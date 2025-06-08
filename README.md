# Reaper

Reaper is a versatile desktop application built with Electron, designed for personal knowledge management and note-taking. It empowers users to capture, organize, and connect their thoughts and ideas in various formats.

## Key Features

*   **Multiple Note Types:** Reaper supports a wide range of note formats to suit different needs:
    *   **Simple Notes:** For quick rich-text notes and ideas.
    *   **Markdown Notes:** For structured text documents with Markdown formatting, including support for backlinks to link related notes.
    *   **Block Workspace:** A flexible block-based editor (similar to Notion or Logseq) for creating complex documents and layouts.
    *   **Drawing Canvas:** For sketching diagrams, mind maps, or visual notes.
    *   **Voice Memos:** For capturing audio notes and thoughts on the go.

*   **Organizational Tools:** Keep your knowledge base structured and accessible:
    *   **Folders:** Organize notes into hierarchical folders.
    *   **Workspaces:** Create distinct workspaces to manage different projects or areas of focus.
    *   **Tags:** Apply tags to notes for flexible categorization and quick filtering.

*   **Knowledge Graph:** Visualize the connections and relationships between your notes through an interactive knowledge graph. This helps in discovering new insights and understanding the bigger picture.

*   **Cross-Platform:** Being an Electron application, Reaper can potentially run on Windows, macOS, and Linux.

*   **Enhanced Content Capabilities:**
    *   **Note Templates:**
        *   Create reusable templates from your notes. Mark any note as a template to quickly generate new notes with pre-filled content.
        *   Use dynamic placeholders like \`{{date:YYYY-MM-DD}}\`, \`{{time:HH:MM}}\`, \`{{uuid}}\`, and \`{{cursor}}\` within your templates.
    *   **LaTeX/Math Support:**
        *   Seamlessly embed mathematical formulas and equations using LaTeX.
        *   Supports inline math with \`$E=mc^2$ \` and block math with \`$$ \\frac{a}{b} $$\`.
        *   Powered by KaTeX for fast and accurate rendering within Markdown notes.
    *   **Enhanced Code Blocks (Markdown):**
        *   Enjoy rich syntax highlighting for a wide variety of programming languages within your Markdown code fences.
        *   Code blocks now feature line numbers for easy reference.
        *   A convenient "Copy" button allows you to quickly copy code snippets.
        *   Powered by Prism.js.
    *   **Video Embedding (Markdown):**
        *   Easily embed videos from YouTube and Vimeo directly into your Markdown notes.
        *   Simply paste the video URL on its own line, and it will be rendered using an embedded player.

*   **Time-Based Organization & Reminders:**
    *   **Daily Notes & Journaling:**
        *   Supports daily note-taking, typically identified by a title like "Journal YYYY-MM-DD".
        *   (Planned UI Feature) Automatic creation of a "Today" note can be configured, potentially using a custom "Daily Note Template".
        *   (Planned UI Feature) A dedicated Journal view with a calendar will allow easy navigation and access to your daily entries.
    *   **Note Reminders (MVP):**
        *   Set a specific date and time for a reminder on any note.
        *   Receive a local desktop notification when a reminder is due.
        *   (Planned UI Feature) Clicking a notification will navigate you directly to the relevant note.
        *   Currently, reminders are one-time and will be cleared after triggering.

## Technology Stack

*   **Frontend:** React
*   **Backend/Desktop Framework:** Electron
*   **Database:** SQLite (via `better-sqlite3`)
*   **Key Libraries:**
    *   `Quill` / `react-quill` for rich text editing.
    *   `react-markdown` for Markdown rendering.
    *   `react-force-graph` for the knowledge graph visualization.
    *   And various other libraries for UI components and specific functionalities.

### Database

*   **Type:** SQLite
*   **File:** The application uses a SQLite database stored in the file \`database.sqlite\`, located in the root directory of the project.
*   **Initialization:** This database file is automatically created and its schema is initialized by the application on its first run if the file does not already exist.

## Getting Started

Follow these instructions to get Reaper up and running on your local machine for development and testing purposes.

### Prerequisites

*   **Node.js:** Make sure you have Node.js installed. You can download it from [nodejs.org](https://nodejs.org/). npm (Node Package Manager) is included with Node.js.
*   **Git:** You'll need Git to clone the repository. You can get it from [git-scm.com](https://git-scm.com/).
*   **Electron (Optional Global Install):** While the project will use a local version of Electron via npm, you might find it useful to have Electron installed globally for easier command-line use in some cases: `npm install -g electron`. This is not strictly required to run the project.

### Installation & Running

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/reaper-app.git
    cd reaper
    ```

2.  **Install dependencies:**
    This project uses npm to manage dependencies.
    ```bash
    npm install
    ```

3.  **Run the application:**
    This command will start the Electron application.
    ```bash
    electron .
    ```
    The SQLite database (`database.sqlite` in the project root, as per `db.js`) will be automatically initialized on the first run if it doesn't exist.

## Contributing

Contributions are welcome! If you'd like to help improve Reaper, please follow these guidelines.

### Reporting Bugs

*   If you find a bug, please check the existing GitHub Issues to see if it has already been reported.
*   If not, create a new issue. Provide a clear title, a detailed description of the bug, steps to reproduce it, and information about your environment (OS, Reaper version if applicable).

### Suggesting Enhancements

*   If you have an idea for a new feature or an improvement to an existing one, feel free to open a new GitHub Issue.
*   Describe your idea clearly, explaining the problem it solves or the value it adds.

### Development Setup

1.  Follow the instructions in the **Getting Started** section to set up the project locally.
2.  Ensure you can run the application and all tests pass.

### Running Tests

This project uses Jest for automated testing. To run the tests:
```bash
npm test
```
To run tests for a specific file:
```bash
npm test path/to/your/testfile.test.js
```
Make sure all tests pass before submitting any changes.

### Pull Request Process

1.  **Fork the repository** on GitHub.
2.  **Create a new branch** for your feature or bug fix:
    ```bash
    git checkout -b feature/your-feature-name
    # or
    # git checkout -b fix/your-bug-fix-name
    ```
3.  **Make your changes.** Adhere to the existing code style as much as possible.
4.  **Test your changes thoroughly.** Add new tests if you're introducing new functionality. Ensure all existing and new tests pass.
5.  **Commit your changes** with a clear and descriptive commit message.
6.  **Push your branch** to your forked repository:
    ```bash
    git push origin your-branch-name
    ```
7.  **Open a Pull Request** against the main Reaper repository. Provide a clear description of your changes in the PR.
