import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Subscription } from 'rxjs'
import { Sparkles, Send, Eye, Code2, Plus, ExternalLink, Square, RotateCw, RotateCcw, Rocket, Download, FileText, FileSearch, Trash2, Image as ImageIcon, Loader2, TerminalSquare, Copy, Check, Camera, ScrollText, ChevronDown, Palette } from 'lucide-react'
import { Workspace, type WCStatus } from './webcontainer'
import { runAgent } from './agent'
import { generateImageBytes } from './gateway'
import { CodeView } from './CodeView'
import { resolveBuilderModel, BUILDER_PRIMARY_MODEL } from './model'
import { STARTER_FILES } from './template'
import { downloadZip } from './zip'
import {
  type Project, type Message, type StoredAction, type MessagePart,
  createProject, getProject, listProjects, saveFiles, saveAssets, saveDeploy, addMessage, getMessages, deleteMessage, deleteMessagesAfter,
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
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [selected, setSelected] = useState('src/App.jsx')
  const [writing, setWriting] = useState('')
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [fatal, setFatal] = useState('')

  const ws = useRef<Workspace | null>(null)
  const filesRef = useRef<Record<string, string>>({})
  const assetsRef = useRef<Record<string, Uint8Array>>({})
  const [files, setFiles] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<string | null>(null) // editable buffer for the selected file
  const sub = useRef<Subscription | null>(null)
  const logRef = useRef('')
  const consoleRef = useRef<string[]>([])           // app console output + runtime errors
  const previewIframeRef = useRef<HTMLIFrameElement>(null)
  const pendingReqs = useRef<Map<string, (v: any) => void>>(new Map())
  const chatEnd = useRef<HTMLDivElement>(null)
  const booted = useRef(false)

  // Ask the preview (cross-origin iframe) for its DOM / a screenshot via postMessage.
  function requestFromPreview(type: 'dom' | 'shot', timeout = 20000): Promise<any> {
    return new Promise((resolve) => {
      const win = previewIframeRef.current?.contentWindow
      if (!win) return resolve({ error: 'preview not running' })
      const id = Math.random().toString(36).slice(2)
      const timer = setTimeout(() => { pendingReqs.current.delete(id); resolve({ error: 'timed out' }) }, timeout)
      pendingReqs.current.set(id, (v) => { clearTimeout(timer); resolve(v) })
      win.postMessage({ __fagReq: type, id }, '*')
    })
  }

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, running])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    resolveBuilderModel().then(setModel)

    // Messages from the preview iframe: errors, console output, and replies to
    // our DOM/screenshot requests.
    const pushLog = (line: string) => { consoleRef.current.push(line); if (consoleRef.current.length > 300) consoleRef.current.shift() }
    const onMsg = (e: MessageEvent) => {
      const d: any = e.data
      if (!d) return
      if (d.__fagPreview) {
        const line = `[${d.kind}] ${d.message}${d.stack ? '\n' + String(d.stack).split('\n').slice(0, 3).join('\n') : ''}`
        pushLog(line)
        setErrors((p) => (p + '\n' + line).slice(-3000))
      } else if (d.__fagConsole) {
        pushLog(`[${d.level}] ${d.text}`)
      } else if (d.__fagRes && d.id) {
        const resolve = pendingReqs.current.get(d.id)
        if (resolve) { resolve(d); pendingReqs.current.delete(d.id) }
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
      assetsRef.current = proj.assets ?? {}
      setFiles(proj.files)
      setMessages(await getMessages(proj.id))
      await boot(proj.files, assetsRef.current)
    })().catch((e) => setFatal(e?.message ?? String(e)))

    return () => { window.removeEventListener('message', onMsg); sub.current?.unsubscribe() }
  }, [])

  async function boot(initial: Record<string, string>, assets: Record<string, Uint8Array> = {}) {
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
      // Restore generated image assets into the running project.
      for (const [path, bytes] of Object.entries(assets)) await w.writeBinary(path, bytes).catch(() => {})
    } catch (e: any) {
      setFatal(e?.message ?? String(e))
    }
  }

  // Update the streaming assistant message's content / actions in place.
  function patchAssistant(patch: (m: Message) => Message) {
    setMessages((ms) => {
      const copy = ms.slice()
      const last = copy[copy.length - 1]
      if (last && last.role === 'assistant') copy[copy.length - 1] = patch(last)
      return copy
    })
  }

  async function send(text: string) {
    const prompt = text.trim()
    if (!prompt || running || !project || status !== 'ready') return
    setInput('')
    setRunning(true)
    setWriting('')
    // Snapshot the project as it is now (before the agent runs) so this user
    // message becomes a restorable checkpoint.
    const checkpoint = { files: { ...filesRef.current }, assets: { ...assetsRef.current } }
    const userMsg: Message = { projectId: project.id, role: 'user', content: prompt, checkpoint, createdAt: Date.now() }
    setMessages((m) => [...m, userMsg, { projectId: project.id, role: 'assistant', content: '', actions: [], parts: [], createdAt: Date.now() }])
    await addMessage({ projectId: project.id, role: 'user', content: prompt, checkpoint })

    const history = messages.slice(-8).map((m) => ({ role: m.role, content: m.content }))
    const recentErrors = errors
    setErrors('')
    let content = ''
    const acts: StoredAction[] = []
    // Ordered timeline of text + actions so pills render inline where they happened.
    const parts: MessagePart[] = []
    const pushText = (t: string) => {
      const last = parts[parts.length - 1]
      if (last && last.type === 'text') last.text += t
      else parts.push({ type: 'text', text: t })
    }

    sub.current = runAgent({
      history,
      files: filesRef.current,
      userPrompt: prompt,
      recentErrors,
      model,
      fallbackModel: model === BUILDER_PRIMARY_MODEL ? 'auto' : null,
      exec: {
        writeFile: async (path, c) => {
          filesRef.current = { ...filesRef.current, [path]: c }
          setFiles(filesRef.current)
          await ws.current?.writeFile(path, c)
        },
        editFile: async (path, find, replace, replaceAll) => {
          const cur = filesRef.current[path] ?? (await ws.current?.readFile(path)) ?? null
          if (cur == null) return { ok: false, count: 0, message: `not found: ${path}` }
          if (!cur.includes(find)) return { ok: false, count: 0, message: `text not found in ${path}` }
          const count = replaceAll ? cur.split(find).length - 1 : 1
          const next = replaceAll ? cur.split(find).join(replace) : cur.replace(find, replace)
          filesRef.current = { ...filesRef.current, [path]: next }
          setFiles(filesRef.current)
          await ws.current?.writeFile(path, next)
          return { ok: true, count }
        },
        readFile: async (path) => filesRef.current[path] ?? (await ws.current?.readFile(path)) ?? null,
        listFiles: () => Object.keys(filesRef.current),
        deleteFile: async (path) => {
          const f = { ...filesRef.current }; delete f[path]; filesRef.current = f; setFiles(f)
          await ws.current?.deleteFile(path)
        },
        generateImage: async (p, path) => {
          const bytes = await generateImageBytes(p)
          assetsRef.current = { ...assetsRef.current, [path]: bytes }
          await ws.current?.writeBinary(path, bytes)
          if (project) await saveAssets(project.id, assetsRef.current)
        },
        runCommand: async (command) => {
          const r = (await ws.current?.exec(command)) ?? { output: 'sandbox not ready', exitCode: -1 }
          const pkg = await ws.current?.readFile('package.json')
          if (pkg) { filesRef.current = { ...filesRef.current, 'package.json': pkg }; setFiles(filesRef.current) }
          return r
        },
        getConsoleLogs: async () => consoleRef.current.slice(-100).join('\n') || '(no console output yet)',
        readDom: async () => { const r = await requestFromPreview('dom'); return r.html ?? `(could not read DOM: ${r.error ?? 'unknown'})` },
        screenshot: async () => { const r = await requestFromPreview('shot', 30000); return { dataUrl: r.dataUrl, error: r.error } },
      },
    }).subscribe({
      next: (ev) => {
        if (ev.type === 'delta') { content += ev.delta; pushText(ev.delta); patchAssistant((m) => ({ ...m, content, parts: [...parts] })) }
        else if (ev.type === 'writing') setWriting(ev.path)
        else if (ev.type === 'fileWritten') setSelected(ev.path)
        else if (ev.type === 'action') {
          acts.push(ev.action)
          parts.push({ type: 'action', action: ev.action })
          patchAssistant((m) => ({ ...m, actions: [...acts], parts: [...parts] }))
          setWriting((w) => (w === ev.action.path ? '' : w))
        } else if (ev.type === 'error') {
          content += `\n\n⚠️ ${ev.message}`
          pushText(`\n\n⚠️ ${ev.message}`)
          patchAssistant((m) => ({ ...m, content, parts: [...parts] }))
        }
      },
      complete: async () => {
        setWriting('')
        if (content.trim() || acts.length) await addMessage({ projectId: project.id, role: 'assistant', content, actions: acts, parts })
        await saveFiles(project.id, filesRef.current)
        // Reload from DB so messages carry their ids + checkpoints (enables the
        // copy / delete / restore actions).
        setMessages(await getMessages(project.id))
        setRunning(false)
      },
    })
  }

  function stop() { sub.current?.unsubscribe(); setRunning(false) }

  async function copyMessage(text: string, i: number) {
    try { await navigator.clipboard.writeText(text) } catch { /* ignore */ }
    setCopiedIdx(i); setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1400)
  }

  async function deleteMsg(m: Message, i: number) {
    if (m.id != null) await deleteMessage(m.id)
    setMessages((ms) => ms.filter((_, idx) => idx !== i))
  }

  // Roll the codebase back to a user message's checkpoint and drop everything
  // after it (in the sandbox, the UI, and the DB).
  async function restoreCheckpoint(m: Message, i: number) {
    if (!project || !m.checkpoint || running) return
    if (!confirm('Restore the code to this point? Changes and messages after it will be discarded.')) return
    const cp = m.checkpoint
    const keep = new Set([...Object.keys(cp.files), ...Object.keys(cp.assets ?? {})])
    // remove files/assets added since the checkpoint
    for (const p of [...Object.keys(filesRef.current), ...Object.keys(assetsRef.current)]) {
      if (!keep.has(p)) await ws.current?.deleteFile(p).catch(() => {})
    }
    filesRef.current = { ...cp.files }
    assetsRef.current = { ...(cp.assets ?? {}) }
    setFiles(filesRef.current)
    for (const [p, c] of Object.entries(cp.files)) await ws.current?.writeFile(p, c).catch(() => {})
    for (const [p, b] of Object.entries(cp.assets ?? {})) await ws.current?.writeBinary(p, b).catch(() => {})
    await saveFiles(project.id, filesRef.current)
    await saveAssets(project.id, assetsRef.current)
    await deleteMessagesAfter(project.id, m.createdAt)
    setMessages((ms) => ms.slice(0, i + 1))
    setErrors('')
  }

  // Manual edit of the selected file → write to the running sandbox + persist.
  async function saveDraft() {
    if (draft === null || !project) return
    filesRef.current = { ...filesRef.current, [selected]: draft }
    setFiles(filesRef.current)
    await ws.current?.writeFile(selected, draft).catch(() => {})
    await saveFiles(project.id, filesRef.current)
    setDraft(null)
  }

  // Build in the sandbox, hand the dist off via IndexedDB, and open the
  // (non-isolated) deploy page where Puter auth + upload happen.
  async function deploy() {
    if (!project || running || status !== 'ready') return
    try {
      setStatus('installing')
      const dist = await ws.current!.build()
      const id = await saveDeploy(project.name, dist)
      setStatus('ready')
      window.open(`/deploy?id=${id}`, '_blank', 'noopener')
    } catch (e: any) {
      setStatus('ready')
      setErrors((p) => (p + '\nBuild failed: ' + (e?.message ?? e)).slice(-3000))
    }
  }

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
        <button onClick={() => project && downloadZip(project.name, files, assetsRef.current)} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2">
          <Download className="size-3.5" /> ZIP
        </button>
        <button onClick={deploy} disabled={running || status !== 'ready'} className="flex items-center gap-1 rounded-lg bg-signal px-2.5 py-1 text-xs font-semibold text-signal-foreground disabled:opacity-50" title="Build and deploy to Puter">
          <Rocket className="size-3.5" /> Deploy
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
              {messages.map((m, i) => {
                const isUser = m.role === 'user'
                const isLast = i === messages.length - 1
                const actions = m.actions ?? []
                const showWriting = m.role === 'assistant' && running && isLast && !!writing
                const showActionRow = !running || !isLast
                const openInCode = (p: string) => { setSelected(p); setTab('code') }
                const empty = !m.content && (!m.parts || m.parts.length === 0)
                return (
                  <div key={m.id ?? i} className={`group relative rounded-xl px-3 py-2 text-sm ${isUser ? 'ml-6 bg-signal-muted' : 'mr-2 border bg-surface-1'}`}>
                    <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{m.role}</div>
                    {isUser ? (
                      <UserText text={m.content} />
                    ) : m.parts ? (
                      // Inline timeline: text and tool pills in the exact order they happened.
                      <div className="flex flex-col gap-1.5">
                        {m.parts.map((part, k) => part.type === 'text'
                          ? (cleanText(part.text) ? <div key={k} className="whitespace-pre-wrap break-words">{cleanText(part.text)}</div> : null)
                          : <ActionPill key={k} action={part.action} onOpen={openInCode} />)}
                        {empty && running && isLast && !showWriting && <div className="text-muted-foreground">Thinking…</div>}
                        {showWriting && (
                          <span className="flex items-center gap-1.5 self-start rounded-md border border-signal/40 bg-signal-muted px-2 py-1 font-mono text-[11px] text-signal">
                            <Loader2 className="size-3 animate-spin" /> writing {writing}…
                          </span>
                        )}
                      </div>
                    ) : (
                      // Legacy messages (pre-timeline): prose then grouped pills.
                      <>
                        <div className="whitespace-pre-wrap break-words">{cleanText(m.content)}</div>
                        {actions.length > 0 && (
                          <div className="mt-2 flex flex-col gap-1">
                            {actions.map((a, j) => <ActionPill key={j} action={a} onOpen={openInCode} />)}
                          </div>
                        )}
                      </>
                    )}
                    {showActionRow && (
                      <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <MsgIcon title={copiedIdx === i ? 'Copied' : 'Copy'} onClick={() => copyMessage(m.content, i)}>
                          {copiedIdx === i ? <Check className="size-3 text-signal" /> : <Copy className="size-3" />}
                        </MsgIcon>
                        {isUser && m.checkpoint && (
                          <MsgIcon title="Restore code to here" onClick={() => restoreCheckpoint(m, i)}><RotateCcw className="size-3" /></MsgIcon>
                        )}
                        <MsgIcon title="Delete message" onClick={() => deleteMsg(m, i)}><Trash2 className="size-3" /></MsgIcon>
                      </div>
                    )}
                  </div>
                )
              })}
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

          {/* Preview | Code */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
              <div className="flex rounded-lg border bg-surface-1 p-0.5">
                <button onClick={() => setTab('preview')} className={`flex items-center gap-1 rounded-md px-2.5 py-1 ${tab === 'preview' ? 'bg-signal text-signal-foreground' : 'text-muted-foreground hover:text-foreground'}`}><Eye className="size-3.5" /> Preview</button>
                <button onClick={() => setTab('code')} className={`flex items-center gap-1 rounded-md px-2.5 py-1 ${tab === 'code' ? 'bg-signal text-signal-foreground' : 'text-muted-foreground hover:text-foreground'}`}><Code2 className="size-3.5" /> Code</button>
              </div>
              {tab === 'preview' && (
                <>
                  <RotateCw className="ml-1 size-3.5 cursor-pointer hover:text-foreground" onClick={() => { const u = previewUrl; setPreviewUrl(''); setTimeout(() => setPreviewUrl(u), 50) }} />
                  <span className="truncate font-mono">{previewUrl || 'preview'}</span>
                  {previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer" className="ml-auto hover:text-foreground"><ExternalLink className="size-3.5" /></a>}
                </>
              )}
            </div>
            <div className="min-h-0 flex-1">
              {tab === 'preview' ? (
                <div className="size-full bg-white">
                  {previewUrl
                    ? <iframe ref={previewIframeRef} title="preview" src={previewUrl} className="size-full border-0" allow="cross-origin-isolated" />
                    : <div className="grid h-full place-items-center text-sm text-muted-foreground">{statusLabel[status]}</div>}
                </div>
              ) : (
                <CodeView
                  files={files}
                  assets={assetsRef.current}
                  selected={selected}
                  onSelect={(p) => { setSelected(p); setDraft(null) }}
                  draft={draft}
                  onChangeDraft={setDraft}
                  onSave={saveDraft}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Collapse the agent's narration: trim and squash runs of blank lines (it can
// accumulate many newlines across tool turns, which whitespace-pre-wrap would
// otherwise render as a big empty gap before the action pills).
function cleanText(s: string): string {
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const TRUNCATE_AT = 128

// User messages over ~128 chars are clamped with a Show more toggle that expands
// into a scrollable box.
function UserText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (text.length <= TRUNCATE_AT) return <div className="whitespace-pre-wrap break-words">{text}</div>
  return (
    <div>
      <div className={`whitespace-pre-wrap break-words ${open ? 'max-h-48 overflow-y-auto pr-1' : ''}`}>
        {open ? text : text.slice(0, TRUNCATE_AT).trimEnd() + '…'}
      </div>
      <button onClick={() => setOpen((o) => !o)} className="mt-1 text-[11px] font-medium text-signal hover:underline">
        {open ? 'Show less' : 'Show more'}
      </button>
    </div>
  )
}

// Small ghost icon button used in the per-message action row.
function MsgIcon({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button title={title} onClick={onClick} className="rounded p-1 text-muted-foreground hover:bg-surface-2 hover:text-foreground">
      {children}
    </button>
  )
}

// Hard-truncate pill text so long paths/commands never overflow the chat column.
const pillText = (s: string, n = 22) => (s.length > n ? s.slice(0, n) + '…' : s)

// A single agent action rendered as an inline pill. File/image/delete open the
// target in Code; any action that produced output (command, console, dom, read)
// is collapsible to reveal it.
function ActionPill({ action, onOpen }: { action: StoredAction; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const base = 'flex items-center gap-1.5 self-start rounded-md border bg-surface-2 px-2 py-1 font-mono text-[11px]'
  const Icon = action.kind === 'command' ? TerminalSquare
    : action.kind === 'console' ? ScrollText
    : action.kind === 'screenshot' ? Camera
    : action.kind === 'dom' ? Code2
    : action.kind === 'design' ? Palette
    : action.kind === 'image' ? ImageIcon
    : action.kind === 'delete' ? Trash2
    : action.kind === 'file' ? FileText
    : FileSearch

  // File/image/delete → click to open in the Code tab.
  if (action.kind === 'file' || action.kind === 'image' || action.kind === 'delete') {
    return (
      <button onClick={() => action.path && onOpen(action.path)} className={`${base} text-muted-foreground hover:text-foreground`} title={action.label}>
        <Icon className={`size-3 shrink-0 ${action.kind === 'delete' ? 'text-destructive' : 'text-signal'}`} />
        <span>{pillText(action.label)}</span>
      </button>
    )
  }

  const label = action.kind === 'command' ? '$ ' + pillText(action.label.replace(/^\$ /, '')) : pillText(action.label)

  // Anything with captured output → collapsible (terminal, console, dom, read).
  if (action.output) {
    return (
      <div className="self-start">
        <button onClick={() => setOpen((o) => !o)} className={`${base} text-muted-foreground hover:text-foreground`} title={action.label}>
          <Icon className={`size-3 shrink-0 ${action.kind === 'command' ? 'text-signal' : ''}`} />
          <span>{label}</span>
          <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <pre className="mt-1 max-h-52 max-w-[340px] overflow-auto whitespace-pre-wrap rounded-md border bg-surface-1 p-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">{action.output}</pre>
        )}
      </div>
    )
  }

  // Plain informational pill (list, design, screenshot, …).
  return <span className={`${base} text-muted-foreground/60`} title={action.label}><Icon className="size-3 shrink-0" /><span>{label}</span></span>
}
