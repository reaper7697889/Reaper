// src/backend/services/insightsService.js
const { getDb } = require('../../../db'); // Corrected path
// Potentially userService if we needed to validate user existence beyond just ID match,
// but for this function, direct ID comparison is sufficient for authorization.

/**
 * Retrieves task completion statistics for a user over a specified period.
 *
 * @param {number|string} userId - The ID of the user whose stats are being fetched.
 * @param {string} periodUnit - Grouping period: 'day', 'week', or 'month'.
 * @param {string} startDateISO - ISO 8601 string for the start of the date range (inclusive).
 * @param {string} endDateISO - ISO 8601 string for the end of the date range (inclusive).
 * @param {number|string} requestingUserId - The ID of the user making the request.
 * @returns {Promise<object>} - { success: boolean, data?: Array<object>, error?: string }
 *                            data objects contain { period: string, completed_count: number }
 */
async function getTaskCompletionStats(userId, periodUnit, startDateISO, endDateISO, requestingUserId) {
  // Input Validation & Authorization
  if (userId === null || userId === undefined ||
      requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "User ID and requesting User ID are required." };
  }

  const parsedUserId = parseInt(String(userId), 10);
  const parsedRequestingUserId = parseInt(String(requestingUserId), 10);

  if (isNaN(parsedUserId) || isNaN(parsedRequestingUserId)) {
      return { success: false, error: "User IDs must be numeric." };
  }

  if (parsedUserId !== parsedRequestingUserId) {
    return { success: false, error: "Authorization denied: Users can only fetch their own task completion statistics." };
  }

  if (!periodUnit || !['day', 'week', 'month'].includes(periodUnit)) {
    return { success: false, error: "Invalid periodUnit. Must be 'day', 'week', or 'month'." };
  }
  if (!startDateISO || !endDateISO) {
    return { success: false, error: "Start date and end date are required." };
  }
  // Basic ISO date format validation could be added here, but SQLite's date functions are somewhat tolerant.

  const db = getDb();
  try {
    const params = [parsedUserId];
    let periodSelectSQL = "";
    let groupBySQL = "";
    // The date column used for filtering and grouping completed tasks.
    // 'updated_at' is often when is_completed is set, but 'due_date' or a dedicated 'completed_at' could also be options.
    // For this implementation, we'll assume 'updated_at' reflects completion time for tasks marked is_completed = 1.
    // A dedicated 'completed_at' timestamp that gets set when a task is marked complete would be more accurate.
    const dateColumnForFiltering = "updated_at";
    const dateColumnForGrouping = "updated_at";

    switch (periodUnit) {
      case 'day':
        periodSelectSQL = `strftime('%Y-%m-%d', ${dateColumnForGrouping})`;
        break;
      case 'week':
        // SQLite's %W: week of year (00-53), Sunday first. %w: day of week (0-6, Sunday==0).
        // To get a consistent week identifier that includes the year:
        periodSelectSQL = `strftime('%Y-%W', ${dateColumnForGrouping})`;
        break;
      case 'month':
        periodSelectSQL = `strftime('%Y-%m', ${dateColumnForGrouping})`;
        break;
      default: // Should be caught by initial validation
        return { success: false, error: "Invalid periodUnit." };
    }
    groupBySQL = periodSelectSQL;

    let sql = `
      SELECT
        COUNT(*) as completed_count,
        ${periodSelectSQL} as period
      FROM tasks
      WHERE
        user_id = ?
        AND is_completed = 1
        AND deleted_at IS NULL
    `;

    // Date Filtering
    // Using date() ensures we compare YYYY-MM-DD parts, ignoring time, robust for DATETIME columns.
    if (startDateISO) {
      sql += ` AND date(${dateColumnForFiltering}) >= date(?)`;
      params.push(startDateISO);
    }
    if (endDateISO) {
      sql += ` AND date(${dateColumnForFiltering}) <= date(?)`;
      params.push(endDateISO);
    }

    sql += ` GROUP BY ${groupBySQL} ORDER BY period ASC`;

    const rows = db.prepare(sql).all(...params);
    return { success: true, data: rows };

  } catch (err) {
    console.error(`Error fetching task completion stats for user ${userId} (requested by ${requestingUserId}):`, err.message, err.stack);
    return { success: false, error: err.message || "Failed to retrieve task completion statistics." };
  }
}

module.exports = {
  getTaskCompletionStats,
  getTimeLoggedStats,
  getTaskOverviewStats, // Export the new function
};

/**
 * Retrieves time logged statistics for a user over a specified period.
 *
 * @param {number|string} userId - The ID of the user whose stats are being fetched.
 * @param {string} periodUnit - Grouping period: 'day', 'week', or 'month'.
 * @param {string} startDateISO - ISO 8601 string for the start of the date range (inclusive).
 * @param {string} endDateISO - ISO 8601 string for the end of the date range (inclusive).
 * @param {number|string} requestingUserId - The ID of the user making the request.
 * @returns {Promise<object>} - { success: boolean, data?: Array<object>, error?: string }
 *                            data objects contain { period: string, total_duration_seconds: number }
 */
