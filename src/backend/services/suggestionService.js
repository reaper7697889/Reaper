// src/backend/services/suggestionService.js
const { getDb } = require('../../../db'); // Adjusted path assuming services are in src/backend/services
const tagService = require('../../../tagService'); // Corrected path to root
const noteService = require('./noteService'); // For checking initial note access

/**
 * Gets notes related to a given note based on shared tags.
 * @param {object} params - The parameters object.
 * @param {number} params.noteId - The ID of the current note.
 * @param {number} params.requestingUserId - The ID of the user requesting suggestions.
 * @param {number} [params.limit=10] - The maximum number of suggestions to return.
 * @returns {Promise<Array<object>>} - A promise that resolves to an array of suggested note objects.
 */
async function getRelatedNotesByTags({ noteId, requestingUserId, limit = 10 }) {
  const db = getDb();

  // 1. Check if the primary note exists and is accessible
  const currentNote = await noteService.getNoteById(noteId, requestingUserId, { bypassPermissionCheck: false });
  if (!currentNote) {
    console.warn(`[suggestionService] Current note ${noteId} not found or not accessible by user ${requestingUserId}.`);
    return [];
  }

  // 2. Fetch tags of the current note
  const currentNoteTags = await tagService.getTagsForNote(noteId);
  if (!currentNoteTags || currentNoteTags.length === 0) {
    // console.log(`[suggestionService] Note ${noteId} has no tags. No suggestions based on tags.`);
    return [];
  }
  const currentNoteTagIds = currentNoteTags.map(tag => tag.id);
  if (currentNoteTagIds.length === 0) return [];

  // 3. Construct and Execute SQL Query
  const placeholders = currentNoteTagIds.map(() => '?').join(',');
  const sql = `
    SELECT
        n.id,
        n.title,
        n.user_id,
        n.type,
        n.is_template,
        n.updated_at,
        COUNT(nt.tag_id) as shared_tag_count
    FROM notes n
    JOIN note_tags nt ON n.id = nt.note_id
    WHERE
        n.id != ?                            -- Not the current note
        AND n.deleted_at IS NULL             -- Only non-deleted notes
        AND nt.tag_id IN (${placeholders})     -- Shares at least one tag with the current note
        AND (n.user_id = ? OR n.user_id IS NULL) -- Accessible by the requesting user (owned or public)
        AND n.is_template = 0                -- Exclude templates from suggestions
    GROUP BY n.id, n.title, n.user_id, n.type, n.is_template, n.updated_at
    ORDER BY shared_tag_count DESC, n.updated_at DESC
    LIMIT ?;
  `;

  const params = [noteId, ...currentNoteTagIds, requestingUserId, limit];

  try {
    // console.log('[suggestionService] SQL:', sql);
    // console.log('[suggestionService] Params:', params);
    const suggestedNotes = db.prepare(sql).all(...params);
    return suggestedNotes;
  } catch (error) {
    console.error(`[suggestionService] Error fetching related notes for note ${noteId} by tags:`, error);
    return [];
  }
}

module.exports = {
  getRelatedNotesByTags,
};
