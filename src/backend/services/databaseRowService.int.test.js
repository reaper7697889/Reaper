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

    describe('Validation in addRow and updateRow', () => {
        let col_text_required_id, col_email_id, col_number_min_max_id, col_text_unique_id;

        beforeEach(async () => {
            // db1Id is already created and owned by ownerUser
            const requiredRule = [{ type: 'not_empty', message: 'Name is required.' }];
            const emailRule = [{ type: 'is_email', message: 'Invalid email.' }];
            const numberRules = [{ type: 'min_value', value: 10, message: 'Min 10.' }, { type: 'max_value', value: 100, message: 'Max 100.' }];
            const uniqueRule = [{ type: 'unique', message: 'Must be unique.' }];

            col_text_required_id = (await databaseDefService.addColumn({ databaseId: db1Id, name: 'Name', type: 'TEXT', columnOrder: 2, validation_rules: requiredRule }, ownerUser.id)).column.id;
            col_email_id = (await databaseDefService.addColumn({ databaseId: db1Id, name: 'Email', type: 'TEXT', columnOrder: 3, validation_rules: emailRule }, ownerUser.id)).column.id;
            col_number_min_max_id = (await databaseDefService.addColumn({ databaseId: db1Id, name: 'Age', type: 'NUMBER', columnOrder: 4, validation_rules: numberRules }, ownerUser.id)).column.id;
            col_text_unique_id = (await databaseDefService.addColumn({ databaseId: db1Id, name: 'UniqueCode', type: 'TEXT', columnOrder: 5, validation_rules: uniqueRule }, ownerUser.id)).column.id;
        });

        describe('addRow Validation', () => {
            it('should add row with valid data', async () => {
                const values = {
                    [col_text_required_id]: 'Valid Name',
                    [col_email_id]: 'test@example.com',
                    [col_number_min_max_id]: 50,
                    [col_text_unique_id]: 'unique1'
                };
                const result = await databaseRowService.addRow({ databaseId: db1Id, values, requestingUserId: ownerUser.id });
                expect(result.success).toBe(true);
                expect(result.rowId).toBeGreaterThan(0);
            });

            it('should fail for single rule violation (not_empty)', async () => {
                const values = { [col_text_required_id]: '' }; // Fails not_empty
                const result = await databaseRowService.addRow({ databaseId: db1Id, values, requestingUserId: ownerUser.id });
                expect(result.success).toBe(false);
                expect(result.error).toBe('Validation failed.');
                expect(result.validationErrors.Name).toEqual(['Name is required.']);
            });

            it('should fail for multiple rule violations on same field (e.g. min_length & regex)', async () => {
                // Setup a column with multiple rules that can both fail
                const multiRule = [
                    { type: 'min_length', value: 10, message: 'Min 10 chars.'},
                    { type: 'regex', value: '^[a-zA-Z]+$', message: 'Only letters.'}
                ];
                const col_multi_id = (await databaseDefService.addColumn({ databaseId: db1Id, name: 'MultiRuleCol', type: 'TEXT', columnOrder: 6, validation_rules: multiRule }, ownerUser.id)).column.id;

                const values = { [col_multi_id]: 'short123' }; // Fails both rules
                const result = await databaseRowService.addRow({ databaseId: db1Id, values, requestingUserId: ownerUser.id });
                expect(result.success).toBe(false);
                expect(result.validationErrors.MultiRuleCol).toContain('Min 10 chars.');
                expect(result.validationErrors.MultiRuleCol).toContain('Only letters.');
            });


            it('should fail with violations on multiple fields', async () => {
                const values = {
                    [col_text_required_id]: '', // Fails not_empty
                    [col_number_min_max_id]: 5 // Fails min_value
                };
                const result = await databaseRowService.addRow({ databaseId: db1Id, values, requestingUserId: ownerUser.id });
                expect(result.success).toBe(false);
                expect(result.validationErrors.Name).toEqual(['Name is required.']);
                expect(result.validationErrors.Age).toEqual(['Min 10.']);
            });

            it('should fail for unique constraint violation on add', async () => {
                const initialValues = { [col_text_unique_id]: 'unique_val' };
                await databaseRowService.addRow({ databaseId: db1Id, values: initialValues, requestingUserId: ownerUser.id });

                const duplicateValues = { [col_text_unique_id]: 'unique_val' };
                const result = await databaseRowService.addRow({ databaseId: db1Id, values: duplicateValues, requestingUserId: ownerUser.id });
                expect(result.success).toBe(false);
                expect(result.validationErrors.UniqueCode).toEqual(['Must be unique.']);
            });
        });

        describe('updateRow Validation', () => {
            let rowIdToUpdate;
            beforeEach(async () => {
                const initialValues = {
                    [col_text_required_id]: 'Initial Name',
                    [col_email_id]: 'initial@example.com',
                    [col_number_min_max_id]: 20,
                    [col_text_unique_id]: 'initialUnique'
                };
                rowIdToUpdate = (await databaseRowService.addRow({ databaseId: db1Id, values: initialValues, requestingUserId: ownerUser.id })).rowId;
            });

            it('should update row with valid data', async () => {
                const result = await databaseRowService.updateRow({ rowId: rowIdToUpdate, values: { [col_text_required_id]: 'Updated Name' }, requestingUserId: ownerUser.id });
                expect(result.success).toBe(true);
            });

            it('should fail update for single rule violation (is_email)', async () => {
                const result = await databaseRowService.updateRow({ rowId: rowIdToUpdate, values: { [col_email_id]: 'not-an-email' }, requestingUserId: ownerUser.id });
                expect(result.success).toBe(false);
                expect(result.validationErrors.Email).toEqual(['Invalid email.']);
            });

            it('should fail update for unique constraint violation', async () => {
                // Add another row to create a value to clash with
                const otherValues = { [col_text_unique_id]: 'existing_unique_value' };
                await databaseRowService.addRow({ databaseId: db1Id, values: otherValues, requestingUserId: ownerUser.id });

                // Attempt to update original row to this existing unique value
                const result = await databaseRowService.updateRow({ rowId: rowIdToUpdate, values: { [col_text_unique_id]: 'existing_unique_value' }, requestingUserId: ownerUser.id });
                expect(result.success).toBe(false);
                expect(result.validationErrors.UniqueCode).toEqual(['Must be unique.']);
            });

            it('should pass update if unique value is unchanged for the current row', async () => {
                 const result = await databaseRowService.updateRow({ rowId: rowIdToUpdate, values: { [col_text_unique_id]: 'initialUnique' }, requestingUserId: ownerUser.id });
                 expect(result.success).toBe(true); // No actual change, but validation passes
            });

            it('should pass update if changing to a new unique value', async () => {
                const result = await databaseRowService.updateRow({ rowId: rowIdToUpdate, values: { [col_text_unique_id]: 'newUniqueForUpdate' }, requestingUserId: ownerUser.id });
                expect(result.success).toBe(true);
            });
        });
    });
});
