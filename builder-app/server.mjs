// Minimal production static server that sets the cross-origin isolation headers
// WebContainer requires. Run `npm run build` then `npm start`.
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(__dirname, 'dist')
const app = express()

app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
})
app.use(express.static(dist))
// SPA fallback (Express 5: avoid '*' route — use a final middleware).
app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')))

const port = process.env.PORT || 4173
app.listen(port, () => console.log(`AI App Builder running on http://localhost:${port}`))
