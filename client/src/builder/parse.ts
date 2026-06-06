// Parse the agent's file blocks out of its response.
//
// The model is instructed to emit each file it creates/changes as:
//   <file path="src/App.jsx">
//   ...full file contents...
//   </file>
// We tolerate an optional ``` code fence wrapping the contents (some models add
// one) and both quote styles on the path.

export interface ParsedFile { path: string; contents: string }

const FILE_RE = /<file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/file>/gi

export function parseFiles(text: string): ParsedFile[] {
  const out: ParsedFile[] = []
  let m: RegExpExecArray | null
  while ((m = FILE_RE.exec(text)) !== null) {
    const path = m[1].trim().replace(/^\.?\//, '') // normalize leading ./ or /
    out.push({ path, contents: stripFence(m[2]) })
  }
  return out
}

// Strip the leading prose + trailing prose isn't needed (regex is bounded), but
// drop a single wrapping ```lang ... ``` fence if the model added one.
function stripFence(raw: string): string {
  let s = raw.replace(/^\n/, '').replace(/\n$/, '')
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/
  const f = fence.exec(s.trim())
  if (f) s = f[1]
  return s.endsWith('\n') ? s : s + '\n'
}

// True once the streamed text contains at least one complete </file>, so the UI
// can apply files as they finish rather than only at the very end.
export function hasCompleteFile(text: string): boolean {
  return /<\/file>/i.test(text)
}

// The agent can request a generated image asset:
//   <image prompt="a neon koi over a reef" path="public/hero.png" />
// The builder generates it via the gateway and writes the bytes into the project.
export interface ParsedImage { prompt: string; path: string }

const IMAGE_RE = /<image\s+([^>]*?)\/?>/gi

export function parseImages(text: string): ParsedImage[] {
  const out: ParsedImage[] = []
  let m: RegExpExecArray | null
  while ((m = IMAGE_RE.exec(text)) !== null) {
    const attrs = m[1]
    const prompt = /prompt=["']([^"']+)["']/.exec(attrs)?.[1]
    const path = /path=["']([^"']+)["']/.exec(attrs)?.[1]
    if (prompt && path) out.push({ prompt: prompt.trim(), path: path.trim().replace(/^\.?\//, '') })
  }
  return out
}

// Ordered list of completed agent actions (file writes + image generations) as
// they appear in the text — drives the inline action pills in the chat.
export type AgentAction = { kind: 'file' | 'image' | 'command'; path: string }

export function parseActions(text: string): AgentAction[] {
  const found: { pos: number; action: AgentAction }[] = []
  let m: RegExpExecArray | null
  const fileRe = /<file\s+path=["']([^"']+)["'][^>]*>[\s\S]*?<\/file>/gi
  while ((m = fileRe.exec(text)) !== null) found.push({ pos: m.index, action: { kind: 'file', path: m[1].trim().replace(/^\.?\//, '') } })
  const imgRe = /<image\s+[^>]*?\/?>/gi
  while ((m = imgRe.exec(text)) !== null) {
    const path = /path=["']([^"']+)["']/.exec(m[0])?.[1]
    if (path) found.push({ pos: m.index, action: { kind: 'image', path: path.trim().replace(/^\.?\//, '') } })
  }
  const cmdRe = /<cmd>([\s\S]*?)<\/cmd>/gi
  while ((m = cmdRe.exec(text)) !== null) found.push({ pos: m.index, action: { kind: 'command', path: m[1].trim() } })
  return found.sort((a, b) => a.pos - b.pos).map((f) => f.action)
}

// The file currently being written (an opened <file> with no closing </file>
// yet), so the UI can show a live "writing …" pill while it streams.
export function inProgressFile(text: string): string | null {
  const lastClose = text.lastIndexOf('</file>')
  const tail = text.slice(lastClose + 7)
  const m = /<file\s+path=["']([^"']+)["']/i.exec(tail)
  return m ? m[1].trim().replace(/^\.?\//, '') : null
}
