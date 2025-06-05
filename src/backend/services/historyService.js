// src/backend/services/historyService.js
const { getDb } = require("../db");

// --- Internal Helper Functions ---

function _parseJsonString(jsonString, fieldName, defaultValue = null) {
  if (jsonString === null || jsonString === undefined) return defaultValue;
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error(`Invalid JSON for ${fieldName}: ${jsonString}`, e);
    // It might be better to throw or return a specific error object
    // For now, returning the default value (e.g. null or empty array for changed_fields)
    // or the original string if it's critical to see the malformed data.
    // Let's return an error indicator or the default.
    // For history, if parsing fails, it's a data corruption issue.
    throw new Error(`Corrupted JSON data for ${fieldName} in history.`);
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
 * Gets the next version number for a given entity in a history table.
 * @param {string} tableName - The name of the history table (e.g., 'notes_history').
 * @param {string} entityIdColumnName - The name of the column holding the entity's ID (e.g., 'note_id').
 * @param {number} entityId - The ID of the entity.
 * @param {object} db - The database instance.
 * @returns {Promise<number>} - The next version number.
 */
async function _getNextVersionNumber(tableName, entityIdColumnName, entityId, db) {
  // This function doesn't need to be async if db operations are synchronous
  // However, keeping it async for consistency if other db ops become async.
  // For better-sqlite3, operations are synchronous.
  try {
    const stmt = db.prepare(
      `SELECT IFNULL(MAX(version_number), 0) + 1 as next_version FROM ${tableName} WHERE ${entityIdColumnName} = ?`
    );
    const result = stmt.get(entityId);
    return result.next_version;
  } catch (err) {
    console.error(`Error getting next version number for ${tableName}, ${entityIdColumnName} ${entityId}:`, err.message);
    throw err; // Re-throw to be caught by calling transactional function if any
  }
}

// --- Public Getter Functions ---

/**
 * Retrieves history for a specific note.
 * @param {number} noteId
 * @param {object} options - { limit = 50, offset = 0 }
 * @returns {Promise<Array<object>>} - Array of history records.
 */
async function getNoteHistory(noteId, { limit = 50, offset = 0 } = {}) {
  if (noteId === null || noteId === undefined) throw new Error("noteId is required.");
  const db = getDb();
  try {
    const stmt = db.prepare(
      "SELECT * FROM notes_history WHERE note_id = ? ORDER BY version_number DESC LIMIT ? OFFSET ?"
    );
    const rows = stmt.all(noteId, limit, offset);
    return rows.map(row => ({
      ...row,
      changed_fields: _parseJsonString(row.changed_fields, `note ${noteId} history changed_fields`, []),
    }));
  } catch (err) {
    console.error(`Error getting history for note ${noteId}:`, err.message);
    return []; // Return empty array on error
  }
}

/**
 * Retrieves history for a specific database row.
 * @param {number} rowId
 * @param {object} options - { limit = 50, offset = 0 }
 * @returns {Promise<Array<object>>} - Array of history records.
 */
async function getRowHistory(rowId, { limit = 50, offset = 0 } = {}) {
  if (rowId === null || rowId === undefined) throw new Error("rowId is required.");
  const db = getDb();
  try {
    const stmt = db.prepare(
      "SELECT * FROM database_row_history WHERE row_id = ? ORDER BY version_number DESC LIMIT ? OFFSET ?"
    );
    const rows = stmt.all(rowId, limit, offset);
    return rows.map(row => ({
      ...row,
      row_values_before_json: _parseJsonString(row.row_values_before_json, `row ${rowId} history before_json`),
      row_values_after_json: _parseJsonString(row.row_values_after_json, `row ${rowId} history after_json`),
    }));
  } catch (err) {
    console.error(`Error getting history for row ${rowId}:`, err.message);
    return [];
  }
}

// --- Internal Recording Functions (Exported for use by other services) ---

/**
 * Records a version of a note's changes.
 * @param {object} params - { noteId, oldValues, newValues, changedFields, db (optional, for transactions) }
 * @returns {Promise<object>} - { success: boolean, error?: string }
 */
async function recordNoteHistory({ noteId, oldValues = {}, newValues = {}, changedFields = [], db: externalDb = null }) {
  const db = externalDb || getDb(); // Use provided db if in transaction, else get new
  try {
    const nextVersion = await _getNextVersionNumber('notes_history', 'note_id', noteId, db);
    const changedFieldsJson = _stringifyJson(changedFields, "changedFields");

    const stmt = db.prepare(
      `INSERT INTO notes_history (
         note_id, version_number,
         title_before, title_after,
         content_before, content_after,
         type_before, type_after,
         changed_fields
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      noteId, nextVersion,
      oldValues.title, newValues.title,
      oldValues.content, newValues.content,
      oldValues.type, newValues.type,
      changedFieldsJson
    );
    return { success: true, version: nextVersion };
  } catch (err) {
    console.error(`Error recording history for note ${noteId}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Records a version of a database row's changes.
 * @param {object} params - { rowId, oldRowValuesJson, newRowValuesJson, db (optional, for transactions) }
 * @returns {Promise<object>} - { success: boolean, error?: string }
 */
async function recordRowHistory({ rowId, oldRowValuesJson, newRowValuesJson, db: externalDb = null }) {
  const db = externalDb || getDb();
  try {
    const nextVersion = await _getNextVersionNumber('database_row_history', 'row_id', rowId, db);

    // Ensure JSON strings are valid or null
    const validOldJson = oldRowValuesJson === undefined ? null : oldRowValuesJson;
    const validNewJson = newRowValuesJson === undefined ? null : newRowValuesJson;

    const stmt = db.prepare(
      `INSERT INTO database_row_history (
         row_id, version_number,
         row_values_before_json, row_values_after_json
       ) VALUES (?, ?, ?, ?)`
    );
    stmt.run(rowId, nextVersion, validOldJson, validNewJson);
    return { success: true, version: nextVersion };
  } catch (err) {
    console.error(`Error recording history for row ${rowId}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  getNoteHistory,
  getRowHistory,
  recordNoteHistory,
  recordRowHistory,
  // _getNextVersionNumber is internal but could be exported for testing if needed
};
