import React, { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { Zap } from 'lucide-react'

export const GenerateNode: React.FC<NodeProps> = memo(({ id, data, selected }) => {
  const genData = data as unknown as { label?: string; autoGenerate?: boolean; waitForCompletion?: boolean; provider?: string }

  return (
    <div
      className={cn(
        'group relative min-w-[180px] bg-[#1A1A1A] rounded-2xl border border-l-2 border-l-emerald-400 transition-all duration-150',
        selected
          ? 'border-[#7C5CFF] shadow-[0_0_0_2px_rgba(124,92,255,0.3)]'
          : 'border-white/[0.06] hover:border-white/10'
      )}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
          <Zap className="w-3.5 h-3.5 text-emerald-400" />
        </div>
        <div className="flex-1">
          <span className="text-xs font-medium text-white/80">{genData.label || 'Generate'}</span>
        </div>
        <div className={cn(
          'w-1.5 h-1.5 rounded-full',
          genData.autoGenerate !== false ? 'bg-emerald-400 animate-pulse' : 'bg-white/20'
        )} />
      </div>

      {(genData.autoGenerate || genData.waitForCompletion) && (
        <div className="px-3.5 pb-3 flex items-center gap-2">
          {genData.autoGenerate !== false && (
            <span className="text-[10px] text-emerald-400/60 bg-emerald-500/10 px-1.5 py-0.5 rounded-md">Auto</span>
          )}
          {genData.waitForCompletion && (
            <span className="text-[10px] text-emerald-400/60 bg-emerald-500/10 px-1.5 py-0.5 rounded-md">Wait</span>
          )}
        </div>
      )}

      <Handle type="target" position={Position.Left} className="!w-2.5 !h-2.5 !bg-[#1A1A1A] !border-2 !border-[#7C5CFF] !-left-1.5" />
      <Handle type="source" position={Position.Right} className="!w-2.5 !h-2.5 !bg-[#1A1A1A] !border-2 !border-[#7C5CFF] !-right-1.5" />
    </div>
  )
})

GenerateNode.displayName = 'GenerateNode'
