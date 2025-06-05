import React, { useState, useEffect } from 'react';
import VoiceMemoRecorder from './components/VoiceMemoRecorder';
import './VoiceMemoEditor.css';

const VoiceMemoEditor = ({ note, onUpdate }) => {
  const [title, setTitle] = useState(note?.title || '');
  const [description, setDescription] = useState('');
  
  // Initialize from note content
  useEffect(() => {
    if (note && note.content) {
      try {
        // Try to parse JSON content
        const parsedContent = JSON.parse(note.content);
        if (parsedContent.audio) {
          // If we have audio data in the content
          if (parsedContent.description) {
            setDescription(parsedContent.description);
          }
        }
      } catch (error) {
        // If content is not JSON, assume it's just the audio data
        console.log("Voice memo content is not in JSON format, using as raw audio data");
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
  
  // Handle description changes
  const handleDescriptionChange = (e) => {
    const newDescription = e.target.value;
    setDescription(newDescription);
    
    // Update note with both audio and description
    if (onUpdate && note.content) {
      try {
        // Try to parse existing content to get audio data
        const existingContent = JSON.parse(note.content);
        onUpdate(note.id, { 
          content: JSON.stringify({
            ...existingContent,
            description: newDescription
          })
        });
      } catch (error) {
        // If parsing fails, create new content object with just the description
        onUpdate(note.id, { 
          content: JSON.stringify({
            description: newDescription
          })
        });
      }
    }
  };
  
  // Handle audio save
  const handleAudioSave = (audioData) => {
    if (onUpdate) {
      try {
        // Try to parse existing content to preserve description
        let updatedContent;
        try {
          const existingContent = JSON.parse(note.content);
          updatedContent = {
            ...existingContent,
            audio: audioData
          };
        } catch (error) {
          // If parsing fails, create new content object
          updatedContent = {
            audio: audioData,
            description: description
          };
        }
        
        onUpdate(note.id, { content: JSON.stringify(updatedContent) });
      } catch (error) {
        console.error("Failed to save audio data:", error);
      }
    }
  };
  
  // Extract audio data from note content
  const getAudioData = () => {
    if (!note || !note.content) return null;
    
    try {
      const parsedContent = JSON.parse(note.content);
      return parsedContent.audio || null;
    } catch (error) {
      // If parsing fails, assume content is raw audio data
      return note.content;
    }
  };
  
  return (
    <div className="voice-memo-editor">
      <input 
        type="text"
        className="note-title-input"
        value={title}
        onChange={handleTitleChange}
        placeholder="Voice Memo Title"
      />
      
      <div className="editor-container">
        <VoiceMemoRecorder 
          initialAudio={getAudioData()}
          onSave={handleAudioSave}
        />
        
        <textarea
          className="memo-description"
          value={description}
          onChange={handleDescriptionChange}
          placeholder="Add a description for this voice memo..."
        />
      </div>
    </div>
  );
};

export default VoiceMemoEditor;
