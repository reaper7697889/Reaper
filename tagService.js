// src/backend/services/tagService.js

const { getDb } = require("../db");

/**
 * Finds a tag by name, or creates it if it doesn't exist.
 * @param {string} tagName - The name of the tag.
 * @returns {object | null} - The tag object { id, name } or null on failure.
 */
function findOrCreateTag(tagName) {
  const db = getDb();
  tagName = tagName.trim().toLowerCase(); // Normalize tag name
  if (!tagName) return null;

  try {
    // Check if tag exists
    let tag = db.prepare("SELECT id, name FROM tags WHERE name = ?").get(tagName);

    if (!tag) {
      // Create tag if it doesn't exist
      const stmt = db.prepare("INSERT INTO tags (name) VALUES (?)");
      const info = stmt.run(tagName);
      tag = { id: info.lastInsertRowid, name: tagName };
      console.log(`Created tag '${tagName}' with ID: ${tag.id}`);
    }
    return tag;
  } catch (err) {
    // Handle potential UNIQUE constraint violation if race condition occurs (unlikely in single-process Electron)
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        console.warn(`Tag '${tagName}' likely created concurrently. Fetching existing.`);
        return db.prepare("SELECT id, name FROM tags WHERE name = ?").get(tagName);
    }
    console.error(`Error finding or creating tag '${tagName}':`, err.message);
    return null;
  }
}

/**
 * Adds a tag to a note.
 * @param {number} noteId - The ID of the note.
 * @param {number} tagId - The ID of the tag.
 * @returns {boolean} - True if successful, false otherwise.
 */
function addTagToNote(noteId, tagId) {
  const db = getDb();
  const stmt = db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)");
  try {
    const info = stmt.run(noteId, tagId);
    return info.changes > 0; // Returns 1 if inserted, 0 if ignored (already exists)
  } catch (err) {
    console.error(`Error adding tag ${tagId} to note ${noteId}:`, err.message);
    return false;
  }
}

/**
 * Removes a tag from a note.
 * @param {number} noteId - The ID of the note.
 * @param {number} tagId - The ID of the tag.
 * @returns {boolean} - True if successful, false otherwise.
 */
function removeTagFromNote(noteId, tagId) {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?");
  try {
    const info = stmt.run(noteId, tagId);
    return info.changes > 0;
  } catch (err) {
    console.error(`Error removing tag ${tagId} from note ${noteId}:`, err.message);
    return false;
  }
}

/**
 * Gets all tags associated with a specific note.
 * @param {number} noteId - The ID of the note.
 * @returns {object[]} - Array of tag objects { id, name }.
 */
function getTagsForNote(noteId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT t.id, t.name
    FROM tags t
    JOIN note_tags nt ON t.id = nt.tag_id
    WHERE nt.note_id = ?
    ORDER BY t.name
  `);
  try {
    return stmt.all(noteId);
  } catch (err) {
    console.error(`Error getting tags for note ${noteId}:`, err.message);
    return [];
  }
}

/**
 * Gets all notes associated with a specific tag.
 * @param {number} tagId - The ID of the tag.
 * @returns {object[]} - Array of note objects (basic info).
 */
function getNotesForTag(tagId) {
    const db = getDb();
    const stmt = db.prepare(`
        SELECT n.id, n.type, n.title, n.updated_at
        FROM notes n
        JOIN note_tags nt ON n.id = nt.note_id
        WHERE nt.tag_id = ? AND n.is_archived = 0
        ORDER BY n.updated_at DESC
    `);
    try {
        return stmt.all(tagId);
    } catch (err) {
        console.error(`Error getting notes for tag ${tagId}:`, err.message);
        return [];
    }
}

/**
 * Gets all unique tags used in the system.
 * @returns {object[]} - Array of tag objects { id, name }.
 */
function getAllTags() {
    const db = getDb();
    const stmt = db.prepare("SELECT id, name FROM tags ORDER BY name");
    try {
        return stmt.all();
    } catch (err) {
        console.error("Error getting all tags:", err.message);
        return [];
    }
}

module.exports = {
  findOrCreateTag,
  addTagToNote,
  removeTagFromNote,
  getTagsForNote,
  getNotesForTag,
  getAllTags,
};

