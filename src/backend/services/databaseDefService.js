// src/backend/services/databaseDefService.js
const { getDb } = require("../../../db"); // Corrected path
const authService = require('./authService'); // Added for RBAC

const ALLOWED_COLUMN_TYPES = ['TEXT', 'NUMBER', 'DATE', 'DATETIME', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'RELATION', 'FORMULA', 'ROLLUP', 'LOOKUP'];
const ALLOWED_ROLLUP_FUNCTIONS = [
    'COUNT_ALL', 'COUNT_VALUES', 'COUNT_UNIQUE_VALUES',
    'SUM', 'AVG', 'MIN', 'MAX',
    'SHOW_UNIQUE',
    'PERCENT_EMPTY', 'PERCENT_NOT_EMPTY',
    'COUNT_CHECKED', 'COUNT_UNCHECKED',
    'PERCENT_CHECKED', 'PERCENT_UNCHECKED'
];
const ALLOWED_LOOKUP_BEHAVIORS = ['FIRST', 'LIST_UNIQUE_STRINGS'];
const ALLOWED_RELATION_TARGET_ENTITY_TYPES = ['NOTE_DATABASES', 'NOTES_TABLE'];
const VALID_NOTE_PSEUDO_FIELDS = ['id', 'title', 'content', 'type', 'created_at', 'updated_at', 'folder_id', 'workspace_id', 'is_pinned', 'is_archived'];

