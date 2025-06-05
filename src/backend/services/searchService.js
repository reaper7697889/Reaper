// src/backend/services/searchService.js
const { getDb } = require("../db");

/**
 * Searches across notes, tasks, and database row content using FTS5.
 * @param {string} searchText - The text to search for.
 * @param {object} options - Search options.
 * @param {number} [options.limit=20] - Max number of results to return.
 * @param {Array<string>} [options.itemTypes=['notes', 'tasks', 'database_rows']] - Types of items to search.
 * @param {string|null} [options.noteTypeFilter=null] - Specific note type to filter by (e.g., 'markdown').
 * @param {number|null} [options.searchInDatabaseId=null] - Specific database ID to confine database_row search.
 * @returns {Promise<Array<object>|object>} - Combined, sorted, and limited search results array, or error object.
 */
async function searchAll(searchText, options = {}) {
  const db = getDb();
  const allResults = [];

  const defaultOptions = {
    limit: 20,
    itemTypes: ['notes', 'tasks', 'database_rows'],
    noteTypeFilter: null,
    searchInDatabaseId: null,
  };
  const effectiveOptions = { ...defaultOptions, ...options };

  if (!searchText || typeof searchText !== 'string' || searchText.trim().length < 2) {
    console.warn("Search text is empty or too short.");
    return [];
  }

  const ftsQuery = searchText.trim();

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

      const noteRows = db.prepare(notesSql).all(...notesParams);
      noteRows.forEach(row => {
        let displayPreview = "";
        if (row.preview_content && row.preview_content.trim() !== '...' && row.preview_content.includes('<b>')) {
          displayPreview = row.preview_content;
        } else if (row.preview_title && row.preview_title.trim() !== '...' && row.preview_title.includes('<b>')) {
          displayPreview = row.preview_title;
        } else {
          displayPreview = row.title || "";
        }
        allResults.push({
          type: 'note',
          id: row.id,
          title: row.title,
          noteType: row.note_type,
          preview: displayPreview.substring(0, 250),
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
      const taskRows = db.prepare(tasksSql).all(...tasksParams);
      taskRows.forEach(row => {
        let displayPreview = "";
        if (row.preview && row.preview.trim() !== '...' && row.preview.includes('<b>')) {
          displayPreview = row.preview;
        } else {
          displayPreview = row.description || "";
        }
        allResults.push({
          type: 'task',
          id: row.id,
          description: row.description,
          isCompleted: !!row.is_completed,
          dueDate: row.due_date,
          preview: displayPreview.substring(0, 250),
          rank: row.rank,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      });
    }

    // Search Database Rows
    if (effectiveOptions.itemTypes.includes('database_rows')) {
      let dbRowsSql = `
          SELECT
              dcf.row_id,
              dcf.database_id,
              nd.name as database_name,
              dr.created_at,
              dr.updated_at,
              snippet(database_content_fts, 0, '<b>', '</b>', '...', 25) as preview,
              dcf.rank
          FROM database_content_fts dcf
          JOIN note_databases nd ON dcf.database_id = nd.id
          JOIN database_rows dr ON dcf.row_id = dr.id
          WHERE dcf.content MATCH ?
      `;
      const dbRowsParams = [ftsQuery];

      if (effectiveOptions.searchInDatabaseId !== null && effectiveOptions.searchInDatabaseId !== undefined) {
          dbRowsSql += ' AND dcf.database_id = ? ';
          dbRowsParams.push(effectiveOptions.searchInDatabaseId);
      }

      const dbRowHits = db.prepare(dbRowsSql).all(...dbRowsParams);
      dbRowHits.forEach(row => {
        let displayPreview = "";
        if (row.preview && row.preview.trim() !== '...' && row.preview.includes('<b>')) {
            displayPreview = row.preview;
        } else {
            displayPreview = `Match in table '${row.database_name}' (Row ID: ${row.row_id})`;
        }
        allResults.push({
          type: 'database_row',
          id: row.row_id,
          databaseId: row.database_id,
          databaseName: row.database_name,
          preview: displayPreview.substring(0, 250),
          rank: row.rank,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      });
    }

    allResults.sort((a, b) => a.rank - b.rank);
    return allResults.slice(0, effectiveOptions.limit);

  } catch (error) {
    console.error("Error during searchAll:", error);
    return { success: false, error: error.message || "An unexpected error occurred during search." };
  }
}

module.exports = {
  searchAll,
};
