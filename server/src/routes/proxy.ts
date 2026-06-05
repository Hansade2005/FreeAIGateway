import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage, ModelListRow } from '@freeaigateway/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, hasEnabledVisionModel, hasEnabledToolsModel, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit, PAYMENT_REQUIRED_COOLDOWN_MS } from '../services/ratelimit.js';
import { pruneRequestAnalytics } from '../services/request-retention.js';
import { runEmbeddings, EmbeddingsError } from '../services/embeddings.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { contentToString, messageHasImage, normalizeOutboundContent } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { getCacheConfig, buildCacheKey, getCached, setCached, type CachedCompletion } from '../services/cache.js';
import { getBuiltinToolsConfig, getEnabledBuiltinToolDefs, isBuiltinTool, executeBuiltinTool } from '../services/builtin-tools.js';
import type { BaseProvider, CompletionOptions } from '../providers/base.js';
import type { ChatCompletionResponse, ChatToolDefinition } from '@freeaigateway/shared/types.js';

// Agent loop for gateway-executed built-in tools (web_search/web_extract/
// generate_image). When the model answers with ONLY built-in tool calls, run
// them server-side, feed the results back, and re-ask — up to a small cap — so
// the client gets a finished answer. If the model calls a CLIENT tool (or mixes
// in one), we stop and hand the turn back so the client's own tool loop runs.
const MAX_BUILTIN_TOOL_ITERS = 5;
async function resolveBuiltinToolCalls(
  provider: BaseProvider,
  apiKey: string,
  modelId: string,
  first: ChatCompletionResponse,
  messages: ChatMessage[],
  opts: CompletionOptions,
  origin: string,
): Promise<ChatCompletionResponse> {
  let current = first;
  const convo: ChatMessage[] = [...messages];
  const imageUrls: string[] = [];
  for (let i = 0; i < MAX_BUILTIN_TOOL_ITERS; i++) {
    const calls = current.choices?.[0]?.message?.tool_calls ?? [];
    if (calls.length === 0) break;
    if (!calls.every((c) => isBuiltinTool(c.function.name))) break; // client tool present
    convo.push(current.choices[0].message);
    for (const c of calls) {
      const result = await executeBuiltinTool(c.function.name, c.function.arguments);
      convo.push({ role: 'tool', tool_call_id: c.id, content: result.content });
      // A generated PNG is served by GET /v1/images/files/:name (same temp dir).
      if (result.imageFile) imageUrls.push(`${origin}/v1/images/files/${result.imageFile}`);
    }
    current = await provider.chatCompletion(apiKey, convo, modelId, opts);
  }
  // Surface generated images inline: append them as markdown to the final
  // answer so any markdown-rendering client (e.g. the Playground) shows them.
  if (imageUrls.length) {
    const msg = current.choices?.[0]?.message;
    if (msg) {
      const base = contentToString(msg.content ?? '');
      const imgs = imageUrls.map((u) => `![generated image](${u})`).join('\n\n');
      msg.content = base ? `${base}\n\n${imgs}` : imgs;
    }
  }
  return current;
}

export const proxyRouter = Router();

// A request opts out of the cache with `x-cache: no-store` (or a no-store/
// no-cache Cache-Control). Used by callers that need a fresh generation.
function cacheOptedOut(req: Request): boolean {
  const header = String(req.headers['x-cache'] ?? req.headers['cache-control'] ?? '');
  return /no-store|no-cache/i.test(header);
}

// Virtual "auto" model. Clients like Hermes require a non-empty `model` field
// on every request, but FreeAIGateway's whole point is to pick the model itself.
// Requesting this id means "let the router decide" — identical to omitting
// `model` entirely.
const AUTO_MODEL_ID = 'auto';

function isAutoModel(modelId: string | undefined): boolean {
  return modelId === AUTO_MODEL_ID;
}

// Constant-time string comparison for the unified API key. Plain `===` leaks
// length and per-character timing, which a network attacker could in principle
// use to recover the key one byte at a time.
export function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compare against a same-length buffer regardless of input length so the
  // comparison itself runs in constant time; the explicit length check at the
  // end is what actually decides equality when lengths differ.
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}

