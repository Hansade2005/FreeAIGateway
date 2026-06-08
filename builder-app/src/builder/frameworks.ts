import { STARTER_FILES, PREVIEW_BRIDGE, BRIDGE_BODY } from './template'

// Multi-framework support. Each framework is a minimal, bootable WebContainer
// scaffold (valid package.json with a `dev` script + the preview bridge baked
// into its served HTML) that the agent then builds out. `deploy` says whether
// the production output is static (Puter) or needs a Node host (Vercel/Netlify).

export type FrameworkId = 'react' | 'vue' | 'svelte' | 'vite' | 'nextjs' | 'nuxt' | 'angular' | 'express'

export interface Framework {
  id: FrameworkId
  label: string
  deploy: 'puter' | 'node'        // static hosting vs. needs a server
  buildDirs: string[]             // candidate production output dirs (auto-detected)
  hint: string                    // appended to the agent's system prompt
  files: Record<string, string>   // scaffold
}

// A Vite-style index.html with Tailwind (CDN) + the preview bridge baked in.
const viteHtml = (entry: string, mount = 'app') => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    <script src="https://cdn.tailwindcss.com"></script>
    ${PREVIEW_BRIDGE}
  </head>
  <body>
    <div id="${mount}"></div>
    <script type="module" src="${entry}"></script>
  </body>
</html>
`

const VUE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { vue: '^3.5.13' }, devDependencies: { '@vitejs/plugin-vue': '^5.2.1', vite: '^6.0.0' } }, null, 2),
  'vite.config.js': "import { defineConfig } from 'vite'\nimport vue from '@vitejs/plugin-vue'\nexport default defineConfig({ plugins: [vue()], server: { host: true } })\n",
  'index.html': viteHtml('/src/main.js'),
  'src/main.js': "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n",
  'src/App.vue': "<template>\n  <div class=\"min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100\">\n    <h1 class=\"text-3xl font-semibold\">Your Vue app starts here</h1>\n  </div>\n</template>\n",
}

const SVELTE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, devDependencies: { '@sveltejs/vite-plugin-svelte': '^3.1.2', svelte: '^4.2.19', vite: '^6.0.0' } }, null, 2),
  'vite.config.js': "import { defineConfig } from 'vite'\nimport { svelte } from '@sveltejs/vite-plugin-svelte'\nexport default defineConfig({ plugins: [svelte()], server: { host: true } })\n",
  'svelte.config.js': "import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'\nexport default { preprocess: vitePreprocess() }\n",
  'index.html': viteHtml('/src/main.js'),
  'src/main.js': "import App from './App.svelte'\nconst app = new App({ target: document.getElementById('app') })\nexport default app\n",
  'src/App.svelte': "<main class=\"min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100\">\n  <h1 class=\"text-3xl font-semibold\">Your Svelte app starts here</h1>\n</main>\n",
}

const VITE_VANILLA: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, devDependencies: { vite: '^6.0.0' } }, null, 2),
  'index.html': viteHtml('/src/main.js'),
  'src/main.js': "document.querySelector('#app').innerHTML = '<div class=\"min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100\"><h1 class=\"text-3xl font-semibold\">Your app starts here</h1></div>'\n",
}

const NEXTJS: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', private: true, scripts: { dev: 'next dev', build: 'next build', start: 'next start' }, dependencies: { next: '^14.2.15', react: '^18.3.1', 'react-dom': '^18.3.1' } }, null, 2),
  'next.config.mjs': "const nextConfig = { output: 'export', images: { unoptimized: true } }\nexport default nextConfig\n",
  'app/layout.js': `export const metadata = { title: 'App' }
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <script src="https://cdn.tailwindcss.com"></script>
        <script dangerouslySetInnerHTML={{ __html: ${JSON.stringify(BRIDGE_BODY)} }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
`,
  'app/page.js': "export default function Page() {\n  return (\n    <main className=\"min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100\">\n      <h1 className=\"text-3xl font-semibold\">Your Next.js app starts here</h1>\n    </main>\n  )\n}\n",
  'jsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }, null, 2),
}

const NUXT: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', private: true, type: 'module', scripts: { dev: 'nuxt dev', build: 'nuxt generate', preview: 'nuxt preview' }, devDependencies: { nuxt: '^3.14.0' } }, null, 2),
  'nuxt.config.ts': `export default defineNuxtConfig({
  devtools: { enabled: false },
  app: { head: { script: [ { src: 'https://cdn.tailwindcss.com' }, { innerHTML: ${JSON.stringify(BRIDGE_BODY)} } ] } },
})
`,
  'app.vue': "<template>\n  <div class=\"min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100\">\n    <h1 class=\"text-3xl font-semibold\">Your Nuxt app starts here</h1>\n  </div>\n</template>\n",
}

const ANGULAR: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'app', private: true,
    scripts: { dev: 'ng serve --host 0.0.0.0 --port 5173 --disable-host-check', build: 'ng build' },
    dependencies: { '@angular/common': '^17.3.0', '@angular/compiler': '^17.3.0', '@angular/core': '^17.3.0', '@angular/forms': '^17.3.0', '@angular/platform-browser': '^17.3.0', '@angular/platform-browser-dynamic': '^17.3.0', '@angular/router': '^17.3.0', rxjs: '^7.8.0', tslib: '^2.6.0', 'zone.js': '^0.14.0' },
    devDependencies: { '@angular-devkit/build-angular': '^17.3.0', '@angular/cli': '^17.3.0', '@angular/compiler-cli': '^17.3.0', typescript: '~5.4.0' },
  }, null, 2),
  'angular.json': JSON.stringify({
    $schema: './node_modules/@angular/cli/lib/config/schema.json', version: 1, newProjectRoot: '', projects: {
      app: { projectType: 'application', root: '', sourceRoot: 'src', architect: {
        build: { builder: '@angular-devkit/build-angular:application', options: { outputPath: 'dist/app', index: 'src/index.html', browser: 'src/main.ts', tsConfig: 'tsconfig.app.json', styles: [] } },
        serve: { builder: '@angular-devkit/build-angular:dev-server', options: { buildTarget: 'app:build' } },
      } },
    },
  }, null, 2),
  'tsconfig.json': JSON.stringify({ compileOnSave: false, compilerOptions: { strict: true, target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler', experimentalDecorators: true, skipLibCheck: true, esModuleInterop: true }, angularCompilerOptions: { strictTemplates: true } }, null, 2),
  'tsconfig.app.json': JSON.stringify({ extends: './tsconfig.json', compilerOptions: { outDir: './out-tsc/app' }, files: ['src/main.ts'] }, null, 2),
  'src/index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    <script src="https://cdn.tailwindcss.com"></script>
    ${PREVIEW_BRIDGE}
  </head>
  <body><app-root></app-root></body>
</html>
`,
  'src/main.ts': "import 'zone.js'\nimport { bootstrapApplication } from '@angular/platform-browser'\nimport { Component } from '@angular/core'\n\n@Component({\n  selector: 'app-root',\n  standalone: true,\n  template: '<div class=\"min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100\"><h1 class=\"text-3xl font-semibold\">Your Angular app starts here</h1></div>',\n})\nexport class AppComponent {}\n\nbootstrapApplication(AppComponent)\n",
}

