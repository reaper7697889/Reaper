// src/backend/services/smartRuleService.js
const { getDb } = require("../db");
const { getDatabaseById } = require("./databaseDefService"); // To validate target_database_id
// We might need getColumnById from databaseDefService if it exists, or query directly.
// For now, direct query for column validation.

const ALLOWED_TRIGGER_TYPES = ['ON_ROW_UPDATE'];
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

function createRule(args) {
  const db = getDb();
  const {
    name, description = null, target_database_id,
    trigger_type, trigger_config: triggerConfigObj,
    condition_formula = null, action_type, action_config: actionConfigObj,
    is_enabled = true,
  } = args;

  // Basic Validations
  if (!name || typeof name !== 'string' || name.trim() === "") return { success: false, error: "Rule name is required." };
  if (target_database_id === undefined || target_database_id === null) return { success: false, error: "Target database ID is required." };
  if (!getDatabaseById(target_database_id)) return { success: false, error: `Target database ID ${target_database_id} not found.` };
  if (!trigger_type || !ALLOWED_TRIGGER_TYPES.includes(trigger_type)) return { success: false, error: `Invalid trigger_type. Allowed: ${ALLOWED_TRIGGER_TYPES.join(', ')}` };
  if (!action_type || !ALLOWED_ACTION_TYPES.includes(action_type)) return { success: false, error: `Invalid action_type. Allowed: ${ALLOWED_ACTION_TYPES.join(', ')}` };

  // Config Object Validations (Structure & Column IDs)
  if (trigger_type === 'ON_ROW_UPDATE' && triggerConfigObj) {
    if (triggerConfigObj.watched_column_ids !== undefined && triggerConfigObj.watched_column_ids !== null) { // Allow null to mean "any column"
        if (!Array.isArray(triggerConfigObj.watched_column_ids)) return { success: false, error: "trigger_config.watched_column_ids must be an array or null." };
        for (const colId of triggerConfigObj.watched_column_ids) {
            const colError = _validateColumnId(colId, target_database_id, db, "trigger_config.watched_column_ids");
            if (colError) return { success: false, error: colError };
        }
    }
  }
  if (action_type === 'UPDATE_SAME_ROW') {
    if (!actionConfigObj || typeof actionConfigObj.set_values !== 'object' || Object.keys(actionConfigObj.set_values).length === 0) {
      return { success: false, error: "action_config.set_values must be a non-empty object for UPDATE_SAME_ROW action." };
    }
    for (const colId of Object.keys(actionConfigObj.set_values)) {
        const colError = _validateColumnId(colId, target_database_id, db, "action_config.set_values column ID");
        if (colError) return { success: false, error: colError };
    }
  }

  let trigger_config_str, action_config_str;
  try {
    trigger_config_str = triggerConfigObj ? _stringifyJson(triggerConfigObj, "trigger_config") : null;
    action_config_str = _stringifyJson(actionConfigObj, "action_config");
  } catch (e) {
    return { success: false, error: e.message };
  }

  const sql = `
    INSERT INTO smart_rules (
      name, description, target_database_id, trigger_type, trigger_config,
      condition_formula, action_type, action_config, is_enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  try {
    const info = db.prepare(sql).run(
      name.trim(), description, target_database_id, trigger_type, trigger_config_str,
      condition_formula, action_type, action_config_str, is_enabled ? 1 : 0
    );
    const newRule = getRuleById(info.lastInsertRowid);
    return newRule ? { success: true, rule: newRule } : { success: false, error: "Failed to retrieve created rule." };
  } catch (err) {
    console.error("Error creating smart rule:", err.message);
    return { success: false, error: "Failed to create smart rule. " + err.message };
  }
}

function getRuleById(ruleId) {
  const db = getDb();
  try {
    const row = db.prepare("SELECT * FROM smart_rules WHERE id = ?").get(ruleId);
    if (row) {
      row.trigger_config = _parseJsonString(row.trigger_config, `rule ${ruleId} trigger_config`);
      row.action_config = _parseJsonString(row.action_config, `rule ${ruleId} action_config`);
      row.is_enabled = !!row.is_enabled;
    }
    return row || null;
  } catch (err) {
    console.error(`Error getting smart rule by ID ${ruleId}:`, err.message);
    if (err.message.startsWith("Invalid JSON format")) return null; // Or some specific error object
    return null;
  }
}

function getRulesForDatabase(databaseId, { triggerType = null, isEnabled = null } = {}) {
  const db = getDb();
  let sql = "SELECT * FROM smart_rules WHERE target_database_id = ?";
  const params = [databaseId];

  if (triggerType !== null) { sql += " AND trigger_type = ?"; params.push(triggerType); }
  if (isEnabled !== null) { sql += " AND is_enabled = ?"; params.push(isEnabled ? 1 : 0); }
  sql += " ORDER BY created_at DESC";

  try {
    const rows = db.prepare(sql).all(...params);
    return rows.map(row => {
      try {
        row.trigger_config = _parseJsonString(row.trigger_config, `rule ${row.id} trigger_config`);
        row.action_config = _parseJsonString(row.action_config, `rule ${row.id} action_config`);
        row.is_enabled = !!row.is_enabled;
        return row;
      } catch (parseErr) {
        console.error(`Error parsing JSON for rule ${row.id} during batch get:`, parseErr.message);
        return { ...row, trigger_config: null, action_config: null, error_parsing_json: true };
      }
    });
  } catch (err) {
    console.error(`Error getting rules for database ${databaseId}:`, err.message);
    return [];
  }
}

function updateRule(ruleId, updates) {
  const db = getDb();
  const { name, description, target_database_id, trigger_type, trigger_config, condition_formula, action_type, action_config, is_enabled } = updates;

  const currentRule = getRuleById(ruleId);
  if (!currentRule) return { success: false, error: `Rule ID ${ruleId} not found.` };

  const finalTargetDbId = target_database_id !== undefined ? target_database_id : currentRule.target_database_id;
  if (target_database_id !== undefined && !getDatabaseById(finalTargetDbId)) {
      return { success: false, error: `Target database ID ${finalTargetDbId} not found.` };
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

  if (trigger_config !== undefined) {
    if (finalTriggerType === 'ON_ROW_UPDATE' && trigger_config) {
        if (trigger_config.watched_column_ids !== undefined && trigger_config.watched_column_ids !== null) {
             if (!Array.isArray(trigger_config.watched_column_ids)) return { success: false, error: "trigger_config.watched_column_ids must be an array or null." };
             for (const colId of trigger_config.watched_column_ids) {
                const colError = _validateColumnId(colId, finalTargetDbId, db, "trigger_config.watched_column_ids");
                if (colError) return { success: false, error: colError };
            }
        }
    }
    try { fieldsToSet.set("trigger_config", trigger_config ? _stringifyJson(trigger_config, "trigger_config") : null); }
    catch (e) { return { success: false, error: e.message }; }
  }

  if (action_config !== undefined) {
    if (finalActionType === 'UPDATE_SAME_ROW') {
        if (!action_config || typeof action_config.set_values !== 'object' || Object.keys(action_config.set_values).length === 0) return { success: false, error: "action_config.set_values must be a non-empty object." };
        for (const colId of Object.keys(action_config.set_values)) {
            const colError = _validateColumnId(colId, finalTargetDbId, db, "action_config.set_values column ID");
            if (colError) return { success: false, error: colError };
        }
    }
    try { fieldsToSet.set("action_config", _stringifyJson(action_config, "action_config")); }
    catch (e) { return { success: false, error: e.message }; }
  }

  if (condition_formula !== undefined) fieldsToSet.set("condition_formula", condition_formula);
  if (is_enabled !== undefined) fieldsToSet.set("is_enabled", is_enabled ? 1 : 0);

  if (fieldsToSet.size === 0) return { success: true, message: "No changes provided.", rule: currentRule };

  fieldsToSet.set("updated_at", "CURRENT_TIMESTAMP");

  const sqlSetParts = Array.from(fieldsToSet.keys()).map(key => `${key} = ?`);
  const sqlValues = Array.from(fieldsToSet.values());
  sqlValues.push(ruleId);

  const sql = `UPDATE smart_rules SET ${sqlSetParts.join(", ")} WHERE id = ?`;
  try {
    const info = db.prepare(sql).run(...sqlValues);
    if (info.changes > 0) {
      return { success: true, rule: getRuleById(ruleId) };
    }
    return { success: false, error: "Rule not found or no effective changes." };
  } catch (err) {
    console.error(`Error updating smart rule ID ${ruleId}:`, err.message);
    return { success: false, error: "Failed to update smart rule. " + err.message };
  }
}

function deleteRule(ruleId) {
  const db = getDb();
  try {
    const stmt = db.prepare("DELETE FROM smart_rules WHERE id = ?");
    const info = stmt.run(ruleId);
    return info.changes > 0 ? { success: true } : { success: false, error: "Rule not found." };
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
};
