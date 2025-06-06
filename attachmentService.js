// src/backend/services/attachmentService.js

const { getDb } = require("../db");
const fs = require("fs").promises; // Use promises for async file operations
const fsSync = require("fs"); // For sync operations like existsSync, statSync if needed in sync parts
const path = require("path");
// TODO: For authorization, import noteService/blockService if needed to check parent ownership.
// For now, authorization will be basic based on requestingUserId matching attachment.user_id.

// Define a base directory for storing attachments.
// If attachmentService.js is in the project root /app:
const PROJECT_ROOT = __dirname;
const ATTACHMENT_DIR = path.join(PROJECT_ROOT, "attachments_data"); // Store in /app/attachments_data


async function ensureAttachmentDirExists() {
  try {
    if (!fsSync.existsSync(ATTACHMENT_DIR)) {
      await fs.mkdir(ATTACHMENT_DIR, { recursive: true });
    }
  } catch (err) {
    console.error("Error creating attachment directory:", err);
    throw new Error("Could not initialize attachment storage.");
  }
}

// Helper to get attachment by ID for internal use (e.g., before an update/delete auth check)
function getAttachmentByIdInternal(attachmentId, dbInstance = null) {
    const db = dbInstance || getDb();
    return db.prepare("SELECT * FROM attachments WHERE id = ?").get(attachmentId);
}


async function createAttachment(attachmentData, requestingUserId) {
  await ensureAttachmentDirExists();
  const db = getDb();
  const { note_id = null, block_id = null, tempFilePath, original_filename, mime_type } = attachmentData;

  if (!requestingUserId) {
    return { success: false, error: "User ID is required to create an attachment." };
  }
  if (!tempFilePath || !original_filename) {
    return { success: false, error: "Missing temporary file path or original filename." };
  }

  const uniqueFilename = `${Date.now()}-${original_filename.replace(/\s+/g, "_")}`;
  const newFilePath = path.join(ATTACHMENT_DIR, uniqueFilename);
  // Store path relative to ATTACHMENT_DIR to make it more portable if ATTACHMENT_DIR changes
  const relativePathForDb = uniqueFilename;

  const transaction = db.transaction(async () => {
    await fs.rename(tempFilePath, newFilePath); // Move file first

    // Step 1: Insert into attachments table
    const attStmt = db.prepare(
      `INSERT INTO attachments (note_id, block_id, user_id, file_path, mime_type, original_filename, created_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    );
    // Initially store details in attachments table for current version denormalization
    const attInfo = attStmt.run(note_id, block_id, requestingUserId, relativePathForDb, mime_type, original_filename);
    const newAttachmentId = attInfo.lastInsertRowid;
    if (!newAttachmentId) throw new Error("Failed to create attachment record.");

    // Step 2: Insert into attachment_versions
    const versionStmt = db.prepare(
      `INSERT INTO attachment_versions (attachment_id, file_path, mime_type, original_filename, version_number, user_id, created_at)
       VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)`
    );
    const versionInfo = versionStmt.run(newAttachmentId, relativePathForDb, mime_type, original_filename, requestingUserId);
    const version1Id = versionInfo.lastInsertRowid;
    if (!version1Id) throw new Error("Failed to create initial attachment version.");

    // Step 3: Update attachments with current_version_id
    const updateAttStmt = db.prepare("UPDATE attachments SET current_version_id = ? WHERE id = ?");
    updateAttStmt.run(version1Id, newAttachmentId);

    return {
        id: newAttachmentId,
        note_id, block_id, user_id: requestingUserId,
        file_path: relativePathForDb, mime_type, original_filename,
        current_version_id: version1Id,
        created_at: new Date().toISOString(), // Reflects actual time
        version_number: 1 // For convenience
    };
  });

  try {
    return { success: true, attachment: await transaction() };
  } catch (err) {
    console.error("Error creating attachment:", err.message, err.stack);
    // Attempt to clean up moved file if transaction fails
    if (fsSync.existsSync(newFilePath)) {
        try { await fs.unlink(newFilePath); } catch (e) { console.error("Error cleaning up attachment file on create failure:", e); }
    }
    return { success: false, error: err.message || "Failed to create attachment." };
  }
}

async function updateAttachedFile(attachmentId, newFileDetails, requestingUserId) {
  await ensureAttachmentDirExists();
  const db = getDb();
  const { tempFilePath, original_filename, mime_type } = newFileDetails;

  if (!attachmentId || !requestingUserId) return { success: false, error: "Attachment ID and User ID are required."};
  if (!tempFilePath || !original_filename) return { success: false, error: "New file path and original filename are required."};

  const attachment = getAttachmentByIdInternal(attachmentId, db);
  if (!attachment) return { success: false, error: "Attachment not found." };

  // Authorization: User who created the attachment or (TODO) has write access to parent note/block
  if (attachment.user_id !== requestingUserId) {
      // Add more sophisticated check if user has permission on parent note/block
      return { success: false, error: "Authorization failed to update attachment." };
  }

  const uniqueFilename = `${Date.now()}-${original_filename.replace(/\s+/g, "_")}`;
  const newVersionFilePath = path.join(ATTACHMENT_DIR, uniqueFilename);
  const relativePathForDb = uniqueFilename;

  const transaction = db.transaction(async () => {
    await fs.rename(tempFilePath, newVersionFilePath);

    const maxVersionResult = db.prepare("SELECT MAX(version_number) as max_v FROM attachment_versions WHERE attachment_id = ?").get(attachmentId);
    const newVersionNumber = (maxVersionResult && maxVersionResult.max_v !== null) ? maxVersionResult.max_v + 1 : 1;

    const versionStmt = db.prepare(
      `INSERT INTO attachment_versions (attachment_id, file_path, mime_type, original_filename, version_number, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    );
    const versionInfo = versionStmt.run(attachmentId, relativePathForDb, mime_type, original_filename, newVersionNumber, requestingUserId);
    const newVersionId = versionInfo.lastInsertRowid;
    if (!newVersionId) throw new Error("Failed to create new attachment version.");

    const updateAttStmt = db.prepare(
      `UPDATE attachments SET current_version_id = ?, file_path = ?, mime_type = ?, original_filename = ?
       WHERE id = ?`
    );
    updateAttStmt.run(newVersionId, relativePathForDb, mime_type, original_filename, attachmentId);

    return {
        attachment_id: attachmentId,
        id: newVersionId, // ID of this version record
        file_path: relativePathForDb, mime_type, original_filename,
        version_number: newVersionNumber, user_id: requestingUserId,
        created_at: new Date().toISOString()
    };
  });

  try {
    return { success: true, version: await transaction() };
  } catch (err) {
    console.error(`Error updating attachment ${attachmentId}:`, err.message, err.stack);
    if (fsSync.existsSync(newVersionFilePath)) {
        try { await fs.unlink(newVersionFilePath); } catch (e) { console.error("Error cleaning up new version file on update failure:", e); }
    }
    return { success: false, error: err.message || "Failed to update attachment." };
  }
}


