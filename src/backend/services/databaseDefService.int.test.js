const databaseDefService = require('./databaseDefService');
const permissionService = require('./permissionService');
const Database = require('better-sqlite3');

let db;

// Mock users
const ownerUser = { id: 1, username: 'owner_dbdef_test', password_hash: 'hash_owner' };
const sharedUser = { id: 2, username: 'shared_dbdef_test', password_hash: 'hash_shared' };
const dbAdminUser = { id: 3, username: 'db_admin_dbdef_test', password_hash: 'hash_db_admin' };
const unrelatedUser = { id: 4, username: 'unrelated_dbdef_test', password_hash: 'hash_unrelated' };
const actorUser = { id: 5, username: 'actor_dbdef_test', password_hash: 'hash_actor' }; // For granting perms if owner is not acting

describe('Database Definition Service Integration Tests', () => {
    beforeAll(() => {
        db = new Database(':memory:');
        permissionService.__setTestDb(db);
        // Assuming databaseDefService uses the same getDb via module or needs its own __setTestDb
        // For now, hoping it picks up the mocked one via permissionService or a global mock on `../db`

        db.exec(`PRAGMA foreign_keys = ON;`);
        // Create users table
        db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);`);
        // Create notes table (as note_databases can be linked to notes)
        db.exec(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, title TEXT, FOREIGN KEY (user_id) REFERENCES users(id));`);
        // Create note_databases table
        db.exec(`CREATE TABLE IF NOT EXISTS note_databases (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, user_id INTEGER, note_id INTEGER, is_calendar INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (note_id) REFERENCES notes(id));`);
        // Create database_columns table
        db.exec(`CREATE TABLE IF NOT EXISTS database_columns (id INTEGER PRIMARY KEY AUTOINCREMENT, database_id INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, column_order INTEGER, default_value TEXT, select_options TEXT, linked_database_id INTEGER, relation_target_entity_type TEXT, inverse_column_id INTEGER, formula_definition TEXT, formula_result_type TEXT, rollup_source_relation_column_id INTEGER, rollup_target_column_id INTEGER, rollup_function TEXT, lookup_source_relation_column_id INTEGER, lookup_target_value_column_id TEXT, lookup_multiple_behavior TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE);`);
        // Create database_rows table
        db.exec(`CREATE TABLE IF NOT EXISTS database_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, database_id INTEGER NOT NULL, row_order INTEGER, recurrence_rule TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE);`);
        // Create object_permissions table
        db.exec(`CREATE TABLE IF NOT EXISTS object_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id INTEGER NOT NULL, user_id INTEGER NOT NULL, permission_level TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, UNIQUE (object_type, object_id, user_id));`);

        [ownerUser, sharedUser, dbAdminUser, unrelatedUser, actorUser].forEach(u => {
            try { db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(u.id, u.username, u.password_hash); } catch (e) {}
        });
    });

    beforeEach(async () => {
        db.prepare("DELETE FROM database_columns").run();
        db.prepare("DELETE FROM database_rows").run();
        db.prepare("DELETE FROM note_databases").run();
        db.prepare("DELETE FROM object_permissions").run();
    });

    afterAll(() => {
        permissionService.__restoreOriginalDb();
        if (db) db.close();
    });

    describe('createDatabase', () => {
        it('should set creator as owner and grant admin permission', async () => {
            const result = await databaseDefService.createDatabase({ name: 'Owned DB', userId: ownerUser.id });
            expect(result.success).toBe(true);
            const dbId = result.database.id;

            const dbData = await databaseDefService.getDatabaseById(dbId, ownerUser.id);
            expect(dbData.user_id).toBe(ownerUser.id);

            const permissions = await permissionService.getPermissionsForObject(dbId, 'database');
            expect(permissions.length).toBe(1);
            expect(permissions[0].user_id).toBe(ownerUser.id);
            expect(permissions[0].permission_level).toBe('admin');
        });
    });

    describe('getDatabaseById', () => {
        let dbId;
        beforeEach(async () => {
            dbId = (await databaseDefService.createDatabase({ name: 'Test DB', userId: ownerUser.id })).database.id;
        });

        it('owner can access the database', async () => {
            const dbData = await databaseDefService.getDatabaseById(dbId, ownerUser.id);
            expect(dbData).not.toBeNull();
        });

        it('user with read permission can access', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', dbId, 'read');
            const dbData = await databaseDefService.getDatabaseById(dbId, sharedUser.id);
            expect(dbData).not.toBeNull();
        });

        it('unrelated user cannot access', async () => {
            const dbData = await databaseDefService.getDatabaseById(dbId, unrelatedUser.id);
            expect(dbData).toBeNull();
        });
    });

    describe('updateDatabaseMetadata', () => {
        let dbId;
        beforeEach(async () => {
            dbId = (await databaseDefService.createDatabase({ name: 'DB to Update', userId: ownerUser.id })).database.id;
        });

        it('owner can update', async () => {
            const result = await databaseDefService.updateDatabaseMetadata(dbId, { name: 'New Name' }, ownerUser.id);
            expect(result.success).toBe(true);
            expect(result.database.name).toBe('New Name');
        });

        it('user with write permission can update', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', dbId, 'write');
            const result = await databaseDefService.updateDatabaseMetadata(dbId, { name: 'Updated by Shared' }, sharedUser.id);
            expect(result.success).toBe(true);
        });

        it('user with read permission cannot update', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', dbId, 'read');
            const result = await databaseDefService.updateDatabaseMetadata(dbId, { name: 'Update Fail' }, sharedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Permission denied');
        });
    });

    describe('deleteDatabase', () => {
        let dbId;
        let row1Id, row2Id;

        beforeEach(async () => {
            // Create a database owned by ownerUser
            const dbResult = await databaseDefService.createDatabase({ name: 'DB to Delete', userId: ownerUser.id });
            dbId = dbResult.database.id;

            // Add some rows to this database (directly, as databaseRowService is tested separately)
            row1Id = db.prepare("INSERT INTO database_rows (database_id) VALUES (?)").run(dbId).lastInsertRowid;
            row2Id = db.prepare("INSERT INTO database_rows (database_id) VALUES (?)").run(dbId).lastInsertRowid;

            // Grant some permissions on these rows and the DB itself
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', dbId, 'read');
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database_row', row1Id, 'read');
            await permissionService.grantPermission(ownerUser.id, unrelatedUser.id, 'database_row', row2Id, 'write');
        });

        it('owner can delete, and all database and its row permissions are revoked', async () => {
            const result = await databaseDefService.deleteDatabase(dbId, ownerUser.id);
            expect(result.success).toBe(true);

            expect(await databaseDefService.getDatabaseById(dbId, ownerUser.id)).toBeNull();
            expect((await permissionService.getPermissionsForObject(dbId, 'database')).length).toBe(0);
            expect((await permissionService.getPermissionsForObject(row1Id, 'database_row')).length).toBe(0);
            expect((await permissionService.getPermissionsForObject(row2Id, 'database_row')).length).toBe(0);
        });

        it('user with admin permission on DB can delete, and permissions are revoked', async () => {
            await permissionService.grantPermission(ownerUser.id, dbAdminUser.id, 'database', dbId, 'admin');
            const result = await databaseDefService.deleteDatabase(dbId, dbAdminUser.id);
            expect(result.success).toBe(true);

            expect(await databaseDefService.getDatabaseById(dbId, ownerUser.id)).toBeNull(); // Check with original owner
            expect((await permissionService.getPermissionsForObject(dbId, 'database')).length).toBe(0);
            expect((await permissionService.getPermissionsForObject(row1Id, 'database_row')).length).toBe(0);
            expect((await permissionService.getPermissionsForObject(row2Id, 'database_row')).length).toBe(0);
        });

        it('user without admin permission cannot delete', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', dbId, 'write'); // write is not enough
            const result = await databaseDefService.deleteDatabase(dbId, sharedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Permission denied');
        });
    });

    describe('Column Operations', () => {
        let dbId;
        beforeEach(async () => {
            dbId = (await databaseDefService.createDatabase({ name: 'DB for Columns', userId: ownerUser.id })).database.id;
        });

        it('owner can add/update/delete columns', async () => {
            const addResult = await databaseDefService.addColumn({ databaseId: dbId, name: 'Col1', type: 'TEXT', columnOrder: 0 }, ownerUser.id);
            expect(addResult.success).toBe(true);
            const colId = addResult.column.id;

            const updateResult = await databaseDefService.updateColumn({ columnId: colId, name: 'Col1 Updated' }, ownerUser.id);
            expect(updateResult.success).toBe(true);
            expect(updateResult.column.name).toBe('Col1 Updated');

            const deleteResult = await databaseDefService.deleteColumn(colId, ownerUser.id);
            expect(deleteResult.success).toBe(true);
        });

        it('user with write permission on DB can add/update/delete columns', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', dbId, 'write');

            const addResult = await databaseDefService.addColumn({ databaseId: dbId, name: 'ColShared', type: 'TEXT', columnOrder: 0 }, sharedUser.id);
            expect(addResult.success).toBe(true);
            const colId = addResult.column.id;

            const updateResult = await databaseDefService.updateColumn({ columnId: colId, name: 'ColShared Upd' }, sharedUser.id);
            expect(updateResult.success).toBe(true);

            const deleteResult = await databaseDefService.deleteColumn(colId, sharedUser.id);
            expect(deleteResult.success).toBe(true);
        });

        it('user with read permission on DB cannot add/update/delete columns', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', dbId, 'read');

            const addResult = await databaseDefService.addColumn({ databaseId: dbId, name: 'ColFail', type: 'TEXT', columnOrder: 0 }, sharedUser.id);
            expect(addResult.success).toBe(false);
            expect(addResult.error).toContain('Permission denied');

            // Need a column to exist for update/delete failure tests
            const ownerAddCol = await databaseDefService.addColumn({ databaseId: dbId, name: 'ColForFail', type: 'TEXT', columnOrder: 0 }, ownerUser.id);
            const colId = ownerAddCol.column.id;

            const updateResult = await databaseDefService.updateColumn({ columnId: colId, name: 'ColFail Upd' }, sharedUser.id);
            expect(updateResult.success).toBe(false);
            // Error message might come from getDatabaseById if it doesn't find for write, or specific check
             expect(updateResult.error).toMatch(/Permission denied|Parent database not found or not accessible/);


            const deleteResult = await databaseDefService.deleteColumn(colId, sharedUser.id);
            expect(deleteResult.success).toBe(false);
            expect(deleteResult.error).toMatch(/Permission denied|Parent database not found or not accessible/);
        });
    });
});
