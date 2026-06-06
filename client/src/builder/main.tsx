import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { BuilderSpike } from './BuilderSpike'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BuilderSpike />
  </StrictMode>,
)
