import crypto from 'crypto';
import { getSetting, setSetting } from '../db/index.js';
import type { ChatMessage, ChatCompletionResponse } from '@freeaigateway/shared/types.js';

// ─────────────────────────────────────────────────────────────────────────
// Prompt/response cache.
//
// An identical request shouldn't burn a second free-tier call. This is a small
// in-memory TTL+LRU store keyed by a hash of the routing-relevant request shape
// (messages, model, tools, sampling knobs). On a hit the proxy returns the
// stored completion WITHOUT routing to any provider, which both saves quota and
// answers instantly. Opt-in (off by default) and per-request overridable.
//
// In-memory on purpose: the gateway is a single long-lived process, the value
// of a cache hit is highest within a session, and a process-local map needs no
// schema/migration. Config (enabled + TTL) is persisted in the settings table
// so it survives restarts and is editable from the dashboard.
// ─────────────────────────────────────────────────────────────────────────

export interface CachedCompletion {
  response: ChatCompletionResponse;
  platform: string;
  modelId: string;
  storedAt: number;
}

interface CacheEntry {
  value: CachedCompletion;
  expiresAt: number;
}

const MAX_ENTRIES = 1000;
const store = new Map<string, CacheEntry>();

const stats = { hits: 0, misses: 0, stores: 0 };

const CACHE_ENABLED_KEY = 'cache_enabled';
const CACHE_TTL_KEY = 'cache_ttl_seconds';
const DEFAULT_TTL_SECONDS = 3600; // 1h

export interface CacheConfig {
  enabled: boolean;
  ttlSeconds: number;
}

// Env provides the initial default; the persisted setting (once written from the
// dashboard) takes precedence.
function envDefaultEnabled(): boolean {
  return process.env.CACHE_ENABLED === '1' || process.env.CACHE_ENABLED === 'true';
}

export function getCacheConfig(): CacheConfig {
  const enabledSetting = getSetting(CACHE_ENABLED_KEY);
  const ttlSetting = getSetting(CACHE_TTL_KEY);
  const ttl = ttlSetting != null ? Number(ttlSetting) : (process.env.CACHE_TTL_SECONDS ? Number(process.env.CACHE_TTL_SECONDS) : DEFAULT_TTL_SECONDS);
  return {
    enabled: enabledSetting != null ? enabledSetting === '1' : envDefaultEnabled(),
    ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS,
  };
}

export function setCacheConfig(patch: Partial<CacheConfig>): CacheConfig {
  if (patch.enabled != null) setSetting(CACHE_ENABLED_KEY, patch.enabled ? '1' : '0');
  if (patch.ttlSeconds != null && Number.isFinite(patch.ttlSeconds) && patch.ttlSeconds > 0) {
    setSetting(CACHE_TTL_KEY, String(Math.floor(patch.ttlSeconds)));
  }
  // Disabling the cache clears it so stale entries can't be served after a later
  // re-enable.
  if (patch.enabled === false) clearCache();
  return getCacheConfig();
}

// Build a stable key from the parts of a request that change the answer. Routing
// internals (which provider serves it) are deliberately NOT part of the key —
// the cached value records where it came from, but an identical request hits
// regardless of current provider health.
export function buildCacheKey(params: {
  endpoint: string;
  model?: string;
  messages: ChatMessage[];
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}): string {
  const shape = {
    e: params.endpoint,
    m: params.model ?? 'auto',
    msgs: params.messages,
    tools: params.tools ?? null,
    tc: params.tool_choice ?? null,
    t: params.temperature ?? null,
    p: params.top_p ?? null,
    mt: params.max_tokens ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

export function getCached(key: string): CachedCompletion | undefined {
  const entry = store.get(key);
  if (!entry) { stats.misses++; return undefined; }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    stats.misses++;
    return undefined;
  }
  // LRU touch: re-insert so it moves to the most-recently-used end.
  store.delete(key);
  store.set(key, entry);
  stats.hits++;
  return entry.value;
}

export function setCached(key: string, value: CachedCompletion, ttlSeconds: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  stats.stores++;
  // Evict the oldest (Map preserves insertion/touch order) over the cap.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function clearCache(): void {
  store.clear();
}

export function getCacheStats() {
  const total = stats.hits + stats.misses;
  return {
    ...stats,
    entries: store.size,
    hitRate: total > 0 ? stats.hits / total : 0,
  };
}

// Test/maintenance helper: reset counters (does not clear stored entries).
export function resetCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.stores = 0;
}
