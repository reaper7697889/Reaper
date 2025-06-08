// src/backend/services/attachmentService.js

const { getDb } = require("../db");
const fs = require("fs").promises; // Use promises for async file operations
const fsSync = require("fs"); // For sync operations like existsSync, statSync if needed in sync parts
const path = require("path");
const exifParser = require('exif-parser');
const pdfParse = require('pdf-parse');
const permissionService = require('./src/backend/services/permissionService.js'); // Corrected path
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

async function _extractMetadata(filePath, mimeType) {
  try {
    const fileBuffer = await fs.readFile(filePath);
    if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
      const parser = exifParser.create(fileBuffer);
      const result = parser.parse();
      return result; // Contains tags, imageSize, thumbnailOffset, etc.
    } else if (mimeType === 'application/pdf') {
      const data = await pdfParse(fileBuffer);
      return {
        info: data.info, // Author, Title, Keywords, etc.
        numpages: data.numpages,
        textSnippet: data.text ? data.text.substring(0, 500) : null // First 500 chars of text
      };
    }
    // Placeholder for other types like DOCX, etc.
    // console.log(`Metadata extraction not implemented for MIME type: ${mimeType}`);
    return null;
  } catch (error) {
    console.error(`Error extracting metadata for file ${filePath} (MIME: ${mimeType}):`, error.message);
    return null; // Return null on error, don't let metadata extraction fail the whole process
  }
}


