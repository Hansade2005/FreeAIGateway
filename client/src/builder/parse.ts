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
