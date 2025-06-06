// src/backend/services/calendarService.js
const { getDb } = require("../db");
const databaseDefService = require('./databaseDefService');
const databaseQueryService = require('./databaseQueryService');
const { RRule, RRuleSet, rrulestr } = require('rrule');

/**
 * Retrieves and expands calendar events from a specified database within a date range,
 * processing recurrence rules.
 * @param {number} databaseId - The ID of the 'note_databases' table configured as a calendar.
 * @param {string} timeWindowStartISO - ISO 8601 string for the start of the time window.
 * @param {string} timeWindowEndISO - ISO 8601 string for the end of the time window.
 * @param {number} requestingUserId - ID of the user making the request.
 * @returns {Promise<object>} - { success: boolean, events?: Array<object>, error?: string }
 */
async function getExpandedEventsInRange(databaseId, timeWindowStartISO, timeWindowEndISO, requestingUserId) {
  try {
    // 1. Fetch Database Definition and Validate Calendar Configuration
    const dbDef = await databaseDefService.getDatabaseById(databaseId, requestingUserId);
    if (!dbDef) {
      return { success: false, error: "Database not found or not accessible." };
    }
    if (!dbDef.is_calendar || !dbDef.event_start_column_id) {
      return { success: false, error: "Database not configured as a calendar or missing event start date column." };
    }

    const startColId = dbDef.event_start_column_id;
    const endColId = dbDef.event_end_column_id; // Can be null

    // 2. Fetch All Rows from the table
    // Note: Fetching all rows might be inefficient for very large tables.
    // Future optimization: Pre-filter rows based on a broader date range if possible,
    // or if RRULEs are limited in their forward expansion.
    // For now, following the spec to fetch all and then process.
    const rowsResult = await databaseQueryService.getRowsForDatabase(databaseId, { filters: [], sorts: [] }, requestingUserId);
    if (!Array.isArray(rowsResult)) { // Assuming getRowsForDatabase returns array on success, or error object
        console.error("Error fetching rows for calendar:", rowsResult);
        return { success: false, error: rowsResult.error || "Failed to fetch rows for calendar." };
    }
    const rows = rowsResult;

    // 3. Fetch Column Definitions (for Title determination)
    const columnDefs = await databaseDefService.getColumnsForDatabase(databaseId, requestingUserId);
    if (!columnDefs) {
        return { success: false, error: "Could not retrieve column definitions for the calendar database."};
    }

    let titleColumn = columnDefs.filter(col => col.type === 'TEXT').sort((a,b) => a.column_order - b.column_order)[0];
    const titleColId = titleColumn ? titleColumn.id : null;

    const expandedEvents = [];
    const windowStart = new Date(timeWindowStartISO);
    const windowEnd = new Date(timeWindowEndISO);

    for (const row of rows) {
      try {
        const baseStartDateString = row.values[startColId];
        if (!baseStartDateString) {
          // console.warn(`Row ${row.id} in DB ${databaseId} missing start date in column ${startColId}. Skipping.`);
          continue;
        }

        let baseStartDate;
        try {
          baseStartDate = new Date(baseStartDateString);
          if (isNaN(baseStartDate.getTime())) throw new Error('Invalid start date');
        } catch (e) {
          // console.warn(`Row ${row.id} in DB ${databaseId} has invalid start date string '${baseStartDateString}'. Skipping.`);
          continue;
        }

        const baseEndDateString = endColId ? row.values[endColId] : null;
        let baseEndDate;

        if (baseEndDateString) {
            try {
                baseEndDate = new Date(baseEndDateString);
                if (isNaN(baseEndDate.getTime())) throw new Error('Invalid end date string');
            } catch (e) {
                // console.warn(`Row ${row.id} in DB ${databaseId} has invalid end date string '${baseEndDateString}'. Using start date as end date.`);
                baseEndDate = new Date(baseStartDate); // Fallback to start date
            }
        } else {
            baseEndDate = new Date(baseStartDate); // If no end column, event duration is minimal (or effectively on start date)
        }

        if (baseEndDate.getTime() < baseStartDate.getTime()) {
            // console.warn(`Row ${row.id} in DB ${databaseId} has end date before start date. Using start date as end date.`);
            baseEndDate = new Date(baseStartDate); // Correct invalid end date
        }

        const rruleString = row.recurrence_rule; // Assuming 'recurrence_rule' is the field name on the row object from database_rows
        const eventTitle = titleColId ? (row.values[titleColId] || `Event ${row.id}`) : `Event ${row.id}`;

        // Basic all-day check: if the start date string does not contain 'T' (time separator)
        // This is a heuristic. A more robust way would be if there's an explicit all-day column.
        const isAllDay = !String(baseStartDateString).includes('T');


        if (rruleString) {
          try {
            const rule = rrulestr(rruleString, { dtstart: baseStartDate });
            const occurrences = rule.between(windowStart, windowEnd, true); // true to include start date if it matches

            for (const occurrenceDate of occurrences) {
              const duration = baseEndDate.getTime() - baseStartDate.getTime();
              const occurrenceEndDate = new Date(occurrenceDate.getTime() + duration);
              expandedEvents.push({
                id: `${row.id}_${occurrenceDate.toISOString()}`, // Create a unique ID for each instance
                originalRowId: row.id,
                title: eventTitle,
                start: occurrenceDate.toISOString(),
                end: occurrenceEndDate.toISOString(),
                allDay: isAllDay, // All occurrences of an event share its all-day status
                originalRowData: row, // For client-side to have full data if needed
              });
            }
          } catch (rruleError) {
            console.error(`Error processing RRULE for row ${row.id} in DB ${databaseId}: ${rruleError.message}. Treating as single event. RRULE: "${rruleString}"`);
            // Fallback: treat as a single event if RRULE is invalid
            if (baseStartDate < windowEnd && baseEndDate > windowStart) {
              expandedEvents.push({
                id: String(row.id),
                originalRowId: row.id,
                title: eventTitle,
                start: baseStartDate.toISOString(),
                end: baseEndDate.toISOString(),
                allDay: isAllDay,
                originalRowData: row,
              });
            }
          }
        } else {
          // Single event (no recurrence rule)
          if (baseStartDate < windowEnd && baseEndDate > windowStart) {
            expandedEvents.push({
              id: String(row.id),
              originalRowId: row.id,
              title: eventTitle,
              start: baseStartDate.toISOString(),
              end: baseEndDate.toISOString(),
              allDay: isAllDay,
              originalRowData: row,
            });
          }
        }
      } catch (eventProcessingError) {
          console.error(`Error processing event for row ${row.id} in DB ${databaseId}: ${eventProcessingError.message}`, eventProcessingError.stack);
          // Optionally add to an errors array in the response
      }
    }

    return { success: true, events: expandedEvents };

  } catch (error) {
    console.error(`Error in getExpandedEventsInRange for databaseId ${databaseId}:`, error);
    return { success: false, error: error.message || "An unexpected error occurred while fetching calendar events." };
  }
}

module.exports = {
  getExpandedEventsInRange,
};
