import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Send, Trash2, Wrench, ImagePlus, X, Cpu, Zap, Clock, Gauge, Layers, MessageSquare, Columns3, Image as ImageIcon, Sparkles } from 'lucide-react'
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

function ChatConsole() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [model, setModel] = useState('auto')
  const [protocol, setProtocol] = useState<Protocol>('openai')
  const [toolsOn, setToolsOn] = useState(false)
  const [toolsJson, setToolsJson] = useState(DEFAULT_TOOLS)
  const [toolsEditorOpen, setToolsEditorOpen] = useState(false)
  const [agentTools, setAgentTools] = useState(false)
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
  const { data: toolsCfg } = useQuery<{ enabled: boolean }>({
    queryKey: ['tools'],
    queryFn: () => apiFetch('/api/settings/tools'),
  })
  const availableModels = fallbackEntries.filter((e) => e.keyCount > 0 && e.enabled)

  // Gateway built-in tools (web search / extract / image gen) only run on the
  // OpenAI auto-routed, non-streaming path. They're an explicit opt-in (the
  // Agent-tools toggle) rather than the default, so plain chat keeps streaming
  // token-by-token. When on, the request goes non-streaming so the model can
  // call them and generated images arrive as inline markdown in the transcript.
  const builtinEligible = !!toolsCfg?.enabled && model === 'auto' && protocol === 'openai'
  const builtinActive = builtinEligible && agentTools

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (keyData?.apiKey) h['Authorization'] = `Bearer ${keyData.apiKey}`
    return h
  }

  // Tools/images/built-ins take the non-streaming path (structured tool_calls,
  // vision, and the server-side tool loop are simpler whole); plain text streams.
  const streaming = !toolsOn && !image && !builtinActive

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
    <div className="flex h-[calc(100vh-13rem)] flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-2">
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
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setMessages([])}><Trash2 className="size-3.5" /> Clear</Button>
        )}
      </div>

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
              {builtinEligible && (
                <Button
                  type="button"
                  variant={agentTools ? 'default' : 'outline'}
                  size="sm"
                  className={`gap-1.5 ${agentTools ? 'bg-signal text-signal-foreground hover:bg-signal/90' : 'text-muted-foreground'}`}
                  onClick={() => setAgentTools((v) => !v)}
                  aria-pressed={agentTools}
                  title="Agent tools: let the gateway run web search / extract / image generation (non-streaming)"
                >
                  <Sparkles className="size-3.5" />
                  Agent tools
                  <span className={`ml-0.5 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${agentTools ? 'bg-signal-foreground/20' : 'bg-muted text-muted-foreground'}`}>
                    {agentTools ? 'On' : 'Off'}
                  </span>
                </Button>
              )}
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
          {builtinActive && !toolsOn && !image && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Sparkles className="size-3 text-signal" /> Gateway tools on — ask it to search the web or “generate an image of …” and results render inline.
            </p>
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

function useGateway() {
  const { data: keyData } = useQuery<{ apiKey: string }>({ queryKey: ['unified-key'], queryFn: () => apiFetch('/api/settings/api-key') })
  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({ queryKey: ['fallback'], queryFn: () => apiFetch('/api/fallback') })
  return { apiKey: keyData?.apiKey, models: fallbackEntries.filter((e) => e.keyCount > 0 && e.enabled) }
}

// ── Image generation console ────────────────────────────────────────────────
function ImageConsole() {
  const { apiKey } = useGateway()
  const [prompt, setPrompt] = useState('')
  const [aspect, setAspect] = useState('1:1')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [images, setImages] = useState<{ url: string; path?: string }[]>([])

  async function generate() {
    const p = prompt.trim()
    if (!p || loading) return
    setLoading(true); setError('')
    try {
      const res = await fetch(`${BASE}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ prompt: p, aspect }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error?.message ?? 'generation failed')
      setImages((prev) => [...(data.data ?? []), ...prev])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-3xl border bg-card/70 p-4 backdrop-blur-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="mb-1.5 block text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate() }}
              placeholder="a bioluminescent jellyfish drifting over a neon reef, cinematic"
              rows={2}
              className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-signal/40"
            />
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-1.5 block text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Aspect</label>
              <Segmented value={aspect} onChange={setAspect} options={[{ value: '1:1', label: '1:1' }, { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }]} />
            </div>
            <Button onClick={generate} disabled={loading || !prompt.trim()} className="bg-signal text-signal-foreground hover:bg-signal/90">
              <Sparkles className="size-4" /> {loading ? 'Generating…' : 'Generate'}
            </Button>
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <p className="mt-2 text-[11px] text-muted-foreground">Powered by a0.dev · the PNG is saved to the server's temp folder and served back here.</p>
      </div>

      {images.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed py-20 text-center">
          <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-signal-muted text-signal"><ImageIcon className="size-6" /></span>
          <p className="font-display text-lg font-semibold">Generate an image</p>
          <p className="text-sm text-muted-foreground">Describe what you want to see, pick an aspect, and hit Generate.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {images.map((img, i) => (
            <div key={i} className="animate-rise overflow-hidden rounded-2xl border bg-card">
              <img src={img.url} alt="generated" className="aspect-square w-full bg-surface-2 object-cover" />
              {img.path && (
                <div className="truncate px-3 py-2 font-mono text-[10px] text-muted-foreground" title={img.path}>{img.path}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Multi-model compare console ─────────────────────────────────────────────
interface CompareResult { loading: boolean; content?: string; error?: string; meta?: TurnMeta }

function CompareConsole() {
  const { apiKey, models } = useGateway()
  const [selected, setSelected] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [results, setResults] = useState<Record<string, CompareResult>>({})
  const [running, setRunning] = useState(false)

  // Default to the first 2 enabled models once they load.
  useEffect(() => {
    if (selected.length === 0 && models.length > 0) setSelected(models.slice(0, 2).map((m) => m.modelId))
  }, [models, selected.length])

  function toggle(modelId: string) {
    setSelected((prev) => prev.includes(modelId) ? prev.filter((m) => m !== modelId) : prev.length >= 3 ? prev : [...prev, modelId])
  }

  async function run() {
    const p = prompt.trim()
    if (!p || running || selected.length === 0) return
    setRunning(true)
    setResults(Object.fromEntries(selected.map((m) => [m, { loading: true }])))
    await Promise.all(selected.map(async (modelId) => {
      const start = Date.now()
      try {
        const res = await fetch(`${BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: p }] }),
        })
        const meta = readHeaderMeta(res, 'openai'); meta.latency = Date.now() - start
        const data = await res.json()
        if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`)
        meta.inputTokens = data.usage?.prompt_tokens; meta.outputTokens = data.usage?.completion_tokens
        setResults((prev) => ({ ...prev, [modelId]: { loading: false, content: data.choices?.[0]?.message?.content ?? '', meta } }))
      } catch (e: any) {
        setResults((prev) => ({ ...prev, [modelId]: { loading: false, error: e.message } }))
      }
    }))
    setRunning(false)
  }

  return (
    <div className="space-y-5">
      <div className="rounded-3xl border bg-card/70 p-4 backdrop-blur-sm">
        <label className="mb-2 block text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Models (pick up to 3)</label>
        <div className="mb-3 flex flex-wrap gap-2">
          {models.map((m) => {
            const on = selected.includes(m.modelId)
            return (
              <button
                key={m.modelDbId}
                onClick={() => toggle(m.modelId)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${on ? 'border-signal/50 bg-signal-muted text-signal' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {m.displayName}
              </button>
            )
          })}
          {models.length === 0 && <p className="text-sm text-muted-foreground">No models available — add a key on the Keys page.</p>}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run() } }}
            placeholder="One prompt, sent to every selected model in parallel…"
            rows={1}
            className="max-h-[120px] min-h-[40px] flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-signal/40"
          />
          <Button onClick={run} disabled={running || !prompt.trim() || selected.length === 0}>
            <Columns3 className="size-4" /> {running ? 'Running…' : 'Compare'}
          </Button>
        </div>
      </div>

      {selected.length > 0 && Object.keys(results).length > 0 && (
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(selected.length, 3)}, minmax(0, 1fr))` }}>
          {selected.map((modelId) => {
            const r = results[modelId]
            const label = models.find((m) => m.modelId === modelId)?.displayName ?? modelId
            return (
              <div key={modelId} className="flex flex-col overflow-hidden rounded-2xl border bg-card">
                <div className="border-b px-3 py-2 text-xs font-medium">{label}</div>
                <div className="min-h-[160px] flex-1 p-3 text-sm">
                  {!r || r.loading ? (
                    <div className="flex gap-1 pt-2">{[0, 150, 300].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-signal/70" style={{ animationDelay: `${d}ms` }} />)}</div>
                  ) : r.error ? (
                    <p className="text-xs text-destructive">{r.error}</p>
                  ) : (
                    <Markdown>{r.content ?? ''}</Markdown>
                  )}
                </div>
                {r?.meta && (
                  <div className="flex flex-wrap gap-1.5 border-t px-3 py-2">
                    {r.meta.cache && <MetaChip icon={Zap} accent={r.meta.cache === 'HIT'}>cache {r.meta.cache}</MetaChip>}
                    {r.meta.latency != null && <MetaChip icon={Clock}>{r.meta.latency} ms</MetaChip>}
                    {(r.meta.inputTokens != null || r.meta.outputTokens != null) && <MetaChip icon={Cpu}>{r.meta.inputTokens ?? '?'}→{r.meta.outputTokens ?? '?'}</MetaChip>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

type Mode = 'chat' | 'compare' | 'image'

export default function PlaygroundPage() {
  const [mode, setMode] = useState<Mode>('chat')
  const description = mode === 'chat'
    ? 'Drive the gateway over either protocol — watch which provider serves each turn, and whether it hit the cache.'
    : mode === 'compare'
      ? 'Send one prompt to several models at once and compare answers, latency, and cost.'
      : 'Generate images through the gateway — saved to the server and shown here.'

  return (
    <div>
      <PageHeader
        title="Playground"
        description={description}
        actions={
          <div className="inline-flex rounded-lg border bg-surface-2/60 p-0.5">
            {([['chat', 'Chat', MessageSquare], ['compare', 'Compare', Columns3], ['image', 'Image', ImageIcon]] as const).map(([m, label, Icon]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${mode === m ? 'bg-signal text-signal-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
        }
      />
      {mode === 'chat' && <ChatConsole />}
      {mode === 'compare' && <CompareConsole />}
      {mode === 'image' && <ImageConsole />}
    </div>
  )
}
