// src/backend/services/importService.js
const { getDb } = require("../db"); // May not be needed if all data comes from other services

const noteService = require('./noteService');
const linkService = require('./linkService');
const tagService = require('./tagService');
const databaseDefService = require('./databaseDefService');
const databaseRowService = require('./databaseRowService');
const permissionService = require('./permissionService'); // Added for permission checks

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
 * @param {number|null} requestingUserId - The ID of the user performing the import.
 * @returns {Promise<object>} - { success, note?: object, error?: string }
 */
async function importMarkdownNoteFromString(markdownContent, titleHint, targetFolderId = null, requestingUserId = null) {
  try {
    if (!requestingUserId) {
        return { success: false, error: "User context is required to import this note." };
    }
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
      userId: requestingUserId // Pass requestingUserId as userId
    });

    if (createResult) {
      const newNoteId = createResult;
      await linkService.updateLinksFromContent(newNoteId, markdownContent);
      // Pass requestingUserId when fetching the note back
      const newNote = await noteService.getNoteById(newNoteId, requestingUserId);
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
 * @param {number|null} requestingUserId - The ID of the user performing the import.
 * @returns {Promise<object>} - { overallSuccess, results: Array<{title, success, error?}> }
 */
async function importJsonNotesFromString(jsonString, defaultFolderId = null, requestingUserId = null) {
  if (!requestingUserId) {
    return { overallSuccess: false, error: "User context is required to import notes.", results: [] };
  }
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
        userId: requestingUserId // Pass requestingUserId as userId
        // other fields like is_pinned, workspace_id could be added if present in noteObject
      });

      if (createdNoteId) {
        // Assuming tagService and linkService either don't need explicit user context
        // or will be updated separately. For now, calls remain as is.
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
 * @param {number|null} requestingUserId - The ID of the user performing the import.
 * @returns {Promise<object>} - { successCount, errorCount, errors: Array<{rowNumber, error}> }
 */
async function importCsvToTableFromString(databaseId, csvString, columnMapping = {}, options = { skipHeader: true }, requestingUserId = null) {
  const results = { successCount: 0, errorCount: 0, errors: [] };

  if (!requestingUserId) {
    results.errors.push({ rowNumber: 0, error: "User context is required to import to table." });
    results.errorCount = csvString.split(/\r?\n/).filter(line => line.trim() !== '').length - (options.skipHeader ? 1 : 0) || 1;
    return results;
  }

  try {
    const permCheck = await permissionService.checkUserDatabasePermission(databaseId, requestingUserId, 'WRITE');
    if (!permCheck.V) {
        results.errors.push({ rowNumber: 0, error: "Authorization failed: Insufficient permissions to import rows to this database." });
        results.errorCount = csvString.split(/\r?\n/).filter(line => line.trim() !== '').length - (options.skipHeader ? 1 : 0) || 1;
        return results;
    }

    const targetColumns = await databaseDefService.getColumnsForDatabase(databaseId, requestingUserId); // Pass requestingUserId
    if (!targetColumns || targetColumns.length === 0) {
      results.errors.push({ rowNumber: 0, error: "Target database has no columns defined or accessible." });
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
          const addResult = await databaseRowService.addRow({ databaseId, values: rowDataForDb, requestingUserId }); // Pass requestingUserId
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
  importJsonToTableFromString, // Export the new function
};

async function importJsonToTableFromString(databaseId, jsonString, requestingUserId = null) {
  const results = { successCount: 0, errorCount: 0, errors: [] };
  let jsonData;

  try {
    jsonData = JSON.parse(jsonString);
  } catch (e) {
    results.errors.push({ itemIndex: -1, error: "Invalid JSON string: " + e.message });
    results.errorCount = 1; // Or jsonData.length if it was an array-like string that failed parsing
    return results;
  }

  if (!Array.isArray(jsonData)) {
    results.errors.push({ itemIndex: -1, error: "JSON data must be an array of objects." });
    results.errorCount = 1;
    return results;
  }

  if (jsonData.length === 0) {
    return results; // Nothing to import
  }

  try {
    // Accessibility check
    const dbDef = await databaseDefService.getDatabaseById(databaseId, requestingUserId);
    if (!dbDef) {
      results.errors.push({ itemIndex: -1, error: `Database ID ${databaseId} not found or not accessible.` });
      results.errorCount = jsonData.length;
      return results;
    }

    const targetColumns = await databaseDefService.getColumnsForDatabase(databaseId, requestingUserId);
    if (!targetColumns || targetColumns.length === 0) {
      results.errors.push({ itemIndex: -1, error: "Target database has no columns defined." });
      results.errorCount = jsonData.length;
      return results;
    }

    const colNameLowerMap = targetColumns.reduce((map, col) => { map[col.name.toLowerCase()] = col; return map; }, {});
    const colIdStringMap = targetColumns.reduce((map, col) => { map[String(col.id)] = col; return map; }, {});

    for (let i = 0; i < jsonData.length; i++) {
      const jsonObject = jsonData[i];
      if (typeof jsonObject !== 'object' || jsonObject === null) {
        results.errorCount++;
        results.errors.push({ itemIndex: i, itemData: jsonObject, error: "Item is not a valid object." });
        continue;
      }

      const rowDataForDb = {};
      let itemHasError = false;

      for (const [key, value] of Object.entries(jsonObject)) {
        let targetColDef = colNameLowerMap[key.toLowerCase()] || colIdStringMap[String(key)];

        if (targetColDef) {
          if (['FORMULA', 'ROLLUP', 'LOOKUP'].includes(targetColDef.type)) continue; // Skip computed columns

          if (value === null || value === undefined || String(value).trim() === "") {
            rowDataForDb[targetColDef.id] = null;
            continue;
          }

          try {
            switch (targetColDef.type) {
              case 'TEXT':
              case 'SELECT':
                rowDataForDb[targetColDef.id] = String(value);
                break;
              case 'NUMBER':
                const num = parseFloat(value);
                if (isNaN(num)) throw new Error(`'${value}' is not a valid number for column '${targetColDef.name}'.`);
                rowDataForDb[targetColDef.id] = num;
                break;
              case 'BOOLEAN':
                if (typeof value === 'boolean') rowDataForDb[targetColDef.id] = value;
                else rowDataForDb[targetColDef.id] = ['true', '1', 'yes', 't', 'y'].includes(String(value).toLowerCase());
                break;
              case 'DATE':
                const d = new Date(value);
                if (isNaN(d.getTime())) throw new Error(`'${value}' is not a valid date for column '${targetColDef.name}'.`);
                rowDataForDb[targetColDef.id] = d.toISOString().split('T')[0];
                break;
              case 'DATETIME':
                const dt = new Date(value);
                if (isNaN(dt.getTime())) throw new Error(`'${value}' is not a valid datetime for column '${targetColDef.name}'.`);
                rowDataForDb[targetColDef.id] = dt.toISOString();
                break;
              case 'MULTI_SELECT':
                if (!Array.isArray(value)) throw new Error(`Value for MULTI_SELECT column '${targetColDef.name}' must be an array. Found: ${JSON.stringify(value)}`);
                rowDataForDb[targetColDef.id] = value.map(s => String(s).trim()).filter(s => s);
                break;
              case 'RELATION':
                if (!Array.isArray(value)) throw new Error(`Value for RELATION column '${targetColDef.name}' must be an array of numbers. Found: ${JSON.stringify(value)}`);
                rowDataForDb[targetColDef.id] = value.map(id => {
                  const numId = parseInt(id, 10);
                  if (isNaN(numId)) throw new Error(`Invalid ID '${id}' in RELATION array for column '${targetColDef.name}'.`);
                  return numId;
                });
                break;
              default:
                break;
            }
          } catch (typeError) {
            results.errors.push({ itemIndex: i, itemData: jsonObject, error: typeError.message });
            itemHasError = true;
            break;
          }
        }
      }

      if (!itemHasError && Object.keys(rowDataForDb).length > 0) {
        try {
          const addResult = await databaseRowService.addRow({ databaseId, values: rowDataForDb, requestingUserId });
          if (addResult.success) {
            results.successCount++;
          } else {
            results.errorCount++;
            results.errors.push({ itemIndex: i, itemData: jsonObject, error: addResult.error || "Failed to add row to database." });
          }
        } catch (addRowError) {
          results.errorCount++;
          results.errors.push({ itemIndex: i, itemData: jsonObject, error: addRowError.message || "Error during addRow call." });
        }
      } else if (!itemHasError && Object.keys(rowDataForDb).length === 0) {
        results.errorCount++;
        results.errors.push({ itemIndex: i, itemData: jsonObject, error: "No mappable fields found for this item." });
      }
    }
  } catch (error) {
    // General error affecting the whole import (e.g., DB connection, service failure)
    console.error(`Error importing JSON to table ${databaseId}:`, error);
    if (results.successCount === 0 && results.errorCount === 0) { // If no specific item errors yet
        results.errors.push({ itemIndex: -1, error: error.message || "An unexpected error occurred during JSON import." });
        results.errorCount = jsonData && Array.isArray(jsonData) ? jsonData.length : 1; // Assume all failed if one major error
    } else { // If some items were processed, add this as a general error
        results.errors.push({ itemIndex: -1, error: `A general error occurred: ${error.message}` });
    }
  }
  return results;
}
