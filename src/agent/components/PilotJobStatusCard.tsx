import React from 'react'
import { CheckCircle2, LoaderCircle, OctagonX, StopCircle, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PilotJob } from '@/agent/stores/agentStore'

export const PilotJobStatusCard: React.FC<{ job: PilotJob; onCancel?: () => void }> = ({ job, onCancel }) => {
  const active = ['queued', 'running', 'waiting-output'].includes(job.status)
  const Icon = job.status === 'completed' ? CheckCircle2
    : job.status === 'failed' || job.status === 'interrupted' ? TriangleAlert
      : job.status === 'cancelled' ? OctagonX
        : LoaderCircle
  return (
    <div className="rounded-xl border border-white/[0.065] bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', active ? 'animate-spin text-[#B8A8FF]' : job.status === 'completed' ? 'text-emerald-300/75' : job.status === 'cancelled' ? 'text-white/28' : 'text-red-300/70')} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2"><p className="truncate text-[10px] font-semibold text-white/65">Pilot {job.kind} · attempt {job.attempt}</p><span className="text-[7px] uppercase tracking-[0.08em] text-white/26">{job.status}</span></div>
          {(job.outputAssetId || job.assetId) && <p className="mt-1 truncate text-[7px] text-emerald-200/42">Asset {job.outputAssetId || job.assetId}</p>}
          {job.error && <p className="mt-1 text-[10px] leading-4 text-red-200/58">{job.error}</p>}
        </div>
        {active && onCancel && <button type="button" title="Stop the active local pipeline. A remote provider request may continue." onClick={onCancel} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/28 hover:bg-white/[0.06] hover:text-white/65"><StopCircle className="h-3.5 w-3.5" /></button>}
      </div>
    </div>
  )
}
