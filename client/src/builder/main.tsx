import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { Builder } from './Builder'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Builder />
  </StrictMode>,
)
