import React, { useState, useEffect, useCallback } from 'react';
import RichTextEditor from './components/RichTextEditor';
import MarkdownEditor from './components/MarkdownEditor';
import BlockWorkspaceEditor from './components/BlockWorkspaceEditor';
import DrawingEditor from './components/DrawingEditor';
import VoiceMemoEditor from './components/VoiceMemoEditor';
import KnowledgeGraph from './components/KnowledgeGraph';
import './App.css';

// --- Placeholder Components (Refined) ---

const Sidebar = ({ folders, workspaces, tags, onSelectFolder, onSelectWorkspace, onSelectTag }) => (
  <div className="sidebar">
    <h2>Navigation</h2>

    {/* Simple Notes Section */}
    <div className="nav-section">
        <h3>Simple Notes</h3>
        {/* TODO: Implement folder tree view */}
        {folders.map(folder => (
            <div key={folder.id} onClick={() => onSelectFolder(folder.id)} className="nav-item">
                {folder.name}
            </div>
        ))}
        {/* Add folder creation button */} 
    </div>

    {/* Markdown KB Section */}
    <div className="nav-section">
        <h3>Markdown KB</h3>
        {/* TODO: Implement Vaults? For now, maybe list all markdown notes or use tags */}
        <div className="nav-item">All Markdown Notes</div> 
        <div className="nav-item">Graph View (Not Implemented)</div>
        <h4>Tags</h4>
        {tags.map(tag => (
             <div key={tag.id} onClick={() => onSelectTag(tag.id)} className="nav-item">
                #{tag.name}
            </div>           
        ))}
    </div>

    {/* Block Workspace Section */}
    <div className="nav-section">
        <h3>Block Workspace</h3>
        {workspaces.map(ws => (
            <div key={ws.id} onClick={() => onSelectWorkspace(ws.id)} className="nav-item">
                {ws.name}
            </div>
        ))}
        {/* Add workspace creation button */} 
    </div>

    {/* TODO: Add Shared / Settings sections */}
    <div className="nav-section">Shared (Not Implemented)</div>
    <div className="nav-section">Settings (Not Implemented)</div>
  </div>
);

const MiddlePane = ({ notes, onSelectNote }) => (
  <div className="middle-pane">
    <h3>Content List / Navigator</h3>
    {/* TODO: Add filtering/sorting controls */} 
    <ul>
      {notes.map(note => (
        <li key={note.id} onClick={() => onSelectNote(note.id)}>
          {note.title || `Note ${note.id}`}
          <span className="note-meta">{new Date(note.updated_at).toLocaleDateString()}</span>
        </li>
      ))}
    </ul>
  </div>
);

const SimpleNoteEditor = ({ note, onUpdate }) => {
  const [title, setTitle] = useState(note?.title || '');
  
  // Handle rich text content changes
  const handleContentChange = (content) => {
    if (onUpdate) {
      onUpdate(note.id, { content });
    }
  };
  
  // Handle title changes
  const handleTitleChange = (e) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    if (onUpdate) {
      onUpdate(note.id, { title: newTitle });
    }
  };
  
  return (
    <div className="simple-note-editor">
      <input 
        type="text"
        className="note-title-input"
        value={title}
        onChange={handleTitleChange}
        placeholder="Note Title"
      />
      <div className="editor-container">
        <RichTextEditor 
          initialContent={note?.content || ''} 
          onContentChange={handleContentChange}
          placeholder="Start writing..."
        />
      </div>
    </div>
  );
};

