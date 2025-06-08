import React, { useState, useEffect } from 'react';
import './TemplateManager.css'; // Assuming CSS file is in the same directory

// Mock currentUserId for now, this would come from auth context or props
const MOCK_CURRENT_USER_ID = 1; // Replace with actual user ID logic later

function TemplateManager({ navigateToNoteEditor }) { // navigateToNoteEditor as a prop for navigation
  const [templates, setTemplates] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchTemplates = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // console.log('TemplateManager: Fetching templates for user:', MOCK_CURRENT_USER_ID);
      const fetchedTemplates = await window.electron.ipcRenderer.invoke('templates:get', MOCK_CURRENT_USER_ID);
      // console.log('TemplateManager: Fetched templates:', fetchedTemplates);
      if (Array.isArray(fetchedTemplates)) {
        setTemplates(fetchedTemplates);
      } else {
        console.error("Error: templates:get did not return an array.", fetchedTemplates);
        setTemplates([]); // Set to empty array on unexpected response
        setError("Could not load templates: Unexpected data format.");
      }
    } catch (err) {
      console.error("Error fetching templates:", err);
      setError(`Error fetching templates: ${err.message}`);
      setTemplates([]); // Clear templates on error
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const handleEditTemplate = (templateId) => {
    console.log('Edit template:', templateId);
    // This would typically navigate to the note editor with the templateId
    if (navigateToNoteEditor) {
        navigateToNoteEditor(templateId); // Assuming this function handles opening the note
    } else {
        alert(`Navigate to editor for note ID: ${templateId}`); // Placeholder
    }
  };

  const handleDeleteTemplate = async (templateId) => {
    if (!window.confirm("Are you sure you want to delete this template? This action cannot be undone.")) {
        return;
    }
    try {
        // Templates are just notes, so use db:deleteNote.
        // The service layer will handle if it's a soft or hard delete based on its implementation.
        const result = await window.electron.ipcRenderer.invoke('db:deleteNote', templateId, MOCK_CURRENT_USER_ID);
        if (result && result.success) {
            alert('Template deleted successfully.');
            fetchTemplates(); // Refresh the list
        } else {
            alert(`Error deleting template: ${result ? result.error : 'Unknown error'}`);
        }
    } catch (err) {
        alert(`Error deleting template: ${err.message}`);
    }
  };

  const handleSetTemplateStatus = async (noteId, isTemplate) => {
    try {
      const result = await window.electron.ipcRenderer.invoke('note:setTemplateStatus', noteId, isTemplate, MOCK_CURRENT_USER_ID);
      if (result && result.success) {
        alert(`Note status updated. It is ${isTemplate ? 'now' : 'no longer'} a template.`);
        fetchTemplates(); // Refresh templates list
      } else {
        alert(`Error updating note template status: ${result ? result.error : 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Error updating note template status: ${err.message}`);
    }
  };

  // Placeholder for creating a new template - this might involve navigating to a new note editor
  // or a more complex flow. For now, it's just a button.
  const handleCreateNewTemplate = async () => {
    try {
      const result = await window.electron.ipcRenderer.invoke('template:createBlank', MOCK_CURRENT_USER_ID, "New Untitled Template");
      if (result && result.success && result.template) {
        alert('New blank template created! Opening for editing...');
        if (navigateToNoteEditor) {
          navigateToNoteEditor(result.template.id); // Navigate to edit the new template
        } else {
          console.warn("navigateToNoteEditor prop not provided to TemplateManager.");
        }
        fetchTemplates(); // Refresh the list of templates
      } else {
        alert(`Error creating new blank template: ${result ? result.error : 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Error creating new blank template: ${err.message}`);
      console.error("Error in handleCreateNewTemplate:", err);
    }
  };


  if (isLoading) {
    return <div className="template-manager"><p>Loading templates...</p></div>;
  }

  if (error) {
    return <div className="template-manager"><p style={{ color: 'red' }}>{error}</p></div>;
  }

  return (
    <div className="template-manager">
      <h2>Note Templates</h2>
      {templates.length === 0 ? (
        <p>No templates found. Create a note and mark it as a template, or use the button below.</p>
      ) : (
        <ul className="template-list">
          {templates.map(template => (
            <li key={template.id} className="template-item">
              <div>
                <span className="template-title">{template.title || 'Untitled Template'}</span>
                <p className="template-meta">Type: {template.type} | Last updated: {new Date(template.updated_at).toLocaleDateString()}</p>
              </div>
              <div className="template-actions">
                <button onClick={() => handleEditTemplate(template.id)}>Edit</button>
                {/* Convert to regular note button */}
                <button onClick={() => handleSetTemplateStatus(template.id, false)}>Make Regular Note</button>
                <button onClick={() => handleDeleteTemplate(template.id)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button className="create-template-button" onClick={handleCreateNewTemplate}>
        Create New Template (Placeholder)
      </button>
      <p style={{fontSize: '0.8em', marginTop: '20px'}}>
        Tip: To create a template, make a regular note, then find an option (e.g., in note menu or file list context menu - to be implemented) to "Mark as Template".
        Alternatively, an existing note can be marked as a template.
      </p>
    </div>
  );
}

export default TemplateManager;
