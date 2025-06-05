// src/backend/services/exportService.js
const { getDb } = require("../db"); // May not be needed if all data comes from other services

// Import services - adjust paths as necessary based on actual file structure
const noteService = require('./noteService');
const tagService = require('./tagService');
const linkService = require('./linkService');
const taskService = require('./taskService'); // Assuming taskService exists and has getTasksForNote
const attachmentService = require('./attachmentService'); // Assuming attachmentService exists
const databaseDefService = require('./databaseDefService');
const databaseQueryService = require('./databaseQueryService');

// --- Helper Functions ---

/**
 * Escapes a value for CSV output.
 * - If null/undefined, returns empty string.
 * - If contains comma, double quote, or newline, encloses in double quotes.
 * - Replaces internal double quotes with two double quotes.
 * @param {any} value
 * @returns {string}
 */
function _csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const strValue = String(value);
  if (/[",\n]/.test(strValue)) {
    return `"${strValue.replace(/"/g, '""')}"`;
  }
  return strValue;
}

// --- Public Export Functions ---

/**
 * Prepares data for exporting a single note.
 * @param {number} noteId
 * @param {string} format - 'json' or 'markdown'
 * @returns {Promise<object|null>} - { filename, data } or null on error/not found.
 */
async function getNoteExportData(noteId, format = 'json') {
  try {
    const note = await noteService.getNoteById(noteId); // Assuming getNoteById is async or can be awaited
    if (!note) {
      return null;
    }

    const safeTitle = (note.title || `note_${noteId}`).replace(/[^a-z0-9]/gi, '_').substring(0, 50);

    if (format === 'json') {
      const tags = await tagService.getTagsForNote(noteId);
      const outgoingLinks = await linkService.getOutgoingLinks(noteId);
      const backlinks = await linkService.getBacklinks(noteId);
      // Assuming these services exist and return arrays of objects:
      const tasks = await taskService.getTasksForNote ? await taskService.getTasksForNote(noteId) : [];
      const attachments = await attachmentService.getAttachmentsForNote ? await attachmentService.getAttachmentsForNote(noteId) : [];

      const noteJsonObject = {
        ...note,
        tags: tags.map(t => t.name), // Assuming tags are objects with a 'name' property
        outgoingLinks,
        backlinks,
        tasks,
        attachments,
      };
      return {
        filename: `note_${noteId}_${safeTitle}.json`,
        data: JSON.stringify(noteJsonObject, null, 2), // Pretty print JSON
      };
    } else if (format === 'markdown') {
      if (note.type === 'markdown') {
        return {
          filename: `${safeTitle}.md`,
          data: note.content || "",
        };
      } else if (note.type === 'simple') { // Assuming 'simple' notes contain HTML
        return {
          filename: `${safeTitle}.txt`,
          data: `--- Note Type: Simple (HTML) ---\n\n${note.content || ""}`,
        };
      } else { // Other types like drawing, workspace_page, etc.
        return {
          filename: `${safeTitle}_${note.type}.txt`,
          data: `--- Note Type: ${note.type} ---\n\nContent for this note type is not directly exportable as Markdown.\nJSON representation:\n${JSON.stringify(note, null, 2)}`,
        };
      }
    } else {
      return { success: false, error: `Unsupported export format: ${format}` };
    }
  } catch (error) {
    console.error(`Error getting note export data for noteId ${noteId}, format ${format}:`, error);
    return { success: false, error: error.message || "Failed to export note data." };
  }
}

/**
 * Prepares data for exporting a collection of notes.
 * For now, supports all notes, or all notes of a specific type.
 * @param {object} args - { filter = { type: 'markdown', all: true }, format = 'json' }
 * @returns {Promise<object|Array<object>|null>}
 */
