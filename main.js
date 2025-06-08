const { app, BrowserWindow, ipcMain, dialog } = require("electron"); // Added dialog
const path = require("path");
const fs = require('fs').promises; // Changed to fs.promises

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
const historyService = require("./src/backend/services/historyService");
const exportService = require('./src/backend/services/exportService');
const importService = require('./src/backend/services/importService');
const searchService = require('./src/backend/services/searchService');
const calendarService = require('./src/backend/services/calendarService');
const timelineService = require('./src/backend/services/timelineService');
const timeLogService = require('./src/backend/services/timeLogService');
const userService = require('./src/backend/services/userService'); // Added userService
const suggestionService = require('./src/backend/services/suggestionService');

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
ipcMain.handle("db:getNotesByFolder", (e, folderId, requestingUserId) => noteService.listNotesByFolder(folderId, requestingUserId));
ipcMain.handle("db:getNoteById", (e, noteId, requestingUserId) => noteService.getNoteById(noteId, requestingUserId));
ipcMain.handle("db:createNote", (e, noteData) => noteService.createNote(noteData)); // createNote expects userId in noteData
ipcMain.handle("db:updateNote", (e, noteId, updateData, requestingUserId) => noteService.updateNote(noteId, updateData, requestingUserId));
ipcMain.handle("db:deleteNote", (e, noteId, requestingUserId) => noteService.deleteNote(noteId, requestingUserId));
ipcMain.handle("templates:get", (e, requestingUserId) => noteService.getTemplates({ userId: requestingUserId }));
ipcMain.handle("note:setTemplateStatus", (e, noteId, isTemplate, requestingUserId) => {
  return noteService.updateNote(noteId, { is_template: isTemplate }, requestingUserId);
});
ipcMain.handle('template:createBlank', async (e, requestingUserId, initialTitle = "Untitled Template") => {
  if (!requestingUserId) {
    return { success: false, error: "User ID is required to create a template." };
  }
  const noteData = {
    title: initialTitle,
    type: 'markdown', // Default to Markdown, or could be a user preference later
    content: '',       // Blank content
    is_template: 1,  // Mark as template
    userId: requestingUserId
  };
  try {
    const newTemplateId = await noteService.createNote(noteData);
    if (newTemplateId) {
      // Fetch the full note object to return, as createNote only returns the ID
      const newTemplate = await noteService.getNoteById(newTemplateId, requestingUserId, { bypassPermissionCheck: false });
      return { success: true, template: newTemplate };
    } else {
      return { success: false, error: "Failed to create blank template note." };
    }
  } catch (error) {
    console.error("Error in template:createBlank IPC handler:", error);
    return { success: false, error: error.message || "IPC Error: Failed to create blank template." };
  }
});

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
ipcMain.handle("db:createTask", (e, taskData) => taskService.createTask(taskData)); // createTask expects userId in taskData
ipcMain.handle("db:getTaskById", (e, taskId, requestingUserId) => taskService.getTaskById(taskId, requestingUserId));
ipcMain.handle("db:updateTask", (e, taskId, updateData, requestingUserId) => taskService.updateTask(taskId, updateData, requestingUserId));
ipcMain.handle("db:deleteTask", (e, taskId, requestingUserId) => taskService.deleteTask(taskId, requestingUserId));
ipcMain.handle("db:getTasksForNote", (e, noteId, requestingUserId) => taskService.getTasksForNote(noteId, requestingUserId));
ipcMain.handle("db:getTasksForBlock", (e, blockId, requestingUserId) => taskService.getTasksForBlock(blockId, requestingUserId));

ipcMain.handle("tasks:addTaskDependency", async (event, taskId, dependsOnTaskId, requestingUserId) => {
    try {
        return await taskService.addTaskDependency(taskId, dependsOnTaskId, requestingUserId);
    } catch (error) {
        console.error("Error in 'tasks:addTaskDependency' IPC handler:", error);
        return { success: false, error: error.message || "Failed to add task dependency." };
    }
});

ipcMain.handle("tasks:removeTaskDependency", async (event, taskId, dependsOnTaskId, requestingUserId) => {
    try {
        return await taskService.removeTaskDependency(taskId, dependsOnTaskId, requestingUserId);
    } catch (error) {
        console.error("Error in 'tasks:removeTaskDependency' IPC handler:", error);
        return { success: false, error: error.message || "Failed to remove task dependency." };
    }
});

ipcMain.handle("tasks:getTaskPrerequisites", async (event, taskId, requestingUserId) => {
    try {
        return await taskService.getTaskPrerequisites(taskId, requestingUserId);
    } catch (error) {
        console.error("Error in 'tasks:getTaskPrerequisites' IPC handler:", error);
        return { success: false, error: error.message || "Failed to get task prerequisites." };
    }
});

