const databaseRowService = require('./databaseRowService');
const databaseDefService = require('./databaseDefService'); // Needed to create DBs and columns
const permissionService = require('./permissionService');
const Database = require('better-sqlite3');

let db;

// Mock users
const ownerUser = { id: 1, username: 'owner_row_test', password_hash: 'hash_owner_row' }; // Owns db1
const sharedUser = { id: 2, username: 'shared_row_test', password_hash: 'hash_shared_row' }; // Has some perms on db1 or rows in db1
const anotherUser = { id: 3, username: 'another_row_test', password_hash: 'hash_another_row' }; // Owns db2, or no perms on db1
const unrelatedUser = { id: 4, username: 'unrelated_row_test', password_hash: 'hash_unrelated_row' }; // No perms generally
const actorUser = { id: 5, username: 'actor_row_test', password_hash: 'hash_actor_row' }; // For granting perms

describe('Database Row Service Integration Tests', () => {
    let db1Id, db2Id; // Database IDs
    let col1Db1Id, col2Db1Id; // Column IDs for db1

    beforeAll(() => {
        db = new Database(':memory:');
        permissionService.__setTestDb(db);
        // Assume databaseDefService and databaseRowService pick up the mocked DB via permissionService or global mock

        db.exec(`PRAGMA foreign_keys = ON;`);
        // Create users table
        db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);`);
        // Create notes table (if any FKs from note_databases point to it, not directly used by rows but good for schema completeness)
        db.exec(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, title TEXT, FOREIGN KEY (user_id) REFERENCES users(id));`);
        // Create note_databases table
        db.exec(`CREATE TABLE IF NOT EXISTS note_databases (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, user_id INTEGER, note_id INTEGER, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL);`);
        // Create database_columns table
        db.exec(`CREATE TABLE IF NOT EXISTS database_columns (id INTEGER PRIMARY KEY AUTOINCREMENT, database_id INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, column_order INTEGER, FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE);`);
        // Create database_rows table
        db.exec(`CREATE TABLE IF NOT EXISTS database_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, database_id INTEGER NOT NULL, FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE);`);
        // Create database_row_values table
        db.exec(`CREATE TABLE IF NOT EXISTS database_row_values (id INTEGER PRIMARY KEY AUTOINCREMENT, row_id INTEGER NOT NULL, column_id INTEGER NOT NULL, value_text TEXT, value_number REAL, value_boolean INTEGER, FOREIGN KEY (row_id) REFERENCES database_rows(id) ON DELETE CASCADE, FOREIGN KEY (column_id) REFERENCES database_columns(id) ON DELETE CASCADE, UNIQUE(row_id, column_id));`);
        // Create object_permissions table
        db.exec(`CREATE TABLE IF NOT EXISTS object_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id INTEGER NOT NULL, user_id INTEGER NOT NULL, permission_level TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, UNIQUE (object_type, object_id, user_id));`);

        [ownerUser, sharedUser, anotherUser, unrelatedUser, actorUser].forEach(u => {
            try { db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(u.id, u.username, u.password_hash); } catch (e) {}
        });
    });

    beforeEach(async () => {
        // Clear relevant tables
        db.prepare("DELETE FROM database_row_values").run();
        db.prepare("DELETE FROM database_rows").run();
        db.prepare("DELETE FROM database_columns").run();
        db.prepare("DELETE FROM note_databases").run();
        db.prepare("DELETE FROM object_permissions").run();

        // Setup: db1 owned by ownerUser, db2 owned by anotherUser
        const db1Result = await databaseDefService.createDatabase({ name: 'DB1', userId: ownerUser.id });
        db1Id = db1Result.database.id;
        const db2Result = await databaseDefService.createDatabase({ name: 'DB2', userId: anotherUser.id });
        db2Id = db2Result.database.id;

        // Add columns to db1
        const col1Db1 = await databaseDefService.addColumn({ databaseId: db1Id, name: 'TextCol', type: 'TEXT', columnOrder: 0 }, ownerUser.id);
        col1Db1Id = col1Db1.column.id;
        const col2Db1 = await databaseDefService.addColumn({ databaseId: db1Id, name: 'NumCol', type: 'NUMBER', columnOrder: 1 }, ownerUser.id);
        col2Db1Id = col2Db1.column.id;
    });

    afterAll(() => {
        permissionService.__restoreOriginalDb();
        if (db) db.close();
    });

    describe('addRow', () => {
        it('owner of DB can add a row, gets admin on new row', async () => {
            const result = await databaseRowService.addRow({ databaseId: db1Id, values: { [col1Db1Id]: 'Val1' }, requestingUserId: ownerUser.id });
            expect(result.success).toBe(true);
            const rowId = result.rowId;
            expect(rowId).toBeGreaterThan(0);

            const permissions = await permissionService.getPermissionsForObject(rowId, 'database_row');
            expect(permissions.length).toBe(1);
            expect(permissions[0].user_id).toBe(ownerUser.id);
            expect(permissions[0].permission_level).toBe('admin');
        });

        it('user with "write" on DB can add a row, gets admin on new row', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', db1Id, 'write');
            const result = await databaseRowService.addRow({ databaseId: db1Id, values: { [col1Db1Id]: 'ValShared' }, requestingUserId: sharedUser.id });
            expect(result.success).toBe(true);
            const rowId = result.rowId;

            const permissions = await permissionService.getPermissionsForObject(rowId, 'database_row');
            expect(permissions.length).toBe(1);
            expect(permissions[0].user_id).toBe(sharedUser.id); // Creator of row gets admin on row
            expect(permissions[0].permission_level).toBe('admin');
        });

        it('user without "write" on DB cannot add a row', async () => {
            await permissionService.grantPermission(ownerUser.id, unrelatedUser.id, 'database', db1Id, 'read'); // Only read access
            const result = await databaseRowService.addRow({ databaseId: db1Id, values: { [col1Db1Id]: 'ValFail' }, requestingUserId: unrelatedUser.id });
            expect(result.success).toBe(false);
            expect(result.error).toContain('lacks \'write\' permission on database');
        });
    });

    describe('getRow', () => {
        let row1inDb1;
        let row1inDb2;

        beforeEach(async () => {
            row1inDb1 = (await databaseRowService.addRow({ databaseId: db1Id, values: { [col1Db1Id]: 'Row1DB1' }, requestingUserId: ownerUser.id })).rowId;
            // db2 is owned by anotherUser, add a column first
            const col1Db2 = (await databaseDefService.addColumn({ databaseId: db2Id, name: 'DataCol', type: 'TEXT', columnOrder: 0 }, anotherUser.id)).column.id;
            row1inDb2 = (await databaseRowService.addRow({ databaseId: db2Id, values: { [col1Db2]: 'Row1DB2' }, requestingUserId: anotherUser.id })).rowId;
        });

        it('owner of parent DB can get row', async () => {
            const row = await databaseRowService.getRow(row1inDb1, ownerUser.id);
            expect(row).not.toBeNull();
            expect(row.id).toBe(row1inDb1);
        });

        it('user with "read" on parent DB can get row (no explicit row perm needed)', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', db1Id, 'read');
            const row = await databaseRowService.getRow(row1inDb1, sharedUser.id);
            expect(row).not.toBeNull();
        });

        it('user with explicit "read" on row can get row (even without parent DB read perm)', async () => {
            // unrelatedUser does not have read access to db1 (owned by ownerUser)
            // actorUser (system or owner of row1inDb1, which is ownerUser) grants perm on row to unrelatedUser
            await permissionService.grantPermission(ownerUser.id, unrelatedUser.id, 'database_row', row1inDb1, 'read');
            const row = await databaseRowService.getRow(row1inDb1, unrelatedUser.id);
            expect(row).not.toBeNull();
        });

        it('user with no perms on parent DB or row cannot get row', async () => {
            const row = await databaseRowService.getRow(row1inDb1, unrelatedUser.id);
            expect(row).toBeNull();
        });
    });

    describe('updateRow', () => {
        let rowId;
        beforeEach(async () => {
            rowId = (await databaseRowService.addRow({ databaseId: db1Id, values: { [col1Db1Id]: 'Initial Value' }, requestingUserId: ownerUser.id })).rowId;
        });

        it('user with "write" on parent DB can update row', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', db1Id, 'write');
            const result = await databaseRowService.updateRow({ rowId, values: { [col1Db1Id]: 'Updated by DB Write Perm' }, requestingUserId: sharedUser.id });
            expect(result.success).toBe(true);
        });

        it('user with explicit "write" on row can update row (even without parent DB write perm)', async () => {
            // sharedUser has only read on db1
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', db1Id, 'read');
            // ownerUser (who is admin on rowId) grants write to sharedUser on the row itself
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database_row', rowId, 'write');

            const result = await databaseRowService.updateRow({ rowId, values: { [col1Db1Id]: 'Updated by Explicit Row Write' }, requestingUserId: sharedUser.id });
            expect(result.success).toBe(true);
        });

        it('user with only "read" on parent DB and "read" on row cannot update', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', db1Id, 'read');
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database_row', rowId, 'read');
            const result = await databaseRowService.updateRow({ rowId, values: { [col1Db1Id]: 'Update Fail' }, requestingUserId: sharedUser.id });
            expect(result.success).toBe(false);
            expect(result.error).toContain('lacks write permission');
        });
    });

    describe('deleteRow', () => {
        let rowId;
        beforeEach(async () => {
            rowId = (await databaseRowService.addRow({ databaseId: db1Id, values: { [col1Db1Id]: 'To Delete' }, requestingUserId: ownerUser.id })).rowId;
        });

        it('user with "admin" on parent DB can delete row, and row permissions are revoked', async () => {
            await permissionService.grantPermission(ownerUser.id, dbAdminUser.id, 'database', db1Id, 'admin');
            // Grant some other perm on the row to check cleanup
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database_row', rowId, 'read');

            const result = await databaseRowService.deleteRow(rowId, dbAdminUser.id);
            expect(result.success).toBe(true);

            const rowPerms = await permissionService.getPermissionsForObject(rowId, 'database_row');
            expect(rowPerms.length).toBe(0);
        });

        it('user with explicit "admin" on row can delete row, and row permissions are revoked', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', db1Id, 'read'); // only read on DB
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database_row', rowId, 'admin'); // admin on row

            const result = await databaseRowService.deleteRow(rowId, sharedUser.id);
            expect(result.success).toBe(true);

            const rowPerms = await permissionService.getPermissionsForObject(rowId, 'database_row');
            expect(rowPerms.length).toBe(0);
        });

        it('user without sufficient privileges cannot delete row', async () => {
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database', db1Id, 'write'); // write on DB is not enough
            await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'database_row', rowId, 'write'); // write on row is not enough

            const result = await databaseRowService.deleteRow(rowId, sharedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('lacks admin permission');
        });
    });
});
