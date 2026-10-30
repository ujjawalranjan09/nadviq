// Automatic model failover and key rotation on rate limits (429 / 15 RPM), quota exhaustion (RESOURCE_EXHAUSTED)
// or invalid keys (401), plus SSE tool_calls normalization for OpenAI-compatible providers (like Gemini /openai).
import type { ProviderKind } from './providers';

export interface KeyRotationEvent {
  oldKey: string;
  newKey: string;
  keyIndex: number;
  totalKeys: number;
  oldModel?: string;
  newModel?: string;
  modelIndex?: number;
  totalModels?: number;
  reason: string;
}

export type KeyRotateCallback = (event: KeyRotationEvent) => void;

let globalRotateListeners: KeyRotateCallback[] = [];

export function onKeyRotate(cb: KeyRotateCallback): () => void {
  globalRotateListeners.push(cb);
  return () => {
    globalRotateListeners = globalRotateListeners.filter(l => l !== cb);
  };
}

function notifyKeyRotate(event: KeyRotationEvent) {
  for (const listener of globalRotateListeners) {
    try {
      listener(event);
    } catch {}
  }
}

async function checkKeyFailure(response: Response): Promise<{ isFailure: boolean; reason: string }> {
  if (response.status === 429) {
    return { isFailure: true, reason: 'Rate limit or quota exceeded (HTTP 429)' };
  }
  if (response.status === 401) {
    return { isFailure: true, reason: 'Invalid or expired API key (HTTP 401)' };
  }
  if (response.status === 503) {
    try {
      const clone = response.clone();
      const text = await clone.text();
      if (text.toLowerCase().includes('overloaded') || text.toLowerCase().includes('unavailable')) {
        return { isFailure: true, reason: 'Model overloaded or unavailable (HTTP 503)' };
      }
    } catch {}
  }
  if (response.status === 403 || response.status === 400) {
    try {
      const clone = response.clone();
      const text = await clone.text();
      const lower = text.toLowerCase();
      if (
        lower.includes('resource_exhausted') ||
        lower.includes('quota') ||
        lower.includes('rate limit') ||
        lower.includes('rate-limit') ||
        lower.includes('rate_limit') ||
        lower.includes('valid api key') ||
        lower.includes('api_key_invalid') ||
        lower.includes('api key not valid')
      ) {
        return { isFailure: true, reason: `Quota or key failure (HTTP ${response.status})` };
      }
    } catch {
      // ignore clone error
    }
  }
  return { isFailure: false, reason: '' };
}

function applyKeyAndModelToRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  key: string,
  modelName?: string,
  kind?: ProviderKind,
): { updatedInput: RequestInfo | URL; updatedInit: RequestInit } {
  let updatedInput = input;
  let updatedInit: RequestInit = { ...init };

  // 1. Update Model Name in JSON body or URL
  if (modelName) {
    if (typeof updatedInit.body === 'string') {
      try {
        const bodyObj = JSON.parse(updatedInit.body);
        if (bodyObj && typeof bodyObj === 'object' && 'model' in bodyObj && bodyObj.model !== modelName) {
          bodyObj.model = modelName;
          updatedInit.body = JSON.stringify(bodyObj);
        }
      } catch {}
    }

    let urlStr: string | null = null;
    if (typeof updatedInput === 'string') {
      urlStr = updatedInput;
    } else if (updatedInput instanceof URL) {
      urlStr = updatedInput.toString();
    } else if (typeof Request !== 'undefined' && updatedInput instanceof Request) {
      urlStr = updatedInput.url;
    }

    if (urlStr && urlStr.includes('/models/')) {
      const updatedUrlStr = urlStr.replace(/(\/models\/)([^/:]+)(:|\/|\?|$)/, `$1${modelName}$3`);
      if (updatedUrlStr !== urlStr) {
        if (typeof updatedInput === 'string') {
          updatedInput = updatedUrlStr;
        } else if (updatedInput instanceof URL) {
          updatedInput = new URL(updatedUrlStr);
        } else if (typeof Request !== 'undefined' && updatedInput instanceof Request) {
          updatedInput = new Request(updatedUrlStr, updatedInput);
        }
      }
    }
  }

  // 2. Update API Key in headers and URL
  if (key) {
    let urlStr: string | null = null;
    if (typeof updatedInput === 'string') {
      urlStr = updatedInput;
    } else if (updatedInput instanceof URL) {
      urlStr = updatedInput.toString();
    } else if (typeof Request !== 'undefined' && updatedInput instanceof Request) {
      urlStr = updatedInput.url;
    }

    if (urlStr) {
      try {
        const parsed = new URL(urlStr);
        if (parsed.searchParams.has('key')) {
          parsed.searchParams.set('key', key);
          if (typeof updatedInput === 'string') {
            updatedInput = parsed.toString();
          } else if (updatedInput instanceof URL) {
            updatedInput = parsed;
          } else if (typeof Request !== 'undefined' && updatedInput instanceof Request) {
            updatedInput = new Request(parsed.toString(), updatedInput);
          }
        }
      } catch {}
    }

    const headers = new Headers(updatedInit.headers);

    if (headers.has('authorization')) {
      const auth = headers.get('authorization') || '';
      headers.set('authorization', auth.startsWith('Bearer ') ? `Bearer ${key}` : key);
    }
    if (headers.has('x-goog-api-key')) {
      headers.set('x-goog-api-key', key);
    }
    if (headers.has('x-api-key')) {
      headers.set('x-api-key', key);
    }
    if (headers.has('api-key')) {
      headers.set('api-key', key);
    }

    if (kind === 'gemini') {
      headers.set('x-goog-api-key', key);
    } else if (kind === 'anthropic') {
      headers.set('x-api-key', key);
    } else if (kind === 'openai' || kind === 'openrouter' || kind === 'openai-compatible') {
      headers.set('authorization', `Bearer ${key}`);
    }

    updatedInit.headers = headers;
  }

  return { updatedInput, updatedInit };
}

export function fixToolCallsIndex(line: string): string {
  const dataPrefix = line.match(/^data:\s*/)?.[0];
  if (!dataPrefix) return line;
  const raw = line.slice(dataPrefix.length).trim();
  if (!raw || raw === '[DONE]') return line;
  try {
    const data = JSON.parse(raw);
    let modified = false;
    if (Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        const calls = choice?.delta?.tool_calls;
        if (Array.isArray(calls)) {
          calls.forEach((call: Record<string, unknown>, idx: number) => {
            if (call && typeof call === 'object' && call.index === undefined) {
              call.index = idx;
              modified = true;
            }
          });
        }
      }
    }
    return modified ? `${dataPrefix}${JSON.stringify(data)}` : line;
  } catch {
    return line;
  }
}

