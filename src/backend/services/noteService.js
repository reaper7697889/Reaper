// src/backend/services/noteService.js

const { getDb } = require("../db");
const { recordNoteHistory } = require('./historyService');
const linkService = require('./linkService');

// --- Note CRUD Operations ---

function createNote(noteData) {
  const db = getDb();
  // Ensure userId is destructured, defaulting to null if not provided
  const { type, title, content, folder_id = null, workspace_id = null, is_pinned = 0, userId = null } = noteData;

  if (!type || !["simple", "markdown", "workspace_page"].includes(type)) {
    console.error("Invalid note type provided.");
    return null;
  }

  let newNoteId;
  const transaction = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO notes (type, title, content, folder_id, workspace_id, user_id, is_pinned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    // Pass userId to the SQL execution
    const info = stmt.run(type, title, content, folder_id, workspace_id, userId, is_pinned ? 1 : 0);
    newNoteId = info.lastInsertRowid;
    if (!newNoteId) {
      throw new Error("Failed to create note or retrieve newNoteId.");
    }
  });

  try {
    transaction();
    if (newNoteId) {
        console.log(`Created note with ID: ${newNoteId}`);
        // Ensure userId is part of the newValues for history if available
        const newValuesForHistory = { title, content, type, folder_id, workspace_id, is_pinned, userId };
        const oldValuesForHistory = { title: null, content: null, type: null, folder_id: null, workspace_id: null, is_pinned: null, userId: null };
        // Determine changed fields more comprehensively for history
        const changedFieldsArray = Object.keys(newValuesForHistory).filter(k =>
            newValuesForHistory[k] !== undefined && newValuesForHistory[k] !== oldValuesForHistory[k]
        );

        recordNoteHistory({
            noteId: newNoteId,
            oldValues: oldValuesForHistory,
            newValues: newValuesForHistory,
            changedFields: changedFieldsArray
        }).catch(err => console.error(`Async history recording failed for new note ${newNoteId}:`, err.message));
    }
    // The function returns the ID. The caller can use getNoteById to get the full object including user_id.
    return newNoteId;
  } catch (err) {
    console.error("Error creating note:", err.message, err.stack);
    return null;
  }
}

function getNoteById(id, requestingUserId = null) {
  const db = getDb();
  let query = "SELECT id, type, title, content, folder_id, workspace_id, user_id, is_pinned, is_archived, created_at, updated_at FROM notes WHERE id = ?";
  const params = [id];

  if (requestingUserId !== null) {
    query += " AND (user_id = ? OR user_id IS NULL)";
    params.push(requestingUserId);
  }

  try {
    const stmt = db.prepare(query);
    const note = stmt.get(...params);
    // if (note) { // No specific boolean conversion needed here }
    return note || null;
  } catch (err) {
    console.error(`Error getting note ${id} for user ${requestingUserId}:`, err.message);
    return null;
  }
}

async function updateNote(noteId, updateData, requestingUserId) { // Added requestingUserId (required)
  const db = getDb();

  // Perform ownership check first using an unfiltered get
  const noteForOwnershipCheck = db.prepare("SELECT user_id FROM notes WHERE id = ?").get(noteId);

  if (!noteForOwnershipCheck) {
    console.error(`Error updating note ${noteId}: Note not found.`);
    return { success: false, error: "Note not found." };
  }

  if (noteForOwnershipCheck.user_id !== null && noteForOwnershipCheck.user_id !== requestingUserId) {
    console.error(`Authorization failed: User ${requestingUserId} does not own note ${noteId} (owned by ${noteForOwnershipCheck.user_id}).`);
    return { success: false, error: "Authorization failed: You do not own this note." };
  }

  // Proceed with existing getNoteById logic, now potentially filtered if we passed requestingUserId,
  // but for oldValues, we need the actual current values, so unfiltered is better here.
  // However, the initial ownership check is the primary gate.
  const oldNote = getNoteById(noteId, null); // Get current state, unfiltered by user for history
  if (!oldNote) { // Should not happen if ownership check passed, but as a safeguard
    console.error(`Error updating note ${noteId}: Note disappeared after ownership check.`);
    return { success: false, error: "Note not found after ownership check." };
    console.error(`Error updating note ${noteId}: Note disappeared after ownership check.`);
    return { success: false, error: "Note not found after ownership check." };
  }

  // user_id is set at creation and checked for ownership. Not typically part of updatableNoteFields by user.
  const oldValuesForHistory = { title: oldNote.title, content: oldNote.content, type: oldNote.type };
  const newValuesForHistory = { ...oldValuesForHistory };
  const changedFieldsArray = [];

  // user_id is generally not in updatableNoteFields by typical user actions, but rather set at creation or by specific ownership transfer logic.
  // If user_id can be part of updateData, it needs to be added to updatableNoteFields.
  // For now, assuming user_id is NOT changed via general updateNote.
  const updatableNoteFields = ["title", "content", "type", "folder_id", "workspace_id", "is_pinned", "is_archived"];
  const versionedFields = ["title", "content", "type"];
  const fieldsToUpdateInNotes = [];
  const valuesForNotesUpdate = [];

  for (const key of updatableNoteFields) {
    if (updateData.hasOwnProperty(key)) {
      if (updateData[key] !== oldNote[key]) {
        fieldsToUpdateInNotes.push(`${key} = ?`);
        valuesForNotesUpdate.push(typeof updateData[key] === "boolean" ? (updateData[key] ? 1 : 0) : updateData[key]);
        if (versionedFields.includes(key)) {
          changedFieldsArray.push(key);
          newValuesForHistory[key] = updateData[key];
        }
      }
    }
  }

  if (updateData.hasOwnProperty("type") && updateData.type !== oldNote.type) {
      if (!["simple", "markdown", "workspace_page"].includes(updateData.type)) {
          console.error(`Invalid new type '${updateData.type}' for note ${noteId}. Update aborted.`);
          return false;
      }
  }

  const needsHistoryRecord = changedFieldsArray.length > 0;
  const titleDidChange = changedFieldsArray.includes("title");
  const shouldUpdateBacklinks = titleDidChange && newValuesForHistory.title !== oldValuesForHistory.title;
  const needsDBTransaction = fieldsToUpdateInNotes.length > 0 || needsHistoryRecord || shouldUpdateBacklinks;

  if (!needsDBTransaction) {
    console.log(`Update called for note ${noteId}, but no effective changes.`);
    return true;
  }

  db.prepare("BEGIN").run();
  try {
    let mainUpdateSuccess = false;
    if (fieldsToUpdateInNotes.length > 0) {
      fieldsToUpdateInNotes.push("updated_at = CURRENT_TIMESTAMP");
      const updateQuery = `UPDATE notes SET ${fieldsToUpdateInNotes.join(", ")} WHERE id = ?`;
      const finalValuesForNotesUpdate = [...valuesForNotesUpdate, noteId];
      const info = db.prepare(updateQuery).run(...finalValuesForNotesUpdate);
      mainUpdateSuccess = info.changes > 0;
      if(mainUpdateSuccess) console.log(`Updated note ${noteId}. Affected rows: ${info.changes}`);
    }

    if (needsHistoryRecord) {
      const historyResult = await recordNoteHistory({
        noteId: noteId, oldValues: oldValuesForHistory, newValues: newValuesForHistory,
        changedFields: changedFieldsArray, db
      });
      if (!historyResult.success) throw new Error(historyResult.error || "Failed to record note history.");
      mainUpdateSuccess = true;
    }

    if (shouldUpdateBacklinks) {
      const updateLinksStmt = db.prepare("UPDATE links SET link_text = ? WHERE target_note_id = ? AND link_text = ?");
      updateLinksStmt.run(newValuesForHistory.title, noteId, oldValuesForHistory.title);
      console.log(`Updated link texts for note ${noteId} from '${oldValuesForHistory.title}' to '${newValuesForHistory.title}'.`);
    }

    db.prepare("COMMIT").run();
    return mainUpdateSuccess;
  } catch (err) {
    db.prepare("ROLLBACK").run();
    console.error(`Error in updateNote (transaction rolled back) for note ${noteId}:`, err.message, err.stack);
    // Return consistent error object
    return { success: false, error: `Failed to update note: ${err.message}` };
  }
}

