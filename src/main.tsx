import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { bootstrap } from '@/data/store'
import { initPush } from '@/integrations/push'
import App from './App'
import './index.css'

void initPush()

const root = createRoot(document.getElementById('root') as HTMLElement)

root.render(
  <div className="grid min-h-dvh place-items-center">
    <img src="/logo.webp" alt="Abrindo" width={120} height={120} className="rounded-3xl" />
  </div>,
)

// Deixa a tela de abertura pintar antes do trabalho pesado do primeiro acesso.
setTimeout(() => {
  void bootstrap().then(() => {
    root.render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>,
    )
  })
}, 30)
