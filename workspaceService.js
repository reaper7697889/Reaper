// src/backend/services/workspaceService.js
const { getDb } = require("../db");
const authService = require('./src/backend/services/authService.js'); // Added for RBAC

async function createWorkspace(workspaceData, requestingUserId) { // Changed to async
  const db = getDb();
  const { name } = workspaceData; // userId will come from requestingUserId

  if (!name || typeof name !== 'string' || name.trim() === "") {
    return { success: false, error: "Workspace name is required." };
  }
  if (requestingUserId === null || requestingUserId === undefined) {
      return { success: false, error: "User ID is required to create a workspace." };
  }

  // RBAC Check: Viewers cannot create workspaces
  const userCreating = await authService.getUserWithRole(requestingUserId);
  if (userCreating && userCreating.role === 'VIEWER') {
      console.error(`User ${requestingUserId} (Viewer) attempted to create a workspace. Denied.`);
      return { success: false, error: "Viewers cannot create workspaces." };
  }

  const stmt = db.prepare("INSERT INTO workspaces (name, user_id) VALUES (?, ?)");
  try {
    const info = stmt.run(name.trim(), requestingUserId);
    const newWorkspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(info.lastInsertRowid);
    return { success: true, workspace: newWorkspace };
  } catch (err) {
    console.error("Error creating workspace:", err.message, err.stack);
    // Handle potential UNIQUE constraint error if (name, user_id) should be unique, though schema doesn't enforce it.
    // Current schema only has UNIQUE on (name) if it were added. The provided schema does not show it.
    return { success: false, error: "Failed to create workspace. " + err.message };
  }
}

function getWorkspaces(requestingUserId) {
  const db = getDb();
  if (requestingUserId === null || requestingUserId === undefined) {
    console.warn("getWorkspaces called without requestingUserId.");
    return []; // Or handle as an error, depending on desired strictness
  }
  try {
    // Select workspaces owned by the user OR public ones (user_id IS NULL)
    const stmt = db.prepare("SELECT id, name, user_id FROM workspaces WHERE user_id = ? OR user_id IS NULL ORDER BY name ASC");
    return stmt.all(requestingUserId);
  } catch (err) {
    console.error("Error getting workspaces:", err.message, err.stack);
    return [];
  }
}

function updateWorkspace(workspaceId, updates, requestingUserId) {
  const db = getDb();
  if (workspaceId === null || workspaceId === undefined || requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "Workspace ID and User ID are required." };
  }

  const workspace = db.prepare("SELECT id, name, user_id FROM workspaces WHERE id = ?").get(workspaceId);
  if (!workspace) {
    return { success: false, error: "Workspace not found." };
  }

  if (workspace.user_id !== null && workspace.user_id !== requestingUserId) {
    return { success: false, error: "Authorization failed. You do not own this workspace." };
  }

  const { name } = updates; // Only name is updatable for now
  if (name === undefined || name === null || typeof name !== 'string' || name.trim() === "") {
    return { success: false, error: "Workspace name must be a non-empty string." };
  }
  if (name.trim() === workspace.name) {
      return { success: true, message: "No effective changes.", workspace };
  }

  // user_id should not be updatable via this function.
  // Add updated_at if schema has it, e.g. "UPDATE workspaces SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  try {
    const stmt = db.prepare("UPDATE workspaces SET name = ? WHERE id = ?");
    const info = stmt.run(name.trim(), workspaceId);
    if (info.changes > 0) {
      const updatedWorkspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId);
      return { success: true, workspace: updatedWorkspace };
    }
    // This case might be unreachable if name check above is thorough or if workspace was deleted concurrently.
    return { success: false, error: "Workspace not found or name was identical." };
  } catch (err) {
    console.error(`Error updating workspace ${workspaceId}:`, err.message, err.stack);
    return { success: false, error: "Failed to update workspace. " + err.message };
  }
}

async function deleteWorkspace(workspaceId, requestingUserId) { // Changed to async
  const db = getDb();
  if (workspaceId === null || workspaceId === undefined || requestingUserId === null || requestingUserId === undefined) {
    return { success: false, error: "Workspace ID and User ID are required." };
  }

  const workspace = db.prepare("SELECT id, user_id FROM workspaces WHERE id = ?").get(workspaceId);
  if (!workspace) {
    return { success: false, error: "Workspace not found." };
  }

  let canDelete = false;
  const isOwner = (workspace.user_id === requestingUserId);

  if (isOwner) {
    canDelete = true;
  } else if (workspace.user_id === null) { // Public workspace (if concept exists)
    const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
    if (isAdmin) {
      canDelete = true;
    } else {
      return { success: false, error: "Authorization failed: Only ADMIN can delete public workspaces." };
    }
  } else { // Workspace has an owner, and it's not the requestingUser
    const isAdmin = await authService.checkUserRole(requestingUserId, 'ADMIN');
    if (isAdmin) {
      canDelete = true; // Admin can delete other users' workspaces
    }
  }

  if (!canDelete) {
    return { success: false, error: `Authorization failed: User ${requestingUserId} cannot delete workspace ${workspaceId}.` };
  }

  try {
    // Schema: FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE for notes table.
    // This means deleting a workspace will also delete all notes within it.
    const stmt = db.prepare("DELETE FROM workspaces WHERE id = ?");
    const info = stmt.run(workspaceId);
    if (info.changes > 0) {
      return { success: true };
    }
    return { success: false, error: "Workspace not found at delete stage." }; // Should be caught by pre-check
  } catch (err) {
    console.error(`Error deleting workspace ${workspaceId}:`, err.message, err.stack);
    return { success: false, error: "Failed to delete workspace. " + err.message };
  }
}

module.exports = {
    createWorkspace,
    getWorkspaces,
    updateWorkspace,
    deleteWorkspace,
};

