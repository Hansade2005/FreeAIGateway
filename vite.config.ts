import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The builder runs WebContainer, so it must be cross-origin isolated (COOP +
// COEP) EVERYWHERE — except the /deploy page, which needs popup auth for Puter
// and therefore must NOT be isolated. So the headers are scoped to skip /deploy.
const setCoi = (res: any) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
}
const isDeploy = (url: string) => url === '/deploy' || url.startsWith('/deploy.html') || url.startsWith('/deploy?')
const mw = (req: any, res: any, next: any) => {
  const url: string = req.url || ''
  if (!isDeploy(url)) setCoi(res)
  if (url === '/deploy' || url.startsWith('/deploy?')) req.url = '/deploy.html' // clean URL in dev/preview
  next()
}
const coi = () => ({
  name: 'coi-headers',
  configureServer(server: any) { server.middlewares.use(mw) },
  configurePreviewServer(server: any) { server.middlewares.use(mw) },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), coi()],
  server: { host: true },
  preview: { host: true },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        deploy: path.resolve(__dirname, 'deploy.html'),
      },
    },
  },
})
