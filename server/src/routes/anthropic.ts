import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
  ChatContentBlock,
} from '@freeaigateway/shared/types.js';
import {
  routeRequest,
  recordRateLimitHit,
  recordSuccess,
  hasEnabledToolsModel,
  hasEnabledVisionModel,
  type RouteResult,
} from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit, PAYMENT_REQUIRED_COOLDOWN_MS } from '../services/ratelimit.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { contentToString, messageHasImage } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import {
  isRetryableError,
  isPaymentRequiredError,
  timingSafeStringEqual,
  extractApiToken,
  getStickyModel,
  setStickyModel,
  logRequest,
} from './proxy.js';

export const anthropicRouter = Router();

// ─────────────────────────────────────────────────────────────────────────
// Anthropic Messages API shim (POST /v1/messages, POST /v1/messages/count_tokens).
//
// FreeAIGateway is "one gateway, two protocols": alongside the OpenAI-compatible
// /v1/chat/completions and the Responses shim, this endpoint speaks the native
// Anthropic Messages wire format so Claude-native clients — Claude Code, the
// Anthropic SDKs, Claude Desktop via a custom base URL, LibreChat's Anthropic
// channel — can point straight at the gateway and get answered by ANY of the
// free providers behind it.
//
// It accepts an Anthropic-shaped request, translates it into the internal chat
// message format, runs it through the SAME router/retry machinery as the proxy,
// and translates the result back into the Anthropic message object / SSE event
// stream the client expects.
//
// Deliberately self-contained, mirroring routes/responses.ts: it duplicates the
// proxy's retry loop rather than refactoring that battle-tested handler, so the
// production /chat/completions path is untouched. Shared, side-effect-free
// helpers (routing, rate-limit bookkeeping, sticky sessions, logging) are
// imported, not re-implemented.
// ─────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 20;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
}

// ── Request schema ──────────────────────────────────────────────────────
// Lenient on purpose: the Messages API surface is large and clients (Claude
// Code especially) ship many optional fields we don't consume. Unknown fields
// (metadata, container, mcp_servers, service_tier, thinking, …) are accepted
// and ignored via .passthrough().

const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).passthrough();

// Anthropic image blocks: base64 (`source.data` + `media_type`) or url
// (`source.url`). Both translate to an OpenAI `image_url` block so vision-
// capable providers can consume them.
const imageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.enum(['base64', 'url']),
    media_type: z.string().optional(),
    data: z.string().optional(),
    url: z.string().optional(),
  }).passthrough(),
}).passthrough();

const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  // Tool output is a string or an array of (mostly text/image) content blocks.
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).optional(),
  is_error: z.boolean().optional(),
}).passthrough();

// Any other block type (document, thinking, redacted_thinking, server_tool_use,
// …) is accepted and flattened/ignored at translation rather than 400-ing.
const unknownBlockSchema = z.object({ type: z.string() }).passthrough();

const contentBlockSchema = z.union([
  textBlockSchema,
  imageBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  unknownBlockSchema,
]);

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

// `system` can be a bare string or an array of text blocks (the cache-control
// shape Claude Code uses).
const systemSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough()),
]);

const anthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  // Custom tools carry an input_schema; built-in/server tools (web_search,
  // computer_*, bash_*, text_editor_*) instead carry a `type` and no schema —
  // those are dropped at conversion since chat-completions providers can't run
  // them.
  input_schema: z.record(z.string(), z.unknown()).optional(),
  type: z.string().optional(),
}).passthrough();

const anthropicToolChoiceSchema = z.union([
  z.object({ type: z.literal('auto') }).passthrough(),
  z.object({ type: z.literal('any') }).passthrough(),
  z.object({ type: z.literal('none') }).passthrough(),
  z.object({ type: z.literal('tool'), name: z.string() }).passthrough(),
]);

const messagesRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  system: systemSchema.optional(),
  // Required by the real Anthropic API; we tolerate omission and default it.
  max_tokens: z.number().int().optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  tools: z.array(anthropicToolSchema).optional(),
  tool_choice: anthropicToolChoiceSchema.optional(),
}).passthrough();

type MessagesRequest = z.infer<typeof messagesRequestSchema>;

// ── Translation: Anthropic request → internal chat messages ──────────────

