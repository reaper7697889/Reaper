import React, { useState, useEffect } from 'react';
import BlockEditor from './components/BlockEditor';
import './BlockWorkspaceEditor.css';

const BlockWorkspaceEditor = ({ note, onUpdate }) => {
  const [title, setTitle] = useState(note?.title || '');
  const [blocks, setBlocks] = useState([]);
  
  // Initialize blocks from note content or create default blocks
  useEffect(() => {
    if (note && note.id) {
      // Try to parse blocks from note content if available
      try {
        if (note.content && typeof note.content === 'string' && note.content.trim().startsWith('[')) {
          const parsedBlocks = JSON.parse(note.content);
          if (Array.isArray(parsedBlocks)) {
            setBlocks(parsedBlocks);
            return;
          }
        }
      } catch (error) {
        console.error("Failed to parse blocks from note content:", error);
      }
      
      // If we get here, either there was no content or parsing failed
      // Fetch blocks from backend
      const fetchBlocks = async () => {
        try {
          const fetchedBlocks = await window.electronAPI.getBlocksForNote(note.id);
          if (fetchedBlocks && fetchedBlocks.length > 0) {
            // Transform backend blocks to format expected by BlockEditor
            const formattedBlocks = fetchedBlocks.map(block => ({
              id: block.id,
              type: block.type,
              content: block.content,
              metadata: block.metadata ? JSON.parse(block.metadata) : {}
            }));
            setBlocks(formattedBlocks);
          } else {
            // Create a default heading block if no blocks exist
            setBlocks([
              {
                id: `block-${Date.now()}`,
                type: 'heading',
                content: note.title || 'Untitled Page',
                metadata: { level: 1 }
              }
            ]);
          }
        } catch (error) {
          console.error("Failed to fetch blocks for note:", error);
          // Create default block on error
          setBlocks([
            {
              id: `block-${Date.now()}`,
              type: 'heading',
              content: note.title || 'Untitled Page',
              metadata: { level: 1 }
            }
          ]);
        }
      };
      
      fetchBlocks();
    }
  }, [note?.id, note?.content, note?.title]);
  
  // Handle title changes
  const handleTitleChange = (e) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    if (onUpdate) {
      onUpdate(note.id, { title: newTitle });
    }
  };
  
  // Handle blocks changes
  const handleBlocksChange = async (updatedBlocks) => {
    setBlocks(updatedBlocks);
    
    // Save blocks to backend
    if (onUpdate) {
      // For simplicity, we'll store the blocks as JSON in the note content
      // In a real implementation, you might want to save each block individually
      const blocksJson = JSON.stringify(updatedBlocks);
      onUpdate(note.id, { content: blocksJson });
      
      // Additionally, sync individual blocks with backend
      try {
        // First, get existing blocks to determine what to create/update/delete
        const existingBlocks = await window.electronAPI.getBlocksForNote(note.id);
        const existingBlockIds = existingBlocks.map(block => block.id);
        const updatedBlockIds = updatedBlocks.map(block => block.id);
        
        // Create or update blocks
        for (const block of updatedBlocks) {
          const blockData = {
            id: block.id,
            note_id: note.id,
            type: block.type,
            content: block.content,
            metadata: JSON.stringify(block.metadata || {})
          };
          
          if (existingBlockIds.includes(block.id)) {
            // Update existing block
            await window.electronAPI.updateBlock(block.id, blockData);
          } else {
            // Create new block
            await window.electronAPI.createBlock(blockData);
          }
        }
        
        // Delete blocks that no longer exist
        for (const blockId of existingBlockIds) {
          if (!updatedBlockIds.includes(blockId)) {
            await window.electronAPI.deleteBlock(blockId);
          }
        }
      } catch (error) {
        console.error("Failed to sync blocks with backend:", error);
      }
    }
  };
  
  return (
    <div className="block-workspace-editor">
      <input 
        type="text"
        className="note-title-input"
        value={title}
        onChange={handleTitleChange}
        placeholder="Page Title"
      />
      <div className="editor-container">
        <BlockEditor 
          blocks={blocks}
          onBlocksChange={handleBlocksChange}
        />
      </div>
    </div>
  );
};

export default BlockWorkspaceEditor;
