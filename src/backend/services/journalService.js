// src/backend/services/journalService.js
const { getDb } = require('../../../db'); // Adjusted path
const noteService = require('./noteService');
const tagService = require('../../../tagService'); // Corrected path to root
const { processBackendPlaceholders, formatDate } = require('../utils/placeholderUtils');

const DEFAULT_DAILY_NOTE_PREFIX = "Journal ";
const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD'; // Used by formatDate utility

/**
 * Finds an existing daily note or creates a new one for the given date.
 * @param {object} params
 * @param {Date} params.date - The target date for the daily note.
 * @param {number} params.requestingUserId - The ID of the user.
 * @param {object} [params.config={}] - Configuration options.
 * @param {number|null} [params.config.folderId=null] - Optional folder ID for daily notes.
 * @param {number|null} [params.config.dailyNoteTemplateId=null] - Optional template ID to use.
 * @param {string|null} [params.config.titlePrefix=DEFAULT_DAILY_NOTE_PREFIX] - Title prefix.
 * @param {string|null} [params.config.titleDateFormat=DEFAULT_DATE_FORMAT] - Date format for title.
 * @param {string|null} [params.config.autoTag=null] - Optional tag to automatically add (e.g., 'daily_note').
 * @returns {Promise<object|null>} The daily note object (created or found), or null on error.
 */
async function getOrCreateDailyNote({
  date,
  requestingUserId,
  config = {}
}) {
  const {
    folderId = null,
    dailyNoteTemplateId = null,
    titlePrefix = DEFAULT_DAILY_NOTE_PREFIX,
    titleDateFormat = DEFAULT_DATE_FORMAT,
    autoTag = null // e.g., "daily_note" or "journal"
  } = config;

  if (!date || !requestingUserId) {
    console.error("[journalService] Date and requestingUserId are required.");
    return null;
  }

  const formattedDate = formatDate(date, titleDateFormat);
  const expectedTitle = `${titlePrefix}${formattedDate}`;

  const db = getDb();

  try {
    // 1. Search for existing daily note
    // Prioritize folderId if provided. Match on title, user_id, and the date part of created_at.
    // Note: Using date(created_at) is good for finding notes *created on* that day.
    // If a daily note could be *moved* to a different created_at date but still represent that day,
    // a dedicated 'journal_date' column would be more robust. For now, this matches creation day.
    let existingNoteSql = `
      SELECT * FROM notes
      WHERE title = ? AND user_id = ? AND date(created_at) = date(?) AND deleted_at IS NULL
    `;
    const queryParams = [expectedTitle, requestingUserId, formatDate(date, 'YYYY-MM-DD')]; // Use YYYY-MM-DD for SQL date comparison

    if (folderId !== null) {
      existingNoteSql += " AND folder_id = ?";
      queryParams.push(folderId);
    }
    existingNoteSql += " LIMIT 1";

    // console.log("[journalService] Searching for existing note:", existingNoteSql, queryParams);
    const existingNote = db.prepare(existingNoteSql).get(...queryParams);

    if (existingNote) {
      // console.log("[journalService] Found existing daily note:", existingNote.id);
      if (existingNote.hasOwnProperty('is_completed')) { // Ensure boolean conversion if field exists
        existingNote.is_completed = !!existingNote.is_completed;
      }
      // Also ensure is_template is boolean, though it should be 0 for daily notes
      if (existingNote.hasOwnProperty('is_template')) {
          existingNote.is_template = !!existingNote.is_template;
      }
      return existingNote;
    }

    // 2. If not found, create new daily note
    // console.log("[journalService] Creating new daily note for:", formattedDate);
    let noteContent = "";
    let noteType = 'markdown'; // Default type

    if (dailyNoteTemplateId) {
      // Fetch template bypassing regular read permissions if it's a system-wide template or owned by user
      // For now, assume requestingUserId should have access or it's a public template.
      // Using bypassPermissionCheck: true might be too permissive if templates have strict ownership.
      // Let's assume getNoteById with requestingUserId is fine, it handles public templates.
      const templateNote = await noteService.getNoteById(dailyNoteTemplateId, requestingUserId, { bypassPermissionCheck: false });
      if (templateNote && templateNote.is_template) { // Ensure it's actually a template
        noteContent = processBackendPlaceholders(templateNote.content || '', date);
        noteType = templateNote.type || 'markdown';
        // console.log(`[journalService] Using template ${dailyNoteTemplateId} for new daily note.`);
      } else {
        console.warn(`[journalService] Daily note template ${dailyNoteTemplateId} not found, not accessible, or not marked as template.`);
      }
    }

    const newNoteData = {
      title: expectedTitle,
      content: noteContent,
      type: noteType,
      userId: requestingUserId,
      folder_id: folderId,
      is_template: 0, // Daily notes themselves are not templates
    };

    const newNoteId = await noteService.createNote(newNoteData);
    if (!newNoteId) {
      console.error("[journalService] Failed to create new daily note via noteService.");
      return null;
    }

    // Fetch the newly created note to return the full object
    const newDailyNote = await noteService.getNoteById(newNoteId, requestingUserId, { bypassPermissionCheck: false });

    if (newDailyNote && autoTag) {
      try {
        const tag = await tagService.findOrCreateTag(autoTag);
        if (tag && tag.id) {
          await tagService.addTagToNote(newDailyNote.id, tag.id);
          // console.log(`[journalService] Auto-tagged daily note ${newDailyNote.id} with '${autoTag}'.`);
        }
      } catch (tagError) {
        console.error(`[journalService] Failed to auto-tag daily note ${newDailyNote.id}:`, tagError);
      }
    }
    return newDailyNote;

  } catch (error) {
    console.error(`[journalService] Error in getOrCreateDailyNote for date ${formattedDate}:`, error);
    return null;
  }
}

module.exports = {
  getOrCreateDailyNote,
  DEFAULT_DAILY_NOTE_PREFIX,
  DEFAULT_DATE_FORMAT
};
