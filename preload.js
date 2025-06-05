// /home/ubuntu/unified-notes-app/preload.js
const { contextBridge, ipcRenderer } = require("electron");

// Expose specific IPC channels to the renderer process securely
contextBridge.exposeInMainWorld("electronAPI", {
  // Generic invoke (optional, can be removed if all calls are specific)
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // --- Note Service ---
  getNotesByFolder: (folderId) => ipcRenderer.invoke("db:getNotesByFolder", folderId),
  getNoteById: (noteId) => ipcRenderer.invoke("db:getNoteById", noteId),
  createNote: (noteData) => ipcRenderer.invoke("db:createNote", noteData),
  updateNote: (noteId, updateData) => ipcRenderer.invoke("db:updateNote", noteId, updateData),
  deleteNote: (noteId) => ipcRenderer.invoke("db:deleteNote", noteId),
  // Add listNotesByWorkspace, searchNotes etc. later

  // --- Tag Service ---
  findOrCreateTag: (tagName) => ipcRenderer.invoke("db:findOrCreateTag", tagName),
  addTagToNote: (noteId, tagId) => ipcRenderer.invoke("db:addTagToNote", noteId, tagId),
  removeTagFromNote: (noteId, tagId) => ipcRenderer.invoke("db:removeTagFromNote", noteId, tagId),
  getTagsForNote: (noteId) => ipcRenderer.invoke("db:getTagsForNote", noteId),
  getAllTags: () => ipcRenderer.invoke("db:getAllTags"),
  getNotesForTag: (tagId) => ipcRenderer.invoke("db:getNotesForTag", tagId),

  // --- Folder Service ---
  getFolders: (parentId = null) => ipcRenderer.invoke("db:getFolders", parentId),
  createFolder: (folderData) => ipcRenderer.invoke("db:createFolder", folderData),
  // Add updateFolder, deleteFolder later

  // --- Workspace Service ---
  getWorkspaces: () => ipcRenderer.invoke("db:getWorkspaces"),
  createWorkspace: (workspaceData) => ipcRenderer.invoke("db:createWorkspace", workspaceData),
  // Add updateWorkspace, deleteWorkspace later

  // --- Block Service ---
  createBlock: (blockData) => ipcRenderer.invoke("db:createBlock", blockData),
  getBlockById: (blockId) => ipcRenderer.invoke("db:getBlockById", blockId),
  updateBlock: (blockId, updateData) => ipcRenderer.invoke("db:updateBlock", blockId, updateData),
  deleteBlock: (blockId) => ipcRenderer.invoke("db:deleteBlock", blockId),
  getBlocksForNote: (noteId) => ipcRenderer.invoke("db:getBlocksForNote", noteId),

  // --- Attachment Service ---
  // Note: createAttachment needs careful handling due to file paths
  // Might need a different approach like asking main process to open dialog
  // or receiving file buffer/path from renderer after user selection.
  // For now, expose retrieval and deletion.
  getAttachmentsForNote: (noteId) => ipcRenderer.invoke("db:getAttachmentsForNote", noteId),
  getAttachmentsForBlock: (blockId) => ipcRenderer.invoke("db:getAttachmentsForBlock", blockId),
  deleteAttachment: (attachmentId) => ipcRenderer.invoke("db:deleteAttachment", attachmentId),
  // createAttachment: (attachmentData) => ipcRenderer.invoke("db:createAttachment", attachmentData), // Needs more thought

  // --- Link Service ---
  createLink: (sourceNoteId, targetIdentifier, linkText) => ipcRenderer.invoke("db:createLink", sourceNoteId, targetIdentifier, linkText),
  getBacklinks: (targetNoteId) => ipcRenderer.invoke("db:getBacklinks", targetNoteId),
  getOutgoingLinks: (sourceNoteId) => ipcRenderer.invoke("db:getOutgoingLinks", sourceNoteId),
  deleteLinksFromSource: (sourceNoteId) => ipcRenderer.invoke("db:deleteLinksFromSource", sourceNoteId),

  // --- Task Service ---
  createTask: (taskData) => ipcRenderer.invoke("db:createTask", taskData),
  getTaskById: (taskId) => ipcRenderer.invoke("db:getTaskById", taskId),
  updateTask: (taskId, updateData) => ipcRenderer.invoke("db:updateTask", taskId, updateData),
  deleteTask: (taskId) => ipcRenderer.invoke("db:deleteTask", taskId),
  getTasksForNote: (noteId) => ipcRenderer.invoke("db:getTasksForNote", noteId),
  getTasksForBlock: (blockId) => ipcRenderer.invoke("db:getTasksForBlock", blockId),

});

console.log("Preload script loaded and API exposed.");

