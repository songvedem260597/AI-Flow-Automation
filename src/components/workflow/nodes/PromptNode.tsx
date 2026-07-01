import React, { memo, useCallback } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { useWorkflowStore } from '@/stores/workflowStore'
import { FileText } from 'lucide-react'
import type { PromptNodeData } from '@/types'

export const PromptNode: React.FC<NodeProps> = memo(({ id, data, selected }) => {
  const updateNode = useWorkflowStore((s) => s.updateNode)
  const nodeData = data as unknown as PromptNodeData

  const handleChange = useCallback((field: string, value: unknown) => {
    updateNode(id, { [field]: value })
  }, [id, updateNode])

  return (
    <div
      className={cn(
        'group relative min-w-[220px] bg-[#1A1A1A] rounded-2xl border transition-all duration-150',
        selected
          ? 'border-[#7C5CFF] shadow-[0_0_0_2px_rgba(124,92,255,0.3)]'
          : 'border-white/[0.06] hover:border-white/10',
        nodeData.provider === 'chatgpt' && 'border-l-2 border-l-sky-400',
        nodeData.provider === 'google-flow' && 'border-l-2 border-l-blue-400',
        nodeData.provider === 'grok' && 'border-l-2 border-l-orange-400'
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-white/[0.06]">
        <div className="w-7 h-7 rounded-lg bg-sky-500/10 flex items-center justify-center flex-shrink-0">
          <FileText className="w-3.5 h-3.5 text-sky-400" />
        </div>
        <div className="flex-1 min-w-0">
          <input
            value={nodeData.label || 'Prompt'}
            onChange={(e) => handleChange('label', e.target.value)}
            className="w-full bg-transparent text-xs font-medium text-white/80 outline-none truncate"
            placeholder="Node name..."
          />
        </div>
        <div className={cn(
          'text-[9px] px-1.5 py-0.5 rounded-md font-medium uppercase tracking-wider',
          nodeData.provider === 'chatgpt' && 'bg-sky-500/10 text-sky-400',
          nodeData.provider === 'google-flow' && 'bg-blue-500/10 text-blue-400',
          nodeData.provider === 'grok' && 'bg-orange-500/10 text-orange-400'
        )}>
          {nodeData.provider === 'google-flow' ? 'Flow' : nodeData.provider}
        </div>
      </div>

      {/* Body */}
      <div className="px-3.5 py-3">
        <textarea
          value={nodeData.prompt || ''}
          onChange={(e) => handleChange('prompt', e.target.value)}
          rows={3}
          className="w-full bg-[#141414] rounded-xl px-3 py-2 text-xs text-white/60 outline-none resize-none placeholder:text-white/20 focus:ring-1 focus:ring-white/10 transition-all"
          placeholder="Enter your prompt..."
        />
        {nodeData.model && (
          <div className="mt-2 flex items-center gap-1.5 px-2 py-1 bg-[#141414] rounded-lg">
            <span className="text-[10px] text-white/25">Model</span>
            <span className="text-[10px] text-sky-400 font-mono">{nodeData.model}</span>
          </div>
        )}
      </div>

      {/* Handles */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-[#1A1A1A] !border-2 !border-[#7C5CFF] !-left-1.5"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-[#1A1A1A] !border-2 !border-[#7C5CFF] !-right-1.5"
      />
    </div>
  )
})

PromptNode.displayName = 'PromptNode'
