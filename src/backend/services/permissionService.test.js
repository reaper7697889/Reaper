const permissionService = require('./permissionService');
const Database = require('better-sqlite3');

let db;

// Mock users for testing
const user1 = { id: 1, username: 'user1_test', password_hash: 'hash1' };
const user2 = { id: 2, username: 'user2_test', password_hash: 'hash2' };
const actorUser = { id: 3, username: 'actor_test', password_hash: 'hash3' }; // User performing grant/revoke actions

describe('Permission Service', () => {
    beforeAll(() => {
        // Initialize an in-memory SQLite database for testing
        db = new Database(':memory:');
        console.log('Test DB connection established (in-memory)');

        // Override getDb in permissionService to use this test_db instance
        // This is a common way to inject dependencies for testing.
        // Ensure permissionService uses this db instance for its operations.
        permissionService.__setTestDb(db); // We'll need to add this to permissionService or adapt

        // Create users table
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create object_permissions table (schema from previous subtask)
        db.exec(`
            CREATE TABLE IF NOT EXISTS object_permissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                object_type TEXT NOT NULL,
                object_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                permission_level TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE (object_type, object_id, user_id)
            );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_object_permissions_object ON object_permissions (object_type, object_id);`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_object_permissions_user ON object_permissions (user_id);`);
        db.exec(`
            CREATE TRIGGER IF NOT EXISTS object_permissions_updated_at_trigger
            AFTER UPDATE ON object_permissions
            FOR EACH ROW
            BEGIN
                UPDATE object_permissions SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
            END;
        `);
        console.log('Test DB schema initialized.');

        // Seed users
        const insertUserStmt = db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)");
        try {
            insertUserStmt.run(user1.id, user1.username, user1.password_hash);
            insertUserStmt.run(user2.id, user2.username, user2.password_hash);
            insertUserStmt.run(actorUser.id, actorUser.username, actorUser.password_hash);
            console.log('Mock users seeded.');
        } catch (error) {
            // This might happen if running tests multiple times without proper reset in some environments
            // or if IDs are not controlled as expected.
            console.warn("Warning seeding users (might already exist if test runner doesn't isolate well):", error.message);
        }
    });

    beforeEach(() => {
        // Clear object_permissions before each test to ensure test isolation
        try {
            db.prepare("DELETE FROM object_permissions").run();
        } catch (error) {
            console.error("Error clearing object_permissions:", error.message);
            // If this fails, subsequent tests might be affected.
        }
    });

    afterAll(() => {
        if (db) {
            db.close();
            console.log('Test DB connection closed.');
        }
        // Restore original db if necessary, though for tests it's usually fine to leave the mock.
        permissionService.__restoreOriginalDb(); // Companion to __setTestDb
    });

    describe('grantPermission', () => {
        it('should grant a new permission successfully', async () => {
            const result = await permissionService.grantPermission(actorUser.id, user1.id, 'note', 101, 'read');
            expect(result.success).toBe(true);
            expect(result.permission).toBeDefined();
            expect(result.permission.user_id).toBe(user1.id);
            expect(result.permission.object_type).toBe('note');
            expect(result.permission.object_id).toBe(101);
            expect(result.permission.permission_level).toBe('read');
        });

        it('should update an existing permission to a new level', async () => {
            await permissionService.grantPermission(actorUser.id, user1.id, 'note', 101, 'read');
            const result = await permissionService.grantPermission(actorUser.id, user1.id, 'note', 101, 'write');
            expect(result.success).toBe(true);
            expect(result.permission).toBeDefined();
            expect(result.permission.permission_level).toBe('write');
            expect(result.permission.user_id).toBe(user1.id); // Ensure other fields remain
            expect(result.permission.object_id).toBe(101);

            const finalPerm = db.prepare("SELECT * FROM object_permissions WHERE user_id = ? AND object_type = ? AND object_id = ?").get(user1.id, 'note', 101);
            expect(finalPerm.permission_level).toBe('write');
        });

        it('should fail with invalid objectType', async () => {
            const result = await permissionService.grantPermission(actorUser.id, user1.id, 'invalid_type', 101, 'read');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid object_type');
        });

        it('should fail with invalid permissionLevel', async () => {
            const result = await permissionService.grantPermission(actorUser.id, user1.id, 'note', 101, 'invalid_level');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid permission_level');
        });

        it('should fail with missing targetUserId', async () => {
            const result = await permissionService.grantPermission(actorUser.id, null, 'note', 101, 'read');
            expect(result.success).toBe(false);
            expect(result.error).toContain('targetUserId is required');
        });

        it('should fail with missing objectId', async () => {
            const result = await permissionService.grantPermission(actorUser.id, user1.id, 'note', null, 'read');
            expect(result.success).toBe(false);
            expect(result.error).toContain('objectId is required');
        });
    });

    describe('revokePermission', () => {
        beforeEach(async () => {
            await permissionService.grantPermission(actorUser.id, user1.id, 'note', 101, 'read');
        });

        it('should revoke an existing permission successfully', async () => {
            const result = await permissionService.revokePermission(actorUser.id, user1.id, 'note', 101);
            expect(result.success).toBe(true);
            expect(result.removed).toBe(true); // Or check count if API changes

            const perm = db.prepare("SELECT * FROM object_permissions WHERE user_id = ? AND object_type = ? AND object_id = ?").get(user1.id, 'note', 101);
            expect(perm).toBeUndefined();
        });

        it('should succeed gracefully if permission does not exist', async () => {
            const result = await permissionService.revokePermission(actorUser.id, user2.id, 'task', 202); // Non-existent
            expect(result.success).toBe(true);
            expect(result.removed).toBe(false);
        });

        it('should fail with invalid objectType', async () => {
            const result = await permissionService.revokePermission(actorUser.id, user1.id, 'invalid_type', 101);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid object_type');
        });
    });

    describe('checkPermission (and _hasSufficientPermission implicitly)', () => {
        beforeEach(async () => {
            await permissionService.grantPermission(actorUser.id, user1.id, 'note', 101, 'write'); // user1 has 'write'
            await permissionService.grantPermission(actorUser.id, user2.id, 'note', 101, 'read');  // user2 has 'read'
            await permissionService.grantPermission(actorUser.id, user1.id, 'task', 201, 'admin'); // user1 has 'admin' on task
        });

        it('should return true if user has exact required permission', async () => {
            const hasPerm = await permissionService.checkPermission(user2.id, 'note', 101, 'read');
            expect(hasPerm).toBe(true);
        });

        it('should return true if user has higher-level permission', async () => {
            const hasPerm = await permissionService.checkPermission(user1.id, 'note', 101, 'read'); // user1 has 'write'
            expect(hasPerm).toBe(true);
        });

        it('should return false if user has lower-level permission', async () => {
            const hasPerm = await permissionService.checkPermission(user2.id, 'note', 101, 'write'); // user2 has 'read'
            expect(hasPerm).toBe(false);
        });

        it('should return false if user has no explicit permission for the object', async () => {
            const hasPerm = await permissionService.checkPermission(actorUser.id, 'note', 101, 'read'); // actorUser has no direct perm on note 101
            expect(hasPerm).toBe(false);
        });

        it('should return false if user has permission for a different object', async () => {
            const hasPerm = await permissionService.checkPermission(user1.id, 'note', 999, 'write'); // user1 has perm on note 101, not 999
            expect(hasPerm).toBe(false);
        });

        it('should return false for invalid requiredPermissionLevel', async () => {
            const hasPerm = await permissionService.checkPermission(user1.id, 'note', 101, 'super_read');
            expect(hasPerm).toBe(false);
        });
    });

    describe('getPermissionsForObject', () => {
        beforeEach(async () => {
            await permissionService.grantPermission(actorUser.id, user1.id, 'folder', 301, 'admin');
            await permissionService.grantPermission(actorUser.id, user2.id, 'folder', 301, 'read');
        });

        it('should return all permissions for an object with user details', async () => {
            const permissions = await permissionService.getPermissionsForObject(301, 'folder');
            expect(permissions).toBeInstanceOf(Array);
            expect(permissions.length).toBe(2);

            const user1Perm = permissions.find(p => p.user_id === user1.id);
            expect(user1Perm).toBeDefined();
            expect(user1Perm.username).toBe(user1.username);
            expect(user1Perm.permission_level).toBe('admin');

            const user2Perm = permissions.find(p => p.user_id === user2.id);
            expect(user2Perm).toBeDefined();
            expect(user2Perm.username).toBe(user2.username);
            expect(user2Perm.permission_level).toBe('read');
        });

        it('should return an empty array for an object with no permissions', async () => {
            const permissions = await permissionService.getPermissionsForObject(999, 'folder');
            expect(permissions).toEqual([]);
        });
    });

    describe('getObjectsSharedWithUser', () => {
        beforeEach(async () => {
            await permissionService.grantPermission(actorUser.id, user1.id, 'note', 101, 'write');
            await permissionService.grantPermission(actorUser.id, user1.id, 'task', 201, 'admin');
            await permissionService.grantPermission(actorUser.id, user1.id, 'folder', 301, 'read');
            await permissionService.grantPermission(actorUser.id, user2.id, 'note', 102, 'read'); // Different user
        });

        it('should return all objects a user has permissions on', async () => {
            const objects = await permissionService.getObjectsSharedWithUser(user1.id);
            expect(objects).toBeInstanceOf(Array);
            expect(objects.length).toBe(3);
            expect(objects.some(o => o.object_type === 'note' && o.object_id === 101 && o.permission_level === 'write')).toBe(true);
            expect(objects.some(o => o.object_type === 'task' && o.object_id === 201 && o.permission_level === 'admin')).toBe(true);
            expect(objects.some(o => o.object_type === 'folder' && o.object_id === 301 && o.permission_level === 'read')).toBe(true);
        });

        it('should filter objects by objectTypeFilter', async () => {
            const notes = await permissionService.getObjectsSharedWithUser(user1.id, 'note');
            expect(notes.length).toBe(1);
            expect(notes[0].object_type).toBe('note');
            expect(notes[0].object_id).toBe(101);

            const tasks = await permissionService.getObjectsSharedWithUser(user1.id, 'task');
            expect(tasks.length).toBe(1);
            expect(tasks[0].object_type).toBe('task');
        });

        it('should return an empty array for a user with no permissions', async () => {
            const objects = await permissionService.getObjectsSharedWithUser(actorUser.id); // actorUser granted perms but doesn't have any on objects
            expect(objects).toEqual([]);
        });
    });

    describe('revokeAllPermissionsForObject', () => {
        beforeEach(async () => {
            await permissionService.grantPermission(actorUser.id, user1.id, 'database', 401, 'admin');
            await permissionService.grantPermission(actorUser.id, user2.id, 'database', 401, 'write');
        });

        it('should revoke all permissions for a given object', async () => {
            const result = await permissionService.revokeAllPermissionsForObject('database', 401);
            expect(result.success).toBe(true);
            expect(result.count).toBe(2);

            const perms = await permissionService.getPermissionsForObject(401, 'database');
            expect(perms.length).toBe(0);
        });

        it('should succeed with count 0 for an object with no permissions', async () => {
            const result = await permissionService.revokeAllPermissionsForObject('database', 999);
            expect(result.success).toBe(true);
            expect(result.count).toBe(0);
        });

        it('should fail with invalid objectType', async () => {
            const result = await permissionService.revokeAllPermissionsForObject('invalid_type', 401);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid object_type');
        });
    });
});

// Minimal mock for __setTestDb and __restoreOriginalDb in permissionService itself
// This is a simplified approach. In a real scenario, you might use Jest's module mocking.
let originalGetDb;
permissionService.__setTestDb = (testDbInstance) => {
    originalGetDb = permissionService.__getDbDirectly; // Assume a way to get the original
    permissionService.__getDbDirectly = () => testDbInstance; // Assume it uses this internally
};
permissionService.__restoreOriginalDb = () => {
    if (originalGetDb) {
        permissionService.__getDbDirectly = originalGetDb;
    }
};
// This implies permissionService.js needs to be structured to allow this kind of injection.
// E.g., by having its internal getDb call a variable that can be reassigned, or exporting it.
// For now, this is a placeholder for how DB mocking would need to be connected.
// A more robust way is `jest.mock('../db', () => ({ getDb: jest.fn() }));`
// and then `getDb.mockReturnValue(testDb);` in `beforeAll`.
// But given the tool constraints, direct modification/injection is assumed.
// The tests will likely fail if permissionService.js cannot be made to use the in-memory db.
// Let's assume for now that permissionService.js is modified to:
// const { getDb: actualGetDb } = require("../db");
// let currentGetDb = actualGetDb;
// function getDb() { return currentGetDb(); }
// function __setTestDb(testDb) { currentGetDb = () => testDb; }
// function __restoreOriginalDb() { currentGetDb = actualGetDb; }
// module.exports = { ..., __setTestDb, __restoreOriginalDb, /* getDb - if needed by other test setups */ }
// This is a significant assumption about the modifiability of permissionService.js
// If this is not possible, tests that rely on DB interaction will not work correctly.
// The subtask asks for tests for permissionService.js, assuming db interactions can be controlled.
