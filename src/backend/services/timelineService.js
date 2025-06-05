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

module.exports = {
  getTimelineDataForDatabase,
};
