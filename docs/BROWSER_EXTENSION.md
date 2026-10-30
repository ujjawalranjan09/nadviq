# Nanobrowser: Chrome Extension Deep Dive

The **Nanobrowser** extension is a Manifest V3 Chromium extension built using the [WXT](https://wxt.dev) framework, React 18, and TypeScript. It lives directly inside the browser engine, giving the AI agent high-speed control over web navigation, DOM parsing, and tab manipulation.

---

## 1. Directory Structure

```text
nanobrowser/
├── entrypoints/
│   ├── background.ts          # Manifest V3 service worker entrypoint
│   ├── options/               # Extension options page
│   ├── sidepanel/             # Chrome side-panel UI
│   └── welcome/               # Onboarding page
├── fixtures/                  # Test suites, local HTTP fixture server
├── src/
│   ├── agent/                 # Agent loop, compaction, elision, context builder
│   │   ├── compaction.ts      # Automatic conversation history compaction
│   │   ├── context.ts         # Assembles system prompt, attachments, DOM state
│   │   ├── elision.ts         # Elides large tool results to fit token window
│   │   ├── loop.ts            # Core autonomous step-by-step agent loop
│   │   └── tools.ts           # Tool definitions exposed to LLM
│   ├── background/            # Background service worker state
│   ├── browser-control/       # DOM perception, action execution, accessibility tree
│   │   ├── core/              # Controller, element refs, security policy
│   │   │   ├── controller.ts  # Browser controller coordinating tools & probe
│   │   │   ├── refs.ts        # Numeric element reference map (e.g. [42])
│   │   │   ├── redact.ts      # Redaction of sensitive fields (credit cards, passwords)
│   │   │   └── url-policy.ts  # URL restriction guard (blocks chrome://, file://)
│   │   └── tools/             # Specific tools: act, observe, fill, text, tabs, etc.
│   ├── extension/             # Extension glue logic
│   │   ├── desktop-bridge.ts  # WebSocket bridge to Instruction Desk
│   │   ├── run-manager.ts     # Task queue, connection registry, tab groups
│   │   └── prompt-broker.ts   # Interactive prompt resolution
│   ├── llm/                   # AI SDK connectors & key rotation
│   │   ├── providers.ts       # Gemini, Anthropic, OpenAI, Ollama providers
│   │   └── rotating-fetch.ts  # Token normalization, 429 backoff, key rotation
│   ├── store/                 # Persistent storage
│   │   ├── conversations.ts   # IndexedDB message history & blob attachments
│   │   └── settings.ts        # WXT persistent extension settings
│   └── ui/                    # Shared protocol schemas, theme, icons
├── package.json
└── wxt.config.ts              # WXT build configuration & manifest declaration
```

---

## 2. Desktop Bridge (`desktop-bridge.ts`)

The desktop bridge links the browser extension's service worker to the Electron app over WebSocket:
- **Automatic Initialization**: On extension startup, `desktop-bridge.ts` establishes a WebSocket connection to `ws://127.0.0.1:8765`.
- **Panel Connection Mock**: Implements the `PanelConnection` interface expected by `RunManager`. All events that would normally render to the Chrome sidepanel are seamlessly piped to the desktop app.
- **Attachment Ingestion**: Ingests Base64 or plain-text files received from the desktop, writing them directly into the extension's IndexedDB blob storage (`putBlob`), making them immediately accessible to agent tools (`upload`, `context`).
- **Tab Synchronization**: Emits real-time tab list updates to the desktop app on `chrome.tabs.onUpdated`, `chrome.tabs.onCreated`, and `chrome.tabs.onRemoved`.
- **Keepalive Heartbeat**: Sends a `{ type: 'ping' }` frame every 20 seconds to prevent Chromium from putting the background service worker into suspended state during long idle tasks.

---

## 3. Run Manager (`run-manager.ts`)

The `RunManager` acts as the execution coordinator:
- **Tab Isolation**: Associates runs with specific Chrome tabs or tab groups.
- **Session Multiplexing**: Tracks concurrent conversation IDs and handles graceful cancellation when a `stop` command is received.
- **Permission Checking**: Consults site permissions before executing actions. If a site has custom rules (e.g. `Ask` or `Block`), it prompts the user or halts execution.

---

## 4. DOM Perception & Element Ref System

Modern websites feature thousands of DOM nodes. Feeding raw HTML into an LLM exhausts the token budget and confuses reasoning. Nanobrowser solves this with an intelligent element reference pipeline:

1. **Accessibility & Interactive Tree**: The probe inspects the DOM, selecting only interactive elements (buttons, inputs, links, dropdowns, contenteditable elements) and semantic containers.
2. **Numeric Ref Assignment**: Every interactive element is tagged with a temporary numeric reference ID (e.g., `42 -> <button id="submit">`).
3. **Bounding Box Calculation**: Calculates the physical coordinate rectangle of each element relative to the viewport.
4. **Visibility & Occlusion Filtering**: Elements with `display: none`, `visibility: hidden`, opacity 0, or covered by modals are pruned.
5. **Redaction**: Fields marked as password inputs or sensitive identifiers are redacted before the observation snapshot reaches the LLM.

---

## 5. Security & Safety Architecture

- **Restricted URL Policy**: The agent is strictly prevented from navigating to sensitive browser internal pages, including `chrome://`, `chrome-extension://`, `about:flags`, or local `file:///` URLs.
- **Password & Payment Protection**: Form inputs identified as passwords (`type="password"`) or payment fields (credit card number, CVV) cannot be auto-filled without explicit user permission.
- **Prompt Injection Defense**: Text extracted from web pages is encapsulated inside fenced blocks marked explicitly as untrusted observation data in the system prompt. The model is instructed to never follow instructions embedded in web page content.
