import { describe, expect, it } from 'vitest';
import { fixToolCallsIndex, normalizeSseResponse, createRotatingFetch } from '../rotating-fetch';

describe('fixToolCallsIndex', () => {
  it('injects missing index into tool_calls for Gemini OpenAI endpoint', () => {
    const rawLine =
      'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"function":{"arguments":"{\\"url\\":\\"https://www.amazon.com\\",\\"intent\\":\\"Navigate to Amazon.com\\"}","name":"navigate"},"id":"function-call-2276262979918772912","type":"function"}]},"finish_reason":"tool_calls","index":0}],"created":1793380100,"id":"A8_kar3nDfuz694PsILtQA","model":"gemini-2.5-flash-lite","object":"chat.completion.chunk","usage":{"completion_tokens":28,"prompt_tokens":9710,"total_tokens":9895}}';

    const fixed = fixToolCallsIndex(rawLine);
    expect(fixed).toMatch(/^data: /);
    const parsed = JSON.parse(fixed.replace(/^data:\s*/, ''));
    expect(parsed.choices[0].delta.tool_calls[0].index).toBe(0);
    expect(parsed.choices[0].delta.tool_calls[0].function.name).toBe('navigate');
  });

  it('leaves already indexed tool_calls untouched', () => {
    const rawLine = 'data: {"choices":[{"delta":{"tool_calls":[{"index":2,"id":"call-1"}]}}]}';
    const fixed = fixToolCallsIndex(rawLine);
    expect(fixed).toBe(rawLine);
  });

  it('handles non-json or DONE lines safely', () => {
    expect(fixToolCallsIndex('data: [DONE]')).toBe('data: [DONE]');
    expect(fixToolCallsIndex('event: ping')).toBe('event: ping');
    expect(fixToolCallsIndex('')).toBe('');
  });
});

describe('normalizeSseResponse', () => {
  it('normalizes stream chunks with missing tool_call index', async () => {
    const chunk =
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"navigate"}}]}}]}\n\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    const mockResponse = new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const normalized = normalizeSseResponse(mockResponse);
    const text = await normalized.text();
    expect(text).toContain('"index":0');
    expect(text).toContain('"navigate"');
  });
});

describe('createRotatingFetch', () => {
  it('rotates to second key on HTTP 429', async () => {
    const keys = ['key-1', 'key-2'];
    let callCount = 0;
    const requestedKeys: string[] = [];

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization') || '';
      requestedKeys.push(auth);

      if (callCount === 1) {
        return new Response('Quota exceeded', { status: 429 });
      }
      return new Response('{"ok": true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const rotatingFetch = createRotatingFetch(keys, 'openai-compatible', undefined, mockFetch as unknown as typeof fetch);
    const res = await rotatingFetch('https://api.test/v1/chat');
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    expect(requestedKeys[0]).toBe('Bearer key-1');
    expect(requestedKeys[1]).toBe('Bearer key-2');
  });
});
