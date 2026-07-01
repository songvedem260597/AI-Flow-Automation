import React from 'react'
import { WorkflowEditorWindow } from '@/components/workflow/WorkflowEditor'
import '~/style.css'

export default function WorkflowEditorTab() {
  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0F0F0F]">
      <WorkflowEditorWindow />
    </div>
  )
}
