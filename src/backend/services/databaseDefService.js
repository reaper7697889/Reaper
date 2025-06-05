// src/backend/services/databaseDefService.js
const { getDb } = require("../db");

// Updated to include 'FORMULA'
const ALLOWED_COLUMN_TYPES = ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'RELATION', 'FORMULA'];

// --- Helper Functions ---
/**
 * Clears the inverse link of a given column.
 * @param {number} inverseColumnId - The ID of the column whose inverse_column_id needs to be nulled.
 * @param {object} db - The database instance.
 */
function _clearInverseColumnLink(inverseColumnId, db) {
    if (inverseColumnId === null || inverseColumnId === undefined) return;
    try {
        const stmt = db.prepare("UPDATE database_columns SET inverse_column_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        stmt.run(inverseColumnId);
        console.log(`Cleared inverse_column_id for column ${inverseColumnId}`);
    } catch (err) {
        console.error(`Error clearing inverse_column_id for column ${inverseColumnId}:`, err.message);
    }
}

/**
 * Validates a target column for establishing a bidirectional link.
 * @param {number} targetColumnId - The ID of the potential inverse column.
 * @param {number} expectedDbId - The database_id where targetColumnId should exist.
 * @param {number} expectedBacklinkDbId - The linked_database_id targetColumnId should point to.
 * @param {object} db - The database instance.
 * @returns {object|string} - The target column object if valid, or an error string.
 */
function _validateTargetInverseColumn(targetColumnId, expectedDbId, expectedBacklinkDbId, db) {
    const targetCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(targetColumnId);
    if (!targetCol) return "Target inverse column not found.";
    if (targetCol.database_id !== expectedDbId) return "Target inverse column is not in the linked database.";
    if (targetCol.type !== 'RELATION') return "Target inverse column is not of type RELATION.";
    if (targetCol.linked_database_id !== expectedBacklinkDbId) return `Target inverse column does not link back to the correct database (expected ${expectedBacklinkDbId}, got ${targetCol.linked_database_id}).`;
    return targetCol;
}

// --- Database Management ---
function createDatabase({ name, noteId = null }) {
  const db = getDb();
  if (!name || typeof name !== 'string' || name.trim() === "") {
    return { success: false, error: "Database name is required." };
  }
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
    formula_result_type: origFormulaResultType
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
  let inverseColumnId = null; // Will be set by bidirectional logic if applicable
  let formulaDefinition = origFormulaDefinition;
  let formulaResultType = origFormulaResultType;

  // Type-specific validation and field nullification
  if (type === 'RELATION') {
    if (linkedDatabaseId === null || linkedDatabaseId === undefined) {
      return { success: false, error: "linkedDatabaseId is required for RELATION type columns." };
    }
    const targetDbInfo = getDatabaseById(linkedDatabaseId);
    if (!targetDbInfo) return { success: false, error: `Linked database ID ${linkedDatabaseId} not found.` };
    defaultValue = null; selectOptions = null; formulaDefinition = null; formulaResultType = null;
  } else if (type === 'FORMULA') {
    if (!formulaDefinition || String(formulaDefinition).trim() === "") {
        return { success: false, error: "formula_definition is required for FORMULA type columns."};
    }
    // formula_result_type is optional
    defaultValue = null; selectOptions = null; linkedDatabaseId = null; /* inverseColumnId already null */
  } else { // TEXT, NUMBER, DATE, BOOLEAN, SELECT, MULTI_SELECT
    linkedDatabaseId = null; /* inverseColumnId already null */
    formulaDefinition = null; formulaResultType = null;
    if (makeBidirectional) return { success: false, error: "Bidirectional links can only be made for RELATION type columns."};
    if (type === 'SELECT' || type === 'MULTI_SELECT') {
      if (selectOptions) {
        try {
          if (typeof selectOptions === 'string') JSON.parse(selectOptions);
          else if (Array.isArray(selectOptions)) selectOptions = JSON.stringify(selectOptions);
          else return { success: false, error: "selectOptions must be a JSON string array."};
        } catch (e) { return { success: false, error: "Invalid JSON for selectOptions." }; }
      } else {
        selectOptions = JSON.stringify([]);
      }
    } else {
      selectOptions = null;
    }
  }

  const transaction = db.transaction(() => {
    const colAStmt = db.prepare(
      `INSERT INTO database_columns (
        database_id, name, type, column_order,
        default_value, select_options, linked_database_id, inverse_column_id,
        formula_definition, formula_result_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // inverse_column_id is initially NULL, will be updated if bidirectional
    const colAInfo = colAStmt.run(
        databaseId, trimmedName, type, columnOrder,
        defaultValue, selectOptions, linkedDatabaseId, null,
        formulaDefinition, formulaResultType
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
          "INSERT INTO database_columns (database_id, name, type, column_order, linked_database_id, inverse_column_id, formula_definition, formula_result_type) VALUES (?, ?, 'RELATION', ?, ?, ?, NULL, NULL)"
        );
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
    console.error("Error adding column (transactional part):", err.message);
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
    const stmt = db.prepare("SELECT id, database_id, name, type, column_order, default_value, select_options, linked_database_id, inverse_column_id, formula_definition, formula_result_type FROM database_columns WHERE database_id = ? ORDER BY column_order ASC");
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

    let newType = updateData.type !== undefined ? updateData.type : currentCol.type;
    let newLinkedDbId = updateData.linked_database_id !== undefined ? updateData.linked_database_id : currentCol.linked_database_id;
    let newInverseColId = updateData.inverse_column_id !== undefined ? updateData.inverse_column_id : currentCol.inverse_column_id;

    const fieldsToSet = new Map();

    // Handle name, columnOrder first as they are simpler
    if (updateData.name !== undefined) fieldsToSet.set("name", updateData.name.trim());
    if (updateData.columnOrder !== undefined) fieldsToSet.set("column_order", updateData.columnOrder);

    // Type change logic
    if (updateData.type !== undefined && updateData.type !== currentCol.type) {
      if (!ALLOWED_COLUMN_TYPES.includes(updateData.type)) throw new Error(`Invalid new type: ${updateData.type}`);
      fieldsToSet.set("type", updateData.type);

      // Clear fields from old type if switching from RELATION or to/from FORMULA
      if (currentCol.type === 'RELATION' && newType !== 'RELATION') {
        _clearInverseColumnLink(currentCol.inverse_column_id, db);
        newInverseColId = null; // Will be set by fieldsToSet.set("inverse_column_id", null) later
        db.prepare("DELETE FROM database_row_links WHERE source_column_id = ?").run(columnId);
      }
      if (currentCol.type === 'FORMULA' && newType !== 'FORMULA') {
         fieldsToSet.set("formula_definition", null);
         fieldsToSet.set("formula_result_type", null);
      }
    }

    // Set type-specific fields based on the *final* type (newType)
    if (newType === 'RELATION') {
      if (newLinkedDbId === null || newLinkedDbId === undefined) throw new Error("linked_database_id is required for RELATION type.");
      const targetDb = getDatabaseById(newLinkedDbId); // Validate newLinkedDbId
      if (!targetDb) throw new Error(`Update failed: Linked database ID ${newLinkedDbId} not found.`);
      fieldsToSet.set("linked_database_id", newLinkedDbId);
      fieldsToSet.set("default_value", null); fieldsToSet.set("select_options", null); fieldsToSet.set("formula_definition", null); fieldsToSet.set("formula_result_type", null);

      if (makeBidirectional === true) {
        // If it was already linked, and linked_db_id changed, clear old inverse
        if (currentCol.inverse_column_id && currentCol.linked_database_id !== newLinkedDbId) {
            _clearInverseColumnLink(currentCol.inverse_column_id, db);
            newInverseColId = null; // Force new setup
        }
        // Logic for setting up new/existing inverse (ColB)
        let colBId;
        if (existingTargetInverseColumnId !== undefined && existingTargetInverseColumnId !== null) {
            colBId = existingTargetInverseColumnId;
            const validationResult = _validateTargetInverseColumn(colBId, newLinkedDbId, currentCol.database_id, db);
            if (typeof validationResult === 'string') throw new Error(validationResult);
            const targetCol = validationResult;
            if (targetCol.inverse_column_id !== null && targetCol.inverse_column_id !== columnId) {
                 throw new Error(`Target inverse column ${colBId} is already linked to another column.`);
            }
            db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(columnId, colBId);
        } else if (newInverseColId === null) { // Auto-create if no existing one specified AND current is null
            const currentDbInfo = getDatabaseById(currentCol.database_id);
            const invColName = targetInverseColumnName ? targetInverseColumnName.trim() : `Related ${currentDbInfo ? currentDbInfo.name : 'DB'} - ${fieldsToSet.get('name') || currentCol.name}`;
            if (!invColName) throw new Error("Generated inverse column name is empty.");
            const existingByName = db.prepare("SELECT id FROM database_columns WHERE database_id = ? AND name = ? COLLATE NOCASE").get(newLinkedDbId, invColName);
            if(existingByName) throw new Error(`Inverse column name "${invColName}" already exists in target database.`);
            const lastOrderStmt = db.prepare("SELECT MAX(column_order) as max_order FROM database_columns WHERE database_id = ?");
            const lastOrderResult = lastOrderStmt.get(newLinkedDbId);
            const colBOrder = (lastOrderResult && typeof lastOrderResult.max_order === 'number' ? lastOrderResult.max_order : 0) + 1;
            const colBStmt = db.prepare("INSERT INTO database_columns (database_id, name, type, column_order, linked_database_id, inverse_column_id) VALUES (?, ?, 'RELATION', ?, ?, ?)");
            const colBInfo = colBStmt.run(newLinkedDbId, invColName, colBOrder, currentCol.database_id, columnId);
            colBId = colBInfo.lastInsertRowid;
            if (!colBId) throw new Error("Failed to create inverse column during update.");
        } else { // Use newInverseColId if it was explicitly provided
            colBId = newInverseColId;
             const validationResult = _validateTargetInverseColumn(colBId, newLinkedDbId, currentCol.database_id, db);
            if (typeof validationResult === 'string') throw new Error(validationResult);
            db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(columnId, colBId);
        }
        newInverseColId = colBId; // This is the new inverse for ColA
      } else if (makeBidirectional === false && currentCol.inverse_column_id !== null) {
        _clearInverseColumnLink(currentCol.inverse_column_id, db);
        newInverseColId = null;
      } // If makeBidirectional is undefined, don't change existing bidirectionality unless inverse_column_id is explicitly set
      fieldsToSet.set("inverse_column_id", newInverseColId);

    } else if (newType === 'FORMULA') {
      const newFormulaDef = updateData.formula_definition !== undefined ? updateData.formula_definition : currentCol.formula_definition;
      if (!newFormulaDef || String(newFormulaDef).trim() === "") throw new Error("formula_definition cannot be empty for FORMULA type.");
      fieldsToSet.set("formula_definition", newFormulaDef);
      if (updateData.formula_result_type !== undefined) fieldsToSet.set("formula_result_type", updateData.formula_result_type);
      else if (currentCol.type !== 'FORMULA') fieldsToSet.set("formula_result_type", null); // Default if changing to formula

      fieldsToSet.set("default_value", null); fieldsToSet.set("select_options", null); fieldsToSet.set("linked_database_id", null); fieldsToSet.set("inverse_column_id", null);
    } else { // TEXT, NUMBER, DATE, BOOLEAN, SELECT, MULTI_SELECT
      if (updateData.defaultValue !== undefined) fieldsToSet.set("default_value", updateData.defaultValue);
      if (newType === 'SELECT' || newType === 'MULTI_SELECT') {
        let newSelectOpts = updateData.selectOptions !== undefined ? updateData.selectOptions : currentCol.select_options;
        if (newSelectOpts === null && updateData.selectOptions !== undefined) newSelectOpts = JSON.stringify([]);
        else if (typeof newSelectOpts === 'string') { try { JSON.parse(newSelectOpts); } catch (e) { throw new Error("Invalid JSON for selectOptions."); }}
        else if (Array.isArray(newSelectOpts)) newSelectOpts = JSON.stringify(newSelectOpts);
        else if (newSelectOpts === undefined && (updateData.type && (updateData.type === 'SELECT' || updateData.type === 'MULTI_SELECT'))) newSelectOpts = JSON.stringify([]);
        fieldsToSet.set("select_options", newSelectOpts);
      } else {
        fieldsToSet.set("select_options", null);
      }
      fieldsToSet.set("linked_database_id", null); fieldsToSet.set("inverse_column_id", null); fieldsToSet.set("formula_definition", null); fieldsToSet.set("formula_result_type", null);
    }

    // Handle explicit update of inverse_column_id if not covered by makeBidirectional
    if (updateData.inverse_column_id !== undefined && makeBidirectional === undefined && newType === 'RELATION') {
        if (currentCol.inverse_column_id !== updateData.inverse_column_id) { // If it's actually changing
            _clearInverseColumnLink(currentCol.inverse_column_id, db); // Clear old one
            if (updateData.inverse_column_id !== null) { // If setting to a new ColB, update that ColB too
                const validationResult = _validateTargetInverseColumn(updateData.inverse_column_id, newLinkedDbId, currentCol.database_id, db);
                if (typeof validationResult === 'string') throw new Error(validationResult);
                db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(columnId, updateData.inverse_column_id);
            }
        }
        fieldsToSet.set("inverse_column_id", updateData.inverse_column_id);
    }


    if (fieldsToSet.size === 0) return { success: true, message: "No effective changes." };

    const finalFieldsSql = Array.from(fieldsToSet.keys()).map(key => `${key} = ?`);
    const finalValues = Array.from(fieldsToSet.values());

    finalFieldsSql.push("updated_at = CURRENT_TIMESTAMP");
    finalValues.push(columnId);

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

    // ON DELETE CASCADE on database_row_links.source_column_id and database_row_values.column_id handles cleanup.
    const stmt = db.prepare("DELETE FROM database_columns WHERE id = ?");
    const info = stmt.run(columnId);

    if (info.changes === 0) throw new Error("Column not found during delete execution."); // Should be caught by earlier check
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
