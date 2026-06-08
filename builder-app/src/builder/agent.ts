import { Observable } from 'rxjs'
import { streamChat, type ChatMsg, type ToolDef, type ToolCall } from './gateway'
import { SYSTEM_PROMPT, buildContextMessage, FRONTEND_DESIGN_GUIDE } from './prompts'
import { getProvider } from '../provider'

// The builder agent is a pure function-calling agent: it reads/writes files,
// generates images, and runs commands via real tools, executed client-side
// against the WebContainer. No tag parsing.

export const BUILDER_TOOLS: ToolDef[] = [
  { type: 'function', function: { name: 'frontend_design', description: 'Get expert frontend-design guidance AND this project\'s design system. ALWAYS call this first before designing or restyling any app, page, or component.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file with the full contents. Use for new files or full rewrites. For small targeted changes, prefer edit_file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'project-relative path, e.g. src/App.jsx' }, contents: { type: 'string', description: 'the full file contents' } }, required: ['path', 'contents'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Make a precise edit by replacing an EXACT text snippet in a file — cheaper and safer than rewriting the whole file. The `find` text must match exactly (including whitespace/indentation). By default replaces the first occurrence; set replace_all to replace every occurrence. Fails if `find` is not present.', parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string', description: 'exact text to find' }, replace: { type: 'string', description: 'replacement text' }, replace_all: { type: 'boolean', description: 'replace all occurrences (default false = first only)' } }, required: ['path', 'find', 'replace'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file to inspect its current contents before editing.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List all files in the project.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'delete_file', description: 'Delete a file from the project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'generate_image', description: 'Generate an image asset from a text prompt and save it (use public/ paths, reference as /name in code).', parameters: { type: 'object', properties: { prompt: { type: 'string' }, path: { type: 'string', description: 'e.g. public/hero.png' } }, required: ['prompt', 'path'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a shell command (e.g. "npm install recharts"). Prefer the dev server\'s live errors over full rebuilds; only run "npm run build" when you specifically need a production build check.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'get_console_logs', description: 'Get the recent console output and runtime errors from the running app — use this to debug behavior.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_dom', description: 'Get the current rendered HTML of the running app so you can see what is actually on the page (great for debugging UI/layout).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'screenshot', description: 'Capture a screenshot of the running app to visually inspect the UI.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web for current information — docs, libraries, examples, APIs, news. Returns result titles, snippets, and links.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'the search query' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch a URL and return its readable content as text/markdown. Use to read a documentation page or a result found via web_search.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'the full URL to fetch' } }, required: ['url'] } } },
  // Live DOM control of the running preview (same-origin bridge): drive the app
  // like a user to verify behavior, not just read it.
  { type: 'function', function: { name: 'snapshot', description: 'Get a Playwright-style accessibility snapshot of the running app: a tree of roles + names with stable [ref=eN] handles. Call this FIRST to see what is on the page, then pass a ref to click/fill/inspect_page/press_key/scroll instead of guessing CSS selectors.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'inspect_page', description: 'Inspect the running app. With a ref (from snapshot) or CSS selector: returns that element\'s tag, text, bounding rect, computed styles (color, font, spacing, etc.) and attributes — ground truth for debugging styling/layout. With neither: returns the page url, title, and visible text.', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'element ref from snapshot, e.g. e5' }, selector: { type: 'string', description: 'CSS selector (alternative to ref)' } } } } },
  { type: 'function', function: { name: 'click', description: 'Click an element in the running app (realistic pointer+mouse sequence, React-safe). Target it by ref (from snapshot) or CSS selector.', parameters: { type: 'object', properties: { ref: { type: 'string' }, selector: { type: 'string' } } } } },
  { type: 'function', function: { name: 'fill', description: 'Set the value of an input/textarea in the running app (native setter so React onChange fires). Target by ref (from snapshot) or CSS selector.', parameters: { type: 'object', properties: { ref: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } }, required: ['value'] } } },
  { type: 'function', function: { name: 'press_key', description: 'Dispatch a keyboard key (e.g. "Enter", "Escape", "Tab") to an element (by ref or selector; or the focused element if neither). Optional modifiers.', parameters: { type: 'object', properties: { key: { type: 'string' }, ref: { type: 'string' }, selector: { type: 'string' }, modifiers: { type: 'object', description: 'e.g. { ctrl: true, shift: true }' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'scroll', description: 'Scroll the page or a scrollable element (by ref or selector). `to` is "top", "bottom", or a pixel offset.', parameters: { type: 'object', properties: { to: { type: 'string', description: '"top" | "bottom" | pixel number' }, ref: { type: 'string' }, selector: { type: 'string' } }, required: ['to'] } } },
  { type: 'function', function: { name: 'evaluate', description: 'Run arbitrary JavaScript inside the running app and return the (JSON-serializable) result. Use for anything not covered by the other tools — submit a form (document.querySelector(\'form\').requestSubmit()), check state, drive inner scrollbars, etc.', parameters: { type: 'object', properties: { code: { type: 'string', description: 'a JS expression or statements; its value is returned' } }, required: ['code'] } } },
]

export type ActionKind = 'file' | 'image' | 'command' | 'delete' | 'read' | 'list' | 'console' | 'dom' | 'screenshot' | 'design' | 'search' | 'fetch' | 'interact'
export interface AgentAction { kind: ActionKind; label: string; path?: string; output?: string; image?: string }

export type AgentEvent =
  | { type: 'status'; status: string }
  | { type: 'delta'; delta: string }
  | { type: 'writing'; path: string }
  | { type: 'action'; action: AgentAction }
  | { type: 'fileWritten'; path: string; contents: string }
  | { type: 'done'; model: string }
  | { type: 'error'; message: string }

export interface Executors {
  writeFile: (path: string, contents: string) => Promise<void>
  editFile: (path: string, find: string, replace: string, replaceAll: boolean) => Promise<{ ok: boolean; count: number; message?: string }>
  readFile: (path: string) => Promise<string | null>
  listFiles: () => string[]
  deleteFile: (path: string) => Promise<void>
  generateImage: (prompt: string, path: string) => Promise<void>
  runCommand: (command: string) => Promise<{ output: string; exitCode: number }>
  getConsoleLogs: () => Promise<string>
  readDom: () => Promise<string>
  screenshot: () => Promise<{ dataUrl?: string; error?: string }>
  webSearch: (query: string) => Promise<string>
  webFetch: (url: string) => Promise<string>
  preview: (cmd: string, args: any) => Promise<{ result?: any; error?: string }>
}

export interface AgentRun {
  history: ChatMsg[]
  files: Record<string, string>
  userPrompt: string
  recentErrors?: string
  model: string
  fallbackModel: string | null
  exec: Executors
}

// Safety ceiling only — high enough to never cut off a real build. The agent
// normally finishes on its own (a turn with no tool calls); the Stop button
// gives manual control. Bumped from 8, which truncated larger apps.
const MAX_STEPS = 60
const norm = (p: string) => p.trim().replace(/^\.?\//, '')

// Image (screenshot) turns go to the configured vision model when set, else the
// primary model — not every provider/model accepts images, so this is opt-in.
const visionModel = (fallback: string) => getProvider()?.visionModel?.trim() || fallback
const convoHasImage = (msgs: ChatMsg[]) =>
  msgs.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))

// Format an interaction result (click/fill/press_key/scroll) into text the model
// can act on: the confirmation + scroll position + the FRESH page snapshot (with
// refs) so it sees the effect and can continue interacting by ref.
function fmtState(r: { result?: any; error?: string }): string {
  if (r.error) return `error: ${r.error}`
  const o = r.result || {}
  let s = `ok: ${o.ok ?? ''}`
  if (o.scroll) s += `\nscroll: y=${o.scroll.y}/${o.scroll.height} viewport=${o.scroll.viewport}${o.scroll.atBottom ? ' [at bottom]' : ''}${o.scroll.atTop ? ' [at top]' : ''}`
  if (o.snapshot) s += `\n\nPage now (target elements by these refs):\n${o.snapshot}`
  return s
}

export function runAgent(run: AgentRun): Observable<AgentEvent> {
  return new Observable<AgentEvent>((sub) => {
    const ctrl = new AbortController()
    const convo: ChatMsg[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildContextMessage({ files: run.files, recentErrors: run.recentErrors }) },
      ...run.history,
      { role: 'user', content: run.userPrompt },
    ]

    // Only advertise generate_image when an image model is configured.
    const tools = getProvider()?.imageModel?.trim()
      ? BUILDER_TOOLS
      : BUILDER_TOOLS.filter((t) => t.function.name !== 'generate_image')

    ;(async () => {
      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          if (ctrl.signal.aborted) { sub.complete(); return }
          sub.next({ type: 'status', status: step === 0 ? 'thinking' : 'working' })

          let lastWriting = ''
          // Route image-bearing turns to the configured vision model; plain turns
          // stay on the primary model.
          const turnModel = convoHasImage(convo) ? visionModel(run.model) : run.model
          const { text, toolCalls, model } = await streamChat(convo, {
            model: turnModel,
            fallbackModel: run.fallbackModel,
            tools,
            signal: ctrl.signal,
            onToken: (delta) => sub.next({ type: 'delta', delta }),
            onTool: (calls) => {
              // Live "writing …" pill: peek the path out of the still-streaming args.
              for (const c of calls) {
                if (c.function.name === 'write_file' || c.function.name === 'generate_image') {
                  const m = /"path"\s*:\s*"([^"]+)"/.exec(c.function.arguments)
                  if (m && norm(m[1]) !== lastWriting) { lastWriting = norm(m[1]); sub.next({ type: 'writing', path: lastWriting }) }
                }
              }
            },
          })

          if (toolCalls.length === 0) { sub.next({ type: 'done', model }); sub.complete(); return }

          convo.push({ role: 'assistant', content: text, tool_calls: toolCalls })
          for (const call of toolCalls) {
            const result = await execute(call, run.exec, sub)
            convo.push({ role: 'tool', tool_call_id: call.id, content: result.content })
            // A screenshot is threaded back as a vision message so vision-capable
            // models can actually see the rendered UI.
            if (result.image) {
              convo.push({ role: 'user', content: [
                { type: 'text', text: 'Screenshot of the current app for your analysis:' },
                { type: 'image_url', image_url: { url: result.image } },
              ] })
            }
          }
        }
        sub.next({ type: 'done', model: run.model })
        sub.complete()
      } catch (e: any) {
        if (ctrl.signal.aborted) { sub.complete(); return }
        sub.next({ type: 'error', message: e?.message ?? String(e) })
        sub.complete()
      }
    })()

    return () => ctrl.abort()
  })
}

