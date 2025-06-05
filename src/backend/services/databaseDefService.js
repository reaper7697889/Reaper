// src/backend/services/databaseDefService.js
const { getDb } = require("../db");

// Updated to include 'RELATION'
const ALLOWED_COLUMN_TYPES = ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'RELATION'];

// --- Database Management ---

/**
 * Creates a new database definition.
 * @param {object} args - { name, noteId = null }
 * @returns {object} - { success: boolean, database?: object, error?: string }
 */
function createDatabase({ name, noteId = null }) {
  const db = getDb();
  if (!name || typeof name !== 'string' || name.trim() === "") {
    return { success: false, error: "Database name is required." };
  }
  try {
    const stmt = db.prepare(
      "INSERT INTO note_databases (name, note_id) VALUES (?, ?)"
    );
    const info = stmt.run(name.trim(), noteId);
    const newDb = getDatabaseById(info.lastInsertRowid); // getDatabaseById itself returns the object or null
    if (newDb) {
        return { success: true, database: newDb };
    } else {
        // Should not happen if insert succeeded and getDatabaseById is robust
        return { success: false, error: "Failed to retrieve newly created database."}
    }
  } catch (err) {
    console.error("Error creating database:", err.message);
    return { success: false, error: "Failed to create database." };
  }
}

/**
 * Retrieves a database by its ID.
 * @param {number} databaseId
 * @returns {object|null} - The database object or null if not found/error.
 */
function getDatabaseById(databaseId) {
  const db = getDb();
  try {
    const stmt = db.prepare("SELECT * FROM note_databases WHERE id = ?");
    return stmt.get(databaseId) || null;
  } catch (err) {
    console.error(`Error getting database by ID ${databaseId}:`, err.message);
    return null;
  }
}

/**
 * Retrieves all databases associated with a specific note ID.
 * @param {number} noteId
 * @returns {Array<object>} - An array of database objects.
 */
function getDatabasesForNote(noteId) {
  const db = getDb();
  try {
    const stmt = db.prepare("SELECT * FROM note_databases WHERE note_id = ? ORDER BY created_at DESC");
    return stmt.all(noteId);
  } catch (err) {
    console.error(`Error getting databases for note ${noteId}:`, err.message);
    return [];
  }
}

/**
 * Updates the name of a database.
 * @param {object} args - { databaseId, name }
 * @returns {object} - { success: boolean, error?: string }
 */
