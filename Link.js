// src/backend/models/Link.js

class Link {
  /**
   * @param {number | null} id
   * @param {number} source_note_id - ID of the note containing the link.
   * @param {number} target_note_id - ID of the note being linked to.
   * @param {string | null} link_text - Optional text used for the link (e.g., [[target_note_id|link_text]]).
   * @param {string | null} created_at - ISO timestamp string.
   */
  constructor(
    id = null,
    source_note_id,
    target_note_id,
    link_text = null,
    created_at = null
  ) {
    this.id = id;
    this.source_note_id = source_note_id;
    this.target_note_id = target_note_id;
    this.link_text = link_text;
    this.created_at = created_at || new Date().toISOString();
  }

  // Static methods for DB interaction (e.g., findBySource, findByTarget) would go here or in a service.
}

module.exports = Link;

