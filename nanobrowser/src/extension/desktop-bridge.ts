// Desktop bridge: connects the background service worker to the local Electron desktop app over WebSocket.
import type { PanelCommand, PanelEvent } from '@src/ui/protocol';
import type { PanelConnection, RunManager } from './run-manager';
import { providersStorage, keysStorage, multiKeysStorage, settingsStorage } from '@src/store/settings';
import type { ProviderConfig } from '@src/store/settings';
import type { ProviderKind } from '@src/llm/providers';
import { onKeyRotate } from '@src/llm/rotating-fetch';
import { putBlob } from '@src/store/conversations';

const WS_URL = 'ws://127.0.0.1:8765';

export function connectDesktopBridge(manager: RunManager): void {
  let ws: WebSocket | null = null;
  let connection: PanelConnection | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  onKeyRotate(ev => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'event',
          event: {
            type: 'notice',
            text: ev.reason || `Rate limit on API key. Switched to key ${ev.keyIndex}/${ev.totalKeys}.`,
          },
        }),
      );
    }
  });

  async function syncSettings(s: {
    provider?: string;
    baseUrl?: string;
    apiKeys?: string[];
    model?: string;
    fallbackModel?: string;
    models?: string[];
  }) {
    if (!s.model) return;
    const isGeminiOpenAI = s.provider === 'gemini' && (s.baseUrl?.includes('/openai') ?? false);
    const kind: ProviderKind =
      isGeminiOpenAI
        ? 'openai-compatible'
        : s.provider === 'gemini'
          ? 'gemini'
          : s.provider === 'openrouter'
            ? 'openrouter'
            : s.provider === 'local'
              ? 'ollama'
              : s.provider === 'openai'
                ? 'openai'
                : 'openai-compatible';
    const providerId = 'desktop-provider';
    const baseUrl = s.provider === 'gemini' && !isGeminiOpenAI ? undefined : s.baseUrl || undefined;

    const modelsList = [
      s.model,
      s.fallbackModel,
      ...(Array.isArray(s.models) ? s.models : [])
    ].filter((m): m is string => Boolean(m && typeof m === 'string'));
    const uniqueModels = [...new Set(modelsList)];

    const cfg: ProviderConfig = {
      id: providerId,
      kind,
      name: 'Desktop Provider',
      baseUrl,
      models: uniqueModels.map(name => ({ name })),
    };
    await providersStorage.set(list => [cfg, ...list.filter(p => p.id !== providerId)]);
    if (s.apiKeys?.length) {
      await multiKeysStorage.set(keys => ({ ...keys, [providerId]: s.apiKeys! }));
      await keysStorage.set(keys => ({ ...keys, [providerId]: s.apiKeys![0] }));
    }
    await settingsStorage.set(current => ({
      ...current,
      onboarded: true,
      defaultModel: {
        providerId,
        model: s.model!,
      },
    }));

    // If welcome onboarding tab is open in Chrome, auto-close it as extension is fully pre-configured
    try {
      const welcomeUrl = chrome.runtime.getURL('/welcome.html');
      const allTabs = await chrome.tabs.query({});
      for (const t of allTabs) {
        if (t.id && t.url && t.url.startsWith(welcomeUrl)) {
          chrome.tabs.remove(t.id).catch(() => undefined);
        }
      }
    } catch {}
  }

  async function sendTabList() {
    if (ws?.readyState !== WebSocket.OPEN) return;
    try {
      const tabs = await chrome.tabs.query({});
      ws.send(
        JSON.stringify({
          type: 'status',
          status: 'connected',
          tabs: tabs.map(t => ({ id: t.id, title: t.title || '', url: t.url || '', active: !!t.active })),
        }),
      );
    } catch {}
  }

  function connect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      reconnectTimer = setTimeout(connect, 2000);
      return;
    }

    connection = {
      tabId: null,
      conversationId: null,
      sink: (event: PanelEvent) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'event', event }));
        }
      },
    };
    manager.connections.add(connection);

    ws.onopen = async () => {
      await sendTabList();
    };

    ws.onmessage = async e => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.type === 'sync-settings' && msg.settings) {
          await syncSettings(msg.settings);
        } else if (msg.type === 'command' && msg.command) {
          if (msg.settings) {
            await syncSettings(msg.settings);
          }
          const cmd = msg.command as PanelCommand;
          if (cmd.type === 'send') {
            const incomingAttachments = (cmd as any).attachmentsData as
              | Array<{
                  id: string;
                  name: string;
                  mimeType: string;
                  size: number;
                  dataBase64?: string;
                  dataText?: string;
                }>
              | undefined;

            if (incomingAttachments && incomingAttachments.length > 0) {
              cmd.attachments = [];
              for (const att of incomingAttachments) {
                try {
                  let blobData: Blob;
                  if (att.dataBase64) {
                    const binaryStr = atob(att.dataBase64);
                    const len = binaryStr.length;
                    const bytes = new Uint8Array(len);
                    for (let i = 0; i < len; i++) {
                      bytes[i] = binaryStr.charCodeAt(i);
                    }
                    blobData = new Blob([bytes], { type: att.mimeType || 'application/octet-stream' });
                  } else {
                    blobData = new Blob([att.dataText || ''], { type: att.mimeType || 'text/plain' });
                  }

                  await putBlob({
                    id: att.id,
                    conversationId: '',
                    name: att.name,
                    mimeType: att.mimeType || 'application/octet-stream',
                    size: att.size || blobData.size,
                    data: blobData,
                    createdAt: Date.now(),
                  });

                  cmd.attachments.push({
                    id: att.id,
                    name: att.name,
                    mimeType: att.mimeType || 'application/octet-stream',
                    size: att.size || blobData.size,
                  });
                } catch (err) {
                  console.error('[desktop-bridge] failed to ingest attachment', att.name, err);
                }
              }
            }

            if (cmd.tabId) {
              // Bring user-chosen target tab to the front
              try {
                await chrome.tabs.update(cmd.tabId, { active: true });
              } catch {}
            } else {
              const allTabs = await chrome.tabs.query({});
              const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
              const isRestricted = (url?: string) =>
                !url || url.startsWith('chrome://') || url.startsWith('chrome-extension://');

              if (active?.id && !isRestricted(active.url)) {
                cmd.tabId = active.id;
              } else {
                const usable = allTabs.find(t => t.id && !isRestricted(t.url));
                if (usable?.id) {
                  cmd.tabId = usable.id;
                } else {
                  const newTab = await chrome.tabs.create({ url: 'about:blank' });
                  cmd.tabId = newTab.id!;
                }
              }
            }
          }
          if ('conversationId' in cmd && cmd.conversationId && connection) {
            connection.conversationId = cmd.conversationId;
          }
          if (connection) {
            try {
              await manager.handle(connection, cmd);
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              console.error('[desktop-bridge] manager.handle error', err);
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'event', event: { type: 'error', message } }));
                ws.send(JSON.stringify({ type: 'event', event: { type: 'run_status', status: 'idle' } }));
              }
            }
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[desktop-bridge] message handling error', err);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'event', event: { type: 'error', message } }));
        }
      }
    };

    ws.onclose = () => {
      if (connection) {
        manager.connections.delete(connection);
        connection.unsubscribe?.();
        connection = null;
      }
      reconnectTimer = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      try {
        ws?.close();
      } catch {}
    };
  }

  // Heartbeat to keep service worker active while connected
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 20000);

  // Send updated tab list on tab changes
  chrome.tabs.onUpdated?.addListener(() => void sendTabList());
  chrome.tabs.onCreated?.addListener(() => void sendTabList());
  chrome.tabs.onRemoved?.addListener(() => void sendTabList());

  connect();
}
