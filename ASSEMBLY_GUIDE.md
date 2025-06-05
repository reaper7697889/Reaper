# Unified Notes App - Assembly Guide

## Overview

The Unified Notes App is a comprehensive knowledge management solution that combines features from Samsung Notes, Apple Notes, Obsidian, and Notion into a single, cohesive desktop application. This guide will help you set up and run the application.

## System Requirements

- **Operating System**: Windows 10/11, macOS 10.15+, or Linux
- **RAM**: 4GB minimum, 8GB recommended
- **Disk Space**: 500MB for the application, plus additional space for your notes and attachments
- **Node.js**: v14.0.0 or higher
- **npm**: v6.0.0 or higher

## Installation

### Step 1: Clone or Extract the Repository

If you received a ZIP file, extract it to a location of your choice. If you're using Git:

```bash
git clone <repository-url>
cd unified-notes-app
```

### Step 2: Install Dependencies

```bash
npm install
```

This will install all required dependencies, including:
- Electron (for desktop application)
- React (for UI)
- Better-SQLite3 (for local database)
- React-Quill (for rich text editing)
- React-Markdown (for markdown editing)
- React-Canvas-Draw (for drawing/handwriting)
- React-Mic (for voice recording)
- React-Force-Graph (for knowledge graph)
- Other utility libraries

### Step 3: Initialize the Database

The first time you run the application, the database will be automatically initialized with the necessary tables. No manual setup is required.

## Running the Application

### Development Mode

To run the application in development mode:

```bash
npm start
```

This will start the Electron application with hot-reloading enabled.

### Building for Production

To build the application for production:

```bash
npm run build
```

This will create platform-specific distributables in the `dist` folder.

## Application Structure

The application is organized as follows:

```
unified-notes-app/
├── src/                    # Source code
│   ├── components/         # React components
│   ├── backend/            # Backend services
│   │   ├── models/         # Data models
│   │   └── services/       # Service functions
│   ├── App.js              # Main React component
│   └── index.js            # Entry point for React
├── main.js                 # Electron main process
├── preload.js              # Electron preload script
└── package.json            # Project configuration
```

## Features

The Unified Notes App includes the following features:

### Simple Notes Module
- Rich text editing with formatting options
- Drawing/handwriting support
- Voice memo recording and playback
- Folder organization

### Markdown Knowledge Base Module
- Markdown editing with live preview
- Wiki-style linking with [[brackets]]
- Backlinks tracking
- Knowledge graph visualization

### Block Workspace Module
- Block-based editing (Notion-style)
- Multiple block types (text, headings, lists, etc.)
- Database views (table, kanban, calendar)

### Cross-Module Features
- File attachments with previews
- Task management with due dates
- Dark/light theme toggle
- Full-text search across all content types
- Tags for organization

## Customization

### Themes

The application comes with both dark and light themes. You can toggle between them using the button in the top bar.

### Data Location

By default, the application stores all data in:
- Windows: `%APPDATA%\unified-notes-app`
- macOS: `~/Library/Application Support/unified-notes-app`
- Linux: `~/.config/unified-notes-app`

## Troubleshooting

### Database Issues

If you encounter database issues, you can reset the database by deleting the SQLite file in the data location mentioned above. Note that this will delete all your notes and data.

### Application Won't Start

- Ensure you have the correct Node.js version installed
- Try deleting the `node_modules` folder and running `npm install` again
- Check the console output for specific error messages

## Extending the Application

The application is designed to be modular and extensible. To add new features:

1. Create new components in the `src/components` directory
2. Add new database models in `src/backend/models`
3. Implement service functions in `src/backend/services`
4. Update the main UI in `src/App.js` to include your new features

## License

This application is provided for educational and personal use.

## Support

For support or questions, please contact the developer.
