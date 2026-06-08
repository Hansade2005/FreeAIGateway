import type { FileSystemTree } from '@webcontainer/api'
import { PACKAGE_LOCK } from './template-lock'

// Bridge injected into the preview: forwards console output + errors to the
// builder and answers DOM / screenshot requests over postMessage. Shipped in the
// template's index.html AND injected into older projects that predate it.
export const PREVIEW_BRIDGE = `<script>
  /* fag-bridge:3 */
  (function () {
    function post(p) { try { parent.postMessage(p, '*'); } catch (e) {} }
    function send(kind, message, stack) { post({ __fagPreview: true, kind: kind, message: String(message), stack: stack ? String(stack) : '' }); }
    ['log', 'info', 'warn', 'error'].forEach(function (level) {
      var orig = console[level];
      console[level] = function () {
        try {
          var text = Array.prototype.map.call(arguments, function (a) { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); } }).join(' ');
          post({ __fagConsole: true, level: level, text: text });
        } catch (e) {}
        return orig.apply(console, arguments);
      };
    });
    window.addEventListener('error', function (e) { send('error', e.message, e.error && e.error.stack); });
    window.addEventListener('unhandledrejection', function (e) { send('unhandledrejection', (e.reason && e.reason.message) || e.reason, e.reason && e.reason.stack); });
    // On every (re)load tell the parent to drop stale logs, so the console buffer
    // reflects only the freshly-loaded page (no leftover pre-fix errors).
    post({ __fagReset: true });
    window.addEventListener('load', function () { post({ __fagReset: true }); });
    window.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.__fagReq === 'dom') {
        var html = (document.documentElement && document.documentElement.outerHTML) || '';
        post({ __fagRes: 'dom', id: d.id, html: html.length > 16000 ? html.slice(0, 16000) + '\\n<!-- …truncated… -->' : html });
      } else if (d.__fagReq === 'shot') {
        (async function () {
          try {
            // html-to-image renders via the browser's own engine (SVG
            // foreignObject), so modern CSS color functions (oklch/oklab, used
            // by Tailwind v4) work — html2canvas can't parse those.
            var mod = await import('https://esm.sh/html-to-image@1.11.13');
            function bg(el) { var c = getComputedStyle(el).backgroundColor; return (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') ? c : ''; }
            var color = bg(document.body) || bg(document.documentElement) || '#ffffff';
            var dataUrl = await mod.toJpeg(document.body, { quality: 0.7, pixelRatio: 0.6, backgroundColor: color, cacheBust: true });
            post({ __fagRes: 'shot', id: d.id, dataUrl: dataUrl });
          } catch (err) { post({ __fagRes: 'shot', id: d.id, error: String((err && err.message) || err) }); }
        })();
      }
    });
  })();
</script>`

// Marker baked into the current bridge so we can tell whether a project already
// has the latest version (and skip rewriting it).
const BRIDGE_MARKER = 'fag-bridge:3'
// Matches a previously-injected bridge script (any version) so it can be
// stripped and replaced — attribute-less <script> blocks that reference our
// postMessage protocol. The app's own `<script type="module">` is untouched.
const OLD_BRIDGE_RE = /<script>[\s\S]*?__fag(?:Req|Preview)[\s\S]*?<\/script>\s*/g

// Ensure the project's index.html carries the CURRENT preview bridge. Older
// projects predate the bridge (DOM/screenshot would hang) or carry the v1
// html2canvas bridge (screenshots fail on Tailwind v4's oklch colors) — both
// are upgraded in place.
export function ensureBridge(html: string): string {
  if (!html || html.includes(BRIDGE_MARKER)) return html
  const stripped = html.replace(OLD_BRIDGE_RE, '')
  return stripped.includes('</head>') ? stripped.replace('</head>', `  ${PREVIEW_BRIDGE}\n  </head>`) : PREVIEW_BRIDGE + stripped
}

// The starter project the agent edits: Vite + React 18 + Tailwind v4. Kept
// deliberately small so free models can reason over the whole thing. The agent
// rewrites/creates files under src/ (and may add deps to package.json).
//
// index.html embeds a tiny runtime-error reporter that postMessages uncaught
// errors to the parent window, so the builder can surface them and feed them
// back into the agent for an auto-fix.

export const STARTER_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'fag-app',
      private: true,
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1',
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.3.4',
        '@tailwindcss/vite': '^4.0.0',
        tailwindcss: '^4.0.0',
        vite: '^5.4.10',
      },
    },
    null,
    2,
  ),
  'vite.config.js': `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: true },
})
`,
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    ${PREVIEW_BRIDGE}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
  'src/main.jsx': `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`,
  'src/index.css': `@import "tailwindcss";
`,
  'src/App.jsx': `export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="text-center space-y-3">
        <h1 className="text-3xl font-semibold">Your app starts here</h1>
        <p className="text-neutral-400">Describe what you want to build in the chat →</p>
      </div>
    </div>
  )
}
`,
  // Pinned lockfile so the in-browser `npm install` skips dependency resolution.
  'package-lock.json': PACKAGE_LOCK,
}

// Convert the flat path→content map into the nested tree WebContainer.mount wants.
export function toFileSystemTree(files: Record<string, string>): FileSystemTree {
  const tree: FileSystemTree = {}
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split('/')
    let node: any = tree
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i]
      node[dir] ??= { directory: {} }
      node = node[dir].directory
    }
    node[parts[parts.length - 1]] = { file: { contents } }
  }
  return tree
}