ipcMain.handle("tasks:getTasksBlockedBy", async (event, taskId, requestingUserId) => {
    try {
        return await taskService.getTasksBlockedBy(taskId, requestingUserId);
    } catch (error) {
        console.error("Error in 'tasks:getTasksBlockedBy' IPC handler:", error);
        return { success: false, error: error.message || "Failed to get tasks blocked by." };
    }
});

// Suggestion Service
ipcMain.handle("suggestions:getRelatedByTags", async (e, noteId, requestingUserId, limit) => {
  if (!noteId || !requestingUserId) {
    console.error('[IPC suggestions:getRelatedByTags] Missing noteId or requestingUserId');
    return { success: false, error: "noteId and requestingUserId are required.", suggestions: [] };
  }
  try {
    const suggestions = await suggestionService.getRelatedNotesByTags({ noteId, requestingUserId, limit });
    return { success: true, suggestions: suggestions };
  } catch (error) {
    console.error(`[IPC suggestions:getRelatedByTags] Error for noteId ${noteId}:`, error);
    return { success: false, error: error.message, suggestions: [] };
  }
});

// Graph Service
ipcMain.handle("graph:getGraphData", async () => {
  return graphService.getGraphData();
});

// Database Definition Service
// createDatabase expects userId in args
ipcMain.handle("dbdef:createDatabase", (e, argsWithUserId) => databaseDefService.createDatabase(argsWithUserId));
ipcMain.handle("dbdef:getDatabaseById", (e, id, requestingUserId) => databaseDefService.getDatabaseById(id, requestingUserId));
ipcMain.handle("dbdef:getDatabasesForNote", (e, noteId, requestingUserId) => databaseDefService.getDatabasesForNote(noteId, requestingUserId));
ipcMain.handle("dbdef:updateDatabaseMetadata", (e, databaseId, updates, requestingUserId) => databaseDefService.updateDatabaseMetadata(databaseId, updates, requestingUserId));
ipcMain.handle("dbdef:deleteDatabase", (e, id, requestingUserId) => databaseDefService.deleteDatabase(id, requestingUserId));
// addColumn and updateColumn service functions take (args, requestingUserId)
ipcMain.handle("dbdef:addColumn", (e, args, requestingUserId) => databaseDefService.addColumn(args, requestingUserId));
ipcMain.handle("dbdef:getColumnsForDatabase", (e, dbId, requestingUserId) => databaseDefService.getColumnsForDatabase(dbId, requestingUserId));
ipcMain.handle("dbdef:updateColumn", (e, args, requestingUserId) => databaseDefService.updateColumn(args, requestingUserId));
ipcMain.handle("dbdef:deleteColumn", (e, id, requestingUserId) => databaseDefService.deleteColumn(id, requestingUserId));

// Database Row Service
// addRow, updateRow expect requestingUserId within the args object passed from frontend
ipcMain.handle("dbrow:addRow", (e, argsWithUserId) => databaseRowService.addRow(argsWithUserId));
ipcMain.handle("dbrow:getRow", (e, id, requestingUserId) => databaseRowService.getRow(id, requestingUserId));
ipcMain.handle("dbrow:updateRow", (e, argsWithUserId) => databaseRowService.updateRow(argsWithUserId));
ipcMain.handle("dbrow:deleteRow", (e, id, requestingUserId) => databaseRowService.deleteRow(id, requestingUserId));

// Database Query Service
ipcMain.handle("dbquery:getRowsForDatabase", (e, databaseId, options, requestingUserId) => databaseQueryService.getRowsForDatabase(databaseId, options, requestingUserId));

// Smart Rule Service
ipcMain.handle("rules:createRule", (e, args) => smartRuleService.createRule(args));
ipcMain.handle("rules:getRuleById", (e, id) => smartRuleService.getRuleById(id));
ipcMain.handle("rules:getRulesForDatabase", (e, dbId, options) => smartRuleService.getRulesForDatabase(dbId, options));
ipcMain.handle("rules:updateRule", (e, id, updates) => smartRuleService.updateRule(id, updates));
ipcMain.handle("rules:deleteRule", (e, id) => smartRuleService.deleteRule(id));

// History Service
ipcMain.handle("history:getNoteHistory", (e, noteId, options) => historyService.getNoteHistory(noteId, options)); // Read-only, no user ID needed for filtering history itself
ipcMain.handle("history:getRowHistory", (e, rowId, options) => historyService.getRowHistory(rowId, options)); // Read-only
ipcMain.handle("history:revertNoteToVersion", (e, noteId, versionNumber, requestingUserId) => historyService.revertNoteToVersion(noteId, versionNumber, requestingUserId));
ipcMain.handle("history:revertRowToVersion", (e, rowId, versionNumber, requestingUserId) => historyService.revertRowToVersion(rowId, versionNumber, requestingUserId));

