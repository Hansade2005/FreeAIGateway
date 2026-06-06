import type { FileSystemTree } from '@webcontainer/api'

// Phase-0 spike template: a tiny zero-dependency Node HTTP server. It proves the
// full WebContainer pipeline (boot → mount → spawn → server-ready → preview)
// WITHOUT a slow `npm install`, so the cross-origin-isolation de-risk doesn't
// hinge on registry access. Phase 1 swaps this for a real Vite + React project.
export const spikeFiles: FileSystemTree = {
  'package.json': {
    file: {
      contents: JSON.stringify(
        { name: 'fag-builder-spike', type: 'module', scripts: { start: 'node server.js' } },
        null,
        2,
      ),
    },
  },
  'server.js': {
    file: {
      contents: `import { createServer } from 'node:http';

const page = \`<!doctype html><html><head><meta charset="utf-8"><title>WebContainer preview</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;height:100vh;display:grid;place-items:center;font-family:ui-sans-serif,system-ui,sans-serif;
       background:radial-gradient(60rem 40rem at 20% -10%,#13321f,#0d1014 60%);color:#e8e8ea}
  .card{text-align:center;padding:40px 48px;border:1px solid rgba(255,255,255,.1);border-radius:24px;
        background:rgba(255,255,255,.03);box-shadow:0 30px 80px -30px rgba(0,0,0,.6)}
  h1{font-size:26px;margin:0 0 6px} .ok{color:#5ce39a} p{color:#9aa0a6;margin:4px 0}
  code{font-family:ui-monospace,monospace;color:#5ce39a}
</style></head><body>
  <div class="card">
    <h1><span class="ok">●</span> Running inside WebContainer</h1>
    <p>This page is served by a Node HTTP server running <b>in your browser</b>.</p>
    <p>No cloud sandbox. Live clock: <code id="t">…</code></p>
  </div>
  <script>setInterval(()=>{document.getElementById('t').textContent=new Date().toLocaleTimeString()},1000)</script>
</body></html>\`;

const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page);
});
server.listen(3111, () => console.log('[spike] server listening on http://localhost:3111'));
`,
    },
  },
}
