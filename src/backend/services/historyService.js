// src/backend/services/historyService.js
const { getDb } = require("../../../db"); // Corrected path
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
    // Fetch with includeDeleted: true to allow reverting a soft-deleted note.
    const noteToRevert = await noteService.getNoteById(noteId, requestingUserId, { includeDeleted: true });
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

    // Ensure undelete by explicitly setting deleted_at and deleted_by_user_id to null
    const finalUpdateData = { ...updateData, deleted_at: null, deleted_by_user_id: null };

    const updateResult = await noteService.updateNote(noteId, finalUpdateData, requestingUserId);
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
    // Before fetching history, check if user can access the row (via its parent DB).
    // Fetch with includeDeleted: true to allow reverting a soft-deleted row.
    const currentRow = await databaseRowService.getRow(rowId, requestingUserId, { includeDeleted: true });
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

    // Ensure that reverting also "undeletes" the row by setting deleted_at to null.
    // The valuesToRevertTo from history will not contain deleted_at or deleted_by_user_id.
    // So, if the updateRow service strictly applies only keys present in `values`,
    // we might need to explicitly add them or ensure updateRow handles this.
    // For now, assume updateRow will overwrite with provided fields.
    // A more robust revert would fetch the target version's fields and explicitly set `deleted_at: null`.
    // However, `databaseRowService.updateRow` doesn't directly touch `deleted_at`.
    // The act of updating a row implies it's "active". If `revertRowToVersion` is meant to also undelete,
    // then the `updateRow` call should include `deleted_at: null`.
    // For this phase, we assume `updateRow` is sufficient.
    // The key is that `getRow(..., {includeDeleted: true})` allowed us to fetch it.
    // The `updateRow` will then set its `updated_at` and if `valuesToRevertTo` doesn't have `deleted_at`,
    // the existing `deleted_at` (if any) on the row in DB would persist unless `updateRow` clears it.

    // To ensure undelete:
    // It's better if `updateRow` implicitly unsets `deleted_at` if it's being updated with non-null values.
    // OR, `revertRowToVersion` must explicitly add `deleted_at: null` to `valuesToRevertTo`.
    // Let's assume for now that if `updateRow` is called, the row is considered "active" again,
    // and the `deleted_at` field should be reset by `updateRow` if it's not part of the `values` from history.
    // This is a subtle point. The current `updateRow` does not automatically set `deleted_at = NULL`.
    // So, to "undelete", the `valuesToRevertTo` should contain `deleted_at: null`.
    // The history `row_values_after_json` does NOT contain `deleted_at`.
    // So, we must add it here.
    const finalValuesToRevert = { ...valuesToRevertTo, deleted_at: null, deleted_by_user_id: null };


    // databaseRowService.updateRow is async and will handle its own history recording.
    // It also requires requestingUserId for its own ownership checks.
    const updateResult = await databaseRowService.updateRow({ rowId, values: finalValuesToRevert, requestingUserId });
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
  undoLastChangeForRow,
  undoLastChangeForNote, // Export the new function
};

async function undoLastChangeForNote(noteId, requestingUserId) {
  if (noteId === null || noteId === undefined) {
    return { success: false, error: "noteId is required to undo last change for a note." };
  }
  if (requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "requestingUserId is required to undo last change for a note." };
  }

  const db = getDb();
  try {
    // First, check if the note exists and is accessible by the user,
    // This is implicitly handled by revertNoteToVersion's call to noteService.getNoteById,
    // but an early check can be clearer. However, to keep it concise and rely on
    // revertNoteToVersion's existing checks, we can proceed.

    // Fetch the last two history entries for the note.
    // We only need version_number, but selecting * might be fine if overhead is negligible.
    const historyEntries = db.prepare(
      "SELECT version_number FROM notes_history WHERE note_id = ? ORDER BY version_number DESC LIMIT 2"
    ).all(noteId);

    if (!historyEntries || historyEntries.length < 2) {
      // historyEntries.length === 0 means no history (or note doesn't exist)
      // historyEntries.length === 1 means it's the initial version, no previous state to revert to.
      return { success: false, message: "No previous version available to undo to for this note." };
    }

    // historyEntries[0] is the current state (latest version recorded).
    // historyEntries[1] is the state *before* the last change was made (i.e., the state we want to revert to).
    // So, we need to revert to version_number of historyEntries[1].
    const versionToRevertTo = historyEntries[1].version_number;

    if (versionToRevertTo === null || versionToRevertTo === undefined) {
      console.error(`undoLastChangeForNote: Version number to revert to is undefined for note ${noteId}. History entry:`, historyEntries[1]);
      return { success: false, error: "Could not determine the version number to revert to for the note." };
    }

    // Call revertNoteToVersion with the identified version number.
    return await revertNoteToVersion(noteId, versionToRevertTo, requestingUserId);

  } catch (err) {
    console.error(`Error in undoLastChangeForNote for note ${noteId} (user ${requestingUserId}):`, err.message, err.stack);
    return { success: false, error: err.message || "Failed to undo last change for note." };
  }
}

async function undoLastChangeForRow(rowId, requestingUserId) {
  if (rowId === null || rowId === undefined) {
    return { success: false, error: "rowId is required to undo last change." };
  }
  if (requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "requestingUserId is required to undo last change." };
  }

  try {
    // Optional: Check accessibility and existence of the row.
    // databaseRowService.getRow also performs an ownership check.
    const currentRowCheck = await databaseRowService.getRow(rowId, requestingUserId);
    if (!currentRowCheck) {
      return { success: false, error: "Row not found or not accessible." };
    }

    // Fetch the last two history entries for the row.
    const history = await getRowHistory(rowId, { limit: 2 });

    // Check if getRowHistory returned an error structure
    if (history && history.success === false) {
        return history; // Propagate the error
    }

    if (!Array.isArray(history)) {
        // This case might occur if getRowHistory had an unhandled exception and returned something unexpected.
        // Or if it returned a single object on error (though current impl. returns array or error obj).
        console.error(`undoLastChangeForRow: getRowHistory for row ${rowId} did not return an array as expected. Received:`, history);
        return { success: false, error: "Failed to retrieve row history or history format is unexpected." };
    }

    if (history.length < 2) {
      // history.length === 0 means no history (or row doesn't exist, though getRow check above should catch that)
      // history.length === 1 means it's the initial version, no previous state to revert to.
      return { success: false, message: "No previous version available to undo to for this row." };
    }

    // history[0] is the current state (latest version recorded).
    // history[1] is the state *before* the last change was made (i.e., the state we want to revert to).
    // So, we need to revert to version_number of history[1].
    const versionToRevertTo = history[1].version_number;

    if (versionToRevertTo === null || versionToRevertTo === undefined) {
        console.error(`undoLastChangeForRow: Version number to revert to is undefined for row ${rowId}. History entry:`, history[1]);
        return { success: false, error: "Could not determine the version number to revert to." };
    }

    // Call revertRowToVersion with the identified version number.
    return await revertRowToVersion(rowId, versionToRevertTo, requestingUserId);

  } catch (err) {
    console.error(`Error in undoLastChangeForRow for row ${rowId} (user ${requestingUserId}):`, err.message, err.stack);
    return { success: false, error: err.message || "Failed to undo last change for row." };
  }
}
