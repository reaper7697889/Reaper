// src/backend/services/projectService.js

const databaseRowService = require('./databaseRowService');
// const databaseDefService = require('./databaseDefService'); // For future enhancements
const taskService = require('./taskService'); // Added import

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

    // Fetch tasks related to this project
    let tasks = [];
    try {
      // Assuming getTasksForProject returns an array of tasks, or empty if none/error internally handled by returning empty.
      const fetchedTasks = await taskService.getTasksForProject(parsedProjectRowId, requestingUserId);
      if (Array.isArray(fetchedTasks)) {
        tasks = fetchedTasks;
      } else {
        // This case assumes getTasksForProject might return { success: false, error: ... }
        // However, based on its current implementation, it returns [] on error.
        // Logging here just in case its behavior changes or for robustness.
        console.warn(`Could not retrieve tasks for project ${parsedProjectRowId}, or unexpected format. Proceeding without task metrics.`);
      }
    } catch (taskError) {
      // Catch errors from the call to getTasksForProject itself
      console.error(`Error fetching tasks for project ${parsedProjectRowId} in getProjectDashboard:`, taskError.message);
      // Proceed without task metrics, or could choose to return an error for the whole dashboard
    }

    // Calculate progress metrics
    const total_tasks = tasks.length;
    const completed_tasks = tasks.filter(t => t.is_completed === true).length;
    const progress_percent = (total_tasks > 0) ? parseFloat(((completed_tasks / total_tasks) * 100).toFixed(2)) : 0;

    projectRowData.progressMetrics = {
      total_tasks,
      completed_tasks,
      progress_percent,
    };

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
