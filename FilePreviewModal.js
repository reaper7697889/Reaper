import React, { useState, useEffect } from 'react';
import FileAttachmentHandler from './FileAttachmentHandler';
import './FilePreviewModal.css';

const FilePreviewModal = ({ attachment, onClose }) => {
  const [previewContent, setPreviewContent] = useState(null);
  
  useEffect(() => {
    if (!attachment) return;
    
    // Determine preview type based on file type
    if (attachment.type.startsWith('image/')) {
      setPreviewContent(
        <div className="image-preview">
          <img src={attachment.data} alt={attachment.name} />
        </div>
      );
    } else if (attachment.type.startsWith('audio/')) {
      setPreviewContent(
        <div className="audio-preview">
          <audio controls src={attachment.data}>
            Your browser does not support the audio element.
          </audio>
        </div>
      );
    } else if (attachment.type.startsWith('video/')) {
      setPreviewContent(
        <div className="video-preview">
          <video controls src={attachment.data}>
            Your browser does not support the video element.
          </video>
        </div>
      );
    } else if (attachment.type.startsWith('text/') || 
               attachment.type.includes('json') || 
               attachment.type.includes('javascript') || 
               attachment.type.includes('css')) {
      // For text files, fetch and display content
      fetch(attachment.data)
        .then(response => response.text())
        .then(text => {
          setPreviewContent(
            <div className="text-preview">
              <pre>{text}</pre>
            </div>
          );
        })
        .catch(error => {
          console.error("Failed to load text content:", error);
          setPreviewContent(
            <div className="preview-error">
              <p>Failed to load text content.</p>
            </div>
          );
        });
    } else if (attachment.type.includes('pdf')) {
      setPreviewContent(
        <div className="pdf-preview">
          <iframe 
            src={attachment.data} 
            title={attachment.name}
            width="100%" 
            height="100%"
          />
        </div>
      );
    } else {
      // For unsupported file types
      setPreviewContent(
        <div className="unsupported-preview">
          <p>Preview not available for this file type.</p>
          <a 
            href={attachment.data} 
            download={attachment.name}
            className="download-link"
          >
            Download {attachment.name}
          </a>
        </div>
      );
    }
  }, [attachment]);
  
  if (!attachment) return null;
  
  return (
    <div className="file-preview-modal">
      <div className="modal-content">
        <div className="modal-header">
          <h3>{attachment.name}</h3>
          <button onClick={onClose} className="close-button">×</button>
        </div>
        <div className="modal-body">
          {previewContent}
        </div>
      </div>
    </div>
  );
};

export default FilePreviewModal;
