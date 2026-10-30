# NaviQ Instruction Desk (Electron Desktop Application)

The **Instruction Desk** is the desktop companion and control interface for NaviQ. It manages the lifecycle of the browser, coordinates user instructions, provides voice recognition with Gemini audio transcription, and visualizes real-time agent execution telemetry.

---

## 🎯 Core Capabilities

1. **Autonomous Chrome Launcher (`browser.mjs`)**:
   - Automatically discovers Chrome across Windows, macOS, and Linux.
   - Launches Chrome with the unpacked NaviQ extension (`--load-extension=../nanobrowser/dist`).
   - Supports switching between clean isolated browser profiles and cloned user profiles (preserving bookmarks, search engines, and user preferences).
2. **WebSocket Bridge Gateway (`main.mjs`)**:
   - Hosts a local WebSocket server at `ws://127.0.0.1:8765`.
   - Synchronizes provider settings and API keys to the browser extension.
   - Delivers real-time execution events (tool calls, arguments, status updates, notifications, and prompts) to the UI.
3. **Voice Command System**:
   - Direct audio recording with WebSpeech fallback.
   - High-precision transcription via Google Gemini audio models (`gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-2.5-flash`).
4. **Multimodal File Attachments**:
   - Ingests text documents, CSVs, markdown files, and images.
   - Encodes and streams them to the browser extension's IndexedDB blob storage for agent inspection or web form uploading.
5. **Interactive Safety Prompts**:
   - Displays approval prompts when the agent requests permission to execute potentially destructive actions (submitting forms, sending messages, deleting data).
   - Allows users to approve, reject, or enable auto-approval.

---

## 🏗️ Technical Architecture

### Process Split
- **Main Process (`main.mjs`)**:
  - Manages Electron app lifecycle and `BrowserWindow`.
  - Runs the WebSocket server on port `8765`.
  - Interfaces with Puppeteer for launching Chrome.
  - Handles disk persistence (`userData/naviq-store.json`).
  - Calls Gemini API directly for audio transcription.
- **Preload Script (`preload.cjs`)**:
  - Securely exposes the `window.agent` API to the renderer via `contextBridge`.
- **Renderer Process (`renderer.js`, `index.html`)**:
  - Modern, responsive dark UI styled with custom CSS.
  - Chat stream rendering with Markdown and syntax highlighting.
  - Tool execution badges and interactive prompt handling.
  - Active tab selector and model switcher.

---

## 🔌 IPC Interface (`window.agent`)

The renderer communicates with the main process through the following asynchronous APIs exposed in `preload.cjs`:

| Method | Parameters | Description |
| :--- | :--- | :--- |
| `run` | `(text, settings, tabId, attachments)` | Dispatches a new automation task to the browser extension. |
| `stop` | `()` | Sends an immediate halt signal to cancel active agent tasks. |
| `answer` | `(promptId, answer)` | Responds to an agent confirmation prompt (Allow/Deny). |
| `newChat` | `()` | Resets active conversation ID for a clean chat session. |
| `launchBrowser` | `(profileId)` | Launches Chrome with the selected profile. |
| `getChromeProfiles` | `()` | Discovers available system Chrome profiles from `Local State`. |
| `getActiveChromeProfile` | `()` | Returns the currently active profile identifier. |
| `syncSettings` | `(settings)` | Pushes current model settings and API keys to the extension. |
| `transcribeAudio` | `({ base64Audio, mimeType, settings })` | Sends recorded voice audio to Gemini for speech-to-text. |
| `getStorage` / `setStorage` | `(key, value)` | Reads/writes persistent settings in the app's `userData` store. |
| `onEvent` | `(callback)` | Listens for streaming agent events dispatched from the extension. |

---

## 💻 Development & Execution

### Prerequisites
- Node.js v20+
- The `nanobrowser` extension must be built first (`cd ../nanobrowser && pnpm build`).

### Commands

```bash
# Install dependencies
pnpm install

# Start the Electron application
pnpm start
```

---

## ⚙️ Configuration File

Settings and active profiles are stored in JSON format at:
- **Windows**: `%APPDATA%\NaviQ\naviq-store.json`
- **macOS**: `~/Library/Application Support/NaviQ/naviq-store.json`
- **Linux**: `~/.config/NaviQ/naviq-store.json`
