// src/backend/services/workspaceService.js - Placeholder

const { getDb } = require("../db");

// Basic placeholder functions - implement fully as needed

function createWorkspace(workspaceData) {
  const db = getDb();
  const { name } = workspaceData;
  const stmt = db.prepare("INSERT INTO workspaces (name) VALUES (?)");
  try {
    const info = stmt.run(name);
    console.log(`Created workspace ${name} with ID: ${info.lastInsertRowid}`);
    return { id: info.lastInsertRowid, name };
  } catch (err) {
    console.error("Error creating workspace:", err.message);
    return null;
  }
}

function getWorkspaces() {
  const db = getDb();
  const stmt = db.prepare("SELECT id, name FROM workspaces ORDER BY name ASC");
  try {
    return stmt.all();
  } catch (err) {
    console.error("Error getting workspaces:", err.message);
    return [];
  }
}

// Add updateWorkspace, deleteWorkspace etc. later

module.exports = { createWorkspace, getWorkspaces };

