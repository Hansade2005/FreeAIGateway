// Talking to the FreeAIGateway from the builder. Same-origin (the builder entry
// is served by the gateway), so plain /api and /v1 paths work in dev and prod.

const TOKEN_KEY = 'freellmapi_dashboard_token'

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolDef { type: 'function'; function: { name: string; description: string; parameters: any } }

let cachedKey: string | null = null
export async function getUnifiedKey(): Promise<string> {
  if (cachedKey) return cachedKey
  const token = localStorage.getItem(TOKEN_KEY)
  const res = await fetch('/api/settings/api-key', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error('Could not load the unified API key — open the dashboard and sign in first.')
  cachedKey = (await res.json()).apiKey
  return cachedKey!
}

export interface StreamHandle { signal?: AbortSignal }
export interface StreamResult { text: string; toolCalls: ToolCall[]; model: string }

export interface StreamOpts {
  model: string
  fallbackModel: string | null
  tools?: ToolDef[]
  onToken: (delta: string) => void
  onTool?: (calls: ToolCall[]) => void // called as tool-call args stream in
  signal?: AbortSignal
}

// Stream a chat completion: invokes onToken for content deltas, onTool as tool
// calls assemble, and returns the final text + tool calls. Tries `model`,
// falling back to `fallbackModel` (kilo-auto/free → auto) on failure.
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

// Generate an image via the gateway (a0.dev under the hood) and return its raw
// bytes, so the builder can write it into the project as an asset.
export async function generateImageBytes(prompt: string): Promise<Uint8Array> {
  const key = await getUnifiedKey()
  const res = await fetch('/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ prompt }),
  })
  if (!res.ok) throw new Error('image generation failed')
  const url = (await res.json())?.data?.[0]?.url
  if (!url) throw new Error('no image url returned')
  const img = await fetch(url)
  if (!img.ok) throw new Error('could not fetch generated image')
  return new Uint8Array(await img.arrayBuffer())
}

async function once(
  messages: ChatMsg[],
  model: string,
  opts: StreamOpts,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const key = await getUnifiedKey()
  const tools = opts.tools
  const body = JSON.stringify({ model, stream: true, messages, temperature: 0.3, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) })
  // Retry transient failures (rate limit / 5xx) on the same model before the
  // caller falls back to `auto`. Free tiers (Kilo 200/hr) hit 429 under load.
  let res: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) throw new Error('aborted')
    res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
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
    throw new Error(err?.error?.message ?? `gateway HTTP ${res?.status ?? '???'}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  const tcAcc: Record<number, ToolCall> = {} // assemble streamed tool-call deltas by index
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
