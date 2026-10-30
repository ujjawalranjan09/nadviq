# Nanobrowser — overview

Nanobrowser is an open-source AI web-automation Chrome extension. You give it a task in a side panel; it reads pages, clicks, types, scrolls, and moves between tabs, and it asks before it submits, sends, deletes, pays, or uploads anything.

Version in this checkout: **0.3.0** (Apache-2.0).

## Two parts

The repository is built around a clean split:

1. **Browser control layer** — `src/browser-control/`
   A deterministic layer that observes a page, acts on it, and reports what happened. It has no LLM in it: the same inputs give the same outputs. The extension’s own agent calls it in-process.

2. **Extension** — entrypoints + `src/extension/`, `src/agent/`, `src/llm/`, `src/ui/`, `src/side-panel/`, `src/options/`
   The side panel, the one agent loop, model providers, settings, permissions, attachments, downloads, i18n, theme, and the surrounding product features.

The layer is the controlled bit. The agent is the part that needs an LLM.

## Browser control layer

The layer is the interesting engine. Its job is to give the agent a reliable, auditable way to work on a real page without guessing.

### What the layer owns

- **Sessions** — an agent’s working context. A session holds tabs, its known refs, its policy, and its confirmation behavior.
- **Refs** — durable labels for elements. A ref ties an element to `(session, frame, document, node)` so a later action can target the exact element the agent was shown, not “whatever matches this selector now.”
- **Perception** — reading the page into an outline and screenshots. Observation is read-only.
- **Interaction** — resolving a target, revalidating it, checking actionability, then dispatching input.
- **Policy / safety** — URL allow/deny and blocked-site rules, confirmation for sensitive actions, and hand-over protection for secrets and payments.

### How it talks to Chrome

The only way the layer reaches the browser is **Chrome’s `chrome.debugger` API**, and it uses **Puppeteer only as a frame manager**.

Key points:

- Puppeteer is used to detect frames (including out-of-process iframes) and to track frame sessions and navigation.
- Elements are **never** found through Puppeteer. No selectors, no `ElementHandle` clicks, no selector-based `evaluate`.
- Element commands are raw CDP commands sent to the session Puppeteer reports for that frame.

That keeps the layer deterministic and independent of Puppeteer’s element model.

### Probes

For page-side behavior that CDP alone does not give cleanly — element state, form facts, hit testing, geometry, labels, and so on — the layer injects small **probe code** into an isolated world per frame/document.

- One probe world per frame/document.
- The probe is the layer’s only in-page code.
- It is built to a string constant and installed into an isolated world, not into the page’s own scripts.

### What a session can and cannot do

A session is configured by the host (the extension), never by the agent protocol:

- **Permissions are user-controlled.** Reading and moving never ask. Suspected writes (submit/send/delete/upload) ask in Ask mode, the default, and run in Auto mode or on an Allow site. Payments, access grants, secret input, and page `prompt()` dialogs are the user’s step in every mode.
- **Page script and `devtools` are not given to agent sessions.**
- **Conversations are compacted automatically** before the context window fills, and the user’s own messages are kept in full.

### Deterministic invariants

The layer is designed so that actions are traceable and fail in predictable ways:

- An action operates on the node the agent was shown, addressed by the browser’s handle for it.
- A ref is valid only for the document it was seen in and only if the agent was shown it; otherwise it is a typed error, not a guess.
- Retries happen **before** dispatch. Once an input event is sent, the layer does not send another on its own.
- There are three reported outcomes, separately: input dispatched, page reacted, expected state reached.
- Observation is read-only.
- Anything bounded is bounded: commands, waits, lists.
- State is disposable: a service worker restart, debugger detach, or navigation invalidates layer state cleanly.

## Toolset the layer exposes

The layer exposes a fixed set of tools through `src/browser-control/core/tools/index.ts`. The main groups are:

- **Observe:** `snapshot`, `find`, `read`, `screenshot`
- **Tabs / navigation:** `tabs`, `navigate`
- **Interact:** `click`, `hover`, `scroll`, `press`, `set`, `type`, `wait`, `handle_dialog`
- **Agent-facing conveniences / safety:** `ask_user`, `fill_form`, `upload`

The controller is created for Chrome through `createChromeController(...)` in `src/browser-control/index.ts`, which wires `chrome.debugger`, `chrome.tabs`, and `chrome.storage`.

## What happens when the agent acts

A good way to understand the whole thing is a single action path. For example, “click the thing labeled X.”

### 1. Agent decides and calls the layer

The agent (in the side panel, in-process) decides it wants to click something and calls the layer with a tool + args, often using a ref it was shown earlier.

### 2. Session receives the call

The session validates the tool and arguments, resolves which tab the call applies to, checks site policy for that tab, and rejects early if there is a pending modal or confirmation on that tab.

### 3. Target resolution

The layer resolves the target to a specific node in a specific frame/document. This is where refs matter: the call should target the exact node the agent was shown.

### 4. Revalidation and actionability

Before anything is sent, the layer re-checks the target:

- Is it still the element the session was shown?
- Is it visible, enabled, stable, and in the viewport?
- For pointer actions, it also checks what would actually receive the click at that point (coverings, nested controls).

All retries in this stage happen **before dispatch**, not after.

### 5. Confirmation gate, if needed

If the action is classified as submit / pay / delete (or is otherwise sensitive), the gate stops and asks the user through the extension, unless policy says otherwise.

- Payments, access grants, secret fields, and page `prompt()` dialogs are the user’s step regardless of mode.
- The extension enforces this; the agent cannot turn it off.

