import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// @solana/web3.js and several wallet adapters assume Node's Buffer/global
// exist; the browser doesn't provide them, so polyfill before anything else.
window.Buffer = window.Buffer ?? Buffer

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
