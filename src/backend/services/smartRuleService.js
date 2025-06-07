// src/backend/services/smartRuleService.js
const { getDb } = require("../db");
const databaseDefService = require("./databaseDefService"); // For getDatabaseById and getColumnsForDatabase
const FormulaEvaluator = require('../utils/FormulaEvaluator'); // For condition evaluation
let databaseRowService = require('./databaseRowService'); // For action execution - potential circular dep
const databaseQueryService = require('./databaseQueryService'); // For fetching rows
const permissionService = require('./permissionService'); // For permission checks
const cron = require('node-cron'); // For CRON validation

// We might need getColumnById from databaseDefService if it exists, or query directly.
// For now, direct query for column validation.

const ALLOWED_TRIGGER_TYPES = ['ON_ROW_UPDATE', 'TIME_BASED_SCHEDULE', 'TIME_BASED_INTERVAL'];
const ALLOWED_ACTION_TYPES = ['UPDATE_SAME_ROW'];

// --- Internal Helper Functions ---

function _parseJsonString(jsonString, fieldName) {
  if (jsonString === null || jsonString === undefined) return null;
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error(`Invalid JSON for ${fieldName}: ${jsonString}`, e);
    throw new Error(`Invalid JSON format for ${fieldName}.`);
  }
}

function _stringifyJson(jsonObject, fieldName) {
  if (jsonObject === null || jsonObject === undefined) return null;
  try {
    return JSON.stringify(jsonObject);
  } catch (e) {
    console.error(`Error stringifying JSON for ${fieldName}:`, jsonObject, e);
    throw new Error(`Could not stringify JSON for ${fieldName}.`);
  }
}

/**
 * Validates if a columnId exists and belongs to the expectedDatabaseId.
 * @param {number | string} columnId - The ID of the column to validate.
 * @param {number} expectedDatabaseId - The database ID the column should belong to.
 * @param {object} db - The database instance.
 * @returns {string|null} - An error message string if invalid, otherwise null.
 */
function _validateColumnId(columnId, expectedDatabaseId, db, fieldDescription) {
  const colIdNum = parseInt(String(columnId), 10);
  if (isNaN(colIdNum)) {
    return `${fieldDescription}: Column ID "${columnId}" must be a number.`;
  }
  const column = db.prepare("SELECT database_id FROM database_columns WHERE id = ?").get(colIdNum);
  if (!column) {
    return `${fieldDescription}: Column ID ${colIdNum} not found.`;
  }
  if (column.database_id !== expectedDatabaseId) {
    return `${fieldDescription}: Column ID ${colIdNum} does not belong to target database ${expectedDatabaseId}.`;
  }
  return null; // No error
}


// --- CRUD Functions ---

