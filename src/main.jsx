import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { registerServiceWorker, markStandalone, watchInstallPrompt } from './lib/pwa.js'
import './styles.css'

// Must run before render so CSS sees the standalone flag on the first paint.
markStandalone()
watchInstallPrompt()
registerServiceWorker()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