### 6. Dispatch

If everything passes, the layer sends the real input through CDP to the frame’s session. Input is real browser input, not page script.

### 7. Page reaction + expected state

After dispatch, the layer tries to observe the result it expected. If it cannot read the page state, the result still includes the receipt saying what was dispatched; the page-state failure is reported separately.

### 8. Result back to agent

The agent receives a structured result: ok/error, receipt, page state, text, and notices. That is what the agent reasons on next.

## Safety model

The safety model is built around user control and explicit sensitive-action handling:

- **Ask is the default.** Writes ask; Auto mode and Allow sites run without asking.
- **Some things are always the user’s step:** payments, access grants, secret input, and page prompt dialogs.
- **Detection is best-effort; enforcement is strict.** If the layer thinks an action is sensitive, it asks; if it cannot decide, it does not silently do dangerous things.
- **Page content is data, not instructions.** Text from pages is passed to the model inside marked boundaries.
- **Secrets are masked.** Sensitive field values are masked in observations, screenshots, and logs.

Navigation policy also has multiple layers:

- Pre-check before navigation is attempted.
- Network-level blocking for configured lists when the debugger is attached.
- Post-commit detection for cases where the request could not be intercepted.

## Architecture diagram

```
User task
   │
   ▼
Side panel (React)
   │
   ▼
Agent loop (one per conversation)
   │  LLM chooses tool + args
   │
   ▼
Browser control layer (deterministic, in-process)
   │
   ├── Session
   │     ├── tabs
   │     ├── known refs
   │     ├── policy (URL allow/deny, blocked sites)
   │     └── confirmation / hand-over rules
   │
   ├── Ref registry
   │     └── labels tied to (session, frame, document, node)
   │
   ├── Perception
   │     ├── CDP accessibility tree (tier 1)
   │     ├── DOM snapshot layout (tier 2)
   │     ├── Outline / refs / masking
   │     └── Screenshots
   │
   ├── Interaction
   │     ├── resolve target
   │     ├── revalidate
   │     ├── actionability checks (retry before dispatch)
   │     ├── hit testing / coverings
   │     └── dispatch CDP input
   │
   ├── Confirmation gate
   │     └── submit / pay / delete / grant / secret / prompt handling
   │
   ├── Navigation policy
   │     ├── pre-check
   │     ├── Fetch interception (layer 3)
   │     └── post-commit detection (layer 4)
   │
   └── Probes
         └── isolated worlds for page-side facts CDP does not give directly
   │
   ▼
Chrome host
   │
   ├── chrome.debugger  (only CDP path)
   ├── Puppeteer         (frame manager only)
   └── chrome.tabs / chrome.storage
   │
   ▼
Real page in Chrome (real clicks, real typing, real navigation)
```

## Extension product layer

Above the control layer, the extension adds the user-facing product:

- Side panel chat UI
- One agent loop per conversation
- Model providers through the Vercel AI SDK: Anthropic, OpenAI, Google Gemini, OpenRouter, xAI Grok, DeepSeek, Mistral, and any OpenAI-compatible endpoint
- Local models via Ollama, LM Studio, and similar through the OpenAI-compatible provider
- Vision models can take screenshots and read attached images
- Permissions, modes, and per-site rules
- Shortcuts, attachments, uploads into pages, saved files, voice input, chat history, memory-like prompts, i18n (English, Simplified Chinese, Traditional Chinese), theme, and an indicator border on pages the agent works on

## Toolchain

- Node 24 LTS, pnpm 10.34.7 (pinned in `packageManager`)
- WXT 0.21.4
- TypeScript 6.0.3
- Vitest 5.0.4
- puppeteer-core ^25.13.0
- zod 4.6.7
- React 18.3.1

Common commands from `package.json`:

- `pnpm install` — install dependencies (`wxt prepare` runs too)
- `pnpm dev` — WXT development mode; load `dist/` unpacked in Chrome
- `pnpm build` — build the extension into `dist/`
- `pnpm zip` — release zip into `dist-zip/`
- `pnpm type-check` — TypeScript check
- `pnpm lint` — ESLint with the import rules
- `pnpm test` — unit tests
- `pnpm fixtures` — fixture server on port 8787
- `pnpm install-chrome` — install Chrome for Testing
- `pnpm autorun` — run automated browser checks against fixture pages

## Where to look next

If you want to understand a specific piece, these are the natural entry points:

- `src/browser-control/index.ts` — the layer’s public entry
- `src/browser-control/core/controller.ts` — sessions, dispatch, audit
- `src/browser-control/core/ports.ts` — the host interfaces the core uses
- `src/browser-control/core/refs.ts` — ref identity and staleness
- `src/browser-control/core/perception/capture.ts` — accessibility + layout capture
- `src/browser-control/core/perception/outline.ts` — outline, refs, masking
- `src/browser-control/core/interaction/classify.ts` — sensitive-action classification
- `src/browser-control/core/interaction/gate.ts` — confirmation gate
- `src/browser-control/core/interaction/actionability.ts` — pre-dispatch checks
- `src/browser-control/core/navigation-guard.ts` — navigation policy layers 3 and 4
- `src/browser-control/host/chrome-host.ts` — `chrome.tabs` / `chrome.storage` adapters
- `src/browser-control/host/frame-topology.ts` — Puppeteer frame adapter
- `src/browser-control/host/cdp-session.ts` — raw CDP through `chrome.debugger`
- `src/agent/`, `src/llm/`, `src/extension/`, `src/side-panel/`, `src/ui/`, `src/options/` — the extension around the layer
