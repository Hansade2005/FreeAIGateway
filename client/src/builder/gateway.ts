// Talking to the FreeAIGateway from the builder. Same-origin (the builder entry
// is served by the gateway), so plain /api and /v1 paths work in dev and prod.

const TOKEN_KEY = 'freellmapi_dashboard_token'

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string }

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

// Stream a chat completion, invoking onToken for each content delta and
// returning the full assistant text. Tries `model`, and on failure retries once
// with `fallbackModel` (kilo-auto/free → auto).
export async function streamChat(
  messages: ChatMsg[],
  model: string,
  fallbackModel: string | null,
  onToken: (delta: string) => void,
  handle?: StreamHandle,
): Promise<{ text: string; model: string }> {
  try {
    const text = await once(messages, model, onToken, handle)
    return { text, model }
  } catch (e) {
    if (fallbackModel && fallbackModel !== model && !handle?.signal?.aborted) {
      const text = await once(messages, fallbackModel, onToken, handle)
      return { text, model: fallbackModel }
    }
    throw e
  }
}

async function once(messages: ChatMsg[], model: string, onToken: (d: string) => void, handle?: StreamHandle): Promise<string> {
  const key = await getUnifiedKey()
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, stream: true, messages, temperature: 0.3 }),
    signal: handle?.signal,
  })
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({} as any))
    throw new Error(err?.error?.message ?? `gateway HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
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
        const delta = JSON.parse(data).choices?.[0]?.delta?.content
        if (delta) { full += delta; onToken(delta) }
      } catch { /* ignore keepalive / partial */ }
    }
  }
  return full
}
