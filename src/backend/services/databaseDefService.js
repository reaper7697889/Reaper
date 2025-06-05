// src/backend/services/databaseDefService.js
const { getDb } = require("../db");

const ALLOWED_COLUMN_TYPES = ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'RELATION'];

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
        // Potentially re-throw if this failure should halt the parent operation
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


// --- Database Management (mostly unchanged from previous versions) ---
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
    // ON DELETE CASCADE for database_id in database_columns will handle related columns.
    // ON DELETE CASCADE for linked_database_id in database_columns (SET NULL) will handle FKs.
    // ON DELETE CASCADE for inverse_column_id in database_columns (SET NULL) will handle FKs.
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
    existingTargetInverseColumnId
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
  let finalInverseColumnId = null; // This will be NULL unless bidirectional is successful

  // Initial validation and setup based on type
  if (type === 'RELATION') {
    if (linkedDatabaseId === null || linkedDatabaseId === undefined) {
      return { success: false, error: "linkedDatabaseId is required for RELATION type columns." };
    }
    const targetDbInfo = getDatabaseById(linkedDatabaseId);
    if (!targetDbInfo) return { success: false, error: `Linked database ID ${linkedDatabaseId} not found.` };
    defaultValue = null;
    selectOptions = null;
  } else {
    linkedDatabaseId = null; // Not applicable for non-RELATION
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

  // Transaction for complex bidirectional setup
  const transaction = db.transaction(() => {
    // Step 1: Insert the primary column (ColA), initially without inverse_column_id
    const colAStmt = db.prepare(
      "INSERT INTO database_columns (database_id, name, type, column_order, default_value, select_options, linked_database_id, inverse_column_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"
    );
    const colAInfo = colAStmt.run(databaseId, trimmedName, type, columnOrder, defaultValue, selectOptions, linkedDatabaseId);
    const colAId = colAInfo.lastInsertRowid;
    if (!colAId) throw new Error("Failed to create primary column.");

    if (type === 'RELATION' && makeBidirectional) {
      let colBId;
      if (existingTargetInverseColumnId !== undefined && existingTargetInverseColumnId !== null) {
        colBId = existingTargetInverseColumnId;
        // Validate existingTargetInverseColumnId (ColB)
        const validationResult = _validateTargetInverseColumn(colBId, linkedDatabaseId, databaseId, db);
        if (typeof validationResult === 'string') throw new Error(validationResult);
        const targetCol = validationResult;
        if (targetCol.inverse_column_id !== null && targetCol.inverse_column_id !== colAId) {
            throw new Error(`Target inverse column ${colBId} is already linked to another column (${targetCol.inverse_column_id}).`);
        }
        // Update ColB to point to ColA
        db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(colAId, colBId);
      } else {
        // Auto-create inverse column (ColB)
        const currentDb = getDatabaseById(databaseId);
        const inverseColName = targetInverseColumnName ? targetInverseColumnName.trim() : `Related ${currentDb ? currentDb.name : 'DB' } - ${trimmedName}`;
        if (!inverseColName) throw new Error("Generated inverse column name is empty.");

        // Check uniqueness of inverseColName in target DB
        const existingByName = db.prepare("SELECT id FROM database_columns WHERE database_id = ? AND name = ? COLLATE NOCASE").get(linkedDatabaseId, inverseColName);
        if(existingByName) throw new Error(`Inverse column name "${inverseColName}" already exists in target database.`);

        // Determine next column_order for ColB in target database
        const lastOrderStmt = db.prepare("SELECT MAX(column_order) as max_order FROM database_columns WHERE database_id = ?");
        const lastOrderResult = lastOrderStmt.get(linkedDatabaseId);
        const colBOrder = (lastOrderResult && typeof lastOrderResult.max_order === 'number' ? lastOrderResult.max_order : 0) + 1;

        const colBStmt = db.prepare(
          "INSERT INTO database_columns (database_id, name, type, column_order, linked_database_id, inverse_column_id) VALUES (?, ?, 'RELATION', ?, ?, ?)"
        );
        const colBInfo = colBStmt.run(linkedDatabaseId, inverseColName, colBOrder, databaseId, colAId);
        colBId = colBInfo.lastInsertRowid;
        if (!colBId) throw new Error("Failed to create inverse column.");
      }
      // Update ColA to point to ColB
      db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(colBId, colAId);
      finalInverseColumnId = colBId; // Store for the return object
    }
    return colAId; // Return ColA's ID from transaction
  });

  try {
    const colAId = transaction();
    const finalColA = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(colAId);
    return { success: true, column: finalColA };
  } catch (err) {
    console.error("Error adding column (transactional part):", err.message);
    // Check for specific unique constraint errors that might not be caught by pre-checks if names are tricky
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
    const stmt = db.prepare("SELECT id, database_id, name, type, column_order, default_value, select_options, linked_database_id, inverse_column_id FROM database_columns WHERE database_id = ? ORDER BY column_order ASC");
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

    let newLinkedDbId = updateData.linked_database_id !== undefined ? updateData.linked_database_id : currentCol.linked_database_id;
    const newType = updateData.type !== undefined ? updateData.type : currentCol.type;
    let newInverseColId = updateData.inverse_column_id !== undefined ? updateData.inverse_column_id : currentCol.inverse_column_id;

    let mustClearOldInverse = false; // Flag to clear currentCol.inverse_column_id's counterpart
    let mustSetUpNewInverse = false; // Flag to set up a new bidirectional link

    // 1. Handle changes that might clear existing inverse link or row links
    if ((updateData.type !== undefined && currentCol.type === 'RELATION' && updateData.type !== 'RELATION') ||
        (updateData.linked_database_id !== undefined && currentCol.type === 'RELATION' && currentCol.linked_database_id !== updateData.linked_database_id)) {

      _clearInverseColumnLink(currentCol.inverse_column_id, db);
      newInverseColId = null; // Column is no longer RELATION or points elsewhere one-way initially

      // Clear all row links for this column as its fundamental relation nature changed
      db.prepare("DELETE FROM database_row_links WHERE source_column_id = ?").run(columnId);
      console.log(`Cleared row links for column ${columnId} due to type/linked_database_id change.`);
    }

    // 2. Prepare fields for the main column update
    const fieldsToSet = new Map();

    if (updateData.name !== undefined) fieldsToSet.set("name", updateData.name.trim());
    if (updateData.type !== undefined) fieldsToSet.set("type", updateData.type);
    if (updateData.columnOrder !== undefined) fieldsToSet.set("column_order", updateData.columnOrder);

    // Default value handling
    if (newType === 'RELATION') fieldsToSet.set("default_value", null);
    else if (updateData.default_value !== undefined) fieldsToSet.set("default_value", updateData.default_value);

    // Select options handling
    if (newType === 'SELECT' || newType === 'MULTI_SELECT') {
      let newSelectOpts = updateData.selectOptions !== undefined ? updateData.selectOptions : currentCol.select_options;
      if (newSelectOpts === null && updateData.selectOptions !== undefined) newSelectOpts = JSON.stringify([]); // Allow explicit null to clear
      else if (typeof newSelectOpts === 'string') { try { JSON.parse(newSelectOpts); } catch (e) { throw new Error("Invalid JSON for selectOptions."); } }
      else if (Array.isArray(newSelectOpts)) newSelectOpts = JSON.stringify(newSelectOpts);
      else if (newSelectOpts === undefined) newSelectOpts = JSON.stringify([]); // Default if type changed to SELECT/MULTI and not provided
      fieldsToSet.set("select_options", newSelectOpts);
    } else {
      fieldsToSet.set("select_options", null);
    }

    // linked_database_id handling
    if (newType === 'RELATION') {
      if (newLinkedDbId === null || newLinkedDbId === undefined) throw new Error("linked_database_id is required for RELATION type.");
      const targetDb = getDatabaseById(newLinkedDbId);
      if (!targetDb) throw new Error(`Update failed: Linked database ID ${newLinkedDbId} not found.`);
      fieldsToSet.set("linked_database_id", newLinkedDbId);
    } else {
      fieldsToSet.set("linked_database_id", null);
    }

    // Initial inverse_column_id for ColA (might be temporary if bidirectional setup follows)
    fieldsToSet.set("inverse_column_id", newInverseColId);


    // 3. Determine if bidirectional setup is needed/changing
    if (newType === 'RELATION') {
        if (makeBidirectional === true) { // User wants to make/ensure it's bidirectional
            if (currentCol.inverse_column_id && updateData.inverse_column_id === undefined && !existingTargetInverseColumnId) {
                // Was bidirectional, user didn't specify a new inverse_column_id, keep it as is unless linked_db_id changed
                 if (mustClearOldInverse) { // linked_db_id changed, old inverse was cleared
                    newInverseColId = null; // Will need to set up new one
                    mustSetUpNewInverse = true;
                 } else {
                    newInverseColId = currentCol.inverse_column_id; // Try to maintain current
                 }
            } else { // New setup or explicit change
                mustSetUpNewInverse = true;
            }
             fieldsToSet.set("inverse_column_id", null); // Set to null first, then update with new B_id
        } else if (makeBidirectional === false && currentCol.inverse_column_id !== null) { // User wants to remove bidirectionality
            _clearInverseColumnLink(currentCol.inverse_column_id, db);
            newInverseColId = null;
            fieldsToSet.set("inverse_column_id", null);
        } else if (updateData.inverse_column_id !== undefined) { // Explicitly setting inverse_column_id
             _clearInverseColumnLink(currentCol.inverse_column_id, db); // Clear old one
             newInverseColId = updateData.inverse_column_id; // This will be set on ColA
             if (newInverseColId !== null) { // If setting to a new ColB, update that ColB too
                const validationResult = _validateTargetInverseColumn(newInverseColId, newLinkedDbId, currentCol.database_id, db);
                if (typeof validationResult === 'string') throw new Error(validationResult);
                 db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(columnId, newInverseColId);
             }
             fieldsToSet.set("inverse_column_id", newInverseColId);
        }
    } else { // Not a RELATION type anymore
        fieldsToSet.set("inverse_column_id", null); // Ensure it's null
    }


    // 4. Update ColA with determined fields (excluding inverse_column_id if it's being set up bidirectionally now)
    if (fieldsToSet.size > 0) {
        const fieldEntries = Array.from(fieldsToSet.entries());
        const sqlSetParts = fieldEntries.map(([key]) => `${key} = ?`);
        const sqlValues = fieldEntries.map(([, value]) => value);

        sqlSetParts.push("updated_at = CURRENT_TIMESTAMP");
        sqlValues.push(columnId);

        const updateStmt = db.prepare(`UPDATE database_columns SET ${sqlSetParts.join(", ")} WHERE id = ?`);
        updateStmt.run(...sqlValues);
    }

    // 5. Setup new inverse link if needed
    let finalColAInverseId = newInverseColId; // Start with what was determined for ColA

    if (mustSetUpNewInverse && newType === 'RELATION') {
        let colBId;
        if (existingTargetInverseColumnId !== undefined && existingTargetInverseColumnId !== null) {
            colBId = existingTargetInverseColumnId;
            const validationResult = _validateTargetInverseColumn(colBId, newLinkedDbId, currentCol.database_id, db);
            if (typeof validationResult === 'string') throw new Error(validationResult);
            const targetCol = validationResult;
            if (targetCol.inverse_column_id !== null && targetCol.inverse_column_id !== columnId) {
                 throw new Error(`Target inverse column ${colBId} is already linked to another column (${targetCol.inverse_column_id}).`);
            }
            db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(columnId, colBId);
        } else { // Auto-create new inverse ColB
            const currentDb = getDatabaseById(currentCol.database_id);
            const invColName = targetInverseColumnName ? targetInverseColumnName.trim() : `Related ${currentDb ? currentDb.name : 'DB'} - ${fieldsToSet.get('name') || currentCol.name}`;
            if (!invColName) throw new Error("Generated inverse column name is empty.");

            const existingByName = db.prepare("SELECT id FROM database_columns WHERE database_id = ? AND name = ? COLLATE NOCASE").get(newLinkedDbId, invColName);
            if(existingByName) throw new Error(`Inverse column name "${invColName}" already exists in target database.`);

            const lastOrderStmt = db.prepare("SELECT MAX(column_order) as max_order FROM database_columns WHERE database_id = ?");
            const lastOrderResult = lastOrderStmt.get(newLinkedDbId);
            const colBOrder = (lastOrderResult && typeof lastOrderResult.max_order === 'number' ? lastOrderResult.max_order : 0) + 1;

            const colBStmt = db.prepare("INSERT INTO database_columns (database_id, name, type, column_order, linked_database_id, inverse_column_id) VALUES (?, ?, 'RELATION', ?, ?, ?)");
            const colBInfo = colBStmt.run(newLinkedDbId, invColName, colBOrder, currentCol.database_id, columnId);
            colBId = colBInfo.lastInsertRowid;
            if (!colBId) throw new Error("Failed to create inverse column.");
        }
        // Update ColA's inverse_column_id to point to the new/validated ColB
        db.prepare("UPDATE database_columns SET inverse_column_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(colBId, columnId);
        finalColAInverseId = colBId;
    }

    return { success: true, finalInverseId: finalColAInverseId }; // Return success
  });

  try {
    return transaction();
  } catch (err) {
    console.error(`Error updating column ID ${columnId} (transactional part):`, err.message);
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') { // From the main update to ColA if name/order conflicts
        if (err.message.includes('name')) return { success: false, error: "Column name already exists for this database." };
        if (err.message.includes('column_order')) return { success: false, error: "Column order already exists for this database." };
    }
    return { success: false, error: err.message || "Failed to update column." };
  }
}

function deleteColumn(columnId) {
  const db = getDb();
  const transaction = db.transaction(() => {
    const columnToDelete = db.prepare("SELECT inverse_column_id FROM database_columns WHERE id = ?").get(columnId);
    if (!columnToDelete) {
      throw new Error("Column not found for deletion.");
    }

    // Clear the link from its inverse column, if any
    _clearInverseColumnLink(columnToDelete.inverse_column_id, db);

    // ON DELETE CASCADE on database_row_links.source_column_id will handle actual link data.
    // ON DELETE CASCADE on database_row_values.column_id will handle cell values.
    const stmt = db.prepare("DELETE FROM database_columns WHERE id = ?");
    const info = stmt.run(columnId);

    if (info.changes === 0) throw new Error("Column not found during delete execution (should have been caught earlier).");
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
