import { useState } from 'react'
import { ChevronRight, ChevronDown, File as FileIcon, FileCode2, Image as ImageIcon } from 'lucide-react'

// A small VSCode-style file explorer built from a flat list of paths.

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

function Row({ node, depth, selected, onSelect }: { node: TreeNode; depth: number; selected: string; onSelect: (p: string) => void }) {
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: 8 + depth * 12 }
  if (node.dir) {
    return (
      <div>
        <button onClick={() => setOpen((v) => !v)} style={pad} className="flex w-full items-center gap-1 py-0.5 text-left text-[12px] text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children.map((c) => <Row key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
      </div>
    )
  }
  const Icon = iconFor(node.name)
  const active = selected === node.path
  return (
    <button onClick={() => onSelect(node.path)} style={pad} className={`flex w-full items-center gap-1.5 py-0.5 text-left text-[12px] ${active ? 'bg-signal-muted text-signal' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

export function FileTree({ paths, selected, onSelect }: { paths: string[]; selected: string; onSelect: (p: string) => void }) {
  const tree = buildTree(paths)
  return (
    <div className="space-y-px py-1">
      {tree.map((n) => <Row key={n.path} node={n} depth={0} selected={selected} onSelect={onSelect} />)}
    </div>
  )
}
