// Standalone gateway: talks to ANY OpenAI-compatible API using the configured
// provider (base URL + key + model). No FreeAIGateway server dependency.

import { getProvider, apiBase } from '../provider'

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolDef { type: 'function'; function: { name: string; description: string; parameters: any } }

export interface StreamResult { text: string; toolCalls: ToolCall[]; model: string }

export interface StreamOpts {
  model: string
  fallbackModel: string | null
  tools?: ToolDef[]
  onToken: (delta: string) => void
  onTool?: (calls: ToolCall[]) => void
  signal?: AbortSignal
}

function authHeaders(): Record<string, string> {
  const key = getProvider()?.apiKey?.trim()
  return key ? { Authorization: `Bearer ${key}` } : {}
}

// Stream a chat completion against the configured provider. Tries `model`, then
// `fallbackModel` on failure.
export async function streamChat(messages: ChatMsg[], opts: StreamOpts): Promise<StreamResult> {
  try {
    const r = await once(messages, opts.model, opts)
    return { ...r, model: opts.model }
  } catch (e) {
    if (opts.fallbackModel && opts.fallbackModel !== opts.model && !opts.signal?.aborted) {
      const r = await once(messages, opts.fallbackModel, opts)
      return { ...r, model: opts.fallbackModel }
    }
    throw e
  }
}

// Generate an image via the provider's OpenAI-style /images/generations endpoint
// (only used when an image model is configured). Returns raw PNG/JPEG bytes.
export async function generateImageBytes(prompt: string): Promise<Uint8Array> {
  const imageModel = getProvider()?.imageModel?.trim()
  const res = await fetch(`${apiBase()}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ prompt, ...(imageModel ? { model: imageModel } : {}), n: 1 }),
  })
  if (!res.ok) throw new Error('image generation failed')
  const data = (await res.json())?.data?.[0]
  // OpenAI returns either a hosted url or base64 (b64_json).
  if (data?.b64_json) {
    const bin = atob(data.b64_json)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }
  if (data?.url) {
    const img = await fetch(data.url)
    if (!img.ok) throw new Error('could not fetch generated image')
    return new Uint8Array(await img.arrayBuffer())
  }
  throw new Error('no image returned')
}

async function once(messages: ChatMsg[], model: string, opts: StreamOpts): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const tools = opts.tools
  const body = JSON.stringify({ model, stream: true, messages, temperature: 0.3, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) })
  let res: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) throw new Error('aborted')
    res = await fetch(`${apiBase()}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body,
      signal: opts.signal,
    })
    if (res.ok && res.body) break
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt))
      continue
    }
    break
  }
  if (!res || !res.ok || !res.body) {
    const err = await res?.json().catch(() => ({} as any))
    throw new Error(err?.error?.message ?? `provider HTTP ${res?.status ?? '???'}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  const tcAcc: Record<number, ToolCall> = {}
  const ordered = () => Object.keys(tcAcc).sort((a, b) => +a - +b).map((k) => tcAcc[+k])
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta
        if (delta?.content) { full += delta.content; opts.onToken(delta.content) }
        if (delta?.tool_calls) {
          for (const d of delta.tool_calls) {
            const i = d.index ?? 0
            tcAcc[i] ??= { id: d.id || `call_${i}`, type: 'function', function: { name: '', arguments: '' } }
            if (d.id) tcAcc[i].id = d.id
            if (d.function?.name) tcAcc[i].function.name += d.function.name
            if (d.function?.arguments) tcAcc[i].function.arguments += d.function.arguments
          }
          opts.onTool?.(ordered())
        }
      } catch { /* ignore keepalive / partial */ }
    }
  }
  const toolCalls = ordered().filter((c) => c.function.name)
  return { text: full, toolCalls }
}
