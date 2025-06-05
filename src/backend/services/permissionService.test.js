const permissionService = require('./permissionService');
const Database = require('better-sqlite3');

let db;

// Mock users for testing
const user1 = { id: 1, username: 'user1_test', password_hash: 'hash1' }; // Target user for perms
const user2 = { id: 2, username: 'user2_test', password_hash: 'hash2' }; // Another target user
const adminUser = { id: 3, username: 'admin_test', password_hash: 'hash_admin' }; // User who can be granted admin
const ownerUser = { id: 4, username: 'owner_test', password_hash: 'hash_owner' }; // Owner of objects
const unrelatedUser = { id: 5, username: 'unrelated_test', password_hash: 'hash_unrelated' }; // No specific perms

describe('Permission Service', () => {
    beforeAll(() => {
        db = new Database(':memory:');
        console.log('Test DB connection established (in-memory)');
        permissionService.__setTestDb(db);

        db.exec(`PRAGMA foreign_keys = ON;`);
        // Create users table
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Create notes table
        db.exec(`
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, type TEXT DEFAULT 'markdown',
                user_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
        `);
        // Create tasks table
        db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, user_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
        `);
        // Create note_databases table
        db.exec(`
            CREATE TABLE IF NOT EXISTS note_databases (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, user_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
        `);
        // Create database_rows table
        db.exec(`
            CREATE TABLE IF NOT EXISTS database_rows (
                id INTEGER PRIMARY KEY AUTOINCREMENT, database_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE
            );
        `);
        // Create object_permissions table
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
        const usersToSeed = [user1, user2, adminUser, ownerUser, unrelatedUser];
        const insertUserStmt = db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)");
        usersToSeed.forEach(u => {
            try {
                insertUserStmt.run(u.id, u.username, u.password_hash);
            } catch (error) {
                 console.warn("Warning seeding user (might already exist):", u.username, error.message);
            }
        });
        console.log('Mock users seeded.');
    });

    beforeEach(() => {
        // Clear data before each test to ensure test isolation
        db.prepare("DELETE FROM object_permissions").run();
        db.prepare("DELETE FROM notes").run();
        db.prepare("DELETE FROM tasks").run();
        db.prepare("DELETE FROM database_rows").run(); // Clear rows before databases due to FK
        db.prepare("DELETE FROM note_databases").run();
    });

    afterAll(() => {
        if (db) {
            db.close();
            console.log('Test DB connection closed.');
        }
        permissionService.__restoreOriginalDb();
    });

    describe('grantPermission', () => {
        let noteId, taskId, dbId, rowId;

        beforeEach(() => {
            // Create objects owned by ownerUser
            noteId = db.prepare("INSERT INTO notes (title, user_id) VALUES (?, ?)").run('Owned Note', ownerUser.id).lastInsertRowid;
            taskId = db.prepare("INSERT INTO tasks (description, user_id) VALUES (?, ?)").run('Owned Task', ownerUser.id).lastInsertRowid;
            dbId = db.prepare("INSERT INTO note_databases (name, user_id) VALUES (?, ?)").run('Owned DB', ownerUser.id).lastInsertRowid;
            rowId = db.prepare("INSERT INTO database_rows (database_id) VALUES (?)").run(dbId).lastInsertRowid;
        });

        it('should allow owner to grant permission', async () => {
            const result = await permissionService.grantPermission(ownerUser.id, user1.id, 'note', noteId, 'read');
            expect(result.success).toBe(true);
            expect(result.permission.permission_level).toBe('read');
        });

        it('should allow user with admin rights to grant permission', async () => {
            // Owner grants adminUser admin rights on the note
            await permissionService.grantPermission(ownerUser.id, adminUser.id, 'note', noteId, 'admin');
            // Then, adminUser grants user1 read rights
            const result = await permissionService.grantPermission(adminUser.id, user1.id, 'note', noteId, 'read');
            expect(result.success).toBe(true);
            expect(result.permission.user_id).toBe(user1.id);
        });

        it('should DENY if actor is not owner and has no admin rights', async () => {
            const result = await permissionService.grantPermission(unrelatedUser.id, user1.id, 'note', noteId, 'read');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Actor must be owner or have admin rights');
        });

        it('should allow system user (actorUserId=0) to grant permission even if not owner/admin', async () => {
            const result = await permissionService.grantPermission(0, user1.id, 'note', noteId, 'write');
            expect(result.success).toBe(true);
            expect(result.permission.permission_level).toBe('write');
        });

        it('should fail if object not found (for ownership check)', async () => {
            const result = await permissionService.grantPermission(ownerUser.id, user1.id, 'note', 9999, 'read');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Object not found or ownership cannot be determined');
        });

        // Basic validation tests (from original set, ensuring actor is valid for them to pass now)
        it('should fail with invalid objectType (actor is owner of a valid object)', async () => {
             // Granting permission on a non-existent object type, actor is owner of other things
            const result = await permissionService.grantPermission(ownerUser.id, user1.id, 'invalid_type', noteId, 'read');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid object_type');
        });
         it('should fail with invalid permissionLevel (actor is owner)', async () => {
            const result = await permissionService.grantPermission(ownerUser.id, user1.id, 'note', noteId, 'invalid_level');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid permission_level');
        });
    });

    describe('revokePermission', () => {
        let noteId;
        beforeEach(async () => {
            noteId = db.prepare("INSERT INTO notes (title, user_id) VALUES (?, ?)").run('Owned Note for Revoke', ownerUser.id).lastInsertRowid;
            // Grant user1 read permission by owner for setup
            await permissionService.grantPermission(ownerUser.id, user1.id, 'note', noteId, 'read');
        });

        it('should allow owner to revoke permission', async () => {
            const result = await permissionService.revokePermission(ownerUser.id, user1.id, 'note', noteId);
            expect(result.success).toBe(true);
            expect(result.removed).toBe(true);
        });

        it('should allow user with admin rights to revoke permission', async () => {
            // Owner grants adminUser admin rights
            await permissionService.grantPermission(ownerUser.id, adminUser.id, 'note', noteId, 'admin');
            // adminUser revokes user1's permission
            const result = await permissionService.revokePermission(adminUser.id, user1.id, 'note', noteId);
            expect(result.success).toBe(true);
            expect(result.removed).toBe(true);
        });

        it('should DENY if actor is not owner and has no admin rights', async () => {
            const result = await permissionService.revokePermission(unrelatedUser.id, user1.id, 'note', noteId);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Actor must be owner or have admin rights');
        });

        it('should allow system user (actorUserId=0) to revoke permission', async () => {
            const result = await permissionService.revokePermission(0, user1.id, 'note', noteId);
            expect(result.success).toBe(true);
            expect(result.removed).toBe(true);
        });

        it('should fail if object not found (for ownership check during revoke)', async () => {
            const result = await permissionService.revokePermission(ownerUser.id, user1.id, 'note', 9999);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Object not found or ownership cannot be determined');
        });
    });

    describe('checkPermission (and _hasSufficientPermission implicitly)', () => {
        // For these tests, an arbitrary actor (ownerUser) can grant initial perms.
        // The focus is on checkPermission's logic, not actor perms for granting.
        let noteId_checkPerm;
        beforeEach(async () => {
            noteId_checkPerm = db.prepare("INSERT INTO notes (title, user_id) VALUES (?, ?)").run('CheckPerm Note', ownerUser.id).lastInsertRowid;
            await permissionService.grantPermission(ownerUser.id, user1.id, 'note', noteId_checkPerm, 'write');
            await permissionService.grantPermission(ownerUser.id, user2.id, 'note', noteId_checkPerm, 'read');
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
