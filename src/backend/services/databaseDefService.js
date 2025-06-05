// src/backend/services/databaseDefService.js
const { getDb } = require("../db");

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
function createDatabase(args) {
  const db = getDb();
  const { name, noteId = null, is_calendar = 0, userId = null } = args; // Extract userId from args

  if (!name || typeof name !== 'string' || name.trim() === "") return { success: false, error: "Database name is required." };
  try {
    const stmt = db.prepare("INSERT INTO note_databases (name, note_id, is_calendar, user_id) VALUES (?, ?, ?, ?)"); // Add user_id to SQL
    const info = stmt.run(name.trim(), noteId, is_calendar ? 1 : 0, userId); // Pass userId
    const newDb = getDatabaseById(info.lastInsertRowid); // This should fetch the object including user_id
    if (newDb) return { success: true, database: newDb };
    return { success: false, error: "Failed to retrieve newly created database."};
  } catch (err) { console.error("Error creating database:", err.message); return { success: false, error: "Failed to create database." }; }
}

function getDatabaseById(databaseId) {
  const db = getDb();
  try {
    // Ensure user_id is selected if the column exists on note_databases
    const row = db.prepare("SELECT * FROM note_databases WHERE id = ?").get(databaseId);
    if (row) row.is_calendar = !!row.is_calendar; // Parse to boolean
    return row || null;
  }
  catch (err) { console.error(`Error getting database by ID ${databaseId}:`, err.message); return null; }
}

function getDatabasesForNote(noteId) {
  const db = getDb();
  try {
    const rows = db.prepare("SELECT * FROM note_databases WHERE note_id = ? ORDER BY created_at DESC").all(noteId);
    return rows.map(row => ({...row, is_calendar: !!row.is_calendar}));
  }
  catch (err) { console.error(`Error getting databases for note ${noteId}:`, err.message); return []; }
}

function updateDatabaseMetadata(databaseId, updates) {
  const db = getDb();
  const { name, is_calendar } = updates;
  if (Object.keys(updates).length === 0) return { success: false, error: "No update data provided."};

  const fieldsToSet = new Map();
  if (name !== undefined) {
    if (!name || typeof name !== 'string' || name.trim() === "") return { success: false, error: "Database name cannot be empty." };
    fieldsToSet.set("name", name.trim());
  }
  if (is_calendar !== undefined) {
    fieldsToSet.set("is_calendar", is_calendar ? 1 : 0);
  }

  if (fieldsToSet.size === 0) return { success: true, message: "No effective changes.", database: getDatabaseById(databaseId) };

  const sqlSetParts = Array.from(fieldsToSet.keys()).map(key => `${key} = ?`);
  const sqlValues = Array.from(fieldsToSet.values());

  sqlSetParts.push("updated_at = CURRENT_TIMESTAMP");
  sqlValues.push(databaseId);

  try {
    const stmt = db.prepare(`UPDATE note_databases SET ${sqlSetParts.join(", ")} WHERE id = ?`);
    const info = stmt.run(...sqlValues);
    if (info.changes > 0) {
      return { success: true, database: getDatabaseById(databaseId) };
    }
    return { success: false, error: "Database not found or data unchanged." };
  } catch (err) {
    console.error(`Error updating database metadata for ID ${databaseId}:`, err.message);
    return { success: false, error: "Failed to update database metadata." };
  }
}

function deleteDatabase(databaseId) {
  const db = getDb();
  try {
    const stmt = db.prepare("DELETE FROM note_databases WHERE id = ?");
    const info = stmt.run(databaseId);
    return info.changes > 0 ? { success: true } : { success: false, error: "Database not found." };
  } catch (err) { console.error(`Error deleting database ID ${databaseId}:`, err.message); return { success: false, error: "Failed to delete database." }; }
}