// Extract the unified API key from an incoming request. Accepts both the
// OpenAI-style `Authorization: Bearer <key>` header and the Anthropic-style
// `x-api-key` header. Clients that speak the Anthropic wire format — notably
// Claude Code routed through CC Switch (#103) — send the key in `x-api-key`
// rather than a bearer token, and were getting a spurious "Invalid API key"
// 401 before this fallback existed.
export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const apiKeyHeader = req.headers['x-api-key'];
  const xApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const trimmed = xApiKey?.trim();
  return trimmed || undefined;
}

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function getSessionKey(messages: ChatMessage[]): string {
  // Use the first user message as session identifier — clients like Hermes
  // re-send the full conversation each turn, so the first user message is
  // stable across turns. Hash the FULL message (not a 100-char slice) so
  // distinct conversations with identical openings don't collide.
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser || typeof firstUser.content !== 'string') return '';
  const hash = crypto.createHash('sha1').update(firstUser.content).digest('hex');
  return `${hash}:${messages.length > 2 ? 'multi' : 'single'}`;
}

export function getStickyModel(messages: ChatMessage[]): number | undefined {
  // Only apply sticky for multi-turn (has assistant messages = continuation)
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(messages);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

export function setStickyModel(messages: ChatMessage[], modelDbId: number) {
  const key = getSessionKey(messages);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

// OpenAI-compatible /models endpoint (used by Hermes for metadata)
proxyRouter.get('/models', (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const db = getDb();
  const models = db.prepare(`
    SELECT platform, model_id, display_name, context_window
    FROM (
      SELECT platform, model_id, display_name, context_window, intelligence_rank, id,
             ROW_NUMBER() OVER (
               PARTITION BY model_id
               ORDER BY intelligence_rank ASC, id ASC
             ) AS rn
      FROM models
      WHERE enabled = 1
    )
    WHERE rn = 1
    ORDER BY intelligence_rank ASC, id ASC
  `).all() as ModelListRow[];

  res.json({
    object: 'list',
    data: [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freeaigateway',
        name: 'Auto (router picks the best available model)',
        context_window: null,
      },
      ...models.map(m => ({
        id: m.model_id,
        object: 'model',
        created: 0,
        owned_by: m.platform,
        name: m.display_name,
        context_window: m.context_window,
      })),
    ],
  });
});

const MAX_RETRIES = 20;

// Echo-tolerant tool calls: agents replay OUR responses back as history, and
// not all of them preserve the strict OpenAI shape. `type` may be dropped
// (re-added on forward), Gemini-lineage agents (Qwen Code, AionUI) often
// send `arguments` as a parsed object instead of a JSON string, and `id` may
// be missing or empty (ids aren't a Gemini concept) — all get normalized
// below rather than 400-ing the whole session. Missing ids are synthesized
// and paired with their tool-result messages by order. (#200)
const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
  thought_signature: z.string().optional(),
});

const toolCallArgsToString = (args: string | Record<string, unknown>): string =>
  typeof args === 'string' ? args : JSON.stringify(args);

// OpenAI multimodal envelope. Clients like opencode / continue.dev send
// content as an array of typed blocks even when only text is present, and
// Gemini-lineage agents send part-style blocks like `{ "text": "..." }` with
// no `type` at all. Accept any object (or bare string) as a block; flatten to
// string for providers that don't support arrays (Cohere, Cloudflare).
// Non-text blocks pass z validation but get dropped by contentToString —
// vision/audio still isn't supported. (#200)
const contentBlockSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: contentSchema,
  name: z.string().optional(),
});

// OpenAI's newer SDKs send the system prompt as role:"developer"; accept it
// and forward as "system" — none of the routed providers know the developer
// role. (#200)
const developerMessageSchema = z.object({
  role: z.literal('developer'),
  content: contentSchema,
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: contentSchema,
  name: z.string().optional(),
});

