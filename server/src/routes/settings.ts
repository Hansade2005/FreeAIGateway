import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUnifiedApiKey, regenerateUnifiedKey } from '../db/index.js';
import { getCacheConfig, setCacheConfig, getCacheStats, clearCache } from '../services/cache.js';

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
