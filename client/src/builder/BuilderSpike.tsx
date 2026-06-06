import { useState, useRef, useEffect } from 'react'
import { WebContainer } from '@webcontainer/api'
import { spikeFiles } from './template'
import { resolveBuilderModel, BUILDER_PRIMARY_MODEL } from './model'

// WebContainer is a singleton per page (only one instance may boot).
let bootPromise: Promise<WebContainer> | null = null
function bootOnce() {
  if (!bootPromise) bootPromise = WebContainer.boot()
  return bootPromise
}

type Status = 'idle' | 'booting' | 'running' | 'ready' | 'error'

export function BuilderSpike() {
  const [status, setStatus] = useState<Status>('idle')
  const [log, setLog] = useState<string[]>([])
  const [previewUrl, setPreviewUrl] = useState('')
  const [agentModel, setAgentModel] = useState<string>('')
  const isolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false
  const logEnd = useRef<HTMLDivElement>(null)

  const add = (m: string) => setLog((l) => [...l, m])
  useEffect(() => { logEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [log])
  // The agent will drive codegen with this model (Phase 1).
  useEffect(() => { resolveBuilderModel().then(setAgentModel) }, [])

  async function run() {
    if (status === 'booting' || status === 'running') return
    setPreviewUrl(''); setLog([])
    add(`crossOriginIsolated = ${isolated}`)
    if (!isolated) {
      add('❌ Not cross-origin isolated — the COOP/COEP headers are missing on this document. WebContainer cannot boot.')
      setStatus('error'); return
    }
    try {
      setStatus('booting'); add('Booting WebContainer runtime…')
      const wc = await bootOnce()
      add('✅ Booted.')
      add('Mounting project files…')
      await wc.mount(spikeFiles)
      setStatus('running')
      wc.on('server-ready', (port, url) => {
        add(`🚀 server-ready on port ${port} → ${url}`)
        setPreviewUrl(url); setStatus('ready')
      })
      add('Starting: node server.js')
      const proc = await wc.spawn('node', ['server.js'])
      proc.output.pipeTo(new WritableStream({ write: (d) => add(d.replace(/\n$/, '')) }))
    } catch (e: any) {
      add(`ERROR: ${e?.message ?? e}`)
      setStatus('error')
    }
  }

  const badge =
    status === 'ready' ? { t: 'preview live', c: 'var(--signal)' } :
    status === 'error' ? { t: 'error', c: '#ef4444' } :
    status === 'idle' ? { t: 'idle', c: 'var(--muted-foreground, #888)' } :
    { t: status + '…', c: 'var(--signal)' }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--background)', color: 'var(--foreground)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
        <a href="/" style={{ color: 'inherit', textDecoration: 'none', fontWeight: 600 }}>← FreeAIGateway</a>
        <span style={{ opacity: 0.4 }}>/</span>
        <strong>Builder spike</strong>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontFamily: 'ui-monospace, monospace', color: badge.c }}>● {badge.t}</span>
      </header>

      <div style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: '380px 1fr', alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--muted-foreground, #9aa0a6)' }}>
            Phase-0 de-risk: boot a WebContainer (Node runtime <b>in the browser</b>), run a server, and embed its live preview —
            proving cross-origin isolation works before we build the agent.
          </div>
          <div style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-1, #1a1d22)' }}>
            crossOriginIsolated: <b style={{ color: isolated ? 'var(--signal)' : '#ef4444' }}>{String(isolated)}</b>
          </div>
          <div style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-1, #1a1d22)' }}>
            agent model: <b style={{ color: 'var(--signal)' }}>{agentModel || '…'}</b>
            {agentModel && agentModel !== BUILDER_PRIMARY_MODEL && <span style={{ color: 'var(--muted-foreground, #9aa0a6)' }}>  (Kilo not configured → gateway auto)</span>}
          </div>
          <button
            onClick={run}
            disabled={status === 'booting' || status === 'running'}
            style={{ padding: '10px 16px', borderRadius: 10, border: 'none', fontWeight: 600, cursor: 'pointer',
                     background: 'var(--signal, #5ce39a)', color: 'var(--signal-foreground, #07251a)' }}
          >
            {status === 'idle' || status === 'error' ? 'Boot & run preview' : 'Running…'}
          </button>
          <div style={{ height: 320, overflow: 'auto', padding: 12, borderRadius: 10, border: '1px solid var(--border)',
                        background: 'var(--code-bg, #0c0e12)', fontFamily: 'ui-monospace, monospace', fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {log.length === 0 ? <span style={{ opacity: 0.5 }}>Logs will appear here…</span> : log.map((l, i) => <div key={i}>{l}</div>)}
            <div ref={logEnd} />
          </div>
        </div>

        <div style={{ height: 'calc(100vh - 120px)', borderRadius: 14, border: '1px solid var(--border)', overflow: 'hidden', background: '#fff' }}>
          {previewUrl
            ? <iframe title="preview" src={previewUrl} style={{ width: '100%', height: '100%', border: 'none' }} allow="cross-origin-isolated" />
            : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#888', fontSize: 14 }}>Preview appears here once the in-browser server is ready.</div>}
        </div>
      </div>
    </div>
  )
}
