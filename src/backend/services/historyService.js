// src/backend/services/historyService.js
const { getDb } = require("../db");
const noteService = require('./noteService');
const databaseRowService = require('./databaseRowService');

// --- Internal Helper Functions ---

function _parseJsonString(jsonString, fieldName, defaultValue = null) {
  if (jsonString === null || jsonString === undefined) return defaultValue;
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error(`Invalid JSON for ${fieldName}: ${jsonString}`, e);
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

async function _getNextVersionNumber(tableName, entityIdColumnName, entityId, dbInstance) {
  const db = dbInstance || getDb();
  try {
    const stmt = db.prepare(
      `SELECT IFNULL(MAX(version_number), 0) + 1 as next_version FROM ${tableName} WHERE ${entityIdColumnName} = ?`
    );
    const result = stmt.get(entityId);
    return result.next_version;
  } catch (err) {
    console.error(`Error getting next version number for ${tableName}, ${entityIdColumnName} ${entityId}:`, err.message);
    throw err;
  }
}

// --- Public Getter Functions ---

async function getNoteHistory(noteId, { limit = 50, offset = 0 } = {}) {
  if (noteId === null || noteId === undefined) {
    // Throwing error or returning structured error for consistency
    return { success: false, error: "noteId is required for getNoteHistory." };
  }
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
    if (err.message.startsWith("Corrupted JSON")) return { success: false, error: err.message };
    return [];
  }
}

async function getRowHistory(rowId, { limit = 50, offset = 0 } = {}) {
  if (rowId === null || rowId === undefined) {
     return { success: false, error: "rowId is required for getRowHistory." };
  }
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
    if (err.message.startsWith("Corrupted JSON")) return { success: false, error: err.message };
    return [];
  }
}

// --- Internal Recording Functions (Exported for use by other services) ---

