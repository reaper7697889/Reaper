// src/backend/services/timeLogService.js
const { getDb } = require("../db");
const taskService = require('./taskService'); // To validate taskId
const noteService = require('./noteService'); // Added
const databaseRowService = require('./databaseRowService'); // Added

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

async function _validateTarget(targetType, targetId, requestingUserId, operationName = "operation") {
    if (!['task', 'note', 'database_row'].includes(targetType)) {
        throw new Error(`Invalid targetType: ${targetType} for ${operationName}.`);
    }
    if (targetId === null || targetId === undefined) {
        throw new Error(`targetId is required for ${operationName}.`);
    }

    let targetEntity;
    switch (targetType) {
        case 'task':
            targetEntity = await taskService.getTaskById(targetId, requestingUserId);
            if (!targetEntity) throw new Error(`Authorization failed: Task ID ${targetId} not found or not accessible by user for ${operationName}.`);
            break;
        case 'note':
            targetEntity = await noteService.getNoteById(targetId, requestingUserId);
            if (!targetEntity) throw new Error(`Authorization failed: Note ID ${targetId} not found or not accessible by user for ${operationName}.`);
            break;
        case 'database_row':
            targetEntity = await databaseRowService.getRow(targetId, requestingUserId);
            if (!targetEntity) throw new Error(`Authorization failed: Database Row ID ${targetId} not found or not accessible by user for ${operationName}.`);
            break;
        default: // Should be caught by the initial check, but as a safeguard
            throw new Error(`Unhandled targetType: ${targetType} for ${operationName}.`);
    }
    return targetEntity; // Return entity if needed, or just let it pass if no error
}


// --- Public Service Functions ---

/**
 * Gets the currently active timer for a given target.
 * @param {string} targetType - Type of the target ('task', 'note', 'database_row').
 * @param {number} targetId - The ID of the target entity.
 * @param {number | null} requestingUserId - ID of the user making the request.
 * @param {object} [db=getDb()] - Optional database instance for transactions.
 * @returns {Promise<object|null>} - The active time log object or null if none/not accessible.
 */
async function getActiveTimerForTarget(targetType, targetId, requestingUserId, db = getDb()) {
    try {
        await _validateTarget(targetType, targetId, requestingUserId, "getActiveTimerForTarget");
        const stmt = db.prepare("SELECT * FROM time_logs WHERE log_target_type = ? AND log_target_id = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1");
        return stmt.get(targetType, targetId) || null;
    } catch (err) {
        console.error(`Error getting active timer for ${targetType} ${targetId} (user ${requestingUserId}):`, err.message);
        return null; // Return null on validation error or DB error
    }
}

/**
 * Starts a new timer for a target.
 * @param {string} targetType
 * @param {number} targetId
 * @param {object} [options={}] - { description = null }
 * @param {number | null} requestingUserId - ID of the user making the request.
 * @returns {Promise<object>} - { success, newLog?: object, error?: string, activeTimer?: object }
 */
async function startTimerForTarget(targetType, targetId, { description = null } = {}, requestingUserId) {
    const db = getDb();
    const transaction = db.transaction(async () => {
        await _validateTarget(targetType, targetId, requestingUserId, "startTimerForTarget");

        const existingTimer = await getActiveTimerForTarget(targetType, targetId, requestingUserId, db);
        if (existingTimer) {
            // Use a specific error structure or property to indicate this specific case
            const error = new Error("An active timer already exists for this target.");
            error.isExistingTimerError = true;
            error.activeTimer = existingTimer;
            throw error;
        }

        const startTime = _toISOString(new Date());
        const stmt = db.prepare(
            "INSERT INTO time_logs (log_target_type, log_target_id, start_time, description, user_id) VALUES (?, ?, ?, ?, ?)"
        );
        const info = stmt.run(targetType, targetId, startTime, description, requestingUserId);
        const newLog = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(info.lastInsertRowid);
        return { success: true, newLog };
    });

    try {
        return await transaction();
    } catch (err) {
        console.error(`Error starting timer for ${targetType} ${targetId} (user ${requestingUserId}):`, err.message);
        if (err.isExistingTimerError) return { success: false, error: err.message, activeTimer: err.activeTimer };
        return { success: false, error: err.message || "Failed to start timer." };
    }
}

