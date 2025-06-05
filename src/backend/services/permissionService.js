// src/backend/services/permissionService.js
const actualDbModule = require("../db"); // Renamed for clarity
let currentGetDb = actualDbModule.getDb; // Initialize with actual getDb

// Internal function that services will use, allowing it to be overridden for tests
function getDbInService() {
    return currentGetDb();
}

// Exported for testing purposes
function __setTestDb(testDbInstance) {
    currentGetDb = () => testDbInstance;
}
function __restoreOriginalDb() {
    currentGetDb = actualDbModule.getDb;
}
// const noteService = require('./noteService'); // Example, if needed later for ownership checks

const ALLOWED_OBJECT_TYPES = ['note', 'database', 'database_row', 'task', 'folder', 'workspace'];
const PERMISSION_LEVEL_HIERARCHY = {
    read: 1,
    write: 2,
    admin: 3,
};
const VALID_PERMISSION_LEVELS = Object.keys(PERMISSION_LEVEL_HIERARCHY);

// --- Helper Functions ---
function _isValidObjectType(objectType) {
    return ALLOWED_OBJECT_TYPES.includes(objectType);
}

function _isValidPermissionLevel(permissionLevel) {
    return VALID_PERMISSION_LEVELS.includes(permissionLevel);
}

/**
 * Checks if a user has the required permission level for an object,
 * considering hierarchy (e.g., admin implies write, write implies read).
 * This is an internal helper for checkPermission.
 * @param {string} actualPermission - The permission level the user actually has.
 * @param {string} requiredPermission - The permission level being checked for.
 * @returns {boolean}
 */
function _hasSufficientPermission(actualPermission, requiredPermission) {
    if (!actualPermission || !requiredPermission) return false;
    const actualLevel = PERMISSION_LEVEL_HIERARCHY[actualPermission];
    const requiredLevel = PERMISSION_LEVEL_HIERARCHY[requiredPermission];
    if (actualLevel === undefined || requiredLevel === undefined) return false; // Invalid level string
    return actualLevel >= requiredLevel;
}

// Internal helper to get owner of an object
// Returns user_id or null if no owner/public, or undefined if object not found/type not supported for ownership.
function _getObjectOwner(objectType, objectId, db) {
    if (!db) db = getDbInService(); // Ensure db is available, useful for direct calls if any

    let stmt;
    switch (objectType) {
        case 'note':
            stmt = db.prepare("SELECT user_id FROM notes WHERE id = ?");
            break;
        case 'task':
            stmt = db.prepare("SELECT user_id FROM tasks WHERE id = ?");
            break;
        case 'database':
            stmt = db.prepare("SELECT user_id FROM note_databases WHERE id = ?");
            break;
        case 'database_row': {
            // Ownership of a row is determined by the owner of its parent database
            const row = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(objectId);
            if (!row) return undefined; // Row not found
            stmt = db.prepare("SELECT user_id FROM note_databases WHERE id = ?");
            const ownerRow = stmt.get(row.database_id);
            return ownerRow ? ownerRow.user_id : null; // Database itself might be public
        }
        case 'folder': // Assuming folders table and user_id column
            // stmt = db.prepare("SELECT user_id FROM folders WHERE id = ?");
            // break;
            // For now, as tables are not confirmed for these:
            console.warn(`Ownership check for objectType '${objectType}' not fully implemented yet.`);
            return null; // Or a specific value like NOT_APPLICABLE if preferred
        case 'workspace': // Assuming workspaces table and user_id column
            // stmt = db.prepare("SELECT user_id FROM workspaces WHERE id = ?");
            // break;
            console.warn(`Ownership check for objectType '${objectType}' not fully implemented yet.`);
            return null;
        default:
            console.warn(`Ownership check not applicable for objectType: ${objectType}`);
            return null; // Not applicable or type doesn't support ownership
    }
    if (!stmt) return undefined; // Should not happen if cases cover all supported types for ownership

    const ownerRow = stmt.get(objectId);
    return ownerRow ? ownerRow.user_id : (ownerRow === undefined ? undefined : null); // null if user_id is null (public), undefined if row not found
}


// --- Public API Functions ---

/**
 * Grants a permission to a user for a specific object.
 * @param {number} actorUserId - The ID of the user performing the action.
 * @param {number} targetUserId - The ID of the user to grant permission to.
 * @param {string} objectType - The type of the object (e.g., 'note', 'task').
 * @param {number} objectId - The ID of the object.
 * @param {string} permissionLevel - The permission level to grant (e.g., 'read', 'write').
 * @returns {Promise<object>} Result object with success status and permission record or error.
 */
