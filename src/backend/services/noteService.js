// src/backend/services/noteService.js

const { getDb } = require("../db");
const { recordNoteHistory } = require('./historyService');
const linkService = require('./linkService');
const permissionService = require('./permissionService'); // Added

// --- Note CRUD Operations ---

async function createNote(noteData) { // Made async
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
        // Grant admin permission to the creator
        if (userId) {
            try {
                await permissionService.grantPermission(userId, userId, 'note', newNoteId, 'admin');
                console.log(`Granted admin permission to creator ${userId} for note ${newNoteId}`);
            } catch (permErr) {
                // Log the error but don't let permission grant failure roll back note creation.
                // Depending on policy, this might need to be stricter.
                console.error(`Failed to grant admin permission to creator ${userId} for note ${newNoteId}:`, permErr.message);
            }
        }

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
    // If transaction was initiated and error occurs, it should be rolled back by db.transaction()
    return null; // Ensure null is returned on error
  }
}

async function getNoteById(id, requestingUserId = null) { // Made async
  const db = getDb();
  // Fetch note without user_id filter first
  const note = db.prepare("SELECT id, type, title, content, folder_id, workspace_id, user_id, is_pinned, is_archived, created_at, updated_at FROM notes WHERE id = ?").get(id);

  if (!note) {
    return null;
  }

  if (requestingUserId !== null) {
    const isOwner = note.user_id === requestingUserId;
    // If user_id is null, it's considered a public/system note, readable by any authenticated user.
    // If it's a private note (user_id is not null), then either be owner or have explicit permission.
    let hasPermission = note.user_id === null;
    if (!isOwner && note.user_id !== null) { // only check explicit if not owner and note is not public
        hasPermission = await permissionService.checkPermission(requestingUserId, 'note', id, 'read');
    }

    if (!isOwner && !hasPermission) {
      console.warn(`Access denied for user ${requestingUserId} on note ${id}. Not owner and no read permission.`);
      return null;
    }
  }
  // If requestingUserId is null (e.g. system access), or if user is owner or has permission, return note.
  return note;
}

async function updateNote(noteId, updateData, requestingUserId) {
  const db = getDb();

  const noteForPermissionCheck = db.prepare("SELECT user_id FROM notes WHERE id = ?").get(noteId);

  if (!noteForPermissionCheck) {
    console.error(`Error updating note ${noteId}: Note not found.`);
    return { success: false, error: "Note not found." };
  }

  const isOwner = noteForPermissionCheck.user_id === requestingUserId;
  // Allow update if user_id is null (public note) or if user is owner or has explicit write permission
  let hasWritePermission = noteForPermissionCheck.user_id === null;
  if (!isOwner && noteForPermissionCheck.user_id !== null) { // only check explicit if not owner and note is not public
    hasWritePermission = await permissionService.checkPermission(requestingUserId, 'note', noteId, 'write');
  }

  if (!isOwner && !hasWritePermission) {
    console.error(`Authorization failed: User ${requestingUserId} cannot update note ${noteId}. Not owner and no write permission.`);
    return { success: false, error: "Permission denied." };
  }

  // Get current state for history, unfiltered by user
  const oldNote = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId);
  if (!oldNote) { // Should not happen if permission check passed, but as a safeguard
    console.error(`Error updating note ${noteId}: Note disappeared after permission check.`);
    return { success: false, error: "Note not found after permission check." };
  }

  // user_id is set at creation and not typically part of updatableNoteFields by user.
  const oldValuesForHistory = { title: oldNote.title, content: oldNote.content, type: oldNote.type };
  const newValuesForHistory = { ...oldValuesForHistory };
  const changedFieldsArray = [];

  // user_id is generally not in updatableNoteFields by typical user actions, but rather set at creation or by specific ownership transfer logic.
  // If user_id can be part of updateData, it needs to be added to updatableNoteFields.
  // For now, assuming user_id is NOT changed via general updateNote.
  const updatableNoteFields = ["title", "content", "type", "folder_id", "workspace_id", "is_pinned", "is_archived"]; // user_id is not updatable here
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

