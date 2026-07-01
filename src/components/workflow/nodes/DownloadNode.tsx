import React, { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { Download } from 'lucide-react'

export const DownloadNode: React.FC<NodeProps> = memo(({ data, selected }) => {
  const dlData = data as unknown as { format?: string; autoDownload?: boolean; label?: string }

  return (
    <div
      className={cn(
        'group relative min-w-[160px] bg-[#1A1A1A] rounded-2xl border border-l-2 border-l-emerald-400 transition-all duration-150',
        selected
          ? 'border-[#7C5CFF] shadow-[0_0_0_2px_rgba(124,92,255,0.3)]'
          : 'border-white/[0.06] hover:border-white/10'
      )}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
          <Download className="w-3.5 h-3.5 text-emerald-400" />
        </div>
        <div className="flex-1">
          <span className="text-xs font-medium text-white/80">{dlData.label || 'Download'}</span>
        </div>
        <span className="text-[10px] font-bold text-emerald-400 uppercase bg-emerald-500/10 px-1.5 py-0.5 rounded-md">
          {dlData.format || 'png'}
        </span>
      </div>

      <Handle type="target" position={Position.Left} className="!w-2.5 !h-2.5 !bg-[#1A1A1A] !border-2 !border-[#7C5CFF] !-left-1.5" />
      <Handle type="source" position={Position.Right} className="!w-2.5 !h-2.5 !bg-[#1A1A1A] !border-2 !border-[#7C5CFF] !-right-1.5" />
    </div>
  )
})

DownloadNode.displayName = 'DownloadNode'
