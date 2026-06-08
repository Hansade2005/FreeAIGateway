import { useMemo, useState, useEffect } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { vscodeDark } from '@uiw/codemirror-theme-vscode'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'
import { Pencil, Copy, ClipboardCopy, Trash2, Save } from 'lucide-react'
import { FileTree, type FsOps } from './FileTree'
import { ColResizer } from './Resizer'
import { ContextMenu, type MenuState } from './ContextMenu'

const EXPLORER_KEY = 'fag-builder-explorerw'

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
  files, assets, selected, onSelect, draft, onChangeDraft, onSave, fs,
}: {
  files: Record<string, string>
  assets: Record<string, Uint8Array>
  selected: string
  onSelect: (p: string) => void
  draft: string | null
  onChangeDraft: (v: string) => void
  onSave: () => void
  fs?: FsOps
}) {
  const [menu, setMenu] = useState<MenuState | null>(null)

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
    <div className="flex h-full min-h-0">
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
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
