// src/backend/services/taskService.js

const { getDb } = require("../db");

/**
 * Creates a new task, optionally linked to a note or block.
 * @param {object} taskData - { description, note_id = null, block_id = null, is_completed = false, due_date = null, reminder_at = null }
 * @returns {object | null} - The created task object or null on failure.
 */
function createTask(taskData) {
  const db = getDb();
  const {
    description,
    note_id = null,
    block_id = null,
    is_completed = false,
    due_date = null,
    reminder_at = null,
  } = taskData;

  if (!description) {
    console.error("Task description cannot be empty.");
    return null;
  }
  // Ensure only one link (note or block) is active, or neither
  if (note_id && block_id) {
      console.error("Task cannot be linked to both a note and a block.");
      return null;
  }

  const stmt = db.prepare(`
    INSERT INTO tasks (note_id, block_id, description, is_completed, due_date, reminder_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  try {
    const info = stmt.run(
      note_id,
      block_id,
      description,
      is_completed ? 1 : 0,
      due_date, // Ensure format is compatible with SQLite (e.g., ISO string)
      reminder_at
    );
    console.log(`Created task with ID: ${info.lastInsertRowid}`);
    return {
        id: info.lastInsertRowid,
        note_id,
        block_id,
        description,
        is_completed,
        due_date,
        reminder_at,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
  } catch (err) {
    console.error("Error creating task:", err.message);
    return null;
  }
}

/**
 * Retrieves a task by its ID.
 * @param {number} id - The ID of the task.
 * @returns {object | null} - The task object or null if not found.
 */
function getTaskById(id) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM tasks WHERE id = ?");
  try {
    const task = stmt.get(id);
    // Convert boolean from 0/1
    if (task) {
        task.is_completed = !!task.is_completed;
    }
    return task || null;
  } catch (err) {
    console.error(`Error getting task ${id}:`, err.message);
    return null;
  }
}

/**
 * Updates an existing task.
 * @param {number} id - The ID of the task to update.
 * @param {object} updateData - Object with fields to update (e.g., { description, is_completed, due_date }).
 * @returns {boolean} - True if update was successful, false otherwise.
 */
function updateTask(id, updateData) {
  const db = getDb();
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updateData)) {
    // Allow updating description, completion status, due date, reminder
    if (["description", "is_completed", "due_date", "reminder_at"].includes(key)) {
      fields.push(`${key} = ?`);
      values.push(key === "is_completed" ? (value ? 1 : 0) : value);
    }
  }

  if (fields.length === 0) {
    console.warn("No valid fields provided for task update.");
    return false;
  }

  const stmt = db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`);
  values.push(id);

  try {
    const info = stmt.run(...values);
    console.log(`Updated task ${id}. Rows affected: ${info.changes}`);
    return info.changes > 0;
  } catch (err) {
    console.error(`Error updating task ${id}:`, err.message);
    return false;
  }
}

/**
 * Deletes a task by its ID.
 * @param {number} id - The ID of the task to delete.
 * @returns {boolean} - True if deletion was successful, false otherwise.
 */
function deleteTask(id) {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM tasks WHERE id = ?");
  try {
    const info = stmt.run(id);
    console.log(`Deleted task ${id}. Rows affected: ${info.changes}`);
    return info.changes > 0;
  } catch (err) {
    console.error(`Error deleting task ${id}:`, err.message);
    return false;
  }
}

/**
 * Retrieves all tasks associated with a specific note.
 * @param {number} noteId
 * @returns {object[]}
 */
function getTasksForNote(noteId) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM tasks WHERE note_id = ? ORDER BY created_at ASC");
  try {
    const tasks = stmt.all(noteId);
    tasks.forEach(task => task.is_completed = !!task.is_completed); // Convert boolean
    return tasks;
  } catch (err) {
    console.error(`Error getting tasks for note ${noteId}:`, err.message);
    return [];
  }
}

/**
 * Retrieves all tasks associated with a specific block.
 * @param {string} blockId
 * @returns {object[]}
 */
function getTasksForBlock(blockId) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM tasks WHERE block_id = ? ORDER BY created_at ASC");
  try {
    const tasks = stmt.all(blockId);
    tasks.forEach(task => task.is_completed = !!task.is_completed); // Convert boolean
    return tasks;
  } catch (err) {
    console.error(`Error getting tasks for block ${blockId}:`, err.message);
    return [];
  }
}

// TODO: Add functions for querying tasks by due date, completion status etc.

module.exports = {
  createTask,
  getTaskById,
  updateTask,
  deleteTask,
  getTasksForNote,
  getTasksForBlock,
};

