import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initTooltips } from './tooltip'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// Position the data-tip tooltips as a fixed layer so they escape the table's scroll clip.
initTooltips()
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
