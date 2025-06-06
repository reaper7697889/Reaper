// src/backend/services/timelineService.js
const databaseDefService = require('./databaseDefService');
const databaseQueryService = require('./databaseQueryService');

/**
 * Retrieves and formats data from a database for timeline visualization.
 * @param {object} config - Configuration object.
 * @param {number} config.databaseId - The ID of the database.
 * @param {number} config.startDateColumnId - The ID of the column representing the start date/datetime.
 * @param {number} config.endDateColumnId - The ID of the column representing the end date/datetime.
 * @param {number} config.labelColumnId - The ID of the column to use for item labels.
 * @param {string} [config.viewStartDate] - ISO 8601 string for the start of the view range (optional filter).
 * @param {string} [config.viewEndDate] - ISO 8601 string for the end of the view range (optional filter).
 * @returns {Promise<object>} - { success: boolean, timelineItems?: Array<object>, error?: string }
 */
async function getTimelineDataForDatabase(config) {
  try {
    const {
      databaseId,
      startDateColumnId,
      endDateColumnId,
      labelColumnId,
      viewStartDate,
      viewEndDate
    } = config;

    // 1. Validate required configuration IDs
    if (!databaseId || !startDateColumnId || !endDateColumnId || !labelColumnId) {
      return { success: false, error: "Missing required configuration IDs (databaseId, startDateColumnId, endDateColumnId, labelColumnId)." };
    }

    // 2. Fetch and Validate Column Definitions
    const allColumns = await databaseDefService.getColumnsForDatabase(databaseId);
    if (!allColumns || allColumns.length === 0) {
      return { success: false, error: `No columns found for database ID ${databaseId}.` };
    }

    const startCol = allColumns.find(c => c.id === startDateColumnId);
    const endCol = allColumns.find(c => c.id === endDateColumnId);
    const labelCol = allColumns.find(c => c.id === labelColumnId);

    if (!startCol) return { success: false, error: `Start date column (ID: ${startDateColumnId}) not found.` };
    if (startCol.type !== 'DATE' && startCol.type !== 'DATETIME') {
      return { success: false, error: `Start date column ('${startCol.name}') must be of type DATE or DATETIME.` };
    }
    if (!endCol) return { success: false, error: `End date column (ID: ${endDateColumnId}) not found.` };
    if (endCol.type !== 'DATE' && endCol.type !== 'DATETIME') {
      return { success: false, error: `End date column ('${endCol.name}') must be of type DATE or DATETIME.` };
    }
    if (!labelCol) return { success: false, error: `Label column (ID: ${labelColumnId}) not found.` };
    // Basic check for labelCol type, could be more specific if needed
    if (!['TEXT', 'SELECT', 'FORMULA', 'LOOKUP'].includes(labelCol.type) && !(labelCol.type === 'FORMULA' && labelCol.formula_result_type === 'TEXT')) {
        console.warn(`Label column ('${labelCol.name}') type is ${labelCol.type}. Ensure it provides usable text.`);
    }


    // 3. Construct Filters for getRowsForDatabase
    const filters = [];
    // Overlap logic: Event ends after viewStart AND Event starts before viewEnd
    if (viewStartDate) {
      filters.push({
        columnId: endDateColumnId, // Event's end must be after or at the start of the view range
        operator: 'GREATER_THAN_OR_EQUAL_TO',
        value: viewStartDate
      });
    }
    if (viewEndDate) {
      filters.push({
        columnId: startDateColumnId, // Event's start must be before or at the end of the view range
        operator: 'LESS_THAN_OR_EQUAL_TO',
        value: viewEndDate
      });
    }

    // 4. Fetch Rows
    const dbRowsResult = await databaseQueryService.getRowsForDatabase(databaseId, { filters });

    let dbRows;
    if(Array.isArray(dbRowsResult)) { // Direct array result
        dbRows = dbRowsResult;
    } else if (dbRowsResult && dbRowsResult.success === false && dbRowsResult.error) { // Error object from service
        return { success: false, error: `Failed to fetch rows: ${dbRowsResult.error}` };
    } else if (dbRowsResult && Array.isArray(dbRowsResult.rows)) { // Object with a rows property
        dbRows = dbRowsResult.rows;
    } else {
        console.error("Unexpected result structure from databaseQueryService.getRowsForDatabase:", dbRowsResult);
        return { success: false, error: "Received unexpected data structure from row query service." };
    }


    // 5. Format Data for Timeline
    const timelineItems = [];
    for (const row of dbRows) {
      const id = row.id;
      const text = row.values[labelColumnId] != null ? String(row.values[labelColumnId]) : "Untitled Item";
      const start_date_val = row.values[startDateColumnId];
      const end_date_val = row.values[endDateColumnId];

      if (!start_date_val || !end_date_val) {
        console.warn(`Row ID ${id} skipped: missing start or end date. Start: ${start_date_val}, End: ${end_date_val}`);
        continue;
      }

      const startDateObj = new Date(start_date_val);
      const endDateObj = new Date(end_date_val);

      if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
        console.warn(`Row ID ${id} skipped: invalid date format. Start: ${start_date_val}, End: ${end_date_val}`);
        continue;
      }

      // For timeline, often end date is exclusive, or represents full day.
      // If end date is just a date (YYYY-MM-DD), it might mean end of that day.
      // For simplicity, if start and end are same date, create a 1-day event.
      // If end is before start after parsing, skip.
      if (endDateObj < startDateObj) {
        console.warn(`Row ID ${id} skipped: end date is before start date. Start: ${start_date_val}, End: ${end_date_val}`);
        continue;
      }

      // Format to "YYYY-MM-DD"
      const formatted_start_date = startDateObj.toISOString().split('T')[0];
      let formatted_end_date = endDateObj.toISOString().split('T')[0];

      // Optional: If end date should be exclusive for full-day events, adjust.
      // E.g., a common library pattern: an event from 2023-01-01 to 2023-01-01 should last 1 day.
      // If the library treats end_date as exclusive, and start=end, it might show as 0 duration.
      // So, sometimes people add 1 day to end_date for full-day events.
      // For now, direct conversion. Frontend can adapt if needed.
      // if (formatted_start_date === formatted_end_date) {
      //    const nextDay = new Date(endDateObj);
      //    nextDay.setDate(endDateObj.getDate() + 1);
      //    formatted_end_date = nextDay.toISOString().split('T')[0];
      // }


      timelineItems.push({
        id: String(id), // Ensure ID is string for some timeline libraries
        text,
        start_date: formatted_start_date,
        end_date: formatted_end_date
      });
    }

    return { success: true, timelineItems };

  } catch (error) {
    console.error(`Error in getTimelineDataForDatabase for databaseId ${config.databaseId}:`, error);
    return { success: false, error: error.message || "An unexpected error occurred." };
  }
}

