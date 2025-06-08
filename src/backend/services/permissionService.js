// src/backend/services/permissionService.js
const { getDb } = require('../db');
const noteService = require('./noteService');
const SYSTEM_USER_ID = 0; // Define SYSTEM_USER_ID
const userService = require('./userService');
const authService = require('./authService'); // Added for RBAC
const databaseDefService = require('./databaseDefService'); // For DB details

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

    // Authorization: User must be the note owner OR an ADMIN to grant permissions.
    const isOwner = note.user_id === grantingUserId;
    let canGrant = isOwner;
    if (!isOwner) {
        const isAdmin = await authService.checkUserRole(grantingUserId, 'ADMIN');
        if (isAdmin) {
            canGrant = true;
        }
    }
    if (!canGrant) {
         return { success: false, error: "Authorization failed: Only the note owner or an ADMIN can grant permissions." };
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

    // Authorization: User must be the note owner OR an ADMIN to revoke permissions.
    const isOwner = note.user_id === revokingUserId;
    let canRevoke = isOwner;
    if (!isOwner) {
        const isAdmin = await authService.checkUserRole(revokingUserId, 'ADMIN');
        if (isAdmin) {
            canRevoke = true;
        }
    }
    if (!canRevoke) {
        return { success: false, error: "Authorization failed: Only the note owner or an ADMIN can revoke permissions." };
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

    // Authorization: User must be the note owner OR an ADMIN to view all permissions.
    const isOwner = note.user_id === requestingUserId;
    let canViewPermissions = isOwner;
    if(!isOwner) {
        const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
        if (isAdmin) {
            canViewPermissions = true;
        }
    }
    if (!canViewPermissions) {
      return { success: false, error: "Authorization failed: Only the note owner or an ADMIN can view permissions." };
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
    if (checkUserId === SYSTEM_USER_ID) {
        return { V: true, level: 'SYSTEM' };
    }
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
  grantDatabasePermission,
  revokeDatabasePermission,
  getPermissionsForDatabase,
  checkUserDatabasePermission,
};

// --- Database Permission Functions ---

async function grantDatabasePermission(databaseId, targetUserId, permissionLevel, grantingUserId) {
  const db = getDb();
  try {
    if (!databaseId || !targetUserId || !permissionLevel || !grantingUserId) {
      return { success: false, error: "Database ID, target user ID, permission level, and granting user ID are required." };
    }

    const grantingUser = await userService.getUserById(grantingUserId);
    if (!grantingUser) {
      return { success: false, error: `Granting user ID ${grantingUserId} not found.` };
    }

    const databaseToShare = await databaseDefService.getDatabaseById(databaseId, null); // Unfiltered
    if (!databaseToShare) {
      return { success: false, error: `Database ID ${databaseId} not found.` };
    }

    const isOwner = databaseToShare.user_id === grantingUserId;
    const isAdminGranter = await authService.checkUserRole(grantingUserId, 'ADMIN');
    if (!isOwner && !isAdminGranter) {
      return { success: false, error: "Authorization failed: Only database owner or an ADMIN can grant permissions." };
    }

    const targetUser = await userService.getUserById(targetUserId);
    if (!targetUser) {
      return { success: false, error: `Target user ID ${targetUserId} not found.` };
    }

    if (targetUserId === databaseToShare.user_id) {
      return { success: false, error: "Cannot grant explicit permission to the database owner; owner has inherent full access." };
    }

    if (!['READ', 'WRITE', 'ADMIN'].includes(permissionLevel)) {
      return { success: false, error: "Invalid permission level. Must be 'READ', 'WRITE', or 'ADMIN'." };
    }

    const stmt = db.prepare(
      `REPLACE INTO database_permissions (database_id, user_id, permission_level, granted_by_user_id)
       VALUES (?, ?, ?, ?)`
    );
    // info.lastInsertRowid might be 0 if REPLACE updated an existing row.
    // Query by database_id and user_id to get the definitive record.
    stmt.run(databaseId, targetUserId, permissionLevel, grantingUserId);
    const newPerm = db.prepare("SELECT * FROM database_permissions WHERE database_id = ? AND user_id = ?").get(databaseId, targetUserId);

    return { success: true, permission: newPerm };

  } catch (error) {
    console.error(`Error in grantDatabasePermission (db ${databaseId}, targetUser ${targetUserId}, granter ${grantingUserId}):`, error);
    return { success: false, error: error.message || "Failed to grant database permission." };
  }
}

async function revokeDatabasePermission(databaseId, targetUserId, revokingUserId) {
  const db = getDb();
  try {
    if (!databaseId || !targetUserId || !revokingUserId) {
      return { success: false, error: "Database ID, target user ID, and revoking user ID are required." };
    }

    const revokingUser = await userService.getUserById(revokingUserId);
    if (!revokingUser) {
      return { success: false, error: `Revoking user ID ${revokingUserId} not found.` };
    }

    const databaseToModify = await databaseDefService.getDatabaseById(databaseId, null); // Unfiltered
    if (!databaseToModify) {
      return { success: false, error: `Database ID ${databaseId} not found.` };
    }

    const isOwner = databaseToModify.user_id === revokingUserId;
    const isAdminRevoker = await authService.checkUserRole(revokingUserId, 'ADMIN');
    if (!isOwner && !isAdminRevoker) {
      return { success: false, error: "Authorization failed: Only database owner or an ADMIN can revoke permissions." };
    }

    const stmt = db.prepare("DELETE FROM database_permissions WHERE database_id = ? AND user_id = ?");
    const info = stmt.run(databaseId, targetUserId);

    return { success: true, changes: info.changes };

  } catch (error) {
    console.error(`Error in revokeDatabasePermission (db ${databaseId}, targetUser ${targetUserId}, revoker ${revokingUserId}):`, error);
    return { success: false, error: error.message || "Failed to revoke database permission." };
  }
}

async function getPermissionsForDatabase(databaseId, requestingUserId) {
  const db = getDb();
  try {
    if (!databaseId || !requestingUserId) {
      return { success: false, error: "Database ID and requesting user ID are required." };
    }

    const dbToList = await databaseDefService.getDatabaseById(databaseId, null); // Unfiltered
    if (!dbToList) {
      return { success: false, error: `Database ID ${databaseId} not found.` };
    }

    const isOwner = dbToList.user_id === requestingUserId;
    const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
    if (!isOwner && !isAdmin) {
      return { success: false, error: "Authorization failed: Only database owner or an ADMIN can list permissions." };
    }

    const sql = `
      SELECT dp.id, dp.database_id, dp.user_id, u.username as target_username,
             dp.permission_level, dp.granted_by_user_id, gbu.username as granted_by_username,
             dp.created_at, dp.updated_at
      FROM database_permissions dp
      JOIN users u ON dp.user_id = u.id
      LEFT JOIN users gbu ON dp.granted_by_user_id = gbu.id
      WHERE dp.database_id = ?
      ORDER BY u.username ASC
    `;
    const permissions = db.prepare(sql).all(databaseId);
    return { success: true, permissions };

  } catch (error) {
    console.error(`Error in getPermissionsForDatabase for db ${databaseId} (user ${requestingUserId}):`, error);
    return { success: false, error: error.message || "Failed to retrieve permissions for database." };
  }
}

async function checkUserDatabasePermission(databaseId, checkUserId, requiredPermissionLevel) {
  const db = getDb();
  try {
    if (checkUserId === SYSTEM_USER_ID) {
        return { V: true, level: 'SYSTEM' };
    }
    if (!databaseId || !checkUserId || !requiredPermissionLevel) {
      return { V: false, error: "Missing parameters for database permission check." };
    }
    if (!['READ', 'WRITE', 'ADMIN'].includes(requiredPermissionLevel)) {
        return { V: false, error: "Invalid requiredPermissionLevel." };
    }

    const dbOwnerInfo = db.prepare("SELECT user_id FROM note_databases WHERE id = ?").get(databaseId);
    if (!dbOwnerInfo) {
      return { V: false, error: "Database not found." };
    }

    // Owner has all permissions
    if (dbOwnerInfo.user_id === checkUserId) {
      return { V: true, level: 'OWNER' };
    }

    // Public DBs: For this check, explicit permission or ADMIN override is still required if not owner.
    // If public DBs had an implicit read for all authenticated users, logic would go here.

    const permRecord = db.prepare(
      "SELECT permission_level FROM database_permissions WHERE database_id = ? AND user_id = ?"
    ).get(databaseId, checkUserId);

    if (permRecord) {
      if (permRecord.permission_level === 'ADMIN') {
        return { V: true, level: 'ADMIN' }; // DB-specific ADMIN implies WRITE and READ
      }
      if (permRecord.permission_level === 'WRITE' && (requiredPermissionLevel === 'WRITE' || requiredPermissionLevel === 'READ')) {
        return { V: true, level: 'WRITE' }; // WRITE implies READ
      }
      if (permRecord.permission_level === 'READ' && requiredPermissionLevel === 'READ') {
        return { V: true, level: 'READ' };
      }
    }

    // Check for global ADMIN role as an override if no specific permission grants access
    const isGlobalAdmin = await authService.checkUserRole(checkUserId, 'ADMIN');
    if (isGlobalAdmin) {
      return { V: true, level: 'ADMIN_GLOBAL_OVERRIDE' };
    }

    return { V: false }; // No sufficient permission found

  } catch (error) {
    console.error(`Error in checkUserDatabasePermission (db ${databaseId}, user ${checkUserId}):`, error);
    return { V: false, error: error.message || "Error checking database permission." };
  }
}
