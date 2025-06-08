// src/backend/services/journalService.test.js

const journalService = require('./journalService');
const { getDb } = require('../../../db');
const noteService = require('./noteService');
const tagService = require('../../../tagService'); // Corrected path for require
const placeholderUtils = require('../utils/placeholderUtils');

// Mock dependencies
jest.mock('../../../db');
jest.mock('./noteService');
jest.mock('../../../tagService'); // Corrected path
jest.mock('../utils/placeholderUtils');

describe('Journal Service - getOrCreateDailyNote', () => {
  let mockDb;
  let mockStmt;
  const mockDate = new Date('2023-10-27T12:00:00.000Z'); // Use a fixed date
  const mockUserId = 1;
  const mockFormattedDate = '2023-10-27'; // Expected output from our formatDate mock for this date
  const expectedDefaultTitle = `Journal ${mockFormattedDate}`;

  beforeEach(() => {
    jest.clearAllMocks();

    mockStmt = { get: jest.fn(), run: jest.fn() };
    mockDb = { prepare: jest.fn().mockReturnValue(mockStmt) };
    getDb.mockReturnValue(mockDb);

    placeholderUtils.formatDate.mockImplementation((date, format) => {
      if (format === 'YYYY-MM-DD' && date.toISOString().startsWith('2023-10-27')) {
        return '2023-10-27';
      }
      // Fallback for any other date/format combination if tests use them
      const year = date.getFullYear();
      const month = (`0${date.getMonth() + 1}`).slice(-2);
      const day = (`0${date.getDate()}`).slice(-2);
      return `${year}-${month}-${day}`;
    });
    placeholderUtils.processBackendPlaceholders.mockImplementation((content, _date) => `processed:${content || ''}`);

    noteService.getNoteById.mockResolvedValue(null);
    noteService.createNote.mockResolvedValue(null);

    tagService.findOrCreateTag.mockResolvedValue({ id: 500, name: 'mockedTag' });
    tagService.addTagToNote.mockResolvedValue({ success: true });

    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
    console.warn.mockRestore();
  });

  const baseParams = { date: mockDate, requestingUserId: mockUserId };

  it('should return null and log error if date is missing', async () => {
    const result = await journalService.getOrCreateDailyNote({ requestingUserId: mockUserId });
    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Date and requestingUserId are required"));
  });

  it('should return null and log error if requestingUserId is missing', async () => {
    const result = await journalService.getOrCreateDailyNote({ date: mockDate });
    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Date and requestingUserId are required"));
  });

  it('should find and return an existing daily note', async () => {
    const existingNote = { id: 10, title: expectedDefaultTitle, user_id: mockUserId, content: 'Existing content', is_template: 0 };
    mockStmt.get.mockReturnValueOnce(existingNote);

    const result = await journalService.getOrCreateDailyNote(baseParams);
    // Temporarily expect existingNote as is; service should add is_completed
    expect(result).toEqual(existingNote);
    const expectedSqlRegexNonFolder = /SELECT\s*\*\s*FROM\s*notes\s*WHERE\s*title\s*=\s*\?\s*AND\s*user_id\s*=\s*\?\s*AND\s*date\(created_at\)\s*=\s*date\(\?\)\s*AND\s*deleted_at\s*IS\s*NULL\s*LIMIT\s*1/;
    expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringMatching(expectedSqlRegexNonFolder));
    expect(mockStmt.get).toHaveBeenCalledWith(expectedDefaultTitle, mockUserId, mockFormattedDate);
    expect(noteService.createNote).not.toHaveBeenCalled();
  });

  it('should find existing daily note in a specific folder if folderId is provided', async () => {
    const existingNote = { id: 11, title: expectedDefaultTitle, user_id: mockUserId, folder_id: 7, is_template: 0 };
    mockStmt.get.mockReturnValueOnce(existingNote);
    const paramsWithFolder = { ...baseParams, config: { folderId: 7 } };

    await journalService.getOrCreateDailyNote(paramsWithFolder);
    const expectedSqlRegexFolder = /SELECT\s*\*\s*FROM\s*notes\s*WHERE\s*title\s*=\s*\?\s*AND\s*user_id\s*=\s*\?\s*AND\s*date\(created_at\)\s*=\s*date\(\?\)\s*AND\s*deleted_at\s*IS\s*NULL\s*AND\s*folder_id\s*=\s*\?\s*LIMIT\s*1/;
    expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringMatching(expectedSqlRegexFolder));
    expect(mockStmt.get).toHaveBeenCalledWith(expectedDefaultTitle, mockUserId, mockFormattedDate, 7);
  });

  it('should create a new daily note with default title if none exists', async () => {
    mockStmt.get.mockReturnValueOnce(null);
    const newNoteId = 101;
    const createdNote = { id: newNoteId, title: expectedDefaultTitle, content: 'processed:', user_id: mockUserId, type: 'markdown', is_template: 0 };
    noteService.createNote.mockResolvedValueOnce(newNoteId);
    noteService.getNoteById.mockResolvedValueOnce(createdNote);

    const result = await journalService.getOrCreateDailyNote(baseParams);

    expect(noteService.createNote).toHaveBeenCalledWith({
      title: expectedDefaultTitle,
      content: '', // If service passes empty string directly for non-template default
      type: 'markdown',
      userId: mockUserId,
      folder_id: null, // from default config
      is_template: 0
    });
    expect(noteService.getNoteById).toHaveBeenCalledWith(newNoteId, mockUserId, { bypassPermissionCheck: false });
    expect(result).toEqual(createdNote);
  });

  it('should create a new daily note using a specified template', async () => {
    mockStmt.get.mockReturnValueOnce(null);
    const templateId = 200;
    const templateNote = { id: templateId, title: 'Daily Template', content: 'Template Content Here {{date}}', type: 'markdown', is_template: 1 };
    const newNoteId = 102;
    const finalCreatedNote = { id: newNoteId, title: expectedDefaultTitle, content: `processed:Template Content Here {{date}}`, type: templateNote.type, user_id: mockUserId, is_template: 0 };

    noteService.getNoteById.mockImplementation(async (id) => {
      if (id === templateId) return templateNote;
      if (id === newNoteId) return finalCreatedNote;
      return null;
    });
    noteService.createNote.mockResolvedValueOnce(newNoteId);

    const paramsWithTemplate = { ...baseParams, config: { dailyNoteTemplateId: templateId } };
    const result = await journalService.getOrCreateDailyNote(paramsWithTemplate);
    // Check that the template was fetched
    expect(noteService.getNoteById).toHaveBeenCalledWith(templateId, mockUserId, { bypassPermissionCheck: false });
    expect(placeholderUtils.processBackendPlaceholders).toHaveBeenCalledWith(templateNote.content, mockDate);
    expect(noteService.createNote).toHaveBeenCalledWith(expect.objectContaining({
      content: `processed:Template Content Here {{date}}`,
      type: templateNote.type,
    }));
    expect(result).toEqual(finalCreatedNote);
  });

  it('should create with default content if specified template not found, and log warning', async () => {
    mockStmt.get.mockReturnValueOnce(null);
    noteService.getNoteById.mockImplementation(async (id, _userId, options) => {
        if (options && options.bypassPermissionCheck && id === 999) return null; // Template not found
        if (id === 103) return { id: 103, title: expectedDefaultTitle, content: 'processed:', user_id: mockUserId, is_template: 0 }; // New note
        return null;
    });
    noteService.createNote.mockResolvedValueOnce(103);

    const paramsWithBadTemplate = { ...baseParams, config: { dailyNoteTemplateId: 999 } };
    await journalService.getOrCreateDailyNote(paramsWithBadTemplate);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[journalService] Daily note template 999 not found, not accessible, or not marked as template."));
    expect(noteService.createNote).toHaveBeenCalledWith(expect.objectContaining({
      content: '', // Fallback to default empty content
    }));
  });

  it('should apply autoTag if specified', async () => {
    mockStmt.get.mockReturnValueOnce(null);
    const newNoteId = 104;
    const createdNote = { id: newNoteId, title: expectedDefaultTitle, content: 'processed:', user_id: mockUserId, is_template: 0 };
    noteService.createNote.mockResolvedValueOnce(newNoteId);
    noteService.getNoteById.mockResolvedValueOnce(createdNote);
    const mockTag = { id: 501, name: 'daily' };
    tagService.findOrCreateTag.mockResolvedValueOnce(mockTag);

    const paramsWithTag = { ...baseParams, config: { autoTag: 'daily' } };
    await journalService.getOrCreateDailyNote(paramsWithTag);

    expect(tagService.findOrCreateTag).toHaveBeenCalledWith('daily');
    expect(tagService.addTagToNote).toHaveBeenCalledWith(newNoteId, mockTag.id);
  });

  it('should continue successfully even if auto-tagging fails, and log error', async () => {
    mockStmt.get.mockReturnValueOnce(null);
    const newNoteId = 105;
    const createdNote = { id: newNoteId, title: expectedDefaultTitle, content: 'processed:', user_id: mockUserId, is_template: 0 };
    noteService.createNote.mockResolvedValueOnce(newNoteId);
    noteService.getNoteById.mockResolvedValueOnce(createdNote);
    tagService.findOrCreateTag.mockRejectedValueOnce(new Error("Tagging failed"));

    const paramsWithTag = { ...baseParams, config: { autoTag: 'fail_tag' } };
    const result = await journalService.getOrCreateDailyNote(paramsWithTag);

    expect(result).toEqual(createdNote);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`Failed to auto-tag daily note ${newNoteId}`), expect.any(Error));
  });

  it('should use custom title prefix and date format from config', async () => {
    mockStmt.get.mockReturnValueOnce(null);
    const newNoteId = 106;
    const customPrefix = "MyLog ";
    const customDateFormat = "DD-MM-YYYY";
    const customFormattedDate = "27-10-2023"; // Expected from a more robust formatDate
    placeholderUtils.formatDate.mockImplementationOnce((date, format) => {
        if(date.toISOString().startsWith('2023-10-27') && format === customDateFormat) return customFormattedDate;
        return 'fallback-date-format';
    });

    const expectedCustomTitle = `${customPrefix}${customFormattedDate}`;
    const createdNote = { id: newNoteId, title: expectedCustomTitle, content: 'processed:', user_id: mockUserId, is_template: 0 };
    noteService.createNote.mockResolvedValueOnce(newNoteId);
    noteService.getNoteById.mockResolvedValueOnce(createdNote);

    const paramsWithCustomTitle = { ...baseParams, config: { titlePrefix: customPrefix, titleDateFormat: customDateFormat } };
    await journalService.getOrCreateDailyNote(paramsWithCustomTitle);

    expect(placeholderUtils.formatDate).toHaveBeenCalledWith(mockDate, customDateFormat);
    expect(noteService.createNote).toHaveBeenCalledWith(expect.objectContaining({
      title: expectedCustomTitle,
    }));
  });

  it('should return null if noteService.createNote fails', async () => {
    mockStmt.get.mockReturnValueOnce(null);
    noteService.createNote.mockResolvedValueOnce(null);

    const result = await journalService.getOrCreateDailyNote(baseParams);
    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Failed to create new daily note via noteService."));
  });

  it('should return null if internal DB query for existing note fails', async () => {
    mockStmt.get.mockImplementationOnce(() => { throw new Error("DB error finding existing note"); });

    const result = await journalService.getOrCreateDailyNote(baseParams);
    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`Error in getOrCreateDailyNote for date ${mockFormattedDate}`), expect.any(Error));
  });

});