/**
 * Stops the currently active timer for a target.
 * @param {string} targetType
 * @param {number} targetId
 * @param {object} [options={}] - { endTimeStr = null, description = null }
 * @param {number | null} requestingUserId - ID of the user making the request.
 * @returns {Promise<object>} - { success, updatedLog?: object, error?: string }
 */
async function stopTimerForTarget(targetType, targetId, { endTimeStr = null, description = null } = {}, requestingUserId) {
    const db = getDb();
    const transaction = db.transaction(async () => {
        await _validateTarget(targetType, targetId, requestingUserId, "stopTimerForTarget");

        const activeTimer = await getActiveTimerForTarget(targetType, targetId, requestingUserId, db);
        if (!activeTimer) {
            throw new Error("No active timer found for this target.");
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
        console.error(`Error stopping timer for task ${taskId} (user ${requestingUserId}):`, err.message);
        return { success: false, error: err.message || "Failed to stop timer." };
    }
}

/**
 * Adds a manual time log entry for a target.
 * @param {string} targetType
 * @param {number} targetId
 * @param {object} logData - { startTimeStr, endTimeStr?, durationSeconds?, description? }
 * @param {number | null} requestingUserId - ID of the user making the request.
 * @returns {Promise<object>} - { success, newLog?: object, error?: string }
 */
async function addManualLogForTarget(targetType, targetId, { startTimeStr, endTimeStr, durationSeconds, description = null }, requestingUserId) {
    const db = getDb();
    const transaction = db.transaction(async () => {
        await _validateTarget(targetType, targetId, requestingUserId, "addManualLogForTarget");

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
            "INSERT INTO time_logs (log_target_type, log_target_id, start_time, end_time, duration_seconds, description, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
        );
        const info = stmt.run(targetType, targetId, _toISOString(finalStartTime), _toISOString(finalEndTime), finalDurationSeconds, description, requestingUserId);
        const newLog = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(info.lastInsertRowid);
        return { success: true, newLog };
    });

    try {
        return await transaction();
    } catch (err) {
        console.error(`Error adding manual log for ${targetType} ${targetId} (user ${requestingUserId}):`, err.message);
        return { success: false, error: err.message || "Failed to add manual log." };
    }
}

/**
 * Updates an existing time log.
 * @param {number} logId
 * @param {object} updates - { startTimeStr?, endTimeStr?, durationSeconds?, description? }
 * @param {number | null} requestingUserId - ID of the user making the request.
 * @returns {Promise<object>} - { success, updatedLog?: object, error?: string }
 */
async function updateTimeLog(logId, updates, requestingUserId) {
    const db = getDb();
    const transaction = db.transaction(async () => {
        const currentLog = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(logId);
        if (!currentLog) {
            throw new Error("Time log not found.");
        }

        // Validate access to the target entity of the log
        await _validateTarget(currentLog.log_target_type, currentLog.log_target_id, requestingUserId, "updateTimeLog (target check)");

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
        console.error(`Error updating time log ${logId} (user ${requestingUserId}):`, err.message);
        return { success: false, error: err.message || "Failed to update time log." };
    }
}

/**
 * Deletes a time log entry.
 * @param {number} logId
 * @param {number | null} requestingUserId - ID of the user making the request.
 * @returns {Promise<object>} - { success: boolean, error?: string }
 */
async function deleteTimeLog(logId, requestingUserId) {
  const db = getDb();
    const transaction = db.transaction(async () => { // Wrap in transaction for consistency if future pre-delete checks are added
        const currentLog = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(logId);
        if (!currentLog) {
            throw new Error("Time log not found.");
        }

        await _validateTarget(currentLog.log_target_type, currentLog.log_target_id, requestingUserId, "deleteTimeLog (target check)");

        const stmt = db.prepare("DELETE FROM time_logs WHERE id = ?");
        const info = stmt.run(logId);
        if (info.changes === 0) {
            // This might happen if the log was deleted between the check and the delete command, though unlikely with a transaction.
            throw new Error("Time log found but delete operation affected no rows.");
        }
        return { success: true };
    });
    try {
        return await transaction();
    } catch (err) {
        console.error(`Error deleting time log ${logId} (user ${requestingUserId}):`, err.message);
        return { success: false, error: err.message || "Failed to delete time log." };
    }
}

/**
 * Retrieves time logs for a specific target, optionally filtered by date range.
 * @param {string} targetType
 * @param {number} targetId
 * @param {object} [options={}] - { dateRangeStartStr?, dateRangeEndStr?, limit=50, offset=0 }
 * @param {number | null} requestingUserId - ID of the user making the request.
 * @returns {Promise<Array<object>>} - Array of time log objects.
 */
async function getLogsForTarget(targetType, targetId, { dateRangeStartStr, dateRangeEndStr, limit = 50, offset = 0 } = {}, requestingUserId) {
  const db = getDb();
  try {
    await _validateTarget(targetType, targetId, requestingUserId, "getLogsForTarget");

    let sql = "SELECT * FROM time_logs WHERE log_target_type = ? AND log_target_id = ?";
    const params = [targetType, targetId];

    if (dateRangeStartStr) {
      sql += " AND start_time >= ?";
      params.push(dateRangeStartStr);
    }
    if (dateRangeEndStr) {
      sql += " AND start_time <= ?";
      params.push(dateRangeEndStr);
    }
    sql += " ORDER BY start_time DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    return db.prepare(sql).all(...params);
  } catch (err) {
    console.error(`Error getting logs for ${targetType} ${targetId} (user ${requestingUserId}):`, err.message);
    return [];
  }
}

module.exports = {
  getActiveTimerForTarget,
  startTimerForTarget,
  stopTimerForTarget,
  addManualLogForTarget,
  updateTimeLog,
  deleteTimeLog,
  getLogsForTarget,
  getTimeLogsForUser,
};

// getTimeLogsForUser remains largely the same as it filters by user_id on time_logs table.
// The schema change from task_id to generic target fields doesn't affect its core query logic.
async function getTimeLogsForUser(targetUserId, { dateRangeStartStr, dateRangeEndStr, limit = 50, offset = 0 } = {}, requestingUserId) {
  if (targetUserId === null || targetUserId === undefined) {
    return { success: false, error: "targetUserId is required." };
  }
  if (requestingUserId === null || requestingUserId === undefined) {
    // This case should ideally be caught by middleware or an earlier auth check in a real app.
    return { success: false, error: "requestingUserId is required for authorization." };
  }

  // Authorization: Users can only fetch their own time logs.
  if (targetUserId !== requestingUserId) {
    // Consider logging this attempt for security auditing if needed.
    console.warn(`User ${requestingUserId} attempted to fetch time logs for user ${targetUserId}. Denied.`);
    return { success: false, error: "Authorization denied: Users can only fetch their own time logs." };
  }

  const db = getDb();
  try {
    let sql = "SELECT * FROM time_logs WHERE user_id = ?";
    const params = [targetUserId];

    if (dateRangeStartStr) {
      // Validate date string format if necessary, or let SQLite handle it (it's quite flexible with ISO8601)
      // For stricter validation, _parseDate could be used here, but it throws on error.
      // Assuming dateRangeStartStr and dateRangeEndStr are valid ISO 8601 strings.
      sql += " AND start_time >= ?";
      params.push(dateRangeStartStr);
    }
    if (dateRangeEndStr) {
      sql += " AND start_time <= ?"; // Using start_time to check if it falls within the end of the range
      params.push(dateRangeEndStr);
    }

    sql += " ORDER BY start_time DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params);
    // Return rows directly as the function is expected to return an array of time log objects,
    // not a { success: true, data: rows } wrapper, unless specified.
    // The prompt asks for "Return an array of time log objects."
    return rows;

  } catch (err) {
    console.error(`Error getting time logs for user ${targetUserId} (requested by ${requestingUserId}):`, err.message, err.stack);
    // Instead of returning an array on error, match the error object structure for consistency.
    return { success: false, error: "Failed to retrieve time logs due to a server error." };
  }
}
