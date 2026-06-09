import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Subscription } from 'rxjs'
import { Sparkles, Send, Eye, Code2, Plus, ExternalLink, Square, RotateCw, RotateCcw, Rocket, Download, FileText, FileSearch, Trash2, Image as ImageIcon, Loader2, TerminalSquare, Copy, Check, Camera, ScrollText, ChevronDown, ChevronLeft, ChevronRight, Palette, Pencil, X, LayoutGrid, FolderOpen, Settings, Globe, Search, MousePointerClick, Brain } from 'lucide-react'
import { Workspace, type WCStatus } from './webcontainer'
import { SettingsModal } from './SettingsModal'
import { Markdown } from './Markdown'
import { ColResizer } from './Resizer'
import { runAgent } from './agent'
import { generateImageBytes } from './gateway'
import { CodeView } from './CodeView'
import { resolveBuilderModel } from './model'
import { getProvider } from '../provider'
import { takePending } from '../pending'
import { getFramework } from './frameworks'
import { STARTER_FILES, ensureBridge } from './template'
import { downloadZip } from './zip'
import {
  type Project, type Message, type StoredAction, type MessagePart, type ProjectSettings, type Checkpoint,
  createProject, getProject, listProjects, saveFiles, saveAssets, saveDeploy, addMessage, getMessages, deleteMessages, renameProject, deleteProject, saveProjectSettings, saveLeaf, setMessageParent,
} from './db'

const LAST_KEY = 'fag-builder-last'
const CHATW_KEY = 'fag-builder-chatw'
const DEFAULT_NAME = 'Untitled app'

const PROMPT_IDEAS = [
  'Build a landing page for a SaaS product — hero, features, pricing, and footer.',
  'Make a pomodoro timer with a circular progress ring and a task list.',
  'Create a kanban board with draggable cards across columns.',
  'Design a personal portfolio with a projects grid and a contact form.',
  'Build a weather dashboard with a search box and animated cards.',
]

// True for names the user never set themselves (so we can auto-name from the
// first prompt without clobbering a name they chose).
function isDefaultName(name: string): boolean {
  return name === DEFAULT_NAME || name === 'My app' || /^Untitled app( \d+)?$/.test(name)
}

// A unique default name so brand-new (not-yet-prompted) apps don't all collide.
function uniqueDefaultName(existing: Project[]): string {
  const names = new Set(existing.map((p) => p.name))
  if (!names.has(DEFAULT_NAME)) return DEFAULT_NAME
  let n = 2
  while (names.has(`${DEFAULT_NAME} ${n}`)) n++
  return `${DEFAULT_NAME} ${n}`
}

// Derive a readable app title from the user's first prompt (Lovable-style).
function titleFromPrompt(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ')
  if (!t) return DEFAULT_NAME
  const short = t.length > 48 ? t.slice(0, 48).trimEnd() + '…' : t
  return short.charAt(0).toUpperCase() + short.slice(1)
}

function timeAgo(t: number): string {
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24); return `${d}d ago`
}

// ── Conversation tree helpers ────────────────────────────────────────────────
// Messages form a tree via parentId; the "active path" is the chain from a root
// down to the current leaf. Editing a user message adds a sibling = a new branch.
const byId = (all: Message[]) => { const m = new Map<number, Message>(); for (const x of all) if (x.id != null) m.set(x.id, x); return m }
const newestId = (all: Message[]): number | null => { let best: Message | null = null; for (const x of all) if (x.id != null && (!best || x.createdAt > best.createdAt)) best = x; return best?.id ?? null }
const childrenOf = (all: Message[], id: number | null) => all.filter((x) => (x.parentId ?? null) === id).sort((a, b) => a.createdAt - b.createdAt)
const siblingsOf = (all: Message[], m: Message) => childrenOf(all, m.parentId ?? null).filter((x) => x.role === m.role)

function pathTo(all: Message[], leaf: number | null): Message[] {
  if (!all.length) return []
  const map = byId(all)
  let id: number | null = leaf != null && map.has(leaf) ? leaf : newestId(all)
  const path: Message[] = []; const seen = new Set<number>()
  while (id != null && map.has(id) && !seen.has(id)) { seen.add(id); const m = map.get(id)!; path.push(m); id = m.parentId ?? null }
  return path.reverse()
}
function deepestLeaf(all: Message[], id: number): number {
  let cur = id
  for (;;) { const kids = childrenOf(all, cur); if (!kids.length) return cur; cur = kids[kids.length - 1].id! }
}
function subtreeIds(all: Message[], id: number): number[] {
  const out: number[] = []; const stack = [id]
  while (stack.length) { const cur = stack.pop()!; out.push(cur); for (const k of childrenOf(all, cur)) if (k.id != null) stack.push(k.id) }
  return out
}
// Back-fill parentId on legacy linear chats (pre-branching) so they join the tree.
async function ensureParentLinks(all: Message[]): Promise<Message[]> {
  const sorted = [...all].sort((a, b) => a.createdAt - b.createdAt)
  let prev: number | null = null
  for (const m of sorted) {
    if (m.parentId === undefined) { m.parentId = prev; if (m.id != null) await setMessageParent(m.id, prev) }
    prev = m.id ?? prev
  }
  return sorted
}

