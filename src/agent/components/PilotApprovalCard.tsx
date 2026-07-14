import React, { useEffect, useState } from 'react'
import { Check, Film, Image as ImageIcon, LoaderCircle, Play, RotateCcw, X } from 'lucide-react'
import { getAssetObjectUrl } from '@/lib/assets/assetStore'
import type { AgentApproval } from '@/agent/schemas/filmProjectSchemas'

const valueAsString = (value: unknown): string => typeof value === 'string' ? value : ''

const useAssetPreview = (assetId: string): string => {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true
    if (!assetId) {
      setUrl('')
      return () => { active = false }
    }
    void getAssetObjectUrl(assetId).then((nextUrl) => {
      if (active) setUrl(nextUrl || '')
    })
    return () => { active = false }
  }, [assetId])
  return url
}

export const PilotApprovalCard: React.FC<{
  approval: AgentApproval
  busy?: boolean
  onRun: (prompt: string) => void
  onApprove: () => void
  onRegenerate: (prompt: string) => void
  onReject: () => void
  onCancel: () => void
}> = ({ approval, busy, onRun, onApprove, onRegenerate, onReject, onCancel }) => {
  const stage = approval.payload.stage === 'review' ? 'review' : 'run'
  const kind = approval.payload.kind === 'video' ? 'video' : 'image'
  const [prompt, setPrompt] = useState(valueAsString(approval.payload.prompt))
  const assetId = valueAsString(approval.payload.assetId)
  const previewUrl = useAssetPreview(assetId)
  const referenceCount = Array.isArray(approval.payload.referenceAssetIds) ? approval.payload.referenceAssetIds.length : 0

  useEffect(() => setPrompt(valueAsString(approval.payload.prompt)), [approval.id, approval.payload.prompt])

  return (
    <div className="overflow-hidden rounded-2xl border border-[#7C5CFF]/25 bg-[#7C5CFF]/[0.055] shadow-[0_14px_38px_rgba(0,0,0,0.24)]">
      <div className="flex items-start gap-2.5 border-b border-white/[0.07] px-3.5 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#7C5CFF]/15 text-[#C8BCFF]">
          {kind === 'video' ? <Film className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-[10px] font-semibold text-white/82">{approval.title}</p>
            <span className="rounded-full bg-[#7C5CFF]/13 px-2 py-0.5 text-[7px] font-semibold uppercase tracking-[0.08em] text-[#C8BCFF]">{stage}</span>
          </div>
          <p className="mt-1 text-[8px] leading-3.5 text-white/36">{approval.description}</p>
        </div>
      </div>

      {stage === 'review' && (
        <div className="p-3.5 pb-0">
          <div className="flex min-h-[150px] items-center justify-center overflow-hidden rounded-xl bg-black/35">
            {previewUrl
              ? kind === 'video'
                ? <video src={previewUrl} controls preload="metadata" className="max-h-[260px] w-full bg-black object-contain" />
                : <img src={previewUrl} alt={`Pilot ${kind}`} className="max-h-[260px] w-full object-contain" />
              : <LoaderCircle className="h-5 w-5 animate-spin text-white/22" />}
          </div>
        </div>
      )}

      <div className="space-y-3 p-3.5">
        {stage === 'run' && (
          <div className="grid grid-cols-2 gap-1.5 text-[8px] text-white/38">
            <span className="truncate rounded-lg bg-black/20 px-2 py-1.5">{valueAsString(approval.payload.provider) || 'Provider'}</span>
            <span className="truncate rounded-lg bg-black/20 px-2 py-1.5">{valueAsString(approval.payload.model) || 'Default model'}</span>
            <span className="rounded-lg bg-black/20 px-2 py-1.5">{valueAsString(approval.payload.ratio) || 'Default ratio'}</span>
            <span className="rounded-lg bg-black/20 px-2 py-1.5">{referenceCount} refs · 1 job</span>
          </div>
        )}
        <label className="block">
          <span className="mb-1.5 block text-[8px] font-semibold uppercase tracking-[0.08em] text-white/28">Prompt</span>
          <textarea
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
            className="min-h-[92px] w-full resize-y rounded-xl border border-white/[0.08] bg-[#0E0E0E] px-3 py-2.5 text-[9px] leading-4 text-white/65 outline-none focus:border-[#7C5CFF]/45 disabled:opacity-45"
          />
        </label>
        {stage === 'run' ? (
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy || !prompt.trim()} onClick={() => onRun(prompt.trim())} className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#7C5CFF] text-[9px] font-semibold text-white hover:bg-[#8768FF] disabled:opacity-35">
              {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Run pilot {kind}
            </button>
            <button type="button" disabled={busy} onClick={onCancel} className="flex h-8 items-center gap-1.5 rounded-xl px-3 text-[9px] text-white/38 hover:bg-white/[0.05] hover:text-white/70 disabled:opacity-35"><X className="h-3.5 w-3.5" /> Cancel</button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={busy} onClick={onApprove} className="flex h-8 items-center justify-center gap-1.5 rounded-xl bg-[#7C5CFF] text-[9px] font-semibold text-white hover:bg-[#8768FF] disabled:opacity-35"><Check className="h-3.5 w-3.5" /> Approve {kind}</button>
            <button type="button" disabled={busy || !prompt.trim()} onClick={() => onRegenerate(prompt.trim())} className="flex h-8 items-center justify-center gap-1.5 rounded-xl bg-white/[0.055] text-[9px] font-medium text-white/58 hover:bg-white/[0.09] hover:text-white/82 disabled:opacity-35"><RotateCcw className="h-3.5 w-3.5" /> Regenerate</button>
            <button type="button" disabled={busy} onClick={onReject} className="col-span-2 flex h-7 items-center justify-center gap-1.5 rounded-lg text-[8px] text-red-200/48 hover:bg-red-500/[0.07] hover:text-red-200/72 disabled:opacity-35"><X className="h-3 w-3" /> Reject and keep asset cached</button>
          </div>
        )}
      </div>
    </div>
  )
}
