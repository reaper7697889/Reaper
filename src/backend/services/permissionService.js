// src/backend/services/permissionService.js
const { getDb } = require('../db');
const noteService = require('./noteService');
const userService = require('./userService');

/**
 * Grants a permission level for a note to a target user.
 * @param {number} noteId - The ID of the note.
 * @param {number} targetUserId - The ID of the user to grant permission to.
 * @param {string} permissionLevel - 'READ' or 'WRITE'.
 * @param {number} grantingUserId - The ID of the user granting the permission (must be note owner).
 * @returns {Promise<object>} - { success: boolean, permission?: object, error?: string }
 */
async function grantNotePermission(noteId, targetUserId, permissionLevel, grantingUserId) {
  const db = getDb();
  try {
    if (!noteId || !targetUserId || !permissionLevel || !grantingUserId) {
      return { success: false, error: "Note ID, target user ID, permission level, and granting user ID are required." };
    }

    const grantingUser = await userService.getUserById(grantingUserId);
    if (!grantingUser) {
      return { success: false, error: `Granting user ID ${grantingUserId} not found.` };
    }

    // Fetch note unfiltered to check current ownership
    const note = await noteService.getNoteById(noteId, null, { bypassPermissionCheck: true }); // Bypassing normal permission check for ownership validation
    if (!note) {
      return { success: false, error: `Note ID ${noteId} not found.` };
    }

    // Authorization: Only the note owner can grant permissions.
    if (note.user_id !== grantingUserId) {
      return { success: false, error: "Authorization failed: Only the note owner can grant permissions." };
    }

    const targetUser = await userService.getUserById(targetUserId);
    if (!targetUser) {
      return { success: false, error: `Target user ID ${targetUserId} not found.` };
    }

    if (targetUserId === grantingUserId) {
      return { success: false, error: "Cannot grant permission to oneself; owner inherently has all permissions." };
    }

    if (permissionLevel !== 'READ' && permissionLevel !== 'WRITE') {
      return { success: false, error: "Invalid permission level. Must be 'READ' or 'WRITE'." };
    }

    const stmt = db.prepare(
      `REPLACE INTO note_permissions (note_id, user_id, permission_level, granted_by_user_id)
       VALUES (?, ?, ?, ?)`
    );
    const info = stmt.run(noteId, targetUserId, permissionLevel, grantingUserId);

    // Fetch the created/updated permission record to return
    const newPermissionRecord = db.prepare("SELECT * FROM note_permissions WHERE note_id = ? AND user_id = ?").get(noteId, targetUserId);

    return { success: true, permission: newPermissionRecord };

  } catch (error) {
    console.error(`Error in grantNotePermission (note ${noteId}, targetUser ${targetUserId}, granter ${grantingUserId}):`, error);
    return { success: false, error: error.message || "Failed to grant note permission." };
  }
}

/**
 * Revokes a permission for a note from a target user.
 * @param {number} noteId - The ID of the note.
 * @param {number} targetUserId - The ID of the user whose permission is to be revoked.
 * @param {number} revokingUserId - The ID of the user revoking the permission (must be note owner).
 * @returns {Promise<object>} - { success: boolean, changes?: number, error?: string }
 */
async function revokeNotePermission(noteId, targetUserId, revokingUserId) {
  const db = getDb();
  try {
    if (!noteId || !targetUserId || !revokingUserId) {
      return { success: false, error: "Note ID, target user ID, and revoking user ID are required." };
    }

    const revokingUser = await userService.getUserById(revokingUserId);
     if (!revokingUser) {
      return { success: false, error: `Revoking user ID ${revokingUserId} not found.` };
    }

    const note = await noteService.getNoteById(noteId, null, { bypassPermissionCheck: true }); // Bypassing normal permission check for ownership validation
    if (!note) {
      return { success: false, error: `Note ID ${noteId} not found.` };
    }

    // Authorization: Only the note owner can revoke permissions.
    if (note.user_id !== revokingUserId) {
      return { success: false, error: "Authorization failed: Only the note owner can revoke permissions." };
    }

    // It's okay if the target user doesn't exist, the delete will just affect 0 rows.
    // const targetUser = await userService.getUserById(targetUserId);
    // if (!targetUser) {
    //   return { success: false, error: `Target user ID ${targetUserId} not found.` };
    // }


    const stmt = db.prepare("DELETE FROM note_permissions WHERE note_id = ? AND user_id = ?");
    const info = stmt.run(noteId, targetUserId);

    return { success: true, changes: info.changes };

  } catch (error) {
    console.error(`Error in revokeNotePermission (note ${noteId}, targetUser ${targetUserId}, revoker ${revokingUserId}):`, error);
    return { success: false, error: error.message || "Failed to revoke note permission." };
  }
}

