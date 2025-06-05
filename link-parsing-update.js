// Update the App.js to connect markdown link parsing to backend

const handleUpdateNote = useCallback(async (noteId, updateData) => {
  try {
    const success = await window.electronAPI.updateNote(noteId, updateData);
    if (success) {
      console.log(`Note ${noteId} updated successfully`);
      // Update the selected note in state to reflect changes
      setSelectedNote(prev => prev && prev.id === noteId ? { ...prev, ...updateData } : prev);
      
      // If this is a markdown note and content was updated, parse for links
      if (selectedNote?.type === 'markdown' && updateData.content) {
        try {
          // Call the backend to update links based on content
          await window.electronAPI.updateLinksFromContent(noteId, updateData.content);
          
          // Refresh backlinks after updating links
          const updatedBacklinks = await window.electronAPI.getBacklinks(noteId);
          setBacklinks(updatedBacklinks || []);
        } catch (error) {
          console.error("Error updating links from content:", error);
        }
      }
    } else {
      console.error(`Failed to update note ${noteId}`);
    }
  } catch (error) {
    console.error(`Error updating note ${noteId}:`, error);
  }
}, [selectedNote]);
