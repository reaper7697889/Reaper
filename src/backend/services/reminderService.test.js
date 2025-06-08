// src/backend/services/reminderService.test.js

const reminderService = require('./reminderService');
const { getDb } = require('../../../db'); // Adjusted path
const noteService = require('./noteService');

// Mock dependencies
jest.mock('../../../db');
jest.mock('./noteService');

describe('Reminder Service', () => {
  let mockDb;
  let mockStmt;
  const mockUserId = 1;
  const mockNoteId = 10;

  beforeEach(() => {
    jest.clearAllMocks();

    mockStmt = { all: jest.fn(), run: jest.fn() }; // Added run for potential future use
    mockDb = { prepare: jest.fn().mockReturnValue(mockStmt) };
    getDb.mockReturnValue(mockDb);

    // Default for noteService.updateNote called by markReminderAsTriggered
    noteService.updateNote.mockResolvedValue({ success: true });

    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
    console.warn.mockRestore();
  });

  describe('checkPendingReminders', () => {
    it('should return pending reminders for a user', async () => {
      const pendingNotes = [
        { noteId: 1, title: 'Note 1', reminder_at: '2023-01-01 09:00:00' },
        { noteId: 2, title: 'Note 2', reminder_at: '2023-01-01 10:00:00' },
      ];
      mockStmt.all.mockReturnValueOnce(pendingNotes);

      const result = await reminderService.checkPendingReminders(mockUserId);
      expect(result).toEqual(pendingNotes);
      const expectedSqlRegex = /SELECT\s+id\s+AS\s+noteId,\s*title,\s*reminder_at\s+FROM\s+notes\s+WHERE\s+user_id\s*=\s*\?\s+AND\s+reminder_at\s+IS\s+NOT\s+NULL\s+AND\s+reminder_at\s*<=\s*CURRENT_TIMESTAMP\s+AND\s+deleted_at\s+IS\s+NULL\s+AND\s+is_archived\s*=\s*0\s*;\s*/i;
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringMatching(expectedSqlRegex));
      expect(mockStmt.all).toHaveBeenCalledWith(mockUserId);
    });

    it('should return an empty array if no userId is provided', async () => {
      const result = await reminderService.checkPendingReminders(null);
      expect(result).toEqual([]);
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });

    it('should return an empty array if no pending reminders are found', async () => {
      mockStmt.all.mockReturnValueOnce([]);
      const result = await reminderService.checkPendingReminders(mockUserId);
      expect(result).toEqual([]);
    });

    it('should return an empty array and log error if DB query fails', async () => {
      mockStmt.all.mockImplementationOnce(() => { throw new Error('DB Error'); });
      const result = await reminderService.checkPendingReminders(mockUserId);
      expect(result).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(`[reminderService] Error fetching pending reminders for user ${mockUserId}:`),
        expect.any(Error)
      );
    });
  });

  describe('markReminderAsTriggered', () => {
    it('should call noteService.updateNote to set reminder_at to null', async () => {
      const updateResult = { success: true };
      noteService.updateNote.mockResolvedValueOnce(updateResult);

      const result = await reminderService.markReminderAsTriggered(mockNoteId, mockUserId);

      expect(result).toEqual(updateResult);
      expect(noteService.updateNote).toHaveBeenCalledWith(mockNoteId, { reminder_at: null }, mockUserId);
    });

    it('should return error if noteId is missing', async () => {
      const result = await reminderService.markReminderAsTriggered(null, mockUserId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("noteId and requestingUserId are required.");
      expect(noteService.updateNote).not.toHaveBeenCalled();
    });

    it('should return error if requestingUserId is missing', async () => {
      const result = await reminderService.markReminderAsTriggered(mockNoteId, null);
      expect(result.success).toBe(false);
      expect(result.error).toContain("noteId and requestingUserId are required.");
      expect(noteService.updateNote).not.toHaveBeenCalled();
    });

    it('should return error and log if noteService.updateNote fails', async () => {
      const updateError = new Error('Update failed');
      noteService.updateNote.mockRejectedValueOnce(updateError); // Simulate promise rejection

      const result = await reminderService.markReminderAsTriggered(mockNoteId, mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe(updateError.message);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(`[reminderService] Error marking reminder as triggered for note ${mockNoteId}:`),
        updateError
      );
    });

    it('should return error if noteService.updateNote returns {success: false}', async () => {
      const updateResult = { success: false, error: "Specific update error" };
      noteService.updateNote.mockResolvedValueOnce(updateResult);

      const result = await reminderService.markReminderAsTriggered(mockNoteId, mockUserId);
      expect(result).toEqual(updateResult); // Propagate the error object
    });
  });
});