async function getAttachmentDetails(attachmentId, requestingUserId, { versionNumber = null } = {}) {
  const db = getDb();
  if (!attachmentId || !requestingUserId) return { success: false, error: "Attachment ID and User ID are required."};

  const attachment = getAttachmentByIdInternal(attachmentId, db);
  if (!attachment) return { success: false, error: "Attachment not found." };

  // Authorization: User who created the attachment or (TODO) has read access to parent note/block
  if (attachment.user_id !== requestingUserId) {
      // Add more sophisticated check if user has permission on parent note/block
      // For now, simple ownership check on attachment itself.
      return { success: false, error: "Authorization failed to get attachment details." };
  }

  let versionDetails;
  if (versionNumber === null || versionNumber === undefined) { // Get current version
    if (!attachment.current_version_id) return { success: false, error: "Attachment has no current version."};
    versionDetails = db.prepare("SELECT * FROM attachment_versions WHERE id = ?").get(attachment.current_version_id);
  } else { // Get specific version
    versionDetails = db.prepare("SELECT * FROM attachment_versions WHERE attachment_id = ? AND version_number = ?").get(attachmentId, versionNumber);
  }

  if (!versionDetails) return { success: false, error: versionNumber ? `Version ${versionNumber} not found.` : "Current version details not found."};

  // Construct full file path for client if needed, or keep relative for internal use.
  // For now, use relative path from DB.
  return {
    success: true,
    attachment: {
        ...attachment, // Main attachment record fields (id, note_id, block_id, user_id)
        // Overwrite with specific version details for path, mime, original_filename if showing specific version
        file_path: versionDetails.file_path,
        mime_type: versionDetails.mime_type,
        original_filename: versionDetails.original_filename,
        version_id: versionDetails.id,
        version_number: versionDetails.version_number,
        version_created_at: versionDetails.created_at,
        version_user_id: versionDetails.user_id
    }
  };
}

async function listAttachmentVersions(attachmentId, requestingUserId) {
  const db = getDb();
  if (!attachmentId || !requestingUserId) return { success: false, error: "Attachment ID and User ID are required."};

  const attachment = getAttachmentByIdInternal(attachmentId, db);
  if (!attachment) return { success: false, error: "Attachment not found." };

  // Authorization
  if (attachment.user_id !== requestingUserId) {
    return { success: false, error: "Authorization failed to list versions." };
  }

  const versions = db.prepare(
    `SELECT av.*, u.username as uploaded_by_username
     FROM attachment_versions av
     LEFT JOIN users u ON av.user_id = u.id
     WHERE av.attachment_id = ?
     ORDER BY av.version_number DESC`
  ).all(attachmentId);

  return { success: true, versions };
}

