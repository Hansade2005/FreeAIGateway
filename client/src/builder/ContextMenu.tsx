import { useEffect } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface MenuItem {
  label?: string
  icon?: LucideIcon
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

export interface MenuState { x: number; y: number; items: MenuItem[] }

// A lightweight VSCode-style right-click menu. The parent owns the open state
// (position + items); this renders it, clamped to the viewport, and closes on
// outside-click / Escape / resize / scroll.
export function ContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [state, onClose])

  if (!state) return null
  const rows = state.items.length
  const style = {
    top: Math.min(state.y, window.innerHeight - 12 - rows * 32),
    left: Math.min(state.x, window.innerWidth - 210),
  }
  return (
    <div className="fixed inset-0 z-[60]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div style={style} className="absolute min-w-[190px] overflow-hidden rounded-lg border bg-surface-1 py-1 text-[13px] shadow-xl" onClick={(e) => e.stopPropagation()}>
        {state.items.map((it, i) => it.separator
          ? <div key={i} className="my-1 border-t" />
          : (
            <button
              key={i}
              disabled={it.disabled}
              onClick={() => { it.onClick?.(); onClose() }}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${it.danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-surface-2'} disabled:opacity-40 disabled:hover:bg-transparent`}
            >
              {it.icon ? <it.icon className="size-3.5 shrink-0 opacity-80" /> : <span className="size-3.5 shrink-0" />}
              <span className="truncate">{it.label}</span>
            </button>
          ))}
      </div>
    </div>
  )
}
