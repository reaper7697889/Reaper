// src/backend/models/Task.js

class Task {
  /**
   * @param {number | null} id
   * @param {number | null} note_id - ID of the note this task belongs to (if simple note).
   * @param {string | null} block_id - ID of the block this task belongs to (if workspace).
   * @param {string} description - The text content of the task.
   * @param {boolean} is_completed - Whether the task is marked as done.
   * @param {string | null} due_date - ISO timestamp string for the due date.
   * @param {string | null} reminder_at - ISO timestamp string for the reminder.
   * @param {string | null} created_at - ISO timestamp string.
   * @param {string | null} updated_at - ISO timestamp string.
   */
  constructor(
    id = null,
    note_id = null,
    block_id = null,
    description,
    is_completed = false,
    due_date = null,
    reminder_at = null,
    created_at = null,
    updated_at = null
  ) {
    this.id = id;
    this.note_id = note_id;
    this.block_id = block_id;
    this.description = description;
    this.is_completed = is_completed;
    this.due_date = due_date;
    this.reminder_at = reminder_at;
    this.created_at = created_at || new Date().toISOString();
    this.updated_at = updated_at || new Date().toISOString();
  }

  // Static methods for DB interaction (e.g., create, update, findByNoteId) would go here or in a service.
}

module.exports = Task;

