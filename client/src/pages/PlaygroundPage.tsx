import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Send, Trash2, Wrench, ImagePlus, X, Cpu, Zap, Clock, Gauge, Layers } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { Markdown } from '@/components/markdown'

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  keyCount: number
}

interface ToolCall { name: string; args: string }

interface TurnMeta {
  protocol: 'openai' | 'anthropic'
  platform?: string
  model?: string
  cache?: string
  latency?: number
  ttfb?: number
  inputTokens?: number
  outputTokens?: number
  fallbackAttempts?: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  image?: string // data URL on a user turn
  toolCalls?: ToolCall[]
  error?: boolean
  meta?: TurnMeta
}

type Protocol = 'openai' | 'anthropic'

const DEFAULT_TOOLS = JSON.stringify(
  [{ name: 'get_weather', description: 'Get the current weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] } }],
  null,
  2,
)

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

// ── small UI atoms ──────────────────────────────────────────────────────────
function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="inline-flex rounded-lg border bg-surface-2/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            value === o.value ? 'bg-signal text-signal-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function MetaChip({ icon: Icon, children, accent }: { icon: typeof Zap; children: React.ReactNode; accent?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${accent ? 'border-signal/40 text-signal' : 'text-muted-foreground'}`}>
      <Icon className="size-3" />
      {children}
    </span>
  )
}

