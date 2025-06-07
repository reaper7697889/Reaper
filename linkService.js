// src/backend/services/linkService.js - Enhanced for markdown wiki links

const { getDb } = require("./db"); // Corrected path
const { v4: uuidv4 } = require("uuid");

/**
 * Parse markdown content for embed-style links ![[link#header]] or ![[link^blockId]].
 * @param {string} content - Markdown content to parse.
 * @returns {Array<object>} - Array of embed objects ({ noteName, headerText, blockId, fullEmbedText }).
 *                           `headerText` and `blockId` are mutually exclusive.
 */
function parseEmbeds(content) {
  if (!content) return [];
  const embedRegex = /\!\[\[(.*?)\]\]/g; // Matches ![[...]]
  const matches = [];
  let matchRegexResult;

  while ((matchRegexResult = embedRegex.exec(content)) !== null) {
    const fullEmbedText = matchRegexResult[1].trim();
    let noteName = fullEmbedText;
    let headerText = null;
    let blockId = null;

    const headerIndex = fullEmbedText.indexOf('#');
    const blockIndex = fullEmbedText.indexOf('^');

    if (headerIndex !== -1 && (blockIndex === -1 || headerIndex < blockIndex)) {
      noteName = fullEmbedText.substring(0, headerIndex).trim();
      headerText = fullEmbedText.substring(headerIndex + 1).trim();
      if (!headerText) headerText = null;
    } else if (blockIndex !== -1 && (headerIndex === -1 || blockIndex < headerIndex)) {
      noteName = fullEmbedText.substring(0, blockIndex).trim();
      blockId = fullEmbedText.substring(blockIndex + 1).trim();
      if (!blockId) blockId = null;
    }

    if (noteName) {
      matches.push({ noteName, headerText, blockId, fullEmbedText });
    }
  }
  return matches;
}

/**
 * Parse markdown content for wiki-style links [[link#header]] or [[link^blockId]].
 * @param {string} content - Markdown content to parse.
 * @returns {Array<object>} - Array of link objects ({ noteName, headerText, blockId, fullLinkText }).
 *                           `headerText` and `blockId` are mutually exclusive.
 */
function parseWikiLinks(content) {
  if (!content) return [];
  // Use negative lookbehind to ensure we don't match ![[ (embeds)
  const wikiLinkRegex = /(?<!\!)\[\[(.*?)\]\]/g;
  const matches = [];
  let matchRegexResult;

  while ((matchRegexResult = wikiLinkRegex.exec(content)) !== null) {
    const fullLinkText = matchRegexResult[1].trim();
    let noteName = fullLinkText; // Default noteName is the full link text
    let headerText = null;
    let blockId = null;

    const headerIndex = fullLinkText.indexOf('#');
    const blockIndex = fullLinkText.indexOf('^');

    // Determine if it's a header link, block link, or simple note link
    if (headerIndex !== -1 && (blockIndex === -1 || headerIndex < blockIndex)) {
      // Header link (either # exists and ^ doesn't, or # appears before ^)
      noteName = fullLinkText.substring(0, headerIndex).trim();
      headerText = fullLinkText.substring(headerIndex + 1).trim();
      if (!headerText) headerText = null; // Treat "Note# " as no specific header
    } else if (blockIndex !== -1 && (headerIndex === -1 || blockIndex < headerIndex)) {
      // Block link (either ^ exists and # doesn't, or ^ appears before #)
      noteName = fullLinkText.substring(0, blockIndex).trim();
      blockId = fullLinkText.substring(blockIndex + 1).trim();
      if (!blockId) blockId = null; // Treat "Note^ " as no specific blockId
    }
    // If neither '#' nor '^' is found, or if they are not valid,
    // it's a simple link to a note, and noteName remains fullLinkText.

    if (noteName) { // Only add if a note name is present (should always be true if fullLinkText is not empty)
      matches.push({ noteName, headerText, blockId, fullLinkText });
    }
  }
  return matches;
}

/**
 * Create a link between notes
 * @param {number} sourceNoteId - ID of the source note
 * @param {string} targetIdentifier - ID or title of the target note (noteName)
 * @param {string} linkText - Text of the link (fullLinkText)
 * @param {string|null} targetHeaderText - Optional text of the header in the target note
 * @param {string|null} targetBlockIdText - Optional ID of the block in the target note
 * @param {number} isEmbed - 0 for false (link), 1 for true (embed)
 * @returns {object|null} - Created link or null if failed
 */
