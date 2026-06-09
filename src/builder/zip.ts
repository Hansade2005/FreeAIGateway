import { zipSync, strToU8 } from 'fflate'

// Download the current project as a .zip (client-side): text files + any
// generated binary assets (images).
export function downloadZip(name: string, files: Record<string, string>, assets: Record<string, Uint8Array> = {}): void {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, contents] of Object.entries(files)) {
    if (path.startsWith('node_modules/') || path === 'package-lock.json') continue
    entries[path] = strToU8(contents)
  }
  for (const [path, bytes] of Object.entries(assets)) entries[path] = bytes
  const blob = new Blob([zipSync(entries, { level: 6 })], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(name || 'app').replace(/[^a-z0-9-_]+/gi, '-')}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
