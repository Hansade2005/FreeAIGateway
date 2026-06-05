import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUnifiedApiKey, regenerateUnifiedKey } from '../db/index.js';
import { getCacheConfig, setCacheConfig, getCacheStats, clearCache } from '../services/cache.js';
import { getBuiltinToolsConfig, setBuiltinToolsConfig } from '../services/builtin-tools.js';

export const settingsRouter = Router();

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// Prompt-cache config + live stats.
settingsRouter.get('/cache', (_req: Request, res: Response) => {
  res.json({ ...getCacheConfig(), stats: getCacheStats() });
});

const cachePatchSchema = z.object({
  enabled: z.boolean().optional(),
  ttlSeconds: z.number().int().min(1).max(2_592_000).optional(), // 1s … 30d
});

settingsRouter.patch('/cache', (req: Request, res: Response) => {
  const parsed = cachePatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid cache settings', type: 'invalid_request_error' } });
    return;
  }
  const config = setCacheConfig(parsed.data);
  res.json({ ...config, stats: getCacheStats() });
});

// Flush all cached completions (config unchanged).
settingsRouter.post('/cache/clear', (_req: Request, res: Response) => {
  clearCache();
  res.json({ ...getCacheConfig(), stats: getCacheStats() });
});

// Built-in (server-executed) tools config — master switch + per-tool flags.
settingsRouter.get('/tools', (_req: Request, res: Response) => {
  res.json(getBuiltinToolsConfig());
});

const toolsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  web_search: z.boolean().optional(),
  web_extract: z.boolean().optional(),
  generate_image: z.boolean().optional(),
});

settingsRouter.patch('/tools', (req: Request, res: Response) => {
  const parsed = toolsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid tools settings', type: 'invalid_request_error' } });
    return;
  }
  res.json(setBuiltinToolsConfig(parsed.data));
});
