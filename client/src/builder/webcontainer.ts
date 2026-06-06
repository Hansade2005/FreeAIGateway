import { WebContainer } from '@webcontainer/api'
import { toFileSystemTree } from './template'

// Thin lifecycle wrapper around a single WebContainer instance: boot → mount →
// install → dev server, plus incremental file writes (Vite HMR picks them up,
// no restart) and dev-server output capture for the error-feedback loop.

export type WCStatus = 'idle' | 'booting' | 'installing' | 'starting' | 'ready' | 'error'

export interface WCCallbacks {
  onStatus?: (s: WCStatus) => void
  onOutput?: (chunk: string) => void   // raw dev-server / install output
  onServerReady?: (url: string) => void
}

let instance: WebContainer | null = null
let bootPromise: Promise<WebContainer> | null = null

// WebContainer allows only one instance per page.
async function getContainer(): Promise<WebContainer> {
  if (instance) return instance
  if (!bootPromise) bootPromise = WebContainer.boot()
  instance = await bootPromise
  return instance
}

export class Workspace {
  private wc: WebContainer | null = null
  private devProc: Awaited<ReturnType<WebContainer['spawn']>> | null = null
  private cb: WCCallbacks
  status: WCStatus = 'idle'
  previewUrl = ''

  constructor(cb: WCCallbacks = {}) { this.cb = cb }

  private setStatus(s: WCStatus) { this.status = s; this.cb.onStatus?.(s) }

  /** Boot, mount the given files, npm install, and start the dev server. */
  async start(files: Record<string, string>): Promise<void> {
    if (!self.crossOriginIsolated) throw new Error('Not cross-origin isolated — WebContainer cannot boot on this page.')
    this.setStatus('booting')
    this.wc = await getContainer()
    this.wc.on('server-ready', (_port, url) => {
      this.previewUrl = url
      this.setStatus('ready')
      this.cb.onServerReady?.(url)
    })
    await this.wc.mount(toFileSystemTree(files))
    await this.install()
    await this.runDev()
  }

  private pipe(proc: Awaited<ReturnType<WebContainer['spawn']>>) {
    proc.output.pipeTo(new WritableStream({ write: (d) => this.cb.onOutput?.(d) }))
  }

  private async install(): Promise<void> {
    if (!this.wc) return
    this.setStatus('installing')
    // --no-audit/--no-fund skip extra network round-trips; --prefer-offline reuses
    // any cached tarballs. The template ships a lockfile so resolution is skipped.
    const proc = await this.wc.spawn('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'])
    this.pipe(proc)
    const code = await proc.exit
    if (code !== 0) { this.setStatus('error'); throw new Error(`npm install failed (exit ${code})`) }
  }

  private async runDev(): Promise<void> {
    if (!this.wc) return
    this.setStatus('starting')
    this.devProc = await this.wc.spawn('npm', ['run', 'dev'])
    this.pipe(this.devProc)
    // server-ready fires via the `on` handler set in start().
  }

  /** Write/overwrite a single file; creates parent dirs as needed. Vite HMRs. */
  async writeFile(path: string, contents: string): Promise<void> {
    if (!this.wc) return
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) await this.wc.fs.mkdir(dir, { recursive: true }).catch(() => {})
    await this.wc.fs.writeFile(path, contents)
  }

  async writeFiles(files: Record<string, string>): Promise<void> {
    for (const [path, contents] of Object.entries(files)) await this.writeFile(path, contents)
  }

  /** Read a text file from the sandbox (null if missing). */
  async readFile(path: string): Promise<string | null> {
    if (!this.wc) return null
    try { return await this.wc.fs.readFile(path, 'utf-8') } catch { return null }
  }

  /** Delete a file from the sandbox. */
  async deleteFile(path: string): Promise<void> {
    if (!this.wc) return
    await this.wc.fs.rm(path, { force: true }).catch(() => {})
  }

  /** Write a binary asset (e.g. a generated image) into the project. */
  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    if (!this.wc) return
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) await this.wc.fs.mkdir(dir, { recursive: true }).catch(() => {})
    await this.wc.fs.writeFile(path, data)
  }

  /** Run an arbitrary command in the sandbox (for the agent's run_command tool),
   * capturing combined output and exit code. */
  async exec(command: string): Promise<{ output: string; exitCode: number }> {
    if (!this.wc) throw new Error('workspace not started')
    const parts = command.trim().split(/\s+/)
    const proc = await this.wc.spawn(parts[0], parts.slice(1))
    let output = ''
    proc.output.pipeTo(new WritableStream({ write: (d) => { output += d; this.cb.onOutput?.(d) } }))
    const exitCode = await proc.exit
    return { output: output.slice(-4000), exitCode }
  }

  /** Re-install (used when package.json changed) then the dev server picks up deps. */
  async reinstall(): Promise<void> {
    await this.install()
  }

  /** Build for production and return the emitted dist/ files as bytes (text and
   * binary alike) — ready to upload to a host. */
  async build(): Promise<Record<string, Uint8Array>> {
    if (!this.wc) throw new Error('workspace not started')
    const proc = await this.wc.spawn('npm', ['run', 'build'])
    this.pipe(proc)
    const code = await proc.exit
    if (code !== 0) throw new Error(`build failed (exit ${code})`)
    return this.readDir('dist')
  }

  private async readDir(dir: string, base = dir): Promise<Record<string, Uint8Array>> {
    if (!this.wc) return {}
    const out: Record<string, Uint8Array> = {}
    const entries = await this.wc.fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) Object.assign(out, await this.readDir(full, base))
      else out[full.slice(base.length + 1)] = await this.wc.fs.readFile(full)
    }
    return out
  }
}