// Flatten an Anthropic content-block array (or string) to plain text. Text
// blocks contribute their text; non-text blocks are dropped (parity with the
// proxy's contentToString). Used for system prompts and tool_result content.
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const block = b as { type?: string; text?: unknown };
      return typeof block?.text === 'string' && (block.type === 'text' || block.type === undefined)
        ? block.text
        : '';
    })
    .join('');
}

function systemToText(system: MessagesRequest['system']): string {
  if (!system) return '';
  return typeof system === 'string' ? system : blocksToText(system);
}

// Anthropic image block → OpenAI image_url content block, so vision-capable
// providers receive it through the existing chat-completions path.
function imageBlockToOpenAI(block: z.infer<typeof imageBlockSchema>): ChatContentBlock | null {
  const src = block.source;
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  if (src.type === 'base64' && src.data) {
    const mediaType = src.media_type || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${src.data}` } };
  }
  return null;
}

export function toChatMessages(req: MessagesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  const system = systemToText(req.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      // Assistant turn: collect text + tool_use blocks into one chat message.
      const textParts: string[] = [];
      const toolCalls: ChatToolCall[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push((block as z.infer<typeof textBlockSchema>).text);
        } else if (block.type === 'tool_use') {
          const tu = block as z.infer<typeof toolUseBlockSchema>;
          toolCalls.push({
            id: tu.id,
            type: 'function',
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
          });
        }
      }
      const text = textParts.join('');
      messages.push({
        role: 'assistant',
        content: toolCalls.length > 0 ? (text || null) : text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // User turn. tool_result blocks become standalone `tool` messages (OpenAI
    // requires the tool role for results); remaining text/image blocks form a
    // single user message AFTER the tool results, preserving wire order.
    const userBlocks: ChatContentBlock[] = [];
    let userHasImage = false;
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const tr = block as z.infer<typeof toolResultBlockSchema>;
        const resultText = blocksToText(tr.content ?? '');
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: tr.is_error ? `Error: ${resultText}` : resultText,
        });
      } else if (block.type === 'text') {
        userBlocks.push({ type: 'text', text: (block as z.infer<typeof textBlockSchema>).text });
      } else if (block.type === 'image') {
        const img = imageBlockToOpenAI(block as z.infer<typeof imageBlockSchema>);
        if (img) {
          userBlocks.push(img);
          userHasImage = true;
        }
      }
      // unknown blocks (thinking, document, …) are dropped
    }
    if (userBlocks.length > 0) {
      // Text-only → flatten to a plain string (cheaper for providers that don't
      // accept arrays); mixed/image content keeps the array envelope so the
      // image survives to vision-capable providers.
      const content: ChatMessage['content'] = userHasImage
        ? userBlocks
        : userBlocks.map((b) => (typeof b === 'object' && b.type === 'text' ? b.text : '')).join('');
      messages.push({ role: 'user', content });
    }
  }

  return messages;
}

export function toChatTools(tools?: MessagesRequest['tools']): ChatToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  // Forward only custom function tools (those with an input_schema). Anthropic
  // server/built-in tools (web_search_*, computer_*, bash_*, text_editor_*)
  // can't be executed by chat-completions providers, so they're dropped.
  const customTools = tools.filter((t) => t.input_schema && typeof t.name === 'string');
  if (!customTools.length) return undefined;
  return customTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema!,
    },
  }));
}

export function toChatToolChoice(tc?: MessagesRequest['tool_choice']): ChatToolChoice | undefined {
  if (!tc) return undefined;
  switch (tc.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: tc.name } };
    default: return undefined;
  }
}

// True if any user message carries an Anthropic image block (before
// translation), so we can gate on vision support up front.
export function messagesRequestHasImage(req: MessagesRequest): boolean {
  return req.messages.some((m) =>
    Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === 'image'),
  );
}

// ── OpenAI finish_reason → Anthropic stop_reason ─────────────────────────
function toStopReason(finishReason: string | null | undefined, hadToolCalls: boolean): string {
  if (hadToolCalls) return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'end_turn';
  return 'end_turn';
}

// ── Build the final (non-stream) Anthropic message object ────────────────
export function buildMessageObject(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: ChatToolCall[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}) {
  const content: any[] = [];
  if (opts.text.length > 0) {
    content.push({ type: 'text', text: opts.text });
  }
  for (const tc of opts.toolCalls) {
    let input: unknown = {};
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      // Provider emitted non-JSON arguments — surface the raw string rather
      // than dropping the call entirely.
      input = { _raw: tc.function.arguments };
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  // Never return an empty content array — Anthropic clients expect at least one
  // block. (The retry loop already fails over on truly-empty completions; this
  // is a belt-and-suspenders default.)
  if (content.length === 0) content.push({ type: 'text', text: '' });

  return {
    id: opts.id,
    type: 'message',
    role: 'assistant',
    model: opts.model,
    content,
    stop_reason: opts.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens,
      output_tokens: opts.outputTokens,
    },
  };
}

function unauthorized(res: Response) {
  res.status(401).json({
    type: 'error',
    error: { type: 'authentication_error', message: 'Invalid API key' },
  });
}

// Resolve the requested model id against the catalog. Unlike the strict
// /chat/completions endpoint, an unknown model is NOT a 400 here: Claude-native
// clients send real Anthropic ids (claude-sonnet-4-5, claude-3-5-haiku, …) that
// will never be in a free-provider catalog, and the whole point of the gateway
// is to answer them with whatever free model the router picks. So: an enabled
// catalog match pins routing; anything else (including "auto" or a Claude id)
// falls through to sticky-session / router auto-selection.
function resolvePreferredModel(requestedModel: string | undefined, messages: ChatMessage[]): number | undefined {
  if (requestedModel && requestedModel !== 'auto') {
    const db = getDb();
    const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
    if (enabled) return enabled.id;
  }
  return getStickyModel(messages);
}

// ── POST /v1/messages/count_tokens ───────────────────────────────────────
// Claude Code calls this before sending to size context. We don't ship a real
// Anthropic tokenizer, so reuse the same ~4-chars-per-token heuristic the rest
// of the gateway uses for routing/bookkeeping. Approximate but stable.
anthropicRouter.post('/messages/count_tokens', (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    unauthorized(res);
    return;
  }
  const parsed = messagesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: `Invalid request: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}` },
    });
    return;
  }
  const messages = toChatMessages(parsed.data);
  const tools = parsed.data.tools ? JSON.stringify(parsed.data.tools) : '';
  const inputTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
    Math.ceil(tools.length / 4),
  );
  res.json({ input_tokens: inputTokens });
});

// ── POST /v1/messages ────────────────────────────────────────────────────
anthropicRouter.post('/messages', async (req: Request, res: Response) => {
  const start = Date.now();

  // Same unified-key auth as the proxy (accepts Bearer or x-api-key — Claude
  // Code and the Anthropic SDKs send x-api-key).
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    unauthorized(res);
    return;
  }

  const parsed = messagesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map((e) => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    console.warn(`[anthropic] 400 invalid /messages request: ${detail}`);
    res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: `Invalid request: ${detail}` },
    });
    return;
  }

  const reqData = parsed.data;
  const stream = reqData.stream ?? false;
  const messages = toChatMessages(reqData);
  const tools = toChatTools(reqData.tools);
  const toolSchemas = toolSchemaMap(tools);
  const tool_choice = toChatToolChoice(reqData.tool_choice);
  // max_tokens is required by the real API; default it generously when omitted
  // and treat <= 0 as unset (some clients send 0 to mean "no cap").
  const max_tokens = reqData.max_tokens != null && reqData.max_tokens > 0 ? reqData.max_tokens : undefined;
  const completionOpts = {
    temperature: reqData.temperature,
    max_tokens,
    top_p: reqData.top_p,
    tools,
    tool_choice,
  };

  // Image requests must route to a vision-capable model — reject up front with
  // a clear message rather than answering blind to a dropped image (mirrors the
  // /chat/completions gate, #118/#125).
  const hasImage = messageHasImage(messages) || messagesRequestHasImage(reqData);
  if (hasImage && !hasEnabledVisionModel()) {
    res.status(422).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'This request includes an image, but no vision-capable model is enabled. Enable a vision model (e.g. Gemini 2.5 Flash, Llama 4 Scout) in the Fallback Chain.',
      },
    });
    return;
  }

  // Tool-bearing requests must stay on models that emit structured tool_calls —
  // a model that serializes the call into text strands the agent harness with a
  // "successful" run it can't act on. Mirrors the /chat/completions gate.
  const wantsTools = (tools?.length ?? 0) > 0;
  if (wantsTools && !hasEnabledToolsModel()) {
    res.status(422).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'This request includes tools, but no tool-capable model is enabled. Enable a tool-calling model (e.g. GPT-OSS 120B, Gemini 3.5 Flash, GLM-4.7) in the Fallback Chain.',
      },
    });
    return;
  }

  const estimatedInputTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
    0,
  );
  const IMAGE_TOKEN_ESTIMATE = 1000;
  const imageCount = messages.reduce((n, m) =>
    n + (Array.isArray(m.content) ? m.content.filter((b) => (b as { type?: string })?.type === 'image_url').length : 0), 0);
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + (max_tokens ?? 1000);
  const preferredModel = resolvePreferredModel(reqData.model, messages);

  const messageId = newId('msg');
  const skipKeys = new Set<string>();
  let lastError: any = null;

  // Stream bookkeeping (used only when stream === true).
  let streamStarted = false;
  const sse = (event: string, data: Record<string, unknown>) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, hasImage, wantsTools);
    } catch (err: any) {
      const safeLast = lastError ? sanitizeProviderErrorMessage(lastError.message) : '';
      const status = lastError ? 429 : (err.status ?? 503);
      const message = lastError ? `All models rate-limited. Last error: ${safeLast}` : err.message;
      const type = lastError ? 'rate_limit_error' : 'api_error';
      if (streamStarted) {
        sse('error', { type: 'error', error: { type, message } });
        res.end();
      } else {
        res.status(status).json({ type: 'error', error: { type, message } });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        // index of the currently/last open content block. -1 = none opened yet.
        let blockIndex = -1;
        let textBlockOpen = false;
        let msgText = '';
        // tool-call accumulator keyed by the provider's tool_call index.
        // `startSent` gates content_block_start: Anthropic's tool_use block
        // requires a non-empty `name`, but some providers stream the name in a
        // later chunk than the id — so we defer the start (buffering arg frags)
        // until the name is known, then flush.
        const toolAcc = new Map<number, { blockIndex: number; callId: string; name: string; args: string; startSent: boolean }>();
        let totalOutputTokens = 0;

        const gen = route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, completionOpts);

        for await (const chunk of gen) {
          // Client hung up — stop pulling from the upstream provider so we don't
          // burn free-tier tokens/bandwidth generating into a dead socket.
          if (res.destroyed) break;
          // LAZY header set — headers + the message_start frame go out only once
          // the provider actually streams a chunk, so a connect-time provider
          // error bubbles to the catch with streamStarted=false and takes the
          // normal failover path (mirrors proxy/responses streaming handlers).
          if (!streamStarted) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
            if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
            sse('message_start', {
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: route.modelId,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
              },
            });
            streamStarted = true;
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Text deltas → a single text content block (always index 0).
          const text = delta.content ?? '';
          if (text) {
            if (!textBlockOpen) {
              blockIndex = 0;
              textBlockOpen = true;
              sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            }
            sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
            msgText += text;
            totalOutputTokens += Math.ceil(text.length / 4);
          }

          // Tool-call deltas → tool_use content blocks + input_json_delta frags.
          for (const tc of delta.tool_calls ?? []) {
            const idx = (tc as any).index ?? 0;
            let acc = toolAcc.get(idx);
            if (!acc) {
              blockIndex = blockIndex < 0 ? 0 : blockIndex + 1;
              acc = { blockIndex, callId: tc.id || newId('toolu'), name: tc.function?.name ?? '', args: '', startSent: false };
              toolAcc.set(idx, acc);
            }
            if (tc.function?.name && !acc.name) acc.name = tc.function.name;

            // Emit content_block_start only once the name is known. Buffered arg
            // frags (accumulated below before the name arrived) are flushed here.
            if (acc.name && !acc.startSent) {
              // Close the text block before opening the first tool_use block —
              // Anthropic allows only one open content block at a time.
              if (textBlockOpen) {
                sse('content_block_stop', { type: 'content_block_stop', index: 0 });
                textBlockOpen = false;
              }
              sse('content_block_start', {
                type: 'content_block_start',
                index: acc.blockIndex,
                content_block: { type: 'tool_use', id: acc.callId, name: acc.name, input: {} },
              });
              acc.startSent = true;
              if (acc.args) {
                sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: acc.blockIndex,
                  delta: { type: 'input_json_delta', partial_json: acc.args },
                });
              }
            }

            const argFrag = tc.function?.arguments ?? '';
            if (argFrag) {
              acc.args += argFrag;
              // Already-started block → stream the frag live; otherwise it stays
              // buffered in acc.args and is flushed when the start fires above.
              if (acc.startSent) {
                sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: acc.blockIndex,
                  delta: { type: 'input_json_delta', partial_json: argFrag },
                });
              }
            }
          }
        }

        // Client disconnected mid-stream — don't finalize/failover into a dead
        // socket (and don't penalize the model: it's not a provider failure).
        if (res.destroyed) {
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, 'client disconnected');
          return;
        }

        // Empty completion — provider returned 200 with no text AND no tool
        // calls. Nothing substantive has been emitted (only message_start), so
        // it's safe to fail over to the next model on the same SSE stream.
        if (msgText.length === 0 && toolAcc.size === 0) {
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, 'empty completion (no content, no tool_calls)');
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
          setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
          recordRateLimitHit(route.modelDbId);
          lastError = new Error(`empty completion from ${route.displayName}`);
          continue;
        }

        // Close any still-open text block.
        if (textBlockOpen) {
          sse('content_block_stop', { type: 'content_block_stop', index: 0 });
          textBlockOpen = false;
        }
        // Close tool_use blocks. Clients reconstruct `input` from the streamed
        // partial_json frags, so nothing more to send but the stop. A block that
        // never got its start (provider sent a tool_call delta but no name at
        // all) is force-started here with the accumulated args so the event
        // sequence stays well-formed — degenerate, but cheap insurance.
        const hadToolCalls = toolAcc.size > 0;
        for (const acc of toolAcc.values()) {
          if (!acc.startSent) {
            sse('content_block_start', {
              type: 'content_block_start',
              index: acc.blockIndex,
              content_block: { type: 'tool_use', id: acc.callId, name: acc.name || 'unknown', input: {} },
            });
            if (acc.args) {
              sse('content_block_delta', { type: 'content_block_delta', index: acc.blockIndex, delta: { type: 'input_json_delta', partial_json: acc.args } });
            }
            acc.startSent = true;
          }
          sse('content_block_stop', { type: 'content_block_stop', index: acc.blockIndex });
        }

        sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: toStopReason(null, hadToolCalls), stop_sequence: null },
          usage: { output_tokens: totalOutputTokens },
        });
        sse('message_stop', { type: 'message_stop' });
        res.end();

        recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);
        logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null);
        return;
      } else {
        const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, completionOpts);

        const msg = result.choices?.[0]?.message;
        const finishReason = result.choices?.[0]?.finish_reason;
        const text = contentToString(msg?.content ?? '');
        const toolCalls = (msg?.tool_calls ?? []).map((tc) => ({
          ...tc,
          function: { ...tc.function, arguments: repairToolArguments(tc.function.arguments, toolSchemas.get(tc.function.name)) },
        }));

        // Empty completion → fail over (mirrors the streaming path).
        if (!text && toolCalls.length === 0) {
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, 'empty completion (no content, no tool_calls)');
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
          setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
          recordRateLimitHit(route.modelDbId);
          lastError = new Error(`empty completion from ${route.displayName}`);
          continue;
        }

        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);

        recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? (promptTokens + completionTokens));
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json(buildMessageObject({
          id: messageId,
          model: route.modelId,
          text,
          toolCalls,
          stopReason: toStopReason(finishReason, toolCalls.length > 0),
          inputTokens: promptTokens,
          outputTokens: completionTokens,
        }));

        logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null);
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError);

      // Mid-stream failures can't be retried (bytes already sent) — close cleanly.
      if (stream && streamStarted) {
        sse('error', { type: 'error', error: { type: 'api_error', message: `Provider error (${route.displayName}): stream interrupted` } });
        res.end();
        return;
      }

      if (isRetryableError(err)) {
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(route.platform, route.modelId, route.keyId, isPaymentRequiredError(err)
          ? PAYMENT_REQUIRED_COOLDOWN_MS
          : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Anthropic] ${safeError.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      res.status(502).json({ type: 'error', error: { type: 'api_error', message: `Provider error (${route.displayName}): ${safeError}` } });
      return;
    }
  }

  // Exhausted all retries.
  const exhaustedMsg = `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${sanitizeProviderErrorMessage(lastError?.message)}`;
  if (streamStarted) {
    sse('error', { type: 'error', error: { type: 'rate_limit_error', message: exhaustedMsg } });
    res.end();
    return;
  }
  res.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message: exhaustedMsg } });
});
