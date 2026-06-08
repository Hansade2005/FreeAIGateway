// A thin vertical drag handle for resizing horizontally-adjacent panels.
// Reports incremental pointer movement (movementX) so the parent can clamp.
export function ColResizer({ onDelta }: { onDelta: (dx: number) => void }) {
  function down(e: React.MouseEvent) {
    e.preventDefault()
    const move = (ev: MouseEvent) => onDelta(ev.movementX)
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  return (
    <div
      onMouseDown={down}
      className="group relative w-1 shrink-0 cursor-col-resize bg-border/60 transition-colors hover:bg-signal/50"
      title="Drag to resize"
    >
      {/* widen the hit area without taking layout space */}
      <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
    </div>
  )
}
