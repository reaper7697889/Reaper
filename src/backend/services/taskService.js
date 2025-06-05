// src/backend/services/taskService.js
const { getDb } = require("../db");

// --- Basic Task CRUD Operations ---

/**
 * Creates a new task.
 * @param {object} taskData - { description, note_id, block_id, due_date, reminder_at, is_completed, userId }
 * @returns {object} - { success: boolean, task?: object, error?: string }
 */
function createTask(taskData) {
  const db = getDb();
  const {
    description,
    note_id = null,
    block_id = null,
    due_date = null,
    reminder_at = null,
    is_completed = 0,
    userId = null // userId is expected in taskData, defaults to null
  } = taskData;

  if (!description || typeof description !== 'string' || description.trim() === "") {
    return { success: false, error: "Task description is required." };
  }

  const sql = `
    INSERT INTO tasks (description, note_id, block_id, due_date, reminder_at, is_completed, user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  try {
    const info = db.prepare(sql).run(
        description.trim(), note_id, block_id,
        due_date, reminder_at, is_completed ? 1 : 0,
        userId // Pass userId to the SQL execution
    );
    // Fetch the newly created task. getTaskById selects user_id, so it will be included.
    const newTask = getTaskById(info.lastInsertRowid);
    return { success: true, task: newTask }; // Return the full task object including user_id
  } catch (err) {
    console.error("Error creating task:", err.message);
    return { success: false, error: "Failed to create task." };
  }
}

/**
 * Retrieves a single task by its ID.
 * @param {number} id - The ID of the task.
 * @returns {object | null} - The task object (with is_completed as boolean) or null if not found.
 */
function getTaskById(id) {
  const db = getDb();
  // Ensure all relevant fields, including user_id, are selected
  const stmt = db.prepare("SELECT id, description, note_id, block_id, due_date, reminder_at, is_completed, user_id, created_at, updated_at FROM tasks WHERE id = ?");
  try {
    const task = stmt.get(id);
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
 * Updates an existing task. user_id is not updatable via this general function.
 * @param {number} id - The ID of the task to update.
 * @param {object} updates - Object containing fields to update (e.g., description, is_completed, due_date).
 * @returns {object} - { success: boolean, error?: string }
 */
function updateTask(id, updates) {
  const db = getDb();
  // user_id is not included in allowedFields for general update
  const allowedFields = ["description", "is_completed", "due_date", "reminder_at", "note_id", "block_id"];
  const fieldsToSet = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fieldsToSet.push(`${key} = ?`);
      values.push(key === "is_completed" ? (value ? 1 : 0) : value);
    }
  }

  if (fieldsToSet.length === 0) {
    return { success: false, error: "No valid fields provided for update." };
  }

  fieldsToSet.push("updated_at = CURRENT_TIMESTAMP");
  const sql = `UPDATE tasks SET ${fieldsToSet.join(", ")} WHERE id = ?`;
  values.push(id);

  try {
    const info = db.prepare(sql).run(...values);
    return { success: info.changes > 0 };
  } catch (err) {
    console.error(`Error updating task ${id}:`, err.message);
    return { success: false, error: "Failed to update task." };
  }
}

function deleteTask(id) {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM tasks WHERE id = ?");
  try {
    const info = stmt.run(id);
    return { success: info.changes > 0 };
  } catch (err) {
    console.error(`Error deleting task ${id}:`, err.message);
    return { success: false, error: "Failed to delete task." };
  }
}

function getTasksForNote(noteId) {
    const db = getDb();
    // Ensure user_id is selected
    const stmt = db.prepare("SELECT id, description, note_id, block_id, due_date, reminder_at, is_completed, user_id, created_at, updated_at FROM tasks WHERE note_id = ? ORDER BY created_at ASC");
    try {
        return stmt.all(noteId).map(task => ({...task, is_completed: !!task.is_completed}));
    } catch (err) {
        console.error(`Error listing tasks for note ${noteId}:`, err.message);
        return [];
    }
}

function getTasksForBlock(blockId) {
    const db = getDb();
    // Ensure user_id is selected
    const stmt = db.prepare("SELECT id, description, note_id, block_id, due_date, reminder_at, is_completed, user_id, created_at, updated_at FROM tasks WHERE block_id = ? ORDER BY created_at ASC");
    try {
        return stmt.all(blockId).map(task => ({...task, is_completed: !!task.is_completed}));
    } catch (err) {
        console.error(`Error listing tasks for block ${blockId}:`, err.message);
        return [];
    }
}

// --- Task Dependency Management Functions ---
// These functions use SELECT t.* which will include user_id if present in tasks table.

async function addTaskDependency(taskId, dependsOnTaskId) {
  if (taskId === dependsOnTaskId) {
    return { success: false, error: "Task cannot depend on itself." };
  }
  const db = getDb();
  try {
    // getTaskById is synchronous
    const task1Exists = getTaskById(taskId);
    const task2Exists = getTaskById(dependsOnTaskId);
    if (!task1Exists || !task2Exists) {
      return { success: false, error: "One or both task IDs not found." };
    }

    const stmt = db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)");
    const info = stmt.run(taskId, dependsOnTaskId);
    return {
      success: true,
      dependency: { id: info.lastInsertRowid, task_id: taskId, depends_on_task_id: dependsOnTaskId }
    };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return { success: true, alreadyExists: true, message: "Dependency already exists." };
    if (err.code === 'SQLITE_CONSTRAINT_CHECK') return { success: false, error: "Task cannot depend on itself (CHECK constraint failed)." };
    console.error(`Error adding dependency from task ${taskId} to ${dependsOnTaskId}:`, err.message);
    return { success: false, error: "Failed to add task dependency." };
  }
}

async function removeTaskDependency(taskId, dependsOnTaskId) {
  const db = getDb();
  try {
    const stmt = db.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?");
    const info = stmt.run(taskId, dependsOnTaskId);
    return { success: true, removed: info.changes > 0 };
  } catch (err) {
    console.error(`Error removing dependency from task ${taskId} to ${dependsOnTaskId}:`, err.message);
    return { success: false, error: "Failed to remove task dependency." };
  }
}

async function getTaskPrerequisites(taskId) {
  const db = getDb();
  const sql = `SELECT t.* FROM tasks t JOIN task_dependencies td ON t.id = td.depends_on_task_id WHERE td.task_id = ? ORDER BY t.created_at ASC`;
  try {
    const rows = db.prepare(sql).all(taskId);
    return rows.map(task => ({ ...task, is_completed: !!task.is_completed }));
  } catch (err) {
    console.error(`Error getting prerequisites for task ${taskId}:`, err.message);
    return [];
  }
}

async function getTasksBlockedBy(taskId) {
  const db = getDb();
  const sql = `SELECT t.* FROM tasks t JOIN task_dependencies td ON t.id = td.task_id WHERE td.depends_on_task_id = ? ORDER BY t.created_at ASC`;
  try {
    const rows = db.prepare(sql).all(taskId);
    return rows.map(task => ({ ...task, is_completed: !!task.is_completed }));
  } catch (err) {
    console.error(`Error getting tasks blocked by task ${taskId}:`, err.message);
    return [];
  }
}

module.exports = {
  createTask, getTaskById, updateTask, deleteTask,
  getTasksForNote, getTasksForBlock,
  addTaskDependency, removeTaskDependency, getTaskPrerequisites, getTasksBlockedBy,
};