export function normalizeSseResponse(response: Response): Response {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        let processedLine = line;
        if (line.startsWith('data:') && line.includes('tool_calls')) {
          processedLine = fixToolCallsIndex(line);
        }
        controller.enqueue(encoder.encode(processedLine + '\n'));
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        let processedLine = buffer;
        if (buffer.startsWith('data:') && buffer.includes('tool_calls')) {
          processedLine = fixToolCallsIndex(buffer);
        }
        controller.enqueue(encoder.encode(processedLine));
      }
    },
  });

  const newBody = response.body.pipeThrough(transformStream);
  return new Response(newBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export interface RotatingFetchOptions {
  keys: string[];
  models?: string[];
  kind?: ProviderKind;
  onRotate?: KeyRotateCallback;
  baseFetch?: typeof fetch;
}

export function createRotatingFetch(
  optionsOrKeys: string[] | RotatingFetchOptions,
  kindParam?: ProviderKind,
  onRotateParam?: KeyRotateCallback,
  baseFetchParam?: typeof fetch,
): typeof fetch {
  const options: RotatingFetchOptions = Array.isArray(optionsOrKeys)
    ? { keys: optionsOrKeys, kind: kindParam, onRotate: onRotateParam, baseFetch: baseFetchParam }
    : optionsOrKeys;

  const rawKeys = options.keys || [];
  const keys = rawKeys.length > 0 ? rawKeys : [''];
  const rawModels = options.models && options.models.length > 0 ? options.models : [];
  const models = rawModels.length > 0 ? rawModels : [''];
  const providerKind = options.kind;
  const onRotate = options.onRotate;
  const baseFetch = options.baseFetch ?? globalThis.fetch.bind(globalThis);

  if (keys.length <= 1 && models.length <= 1) {
    const singleKey = keys[0];
    const singleModel = models[0];
    return async function singleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const { updatedInput, updatedInit } = applyKeyAndModelToRequest(
        input,
        init,
        singleKey,
        singleModel || undefined,
        providerKind,
      );
      const resp = await baseFetch(updatedInput, updatedInit);
      return normalizeSseResponse(resp);
    };
  }

  let activeKeyIndex = 0;
  let activeModelIndex = 0;
  let lastModel429Timestamp = 0;

  return async function rotatingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const totalKeys = keys.length;
    const totalModels = models.length;
    const totalAttempts = totalKeys * totalModels;

    // If 60 seconds have elapsed since the last 429 rate limit on the primary model,
    // Google AI Studio's 15 RPM bucket has replenished! Reset to primary model.
    if (activeModelIndex !== 0 && Date.now() - lastModel429Timestamp > 60_000) {
      activeModelIndex = 0;
    }

    let lastResponse: Response | null = null;
    let currentKeyIndex = activeKeyIndex;
    let currentModelIndex = activeModelIndex;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const currentKey = keys[currentKeyIndex];
      const currentModel = models[currentModelIndex];

      const { updatedInput, updatedInit } = applyKeyAndModelToRequest(
        input,
        init,
        currentKey,
        currentModel || undefined,
        providerKind,
      );

      let response: Response;
      try {
        response = await baseFetch(updatedInput, updatedInit);
      } catch (err) {
        throw err;
      }

      const check = await checkKeyFailure(response);
      if (check.isFailure) {
        lastResponse = response;

        let nextKeyIndex = currentKeyIndex;
        let nextModelIndex = currentModelIndex;
        let reason = '';

        if (currentModelIndex + 1 < totalModels) {
          // Switch to secondary/fallback model on the SAME API key!
          nextModelIndex = currentModelIndex + 1;
          nextKeyIndex = currentKeyIndex;
          lastModel429Timestamp = Date.now();
          const oldName = currentModel || 'primary model';
          const newName = models[nextModelIndex];
          reason = `Rate limit on ${oldName} (15 RPM). Switched to model ${newName} on Key ${currentKeyIndex + 1}/${totalKeys}.`;
        } else {
          // Both models exhausted on this key! Switch to next API key and reset to primary model.
          nextModelIndex = 0;
          nextKeyIndex = (currentKeyIndex + 1) % totalKeys;
          lastModel429Timestamp = 0;
          const keyNum = currentKeyIndex + 1;
          const nextKeyNum = nextKeyIndex + 1;
          reason = totalModels > 1
            ? `Quota limit reached on all models for Key ${keyNum}. Switched to API Key ${nextKeyNum}/${totalKeys} (${models[0] || 'primary'}).`
            : `Rate limit on Key ${keyNum}. Switched to API Key ${nextKeyNum}/${totalKeys}.`;
        }

        if (attempt < totalAttempts - 1) {
          activeKeyIndex = nextKeyIndex;
          activeModelIndex = nextModelIndex;
          currentKeyIndex = nextKeyIndex;
          currentModelIndex = nextModelIndex;

          const ev: KeyRotationEvent = {
            oldKey: currentKey,
            newKey: keys[nextKeyIndex],
            keyIndex: nextKeyIndex + 1,
            totalKeys,
            oldModel: currentModel,
            newModel: models[nextModelIndex],
            modelIndex: nextModelIndex + 1,
            totalModels,
            reason,
          };
          onRotate?.(ev);
          notifyKeyRotate(ev);
          continue;
        }
      } else {
        // Success!
        activeKeyIndex = currentKeyIndex;
        activeModelIndex = currentModelIndex;
        return normalizeSseResponse(response);
      }
    }

    return normalizeSseResponse(lastResponse!);
  };
}
