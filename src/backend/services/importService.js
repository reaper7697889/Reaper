// src/backend/services/importService.js
const { getDb } = require("../db"); // May not be needed if all data comes from other services

const noteService = require('./noteService');
const linkService = require('./linkService');
const tagService = require('./tagService');
const databaseDefService = require('./databaseDefService');
const databaseRowService = require('./databaseRowService');

// --- Helper Functions ---

/**
 * Basic CSV row parser. Handles simple quoting.
 * @param {string} rowString
 * @returns {Array<string>}
 */
function _parseCsvRow(rowString) {
    const result = [];
    let currentVal = '';
    let inQuotes = false;
    for (let i = 0; i < rowString.length; i++) {
        const char = rowString[i];
        if (char === '"') {
            if (inQuotes && i + 1 < rowString.length && rowString[i+1] === '"') {
                currentVal += '"'; // Escaped double quote
                i++; // Skip next quote
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(currentVal);
            currentVal = '';
        } else {
            currentVal += char;
        }
    }
    result.push(currentVal); // Add last value
    return result.map(val => val.trim()); // Trim whitespace from unquoted values, or from fully quoted value
}


// --- Public Import Functions ---

/**
 * Imports a note from a Markdown string.
 * @param {string} markdownContent
 * @param {string} titleHint - Fallback title if not found in H1.
 * @param {number|null} targetFolderId - Optional folder ID to import into.
 * @returns {Promise<object>} - { success, note?: object, error?: string }
 */
async function importMarkdownNoteFromString(markdownContent, titleHint, targetFolderId = null) {
  try {
    if (typeof markdownContent !== 'string') {
      return { success: false, error: "Markdown content must be a string." };
    }

    let title = titleHint || "Imported Note";
    const h1Match = markdownContent.match(/^#\s+(.*)/m);
    if (h1Match && h1Match[1]) {
      title = h1Match[1].trim();
    }

    const createResult = await noteService.createNote({
      type: 'markdown',
      title: title,
      content: markdownContent,
      folder_id: targetFolderId,
    });

    // createNote in noteService now returns newNoteId directly, or null.
    // It doesn't return an object like { success, note }.
    // We need to adapt to how noteService.createNote works.
    // Let's assume it returns the newNoteId or throws/returns null on error.
    // For this example, I'll assume it returns the ID or null.
    // A more robust createNote would return a structured object or throw.

    if (createResult) { // Assuming createResult is the newNoteId
      const newNoteId = createResult;
      await linkService.updateLinksFromContent(newNoteId, markdownContent);
      const newNote = await noteService.getNoteById(newNoteId); // Fetch the full note
      return { success: true, note: newNote };
    } else {
      return { success: false, error: "Failed to create note in database." };
    }
  } catch (error) {
    console.error("Error importing Markdown note:", error);
    return { success: false, error: error.message || "An unexpected error occurred during Markdown import." };
  }
}

/**
 * Imports notes from a JSON string.
 * @param {string} jsonString
 * @param {number|null} defaultFolderId - Optional default folder ID if not in note object.
 * @returns {Promise<object>} - { overallSuccess, results: Array<{title, success, error?}> }
 */
async function importJsonNotesFromString(jsonString, defaultFolderId = null) {
  let notesToImport;
  try {
    notesToImport = JSON.parse(jsonString);
  } catch (e) {
    return { overallSuccess: false, error: "Invalid JSON format.", results: [] };
  }

  const notesArray = Array.isArray(notesToImport) ? notesToImport : [notesToImport];
  const results = [];
  let allSucceeded = true;

  for (const noteObject of notesArray) {
    try {
      if (!noteObject.type || !noteObject.title || noteObject.content === undefined) {
        results.push({ title: noteObject.title || "Unknown Title", success: false, error: "Missing required fields (type, title, content)." });
        allSucceeded = false;
        continue;
      }

      const folder_id = noteObject.folder_id !== undefined ? noteObject.folder_id : defaultFolderId;

      const createdNoteId = await noteService.createNote({
        type: noteObject.type,
        title: noteObject.title,
        content: noteObject.content,
        folder_id: folder_id,
        // other fields like is_pinned, workspace_id could be added if present in noteObject
      });

      if (createdNoteId) {
        if (noteObject.tags && Array.isArray(noteObject.tags)) {
          for (const tagName of noteObject.tags) {
            if (typeof tagName === 'string') {
              const tag = await tagService.findOrCreateTag(tagName);
              if (tag && tag.id) {
                await tagService.addTagToNote(createdNoteId, tag.id);
              }
            }
          }
        }
        if (noteObject.type === 'markdown') {
          await linkService.updateLinksFromContent(createdNoteId, noteObject.content);
        }
        results.push({ title: noteObject.title, success: true, noteId: createdNoteId });
      } else {
        results.push({ title: noteObject.title, success: false, error: "Failed to create note in database." });
        allSucceeded = false;
      }
    } catch (loopError) {
      console.error("Error importing a note object from JSON:", loopError, noteObject);
      results.push({ title: noteObject.title || "Unknown Title", success: false, error: loopError.message || "Import failed." });
      allSucceeded = false;
    }
  }
  return { overallSuccess: allSucceeded, results };
}

/**
 * Imports CSV data into a specified database table.
 * @param {number} databaseId
 * @param {string} csvString
 * @param {object} columnMapping - Optional: { "Target Column Name": "CSV Header Name" or csv_column_index }
 * @param {object} options - Optional: { skipHeader: true }
 * @returns {Promise<object>} - { successCount, errorCount, errors: Array<{rowNumber, error}> }
 */
async function importCsvToTableFromString(databaseId, csvString, columnMapping = {}, options = { skipHeader: true }) {
  const results = { successCount: 0, errorCount: 0, errors: [] };
  try {
    const targetColumns = await databaseDefService.getColumnsForDatabase(databaseId);
    if (!targetColumns || targetColumns.length === 0) {
      results.errors.push({ rowNumber: 0, error: "Target database has no columns defined." });
      results.errorCount = 1;
      return results;
    }

    const targetColMapByName = targetColumns.reduce((map, col) => { map[col.name.toLowerCase()] = col; return map; }, {});
    const targetColMapById = targetColumns.reduce((map, col) => { map[col.id] = col; return map; }, {});

    const lines = csvString.split(/\r?\n/).filter(line => line.trim() !== ''); // Filter empty lines
    if (lines.length === 0) return results;

    let headerRow = [];
    let dataLines = lines;
    if (options.skipHeader) {
      if (lines.length > 0) headerRow = _parseCsvRow(lines[0]);
      dataLines = lines.slice(1);
    }

    for (let i = 0; i < dataLines.length; i++) {
      const rowNumber = options.skipHeader ? i + 2 : i + 1; // 1-based for errors
      const csvValues = _parseCsvRow(dataLines[i]);
      const rowDataForDb = {};
      let rowHasError = false;

      for (const targetColDef of targetColumns) {
        if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetColDef.type)) continue; // Skip computed columns

        let csvCellString;
        const mappingKey = columnMapping[targetColDef.name] || columnMapping[String(targetColDef.id)];

        if (mappingKey !== undefined) {
          if (typeof mappingKey === 'number' && mappingKey < csvValues.length) { // Index-based mapping
            csvCellString = csvValues[mappingKey];
          } else if (typeof mappingKey === 'string' && options.skipHeader) { // Name-based mapping
            const csvHeaderIndex = headerRow.findIndex(h => h.toLowerCase() === mappingKey.toLowerCase());
            if (csvHeaderIndex !== -1 && csvHeaderIndex < csvValues.length) {
              csvCellString = csvValues[csvHeaderIndex];
            }
          }
        } else if (options.skipHeader) { // Try direct name match if no mapping for this targetCol
            const csvHeaderIndex = headerRow.findIndex(h => h.toLowerCase() === targetColDef.name.toLowerCase());
            if (csvHeaderIndex !== -1 && csvHeaderIndex < csvValues.length) {
                 csvCellString = csvValues[csvHeaderIndex];
            }
        } else { // No header, try column_order (0-indexed) as index into csvValues
            // This assumes CSV columns are in the same order as targetColDef.column_order
            // which is fragile. columnMapping is preferred.
            const orderedIndex = targetColumns.findIndex(c => c.id === targetColDef.id); // This is just its index in the sorted targetColumns array
            if (orderedIndex !== -1 && orderedIndex < csvValues.length) {
                 csvCellString = csvValues[orderedIndex];
            }
        }

        if (csvCellString === undefined || csvCellString.trim() === "") {
          rowDataForDb[targetColDef.id] = null; // Treat empty CSV cells as null
          continue;
        }

        try {
          switch (targetColDef.type) {
            case 'TEXT': case 'SELECT': rowDataForDb[targetColDef.id] = String(csvCellString); break;
            case 'NUMBER':
              const num = parseFloat(csvCellString);
              if (isNaN(num)) throw new Error(`'${csvCellString}' is not a valid number for column '${targetColDef.name}'.`);
              rowDataForDb[targetColDef.id] = num; break;
            case 'BOOLEAN': rowDataForDb[targetColDef.id] = ['true', '1', 'yes', 't', 'y'].includes(csvCellString.toLowerCase()); break;
            case 'DATE': // Expects YYYY-MM-DD or will try to parse common formats
              const d = new Date(csvCellString);
              if (isNaN(d.getTime())) throw new Error(`'${csvCellString}' is not a valid date for column '${targetColDef.name}'.`);
              rowDataForDb[targetColDef.id] = d.toISOString().split('T')[0]; break; // Format to YYYY-MM-DD
            case 'MULTI_SELECT': rowDataForDb[targetColDef.id] = csvCellString.split(';').map(s => s.trim()).filter(s => s); break;
            case 'RELATION': rowDataForDb[targetColDef.id] = csvCellString.split(';').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)); break;
            default: break; // Should not happen due to earlier skip
          }
        } catch (typeError) {
          results.errors.push({ rowNumber, csvRow: dataLines[i], error: typeError.message });
          rowHasError = true;
          break;
        }
      }

      if (!rowHasError && Object.keys(rowDataForDb).length > 0) {
        try {
          const addResult = await databaseRowService.addRow({ databaseId, values: rowDataForDb });
          if (addResult.success) {
            results.successCount++;
          } else {
            results.errorCount++;
            results.errors.push({ rowNumber, csvRow: dataLines[i], error: addResult.error || "Failed to add row to database." });
          }
        } catch (addRowError) {
          results.errorCount++;
          results.errors.push({ rowNumber, csvRow: dataLines[i], error: addRowError.message || "Error during addRow call." });
        }
      } else if (!rowHasError && Object.keys(rowDataForDb).length === 0) {
          // This means a CSV row was processed but no data was mapped to any target columns.
          // Could be an empty CSV row, or mapping failure for all columns.
          results.errorCount++;
          results.errors.push({ rowNumber, csvRow: dataLines[i], error: "No data mapped from CSV row to target columns." });
      }
    }
  } catch (error) {
    console.error(`Error importing CSV to table ${databaseId}:`, error);
    // Add a general error if the whole process fails early
    if (results.successCount === 0 && results.errorCount === 0) {
        results.errors.push({ rowNumber: 0, error: error.message || "An unexpected error occurred during CSV import." });
        results.errorCount = lines.length > (options.skipHeader ? 1:0) ? lines.length - (options.skipHeader ? 1:0) : 1;
    }
  }
  return results;
}

module.exports = {
  importMarkdownNoteFromString,
  importJsonNotesFromString,
  importCsvToTableFromString,
};
