// src/backend/services/noteService.test.js

const noteService = require('./noteService');
const { getDb } = require('../../../db'); // Corrected path
const historyService = require('./historyService');
const permissionService = require('./permissionService');
const attachmentService = require('../../../attachmentService'); // Root file
const authService = require('./authService');

// Mock all imported modules
jest.mock('../../../db');
jest.mock('./historyService');
jest.mock('./permissionService');
jest.mock('../../../attachmentService');
jest.mock('./authService');

describe('Note Service', () => {
  let mockDb;
  let mockStmt;

  beforeEach(() => {
    jest.clearAllMocks();

    mockStmt = { run: jest.fn(), get: jest.fn(), all: jest.fn() };
    mockDb = {
      prepare: jest.fn().mockReturnValue(mockStmt),
      // Corrected mock for db.transaction:
      // db.transaction(callback) returns a new function.
      // That new function, when called, executes the callback.
      transaction: jest.fn(callback => {
        return (...args) => callback(...args);
      }),
    };
    getDb.mockReturnValue(mockDb);

    historyService.recordNoteHistory.mockResolvedValue({ success: true });
    permissionService.checkUserNotePermission.mockResolvedValue({ V: true });
    authService.getUserWithRole.mockResolvedValue({ id: 1, username: 'testuser', role: 'EDITOR' });
    authService.checkUserRole.mockResolvedValue(false);
    // Add default mock for attachmentService if its functions are called by noteService directly
    // For now, noteService.createNote doesn't directly call attachmentService (voiceNote does)
    // For getNoteById, no direct calls.
  });

  // --- createNote ---
  describe('createNote', () => {
    it('should create a note successfully', async () => {
      mockStmt.run.mockReturnValue({ lastInsertRowid: 123 });
      const noteData = { type: 'simple', title: 'Test Note', content: 'Test Content', userId: 1 };
      const newNoteId = await noteService.createNote(noteData);

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
      // Simulate stmt.run() throwing an error.
      // The transaction itself will proceed, but the operation within it will fail.
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
      // Ensure the other version of the call (without AND deleted_at IS NULL) is NOT called in this specific test's context if this is the only prepare call.
      // This can be tricky if the function internally might call prepare multiple times with different SQL.
      // For this test, we assume one relevant 'prepare' call for the main query.
      const prepareCalls = mockDb.prepare.mock.calls;
      const relevantCall = prepareCalls.find(call => call[0].includes("SELECT id, type, title, content, folder_id, workspace_id, user_id, is_pinned, is_archived, created_at, updated_at, deleted_at, deleted_by_user_id FROM notes WHERE id = ?"));
      expect(relevantCall[0]).not.toContain("AND deleted_at IS NULL");
    });
  });

  // Placeholders for tests to be added in subsequent steps
  describe('updateNote', () => { it.todo('Tests for updateNote'); });
  describe('deleteNote', () => { it.todo('Tests for deleteNote'); });
  describe('listNotesByFolder', () => { it.todo('Tests for listNotesByFolder'); });
  describe('createVoiceNote', () => { it.todo('Tests for createVoiceNote'); });

});