interface ExecResult { content: string; image?: string }

async function execute(call: ToolCall, ex: Executors, sub: { next: (e: AgentEvent) => void }): Promise<ExecResult> {
  let args: any = {}
  try { args = JSON.parse(call.function.arguments || '{}') } catch { /* tolerate */ }
  const name = call.function.name
  try {
    switch (name) {
      case 'write_file': {
        const path = norm(String(args.path ?? ''))
        const contents = String(args.contents ?? '')
        if (!path) return { content: 'error: missing path' }
        await ex.writeFile(path, contents)
        sub.next({ type: 'fileWritten', path, contents })
        sub.next({ type: 'action', action: { kind: 'file', label: `wrote ${path}`, path } })
        return { content: `ok: wrote ${path}` }
      }
      case 'edit_file': {
        const path = norm(String(args.path ?? ''))
        const find = String(args.find ?? '')
        const replace = String(args.replace ?? '')
        if (!path || !find) return { content: 'error: edit_file needs path and find' }
        const r = await ex.editFile(path, find, replace, !!args.replace_all)
        if (!r.ok) return { content: `edit failed: ${r.message ?? 'no match'} — read_file to see the exact current contents, then retry.` }
        sub.next({ type: 'fileWritten', path, contents: '' })
        sub.next({ type: 'action', action: { kind: 'file', label: `edited ${path} (${r.count}×)`, path } })
        return { content: `ok: edited ${path} (${r.count} replacement${r.count === 1 ? '' : 's'})` }
      }
      case 'read_file': {
        const path = norm(String(args.path ?? ''))
        const content = await ex.readFile(path)
        sub.next({ type: 'action', action: { kind: 'read', label: `read ${path}`, path, output: content == null ? `not found: ${path}` : content.slice(0, 4000) } })
        return { content: content == null ? `not found: ${path}` : content }
      }
      case 'list_files': {
        const files = ex.listFiles()
        sub.next({ type: 'action', action: { kind: 'list', label: 'listed files', output: files.join('\n') || '(no files)' } })
        return { content: files.join('\n') }
      }
      case 'delete_file': {
        const path = norm(String(args.path ?? ''))
        await ex.deleteFile(path)
        sub.next({ type: 'action', action: { kind: 'delete', label: `deleted ${path}`, path } })
        return { content: `ok: deleted ${path}` }
      }
      case 'generate_image': {
        const path = norm(String(args.path ?? ''))
        await ex.generateImage(String(args.prompt ?? ''), path)
        sub.next({ type: 'action', action: { kind: 'image', label: `generated ${path}`, path } })
        return { content: `ok: generated image at ${path}` }
      }
      case 'run_command': {
        const command = String(args.command ?? '')
        const r = await ex.runCommand(command)
        const out = `(exit ${r.exitCode})\n${r.output || '(no output)'}`.slice(-2000)
        sub.next({ type: 'action', action: { kind: 'command', label: command, path: command, output: out } })
        return { content: `$ ${command}\n${out}` }
      }
      case 'frontend_design': {
        sub.next({ type: 'action', action: { kind: 'design', label: 'consulted design guide' } })
        const existing = await ex.readFile('.pipilot/design.md')
        if (existing && existing.trim()) {
          return { content: `${FRONTEND_DESIGN_GUIDE}\n\n=== THIS PROJECT'S DESIGN SYSTEM (.pipilot/design.md) — follow it for consistency ===\n${existing}` }
        }
        return { content: `${FRONTEND_DESIGN_GUIDE}\n\n=== NO DESIGN SYSTEM YET ===\nDecide a distinctive design system now and write it to .pipilot/design.md (chosen aesthetic direction, display + body fonts with their import URLs, color tokens, spacing scale, motion approach, and component conventions), then build the UI to match it.` }
      }
      case 'get_console_logs': {
        const logs = await ex.getConsoleLogs()
        sub.next({ type: 'action', action: { kind: 'console', label: 'read console', output: logs.slice(-4000) } })
        return { content: logs }
      }
      case 'read_dom': {
        const dom = await ex.readDom()
        sub.next({ type: 'action', action: { kind: 'dom', label: 'inspected the page', output: dom.slice(0, 4000) } })
        return { content: dom }
      }
      case 'screenshot': {
        const shot = await ex.screenshot()
        if (shot.error || !shot.dataUrl) {
          sub.next({ type: 'action', action: { kind: 'screenshot', label: 'screenshot failed', output: shot.error ?? 'no image' } })
          return { content: `screenshot failed: ${shot.error ?? 'no image'}` }
        }
        sub.next({ type: 'action', action: { kind: 'screenshot', label: 'screenshot', image: shot.dataUrl } })
        return { content: 'Screenshot captured — see the attached image of the rendered UI.', image: shot.dataUrl }
      }
      case 'web_search': {
        const query = String(args.query ?? '').trim()
        if (!query) return { content: 'error: missing query' }
        const out = await ex.webSearch(query)
        sub.next({ type: 'action', action: { kind: 'search', label: `searched ${query}`, output: out.slice(0, 4000) } })
        return { content: out.slice(0, 8000) }
      }
      case 'web_fetch': {
        const url = String(args.url ?? '').trim()
        if (!url) return { content: 'error: missing url' }
        const out = await ex.webFetch(url)
        sub.next({ type: 'action', action: { kind: 'fetch', label: `fetched ${url}`, output: out.slice(0, 4000) } })
        return { content: out.slice(0, 12000) }
      }
      case 'snapshot': {
        const r = await ex.preview('snapshot', {})
        const out = r.error ? `error: ${r.error}` : String(r.result)
        sub.next({ type: 'action', action: { kind: 'interact', label: 'page snapshot', output: out.slice(0, 4000) } })
        return { content: out.slice(0, 8000) }
      }
      case 'inspect_page': {
        const tgt = args.ref ?? args.selector
        const r = await ex.preview('inspect', { ref: args.ref, selector: args.selector })
        const out = r.error ? `error: ${r.error}` : JSON.stringify(r.result, null, 2)
        sub.next({ type: 'action', action: { kind: 'interact', label: tgt ? `inspected ${tgt}` : 'inspected page', output: out.slice(0, 4000) } })
        return { content: out.slice(0, 6000) }
      }
      case 'click': {
        const r = await ex.preview('click', { ref: args.ref, selector: args.selector })
        const out = fmtState(r)
        sub.next({ type: 'action', action: { kind: 'interact', label: `click ${args.ref ?? args.selector}`, output: out.slice(0, 4000) } })
        return { content: out.slice(0, 6000) }
      }
      case 'fill': {
        const r = await ex.preview('fill', { ref: args.ref, selector: args.selector, value: args.value })
        const out = fmtState(r)
        sub.next({ type: 'action', action: { kind: 'interact', label: `fill ${args.ref ?? args.selector}`, output: out.slice(0, 4000) } })
        return { content: out.slice(0, 6000) }
      }
      case 'press_key': {
        const r = await ex.preview('pressKey', { key: args.key, ref: args.ref, selector: args.selector, modifiers: args.modifiers })
        const out = fmtState(r)
        sub.next({ type: 'action', action: { kind: 'interact', label: `key ${args.key}`, output: out.slice(0, 4000) } })
        return { content: out.slice(0, 6000) }
      }
      case 'scroll': {
        const r = await ex.preview('scroll', { to: args.to, ref: args.ref, selector: args.selector })
        const out = fmtState(r)
        sub.next({ type: 'action', action: { kind: 'interact', label: `scroll ${args.to}`, output: out.slice(0, 4000) } })
        return { content: out.slice(0, 6000) }
      }
      case 'evaluate': {
        const r = await ex.preview('evaluate', { code: String(args.code ?? '') })
        const out = r.error ? `error: ${r.error}` : JSON.stringify(r.result, null, 2)
        sub.next({ type: 'action', action: { kind: 'interact', label: 'evaluate', output: out.slice(0, 4000) } })
        return { content: out.slice(0, 6000) }
      }
      default:
        return { content: `unsupported tool: ${name}` }
    }
  } catch (e: any) {
    return { content: `error running ${name}: ${e?.message ?? e}` }
  }
}
