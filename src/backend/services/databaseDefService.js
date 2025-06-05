// src/backend/services/databaseDefService.js
const { getDb } = require("../db");

const ALLOWED_COLUMN_TYPES = ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT'];

// --- Database Management ---

/**
 * Creates a new database definition.
 * @param {object} args - { name, noteId = null }
 * @returns {object|null} - The new database object { id, name, note_id, ... } or null on failure.
 */
function createDatabase({ name, noteId = null }) {
  const db = getDb();
  if (!name || typeof name !== 'string' || name.trim() === "") {
    console.error("Database name is required.");
    return null;
  }
  try {
    const stmt = db.prepare(
      "INSERT INTO note_databases (name, note_id) VALUES (?, ?)"
    );
    const info = stmt.run(name.trim(), noteId);
    return getDatabaseById(info.lastInsertRowid);
  } catch (err) {
    console.error("Error creating database:", err.message);
    return null;
  }
}

/**
 * Retrieves a database by its ID.
 * @param {number} databaseId
 * @returns {object|null} - The database object or null if not found.
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
 * @param {object} args - { databaseId, name, type, columnOrder, defaultValue = null, selectOptions = null }
 * @returns {object|null} - The new column object or null on failure.
 */
function addColumn({ databaseId, name, type, columnOrder, defaultValue = null, selectOptions = null }) {
  const db = getDb();
  const trimmedName = name ? name.trim() : "";

  if (!trimmedName) return { success: false, error: "Column name cannot be empty." };
  if (!type || !ALLOWED_COLUMN_TYPES.includes(type)) {
    return { success: false, error: `Invalid column type. Allowed types: ${ALLOWED_COLUMN_TYPES.join(', ')}` };
  }
  if (typeof columnOrder !== 'number') return { success: false, error: "Column order must be a number." };

  if ((type === 'SELECT' || type === 'MULTI_SELECT') && selectOptions) {
    try {
      if (typeof selectOptions === 'string') JSON.parse(selectOptions); // Validate if string
      else if (Array.isArray(selectOptions)) selectOptions = JSON.stringify(selectOptions); // Convert array to string
      else return { success: false, error: "selectOptions must be a JSON string array for SELECT/MULTI_SELECT types."};
    } catch (e) {
      return { success: false, error: "Invalid JSON format for selectOptions." };
    }
  } else if (type === 'SELECT' || type === 'MULTI_SELECT') {
    selectOptions = JSON.stringify([]); // Default to empty array if not provided
  }


  try {
    const stmt = db.prepare(
      "INSERT INTO database_columns (database_id, name, type, column_order, default_value, select_options) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const info = stmt.run(databaseId, trimmedName, type, columnOrder, defaultValue, selectOptions);
    // Fetch the newly created column to return it
    const newColumn = db.prepare("SELECT * FROM database_columns WHERE id = ?").get(info.lastInsertRowid);
    return { success: true, column: newColumn };
  } catch (err) {
    console.error("Error adding column:", err.message);
     if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        if (err.message.includes('database_id, name')) return { success: false, error: "Column name already exists for this database." };
        if (err.message.includes('database_id, column_order')) return { success: false, error: "Column order already exists for this database." };
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
    const stmt = db.prepare("SELECT * FROM database_columns WHERE database_id = ? ORDER BY column_order ASC");
    return stmt.all(databaseId);
  } catch (err) {
    console.error(`Error getting columns for database ${databaseId}:`, err.message);
    return [];
  }
}

/**
 * Updates an existing column.
 * @param {object} args - { columnId, name?, type?, columnOrder?, defaultValue?, selectOptions? }
 *                        Only provided fields will be updated.
 * @returns {object} - { success: boolean, error?: string }
 */
function updateColumn(args) {
  const { columnId, ...updateData } = args;
  const db = getDb();

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: "No update data provided." };
  }

  const fields = [];
  const values = [];

  if (updateData.name !== undefined) {
    const trimmedName = updateData.name ? updateData.name.trim() : "";
    if (!trimmedName) return { success: false, error: "Column name cannot be empty." };
    fields.push("name = ?");
    values.push(trimmedName);
  }
  if (updateData.type !== undefined) {
    if (!ALLOWED_COLUMN_TYPES.includes(updateData.type)) {
      return { success: false, error: `Invalid column type. Allowed types: ${ALLOWED_COLUMN_TYPES.join(', ')}` };
    }
    fields.push("type = ?");
    values.push(updateData.type);
     // If type is changed, ensure selectOptions are appropriate or cleared
    if (updateData.type !== 'SELECT' && updateData.type !== 'MULTI_SELECT' && updateData.selectOptions === undefined) {
        fields.push("select_options = ?");
        values.push(null);
    }
  }
  if (updateData.columnOrder !== undefined) {
    if (typeof updateData.columnOrder !== 'number') return { success: false, error: "Column order must be a number." };
    fields.push("column_order = ?");
    values.push(updateData.columnOrder);
  }
  if (updateData.defaultValue !== undefined) { // Allows setting defaultValue to null
    fields.push("default_value = ?");
    values.push(updateData.defaultValue);
  }
  if (updateData.selectOptions !== undefined) { // Allows setting selectOptions to null
    if ((updateData.type === 'SELECT' || updateData.type === 'MULTI_SELECT' || (updateData.type === undefined && (args.type === 'SELECT' || args.type === 'MULTI_SELECT'))) && updateData.selectOptions) {
        try {
            let currentType = updateData.type;
            if(!currentType) { // if type is not part of this update, fetch current type
                const currentCol = db.prepare("SELECT type FROM database_columns WHERE id = ?").get(columnId);
                if(currentCol) currentType = currentCol.type;
            }
            if(currentType === 'SELECT' || currentType === 'MULTI_SELECT') {
                 if (typeof updateData.selectOptions === 'string') JSON.parse(updateData.selectOptions);
                 else if (Array.isArray(updateData.selectOptions)) updateData.selectOptions = JSON.stringify(updateData.selectOptions);
                 else return { success: false, error: "selectOptions must be a JSON string array for SELECT/MULTI_SELECT types."};
            } else { // type is changing away from select/multi-select or was never one
                updateData.selectOptions = null;
            }
        } catch (e) {
            return { success: false, error: "Invalid JSON format for selectOptions." };
        }
    } else if (updateData.type !== 'SELECT' && updateData.type !== 'MULTI_SELECT') {
        // if type is not SELECT/MULTI_SELECT, ensure selectOptions is null
        updateData.selectOptions = null;
    }
    fields.push("select_options = ?");
    values.push(updateData.selectOptions);
  }


  if (fields.length === 0) {
    return { success: false, error: "No valid fields to update." };
  }

  fields.push("updated_at = CURRENT_TIMESTAMP");
  values.push(columnId);

  try {
    const stmt = db.prepare(`UPDATE database_columns SET ${fields.join(", ")} WHERE id = ?`);
    const info = stmt.run(...values);
    if (info.changes > 0) {
      return { success: true };
    }
    return { success: false, error: "Column not found or data unchanged." };
  } catch (err) {
    console.error(`Error updating column ID ${columnId}:`, err.message);
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        if (err.message.includes('name')) return { success: false, error: "Column name already exists for this database." };
        if (err.message.includes('column_order')) return { success: false, error: "Column order already exists for this database." };
    }
    return { success: false, error: "Failed to update column." };
  }
}

/**
 * Deletes a column.
 * @param {number} columnId
 * @returns {object} - { success: boolean, error?: string }
 */
function deleteColumn(columnId) {
  const db = getDb();
  try {
    // Note: This does not automatically delete corresponding database_row_values for this column.
    // Depending on requirements, those might need to be cleaned up too, or handled by application logic.
    // For now, we rely on potential FK constraints or allow orphaned values if schema allows.
    // The schema has ON DELETE CASCADE for database_row_values.column_id, so values will be deleted.
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