export function Builder({ onEditProvider, onHome }: { onEditProvider?: () => void; onHome?: () => void } = {}) {
  const [project, setProject] = useState<Project | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [messages, setMessages] = useState<Message[]>([]) // active branch path (rendered)
  const [allMessages, setAllMessages] = useState<Message[]>([]) // full conversation tree
  const [leafId, setLeafId] = useState<number | null>(null) // active branch tip
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
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
  const [showProjects, setShowProjects] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showIdeas, setShowIdeas] = useState(false)
  const [chatWidth, setChatWidth] = useState(() => {
    const v = Number(localStorage.getItem(CHATW_KEY) || '')
    return v >= 300 && v <= 760 ? v : 380
  })

  const ws = useRef<Workspace | null>(null)
  const filesRef = useRef<Record<string, string>>({})
  const assetsRef = useRef<Record<string, Uint8Array>>({})
  const [files, setFiles] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<string | null>(null) // editable buffer for the selected file
  const sub = useRef<Subscription | null>(null)
  // Finalizer for the in-flight turn: persists the partial assistant message so
  // Stop (or normal completion) keeps whatever streamed so far. Idempotent.
  const finalizeRef = useRef<null | (() => Promise<void>)>(null)
  const logRef = useRef('')
  const consoleRef = useRef<string[]>([])           // app console output + runtime errors
  const previewIframeRef = useRef<HTMLIFrameElement>(null)
  const pendingReqs = useRef<Map<string, (v: any) => void>>(new Map())
  const chatEnd = useRef<HTMLDivElement>(null)
  const booted = useRef(false)
  const autoSent = useRef(false)

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

  // Run a DOM-control command inside the preview (click/fill/scroll/inspect/
  // press_key/evaluate) and get its result back over the same RPC channel.
  function previewCmd(cmd: string, args: any, timeout = 10000): Promise<{ result?: any; error?: string }> {
    return new Promise((resolve) => {
      const win = previewIframeRef.current?.contentWindow
      if (!win) return resolve({ error: 'preview not running' })
      const id = Math.random().toString(36).slice(2)
      const timer = setTimeout(() => { pendingReqs.current.delete(id); resolve({ error: 'timed out' }) }, timeout)
      pendingReqs.current.set(id, (v) => { clearTimeout(timer); resolve({ result: v.result, error: v.error }) })
      win.postMessage({ __fagReq: 'cmd', id, cmd, args }, '*')
    })
  }

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, running])
  useEffect(() => { localStorage.setItem(CHATW_KEY, String(chatWidth)) }, [chatWidth])

  // Auto-run the prompt the user typed on the Home screen — handed off via the
  // pending store (not the URL/props), so it survives a reload. Consumed once,
  // when the sandbox is ready and the brand-new project has no messages yet.
  useEffect(() => {
    if (autoSent.current) return
    if (status !== 'ready' || !project || running || messages.length !== 0) return
    autoSent.current = true
    const p = takePending(project.id)
    if (p?.prompt) send(p.prompt)
  }, [status, project, running, messages.length])

  // Preview→builder channel: errors, console output, and replies to our DOM /
  // screenshot requests. Its OWN effect (not behind the boot guard) so React
  // StrictMode's mount→unmount→remount in dev re-attaches it correctly.
  useEffect(() => {
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
      } else if (d.__fagReset) {
        // Preview (re)loaded — drop stale logs so the buffer is fresh.
        consoleRef.current = []
        setErrors('')
      } else if (d.__fagRes && d.id) {
        const resolve = pendingReqs.current.get(d.id)
        if (resolve) { resolve(d); pendingReqs.current.delete(d.id) }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    resolveBuilderModel().then(setModel)

    ;(async () => {
      if (!self.crossOriginIsolated) { setFatal('Starting the in-browser runtime… If this persists, refresh the page — the service worker that enables it needs one reload (and a Chromium-based browser).'); return }
      const all = await listProjects()
      setProjects(all)
      const lastId = localStorage.getItem(LAST_KEY)
      let proj = (lastId && (await getProject(lastId))) || all[0] || null
      if (!proj) proj = await createProject(uniqueDefaultName(all), { ...STARTER_FILES })
      localStorage.setItem(LAST_KEY, proj.id)
      // Older projects predate the preview bridge — inject it so read_dom /
      // screenshot work (otherwise they hang/time out).
      const patchedHtml = ensureBridge(proj.files['index.html'] || '')
      if (patchedHtml && patchedHtml !== proj.files['index.html']) {
        proj.files = { ...proj.files, 'index.html': patchedHtml }
        await saveFiles(proj.id, proj.files)
      }
      setProject(proj)
      filesRef.current = proj.files
      assetsRef.current = proj.assets ?? {}
      setFiles(proj.files)
      const msgs = await ensureParentLinks(await getMessages(proj.id))
      const leaf = proj.leafId ?? newestId(msgs)
      setAllMessages(msgs)
      setLeafId(leaf)
      setMessages(pathTo(msgs, leaf))
      await boot(proj.files, assetsRef.current)
    })().catch((e) => setFatal(e?.message ?? String(e)))

    return () => { sub.current?.unsubscribe() }
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
    // Snapshot the project as it is now (before the agent runs) so this user
    // message becomes a restorable checkpoint. New prompts extend the active leaf.
    const checkpoint = { files: { ...filesRef.current }, assets: { ...assetsRef.current } }
    await runTurn(prompt, leafId, checkpoint)
  }

  // Run one user→assistant turn under `parentId`, creating a new branch when
  // parentId points at an existing user message's parent (i.e. an edit/resend).
  async function runTurn(prompt: string, parentId: number | null, checkpoint: Checkpoint) {
    if (!project) return
    setRunning(true)
    setWriting('')

    const firstEver = allMessages.every((m) => m.role !== 'user')
    const priorPath = parentId == null ? [] : pathTo(allMessages, parentId)
    const userId = await addMessage({ projectId: project.id, role: 'user', content: prompt, checkpoint, parentId })
    const userMsg: Message = { id: userId, projectId: project.id, role: 'user', content: prompt, checkpoint, parentId, createdAt: Date.now() }
    const nextAll = [...allMessages, userMsg]
    setAllMessages(nextAll)
    setLeafId(userId); await saveLeaf(project.id, userId)
    setMessages([...priorPath, userMsg, { projectId: project.id, role: 'assistant', content: '', actions: [], parts: [], parentId: userId, createdAt: Date.now() }])

    // Auto-name the app from its first prompt (unless the user named it already).
    if (firstEver && isDefaultName(project.name)) {
      const name = titleFromPrompt(prompt)
      await renameProject(project.id, name)
      setProject((p) => (p ? { ...p, name } : p))
      setProjects((ps) => ps.map((p) => (p.id === project.id ? { ...p, name } : p)))
    }

    const history = priorPath.slice(-8).map((m) => ({ role: m.role, content: m.content }))
    const recentErrors = errors
    setErrors('')
    // A code change invalidates prior runtime logs/errors — drop them so a later
    // get_console_logs reflects only output produced since this edit (Fast Refresh
    // swaps don't fire a full reload, so the bridge's reset signal won't cover it).
    const clearConsole = () => { consoleRef.current = []; setErrors('') }
    let content = ''
    const acts: StoredAction[] = []
    // Ordered timeline of text + actions so pills render inline where they happened.
    const parts: MessagePart[] = []
    const pushText = (t: string) => {
      const last = parts[parts.length - 1]
      if (last && last.type === 'text') last.text += t
      else parts.push({ type: 'text', text: t })
    }

    // Persist whatever has streamed so far (called on normal completion AND on
    // Stop). Idempotent via finalizeRef being cleared after the first run.
    let finalized = false
    const finalize = async () => {
      if (finalized) return
      finalized = true
      finalizeRef.current = null
      setWriting('')
      let asstId: number | undefined
      if (content.trim() || acts.length) asstId = await addMessage({ projectId: project.id, role: 'assistant', content, actions: acts, parts, parentId: userId })
      await saveFiles(project.id, filesRef.current)
      // Reload from DB so messages carry their ids + checkpoints (enables the
      // copy / delete / restore / branch actions).
      const all = await getMessages(project.id)
      const leaf = asstId ?? userId
      setAllMessages(all)
      setLeafId(leaf); await saveLeaf(project.id, leaf)
      setMessages(pathTo(all, leaf))
      setRunning(false)
    }
    finalizeRef.current = finalize

    sub.current = runAgent({
      history,
      files: filesRef.current,
      userPrompt: prompt,
      recentErrors,
      model,
      fallbackModel: getProvider()?.fallbackModel?.trim() || null,
      frameworkHint: getFramework(project.framework).hint,
      exec: {
        writeFile: async (path, c) => {
          // Self-heal: if the agent rewrites an .html entry and drops the preview
          // bridge, re-inject it so inspect/click/fill/evaluate/console keep working.
          const c2 = /\.html$/i.test(path) ? ensureBridge(c) : c
          filesRef.current = { ...filesRef.current, [path]: c2 }
          setFiles(filesRef.current)
          await ws.current?.writeFile(path, c2)
          clearConsole()
        },
        editFile: async (path, find, replace, replaceAll) => {
          const cur = filesRef.current[path] ?? (await ws.current?.readFile(path)) ?? null
          if (cur == null) return { ok: false, count: 0, message: `not found: ${path}` }
          if (!cur.includes(find)) return { ok: false, count: 0, message: `text not found in ${path}` }
          const count = replaceAll ? cur.split(find).length - 1 : 1
          let next = replaceAll ? cur.split(find).join(replace) : cur.replace(find, replace)
          if (/\.html$/i.test(path)) next = ensureBridge(next) // re-inject the bridge if an edit removed it
          filesRef.current = { ...filesRef.current, [path]: next }
          setFiles(filesRef.current)
          await ws.current?.writeFile(path, next)
          clearConsole()
          return { ok: true, count }
        },
        readFile: async (path) => filesRef.current[path] ?? (await ws.current?.readFile(path)) ?? null,
        listFiles: () => Object.keys(filesRef.current),
        deleteFile: async (path) => {
          const f = { ...filesRef.current }; delete f[path]; filesRef.current = f; setFiles(f)
          await ws.current?.deleteFile(path)
          clearConsole()
        },
        generateImage: async (p, path, aspect) => {
          const bytes = await generateImageBytes(p, aspect)
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
        preview: async (cmd, args) => previewCmd(cmd, args),
        webSearch: async (query) => {
          try {
            const res = await fetch('https://r.jina.ai/https://html.duckduckgo.com/html?q=' + encodeURIComponent(query), { headers: { Accept: 'text/plain' } })
            if (!res.ok) return `search failed: HTTP ${res.status}`
            return (await res.text()).trim() || '(no results)'
          } catch (e: any) { return `search failed: ${e?.message ?? e}` }
        },
        webFetch: async (url) => {
          try {
            const u = /^https?:\/\//i.test(url) ? url : 'https://' + url
            const res = await fetch('https://r.jina.ai/' + u, { headers: { Accept: 'text/plain' } })
            if (!res.ok) return `fetch failed: HTTP ${res.status}`
            return (await res.text()).trim() || '(empty)'
          } catch (e: any) { return `fetch failed: ${e?.message ?? e}` }
        },
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
      complete: () => { void finalize() },
    })
  }

  // Stop mid-stream: tear down the agent run, but first persist whatever has
  // already streamed (unsubscribe aborts the stream so `complete` never fires).
  function stop() {
    sub.current?.unsubscribe()
    void finalizeRef.current?.()
  }

  // File operations backing the explorer/editor context menus. Each mutates the
  // in-memory maps, the running sandbox, and the persisted project together.
  const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
  const parentOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i) }
  const matchingUnder = (path: string, keys: string[]) => keys.filter((k) => k === path || k.startsWith(path + '/'))

  async function fsWriteFile(path: string, contents: string) {
    if (!project) return
    filesRef.current = { ...filesRef.current, [path]: contents }
    setFiles(filesRef.current)
    await ws.current?.writeFile(path, contents).catch(() => {})
    await saveFiles(project.id, filesRef.current)
  }

  async function fsNewFile(dir: string) {
    const name = prompt(`New file name${dir ? ` in ${dir}/` : ''}:`)?.trim()
    if (!name) return
    const path = joinPath(dir, name)
    if (filesRef.current[path] != null || assetsRef.current[path]) { alert(`${path} already exists`); return }
    await fsWriteFile(path, '')
    setSelected(path); setDraft(null); setTab('code')
  }

  async function fsNewFolder(dir: string) {
    const name = prompt('New folder name:')?.trim()
    if (!name) return
    await fsWriteFile(joinPath(joinPath(dir, name), '.gitkeep'), '')
  }

  async function fsRename(path: string) {
    if (!project) return
    const next = prompt('Rename / move to:', path)?.trim()
    if (!next || next === path) return
    const map = (p: string) => next + p.slice(path.length)
    const nf = { ...filesRef.current }
    for (const p of matchingUnder(path, Object.keys(filesRef.current))) {
      const np = map(p); nf[np] = nf[p]; delete nf[p]
      await ws.current?.deleteFile(p).catch(() => {}); await ws.current?.writeFile(np, filesRef.current[p]).catch(() => {})
    }
    const na = { ...assetsRef.current }
    for (const p of matchingUnder(path, Object.keys(assetsRef.current))) {
      const np = map(p); na[np] = na[p]; delete na[p]
      await ws.current?.deleteFile(p).catch(() => {}); await ws.current?.writeBinary(np, assetsRef.current[p]).catch(() => {})
    }
    filesRef.current = nf; assetsRef.current = na; setFiles(nf)
    await saveFiles(project.id, nf); await saveAssets(project.id, na)
    if (selected === path || selected.startsWith(path + '/')) setSelected(map(selected))
  }

  async function fsRemove(path: string) {
    if (!project) return
    if (!confirm(`Delete ${path}? This cannot be undone.`)) return
    const nf = { ...filesRef.current }; const na = { ...assetsRef.current }
    for (const p of matchingUnder(path, Object.keys(filesRef.current))) { delete nf[p]; await ws.current?.deleteFile(p).catch(() => {}) }
    for (const p of matchingUnder(path, Object.keys(assetsRef.current))) { delete na[p]; await ws.current?.deleteFile(p).catch(() => {}) }
    filesRef.current = nf; assetsRef.current = na; setFiles(nf)
    await saveFiles(project.id, nf); await saveAssets(project.id, na)
    if (selected === path || selected.startsWith(path + '/')) { setSelected(Object.keys(nf)[0] ?? ''); setDraft(null) }
  }

  async function fsDuplicate(path: string) {
    if (!project) return
    const isFile = path in filesRef.current
    const isAsset = path in assetsRef.current
    if (!isFile && !isAsset) return
    const dir = parentOf(path); const base = isFile || isAsset ? path.slice(dir ? dir.length + 1 : 0) : path
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''
    let n = 1, cand = ''
    do { cand = joinPath(dir, `${stem}-copy${n > 1 ? n : ''}${ext}`); n++ } while (filesRef.current[cand] != null || assetsRef.current[cand])
    if (isFile) { await fsWriteFile(cand, filesRef.current[path]); setSelected(cand) }
    else {
      assetsRef.current = { ...assetsRef.current, [cand]: assetsRef.current[path] }
      await ws.current?.writeBinary(cand, assetsRef.current[path]).catch(() => {})
      await saveAssets(project.id, assetsRef.current)
    }
  }

  const fsOps = {
    newFile: fsNewFile, newFolder: fsNewFolder, rename: fsRename, remove: fsRemove, duplicate: fsDuplicate,
    copyPath: (p: string) => { navigator.clipboard.writeText(p).catch(() => {}) },
  }

  async function copyMessage(text: string, i: number) {
    try { await navigator.clipboard.writeText(text) } catch { /* ignore */ }
    setCopiedIdx(i); setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1400)
  }

  // Delete a message and its whole subtree (all branches below it).
  async function deleteMsg(m: Message) {
    if (m.id == null || !project) return
    const ids = subtreeIds(allMessages, m.id)
    await deleteMessages(ids)
    const remaining = allMessages.filter((x) => x.id == null || !ids.includes(x.id))
    const leaf = m.parentId != null && remaining.some((x) => x.id === m.parentId) ? m.parentId : newestId(remaining)
    setAllMessages(remaining)
    setLeafId(leaf); await saveLeaf(project.id, leaf)
    setMessages(pathTo(remaining, leaf))
  }

  // Restore the running sandbox + persisted files to a checkpoint.
  async function applyCheckpoint(cp: Checkpoint) {
    const keep = new Set([...Object.keys(cp.files), ...Object.keys(cp.assets ?? {})])
    for (const p of [...Object.keys(filesRef.current), ...Object.keys(assetsRef.current)]) {
      if (!keep.has(p)) await ws.current?.deleteFile(p).catch(() => {})
    }
    filesRef.current = { ...cp.files }
    assetsRef.current = { ...(cp.assets ?? {}) }
    setFiles(filesRef.current)
    for (const [p, c] of Object.entries(cp.files)) await ws.current?.writeFile(p, c).catch(() => {})
    for (const [p, b] of Object.entries(cp.assets ?? {})) await ws.current?.writeBinary(p, b).catch(() => {})
    if (project) { await saveFiles(project.id, filesRef.current); await saveAssets(project.id, assetsRef.current) }
  }

  // Roll the codebase back to a user message's checkpoint; the conversation
  // view ends at that message (continuing from here naturally branches).
  async function restoreCheckpoint(m: Message) {
    if (!project || !m.checkpoint || running || m.id == null) return
    if (!confirm('Restore the code to this point? The conversation will continue from here.')) return
    await applyCheckpoint(m.checkpoint)
    setLeafId(m.id); await saveLeaf(project.id, m.id)
    setMessages(pathTo(allMessages, m.id))
    setErrors('')
  }

  // Edit a user message → re-run it as a NEW branch (sibling), from the same
  // starting code state the original ran from.
  function startEdit(m: Message) { if (m.id != null) { setEditingId(m.id); setEditText(m.content) } }
  function cancelEdit() { setEditingId(null); setEditText('') }
  async function saveEdit(m: Message) {
    const text = editText.trim()
    if (!text || !project) { setEditingId(null); return }
    if (running || status !== 'ready') return // the Save button is disabled in this state
    setEditingId(null)
    // Rebase the sandbox to the state this message originally ran from, then
    // re-run as a new sibling branch. (Same text is allowed — it regenerates.)
    if (m.checkpoint) { try { await applyCheckpoint(m.checkpoint) } catch { /* keep going */ } }
    const checkpoint = m.checkpoint ?? { files: { ...filesRef.current }, assets: { ...assetsRef.current } }
    await runTurn(text, m.parentId ?? null, checkpoint)
  }

  // Switch to the previous/next sibling branch of a user message.
  async function switchBranch(m: Message, dir: -1 | 1) {
    if (!project || running) return
    const sibs = siblingsOf(allMessages, m)
    const idx = sibs.findIndex((s) => s.id === m.id)
    const target = sibs[idx + dir]
    if (!target?.id) return
    const leaf = deepestLeaf(allMessages, target.id)
    setLeafId(leaf); await saveLeaf(project.id, leaf)
    setMessages(pathTo(allMessages, leaf))
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

  // Deploy. Static frameworks → build, auto-detect the output dir, hand off via
  // IndexedDB, and open the (non-isolated) /deploy page for Puter. Node/SSR
  // frameworks (Express, etc.) → export the source ZIP and point at Vercel/Netlify.
  async function deploy() {
    if (!project || running || status !== 'ready') return
    const fw = getFramework(project.framework)
    if (fw.deploy === 'node') {
      downloadZip(project.name, files, assetsRef.current)
      window.open('https://vercel.com/new', '_blank')
      setErrors((p) => (p + `\nThis is a ${fw.label} (server) app — Puter only hosts static sites. Downloaded ${project.name}.zip; push it to GitHub and import at Vercel or Netlify.`).slice(-3000))
      return
    }
    // Open the deploy tab NOW, synchronously within the click gesture, so it
    // isn't popup-blocked (a window.open after the long async build would be).
    // It loads /deploy.html (real file → works on static hosts like Puter), then
    // we hand it the build id once ready.
    const tab = window.open('/deploy.html?building=true', '_blank')
    try {
      setStatus('installing')
      const { files: dist } = await ws.current!.build(fw.buildDirs.length ? fw.buildDirs : undefined)
      const id = await saveDeploy(project.name, dist, project.id)
      setStatus('ready')
      // The user may have closed the tab mid-build; touching a closed tab's
      // location can throw, so re-open instead.
      if (tab && !tab.closed) tab.location.href = `/deploy.html?id=${id}`
      else window.open(`/deploy.html?id=${id}`, '_blank')
    } catch (e: any) {
      setStatus('ready')
      try { tab?.close() } catch { /* ignore */ }
      setErrors((p) => (p + '\nBuild failed: ' + (e?.message ?? e)).slice(-3000))
    }
  }

  async function newProject() {
    const p = await createProject(uniqueDefaultName(projects), { ...STARTER_FILES })
    localStorage.setItem(LAST_KEY, p.id)
    location.reload()
  }
  function openProject(id: string) {
    if (id === project?.id) { setShowProjects(false); return }
    localStorage.setItem(LAST_KEY, id)
    location.reload()
  }

  async function handleRename(id: string, name: string) {
    const clean = name.trim()
    if (!clean) return
    await renameProject(id, clean)
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, name: clean } : p)))
    if (project?.id === id) setProject((p) => (p ? { ...p, name: clean } : p))
  }

  async function handleSaveSettings(settings: ProjectSettings) {
    if (!project) return
    await saveProjectSettings(project.id, settings)
    setProject((p) => (p ? { ...p, settings } : p))
    setProjects((ps) => ps.map((p) => (p.id === project.id ? { ...p, settings } : p)))
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this app and its chat history? This cannot be undone.')) return
    await deleteProject(id)
    if (id === project?.id) {
      const next = projects.find((p) => p.id !== id)
      if (next) localStorage.setItem(LAST_KEY, next.id)
      else localStorage.removeItem(LAST_KEY)
      location.reload()
      return
    }
    setProjects((ps) => ps.filter((p) => p.id !== id))
  }

  const statusLabel: Record<WCStatus, string> = {
    idle: 'idle', booting: 'booting runtime…', installing: 'installing deps…',
    starting: 'starting dev server…', ready: 'live', error: 'error',
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <button onClick={onHome} className="flex items-center gap-2 text-sm font-semibold hover:opacity-80" title="Home">
          <Sparkles className="size-4 text-signal" /> AI Builder
        </button>
        <span className="text-muted-foreground/40">/</span>
        {project && <EditableName name={project.name} onRename={(n) => handleRename(project.id, n)} />}
        <button onClick={() => setShowProjects(true)} className="ml-1 flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2" title="All apps">
          <LayoutGrid className="size-3.5" /> Apps
        </button>
        <button onClick={newProject} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2" title="New app">
          <Plus className="size-3.5" /> New
        </button>
        <button onClick={() => project && setShowSettings(true)} disabled={!project} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50" title="App settings">
          <Settings className="size-3.5" /> Settings
        </button>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span className={`size-2 rounded-full ${status === 'ready' ? 'bg-signal' : status === 'error' ? 'bg-destructive' : 'bg-amber-400 animate-pulse'}`} />
          {statusLabel[status]}
        </span>
        <button onClick={onEditProvider} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2" title="Change provider / model">
          <Sparkles className="size-3.5 text-signal" /> <span className="font-mono text-[11px] text-muted-foreground">{model || 'provider'}</span>
        </button>
        <button onClick={() => project && downloadZip(project.name, files, assetsRef.current)} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2" title="Download project as ZIP">
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
          <div style={{ width: chatWidth }} className="flex flex-none flex-col border-r">
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
                const editing = isUser && editingId != null && editingId === m.id
                const sibs = isUser ? siblingsOf(allMessages, m) : []
                const sibIdx = sibs.findIndex((s) => s.id === m.id)
                return (
                  <div key={m.id ?? i} className={`group relative rounded-xl px-3 py-2 text-sm ${isUser ? 'ml-6 bg-signal-muted' : 'mr-2 border bg-surface-1'}`}>
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{m.role}</span>
                      {isUser && sibs.length > 1 && !editing && (
                        <span className="ml-auto flex items-center gap-0.5 font-mono text-[10px] text-muted-foreground">
                          <button disabled={running || sibIdx <= 0} onClick={() => switchBranch(m, -1)} className="rounded p-0.5 hover:bg-surface-2 hover:text-foreground disabled:opacity-30" title="Previous branch"><ChevronLeft className="size-3" /></button>
                          {sibIdx + 1}/{sibs.length}
                          <button disabled={running || sibIdx >= sibs.length - 1} onClick={() => switchBranch(m, 1)} className="rounded p-0.5 hover:bg-surface-2 hover:text-foreground disabled:opacity-30" title="Next branch"><ChevronRight className="size-3" /></button>
                        </span>
                      )}
                    </div>
                    {editing ? (
                      <div className="space-y-2">
                        <textarea
                          autoFocus
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(m) } else if (e.key === 'Escape') cancelEdit() }}
                          rows={3}
                          className="w-full resize-none rounded-lg border bg-background px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-signal/40"
                        />
                        <div className="flex items-center justify-end gap-2">
                          {status !== 'ready' && <span className="mr-auto text-[11px] text-muted-foreground">sandbox starting…</span>}
                          <button onClick={cancelEdit} className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:bg-surface-2">Cancel</button>
                          <button onClick={() => saveEdit(m)} disabled={running || status !== 'ready' || !editText.trim()} className="rounded-lg bg-signal px-2.5 py-1 text-xs font-semibold text-signal-foreground disabled:opacity-50">Save &amp; branch</button>
                        </div>
                      </div>
                    ) : isUser ? (
                      <UserText text={m.content} />
                    ) : m.parts ? (
                      // Inline timeline: text and tool pills in the exact order they happened.
                      <div className="flex min-w-0 flex-col gap-1.5">
                        {m.parts.map((part, k) => part.type === 'text'
                          ? <AssistantText key={k} text={part.text} />
                          : <ActionPill key={k} action={part.action} onOpen={openInCode} />)}
                        {showWriting && (
                          <span className="flex items-center gap-1.5 self-start rounded-md border border-signal/40 bg-signal-muted px-2 py-1 font-mono text-[11px] text-signal">
                            <Loader2 className="size-3 animate-spin" /> writing {writing}…
                          </span>
                        )}
                        {running && isLast && <span className="shimmer self-start font-mono text-[12px] font-medium">Working…</span>}
                      </div>
                    ) : (
                      // Legacy messages (pre-timeline): prose then grouped pills.
                      <>
                        <AssistantText text={m.content} />
                        {actions.length > 0 && (
                          <div className="mt-2 flex min-w-0 flex-col gap-1">
                            {actions.map((a, j) => <ActionPill key={j} action={a} onOpen={openInCode} />)}
                          </div>
                        )}
                      </>
                    )}
                    {showActionRow && !editing && (
                      <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <MsgIcon title={copiedIdx === i ? 'Copied' : 'Copy'} onClick={() => copyMessage(m.content, i)}>
                          {copiedIdx === i ? <Check className="size-3 text-signal" /> : <Copy className="size-3" />}
                        </MsgIcon>
                        {isUser && !running && (
                          <MsgIcon title="Edit (creates a new branch)" onClick={() => startEdit(m)}><Pencil className="size-3" /></MsgIcon>
                        )}
                        {isUser && m.checkpoint && (
                          <MsgIcon title="Restore code to here" onClick={() => restoreCheckpoint(m)}><RotateCcw className="size-3" /></MsgIcon>
                        )}
                        <MsgIcon title="Delete message" onClick={() => deleteMsg(m)}><Trash2 className="size-3" /></MsgIcon>
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

            <div className="p-3">
              <div className="relative">
                {showIdeas && (
                  <div className="absolute bottom-full left-0 z-10 mb-2 w-full overflow-hidden rounded-xl border bg-surface-1 shadow-lg">
                    <div className="px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Prompt ideas</div>
                    {PROMPT_IDEAS.map((p) => (
                      <button
                        key={p}
                        onClick={() => { setInput(p); setShowIdeas(false) }}
                        className="block w-full border-t px-3 py-2 text-left text-xs text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}
                <div className="rounded-2xl border bg-surface-1 transition focus-within:border-signal/50 focus-within:ring-2 focus-within:ring-signal/25">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
                    placeholder={status === 'ready' ? 'Write a message…' : 'Starting the sandbox…'}
                    rows={1}
                    disabled={status !== 'ready'}
                    className="max-h-[180px] min-h-[48px] w-full resize-none bg-transparent px-4 pt-3 text-sm placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
                  />
                  <div className="flex items-center gap-2 px-2.5 pb-2.5">
                    <button
                      onClick={() => setShowIdeas((s) => !s)}
                      title="Prompt ideas"
                      className={`grid size-8 place-items-center rounded-full border transition hover:bg-surface-2 ${showIdeas ? 'border-signal/50 text-signal' : 'text-muted-foreground'}`}
                    >
                      <Plus className="size-4" />
                    </button>
                    <div className="ml-auto flex items-center gap-1.5">
                      {running ? (
                        <button onClick={stop} title="Stop" className="grid size-8 place-items-center rounded-full bg-surface-2 text-foreground hover:opacity-90"><Square className="size-3.5" /></button>
                      ) : (
                        <button onClick={() => send(input)} disabled={!input.trim() || status !== 'ready'} title="Send" className="grid size-8 place-items-center rounded-full bg-signal text-signal-foreground transition hover:opacity-90 disabled:opacity-40">
                          <Send className="size-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <ColResizer onDelta={(dx) => setChatWidth((w) => Math.min(760, Math.max(300, w + dx)))} />

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
                    ? <iframe ref={previewIframeRef} title="preview" src={previewUrl} className="size-full border-0" />
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
                  fs={fsOps}
                  workspace={ws.current}
                  status={status}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {showProjects && (
        <ProjectsModal
          projects={projects}
          currentId={project?.id ?? null}
          onClose={() => setShowProjects(false)}
          onOpen={openProject}
          onNew={newProject}
          onRename={handleRename}
          onDelete={handleDelete}
        />
      )}

      {showSettings && project && (
        <SettingsModal
          project={project}
          onClose={() => setShowSettings(false)}
          onSave={handleSaveSettings}
          onRename={(n) => handleRename(project.id, n)}
          onDelete={() => { setShowSettings(false); handleDelete(project.id) }}
        />
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

// Split assistant text into normal prose and <think>…</think> reasoning blocks.
// An unterminated <think> (still streaming) is returned with streaming:true.
type Seg = { type: 'text' | 'think'; content: string; streaming?: boolean }
function parseThink(text: string): Seg[] {
  const segs: Seg[] = []
  let rest = text
  for (;;) {
    const open = rest.indexOf('<think>')
    if (open === -1) { if (rest) segs.push({ type: 'text', content: rest }); break }
    const before = rest.slice(0, open)
    if (before) segs.push({ type: 'text', content: before })
    const after = rest.slice(open + 7)
    const close = after.indexOf('</think>')
    if (close === -1) { segs.push({ type: 'think', content: after, streaming: true }); break }
    segs.push({ type: 'think', content: after.slice(0, close) })
    rest = after.slice(close + 8)
  }
  return segs
}

// Collapsible reasoning accordion. Auto-expanded while the model is still
// thinking (no closing tag yet), then collapses to a tidy "Reasoning" toggle.
function Reasoning({ content, streaming }: { content: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  const show = streaming || open
  return (
    <div className="self-start w-full min-w-0 overflow-hidden rounded-lg border bg-surface-1/60">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
        {streaming ? <Loader2 className="size-3.5 animate-spin" /> : <Brain className="size-3.5" />}
        {streaming ? 'Thinking…' : 'Reasoning'}
        <ChevronDown className={`ml-auto size-3 shrink-0 transition-transform ${show ? 'rotate-180' : ''}`} />
      </button>
      {show && (
        <div className="max-h-60 overflow-auto border-t px-2.5 py-2 text-[12px] text-muted-foreground">
          <Markdown>{cleanText(content)}</Markdown>
        </div>
      )}
    </div>
  )
}

// Render assistant text: <think> blocks become reasoning accordions, the rest
// renders as markdown.
function AssistantText({ text }: { text: string }) {
  if (!text) return null
  const segs = parseThink(text)
  const out = segs.map((s, i) => {
    if (s.type === 'think') {
      const c = cleanText(s.content)
      return c ? <Reasoning key={i} content={s.content} streaming={s.streaming} /> : null
    }
    const c = cleanText(s.content)
    return c ? <Markdown key={i}>{c}</Markdown> : null
  }).filter(Boolean)
  return out.length ? <>{out}</> : null
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

// Inline-editable app name. Click to edit; Enter commits, Escape cancels.
function EditableName({ name, onRename, big }: { name: string; onRename: (n: string) => void; big?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(name)
  useEffect(() => { setVal(name) }, [name])
  const size = big ? 'text-sm font-medium' : 'text-xs font-medium'
  if (editing) {
    const commit = () => { const t = val.trim(); if (t && t !== name) onRename(t); setEditing(false) }
    return (
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { setVal(name); setEditing(false) }
        }}
        className={`rounded-md border bg-background px-2 py-1 ${size} focus:outline-none focus:ring-2 focus:ring-signal/40`}
      />
    )
  }
  return (
    <button onClick={() => setEditing(true)} className={`group/name flex items-center gap-1 rounded-md px-1.5 py-1 ${size} hover:bg-surface-2`} title="Rename app">
      <span className="max-w-[200px] truncate">{name}</span>
      <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/name:opacity-100" />
    </button>
  )
}

// "Apps" / sessions panel: every app with its details, plus rename / open /
// delete. Reads file counts straight off each stored project.
function ProjectsModal({ projects, currentId, onClose, onOpen, onNew, onRename, onDelete }: {
  projects: Project[]
  currentId: string | null
  onClose: () => void
  onOpen: (id: string) => void
  onNew: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6 pt-[8vh]" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <LayoutGrid className="size-4 text-signal" />
            <h2 className="font-display text-base font-semibold">Your apps</h2>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{projects.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onNew} className="flex items-center gap-1 rounded-lg bg-signal px-2.5 py-1 text-xs font-semibold text-signal-foreground"><Plus className="size-3.5" /> New app</button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-surface-2 hover:text-foreground"><X className="size-4" /></button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {sorted.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No apps yet.</div>}
          <div className="flex flex-col gap-1.5">
            {sorted.map((p) => {
              const fileCount = Object.keys(p.files).filter((f) => !f.startsWith('node_modules') && f !== 'package-lock.json').length
              const assetCount = Object.keys(p.assets ?? {}).length
              const isCurrent = p.id === currentId
              return (
                <div key={p.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${isCurrent ? 'border-signal/50 bg-signal-muted' : 'bg-surface-1 hover:bg-surface-2'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <EditableName name={p.name} onRename={(n) => onRename(p.id, n)} big />
                      {isCurrent && <span className="rounded-full bg-signal/20 px-1.5 py-0.5 font-mono text-[10px] text-signal">open</span>}
                    </div>
                    <div className="mt-0.5 px-1.5 font-mono text-[11px] text-muted-foreground">
                      {fileCount} file{fileCount === 1 ? '' : 's'}{assetCount ? ` · ${assetCount} asset${assetCount === 1 ? '' : 's'}` : ''} · edited {timeAgo(p.updatedAt)}
                    </div>
                  </div>
                  {!isCurrent && (
                    <button onClick={() => onOpen(p.id)} className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs hover:bg-background" title="Open app">
                      <FolderOpen className="size-3.5" /> Open
                    </button>
                  )}
                  <button onClick={() => onDelete(p.id)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive" title="Delete app">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
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
    : action.kind === 'search' ? Search
    : action.kind === 'fetch' ? Globe
    : action.kind === 'interact' ? MousePointerClick
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

  // Anything with captured output/image → collapsible (terminal, console, dom,
  // read, screenshot).
  if (action.output || action.image) {
    return (
      <div className="min-w-0 max-w-full">
        <button onClick={() => setOpen((o) => !o)} className={`${base} w-fit max-w-full text-muted-foreground hover:text-foreground`} title={action.label}>
          <Icon className={`size-3 shrink-0 ${action.kind === 'command' ? 'text-signal' : ''}`} />
          <span className="truncate">{label}</span>
          <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (action.image
          ? <img src={action.image} alt="screenshot" className="mt-1 max-h-60 max-w-full rounded-md border" />
          // Stay inside the bubble: full bubble width, wrap long lines, and add
          // both scrollbars (vertical via max-h, horizontal for unbreakable text).
          : <pre className="mt-1 max-h-60 w-full max-w-full overflow-auto overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-surface-1 p-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">{action.output}</pre>)}
      </div>
    )
  }

  // Plain informational pill (list, design, screenshot, …).
  return <span className={`${base} text-muted-foreground/60`} title={action.label}><Icon className="size-3 shrink-0" /><span>{label}</span></span>
}
