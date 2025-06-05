import React, { useState, useEffect } from 'react';
import DrawingCanvas from './components/DrawingCanvas';
import './DrawingEditor.css';

const DrawingEditor = ({ note, onUpdate }) => {
  const [title, setTitle] = useState(note?.title || '');
  const [drawingData, setDrawingData] = useState(null);
  
  // Initialize drawing data from note content
  useEffect(() => {
    if (note && note.content) {
      try {
        // Check if content is valid JSON drawing data
        JSON.parse(note.content);
        setDrawingData(note.content);
      } catch (error) {
        console.error("Failed to parse drawing data:", error);
        setDrawingData(null);
      }
    }
  }, [note]);
  
  // Handle title changes
  const handleTitleChange = (e) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    if (onUpdate) {
      onUpdate(note.id, { title: newTitle });
    }
  };
  
  // Handle drawing save
  const handleDrawingSave = (saveData) => {
    setDrawingData(saveData);
    if (onUpdate) {
      onUpdate(note.id, { content: saveData });
    }
  };
  
  return (
    <div className="drawing-editor">
      <input 
        type="text"
        className="note-title-input"
        value={title}
        onChange={handleTitleChange}
        placeholder="Drawing Title"
      />
      <div className="editor-container">
        <DrawingCanvas 
          initialData={drawingData}
          onSave={handleDrawingSave}
        />
      </div>
    </div>
  );
};

export default DrawingEditor;
