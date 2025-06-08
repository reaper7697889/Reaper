import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import 'katex/dist/katex.min.css'; // KaTeX CSS
import remarkMath from 'remark-math';   // KaTeX plugins
import rehypeKatex from 'rehype-katex'; // KaTeX plugins
import rehypePrismPlus from 'rehype-prism-plus'; // Prism for syntax highlighting
import ReactPlayer from 'react-player/lazy'; // For video embeds
import remarkSimpleVideoEmbed from './remark-plugins/remarkSimpleVideoEmbed'; // Custom plugin
import './MarkdownEditor.css';

const MarkdownEditor = ({
  initialContent = '',
  onContentChange,
  placeholder = 'Start writing in markdown...',
  readOnly = false
}) => {
  const [content, setContent] = useState(initialContent);
  const [showPreview, setShowPreview] = useState(true); // Default to showing split view

  // Update content when initialContent prop changes
  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  // Handle content changes
  const handleChange = (e) => {
    const newContent = e.target.value;
    setContent(newContent);
    if (onContentChange) {
      onContentChange(newContent);
    }
  };

  // Toggle between edit-only, preview-only, and split view
  const toggleView = () => {
    setShowPreview(prev => !prev);
  };

  const customRenderers = {
    video: ({ node }) => {
      if (node && node.url) {
        // Check if URL is valid for ReactPlayer (it's quite broad)
        if (ReactPlayer.canPlay(node.url)) {
          return (
            <div className="embedded-video-wrapper" style={{ position: 'relative', paddingTop: '56.25%' /* 16:9 Aspect Ratio */ }}>
              <ReactPlayer
                url={node.url}
                controls={true}
                width="100%"
                height="100%"
                style={{ position: 'absolute', top: 0, left: 0 }}
              />
            </div>
          );
        } else {
          return <p style={{color: 'red'}}>Invalid or unsupported video URL: {node.url}</p>;
        }
      }
      return <p style={{color: 'red'}}>Error embedding video: Invalid node structure.</p>;
    }
  };

  return (
    <div className="markdown-editor">
      <div className="markdown-toolbar">
        <button onClick={toggleView}>
          {showPreview ? 'Hide Preview' : 'Show Preview'}
        </button>
        <div className="markdown-toolbar-buttons">
          <button onClick={() => handleChange({ target: { value: content + '# ' } })}>H1</button>
          <button onClick={() => handleChange({ target: { value: content + '## ' } })}>H2</button>
          <button onClick={() => handleChange({ target: { value: content + '### ' } })}>H3</button>
          <button onClick={() => handleChange({ target: { value: content + '**Bold**' } })}>B</button>
          <button onClick={() => handleChange({ target: { value: content + '*Italic*' } })}>I</button>
          <button onClick={() => handleChange({ target: { value: content + '~~Strikethrough~~' } })}>S</button>
          <button onClick={() => handleChange({ target: { value: content + '- ' } })}>• List</button>
          <button onClick={() => handleChange({ target: { value: content + '1. ' } })}>1. List</button>
          <button onClick={() => handleChange({ target: { value: content + '> ' } })}>Quote</button>
          <button onClick={() => handleChange({ target: { value: content + '`Code`' } })}>Code</button>
          <button onClick={() => handleChange({ target: { value: content + '[[Link]]' } })}>Link</button>
          <button onClick={() => handleChange({ target: { value: content + '![Image](url)' } })}>Image</button>
        </div>
      </div>
      
      <div className={`markdown-content ${showPreview ? 'split-view' : 'edit-only'}`}>
        <div className="markdown-input-container">
          <textarea
            className="markdown-input"
            value={content}
            onChange={handleChange}
            placeholder={placeholder}
            readOnly={readOnly}
          />
        </div>
        
        {showPreview && (
          <div className="markdown-preview">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath, remarkSimpleVideoEmbed]}
              rehypePlugins={[rehypeRaw, rehypeSanitize, [rehypePrismPlus, { showLineNumbers: true }], rehypeKatex]}
              components={customRenderers}
            >
              {content || '*Preview will appear here*'}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
};

export default MarkdownEditor;