// --- Helper Functions ---
function _clearInverseColumnLink(inverseColumnId, db) {
    if (inverseColumnId === null || inverseColumnId === undefined) return;
    try {
        db.prepare("UPDATE database_columns SET inverse_column_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(inverseColumnId);
        console.log(`Cleared inverse_column_id for column ${inverseColumnId}`);
    } catch (err) { console.error(`Error clearing inverse_column_id for column ${inverseColumnId}:`, err.message); }
}

function _validateTargetInverseColumn(targetColumnId, expectedTargetDbIdForColB, expectedSourceDbIdForColBLinkBack, db) {
    const targetCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(targetColumnId);
    if (!targetCol) return "Target inverse column not found.";
    if (targetCol.database_id !== expectedTargetDbIdForColB) return "Target inverse column is not in the specified linked database.";
    if (targetCol.type !== 'RELATION') return "Target inverse column is not of type RELATION.";
    if (targetCol.relation_target_entity_type !== 'NOTE_DATABASES') return "Target inverse column must itself target NOTE_DATABASES.";
    if (targetCol.linked_database_id !== expectedSourceDbIdForColBLinkBack) return `Target inverse column does not link back to source DB.`;
    return targetCol;
}

function _validateRollupDefinition(rollupArgs, db, currentDatabaseId) { /* ... (as defined previously, unchanged) ... */
    const { rollup_source_relation_column_id, rollup_target_column_id, rollup_function } = rollupArgs;
    if (!rollup_source_relation_column_id) return "Rollup source relation column ID is required.";
    if (!rollup_target_column_id) return "Rollup target column ID is required.";
    if (!rollup_function) return "Rollup function is required.";
    if (!ALLOWED_ROLLUP_FUNCTIONS.includes(rollup_function)) return `Invalid rollup function: ${rollup_function}.`;
    const sourceCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(rollup_source_relation_column_id);
    if (!sourceCol) return `Rollup source relation column ID ${rollup_source_relation_column_id} not found.`;
    if (sourceCol.database_id !== currentDatabaseId) return "Rollup source relation column must be in the same database.";
    if (sourceCol.type !== 'RELATION') return "Rollup source column must be of type RELATION.";
    if (sourceCol.relation_target_entity_type !== 'NOTE_DATABASES') return "Rollup source relation column must target another database table (NOTE_DATABASES).";
    if (!sourceCol.linked_database_id) return "Rollup source relation column does not have a linked database.";
    const targetCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(rollup_target_column_id);
    if (!targetCol) return `Rollup target column ID ${rollup_target_column_id} not found.`;
    if (targetCol.database_id !== sourceCol.linked_database_id) return "Rollup target column is not in the database linked by the source relation column.";
    const targetType = targetCol.type === 'FORMULA' ? targetCol.formula_result_type : targetCol.type;
    if (!targetType && targetCol.type === 'FORMULA') return `Rollup target column (ID: ${targetCol.id}) is a FORMULA with an undefined result type.`;
    if (['SUM', 'AVG'].includes(rollup_function) && targetType !== 'NUMBER') return `Rollup function ${rollup_function} requires target '${targetCol.name}' to be NUMBER. Is ${targetType}.`;
    if (['COUNT_CHECKED', 'COUNT_UNCHECKED', 'PERCENT_CHECKED', 'PERCENT_UNCHECKED'].includes(rollup_function) && targetType !== 'BOOLEAN') return `Rollup function ${rollup_function} requires target '${targetCol.name}' to be BOOLEAN. Is ${targetType}.`;
    if (['MIN', 'MAX'].includes(rollup_function) && !['NUMBER', 'DATE', 'DATETIME'].includes(targetType)) return `Rollup function ${rollup_function} requires target '${targetCol.name}' to be NUMBER, DATE or DATETIME. Is ${targetType}.`;
    return null;
}

function _validateLookupDefinition(lookupArgs, db, currentDatabaseId) { /* ... (as defined previously, unchanged) ... */
    const { lookup_source_relation_column_id, lookup_target_value_column_id, lookup_multiple_behavior } = lookupArgs;
    if (!lookup_source_relation_column_id) return "Lookup source relation column ID is required.";
    if (lookup_target_value_column_id === null || lookup_target_value_column_id === undefined) return "Lookup target value column ID (or pseudo-field name) is required.";
    if (lookup_multiple_behavior && !ALLOWED_LOOKUP_BEHAVIORS.includes(lookup_multiple_behavior)) return `Invalid lookup_multiple_behavior: ${lookup_multiple_behavior}.`;
    const sourceCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(lookup_source_relation_column_id);
    if (!sourceCol) return `Lookup source relation column ID ${lookup_source_relation_column_id} not found.`;
    if (sourceCol.database_id !== currentDatabaseId) return "Lookup source relation column must be in the same database.";
    if (sourceCol.type !== 'RELATION') return "Lookup source column must be of type RELATION.";
    if (sourceCol.relation_target_entity_type === 'NOTE_DATABASES') {
        if (!sourceCol.linked_database_id) return "Lookup source relation column (targeting NOTE_DATABASES) does not have a linked database.";
        const targetValColIdNum = parseInt(lookup_target_value_column_id, 10);
        if (isNaN(targetValColIdNum)) return "lookup_target_value_column_id must be a numeric ID when relation targets NOTE_DATABASES.";
        const targetValCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(targetValColIdNum);
        if (!targetValCol) return `Lookup target value column ID ${targetValColIdNum} not found.`;
        if (targetValCol.database_id !== sourceCol.linked_database_id) return "Lookup target value column is not in the database linked by the source relation column.";
        if (['RELATION', 'ROLLUP', 'LOOKUP'].includes(targetValCol.type)) return `Lookup target column ('${targetValCol.name}') cannot be of type RELATION, ROLLUP, or LOOKUP itself.`;
    } else if (sourceCol.relation_target_entity_type === 'NOTES_TABLE') {
        if (typeof lookup_target_value_column_id !== 'string') return "lookup_target_value_column_id should be a string (e.g. 'title') when relation target is NOTES_TABLE."
        if (!VALID_NOTE_PSEUDO_FIELDS.includes(lookup_target_value_column_id)) return `Invalid target pseudo-field name '${lookup_target_value_column_id}' for lookup on notes. Allowed fields are: ${VALID_NOTE_PSEUDO_FIELDS.join(', ')}.`;
    } else { return "Invalid relation_target_entity_type on lookup source relation column."; }
    return null;
}

// --- Database Management ---
async function createDatabase(args) { // Changed to async
  const db = getDb();
  const { name, noteId = null, is_calendar = 0, userId = null } = args;

  if (userId) {
    const userCreating = await authService.getUserWithRole(userId);
    if (userCreating && userCreating.role === 'VIEWER') {
      return { success: false, error: "Viewers cannot create databases." };
    }
  } else {
    // Policy: If no userId, perhaps it's a system/public DB creation?
    // For now, assume if userId is null, it's not a user-driven action that needs this check.
    // Or, enforce userId presence: return { success: false, error: "User ID is required to create a database." };
  }

  if (!name || typeof name !== 'string' || name.trim() === "") return { success: false, error: "Database name is required." };
  try {
    const stmt = db.prepare("INSERT INTO note_databases (name, note_id, is_calendar, user_id) VALUES (?, ?, ?, ?)"); // Add user_id to SQL
    const info = stmt.run(name.trim(), noteId, is_calendar ? 1 : 0, userId); // Pass userId
    const newDb = getDatabaseById(info.lastInsertRowid); // This should fetch the object including user_id
    if (newDb) return { success: true, database: newDb };
    return { success: false, error: "Failed to retrieve newly created database."};
  } catch (err) { console.error("Error creating database:", err.message); return { success: false, error: "Failed to create database." }; }
}

function getDatabaseById(databaseId, requestingUserId = null) {
  const db = getDb();
  // Select new calendar-related fields
  let query = "SELECT id, note_id, name, is_calendar, user_id, created_at, updated_at, event_start_column_id, event_end_column_id FROM note_databases WHERE id = ?";
  const params = [databaseId];

  if (requestingUserId !== null) {
    query += " AND (user_id = ? OR user_id IS NULL)";
    params.push(requestingUserId);
  }

  try {
    const row = db.prepare(query).get(...params);
    if (row) {
        row.is_calendar = !!row.is_calendar; // Parse to boolean
    }
    return row || null;
  }
  catch (err) { console.error(`Error getting database by ID ${databaseId} for user ${requestingUserId}:`, err.message); return null; }
}

function getDatabasesForNote(noteId, requestingUserId = null) {
  const db = getDb();
  try {
    // Select new calendar-related fields
    const allDBsForNote = db.prepare("SELECT id, note_id, name, is_calendar, user_id, created_at, updated_at, event_start_column_id, event_end_column_id FROM note_databases WHERE note_id = ? ORDER BY created_at DESC").all(noteId);

    const mapRow = row => ({
        ...row,
        is_calendar: !!row.is_calendar
    });

    if (requestingUserId !== null) {
        return allDBsForNote
            .map(mapRow)
            .filter(dbItem => dbItem.user_id === null || dbItem.user_id === requestingUserId);
    }
    return allDBsForNote.map(mapRow);
  }
  catch (err) { console.error(`Error getting databases for note ${noteId} (user ${requestingUserId}):`, err.message); return []; }
}

function updateDatabaseMetadata(databaseId, updates, requestingUserId) {
  const db = getDb();

  const dbToUpdate = getDatabaseById(databaseId, null); // Unfiltered fetch for ownership check and current values
  if (!dbToUpdate) {
    return { success: false, error: "Database not found." };
  }
  if (dbToUpdate.user_id !== null && dbToUpdate.user_id !== requestingUserId) {
    return { success: false, error: "Authorization failed: You do not own this database." };
  }

  const { name, is_calendar, event_start_column_id, event_end_column_id } = updates;
  if (Object.keys(updates).length === 0) return { success: false, error: "No update data provided." };

  const fieldsToSet = new Map();
  if (name !== undefined) {
    if (!name || typeof name !== 'string' || name.trim() === "") return { success: false, error: "Database name cannot be empty." };
    fieldsToSet.set("name", name.trim());
  }

  // Handling is_calendar and its implications on event column IDs
  if (is_calendar !== undefined) {
    fieldsToSet.set("is_calendar", is_calendar ? 1 : 0);
    if (is_calendar === false || is_calendar === 0) { // Explicitly setting to not a calendar
      fieldsToSet.set("event_start_column_id", null);
      fieldsToSet.set("event_end_column_id", null);
    }
  }

  // Validate and set event_start_column_id
  if (event_start_column_id !== undefined) {
    if (event_start_column_id === null) {
      fieldsToSet.set("event_start_column_id", null);
    } else {
      const colIdNum = parseInt(String(event_start_column_id), 10);
      if (isNaN(colIdNum)) return { success: false, error: "event_start_column_id must be a numeric ID or null." };
      const column = db.prepare("SELECT database_id, type FROM database_columns WHERE id = ?").get(colIdNum);
      if (!column) return { success: false, error: `event_start_column_id ${colIdNum} not found.` };
      if (column.database_id !== databaseId) return { success: false, error: `event_start_column_id ${colIdNum} does not belong to this database.` };
      if (column.type !== 'DATETIME') return { success: false, error: `event_start_column_id ${colIdNum} must be a DATETIME column.` };
      fieldsToSet.set("event_start_column_id", colIdNum);
    }
  }

  // Validate and set event_end_column_id
  if (event_end_column_id !== undefined) {
     if (event_end_column_id === null) {
      fieldsToSet.set("event_end_column_id", null);
    } else {
      const colIdNum = parseInt(String(event_end_column_id), 10);
      if (isNaN(colIdNum)) return { success: false, error: "event_end_column_id must be a numeric ID or null." };
      const column = db.prepare("SELECT database_id, type FROM database_columns WHERE id = ?").get(colIdNum);
      if (!column) return { success: false, error: `event_end_column_id ${colIdNum} not found.` };
      if (column.database_id !== databaseId) return { success: false, error: `event_end_column_id ${colIdNum} does not belong to this database.` };
      if (column.type !== 'DATETIME') return { success: false, error: `event_end_column_id ${colIdNum} must be a DATETIME column.` };
      fieldsToSet.set("event_end_column_id", colIdNum);
    }
  }

  // If is_calendar is true (either being set or already true) and event_start_column_id is not being set to null explicitly
  // and this update is not already setting it via event_start_column_id field, ensure it's not null if it's required.
  // However, the requirement says "If they are provided in updates, they must pass validation. If is_calendar is true... are null, this is acceptable"
  // So no explicit error if they are null when is_calendar is true.

  if (fieldsToSet.size === 0) return { success: true, message: "No effective changes.", database: getDatabaseById(databaseId, requestingUserId) };

  const sqlSetParts = Array.from(fieldsToSet.keys()).map(key => `${key} = ?`);
  const sqlValues = Array.from(fieldsToSet.values());

  sqlSetParts.push("updated_at = CURRENT_TIMESTAMP");
  sqlValues.push(databaseId); // For WHERE id = ?

  try {
    const stmt = db.prepare(`UPDATE note_databases SET ${sqlSetParts.join(", ")} WHERE id = ?`);
    const info = stmt.run(...sqlValues);
    if (info.changes > 0) {
      return { success: true, database: getDatabaseById(databaseId, requestingUserId) };
    }
    // This implies the WHERE clause (id = ?) didn't match, or data was identical.
    // Since we fetched dbToUpdate, it should exist. So, data might be identical.
    // However, the fieldsToSet.size === 0 check should catch identical data for *all* provided fields.
    // If only a subset of provided fields were identical, this could be reached.
    return { success: false, error: "Database not found post-auth or data effectively unchanged." };
  } catch (err) {
    console.error(`Error updating database metadata for ID ${databaseId} (user ${requestingUserId}):`, err.message);
    return { success: false, error: "Failed to update database metadata." };
  }
}

async function deleteDatabase(databaseId, requestingUserId) { // Added async
  const db = getDb();

  const dbToDelete = await getDatabaseById(databaseId, null); // Unfiltered fetch, ensure it's awaited
  if (!dbToDelete) {
    return { success: false, error: "Database not found." };
  }

  let canDelete = false;
  const isOwner = (dbToDelete.user_id === requestingUserId);

  if (isOwner) {
    canDelete = true;
  } else if (dbToDelete.user_id === null) { // Public DB
    const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
    if (isAdmin) {
      canDelete = true;
    } else {
      return { success: false, error: "Authorization failed: Only ADMIN can delete public databases." };
    }
  } else { // DB has an owner, and it's not the requestingUser
    const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
    if (isAdmin) {
      canDelete = true; // Admin can delete other users' databases
    }
  }

  if (!canDelete) {
    return { success: false, error: `Authorization failed: User ${requestingUserId} cannot delete database ${databaseId}.` };
  }

  try {
    // CASCADE constraints should handle related columns, rows, values, links
    const stmt = db.prepare("DELETE FROM note_databases WHERE id = ?");
    const info = stmt.run(databaseId);
    return info.changes > 0 ? { success: true } : { success: false, error: "Database not found at delete stage." }; // Should be caught by pre-check
  } catch (err) {
    console.error(`Error deleting database ID ${databaseId} (user ${requestingUserId}):`, err.message);
    return { success: false, error: "Failed to delete database due to server error." };
  }
}

// --- Column Management ---
async function addColumn(args, requestingUserId) { // Added async, Added requestingUserId
  const {
    databaseId, name, type, columnOrder,
    defaultValue: origDefaultValue, selectOptions: origSelectOptions,
    linkedDatabaseId: origLinkedDbId, relationTargetEntityType: origRelTargetEntityType = 'NOTE_DATABASES',
    makeBidirectional = false, targetInverseColumnName, existingTargetInverseColumnId,
    formula_definition: origFormulaDefinition, formula_result_type: origFormulaResultType,
    rollup_source_relation_column_id: origRollupSrcRelId, rollup_target_column_id: origRollupTargetId, rollup_function: origRollupFunc,
    lookup_source_relation_column_id: origLookupSrcRelId, lookup_target_value_column_id: origLookupTargetValId, lookup_multiple_behavior: origLookupMultiBehavior,
    validation_rules: origValidationRules // Added validation_rules
  } = args;

  const db = getDb();

  // Authorization for schema modification
  const parentDbUnfiltered = await getDatabaseById(databaseId, null); // Get unfiltered for direct ownership check
  if (!parentDbUnfiltered) {
    return { success: false, error: "Parent database not found." };
  }

  const isOwner = parentDbUnfiltered.user_id === requestingUserId;
  const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
  let canModifySchema = isOwner;

  if (!isOwner && parentDbUnfiltered.user_id !== null) { // Not owner and DB is not public
    if (isAdmin) canModifySchema = true;
  } else if (parentDbUnfiltered.user_id === null) { // Public DB
    if (!isAdmin) {
        return { success: false, error: "Authorization failed: Only ADMIN can modify public database schemas." };
    }
    canModifySchema = true;
  }

  if (!canModifySchema) {
      return { success: false, error: `User ${requestingUserId} is not authorized to modify schema for database ${databaseId}.` };
  }
  // If execution reaches here, user is authorized. parentDb can be the one fetched for auth.
  const parentDb = parentDbUnfiltered;


  const trimmedName = name ? name.trim() : "";

  if (!trimmedName) return { success: false, error: "Column name cannot be empty." };
  if (!type || !ALLOWED_COLUMN_TYPES.includes(type)) return { success: false, error: `Invalid column type: ${type}` };
  if (typeof columnOrder !== 'number') return { success: false, error: "Column order must be a number." };

  // Prepare all possible fields, then nullify based on type
  let finalValues = {
      defaultValue: origDefaultValue, selectOptions: origSelectOptions,
      linkedDatabaseId: origLinkedDbId, relationTargetEntityType: origRelTargetEntityType,
      inverseColumnId: null, // Handled by bidirectional logic specifically
      formulaDefinition: origFormulaDefinition, formulaResultType: origFormulaResultType,
      rollupSourceRelId: origRollupSrcRelId, rollupTargetId: origRollupTargetId, rollupFunction: origRollupFunc,
      lookupSourceRelId: origLookupSrcRelId, lookupTargetValId: origLookupTargetValId, lookupMultiBehavior: origLookupMultiBehavior,
      validationRules: origValidationRules // Added validationRules
  };

  // Validate validation_rules structure if provided
  if (finalValues.validationRules !== undefined && finalValues.validationRules !== null) {
    try {
      const rules = JSON.parse(finalValues.validationRules);
      if (!Array.isArray(rules)) throw new Error("validation_rules must be an array.");
      for (const rule of rules) {
        if (typeof rule !== 'object' || rule === null || typeof rule.type !== 'string' || typeof rule.error_message !== 'string') {
          throw new Error("Each rule in validation_rules must be an object with 'type' and 'error_message' strings.");
        }
      }
      // If valid, keep it as a JSON string. If it was an object, stringify it.
      // The service expects a string from the client for simplicity, or it could handle object input too.
      // For now, assuming client sends string or it's already stringified if constructed internally.
      if (typeof finalValues.validationRules !== 'string') {
          finalValues.validationRules = JSON.stringify(finalValues.validationRules);
      }
    } catch (e) {
      return { success: false, error: `Invalid validation_rules: ${e.message}` };
    }
  } else {
    finalValues.validationRules = null; // Ensure it's explicitly null if not provided or undefined
  }

  // Type-specific validation and field nullification/setup
  if (type === 'RELATION') {
    if (!ALLOWED_RELATION_TARGET_ENTITY_TYPES.includes(finalValues.relationTargetEntityType)) return { success: false, error: `Invalid relation_target_entity_type: ${finalValues.relationTargetEntityType}`};
    if (finalValues.relationTargetEntityType === 'NOTE_DATABASES') {
        if (finalValues.linkedDatabaseId === null || finalValues.linkedDatabaseId === undefined) return { success: false, error: "linkedDatabaseId required for RELATION to NOTE_DATABASES." };
        // Check accessibility of linkedDatabaseId by the same user (or if it's public)
        if (!getDatabaseById(finalValues.linkedDatabaseId, requestingUserId)) return { success: false, error: `Linked database ID ${finalValues.linkedDatabaseId} not found or not accessible.` };
    } else { // NOTES_TABLE
        if (finalValues.linkedDatabaseId !== null && finalValues.linkedDatabaseId !== undefined && String(finalValues.linkedDatabaseId).trim() !== "") return { success: false, error: "linkedDatabaseId must be null for RELATION to NOTES_TABLE."};
        finalValues.linkedDatabaseId = null;
        if (makeBidirectional) return { success: false, error: "Bidirectional links are not supported for relations targeting NOTES_TABLE."};
    }
    finalValues = {...finalValues, formulaDefinition: null, formulaResultType: null, rollupSourceRelId: null, rollupTargetId: null, rollupFunction: null, lookupSourceRelId: null, lookupTargetValId: null, lookupMultiBehavior: null, defaultValue: null, selectOptions: null};
  } else if (type === 'FORMULA') {
    if (!finalValues.formulaDefinition || String(finalValues.formulaDefinition).trim() === "") return { success: false, error: "formula_definition is required."};
    finalValues = {...finalValues, linkedDatabaseId: null, relationTargetEntityType: 'NOTE_DATABASES', defaultValue: null, selectOptions: null, rollupSourceRelId: null, rollupTargetId: null, rollupFunction: null, lookupSourceRelId: null, lookupTargetValId: null, lookupMultiBehavior: null, inverseColumnId: null, validationRules: null}; // No validation rules for FORMULA
  } else if (type === 'ROLLUP') {
    const err = _validateRollupDefinition({rollup_source_relation_column_id: finalValues.rollupSourceRelId, rollup_target_column_id: finalValues.rollupTargetId, rollup_function: finalValues.rollupFunction}, db, databaseId);
    if (err) return { success: false, error: err };
    finalValues = {...finalValues, linkedDatabaseId: null, relationTargetEntityType: 'NOTE_DATABASES', defaultValue: null, selectOptions: null, formulaDefinition: null, formulaResultType: null, lookupSourceRelId: null, lookupTargetValId: null, lookupMultiBehavior: null, inverseColumnId: null, validationRules: null}; // No validation rules for ROLLUP
  } else if (type === 'LOOKUP') {
    finalValues.lookupMultiBehavior = finalValues.lookupMultiBehavior || 'FIRST';
    const err = _validateLookupDefinition({lookup_source_relation_column_id: finalValues.lookupSourceRelId, lookup_target_value_column_id: finalValues.lookupTargetValId, lookup_multiple_behavior: finalValues.lookupMultiBehavior}, db, databaseId);
    if (err) return { success: false, error: err };
    finalValues = {...finalValues, linkedDatabaseId: null, relationTargetEntityType: 'NOTE_DATABASES', defaultValue: null, selectOptions: null, formulaDefinition: null, formulaResultType: null, rollupSourceRelId: null, rollupTargetId: null, rollupFunction: null, inverseColumnId: null, validationRules: null}; // No validation rules for LOOKUP
  } else { // TEXT, NUMBER, DATE, DATETIME, BOOLEAN, SELECT, MULTI_SELECT
    finalValues = {...finalValues, linkedDatabaseId: null, relationTargetEntityType: 'NOTE_DATABASES', formulaDefinition: null, formulaResultType: null, rollupSourceRelId: null, rollupTargetId: null, rollupFunction: null, lookupSourceRelId: null, lookupTargetValId: null, lookupMultiBehavior: null, inverseColumnId: null};
    // validationRules can apply to these types.
    if (makeBidirectional) return { success: false, error: "Bidirectional can only be set for RELATION type."};
    if (type === 'SELECT' || type === 'MULTI_SELECT') {
      if (finalValues.selectOptions) {
        try { if (typeof finalValues.selectOptions === 'string') JSON.parse(finalValues.selectOptions); else if (Array.isArray(finalValues.selectOptions)) finalValues.selectOptions = JSON.stringify(finalValues.selectOptions); else return { success: false, error: "selectOptions must be JSON string array."}; }
        catch (e) { return { success: false, error: "Invalid JSON for selectOptions." }; }
      } else { finalValues.selectOptions = JSON.stringify([]); }
    } else { finalValues.selectOptions = null; }
    if (type === 'DATETIME' && finalValues.defaultValue === "NOW()") finalValues.defaultValue = new Date().toISOString(); // Example default handling
  }

  const runTransaction = db.transaction(() => {
    const colAStmt = db.prepare( `INSERT INTO database_columns ( database_id, name, type, column_order, default_value, select_options, linked_database_id, relation_target_entity_type, inverse_column_id, formula_definition, formula_result_type, rollup_source_relation_column_id, rollup_target_column_id, rollup_function, lookup_source_relation_column_id, lookup_target_value_column_id, lookup_multiple_behavior, validation_rules ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)` );
    const colAInfo = colAStmt.run( databaseId, trimmedName, type, columnOrder, finalValues.defaultValue, finalValues.selectOptions, finalValues.linkedDatabaseId, finalValues.relationTargetEntityType, finalValues.formulaDefinition, finalValues.formulaResultType, finalValues.rollupSourceRelId, finalValues.rollupTargetId, finalValues.rollupFunction, finalValues.lookupSourceRelId, finalValues.lookupTargetValId, finalValues.lookupMultiBehavior, finalValues.validationRules );
    const colAId = colAInfo.lastInsertRowid;
    if (!colAId) throw new Error("Failed to create primary column.");

    if (type === 'RELATION' && makeBidirectional && finalValues.relationTargetEntityType === 'NOTE_DATABASES') {
      let colBId;
      if (existingTargetInverseColumnId !== undefined && existingTargetInverseColumnId !== null) {
        // Use existing column as inverse
        const validationResult = _validateTargetInverseColumn(existingTargetInverseColumnId, finalValues.linkedDatabaseId, databaseId, db);
        if (typeof validationResult === 'string') throw new Error(`Invalid existing target inverse column: ${validationResult}`);
        colBId = validationResult.id; // Use the validated ID
        // Update existing colB to point back to colA
        db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(colAId, colBId);
      } else {
        // Create new inverse column (colB)
        const colBName = targetInverseColumnName || `${trimmedName}_inverse_of_${parentDb.name}`.slice(0, 255); // Ensure name is reasonable
        const colBOrder = db.prepare("SELECT COUNT(*) as count FROM database_columns WHERE database_id = ?").get(finalValues.linkedDatabaseId).count + 1;

        const colBStmt = db.prepare(
            `INSERT INTO database_columns (
                database_id, name, type, column_order,
                linked_database_id, relation_target_entity_type,
                inverse_column_id,
                created_at, updated_at
            ) VALUES (?, ?, 'RELATION', ?, ?, 'NOTE_DATABASES', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        );
        // colB links back to colA's database, and its inverse_column_id is colAId
        const colBInfo = colBStmt.run(finalValues.linkedDatabaseId, colBName, colBOrder, databaseId, colAId);
        colBId = colBInfo.lastInsertRowid;
        if (!colBId) throw new Error("Failed to create inverse column (colB).");
      }
      // Update colA to point to colB
      db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(colBId, colAId);
    }
    return colAId;
  });

  try {
    const colAId = runTransaction();
    const finalColA = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(colAId);
    return { success: true, column: finalColA };
  } catch (err) {
    console.error(`Error adding column to DB ${databaseId} (user ${requestingUserId}):`, err.message, err.stack);
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') { return { success: false, error: "Column name must be unique within the database."}; }
    return { success: false, error: err.message || "Failed to add column." };
  }
}

function getColumnsForDatabase(databaseId, requestingUserId = null) {
  const db = getDb();
  const parentDb = getDatabaseById(databaseId, requestingUserId);
  if (!parentDb) {
    // If parent DB is not found or not accessible, user shouldn't see its columns.
    return [];
  }
  // Ownership of parent DB implies permission to see its columns.
  try {
    const stmt = db.prepare("SELECT *, formula_definition, formula_result_type, rollup_source_relation_column_id, rollup_target_column_id, rollup_function, lookup_source_relation_column_id, lookup_target_value_column_id, lookup_multiple_behavior, relation_target_entity_type, validation_rules FROM database_columns WHERE database_id = ? ORDER BY column_order ASC");
    // No need to map is_calendar here, it's a property of the database, not columns.
    return stmt.all(databaseId);
  } catch (err) {
    console.error(`Error getting columns for database ${databaseId} (user ${requestingUserId}):`, err.message);
    return [];
  }
}

async function updateColumn(args, requestingUserId) { // Added async, Added requestingUserId
  const { columnId, makeBidirectional, targetInverseColumnName, existingTargetInverseColumnId, ...updateData } = args;
  const db = getDb();

  if (Object.keys(updateData).length === 0 && makeBidirectional === undefined) {
    return { success: false, error: "No update data or action provided." };
  }

  const transaction = db.transaction(async () => { // Added async
    const currentCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(columnId);
    if (!currentCol) throw new Error("Column not found.");

    // Authorization for schema modification (re-check within transaction for safety, using a non-throwing pattern)
    const parentDbUnfiltered = await getDatabaseById(currentCol.database_id, null);
    if (!parentDbUnfiltered) {
        throw new Error("Parent database not found during update transaction.");
    }
    const isOwner = parentDbUnfiltered.user_id === requestingUserId;
    const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
    let canModifySchema = isOwner;

    if (!isOwner && parentDbUnfiltered.user_id !== null) {
        if (isAdmin) canModifySchema = true;
    } else if (parentDbUnfiltered.user_id === null) {
        if (!isAdmin) throw new Error("Authorization failed: Only ADMIN can modify public database schemas during update.");
        canModifySchema = true;
    }
    if (!canModifySchema) {
        throw new Error(`User ${requestingUserId} is not authorized to modify columns in database ${currentCol.database_id}.`);
    }
    // const parentDb = parentDbUnfiltered; // Use if needed later

    const fieldsToSet = new Map();
    let mustClearRowLinksForRelationChange = false;

    // Determine final characteristics by merging currentCol with updateData
    const finalState = { ...currentCol, ...updateData };
    finalState.is_calendar = !!finalState.is_calendar; // Ensure boolean for is_calendar if it were on this table

    // Name & Column Order (simple updates)
    if (updateData.name !== undefined) fieldsToSet.set("name", updateData.name.trim());
    if (updateData.columnOrder !== undefined) fieldsToSet.set("column_order", updateData.columnOrder);

    // Type change logic - if type changes, nullify all old type-specific fields first
    if (updateData.type !== undefined && updateData.type !== currentCol.type) {
      if (!ALLOWED_COLUMN_TYPES.includes(updateData.type)) throw new Error(`Invalid new type: ${updateData.type}`);
      fieldsToSet.set("type", updateData.type);

      // Nullify all potentially conflicting type-specific fields before setting new ones
      ["select_options", "linked_database_id", "relation_target_entity_type", "inverse_column_id",
       "formula_definition", "formula_result_type", "rollup_source_relation_column_id",
       "rollup_target_column_id", "rollup_function", "lookup_source_relation_column_id",
       "lookup_target_value_column_id", "lookup_multiple_behavior", "default_value", "validation_rules"] // Added validation_rules
      .forEach(key => fieldsToSet.set(key, null));

      if (currentCol.type === 'RELATION') {
        _clearInverseColumnLink(currentCol.inverse_column_id, db);
        mustClearRowLinksForRelationChange = true;
      }
    }

    // Apply settings based on finalType
    if (finalState.type === 'RELATION') {
        if (!ALLOWED_RATION_TARGET_ENTITY_TYPES.includes(finalState.relation_target_entity_type)) throw new Error(`Invalid relation_target_entity_type: ${finalState.relation_target_entity_type}`);
        fieldsToSet.set("relation_target_entity_type", finalState.relation_target_entity_type);
        if (finalState.relation_target_entity_type === 'NOTE_DATABASES') {
            if (finalState.linked_database_id === null || finalState.linked_database_id === undefined) throw new Error("linkedDatabaseId required for RELATION to NOTE_DATABASES.");
            // Check accessibility of the NEW linked_database_id by the same user
            if (updateData.linked_database_id !== undefined && !getDatabaseById(finalState.linked_database_id, requestingUserId)) {
                 throw new Error(`New linked database ID ${finalState.linked_database_id} not found or not accessible.`);
            } else if (updateData.linked_database_id === undefined && !getDatabaseById(finalState.linked_database_id, null)) { // if not updated, ensure it still exists (unfiltered)
                 throw new Error(`Current linked database ID ${finalState.linked_database_id} seems to be missing (unfiltered check).`);
            }
            fieldsToSet.set("linked_database_id", finalState.linked_database_id);

            // Handling changes that would break an existing bidirectional link
            if (currentCol.inverse_column_id !== null && currentCol.type === 'RELATION' && finalState.type === 'RELATION' &&
                (updateData.linked_database_id !== undefined && updateData.linked_database_id !== currentCol.linked_database_id ||
                 updateData.relation_target_entity_type !== undefined && updateData.relation_target_entity_type !== currentCol.relation_target_entity_type)
            ) {
                _clearInverseColumnLink(currentCol.inverse_column_id, db);
                currentCol.inverse_column_id = null; // Reflect this change in currentCol for subsequent logic
                fieldsToSet.set("inverse_column_id", null);
                mustClearRowLinksForRelationChange = true; // Links are definitely changing
            }

            if (makeBidirectional === true) {
                if (finalState.inverse_column_id && existingTargetInverseColumnId && finalState.inverse_column_id !== existingTargetInverseColumnId) {
                    _clearInverseColumnLink(finalState.inverse_column_id, db); // Clear old link before establishing new
                }

                if (existingTargetInverseColumnId !== undefined && existingTargetInverseColumnId !== null) {
                    const validationResult = _validateTargetInverseColumn(existingTargetInverseColumnId, finalState.linked_database_id, currentCol.database_id, db);
                    if (typeof validationResult === 'string') throw new Error(`Invalid existing target inverse column: ${validationResult}`);
                    const colBId = validationResult.id;
                    db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(currentCol.id, colBId);
                    fieldsToSet.set("inverse_column_id", colBId);
                } else {
                    // Create new inverse column (colB) if one doesn't exist or if we are explicitly asked to make one without providing an existing one.
                    // This implies currentCol.inverse_column_id might be null or we are overriding.
                    if (currentCol.inverse_column_id) { // If currentCol already had an inverse, clear it first.
                        _clearInverseColumnLink(currentCol.inverse_column_id, db);
                    }

                    const colBName = targetInverseColumnName || `${currentCol.name}_inverse_of_db_${currentCol.database_id}`.slice(0, 255);
                    const colBOrder = db.prepare("SELECT COUNT(*) as count FROM database_columns WHERE database_id = ?").get(finalState.linked_database_id).count + 1;

                    const colBStmt = db.prepare(
                        `INSERT INTO database_columns (
                            database_id, name, type, column_order,
                            linked_database_id, relation_target_entity_type,
                            inverse_column_id,
                            created_at, updated_at
                        ) VALUES (?, ?, 'RELATION', ?, ?, 'NOTE_DATABASES', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
                    );
                    const colBInfo = colBStmt.run(finalState.linked_database_id, colBName, colBOrder, currentCol.database_id, currentCol.id);
                    const colBId = colBInfo.lastInsertRowid;
                    if (!colBId) throw new Error("Failed to create inverse column (colB) during update.");
                    fieldsToSet.set("inverse_column_id", colBId);
                }
            } else if (makeBidirectional === false) { // Explicitly remove bidirectional link
                if (currentCol.inverse_column_id !== null) {
                    _clearInverseColumnLink(currentCol.inverse_column_id, db);
                }
                fieldsToSet.set("inverse_column_id", null);
            } else if (updateData.inverse_column_id !== undefined) { // Allowing direct set of inverse_column_id (e.g. nullifying)
                 if (currentCol.inverse_column_id && currentCol.inverse_column_id !== updateData.inverse_column_id) {
                    _clearInverseColumnLink(currentCol.inverse_column_id, db);
                 }
                 fieldsToSet.set("inverse_column_id", updateData.inverse_column_id); // Could be null or a new ID (validation might be needed for new ID)
            }
            // Note: if makeBidirectional is undefined, and inverse_column_id is not in updateData, existing inverse_column_id is preserved unless cleared by relation change logic earlier.

        } else { // NOTES_TABLE or type changed away from RELATION
            if (currentCol.inverse_column_id !== null) { // If it had an inverse link, clear it
                _clearInverseColumnLink(currentCol.inverse_column_id, db);
            }
            fieldsToSet.set("linked_database_id", null);
            fieldsToSet.set("inverse_column_id", null);
            if (makeBidirectional === true && finalState.type === 'RELATION') throw new Error("Bidirectional links not supported for NOTES_TABLE relations.");
        }

        // If type is changing to RELATION or if linked_database_id/relation_target_entity_type changes for an existing RELATION
        if ((updateData.type === 'RELATION' && currentCol.type !== 'RELATION') ||
            (currentCol.type === 'RELATION' && finalState.type === 'RELATION' &&
             (updateData.linked_database_id !== undefined && updateData.linked_database_id !== currentCol.linked_database_id ||
              updateData.relation_target_entity_type !== undefined && updateData.relation_target_entity_type !== currentCol.relation_target_entity_type))
           ) {
            mustClearRowLinksForRelationChange = true;
        }

    } else if (finalState.type === 'FORMULA') {
        if (currentCol.inverse_column_id !== null) { _clearInverseColumnLink(currentCol.inverse_column_id, db); fieldsToSet.set("inverse_column_id", null); }
        /* ... as before ... */
    }
    else if (finalState.type === 'ROLLUP') {
        if (currentCol.inverse_column_id !== null) { _clearInverseColumnLink(currentCol.inverse_column_id, db); fieldsToSet.set("inverse_column_id", null); }
        /* ... as before ... */
    }
    else if (finalState.type === 'ROLLUP') {
        if (currentCol.inverse_column_id !== null) { _clearInverseColumnLink(currentCol.inverse_column_id, db); fieldsToSet.set("inverse_column_id", null); }
        /* ... as before ... */
    }
    else if (finalState.type === 'LOOKUP') {
        if (currentCol.inverse_column_id !== null) { _clearInverseColumnLink(currentCol.inverse_column_id, db); fieldsToSet.set("inverse_column_id", null); }
        fieldsToSet.set("validation_rules", null); // No validation rules for LOOKUP
        /* ... as before ... */
    }
    else if (finalState.type === 'DATETIME') {
        if (currentCol.inverse_column_id !== null) { _clearInverseColumnLink(currentCol.inverse_column_id, db); fieldsToSet.set("inverse_column_id", null); }
        // validation_rules can apply
        /* Default value, other fields nulled by earlier mass nullification */
    }
    else { // TEXT, NUMBER, DATE, BOOLEAN, SELECT, MULTI_SELECT
      if (currentCol.inverse_column_id !== null) { // If type changed from RELATION to these types
        _clearInverseColumnLink(currentCol.inverse_column_id, db);
        fieldsToSet.set("inverse_column_id", null);
      }
      // validation_rules can apply
      if (updateData.defaultValue !== undefined) fieldsToSet.set("default_value", updateData.defaultValue);
      if (finalState.type === 'SELECT' || finalState.type === 'MULTI_SELECT') { /* ... as before ... */ }
    }

    // Handle validation_rules update for applicable types
    if (updateData.validation_rules !== undefined &&
        !['FORMULA', 'ROLLUP', 'LOOKUP', 'RELATION'].includes(finalState.type)) {
        if (updateData.validation_rules === null) {
            fieldsToSet.set("validation_rules", null);
        } else {
            try {
                const rules = JSON.parse(updateData.validation_rules);
                if (!Array.isArray(rules)) throw new Error("validation_rules must be an array.");
                for (const rule of rules) {
                    if (typeof rule !== 'object' || rule === null || typeof rule.type !== 'string' || typeof rule.error_message !== 'string') {
                        throw new Error("Each rule in validation_rules must be an object with 'type' and 'error_message' strings.");
                    }
                }
                fieldsToSet.set("validation_rules", updateData.validation_rules); // Store as JSON string
            } catch (e) {
                throw new Error(`Invalid validation_rules: ${e.message}`);
            }
        }
    } else if (['FORMULA', 'ROLLUP', 'LOOKUP', 'RELATION'].includes(finalState.type)) {
        // Ensure validation_rules are nullified if type changes to one that doesn't support them
        fieldsToSet.set("validation_rules", null);
    }


    if (fieldsToSet.size === 0 && makeBidirectional === undefined) return { success: true, message: "No effective changes." };
    const finalFieldsSql = Array.from(fieldsToSet.keys()).map(key => `${key} = ?`);
    const finalValues = Array.from(fieldsToSet.values());
    if (finalFieldsSql.length > 0) {
        finalFieldsSql.push("updated_at = CURRENT_TIMESTAMP"); finalValues.push(columnId);
        db.prepare(`UPDATE database_columns SET ${finalFieldsSql.join(", ")} WHERE id = ?`).run(...finalValues);
    }
    if (mustClearRowLinksForRelationChange) db.prepare("DELETE FROM database_row_links WHERE source_column_id = ?").run(columnId);

    const updatedCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(columnId);
    return { success: true, column: updatedCol };
  });

  try { return transaction(); }
  catch (err) {
      console.error(`Error updating column ID ${columnId} (user ${requestingUserId}):`, err.message, err.stack);
      return { success: false, error: err.message || "Failed to update column." };
    }
}

