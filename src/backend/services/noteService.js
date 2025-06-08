// src/backend/services/noteService.js

const { getDb } = require("../../../db"); // Corrected path
const { recordNoteHistory } = require('./historyService');
const linkService = require('../../../linkService.js'); // Corrected path
const permissionService = require('./permissionService'); // Added import
const attachmentService = require('../../../attachmentService'); // For voice notes
const authService = require('./authService'); // Added for RBAC

// --- Note CRUD Operations ---

async function createNote(noteData) { // Changed to async to use authService
  const db = getDb();
  // Ensure userId is destructured, defaulting to null if not provided
  const { type, title, content, folder_id = null, workspace_id = null, is_pinned = 0, userId = null, is_template = 0, reminder_at = null } = noteData;

  // RBAC Check: Viewers cannot create notes
  if (userId) { // Check only if userId is provided for the note
    const userCreating = await authService.getUserWithRole(userId);
    if (userCreating && userCreating.role === 'VIEWER') {
        console.error(`User ${userId} (Viewer) attempted to create a note. Denied.`);
        return null; // Consistent with existing error return type for createNote
    }
  }
  // If no userId is provided in noteData (e.g. for a public note if allowed), this check is skipped.
  // Policy for anonymous creation or default ownership would be handled by how userId is set/required.

  if (!type || !["simple", "markdown", "workspace_page", "voice"].includes(type)) { // Added 'voice'
    console.error("Invalid note type provided: " + type);
    return null;
  }

  let newNoteId;
  const transaction = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO notes (type, title, content, folder_id, workspace_id, user_id, is_pinned, is_template, reminder_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    // Pass userId to the SQL execution
    const info = stmt.run(type, title, content, folder_id, workspace_id, userId, is_pinned ? 1 : 0, is_template ? 1 : 0, reminder_at);
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
        const newValuesForHistory = { title, content, type, folder_id, workspace_id, is_pinned, userId, is_template, reminder_at };
        const oldValuesForHistory = { title: null, content: null, type: null, folder_id: null, workspace_id: null, is_pinned: null, userId: null, is_template: 0, reminder_at: null };
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

// Added options parameter with bypassPermissionCheck and includeDeleted
async function getNoteById(id, requestingUserId = null, options = { bypassPermissionCheck: false, includeDeleted: false }) {
  const db = getDb();
  let baseQuery = "SELECT id, type, title, content, folder_id, workspace_id, user_id, is_pinned, is_archived, is_template, reminder_at, created_at, updated_at, deleted_at, deleted_by_user_id FROM notes WHERE id = ?";
  const params = [id];

  if (!options.includeDeleted) {
    baseQuery += " AND deleted_at IS NULL";
  }

  try {
    const note = db.prepare(baseQuery).get(...params);
    if (!note) {
      return null; // Note not found
    }

    if (options.bypassPermissionCheck) {
      return note; // Used by internal services like permissionService itself
    }

    if (requestingUserId !== null) {
      // Check 1: Is the requesting user the owner?
      if (note.user_id === requestingUserId) {
        return note;
      }
      // Check 2: Is the note public (user_id is NULL)?
      if (note.user_id === null) {
        return note; // Public notes are accessible
      }
      // Check 3: Does the user have explicit 'READ' permission?
      const permissionCheck = await permissionService.checkUserNotePermission(id, requestingUserId, 'READ');
      if (permissionCheck && permissionCheck.V) {
        return note;
      }
    } else { // No requestingUserId provided
      // If note is public, allow access. Otherwise, deny.
      if (note.user_id === null) {
        return note;
      }
      // Non-public notes require a requestingUserId to check ownership or permissions
      console.warn(`getNoteById: Access denied for note ${id} as no requestingUserId was provided for a non-public note.`);
      return null;
    }

    // If none of the above conditions met, user does not have access.
    console.warn(`getNoteById: Access denied for user ${requestingUserId} to note ${id}.`);
    return null;

  } catch (err) {
    console.error(`Error getting note ${id} for user ${requestingUserId}:`, err.message, err.stack);
    return null;
  }
}

async function updateNote(noteId, updateData, requestingUserId) {
  const db = getDb();

  // Fetch the note with bypass to get current owner, regardless of requesting user's direct permissions yet.
  const noteToUpdate = await getNoteById(noteId, null, { bypassPermissionCheck: true });

  if (!noteToUpdate) {
    console.error(`Error updating note ${noteId}: Note not found.`);
    return { success: false, error: "Note not found." };
  }

  let hasPermission = false;
  if (noteToUpdate.user_id === null) { // Publicly editable note (if such a concept is allowed by app rules)
    // For now, let's assume public notes are not editable by just anyone unless specific rules are added.
    // This example will require ownership or explicit WRITE permission even for public notes.
    // If public notes were world-writable, this logic would change:
    // hasPermission = true; // Or check a specific "public_writable" flag.
    // For now, fall through to ownership/permission check.
  }

  if (noteToUpdate.user_id === requestingUserId) {
    hasPermission = true; // Owner has permission
  } else {
    // Not the owner, check for 'WRITE' permission
    const permissionCheck = await permissionService.checkUserNotePermission(noteId, requestingUserId, 'WRITE');
    if (permissionCheck && permissionCheck.V) {
      hasPermission = true;
    }
  }

  if (!hasPermission) {
    console.error(`Authorization failed: User ${requestingUserId} cannot update note ${noteId}.`);
    return { success: false, error: "Authorization failed: Insufficient permissions to update this note." };
  }

  // Use the already fetched noteToUpdate as oldNote to avoid second getNoteById call.
  const oldNote = noteToUpdate;

  // user_id is set at creation and checked for ownership. Not typically part of updatableNoteFields by user.
  const oldValuesForHistory = { title: oldNote.title, content: oldNote.content, type: oldNote.type, is_template: oldNote.is_template, reminder_at: oldNote.reminder_at };
  const newValuesForHistory = { ...oldValuesForHistory };
  const changedFieldsArray = [];

  // user_id is generally not in updatableNoteFields by typical user actions, but rather set at creation or by specific ownership transfer logic.
  // If user_id can be part of updateData, it needs to be added to updatableNoteFields.
  // For now, assuming user_id is NOT changed via general updateNote.
  const updatableNoteFields = ["title", "content", "type", "folder_id", "workspace_id", "is_pinned", "is_archived", "is_template", "reminder_at"];
  const versionedFields = ["title", "content", "type", "is_template", "reminder_at"];
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

async function deleteNote(noteId, requestingUserId) { // Changed to async
  const db = getDb();
  const transaction = db.transaction(async () => { // transaction callback can be async if operations inside are
    // Fetch note including deleted, bypass regular permission to check raw ownership/status
    const noteToSoftDelete = await getNoteById(noteId, requestingUserId, { bypassPermissionCheck: true, includeDeleted: true });

    if (!noteToSoftDelete) {
      throw new Error(`Note ${noteId} not found.`);
    }

    let canDelete = false;
    const isOwner = (noteToSoftDelete.user_id === requestingUserId);

    if (isOwner) {
      canDelete = true;
    } else if (noteToSoftDelete.user_id === null) { // Public note
      const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
      if (isAdmin) {
        canDelete = true;
      } else {
        throw new Error("Authorization failed: Only ADMIN can delete public notes.");
      }
    } else { // Note has an owner, and it's not the requestingUser
      const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
      if (isAdmin) {
        canDelete = true; // Admin can delete other users' notes
      }
    }

    if (!canDelete) {
      throw new Error(`Authorization failed: User ${requestingUserId} cannot delete note ${noteId}.`);
    }

    // If already soft-deleted by this user, or by anyone if we don't care about who deleted it.
    // For now, allow re-soft-delete, it just updates timestamps and deleted_by_user_id.
    // if (noteToSoftDelete.deleted_at !== null) {
    //   return { success: true, message: "Note already deleted.", changes: 0 };
    // }

    const stmt = db.prepare(
      "UPDATE notes SET deleted_at = CURRENT_TIMESTAMP, deleted_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );
    const info = stmt.run(requestingUserId, noteId);

    if (info.changes > 0) {
      console.log(`Soft deleted note ${noteId} by user ${requestingUserId}.`);
      // IMPORTANT: For soft delete, we DO NOT clean up database_row_links targeting this note.
      return { success: true, changes: info.changes };
    }
    return { success: false, error: "Note not found at soft delete stage or no changes made." };
  });

  try {
    return await transaction(); // await if transaction callback is async
  } catch (err) {
    console.error(`Error deleting note ${noteId} (user ${requestingUserId}):`, err.message, err.stack);
    // Ensure rollback is attempted if transaction function throws
    // (though db.transaction() handles this if the error propagates out of its callback)
    // try { db.prepare("ROLLBACK").run(); } catch (e) { /* ignore rollback error if already rolled back */ }
    return { success: false, error: err.message || "Failed to delete note." };
  }
}

function listNotesByFolder(folderId, requestingUserId = null, options = { includeDeleted: false }) {
    const db = getDb();
    let query = "SELECT id, type, title, user_id, is_pinned, updated_at, deleted_at, reminder_at FROM notes WHERE folder_id = ? AND is_archived = 0";
    const params = [folderId];

    if (!options.includeDeleted) {
        query += " AND deleted_at IS NULL";
    }

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
  getTemplates, // Export new function
  createVoiceNote, // Export new function
};

async function getTemplates({ userId = null }) {
  const db = getDb();
  let sql = "SELECT id, type, title, user_id, updated_at, is_template, reminder_at FROM notes WHERE is_template = 1";
  const params = [];
  if (userId !== null) {
    sql += " AND (user_id = ? OR user_id IS NULL)"; // User's own templates + public templates
    params.push(userId);
  }
  sql += " ORDER BY title ASC";
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    console.error(`Error getting templates for user ${userId}:`, err.message);
    return [];
  }
}

async function createVoiceNote(fileDetails, { title, folder_id = null, workspace_id = null, is_pinned = 0 }, requestingUserId) {
  if (!requestingUserId) {
    return { success: false, error: "Requesting user ID is required." };
  }
  if (!fileDetails || !fileDetails.tempFilePath || !fileDetails.original_filename || !fileDetails.mime_type) {
    return { success: false, error: "File details (tempFilePath, original_filename, mime_type) are required." };
  }
  if (!fileDetails.mime_type.startsWith('audio/')) {
    return { success: false, error: "Invalid file type for voice note. Must be an audio type." };
  }

  try {
    // Step 1: Create Attachment (initially unlinked to a note)
    const attachmentResult = await attachmentService.createAttachment(
      {
        ...fileDetails, // tempFilePath, original_filename, mime_type
        note_id: null,
        block_id: null
      },
      requestingUserId
    );

    if (!attachmentResult || !attachmentResult.success) {
      return {
        success: false,
        error: "Failed to create attachment for voice note. " + (attachmentResult ? attachmentResult.error : 'Unknown attachment error')
      };
    }
    const attachmentId = attachmentResult.attachment.id;

    // Step 2: Create the 'voice' Note
    // Content of a voice note will store the ID of its primary attachment.
    const noteContent = JSON.stringify({ attachmentId: attachmentId });
    const noteTitle = title || attachmentResult.attachment.original_filename || `Voice Note ${new Date().toISOString().substring(0,10)}`;

    // createNote is an async function, so it should be awaited.
    const newNoteId = await createNote({
      type: 'voice', // Assuming 'voice' is a valid type to be added to CHECK constraint in notes table
      title: noteTitle,
      content: noteContent,
      folder_id,
      workspace_id,
      is_pinned,
      userId: requestingUserId
    });

    if (!newNoteId) {
      console.error(`Failed to create voice note record for attachment ID: ${attachmentId}. Orphaned attachment.`);
      // Attempting to delete the orphaned attachment is complex here.
      // Consider a cleanup utility or ensure createNote is more robust.
      return { success: false, error: "Failed to create voice note record after creating attachment." };
    }

    // Step 3: Link Attachment to New Note by updating the attachment's note_id
    const linkResult = await attachmentService.updateAttachmentParent(attachmentId, newNoteId, 'note', requestingUserId);
    if (!linkResult || !linkResult.success) {
      // This is a partial failure. The note and attachment exist but are not linked via attachments.note_id.
      // The note's content still holds the attachmentId, so it's findable.
      console.warn(`Failed to link attachment ${attachmentId} to new voice note ${newNoteId} via attachmentService.updateAttachmentParent. Note content has link.`);
      // Depending on strictness, this could be an error or a warning. For now, proceed but log.
    }

    // Step 4: Return Success
    // Fetch the newly created note to return its full details, including the user_id set by createNote.
    const newVoiceNote = await getNoteById(newNoteId, requestingUserId);
    if (!newVoiceNote) {
        // This would be unusual if createNote succeeded.
        console.error(`Failed to fetch newly created voice note ${newNoteId}.`);
        return { success: false, error: "Voice note created but could not be retrieved."}
    }

    return { success: true, note: newVoiceNote, attachment: attachmentResult.attachment };

  } catch (error) {
    console.error("Error in createVoiceNote:", error);
    return { success: false, error: error.message || "An unexpected error occurred while creating the voice note." };
  }
}
