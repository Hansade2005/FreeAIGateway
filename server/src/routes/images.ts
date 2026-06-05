import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUnifiedApiKey } from '../db/index.js';
import { timingSafeStringEqual, extractApiToken, logRequest } from './proxy.js';

export const imagesRouter = Router();

// ─────────────────────────────────────────────────────────────────────────
// OpenAI-compatible image generation (POST /v1/images/generations).
//
// Backed by a0.dev's keyless text-to-image asset endpoint:
//   https://api.a0.dev/assets/image?text=<prompt>&aspect=<16:9|9:16|1:1>
//
// We accept the OpenAI Images request shape (prompt, n, size, response_format)
// so any OpenAI client/SDK works unchanged, translate `size` → a0.dev `aspect`,
// and return the OpenAI `{ created, data: [{ url } | { b64_json }] }` envelope.
// No provider key required (it rides the gateway's unified key like every other
// endpoint). See README "Image generation".
// ─────────────────────────────────────────────────────────────────────────

const A0_BASE = 'https://api.a0.dev/assets/image';
const PLATFORM = 'a0dev';
const MODEL_ID = 'a0-image';

type Aspect = '1:1' | '16:9' | '9:16';

// Map an OpenAI `size` ("1024x1024", "1792x1024", …) to an a0.dev aspect.
// An explicit `aspect` field (our extension) wins when valid.
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

function buildImageUrl(prompt: string, aspect: Aspect, seed?: number): string {
  const params = new URLSearchParams({ text: prompt, aspect });
  if (seed != null) params.set('seed', String(seed));
  return `${A0_BASE}?${params.toString()}`;
}

const imagesRequestSchema = z.object({
  prompt: z.string().min(1),
  // `n` images; a0.dev is one-image-per-URL, so n>1 returns n seeded variants.
  n: z.number().int().min(1).max(10).optional(),
  size: z.string().optional(),
  aspect: z.enum(['1:1', '16:9', '9:16']).optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
  model: z.string().optional(),
}).passthrough();

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
  // n>1 gets distinct seeds so callers get variants rather than identical URLs.
  const urls = Array.from({ length: n }, (_, i) => buildImageUrl(prompt, aspect, n > 1 ? Date.now() + i : undefined));

  try {
    let data: Array<{ url: string } | { b64_json: string }>;
    if (response_format === 'b64_json') {
      // Fetch each asset and inline it as base64 (OpenAI b64_json parity).
      data = await Promise.all(urls.map(async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`a0.dev returned ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        return { b64_json: buf.toString('base64') };
      }));
    } else {
      data = urls.map((url) => ({ url }));
    }

    res.setHeader('X-Routed-Via', `${PLATFORM}/${MODEL_ID}`);
    res.json({ created: Math.floor(Date.now() / 1000), data, model: MODEL_ID });
    logRequest(PLATFORM, MODEL_ID, 0, 'success', Math.ceil(prompt.length / 4), 0, Date.now() - start, null);
  } catch (err: any) {
    logRequest(PLATFORM, MODEL_ID, 0, 'error', Math.ceil(prompt.length / 4), 0, Date.now() - start, err?.message ?? 'image generation failed');
    res.status(502).json({ error: { message: `Image generation failed: ${err?.message ?? 'unknown'}`, type: 'provider_error' } });
  }
});
