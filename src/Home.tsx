import { useEffect, useRef, useState } from 'react'
import { Sparkles, ArrowUp, Plus, Mic, FolderOpen, Trash2 } from 'lucide-react'
import { listProjects, deleteProject, type Project } from './builder/db'
import { FRAMEWORK_LIST } from './builder/frameworks'
import { getDailySuggestions, FALLBACK_SUGGESTIONS } from './a0'

function timeAgo(t: number): string {
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24); return `${d}d ago`
}
// A stable two-color gradient per project for the card thumbnail.
function gradientFor(id: string): string {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return `linear-gradient(135deg, oklch(0.6 0.18 ${h}), oklch(0.55 0.16 ${(h + 60) % 360}))`
}

export function Home({ onStart, onOpen, onEditProvider }: {
  onStart: (prompt: string, framework: string) => void
  onOpen: (id: string) => void
  onEditProvider?: () => void
}) {
  const [prompt, setPrompt] = useState('')
  const [framework, setFramework] = useState('react')
  const [projects, setProjects] = useState<Project[]>([])
  const [suggestions, setSuggestions] = useState<string[]>(FALLBACK_SUGGESTIONS)
  const [listening, setListening] = useState(false)
  const recRef = useRef<any>(null)

  useEffect(() => { listProjects().then(setProjects).catch(() => {}) }, [])
  useEffect(() => { let ok = true; getDailySuggestions().then((s) => { if (ok && s.length) setSuggestions(s) }).catch(() => {}); return () => { ok = false } }, [])
  useEffect(() => () => { try { recRef.current?.stop() } catch { /* ignore */ } }, [])

  const submit = () => { const v = prompt.trim(); if (v) onStart(v, framework) }

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This removes the app and its chat history. Cannot be undone.`)) return
    await deleteProject(id)
    setProjects((ps) => ps.filter((p) => p.id !== id))
  }

  const voice = () => {
    const W = window as any
    const R = W.SpeechRecognition ?? W.webkitSpeechRecognition
    if (!R) { alert('Voice input is not supported in this browser.'); return }
    if (listening) { recRef.current?.stop(); return }
    const rec = new R()
    rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1
    recRef.current = rec; setListening(true)
    rec.onresult = (e: any) => { const t = e.results?.[0]?.[0]?.transcript?.trim(); if (t) setPrompt((p) => (p ? p + ' ' : '') + t) }
    rec.onerror = () => setListening(false)
    rec.onend = () => setListening(false)
    rec.start()
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between px-5 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-signal" /> AI Builder
        </div>
        <button onClick={onEditProvider} className="rounded-lg border px-2.5 py-1 text-xs text-muted-foreground hover:bg-surface-2 hover:text-foreground">Provider</button>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 pb-20">
        {/* Hero */}
        <section className="relative mt-10 overflow-hidden rounded-3xl border bg-surface-1 px-6 py-14 text-center sm:py-20">
          <div className="pointer-events-none absolute inset-0 opacity-60" style={{ background: 'radial-gradient(60% 80% at 50% 0%, var(--signal-muted), transparent)' }} />
          <div className="relative">
            <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground">
              <Sparkles size={12} className="text-signal" /> Build full web apps with AI — in your browser
            </span>
            <h1 className="mt-6 font-display text-3xl font-semibold tracking-tight sm:text-5xl">What should we build?</h1>
            <p className="mt-3 text-sm text-muted-foreground">Describe your idea — the agent writes the code and runs it live.</p>

            <form
              onSubmit={(e) => { e.preventDefault(); submit() }}
              className="mx-auto mt-8 max-w-xl rounded-2xl border bg-background p-2.5 text-left shadow-xl focus-within:border-signal/50 focus-within:ring-2 focus-within:ring-signal/25"
            >
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
                placeholder="Ask the agent to create a landing page for…"
                rows={3}
                className="w-full resize-none bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none"
              />
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-1">
                  <button type="button" aria-label="Attach" className="grid size-9 place-items-center rounded-lg text-muted-foreground/50" title="Attachments coming soon"><Plus size={18} /></button>
                  <select
                    value={framework}
                    onChange={(e) => setFramework(e.target.value)}
                    title="Framework"
                    className="rounded-lg border bg-surface-1 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-signal/30"
                  >
                    {FRAMEWORK_LIST.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={voice} aria-label="Voice" className={`grid size-9 place-items-center rounded-lg ${listening ? 'text-destructive' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
                    <Mic size={18} />
                  </button>
                  <button type="submit" aria-label="Send" disabled={!prompt.trim()} className="grid size-9 place-items-center rounded-lg bg-signal text-signal-foreground transition hover:opacity-90 disabled:opacity-40">
                    <ArrowUp size={18} strokeWidth={2.5} />
                  </button>
                </div>
              </div>
            </form>

            <div className="mx-auto mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button key={s} onClick={() => setPrompt(s)} className="rounded-full border px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-2 hover:text-foreground">
                  {s.length > 42 ? s.slice(0, 42) + '…' : s}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Projects */}
        <section className="mt-10">
          <h2 className="mb-4 text-sm font-medium text-muted-foreground">Your apps</h2>
          {projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed p-12 text-center text-sm text-muted-foreground">
              No apps yet — describe one above to start building.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {projects.map((p) => (
                <div key={p.id} className="group relative overflow-hidden rounded-2xl border bg-surface-1 transition-colors hover:border-signal/40">
                  <button onClick={() => onOpen(p.id)} className="block w-full text-left">
                    <div className="relative aspect-[16/9] overflow-hidden" style={{ background: gradientFor(p.id) }}>
                      <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/40 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
                        <FolderOpen className="size-3" /> open
                      </span>
                    </div>
                    <div className="p-4">
                      <h3 className="truncate text-sm font-medium">{p.name}</h3>
                      <p className="text-xs text-muted-foreground">edited {timeAgo(p.updatedAt)}</p>
                    </div>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); remove(p.id, p.name) }}
                    title="Delete app"
                    className="absolute right-2 top-2 grid size-7 place-items-center rounded-lg bg-black/40 text-white/80 opacity-0 backdrop-blur transition hover:bg-destructive hover:text-white group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
