# Developer & Testing Guide

This guide details how to set up the development environment, build both subsystems, execute automated test suites, and debug NaviQ.

---

## 1. Prerequisites

- **Node.js**: `v20.0.0` or higher (Node.js 24 recommended).
- **pnpm**: Version 9 or 10.
- **Operating System**: Windows 10/11, macOS 12+, or Ubuntu 22.04+.
- **Chrome**: Installed Google Chrome browser.

---

## 2. Setting Up the Workspace

Clone the repository and install dependencies for each package:

```bash
# 1. Install nanobrowser extension dependencies
cd nanobrowser
pnpm install

# 2. Build the extension bundle
pnpm build

# 3. Install desktop desk dependencies
cd ../instruction-desk
pnpm install
```

---

## 3. Development Workflow

### Running the Extension in Development Mode
To develop on the extension with hot reloading:
```bash
cd nanobrowser
pnpm dev
```
WXT will start a dev server and launch a clean test browser instance with the extension loaded.

### Running the Full End-to-End System
To test the complete integration between the desktop app and the extension:
1. Ensure the extension is built:
   ```bash
   cd nanobrowser
   pnpm build
   ```
2. Start the Instruction Desk:
   ```bash
   cd ../instruction-desk
   pnpm start
   ```
The desktop app will launch and automatically spawn Chrome with the unpacked extension loaded from `../nanobrowser/dist`.

---

## 4. Testing & Verification

### Unit & Integration Tests (Vitest)
Nanobrowser includes test coverage for DOM perception, tool schemas, context compaction, and rotating fetch:

```bash
cd nanobrowser
pnpm test
```

### Type Checking & Linting
Validate TypeScript contracts and formatting:

```bash
# Type check
pnpm type-check

# Lint check
pnpm lint

# Format with prettier
pnpm prettier
```

### Local Fixture Server
Nanobrowser includes an offline test server to verify web automation without network requests:

```bash
cd nanobrowser
pnpm fixtures
```
Spawns a local test server at `http://localhost:3000` hosting complex forms, dynamic dropdowns, file upload inputs, and simulated delayed responses.

---

## 5. Debugging Techniques

### Inspecting the Desktop App
- Launch with devtools enabled by setting the environment flag or pressing `Ctrl+Shift+I` / `Cmd+Option+I` within the Electron window.
- Check stdout/stderr in your terminal for main process logs and WebSocket connection states.

### Inspecting the Browser Extension
1. In the launched Chrome instance, open `chrome://extensions`.
2. Enable **Developer mode** in the top right.
3. Locate **NaviQ** and click `service worker` under **Inspect views**.
4. Check the Console tab for `[desktop-bridge]`, `[run-manager]`, and `[loop]` logs.

### WebSocket Traffic Monitoring
The bridge communicates on `ws://127.0.0.1:8765`. You can verify incoming and outgoing frames using any WebSocket inspection client or in Chrome DevTools under the **Network** tab (filter by `WS`).
