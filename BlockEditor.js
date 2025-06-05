import React, { useState, useEffect } from 'react';
import './BlockEditor.css';

// Block Type Components
const TextBlock = ({ content, onChange, readOnly }) => {
  return (
    <div className="block-content text-block">
      <textarea 
        value={content || ''} 
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type text here..."
        readOnly={readOnly}
      />
    </div>
  );
};

const HeadingBlock = ({ content, level = 1, onChange, readOnly }) => {
  const [headingLevel, setHeadingLevel] = useState(level);
  
  const handleLevelChange = (e) => {
    const newLevel = parseInt(e.target.value);
    setHeadingLevel(newLevel);
    // Notify parent about level change
    if (onChange) {
      onChange(content, { level: newLevel });
    }
  };
  
  return (
    <div className="block-content heading-block">
      {!readOnly && (
        <select 
          value={headingLevel} 
          onChange={handleLevelChange}
          className="heading-level-select"
        >
          <option value={1}>Heading 1</option>
          <option value={2}>Heading 2</option>
          <option value={3}>Heading 3</option>
        </select>
      )}
      <input 
        type="text" 
        value={content || ''} 
        onChange={(e) => onChange(e.target.value)}
        placeholder="Heading text..."
        className={`heading-input h${headingLevel}`}
        readOnly={readOnly}
      />
    </div>
  );
};

