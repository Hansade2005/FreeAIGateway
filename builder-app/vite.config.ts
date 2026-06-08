import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The whole app is the builder, which runs WebContainer — so it must be
// cross-origin isolated (COOP + COEP) everywhere, in dev AND preview.
const setCoi = (res: any) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
}
const coi = () => ({
  name: 'coi-headers',
  configureServer(server: any) { server.middlewares.use((_req: any, res: any, next: any) => { setCoi(res); next() }) },
  configurePreviewServer(server: any) { server.middlewares.use((_req: any, res: any, next: any) => { setCoi(res); next() }) },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), coi()],
  server: { host: true },
  preview: { host: true },
})