const MarkdownNoteEditor = ({ note, onUpdate, backlinks = [] }) => {
  const [title, setTitle] = useState(note?.title || '');
  
  // Handle markdown content changes
  const handleContentChange = (content) => {
    if (onUpdate) {
      onUpdate(note.id, { content });
    }
  };
  
  // Handle title changes
  const handleTitleChange = (e) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    if (onUpdate) {
      onUpdate(note.id, { title: newTitle });
    }
  };
  
  return (
    <div className="markdown-note-editor">
      <input 
        type="text"
        className="note-title-input"
        value={title}
        onChange={handleTitleChange}
        placeholder="Note Title"
      />
      <div className="editor-container">
        <MarkdownEditor 
          initialContent={note?.content || ''} 
          onContentChange={handleContentChange}
          placeholder="Start writing in markdown..."
        />
      </div>
      
      {/* Backlinks Section */}
      <div className="backlinks-section">
        <h3>Backlinks</h3>
        {backlinks.length > 0 ? (
          <ul className="backlinks-list">
            {backlinks.map(link => (
              <li key={link.id}>
                <a href="#" onClick={(e) => { e.preventDefault(); /* Handle navigation */ }}>
                  {link.title || `Note ${link.id}`}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p>No backlinks found.</p>
        )}
      </div>
    </div>
  );
};

const RightPane = ({ selectedNote, onUpdateNote, backlinks = [] }) => {
  if (!selectedNote) {
    return (
      <div className="right-pane">
        <h1>Select an item</h1>
        <p>Choose a note from the list to view or edit it.</p>
      </div>
    );
  }

  return (
    <div className="right-pane">
      {selectedNote.type === 'simple' && (
        <SimpleNoteEditor note={selectedNote} onUpdate={onUpdateNote} />
      )}
      
      {selectedNote.type === 'markdown' && (
        <MarkdownNoteEditor 
          note={selectedNote} 
          onUpdate={onUpdateNote} 
          backlinks={backlinks}
        />
      )}
      
      {selectedNote.type === 'workspace_page' && (
        <BlockWorkspaceEditor 
          note={selectedNote} 
          onUpdate={onUpdateNote}
        />
      )}
      
      {selectedNote.type === 'drawing' && (
        <DrawingEditor 
          note={selectedNote} 
          onUpdate={onUpdateNote}
        />
      )}
      
      {selectedNote.type === 'voice_memo' && (
        <VoiceMemoEditor 
          note={selectedNote} 
          onUpdate={onUpdateNote}
        />
      )}
      
      {/* Display Tags */} 
      {selectedNote.tags && selectedNote.tags.length > 0 && (
        <div className="note-details-section">
          <h4>Tags:</h4>
          {selectedNote.tags.map(tag => <span key={tag.id} className="tag">#{tag.name}</span>)}
        </div>
      )}
    </div>
  );
};

const TopBar = ({ toggleTheme, onShowGraphView }) => (
    <div className="top-bar">
        <div className="top-bar-left">Unified Notes</div>
        <div className="top-bar-center">
            <input type="search" placeholder="Search... (Not Implemented)" />
        </div>
        <div className="top-bar-right">
            <button onClick={onShowGraphView}>Graph View</button>
            <span>User | Sync (NI)</span>
            <button onClick={toggleTheme}>Toggle Theme</button>
        </div>
    </div>
);

const BottomBar = ({ onCreateNote, currentContext }) => (
    <div className="bottom-bar">
        {/* Context-aware buttons based on selected module/pane */} 
        <button onClick={() => onCreateNote({ type: 'simple', title: 'New Simple Note' })}>New Simple Note</button>
        <button onClick={() => onCreateNote({ type: 'markdown', title: 'New Markdown Note' })}>New Markdown Note</button>
        <button onClick={() => onCreateNote({ type: 'drawing', title: 'New Drawing' })}>New Drawing</button>
        <button onClick={() => onCreateNote({ type: 'voice_memo', title: 'New Voice Memo' })}>New Voice Memo</button>
        {currentContext.type === 'workspace' && (
          <button onClick={() => onCreateNote({ 
            type: 'workspace_page', 
            title: 'New Page',
            workspace_id: currentContext.id
          })}>New Workspace Page</button>
        )}
        <button>New Folder (NI)</button>
        <button>New Workspace (NI)</button>
    </div>
);

// --- Main App Component ---

function App() {
  const [theme, setTheme] = useState('dark'); // Default to dark theme
  const [folders, setFolders] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [tags, setTags] = useState([]);
  const [notes, setNotes] = useState([]); // Notes in the middle pane
  const [selectedNote, setSelectedNote] = useState(null); // Full note data for right pane
  const [backlinks, setBacklinks] = useState([]); // Backlinks for the selected note
  const [currentContext, setCurrentContext] = useState({ type: 'folder', id: null }); // To track what notes list to show
  const [showGraphView, setShowGraphView] = useState(false); // Toggle for graph view

  // --- Data Fetching Effects ---
  useEffect(() => {
    // Fetch initial sidebar data
    const fetchData = async () => {
      try {
        const [fetchedFolders, fetchedWorkspaces, fetchedTags] = await Promise.all([
          window.electronAPI.getFolders(),
          window.electronAPI.getWorkspaces(),
          window.electronAPI.getAllTags()
        ]);
        setFolders(fetchedFolders || []);
        setWorkspaces(fetchedWorkspaces || []);
        setTags(fetchedTags || []);
        // Optionally select the first folder by default
        if (fetchedFolders && fetchedFolders.length > 0) {
            handleSelectFolder(fetchedFolders[0].id);
        }
      } catch (error) {
        console.error("Failed to fetch initial sidebar data:", error);
      }
    };
    fetchData();
  }, []);

  // Fetch notes when context changes (selected folder, tag, workspace etc.)
  useEffect(() => {
    const fetchNotes = async () => {
        let fetchedNotes = [];
        try {
            if (currentContext.type === 'folder' && currentContext.id !== null) {
                fetchedNotes = await window.electronAPI.getNotesByFolder(currentContext.id);
            } else if (currentContext.type === 'tag' && currentContext.id !== null) {
                fetchedNotes = await window.electronAPI.getNotesForTag(currentContext.id);
            } else if (currentContext.type === 'workspace' && currentContext.id !== null) {
                // Fetch workspace pages (notes of type 'workspace_page')
                // This is a placeholder - you might need to implement this backend function
                fetchedNotes = await window.electronAPI.getNotesByWorkspace(currentContext.id);
            }
            setNotes(fetchedNotes || []);
            setSelectedNote(null); // Clear right pane when list changes
        } catch (error) {
            console.error(`Failed to fetch notes for ${currentContext.type} ${currentContext.id}:`, error);
            setNotes([]);
        }
    };

    if (currentContext.id !== null || currentContext.type === 'all') { // Add condition for fetching 'all'
        fetchNotes();
    }
  }, [currentContext]);

  // --- Event Handlers ---
  const toggleTheme = () => {
    setTheme(currentTheme => (currentTheme === 'light' ? 'dark' : 'light'));
  };

  const handleSelectFolder = useCallback((folderId) => {
    setCurrentContext({ type: 'folder', id: folderId });
  }, []);

  const handleSelectWorkspace = useCallback((workspaceId) => {
    setCurrentContext({ type: 'workspace', id: workspaceId });
  }, []);

  const handleSelectTag = useCallback((tagId) => {
      setCurrentContext({ type: 'tag', id: tagId });
  }, []);

  const handleSelectNote = useCallback(async (noteId) => {
    try {
      // Fetch full note details including tags, etc.
      const noteDetails = await window.electronAPI.getNoteById(noteId);
      if (noteDetails) {
          // Fetch related data
          const [noteTags, noteBacklinks] = await Promise.all([
              window.electronAPI.getTagsForNote(noteId),
              noteDetails.type === 'markdown' ? window.electronAPI.getBacklinks(noteId) : []
          ]);
          
          setSelectedNote({ ...noteDetails, tags: noteTags || [] });
          setBacklinks(noteBacklinks || []);
      } else {
          setSelectedNote(null);
          setBacklinks([]);
      }
    } catch (error) {
      console.error(`Failed to fetch details for note ${noteId}:`, error);
      setSelectedNote(null);
      setBacklinks([]);
    }
  }, []);

  const handleCreateNote = useCallback(async (noteData) => {
      try {
          // Add context-specific data
          const contextData = {};
          if (currentContext.type === 'folder') {
            contextData.folder_id = currentContext.id;
          } else if (currentContext.type === 'workspace') {
            contextData.workspace_id = currentContext.id;
          }
          
          const newNoteId = await window.electronAPI.createNote({
            ...noteData,
            ...contextData
          });
          
          if (newNoteId) {
              console.log("New note created with ID:", newNoteId);
              // Refresh the notes list based on current context
              setCurrentContext(prev => ({ ...prev })); 
          } else {
              console.error("Failed to create note (backend returned null ID).");
          }
      } catch (error) {
          console.error("Error calling createNote:", error);
      }
  }, [currentContext]);

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

  const handleToggleGraphView = () => {
    setShowGraphView(!showGraphView);
  };

  const handleGraphNodeClick = (noteId) => {
    handleSelectNote(noteId);
  };

  // --- Render ---
  return (
    <div className={`app-container theme-${theme}`}>
        <TopBar 
          toggleTheme={toggleTheme} 
          onShowGraphView={handleToggleGraphView}
        />
        <div className="main-content">
            <Sidebar 
                folders={folders} 
                workspaces={workspaces} 
                tags={tags}
                onSelectFolder={handleSelectFolder}
                onSelectWorkspace={handleSelectWorkspace}
                onSelectTag={handleSelectTag}
            />
            <MiddlePane 
                notes={notes} 
                onSelectNote={handleSelectNote} 
            />
            <RightPane 
                selectedNote={selectedNote} 
                onUpdateNote={handleUpdateNote}
                backlinks={backlinks}
            />
        </div>
        <BottomBar 
            onCreateNote={handleCreateNote} 
            currentContext={currentContext}
        />
        
        {showGraphView && (
          <KnowledgeGraph 
            onClose={handleToggleGraphView}
            onNodeClick={handleGraphNodeClick}
            theme={theme}
          />
        )}
    </div>
  );
}

export default App;
