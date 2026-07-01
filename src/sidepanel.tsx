import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { SidePanel } from '@/components/SidePanel'
import '~/style.css'

export default function SidePanelApp() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)

  return (
    <ReactFlowProvider>
      <SidePanel
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
      />
    </ReactFlowProvider>
  )
}

const container = document.getElementById('__plasmo')
if (container) {
  const root = createRoot(container)
  root.render(
    <React.StrictMode>
      <SidePanelApp />
    </React.StrictMode>
  )
}
