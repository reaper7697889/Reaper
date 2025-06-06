// src/backend/services/folderService.js
const { getDb } = require("../db");

function createFolder(folderData, requestingUserId) {
  const db = getDb();
  const { name, parent_id = null } = folderData; // userId will come from requestingUserId

  if (!name || typeof name !== 'string' || name.trim() === "") {
    return { success: false, error: "Folder name is required." };
  }
  if (requestingUserId === null || requestingUserId === undefined) {
      return { success: false, error: "User ID is required to create a folder." };
  }
  // Optional: Validate parent_id if provided (e.g., ensure it exists and belongs to the user)
  // For now, assume parent_id is either null or valid if provided by the client for this user.

  const stmt = db.prepare("INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)");
  try {
    const info = stmt.run(name.trim(), parent_id, requestingUserId);
    const newFolder = db.prepare("SELECT * FROM folders WHERE id = ?").get(info.lastInsertRowid);
    return { success: true, folder: newFolder };
  } catch (err) {
    console.error("Error creating folder:", err.message, err.stack);
    return { success: false, error: "Failed to create folder. " + err.message };
  }
}

function getFolders(parentId = null, requestingUserId) {
  const db = getDb();
  if (requestingUserId === null || requestingUserId === undefined) {
    // In a real app, this might be caught by auth middleware.
    // Returning empty array for query functions if user context is missing.
    console.warn("getFolders called without requestingUserId.");
    return [];
  }
  try {
    let stmt;
    const params = [];
    if (parentId === null) {
      stmt = db.prepare("SELECT id, name, user_id, parent_id FROM folders WHERE parent_id IS NULL AND (user_id = ? OR user_id IS NULL) ORDER BY name ASC");
      params.push(requestingUserId);
    } else {
      stmt = db.prepare("SELECT id, name, user_id, parent_id FROM folders WHERE parent_id = ? AND (user_id = ? OR user_id IS NULL) ORDER BY name ASC");
      params.push(parentId, requestingUserId);
    }
    return stmt.all(...params);
  } catch (err) {
    console.error("Error getting folders:", err.message, err.stack);
    return []; // Return empty array on error for query functions
  }
}

function updateFolder(folderId, updates, requestingUserId) {
  const db = getDb();
  if (folderId === null || folderId === undefined || requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "Folder ID and User ID are required." };
  }

  const folder = db.prepare("SELECT id, name, parent_id, user_id FROM folders WHERE id = ?").get(folderId);
  if (!folder) {
    return { success: false, error: "Folder not found." };
  }

  if (folder.user_id !== null && folder.user_id !== requestingUserId) {
    return { success: false, error: "Authorization failed. You do not own this folder." };
  }

  const { name, parent_id } = updates;
  const fieldsToSet = new Map();

  if (name !== undefined) {
    if (!name || typeof name !== 'string' || name.trim() === "") {
      return { success: false, error: "Folder name cannot be empty." };
    }
    fieldsToSet.set("name", name.trim());
  }
  if (parent_id !== undefined) {
    // Additional validation for parent_id:
    // - Cannot be itself (folderId)
    // - If not null, the target parent folder must exist and belong to the same user.
    // - Moving a folder under one of its own descendants would create a cycle (complex to check here, usually handled by client or deeper validation).
    if (parent_id !== null) {
        if (parent_id === folderId) return { success: false, error: "Folder cannot be its own parent."};
        const targetParent = db.prepare("SELECT id, user_id FROM folders WHERE id = ?").get(parent_id);
        if (!targetParent) return { success: false, error: "Target parent folder not found."};
        if (targetParent.user_id !== null && targetParent.user_id !== requestingUserId) {
             return { success: false, error: "Cannot move folder under a parent folder you do not own."};
        }
    }
    fieldsToSet.set("parent_id", parent_id);
  }

  if (fieldsToSet.size === 0) {
    return { success: true, message: "No effective changes.", folder };
  }

  // Keep original user_id, do not update it here.
  // Add updated_at if schema has it, e.g. fieldsToSet.set("updated_at", "CURRENT_TIMESTAMP");
  const sqlSetParts = Array.from(fieldsToSet.keys()).map(key => `${key} = ?`);
  const sqlValues = Array.from(fieldsToSet.values());
  sqlValues.push(folderId);

  try {
    const stmt = db.prepare(`UPDATE folders SET ${sqlSetParts.join(", ")} WHERE id = ?`);
    const info = stmt.run(...sqlValues);
    if (info.changes > 0) {
      const updatedFolder = db.prepare("SELECT * FROM folders WHERE id = ?").get(folderId);
      return { success: true, folder: updatedFolder };
    }
    return { success: false, error: "Folder not found or no changes made." }; // Should be caught by earlier checks
  } catch (err) {
    console.error(`Error updating folder ${folderId}:`, err.message, err.stack);
    return { success: false, error: "Failed to update folder. " + err.message };
  }
}

function deleteFolder(folderId, requestingUserId) {
  const db = getDb();
   if (folderId === null || folderId === undefined || requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "Folder ID and User ID are required." };
  }

  const folder = db.prepare("SELECT id, user_id FROM folders WHERE id = ?").get(folderId);
  if (!folder) {
    return { success: false, error: "Folder not found." };
  }

  if (folder.user_id !== null && folder.user_id !== requestingUserId) {
    return { success: false, error: "Authorization failed. You do not own this folder." };
  }

  try {
    // ON DELETE CASCADE for parent_id in folders table will handle children.
    // ON DELETE SET NULL for notes.folder_id will unassign notes from this folder.
    const stmt = db.prepare("DELETE FROM folders WHERE id = ?");
    const info = stmt.run(folderId);
    if (info.changes > 0) {
      return { success: true };
    }
    return { success: false, error: "Folder not found at delete stage." }; // Should be caught by pre-check
  } catch (err) {
    console.error(`Error deleting folder ${folderId}:`, err.message, err.stack);
    return { success: false, error: "Failed to delete folder. " + err.message };
  }
}

module.exports = {
    createFolder,
    getFolders,
    updateFolder,
    deleteFolder,
};

