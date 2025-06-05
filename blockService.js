// src/backend/services/blockService.js

const { getDb } = require("../db");
const { v4: uuidv4 } = require("uuid"); // Use uuid for block IDs

/**
 * Creates a new block for a workspace page.
 * @param {object} blockData - { note_id, type, content, block_order, parent_id = null }
 * @returns {object | null} - The created block object or null on failure.
 */
function createBlock(blockData) {
  const db = getDb();
  const { note_id, type, content, block_order, parent_id = null } = blockData;
  const blockId = uuidv4(); // Generate a unique ID

  // Validate required fields
  if (!note_id || !type || content === undefined || block_order === undefined) {
    console.error("Missing required fields for creating a block.");
    return null;
  }

  // Ensure content is stored as JSON string if it's an object
  const contentString = typeof content === "string" ? content : JSON.stringify(content);

  const stmt = db.prepare(`
    INSERT INTO blocks (id, note_id, type, content, block_order, parent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  try {
    stmt.run(blockId, note_id, type, contentString, block_order, parent_id);
    console.log(`Created block with ID: ${blockId} for note ${note_id}`);
    // Return the newly created block data (fetch it or construct it)
    return {
        id: blockId,
        note_id,
        type,
        content: contentString, // Return as string for consistency?
        block_order,
        parent_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
  } catch (err) {
    console.error("Error creating block:", err.message);
    return null;
  }
}

/**
 * Retrieves a block by its ID.
 * @param {string} id - The UUID of the block.
 * @returns {object | null} - The block object or null if not found.
 */
function getBlockById(id) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM blocks WHERE id = ?");
  try {
    const block = stmt.get(id);
    // Optionally parse JSON content here if needed consistently
    // if (block && block.content) { try { block.content = JSON.parse(block.content); } catch(e) { console.error("Failed to parse block content:", e); } }
    return block || null;
  } catch (err) {
    console.error(`Error getting block ${id}:`, err.message);
    return null;
  }
}

/**
 * Updates properties of an existing block (e.g., content, type).
 * @param {string} id - The ID of the block to update.
 * @param {object} updateData - Object with fields to update (e.g., { content, type }).
 * @returns {boolean} - True if update was successful, false otherwise.
 */
function updateBlock(id, updateData) {
  const db = getDb();
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updateData)) {
    // Allow updating type, content, parent_id, block_order
    if (["type", "content", "parent_id", "block_order"].includes(key)) {
      fields.push(`${key} = ?`);
      // Stringify content if it's an object
      values.push(key === "content" && typeof value !== "string" ? JSON.stringify(value) : value);
    }
  }

  if (fields.length === 0) {
    console.warn("No valid fields provided for block update.");
    return false;
  }

  const stmt = db.prepare(`UPDATE blocks SET ${fields.join(", ")} WHERE id = ?`);
  values.push(id);

  try {
    const info = stmt.run(...values);
    console.log(`Updated block ${id}. Rows affected: ${info.changes}`);
    return info.changes > 0;
  } catch (err) {
    console.error(`Error updating block ${id}:`, err.message);
    return false;
  }
}

/**
 * Deletes a block (and potentially its children via CASCADE).
 * @param {string} id - The ID of the block to delete.
 * @returns {boolean} - True if deletion was successful, false otherwise.
 */
function deleteBlock(id) {
  const db = getDb();
  // CASCADE constraint should handle children blocks, attachments, tasks linked to this block
  const stmt = db.prepare("DELETE FROM blocks WHERE id = ?");
  try {
    const info = stmt.run(id);
    console.log(`Deleted block ${id}. Rows affected: ${info.changes}`);
    return info.changes > 0;
  } catch (err) {
    console.error(`Error deleting block ${id}:`, err.message);
    return false;
  }
}

/**
 * Retrieves all top-level blocks for a specific workspace page note, ordered correctly.
 * @param {number} noteId - The ID of the workspace_page note.
 * @returns {object[]} - Array of block objects.
 */
function getBlocksForNote(noteId) {
  const db = getDb();
  // Fetch top-level blocks first (parent_id IS NULL)
  const stmt = db.prepare("SELECT * FROM blocks WHERE note_id = ? AND parent_id IS NULL ORDER BY block_order ASC");
  try {
    const blocks = stmt.all(noteId);
    // TODO: Recursively fetch child blocks if needed, or handle nesting on the frontend.
    // For simplicity, returning only top-level blocks here.
    return blocks;
  } catch (err) {
    console.error(`Error getting blocks for note ${noteId}:`, err.message);
    return [];
  }
}

// TODO: Add functions for:
// - getChildBlocks(parentId)
// - updateBlockOrder(blocksToUpdate) // More complex logic for reordering

module.exports = {
  createBlock,
  getBlockById,
  updateBlock,
  deleteBlock,
  getBlocksForNote,
};