const ListBlock = ({ content, listType = 'bullet', onChange, readOnly }) => {
  const [items, setItems] = useState(content ? content.split('\n') : ['']);
  const [type, setType] = useState(listType);
  
  useEffect(() => {
    if (content) {
      setItems(content.split('\n'));
    }
  }, [content]);
  
  const handleItemChange = (index, value) => {
    const newItems = [...items];
    newItems[index] = value;
    setItems(newItems);
    if (onChange) {
      onChange(newItems.join('\n'), { listType: type });
    }
  };
  
  const handleAddItem = (index) => {
    const newItems = [...items];
    newItems.splice(index + 1, 0, '');
    setItems(newItems);
    if (onChange) {
      onChange(newItems.join('\n'), { listType: type });
    }
  };
  
  const handleRemoveItem = (index) => {
    if (items.length > 1) {
      const newItems = [...items];
      newItems.splice(index, 1);
      setItems(newItems);
      if (onChange) {
        onChange(newItems.join('\n'), { listType: type });
      }
    }
  };
  
  const handleTypeChange = (e) => {
    const newType = e.target.value;
    setType(newType);
    if (onChange) {
      onChange(items.join('\n'), { listType: newType });
    }
  };
  
  return (
    <div className="block-content list-block">
      {!readOnly && (
        <select 
          value={type} 
          onChange={handleTypeChange}
          className="list-type-select"
        >
          <option value="bullet">Bullet List</option>
          <option value="numbered">Numbered List</option>
          <option value="todo">To-Do List</option>
        </select>
      )}
      <ul className={`list-items ${type}-list`}>
        {items.map((item, index) => (
          <li key={index} className="list-item">
            {type === 'todo' && !readOnly ? (
              <input type="checkbox" className="todo-checkbox" />
            ) : (
              <span className="list-marker">
                {type === 'numbered' ? `${index + 1}.` : '•'}
              </span>
            )}
            <input 
              type="text" 
              value={item} 
              onChange={(e) => handleItemChange(index, e.target.value)}
              placeholder="List item..."
              readOnly={readOnly}
            />
            {!readOnly && (
              <div className="list-item-actions">
                <button onClick={() => handleAddItem(index)}>+</button>
                {items.length > 1 && (
                  <button onClick={() => handleRemoveItem(index)}>-</button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

const CodeBlock = ({ content, language = 'javascript', onChange, readOnly }) => {
  const [lang, setLang] = useState(language);
  
  const handleLangChange = (e) => {
    const newLang = e.target.value;
    setLang(newLang);
    if (onChange) {
      onChange(content, { language: newLang });
    }
  };
  
  return (
    <div className="block-content code-block">
      {!readOnly && (
        <select 
          value={lang} 
          onChange={handleLangChange}
          className="code-language-select"
        >
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          <option value="html">HTML</option>
          <option value="css">CSS</option>
          <option value="sql">SQL</option>
          <option value="plain">Plain Text</option>
        </select>
      )}
      <textarea 
        value={content || ''} 
        onChange={(e) => onChange(e.target.value)}
        placeholder="Code goes here..."
        className={`code-input language-${lang}`}
        readOnly={readOnly}
      />
    </div>
  );
};

const ImageBlock = ({ content, caption, onChange, readOnly }) => {
  // In a real implementation, content would be the image URL or data
  const [imageUrl, setImageUrl] = useState(content || '');
  const [imageCaption, setImageCaption] = useState(caption || '');
  
  const handleUrlChange = (e) => {
    const newUrl = e.target.value;
    setImageUrl(newUrl);
    if (onChange) {
      onChange(newUrl, { caption: imageCaption });
    }
  };
  
  const handleCaptionChange = (e) => {
    const newCaption = e.target.value;
    setImageCaption(newCaption);
    if (onChange) {
      onChange(imageUrl, { caption: newCaption });
    }
  };
  
  return (
    <div className="block-content image-block">
      {!readOnly && (
        <input 
          type="text" 
          value={imageUrl} 
          onChange={handleUrlChange}
          placeholder="Image URL..."
          className="image-url-input"
        />
      )}
      {imageUrl && (
        <div className="image-preview">
          <img src={imageUrl} alt={imageCaption || 'Image'} />
        </div>
      )}
      <input 
        type="text" 
        value={imageCaption} 
        onChange={handleCaptionChange}
        placeholder="Image caption..."
        className="image-caption-input"
        readOnly={readOnly}
      />
    </div>
  );
};

// Main Block Component
const Block = ({ 
  id, 
  type, 
  content, 
  metadata = {}, 
  onUpdate, 
  onDelete, 
  onMoveUp, 
  onMoveDown,
  readOnly = false
}) => {
  const handleContentChange = (newContent, additionalMetadata = {}) => {
    if (onUpdate) {
      onUpdate(id, {
        content: newContent,
        metadata: { ...metadata, ...additionalMetadata }
      });
    }
  };
  
  const renderBlockContent = () => {
    switch (type) {
      case 'heading':
        return (
          <HeadingBlock 
            content={content} 
            level={metadata.level || 1} 
            onChange={handleContentChange}
            readOnly={readOnly}
          />
        );
      case 'list':
        return (
          <ListBlock 
            content={content} 
            listType={metadata.listType || 'bullet'} 
            onChange={handleContentChange}
            readOnly={readOnly}
          />
        );
      case 'code':
        return (
          <CodeBlock 
            content={content} 
            language={metadata.language || 'javascript'} 
            onChange={handleContentChange}
            readOnly={readOnly}
          />
        );
      case 'image':
        return (
          <ImageBlock 
            content={content} 
            caption={metadata.caption} 
            onChange={handleContentChange}
            readOnly={readOnly}
          />
        );
      case 'text':
      default:
        return (
          <TextBlock 
            content={content} 
            onChange={handleContentChange}
            readOnly={readOnly}
          />
        );
    }
  };
  
  return (
    <div className={`block ${type}-block`}>
      {!readOnly && (
        <div className="block-actions">
          <button onClick={() => onMoveUp(id)} className="move-up-btn">↑</button>
          <button onClick={() => onMoveDown(id)} className="move-down-btn">↓</button>
          <button onClick={() => onDelete(id)} className="delete-btn">×</button>
        </div>
      )}
      {renderBlockContent()}
    </div>
  );
};

// Block Editor Component
const BlockEditor = ({ 
  blocks = [], 
  onBlocksChange,
  readOnly = false
}) => {
  const [blocksList, setBlocksList] = useState(blocks);
  
  // Update blocks when props change
  useEffect(() => {
    setBlocksList(blocks);
  }, [blocks]);
  
  const handleBlockUpdate = (blockId, updates) => {
    const updatedBlocks = blocksList.map(block => 
      block.id === blockId ? { ...block, ...updates } : block
    );
    setBlocksList(updatedBlocks);
    if (onBlocksChange) {
      onBlocksChange(updatedBlocks);
    }
  };
  
  const handleBlockDelete = (blockId) => {
    const updatedBlocks = blocksList.filter(block => block.id !== blockId);
    setBlocksList(updatedBlocks);
    if (onBlocksChange) {
      onBlocksChange(updatedBlocks);
    }
  };
  
  const handleBlockMoveUp = (blockId) => {
    const index = blocksList.findIndex(block => block.id === blockId);
    if (index > 0) {
      const updatedBlocks = [...blocksList];
      [updatedBlocks[index - 1], updatedBlocks[index]] = [updatedBlocks[index], updatedBlocks[index - 1]];
      setBlocksList(updatedBlocks);
      if (onBlocksChange) {
        onBlocksChange(updatedBlocks);
      }
    }
  };
  
  const handleBlockMoveDown = (blockId) => {
    const index = blocksList.findIndex(block => block.id === blockId);
    if (index < blocksList.length - 1) {
      const updatedBlocks = [...blocksList];
      [updatedBlocks[index], updatedBlocks[index + 1]] = [updatedBlocks[index + 1], updatedBlocks[index]];
      setBlocksList(updatedBlocks);
      if (onBlocksChange) {
        onBlocksChange(updatedBlocks);
      }
    }
  };
  
  const handleAddBlock = (type) => {
    const newBlock = {
      id: `block-${Date.now()}`,
      type,
      content: '',
      metadata: {}
    };
    
    const updatedBlocks = [...blocksList, newBlock];
    setBlocksList(updatedBlocks);
    if (onBlocksChange) {
      onBlocksChange(updatedBlocks);
    }
  };
  
  return (
    <div className="block-editor">
      <div className="blocks-container">
        {blocksList.map(block => (
          <Block 
            key={block.id}
            id={block.id}
            type={block.type}
            content={block.content}
            metadata={block.metadata || {}}
            onUpdate={handleBlockUpdate}
            onDelete={handleBlockDelete}
            onMoveUp={handleBlockMoveUp}
            onMoveDown={handleBlockMoveDown}
            readOnly={readOnly}
          />
        ))}
      </div>
      
      {!readOnly && (
        <div className="add-block-controls">
          <button onClick={() => handleAddBlock('text')}>Add Text</button>
          <button onClick={() => handleAddBlock('heading')}>Add Heading</button>
          <button onClick={() => handleAddBlock('list')}>Add List</button>
          <button onClick={() => handleAddBlock('code')}>Add Code</button>
          <button onClick={() => handleAddBlock('image')}>Add Image</button>
        </div>
      )}
    </div>
  );
};

export default BlockEditor;
