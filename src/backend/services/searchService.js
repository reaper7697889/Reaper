// src/backend/services/searchService.js
const { getDb } = require("../db");

/**
 * Searches across notes and tasks using FTS5.
 * @param {string} searchText - The text to search for.
 * @param {object} options - Search options.
 * @param {number} [options.limit=20] - Max number of results to return.
 * @param {Array<string>} [options.itemTypes=['notes', 'tasks']] - Types of items to search ('notes', 'tasks').
 * @param {string|null} [options.noteTypeFilter=null] - Specific note type to filter by (e.g., 'markdown').
 * @returns {Promise<Array<object>>} - Combined, sorted, and limited search results.
 */
async function searchAll(searchText, options = {}) {
  const db = getDb();
  const allResults = [];

  const defaultOptions = {
    limit: 20,
    itemTypes: ['notes', 'tasks'],
    noteTypeFilter: null,
  };
  const effectiveOptions = { ...defaultOptions, ...options };

  if (!searchText || typeof searchText !== 'string' || searchText.trim().length < 2) {
    console.warn("Search text is empty or too short.");
    return []; // Or return { success: false, error: "Search text too short." }
  }

  const ftsQuery = searchText.trim(); // Use directly for MATCH; FTS5 handles syntax like "word*", "phrase", etc.

  try {
    // Search Notes
    if (effectiveOptions.itemTypes.includes('notes')) {
      let notesSql = `
        SELECT
            n.id, n.title, n.type AS note_type, n.created_at, n.updated_at,
            snippet(notes_fts, 0, '<b>', '</b>', '...', 10) as preview_title,
            snippet(notes_fts, 1, '<b>', '</b>', '...', 20) as preview_content,
            rank
        FROM notes n
        JOIN notes_fts ON n.id = notes_fts.note_id
        WHERE notes_fts MATCH ?
      `;
      const notesParams = [ftsQuery];

      if (effectiveOptions.noteTypeFilter) {
        notesSql += ` AND n.type = ?`;
        notesParams.push(effectiveOptions.noteTypeFilter);
      }
      // ORDER BY rank will be done on combined results.

      const noteRows = db.prepare(notesSql).all(...notesParams);
      noteRows.forEach(row => {
        let displayPreview = "";
        // Prioritize content snippet if it's meaningful (not just '...' and contains highlight)
        if (row.preview_content && row.preview_content !== '...' && row.preview_content.includes('<b>')) {
          displayPreview = row.preview_content;
        } else if (row.preview_title && row.preview_title !== '...' && row.preview_title.includes('<b>')) {
          displayPreview = row.preview_title;
        } else {
          displayPreview = row.title || ""; // Fallback to full title if snippets are not good
        }

        allResults.push({
          type: 'note',
          id: row.id,
          title: row.title,
          noteType: row.note_type,
          preview: displayPreview.substring(0, 250), // Truncate final preview
          rank: row.rank,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      });
    }

    // Search Tasks
    if (effectiveOptions.itemTypes.includes('tasks')) {
      const tasksSql = `
        SELECT
            t.id, t.description, t.is_completed, t.due_date, t.created_at, t.updated_at,
            snippet(tasks_fts, 0, '<b>', '</b>', '...', 20) as preview,
            rank
        FROM tasks t
        JOIN tasks_fts ON t.id = tasks_fts.task_id
        WHERE tasks_fts MATCH ?
      `;
      const tasksParams = [ftsQuery];
      // ORDER BY rank will be done on combined results.

      const taskRows = db.prepare(tasksSql).all(...tasksParams);
      taskRows.forEach(row => {
        let displayPreview = "";
        if (row.preview && row.preview !== '...' && row.preview.includes('<b>')) {
          displayPreview = row.preview;
        } else {
          displayPreview = row.description || ""; // Fallback to full description
        }

        allResults.push({
          type: 'task',
          id: row.id,
          description: row.description,
          isCompleted: !!row.is_completed,
          dueDate: row.due_date,
          preview: displayPreview.substring(0, 250), // Truncate final preview
          rank: row.rank,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      });
    }

    // Combine and Sort Results
    // FTS5 rank is usually higher for better matches (BM25), so sort ascending.
    // SQLite's default FTS5 rank calculation results in smaller (more negative) values for better matches.
    allResults.sort((a, b) => a.rank - b.rank);

    // Apply Limit
    return allResults.slice(0, effectiveOptions.limit);

  } catch (error) {
    console.error("Error during searchAll:", error);
    return { success: false, error: error.message || "An unexpected error occurred during search." }; // Return structured error
  }
}

module.exports = {
  searchAll,
};
