import { Observable } from 'rxjs'
import { streamChat, type ChatMsg, type ToolDef, type ToolCall } from './gateway'
import { SYSTEM_PROMPT, buildContextMessage } from './prompts'

// The builder agent is a pure function-calling agent: it reads/writes files,
// generates images, and runs commands via real tools, executed client-side
// against the WebContainer. No tag parsing.

export const BUILDER_TOOLS: ToolDef[] = [
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
]

export type ActionKind = 'file' | 'image' | 'command' | 'delete' | 'read' | 'list' | 'console' | 'dom' | 'screenshot'
export interface AgentAction { kind: ActionKind; label: string; path?: string }

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

export function runAgent(run: AgentRun): Observable<AgentEvent> {
  return new Observable<AgentEvent>((sub) => {
    const ctrl = new AbortController()
    const convo: ChatMsg[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildContextMessage({ files: run.files, recentErrors: run.recentErrors }) },
      ...run.history,
      { role: 'user', content: run.userPrompt },
    ]

    ;(async () => {
      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          if (ctrl.signal.aborted) { sub.complete(); return }
          sub.next({ type: 'status', status: step === 0 ? 'thinking' : 'working' })

          let lastWriting = ''
          const { text, toolCalls, model } = await streamChat(convo, {
            model: run.model,
            fallbackModel: run.fallbackModel,
            tools: BUILDER_TOOLS,
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
        sub.next({ type: 'action', action: { kind: 'read', label: `read ${path}`, path } })
        return { content: content == null ? `not found: ${path}` : content }
      }
      case 'list_files': {
        sub.next({ type: 'action', action: { kind: 'list', label: 'listed files' } })
        return { content: ex.listFiles().join('\n') }
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
        sub.next({ type: 'action', action: { kind: 'command', label: command, path: command } })
        const r = await ex.runCommand(command)
        return { content: `$ ${command}\n(exit ${r.exitCode})\n${r.output || '(no output)'}` }
      }
      case 'get_console_logs': {
        sub.next({ type: 'action', action: { kind: 'console', label: 'read console' } })
        return { content: await ex.getConsoleLogs() }
      }
      case 'read_dom': {
        sub.next({ type: 'action', action: { kind: 'dom', label: 'inspected the page' } })
        return { content: await ex.readDom() }
      }
      case 'screenshot': {
        sub.next({ type: 'action', action: { kind: 'screenshot', label: 'screenshot' } })
        const shot = await ex.screenshot()
        if (shot.error || !shot.dataUrl) return { content: `screenshot failed: ${shot.error ?? 'no image'}` }
        return { content: 'Screenshot captured — see the attached image of the rendered UI.', image: shot.dataUrl }
      }
      default:
        return { content: `unsupported tool: ${name}` }
    }
  } catch (e: any) {
    return { content: `error running ${name}: ${e?.message ?? e}` }
  }
}
