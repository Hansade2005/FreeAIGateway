import type { FileSystemTree } from '@webcontainer/api'
import { PACKAGE_LOCK } from './template-lock'

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
    <script>
      // Bridge between the running app and the builder: forwards console output
      // and errors, and answers DOM / screenshot requests over postMessage.
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
        window.addEventListener('message', function (e) {
          var d = e.data || {};
          if (d.__fagReq === 'dom') {
            var html = (document.documentElement && document.documentElement.outerHTML) || '';
            post({ __fagRes: 'dom', id: d.id, html: html.length > 16000 ? html.slice(0, 16000) + '\\n<!-- …truncated… -->' : html });
          } else if (d.__fagReq === 'shot') {
            (async function () {
              try {
                var mod = await import('https://esm.sh/html2canvas@1.4.1');
                var h2c = mod.default || mod;
                var canvas = await h2c(document.body, { logging: false, useCORS: true, scale: 0.6, backgroundColor: null });
                post({ __fagRes: 'shot', id: d.id, dataUrl: canvas.toDataURL('image/jpeg', 0.7) });
              } catch (err) { post({ __fagRes: 'shot', id: d.id, error: String((err && err.message) || err) }); }
            })();
          }
        });
      })();
    </script>
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
