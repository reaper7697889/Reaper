const databaseDefService = require('./databaseDefService');
const permissionService = require('./permissionService'); // Mocked or real for some auth checks
const Database = require('better-sqlite3');

let db;

// Mock users (minimal, as primary focus is not complex permissions here but rule storage)
const testUser = { id: 1, username: 'test_dbdef_user', password_hash: 'hash' };

// Mock permissionService
jest.mock('./permissionService', () => ({
    // Mock any functions that might be called by databaseDefService during these specific tests
    // For column operations, it checks 'write' on the database.
    checkPermission: jest.fn().mockResolvedValue(true), // Default to allow for simplicity
    grantPermission: jest.fn().mockResolvedValue({ success: true }), // If createDatabase is called
    __setTestDb: jest.fn(), // Ensure this can be called
    __restoreOriginalDb: jest.fn(),
}));


describe('Database Definition Service - Validation Rules Management', () => {
    beforeAll(() => {
        db = new Database(':memory:');
        // Inject this db into the service being tested if it has a similar mechanism to permissionService,
        // or ensure its internal getDb() calls can be globally mocked to point here for tests.
        // For now, we assume databaseDefService's getDb() might be influenced by permissionService's mock,
        // or we are testing its direct DB interactions with this instance.
        // A direct __setTestDb for databaseDefService would be ideal.
        // Let's try to mock the getDb used by databaseDefService if possible,
        // or pass db instance if functions allow. The current structure of databaseDefService uses getDb internally.
        // We'll rely on the fact that `../db` is mocked/controlled by the test environment (like via permissionService's setup)
        // or that these tests are okay if `databaseDefService` itself initializes its own in-memory for testing if `getDb` is not mocked globally.
        // The most robust way: `jest.mock('../db', () => ({ getDb: () => db }));` at top level.
        // For this tool, we'll assume the db instance is correctly picked up by databaseDefService via its own `getDb` calls.
        // This is simpler if `databaseDefService` was refactored like `permissionService` to use `getDbInService`.
        // Since it's not, we'll ensure the schema is created on *this* db instance.

        // Create users table (referenced by note_databases.user_id)
        db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);`);
        db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(testUser.id, testUser.username, testUser.password_hash);

        // Create note_databases table (parent for database_columns)
        db.exec(`CREATE TABLE IF NOT EXISTS note_databases (id INTEGER PRIMARY KEY, name TEXT NOT NULL, user_id INTEGER, FOREIGN KEY (user_id) REFERENCES users(id));`);

        // Create database_columns table (the table we are testing interactions with)
        // This is the schema databaseDefService itself would create, including the new validation_rules
         db.exec(`
            CREATE TABLE IF NOT EXISTS database_columns (
                id INTEGER PRIMARY KEY AUTOINCREMENT, database_id INTEGER NOT NULL, name TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'RELATION', 'FORMULA', 'ROLLUP', 'LOOKUP', 'DATETIME')),
                column_order INTEGER NOT NULL, default_value TEXT, select_options TEXT,
                linked_database_id INTEGER,
                relation_target_entity_type TEXT NOT NULL DEFAULT 'NOTE_DATABASES' CHECK(relation_target_entity_type IN ('NOTE_DATABASES', 'NOTES_TABLE')),
                inverse_column_id INTEGER DEFAULT NULL,
                formula_definition TEXT DEFAULT NULL, formula_result_type TEXT DEFAULT NULL,
                rollup_source_relation_column_id INTEGER DEFAULT NULL, rollup_target_column_id INTEGER DEFAULT NULL,
                rollup_function TEXT DEFAULT NULL,
                lookup_source_relation_column_id INTEGER DEFAULT NULL, lookup_target_value_column_id TEXT DEFAULT NULL,
                lookup_multiple_behavior TEXT DEFAULT NULL,
                validation_rules TEXT DEFAULT NULL, -- Ensure this is present
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE,
                FOREIGN KEY (linked_database_id) REFERENCES note_databases(id) ON DELETE SET NULL,
                FOREIGN KEY (inverse_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
                FOREIGN KEY (rollup_source_relation_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
                FOREIGN KEY (rollup_target_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
                FOREIGN KEY (lookup_source_relation_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
                FOREIGN KEY (lookup_target_value_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
                UNIQUE (database_id, name), UNIQUE (database_id, column_order)
            );
        `);
        // Mock getDb for databaseDefService if it was refactored like permissionService
        if (databaseDefService.__setTestDb) {
            databaseDefService.__setTestDb(db);
        }
    });

    let testDbId;
    beforeEach(async () => {
        db.prepare("DELETE FROM database_columns").run();
        db.prepare("DELETE FROM note_databases").run();
        // Seed a test database definition owned by testUser
        const result = db.prepare("INSERT INTO note_databases (name, user_id) VALUES (?, ?)").run('TestDB for Columns', testUser.id);
        testDbId = result.lastInsertRowid;

        // Reset mocks for permissionService if they are stateful per test
        permissionService.checkPermission.mockClear().mockResolvedValue(true); // Default to allow
    });

    afterAll(() => {
        if (databaseDefService.__restoreOriginalDb) {
            databaseDefService.__restoreOriginalDb();
        }
        if (db) db.close();
    });

    describe('addColumn', () => {
        it('should add a column with valid validation_rules', async () => {
            const rules = [{ type: 'not_empty', message: 'Required' }];
            const result = await databaseDefService.addColumn({
                databaseId: testDbId, name: 'ColWithRules', type: 'TEXT', columnOrder: 1,
                validation_rules: rules
            }, testUser.id);
            expect(result.success).toBe(true);
            expect(result.column).toBeDefined();
            expect(result.column.validation_rules).toEqual(rules);

            const storedCol = db.prepare("SELECT validation_rules FROM database_columns WHERE id = ?").get(result.column.id);
            expect(JSON.parse(storedCol.validation_rules)).toEqual(rules);
        });

        it('should store validation_rules as NULL if not provided', async () => {
            const result = await databaseDefService.addColumn({
                databaseId: testDbId, name: 'ColNoRules', type: 'TEXT', columnOrder: 1
            }, testUser.id);
            expect(result.success).toBe(true);
            expect(result.column.validation_rules).toEqual([]); // Default parsing behavior

            const storedCol = db.prepare("SELECT validation_rules FROM database_columns WHERE id = ?").get(result.column.id);
            expect(storedCol.validation_rules).toBeNull();
        });

        it('should return error if validation_rules is not an array', async () => {
            const result = await databaseDefService.addColumn({
                databaseId: testDbId, name: 'ColInvalidRules', type: 'TEXT', columnOrder: 1,
                validation_rules: "not-an-array"
            }, testUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('validation_rules must be an array');
        });
    });

    describe('updateColumn', () => {
        let colIdToUpdate;
        beforeEach(async () => {
            const addResult = await databaseDefService.addColumn({ databaseId: testDbId, name: 'ColToUpdate', type: 'TEXT', columnOrder: 0 }, testUser.id);
            colIdToUpdate = addResult.column.id;
        });

        it('should update a column to add validation_rules', async () => {
            const rules = [{ type: 'min_length', value: 5 }];
            const result = await databaseDefService.updateColumn({ columnId: colIdToUpdate, validation_rules: rules }, testUser.id);
            expect(result.success).toBe(true);
            expect(result.column.validation_rules).toEqual(rules);
        });

        it('should update existing validation_rules', async () => {
            // First, add some rules
            await databaseDefService.updateColumn({ columnId: colIdToUpdate, validation_rules: [{ type: 'not_empty' }] }, testUser.id);
            // Then, update them
            const newRules = [{ type: 'max_length', value: 10 }];
            const result = await databaseDefService.updateColumn({ columnId: colIdToUpdate, validation_rules: newRules }, testUser.id);
            expect(result.success).toBe(true);
            expect(result.column.validation_rules).toEqual(newRules);
        });

        it('should clear validation_rules if set to null', async () => {
            await databaseDefService.updateColumn({ columnId: colIdToUpdate, validation_rules: [{ type: 'not_empty' }] }, testUser.id);
            const result = await databaseDefService.updateColumn({ columnId: colIdToUpdate, validation_rules: null }, testUser.id);
            expect(result.success).toBe(true);
            expect(result.column.validation_rules).toEqual([]); // Default parsing of NULL
        });

        it('should return error if updating with invalid validation_rules (not array or null)', async () => {
            const result = await databaseDefService.updateColumn({ columnId: colIdToUpdate, validation_rules: "invalid-string" }, testUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('validation_rules must be an array or null');
        });
    });

    describe('getColumnsForDatabase', () => {
        it('should parse valid JSON rules, handle NULL, and manage invalid JSON', async () => {
            const validRules = [{ type: 'is_email' }];
            const invalidJsonString = '[{type:"bad",}'; // Intentionally bad JSON

            await databaseDefService.addColumn({ databaseId: testDbId, name: 'ColWithValidRules', type: 'TEXT', columnOrder: 0, validation_rules: validRules }, testUser.id);
            await databaseDefService.addColumn({ databaseId: testDbId, name: 'ColWithNullRules', type: 'TEXT', columnOrder: 1, validation_rules: null }, testUser.id);

            // Manually insert a column with invalid JSON for validation_rules
            db.prepare("INSERT INTO database_columns (database_id, name, type, column_order, validation_rules) VALUES (?, ?, ?, ?, ?)")
              .run(testDbId, 'ColWithInvalidJson', 'TEXT', 2, invalidJsonString);

            const columns = await databaseDefService.getColumnsForDatabase(testDbId, testUser.id);
            expect(columns.length).toBe(3);

            const colValid = columns.find(c => c.name === 'ColWithValidRules');
            expect(colValid.validation_rules).toEqual(validRules);

            const colNull = columns.find(c => c.name === 'ColWithNullRules');
            expect(colNull.validation_rules).toEqual([]); // Default parsing of NULL

            const colInvalid = columns.find(c => c.name === 'ColWithInvalidJson');
            expect(colInvalid.validation_rules).toEqual([{ error: "parse_failed", original: invalidJsonString }]);
        });
    });
});
