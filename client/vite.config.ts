import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// The /builder entry must be cross-origin isolated (COOP+COEP) so WebContainer
// can run. These headers are scoped to the builder document only — applied in
// dev via this plugin, in prod by the Express route — so the rest of the
// dashboard is unaffected.
const builderCoiHeaders = () => ({
  name: 'builder-coi-headers',
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      const url: string = req.url || ''
      if (url === '/builder' || url.startsWith('/builder.html') || url.startsWith('/src/builder/')) {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
      }
      if (url === '/builder') req.url = '/builder.html' // clean URL in dev
      next()
    })
  },
})

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const serverPort = env.PORT ?? process.env.PORT ?? 3001

  return {
    plugins: [react(), tailwindcss(), builderCoiHeaders()],
    base: process.env.VITE_BASE ?? '/',
    envDir: path.resolve(__dirname, '..'),
    define: {
      __SERVER_PORT__: JSON.stringify(String(serverPort)),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      rollupOptions: {
        // Multi-page: the SPA (index.html) + the isolated builder entry.
        input: {
          main: path.resolve(__dirname, 'index.html'),
          builder: path.resolve(__dirname, 'builder.html'),
        },
      },
    },
    server: {
      proxy: {
        // Force IPv4 — on Windows + Node 17+, `localhost` resolves to ::1 first,
        // which can collide with wslrelay / Docker Desktop listeners on the same port.
        '/api': `http://127.0.0.1:${serverPort}`,
        '/v1': `http://127.0.0.1:${serverPort}`,
      },
    },
  }
})
