import { Observable } from 'rxjs'
import { streamChat, type ChatMsg, type ToolDef, type ToolCall } from './gateway'
import { SYSTEM_PROMPT, buildContextMessage } from './prompts'

// The builder agent is a pure function-calling agent: it reads/writes files,
// generates images, and runs commands via real tools, executed client-side
// against the WebContainer. No tag parsing.

export const BUILDER_TOOLS: ToolDef[] = [
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file with the full contents. Always pass the COMPLETE file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'project-relative path, e.g. src/App.jsx' }, contents: { type: 'string', description: 'the full file contents' } }, required: ['path', 'contents'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file to inspect its current contents before editing.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List all files in the project.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'delete_file', description: 'Delete a file from the project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'generate_image', description: 'Generate an image asset from a text prompt and save it (use public/ paths, reference as /name in code).', parameters: { type: 'object', properties: { prompt: { type: 'string' }, path: { type: 'string', description: 'e.g. public/hero.png' } }, required: ['prompt', 'path'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a shell command (e.g. "npm install recharts"). Prefer the dev server\'s live errors over full rebuilds; only run "npm run build" when you specifically need a production build check.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
]

export type ActionKind = 'file' | 'image' | 'command' | 'delete' | 'read' | 'list'
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
  readFile: (path: string) => Promise<string | null>
  listFiles: () => string[]
  deleteFile: (path: string) => Promise<void>
  generateImage: (prompt: string, path: string) => Promise<void>
  runCommand: (command: string) => Promise<{ output: string; exitCode: number }>
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
            convo.push({ role: 'tool', tool_call_id: call.id, content: result })
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

async function execute(call: ToolCall, ex: Executors, sub: { next: (e: AgentEvent) => void }): Promise<string> {
  let args: any = {}
  try { args = JSON.parse(call.function.arguments || '{}') } catch { /* tolerate */ }
  const name = call.function.name
  try {
    switch (name) {
      case 'write_file': {
        const path = norm(String(args.path ?? ''))
        const contents = String(args.contents ?? '')
        if (!path) return 'error: missing path'
        await ex.writeFile(path, contents)
        sub.next({ type: 'fileWritten', path, contents })
        sub.next({ type: 'action', action: { kind: 'file', label: `wrote ${path}`, path } })
        return `ok: wrote ${path}`
      }
      case 'read_file': {
        const path = norm(String(args.path ?? ''))
        const content = await ex.readFile(path)
        sub.next({ type: 'action', action: { kind: 'read', label: `read ${path}`, path } })
        return content == null ? `not found: ${path}` : content
      }
      case 'list_files': {
        const list = ex.listFiles()
        sub.next({ type: 'action', action: { kind: 'list', label: 'listed files' } })
        return list.join('\n')
      }
      case 'delete_file': {
        const path = norm(String(args.path ?? ''))
        await ex.deleteFile(path)
        sub.next({ type: 'action', action: { kind: 'delete', label: `deleted ${path}`, path } })
        return `ok: deleted ${path}`
      }
      case 'generate_image': {
        const path = norm(String(args.path ?? ''))
        await ex.generateImage(String(args.prompt ?? ''), path)
        sub.next({ type: 'action', action: { kind: 'image', label: `generated ${path}`, path } })
        return `ok: generated image at ${path}`
      }
      case 'run_command': {
        const command = String(args.command ?? '')
        sub.next({ type: 'action', action: { kind: 'command', label: command, path: command } })
        const r = await ex.runCommand(command)
        return `$ ${command}\n(exit ${r.exitCode})\n${r.output || '(no output)'}`
      }
      default:
        return `unsupported tool: ${name}`
    }
  } catch (e: any) {
    return `error running ${name}: ${e?.message ?? e}`
  }
}
