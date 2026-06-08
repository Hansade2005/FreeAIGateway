import { useMemo, useState, useEffect } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { vscodeDark } from '@uiw/codemirror-theme-vscode'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'
import { Pencil, Copy, ClipboardCopy, Trash2, Save, TerminalSquare, ChevronDown, X } from 'lucide-react'
import { FileTree, type FsOps } from './FileTree'
import { ColResizer, RowResizer } from './Resizer'
import { ContextMenu, type MenuState } from './ContextMenu'
import { TerminalPanel } from './TerminalPanel'
import type { Workspace, WCStatus } from './webcontainer'

const EXPLORER_KEY = 'fag-builder-explorerw'
const TERMH_KEY = 'fag-builder-termh'

const STATUS_LABEL: Record<WCStatus, string> = {
  idle: 'idle', booting: 'booting', installing: 'installing deps', starting: 'starting server', ready: 'ready', error: 'error',
}

function extensionsFor(path: string) {
  if (/\.(jsx|tsx)$/.test(path)) return [javascript({ jsx: true, typescript: /\.tsx$/.test(path) })]
  if (/\.(js|ts|mjs|cjs)$/.test(path)) return [javascript({ typescript: /\.ts$/.test(path) })]
  if (/\.css$/.test(path)) return [css()]
  if (/\.html?$/.test(path)) return [html()]
  if (/\.json$/.test(path)) return [json()]
  return []
}

const isImage = (p: string) => /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(p)

export function CodeView({
  files, assets, selected, onSelect, draft, onChangeDraft, onSave, fs, workspace, status,
}: {
  files: Record<string, string>
  assets: Record<string, Uint8Array>
  selected: string
  onSelect: (p: string) => void
  draft: string | null
  onChangeDraft: (v: string) => void
  onSave: () => void
  fs?: FsOps
  workspace?: Workspace | null
  status?: WCStatus
}) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [showTerminal, setShowTerminal] = useState(false)
  const [termHeight, setTermHeight] = useState(() => {
    const v = Number(localStorage.getItem(TERMH_KEY) || '')
    return v >= 120 && v <= 600 ? v : 240
  })
  useEffect(() => { localStorage.setItem(TERMH_KEY, String(termHeight)) }, [termHeight])

  function openEditorMenu(e: React.MouseEvent) {
    if (!selected) return
    e.preventDefault()
    const sel = window.getSelection()?.toString() ?? ''
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Save', icon: Save, disabled: !dirty, onClick: onSave },
        { label: sel ? 'Copy Selection' : 'Copy File Contents', icon: Copy, onClick: () => navigator.clipboard.writeText(sel || (draft ?? files[selected] ?? '')).catch(() => {}) },
        { label: 'Copy Path', icon: ClipboardCopy, onClick: () => fs?.copyPath(selected) },
        { separator: true },
        { label: 'Rename…', icon: Pencil, disabled: !fs, onClick: () => fs?.rename(selected) },
        { label: 'Duplicate', icon: Copy, disabled: !fs, onClick: () => fs?.duplicate(selected) },
        { label: 'Delete', icon: Trash2, danger: true, disabled: !fs, onClick: () => fs?.remove(selected) },
      ],
    })
  }
  const allPaths = useMemo(() => [...Object.keys(files), ...Object.keys(assets)], [files, assets])
  const dirty = draft !== null && draft !== files[selected]

  const [explorerWidth, setExplorerWidth] = useState(() => {
    const v = Number(localStorage.getItem(EXPLORER_KEY) || '')
    return v >= 140 && v <= 480 ? v : 224
  })
  useEffect(() => { localStorage.setItem(EXPLORER_KEY, String(explorerWidth)) }, [explorerWidth])

  // Object URL for previewing a selected binary asset.
  const assetUrl = useMemo(() => {
    if (!isImage(selected) || !assets[selected]) return ''
    const copy = new Uint8Array(assets[selected].byteLength)
    copy.set(assets[selected])
    return URL.createObjectURL(new Blob([copy]))
  }, [selected, assets])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* explorer + editor */}
      <div className="flex min-h-0 flex-1">
        <div style={{ width: explorerWidth }} className="shrink-0 overflow-y-auto border-r bg-surface-1">
          <FileTree paths={allPaths} selected={selected} onSelect={onSelect} fs={fs} />
        </div>
        <ColResizer onDelta={(dx) => setExplorerWidth((w) => Math.min(480, Math.max(140, w + dx)))} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b px-3 py-1.5">
            <span className="truncate font-mono text-[11px] text-muted-foreground">{selected}</span>
            {dirty && <button onClick={onSave} className="rounded bg-signal px-2 py-0.5 text-[11px] font-semibold text-signal-foreground">Save</button>}
          </div>
          <div className="min-h-0 flex-1 overflow-auto" onContextMenu={openEditorMenu}>
            {isImage(selected) ? (
              <div className="grid h-full place-items-center bg-[#1e1e1e] p-6">
                {assetUrl ? <img src={assetUrl} alt={selected} className="max-h-full max-w-full rounded border" /> : <span className="text-sm text-muted-foreground">binary asset</span>}
              </div>
            ) : (
              <CodeMirror
                value={draft ?? files[selected] ?? ''}
                theme={vscodeDark}
                height="100%"
                style={{ height: '100%', fontSize: 12.5 }}
                extensions={[...extensionsFor(selected), EditorView.lineWrapping]}
                onChange={onChangeDraft}
              />
            )}
          </div>
        </div>
      </div>

      {/* Terminal panel (VSCode/Bolt-style) */}
      {showTerminal && (
        <>
          <RowResizer onDelta={(dy) => setTermHeight((h) => Math.min(600, Math.max(120, h - dy)))} />
          <div style={{ height: termHeight }} className="flex shrink-0 flex-col bg-[#0a0a0a]">
            <div className="flex items-center justify-between border-y px-3 py-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5 font-medium"><TerminalSquare className="size-3.5" /> Terminal <span className="text-muted-foreground/60">jsh</span></span>
              <button onClick={() => setShowTerminal(false)} className="rounded p-0.5 hover:bg-surface-2 hover:text-foreground" title="Close terminal"><X className="size-3.5" /></button>
            </div>
            <div className="min-h-0 flex-1">
              <TerminalPanel workspace={workspace ?? null} />
            </div>
          </div>
        </>
      )}

      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-3 border-t bg-surface-1 px-3 py-1 text-[11px] text-muted-foreground">
        {status && (
          <span className="flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${status === 'ready' ? 'bg-signal' : status === 'error' ? 'bg-destructive' : 'bg-amber-400'}`} />
            {STATUS_LABEL[status]}
          </span>
        )}
        <span className="truncate font-mono">{selected}{dirty ? ' •' : ''}</span>
        <button
          onClick={() => setShowTerminal((v) => !v)}
          className={`ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-2 hover:text-foreground ${showTerminal ? 'text-foreground' : ''}`}
          title="Toggle terminal"
        >
          <TerminalSquare className="size-3.5" /> Terminal
          <ChevronDown className={`size-3 transition-transform ${showTerminal ? '' : 'rotate-180'}`} />
        </button>
      </div>

      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
