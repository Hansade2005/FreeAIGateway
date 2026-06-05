import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  getBuiltinToolsConfig, setBuiltinToolsConfig, getEnabledBuiltinToolDefs,
  isBuiltinTool, executeBuiltinTool, BUILTIN_TOOL_NAMES,
} from '../../services/builtin-tools.js';

describe('builtin-tools service', () => {
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });
  afterEach(() => { vi.unstubAllGlobals(); setBuiltinToolsConfig({ enabled: true, web_search: true, web_extract: true, generate_image: true }); });

  it('defaults every tool ON', () => {
    const cfg = getBuiltinToolsConfig();
    expect(cfg).toEqual({ enabled: true, web_search: true, web_extract: true, generate_image: true });
  });

  it('isBuiltinTool recognizes exactly the three built-ins', () => {
    for (const n of BUILTIN_TOOL_NAMES) expect(isBuiltinTool(n)).toBe(true);
    expect(isBuiltinTool('get_weather')).toBe(false);
  });

  it('getEnabledBuiltinToolDefs reflects flags and the master switch', () => {
    expect(getEnabledBuiltinToolDefs().map(d => d.function.name).sort()).toEqual(['generate_image', 'web_extract', 'web_search']);
    setBuiltinToolsConfig({ web_search: false });
    expect(getEnabledBuiltinToolDefs().map(d => d.function.name)).not.toContain('web_search');
    setBuiltinToolsConfig({ enabled: false });
    expect(getEnabledBuiltinToolDefs()).toHaveLength(0);
  });

  it('web_search hits the jina/duckduckgo upstream and returns text', async () => {
    let called = '';
    vi.stubGlobal('fetch', (url: any) => { called = String(url); return Promise.resolve(new Response('result text', { status: 200 })); });
    const out = await executeBuiltinTool('web_search', JSON.stringify({ query: 'latest news' }));
    expect(called).toContain('https://r.jina.ai/https://html.duckduckgo.com/html?q=latest%20news');
    expect(out).toContain('result text');
  });

  it('web_extract proxies the URL through jina reader', async () => {
    let called = '';
    vi.stubGlobal('fetch', (url: any) => { called = String(url); return Promise.resolve(new Response('# Page', { status: 200 })); });
    const out = await executeBuiltinTool('web_extract', JSON.stringify({ url: 'https://example.com/post' }));
    expect(called).toBe('https://r.jina.ai/https://example.com/post');
    expect(out).toContain('# Page');
  });

  it('generate_image fetches a0.dev and returns a saved temp PNG path', async () => {
    let called = '';
    vi.stubGlobal('fetch', (url: any) => { called = String(url); return Promise.resolve(new Response(Buffer.from('89504e47', 'hex'), { status: 200 })); });
    const out = await executeBuiltinTool('generate_image', JSON.stringify({ prompt: 'a fox', aspect: '16:9' }));
    expect(called).toContain('api.a0.dev/assets/image');
    expect(called).toContain('aspect=16:9');
    expect(out).toMatch(/saved to: .+freeaigateway-images.+\.png/);
  });

  it('a tool failure resolves to an error string (never throws into the loop)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 500 })));
    const out = await executeBuiltinTool('web_search', JSON.stringify({ query: 'x' }));
    expect(out).toContain('failed');
  });
});
