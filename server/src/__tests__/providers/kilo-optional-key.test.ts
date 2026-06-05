import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { resolveProvider } from '../../providers/index.js';
import { decrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Kilo is an optional-key provider: it works anonymously (no Authorization
// header) but also accepts a real API key (sent as a bearer).

const OPENAI_OK = {
  id: 'c', object: 'chat.completion', created: 0, model: 'kilo-auto/free',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

describe('Kilo optional-key provider', () => {
  const realFetch = globalThis.fetch;
  let lastHeaders: Record<string, string> = {};

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    lastHeaders = {};
    vi.stubGlobal('fetch', (url: any, init?: any) => {
      if (typeof url === 'string' && url.includes('api.kilo.ai')) {
        lastHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
        return Promise.resolve(new Response(JSON.stringify(OPENAI_OK), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return realFetch(url, init);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is registered as optional-key (not pure keyless)', () => {
    const kilo = resolveProvider('kilo')!;
    expect(kilo.optionalKey).toBe(true);
    expect(kilo.keyless).toBe(false);
  });

  it('omits Authorization in anonymous mode (anon sentinel)', async () => {
    const kilo = resolveProvider('kilo')!;
    await kilo.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'kilo-auto/free');
    expect(lastHeaders).not.toHaveProperty('Authorization');
  });

  it('omits Authorization when the key is empty', async () => {
    const kilo = resolveProvider('kilo')!;
    await kilo.chatCompletion('', [{ role: 'user', content: 'hi' }], 'kilo-auto/free');
    expect(lastHeaders).not.toHaveProperty('Authorization');
  });

  it('sends the bearer when a real key is configured', async () => {
    const kilo = resolveProvider('kilo')!;
    await kilo.chatCompletion('kilo-sk-abc123', [{ role: 'user', content: 'hi' }], 'kilo-auto/free');
    expect(lastHeaders['Authorization']).toBe('Bearer kilo-sk-abc123');
  });
});

describe('Keys API — Kilo with optional key', () => {
  let app: Express;
  let dashToken = '';

  async function request(method: string, path: string, body?: any) {
    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body: data };
  }

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });
  beforeEach(() => { getDb().prepare('DELETE FROM api_keys').run(); });

  function storedKeyFor(platform: string): string[] {
    const rows = getDb().prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ?').all(platform) as any[];
    return rows.map(r => decrypt(r.encrypted_key, r.iv, r.auth_tag));
  }

  it('adds Kilo with no key → stores the anon sentinel', async () => {
    const res = await request('POST', '/api/keys', { platform: 'kilo' });
    expect(res.status).toBe(201);
    expect(storedKeyFor('kilo')).toEqual(['no-key']);
  });

  it('re-adding Kilo anon reuses the one sentinel row (no duplicates)', async () => {
    await request('POST', '/api/keys', { platform: 'kilo' });
    const res = await request('POST', '/api/keys', { platform: 'kilo' });
    expect(res.status).toBe(200); // re-enabled existing
    expect(storedKeyFor('kilo')).toEqual(['no-key']);
  });

  it('adds Kilo with a real key → stores it (bearer mode)', async () => {
    const res = await request('POST', '/api/keys', { platform: 'kilo', key: 'kilo-sk-xyz' });
    expect(res.status).toBe(201);
    expect(storedKeyFor('kilo')).toEqual(['kilo-sk-xyz']);
  });

  it('still requires a key for non-optional providers', async () => {
    const res = await request('POST', '/api/keys', { platform: 'groq' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/key is required/);
  });
});