const { getRecurrenceInstances } = require('../utils/recurrenceUtils'); // Added
// databaseDefService is already imported
// const databaseDefService = require('./databaseDefService');

/**
 * @typedef {Object} TimelineEvent
 * @property {string} id - Unique ID for the event instance (e.g., row.id or row.id_instanceTimestamp for recurring)
 * @property {number} originalRowId - The ID of the source row.
 * @property {number} sourceDatabaseId - The ID of the database this event came from.
 * @property {string} title - The event title or label.
 * @property {string} start - ISO 8601 string for the event start.
 * @property {string} end - ISO 8601 string for the event end.
 * @property {string} type - Type hint (e.g., 'event', 'task', 'generic').
 */

/**
 * @typedef {Object} DatabaseSourceConfig
 * @property {number} databaseId - ID of the database to source events from.
 * @property {'calendar' | 'generic'} typeHint - Hint for how to treat this source.
 * @property {string} [titleColumnNameHint] - Name of the column for event titles (used if not calendar or if calendar label needs override).
 * @property {string} [startDateColumnNameHint] - Name of the start date column (used for 'generic' typeHint).
 * @property {string} [endDateColumnNameHint] - Name of the end date column (used for 'generic' typeHint).
 */

/**
 * Fetches and aggregates timeline data from multiple database sources, including handling recurring events.
 *
 * @param {object} params - Parameters object.
 * @param {DatabaseSourceConfig[]} params.databaseSources - Array of database source configurations.
 * @param {string} params.dateRangeStart - ISO 8601 string for the start of the overall timeline view.
 * @param {string} params.dateRangeEnd - ISO 8601 string for the end of the overall timeline view.
 * @param {number} params.requestingUserId - ID of the user making the request.
 * @returns {Promise<{ success: boolean, events?: TimelineEvent[], error?: string }>}
 */
