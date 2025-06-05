// src/backend/services/noteService.js

const { getDb } = require("../db");

// --- Note CRUD Operations ---

/**
 * Creates a new note in the database.
 * @param {object} noteData - Object containing note properties (type, title, content, folder_id, workspace_id, etc.)
 * @returns {number | null} - The ID of the newly created note, or null on failure.
 */
function createNote(noteData) {
  const db = getDb();
  const { type, title, content, folder_id = null, workspace_id = null, is_pinned = 0 } = noteData;

  // Basic validation
  if (!type || !["simple", "markdown", "workspace_page"].includes(type)) {
    console.error("Invalid note type provided.");
    return null;
  }

  const stmt = db.prepare(`
    INSERT INTO notes (type, title, content, folder_id, workspace_id, is_pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  try {
    const info = stmt.run(type, title, content, folder_id, workspace_id, is_pinned ? 1 : 0);
    console.log(`Created note with ID: ${info.lastInsertRowid}`);
    return info.lastInsertRowid;
  } catch (err) {
    console.error("Error creating note:", err.message);
    return null;
  }
}

/**
 * Retrieves a single note by its ID.
 * @param {number} id - The ID of the note to retrieve.
 * @returns {object | null} - The note object or null if not found.
 */
function getNoteById(id) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM notes WHERE id = ?");
  try {
    const note = stmt.get(id);
    return note || null;
  } catch (err) {
    console.error(`Error getting note ${id}:`, err.message);
    return null;
  }
}

/**
 * Updates an existing note.
 * @param {number} id - The ID of the note to update.
 * @param {object} updateData - Object containing fields to update (e.g., title, content, folder_id, is_pinned).
 * @returns {boolean} - True if update was successful, false otherwise.
 */
function updateNote(id, updateData) {
  const db = getDb();
  const fields = [];
  const values = [];

  // Dynamically build the SET part of the query
  for (const [key, value] of Object.entries(updateData)) {
    // Ensure only valid columns are updated (add more as needed)
    if (["title", "content", "folder_id", "workspace_id", "is_pinned", "is_archived"].includes(key)) {
      fields.push(`${key} = ?`);
      // Handle boolean conversion for SQLite (0 or 1)
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
  }

  if (fields.length === 0) {
    console.warn("No valid fields provided for update.");
    return false;
  }

  // Add updated_at manually since the trigger only works on actual UPDATE commands
  // fields.push("updated_at = CURRENT_TIMESTAMP"); // Trigger handles this

  const stmt = db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`);
  values.push(id);

  try {
    const info = stmt.run(...values);
    console.log(`Updated note ${id}. Rows affected: ${info.changes}`);
    return info.changes > 0;
  } catch (err) {
    console.error(`Error updating note ${id}:`, err.message);
    return false;
  }
}

/**
 * Deletes a note by its ID.
 * @param {number} id - The ID of the note to delete.
 * @returns {boolean} - True if deletion was successful, false otherwise.
 */
function deleteNote(id) {
  const db = getDb();
  // Note: Related data (tags, links, blocks, attachments, tasks) should be handled by CASCADE constraints
  const stmt = db.prepare("DELETE FROM notes WHERE id = ?");
  try {
    const info = stmt.run(id);
    console.log(`Deleted note ${id}. Rows affected: ${info.changes}`);
    return info.changes > 0;
  } catch (err) {
    console.error(`Error deleting note ${id}:`, err.message);
    return false;
  }
}

// --- Listing and Searching --- (Add more functions as needed)

/**
 * Lists notes within a specific folder (for Simple Notes).
 * @param {number} folderId
 * @returns {object[]} - Array of note objects.
 */
function listNotesByFolder(folderId) {
    const db = getDb();
    const stmt = db.prepare("SELECT id, type, title, is_pinned, updated_at FROM notes WHERE folder_id = ? AND is_archived = 0 ORDER BY is_pinned DESC, updated_at DESC");
    try {
        return stmt.all(folderId);
    } catch (err) {
        console.error(`Error listing notes for folder ${folderId}:`, err.message);
        return [];
    }
}

// TODO: Add functions for:
// - listNotesByWorkspace(workspaceId)
// - listAllNotes(typeFilter)
// - searchNotes(query)
// - getNoteWithDetails(id) // Function to fetch note with tags, attachments etc.

module.exports = {
  createNote,
  getNoteById,
  updateNote,
  deleteNote,
  listNotesByFolder,
  // ... other exported functions
};

