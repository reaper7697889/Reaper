// src/backend/services/attachmentService.js

const { getDb } = require("../db");
const fs = require("fs").promises; // Use promises for async file operations
const path = require("path");

// Define a base directory for storing attachments (should be configurable)
// For Electron, this might be inside app.getPath("userData")
const ATTACHMENT_DIR = path.join(__dirname, "..", "..", "..", "attachments");

/**
 * Ensures the attachment directory exists.
 */
async function ensureAttachmentDirExists() {
  try {
    await fs.mkdir(ATTACHMENT_DIR, { recursive: true });
  } catch (err) {
    console.error("Error creating attachment directory:", err);
    throw new Error("Could not initialize attachment storage.");
  }
}

/**
 * Creates an attachment record in the database and saves the file.
 * Assumes the file has already been uploaded/placed in a temporary location.
 *
 * @param {object} attachmentData - Data including { note_id, block_id, tempFilePath, original_filename, mime_type }
 * @returns {object | null} - The created attachment record or null on failure.
 */
async function createAttachment(attachmentData) {
  await ensureAttachmentDirExists();
  const db = getDb();
  const { note_id = null, block_id = null, tempFilePath, original_filename, mime_type } = attachmentData;

  if (!tempFilePath || !original_filename) {
    console.error("Missing temporary file path or original filename for attachment.");
    return null;
  }

  // Generate a unique filename for storage (e.g., using timestamp or UUID)
  const uniqueFilename = `${Date.now()}-${original_filename.replace(/\s+/g, "_")}`;
  const newFilePath = path.join(ATTACHMENT_DIR, uniqueFilename);
  const relativePath = path.relative(path.join(__dirname, "..", ".."), newFilePath); // Store path relative to project root or userData

  try {
    // Move the file from temp location to attachment directory
    await fs.rename(tempFilePath, newFilePath);
    console.log(`Moved attachment to: ${newFilePath}`);

    // Insert record into the database
    const stmt = db.prepare(`
      INSERT INTO attachments (note_id, block_id, file_path, mime_type, original_filename, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const info = stmt.run(note_id, block_id, relativePath, mime_type, original_filename);

    console.log(`Created attachment record with ID: ${info.lastInsertRowid}`);
    return {
        id: info.lastInsertRowid,
        note_id,
        block_id,
        file_path: relativePath,
        mime_type,
        original_filename,
        created_at: new Date().toISOString()
    };

  } catch (err) {
    console.error("Error creating attachment:", err.message);
    // Attempt to clean up moved file if DB insert fails
    try {
        await fs.unlink(newFilePath);
        console.log(`Cleaned up failed attachment file: ${newFilePath}`);
    } catch (cleanupErr) {
        console.error("Error cleaning up attachment file:", cleanupErr);
    }
    return null;
  }
}

/**
 * Retrieves all attachments linked to a specific note.
 * @param {number} noteId
 * @returns {object[]}
 */
function getAttachmentsForNote(noteId) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM attachments WHERE note_id = ? ORDER BY created_at");
  try {
    return stmt.all(noteId);
  } catch (err) {
    console.error(`Error getting attachments for note ${noteId}:`, err.message);
    return [];
  }
}

/**
 * Retrieves all attachments linked to a specific block.
 * @param {string} blockId
 * @returns {object[]}
 */
function getAttachmentsForBlock(blockId) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM attachments WHERE block_id = ? ORDER BY created_at");
  try {
    return stmt.all(blockId);
  } catch (err) {
    console.error(`Error getting attachments for block ${blockId}:`, err.message);
    return [];
  }
}

/**
 * Deletes an attachment record and its corresponding file.
 * @param {number} id - The ID of the attachment to delete.
 * @returns {boolean} - True if successful, false otherwise.
 */
async function deleteAttachment(id) {
  const db = getDb();
  const stmtSelect = db.prepare("SELECT file_path FROM attachments WHERE id = ?");

  try {
    const attachment = stmtSelect.get(id);
    if (!attachment) {
      console.warn(`Attachment with ID ${id} not found.`);
      return false;
    }

    // Delete DB record first
    const stmtDelete = db.prepare("DELETE FROM attachments WHERE id = ?");
    const info = stmtDelete.run(id);

    if (info.changes > 0) {
      console.log(`Deleted attachment record ${id}.`);
      // Delete the actual file
      const filePath = path.join(__dirname, "..", "..", attachment.file_path);
      try {
        await fs.unlink(filePath);
        console.log(`Deleted attachment file: ${filePath}`);
      } catch (fileErr) {
        console.error(`Error deleting attachment file ${filePath}:`, fileErr.message);
        // Log error but consider DB deletion successful
      }
      return true;
    } else {
      console.warn(`No attachment record found to delete for ID ${id}.`);
      return false;
    }
  } catch (err) {
    console.error(`Error deleting attachment ${id}:`, err.message);
    return false;
  }
}

module.exports = {
  createAttachment,
  getAttachmentsForNote,
  getAttachmentsForBlock,
  deleteAttachment,
};

