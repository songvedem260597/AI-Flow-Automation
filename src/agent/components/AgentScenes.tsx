import React, { useEffect, useMemo, useState } from 'react'
import { Check, Clapperboard, Film, Image as ImageIcon, LocateFixed, RotateCcw, X } from 'lucide-react'
import { getAssetObjectUrl } from '@/lib/assets/assetStore'
import type { AgentApproval, FilmProject, FilmShot } from '@/agent/schemas/filmProjectSchemas'

const useShotPreviews = (shot: FilmShot): { imageUrl: string; videoUrl: string } => {
  const [previews, setPreviews] = useState({ imageUrl: '', videoUrl: '' })
  useEffect(() => {
    let active = true
    void Promise.all([
      shot.imageAssetId ? getAssetObjectUrl(shot.imageAssetId) : Promise.resolve(null),
      shot.videoAssetId ? getAssetObjectUrl(shot.videoAssetId) : Promise.resolve(null),
    ]).then(([imageUrl, videoUrl]) => {
      if (active) setPreviews({ imageUrl: imageUrl || '', videoUrl: videoUrl || '' })
    })
    return () => { active = false }
  }, [shot.imageAssetId, shot.videoAssetId])
  return previews
}

const ShotCard: React.FC<{
  shot: FilmShot
  reviewApproval?: AgentApproval
  busy?: boolean
  onViewNode?: (nodeId: string) => void
  onApprove?: (approvalId: string) => void
  onRegenerate?: (approvalId: string, prompt: string) => void
  onReject?: (approvalId: string) => void
  retryKind?: 'image' | 'video'
  onPrepareRetry?: (shotId: string, kind: 'image' | 'video') => void
}> = ({ shot, reviewApproval, busy, onViewNode, onApprove, onRegenerate, onReject, retryKind, onPrepareRetry }) => {
  const previews = useShotPreviews(shot)
  const reviewKind = reviewApproval?.payload.kind === 'video' ? 'video' : 'image'
  const prompt = typeof reviewApproval?.payload.prompt === 'string' ? reviewApproval.payload.prompt : ''
  return (
    <div className="overflow-hidden rounded-xl bg-[#0F0F0F]">
      {(previews.imageUrl || previews.videoUrl) && (
        <div className="grid max-h-[180px] grid-cols-2 gap-px bg-white/[0.06]">
          {previews.imageUrl && <div className="relative min-h-[120px] bg-black"><img src={previews.imageUrl} alt={`${shot.id} image`} className="h-full max-h-[180px] w-full object-cover" /><span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[7px] text-white/65"><ImageIcon className="mr-1 inline h-2.5 w-2.5" />Image</span></div>}
          {previews.videoUrl && <div className="relative min-h-[120px] bg-black"><video src={previews.videoUrl} muted preload="metadata" className="h-full max-h-[180px] w-full object-cover" /><span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[7px] text-white/65"><Film className="mr-1 inline h-2.5 w-2.5" />Video</span></div>}
        </div>
      )}
      <div className="px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><span className="text-[10px] font-semibold text-[#C8BCFF]">{shot.id}</span><span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[7px] text-white/28">{shot.durationSec}s</span><span className="text-[7px] text-white/24">Image {shot.imageAttempt} · Video {shot.videoAttempt}</span></div>
            <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-white/42">{shot.description}</p>
          </div>
          <span className="shrink-0 rounded-full bg-[#7C5CFF]/10 px-2 py-1 text-[7px] text-[#B8A8FF]/70">{shot.status}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {shot.workflowNodeIds.length > 0 && onViewNode && <button type="button" onClick={() => onViewNode(shot.workflowNodeIds[0])} className="flex h-6 items-center gap-1.5 rounded-lg px-1.5 text-[10px] font-medium text-white/30 hover:bg-white/[0.04] hover:text-[#C8BCFF]"><LocateFixed className="h-3 w-3" /> View on canvas</button>}
          {reviewApproval && onApprove && onRegenerate && onReject && (
            <>
              <button type="button" disabled={busy} onClick={() => onApprove(reviewApproval.id)} className="flex h-6 items-center gap-1 rounded-lg bg-[#7C5CFF]/16 px-2 text-[10px] font-semibold text-[#C8BCFF] hover:bg-[#7C5CFF]/24 disabled:opacity-35"><Check className="h-3 w-3" /> Approve {reviewKind}</button>
              <button type="button" disabled={busy} onClick={() => onRegenerate(reviewApproval.id, prompt)} className="flex h-6 items-center gap-1 rounded-lg px-2 text-[10px] text-white/34 hover:bg-white/[0.05] hover:text-white/68 disabled:opacity-35"><RotateCcw className="h-3 w-3" /> Regenerate</button>
              <button type="button" disabled={busy} title="Reject and keep cached" onClick={() => onReject(reviewApproval.id)} className="flex h-6 w-6 items-center justify-center rounded-lg text-red-200/34 hover:bg-red-500/[0.07] hover:text-red-200/68 disabled:opacity-35"><X className="h-3 w-3" /></button>
            </>
          )}
          {!reviewApproval && retryKind && onPrepareRetry && <button type="button" disabled={busy} onClick={() => onPrepareRetry(shot.id, retryKind)} className="flex h-6 items-center gap-1 rounded-lg bg-amber-300/[0.07] px-2 text-[10px] font-medium text-amber-100/55 hover:bg-amber-300/[0.11] hover:text-amber-100/75 disabled:opacity-35"><RotateCcw className="h-3 w-3" /> Prepare {retryKind} retry</button>}
        </div>
      </div>
    </div>
  )
}

export const AgentScenes: React.FC<{
  project: FilmProject | null
  busyApprovalId?: string | null
  onViewNode?: (nodeId: string) => void
  onApprove?: (approvalId: string) => void
  onRegenerate?: (approvalId: string, prompt: string) => void
  onReject?: (approvalId: string) => void
  onPrepareRetry?: (shotId: string, kind: 'image' | 'video') => void
}> = ({ project, busyApprovalId, onViewNode, onApprove, onRegenerate, onReject, onPrepareRetry }) => {
  const pendingReviewByShot = useMemo(() => new Map((project?.approvals || [])
    .filter((approval) => approval.status === 'pending' && approval.payload.stage === 'review')
    .map((approval) => [String(approval.payload.shotId || ''), approval])), [project?.approvals])
  if (!project || project.scenes.length === 0) return <div className="flex h-full flex-col items-center justify-center px-8 text-center"><Clapperboard className="h-6 w-6 text-white/18" /><p className="mt-3 text-[11px] font-medium text-white/52">No scenes yet</p><p className="mt-1 text-[9px] leading-4 text-white/28">Structured scene and shot cards appear after planning.</p></div>
  const shotsById = new Map(project.shots.map((shot) => [shot.id, shot]))
  const hasPendingApproval = (shotId: string): boolean => project.approvals.some((approval) => approval.status === 'pending' && approval.payload.shotId === shotId)
  const retryKindForShot = (shotId: string): 'image' | 'video' | undefined => {
    if (hasPendingApproval(shotId)) return undefined
    const interrupted = project.tasks.find((task) => task.shotId === shotId && (task.status === 'failed' || task.status === 'interrupted'))
    if (interrupted?.type === 'pilot-video') return 'video'
    if (interrupted?.type === 'pilot-image') return 'image'
    return undefined
  }
  return <div className="space-y-3 p-4">{[...project.scenes].sort((a, b) => a.order - b.order).map((scene) => <section key={scene.id} className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.018]"><div className="border-b border-white/[0.06] px-3.5 py-3"><div className="flex items-center justify-between"><h3 className="text-[10px] font-semibold text-white/72">{String(scene.order).padStart(2, '0')} · {scene.title}</h3><span className="text-[8px] text-white/24">{scene.shotIds.length} shots</span></div><p className="mt-1.5 text-[10px] leading-4 text-white/32">{scene.summary}</p></div><div className="space-y-1.5 p-2">{scene.shotIds.map((shotId) => shotsById.get(shotId)).filter(Boolean).map((shot) => shot && <ShotCard key={shot.id} shot={shot} reviewApproval={pendingReviewByShot.get(shot.id)} busy={busyApprovalId === pendingReviewByShot.get(shot.id)?.id} onViewNode={onViewNode} onApprove={onApprove} onRegenerate={onRegenerate} onReject={onReject} retryKind={retryKindForShot(shot.id)} onPrepareRetry={onPrepareRetry} />)}</div></section>)}</div>
}
