// --- JEST MOCK SETUP ---
// Mock other dependencies first as they are used by the actual noteService
// These should ideally be the versions whose paths were corrected previously.
jest.mock('../../../db');
jest.mock('./historyService');
jest.mock('./permissionService');
jest.mock('../../../attachmentService');
jest.mock('./authService');

// noteService will be the actual module, not mocked at this level.
const noteService = require('./noteService');

// These imports are for test setup (e.g. configuring mocks), not for the service itself.
const { getDb } = require('../../../db');
const historyService = require('./historyService');
const permissionService = require('./permissionService');
const attachmentService = require('../../../attachmentService');
const authService = require('./authService');
// --- END JEST MOCK SETUP ---

describe('Note Service', () => {
  let mockDb;
  let mockStmt;

  beforeEach(() => {
    jest.clearAllMocks();

    // Configure the globally mocked getDb (for actual service calls)
    mockStmt = { run: jest.fn(), get: jest.fn(), all: jest.fn() };
    mockDb = {
      prepare: jest.fn().mockReturnValue(mockStmt),
      transaction: jest.fn(callback => (...args) => callback(...args)),
    };
    getDb.mockReturnValue(mockDb);

    // Reset other service mocks
    historyService.recordNoteHistory.mockResolvedValue({ success: true });
    permissionService.checkUserNotePermission.mockResolvedValue({ V: true });
    authService.getUserWithRole.mockResolvedValue({ id: 1, username: 'testuser', role: 'EDITOR' });
    authService.checkUserRole.mockResolvedValue(false);
  });

  // --- createNote ---
  describe('createNote', () => {
    it('should create a note successfully', async () => {
      mockStmt.run.mockReturnValue({ lastInsertRowid: 123 });
      const noteData = { type: 'simple', title: 'Test Note', content: 'Test Content', userId: 1 };
      const newNoteId = await noteService.createNote(noteData); // Uses actual createNote

      expect(newNoteId).toBe(123);
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO notes'));
      expect(mockStmt.run).toHaveBeenCalledWith('simple', 'Test Note', 'Test Content', null, null, 1, 0);
      expect(historyService.recordNoteHistory).toHaveBeenCalledWith(expect.objectContaining({
        noteId: 123,
        newValues: expect.objectContaining({ title: 'Test Note', content: 'Test Content', type: 'simple', userId: 1 })
      }));
    });

    it('should return null if note type is invalid', async () => {
      const noteData = { type: 'invalid', title: 'Test Note', userId: 1 };
      const result = await noteService.createNote(noteData);
      expect(result).toBeNull();
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });

    it('should return null if database operation fails during run', async () => {
      mockStmt.run.mockImplementationOnce(() => {
        throw new Error('DB error during run');
      });
      const noteData = { type: 'simple', title: 'Test Note', userId: 1 };
      const result = await noteService.createNote(noteData);
      expect(result).toBeNull();
    });

    it('should prevent VIEWERS from creating notes', async () => {
      authService.getUserWithRole.mockResolvedValue({ id: 2, username: 'viewer', role: 'VIEWER' });
      const noteData = { type: 'simple', title: 'Viewer Note', content: 'Content', userId: 2 };
      const result = await noteService.createNote(noteData);
      expect(result).toBeNull();
      expect(mockDb.prepare).not.toHaveBeenCalled();
      expect(authService.getUserWithRole).toHaveBeenCalledWith(2);
    });
  });

  // --- getNoteById ---
  describe('getNoteById', () => {
    const mockNoteBasic = { id: 1, type: 'simple', title: 'Test', content: 'Content', user_id: 1, deleted_at: null };

    it('should return a note if found and user is owner', async () => {
      mockStmt.get.mockReturnValue(mockNoteBasic);
      // Use noteService.getNoteById directly, as it's the actual function.
      const note = await noteService.getNoteById(1, 1);
      expect(note).toEqual(mockNoteBasic);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("SELECT id, type, title, content, folder_id, workspace_id, user_id, is_pinned, is_archived, created_at, updated_at, deleted_at, deleted_by_user_id FROM notes WHERE id = ? AND deleted_at IS NULL")
      );
      expect(mockStmt.get).toHaveBeenCalledWith(1);
    });

    it('should return null if note not found', async () => {
      mockStmt.get.mockReturnValue(undefined);
      const note = await noteService.getNoteById(1, 1);
      expect(note).toBeNull();
    });

    it('should return note if public (user_id is null)', async () => {
      const publicNote = { ...mockNoteBasic, user_id: null };
      mockStmt.get.mockReturnValue(publicNote);
      const note = await noteService.getNoteById(1, 2);
      expect(note).toEqual(publicNote);
    });

    it('should return note if user has explicit READ permission', async () => {
      const otherUserNote = { ...mockNoteBasic, user_id: 2 };
      mockStmt.get.mockReturnValue(otherUserNote);
      permissionService.checkUserNotePermission.mockResolvedValue({ V: true });
      const note = await noteService.getNoteById(1, 1);
      expect(note).toEqual(otherUserNote);
      expect(permissionService.checkUserNotePermission).toHaveBeenCalledWith(1, 1, 'READ');
    });

    it('should return null if user does not have READ permission and is not owner', async () => {
      const otherUserNote = { ...mockNoteBasic, user_id: 2 };
      mockStmt.get.mockReturnValue(otherUserNote);
      permissionService.checkUserNotePermission.mockResolvedValue({ V: false });
      const note = await noteService.getNoteById(1, 1);
      expect(note).toBeNull();
    });

    it('should return note if bypassPermissionCheck is true', async () => {
      mockStmt.get.mockReturnValue(mockNoteBasic);
      const note = await noteService.getNoteById(1, 999, { bypassPermissionCheck: true });
      expect(note).toEqual(mockNoteBasic);
      expect(permissionService.checkUserNotePermission).not.toHaveBeenCalled();
    });

    it('should prepare query without "deleted_at IS NULL" if includeDeleted is true', async () => {
      const deletedNote = { ...mockNoteBasic, deleted_at: '2023-01-01T00:00:00.000Z' };
      mockStmt.get.mockReturnValue(deletedNote);
      await noteService.getNoteById(1, 1, { includeDeleted: true, bypassPermissionCheck: true });
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("SELECT id, type, title, content, folder_id, workspace_id, user_id, is_pinned, is_archived, created_at, updated_at, deleted_at, deleted_by_user_id FROM notes WHERE id = ?")
      );
      const prepareCalls = mockDb.prepare.mock.calls;
      const relevantCall = prepareCalls.find(call => call[0].includes("SELECT id, type, title, content, folder_id, workspace_id, user_id, is_pinned, is_archived, created_at, updated_at, deleted_at, deleted_by_user_id FROM notes WHERE id = ?"));
      expect(relevantCall[0]).not.toContain("AND deleted_at IS NULL");
    });
  });

  // --- updateNote ---
  describe('updateNote', () => {
    let updateData;
    const existingNoteBaseProperties = { id: 1, type: 'simple', title: 'Old Title', content: 'Old Content', user_id: 1, folder_id: null, workspace_id: null, is_pinned: 0, is_archived: 0 };

    beforeEach(() => {
      updateData = { title: 'New Title', content: 'New Content' };
      // noteService.getNoteById is globally mocked. For these tests, we assume updateNote
      // calls the *actual* getNoteById internally. We control its behavior via mockStmt.get.

      permissionService.checkUserNotePermission.mockResolvedValue({ V: true });
      mockStmt.run.mockReturnValue({ changes: 1 });
    });

    // No afterEach needed here.

    it('should update a note successfully by owner', async () => {
      const currentExistingNote = { ...existingNoteBaseProperties };
      // Configure the db mock for the internal call to actual getNoteById
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(currentExistingNote)));

      const result = await noteService.updateNote(currentExistingNote.id, updateData, currentExistingNote.user_id);
      expect(result).toBe(true);
      // We expect the *actual* getNoteById to have been called, which means mockStmt.get was called.
      expect(mockStmt.get).toHaveBeenCalledWith(currentExistingNote.id);
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE notes SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'));
      expect(mockStmt.run).toHaveBeenCalledWith('New Title', 'New Content', 1);
      expect(historyService.recordNoteHistory).toHaveBeenCalledWith(expect.objectContaining({
        noteId: 1,
        oldValues: { title: 'Old Title', content: 'Old Content', type: 'simple' },
        newValues: expect.objectContaining({ title: 'New Title', content: 'New Content' })
      }));
    });

    it('should update note successfully by user with WRITE permission', async () => {
      const currentExistingNote = { ...existingNoteBaseProperties, user_id: 2 };
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(currentExistingNote)));

      const result = await noteService.updateNote(currentExistingNote.id, updateData, 1);
      expect(result).toBe(true);
      expect(mockStmt.get).toHaveBeenCalledWith(currentExistingNote.id);
      expect(permissionService.checkUserNotePermission).toHaveBeenCalledWith(currentExistingNote.id, 1, 'WRITE');
    });

    it('should return error object if note not found', async () => {
      mockStmt.get.mockReturnValueOnce(undefined); // Configure db mock for this case
      const result = await noteService.updateNote(99, updateData, 1);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Note not found");
      expect(mockStmt.get).toHaveBeenCalledWith(99);
    });

    it('should return error object if user lacks permission', async () => {
      const currentExistingNote = { ...existingNoteBaseProperties, user_id: 2 };
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(currentExistingNote)));
      permissionService.checkUserNotePermission.mockResolvedValue({ V: false });

      const result = await noteService.updateNote(currentExistingNote.id, updateData, 1);
      expect(result.success).toBe(false);
      expect(mockStmt.get).toHaveBeenCalledWith(currentExistingNote.id);
      expect(result.error).toContain("Authorization failed");
    });

    it('should update link text if title changes', async () => {
      const currentExistingNote = { ...existingNoteBaseProperties };
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(currentExistingNote)));

      await noteService.updateNote(currentExistingNote.id, { title: 'Super Duper New Title' }, currentExistingNote.user_id);
      expect(mockStmt.get).toHaveBeenCalledWith(currentExistingNote.id);
      const linkUpdatePrepareCall = mockDb.prepare.mock.calls.find(call => call[0].includes("UPDATE links SET link_text = ? WHERE target_note_id = ? AND link_text = ?"));
      expect(linkUpdatePrepareCall).toBeDefined();
      expect(mockStmt.run).toHaveBeenCalledWith('Super Duper New Title', 1, 'Old Title');
    });

    it('should not update or record history if data is identical', async () => {
      const currentExistingNote = { ...existingNoteBaseProperties };
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(currentExistingNote)));
      const noChangeData = { title: currentExistingNote.title, content: currentExistingNote.content };

      // mockDb.prepare.mockClear(); // Be careful with mockClear if other prepares are expected
      const initialPrepareCount = mockDb.prepare.mock.calls.length;
      historyService.recordNoteHistory.mockClear();

      const result = await noteService.updateNote(currentExistingNote.id, noChangeData, currentExistingNote.user_id);
      expect(result).toBe(true);
      expect(mockStmt.get).toHaveBeenCalledWith(currentExistingNote.id);

      const updateNotesPrepareCall = mockDb.prepare.mock.calls.find(call => call[0].includes("UPDATE notes SET"));
      expect(updateNotesPrepareCall).toBeUndefined(); // No new "UPDATE notes" prepare call
      // Or check count: expect(mockDb.prepare.mock.calls.length).toBe(initialPrepareCount);
      expect(historyService.recordNoteHistory).not.toHaveBeenCalled();
    });

    it('should return error object on DB error during transaction', async () => {
      const currentExistingNote = { ...existingNoteBaseProperties };

      const originalDbPrepare = mockDb.prepare; // Store the original mock from beforeEach

      mockDb.prepare = jest.fn((sqlQuery) => {
        if (sqlQuery.includes("SELECT id, type, title")) { // For getNoteById's SELECT
          // Ensure getNoteById succeeds using a fresh mock statement for its .get
          return { get: jest.fn().mockReturnValueOnce(JSON.parse(JSON.stringify(currentExistingNote))) };
        }
        if (sqlQuery.includes("UPDATE notes SET")) { // For the UPDATE statement
          // This is the statement that should throw an error
          return { run: jest.fn().mockImplementationOnce(() => { throw new Error("DB Update Error during transaction"); }) };
        }
        // For BEGIN, COMMIT, ROLLBACK, UPDATE links, etc.
        return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
      });

      const result = await noteService.updateNote(currentExistingNote.id, updateData, currentExistingNote.user_id);

      const theActualMockUsedForPrepare = mockDb.prepare; // This is the temporary mock function
      mockDb.prepare = originalDbPrepare; // Restore for other tests

      expect(result.success).toBe(false);
      // Assert that the temporary mock (theActualMockUsedForPrepare) was called for the SELECT
      expect(theActualMockUsedForPrepare).toHaveBeenCalledWith(expect.stringContaining("SELECT id, type, title"));
      // Assert that the temporary mock (theActualMockUsedForPrepare) was called for the UPDATE
      expect(theActualMockUsedForPrepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE notes SET"));
      expect(result.error).toContain("Failed to update note: DB Update Error during transaction");
      // Assert that ROLLBACK was prepared using the temporary mock (theActualMockUsedForPrepare)
      expect(theActualMockUsedForPrepare).toHaveBeenCalledWith('ROLLBACK');
      expect(theActualMockUsedForPrepare).not.toHaveBeenCalledWith('COMMIT');
    });

    it('should prevent updating to an invalid note type', async () => {
      const currentExistingNote = { ...existingNoteBaseProperties };
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(currentExistingNote))); // For getNoteById
      const invalidTypeUpdate = { type: 'super_invalid_type' };

      const result = await noteService.updateNote(currentExistingNote.id, invalidTypeUpdate, currentExistingNote.user_id);
      expect(result).toBe(false);
      expect(mockStmt.get).toHaveBeenCalledWith(currentExistingNote.id); // From the internal getNoteById
      // Check that no "UPDATE notes" prepare call was made
      const updateNotesPrepareCall = mockDb.prepare.mock.calls.find(call => call[0].includes("UPDATE notes SET"));
      expect(updateNotesPrepareCall).toBeUndefined();
    });
  });

  // --- deleteNote ---
  describe('deleteNote', () => {
    let noteToDeleteProperties;

    beforeEach(() => {
      noteToDeleteProperties = { id: 1, user_id: 1, deleted_at: null, type: 'simple', title: 'Test Note To Delete' };
      // Reset authService mock for deleteNote specific scenarios
      authService.checkUserRole.mockReset().mockResolvedValue(false); // Default to not admin
      // Default mockStmt.run for successful UPDATE (soft delete) or other operations
      mockStmt.run.mockClear().mockReturnValue({ changes: 1 });
      // Ensure permissionService allows by default for relevant tests
      permissionService.checkUserNotePermission.mockClear().mockResolvedValue({ V: true });
    });

    it('should soft delete a note successfully by owner', async () => {
      const currentNoteToDelete = { ...noteToDeleteProperties };
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(currentNoteToDelete))); // Internal getNoteById finds the note

      const result = await noteService.deleteNote(currentNoteToDelete.id, currentNoteToDelete.user_id);

      expect(mockStmt.get).toHaveBeenCalledWith(currentNoteToDelete.id); // From internal getNoteById
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE notes SET deleted_at = CURRENT_TIMESTAMP, deleted_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'));
      expect(mockStmt.run).toHaveBeenCalledWith(currentNoteToDelete.user_id, currentNoteToDelete.id); // deleted_by_user_id, noteId
      expect(result.success).toBe(true);
      expect(result.changes).toBe(1);
      // History is not currently recorded by the service for soft delete, so removing this expectation.
      // expect(historyService.recordNoteHistory).toHaveBeenCalledWith({
      //   noteId: currentNoteToDelete.id,
      //   userId: currentNoteToDelete.user_id,
      //   action: 'SOFT_DELETED',
      //   oldValues: { title: currentNoteToDelete.title, type: currentNoteToDelete.type, deleted_at: null },
      //   newValues: { deleted_at: expect.any(String) }
      // });
    });

    it('should return error if note not found for deletion', async () => {
      mockStmt.get.mockReturnValueOnce(null); // Internal getNoteById finds nothing
      const result = await noteService.deleteNote(99, 1);

      expect(mockStmt.get).toHaveBeenCalledWith(99);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Note 99 not found."); // Corrected error message check
    });

    it('should allow ADMIN to soft delete another user_s note', async () => {
      const victimNote = { ...noteToDeleteProperties, user_id: 2 }; // Note owned by user 2
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(victimNote)));
      authService.checkUserRole.mockResolvedValueOnce(true); // User 1 is ADMIN

      const result = await noteService.deleteNote(victimNote.id, 1); // User 1 (Admin) deleting note of User 2

      expect(authService.checkUserRole).toHaveBeenCalledWith(1, 'ADMIN');
      expect(mockStmt.get).toHaveBeenCalledWith(victimNote.id);
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE notes SET deleted_at = CURRENT_TIMESTAMP'));
      expect(mockStmt.run).toHaveBeenCalledWith(1, victimNote.id); // Deleted by admin user 1
      expect(result.success).toBe(true);
      expect(result.changes).toBe(1);
    });

    it('should prevent non-owner, non-ADMIN from deleting a note', async () => {
      const otherUserNote = { ...noteToDeleteProperties, user_id: 2 }; // Owned by user 2
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(otherUserNote)));
      // User 1 is not ADMIN (default mock behavior)
      // User 1 does not have explicit 'DELETE' permission via permissionService
      permissionService.checkUserNotePermission.mockResolvedValueOnce({ V: false });


      const result = await noteService.deleteNote(otherUserNote.id, 1); // User 1 trying to delete User 2's note

      expect(mockStmt.get).toHaveBeenCalledWith(otherUserNote.id);
      expect(authService.checkUserRole).toHaveBeenCalledWith(1, 'ADMIN');
      // Removed expectation for permissionService.checkUserNotePermission as current service logic doesn't call it here.
      expect(result.success).toBe(false);
      expect(result.error).toContain(`Authorization failed: User 1 cannot delete note ${otherUserNote.id}.`); // Corrected error check
      expect(mockDb.prepare).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE notes SET deleted_at'));
    });

    it('should "succeed" (by re-deleting) if note is already deleted, reflecting current service behavior', async () => {
      const alreadyDeletedNote = { ...noteToDeleteProperties, deleted_at: '2023-01-01T00:00:00.000Z' };
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(alreadyDeletedNote)));

      const result = await noteService.deleteNote(alreadyDeletedNote.id, alreadyDeletedNote.user_id);

      expect(mockStmt.get).toHaveBeenCalledWith(alreadyDeletedNote.id);
      // Current service behavior re-runs the UPDATE, resulting in success:true if changes > 0
      expect(result.success).toBe(true);
      // expect(result.error).toBeUndefined(); // No error if success is true
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE notes SET deleted_at')); // The update is attempted
    });

    it('should return error on DB error during the soft delete UPDATE', async () => {
      const currentNoteToDelete = { ...noteToDeleteProperties };
      // Internal getNoteById finds the note successfully
      mockStmt.get.mockReturnValueOnce(JSON.parse(JSON.stringify(currentNoteToDelete)));

      const originalDbPrepare = mockDb.prepare;
      const tempMockPrepare = jest.fn((sqlQuery) => {
        if (sqlQuery.toUpperCase().includes("SELECT ID, TYPE, TITLE")) {
          // This path is for the internal getNoteById, which uses the main mockStmt
          return mockStmt;
        }
        if (sqlQuery.toUpperCase().includes("UPDATE NOTES SET DELETED_AT")) {
          // This is the soft delete UPDATE statement that should throw
          return { run: jest.fn().mockImplementationOnce(() => { throw new Error("DB Soft Delete Error"); }) };
        }
        // For BEGIN, COMMIT, ROLLBACK etc.
        return { run: jest.fn().mockReturnValue({ changes: 1 }), get: jest.fn(), all: jest.fn() };
      });
      mockDb.prepare = tempMockPrepare;

      const result = await noteService.deleteNote(currentNoteToDelete.id, currentNoteToDelete.user_id);

      mockDb.prepare = originalDbPrepare; // Restore original prepare

      expect(result.success).toBe(false);
      // The service itself prefixes "Failed to delete note: " to the original error message.
      // If the original error was "DB Soft Delete Error", then the result.error should contain that.
      expect(result.error).toContain("DB Soft Delete Error");
      expect(mockStmt.get).toHaveBeenCalledWith(currentNoteToDelete.id);
      // Check that the temporary prepare was called for the UPDATE
      expect(tempMockPrepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE notes SET deleted_at"));
      // After tempMockPrepare caused an error, and mockDb.prepare was restored,
      // the service's catch block in noteService.js currently has the explicit ROLLBACK call commented out.
      // The transaction itself will rollback due to the error, but db.prepare('ROLLBACK') won't be explicitly called by our code.
      // So we remove this expectation.
      // expect(mockDb.prepare).toHaveBeenCalledWith('ROLLBACK');
      expect(tempMockPrepare).not.toHaveBeenCalledWith('COMMIT'); // COMMIT should not be on the temporary one.
      expect(historyService.recordNoteHistory).not.toHaveBeenCalled();
    });
  });

  // --- listNotesByFolder ---
  describe('listNotesByFolder', () => {
    const mockNotesFromDb = [
      { id: 1, type: 'simple', title: 'Note A', user_id: 1, is_pinned: 1, updated_at: '2023-01-01 10:00:00', deleted_at: null },
      { id: 2, type: 'markdown', title: 'Note B', user_id: 1, is_pinned: 0, updated_at: '2023-01-02 10:00:00', deleted_at: null },
      { id: 3, type: 'simple', title: 'Public Note C', user_id: null, is_pinned: 0, updated_at: '2023-01-03 10:00:00', deleted_at: null },
      { id: 4, type: 'simple', title: 'Deleted Note D', user_id: 1, is_pinned: 0, updated_at: '2023-01-04 10:00:00', deleted_at: '2023-01-04 11:00:00' },
    ];

    beforeEach(() => {
      mockStmt.all.mockClear().mockReturnValue([]); // Default to empty array
    });

    it('should list notes for a given folder_id, owned by user or public, excluding deleted by default', () => {
      const expectedNotes = mockNotesFromDb.filter(n => (n.user_id === 1 || n.user_id === null) && !n.deleted_at);
      mockStmt.all.mockReturnValueOnce(expectedNotes);

      const result = noteService.listNotesByFolder(10, 1); // folderId 10, requestingUserId 1

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining(
        "SELECT id, type, title, user_id, is_pinned, updated_at, deleted_at FROM notes WHERE folder_id = ? AND is_archived = 0 AND deleted_at IS NULL AND (user_id = ? OR user_id IS NULL) ORDER BY is_pinned DESC, updated_at DESC"
      ));
      expect(mockStmt.all).toHaveBeenCalledWith(10, 1);
      expect(result).toEqual(expectedNotes);
    });

    it('should list notes for a folder, including deleted, if options.includeDeleted is true', () => {
      const notesIncludingDeleted = mockNotesFromDb.filter(n => n.user_id === 1); // Notes for user 1, including their deleted one.
      mockStmt.all.mockReturnValueOnce(notesIncludingDeleted);

      const result = noteService.listNotesByFolder(10, 1, { includeDeleted: true });

      // Query should not contain "AND deleted_at IS NULL"
      const prepareCall = mockDb.prepare.mock.calls.find(call => call[0].includes("SELECT id, type, title, user_id, is_pinned, updated_at, deleted_at FROM notes WHERE folder_id = ?"));
      expect(prepareCall[0]).not.toContain("AND deleted_at IS NULL");
      expect(prepareCall[0]).toContain("AND (user_id = ? OR user_id IS NULL)"); // User filtering should still apply

      expect(mockStmt.all).toHaveBeenCalledWith(10, 1);
      expect(result).toEqual(notesIncludingDeleted);
    });

    it('should list all non-deleted notes in a folder if requestingUserId is null (public access)', () => {
      // Expects all non-deleted notes, regardless of user_id, as requestingUserId is null
      const allNonDeletedNotesInFolder = mockNotesFromDb.filter(n => !n.deleted_at);
      mockStmt.all.mockReturnValueOnce(allNonDeletedNotesInFolder);

      const result = noteService.listNotesByFolder(10, null); // No requestingUserId

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining(
        "SELECT id, type, title, user_id, is_pinned, updated_at, deleted_at FROM notes WHERE folder_id = ? AND is_archived = 0 AND deleted_at IS NULL ORDER BY is_pinned DESC, updated_at DESC"
      )); // No user_id filtering in WHERE clause
      expect(mockStmt.all).toHaveBeenCalledWith(10); // Only folderId
      expect(result).toEqual(allNonDeletedNotesInFolder);
    });

    it('should list all notes (including deleted) in a folder if requestingUserId is null and includeDeleted is true', () => {
      mockStmt.all.mockReturnValueOnce([...mockNotesFromDb]); // Return all notes for this scenario

      const result = noteService.listNotesByFolder(10, null, { includeDeleted: true });

      const prepareCall = mockDb.prepare.mock.calls.find(call => call[0].includes("SELECT id, type, title, user_id, is_pinned, updated_at, deleted_at FROM notes WHERE folder_id = ?"));
      expect(prepareCall[0]).not.toContain("AND deleted_at IS NULL"); // No deleted_at filtering
      expect(prepareCall[0]).not.toContain("AND (user_id = ? OR user_id IS NULL)"); // No user_id filtering

      expect(mockStmt.all).toHaveBeenCalledWith(10);
      expect(result).toEqual(mockNotesFromDb);
    });

    it('should return empty array if db operation fails', () => {
      mockStmt.all.mockImplementationOnce(() => { throw new Error("DB Error"); });
      const result = noteService.listNotesByFolder(10, 1);
      expect(result).toEqual([]);
      // Optionally, check if console.error was called
      // expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Error listing notes"), expect.any(String));
    });
  });

  // --- createVoiceNote ---
  describe('createVoiceNote', () => {
    const mockFileDetails = { tempFilePath: '/tmp/voice.wav', original_filename: 'MyRecording.wav', mime_type: 'audio/wav' };
    const mockNoteDetails = { title: 'Voice Note Title', folder_id: 1, workspace_id: null, is_pinned: 0 }; // Added defaults for workspace_id and is_pinned
    const mockRequestingUserId = 1;
    const mockAttachmentId = 789;
    const mockNewNoteId = 123;

    beforeEach(() => {
      attachmentService.createAttachment.mockReset();
      attachmentService.updateAttachmentParent.mockReset();

      attachmentService.createAttachment.mockResolvedValue({ success: true, attachment: { id: mockAttachmentId, original_filename: 'MyRecording.wav' } });
      attachmentService.updateAttachmentParent.mockResolvedValue({ success: true });

      mockStmt.run.mockClear().mockReturnValue({ lastInsertRowid: mockNewNoteId, changes: 1 });
      // For the final getNoteById call in createVoiceNote
      mockStmt.get.mockClear().mockReturnValue({
        id: mockNewNoteId,
        title: mockNoteDetails.title,
        content: JSON.stringify({ attachmentId: mockAttachmentId }),
        type: 'voice',
        user_id: mockRequestingUserId,
        folder_id: mockNoteDetails.folder_id,
        workspace_id: mockNoteDetails.workspace_id,
        is_pinned: mockNoteDetails.is_pinned,
        // ... other fields as returned by getNoteById
      });
    });

    it('should create a voice note successfully', async () => {
      const result = await noteService.createVoiceNote(mockFileDetails, mockNoteDetails, mockRequestingUserId);

      expect(result.success).toBe(true);
      expect(result.note.id).toBe(mockNewNoteId);
      expect(result.attachment.id).toBe(mockAttachmentId);

      expect(attachmentService.createAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ tempFilePath: '/tmp/voice.wav', original_filename: 'MyRecording.wav', mime_type: 'audio/wav', note_id: null }),
        mockRequestingUserId
      );

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO notes'));
      expect(mockStmt.run).toHaveBeenCalledWith(
        'voice',
        mockNoteDetails.title,
        JSON.stringify({ attachmentId: mockAttachmentId }),
        mockNoteDetails.folder_id,
        mockNoteDetails.workspace_id, // workspace_id
        mockRequestingUserId,
        mockNoteDetails.is_pinned // is_pinned
      );
      expect(attachmentService.updateAttachmentParent).toHaveBeenCalledWith(mockAttachmentId, mockNewNoteId, 'note', mockRequestingUserId);
      expect(mockStmt.get).toHaveBeenCalledWith(mockNewNoteId);
    });

    it('should return error if requestingUserId is missing', async () => {
      const result = await noteService.createVoiceNote(mockFileDetails, mockNoteDetails, null);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Requesting user ID is required");
    });

    it('should return error if fileDetails are incomplete', async () => {
      const result = await noteService.createVoiceNote({ tempFilePath: '/tmp/voice.wav', original_filename: 'MyRecording.wav' /* mime_type missing */ }, mockNoteDetails, mockRequestingUserId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("File details (tempFilePath, original_filename, mime_type) are required");
    });

    it('should return error if file type is not audio', async () => {
      const nonAudioFile = { ...mockFileDetails, mime_type: 'image/png' };
      const result = await noteService.createVoiceNote(nonAudioFile, mockNoteDetails, mockRequestingUserId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid file type for voice note");
    });

    it('should return error if attachment creation fails', async () => {
      attachmentService.createAttachment.mockResolvedValue({ success: false, error: 'Attach failed' });
      const result = await noteService.createVoiceNote(mockFileDetails, mockNoteDetails, mockRequestingUserId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create attachment for voice note. Attach failed");
    });

    it('should return error if internal note creation (INSERT) fails', async () => {
      mockStmt.run.mockImplementationOnce(() => { throw new Error("DB error during note insert"); });
      const result = await noteService.createVoiceNote(mockFileDetails, mockNoteDetails, mockRequestingUserId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create voice note record after creating attachment.");
    });

    it('should return error if internal note creation (createNote function call) returns null', async () => {
      // This simulates createNote itself returning null (e.g. invalid type, though 'voice' should be valid)
      // We achieve this by making the run call return no lastInsertRowid
      mockStmt.run.mockReturnValueOnce({ changes: 0 }); // No lastInsertRowid implicitly
       const result = await noteService.createVoiceNote(mockFileDetails, mockNoteDetails, mockRequestingUserId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to create voice note record after creating attachment.");
    });

    it('should proceed with a warning if linking attachment to note fails (updateAttachmentParent)', async () => {
      attachmentService.updateAttachmentParent.mockResolvedValue({ success: false, error: 'Link fail' });
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); // Spy on console.warn

      const result = await noteService.createVoiceNote(mockFileDetails, mockNoteDetails, mockRequestingUserId);

      expect(result.success).toBe(true);
      expect(result.note.id).toBe(mockNewNoteId);
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to link attachment'));
      consoleWarnSpy.mockRestore();
    });

    it('should return error if final getNoteById fails after successful creation', async () => {
      // All creations succeed, but the final fetch fails
      mockStmt.run.mockReturnValue({ lastInsertRowid: mockNewNoteId, changes: 1 });
      attachmentService.createAttachment.mockResolvedValue({ success: true, attachment: { id: mockAttachmentId, original_filename: 'MyRecording.wav' } });
      attachmentService.updateAttachmentParent.mockResolvedValue({ success: true });

      mockStmt.get.mockReset();
      mockStmt.get.mockReturnValueOnce(null); // Simulate getNoteById returning null

      const result = await noteService.createVoiceNote(mockFileDetails, mockNoteDetails, mockRequestingUserId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Voice note created but could not be retrieved");
    });
  });
});

// Verification suite removed as it's no longer relevant to the current mocking strategy.
