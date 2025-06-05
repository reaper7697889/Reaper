const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

// Import backend services
require("./src/backend/db"); // Initialize DB connection
const noteService = require("./src/backend/services/noteService");
const tagService = require("./src/backend/services/tagService");
const blockService = require("./src/backend/services/blockService");
const attachmentService = require("./src/backend/services/attachmentService");
const linkService = require("./src/backend/services/linkService");
const taskService = require("./src/backend/services/taskService");
const folderService = require("./src/backend/services/folderService");
const workspaceService = require("./src/backend/services/workspaceService");
const graphService = require("./src/backend/services/graphService");
const databaseDefService = require("./src/backend/services/databaseDefService");
const databaseRowService = require("./src/backend/services/databaseRowService");
const databaseQueryService = require("./src/backend/services/databaseQueryService");
const smartRuleService = require("./src/backend/services/smartRuleService");
const historyService = require("./src/backend/services/historyService"); // Added historyService

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "public/index.html"));

  // mainWindow.webContents.openDevTools(); // Optional
}

// --- IPC Handlers ---

// Note Service
ipcMain.handle("db:getNotesByFolder", (e, folderId) => noteService.listNotesByFolder(folderId));
ipcMain.handle("db:getNoteById", (e, noteId) => noteService.getNoteById(noteId));
ipcMain.handle("db:createNote", (e, noteData) => noteService.createNote(noteData));
ipcMain.handle("db:updateNote", (e, noteId, updateData) => noteService.updateNote(noteId, updateData));
ipcMain.handle("db:deleteNote", (e, noteId) => noteService.deleteNote(noteId));

// Tag Service
ipcMain.handle("db:findOrCreateTag", (e, tagName) => tagService.findOrCreateTag(tagName));
ipcMain.handle("db:addTagToNote", (e, noteId, tagId) => tagService.addTagToNote(noteId, tagId));
ipcMain.handle("db:removeTagFromNote", (e, noteId, tagId) => tagService.removeTagFromNote(noteId, tagId));
ipcMain.handle("db:getTagsForNote", (e, noteId) => tagService.getTagsForNote(noteId));
ipcMain.handle("db:getAllTags", () => tagService.getAllTags());
ipcMain.handle("db:getNotesForTag", (e, tagId) => tagService.getNotesForTag(tagId));
ipcMain.handle("tags:renameTag", async (e, tagId, newTagName) => { return tagService.renameTag(tagId, newTagName); });
ipcMain.handle("tags:deleteTag", async (e, tagId) => { return tagService.deleteTag(tagId); });

// Folder Service
ipcMain.handle("db:getFolders", (e, parentId = null) => folderService.getFolders(parentId));
ipcMain.handle("db:createFolder", (e, folderData) => folderService.createFolder(folderData));

// Workspace Service
ipcMain.handle("db:getWorkspaces", () => workspaceService.getWorkspaces());
ipcMain.handle("db:createWorkspace", (e, workspaceData) => workspaceService.createWorkspace(workspaceData));

// Block Service
ipcMain.handle("db:createBlock", (e, blockData) => blockService.createBlock(blockData));
ipcMain.handle("db:getBlockById", (e, blockId) => blockService.getBlockById(blockId));
ipcMain.handle("db:updateBlock", (e, blockId, updateData) => blockService.updateBlock(blockId, updateData));
ipcMain.handle("db:deleteBlock", (e, blockId) => blockService.deleteBlock(blockId));
ipcMain.handle("db:getBlocksForNote", (e, noteId) => blockService.getBlocksForNote(noteId));

// Attachment Service
ipcMain.handle("db:getAttachmentsForNote", (e, noteId) => attachmentService.getAttachmentsForNote(noteId));
ipcMain.handle("db:getAttachmentsForBlock", (e, blockId) => attachmentService.getAttachmentsForBlock(blockId));
ipcMain.handle("db:deleteAttachment", (e, attachmentId) => attachmentService.deleteAttachment(attachmentId));