// Assistant turns may carry empty/null content and no tool_calls — OpenAI
// accepts these in conversation history (a turn that produced no visible text,
// a placeholder, a tool turn whose content was emptied), and clients replay
// them verbatim. We accept them too and coerce empty/null content to "" before
// forwarding (see message build below) rather than 400-ing a payload OpenAI
// would take. (#165)
const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([contentSchema, z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

// Tool results may arrive with null/missing content (a tool that returned
// nothing) and a missing/empty tool_call_id (Gemini-lineage agents) — coerced
// to "" and paired by order with the preceding tool_calls respectively. (#200)
const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.union([contentSchema, z.null()]).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

// Legacy function-calling shape (pre-tools OpenAI API). Old clients still
// replay these in history; forwarded as a tool message. (#200)
const functionMessageSchema = z.object({
  role: z.literal('function'),
  name: z.string().min(1),
  content: z.union([contentSchema, z.null()]).optional(),
});

const toolDefinitionSchema = z.object({
  // Some agents omit `type` on tool definitions; re-defaulted to 'function'
  // on forward. (#200)
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  // 'any' is the Mistral/Gemini wording for OpenAI's 'required'; mapped on
  // forward. (#200)
  z.enum(['none', 'auto', 'required', 'any']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    developerMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
    functionMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  // Some clients send max_tokens <= 0 (or -1) to mean "no limit"; accepted and
  // treated as unset on forward. (#200)
  max_tokens: z.number().int().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
});

export function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    // 413: this model's payload limit is too small for the request, but another
    // provider in the fallback chain may have a larger limit. Same reasoning as 503.
    || msg.includes('413') || msg.includes('payload too large') || msg.includes('request body too large')
    || msg.includes('request entity too large') || msg.includes('content too large')
    // 404: model deprecated/removed upstream (e.g. OpenRouter's "no endpoints found"
    // for a model that's been pulled). Rotate to the next model in the chain —
    // setCooldown + the health checker will avoid this model on subsequent requests.
    || msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
    // 400: one provider may reject parameters another accepts (e.g. max_tokens
    // limits, unsupported params). The matching pattern is "api error 400"
    // which comes from the OpenAI-compat provider's error formatting, not
    // a bare "400" which is deliberately non-retryable for validation errors.
    || msg.includes('api error 400')
    // 402: this provider/key is out of credits (e.g. HuggingFace Router
    // "API error 402: Payment required"). The SAME model often lives on another
    // provider (Kimi K2.6 is on HF + Cloudflare + NVIDIA), so fail over instead
    // of killing the workflow. Paired with a long cooldown (isPaymentRequiredError)
    // so we don't re-hammer the broke key every retry.
    || isPaymentRequiredError(err);
}

// A 402 Payment Required / out-of-credits error. Distinct from a transient 429:
// it won't recover on the next window, so the caller benches the model+key with
// PAYMENT_REQUIRED_COOLDOWN_MS (a full day) rather than the 90s transient cooldown.
export function isPaymentRequiredError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('402') || msg.includes('payment required')
    || msg.includes('insufficient_quota') || msg.includes('insufficient credit')
    || msg.includes('insufficient balance');
}

// Pull the incremental text out of a streaming chunk for token counting.
// Must tolerate chunks that carry no `choices` array at all: some providers
// (e.g. Groq) emit usage/keepalive frames shaped like `{usage:{...}}` with no
// `choices`. Indexing `chunk.choices[0]` on those throws "Cannot read
// properties of undefined (reading '0')", which — once the SSE stream has
// started — aborts the response mid-flight with no chance to fall back.
export function streamChunkText(chunk: any): string {
  return chunk?.choices?.[0]?.delta?.content ?? '';
}

// OpenAI-compatible embeddings endpoint, routed through the embeddings family
// catalog: `model: "auto"` (or omitted) → the configured default family; a
// family name or provider model id → that family's provider chain. Failover
// only happens WITHIN a family (same model on another provider) — never across
// models, since vectors from different models are incompatible.
const EmbeddingsBody = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
});

