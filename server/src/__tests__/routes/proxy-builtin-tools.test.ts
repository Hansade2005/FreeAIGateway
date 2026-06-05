import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return {
    ...actual,
    routeRequest: mockRouteRequest,
    hasEnabledToolsModel: () => true, // pretend a tool-capable model is enabled
  };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import { setBuiltinToolsConfig } from '../../services/builtin-tools.js';
import { setCacheConfig } from '../../services/cache.js';

function fakeRoute(provider: any) {
  return { provider, modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1, platform: 'fake', displayName: 'Fake', rpdLimit: null, tpdLimit: null };
}

async function post(app: Express, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'x-cache': 'no-store' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('built-in tool agent loop on /v1/chat/completions', () => {
  let app: Express;
  let key: string;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    mockRouteRequest.mockReset();
    setCacheConfig({ enabled: false });
    setBuiltinToolsConfig({ enabled: true, web_search: true, web_extract: true, generate_image: true });
    // jina upstream for web_search execution
    vi.stubGlobal('fetch', (url: any, init?: any) => {
      if (typeof url === 'string' && url.includes('r.jina.ai')) {
        return Promise.resolve(new Response('Top result: it is sunny.', { status: 200 }))
      }
      return realFetch(url, init)
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('executes a built-in tool call server-side and returns the final answer', async () => {
    const provider = {
      calls: 0,
      lastMessages: null as any,
      async chatCompletion(_k: string, messages: any[]) {
        provider.calls++
        provider.lastMessages = messages
        if (provider.calls === 1) {
          // First turn: the model asks for a web search.
          return {
            id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"query":"weather"}' } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }
        }
        // Second turn: after the tool result, the model answers.
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'It is sunny today.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }
      },
      async *streamChatCompletion() {},
    }
    mockRouteRequest.mockReturnValue(fakeRoute(provider))

    const { status, body } = await post(app, { messages: [{ role: 'user', content: 'weather?' }] }, key)
    expect(status).toBe(200)
    // Two model calls: tool request, then final answer.
    expect(provider.calls).toBe(2)
    // The tool result was fed back into the second call.
    const toolMsg = provider.lastMessages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('sunny')
    // Client receives the finished answer, not the tool call.
    expect(body.choices[0].message.content).toBe('It is sunny today.')
  })

  it('does not inject built-in tools when disabled (single call, no tools)', async () => {
    setBuiltinToolsConfig({ enabled: false })
    const provider = {
      calls: 0,
      lastOpts: null as any,
      async chatCompletion(_k: string, _m: any[], _id: string, opts: any) {
        provider.calls++
        provider.lastOpts = opts
        return { id: 'c', object: 'chat.completion', created: 0, model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      },
      async *streamChatCompletion() {},
    }
    mockRouteRequest.mockReturnValue(fakeRoute(provider))
    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key)
    expect(status).toBe(200)
    expect(provider.calls).toBe(1)
    expect(provider.lastOpts.tools).toBeUndefined()
  })

  it('x-builtin-tools: off opts a request out even when enabled', async () => {
    const provider = {
      lastOpts: null as any,
      async chatCompletion(_k: string, _m: any[], _id: string, opts: any) {
        provider.lastOpts = opts
        return { id: 'c', object: 'chat.completion', created: 0, model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      },
      async *streamChatCompletion() {},
    }
    mockRouteRequest.mockReturnValue(fakeRoute(provider))
    const server = app.listen(0)
    const addr = server.address() as any
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'x-builtin-tools': 'off', 'x-cache': 'no-store' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    server.close()
    expect(res.status).toBe(200)
    expect(provider.lastOpts.tools).toBeUndefined()
  })
})
