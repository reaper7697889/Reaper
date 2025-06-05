// src/backend/services/timeLogService.js
const { getDb } = require("../db");
const taskService = require('./taskService'); // To validate taskId

// --- Helper Functions ---
function _parseDate(dateStr, fieldName) {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
        throw new Error(`Invalid date string for ${fieldName}: ${dateStr}`);
    }
    return date;
}

function _toISOString(dateObj) {
    if (!dateObj) return null;
    return dateObj.toISOString();
}

// --- Public Service Functions ---

/**
 * Gets the currently active timer for a given task.
 * @param {number} taskId - The ID of the task.
 * @param {object} [db=getDb()] - Optional database instance for transactions.
 * @returns {Promise<object|null>} - The active time log object or null if none.
 */
async function getActiveTimerForTask(taskId, db = getDb()) {
    try {
        const stmt = db.prepare("SELECT * FROM time_logs WHERE task_id = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1");
        return stmt.get(taskId) || null;
    } catch (err) {
        console.error(`Error getting active timer for task ${taskId}:`, err.message);
        throw err; // Re-throw for transaction handling
    }
}

/**
 * Starts a new timer for a task.
 * @param {number} taskId
 * @param {object} [options={}] - { description = null, userId = null }
 * @returns {Promise<object>} - { success, newLog?: object, error?: string, activeTimer?: object }
 */
async function startTimerForTask(taskId, { description = null, userId = null } = {}) { // Added userId to options
    const db = getDb();
    const transaction = db.transaction(async () => { // Make transaction callback async
        const task = await taskService.getTaskById(taskId); // getTaskById is sync, but await is harmless
        if (!task) throw new Error("Task not found.");

        const existingTimer = await getActiveTimerForTask(taskId, db);
        if (existingTimer) {
            // Return a specific structure that includes the existing timer
            return { success: false, error: "An active timer already exists for this task.", activeTimer: existingTimer, isExistingTimerError: true };
        }

        const startTime = _toISOString(new Date());
        const stmt = db.prepare(
            "INSERT INTO time_logs (task_id, start_time, description, user_id) VALUES (?, ?, ?, ?)" // Added user_id column
        );
        const info = stmt.run(taskId, startTime, description, userId); // Pass userId
        const newLog = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(info.lastInsertRowid); // Should fetch user_id
        return { success: true, newLog };
    });

    try {
        return await transaction();
    } catch (err) {
        console.error(`Error starting timer for task ${taskId}:`, err.message);
        if (err.isExistingTimerError) return { success: false, error: err.error, activeTimer: err.activeTimer };
        return { success: false, error: err.message || "Failed to start timer." };
    }
}

/**
 * Stops the currently active timer for a task.
 * @param {number} taskId
 * @param {object} [options={}] - { endTimeStr = null, description = null }
 * @returns {Promise<object>} - { success, updatedLog?: object, error?: string }
 */
