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
      // Report uncaught errors to the builder (parent window) for auto-fix.
      (function () {
        function send(kind, msg, stack) {
          try { parent.postMessage({ __fagPreview: true, kind: kind, message: String(msg), stack: stack ? String(stack) : '' }, '*'); } catch (e) {}
        }
        window.addEventListener('error', function (e) { send('error', e.message, e.error && e.error.stack); });
        window.addEventListener('unhandledrejection', function (e) { send('unhandledrejection', (e.reason && e.reason.message) || e.reason, e.reason && e.reason.stack); });
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