async function getNotesCollectionExportData({ filter = {}, format = 'json' } = {}) {
  try {
    // Assumption: noteService.getAllNotes() exists or can be implemented.
    // For this subtask, if it doesn't exist, this function will be limited.
    // Let's simulate a placeholder if it's not available from context.
    let allNotes = [];
    if (typeof noteService.getAllNotes === 'function') {
        allNotes = await noteService.getAllNotes();
    } else {
        console.warn("noteService.getAllNotes() is not implemented. Exporting empty collection or sample.");
        // As a fallback, try to get a few notes if possible, or just return empty.
        // This part would need actual implementation of getAllNotes or similar.
        // For now, let's assume it might return an empty array to avoid breaking.
    }

    let filteredNotes = allNotes;
    if (filter.noteType && filter.all) {
      filteredNotes = allNotes.filter(note => note.type === filter.noteType);
    } else if (filter.folderId) {
      // Placeholder: if noteService had getNotesByFolder, it would be used here.
      // filteredNotes = await noteService.getNotesByFolder(filter.folderId);
      console.warn(`Filtering by folderId not fully implemented in getNotesCollectionExportData without direct noteService.getNotesByFolder call here.`);
    }
    // Add more filters as needed

    if (format === 'json') {
      const allNoteJsonObjects = [];
      for (const note of filteredNotes) {
        const exportData = await getNoteExportData(note.id, 'json');
        if (exportData && exportData.data) {
          allNoteJsonObjects.push(JSON.parse(exportData.data)); // Parse back from string to object
        }
      }
      return {
        filename: `reaper_notes_export_${Date.now()}.json`,
        data: JSON.stringify(allNoteJsonObjects, null, 2),
      };
    } else if (format === 'markdown') {
      const markdownFiles = [];
      for (const note of filteredNotes) {
        const exportData = await getNoteExportData(note.id, 'markdown');
        if (exportData) {
          markdownFiles.push(exportData);
        }
      }
      return markdownFiles; // Array of { filename, data }
    } else {
      return { success: false, error: `Unsupported export format: ${format}` };
    }
  } catch (error) {
    console.error(`Error getting notes collection export data:`, error);
    return { success: false, error: error.message || "Failed to export notes collection." };
  }
}

/**
 * Prepares CSV data for a given database table.
 * @param {number} databaseId
 * @returns {Promise<object|null>} - { filename, data: csvString } or null on error.
 */
async function getTableCsvData(databaseId) {
  try {
    const dbDef = await databaseDefService.getDatabaseById(databaseId);
    if (!dbDef) {
      return { success: false, error: `Database with ID ${databaseId} not found.` };
    }

    const columns = await databaseDefService.getColumnsForDatabase(databaseId);
    if (!columns || columns.length === 0) {
      return { filename: `${(dbDef.name || 'table_'+databaseId).replace(/[^a-z0-9]/gi, '_')}.csv`, data: "" }; // Empty CSV for no columns
    }

    // Sort columns by column_order explicitly, though getColumnsForDatabase should already do it.
    columns.sort((a, b) => a.column_order - b.column_order);

    // Fetch all rows with fully computed values (formulas, rollups, lookups)
    // The empty filter {} and sort {} means default fetching (all rows, default order)
    const rows = await databaseQueryService.getRowsForDatabase(databaseId, { filters: [], sorts: [] });

    const headerRow = columns.map(col => _csvEscape(col.name)).join(',');

    const dataRows = rows.map(row => {
      return columns.map(col => {
        let value = row.values[col.id];
        // For CSV, array values (like from MULTI_SELECT or some LOOKUP/RELATION) might need special stringification.
        if (Array.isArray(value)) {
          value = value.join('; '); // Example: join array elements with semicolon
        }
        return _csvEscape(value);
      }).join(',');
    });

    const csvString = [headerRow, ...dataRows].join('\n');

    const safeDbName = (dbDef.name || `database_${databaseId}`).replace(/[^a-z0-9]/gi, '_').substring(0,50);

    return {
      filename: `${safeDbName}.csv`,
      data: csvString,
    };

  } catch (error) {
    console.error(`Error getting table CSV data for databaseId ${databaseId}:`, error);
    return { success: false, error: error.message || "Failed to export table to CSV." };
  }
}

module.exports = {
  getNoteExportData,
  getNotesCollectionExportData,
  getTableCsvData,
};
