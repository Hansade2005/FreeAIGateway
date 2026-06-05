import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock only routeRequest so we don't need real provider keys; keep the rest of
// the router module (recordSuccess / recordRateLimitHit / hasEnabled*) intact.
const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

function fakeRoute(provider: any) {
  return { provider, modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1, platform: 'fake', displayName: 'Fake Model' };
}

async function post(app: Express, path: string, body: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  return { status: res.status, text, contentType: res.headers.get('content-type') ?? '' };
}

describe('POST /v1/messages (Anthropic Messages API)', () => {
  let app: Express;
  let key: string;
  const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  it('rejects requests without a valid unified key (401)', async () => {
    const noKey = await post(app, '/v1/messages', { messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 });
    expect(noKey.status).toBe(401);
    expect(JSON.parse(noKey.text).type).toBe('error');
    const badKey = await post(app, '/v1/messages', { messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }, auth('wrong'));
    expect(badKey.status).toBe(401);
  });

  it('accepts the unified key via the Anthropic x-api-key header', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() {
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi back' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        };
      },
      async *streamChatCompletion() { /* unused */ },
    }));
    const res = await post(app, '/v1/messages', { messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }, { 'x-api-key': key });
    expect(res.status).not.toBe(401);
  });

  it('rejects an invalid body (missing messages) with a typed Anthropic error', async () => {
    const { status, text } = await post(app, '/v1/messages', { model: 'auto', max_tokens: 16 }, auth(key));
    expect(status).toBe(400);
    expect(JSON.parse(text).error.type).toBe('invalid_request_error');
  });

  it('non-stream: returns a Messages object with text content and usage', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() {
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from fake' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        };
      },
      async *streamChatCompletion() { /* unused */ },
    }));

    const { status, text } = await post(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64,
    }, auth(key));
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content[0]).toEqual({ type: 'text', text: 'Hello from fake' });
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
    expect(typeof body.id).toBe('string');
  });

  it('non-stream: maps a system prompt + array content blocks', async () => {
    const seen: any = {};
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        seen.messages = messages;
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
      async *streamChatCompletion() { /* unused */ },
    }));

    await post(app, '/v1/messages', {
      system: 'You are helpful.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }],
      max_tokens: 64,
    }, auth(key));

    expect(seen.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(seen.messages[1]).toEqual({ role: 'user', content: 'hello there' });
  });

  it('non-stream: tool_use turns and tool_result blocks round-trip into the chat format', async () => {
    const seen: any = {};
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        seen.messages = messages;
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }] },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
        };
      },
      async *streamChatCompletion() { /* unused */ },
    }));

    const { status, text } = await post(app, '/v1/messages', {
      messages: [
        { role: 'user', content: 'weather in SF?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_0', name: 'get_weather', input: { city: 'SF' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'sunny' }] },
      ],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      max_tokens: 64,
    }, auth(key));

    // Inbound translation: assistant tool_use → tool_calls; tool_result → tool message.
    const assistant = seen.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls[0]).toMatchObject({ id: 'toolu_0', type: 'function', function: { name: 'get_weather' } });
    const toolMsg = seen.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'toolu_0', content: 'sunny' });

    // Outbound translation: tool_calls → tool_use content block + stop_reason.
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.stop_reason).toBe('tool_use');
    const toolUse = body.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } });
  });

  it('stream: emits the Anthropic SSE event sequence for text', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() { throw new Error('should not be called'); },
      async *streamChatCompletion() {
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      },
    }));

    const { status, text, contentType } = await post(app, '/v1/messages', {
      messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, stream: true,
    }, auth(key));
    expect(status).toBe(200);
    expect(contentType).toContain('text/event-stream');
    for (const ev of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
      expect(text).toContain(`event: ${ev}`);
    }
    expect(text).toContain('"type":"text_delta","text":"Hel"');
    expect(text).toContain('"type":"text_delta","text":"lo"');
    expect(text).toContain('"stop_reason":"end_turn"');
  });

  it('stream: tool-call deltas produce tool_use block + input_json_delta', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() { throw new Error('nope'); },
      async *streamChatCompletion() {
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: 'function', function: { arguments: 'ty":"SF"}' } }] }, finish_reason: 'tool_calls' }] };
      },
    }));

    const { text } = await post(app, '/v1/messages', {
      messages: [{ role: 'user', content: 'weather?' }], max_tokens: 64, stream: true,
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
    }, auth(key));
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"get_weather"');
    expect(text).toContain('"type":"input_json_delta"');
    expect(text).toContain('"partial_json":"{\\"ci"');
    expect(text).toContain('"partial_json":"ty\\":\\"SF\\"}"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });
});

describe('POST /v1/messages/count_tokens', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  it('rejects without a valid key (401)', async () => {
    const { status } = await post(app, '/v1/messages/count_tokens', { messages: [{ role: 'user', content: 'hi' }] });
    expect(status).toBe(401);
  });

  it('returns an input_tokens estimate', async () => {
    const { status, text } = await post(app, '/v1/messages/count_tokens', {
      messages: [{ role: 'user', content: 'hello world this is a token count test' }],
    }, { Authorization: `Bearer ${key}` });
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(typeof body.input_tokens).toBe('number');
    expect(body.input_tokens).toBeGreaterThan(0);
  });
});