async function getTimeLoggedStats(userId, periodUnit, startDateISO, endDateISO, requestingUserId) {
  // Input Validation & Authorization
  if (userId === null || userId === undefined ||
      requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "User ID and requesting User ID are required." };
  }

  const parsedUserId = parseInt(String(userId), 10);
  const parsedRequestingUserId = parseInt(String(requestingUserId), 10);

  if (isNaN(parsedUserId) || isNaN(parsedRequestingUserId)) {
      return { success: false, error: "User IDs must be numeric." };
  }

  if (parsedUserId !== parsedRequestingUserId) {
    return { success: false, error: "Authorization denied: Users can only fetch their own time logged statistics." };
  }

  if (!periodUnit || !['day', 'week', 'month'].includes(periodUnit)) {
    return { success: false, error: "Invalid periodUnit. Must be 'day', 'week', or 'month'." };
  }
  if (!startDateISO || !endDateISO) {
    return { success: false, error: "Start date and end date are required." };
  }

  const db = getDb();
  try {
    const params = [parsedUserId];
    let periodSelectSQL = "";
    let groupBySQL = "";
    const dateColumnForFiltering = "start_time";
    const dateColumnForGrouping = "start_time";

    switch (periodUnit) {
      case 'day':
        periodSelectSQL = `strftime('%Y-%m-%d', ${dateColumnForGrouping})`;
        break;
      case 'week':
        periodSelectSQL = `strftime('%Y-%W', ${dateColumnForGrouping})`;
        break;
      case 'month':
        periodSelectSQL = `strftime('%Y-%m', ${dateColumnForGrouping})`;
        break;
      default:
        return { success: false, error: "Invalid periodUnit." }; // Should be caught by initial validation
    }
    groupBySQL = periodSelectSQL;

    let sql = `
      SELECT
        SUM(duration_seconds) as total_duration_seconds,
        ${periodSelectSQL} as period
      FROM time_logs
      WHERE
        user_id = ?
        AND duration_seconds IS NOT NULL
        -- AND end_time IS NOT NULL -- Optionally ensure only completed timers are summed
    `;

    if (startDateISO) {
      sql += ` AND date(${dateColumnForFiltering}) >= date(?)`;
      params.push(startDateISO);
    }
    if (endDateISO) {
      sql += ` AND date(${dateColumnForFiltering}) <= date(?)`;
      params.push(endDateISO);
    }

    sql += ` GROUP BY ${groupBySQL} ORDER BY period ASC`;

    const rows = db.prepare(sql).all(...params);

    const processedRows = rows.map(row => ({
        ...row,
        total_duration_seconds: row.total_duration_seconds === null ? 0 : Number(row.total_duration_seconds)
    }));

    return { success: true, data: processedRows };

  } catch (err) {
    console.error(`Error fetching time logged stats for user ${userId} (requested by ${requestingUserId}):`, err.message, err.stack);
    return { success: false, error: err.message || "Failed to retrieve time logged statistics." };
  }
}

/**
 * Retrieves an overview of task statistics for a user (active and overdue tasks).
 *
 * @param {number|string} userId - The ID of the user whose stats are being fetched.
 * @param {number|string} requestingUserId - The ID of the user making the request.
 * @returns {Promise<object>} - { success: boolean, data?: { active_tasks: number, overdue_tasks: number }, error?: string }
 */
async function getTaskOverviewStats(userId, requestingUserId) {
  // Input Validation & Authorization
  if (userId === null || userId === undefined ||
      requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "User ID and requesting User ID are required." };
  }

  const parsedUserId = parseInt(String(userId), 10);
  const parsedRequestingUserId = parseInt(String(requestingUserId), 10);

  if (isNaN(parsedUserId) || isNaN(parsedRequestingUserId)) {
      return { success: false, error: "User IDs must be numeric." };
  }

  if (parsedUserId !== parsedRequestingUserId) {
    return { success: false, error: "Authorization denied: Users can only fetch their own task overview statistics." };
  }

  const db = getDb();
  try {
    // Active Tasks Query
    const sqlActive = "SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND is_completed = 0 AND deleted_at IS NULL";
    const activeResult = db.prepare(sqlActive).get(parsedUserId);
    const active_tasks = activeResult ? activeResult.count : 0;

    // Overdue Tasks Query
    // date('now') in SQLite returns 'YYYY-MM-DD'. Comparing date(due_date) ensures correct date-only comparison.
    const sqlOverdue = `
      SELECT COUNT(*) as count
      FROM tasks
      WHERE user_id = ?
        AND is_completed = 0
        AND deleted_at IS NULL
        AND due_date IS NOT NULL
        AND date(due_date) < date('now')
    `;
    const overdueResult = db.prepare(sqlOverdue).get(parsedUserId);
    const overdue_tasks = overdueResult ? overdueResult.count : 0;

    return { success: true, data: { active_tasks, overdue_tasks } };

  } catch (err) {
    console.error(`Error fetching task overview stats for user ${userId} (requested by ${requestingUserId}):`, err.message, err.stack);
    return { success: false, error: err.message || "Failed to retrieve task overview statistics." };
  }
}