proxyRouter.post('/embeddings', async (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }
  const parsed = EmbeddingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' } });
    return;
  }
  const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input];
  try {
    const result = await runEmbeddings(parsed.data.model, inputs);
    res.json({
      object: 'list',
      data: result.vectors.map((values, i) => ({ object: 'embedding', index: i, embedding: values })),
      model: result.family,
      provider: result.platform,
      usage: { prompt_tokens: result.inputTokens, total_tokens: result.inputTokens },
    });
  } catch (err: any) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({ error: { message: `embedding error: ${err?.message ?? 'unknown'}`, type } });
  }
});

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();

  // Authenticate with the unified API key for every proxy request, including
  // loopback callers. Browser pages can reach localhost, so socket locality is
  // not a reliable authorization boundary.
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  // Validate request
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    // Path-qualified issues ("messages.1.content: Invalid input" beats a bare
    // "Invalid input") and a server-side breadcrumb — these rejections never
    // reach the request log, which made #200 nearly undebuggable.
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    console.warn(`[proxy] 400 invalid /chat/completions request: ${detail}`);
    res.status(400).json({
      error: {
        message: `Invalid request: ${detail}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { model: requestedModel, temperature, top_p, stream, parallel_tool_calls } = parsed.data;
  // Agent-tolerant knob normalization (#200): max_tokens <= 0 means "no
  // limit" in several clients → unset; tool_choice 'any' is OpenAI's
  // 'required'; tool definitions get their 'function' type re-defaulted.
  const max_tokens = parsed.data.max_tokens != null && parsed.data.max_tokens > 0
    ? parsed.data.max_tokens : undefined;
  const tool_choice = parsed.data.tool_choice === 'any' ? 'required' as const : parsed.data.tool_choice;
  const tools = parsed.data.tools?.map(t => ({ ...t, type: 'function' as const }));

  // Built-in (gateway-executed) tools. Injected only on the non-streaming path,
  // only when a tool-capable model is enabled (so plain chat isn't forced onto
  // a narrower pool when none exists), and only if the caller didn't opt out
  // (`x-builtin-tools: off`). Merged with any client tools; the agent loop in
  // the non-stream branch resolves them. Default-on, toggleable in Settings.
  const builtinCfg = getBuiltinToolsConfig();
  const builtinOptOut = String(req.headers['x-builtin-tools'] ?? '').toLowerCase() === 'off';
  // Built-ins augment only the gateway's signature AUTO-routed path: no explicit
  // model pin (honor an exact model choice verbatim), no client tools (an agent
  // client keeps full control of its own toolset), non-streaming, not opted out,
  // and only when a tool-capable model actually exists to run them.
  const clientSentTools = (tools?.length ?? 0) > 0;
  const autoRouted = !requestedModel || isAutoModel(requestedModel);
  // Non-streaming only: the agent loop makes several upstream calls, which can't
  // run over a live token stream. Clients that want the tools send stream:false
  // (the Playground does this automatically when built-ins are active).
  const useBuiltinTools = !stream && builtinCfg.enabled && !builtinOptOut && !clientSentTools && autoRouted && hasEnabledToolsModel();
  const builtinToolDefs: ChatToolDefinition[] = useBuiltinTools ? getEnabledBuiltinToolDefs(builtinCfg) : [];
  const effectiveTools = builtinToolDefs.length ? [...(tools ?? []), ...builtinToolDefs] : tools;

  // Pairing state for id-less tool calls (#200): every tool_call id (given or
  // synthesized) queues up here; a tool message without a tool_call_id takes
  // the oldest unanswered one, which matches the single-call-per-turn flow
  // Gemini-lineage agents produce.
  const pendingToolCallIds: string[] = [];
  let syntheticIdCounter = 0;
  const takeToolCallId = (given: string | undefined): string => {
    if (given && given.length > 0) {
      const qi = pendingToolCallIds.indexOf(given);
      if (qi !== -1) pendingToolCallIds.splice(qi, 1);
      return given;
    }
    return pendingToolCallIds.shift() ?? `call_auto_${++syntheticIdCounter}`;
  };

  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      const hasToolCalls = (m.tool_calls?.length ?? 0) > 0;
      // With tool_calls, content: null is the correct OpenAI shape — keep it.
      // Without tool_calls, coerce empty/null content to "" so strict upstreams
      // don't choke on a null-content assistant turn we just accepted. (#165)
      const isEmptyContent = m.content == null
        || (typeof m.content === 'string' && m.content.length === 0)
        || (Array.isArray(m.content) && m.content.length === 0);
      const assistantContent: ChatMessage['content'] = hasToolCalls
        ? (m.content ?? null)
        : (isEmptyContent ? '' : m.content!);
      return {
        role: 'assistant',
        content: assistantContent,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => {
          // Normalize echo-tolerant inputs back to the strict OpenAI shape
          // before forwarding (see toolCallSchema); synthesize missing ids
          // and queue every id for order-based tool-result pairing. (#200)
          const id = tc.id && tc.id.length > 0 ? tc.id : `call_auto_${++syntheticIdCounter}`;
          pendingToolCallIds.push(id);
          return {
            id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: toolCallArgsToString(tc.function.arguments) },
            thought_signature: tc.thought_signature,
          };
        }) } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        // Null/missing content (a tool that returned nothing) → "". (#200)
        content: m.content ?? '',
        tool_call_id: takeToolCallId(m.tool_call_id),
        ...(m.name ? { name: m.name } : {}),
      };
    }

    // Legacy function-calling result → forward as a tool message, paired by
    // order like an id-less tool message. (#200)
    if (m.role === 'function') {
      return {
        role: 'tool',
        content: m.content ?? '',
        tool_call_id: takeToolCallId(undefined),
        name: m.name,
      };
    }

    return {
      // 'developer' is OpenAI's newer name for the system role — providers
      // downstream only know 'system'. (#200)
      role: m.role === 'developer' ? 'system' : m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  });

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  const estimatedInputTokens = messages.reduce((sum, m) => {
    const text = contentToString(m.content);
    return sum + Math.ceil(text.length / 4);
  }, 0);

  // Prompt cache (opt-in): an identical request returns the stored completion
  // without routing to any provider — saving a free-tier call and answering
  // instantly. The key covers the answer-affecting request shape; routing
  // internals are excluded so a repeat hits regardless of current provider
  // health. Streaming hits replay the cached completion as a single SSE frame.
  const cacheCfg = getCacheConfig();
  const cacheKey = cacheCfg.enabled && !cacheOptedOut(req)
    ? buildCacheKey({ endpoint: 'chat', model: requestedModel, messages, tools: effectiveTools, tool_choice, temperature, top_p, max_tokens })
    : null;
  if (cacheKey) {
    const hit = getCached(cacheKey);
    if (hit) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Routed-Via', `${hit.platform}/${hit.modelId}`);
      logRequest(hit.platform, hit.modelId, 0, 'success', hit.response.usage?.prompt_tokens ?? 0, hit.response.usage?.completion_tokens ?? 0, Date.now() - start, null);
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const msg = hit.response.choices?.[0]?.message;
        const chunk = {
          id: hit.response.id, object: 'chat.completion.chunk', created: hit.response.created, model: hit.response.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: contentToString(msg?.content ?? ''), ...(msg?.tool_calls ? { tool_calls: msg.tool_calls } : {}) }, finish_reason: 'stop' }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.json(hit.response);
      }
      return;
    }
  }

  // Image requests must route to a vision-capable model. Reject up front with a
  // clear message when none is enabled, rather than silently dropping the image
  // or surfacing the generic "all models exhausted" error (#118, #125). Add a
  // rough per-image token cost so budget routing isn't skewed by content the
  // heuristic above (text-only) can't see.
  const hasImage = messageHasImage(messages);
  if (hasImage && !hasEnabledVisionModel()) {
    res.status(422).json({
      error: {
        message: 'This request includes an image, but no vision-capable model is enabled. Enable a vision model (e.g. Gemini 2.5 Flash, Llama 4 Scout) in the Fallback Chain.',
        type: 'invalid_request_error',
        code: 'no_vision_model',
      },
    });
    return;
  }
  const IMAGE_TOKEN_ESTIMATE = 1000;
  const imageCount = messages.reduce((n, m) =>
    n + (Array.isArray(m.content) ? m.content.filter(b => (b as { type?: string })?.type === 'image_url' || (b as { type?: string })?.type === 'image').length : 0), 0);
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + (max_tokens ?? 1000);

  // Tool-bearing requests must route to a model that emits STRUCTURED
  // tool_calls. A model without real function-calling support serializes the
  // call into its text answer — the request "succeeds" but the client's tool
  // loop sees nothing, which is strictly worse than an error. Same up-front
  // gate pattern as vision above.
  const wantsTools = (effectiveTools?.length ?? 0) > 0;
  if (wantsTools && !hasEnabledToolsModel()) {
    res.status(422).json({
      error: {
        message: 'This request includes tools, but no tool-capable model is enabled. Enable a tool-calling model (e.g. GPT-OSS 120B, Gemini 3.5 Flash, GLM-4.7) in the Fallback Chain.',
        type: 'invalid_request_error',
        code: 'no_tools_model',
      },
    });
    return;
  }

  // Explicit `model` field pins routing. If the catalog has no enabled row
  // matching the requested id, return 400 — silently auto-routing to a
  // different model would be surprising to OpenAI-compatible clients.
  // Sticky-session is the fallback when no `model` field was sent at all.
  let preferredModel: number | undefined;
  if (isAutoModel(requestedModel)) {
    // Explicit "auto" → behave exactly like an omitted model field.
    preferredModel = getStickyModel(messages);
  } else if (requestedModel) {
    const db = getDb();
    const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
    if (enabled) {
      preferredModel = enabled.id;
    } else {
      const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
      const reason = disabled ? 'is disabled' : 'is not in the catalog';
      res.status(400).json({
        error: {
          message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
      return;
    }
  } else {
    preferredModel = getStickyModel(messages);
  }

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, hasImage, wantsTools);
    } catch (err: any) {
      // No more models available
      if (lastError) {
        const safeLastError = sanitizeProviderErrorMessage(lastError.message);
        res.status(429).json({
          error: {
            message: `All models rate-limited. Last error: ${safeLastError}`,
            type: 'rate_limit_error',
          },
        });
      } else {
        res.status(err.status ?? 503).json({
          error: { message: err.message, type: 'routing_error' },
        });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        // Lazy header set: pre-stream errors stay retryable (no headers sent yet);
        // mid-stream errors emit an `error` SSE frame so the client sees a real signal
        // instead of a silently truncated stream.
        let totalOutputTokens = 0;
        let streamStarted = false;
        let ttfbMs: number | null = null;
        // Accumulate the assistant text so a successful stream can populate the
        // prompt cache. Tool-call streams aren't cached (reassembling structured
        // calls from index-based deltas is error-prone) — sawToolCalls skips it.
        let cachedText = '';
        let sawToolCalls = false;
        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, messages, route.modelId,
            { temperature, max_tokens, top_p, tools: effectiveTools, tool_choice, parallel_tool_calls },
          );

          for await (const chunk of gen) {
            if (!streamStarted) {
              // Time-to-first-byte: dispatch → first chunk. Feeds the router's
              // latency axis (server/src/services/scoring.ts).
              ttfbMs = Date.now() - start;
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
              if (cacheKey) res.setHeader('X-Cache', 'MISS');
              if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
              streamStarted = true;
            }
            // Coerce array-shaped delta.content to a string before forwarding,
            // so spec-conforming clients don't break and tool_calls survive (#166).
            normalizeOutboundContent(chunk);
            const text = streamChunkText(chunk);
            totalOutputTokens += Math.ceil(text.length / 4);
            cachedText += text;
            if ((chunk.choices?.[0]?.delta?.tool_calls?.length ?? 0) > 0) sawToolCalls = true;
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          if (!streamStarted) {
            // Upstream returned zero chunks — an empty completion in stream
            // clothing. No headers are out yet, so fail over to the next model
            // instead of handing the client a valid-looking empty stream
            // (production case: nemotron-3-super returning nothing on large
            // contexts while the request logs as success).
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, 'empty completion (stream produced no chunks)');
            skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
            setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
            recordRateLimitHit(route.modelDbId);
            lastError = new Error(`empty completion from ${route.displayName}`);
            continue;
          }
          res.write('data: [DONE]\n\n');
          res.end();

          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messages, route.modelDbId);
          // Populate the cache from a clean text stream (no tool calls).
          if (cacheKey && !sawToolCalls && cachedText) {
            const synthesized: CachedCompletion = {
              response: {
                id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: route.modelId,
                choices: [{ index: 0, message: { role: 'assistant', content: cachedText }, finish_reason: 'stop' }],
                usage: { prompt_tokens: estimatedInputTokens, completion_tokens: totalOutputTokens, total_tokens: estimatedInputTokens + totalOutputTokens },
              },
              platform: route.platform, modelId: route.modelId, storedAt: Date.now(),
            };
            setCached(cacheKey, synthesized, cacheCfg.ttlSeconds);
          }
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null, ttfbMs);
          return;
        } catch (streamErr: any) {
          if (streamStarted) {
            // Mid-stream error — finish the SSE response cleanly instead of leaving
            // the client hanging or letting Express's default handler take over.
            // Full upstream message goes to the log; the client sees a generic
            // message so we don't leak provider internals into a partial stream.
            console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, sanitizeProviderErrorMessage(streamErr.message));
            return;
          }
          // Pre-stream error — bubble to outer retry/502 handler.
          throw streamErr;
        }
      } else {
        const completionOpts = { temperature, max_tokens, top_p, tools: effectiveTools, tool_choice, parallel_tool_calls };
        let result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, completionOpts);

        // Built-in tool agent loop: resolve any gateway-executed tool calls
        // server-side before returning, so the client gets a finished answer.
        if (builtinToolDefs.length) {
          const origin = `${req.protocol}://${req.get('host')}`;
          result = await resolveBuiltinToolCalls(route.provider, route.apiKey, route.modelId, result, messages, completionOpts, origin);
        }

        // Empty completion (no text, no tool calls) → fail over rather than
        // return a transport-level "success" the caller can't act on. Mirrors
        // the zero-chunk streaming case above.
        const respMsg = result.choices?.[0]?.message;
        const respText = contentToString(respMsg?.content ?? '');
        if (!respText && (respMsg?.tool_calls?.length ?? 0) === 0) {
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, 'empty completion (no content, no tool_calls)');
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
          setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
          recordRateLimitHit(route.modelDbId);
          lastError = new Error(`empty completion from ${route.displayName}`);
          continue;
        }

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (cacheKey) res.setHeader('X-Cache', 'MISS');
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        // Repair double-encoded tool arguments against the request's tool
        // schemas (e.g. GLM emitting an array parameter as a JSON string),
        // so strict clients don't reject the call. Schema-gated — a true
        // string parameter is never touched. See lib/tool-args.ts.
        if (respMsg?.tool_calls?.length) {
          const schemas = toolSchemaMap(tools);
          for (const tc of respMsg.tool_calls) {
            if (tc?.function?.arguments != null) {
              tc.function.arguments = repairToolArguments(tc.function.arguments, schemas.get(tc.function.name));
            }
          }
        }
        // Normalize array-shaped message.content to a string on the way out (#166).
        const normalized = normalizeOutboundContent(result);
        // Cache the completed answer (tool calls included — they're already
        // fully formed here, unlike the streamed path).
        if (cacheKey) {
          setCached(cacheKey, { response: normalized, platform: route.platform, modelId: route.modelId, storedAt: Date.now() }, cacheCfg.ttlSeconds);
        }
        res.json(normalized);

        logRequest(
          route.platform, route.modelId, route.keyId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Date.now() - start, null,
        );
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError);

      if (isRetryableError(err)) {
        // Put this model+key on cooldown and try the next one
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        setCooldown(
          route.platform,
          route.modelId,
          route.keyId,
          isPaymentRequiredError(err)
            ? PAYMENT_REQUIRED_COOLDOWN_MS
            : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, {
                rpd: route.rpdLimit,
                tpd: route.tpdLimit,
              }),
        );
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Proxy] ${safeError.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Non-retryable error (auth, 4xx, etc.): don't retry
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${safeError}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  // Exhausted all retries
  res.status(429).json({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${sanitizeProviderErrorMessage(lastError?.message)}`,
      type: 'rate_limit_error',
    },
  });
});

export function logRequest(
  platform: string,
  modelId: string,
  keyId: number,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  ttfbMs: number | null = null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error, ttfbMs);
    pruneRequestAnalytics({ db });
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
