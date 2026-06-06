import { Observable } from 'rxjs'
import { streamChat, type ChatMsg } from './gateway'
import { SYSTEM_PROMPT, buildContextMessage } from './prompts'
import { parseFiles } from './parse'

// One codegen turn, modeled as an RxJS stream of events the UI subscribes to.
// Files are emitted as their <file> blocks complete during streaming, so the
// preview updates live; teardown aborts the in-flight gateway request.

export type AgentEvent =
  | { type: 'status'; status: string }
  | { type: 'delta'; delta: string }
  | { type: 'file'; path: string; contents: string }
  | { type: 'done'; model: string; text: string }
  | { type: 'error'; message: string }

export interface AgentRun {
  history: ChatMsg[]
  files: Record<string, string>
  userPrompt: string
  recentErrors?: string
  model: string
  fallbackModel: string | null
}

export function runAgent(run: AgentRun): Observable<AgentEvent> {
  return new Observable<AgentEvent>((sub) => {
    const ctrl = new AbortController()

    const messages: ChatMsg[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildContextMessage({ files: run.files, recentErrors: run.recentErrors }) },
      ...run.history,
      { role: 'user', content: run.userPrompt },
    ]

    let acc = ''
    let emitted = 0 // how many completed file blocks we've already emitted

    const flushNewFiles = () => {
      const parsed = parseFiles(acc)
      for (let i = emitted; i < parsed.length; i++) {
        sub.next({ type: 'file', path: parsed[i].path, contents: parsed[i].contents })
      }
      emitted = parsed.length
    }

    ;(async () => {
      try {
        sub.next({ type: 'status', status: 'thinking' })
        const { text, model } = await streamChat(
          messages,
          run.model,
          run.fallbackModel,
          (delta) => {
            acc += delta
            sub.next({ type: 'delta', delta })
            if (delta.includes('</file>')) flushNewFiles()
          },
          { signal: ctrl.signal },
        )
        acc = text
        flushNewFiles() // catch any trailing block
        sub.next({ type: 'done', model, text })
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
