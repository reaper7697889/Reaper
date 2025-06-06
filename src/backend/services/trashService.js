// src/backend/services/trashService.js
const { getDb } = require('../db');
const noteService = require('./noteService');
const databaseRowService = require('./databaseRowService');
const userService = require('./userService'); // To validate user IDs if needed, or get usernames
const databaseDefService = require('./databaseDefService');

/**
 * Lists soft-deleted items for a user.
 * Users can see items they own or items they were the one to delete.
 * @param {number} requestingUserId - The ID of the user making the request.
 * @param {object} [options={}] - Options for filtering and pagination.
 * @param {string} [options.itemType='all'] - 'all', 'note', or 'database_row'.
 * @param {number} [options.limit=50] - Number of items to return.
 * @param {number} [options.offset=0] - Number of items to skip for pagination.
 * @returns {Promise<object>} - { success: boolean, items?: Array<object>, total?: number, error?: string }
 */
async function listDeletedItems(requestingUserId, { itemType = 'all', limit = 50, offset = 0 } = {}) {
  if (requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "Requesting user ID is required." };
  }

  const db = getDb();
  let results = [];

  try {
    // Fetch deleted notes
    if (itemType === 'note' || itemType === 'all') {
      const notesQuery = `
        SELECT
          n.id, n.title, n.type as noteType, n.user_id as owner_id,
          n.deleted_at, n.deleted_by_user_id,
          u_deleted.username as deleted_by_username,
          u_owner.username as owner_username
        FROM notes n
        LEFT JOIN users u_deleted ON n.deleted_by_user_id = u_deleted.id
        LEFT JOIN users u_owner ON n.user_id = u_owner.id
        WHERE n.deleted_at IS NOT NULL
          AND (n.user_id = ? OR n.deleted_by_user_id = ?)
      `;
      // In this context, user_id = ? refers to original owner, deleted_by_user_id = ? refers to who deleted it.
      // A user should see items they owned that are deleted, or items they deleted (even if owned by someone else they had access to delete).
      const deletedNotes = db.prepare(notesQuery).all(requestingUserId, requestingUserId);
      deletedNotes.forEach(row => {
        results.push({
          type: 'note',
          id: row.id,
          name: row.title || 'Untitled Note',
          itemTypeDetail: row.noteType, // Original note type
          ownerId: row.owner_id,
          ownerUsername: row.owner_username,
          deletedAt: row.deleted_at,
          deletedByUserId: row.deleted_by_user_id,
          deletedByUsername: row.deleted_by_username,
        });
      });
    }

    // Fetch deleted database rows
    if (itemType === 'database_row' || itemType === 'all') {
      const rowsQuery = `
        SELECT
          dr.id, dr.database_id,
          nd.name as database_name, nd.user_id as db_owner_id,
          u_db_owner.username as db_owner_username,
          dr.deleted_at, dr.deleted_by_user_id,
          u_deleted.username as deleted_by_username
        FROM database_rows dr
        JOIN note_databases nd ON dr.database_id = nd.id
        LEFT JOIN users u_deleted ON dr.deleted_by_user_id = u_deleted.id
        LEFT JOIN users u_db_owner ON nd.user_id = u_db_owner.id
        WHERE dr.deleted_at IS NOT NULL
          AND (nd.user_id = ? OR dr.deleted_by_user_id = ?)
      `;
      // Similar logic: user should see rows from DBs they own, or rows they personally deleted.
      const deletedRows = db.prepare(rowsQuery).all(requestingUserId, requestingUserId);
      deletedRows.forEach(row => {
        results.push({
          type: 'database_row',
          id: row.id,
          name: `Row ${row.id} in '${row.database_name}'`,
          itemTypeDetail: 'row',
          databaseId: row.database_id,
          dbOwnerId: row.db_owner_id,
          dbOwnerUsername: row.db_owner_username,
          deletedAt: row.deleted_at,
          deletedByUserId: row.deleted_by_user_id,
          deletedByUsername: row.deleted_by_username,
        });
      });
    }

    // Combine and Sort
    results.sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());

    const total = results.length;
    const paginatedResults = results.slice(offset, offset + limit);

    return { success: true, items: paginatedResults, total };

  } catch (error) {
    console.error(`Error listing deleted items for user ${requestingUserId}:`, error);
    return { success: false, error: "Failed to retrieve deleted items." };
  }
}