async function createAttachment({ tempFilePath, original_filename, mime_type }, requestingUserId) { // Modified signature
  await ensureAttachmentDirExists();
  const db = getDb();
  // const { tempFilePath, original_filename, mime_type } = attachmentData; // Original destructuring

  if (!requestingUserId) {
    return { success: false, error: "User ID is required to create an attachment." };
  }
  if (!tempFilePath || !original_filename) {
    return { success: false, error: "Missing temporary file path or original filename." };
  }

  const uniqueFilename = `${Date.now()}-${original_filename.replace(/\s+/g, "_")}`;
  const newFilePathAbsolute = path.join(ATTACHMENT_DIR, uniqueFilename);
  // Store path relative to ATTACHMENT_DIR to make it more portable if ATTACHMENT_DIR changes
  const relativePathForDb = uniqueFilename;

  const transaction = db.transaction(async () => {
    await fs.rename(tempFilePath, newFilePathAbsolute); // Move file first

    let extractedMetadata = null;
    try {
      extractedMetadata = await _extractMetadata(newFilePathAbsolute, mime_type);
    } catch (metaError) {
      console.error(`Metadata extraction failed during createAttachment for ${original_filename}, continuing without metadata:`, metaError.message);
      // extractedMetadata remains null, which is fine
    }
    const extractedMetadataJson = extractedMetadata ? JSON.stringify(extractedMetadata) : null;


    // Step 1: Insert into attachments table
    const attStmt = db.prepare(
      `INSERT INTO attachments (note_id, block_id, user_id, file_path, mime_type, original_filename, created_at)
       VALUES (NULL, NULL, ?, ?, ?, ?, CURRENT_TIMESTAMP)` // note_id and block_id set to NULL
    );
    // Initially store details in attachments table for current version denormalization
    const attInfo = attStmt.run(requestingUserId, relativePathForDb, mime_type, original_filename);
    const newAttachmentId = attInfo.lastInsertRowid;
    if (!newAttachmentId) throw new Error("Failed to create attachment record.");

    // Step 2: Insert into attachment_versions
    const versionStmt = db.prepare(
      `INSERT INTO attachment_versions (attachment_id, file_path, mime_type, original_filename, version_number, user_id, created_at, extracted_metadata)
       VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, ?)`
    );
    const versionInfo = versionStmt.run(newAttachmentId, relativePathForDb, mime_type, original_filename, requestingUserId, extractedMetadataJson);
    const version1Id = versionInfo.lastInsertRowid;
    if (!version1Id) throw new Error("Failed to create initial attachment version.");

    // Step 3: Update attachments with current_version_id
    const updateAttStmt = db.prepare("UPDATE attachments SET current_version_id = ? WHERE id = ?");
    updateAttStmt.run(version1Id, newAttachmentId);

    return {
        id: newAttachmentId,
        // note_id and block_id are null now for the main attachment record
        user_id: requestingUserId,
        file_path: relativePathForDb, mime_type, original_filename,
        current_version_id: version1Id,
        created_at: new Date().toISOString(), // Reflects actual time
        version_number: 1, // For convenience
        extracted_metadata: extractedMetadata // Return parsed, not stringified
    };
  });

  try {
    return { success: true, attachment: await transaction() };
  } catch (err) {
    console.error("Error creating attachment:", err.message, err.stack);
    // Attempt to clean up moved file if transaction fails
    if (fsSync.existsSync(newFilePathAbsolute)) {
        try { await fs.unlink(newFilePathAbsolute); } catch (e) { console.error("Error cleaning up attachment file on create failure:", e); }
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
  const newVersionFilePathAbsolute = path.join(ATTACHMENT_DIR, uniqueFilename);
  const relativePathForDb = uniqueFilename;

  const transaction = db.transaction(async () => {
    await fs.rename(tempFilePath, newVersionFilePathAbsolute);

    let extractedMetadata = null;
    try {
        extractedMetadata = await _extractMetadata(newVersionFilePathAbsolute, mime_type);
    } catch (metaError) {
        console.error(`Metadata extraction failed during updateAttachedFile for ${original_filename}, continuing without metadata:`, metaError.message);
    }
    const extractedMetadataJson = extractedMetadata ? JSON.stringify(extractedMetadata) : null;

    const maxVersionResult = db.prepare("SELECT MAX(version_number) as max_v FROM attachment_versions WHERE attachment_id = ?").get(attachmentId);
    const newVersionNumber = (maxVersionResult && maxVersionResult.max_v !== null) ? maxVersionResult.max_v + 1 : 1;

    const versionStmt = db.prepare(
      `INSERT INTO attachment_versions (attachment_id, file_path, mime_type, original_filename, version_number, user_id, created_at, extracted_metadata)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`
    );
    const versionInfo = versionStmt.run(attachmentId, relativePathForDb, mime_type, original_filename, newVersionNumber, requestingUserId, extractedMetadataJson);
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
        created_at: new Date().toISOString(),
        extracted_metadata: extractedMetadata // Return parsed, not stringified
    };
  });

  try {
    return { success: true, version: await transaction() };
  } catch (err) {
    console.error(`Error updating attachment ${attachmentId}:`, err.message, err.stack);
    if (fsSync.existsSync(newVersionFilePathAbsolute)) {
        try { await fs.unlink(newVersionFilePathAbsolute); } catch (e) { console.error("Error cleaning up new version file on update failure:", e); }
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

  let parsedMetadata = null;
  if (versionDetails.extracted_metadata) {
      try {
          parsedMetadata = JSON.parse(versionDetails.extracted_metadata);
      } catch (e) {
          console.error(`Error parsing extracted_metadata for attachment version ${versionDetails.id}:`, e.message);
          // Optionally include the raw string or an error marker in the response
          // parsedMetadata = { error: "Failed to parse metadata", raw: versionDetails.extracted_metadata };
      }
  }

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
        version_user_id: versionDetails.user_id,
        extracted_metadata_content: parsedMetadata // Added parsed metadata
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
  // getAttachmentsForNote, // Will be updated to use getAttachmentsForEntity
  // getAttachmentsForBlock, // Will be updated to use getAttachmentsForEntity
  deleteAttachment,
  updateAttachedFile,
  getAttachmentDetails,
  listAttachmentVersions,
  setAttachmentVersionAsCurrent,
  updateAttachmentParent,
  linkAttachmentToEntity,
  unlinkAttachmentFromEntity,
  getAttachmentsForEntity,
  getAttachmentsForNote, // Keep in exports, but behavior changes
  getAttachmentsForBlock, // Keep in exports, but behavior changes
};


async function linkAttachmentToEntity(attachmentId, entityType, entityId, requestingUserId) {
  const db = getDb();

  if (!attachmentId || !entityType || !entityId || !requestingUserId) {
    return { success: false, error: "Attachment ID, entity type, entity ID, and requesting user ID are required." };
  }
  if (entityType !== 'note' && entityType !== 'database_row') {
    return { success: false, error: "Invalid entity_type. Must be 'note' or 'database_row'." };
  }

  const attachment = getAttachmentByIdInternal(attachmentId, db);
  if (!attachment) {
    return { success: false, error: "Attachment not found." };
  }

  // Authorization: Check if user has WRITE permission on the target entity
  let permCheck;
  if (entityType === 'note') {
    permCheck = await permissionService.checkUserNotePermission(entityId, requestingUserId, 'WRITE');
  } else if (entityType === 'database_row') {
    // For database_row, we need to find its parent database_id first
    const row = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(entityId);
    if (!row) return { success: false, error: "Database row not found." };
    permCheck = await permissionService.checkUserDatabasePermission(row.database_id, requestingUserId, 'WRITE');
  } else {
     return { success: false, error: "Unsupported entity type for permission check." };
  }

  if (!permCheck || !permCheck.V) {
      return { success: false, error: `Authorization failed: Insufficient permissions to link attachment to ${entityType} ID ${entityId}.` };
  }

  try {
    const stmt = db.prepare(
      `INSERT INTO entity_attachment_links (attachment_id, entity_type, entity_id, user_id)
       VALUES (?, ?, ?, ?)`
    );
    const info = stmt.run(attachmentId, entityType, entityId, requestingUserId);
    return { success: true, linkId: info.lastInsertRowid };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { success: false, error: "This attachment is already linked to this entity." };
    }
    console.error("Error linking attachment to entity:", err.message);
    return { success: false, error: "Failed to link attachment to entity. " + err.message };
  }
}

async function unlinkAttachmentFromEntity(attachmentId, entityType, entityId, requestingUserId) {
  const db = getDb();

  if (!attachmentId || !entityType || !entityId || !requestingUserId) {
    return { success: false, error: "Attachment ID, entity type, entity ID, and requesting user ID are required." };
  }

  // Verify the link exists
  const link = db.prepare(
    `SELECT id, user_id FROM entity_attachment_links
     WHERE attachment_id = ? AND entity_type = ? AND entity_id = ?`
  ).get(attachmentId, entityType, entityId);

  if (!link) {
    return { success: false, error: "Attachment link not found." };
  }

  // Authorization: User who created the link OR has WRITE permission on the entity
  let hasPermission = false;
  if (link.user_id === requestingUserId) {
    hasPermission = true;
  } else {
    let permCheck;
    if (entityType === 'note') {
      permCheck = await permissionService.checkUserNotePermission(entityId, requestingUserId, 'WRITE');
    } else if (entityType === 'database_row') {
      const row = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(entityId);
      if (!row) return { success: false, error: "Database row (for permission check) not found." };
      permCheck = await permissionService.checkUserDatabasePermission(row.database_id, requestingUserId, 'WRITE');
    }
    if (permCheck && permCheck.V) {
      hasPermission = true;
    }
  }

  if (!hasPermission) {
    return { success: false, error: `Authorization failed: Insufficient permissions to unlink attachment from ${entityType} ID ${entityId}.` };
  }

  try {
    const stmt = db.prepare(
      "DELETE FROM entity_attachment_links WHERE id = ?"
    );
    const info = stmt.run(link.id);
    return { success: true, changes: info.changes };
  } catch (err) {
    console.error("Error unlinking attachment from entity:", err.message);
    return { success: false, error: "Failed to unlink attachment. " + err.message };
  }
}

async function getAttachmentsForEntity(entityType, entityId, requestingUserId) {
  const db = getDb();

  if (!entityType || !entityId || !requestingUserId) {
    return { success: false, error: "Entity type, entity ID, and requesting user ID are required." };
  }

  // Authorization: Check READ permission on the target entity
  let permCheck;
  if (entityType === 'note') {
    permCheck = await permissionService.checkUserNotePermission(entityId, requestingUserId, 'READ');
  } else if (entityType === 'database_row') {
    const row = db.prepare("SELECT database_id FROM database_rows WHERE id = ?").get(entityId);
    if (!row) return { success: false, error: "Database row (for permission check) not found." };
    permCheck = await permissionService.checkUserDatabasePermission(row.database_id, requestingUserId, 'READ');
  } else {
      return { success: false, error: "Unsupported entity type for permission check." };
  }

  if (!permCheck || !permCheck.V) {
    return { success: false, error: `Authorization failed: Insufficient permissions to read attachments for ${entityType} ID ${entityId}.` };
  }

  try {
    const links = db.prepare(
      `SELECT attachment_id FROM entity_attachment_links
       WHERE entity_type = ? AND entity_id = ?`
    ).all(entityType, entityId);

    const attachmentsDetails = [];
    for (const link of links) {
      // Using requestingUserId for getAttachmentDetails for its own internal permission checks (user owns attachment)
      const detailsResult = await getAttachmentDetails(link.attachment_id, requestingUserId);
      if (detailsResult.success) {
        attachmentsDetails.push(detailsResult.attachment);
      } else {
        // Log error but continue, some attachments might be inaccessible or deleted
        console.warn(`Could not fetch details for linked attachment ID ${link.attachment_id} for entity ${entityType}:${entityId}. Error: ${detailsResult.error}`);
      }
    }
    return { success: true, attachments: attachmentsDetails };
  } catch (err) {
    console.error(`Error fetching attachments for entity ${entityType} ${entityId}:`, err.message);
    return { success: false, error: "Failed to retrieve attachments for entity." };
  }
}

// --- Legacy/Adapter Functions ---
// These functions are now adapters for the new getAttachmentsForEntity mechanism.
// They can be deprecated in the future.
// For now, they also don't handle the old direct links from attachments.note_id/block_id.
// That would require merging results from two sources if we want to support both simultaneously.
// This implementation assumes all new and relevant links are via entity_attachment_links.

async function getAttachmentsForNote(noteId, requestingUserId) {
    if (!noteId) return { success: false, error: "Note ID is required." };
    // This now primarily fetches attachments linked via entity_attachment_links.
    // It won't fetch attachments that are ONLY linked via the old attachments.note_id column
    // unless getAttachmentsForEntity is enhanced or this function does dual queries.
    // For this subtask, it uses the new system.
    return getAttachmentsForEntity('note', noteId, requestingUserId);
}

async function getAttachmentsForBlock(blockId, requestingUserId) {
    if (!blockId) return { success: false, error: "Block ID is required." };
     // Similar to getAttachmentsForNote, this now uses the new linking table.
    return { success: false, error: "getAttachmentsForBlock using entity_attachment_links is not fully specified if blocks have direct user permissions or rely on note permissions. Assuming 'block' is not a primary linkable entity type for now or needs specific permission logic via its note."};
    // If blocks are distinct entities for permissions:
    // return getAttachmentsForEntity('block', blockId, requestingUserId);
    // If block permissions are derived (e.g. from the note they are in), then direct linking to blocks
    // via entity_attachment_links might need more thought on how permissions are checked in getAttachmentsForEntity
    // or if 'block' entity_type is even used there.
    // The current entity_type CHECK constraint is ('note', 'database_row').
    // So, linking directly to 'block' via this new table is not yet supported by DB schema.
    // This function would need significant rework or removal if attachments.block_id is deprecated.
    // For now, let's make it clear it's not using the new system for 'block' entity type.

    // To keep it simple and reflect current state:
    // This function is problematic if we are moving away from attachments.block_id
    // For now, let's return empty or error, as new attachments won't use attachments.block_id
     console.warn("getAttachmentsForBlock is called, but attachments are moving to entity_attachment_links. Direct block_id links in 'attachments' table are legacy.");
     const db = getDb();
     const attachments = db.prepare("SELECT * FROM attachments WHERE block_id = ? AND user_id = ?").all(blockId, requestingUserId);
     // This old query doesn't use getAttachmentDetails, so it won't have metadata etc.
     // This is just a placeholder to show it's not using the new system.
     return { success: true, attachments: attachments.map(att => ({...att, file_path: path.join(ATTACHMENT_DIR, att.file_path)})) };

}


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