async function recordNoteHistory({ noteId, oldValues = {}, newValues = {}, changedFields = [], db: externalDb = null }) {
  const db = externalDb || getDb();
  try {
    const nextVersion = await _getNextVersionNumber('notes_history', 'note_id', noteId, db);
    const changedFieldsJson = _stringifyJson(changedFields, "changedFields");

    const stmt = db.prepare(
      `INSERT INTO notes_history (
         note_id, version_number, title_before, title_after, content_before, content_after, type_before, type_after, changed_fields
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run( noteId, nextVersion, oldValues.title, newValues.title, oldValues.content, newValues.content, oldValues.type, newValues.type, changedFieldsJson );
    return { success: true, version: nextVersion };
  } catch (err) {
    console.error(`Error recording history for note ${noteId}:`, err.message);
    return { success: false, error: err.message };
  }
}

async function recordRowHistory({ rowId, oldRowValuesJson, newRowValuesJson, db: externalDb = null }) {
  const db = externalDb || getDb();
  try {
    const nextVersion = await _getNextVersionNumber('database_row_history', 'row_id', rowId, db);
    const validOldJson = oldRowValuesJson === undefined ? null : oldRowValuesJson;
    const validNewJson = newRowValuesJson === undefined ? null : newRowValuesJson;
    const stmt = db.prepare(
      `INSERT INTO database_row_history (row_id, version_number, row_values_before_json, row_values_after_json) VALUES (?, ?, ?, ?)`
    );
    stmt.run(rowId, nextVersion, validOldJson, validNewJson);
    return { success: true, version: nextVersion };
  } catch (err) {
    console.error(`Error recording history for row ${rowId}:`, err.message);
    return { success: false, error: err.message };
  }
}

// --- Public Revert Functions ---

/**
 * Reverts a note to a specific historical version.
 * @param {number} noteId - The ID of the note to revert.
 * @param {number} versionNumber - The version number to revert to.
 * @param {number} requestingUserId - ID of the user making the request.
 * @returns {Promise<object>} - { success: boolean, error?: string }
 */
async function revertNoteToVersion(noteId, versionNumber, requestingUserId) {
  const db = getDb();
  try {
    // First, ensure the requesting user can even access the note they are trying to revert.
    // noteService.getNoteById will return null if not found or not accessible.
    const noteToRevert = await noteService.getNoteById(noteId, requestingUserId);
    if (!noteToRevert) {
      return { success: false, error: "Note not found or not accessible by user." };
    }
    // Note: getNoteById might not be strictly necessary here if updateNote handles its own auth fully,
    // but it's a good pre-check. The critical part is passing requestingUserId to updateNote.

    const historyRecord = db.prepare(
      "SELECT * FROM notes_history WHERE note_id = ? AND version_number = ?"
    ).get(noteId, versionNumber);

    if (!historyRecord) {
      return { success: false, error: "Note version not found." };
    }

    const updateData = {};
    // Only add fields to updateData if they were captured in history (i.e., not null in the 'after' state)
    // and are actual fields that `noteService.updateNote` can process.
    if (historyRecord.title_after !== null) updateData.title = historyRecord.title_after;
    if (historyRecord.content_after !== null) updateData.content = historyRecord.content_after;
    if (historyRecord.type_after !== null) updateData.type = historyRecord.type_after;

    // Check if there's anything to update. If history stored all nulls for 'after' state (unlikely),
    // then updateData might be empty.
    if (Object.keys(updateData).length === 0) {
        return { success: true, message: "Historical version had no data to revert to for primary fields."};
    }

    // noteService.updateNote is async and will handle its own history recording for this revert action.
    // It also requires requestingUserId for ownership check.
    const updateResult = await noteService.updateNote(noteId, updateData, requestingUserId);
    return updateResult;

  } catch (err) {
    console.error(`Error reverting note ${noteId} to version ${versionNumber} (user ${requestingUserId}):`, err.message);
    return { success: false, error: err.message || "Failed to revert note." };
  }
}

/**
 * Reverts a database row to a specific historical version.
 * @param {number} rowId - The ID of the row to revert.
 * @param {number} versionNumber - The version number to revert to.
 * @param {number} requestingUserId - ID of the user making the request.
 * @returns {Promise<object>} - { success: boolean, error?: string }
 */
async function revertRowToVersion(rowId, versionNumber, requestingUserId) {
  const db = getDb();
  try {
    // Before fetching history, check if user can access the row (via its parent DB)
    // This requires getting the row's database_id first.
    const currentRow = await databaseRowService.getRow(rowId, requestingUserId);
    if (!currentRow) {
        return { success: false, error: "Row not found or not accessible by user."};
    }
    // If getRow succeeded, user has access to the DB, so they can attempt revert.

    const historyRecord = db.prepare(
      "SELECT row_values_after_json FROM database_row_history WHERE row_id = ? AND version_number = ?"
    ).get(rowId, versionNumber);

    if (!historyRecord) {
      return { success: false, error: "Row version not found." };
    }

    let valuesToRevertTo = {};
    if (historyRecord.row_values_after_json !== null) {
        valuesToRevertTo = _parseJsonString(historyRecord.row_values_after_json, `row ${rowId} version ${versionNumber} row_values_after_json`);
        if (valuesToRevertTo === undefined) { // _parseJsonString might throw or return undefined on error
            return { success: false, error: "Failed to parse historical row data for revert." };
        }
    } else {
        // If row_values_after_json is null, means revert to "empty" state for stored values.
        console.warn(`Row version ${versionNumber} for row ${rowId} (user ${requestingUserId}) has null for row_values_after_json. Reverting to effectively empty state for stored values.`);
    }

    // databaseRowService.updateRow is async and will handle its own history recording.
    // It also requires requestingUserId for its own ownership checks.
    const updateResult = await databaseRowService.updateRow({ rowId, values: valuesToRevertTo, requestingUserId });
    return updateResult;

  } catch (err) {
    console.error(`Error reverting row ${rowId} to version ${versionNumber} (user ${requestingUserId}):`, err.message);
    return { success: false, error: err.message || "Failed to revert row." };
  }
}

module.exports = {
  getNoteHistory,
  getRowHistory,
  recordNoteHistory,
  recordRowHistory,
  revertNoteToVersion,
  revertRowToVersion,
};