async function grantPermission(actorUserId, targetUserId, objectType, objectId, permissionLevel) {
    // Basic validation
    if (!_isValidObjectType(objectType)) return { success: false, error: `Invalid object_type: ${objectType}` };
    if (!_isValidPermissionLevel(permissionLevel)) return { success: false, error: `Invalid permission_level: ${permissionLevel}` };
    if (targetUserId === null || targetUserId === undefined) return { success: false, error: "targetUserId is required." };
    if (objectId === null || objectId === undefined) return { success: false, error: "objectId is required." };

    // TODO: Add check: actorUserId must have 'admin' permission on the object or be its owner.
    // This will require integrating with owner-checking logic from other services (e.g., noteService.getNoteById(objectId).user_id)
    // For now, this check is omitted for initial implementation.

    const db = getDbInService();

    // Actor permission check: Must be owner or have 'admin' rights on the object
    const ownerId = _getObjectOwner(objectType, objectId, db);

    if (ownerId === undefined && ['note', 'task', 'database', 'database_row', 'folder', 'workspace'].includes(objectType)) {
        // undefined means object not found by _getObjectOwner or type not supported for ownership lookup
        return { success: false, error: "Object not found or ownership cannot be determined." };
    }

    let isOwner = false;
    if (ownerId !== null && ownerId !== undefined) { // ownerId can be null for public objects
        isOwner = (actorUserId === ownerId);
    }

    if (!isOwner && actorUserId !== 0) { // actorUserId 0 could be a system/super user
        const hasAdminPermission = await checkPermission(actorUserId, objectType, objectId, 'admin');
        if (!hasAdminPermission) {
            return { success: false, error: "Permission denied: Actor must be owner or have admin rights on the object to manage its permissions." };
        }
    }
    // If ownerId is null (public object), only an explicit 'admin' permission (checked above) allows managing permissions.
    // If actorUserId is 0 (system), it bypasses this check.

    try {
        let existing = db.prepare("SELECT id FROM object_permissions WHERE object_type = ? AND object_id = ? AND user_id = ?").get(objectType, objectId, targetUserId);
        let resultPermission;

        if (existing) {
            const updateStmt = db.prepare("UPDATE object_permissions SET permission_level = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
            updateStmt.run(permissionLevel, existing.id);
            resultPermission = db.prepare("SELECT * FROM object_permissions WHERE id = ?").get(existing.id);
        } else {
            const insertStmt = db.prepare("INSERT INTO object_permissions (object_type, object_id, user_id, permission_level) VALUES (?, ?, ?, ?)");
            const info = insertStmt.run(objectType, objectId, targetUserId, permissionLevel);
            resultPermission = db.prepare("SELECT * FROM object_permissions WHERE id = ?").get(info.lastInsertRowid);
        }

        return { success: true, permission: resultPermission };
    } catch (err) {
        console.error("Error in grantPermission:", err);
        return { success: false, error: err.message || "Failed to grant permission." };
    }
}

/**
 * Revokes all explicit permissions for a given object.
 * This is typically used when an object is deleted.
 * @param {string} objectType - The type of the object.
 * @param {number} objectId - The ID of the object.
 * @returns {Promise<object>} Result object with success status and count of revoked permissions, or error.
 */
async function revokeAllPermissionsForObject(objectType, objectId) {
    if (!_isValidObjectType(objectType)) {
        return { success: false, error: `Invalid object_type: ${objectType}` };
    }
    if (objectId === null || objectId === undefined) {
        return { success: false, error: "objectId is required." };
    }

    const db = getDbInService(); // Changed
    try {
        const stmt = db.prepare(
            "DELETE FROM object_permissions WHERE object_type = ? AND object_id = ?"
        );
        const info = stmt.run(objectType, objectId);
        console.log(`Revoked ${info.changes} permissions for ${objectType} ID ${objectId}`);
        return { success: true, count: info.changes };
    } catch (err) {
        console.error(`Error in revokeAllPermissionsForObject for ${objectType} ID ${objectId}:`, err);
        return { success: false, error: err.message || "Failed to revoke permissions for object." };
    }
}

/**
 * Revokes a permission from a user for a specific object.
 * @param {number} actorUserId - The ID of the user performing the action.
 * @param {number} targetUserId - The ID of the user whose permission is being revoked.
 * @param {string} objectType - The type of the object.
 * @param {number} objectId - The ID of the object.
 * @returns {Promise<object>} Result object with success status or error.
 */
async function revokePermission(actorUserId, targetUserId, objectType, objectId) {
    if (!_isValidObjectType(objectType)) return { success: false, error: `Invalid object_type: ${objectType}` };
    if (targetUserId === null || targetUserId === undefined) return { success: false, error: "targetUserId is required." };
    if (objectId === null || objectId === undefined) return { success: false, error: "objectId is required." };

    // TODO: Add check: actorUserId must have 'admin' permission or be owner.
    // Omitted for now.

    const db = getDbInService();

    // Actor permission check
    const ownerId = _getObjectOwner(objectType, objectId, db);
    if (ownerId === undefined && ['note', 'task', 'database', 'database_row', 'folder', 'workspace'].includes(objectType)) {
      return { success: false, error: "Object not found or ownership cannot be determined." };
    }
    let isOwner = false;
    if (ownerId !== null && ownerId !== undefined) {
        isOwner = (actorUserId === ownerId);
    }

    if (!isOwner && actorUserId !== 0) { // actorUserId 0 for system bypass
        const hasAdminPermission = await checkPermission(actorUserId, objectType, objectId, 'admin');
        if (!hasAdminPermission) {
            return { success: false, error: "Permission denied: Actor must be owner or have admin rights on the object to manage its permissions." };
        }
    }

    try {
        const stmt = db.prepare("DELETE FROM object_permissions WHERE object_type = ? AND object_id = ? AND user_id = ?");
        const info = stmt.run(objectType, objectId, targetUserId);
        return { success: true, removed: info.changes > 0 };
    } catch (err) {
        console.error("Error in revokePermission:", err);
        return { success: false, error: err.message || "Failed to revoke permission." };
    }
}

/**
 * Checks if a user has a specific permission level for an object.
 * @param {number} userId - The ID of the user.
 * @param {string} objectType - The type of the object.
 * @param {number} objectId - The ID of the object.
 * @param {string} requiredPermissionLevel - The permission level required.
 * @returns {Promise<boolean>} True if the user has the required permission, false otherwise.
 */
async function checkPermission(userId, objectType, objectId, requiredPermissionLevel) {
    if (userId === null || userId === undefined) return false; // Or throw error
    if (!_isValidObjectType(objectType)) return false;
    if (objectId === null || objectId === undefined) return false;
    if (!_isValidPermissionLevel(requiredPermissionLevel)) return false;

    const db = getDbInService(); // Changed
    try {
        // TODO: Phase 2 of checkPermission - Integrate ownership check.
        const row = db.prepare(
            "SELECT permission_level FROM object_permissions WHERE user_id = ? AND object_type = ? AND object_id = ?"
        ).get(userId, objectType, objectId);

        if (row && _hasSufficientPermission(row.permission_level, requiredPermissionLevel)) {
            return true;
        }

        // Ownership check placeholder - to be implemented later
        return false;
    } catch (err) {
        console.error("Error in checkPermission:", err);
        return false; // Default to no permission on error
    }
}

/**
 * Retrieves all permissions granted for a specific object.
 * @param {number} objectId - The ID of the object.
 * @param {string} objectType - The type of the object.
 * @returns {Promise<Array<object>>} A list of permissions with user details.
 */
async function getPermissionsForObject(objectId, objectType) {
    if (!_isValidObjectType(objectType)) return Promise.resolve([]); // Or reject with error
    if (objectId === null || objectId === undefined) return Promise.resolve([]);

    const db = getDbInService(); // Changed
    try {
        const stmt = db.prepare(`
            SELECT op.user_id, u.username, op.permission_level
            FROM object_permissions op
            JOIN users u ON op.user_id = u.id
            WHERE op.object_type = ? AND op.object_id = ?
        `);
        return stmt.all(objectType, objectId);
    } catch (err) {
        console.error("Error in getPermissionsForObject:", err);
        return [];
    }
}

/**
 * Retrieves all objects for which a user has explicit permissions.
 * @param {number} userId - The ID of the user.
 * @param {string|null} objectTypeFilter - Optional filter by object type.
 * @returns {Promise<Array<object>>} A list of objects the user has permissions on.
 */
async function getObjectsSharedWithUser(userId, objectTypeFilter = null) {
    if (userId === null || userId === undefined) return Promise.resolve([]);
    if (objectTypeFilter && !_isValidObjectType(objectTypeFilter)) return Promise.resolve([]);

    const db = getDbInService(); // Changed
    try {
        let sql = "SELECT object_type, object_id, permission_level FROM object_permissions WHERE user_id = ?";
        const params = [userId];
        if (objectTypeFilter) {
            sql += " AND object_type = ?";
            params.push(objectTypeFilter);
        }
        return db.prepare(sql).all(...params);
    } catch (err) {
        console.error("Error in getObjectsSharedWithUser:", err);
        return [];
    }
}

module.exports = {
    grantPermission,
    revokePermission,
    checkPermission,
    getPermissionsForObject,
    getObjectsSharedWithUser,
    // Expose constants for use in other services or tests if needed
    ALLOWED_OBJECT_TYPES,
    PERMISSION_LEVEL_HIERARCHY,
    VALID_PERMISSION_LEVELS,
    revokeAllPermissionsForObject,
    __setTestDb, // Added for testing
    __restoreOriginalDb, // Added for testing
};
