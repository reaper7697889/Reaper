const Database = require("better-sqlite3");
const path = require("path");

// Define the path for the database file within the project structure
const dbPath = path.join(__dirname, "..", "..", "database.sqlite"); 
let db;

function initializeDatabase() {
  db = new Database(dbPath, { verbose: console.log });

  console.log("Initializing database schema...");
  db.exec("PRAGMA foreign_keys = ON;");

  // --- Core Tables ---
  db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  db.exec(`CREATE TABLE IF NOT EXISTS folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TABLE IF NOT EXISTS workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  db.exec(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK(type IN ("simple", "markdown", "workspace_page")), title TEXT, content TEXT, folder_id INTEGER, workspace_id INTEGER, is_pinned BOOLEAN DEFAULT 0, is_archived BOOLEAN DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL, FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS update_note_timestamp AFTER UPDATE ON notes FOR EACH ROW BEGIN UPDATE notes SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id; END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE COLLATE NOCASE NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS note_tags (note_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (note_id, tag_id), FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE, FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY AUTOINCREMENT, source_note_id INTEGER NOT NULL, target_note_id INTEGER NOT NULL, link_text TEXT, target_header TEXT, target_block_id TEXT, is_embed BOOLEAN DEFAULT 0 NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE (source_note_id, target_note_id, link_text, target_header, target_block_id, is_embed), FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE);`);

  // --- In-Note Database Feature Tables ---
  db.exec(`CREATE TABLE IF NOT EXISTS note_databases (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER UNIQUE, name TEXT NOT NULL, is_calendar BOOLEAN NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trigger_note_databases_updated_at AFTER UPDATE ON note_databases FOR EACH ROW BEGIN UPDATE note_databases SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id; END;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS database_columns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, database_id INTEGER NOT NULL, name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'RELATION', 'FORMULA', 'ROLLUP', 'LOOKUP', 'DATETIME')), -- Added 'DATETIME'
        column_order INTEGER NOT NULL, default_value TEXT, select_options TEXT,
        linked_database_id INTEGER,
        relation_target_entity_type TEXT NOT NULL DEFAULT 'NOTE_DATABASES' CHECK(relation_target_entity_type IN ('NOTE_DATABASES', 'NOTES_TABLE')),
        inverse_column_id INTEGER DEFAULT NULL,
        formula_definition TEXT DEFAULT NULL, formula_result_type TEXT DEFAULT NULL,
        rollup_source_relation_column_id INTEGER DEFAULT NULL, rollup_target_column_id INTEGER DEFAULT NULL,
        rollup_function TEXT DEFAULT NULL CHECK(rollup_function IS NULL OR rollup_function IN ('COUNT_ALL', 'COUNT_VALUES', 'COUNT_UNIQUE_VALUES', 'SUM', 'AVG', 'MIN', 'MAX', 'SHOW_UNIQUE', 'PERCENT_EMPTY', 'PERCENT_NOT_EMPTY', 'COUNT_CHECKED', 'COUNT_UNCHECKED', 'PERCENT_CHECKED', 'PERCENT_UNCHECKED')),
        lookup_source_relation_column_id INTEGER DEFAULT NULL, lookup_target_value_column_id INTEGER DEFAULT NULL,
        lookup_multiple_behavior TEXT DEFAULT NULL CHECK(lookup_multiple_behavior IS NULL OR lookup_multiple_behavior IN ('FIRST', 'LIST_UNIQUE_STRINGS')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE,
        FOREIGN KEY (linked_database_id) REFERENCES note_databases(id) ON DELETE SET NULL, -- For relation_target_entity_type = 'NOTE_DATABASES'
        -- No direct FK for linked_database_id if target is 'NOTES_TABLE', this is handled by application logic.
        FOREIGN KEY (inverse_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
        FOREIGN KEY (rollup_source_relation_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
        FOREIGN KEY (rollup_target_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
        FOREIGN KEY (lookup_source_relation_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
        FOREIGN KEY (lookup_target_value_column_id) REFERENCES database_columns(id) ON DELETE SET NULL,
        UNIQUE (database_id, name), UNIQUE (database_id, column_order)
    );`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trigger_database_columns_updated_at AFTER UPDATE ON database_columns FOR EACH ROW BEGIN UPDATE database_columns SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id; END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS database_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, database_id INTEGER NOT NULL, row_order INTEGER, recurrence_rule TEXT DEFAULT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (database_id) REFERENCES note_databases(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trigger_database_rows_updated_at AFTER UPDATE ON database_rows FOR EACH ROW BEGIN UPDATE database_rows SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id; END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS database_row_values (id INTEGER PRIMARY KEY AUTOINCREMENT, row_id INTEGER NOT NULL, column_id INTEGER NOT NULL, value_text TEXT, value_number REAL, value_boolean INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (row_id) REFERENCES database_rows(id) ON DELETE CASCADE, FOREIGN KEY (column_id) REFERENCES database_columns(id) ON DELETE CASCADE, UNIQUE (row_id, column_id));`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trigger_database_row_values_updated_at AFTER UPDATE ON database_row_values FOR EACH ROW BEGIN UPDATE database_row_values SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id; END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS database_row_links (id INTEGER PRIMARY KEY AUTOINCREMENT, source_row_id INTEGER NOT NULL, source_column_id INTEGER NOT NULL, target_row_id INTEGER NOT NULL, link_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (source_row_id) REFERENCES database_rows(id) ON DELETE CASCADE, FOREIGN KEY (source_column_id) REFERENCES database_columns(id) ON DELETE CASCADE, FOREIGN KEY (target_row_id) REFERENCES database_rows(id) ON DELETE CASCADE, UNIQUE (source_row_id, source_column_id, target_row_id));`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trigger_database_row_links_updated_at AFTER UPDATE ON database_row_links FOR EACH ROW BEGIN UPDATE database_row_links SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id; END;`);

  // --- Smart Rules Table ---
  db.exec(`CREATE TABLE IF NOT EXISTS smart_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, target_database_id INTEGER NOT NULL, trigger_type TEXT NOT NULL CHECK(trigger_type IN ('ON_ROW_UPDATE')), trigger_config TEXT, condition_formula TEXT, action_type TEXT NOT NULL CHECK(action_type IN ('UPDATE_SAME_ROW')), action_config TEXT NOT NULL, is_enabled BOOLEAN NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (target_database_id) REFERENCES note_databases(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trigger_smart_rules_updated_at AFTER UPDATE ON smart_rules FOR EACH ROW BEGIN UPDATE smart_rules SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id; END;`);

  // --- History Tables ---
  db.exec(`CREATE TABLE IF NOT EXISTS notes_history (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL, changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, version_number INTEGER NOT NULL, title_before TEXT, title_after TEXT, content_before TEXT, content_after TEXT, type_before TEXT, type_after TEXT, changed_fields TEXT, FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE, UNIQUE (note_id, version_number));`);
  db.exec(`CREATE TABLE IF NOT EXISTS database_row_history (id INTEGER PRIMARY KEY AUTOINCREMENT, row_id INTEGER NOT NULL, changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, version_number INTEGER NOT NULL, row_values_before_json TEXT, row_values_after_json TEXT, FOREIGN KEY (row_id) REFERENCES database_rows(id) ON DELETE CASCADE, UNIQUE (row_id, version_number));`);

  // --- Full-Text Search (FTS5) Tables ---
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(note_id UNINDEXED, title, content, tokenize = 'porter unicode61');`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(task_id UNINDEXED, description, tokenize = 'porter unicode61');`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS database_content_fts USING fts5(row_id UNINDEXED, database_id UNINDEXED, content, tokenize = 'porter unicode61');`);

  // Triggers for notes_fts
  db.exec(`CREATE TRIGGER IF NOT EXISTS notes_ai_fts_insert AFTER INSERT ON notes BEGIN INSERT INTO notes_fts (note_id, title, content) VALUES (NEW.id, NEW.title, NEW.content); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS notes_ad_fts_delete AFTER DELETE ON notes BEGIN DELETE FROM notes_fts WHERE note_id = OLD.id; END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS notes_au_fts_update AFTER UPDATE ON notes BEGIN DELETE FROM notes_fts WHERE note_id = OLD.id; INSERT INTO notes_fts (note_id, title, content) VALUES (NEW.id, NEW.title, NEW.content); END;`);

  // Triggers for tasks_fts
  db.exec(`CREATE TRIGGER IF NOT EXISTS tasks_ai_fts_insert AFTER INSERT ON tasks BEGIN INSERT INTO tasks_fts (task_id, description) VALUES (NEW.id, NEW.description); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS tasks_ad_fts_delete AFTER DELETE ON tasks BEGIN DELETE FROM tasks_fts WHERE task_id = OLD.id; END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS tasks_au_fts_update AFTER UPDATE ON tasks BEGIN DELETE FROM tasks_fts WHERE task_id = OLD.id; INSERT INTO tasks_fts (task_id, description) VALUES (NEW.id, NEW.description); END;`);

  // Triggers for database_content_fts
  db.exec(`CREATE TRIGGER IF NOT EXISTS d_rows_ai_fts_insert AFTER INSERT ON database_rows BEGIN INSERT INTO database_content_fts (row_id, database_id, content) VALUES (NEW.id, NEW.database_id, (SELECT GROUP_CONCAT(COALESCE(drv.value_text, ''), ' ') FROM database_row_values drv JOIN database_columns dc ON drv.column_id = dc.id WHERE drv.row_id = NEW.id AND dc.type IN ('TEXT', 'SELECT', 'MULTI_SELECT', 'DATE'))); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS d_rows_ad_fts_delete AFTER DELETE ON database_rows BEGIN DELETE FROM database_content_fts WHERE row_id = OLD.id; END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS d_row_values_ai_fts_update AFTER INSERT ON database_row_values FOR EACH ROW WHEN (SELECT type FROM database_columns WHERE id = NEW.column_id) IN ('TEXT', 'SELECT', 'MULTI_SELECT', 'DATE') BEGIN DELETE FROM database_content_fts WHERE row_id = NEW.row_id; INSERT INTO database_content_fts (row_id, database_id, content) VALUES (NEW.row_id, (SELECT dr.database_id FROM database_rows dr WHERE dr.id = NEW.row_id), (SELECT GROUP_CONCAT(COALESCE(drv.value_text, ''), ' ') FROM database_row_values drv JOIN database_columns dc ON drv.column_id = dc.id WHERE drv.row_id = NEW.row_id AND dc.type IN ('TEXT', 'SELECT', 'MULTI_SELECT', 'DATE'))); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS d_row_values_au_fts_update AFTER UPDATE OF value_text ON database_row_values FOR EACH ROW WHEN (SELECT type FROM database_columns WHERE id = NEW.column_id) IN ('TEXT', 'SELECT', 'MULTI_SELECT', 'DATE') AND OLD.value_text IS NOT NEW.value_text BEGIN DELETE FROM database_content_fts WHERE row_id = NEW.row_id; INSERT INTO database_content_fts (row_id, database_id, content) VALUES (NEW.row_id, (SELECT dr.database_id FROM database_rows dr WHERE dr.id = NEW.row_id), (SELECT GROUP_CONCAT(COALESCE(drv.value_text, ''), ' ') FROM database_row_values drv JOIN database_columns dc ON drv.column_id = dc.id WHERE drv.row_id = NEW.row_id AND dc.type IN ('TEXT', 'SELECT', 'MULTI_SELECT', 'DATE'))); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS d_row_values_ad_fts_update AFTER DELETE ON database_row_values FOR EACH ROW WHEN (SELECT type FROM database_columns WHERE id = OLD.column_id) IN ('TEXT', 'SELECT', 'MULTI_SELECT', 'DATE') BEGIN DELETE FROM database_content_fts WHERE row_id = OLD.row_id; INSERT INTO database_content_fts (row_id, database_id, content) VALUES (OLD.row_id, (SELECT dr.database_id FROM database_rows dr WHERE dr.id = OLD.row_id), (SELECT GROUP_CONCAT(COALESCE(drv.value_text, ''), ' ') FROM database_row_values drv JOIN database_columns dc ON drv.column_id = dc.id WHERE drv.row_id = OLD.row_id AND dc.type IN ('TEXT', 'SELECT', 'MULTI_SELECT', 'DATE'))); END;`);

  // --- Block-Based Workspace Specific Tables ---
  db.exec(`CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, note_id INTEGER NOT NULL, type TEXT NOT NULL, content TEXT, block_order INTEGER NOT NULL, parent_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE, FOREIGN KEY (parent_id) REFERENCES blocks(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS update_block_timestamp AFTER UPDATE ON blocks FOR EACH ROW BEGIN UPDATE blocks SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id; END;`);

  // --- Common Feature Tables ---
  db.exec(`CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER, block_id TEXT, file_path TEXT NOT NULL, mime_type TEXT, original_filename TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE, FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER, block_id TEXT, description TEXT NOT NULL, is_completed BOOLEAN DEFAULT 0, due_date DATETIME, reminder_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE, FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS update_task_timestamp AFTER UPDATE ON tasks FOR EACH ROW BEGIN UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id; END;`);

  // Task Dependencies Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL, -- The task that is dependent/blocked
        depends_on_task_id INTEGER NOT NULL, -- The task it depends on (the blocker)
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        UNIQUE (task_id, depends_on_task_id),
        CHECK (task_id != depends_on_task_id) -- Prevent a task from depending on itself
    );
  `);

  db.exec(`CREATE TABLE IF NOT EXISTS note_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL, content TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE);`);

  // --- Placeholder Tables for Future Features ---
  db.exec(`CREATE TABLE IF NOT EXISTS shares (id INTEGER PRIMARY KEY);`);
  db.exec(`CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY);`);
  db.exec(`CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY);`);
  db.exec(`CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY);`);

  console.log("Database schema initialized successfully.");

  // --- FTS Initial Population Logic (using user_version pragma) ---
  const currentVersionRow = db.prepare("PRAGMA user_version").get();
  const currentUserVersion = currentVersionRow.user_version;
  const targetFtsPopulatedVersion = 1;

  if (currentUserVersion < targetFtsPopulatedVersion) {
    console.log(`Current DB user_version ${currentUserVersion}, attempting to populate FTS tables for version ${targetFtsPopulatedVersion}...`);
    try {
      db.prepare("BEGIN").run();
      console.log("Populating notes_fts table...");
      db.prepare("DELETE FROM notes_fts").run();
      db.prepare("INSERT INTO notes_fts (note_id, title, content) SELECT id, title, content FROM notes").run();
      console.log("Finished populating notes_fts table.");
      console.log("Populating tasks_fts table...");
      db.prepare("DELETE FROM tasks_fts").run();
      db.prepare("INSERT INTO tasks_fts (task_id, description) SELECT id, description FROM tasks").run();
      console.log("Finished populating tasks_fts table.");
      // Initial population for database_content_fts will be handled by its triggers as rows/values are created/updated.
      // Or, could add a similar population step here if desired for existing database_row_values.
      // For now, relying on triggers for database_content_fts.
      db.prepare(`PRAGMA user_version = ${targetFtsPopulatedVersion}`).run();
      db.prepare("COMMIT").run();
      console.log(`Successfully populated FTS tables (notes, tasks) and set user_version to ${targetFtsPopulatedVersion}.`);
    } catch (err) {
      console.error("Error during FTS initial data population:", err.message, err.stack);
      try { db.prepare("ROLLBACK").run(); console.log("Rolled back FTS population transaction."); }
      catch (rollbackErr) { console.error("Error rolling back FTS population transaction:", rollbackErr.message); }
    }
  } else {
    console.log(`DB user_version is ${currentUserVersion}. Notes/Tasks FTS tables presumed populated for version ${targetFtsPopulatedVersion} or newer.`);
  }

  // --- database_content_fts Initial Population Logic ---
  // Re-fetch user_version as it might have been updated by the previous FTS step
  const dbContentViewRow = db.prepare("PRAGMA user_version").get();
  const currentDbContentViewUserVersion = dbContentViewRow.user_version;
  const targetDbContentFtsVersion = 2; // Target version for this specific migration

  if (currentDbContentViewUserVersion < targetDbContentFtsVersion) {
    console.log(`Current DB user_version ${currentDbContentViewUserVersion}, attempting to populate database_content_fts for version ${targetDbContentFtsVersion}...`);
    try {
      db.prepare("BEGIN").run();

      console.log("Populating database_content_fts table...");
      db.prepare("DELETE FROM database_content_fts").run(); // Clear existing data
      const populateStmt = db.prepare(
        `INSERT INTO database_content_fts (row_id, database_id, content)
         SELECT dr.id, dr.database_id,
                (SELECT GROUP_CONCAT(COALESCE(drv.value_text, ''), ' ')
                 FROM database_row_values drv
                 JOIN database_columns dc ON drv.column_id = dc.id
                 WHERE drv.row_id = dr.id
                 AND dc.type IN ('TEXT', 'SELECT', 'MULTI_SELECT', 'DATE')
                )
         FROM database_rows dr`
      );
      populateStmt.run();
      console.log("Finished populating database_content_fts table.");

      db.prepare(`PRAGMA user_version = ${targetDbContentFtsVersion}`).run();
      db.prepare("COMMIT").run();
      console.log(`Successfully populated database_content_fts and set user_version to ${targetDbContentFtsVersion}.`);

    } catch (err) {
      console.error("Error during database_content_fts initial data population:", err.message, err.stack);
      try {
        db.prepare("ROLLBACK").run();
        console.log("Rolled back database_content_fts population transaction.");
      } catch (rollbackErr) {
        console.error("Error rolling back database_content_fts population transaction:", rollbackErr.message);
      }
    }
  } else {
    console.log(`DB user_version is ${currentDbContentViewUserVersion}. database_content_fts table presumed populated for version ${targetDbContentFtsVersion} or newer.`);
  }
}

function getDb() {
  if (!db) {
    initializeDatabase();
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close((err) => {
      if (err) return console.error(err.message);
      console.log("Closed the database connection.");
    });
    db = null;
  }
}

initializeDatabase();

module.exports = { getDb, closeDb };
