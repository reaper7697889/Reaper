// src/backend/services/taskService.js
const { getDb } = require("../db");
const authService = require('./authService'); // Added for RBAC

// --- Basic Task CRUD Operations ---

/**
 * Creates a new task.
 * @param {object} taskData - { description, note_id, block_id, due_date, reminder_at, is_completed, userId }
 * @returns {object} - { success: boolean, task?: object, error?: string }
 */
async function createTask(taskData) { // Changed to async
  const db = getDb();
  const {
    description,
    note_id = null,
    block_id = null,
    due_date = null,
    reminder_at = null,
    is_completed = 0,
    userId = null, // userId is expected in taskData, defaults to null
    recurrence_rule = null // Added recurrence_rule
  } = taskData;

  if (!description || typeof description !== 'string' || description.trim() === "") {
    return { success: false, error: "Task description is required." };
  }

  // RBAC Check: Viewers cannot create tasks
  if (userId) { // taskData.userId is the requestingUserId effectively for new tasks
    const userCreating = await authService.getUserWithRole(userId);
    if (userCreating && userCreating.role === 'VIEWER') {
        console.error(`User ${userId} (Viewer) attempted to create a task. Denied.`);
        return { success: false, error: "Viewers cannot create tasks." };
    }
  }
  // If no userId, it's a public task or an error depending on policy (current schema allows NULL user_id for tasks)

  const sql = `
    INSERT INTO tasks (description, note_id, block_id, due_date, reminder_at, is_completed, user_id, recurrence_rule, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  try {
    const info = db.prepare(sql).run(
        description.trim(), note_id, block_id,
        due_date, reminder_at, is_completed ? 1 : 0,
        userId, // Pass userId to the SQL execution
        recurrence_rule // Added recurrence_rule
    );
    // Fetch the newly created task. getTaskById selects user_id and recurrence_rule, so it will be included.
    const newTask = getTaskById(info.lastInsertRowid, userId); // Pass userId for auth if needed by getTaskById
    return { success: true, task: newTask }; // Return the full task object including user_id
  } catch (err) {
    console.error("Error creating task:", err.message);
    return { success: false, error: "Failed to create task." };
  }
}

/**
 * Retrieves a single task by its ID.
 * @param {number} id - The ID of the task.
 * @param {number | null} [requestingUserId=null] - Optional ID of the user making the request.
 * @returns {object | null} - The task object (with is_completed as boolean) or null if not found or not authorized.
 */
function getTaskById(id, requestingUserId = null) {
  const db = getDb();
  let sql = "SELECT id, description, note_id, block_id, due_date, reminder_at, is_completed, user_id, recurrence_rule, created_at, updated_at FROM tasks WHERE id = ?";
  const params = [id];

  if (requestingUserId !== null) {
    sql += " AND (user_id = ? OR user_id IS NULL)";
    params.push(requestingUserId);
  }

  try {
    const task = db.prepare(sql).get(...params);
    if (task) {
      task.is_completed = !!task.is_completed;
    }
    return task || null;
  } catch (err) {
    console.error(`Error getting task ${id} for user ${requestingUserId}:`, err.message);
    return null;
  }
}

/**
 * Updates an existing task. user_id is not updatable via this general function.
 * @param {number} id - The ID of the task to update.
 * @param {object} updates - Object containing fields to update (e.g., description, is_completed, due_date).
 * @param {number} requestingUserId - ID of the user making the request.
 * @returns {object} - { success: boolean, error?: string }
 */
function updateTask(id, updates, requestingUserId) {
  const db = getDb();

  const taskFound = getTaskById(id, null); // Unfiltered fetch for ownership check
  if (!taskFound) {
    return { success: false, error: "Task not found." };
  }
  if (taskFound.user_id !== null && taskFound.user_id !== requestingUserId) {
    return { success: false, error: "Authorization failed: You do not own this task." };
  }

  const allowedFields = ["description", "is_completed", "due_date", "reminder_at", "note_id", "block_id", "recurrence_rule"];
  const fieldsToSet = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fieldsToSet.push(`${key} = ?`);
      values.push(key === "is_completed" ? (value ? 1 : 0) : value);
    }
  }

  if (fieldsToSet.length === 0) {
    // No actual change, but ownership was verified, so consider it success.
    return { success: true, message: "No effective changes to task fields." };
  }

  fieldsToSet.push("updated_at = CURRENT_TIMESTAMP");
  const sql = `UPDATE tasks SET ${fieldsToSet.join(", ")} WHERE id = ?`;
  values.push(id); // For the WHERE id = ?

  try {
    const info = db.prepare(sql).run(...values);
    return { success: info.changes > 0 };
  } catch (err) {
    console.error(`Error updating task ${id} for user ${requestingUserId}:`, err.message);
    return { success: false, error: "Failed to update task." };
  }
}

/**
 * Deletes a task.
 * @param {number} id - The ID of the task to delete.
 * @param {number} requestingUserId - ID of the user making the request.
 * @returns {object} - { success: boolean, error?: string }
 */
async function deleteTask(id, requestingUserId) { // Changed to async
  const db = getDb();

  // Fetch task with any user context initially to check its existence and actual owner
  const taskToDelete = await getTaskById(id, null); // Using existing getTaskById which is now aware of user_id filtering
                                                    // but for delete, we need to fetch even if not directly owned to check for ADMIN override.
                                                    // A getTaskByIdInternal or similar that bypasses user check might be better.
                                                    // For now, assume getTaskById(id, null) gets it if it exists.

  if (!taskToDelete) {
    return { success: false, error: "Task not found." };
  }

  let canDelete = false;
  const isOwner = (taskToDelete.user_id === requestingUserId);

  if (isOwner) {
    canDelete = true;
  } else if (taskToDelete.user_id === null) { // Public task
    const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
    if (isAdmin) {
      canDelete = true;
    } else {
      return { success: false, error: "Authorization failed: Only ADMIN can delete public tasks." };
    }
  } else { // Task has an owner, and it's not the requestingUser
    const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
    if (isAdmin) {
      canDelete = true; // Admin can delete other users' tasks
    }
  }

  if (!canDelete) {
    return { success: false, error: `Authorization failed: User ${requestingUserId} cannot delete task ${id}.` };
  }

  // For soft delete, this would be an UPDATE. For hard delete, it's DELETE.
  // Current implementation is hard delete.
  const stmt = db.prepare("DELETE FROM tasks WHERE id = ?");
  try {
    const info = stmt.run(id);
    if (info.changes > 0) {
      // Also remove associated dependencies
      db.prepare("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?").run(id, id);
      return { success: true };
    }
    return { success: false, error: "Task found but delete operation failed."};
  } catch (err) {
    console.error(`Error deleting task ${id} for user ${requestingUserId}:`, err.message);
    return { success: false, error: "Failed to delete task." };
  }
}

function getTasksForNote(noteId, requestingUserId = null) {
    const db = getDb();
    let sql = "SELECT id, description, note_id, block_id, due_date, reminder_at, is_completed, user_id, recurrence_rule, created_at, updated_at FROM tasks WHERE note_id = ?";
    const params = [noteId];

    if (requestingUserId !== null) {
        sql += " AND (user_id = ? OR user_id IS NULL)";
        params.push(requestingUserId);
    }
    sql += " ORDER BY created_at ASC";

    try {
        return db.prepare(sql).all(...params).map(task => ({...task, is_completed: !!task.is_completed}));
    } catch (err) {
        console.error(`Error listing tasks for note ${noteId} (user ${requestingUserId}):`, err.message);
        return [];
    }
}

function getTasksForBlock(blockId, requestingUserId = null) {
    const db = getDb();
    let sql = "SELECT id, description, note_id, block_id, due_date, reminder_at, is_completed, user_id, recurrence_rule, created_at, updated_at FROM tasks WHERE block_id = ?";
    const params = [blockId];

    if (requestingUserId !== null) {
        sql += " AND (user_id = ? OR user_id IS NULL)";
        params.push(requestingUserId);
    }
    sql += " ORDER BY created_at ASC";

    try {
        return db.prepare(sql).all(...params).map(task => ({...task, is_completed: !!task.is_completed}));
    } catch (err) {
        console.error(`Error listing tasks for block ${blockId} (user ${requestingUserId}):`, err.message);
        return [];
    }
}

// --- Task Dependency Management Functions ---

async function addTaskDependency(taskId, dependsOnTaskId, requestingUserId) {
  if (taskId === dependsOnTaskId) {
    return { success: false, error: "Task cannot depend on itself." };
  }
  const db = getDb();

  const task1 = getTaskById(taskId, null); // Unfiltered fetch for ownership check
  if (!task1) {
    return { success: false, error: `Task with ID ${taskId} not found.` };
  }
  if (task1.user_id !== null && task1.user_id !== requestingUserId) {
    return { success: false, error: `Authorization failed: You do not own task ${taskId}.` };
  }

  const task2Exists = getTaskById(dependsOnTaskId, null); // Check if dependent task exists (no ownership check needed for it)
  if (!task2Exists) {
    return { success: false, error: `Task with ID ${dependsOnTaskId} (to depend on) not found.` };
  }

  try {
    const stmt = db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)");
    const info = stmt.run(taskId, dependsOnTaskId);
    return {
      success: true,
      dependency: { id: info.lastInsertRowid, task_id: taskId, depends_on_task_id: dependsOnTaskId }
    };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return { success: true, alreadyExists: true, message: "Dependency already exists." }; // Or success:false if preferred
    if (err.code === 'SQLITE_CONSTRAINT_CHECK') return { success: false, error: "Task cannot depend on itself (CHECK constraint failed)." };
    console.error(`Error adding dependency from task ${taskId} to ${dependsOnTaskId} for user ${requestingUserId}:`, err.message);
    return { success: false, error: "Failed to add task dependency." };
  }
}

async function removeTaskDependency(taskId, dependsOnTaskId, requestingUserId) {
  const db = getDb();

  const task1 = getTaskById(taskId, null); // Unfiltered fetch for ownership check
  if (!task1) {
    return { success: false, error: `Task with ID ${taskId} not found.` };
  }
  if (task1.user_id !== null && task1.user_id !== requestingUserId) {
    return { success: false, error: `Authorization failed: You do not own task ${taskId}.` };
  }
  // No need to check ownership of dependsOnTaskId for removal

  try {
    const stmt = db.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?");
    const info = stmt.run(taskId, dependsOnTaskId);
    return { success: true, removed: info.changes > 0 };
  } catch (err) {
    console.error(`Error removing dependency from task ${taskId} to ${dependsOnTaskId} for user ${requestingUserId}:`, err.message);
    return { success: false, error: "Failed to remove task dependency." };
  }
}

async function getTaskPrerequisites(taskId, requestingUserId = null) {
  const db = getDb();
  // First, check if the main task itself is accessible to the requesting user
  const mainTask = getTaskById(taskId, requestingUserId);
  if (!mainTask) {
      // This means either the task doesn't exist or the user cannot access it.
      // Depending on desired behavior, could be an empty array or an error.
      // For consistency with "return null or empty array if auth fails", return empty array.
      console.warn(`getTaskPrerequisites: Main task ${taskId} not found or not accessible by user ${requestingUserId}.`);
      return [];
  }

  // t.* will include recurrence_rule if the table schema is updated before this query runs.
  const sql = `SELECT t.* FROM tasks t JOIN task_dependencies td ON t.id = td.depends_on_task_id WHERE td.task_id = ? ORDER BY t.created_at ASC`;
  try {
    let rows = db.prepare(sql).all(taskId);
    if (requestingUserId !== null) {
      // Filter prerequisites based on the requesting user's ownership or if they are public (user_id IS NULL)
      rows = rows.filter(r => r.user_id === requestingUserId || r.user_id === null);
    }
    return rows.map(task => ({ ...task, is_completed: !!task.is_completed }));
  } catch (err) {
    console.error(`Error getting prerequisites for task ${taskId} (user ${requestingUserId}):`, err.message);
    return [];
  }
}

async function getTasksBlockedBy(taskId, requestingUserId = null) {
  const db = getDb();
  // Check if the main task is accessible
  const mainTask = getTaskById(taskId, requestingUserId);
  if (!mainTask) {
      console.warn(`getTasksBlockedBy: Main task ${taskId} not found or not accessible by user ${requestingUserId}.`);
      return [];
  }

  // t.* will include recurrence_rule if the table schema is updated before this query runs.
  const sql = `SELECT t.* FROM tasks t JOIN task_dependencies td ON t.id = td.task_id WHERE td.depends_on_task_id = ? ORDER BY t.created_at ASC`;
  try {
    let rows = db.prepare(sql).all(taskId);
    if (requestingUserId !== null) {
      rows = rows.filter(r => r.user_id === requestingUserId || r.user_id === null);
    }
    return rows.map(task => ({ ...task, is_completed: !!task.is_completed }));
  } catch (err) {
    console.error(`Error getting tasks blocked by task ${taskId} (user ${requestingUserId}):`, err.message);
    return [];
  }
}

module.exports = {
  createTask, getTaskById, updateTask, deleteTask,
  getTasksForNote, getTasksForBlock,
  addTaskDependency, removeTaskDependency, getTaskPrerequisites, getTasksBlockedBy,
};
