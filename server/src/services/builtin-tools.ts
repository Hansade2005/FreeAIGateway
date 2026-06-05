import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { getSetting, setSetting } from '../db/index.js';
import type { ChatToolDefinition } from '@freeaigateway/shared/types.js';

// ─────────────────────────────────────────────────────────────────────────
// Built-in, server-executed tools.
//
// The gateway can offer the model a few tools it runs itself — web search, URL
// extraction, and image generation — and resolve them in an agent loop before
// returning the final answer (see routes/proxy.ts). This turns any plain
// chat-completions client into a lightweight agent without the client wiring up
// any tools of its own.
//
// Powered by keyless upstreams:
//   web_search   → https://r.jina.ai/https://html.duckduckgo.com/html?q=<query>
//   web_extract  → https://r.jina.ai/<url>
//   image_gen    → https://api.a0.dev/assets/image?text=<prompt>&aspect=<ratio>
//
// All three are on by default and individually toggleable from Settings.
// ─────────────────────────────────────────────────────────────────────────

export const BUILTIN_TOOL_NAMES = ['web_search', 'web_extract', 'generate_image'] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export interface BuiltinToolsConfig {
  enabled: boolean; // master switch
  web_search: boolean;
  web_extract: boolean;
  generate_image: boolean;
}

// Settings keys + defaults (every tool defaults ON).
const KEYS: Record<keyof BuiltinToolsConfig, string> = {
  enabled: 'builtin_tools_enabled',
  web_search: 'tool_web_search',
  web_extract: 'tool_web_extract',
  generate_image: 'tool_image_generation',
};

function readFlag(key: string): boolean {
  const v = getSetting(key);
  return v == null ? true : v === '1'; // default ON
}

export function getBuiltinToolsConfig(): BuiltinToolsConfig {
  return {
    enabled: readFlag(KEYS.enabled),
    web_search: readFlag(KEYS.web_search),
    web_extract: readFlag(KEYS.web_extract),
    generate_image: readFlag(KEYS.generate_image),
  };
}

export function setBuiltinToolsConfig(patch: Partial<BuiltinToolsConfig>): BuiltinToolsConfig {
  for (const k of Object.keys(patch) as (keyof BuiltinToolsConfig)[]) {
    if (patch[k] != null) setSetting(KEYS[k], patch[k] ? '1' : '0');
  }
  return getBuiltinToolsConfig();
}

export function isBuiltinTool(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

// OpenAI-shaped tool definitions for the enabled built-ins.
export function getEnabledBuiltinToolDefs(cfg: BuiltinToolsConfig = getBuiltinToolsConfig()): ChatToolDefinition[] {
  if (!cfg.enabled) return [];
  const defs: ChatToolDefinition[] = [];
  if (cfg.web_search) {
    defs.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the live web for up-to-date information. Returns ranked result snippets with titles and URLs.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] },
      },
    });
  }
  if (cfg.web_extract) {
    defs.push({
      type: 'function',
      function: {
        name: 'web_extract',
        description: 'Fetch a web page and extract its main content as clean readable text/markdown.',
        parameters: { type: 'object', properties: { url: { type: 'string', description: 'The absolute URL to extract' } }, required: ['url'] },
      },
    });
  }
  if (cfg.generate_image) {
    defs.push({
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'Generate an image from a text prompt. Saves a PNG to the server and returns its file path.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What to draw' },
            aspect: { type: 'string', enum: ['1:1', '16:9', '9:16'], description: 'Aspect ratio (default 1:1)' },
          },
          required: ['prompt'],
        },
      },
    });
  }
  return defs;
}

const MAX_RESULT_CHARS = 6000;
const FETCH_TIMEOUT_MS = 20000;

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const text = await res.text();
    return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '\n…[truncated]' : text;
  } finally {
    clearTimeout(timer);
  }
}

// Jina Reader fronts both web tools: it renders a page (or a DuckDuckGo HTML
// search) to clean markdown. No key required.
async function webSearch(query: string): Promise<string> {
  const target = `https://html.duckduckgo.com/html?q=${encodeURIComponent(query)}`;
  return fetchText(`https://r.jina.ai/${target}`);
}

async function webExtract(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error('url must be absolute (http/https)');
  return fetchText(`https://r.jina.ai/${url}`);
}

// The model gets `content` as the tool result; `imageFile` (a basename served
// by GET /v1/images/files/:name) lets the gateway surface generated images
// inline to the caller.
export interface BuiltinToolResult {
  content: string;
  imageFile?: string;
}

export const IMAGE_DIR = path.join(os.tmpdir(), 'freeaigateway-images');

// Fetch the generated asset and persist it as a PNG in the OS temp dir, then
// return its path (for the model) and basename (so the caller can serve it).
async function generateImage(prompt: string, aspect?: string): Promise<BuiltinToolResult> {
  const ratio = aspect === '16:9' || aspect === '9:16' || aspect === '1:1' ? aspect : '1:1';
  const url = `https://api.a0.dev/assets/image?text=${encodeURIComponent(prompt)}&aspect=${ratio}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`a0.dev ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const name = `img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
    const file = path.join(IMAGE_DIR, name);
    fs.writeFileSync(file, buf);
    return {
      content: `Image generated and saved to: ${file}\n(prompt: "${prompt}", aspect: ${ratio}). It is shown to the user automatically — no need to repeat the URL.`,
      imageFile: name,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Execute a built-in tool by name. `argsJson` is the model's raw arguments
// string. Always resolves (errors included as content) so the agent loop can
// hand the model a tool result and continue rather than crashing the request.
export async function executeBuiltinTool(name: string, argsJson: string): Promise<BuiltinToolResult> {
  let args: any = {};
  try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { /* tolerate non-JSON */ }
  try {
    switch (name) {
      case 'web_search': return { content: await webSearch(String(args.query ?? '')) };
      case 'web_extract': return { content: await webExtract(String(args.url ?? '')) };
      case 'generate_image': return await generateImage(String(args.prompt ?? ''), args.aspect);
      default: return { content: `Unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { content: `Tool "${name}" failed: ${err?.message ?? 'unknown error'}` };
  }
}
