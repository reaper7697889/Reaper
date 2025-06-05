const Database = require("better-sqlite3");
const path = require("path");

// Define the path for the database file within the project structure
// In a real Electron app, you might use app.getPath("userData")
const dbPath = path.join(__dirname, "..", "..", "database.sqlite"); 
let db;

function initializeDatabase() {
  db = new Database(dbPath, { verbose: console.log }); // Enable logging for debugging

  console.log("Initializing database schema...");

  // Use PRAGMA foreign_keys=ON for enforcing foreign key constraints
  db.exec("PRAGMA foreign_keys = ON;");

  // --- Core Tables ---
  // Users (for potential future collaboration/sync)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Folders/Notebooks (for Simple Notes organization)
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER, -- For nested folders
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
    );
  `);

  // Workspaces (for Block-Based Module)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Notes Table (Central table for all note types)
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ("simple", "markdown", "workspace_page")), -- Note type discriminator
      title TEXT,
      content TEXT, -- Main content (rich text, markdown, or reference to blocks)
      folder_id INTEGER, -- For simple notes organization
      workspace_id INTEGER, -- For workspace pages
      is_pinned BOOLEAN DEFAULT 0,
      is_archived BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- user_id INTEGER, -- Add when user accounts are implemented
      -- FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
  `);
  // Trigger to update updated_at timestamp
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS update_note_timestamp
    AFTER UPDATE ON notes
    FOR EACH ROW
    BEGIN
      UPDATE notes SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
    END;
  `);

  // Tags
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE COLLATE NOCASE NOT NULL
    );
  `);

  // Note_Tags (Many-to-Many relationship)
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_tags (
      note_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (note_id, tag_id),
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
  `);

  // --- Markdown KB Specific Tables ---
  // Links (for Backlinks)
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_note_id INTEGER NOT NULL,
      target_note_id INTEGER NOT NULL, -- Can reference notes that might not exist yet
      link_text TEXT, -- Optional: the text used for the link
      target_header TEXT,     -- For linking to headers
      target_block_id TEXT,   -- For linking to specific blocks
      is_embed BOOLEAN DEFAULT 0 NOT NULL, -- True if this link is an embed
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (source_note_id, target_note_id, link_text, target_header, target_block_id, is_embed), -- Updated UNIQUE constraint
      FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE
      -- No FK on target_note_id to allow linking to non-existent notes initially
    );
  `);

  // --- In-Note Database Feature Tables ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_databases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER UNIQUE, -- Each note can have at most one database directly associated
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trigger_note_databases_updated_at
    AFTER UPDATE ON note_databases
    FOR EACH ROW
    BEGIN
        UPDATE note_databases SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
    END;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS database_columns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        database_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'RELATION', 'FORMULA', 'ROLLUP')), -- Added 'ROLLUP'
        column_order INTEGER NOT NULL,
        default_value TEXT,
        select_options TEXT,
        linked_database_id INTEGER,
        inverse_column_id INTEGER DEFAULT NULL,
        formula_definition TEXT DEFAULT NULL,
        formula_result_type TEXT DEFAULT NULL,
        rollup_source_relation_column_id INTEGER DEFAULT NULL, -- New
        rollup_target_column_id INTEGER DEFAULT NULL,       -- New
        rollup_function TEXT DEFAULT NULL CHECK(rollup_function IS NULL OR rollup_function IN ( -- New
            'COUNT_ALL', 'COUNT_VALUES', 'COUNT_UNIQUE_VALUES', 'SUM', 'AVG', 'MIN', 'MAX',
            'SHOW_UNIQUE', 'PERCENT_EMPTY', 'PERCENT_NOT_EMPTY', 'COUNT_CHECKED',
            'COUNT_UNCHECKED', 'PERCENT_CHECKED', 'PERCENT_UNCHECKED'
        )),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE,
        FOREIGN KEY (linked_database_id) REFERENCES note_databases(id) ON DELETE SET NULL,
        FOREIGN KEY (inverse_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
        FOREIGN KEY (rollup_source_relation_column_id) REFERENCES database_columns(id) ON DELETE SET NULL, -- New
        FOREIGN KEY (rollup_target_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,       -- New
        UNIQUE (database_id, name),
        UNIQUE (database_id, column_order)
    );
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trigger_database_columns_updated_at
    AFTER UPDATE ON database_columns
    FOR EACH ROW
    BEGIN
        UPDATE database_columns SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
    END;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS database_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        database_id INTEGER NOT NULL,
        row_order INTEGER, -- Nullable, can be used for manual sort order
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trigger_database_rows_updated_at
    AFTER UPDATE ON database_rows
    FOR EACH ROW
    BEGIN
        UPDATE database_rows SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
    END;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS database_row_values (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        row_id INTEGER NOT NULL,
        column_id INTEGER NOT NULL,
        value_text TEXT,    -- For TEXT, DATE, SELECT, MULTI_SELECT (JSON array)
        value_number REAL,  -- For NUMBER
        value_boolean INTEGER, -- For BOOLEAN (0 or 1)
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (row_id) REFERENCES database_rows(id) ON DELETE CASCADE,
        FOREIGN KEY (column_id) REFERENCES database_columns(id) ON DELETE CASCADE,
        UNIQUE (row_id, column_id)
    );
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trigger_database_row_values_updated_at
    AFTER UPDATE ON database_row_values
    FOR EACH ROW
    BEGIN
        UPDATE database_row_values SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
    END;
  `);

  // Table for links between rows in different (or same) databases (for RELATION type columns)
  db.exec(`
    CREATE TABLE IF NOT EXISTS database_row_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_row_id INTEGER NOT NULL,
        source_column_id INTEGER NOT NULL, -- The 'RELATION' type column in the source table
        target_row_id INTEGER NOT NULL,    -- The row in the linked_database_id table
        link_order INTEGER NOT NULL DEFAULT 0, -- For ordered multi-links if needed
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_row_id) REFERENCES database_rows(id) ON DELETE CASCADE,
        FOREIGN KEY (source_column_id) REFERENCES database_columns(id) ON DELETE CASCADE,
        FOREIGN KEY (target_row_id) REFERENCES database_rows(id) ON DELETE CASCADE,
        UNIQUE (source_row_id, source_column_id, target_row_id)
    );
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trigger_database_row_links_updated_at
    AFTER UPDATE ON database_row_links
    FOR EACH ROW
    BEGIN
        UPDATE database_row_links SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
    END;
  `);

  // --- Block-Based Workspace Specific Tables ---
  // Blocks (for Notion-style pages)
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY, -- Using UUIDs generated by app might be better
      note_id INTEGER NOT NULL, -- The workspace_page note this block belongs to
      type TEXT NOT NULL, -- e.g., "text", "heading1", "todo", "image", "table", "database_view"
      content TEXT, -- JSON representation of block data
      block_order INTEGER NOT NULL, -- Order within the page
      parent_id TEXT, -- For nested blocks
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES blocks(id) ON DELETE CASCADE
    );
  `);
  // Trigger to update updated_at timestamp
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS update_block_timestamp
    AFTER UPDATE ON blocks
    FOR EACH ROW
    BEGIN
      UPDATE blocks SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
    END;
  `);

  // --- Common Feature Tables ---
  // Attachments (Images, PDFs, Voice Memos, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER, -- Link to note if attached directly
      block_id TEXT, -- Link to block if embedded in workspace
      file_path TEXT NOT NULL, -- Path relative to a defined app data directory
      mime_type TEXT,
      original_filename TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
    );
  `);

  // Tasks (can be standalone in simple notes or part of blocks)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER, -- Link if part of a simple note
      block_id TEXT, -- Link if part of a block
      description TEXT NOT NULL,
      is_completed BOOLEAN DEFAULT 0,
      due_date DATETIME,
      reminder_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
    );
  `);
  // Trigger to update updated_at timestamp
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS update_task_timestamp
    AFTER UPDATE ON tasks
    FOR EACH ROW
    BEGIN
      UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
    END;
  `);

  // Version History (Simple approach: store snapshots)
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      content TEXT, -- Snapshot of note content at the time
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
  `);

  // --- Placeholder Tables for Future Features ---
  // Collaboration Shares & Permissions
  db.exec(`CREATE TABLE IF NOT EXISTS shares (id INTEGER PRIMARY KEY);`); // Placeholder
  db.exec(`CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY);`); // Placeholder
  db.exec(`CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY);`); // Placeholder
  db.exec(`CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY);`); // Placeholder

  console.log("Database schema initialized successfully.");

  // TODO: Add functions for CRUD operations
}

function getDb() {
  if (!db) {
    initializeDatabase();
  }
  return db;
}

// Close the database connection when the app quits (important!)
// In Electron, you might call this in response to app 'will-quit' event
function closeDb() {
  if (db) {
    db.close((err) => {
      if (err) {
        return console.error(err.message);
      }
      console.log("Closed the database connection.");
    });
    db = null;
  }
}

// Initialize on load
initializeDatabase();

// Export functions for use in other backend modules
module.exports = { getDb, closeDb };

