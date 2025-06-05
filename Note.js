// src/backend/models/Note.js

/**
 * Represents the structure for different types of notes.
 * This is a conceptual model; actual data interaction happens via db functions.
 */
class Note {
  /**
   * @param {number | null} id - The note ID (null for new notes).
   * @param {"simple" | "markdown" | "workspace_page"} type - The type of the note.
   * @param {string | null} title - The title of the note.
   * @param {string | null} content - The main content (rich text, markdown, or JSON for blocks).
   * @param {number | null} folder_id - ID of the parent folder (for simple notes).
   * @param {number | null} workspace_id - ID of the parent workspace (for workspace pages).
   * @param {boolean} is_pinned - Whether the note is pinned.
   * @param {boolean} is_archived - Whether the note is archived.
   * @param {string | null} created_at - ISO timestamp string.
   * @param {string | null} updated_at - ISO timestamp string.
   * @param {Tag[]} tags - Array of associated tags.
   * @param {Attachment[]} attachments - Array of associated attachments (for simple/markdown).
   * @param {Block[]} blocks - Array of blocks (for workspace_page).
   * @param {Link[]} backlinks - Array of notes linking to this one (for markdown).
   * @param {Link[]} outgoing_links - Array of links originating from this note (for markdown).
   * @param {Task[]} tasks - Array of tasks within the note (for simple notes).
   */
  constructor(
    id = null,
    type,
    title = null,
    content = null,
    folder_id = null,
    workspace_id = null,
    is_pinned = false,
    is_archived = false,
    created_at = null,
    updated_at = null,
    tags = [],
    attachments = [],
    blocks = [],
    backlinks = [],
    outgoing_links = [],
    tasks = []
  ) {
    this.id = id;
    this.type = type;
    this.title = title;
    this.content = content; // For simple/markdown. Workspace pages use blocks.
    this.folder_id = folder_id;
    this.workspace_id = workspace_id;
    this.is_pinned = is_pinned;
    this.is_archived = is_archived;
    this.created_at = created_at || new Date().toISOString();
    this.updated_at = updated_at || new Date().toISOString();
    this.tags = tags; // Array of Tag objects/ids
    this.attachments = attachments; // Array of Attachment objects/ids
    this.blocks = blocks; // Array of Block objects/ids (for type === "workspace_page")
    this.backlinks = backlinks; // Array of Link objects/ids (for type === "markdown")
    this.outgoing_links = outgoing_links; // Array of Link objects/ids (for type === "markdown")
    this.tasks = tasks; // Array of Task objects/ids (for type === "simple")
  }

  // --- Static methods for interacting with the database would go here or in a separate service/repository class ---
  // e.g., static async findById(id) { ... }
  // e.g., static async create(noteData) { ... }
  // e.g., async save() { ... }
  // e.g., async delete() { ... }
}

// Note: Link, Tag, Attachment, Block, Task classes/structures would be defined similarly in other files.

module.exports = Note;

