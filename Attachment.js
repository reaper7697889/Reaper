// src/backend/models/Attachment.js

class Attachment {
  /**
   * @param {number | null} id
   * @param {number | null} note_id - ID of the note it's attached to (if not in a block).
   * @param {string | null} block_id - ID of the block it's embedded in (if workspace).
   * @param {string} file_path - Relative path to the stored file.
   * @param {string | null} mime_type - MIME type of the file.
   * @param {string | null} original_filename - Original name of the uploaded file.
   * @param {string | null} created_at - ISO timestamp string.
   */
  constructor(
    id = null,
    note_id = null,
    block_id = null,
    file_path,
    mime_type = null,
    original_filename = null,
    created_at = null
  ) {
    this.id = id;
    this.note_id = note_id;
    this.block_id = block_id;
    this.file_path = file_path;
    this.mime_type = mime_type;
    this.original_filename = original_filename;
    this.created_at = created_at || new Date().toISOString();
  }

  // Static methods for DB interaction (e.g., create, findByNoteId) would go here or in a service.
}

module.exports = Attachment;

