// src/backend/services/graphService.js
const { getDb } = require("../../../db"); // Corrected path

/**
 * Assembles data for the knowledge graph visualization.
 * @returns {Promise<object>} - An object containing nodes and links for the graph:
 *                            { nodes: Array<object>, links: Array<object> }
 *                            Returns empty arrays if an error occurs or no data.
 */
async function getGraphData() {
  const db = getDb();
  try {
    // Fetch Notes
    const notesRaw = db.prepare("SELECT id, title, type, content FROM notes").all();

    // Fetch Links
    const linksRaw = db.prepare("SELECT source_note_id, target_note_id, link_text, target_header, target_block_id, is_embed FROM links").all();

    // Fetch Tags and Note-Tag Associations
    const tagsRaw = db.prepare("SELECT id, name FROM tags").all();
    const noteTagsRaw = db.prepare("SELECT note_id, tag_id FROM note_tags").all();

    // Create a mapping for tag IDs to tag names
    const tagIdToNameMap = tagsRaw.reduce((acc, tag) => {
      acc[tag.id] = tag.name;
      return acc;
    }, {});

    // Create a mapping for note IDs to an array of tag names
    const noteIdToTagsMap = noteTagsRaw.reduce((acc, nt) => {
      if (!acc[nt.note_id]) {
        acc[nt.note_id] = [];
      }
      const tagName = tagIdToNameMap[nt.tag_id];
      if (tagName) {
        acc[nt.note_id].push(tagName);
      }
      return acc;
    }, {});

    // Construct Nodes Array
    const nodes = notesRaw.map(note => ({
      id: note.id,
      title: note.title || `Untitled Note ${note.id}`, // Provide a fallback title
      type: note.type,
      isPlaceholder: !note.content, // Simplified: empty content means placeholder
      tags: noteIdToTagsMap[note.id] || [], // Get tags for the current note, or empty array
    }));

    // Construct Links Array (Edges)
    const links = linksRaw.map(link => ({
      source: link.source_note_id,
      target: link.target_note_id,
      linkText: link.link_text,
      isEmbed: !!link.is_embed, // Ensure boolean
      hasTargetHeader: !!(link.target_header && link.target_header.trim() !== ""),
      hasTargetBlock: !!(link.target_block_id && link.target_block_id.trim() !== ""),
    }));

    return { nodes, links };

  } catch (err) {
    console.error("Error fetching graph data:", err.message);
    // Return empty structure in case of error to prevent frontend crashes
    return { nodes: [], links: [] };
  }
}

module.exports = {
  getGraphData,
};
