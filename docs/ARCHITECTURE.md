# System Architecture & Protocol Specification

## 1. Architectural Overview

NaviQ combines an Electron desktop application (**Instruction Desk**) and a Manifest V3 Chromium Extension (**Nanobrowser**). The architecture decouples the user interaction environment from the browser execution runtime, communicating over a local WebSocket channel.

```
+-----------------------------------------------------------------------------------+
|                           Instruction Desk (Electron)                             |
|                                                                                   |
|  +--------------------+       IPC       +--------------------------------------+  |
|  |  Renderer Process  | <-------------> |             Main Process             |  |
|  |  - Chat & Voice UI |                 |  - Session Lifecycle & Store         |  |
|  |  - Markdown Stream |                 |  - Puppeteer Chrome Launcher         |  |
|  |  - Tool Telemetry  |                 |  - Gemini Audio Transcription        |  |
|  +--------------------+                 |  - WebSocket Server (127.0.0.1:8765) |  |
|                                         +-------------------+------------------+  |
+-------------------------------------------------------------|---------------------+
                                                              |  WebSocket (JSON)
                                                              v
+-----------------------------------------------------------------------------------+
|                        Google Chrome Browser Instance                             |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  |                   Nanobrowser Extension (Service Worker)                    |  |
|  |                                                                             |  |
|  |  +----------------------+      +------------------+      +---------------+  |  |
|  |  | Desktop Bridge       | <--> | Run Manager      | <--> | Agent Loop    |  |  |
|  |  | (desktop-bridge.ts)  |      | (run-manager.ts) |      | (loop.ts)     |  |  |
|  |  +----------------------+      +------------------+      +-------+-------+  |  |
|  |                                                                  |          |  |
|  |  +----------------------+      +------------------+              |          |  |
|  |  | Storage & IndexedDB  |      | Rotating Fetch   | <------------+          |  |
|  |  | (conversations/blobs)|      | & Model Failover |                         |  |
|  |  +----------------------+      +------------------+                         |  |
|  +------------------------------------------------------------------|----------+  |
|                                                                     v             |
|  +-----------------------------------------------------------------------------+  |
|  |                   Browser Control & Content Scripts                         |  |
|  |  - DOM Perception & Accessibility Tree (observe)                            |  |
|  |  - User Interaction Emulation (act, fill, navigate, text)                   |  |
|  |  - Human-in-the-Loop Prompts & Safety Guardrails                            |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## 2. Process Separation & Responsibilities

### Electron Main Process (`instruction-desk/main.mjs`)
- **WebSocket Server**: Binds to `127.0.0.1:8765`. Accepts connections exclusively from the local Nanobrowser extension.
- **Chrome Lifecycle**: Uses Puppeteer-Core to launch and monitor Chrome processes. Manages user data directory routing and profile seeding.
- **Multimodal Audio Processing**: Transcribes voice commands directly using Google Gemini's REST API, handling audio compression and model fallbacks.
- **Disk Persistence**: Stores desktop settings, chosen profiles, and recent configurations in `naviq-store.json`.

### Electron Renderer Process (`instruction-desk/renderer.js`)
- Renders the interactive terminal and chat interface.
- Records voice via `MediaRecorder` or WebSpeech API.
- Converts file attachments to Base64/text representations.
- Listens for real-time streaming events and updates UI states (active tools, error banners, confirmation dialogs).

### Browser Extension Background Worker (`nanobrowser/src/extension/`)
- Maintains an open WebSocket connection with `127.0.0.1:8765`.
- Implements the `PanelConnection` interface expected by `RunManager`.
- Executes the autonomous agent loop, calling tools, querying the LLM, and handling error recovery.
- Maintains IndexedDB tables for messages, conversations, and attachment blobs.

---

## 3. WebSocket Protocol Specification (`ws://127.0.0.1:8765`)

All payloads are serialized as JSON objects.

### 3.1. Desktop to Extension Messages

#### `sync-settings`
Pushes LLM provider credentials and configurations into the extension:
```json
{
  "type": "sync-settings",
  "settings": {
    "provider": "gemini",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
    "apiKeys": ["AIzaSy...", "AIzaSy..."],
    "model": "gemini-3.1-flash-lite",
    "fallbackModel": "gemini-3.5-flash-lite",
    "models": ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]
  }
}
```

#### `command` (`send`)
Dispatches a new prompt or instruction for execution:
```json
{
  "type": "command",
  "command": {
    "type": "send",
    "tabId": 12345,
    "conversationId": "sess_1730398000_abc",
    "text": "Go to amazon.com and find the best rated USB-C hub",
    "attachments": [],
    "attachmentsData": [
      {
        "id": "att_1",
        "name": "specs.txt",
        "mimeType": "text/plain",
        "size": 128,
        "dataText": "Must have HDMI 2.1 and 100W PD"
      }
    ],
    "mode": "ask",
    "reasoning": "medium"
  }
}
```

#### `command` (`stop`)
Cancels the running agent task:
```json
{
  "type": "command",
  "command": {
    "type": "stop",
    "conversationId": "sess_1730398000_abc"
  }
}
```

#### `command` (`answer`)
Resolves an interactive human-in-the-loop permission prompt:
```json
{
  "type": "command",
  "command": {
    "type": "answer",
    "promptId": "prm_98765",
    "answer": "allow"
  }
}
```

---

### 3.2. Extension to Desktop Messages

#### `status`
Transmits the current connection state and list of open browser tabs:
```json
{
  "type": "status",
  "status": "connected",
  "tabs": [
    {
      "id": 101,
      "title": "Google",
      "url": "https://www.google.com",
      "active": true
    }
  ]
}
```

#### `event` (Tool Execution Start)
Notifies the desktop that a specific tool is being executed:
```json
{
  "type": "event",
  "event": {
    "type": "tool_execution_start",
    "conversationId": "sess_1730398000_abc",
    "row": {
      "tool": "act",
      "args": { "action": "click", "ref": 42 }
    }
  }
}
```

#### `event` (Tool Execution End)
Reports tool completion or failure:
```json
{
  "type": "event",
  "event": {
    "type": "tool_execution_end",
    "conversationId": "sess_1730398000_abc",
    "row": {
      "tool": "act",
      "status": "completed",
      "result": "Clicked element 42 (<button type='submit'>)"
    }
  }
}
```

#### `event` (Message Update / Streaming)
Streams partial LLM completion tokens to the UI:
```json
{
  "type": "event",
  "event": {
    "type": "message_update",
    "id": "msg_001",
    "text": "I am searching for the requested product now..."
  }
}
```

#### `event` (Prompt Open)
Asks the user for approval before continuing:
```json
{
  "type": "event",
  "event": {
    "type": "prompt_open",
    "prompt": {
      "id": "prm_98765",
      "title": "Confirm Form Submission",
      "message": "The agent is about to submit the checkout form with total $49.99.",
      "type": "confirm",
      "options": ["allow", "deny"]
    }
  }
}
```

---

## 4. Lifecycle & Failure Handling

1. **Service Worker Inactivity**: Chrome Manifest V3 service workers terminate after idling. The desktop bridge issues a periodic `ping` every 20 seconds to keep the connection warm while an active session exists.
2. **Reconnection Strategy**: If the WebSocket drops, the bridge attempts automatic reconnection with a 2000ms backoff interval.
3. **Graceful Teardown**: Closing the Instruction Desk automatically closes child Chrome instances created by Puppeteer and cleans up temporary handles.
