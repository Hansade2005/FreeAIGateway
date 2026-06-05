import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUnifiedApiKey } from '../db/index.js';
import { timingSafeStringEqual, extractApiToken, logRequest } from './proxy.js';

export const imagesRouter = Router();

// ─────────────────────────────────────────────────────────────────────────
// OpenAI-compatible image generation (POST /v1/images/generations).
//
// Backed by a0.dev's keyless text-to-image endpoint:
//   https://api.a0.dev/assets/image?text=<prompt>&aspect=<16:9|9:16|1:1>
//
// We FETCH the generated asset, save it as a PNG in the OS temp folder, and
// return its local file path (plus a gateway-served URL so the image is
// viewable, and optional b64_json). Accepts the OpenAI Images request shape so
// any OpenAI client/SDK works unchanged. No provider key required — it rides
// the gateway's unified key. See README "Image generation".
// ─────────────────────────────────────────────────────────────────────────

const A0_BASE = 'https://api.a0.dev/assets/image';
const PLATFORM = 'a0dev';
const MODEL_ID = 'a0-image';
const IMAGE_DIR = path.join(os.tmpdir(), 'freeaigateway-images');
const FILE_NAME_RE = /^img-\d+-[0-9a-f]+\.png$/;

type Aspect = '1:1' | '16:9' | '9:16';

function resolveAspect(size: string | undefined, aspect: string | undefined): Aspect {
  if (aspect === '1:1' || aspect === '16:9' || aspect === '9:16') return aspect;
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec((size ?? '').trim());
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > h) return '16:9';
    if (h > w) return '9:16';
  }
  return '1:1';
}

function a0Url(prompt: string, aspect: Aspect, seed?: number): string {
  const params = new URLSearchParams({ text: prompt, aspect });
  if (seed != null) params.set('seed', String(seed));
  return `${A0_BASE}?${params.toString()}`;
}

// Fetch the asset and persist it as a PNG in the OS temp dir; returns the
// absolute file path.
export async function fetchAndSaveImage(prompt: string, aspect: Aspect, seed?: number): Promise<string> {
  const res = await fetch(a0Url(prompt, aspect, seed));
  if (!res.ok) throw new Error(`a0.dev returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const name = `img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
  const file = path.join(IMAGE_DIR, name);
  fs.writeFileSync(file, buf);
  return file;
}

const imagesRequestSchema = z.object({
  prompt: z.string().min(1),
  n: z.number().int().min(1).max(10).optional(),
  size: z.string().optional(),
  aspect: z.enum(['1:1', '16:9', '9:16']).optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
  model: z.string().optional(),
}).passthrough();

// Serve a generated PNG back out (so the returned URL is actually viewable).
// Filename is strictly validated to prevent path traversal — only our own
// generated names ever resolve.
imagesRouter.get('/images/files/:name', (req: Request, res: Response) => {
  const name = String(req.params.name);
  if (!FILE_NAME_RE.test(name)) {
    res.status(400).json({ error: { message: 'invalid file name', type: 'invalid_request_error' } });
    return;
  }
  const file = path.join(IMAGE_DIR, name);
  if (!file.startsWith(IMAGE_DIR) || !fs.existsSync(file)) {
    res.status(404).json({ error: { message: 'image not found', type: 'not_found' } });
    return;
  }
  // Serve the ACTUAL image type. a0.dev returns WebP (not PNG), and with
  // helmet's `nosniff` a wrong Content-Type makes the browser refuse to render
  // it — so sniff the magic bytes instead of assuming image/png.
  res.setHeader('Content-Type', sniffImageType(file));
  fs.createReadStream(file).pipe(res);
});

// Detect image type from the file's leading bytes (PNG / WebP / JPEG / GIF),
// defaulting to PNG. Lets us send a correct Content-Type under `nosniff`.
function sniffImageType(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
    if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
    if (head.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    return 'image/png';
  } catch {
    return 'image/png';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

imagesRouter.post('/images/generations', async (req: Request, res: Response) => {
  const start = Date.now();

  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const parsed = imagesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).join(', ');
    res.status(400).json({ error: { message: `Invalid request: ${detail}`, type: 'invalid_request_error' } });
    return;
  }

  const { prompt, response_format } = parsed.data;
  const n = parsed.data.n ?? 1;
  const aspect = resolveAspect(parsed.data.size, parsed.data.aspect);
  const origin = `${req.protocol}://${req.get('host')}`;

  try {
    const data = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const file = await fetchAndSaveImage(prompt, aspect, n > 1 ? Date.now() + i : undefined);
        const url = `${origin}/v1/images/files/${path.basename(file)}`;
        if (response_format === 'b64_json') {
          return { b64_json: fs.readFileSync(file).toString('base64'), path: file, url };
        }
        // Default: the saved PNG path (the user's ask) plus a viewable URL.
        return { url, path: file };
      }),
    );

    res.setHeader('X-Routed-Via', `${PLATFORM}/${MODEL_ID}`);
    res.json({ created: Math.floor(Date.now() / 1000), data, model: MODEL_ID });
    logRequest(PLATFORM, MODEL_ID, 0, 'success', Math.ceil(prompt.length / 4), 0, Date.now() - start, null);
  } catch (err: any) {
    logRequest(PLATFORM, MODEL_ID, 0, 'error', Math.ceil(prompt.length / 4), 0, Date.now() - start, err?.message ?? 'image generation failed');
    res.status(502).json({ error: { message: `Image generation failed: ${err?.message ?? 'unknown'}`, type: 'provider_error' } });
  }
});