async function getAggregatedTimelineEvents({ databaseSources, dateRangeStart, dateRangeEnd, requestingUserId }) {
  const allEvents = [];
  let dateRangeStartObj, dateRangeEndObj;

  try {
    dateRangeStartObj = new Date(dateRangeStart);
    dateRangeEndObj = new Date(dateRangeEnd);
    if (isNaN(dateRangeStartObj.getTime()) || isNaN(dateRangeEndObj.getTime())) {
      return { success: false, error: "Invalid dateRangeStart or dateRangeEnd." };
    }
  } catch (e) {
    return { success: false, error: "Failed to parse dateRangeStart or dateRangeEnd." };
  }

  if (!Array.isArray(databaseSources) || databaseSources.length === 0) {
    return { success: true, events: [] }; // No sources, return empty successfully.
  }

  for (const source of databaseSources) {
    try {
      const dbDef = await databaseDefService.getDatabaseById(source.databaseId, requestingUserId);
      if (!dbDef) {
        console.warn(`Timeline: Database ID ${source.databaseId} not found or not accessible by user ${requestingUserId}. Skipping.`);
        continue;
      }

      const allColumnsForDb = await databaseDefService.getColumnsForDatabase(source.databaseId, requestingUserId);
      if (!allColumnsForDb || allColumnsForDb.length === 0) {
        console.warn(`Timeline: No columns found for database ID ${source.databaseId}. Skipping.`);
        continue;
      }

      let actualStartDateColumn;
      let actualEndDateColumn;
      let actualLabelColumn;

      if (dbDef.is_calendar && source.typeHint === 'calendar') {
        if (!dbDef.event_start_column_id) {
            console.warn(`Timeline: Calendar database ${dbDef.name} (ID ${source.databaseId}) is missing event_start_column_id. Skipping.`);
            continue;
        }
        actualStartDateColumn = allColumnsForDb.find(c => c.id === dbDef.event_start_column_id);
        actualEndDateColumn = dbDef.event_end_column_id ? allColumnsForDb.find(c => c.id === dbDef.event_end_column_id) : actualStartDateColumn; // Default end to start if not specified

        if (source.titleColumnNameHint) {
            actualLabelColumn = allColumnsForDb.find(c => c.name.toLowerCase() === source.titleColumnNameHint.toLowerCase());
        }
        if (!actualLabelColumn) { // Default label for calendars
            actualLabelColumn = allColumnsForDb.find(c => c.name.toLowerCase() === "name" || c.name.toLowerCase() === "title");
        }
         if (!actualLabelColumn && allColumnsForDb.length > 0) { // Fallback to first text-like column if no specific label
            actualLabelColumn = allColumnsForDb.find(c => ['TEXT', 'SELECT'].includes(c.type) || (c.type === 'FORMULA' && c.formula_result_type === 'TEXT'));
         }


      } else { // Generic source or calendar with overrides
        if (!source.startDateColumnNameHint || !source.titleColumnNameHint) {
          console.warn(`Timeline: Generic source (DB ID ${source.databaseId}) requires startDateColumnNameHint and titleColumnNameHint. Skipping.`);
          continue;
        }
        actualStartDateColumn = allColumnsForDb.find(c => c.name.toLowerCase() === source.startDateColumnNameHint.toLowerCase());
        actualLabelColumn = allColumnsForDb.find(c => c.name.toLowerCase() === source.titleColumnNameHint.toLowerCase());
        if (source.endDateColumnNameHint) {
          actualEndDateColumn = allColumnsForDb.find(c => c.name.toLowerCase() === source.endDateColumnNameHint.toLowerCase());
        } else { // If no end date hint, assume it's same as start (point event or task)
          actualEndDateColumn = actualStartDateColumn;
        }
      }

      if (!actualStartDateColumn) { console.warn(`Timeline: Start date column not resolved for DB ID ${source.databaseId}. Skipping.`); continue; }
      if (!actualEndDateColumn) { console.warn(`Timeline: End date column not resolved for DB ID ${source.databaseId}. Skipping.`); continue; }
      if (!actualLabelColumn) { console.warn(`Timeline: Label column not resolved for DB ID ${source.databaseId}. Skipping.`); continue; }

      if (!['DATE', 'DATETIME'].includes(actualStartDateColumn.type)) { console.warn(`Timeline: Start column for DB ${source.databaseId} is not DATE/DATETIME. Skipping.`); continue; }
      if (!['DATE', 'DATETIME'].includes(actualEndDateColumn.type)) { console.warn(`Timeline: End column for DB ${source.databaseId} is not DATE/DATETIME. Skipping.`); continue; }


      const filters = [];
      filters.push({ columnId: actualEndDateColumn.id, operator: 'GREATER_THAN_OR_EQUAL_TO', value: dateRangeStart });
      filters.push({ columnId: actualStartDateColumn.id, operator: 'LESS_THAN_OR_EQUAL_TO', value: dateRangeEnd });

      // Assuming getRowsForDatabase structure from previous analysis.
      // It expects { filters, sorts }, requestingUserId, options
      const queryResult = await databaseQueryService.getRowsForDatabase(source.databaseId, { filters }, requestingUserId);

      let sourceRows = [];
      if (Array.isArray(queryResult)) {
          sourceRows = queryResult;
      } else if (queryResult && queryResult.success === false) { // Handle potential error structure from service
          console.warn(`Timeline: Failed to fetch rows for DB ID ${source.databaseId}: ${queryResult.error}. Skipping source.`);
          continue;
      } else if (queryResult && Array.isArray(queryResult.rows)) { // Handle potential object structure with rows array
          sourceRows = queryResult.rows;
      } else {
           console.warn(`Timeline: Unexpected data structure from getRowsForDatabase for DB ID ${source.databaseId}. Skipping source.`);
           continue;
      }


      for (const row of sourceRows) {
        const eventTitle = row.values[actualLabelColumn.id] != null ? String(row.values[actualLabelColumn.id]) : "Untitled Event";
        const eventStartStr = row.values[actualStartDateColumn.id];
        let eventEndStr = row.values[actualEndDateColumn.id];

        if (!eventStartStr) {
          console.warn(`Timeline: Row ID ${row.id} in DB ${source.databaseId} skipped: missing start date value.`);
          continue;
        }
        if (!eventEndStr) { // If end date is missing, default it to start date
            eventEndStr = eventStartStr;
        }

        const eventStartDateTime = new Date(eventStartStr);
        if (isNaN(eventStartDateTime.getTime())) {
            console.warn(`Timeline: Row ID ${row.id} in DB ${source.databaseId} has invalid start date ${eventStartStr}. Skipping.`);
            continue;
        }
        let eventEndDateTime = new Date(eventEndStr);
        if (isNaN(eventEndDateTime.getTime())) {
            console.warn(`Timeline: Row ID ${row.id} in DB ${source.databaseId} has invalid end date ${eventEndStr}. Using start date as end.`);
            eventEndDateTime = new Date(eventStartDateTime); // Default to start if end is invalid
        }
         if (eventEndDateTime < eventStartDateTime) { // Ensure end is not before start
            eventEndDateTime = new Date(eventStartDateTime);
        }


        const recurrenceRule = row.recurrence_rule; // Assuming recurrence_rule is a direct property on the row if it exists

        if (dbDef.is_calendar && recurrenceRule && typeof recurrenceRule === 'string' && recurrenceRule.trim() !== "") {
          const originalDuration = eventEndDateTime.getTime() - eventStartDateTime.getTime();
          const instances = getRecurrenceInstances(recurrenceRule, eventStartDateTime, dateRangeStartObj, dateRangeEndObj);

          for (const instanceDate of instances) {
            const instanceEndDate = new Date(instanceDate.getTime() + originalDuration);
            allEvents.push({
              id: `${row.id}_${instanceDate.toISOString()}`, // Create unique ID for instance
              originalRowId: row.id,
              sourceDatabaseId: source.databaseId,
              title: eventTitle,
              start: instanceDate.toISOString(),
              end: instanceEndDate.toISOString(),
              type: source.typeHint === 'calendar' ? 'event' : (source.typeHint || 'generic'),
            });
          }
        } else {
          allEvents.push({
            id: String(row.id),
            originalRowId: row.id,
            sourceDatabaseId: source.databaseId,
            title: eventTitle,
            start: eventStartDateTime.toISOString(),
            end: eventEndDateTime.toISOString(),
            type: source.typeHint || 'generic',
          });
        }
      }
    } catch (sourceError) {
      console.error(`Timeline: Error processing source DB ID ${source.databaseId}:`, sourceError.message, sourceError.stack);
      // Continue to next source
    }
  }

  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return { success: true, events: allEvents };

} catch (overallError) {
    console.error("Timeline: Overall error in getAggregatedTimelineEvents:", overallError.message, overallError.stack);
    return { success: false, error: overallError.message || "An unexpected error occurred while aggregating timeline events." };
}
}


module.exports = {
  getTimelineDataForDatabase,
  getAggregatedTimelineEvents, // Added
};
