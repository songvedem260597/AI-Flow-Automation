import React, { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { Pause } from 'lucide-react'

export const WaitNode: React.FC<NodeProps> = memo(({ data, selected }) => {
  const waitData = data as unknown as { condition?: string; timeout?: number; label?: string }

  return (
    <div
      className={cn(
        'group relative min-w-[140px] bg-[#1A1A1A] rounded-2xl border border-l-2 border-l-amber-400 transition-all duration-150',
        selected
          ? 'border-[#7C5CFF] shadow-[0_0_0_2px_rgba(124,92,255,0.3)]'
          : 'border-white/[0.06] hover:border-white/10'
      )}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center">
          <Pause className="w-3.5 h-3.5 text-amber-400" />
        </div>
        <div className="flex-1">
          <span className="text-xs font-medium text-white/80">{waitData.label || 'Wait'}</span>
        </div>
      </div>

      <div className="px-3.5 pb-3">
        <span className="text-[10px] text-white/30 capitalize">
          {waitData.condition?.replace('-', ' ') || 'DOM change'}
        </span>
      </div>

      <Handle type="target" position={Position.Left} className="!w-2.5 !h-2.5 !bg-[#1A1A1A] !border-2 !border-[#7C5CFF] !-left-1.5" />
      <Handle type="source" position={Position.Right} className="!w-2.5 !h-2.5 !bg-[#1A1A1A] !border-2 !border-[#7C5CFF] !-right-1.5" />
    </div>
  )
})

WaitNode.displayName = 'WaitNode'
