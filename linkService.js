// src/backend/services/linkService.js - Enhanced for markdown wiki links

const { getDb } = require("../db");
const { v4: uuidv4 } = require("uuid");

/**
 * Parse markdown content for wiki-style links [[link]]
 * @param {string} content - Markdown content to parse
 * @returns {Array} - Array of link texts found
 */
function parseWikiLinks(content) {
  if (!content) return [];
  
  // Match [[link]] pattern
  const wikiLinkRegex = /\[\[(.*?)\]\]/g;
  const matches = [];
  let match;
  
  while ((match = wikiLinkRegex.exec(content)) !== null) {
    matches.push(match[1].trim());
  }
  
  return matches;
}

/**
 * Create a link between notes
 * @param {number} sourceNoteId - ID of the source note
 * @param {string} targetIdentifier - ID or title of the target note
 * @param {string} linkText - Text of the link
 * @returns {object|null} - Created link or null if failed
 */
function createLink(sourceNoteId, targetIdentifier, linkText) {
  const db = getDb();
  
  try {
    // First, try to find the target note by ID
    let targetNote = null;
    if (!isNaN(targetIdentifier)) {
      const stmt = db.prepare("SELECT id FROM notes WHERE id = ?");
      targetNote = stmt.get(targetIdentifier);
    }
    
    // If not found by ID, try by title
    if (!targetNote) {
      const stmt = db.prepare("SELECT id FROM notes WHERE title = ?");
      targetNote = stmt.get(targetIdentifier);
    }
    
    // If target note doesn't exist, create a placeholder note
    let targetNoteId;
    if (targetNote) {
      targetNoteId = targetNote.id;
    } else {
      // Create a new markdown note as a placeholder
      const insertStmt = db.prepare(
        "INSERT INTO notes (title, content, type, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
      );
      const info = insertStmt.run(targetIdentifier, "", "markdown");
      targetNoteId = info.lastInsertRowid;
    }
    
    // Create the link
    const linkId = uuidv4();
    const stmt = db.prepare(
      "INSERT INTO links (id, source_note_id, target_note_id, link_text, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    );
    stmt.run(linkId, sourceNoteId, targetNoteId, linkText);
    
    return { id: linkId, source_note_id: sourceNoteId, target_note_id: targetNoteId, link_text: linkText };
  } catch (err) {
    console.error("Error creating link:", err.message);
    return null;
  }
}

/**
 * Update links for a note based on its content
 * @param {number} noteId - ID of the note
 * @param {string} content - New content with links
 * @returns {boolean} - Success status
 */
function updateLinksFromContent(noteId, content) {
  const db = getDb();
  
  try {
    // Begin transaction
    db.prepare("BEGIN TRANSACTION").run();
    
    // Delete existing links from this source
    const deleteStmt = db.prepare("DELETE FROM links WHERE source_note_id = ?");
    deleteStmt.run(noteId);
    
    // Parse new links from content
    const links = parseWikiLinks(content);
    
    // Create new links
    for (const linkText of links) {
      createLink(noteId, linkText, linkText);
    }
    
    // Commit transaction
    db.prepare("COMMIT").run();
    
    return true;
  } catch (err) {
    console.error("Error updating links from content:", err.message);
    // Rollback on error
    db.prepare("ROLLBACK").run();
    return false;
  }
}

/**
 * Get backlinks for a note
 * @param {number} targetNoteId - ID of the target note
 * @returns {Array} - Array of notes linking to the target
 */
function getBacklinks(targetNoteId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      SELECT n.id, n.title, n.type, l.link_text
      FROM links l
      JOIN notes n ON l.source_note_id = n.id
      WHERE l.target_note_id = ?
    `);
    
    return stmt.all(targetNoteId);
  } catch (err) {
    console.error("Error getting backlinks:", err.message);
    return [];
  }
}

/**
 * Get outgoing links from a note
 * @param {number} sourceNoteId - ID of the source note
 * @returns {Array} - Array of notes linked from the source
 */
function getOutgoingLinks(sourceNoteId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      SELECT n.id, n.title, n.type, l.link_text
      FROM links l
      JOIN notes n ON l.target_note_id = n.id
      WHERE l.source_note_id = ?
    `);
    
    return stmt.all(sourceNoteId);
  } catch (err) {
    console.error("Error getting outgoing links:", err.message);
    return [];
  }
}

/**
 * Delete all links from a source note
 * @param {number} sourceNoteId - ID of the source note
 * @returns {boolean} - Success status
 */
function deleteLinksFromSource(sourceNoteId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare("DELETE FROM links WHERE source_note_id = ?");
    stmt.run(sourceNoteId);
    return true;
  } catch (err) {
    console.error("Error deleting links from source:", err.message);
    return false;
  }
}

module.exports = {
  createLink,
  getBacklinks,
  getOutgoingLinks,
  deleteLinksFromSource,
  parseWikiLinks,
  updateLinksFromContent
};