function updateDatabaseName({ databaseId, name }) {
  const db = getDb();
  const trimmedName = name ? name.trim() : "";
  if (!trimmedName) {
    return { success: false, error: "Database name cannot be empty." };
  }
  try {
    const stmt = db.prepare("UPDATE note_databases SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    const info = stmt.run(trimmedName, databaseId);
    if (info.changes > 0) {
      return { success: true };
    }
    return { success: false, error: "Database not found or name unchanged." };
  } catch (err) {
    console.error(`Error updating database name for ID ${databaseId}:`, err.message);
    return { success: false, error: "Failed to update database name." };
  }
}

/**
 * Deletes a database. Cascading deletes handle related columns and row values.
 * @param {number} databaseId
 * @returns {object} - { success: boolean, error?: string }
 */
function deleteDatabase(databaseId) {
  const db = getDb();
  try {
    const stmt = db.prepare("DELETE FROM note_databases WHERE id = ?");
    const info = stmt.run(databaseId);
    if (info.changes > 0) {
      return { success: true };
    }
    return { success: false, error: "Database not found." };
  } catch (err) {
    console.error(`Error deleting database ID ${databaseId}:`, err.message);
    return { success: false, error: "Failed to delete database." };
  }
}

// --- Column Management ---

/**
 * Adds a new column to a database.
 * @param {object} args - { databaseId, name, type, columnOrder, defaultValue = null, selectOptions = null, linkedDatabaseId = null }
 * @returns {object} - { success: boolean, column?: object, error?: string }
 */
function addColumn(args) {
  const { databaseId, name, type, columnOrder, defaultValue: origDefaultValue, selectOptions: origSelectOptions, linkedDatabaseId: origLinkedDbId } = args;
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

  if (type === 'RELATION') {
    if (linkedDatabaseId === null || linkedDatabaseId === undefined) { // Check for null or undefined explicitly
      return { success: false, error: "linkedDatabaseId is required for RELATION type columns." };
    }
    const targetDb = getDatabaseById(linkedDatabaseId);
    if (!targetDb) {
      return { success: false, error: `Linked database ID ${linkedDatabaseId} not found.` };
    }
    defaultValue = null;
    selectOptions = null;
  } else {
    linkedDatabaseId = null;
    if (type === 'SELECT' || type === 'MULTI_SELECT') {
        if (selectOptions) {
            try {
                if (typeof selectOptions === 'string') { // Ensure it's valid JSON if string
                    JSON.parse(selectOptions);
                } else if (Array.isArray(selectOptions)) {
                    selectOptions = JSON.stringify(selectOptions);
                } else {
                    return { success: false, error: "selectOptions must be a JSON string array for SELECT/MULTI_SELECT types."};
                }
            } catch (e) {
                return { success: false, error: "Invalid JSON format for selectOptions." };
            }
        } else {
             selectOptions = JSON.stringify([]);
        }
    } else {
        selectOptions = null;
    }
  }

  try {
    const stmt = db.prepare(
      "INSERT INTO database_columns (database_id, name, type, column_order, default_value, select_options, linked_database_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const info = stmt.run(databaseId, trimmedName, type, columnOrder, defaultValue, selectOptions, linkedDatabaseId);
    const newColumn = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(info.lastInsertRowid);
    return { success: true, column: newColumn };
  } catch (err) {
    console.error("Error adding column:", err.message);
     if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        if (err.message.includes('name')) return { success: false, error: "Column name already exists for this database." };
        if (err.message.includes('column_order')) return { success: false, error: "Column order already exists for this database." };
    }
    return { success: false, error: "Failed to add column." };
  }
}

/**
 * Retrieves all columns for a specific database, ordered by column_order.
 * @param {number} databaseId
 * @returns {Array<object>} - An array of column objects.
 */
function getColumnsForDatabase(databaseId) {
  const db = getDb();
  try {
    const stmt = db.prepare("SELECT id, database_id, name, type, column_order, default_value, select_options, linked_database_id FROM database_columns WHERE database_id = ? ORDER BY column_order ASC");
    return stmt.all(databaseId);
  } catch (err) {
    console.error(`Error getting columns for database ${databaseId}:`, err.message);
    return [];
  }
}

/**
 * Updates an existing column.
 * @param {object} args - { columnId, name?, type?, columnOrder?, defaultValue?, selectOptions?, linkedDatabaseId? }
 * @returns {object} - { success: boolean, error?: string }
 */
function updateColumn(args) {
  const { columnId, ...updateData } = args;
  const db = getDb();

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: "No update data provided." };
  }

  const currentCol = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(columnId);
  if (!currentCol) {
    return { success: false, error: "Column not found." };
  }

  const fieldsToSet = new Map(); // Use a map to ensure each field is set only once

  // Determine final type early
  const finalType = updateData.type !== undefined ? updateData.type : currentCol.type;

  // Name
  if (updateData.name !== undefined) {
    const trimmedName = updateData.name ? updateData.name.trim() : "";
    if (!trimmedName) return { success: false, error: "Column name cannot be empty." };
    fieldsToSet.set("name", trimmedName);
  }

  // Type and its consequences
  let mustClearLinks = false;
  if (updateData.type !== undefined) {
    if (!ALLOWED_COLUMN_TYPES.includes(updateData.type)) {
      return { success: false, error: `Invalid column type: ${updateData.type}` };
    }
    fieldsToSet.set("type", updateData.type);

    if (currentCol.type === 'RELATION' && updateData.type !== 'RELATION') {
      mustClearLinks = true;
      fieldsToSet.set("linked_database_id", null);
    }
    if (updateData.type === 'RELATION') {
      const newLinkedDbId = updateData.linkedDatabaseId !== undefined ? updateData.linkedDatabaseId : currentCol.linked_database_id;
      if (newLinkedDbId === null || newLinkedDbId === undefined) {
        return { success: false, error: "linkedDatabaseId is required when type is RELATION." };
      }
      const targetDb = getDatabaseById(newLinkedDbId);
      if (!targetDb) return { success: false, error: `Linked database ID ${newLinkedDbId} not found.` };

      fieldsToSet.set("linked_database_id", newLinkedDbId);
      if (currentCol.type === 'RELATION' && currentCol.linked_database_id !== newLinkedDbId) {
          mustClearLinks = true;
      }
      fieldsToSet.set("select_options", null);
      fieldsToSet.set("default_value", null);
    } else if (updateData.type === 'SELECT' || updateData.type === 'MULTI_SELECT') {
      fieldsToSet.set("linked_database_id", null);
      // selectOptions handled below if explicitly provided, or if type changes to this
    } else { // TEXT, NUMBER, DATE, BOOLEAN
      fieldsToSet.set("select_options", null);
      fieldsToSet.set("linked_database_id", null);
    }
  }

  // linkedDatabaseId (if type is not changing, or type is already RELATION)
  if (updateData.linkedDatabaseId !== undefined && finalType === 'RELATION') {
    if (updateData.linkedDatabaseId === null) return { success: false, error: "linkedDatabaseId cannot be null for a RELATION column."};
    const targetDb = getDatabaseById(updateData.linkedDatabaseId);
    if (!targetDb) return { success: false, error: `Linked database ID ${updateData.linkedDatabaseId} not found.` };

    if (currentCol.linked_database_id !== updateData.linkedDatabaseId) {
        mustClearLinks = true;
    }
    fieldsToSet.set("linked_database_id", updateData.linkedDatabaseId);
  }


  // selectOptions (if type is not changing, or type is already SELECT/MULTI_SELECT)
  if (updateData.selectOptions !== undefined) {
    if (finalType === 'SELECT' || finalType === 'MULTI_SELECT') {
        let newSelectOptions = updateData.selectOptions;
        if (newSelectOptions === null) { // Allow explicitly setting to null (empty array)
            newSelectOptions = JSON.stringify([]);
        } else if (typeof newSelectOptions === 'string') {
            try { JSON.parse(newSelectOptions); } catch (e) { return { success: false, error: "Invalid JSON for selectOptions." }; }
        } else if (Array.isArray(newSelectOptions)) {
            newSelectOptions = JSON.stringify(newSelectOptions);
        } else {
            return { success: false, error: "selectOptions must be a JSON string array or null."};
        }
        fieldsToSet.set("select_options", newSelectOptions);
    }
  } else if (updateData.type !== undefined && (updateData.type === 'SELECT' || updateData.type === 'MULTI_SELECT') && !fieldsToSet.has('select_options')) {
    // If type is changing to SELECT/MULTI_SELECT and selectOptions was not provided, default to empty array
    fieldsToSet.set("select_options", JSON.stringify([]));
  }


  // defaultValue (only if type is not RELATION)
  if (updateData.defaultValue !== undefined && finalType !== 'RELATION') {
    fieldsToSet.set("default_value", updateData.defaultValue);
  } else if (finalType === 'RELATION' && !fieldsToSet.has('default_value')) {
    // Ensure defaultValue is null if type is RELATION (might have been set by type change logic already)
    fieldsToSet.set("default_value", null);
  }


  // columnOrder
  if (updateData.columnOrder !== undefined) {
    if (typeof updateData.columnOrder !== 'number') return { success: false, error: "Column order must be a number." };
    fieldsToSet.set("column_order", updateData.columnOrder);
  }

  if (fieldsToSet.size === 0) {
    return { success: true, message: "No effective changes provided." };
  }

  const finalFieldsSql = [];
  const finalValues = [];
  fieldsToSet.forEach((value, key) => {
    finalFieldsSql.push(`${key} = ?`);
    finalValues.push(value);
  });

  finalFieldsSql.push("updated_at = CURRENT_TIMESTAMP");
  finalValues.push(columnId); // For WHERE id = ?

  const runUpdate = () => {
    const stmt = db.prepare(`UPDATE database_columns SET ${finalFieldsSql.join(", ")} WHERE id = ?`);
    const info = stmt.run(...finalValues);
    if (info.changes > 0 || mustClearLinks) { // If links were cleared, it's a success even if other fields didn't change
      return { success: true };
    }
    return { success: false, error: "Column not found or data effectively unchanged." };
  };

  try {
    if (mustClearLinks) {
      const transaction = db.transaction(() => {
        const deleteLinksStmt = db.prepare("DELETE FROM database_row_links WHERE source_column_id = ?");
        deleteLinksStmt.run(columnId);
        console.log(`Cleared row links for column ID ${columnId} due to type/linked_id change.`);
        return runUpdate();
      });
      return transaction();
    } else {
      return runUpdate();
    }
  } catch (err) {
    console.error(`Error updating column ID ${columnId}:`, err.message);
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        if (err.message.includes('name')) return { success: false, error: "Column name already exists for this database." };
        if (err.message.includes('column_order')) return { success: false, error: "Column order already exists for this database." };
    }
    return { success: false, error: "Failed to update column due to an unexpected error." };
  }
}

/**
 * Deletes a column.
 * @param {number} columnId
 * @returns {object} - { success: boolean, error?: string }
 */
function deleteColumn(columnId) {
  const db = getDb();
  // FOREIGN KEY constraint on database_row_links.source_column_id is ON DELETE CASCADE,
  // so related links will be deleted automatically by SQLite.
  try {
    const stmt = db.prepare("DELETE FROM database_columns WHERE id = ?");
    const info = stmt.run(columnId);
    if (info.changes > 0) {
      return { success: true };
    }
    return { success: false, error: "Column not found." };
  } catch (err) {
    console.error(`Error deleting column ID ${columnId}:`, err.message);
    return { success: false, error: "Failed to delete column." };
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