const EXPRESS: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', private: true, scripts: { dev: 'node server.js', start: 'node server.js' }, dependencies: { express: '^4.21.0' } }, null, 2),
  'server.js': "const express = require('express')\nconst app = express()\napp.use(express.json())\n\napp.get('/api/hello', (_req, res) => res.json({ message: 'Hello from Express' }))\n\napp.use(express.static('public'))\nconst port = process.env.PORT || 3000\napp.listen(port, '0.0.0.0', () => console.log('listening on ' + port))\n",
  'public/index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    <script src="https://cdn.tailwindcss.com"></script>
    ${PREVIEW_BRIDGE}
  </head>
  <body>
    <div class="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
      <h1 class="text-3xl font-semibold">Your Express app starts here</h1>
    </div>
  </body>
</html>
`,
}

export const FRAMEWORKS: Record<FrameworkId, Framework> = {
  react: { id: 'react', label: 'React', deploy: 'puter', buildDirs: ['dist'], hint: 'React 18 + Vite + Tailwind v4 (preconfigured). This is the default stack the base instructions describe.', files: STARTER_FILES },
  vite: { id: 'vite', label: 'Vite (vanilla)', deploy: 'puter', buildDirs: ['dist'], hint: 'Vanilla Vite (no framework). Use plain DOM/JS modules. Tailwind is loaded via CDN in index.html.', files: VITE_VANILLA },
  vue: { id: 'vue', label: 'Vue', deploy: 'puter', buildDirs: ['dist'], hint: 'Vue 3 (SFCs) + Vite. Tailwind is loaded via CDN in index.html. Entry is src/main.js mounting src/App.vue.', files: VUE },
  svelte: { id: 'svelte', label: 'Svelte', deploy: 'puter', buildDirs: ['dist'], hint: 'Svelte 4 + Vite. Tailwind via CDN. Entry is src/main.js mounting src/App.svelte (classic `new App({ target })` API).', files: SVELTE },
  nextjs: { id: 'nextjs', label: 'Next.js', deploy: 'puter', buildDirs: ['out', '.next'], hint: 'Next.js (App Router) configured for STATIC EXPORT (output: "export"). Do NOT use server-only features (SSR, route handlers, server actions, ISR) — keep it fully static. Tailwind via CDN. Files are .js (no TS).', files: NEXTJS },
  nuxt: { id: 'nuxt', label: 'Nuxt', deploy: 'puter', buildDirs: ['.output/public', 'dist'], hint: 'Nuxt 3. `npm run build` runs `nuxt generate` (static site). Prefer static-friendly patterns; the head injects Tailwind via CDN.', files: NUXT },
  angular: { id: 'angular', label: 'Angular', deploy: 'puter', buildDirs: ['dist'], hint: 'Angular 17 (standalone APIs, application builder). Build output is under dist/app/browser. Tailwind via CDN in src/index.html.', files: ANGULAR },
  express: { id: 'express', label: 'Express (Node)', deploy: 'node', buildDirs: [], hint: 'Express (Node server). This is a BACKEND/SSR app — it needs a Node host (Vercel/Netlify/Render), NOT static hosting. Serve static files from public/ and add API routes in server.js. Listen on process.env.PORT || 3000.', files: EXPRESS },
}

export const FRAMEWORK_LIST: Framework[] = ['react', 'nextjs', 'vue', 'svelte', 'nuxt', 'angular', 'vite', 'express'].map((id) => FRAMEWORKS[id as FrameworkId])

export function getFramework(id?: string | null): Framework {
  return (id && FRAMEWORKS[id as FrameworkId]) || FRAMEWORKS.react
}
