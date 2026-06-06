import { useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { vscodeDark } from '@uiw/codemirror-theme-vscode'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'
import { FileTree } from './FileTree'

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
  files, assets, selected, onSelect, draft, onChangeDraft, onSave,
}: {
  files: Record<string, string>
  assets: Record<string, Uint8Array>
  selected: string
  onSelect: (p: string) => void
  draft: string | null
  onChangeDraft: (v: string) => void
  onSave: () => void
}) {
  const allPaths = useMemo(() => [...Object.keys(files), ...Object.keys(assets)], [files, assets])
  const dirty = draft !== null && draft !== files[selected]

  // Object URL for previewing a selected binary asset.
  const assetUrl = useMemo(() => {
    if (!isImage(selected) || !assets[selected]) return ''
    const copy = new Uint8Array(assets[selected].byteLength)
    copy.set(assets[selected])
    return URL.createObjectURL(new Blob([copy]))
  }, [selected, assets])

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0 overflow-y-auto border-r bg-surface-1">
        <FileTree paths={allPaths} selected={selected} onSelect={onSelect} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <span className="truncate font-mono text-[11px] text-muted-foreground">{selected}</span>
          {dirty && <button onClick={onSave} className="rounded bg-signal px-2 py-0.5 text-[11px] font-semibold text-signal-foreground">Save</button>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
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
  )
}
