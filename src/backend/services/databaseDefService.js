// src/backend/services/databaseDefService.js
const { getDb } = require("../db");

// Updated to include 'ROLLUP'
const ALLOWED_COLUMN_TYPES = ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'RELATION', 'FORMULA', 'ROLLUP'];
const ALLOWED_ROLLUP_FUNCTIONS = [
    'COUNT_ALL', 'COUNT_VALUES', 'COUNT_UNIQUE_VALUES',
    'SUM', 'AVG', 'MIN', 'MAX',
    'SHOW_UNIQUE', // Primarily for text/select, might show as comma-separated string or array
    'PERCENT_EMPTY', 'PERCENT_NOT_EMPTY',
    'COUNT_CHECKED', 'COUNT_UNCHECKED',
    'PERCENT_CHECKED', 'PERCENT_UNCHECKED'
];

// --- Helper Functions ---
function _clearInverseColumnLink(inverseColumnId, db) {
    if (inverseColumnId === null || inverseColumnId === undefined) return;
    try {
        db.prepare("UPDATE database_columns SET inverse_column_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(inverseColumnId);
        console.log(`Cleared inverse_column_id for column ${inverseColumnId}`);
    } catch (err) {
        console.error(`Error clearing inverse_column_id for column ${inverseColumnId}:`, err.message);
    }
}

function _validateTargetInverseColumn(targetColumnId, expectedDbId, expectedBacklinkDbId, db) {
    const targetCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(targetColumnId);
    if (!targetCol) return "Target inverse column not found.";
    if (targetCol.database_id !== expectedDbId) return "Target inverse column is not in the linked database.";
    if (targetCol.type !== 'RELATION') return "Target inverse column is not of type RELATION.";
    if (targetCol.linked_database_id !== expectedBacklinkDbId) return `Target inverse column does not link back to the correct database (expected ${expectedBacklinkDbId}, got ${targetCol.linked_database_id}).`;
    return targetCol;
}

function _validateRollupDefinition(rollupArgs, db, currentDatabaseId) {
    const { rollup_source_relation_column_id, rollup_target_column_id, rollup_function } = rollupArgs;

    if (rollup_source_relation_column_id === null || rollup_source_relation_column_id === undefined) return "Rollup source relation column ID is required.";
    if (rollup_target_column_id === null || rollup_target_column_id === undefined) return "Rollup target column ID is required.";
    if (!rollup_function) return "Rollup function is required.";
    if (!ALLOWED_ROLLUP_FUNCTIONS.includes(rollup_function)) return `Invalid rollup function: ${rollup_function}.`;

    const sourceCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(rollup_source_relation_column_id);
    if (!sourceCol) return `Rollup source relation column ID ${rollup_source_relation_column_id} not found.`;
    if (sourceCol.database_id !== currentDatabaseId) return "Rollup source relation column must be in the same database as the rollup column.";
    if (sourceCol.type !== 'RELATION') return "Rollup source column must be of type RELATION.";
    if (sourceCol.linked_database_id === null) return "Rollup source relation column does not have a linked database.";

    const targetCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(rollup_target_column_id);
    if (!targetCol) return `Rollup target column ID ${rollup_target_column_id} not found.`;
    if (targetCol.database_id !== sourceCol.linked_database_id) return "Rollup target column is not in the database linked by the source relation column.";

    // Type Compatibility Checks
    const targetType = targetCol.type === 'FORMULA' ? targetCol.formula_result_type : targetCol.type;
    if (!targetType) { // Could happen if formula_result_type is null for a formula target
        return `Rollup target column (ID: ${targetCol.id}) is a FORMULA with an undefined result type. Cannot perform rollup.`;
    }

    if (['SUM', 'AVG'].includes(rollup_function) && targetType !== 'NUMBER') {
      return `Rollup function ${rollup_function} requires the target column ('${targetCol.name}') to be of type NUMBER (or a FORMULA resulting in NUMBER). Actual type: ${targetType}.`;
    }
    if (['COUNT_CHECKED', 'COUNT_UNCHECKED', 'PERCENT_CHECKED', 'PERCENT_UNCHECKED'].includes(rollup_function) && targetType !== 'BOOLEAN') {
      return `Rollup function ${rollup_function} requires the target column ('${targetCol.name}') to be of type BOOLEAN (or a FORMULA resulting in BOOLEAN). Actual type: ${targetType}.`;
    }
    if (['MIN', 'MAX'].includes(rollup_function) && !['NUMBER', 'DATE'].includes(targetType)) {
         return `Rollup function ${rollup_function} requires the target column ('${targetCol.name}') to be of type NUMBER or DATE. Actual type: ${targetType}.`;
    }
    // SHOW_UNIQUE, COUNT_ALL, COUNT_VALUES, COUNT_UNIQUE_VALUES, PERCENT_EMPTY, PERCENT_NOT_EMPTY are generally compatible with most types.

    return null; // No error
}


// --- Database Management ---
function createDatabase({ name, noteId = null }) {
  const db = getDb();
  if (!name || typeof name !== 'string' || name.trim() === "") return { success: false, error: "Database name is required." };
  try {
    const stmt = db.prepare("INSERT INTO note_databases (name, note_id) VALUES (?, ?)");
    const info = stmt.run(name.trim(), noteId);
    const newDb = getDatabaseById(info.lastInsertRowid);
    if (newDb) return { success: true, database: newDb };
    return { success: false, error: "Failed to retrieve newly created database."};
  } catch (err) {
    console.error("Error creating database:", err.message);
    return { success: false, error: "Failed to create database." };
  }
}

function getDatabaseById(databaseId) {
  const db = getDb();
  try {
    return db.prepare("SELECT * FROM note_databases WHERE id = ?").get(databaseId) || null;
  } catch (err) {
    console.error(`Error getting database by ID ${databaseId}:`, err.message);
    return null;
  }
}

function getDatabasesForNote(noteId) {
  const db = getDb();
  try {
    return db.prepare("SELECT * FROM note_databases WHERE note_id = ? ORDER BY created_at DESC").all(noteId);
  } catch (err) {
    console.error(`Error getting databases for note ${noteId}:`, err.message);
    return [];
  }
}

function updateDatabaseName({ databaseId, name }) {
  const db = getDb();
  const trimmedName = name ? name.trim() : "";
  if (!trimmedName) return { success: false, error: "Database name cannot be empty." };
  try {
    const stmt = db.prepare("UPDATE note_databases SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    const info = stmt.run(trimmedName, databaseId);
    return info.changes > 0 ? { success: true } : { success: false, error: "Database not found or name unchanged." };
  } catch (err) {
    console.error(`Error updating database name for ID ${databaseId}:`, err.message);
    return { success: false, error: "Failed to update database name." };
  }
}

function deleteDatabase(databaseId) {
  const db = getDb();
  try {
    const stmt = db.prepare("DELETE FROM note_databases WHERE id = ?");
    const info = stmt.run(databaseId);
    return info.changes > 0 ? { success: true } : { success: false, error: "Database not found." };
  } catch (err) {
    console.error(`Error deleting database ID ${databaseId}:`, err.message);
    return { success: false, error: "Failed to delete database." };
  }
}

// --- Column Management ---

function addColumn(args) {
  const {
    databaseId, name, type, columnOrder,
    defaultValue: origDefaultValue,
    selectOptions: origSelectOptions,
    linkedDatabaseId: origLinkedDbId,
    makeBidirectional = false,
    targetInverseColumnName,
    existingTargetInverseColumnId,
    formula_definition: origFormulaDefinition,
    formula_result_type: origFormulaResultType,
    rollup_source_relation_column_id: origRollupSrcRelId,
    rollup_target_column_id: origRollupTargetId,
    rollup_function: origRollupFunc
  } = args;

  const db = getDb();
  const trimmedName = name ? name.trim() : "";

  if (!trimmedName) return { success: false, error: "Column name cannot be empty." };
  if (!type || !ALLOWED_COLUMN_TYPES.includes(type)) {
    return { success: false, error: `Invalid column type. Allowed types: ${ALLOWED_COLUMN_TYPES.join(', ')}` };
  }
  if (typeof columnOrder !== 'number') return { success: false, error: "Column order must be a number." };

  let defaultValue = origDefaultValue;
  let selectOptions = origSelectOptions;
  let linkedDatabaseId = origLinkedDbId;
  let formulaDefinition = origFormulaDefinition;
  let formulaResultType = origFormulaResultType;
  let rollupSourceRelId = origRollupSrcRelId;
  let rollupTargetId = origRollupTargetId;
  let rollupFunction = origRollupFunc;

  // Nullify fields not applicable to the chosen type
  if (type !== 'RELATION') { linkedDatabaseId = null; /* inverseColumnId is handled by bidirectional logic */ }
  if (type !== 'FORMULA') { formulaDefinition = null; formulaResultType = null; }
  if (type !== 'ROLLUP') { rollupSourceRelId = null; rollupTargetId = null; rollupFunction = null; }
  if (type !== 'SELECT' && type !== 'MULTI_SELECT') { selectOptions = null; }
  if (type === 'RELATION' || type === 'FORMULA' || type === 'ROLLUP') { defaultValue = null; }


  // Type-specific validation and field setup
  if (type === 'RELATION') {
    if (linkedDatabaseId === null || linkedDatabaseId === undefined) return { success: false, error: "linkedDatabaseId is required for RELATION type columns." };
    const targetDbInfo = getDatabaseById(linkedDatabaseId);
    if (!targetDbInfo) return { success: false, error: `Linked database ID ${linkedDatabaseId} not found.` };
  } else if (type === 'FORMULA') {
    if (!formulaDefinition || String(formulaDefinition).trim() === "") return { success: false, error: "formula_definition is required for FORMULA type columns."};
  } else if (type === 'ROLLUP') {
    const rollupValidationError = _validateRollupDefinition({ rollup_source_relation_column_id: rollupSourceRelId, rollup_target_column_id: rollupTargetId, rollup_function: rollupFunction }, db, databaseId);
    if (rollupValidationError) return { success: false, error: rollupValidationError };
  } else if (type === 'SELECT' || type === 'MULTI_SELECT') {
    if (selectOptions) {
      try {
        if (typeof selectOptions === 'string') JSON.parse(selectOptions);
        else if (Array.isArray(selectOptions)) selectOptions = JSON.stringify(selectOptions);
        else return { success: false, error: "selectOptions must be a JSON string array."};
      } catch (e) { return { success: false, error: "Invalid JSON for selectOptions." }; }
    } else {
      selectOptions = JSON.stringify([]);
    }
  }

  const transaction = db.transaction(() => {
    const colAStmt = db.prepare(
      `INSERT INTO database_columns (
        database_id, name, type, column_order, default_value, select_options,
        linked_database_id, inverse_column_id,
        formula_definition, formula_result_type,
        rollup_source_relation_column_id, rollup_target_column_id, rollup_function
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
    );
    const colAInfo = colAStmt.run(
        databaseId, trimmedName, type, columnOrder, defaultValue, selectOptions,
        linkedDatabaseId, formulaDefinition, formulaResultType,
        rollupSourceRelId, rollupTargetId, rollupFunction
    );
    const colAId = colAInfo.lastInsertRowid;
    if (!colAId) throw new Error("Failed to create primary column.");

    if (type === 'RELATION' && makeBidirectional) {
      let colBId;
      if (existingTargetInverseColumnId !== undefined && existingTargetInverseColumnId !== null) {
        colBId = existingTargetInverseColumnId;
        const validationResult = _validateTargetInverseColumn(colBId, linkedDatabaseId, databaseId, db);
        if (typeof validationResult === 'string') throw new Error(validationResult);
        const targetCol = validationResult;
        if (targetCol.inverse_column_id !== null && targetCol.inverse_column_id !== colAId) {
            throw new Error(`Target inverse column ${colBId} is already linked to another column (${targetCol.inverse_column_id}).`);
        }
        db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(colAId, colBId);
      } else {
        const currentDb = getDatabaseById(databaseId);
        const invColName = targetInverseColumnName ? targetInverseColumnName.trim() : `Related ${currentDb ? currentDb.name : 'DB'} - ${trimmedName}`;
        if (!invColName) throw new Error("Generated inverse column name is empty.");
        const existingByName = db.prepare("SELECT id FROM database_columns WHERE database_id = ? AND name = ? COLLATE NOCASE").get(linkedDatabaseId, invColName);
        if(existingByName) throw new Error(`Inverse column name "${invColName}" already exists in target database.`);
        const lastOrderStmt = db.prepare("SELECT MAX(column_order) as max_order FROM database_columns WHERE database_id = ?");
        const lastOrderResult = lastOrderStmt.get(linkedDatabaseId);
        const colBOrder = (lastOrderResult && typeof lastOrderResult.max_order === 'number' ? lastOrderResult.max_order : 0) + 1;
        const colBStmt = db.prepare(
          "INSERT INTO database_columns (database_id, name, type, column_order, linked_database_id, inverse_column_id) VALUES (?, ?, 'RELATION', ?, ?, ?)"
        ); // Other fields default to NULL for ColB
        const colBInfo = colBStmt.run(linkedDatabaseId, invColName, colBOrder, databaseId, colAId);
        colBId = colBInfo.lastInsertRowid;
        if (!colBId) throw new Error("Failed to create inverse column.");
      }
      db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(colBId, colAId);
    }
    return colAId;
  });

  try {
    const colAId = transaction();
    const finalColA = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(colAId);
    return { success: true, column: finalColA };
  } catch (err) {
    console.error("Error adding column (transactional part):", err.message, err.stack);
     if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        if (err.message.includes('name')) return { success: false, error: "Column name already exists for this database." };
        if (err.message.includes('column_order')) return { success: false, error: "Column order already exists for this database." };
    }
    return { success: false, error: err.message || "Failed to add column." };
  }
}

function getColumnsForDatabase(databaseId) {
  const db = getDb();
  try {
    const stmt = db.prepare("SELECT id, database_id, name, type, column_order, default_value, select_options, linked_database_id, inverse_column_id, formula_definition, formula_result_type, rollup_source_relation_column_id, rollup_target_column_id, rollup_function FROM database_columns WHERE database_id = ? ORDER BY column_order ASC");
    return stmt.all(databaseId);
  } catch (err) {
    console.error(`Error getting columns for database ${databaseId}:`, err.message);
    return [];
  }
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
    let mustClearRowLinks = false;

    // Determine final characteristics of the column after update
    const finalType = updateData.type !== undefined ? updateData.type : currentCol.type;
    let finalLinkedDbId = updateData.linked_database_id !== undefined ? updateData.linked_database_id : currentCol.linked_database_id;
    let finalInverseColId = updateData.inverse_column_id !== undefined ? updateData.inverse_column_id : currentCol.inverse_column_id;

    let finalRollupSourceRelId = updateData.rollup_source_relation_column_id !== undefined ? updateData.rollup_source_relation_column_id : currentCol.rollup_source_relation_column_id;
    let finalRollupTargetId = updateData.rollup_target_column_id !== undefined ? updateData.rollup_target_column_id : currentCol.rollup_target_column_id;
    let finalRollupFunc = updateData.rollup_function !== undefined ? updateData.rollup_function : currentCol.rollup_function;


    // Name & Column Order
    if (updateData.name !== undefined) fieldsToSet.set("name", updateData.name.trim());
    if (updateData.columnOrder !== undefined) fieldsToSet.set("column_order", updateData.columnOrder);

    // Type change logic
    if (updateData.type !== undefined && updateData.type !== currentCol.type) {
      if (!ALLOWED_COLUMN_TYPES.includes(updateData.type)) throw new Error(`Invalid new type: ${updateData.type}`);
      fieldsToSet.set("type", updateData.type);

      // Cleanup from old type
      if (currentCol.type === 'RELATION') {
        _clearInverseColumnLink(currentCol.inverse_column_id, db);
        finalInverseColId = null; // Reset for the new type unless it's also RELATION and sets it
        mustClearRowLinks = true; // Row links are specific to this RELATION column
      }
      if (currentCol.type === 'FORMULA') { fieldsToSet.set("formula_definition", null); fieldsToSet.set("formula_result_type", null); }
      if (currentCol.type === 'ROLLUP') { fieldsToSet.set("rollup_source_relation_column_id", null); fieldsToSet.set("rollup_target_column_id", null); fieldsToSet.set("rollup_function", null); }
      if (currentCol.type === 'SELECT' || currentCol.type === 'MULTI_SELECT') { fieldsToSet.set("select_options", null); }
      if (currentCol.type !== 'RELATION' && currentCol.type !== 'FORMULA' && currentCol.type !== 'ROLLUP') { /*defaultValue cleared below if new type needs it*/ }
    }

    // Set fields based on finalType
    if (finalType === 'RELATION') {
      if (finalLinkedDbId === null || finalLinkedDbId === undefined) throw new Error("linked_database_id is required for RELATION type.");
      const targetDb = getDatabaseById(finalLinkedDbId);
      if (!targetDb) throw new Error(`Update failed: Linked database ID ${finalLinkedDbId} not found.`);
      fieldsToSet.set("linked_database_id", finalLinkedDbId);

      // Nullify fields not applicable to RELATION
      fieldsToSet.set("default_value", null); fieldsToSet.set("select_options", null);
      fieldsToSet.set("formula_definition", null); fieldsToSet.set("formula_result_type", null);
      fieldsToSet.set("rollup_source_relation_column_id", null); fieldsToSet.set("rollup_target_column_id", null); fieldsToSet.set("rollup_function", null);

      // Bidirectional logic
      if (makeBidirectional === true) {
        if (currentCol.inverse_column_id && currentCol.linked_database_id !== finalLinkedDbId) { // Linked DB changed, old inverse is invalid
            _clearInverseColumnLink(currentCol.inverse_column_id, db);
            finalInverseColId = null;
        }
        let colBIdToSet;
        if (existingTargetInverseColumnId !== undefined && existingTargetInverseColumnId !== null) {
            colBIdToSet = existingTargetInverseColumnId;
            const validationResult = _validateTargetInverseColumn(colBIdToSet, finalLinkedDbId, currentCol.database_id, db);
            if (typeof validationResult === 'string') throw new Error(validationResult);
            const targetCol = validationResult;
            if (targetCol.inverse_column_id !== null && targetCol.inverse_column_id !== columnId) throw new Error(`Target inverse column ${colBIdToSet} is already linked to another column.`);
            db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(columnId, colBIdToSet);
        } else if (finalInverseColId === null) { // Auto-create if no existing one specified AND current is null (or became null due to linked_db_id change)
            const currentDbInfo = getDatabaseById(currentCol.database_id);
            const invColName = targetInverseColumnName ? targetInverseColumnName.trim() : `Related ${currentDbInfo ? currentDbInfo.name : 'DB'} - ${fieldsToSet.get('name') || currentCol.name}`;
            if (!invColName) throw new Error("Generated inverse column name for update is empty.");
            const existingByName = db.prepare("SELECT id FROM database_columns WHERE database_id = ? AND name = ? COLLATE NOCASE").get(finalLinkedDbId, invColName);
            if(existingByName) throw new Error(`Inverse column name "${invColName}" already exists in target database.`);
            const lastOrderStmt = db.prepare("SELECT MAX(column_order) as max_order FROM database_columns WHERE database_id = ?");
            const lastOrderResult = lastOrderStmt.get(finalLinkedDbId);
            const colBOrder = (lastOrderResult && typeof lastOrderResult.max_order === 'number' ? lastOrderResult.max_order : 0) + 1;
            const colBStmt = db.prepare("INSERT INTO database_columns (database_id, name, type, column_order, linked_database_id, inverse_column_id) VALUES (?, ?, 'RELATION', ?, ?, ?)");
            const colBInfo = colBStmt.run(finalLinkedDbId, invColName, colBOrder, currentCol.database_id, columnId);
            colBIdToSet = colBInfo.lastInsertRowid;
            if (!colBIdToSet) throw new Error("Failed to create inverse column during update.");
        } else { // Use existing/provided finalInverseColId
            colBIdToSet = finalInverseColId;
            // If finalInverseColId was explicitly provided in updateData, ensure its counterpart is updated.
            if (updateData.inverse_column_id !== undefined && updateData.inverse_column_id !== null) {
                 const validationResult = _validateTargetInverseColumn(updateData.inverse_column_id, finalLinkedDbId, currentCol.database_id, db);
                 if (typeof validationResult === 'string') throw new Error(validationResult);
                 db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(columnId, updateData.inverse_column_id);
            }
        }
        finalInverseColId = colBIdToSet;
      } else if (makeBidirectional === false && currentCol.inverse_column_id !== null) { // Explicitly removing bidirectionality
        _clearInverseColumnLink(currentCol.inverse_column_id, db);
        finalInverseColId = null;
      } else if (updateData.inverse_column_id !== undefined && finalType === 'RELATION') { // Explicitly setting inverse_column_id without makeBidirectional flag
         _clearInverseColumnLink(currentCol.inverse_column_id, db); // Clear old one first
         if (updateData.inverse_column_id !== null) {
            const validationResult = _validateTargetInverseColumn(updateData.inverse_column_id, finalLinkedDbId, currentCol.database_id, db);
            if (typeof validationResult === 'string') throw new Error(validationResult);
            db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(columnId, updateData.inverse_column_id);
         }
         finalInverseColId = updateData.inverse_column_id;
      }
      fieldsToSet.set("inverse_column_id", finalInverseColId);

    } else if (finalType === 'FORMULA') {
      const newFormulaDef = updateData.formula_definition !== undefined ? updateData.formula_definition : currentCol.formula_definition;
      if (!newFormulaDef || String(newFormulaDef).trim() === "") throw new Error("formula_definition cannot be empty for FORMULA type.");
      fieldsToSet.set("formula_definition", newFormulaDef);
      if (updateData.formula_result_type !== undefined) fieldsToSet.set("formula_result_type", updateData.formula_result_type);
      else if (currentCol.type !== 'FORMULA') fieldsToSet.set("formula_result_type", null); // Default if changing to formula

      fieldsToSet.set("default_value", null); fieldsToSet.set("select_options", null); fieldsToSet.set("linked_database_id", null); fieldsToSet.set("inverse_column_id", null);
      fieldsToSet.set("rollup_source_relation_column_id", null); fieldsToSet.set("rollup_target_column_id", null); fieldsToSet.set("rollup_function", null);

    } else if (finalType === 'ROLLUP') {
        const rollupArgs = {
            rollup_source_relation_column_id: finalRollupSourceRelId,
            rollup_target_column_id: finalRollupTargetId,
            rollup_function: finalRollupFunc
        };
        const rollupValidationError = _validateRollupDefinition(rollupArgs, db, currentCol.database_id);
        if (rollupValidationError) throw new Error(rollupValidationError);

        fieldsToSet.set("rollup_source_relation_column_id", finalRollupSourceRelId);
        fieldsToSet.set("rollup_target_column_id", finalRollupTargetId);
        fieldsToSet.set("rollup_function", finalRollupFunc);

        fieldsToSet.set("default_value", null); fieldsToSet.set("select_options", null); fieldsToSet.set("linked_database_id", null); fieldsToSet.set("inverse_column_id", null);
        fieldsToSet.set("formula_definition", null); fieldsToSet.set("formula_result_type", null);

    } else { // TEXT, NUMBER, DATE, BOOLEAN, SELECT, MULTI_SELECT
      if (updateData.defaultValue !== undefined) fieldsToSet.set("default_value", updateData.defaultValue);
      if (finalType === 'SELECT' || finalType === 'MULTI_SELECT') {
        let newSelectOpts = updateData.selectOptions !== undefined ? updateData.selectOptions : currentCol.select_options;
        if (newSelectOpts === null && updateData.selectOptions !== undefined) newSelectOpts = JSON.stringify([]);
        else if (typeof newSelectOpts === 'string') { try { JSON.parse(newSelectOpts); } catch (e) { throw new Error("Invalid JSON for selectOptions."); }}
        else if (Array.isArray(newSelectOpts)) newSelectOpts = JSON.stringify(newSelectOpts);
        else if (newSelectOpts === undefined && (updateData.type && (updateData.type === 'SELECT' || updateData.type === 'MULTI_SELECT'))) newSelectOpts = JSON.stringify([]);
        fieldsToSet.set("select_options", newSelectOpts);
      } else {
        fieldsToSet.set("select_options", null);
      }
      fieldsToSet.set("linked_database_id", null); fieldsToSet.set("inverse_column_id", null);
      fieldsToSet.set("formula_definition", null); fieldsToSet.set("formula_result_type", null);
      fieldsToSet.set("rollup_source_relation_column_id", null); fieldsToSet.set("rollup_target_column_id", null); fieldsToSet.set("rollup_function", null);
    }

    if (fieldsToSet.size === 0) return { success: true, message: "No effective changes." };

    const finalFieldsSql = Array.from(fieldsToSet.keys()).map(key => `${key} = ?`);
    const finalValues = Array.from(fieldsToSet.values());

    finalFieldsSql.push("updated_at = CURRENT_TIMESTAMP");
    finalValues.push(columnId);

    if (mustClearRowLinks) {
      db.prepare("DELETE FROM database_row_links WHERE source_column_id = ?").run(columnId);
      console.log(`Cleared row links for column ${columnId} due to type/linked_database_id change during update.`);
    }

    const updateStmt = db.prepare(`UPDATE database_columns SET ${finalFieldsSql.join(", ")} WHERE id = ?`);
    const info = updateStmt.run(...finalValues);

    return { success: info.changes > 0 };
  });

  try {
    return transaction();
  } catch (err) {
    console.error(`Error updating column ID ${columnId}:`, err.message, err.stack);
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        if (err.message.includes('name')) return { success: false, error: "Column name already exists for this database." };
        if (err.message.includes('column_order')) return { success: false, error: "Column order already exists for this database." };
    }
    return { success: false, error: err.message || "Failed to update column." };
  }
}

function deleteColumn(columnId) {
  const db = getDb();
  const transaction = db.transaction(() => {
    const columnToDelete = db.prepare("SELECT type, inverse_column_id FROM database_columns WHERE id = ?").get(columnId);
    if (!columnToDelete) throw new Error("Column not found for deletion.");

    if (columnToDelete.type === 'RELATION' && columnToDelete.inverse_column_id !== null) {
      _clearInverseColumnLink(columnToDelete.inverse_column_id, db);
    }

    const stmt = db.prepare("DELETE FROM database_columns WHERE id = ?");
    const info = stmt.run(columnId);

    if (info.changes === 0) throw new Error("Column not found during delete execution.");
    return { success: true };
  });

  try {
    return transaction();
  } catch (err) {
    console.error(`Error deleting column ID ${columnId}:`, err.message);
    return { success: false, error: err.message || "Failed to delete column." };
  }
}

module.exports = {
  createDatabase,
  getDatabaseById,
  getDatabasesForNote,
  updateDatabaseName,
  deleteDatabase,
  addColumn,
  getColumnsForDatabase,
  updateColumn,
  deleteColumn,
};
