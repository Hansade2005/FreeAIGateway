import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

// A 1x1 PNG. The endpoint fetches the a0.dev asset and saves it, so we stub
// fetch to return these bytes instead of hitting the network.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let lastFetchUrl = '';

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
    return { status: res.status, text, routedVia: res.headers.get('x-routed-via') ?? '' };
  } finally {
    server.close();
  }
}

describe('POST /v1/images/generations', () => {
  let app: Express;
  let key: string;
  const realFetch = globalThis.fetch;
  const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    // Only intercept a0.dev calls; let the test's own loopback fetch through.
    vi.stubGlobal('fetch', (url: any, init?: any) => {
      if (typeof url === 'string' && url.includes('api.a0.dev')) {
        lastFetchUrl = url;
        return Promise.resolve(new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } }));
      }
      return realFetch(url, init);
    });
  });

  afterAll(() => { vi.unstubAllGlobals(); });

  it('rejects without a valid key (401)', async () => {
    expect((await post(app, '/v1/images/generations', { prompt: 'a cat' })).status).toBe(401);
    expect((await post(app, '/v1/images/generations', { prompt: 'a cat' }, auth('nope'))).status).toBe(401);
  });

  it('rejects a missing prompt (400)', async () => {
    const { status, text } = await post(app, '/v1/images/generations', {}, auth(key));
    expect(status).toBe(400);
    expect(JSON.parse(text).error.type).toBe('invalid_request_error');
  });

  it('fetches a0.dev, saves a PNG to a temp path, and returns the path + served url', async () => {
    const { status, text, routedVia } = await post(app, '/v1/images/generations', { prompt: 'a neon city skyline' }, auth(key));
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(routedVia).toBe('a0dev/a0-image');
    expect(lastFetchUrl).toContain('api.a0.dev/assets/image');
    expect(lastFetchUrl).toContain('text=a+neon+city+skyline');
    expect(lastFetchUrl).toContain('aspect=1%3A1');

    const entry = body.data[0];
    expect(entry.path).toMatch(/freeaigateway-images.+\.png$/);
    expect(fs.existsSync(entry.path)).toBe(true);          // saved to OS temp
    expect(fs.readFileSync(entry.path).length).toBe(PNG.length);
    expect(entry.url).toContain('/v1/images/files/');       // viewable URL
  });

  it('maps OpenAI size to a0.dev aspect (landscape → 16:9)', async () => {
    await post(app, '/v1/images/generations', { prompt: 'x', size: '1792x1024' }, auth(key));
    expect(lastFetchUrl).toContain('aspect=16%3A9');
  });

  it('b64_json includes the inlined bytes and the saved path', async () => {
    const { text } = await post(app, '/v1/images/generations', { prompt: 'forest', response_format: 'b64_json' }, auth(key));
    const entry = JSON.parse(text).data[0];
    expect(entry.b64_json).toBe(PNG.toString('base64'));
    expect(fs.existsSync(entry.path)).toBe(true);
  });
});
