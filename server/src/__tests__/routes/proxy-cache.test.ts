import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import { setCacheConfig, clearCache, resetCacheStats } from '../../services/cache.js';

function fakeRoute(provider: any) {
  return { provider, modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1, platform: 'fake', displayName: 'Fake Model', rpdLimit: null, tpdLimit: null };
}

async function post(app: Express, path: string, body: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, cache: res.headers.get('x-cache') ?? '', routedVia: res.headers.get('x-routed-via') ?? '' };
  } finally {
    server.close();
  }
}

describe('prompt cache on /v1/chat/completions', () => {
  let app: Express;
  let key: string;
  const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    clearCache();
    resetCacheStats();
    setCacheConfig({ enabled: true, ttlSeconds: 3600 });
    mockRouteRequest.mockReset();
  });

  function singleReplyRoute() {
    const provider = {
      calls: 0,
      async chatCompletion() {
        provider.calls++;
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'cached answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        };
      },
      async *streamChatCompletion() {
        provider.calls++;
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'streamed answer' }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      },
    };
    return provider;
  }

  it('non-stream: first call MISS hits the provider, second identical call is a HIT served from cache', async () => {
    const provider = singleReplyRoute();
    mockRouteRequest.mockReturnValue(fakeRoute(provider));
    const body = { model: 'auto', messages: [{ role: 'user', content: 'cache me' }] };

    const first = await post(app, '/v1/chat/completions', body, auth(key));
    expect(first.status).toBe(200);
    expect(first.cache).toBe('MISS');
    expect(provider.calls).toBe(1);

    const second = await post(app, '/v1/chat/completions', body, auth(key));
    expect(second.status).toBe(200);
    expect(second.cache).toBe('HIT');
    expect(JSON.parse(second.text).choices[0].message.content).toBe('cached answer');
    // Provider was NOT called again — the whole point.
    expect(provider.calls).toBe(1);
  });

  it('a different prompt is a MISS (distinct cache key)', async () => {
    const provider = singleReplyRoute();
    mockRouteRequest.mockReturnValue(fakeRoute(provider));
    await post(app, '/v1/chat/completions', { messages: [{ role: 'user', content: 'one' }] }, auth(key));
    const other = await post(app, '/v1/chat/completions', { messages: [{ role: 'user', content: 'two' }] }, auth(key));
    expect(other.cache).toBe('MISS');
    expect(provider.calls).toBe(2);
  });

  it('x-cache: no-store bypasses the cache (no hit, no store)', async () => {
    const provider = singleReplyRoute();
    mockRouteRequest.mockReturnValue(fakeRoute(provider));
    const body = { messages: [{ role: 'user', content: 'fresh please' }] };
    await post(app, '/v1/chat/completions', body, { ...auth(key), 'x-cache': 'no-store' });
    const again = await post(app, '/v1/chat/completions', body, { ...auth(key), 'x-cache': 'no-store' });
    expect(again.cache).toBe('');
    expect(provider.calls).toBe(2);
  });

  it('disabled cache: no headers, always routes', async () => {
    setCacheConfig({ enabled: false });
    const provider = singleReplyRoute();
    mockRouteRequest.mockReturnValue(fakeRoute(provider));
    const body = { messages: [{ role: 'user', content: 'nocache' }] };
    const first = await post(app, '/v1/chat/completions', body, auth(key));
    const second = await post(app, '/v1/chat/completions', body, auth(key));
    expect(first.cache).toBe('');
    expect(second.cache).toBe('');
    expect(provider.calls).toBe(2);
  });

  it('streaming: a clean text stream populates the cache; a later identical stream is a HIT replayed as SSE', async () => {
    const provider = singleReplyRoute();
    mockRouteRequest.mockReturnValue(fakeRoute(provider));
    const body = { messages: [{ role: 'user', content: 'stream cache' }], stream: true };

    const first = await post(app, '/v1/chat/completions', body, auth(key));
    expect(first.cache).toBe('MISS');
    expect(first.text).toContain('streamed answer');
    expect(provider.calls).toBe(1);

    const second = await post(app, '/v1/chat/completions', body, auth(key));
    expect(second.cache).toBe('HIT');
    expect(second.text).toContain('data: [DONE]');
    expect(second.text).toContain('streamed answer');
    expect(provider.calls).toBe(1); // served from cache
  });
});
