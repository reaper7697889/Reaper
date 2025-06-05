const taskService = require('./taskService');
const permissionService = require('./permissionService');
const Database = require('better-sqlite3');

let db;

// Mock users
const ownerUser = { id: 1, username: 'owner_tasks_test', password_hash: 'hash_owner_task' };
const sharedUser = { id: 2, username: 'shared_tasks_test', password_hash: 'hash_shared_task' };
const unrelatedUser = { id: 3, username: 'unrelated_tasks_test', password_hash: 'hash_unrelated_task' };
const actorUser = { id: 4, username: 'actor_tasks_test', password_hash: 'hash_actor_task' }; // General actor

describe('Task Service Integration Tests', () => {
    beforeAll(() => {
        db = new Database(':memory:');
        permissionService.__setTestDb(db); // Inject test DB

        db.exec(`PRAGMA foreign_keys = ON;`);
        // Create users table
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Create tasks table (ensure user_id exists)
        db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, note_id INTEGER, block_id TEXT,
                due_date DATETIME, reminder_at DATETIME, is_completed BOOLEAN DEFAULT 0, user_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
        `);
        // Create object_permissions table
        db.exec(`
            CREATE TABLE IF NOT EXISTS object_permissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL, permission_level TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE (object_type, object_id, user_id)
            );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_object_permissions_object ON object_permissions (object_type, object_id);`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_object_permissions_user ON object_permissions (user_id);`);
        // Create task_dependencies table
        db.exec(`
            CREATE TABLE IF NOT EXISTS task_dependencies (
                id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, depends_on_task_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                UNIQUE (task_id, depends_on_task_id), CHECK (task_id != depends_on_task_id)
            );
        `);

        // Seed users (fixed: ensure all users are seeded here)
        [ownerUser, sharedUser, unrelatedUser, actorUser].forEach(u => {
             try {
                db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)")
                  .run(u.id, u.username, u.password_hash);
            } catch (e) { console.warn("User seeding warning:", e.message); }
        });
    });

    beforeEach(async () => {
        db.prepare("DELETE FROM tasks").run();
        db.prepare("DELETE FROM object_permissions").run();
        db.prepare("DELETE FROM task_dependencies").run();
    });

    afterAll(() => {
        permissionService.__restoreOriginalDb();
        if (db) db.close();
    });

    describe('createTask', () => {
        it('should set creator as owner and grant admin permission', async () => {
            const taskData = { description: 'New Task by Owner', userId: ownerUser.id };
            const result = await taskService.createTask(taskData);

            expect(result.success).toBe(true);
            expect(result.task).toBeDefined();
            const newTaskId = result.task.id;
            expect(newTaskId).toBeGreaterThan(0);

            const task = await taskService.getTaskById(newTaskId, ownerUser.id);
            expect(task).toBeDefined();
            expect(task.user_id).toBe(ownerUser.id);

            const permissions = await permissionService.getPermissionsForObject(newTaskId, 'task');
            expect(permissions.length).toBe(1);
            expect(permissions[0].user_id).toBe(ownerUser.id);
            expect(permissions[0].permission_level).toBe('admin');
        });
    });

    describe('getTaskById', () => {
        let taskId;
        beforeEach(async () => {
            const result = await taskService.createTask({ description: 'Access Test Task', userId: ownerUser.id });
            taskId = result.task.id;
        });

        it('owner can access the task', async () => {
            const task = await taskService.getTaskById(taskId, ownerUser.id);
            expect(task).not.toBeNull();
            expect(task.id).toBe(taskId);
        });

        it('user with explicit read permission can access the task', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'task', taskId, 'read');
            const task = await taskService.getTaskById(taskId, sharedUser.id);
            expect(task).not.toBeNull();
        });

        it('user with explicit write permission can access the task (hierarchy)', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'task', taskId, 'write');
            const task = await taskService.getTaskById(taskId, sharedUser.id);
            expect(task).not.toBeNull();
        });

        it('unrelated user cannot access the task', async () => {
            const task = await taskService.getTaskById(taskId, unrelatedUser.id);
            expect(task).toBeNull();
        });
    });

    describe('updateTask', () => {
        let taskId;
        beforeEach(async () => {
            taskId = (await taskService.createTask({ description: 'Update Task Test', userId: ownerUser.id })).task.id;
        });

        it('owner can update the task', async () => {
            const result = await taskService.updateTask(taskId, { description: 'Updated by Owner' }, ownerUser.id);
            expect(result.success).toBe(true);
            const updatedTask = await taskService.getTaskById(taskId, ownerUser.id);
            expect(updatedTask.description).toBe('Updated by Owner');
        });

        it('user with write permission can update the task', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'task', taskId, 'write');
            const result = await taskService.updateTask(taskId, { description: 'Updated by Shared' }, sharedUser.id);
            expect(result.success).toBe(true);
        });

        it('user with only read permission cannot update the task', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'task', taskId, 'read');
            const result = await taskService.updateTask(taskId, { description: 'Update Fail by ReadOnly' }, sharedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Permission denied');
        });

        it('unrelated user cannot update the task', async () => {
            const result = await taskService.updateTask(taskId, { description: 'Update Fail by Unrelated' }, unrelatedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Permission denied');
        });
    });

    describe('deleteTask', () => {
        let taskId;
        beforeEach(async () => {
            taskId = (await taskService.createTask({ description: 'Delete Task Test', userId: ownerUser.id })).task.id;
        });

        it('unrelated user cannot delete the task', async () => {
            const result = await taskService.deleteTask(taskId, unrelatedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Permission denied');
        });

        it('user with admin permission can delete the task and permissions are revoked', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'task', taskId, 'admin');
            const result = await taskService.deleteTask(taskId, sharedUser.id);
            expect(result.success).toBe(true);

            const task = await taskService.getTaskById(taskId, ownerUser.id);
            expect(task).toBeNull();

            const permissions = await permissionService.getPermissionsForObject(taskId, 'task');
            expect(permissions.length).toBe(0);
        });

        it('owner can delete their own task and permissions are revoked', async () => {
            const result = await taskService.deleteTask(taskId, ownerUser.id);
            expect(result.success).toBe(true);
            const task = await taskService.getTaskById(taskId, ownerUser.id);
            expect(task).toBeNull();
            const permissions = await permissionService.getPermissionsForObject(taskId, 'task');
            expect(permissions.length).toBe(0);
        });
    });

    describe('Task Dependencies', () => {
        let taskA_id, taskB_id, taskC_id;
        beforeEach(async () => {
            taskA_id = (await taskService.createTask({ description: 'Task A', userId: ownerUser.id })).task.id;
            taskB_id = (await taskService.createTask({ description: 'Task B', userId: ownerUser.id })).task.id;
            taskC_id = (await taskService.createTask({ description: 'Task C', userId: sharedUser.id })).task.id; // Task C owned by sharedUser
        });

        it('owner can add dependency between their tasks', async () => {
            const result = await taskService.addTaskDependency(taskA_id, taskB_id, ownerUser.id);
            expect(result.success).toBe(true);
        });

        it('user with write permission on source task can add dependency to any other existing task', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'task', taskA_id, 'write');
            // sharedUser has write on taskA, ownerUser owns taskB
            const result = await taskService.addTaskDependency(taskA_id, taskB_id, sharedUser.id);
            expect(result.success).toBe(true);
        });

        it('user without write permission on source task cannot add dependency', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'task', taskA_id, 'read');
            const result = await taskService.addTaskDependency(taskA_id, taskB_id, sharedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Authorization failed: You do not have write permission for task');
        });

        it('unrelated user cannot add dependency', async () => {
            const result = await taskService.addTaskDependency(taskA_id, taskB_id, unrelatedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Authorization failed: You do not have write permission for task');
        });

        // Similar tests for removeTaskDependency, getTaskPrerequisites, getTasksBlockedBy
        // For getTaskPrerequisites/getTasksBlockedBy, need to check if the filtered list is correct based on read perms.
    });
});