function deleteNote(noteId, requestingUserId) { // Added requestingUserId (required)
  const db = getDb();
  const transaction = db.transaction(() => {
    // Ownership check before deleting
    const noteForOwnershipCheck = db.prepare("SELECT user_id FROM notes WHERE id = ?").get(noteId);

    if (!noteForOwnershipCheck) {
      // Note: If we want to distinguish "not found" from "auth failed", this check is important.
      // For now, throwing error will lead to a generic "failed to delete" if not caught specifically.
      // Consider returning a specific object like { success: false, error: "Note not found." } if preferred.
      throw new Error(`Note ${noteId} not found for deletion.`);
    }

    if (noteForOwnershipCheck.user_id !== null && noteForOwnershipCheck.user_id !== requestingUserId) {
      throw new Error(`Authorization failed: User ${requestingUserId} does not own note ${noteId}.`);
    }

    const stmt = db.prepare("DELETE FROM notes WHERE id = ?");
    const info = stmt.run(noteId);

    if (info.changes > 0) {
      console.log(`Deleted note ${noteId} by user ${requestingUserId}. Rows affected: ${info.changes}`);
      const cleanupStmt = db.prepare(`
        DELETE FROM database_row_links
        WHERE target_row_id = ?
        AND source_column_id IN (
            SELECT id FROM database_columns
            WHERE type = 'RELATION'
            AND relation_target_entity_type = 'NOTES_TABLE'
        )
      `);
      const cleanupInfo = cleanupStmt.run(noteId);
      console.log(`Cleaned up ${cleanupInfo.changes} 'NOTES_TABLE' relation links targeting deleted note ${noteId}.`);
      return { success: true, changes: info.changes };
    }
    // This case (info.changes === 0 after ownership check passed) implies note was deleted between check and delete, which is unlikely in a transaction.
    // Or, note existed but delete op failed for other reasons.
    return { success: false, error: "Note not found or delete operation failed unexpectedly." };
  });

  try {
    return transaction();
  } catch (err) {
    console.error(`Error deleting note ${noteId} (user ${requestingUserId}):`, err.message, err.stack);
    // Ensure rollback is attempted if transaction function throws
    // (though db.transaction() handles this if the error propagates out of its callback)
    // try { db.prepare("ROLLBACK").run(); } catch (e) { /* ignore rollback error if already rolled back */ }
    return { success: false, error: err.message || "Failed to delete note." };
  }
}

function listNotesByFolder(folderId, requestingUserId = null) {
    const db = getDb();
    let query = "SELECT id, type, title, user_id, is_pinned, updated_at FROM notes WHERE folder_id = ? AND is_archived = 0";
    const params = [folderId];

    if (requestingUserId !== null) {
        query += " AND (user_id = ? OR user_id IS NULL)";
        params.push(requestingUserId);
    }
    query += " ORDER BY is_pinned DESC, updated_at DESC";

    try {
        const stmt = db.prepare(query);
        return stmt.all(...params);
    } catch (err) {
        console.error(`Error listing notes for folder ${folderId} (user ${requestingUserId}):`, err.message);
        return [];
    }
}

module.exports = {
  createNote,
  getNoteById,
  updateNote,
  deleteNote,
  listNotesByFolder,
};
