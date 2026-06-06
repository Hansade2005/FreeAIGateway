import { useEffect, useRef, useState } from 'react'
import type { Subscription } from 'rxjs'
import { Sparkles, Send, Download, FileCode, Plus, ExternalLink, X, Square, RotateCw } from 'lucide-react'
import { Workspace, type WCStatus } from './webcontainer'
import { runAgent } from './agent'
import { resolveBuilderModel, BUILDER_PRIMARY_MODEL } from './model'
import { STARTER_FILES } from './template'
import { downloadZip } from './zip'
import {
  type Project, type Message,
  createProject, getProject, listProjects, saveFiles, addMessage, getMessages,
} from './db'

const LAST_KEY = 'fag-builder-last'

export function Builder() {
  const [project, setProject] = useState<Project | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<WCStatus>('idle')
  const [previewUrl, setPreviewUrl] = useState('')
  const [errors, setErrors] = useState('')
  const [model, setModel] = useState('auto')
  const [showFiles, setShowFiles] = useState(false)
  const [selected, setSelected] = useState('src/App.jsx')
  const [fatal, setFatal] = useState('')

  const ws = useRef<Workspace | null>(null)
  const filesRef = useRef<Record<string, string>>({})
  const [files, setFiles] = useState<Record<string, string>>({})
  const sub = useRef<Subscription | null>(null)
  const logRef = useRef('')
  const chatEnd = useRef<HTMLDivElement>(null)
  const booted = useRef(false)

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, running])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    resolveBuilderModel().then(setModel)

    // Capture uncaught errors from the preview iframe (for the auto-fix loop).
    const onMsg = (e: MessageEvent) => {
      const d: any = e.data
      if (d && d.__fagPreview) {
        const line = `[${d.kind}] ${d.message}${d.stack ? '\n' + String(d.stack).split('\n').slice(0, 3).join('\n') : ''}`
        setErrors((p) => (p + '\n' + line).slice(-3000))
      }
    }
    window.addEventListener('message', onMsg)

    ;(async () => {
      if (!self.crossOriginIsolated) { setFatal('This page is not cross-origin isolated, so the in-browser runtime can’t start. Open /builder directly (it sets the required headers).'); return }
      const all = await listProjects()
      setProjects(all)
      const lastId = localStorage.getItem(LAST_KEY)
      let proj = (lastId && (await getProject(lastId))) || all[0] || null
      if (!proj) proj = await createProject('My app', { ...STARTER_FILES })
      localStorage.setItem(LAST_KEY, proj.id)
      setProject(proj)
      filesRef.current = proj.files
      setFiles(proj.files)
      setMessages(await getMessages(proj.id))
      await boot(proj.files)
    })().catch((e) => setFatal(e?.message ?? String(e)))

    return () => { window.removeEventListener('message', onMsg); sub.current?.unsubscribe() }
  }, [])

  async function boot(initial: Record<string, string>) {
    try {
      const w = new Workspace({
        onStatus: setStatus,
        onServerReady: setPreviewUrl,
        onOutput: (chunk) => {
          logRef.current = (logRef.current + chunk).slice(-8000)
          if (/error|failed|cannot find|is not defined/i.test(chunk)) setErrors((p) => (p + chunk).slice(-3000))
        },
      })
      ws.current = w
      await w.start(initial)
    } catch (e: any) {
      setFatal(e?.message ?? String(e))
    }
  }

  function setAssistant(update: (prev: string) => string) {
    setMessages((ms) => {
      const copy = ms.slice()
      const last = copy[copy.length - 1]
      if (last && last.role === 'assistant') copy[copy.length - 1] = { ...last, content: update(last.content) }
      return copy
    })
  }

  async function send(text: string) {
    const prompt = text.trim()
    if (!prompt || running || !project || status !== 'ready') return
    setInput('')
    setRunning(true)
    const userMsg: Message = { projectId: project.id, role: 'user', content: prompt, createdAt: Date.now() }
    setMessages((m) => [...m, userMsg, { projectId: project.id, role: 'assistant', content: '', createdAt: Date.now() }])
    await addMessage({ projectId: project.id, role: 'user', content: prompt })

    const history = messages.slice(-8).map((m) => ({ role: m.role, content: m.content }))
    const writtenPaths: string[] = []
    const recentErrors = errors
    setErrors('')
    let assistantText = ''

    sub.current = runAgent({
      history,
      files: filesRef.current,
      userPrompt: prompt,
      recentErrors,
      model,
      fallbackModel: model === BUILDER_PRIMARY_MODEL ? 'auto' : null,
    }).subscribe({
      next: (ev) => {
        if (ev.type === 'delta') { assistantText += ev.delta; setAssistant((p) => p + ev.delta) }
        else if (ev.type === 'file') {
          filesRef.current = { ...filesRef.current, [ev.path]: ev.contents }
          setFiles(filesRef.current)
          setSelected(ev.path)
          if (!writtenPaths.includes(ev.path)) writtenPaths.push(ev.path)
          ws.current?.writeFile(ev.path, ev.contents).catch(() => {})
        } else if (ev.type === 'error') {
          assistantText += `\n\n⚠️ ${ev.message}`
          setAssistant((p) => p + `\n\n⚠️ ${ev.message}`)
        }
      },
      complete: async () => {
        if (assistantText.trim()) await addMessage({ projectId: project.id, role: 'assistant', content: assistantText })
        await saveFiles(project.id, filesRef.current)
        if (writtenPaths.includes('package.json')) {
          setStatus('installing')
          await ws.current?.reinstall().catch(() => {})
          setStatus('ready')
        }
        setRunning(false)
      },
    })
  }

  function stop() { sub.current?.unsubscribe(); setRunning(false) }

  async function newProject() {
    const p = await createProject('My app', { ...STARTER_FILES })
    localStorage.setItem(LAST_KEY, p.id)
    location.reload()
  }
  async function openProject(id: string) {
    localStorage.setItem(LAST_KEY, id)
    location.reload()
  }

  const statusLabel: Record<WCStatus, string> = {
    idle: 'idle', booting: 'booting runtime…', installing: 'installing deps…',
    starting: 'starting dev server…', ready: 'live', error: 'error',
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <a href="/" className="flex items-center gap-2 text-sm font-semibold hover:opacity-80">
          <Sparkles className="size-4 text-signal" /> FreeAIGateway <span className="text-muted-foreground">Builder</span>
        </a>
        <select
          value={project?.id ?? ''}
          onChange={(e) => openProject(e.target.value)}
          className="ml-2 rounded-lg border bg-surface-1 px-2 py-1 text-xs"
          title="Switch project"
        >
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          {project && !projects.find((p) => p.id === project.id) && <option value={project.id}>{project.name}</option>}
        </select>
        <button onClick={newProject} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2" title="New project">
          <Plus className="size-3.5" /> New
        </button>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span className={`size-2 rounded-full ${status === 'ready' ? 'bg-signal' : status === 'error' ? 'bg-destructive' : 'bg-amber-400 animate-pulse'}`} />
          {statusLabel[status]}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{model}</span>
        <button onClick={() => setShowFiles((v) => !v)} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2">
          <FileCode className="size-3.5" /> Files
        </button>
        <button onClick={() => project && downloadZip(project.name, files)} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2">
          <Download className="size-3.5" /> ZIP
        </button>
      </header>

      {fatal ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-md space-y-2">
            <p className="font-display text-lg font-semibold">Can’t start the builder</p>
            <p className="text-sm text-muted-foreground">{fatal}</p>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Chat */}
          <div className="flex w-[380px] flex-none flex-col border-r">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 && (
                <div className="rounded-xl border bg-surface-1 p-4 text-sm text-muted-foreground">
                  Describe the app you want. e.g. <span className="text-foreground">“a pomodoro timer with a circular progress ring and a task list”</span>. The agent writes the code and the preview updates live.
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`rounded-xl px-3 py-2 text-sm ${m.role === 'user' ? 'ml-6 bg-signal-muted' : 'mr-2 border bg-surface-1'}`}>
                  <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{m.role}</div>
                  <div className="whitespace-pre-wrap break-words">{stripFileBlocks(m.content) || (running && i === messages.length - 1 ? '…' : '')}</div>
                </div>
              ))}
              <div ref={chatEnd} />
            </div>

            {errors.trim() && (
              <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[11px]">
                <span className="truncate text-destructive">Preview has errors</span>
                <button disabled={running} onClick={() => send('Fix the errors shown in the app.')} className="rounded bg-destructive/20 px-2 py-0.5 font-medium text-destructive hover:bg-destructive/30 disabled:opacity-50">Auto-fix</button>
              </div>
            )}

            <div className="border-t p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
                  placeholder={status === 'ready' ? 'Describe a change…' : 'Starting the sandbox…'}
                  rows={1}
                  disabled={status !== 'ready'}
                  className="max-h-[140px] min-h-[40px] flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-signal/40 disabled:opacity-50"
                />
                {running ? (
                  <button onClick={stop} className="flex items-center gap-1 rounded-lg bg-surface-2 px-3 py-2 text-sm font-medium"><Square className="size-3.5" /> Stop</button>
                ) : (
                  <button onClick={() => send(input)} disabled={!input.trim() || status !== 'ready'} className="flex items-center gap-1 rounded-lg bg-signal px-3 py-2 text-sm font-semibold text-signal-foreground disabled:opacity-50">
                    <Send className="size-4" /> Build
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Preview */}
          <div className="relative flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
              <RotateCw className="size-3.5 cursor-pointer hover:text-foreground" onClick={() => { const u = previewUrl; setPreviewUrl(''); setTimeout(() => setPreviewUrl(u), 50) }} />
              <span className="truncate font-mono">{previewUrl || 'preview'}</span>
              {previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer" className="ml-auto hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
            </div>
            <div className="flex-1 bg-white">
              {previewUrl
                ? <iframe title="preview" src={previewUrl} className="size-full border-0" allow="cross-origin-isolated" />
                : <div className="grid h-full place-items-center text-sm text-muted-foreground">{statusLabel[status]}</div>}
            </div>

            {/* Files slide-over */}
            {showFiles && (
              <div className="absolute inset-y-0 right-0 flex w-[520px] border-l bg-card shadow-2xl">
                <div className="w-44 flex-none overflow-y-auto border-r p-2">
                  <div className="mb-1 flex items-center justify-between px-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Files</span>
                    <X className="size-3.5 cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => setShowFiles(false)} />
                  </div>
                  {Object.keys(files).sort().map((p) => (
                    <button key={p} onClick={() => setSelected(p)} className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] ${selected === p ? 'bg-signal-muted text-signal' : 'text-muted-foreground hover:bg-surface-2'}`}>{p}</button>
                  ))}
                </div>
                <pre className="min-w-0 flex-1 overflow-auto bg-surface-1 p-3 font-mono text-[11.5px] leading-relaxed"><code>{files[selected] ?? ''}</code></pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Hide raw <file> blocks from the chat bubble (the code lands in the preview/files).
function stripFileBlocks(text: string): string {
  return text.replace(/<file[\s\S]*?<\/file>/gi, '').replace(/<file[\s\S]*$/i, '').trim()
}
