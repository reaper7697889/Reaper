// src/backend/services/noteService.js

const { getDb } = require("../db");
const { recordNoteHistory } = require('./historyService');
const linkService = require('./linkService');

// --- Note CRUD Operations ---

function createNote(noteData) {
  const db = getDb();
  const { type, title, content, folder_id = null, workspace_id = null, is_pinned = 0 } = noteData;

  if (!type || !["simple", "markdown", "workspace_page"].includes(type)) {
    console.error("Invalid note type provided.");
    return null;
  }

  let newNoteId;
  const transaction = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO notes (type, title, content, folder_id, workspace_id, is_pinned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const info = stmt.run(type, title, content, folder_id, workspace_id, is_pinned ? 1 : 0);
    newNoteId = info.lastInsertRowid;
    if (!newNoteId) {
      throw new Error("Failed to create note or retrieve newNoteId.");
    }
    // History will be recorded outside main transaction for now to keep createNote sync if possible
    // or if createNote is async, this should be inside transaction and awaited.
  });

  try {
    transaction(); // Execute transaction
    if (newNoteId) {
        console.log(`Created note with ID: ${newNoteId}`);
        // Fire-and-forget history for creation to keep createNote synchronous for now
        // A more robust system would make createNote async and include history in its transaction.
        const newValuesForHistory = { title, content, type };
        const oldValuesForHistory = { title: null, content: null, type: null };
        const changedFieldsArray = Object.keys(newValuesForHistory).filter(k => newValuesForHistory[k] !== null && newValuesForHistory[k] !== undefined);
        recordNoteHistory({
            noteId: newNoteId,
            oldValues: oldValuesForHistory,
            newValues: newValuesForHistory,
            changedFields: changedFieldsArray
        }).catch(err => console.error(`Async history recording failed for new note ${newNoteId}:`, err.message));
    }
    return newNoteId;
  } catch (err) {
    console.error("Error creating note:", err.message, err.stack);
    return null;
  }
}

function getNoteById(id) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM notes WHERE id = ?");
  try {
    return stmt.get(id) || null;
  } catch (err) {
    console.error(`Error getting note ${id}:`, err.message);
    return null;
  }
}

async function updateNote(noteId, updateData) {
  const db = getDb();

  const oldNote = getNoteById(noteId);
  if (!oldNote) {
    console.error(`Error updating note ${noteId}: Note not found.`);
    return false;
  }

  const oldValuesForHistory = { title: oldNote.title, content: oldNote.content, type: oldNote.type };
  const newValuesForHistory = { ...oldValuesForHistory };
  const changedFieldsArray = [];
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
      // This was the previous logic for updating links based on title change.
      // linkService.updateLinksFromContent(noteId, newValuesForHistory.content);
      // The above is too broad if only title changed. The one below is more specific.
      const updateLinksStmt = db.prepare("UPDATE links SET link_text = ? WHERE target_note_id = ? AND link_text = ?");
      updateLinksStmt.run(newValuesForHistory.title, noteId, oldValuesForHistory.title);
      console.log(`Updated link texts for note ${noteId} from '${oldValuesForHistory.title}' to '${newValuesForHistory.title}'.`);
    }

    db.prepare("COMMIT").run();
    return mainUpdateSuccess;
  } catch (err) {
    db.prepare("ROLLBACK").run();
    console.error(`Error in updateNote (transaction rolled back) for note ${noteId}:`, err.message, err.stack);
    return false;
  }
}

function deleteNote(noteId) {
  const db = getDb();
  const transaction = db.transaction(() => {
    // Delete the note itself
    const stmt = db.prepare("DELETE FROM notes WHERE id = ?");
    const info = stmt.run(noteId);

    if (info.changes > 0) {
      console.log(`Deleted note ${noteId}. Rows affected: ${info.changes}`);

      // Clean up links in database_row_links targeting this note
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
      return true; // Note deletion was successful
    }
    return false; // Note not found or not deleted
  });

  try {
    return transaction();
  } catch (err) {
    console.error(`Error deleting note ${noteId} or its related links:`, err.message, err.stack);
    // Attempt to rollback if any part of the transaction threw an error not caught by db.transaction itself
    // This is belt-and-suspenders as db.transaction should handle it.
    try { db.prepare("ROLLBACK").run(); } catch (e) { /* ignore rollback error */ }
    return false;
  }
}

function listNotesByFolder(folderId) {
    const db = getDb();
    const stmt = db.prepare("SELECT id, type, title, is_pinned, updated_at FROM notes WHERE folder_id = ? AND is_archived = 0 ORDER BY is_pinned DESC, updated_at DESC");
    try { return stmt.all(folderId); }
    catch (err) { console.error(`Error listing notes for folder ${folderId}:`, err.message); return []; }
}

module.exports = {
  createNote,
  getNoteById,
  updateNote,
  deleteNote,
  listNotesByFolder,
};