function createLink(sourceNoteId, targetIdentifier, linkText, targetHeaderText = null, targetBlockIdText = null, isEmbed = 0) {
  const db = getDb();
  
  try {
    // Ensure header and block links are mutually exclusive at the data level for this function
    if (targetHeaderText && targetBlockIdText) {
      console.warn(`Attempted to create a link with both header and block target: ${targetHeaderText} and ${targetBlockIdText}. Clearing blockId.`);
      targetBlockIdText = null; // Prioritize header if both somehow passed
    }

    // First, try to find the target note by ID
    let targetNote = null;
    // Ensure targetIdentifier is treated as a potential ID only if it's purely numeric
    // and not likely a title that happens to be a number.
    // For simplicity, we'll keep the existing isNaN check, assuming titles aren't usually just numbers.
    if (!isNaN(targetIdentifier)) {
      const stmtById = db.prepare("SELECT id FROM notes WHERE id = ?");
      targetNote = stmtById.get(targetIdentifier);
    }
    
    // If not found by ID, or if targetIdentifier was not a number, try by title (noteName)
    if (!targetNote) {
      const stmtByTitle = db.prepare("SELECT id FROM notes WHERE title = ? COLLATE NOCASE");
      targetNote = stmtByTitle.get(targetIdentifier); // targetIdentifier is noteName here
    }
    
    let targetNoteId;
    if (targetNote) {
      targetNoteId = targetNote.id;
    } else {
      // Create a new markdown note as a placeholder if targetIdentifier (noteName) was not found
      const insertPlaceholderStmt = db.prepare(
        "INSERT INTO notes (title, content, type, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
      );
      // Use targetIdentifier (which is noteName) as the title for the placeholder
      const placeholderInfo = insertPlaceholderStmt.run(targetIdentifier, `# Placeholder for ${targetIdentifier}`, "markdown");
      targetNoteId = placeholderInfo.lastInsertRowid;
    }
    
    // Create the link, now including target_header, target_block_id, and is_embed
    const insertLinkStmt = db.prepare(
      "INSERT INTO links (source_note_id, target_note_id, link_text, target_header, target_block_id, is_embed, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    );
    const info = insertLinkStmt.run(sourceNoteId, targetNoteId, linkText, targetHeaderText, targetBlockIdText, isEmbed);
    
    return {
      id: info.lastInsertRowid,
      source_note_id: sourceNoteId,
      target_note_id: targetNoteId,
      link_text: linkText,
      target_header: targetHeaderText,
      target_block_id: targetBlockIdText,
      is_embed: isEmbed
    };
  } catch (err) {
    // Check for UNIQUE constraint violation specifically for links
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // A link/embed with this source, target, text, header, block_id, and embed status already exists.
      let targetString = targetIdentifier;
      if (targetHeaderText) targetString += `#${targetHeaderText}`;
      if (targetBlockIdText) targetString += `^${targetBlockIdText}`;
      const type = isEmbed ? "embed" : "link";
      console.warn(`Attempted to create a duplicate ${type}: ${sourceNoteId} -> ${targetString} (text: ${linkText}). Item already exists.`);
      return null;
    }
    console.error("Error creating link:", err.message, { sourceNoteId, targetIdentifier, linkText, targetHeaderText, targetBlockIdText, isEmbed });
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
    
    // Delete existing links from this source (idempotent operation)
    const deleteStmt = db.prepare("DELETE FROM links WHERE source_note_id = ?");
    deleteStmt.run(noteId);
    
    // 1. Parse and create embeds
    const parsedEmbeds = parseEmbeds(content);
    for (const parsedEmbed of parsedEmbeds) {
      createLink(
        noteId,
        parsedEmbed.noteName,
        parsedEmbed.fullEmbedText, // Use fullEmbedText as linkText for embeds
        parsedEmbed.headerText,
        parsedEmbed.blockId,
        1 // isEmbed = true
      );
    }

    // 2. Parse and create regular wiki links (parseWikiLinks now ignores embeds)
    const parsedLinks = parseWikiLinks(content);
    for (const parsedLink of parsedLinks) {
      createLink(
        noteId,
        parsedLink.noteName,
        parsedLink.fullLinkText,
        parsedLink.headerText,
        parsedLink.blockId,
        0 // isEmbed = false
      );
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
      SELECT n.id, n.title, n.type, l.link_text, l.target_header, l.target_block_id, l.is_embed
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
      SELECT n.id, n.title, n.type, l.link_text, l.target_header, l.target_block_id, l.is_embed
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
  parseEmbeds, // Export the new parser
  updateLinksFromContent
};
