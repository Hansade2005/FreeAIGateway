import '../index.css'
import { getDeploy, getProject, saveDeployedSubdomain } from './db'

// The /deploy page. NOT cross-origin isolated, so Puter's popup auth works here.
// It reads the built dist/ (handed off via IndexedDB by the isolated builder)
// and publishes it to <subdomain>.puter.site.

const puter = () => (window as any).puter

function waitForPuter(ms = 12000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (puter()) return resolve(puter())
      if (Date.now() - t0 > ms) return reject(new Error('puter.js failed to load'))
      setTimeout(tick, 100)
    }
    tick()
  })
}

const root = document.getElementById('root')!
function render(html: string) { root.innerHTML = html }
const card = (inner: string) => `
  <div style="min-height:100vh;display:grid;place-items:center;background:var(--background);color:var(--foreground);font-family:ui-sans-serif,system-ui,sans-serif;padding:24px">
    <div style="width:100%;max-width:460px;border:1px solid var(--border);border-radius:20px;background:var(--surface-1);padding:28px;box-shadow:0 30px 80px -30px rgba(0,0,0,.6)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <span style="width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:var(--signal);color:var(--signal-foreground);font-weight:700">▲</span>
        <strong style="font-size:15px">Deploy to Puter</strong>
      </div>
      ${inner}
    </div>
  </div>`

const btn = (id: string, label: string) =>
  `<button id="${id}" style="margin-top:16px;width:100%;padding:11px;border:0;border-radius:11px;font-weight:600;cursor:pointer;background:var(--signal);color:var(--signal-foreground)">${label}</button>`

const muted = (t: string) => `<span style="color:var(--muted-foreground)">${t}</span>`

async function main() {
  const params = new URLSearchParams(location.search)
  const id = params.get('id')
  if (!id) {
    // The Builder opens this tab synchronously (so it isn't popup-blocked) with
    // ?building=true while the production build runs, then redirects here with
    // ?id=… once it's ready. Show a friendly "building" state meanwhile.
    if (params.get('building')) { render(card(`<p style="font-size:14px">Building your app…</p><p style="font-size:12.5px;margin-top:8px">${muted('This tab will update automatically when the build is ready to deploy.')}</p>`)); return }
    render(card(`<p>${muted('No deploy in progress. Open this from the Builder’s Deploy button.')}</p>`)); return
  }

  const rec = await getDeploy(id)
  if (!rec) { render(card(`<p>${muted('That build wasn’t found (it may have expired). Re-run Deploy from the Builder.')}</p>`)); return }

  const fileCount = Object.keys(rec.files).length
  // If this project was already published, re-deploy UPDATES that same site.
  const proj = rec.projectId ? await getProject(rec.projectId) : undefined
  const existingSub: string | undefined = proj?.deployedSubdomain
  render(card(`
    <p style="font-size:14px">${existingSub ? 'Update' : 'Publish'} <b>${escapeHtml(rec.name)}</b> — ${fileCount} files${existingSub ? ` — on <b>${escapeHtml(existingSub)}.puter.site</b>` : ' — to a free Puter subdomain'}.</p>
    <p style="font-size:12px;margin-top:6px">${muted('You’ll sign in to Puter (a popup) the first time. The app is hosted under your Puter account.')}</p>
    ${btn('go', existingSub ? 'Sign in to Puter & update' : 'Sign in to Puter & deploy')}
    <p id="status" style="font-size:12.5px;margin-top:14px;min-height:18px"></p>
    <div id="result"></div>
  `))

  const status = (t: string) => { document.getElementById('status')!.textContent = t }
  document.getElementById('go')!.addEventListener('click', async () => {
    const goBtn = document.getElementById('go') as HTMLButtonElement
    goBtn.disabled = true
    try {
      status('Connecting to Puter…')
      const p = await waitForPuter()
      if (!p.auth.isSignedIn()) { status('Waiting for sign-in…'); await p.auth.signIn() }

      // Stable per-project dir so re-deploys overwrite the same files in place.
      const dir = `app-${rec.projectId || rec.id}`
      status('Uploading files…')
      try { await p.fs.mkdir(dir) } catch { /* exists */ }
      let done = 0
      for (const [path, bytes] of Object.entries(rec.files)) {
        const src = bytes as Uint8Array
        const copy = new Uint8Array(src.byteLength) // detach from any SharedArrayBuffer for Blob
        copy.set(src)
        await p.fs.write(`${dir}/${path}`, new Blob([copy]), { overwrite: true, createMissingParents: true })
        status(`Uploading files… ${++done}/${fileCount}`)
      }

      let site: any = null
      // Update the existing site if we have one; otherwise create a fresh subdomain.
      if (existingSub) {
        status('Updating site…')
        try { site = await p.hosting.update(existingSub, dir) } catch { site = null }
        if (!site) { try { site = await p.hosting.create(existingSub, dir) } catch { /* taken/gone → fall through */ } }
        if (site && !site.subdomain) site = { subdomain: existingSub }
      }
      if (!site) {
        status('Creating site…')
        const base = sanitize(rec.name)
        const candidates = [base, `${base}-${rand(4)}`, `app-${rand(6)}`]
        let lastErr = ''
        for (const sub of candidates) {
          try { site = await p.hosting.create(sub, dir); break } catch (e: any) { lastErr = e?.message ?? String(e) }
        }
        if (!site) throw new Error(`Could not create a subdomain (${lastErr})`)
      }
      // Remember the subdomain on the project so the next deploy updates it.
      if (rec.projectId && site?.subdomain) { try { await saveDeployedSubdomain(rec.projectId, site.subdomain) } catch { /* ignore */ } }

      const url = `https://${site.subdomain}.puter.site`
      status('')
      document.getElementById('result')!.innerHTML = `
        <div style="margin-top:6px;padding:14px;border:1px solid var(--signal);border-radius:12px;background:var(--signal-muted)">
          <div style="font-size:13px;margin-bottom:6px">✅ Live at</div>
          <a href="${url}" target="_blank" rel="noopener" style="color:var(--signal);font-weight:600;word-break:break-all">${url}</a>
        </div>`
    } catch (e: any) {
      status('')
      document.getElementById('result')!.innerHTML = `<p style="color:#ef4444;font-size:13px;margin-top:6px">${escapeHtml(e?.message ?? String(e))}</p>`
      goBtn.disabled = false
    }
  })
}

function sanitize(name: string): string {
  return (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'app')
}
function rand(n: number): string { return Math.random().toString(36).slice(2, 2 + n) }
function escapeHtml(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)) }

main()