// Export Service Handlers
ipcMain.handle("export:note", async (event, noteId, format) => {
  try {
    const result = await exportService.getNoteExportData(noteId, format);
    if (!result || result.success === false) { // Check for service error structure
      return { success: false, error: result?.error || 'Failed to get note export data or note not found.' };
    }
    const saveDialogResult = await dialog.showSaveDialog({ defaultPath: result.filename });
    if (saveDialogResult.canceled || !saveDialogResult.filePath) {
      return { success: false, error: 'Export cancelled by user.' };
    }
    await fs.writeFile(saveDialogResult.filePath, result.data);
    return { success: true, path: saveDialogResult.filePath };
  } catch (error) {
    console.error("Export note error:", error);
    return { success: false, error: error.message || "An unexpected error occurred during note export." };
  }
});

ipcMain.handle("export:notesCollection", async (event, filter, format) => {
  try {
    const result = await exportService.getNotesCollectionExportData({ filter, format });
    if (!result || result.success === false) {
      return { success: false, error: result?.error || 'Failed to get notes collection export data.' };
    }

    if (format === 'json') { // Single file
      const saveDialogResult = await dialog.showSaveDialog({ defaultPath: result.filename });
      if (saveDialogResult.canceled || !saveDialogResult.filePath) {
        return { success: false, error: 'Export cancelled by user.' };
      }
      await fs.writeFile(saveDialogResult.filePath, result.data);
      return { success: true, path: saveDialogResult.filePath };
    } else if (format === 'markdown') { // Multiple files
      const dirDialogResult = await dialog.showOpenDialog({
        title: "Select Export Directory",
        properties: ['openDirectory', 'createDirectory']
      });
      if (dirDialogResult.canceled || !dirDialogResult.filePaths || dirDialogResult.filePaths.length === 0) {
        return { success: false, error: 'Export directory selection cancelled.' };
      }
      const chosenDir = dirDialogResult.filePaths[0];
      for (const item of result) { // result is an array of {filename, data}
        await fs.writeFile(path.join(chosenDir, item.filename), item.data);
      }
      return { success: true, directory: chosenDir, filesExported: result.length };
    } else {
        return { success: false, error: `Unsupported format for collection export: ${format}`};
    }
  } catch (error) {
    console.error("Export notes collection error:", error);
    return { success: false, error: error.message || "An unexpected error occurred during notes collection export." };
  }
});

ipcMain.handle("export:tableToCsv", async (event, databaseId) => {
  try {
    const result = await exportService.getTableCsvData(databaseId);
    if (!result || result.success === false) {
      return { success: false, error: result?.error || 'Failed to get table CSV data.' };
    }
    const saveDialogResult = await dialog.showSaveDialog({
      defaultPath: result.filename,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    if (saveDialogResult.canceled || !saveDialogResult.filePath) {
      return { success: false, error: 'Export cancelled by user.' };
    }
    await fs.writeFile(saveDialogResult.filePath, result.data);
    return { success: true, path: saveDialogResult.filePath };
  } catch (error) {
    console.error("Export table to CSV error:", error);
    return { success: false, error: error.message || "An unexpected error occurred during CSV export." };
  }
});

// Import Service Handlers
ipcMain.handle("import:markdownNote", async (event, targetFolderId = null) => {
  try {
    const dialogResult = await dialog.showOpenDialog({
      title: "Import Markdown File",
      properties: ['openFile'],
      filters: [{ name: 'Markdown Files', extensions: ['md', 'markdown', 'txt'] }]
    });
    if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length === 0) {
      return { success: false, error: 'Import cancelled or no file selected.' };
    }
    const filePath = dialogResult.filePaths[0];
    const markdownContent = await fs.readFile(filePath, 'utf-8');
    const titleHint = path.basename(filePath);
    return await importService.importMarkdownNoteFromString(markdownContent, titleHint, targetFolderId);
  } catch (error) {
    console.error("Import Markdown note error:", error);
    return { success: false, error: error.message || "An unexpected error occurred during Markdown import." };
  }
});

ipcMain.handle("import:jsonNotes", async (event, defaultFolderId = null) => {
  try {
    const dialogResult = await dialog.showOpenDialog({
      title: "Import JSON Notes File",
      properties: ['openFile'],
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    });
    if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length === 0) {
      return { success: false, error: 'Import cancelled or no file selected.' };
    }
    const filePath = dialogResult.filePaths[0];
    const jsonString = await fs.readFile(filePath, 'utf-8');
    return await importService.importJsonNotesFromString(jsonString, defaultFolderId);
  } catch (error) {
    console.error("Import JSON notes error:", error);
    return { success: false, error: error.message || "An unexpected error occurred during JSON import." };
  }
});

