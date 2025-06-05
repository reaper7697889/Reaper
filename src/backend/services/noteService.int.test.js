const noteService = require('./noteService');
const permissionService = require('./permissionService');
const Database = require('better-sqlite3');

let db;

// Mock users
const ownerUser = { id: 1, username: 'owner_notes_test', password_hash: 'hash_owner' };
const sharedUser = { id: 2, username: 'shared_notes_test', password_hash: 'hash_shared' };
const unrelatedUser = { id: 3, username: 'unrelated_notes_test', password_hash: 'hash_unrelated' };
const actorUser = { id: 4, username: 'actor_notes_test', password_hash: 'hash_actor' }; // General actor for granting if needed

describe('Note Service Integration Tests', () => {
    beforeAll(() => {
        db = new Database(':memory:');
        // Inject test DB into services that use it
        permissionService.__setTestDb(db);
        // If noteService itself directly used getDb, it would also need mocking.
        // For now, assuming noteService calls permissionService which is now mocked for DB.
        // And noteService's own DB calls will also use the same mocked global getDb if it's refactored like permissionService.
        // For simplicity, we'll assume db.js's getDb can be influenced by tests or we directly initialize noteService's db.
        // The ideal way is that noteService also has __setTestDb or uses a globally mocked db.
        // Let's assume db.js getDb() will return our in-memory db for this test environment.
        // This requires db.js to be adaptable or Jest's global mocks.
        // For now, we proceed hoping direct `getDb()` calls in noteService pick up the in-memory DB
        // or we manually ensure its schema is also in this in-memory DB.

        db.exec(`PRAGMA foreign_keys = ON;`);
        // Create users table
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Create notes table (simplified for testing, ensure user_id exists)
        db.exec(`
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT, content TEXT,
                folder_id INTEGER, workspace_id INTEGER, user_id INTEGER, is_pinned BOOLEAN DEFAULT 0,
                is_archived BOOLEAN DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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

        // Seed users
        [ownerUser, sharedUser, unrelatedUser, actorUser].forEach(u => {
            try {
                db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)")
                  .run(u.id, u.username, u.password_hash);
            } catch (e) { /* ignore if already exists for some test runners */ }
        });
    });

    beforeEach(async () => {
        db.prepare("DELETE FROM notes").run();
        db.prepare("DELETE FROM object_permissions").run();
    });

    afterAll(() => {
        permissionService.__restoreOriginalDb(); // Restore original DB for permissionService
        if (db) db.close();
    });

    describe('createNote', () => {
        it('should set creator as owner and grant admin permission', async () => {
            const noteData = { type: 'simple', title: 'Test Note', content: 'Content', userId: ownerUser.id };
            const newNoteId = await noteService.createNote(noteData);

            expect(newNoteId).toBeGreaterThan(0);

            const note = await noteService.getNoteById(newNoteId, ownerUser.id);
            expect(note).toBeDefined();
            expect(note.user_id).toBe(ownerUser.id);

            const permissions = await permissionService.getPermissionsForObject(newNoteId, 'note');
            expect(permissions.length).toBe(1);
            expect(permissions[0].user_id).toBe(ownerUser.id);
            expect(permissions[0].permission_level).toBe('admin');
        });
    });

    describe('getNoteById', () => {
        let noteId;
        beforeEach(async () => {
            const createdNoteId = await noteService.createNote({ type: 'simple', title: 'Shared Note', userId: ownerUser.id });
            noteId = createdNoteId; // createNote returns the ID directly
        });

        it('owner can access the note', async () => {
            const note = await noteService.getNoteById(noteId, ownerUser.id);
            expect(note).not.toBeNull();
            expect(note.id).toBe(noteId);
        });

        it('user with explicit read permission can access the note', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'note', noteId, 'read');
            const note = await noteService.getNoteById(noteId, sharedUser.id);
            expect(note).not.toBeNull();
            expect(note.id).toBe(noteId);
        });

        it('user with explicit write permission can access the note (hierarchy)', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'note', noteId, 'write');
            const note = await noteService.getNoteById(noteId, sharedUser.id);
            expect(note).not.toBeNull();
            expect(note.id).toBe(noteId);
        });

        it('unrelated user cannot access the note', async () => {
            const note = await noteService.getNoteById(noteId, unrelatedUser.id);
            expect(note).toBeNull();
        });
    });

    describe('updateNote', () => {
        let noteId;
        beforeEach(async () => {
            noteId = await noteService.createNote({ type: 'simple', title: 'Update Test Note', userId: ownerUser.id });
        });

        it('owner can update the note', async () => {
            const result = await noteService.updateNote(noteId, { title: 'Updated by Owner' }, ownerUser.id);
            // updateNote returns boolean success or an object {success: boolean}
            const success = typeof result === 'boolean' ? result : result.success;
            expect(success).toBe(true);
            const updatedNote = await noteService.getNoteById(noteId, ownerUser.id);
            expect(updatedNote.title).toBe('Updated by Owner');
        });

        it('user with write permission can update the note', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'note', noteId, 'write');
            const result = await noteService.updateNote(noteId, { title: 'Updated by Shared' }, sharedUser.id);
            const success = typeof result === 'boolean' ? result : result.success;
            expect(success).toBe(true);
            const updatedNote = await noteService.getNoteById(noteId, sharedUser.id); // Check with sharedUser who has write
            expect(updatedNote.title).toBe('Updated by Shared');
        });

        it('user with only read permission cannot update the note', async () => {
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'note', noteId, 'read');
            const result = await noteService.updateNote(noteId, { title: 'Update Fail by ReadOnly' }, sharedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Permission denied');
        });

        it('unrelated user cannot update the note', async () => {
            const result = await noteService.updateNote(noteId, { title: 'Update Fail by Unrelated' }, unrelatedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Permission denied');
        });
    });

    describe('deleteNote', () => {
        let noteId;
        const anotherSharedUserId = 5; // Assuming this ID is not used or add to users table
         db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(anotherSharedUserId, 'another_shared_user', 'hash_another');


        beforeEach(async () => {
            noteId = await noteService.createNote({ type: 'simple', title: 'Delete Test Note', userId: ownerUser.id });
            await permissionService.grantPermission(actorUser.id, sharedUser.id, 'note', noteId, 'admin');
            await permissionService.grantPermission(actorUser.id, anotherSharedUserId, 'note', noteId, 'read');
        });

        it('unrelated user cannot delete the note', async () => {
            const result = await noteService.deleteNote(noteId, unrelatedUser.id);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Permission denied');
        });

        it('user with admin permission can delete the note and permissions are revoked', async () => {
            const result = await noteService.deleteNote(noteId, sharedUser.id);
            expect(result.success).toBe(true);

            const note = await noteService.getNoteById(noteId, ownerUser.id); // Check with owner
            expect(note).toBeNull();

            const permissions = await permissionService.getPermissionsForObject(noteId, 'note');
            expect(permissions.length).toBe(0);
        });

        it('owner can delete their own note and permissions are revoked', async () => {
            const result = await noteService.deleteNote(noteId, ownerUser.id);
            expect(result.success).toBe(true);

            const note = await noteService.getNoteById(noteId, ownerUser.id);
            expect(note).toBeNull();

            const permissions = await permissionService.getPermissionsForObject(noteId, 'note');
            expect(permissions.length).toBe(0);
        });
    });
});
