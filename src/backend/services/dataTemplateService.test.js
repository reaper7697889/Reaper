const dataTemplateService = require('./dataTemplateService');
const databaseDefService = require('./databaseDefService');
const permissionService = require('./permissionService');
const Database = require('better-sqlite3');

let db;

// Mock Users
const ownerUser = { id: 1, username: 'owner_template_test' };
const sharedUser = { id: 2, username: 'shared_template_test' }; // Owns db2, can be granted perms on db1
const unrelatedUser = { id: 3, username: 'unrelated_template_test' };
const dbAdminUser = { id: 4, username: 'db_admin_template_test' }; // Can be granted admin on db1
const SYS_USER_ID = 0;

// Mocks for permissionService
let mockCheckPermission;
let mockGrantPermission;
let mockRevokeAllPermissions;

describe('Data Template Service Tests', () => {
    let db1Id, db2Id;
    let col1Db1Id, col2Db1Id; // Columns in db1

    beforeAll(() => {
        db = new Database(':memory:');
        // Inject test DB into services
        permissionService.__setTestDb(db);
        // Assuming databaseDefService and dataTemplateService use getDb that's now globally "mocked" via permissionService's setup
        // or they would need their own __setTestDb methods.
        // For this test, we rely on a single db instance being used across services.
        if (databaseDefService.__setTestDb) databaseDefService.__setTestDb(db);
        if (dataTemplateService.__setTestDb) dataTemplateService.__setTestDb(db); // If it had one

        db.exec(`PRAGMA foreign_keys = ON;`);
        // Create users table
        db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT);`);
        // Create note_databases table
        db.exec(`CREATE TABLE IF NOT EXISTS note_databases (id INTEGER PRIMARY KEY, name TEXT NOT NULL, user_id INTEGER, FOREIGN KEY (user_id) REFERENCES users(id));`);
        // Create database_columns table
        db.exec(`CREATE TABLE IF NOT EXISTS database_columns (id INTEGER PRIMARY KEY, database_id INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, column_order INTEGER, validation_rules TEXT, FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE, UNIQUE(database_id, name));`);
        // Create data_templates table
        db.exec(`CREATE TABLE IF NOT EXISTS data_templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, target_database_id INTEGER NOT NULL, template_values TEXT NOT NULL, user_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (target_database_id) REFERENCES note_databases(id) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL, UNIQUE (target_database_id, name));`);
        // Create object_permissions table
        db.exec(`CREATE TABLE IF NOT EXISTS object_permissions (id INTEGER PRIMARY KEY, object_type TEXT NOT NULL, object_id INTEGER NOT NULL, user_id INTEGER NOT NULL, permission_level TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, UNIQUE (object_type, object_id, user_id));`);

        [ownerUser, sharedUser, unrelatedUser, dbAdminUser].forEach(u => {
            db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(u.id, u.username, 'test_hash');
        });
    });

    beforeEach(async () => {
        // Clear tables
        db.prepare("DELETE FROM data_templates").run();
        db.prepare("DELETE FROM database_columns").run();
        db.prepare("DELETE FROM note_databases").run();
        db.prepare("DELETE FROM object_permissions").run();

        // Seed databases
        const db1Result = await databaseDefService.createDatabase({ name: 'DB1_for_Templates', userId: ownerUser.id });
        db1Id = db1Result.database.id;
        const db2Result = await databaseDefService.createDatabase({ name: 'DB2_for_Templates', userId: sharedUser.id });
        db2Id = db2Result.database.id;

        // Seed columns for db1
        col1Db1Id = (await databaseDefService.addColumn({ databaseId: db1Id, name: 'Name', type: 'TEXT', columnOrder: 0, validation_rules: [{ type: 'not_empty' }] }, ownerUser.id)).column.id;
        col2Db1Id = (await databaseDefService.addColumn({ databaseId: db1Id, name: 'Email', type: 'TEXT', columnOrder: 1, validation_rules: [{ type: 'is_email' }] }, ownerUser.id)).column.id;

        // Setup spies
        mockCheckPermission = jest.spyOn(permissionService, 'checkPermission');
        mockGrantPermission = jest.spyOn(permissionService, 'grantPermission');
        mockRevokeAllPermissions = jest.spyOn(permissionService, 'revokeAllPermissionsForObject');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(() => {
        permissionService.__restoreOriginalDb();
        if (databaseDefService.__restoreOriginalDb) databaseDefService.__restoreOriginalDb();
        if (dataTemplateService.__restoreOriginalDb) dataTemplateService.__restoreOriginalDb();
        if (db) db.close();
    });

    describe('_validateTemplateValuesKeys (implicitly via create/update)', () => {
        it('createTemplate should fail if template_values contains invalid column IDs', async () => {
            const result = await dataTemplateService.createTemplate({
                name: 'Test Invalid Keys', target_database_id: db1Id,
                template_values: { "9999": "val", [col1Db1Id]: "good val" }, // 9999 is invalid
                requestingUserId: ownerUser.id
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain("Invalid column ID '9999'");
        });
    });

    describe('createTemplate', () => {
        it('should succeed if actor owns parent DB', async () => {
            mockCheckPermission.mockResolvedValue(true); // Assume general write if not owner (not needed here)
            const result = await dataTemplateService.createTemplate({
                name: 'Owned DB Template', target_database_id: db1Id,
                template_values: { [col1Db1Id]: "Test" }, requestingUserId: ownerUser.id
            });
            expect(result.success).toBe(true);
            expect(result.template.user_id).toBe(ownerUser.id);
            expect(mockGrantPermission).toHaveBeenCalledWith(ownerUser.id, ownerUser.id, 'data_template', result.template.id, 'admin');
        });

        it('should succeed if actor has "write" on parent DB', async () => {
            mockCheckPermission.mockResolvedValueOnce(true); // For 'database' 'write' check
            const result = await dataTemplateService.createTemplate({
                name: 'Shared DB Write Template', target_database_id: db1Id, // db1 owned by ownerUser
                template_values: { [col1Db1Id]: "Test" }, requestingUserId: sharedUser.id
            });
            expect(result.success).toBe(true);
            expect(result.template.user_id).toBe(sharedUser.id);
            expect(mockGrantPermission).toHaveBeenCalledWith(sharedUser.id, sharedUser.id, 'data_template', result.template.id, 'admin');
        });

        it('should fail if actor has no "write" on parent DB and is not owner', async () => {
            mockCheckPermission.mockResolvedValueOnce(false); // For 'database' 'write' check
            const result = await dataTemplateService.createTemplate({
                name: 'No Perm Template', target_database_id: db1Id,
                template_values: { [col1Db1Id]: "Test" }, requestingUserId: unrelatedUser.id
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain("Permission denied: Cannot create template for this database.");
        });

        it('should fail on duplicate name for the same target_database_id', async () => {
            await dataTemplateService.createTemplate({ name: 'Unique Name Test', target_database_id: db1Id, template_values: {}, requestingUserId: ownerUser.id });
            const result = await dataTemplateService.createTemplate({ name: 'Unique Name Test', target_database_id: db1Id, template_values: {}, requestingUserId: ownerUser.id });
            expect(result.success).toBe(false);
            expect(result.error).toContain("already exists for the target database");
        });
    });

    describe('getTemplateById', () => {
        let templateId;
        beforeEach(async () => {
            templateId = (await dataTemplateService.createTemplate({ name: 'TestGet', target_database_id: db1Id, template_values: {}, requestingUserId: ownerUser.id })).template.id;
        });

        it('template owner can get template', async () => {
            const result = await dataTemplateService.getTemplateById(templateId, ownerUser.id);
            expect(result).not.toBeNull();
            expect(result.id).toBe(templateId);
        });

        it('user with read on parent DB can get template (even if not owner of template, and template is not public)', async () => {
            // db1 is owned by ownerUser. sharedUser needs read perm on db1.
            mockCheckPermission.mockResolvedValueOnce(true); // For 'database' 'read' check by sharedUser
            const result = await dataTemplateService.getTemplateById(templateId, sharedUser.id);
            expect(result).not.toBeNull();
        });

        it('should return null if user has no rights on parent DB and is not template owner', async () => {
            mockCheckPermission.mockResolvedValueOnce(false); // For 'database' 'read' check by unrelatedUser
            const result = await dataTemplateService.getTemplateById(templateId, unrelatedUser.id);
            expect(result).toBeNull();
        });
    });

    describe('getTemplatesForDatabase', () => {
        beforeEach(async () => {
            await dataTemplateService.createTemplate({ name: 'T1_DB1', target_database_id: db1Id, template_values: {}, requestingUserId: ownerUser.id });
            await dataTemplateService.createTemplate({ name: 'T2_DB1_Public', target_database_id: db1Id, template_values: {}, requestingUserId: null }); // Public template
            await dataTemplateService.createTemplate({ name: 'T3_DB1_Shared', target_database_id: db1Id, template_values: {}, requestingUserId: sharedUser.id });
            await dataTemplateService.createTemplate({ name: 'T1_DB2', target_database_id: db2Id, template_values: {}, requestingUserId: sharedUser.id });
        });

        it('user with read on DB gets all templates for that DB', async () => {
            mockCheckPermission.mockResolvedValueOnce(true); // sharedUser 'read' on db1
            const templates = await dataTemplateService.getTemplatesForDatabase(db1Id, sharedUser.id);
            expect(templates.length).toBe(3); // T1_DB1, T2_DB1_Public, T3_DB1_Shared
            expect(templates.some(t => t.name === 'T1_DB1')).toBe(true);
            expect(templates.some(t => t.name === 'T2_DB1_Public')).toBe(true);
            expect(templates.some(t => t.name === 'T3_DB1_Shared')).toBe(true);
        });

        it('user with no read on DB gets empty array', async () => {
            mockCheckPermission.mockResolvedValueOnce(false); // unrelatedUser no 'read' on db1
            const templates = await dataTemplateService.getTemplatesForDatabase(db1Id, unrelatedUser.id);
            expect(templates).toEqual([]);
        });
    });

    describe('updateTemplate', () => {
        let templateId;
        beforeEach(async () => {
            templateId = (await dataTemplateService.createTemplate({ name: 'Update Test', target_database_id: db1Id, template_values: {}, requestingUserId: ownerUser.id })).template.id;
        });

        it('template owner can update', async () => {
            const result = await dataTemplateService.updateTemplate(templateId, { description: 'Updated Desc' }, ownerUser.id);
            expect(result.success).toBe(true);
            expect(result.template.description).toBe('Updated Desc');
        });

        it('user with admin on parent DB can update (not template owner)', async () => {
            mockCheckPermission.mockResolvedValueOnce(true); // dbAdminUser 'admin' on db1
            const result = await dataTemplateService.updateTemplate(templateId, { description: 'Updated by DB Admin' }, dbAdminUser.id);
            expect(result.success).toBe(true);
        });

        it('DENY update if not owner and no admin on parent DB', async () => {
            mockCheckPermission.mockResolvedValueOnce(false); // sharedUser no 'admin' on db1
            const result = await dataTemplateService.updateTemplate(templateId, { description: 'Fail Update' }, sharedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Permission denied');
        });

        it('DENY update of target_database_id if actor has no write on new DB', async () => {
            // ownerUser owns templateId (on db1). Tries to move to db2 (owned by sharedUser).
            // ownerUser needs 'write' on db2.
            mockCheckPermission.mockResolvedValueOnce(false); // ownerUser no 'write' on db2
            const result = await dataTemplateService.updateTemplate(templateId, { target_database_id: db2Id }, ownerUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Actor lacks write/ownership rights on the new target database');
        });
    });

    describe('deleteTemplate', () => {
        let templateId;
        beforeEach(async () => {
            templateId = (await dataTemplateService.createTemplate({ name: 'Delete Test', target_database_id: db1Id, template_values: {}, requestingUserId: ownerUser.id })).template.id;
            // Grant a permission on the template itself to test cleanup
             await permissionService.grantPermission(ownerUser.id, sharedUser.id, 'data_template', templateId, 'read');
        });

        it('template owner can delete', async () => {
            const result = await dataTemplateService.deleteTemplate(templateId, ownerUser.id);
            expect(result.success).toBe(true);
            expect(mockRevokeAllPermissions).toHaveBeenCalledWith('data_template', templateId);
        });

        it('user with admin on parent DB can delete (not template owner)', async () => {
            mockCheckPermission.mockResolvedValueOnce(true); // dbAdminUser 'admin' on db1
            const result = await dataTemplateService.deleteTemplate(templateId, dbAdminUser.id);
            expect(result.success).toBe(true);
            expect(mockRevokeAllPermissions).toHaveBeenCalledWith('data_template', templateId);
        });

        it('DENY delete if not owner and no admin on parent DB', async () => {
            mockCheckPermission.mockResolvedValueOnce(false); // unrelatedUser no 'admin' on db1
            const result = await dataTemplateService.deleteTemplate(templateId, unrelatedUser.id);
            expect(result.success).toBe(false);
            expect(mockRevokeAllPermissions).not.toHaveBeenCalled();
        });
    });

    describe('getResolvedTemplateValues', () => {
        let templateId;
        let colNameMap = {};
        beforeEach(async () => {
            const templateContent = { [col1Db1Id]: "Default Name", [col2Db1Id]: "default@example.com", "999": "StaleValue" };
            templateId = (await dataTemplateService.createTemplate({ name: 'Resolve Test', target_database_id: db1Id, template_values: templateContent, requestingUserId: ownerUser.id })).template.id;
            colNameMap[col1Db1Id] = 'Name';
            colNameMap[col2Db1Id] = 'Email';
        });

        it('should resolve values with column names for accessible template', async () => {
            // ownerUser can access template and db1
            const result = await dataTemplateService.getResolvedTemplateValues(templateId, ownerUser.id);
            expect(result.success).toBe(true);
            expect(result.values.Name).toBe("Default Name");
            expect(result.values.Email).toBe("default@example.com");
            expect(result.values.StaleValue).toBeUndefined(); // Column ID 999 doesn't exist
        });

        it('should return error if template not accessible', async () => {
            // unrelatedUser cannot access db1, nor does it own the template
            mockCheckPermission.mockResolvedValue(false); // Ensure no read access to db1
            const result = await dataTemplateService.getResolvedTemplateValues(templateId, unrelatedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Template not found or not accessible");
        });
    });
});
