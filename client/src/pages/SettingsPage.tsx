import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, Check, Eye, EyeOff, RefreshCw, KeyRound, Plug, ShieldAlert, Zap, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'

interface CacheState {
  enabled: boolean
  ttlSeconds: number
  stats: { hits: number; misses: number; stores: number; entries: number; hitRate: number }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-surface-2/50 px-3 py-2.5">
      <div className="font-mono text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  )
}

function CacheCard() {
  const queryClient = useQueryClient()
  const { data } = useQuery<CacheState>({
    queryKey: ['cache'],
    queryFn: () => apiFetch('/api/settings/cache'),
    refetchInterval: 10000,
  })
  const [ttl, setTtl] = useState('')
  useEffect(() => { if (data && ttl === '') setTtl(String(data.ttlSeconds)) }, [data, ttl])

  const patch = useMutation({
    mutationFn: (body: { enabled?: boolean; ttlSeconds?: number }) =>
      apiFetch<CacheState>('/api/settings/cache', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (res) => queryClient.setQueryData(['cache'], res),
  })
  const clear = useMutation({
    mutationFn: () => apiFetch<CacheState>('/api/settings/cache/clear', { method: 'POST' }),
    onSuccess: (res) => queryClient.setQueryData(['cache'], res),
  })

  const enabled = data?.enabled ?? false
  const stats = data?.stats
  const ttlChanged = data && ttl !== '' && Number(ttl) !== data.ttlSeconds && Number(ttl) > 0

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-signal-muted text-signal">
              <Zap className="size-4" />
            </span>
            <div>
              <CardTitle>Prompt cache</CardTitle>
              <CardDescription>Serve identical requests from memory — no provider call, instant reply, free-tier saved.</CardDescription>
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={(v: boolean) => patch.mutate({ enabled: v })} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">TTL (seconds)</label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                value={ttl}
                onChange={(e) => setTtl(e.target.value)}
                className="h-9 w-32 font-mono"
                disabled={!enabled}
              />
              {ttlChanged && (
                <Button size="sm" variant="outline" onClick={() => patch.mutate({ ttlSeconds: Number(ttl) })} disabled={patch.isPending}>
                  Save
                </Button>
              )}
            </div>
          </div>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => clear.mutate()} disabled={clear.isPending || !stats?.entries}>
            <Trash2 className="size-3.5" /> Flush {stats?.entries ? `(${stats.entries})` : ''}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Hit rate" value={stats ? `${Math.round(stats.hitRate * 100)}%` : '—'} />
          <Stat label="Hits" value={stats ? String(stats.hits) : '—'} />
          <Stat label="Misses" value={stats ? String(stats.misses) : '—'} />
          <Stat label="Entries" value={stats ? String(stats.entries) : '—'} />
        </div>
        <p className="text-xs text-muted-foreground">
          Keyed on the full request shape. Send <code className="font-mono">x-cache: no-store</code> on a request to bypass.
          Streamed answers with tool calls aren't cached.
        </p>
      </CardContent>
    </Card>
  )
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  function copy(value: string, id: string) {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(id)
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1400)
    })
  }
  return { copied, copy }
}

// A monospace value row with copy (and optional reveal for secrets).
function ValueRow({ id, value, secret = false, copied, onCopy }: {
  id: string; value: string; secret?: boolean; copied: string | null; onCopy: (v: string, id: string) => void
}) {
  const [shown, setShown] = useState(!secret)
  const display = secret && !shown ? value.replace(/./g, '•').slice(0, 44) : value
  return (
    <div className="flex items-center gap-2 rounded-xl border bg-surface-2/60 px-3 py-2 font-mono text-xs">
      <code className="min-w-0 flex-1 truncate text-foreground/90">{display}</code>
      {secret && (
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label={shown ? 'Hide' : 'Reveal'}
        >
          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      )}
      <button
        type="button"
        onClick={() => onCopy(value, id)}
        className="text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Copy"
      >
        {copied === id ? <Check className="size-4 text-signal" /> : <Copy className="size-4" />}
      </button>
    </div>
  )
}

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const { copied, copy } = useCopy()
  const [confirming, setConfirming] = useState(false)

  const { data, isLoading } = useQuery<{ apiKey: string }>({
    queryKey: ['api-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch<{ apiKey: string }>('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: (res) => {
      queryClient.setQueryData(['api-key'], res)
      setConfirming(false)
    },
  })

  const apiKey = data?.apiKey ?? ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div className="stagger">
      <PageHeader
        title="Settings"
        description="Your unified key, connection endpoints, and gateway preferences."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Unified API key */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-signal-muted text-signal">
                <KeyRound className="size-4" />
              </span>
              <div>
                <CardTitle>Unified API key</CardTitle>
                <CardDescription>One key for every provider behind the gateway. Sent as a Bearer token or <code className="font-mono">x-api-key</code>.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <div className="h-10 animate-pulse rounded-xl bg-surface-2" />
            ) : (
              <ValueRow id="key" value={apiKey} secret copied={copied} onCopy={copy} />
            )}

            <div className="flex flex-wrap items-center gap-3">
              {!confirming ? (
                <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                  <RefreshCw className="size-3.5" /> Regenerate key
                </Button>
              ) : (
                <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
                  <ShieldAlert className="size-4 text-destructive" />
                  <span className="text-muted-foreground">This revokes the current key everywhere. Sure?</span>
                  <Button size="sm" variant="destructive" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>
                    {regenerate.isPending ? 'Rotating…' : 'Regenerate'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Prompt cache */}
        <CacheCard />

        {/* OpenAI-compatible endpoint */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Plug className="size-4 text-muted-foreground" />
                <CardTitle>OpenAI-compatible</CardTitle>
              </div>
              <Badge variant="secondary" className="font-mono text-[10px]">/v1</Badge>
            </div>
            <CardDescription>Point any OpenAI SDK or client at this base URL.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="mb-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">base_url</p>
              <ValueRow id="openai-base" value={`${origin}/v1`} copied={copied} onCopy={copy} />
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li><code className="font-mono text-foreground/80">POST /v1/chat/completions</code></li>
              <li><code className="font-mono text-foreground/80">POST /v1/responses</code> · <code className="font-mono text-foreground/80">/v1/embeddings</code></li>
              <li><code className="font-mono text-foreground/80">GET /v1/models</code></li>
            </ul>
          </CardContent>
        </Card>

        {/* Anthropic-compatible endpoint */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Plug className="size-4 text-muted-foreground" />
                <CardTitle>Anthropic-compatible</CardTitle>
              </div>
              <Badge className="bg-signal-muted font-mono text-[10px] text-signal">new</Badge>
            </div>
            <CardDescription>Point Claude Code or the Anthropic SDK here — set as <code className="font-mono">ANTHROPIC_BASE_URL</code>.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="mb-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">base url</p>
              <ValueRow id="anthropic-base" value={origin} copied={copied} onCopy={copy} />
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li><code className="font-mono text-foreground/80">POST /v1/messages</code></li>
              <li><code className="font-mono text-foreground/80">POST /v1/messages/count_tokens</code></li>
              <li>Unknown Claude model ids auto-route to a free model.</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