async function deleteNote(noteId, requestingUserId) { // Made async
  const db = getDb();

  const noteForPermissionCheck = db.prepare("SELECT user_id FROM notes WHERE id = ?").get(noteId);

  if (!noteForPermissionCheck) {
    return { success: false, error: `Note ${noteId} not found for deletion.` };
  }

  const isOwner = noteForPermissionCheck.user_id === requestingUserId;
  // Allow delete if user_id is null (public note) or if user is owner or has explicit admin permission
  let hasAdminPermission = noteForPermissionCheck.user_id === null;
  if (!isOwner && noteForPermissionCheck.user_id !== null) { // only check explicit if not owner and note is not public
    hasAdminPermission = await permissionService.checkPermission(requestingUserId, 'note', noteId, 'admin');
  }

  if (!isOwner && !hasAdminPermission) {
    console.error(`Authorization failed: User ${requestingUserId} cannot delete note ${noteId}. Not owner and no admin permission.`);
    return { success: false, error: "Permission denied." };
  }

  // Transaction for deletion and potential cleanup
  const transaction = db.transaction(() => {
    const stmt = db.prepare("DELETE FROM notes WHERE id = ?");
    const info = stmt.run(noteId);

    if (info.changes > 0) {
      console.log(`Deleted note ${noteId} by user ${requestingUserId}. Rows affected: ${info.changes}`);

      // Cleanup related links (existing logic)
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

      // Revoke all permissions for the deleted note
      // This is an async function, but db.transaction expects synchronous operations.
      // This will be handled after the transaction block.
      // For now, mark that permissions need to be revoked.
      // permissionService.revokeAllPermissionsForObject('note', noteId); // This will be awaited outside

      return { success: true, changes: info.changes, noteIdDeleted: noteId }; // Pass noteId for permission cleanup
    }
    return { success: false, error: "Note not found during delete operation or delete failed." };
  });

  try {
    const result = transaction(); // Run the synchronous part of the transaction

    if (result.success && result.noteIdDeleted) {
      // Perform async permission revocation after the transaction has committed
      try {
        await permissionService.revokeAllPermissionsForObject('note', result.noteIdDeleted);
        console.log(`Successfully revoked all permissions for note ${result.noteIdDeleted}.`);
      } catch (permError) {
        console.error(`Failed to revoke permissions for note ${result.noteIdDeleted}:`, permError.message);
        // This is a best-effort cleanup. The note is already deleted.
        // Depending on policy, this could be logged for later reconciliation.
      }
    }
    return { success: result.success, changes: result.changes, error: result.error }; // Return original result status
  } catch (err) {
    console.error(`Error deleting note ${noteId} (user ${requestingUserId}):`, err.message, err.stack);
    return { success: false, error: err.message || "Failed to delete note." };
  }
}

// listNotesByFolder is not modified in this subtask for granular permission checks.
// It retains its existing behavior of filtering by owner or public (user_id IS NULL).
// A full permission integration for list operations would involve checking each note,
// which could be complex and performance-intensive, requiring a different strategy.
function listNotesByFolder(folderId, requestingUserId = null) {
    const db = getDb();
    let query = "SELECT id, type, title, user_id, is_pinned, updated_at FROM notes WHERE folder_id = ? AND is_archived = 0";
    const params = [folderId];

    // This existing filter helps, but doesn't cover explicit shares for notes owned by others.
    // For a complete permission-aware list, this function would need significant rework.
    if (requestingUserId !== null) {
        query += " AND (user_id = ? OR user_id IS NULL)"; // Shows own notes or public notes
        params.push(requestingUserId);
    }
    query += " ORDER BY is_pinned DESC, updated_at DESC";

    try {
        const stmt = db.prepare(query);
        // Further filtering based on permissionService.checkPermission for each note could be done here if required,
        // but that would be inefficient for large lists. This is a common challenge with list operations + ACLs.
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
