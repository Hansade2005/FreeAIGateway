// Minimal production static server. Sets the cross-origin isolation headers
// WebContainer requires on every route EXCEPT /deploy (which needs popup auth
// for Puter and must NOT be isolated). Run `npm run build` then `npm start`.
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(__dirname, 'dist')
const app = express()

const isDeploy = (p) => p === '/deploy' || p.startsWith('/deploy.html')
app.use((req, res, next) => {
  if (!isDeploy(req.path)) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  }
  next()
})

// Clean URL for the (non-isolated) deploy page.
app.get('/deploy', (_req, res) => res.sendFile(path.join(dist, 'deploy.html')))
app.use(express.static(dist))
// SPA fallback (Express 5: avoid '*' route — use a final middleware).
app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')))

const port = process.env.PORT || 4173
app.listen(port, () => console.log(`AI App Builder running on http://localhost:${port}`))
