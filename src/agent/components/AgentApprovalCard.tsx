import React from 'react'
import { GitBranchPlus, ShieldCheck, X } from 'lucide-react'
import type { WorkflowPatch } from '@/agent/schemas/agentToolSchemas'

export const AgentApprovalCard: React.FC<{
  patch: WorkflowPatch
  onApply: () => void
  onReject: () => void
  applying?: boolean
}> = ({ patch, onApply, onReject, applying }) => (
  <div className="rounded-2xl border border-[#7C5CFF]/25 bg-[#7C5CFF]/[0.06] p-3.5 shadow-[0_12px_34px_rgba(0,0,0,0.2)]">
    <div className="flex items-start gap-2.5"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#7C5CFF]/15 text-[#C8BCFF]"><GitBranchPlus className="h-4 w-4" /></span><div className="min-w-0"><p className="text-[10px] font-semibold text-white/78">Workflow proposal</p><p className="mt-1 text-[8px] leading-3.5 text-white/38">{patch.summary}</p></div></div>
    <div className="mt-3 grid grid-cols-2 gap-1.5 text-[8px] text-white/42"><div className="rounded-lg bg-black/20 px-2 py-1.5">+ {patch.addNodes.length} nodes</div><div className="rounded-lg bg-black/20 px-2 py-1.5">+ {patch.addEdges.length} connections</div>{patch.updateNodes.length > 0 && <div className="rounded-lg bg-black/20 px-2 py-1.5">~ {patch.updateNodes.length} updates</div>}{(patch.deleteNodeIds.length + patch.deleteEdgeIds.length) > 0 && <div className="rounded-lg bg-red-500/[0.06] px-2 py-1.5 text-red-200/55">− {patch.deleteNodeIds.length + patch.deleteEdgeIds.length} removals</div>}</div>
    <div className="mt-3 flex items-center gap-2"><button type="button" disabled={applying} onClick={onApply} className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#7C5CFF] text-[9px] font-semibold text-white hover:bg-[#8768FF] disabled:opacity-40"><ShieldCheck className="h-3.5 w-3.5" /> Apply changes</button><button type="button" disabled={applying} onClick={onReject} className="flex h-8 items-center justify-center gap-1.5 rounded-xl px-3 text-[9px] font-medium text-white/38 hover:bg-white/[0.05] hover:text-white/68"><X className="h-3.5 w-3.5" /> Reject</button></div>
  </div>
)
