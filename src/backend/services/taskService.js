// src/backend/services/taskService.js
const { getDb } = require("../db");
const permissionService = require('./permissionService'); // Added

// --- Basic Task CRUD Operations ---

/**
 * Creates a new task.
 * @param {object} taskData - { description, note_id, block_id, due_date, reminder_at, is_completed, userId }
 * @returns {object} - { success: boolean, task?: object, error?: string }
 */
async function createTask(taskData) { // Made async
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
    const newTaskId = info.lastInsertRowid;
    if (userId && newTaskId) {
        try {
            await permissionService.grantPermission(userId, userId, 'task', newTaskId, 'admin');
            console.log(`Granted admin permission to creator ${userId} for task ${newTaskId}`);
        } catch (permErr) {
            console.error(`Failed to grant admin permission to creator ${userId} for task ${newTaskId}:`, permErr.message);
            // Decide on error handling: proceed or indicate partial failure. For now, log and proceed.
        }
    }
    // Fetch the newly created task.
    const newTask = await getTaskById(newTaskId, userId); // Use await, pass userId for context
    return { success: true, task: newTask };
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
async function getTaskById(id, requestingUserId = null) { // Made async
  const db = getDb();
  const task = db.prepare("SELECT id, description, note_id, block_id, due_date, reminder_at, is_completed, user_id, created_at, updated_at FROM tasks WHERE id = ?").get(id);

  if (!task) {
    return null;
  }

  if (requestingUserId !== null) {
    const isOwner = task.user_id === requestingUserId;
    let hasReadPermission = task.user_id === null; // Public tasks are readable

    if (!isOwner && task.user_id !== null) { // Only check explicit if not owner and task is not public
        hasReadPermission = await permissionService.checkPermission(requestingUserId, 'task', id, 'read');
    }

    if (!isOwner && !hasReadPermission) {
      console.warn(`Access denied for user ${requestingUserId} on task ${id}. Not owner and no read permission.`);
      return null;
    }
  }

  if (task) {
    task.is_completed = !!task.is_completed;
  }
  return task;
}

/**
 * Updates an existing task. user_id is not updatable via this general function.
 * @param {number} id - The ID of the task to update.
 * @param {object} updates - Object containing fields to update (e.g., description, is_completed, due_date).
 * @param {number} requestingUserId - ID of the user making the request.
 * @returns {object} - { success: boolean, error?: string }
 */
async function updateTask(id, updates, requestingUserId) { // Made async
  const db = getDb();

  const taskForPermissionCheck = db.prepare("SELECT user_id FROM tasks WHERE id = ?").get(id);
  if (!taskForPermissionCheck) {
    return { success: false, error: "Task not found." };
  }

  const isOwner = taskForPermissionCheck.user_id === requestingUserId;
  let hasWritePermission = taskForPermissionCheck.user_id === null; // Public tasks are writable

  if (!isOwner && taskForPermissionCheck.user_id !== null) { // Only check explicit if not owner and task is not public
    hasWritePermission = await permissionService.checkPermission(requestingUserId, 'task', id, 'write');
  }

  if (!isOwner && !hasWritePermission) {
    console.error(`Authorization failed: User ${requestingUserId} cannot update task ${id}. Not owner and no write permission.`);
    return { success: false, error: "Permission denied." };
  }

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
async function deleteTask(id, requestingUserId) { // Made async
  const db = getDb();

  const taskForPermissionCheck = db.prepare("SELECT user_id FROM tasks WHERE id = ?").get(id);
  if (!taskForPermissionCheck) {
    return { success: false, error: "Task not found." };
  }

  const isOwner = taskForPermissionCheck.user_id === requestingUserId;
  let hasAdminPermission = taskForPermissionCheck.user_id === null; // Public tasks are deletable

  if (!isOwner && taskForPermissionCheck.user_id !== null) { // Only check explicit if not owner and task is not public
    hasAdminPermission = await permissionService.checkPermission(requestingUserId, 'task', id, 'admin');
  }

  if (!isOwner && !hasAdminPermission) {
    console.error(`Authorization failed: User ${requestingUserId} cannot delete task ${id}. Not owner and no admin permission.`);
    return { success: false, error: "Permission denied." };
  }

  const stmt = db.prepare("DELETE FROM tasks WHERE id = ?");
  try {
    const info = stmt.run(id);
    if (info.changes > 0) {
      // Also remove associated dependencies
      db.prepare("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?").run(id, id);
      await permissionService.revokeAllPermissionsForObject('task', id);
      console.log(`Successfully revoked all permissions for task ${id}.`);
      return { success: true };
    }
    return { success: false, error: "Task found but delete operation failed." };
  } catch (err) {
    console.error(`Error deleting task ${id} for user ${requestingUserId}:`, err.message);
    return { success: false, error: "Failed to delete task." };
  }
}

function getTasksForNote(noteId, requestingUserId = null) {
    const db = getDb();
    let sql = "SELECT id, description, note_id, block_id, due_date, reminder_at, is_completed, user_id, created_at, updated_at FROM tasks WHERE note_id = ?";
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
    let sql = "SELECT id, description, note_id, block_id, due_date, reminder_at, is_completed, user_id, created_at, updated_at FROM tasks WHERE block_id = ?";
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

  // Check permission to modify the primary task
  const taskForPermissionCheck = await getTaskById(taskId, requestingUserId);
  if (!taskForPermissionCheck) { // This also handles the permission check for task1
    return { success: false, error: `Task with ID ${taskId} not found or permission denied.` };
  }
  // Further check if user has write/admin permission on task1 (getTaskById only checks read by default for non-owners)
  const isOwnerTask1 = taskForPermissionCheck.user_id === requestingUserId;
  let hasWritePermissionTask1 = taskForPermissionCheck.user_id === null;
  if(!isOwnerTask1 && taskForPermissionCheck.user_id !== null) {
    hasWritePermissionTask1 = await permissionService.checkPermission(requestingUserId, 'task', taskId, 'write');
  }
  if (!isOwnerTask1 && !hasWritePermissionTask1) {
    return { success: false, error: `Authorization failed: You do not have write permission for task ${taskId}.` };
  }

  const task2Exists = await getTaskById(dependsOnTaskId, null); // Check if dependent task exists (no user context needed for existence check)
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

  // Check permission to modify the primary task
  const taskForPermissionCheck = await getTaskById(taskId, requestingUserId);
  if (!taskForPermissionCheck) { // This also handles the permission check for task1
    return { success: false, error: `Task with ID ${taskId} not found or permission denied.` };
  }
  // Further check if user has write/admin permission on task1
  const isOwnerTask1 = taskForPermissionCheck.user_id === requestingUserId;
  let hasWritePermissionTask1 = taskForPermissionCheck.user_id === null;
  if(!isOwnerTask1 && taskForPermissionCheck.user_id !== null) {
    hasWritePermissionTask1 = await permissionService.checkPermission(requestingUserId, 'task', taskId, 'write');
  }
  if (!isOwnerTask1 && !hasWritePermissionTask1) {
    return { success: false, error: `Authorization failed: You do not have write permission for task ${taskId}.` };
  }
  // No need to check ownership or permission of dependsOnTaskId for removal itself

  try {
    const stmt = db.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?");
    const info = stmt.run(taskId, dependsOnTaskId);
    return { success: true, removed: info.changes > 0 };
  } catch (err) {
    console.error(`Error removing dependency from task ${taskId} to ${dependsOnTaskId} for user ${requestingUserId}:`, err.message);
    return { success: false, error: "Failed to remove task dependency." };
  }
}

async function getTaskPrerequisites(taskId, requestingUserId = null) { // Made async
  const db = getDb();
  // First, check if the main task itself is accessible to the requesting user
  const mainTask = await getTaskById(taskId, requestingUserId); // Use await
  if (!mainTask) {
      console.warn(`getTaskPrerequisites: Main task ${taskId} not found or not accessible by user ${requestingUserId}.`);
      return [];
  }

  const sql = `SELECT t.* FROM tasks t JOIN task_dependencies td ON t.id = td.depends_on_task_id WHERE td.task_id = ? ORDER BY t.created_at ASC`;
  try {
    const prerequisiteTasksRaw = db.prepare(sql).all(taskId);
    const accessiblePrerequisites = [];
    for (const task of prerequisiteTasksRaw) {
        const isOwner = requestingUserId !== null && task.user_id === requestingUserId;
        let hasReadPermission = requestingUserId !== null && task.user_id === null; // Public tasks

        if (requestingUserId !== null && !isOwner && task.user_id !== null) {
            hasReadPermission = await permissionService.checkPermission(requestingUserId, 'task', task.id, 'read');
        } else if (requestingUserId === null && task.user_id !== null) { // Unauthenticated user trying to access private task
             hasReadPermission = false;
        } else if (isOwner) { // Owner always has permission
            hasReadPermission = true;
        }


        if (hasReadPermission) {
            accessiblePrerequisites.push({ ...task, is_completed: !!task.is_completed });
        }
    }
    return accessiblePrerequisites;
  } catch (err) {
    console.error(`Error getting prerequisites for task ${taskId} (user ${requestingUserId}):`, err.message);
    return [];
  }
}

async function getTasksBlockedBy(taskId, requestingUserId = null) {
  const db = getDb();
  // Check if the main task is accessible
  const mainTask = await getTaskById(taskId, requestingUserId); // Use await
  if (!mainTask) {
      console.warn(`getTasksBlockedBy: Main task ${taskId} not found or not accessible by user ${requestingUserId}.`);
      return [];
  }

  const sql = `SELECT t.* FROM tasks t JOIN task_dependencies td ON t.id = td.task_id WHERE td.depends_on_task_id = ? ORDER BY t.created_at ASC`;
  try {
    const blockedTasksRaw = db.prepare(sql).all(taskId);
    const accessibleBlockedTasks = [];
    for (const task of blockedTasksRaw) {
        const isOwner = requestingUserId !== null && task.user_id === requestingUserId;
        let hasReadPermission = requestingUserId !== null && task.user_id === null; // Public tasks

        if (requestingUserId !== null && !isOwner && task.user_id !== null) {
            hasReadPermission = await permissionService.checkPermission(requestingUserId, 'task', task.id, 'read');
        } else if (requestingUserId === null && task.user_id !== null) { // Unauthenticated user trying to access private task
            hasReadPermission = false;
        } else if (isOwner) { // Owner always has permission
            hasReadPermission = true;
        }


        if (hasReadPermission) {
            accessibleBlockedTasks.push({ ...task, is_completed: !!task.is_completed });
        }
    }
    return accessibleBlockedTasks;
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
