import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Workspace } from './webcontainer'

// A real interactive terminal (xterm) wired to the WebContainer's jsh shell —
// read AND write, Bolt-style. Mounted only while the panel is open; closing it
// kills the shell (the dev server is a separate process and keeps running).
export function TerminalPanel({ workspace }: { workspace: Workspace | null }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current || !hostRef.current || !workspace) return
    started.current = true
    let disposed = false
    let proc: Awaited<ReturnType<Workspace['startShell']>> | null = null
    let writer: WritableStreamDefaultWriter<string> | null = null

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#0a0a0a', foreground: '#e5e5e5', cursor: '#22c55e' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    try { fit.fit() } catch { /* host not laid out yet */ }

    ;(async () => {
      try {
        proc = await workspace.startShell(term.cols || 80, term.rows || 24)
        if (disposed) { try { proc.kill() } catch { /* ignore */ } return }
        proc.output.pipeTo(new WritableStream({ write: (d: string) => term.write(d) })).catch(() => {})
        writer = proc.input.getWriter()
        term.onData((d) => { writer?.write(d).catch(() => {}) })
      } catch (e: any) {
        term.write('\r\n\x1b[31mfailed to start shell: ' + (e?.message ?? e) + '\x1b[0m\r\n')
      }
    })()

    const ro = new ResizeObserver(() => {
      try { fit.fit(); proc?.resize({ cols: term.cols, rows: term.rows }) } catch { /* ignore */ }
    })
    ro.observe(hostRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      try { writer?.releaseLock() } catch { /* ignore */ }
      try { proc?.kill() } catch { /* ignore */ }
      term.dispose()
      started.current = false
    }
  }, [workspace])

  return <div ref={hostRef} className="size-full overflow-hidden px-2 pt-1" />
}
