import { Observable } from 'rxjs'
import { streamChat, type ChatMsg, type ToolDef } from './gateway'
import { SYSTEM_PROMPT, buildContextMessage } from './prompts'
import { parseFiles } from './parse'

// Real function tools the agent can call, executed client-side against the
// WebContainer. run_command unlocks the self-verifying loop: install deps, run
// `npm run build`, read the error, fix, rebuild — until it's green.
export const BUILDER_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the project sandbox and get back its combined output + exit code. Use it to install npm packages you import (e.g. "npm install recharts") BEFORE using them, and to run "npm run build" to verify the app compiles. If a build fails, read the error, fix the files, and run the build again.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'the shell command, e.g. "npm install recharts"' } }, required: ['command'] },
    },
  },
]

export type AgentEvent =
  | { type: 'status'; status: string }
  | { type: 'delta'; delta: string }
  | { type: 'file'; path: string; contents: string }
  | { type: 'command'; command: string }
  | { type: 'done'; model: string }
  | { type: 'error'; message: string }

export interface AgentRun {
  history: ChatMsg[]
  files: Record<string, string>
  userPrompt: string
  recentErrors?: string
  model: string
  fallbackModel: string | null
  runCommand: (command: string) => Promise<{ output: string; exitCode: number }>
}

const MAX_STEPS = 6

export function runAgent(run: AgentRun): Observable<AgentEvent> {
  return new Observable<AgentEvent>((sub) => {
    const ctrl = new AbortController()

    const convo: ChatMsg[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildContextMessage({ files: run.files, recentErrors: run.recentErrors }) },
      ...run.history,
      { role: 'user', content: run.userPrompt },
    ]

    let acc = '' // cumulative model content across turns (for file-block parsing)
    let emitted = 0
    const flushNewFiles = () => {
      const parsed = parseFiles(acc)
      for (let i = emitted; i < parsed.length; i++) sub.next({ type: 'file', path: parsed[i].path, contents: parsed[i].contents })
      emitted = parsed.length
    }

    ;(async () => {
      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          if (ctrl.signal.aborted) { sub.complete(); return }
          sub.next({ type: 'status', status: step === 0 ? 'thinking' : 'working' })

          const { text, toolCalls, model } = await streamChat(
            convo, run.model, run.fallbackModel,
            (delta) => { acc += delta; sub.next({ type: 'delta', delta }); if (delta.includes('</file>')) flushNewFiles() },
            BUILDER_TOOLS,
            { signal: ctrl.signal },
          )
          flushNewFiles()

          if (toolCalls.length === 0) { sub.next({ type: 'done', model }); sub.complete(); return }

          // Execute the tool calls and feed the results back for the next turn.
          convo.push({ role: 'assistant', content: text, tool_calls: toolCalls })
          for (const call of toolCalls) {
            let result = { output: '', exitCode: -1 }
            let command = ''
            if (call.function.name === 'run_command') {
              try { command = String(JSON.parse(call.function.arguments || '{}').command ?? '') } catch { command = '' }
              if (command) {
                sub.next({ type: 'delta', delta: `\n<cmd>${command}</cmd>\n` })
                sub.next({ type: 'command', command })
                result = await run.runCommand(command)
              }
            }
            convo.push({
              role: 'tool',
              tool_call_id: call.id,
              content: command
                ? `$ ${command}\n(exit ${result.exitCode})\n${result.output || '(no output)'}`
                : `Unsupported tool: ${call.function.name}`,
            })
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