export default function PlaygroundPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [model, setModel] = useState('auto')
  const [protocol, setProtocol] = useState<Protocol>('openai')
  const [toolsOn, setToolsOn] = useState(false)
  const [toolsJson, setToolsJson] = useState(DEFAULT_TOOLS)
  const [toolsEditorOpen, setToolsEditorOpen] = useState(false)
  const [image, setImage] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })
  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  const availableModels = fallbackEntries.filter((e) => e.keyCount > 0 && e.enabled)

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (keyData?.apiKey) h['Authorization'] = `Bearer ${keyData.apiKey}`
    return h
  }

  // Tools/images take the non-streaming path (structured tool_calls and vision
  // are simpler and more reliable to parse whole); plain text streams.
  const streaming = !toolsOn && !image

  function buildTools(): any[] | undefined {
    if (!toolsOn) return undefined
    try {
      const parsed = JSON.parse(toolsJson)
      if (!Array.isArray(parsed)) return undefined
      if (protocol === 'openai') {
        // Translate Anthropic-style {name,description,input_schema} → OpenAI fn tools.
        return parsed.map((t: any) => ('function' in t ? t : { type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
      }
      // Anthropic protocol expects {name,description,input_schema}.
      return parsed.map((t: any) => (t.input_schema ? t : { name: t.function?.name, description: t.function?.description, input_schema: t.function?.parameters }))
    } catch {
      return undefined
    }
  }

  async function handleSend() {
    const text = input.trim()
    if ((!text && !image) || loading) return

    const userMsg: ChatMessage = { role: 'user', content: text, ...(image ? { image } : {}) }
    const history = [...messages, userMsg]
    setMessages(history)
    setInput('')
    const sentImage = image
    setImage(null)
    setLoading(true)
    inputRef.current?.focus()

    const start = Date.now()
    try {
      if (streaming) {
        await runStream(history, start)
      } else {
        await runOnce(history, start, sentImage)
      }
    } catch (err: any) {
      setMessages([...history, { role: 'assistant', content: `Error: ${err.message}`, error: true }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  // ── streaming path (text only) ────────────────────────────────────────────
  async function runStream(history: ChatMessage[], start: number) {
    const url = protocol === 'openai' ? `${BASE}/v1/chat/completions` : `${BASE}/v1/messages`
    const body = protocol === 'openai'
      ? { ...(model !== 'auto' ? { model } : {}), stream: true, messages: history.map((m) => ({ role: m.role, content: m.content })) }
      : { model: model === 'auto' ? 'auto' : model, max_tokens: 1024, stream: true, messages: history.map((m) => ({ role: m.role, content: m.content })) }

    const res = await fetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) })
    const meta: TurnMeta = readHeaderMeta(res, protocol)
    if (!res.ok || !res.body) {
      const e = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
      setMessages([...history, { role: 'assistant', content: `Error: ${e.error?.message ?? 'stream failed'}`, error: true }])
      return
    }

    let acc = ''
    let ttfb: number | undefined
    const push = () => setMessages([...history, { role: 'assistant', content: acc, meta: { ...meta, ttfb, latency: Date.now() - start } }])

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          let json: any
          try { json = JSON.parse(payload) } catch { continue }
          const delta = protocol === 'openai'
            ? json.choices?.[0]?.delta?.content
            : (json.type === 'content_block_delta' ? json.delta?.text : undefined)
          if (delta) {
            if (ttfb === undefined) ttfb = Date.now() - start
            acc += delta
            push()
          }
          if (protocol === 'anthropic' && json.type === 'message_delta' && json.usage) {
            meta.outputTokens = json.usage.output_tokens
          }
        }
      }
    }
    if (!acc) setMessages([...history, { role: 'assistant', content: '_(empty response)_', meta: { ...meta, latency: Date.now() - start } }])
  }

  // ── non-streaming path (tools / vision) ─────────────────────────────────────
  async function runOnce(history: ChatMessage[], start: number, sentImage: string | null) {
    const url = protocol === 'openai' ? `${BASE}/v1/chat/completions` : `${BASE}/v1/messages`
    const tools = buildTools()

    const toContent = (m: ChatMessage, isLast: boolean) => {
      if (!(isLast && sentImage)) return m.content
      if (protocol === 'openai') {
        return [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          { type: 'image_url', image_url: { url: sentImage } },
        ]
      }
      const [, mediaType, data] = sentImage.match(/^data:(.+?);base64,(.+)$/) ?? []
      return [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        { type: 'image', source: { type: 'base64', media_type: mediaType ?? 'image/png', data: data ?? '' } },
      ]
    }
    const msgs = history.map((m, idx) => ({ role: m.role, content: toContent(m, idx === history.length - 1) }))
    const body: any = protocol === 'openai'
      ? { ...(model !== 'auto' ? { model } : {}), messages: msgs, ...(tools ? { tools } : {}) }
      : { model: model === 'auto' ? 'auto' : model, max_tokens: 1024, messages: msgs, ...(tools ? { tools } : {}) }

    const res = await fetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) })
    const meta: TurnMeta = readHeaderMeta(res, protocol)
    meta.latency = Date.now() - start
    if (!res.ok) {
      const e = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
      setMessages([...history, { role: 'assistant', content: `Error: ${e.error?.message ?? 'request failed'}`, error: true }])
      return
    }
    const data = await res.json()
    let content = ''
    let toolCalls: ToolCall[] | undefined
    if (protocol === 'openai') {
      const m = data.choices?.[0]?.message
      content = typeof m?.content === 'string' ? m.content : ''
      toolCalls = (m?.tool_calls ?? []).map((tc: any) => ({ name: tc.function?.name, args: tc.function?.arguments ?? '' }))
      meta.inputTokens = data.usage?.prompt_tokens
      meta.outputTokens = data.usage?.completion_tokens
    } else {
      for (const block of data.content ?? []) {
        if (block.type === 'text') content += block.text
        else if (block.type === 'tool_use') (toolCalls ??= []).push({ name: block.name, args: JSON.stringify(block.input ?? {}, null, 2) })
      }
      meta.inputTokens = data.usage?.input_tokens
      meta.outputTokens = data.usage?.output_tokens
    }
    setMessages([...history, { role: 'assistant', content, toolCalls: toolCalls?.length ? toolCalls : undefined, meta }])
  }

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setImage(reader.result as string)
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col">
      <PageHeader
        title="Playground"
        description="Drive the gateway over either protocol — watch which provider serves each turn, and whether it hit the cache."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={protocol}
              onChange={(v) => setProtocol(v as Protocol)}
              options={[{ value: 'openai', label: 'OpenAI /v1' }, { value: 'anthropic', label: 'Anthropic /messages' }]}
            />
            <Select value={model} onValueChange={(v) => setModel(v ?? 'auto')}>
              <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (router picks)</SelectItem>
                {availableModels.map((m) => (
                  <SelectItem key={m.modelDbId} value={m.modelId}>
                    <span className="flex items-center gap-2"><span>{m.displayName}</span><span className="text-xs text-muted-foreground">{m.platform}</span></span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {messages.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setMessages([])}><Trash2 className="size-3.5" /> Clear</Button>
            )}
          </div>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border bg-card/70 backdrop-blur-sm">
        {/* transcript */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center">
              <div className="max-w-md space-y-3">
                <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-signal-muted text-signal"><Cpu className="size-6" /></span>
                <p className="font-display text-lg font-semibold">Send a message to the gateway.</p>
                <p className="text-sm text-muted-foreground">
                  Speaking <span className="text-foreground">{protocol === 'openai' ? 'OpenAI' : 'Anthropic'}</span>, routed to{' '}
                  <span className="text-foreground">{model === 'auto' ? 'the best available model' : model}</span>.
                  Toggle tools or attach an image to test those paths.
                </p>
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <div key={i} className={`flex animate-rise ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === 'user' ? 'bg-primary text-primary-foreground'
                    : msg.error ? 'border border-destructive/40 bg-destructive/10 text-foreground' : 'bg-surface-2 edge-lit'
                }`}>
                  {msg.image && <img src={msg.image} alt="attachment" className="mb-2 max-h-48 rounded-lg" />}
                  {msg.role === 'assistant' && !msg.error ? <Markdown>{msg.content}</Markdown> : <div className="whitespace-pre-wrap">{msg.content}</div>}

                  {msg.toolCalls?.map((tc, j) => (
                    <div key={j} className="mt-2 rounded-lg border border-signal/30 bg-signal-muted/40 p-2 font-mono text-xs">
                      <div className="mb-1 flex items-center gap-1.5 text-signal"><Wrench className="size-3" /> {tc.name}</div>
                      <pre className="overflow-x-auto whitespace-pre-wrap text-muted-foreground">{tc.args}</pre>
                    </div>
                  ))}

                  {msg.meta && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {msg.meta.model && <MetaChip icon={Layers}>{msg.meta.platform}/{msg.meta.model}</MetaChip>}
                      {msg.meta.cache && <MetaChip icon={Zap} accent={msg.meta.cache === 'HIT'}>cache {msg.meta.cache}</MetaChip>}
                      {msg.meta.latency != null && <MetaChip icon={Clock}>{msg.meta.latency} ms</MetaChip>}
                      {msg.meta.ttfb != null && <MetaChip icon={Gauge}>ttfb {msg.meta.ttfb} ms</MetaChip>}
                      {(msg.meta.inputTokens != null || msg.meta.outputTokens != null) && (
                        <MetaChip icon={Cpu}>{msg.meta.inputTokens ?? '?'}→{msg.meta.outputTokens ?? '?'} tok</MetaChip>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {loading && (
            <div className="flex justify-start">
              <div className="flex gap-1 rounded-2xl bg-surface-2 px-4 py-3">
                {[0, 150, 300].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-signal/70" style={{ animationDelay: `${d}ms` }} />)}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* tools editor (collapsible) */}
        {toolsOn && toolsEditorOpen && (
          <div className="border-t bg-surface-1/60 p-3">
            <p className="mb-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Tools (JSON)</p>
            <textarea
              value={toolsJson}
              onChange={(e) => setToolsJson(e.target.value)}
              rows={6}
              className="w-full resize-y rounded-lg border bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-signal/40"
              spellCheck={false}
            />
          </div>
        )}

        {/* composer */}
        <div className="border-t bg-background/40 p-3">
          {image && (
            <div className="mb-2 flex items-center gap-2">
              <img src={image} alt="to send" className="size-12 rounded-lg object-cover" />
              <button onClick={() => setImage(null)} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant={toolsOn ? 'default' : 'outline'}
                size="icon"
                className={toolsOn ? 'bg-signal text-signal-foreground hover:bg-signal/90' : ''}
                onClick={() => { setToolsOn((v) => !v); setToolsEditorOpen(true) }}
                title="Attach tools"
              >
                <Wrench className="size-4" />
              </Button>
              <Button type="button" variant="outline" size="icon" onClick={() => fileRef.current?.click()} title="Attach image">
                <ImagePlus className="size-4" />
              </Button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickImage} />
            </div>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Message via ${protocol === 'openai' ? 'OpenAI' : 'Anthropic'}… (⏎ send · ⇧⏎ newline)`}
              rows={1}
              className="max-h-[160px] min-h-[40px] flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-signal/40"
              onInput={(e) => { const el = e.target as HTMLTextAreaElement; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px' }}
            />
            <Button onClick={handleSend} disabled={loading || (!input.trim() && !image)}>
              <Send className="size-4" /> {loading ? 'Sending…' : 'Send'}
            </Button>
          </div>
          {toolsOn && (
            <button onClick={() => setToolsEditorOpen((v) => !v)} className="mt-1.5 text-[11px] text-muted-foreground hover:text-foreground">
              {toolsEditorOpen ? 'Hide' : 'Edit'} tools JSON · streaming off while tools/image attached
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function readHeaderMeta(res: Response, protocol: Protocol): TurnMeta {
  const routed = res.headers.get('X-Routed-Via')
  const fb = res.headers.get('X-Fallback-Attempts')
  return {
    protocol,
    platform: routed ? routed.split('/')[0] : undefined,
    model: routed ? routed.split('/').slice(1).join('/') : undefined,
    cache: res.headers.get('X-Cache') ?? undefined,
    fallbackAttempts: fb ? Number(fb) : undefined,
  }
}
