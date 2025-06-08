import React, { useState, useEffect } from 'react';
import './TemplateSelectionModal.css';

// Mock currentUserId for now
const MOCK_CURRENT_USER_ID = 1;

function TemplateSelectionModal({ isOpen, onClose, onSelectTemplate }) {
  const [templates, setTemplates] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen) {
      const fetchTemplatesForModal = async () => {
        setIsLoading(true);
        setError(null);
        try {
          const fetchedTemplates = await window.electron.ipcRenderer.invoke('templates:get', MOCK_CURRENT_USER_ID);
          if (Array.isArray(fetchedTemplates)) {
            setTemplates(fetchedTemplates);
          } else {
            setTemplates([]);
            setError("Could not load templates: Unexpected data format.");
          }
        } catch (err) {
          console.error("Error fetching templates for modal:", err);
          setError(`Error fetching templates: ${err.message}`);
          setTemplates([]);
        } finally {
          setIsLoading(false);
        }
      };
      fetchTemplatesForModal();
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>Select a Template</h3>
        {isLoading && <p>Loading templates...</p>}
        {error && <p style={{ color: 'red' }}>{error}</p>}
        {!isLoading && !error && (
          templates.length === 0 ? (
            <p>No templates available.</p>
          ) : (
            <ul className="modal-list">
              {templates.map(template => (
                <li
                  key={template.id}
                  className="modal-list-item"
                  onClick={() => onSelectTemplate(template.id)}
                >
                  {template.title || 'Untitled Template'} ({template.type})
                </li>
              ))}
            </ul>
          )
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default TemplateSelectionModal;
