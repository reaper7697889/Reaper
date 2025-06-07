// src/backend/services/taskService.js

const { getDb } = require("../db");
const noteService = require('./noteService');
const databaseRowService = require('./databaseRowService');
// const blockService = require('./blockService'); // If it exists and is needed
const authService = require('./authService'); // For ADMIN check

/**
 * Creates a new task, optionally linked to a note or block.
 * @param {object} taskData - { description, note_id = null, block_id = null, project_row_id = null, is_completed = false, due_date = null, reminder_at = null, userId: requestingUserId }
 * @returns {object | null} - The created task object or null on failure.
 */
async function createTask(taskData) { // Changed to async
  const db = getDb();
  const {
    description,
    note_id = null,
    block_id = null, // block_id validation skipped for now
    project_row_id = null,
    is_completed = false,
    due_date = null,
    reminder_at = null,
    userId: requestingUserId = null, // Renamed for clarity and used as task's user_id
  } = taskData;

  if (!requestingUserId) {
    return { success: false, error: "User context (requestingUserId) is required to create a task." };
  }

  if (!description) {
    return { success: false, error: "Task description cannot be empty." };
  }

  if (note_id && (block_id || project_row_id) || block_id && project_row_id) {
      return { success: false, error: "Task can only be linked to one parent (note, block, or project row)." };
  }

  // Validate note_id
  if (note_id) {
    const note = await noteService.getNoteById(note_id, requestingUserId);
    if (!note) {
      return { success: false, error: "Associated note not found or not accessible." };
    }
  }

  // Validate project_row_id
  if (project_row_id) {
    const row = await databaseRowService.getRow(project_row_id, requestingUserId);
    if (!row) {
      return { success: false, error: "Associated project row not found or not accessible." };
    }
  }

  // block_id validation would go here if blockService was available and integrated

  const stmt = db.prepare(`
    INSERT INTO tasks (note_id, block_id, project_row_id, description, is_completed, due_date, reminder_at, user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  try {
    const info = stmt.run(
      note_id,
      block_id,
      project_row_id,
      description,
      is_completed ? 1 : 0,
      due_date,
      reminder_at,
      requestingUserId // Assigning the task to the requesting user
    );
    // Fetch the created task to return it completely
    const createdTask = getTaskById(info.lastInsertRowid, requestingUserId); // Pass requestingUserId if getTaskById needs it for auth
    return { success: true, task: createdTask };
  } catch (err) {
    console.error("Error creating task:", err.message);
    // Consider more specific error messages based on err.code if needed
    return null;
  }
}

/**
 * Retrieves a task by its ID.
 * @param {number} id - The ID of the task.
 * @param {number|null} requestingUserId - Optional: for permission checks if tasks are not public.
 * @returns {object | null} - The task object or null if not found/accessible.
 */
function getTaskById(id, requestingUserId = null) { // Added requestingUserId
  const db = getDb();
  // Include user_id in select if it's not there, for permission checks. Assuming it is.
  const stmt = db.prepare("SELECT * FROM tasks WHERE id = ?");
  try {
    const task = stmt.get(id);
    if (task) {
        task.is_completed = !!task.is_completed;
        // Basic permission: if task has a user_id, it must match requestingUserId, unless requestingUser is admin or task is public (user_id IS NULL)
        // This is a simple check. More complex scenarios might involve checking parent entity permissions.
        if (requestingUserId !== null && task.user_id !== null && task.user_id !== requestingUserId) {
            // Consider if ADMINs can bypass this. For now, strict ownership or public.
            // const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN'); if (isAdmin) return task;
            console.warn(`User ${requestingUserId} attempted to access task ${id} owned by user ${task.user_id}.`);
            return null; // Not found or not accessible
        }
    }
    return task || null;
  } catch (err) {
    console.error(`Error getting task ${id}:`, err.message);
    // For security, don't leak error details unless it's a "not found" type of error.
    return null;
  }
}

/**
 * Updates an existing task.
 * @param {number} id - The ID of the task to update.
 * @param {object} updates - Object with fields to update (e.g., { description, is_completed, due_date }).
 * @param {number} requestingUserId - The ID of the user requesting the update.
 * @returns {Promise<object>} - { success: boolean, error?: string }
 */
async function updateTask(id, updates, requestingUserId) { // Changed to async
  const db = getDb();

  if (!requestingUserId) {
    return { success: false, error: "User context (requestingUserId) is required to update a task." };
  }

  const taskFound = await getTaskById(id, null); // Fetch task without user filtering for initial check
  if (!taskFound) {
    return { success: false, error: "Task not found." };
  }

  // Permission check
  if (taskFound.user_id === null) { // Public task
    const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
    if (!isAdmin) {
      return { success: false, error: "Authorization failed: Only an ADMIN can update public tasks." };
    }
  } else if (taskFound.user_id !== requestingUserId) {
    // const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN'); // Optional: Allow admin to edit any task
    // if (!isAdmin) return { success: false, error: "Authorization failed: You do not own this task." };
    return { success: false, error: "Authorization failed: You do not own this task." };
  }

  const fields = [];
  const values = [];

  // Foreign key validation for note_id, project_row_id if they are being changed
  if (updates.note_id !== undefined) {
    if (updates.note_id === null) {
        fields.push(`note_id = ?`); values.push(null);
    } else {
        const note = await noteService.getNoteById(updates.note_id, requestingUserId);
        if (!note) return { success: false, error: "Updated note_id not found or not accessible." };
        fields.push(`note_id = ?`); values.push(updates.note_id);
    }
  }
  if (updates.project_row_id !== undefined) {
     if (updates.project_row_id === null) {
        fields.push(`project_row_id = ?`); values.push(null);
    } else {
        const row = await databaseRowService.getRow(updates.project_row_id, requestingUserId);
        if (!row) return { success: false, error: "Updated project_row_id not found or not accessible." };
        fields.push(`project_row_id = ?`); values.push(updates.project_row_id);
    }
  }
  // block_id validation would go here

  for (const [key, value] of Object.entries(updates)) {
    if (["description", "is_completed", "due_date", "reminder_at", "recurrence_rule"].includes(key)) { // Added recurrence_rule
      // Avoid re-adding note_id/project_row_id if already handled
      if (key === 'note_id' && updates.note_id !== undefined) continue;
      if (key === 'project_row_id' && updates.project_row_id !== undefined) continue;

      fields.push(`${key} = ?`);
      values.push(key === "is_completed" ? (value ? 1 : 0) : value);
    }
  }

  if (fields.length === 0) {
    return { success: true, message: "No updatable fields provided." }; // No error, but no change
  }

  fields.push("updated_at = CURRENT_TIMESTAMP"); // Always update timestamp

  const stmt = db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`);
  values.push(id);

  try {
    const info = stmt.run(...values);
    if (info.changes > 0) {
        return { success: true, task: await getTaskById(id, requestingUserId) };
    }
    return { success: false, error: "Task not found or no changes made." }; // Should be caught by taskFound earlier
  } catch (err) {
    console.error(`Error updating task ${id}:`, err.message);
    return { success: false, error: err.message || "Failed to update task." };
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