async function setAttachmentVersionAsCurrent(attachmentId, versionIdToSetCurrent, requestingUserId) {
  const db = getDb();
  if (!attachmentId || !versionIdToSetCurrent || !requestingUserId) return { success: false, error: "Attachment ID, Version ID and User ID are required."};

  const attachment = getAttachmentByIdInternal(attachmentId, db);
  if (!attachment) return { success: false, error: "Attachment not found." };

  // Authorization
  if (attachment.user_id !== requestingUserId) {
    return { success: false, error: "Authorization failed to set current version." };
  }

  const versionToSet = db.prepare("SELECT * FROM attachment_versions WHERE id = ? AND attachment_id = ?").get(versionIdToSetCurrent, attachmentId);
  if (!versionToSet) return { success: false, error: "Specified version not found for this attachment."};

  try {
    const stmt = db.prepare(
      `UPDATE attachments
       SET current_version_id = ?, file_path = ?, mime_type = ?, original_filename = ?
       WHERE id = ?`
    );
    stmt.run(versionToSet.id, versionToSet.file_path, versionToSet.mime_type, versionToSet.original_filename, attachmentId);
    return { success: true, message: `Version ${versionToSet.version_number} set as current.`};
  } catch (err) {
    console.error(`Error setting attachment version ${versionIdToSetCurrent} as current for attachment ${attachmentId}:`, err.message);
    return { success: false, error: "Failed to set attachment version."};
  }
}


async function deleteAttachment(attachmentId, requestingUserId) {
  const db = getDb();
  if (!attachmentId || !requestingUserId) return { success: false, error: "Attachment ID and User ID are required."};

  const attachment = getAttachmentByIdInternal(attachmentId, db);
  if (!attachment) return { success: false, error: "Attachment not found." };

  // Authorization
  if (attachment.user_id !== requestingUserId) {
    return { success: false, error: "Authorization failed to delete attachment." };
  }

  const transaction = db.transaction(async () => {
    const versions = db.prepare("SELECT file_path FROM attachment_versions WHERE attachment_id = ?").all(attachmentId);
    for (const version of versions) {
      const fullPath = path.join(ATTACHMENT_DIR, version.file_path);
      try {
        if (fsSync.existsSync(fullPath)) { // Check before unlinking
          await fs.unlink(fullPath);
          console.log(`Deleted attachment version file: ${fullPath}`);
        }
      } catch (fileErr) {
        console.error(`Error deleting attachment version file ${fullPath}:`, fileErr.message);
        // Decide if this should throw and rollback or just log. For now, log and continue.
      }
    }
    // ON DELETE CASCADE on attachment_versions.attachment_id will delete version records.
    const info = db.prepare("DELETE FROM attachments WHERE id = ?").run(attachmentId);
    if (info.changes === 0) throw new Error("Attachment record not found during delete, despite initial check.");
    return { changes: info.changes };
  });

  try {
    const result = await transaction();
    return { success: true, changes: result.changes };
  } catch (err) {
    console.error(`Error deleting attachment ${attachmentId}:`, err.message, err.stack);
    return { success: false, error: "Failed to delete attachment. " + err.message };
  }
}

module.exports = {
  createAttachment,
  getAttachmentsForNote, // This might need update to reflect versioning or use getAttachmentDetails
  getAttachmentsForBlock, // Same as above
  deleteAttachment,
  updateAttachedFile,
  getAttachmentDetails,
  listAttachmentVersions,
  setAttachmentVersionAsCurrent,
  updateAttachmentParent, // Export the new function
};

async function updateAttachmentParent(attachmentId, parentEntityId, parentEntityType, requestingUserId) {
  const db = getDb();

  if (!attachmentId || !parentEntityId || !parentEntityType || !requestingUserId) {
    return { success: false, error: "Attachment ID, parent entity ID, parent entity type, and requesting user ID are required." };
  }

  const attachment = getAttachmentByIdInternal(attachmentId, db);
  if (!attachment) {
    return { success: false, error: "Attachment not found." };
  }

  // Authorization: Only the user who created the attachment can change its parentage.
  if (attachment.user_id !== requestingUserId) {
    return { success: false, error: "Authorization failed: You do not own this attachment." };
  }

  let noteIdToSet = null;
  let blockIdToSet = null;

  if (parentEntityType === 'note') {
    noteIdToSet = parentEntityId;
  } else if (parentEntityType === 'block') {
    blockIdToSet = parentEntityId;
  } else {
    return { success: false, error: "Invalid parentEntityType. Must be 'note' or 'block'." };
  }

  try {
    // The `attachments` table does not have an `updated_at` column as per schema check.
    const stmt = db.prepare(
      "UPDATE attachments SET note_id = ?, block_id = ? WHERE id = ?"
    );
    const info = stmt.run(noteIdToSet, blockIdToSet, attachmentId);

    if (info.changes > 0) {
      return { success: true };
    } else {
      // This could happen if the attachmentId was valid but somehow the update affected no rows
      // (e.g., already set to these values, or a race condition if it was deleted).
      // For now, consider it a non-error if no changes, but could be an error.
      return { success: true, message: "No changes made to attachment parentage (values might be the same)." };
    }
  } catch (error) {
    console.error(`Error updating attachment parent for attachment ${attachmentId}:`, error);
    return { success: false, error: error.message || "Failed to update attachment parent." };
  }
}
