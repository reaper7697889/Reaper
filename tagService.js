// src/backend/services/tagService.js

const { getDb } = require("../db");

/**
 * Finds a tag by name, or creates it if it doesn't exist.
 * @param {string} tagName - The name of the tag.
 * @returns {object | null} - The tag object { id, name } or null on failure.
 */
function findOrCreateTag(tagName) {
  const db = getDb();
  const originalTagName = tagName; // Keep original for potential insertion
  const trimmedTagName = tagName.trim();
  if (!trimmedTagName) return null;

  try {
    // Check if tag exists (case-insensitive lookup)
    // The table schema now has COLLATE NOCASE on the UNIQUE constraint for name,
    // so inserts will fail correctly. This explicit COLLATE NOCASE ensures find is also case-insensitive.
    let tag = db.prepare("SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE").get(trimmedTagName);

    if (!tag) {
      // Create tag if it doesn't exist, storing the original (trimmed) casing
      const stmt = db.prepare("INSERT INTO tags (name) VALUES (?)");
      // Use originalTagName.trim() to preserve casing as much as possible but remove edge whitespace
      const info = stmt.run(trimmedTagName);
      tag = { id: info.lastInsertRowid, name: trimmedTagName }; // Return the name as it was stored
      console.log(`Created tag '${trimmedTagName}' with ID: ${tag.id}`);
    }
    return tag;
  } catch (err) {
    // The UNIQUE COLLATE NOCASE constraint on tags.name handles case-insensitive uniqueness.
    // If this error occurs, it means a tag with a different casing but same effective name exists.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        console.warn(`Tag '${trimmedTagName}' (or a case variant) already exists. Fetching existing.`);
        // Fetch the existing tag, which might have a different casing than trimmedTagName
        return db.prepare("SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE").get(trimmedTagName);
    }
    console.error(`Error finding or creating tag '${trimmedTagName}':`, err.message);
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
  renameTag,
  deleteTag,
};

// --- New Tag Management Functions ---

/**
 * Renames an existing tag.
 * @param {number} tagId - The ID of the tag to rename.
 * @param {string} newTagName - The new name for the tag.
 * @returns {object} - { success: boolean, error?: string }
 */
function renameTag(tagId, newTagName) {
  const db = getDb();
  const trimmedNewName = newTagName.trim();

  if (!trimmedNewName) {
    return { success: false, error: "Tag name cannot be empty." };
  }

  try {
    // Check if another tag already exists with the new name (case-insensitive)
    const existingTagStmt = db.prepare(
      "SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id != ?"
    );
    const existingTag = existingTagStmt.get(trimmedNewName, tagId);

    if (existingTag) {
      return { success: false, error: `Tag name "${trimmedNewName}" is already in use by another tag.` };
    }

    // Proceed with the update
    const updateStmt = db.prepare("UPDATE tags SET name = ? WHERE id = ?");
    const info = updateStmt.run(trimmedNewName, tagId);

    if (info.changes > 0) {
      console.log(`Renamed tag ID ${tagId} to '${trimmedNewName}'`);
      return { success: true };
    } else {
      return { success: false, error: "Tag not found or name unchanged." };
    }
  } catch (err) {
    // The UNIQUE COLLATE NOCASE constraint should ideally prevent duplicates during rename.
    // This explicit check above is a safeguard.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return { success: false, error: `Tag name "${trimmedNewName}" is already in use.` };
    }
    console.error(`Error renaming tag ID ${tagId} to '${trimmedNewName}':`, err.message);
    return { success: false, error: "An unexpected error occurred while renaming the tag." };
  }
}

/**
 * Deletes a tag from the system.
 * This includes removing its associations from note_tags.
 * @param {number} tagId - The ID of the tag to delete.
 * @returns {object} - { success: boolean, error?: string }
 */
function deleteTag(tagId) {
  const db = getDb();

  const deleteAssociations = db.prepare("DELETE FROM note_tags WHERE tag_id = ?");
  const deleteTheTag = db.prepare("DELETE FROM tags WHERE id = ?");

  // Use a transaction to ensure both operations succeed or fail together
  const transaction = db.transaction(() => {
    const associationInfo = deleteAssociations.run(tagId);
    console.log(`Removed ${associationInfo.changes} associations for tag ID ${tagId}`);

    const tagInfo = deleteTheTag.run(tagId);
    if (tagInfo.changes === 0) {
      // This means the tag didn't exist in the first place, which might not be an error
      // depending on desired behavior. For now, consider it not an error if associations were cleaned.
      // Or, throw an error to indicate the tag was not found.
      // For simplicity, we'll say if no tag was deleted, it's a "soft" failure or no-op.
      // However, if the goal is strict "tag must exist to be deleted", this could be an error.
      console.log(`Tag ID ${tagId} not found for deletion from 'tags' table.`);
      // To ensure the transaction rolls back if the tag itself isn't found for deletion:
      if (associationInfo.changes >=0 && tagInfo.changes === 0) {
          // If you want to ensure the tag was actually deleted from the tags table to call it a success
          // throw new Error("Tag not found in tags table.");
          // For now, we will consider it success if no errors occurred, even if tag was already gone.
      }
    } else {
      console.log(`Deleted tag ID ${tagId} from 'tags' table.`);
    }
    return tagInfo.changes; // Return number of changes from the tag deletion itself
  });

  try {
    const changes = transaction();
    // If changes from deleting the tag itself is > 0, it's a clear success.
    // If 0, it means the tag was not in the 'tags' table (maybe already deleted).
    // We'll count it as success if no exceptions were thrown during the transaction.
    return { success: true };
  } catch (err) {
    console.error(`Error deleting tag ID ${tagId}:`, err.message);
    return { success: false, error: "An unexpected error occurred while deleting the tag." };
  }
}
