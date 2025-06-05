// src/backend/services/calendarService.js
const { getDb } = require("../db"); // May not be directly needed if using services
const databaseDefService = require('./databaseDefService');
const databaseQueryService = require('./databaseQueryService');

/**
 * Retrieves calendar events from a specified database within a date range.
 * @param {number} databaseId - The ID of the 'note_databases' table marked as a calendar.
 * @param {string} dateRangeStartStr - ISO 8601 string for the start of the date range.
 * @param {string} dateRangeEndStr - ISO 8601 string for the end of the date range.
 * @param {object} options - Additional options (currently unused).
 * @returns {Promise<object>} - { success: boolean, events?: Array<object>, error?: string }
 */
async function getCalendarEvents(databaseId, dateRangeStartStr, dateRangeEndStr, options = {}) {
  try {
    // 1. Validate databaseId and ensure it's a calendar
    const dbDef = await databaseDefService.getDatabaseById(databaseId);
    if (!dbDef || !dbDef.is_calendar) {
      return { success: false, error: "Invalid or non-calendar database ID." };
    }

    // 2. Identify Start/End DateTime Columns (By Convention)
    const columns = await databaseDefService.getColumnsForDatabase(databaseId);
    if (!columns || columns.length === 0) {
        return { success: false, error: "No columns found in the calendar database." };
    }

    // Sort by column_order to reliably get first/second DATETIME columns
    columns.sort((a, b) => a.column_order - b.column_order);

    const dateTimeColumns = columns.filter(col => col.type === 'DATETIME');

    if (dateTimeColumns.length === 0) {
      return { success: false, error: "Calendar table requires at least one DATETIME column for event start times." };
    }

    const startCol = dateTimeColumns[0];
    const endCol = dateTimeColumns.length > 1 ? dateTimeColumns[1] : null;

    // 3. Construct Filters for getRowsForDatabase
    // Basic overlap logic: (StartA < EndB) AND (EndA > StartB)
    // Event starts before the range ends: event.start < dateRangeEndStr
    // Event ends after the range starts: event.end > dateRangeStartStr (or event.start if no end time)
    const filters = [];

    filters.push({
      columnId: startCol.id,
      operator: 'LESS_THAN', // Using LESS_THAN as per prompt correction, can be adjusted to <= if needed & supported
      value: dateRangeEndStr,
    });

    const effectiveEndColumnId = endCol ? endCol.id : startCol.id;
    filters.push({
      columnId: effectiveEndColumnId,
      operator: 'GREATER_THAN', // Using GREATER_THAN, can be adjusted to >= if needed & supported
      value: dateRangeStartStr,
    });

    // 4. Fetch Rows
    // databaseQueryService.getRowsForDatabase returns an array of rows or an error object
    const queryResult = await databaseQueryService.getRowsForDatabase(databaseId, { filters });

    if (Array.isArray(queryResult)) { // Success case from getRowsForDatabase
        return { success: true, events: queryResult };
    } else if (queryResult && queryResult.success === false) { // Error object from getRowsForDatabase
        return queryResult;
    } else { // Unexpected result
        console.error("Unexpected result from databaseQueryService.getRowsForDatabase:", queryResult);
        return { success: false, error: "Failed to fetch events due to an unexpected query service error." };
    }

  } catch (error) {
    console.error(`Error in getCalendarEvents for databaseId ${databaseId}:`, error);
    return { success: false, error: error.message || "An unexpected error occurred while fetching calendar events." };
  }
}

module.exports = {
  getCalendarEvents,
};