ipcMain.handle("import:csvToTable", async (event, databaseId, columnMapping = {}, options = { skipHeader: true }) => {
  try {
    const dialogResult = await dialog.showOpenDialog({
      title: "Import CSV into Table",
      properties: ['openFile'],
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length === 0) {
      return { success: false, error: 'Import cancelled or no file selected.' };
    }
    const filePath = dialogResult.filePaths[0];
    const csvString = await fs.readFile(filePath, 'utf-8');
    return await importService.importCsvToTableFromString(databaseId, csvString, columnMapping, options);
  } catch (error) {
    console.error("Import CSV to table error:", error);
    return { success: false, error: error.message || "An unexpected error occurred during CSV import." };
  }
});

// Search Service
ipcMain.handle("search:all", async (event, searchText, options) => {
    try {
        // searchService.searchAll already returns a structured error object or an array of results.
        return await searchService.searchAll(searchText, options);
    } catch (error) {
        // This outer catch is for unexpected errors in the IPC call itself or if searchService throws an unhandled one.
        console.error("Error during search:all IPC call:", error);
        return { success: false, error: error.message || "An unexpected error occurred during search." };
    }
});

// Calendar Service
ipcMain.handle("calendar:getEvents", (e, databaseId, startStr, endStr, options) =>
    calendarService.getCalendarEvents(databaseId, startStr, endStr, options)
);

// Timeline Service
ipcMain.handle("timeline:getTimelineDataForDatabase", (e, config) =>
    timelineService.getTimelineDataForDatabase(config)
);

// --- Time Log Service ---
// startTimerForTask and addManualLogForTask take (taskId, options/logData, requestingUserId)
// options/logData should NOT contain userId anymore for these, it's taken from requestingUserId
ipcMain.handle("timelogs:startTimerForTask", async (event, taskId, options, requestingUserId) => {
    try {
        return await timeLogService.startTimerForTask(taskId, options, requestingUserId);
    } catch (error) {
        console.error("Error in 'timelogs:startTimerForTask' IPC handler:", error);
        return { success: false, error: error.message || "Failed to start timer." };
    }
});

ipcMain.handle("timelogs:stopTimerForTask", async (event, taskId, options, requestingUserId) => {
    try {
        return await timeLogService.stopTimerForTask(taskId, options, requestingUserId);
    } catch (error) {
        console.error("Error in 'timelogs:stopTimerForTask' IPC handler:", error);
        return { success: false, error: error.message || "Failed to stop timer." };
    }
});

ipcMain.handle("timelogs:addManualLogForTask", async (event, taskId, logData, requestingUserId) => {
    try {
        return await timeLogService.addManualLogForTask(taskId, logData, requestingUserId);
    } catch (error) {
        console.error("Error in 'timelogs:addManualLogForTask' IPC handler:", error);
        return { success: false, error: error.message || "Failed to add manual log." };
    }
});

ipcMain.handle("timelogs:updateTimeLog", async (event, logId, updates, requestingUserId) => {
    try {
        return await timeLogService.updateTimeLog(logId, updates, requestingUserId);
    } catch (error) {
        console.error("Error in 'timelogs:updateTimeLog' IPC handler:", error);
        return { success: false, error: error.message || "Failed to update time log." };
    }
});

ipcMain.handle("timelogs:deleteTimeLog", async (event, logId, requestingUserId) => {
    try {
        return await timeLogService.deleteTimeLog(logId, requestingUserId);
    } catch (error) {
        console.error("Error in 'timelogs:deleteTimeLog' IPC handler:", error);
        return { success: false, error: error.message || "Failed to delete time log." };
    }
});

ipcMain.handle("timelogs:getLogsForTask", async (event, taskId, options, requestingUserId) => {
    try {
        return await timeLogService.getLogsForTask(taskId, options, requestingUserId);
    } catch (error) {
        console.error("Error in 'timelogs:getLogsForTask' IPC handler:", error);
        return { success: false, error: error.message || "Failed to get time logs." };
    }
});

ipcMain.handle("timelogs:getActiveTimerForTask", async (event, taskId, requestingUserId) => {
    try {
        return await timeLogService.getActiveTimerForTask(taskId, requestingUserId);
    } catch (error) {
        console.error("Error in 'timelogs:getActiveTimerForTask' IPC handler:", error);
        return { success: false, error: error.message || "Failed to get active timer." };
    }
});

// --- User Service ---
ipcMain.handle("user:register", async (event, username, password) => {
    try {
        return await userService.registerUser(username, password);
    } catch (error) {
        console.error("Error in 'user:register' IPC handler:", error);
        return { success: false, error: error.message || "User registration failed." };
    }
});

ipcMain.handle("user:login", async (event, username, password) => {
    try {
        return await userService.loginUser(username, password);
    } catch (error) {
        console.error("Error in 'user:login' IPC handler:", error);
        return { success: false, error: error.message || "User login failed." };
    }
});

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
