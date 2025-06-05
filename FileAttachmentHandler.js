import React, { useState, useRef } from 'react';
import './FileAttachmentHandler.css';

const FileAttachmentHandler = ({ 
  onAttach, 
  attachments = [],
  onRemoveAttachment,
  onPreviewAttachment
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
  
  // Handle file selection via input
  const handleFileSelect = async (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await processFiles(files);
    }
  };
  
  // Handle drag events
  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };
  
  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };
  
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) {
      setIsDragging(true);
    }
  };
  
  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      await processFiles(files);
    }
  };
  
  // Process files for attachment
  const processFiles = async (files) => {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      // Read file as data URL
      const reader = new FileReader();
      reader.onload = async (event) => {
        const fileData = {
          name: file.name,
          type: file.type,
          size: file.size,
          data: event.target.result
        };
        
        if (onAttach) {
          onAttach(fileData);
        }
      };
      reader.readAsDataURL(file);
    }
  };
  
  // Trigger file input click
  const handleAttachClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };
  
  // Get file icon based on MIME type
  const getFileIcon = (fileType) => {
    if (fileType.startsWith('image/')) {
      return '🖼️';
    } else if (fileType.startsWith('audio/')) {
      return '🔊';
    } else if (fileType.startsWith('video/')) {
      return '🎬';
    } else if (fileType.startsWith('text/')) {
      return '📄';
    } else if (fileType.includes('pdf')) {
      return '📑';
    } else if (fileType.includes('word') || fileType.includes('document')) {
      return '📝';
    } else if (fileType.includes('excel') || fileType.includes('spreadsheet')) {
      return '📊';
    } else if (fileType.includes('powerpoint') || fileType.includes('presentation')) {
      return '📽️';
    } else {
      return '📎';
    }
  };
  
  // Format file size
  const formatFileSize = (bytes) => {
    if (bytes < 1024) {
      return bytes + ' B';
    } else if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(1) + ' KB';
    } else if (bytes < 1024 * 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    } else {
      return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }
  };
  
  return (
    <div className="file-attachment-handler">
      <div 
        className={`attachment-dropzone ${isDragging ? 'dragging' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <p>Drag files here or <button onClick={handleAttachClick}>browse</button></p>
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleFileSelect} 
          style={{ display: 'none' }}
          multiple
        />
      </div>
      
      {attachments.length > 0 && (
        <div className="attachments-list">
          <h4>Attachments</h4>
          <ul>
            {attachments.map((attachment, index) => (
              <li key={index} className="attachment-item">
                <div className="attachment-icon">
                  {getFileIcon(attachment.type)}
                </div>
                <div className="attachment-details">
                  <div className="attachment-name" onClick={() => onPreviewAttachment(attachment)}>
                    {attachment.name}
                  </div>
                  <div className="attachment-meta">
                    {formatFileSize(attachment.size)}
                  </div>
                </div>
                <button 
                  className="attachment-remove"
                  onClick={() => onRemoveAttachment(index)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default FileAttachmentHandler;