async function createRule(args, requestingUserId) { // Added requestingUserId
  const db = getDb();
  const {
    name, description = null, target_database_id,
    trigger_type, trigger_config: triggerConfigObj, // triggerConfigObj is for ON_ROW_UPDATE
    condition_formula = null, action_type, action_config: actionConfigObj,
    is_enabled = true,
    schedule_cron = null, schedule_interval_seconds = null, timezone = null,
  } = args;

  // Permission Check
  if (!requestingUserId) return { success: false, error: "Requesting user ID is required."};
  const permCheck = await permissionService.checkUserDatabasePermission(target_database_id, requestingUserId, 'WRITE');
  if (!permCheck.V) {
      return { success: false, error: "Authorization failed: Insufficient permissions to create a rule for this database." };
  }

  // Basic Validations
  if (!name || typeof name !== 'string' || name.trim() === "") return { success: false, error: "Rule name is required." };
  if (target_database_id === undefined || target_database_id === null) return { success: false, error: "Target database ID is required." };

  // Target DB existence already implicitly checked by permissionService if it fetches the DB.
  // If not, an explicit check might be needed if permission check is mocked or doesn't fetch.
  // For now, assume permission check implies DB existence for the user.
  // const targetDbExists = db.prepare("SELECT id FROM note_databases WHERE id = ?").get(target_database_id);
  // if (!targetDbExists) return { success: false, error: `Target database ID ${target_database_id} not found.` };


  if (!trigger_type || !ALLOWED_TRIGGER_TYPES.includes(trigger_type)) return { success: false, error: `Invalid trigger_type. Allowed: ${ALLOWED_TRIGGER_TYPES.join(', ')}` };
  if (!action_type || !ALLOWED_ACTION_TYPES.includes(action_type)) return { success: false, error: `Invalid action_type. Allowed: ${ALLOWED_ACTION_TYPES.join(', ')}` };

  let localTriggerConfigObj = triggerConfigObj;
  let localScheduleCron = schedule_cron;
  let localScheduleIntervalSeconds = schedule_interval_seconds;
  let localTimezone = timezone;

  // Config Object Validations & specific field handling
  if (trigger_type === 'ON_ROW_UPDATE') {
    if (localTriggerConfigObj && localTriggerConfigObj.watched_column_ids !== undefined && localTriggerConfigObj.watched_column_ids !== null) {
        if (!Array.isArray(localTriggerConfigObj.watched_column_ids)) return { success: false, error: "trigger_config.watched_column_ids must be an array or null." };
        for (const colId of localTriggerConfigObj.watched_column_ids) {
            const colError = _validateColumnId(colId, target_database_id, db, "trigger_config.watched_column_ids");
            if (colError) return { success: false, error: colError };
        }
    }
    localScheduleCron = null; // Ensure schedule fields are null for this type
    localScheduleIntervalSeconds = null;
    localTimezone = null;
  } else if (trigger_type === 'TIME_BASED_SCHEDULE') {
    if (!localScheduleCron || typeof localScheduleCron !== 'string' || localScheduleCron.trim() === "") {
      return { success: false, error: "schedule_cron is required for TIME_BASED_SCHEDULE." };
    }
    if (!cron.validate(localScheduleCron.trim())) {
        return { success: false, error: "Invalid CRON string format provided for schedule_cron." };
    }
    localScheduleIntervalSeconds = null; // Ensure interval is null
    localTriggerConfigObj = null; // Ensure legacy trigger_config is null or stores timezone if needed
    if (localTimezone && (typeof localTimezone !== 'string' || localTimezone.trim() === "")) localTimezone = null;

  } else if (trigger_type === 'TIME_BASED_INTERVAL') {
    if (localScheduleIntervalSeconds === null || typeof localScheduleIntervalSeconds !== 'number' || localScheduleIntervalSeconds <= 0) {
      return { success: false, error: "schedule_interval_seconds must be a positive integer for TIME_BASED_INTERVAL." };
    }
    localScheduleCron = null; // Ensure cron is null
    localTimezone = null; // Timezone not typically used with simple intervals
    localTriggerConfigObj = null;
  }

  if (action_type === 'UPDATE_SAME_ROW') {
    if (!actionConfigObj || typeof actionConfigObj.set_values !== 'object' || Object.keys(actionConfigObj.set_values).length === 0) {
      return { success: false, error: "action_config.set_values must be a non-empty object for UPDATE_SAME_ROW action." };
    }
    for (const colIdStr of Object.keys(actionConfigObj.set_values)) {
        const colError = _validateColumnId(colIdStr, target_database_id, db, "action_config.set_values column ID");
        if (colError) return { success: false, error: colError };

        // Validate column type for set_values
        const colDef = db.prepare("SELECT type FROM database_columns WHERE id = ?").get(parseInt(colIdStr, 10));
        if (colDef && ['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
            return { success: false, error: `Cannot set value for computed column ID ${colIdStr} (type: ${colDef.type}).` };
        }
    }
  }

  let trigger_config_str, action_config_str;
  try {
    trigger_config_str = localTriggerConfigObj ? _stringifyJson(localTriggerConfigObj, "trigger_config") : null;
    action_config_str = _stringifyJson(actionConfigObj, "action_config");
  } catch (e) {
    return { success: false, error: e.message };
  }

  const sql = `
    INSERT INTO smart_rules (
      name, description, target_database_id, trigger_type, trigger_config,
      condition_formula, action_type, action_config, is_enabled,
      schedule_cron, schedule_interval_seconds, timezone, last_triggered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `;
  try {
    const info = db.prepare(sql).run(
      name.trim(), description, target_database_id, trigger_type, trigger_config_str,
      condition_formula, action_type, action_config_str, is_enabled ? 1 : 0,
      localScheduleCron, localScheduleIntervalSeconds, localTimezone
    );
    const newRule = getRuleById(info.lastInsertRowid);
    return newRule ? { success: true, rule: newRule } : { success: false, error: "Failed to retrieve created rule." };
  } catch (err) {
    console.error("Error creating smart rule:", err.message);
    return { success: false, error: "Failed to create smart rule. " + err.message };
  }
}

// getRuleById is mostly an internal helper or for specific trusted scenarios.
// If exposed via API, it would need its own permission check (e.g., user can READ target_database_id).
function getRuleById(ruleId) {
  const db = getDb();
  try {
    const row = db.prepare("SELECT id, name, description, target_database_id, trigger_type, trigger_config, condition_formula, action_type, action_config, is_enabled, schedule_cron, schedule_interval_seconds, last_triggered_at, timezone, created_at, updated_at FROM smart_rules WHERE id = ?").get(ruleId);
    if (row) {
      if (row.trigger_type === 'ON_ROW_UPDATE') { // Only parse for relevant type
        row.trigger_config = _parseJsonString(row.trigger_config, `rule ${ruleId} trigger_config`);
      } else {
        row.trigger_config = null; // Or keep as is if it might store other JSON for time-based
      }
      row.action_config = _parseJsonString(row.action_config, `rule ${ruleId} action_config`);
      row.is_enabled = !!row.is_enabled;
    }
    return row || null;
  } catch (err) {
    console.error(`Error getting smart rule by ID ${ruleId}:`, err.message);
    if (err.message.startsWith("Invalid JSON format")) return null;
    return null;
  }
}

function getRulesForDatabase(databaseId, { triggerType = null, isEnabled = null } = {}) {
  const db = getDb();
  let sql = "SELECT id, name, description, target_database_id, trigger_type, trigger_config, condition_formula, action_type, action_config, is_enabled, schedule_cron, schedule_interval_seconds, last_triggered_at, timezone, created_at, updated_at FROM smart_rules WHERE target_database_id = ?";
  const params = [databaseId];

  if (triggerType !== null) { sql += " AND trigger_type = ?"; params.push(triggerType); }
  if (isEnabled !== null) { sql += " AND is_enabled = ?"; params.push(isEnabled ? 1 : 0); }
  sql += " ORDER BY created_at DESC";

  try {
    const rows = db.prepare(sql).all(...params);
    return rows.map(row => {
      try {
        if (row.trigger_type === 'ON_ROW_UPDATE') {
            row.trigger_config = _parseJsonString(row.trigger_config, `rule ${row.id} trigger_config`);
        } else {
            row.trigger_config = null; // Or keep as is
        }
        row.action_config = _parseJsonString(row.action_config, `rule ${row.id} action_config`);
        row.is_enabled = !!row.is_enabled;
        return row;
      } catch (parseErr) {
        console.error(`Error parsing JSON for rule ${row.id} during batch get:`, parseErr.message);
        return { ...row, trigger_config: null, action_config: null, error_parsing_json: true, is_enabled: !!row.is_enabled };
      }
    });
  } catch (err) {
    console.error(`Error getting rules for database ${databaseId}:`, err.message);
    return [];
  }
}

async function updateRule(ruleId, updates, requestingUserId) { // Added requestingUserId
  const db = getDb();
  const {
    name, description, target_database_id,
    trigger_type, trigger_config, // trigger_config for ON_ROW_UPDATE
    condition_formula, action_type, action_config, is_enabled,
    schedule_cron, schedule_interval_seconds, timezone
  } = updates;

  const currentRule = getRuleById(ruleId); // Fetch current rule first to check its target_database_id
  if (!currentRule) return { success: false, error: `Rule ID ${ruleId} not found.` };

  // Permission Check on the original target_database_id of the rule
  if(!requestingUserId) return { success: false, error: "Requesting user ID is required."};
  let permCheck = await permissionService.checkUserDatabasePermission(currentRule.target_database_id, requestingUserId, 'WRITE');
  if (!permCheck.V) {
      return { success: false, error: `Authorization failed: Insufficient permissions for original database ID ${currentRule.target_database_id}.` };
  }

  const finalTargetDbId = target_database_id !== undefined ? target_database_id : currentRule.target_database_id;

  // If target_database_id is being changed, check permission on the new one as well
  if (target_database_id !== undefined && target_database_id !== currentRule.target_database_id) {
    permCheck = await permissionService.checkUserDatabasePermission(target_database_id, requestingUserId, 'WRITE');
    if (!permCheck.V) {
        return { success: false, error: `Authorization failed: Insufficient permissions for new target database ID ${target_database_id}.` };
    }
    // Existence of new target_database_id is implicitly checked by permissionService
  }

  const fieldsToSet = new Map();

  if (name !== undefined) {
    if (!name || typeof name !== 'string' || name.trim() === "") return { success: false, error: "Rule name cannot be empty." };
    fieldsToSet.set("name", name.trim());
  }
  if (description !== undefined) fieldsToSet.set("description", description);
  if (target_database_id !== undefined) fieldsToSet.set("target_database_id", target_database_id);

  const finalTriggerType = trigger_type !== undefined ? trigger_type : currentRule.trigger_type;
  if (trigger_type !== undefined) {
    if (!ALLOWED_TRIGGER_TYPES.includes(trigger_type)) return { success: false, error: `Invalid trigger_type.` };
    fieldsToSet.set("trigger_type", trigger_type);
  }
  const finalActionType = action_type !== undefined ? action_type : currentRule.action_type;
  if (action_type !== undefined) {
    if (!ALLOWED_ACTION_TYPES.includes(action_type)) return { success: false, error: `Invalid action_type.` };
    fieldsToSet.set("action_type", action_type);
  }

  // Handle trigger_type specific fields and nullify others
  if (finalTriggerType === 'ON_ROW_UPDATE') {
    if (trigger_config !== undefined) { // If trigger_config is explicitly passed for an ON_ROW_UPDATE
        if (trigger_config && trigger_config.watched_column_ids !== undefined && trigger_config.watched_column_ids !== null) {
            if (!Array.isArray(trigger_config.watched_column_ids)) return { success: false, error: "trigger_config.watched_column_ids must be an array or null." };
            for (const colId of trigger_config.watched_column_ids) {
                const colError = _validateColumnId(colId, finalTargetDbId, db, "trigger_config.watched_column_ids");
                if (colError) return { success: false, error: colError };
            }
        }
        try { fieldsToSet.set("trigger_config", trigger_config ? _stringifyJson(trigger_config, "trigger_config") : null); }
        catch (e) { return { success: false, error: e.message }; }
    } else if (trigger_type === 'ON_ROW_UPDATE' && currentRule.trigger_type !== 'ON_ROW_UPDATE') {
        // If changing to ON_ROW_UPDATE and no trigger_config provided, use current or default (null)
        // This case might need more specific logic if default non-null config is expected
        fieldsToSet.set("trigger_config", null); // Example: default to null if not provided
    }
    fieldsToSet.set("schedule_cron", null);
    fieldsToSet.set("schedule_interval_seconds", null);
    fieldsToSet.set("timezone", null);
  } else if (finalTriggerType === 'TIME_BASED_SCHEDULE') {
    if (schedule_cron !== undefined) {
        if (!schedule_cron || typeof schedule_cron !== 'string' || schedule_cron.trim() === "") return { success: false, error: "schedule_cron is required for TIME_BASED_SCHEDULE."};
        if (!cron.validate(schedule_cron.trim())) {
            return { success: false, error: "Invalid CRON string format provided for schedule_cron." };
        }
        fieldsToSet.set("schedule_cron", schedule_cron.trim());
    } else if (trigger_type === 'TIME_BASED_SCHEDULE' && !currentRule.schedule_cron) { // Changed to this type, but no value given
        return { success: false, error: "schedule_cron is required when changing to TIME_BASED_SCHEDULE." };
    }
    if (timezone !== undefined) fieldsToSet.set("timezone", timezone && timezone.trim() !== "" ? timezone.trim() : null);

    fieldsToSet.set("trigger_config", null);
    fieldsToSet.set("schedule_interval_seconds", null);
  } else if (finalTriggerType === 'TIME_BASED_INTERVAL') {
    if (schedule_interval_seconds !== undefined) {
        if (typeof schedule_interval_seconds !== 'number' || schedule_interval_seconds <= 0) return { success: false, error: "schedule_interval_seconds must be a positive integer."};
        fieldsToSet.set("schedule_interval_seconds", schedule_interval_seconds);
    } else if (trigger_type === 'TIME_BASED_INTERVAL' && !currentRule.schedule_interval_seconds) {
        return { success: false, error: "schedule_interval_seconds is required when changing to TIME_BASED_INTERVAL." };
    }
    fieldsToSet.set("trigger_config", null);
    fieldsToSet.set("schedule_cron", null);
    fieldsToSet.set("timezone", null);
  }


  if (action_config !== undefined) {
    if (finalActionType === 'UPDATE_SAME_ROW') {
        if (!action_config || typeof action_config.set_values !== 'object' || Object.keys(action_config.set_values).length === 0) return { success: false, error: "action_config.set_values must be a non-empty object." };
        for (const colIdStr of Object.keys(action_config.set_values)) {
            const colError = _validateColumnId(colIdStr, finalTargetDbId, db, "action_config.set_values column ID");
            if (colError) return { success: false, error: colError };

            // Validate column type for set_values
            const colDef = db.prepare("SELECT type FROM database_columns WHERE id = ?").get(parseInt(colIdStr, 10));
            if (colDef && ['FORMULA', 'ROLLUP', 'LOOKUP'].includes(colDef.type)) {
                 return { success: false, error: `Cannot set value for computed column ID ${colIdStr} (type: ${colDef.type}).` };
            }
        }
    }
    try { fieldsToSet.set("action_config", _stringifyJson(action_config, "action_config")); }
    catch (e) { return { success: false, error: e.message }; }
  }

  if (condition_formula !== undefined) fieldsToSet.set("condition_formula", condition_formula);
  if (is_enabled !== undefined) fieldsToSet.set("is_enabled", is_enabled ? 1 : 0);

  if (fieldsToSet.size === 0 && !(schedule_cron === null && currentRule.schedule_cron) && !(schedule_interval_seconds === null && currentRule.schedule_interval_seconds) && !(timezone === null && currentRule.timezone)) {
     // Check if any actual value is changing beyond just setting to null from null
     let noRealChange = true;
     if (schedule_cron !== undefined && schedule_cron !== currentRule.schedule_cron) noRealChange = false;
     if (schedule_interval_seconds !== undefined && schedule_interval_seconds !== currentRule.schedule_interval_seconds) noRealChange = false;
     if (timezone !== undefined && timezone !== currentRule.timezone) noRealChange = false;
     if (noRealChange && fieldsToSet.size === 0) {
        return { success: true, message: "No effective changes provided.", rule: currentRule };
     }
  }

  fieldsToSet.set("updated_at", "CURRENT_TIMESTAMP");

  const sqlSetParts = Array.from(fieldsToSet.keys()).map(key => `${key} = ?`);
  const sqlValues = Array.from(fieldsToSet.values());
  sqlValues.push(ruleId);

  const sql = `UPDATE smart_rules SET ${sqlSetParts.join(", ")} WHERE id = ?`;
  try {
    const info = db.prepare(sql).run(...sqlValues);
    if (info.changes > 0) {
      const updatedRule = getRuleById(ruleId);
      // After successful DB update, update the scheduler
      const scheduler = require('./schedulerService'); // Late import
      scheduler.unscheduleRule(ruleId);
      if (updatedRule && updatedRule.is_enabled && updatedRule.trigger_type === 'TIME_BASED_SCHEDULE') {
        scheduler.scheduleCronRule(updatedRule);
      }
      return { success: true, rule: updatedRule };
    }
    return { success: false, error: "Rule not found or no effective changes." };
  } catch (err) {
    console.error(`Error updating smart rule ID ${ruleId}:`, err.message);
    return { success: false, error: "Failed to update smart rule. " + err.message };
  }
}

function deleteRule(ruleId, requestingUserId) { // Added requestingUserId for consistency, though not used in this version
  const db = getDb();
  try {
    // Optional: Add permission check here if deleting rules should be restricted
    // For now, assuming if a user can call this, they have rights (e.g. from API layer)

    const ruleToDelete = getRuleById(ruleId); // Get rule details before deleting, to know its type
    if (!ruleToDelete) {
        return { success: false, error: "Rule not found." };
    }

    const stmt = db.prepare("DELETE FROM smart_rules WHERE id = ?");
    const info = stmt.run(ruleId);

    if (info.changes > 0) {
      // If the rule was a time-based schedule, unschedule it
      if (ruleToDelete.trigger_type === 'TIME_BASED_SCHEDULE') {
        const scheduler = require('./schedulerService'); // Late import
        scheduler.unscheduleRule(ruleId);
      }
      return { success: true };
    }
    return { success: false, error: "Rule not found (at delete stage)." };
  } catch (err) {
    console.error(`Error deleting smart rule ID ${ruleId}:`, err.message);
    return { success: false, error: "Failed to delete smart rule." };
  }
}

module.exports = {
  createRule,
  getRuleById,
  getRulesForDatabase,
  updateRule,
  deleteRule,
  runSmartRulesForRowChange,
  executeTimeBasedRule,
  getAllEnabledRulesByTriggerType, // Export new function
  getAllEnabledTimeBasedRules, // Export new function
};

function _mapRuleRow(row) {
  // Helper to consistently parse JSON fields for rule objects
  let trigger_config = null;
  if (row.trigger_type === 'ON_ROW_UPDATE') {
    trigger_config = _parseJsonString(row.trigger_config, `rule ${row.id} trigger_config`);
  }
  const action_config = _parseJsonString(row.action_config, `rule ${row.id} action_config`);
  return {
    ...row,
    trigger_config,
    action_config,
    is_enabled: !!row.is_enabled,
  };
}

async function getAllEnabledRulesByTriggerType(triggerType) {
  const db = getDb();
  if (!ALLOWED_TRIGGER_TYPES.includes(triggerType)) {
    console.error(`getAllEnabledRulesByTriggerType: Invalid triggerType "${triggerType}"`);
    return [];
  }
  try {
    const rows = db.prepare(
      "SELECT * FROM smart_rules WHERE is_enabled = 1 AND trigger_type = ?"
    ).all(triggerType);
    return rows.map(_mapRuleRow);
  } catch (err) {
    console.error(`Error getting enabled rules by trigger type ${triggerType}:`, err.message);
    return [];
  }
}

async function getAllEnabledTimeBasedRules() {
  const db = getDb();
  try {
    const rows = db.prepare(
      "SELECT * FROM smart_rules WHERE is_enabled = 1 AND (trigger_type = 'TIME_BASED_SCHEDULE' OR trigger_type = 'TIME_BASED_INTERVAL')"
    ).all();
    return rows.map(_mapRuleRow);
  } catch (err) {
    console.error(`Error getting all enabled time-based rules:`, err.message);
    return [];
  }
}


async function executeTimeBasedRule(ruleId, systemUserId) {
  const rule = getRuleById(ruleId);

  if (!rule) {
    console.log(`ExecuteTimeBasedRule: Rule ID ${ruleId} not found. Skipping.`);
    return;
  }
  if (!rule.is_enabled) {
    console.log(`ExecuteTimeBasedRule: Rule ID ${ruleId} (${rule.name}) is disabled. Skipping.`);
    return;
  }
  if (rule.trigger_type !== 'TIME_BASED_SCHEDULE' && rule.trigger_type !== 'TIME_BASED_INTERVAL') {
    console.log(`ExecuteTimeBasedRule: Rule ID ${ruleId} (${rule.name}) is not a time-based rule (type: ${rule.trigger_type}). Skipping.`);
    return;
  }

  console.log(`ExecuteTimeBasedRule: Processing rule ID ${ruleId} (${rule.name}) for database ${rule.target_database_id}`);

  try {
    const columnDefinitions = await databaseDefService.getColumnsForDatabase(rule.target_database_id, null); // systemUserId might be relevant here for restricted views in future
    if (!columnDefinitions) {
      console.error(`ExecuteTimeBasedRule: Could not fetch column definitions for database ${rule.target_database_id}. Skipping rule ${ruleId}.`);
      return;
    }

    // Fetch all rows for the target database.
    // databaseQueryService.getRowsForDatabase expects filters and sorts.
    // systemUserId implies fetching all rows without user-specific filtering for the purpose of rule execution.
    // This service needs to be designed to handle a null or special systemUserId.
    const queryResult = await databaseQueryService.getRowsForDatabase(
      rule.target_database_id,
      { filters: [], sorts: [] }, // No specific filters/sorts, process all rows
      systemUserId // Pass systemUserId, which needs to be handled by databaseQueryService
    );

    if (!queryResult || !queryResult.rows) {
        console.error(`ExecuteTimeBasedRule: Failed to fetch rows for database ${rule.target_database_id} for rule ${ruleId}.`);
        return;
    }

    console.log(`ExecuteTimeBasedRule: Fetched ${queryResult.rows.length} rows for database ${rule.target_database_id} to process for rule ${ruleId}.`);

    for (const row of queryResult.rows) {
      // row from databaseQueryService.getRowsForDatabase should already have its 'values' field populated.
      // If not, an additional call to databaseRowService.getRow(row.id, systemUserId) would be needed here.
      // Assuming row.values is populated correctly by databaseQueryService.

      let conditionMet = true;
      if (rule.condition_formula && rule.condition_formula.trim() !== "") {
        const evalResult = FormulaEvaluator.evaluateFormula(rule.condition_formula, row.values, columnDefinitions);
        if (evalResult.error) {
          console.error(`ExecuteTimeBasedRule: Rule ${rule.id}, Row ${row.id} - condition evaluation error: ${evalResult.error}. Skipping row.`);
          continue;
        }
        conditionMet = !!evalResult.result;
      }

      if (!conditionMet) {
        // console.log(`ExecuteTimeBasedRule: Rule ${rule.id}, Row ${row.id} - condition not met. Skipping action.`);
        continue;
      }

      // Action Execution
      if (rule.action_type === 'UPDATE_SAME_ROW') {
        if (!rule.action_config || !rule.action_config.set_values) {
          console.error(`ExecuteTimeBasedRule: Rule ${rule.id}, Row ${row.id} - action_config.set_values is missing. Skipping action.`);
          continue;
        }

        const updatesToApply = { ...rule.action_config.set_values }; // Clone

        for (const colIdStr of Object.keys(updatesToApply)) {
          const colId = parseInt(colIdStr, 10);
          const targetColDef = columnDefinitions.find(c => c.id === colId);

          if (updatesToApply[colIdStr] === "{CURRENT_TIMESTAMP}") {
            if (targetColDef && targetColDef.type === 'DATETIME') {
              updatesToApply[colIdStr] = new Date().toISOString();
            } else if (targetColDef && targetColDef.type === 'DATE') {
              updatesToApply[colIdStr] = new Date().toISOString().split('T')[0];
            } else {
              console.warn(`ExecuteTimeBasedRule: Rule ${rule.id}, Row ${row.id} - placeholder {CURRENT_TIMESTAMP} for non-DATETIME/DATE column ${colIdStr}. Using as literal.`);
            }
          }
          // Add more placeholder handlers here
        }

        console.log(`ExecuteTimeBasedRule: Rule ${rule.id} applying action to Row ${row.id}. Updates:`, updatesToApply);

        try {
            // Ensure databaseRowService is loaded (handling potential circular dependencies)
            if (!databaseRowService || !databaseRowService.updateRow) {
                console.error("ExecuteTimeBasedRule: databaseRowService.updateRow is not available. This might be a circular dependency issue. Re-requiring...");
                databaseRowService = require('./databaseRowService');
                if (!databaseRowService || !databaseRowService.updateRow) {
                    console.error("ExecuteTimeBasedRule: Re-require of databaseRowService did not resolve updateRow. Cannot execute action for rule " + rule.id + " on row " + row.id);
                    continue; // Skip this row action
                }
            }

            await databaseRowService.updateRow({
              rowId: row.id,
              values: updatesToApply,
              _triggerDepth: 1, // Time-based rules are like initial triggers from system
              requestingUserId: systemUserId // Pass systemUserId
            });
        } catch (actionError) {
            console.error(`ExecuteTimeBasedRule: Rule ${rule.id}, Row ${row.id} - error during action execution:`, actionError.message);
            // Continue to the next row even if one row's action fails.
        }
      }
      // TODO: Add other action_type handlers here if new ones are defined for time-based rules
    }
     console.log(`ExecuteTimeBasedRule: Finished processing rule ID ${ruleId} (${rule.name}).`);

  } catch (error) {
    console.error(`ExecuteTimeBasedRule: Error processing rule ID ${ruleId} (${rule.name}):`, error.message, error.stack);
  }
}

async function runSmartRulesForRowChange(rowId, databaseId, oldRowValues, newRowValues, dbInstance, _triggerDepth = 0, requestingUserId) {
  const db = dbInstance || getDb();

  // Fetch active rules for the database and trigger type
  const rules = getRulesForDatabase(databaseId, { triggerType: 'ON_ROW_UPDATE', isEnabled: true });
  if (!rules || rules.length === 0) {
    return; // No rules to process
  }

  // Fetch column definitions for formula evaluation (once per databaseId)
  let columnDefinitions;
  try {
    columnDefinitions = await databaseDefService.getColumnsForDatabase(databaseId, null); // Fetch all columns
    if (!columnDefinitions) {
      console.error(`SmartRules: Could not fetch column definitions for database ${databaseId}. Aborting rule execution.`);
      return;
    }
  } catch (e) {
    console.error(`SmartRules: Error fetching column definitions for database ${databaseId}: ${e.message}. Aborting rule execution.`);
    return;
  }

  for (const rule of rules) {
    try {
      // 1. Watched Columns Check
      let watchedColumnChanged = true; // Assume change if no watched_column_ids specified
      if (rule.trigger_config && Array.isArray(rule.trigger_config.watched_column_ids) && rule.trigger_config.watched_column_ids.length > 0) {
        watchedColumnChanged = rule.trigger_config.watched_column_ids.some(colId => {
          // Simple comparison; consider deep equality for objects/arrays if column types could store them directly
          // For now, _getStoredRowData provides simple values or arrays of IDs, so direct comparison (after stringify for arrays) is mostly fine.
          const oldValue = oldRowValues[colId];
          const newValue = newRowValues[colId];
          if (Array.isArray(oldValue) || Array.isArray(newValue)) {
            return JSON.stringify(oldValue) !== JSON.stringify(newValue);
          }
          return oldValue !== newValue;
        });
      }

      if (!watchedColumnChanged) {
        console.log(`SmartRules: Rule ${rule.id} skipped (no watched column changed).`);
        continue;
      }

      // 2. Condition Evaluation
      let conditionMet = true; // Assume true if no condition_formula
      if (rule.condition_formula && rule.condition_formula.trim() !== "") {
        const evalResult = FormulaEvaluator.evaluateFormula(rule.condition_formula, newRowValues, columnDefinitions);
        if (evalResult.error) {
          console.error(`SmartRules: Rule ${rule.id} condition evaluation error: ${evalResult.error}. Skipping rule.`);
          continue;
        }
        conditionMet = !!evalResult.result; // Ensure boolean
      }

      if (!conditionMet) {
        console.log(`SmartRules: Rule ${rule.id} skipped (condition not met).`);
        continue;
      }

      // 3. Action Execution
      if (rule.action_type === 'UPDATE_SAME_ROW') {
        if (!rule.action_config || !rule.action_config.set_values) {
          console.error(`SmartRules: Rule ${rule.id} action_config.set_values is missing. Skipping rule.`);
          continue;
        }

        const updatesToApply = { ...rule.action_config.set_values }; // Clone to modify

        // Handle special value placeholders
        for (const colIdStr of Object.keys(updatesToApply)) {
            const colId = parseInt(colIdStr, 10);
            const targetColDef = columnDefinitions.find(c => c.id === colId);

            if (updatesToApply[colIdStr] === "{CURRENT_TIMESTAMP}") {
                if (targetColDef && targetColDef.type === 'DATETIME') {
                    updatesToApply[colIdStr] = new Date().toISOString();
                } else if (targetColDef && targetColDef.type === 'DATE') {
                    updatesToApply[colIdStr] = new Date().toISOString().split('T')[0];
                }
                 else {
                    console.warn(`SmartRules: Rule ${rule.id} placeholder {CURRENT_TIMESTAMP} used for non-DATETIME/DATE column ${colIdStr}. Using as literal string.`);
                }
            }
            // Add more placeholder handlers here if needed (e.g., "{USER_ID}")
        }

        console.log(`SmartRules: Rule ${rule.id} triggered. Applying updates to row ${rowId}:`, updatesToApply);
        // Call databaseRowService.updateRow
        // Ensure databaseRowService is loaded, handling potential circular dependencies if necessary.
        // If databaseRowService was destructured at the top, it might be undefined due to circular deps.
        if (!databaseRowService || !databaseRowService.updateRow) {
            console.error("SmartRules: databaseRowService.updateRow is not available. This might be a circular dependency issue.");
            // Attempt to re-require if it was undefined. This is a common pattern to break circular dependencies at runtime.
            databaseRowService = require('./databaseRowService');
            if (!databaseRowService || !databaseRowService.updateRow) {
                 console.error("SmartRules: Re-require of databaseRowService did not resolve updateRow. Cannot execute action for rule " + rule.id);
                 continue;
            }
        }

        await databaseRowService.updateRow({
          rowId,
          values: updatesToApply,
          _triggerDepth: _triggerDepth + 1, // Increment depth
          requestingUserId // Pass along the original user context
        });
        console.log(`SmartRules: Rule ${rule.id} action executed for row ${rowId}.`);
      }
    } catch (e) {
      console.error(`SmartRules: Error processing rule ${rule.id} for row ${rowId}: ${e.message}`, e.stack);
    }
  }
}
