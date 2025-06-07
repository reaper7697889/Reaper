// src/backend/services/exportService.js
const fs = require('fs');
const path = require('path');
const { getDb } = require("../../../db"); // Corrected path
// Used for db.backup() and db.name

// New imports for PDF export
let puppeteer;
let marked;

// Import services - adjust paths as necessary based on actual file structure
const noteService = require('./noteService');
const tagService = require('../../../tagService.js'); // Corrected path
const linkService = require('../../../linkService.js'); // Corrected path
const taskService = require('./taskService'); // Assuming taskService exists and has getTasksForNote
const attachmentService = require('../../../attachmentService.js'); // Corrected path
const databaseDefService = require('./databaseDefService');
const databaseQueryService = require('./databaseQueryService');
const authService = require('./authService'); // Added authService import

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
  getTableJsonData,
  createDatabaseSnapshot,
  getNotePdfExportData, // Export the new function
};

async function getNotePdfExportData(noteId, requestingUserId) {
  try {
    // Dynamically import modules if they haven't been loaded yet
    if (!puppeteer) puppeteer = require('puppeteer');
    if (!marked) marked = require('marked');

    const note = await noteService.getNoteById(noteId, requestingUserId);
    if (!note) {
      return { success: false, error: "Note not found or not accessible." };
    }

    let htmlContent = "";
    const safeTitle = (note.title || `note_${noteId}`).replace(/[^a-z0-9]/gi, '_').substring(0, 50);

    if (note.type === 'markdown') {
      htmlContent = marked.parse(note.content || "");
    } else if (note.type === 'simple') { // Assuming 'simple' is HTML content
      htmlContent = note.content || "";
    } else {
      return { success: false, error: `PDF export not supported for note type: ${note.type}` };
    }

    const defaultCss = `
      body { font-family: Helvetica, Arial, sans-serif; line-height: 1.6; margin: 40px; color: #333; }
      h1, h2, h3, h4, h5, h6 { color: #111; margin-bottom: 0.5em; margin-top: 1em; }
      h1 { font-size: 2em; } h2 { font-size: 1.75em; } h3 { font-size: 1.5em; }
      p { margin-bottom: 1em; }
      ul, ol { margin-bottom: 1em; padding-left: 20px; }
      code { background-color: #f0f0f0; padding: 2px 4px; border-radius: 3px; font-family: monospace; }
      pre { background-color: #f0f0f0; padding: 10px; border-radius: 3px; overflow-x: auto; }
      pre code { background-color: transparent; padding: 0; }
      blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 15px; color: #555; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 1em; }
      th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
      th { background-color: #f9f9f9; }
      img { max-width: 100%; height: auto; }
    `;
    const fullHtml = `
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>${note.title || 'Note'}</title><style>${defaultCss}</style></head>
      <body>${htmlContent}</body></html>
    `;

    let browser;
    try {
      browser = await puppeteer.launch({
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', // Common for CI environments
          '--disable-gpu' // Can help in some environments
        ],
        headless: true // Ensure headless mode
      });
      const page = await browser.newPage();
      await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '2cm', right: '1.5cm', bottom: '2cm', left: '1.5cm' }
      });

      return {
        success: true,
        filename: `${safeTitle}.pdf`,
        data: pdfBuffer, // This will be a Buffer
        mimeType: 'application/pdf'
      };
    } catch (err) {
      console.error("Error generating PDF with Puppeteer:", err);
      return { success: false, error: err.message || "Failed to generate PDF." };
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  } catch (error) { // Catch errors from noteService or initial setup
    console.error(`Error in getNotePdfExportData for noteId ${noteId}:`, error);
    return { success: false, error: error.message || "Failed to export note to PDF." };
  }
}


