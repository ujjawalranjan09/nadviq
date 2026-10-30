import { app, BrowserWindow, ipcMain, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { launchBrowserWithExtension, closeBrowser, getChromeProfiles, getActiveProfileId } from './browser.mjs';

app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-features', 'WebSpeechAPI');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let extWs = null;
let activeConversationId = null;

// Persistent file-based store in userData directory
const storeFile = path.join(app.getPath('userData'), 'naviq-store.json');

function readStore() {
  try {
    if (fs.existsSync(storeFile)) {
      return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    }
  } catch (err) {
    console.error('[main] store read error:', err);
  }
  return {};
}

function writeStore(data) {
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[main] store write error:', err);
  }
}

const wss = new WebSocketServer({ port: 8765, host: '127.0.0.1' });

wss.on('connection', (ws) => {
  extWs = ws;
  sendToUi({ type: 'browser-status', status: 'connected' });

  // Immediately push desktop settings into the extension so extension is pre-configured
  const store = readStore();
  if (store.settings) {
    ws.send(JSON.stringify({ type: 'sync-settings', settings: store.settings }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'status') {
        sendToUi({ type: 'browser-status', status: 'connected', tabs: msg.tabs });
      } else if (msg.type === 'event' && msg.event) {
        handleNanobrowserEvent(msg.event);
      }
    } catch (err) {
      console.error('[main] failed to parse message from extension', err);
    }
  });

  ws.on('close', () => {
    if (extWs === ws) {
      extWs = null;
      sendToUi({ type: 'browser-status', status: 'disconnected' });
    }
  });
});

function sendToUi(ev) {
  if (win && !win.isDestroyed()) win.webContents.send('agent-event', ev);
}

function handleNanobrowserEvent(ev) {
  if (ev.conversationId) activeConversationId = ev.conversationId;

  switch (ev.type) {
    case 'tool_execution_start':
      sendToUi({ type: 'tool', name: ev.row?.tool, args: ev.row?.args });
      break;
    case 'tool_execution_end':
      if (ev.row?.status === 'failed') {
        sendToUi({ type: 'tool-result', name: ev.row?.tool, result: { ok: false, error: ev.row?.result || ev.row?.text || 'Tool failed' } });
      } else {
        sendToUi({ type: 'tool-result', name: ev.row?.tool, result: { ok: true, result: ev.row?.result || ev.row?.text } });
      }
      break;
    case 'message_update':
      sendToUi({ type: 'streaming', id: ev.id, text: ev.text });
      break;
    case 'message_end':
      if (ev.entry?.kind === 'assistant') {
        sendToUi({ type: 'assistant', text: ev.entry.text });
      } else if (ev.entry?.kind === 'notice') {
        sendToUi({
          type: ev.entry.tone === 'error' ? 'err' : 'notice',
          text: ev.entry.text,
          error: ev.entry.text
        });
      }
      break;
    case 'prompt_open':
      sendToUi({ type: 'prompt', prompt: ev.prompt });
      break;
    case 'prompt_closed':
      sendToUi({ type: 'prompt_closed', id: ev.id });
      break;
    case 'tabs':
      sendToUi({ type: 'tabs', tabs: ev.tabs });
      break;
    case 'run_status':
      if (ev.status === 'stopped') sendToUi({ type: 'stopped' });
      else if (ev.status === 'idle') sendToUi({ type: 'idle' });
      else if (ev.status === 'failed') {
        sendToUi({ type: 'err', error: ev.reason || 'Run failed' });
        activeConversationId = null;
      }
      break;
    case 'error':
      sendToUi({ type: 'err', error: ev.message });
      break;
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets/icon.png');
  win = new BrowserWindow({
    width: 1140,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'NaviQ',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });
  win.loadFile('index.html');
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'microphone' || true;
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(true);
  });

  createWindow();
  // Auto-launch Chrome with user's saved or default profile
  const initialStore = readStore();
  const initialProfile = initialStore.chrome_profile || 'Default';
  await launchBrowserWithExtension(initialProfile).catch((err) => {
    console.error('[main] Chrome launch error:', err);
    sendToUi({ type: 'err', error: `Chrome launch failed: ${err.message}` });
  });
});

app.on('window-all-closed', async () => {
  await closeBrowser();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-storage', (_e, key) => {
  const store = readStore();
  return key ? store[key] : store;
});

ipcMain.handle('set-storage', (_e, key, val) => {
  const store = readStore();
  store[key] = val;
  writeStore(store);
  return { ok: true };
});

