import React, { useState, useEffect } from 'react';
import './SearchComponent.css';

const SearchComponent = ({ onSelectResult }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchFilters, setSearchFilters] = useState({
    simple: true,
    markdown: true,
    workspace: true,
    drawing: true,
    voice_memo: true,
    tasks: true,
    attachments: true
  });
  
  // Debounce search to avoid excessive API calls
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    
    const timer = setTimeout(() => {
      performSearch();
    }, 300);
    
    return () => clearTimeout(timer);
  }, [searchQuery, searchFilters]);
  
  // Perform search across all content types
  const performSearch = async () => {
    if (!searchQuery.trim()) return;
    
    setIsSearching(true);
    
    try {
      // Create filter string from selected filters
      const filterTypes = Object.entries(searchFilters)
        .filter(([_, isEnabled]) => isEnabled)
        .map(([type]) => type);
      
      // Call backend search API
      const results = await window.electronAPI.searchContent(searchQuery, filterTypes);
      setSearchResults(results || []);
    } catch (error) {
      console.error("Search failed:", error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };
  
  // Handle filter toggle
  const handleFilterToggle = (filterType) => {
    setSearchFilters(prev => ({
      ...prev,
      [filterType]: !prev[filterType]
    }));
  };
  
  // Get icon for result type
  const getResultIcon = (type) => {
    switch (type) {
      case 'simple':
        return '📝';
      case 'markdown':
        return '📘';
      case 'workspace_page':
        return '📊';
      case 'drawing':
        return '🖌️';
      case 'voice_memo':
        return '🎤';
      case 'task':
        return '✓';
      case 'attachment':
        return '📎';
      default:
        return '📄';
    }
  };
  
  // Format result preview
  const formatPreview = (content, type) => {
    if (!content) return 'No content';
    
    // For different content types
    if (type === 'simple') {
      // Strip HTML tags for rich text
      return content.replace(/<[^>]*>/g, '').substring(0, 100) + '...';
    } else if (type === 'markdown') {
      return content.substring(0, 100) + '...';
    } else if (type === 'task') {
      return content;
    } else if (type === 'attachment') {
      return `Attachment: ${content}`;
    } else if (type === 'voice_memo') {
      try {
        const parsed = JSON.parse(content);
        return parsed.description || 'Voice memo';
      } catch {
        return 'Voice memo';
      }
    }
    
    return content.substring(0, 100) + '...';
  };
  
  // Handle result selection
  const handleResultClick = (result) => {
    if (onSelectResult) {
      onSelectResult(result);
    }
  };
  
  return (
    <div className="search-component">
      <div className="search-input-container">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search across all content..."
          className="search-input"
        />
        {isSearching && <div className="search-spinner"></div>}
      </div>
      
      <div className="search-filters">
        <div 
          className={`filter-pill ${searchFilters.simple ? 'active' : ''}`}
          onClick={() => handleFilterToggle('simple')}
        >
          Notes
        </div>
        <div 
          className={`filter-pill ${searchFilters.markdown ? 'active' : ''}`}
          onClick={() => handleFilterToggle('markdown')}
        >
          Markdown
        </div>
        <div 
          className={`filter-pill ${searchFilters.workspace ? 'active' : ''}`}
          onClick={() => handleFilterToggle('workspace')}
        >
          Workspace
        </div>
        <div 
          className={`filter-pill ${searchFilters.drawing ? 'active' : ''}`}
          onClick={() => handleFilterToggle('drawing')}
        >
          Drawings
        </div>
        <div 
          className={`filter-pill ${searchFilters.voice_memo ? 'active' : ''}`}
          onClick={() => handleFilterToggle('voice_memo')}
        >
          Voice Memos
        </div>
        <div 
          className={`filter-pill ${searchFilters.tasks ? 'active' : ''}`}
          onClick={() => handleFilterToggle('tasks')}
        >
          Tasks
        </div>
        <div 
          className={`filter-pill ${searchFilters.attachments ? 'active' : ''}`}
          onClick={() => handleFilterToggle('attachments')}
        >
          Attachments
        </div>
      </div>
      
      {searchQuery.trim() && (
        <div className="search-results">
          {searchResults.length > 0 ? (
            <ul className="results-list">
              {searchResults.map((result, index) => (
                <li 
                  key={index} 
                  className="result-item"
                  onClick={() => handleResultClick(result)}
                >
                  <div className="result-icon">{getResultIcon(result.type)}</div>
                  <div className="result-content">
                    <div className="result-title">{result.title || 'Untitled'}</div>
                    <div className="result-preview">{formatPreview(result.content, result.type)}</div>
                    <div className="result-meta">
                      <span className="result-type">{result.type}</span>
                      {result.updated_at && (
                        <span className="result-date">
                          {new Date(result.updated_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="no-results">
              {isSearching ? 'Searching...' : 'No results found'}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SearchComponent;