/**
 * Gets all permissions for a specific note.
 * @param {number} noteId - The ID of the note.
 * @param {number} requestingUserId - The ID of the user requesting the permissions (must be note owner).
 * @returns {Promise<Array<object>|object>} - Array of permission objects or error object.
 */
async function getPermissionsForNote(noteId, requestingUserId) {
  const db = getDb();
  try {
    if (!noteId || !requestingUserId) {
      return { success: false, error: "Note ID and requesting user ID are required." };
    }

    const note = await noteService.getNoteById(noteId, null, { bypassPermissionCheck: true }); // Bypassing normal permission check for ownership validation
    if (!note) {
      return { success: false, error: `Note ID ${noteId} not found.` };
    }

    // Authorization: Only the note owner can view all permissions for the note.
    if (note.user_id !== requestingUserId) {
      return { success: false, error: "Authorization failed: Only the note owner can view permissions." };
    }

    const sql = `
      SELECT np.note_id, np.user_id, u.username AS target_username,
             np.permission_level, np.granted_by_user_id, gbu.username AS granted_by_username,
             np.created_at, np.updated_at
      FROM note_permissions np
      JOIN users u ON np.user_id = u.id
      LEFT JOIN users gbu ON np.granted_by_user_id = gbu.id
      WHERE np.note_id = ?
    `;
    const permissions = db.prepare(sql).all(noteId);
    return { success: true, permissions };

  } catch (error) {
    console.error(`Error in getPermissionsForNote for note ${noteId} (user ${requestingUserId}):`, error);
    return { success: false, error: error.message || "Failed to retrieve permissions for note." };
  }
}

/**
 * Checks a user's permission level for a specific note.
 * This is an internal helper and can be synchronous if db calls are synchronous.
 * Making it async to align with other service calls.
 * @param {number} noteId - The ID of the note.
 * @param {number} checkUserId - The ID of the user whose permission is being checked.
 * @param {string} requiredPermissionLevel - 'READ' or 'WRITE'.
 * @returns {Promise<object>} - { V: boolean, level?: string ('READ', 'WRITE', 'OWNER') } V is true if permission met.
 */
async function checkUserNotePermission(noteId, checkUserId, requiredPermissionLevel) {
  const db = getDb();
  try {
    if (!noteId || !checkUserId || !requiredPermissionLevel) {
      // console.warn("checkUserNotePermission called with missing parameters.");
      return { V: false, error: "Missing parameters for permission check." };
    }

    const noteOwnerResult = db.prepare("SELECT user_id FROM notes WHERE id = ?").get(noteId);
    if (!noteOwnerResult) {
      return { V: false, error: "Note not found." }; // Note doesn't exist
    }

    // Owner has all permissions
    if (noteOwnerResult.user_id === checkUserId) {
      return { V: true, level: 'OWNER' };
    }

    // Check for public notes (user_id IS NULL on notes table)
    if (noteOwnerResult.user_id === null) {
        if (requiredPermissionLevel === 'READ') { // Public notes are readable by anyone
            return { V: true, level: 'PUBLIC_READ' };
        }
        // Write access to public notes is typically restricted or handled differently, not via note_permissions
        // For now, only public read is granted this way. Owner (if any conceptual owner) would be through user_id.
    }


    const permissionRecord = db.prepare(
      "SELECT permission_level FROM note_permissions WHERE note_id = ? AND user_id = ?"
    ).get(noteId, checkUserId);

    if (permissionRecord) {
      if (permissionRecord.permission_level === 'WRITE') {
        return { V: true, level: 'WRITE' }; // 'WRITE' implies 'READ'
      }
      if (permissionRecord.permission_level === 'READ' && requiredPermissionLevel === 'READ') {
        return { V: true, level: 'READ' };
      }
    }

    return { V: false }; // No specific permission found or level not sufficient

  } catch (error) {
    console.error(`Error in checkUserNotePermission (note ${noteId}, user ${checkUserId}):`, error);
    return { V: false, error: error.message || "Error checking permission." };
  }
}

module.exports = {
  grantNotePermission,
  revokeNotePermission,
  getPermissionsForNote,
  checkUserNotePermission,
};