// Link Service
ipcMain.handle("db:createLink", (e, sourceNoteId, targetIdentifier, linkText) => linkService.createLink(sourceNoteId, targetIdentifier, linkText));
ipcMain.handle("db:getBacklinks", (e, targetNoteId) => linkService.getBacklinks(targetNoteId));
ipcMain.handle("db:getOutgoingLinks", (e, sourceNoteId) => linkService.getOutgoingLinks(sourceNoteId));
ipcMain.handle("db:deleteLinksFromSource", (e, sourceNoteId) => linkService.deleteLinksFromSource(sourceNoteId));
ipcMain.handle("db:updateLinksFromContent", (e, noteId, content) => linkService.updateLinksFromContent(noteId, content));

// Task Service
ipcMain.handle("db:createTask", (e, taskData) => taskService.createTask(taskData));
ipcMain.handle("db:getTaskById", (e, taskId) => taskService.getTaskById(taskId));
ipcMain.handle("db:updateTask", (e, taskId, updateData) => taskService.updateTask(taskId, updateData));
ipcMain.handle("db:deleteTask", (e, taskId) => taskService.deleteTask(taskId));
ipcMain.handle("db:getTasksForNote", (e, noteId) => taskService.getTasksForNote(noteId));
ipcMain.handle("db:getTasksForBlock", (e, blockId) => taskService.getTasksForBlock(blockId));

// Graph Service
ipcMain.handle("graph:getGraphData", async () => {
  return graphService.getGraphData();
});

// Database Definition Service
ipcMain.handle("dbdef:createDatabase", (e, args) => databaseDefService.createDatabase(args));
ipcMain.handle("dbdef:getDatabaseById", (e, id) => databaseDefService.getDatabaseById(id));
ipcMain.handle("dbdef:getDatabasesForNote", (e, noteId) => databaseDefService.getDatabasesForNote(noteId));
ipcMain.handle("dbdef:updateDatabaseName", (e, args) => databaseDefService.updateDatabaseName(args));
ipcMain.handle("dbdef:deleteDatabase", (e, id) => databaseDefService.deleteDatabase(id));
ipcMain.handle("dbdef:addColumn", (e, args) => databaseDefService.addColumn(args));
ipcMain.handle("dbdef:getColumnsForDatabase", (e, dbId) => databaseDefService.getColumnsForDatabase(dbId));
ipcMain.handle("dbdef:updateColumn", (e, args) => databaseDefService.updateColumn(args));
ipcMain.handle("dbdef:deleteColumn", (e, id) => databaseDefService.deleteColumn(id));

// Database Row Service
ipcMain.handle("dbrow:addRow", (e, args) => databaseRowService.addRow(args));
ipcMain.handle("dbrow:getRow", (e, id) => databaseRowService.getRow(id));
ipcMain.handle("dbrow:updateRow", (e, args) => databaseRowService.updateRow(args));
ipcMain.handle("dbrow:deleteRow", (e, id) => databaseRowService.deleteRow(id));

// Database Query Service
ipcMain.handle("dbquery:getRowsForDatabase", (e, databaseId, options) => databaseQueryService.getRowsForDatabase(databaseId, options));

// Smart Rule Service
ipcMain.handle("rules:createRule", (e, args) => smartRuleService.createRule(args));
ipcMain.handle("rules:getRuleById", (e, id) => smartRuleService.getRuleById(id));
ipcMain.handle("rules:getRulesForDatabase", (e, dbId, options) => smartRuleService.getRulesForDatabase(dbId, options));
ipcMain.handle("rules:updateRule", (e, id, updates) => smartRuleService.updateRule(id, updates));
ipcMain.handle("rules:deleteRule", (e, id) => smartRuleService.deleteRule(id));

// History Service
ipcMain.handle("history:getNoteHistory", (e, noteId, options) => historyService.getNoteHistory(noteId, options));
ipcMain.handle("history:getRowHistory", (e, rowId, options) => historyService.getRowHistory(rowId, options));

// --- App Lifecycle ---

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    const { closeDb } = require("./src/backend/db");
    closeDb();
    app.quit();
  }
});

app.on("will-quit", () => {
  const { closeDb } = require("./src/backend/db");
  closeDb();
});
