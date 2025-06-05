import React, { useState, useEffect } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css'; // Import Quill styles
import './RichTextEditor.css'; // We'll create this for custom styling

const RichTextEditor = ({ 
  initialContent = '', 
  onContentChange, 
  placeholder = 'Start writing...',
  readOnly = false
}) => {
  const [content, setContent] = useState(initialContent);

  // Update content when initialContent prop changes
  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  // Handle content changes
  const handleChange = (value) => {
    setContent(value);
    if (onContentChange) {
      onContentChange(value);
    }
  };

  // Quill modules configuration (toolbar options)
  const modules = {
    toolbar: [
      [{ 'header': [1, 2, 3, 4, 5, 6, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'color': [] }, { 'background': [] }],
      [{ 'list': 'ordered' }, { 'list': 'bullet' }],
      [{ 'indent': '-1' }, { 'indent': '+1' }],
      [{ 'align': [] }],
      ['link', 'image'],
      ['clean']
    ],
  };

  // Quill formats
  const formats = [
    'header',
    'bold', 'italic', 'underline', 'strike',
    'color', 'background',
    'list', 'bullet',
    'indent',
    'align',
    'link', 'image'
  ];

  return (
    <div className="rich-text-editor">
      <ReactQuill
        theme="snow"
        value={content}
        onChange={handleChange}
        modules={modules}
        formats={formats}
        placeholder={placeholder}
        readOnly={readOnly}
      />
    </div>
  );
};

export default RichTextEditor;
