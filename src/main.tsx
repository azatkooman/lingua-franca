import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Applies the saved light/dark choice before the first render, so the page never flashes.
import './lib/theme'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