ipcMain.handle('transcribe-audio', async (_e, { base64Audio, mimeType, settings }) => {
  const keys = Array.isArray(settings?.apiKeys) && settings.apiKeys.length ? settings.apiKeys : [];
  if (!keys.length) return { ok: false, error: 'No API key configured in settings' };

  const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
  const preferredModel = settings?.model && !['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'].includes(settings.model)
    ? settings.model
    : 'gemini-3.1-flash-lite';

  const modelsToTry = [
    preferredModel,
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-2.5-flash',
    'gemini-3-flash'
  ];
  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = '';

  for (const key of keys) {
    for (const model of uniqueModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: 'Transcribe this voice command verbatim into plain text for a web automation browser agent. Output ONLY the clean transcribed command text without quotes, timestamps, markdown or explanations.'
                  },
                  {
                    inlineData: {
                      mimeType: cleanMime,
                      data: base64Audio
                    }
                  }
                ]
              }
            ]
          })
        });

        if (res.ok) {
          const data = await res.json();
          const parts = data?.candidates?.[0]?.content?.parts || [];
          let transcribed = '';
          for (const p of parts) {
            if (p.thought) continue;
            if (typeof p.text === 'string') transcribed += p.text;
          }
          transcribed = transcribed.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]|\b\d{1,2}:\d{2}\b/g, '').trim();
          if (transcribed && !/^silent$/i.test(transcribed)) {
            return { ok: true, text: transcribed };
          }
        } else {
          const errText = await res.text();
          lastError = `Gemini HTTP ${res.status} (${model}): ${errText}`;
          // 404 = model not in API; try next model
          if (res.status === 404) continue;
          // 503 / 429 = overloaded or rate limit; try next model on same key first
          if (res.status === 503 || res.status === 429) continue;
          // 400 / 403 with invalid key; try next key
          if (res.status === 400 || res.status === 403) break;
        }
      } catch (err) {
        lastError = err.message || String(err);
      }
    }
  }

  return { ok: false, error: lastError || 'Transcription failed across all keys and models' };
});

ipcMain.handle('new-chat', async () => {
  activeConversationId = null;
  return { ok: true };
});

ipcMain.handle('get-chrome-profiles', async () => {
  return getChromeProfiles();
});

ipcMain.handle('get-active-chrome-profile', async () => {
  const store = readStore();
  return getActiveProfileId() || store.chrome_profile || 'Default';
});

ipcMain.handle('sync-settings', async (_e, settings) => {
  if (extWs && extWs.readyState === 1 && settings) {
    extWs.send(JSON.stringify({ type: 'sync-settings', settings }));
  }
  return { ok: true };
});

ipcMain.handle('launch-browser', async (_e, profileId) => {
  try {
    const store = readStore();
    const chosenProfile = profileId || store.chrome_profile || 'Default';
    if (profileId) {
      store.chrome_profile = profileId;
      writeStore(store);
    }
    await launchBrowserWithExtension(chosenProfile);
    return { ok: true, activeProfile: chosenProfile };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('run', async (_e, instruction, settings, targetTabId, attachments) => {
  try {
    const store = readStore();
    await launchBrowserWithExtension(store.chrome_profile || 'Default');
  } catch (err) {
    return { ok: false, error: `Chrome not running: ${err.message}` };
  }

  if (!extWs || extWs.readyState !== 1) {
    return { ok: false, error: 'Extension not connected yet. Please wait for Chrome to connect.' };
  }

  // Sync settings first
  extWs.send(JSON.stringify({ type: 'sync-settings', settings }));

  // Send instruction command with optional file attachments
  extWs.send(
    JSON.stringify({
      type: 'command',
      command: {
        type: 'send',
        tabId: targetTabId ? Number(targetTabId) : null,
        conversationId: activeConversationId,
        text: instruction,
        attachments: [],
        attachmentsData: Array.isArray(attachments) ? attachments : [],
        context: [],
        mode: 'ask',
        model: settings?.model ? { providerId: 'desktop-provider', model: settings.model } : null,
        reasoning: 'medium'
      }
    })
  );

  return { ok: true };
});

ipcMain.on('stop', () => {
  if (extWs?.readyState === 1 && activeConversationId) {
    extWs.send(
      JSON.stringify({
        type: 'command',
        command: { type: 'stop', conversationId: activeConversationId }
      })
    );
  }
});

ipcMain.on('answer', (_e, promptId, answer) => {
  if (extWs?.readyState === 1) {
    extWs.send(
      JSON.stringify({
        type: 'command',
        command: { type: 'answer', promptId, answer }
      })
    );
  }
});
