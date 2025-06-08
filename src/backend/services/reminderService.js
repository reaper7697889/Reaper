// src/backend/services/reminderService.js
const { getDb } = require('../../../db'); // Adjusted path
const noteService = require('./noteService'); // For marking reminder as triggered (updating note)

/**
 * Checks for pending reminders for a given user.
 * A reminder is pending if its reminder_at is not null and is in the past or present.
 * @param {number} userId - The ID of the user.
 * @returns {Promise<Array<object>>} - A promise that resolves to an array of notes with pending reminders.
 *                                      Each object contains { noteId, title, reminder_at }.
 */
async function checkPendingReminders(userId) {
  if (!userId) {
    // console.log("[reminderService] No userId provided, skipping reminder check.");
    return [];
  }
  const db = getDb();
  // Get current timestamp in YYYY-MM-DD HH:MM:SS format suitable for SQLite comparison
  // SQLite's CURRENT_TIMESTAMP is in UTC. Ensure reminder_at is also stored/compared in UTC.
  // For simplicity, we assume reminder_at is stored in a way that direct comparison works.
  // If reminder_at is stored in local time, conversion or timezone handling would be needed.
  // Let's assume reminder_at is UTC for now.
  const sql = `
    SELECT
      id AS noteId,
      title,
      reminder_at
    FROM notes
    WHERE
      user_id = ?
      AND reminder_at IS NOT NULL
      AND reminder_at <= CURRENT_TIMESTAMP
      AND deleted_at IS NULL
      AND is_archived = 0;
  `;
  // Only fetch non-deleted, non-archived notes for reminders.

  try {
    const pendingReminders = db.prepare(sql).all(userId);
    // console.log(`[reminderService] Found ${pendingReminders.length} pending reminders for user ${userId}.`);
    return pendingReminders;
  } catch (error) {
    console.error(`[reminderService] Error fetching pending reminders for user ${userId}:`, error);
    return [];
  }
}

/**
 * Marks a reminder as triggered for a given note by setting its reminder_at to NULL.
 * (MVP strategy for one-time reminders)
 * @param {number} noteId - The ID of the note for which to mark the reminder as triggered.
 * @param {number} requestingUserId - The ID of the user (for permission check before update).
 * @returns {Promise<object>} - Result from noteService.updateNote, e.g., { success: boolean, error?: string }
 */
async function markReminderAsTriggered(noteId, requestingUserId) {
  if (!noteId || !requestingUserId) {
    console.error("[reminderService] noteId and requestingUserId are required to mark reminder as triggered.");
    return { success: false, error: "noteId and requestingUserId are required." };
  }
  try {
    // console.log(`[reminderService] Marking reminder as triggered for note ${noteId} by user ${requestingUserId}.`);
    // Use noteService.updateNote to ensure history is maintained and permissions are checked.
    // Pass requestingUserId for the permission check within updateNote.
    const result = await noteService.updateNote(noteId, { reminder_at: null }, requestingUserId);
    return result;
  } catch (error) {
    console.error(`[reminderService] Error marking reminder as triggered for note ${noteId}:`, error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  checkPendingReminders,
  markReminderAsTriggered,
};
