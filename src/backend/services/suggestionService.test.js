// src/backend/services/suggestionService.test.js

const suggestionService = require('./suggestionService');
const { getDb } = require('../../../db'); // Adjusted path
const noteService = require('./noteService');
const tagService = require('../../../tagService'); // Corrected path to root

// Mock dependencies
jest.mock('../../../db');
jest.mock('./noteService');
jest.mock('../../../tagService'); // Corrected path to root

describe('Suggestion Service - getRelatedNotesByTags', () => {
  let mockDb;
  let mockStmt;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock for db.js
    mockStmt = {
      all: jest.fn(),
      // Add other methods like get, run if suggestionService starts using them directly
    };
    mockDb = {
      prepare: jest.fn().mockReturnValue(mockStmt),
    };
    getDb.mockReturnValue(mockDb);

    // Default mocks for service calls
    // For the primary note check in getRelatedNotesByTags
    noteService.getNoteById.mockResolvedValue({ id: 1, title: 'Current Note', user_id: 1 });
    // For fetching tags of the current note
    tagService.getTagsForNote.mockResolvedValue([{ id: 101, name: 'tagA' }, { id: 102, name: 'tagB' }]);
    // Default for the main DB query returning suggestions
    mockStmt.all.mockReturnValue([]);
  });

  const defaultParams = {
    noteId: 1,
    requestingUserId: 1,
    limit: 5,
  };

  it('should return empty array if current note is not found or not accessible', async () => {
    noteService.getNoteById.mockResolvedValueOnce(null);
    const suggestions = await suggestionService.getRelatedNotesByTags(defaultParams);
    expect(suggestions).toEqual([]);
    expect(noteService.getNoteById).toHaveBeenCalledWith(defaultParams.noteId, defaultParams.requestingUserId, { bypassPermissionCheck: false });
    expect(tagService.getTagsForNote).not.toHaveBeenCalled();
  });

  it('should return empty array if current note has no tags', async () => {
    tagService.getTagsForNote.mockResolvedValueOnce([]);
    const suggestions = await suggestionService.getRelatedNotesByTags(defaultParams);
    expect(suggestions).toEqual([]);
    expect(tagService.getTagsForNote).toHaveBeenCalledWith(defaultParams.noteId);
    expect(mockDb.prepare).not.toHaveBeenCalled();
  });

  it('should correctly query for related notes based on shared tags, permissions, and excluding templates', async () => {
    const mockSuggestionsFromDb = [
      { id: 2, title: 'Related Note 1', user_id: 1, type: 'simple', is_template: 0, updated_at: '2023-01-01', shared_tag_count: 2 },
      { id: 3, title: 'Related Public Note', user_id: null, type: 'markdown', is_template: 0, updated_at: '2023-01-02', shared_tag_count: 1 },
    ];
    mockStmt.all.mockReturnValueOnce(mockSuggestionsFromDb);

    const suggestions = await suggestionService.getRelatedNotesByTags(defaultParams);

    expect(suggestions).toEqual(mockSuggestionsFromDb);
    expect(mockDb.prepare).toHaveBeenCalledTimes(1);
    const sqlQuery = mockDb.prepare.mock.calls[0][0];

    // Check key parts of the SQL query
    expect(sqlQuery).toContain('SELECT');
    expect(sqlQuery).toContain('n.id != ?');
    expect(sqlQuery).toContain('n.deleted_at IS NULL');
    expect(sqlQuery).toContain('nt.tag_id IN (?,?)'); // Based on 2 tags from default mock
    expect(sqlQuery).toContain('(n.user_id = ? OR n.user_id IS NULL)');
    expect(sqlQuery).toContain('n.is_template = 0');
    expect(sqlQuery).toContain('GROUP BY n.id, n.title, n.user_id, n.type, n.is_template, n.updated_at'); // Ensure all selected non-aggregated columns are here
    expect(sqlQuery).toContain('ORDER BY shared_tag_count DESC, n.updated_at DESC');
    expect(sqlQuery).toContain('LIMIT ?');

    expect(mockStmt.all).toHaveBeenCalledWith(
      defaultParams.noteId,     // for n.id != ?
      101, 102,                 // tag IDs from mock
      defaultParams.requestingUserId, // for permission check
      defaultParams.limit       // for LIMIT
    );
  });

  it('should return empty array if no notes share tags', async () => {
    mockStmt.all.mockReturnValueOnce([]); // DB returns no matches
    const suggestions = await suggestionService.getRelatedNotesByTags(defaultParams);
    expect(suggestions).toEqual([]);
  });

  it('should handle a single tag for the current note', async () => {
    tagService.getTagsForNote.mockResolvedValueOnce([{ id: 101, name: 'tagA' }]);
    mockStmt.all.mockReturnValueOnce([]); // For simplicity, just check query construction

    await suggestionService.getRelatedNotesByTags(defaultParams);

    expect(mockDb.prepare).toHaveBeenCalledTimes(1);
    const sqlQuery = mockDb.prepare.mock.calls[0][0];
    expect(sqlQuery).toContain('nt.tag_id IN (?)'); // Single placeholder
    expect(mockStmt.all).toHaveBeenCalledWith(
      defaultParams.noteId, 101, defaultParams.requestingUserId, defaultParams.limit
    );
  });

  it('should return empty array and log error if DB query fails', async () => {
    mockStmt.all.mockImplementationOnce(() => { throw new Error('DB Query Failed'); });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); // Spy on console.error

    const suggestions = await suggestionService.getRelatedNotesByTags(defaultParams);

    expect(suggestions).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[suggestionService] Error fetching related notes for note ${defaultParams.noteId} by tags:`),
      expect.any(Error)
    );
    consoleErrorSpy.mockRestore();
  });

  it('should use default limit if not provided', async () => {
    const paramsWithoutLimit = { noteId: 1, requestingUserId: 1 };
    // tagService and noteService mocks will use defaults from beforeEach
    await suggestionService.getRelatedNotesByTags(paramsWithoutLimit);

    expect(mockStmt.all).toHaveBeenCalledWith(
      paramsWithoutLimit.noteId,
      101, 102, // Default tag IDs
      paramsWithoutLimit.requestingUserId,
      10 // Default limit from function signature
    );
  });

});