async function deleteColumn(columnId, requestingUserId) { // Added async, Added requestingUserId
  const db = getDb();
  // It's good practice to wrap this in a transaction if multiple dependent operations occur.
  // For this specific change, _clearInverseColumnLink is one operation, then delete.
  // SQLite operations are atomic per statement, but a transaction ensures both or neither.
  const transaction = db.transaction(async () => { // Added async
    const colInfo = db.prepare("SELECT database_id, inverse_column_id FROM database_columns WHERE id = ?").get(columnId);
    if (!colInfo) {
      // Throw an error to be caught by the outer catch, which will then return the error object.
      // This ensures the transaction is rolled back.
      throw new Error("Column not found.");
    }

    // Authorization for schema modification
    const parentDbUnfiltered = await getDatabaseById(colInfo.database_id, null);
    if (!parentDbUnfiltered) {
        throw new Error("Parent database not found during delete column transaction.");
    }
    const isOwner = parentDbUnfiltered.user_id === requestingUserId;
    const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
    let canModifySchema = isOwner;
    if (!isOwner && parentDbUnfiltered.user_id !== null) {
        if (isAdmin) canModifySchema = true;
    } else if (parentDbUnfiltered.user_id === null) {
        if (!isAdmin) throw new Error("Authorization failed: Only ADMIN can delete columns from public database schemas.");
        canModifySchema = true;
    }
    if (!canModifySchema) {
        throw new Error(`User ${requestingUserId} is not authorized to delete columns from database ${colInfo.database_id}.`);
    }
    // const parentDb = parentDbUnfiltered; // Use if needed

    if (colInfo.inverse_column_id !== null) {
      _clearInverseColumnLink(colInfo.inverse_column_id, db);
    }

    const stmt = db.prepare("DELETE FROM database_columns WHERE id = ?");
    const info = stmt.run(columnId);

    if (info.changes > 0) {
      // Clean up related row values and links (if not handled by CASCADE)
      // This is more robust if done with triggers or specific service calls.
      // For now, assuming direct delete of column is the main goal.
      // db.prepare("DELETE FROM database_row_values WHERE column_id = ?").run(columnId);
      // db.prepare("DELETE FROM database_row_links WHERE source_column_id = ?").run(columnId);
      return { success: true }; // Return success object for the transaction's result
    }
    // If no changes, it means the column was not found at delete stage, though colInfo found it.
    // This scenario should ideally not happen if IDs are consistent.
    throw new Error("Column found initially but delete operation affected no rows.");
  });

  try {
    return transaction(); // Execute the transaction
  } catch (err) {
    console.error(`Error deleting column ID ${columnId} (user ${requestingUserId}):`, err.message, err.stack);
    console.error(`Error deleting column ID ${columnId} (user ${requestingUserId}):`, err.message, err.stack);
    // Ensure a consistent error object structure as expected by consumers
    return { success: false, error: err.message || "Failed to delete column." };
  }
}

module.exports = {
  createDatabase, getDatabaseById, getDatabasesForNote, updateDatabaseMetadata,
  addColumn, getColumnsForDatabase, updateColumn, deleteColumn,
};
