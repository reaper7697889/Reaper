// src/backend/services/projectService.js

const databaseRowService = require('./databaseRowService');
// const databaseDefService = require('./databaseDefService'); // For future enhancements

/**
 * Retrieves data for a project dashboard, which is essentially a specific row
 * from a database, potentially containing rollup columns and other metrics.
 *
 * @param {number} projectRowId - The ID of the database row representing the project.
 * @param {number} requestingUserId - The ID of the user making the request.
 * @returns {Promise<object>} - { success: boolean, dashboardData?: object, error?: string }
 */
async function getProjectDashboard(projectRowId, requestingUserId) {
  // Input Validation
  if (projectRowId === null || projectRowId === undefined || isNaN(parseInt(String(projectRowId), 10))) {
    return { success: false, error: "Invalid projectRowId provided. Must be a number." };
  }
  const parsedProjectRowId = parseInt(String(projectRowId), 10);

  if (requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "requestingUserId is required." };
  }

  try {
    // Fetch Project Row Data using databaseRowService.getRow
    // getRow handles:
    // - Authorization (user can access the database this row belongs to)
    // - Row existence (returns null if not found or soft-deleted and includeDeleted is false)
    // - Fetching all column values, including computed ones like ROLLUPs.
    const projectRowData = await databaseRowService.getRow(parsedProjectRowId, requestingUserId);

    if (!projectRowData) {
      // This means the row was not found, or it's soft-deleted (and getRow by default doesn't include deleted),
      // or the user doesn't have access to the parent database.
      return { success: false, error: "Project not found or not accessible." };
    }

    // The entire projectRowData object (which includes id, database_id, row_order, and values map)
    // is considered the dashboard data. The frontend will select relevant fields.
    return { success: true, dashboardData: projectRowData };

  } catch (error) {
    console.error(`Error in getProjectDashboard for projectRowId ${projectRowId} (user ${requestingUserId}):`, error);
    return { success: false, error: error.message || "An unexpected error occurred while fetching project dashboard data." };
  }
}

module.exports = {
  getProjectDashboard,
};