async function stopTimerForTask(taskId, { endTimeStr = null, description = null } = {}) {
    const db = getDb();
    const transaction = db.transaction(async () => {
        const activeTimer = await getActiveTimerForTask(taskId, db);
        if (!activeTimer) {
            throw new Error("No active timer found for this task.");
        }

        const parsedEndTime = endTimeStr ? _parseDate(endTimeStr, "endTimeStr") : new Date();
        const parsedStartTime = _parseDate(activeTimer.start_time, "activeTimer.start_time");

        if (!parsedStartTime) throw new Error("Invalid start_time in active timer record.");
        if (parsedEndTime < parsedStartTime) {
            throw new Error("End time cannot be before start time.");
        }

        const durationSeconds = Math.floor((parsedEndTime.getTime() - parsedStartTime.getTime()) / 1000);

        const updates = {
            end_time: _toISOString(parsedEndTime),
            duration_seconds: durationSeconds
        };
        if (description !== null) { // Allow clearing description by passing null
            updates.description = description;
        }

        const setClauses = Object.keys(updates).map(key => `${key} = ?`);
        const values = [...Object.values(updates), activeTimer.id];

        const stmt = db.prepare(`UPDATE time_logs SET ${setClauses.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
        stmt.run(...values);

        const updatedLog = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(activeTimer.id);
        return { success: true, updatedLog };
    });

    try {
        return await transaction();
    } catch (err) {
        console.error(`Error stopping timer for task ${taskId}:`, err.message);
        return { success: false, error: err.message || "Failed to stop timer." };
    }
}

/**
 * Adds a manual time log entry for a task.
 * @param {number} taskId
 * @param {object} logData - { startTimeStr, endTimeStr?, durationSeconds?, description?, userId? }
 * @returns {Promise<object>} - { success, newLog?: object, error?: string }
 */
async function addManualLogForTask(taskId, { startTimeStr, endTimeStr, durationSeconds, description = null, userId = null }) { // Added userId
    const db = getDb();
    const transaction = db.transaction(async () => {
        const task = await taskService.getTaskById(taskId);
        if (!task) throw new Error("Task not found.");

        let finalStartTime, finalEndTime, finalDurationSeconds;

        if (startTimeStr && endTimeStr) {
            finalStartTime = _parseDate(startTimeStr, "startTimeStr");
            finalEndTime = _parseDate(endTimeStr, "endTimeStr");
            if (finalEndTime < finalStartTime) throw new Error("End time cannot be before start time.");
            finalDurationSeconds = Math.floor((finalEndTime.getTime() - finalStartTime.getTime()) / 1000);
        } else if (startTimeStr && durationSeconds !== undefined) {
            finalStartTime = _parseDate(startTimeStr, "startTimeStr");
            if (typeof durationSeconds !== 'number' || durationSeconds < 0) throw new Error("Invalid durationSeconds.");
            finalDurationSeconds = durationSeconds;
            finalEndTime = new Date(finalStartTime.getTime() + durationSeconds * 1000);
        } else if (endTimeStr && durationSeconds !== undefined) {
            finalEndTime = _parseDate(endTimeStr, "endTimeStr");
            if (typeof durationSeconds !== 'number' || durationSeconds < 0) throw new Error("Invalid durationSeconds.");
            finalDurationSeconds = durationSeconds;
            finalStartTime = new Date(finalEndTime.getTime() - durationSeconds * 1000);
        } else {
            throw new Error("Insufficient data: Provide (startTime & endTime), (startTime & duration), or (endTime & duration).");
        }

        if (finalDurationSeconds < 0) throw new Error("Calculated duration is negative. End time must be after start time.");

        const stmt = db.prepare(
            "INSERT INTO time_logs (task_id, start_time, end_time, duration_seconds, description, user_id) VALUES (?, ?, ?, ?, ?, ?)" // Added user_id column
        );
        const info = stmt.run(taskId, _toISOString(finalStartTime), _toISOString(finalEndTime), finalDurationSeconds, description, userId); // Pass userId
        const newLog = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(info.lastInsertRowid); // Should fetch user_id
        return { success: true, newLog };
    });

    try {
        return await transaction();
    } catch (err) {
        console.error(`Error adding manual log for task ${taskId}:`, err.message);
        return { success: false, error: err.message || "Failed to add manual log." };
    }
}

/**
 * Updates an existing time log.
 * @param {number} logId
 * @param {object} updates - { startTimeStr?, endTimeStr?, durationSeconds?, description? }
 * @returns {Promise<object>} - { success, updatedLog?: object, error?: string }
 */
async function updateTimeLog(logId, updates) {
    const db = getDb();
    const transaction = db.transaction(async () => {
        const currentLog = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(logId);
        if (!currentLog) throw new Error("Time log not found.");

        // If timer is active, only description can be updated, or it must be stopped first.
        if (currentLog.end_time === null && (updates.startTimeStr || updates.endTimeStr || updates.durationSeconds !== undefined)) {
            throw new Error("Cannot modify times/duration of an active timer. Stop the timer first or update only description.");
        }

        let newStartTime = updates.startTimeStr ? _parseDate(updates.startTimeStr, "startTimeStr") : _parseDate(currentLog.start_time, "currentLog.start_time");
        let newEndTime = updates.endTimeStr ? _parseDate(updates.endTimeStr, "endTimeStr") : (currentLog.end_time ? _parseDate(currentLog.end_time, "currentLog.end_time") : null);
        let newDuration = updates.durationSeconds !== undefined ? updates.durationSeconds : currentLog.duration_seconds;

        if (updates.startTimeStr || updates.endTimeStr) { // If either time changed, and both are set, re-calc duration
            if (newStartTime && newEndTime) {
                if (newEndTime < newStartTime) throw new Error("End time cannot be before start time.");
                newDuration = Math.floor((newEndTime.getTime() - newStartTime.getTime()) / 1000);
            } else if (newStartTime && newDuration !== null && newDuration !== undefined && !updates.endTimeStr) { // StartTime changed, duration provided/exists, calc EndTime
                newEndTime = new Date(newStartTime.getTime() + newDuration * 1000);
            } else if (newEndTime && newDuration !== null && newDuration !== undefined && !updates.startTimeStr) { // EndTime changed, duration provided/exists, calc StartTime
                 newStartTime = new Date(newEndTime.getTime() - newDuration * 1000);
            } // If only one time is set and duration is not, it's ambiguous or becomes an active timer - handle carefully
              // For simplicity, if one time is cleared (set to null) and it was a completed timer, that's an invalid state unless duration is also cleared.
              // This update logic assumes we are mostly adjusting completed timers or just the description of an active one.
        } else if (updates.durationSeconds !== undefined && newStartTime && currentLog.end_time !== null) { // Only duration changed for a completed timer, re-calc end_time
            if (updates.durationSeconds < 0) throw new Error("Duration cannot be negative.");
            newEndTime = new Date(newStartTime.getTime() + updates.durationSeconds * 1000);
        }

        // If it's an active timer (currentLog.end_time is null), newEndTime should also be null unless explicitly set in updates
        if (currentLog.end_time === null && !updates.endTimeStr && !updates.durationSeconds) { // Only description can be updated for active timer if not stopping it
            newEndTime = null;
            newDuration = null;
        }


        const fieldsToSet = new Map();
        if (updates.hasOwnProperty('description')) fieldsToSet.set('description', updates.description);
        if (updates.hasOwnProperty('startTimeStr')) fieldsToSet.set('start_time', _toISOString(newStartTime));
        if (updates.hasOwnProperty('endTimeStr') || (newEndTime && currentLog.end_time !== _toISOString(newEndTime)) ) { // if endTimeStr was in updates OR if it was calculated and changed
             fieldsToSet.set('end_time', _toISOString(newEndTime));
        }
        if (updates.hasOwnProperty('durationSeconds') || (newDuration !== null && currentLog.duration_seconds !== newDuration)) {
             fieldsToSet.set('duration_seconds', newDuration);
        }

        if (fieldsToSet.size === 0) return { success: true, updatedLog: currentLog }; // No effective change

        fieldsToSet.set("updated_at", "CURRENT_TIMESTAMP");
        const sqlSetParts = Array.from(fieldsToSet.keys()).map(key => `${key} = ?`);
        const sqlValues = Array.from(fieldsToSet.values());
        sqlValues.push(logId);

        db.prepare(`UPDATE time_logs SET ${sqlSetParts.join(", ")} WHERE id = ?`).run(...sqlValues);
        const updatedLog = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(logId);
        return { success: true, updatedLog };
    });

    try {
        return await transaction();
    } catch (err) {
        console.error(`Error updating time log ${logId}:`, err.message);
        return { success: false, error: err.message || "Failed to update time log." };
    }
}

/**
 * Deletes a time log entry.
 * @param {number} logId
 * @returns {Promise<object>} - { success: boolean, changes: number, error?: string }
 */
async function deleteTimeLog(logId) {
  const db = getDb();
  try {
    const stmt = db.prepare("DELETE FROM time_logs WHERE id = ?");
    const info = stmt.run(logId);
    return { success: true, changes: info.changes };
  } catch (err) {
    console.error(`Error deleting time log ${logId}:`, err.message);
    return { success: false, error: "Failed to delete time log." };
  }
}

/**
 * Retrieves time logs for a specific task, optionally filtered by date range.
 * @param {number} taskId
 * @param {object} [options={}] - { dateRangeStartStr?, dateRangeEndStr?, limit=50, offset=0 }
 * @returns {Promise<Array<object>>} - Array of time log objects.
 */
async function getLogsForTask(taskId, { dateRangeStartStr, dateRangeEndStr, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  let sql = "SELECT * FROM time_logs WHERE task_id = ?";
  const params = [taskId];

  if (dateRangeStartStr) {
    sql += " AND start_time >= ?"; // Assumes start_time is what should be in range
    params.push(dateRangeStartStr);
  }
  if (dateRangeEndStr) {
    sql += " AND start_time <= ?"; // Inclusive end for start_time based range queries
    params.push(dateRangeEndStr);
  }
  sql += " ORDER BY start_time DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    console.error(`Error getting logs for task ${taskId}:`, err.message);
    return [];
  }
}

module.exports = {
  getActiveTimerForTask,
  startTimerForTask,
  stopTimerForTask,
  addManualLogForTask,
  updateTimeLog,
  deleteTimeLog,
  getLogsForTask,
};