async function getTableJsonData(databaseId, requestingUserId = null) {
  try {
    const dbDef = await databaseDefService.getDatabaseById(databaseId, requestingUserId);
    if (!dbDef) {
      return { success: false, error: `Database with ID ${databaseId} not found or not accessible.` };
    }

    const columns = await databaseDefService.getColumnsForDatabase(databaseId, requestingUserId);
    if (!columns) { // Should not happen if dbDef was found, but good check
        return { success: false, error: `Could not retrieve columns for database ID ${databaseId}.`};
    }
    // Sort columns by column_order, though getColumnsForDatabase should already do it.
    // It's good practice to ensure it here if the order is critical for the export format.
    columns.sort((a, b) => a.column_order - b.column_order);

    // Fetch all rows with fully computed values.
    // Pass requestingUserId to getRowsForDatabase.
    const rows = await databaseQueryService.getRowsForDatabase(databaseId, { filters: [], sorts: [] }, requestingUserId);
    if (!rows) { // if getRowsForDatabase can return null on error or no rows
        return { success: false, error: `Could not retrieve rows for database ID ${databaseId}.`};
    }

    const arrayOfRowObjects = rows.map(row => {
      const rowObject = {};
      columns.forEach(col => {
        // Use column name as key. If names are not unique (should be handled by DB constraints), this could be an issue.
        // Assuming column names are unique within a database.
        rowObject[col.name] = row.values[col.id];
      });
      return rowObject;
    });

    const safeDbName = (dbDef.name || `database_${databaseId}`).replace(/[^a-z0-9]/gi, '_').substring(0, 50);
    const filename = `${safeDbName}_export.json`;

    return {
      filename,
      data: JSON.stringify(arrayOfRowObjects, null, 2), // Pretty print JSON
    };

  } catch (error) {
    console.error(`Error getting table JSON data for databaseId ${databaseId} (user ${requestingUserId}):`, error);
    return { success: false, error: error.message || "Failed to export table to JSON." };
  }
}

/**
 * Creates a snapshot (backup) of the main application database.
 * @param {number} requestingUserId - The ID of the user making the request (for authorization).
 * @returns {Promise<object>} - { success: boolean, filename?: string, path?: string, size?: number, message?: string, error?: string }
 */
async function createDatabaseSnapshot(requestingUserId) {
  // Authorization
  const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
  if (!isAdmin) {
    return { success: false, error: "Unauthorized: Only ADMIN users can create database snapshots." };
  }

  try {
    const mainDbInstance = getDb();
    const mainDbPath = mainDbInstance.name; // better-sqlite3 .name property holds the file path

    // Determine backup directory: ../backups relative to the DB file's directory
    // If db is /app/database.sqlite, backupDir will be /app/backups
    // If db is /app/data/database.sqlite, backupDir will be /app/data/backups
    const dbDir = path.dirname(mainDbPath);
    const backupDir = path.join(dbDir, 'backups_project_root'); // To place it in project root's backups
    // Correcting the path to ensure 'backups' is at project root, assuming db.js is in project root
    // and mainDbPath is like '/app/database.sqlite'
    // So, path.dirname(mainDbPath) is '/app'. We want '/app/backups'.
    const projectRoot = path.dirname(mainDbPath); // if mainDbPath = /app/database.sqlite, projectRoot = /app
    const actualBackupDir = path.join(projectRoot, 'backups');


    if (!fs.existsSync(actualBackupDir)) {
      fs.mkdirSync(actualBackupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[.:T]/g, '-').slice(0, -5); // YYYY-MM-DD-HH-MM-SS
    const backupFilename = `database_snapshot_${timestamp}.sqlite`;
    const backupFilePath = path.join(actualBackupDir, backupFilename);

    // better-sqlite3's backup method is synchronous.
    // Wrapping in Promise.resolve() to keep async function signature if preferred, though not strictly necessary here.
    await Promise.resolve().then(() => mainDbInstance.backup(backupFilePath));

    const stats = fs.statSync(backupFilePath);
    const fileSizeInBytes = stats.size;

    return {
      success: true,
      filename: backupFilename,
      path: backupFilePath, // This is the server-side path
      size: fileSizeInBytes,
      message: "Database snapshot created successfully."
    };

  } catch (err) {
    console.error("Error creating database snapshot:", err);
    return { success: false, error: err.message || "Failed to create database snapshot." };
  }
}
