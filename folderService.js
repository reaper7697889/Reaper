// src/backend/services/folderService.js - Placeholder

const { getDb } = require("../db");

// Basic placeholder functions - implement fully as needed

function createFolder(folderData) {
  const db = getDb();
  const { name, parent_id = null } = folderData;
  const stmt = db.prepare("INSERT INTO folders (name, parent_id) VALUES (?, ?)");
  try {
    const info = stmt.run(name, parent_id);
    console.log(`Created folder ${name} with ID: ${info.lastInsertRowid}`);
    return { id: info.lastInsertRowid, name, parent_id };
  } catch (err) {
    console.error("Error creating folder:", err.message);
    return null;
  }
}

function getFolders(parentId = null) {
  const db = getDb();
  let stmt;
  try {
      if (parentId === null) {
          stmt = db.prepare("SELECT id, name FROM folders WHERE parent_id IS NULL ORDER BY name ASC");
          return stmt.all();
      } else {
          stmt = db.prepare("SELECT id, name FROM folders WHERE parent_id = ? ORDER BY name ASC");
          return stmt.all(parentId);
      }
  } catch (err) {
      console.error("Error getting folders:", err.message);
      return [];
  }
}

// Add updateFolder, deleteFolder etc. later

module.exports = { createFolder, getFolders };

