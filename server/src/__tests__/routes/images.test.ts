import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

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
  const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  it('rejects without a valid key (401)', async () => {
    expect((await post(app, '/v1/images/generations', { prompt: 'a cat' })).status).toBe(401);
    expect((await post(app, '/v1/images/generations', { prompt: 'a cat' }, auth('nope'))).status).toBe(401);
  });

  it('rejects a missing prompt (400)', async () => {
    const { status, text } = await post(app, '/v1/images/generations', {}, auth(key));
    expect(status).toBe(400);
    expect(JSON.parse(text).error.type).toBe('invalid_request_error');
  });

  it('returns an OpenAI-shaped url response backed by a0.dev', async () => {
    const { status, text, routedVia } = await post(app, '/v1/images/generations', { prompt: 'a neon city skyline' }, auth(key));
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].url).toContain('api.a0.dev/assets/image');
    expect(body.data[0].url).toContain('text=a+neon+city+skyline');
    expect(body.data[0].url).toContain('aspect=1%3A1'); // default square
    expect(routedVia).toBe('a0dev/a0-image');
  });

  it('maps OpenAI size to a0.dev aspect (landscape → 16:9, portrait → 9:16)', async () => {
    const wide = JSON.parse((await post(app, '/v1/images/generations', { prompt: 'x', size: '1792x1024' }, auth(key))).text);
    expect(wide.data[0].url).toContain('aspect=16%3A9');
    const tall = JSON.parse((await post(app, '/v1/images/generations', { prompt: 'x', size: '1024x1792' }, auth(key))).text);
    expect(tall.data[0].url).toContain('aspect=9%3A16');
  });

  it('honors an explicit aspect and n (distinct variants)', async () => {
    const { text } = await post(app, '/v1/images/generations', { prompt: 'forest', aspect: '16:9', n: 3 }, auth(key));
    const body = JSON.parse(text);
    expect(body.data).toHaveLength(3);
    for (const d of body.data) expect(d.url).toContain('aspect=16%3A9');
    // seeds make the variants distinct URLs
    expect(new Set(body.data.map((d: any) => d.url)).size).toBe(3);
  });
});