/**
 * Restores a soft-deleted note.
 * @param {number} noteId - The ID of the note to restore.
 * @param {number} requestingUserId - The ID of the user making the request.
 * @returns {Promise<object>} - Result from noteService.updateNote or error object.
 */
async function restoreNote(noteId, requestingUserId) {
  if (!noteId || requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "Note ID and requesting user ID are required." };
  }

  try {
    // Fetch note with includeDeleted: true and bypassPermissionCheck: true to get its raw state
    const note = await noteService.getNoteById(noteId, null, { includeDeleted: true, bypassPermissionCheck: true });

    if (!note) {
      return { success: false, error: "Note not found." };
    }
    if (!note.deleted_at) {
      return { success: false, error: "Note is not deleted." };
    }

    // Authorization: User must be the original owner OR the one who deleted it.
    const isOwner = note.user_id === requestingUserId;
    const isDeleter = note.deleted_by_user_id === requestingUserId;

    if (!isOwner && !isDeleter) {
      return { success: false, error: "Authorization failed: You cannot restore this note." };
    }

    // requestingUserId for updateNote should be the user performing the action,
    // who has now been authorized. updateNote will do its own permission checks if needed,
    // but owner/deleter should have rights to "update" it by undeleting.
    const updateResult = await noteService.updateNote(
      noteId,
      { deleted_at: null, deleted_by_user_id: null },
      requestingUserId
    );

    return updateResult; // This will be { success: true } or { success: false, error: ... }

  } catch (error) {
    console.error(`Error restoring note ${noteId} for user ${requestingUserId}:`, error);
    return { success: false, error: error.message || "Failed to restore note." };
  }
}

/**
 * Restores a soft-deleted database row.
 * @param {number} rowId - The ID of the database row to restore.
 * @param {number} requestingUserId - The ID of the user making the request.
 * @returns {Promise<object>} - Result from databaseRowService.updateRow or error object.
 */
async function restoreDatabaseRow(rowId, requestingUserId) {
  if (!rowId || requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "Row ID and requesting user ID are required." };
  }

  try {
    // Fetch row with includeDeleted: true.
    // Pass null for requestingUserId in getRow to bypass its normal permission checks,
    // as we need to check against db owner or original deleter.
    const row = await databaseRowService.getRow(rowId, null, { includeDeleted: true });

    if (!row) {
      return { success: false, error: "Database row not found." };
    }
    if (!row.deleted_at) {
      return { success: false, error: "Database row is not deleted." };
    }

    // Authorization: User must own the parent database OR have been the one who deleted the row.
    const dbDef = await databaseDefService.getDatabaseById(row.database_id, null); // Fetch DB def unfiltered for owner check
    if (!dbDef) {
        // Should not happen if row exists, implies inconsistent data or error in getDatabaseById
        return { success: false, error: "Could not find parent database for the row."};
    }

    const isDbOwner = dbDef.user_id === requestingUserId;
    const isDeleter = row.deleted_by_user_id === requestingUserId;

    if (!isDbOwner && !isDeleter) {
      return { success: false, error: "Authorization failed: You cannot restore this database row." };
    }

    // requestingUserId for updateRow is the user performing the action.
    // databaseRowService.updateRow will perform its own check that this user can access the parent DB.
    const updateResult = await databaseRowService.updateRow({
      rowId,
      values: { deleted_at: null, deleted_by_user_id: null },
      requestingUserId
    });

    return updateResult;

  } catch (error) {
    console.error(`Error restoring database row ${rowId} for user ${requestingUserId}:`, error);
    return { success: false, error: error.message || "Failed to restore database row." };
  }
}

module.exports = {
  listDeletedItems,
  restoreNote,
  restoreDatabaseRow,
};
