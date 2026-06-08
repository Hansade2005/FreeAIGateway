import { useState } from 'react'
import { ChevronRight, ChevronDown, File as FileIcon, FileCode2, Image as ImageIcon, FilePlus, FolderPlus, Pencil, Copy, Trash2, ClipboardCopy } from 'lucide-react'
import { ContextMenu, type MenuState } from './ContextMenu'

// A small VSCode-style file explorer built from a flat list of paths, with a
// right-click context menu for the usual file operations.

// File operations the explorer/editor invoke. The owner (Builder) handles the
// name prompts + the actual writes to the sandbox + persistence.
export interface FsOps {
  newFile: (parentDir: string) => void
  newFolder: (parentDir: string) => void
  rename: (path: string) => void
  remove: (path: string) => void
  duplicate: (path: string) => void
  copyPath: (path: string) => void
}

interface TreeNode { name: string; path: string; dir: boolean; children: TreeNode[] }

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] }
  for (const p of paths.sort()) {
    const parts = p.split('/')
    let node = root
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1
      let child = node.children.find((c) => c.name === part)
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join('/'), dir: !isFile, children: [] }
        node.children.push(child)
      }
      node = child
    })
  }
  // dirs first, then files, alphabetical
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    n.children.forEach(sort)
  }
  sort(root)
  return root.children
}

function iconFor(name: string) {
  if (/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(name)) return ImageIcon
  if (/\.(jsx?|tsx?|css|html|json)$/i.test(name)) return FileCode2
  return FileIcon
}

const parentOf = (path: string) => { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i) }

function Row({ node, depth, selected, onSelect, onContext }: {
  node: TreeNode; depth: number; selected: string; onSelect: (p: string) => void; onContext: (e: React.MouseEvent, node: TreeNode) => void
}) {
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: 8 + depth * 12 }
  if (node.dir) {
    return (
      <div>
        <button onClick={() => setOpen((v) => !v)} onContextMenu={(e) => onContext(e, node)} style={pad} className="flex w-full items-center gap-1 py-0.5 text-left text-[12px] text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children.map((c) => <Row key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} onContext={onContext} />)}
      </div>
    )
  }
  const Icon = iconFor(node.name)
  const active = selected === node.path
  return (
    <button onClick={() => onSelect(node.path)} onContextMenu={(e) => onContext(e, node)} style={pad} className={`flex w-full items-center gap-1.5 py-0.5 text-left text-[12px] ${active ? 'bg-signal-muted text-signal' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

export function FileTree({ paths, selected, onSelect, fs }: { paths: string[]; selected: string; onSelect: (p: string) => void; fs?: FsOps }) {
  const tree = buildTree(paths)
  const [menu, setMenu] = useState<MenuState | null>(null)

  function openMenu(e: React.MouseEvent, node: TreeNode) {
    if (!fs) return
    e.preventDefault(); e.stopPropagation()
    if (!node.dir) onSelect(node.path)
    const dir = node.dir ? node.path : parentOf(node.path)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'New File…', icon: FilePlus, onClick: () => fs.newFile(dir) },
        { label: 'New Folder…', icon: FolderPlus, onClick: () => fs.newFolder(dir) },
        { separator: true },
        { label: 'Rename…', icon: Pencil, onClick: () => fs.rename(node.path) },
        ...(!node.dir ? [{ label: 'Duplicate', icon: Copy, onClick: () => fs.duplicate(node.path) }] : []),
        { label: 'Copy Path', icon: ClipboardCopy, onClick: () => fs.copyPath(node.path) },
        { separator: true },
        { label: 'Delete', icon: Trash2, danger: true, onClick: () => fs.remove(node.path) },
      ],
    })
  }

  // Right-click on the empty area → root-level create actions.
  function openRootMenu(e: React.MouseEvent) {
    if (!fs) return
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'New File…', icon: FilePlus, onClick: () => fs.newFile('') },
        { label: 'New Folder…', icon: FolderPlus, onClick: () => fs.newFolder('') },
      ],
    })
  }

  return (
    <div className="min-h-full space-y-px py-1" onContextMenu={openRootMenu}>
      {tree.map((n) => <Row key={n.path} node={n} depth={0} selected={selected} onSelect={onSelect} onContext={openMenu} />)}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