// --- Column Management ---
function addColumn(args) {
  const {
    databaseId, name, type, columnOrder,
    defaultValue: origDefaultValue, selectOptions: origSelectOptions,
    linkedDatabaseId: origLinkedDbId, relationTargetEntityType: origRelTargetEntityType = 'NOTE_DATABASES',
    makeBidirectional = false, targetInverseColumnName, existingTargetInverseColumnId,
    formula_definition: origFormulaDefinition, formula_result_type: origFormulaResultType,
    rollup_source_relation_column_id: origRollupSrcRelId, rollup_target_column_id: origRollupTargetId, rollup_function: origRollupFunc,
    lookup_source_relation_column_id: origLookupSrcRelId, lookup_target_value_column_id: origLookupTargetValId, lookup_multiple_behavior: origLookupMultiBehavior
  } = args;

  const db = getDb();
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
      lookupSourceRelId: origLookupSrcRelId, lookupTargetValId: origLookupTargetValId, lookupMultiBehavior: origLookupMultiBehavior
  };

  // Type-specific validation and field nullification/setup
  if (type === 'RELATION') {
    if (!ALLOWED_RELATION_TARGET_ENTITY_TYPES.includes(finalValues.relationTargetEntityType)) return { success: false, error: `Invalid relation_target_entity_type: ${finalValues.relationTargetEntityType}`};
    if (finalValues.relationTargetEntityType === 'NOTE_DATABASES') {
        if (finalValues.linkedDatabaseId === null || finalValues.linkedDatabaseId === undefined) return { success: false, error: "linkedDatabaseId required for RELATION to NOTE_DATABASES." };
        if (!getDatabaseById(finalValues.linkedDatabaseId)) return { success: false, error: `Linked database ID ${finalValues.linkedDatabaseId} not found.` };
    } else { // NOTES_TABLE
        if (finalValues.linkedDatabaseId !== null && finalValues.linkedDatabaseId !== undefined && String(finalValues.linkedDatabaseId).trim() !== "") return { success: false, error: "linkedDatabaseId must be null for RELATION to NOTES_TABLE."};
        finalValues.linkedDatabaseId = null;
        if (makeBidirectional) return { success: false, error: "Bidirectional links are not supported for relations targeting NOTES_TABLE."};
    }
    finalValues = {...finalValues, formulaDefinition: null, formulaResultType: null, rollupSourceRelId: null, rollupTargetId: null, rollupFunction: null, lookupSourceRelId: null, lookupTargetValId: null, lookupMultiBehavior: null, defaultValue: null, selectOptions: null};
  } else if (type === 'FORMULA') {
    if (!finalValues.formulaDefinition || String(finalValues.formulaDefinition).trim() === "") return { success: false, error: "formula_definition is required."};
    finalValues = {...finalValues, linkedDatabaseId: null, relationTargetEntityType: 'NOTE_DATABASES', defaultValue: null, selectOptions: null, rollupSourceRelId: null, rollupTargetId: null, rollupFunction: null, lookupSourceRelId: null, lookupTargetValId: null, lookupMultiBehavior: null, inverseColumnId: null};
  } else if (type === 'ROLLUP') {
    const err = _validateRollupDefinition({rollup_source_relation_column_id: finalValues.rollupSourceRelId, rollup_target_column_id: finalValues.rollupTargetId, rollup_function: finalValues.rollupFunction}, db, databaseId);
    if (err) return { success: false, error: err };
    finalValues = {...finalValues, linkedDatabaseId: null, relationTargetEntityType: 'NOTE_DATABASES', defaultValue: null, selectOptions: null, formulaDefinition: null, formulaResultType: null, lookupSourceRelId: null, lookupTargetValId: null, lookupMultiBehavior: null, inverseColumnId: null};
  } else if (type === 'LOOKUP') {
    finalValues.lookupMultiBehavior = finalValues.lookupMultiBehavior || 'FIRST';
    const err = _validateLookupDefinition({lookup_source_relation_column_id: finalValues.lookupSourceRelId, lookup_target_value_column_id: finalValues.lookupTargetValId, lookup_multiple_behavior: finalValues.lookupMultiBehavior}, db, databaseId);
    if (err) return { success: false, error: err };
    finalValues = {...finalValues, linkedDatabaseId: null, relationTargetEntityType: 'NOTE_DATABASES', defaultValue: null, selectOptions: null, formulaDefinition: null, formulaResultType: null, rollupSourceRelId: null, rollupTargetId: null, rollupFunction: null, inverseColumnId: null};
  } else { // TEXT, NUMBER, DATE, DATETIME, BOOLEAN, SELECT, MULTI_SELECT
    finalValues = {...finalValues, linkedDatabaseId: null, relationTargetEntityType: 'NOTE_DATABASES', formulaDefinition: null, formulaResultType: null, rollupSourceRelId: null, rollupTargetId: null, rollupFunction: null, lookupSourceRelId: null, lookupTargetValId: null, lookupMultiBehavior: null, inverseColumnId: null};
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
    const colAStmt = db.prepare( `INSERT INTO database_columns ( database_id, name, type, column_order, default_value, select_options, linked_database_id, relation_target_entity_type, inverse_column_id, formula_definition, formula_result_type, rollup_source_relation_column_id, rollup_target_column_id, rollup_function, lookup_source_relation_column_id, lookup_target_value_column_id, lookup_multiple_behavior ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)` );
    const colAInfo = colAStmt.run( databaseId, trimmedName, type, columnOrder, finalValues.defaultValue, finalValues.selectOptions, finalValues.linkedDatabaseId, finalValues.relationTargetEntityType, finalValues.formulaDefinition, finalValues.formulaResultType, finalValues.rollupSourceRelId, finalValues.rollupTargetId, finalValues.rollupFunction, finalValues.lookupSourceRelId, finalValues.lookupTargetValId, finalValues.lookupMultiBehavior );
    const colAId = colAInfo.lastInsertRowid;
    if (!colAId) throw new Error("Failed to create primary column.");

    if (type === 'RELATION' && makeBidirectional && finalValues.relationTargetEntityType === 'NOTE_DATABASES') {
      let colBId;
      if (existingTargetInverseColumnId !== undefined && existingTargetInverseColumnId !== null) { /* ... as before ... */ }
      else { /* ... as before ... */ }
      db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(colBId, colAId);
    }
    return colAId;
  });

  try {
    const colAId = runTransaction();
    const finalColA = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(colAId);
    return { success: true, column: finalColA };
  } catch (err) {
    console.error("Error adding column:", err.message, err.stack);
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') { /* ... */ }
    return { success: false, error: err.message || "Failed to add column." };
  }
}

function getColumnsForDatabase(databaseId) {
  const db = getDb();
  try {
    const stmt = db.prepare("SELECT *, formula_definition, formula_result_type, rollup_source_relation_column_id, rollup_target_column_id, rollup_function, lookup_source_relation_column_id, lookup_target_value_column_id, lookup_multiple_behavior, relation_target_entity_type FROM database_columns WHERE database_id = ? ORDER BY column_order ASC");
    return stmt.all(databaseId).map(col => ({...col, is_calendar: !!col.is_calendar})); // is_calendar is on note_databases
  } catch (err) { console.error(`Error getting columns for database ${databaseId}:`, err.message); return []; }
}

function updateColumn(args) {
  const { columnId, makeBidirectional, targetInverseColumnName, existingTargetInverseColumnId, ...updateData } = args;
  const db = getDb();

  if (Object.keys(updateData).length === 0 && makeBidirectional === undefined) {
    return { success: false, error: "No update data or action provided." };
  }

  const transaction = db.transaction(() => {
    const currentCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(columnId);
    if (!currentCol) throw new Error("Column not found.");

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
       "lookup_target_value_column_id", "lookup_multiple_behavior", "default_value"]
      .forEach(key => fieldsToSet.set(key, null));

      if (currentCol.type === 'RELATION') {
        _clearInverseColumnLink(currentCol.inverse_column_id, db);
        mustClearRowLinksForRelationChange = true;
      }
    }

    // Apply settings based on finalType
    if (finalState.type === 'RELATION') {
        if (!ALLOWED_RELATION_TARGET_ENTITY_TYPES.includes(finalState.relation_target_entity_type)) throw new Error(`Invalid relation_target_entity_type: ${finalState.relation_target_entity_type}`);
        fieldsToSet.set("relation_target_entity_type", finalState.relation_target_entity_type);
        if (finalState.relation_target_entity_type === 'NOTE_DATABASES') {
            if (finalState.linked_database_id === null || finalState.linked_database_id === undefined) throw new Error("linkedDatabaseId required for RELATION to NOTE_DATABASES.");
            if (!getDatabaseById(finalState.linked_database_id)) throw new Error(`Linked DB ${finalState.linked_database_id} not found.`);
            fieldsToSet.set("linked_database_id", finalState.linked_database_id);
            // Bidirectional logic only for NOTE_DATABASES target
            if (makeBidirectional === true) { /* ... complex logic from addColumn ... */ }
            else if (makeBidirectional === false && currentCol.inverse_column_id !== null) { _clearInverseColumnLink(currentCol.inverse_column_id, db); finalState.inverse_column_id = null; }
            else if (updateData.inverse_column_id !== undefined) { /* explicit set */ _clearInverseColumnLink(currentCol.inverse_column_id, db); /* then set new if valid */ }
            fieldsToSet.set("inverse_column_id", finalState.inverse_column_id);
        } else { // NOTES_TABLE
            fieldsToSet.set("linked_database_id", null);
            if (currentCol.inverse_column_id !== null) _clearInverseColumnLink(currentCol.inverse_column_id, db);
            fieldsToSet.set("inverse_column_id", null);
            if (makeBidirectional === true) throw new Error("Bidirectional links not supported for NOTES_TABLE relations.");
        }
        if (updateData.type === currentCol.type && (updateData.linked_database_id !== currentCol.linked_database_id || updateData.relation_target_entity_type !== currentCol.relation_target_entity_type)) {
            mustClearRowLinksForRelationChange = true;
        }
    } else if (finalState.type === 'FORMULA') { /* ... as before ... */ }
    else if (finalState.type === 'ROLLUP') { /* ... as before ... */ }
    else if (finalState.type === 'LOOKUP') { /* ... as before ... */ }
    else if (finalState.type === 'DATETIME') { /* Default value, other fields nulled by earlier mass nullification */ }
    else { // TEXT, NUMBER, DATE, BOOLEAN, SELECT, MULTI_SELECT
      if (updateData.defaultValue !== undefined) fieldsToSet.set("default_value", updateData.defaultValue);
      if (finalState.type === 'SELECT' || finalState.type === 'MULTI_SELECT') { /* ... as before ... */ }
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
  catch (err) { console.error(`Error updating column ID ${columnId}:`, err.message, err.stack); return { success: false, error: err.message || "Failed to update column." }; }
}

function deleteColumn(columnId) { /* ... unchanged ... */ }

module.exports = {
  createDatabase, getDatabaseById, getDatabasesForNote, updateDatabaseMetadata, // Renamed
  addColumn, getColumnsForDatabase, updateColumn, deleteColumn,
};
