import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Select from '@radix-ui/react-select'
import Drawflow from '@/lib/drawflow/drawflow.min.js'
import '@/lib/drawflow/drawflow.min.css'
import { autoUpdate, computePosition, offset, shift } from '@floating-ui/dom'
import { useWorkflowStore } from '@/stores/workflowStore'
import { canvasLog } from '@/lib/canvasInvestigate'
import { cn, formatDate, usePersistedState } from '@/lib/utils'
import type { AIProvider, FlowNodeData, FlowNodeType, FlowVideoMode, Workflow, WorkflowEdge, WorkflowNode } from '@/types'
import {
  ArrowLeft,
  BookmarkPlus,
  BookOpen,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Film,
  FileDown,
  FileText,
  FolderOpen,
  Image,
  LayoutTemplate,
  List,
  LoaderCircle,
  Maximize2,
  MessagesSquare,
  PanelLeft,
  PanelLeftClose,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Save,
  Send,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Workflow as WorkflowIcon,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2,
  Settings2,
  HardDrive
} from 'lucide-react'
import { runPipeline, stopPipeline, pausePipeline, resumePipeline } from '@/pipeline'
import type { PipelineCallbacks } from '@/pipeline'
import { usePipelineStore } from '@/stores/pipelineStore'
import { debugLog, debugWarn } from '@/lib/debug'
import {
  loadPromptAssistantApiModels,
  promptAssistantProviderLabel,
  runPromptAssistant,
  selectPromptAssistantApiModel,
  type PromptAssistantApiConfig,
  type PromptAssistantApiModel,
  type PromptAssistantMediaUpload,
  type PromptAssistantProvider,
} from '@/lib/promptAssistant'
import { useSettingsStore } from '@/stores/settingsStore'
import {
  EMPTY_VIDEO_AGENT_SKILL_LIBRARY,
  loadVideoAgentSkillLibrary,
  saveVideoAgentSkillLibrary,
  type VideoAgentSkill,
  type VideoAgentSkillLibrary,
} from '@/lib/videoAgentSkills'
import {
  createVideoAgentConversation,
  loadVideoAgentConversationState,
  saveVideoAgentConversation,
  setActiveVideoAgentConversation,
  type VideoAgentConversation,
  type VideoAgentConversationMessage,
} from '@/lib/videoAgentConversations'

/**
 * [WorkflowRun][probe] Investigation-only source probe.
 *
 * Enabled by `localStorage.AI_FLOW_DEBUG_RUN_SOURCE === '1'`.
 * Default verbosity is OFF — without the flag, this function
 * returns synchronously and never touches `console`.
 *
 * The probe exists to answer "who called `runPipeline` even though
 * the user did not click Run?" — see the ignoredDuplicate log
 * investigation. Each call site declares its own label so we can
 * tell toolbar-button / canvas-menu / single-node / dashboard-run
 * / import-open / template-use / hydration apart in the console.
 */
const WORKFLOW_RUN_SOURCE_PROBE: boolean =
  typeof localStorage !== 'undefined'
  && localStorage.getItem('AI_FLOW_DEBUG_RUN_SOURCE') === '1'

type RunSource =
  | 'toolbar-button'
  | 'single-node-canvas'
  | 'dashboard-quick-run'
  | 'runner-entry'
  | 'unknown'

const probeRunRequest = (source: RunSource, workflowId: string, extras: Record<string, unknown> = {}): void => {
  if (!WORKFLOW_RUN_SOURCE_PROBE) return
  // eslint-disable-next-line no-console
  console.log('[WorkflowRun][request]', {
    source,
    workflowId,
    activeWorkflowId: useWorkflowStore.getState().activeWorkflowId,
    pipelineStoreIsRunning: usePipelineStore.getState().isRunning,
    timestamp: Date.now(),
    ...extras
  })
  // eslint-disable-next-line no-console
  console.trace('[WorkflowRun][request.trace]', source)
}

const probeRunnerState = (
  event: 'create' | 'enter-guard' | 'ignored-duplicate' | 'start' | 'finish' | 'error' | 'cancel' | 'cleanup',
  payload: Record<string, unknown>
): void => {
  if (!WORKFLOW_RUN_SOURCE_PROBE) return
  // eslint-disable-next-line no-console
  console.log('[WorkflowRun][runnerState]', { event, ...payload })
}
import {
  saveAssetFromFile,
  saveAssetFromBlob,
  getAssetBlob,
  getAssetObjectUrl,
  revokeAssetObjectUrl,
  revokeAllAssetObjectUrls,
  type AssetKind,
  type AssetMeta
} from '@/lib/assets/assetStore'
import { cacheGenerateOutputs } from '@/lib/assets/outputAssetCache'
import { migrateLegacyWorkflowAssets } from '@/lib/assets/assetMigration'
import {
  exportWorkflowAssetBundle,
  importWorkflowAssetBundle,
  parseWorkflowAssetBundle
} from '@/lib/assets/assetBundle'
import {
  listAssetUsage,
  findOrphanAssets,
  deleteAssetsById,
  getAssetStorageEstimate,
  isOrphanReportFresh,
  RECENT_ASSET_GRACE_MS,
  type AssetUsageReport,
  type OrphanAssetReport
} from '@/lib/assets/assetGc'
import {
  applyNodePreviews,
  categorizeSavedTemplate,
  deleteWorkflowTemplate,
  extractImageNodePreviews,
  extractWorkflowThumbnailWithSource,
  generateUniqueTemplateName,
  listWorkflowTemplates,
  onWorkflowTemplatesChanged,
  resolveTemplateCardThumbnail,
  sanitizeWorkflowForTemplate,
  saveWorkflowTemplate,
  type UserWorkflowTemplate
} from '@/lib/workflowTemplates'

const WORKFLOW_PERSIST_DEBUG = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('AI_FLOW_DEBUG_PERSIST') === '1'
  } catch {
    return false
  }
}

// [WorkflowList] Diagnostic logs gated behind `AI_FLOW_DEBUG` to confirm
// the stable sort policy at runtime (render order, sort policy, and any
// time a workflow reorder would have shifted cards around).
const WORKFLOW_LIST_DEBUG = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('AI_FLOW_DEBUG') === '1'
  } catch {
    return false
  }
}

// [WorkflowSelection] Debug channel used by the canvas selection /
// highlight pipeline. Gated behind `AI_FLOW_DEBUG` so it stays silent
// in normal runs. Prefix is greppable as `[WorkflowSelection]` so the
// entire selection lifecycle can be reconstructed from a single browser
// session without enabling the broader CanvasInvestigate flags.
const WORKFLOW_SELECTION_DEBUG = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('AI_FLOW_DEBUG') === '1'
  } catch {
    return false
  }
}

const wfSelectionLog = (event: string, payload: Record<string, unknown> = {}): void => {
  if (!WORKFLOW_SELECTION_DEBUG()) return
  // Verbose level — Chrome DevTools hides this by default.
  // Per-frame pointerdown inspect logs and selection sync logs
  // stay out of production consoles unless the user explicitly
  // enables the `Verbose` filter.
  try {
    // eslint-disable-next-line no-console
    console.debug(`[WorkflowSelection][${event}]`, JSON.stringify(payload))
  } catch {
    // Never let debug logging throw into runtime.
  }
}

const SUPPORTED_NODE_TYPES: FlowNodeType[] = [
  'prompt',
  'image',
  'generate',
  'delay',
  'download',
  'wait',
  'condition',
  'loop',
  'merge',
  'split'
]

const NODE_CATEGORIES = [
  {
    label: 'Input',
    color: 'text-[#B8A8FF]',
    nodes: [
      { type: 'prompt' as FlowNodeType, label: 'Prompt', icon: <FileText className="h-4 w-4" />, color: 'sky' },
      { type: 'image' as FlowNodeType, label: 'Media', icon: <Image className="h-4 w-4" />, color: 'sky' }
    ]
  },
  {
    label: 'Action',
    color: 'text-[#B8A8FF]',
    nodes: [
      { type: 'generate' as FlowNodeType, label: 'Generate', icon: <Zap className="h-4 w-4" />, color: 'emerald' },
      { type: 'download' as FlowNodeType, label: 'Download', icon: <Download className="h-4 w-4" />, color: 'emerald' }
    ]
  },
  {
    label: 'Utility',
    color: 'text-white/45',
    nodes: [
      { type: 'delay' as FlowNodeType, label: 'Delay', icon: <Clock className="h-4 w-4" />, color: 'amber' },
      { type: 'wait' as FlowNodeType, label: 'Wait', icon: <Pause className="h-4 w-4" />, color: 'amber' }
    ]
  }
]

const NODE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  sky: { bg: 'bg-[#7C5CFF]/10', border: 'border-l-[#7C5CFF]', text: 'text-[#B8A8FF]' },
  emerald: { bg: 'bg-[#7C5CFF]/10', border: 'border-l-[#7C5CFF]', text: 'text-[#B8A8FF]' },
  amber: { bg: 'bg-white/[0.04]', border: 'border-l-white/20', text: 'text-white/45' },
  rose: { bg: 'bg-[#7C5CFF]/10', border: 'border-l-[#7C5CFF]', text: 'text-[#B8A8FF]' }
}

const NODE_DESCRIPTIONS: Partial<Record<FlowNodeType, string>> = {
  prompt: 'Write or reuse prompt text',
  image: 'Upload image or video media',
  generate: 'Generate media from inputs',
  download: 'Save generated output',
  delay: 'Pause before next step',
  wait: 'Wait for a manual condition'
}

const PROVIDER_OPTIONS: Array<{ value: AIProvider; label: string }> = [
  { value: 'google-flow', label: 'Google Flow' },
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'grok', label: 'Grok' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'claude', label: 'Claude' }
]

const ASPECT_RATIO_OPTIONS = ['1:1', '16:9', '9:16', '4:3', '3:4', 'custom']
const GENERATE_IMAGE_RATIO_OPTIONS = ['1:1', '16:9', '9:16', '4:3', '3:4']
const GENERATE_VIDEO_RATIO_OPTIONS = ['16:9', '9:16']
const GENERATE_MEDIA_TYPE_OPTIONS = [
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' }
]
// Google Flow Video only — maps to the in-popup "Khung hình / Thành phần"
// segmented control (trigger id suffixes VIDEO_FRAMES / VIDEO_REFERENCES).
// Flow's current default is 'ingredient'; ordering here mirrors that.
const FLOW_VIDEO_MODE_OPTIONS: Array<{ value: FlowVideoMode; label: string }> = [
  { value: 'ingredient', label: 'Thành phần' },
  { value: 'frame', label: 'Khung hình' }
]
const FLOW_VIDEO_MODE_VALUES = FLOW_VIDEO_MODE_OPTIONS.map((opt) => opt.value)
const GENERATE_QUANTITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '1', label: 'x1' },
  { value: '2', label: 'x2' },
  { value: '3', label: 'x3' },
  { value: '4', label: 'x4' }
]
const GENERATE_RESOLUTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '1k', label: '1K' },
  { value: '2k', label: '2K' },
  { value: '4k', label: '4K' }
]
const GENERATE_DEFAULT_RESOLUTION = '1k'
const GOOGLE_FLOW_IMAGE_MODEL_OPTIONS = ['Nano Banana Pro', 'Nano Banana 2', 'Nano Banana 2 Lite']
const GOOGLE_FLOW_VIDEO_MODEL_OPTIONS = [
  'Omni Flash',
  'Veo 3.1 - Lite',
  'Veo 3.1 - Fast',
  'Veo 3.1 - Quality',
  'Veo 3.1 - Lite [Lower Priority]'
]
const GOOGLE_FLOW_DEFAULT_IMAGE_MODEL = 'Nano Banana 2'
const GOOGLE_FLOW_DEFAULT_VIDEO_MODEL = 'Omni Flash'
const VIDEO_DURATION_OPTIONS = ['4s', '6s', '8s']
const OMNI_FLASH_VIDEO_DURATION_OPTIONS = ['4s', '6s', '8s', '10s']
const IMAGE_ASPECT_RATIO_VALUES = {
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:4': 3 / 4
} as const

type GenerateMediaType = 'image' | 'video'
type MediaNodeType = 'image' | 'video'
type ImageAspectRatioOption = keyof typeof IMAGE_ASPECT_RATIO_VALUES
type NodePillField = 'provider' | 'aspectRatio' | 'mediaType' | 'model' | 'videoDuration' | 'quantity' | 'resolution' | 'flowVideoMode'

interface NodePillOption {
  value: string
  label: string
}

interface NodePillMenuState {
  nodeId: string
  field: NodePillField
  value: string
  trigger: HTMLElement
  options: NodePillOption[]
}

interface PreviewMetadata {
  model?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  duration?: number
  createdAt?: number | string
  cost?: number | string
  createdBy?: string
}

interface ImagePreviewState {
  src: string
  name: string
  mediaType: MediaNodeType
  metadata?: PreviewMetadata
  baseMetadata?: PreviewMetadata
  zoom?: number
  /** Carousel context. When `outputItems.length > 1`, the lightbox
   *  shows prev/next/counter and lets the user flip through outputs
   *  without leaving the modal. Empty array → no carousel. */
  outputItems?: GenerateOutputItem[]
  /** Current selected index inside `outputItems`. Drives the counter
   *  and which asset the download button targets. */
  selectedIndex?: number
  /** Display name for the asset currently being shown (synced with
   *  `outputItems[selectedIndex].name` whenever the carousel moves).
   *  Used by the lightbox header so the title tracks the visible
   *  asset, not the asset that was open when the modal first opened. */
  outputName?: string
  /** Filename hint for the download button (the asset's
   *  `savedFilename` basename). Same lifecycle as `outputName` —
   *  re-synced on every carousel step. */
  downloadFilename?: string
}

interface MarqueeRect {
  /** Left edge in viewport (clientX) coordinates. */
  left: number
  /** Top edge in viewport (clientY) coordinates. */
  top: number
  /** Width in viewport pixels. */
  width: number
  /** Height in viewport pixels. */
  height: number
}

function normalizePillOptions(options: Array<{ value: string; label: string }> | string[]): NodePillOption[] {
  return options.map((option) => (
    typeof option === 'string'
      ? { value: option, label: option }
      : { value: option.value, label: option.label }
  ))
}

function generateProviderSupportsVideo(provider: unknown) {
  return provider === 'google-flow'
}

function getGenerateMediaType(data: Record<string, unknown>): GenerateMediaType {
  const provider = data.provider || 'chatgpt'
  const raw = String(data.mediaType || data.media_type || 'image').toLowerCase()
  return raw === 'video' && generateProviderSupportsVideo(provider) ? 'video' : 'image'
}

function getGenerateAspectRatioOptions(data: Record<string, unknown>) {
  return getGenerateMediaType(data) === 'video' ? GENERATE_VIDEO_RATIO_OPTIONS : GENERATE_IMAGE_RATIO_OPTIONS
}

function getGenerateModelOptions(data: Record<string, unknown>) {
  const provider = data.provider || 'chatgpt'
  if (provider === 'google-flow') {
    return getGenerateMediaType(data) === 'video'
      ? GOOGLE_FLOW_VIDEO_MODEL_OPTIONS
      : GOOGLE_FLOW_IMAGE_MODEL_OPTIONS
  }
  return []
}

function getGenerateDefaultModel(data: Record<string, unknown>) {
  return getGenerateMediaType(data) === 'video'
    ? GOOGLE_FLOW_DEFAULT_VIDEO_MODEL
    : GOOGLE_FLOW_DEFAULT_IMAGE_MODEL
}

function getGenerateVideoDurationOptions(data: Record<string, unknown>) {
  if (getGenerateMediaType(data) !== 'video') return []
  return data.model === 'Omni Flash' ? OMNI_FLASH_VIDEO_DURATION_OPTIONS : VIDEO_DURATION_OPTIONS
}

function generateNodeSupportsVideoInput(data: Record<string, unknown>) {
  return (
    data.provider === 'google-flow' &&
    getGenerateMediaType(data) === 'video' &&
    String(data.model || '') === 'Omni Flash'
  )
}

function sanitizeGenerateDataPatch(currentData: Record<string, unknown>, patch: Record<string, unknown>) {
  const next = { ...currentData, ...patch }
  const provider = String(next.provider || 'chatgpt')
  const mediaType = getGenerateMediaType(next)
  const ratioOptions = getGenerateAspectRatioOptions({ ...next, mediaType })
  const modelOptions = getGenerateModelOptions({ ...next, provider, mediaType })
  const sanitized: Record<string, unknown> = { ...patch, provider, mediaType }

  if (!generateProviderSupportsVideo(provider)) {
    sanitized.mediaType = 'image'
    sanitized.model = ''
    sanitized.videoDuration = undefined
  } else {
    const defaultModel = getGenerateDefaultModel({ ...next, provider, mediaType })
    sanitized.model = modelOptions.includes(String(next.model))
      ? String(next.model)
      : modelOptions.includes(defaultModel)
        ? defaultModel
        : modelOptions[0]
    const durationOptions = getGenerateVideoDurationOptions({ ...next, ...sanitized, mediaType })
    const nextDuration = String(next.videoDuration || next.video_duration || VIDEO_DURATION_OPTIONS[1])
    sanitized.videoDuration = mediaType === 'video'
      ? durationOptions.includes(nextDuration)
        ? nextDuration
        : durationOptions.includes('8s')
          ? '8s'
          : durationOptions[0]
      : undefined
  }

  if (!ratioOptions.includes(String(next.aspectRatio))) {
    sanitized.aspectRatio = ratioOptions[0]
  }

  // Resolution only applies to google-flow image outputs. ChatGPT
  // has no equivalent setting; clamp unknown / stale values to
  // '1k' so the runner always sends a valid value (or omits it
  // entirely for non-google providers, see runner).
  if (provider === 'google-flow') {
    const validResolutions = GENERATE_RESOLUTION_OPTIONS.map((opt) => opt.value)
    sanitized.resolution = validResolutions.includes(String(next.resolution))
      ? String(next.resolution)
      : GENERATE_DEFAULT_RESOLUTION
  } else {
    sanitized.resolution = undefined
  }

  // flowVideoMode — Google Flow Video only. Strip when provider is not
  // google-flow or when the active mediaType isn't video. Persisted
  // only when the user explicitly sets it via the pill, so legacy
  // workflows without the field keep their pre-existing behavior
  // (Flow's current default is 'ingredient'). This rule must NOT
  // synthesize a default value on every patch — the runtime "do not
  // touch the Flow tab" branch in selectVideoMode is what guarantees
  // legacy compatibility.
  if (provider === 'google-flow' && mediaType === 'video') {
    const candidate = next.flowVideoMode
    sanitized.flowVideoMode = candidate !== undefined && FLOW_VIDEO_MODE_VALUES.includes(candidate as FlowVideoMode)
      ? (candidate as FlowVideoMode)
      : undefined
  } else {
    sanitized.flowVideoMode = undefined
  }

  return sanitized
}

function getPillOptions(field: NodePillField, data: Record<string, unknown> = {}): NodePillOption[] {
  if (field === 'provider') return normalizePillOptions(PROVIDER_OPTIONS)
  if (field === 'mediaType') return normalizePillOptions(GENERATE_MEDIA_TYPE_OPTIONS)
  if (field === 'model') return normalizePillOptions(getGenerateModelOptions(data))
  if (field === 'videoDuration') return normalizePillOptions(getGenerateVideoDurationOptions(data))
  if (field === 'quantity') return normalizePillOptions(GENERATE_QUANTITY_OPTIONS)
  if (field === 'resolution') return normalizePillOptions(GENERATE_RESOLUTION_OPTIONS)
  if (field === 'flowVideoMode') return normalizePillOptions(FLOW_VIDEO_MODE_OPTIONS)
  return normalizePillOptions(
    data && Object.keys(data).length > 0 ? getGenerateAspectRatioOptions(data) : ASPECT_RATIO_OPTIONS
  )
}

function pillFieldLabel(field: NodePillField) {
  if (field === 'provider') return 'Provider'
  if (field === 'mediaType') return 'Media type'
  if (field === 'model') return 'Model'
  if (field === 'videoDuration') return 'Duration'
  if (field === 'quantity') return 'Quantity'
  if (field === 'resolution') return 'Resolution'
  if (field === 'flowVideoMode') return 'Chế độ video'
  return 'Aspect ratio'
}

function closestImageAspectRatio(width: number, height: number): ImageAspectRatioOption {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '1:1'

  const imageRatio = width / height
  return (Object.entries(IMAGE_ASPECT_RATIO_VALUES) as Array<[ImageAspectRatioOption, number]>).reduce(
    (best, [ratio, value]) => {
      const score = Math.abs(Math.log(imageRatio / value))
      return score < best.score ? { ratio, score } : best
    },
    { ratio: '1:1' as ImageAspectRatioOption, score: Infinity }
  ).ratio
}

function getMediaNodeType(data: Record<string, unknown>): MediaNodeType {
  const raw = String(data.mediaType || '').toLowerCase()
  const videoSource = String(data.videoData || data.videoUrl || '')
  if (raw === 'video' || videoSource.length > 0) return 'video'
  return 'image'
}

/**
 * Module-level cache of assetId → object URL. Populated by an effect
 * inside the editor that watches every node for `data.assetId` /
 * `data.posterAssetId` changes. Functions reading this cache stay
 * synchronous so the static `renderDrawflowNode` HTML builder does
 * not have to grow an async path. The cache is empty until the
 * effect runs (during a render) so the first frame still falls back
 * to the legacy data URL / template preview; the second frame after
 * IndexedDB resolves replaces it via `rerenderDrawflowNode`.
 */
const assetObjectUrlSyncCache = new Map<string, string>()

const syncAssetUrl = (assetId: unknown): string => {
  if (typeof assetId !== 'string' || !assetId) return ''
  return assetObjectUrlSyncCache.get(assetId) || ''
}

function getMediaNodeSource(data: Record<string, unknown>) {
  const mediaType = getMediaNodeType(data)
  // [WorkflowTemplate] Last-resort fallback chain reads the
  // compressed per-node preview that survives the template
  // round-trip. The sanitizer strips every `imageData`/`mediaData`
  // /`videoData` raw base64, so without this fallback every
  // restored Media node renders as a placeholder.
  // [AssetStore] assetId takes priority — resolved blob URL comes
  // from the module-level sync cache populated by an effect.
  if (mediaType === 'video') {
    const videoAssetUrl = syncAssetUrl(data.assetId) || syncAssetUrl(data.mediaAssetId)
    if (videoAssetUrl) return videoAssetUrl
    return String(
      data.videoData
      || data.videoUrl
      || data.mediaData
      || data.mediaUrl
      || data.templateVideoPoster
      || data.templateImagePreview
      || ''
    )
  }
  const imageAssetUrl = syncAssetUrl(data.assetId) || syncAssetUrl(data.mediaAssetId) || syncAssetUrl(data.imageAssetId)
  if (imageAssetUrl) return imageAssetUrl
  return String(
    data.imageData
    || data.imageUrl
    || data.mediaData
    || data.mediaUrl
    || data.templateImagePreview
    || ''
  )
}

function getMediaNodePoster(data: Record<string, unknown>) {
  // [WorkflowTemplate] Same fallback — the video poster slot
  // collapses onto the same compressed preview when nothing else
  // is available.
  // [AssetStore] posterAssetId takes priority — same sync cache.
  const posterUrl = syncAssetUrl(data.posterAssetId) || syncAssetUrl(data.thumbnailAssetId)
  if (posterUrl) return posterUrl
  return String(
    data.videoPoster
    || data.mediaPoster
    || data.templateVideoPoster
    || data.templateImagePreview
    || ''
  )
}

interface MediaUrlProbeResult {
  mediaType: MediaNodeType
  width?: number
  height?: number
  duration?: number
}

const MEDIA_URL_IMAGE_PATTERN = /\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#]|$)/i
const MEDIA_URL_VIDEO_PATTERN = /\.(mp4|mov|webm|m4v|ogv)(?:[?#]|$)/i

function inferMediaUrlType(url: string): MediaNodeType | null {
  if (/^data:video\//i.test(url) || MEDIA_URL_VIDEO_PATTERN.test(url)) return 'video'
  if (/^data:image\//i.test(url) || MEDIA_URL_IMAGE_PATTERN.test(url)) return 'image'
  return null
}

function validateMediaUrl(rawUrl: string): string {
  const url = rawUrl.trim()
  if (!url) throw new Error('Enter an image or video URL.')

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Enter a valid absolute media URL.')
  }

  if (!['http:', 'https:', 'data:', 'blob:', 'chrome-extension:'].includes(parsed.protocol)) {
    throw new Error('This URL protocol is not supported.')
  }
  return url
}

function probeImageUrl(url: string): Promise<MediaUrlProbeResult> {
  return new Promise((resolve, reject) => {
    const image = new window.Image()
    const timeoutId = window.setTimeout(() => finish(new Error('Image URL timed out.')), 10000)
    const finish = (error?: Error) => {
      window.clearTimeout(timeoutId)
      image.onload = null
      image.onerror = null
      if (error) reject(error)
      else resolve({ mediaType: 'image', width: image.naturalWidth || undefined, height: image.naturalHeight || undefined })
    }
    image.onload = () => finish()
    image.onerror = () => finish(new Error('URL is not a loadable image.'))
    image.src = url
  })
}

function probeVideoUrl(url: string): Promise<MediaUrlProbeResult> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    const timeoutId = window.setTimeout(() => finish(new Error('Video URL timed out.')), 10000)
    const finish = (error?: Error) => {
      window.clearTimeout(timeoutId)
      video.onloadedmetadata = null
      video.onerror = null
      if (error) reject(error)
      else resolve({
        mediaType: 'video',
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined
      })
    }
    video.onloadedmetadata = () => finish()
    video.onerror = () => finish(new Error('URL is not a loadable video.'))
    video.src = url
    video.load()
  })
}

async function probeMediaUrl(url: string, preferredType: MediaNodeType): Promise<MediaUrlProbeResult> {
  const inferredType = inferMediaUrlType(url)
  if (inferredType) {
    try {
      return inferredType === 'video' ? await probeVideoUrl(url) : await probeImageUrl(url)
    } catch {
      // A strong URL/data MIME hint is enough to preserve authenticated
      // or short-lived URLs whose metadata cannot be probed from the UI.
      return { mediaType: inferredType }
    }
  }

  return new Promise((resolve, reject) => {
    let failedCount = 0
    let settled = false
    const accept = (result: MediaUrlProbeResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const decline = () => {
      failedCount += 1
      if (!settled && failedCount === 2) {
        settled = true
        reject(new Error('The URL could not be identified as an image or video.'))
      }
    }
    const probes = preferredType === 'video'
      ? [probeVideoUrl(url), probeImageUrl(url)]
      : [probeImageUrl(url), probeVideoUrl(url)]
    probes.forEach((probe) => probe.then(accept).catch(decline))
  })
}

function mediaFileNameFromUrl(url: string, mediaType: MediaNodeType): string {
  try {
    const parsed = new URL(url)
    const segment = parsed.pathname.split('/').filter(Boolean).pop()
    if (segment) return decodeURIComponent(segment)
  } catch {
    // URL validation already happened before commit; keep a safe fallback.
  }
  return mediaType === 'video' ? 'remote-video.mp4' : 'remote-image.png'
}

// [WorkflowMediaFileCard] Helpers used by the new Media (image /
// video) canvas card. Kept local to the editor so the GenTab runner
// / asset store / template loaders do not gain a new public surface.
const MEDIA_CARD_LABEL: Record<MediaNodeType, string> = {
  video: 'Video File',
  image: 'Image File'
}

function getMediaCardLabel(mediaType: MediaNodeType): string {
  return MEDIA_CARD_LABEL[mediaType] || 'Media File'
}

function formatMediaFileSize(bytes: unknown): string {
  const numeric = Number(bytes)
  if (!Number.isFinite(numeric) || numeric <= 0) return ''
  if (numeric < 1024 * 1024) {
    const kb = numeric / 1024
    return `${kb.toFixed(kb >= 100 ? 0 : 2)} KB`
  }
  const mb = numeric / (1024 * 1024)
  return `${mb.toFixed(2)} MB`
}

function formatMediaDuration(seconds: unknown): string {
  const numeric = Number(seconds)
  if (!Number.isFinite(numeric) || numeric <= 0) return ''
  return `${Number.isInteger(numeric) ? numeric.toFixed(0) : numeric.toFixed(1)}s`
}

function firstPreviewString(
  records: Array<Record<string, unknown> | undefined>,
  keys: string[]
): string | undefined {
  for (const record of records) {
    if (!record) continue
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return undefined
}

function firstPreviewNumber(
  records: Array<Record<string, unknown> | undefined>,
  keys: string[]
): number | undefined {
  for (const record of records) {
    if (!record) continue
    for (const key of keys) {
      const value = Number(record[key])
      if (Number.isFinite(value) && value > 0) return value
    }
  }
  return undefined
}

function firstPreviewScalar(
  records: Array<Record<string, unknown> | undefined>,
  keys: string[]
): number | string | undefined {
  for (const record of records) {
    if (!record) continue
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() && value.trim() !== '—') return value.trim()
    }
  }
  return undefined
}

function buildPreviewMetadata(
  records: Array<Record<string, unknown> | undefined>,
  mediaType: MediaNodeType
): PreviewMetadata {
  const metadata: PreviewMetadata = {}
  const model = firstPreviewString(records, ['model', 'activeModel', 'modelName'])
  const mimeType = firstPreviewString(records, ['mediaMimeType', 'mimeType', 'contentType'])
  const size = firstPreviewNumber(records, ['mediaSize', 'size', 'fileSize', 'byteSize'])
  const width = firstPreviewNumber(records, ['mediaWidth', 'imageWidth', 'videoWidth', 'width'])
  const height = firstPreviewNumber(records, ['mediaHeight', 'imageHeight', 'videoHeight', 'height'])
  const duration = firstPreviewNumber(records, ['mediaDuration', 'duration'])
  const createdAt = firstPreviewScalar(records, ['createdAt', 'dateCreated', 'created_at'])
  const cost = firstPreviewScalar(records, ['cost', 'generationCost', 'creditCost'])
  const createdBy = firstPreviewString(records, ['createdBy', 'createdByName', 'creator', 'uploadedBy', 'uploadedByName'])

  if (model) metadata.model = model
  metadata.mimeType = mimeType || (mediaType === 'video' ? 'video/mp4' : 'image/png')
  if (size) metadata.size = size
  if (width) metadata.width = width
  if (height) metadata.height = height
  if (duration) metadata.duration = duration
  if (createdAt !== undefined) metadata.createdAt = createdAt
  if (cost !== undefined) metadata.cost = cost
  if (createdBy) metadata.createdBy = createdBy
  return metadata
}

function formatPreviewFileType(
  metadata: PreviewMetadata | undefined,
  name: string,
  src: string,
  mediaType: MediaNodeType
): string {
  const mimeSubtype = String(metadata?.mimeType || '').split('/')[1]?.split(';')[0]?.trim()
  if (mimeSubtype) return mimeSubtype.toUpperCase() === 'JPG' ? 'JPEG' : mimeSubtype.toUpperCase()
  const cleanSource = `${name} ${src}`.split(/[?#]/)[0]
  const extension = cleanSource.match(/\.([a-z0-9]{2,5})(?:\s|$)/i)?.[1]
  return extension ? extension.toUpperCase() : mediaType === 'video' ? 'MP4' : 'PNG'
}

function formatPreviewCreatedAt(value: number | string | undefined): string {
  if (value === undefined || value === '') return ''
  const numeric = typeof value === 'number' ? value : Number(value)
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

function formatPreviewCost(value: number | string | undefined): string {
  if (value === undefined || value === null || value === '') return ''
  return String(value).trim()
}

// Falls back through every documented width/height field so legacy
// Media nodes (imageWidth / videoWidth / raw width / raw height) all
// paint the badge the same way. Returns 0 when missing — caller
// decides whether to show the badge.
function getMediaCardDimensions(data: Record<string, unknown>): { width: number; height: number } {
  const width = Number(
    data.mediaWidth
    || data.imageWidth
    || data.videoWidth
    || data.width
    || 0
  )
  const height = Number(
    data.mediaHeight
    || data.imageHeight
    || data.videoHeight
    || data.height
    || 0
  )
  return { width, height }
}

function getMediaCardFileName(data: Record<string, unknown>): string {
  return String(
    data.mediaName
    || data.imageName
    || data.videoName
    || data.fileName
    || ''
  )
}

function getMediaCardByteSize(data: Record<string, unknown>): number {
  const raw = Number(
    data.mediaSize
    || data.size
    || 0
  )
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

function getMediaCardDurationSeconds(data: Record<string, unknown>): number {
  const raw = Number(data.duration || data.mediaDuration || 0)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

function captureVideoPoster(videoSrc: string): Promise<{ width?: number; height?: number; duration?: number; poster?: string }> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    let settled = false
    let waitingForSeek = false

    let captureDuration: number | undefined
    const finish = (poster?: string) => {
      if (settled) return
      settled = true
      const width = video.videoWidth || undefined
      const height = video.videoHeight || undefined
      // [WorkflowMediaFileCard] Surface the video duration so the
      // card badge can show "720\u00d71280 \u00b7 11.9s". The
      // `duration` field is already in SAFE_MEDIA_METADATA_KEYS, so
      // it round-trips through the import sanitizer.
      if (videoDurationSnapshot > 0 && captureDuration === undefined) {
        captureDuration = videoDurationSnapshot
      }
      video.removeAttribute('src')
      video.load()
      resolve({
        width,
        height,
        duration: captureDuration,
        poster
      })
    }

    const capture = () => {
      if (settled) return
      const width = video.videoWidth
      const height = video.videoHeight
      if (!width || !height) {
        finish()
        return
      }

      try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) {
          finish()
          return
        }
        context.drawImage(video, 0, 0, width, height)
        finish(canvas.toDataURL('image/jpeg', 0.86))
      } catch {
        finish()
      }
    }

    const captureNextFrame = () => {
      requestAnimationFrame(capture)
    }

    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'
    let videoDurationSnapshot = 0
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      videoDurationSnapshot = duration > 0 ? duration : 0
      const seekTime = duration > 0.2 ? Math.min(0.15, Math.max(0, duration - 0.05)) : 0
      if (seekTime > 0) {
        waitingForSeek = true
        try {
          video.currentTime = seekTime
        } catch {
          waitingForSeek = false
          captureNextFrame()
        }
        return
      }
      captureNextFrame()
    }
    video.onloadeddata = () => {
      if (!waitingForSeek) captureNextFrame()
    }
    video.onseeked = () => {
      waitingForSeek = false
      captureNextFrame()
    }
    video.onerror = () => finish()

    window.setTimeout(() => finish(), 3000)
    video.src = videoSrc
    video.load()
  })
}

const WORKFLOW_REQUIRES_GENERATE_MESSAGE = 'Add an enabled Generate node before running.'
const WORKFLOW_REQUIRES_PROMPT_MESSAGE = 'Connect an enabled Prompt node or add prompt text before running.'

const readNodePromptText = (node: WorkflowNode): string => {
  const data = (node.data || {}) as Record<string, unknown>
  return typeof data.prompt === 'string' ? data.prompt.trim() : ''
}

const getWorkflowRunWarning = (workflow: Pick<Workflow, 'nodes' | 'edges'>, targetGenerateNodeId?: string): string | null => {
  const enabledNodes = workflow.nodes.filter((node) => (node.data as Record<string, unknown>).enabled !== false)
  const enabledNodeIds = new Set(enabledNodes.map((node) => node.id))
  const enabledEdges = workflow.edges.filter((edge) => enabledNodeIds.has(edge.source) && enabledNodeIds.has(edge.target))
  const enabledNodeMap = new Map(enabledNodes.map((node) => [node.id, node]))
  const generateNodes = enabledNodes.filter((node) => (
    node.type === 'generate'
    && (!targetGenerateNodeId || node.id === targetGenerateNodeId)
  ))

  if (generateNodes.length === 0) return WORKFLOW_REQUIRES_GENERATE_MESSAGE

  const canProduceText = (nodeId: string, seen = new Set<string>()): boolean => {
    if (seen.has(nodeId)) return false
    seen.add(nodeId)
    const node = enabledNodeMap.get(nodeId)
    if (!node) return false
    if (readNodePromptText(node)) return true
    if (node.type !== 'prompt') return false
    return enabledEdges
      .filter((edge) => edge.target === nodeId)
      .some((edge) => canProduceText(edge.source, seen))
  }

  const missingPromptNode = generateNodes.find((node) => {
    if (readNodePromptText(node)) return false
    return !enabledEdges
      .filter((edge) => edge.target === node.id)
      .some((edge) => canProduceText(edge.source))
  })

  if (missingPromptNode) return WORKFLOW_REQUIRES_PROMPT_MESSAGE
  return null
}

const NODE_PICKER_ITEMS = NODE_CATEGORIES.flatMap((category) =>
  category.nodes.map((node) => ({
    ...node,
    category: category.label,
    description: NODE_DESCRIPTIONS[node.type] || 'Configure this workflow step'
  }))
)

interface WorkflowEditorProps {
  isSidebarOpen: boolean
  onToggleSidebar: () => void
}

interface WorkflowCanvasProps {
  workflow: Workflow
  isSidebarOpen: boolean
  onToggleSidebar: () => void
  onBackToDashboard: () => void
  windowMode?: boolean
}

type WorkflowShellView = 'templates' | 'workflows' | 'editor'

interface WorkflowTemplate {
  id: string
  name: string
  description: string
  category: string
  accent: 'sky' | 'emerald' | 'amber' | 'rose'
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  tags: string[]
  /** Source marker for cards rendered from chrome.storage.local. Cards
   *  derived from `BUILT_IN_TEMPLATES` leave this undefined; cards
   *  built by `userTemplateToCardShape` set it to `'user'`. */
  source?: 'user'
  /** Optional JPEG data URL extracted at save time. Built-in cards
   *  leave this undefined. The Templates tab renders it as a 240px
   *  cover image when present. */
  thumbnail?: string
}

type TemplateMediaFilter = 'All' | 'Image' | 'Video'

const TEMPLATE_MEDIA_FILTERS: TemplateMediaFilter[] = ['All', 'Image', 'Video']

function getTemplateTagCount(template: WorkflowTemplate, mediaType: 'image' | 'video'): number | null {
  const pattern = mediaType === 'image'
    ? /^(\d+)\s+images?$/i
    : /^(\d+)\s+videos?$/i
  for (const tag of template.tags) {
    const match = String(tag).trim().match(pattern)
    if (match) return Number(match[1]) || 0
  }
  return null
}

function templateHasVideoMedia(template: WorkflowTemplate): boolean {
  const explicitVideoCount = getTemplateTagCount(template, 'video')
  if (explicitVideoCount !== null) return explicitVideoCount > 0
  return template.tags.some((tag) => String(tag).toLowerCase() === 'video')
    || template.nodes.some((node) => {
      const data = (node.data || {}) as Record<string, unknown>
      const mediaType = String(data.mediaType || '').toLowerCase()
      const mimeType = String(data.mediaMimeType || data.mimeType || '').toLowerCase()
      return mediaType === 'video'
        || mimeType.startsWith('video/')
        || typeof data.videoUrl === 'string' && data.videoUrl.trim().length > 0
        || typeof data.templateVideoPoster === 'string' && data.templateVideoPoster.trim().length > 0
        || typeof data.posterAssetId === 'string' && data.posterAssetId.trim().length > 0
    })
}

function templateHasImageMedia(template: WorkflowTemplate): boolean {
  const explicitImageCount = getTemplateTagCount(template, 'image')
  if (explicitImageCount !== null && explicitImageCount > 0) return true
  if (template.category === 'Image' || template.tags.some((tag) => String(tag).toLowerCase() === 'image')) return true
  return template.nodes.some((node) => {
    const data = (node.data || {}) as Record<string, unknown>
    const mediaType = String(data.mediaType || '').toLowerCase()
    const mimeType = String(data.mediaMimeType || data.mimeType || '').toLowerCase()
    if (mediaType === 'video' || mimeType.startsWith('video/')) return false
    return node.type === 'generate'
      || node.type === 'image'
      || typeof data.imageUrl === 'string' && data.imageUrl.trim().length > 0
      || typeof data.templateImagePreview === 'string' && data.templateImagePreview.trim().length > 0
      || typeof data.imageAssetId === 'string' && data.imageAssetId.trim().length > 0
  })
}

function templateMatchesMediaFilter(template: WorkflowTemplate, filter: TemplateMediaFilter): boolean {
  if (filter === 'All') return true
  if (filter === 'Video') return templateHasVideoMedia(template)
  return templateHasImageMedia(template) && !templateHasVideoMedia(template)
}

// [WorkflowTemplate] JS-masonry constants. The card width target is
// shared between the runtime ResizeObserver (which decides how many
// columns to render) and the e2e test (which asserts the column
// count for a given viewport). Keep these in sync if either side
// changes.
const MIN_TEMPLATE_CARD_WIDTH = 240
const TEMPLATE_CARD_GAP = 12
const MAX_TEMPLATE_COLUMNS = 4

// [WorkflowTemplate] Round-robin distribution. We do NOT use
// shortest-column here because that would need a pre-measured
// height estimate per card; without one, shortest-column is no
// better than round-robin and round-robin is fully predictable
// (card[0] -> column[0]). The critical property is: when
// `templates.length <= columnCount`, every card lands in its own
// column and no column is left empty — the bug CSS columns
// `column-fill: balance` produced at viewport 1229 (3 saved cards
// collapsed into 2 visual columns with ≈258px of dead right area).
function distributeTemplatesIntoColumns<T>(templates: T[], columnCount: number): T[][] {
  const cols = Math.max(1, columnCount)
  const out: T[][] = Array.from({ length: cols }, () => [])
  templates.forEach((tpl, i) => {
    out[i % cols].push(tpl)
  })
  return out
}

const BUILT_IN_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'flow-image-basic',
    name: 'Flow Image Pipeline',
    description: 'Prompt, ratio setup, generate, download.',
    category: 'Image',
    accent: 'emerald',
    tags: ['Google Flow', 'Image'],
    nodes: [
      {
        id: 'prompt',
        type: 'prompt',
        position: { x: 80, y: 140 },
        data: {
          label: 'Image Prompt',
          prompt: 'A cinematic product shot with rich detail and natural lighting',
          provider: 'google-flow'
        }
      },
      {
        id: 'image',
        type: 'image',
        position: { x: 350, y: 140 },
        data: {
          label: 'Aspect Ratio',
          aspectRatio: '16:9',
          provider: 'google-flow'
        }
      },
      {
        id: 'generate',
        type: 'generate',
        position: { x: 610, y: 140 },
        data: {
          label: 'Generate',
          provider: 'google-flow',
          autoGenerate: true,
          waitForCompletion: true,
          timeout: 90000
        }
      },
      {
        id: 'download',
        type: 'download',
        position: { x: 860, y: 140 },
        data: {
          label: 'Download',
          format: 'png',
          autoDownload: true
        }
      }
    ],
    edges: [
      { id: 'e1', source: 'prompt', target: 'generate', targetHandle: 'input_2' },
      { id: 'e2', source: 'image', target: 'generate', targetHandle: 'input_1' },
      { id: 'e3', source: 'generate', target: 'download' }
    ]
  },
  {
    id: 'chatgpt-image-basic',
    name: 'ChatGPT Image',
    description: 'Prompt, generate image, save output.',
    category: 'Image',
    accent: 'sky',
    tags: ['ChatGPT', 'Image'],
    nodes: [
      {
        id: 'prompt',
        type: 'prompt',
        position: { x: 100, y: 120 },
        data: {
          label: 'Prompt',
          prompt: 'Create a polished concept image for a modern AI workflow dashboard',
          provider: 'chatgpt',
          model: 'Instant'
        }
      },
      {
        id: 'generate',
        type: 'generate',
        position: { x: 390, y: 120 },
        data: {
          label: 'Generate',
          provider: 'chatgpt',
          autoGenerate: true,
          waitForCompletion: true,
          timeout: 90000
        }
      },
      {
        id: 'download',
        type: 'download',
        position: { x: 650, y: 120 },
        data: {
          label: 'Save Result',
          format: 'png',
          autoDownload: true
        }
      }
    ],
    edges: [
      { id: 'e1', source: 'prompt', target: 'generate', targetHandle: 'input_2' },
      { id: 'e2', source: 'generate', target: 'download' }
    ]
  },
  {
    id: 'batch-with-delay',
    name: 'Batch With Delay',
    description: 'Two prompt runs with a pacing delay.',
    category: 'Batch',
    accent: 'amber',
    tags: ['Batch', 'Delay'],
    nodes: [
      {
        id: 'prompt-a',
        type: 'prompt',
        position: { x: 80, y: 80 },
        data: {
          label: 'Prompt A',
          prompt: 'Generate the first visual direction',
          provider: 'chatgpt'
        }
      },
      {
        id: 'generate-a',
        type: 'generate',
        position: { x: 350, y: 80 },
        data: {
          label: 'Generate A',
          provider: 'chatgpt',
          autoGenerate: true,
          waitForCompletion: true,
          timeout: 90000
        }
      },
      {
        id: 'delay',
        type: 'delay',
        position: { x: 610, y: 80 },
        data: {
          label: 'Cooldown',
          duration: 5000
        }
      },
      {
        id: 'prompt-b',
        type: 'prompt',
        position: { x: 80, y: 280 },
        data: {
          label: 'Prompt B',
          prompt: 'Generate a refined alternate direction',
          provider: 'chatgpt'
        }
      },
      {
        id: 'generate-b',
        type: 'generate',
        position: { x: 350, y: 280 },
        data: {
          label: 'Generate B',
          provider: 'chatgpt',
          autoGenerate: true,
          waitForCompletion: true,
          timeout: 90000
        }
      },
      {
        id: 'download',
        type: 'download',
        position: { x: 650, y: 280 },
        data: {
          label: 'Download',
          format: 'png',
          autoDownload: true
        }
      }
    ],
    edges: [
      { id: 'e1', source: 'prompt-a', target: 'generate-a', targetHandle: 'input_2' },
      { id: 'e2', source: 'generate-a', target: 'delay' },
      { id: 'e3', source: 'delay', target: 'prompt-b' },
      { id: 'e4', source: 'prompt-b', target: 'generate-b', targetHandle: 'input_2' },
      { id: 'e5', source: 'generate-b', target: 'download' }
    ]
  },
  {
    id: 'grok-quick',
    name: 'Grok Quick Run',
    description: 'Prompt and generate through Grok.',
    category: 'Image',
    accent: 'rose',
    tags: ['Grok', 'Quick'],
    nodes: [
      {
        id: 'prompt',
        type: 'prompt',
        position: { x: 100, y: 130 },
        data: {
          label: 'Prompt',
          prompt: 'A dramatic editorial image with crisp composition',
          provider: 'grok'
        }
      },
      {
        id: 'generate',
        type: 'generate',
        position: { x: 390, y: 130 },
        data: {
          label: 'Generate',
          provider: 'grok',
          autoGenerate: true,
          waitForCompletion: true,
          timeout: 90000
        }
      },
      {
        id: 'download',
        type: 'download',
        position: { x: 650, y: 130 },
        data: {
          label: 'Download',
          format: 'png',
          autoDownload: true
        }
      }
    ],
    edges: [
      { id: 'e1', source: 'prompt', target: 'generate', targetHandle: 'input_2' },
      { id: 'e2', source: 'generate', target: 'download' }
    ]
  }
]

function createId(prefix: string) {
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 12)
  return `${prefix}_${randomId}`
}

function cloneDeep<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp)
}

function coerceProvider(value: unknown): AIProvider {
  if (value === 'flow' || value === 'google-flow') return 'google-flow'
  if (value === 'grok') return 'grok'
  if (value === 'gemini') return 'gemini'
  if (value === 'claude') return 'claude'
  return 'chatgpt'
}

function normalizeNodeType(value: unknown): FlowNodeType {
  const raw = String(value || '').toLowerCase()
  if ((SUPPORTED_NODE_TYPES as string[]).includes(raw)) return raw as FlowNodeType
  if (raw === 'flow' || raw === 'chatgpt' || raw === 'grok') return 'generate'
  if (raw === 'note' || raw === 'text') return 'prompt'
  return 'prompt'
}

/**
 * Plain JSON import hotfix — pick the lightweight asset metadata
 * fields that are safe to round-trip through `coerceNodeData`.
 *
 * Heavies are deliberately omitted:
 *   - data:image / data:video / blob: strings
 *   - imageData / mediaData / videoData / videoPoster / mediaPoster
 *     (legacy base64 blobs that the migration helper rewrites on
 *     open, see `assetMigration.ts`)
 *   - objectUrl / previewUrl / resolvedAssetUrl / assetObjectUrl
 *     (transient in-memory object URLs that die after reload)
 *   - File / blob / rawFile / base64 / dataUrl (binary blobs that
 *     never belonged in the store)
 *
 * Anything outside this whitelist is dropped. The persist
 * sanitizer remains the safety net for anything that slips through.
 */
const SAFE_MEDIA_METADATA_KEYS: ReadonlySet<string> = new Set<string>([
  // asset pointer ids
  'assetId',
  'mediaAssetId',
  'imageAssetId',
  'posterAssetId',
  'thumbnailAssetId',
  // file / mime metadata
  'fileName',
  'mediaName',
  'mimeType',
  'mediaMimeType',
  'size',
  // dimensions + duration
  'width',
  'height',
  'mediaWidth',
  'mediaHeight',
  'imageWidth',
  'imageHeight',
  'videoWidth',
  'videoHeight',
  'duration'
])

const isShortString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length < 4_096

const isShortNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * Pick safe asset metadata (assetId pointers + dimensions + mime
 * + size) from a raw `node.data` blob. Returns a flat object with
 * ONLY the safe fields preserved. Always returns a fresh object.
 */
const pickSafeMediaMetadata = (raw: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!SAFE_MEDIA_METADATA_KEYS.has(key)) continue
    if (isShortString(value) || isShortNumber(value) || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

const pickNodeEnabledState = (raw: Record<string, unknown>): Pick<FlowNodeData, 'enabled'> | Record<string, never> => {
  if (raw.enabled === false) return { enabled: false }
  if (raw.enabled === true) return { enabled: true }
  return {}
}

/**
 * Safe Generate `_output` whitelist for plain JSON import. Mirrors
 * the persist-side `sanitizeGenerateOutput` contract — keep the
 * metadata the renderer reads back on reload, drop heavy strings.
 *
 * Items inside `outputs[]` are filtered through
 * `SAFE_GENERATE_OUTPUT_ITEM_KEYS`. URL fields are allowed only
 * when they start with `http://` / `https://` / `blob:` — `data:`
 * URLs are still stripped (Phase 3 migration handles those).
 */
const SAFE_GENERATE_OUTPUT_TOP_KEYS: ReadonlySet<string> = new Set<string>([
  'assetId',
  'posterAssetId',
  'thumbnailAssetId',
  'mediaType',
  'type',
  'mimeType',
  'size',
  'createdAt'
])

const SAFE_GENERATE_OUTPUT_ITEM_KEYS: ReadonlySet<string> = new Set<string>([
  'assetId',
  'posterAssetId',
  'thumbnailAssetId',
  'url',
  'imageUrl',
  'mediaUrl',
  'videoUrl',
  'thumbnailUrl',
  'poster',
  'mediaType',
  'type',
  'mimeType',
  'size',
  'width',
  'height',
  'duration',
  'savedFilename',
  'fileNameFromFlow',
  'name',
  'outputAvailable',
  'createdAt'
])

const isHttpishUrl = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length < 4_096
  && (/^https?:\/\//i.test(value) || /^blob:/i.test(value))

const pickSafeGenerateOutput = (raw: unknown): Record<string, unknown> | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const [key, child] of Object.entries(record)) {
    if (!SAFE_GENERATE_OUTPUT_TOP_KEYS.has(key)) continue
    if (key === 'assetId' || key === 'posterAssetId' || key === 'thumbnailAssetId') {
      if (isShortString(child)) out[key] = child
      continue
    }
    if (isShortString(child) || isShortNumber(child) || typeof child === 'boolean') {
      out[key] = child
    }
  }

  if (Array.isArray(record.outputs)) {
    const safeItems: unknown[] = []
    for (const item of record.outputs) {
      if (!item || typeof item !== 'object') continue
      const itemRecord = item as Record<string, unknown>
      const safeItem: Record<string, unknown> = {}
      for (const [itemKey, itemValue] of Object.entries(itemRecord)) {
        if (!SAFE_GENERATE_OUTPUT_ITEM_KEYS.has(itemKey)) continue
        if (
          itemKey === 'assetId'
          || itemKey === 'posterAssetId'
          || itemKey === 'thumbnailAssetId'
        ) {
          if (isShortString(itemValue)) safeItem[itemKey] = itemValue
          continue
        }
        if (
          itemKey === 'url'
          || itemKey === 'imageUrl'
          || itemKey === 'mediaUrl'
          || itemKey === 'videoUrl'
          || itemKey === 'thumbnailUrl'
          || itemKey === 'poster'
        ) {
          // Only allow http(s) / blob: URLs to round-trip. `data:`
          // strings are dropped — the persist sanitizer would
          // strip them anyway and Phase 3 migration re-writes
          // them through IndexedDB on the next open.
          if (isHttpishUrl(itemValue)) safeItem[itemKey] = itemValue
          continue
        }
        if (isShortString(itemValue) || isShortNumber(itemValue) || typeof itemValue === 'boolean') {
          safeItem[itemKey] = itemValue
        }
      }
      if (Object.keys(safeItem).length > 0) safeItems.push(safeItem)
    }
    if (safeItems.length > 0) out.outputs = safeItems
  }

  return Object.keys(out).length > 0 ? out : undefined
}

function coerceNodeData(type: FlowNodeType, raw: Record<string, unknown>): FlowNodeData {
  const label = String(raw.label || raw.node_name || raw.name || type)
  const provider = coerceProvider(raw.provider || raw.gen_type || raw.model_provider)
  const enabledState = pickNodeEnabledState(raw)

  if (type === 'prompt') {
    return {
      label,
      ...enabledState,
      prompt: String(raw.prompt || raw.note_text || ''),
      provider,
      model: typeof raw.model === 'string' ? raw.model : undefined
    }
  }

  if (type === 'image') {
    const refUrls = Array.isArray(raw.ref_img_urls) ? raw.ref_img_urls : []
    const imageUrl = typeof raw.imageUrl === 'string'
      ? raw.imageUrl
      : typeof raw.result_img_url === 'string'
        ? raw.result_img_url
        : typeof refUrls[0] === 'string'
          ? refUrls[0]
          : undefined
    const videoUrl = typeof raw.videoUrl === 'string'
      ? raw.videoUrl
      : typeof raw.result_video_url === 'string'
        ? raw.result_video_url
        : undefined
    const hasVideo = Boolean(videoUrl || raw.videoData)
    const mediaType = String(raw.mediaType || raw.media_type || '').toLowerCase() === 'video' || hasVideo ? 'video' : 'image'

    return {
      label,
      ...enabledState,
      mediaType,
      mediaUrl: typeof raw.mediaUrl === 'string' ? raw.mediaUrl : undefined,
      mediaData: typeof raw.mediaData === 'string' ? raw.mediaData : undefined,
      mediaName: typeof raw.mediaName === 'string' ? raw.mediaName : undefined,
      mediaPoster: typeof raw.mediaPoster === 'string' ? raw.mediaPoster : undefined,
      imageUrl,
      imageData: typeof raw.imageData === 'string' ? raw.imageData : undefined,
      videoUrl,
      videoData: typeof raw.videoData === 'string' ? raw.videoData : undefined,
      videoPoster: typeof raw.videoPoster === 'string' ? raw.videoPoster : undefined,
      aspectRatio: String(raw.aspectRatio || raw.ratio || '1:1') as FlowNodeData['aspectRatio'],
      provider,
      // Plain JSON import hotfix — preserve safe asset metadata so a
      // local machine that already has the IndexedDB blob can keep
      // rendering the preview without going through the .aiflow.json
      // bundle. Drops heavy / data: / blob: strings automatically.
      ...pickSafeMediaMetadata(raw)
    }
  }

  if (type === 'generate') {
    const mediaType = String(raw.mediaType || raw.media_type || 'image').toLowerCase() === 'video' ? 'video' : 'image'
    const nodeData: Record<string, unknown> = {
      label,
      ...enabledState,
      provider,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      mediaType,
      aspectRatio: String(raw.aspectRatio || raw.ratio || (mediaType === 'video' ? '16:9' : '1:1')) as FlowNodeData['aspectRatio'],
      videoDuration: typeof raw.videoDuration === 'string'
        ? raw.videoDuration
        : typeof raw.video_duration === 'string'
          ? raw.video_duration
          : undefined,
      autoGenerate: raw.autoGenerate !== false,
      waitForCompletion: raw.waitForCompletion !== false,
      timeout: Number(raw.timeout || 90000),
      prompt: raw.prompt || ''
    }
    // Plain JSON import hotfix — preserve safe _output metadata so
    // cached Generate outputs (assetId / http(s) URLs) round-trip
    // through plain JSON export / import. data: URLs and blob: are
    // intentionally filtered; Phase 3 migration handles data: at
    // next editor mount.
    const safeOutput = pickSafeGenerateOutput(raw._output)
    if (safeOutput) nodeData._output = safeOutput
    return { ...nodeData, ...sanitizeGenerateDataPatch(nodeData, {}) } as FlowNodeData
  }

  if (type === 'delay') {
    const seconds = Number(raw.delay_seconds || 0)
    return {
      label,
      ...enabledState,
      duration: Number(raw.duration || (seconds > 0 ? seconds * 1000 : 1000))
    }
  }

  if (type === 'download') {
    return {
      label,
      ...enabledState,
      format: String(raw.format || 'png') as FlowNodeData['format'],
      autoDownload: raw.autoDownload !== false,
      filename: typeof raw.filename === 'string' ? raw.filename : undefined
    } as FlowNodeData
  }

  if (type === 'wait') {
    return {
      label,
      ...enabledState,
      condition: String(raw.condition || 'dom-change') as FlowNodeData['condition'],
      selector: typeof raw.selector === 'string' ? raw.selector : undefined,
      expectedText: typeof raw.expectedText === 'string' ? raw.expectedText : undefined,
      timeout: Number(raw.timeout || 30000)
    } as FlowNodeData
  }

  return { label, ...enabledState } as FlowNodeData
}

function instantiateTemplate(template: WorkflowTemplate): Workflow {
  const nodeIdMap = new Map<string, string>()
  const now = Date.now()
  const nodes = template.nodes.map((node) => {
    const id = createId('node')
    nodeIdMap.set(node.id, id)
    return {
      ...cloneDeep(node),
      id,
      position: { ...node.position },
      data: cloneDeep(node.data)
    }
  })

  const edges = template.edges
    .map((edge) => {
      const source = nodeIdMap.get(edge.source)
      const target = nodeIdMap.get(edge.target)
      if (!source || !target) return null
      return {
        ...cloneDeep(edge),
        id: createId('edge'),
        source,
        target
      }
    })
    .filter(Boolean) as WorkflowEdge[]

  return {
    id: createId('workflow'),
    name: template.name,
    description: template.description,
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
    tags: template.tags
  }
}

/**
 * Instantiate a user-saved template into a brand-new Workflow. Same
 * shape as `instantiateTemplate` but reads from the
 * `UserWorkflowTemplate.workflow.nodes/edges` shape and prefixes the
 * new workflow name with the template name so the user can spot the
 * origin. The template itself is never mutated — every node and edge
 * gets a fresh id so the workflow can live side-by-side with the
 * original without collision.
 */
function instantiateUserTemplate(template: UserWorkflowTemplate): Workflow {
  const nodeIdMap = new Map<string, string>()
  const now = Date.now()
  // [WorkflowTemplate] Card-thumbnail fallback. When a node that
  // emitted the card thumbnail is missing a per-node preview
  // (CORS / decode failure), we substitute the card thumbnail as
  // its preview so the restored Media node still renders. This is
  // what the spec calls "thumbnailSourceNodeId restore" — only
  // fires when the per-node path was unable to fill that slot.
  const cardFallback = template.thumbnail && template.thumbnailSourceNodeId
    ? template.thumbnail
    : undefined
  const cardFallbackSlot: 'templateImagePreview' | 'templateVideoPoster' | undefined = (() => {
    if (!cardFallback) return undefined
    // [WorkflowTemplate] Honour the source node's mediaType. A
    // video Media-node should not get the image-card dropped into
    // the image-slot when the poster slot is what its renderer
    // will actually read.
    const sourceNode = template.workflow.nodes.find((n) => n.id === template.thumbnailSourceNodeId)
    if (!sourceNode) return undefined
    const t = String((sourceNode.data as Record<string, unknown>)?.mediaType || '').toLowerCase()
    return t === 'video' ? 'templateVideoPoster' : 'templateImagePreview'
  })()
  const nodes = template.workflow.nodes.map((node) => {
    const id = createId('node')
    nodeIdMap.set(node.id, id)
    const dataRecord = (node.data && typeof node.data === 'object'
      ? (node.data as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const nextData: Record<string, unknown> = { ...cloneDeep(dataRecord) }
    // [WorkflowTemplate] Card-thumbnail fallback only applied
    // when the original source node is the one we are restoring
    // AND no per-node preview is already populated. Built-in
    // nodes are not affected — they never participate in the
    // source-id mapping.
    if (
      cardFallback
      && cardFallbackSlot
      && node.id === template.thumbnailSourceNodeId
      && !nextData[cardFallbackSlot]
    ) {
      nextData[cardFallbackSlot] = cardFallback
    }
    return {
      ...cloneDeep(node),
      id,
      position: { ...node.position },
      data: nextData as unknown as Workflow['nodes'][number]['data']
    }
  })

  const edges = template.workflow.edges
    .map((edge) => {
      const source = nodeIdMap.get(edge.source)
      const target = nodeIdMap.get(edge.target)
      if (!source || !target) return null
      return {
        ...cloneDeep(edge),
        id: createId('edge'),
        source,
        target
      }
    })
    .filter(Boolean) as WorkflowEdge[]

  const baseName = `${template.name}`.trim() || 'Saved Template'
  return {
    id: createId('workflow'),
    name: baseName,
    description: template.description,
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
    tags: []
  }
}

function getUserTemplateMediaTags(nodes: WorkflowNode[]): string[] {
  let imageCount = 0
  let videoCount = 0
  const seenOutputKeys = new Set<string>()

  const stringValue = (value: unknown): string => {
    return typeof value === 'string' ? value.trim() : ''
  }

  const firstStringValue = (...values: unknown[]): string => {
    for (const value of values) {
      const text = stringValue(value)
      if (text) return text
    }
    return ''
  }

  const isVideoOutput = (record: Record<string, unknown>): boolean => {
    const mediaType = firstStringValue(record.mediaType, record.type).toLowerCase()
    const mimeType = firstStringValue(record.mediaMimeType, record.mimeType).toLowerCase()
    if (mediaType === 'video') return true
    if (mediaType === 'image') return false
    if (mimeType.startsWith('video/')) return true
    const url = firstStringValue(record.videoUrl, record.url, record.mediaUrl, record.imageUrl)
    return Boolean(stringValue(record.videoPoster))
      || Boolean(stringValue(record.templateVideoPoster))
      || Boolean(stringValue(record.posterAssetId))
      || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)
      || url.toLowerCase().includes('video')
  }

  const countMediaRecord = (record: Record<string, unknown>, requireOutputAvailable: boolean): void => {
    if (requireOutputAvailable && record.outputAvailable === false) return
    const outputKey = firstStringValue(
      record.assetId,
      record.mediaAssetId,
      record.imageAssetId,
      record.videoUrl,
      record.imageUrl,
      record.mediaUrl,
      record.url,
      record.videoData,
      record.imageData,
      record.mediaData,
      record.templateImagePreview,
      record.templateVideoPoster,
      record.posterAssetId,
      record.thumbnailAssetId
    )
    if (!outputKey) return
    if (outputKey && seenOutputKeys.has(outputKey)) return
    if (outputKey) seenOutputKeys.add(outputKey)
    if (isVideoOutput(record)) {
      videoCount += 1
    } else {
      imageCount += 1
    }
  }

  const countOutputRecord = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const record = raw as Record<string, unknown>
    countMediaRecord(record, true)
  }

  const countOutputContainer = (container: unknown): void => {
    if (!Array.isArray(container)) return
    for (const raw of container) countOutputRecord(raw)
  }

  const countFlatImageUrls = (container: unknown): void => {
    if (!Array.isArray(container)) return
    for (const value of container) {
      if (typeof value !== 'string') continue
      const outputKey = value.trim()
      if (!outputKey || seenOutputKeys.has(outputKey)) continue
      seenOutputKeys.add(outputKey)
      if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(outputKey) || outputKey.toLowerCase().includes('video')) {
        videoCount += 1
      } else {
        imageCount += 1
      }
    }
  }

  for (const node of nodes) {
    const data = (node.data && typeof node.data === 'object'
      ? (node.data as Record<string, unknown>)
      : {}) as Record<string, unknown>

    if (node.type === 'image') {
      countMediaRecord(data, false)
      continue
    }

    if (node.type !== 'generate') continue
    const output = data._output && typeof data._output === 'object'
      ? (data._output as Record<string, unknown>)
      : null

    countOutputContainer(output?.outputs)
    countOutputContainer(data.outputs)
    countFlatImageUrls(output?.imageUrls)
    countFlatImageUrls(data.imageUrls)
  }

  return [
    `${imageCount} image${imageCount === 1 ? '' : 's'}`,
    `${videoCount} video${videoCount === 1 ? '' : 's'}`
  ]
}

/**
 * [WorkflowTemplate] Adapter that lifts a UserWorkflowTemplate into
 * the card-render shape that built-in templates already use. The
 * Templates tab card renders `template.name`, `template.description`,
 * `template.category`, `template.tags`, `template.nodes.length`,
 * `template.edges.length`, `template.accent`, and (for the new
 * thumbnail render) `template.thumbnail`. All of those are filled
 * from the saved record. Source markers (`source: 'user'`) are kept
 * so a future delete affordance can tell the two apart.
 */
function userTemplateToCardShape(template: UserWorkflowTemplate): WorkflowTemplate {
  // [WorkflowTemplate] Card-cover thumbnail falls back through
  // `template.thumbnail` → first node's compressed preview →
  // safe URL field. We never read raw base64 here because the
  // sanitizer stripped it; the per-node `templateImagePreview`
  // is the already-compressed JPEG that survives the save
  // round-trip.
  const cardThumbnail = resolveTemplateCardThumbnail(template)
  return {
    id: template.id,
    name: template.name,
    description: template.description || `Saved template — ${template.nodeCount} nodes / ${template.edgeCount} edges`,
    category: categorizeSavedTemplate(template.workflow),
    accent: 'sky',
    tags: getUserTemplateMediaTags(template.workflow.nodes),
    nodes: template.workflow.nodes,
    edges: template.workflow.edges,
    source: 'user',
    ...(cardThumbnail ? { thumbnail: cardThumbnail } : {})
  }
}

function normalizeImportedWorkflow(payload: unknown): Workflow | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const source = root.workflow && typeof root.workflow === 'object'
    ? root.workflow as Record<string, unknown>
    : root

  const rawNodes = Array.isArray(source.nodes) ? source.nodes : []
  if (rawNodes.length === 0) return null

  const now = Date.now()
  const nodeIdMap = new Map<string, string>()
  const nodes = rawNodes.map((rawNode, index) => {
    const node = rawNode as Record<string, unknown>
    const originalId = String(node.id || node.node_id || `node_${index}`)
    const id = createId('node')
    const type = normalizeNodeType(node.type || node.node_type)
    const rawData = node.data && typeof node.data === 'object'
      ? node.data as Record<string, unknown>
      : node
    nodeIdMap.set(originalId, id)

    const position = node.position && typeof node.position === 'object'
      ? node.position as { x?: unknown; y?: unknown }
      : null

    return {
      id,
      type,
      position: {
        x: Number(position?.x ?? node.pos_x ?? 120 + index * 260),
        y: Number(position?.y ?? node.pos_y ?? 120)
      },
      data: coerceNodeData(type, rawData)
    }
  })

  const rawEdges = Array.isArray(source.edges) ? source.edges : []
  const edges = rawEdges
    .map((rawEdge, index) => {
      const edge = rawEdge as Record<string, unknown>
      const sourceId = String(edge.source || edge.source_node_id || '')
      const targetId = String(edge.target || edge.target_node_id || '')
      const source = nodeIdMap.get(sourceId)
      const target = nodeIdMap.get(targetId)
      if (!source || !target) return null

      return {
        id: createId('edge'),
        source,
        target,
        sourceHandle: typeof edge.sourceHandle === 'string'
          ? edge.sourceHandle
          : typeof edge.source_handle === 'string'
            ? edge.source_handle
            : undefined,
        targetHandle: typeof edge.targetHandle === 'string'
          ? edge.targetHandle
          : typeof edge.target_handle === 'string'
            ? edge.target_handle
            : undefined,
        label: typeof edge.label === 'string' ? edge.label : undefined,
        animated: edge.animated !== false
      } satisfies WorkflowEdge
    })
    .filter(Boolean) as WorkflowEdge[]

  return {
    id: createId('workflow'),
    name: String(source.name || source.wf_name || root.name || 'Imported Workflow'),
    description: typeof source.description === 'string' ? source.description : undefined,
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
    tags: Array.isArray(source.tags) ? source.tags.filter((tag): tag is string => typeof tag === 'string') : ['Imported']
  }
}

function downloadWorkflowJson(workflow: Workflow) {
  const payload = JSON.stringify({ version: 1, exportedAt: Date.now(), workflow }, null, 2)
  const blob = new Blob([payload], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${sanitizeExportFilename(workflow.name)}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function sanitizeExportFilename(name: string): string {
  const cleaned = String(name || '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return cleaned || 'workflow'
}

/**
 * [AssetBundle] Export the workflow as a portable `.aiflow.json`
 * bundle carrying every asset blob. Bundle file is the ONLY place
 * the data URLs live — they must never reach chrome.storage.local.
 * Async because IndexedDB reads + FileReader dataURLs are async.
 */
async function downloadWorkflowAssetBundle(
  workflow: Workflow,
  status?: { okCount: number; missingCount: number; error?: string }
): Promise<void> {
  const { bundle } = await exportWorkflowAssetBundle(workflow)
  const payload = JSON.stringify(bundle, null, 2)
  const blob = new Blob([payload], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${sanitizeExportFilename(workflow.name)}.aiflow.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)

  if (status) {
    status.okCount = bundle.assets.length
    status.missingCount = Array.isArray(bundle.missingAssets) ? bundle.missingAssets.length : 0
  }
}

interface DrawflowConnection {
  output_id: string | number
  input_id: string | number
  output_class: string
  input_class: string
}

interface DrawflowPortDragInfo {
  nodeId: string
  handle: string
  side: 'in' | 'out'
  type: DrawflowPortType
  element: HTMLElement
}

interface DrawflowNodeRecord {
  id: string
  name: string
  data: FlowNodeData
  class: string
  html: string
  typenode: false
  inputs: Record<string, { connections: Array<{ node: string; input: string }> }>
  outputs: Record<string, { connections: Array<{ node: string; output: string }> }>
  pos_x: number
  pos_y: number
}

interface DrawflowInstance {
  reroute: boolean
  curvature: number
  reroute_curvature_start_end: number
  reroute_curvature: number
  force_first_input: boolean
  line_path: number
  editor_mode: 'edit' | 'fixed' | 'view'
  zoom: number
  zoom_max: number
  zoom_min: number
  zoom_value: number
  zoom_last_value: number
  canvas_x: number
  canvas_y: number
  precanvas: HTMLElement
  node_selected: HTMLElement | null
  ele_selected?: HTMLElement | null
  drag?: boolean
  drag_point?: boolean
  connection?: boolean
  connection_ele?: Element | null
  editor_selected?: boolean
  click?: (event: MouseEvent | TouchEvent) => unknown
  position?: (event: MouseEvent | TouchEvent) => unknown
  dragEnd?: (event: MouseEvent | TouchEvent) => unknown
  start: () => void
  clear: () => void
  import: (data: unknown, notify?: boolean) => void
  addNode: (
    name: string,
    inputs: number,
    outputs: number,
    posX: number,
    posY: number,
    nodeClass: string,
    data: FlowNodeData,
    html: string,
    typenode: false
  ) => string | number
  getNodeFromId: (id: string | number) => { pos_x: number; pos_y: number; data: FlowNodeData }
  updateNodeDataFromId: (id: string | number, data: FlowNodeData) => void
  updateConnectionNodes: (nodeId: string) => void
  addConnection: (source: string, target: string, sourceHandle: string, targetHandle: string) => void
  removeNodeId: (id: string) => void
  removeSingleConnection: (source: string, target: string, sourceHandle: string, targetHandle: string) => void
  contextmenu: (event: Event) => boolean | void
  zoom_in: () => void
  zoom_out: () => void
  zoom_reset: () => void
  zoom_refresh: () => void
  on: (event: string, callback: (payload: any) => void) => void
}

function isStaleDrawflowDomError(error: unknown) {
  return error instanceof TypeError
    && /parentElement|offsetWidth|offsetHeight|classList/.test(error.message)
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function providerLabel(provider: unknown) {
  if (provider === 'google-flow') return 'Google Flow'
  if (provider === 'chatgpt') return 'ChatGPT'
  if (provider === 'grok') return 'Grok'
  if (provider === 'gemini') return 'Gemini'
  if (provider === 'claude') return 'Claude'
  return 'Auto'
}

function providerSlug(provider: unknown) {
  if (provider === 'google-flow') return 'flow'
  if (provider === 'chatgpt') return 'openai'
  if (provider === 'grok') return 'grok'
  return ''
}

const DF_ICONS = {
  generate: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/><circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/><circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/><circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z"/></svg>',
  run: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5L10 8.5z" fill="currentColor" stroke="none"/></svg>',
  download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  delay: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  prompt: 'T',
  wait: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
  zoom: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6"/><path d="M8 11h6"/></svg>',
  download: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  brandFlow: '<svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20.616 10.835a14.147 14.147 0 0 1-4.45-3.001 14.111 14.111 0 0 1-3.678-6.452.503.503 0 0 0-.975 0 14.134 14.134 0 0 1-3.679 6.452 14.155 14.155 0 0 1-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 0 0 0 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 0 1 4.45 3.001 14.112 14.112 0 0 1 3.679 6.453.502.502 0 0 0 .975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 0 1 3.001-4.45 14.113 14.113 0 0 1 6.453-3.678.503.503 0 0 0 0-.975 13.245 13.245 0 0 1-2.003-.678z" fill="#3186FF"/></svg>',
  brandOpenAI: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>',
  brandGrok: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 0 0-1.829-1A8.975 8.975 0 0 0 5.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/></svg>'
}

type DrawflowPortType = 'text' | 'image' | 'video' | 'frame' | 'any'

interface DrawflowPortMeta {
  type: DrawflowPortType
  name: string
  label: string
  required?: boolean
}

const DF_PORT_ICONS: Record<DrawflowPortType, string> = {
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm5.5 4.5v7l6-3.5-6-3.5z"/></svg>',
  frame: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M3 3h18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v2h2V5H4zm0 4v2h2V9H4zm0 4v2h2v-2H4zm0 4v2h2v-2H4zm14-12v2h2V5h-2zm0 4v2h2V9h-2zm0 4v2h2v-2h-2zm0 4v2h2v-2h-2zM7 6v12h10V6H7z"/></svg>',
  any: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>'
}

function nodeMeta(type: FlowNodeType) {
  const meta: Record<string, { icon: string; color: string; title: string; portType: DrawflowPortType }> = {
    prompt: { icon: DF_ICONS.prompt, color: 'prompt', title: 'Prompt', portType: 'text' },
    image: { icon: DF_ICONS.image, color: 'image', title: 'Media', portType: 'image' },
    generate: { icon: DF_ICONS.generate, color: 'generate', title: 'Generate', portType: 'image' },
    delay: { icon: DF_ICONS.delay, color: 'delay', title: 'Wait', portType: 'any' },
    download: { icon: DF_ICONS.download, color: 'download', title: 'Download', portType: 'any' },
    wait: { icon: DF_ICONS.wait, color: 'note', title: 'Wait', portType: 'any' },
    condition: { icon: '?', color: 'condition', title: 'Condition', portType: 'any' },
    loop: { icon: 'L', color: 'condition', title: 'Loop', portType: 'any' },
    merge: { icon: 'M', color: 'merge', title: 'Merge', portType: 'any' },
    split: { icon: 'S', color: 'condition', title: 'Split', portType: 'any' }
  }
  return meta[type] || meta.prompt
}

function drawflowPortGroupsForNode(node: WorkflowNode): { in: DrawflowPortMeta[]; out: DrawflowPortMeta[] } {
  if (node.type === 'prompt') {
    return {
      in: [{ type: 'text', name: 'text_in', label: 'Text' }],
      out: [{ type: 'text', name: 'text', label: 'Text' }]
    }
  }

  if (node.type === 'image') {
    const mediaType = getMediaNodeType(node.data as Record<string, unknown>)
    return {
      in: [],
      out: [{ type: mediaType, name: mediaType, label: mediaType === 'video' ? 'Video' : 'Image' }]
    }
  }

  if (node.type === 'generate') {
    const generateData = { ...(node.data as Record<string, unknown>), ...sanitizeGenerateDataPatch(node.data as Record<string, unknown>, {}) }
    const outputType: DrawflowPortType = getGenerateMediaType(generateData) === 'video' ? 'video' : 'image'
    const inputs: DrawflowPortMeta[] = [
      { type: 'image', name: 'image', label: 'Image' },
      { type: 'text', name: 'prompt', label: 'Prompt', required: true }
    ]
    if (generateNodeSupportsVideoInput(generateData)) {
      inputs.push({ type: 'video', name: 'video', label: 'Video' })
    }

    return {
      in: inputs,
      out: [{ type: outputType, name: outputType, label: outputType === 'video' ? 'Video' : 'Image' }]
    }
  }

  if (node.type === 'download') {
    return {
      in: [{ type: 'image', name: 'image', label: 'Image', required: true }],
      out: []
    }
  }

  return {
    in: [{ type: 'any', name: 'input', label: 'Input' }],
    out: [{ type: 'any', name: 'output', label: 'Output' }]
  }
}

function drawflowPortsForNode(node: WorkflowNode) {
  const ports = drawflowPortGroupsForNode(node)
  return { inputs: ports.in.length, outputs: ports.out.length }
}

function createInputConnections(count: number) {
  const ports: Record<string, { connections: Array<{ node: string; input: string }> }> = {}
  for (let index = 1; index <= count; index += 1) {
    ports[`input_${index}`] = { connections: [] }
  }
  return ports
}

function createOutputConnections(count: number) {
  const ports: Record<string, { connections: Array<{ node: string; output: string }> }> = {}
  for (let index = 1; index <= count; index += 1) {
    ports[`output_${index}`] = { connections: [] }
  }
  return ports
}

function nodeConnectionType(node: WorkflowNode | undefined) {
  if (!node) return 'any'
  if (node.type === 'image') {
    return getMediaNodeType(node.data as Record<string, unknown>)
  }
  if (node.type === 'generate') {
    return getGenerateMediaType(node.data as Record<string, unknown>) === 'video' ? 'video' : 'image'
  }
  return nodeMeta(node.type).portType
}

function providerBadge(provider: unknown) {
  const slug = providerSlug(provider)
  if (!slug) return ''

  const logo = slug === 'flow'
    ? DF_ICONS.brandFlow
    : slug === 'openai'
      ? DF_ICONS.brandOpenAI
      : DF_ICONS.brandGrok

  return `
    <div class="df-node-provider-pill df-node-provider-${slug}">
      <span class="df-node-provider-pill-logo">${logo}</span>
      <span class="df-node-provider-pill-label">${escapeHtml(providerLabel(provider))}</span>
    </div>
  `
}

function nodeHoverToolbar(nodeType: FlowNodeType) {
  // [PromptNodeRunButton] Run button is hidden for prompt and image
  // nodes — both are source/leaf nodes that produce no execution
  // artifact of their own when fired alone. Image already had the
  // gate; prompt was leaking the play icon even though running a
  // prompt standalone is meaningless. Generate / Wait / Download /
  // Condition / Loop / Merge / Split keep the Run button.
  const runButton = nodeType === 'image' || nodeType === 'prompt'
    ? ''
    : `<button type="button" class="df-hover-btn" data-node-action="run" title="Run node">${DF_ICONS.run}</button>`
  // [WorkflowMediaFileCard] Media nodes get a leading "Expand media"
  // button on the hover toolbar so the user can open the lightbox
  // even when the card preview hasn't loaded yet (or when the
  // source asset is a remote URL with no on-card preview). The
  // action is gated to image-type nodes — non-Media nodes keep the
  // legacy Run-first ordering.
  const expandButton = nodeType === 'image'
    ? `<button type="button" class="df-hover-btn" data-node-action="expand-media" title="Expand media" aria-label="Expand media"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>`
    : ''
  return `
    <div class="df-hover-toolbar">
      ${expandButton}
      ${runButton}
      <button type="button" class="df-hover-btn" data-node-action="duplicate" title="Duplicate"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
      <button type="button" class="df-hover-btn" data-node-action="settings" title="Settings"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.17a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 0 1 4 0v.17a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9c.23.61.81 1 1.51 1H21a2 2 0 0 1 0 4h-.17a1.65 1.65 0 0 0-1.43 1z"/></svg></button>
      <button type="button" class="df-hover-btn df-hover-btn-danger" data-node-action="delete" title="Delete node">${DF_ICONS.trash}</button>
    </div>
  `
}

function renderPillTrigger(
  field: NodePillField,
  value: string,
  options: Array<{ value: string; label: string }> | string[]
) {
  const optionItems = normalizePillOptions(options)
  const selected = optionItems.find((option) => option.value === value) || optionItems[0]
  const label = selected?.label || value

  return `
    <button
      type="button"
      class="df-node-tag df-node-pill-trigger nodrag"
      data-node-field="${field}"
      data-node-value="${escapeHtml(value)}"
      aria-haspopup="listbox"
      aria-label="${pillFieldLabel(field)}"
    >
      <span class="df-node-pill-label">${escapeHtml(label)}</span>
      <span class="df-node-select-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6"></path>
        </svg>
      </span>
    </button>
  `
}

function getGenerateOutputImageUrls(output: unknown): string[] {
  const urls: string[] = []
  const seenObjects = new WeakSet<object>()

  const pushUrl = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) urls.push(value)
  }

  const visit = (value: unknown, depth = 0) => {
    if (depth > 3 || !value) return

    if (typeof value === 'string') {
      pushUrl(value)
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }

    if (typeof value !== 'object') return
    if (seenObjects.has(value)) return
    seenObjects.add(value)

    const record = value as Record<string, unknown>
    // URL walking — order matters:
    //   1. videoUrl is read FIRST so a video-only output (where
    //      `url` / `mediaUrl` / `imageUrl` may be empty or carry
    //      the thumbnail image URL) still surfaces the playable
    //      video URL.
    //   2. url, imageUrl, mediaUrl cover the legacy / image
    //      shapes. `imageUrl` is intentionally NOT cleared for
    //      image outputs — ChatGPT and older Flow responses put
    //      the asset URL there.
    //
    // Why this matters:
    //   flow-content.ts + runner.normalizeWorkflowOutput guarantee
    //   that for `mediaType === 'video'` items, `videoUrl` is
    //   populated and `imageUrl` is cleared. Walking `videoUrl`
    //   first lets the Workflow UI surface video URLs even when
    //   the raw `url` / `mediaUrl` happen to be the thumbnail.
    pushUrl(record.videoUrl)
    pushUrl(record.url)
    pushUrl(record.imageUrl)
    pushUrl(record.mediaUrl)
    pushUrl(record.thumbnailUrl)
    pushUrl(record.poster)
    visit(record.images, depth + 1)
    visit(record.imageUrls, depth + 1)
    visit(record.outputs, depth + 1)
    visit(record.result, depth + 1)
  }

  visit(output)
  return Array.from(new Set(urls))
}

/**
 * Per-asset media type detection for a Generate-node output descriptor.
 * Walks the same fields `buildGenerateOutputItems` reads so the Workflow
 * UI's preview/lightbox can render a `<video>` element for video outputs
 * instead of `<img>` (which silently fails on a video URL).
 *
 * Order of preference:
 *   1. Explicit `mediaType` / `type` field on the descriptor.
 *   2. URL heuristic — `.mp4` / `.mov` / `.webm` / `video` markers.
 *   3. Default to `image` (matches the legacy behavior).
 */
function detectGenerateOutputMediaType(item: Record<string, unknown> | undefined): 'image' | 'video' {
  if (!item || typeof item !== 'object') return 'image'
  const rawType = String(item.mediaType || item.type || '').toLowerCase()
  if (rawType === 'video') return 'video'
  if (rawType === 'image') return 'image'
  const url = String(item.url || item.videoUrl || item.mediaUrl || item.imageUrl || '')
  if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)) return 'video'
  if (url.toLowerCase().includes('video')) return 'video'
  return 'image'
}

/**
 * Rich descriptor for one Generate-node output. Used by both the
 * node-bar download handler and the lightbox carousel so they share
 * the same filename/URL resolution — no drift between surfaces.
 *
 * `source` distinguishes where the descriptor came from so callers
 * can introspect when needed (`outputs` = rich auto-download record,
 * `imageUrls` = legacy plain-string array, `fallback` = synthesized).
 */
interface GenerateOutputItem {
  url: string
  /** Best-effort display name (e.g. original filename in the chat
   *  history, sans path). Used by the lightbox header. */
  name?: string
  /** Saved filename the auto-download pipeline produced locally
   *  (e.g. `~/Downloads/flow-output/foo.png`). Used as download
   *  filename preference when chrome.downloads.download needs a
   *  `filename` hint. */
  savedFilename?: string
  /** Mime hint (`image` or `video`). Drives extension choice (.png /
   *  .mp4) when synthesizing a filename. */
  mediaType?: 'image' | 'video'
  /** [AssetStore] Cached assetId → resolved blob URL for this
   *  output. Renderer prefers this over `url` so a reloaded editor
   *  paints the preview from IndexedDB without going through the
   *  remote signed URL. The original `url` stays untouched so
   *  auto-download and downstream consumers keep working. */
  previewUrl?: string
  /** [AssetStore] Cached assetId for this output (kept on the
   *  item so the resolver effect can pre-warm the sync cache even
   *  before the blob URL resolves). */
  assetId?: string
  metadata?: PreviewMetadata
  source: 'outputs' | 'imageUrls' | 'fallback'
}

/**
 * Build a per-output item list for a Generate-node result. Joins the
 * rich `outputs[]` descriptors with the flat `imageUrls[]` fallback so
 * each output gets both a URL and (when available) a savedFilename.
 *
 * The returned list always has the same length as the deduplicated
 * output URL list returned by `getGenerateOutputImageUrls`, so
 * callers can index them interchangeably.
 *
 * `selectedOutputIndex` is the live node-bar index — the function
 * does not read or mutate it. It only enriches the list.
 */
function buildGenerateOutputItems(
  output: Record<string, unknown> | undefined,
  outputUrls: string[]
): GenerateOutputItem[] {
  if (outputUrls.length === 0) return []

  const richOutputs = Array.isArray(output?.outputs)
    ? (output!.outputs as unknown[]).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    : []

  // Build a URL → rich-record map so we can join even when the
  // order of `outputs[]` doesn't match `outputUrls` (e.g. legacy
  // bundles or partial enrichment).
  const richByUrl = new Map<string, Record<string, unknown>>()
  for (const item of richOutputs) {
    // [Workflow] URL resolution now walks `videoUrl` first so a
    // video-only descriptor (where `url` / `mediaUrl` /
    // `imageUrl` may be empty) still surfaces the playable
    // URL. After `runner.normalizeWorkflowOutput`, video items
    // have `videoUrl` / `mediaUrl` / `url` all set to the same
    // video URL and `imageUrl` cleared — this means buildGenerateOutputItems
    // can join them on any of those three URLs.
    const url =
      (typeof item.videoUrl === 'string' && item.videoUrl) ||
      (typeof item.url === 'string' && item.url) ||
      (typeof item.mediaUrl === 'string' && item.mediaUrl) ||
      (typeof item.imageUrl === 'string' && item.imageUrl) ||
      ''
    if (url) richByUrl.set(url, item)
  }

  return outputUrls.map((url, idx) => {
    const rich = richByUrl.get(url)
    if (rich) {
      const savedFilename =
        (typeof rich.savedFilename === 'string' && rich.savedFilename) ||
        (typeof rich.fileNameFromFlow === 'string' && rich.fileNameFromFlow) ||
        undefined
      const name =
        (typeof rich.name === 'string' && rich.name) ||
        (typeof rich.fileNameFromFlow === 'string' && rich.fileNameFromFlow) ||
        (typeof rich.savedFilename === 'string'
          ? (rich.savedFilename.split(/[\\/]/).pop() || rich.savedFilename)
          : undefined) ||
        undefined
      const mediaType: 'image' | 'video' | undefined =
        (typeof rich.mediaType === 'string' && rich.mediaType === 'video') ||
        (typeof rich.type === 'string' && rich.type === 'video')
          ? 'video'
          : (typeof rich.mediaType === 'string' && rich.mediaType === 'image') ||
            (typeof rich.type === 'string' && rich.type === 'image')
            ? 'image'
            : undefined
      const resolvedMediaType = mediaType || detectGenerateOutputMediaType(rich)
      // [AssetStore] Resolve the cached blob URL when this rich
      // descriptor carries an assetId. The original `url` stays
      // untouched so auto-download and downstream consumers keep
      // working — only the renderer's `previewUrl` flips to the
      // blob once IndexedDB has the asset in the sync cache.
      const itemAssetId = typeof rich.assetId === 'string' ? rich.assetId : ''
      const previewUrl = itemAssetId ? syncAssetUrl(itemAssetId) || undefined : undefined
      return {
        url,
        name,
        savedFilename,
        mediaType: resolvedMediaType,
        metadata: buildPreviewMetadata([rich], resolvedMediaType),
        ...(previewUrl ? { previewUrl } : {}),
        ...(itemAssetId ? { assetId: itemAssetId } : {}),
        source: 'outputs' as const,
      }
    }

    // Legacy fallback — flat `imageUrls[]` only. Synthesize a
    // stable basename from the index so downloads are predictable.
    return {
      url,
      name: `flow-output-${idx + 1}`,
      savedFilename: undefined,
      mediaType: url.includes('.mp4') || url.includes('video') ? 'video' : 'image',
      source: 'imageUrls' as const,
    }
  })
}

/** Resolve a usable filename for a Generate output item, applying
 *  the same extension-selection rule the SW download handler does.
 *  `item` may be partial — falls back to `flow-output-N.ext`. */
function resolveGenerateOutputFilename(item: GenerateOutputItem | undefined, idx: number): string {
  const rawName =
    (item?.savedFilename && item.savedFilename.split(/[\\/]/).pop()) ||
    item?.name ||
    `flow-output-${idx + 1}`
  const base = rawName.replace(/\.(png|jpg|jpeg|webp|mp4|mov|webm|gif)$/i, '')
  const isVideo =
    item?.mediaType === 'video' ||
    (typeof item?.url === 'string' && (item.url.includes('.mp4') || item.url.includes('video')))
  return `${base}.${isVideo ? 'mp4' : 'png'}`
}

// Safe download helper for Generate-node outputs.
//
// Routing strategy (in order):
//   1. `chrome.runtime.sendMessage` → background `WORKFLOW_DOWNLOAD_OUTPUT`
//      → `chrome.downloads.download` in the SW. This is the canonical
//      path; `chrome.downloads` is GUARANTEED to exist in the SW
//      context (manifest declares `downloads` permission).
//   2. Direct `chrome.downloads.download` if the UI context happens to
//      have it bound. Guarded with `chrome?.downloads?.download` so we
//      don't crash in contexts where the API isn't exposed.
//   3. Anchor-click fallback. Only viable for same-origin URLs — for
//      cross-origin (`https://labs.google/...`) it opens a new tab.
//      Best-effort only, but at least the user gets the file.
//
// Why we don't just call chrome.downloads from the sidepanel:
//   The previous direct call threw "Cannot read properties of
//   undefined (reading 'download')" in some UI contexts. The SW
//   side of `chrome.runtime.sendMessage` never throws on API
//   presence — chrome.* APIs are always defined inside the SW.
//
// Owner: shared (workflow UI only — not Flow or ChatGPT runtime).
async function downloadWorkflowOutputAsset(args: {
  url: string
  filename: string
  nodeId: string
  selectedOutputIndex: number
}): Promise<{ ok: boolean; path?: string; reason?: string }> {
  const { url, filename } = args
  if (!url) return { ok: false, reason: 'OUTPUT_DOWNLOAD_URL_MISSING' }

  // 1) SW route — preferred.
  try {
    if (typeof globalThis !== 'undefined' && globalThis.chrome?.runtime?.sendMessage) {
      const response = await new Promise<{ success?: boolean; downloadId?: number; error?: string }>((resolve) => {
        try {
          globalThis.chrome.runtime.sendMessage(
            { action: 'WORKFLOW_DOWNLOAD_OUTPUT', payload: { url, filename } },
            (res) => resolve(res || {})
          )
        } catch (e) {
          resolve({ success: false, error: (e as Error).message })
        }
      })
      if (response && response.success) {
        return { ok: true, path: `sw:downloadId=${response.downloadId ?? '?'}` }
      }
      // SW failed — fall through to direct call (still safe to try).
    }
  } catch (err) {
    // ignore — fall through
  }

  // 2) Direct call — only if the UI context has it bound.
  try {
    const chromeApi = (typeof globalThis !== 'undefined' ? (globalThis as any).chrome : undefined)
    if (chromeApi?.downloads?.download) {
      const downloadId = await new Promise<number>((resolve, reject) => {
        try {
          chromeApi.downloads.download(
            {
              url,
              filename,
              saveAs: false,
              conflictAction: 'uniquify',
            },
            (id: number | undefined) => {
              const err = chromeApi.runtime?.lastError
              if (err || !id) {
                reject(new Error(err?.message || 'chrome.downloads.download returned no id'))
              } else {
                resolve(id)
              }
            }
          )
        } catch (e) {
          reject(e)
        }
      })
      return { ok: true, path: `ui:downloadId=${downloadId}` }
    }
  } catch (err) {
    // ignore — fall through to anchor fallback
  }

  // 3) Anchor-click fallback. Same-origin works via download attr;
  //    cross-origin opens in a new tab. User still gets the file.
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
    return { ok: true, path: 'anchor:fallback' }
  } catch (err) {
    return { ok: false, reason: (err as Error).message || 'OUTPUT_DOWNLOAD_FAILED' }
  }
}

function renderDrawflowMediaFileCard(
  node: WorkflowNode,
  data: Record<string, unknown>,
  enabled: boolean,
  ratioClass: string
) {
  // [WorkflowMediaFileCard] New Media (image / video) card layout.
  // Mirrors the mockup: header on top of a dark preview card, badge
  // metadata bottom-left, filename + size in the card footer, and
  // a 3-dot menu + enable toggle in the header. Port / output port
  // are NOT touched — they live on the parent `.drawflow-node`
  // wrapper around `.df-node`, which is still painted unchanged by
  // `renderDrawflowNode`.
  const mediaType = getMediaNodeType(data)
  const mediaSrc = getMediaNodeSource(data)
  const mediaPoster = getMediaNodePoster(data)
  // [WorkflowMediaFileCard] Header label is "Upload" while the node has
  // no asset attached, and only switches to "Image File" / "Video File"
  // once the user has dropped a file in. The empty state must NEVER
  // advertise a file type that isn't loaded yet — otherwise the user
  // thinks they already have media attached when they don't.
  const labelText = mediaSrc ? getMediaCardLabel(mediaType) : 'Upload'
  const label = escapeHtml(labelText)
  const cardLabel = `${labelText} · Media`
  // Metadata is meaningful only while a renderable asset exists.
  // Imported/legacy nodes may retain filename/dimensions after their
  // blob or remote URL is gone; never surface those stale values in
  // the empty Upload state.
  const dims = mediaSrc ? getMediaCardDimensions(data) : { width: 0, height: 0 }
  const fileName = mediaSrc ? getMediaCardFileName(data) : ''
  const byteSize = mediaSrc ? getMediaCardByteSize(data) : 0
  const durationSeconds = mediaSrc ? getMediaCardDurationSeconds(data) : 0

  const dimPart = dims.width > 0 && dims.height > 0
    ? `${dims.width}\u00d7${dims.height}`
    : ''
  const durationPart = mediaType === 'video' && durationSeconds > 0
    ? formatMediaDuration(durationSeconds)
    : ''
  const metaTextParts: string[] = []
  if (dimPart) metaTextParts.push(dimPart)
  if (durationPart) metaTextParts.push(durationPart)
  const metaText = escapeHtml(metaTextParts.join(' \u00b7 '))

  const fileNameText = escapeHtml(fileName || 'Select image or video to upload')
  const sizeText = escapeHtml(formatMediaFileSize(byteSize) || '—')

  const previewInner = mediaSrc
    ? (
      mediaType === 'video'
        ? (
          mediaPoster
            ? `<img class="df-node-preview-media" src="${escapeHtml(mediaPoster)}" alt="" draggable="false">`
            : `<video class="df-node-preview-media" src="${escapeHtml(mediaSrc)}" muted playsinline preload="metadata" draggable="false" aria-label="Video preview"></video>`
        )
        : `<img class="df-node-preview-media" src="${escapeHtml(mediaSrc)}" alt="" draggable="false">`
    )
    : `<div class="df-node-preview-placeholder"><span class="workflow-media-file-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></span><span class="workflow-media-file-empty-text">Drop image / video here</span></div>`

  const previewRemoveButton = mediaSrc
    ? `<button type="button" class="workflow-media-file-remove nodrag" data-node-action="remove-media" title="Remove media" aria-label="Remove media">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>`
    : ''

  const previewOpenButton = mediaSrc
    ? `<button type="button" class="df-node-image-preview-button nodrag" data-node-action="preview-image" title="Preview media" aria-label="Preview media">
                ${DF_ICONS.zoom}
              </button>`
    : ''

  const metaBadge = mediaSrc && metaText
    ? `<div class="workflow-media-file-meta" aria-hidden="true">${metaText}</div>`
    : ''

  const footerBlock = mediaSrc ? `
        <div class="workflow-media-file-footer">
          <span class="workflow-media-file-name" title="${fileNameText}">${fileNameText}</span>
          <span class="workflow-media-file-size">${sizeText}</span>
        </div>
      ` : ''

  const cardBody = `
    <div class="workflow-media-file-card ${mediaSrc ? 'has-image' : ''}">
      <div class="workflow-media-file-header">
        <span class="workflow-media-file-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </span>
        <span class="workflow-media-file-label">${label}</span>
        <button
          type="button"
          class="df-node-toggle ${enabled ? 'on' : 'off'}"
          title="${enabled ? 'Disable node' : 'Enable node'}"
          aria-label="${enabled ? 'Disable node' : 'Enable node'}"
        >
          <span class="df-node-toggle-track"><span class="df-node-toggle-thumb"></span></span>
        </button>
      </div>
      <div class="workflow-media-file-preview df-node-image-upload-target ${ratioClass} ${mediaSrc ? 'has-image' : ''}" data-image-upload-target="true" aria-label="${escapeHtml(cardLabel)}">
        ${previewInner}
        ${previewOpenButton}
        ${previewRemoveButton}
        ${metaBadge}
      </div>
      ${footerBlock}
    </div>
  `

  return `<div class="workflow-media-file-node" data-workflow-node-id="${escapeHtml(node.id)}">
        ${cardBody}
      </div>`
}

function getGenerateNodeTitle(data: Record<string, unknown>): string {
  const output = data._output as Record<string, unknown> | undefined
  const outputUrls = getGenerateOutputImageUrls(output)
  if (outputUrls.length === 0) return 'New Generate Node'

  const selectedOutputIndex = Math.max(
    0,
    Math.min(outputUrls.length - 1, Number(data.selectedOutputIndex) || 0)
  )
  const outputItems = buildGenerateOutputItems(output, outputUrls)
  const selectedOutput = outputItems[selectedOutputIndex] || outputItems[0]
  const outputMediaType = selectedOutput?.mediaType || getGenerateMediaType(data)
  return getMediaCardLabel(outputMediaType)
}

function renderDrawflowNode(node: WorkflowNode) {
  const data = node.data as Record<string, unknown>
  const generateData = node.type === 'generate'
    ? { ...data, ...sanitizeGenerateDataPatch(data, {}) }
    : data
  const meta = nodeMeta(node.type)
  const rawLabel = node.type === 'image' && (!data.label || data.label === 'New Image Node' || data.label === 'image')
    ? 'New Media Node'
    : node.type === 'prompt'
      ? (String(data.prompt || '').trim() ? 'Prompt' : 'New Prompt Node')
      : node.type === 'generate'
        ? getGenerateNodeTitle(generateData)
      : data.label || meta.title
  const label = escapeHtml(rawLabel)
  const provider = providerSlug(generateData.provider)
  const prompt = escapeHtml(String(data.prompt || '').slice(0, 150))
  const enabled = data.enabled !== false
  const providerPill = node.type === 'generate' ? providerBadge(generateData.provider) : ''
  const aspectRatio = String(data.aspectRatio || '1:1')
  const ratioClass = `ratio-${aspectRatio.replace(':', '-')}`

  // [WorkflowMediaFileCard] Media nodes opt out of the legacy
  // .df-node / .df-node-header chrome and use the new card layout.
  // The outer Drawflow wrapper, .input / .output port children,
  // and the `data-workflow-node-id` anchor that drawflow.js reads
  // stay intact — only the inner card body changes. Port position
  // is set by Drawflow's `.drawflow-node .output` rules in CSS, not
  // by us.
  if (node.type === 'image') {
    return `
    <div class="df-node workflow-media-file-shell ${!enabled ? 'df-node-disabled' : ''}" data-node-type="${escapeHtml(node.type)}" data-provider="${provider}" data-enabled="${enabled}" data-workflow-node-id="${escapeHtml(node.id)}">
      ${providerPill}
      ${nodeHoverToolbar(node.type)}
      ${renderDrawflowMediaFileCard(node, data, enabled, ratioClass)}
    </div>
  `
  }

  let body = ''
  if (node.type === 'prompt') {
    body = prompt
      ? `<div class="df-node-prompt df-node-prompt-inline" data-prompt-editable="true">${prompt}</div>`
      : '<div class="df-node-prompt df-node-prompt-inline df-node-prompt-empty" data-prompt-editable="true">Empty prompt</div>'
    body += `
      <div class="df-node-settings-bar">
        ${renderPillTrigger('provider', String(data.provider || 'chatgpt'), PROVIDER_OPTIONS)}
        <span class="df-node-tag">Text</span>
      </div>
    `
  } else if (node.type === 'image') {
    const mediaType = getMediaNodeType(data)
    const mediaSrc = getMediaNodeSource(data)
    const mediaPoster = getMediaNodePoster(data)
    body = `
      <div class="df-node-preview df-node-image-upload-target ${mediaSrc ? 'has-image' : ''} ${ratioClass}" data-image-upload-target="true">
        ${
          mediaSrc
            ? `
              ${
                mediaType === 'video'
                  ? mediaPoster
                    ? `<img class="df-node-preview-media" src="${escapeHtml(mediaPoster)}" alt="" draggable="false">`
                    : `<div class="df-node-preview-placeholder">${DF_PORT_ICONS.video}</div>`
                  : `<img class="df-node-preview-media" src="${escapeHtml(mediaSrc)}" alt="" draggable="false">`
              }
              <button type="button" class="df-node-image-preview-button nodrag" data-node-action="preview-image" title="Preview media" aria-label="Preview media">
                ${DF_ICONS.zoom}
              </button>
            `
            : `<div class="df-node-preview-placeholder">${DF_ICONS.image}</div>`
        }
      </div>
    `
  } else if (node.type === 'generate') {
    const mediaType = getGenerateMediaType(generateData)
    const ratioOptions = getGenerateAspectRatioOptions(generateData)
    const modelOptions = getGenerateModelOptions(generateData)
    const durationOptions = getGenerateVideoDurationOptions(generateData)
    const generateAspectRatio = String(generateData.aspectRatio || ratioOptions[0] || '1:1')
    const generateRatioClass = `ratio-${generateAspectRatio.replace(':', '-')}`
    const generateModel = String(generateData.model || modelOptions[0] || '')
    const generateDuration = String(generateData.videoDuration || durationOptions[0] || VIDEO_DURATION_OPTIONS[1])
    const supportsVideo = generateProviderSupportsVideo(generateData.provider)
    const isGoogleFlow = String(generateData.provider || 'chatgpt') === 'google-flow'
    const quantityValue = String(generateData.quantity ?? 1)
    const quantityOptions = isGoogleFlow ? GENERATE_QUANTITY_OPTIONS : []
    const generateResolution = String(
      isGoogleFlow && GENERATE_RESOLUTION_OPTIONS.some((opt) => opt.value === generateData.resolution)
        ? generateData.resolution
        : GENERATE_DEFAULT_RESOLUTION
    )

    // Output preview: if node completed and has images, show the
    // user's currently selected image in a carousel. When the user
    // has multiple outputs (e.g. quantity=2), the carousel bar
    // (top-left of the preview) lets them click prev/next to switch
    // which asset downstream nodes receive. The default is index 0
    // (the first asset).
    const output = data._output as Record<string, unknown> | undefined
    const outputImageUrls = getGenerateOutputImageUrls(output)
    const hasMultipleOutputs = outputImageUrls.length > 1
    const selectedOutputIndex = Math.max(0, Math.min(
      outputImageUrls.length - 1,
      Number((data as Record<string, unknown>).selectedOutputIndex) || 0
    ))
    // Build rich per-output items so the preview can branch on
    // `mediaType === 'video'` (render `<video>`) vs `image` (render
    // `<img>`). Without this branch, the preview would render every
    // generated output as `<img src=...>` and video outputs would
    // silently fail (broken image icon).
    const outputItems = buildGenerateOutputItems(
      output as Record<string, unknown> | undefined,
      outputImageUrls
    )
    const firstImageUrl = outputImageUrls[selectedOutputIndex] || outputImageUrls[0] || ''
    const selectedOutputItem = outputItems[selectedOutputIndex] || outputItems[0]
    // [AssetStore] Prefer the cached blob URL when available so the
    // preview paints from IndexedDB. The fallback chain is:
    //   previewUrl (cached blob) → firstImageUrl (original URL).
    const firstPreviewUrl = selectedOutputItem?.previewUrl || firstImageUrl
    const previewMediaType: 'image' | 'video' = selectedOutputItem?.mediaType === 'video'
      ? 'video'
      : 'image'
    // For video previews: resolve the playable URL and poster. The
    // runner.normalizeWorkflowOutput contract guarantees `videoUrl`
    // is populated for video outputs; we still fall back to mediaUrl
    // / url / thumbnailUrl for legacy bundles.
    const previewVideoSrc = selectedOutputItem
      ? String(selectedOutputItem.previewUrl || selectedOutputItem.url || '')
      : ''
    // [AssetStore] Poster chain — cached assetId first, then original
    // `thumbnailUrl` / `poster`. The cached assetId path is preferred
    // so a video whose poster URL expired still paints a poster.
    const posterAssetIdFromOutput =
      typeof (output as Record<string, unknown> | undefined)?.posterAssetId === 'string'
        ? String((output as Record<string, unknown> | undefined)?.posterAssetId)
        : typeof (output as Record<string, unknown> | undefined)?.thumbnailAssetId === 'string'
          ? String((output as Record<string, unknown> | undefined)?.thumbnailAssetId)
          : ''
    const cachedPosterUrl = posterAssetIdFromOutput ? syncAssetUrl(posterAssetIdFromOutput) : ''
    const previewPoster = selectedOutputItem
      ? String(
        cachedPosterUrl
        || selectedOutputItem.previewUrl
        || (output as Record<string, unknown> | undefined)?.thumbnailUrl
        || (output as Record<string, unknown> | undefined)?.poster
        || ''
      )
      : ''
    const hasOutput = (firstPreviewUrl || firstImageUrl).length > 0

    body = `
      <div class="df-node-preview-wrap df-node-generate-preview-wrap">
        ${hasOutput ? `
          <div class="df-node-output-preview df-node-image-upload-target has-image ${generateRatioClass} ${previewMediaType === 'video' ? 'df-node-output-preview-video' : 'df-node-output-preview-image'}" data-generated-output-preview="true" data-selected-output-index="${selectedOutputIndex}" data-preview-media-type="${previewMediaType}">
            ${previewMediaType === 'video' ? `
              <video
                class="df-node-preview-media df-node-preview-video"
                src="${escapeHtml(previewVideoSrc)}"
                ${previewPoster ? `poster="${escapeHtml(previewPoster)}"` : ''}
                muted
                playsinline
                preload="metadata"
                draggable="false"
                aria-label="Generated video preview"
              ></video>
              <span class="df-node-video-play-badge" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </span>
            ` : `
              <img class="df-node-preview-media" src="${escapeHtml(firstPreviewUrl)}" alt="Generated output" draggable="false">
            `}
            ${/* [Workflow] Skeleton / shimmer only renders while a
                generated output is in flight (no usable URL yet). Once
                `hasOutput` is true — image decoded or video metadata
                ready — we drop the overlay so it doesn't paint stripes
                on top of the finished content. The `df-node-output-top-gradient`
                + preview button + carousel bar still give the user the
                same hover affordances. CSS below also hides the
                skeleton when `data-run-state="completed"` as a safety net. */
              hasOutput ? '' : '<span class="df-node-output-skeleton" aria-hidden="true"></span>'
            }
            <span class="df-node-output-top-gradient" aria-hidden="true"></span>
            <button type="button" class="df-node-image-preview-button nodrag" data-node-action="preview-image" title="Preview output" aria-label="Preview output">
              ${DF_ICONS.zoom}
            </button>
            <div class="df-node-output-carousel-bar nodrag" role="group" aria-label="Output carousel">
              ${hasMultipleOutputs ? `
                <button type="button" class="df-node-output-carousel-prev nodrag" data-node-action="output-prev" title="Previous output" aria-label="Previous output">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
              ` : ''}
              <span class="df-node-output-carousel-counter" aria-live="polite">${selectedOutputIndex + 1} / ${outputImageUrls.length}</span>
              ${hasMultipleOutputs ? `
                <button type="button" class="df-node-output-carousel-next nodrag" data-node-action="output-next" title="Next output" aria-label="Next output">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              ` : ''}
              <span class="df-node-output-carousel-sep" aria-hidden="true"></span>
              <button type="button" class="df-node-output-carousel-download nodrag" data-node-action="output-download" data-output-index="${selectedOutputIndex}" title="Download current output" aria-label="Download current output">
                ${DF_ICONS.download}
              </button>
            </div>
          </div>
        ` : `
          <div class="df-node-preview ${generateRatioClass}">
            <div class="df-node-preview-placeholder">${mediaType === 'video' ? DF_ICONS.generate : DF_ICONS.image}</div>
          </div>
        `}
        ${prompt ? `<div class="df-node-prompt df-node-prompt-overlay nodrag">${prompt}</div>` : ''}
        <div class="df-node-settings-bar df-node-settings-bar-overlay">
          ${renderPillTrigger('provider', String(generateData.provider || 'chatgpt'), PROVIDER_OPTIONS)}
          ${supportsVideo ? renderPillTrigger('mediaType', mediaType, GENERATE_MEDIA_TYPE_OPTIONS) : ''}
          ${isGoogleFlow && mediaType === 'video'
            ? renderPillTrigger(
                'flowVideoMode',
                String(generateData.flowVideoMode || ''),
                FLOW_VIDEO_MODE_OPTIONS
              )
            : ''}
          ${modelOptions.length ? renderPillTrigger('model', generateModel, modelOptions) : ''}
          ${mediaType === 'video' ? renderPillTrigger('videoDuration', generateDuration, durationOptions) : ''}
          ${renderPillTrigger('aspectRatio', generateAspectRatio, ratioOptions)}
          ${isGoogleFlow ? renderPillTrigger('quantity', quantityValue, quantityOptions) : ''}
          ${isGoogleFlow && mediaType === 'image' ? renderPillTrigger('resolution', generateResolution, GENERATE_RESOLUTION_OPTIONS) : ''}
        </div>
      </div>
    `
  } else if (node.type === 'delay') {
    body = `
      <div class="df-node-delay-setting">
        <span>Wait</span>
        <input type="number" class="df-node-inline-input df-delay-seconds" value="${Math.round(Number(data.duration || 1000) / 1000)}" min="1" max="300" readonly>
        <span>seconds</span>
      </div>
    `
  } else if (node.type === 'download') {
    body = `
      <div class="df-node-download-info">Automatically download results from previous node</div>
      <div class="df-node-settings-bar">
        <span class="df-node-tag">${escapeHtml(data.format || 'png')}</span>
        <span class="df-node-tag">${data.autoDownload === false ? 'Manual' : 'Auto'}</span>
      </div>
    `
  } else if (node.type === 'wait') {
    body = `
      <div class="df-node-download-info">${escapeHtml(data.condition || 'manual')}</div>
      <div class="df-node-settings-bar">
        <span class="df-node-tag">Condition</span>
      </div>
    `
  } else {
    body = '<div class="df-node-download-info">Configure in inspector</div>'
  }

  return `
    <div class="df-node ${!enabled ? 'df-node-disabled' : ''}" data-node-type="${escapeHtml(node.type)}" data-provider="${provider}" data-enabled="${enabled}" data-workflow-node-id="${escapeHtml(node.id)}">
      ${providerPill}
      ${nodeHoverToolbar(node.type)}
      <div class="df-node-header">
        <div class="df-node-icon ${meta.color}">${meta.icon}</div>
        <div class="df-node-title">${label}</div>
        <button
          type="button"
          class="df-node-toggle ${enabled ? 'on' : 'off'}"
          title="${enabled ? 'Disable node' : 'Enable node'}"
          aria-label="${enabled ? 'Disable node' : 'Enable node'}"
        >
          <span class="df-node-toggle-track"><span class="df-node-toggle-thumb"></span></span>
        </button>
      </div>
      <div class="df-node-body">${body}</div>
    </div>
  `
}

function buildDrawflowData(workflow: Workflow) {
  const data: Record<string, DrawflowNodeRecord> = {}

  for (const node of workflow.nodes) {
    const ports = drawflowPortsForNode(node)
    const portType = nodeConnectionType(node)
    data[node.id] = {
      id: node.id,
      name: node.type,
      data: cloneDeep(node.data),
      class: `ai-df-wrapper ai-df-wrapper-${node.type} df-port-${portType}`,
      html: renderDrawflowNode(node),
      typenode: false,
      inputs: createInputConnections(ports.inputs),
      outputs: createOutputConnections(ports.outputs),
      pos_x: node.position.x,
      pos_y: node.position.y
    }
  }

  for (const edge of workflow.edges) {
    const source = data[edge.source]
    const target = data[edge.target]
    if (!source || !target) continue

    const sourceHandle = edge.sourceHandle || 'output_1'
    const targetHandle = edge.targetHandle || 'input_1'
    if (!source.outputs[sourceHandle] || !target.inputs[targetHandle]) continue
    source.outputs[sourceHandle] ||= { connections: [] }
    target.inputs[targetHandle] ||= { connections: [] }
    source.outputs[sourceHandle].connections.push({ node: edge.target, output: targetHandle })
    target.inputs[targetHandle].connections.push({ node: edge.source, input: sourceHandle })
  }

  return { drawflow: { Home: { data } } }
}

function getNodePortSignature(node: WorkflowNode) {
  const ports = drawflowPortGroupsForNode(node)
  const inputSignature = ports.in.map((port) => `${port.name}:${port.type}`).join(',')
  const outputSignature = ports.out.map((port) => `${port.name}:${port.type}`).join(',')
  return `in(${inputSignature})|out(${outputSignature})`
}

// [CanvasFix] Hotfix for canvas drag flicker.
//
// PREVIOUSLY: signature included `Math.round(node.position.x)` and
// `Math.round(node.position.y)`. Drawflow fires `nodeMoved`
// 30–60 Hz during drag, each tick calling `updateNodePosition`,
// which mutated `position` and bumped `updatedAt`. Math.round()
// crossing a pixel boundary changed the signature →
// `hydrateDrawflow()` ran → `editor.import(...)` rebuilt the
// entire DOM mid-drag → every node + line flickered.
//
// NOW: signature only includes structural fields (id, type,
// ports, edges, workflow id). Position changes cannot trigger
// reimport. A separate `positionSignature` consumer (currently
// unused — see `getWorkflowPositionSignature` below) is kept so
// any future code that DOES need position-aware re-render has an
// explicit opt-in rather than piggybacking on the structural key.
function getWorkflowStructureSignature(workflow: Workflow) {
  const nodes = workflow.nodes
    .map((node) => `${node.id}:${node.type}:${getNodePortSignature(node)}`)
    .join('|')
  const edges = workflow.edges
    .map((edge) => `${edge.source}:${edge.target}:${edge.sourceHandle || ''}:${edge.targetHandle || ''}`)
    .join('|')
  return `${workflow.id}::${nodes}::${edges}`
}

// Position-only signature — kept intentionally NOT wired into the
// hydrate effect. If a future feature needs to react to drag-end
// position changes only, it should consume this directly (e.g.
// snap-to-grid alignment, layout analytics) rather than the
// structural signature.
function getWorkflowPositionSignature(workflow: Workflow): string {
  const positions = workflow.nodes
    .map((node) => `${node.id}:${Math.round(node.position.x)}:${Math.round(node.position.y)}`)
    .join('|')
  return `${workflow.id}::${positions}`
}

function getWorkflowDataSignature(workflow: Workflow) {
  return workflow.nodes
    .map((node) => `${node.id}:${JSON.stringify(node.data)}`)
    .join('|')
}

function buildWorkflowSliceForTarget(workflow: Workflow, targetNodeId: string): Workflow | null {
  const targetNode = workflow.nodes.find((node) => node.id === targetNodeId)
  if (!targetNode) return null

  const incomingByTarget = new Map<string, WorkflowEdge[]>()
  for (const edge of workflow.edges) {
    const list = incomingByTarget.get(edge.target) || []
    list.push(edge)
    incomingByTarget.set(edge.target, list)
  }

  const nodeIds = new Set<string>([targetNodeId])
  const edgeIds = new Set<string>()
  const stack = [targetNodeId]

  while (stack.length > 0) {
    const nodeId = stack.pop()
    if (!nodeId) continue
    for (const edge of incomingByTarget.get(nodeId) || []) {
      edgeIds.add(edge.id)
      if (!nodeIds.has(edge.source)) {
        nodeIds.add(edge.source)
        stack.push(edge.source)
      }
    }
  }

  const nodes = workflow.nodes
    .filter((node) => nodeIds.has(node.id))
    .map((node) => cloneDeep(node))
  const edges = workflow.edges
    .filter((edge) => edgeIds.has(edge.id) && nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => cloneDeep(edge))

  return {
    ...workflow,
    name: `${workflow.name} / ${String(targetNode.data?.label || targetNode.type)}`,
    nodes,
    edges
  }
}

interface NodeInspectorProps {
  workflow: Workflow
  nodeId: string
  onClose: () => void
  onSaveMediaUrl: (nodeId: string, url: string) => Promise<{ mediaType: MediaNodeType; unlinkedCount: number }>
}

const NodeInspector: React.FC<NodeInspectorProps> = ({ workflow, nodeId, onClose, onSaveMediaUrl }) => {
  const updateNode = useWorkflowStore((s) => s.updateNode)
  const deleteNode = useWorkflowStore((s) => s.deleteNode)
  const node = workflow.nodes.find((item) => item.id === nodeId)
  const nodeData = (node?.data || {}) as Record<string, unknown>
  const persistedMediaUrl = node?.type === 'image'
    ? String(getMediaNodeType(nodeData) === 'video' ? nodeData.videoUrl || nodeData.mediaUrl || '' : nodeData.imageUrl || nodeData.mediaUrl || '')
    : ''
  const [mediaUrlDraft, setMediaUrlDraft] = useState(persistedMediaUrl)
  const [mediaUrlSaving, setMediaUrlSaving] = useState(false)
  const [mediaUrlFeedback, setMediaUrlFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    setMediaUrlDraft(persistedMediaUrl)
  }, [nodeId, persistedMediaUrl])

  useEffect(() => {
    setMediaUrlFeedback(null)
  }, [nodeId])

  if (!node) {
    return null
  }

  const data = nodeData
  const update = (field: string, value: unknown) => updateNode(node.id, { [field]: value } as Partial<FlowNodeData>)
  const updateGenerate = (patch: Record<string, unknown>) => {
    updateNode(node.id, sanitizeGenerateDataPatch(data, patch) as Partial<FlowNodeData>)
  }
  const generateData = node.type === 'generate'
    ? { ...data, ...sanitizeGenerateDataPatch(data, {}) }
    : data
  const generateProvider = String(generateData.provider || 'chatgpt')
  const generateSupportsVideo = node.type === 'generate' && generateProviderSupportsVideo(generateProvider)
  const generateMediaType = node.type === 'generate' ? getGenerateMediaType(generateData) : 'image'
  const generateModelOptions = node.type === 'generate' ? getGenerateModelOptions(generateData) : []
  const generateDurationOptions = node.type === 'generate' ? getGenerateVideoDurationOptions(generateData) : []
  const aspectRatioOptions = node.type === 'generate' ? getGenerateAspectRatioOptions(generateData) : ASPECT_RATIO_OPTIONS
  const aspectRatioValue = node.type === 'generate'
    ? String(generateData.aspectRatio || aspectRatioOptions[0] || '1:1')
    : String(data.aspectRatio || '1:1')
  const generateModelValue = String(generateData.model || generateModelOptions[0] || '')
  const generateDurationValue = String(generateData.videoDuration || generateDurationOptions[0] || VIDEO_DURATION_OPTIONS[1])
  const fieldLabelClass = 'mb-1.5 block text-[11px] font-medium text-white/50'
  const fieldControlClass = 'h-8 w-full rounded-lg border border-white/5 bg-[#141414] px-2.5 text-[11px] text-white/60 outline-none transition-colors placeholder:text-white/25 focus:border-white/10 focus:ring-1 focus:ring-white/10'
  const fieldSelectClass = cn(fieldControlClass, 'appearance-none pr-8 [background-image:none]')
  const fieldTextAreaClass = 'w-full resize-none rounded-lg border border-white/5 bg-[#141414] px-2.5 py-2 text-[11px] leading-relaxed text-white/70 outline-none transition-colors placeholder:text-white/25 focus:border-white/10 focus:ring-1 focus:ring-white/10'
  const toggleRowClass = 'flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-[#141414] px-3 py-2'
  const toggleLabelClass = 'text-[11px] font-medium text-white/50'
  const selectIconClass = 'pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35'
  const saveMediaUrl = async () => {
    const url = mediaUrlDraft.trim()
    if (!url || mediaUrlSaving) return
    setMediaUrlSaving(true)
    setMediaUrlFeedback(null)
    try {
      const result = await onSaveMediaUrl(node.id, url)
      setMediaUrlFeedback({
        tone: 'success',
        message: `${result.mediaType === 'video' ? 'Video' : 'Image'} URL saved${result.unlinkedCount > 0 ? ` · ${result.unlinkedCount} incompatible link${result.unlinkedCount === 1 ? '' : 's'} removed` : ''}.`
      })
    } catch (error) {
      setMediaUrlFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to save this media URL.'
      })
    } finally {
      setMediaUrlSaving(false)
    }
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-white/[0.06] bg-[#111111]">
      <div className="flex h-14 items-center justify-between border-b border-white/[0.06] px-4">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium text-white/80">
            {String(node.type === 'image' && (!data.label || data.label === 'New Image Node') ? 'New Media Node' : data.label || node.type)}
          </p>
          <p className="text-[10px] text-white/30">{node.type === 'image' ? 'media' : node.type}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            title="Delete node"
            onClick={() => deleteNode(node.id)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Close"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-4">
        {node.type !== 'image' && (
          <label className="block">
            <span className={fieldLabelClass}>Name</span>
            <input
              value={String(data.label || '')}
              onChange={(event) => update('label', event.target.value)}
              className={fieldControlClass}
            />
          </label>
        )}

        {(node.type === 'prompt' || node.type === 'generate') && (
          <label className="block">
            <span className={fieldLabelClass}>Provider</span>
            <div className="relative">
              <select
                value={node.type === 'generate' ? generateProvider : String(data.provider || 'chatgpt')}
                onChange={(event) => (
                  node.type === 'generate'
                    ? updateGenerate({ provider: event.target.value as AIProvider })
                    : update('provider', event.target.value as AIProvider)
                )}
                className={fieldSelectClass}
              >
                {PROVIDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <ChevronDown className={selectIconClass} />
            </div>
          </label>
        )}

        {generateSupportsVideo && (
          <label className="block">
            <span className={fieldLabelClass}>Media Type</span>
            <div className="relative">
              <select
                value={generateMediaType}
                onChange={(event) => updateGenerate({ mediaType: event.target.value })}
                className={fieldSelectClass}
              >
                {GENERATE_MEDIA_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <ChevronDown className={selectIconClass} />
            </div>
          </label>
        )}

        {node.type === 'prompt' && (
          <label className="block">
            <span className={fieldLabelClass}>Prompt</span>
            <textarea
              value={String(data.prompt || '')}
              onChange={(event) => update('prompt', event.target.value)}
              onBlur={(event) => {
                const currentLabel = String(data.label || '').trim()
                const promptValue = event.currentTarget.value
                if (!currentLabel || currentLabel === 'New Prompt Node' || currentLabel === 'Prompt') {
                  update('label', promptValue.trim() ? 'Prompt' : 'New Prompt Node')
                }
              }}
              rows={8}
              className={fieldTextAreaClass}
            />
          </label>
        )}

        {node.type === 'prompt' && (
          <label className="block">
            <span className={fieldLabelClass}>Model</span>
            <input
              value={String(data.model || '')}
              onChange={(event) => update('model', event.target.value)}
              placeholder="Auto"
              className={fieldControlClass}
            />
          </label>
        )}

        {node.type === 'generate' && generateModelOptions.length > 0 && (
          <label className="block">
            <span className={fieldLabelClass}>Model</span>
            <div className="relative">
              <select
                value={generateModelValue}
                onChange={(event) => updateGenerate({ model: event.target.value })}
                className={fieldSelectClass}
              >
                {generateModelOptions.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
              <ChevronDown className={selectIconClass} />
            </div>
          </label>
        )}

        {node.type === 'generate' && generateMediaType === 'video' && (
          <label className="block">
            <span className={fieldLabelClass}>Duration</span>
            <div className="relative">
              <select
                value={generateDurationValue}
                onChange={(event) => updateGenerate({ videoDuration: event.target.value })}
                className={fieldSelectClass}
              >
                {generateDurationOptions.map((duration) => (
                  <option key={duration} value={duration}>{duration}</option>
                ))}
              </select>
              <ChevronDown className={selectIconClass} />
            </div>
          </label>
        )}

        {(node.type === 'image' || node.type === 'generate') && (
          <label className="block">
            <span className={fieldLabelClass}>Aspect Ratio</span>
            <div className="relative">
              <select
                value={aspectRatioValue}
                onChange={(event) => (
                  node.type === 'generate'
                    ? updateGenerate({ aspectRatio: event.target.value })
                    : update('aspectRatio', event.target.value)
                )}
                className={fieldSelectClass}
              >
                {aspectRatioOptions.map((ratio) => (
                  <option key={ratio} value={ratio}>{ratio}</option>
                ))}
              </select>
              <ChevronDown className={selectIconClass} />
            </div>
          </label>
        )}

        {node.type === 'generate' && generateProvider === 'google-flow' && (
          <label className="block">
            <span className={fieldLabelClass}>Quantity</span>
            <div className="relative">
              <select
                value={String(Math.max(1, Math.min(4, Number(generateData.quantity ?? 1))))}
                onChange={(event) => updateGenerate({ quantity: Number(event.target.value) })}
                className={fieldSelectClass}
              >
                {GENERATE_QUANTITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <ChevronDown className={selectIconClass} />
            </div>
          </label>
        )}

        {node.type === 'generate' && generateProvider === 'google-flow' && generateMediaType === 'image' && (
          <label className="block">
            <span className={fieldLabelClass}>Resolution</span>
            <div className="relative">
              <select
                value={String(
                  GENERATE_RESOLUTION_OPTIONS.some((opt) => opt.value === generateData.resolution)
                    ? generateData.resolution
                    : GENERATE_DEFAULT_RESOLUTION
                )}
                onChange={(event) => updateGenerate({ resolution: event.target.value as '1k' | '2k' | '4k' })}
                className={fieldSelectClass}
              >
                {GENERATE_RESOLUTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <ChevronDown className={selectIconClass} />
            </div>
          </label>
        )}

        {node.type === 'image' && (
          <div className="block">
            <span className={fieldLabelClass}>Media URL</span>
            <div className="flex items-center gap-2">
              <input
                value={mediaUrlDraft}
                onChange={(event) => {
                  setMediaUrlDraft(event.target.value)
                  setMediaUrlFeedback(null)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  void saveMediaUrl()
                }}
                placeholder="https://..."
                className={cn(fieldControlClass, 'min-w-0 flex-1')}
              />
              <button
                type="button"
                disabled={!mediaUrlDraft.trim() || mediaUrlSaving}
                onClick={() => void saveMediaUrl()}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#7C5CFF] px-3 text-[10px] font-semibold text-white transition-colors hover:bg-[#8768FF] disabled:cursor-not-allowed disabled:opacity-35"
              >
                {mediaUrlSaving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save URL
              </button>
            </div>
            {mediaUrlFeedback && (
              <p className={cn(
                'mt-1.5 text-[9px] leading-relaxed',
                mediaUrlFeedback.tone === 'success' ? 'text-emerald-300/75' : 'text-red-300/80'
              )}>
                {mediaUrlFeedback.message}
              </p>
            )}
          </div>
        )}

        {node.type === 'generate' && (
          <div className="space-y-3">
            <label className={toggleRowClass}>
              <span className={toggleLabelClass}>Auto generate</span>
              <input
                type="checkbox"
                checked={data.autoGenerate !== false}
                onChange={(event) => update('autoGenerate', event.target.checked)}
                className="h-3.5 w-3.5 accent-[#7C5CFF]"
              />
            </label>
            <label className={toggleRowClass}>
              <span className={toggleLabelClass}>Wait for result</span>
              <input
                type="checkbox"
                checked={data.waitForCompletion !== false}
                onChange={(event) => update('waitForCompletion', event.target.checked)}
                className="h-3.5 w-3.5 accent-[#7C5CFF]"
              />
            </label>
            <label className="block">
              <span className={fieldLabelClass}>Timeout ms</span>
              <input
                type="number"
                value={Number(data.timeout || 90000)}
                onChange={(event) => update('timeout', Number(event.target.value))}
                className={fieldControlClass}
              />
            </label>
          </div>
        )}

        {node.type === 'delay' && (
          <label className="block">
            <span className={fieldLabelClass}>Duration seconds</span>
            <input
              type="number"
              min={0}
              value={Math.round(Number(data.duration || 1000) / 1000)}
              onChange={(event) => update('duration', Number(event.target.value) * 1000)}
              className={fieldControlClass}
            />
          </label>
        )}

        {node.type === 'download' && (
          <>
            <label className="block">
              <span className={fieldLabelClass}>Format</span>
              <div className="relative">
                <select
                  value={String(data.format || 'png')}
                  onChange={(event) => update('format', event.target.value)}
                  className={fieldSelectClass}
                >
                  {['png', 'jpg', 'webp', 'svg', 'txt'].map((format) => (
                    <option key={format} value={format}>{format}</option>
                  ))}
                </select>
                <ChevronDown className={selectIconClass} />
              </div>
            </label>
            <label className="block">
              <span className={fieldLabelClass}>Filename</span>
              <input
                value={String(data.filename || '')}
                onChange={(event) => update('filename', event.target.value)}
                placeholder="Auto"
                className={fieldControlClass}
              />
            </label>
            <label className={toggleRowClass}>
              <span className={toggleLabelClass}>Auto download</span>
              <input
                type="checkbox"
                checked={data.autoDownload !== false}
                onChange={(event) => update('autoDownload', event.target.checked)}
                className="h-3.5 w-3.5 accent-[#7C5CFF]"
              />
            </label>
          </>
        )}

        {node.type === 'wait' && (
          <>
            <label className="block">
              <span className={fieldLabelClass}>Condition</span>
              <div className="relative">
                <select
                  value={String(data.condition || 'dom-change')}
                  onChange={(event) => update('condition', event.target.value)}
                  className={fieldSelectClass}
                >
                  {['dom-change', 'text-appear', 'element-visible', 'manual'].map((condition) => (
                    <option key={condition} value={condition}>{condition}</option>
                  ))}
                </select>
                <ChevronDown className={selectIconClass} />
              </div>
            </label>
            <label className="block">
              <span className={fieldLabelClass}>Selector</span>
              <input
                value={String(data.selector || '')}
                onChange={(event) => update('selector', event.target.value)}
                className={fieldControlClass}
              />
            </label>
          </>
        )}
      </div>
    </aside>
  )
}

type VideoAgentMessage = VideoAgentConversationMessage

interface VideoAgentWorkflowImageReference {
  id: string
  alias: string
  name: string
  sourceUrl: string
  previewUrl: string
  assetId?: string
}

function collectVideoAgentWorkflowImages(workflow: Workflow): VideoAgentWorkflowImageReference[] {
  const images: Array<Omit<VideoAgentWorkflowImageReference, 'alias'>> = []

  for (const node of workflow.nodes) {
    const data = node.data as Record<string, unknown>

    if (node.type === 'image' && getMediaNodeType(data) === 'image') {
      const assetId = String(data.assetId || data.mediaAssetId || data.imageAssetId || '')
      const sourceUrl = getMediaNodeSource(data)
      if (!sourceUrl && !assetId) continue
      images.push({
        id: `${node.id}:media`,
        name: getMediaCardFileName(data) || `workflow-image-${images.length + 1}.png`,
        sourceUrl,
        previewUrl: sourceUrl,
        ...(assetId ? { assetId } : {}),
      })
      continue
    }

    if (node.type !== 'generate') continue
    const output = data._output as Record<string, unknown> | undefined
    const outputUrls = getGenerateOutputImageUrls(output)
    const outputItems = buildGenerateOutputItems(output, outputUrls)
    outputItems.forEach((item, outputIndex) => {
      if (item.mediaType === 'video') return
      const sourceUrl = item.previewUrl || item.url
      if (!sourceUrl && !item.assetId) return
      images.push({
        id: `${node.id}:output:${outputIndex}`,
        name: resolveGenerateOutputFilename(item, outputIndex),
        sourceUrl,
        previewUrl: sourceUrl,
        ...(item.assetId ? { assetId: item.assetId } : {}),
      })
    })
  }

  return images.map((image, index) => ({ ...image, alias: `image${index + 1}` }))
}

function mentionedVideoAgentWorkflowImages(
  text: string,
  images: VideoAgentWorkflowImageReference[],
): VideoAgentWorkflowImageReference[] {
  const aliases = new Set(Array.from(text.matchAll(/@image\d+\b/gi), (match) => match[0].slice(1).toLowerCase()))
  return images.filter((image) => aliases.has(image.alias.toLowerCase()))
}

function blobToPromptAssistantUpload(blob: Blob, name: string): Promise<PromptAssistantMediaUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${name}.`))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      const commaIndex = dataUrl.indexOf(',')
      if (commaIndex < 0) {
        reject(new Error(`Could not encode ${name}.`))
        return
      }
      resolve({
        base64: dataUrl.slice(commaIndex + 1),
        name,
        type: blob.type || 'image/png',
      })
    }
    reader.readAsDataURL(blob)
  })
}

async function videoAgentWorkflowImageToUpload(
  image: VideoAgentWorkflowImageReference,
): Promise<PromptAssistantMediaUpload> {
  const blob = image.assetId ? await getAssetBlob(image.assetId) : null
  const resolvedBlob = blob || (image.sourceUrl ? await fetch(image.sourceUrl).then((response) => {
    if (!response.ok) throw new Error(`Could not load @${image.alias}.`)
    return response.blob()
  }) : null)
  if (!resolvedBlob || resolvedBlob.size === 0) throw new Error(`Could not load @${image.alias}.`)
  return blobToPromptAssistantUpload(resolvedBlob, `${image.alias}-${image.name}`)
}

function normalizeAgentSectionLabel(value: string): string {
  return value
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\*\*/g, '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function agentPromptSectionPriority(line: string): number {
  const normalized = normalizeAgentSectionLabel(line)
  if (!normalized.includes('prompt')) return 0
  if (/prompt\s+(goc|nguon|original|source)\b/.test(normalized)) return 10
  if (
    /final\s+(?:ai\s+|video\s+|generation\s+)*prompt\b/.test(normalized)
    || /(?:ai\s+video|generation)\s+prompt\b/.test(normalized)
    || /prompt\s+(?:swap|hoan\s+chinh|cuoi(?:\s+cung)?|final)\b/.test(normalized)
  ) return 100
  return /^prompt\b/.test(normalized) ? 40 : 0
}

function cleanAgentPromptCandidate(value: string): string {
  let cleaned = value
    .replace(/^\s*```[^\n]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
  if (/^\*[^*][\s\S]*[^*]\*$/.test(cleaned)) cleaned = cleaned.slice(1, -1).trim()
  return cleaned
}

function extractAgentPromptForNode(responseText: string): string {
  const normalizedText = responseText.replace(/\r\n?/g, '\n').trim()
  if (!normalizedText) return ''
  const lines = normalizedText.split('\n')
  let selectedIndex = -1
  let selectedPriority = 0

  lines.forEach((line, index) => {
    const priority = agentPromptSectionPriority(line)
    if (priority >= selectedPriority && priority > 0) {
      selectedIndex = index
      selectedPriority = priority
    }
  })

  if (selectedIndex >= 0) {
    const labelLine = lines[selectedIndex]
    const colonIndex = labelLine.indexOf(':')
    const inlinePrompt = colonIndex >= 0
      ? labelLine.slice(colonIndex + 1).replace(/\*\*/g, '').trim()
      : ''
    let cursor = selectedIndex + 1
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1

    if (cursor < lines.length && /^\s*```/.test(lines[cursor])) {
      const fenced: string[] = []
      cursor += 1
      while (cursor < lines.length && !/^\s*```/.test(lines[cursor])) {
        fenced.push(lines[cursor])
        cursor += 1
      }
      const candidate = cleanAgentPromptCandidate([inlinePrompt, ...fenced].filter(Boolean).join('\n'))
      if (candidate) return candidate
    }

    if (cursor < lines.length && /^\s*>/.test(lines[cursor])) {
      const quoted: string[] = []
      while (cursor < lines.length && (/^\s*>/.test(lines[cursor]) || !lines[cursor].trim())) {
        quoted.push(lines[cursor])
        cursor += 1
      }
      const candidate = cleanAgentPromptCandidate([inlinePrompt, ...quoted].filter(Boolean).join('\n'))
      if (candidate) return candidate
    }

    const section: string[] = inlinePrompt ? [inlinePrompt] : []
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      const normalizedLine = normalizeAgentSectionLabel(line)
      if (/^\s*---+\s*$/.test(line)) break
      if (section.length > 0 && agentPromptSectionPriority(line) > 0) break
      if (/^(neu ban|if you want|variants?|alternatives?|cac bien the|bien the)\b/.test(normalizedLine)) break
      if (section.length > 0 && /^\s*#{1,6}\s+/.test(line)) break
      section.push(line)
    }
    const candidate = cleanAgentPromptCandidate(section.join('\n'))
    if (candidate) return candidate
  }

  const fencedBlocks = Array.from(normalizedText.matchAll(/```[^\n]*\n([\s\S]*?)```/g), (match) => cleanAgentPromptCandidate(match[1]))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  if (fencedBlocks[0]) return fencedBlocks[0]

  const quotedBlocks = Array.from(normalizedText.matchAll(/(?:^|\n)((?:\s*>[^\n]*(?:\n|$))+)/g), (match) => cleanAgentPromptCandidate(match[1]))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  if (quotedBlocks[0]) return quotedBlocks[0]

  const paragraphs = normalizedText.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean)
  const hasStructuredResponse = paragraphs.length > 1 || /^\s*(?:#{1,6}\s|\*\*|[-*]\s|\d+[.)]\s)/m.test(normalizedText)
  return hasStructuredResponse ? '' : cleanAgentPromptCandidate(normalizedText)
}

function renderVideoAgentComposerText(value: string): React.ReactNode {
  return value.split(/(@image\d+\b)/gi).map((part, index) => (
    /^@image\d+$/i.test(part)
      ? <span key={`${index}-${part}`} className="font-semibold text-[#B8A8FF]">{part}</span>
      : <React.Fragment key={`${index}-${part}`}>{part}</React.Fragment>
  ))
}

function renderVideoAgentMessageText(
  value: string,
  images: VideoAgentWorkflowImageReference[],
): React.ReactNode {
  const imagesByAlias = new Map(images.map((image) => [image.alias.toLowerCase(), image]))

  return value.split(/(@image\d+\b)/gi).map((part, index) => {
    if (!/^@image\d+$/i.test(part)) {
      return <React.Fragment key={`${index}-${part}`}>{part}</React.Fragment>
    }

    const image = imagesByAlias.get(part.slice(1).toLowerCase())
    return (
      <span key={`${index}-${part}`} className="inline-flex items-center gap-1 whitespace-nowrap align-middle">
        <span className="font-semibold text-[#B8A8FF]">{part}</span>
        {image && (
          <span
            title={`${part} · ${image.name}`}
            aria-label={`${part}: ${image.name}`}
            className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center overflow-hidden rounded-[5px] border border-[#9D86FF]/45 bg-[#7C5CFF]/12 text-[#B8A8FF] shadow-[0_0_0_1px_rgba(124,92,255,0.08)]"
          >
            <Image className="h-2.5 w-2.5" aria-hidden="true" />
            {image.previewUrl && (
              <img
                src={image.previewUrl}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                onError={(event) => { event.currentTarget.style.display = 'none' }}
              />
            )}
          </span>
        )}
      </span>
    )
  })
}

function isSkillCreatorAgentResponse(messages: VideoAgentMessage[], messageIndex: number): boolean {
  const message = messages[messageIndex]
  if (message?.role !== 'assistant') return false
  if (message.sourceCommand === 'skill-creator') return true
  const previousMessage = messages[messageIndex - 1]
  return previousMessage?.role === 'user' && /^Skill Creator(?:\r?\n|$)/i.test(previousMessage.text)
}

type VideoAgentSlashCommandId = 'skill-creator' | 'skill-installer'

type VideoAgentSlashCommand = {
  id: VideoAgentSlashCommandId
  label: string
  description: string
  instruction: string
}

const VIDEO_AGENT_SKILL_COMMANDS: VideoAgentSlashCommand[] = [
  {
    id: 'skill-creator',
    label: 'Skill Creator',
    description: 'Create or update a skill',
    instruction: 'Help the user create or update a reusable AI Idea Agent skill. Produce a concise skill name and a complete reusable instruction that can be saved with the Save skill action. Do not claim the skill has already been saved.',
  },
  {
    id: 'skill-installer',
    label: 'Skill Installer',
    description: 'Install curated skills from openai/skills or other repos',
    instruction: 'Help the user convert a curated skill or repository-provided skill specification into a safe local reusable AI Idea Agent skill. Ask for the source text or repository details when missing. Never claim remote code was installed or executed; return a reviewable local skill instruction that the user can save.',
  },
]

function buildVideoAgentWorkflowContext(workflow: Workflow): string {
  const promptNodes = workflow.nodes
    .filter((node) => node.type === 'prompt')
    .map((node, index) => {
      const prompt = readNodePromptText(node).trim().slice(0, 700)
      return prompt ? `Prompt ${index + 1}: ${prompt}` : ''
    })
    .filter(Boolean)
    .slice(0, 6)
  const generateNodes = workflow.nodes
    .filter((node) => node.type === 'generate')
    .map((node, index) => {
      const data = node.data as Record<string, unknown>
      return `Generate ${index + 1}: ${String(data.provider || 'google-flow')}, ${String(data.mediaType || 'image')}, ${String(data.aspectRatio || '16:9')}, ${String(data.model || 'default model')}`
    })
    .slice(0, 6)
  const lines = [...promptNodes, ...generateNodes]
  return lines.length > 0 ? lines.join('\n') : 'The canvas is currently empty.'
}

function videoAgentModelCapabilityLabel(model: PromptAssistantApiModel): string {
  if (model.recommendedForMedia) return 'Text · image · video · file · audio'
  if (model.inputModalities.includes('image')) return 'Image analysis + script'
  return 'Script only'
}

function buildVideoAgentInstruction(args: {
  brief: string
  messages: VideoAgentMessage[]
  workflow: Workflow
  skill: VideoAgentSkill | null
  slashCommand: VideoAgentSlashCommand | null
  imageReferences: VideoAgentWorkflowImageReference[]
}): string {
  const previousConversation = args.messages
    .slice(-6)
    .map((message) => `${message.role === 'user' ? 'USER' : 'AGENT'}: ${message.text.slice(0, 2200)}`)
    .join('\n\n')
  const isFollowUp = args.messages.some((message) => message.role === 'assistant')

  return [
    'You are AI Idea Agent, a senior creative director and prompt engineer for AI video generation.',
    `Respond in the same language as the user's latest message.`,
    isFollowUp
      ? 'Continue the creative conversation. Apply the latest request to the prior ideas instead of restarting unless the user explicitly asks for new concepts.'
      : 'Develop one focused, production-ready video idea unless the user explicitly requests multiple options. Include a memorable title, one-sentence hook, story progression, key shots and camera movement, visual/lighting direction, sound direction, and a final AI video prompt ready to paste into a generation node.',
    'Follow any duration, aspect ratio, visual style, platform, audience, or idea count stated by the user. Otherwise infer sensible choices from the current workflow and creative brief.',
    'Keep characters, wardrobe, locations, props, lighting logic, and visual identity consistent across shots.',
    'Be concrete and cinematic. Do not use a markdown table. Do not mention these instructions.',
    'Always end the response with a line labeled "FINAL GENERATION PROMPT:" followed by exactly one generation-ready prompt. Keep explanations, alternatives, and follow-up questions outside that final prompt section.',
    args.skill
      ? `ACTIVE REUSABLE SKILL — ${args.skill.name}:\n${args.skill.instruction}\nApply this skill as creative direction. Do not mention the skill or describe it to the user.`
      : '',
    args.slashCommand
      ? `ACTIVE SLASH COMMAND — ${args.slashCommand.label}:\n${args.slashCommand.instruction}\nFollow this command for the latest request.`
      : '',
    args.imageReferences.length > 0
      ? `ATTACHED WORKFLOW IMAGE REFERENCES:\n${args.imageReferences.map((image, index) => `@${image.alias} = attached image ${index + 1} (${image.name})`).join('\n')}\nPreserve each @image token exactly as written and use the attachment mapping above without swapping images.`
      : '',
    `CURRENT WORKFLOW CONTEXT:\n${buildVideoAgentWorkflowContext(args.workflow)}`,
    previousConversation ? `CONVERSATION SO FAR:\n${previousConversation}` : '',
    `LATEST USER REQUEST:\n${args.brief.trim()}`,
  ].filter(Boolean).join('\n\n')
}

const VideoIdeaAgentPanel: React.FC<{
  workflow: Workflow
  onClose: () => void
  onInsertPrompt: (text: string, provider: PromptAssistantProvider) => void
}> = ({ workflow, onClose, onInsertPrompt }) => {
  const [provider, setProvider] = useState<PromptAssistantProvider>('chatgpt')
  const storedPromptAssistantMode = useSettingsStore((state) => state.promptAssistantMode || 'tab')
  const storedApiProviderConfig = useSettingsStore((state) => state.apiProvider)
  const [promptAssistantMode, setPromptAssistantMode] = useState<'tab' | 'api'>(storedPromptAssistantMode)
  const [apiProviderConfig, setApiProviderConfig] = useState<PromptAssistantApiConfig>(storedApiProviderConfig)
  const [apiModels, setApiModels] = useState<PromptAssistantApiModel[]>([])
  const [apiModelsLoading, setApiModelsLoading] = useState(false)
  const [apiModelsError, setApiModelsError] = useState('')
  const apiProviderReady = Boolean(
    apiProviderConfig?.endpoint?.trim()
    && apiProviderConfig.model?.trim()
  )
  const activeProvider: PromptAssistantProvider = promptAssistantMode === 'api'
    ? 'api'
    : provider === 'api' ? 'chatgpt' : provider
  const [input, setInput] = useState('')
  const [inputScrollTop, setInputScrollTop] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const slashCommandMenuRef = useRef<HTMLDivElement>(null)
  const workflowImageCandidates = useMemo(() => collectVideoAgentWorkflowImages(workflow), [workflow.nodes])
  const [workflowImageReferences, setWorkflowImageReferences] = useState<VideoAgentWorkflowImageReference[]>(workflowImageCandidates)
  const [imageMention, setImageMention] = useState<{ start: number; query: string } | null>(null)
  const [imageMentionIndex, setImageMentionIndex] = useState(0)
  const [activeSlashCommand, setActiveSlashCommand] = useState<VideoAgentSlashCommand | null>(null)
  const [slashCommandHighlight, setSlashCommandHighlight] = useState(0)
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false)
  const [messages, setMessages] = useState<VideoAgentMessage[]>([])
  const [conversationHistory, setConversationHistory] = useState<VideoAgentConversation[]>([])
  const conversationHistoryRef = useRef<VideoAgentConversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [conversationHistoryReady, setConversationHistoryReady] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState('')
  const [insertedMessageId, setInsertedMessageId] = useState<string | null>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const historyMenuRef = useRef<HTMLDivElement>(null)
  const skillMenuRef = useRef<HTMLDivElement>(null)
  const [skillLibrary, setSkillLibrary] = useState<VideoAgentSkillLibrary>(EMPTY_VIDEO_AGENT_SKILL_LIBRARY)
  const [skillsReady, setSkillsReady] = useState(false)
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)
  const [skillEditorOpen, setSkillEditorOpen] = useState(false)
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null)
  const [skillDraftName, setSkillDraftName] = useState('')
  const [skillDraftInstruction, setSkillDraftInstruction] = useState('')
  const selectedSkill = skillLibrary.skills.find((skill) => skill.id === skillLibrary.selectedSkillId) || null
  const slashCommandMatch = input.trim().match(/^\/([^\s]*)$/)
  const slashCommandQuery = slashCommandMatch ? slashCommandMatch[1].toLowerCase() : null
  const filteredSkillCommands = useMemo(() => {
    if (slashCommandQuery === null) return []
    return VIDEO_AGENT_SKILL_COMMANDS.filter((command) => {
      if (!slashCommandQuery) return true
      const searchable = `${command.id} ${command.label} ${command.description}`.toLowerCase()
      return searchable.includes(slashCommandQuery)
    })
  }, [slashCommandQuery])
  const showSkillSlashMenu = !activeSlashCommand && !slashMenuDismissed && filteredSkillCommands.length > 0
  const filteredImageMentionOptions = useMemo(() => {
    if (!imageMention) return []
    const query = imageMention.query.toLowerCase()
    return workflowImageReferences.filter((image) => (
      image.alias.toLowerCase().includes(query) || image.name.toLowerCase().includes(query)
    ))
  }, [imageMention, workflowImageReferences])
  const showImageMentionMenu = imageMention !== null && filteredImageMentionOptions.length > 0
  const hasValidInputImageMention = useMemo(() => {
    if (!input) return false
    const availableAliases = new Set(workflowImageReferences.map((image) => image.alias.toLowerCase()))
    return Array.from(input.matchAll(/@image\d+\b/gi))
      .some((match) => availableAliases.has(match[0].slice(1).toLowerCase()))
  }, [input, workflowImageReferences])
  const visibleApiModels = useMemo(() => {
    const configuredId = apiProviderConfig.model?.trim()
    if (!configuredId || apiModels.some((model) => model.id === configuredId)) return apiModels
    return [{
      id: configuredId,
      name: configuredId,
      owner: 'configured',
      plan: 'Configured Model',
      isFree: false,
      inputModalities: ['text'],
      recommendedForMedia: false,
    }, ...apiModels]
  }, [apiModels, apiProviderConfig.model])
  const apiModelGroups = useMemo(() => {
    const groups = new Map<string, PromptAssistantApiModel[]>()
    for (const model of visibleApiModels) {
      const group = groups.get(model.plan) || []
      group.push(model)
      groups.set(model.plan, group)
    }
    return Array.from(groups.entries())
  }, [visibleApiModels])

  const persistApiModelSelection = useCallback((modelId: string) => {
    const normalizedModelId = modelId.trim()
    if (!normalizedModelId) return
    setApiProviderConfig((current) => ({ ...current, apiKey: '', model: normalizedModelId }))
    const settingsState = useSettingsStore.getState()
    settingsState.updateSettings({
      apiProvider: {
        ...settingsState.apiProvider,
        apiKey: '',
        model: normalizedModelId,
      },
    })
  }, [])

  const refreshApiModels = useCallback(async (): Promise<PromptAssistantApiModel[]> => {
    if (!apiProviderConfig.endpoint?.trim()) {
      setApiModels([])
      setApiModelsError('Configure the 9Router endpoint in Settings first.')
      return []
    }
    setApiModelsLoading(true)
    setApiModelsError('')
    try {
      const models = await loadPromptAssistantApiModels(apiProviderConfig.endpoint)
      setApiModels(models)
      if (models.length === 0) setApiModelsError('9Router returned no available models.')
      return models
    } catch (modelError) {
      const message = modelError instanceof Error ? modelError.message : 'Could not load models from 9Router.'
      setApiModelsError(message)
      return []
    } finally {
      setApiModelsLoading(false)
    }
  }, [apiProviderConfig.endpoint])

  useEffect(() => {
    setPromptAssistantMode(storedPromptAssistantMode)
    setApiProviderConfig(storedApiProviderConfig)
  }, [storedApiProviderConfig, storedPromptAssistantMode])

  useEffect(() => {
    if (promptAssistantMode !== 'api') return
    void refreshApiModels()
  }, [promptAssistantMode, refreshApiModels])

  useEffect(() => {
    if (promptAssistantMode !== 'api' || !hasValidInputImageMention || apiModels.length === 0 || isRunning) return
    const bestModelId = selectPromptAssistantApiModel(apiModels, apiProviderConfig.model || '', true)
    if (bestModelId && bestModelId !== apiProviderConfig.model?.trim()) {
      persistApiModelSelection(bestModelId)
    }
  }, [
    apiModels,
    apiProviderConfig.model,
    hasValidInputImageMention,
    isRunning,
    persistApiModelSelection,
    promptAssistantMode,
  ])

  useEffect(() => {
    let active = true
    setWorkflowImageReferences(workflowImageCandidates)
    void Promise.all(workflowImageCandidates.map(async (image) => {
      if (!image.assetId) return image
      const objectUrl = await getAssetObjectUrl(image.assetId)
      return objectUrl
        ? { ...image, sourceUrl: objectUrl, previewUrl: objectUrl }
        : image
    })).then((images) => {
      if (active) setWorkflowImageReferences(images)
    })
    return () => { active = false }
  }, [workflowImageCandidates])

  useEffect(() => {
    const applyStoredSettings = (raw: unknown) => {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        const state = (parsed as { state?: { promptAssistantMode?: unknown; apiProvider?: unknown } } | null)?.state
        if (state?.promptAssistantMode === 'tab' || state?.promptAssistantMode === 'api') {
          setPromptAssistantMode(state.promptAssistantMode)
        }
        if (state?.apiProvider && typeof state.apiProvider === 'object') {
          setApiProviderConfig((current) => ({
            ...current,
            ...(state.apiProvider as Partial<PromptAssistantApiConfig>),
          }))
        }
      } catch {
        // Keep the already-hydrated settings when an external value is malformed.
      }
    }
    void chrome.storage.local.get('ai-flow-settings').then((stored) => {
      applyStoredSettings(stored['ai-flow-settings'])
    }).catch(() => {})
    const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local' || !changes['ai-flow-settings']) return
      applyStoredSettings(changes['ai-flow-settings'].newValue)
    }
    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleStorageChange)
  }, [])

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isRunning])

  useEffect(() => {
    conversationHistoryRef.current = conversationHistory
  }, [conversationHistory])

  useEffect(() => {
    let active = true
    setConversationHistoryReady(false)
    setHistoryOpen(false)
    void loadVideoAgentConversationState(workflow.id)
      .then(async (state) => {
        if (!active) return
        let conversations = state.conversations
        let activeId = state.activeConversationId
        if (!activeId) {
          const conversation = createVideoAgentConversation(workflow.id)
          await saveVideoAgentConversation(conversation)
          if (!active) return
          conversations = [conversation]
          activeId = conversation.id
        }
        const activeConversation = conversations.find((conversation) => conversation.id === activeId) || conversations[0]
        conversationHistoryRef.current = conversations
        setConversationHistory(conversations)
        setActiveConversationId(activeConversation?.id || null)
        setMessages(activeConversation?.messages || [])
        setConversationHistoryReady(true)
      })
      .catch(() => {
        if (!active) return
        setConversationHistoryReady(true)
        setError('Could not load AI Idea Agent conversation history from IndexedDB.')
      })
    return () => { active = false }
  }, [workflow.id])

  useEffect(() => {
    if (!conversationHistoryReady || !activeConversationId) return
    const existing = conversationHistoryRef.current.find((conversation) => conversation.id === activeConversationId)
    if (!existing) return
    const now = Date.now()
    const firstUserMessage = messages.find((message) => message.role === 'user')?.text
      .replace(/\s+/g, ' ')
      .trim()
    const updatedConversation: VideoAgentConversation = {
      ...existing,
      title: firstUserMessage ? firstUserMessage.slice(0, 90) : existing.title,
      messages,
      updatedAt: now,
    }
    const nextHistory = [
      updatedConversation,
      ...conversationHistoryRef.current.filter((conversation) => conversation.id !== activeConversationId),
    ].sort((left, right) => right.updatedAt - left.updatedAt)
    conversationHistoryRef.current = nextHistory
    setConversationHistory(nextHistory)
    void saveVideoAgentConversation(updatedConversation).catch(() => {
      setError('Could not save the current AI Idea Agent conversation to IndexedDB.')
    })
  }, [activeConversationId, conversationHistoryReady, messages])

  useEffect(() => {
    if (!historyOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!historyMenuRef.current?.contains(event.target as Node)) setHistoryOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [historyOpen])

  useEffect(() => {
    let active = true
    void loadVideoAgentSkillLibrary()
      .then((library) => {
        if (!active) return
        setSkillLibrary(library)
        setSkillsReady(true)
      })
      .catch(() => {
        if (!active) return
        setSkillsReady(true)
        setError('Could not load saved AI Idea Agent skills.')
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!skillMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!skillMenuRef.current?.contains(event.target as Node)) setSkillMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [skillMenuOpen])

  useEffect(() => {
    if (!showSkillSlashMenu) return
    setSlashCommandHighlight(0)
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!slashCommandMenuRef.current?.contains(event.target as Node)) setSlashMenuDismissed(true)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [showSkillSlashMenu, slashCommandQuery])

  useEffect(() => {
    if (!showImageMentionMenu) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!slashCommandMenuRef.current?.contains(event.target as Node)) setImageMention(null)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [showImageMentionMenu])

  useEffect(() => {
    if (workflowImageReferences.length > 0) return
    setImageMention(null)
    setImageMentionIndex(0)
  }, [workflowImageReferences.length])

  const updateVideoAgentImageMention = (value: string, cursor: number) => {
    if (workflowImageReferences.length === 0) {
      setImageMention(null)
      return
    }
    const beforeCursor = value.slice(0, cursor)
    const match = beforeCursor.match(/@([a-zA-Z0-9]*)$/)
    if (!match) {
      setImageMention(null)
      return
    }
    const start = beforeCursor.length - match[0].length
    const preceding = start > 0 ? beforeCursor[start - 1] : ''
    if (preceding && !/[\s([,{]/.test(preceding)) {
      setImageMention(null)
      return
    }
    setImageMention({ start, query: match[1] || '' })
    setImageMentionIndex(0)
  }

  const insertVideoAgentImageMention = (alias: string) => {
    const textarea = inputRef.current
    const currentCursor = textarea?.selectionStart ?? input.length
    const replaceStart = imageMention?.start ?? currentCursor
    const before = input.slice(0, replaceStart)
    const after = input.slice(currentCursor)
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
    const needsTrailingSpace = after.length === 0 || !/^\s/.test(after)
    const inserted = `${needsLeadingSpace ? ' ' : ''}@${alias}${needsTrailingSpace ? ' ' : ''}`
    const nextInput = before + inserted + after
    const nextCursor = before.length + inserted.length

    setInput(nextInput)
    setImageMention(null)
    setImageMentionIndex(0)
    window.requestAnimationFrame(() => {
      const inputElement = inputRef.current
      if (!inputElement) return
      inputElement.focus()
      inputElement.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const selectSlashCommand = (command: VideoAgentSlashCommand) => {
    setActiveSlashCommand(command)
    setInput((current) => current.replace(/^\s*\/[^\s]*\s*$/i, ''))
    setSlashMenuDismissed(true)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }

  const persistConversationSnapshot = async (conversationId: string, nextMessages: VideoAgentMessage[]) => {
    const existing = conversationHistoryRef.current.find((conversation) => conversation.id === conversationId)
    if (!existing) throw new Error('The active AI Idea Agent conversation is unavailable.')
    const firstUserMessage = nextMessages.find((message) => message.role === 'user')?.text
      .replace(/\s+/g, ' ')
      .trim()
    const updatedConversation: VideoAgentConversation = {
      ...existing,
      title: firstUserMessage ? firstUserMessage.slice(0, 90) : existing.title,
      messages: nextMessages,
      updatedAt: Date.now(),
    }
    const nextHistory = [
      updatedConversation,
      ...conversationHistoryRef.current.filter((conversation) => conversation.id !== conversationId),
    ].sort((left, right) => right.updatedAt - left.updatedAt)
    conversationHistoryRef.current = nextHistory
    setConversationHistory(nextHistory)
    await saveVideoAgentConversation(updatedConversation)
  }

  const submit = async (seed?: string) => {
    const brief = (seed ?? input).trim()
    if (!brief || isRunning) return
    if (!conversationHistoryReady || !activeConversationId) {
      setError('AI Idea Agent conversation history is still loading. Try again in a moment.')
      return
    }
    if (activeProvider === 'api' && !apiProviderReady) {
      setError('Configure the API endpoint and model in Settings before using API mode.')
      return
    }
    const availableAliases = new Set(workflowImageReferences.map((image) => image.alias.toLowerCase()))
    const unavailableReference = Array.from(brief.matchAll(/@image\d+\b/gi), (match) => match[0])
      .find((token) => !availableAliases.has(token.slice(1).toLowerCase()))
    if (unavailableReference) {
      setError(`${unavailableReference} is not available in the current workflow.`)
      return
    }
    const referenceContext = [
      ...messages.filter((message) => message.role === 'user').map((message) => message.text),
      brief,
    ].join('\n')
    const imageReferences = mentionedVideoAgentWorkflowImages(referenceContext, workflowImageReferences)
    if (imageReferences.length > 5) {
      setError('AI Idea Agent supports up to 5 referenced workflow images per request.')
      return
    }
    const slashCommand = activeSlashCommand
    const userMessageCreatedAt = Date.now()
    const userMessage: VideoAgentMessage = {
      id: `video-agent-user-${userMessageCreatedAt}`,
      role: 'user',
      text: slashCommand ? `${slashCommand.label}\n${brief}` : brief,
      createdAt: userMessageCreatedAt,
    }
    const conversation = [...messages, userMessage]
    setMessages(conversation)
    setInput('')
    setInputScrollTop(0)
    setImageMention(null)
    setImageMentionIndex(0)
    setActiveSlashCommand(null)
    setSlashMenuDismissed(false)
    setError('')
    setIsRunning(true)
    try {
      await persistConversationSnapshot(activeConversationId, conversation)
      const mediaUploads = await Promise.all(imageReferences.map(videoAgentWorkflowImageToUpload))
      let requestModel = apiProviderConfig.model?.trim() || ''
      if (activeProvider === 'api' && mediaUploads.length > 0) {
        const availableModels = apiModels.length > 0 ? apiModels : await refreshApiModels()
        requestModel = selectPromptAssistantApiModel(availableModels, requestModel, true)
        if (requestModel && requestModel !== apiProviderConfig.model?.trim()) {
          persistApiModelSelection(requestModel)
        }
      }
      const instruction = buildVideoAgentInstruction({
        brief,
        messages,
        workflow,
        skill: selectedSkill,
        slashCommand,
        imageReferences,
      })
      const text = await runPromptAssistant(activeProvider, instruction, 120000, mediaUploads, {
        focus: false,
        apiModel: activeProvider === 'api' ? requestModel : undefined,
      })
      const assistantMessageCreatedAt = Date.now()
      const assistantMessage: VideoAgentMessage = {
        id: `video-agent-assistant-${assistantMessageCreatedAt}`,
        role: 'assistant',
        text,
        provider: activeProvider,
        sourceCommand: slashCommand?.id,
        createdAt: assistantMessageCreatedAt,
      }
      const completedConversation = [...conversation, assistantMessage]
      await persistConversationSnapshot(activeConversationId, completedConversation)
      setMessages(completedConversation)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'AI Idea Agent could not complete this request.')
    } finally {
      setIsRunning(false)
    }
  }

  const copyMessage = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setError('')
    } catch {
      setError('Could not copy this idea to the clipboard.')
    }
  }

  const persistSkillLibrary = async (nextLibrary: VideoAgentSkillLibrary) => {
    setSkillLibrary(nextLibrary)
    try {
      const savedLibrary = await saveVideoAgentSkillLibrary(nextLibrary)
      setSkillLibrary(savedLibrary)
      setError('')
    } catch {
      setError('Could not save AI Idea Agent skills to extension storage.')
    }
  }

  const openSkillEditor = (skill?: VideoAgentSkill, sourceText = '') => {
    const suggestedName = sourceText
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*[-#*\d.]+\s*/, '').trim())
      .find(Boolean)
      ?.slice(0, 64) || ''
    setEditingSkillId(skill?.id || null)
    setSkillDraftName(skill?.name || suggestedName)
    setSkillDraftInstruction(skill?.instruction || sourceText.slice(0, 12000))
    setSkillMenuOpen(false)
    setSkillEditorOpen(true)
  }

  const saveSkillDraft = async () => {
    const name = skillDraftName.trim()
    const instruction = skillDraftInstruction.trim()
    if (!name || !instruction) return
    const now = Date.now()
    const existing = editingSkillId
      ? skillLibrary.skills.find((skill) => skill.id === editingSkillId)
      : undefined
    const savedSkill: VideoAgentSkill = {
      id: existing?.id || `video-agent-skill-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      instruction,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    const nextSkills = existing
      ? skillLibrary.skills.map((skill) => skill.id === existing.id ? savedSkill : skill)
      : [savedSkill, ...skillLibrary.skills]
    await persistSkillLibrary({ skills: nextSkills, selectedSkillId: savedSkill.id })
    setSkillEditorOpen(false)
    setEditingSkillId(null)
  }

  const selectSkill = (skillId: string | null) => {
    setSkillMenuOpen(false)
    void persistSkillLibrary({ ...skillLibrary, selectedSkillId: skillId })
  }

  const deleteSkill = (skillId: string) => {
    const nextSkills = skillLibrary.skills.filter((skill) => skill.id !== skillId)
    const selectedSkillId = skillLibrary.selectedSkillId === skillId ? null : skillLibrary.selectedSkillId
    void persistSkillLibrary({ skills: nextSkills, selectedSkillId })
  }

  const startNewConversation = async () => {
    if (isRunning || !conversationHistoryReady) return
    const conversation = createVideoAgentConversation(workflow.id)
    try {
      await saveVideoAgentConversation(conversation)
      const nextHistory = [conversation, ...conversationHistoryRef.current]
      conversationHistoryRef.current = nextHistory
      setConversationHistory(nextHistory)
      setActiveConversationId(conversation.id)
      setMessages(conversation.messages)
      setInput('')
      setInputScrollTop(0)
      setActiveSlashCommand(null)
      setSlashMenuDismissed(false)
      setError('')
      setInsertedMessageId(null)
      setHistoryOpen(false)
    } catch {
      setError('Could not create a new AI Idea Agent conversation in IndexedDB.')
    }
  }

  const openSavedConversation = async (conversation: VideoAgentConversation) => {
    if (isRunning || conversation.id === activeConversationId) {
      setHistoryOpen(false)
      return
    }
    try {
      await setActiveVideoAgentConversation(workflow.id, conversation.id)
      setActiveConversationId(conversation.id)
      setMessages(conversation.messages)
      setInput('')
      setInputScrollTop(0)
      setActiveSlashCommand(null)
      setSlashMenuDismissed(false)
      setError('')
      setInsertedMessageId(null)
      setHistoryOpen(false)
    } catch {
      setError('Could not open the selected AI Idea Agent conversation.')
    }
  }

  const suggestionPrompts = [
    'Create a cinematic product launch concept',
    'Turn my current workflow into a 60-second story',
    'Plan a viral vertical short with a strong hook',
  ]

  return (
    <aside className="relative z-[90] flex h-full w-[420px] min-w-[360px] max-w-[46vw] shrink-0 flex-col border-l border-white/[0.08] bg-[#151515] shadow-[-18px_0_48px_rgba(0,0,0,0.28)]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.07] px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#7C5CFF]/25 bg-[#7C5CFF]/12 text-[#B8A8FF]">
            <Bot className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[12px] font-semibold text-white/88">AI Idea Agent</h2>
            <p className="truncate text-[9px] text-white/30">Develop concepts, storyboards and generation prompts</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div ref={historyMenuRef} className="relative">
            <button
              type="button"
              title="Conversation history"
              aria-label="Open AI Idea Agent conversation history"
              disabled={!conversationHistoryReady}
              onClick={() => setHistoryOpen((current) => !current)}
              className={cn(
                'relative flex h-8 w-8 items-center justify-center rounded-lg text-white/35 hover:bg-white/[0.06] hover:text-white/75 disabled:opacity-30',
                historyOpen && 'bg-[#7C5CFF]/12 text-[#C8BCFF]'
              )}
            >
              <MessagesSquare className="h-4 w-4" />
              {conversationHistory.length > 1 && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[#8E73FF]" />}
            </button>

            {historyOpen && (
              <div className="absolute right-0 top-10 z-[200] w-[340px] overflow-hidden rounded-2xl border border-white/[0.1] bg-[#1A1A1A] shadow-[0_24px_72px_rgba(0,0,0,0.76)]">
                <div className="flex items-center justify-between border-b border-white/[0.07] px-3.5 py-3">
                  <div>
                    <p className="text-[10px] font-semibold text-white/78">Conversation history</p>
                    <p className="mt-0.5 text-[8px] text-white/28">Saved permanently in IndexedDB</p>
                  </div>
                  <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[8px] font-medium text-white/35">{conversationHistory.length}</span>
                </div>
                <div className="max-h-[360px] overflow-y-auto p-1.5">
                  {conversationHistory.map((conversation) => {
                    const active = conversation.id === activeConversationId
                    const preview = conversation.messages[conversation.messages.length - 1]?.text || 'Empty conversation'
                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        disabled={isRunning}
                        onClick={() => void openSavedConversation(conversation)}
                        className={cn(
                          'flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-45',
                          active && 'bg-[#7C5CFF]/10'
                        )}
                      >
                        <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border', active ? 'border-[#7C5CFF]/24 bg-[#7C5CFF]/12 text-[#B8A8FF]' : 'border-white/[0.07] bg-white/[0.025] text-white/28')}>
                          <Film className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cn('block truncate text-[10px] font-medium', active ? 'text-[#D1C8FF]' : 'text-white/62')}>{conversation.title}</span>
                          <span className="mt-0.5 block truncate text-[8px] text-white/25">{preview}</span>
                          <span className="mt-1 block text-[7px] text-white/18">{formatDate(conversation.updatedAt)} · {conversation.messages.length} messages</span>
                        </span>
                        {active && <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-[#A895FF]" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            title="Start a new conversation without deleting history"
            disabled={!conversationHistoryReady || isRunning}
            onClick={() => void startNewConversation()}
            className="h-8 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-[10px] font-medium text-white/38 hover:bg-white/[0.06] hover:text-white/72 disabled:cursor-not-allowed disabled:opacity-30"
          >
            New chat
          </button>
          <button type="button" title="Close Agent" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 hover:bg-white/[0.06] hover:text-white/75">
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !isRunning && (
          <div className="flex min-h-full flex-col items-center justify-center py-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[#7C5CFF]/20 bg-[#7C5CFF]/10 text-[#B8A8FF] shadow-[0_12px_34px_rgba(124,92,255,0.12)]">
              <Film className="h-5 w-5" />
            </span>
            <h3 className="mt-4 text-[13px] font-semibold text-white/82">Start with a rough idea</h3>
            <p className="mt-1.5 max-w-[280px] text-[10px] leading-4 text-white/34">The Agent uses your canvas context to develop a coherent video concept and production-ready prompt.</p>
            <div className="mt-5 flex w-full max-w-[320px] flex-col gap-2">
              {suggestionPrompts.map((suggestion) => (
                <button key={suggestion} type="button" disabled={!conversationHistoryReady || !activeConversationId} onClick={() => void submit(suggestion)} className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5 text-left text-[10px] leading-4 text-white/48 transition-colors hover:border-[#7C5CFF]/28 hover:bg-[#7C5CFF]/[0.07] hover:text-white/75 disabled:cursor-not-allowed disabled:opacity-35">
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, messageIndex) => (
          <div key={message.id} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cn('max-w-[94%] rounded-2xl px-3.5 py-3 text-[11px] leading-[1.65]', message.role === 'user' ? 'rounded-br-md bg-[#7C5CFF] text-white' : 'rounded-bl-md border border-white/[0.08] bg-[#1B1B1B] text-white/72')}>
              <div className="whitespace-pre-wrap break-words">
                {renderVideoAgentMessageText(message.text, workflowImageReferences)}
              </div>
              {message.role === 'assistant' && (
                <div className="mt-3 flex items-center gap-1.5 border-t border-white/[0.07] pt-2.5">
                   <button type="button" onClick={() => void copyMessage(message.text)} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[9px] font-medium text-white/34 hover:bg-white/[0.06] hover:text-white/70">
                     <Copy className="h-3 w-3" /> Copy
                   </button>
                   {isSkillCreatorAgentResponse(messages, messageIndex) && (
                     <button type="button" onClick={() => openSkillEditor(undefined, message.text)} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[9px] font-medium text-white/34 hover:bg-white/[0.06] hover:text-white/70">
                       <BookOpen className="h-3 w-3" /> Save skill
                     </button>
                   )}
                   <button
                    type="button"
                    onClick={() => {
                      const promptText = extractAgentPromptForNode(message.text)
                      if (!promptText) {
                        setError('Could not identify a final generation prompt in this response. Ask the Agent to return a FINAL GENERATION PROMPT, then try again.')
                        return
                      }
                      onInsertPrompt(promptText, message.provider || activeProvider)
                      setError('')
                      setInsertedMessageId(message.id)
                      window.setTimeout(() => setInsertedMessageId((current) => current === message.id ? null : current), 1600)
                    }}
                    className="flex h-7 items-center gap-1.5 rounded-lg bg-[#7C5CFF]/14 px-2.5 text-[9px] font-semibold text-[#C8BCFF] hover:bg-[#7C5CFF]/22 hover:text-white"
                  >
                    <Plus className="h-3 w-3" /> {insertedMessageId === message.id ? 'Added to canvas' : 'Add Prompt Node'}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {isRunning && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-white/[0.08] bg-[#1B1B1B] px-3.5 py-3 text-[10px] text-white/42">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[#A895FF]" />
              Developing video ideas with {promptAssistantProviderLabel(activeProvider)}…
            </div>
          </div>
        )}
        <div ref={messageEndRef} />
      </div>

      <div className="shrink-0 border-t border-white/[0.07] bg-[#131313] p-3.5">
        {error && <div className="mb-2 rounded-lg border border-red-400/15 bg-red-500/[0.07] px-2.5 py-2 text-[9px] leading-4 text-red-200/75">{error}</div>}
        <div ref={slashCommandMenuRef} className="relative rounded-2xl border border-white/[0.09] bg-[#0F0F0F] p-2.5 transition-colors focus-within:border-[#7C5CFF]/55 focus-within:ring-2 focus-within:ring-[#7C5CFF]/10">
          {showImageMentionMenu && (
            <div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-[205] max-h-[260px] overflow-y-auto rounded-xl border border-white/[0.1] bg-[#202020] p-1 shadow-[0_20px_58px_rgba(0,0,0,0.72)]">
              <div className="flex items-center justify-between px-2.5 py-2">
                <span className="text-[9px] font-semibold text-white/48">Workflow images</span>
                <span className="text-[8px] text-white/22">{workflowImageReferences.length}</span>
              </div>
              {filteredImageMentionOptions.map((image, index) => (
                <button
                  key={image.id}
                  type="button"
                  onMouseEnter={() => setImageMentionIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertVideoAgentImageMention(image.alias)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors',
                    imageMentionIndex === index ? 'bg-[#7C5CFF]/15' : 'hover:bg-white/[0.06]'
                  )}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/[0.08] bg-[#111] text-white/24">
                    {image.previewUrl
                      ? <img src={image.previewUrl} alt="" className="h-full w-full object-cover" />
                      : <Image className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-[10px] font-semibold', imageMentionIndex === index ? 'text-[#C8BCFF]' : 'text-white/68')}>@{image.alias}</span>
                    <span className="mt-0.5 block truncate text-[8px] text-white/28">{image.name}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {showSkillSlashMenu && (
            <div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-[205] overflow-hidden rounded-xl border border-white/[0.1] bg-[#242424] p-1 shadow-[0_20px_58px_rgba(0,0,0,0.72)]">
              {filteredSkillCommands.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  onMouseEnter={() => setSlashCommandHighlight(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSlashCommand(command)}
                  className={cn(
                    'flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left outline-none transition-colors',
                    slashCommandHighlight === index ? 'bg-white/[0.09]' : 'hover:bg-white/[0.06]'
                  )}
                >
                  <Box className="h-3.5 w-3.5 shrink-0 text-white/55" />
                  <span className="text-[10px] font-medium text-white/75">{command.label}</span>
                  <span className="min-w-0 truncate text-[9px] text-white/32">{command.description}</span>
                </button>
              ))}
            </div>
          )}

          {activeSlashCommand && (
            <div className="mb-1.5 flex items-center px-1 pt-0.5">
              <span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-[#79B8FF]/10 px-2 text-[10px] font-medium text-[#8FC4FF]">
                <Box className="h-3.5 w-3.5" />
                {activeSlashCommand.label}
                <button
                  type="button"
                  aria-label={`Remove ${activeSlashCommand.label}`}
                  onClick={() => {
                    setActiveSlashCommand(null)
                    window.requestAnimationFrame(() => inputRef.current?.focus())
                  }}
                  className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-[#8FC4FF]/45 hover:bg-white/[0.08] hover:text-[#B8D9FF]"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            </div>
          )}

          <div className="relative max-h-32 min-h-[64px] overflow-hidden">
            {input && (
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden px-1 text-[11px] leading-5 text-white/78">
                <div
                  className="whitespace-pre-wrap break-words"
                  style={{ transform: `translateY(-${inputScrollTop}px)` }}
                >
                  {renderVideoAgentComposerText(input)}
                  {input.endsWith('\n') ? ' ' : null}
                </div>
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              disabled={isRunning || !conversationHistoryReady || !activeConversationId}
              onChange={(event) => {
                const value = event.target.value
                setInput(value)
                setSlashMenuDismissed(false)
                updateVideoAgentImageMention(value, event.target.selectionStart ?? value.length)
              }}
              onScroll={(event) => setInputScrollTop(event.currentTarget.scrollTop)}
              onKeyDown={(event) => {
                if (showImageMentionMenu) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setImageMentionIndex((current) => (current + 1) % filteredImageMentionOptions.length)
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setImageMentionIndex((current) => (current - 1 + filteredImageMentionOptions.length) % filteredImageMentionOptions.length)
                    return
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault()
                    const selected = filteredImageMentionOptions[Math.min(imageMentionIndex, filteredImageMentionOptions.length - 1)]
                    if (selected) insertVideoAgentImageMention(selected.alias)
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setImageMention(null)
                    return
                  }
                }
                if (showSkillSlashMenu) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setSlashCommandHighlight((current) => (current + 1) % filteredSkillCommands.length)
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setSlashCommandHighlight((current) => (current - 1 + filteredSkillCommands.length) % filteredSkillCommands.length)
                    return
                  }
                  if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
                    event.preventDefault()
                    selectSlashCommand(filteredSkillCommands[Math.min(slashCommandHighlight, filteredSkillCommands.length - 1)])
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setSlashMenuDismissed(true)
                    return
                  }
                }
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
              rows={3}
              placeholder={activeSlashCommand?.id === 'skill-creator'
                ? 'Describe the skill you want to create or update…'
                : activeSlashCommand?.id === 'skill-installer'
                  ? 'Paste a skill specification or repository details…'
                  : messages.length > 0
                    ? 'Refine the idea, change a scene, or ask for another direction…'
                    : 'Describe the video you want to create…'}
              className="relative block max-h-32 min-h-[64px] w-full resize-none bg-transparent px-1 text-[11px] leading-5 text-transparent caret-[#E8E1FF] outline-none placeholder:text-white/22 selection:bg-[#7C5CFF]/35 disabled:opacity-45"
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between pl-1">
            <div ref={skillMenuRef} className="relative min-w-0">
              <button
                type="button"
                disabled={!skillsReady || isRunning}
                onClick={() => setSkillMenuOpen((current) => !current)}
                title={selectedSkill ? `Active skill: ${selectedSkill.name}` : 'Choose a reusable AI Idea Agent skill'}
                className={cn(
                  'flex h-8 max-w-[190px] items-center gap-1.5 rounded-lg px-2 text-[9px] font-medium outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-35',
                  selectedSkill
                    ? 'bg-[#7C5CFF]/12 text-[#C8BCFF] hover:bg-[#7C5CFF]/18'
                    : 'text-white/30 hover:bg-white/[0.05] hover:text-white/65'
                )}
              >
                <BookOpen className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{selectedSkill?.name || 'Skill'}</span>
                <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', skillMenuOpen && 'rotate-180')} />
              </button>

              {skillMenuOpen && (
                <div className="absolute bottom-10 left-0 z-[190] w-[330px] overflow-hidden rounded-2xl border border-white/[0.1] bg-[#1A1A1A] shadow-[0_22px_64px_rgba(0,0,0,0.72)]">
                  <div className="flex items-center justify-between border-b border-white/[0.07] px-3.5 py-3">
                    <div>
                      <p className="text-[10px] font-semibold text-white/78">Agent skills</p>
                      <p className="mt-0.5 text-[8px] text-white/28">Reusable creative instructions</p>
                    </div>
                    <button type="button" onClick={() => openSkillEditor()} className="flex h-7 items-center gap-1 rounded-lg bg-[#7C5CFF]/14 px-2 text-[9px] font-semibold text-[#C8BCFF] hover:bg-[#7C5CFF]/22">
                      <Plus className="h-3 w-3" /> New
                    </button>
                  </div>
                  <div className="max-h-[260px] overflow-y-auto p-1.5">
                    <button
                      type="button"
                      onClick={() => selectSkill(null)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05]',
                        !selectedSkill && 'bg-[#7C5CFF]/10'
                      )}
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.025] text-white/30"><X className="h-3.5 w-3.5" /></span>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-[10px] font-medium', !selectedSkill ? 'text-[#C8BCFF]' : 'text-white/60')}>No skill</span>
                        <span className="mt-0.5 block text-[8px] text-white/25">Use the default AI Idea Agent direction</span>
                      </span>
                      {!selectedSkill && <Check className="h-3.5 w-3.5 shrink-0 text-[#A895FF]" />}
                    </button>

                    {skillLibrary.skills.length === 0 ? (
                      <div className="px-3 py-6 text-center">
                        <BookOpen className="mx-auto h-5 w-5 text-white/18" />
                        <p className="mt-2 text-[9px] text-white/30">No saved skills yet</p>
                      </div>
                    ) : skillLibrary.skills.map((skill) => {
                      const active = skill.id === selectedSkill?.id
                      return (
                        <div key={skill.id} className={cn('group flex items-center gap-1 rounded-xl transition-colors hover:bg-white/[0.05]', active && 'bg-[#7C5CFF]/10')}>
                          <button type="button" onClick={() => selectSkill(skill.id)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[#7C5CFF]/18 bg-[#7C5CFF]/8 text-[#B8A8FF]"><BookOpen className="h-3.5 w-3.5" /></span>
                            <span className="min-w-0 flex-1">
                              <span className={cn('block truncate text-[10px] font-medium', active ? 'text-[#D1C8FF]' : 'text-white/62')}>{skill.name}</span>
                              <span className="mt-0.5 block truncate text-[8px] text-white/25">{skill.instruction}</span>
                            </span>
                            {active && <Check className="h-3.5 w-3.5 shrink-0 text-[#A895FF]" />}
                          </button>
                          <button type="button" aria-label={`Edit ${skill.name}`} onClick={() => openSkillEditor(skill)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/22 opacity-0 hover:bg-white/[0.06] hover:text-white/65 group-hover:opacity-100">
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button type="button" aria-label={`Delete ${skill.name}`} onClick={() => deleteSkill(skill.id)} className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/22 opacity-0 hover:bg-red-500/10 hover:text-red-300/75 group-hover:opacity-100">
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {promptAssistantMode === 'api' ? (
                <Select.Root value={apiProviderConfig.model?.trim() || undefined} onValueChange={persistApiModelSelection} disabled={isRunning || !apiProviderConfig.endpoint?.trim()}>
                  <Select.Trigger
                    title={`9Router model: ${apiProviderConfig.model || 'Choose model'}`}
                    aria-label={`Choose 9Router model. Current: ${apiProviderConfig.model || 'not configured'}`}
                    className="relative flex h-8 w-8 items-center justify-center rounded-xl text-white/34 outline-none transition-colors hover:bg-white/[0.06] hover:text-white/70 data-[state=open]:bg-[#7C5CFF]/12 data-[state=open]:text-[#B8A8FF] disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <Box className="h-3.5 w-3.5" />
                    {(isRunning || apiModelsLoading) && (
                      <span className="absolute right-0.5 top-0.5 flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-55" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,.8)]" />
                      </span>
                    )}
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content position="popper" side="top" align="end" sideOffset={8} collisionPadding={12} className="z-[170] w-[340px] overflow-hidden rounded-2xl border border-white/[0.1] bg-[#1B1B1B] p-1.5 shadow-[0_22px_68px_rgba(0,0,0,0.76)]">
                      <div className="border-b border-white/[0.07] px-2.5 pb-2.5 pt-1.5">
                        <p className="text-[10px] font-semibold text-white/78">9Router models</p>
                        <p className="mt-0.5 text-[8px] text-white/28">Grouped by plan · media-capable models are prioritized</p>
                      </div>
                      <Select.Viewport className="max-h-[330px] py-1">
                        {apiModelsLoading && visibleApiModels.length === 0 && (
                          <div className="flex h-14 items-center justify-center gap-2 text-[9px] text-white/32">
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[#A895FF]" /> Loading available models…
                          </div>
                        )}
                        {!apiModelsLoading && apiModelsError && (
                          <div className="px-3 py-4 text-[9px] leading-4 text-red-200/65">{apiModelsError}</div>
                        )}
                        {apiModelGroups.map(([plan, models]) => (
                          <Select.Group key={plan}>
                            <Select.Label className="px-2.5 pb-1 pt-2 text-[8px] font-semibold uppercase tracking-[0.12em] text-white/24">{plan}</Select.Label>
                            {models.map((model) => (
                              <Select.Item key={model.id} value={model.id} className="relative flex min-h-11 cursor-pointer select-none items-center rounded-xl py-2 pl-8 pr-2.5 outline-none data-[highlighted]:bg-[#7C5CFF]/12 data-[state=checked]:bg-[#7C5CFF]/[0.08]">
                                <Select.ItemIndicator className="absolute left-2.5 text-[#B8A8FF]"><Check className="h-3.5 w-3.5" /></Select.ItemIndicator>
                                <span className="min-w-0 flex-1">
                                  <Select.ItemText>{model.name}</Select.ItemText>
                                  <span className={cn('mt-0.5 block truncate text-[8px]', model.recommendedForMedia ? 'text-emerald-300/65' : model.inputModalities.includes('image') ? 'text-[#B8A8FF]/62' : 'text-white/25')}>
                                    {videoAgentModelCapabilityLabel(model)}
                                  </span>
                                </span>
                                {model.recommendedForMedia && <span className="ml-2 shrink-0 rounded-full bg-emerald-400/[0.08] px-1.5 py-0.5 text-[7px] font-semibold uppercase tracking-wide text-emerald-300/70">Media</span>}
                              </Select.Item>
                            ))}
                          </Select.Group>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              ) : (
              <Select.Root value={activeProvider} onValueChange={(value) => setProvider(value as PromptAssistantProvider)} disabled={isRunning}>
                <Select.Trigger
                  title={`Generate with ${promptAssistantProviderLabel(activeProvider)}`}
                  aria-label={`Choose AI provider. Current: ${promptAssistantProviderLabel(activeProvider)}`}
                  className="relative flex h-8 w-8 items-center justify-center rounded-xl text-white/34 outline-none transition-colors hover:bg-white/[0.06] hover:text-white/70 data-[state=open]:bg-[#7C5CFF]/12 data-[state=open]:text-[#B8A8FF] disabled:cursor-not-allowed"
                >
                  <Box className="h-3.5 w-3.5" />
                  {isRunning && (
                    <span className="absolute right-0.5 top-0.5 flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-55" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,.8)]" />
                    </span>
                  )}
                </Select.Trigger>
                <Select.Portal>
                  <Select.Content position="popper" side="top" align="end" sideOffset={8} collisionPadding={12} className="z-[170] min-w-[150px] overflow-hidden rounded-xl border border-white/[0.1] bg-[#1B1B1B] p-1 shadow-[0_18px_48px_rgba(0,0,0,0.68)]">
                    <Select.Viewport>
                      {((promptAssistantMode === 'api'
                        ? ['api']
                        : ['chatgpt', 'gemini']) as PromptAssistantProvider[]).map((item) => {
                        const unavailable = item === 'api' && !apiProviderReady
                        return (
                        <Select.Item key={item} value={item} disabled={unavailable} className="relative flex h-9 cursor-pointer select-none items-center rounded-lg pl-8 pr-3 text-[10px] font-medium text-white/55 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:text-white/18 data-[highlighted]:bg-[#7C5CFF]/12 data-[highlighted]:text-white data-[state=checked]:text-[#C8BCFF]">
                          <Select.ItemIndicator className="absolute left-2.5"><Check className="h-3.5 w-3.5" /></Select.ItemIndicator>
                          <Select.ItemText>{promptAssistantProviderLabel(item)}{unavailable ? ' · Setup required' : ''}</Select.ItemText>
                        </Select.Item>
                        )
                      })}
                    </Select.Viewport>
                  </Select.Content>
                </Select.Portal>
              </Select.Root>
              )}
              <button
                type="button"
                aria-label="Send to AI Idea Agent"
                disabled={!input.trim() || isRunning || !conversationHistoryReady || !activeConversationId || (activeProvider === 'api' && !apiProviderReady)}
                onClick={() => void submit()}
                className={cn('flex h-8 w-8 items-center justify-center rounded-xl transition-all', input.trim() && !isRunning && conversationHistoryReady && activeConversationId && (activeProvider !== 'api' || apiProviderReady) ? 'bg-[#7C5CFF] text-white shadow-[0_7px_18px_rgba(124,92,255,0.28)] hover:bg-[#8768FF]' : 'cursor-not-allowed bg-white/[0.05] text-white/18')}
              >
                {isRunning ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {skillEditorOpen && (
        <div className="absolute inset-0 z-[210] flex items-center justify-center bg-black/68 p-5 backdrop-blur-[2px]" onMouseDown={() => setSkillEditorOpen(false)}>
          <div className="w-full max-w-[370px] overflow-hidden rounded-2xl border border-white/[0.1] bg-[#191919] shadow-[0_28px_90px_rgba(0,0,0,0.78)]" onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#7C5CFF]/22 bg-[#7C5CFF]/10 text-[#B8A8FF]"><BookOpen className="h-4 w-4" /></span>
                <div className="min-w-0">
                  <h3 className="truncate text-[11px] font-semibold text-white/82">{editingSkillId ? 'Edit agent skill' : 'Create agent skill'}</h3>
                  <p className="mt-0.5 text-[8px] text-white/28">Saved locally and reusable in future sessions</p>
                </div>
              </div>
              <button type="button" onClick={() => setSkillEditorOpen(false)} className="flex h-7 w-7 items-center justify-center rounded-lg text-white/28 hover:bg-white/[0.06] hover:text-white/70"><X className="h-3.5 w-3.5" /></button>
            </div>

            <div className="space-y-3 px-4 py-4">
              <label className="block">
                <span className="mb-1.5 block text-[9px] font-medium text-white/42">Skill name</span>
                <input
                  autoFocus
                  value={skillDraftName}
                  maxLength={64}
                  onChange={(event) => setSkillDraftName(event.target.value)}
                  placeholder="e.g. Cinematic storyboard director"
                  className="h-10 w-full rounded-xl border border-white/[0.08] bg-[#101010] px-3 text-[10px] text-white/76 outline-none placeholder:text-white/20 focus:border-[#7C5CFF]/55 focus:ring-2 focus:ring-[#7C5CFF]/10"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[9px] font-medium text-white/42">Reusable instructions</span>
                <textarea
                  value={skillDraftInstruction}
                  maxLength={12000}
                  rows={9}
                  onChange={(event) => setSkillDraftInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault()
                      void saveSkillDraft()
                    }
                  }}
                  placeholder="Describe how the agent should structure ideas, storyboards, shots, camera movement, visual direction, or output format."
                  className="block max-h-[280px] min-h-[170px] w-full resize-y rounded-xl border border-white/[0.08] bg-[#101010] px-3 py-2.5 text-[10px] leading-[1.6] text-white/70 outline-none placeholder:text-white/20 focus:border-[#7C5CFF]/55 focus:ring-2 focus:ring-[#7C5CFF]/10"
                />
              </label>
              <div className="flex items-center justify-between text-[8px] text-white/20">
                <span>Ctrl + Enter to save</span>
                <span>{skillDraftInstruction.length.toLocaleString()}/12,000</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-white/[0.07] px-4 py-3">
              <button type="button" onClick={() => setSkillEditorOpen(false)} className="h-9 rounded-xl px-3.5 text-[10px] font-medium text-white/40 hover:bg-white/[0.05] hover:text-white/70">Cancel</button>
              <button
                type="button"
                disabled={!skillDraftName.trim() || !skillDraftInstruction.trim()}
                onClick={() => void saveSkillDraft()}
                className="flex h-9 items-center gap-1.5 rounded-xl bg-[#7C5CFF] px-3.5 text-[10px] font-semibold text-white shadow-[0_8px_20px_rgba(124,92,255,0.24)] hover:bg-[#8768FF] disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Check className="h-3.5 w-3.5" /> Save skill
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}

const WorkflowCanvas: React.FC<WorkflowCanvasProps> = ({ workflow, isSidebarOpen, onToggleSidebar, onBackToDashboard, windowMode = false }) => {
  const updateWorkflow = useWorkflowStore((s) => s.updateWorkflow)
  const addNode = useWorkflowStore((s) => s.addNode)
  const updateNode = useWorkflowStore((s) => s.updateNode)
  const updateNodeAndRemoveEdges = useWorkflowStore((s) => s.updateNodeAndRemoveEdges)
  const updateNodePosition = useWorkflowStore((s) => s.updateNodePosition)
  const updateNodePositions = useWorkflowStore((s) => s.updateNodePositions)
  const replaceWorkflowNodes = useWorkflowStore((s) => s.replaceWorkflowNodes)
  const addEdgeToStore = useWorkflowStore((s) => s.addEdge)
  const deleteNode = useWorkflowStore((s) => s.deleteNode)
  const deleteNodes = useWorkflowStore((s) => s.deleteNodes)
  const deleteEdge = useWorkflowStore((s) => s.deleteEdge)
  const setSelectedNode = useWorkflowStore((s) => s.setSelectedNode)
  // [WorkflowSelection] Logged wrapper. Routes every
  // `setSelectedNode(...)` call from the entire component through
  // a single log so a re-add after a clear is always traceable.
  // Default reason is the callsite description; callers can
  // override with a more specific source string.
  const setSelectedNodeWithLog = (nodeId: string | null, reason: string) => {
    const from = useWorkflowStore.getState().selectedNodeId
    wfSelectionLog('setSelectedNode', { from, to: nodeId, reason })
    setSelectedNode(nodeId)
  }
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId)
  const undoWorkflow = useWorkflowStore((s) => s.undoWorkflow)
  const redoWorkflow = useWorkflowStore((s) => s.redoWorkflow)
  const canUndo = useWorkflowStore((s) => Boolean(s.history[workflow.id]?.past.length))
  const canRedo = useWorkflowStore((s) => Boolean(s.history[workflow.id]?.future.length))
  const isRunning = usePipelineStore((s) => s.isRunning)
  const isPaused = usePipelineStore((s) => s.isPaused)
  const activeTaskId = usePipelineStore((s) => s.activeTaskId)
  const tasks = usePipelineStore((s) => s.tasks)
  const logs = usePipelineStore((s) => s.logs)

  const canvasRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<DrawflowInstance | null>(null)
  const workflowRef = useRef(workflow)
  const autoFitWorkflowIdRef = useRef<string | null>(null)
  const suppressEdgeEventRef = useRef(false)
  const connectionSyncFrameRef = useRef<number | null>(null)
  const connectionRefreshFrameRef = useRef<number | null>(null)
  const pendingConnectionRefreshIdsRef = useRef<Set<string>>(new Set())
  const refreshAllConnectionsRef = useRef(false)
  const nodeResizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map())
  const overlayObserversRef = useRef<WeakMap<SVGPathElement, MutationObserver>>(new WeakMap())
  const nodePickerSpawnRef = useRef<{ x: number; y: number } | null>(null)
  const copiedNodeGroupRef = useRef<{ targetNodeId: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] } | null>(null)
  const multiSelectedNodeIdsRef = useRef<Set<string>>(new Set())
  // [WorkflowMarquee] Live preview set. Populated only WHILE the user
  // is Ctrl+dragging a marquee rectangle. The `.selected` /
  // `.conn-node-selected` classes applied from this set are transient
  // — they vanish the moment the marquee ends, the mouseup commits
  // the selection, or the gesture is cancelled. Keeping this in a
  // ref (not React state) lets the rAF hit-test mutate it ~60 Hz
  // without re-rendering the workflow tree.
  const marqueePreviewNodeIdsRef = useRef<Set<string>>(new Set())
  const marqueePreviewFrameRef = useRef<number | null>(null)
  const marqueeLastRectRef = useRef<MarqueeRect | null>(null)
  const marqueeActiveRef = useRef<boolean>(false)
  const marqueePreviewCountRef = useRef<number>(0)
  const lastCanvasPointerRef = useRef<{ x: number; y: number } | null>(null)
  const nodePickerRef = useRef<HTMLDivElement | null>(null)
  const nodePillMenuRef = useRef<HTMLDivElement | null>(null)
  const selectionMouseDownRef = useRef<{ nodeId: string | null; clearOnUnselect: boolean } | null>(null)
  const portDragCleanupRef = useRef<(() => void) | null>(null)
  // [CanvasInvestigate] observation-only ref — does NOT change
  // production behavior. Set true while Drawflow is firing
  // `nodeMoved` for an active drag, false on the next non-drawflow
  // tick that exceeds `dragInactivityMs`. Used by the probe logs
  // to disambiguate "during drag" vs "idle dragfinish".
  const canvasDragInFlightRef = useRef<{ nodeId: string | null; lastTickAt: number }>({
    nodeId: null,
    lastTickAt: 0,
  })

  // [CanvasFix] Accumulator of per-node positions captured during
  // a drag. While Drawflow is dispatching `nodeMoved` (30–60 Hz),
  // we write the latest (x, y) here WITHOUT touching the store.
  // On `mouseUp`, the map is drained into a single
  // `updateNodePositions` bulk call so the store + persist +
  // undo history each receives exactly one write per drag.
  const pendingDragPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())

  // [GroupDrag] Group drag state. Activated when the user clicks on a
  // node that belongs to a multi-selection set of ≥2 nodes. Captures
  // the leader's start position and snapshots the start positions of
  // every other selected node, then mirrors the leader's per-tick
  // delta onto each follower. No store write, no history, no
  // hydrateDrawflow / editor.import during the gesture — positions
  // are written to `pendingDragPositionsRef` (the same map the
  // single-node drag uses) and the existing `mouseUp` handler drains
  // them into a single bulk `updateNodePositions` call. That means
  // one history entry per group drag, and Ctrl+Z restores the whole
  // group in one undo step.
  type GroupDragState = {
    active: boolean
    leaderNodeId: string | null
    leaderStart: { x: number; y: number } | null
    startPositions: Map<string, { x: number; y: number }>
    selectedIds: Set<string>
    lastDelta: { x: number; y: number }
    frame: number | null
    applyingFollowers: boolean
  }

  // [GroupDrag][mirror] Mirror state captured on plain mousedown
  // over a node that is already in the multi-selection. Holds:
  //   - `grabbedId`: the leader Drawflow will drag natively.
  //   - `selectedIds`: snapshot of the multi-selection at start.
  //   - `starts`: per-node pre-drag {left,top} read from the DOM
  //     (with editor-internal pos_x/pos_y as fallback).
  //   - `mouseStartX/Y`: viewport pixels at mousedown.
  //   - `zoom`: editor.zoom at start (delta is divided by zoom so
  //     dx/dy stays canvas-px regardless of the current zoom level).
  // Document `mousemove` / `mouseup` capture-phase listeners compute
  // `dx = (clientX - mouseStartX) / zoom` and apply that delta to
  // every follower via `applyDrawflowNodePosition`. The leader is
  // skipped — Drawflow moves it natively. Mouseup commits bulk.
  type MultiDragState = {
    grabbedId: string
    selectedIds: Set<string>
    starts: Map<string, { el: HTMLElement; left: number; top: number }>
    mouseStartX: number
    mouseStartY: number
    zoom: number
    /**
     * True once a `mirrorMove` tick has fired with a non-zero
     * delta. Used by `finishMultiDragMirror` to skip the bulk
     * commit when the user just clicked without dragging — we
     * must NOT call `updateNodePositions` for an unchanged
     * cluster (otherwise the store would see a phantom write
     * and `updatedAt` / history would move on a no-op gesture).
     */
    moved: boolean
  }
  const multiDragRef = useRef<MultiDragState | null>(null)
  const multiDragFrameRef = useRef<number | null>(null)

  const groupDragRef = useRef<GroupDragState>({
    active: false,
    leaderNodeId: null,
    leaderStart: null,
    startPositions: new Map(),
    selectedIds: new Set(),
    lastDelta: { x: 0, y: 0 },
    frame: null,
    applyingFollowers: false
  })

  // [CanvasFix] Per-node lightweight rAF handle for `nodeMoved`
  // ticks. Unlike `scheduleDrawflowConnectionRefresh`, this does
  // NOT call applyPortAttributes / attachNodeResizeObservers /
  // refreshAllConnections — it only repaints the SVG paths
  // attached to the dragged node via Drawflow's
  // `editor.updateConnectionNodes(nodeId)`. Throttled by rAF so
  // 60 Hz draw ticks collapse to ~60 Hz repaints but never
  // trigger the heavy full-canvas path.
  const lightweightConnectionRefreshFrameRef = useRef<number | null>(null)
  const lightweightConnectionRefreshNodeIdRef = useRef<string | null>(null)

  // [WorkflowSelection] Defensive guard against a Drawflow-stale
  // `nodeSelected` re-firing within the same mousedown that just
  // cleared the selection. Drawflow's click handler is synchronous
  // and runs inside the same mousedown event; if our `nodeUnselected`
  // listener fires `clearCanvasSelection(...)` (which removes the
  // `.selected` class and `setSelectedNode(null)`), but a subsequent
  // `nodeSelected` event lands within the same event loop turn with
  // a stale id, the highlight would re-appear. We use this ref to
  // suppress that re-add for a short window. Default 0 = inactive.
  const clearInFlightUntilRef = useRef<number>(0)

  // [WorkflowSelection] Editor root wrapper ref used for a JSX
  // `onPointerDownCapture` handler. We deliberately wire this
  // through React (not `addEventListener`) so the lifecycle is
  // tied to the component mount and cannot drift out of sync with
  // the editor's `useEffect` cleanup path.
  const editorRootRef = useRef<HTMLDivElement | null>(null)

  const [isPaletteOpen, setIsPaletteOpen] = useState(false)
  const [nodePickerSearch, setNodePickerSearch] = useState('')
  const [selectedPickerIndex, setSelectedPickerIndex] = useState(0)
  const [nodePickerPosition, setNodePickerPosition] = useState<{ x: number; y: number } | null>(null)
  const [nodePillMenu, setNodePillMenu] = useState<NodePillMenuState | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [isRenamingWorkflow, setIsRenamingWorkflow] = useState(false)
  const [workflowNameDraft, setWorkflowNameDraft] = useState(workflow.name)
  const workflowNameInputRef = useRef<HTMLInputElement | null>(null)
  const [zoomLevel, setZoomLevel] = useState(100)
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null)
  // [WorkflowTemplate] Tiny inline toast for Save-to-Template feedback.
  // Plain useState instead of a global store — only this component
  // mounts the editor header where the button lives, and a single
  // toast slot keeps the body free of third-party toast libs in
  // production. The state holds either null or { tone, message } and
  // auto-clears on a timer started by handleSaveAsTemplate.
  const [templateToast, setTemplateToast] = useState<{
    tone: 'success' | 'error' | 'warning'
    message: string
  } | null>(null)
  const templateToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashTemplateToast = (
    tone: 'success' | 'error' | 'warning',
    message: string
  ) => {
    if (templateToastTimerRef.current) {
      clearTimeout(templateToastTimerRef.current)
      templateToastTimerRef.current = null
    }
    setTemplateToast({ tone, message })
    templateToastTimerRef.current = setTimeout(() => {
      setTemplateToast(null)
      templateToastTimerRef.current = null
    }, 2600)
  }

  // [WorkflowTemplate] Drop the timeout on unmount so a stale
  // setState doesn't fire after the editor has closed.
  useEffect(() => {
    return () => {
      if (templateToastTimerRef.current) {
        clearTimeout(templateToastTimerRef.current)
        templateToastTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!isRenamingWorkflow) setWorkflowNameDraft(workflow.name)
  }, [isRenamingWorkflow, workflow.id, workflow.name])

  useEffect(() => {
    if (!isRenamingWorkflow) return
    const input = workflowNameInputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [isRenamingWorkflow])

  const beginWorkflowRename = () => {
    setWorkflowNameDraft(workflow.name)
    setIsRenamingWorkflow(true)
  }

  const cancelWorkflowRename = () => {
    setWorkflowNameDraft(workflow.name)
    setIsRenamingWorkflow(false)
  }

  const commitWorkflowRename = () => {
    const nextName = workflowNameDraft.trim()
    setIsRenamingWorkflow(false)
    if (!nextName || nextName === workflow.name) {
      setWorkflowNameDraft(workflow.name)
      return
    }
    setWorkflowNameDraft(nextName)
    updateWorkflow(workflow.id, { name: nextName })
  }
  const [inspectorNodeId, setInspectorNodeId] = useState<string | null>(null)
  const [videoAgentOpen, setVideoAgentOpen] = useState(false)
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null)
  // Multi-selection: the Set lives in a ref for hot-path reads inside
  // syncSelectedNodeDom / syncConnectionOverlays, and we mirror the
  // same data into a state so React-driven UI (marquee overlay,
  // selection counter) re-renders. Keep both in sync via the
  // `setMultiSelectedNodeIds` helper defined further down.
  const [multiSelectedNodeIds, setMultiSelectedNodeIdsState] = useState<string[]>([])
  // [WorkflowMarquee] React-side mirror of `marqueePreviewNodeIdsRef.size`.
  // We only push this through state (causing one render per COUNT CHANGE,
  // not per pixel of mouse motion) so the badge can update during drag.
  const [marqueePreviewCount, setMarqueePreviewCount] = useState<number>(0)
  const setMultiSelectedNodeIds = (next: Iterable<string> | null) => {
    if (next == null) {
      multiSelectedNodeIdsRef.current = new Set()
      setMultiSelectedNodeIdsState([])
      return
    }
    const arr = Array.from(new Set(next))
    multiSelectedNodeIdsRef.current = new Set(arr)
    setMultiSelectedNodeIdsState(arr)
  }

  // ── Pipeline run visual state ─────────────────────────────────────────
  type NodeRunStatus = 'idle' | 'running' | 'completed' | 'failed'
  const [nodeRunStates, setNodeRunStates] = useState<Record<string, NodeRunStatus>>({})
  const [activeEdges, setActiveEdges] = useState<Record<string, { source: string; target: string; sourceHandle?: string; targetHandle?: string }>>({})
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, unknown>>({})

  function applyNodeVisualRunState(nodeId: string, status: NodeRunStatus) {
    const container = document.querySelector('.parent-drawflow')
    if (!container) return false

    const selectorTried = `[data-workflow-node-id="${CSS.escape(nodeId)}"]`
    const el = container.querySelector<HTMLElement>(selectorTried)
    if (!el) return false

    const card =
      (el.querySelector<HTMLElement>('.df-node-body'))
      || (el.querySelector<HTMLElement>('.df-node-card'))
      || (el.querySelector<HTMLElement>('.node-card'))
      || (el.querySelector<HTMLElement>('.workflow-node-card'))
      || el
    const wrapper = el.closest<HTMLElement>('.drawflow-node')

    for (const target of [wrapper, el, card]) {
      if (!target) continue
      target.classList.remove('ai-node-running', 'ai-node-completed', 'ai-node-failed')
      target.removeAttribute('data-run-state')
    }

    if (status !== 'idle') {
      for (const target of [wrapper, el, card]) {
        if (!target) continue
        target.classList.add(`ai-node-${status}`)
        target.setAttribute('data-run-state', status)
      }
    }

    return true
  }

  // ── Run-state DOM cleanup ─────────────────────────────────────────────
  // Removes `ai-node-running|completed|failed` and `data-run-state` from
  // EVERY workflow node wrapper + card in the Drawflow canvas. Used:
  //   1) at the very start of a new run (handleRun) so stale classes
  //      from a previous run cannot leak into the new run.
  //   2) at the start of syncNodeRunStates() to make the sync
  //      deterministic — we clear first, then re-apply for ONLY the
  //      nodes currently in nodeRunStates. This guarantees that
  //      downstream / next / upstream nodes that are NOT in
  //      nodeRunStates stay neutral.
  //
  // Without this, a node that was 'completed' in a previous run would
  // keep its ai-node-completed class during the next run (until
  // something explicitly removed it), producing the "downstream glow"
  // bug observed in the UI.
  function clearAllRunDomClasses(): number {
    const container = document.querySelector('.parent-drawflow')
    if (!container) return 0
    let cleared = 0
    const nodes = container.querySelectorAll<HTMLElement>(
      '[data-workflow-node-id], .df-node, .drawflow-node'
    )
    nodes.forEach((el) => {
      const card =
        (el.querySelector<HTMLElement>('.df-node-body'))
        || (el.querySelector<HTMLElement>('.df-node-card'))
        || (el.querySelector<HTMLElement>('.node-card'))
        || (el.querySelector<HTMLElement>('.workflow-node-card'))
      const targets: (HTMLElement | null)[] = [el, el.closest<HTMLElement>('.drawflow-node'), card]
      for (const target of targets) {
        if (!target) continue
        if (
          target.classList.contains('ai-node-running')
          || target.classList.contains('ai-node-completed')
          || target.classList.contains('ai-node-failed')
          || target.hasAttribute('data-run-state')
        ) {
          target.classList.remove('ai-node-running', 'ai-node-completed', 'ai-node-failed')
          target.removeAttribute('data-run-state')
          cleared++
        }
      }
    })
    debugLog('nodeState', '[NodeStateDebug] run reset', { clearedDomNodes: cleared })
    return cleared
  }

  // ── Pipeline visual callbacks ─────────────────────────────────────────
  const pipelineCallbacks = useMemo(() => ({
    onNodeStart: (nodeId: string) => {
      const enabledNodeIds = new Set(
        (workflow.nodes || [])
          .filter((node: WorkflowNode) => (node.data as Record<string, unknown>).enabled !== false)
          .map((node: WorkflowNode) => node.id)
      )
      const enabledEdges = (workflow.edges || [])
        .filter((edge: WorkflowEdge) => enabledNodeIds.has(edge.source) && enabledNodeIds.has(edge.target))

      debugLog('edgeFlow', '[EdgeFlowDebug][Editor] node start', {
        nodeId,
        activeIncomingEdges: (workflow.edges || [])
          .filter((e: WorkflowEdge) => e.target === nodeId)
          .map((e: WorkflowEdge) => e.id),
        incorrectlyActiveOutgoingEdges: (workflow.edges || [])
          .filter((e: WorkflowEdge) => e.source === nodeId)
          .map((e: WorkflowEdge) => e.id),
        reason: 'only incoming edges become active — outgoing stay inactive until the NEXT node onNodeStart',
      })
      debugLog('glow', '[GlowDebug][Editor] onNodeStart', { nodeId })
      // [NodeStateDebug] — surface the post-update nodeRunStates so we
      // can verify downstream / next / unstarted nodes stay neutral
      // and the only new entry is `nodeId: 'running'`.
      let postStartNodeRunStates: Record<string, NodeRunStatus> = {}
      setNodeRunStates((prev) => {
        const next = { ...prev, [nodeId]: 'running' }
        postStartNodeRunStates = next
        return next
      })
      debugLog('nodeState', '[NodeStateDebug] onNodeStart', {
        nodeId,
        nextNodeRunStates: postStartNodeRunStates,
        downstreamNodeIds: (workflow.edges || [])
          .filter((e: WorkflowEdge) => e.source === nodeId)
          .map((e: WorkflowEdge) => e.target),
      })
      // Activate incoming edges (data flowing into this node).
      // Outgoing edges of THIS node are intentionally NOT activated
      // here — they will only light up when the NEXT node starts, at
      // which point the edge's target is the next node and it gets
      // activated as part of that next-node's incoming set.
      const incoming = enabledEdges
        .filter((e: WorkflowEdge) => e.target === nodeId)
      if (incoming.length > 0) {
        setActiveEdges((prev) => {
          const next = { ...prev }
          for (const edge of incoming) {
            next[edge.id] = {
              source: edge.source,
              target: edge.target,
              sourceHandle: edge.sourceHandle || 'output_1',
              targetHandle: edge.targetHandle || 'input_1'
            }
          }
          return next
        })
      }
    },
    onNodeComplete: (nodeId: string, output: unknown) => {
      debugLog('edgeFlow', '[EdgeFlowDebug][Editor] node complete', {
        nodeId,
        incomingEdgesToDeactivate: (workflow.edges || [])
          .filter((e: WorkflowEdge) => e.target === nodeId)
          .map((e: WorkflowEdge) => e.id),
        outgoingEdgesNotActivatedHere: (workflow.edges || [])
          .filter((e: WorkflowEdge) => e.source === nodeId)
          .map((e: WorkflowEdge) => e.id),
        reason: 'edge activation moves to the NEXT node onNodeStart',
      })
      debugLog('glow', '[GlowDebug][Editor] onNodeComplete', { nodeId, output })
      // Minimum visible duration so Media/Prompt that finish in <50ms
      // still flash the running glow before settling into the completed purple state.
      const startedAt = Date.now()
      setNodeRunStates((prev) => prev) // ensure state subscription
      const elapsed = Date.now() - startedAt
      const minRunningMs = 500
      const delayMs = Math.max(0, minRunningMs - elapsed)
      const finalize = () => {
        let postCompleteNodeRunStates: Record<string, NodeRunStatus> = {}
        setNodeRunStates((prev) => {
          const next = { ...prev, [nodeId]: 'completed' }
          postCompleteNodeRunStates = next
          return next
        })
        debugLog('nodeState', '[NodeStateDebug] onNodeComplete', {
          nodeId,
          nextNodeRunStates: postCompleteNodeRunStates,
          downstreamNodeIds: (workflow.edges || [])
            .filter((e: WorkflowEdge) => e.source === nodeId)
            .map((e: WorkflowEdge) => e.target),
        })
        setNodeOutputs((prev) => ({ ...prev, [nodeId]: output }))
        const completedNode = workflow.nodes.find((n: WorkflowNode) => n.id === nodeId)
        if (completedNode?.type === 'generate') {
          // Persist a default `selectedOutputIndex = 0` on the node
          // data if the user hasn't picked one yet. The runner reads
          // this to decide which single asset to forward to the
          // downstream node when the upstream produced N>1 assets.
          // Without this default, the runner falls back to 0 anyway,
          // but storing it explicitly makes the runner's read path
          // and the UI's read path agree on every lookup.
          const completedData = (completedNode.data || {}) as Record<string, unknown>
          const nextData: Record<string, unknown> = { _output: output }
          if (typeof completedData.selectedOutputIndex !== 'number') {
            nextData.selectedOutputIndex = 0
          }
          updateNode(nodeId, nextData as Partial<FlowNodeData>)

          // [AssetStore] Cache every output URL into IndexedDB in
          // the background. We commit the original descriptor to
          // node.data first so the preview paints from the URL
          // immediately — no waiting on fetch / save. Once the
          // enrichment resolves, we rewrite _output with assetId /
          // posterAssetId fields so the renderer can prefer the
          // local cache on subsequent renders and after reload.
          // The original `url` / `videoUrl` / `imageUrl` /
          // `mediaUrl` / `thumbnailUrl` are NEVER removed, so the
          // auto-download path keeps working without changes.
          void (async () => {
            try {
              const enriched = await cacheGenerateOutputs(output)
              if (!enriched || enriched === output) return
              setNodeOutputs((prev) => ({ ...prev, [nodeId]: enriched }))
              const current = workflowRef.current.nodes.find((n) => n.id === nodeId)
              if (current) {
                const enrichedData: Record<string, unknown> = { _output: enriched }
                if (typeof (current.data as Record<string, unknown>).selectedOutputIndex === 'number') {
                  enrichedData.selectedOutputIndex = (current.data as Record<string, unknown>).selectedOutputIndex
                } else {
                  enrichedData.selectedOutputIndex = 0
                }
                updateNode(nodeId, enrichedData as Partial<FlowNodeData>)
              }
            } catch (err) {
              // [AssetStore] Background enrichment failure stays
              // silent — preview keeps rendering from the URL.
              // eslint-disable-next-line no-console
              console.warn('[AssetStore] cacheGenerateOutputs rejected', err instanceof Error ? err.message : String(err))
            }
          })()

          // [Workflow][NodeOutputPreview] — emitted exactly once per
          // Generate-node completion so operators can confirm the
          // editor sees the right shape: which URL fields are
          // populated, what media type is detected, and which DOM
          // element (`<img>` vs `<video>`) will be rendered. Catches
          // the "Flow succeeded with outputsCount=1 but Generate
          // node renders blank" bug class — if `firstMediaType` is
          // 'image' for a video output, the video URL is being
          // routed into the wrong field downstream.
          try {
            const outputRecord = (output as Record<string, unknown> | undefined) || {}
            const outputList = Array.isArray(outputRecord.outputs)
              ? (outputRecord.outputs as unknown[]).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
              : []
            const firstOutput = outputList[0] || {}
            const firstType = String(firstOutput.type || firstOutput.mediaType || '')
            const firstMediaType = detectGenerateOutputMediaType(firstOutput)
            const url = String(firstOutput.url || '')
            const mediaUrl = String(firstOutput.mediaUrl || '')
            const videoUrl = String(firstOutput.videoUrl || '')
            const imageUrl = String(firstOutput.imageUrl || '')
            const previewRenderAs = firstMediaType === 'video' ? '<video>' : '<img>'
            console.log('[Workflow][NodeOutputPreview] ' + JSON.stringify({
              nodeId,
              outputsCount: outputList.length,
              outputsAvailableCount: outputList.filter((o) => o.outputAvailable === true).length,
              firstType,
              firstMediaType,
              url,
              mediaUrl,
              videoUrl,
              imageUrl,
              renderAs: previewRenderAs,
              note: 'video outputs should render as <video>, image outputs as <img>'
            }))
          } catch (_) {}
        }
        // Refresh node DOM so Generate node shows output preview.
        // We intentionally DO NOT activate outgoing edges here — the
        // edge from the just-completed node to the next node lights
        // up only when the next node's onNodeStart fires (at which
        // point the edge's target is the next node and it gets
        // activated as part of that next-node's incoming set).
        requestAnimationFrame(() => {
          const domNode = document.querySelector(`[data-workflow-node-id="${CSS.escape(nodeId)}"]`)
          if (domNode) {
            const node = workflow.nodes.find((n: WorkflowNode) => n.id === nodeId)
            if (node) {
              const nodeData = (node.data || {}) as Record<string, unknown>
              // Include selectedOutputIndex in the DOM-rendering
              // snapshot so the carousel renders with the right
              // initial index (the persisted value, not undefined).
              const renderPatch: Record<string, unknown> = { _output: output }
              if (typeof nodeData.selectedOutputIndex === 'number') {
                renderPatch.selectedOutputIndex = nodeData.selectedOutputIndex
              } else {
                renderPatch.selectedOutputIndex = 0
              }
              const updatedNode = { ...node, data: { ...node.data, ...renderPatch } }
              const content = domNode.closest('.drawflow_content_node') || domNode.parentElement
              if (content) {
                content.innerHTML = renderDrawflowNode(updatedNode)
                applyPortAttributesForNode(updatedNode)
                applyNodeVisualRunState(nodeId, 'completed')
                attachNodeResizeObserver(nodeId)
                scheduleDrawflowConnectionRefresh(nodeId)
              }
            }
          }
        })
      }
      if (delayMs > 0) setTimeout(finalize, delayMs)
      else finalize()
    },
    onNodeFail: (nodeId: string, error: string) => {
      debugLog('glow', '[GlowDebug][Editor] onNodeFail', { nodeId, error })
      setNodeRunStates((prev) => ({ ...prev, [nodeId]: 'failed' }))
      // Deactivate ALL active edges so nothing glows forever
      setActiveEdges({})
    },
    onEdgeActive: (edgeId: string) => {
      // Resolve source/target from workflow.edges — callback only ships edgeId.
      const edge = (workflow.edges || []).find((e: WorkflowEdge) => e.id === edgeId)
      if (!edge) {
        debugLog('glow', '[GlowDebug][Editor] onEdgeActive', { edgeId })
        return
      }
      // Find the running target node — edges only become active when
      // their TARGET is the currently running node (per the user rule:
      // "active incoming edges of current running node only").
      const runningTargetIds = (workflow.nodes || [])
        .filter((n: WorkflowNode) => n.id === edge.target)
        .map((n: WorkflowNode) => n.id)
      debugLog('edgeFlow', '[EdgeFlowDebug][Editor] edge active', {
        edgeId,
        source: edge.source,
        target: edge.target,
        runningNodeId: edge.target,
        reason: 'incoming-to-running-node',
      })
      debugLog('glow', '[GlowDebug][Editor] onEdgeActive', { edgeId, runningTargetIds })
      setActiveEdges((prev) => ({
        ...prev,
        [edgeId]: {
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle || 'output_1',
          targetHandle: edge.targetHandle || 'input_1'
        }
      }))
    },
    onEdgeInactive: (edgeId: string) => {
      const edge = (workflow.edges || []).find((e: WorkflowEdge) => e.id === edgeId)
      if (edge) {
        debugLog('edgeFlow', '[EdgeFlowDebug][Editor] edge inactive', {
          edgeId,
          source: edge.source,
          target: edge.target,
          reason: 'node-finished',
        })
      }
      debugLog('glow', '[GlowDebug][Editor] onEdgeInactive', { edgeId })
      setActiveEdges((prev) => {
        if (!(edgeId in prev)) return prev
        const next = { ...prev }
        delete next[edgeId]
        return next
      })
    },
  }), [workflow, updateNode]) // eslint-disable-line react-hooks/exhaustive-deps

  const pipelineCallbacksRef = useRef<PipelineCallbacks>(pipelineCallbacks)
  useEffect(() => {
    pipelineCallbacksRef.current = pipelineCallbacks
  }, [pipelineCallbacks])

  // Apply node run state classes to DOM nodes.
  //
  // Deterministic: every call starts from a clean canvas — we
  // clearAllRunDomClasses() first to remove any stale
  // `ai-node-running|completed|failed` / `data-run-state` that may
  // have been left on the DOM by a previous run, by an aborted run,
  // or by a `dataSignature` change that wiped the innerHTML without
  // re-applying state. Then we re-apply classes for ONLY the nodes
  // currently present in `nodeRunStates`. Nodes NOT in nodeRunStates
  // (including downstream / next / unstarted nodes) stay neutral.
  //
  // This eliminates the "downstream glow" UI bug where a node that
  // ran in a previous run retained its `ai-node-completed` class
  // during the next run, causing it to look like it was still
  // running while the actual current node was elsewhere.
  const syncNodeRunStates = () => {
    const container = document.querySelector('.parent-drawflow')
    if (!container) return
    clearAllRunDomClasses()
    for (const [nodeId, status] of Object.entries(nodeRunStates)) {
      const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
      const data = (node?.data || {}) as Record<string, unknown>
      const output = data._output || nodeOutputs[nodeId]
      const hasSuccessfulOutput =
        node?.type === 'generate' &&
        getGenerateOutputImageUrls(output).length > 0
      const visualStatus: NodeRunStatus = status === 'running' && hasSuccessfulOutput ? 'completed' : status
      const selectorTried = `[data-workflow-node-id="${CSS.escape(nodeId)}"]`
      const el = container.querySelector<HTMLElement>(selectorTried)
      if (!el) {
        debugLog('glow', '[GlowDebug][DOM] apply node state', {
          nodeId,
          state: visualStatus,
          found: false,
          selectorTried,
          classNameBefore: '',
          classNameAfter: ''
        })
        continue
      }
      // Find the inner card/body so the box-shadow renders inside the
      // node box (Drawflow's .drawflow-node wrapper is an outer shell
      // whose box-shadow is clipped by overflow).
      const card =
        (el.querySelector<HTMLElement>('.df-node-body'))
        || (el.querySelector<HTMLElement>('.df-node-card'))
        || (el.querySelector<HTMLElement>('.node-card'))
        || (el.querySelector<HTMLElement>('.workflow-node-card'))
        || el
      const classNameBefore = el.className
      applyNodeVisualRunState(nodeId, visualStatus)
      const classNameAfter = el.className
      const cardClassNameAfter = (() => {
        try { return card.className } catch { return 'error' }
      })()
      const computedBoxShadow = (() => {
        try { return getComputedStyle(card).boxShadow } catch { return 'error' }
      })()
      debugLog('nodeState', '[NodeStateDebug] sync apply', {
        nodeId,
        state: visualStatus,
        found: true,
        classNameAfter,
        cardClassNameAfter,
      })
      debugLog('glow', '[GlowDebug][DOM] apply node state', {
        nodeId,
        state: visualStatus,
        found: true,
        selectorTried,
        classNameBefore,
        classNameAfter,
        cardTagName: card.tagName,
        cardClassName: cardClassNameAfter,
        computedBoxShadow
      })
    }

    // ── Downstream-glow detector ────────────────────────────────────
    // After re-applying, scan the DOM for any node that has a run
    // class but is NOT in nodeRunStates. If we find one whose id is
    // downstream of a currently-running node, that means a stale
    // class leaked — useful for the next regression. We only log;
    // we don't auto-fix because the deterministic clear-and-apply
    // above should already have removed the stale class.
    try {
      const runningIds = Object.entries(nodeRunStates)
        .filter(([, s]) => s === 'running')
        .map(([id]) => id)
      if (runningIds.length > 0) {
        const downstreamOf = (id: string) => workflowRef.current.edges
          .filter((e) => e.source === id)
          .map((e) => e.target)
        const downstreamIds = new Set<string>()
        for (const rid of runningIds) {
          for (const t of downstreamOf(rid)) downstreamIds.add(t)
        }
        for (const targetId of downstreamIds) {
          const stateInMap = nodeRunStates[targetId]
          if (stateInMap) continue
          const el = container.querySelector<HTMLElement>(
            `[data-workflow-node-id="${CSS.escape(targetId)}"]`
          )
          if (!el) continue
          const className = el.getAttribute('class') || ''
          const runState = el.getAttribute('data-run-state')
          if (
            className.includes('ai-node-running')
            || className.includes('ai-node-completed')
            || className.includes('ai-node-failed')
            || runState
          ) {
            debugWarn('nodeState', '[NodeStateDebug] unexpected downstream glow', {
              runningNodeId: runningIds,
              downstreamNodeId: targetId,
              downstreamClassName: className,
              downstreamRunState: runState,
            })
          }
        }
      }
    } catch (_) {}
  }

  // Apply active edge animations to Drawflow SVG paths.
  // Drawflow SVG connections don't have stable IDs — we locate them by
  // (1) data-edge-id attribute if present, (2) source/target port
  // containment via SVG output/input markers.
  const syncActiveEdges = () => {
    const container = document.querySelector('.parent-drawflow')
    if (!container) return

    // Deactivate ALL first, then re-activate matching ones.
    const allSvgs = container.querySelectorAll<SVGSVGElement>('.connection')
    allSvgs.forEach((svg) => {
      svg.classList.remove('ai-edge-running', 'ai-edge-completed', 'connection-active')
      svg.querySelectorAll<SVGPathElement>('path').forEach((path) => {
        path.style.strokeDasharray = ''
        path.style.animation = ''
      })
    })

    // Activate edges that are in the activeEdges map.
    for (const [edgeId, meta] of Object.entries(activeEdges)) {
      const sourceId = meta.source
      const targetId = meta.target
      if (!sourceId || !targetId) {
        debugLog('glow', '[GlowDebug][DOM] apply edge state', {
          edgeId,
          source: sourceId,
          target: targetId,
          found: false,
          classNameBefore: '',
          classNameAfter: ''
        })
        continue
      }

      // (1) Try data-edge-id attribute first — added below by Drawflow
      // monkey-patch if available.
      let targetSvg: SVGSVGElement | null = null
      let candidates: { svg: SVGSVGElement; reason: string }[] = []
      for (const svg of allSvgs) {
        const dataId = svg.getAttribute('data-edge-id')
        if (dataId === edgeId) {
          targetSvg = svg
          candidates.push({ svg, reason: 'data-edge-id-match' })
          break
        }
      }

      // (2) Exact Drawflow classes: connection node_in_node-<target> node_out_node-<source> output_X input_X.
      if (!targetSvg) {
        const sourceHandle = meta.sourceHandle || 'output_1'
        const targetHandle = meta.targetHandle || 'input_1'
        const sourceClass = CSS.escape(`node_out_node-${sourceId}`)
        const targetClass = CSS.escape(`node_in_node-${targetId}`)
        targetSvg = container.querySelector<SVGSVGElement>(
          `svg.connection.${targetClass}.${sourceClass}.${CSS.escape(sourceHandle)}.${CSS.escape(targetHandle)}`
        )
        if (targetSvg) candidates.push({ svg: targetSvg, reason: 'drawflow-class-exact-match' })
      }

      // (3) Fallback: locate by source/target Drawflow classes.
      if (!targetSvg) {
        const sourceClass = CSS.escape(`node_out_node-${sourceId}`)
        const targetClass = CSS.escape(`node_in_node-${targetId}`)
        targetSvg = container.querySelector<SVGSVGElement>(
          `svg.connection.${targetClass}.${sourceClass}`
        )
        if (targetSvg) candidates.push({ svg: targetSvg, reason: 'drawflow-class-node-match' })
      }

      // (4) Last fallback: locate by source/target via .output/.input containment.
      if (!targetSvg) {
        for (const svg of allSvgs) {
          const sourceNode = svg.closest(`[id="node-${CSS.escape(sourceId)}"]`)
          const targetNode = svg.closest(`[id="node-${CSS.escape(targetId)}"]`)
          if (!sourceNode || !targetNode) continue
          if (sourceNode === targetNode) continue
          // Verify the .output/.input endpoints belong to the right nodes
          const sourcePort = svg.querySelector('.output')
          const targetPort = svg.querySelector('.input')
          const sourceOk = sourcePort
            ? sourcePort.closest(`[id="node-${CSS.escape(sourceId)}"]`) !== null
            : sourceNode !== null
          const targetOk = targetPort
            ? targetPort.closest(`[id="node-${CSS.escape(targetId)}"]`) !== null
            : targetNode !== null
          if (!sourceOk || !targetOk) continue
          candidates.push({ svg, reason: 'port-containment' })
          if (!targetSvg) targetSvg = svg
        }
      }

      // Diagnostic: log candidate scan when nothing matched
      if (!targetSvg) {
        const debugCandidates = Array.from(allSvgs).slice(0, 8).map((svg) => ({
          dataEdgeId: svg.getAttribute('data-edge-id'),
          classes: svg.getAttribute('class'),
          childClasses: Array.from(svg.children).map((c) => c.getAttribute('class')).join('|')
        }))
        debugLog('glow', '[GlowDebug][DOM] apply edge state', {
          edgeId,
          source: sourceId,
          target: targetId,
          found: false,
          classNameBefore: '',
          classNameAfter: '',
          debugCandidates,
          triedSourceSelector: `[id="node-${CSS.escape(sourceId)}"]`,
          triedTargetSelector: `[id="node-${CSS.escape(targetId)}"]`,
          triedDataEdgeId: edgeId
        })
        continue
      }

      const classNameBefore = targetSvg.getAttribute('class') || ''
      targetSvg.classList.add('connection-active')
      targetSvg.setAttribute('data-edge-id', edgeId)
      const classNameAfter = targetSvg.getAttribute('class') || ''
      debugLog('glow', '[GlowDebug][DOM] apply edge state', {
        edgeId,
        source: sourceId,
        target: targetId,
        found: true,
        classNameBefore,
        classNameAfter,
        candidateCount: candidates.length,
        reason: candidates[0]?.reason
      })
    }
  }

  // React side-effect: sync DOM whenever state changes
  useEffect(() => { syncNodeRunStates() }, [nodeRunStates, nodeOutputs])
  useEffect(() => { syncActiveEdges() }, [activeEdges])

  const activeTask = tasks.find((task) => task.id === activeTaskId)
  const taskLogs = logs.filter((log) => log.pipelineId === activeTaskId).slice(0, 24)
  // [CanvasFix] Hotfix for canvas drag flicker (round 2 — undo/redo).
  //
  // After the round-1 fix removed `position` from the structural
  // signature so per-tick drag writes wouldn't re-import the whole
  // canvas, undo/redo (which mutates `workflow.nodes[].position`
  // via the workflow store) stopped updating the visual canvas
  // — the store said the node was at the restored position, but
  // Drawflow's DOM `node-xxx` element was still at the dragged
  // position.
  //
  // Round 2 introduces a SEPARATE `positionSignature` consumer
  // that mirrors position changes from the store into Drawflow
  // DOM via a lightweight, per-node sync effect. This effect:
  //   - does NOT call hydrateDrawflow / editor.import
  //   - does NOT call renderDrawflowNode / content.innerHTML
  //   - does NOT reapply port attributes or resize observers
  //     for unrelated nodes
  //   - DOES update Drawflow's internal `pos_x/pos_y` model +
  //     move the DOM `<div class="drawflow-node">` left/top +
  //     call `editor.updateConnectionNodes(id)` for each touched
  //     node.
  //
  // Skipped during an in-flight drag so per-tick store updates do
  // not fight Drawflow's own DOM moves (they would have anyway
  // because `nodeMoved` already wrote to Drawflow DOM).
  const positionSignature = useMemo(() => getWorkflowPositionSignature(workflow), [workflow])
  const lastAppliedPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())

  const structureSignature = useMemo(() => getWorkflowStructureSignature(workflow), [workflow])
  const dataSignature = useMemo(() => getWorkflowDataSignature(workflow), [workflow])
  const pickerItems = useMemo(() => {
    const query = nodePickerSearch.trim().toLowerCase()
    if (!query) return NODE_PICKER_ITEMS
    return NODE_PICKER_ITEMS.filter((node) =>
      [node.label, node.category, node.description, node.type].some((value) => String(value).toLowerCase().includes(query))
    )
  }, [nodePickerSearch])

  useEffect(() => {
    workflowRef.current = workflow
  }, [workflow])

  // [AssetStore] Migrate legacy base64 / data URL fields on the
  // active workflow to IndexedDB assetIds. Runs once per workflow
  // id (or once per node-mutation that touches a legacy field) —
  // the `migratedWorkflowIdsRef` short-circuits repeat fires. The
  // migration writes go through `replaceWorkflowNodes`, which is
  // a SILENT store action — no history push, no undo entry, the
  // user never asked for it. If migration fails for some nodes,
  // the legacy data stays in memory and the next session retries.
  const migratedWorkflowIdsRef = useRef<Set<string>>(new Set())
  const migrationInProgressRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!workflow || !workflow.id) return
    if (migratedWorkflowIdsRef.current.has(workflow.id)) return
    if (migrationInProgressRef.current.has(workflow.id)) return

    // Snapshot the nodes we plan to migrate. If the user keeps
    // editing the workflow mid-migration, `replaceWorkflowNodes`
    // may overwrite their work — gate on a generation counter.
    const capturedNodes = workflow.nodes
    const capturedUpdatedAt = workflow.updatedAt ?? 0
    migrationInProgressRef.current.add(workflow.id)

    void (async () => {
      try {
        const summary = await migrateLegacyWorkflowAssets({
          workflowId: workflow.id,
          nodes: capturedNodes
        })
        // Skip the store write if the workflow has been mutated
        // since we started. The next render of this effect (driven
        // by updatedAt) will pick up the new state and re-evaluate.
        const latest = useWorkflowStore.getState().workflows.find((w) => w.id === workflow.id)
        if (!latest || (latest.updatedAt ?? 0) !== capturedUpdatedAt) return
        if (summary.changed) {
          replaceWorkflowNodes(workflow.id, summary.nextNodes as WorkflowNode[])
        }
        migratedWorkflowIdsRef.current.add(workflow.id)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[AssetStore] legacy workflow migration failed', {
          workflowId: workflow.id,
          message: err instanceof Error ? err.message : String(err)
        })
      } finally {
        migrationInProgressRef.current.delete(workflow.id)
      }
    })()
  }, [workflow, replaceWorkflowNodes])

  useEffect(() => {
    const completedGenerateNodeIds = workflow.nodes
      .filter((node) => node.type === 'generate' && getGenerateOutputImageUrls((node.data as Record<string, unknown>)._output).length > 0)
      .map((node) => node.id)
      .filter((nodeId) => nodeRunStates[nodeId] === 'running')

    if (completedGenerateNodeIds.length === 0) return

    setNodeRunStates((prev) => {
      let changed = false
      const next = { ...prev }

      for (const nodeId of completedGenerateNodeIds) {
        if (next[nodeId] !== 'running') continue
        next[nodeId] = 'completed'
        changed = true
      }

      return changed ? next : prev
    })

    requestAnimationFrame(() => {
      completedGenerateNodeIds.forEach((nodeId) => applyNodeVisualRunState(nodeId, 'completed'))
    })
  }, [dataSignature, nodeRunStates])

  useEffect(() => {
    if (inspectorNodeId && !workflow.nodes.some((node) => node.id === inspectorNodeId)) {
      setInspectorNodeId(null)
    }
  }, [inspectorNodeId, workflow.nodes])

  // [AssetStore] Resolve IndexedDB asset references to object URLs.
  // Walks every node on every workflow change, fetches every assetId
  // (and posterAssetId) once, caches the result in the module-level
  // `assetObjectUrlSyncCache`, then triggers a per-node rerender so
  // the static `getMediaNodeSource` helper picks up the resolved URL
  // on the next render. Asset IDs that fail to resolve stay out of
  // the cache and the legacy data URL / template preview chain keeps
  // rendering — no crash, no missing-image flicker beyond the first
  // IndexedDB read.
  useEffect(() => {
    const nodeAssetPairs: Array<{ nodeId: string; assetId: string; kind: 'media' | 'poster' | 'output' | 'outputPoster' }> = []
    for (const node of workflow.nodes) {
      if (node.type === 'image') {
        const data = node.data as Record<string, unknown>
        const mediaAssetId = String(data.assetId || data.mediaAssetId || data.imageAssetId || '')
        const posterAssetId = String(data.posterAssetId || data.thumbnailAssetId || '')
        if (mediaAssetId) nodeAssetPairs.push({ nodeId: node.id, assetId: mediaAssetId, kind: 'media' })
        if (posterAssetId) nodeAssetPairs.push({ nodeId: node.id, assetId: posterAssetId, kind: 'poster' })
      } else if (node.type === 'generate') {
        const data = node.data as Record<string, unknown>
        const output = (data._output as Record<string, unknown> | undefined) || undefined
        const topPosterAssetId = String(output?.posterAssetId || output?.thumbnailAssetId || '')
        if (topPosterAssetId) nodeAssetPairs.push({ nodeId: node.id, assetId: topPosterAssetId, kind: 'outputPoster' })
        const outputs = Array.isArray(output?.outputs) ? output!.outputs as unknown[] : []
        for (const raw of outputs) {
          if (!raw || typeof raw !== 'object') continue
          const item = raw as Record<string, unknown>
          const itemAssetId = typeof item.assetId === 'string' ? item.assetId : ''
          const itemPosterAssetId = typeof item.posterAssetId === 'string' ? item.posterAssetId : ''
          if (itemAssetId) nodeAssetPairs.push({ nodeId: node.id, assetId: itemAssetId, kind: 'output' })
          if (itemPosterAssetId) nodeAssetPairs.push({ nodeId: node.id, assetId: itemPosterAssetId, kind: 'outputPoster' })
        }
      }
    }
    if (nodeAssetPairs.length === 0) return

    let cancelled = false
    const dirtyNodeIds = new Set<string>()
    void Promise.allSettled(
      nodeAssetPairs.map(async (entry) => {
        const url = await getAssetObjectUrl(entry.assetId)
        if (!url) return
        if (cancelled) return
        if (assetObjectUrlSyncCache.get(entry.assetId) === url) return
        assetObjectUrlSyncCache.set(entry.assetId, url)
        dirtyNodeIds.add(entry.nodeId)
      })
    ).then(() => {
      if (cancelled) return
      dirtyNodeIds.forEach((nodeId) => rerenderDrawflowNode(nodeId))
    })
    return () => { cancelled = true }
  }, [workflow.nodes, dataSignature])

  // [AssetStore] Revoke every cached object URL when the editor
  // unmounts. Without this, every reload leaks the prior session's
  // blob references until the page is closed.
  useEffect(() => {
    return () => {
      revokeAllAssetObjectUrls()
    }
  }, [])

  useEffect(() => {
    setSelectedPickerIndex(0)
  }, [isPaletteOpen, nodePickerSearch])

  const refreshZoom = () => {
    const editor = editorRef.current
    if (editor) setZoomLevel(Math.round(editor.zoom * 100))
  }

  const clientPointToCanvasPoint = (clientX: number, clientY: number) => {
    const editor = editorRef.current
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    const zoom = editor?.zoom || 1
    const panX = editor?.canvas_x || 0
    const panY = editor?.canvas_y || 0
    if (!rect) return null

    return {
      x: Math.round((clientX - rect.left - panX) / zoom),
      y: Math.round((clientY - rect.top - panY) / zoom)
    }
  }

  const getCanvasCenterPoint = () => {
    const editor = editorRef.current
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    const zoom = editor?.zoom || 1
    const panX = editor?.canvas_x || 0
    const panY = editor?.canvas_y || 0
    if (!rect) return { x: 220, y: 160 }

    return {
      x: Math.round((rect.width / 2 - panX) / zoom),
      y: Math.round((rect.height / 2 - panY) / zoom)
    }
  }

  const rememberCanvasPointer = (event: Event) => {
    if ('touches' in event) {
      const touch = event.touches[0] || event.changedTouches[0]
      if (!touch) return
      lastCanvasPointerRef.current = clientPointToCanvasPoint(touch.clientX, touch.clientY)
      return
    }

    const pointerEvent = event as MouseEvent | PointerEvent
    if (typeof pointerEvent.clientX !== 'number' || typeof pointerEvent.clientY !== 'number') return
    lastCanvasPointerRef.current = clientPointToCanvasPoint(pointerEvent.clientX, pointerEvent.clientY)
  }

  const openNodePicker = (position: { x: number; y: number } | null = null, spawnPosition: { x: number; y: number } | null = null) => {
    setNodePickerSearch('')
    setSelectedPickerIndex(0)
    setNodePickerPosition(position)
    nodePickerSpawnRef.current = spawnPosition
    setIsPaletteOpen(true)
  }

  const closeNodePicker = () => {
    setIsPaletteOpen(false)
    setNodePickerPosition(null)
    nodePickerSpawnRef.current = null
  }

  const closeNodePillMenu = () => {
    setNodePillMenu(null)
  }

  useEffect(() => {
    if (!isPaletteOpen) return

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return

      const target = event.target as Node | null
      if (!target || nodePickerRef.current?.contains(target)) return

      closeNodePicker()
    }

    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
    }
  }, [isPaletteOpen])

  useLayoutEffect(() => {
    const menu = nodePillMenuRef.current
    if (!nodePillMenu || !menu) return

    const updatePosition = () => {
      computePosition(nodePillMenu.trigger, menu, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [offset(6), shift({ padding: 8 })]
      }).then(({ x, y }) => {
        Object.assign(menu.style, {
          left: `${x}px`,
          top: `${y}px`
        })
      })
    }

    updatePosition()
    return autoUpdate(nodePillMenu.trigger, menu, updatePosition)
  }, [nodePillMenu, zoomLevel])

  useEffect(() => {
    if (!nodePillMenu) return

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const target = event.target as Node | null
      if (!target) return
      if (nodePillMenuRef.current?.contains(target) || nodePillMenu.trigger.contains(target)) return
      closeNodePillMenu()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeNodePillMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [nodePillMenu])

  useEffect(() => {
    if (!imagePreview) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImagePreview(null)
      else if (event.key === 'ArrowLeft') handleLightboxPrev()
      else if (event.key === 'ArrowRight') handleLightboxNext()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [imagePreview])

  const handleDownloadPreview = async () => {
    if (!imagePreview || !imagePreview.src) return

    const src = imagePreview.src

    // Resolve filename from the live carousel selection so the
    // download tracks the asset the user is currently looking at,
    // not the one that was visible when the lightbox first opened.
    // Resolution order: cached `downloadFilename` (set when the
    // carousel moves or when the modal opened) → fallback
    // synthesized from the index.
    let filename = ''
    if (imagePreview.outputItems && imagePreview.outputItems.length > 0) {
      const idx = imagePreview.selectedIndex ?? 0
      const item = imagePreview.outputItems[idx]
      // Re-derive from the item instead of trusting the cache, so
      // a stale `downloadFilename` (e.g. one written by an older
      // code path) can never win over the rich descriptor.
      filename = resolveGenerateOutputFilename(item, idx)
    }
    if (!filename && imagePreview.downloadFilename) {
      filename = imagePreview.downloadFilename
    }
    if (!filename) {
      const rawName = (imagePreview.outputName || imagePreview.name || '').trim()
      filename = rawName ? rawName.replace(/[^\w.\-]+/g, '-').replace(/^-+|-+$/g, '') : ''
    }
    if (!filename) {
      filename = `${imagePreview.mediaType}-${Date.now()}.${imagePreview.mediaType === 'video' ? 'mp4' : 'png'}`
    }
    if (!/\.[a-zA-Z0-9]{2,5}$/.test(filename)) {
      filename = `${filename}.${imagePreview.mediaType === 'video' ? 'mp4' : 'png'}`
    }

    // Use the same SW-routed helper as the node-bar download so the
    // path / error handling / chrome.downloads fallback chain stays
    // consistent. We do NOT call chrome.downloads.download directly
    // here — that was the original UI-side crash source.
    const result = await downloadWorkflowOutputAsset({
      url: src,
      filename,
      nodeId: selectedNode,
      selectedOutputIndex: imagePreview.selectedIndex ?? 0,
    })
    if (!result.ok) {
      console.warn('[WorkflowEditor] Preview download failed', {
        reason: result.reason,
        src,
        filename,
      })
    } else {
      console.log('[WorkflowEditor] Preview download started', {
        path: result.path,
        filename,
      })
    }
  }

  const handleLightboxPrev = () => {
    setImagePreview((prev) => {
      if (!prev || !prev.outputItems || prev.outputItems.length <= 1) return prev
      const len = prev.outputItems.length
      const idx = prev.selectedIndex ?? 0
      const nextIdx = (idx - 1 + len) % len
      const nextItem = prev.outputItems[nextIdx]
      return {
        ...prev,
        selectedIndex: nextIdx,
        src: nextItem.url,
        // Re-sync the header label + download filename so each
        // step of the carousel reflects the asset the user is
        // looking at right now — not the asset they opened.
        outputName: nextItem.name,
        downloadFilename: resolveGenerateOutputFilename(nextItem, nextIdx),
        metadata: { ...(prev.baseMetadata || {}), ...(nextItem.metadata || {}) },
        zoom: 100,
        // Track the asset's media type so the lightbox switches
        // between <img> and <video> as the user flips through
        // mixed outputs (e.g. quantity=2 with one image + one
        // video).
        mediaType: nextItem.mediaType === 'video' ? 'video' : 'image',
      }
    })
  }

  const handleLightboxNext = () => {
    setImagePreview((prev) => {
      if (!prev || !prev.outputItems || prev.outputItems.length <= 1) return prev
      const len = prev.outputItems.length
      const idx = prev.selectedIndex ?? 0
      const nextIdx = (idx + 1) % len
      const nextItem = prev.outputItems[nextIdx]
      return {
        ...prev,
        selectedIndex: nextIdx,
        src: nextItem.url,
        outputName: nextItem.name,
        downloadFilename: resolveGenerateOutputFilename(nextItem, nextIdx),
        metadata: { ...(prev.baseMetadata || {}), ...(nextItem.metadata || {}) },
        zoom: 100,
        // Track the asset's media type — see handleLightboxPrev.
        mediaType: nextItem.mediaType === 'video' ? 'video' : 'image',
      }
    })
  }

  const handleCanvasContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('.aiflow-node-picker, .aiflow-wf-toolbar, button, input, textarea, select')) return

    event.preventDefault()
    event.stopPropagation()

    const hostRect = event.currentTarget.getBoundingClientRect()
    const pickerWidth = 320
    const pickerHeight = 370
    const padding = 12
    const x = Math.min(Math.max(event.clientX - hostRect.left, padding), Math.max(padding, hostRect.width - pickerWidth - padding))
    const y = Math.min(Math.max(event.clientY - hostRect.top, padding), Math.max(padding, hostRect.height - pickerHeight - padding))
    const spawnPosition = clientPointToCanvasPoint(event.clientX, event.clientY)

    openNodePicker({ x, y }, spawnPosition)
  }

  const applyPortAttributesForNode = (node: WorkflowNode) => {
    const nodeEl = canvasRef.current?.querySelector<HTMLElement>(`#node-${CSS.escape(node.id)}`)
    if (!nodeEl) return

    const ports = drawflowPortGroupsForNode(node)
    const applyPort = (portEl: HTMLElement | null, port: DrawflowPortMeta, side: 'in' | 'out', index: number) => {
      if (!portEl) return

      const handle = `${side === 'in' ? 'input' : 'output'}_${index + 1}`
      const isEmpty = side === 'in'
        ? !workflowRef.current.edges.some((edge) => edge.target === node.id && (edge.targetHandle || 'input_1') === handle)
        : !workflowRef.current.edges.some((edge) => edge.source === node.id && (edge.sourceHandle || 'output_1') === handle)

      portEl.setAttribute('data-port-type', port.type)
      portEl.setAttribute('data-port-name', port.name)
      portEl.setAttribute('data-port-side', side)
      portEl.setAttribute('data-port-label', port.label)
      portEl.setAttribute('data-port-empty', String(isEmpty))
      portEl.setAttribute('title', `${port.label} (${port.type})`)
      if (port.required) portEl.setAttribute('data-port-required', 'true')
      else portEl.removeAttribute('data-port-required')

      let icon = portEl.querySelector<HTMLSpanElement>('.df-port-icon')
      if (!icon) {
        icon = document.createElement('span')
        icon.className = 'df-port-icon'
        icon.style.pointerEvents = 'none'
        portEl.appendChild(icon)
      }

      if (icon.dataset.iconType !== port.type) {
        icon.innerHTML = DF_PORT_ICONS[port.type] || DF_PORT_ICONS.any
        icon.dataset.iconType = port.type
      }
    }

    ports.in.forEach((port, index) => {
      applyPort(nodeEl.querySelector<HTMLElement>(`.input.input_${index + 1}`), port, 'in', index)
    })
    ports.out.forEach((port, index) => {
      applyPort(nodeEl.querySelector<HTMLElement>(`.output.output_${index + 1}`), port, 'out', index)
    })
  }

  const applyPortAttributes = () => {
    for (const node of workflowRef.current.nodes) {
      applyPortAttributesForNode(node)
    }
  }

  function toDrawflowElementId(nodeId: string | number) {
    const value = String(nodeId)
    return value.startsWith('node-') ? value : `node-${value}`
  }

  function toWorkflowNodeId(nodeId: string | number) {
    return String(nodeId).replace(/^node-/, '')
  }

  // [GroupDragInvestigate] Resolve a raw id (workflow, drawflow
  // element, or numeric) to all the variants and tell the caller
  // where the same id lives across the layers. Used by
  // groupDragInvestigateLog call sites that need to disambiguate
  // id formats.
  const debugResolveNodeId = (rawId: string | number): Record<string, unknown> => {
    const editor = editorRef.current
    const rawStr = String(rawId)
    const drawflowElId = toDrawflowElementId(rawStr)
    const workflowId = toWorkflowNodeId(rawStr)
    const canvas = canvasRef.current
    const domEl = canvas?.querySelector<HTMLElement>(`#${CSS.escape(drawflowElId)}`)
    const editorNode = editor?.getNodeFromId(workflowId)
    const workflowNode = workflowRef.current.nodes.find((node) => node.id === workflowId)
    return {
      rawId,
      rawStr,
      drawflowElId,
      workflowId,
      domExists: !!domEl,
      domClassList: domEl ? Array.from(domEl.classList) : null,
      editorNodeExists: !!editorNode,
      editorPos: editorNode ? { x: editorNode.pos_x, y: editorNode.pos_y } : null,
      workflowNodeExists: !!workflowNode,
      workflowPos: workflowNode ? workflowNode.position : null
    }
  }

  function mountedWorkflowNodeIds() {
    const ids = new Set(workflowRef.current.nodes.map((node) => node.id))
    canvasRef.current?.querySelectorAll<HTMLElement>('.drawflow-node[id^="node-"]').forEach((nodeEl) => {
      ids.add(toWorkflowNodeId(nodeEl.id))
    })
    return ids
  }

  function updateDrawflowConnectionNodeNow(nodeId: string | number) {
    const editor = editorRef.current
    if (!editor) return

    try {
      editor.updateConnectionNodes(toDrawflowElementId(nodeId))
    } catch {
      // Drawflow can briefly miss DOM nodes while React/Drawflow are rehydrating.
    }
  }

  function refreshDrawflowConnectionsNow(nodeIds?: Iterable<string | number> | null) {
    const editor = editorRef.current
    if (!editor) return

    const ids = nodeIds
      ? Array.from(nodeIds, (nodeId) => toWorkflowNodeId(nodeId)).filter(Boolean)
      : Array.from(mountedWorkflowNodeIds())

    for (const nodeId of new Set(ids)) {
      updateDrawflowConnectionNodeNow(nodeId)
    }
    scheduleConnectionSync()
  }

  function scheduleDrawflowConnectionRefresh(nodeId?: string | number | null, options?: { all?: boolean }) {
    if (options?.all || nodeId == null) {
      refreshAllConnectionsRef.current = true
    } else {
      pendingConnectionRefreshIdsRef.current.add(toWorkflowNodeId(nodeId))
    }

    if (connectionRefreshFrameRef.current !== null) return

    // [CanvasInvestigate] probe — fires when a connection refresh
    // is scheduled. The lambda inside rAF below is the "execute"
    // marker; this one is the "intent" marker. Pair with the
    // inner lambda log to count throttled-vs-executed ratio.
    canvasLog('connectionRefresh-schedule', {
      nodeId: nodeId != null ? String(nodeId) : null,
      all: !!options?.all,
      canvasDragInFlight: !!canvasDragInFlightRef.current.nodeId,
      dragNodeId: canvasDragInFlightRef.current.nodeId,
    })

    connectionRefreshFrameRef.current = window.requestAnimationFrame(() => {
      connectionRefreshFrameRef.current = window.requestAnimationFrame(() => {
        connectionRefreshFrameRef.current = null
        const forceAll = refreshAllConnectionsRef.current
        const pendingIds = new Set(pendingConnectionRefreshIdsRef.current)

        refreshAllConnectionsRef.current = false
        pendingConnectionRefreshIdsRef.current.clear()

        // [CanvasInvestigate] probe — actual execute of the
        // throttled connection refresh. Counts how often a drag
        // tick ultimately triggers applyPortAttributes +
        // attachNodeResizeObservers (full per-frame work).
        canvasLog('connectionRefresh-execute', {
          forceAll,
          pendingCount: pendingIds.size,
          canvasDragInFlight: !!canvasDragInFlightRef.current.nodeId,
        })

        applyPortAttributes()
        attachNodeResizeObservers()
        refreshDrawflowConnectionsNow(forceAll ? null : pendingIds)
      })
    })
  }

  function disconnectNodeResizeObservers() {
    for (const observer of nodeResizeObserversRef.current.values()) {
      observer.disconnect()
    }
    nodeResizeObserversRef.current.clear()
  }

  function attachNodeResizeObserver(nodeId: string | number) {
    if (typeof ResizeObserver === 'undefined') return

    const workflowNodeId = toWorkflowNodeId(nodeId)
    if (nodeResizeObserversRef.current.has(workflowNodeId)) return

    const nodeEl = canvasRef.current?.querySelector<HTMLElement>(`#node-${CSS.escape(workflowNodeId)}`)
    if (!nodeEl) return

    const observer = new ResizeObserver(() => {
      scheduleDrawflowConnectionRefresh(workflowNodeId)
    })
    observer.observe(nodeEl)
    nodeResizeObserversRef.current.set(workflowNodeId, observer)
  }

  function attachNodeResizeObservers() {
    const mountedIds = mountedWorkflowNodeIds()

    for (const [nodeId, observer] of nodeResizeObserversRef.current.entries()) {
      if (!mountedIds.has(nodeId)) {
        observer.disconnect()
        nodeResizeObserversRef.current.delete(nodeId)
      }
    }

    mountedIds.forEach((nodeId) => attachNodeResizeObserver(nodeId))
  }

  // [CanvasFix] Lightweight per-node connection repaint used during
  // a node drag. The full `scheduleDrawflowConnectionRefresh` is
  // correct for structural events (node added/deleted, port
  // structure changed, hydrate complete), but mid-drag it would
  // re-run applyPortAttributes + attachNodeResizeObservers + full
  // refresh per draw tick, causing the line flicker.
  //
  // This function only repaints the SVG paths attached to the
  // dragged node via `editor.updateConnectionNodes(draggedNodeId)`.
  // Throttled by requestAnimationFrame so 60 Hz draw ticks
  // collapse to at most one repaint per animation frame.
  //
  // Used by:
  //   - the `nodeMoved` event handler (per draw tick)
  //   - the `mouseUp` → `commitNodePositions` path defers a full
  //     refresh AFTER committing, not mid-drag.
  function lightweightDragConnectionRefresh(nodeId: string) {
    lightweightConnectionRefreshNodeIdRef.current = nodeId
    if (lightweightConnectionRefreshFrameRef.current !== null) return
    lightweightConnectionRefreshFrameRef.current = window.requestAnimationFrame(() => {
      lightweightConnectionRefreshFrameRef.current = null
      const editor = editorRef.current
      const target = lightweightConnectionRefreshNodeIdRef.current
      if (!editor || !target) return
      try {
        editor.updateConnectionNodes(toDrawflowElementId(target))
      } catch {
        // Drawflow can briefly miss DOM nodes mid-rehydrate.
      }
    })
  }

  // [CanvasFix] Hotfix for canvas drag flicker (round 2 — undo/redo).
  //
  // Move a single Drawflow node to (x, y) WITHOUT calling
  // editor.import / buildDrawflowData / renderDrawflowNode /
  // hydrateDrawflow. Steps:
  //   1. update Drawflow's internal model (pos_x/pos_y) so future
  //      `editor.getNodeFromId(...)` reads see the new position;
  //   2. mutate the DOM `<div class="drawflow-node" id="node-X">`
  //      left/top so the visual moves;
  //   3. redraw the connections touching that node so the lines
  //      follow the new endpoint.
  //
  // This is the only path used by the `positionSignature` sync
  // effect (round-2 hotfix). It must remain cheap enough to call
  // for several nodes in one frame (multi-node bulk moves).
  function applyDrawflowNodePosition(nodeId: string, position: { x: number; y: number }) {
    const editor = editorRef.current
    if (!editor) return
    const elementId = toDrawflowElementId(nodeId)

    // 1. Update Drawflow's internal model.
    try {
      const internal = editor.getNodeFromId(nodeId)
      if (internal) {
        internal.pos_x = position.x
        internal.pos_y = position.y
      }
    } catch {
      // Node may not be mounted yet — DOM mutation below will
      // still be applied when the structural hydrate runs.
    }

    // 2. Move the DOM element. Drawflow's CSS positions nodes via
    //    inline `left/top` on the .drawflow-node element.
    const nodeEl = canvasRef.current?.querySelector<HTMLElement>(`#${CSS.escape(elementId)}`)
    if (nodeEl) {
      nodeEl.style.left = `${position.x}px`
      nodeEl.style.top = `${position.y}px`
    }

    // 3. Redraw the connections touching this node.
    try {
      editor.updateConnectionNodes(elementId)
    } catch {
      // Drawflow can briefly miss DOM nodes mid-rehydrate.
    }
  }

  // [GroupDrag][mirror] Legacy single-node rAF follower apply
  // removed in favour of the mirror pattern in
  // `applyMultiDragMirror`. The functions
  // `scheduleGroupDragFollowerUpdate` and
  // `applyGroupDragFollowers` previously driven by `nodeMoved`
  // delta are now no-ops kept only because old `groupDragRef`
  // flag reads still exist in defence paths. The mirror path is
  // the one that actually drives cluster movement.
  const scheduleGroupDragFollowerUpdate = () => {
    // No-op — mirror is the active path.
  }

  const applyGroupDragFollowers = () => {
    // No-op — mirror is the active path.
  }

// [GroupDrag][mirror] Legacy finish path. The mirror pattern
  // drives the actual cluster movement + commit. This function is
  // kept as a state-reset helper so any leftover call sites
  // (legacy cancel paths, defence branches that read `gd.active`)
  // stay safe.
  const finishGroupDrag = (options: { commit: boolean; reason?: string } = { commit: true }) => {
    const gd = groupDragRef.current
    if (gd.frame !== null) {
      cancelAnimationFrame(gd.frame)
      gd.frame = null
    }
    gd.active = false
    gd.leaderNodeId = null
    gd.leaderStart = null
    gd.startPositions = new Map()
    gd.selectedIds = new Set()
    gd.lastDelta = { x: 0, y: 0 }
  }

  const cancelGroupDrag = (reason: string) => {
    finishGroupDrag({ commit: false, reason })
  }

  // [GroupDrag][mirror] Capture pre-drag state on plain mousedown
  // over a node that is already in the multi-selection. Stores the
  // node DOM element + parsed `style.left/top` for every selected
  // node, plus the mouse start coords and current zoom. The
  // mousemove handler attached right after this reads
  // `multiDragRef.current` and applies `(clientX - mouseStartX) /
  // zoom` to every follower.
  const startMultiDragMirror = (grabbedId: string, event: MouseEvent): boolean => {
    const editor = editorRef.current
    const canvas = canvasRef.current
    if (!editor || !canvas) return false
    const multi = multiSelectedNodeIdsRef.current
    if (multi.size < 2 || !multi.has(grabbedId)) return false

    const starts = new Map<string, { el: HTMLElement; left: number; top: number }>()
    for (const selectedId of multi) {
      const el = canvas.querySelector<HTMLElement>(`#${CSS.escape(toDrawflowElementId(selectedId))}`)
      if (!el) continue
      const domLeft = parseFloat(el.style.left)
      const domTop = parseFloat(el.style.top)
      const internal = editor.getNodeFromId(selectedId)
      const left = Number.isFinite(domLeft) ? domLeft : internal?.pos_x ?? 0
      const top = Number.isFinite(domTop) ? domTop : internal?.pos_y ?? 0
      starts.set(selectedId, { el, left, top })
    }

    if (!starts.has(grabbedId)) return false

    multiDragRef.current = {
      grabbedId,
      selectedIds: new Set(multi),
      starts,
      mouseStartX: event.clientX,
      mouseStartY: event.clientY,
      zoom: editor.zoom || 1,
      moved: false
    }

    // Cancel any in-flight rAF and reset the frame slot.
    if (multiDragFrameRef.current !== null) {
      cancelAnimationFrame(multiDragFrameRef.current)
      multiDragFrameRef.current = null
    }
    attachMultiDragMirrorListeners()
    groupDragMirrorLog('mirrorStart', {
      grabbedId,
      selectedCount: starts.size,
      followerCount: starts.size - 1,
      mouseStartX: event.clientX,
      mouseStartY: event.clientY,
      zoom: editor.zoom || 1
    })
    return true
  }

  // [GroupDrag][mirror] Document-level mousemove handler. Reads the
  // viewport delta, divides by `multiDragRef.zoom` to get canvas-px,
  // and updates each follower's `style.left/top` + Drawflow internal
  // `pos_x/pos_y`. The leader is skipped because Drawflow is moving
  // it natively via its own mousedown handler.
  const applyMultiDragMirror = (event: MouseEvent) => {
    const md = multiDragRef.current
    if (!md) return
    const dx = (event.clientX - md.mouseStartX) / md.zoom
    const dy = (event.clientY - md.mouseStartY) / md.zoom
    const editor = editorRef.current
    if (!editor) return

    for (const selectedId of md.selectedIds) {
      if (selectedId === md.grabbedId) continue
      const start = md.starts.get(selectedId)
      if (!start) continue
      const nextX = start.left + dx
      const nextY = start.top + dy
      try {
        const internal = editor.getNodeFromId(selectedId)
        if (internal) {
          internal.pos_x = nextX
          internal.pos_y = nextY
        }
      } catch {
        // rehydrate race — DOM update below still applies
      }
      start.el.style.left = `${nextX}px`
      start.el.style.top = `${nextY}px`
      try {
        editor.updateConnectionNodes(toDrawflowElementId(selectedId))
      } catch {
        // Drawflow can briefly miss DOM nodes mid-rehydrate.
      }
      pendingDragPositionsRef.current.set(selectedId, { x: nextX, y: nextY })
    }
    // [GroupDrag] Per-frame `mirrorMove` / `mirrorFollower` logs
    // are intentionally removed. These fired every animation
    // frame (and once per follower per frame) — even with the
    // `groupDragInvestigateEnabled` gate, enabling that flag in
    // a normal user session would spam the console. Lifecycle
    // events (mirrorStart / mirrorCommit / mirrorCancel /
    // mirrorCleanupOnUnmount) still log via
    // `groupDragMirrorLog`, which now uses `console.debug` so
    // production consoles stay clean.
    if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
      md.moved = true
    }
  }

  const scheduleMultiDragMirror = (event: MouseEvent) => {
    if (multiDragFrameRef.current !== null) return
    multiDragFrameRef.current = window.requestAnimationFrame(() => {
      multiDragFrameRef.current = null
      applyMultiDragMirror(event)
    })
  }

  // [GroupDrag][mirror] Mouseup handler. Drains pending → bulk
  // commit, then detaches listeners and clears state. Selection is
  // preserved (the user expects the multi-set to remain after a
  // group drag).
  const finishMultiDragMirror = (commit: boolean) => {
    const md = multiDragRef.current
    if (!md) return
    if (multiDragFrameRef.current !== null) {
      cancelAnimationFrame(multiDragFrameRef.current)
      multiDragFrameRef.current = null
    }
    const editor = editorRef.current
    const positions: Record<string, { x: number; y: number }> = {}
    if (commit && editor && md.moved) {
      // Pull leader's final pos from Drawflow — Drawflow already
      // moved it natively, so `pos_x/pos_y` is the post-drag truth.
      const leaderInternal = editor.getNodeFromId(md.grabbedId)
      if (leaderInternal) {
        positions[md.grabbedId] = { x: leaderInternal.pos_x, y: leaderInternal.pos_y }
      }
      for (const [id, pos] of pendingDragPositionsRef.current.entries()) {
        if (!positions[id]) positions[id] = pos
      }
      const activeWorkflowId = useWorkflowStore.getState().activeWorkflowId
      if (activeWorkflowId && Object.keys(positions).length > 0) {
        updateNodePositions(positions, activeWorkflowId)
      }
      // Sync lastApplied so positionSignature does not snap back.
      for (const [id, pos] of Object.entries(positions)) {
        lastAppliedPositionsRef.current.set(id, pos)
      }
      scheduleDrawflowConnectionRefresh(null, { all: true })
      groupDragMirrorLog('mirrorCommit', {
        count: Object.keys(positions).length,
        nodeIds: Object.keys(positions),
        leaderFinal: positions[md.grabbedId] ?? null,
        positions
      })
    } else {
      // No movement happened, or commit=false (cancel) — restore
      // followers and skip the store write entirely.
      if (commit) {
        groupDragMirrorLog('mirrorCommitSkipped', {
          reason: md.moved ? 'no_pending' : 'no_movement',
          moved: md.moved,
          pendingCount: pendingDragPositionsRef.current.size
        })
      }
      // Restore followers in either cancel or no-movement case so
      // any sub-pixel rAF-painted positions don't linger.
      for (const [id, start] of md.starts.entries()) {
        if (id === md.grabbedId) continue
        try {
          const internal = editor?.getNodeFromId(id)
          if (internal) {
            internal.pos_x = start.left
            internal.pos_y = start.top
          }
        } catch {
          // ignore
        }
        start.el.style.left = `${start.left}px`
        start.el.style.top = `${start.top}px`
      }
      pendingDragPositionsRef.current.clear()
      if (!commit) {
        groupDragMirrorLog('mirrorCancel', {
          reason: 'cancel',
          restoredFollowerCount: md.starts.size - 1
        })
      }
    }
    multiDragRef.current = null
    detachMultiDragMirrorListeners()
  }

  // [GroupDrag][mirror] Attach / detach document capture-phase
  // listeners. Idempotent. The references are kept on `window`
  // so the detach path can find them across closures.
  const attachMultiDragMirrorListeners = () => {
    if ((window as unknown as { __aiflow_multiDragMove__?: boolean }).__aiflow_multiDragMove__) {
      return
    }
    const onMove = (event: MouseEvent) => {
      if (!multiDragRef.current) return
      scheduleMultiDragMirror(event)
    }
    const onUp = () => {
      finishMultiDragMirror(true)
    }
    const onCancel = () => {
      finishMultiDragMirror(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        finishMultiDragMirror(false)
      }
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    document.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('blur', onCancel)
    window.addEventListener('keydown', onKeyDown, true)
    ;(window as unknown as {
      __aiflow_multiDragMove__?: boolean
      __aiflow_multiDragOnMove__?: (event: MouseEvent) => void
      __aiflow_multiDragOnUp__?: () => void
      __aiflow_multiDragOnCancel__?: () => void
      __aiflow_multiDragOnKeyDown__?: (event: KeyboardEvent) => void
    }).__aiflow_multiDragMove__ = true
    ;(window as unknown as {
      __aiflow_multiDragOnMove__?: (event: MouseEvent) => void
    }).__aiflow_multiDragOnMove__ = onMove
    ;(window as unknown as {
      __aiflow_multiDragOnUp__?: () => void
    }).__aiflow_multiDragOnUp__ = onUp
    ;(window as unknown as {
      __aiflow_multiDragOnCancel__?: () => void
    }).__aiflow_multiDragOnCancel__ = onCancel
    ;(window as unknown as {
      __aiflow_multiDragOnKeyDown__?: (event: KeyboardEvent) => void
    }).__aiflow_multiDragOnKeyDown__ = onKeyDown
  }

  const detachMultiDragMirrorListeners = () => {
    const w = window as unknown as {
      __aiflow_multiDragMove__?: boolean
      __aiflow_multiDragOnMove__?: (event: MouseEvent) => void
      __aiflow_multiDragOnUp__?: () => void
      __aiflow_multiDragOnCancel__?: () => void
      __aiflow_multiDragOnKeyDown__?: (event: KeyboardEvent) => void
    }
    if (!w.__aiflow_multiDragMove__) return
    if (w.__aiflow_multiDragOnMove__) {
      document.removeEventListener('mousemove', w.__aiflow_multiDragOnMove__, true)
    }
    if (w.__aiflow_multiDragOnUp__) {
      document.removeEventListener('mouseup', w.__aiflow_multiDragOnUp__, true)
    }
    if (w.__aiflow_multiDragOnCancel__) {
      document.removeEventListener('pointercancel', w.__aiflow_multiDragOnCancel__, true)
      window.removeEventListener('blur', w.__aiflow_multiDragOnCancel__)
    }
    if (w.__aiflow_multiDragOnKeyDown__) {
      window.removeEventListener('keydown', w.__aiflow_multiDragOnKeyDown__, true)
    }
    w.__aiflow_multiDragMove__ = false
    w.__aiflow_multiDragOnMove__ = undefined
    w.__aiflow_multiDragOnUp__ = undefined
    w.__aiflow_multiDragOnCancel__ = undefined
    w.__aiflow_multiDragOnKeyDown__ = undefined
  }

  // [GroupDrag] Debug log gated by AI_FLOW_DEBUG /
  // AI_FLOW_DEBUG_CANVAS_INVESTIGATE so production consoles stay
  // clean. The lifecycle events are: start (when the leader's first
  // tick activates group drag), commit (mouseUp drain), cancel
  // (Escape / blur / pointercancel / off-window mouseup).
  const groupDragDebugLog = (
    event: 'start' | 'commit' | 'cancel',
    payload: Record<string, unknown>
  ) => {
    if (typeof window === 'undefined') return
    const w = window as unknown as { __GROUP_DRAG_DEBUG__?: boolean }
    const enabled = Boolean(w.__GROUP_DRAG_DEBUG__)
    if (!enabled) return
    // eslint-disable-next-line no-console
    console.debug(`[GroupDrag][${event}]`, payload)
  }

  // [GroupDragInvestigate] Investigation-only log.
//
// Three flag sources are honored, in order:
//   1. window.__GROUP_DRAG_INVESTIGATE__ === true (page-console toggle)
//   2. localStorage.AI_FLOW_DEBUG_GROUP_DRAG === '1' (dedicated flag)
//   3. localStorage.AI_FLOW_DEBUG === '1' (master debug switch)
//
// The helper emits at `console.debug` level so production consoles
// stay clean — Chrome DevTools hides Verbose by default. Call sites
// for the per-frame probes (`mirrorMove`, `mirrorFollower`,
// `nodeMoved.raw`, `nodeMoved.context`, etc.) have been removed
// entirely; only lifecycle event sites remain in
// `groupDragMirrorLog`. Enable the `Verbose` filter in DevTools
// (or set `window.__GROUP_DRAG_INVESTIGATE__ = true`) to observe
// the remaining probes.
const groupDragInvestigateEnabled = (): boolean => {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { __GROUP_DRAG_INVESTIGATE__?: boolean }
  if (w.__GROUP_DRAG_INVESTIGATE__) return true
  try {
    if (window.localStorage.getItem('AI_FLOW_DEBUG_GROUP_DRAG') === '1') return true
    if (window.localStorage.getItem('AI_FLOW_DEBUG') === '1') return true
  } catch {
    return false
  }
  return false
}
const groupDragInvestigateLog = (
  event: string,
  payload: Record<string, unknown>
) => {
  if (!groupDragInvestigateEnabled()) return
  // [GroupDrag] Verbose level — Chrome DevTools hides this by
  // default. Production consoles stay clean unless the user
  // enables the `Verbose` filter. Per-frame probes (mirrorMove,
  // mirrorFollower) are intentionally NOT called from
  // `applyMultiDragMirror` anymore — see `applyMultiDragMirror`
  // for the per-frame decision.
  // eslint-disable-next-line no-console
  console.debug(`[GroupDragInvestigate][${event}]`, payload)
}

// [GroupDrag] Mirror-mode logger — same flag as the investigation
// logger, but uses the `[GroupDrag]` prefix. Lifecycle events
// (mirrorStart / mirrorCommit / mirrorCommitSkipped /
// mirrorCancel / mirrorCleanupOnUnmount) call this at most once
// per gesture, so the Verbose level is appropriate.
const groupDragMirrorLog = (
  event: string,
  payload: Record<string, unknown>
) => {
  if (!groupDragInvestigateEnabled()) return
  // eslint-disable-next-line no-console
  console.debug(`[GroupDrag][${event}]`, payload)
}

  const rerenderDrawflowNode = (nodeIdOrNode: string | WorkflowNode) => {
    const editor = editorRef.current
    const node = typeof nodeIdOrNode === 'string'
      ? workflowRef.current.nodes.find((item) => item.id === nodeIdOrNode)
      : nodeIdOrNode
    const nodeId = typeof nodeIdOrNode === 'string' ? nodeIdOrNode : nodeIdOrNode.id
    if (!editor || !node) return

    // [GroupDrag] Per-node rerender wipes the node's
    // `.drawflow_content_node` innerHTML. A rerender for a
    // follower during group drag can re-apply the original
    // `style.left/top` from the freshly-rendered Drawflow data
    // and snap it back to its pre-drag spot. The investigation
    // log was removed — see
    // `groupDragInvestigateLog` definition for the gating
    // contract.

    // [CanvasInvestigate] probe — fires every time a SINGLE node's
    // HTML is replaced. Pair with [hydrateDrawflow] to distinguish
    // "per-node rerender" (cheap) from "full canvas re-import"
    // (expensive). If rerenderDrawflowNode is called for a node
    // that is NOT the dragged node, and the call site is NOT a
    // genuine output-preview change, that is the per-node
    // flicker source.
    canvasLog('rerenderDrawflowNode', {
      nodeId,
      reason: 'rerenderDrawflowNode-invoke',
      canvasDragInFlight: !!canvasDragInFlightRef.current.nodeId,
      dragNodeId: canvasDragInFlightRef.current.nodeId,
      hasOutput: !!node.data?._output,
    })

    const content = canvasRef.current?.querySelector(`#node-${CSS.escape(node.id)} .drawflow_content_node`)
    if (content) content.innerHTML = renderDrawflowNode(node)
    applyPortAttributesForNode(node)
    syncNodeRunStates()
    attachNodeResizeObserver(node.id)
    scheduleDrawflowConnectionRefresh(node.id)
  }

  const getPortDragInfo = (target: EventTarget | null): DrawflowPortDragInfo | null => {
    const element = target instanceof Element
      ? target.closest<HTMLElement>('.input[data-port-type], .output[data-port-type]')
      : null
    const nodeEl = element?.closest<HTMLElement>('.drawflow-node')
    if (!element || !nodeEl) return null

    const side = element.classList.contains('output') ? 'out' : 'in'
    const handle = Array.from(element.classList).find((className) =>
      side === 'out' ? className.startsWith('output_') : className.startsWith('input_')
    )
    const type = element.dataset.portType as DrawflowPortType | undefined
    if (!handle || !type) return null

    return {
      nodeId: nodeEl.id.replace(/^node-/, ''),
      handle,
      side,
      type,
      element
    }
  }

  const getPortInfoByHandle = (nodeId: string, side: 'in' | 'out', handle: string): DrawflowPortDragInfo | null => {
    const selector = `#node-${CSS.escape(nodeId)} .${side === 'out' ? 'output' : 'input'}.${CSS.escape(handle)}`
    return getPortDragInfo(canvasRef.current?.querySelector(selector) || null)
  }

  const normalizePortConnection = (first: DrawflowPortDragInfo | null, second: DrawflowPortDragInfo | null) => {
    if (!first || !second) return null
    if (first.nodeId === second.nodeId) return null
    if (first.side === second.side) return null
    if (first.type !== second.type) return null

    return first.side === 'out'
      ? { source: first, target: second }
      : { source: second, target: first }
  }

  const hasWorkflowEdge = (sourceId: string, targetId: string, sourceHandle: string, targetHandle: string) => {
    return workflowRef.current.edges.some((edge) =>
      edge.source === sourceId &&
      edge.target === targetId &&
      (edge.sourceHandle || 'output_1') === sourceHandle &&
      (edge.targetHandle || 'input_1') === targetHandle
    )
  }

  const addPortConnection = (first: DrawflowPortDragInfo | null, second: DrawflowPortDragInfo | null) => {
    const normalized = normalizePortConnection(first, second)
    const editor = editorRef.current
    if (!normalized || !editor) return false

    const { source, target } = normalized
    if (hasWorkflowEdge(source.nodeId, target.nodeId, source.handle, target.handle)) return false

    editor.addConnection(source.nodeId, target.nodeId, source.handle, target.handle)
    requestAnimationFrame(applyPortAttributes)
    scheduleConnectionSync()
    return true
  }

  const isConnectionCompatible = (connection: DrawflowConnection) => {
    const source = getPortInfoByHandle(String(connection.output_id), 'out', connection.output_class || 'output_1')
    const target = getPortInfoByHandle(String(connection.input_id), 'in', connection.input_class || 'input_1')
    return Boolean(normalizePortConnection(source, target))
  }

  const getNodePortTypeByHandle = (node: WorkflowNode | undefined, side: 'in' | 'out', handle: string): DrawflowPortType | null => {
    if (!node) return null
    const index = Number.parseInt(handle.split('_')[1] || '', 10) - 1
    if (!Number.isFinite(index) || index < 0) return null
    const ports = drawflowPortGroupsForNode(node)[side]
    return ports[index]?.type || null
  }

  const isWorkflowEdgeCompatible = (edge: WorkflowEdge, nodesById: Map<string, WorkflowNode>) => {
    const sourceType = getNodePortTypeByHandle(nodesById.get(edge.source), 'out', edge.sourceHandle || 'output_1')
    const targetType = getNodePortTypeByHandle(nodesById.get(edge.target), 'in', edge.targetHandle || 'input_1')
    return Boolean(sourceType && targetType && sourceType === targetType)
  }

  const unlinkIncompatibleConnectionsForNode = (nodeId: string, nextNode: WorkflowNode) => {
    const currentWorkflow = workflowRef.current
    const nodesById = new Map(currentWorkflow.nodes.map((item) => [item.id, item]))
    nodesById.set(nodeId, nextNode)

    const staleEdges = currentWorkflow.edges.filter((edge) =>
      (edge.source === nodeId || edge.target === nodeId) &&
      !isWorkflowEdgeCompatible(edge, nodesById)
    )
    if (staleEdges.length === 0) return []

    const editor = editorRef.current
    if (editor) {
      suppressEdgeEventRef.current = true
      for (const edge of staleEdges) {
        editor.removeSingleConnection(
          edge.source,
          edge.target,
          edge.sourceHandle || 'output_1',
          edge.targetHandle || 'input_1'
        )
      }
      suppressEdgeEventRef.current = false
    }

    requestAnimationFrame(applyPortAttributes)
    scheduleConnectionSync()
    return staleEdges.map((edge) => edge.id)
  }

  const handleSaveMediaUrl = async (nodeId: string, rawUrl: string) => {
    const url = validateMediaUrl(rawUrl)
    const currentNode = workflowRef.current.nodes.find((item) => item.id === nodeId)
    if (!currentNode || currentNode.type !== 'image') {
      throw new Error('The selected node is no longer a Media Node.')
    }

    const currentData = currentNode.data as Record<string, unknown>
    const result = await probeMediaUrl(url, getMediaNodeType(currentData))
    const hasDimensions = Boolean(result.width && result.height)
    const fileName = mediaFileNameFromUrl(url, result.mediaType)
    const aspectRatio = hasDimensions
      ? closestImageAspectRatio(result.width as number, result.height as number)
      : result.mediaType === 'video'
        ? '16:9'
        : String(currentData.aspectRatio || '1:1')

    const patch = {
      mediaType: result.mediaType,
      mediaUrl: url,
      mediaData: '',
      mediaName: fileName,
      mediaMimeType: result.mediaType === 'video' ? 'video/*' : 'image/*',
      mediaWidth: result.width,
      mediaHeight: result.height,
      mediaDuration: result.mediaType === 'video' ? result.duration : undefined,
      mediaSize: 0,
      size: 0,
      mediaPoster: '',
      imageUrl: result.mediaType === 'image' ? url : '',
      imageData: '',
      imageName: result.mediaType === 'image' ? fileName : '',
      imageWidth: result.mediaType === 'image' ? result.width : undefined,
      imageHeight: result.mediaType === 'image' ? result.height : undefined,
      videoUrl: result.mediaType === 'video' ? url : '',
      videoData: '',
      videoName: result.mediaType === 'video' ? fileName : '',
      videoWidth: result.mediaType === 'video' ? result.width : undefined,
      videoHeight: result.mediaType === 'video' ? result.height : undefined,
      videoPoster: '',
      duration: result.mediaType === 'video' ? result.duration : undefined,
      aspectRatio,
      assetId: undefined,
      mediaAssetId: undefined,
      imageAssetId: undefined,
      videoAssetId: undefined,
      posterAssetId: undefined,
      thumbnailAssetId: undefined
    } as Partial<FlowNodeData>

    const nextNode: WorkflowNode = {
      ...currentNode,
      data: { ...currentNode.data, ...patch } as FlowNodeData
    }
    const staleEdgeIds = unlinkIncompatibleConnectionsForNode(nodeId, nextNode)
    updateNodeAndRemoveEdges(nodeId, patch, staleEdgeIds)
    scheduleDrawflowConnectionRefresh(nodeId)

    return { mediaType: result.mediaType, unlinkedCount: staleEdgeIds.length }
  }

  const syncConnectionOverlaysForSelectedIds = (selectedIds: Set<string>) => {
    const canvas = canvasRef.current
    if (!canvas) return

    canvas.querySelectorAll<SVGSVGElement>('.drawflow svg.connection').forEach((connection) => {
      const mainPath = connection.querySelector<SVGPathElement>('path.main-path:not(.main-path-overlay)')
      if (!mainPath) return
      const classNames = Array.from(connection.classList)
      const isPendingConnection = !classNames.some((className) => className.startsWith('node_in_node-'))

      if (isPendingConnection) {
        connection.querySelector<SVGPathElement>('path.main-path-overlay')?.remove()
        connection.classList.remove('conn-type-frame', 'conn-type-text', 'conn-type-image', 'conn-type-video', 'conn-type-any', 'conn-node-selected')
        return
      }

      let overlay = connection.querySelector<SVGPathElement>('path.main-path-overlay')
      if (!overlay) {
        overlay = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        overlay.classList.add('main-path-overlay')
        connection.appendChild(overlay)
      }

      overlay.setAttribute('d', mainPath.getAttribute('d') || '')
      overlay.setAttribute('fill', 'none')
      if (!overlayObserversRef.current.has(mainPath)) {
        const observer = new MutationObserver(() => {
          overlay?.setAttribute('d', mainPath.getAttribute('d') || '')
        })
        observer.observe(mainPath, { attributes: true, attributeFilter: ['d'] })
        overlayObserversRef.current.set(mainPath, observer)
      }

      connection.classList.remove('conn-type-frame', 'conn-type-text', 'conn-type-image', 'conn-type-video', 'conn-type-any')
      const sourceClass = classNames.find((className) => className.startsWith('node_out_node-'))
      const targetClass = classNames.find((className) => className.startsWith('node_in_node-'))
      const inputClass = classNames.find((className) => className.startsWith('input_'))
      const sourceId = sourceClass?.replace('node_out_node-', '')
      const targetId = targetClass?.replace('node_in_node-', '')
      const targetPortType = targetId && inputClass
        ? canvas.querySelector<HTMLElement>(`#node-${CSS.escape(targetId)} .input.${CSS.escape(inputClass)}`)?.getAttribute('data-port-type')
        : null
      const sourceNode = workflowRef.current.nodes.find((node) => node.id === sourceId)
      const connectionType = targetPortType === 'frame' || targetPortType === 'video'
        ? targetPortType
        : targetPortType === 'text' || targetPortType === 'image'
          ? targetPortType
          : nodeConnectionType(sourceNode)
      connection.classList.add(`conn-type-${connectionType}`)
      connection.classList.toggle(
        'conn-node-selected',
        Boolean((sourceId && selectedIds.has(sourceId)) || (targetId && selectedIds.has(targetId)))
      )
    })
  }

  const syncConnectionOverlays = () => {
    const selectedId = useWorkflowStore.getState().selectedNodeId
    const selectedIds = new Set(multiSelectedNodeIdsRef.current)
    if (selectedId) selectedIds.add(selectedId)
    // [WorkflowMarquee] When the user is mid-drag, the live preview
    // set overrides the committed store selection. Preview glow is
    // drawn from the marquee rectangle and must shrink/expand
    // realtime — the committed set would lag by one mouseup.
    if (marqueeActiveRef.current) {
      const previewIds = new Set(marqueePreviewNodeIdsRef.current)
      if (previewIds.size > 0) {
        return syncConnectionOverlaysForSelectedIds(previewIds)
      }
      return syncConnectionOverlaysForSelectedIds(new Set())
    }
    return syncConnectionOverlaysForSelectedIds(selectedIds)
  }

  const scheduleConnectionSync = () => {
    if (connectionSyncFrameRef.current !== null) return
    connectionSyncFrameRef.current = requestAnimationFrame(() => {
      connectionSyncFrameRef.current = null
      syncConnectionOverlays()
    })
  }

  const syncSelectedNodeDomForIds = (selectedIds: Set<string>, options: { mutateEditor?: boolean; preferredSelectedId?: string | null } = {}) => {
    const { mutateEditor = true, preferredSelectedId = null } = options
    const canvas = canvasRef.current
    const editor = editorRef.current
    if (!canvas) return null

    let selectedEl: HTMLElement | null = null
    canvas.querySelectorAll<HTMLElement>('.drawflow-node.selected').forEach((el) => {
      const nodeId = el.id.replace(/^node-/, '')
      if (!selectedIds.has(nodeId)) el.classList.remove('selected')
    })

    for (const nodeId of selectedIds) {
      const nodeEl = canvas.querySelector<HTMLElement>(`#node-${CSS.escape(nodeId)}`)
      nodeEl?.classList.add('selected')
      if (nodeId === preferredSelectedId) selectedEl = nodeEl
    }

    // Only the store-driven path mutates `editor.node_selected`.
    // Marquee-preview takes the same visual glow but leaves Drawflow's
    // internal selection alone — otherwise a mid-drag `node_selected`
    // assignment would fight the user's Ctrl+drag intent and confuse
    // the library's own click handlers.
    if (mutateEditor && editor) {
      editor.node_selected = selectedEl
    }
    return selectedEl
  }

  const syncSelectedNodeDom = (selectedId = useWorkflowStore.getState().selectedNodeId) => {
    const selectedIds = new Set(multiSelectedNodeIdsRef.current)
    if (selectedId) selectedIds.add(selectedId)
    wfSelectionLog('syncSelectedNodeDom', { selectedId, selectedIds: Array.from(selectedIds) })
    syncSelectedNodeDomForIds(selectedIds, {
      mutateEditor: true,
      preferredSelectedId: selectedId
    })
    scheduleConnectionSync()
  }

  // [WorkflowSelection] Single source of truth for clearing the
  // canvas selection. ALL clear paths (canvas pointerdown, document
  // pointerdown, drawflow nodeUnselected, root onPointerDownCapture)
  // funnel through this helper. It:
  //   1. Logs a `clear.before` snapshot of every selector that might
  //      be holding the highlight on screen, so we can verify which
  //      CSS class is the real one.
  //   2. Removes all known highlight classes from the DOM.
  //   3. Nulls out Drawflow's internal selected state so the library
  //      cannot re-add the highlight from inside its own mousedown
  //      handler.
  //   4. Sets `clearInFlightUntilRef` to suppress any stale
  //      `nodeSelected` re-firing for a short window.
  //   5. Calls `setSelectedNode(null)` so the store-driven
  //      `syncSelectedNodeDom(null)` effect also runs.
  //   6. Logs a `clear.afterRAF` snapshot to confirm the DOM
  //      actually cleared.
  const clearCanvasSelection = (reason: string = 'unspecified') => {
    const canvas = canvasRef.current
    const editor = editorRef.current

    // [GroupDrag] Investigation log was removed — see
    // `groupDragInvestigateLog` definition for the gating
    // contract.

    if (canvas) {
      // Snapshot BEFORE removing anything. Multiple selectors are
      // checked because the original "click canvas doesn't clear"
      // bug may have been caused by an unmeasured CSS class
      // (e.g. `.df-node-selected`, `path.selected`, etc.).
      const selectedNodes = Array.from(
        canvas.querySelectorAll<HTMLElement>('.drawflow-node.selected')
      ).map((el) => ({ id: el.id, classes: el.className }))
      const highlightedConnNodeSelected = Array.from(
        canvas.querySelectorAll<SVGSVGElement>('svg.connection.conn-node-selected')
      ).map((el) => el.getAttribute('class'))
      const activeConnections = Array.from(
        canvas.querySelectorAll<SVGSVGElement>('svg.connection.connection-active')
      ).map((el) => el.getAttribute('class'))
      const pathSelected = Array.from(
        canvas.querySelectorAll<SVGPathElement>('svg.connection path.main-path.selected')
      ).map((el) => el.getAttribute('class'))
      const dfNodeSelected = Array.from(
        canvas.querySelectorAll<HTMLElement>('.drawflow-node.df-node-selected')
      ).map((el) => el.className)

      wfSelectionLog('clear.before', {
        reason,
        selectedNodeIdStore: useWorkflowStore.getState().selectedNodeId,
        selectedNodes,
        highlightedConnNodeSelected,
        activeConnections,
        pathSelected,
        dfNodeSelected
      })
    }

    // Selection intent ref must agree before Drawflow's `mouseUp` runs
    // — otherwise the nodeUnselected handler will leave the .selected
    // class stuck on the previously-clicked node.
    selectionMouseDownRef.current = { nodeId: null, clearOnUnselect: true }

    // Clear multi-selection ref + state so background / outside clicks
    // also wipe the marquee selection. Without this, ctrl+drag → click
    // empty space would leave stale .selected classes on previously
    // marquee-selected nodes.
    if (multiSelectedNodeIdsRef.current.size > 0 || multiSelectedNodeIds.length > 0) {
      setMultiSelectedNodeIds(null)
    }

    if (canvas) {
      // Defensive DOM flush BEFORE the React render commits. We strip
      // every selector that the [clear.before] snapshot checked so the
      // `afterRAF` snapshot can confirm the count drops to 0.
      canvas.querySelectorAll<HTMLElement>('.drawflow-node.selected').forEach((el) => {
        el.classList.remove('selected')
      })
      canvas.querySelectorAll<HTMLElement>('.drawflow-node.df-node-selected').forEach((el) => {
        el.classList.remove('df-node-selected')
      })
      canvas.querySelectorAll<SVGSVGElement>('.drawflow svg.connection').forEach((connection) => {
        connection.classList.remove('conn-node-selected', 'connection-active', 'selected')
        connection.querySelectorAll<SVGPathElement>('path.main-path').forEach((path) => {
          path.classList.remove('selected')
        })
      })
    }

    // Clear Drawflow's INTERNAL selected state. Without this, Drawflow
    // can re-add `.selected` on its next internal dispatch even after
    // we removed the class — because `node_selected` still points at
    // the same DOM element. We use `try` because the Drawflow
    // typings don't formally declare these fields, and a stray missing
    // property should never crash the clear path.
    if (editor) {
      try {
        // Cast through `unknown` so we can clear internal fields
        // without the TS compiler complaining about undeclared
        // properties on the typed DrawflowInstance.
        const e = editor as unknown as Record<string, unknown>
        e.node_selected = null
        e.ele_selected = null
        e.connection_selected = null
        e.connection_ele_selected = null
        e.editor_selected = false
      } catch {
        // No-op: never let a missing field crash clear.
      }
    }

    // Suppress any stale `nodeSelected` re-fire for the next 120ms.
    // This is the safety net for the [clear.diag] case where
    // drawflow's click handler re-dispatches `nodeSelected` after
    // our `nodeUnselected` listener already cleared the selection.
    clearInFlightUntilRef.current = performance.now() + 120

    const previousSelectedId = useWorkflowStore.getState().selectedNodeId
    if (previousSelectedId) {
      // Route through the logging wrapper so a `[setSelectedNode]`
      // entry appears in the trace even when the clear path is
      // triggered by something other than the nodeUnselected
      // event (e.g. document mousedown, root capture).
      setSelectedNodeWithLog(null, `clear:${reason}`)
    }

    // Schedule the canonical sync in case any external source added
    // a stray .selected / .conn-node-selected we did not know about.
    // Explicit `null` argument ensures we don't pick up a stale
    // store value if the setSelectedNode write has not flushed yet.
    requestAnimationFrame(() => {
      syncSelectedNodeDom(null)
      if (canvas) {
        const afterNodes = canvas.querySelectorAll('.drawflow-node.selected').length
        const afterConn = canvas.querySelectorAll('svg.connection.conn-node-selected').length
        const afterPath = canvas.querySelectorAll('svg.connection path.main-path.selected').length
        const afterDfNode = canvas.querySelectorAll('.drawflow-node.df-node-selected').length
        const afterActive = canvas.querySelectorAll('svg.connection.connection-active').length
        wfSelectionLog('clear.afterRAF', {
          reason,
          selectedNodeIdStore: useWorkflowStore.getState().selectedNodeId,
          afterNodes,
          afterConn,
          afterPath,
          afterDfNode,
          afterActive
        })
      }
    })
  }

  const runGenerateNodeWithInputs = async (nodeId: string) => {
    const currentWorkflow = workflowRef.current
    const targetNode = currentWorkflow.nodes.find((node) => node.id === nodeId)
    if (!targetNode) return
    if (targetNode.type !== 'generate') return
    if (usePipelineStore.getState().isRunning) return

    const workflowSlice = buildWorkflowSliceForTarget(currentWorkflow, nodeId)
    if (!workflowSlice) return
    const runWarning = getWorkflowRunWarning(workflowSlice, nodeId)
    if (runWarning) {
      flashTemplateToast('warning', runWarning)
      return
    }

    closeNodePillMenu()
    clearAllRunDomClasses()
    setNodeRunStates({})
    setActiveEdges({})
    setNodeOutputs({})

    probeRunRequest('single-node-canvas', workflowSlice.id, {
      targetNodeId: nodeId,
      targetNodeType: targetNode.type
    })
    await runPipeline(workflowSlice, pipelineCallbacksRef.current)
  }

  const duplicateNodeWithInputs = (nodeId: string) => {
    const currentWorkflow = workflowRef.current
    const workflowSlice = buildWorkflowSliceForTarget(currentWorkflow, nodeId)
    if (!workflowSlice || workflowSlice.nodes.length === 0) return false

    const idMap = new Map<string, string>()
    for (const node of workflowSlice.nodes) {
      idMap.set(node.id, createId('node'))
    }

    const offset = { x: 72, y: 72 }
    const duplicatedNodes: WorkflowNode[] = workflowSlice.nodes.map((node) => ({
      ...cloneDeep(node),
      id: idMap.get(node.id) || createId('node'),
      position: {
        x: Math.max(0, Math.round(node.position.x + offset.x)),
        y: Math.max(0, Math.round(node.position.y + offset.y))
      },
      data: cloneDeep(node.data)
    }))

    const duplicatedEdges: WorkflowEdge[] = workflowSlice.edges
      .map((edge) => {
        const source = idMap.get(edge.source)
        const target = idMap.get(edge.target)
        if (!source || !target) return null
        return {
          ...cloneDeep(edge),
          id: createId('edge'),
          source,
          target
        } satisfies WorkflowEdge
      })
      .filter((edge): edge is WorkflowEdge => Boolean(edge))

    const duplicatedTargetId = idMap.get(nodeId) || duplicatedNodes[duplicatedNodes.length - 1]?.id
    updateWorkflow(currentWorkflow.id, {
      nodes: [...currentWorkflow.nodes, ...duplicatedNodes],
      edges: [...currentWorkflow.edges, ...duplicatedEdges]
    })

    if (duplicatedTargetId) {
      setSelectedNode(duplicatedTargetId)
    }

    requestAnimationFrame(() => {
      duplicatedNodes.forEach((node) => attachNodeResizeObserver(node.id))
      scheduleDrawflowConnectionRefresh(null, { all: true })
      if (duplicatedTargetId) syncSelectedNodeDom(duplicatedTargetId)
    })

    return true
  }

  // [WorkflowMarquee] Delete every node in the current selection set.
  // When the selection is empty, fall back to deleting just the
  // store-selected node so single-selection + Delete still works.
  // The store's `deleteNode` already removes edges attached to the
  // node, so calling it in a loop is enough — internal edges vanish
  // when both endpoints are deleted, and any external edges to nodes
  // outside the selection are dropped too.
  const deleteSelectedNodes = () => {
    const ids = new Set(multiSelectedNodeIdsRef.current)
    const storeSelected = useWorkflowStore.getState().selectedNodeId
    if (storeSelected) ids.add(storeSelected)

    if (ids.size === 0) return false

    const currentWorkflow = workflowRef.current
    if (!currentWorkflow) return false

    // Snapshot which nodes actually exist so we don't no-op a stale
    // id from a previous selection.
    const toDelete = currentWorkflow.nodes.filter((node) => ids.has(node.id))
    if (toDelete.length === 0) return false

    // Clear run-state refs first so the visual state doesn't show
    // ghosts of nodes we're about to remove.
    setNodeRunStates((prev) => {
      const next: Record<string, NodeRunStatus> = { ...prev }
      for (const node of toDelete) delete next[node.id]
      return next
    })
    setActiveEdges({})
    setNodeOutputs((prev) => {
      const next: Record<string, unknown> = { ...prev }
      for (const node of toDelete) delete next[node.id]
      return next
    })

    // Clear selection state BEFORE deleting so Drawflow's
    // nodeUnselected path doesn't re-add .selected for a node
    // that's about to vanish.
    setMultiSelectedNodeIds(null)
    if (storeSelected) setSelectedNodeWithLog(null, 'delete:clear-multi')

    // Close the inspector if it was open on one of the doomed nodes.
    const inspectorId = inspectorNodeId
    if (inspectorId && ids.has(inspectorId)) {
      setInspectorNodeId(null)
    }

    // [WorkflowDelete] Single batched delete through the store. This
    // pushes exactly ONE history entry for the whole multi-node
    // gesture so Ctrl+Z restores every removed node + edge in one
    // undo. The previous loop-over-deleteNode() implementation pushed
    // one history entry per node and required N undos for N nodes.
    deleteNodes(currentWorkflow.id, Array.from(ids))

    requestAnimationFrame(() => {
      // Force a connection pass because the store deletes edges
      // synchronously but Drawflow's path DOM might still reference
      // removed endpoints. The full-fingerprint refresh rebuilds
      // every port → path mapping.
      scheduleDrawflowConnectionRefresh(null, { all: true })
      syncSelectedNodeDom(null)
    })

    return true
  }

  const applyCanvasZoom = (nextZoom: number, anchor?: { x: number; y: number }) => {
    const editor = editorRef.current
    const canvas = canvasRef.current
    if (!editor || !canvas || !editor.precanvas) return

    const previousZoom = editor.zoom || 1
    const zoom = Math.min(editor.zoom_max, Math.max(editor.zoom_min, nextZoom))
    if (Math.abs(zoom - previousZoom) < 0.001) return

    const point = anchor || { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }
    const worldX = (point.x - editor.canvas_x) / previousZoom
    const worldY = (point.y - editor.canvas_y) / previousZoom

    editor.zoom = zoom
    editor.canvas_x = Math.round(point.x - worldX * zoom)
    editor.canvas_y = Math.round(point.y - worldY * zoom)
    editor.zoom_last_value = zoom
    editor.precanvas.style.transformOrigin = '0 0'
    editor.precanvas.style.transform = `translate(${editor.canvas_x}px, ${editor.canvas_y}px) scale(${zoom})`
    setZoomLevel(Math.round(zoom * 100))
    scheduleConnectionSync()
  }

  const hydrateDrawflow = () => {
    const editor = editorRef.current
    if (!editor) return

    // [GroupDrag] A hydrate during a group drag nukes every
    // follower's `style.left/top` because the editor.import call
    // rebuilds the DOM. Investigation log was removed.

    // [CanvasInvestigate] probe — fires every time a structural
    // signature change causes a full canvas re-import. Confirms
    // whether position-drag is rebuilding the entire canvas.
    // Caller context is captured by `reason` so we can map a
    // signature-flip back to the upstream event (drag, add,
    // delete, paste, output update, etc.).
    canvasLog('hydrateDrawflow', {
      reason: 'hydrateDrawflow-invoke',
      structureSignatureNow: structureSignature,
      canvasDragInFlight: !!canvasDragInFlightRef.current.nodeId,
      dragNodeId: canvasDragInFlightRef.current.nodeId,
      nodeCount: workflowRef.current?.nodes?.length ?? 0,
      edgeCount: workflowRef.current?.edges?.length ?? 0,
    })

    disconnectNodeResizeObservers()
    suppressEdgeEventRef.current = true
    editor.import(buildDrawflowData(workflowRef.current), false)
    suppressEdgeEventRef.current = false

    // [CanvasFix] round-2: re-seed the position mirror after a
    // full import so the positionSignature effect does not treat
    // every node as "changed" on the next render. `editor.import`
    // already placed each DOM node at the workflow's stored
    // position, so the mirror must agree.
    lastAppliedPositionsRef.current.clear()
    for (const node of workflowRef.current.nodes) {
      lastAppliedPositionsRef.current.set(node.id, {
        x: node.position.x,
        y: node.position.y,
      })
    }

    requestAnimationFrame(() => {
      applyPortAttributes()
      attachNodeResizeObservers()
      scheduleDrawflowConnectionRefresh(null, { all: true })
      syncSelectedNodeDom()
      scheduleConnectionSync()
      refreshZoom()
    })
  }

  useEffect(() => {
    if (!canvasRef.current) return

    // [GroupDragInvestigate] probe-mounted. Fires once when the
    // editor is created, gated by the same flag the user enables via
    // localStorage / window flag. The previous round of investigation
    // [GroupDrag] Mount probe was removed in the log-cleanup pass.

    const canvasEl = canvasRef.current
    canvasEl.innerHTML = ''
    const editor = new Drawflow(canvasEl) as DrawflowInstance
    editor.reroute = true
    editor.curvature = 0.5
    editor.reroute_curvature_start_end = 0.5
    editor.reroute_curvature = 0.5
    editor.force_first_input = false
    editor.line_path = 5
    editor.editor_mode = 'edit'
    editor.zoom_min = 0.35
    editor.zoom_max = 1.6
    editor.zoom_value = 0.1

    // Drawflow assumes every node/port it previously saw is still mounted.
    // React can replace that DOM between a pointer event and Drawflow's next
    // connection refresh, so guard only the known stale-DOM failure paths.
    const recoverFromStaleDrawflowDom = (error: unknown) => {
      if (!isStaleDrawflowDomError(error)) throw error
      editor.drag = false
      editor.drag_point = false
      editor.connection = false
      editor.editor_selected = false
      editor.ele_selected = null
      if (editor.connection_ele && !editor.connection_ele.isConnected) {
        editor.connection_ele = null
      }
    }

    const updateConnectionNodes = editor.updateConnectionNodes.bind(editor)
    editor.updateConnectionNodes = (nodeId: string) => {
      try {
        updateConnectionNodes(nodeId)
      } catch (error) {
        recoverFromStaleDrawflowDom(error)
      }
    }

    const removeSingleConnection = editor.removeSingleConnection.bind(editor)
    editor.removeSingleConnection = (source, target, sourceHandle, targetHandle) => {
      try {
        removeSingleConnection(source, target, sourceHandle, targetHandle)
      } catch (error) {
        recoverFromStaleDrawflowDom(error)
      }
    }

    const click = editor.click?.bind(editor)
    if (click) {
      editor.click = (event) => {
        try {
          return click(event)
        } catch (error) {
          recoverFromStaleDrawflowDom(error)
        }
      }
    }

    const position = editor.position?.bind(editor)
    if (position) {
      editor.position = (event) => {
        try {
          return position(event)
        } catch (error) {
          recoverFromStaleDrawflowDom(error)
        }
      }
    }

    const dragEnd = editor.dragEnd?.bind(editor)
    if (dragEnd) {
      editor.dragEnd = (event) => {
        try {
          return dragEnd(event)
        } catch (error) {
          recoverFromStaleDrawflowDom(error)
        }
      }
    }

    editor.contextmenu = (event: Event) => {
      event.preventDefault()
      return false
    }
    editor.start()
    // Drawflow leaves transform-origin at the browser default (center).
    // Every canvas_x/canvas_y calculation in this editor is top-left based,
    // so establish that coordinate system before the initial auto-fit. The
    // pan handler also sets this value; relying on it made the fitted canvas
    // visibly jump only after the user's first pointer movement.
    editor.precanvas.style.transformOrigin = '0 0'

    editor.on('nodeSelected', (id: string | number) => {
      const nodeId = String(id)
      // [GroupDrag] drawflowNodeSelected probe was removed.
      // [WorkflowSelection] Stale-event guard. If a `clearCanvasSelection`
      // fired within the last 120ms, a synchronous re-fire of
      // `nodeSelected` from Drawflow's own click handler would
      // re-add the highlight we just removed. Drop the event and log
      // it so we can confirm the guard is doing its job.
      if (performance.now() < clearInFlightUntilRef.current) {
        wfSelectionLog('nodeSelected.suppressed', {
          nodeId,
          msUntilExpiry: Math.round(clearInFlightUntilRef.current - performance.now())
        })
        return
      }
      wfSelectionLog('nodeSelected.event', { nodeId })
      setSelectedNodeWithLog(nodeId, 'editor:nodeSelected')
      requestAnimationFrame(() => syncSelectedNodeDom(nodeId))
    })

    editor.on('nodeUnselected', () => {
      wfSelectionLog('nodeUnselected.event', {
        selectionIntent: selectionMouseDownRef.current
      })
      const selectionIntent = selectionMouseDownRef.current
      // [GroupDrag] drawflowNodeUnselected probe was removed.
      if (selectionIntent?.nodeId) {
        requestAnimationFrame(() => syncSelectedNodeDom(selectionIntent.nodeId))
        return
      }

      if (!selectionIntent || selectionIntent.clearOnUnselect) {
        clearCanvasSelection('drawflow-nodeUnselected')
      }
    })

    // [CanvasFix] Hotfix for canvas drag flicker.
    //
    // PREVIOUSLY: every drawflow tick (~30–60 Hz) called
    //   updateNodePosition(...)            // per-tick store write
    //   refreshDrawflowConnectionsNow(...) // per-tick refresh
    //   scheduleDrawflowConnectionRefresh(...) // per-tick full reapply
    // Each updateNodePosition mutated `position`, bumped `updatedAt`,
    // pushed a workflow history entry, and set `isDirty`. Combined
    // with `Math.round(position.x|y)` in the structural signature,
    // this caused the canvas to be `editor.import`ed multiple times
    // per drag.
    //
    // NOW: store the latest position in a ref only (no React render,
    // no history push, no updatedAt bump). At mouseUp, the ref is
    // drained into a single `updateNodePositions` bulk call so the
    // store receives ONE write per drag gesture — history + persist
    // each happen exactly once.
    editor.on('nodeMoved', (id: string | number) => {
      // [GroupDrag] nodeMoved probes were removed in the log-cleanup
      // pass. `canvasLog('nodeMoved', …)` still runs from the
      // canvasInvestigate flag — see `src/lib/canvasInvestigate.ts`.
      if (suppressEdgeEventRef.current) return
      const node = editor.getNodeFromId(id)
      const nodeId = String(id)
      const now = performance.now()
      const prevTick = canvasDragInFlightRef.current
      canvasDragInFlightRef.current = {
        nodeId,
        lastTickAt: now,
      }
      canvasLog('nodeMoved', {
        nodeId,
        x: node.pos_x,
        y: node.pos_y,
        ticksSincePrev: prevTick.nodeId === nodeId ? Math.round(now - prevTick.lastTickAt) : -1,
        nodeCount: workflowRef.current?.nodes?.length ?? 0,
      })

      // [GroupDrag] Detect group drag start. With the mirror pattern,
      // the actual drag is driven by `multiDragRef` (set on plain
      // mousedown inside a multi-selected node). nodeMoved still
      // fires for the leader as Drawflow moves it natively; we just
      // prime the leader's pending entry here so mouseUp commits
      // the bulk. nodeMoved for followers is a no-op because the
      // follower DOM was set by the mirror handler, not by Drawflow.
      const gd = groupDragRef.current
      const md = multiDragRef.current
      const isLeaderInMirror = !!(md && md.grabbedId === nodeId)
      const isFollowerInMirror = !!(md && md.selectedIds.has(nodeId) && md.grabbedId !== nodeId)

      if (isFollowerInMirror) {
        // Follower mutation — already painted by the mirror handler.
        // Drawflow's internal observer can re-emit a `nodeMoved` tick
        // for the follower because we updated `pos_x/pos_y` via
        // `applyDrawflowNodePosition` semantics. Do nothing — let
        // the mirror keep owning these ids.
        return
      }

      if (isLeaderInMirror) {
        // Leader tick during a mirror drag. Just keep the pending
        // entry fresh from Drawflow's authoritative `pos_x/pos_y`.
        // Followers are NOT recomputed here — the mirror handler
        // already set them from `(clientX - mouseStartX) / zoom`.
        pendingDragPositionsRef.current.set(nodeId, {
          x: node.pos_x,
          y: node.pos_y
        })
        return
      }

      if (gd.active) {
        // Legacy single-leader drag (mirror inactive). The
        // activation block is intentionally minimal here — the
        // prior nodeMoved-driven follower logic is removed per
        // spec H. We still keep `gd.active` so the existing
        // finishGroupDrag / mouseUp path stays consistent for
        // any call sites that read it.
        return
      }

      // Mirror inactive and `gd` not active — this is a plain
      // single-node drag. Prime the leader's pending entry from
      // Drawflow's authoritative position and refresh its
      // connections. No store write, no history, no `isDirty`, no
      // `updatedAt`.
      pendingDragPositionsRef.current.set(nodeId, { x: node.pos_x, y: node.pos_y })
      lightweightDragConnectionRefresh(nodeId)
    })

    editor.on('nodeRemoved', (id: string | number) => {
      if (suppressEdgeEventRef.current) return
      deleteNode(String(id))
    })

    editor.on('connectionCreated', (connection: DrawflowConnection) => {
      if (suppressEdgeEventRef.current) return
      if (!isConnectionCompatible(connection)) {
        suppressEdgeEventRef.current = true
        editor.removeSingleConnection(
          String(connection.output_id),
          String(connection.input_id),
          connection.output_class || 'output_1',
          connection.input_class || 'input_1'
        )
        suppressEdgeEventRef.current = false
        requestAnimationFrame(applyPortAttributes)
        scheduleConnectionSync()
        return
      }

      addEdgeToStore({
        source: String(connection.output_id),
        target: String(connection.input_id),
        sourceHandle: connection.output_class || 'output_1',
        targetHandle: connection.input_class || 'input_1',
        animated: true
      })
      requestAnimationFrame(applyPortAttributes)
      scheduleConnectionSync()
    })

    editor.on('connectionRemoved', (connection: DrawflowConnection) => {
      if (suppressEdgeEventRef.current) return
      const current = useWorkflowStore.getState().getActiveWorkflow()
      const edge = current?.edges.find((item) =>
        item.source === String(connection.output_id) &&
        item.target === String(connection.input_id) &&
        (item.sourceHandle || 'output_1') === (connection.output_class || 'output_1') &&
        (item.targetHandle || 'input_1') === (connection.input_class || 'input_1')
      )
      if (edge) deleteEdge(edge.id)
      requestAnimationFrame(applyPortAttributes)
      scheduleConnectionSync()
    })

    editor.on('zoom', (zoom: number) => {
      setZoomLevel(Math.round(zoom * 100))
      scheduleConnectionSync()
    })

    editor.on('mouseMove', scheduleConnectionSync)
    editor.on('translate', scheduleConnectionSync)
    editor.on('connectionStart', scheduleConnectionSync)
    editor.on('connectionCancel', scheduleConnectionSync)
    editor.on('mouseUp', () => {
      // [CanvasFix] Hotfix for canvas drag flicker.
      //
      // PREVIOUSLY: this `mouseUp` handler only cleared the
      // investigation ref and ran `scheduleConnectionSync`. All
      // position data was already in the store (because per-tick
      // writes fired throughout the drag).
      //
      // NOW: this is where the drag's accumulated position data
      // finally commits to the store. The pending map is drained
      // into a single `updateNodePositions` bulk call so the
      // store receives exactly ONE workflow write per drag
      // gesture — one history push, one updatedAt bump, one
      // `isDirty` flip. From an undo/redo standpoint, the entire
      // gesture counts as one user action.
      //
      // [GroupDrag][mirror] When a multi-selection mirror drag is
      // active, the capture-phase `finishMultiDragMirror(true)` has
      // ALREADY drained the pending map and called
      // `updateNodePositions` BEFORE this handler runs. So the
      // pending map is empty here — the bulk commit below is a
      // no-op for mirror drags. Single-node drags still flow
      // through this path normally.
      if (groupDragRef.current.active) {
        finishGroupDrag({ commit: true, reason: 'mouseUp' })
      }
      const pending = pendingDragPositionsRef.current
      if (pending.size > 0 && !multiDragRef.current) {
        const positions: Record<string, { x: number; y: number }> = {}
        for (const [nodeId, position] of pending.entries()) {
          positions[nodeId] = position
        }
        pending.clear()
        const activeWorkflowId = useWorkflowStore.getState().activeWorkflowId
        // [GroupDrag] commitPositions probe was removed.
        canvasLog('commitNodePositions', {
          count: Object.keys(positions).length,
          workflowId: activeWorkflowId,
          source: 'mouseUp',
        })
        updateNodePositions(positions, activeWorkflowId ?? undefined)
        // [CanvasFix] round-2: after committing, sync the
        // `lastAppliedPositionsRef` mirror so the
        // `positionSignature` effect does NOT re-apply the same
        // positions to the DOM on the next render. Drawflow has
        // already moved the DOM during the drag; we're just
        // catching up the ref so future undo/redo from THIS
        // position can correctly detect the diff.
        for (const [nodeId, position] of Object.entries(positions)) {
          lastAppliedPositionsRef.current.set(nodeId, position)
        }
        // After committing positions, make sure the persisted
        // node DOM matches the new workflow state. We use the
        // already-existing full-fingerprint refresh path: it
        // handles the case where multiple nodes share a
        // connection endpoint correctly.
        scheduleDrawflowConnectionRefresh(null, { all: true })
      }

      // [CanvasInvestigate] probe boundary — drag finished.
      // Cleared on the first non-drag tick so subsequent calls
      // are tagged "idle" instead of "drag". Combined with the
      // pre-existing handler below into a single binding to
      // avoid duplicate listeners.
      const prev = canvasDragInFlightRef.current
      if (prev.nodeId) {
        canvasLog('dragEnd', {
          nodeId: prev.nodeId,
          dragDurationMs: Math.round(performance.now() - prev.lastTickAt),
        })
        canvasDragInFlightRef.current = { nodeId: null, lastTickAt: 0 }
      }
      selectionMouseDownRef.current = null
      scheduleConnectionSync()
    })
    editor.on('rerouteMoved', scheduleConnectionSync)
    editor.on('addReroute', scheduleConnectionSync)
    editor.on('removeReroute', scheduleConnectionSync)

    const syncOnPointerMove = (event: MouseEvent | PointerEvent | TouchEvent) => {
      rememberCanvasPointer(event)
      const activeNodeId = editor.drag
        ? editor.ele_selected?.id || editor.node_selected?.id
        : editor.node_selected?.id
      if (activeNodeId) updateDrawflowConnectionNodeNow(activeNodeId)
      scheduleConnectionSync()
    }
    const canvasPointFromClient = (clientX: number, clientY: number) => {
      const rect = editor.precanvas.getBoundingClientRect()
      const zoom = editor.zoom || 1
      return {
        x: (clientX - rect.left) / zoom,
        y: (clientY - rect.top) / zoom
      }
    }
    const portCenterPoint = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return canvasPointFromClient(rect.left + rect.width / 2, rect.top + rect.height / 2)
    }
    const portDragPath = (start: { x: number; y: number }, end: { x: number; y: number }, startSide: 'in' | 'out') => {
      const direction = startSide === 'out' ? 1 : -1
      const distance = Math.max(80, Math.abs(end.x - start.x) * 0.5)
      return `M ${start.x} ${start.y} C ${start.x + direction * distance} ${start.y} ${end.x - direction * distance} ${end.y} ${end.x} ${end.y}`
    }
    const startInputPortDrag = (startPort: DrawflowPortDragInfo, event: MouseEvent) => {
      portDragCleanupRef.current?.()

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const start = portCenterPoint(startPort.element)
      svg.classList.add('connection', 'df-port-drag-connection', `conn-type-${startPort.type}`)
      svg.style.pointerEvents = 'none'
      path.classList.add('main-path')
      path.setAttribute('fill', 'none')
      svg.appendChild(path)
      editor.precanvas.appendChild(svg)

      const updatePath = (moveEvent: MouseEvent) => {
        const end = canvasPointFromClient(moveEvent.clientX, moveEvent.clientY)
        path.setAttribute('d', portDragPath(start, end, startPort.side))
      }
      const cleanup = () => {
        document.removeEventListener('mousemove', updatePath, true)
        document.removeEventListener('mouseup', handleMouseUp, true)
        svg.remove()
        if (portDragCleanupRef.current === cleanup) portDragCleanupRef.current = null
        scheduleConnectionSync()
      }
      const handleMouseUp = (upEvent: MouseEvent) => {
        const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)
        const endPort = getPortDragInfo(target)
        addPortConnection(startPort, endPort)
        cleanup()
      }

      updatePath(event)
      portDragCleanupRef.current = cleanup
      document.addEventListener('mousemove', updatePath, true)
      document.addEventListener('mouseup', handleMouseUp, true)
    }
    const handleBidirectionalPortMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return

      const port = getPortDragInfo(event.target)
      if (!port || port.side !== 'in') return

      event.preventDefault()
      event.stopImmediatePropagation()
      selectionMouseDownRef.current = { nodeId: null, clearOnUnselect: false }
      startInputPortDrag(port, event)
    }
    const handleSelectionMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return

      const target = event.target as HTMLElement | null
      if (!target) return

      const nodeEl = target.closest<HTMLElement>('.drawflow-node')
      const outputPort = target.closest('.output')
      const inputPort = target.closest('.input')
      const connectionPath = target.closest('.main-path, svg.connection')
      const canvasSurface = !nodeEl && Boolean(target.closest('.drawflow, .parent-drawflow'))
      const nodeId = nodeEl && !outputPort && !inputPort ? nodeEl.id.replace(/^node-/, '') : null

      // [GroupDrag] nodePointerDown probe was removed in the
      // log-cleanup pass.
      // [WorkflowSelection] Diagnostic log. Emits on EVERY mousedown
      // landing inside the canvas. Off by default; enable with
      // `localStorage.setItem('AI_FLOW_DEBUG','1')` to see whether
      // the handler even runs for a given click.
      wfSelectionLog('pointerdown.inspect', {
        source: 'canvas-mousedown',
        tag: target.tagName,
        className: target.className,
        id: target.id,
        closestDrawflowNode: nodeEl?.id ?? null,
        closestConnection: connectionPath ? true : false,
        closestCanvas: canvasSurface,
        closestParentDrawflow: !!target.closest('.parent-drawflow'),
        closestControl: !!target.closest(
          'button, input, textarea, select, [role="button"], [data-node-action]'
        ),
        selectedNodeIdBefore: useWorkflowStore.getState().selectedNodeId,
        domSelectedNodesCount: canvasRef.current
          ? canvasRef.current.querySelectorAll('.drawflow-node.selected').length
          : 0,
        domSelectedConnectionCount: canvasRef.current
          ? canvasRef.current.querySelectorAll('svg.connection.conn-node-selected').length
          : 0,
        eventPhase: event.eventPhase,
        button: event.button
      })

      selectionMouseDownRef.current = {
        nodeId,
        clearOnUnselect: Boolean(outputPort || connectionPath || canvasSurface)
      }

      // [GroupDrag][mirror] Plain mousedown over a node that is already
      // in the multi-selection kicks off a mirror drag: Drawflow
      // continues to drag the grabbed node natively, and we mirror
      // every other selected node by the same viewport delta
      // (divided by zoom) so the cluster moves as one. We do NOT
      // stop propagation / preventDefault — the click must reach
      // Drawflow's listener so its native node drag starts.
      //
      // Conditions:
      //   - clicked a real node
      //   - node is in the multi-selection set
      //   - multi size >= 2 (otherwise single-node drag)
      //   - not on a port / connection / control / pill / inline
      //     editor / resize handle / node picker
      //   - no Shift/Cmd (those modifiers mean toggle, not drag)
      if (
        nodeId &&
        !outputPort &&
        !inputPort &&
        !connectionPath &&
        !canvasSurface &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        const onControl = !!target.closest(
          'button, input, textarea, select, [role="button"], [data-node-action], .df-node-toolbar, .df-hover-toolbar, .df-node-pill-menu, .df-node-prompt-editor, .df-node-resize-handle, .df-node-settings-bar, .aiflow-node-picker'
        )
        if (!onControl) {
          const multi = multiSelectedNodeIdsRef.current
          if (multi.size >= 2 && multi.has(nodeId)) {
            startMultiDragMirror(nodeId, event)
          } else if (!multi.has(nodeId)) {
            // Plain click on a non-multi-selected node — make sure no
            // mirror is left dangling.
            if (multiDragRef.current) {
              finishMultiDragMirror(false)
            }
          }
        }
      } else if (!nodeId || outputPort || inputPort || connectionPath || canvasSurface) {
        // Pointerdown on non-node surface (port / connection /
        // canvas) clears any leftover mirror so a stray gesture
        // cannot keep applying follower deltas.
        if (multiDragRef.current) {
          finishMultiDragMirror(false)
        }
      }

      // ── Marquee selection start (Ctrl + drag on empty canvas) ─────
      // Holding Ctrl and pressing on the empty canvas starts a
      // marquee-selection drag. A simple click on empty canvas (no
      // Ctrl) keeps the existing clearSelection path so the user can
      // still wipe selection with one click.
      //
      // Behaviour:
      //  - Live preview: while dragging, hit-test runs ~per-frame and
      //    toggles `.selected` / `.conn-node-selected` on nodes whose
      //    screen-space rect intersects the marquee. The user sees the
      //    glow move in real time as the rectangle grows or shrinks.
      //  - No anchor: Ctrl + drag is a NEW selection. Existing selected
      //    nodes that fall outside the new rectangle lose their glow.
      //  - Mouseup commits the preview set as the official multi-set.
      //    We do not hit-test again — the user must see the same set
      //    they were previewing when they released.
      //  - No workflow store writes per frame. Only DOM class
      //    toggles + an `editor.import`/`hydrateDrawflow`-free path.
      // [GroupDrag] Multi-select modifier (Shift / Cmd on macOS) gates both
      // the marquee start and the Shift+click toggle path. Ctrl is
      // deliberately NOT used here — the OS / browser already claim it
      // for copy / paste / right-click / refresh, so Ctrl grabs are
      // unreliable and frequently blocked by other handlers.
      if (!nodeId && canvasSurface && (event.shiftKey || event.metaKey) && !outputPort && !inputPort && !connectionPath) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()

        // Drop the previous selection immediately so a shrinking marquee
        // doesn't leave stale highlights on nodes that were in the old
        // anchor set but are now outside the rectangle. We also wipe
        // the DOM `.selected` class and `editor.node_selected` here —
        // the first preview rAF would otherwise have to clean them up
        // and the user would see a one-frame flash of stale glow.
        //
        // Capture the previous selection BEFORE we wipe it so a
        // no-drag Ctrl+click (which the user spec defines as a no-op,
        // not a clear) can restore it. This matches Figma / VS Code
        // marquee semantics: dragging begins a new selection, but
        // clicking without dragging is a no-op.
        const previousMultiIds = new Set(multiSelectedNodeIdsRef.current)
        const previouslySelectedId = useWorkflowStore.getState().selectedNodeId
        if (previouslySelectedId) previousMultiIds.add(previouslySelectedId)

        setMultiSelectedNodeIds(null)
        setSelectedNodeWithLog(null, 'marquee:start')
        setMarqueeRect(null)
        marqueePreviewNodeIdsRef.current = new Set()
        marqueePreviewCountRef.current = 0
        setMarqueePreviewCount(0)
        marqueeActiveRef.current = true
        syncSelectedNodeDom(null)

        const startClient = { x: event.clientX, y: event.clientY }
        let lastRect: MarqueeRect = { left: startClient.x, top: startClient.y, width: 0, height: 0 }
        let dragMoved = false

        // Hit-test against node DOM rects in screen-space. Runs inside
        // a single rAF so a fast 1kHz mousemove stream collapses to one
        // mutation per frame. Both the marquee (in clientX/Y) and the
        // node DOM rects (post-transform) live in screen-space, so a
        // direct intersection test works without any pan/zoom math.
        const runPreviewHitTest = () => {
          marqueePreviewFrameRef.current = null
          const rect = marqueeLastRectRef.current
          if (!rect) return
          const canvasEl = canvasRef.current
          if (!canvasEl) return

          const rectLeft = rect.left
          const rectTop = rect.top
          const rectRight = rect.left + rect.width
          const rectBottom = rect.top + rect.height

          const nextIds = new Set<string>()
          canvasEl.querySelectorAll<HTMLElement>('.drawflow-node[id^="node-"]').forEach((el) => {
            const nodeRect = el.getBoundingClientRect()
            if (!nodeRect || nodeRect.width === 0 || nodeRect.height === 0) return
            const intersects =
              nodeRect.left <= rectRight &&
              nodeRect.left + nodeRect.width >= rectLeft &&
              nodeRect.top <= rectBottom &&
              nodeRect.top + nodeRect.height >= rectTop
            if (intersects) {
              nextIds.add(toWorkflowNodeId(el.id))
            }
          })

          const prevIds = marqueePreviewNodeIdsRef.current
          // Early-out when the visible set did not change (e.g. the
          // mouse moved inside the same hit region). This is the main
          // perf guard — without it, every rAF would re-touch every
          // `.selected` class.
          if (prevIds.size === nextIds.size && Array.from(prevIds).every((id) => nextIds.has(id))) {
            return
          }
          marqueePreviewNodeIdsRef.current = nextIds

          syncSelectedNodeDomForIds(nextIds, { mutateEditor: false })
          syncConnectionOverlaysForSelectedIds(nextIds)

          const nextCount = nextIds.size
          if (nextCount !== marqueePreviewCountRef.current) {
            marqueePreviewCountRef.current = nextCount
            setMarqueePreviewCount(nextCount)
          }
        }

        const schedulePreviewHitTest = (rect: MarqueeRect) => {
          marqueeLastRectRef.current = rect
          if (marqueePreviewFrameRef.current != null) return
          marqueePreviewFrameRef.current = requestAnimationFrame(runPreviewHitTest)
        }

        const updateRect = (moveEvent: MouseEvent) => {
          const moved = Math.abs(moveEvent.clientX - startClient.x) > 3 || Math.abs(moveEvent.clientY - startClient.y) > 3
          dragMoved = dragMoved || moved
          const left = Math.min(startClient.x, moveEvent.clientX)
          const top = Math.min(startClient.y, moveEvent.clientY)
          const width = Math.abs(moveEvent.clientX - startClient.x)
          const height = Math.abs(moveEvent.clientY - startClient.y)
          lastRect = { left, top, width, height }
          setMarqueeRect(lastRect)
          schedulePreviewHitTest(lastRect)
        }

        // Centralized cleanup. Used by mouseup, escape, pointercancel,
        // and window-blur. Removes all transient DOM glow + state.
        const cleanupPreview = () => {
          document.removeEventListener('mousemove', updateRect, true)
          document.removeEventListener('mouseup', finish, true)
          document.removeEventListener('keydown', onEscape, true)
          window.removeEventListener('blur', onBlur)
          window.removeEventListener('pointercancel', onPointerCancel, true)
          if (marqueePreviewFrameRef.current != null) {
            cancelAnimationFrame(marqueePreviewFrameRef.current)
            marqueePreviewFrameRef.current = null
          }
          marqueeLastRectRef.current = null
          marqueeActiveRef.current = false
        }

        const onEscape = (keyEvent: KeyboardEvent) => {
          if (keyEvent.key !== 'Escape') return
          keyEvent.preventDefault()
          keyEvent.stopPropagation()
          // Cancel: restore the previous committed selection (whatever
          // was selected before this Ctrl+drag started). Without this
          // the user would lose their selection if they accidentally
          // pressed Escape mid-drag.
          setMarqueeRect(null)
          marqueePreviewNodeIdsRef.current = new Set()
          marqueePreviewCountRef.current = 0
          setMarqueePreviewCount(0)
          syncSelectedNodeDom()
          cleanupPreview()
        }

        const onBlur = () => {
          // Window lost focus mid-drag (alt-tab, devtools, etc). The
          // mouseup may never arrive on the document. Restore the
          // previous selection and bail.
          setMarqueeRect(null)
          marqueePreviewNodeIdsRef.current = new Set()
          marqueePreviewCountRef.current = 0
          setMarqueePreviewCount(0)
          syncSelectedNodeDom()
          cleanupPreview()
        }

        const onPointerCancel = () => {
          setMarqueeRect(null)
          marqueePreviewNodeIdsRef.current = new Set()
          marqueePreviewCountRef.current = 0
          setMarqueePreviewCount(0)
          syncSelectedNodeDom()
          cleanupPreview()
        }

        const finish = (upEvent: MouseEvent) => {
          cleanupPreview()

          if (!dragMoved) {
            // Undragged Ctrl+click on empty canvas is a no-op — the
            // existing clear was already applied at marquee start, so
            // we need to restore the previous selection here. This
            // matches standard editor semantics: dragging begins a
            // marquee, clicking without dragging does not.
            setMarqueeRect(null)
            marqueePreviewCountRef.current = 0
            setMarqueePreviewCount(0)
            setMultiSelectedNodeIds(previousMultiIds)
            if (previousMultiIds.size === 1) {
              const [onlyId] = previousMultiIds
              if (onlyId) {
                setSelectedNodeWithLog(onlyId, 'marquee:no-drag-single')
                requestAnimationFrame(() => syncSelectedNodeDom(onlyId))
              }
            } else {
              // Multi-set with 2+ items keeps the store's
              // selectedNodeId clear so single-node Drawflow paths
              // don't fight the multi-selection. When there's nothing
              // to restore (previousMultiIds is empty), the call to
              // setSelectedNodeWithLog(null, ...) is a no-op against
              // an already-null store.
              const restoreSingle = previousMultiIds.size === 0
                ? null
                : previouslySelectedId
              setSelectedNodeWithLog(
                restoreSingle,
                previousMultiIds.size > 1
                  ? `marquee:no-drag-multi-${previousMultiIds.size}`
                  : 'marquee:no-drag-restore'
              )
              requestAnimationFrame(() => syncSelectedNodeDom(restoreSingle))
            }
            scheduleConnectionSync()
            return
          }

          // Drain any pending rAF so the final preview set is in sync
          // with what the user is seeing at mouseup. The committed set
          // is the live preview set, NOT a fresh hit-test — this is
          // the contract: "what you see when you release is what you
          // get".
          if (marqueePreviewFrameRef.current != null) {
            cancelAnimationFrame(marqueePreviewFrameRef.current)
            marqueePreviewFrameRef.current = null
            runPreviewHitTest()
          }

          const ids = new Set(marqueePreviewNodeIdsRef.current)
          setMarqueeRect(null)
          marqueePreviewCountRef.current = 0
          setMarqueePreviewCount(0)

          setMultiSelectedNodeIds(ids)
          if (ids.size === 1) {
            const [onlyId] = ids
            if (onlyId) {
              setSelectedNodeWithLog(onlyId, 'marquee:committed-single')
              requestAnimationFrame(() => syncSelectedNodeDom(onlyId))
            }
          } else if (ids.size === 0) {
            setSelectedNodeWithLog(null, 'marquee:committed-empty')
            requestAnimationFrame(() => syncSelectedNodeDom(null))
          } else {
            setSelectedNodeWithLog(null, `marquee:committed-multi:${ids.size}`)
            requestAnimationFrame(() => syncSelectedNodeDom(null))
          }
          // [GroupDrag] multiSelectCommitted probe was removed.
          scheduleConnectionSync()

          // Suppress the synthetic click that fires immediately after
          // mouseup — otherwise a click handler would re-clear our
          // selection.
          if (upEvent && typeof upEvent.preventDefault === 'function') {
            upEvent.preventDefault()
          }
          const swallow = (ev: MouseEvent) => {
            ev.stopPropagation()
            ev.stopImmediatePropagation()
            ev.preventDefault()
            document.removeEventListener('click', swallow, true)
          }
          document.addEventListener('click', swallow, true)
        }

        document.addEventListener('mousemove', updateRect, true)
        document.addEventListener('mouseup', finish, true)
        document.addEventListener('keydown', onEscape, true)
        window.addEventListener('blur', onBlur)
        window.addEventListener('pointercancel', onPointerCancel, true)
        return
      }

      if (nodeId) {
        // Shift + click on a node toggles it in the multi-selection set
        // instead of replacing the selection. Plain click still
        // replaces (single-selection behaviour). Meta/Cmd on macOS
        // is the friendly alias.
        if (event.shiftKey || event.metaKey) {
          event.preventDefault()
          // Suppress Drawflow's own `nodeSelected` re-fire for the
          // next ~250ms. Without this, Drawflow's internal click
          // handler would call `setSelectedNode(nodeId)` and our
          // careful multi-selection bookkeeping would be overwritten
          // by a stale single-node selection.
          clearInFlightUntilRef.current = performance.now() + 250
          const next = new Set(multiSelectedNodeIdsRef.current)
          if (next.has(nodeId)) {
            next.delete(nodeId)
          } else {
            next.add(nodeId)
          }
          setMultiSelectedNodeIds(next)
          if (next.size === 1) {
            const [onlyId] = next
            setSelectedNodeWithLog(onlyId, 'shift-click:single-remaining')
            requestAnimationFrame(() => syncSelectedNodeDom(onlyId))
          } else {
            setSelectedNodeWithLog(null, `shift-click:multi-${next.size}`)
            requestAnimationFrame(() => syncSelectedNodeDom(null))
          }
          scheduleConnectionSync()
          return
        }
        setSelectedNodeWithLog(nodeId, 'canvas-mousedown:node')
        requestAnimationFrame(() => syncSelectedNodeDom(nodeId))
      } else if (canvasSurface || connectionPath) {
        clearCanvasSelection('canvas-mousedown:surface')
      }
    }

    // ── Empty-area pan ─────────────────────────────────────────────
    // Left-button drag on any viewport area that is NOT a node, port,
    // connection, or interactive form control. Drawflow already has its
    // own background-pan (mousedown on .parent-drawflow), but it
    // triggers node-drag when the target is a .drawflow-node and does
    // nothing on areas Drawflow did not annotate. This handler runs in
    // the capture phase AFTER handleBidirectionalPortMouseDown (so port
    // drags still win) and stops propagation to suppress Drawflow's
    // own drag logic on the canvas surface, then mutates
    // editor.canvas_x / canvas_y + the precanvas transform the same
    // way applyCanvasZoom does.
    const handleDocumentSelectionMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return

      const target = event.target as HTMLElement | null
      if (!target) return

      // Skip when the click landed on any interactive element inside
      // a node. Without this guard, clicking node toolbar buttons or
      // inline editors would accidentally clear the selection.
      const insideNode = target.closest(
        '.drawflow-node, .input, .output, .df-hover-toolbar, .df-node-toolbar, .df-node-settings-bar, .df-node-pill-menu, .df-node-prompt-editor, .aiflow-node-picker, button, [role="button"], input, textarea, select, [contenteditable="true"], [data-node-action]'
      )
      if (insideNode) {
        // [GroupDrag] documentPointerDown.filtered probe was removed.
        return
      }

      // Only handle clicks that landed inside the editor / canvas
      // region. Clicks outside the editor (e.g. on the top nav or the
      // sidebar) should NOT clear the workflow selection — the user
      // might just be giving focus to another panel.
      const insideEditor = !!target.closest(
        '.ai-drawflow-canvas, .drawflow, .parent-drawflow, .aiflow-wf-toolbar, [data-workflow-editor-root]'
      )
      if (!insideEditor) return

      // [WorkflowSelection] Diagnostic log. Captures the click that
      // would have been silently dropped before — clicking on a
      // non-Drawflow background (dotted overlay, padding around the
      // canvas, etc.) used to fall through without clearing.
      wfSelectionLog('pointerdown.inspect', {
        source: 'document-mousedown',
        tag: target.tagName,
        className: target.className,
        id: target.id,
        closestDrawflowNode: target.closest('.drawflow-node')?.id ?? null,
        closestConnection: !!target.closest('.main-path, svg.connection'),
        closestCanvas: !!target.closest('.drawflow, .parent-drawflow'),
        closestParentDrawflow: !!target.closest('.parent-drawflow'),
        closestControl: !!target.closest(
          'button, input, textarea, select, [role="button"], [data-node-action]'
        ),
        selectedNodeIdBefore: useWorkflowStore.getState().selectedNodeId,
        domSelectedNodesCount: canvasRef.current
          ? canvasRef.current.querySelectorAll('.drawflow-node.selected').length
          : 0,
        domSelectedConnectionCount: canvasRef.current
          ? canvasRef.current.querySelectorAll('svg.connection.conn-node-selected').length
          : 0,
        eventPhase: event.eventPhase,
        button: event.button
      })

      // No-op DOM diff: only clear when there IS a selected node OR
      // a stray .selected / .conn-node-selected currently visible. We
      // no longer early-return on `!selectedNodeId` — that early-return
      // was the root cause of the "highlight won't clear" bug when the
      // store was null but a stale class lingered.
      const canvas = canvasRef.current
      if (!canvas) return
      const hasSelectedNodeClass = canvas.querySelector('.drawflow-node.selected') !== null
      const hasSelectedEdgeClass = canvas.querySelector('svg.connection.conn-node-selected') !== null
      const storeSelectedId = useWorkflowStore.getState().selectedNodeId
      if (!storeSelectedId && !hasSelectedNodeClass && !hasSelectedEdgeClass) return

      // Drop any leftover mirror before clearing selection so the
      // mirror's restored positions don't bleed into the cleared state.
      if (multiDragRef.current) {
        finishMultiDragMirror(false)
      }
      clearCanvasSelection(`document-mousedown:${target.tagName.toLowerCase()}:${target.className?.split(/\s+/).slice(0, 2).join('.') || 'unknown'}`)
    }

    let panActive = false
    let panStartX = 0
    let panStartY = 0
    let panBaseX = 0
    let panBaseY = 0
    let panPointerId: number | null = null

    const isPanExcluded = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null
      if (!el) return true
      if (el.closest('.drawflow-node')) return true
      if (el.closest('.input, .output, .main-path, svg.connection')) return true
      if (el.closest('button, [role="button"], input, textarea, select, [contenteditable="true"]')) return true
      if (el.closest('.aiflow-node-picker, .df-node-prompt-editor, .df-node-resize-handle, .df-port-icon')) return true
      return false
    }

    const handlePanPointerMove = (event: PointerEvent) => {
      if (!panActive || event.pointerId !== panPointerId) return
      const dx = event.clientX - panStartX
      const dy = event.clientY - panStartY
      editor.canvas_x = Math.round(panBaseX + dx)
      editor.canvas_y = Math.round(panBaseY + dy)
      editor.precanvas.style.transformOrigin = '0 0'
      editor.precanvas.style.transform = `translate(${editor.canvas_x}px, ${editor.canvas_y}px) scale(${editor.zoom})`
      scheduleConnectionSync()
    }
    const handlePanPointerUp = (event: PointerEvent) => {
      if (!panActive || event.pointerId !== panPointerId) return
      panActive = false
      panPointerId = null
      document.removeEventListener('pointermove', handlePanPointerMove, true)
      document.removeEventListener('pointerup', handlePanPointerUp, true)
      document.removeEventListener('pointercancel', handlePanPointerUp, true)
    }
    const handleViewportPanPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (panActive) return
      if (isPanExcluded(event.target)) return
      if (!editor.precanvas) return

      // [WorkflowMarquee] Shift + drag is reserved for marquee selection.
      // Bail out so the marquee mousedown handler (registered on
      // `mousedown` capture, which fires after `pointerdown`) can claim
      // the gesture. Without this, the pan starts on pointerdown, the
      // editor canvas pans ~1px before the marquee swallows the event,
      // and the marquee feels laggy.
      if (event.shiftKey || event.metaKey) return

      panActive = true
      panStartX = event.clientX
      panStartY = event.clientY
      panBaseX = Number(editor.canvas_x) || 0
      panBaseY = Number(editor.canvas_y) || 0
      panPointerId = event.pointerId

      event.preventDefault()
      event.stopImmediatePropagation()

      document.addEventListener('pointermove', handlePanPointerMove, true)
      document.addEventListener('pointerup', handlePanPointerUp, true)
      document.addEventListener('pointercancel', handlePanPointerUp, true)
    }
    const handlePromptInlineEdit = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target || target.closest('.df-node-prompt-editor')) return

      const promptEl = target.closest<HTMLElement>('[data-prompt-editable="true"]')
      const nodeEl = promptEl?.closest<HTMLElement>('.df-node[data-workflow-node-id]')
      const nodeId = nodeEl?.dataset.workflowNodeId
      if (!promptEl || !nodeId) return

      const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
      if (!node || node.type !== 'prompt') return

      event.preventDefault()
      event.stopPropagation()
      closeNodePillMenu()
      setSelectedNode(nodeId)

      const currentPrompt = String((node.data as Record<string, unknown>).prompt || '')
      let finished = false
      const textarea = document.createElement('textarea')
      textarea.className = 'df-node-prompt-editor nodrag'
      textarea.value = currentPrompt
      textarea.placeholder = 'Enter prompt...'
      textarea.spellcheck = true

      const resize = () => {
        textarea.style.height = '0px'
        textarea.style.height = `${Math.min(170, Math.max(74, textarea.scrollHeight))}px`
        refreshDrawflowConnectionsNow([nodeId])
        scheduleDrawflowConnectionRefresh(nodeId)
      }
      const finish = (commit: boolean) => {
        if (finished) return
        finished = true
        textarea.removeEventListener('input', resize)
        textarea.removeEventListener('blur', commitEdit)
        textarea.removeEventListener('keydown', handleEditorKeyDown)
        textarea.removeEventListener('mousedown', stopEditorEvent)
        textarea.removeEventListener('click', stopEditorEvent)
        textarea.removeEventListener('dblclick', stopEditorEvent)
        document.removeEventListener('pointerdown', handleEditorPointerDown, true)

        // [PromptNodeEditExit] Always detach the <textarea> from the DOM
        // BEFORE the rerender. Listeners get removed above but the
        // element itself stays inside `promptEl` until either
        // `innerHTML` is replaced or we explicitly remove it. Without
        // this, races (canvas null, drawflow content not found) leave
        // a stale textarea + `.editing` class visible on the node.
        promptEl.classList.remove('editing')
        if (textarea.parentNode === promptEl) {
          promptEl.removeChild(textarea)
        }
        if (commit) {
          // Restore visible prompt text immediately so the node looks
          // like the prompt nodes below the canvas (no textarea, no
          // `.editing` chrome). The rerender below is still useful for
          // inspector sync, but the visible state is already correct.
          const displayPrompt = textarea.value
          promptEl.classList.toggle('df-node-prompt-empty', !displayPrompt.trim())
          promptEl.textContent = displayPrompt.trim() || 'Empty prompt'
        } else {
          // ESC / cancel: drop the textarea content and fall back to
          // the pre-edit prompt text from the store.
          promptEl.textContent = currentPrompt || 'Empty prompt'
          promptEl.classList.toggle('df-node-prompt-empty', !currentPrompt.trim())
        }

        if (commit) {
          const newPromptValue = textarea.value
          const currentLabel = String((node.data as Record<string, unknown>).label || '').trim()
          const nextLabel = !currentLabel || currentLabel === 'New Prompt Node' || currentLabel === 'Prompt'
            ? (newPromptValue.trim() ? 'Prompt' : 'New Prompt Node')
            : currentLabel
          updateNode(nodeId, { prompt: newPromptValue, label: nextLabel } as Partial<FlowNodeData>)
          // [PromptNodeLabel] After committing the prompt text, push a
          // drawflow-side rerender so the header label flips from
          // "New Prompt Node" to "Prompt" the moment the editor closes.
          // The `updateNode` above mutates the zustand store but
          // `workflowRef.current` won't be replaced until the next
          // React effect pass, so we synthesize the updated node
          // locally and feed it to `rerenderDrawflowNode` directly.
          const baseNode = workflowRef.current.nodes.find((item) => item.id === nodeId)
          if (baseNode) {
            rerenderDrawflowNode({
              ...baseNode,
              data: { ...(baseNode.data as Record<string, unknown>), prompt: newPromptValue, label: nextLabel }
            })
          }
          // [PromptNodeLabelDefense] Defensive DOM patch: also update
          // the `.df-node-title` text directly. The rerender above
          // SHOULD have done this, but drawflow's per-node rerender
          // occasionally no-ops (canvas null, selector miss, or
          // a follow-up dataSignature effect overwriting with stale
          // state). Without this fallback, the user sees the header
          // stay on "New Prompt Node" even after commit.
          const headerTitle = promptEl.parentElement
            ?.parentElement
            ?.parentElement
            ?.querySelector<HTMLElement>('.df-node-title')
          if (headerTitle && newPromptValue.trim()) {
            headerTitle.textContent = 'Prompt'
          } else if (headerTitle) {
            headerTitle.textContent = 'New Prompt Node'
          }
        } else {
          rerenderDrawflowNode(nodeId)
        }
      }
      const commitEdit = () => finish(true)
      const handleEditorPointerDown = (pointerEvent: PointerEvent) => {
        const pointerTarget = pointerEvent.target
        if (pointerTarget instanceof Node && textarea.contains(pointerTarget)) return
        finish(true)
      }
      const stopEditorEvent = (editorEvent: Event) => {
        editorEvent.stopPropagation()
      }
      const handleEditorKeyDown = (keyboardEvent: KeyboardEvent) => {
        keyboardEvent.stopPropagation()
        if (keyboardEvent.key === 'Escape') {
          keyboardEvent.preventDefault()
          finish(false)
          return
        }
        if (keyboardEvent.key === 'Enter' && (keyboardEvent.ctrlKey || keyboardEvent.metaKey)) {
          keyboardEvent.preventDefault()
          finish(true)
        }
      }

      promptEl.classList.remove('df-node-prompt-empty')
      promptEl.classList.add('editing')
      promptEl.textContent = ''
      promptEl.appendChild(textarea)

      textarea.addEventListener('input', resize)
      textarea.addEventListener('blur', commitEdit)
      textarea.addEventListener('keydown', handleEditorKeyDown)
      textarea.addEventListener('mousedown', stopEditorEvent)
      textarea.addEventListener('click', stopEditorEvent)
      textarea.addEventListener('dblclick', stopEditorEvent)
      document.addEventListener('pointerdown', handleEditorPointerDown, true)

      requestAnimationFrame(() => {
        textarea.focus()
        textarea.selectionStart = textarea.value.length
        textarea.selectionEnd = textarea.value.length
        resize()
      })
    }
    const handleImageNodeUpload = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      if (target.closest('.df-node-pill-trigger, .df-hover-btn, button, input, textarea, select, .input, .output')) return

      const uploadTarget = target.closest<HTMLElement>('[data-image-upload-target="true"]')
      const nodeEl = (uploadTarget || target).closest<HTMLElement>('.df-node[data-workflow-node-id][data-node-type="image"]')
      const nodeId = nodeEl?.dataset.workflowNodeId
      if (!nodeId) return

      const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
      if (!node || node.type !== 'image') return

      event.preventDefault()
      event.stopPropagation()
      closeNodePillMenu()
      setSelectedNode(nodeId)

      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*,video/*'
      input.style.display = 'none'

      const cleanup = () => {
        input.remove()
      }

      input.addEventListener('change', () => {
        const file = input.files?.[0]
        const fileMediaType: MediaNodeType | null = file?.type.startsWith('video/')
          ? 'video'
          : file?.type.startsWith('image/')
            ? 'image'
            : null
        if (!file || !fileMediaType) {
          cleanup()
          return
        }

        const reader = new FileReader()
        reader.onload = () => {
          const imageData = typeof reader.result === 'string' ? reader.result : ''
          if (!imageData) {
            cleanup()
            return
          }

          // [AssetStore] Save the raw file Blob into IndexedDB in
          // parallel with the legacy FileReader.readAsDataURL flow.
          // Renderer prefers `data.assetId` / `data.posterAssetId`
          // over the data URL; failure here leaves the legacy path
          // intact so the upload preview still appears in-session.
          const writeAssetIdAndPosterId = async (nextAssetId?: string, nextPosterAssetId?: string) => {
            const patch: Record<string, unknown> = {}
            if (nextAssetId) patch.assetId = nextAssetId
            if (nextPosterAssetId) patch.posterAssetId = nextPosterAssetId
            if (Object.keys(patch).length === 0) return
            try {
              const currentNode = workflowRef.current.nodes.find((n) => n.id === nodeId)
              if (!currentNode) return
              updateNode(nodeId, patch as Partial<FlowNodeData>)
              void currentNode
            } catch {
              // Persistence is best-effort; render path already
              // handles a missing assetId via legacy fallbacks.
            }
          }

          const persistUploadedAsset = (): void => {
            try {
              const meta: AssetMeta = {
                kind: fileMediaType === 'video' ? 'video' : 'image',
                source: 'upload',
                fileName: file.name,
                mimeType: file.type,
                width: undefined,
                height: undefined
              }
              const metaWithDims = (w: number | undefined, h: number | undefined, dur?: number): AssetMeta =>
                ({ ...meta, width: w, height: h, duration: dur })
              if (fileMediaType === 'video') {
                const videoMeta = metaWithDims(undefined, undefined)
                saveAssetFromFile(file, videoMeta).then((rec) => writeAssetIdAndPosterId(rec.id, undefined)).catch((err) => {
                  // [AssetStore] Persisted-asset failures must surface so the operator can
                  // diagnose why a reload loses the upload. Silent failure would
                  // regress the runtime-only fallback to a hidden bug.
                  // eslint-disable-next-line no-console
                  console.warn('[AssetStore] saveAssetFromFile failed', { kind: 'video', message: err instanceof Error ? err.message : String(err) })
                })
              }
              // Image asset dimensions resolve once decode completes.
              const uploadedImage = document.createElement('img')
              uploadedImage.onload = () => {
                const w = uploadedImage.naturalWidth || undefined
                const h = uploadedImage.naturalHeight || undefined
                if (fileMediaType === 'image') {
                  saveAssetFromFile(file, metaWithDims(w, h))
                    .then((rec) => writeAssetIdAndPosterId(rec.id, undefined))
                    .catch((err) => {
                      // eslint-disable-next-line no-console
                      console.warn('[AssetStore] saveAssetFromFile failed', { kind: 'image', message: err instanceof Error ? err.message : String(err) })
                    })
                }
              }
              uploadedImage.onerror = () => { /* ignore decode failures — render path falls back */ }
              uploadedImage.src = imageData
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn('[AssetStore] persistUploadedAsset threw', err instanceof Error ? err.message : String(err))
            }
          }

          const finishUpload = (width?: number, height?: number, poster?: string, duration?: number) => {
            const aspectRatio = width && height ? closestImageAspectRatio(width, height) : fileMediaType === 'video' ? '16:9' : '1:1'
            // [WorkflowMediaFileCard] Persist the original byte size
            // so the card footer can show KB / MB after a reload
            // (the legacy base64 fallback only knew length, not the
            // raw blob size). `size` is already on
            // SAFE_MEDIA_METADATA_KEYS, so it round-trips through the
            // importer; `mediaSize` is the per-node handle for the
            // card reader and only needs to live in the live store.
            const fileSize = Number.isFinite(file.size) ? file.size : 0
            const durationSeconds = Number.isFinite(duration) && (duration as number) > 0 ? (duration as number) : undefined
            const basePatch: Record<string, unknown> = {
              mediaType: fileMediaType,
              mediaData: imageData,
              mediaUrl: '',
              mediaName: file.name,
              mediaMimeType: file.type,
              mediaWidth: width,
              mediaHeight: height,
              mediaSize: fileSize,
              size: fileSize,
              mediaPoster: fileMediaType === 'video' ? poster || '' : '',
              ...(durationSeconds !== undefined ? { mediaDuration: durationSeconds } : {}),
              aspectRatio
            }

            const nextPatch = {
              ...basePatch,
              imageData: fileMediaType === 'image' ? imageData : '',
              imageUrl: '',
              imageName: fileMediaType === 'image' ? file.name : '',
              imageWidth: fileMediaType === 'image' ? width : undefined,
              imageHeight: fileMediaType === 'image' ? height : undefined,
              videoData: fileMediaType === 'video' ? imageData : '',
              videoUrl: '',
              videoName: fileMediaType === 'video' ? file.name : '',
              videoWidth: fileMediaType === 'video' ? width : undefined,
              videoHeight: fileMediaType === 'video' ? height : undefined,
              videoPoster: fileMediaType === 'video' ? poster || '' : '',
              duration: durationSeconds
            } as Partial<FlowNodeData>
            const nextNode = { ...node, data: { ...node.data, ...nextPatch } as FlowNodeData }
            const staleEdgeIds = unlinkIncompatibleConnectionsForNode(nodeId, nextNode)
            updateNodeAndRemoveEdges(nodeId, nextPatch, staleEdgeIds)
            scheduleDrawflowConnectionRefresh(nodeId)
            cleanup()

            // [AssetStore] Once the data URL is committed to
            // node.data, kick off the IndexedDB save. We do not
            // block the render flow — the assetId is added on top
            // of the existing fields when the save resolves.
            persistUploadedAsset()
            if (fileMediaType === 'video' && poster) {
              // Save the captured poster as its own asset record so
              // the video Media-node can resolve a poster without
              // decoding the full video blob every render.
              try {
                void (async () => {
                  const blob = await (await fetch(poster)).blob()
                  saveAssetFromBlob(blob, { kind: 'poster', source: 'upload', mimeType: blob.type || 'image/jpeg' })
                    .then((rec) => writeAssetIdAndPosterId(undefined, rec.id))
                    .catch((err) => {
                      // eslint-disable-next-line no-console
                      console.warn('[AssetStore] saveAssetFromBlob(poster) failed', err instanceof Error ? err.message : String(err))
                    })
                })()
              } catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[AssetStore] poster blob conversion failed', err instanceof Error ? err.message : String(err))
              }
            }
          }

          if (fileMediaType === 'video') {
            captureVideoPoster(imageData)
              .then(({ width, height, duration, poster }) => finishUpload(width, height, poster, duration))
              .catch(() => finishUpload())
            return
          }

          const uploadedImage = document.createElement('img')
          uploadedImage.onload = () => {
            finishUpload(uploadedImage.naturalWidth, uploadedImage.naturalHeight)
          }
          uploadedImage.onerror = () => finishUpload()
          uploadedImage.src = imageData
        }
        reader.onerror = cleanup
        reader.readAsDataURL(file)
      }, { once: true })

      document.body.appendChild(input)
      input.click()
    }
    const stopNodePillDragStart = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.df-node-pill-trigger, .df-hover-btn, .df-node-toggle, .df-node-prompt-editor, .df-node-image-preview-button')) return
      event.stopPropagation()
    }
    const handleNodePillClick = (event: MouseEvent) => {
      const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>('.df-node-pill-trigger')
      if (!trigger) return

      event.preventDefault()
      event.stopPropagation()

      const nodeEl = trigger.closest<HTMLElement>('.df-node[data-workflow-node-id]')
      const nodeId = nodeEl?.dataset.workflowNodeId
      const field = trigger.dataset.nodeField as NodePillField | undefined
      if (!nodeId || !field) return
      const currentNode = workflowRef.current.nodes.find((item) => item.id === nodeId)
      const currentData = currentNode?.type === 'generate'
        ? {
            ...(currentNode.data as Record<string, unknown>),
            ...sanitizeGenerateDataPatch(currentNode.data as Record<string, unknown>, {})
          }
        : ((currentNode?.data || {}) as Record<string, unknown>)
      const options = getPillOptions(field, currentData)
      if (options.length === 0) return
      const value = field === 'mediaType'
        ? getGenerateMediaType(currentData)
        : field === 'model'
          ? String(currentData.model || options[0]?.value || '')
          : field === 'videoDuration'
            ? String(currentData.videoDuration || options[0]?.value || '')
            : field === 'aspectRatio'
              ? String(currentData.aspectRatio || options[0]?.value || '')
              : String(currentData.provider || trigger.dataset.nodeValue || '')

      setSelectedNode(nodeId)
      setNodePillMenu((current) => (
        current?.nodeId === nodeId && current.field === field
          ? null
          : {
              nodeId,
              field,
              value,
              trigger,
              options
            }
      ))
    }
    const handleNodeToolbarClick = (event: MouseEvent) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.df-hover-btn[data-node-action]')
      if (!button) return

      event.preventDefault()
      event.stopPropagation()

      const nodeEl = button.closest<HTMLElement>('.df-node[data-workflow-node-id]')
      const nodeId = nodeEl?.dataset.workflowNodeId
      if (!nodeId) return

      const action = button.dataset.nodeAction
      setSelectedNode(nodeId)
      const targetNode = workflowRef.current.nodes.find((item) => item.id === nodeId)
      if (action === 'delete') {
        closeNodePillMenu()
        deleteNode(nodeId)
        setInspectorNodeId((current) => (current === nodeId ? null : current))
      } else if (action === 'duplicate') {
        closeNodePillMenu()
        duplicateNodeWithInputs(nodeId)
      } else if (action === 'run') {
        closeNodePillMenu()
        // [WorkflowMediaFileCard] Media nodes are source data — they
        // never need to be re-run in isolation. Show a friendly
        // toast instead of silently no-op'ing. The toolbar already
        // hides the Run button for Media nodes; this branch only
        // runs if some legacy node or stale hook sends the action
        // here, so the visual hint is what matters.
        if (targetNode?.type === 'image') {
          flashTemplateToast('warning', 'Media node doesn\u2019t run on its own — just connect it to a Generate node.')
          return
        }
        void runGenerateNodeWithInputs(nodeId).catch((error) => {
          window.alert(error instanceof Error ? error.message : 'Unable to run node.')
        })
      } else if (action === 'settings') {
        closeNodePillMenu()
        setInspectorNodeId(nodeId)
      } else if (action === 'expand-media') {
        closeNodePillMenu()
        // [WorkflowMediaFileCard] Open the same lightbox the
        // preview-image button does, but driven from the toolbar so
        // the user can also reach it when the card preview hasn't
        // loaded yet (remote URL, blob not yet decoded, etc.).
        if (!targetNode || targetNode.type !== 'image') return
        const data = (targetNode.data || {}) as Record<string, unknown>
        const mediaSrc = getMediaNodeSource(data)
        if (!mediaSrc) {
          flashTemplateToast('warning', 'No media to expand yet — upload an image or video first.')
          return
        }
        const mediaType = getMediaNodeType(data)
        const name = String(data.mediaName || data.videoName || data.imageName || data.label || 'Media')
        setImagePreview({
          src: mediaSrc,
          name,
          mediaType,
          metadata: buildPreviewMetadata([data], mediaType),
          zoom: 100,
        })
      }
    }
    const handleNodeToggleClick = (event: MouseEvent) => {
      const button = (event.target as HTMLElement | null)
        ?.closest<HTMLButtonElement>('.df-node-toggle')
      if (!button) return

      event.preventDefault()
      event.stopPropagation()

      const nodeEl = button.closest<HTMLElement>('.df-node[data-workflow-node-id]')
      const nodeId = nodeEl?.dataset.workflowNodeId
      if (!nodeId) return

      const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
      if (!node) return

      const isEnabled = (node.data as Record<string, unknown>).enabled !== false
      const nextEnabled = !isEnabled
      const nextLabel = nextEnabled ? 'Disable node' : 'Enable node'

      closeNodePillMenu()
      updateNode(nodeId, { enabled: nextEnabled } as Partial<FlowNodeData>)

      nodeEl.classList.toggle('df-node-disabled', !nextEnabled)
      nodeEl.dataset.enabled = String(nextEnabled)
      nodeEl.querySelectorAll<HTMLButtonElement>('.df-node-toggle').forEach((toggle) => {
        toggle.classList.toggle('on', nextEnabled)
        toggle.classList.toggle('off', !nextEnabled)
        toggle.title = nextLabel
        toggle.setAttribute('aria-label', nextLabel)
      })

      requestAnimationFrame(() => {
        rerenderDrawflowNode(nodeId)
        syncSelectedNodeDom()
      })
    }
    const handleImagePreviewClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const button = target?.closest<HTMLButtonElement>('.df-node-image-preview-button[data-node-action="preview-image"]')
      if (!button) return

      event.preventDefault()
      event.stopPropagation()

      const nodeEl = button.closest<HTMLElement>('.df-node[data-workflow-node-id]')
      const nodeId = nodeEl?.dataset.workflowNodeId
      if (!nodeId) return

      const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
      const data = (node?.data || {}) as Record<string, unknown>
      let mediaSrc = ''
      let mediaType: MediaNodeType = 'image'
      let name = String(data.mediaName || data.videoName || data.imageName || data.label || 'Media')

      if (node?.type === 'image') {
        mediaSrc = getMediaNodeSource(data)
        mediaType = getMediaNodeType(data)
      } else if (node?.type === 'generate') {
        const output = data._output as Record<string, unknown> | undefined
        const outputUrls = getGenerateOutputImageUrls(output)
        // Read `selectedOutputIndex` from the live node data, not
        // from the rendered DOM attribute — the user may have cycled
        // the carousel since the last render.
        const liveIndex = Math.max(0, Math.min(outputUrls.length - 1, Number(data.selectedOutputIndex) || 0))
        mediaSrc = outputUrls[liveIndex] || outputUrls[0] || ''
        // Build rich per-output items so the lightbox can flip URLs
        // AND keep the correct filename for each one. We do NOT
        // mutate `data.selectedOutputIndex` here — that only changes
        // when the user explicitly cycles the carousel via the node
        // bar / lightbox controls / click handlers.
        const outputItems = buildGenerateOutputItems(output, outputUrls)
        const initialItem = outputItems[liveIndex] || outputItems[0]
        const initialDownloadFilename = resolveGenerateOutputFilename(initialItem, liveIndex)
        // Pick the media type from the rich output item. Without
        // this branch the lightbox would always render `<img>` and
        // silently fail for video outputs (Generate-node produces a
        // valid video URL but `mediaType` was hard-coded to 'image').
        const initialMediaType: MediaNodeType =
          initialItem?.mediaType === 'video' ? 'video' : 'image'
        mediaType = initialMediaType
        name = String(data.label || 'Generated output')
        if (outputUrls.length > 0 && mediaSrc) {
          const previewGenerateData = { ...data, ...sanitizeGenerateDataPatch(data, {}) }
          const baseMetadata = buildPreviewMetadata([previewGenerateData, output], initialMediaType)
          closeNodePillMenu()
          setSelectedNode(nodeId)
          setImagePreview({
            src: mediaSrc,
            name: initialItem?.name || name,
            mediaType: initialMediaType,
            outputItems,
            selectedIndex: liveIndex,
            outputName: initialItem?.name,
            downloadFilename: initialDownloadFilename,
            baseMetadata,
            metadata: { ...baseMetadata, ...(initialItem?.metadata || {}) },
            zoom: 100,
          })
          return
        }
      }

      if (!node || !mediaSrc) return

      closeNodePillMenu()
      setSelectedNode(nodeId)
      setImagePreview({
        src: mediaSrc,
        name,
        mediaType,
        metadata: buildPreviewMetadata([data], mediaType),
        zoom: 100,
      })
    }
    const handleMediaRemoveClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const button = target?.closest<HTMLButtonElement>('.workflow-media-file-remove[data-node-action="remove-media"]')
      if (!button) return

      event.preventDefault()
      event.stopPropagation()

      const nodeEl = button.closest<HTMLElement>('.df-node[data-workflow-node-id]')
      const nodeId = nodeEl?.dataset.workflowNodeId
      if (!nodeId) return

      const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
      if (!node || node.type !== 'image') return

      const data = (node.data || {}) as Record<string, unknown>
      // [WorkflowMediaFileCard] Reset the Media node to its default
      // (no asset, no source URL, no data URL, no poster, no metadata).
      // Keep the human label and the enable/disable state the user
      // already chose — only the media asset fields are cleared.
      // `enabled` is preserved because the user explicitly toggled it;
      // we never want a single click to also disable the node.
      const preservedLabel = typeof data.label === 'string' ? data.label : node.data?.label
      const preservedEnabled = data.enabled !== false
      const defaults = coerceNodeData('image', {})
      // [WorkflowMediaFileCard] `updateNode` in the store MERGES via
      // `{ ...n.data, ...data }` — so leaving a field out of the patch
      // keeps the old value. We MUST explicitly null out every asset
      // field the renderer / `getMediaNodeSource` reads back, otherwise
      // the previous image stays rendered and the click appears to do
      // nothing. `undefined` keeps the patch Partial-shaped; the
      // downstream readers (`String(...) || ''`) treat it as empty.
      const cleared: Record<string, unknown> = {
        // generic media fields
        mediaUrl: undefined,
        mediaData: undefined,
        mediaName: undefined,
        mediaPoster: undefined,
        mediaType: undefined,
        mediaAssetId: undefined,
        mediaSize: undefined,
        mediaWidth: undefined,
        mediaHeight: undefined,
        mediaDuration: undefined,
        // image-specific
        imageUrl: undefined,
        imageData: undefined,
        imageAssetId: undefined,
        imageName: undefined,
        imageWidth: undefined,
        imageHeight: undefined,
        // video-specific
        videoUrl: undefined,
        videoData: undefined,
        videoPoster: undefined,
        videoName: undefined,
        videoWidth: undefined,
        videoHeight: undefined,
        // shared asset id + metadata
        assetId: undefined,
        posterAssetId: undefined,
        thumbnailAssetId: undefined,
        size: undefined,
        width: undefined,
        height: undefined,
        duration: undefined,
        mimeType: undefined,
        // generic file aliases the renderer fallbacks read
        fileName: undefined
      }
      const nextData = {
        ...cleared,
        ...defaults,
        label: typeof preservedLabel === 'string' ? preservedLabel : defaults.label,
        enabled: preservedEnabled
      } as Partial<WorkflowNode['data']>

      closeNodePillMenu()
      // Clear any cached downstream preview pointing at this node.
      setSelectedNode(nodeId)
      updateNode(nodeId, nextData)
      // Re-paint the DOM so the empty state (drop area) is visible
      // immediately, without waiting for a drawflow `updateNode`
      // reconciliation pass.
      requestAnimationFrame(() => {
        rerenderDrawflowNode(nodeId)
        syncSelectedNodeDom()
      })
    }
    const handleOutputCarouselClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const button = target?.closest<HTMLButtonElement>(
        '.df-node-output-carousel-prev[data-node-action="output-prev"], .df-node-output-carousel-next[data-node-action="output-next"]'
      )
      if (!button) return

      event.preventDefault()
      event.stopPropagation()

      const nodeEl = button.closest<HTMLElement>('.df-node[data-workflow-node-id]')
      const nodeId = nodeEl?.dataset.workflowNodeId
      if (!nodeId) return

      const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
      if (!node || node.type !== 'generate') return

      const data = (node.data || {}) as Record<string, unknown>
      const output = data._output as Record<string, unknown> | undefined
      const outputImageUrls = getGenerateOutputImageUrls(output)
      if (outputImageUrls.length <= 1) return

      const currentIndex = Math.max(
        0,
        Math.min(outputImageUrls.length - 1, Number(data.selectedOutputIndex) || 0)
      )
      const direction = button.dataset.nodeAction === 'output-next' ? 1 : -1
      const nextIndex = (currentIndex + direction + outputImageUrls.length) % outputImageUrls.length

      setSelectedNode(nodeId)
      updateNode(nodeId, { selectedOutputIndex: nextIndex } as Partial<FlowNodeData>)
      // Mirror the new selection into `nodeOutputs` so the runner's
      // live `context[edge.source]` reflects the user's choice. The
      // runner reads `value.selectedOutputIndex` first, then falls
      // back to `sourceNode.data.selectedOutputIndex`; mirroring into
      // the live context covers both the next-run and any in-flight
      // reader. We also keep the existing `_output` shape so the
      // rest of the Generate node's contract stays intact.
      if (output && typeof output === 'object') {
        setNodeOutputs((prev) => ({
          ...prev,
          [nodeId]: { ...(prev[nodeId] as Record<string, unknown> | undefined), selectedOutputIndex: nextIndex },
        }))
      }
      // Re-render this node's DOM so the carousel counter / img src
      // reflect the new selection without waiting for a workflow
      // re-run.
      requestAnimationFrame(() => {
        const domNode = document.querySelector(`[data-workflow-node-id="${CSS.escape(nodeId)}"]`)
        if (!domNode) return
        const refreshed = workflowRef.current.nodes.find((item) => item.id === nodeId)
        if (!refreshed) return
        const updatedNode = {
          ...refreshed,
          data: { ...refreshed.data, selectedOutputIndex: nextIndex },
        }
        const content = domNode.closest('.drawflow_content_node') || domNode.parentElement
        if (content) {
          content.innerHTML = renderDrawflowNode(updatedNode)
          applyPortAttributesForNode(updatedNode)
        }
      })
    }
    const handleOutputDownloadClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const button = target?.closest<HTMLButtonElement>(
        '.df-node-output-carousel-download[data-node-action="output-download"]'
      )
      if (!button) return

      event.preventDefault()
      event.stopPropagation()

      const nodeEl = button.closest<HTMLElement>('.df-node[data-workflow-node-id]')
      const nodeId = nodeEl?.dataset.workflowNodeId
      if (!nodeId) return

      const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
      if (!node || node.type !== 'generate') return

      const data = (node.data || {}) as Record<string, unknown>
      const output = data._output as Record<string, unknown> | undefined
      if (!output) return

      // Always resolve which asset the user is currently looking at
      // by reading `data.selectedOutputIndex` at click time. The
      // button's `data-output-index` attribute is a render-time
      // snapshot — we still use the live data so a click right after
      // a carousel wrap-around still hits the correct asset.
      const outputImageUrls = getGenerateOutputImageUrls(output)
      if (outputImageUrls.length === 0) return
      const selectedOutputIndex = Math.max(
        0,
        Math.min(outputImageUrls.length - 1, Number(data.selectedOutputIndex) || 0)
      )

      // Prefer the rich `outputs[]` asset descriptor so we keep the
      // saved filename and mimeType that auto-download produced. Fall
      // back to `imageUrls[]` for bundles that pre-date the
      // `outputs[]` enrichment.
      const outputs = Array.isArray(output.outputs)
        ? (output.outputs as unknown[]).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
        : []
      const asset = outputs[selectedOutputIndex] || {}
      const assetUrl =
        (typeof asset.url === 'string' && asset.url) ||
        (typeof asset.mediaUrl === 'string' && asset.mediaUrl) ||
        (typeof asset.imageUrl === 'string' && asset.imageUrl) ||
        (typeof asset.thumbnailUrl === 'string' && asset.thumbnailUrl) ||
        outputImageUrls[selectedOutputIndex] ||
        outputImageUrls[0] ||
        ''
      if (!assetUrl) return

      // Build a sane filename. If the asset was already saved locally
      // (`savedFilename`) we use its basename so the user gets a
      // familiar name; otherwise we synthesize one from the index.
      const savedName =
        (typeof asset.savedFilename === 'string' && asset.savedFilename) ||
        (typeof asset.fileNameFromFlow === 'string' && asset.fileNameFromFlow) ||
        (typeof asset.name === 'string' && asset.name) ||
        ''
      const baseNameRaw = savedName
        ? savedName.split(/[\\/]/).pop() || savedName
        : `flow-output-${selectedOutputIndex + 1}.${(typeof asset.mediaType === 'string' && asset.mediaType === 'video') || (typeof asset.type === 'string' && asset.type === 'video') ? 'mp4' : 'png'}`
      const baseName = baseNameRaw.replace(/\.(png|jpg|jpeg|webp|mp4|mov|webm|gif)$/i, '')
      const isVideo =
        assetUrl.includes('.mp4') ||
        assetUrl.includes('video') ||
        (typeof asset.mediaType === 'string' && asset.mediaType === 'video') ||
        (typeof asset.type === 'string' && asset.type === 'video')
      const suggestedFilename = `${baseName}.${isVideo ? 'mp4' : 'png'}`

      // Resolve a download URL — never use the local savedFilename
      // as a URL (file:// is blocked from extension origins in MV3).
      const downloadUrl = assetUrl

      // Kick off the download through the SW so `chrome.downloads`
      // only has to exist in one place. We never call it directly
      // from the UI because some UI contexts (devtools, isolated
      // sidepanel sub-frames, etc.) don't bind `chrome.downloads`,
      // and the SW owns the canonical download path for the
      // extension.
      downloadWorkflowOutputAsset({
        url: downloadUrl,
        filename: suggestedFilename,
        nodeId,
        selectedOutputIndex,
      }).then((result) => {
        if (result.ok) {
          console.log('[Workflow][OutputDownload] download started', {
            nodeId,
            selectedOutputIndex,
            filename: suggestedFilename,
            path: result.path,
          })
        } else {
          console.warn('[Workflow][OutputDownload] failed', {
            nodeId,
            selectedOutputIndex,
            reason: result.reason,
            url: downloadUrl,
            filename: suggestedFilename,
          })
        }
      })
    }
    const preventNativeMediaDrag = (event: DragEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('.df-node-preview-media, .df-node-preview-image, .df-node-image-upload-target')) return

      event.preventDefault()
      event.stopPropagation()
    }
    // Delegated `load` listener for the Generate-node preview media.
    // When an <img class="df-node-preview-media"> finishes decoding,
    // we tag it `df-node-preview-media-loaded` so the CSS skeleton
    // fades out (sits behind the image). Capture-phase on the canvas
    // root so newly-rendered nodes get the listener without us
    // re-binding after every renderDrawflowNode.
    const handlePreviewMediaLoaded = (event: Event) => {
      const target = event.target as Element | null
      if (!target || target.tagName !== 'IMG') return
      if (!target.classList.contains('df-node-preview-media')) return
      target.classList.add('df-node-preview-media-loaded')
    }
    const handlePreviewMediaError = (event: Event) => {
      const target = event.target as Element | null
      if (!target || target.tagName !== 'IMG') return
      if (!target.classList.contains('df-node-preview-media')) return
      // Mark loaded anyway so the skeleton fades — the broken-image
      // icon is preferable to a permanent placeholder behind a
      // never-resolving image element.
      target.classList.add('df-node-preview-media-loaded')
    }
    const zoomOnWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.aiflow-node-picker, input, textarea, select')) return
      if (event.ctrlKey) {
        refreshZoom()
        scheduleConnectionSync()
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const rect = canvasEl.getBoundingClientRect()
      const step = Math.max(editor.zoom_value || 0.1, 0.08)
      const direction = event.deltaY < 0 ? 1 : -1
      applyCanvasZoom(editor.zoom + direction * step, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      })
    }
    canvasEl.addEventListener('mousemove', syncOnPointerMove)
    canvasEl.addEventListener('pointermove', syncOnPointerMove)
    canvasEl.addEventListener('touchmove', syncOnPointerMove)
    canvasEl.addEventListener('mousedown', rememberCanvasPointer)
    canvasEl.addEventListener('touchstart', rememberCanvasPointer)
    canvasEl.addEventListener('mousedown', handleBidirectionalPortMouseDown, true)
    canvasEl.addEventListener('mousedown', handleSelectionMouseDown, true)
    canvasEl.addEventListener('mousedown', stopNodePillDragStart, true)
    document.addEventListener('mousedown', handleDocumentSelectionMouseDown, true)
    canvasEl.addEventListener('pointerdown', handleViewportPanPointerDown, true)
    canvasEl.addEventListener('dblclick', handlePromptInlineEdit)
    canvasEl.addEventListener('dblclick', handleImageNodeUpload)
    canvasEl.addEventListener('click', handleNodePillClick)
    canvasEl.addEventListener('click', handleNodeToolbarClick)
    canvasEl.addEventListener('click', handleNodeToggleClick)
    canvasEl.addEventListener('click', handleImagePreviewClick)
    canvasEl.addEventListener('click', handleMediaRemoveClick)
    canvasEl.addEventListener('click', handleOutputCarouselClick)
    canvasEl.addEventListener('click', handleOutputDownloadClick)
    canvasEl.addEventListener('load', handlePreviewMediaLoaded, true)
    canvasEl.addEventListener('error', handlePreviewMediaError, true)
    canvasEl.addEventListener('dragstart', preventNativeMediaDrag, true)
    canvasEl.addEventListener('wheel', zoomOnWheel, { passive: false })

    editorRef.current = editor
    hydrateDrawflow()

    return () => {
      if (connectionSyncFrameRef.current !== null) {
        cancelAnimationFrame(connectionSyncFrameRef.current)
        connectionSyncFrameRef.current = null
      }
      if (connectionRefreshFrameRef.current !== null) {
        cancelAnimationFrame(connectionRefreshFrameRef.current)
        connectionRefreshFrameRef.current = null
      }
      // [GroupDrag][mirror] Cancel any in-flight mirror rAF and
      // detach document-level mouse listeners registered by
      // `attachMultiDragMirrorListeners`. We do NOT commit the
      // pending positions here — an unmount mid-drag means the
      // workflow tab is going away, so writing positions to the
      // store would corrupt the user's view of the workflow when
      // they reopen the editor. Pending positions are simply
      // dropped; the next mount rehydrates from the store, which
      // still holds the pre-drag positions.
      if (multiDragFrameRef.current !== null) {
        cancelAnimationFrame(multiDragFrameRef.current)
        multiDragFrameRef.current = null
      }
      if (multiDragRef.current) {
        groupDragMirrorLog('mirrorCleanupOnUnmount', {
          grabbedId: multiDragRef.current.grabbedId,
          moved: multiDragRef.current.moved,
          pendingCount: pendingDragPositionsRef.current.size
        })
      }
      detachMultiDragMirrorListeners()
      multiDragRef.current = null
      pendingDragPositionsRef.current.clear()
      // Legacy group-drag frame cancel.
      if (groupDragRef.current.frame !== null) {
        cancelAnimationFrame(groupDragRef.current.frame)
        groupDragRef.current.frame = null
      }
      groupDragRef.current.active = false
      disconnectNodeResizeObservers()
      canvasEl.removeEventListener('mousemove', syncOnPointerMove)
      canvasEl.removeEventListener('pointermove', syncOnPointerMove)
      canvasEl.removeEventListener('touchmove', syncOnPointerMove)
      canvasEl.removeEventListener('mousedown', rememberCanvasPointer)
      canvasEl.removeEventListener('touchstart', rememberCanvasPointer)
      canvasEl.removeEventListener('mousedown', handleBidirectionalPortMouseDown, true)
      canvasEl.removeEventListener('mousedown', handleSelectionMouseDown, true)
      canvasEl.removeEventListener('mousedown', stopNodePillDragStart, true)
      document.removeEventListener('mousedown', handleDocumentSelectionMouseDown, true)
      canvasEl.removeEventListener('pointerdown', handleViewportPanPointerDown, true)
      canvasEl.removeEventListener('dblclick', handlePromptInlineEdit)
      canvasEl.removeEventListener('dblclick', handleImageNodeUpload)
      canvasEl.removeEventListener('click', handleNodePillClick)
      canvasEl.removeEventListener('click', handleNodeToolbarClick)
      canvasEl.removeEventListener('click', handleNodeToggleClick)
      canvasEl.removeEventListener('click', handleImagePreviewClick)
      canvasEl.removeEventListener('click', handleMediaRemoveClick)
      canvasEl.removeEventListener('dragstart', preventNativeMediaDrag, true)
      canvasEl.removeEventListener('load', handlePreviewMediaLoaded, true)
      canvasEl.removeEventListener('error', handlePreviewMediaError, true)
      canvasEl.removeEventListener('wheel', zoomOnWheel)
      editorRef.current = null
      portDragCleanupRef.current?.()
      canvasEl.replaceChildren()
    }
  }, [addEdgeToStore, deleteEdge, deleteNode, setSelectedNode, updateNode, updateNodeAndRemoveEdges, updateNodePosition])

  useEffect(() => {
    hydrateDrawflow()
  }, [structureSignature])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    // [CanvasInvestigate] probe — fires every time the data
    // signature effect re-renders all node HTML. Pair with
    // [hydrateDrawflow] and the per-frame [nodeMoved] count. If
    // this fires during a drag, it means the data signature
    // changed during the drag — which it shouldn't, because
    // position alone should not change data.
    canvasLog('dataSignatureEffect', {
      canvasDragInFlight: !!canvasDragInFlightRef.current.nodeId,
      dragNodeId: canvasDragInFlightRef.current.nodeId,
      nodeCount: workflow.nodes.length,
    })

    for (const node of workflow.nodes) {
      try {
        editor.updateNodeDataFromId(node.id, cloneDeep(node.data))
        const content = canvasRef.current?.querySelector(`#node-${CSS.escape(node.id)} .drawflow_content_node`)
        if (content) content.innerHTML = renderDrawflowNode(node)
        applyPortAttributesForNode(node)
        attachNodeResizeObserver(node.id)
        scheduleDrawflowConnectionRefresh(node.id)
      } catch {
        // Node may not be mounted yet; the structural hydrate will catch it.
      }
    }
    requestAnimationFrame(() => {
      syncNodeRunStates()
      syncActiveEdges()
    })
  }, [dataSignature, workflow.nodes])

  // [CanvasFix] Hotfix for canvas drag flicker (round 2 — undo/redo).
  //
  // Mirrors position changes from the workflow store into
  // Drawflow DOM via `applyDrawflowNodePosition`. Replaces the
  // round-1 behavior where adding `position` to the structural
  // signature caused full canvas re-import mid-drag.
  //
  // During an in-flight drag, `pendingDragPositionsRef` already
  // matches the live DOM (Drawflow moves the element directly),
  // and the eventual `mouseUp` commit updates `lastAppliedPositionsRef`
  // for each committed node. We therefore skip the effect while
  // a drag is in flight — if we didn't, the round-1 flicker
  // bug would re-emerge every time the user crossed a Math.round
  // boundary during a drawflow tick.
  useEffect(() => {
    if (!editorRef.current) return
    const isDragging = !!canvasDragInFlightRef.current.nodeId
    const groupDragActive = groupDragRef.current.active
    const multiDragActive = !!multiDragRef.current
    // [GroupDrag] positionSignatureEffect probe was removed.
    if (canvasDragInFlightRef.current.nodeId || multiDragActive) {
      canvasLog('positionUndoRedoSyncSkippedDuringDrag', {
        positionSignature,
        activeNodeId: canvasDragInFlightRef.current.nodeId,
        multiDragActive
      })
      return
    }

    const changed: WorkflowNode[] = []
    for (const node of workflow.nodes) {
      const prev = lastAppliedPositionsRef.current.get(node.id)
      const next = node.position
      if (!prev ||
          Math.round(prev.x) !== Math.round(next.x) ||
          Math.round(prev.y) !== Math.round(next.y)) {
        changed.push(node)
      }
    }

    if (changed.length === 0) return

    canvasLog('positionSignatureChanged', {
      changedCount: changed.length,
      isDragging: false,
      changedIds: changed.map((node) => node.id),
    })
    // [GroupDrag] positionSignatureEffect.changedDuringGroupDrag
    // probe was removed.

    for (const node of changed) {
      applyDrawflowNodePosition(node.id, node.position)
      canvasLog('applyNodePosition', {
        nodeId: node.id,
        from: lastAppliedPositionsRef.current.get(node.id) ?? null,
        to: node.position,
        reason: 'undo-redo-or-store-sync',
      })
      lastAppliedPositionsRef.current.set(node.id, node.position)
    }
  }, [positionSignature, workflow.nodes])

  useEffect(() => {
    syncSelectedNodeDom(selectedNodeId)
  }, [selectedNodeId])

  const copySelectedNode = () => {
    // [WorkflowMarquee] Multi-selection takes priority. If the user
    // has 2+ nodes selected via marquee or ctrl-click, copy the
    // entire selected set + the internal edges between them. We do
    // NOT use `buildWorkflowSliceForTarget` (which walks upstream
    // ancestors) because multi-selection is intentionally a flat
    // user-driven subset.
    const currentWorkflow = workflowRef.current
    if (!currentWorkflow) return false

    const multiIds = multiSelectedNodeIdsRef.current
    if (multiIds.size >= 2) {
      const selectedNodes = currentWorkflow.nodes.filter((node) => multiIds.has(node.id))
      if (selectedNodes.length === 0) return false

      const internalEdges = currentWorkflow.edges.filter(
        (edge) => multiIds.has(edge.source) && multiIds.has(edge.target)
      )

      // Anchor: prefer the store's selectedNodeId so paste lands
      // near the same screen position the user saw when they hit
      // copy. Fall back to the first node by canvas position so we
      // always have a deterministic anchor.
      const storeSelected = useWorkflowStore.getState().selectedNodeId
      const anchor =
        (storeSelected && selectedNodes.find((node) => node.id === storeSelected)) ||
        [...selectedNodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)[0]
      if (!anchor) return false

      copiedNodeGroupRef.current = {
        targetNodeId: anchor.id,
        nodes: selectedNodes.map((node) => cloneDeep(node)),
        edges: internalEdges.map((edge) => cloneDeep(edge))
      }
      return true
    }

    // Single-selection path (legacy). Walks upstream ancestors so
    // duplicating / pasting a Generate node carries its Media +
    // Prompt inputs.
    const nodeId = useWorkflowStore.getState().selectedNodeId
    if (!nodeId) return false

    const workflowSlice = buildWorkflowSliceForTarget(currentWorkflow, nodeId)
    if (!workflowSlice || workflowSlice.nodes.length === 0) return false

    copiedNodeGroupRef.current = {
      targetNodeId: nodeId,
      nodes: workflowSlice.nodes.map((node) => cloneDeep(node)),
      edges: workflowSlice.edges.map((edge) => cloneDeep(edge))
    }
    return true
  }

  const pasteCopiedNode = () => {
    const copiedGroup = copiedNodeGroupRef.current
    const currentWorkflow = workflowRef.current
    if (!copiedGroup || !currentWorkflow) return false

    const pointer = lastCanvasPointerRef.current || getCanvasCenterPoint()
    const copiedTarget = copiedGroup.nodes.find((node) => node.id === copiedGroup.targetNodeId) || copiedGroup.nodes[0]
    if (!copiedTarget) return false

    const offset = {
      x: pointer.x - copiedTarget.position.x,
      y: pointer.y - copiedTarget.position.y
    }
    const idMap = new Map<string, string>()
    for (const node of copiedGroup.nodes) {
      idMap.set(node.id, createId('node'))
    }

    const pastedNodes: WorkflowNode[] = copiedGroup.nodes.map((node) => ({
      ...cloneDeep(node),
      id: idMap.get(node.id) || createId('node'),
      position: {
        x: Math.max(0, Math.round(node.position.x + offset.x)),
        y: Math.max(0, Math.round(node.position.y + offset.y))
      },
      data: cloneDeep(node.data)
    }))

    const pastedEdges: WorkflowEdge[] = copiedGroup.edges
      .map((edge) => {
        const source = idMap.get(edge.source)
        const target = idMap.get(edge.target)
        if (!source || !target) return null
        return {
          ...cloneDeep(edge),
          id: createId('edge'),
          source,
          target
        } satisfies WorkflowEdge
      })
      .filter((edge): edge is WorkflowEdge => Boolean(edge))

    const pastedTargetId = idMap.get(copiedGroup.targetNodeId) || pastedNodes[0]?.id
    updateWorkflow(currentWorkflow.id, {
      nodes: [...currentWorkflow.nodes, ...pastedNodes],
      edges: [...currentWorkflow.edges, ...pastedEdges]
    })

    // Multi-select the pasted set so the user can immediately drag
    // them together, hit Delete, or Ctrl+C them again. For a
    // single-node paste, fall back to the legacy single-selection
    // behaviour so the inspector / hover toolbar continue to work.
    if (pastedNodes.length > 1) {
      const pastedIds = pastedNodes.map((node) => node.id)
      setMultiSelectedNodeIds(pastedIds)
      if (pastedTargetId) {
        setSelectedNode(pastedTargetId)
      }
      requestAnimationFrame(() => {
        pastedNodes.forEach((node) => attachNodeResizeObserver(node.id))
        scheduleDrawflowConnectionRefresh(null, { all: true })
        if (pastedTargetId) {
          syncSelectedNodeDom(pastedTargetId)
        }
      })
    } else if (pastedTargetId) {
      setSelectedNode(pastedTargetId)
      requestAnimationFrame(() => {
        pastedNodes.forEach((node) => attachNodeResizeObserver(node.id))
        scheduleDrawflowConnectionRefresh(null, { all: true })
        if (pastedTargetId) {
          syncSelectedNodeDom(pastedTargetId)
        }
      })
    }

    return true
  }

  useEffect(() => {
    const handleCanvasShortcut = (event: KeyboardEvent) => {
      // [GroupDrag][mirror] Escape during a mirror drag cancels the
      // gesture and restores every follower to its pre-drag position.
      // Runs BEFORE the marquee Escape branch so a mirror-drag
      // Escape takes precedence.
      if (event.key === 'Escape' && multiDragRef.current) {
        event.preventDefault()
        event.stopPropagation()
        finishMultiDragMirror(false)
        return
      }

      // Legacy group-drag Escape (single-node fallback path).
      if (event.key === 'Escape' && groupDragRef.current.active) {
        event.preventDefault()
        event.stopPropagation()
        cancelGroupDrag('Escape')
        return
      }

      // Skip when typing in any form field — Delete in a textarea
      // must not delete nodes, and Ctrl+C inside an input must not
      // copy the workflow selection.
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return

      // [WorkflowMarquee] Delete / Backspace: remove the entire
      // selection set (multi-selection or single). Guarded by
      // !ctrlKey so it doesn't intercept Ctrl+Backspace (browser
      // navigation in some platforms).
      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.ctrlKey && !event.metaKey) {
        if (deleteSelectedNodes()) {
          event.preventDefault()
          return
        }
      }

      if (!(event.ctrlKey || event.metaKey)) return

      const key = event.key.toLowerCase()
      if (key === 'c') {
        if (copySelectedNode()) event.preventDefault()
        return
      }

      if (key === 'v') {
        if (pasteCopiedNode()) event.preventDefault()
        return
      }

      if (key === 'z' && event.shiftKey) {
        event.preventDefault()
        if (useWorkflowStore.getState().canRedoWorkflow(workflow.id)) redoWorkflow(workflow.id)
        return
      }

      if (key === 'z') {
        event.preventDefault()
        if (useWorkflowStore.getState().canUndoWorkflow(workflow.id)) undoWorkflow(workflow.id)
        return
      }

      if (key === 'y') {
        event.preventDefault()
        if (useWorkflowStore.getState().canRedoWorkflow(workflow.id)) redoWorkflow(workflow.id)
      }
    }

    window.addEventListener('keydown', handleCanvasShortcut)
    return () => window.removeEventListener('keydown', handleCanvasShortcut)
  }, [redoWorkflow, undoWorkflow, updateWorkflow, workflow.id, deleteSelectedNodes, copySelectedNode, pasteCopiedNode])

  // [GroupDrag][mirror] Window-level cancel listeners. The mirror
  // listener set has its own `blur` and `pointercancel` handlers
  // (registered when the mirror starts), but we keep these here as
  // a fallback for the legacy `gd.active` path and as a second
  // line of defence if a mirror listener fails to fire.
  useEffect(() => {
    const handleWindowBlur = () => {
      if (multiDragRef.current) {
        finishMultiDragMirror(false)
        return
      }
      if (groupDragRef.current.active) {
        cancelGroupDrag('window-blur')
      }
    }
    const handlePointerCancel = () => {
      if (multiDragRef.current) {
        finishMultiDragMirror(false)
        return
      }
      if (groupDragRef.current.active) {
        cancelGroupDrag('pointercancel')
      }
    }
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('pointercancel', handlePointerCancel, true)
    return () => {
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('pointercancel', handlePointerCancel, true)
    }
  }, [])

  const handleAddNode = (type: FlowNodeType, dataPatch?: Partial<FlowNodeData>) => {
    const editor = editorRef.current
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    const zoom = editor?.zoom || 1
    const panX = editor?.canvas_x || 0
    const panY = editor?.canvas_y || 0
    const spawnPosition = nodePickerSpawnRef.current
    const x = spawnPosition
      ? Math.round(spawnPosition.x + Math.random() * 24)
      : rect
        ? Math.round((rect.width / 2 - panX) / zoom - 160 + Math.random() * 40)
        : Math.round(220 + Math.random() * 180)
    const y = spawnPosition
      ? Math.round(spawnPosition.y + Math.random() * 24)
      : rect
        ? Math.round((rect.height / 2 - panY) / zoom - 70 + Math.random() * 40)
        : Math.round(160 + Math.random() * 160)
    const node = addNode(type, { x, y })
    nodePickerSpawnRef.current = null
    if (node) {
      if (dataPatch) updateNode(node.id, dataPatch)
      setSelectedNode(node.id)
    }
    if (editor && node) {
      requestAnimationFrame(() => {
        attachNodeResizeObserver(node.id)
        scheduleDrawflowConnectionRefresh(node.id)
      })
    }
  }

  const handleRun = async () => {
    if (isRunning) {
      if (isPaused) resumePipeline()
      else pausePipeline()
      return
    }

    const runWarning = getWorkflowRunWarning(workflow)
    if (runWarning) {
      flashTemplateToast('warning', runWarning)
      return
    }

    // Clear previous run visual state before starting.
    // Order matters: clear the DOM classes FIRST so the next
    // syncNodeRunStates() pass (triggered by the React state changes
    // below) re-applies classes from a clean slate, instead of having
    // to first fight stale `ai-node-completed` from the previous run.
    clearAllRunDomClasses()
    setNodeRunStates({})
    setActiveEdges({})
    setNodeOutputs({})

    probeRunRequest('toolbar-button', workflow.id)
    await runPipeline(workflow, pipelineCallbacks)
  }

  const handleStop = () => {
    stopPipeline()
    // Clear all visual state on stop so nothing glows
    clearAllRunDomClasses()
    setNodeRunStates({})
    setActiveEdges({})
  }

  const zoomInCanvas = () => {
    const editor = editorRef.current
    if (!editor) return
    applyCanvasZoom(editor.zoom + (editor.zoom_value || 0.1))
  }

  const zoomOutCanvas = () => {
    const editor = editorRef.current
    if (!editor) return
    applyCanvasZoom(editor.zoom - (editor.zoom_value || 0.1))
  }

  const fitCanvas = () => {
    const editor = editorRef.current
    const canvas = canvasRef.current
    if (!editor || !canvas || !editor.precanvas) return false
    if (canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return false

    const nodes = Array.from(canvas.querySelectorAll<HTMLElement>('.drawflow-node'))
    const expectedNodeCount = workflowRef.current.nodes.length
    if (nodes.length < expectedNodeCount) return false
    if (nodes.some((node) => node.offsetWidth <= 0 || node.offsetHeight <= 0)) return false

    if (nodes.length === 0) {
      editor.zoom_reset()
      refreshZoom()
      scheduleConnectionSync()
      return true
    }

    const bounds = nodes.reduce(
      (acc, node) => {
        const left = node.offsetLeft
        const top = node.offsetTop
        const right = left + node.offsetWidth
        const bottom = top + node.offsetHeight
        return {
          minX: Math.min(acc.minX, left),
          minY: Math.min(acc.minY, top),
          maxX: Math.max(acc.maxX, right),
          maxY: Math.max(acc.maxY, bottom)
        }
      },
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    )

    const width = Math.max(bounds.maxX - bounds.minX, 1)
    const height = Math.max(bounds.maxY - bounds.minY, 1)
    const zoom = Math.min(1.15, Math.max(0.35, Math.min((canvas.clientWidth - 160) / width, (canvas.clientHeight - 140) / height)))

    editor.zoom = zoom
    editor.zoom_last_value = zoom
    editor.canvas_x = Math.round((canvas.clientWidth - width * zoom) / 2 - bounds.minX * zoom)
    editor.canvas_y = Math.round((canvas.clientHeight - height * zoom) / 2 - bounds.minY * zoom)
    editor.precanvas.style.transformOrigin = '0 0'
    editor.precanvas.style.transform = `translate(${editor.canvas_x}px, ${editor.canvas_y}px) scale(${zoom})`
    refreshZoom()
    scheduleConnectionSync()
    return true
  }

  useEffect(() => {
    const workflowId = workflow.id
    if (autoFitWorkflowIdRef.current === workflowId) return

    let stopped = false
    let retryTimerId: number | null = null
    let firstFrameId: number | null = null
    let resizeObserver: ResizeObserver | null = null
    const deadline = Date.now() + 5000

    const stopScheduling = () => {
      if (retryTimerId !== null) {
        window.clearTimeout(retryTimerId)
        retryTimerId = null
      }
      if (firstFrameId !== null) {
        window.cancelAnimationFrame(firstFrameId)
        firstFrameId = null
      }
      resizeObserver?.disconnect()
      resizeObserver = null
    }

    const attemptInitialFit = () => {
      if (stopped || workflowRef.current.id !== workflowId) return
      if (fitCanvas()) {
        autoFitWorkflowIdRef.current = workflowId
        scheduleDrawflowConnectionRefresh(null, { all: true })
        stopScheduling()
        return
      }
      if (Date.now() < deadline) {
        if (retryTimerId !== null) window.clearTimeout(retryTimerId)
        retryTimerId = window.setTimeout(attemptInitialFit, 60)
      }
    }

    const canvas = canvasRef.current
    if (canvas && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(attemptInitialFit)
      resizeObserver.observe(canvas)
    }
    firstFrameId = window.requestAnimationFrame(attemptInitialFit)

    return () => {
      stopped = true
      stopScheduling()
    }
  }, [workflow.id])

  const autoLayoutCanvas = () => {
    const currentWorkflow = workflowRef.current
    const nodes = currentWorkflow.nodes
    if (nodes.length === 0) return

    const nodeIds = new Set(nodes.map((node) => node.id))
    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]))
    const parents = new Map<string, Set<string>>()
    const children = new Map<string, Set<string>>()

    for (const node of nodes) {
      parents.set(node.id, new Set())
      children.set(node.id, new Set())
    }

    for (const edge of currentWorkflow.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) continue
      parents.get(edge.target)?.add(edge.source)
      children.get(edge.source)?.add(edge.target)
    }

    const getNodeElement = (nodeId: string) =>
      canvasRef.current?.querySelector<HTMLElement>(`#node-${CSS.escape(nodeId)}`) || null
    const getNodeHeight = (nodeId: string) => {
      const node = nodeById.get(nodeId)
      const measured = getNodeElement(nodeId)?.offsetHeight
      if (measured && measured > 0) return measured
      if (node?.type === 'generate' || node?.type === 'image') return 360
      if (node?.type === 'prompt') return 140
      return 180
    }
    const getNodeWidth = (nodeId: string) => {
      const node = nodeById.get(nodeId)
      const measured = getNodeElement(nodeId)?.offsetWidth
      if (measured && measured > 0) return measured
      if (node?.type === 'generate' || node?.type === 'image') return 360
      return 320
    }

    const roots = nodes.filter((node) => (parents.get(node.id)?.size || 0) === 0).map((node) => node.id)
    const depth = new Map<string, number>()

    if (roots.length > 0) {
      const remainingParents = new Map(nodes.map((node) => [node.id, parents.get(node.id)?.size || 0]))
      const queue = [...roots]
      for (const root of roots) depth.set(root, 0)

      while (queue.length > 0) {
        const id = queue.shift()
        if (!id) continue
        const currentDepth = depth.get(id) || 0

        for (const childId of children.get(id) || []) {
          depth.set(childId, Math.max(depth.get(childId) ?? 0, currentDepth + 1))
          remainingParents.set(childId, Math.max(0, (remainingParents.get(childId) || 0) - 1))
          if ((remainingParents.get(childId) || 0) === 0) queue.push(childId)
        }
      }
    } else {
      const fallbackRoot = nodes[0]?.id
      const queue = fallbackRoot ? [fallbackRoot] : []
      if (fallbackRoot) depth.set(fallbackRoot, 0)

      while (queue.length > 0) {
        const id = queue.shift()
        if (!id) continue
        const currentDepth = depth.get(id) || 0
        for (const childId of children.get(id) || []) {
          if (depth.has(childId)) continue
          depth.set(childId, currentDepth + 1)
          queue.push(childId)
        }
      }
    }

    for (const node of nodes) {
      if (!depth.has(node.id)) depth.set(node.id, 0)
    }

    const levels = new Map<number, string[]>()
    for (const node of nodes) {
      const level = depth.get(node.id) || 0
      levels.set(level, [...(levels.get(level) || []), node.id])
    }

    const sortedLevels = [...levels.keys()].sort((a, b) => a - b)
    const nodeHeights = new Map(nodes.map((node) => [node.id, getNodeHeight(node.id)]))
    const nodeWidths = new Map(nodes.map((node) => [node.id, getNodeWidth(node.id)]))
    const levelX = new Map<number, number>()
    const START_X = 80
    const START_Y = 80
    const HORIZONTAL_GAP = 170
    const VERTICAL_GAP = 100
    let cursorX = START_X

    for (const level of sortedLevels) {
      const ids = levels.get(level) || []
      levelX.set(level, cursorX)
      const maxWidth = Math.max(...ids.map((id) => nodeWidths.get(id) || 320), 320)
      cursorX += maxWidth + HORIZONTAL_GAP
    }

    const positions: Record<string, { x: number; y: number }> = {}
    const nodeCenterY = (nodeId: string) => {
      const position = positions[nodeId]
      const height = nodeHeights.get(nodeId) || 180
      if (position) return position.y + height / 2
      const node = nodeById.get(nodeId)
      return (node?.position.y || 0) + height / 2
    }

    for (const level of sortedLevels) {
      const ids = levels.get(level) || []
      ids.sort((a, b) => {
        const weightedY = (nodeId: string) => {
          const parentIds = [...(parents.get(nodeId) || [])]
          const childIds = [...(children.get(nodeId) || [])]
          let totalWeight = 0
          let weightedSum = 0

          for (const parentId of parentIds) {
            weightedSum += nodeCenterY(parentId) * 2
            totalWeight += 2
          }
          for (const childId of childIds) {
            weightedSum += nodeCenterY(childId)
            totalWeight += 1
          }

          return totalWeight > 0 ? weightedSum / totalWeight : (nodeById.get(nodeId)?.position.y || 0)
        }

        return weightedY(a) - weightedY(b) || (nodeOrder.get(a) || 0) - (nodeOrder.get(b) || 0)
      })

      let cursorY = START_Y
      for (const id of ids) {
        positions[id] = { x: levelX.get(level) || START_X, y: cursorY }
        cursorY += (nodeHeights.get(id) || 180) + VERTICAL_GAP
      }
    }

    for (const level of sortedLevels) {
      if (level === 0) continue
      const ids = levels.get(level) || []
      for (const id of ids) {
        const parentIds = [...(parents.get(id) || [])]
        if (parentIds.length === 0) continue

        const avgParentCenterY = parentIds.reduce((sum, parentId) => sum + nodeCenterY(parentId), 0) / parentIds.length
        const height = nodeHeights.get(id) || 180
        const currentY = positions[id].y
        const targetY = avgParentCenterY - height / 2
        const maxShift = VERTICAL_GAP * 0.6
        const shift = Math.max(-maxShift, Math.min(maxShift, targetY - currentY))
        positions[id] = { ...positions[id], y: Math.max(START_Y / 2, currentY + shift) }
      }
    }

    for (const level of sortedLevels) {
      const ids = [...(levels.get(level) || [])].sort((a, b) => positions[a].y - positions[b].y)
      const minGap = VERTICAL_GAP * 0.55

      for (let index = 1; index < ids.length; index += 1) {
        const previousId = ids[index - 1]
        const currentId = ids[index]
        const previousBottom = positions[previousId].y + (nodeHeights.get(previousId) || 180)
        if (positions[currentId].y < previousBottom + minGap) {
          positions[currentId] = { ...positions[currentId], y: previousBottom + minGap }
        }
      }
    }

    const minX = Math.min(...Object.values(positions).map((position) => position.x))
    const minY = Math.min(...Object.values(positions).map((position) => position.y))
    const offsetX = minX < START_X ? START_X - minX : 0
    const offsetY = minY < START_Y ? START_Y - minY : 0
    const nextPositions = Object.fromEntries(
      Object.entries(positions).map(([id, position]) => [
        id,
        {
          x: Math.round(position.x + offsetX),
          y: Math.round(position.y + offsetY)
        }
      ])
    )

    updateNodePositions(nextPositions, currentWorkflow.id)
    window.setTimeout(() => {
      scheduleDrawflowConnectionRefresh(null, { all: true })
      fitCanvas()
    }, 80)
    window.setTimeout(() => {
      scheduleDrawflowConnectionRefresh(null, { all: true })
      fitCanvas()
    }, 240)
  }

  const resetCanvas = () => {
    editorRef.current?.zoom_reset()
    refreshZoom()
    scheduleConnectionSync()
  }

  const handleNodePillOptionSelect = (option: NodePillOption) => {
    if (!nodePillMenu) return

    const currentNode = workflowRef.current.nodes.find((node) => node.id === nodePillMenu.nodeId)
    const currentData = (currentNode?.data || {}) as Record<string, unknown>
    if (currentNode?.type === 'generate') {
      const patchByField: Record<NodePillField, Record<string, unknown>> = {
        provider: { provider: option.value as AIProvider },
        mediaType: { mediaType: option.value },
        model: { model: option.value },
        videoDuration: { videoDuration: option.value },
        aspectRatio: { aspectRatio: option.value },
        quantity: { quantity: Number(option.value) },
        resolution: { resolution: option.value }
      }
      updateNode(
        nodePillMenu.nodeId,
        sanitizeGenerateDataPatch(currentData, patchByField[nodePillMenu.field]) as Partial<FlowNodeData>
      )
    } else if (nodePillMenu.field === 'provider') {
      updateNode(nodePillMenu.nodeId, { provider: option.value as AIProvider } as Partial<FlowNodeData>)
    } else if (nodePillMenu.field === 'aspectRatio') {
      updateNode(nodePillMenu.nodeId, { aspectRatio: option.value } as Partial<FlowNodeData>)
    }

    closeNodePillMenu()
    requestAnimationFrame(() => {
      scheduleConnectionSync()
    })
  }
  // [WorkflowTemplate] Save the active workflow as a user template.
  // Lifecycle:
  //   1. Bail with a warning toast when there is no active workflow
  //      (defensive — the button is only rendered when one exists).
  //   2. Sanitize the workflow via `sanitizeWorkflowForTemplate`.
  //      Heavy fields (base64 / blob / dataUrl) are stripped, nested
  //      Generate-node outputs are flattened to URL-only descriptors.
  //   3. Try to extract a 320x180 JPEG thumbnail, then save the
  //      template. Thumbnail is best-effort — failure falls through
  //      silently so a CORS-blocked asset URL still produces a
  //      thumbnailless save.
  //   4. Persist under chrome.storage.local key
  //      `ai-flow-workflow-templates` via the local store helper.
  //      Errors are surfaced as error toasts.
  // No production debug logs — this is a user-facing action.
  const handleSaveAsTemplate = async (active: Workflow) => {
    if (!active) {
      flashTemplateToast('warning', 'No workflow selected.')
      return
    }
    let existing: UserWorkflowTemplate[] = []
    try {
      existing = await listWorkflowTemplates()
    } catch {
      existing = []
    }
    const sanitized = sanitizeWorkflowForTemplate({
      nodes: active.nodes,
      edges: active.edges
    })
    const sanitizedNodes = sanitized.nodes.length
    const sanitizedEdges = sanitized.edges.length

    let thumbnail: string | undefined
    let thumbnailSourceNodeId: string | undefined
    try {
      // [WorkflowTemplate] Use the with-source variant so the
      // restore path can prefer the originating node's per-node
      // preview. Backwards-compatible — existing call sites that
      // only need the data URL can keep using
      // `extractWorkflowThumbnail`.
      const card = await extractWorkflowThumbnailWithSource({ nodes: active.nodes })
      thumbnail = card?.dataUrl
      thumbnailSourceNodeId = card?.sourceNodeId
    } catch {
      thumbnail = undefined
      thumbnailSourceNodeId = undefined
    }

    // [WorkflowTemplate] Per-node previews. Walk every
    // image-bearing node and store a 1024px JPEG data URL inside
    // `data.templateImagePreview` / `data.templateVideoPoster`.
    // Without this the restored workflow's Media nodes render as
    // placeholders — sanitizer strips the raw base64 the upload
    // path writes into `imageData` / `mediaData`. Per-node
    // previews are independent of the card thumbnail so a CORS
    // failure on the card does not poison the node previews.
    let previewCount = 0
    try {
      const previews = await extractImageNodePreviews({ nodes: active.nodes })
      if (previews.size > 0) {
        sanitized.nodes = applyNodePreviews(sanitized.nodes, previews)
        previewCount = previews.size
      }
    } catch {
      previewCount = 0
    }

    const now = Date.now()
    const template: UserWorkflowTemplate = {
      id:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? `tpl_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
          : `tpl_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      name: generateUniqueTemplateName(active.name, existing),
      workflow: {
        nodes: sanitized.nodes,
        edges: sanitized.edges
      },
      nodeCount: sanitizedNodes,
      edgeCount: sanitizedEdges,
      createdAt: now,
      updatedAt: now,
      source: 'user',
      ...(thumbnail ? { thumbnail } : {}),
      ...(thumbnailSourceNodeId ? { thumbnailSourceNodeId } : {})
    }

    try {
      await saveWorkflowTemplate(template)
    } catch (err) {
      flashTemplateToast(
        'error',
        err instanceof Error
          ? `Storage failed: ${err.message}`
          : 'Unable to save template to storage.'
      )
      return
    }

    // [WorkflowTemplate] Tell the user how many of their
    // image-bearing nodes survived. 0 is the same wording as
    // before. >0 is the new green path — saved with image
    // previews restored on Use. Errors are kept in user-facing
    // copy, not the console.
    const previewSuffix = previewCount > 0 ? `, ${previewCount} image preview${previewCount === 1 ? '' : 's'}` : ''
    flashTemplateToast(
      'success',
      thumbnail
        ? `Saved to templates — "${template.name}" (${sanitizedNodes} nodes${previewSuffix})`
        : `Saved to templates — "${template.name}" (${sanitizedNodes} nodes, no thumbnail${previewSuffix})`
    )
  }

  const nodePillMenuScale = Math.min(1, Math.max(0.55, zoomLevel / 100))

  return (
    <div className={cn('flex flex-col bg-[#0F0F0F] text-white', windowMode ? 'h-screen w-screen' : 'h-full w-full')}>
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#161616] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            title={windowMode ? 'Close editor' : 'Back'}
            onClick={onBackToDashboard}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            {windowMode ? <X className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
          </button>
          {!windowMode && (
            <button
              type="button"
              title="Toggle navigation"
              onClick={onToggleSidebar}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              {isSidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
            </button>
          )}
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#7C5CFF]/10 text-[#B8A8FF]">
            <WorkflowIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            {isRenamingWorkflow ? (
              <input
                ref={workflowNameInputRef}
                value={workflowNameDraft}
                maxLength={120}
                onChange={(event) => setWorkflowNameDraft(event.target.value)}
                onBlur={commitWorkflowRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitWorkflowRename()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelWorkflowRename()
                  }
                }}
                className="h-7 w-[min(42vw,360px)] min-w-[180px] rounded-md border border-[#7C5CFF]/70 bg-[#101010] px-2 text-[12px] font-medium text-white outline-none shadow-[0_0_0_2px_rgba(124,92,255,0.14)]"
                aria-label="Rename workflow"
              />
            ) : (
              <button
                type="button"
                onClick={beginWorkflowRename}
                title="Click to rename workflow"
                className="group -ml-1.5 flex h-7 w-[min(42vw,360px)] min-w-[180px] items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] font-medium text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C5CFF]/60"
              >
                <span className="truncate">{workflow.name}</span>
                <Pencil className="h-3 w-3 shrink-0 text-white/35 opacity-70 transition-opacity group-hover:opacity-100" />
              </button>
            )}
            <div className="text-[10px] font-medium text-white/28">
              {workflow.nodes.length} nodes / {workflow.edges.length} connections
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {windowMode && (
            <button
              type="button"
              title="AI Idea Agent"
              onClick={() => {
                setInspectorNodeId(null)
                setVideoAgentOpen((current) => !current)
              }}
              className={cn(
                'mr-1 flex h-9 items-center gap-2 rounded-lg border px-3 text-[11px] font-medium transition-colors',
                videoAgentOpen
                  ? 'border-[#7C5CFF]/45 bg-[#7C5CFF]/16 text-white'
                  : 'border-white/[0.08] bg-white/[0.025] text-white/55 hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-white'
              )}
            >
              <Sparkles className="h-3.5 w-3.5 text-[#B8A8FF]" />
              Agent
            </button>
          )}
          <button
            type="button"
            title="Save to Template"
            onClick={() => {
              void handleSaveAsTemplate(workflow)
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/42 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <BookmarkPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Export workflow"
            onClick={() => void downloadWorkflowAssetBundle(workflow)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/42 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <FileDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Console"
            onClick={() => setShowLogs(!showLogs)}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
              showLogs ? 'bg-[#7C5CFF] text-white' : 'text-white/42 hover:bg-white/[0.06] hover:text-white'
            )}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={editorRootRef}
          data-workflow-editor-root="true"
          className="relative min-w-0 flex-1 overflow-hidden bg-[#101010]"
          onContextMenu={handleCanvasContextMenu}
          onPointerDownCapture={(event) => {
            // [WorkflowSelection] Authoritative React-level clear
            // path. We wire this directly through React (not
            // addEventListener) so:
            //   1. The lifecycle is tied to the component mount —
            //      no risk of a stale listener surviving a hot
            //      reload.
            //   2. It runs in the CAPTURE phase before any
            //      bubble-phase listener (including Drawflow's
            //      own click handler). This is the earliest point
            //      at which we can guarantee our clear wins over
            //      any other code that might re-add the highlight.
            //
            // The guard mirrors `handleDocumentSelectionMouseDown`:
            // skip when the click landed on a node, port,
            // connection, or any interactive control inside a
            // node. The skip set is intentionally a superset of
            // the inline checks below so we never accidentally
            // clear a selection that lives inside a node the
            // user is interacting with.
            if (event.button !== 0) return
            if (isRenamingWorkflow) commitWorkflowRename()
            const target = event.target as HTMLElement | null
            if (!target) return
            if (
              target.closest(
                '.drawflow-node, .input, .output, .df-hover-toolbar, .df-node-toolbar, .df-node-settings-bar, .df-node-pill-menu, .df-node-prompt-editor, .aiflow-node-picker, button, [role="button"], input, textarea, select, [contenteditable="true"], [data-node-action]'
              )
            ) {
              return
            }
            // We only want to clear when the click is on the
            // canvas background — not when the user clicks the
            // toolbar, the run/stop button, or any other UI
            // control. The wrapper we attach this handler to
            // contains the canvas AND the toolbar, so we use the
            // closest('.ai-drawflow-canvas, .parent-drawflow')
            // check to ensure we only clear on canvas-surface
            // clicks.
            const onCanvas = !!target.closest(
              '.ai-drawflow-canvas, .parent-drawflow, .drawflow'
            )
            if (!onCanvas) return
            clearCanvasSelection('root-pointerdown-capture')
          }}
        >
          <div className="pointer-events-none absolute inset-0 opacity-[0.32] [background-image:radial-gradient(circle,rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:22px_22px]" />
          <div ref={canvasRef} className="ai-drawflow-canvas absolute inset-0" />

          {/* Marquee selection rectangle. Positioned `absolute` inside
              the editor root, with `left/top` translated from
              viewport coords (clientX/Y) by subtracting the editor
              root's bounding rect. The ref is read on render so it
              is guaranteed non-null by the time the user has started
              a marquee drag (which only happens after a click on the
              editor root). */}
          {marqueeRect && editorRootRef.current && (
            <div
              className="aiflow-marquee-rect pointer-events-none absolute z-50"
              style={{
                left: marqueeRect.left - editorRootRef.current.getBoundingClientRect().left,
                top: marqueeRect.top - editorRootRef.current.getBoundingClientRect().top,
                width: marqueeRect.width,
                height: marqueeRect.height
              }}
            />
          )}

          {/* Selection count badge — appears when 2+ nodes are
              selected so the user has a visible signal that they have
              a multi-selection active (and not just a stray
              .selected class on one node). During a marquee drag the
              badge reads from the live preview set so the count moves
              in lockstep with the rectangle. */}
          {(() => {
            const isPreviewing = marqueePreviewCount > 0 || marqueeRect !== null
            const effectiveCount = isPreviewing ? marqueePreviewCount : multiSelectedNodeIds.length
            if (effectiveCount <= 1) return null
            if (!editorRootRef.current) return null
            const label = isPreviewing ? `${effectiveCount} nodes in selection` : `${effectiveCount} nodes selected`
            return (
              <div
                className="aiflow-selection-badge pointer-events-none absolute right-3 top-3 z-50"
              >
                <span className="aiflow-selection-badge-dot" />
                {label}
                <span className="aiflow-selection-badge-hint">
                  {isPreviewing ? 'Release to confirm' : 'Delete to remove · Ctrl+C to copy'}
                </span>
              </div>
            )
          })()}

          <div className="aiflow-wf-toolbar">
            <button
              type="button"
              title="Add node"
              onClick={() => {
                if (isPaletteOpen) closeNodePicker()
                else openNodePicker()
              }}
              className={cn('aiflow-wf-tool-btn', isPaletteOpen && 'active')}
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={isRunning ? (isPaused ? 'Resume workflow' : 'Pause workflow') : 'Run workflow'}
              onClick={handleRun}
              disabled={workflow.nodes.length === 0}
              className="aiflow-wf-tool-btn"
            >
              {isRunning && !isPaused ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <button
              type="button"
              title="Stop workflow"
              onClick={handleStop}
              className={cn('aiflow-wf-tool-btn', !isRunning && 'hidden')}
            >
              <Square className="h-4 w-4" />
            </button>
            <div className="aiflow-wf-tool-divider" />
            <button
              type="button"
              title="Undo"
              onClick={() => undoWorkflow(workflow.id)}
              disabled={!canUndo}
              className="aiflow-wf-tool-btn"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Redo"
              onClick={() => redoWorkflow(workflow.id)}
              disabled={!canRedo}
              className="aiflow-wf-tool-btn"
            >
              <Redo2 className="h-4 w-4" />
            </button>
            <div className="aiflow-wf-tool-divider" />
            <button type="button" title="Console" onClick={() => setShowLogs(!showLogs)} className={cn('aiflow-wf-tool-btn', showLogs && 'active')}>
              <List className="h-4 w-4" />
            </button>
            <button type="button" title="Fit view" onClick={fitCanvas} className="aiflow-wf-tool-btn">
              <Maximize2 className="h-4 w-4" />
            </button>
            <button type="button" title="Reset zoom" onClick={resetCanvas} className="aiflow-wf-tool-btn">
              <span className="text-[10px] font-medium">{zoomLevel}%</span>
            </button>
            <button type="button" title="Auto layout" onClick={autoLayoutCanvas} disabled={workflow.nodes.length === 0} className="aiflow-wf-tool-btn">
              <LayoutTemplate className="h-4 w-4" />
            </button>
            <button type="button" title="Settings" className="aiflow-wf-tool-btn">
              <Settings2 className="h-4 w-4" />
            </button>
            <button type="button" title="Export workflow" onClick={() => void downloadWorkflowAssetBundle(workflow)} className="aiflow-wf-tool-btn">
              <FileDown className="h-4 w-4" />
            </button>
          </div>

          {isPaletteOpen && (
            <div
              ref={nodePickerRef}
              className={cn('aiflow-node-picker', nodePickerPosition ? '' : 'left-[64px] top-1/2 -translate-y-1/2')}
              style={nodePickerPosition ? { left: nodePickerPosition.x, top: nodePickerPosition.y } : undefined}
            >
              <div className="aiflow-node-picker-context-hint aiflow-node-picker-context-hint--no-text">
                <button
                  type="button"
                  title="Close"
                  onClick={closeNodePicker}
                  className="aiflow-node-picker-close"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="aiflow-node-picker-search">
                <input
                  value={nodePickerSearch}
                  onChange={(event) => setNodePickerSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      closeNodePicker()
                    }
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setSelectedPickerIndex((current) => Math.min(current + 1, Math.max(pickerItems.length - 1, 0)))
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setSelectedPickerIndex((current) => Math.max(current - 1, 0))
                    }
                    if (event.key === 'Enter' && pickerItems[selectedPickerIndex]) {
                      event.preventDefault()
                      handleAddNode(pickerItems[selectedPickerIndex].type)
                      closeNodePicker()
                    }
                  }}
                  autoFocus
                  placeholder="Search nodes..."
                  className="aiflow-node-picker-input nodrag"
                />
              </div>
              <div className="aiflow-node-picker-list">
                {pickerItems.map((node, index) => (
                  <button
                    type="button"
                    key={node.type}
                    onClick={() => {
                      handleAddNode(node.type)
                      closeNodePicker()
                    }}
                    className={cn('aiflow-node-picker-item', index === selectedPickerIndex && 'selected')}
                  >
                    <span className={cn('node-palette-item-icon df-node-icon', nodeMeta(node.type).color)}>
                      {node.icon}
                    </span>
                    <span className="aiflow-node-picker-info">
                      <span className="aiflow-node-picker-name">{node.label}</span>
                      <span className="aiflow-node-picker-desc">{node.description}</span>
                    </span>
                  </button>
                ))}
                {pickerItems.length === 0 && (
                  <div className="px-3 py-8 text-center text-[11px] text-white/35">No matching nodes</div>
                )}
              </div>
              <div className="aiflow-node-picker-footer">
                <kbd>↑↓</kbd> Move &nbsp; <kbd>Enter</kbd> Select &nbsp; <kbd>Esc</kbd> Close
              </div>
            </div>
          )}

          {nodePillMenu && (
            <div
              ref={nodePillMenuRef}
              className="df-node-pill-menu"
              style={{ '--df-pill-menu-scale': String(nodePillMenuScale) } as React.CSSProperties}
              role="listbox"
              aria-label={pillFieldLabel(nodePillMenu.field)}
            >
              <div className="df-node-pill-menu-title">
                {pillFieldLabel(nodePillMenu.field)}
              </div>
              <div className="df-node-pill-menu-list">
                {nodePillMenu.options.map((option) => {
                  const selected = option.value === nodePillMenu.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={cn('df-node-pill-menu-item', selected && 'selected')}
                      onClick={() => handleNodePillOptionSelect(option)}
                    >
                      <span className="df-node-pill-menu-label">{option.label}</span>
                      {selected && <Check className="df-node-pill-menu-check" />}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {imagePreview && (() => {
            const lightboxOutputs = imagePreview.outputItems || []
            const lightboxHasCarousel = lightboxOutputs.length > 1
            const lightboxSelectedIndex = imagePreview.selectedIndex ?? 0
            const headerTitle =
              imagePreview.outputName
              || imagePreview.outputItems?.[lightboxSelectedIndex]?.name
              || imagePreview.name
            const metadata = imagePreview.metadata || {}
            const fileSizeText = formatMediaFileSize(metadata.size)
            const resolutionText = metadata.width && metadata.height
              ? `${Math.round(metadata.width)} × ${Math.round(metadata.height)}`
              : ''
            const durationText = imagePreview.mediaType === 'video'
              ? formatMediaDuration(metadata.duration)
              : ''
            const createdAtText = formatPreviewCreatedAt(metadata.createdAt)
            const costText = formatPreviewCost(metadata.cost)
            const fileTypeText = formatPreviewFileType(
              metadata,
              headerTitle,
              imagePreview.src,
              imagePreview.mediaType
            )
            const metadataRows = [
              { label: 'Name', value: headerTitle },
              { label: 'Model', value: metadata.model },
              { label: 'File type', value: fileTypeText },
              { label: 'File size', value: fileSizeText },
              { label: 'Resolution', value: resolutionText },
              { label: 'Duration', value: durationText },
              { label: 'Date created', value: createdAtText },
              // Do not render a placeholder row when the provider
              // did not return cost metadata.
              { label: 'Cost', value: costText },
              {
                label: imagePreview.outputItems ? 'Created by' : 'Uploaded by',
                value: metadata.createdBy
              }
            ].filter((row) => Boolean(row.value))
            const zoom = Math.max(50, Math.min(300, imagePreview.zoom || 100))

            const syncRenderedMediaMetadata = (width: number, height: number, duration?: number) => {
              if (!width || !height) return
              setImagePreview((current) => {
                if (!current || current.src !== imagePreview.src) return current
                const currentMetadata = current.metadata || {}
                const nextDuration = currentMetadata.duration || duration
                if (
                  currentMetadata.width === width
                  && currentMetadata.height === height
                  && currentMetadata.duration === nextDuration
                ) return current
                return {
                  ...current,
                  metadata: {
                    ...currentMetadata,
                    width: currentMetadata.width || width,
                    height: currentMetadata.height || height,
                    ...(nextDuration ? { duration: nextDuration } : {})
                  }
                }
              })
            }
            return (
              <div
                className="absolute inset-0 z-[70] flex flex-col bg-black/90 p-4 backdrop-blur-md"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) setImagePreview(null)
                }}
              >
                <div className="flex h-12 shrink-0 items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      title={lightboxHasCarousel ? 'Download current output' : 'Download'}
                      aria-label={lightboxHasCarousel ? 'Download current output' : 'Download'}
                      onClick={handleDownloadPreview}
                      className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.12] bg-white/[0.04] text-white/65 transition-colors hover:bg-white/[0.09] hover:text-white"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                    {lightboxHasCarousel && (
                      <div className="flex items-center gap-1 rounded-xl border border-white/[0.1] bg-white/[0.04] p-1 text-[11px] text-white/72">
                        <button
                          type="button"
                          title="Previous output"
                          aria-label="Previous output"
                          onClick={handleLightboxPrev}
                          className="flex h-6 w-6 items-center justify-center rounded text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </button>
                        <span className="min-w-[40px] px-1 text-center tabular-nums">
                          {lightboxSelectedIndex + 1} / {lightboxOutputs.length}
                        </span>
                        <button
                          type="button"
                          title="Next output"
                          aria-label="Next output"
                          onClick={handleLightboxNext}
                          className="flex h-6 w-6 items-center justify-center rounded text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white"
                        >
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    title="Close preview"
                    onClick={() => setImagePreview(null)}
                    className="flex h-9 w-9 items-center justify-center rounded-xl text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="flex min-h-0 flex-1 gap-4">
                  <div className="relative flex min-w-0 flex-1 items-center justify-center overflow-auto rounded-2xl border border-white/[0.12] bg-[#111111] shadow-2xl">
                    {imagePreview.mediaType === 'image' && (
                      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg bg-black/70 p-1 text-[10px] font-medium text-white/75 backdrop-blur-sm">
                        <button
                          type="button"
                          title="Zoom out"
                          onClick={() => setImagePreview((current) => current ? { ...current, zoom: Math.max(50, (current.zoom || 100) - 25) } : current)}
                          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/[0.1] hover:text-white"
                        >
                          <ZoomOut className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Reset zoom"
                          onClick={() => setImagePreview((current) => current ? { ...current, zoom: 100 } : current)}
                          className="h-7 min-w-[48px] rounded-md px-1 tabular-nums hover:bg-white/[0.1] hover:text-white"
                        >
                          {zoom}%
                        </button>
                        <button
                          type="button"
                          title="Zoom in"
                          onClick={() => setImagePreview((current) => current ? { ...current, zoom: Math.min(300, (current.zoom || 100) + 25) } : current)}
                          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/[0.1] hover:text-white"
                        >
                          <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}

                    {imagePreview.mediaType === 'video' ? (
                      <video
                        key={imagePreview.src}
                        src={imagePreview.src}
                        controls
                        autoPlay
                        onLoadedMetadata={(event) => {
                          const video = event.currentTarget
                          syncRenderedMediaMetadata(video.videoWidth, video.videoHeight, video.duration)
                        }}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <img
                        key={imagePreview.src}
                        src={imagePreview.src}
                        alt={headerTitle}
                        onLoad={(event) => {
                          const image = event.currentTarget
                          syncRenderedMediaMetadata(image.naturalWidth, image.naturalHeight)
                        }}
                        style={{ transform: `scale(${zoom / 100})` }}
                        className="max-h-full max-w-full origin-center object-contain transition-transform duration-150"
                      />
                    )}
                  </div>

                  <aside className="w-[220px] shrink-0 overflow-y-auto rounded-2xl border border-white/[0.06] bg-black/35 px-4 py-5">
                    <div className="space-y-5">
                      {metadataRows.map((row) => (
                        <div key={row.label}>
                          <div className="text-[10px] font-medium text-white/38">{row.label}</div>
                          <div className="mt-1 break-words text-[11px] font-medium leading-relaxed text-white/82">
                            {row.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  </aside>
                </div>
              </div>
            )
          })()}

          {workflow.nodes.length === 0 && !isPaletteOpen && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <div className="pointer-events-auto flex flex-col items-center rounded-xl border border-white/[0.06] bg-[#171717]/95 px-5 py-4 text-center shadow-2xl">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.04] text-white/28">
                  <WorkflowIcon className="h-5 w-5" />
                </div>
                <p className="mt-3 text-[11px] font-medium text-white/60">No nodes</p>
                <button
                  type="button"
                  onClick={() => {
                    openNodePicker()
                  }}
                  className="mt-3 flex h-8 items-center gap-2 rounded-lg bg-[#7C5CFF] px-3 text-[11px] font-medium text-white transition-colors hover:bg-[#6B4EE0]"
                >
                  <Plus className="h-4 w-4" />
                  Add node
                </button>
              </div>
            </div>
          )}

          <div className={cn(
            'absolute left-3 z-20 flex items-center gap-1 rounded-xl border border-white/[0.08] bg-[#191919] p-1 shadow-xl transition-[bottom]',
            showLogs ? 'bottom-[220px]' : 'bottom-3'
          )}>
            <button type="button" title="Zoom out" onClick={zoomOutCanvas} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white">
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <button type="button" title="Fit view" onClick={fitCanvas} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white">
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button type="button" title="Zoom in" onClick={zoomInCanvas} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white">
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button type="button" title="Reset zoom" onClick={resetCanvas} className="h-8 min-w-11 rounded-lg px-2 text-[10px] font-medium text-white/35 transition-colors hover:bg-white/[0.07] hover:text-white/75">
              {zoomLevel}%
            </button>
          </div>

          {showLogs && (
            <div className="absolute inset-x-0 bottom-0 z-30 h-52 border-t border-white/[0.06] bg-[#151515] shadow-2xl">
              <div className="flex h-11 items-center justify-between border-b border-white/[0.06] px-4">
                <span className="text-[11px] font-medium text-white/50">Console</span>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-white/28">
                    {activeTask?.status || 'idle'}
                    {selectedNodeId ? ` / ${selectedNodeId.slice(0, 6)}` : ''}
                  </span>
                  <button
                    type="button"
                    title="Close console"
                    onClick={() => setShowLogs(false)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="h-[calc(100%-44px)] space-y-0.5 overflow-y-auto p-3">
                {taskLogs.length === 0 ? (
                  <p className="py-8 text-center text-[11px] text-white/22">No logs</p>
                ) : (
                  taskLogs.map((log) => (
                    <div key={log.id} className="flex items-start gap-3 rounded-md px-2 py-1 hover:bg-white/[0.04]">
                      <span className={cn(
                        'mt-0.5 w-12 text-[10px] font-mono',
                        log.level === 'success' && 'text-emerald-400',
                        log.level === 'error' && 'text-red-400',
                        log.level === 'warn' && 'text-amber-400',
                        log.level === 'info' && 'text-white/35'
                      )}>
                        {log.level.toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-white/58">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        {windowMode && videoAgentOpen && (
          <VideoIdeaAgentPanel
            workflow={workflow}
            onClose={() => setVideoAgentOpen(false)}
            onInsertPrompt={(text, provider) => {
              const workflowProvider = provider === 'api' ? 'chatgpt' : provider as AIProvider
              const selectedPromptNodeId = useWorkflowStore.getState().selectedNodeId
              const selectedPromptNode = selectedPromptNodeId
                ? workflowRef.current.nodes.find((node) => node.id === selectedPromptNodeId && node.type === 'prompt')
                : undefined

              if (selectedPromptNode) {
                updateNode(selectedPromptNode.id, {
                  label: 'Prompt',
                  prompt: text,
                  provider: workflowProvider,
                  enabled: true,
                } as Partial<FlowNodeData>)
                flashTemplateToast('success', 'Selected Prompt Node updated with the Agent prompt.')
                return
              }

              handleAddNode('prompt', {
                label: 'Prompt',
                prompt: text,
                // API is a Prompt Assistant transport, not a workflow execution provider.
                provider: workflowProvider,
                enabled: true,
              } as Partial<FlowNodeData>)
              flashTemplateToast('success', 'Agent idea added as a Prompt Node.')
            }}
          />
        )}
        {windowMode && inspectorNodeId && (
          <NodeInspector
            workflow={workflow}
            nodeId={inspectorNodeId}
            onClose={() => setInspectorNodeId(null)}
            onSaveMediaUrl={handleSaveMediaUrl}
          />
        )}
        {/* [WorkflowTemplate] Save-to-Template toast. Sits inside the
            editor root so it doesn't cross into a fresh stacking
            context — z-[80] keeps it above the lightbox (z-70) and
            the marquee (z-50). Hidden by `templateToast` being null
            after auto-clear. No debugging hooks. */}
        {templateToast && (
          <div
            role="status"
            aria-live="polite"
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-5 z-[80] flex justify-center px-3'
            )}
          >
            <div
              className={cn(
                'pointer-events-auto flex max-w-[420px] items-start gap-2 rounded-lg border px-3 py-2 text-[12px] font-medium shadow-2xl backdrop-blur-sm',
                templateToast.tone === 'success' &&
                  'border-emerald-400/35 bg-[#0F2018]/92 text-emerald-100',
                templateToast.tone === 'error' &&
                  'border-rose-400/40 bg-[#271318]/92 text-rose-100',
                templateToast.tone === 'warning' &&
                  'border-amber-400/35 bg-[#2A1F0F]/92 text-amber-100'
              )}
            >
              <span
                className={cn(
                  'mt-[3px] inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                  templateToast.tone === 'success' && 'bg-emerald-400',
                  templateToast.tone === 'error' && 'bg-rose-400',
                  templateToast.tone === 'warning' && 'bg-amber-400'
                )}
              />
              <span className="leading-snug">{templateToast.message}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
async function openWorkflowEditorWindow(
  workflow: Workflow,
  options: { fromTemplate?: boolean } = {}
) {
  await chrome.storage.local.set({
    _pendingWorkflowEditor: {
      workflow,
      workflowId: workflow.id,
      fromTemplate: options.fromTemplate === true,
      timestamp: Date.now()
    }
  })

  await chrome.runtime.sendMessage({
    action: 'OPEN_WORKFLOW_EDITOR_WINDOW',
    payload: {
      workflowId: workflow.id,
      fromTemplate: options.fromTemplate === true
    },
    timestamp: Date.now()
  })
}

const templateDraftSnapshot = (workflow: Workflow): string => JSON.stringify({
  name: workflow.name,
  description: workflow.description || '',
  nodes: workflow.nodes,
  edges: workflow.edges,
  tags: workflow.tags || []
})

// [AssetGC] Phase 5 — Asset Storage report modal.
// Owned by WorkflowEditor; never touches Flow / ChatGPT / runner
// paths. Shows:
//   - Total / referenced / orphan counts and sizes.
//   - Browser storage.estimate() usage + quota when available.
//   - Top 5 largest assets by size.
//   - A "Clean unused assets" CTA that opens a confirm dialog.
// Confirm step is mandatory — never auto-deletes, never deletes
// against a stale report (REPORT_STALE_MS in assetGc).
interface AssetStorageModalProps {
  report: AssetUsageReport | null
  estimate: Awaited<ReturnType<typeof getAssetStorageEstimate>> | null
  orphan: OrphanAssetReport | null
  loading: boolean
  error: string | null
  confirmDelete: boolean
  deleting: boolean
  deleteSummary: { deleted: number; failed: number } | null
  onRefresh: () => void
  onRequestCleanup: () => void
  onCancelCleanup: () => void
  onConfirmCleanup: () => void
  onClose: () => void
}

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const decimals = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${units[unitIndex]}`
}

const formatPercent = (numerator: number, denominator: number): string => {
  if (!denominator) return '0%'
  const pct = Math.min(100, Math.max(0, (numerator / denominator) * 100))
  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`
}

const AssetStorageModal: React.FC<AssetStorageModalProps> = ({
  report,
  estimate,
  orphan,
  loading,
  error,
  confirmDelete,
  deleting,
  deleteSummary,
  onRefresh,
  onRequestCleanup,
  onCancelCleanup,
  onConfirmCleanup,
  onClose
}) => {
  const orphanRows = orphan?.cleanable ?? []
  const orphanBytes = orphan?.cleanableBytes ?? 0
  const recentGraceAssets = orphan?.recentGraceAssets ?? report?.recentGraceAssets ?? 0
  const browserPct = estimate && estimate.browserQuotaBytes && estimate.browserQuotaBytes > 0
    ? formatPercent(estimate.browserUsageBytes || 0, estimate.browserQuotaBytes)
    : null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="asset-storage-title"
      className="workflow-confirm-overlay"
      onClick={onClose}
    >
      <div
        className="asset-storage-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="asset-storage-header">
          <div className="asset-storage-icon">
            <HardDrive className="h-4 w-4" />
          </div>
          <div className="asset-storage-title-block">
            <h2 id="asset-storage-title" className="asset-storage-title">
              Asset storage
            </h2>
            <p className="asset-storage-subtitle">
              IndexedDB assets uploaded with your workflows and generate outputs.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="asset-storage-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="asset-storage-body">
          {error && (
            <div className="asset-storage-banner asset-storage-banner-error" role="alert">
              <span>{error}</span>
            </div>
          )}
          {deleteSummary && (
            <div
              className={
                deleteSummary.failed > 0
                  ? 'asset-storage-banner asset-storage-banner-warning'
                  : 'asset-storage-banner asset-storage-banner-success'
              }
              role="status"
            >
              <span>
                Deleted {deleteSummary.deleted} asset
                {deleteSummary.deleted === 1 ? '' : 's'}
                {deleteSummary.failed > 0
                  ? `, ${deleteSummary.failed} failed`
                  : ''}
                .
              </span>
            </div>
          )}

          <div className="asset-storage-grid">
            <div className="asset-storage-stat">
              <span className="asset-storage-stat-label">Total assets</span>
              <span className="asset-storage-stat-value">{report?.totalAssets ?? '—'}</span>
              <span className="asset-storage-stat-sub">{formatBytes(report?.totalBytes ?? 0)}</span>
            </div>
            <div className="asset-storage-stat">
              <span className="asset-storage-stat-label">Referenced</span>
              <span className="asset-storage-stat-value">{report?.referencedAssets ?? '—'}</span>
              <span className="asset-storage-stat-sub">{formatBytes(report?.referencedBytes ?? 0)}</span>
            </div>
            <div className="asset-storage-stat asset-storage-stat-orphan">
              <span className="asset-storage-stat-label">Unused / orphan</span>
              <span className="asset-storage-stat-value">{report?.orphanAssets ?? '—'}</span>
              <span className="asset-storage-stat-sub">{formatBytes(report?.orphanBytes ?? 0)}</span>
            </div>
            <div className="asset-storage-stat">
              <span className="asset-storage-stat-label">Recent grace</span>
              <span className="asset-storage-stat-value">{recentGraceAssets}</span>
              <span className="asset-storage-stat-sub">
                {`assets <${Math.round(RECENT_ASSET_GRACE_MS / 60000)} min old`}
              </span>
            </div>
          </div>

          {estimate && (
            <div className="asset-storage-section">
              <div className="asset-storage-section-title">Browser storage</div>
              {estimate.browserEstimateSupported ? (
                <div className="asset-storage-bar-wrap">
                  <div className="asset-storage-bar">
                    <div
                      className="asset-storage-bar-fill"
                      style={{ width: browserPct || '0%' }}
                    />
                  </div>
                  <div className="asset-storage-bar-text">
                    {estimate.browserUsageBytes !== null
                      ? `${formatBytes(estimate.browserUsageBytes)} used`
                      : 'usage unavailable'}
                    {estimate.browserQuotaBytes !== null && (
                      <> &middot; quota {formatBytes(estimate.browserQuotaBytes)} ({browserPct})</>
                    )}
                    {' · '}
                    IndexedDB assets {formatBytes(estimate.indexedDbBytes)} ({estimate.assetCount})
                  </div>
                </div>
              ) : (
                <div className="asset-storage-bar-text">
                  Browser storage estimate is not available in this environment.
                </div>
              )}
            </div>
          )}

          <div className="asset-storage-section">
            <div className="asset-storage-section-title">Top largest assets</div>
            {report && report.largestAssets.length > 0 ? (
              <ul className="asset-storage-list">
                {report.largestAssets.map((asset) => (
                  <li key={asset.id} className="asset-storage-list-row">
                    <span className="asset-storage-list-name">
                      {asset.fileName || asset.id}
                    </span>
                    <span className="asset-storage-list-meta">
                      {asset.kind} &middot; {asset.source} &middot; {asset.mimeType || 'unknown'}
                    </span>
                    <span className="asset-storage-list-size">{formatBytes(asset.size)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="asset-storage-empty">No assets yet.</div>
            )}
          </div>
        </div>

        <div className="asset-storage-footer">
          <button
            type="button"
            className="asset-storage-btn asset-storage-btn-ghost"
            onClick={onRefresh}
            disabled={loading || deleting}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="asset-storage-btn asset-storage-btn-danger"
            onClick={onRequestCleanup}
            disabled={
              loading
              || deleting
              || !report
              || (report.orphanAssets <= 0 && (orphan?.cleanable.length ?? 0) === 0)
            }
          >
            Clean unused assets
          </button>
          <button
            type="button"
            className="asset-storage-btn"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {confirmDelete && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="asset-storage-confirm-title"
            className="workflow-confirm-overlay"
            onClick={() => {
              if (!deleting) onCancelCleanup()
            }}
          >
            <div
              className="workflow-confirm-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="workflow-confirm-icon">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="workflow-confirm-body">
                <h3 id="asset-storage-confirm-title" className="workflow-confirm-title">
                  {orphanRows.length > 0
                    ? `Delete ${orphanRows.length} unused asset${orphanRows.length === 1 ? '' : 's'} and free ${formatBytes(orphanBytes)}?`
                    : 'No unused assets to delete.'}
                </h3>
                <p className="workflow-confirm-desc">
                  This action cannot be undone. Assets referenced by any workflow, template,
                  or pending editor payload are kept.
                </p>
              </div>
              <div className="workflow-confirm-actions">
                <button
                  type="button"
                  className="workflow-confirm-cancel"
                  onClick={onCancelCleanup}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="workflow-confirm-delete"
                  onClick={onConfirmCleanup}
                  disabled={deleting || orphanRows.length === 0}
                >
                  <Trash2 className="h-4 w-4" />
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export const WorkflowEditor: React.FC<WorkflowEditorProps> = ({ isSidebarOpen, onToggleSidebar }) => {
  const workflows = useWorkflowStore((s) => s.workflows)
  const activeWorkflowId = useWorkflowStore((s) => s.activeWorkflowId)
  const hydrateFromStorage = useWorkflowStore((s) => s.hydrateFromStorage)
  const createWorkflow = useWorkflowStore((s) => s.createWorkflow)
  const updateWorkflow = useWorkflowStore((s) => s.updateWorkflow)
  const deleteWorkflow = useWorkflowStore((s) => s.deleteWorkflow)
  const duplicateWorkflow = useWorkflowStore((s) => s.duplicateWorkflow)
  const importWorkflow = useWorkflowStore((s) => s.importWorkflow)
  const setActiveWorkflow = useWorkflowStore((s) => s.setActiveWorkflow)

  const [view, setView] = usePersistedState<WorkflowShellView>('workflow.view', workflows.some((workflow) => !workflow.isTemplateDraft) ? 'workflows' : 'templates')
  const [templateCategory, setTemplateCategory] = usePersistedState<string>('workflow.templateCategory', 'All')
  const [workflowSearch, setWorkflowSearch] = useState('')
  // [WorkflowTemplate] JS masonry: ref to the templates scroll
  // container (the OUTER element that owns `overflow-y-auto`).
  // We measure this container's clientWidth to decide the
  // flex-column count. The container itself becomes a vertical
  // scroll viewport; the JS masonry flex row lives INSIDE it.
  const templatesScrollRef = useRef<HTMLDivElement | null>(null)
  const [templateColumnCount, setTemplateColumnCount] = useState<number>(1)
  // [WorkflowTemplate] ResizeObserver drives
  // `templateColumnCount`. We measure on every layout-affecting
  // change (panel resize, side-panel open/close, viewport drag)
  // so the flex row updates without a page reload. The observer
  // is attached only while the Templates view is mounted, so
  // flipping to the Workflows tab tears it down and avoids the
  // observer leak that would otherwise fire on Workflow-canvas
  // resizes.
  useEffect(() => {
    if (view !== 'templates') return
    const el = templatesScrollRef.current
    if (!el) return
    const compute = () => {
      const w = el.clientWidth
      const n = Math.max(
        1,
        Math.min(
          MAX_TEMPLATE_COLUMNS,
          Math.floor((w + TEMPLATE_CARD_GAP) / (MIN_TEMPLATE_CARD_WIDTH + TEMPLATE_CARD_GAP))
        )
      )
      setTemplateColumnCount((prev) => (prev === n ? prev : n))
    }
    compute()
    const ro = new ResizeObserver(() => compute())
    ro.observe(el)
    return () => ro.disconnect()
  }, [view])
  // [WorkflowEditor] Clear multi-select when leaving the Workflows
  // view. Selection is meaningful only inside the list UI; carrying
  // it across view changes would select stale ids and surprise the
  // user when they return. We track the previous view in a ref
  // (transition detector) so this fires only on actual view
  // changes, not on every selection mutation while staying on the
  // same view.
  const previousViewRef = useRef<WorkflowShellView>(view)
  useEffect(() => {
    if (previousViewRef.current === view) return
    previousViewRef.current = view
    if (view !== 'workflows') setSelectedWorkflowIds([])
  }, [view])
  // [WorkflowTemplate] Saved templates pulled from
  // chrome.storage.local `ai-flow-workflow-templates`. Refreshed on
  // mount, on chrome.storage.onChanged, and on tab-focus inside the
  // Templates tab so a Save-to-Template from the canvas shows up
  // without a manual reload.
  const [savedTemplates, setSavedTemplates] = useState<UserWorkflowTemplate[]>([])
  const [deleteConfirmTemplate, setDeleteConfirmTemplate] = useState<UserWorkflowTemplate | null>(null)
  const [deleteConfirmWorkflow, setDeleteConfirmWorkflow] = useState<Workflow | null>(null)
  // [WorkflowEditor] Multi-select for bulk delete. Array (not Set)
  // so the state is serializable / debuggable. Holds the IDs of
  // currently selected workflow cards. Selection is local UI state
  // (not persisted): it must reset when the user leaves the
  // Workflows view or switches tabs.
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<string[]>([])
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false)
  // [EscapeRef] Ref-mirror for `clearWorkflowSelection` so the
  // Escape keydown handler (declared higher in the component,
  // before the multi-select handlers exist) can always read the
  // latest callback. The ref is kept current by a sibling effect
  // below.
  const clearSelectionRef = useRef<(() => void) | null>(null)
  const [renameWorkflow, setRenameWorkflow] = useState<Workflow | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // [AssetGC] Phase 5 — Asset Storage modal. Self-contained:
  // owns its loading / report / confirm-delete state, never touches
  // workflow store mutations. The button lives next to "Import" on
  // the dashboard toolbar so the affordance is discoverable but
  // doesn't get in the way of the canvas / templates flows.
  const [storageModalOpen, setStorageModalOpen] = useState(false)
  const [storageReport, setStorageReport] = useState<AssetUsageReport | null>(null)
  const [storageEstimate, setStorageEstimate] = useState<Awaited<ReturnType<typeof getAssetStorageEstimate>> | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [storageOrphan, setStorageOrphan] = useState<OrphanAssetReport | null>(null)
  const [storageConfirmDelete, setStorageConfirmDelete] = useState(false)
  const [storageDeleting, setStorageDeleting] = useState(false)
  const [storageDeleteSummary, setStorageDeleteSummary] = useState<{ deleted: number; failed: number } | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const storageDeleteTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const closeStorageModal = useCallback(() => {
    for (const timer of storageDeleteTimersRef.current) clearTimeout(timer)
    storageDeleteTimersRef.current = []
    setStorageModalOpen(false)
    setStorageReport(null)
    setStorageEstimate(null)
    setStorageOrphan(null)
    setStorageConfirmDelete(false)
    setStorageDeleting(false)
    setStorageDeleteSummary(null)
    setStorageError(null)
    setStorageLoading(false)
  }, [])

  const refreshStorageReport = useCallback(async () => {
    setStorageLoading(true)
    setStorageError(null)
    try {
      const [usage, estimate] = await Promise.all([
        listAssetUsage(),
        getAssetStorageEstimate()
      ])
      setStorageReport(usage)
      setStorageEstimate(estimate)
      setStorageOrphan(null)
      setStorageConfirmDelete(false)
      setStorageDeleteSummary(null)
    } catch (err) {
      setStorageError(err instanceof Error ? err.message : String(err))
    } finally {
      setStorageLoading(false)
    }
  }, [])

  const beginStorageCleanup = useCallback(async () => {
    // Re-run orphan detection at the moment the user opens the
    // confirm dialog so a stale report (older than 30 s) cannot
    // be used to delete an asset that just got referenced.
    if (storageOrphan && !isOrphanReportFresh(storageOrphan)) {
      try {
        const next = await findOrphanAssets()
        setStorageOrphan(next)
      } catch {
        // Refresh failed — keep the existing report, the confirm
        // step will reject the deletion if the rows are still
        // there but the count no longer matches.
      }
    }
    setStorageConfirmDelete(true)
  }, [storageOrphan])

  const cancelStorageCleanup = useCallback(() => {
    setStorageConfirmDelete(false)
  }, [])

  const confirmStorageCleanup = useCallback(async () => {
    if (!storageOrphan || storageOrphan.cleanable.length === 0) {
      setStorageConfirmDelete(false)
      return
    }
    if (!isOrphanReportFresh(storageOrphan)) {
      // The pre-delete safety net — never delete against a stale
      // report. Re-run detection and let the user try again.
      try {
        const next = await findOrphanAssets()
        setStorageOrphan(next)
      } catch (err) {
        setStorageError(err instanceof Error ? err.message : String(err))
      }
      setStorageConfirmDelete(false)
      return
    }
    setStorageDeleting(true)
    setStorageError(null)
    try {
      const ids = storageOrphan.cleanable.map((row) => row.id)
      const result = await deleteAssetsById(ids)
      setStorageDeleteSummary({ deleted: result.deleted, failed: result.failed.length })
      if (result.failed.length > 0) {
        // eslint-disable-next-line no-console
        console.warn('[AssetGC] cleanup partial', JSON.stringify({
          deleted: result.deleted,
          failed: result.failed
        }))
      }
      // Refresh the report so the UI shows the post-delete state.
      const [usage, estimate] = await Promise.all([
        listAssetUsage(),
        getAssetStorageEstimate()
      ])
      setStorageReport(usage)
      setStorageEstimate(estimate)
      setStorageOrphan(null)
    } catch (err) {
      setStorageError(err instanceof Error ? err.message : String(err))
    } finally {
      setStorageDeleting(false)
      setStorageConfirmDelete(false)
    }
  }, [storageOrphan])

  const refreshSavedTemplates = useCallback(async () => {
    try {
      const list = await listWorkflowTemplates()
      setSavedTemplates(list)
    } catch {
      setSavedTemplates([])
    }
  }, [])

  // Initial load + chrome.storage.onChanged subscription. The
  // listener is deduped so a tab-blur / focus does not double-bind.
  useEffect(() => {
    void refreshSavedTemplates()
    const unsubscribe = onWorkflowTemplatesChanged((next) => {
      setSavedTemplates(next)
    })
    return unsubscribe
  }, [refreshSavedTemplates])

  // When the user switches into the Templates tab we re-read storage
  // so a save that happened in the canvas (which fired onChanged
  // already) is reflected even if the listener was registered after
  // the write. Also re-read on window focus because the Side Panel
  // can be hidden then shown without unmounting the editor.
  useEffect(() => {
    if (view !== 'templates') return
    void refreshSavedTemplates()
    const onFocus = () => {
      void refreshSavedTemplates()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [view, refreshSavedTemplates])

  useEffect(() => {
    hydrateFromStorage().catch(() => {})
    const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === 'local' && changes['ai-flow-workflows']) {
        const oldVal = changes['ai-flow-workflows'].oldValue
        const newVal = changes['ai-flow-workflows'].newValue
        const countFrom = (raw: unknown): number => {
          if (typeof raw !== 'string' || !raw) return 0
          try {
            const p = JSON.parse(raw) as { state?: { workflows?: unknown[]; activeWorkflowId?: string | null } }
            return Array.isArray(p?.state?.workflows) ? p.state.workflows.length : 0
          } catch { return 0 }
        }
        const activeFrom = (raw: unknown): string | null => {
          if (typeof raw !== 'string' || !raw) return null
          try {
            const p = JSON.parse(raw) as { state?: { activeWorkflowId?: string | null } }
            return p?.state?.activeWorkflowId ?? null
          } catch { return null }
        }
        const newWc = countFrom(newVal)
        if (WORKFLOW_PERSIST_DEBUG()) {
          // eslint-disable-next-line no-console
          console.debug('[WorkflowPersist][storage.onChanged]', JSON.stringify({
            key: 'ai-flow-workflows',
            oldWorkflowCount: countFrom(oldVal),
            newWorkflowCount: newWc,
            oldActiveWorkflowId: activeFrom(oldVal),
            newActiveWorkflowId: activeFrom(newVal)
          }))
        }
        hydrateFromStorage().catch(() => {})
      }
    }
    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleStorageChange)
  }, [hydrateFromStorage])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // [WorkflowEditor] Escape precedence: most-specific modal
      // wins, then the bare selection. A top-level Escape with
      // no modal open deselects the multi-selected cards.
      if (renameWorkflow) {
        event.stopPropagation()
        handleCancelRenameWorkflow()
      } else if (deleteConfirmTemplate) {
        event.stopPropagation()
        setDeleteConfirmTemplate(null)
      } else if (deleteConfirmWorkflow) {
        event.stopPropagation()
        setDeleteConfirmWorkflow(null)
      } else if (bulkDeleteConfirmOpen) {
        event.stopPropagation()
        // Bulk delete Escape — close the modal without
        // deleting. The selection is preserved so the user can
        // keep working without re-selecting after cancelling.
        setBulkDeleteConfirmOpen(false)
      } else if (
        selectedWorkflowIds.length > 0
        && view === 'workflows'
        && !renameWorkflow
        && !deleteConfirmTemplate
        && !deleteConfirmWorkflow
      ) {
        // [WorkflowEditor] Top-level Escape clears the multi-
        // selection when no modal is open. Matches the
        // Gmail / Inbox convention: pressing Escape in a list
        // view with items selected deselects instead of going
        // back / closing anything.
        event.stopPropagation()
        // [EscapeRef] `clearWorkflowSelection` is declared
        // further down in this component (after this effect).
        // We read from a ref that mirrors the callback so the
        // effect can stay positioned above the handler block.
        clearSelectionRef.current?.()
      }
    }
    const handleEnter = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !renameWorkflow) return
      const target = event.target as HTMLElement | null
      if (target && target.tagName === 'TEXTAREA') return
      event.preventDefault()
      handleConfirmRenameWorkflow()
    }
    const onKey = (event: KeyboardEvent) => {
      handleKeyDown(event)
      handleEnter(event)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [
    deleteConfirmWorkflow,
    deleteConfirmTemplate,
    renameWorkflow,
    renameDraft,
    bulkDeleteConfirmOpen,
    selectedWorkflowIds.length,
    view,
    // `clearWorkflowSelection` is read via `clearSelectionRef`
    // above, so it doesn't belong in deps. The ref is kept
    // up-to-date in a sibling effect.
  ])

  useEffect(() => {
    if (!renameWorkflow) return
    const handle = window.requestAnimationFrame(() => {
      const element = renameInputRef.current
      if (element) {
        element.focus()
        element.select()
      }
    })
    return () => window.cancelAnimationFrame(handle)
  }, [renameWorkflow])

  useEffect(() => {
    if (!activeWorkflowId && workflows.length > 0) {
      setActiveWorkflow(workflows[0].id)
    }
  }, [activeWorkflowId, workflows, setActiveWorkflow])

  // [WorkflowPersist] editorMount — capture initial render state.
  // Persist's internal hydrate may still be in flight here (Promise wrapper
  // resolves async), so hasHydrated() may report false even when storage
  // already has data. The follow-up logs (storage.getItem:resolved,
  // rehydrate:finish) confirm the eventual truth.
  useEffect(() => {
    const persistedView = typeof localStorage !== 'undefined'
      ? localStorage.getItem('workflow.view')
      : null
    const hasHydrated = (useWorkflowStore as unknown as { persist?: { hasHydrated?: () => boolean } })
      .persist?.hasHydrated?.()
    if (WORKFLOW_PERSIST_DEBUG()) {
      // eslint-disable-next-line no-console
      console.debug('[WorkflowPersist][editorMount]', JSON.stringify({
        workflowCount: workflows.length,
        activeWorkflowId,
        view,
        persistedView,
        hasHydrated: typeof hasHydrated === 'boolean' ? hasHydrated : null
      }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // [WorkflowPersist] viewMismatch — workflows exist but UI stuck on templates.
  useEffect(() => {
    if (view === 'templates' && workflows.length > 0) {
      const persistedView = typeof localStorage !== 'undefined'
        ? localStorage.getItem('workflow.view')
        : null
      if (WORKFLOW_PERSIST_DEBUG()) {
        // eslint-disable-next-line no-console
        console.debug('[WorkflowPersist][viewMismatch]', JSON.stringify({
          view,
          workflowCount: workflows.length,
          activeWorkflowId,
          persistedView
        }))
      }
    }
  }, [view, workflows.length, activeWorkflowId])

  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) || workflows[0] || null
  const visibleWorkflows = useMemo(
    () => workflows.filter((workflow) => !workflow.isTemplateDraft),
    [workflows]
  )
  // [WorkflowTemplate] Combine built-in templates with user-saved
  // templates into a single render list. Saved templates sort before
  // built-in ones (newest first by createdAt desc) so a freshly saved
  // card lands at the top of the grid instead of being buried under
  // the built-in starters. Built-in cards keep their existing order.
  const savedAsCards = useMemo(
    () => savedTemplates.map(userTemplateToCardShape),
    [savedTemplates]
  )
  const sortedSavedCards = useMemo(() => {
    return [...savedAsCards].sort((a, b) => {
      const aRecord = savedTemplates.find((t) => t.id === a.id)
      const bRecord = savedTemplates.find((t) => t.id === b.id)
      const ac = aRecord ? aRecord.createdAt : 0
      const bc = bRecord ? bRecord.createdAt : 0
      if (bc !== ac) return bc - ac
      return String(a.id).localeCompare(String(b.id))
    })
  }, [savedAsCards, savedTemplates])

  const combinedTemplates = useMemo<WorkflowTemplate[]>(
    () => [...sortedSavedCards, ...BUILT_IN_TEMPLATES],
    [sortedSavedCards]
  )
  const normalizedTemplateCategory: TemplateMediaFilter = TEMPLATE_MEDIA_FILTERS.includes(templateCategory as TemplateMediaFilter)
    ? templateCategory as TemplateMediaFilter
    : 'All'
  const filteredTemplates = normalizedTemplateCategory === 'All'
    ? combinedTemplates
    : combinedTemplates.filter((template) => templateMatchesMediaFilter(template, normalizedTemplateCategory))
  // [WorkflowTemplate] Distribute filtered templates into N columns
  // for the JS masonry. Round-robin so a card count `<= columnCount`
  // guarantees every column gets exactly one card (no empty column).
  // Memoized on the same inputs as the rendered list so re-renders
  // that don't change the list or column count skip the work.
  const templateColumns = useMemo(
    () => distributeTemplatesIntoColumns(filteredTemplates, templateColumnCount),
    [filteredTemplates, templateColumnCount]
  )
  // [WorkflowList] Stable ordering policy — sort by `createdAt` desc (with id
  // tie-break). The Zustand `workflows` array is kept in insertion order; the
  // dashboard renders a derived `[...filtered]` snapshot here. This means
  // every operation that bumps `updatedAt` (autosave, mount/open editor,
  // run, name rename, undo/redo, setActive, etc.) is a no-op for the visible
  // card order — only `createWorkflow` / `duplicateWorkflow` /
  // `importWorkflow` and `deleteWorkflow` change what the user sees.
  //
  // Acceptance cases (createdAt-desc — newest first, never insertion order):
  //   A. Create W1, W2, W3 → visual order: W3, W2, W1.
  //      Close/reopen side panel → still W3, W2, W1.
  //   B. Open W1, autosave fires `updateWorkflow` → W1 must NOT jump to top.
  //      Order remains W3, W2, W1 (updatedAt changes are ignored).
  //   C. Create W4 → W4, W3, W2, W1.
  //   D. Delete W2 → W4, W3, W1.
  // To switch to insertion order instead, do NOT just delete the comparator;
  // use a stable `sortOrder` field or render `workflows` directly (the array
  // is already in insertion order) so the policy remains explicit.
  const filteredWorkflows = useMemo(() => {
    const lowerSearch = workflowSearch.toLowerCase()
    const filtered = visibleWorkflows.filter((workflow) =>
      workflow.name.toLowerCase().includes(lowerSearch)
    )
    const sorted = [...filtered].sort((a, b) => {
      const ac = typeof a.createdAt === 'number' ? a.createdAt : 0
      const bc = typeof b.createdAt === 'number' ? b.createdAt : 0
      if (bc !== ac) return bc - ac
      return String(a.id).localeCompare(String(b.id))
    })
    if (WORKFLOW_LIST_DEBUG()) {
      // eslint-disable-next-line no-console
      console.debug('[WorkflowList][renderOrder]', JSON.stringify({
        policy: 'createdAt-desc',
        search: workflowSearch,
        order: sorted.map((w) => ({
          id: w.id,
          name: w.name,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          nodeCount: Array.isArray(w.nodes) ? w.nodes.length : 0
        }))
      }))
      // eslint-disable-next-line no-console
      console.debug('[WorkflowList][sortPolicy]', JSON.stringify({ policy: 'createdAt-desc' }))
    }
    return sorted
  }, [visibleWorkflows, workflowSearch])

  const handleCreateBlank = async () => {
    const workflow = createWorkflow(`Workflow ${visibleWorkflows.length + 1}`)
    setActiveWorkflow(workflow.id)
    await openWorkflowEditorWindow(workflow)
  }

  const handleUseTemplate = async (template: WorkflowTemplate) => {
    // [WorkflowTemplate] Branch on `source` so saved templates use
    // the user-template instantiator (which knows about
    // `template.workflow.nodes/edges` and renames the new workflow
    // to match the saved entry). Built-in templates keep the
    // existing path verbatim.
    const instantiatedWorkflow = template.source === 'user'
      ? instantiateUserTemplate(savedTemplates.find((t) => t.id === template.id) || {
          id: template.id,
          name: template.name,
          workflow: { nodes: template.nodes, edges: template.edges },
          nodeCount: template.nodes.length,
          edgeCount: template.edges.length,
          createdAt: 0,
          updatedAt: 0,
          source: 'user',
          ...(template.thumbnail ? { thumbnail: template.thumbnail } : {})
        })
      : instantiateTemplate(template)
    const workflow: Workflow = {
      ...instantiatedWorkflow,
      isTemplateDraft: true,
      sourceTemplateId: template.id
    }
    importWorkflow(workflow)
    await openWorkflowEditorWindow(workflow, { fromTemplate: true })
  }

  // [WorkflowTemplate] Delete a saved template from chrome.storage.
  // Wired to a small "Delete" affordance on user cards only — built-in
  // cards keep their existing Use-only path. Failure surfaces an
  // alert; success re-reads the storage list (the onChanged listener
  // would also fire, but the explicit refresh avoids a one-render
  // flicker on slow MV3 wake-ups).
  const handleDeleteSavedTemplate = async (template: UserWorkflowTemplate) => {
    setDeleteConfirmTemplate(null)
    try {
      await deleteWorkflowTemplate(template.id)
      await refreshSavedTemplates()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to delete template.')
    }
  }

  const handleOpenWorkflow = async (workflow: Workflow) => {
    setActiveWorkflow(workflow.id)
    await openWorkflowEditorWindow(workflow)
  }

  const handleDuplicateWorkflow = (workflow: Workflow) => {
    duplicateWorkflow(workflow.id)
  }

  const handleRenameWorkflow = (workflow: Workflow) => {
    setRenameDraft(workflow.name)
    setRenameWorkflow(workflow)
  }

  const handleConfirmRenameWorkflow = () => {
    if (!renameWorkflow) return
    const nextName = renameDraft.trim()
    if (!nextName) return
    const renameId = renameWorkflow.id
    setRenameWorkflow(null)
    updateWorkflow(renameId, { name: nextName })
  }

  const handleCancelRenameWorkflow = () => {
    setRenameWorkflow(null)
    setRenameDraft('')
  }

  const handleDeleteWorkflow = (workflow: Workflow) => {
    setDeleteConfirmWorkflow(workflow)
  }

  const handleConfirmDeleteWorkflow = () => {
    if (!deleteConfirmWorkflow) return
    const removedId = deleteConfirmWorkflow.id
    setDeleteConfirmWorkflow(null)
    deleteWorkflow(removedId)
    if (activeWorkflowId === removedId) {
      setView('workflows')
    }
  }

  // [WorkflowEditor] Multi-select handlers. Pure local state
  // mutations; never touch `deleteWorkflow` here — that happens
  // only after the bulk delete confirm modal is acknowledged.
  // Order is irrelevant for correctness, so we keep insertion
  // order to make DevTools snapshots readable.
  const toggleSelectWorkflow = useCallback((id: string) => {
    setSelectedWorkflowIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      return [...prev, id]
    })
  }, [])

  const clearWorkflowSelection = useCallback(() => {
    setSelectedWorkflowIds([])
  }, [])
  // [EscapeRef] Keep the forward-declared ref pointing at the
  // latest callback so the keyboard handler (declared earlier in
  // this component) always reads the current closure.
  useEffect(() => {
    clearSelectionRef.current = clearWorkflowSelection
  }, [clearWorkflowSelection])

  // [WorkflowEditor] "Select all" acts only on currently filtered
  // workflows. The user sees a list filtered by search; selecting
  // items hidden behind a search filter would be surprising, so
  // we constrain the operation to the visible set. If every
  // visible item is already selected, the second click clears
  // the entire selection (not just the visible subset — clearing
  // only the visible subset is rarely what the user wants).
  const toggleSelectAllVisible = useCallback((visibleIds: string[]) => {
    if (visibleIds.length === 0) return
    setSelectedWorkflowIds((prev) => {
      const prevSet = new Set(prev)
      const allVisibleSelected = visibleIds.every((id) => prevSet.has(id))
      if (allVisibleSelected) {
        // Drop only the visible ids from the selection — preserve
        // any selection entries that don't correspond to currently
        // visible workflows (keeps behavior predictable even when
        // the user has a multi-search-history edge case).
        const visibleSet = new Set(visibleIds)
        return prev.filter((id) => !visibleSet.has(id))
      }
      // Add all visible ids (idempotent against any prior partial
      // overlap).
      const next = [...prev]
      const nextSet = new Set(prev)
      for (const id of visibleIds) {
        if (!nextSet.has(id)) {
          next.push(id)
          nextSet.add(id)
        }
      }
      return next
    })
  }, [])

  // [WorkflowEditor] Bulk delete request. Opens the confirm
  // modal — does NOT delete anything yet. The actual delete fires
  // from `handleConfirmBulkDelete` after the user clicks "Delete"
  // in the modal. We deliberately gate the destructive action
  // here so a stray "Select all + Delete" is always reversible.
  const handleBulkDeleteRequest = useCallback(() => {
    if (selectedWorkflowIds.length === 0) return
    setBulkDeleteConfirmOpen(true)
  }, [selectedWorkflowIds])

  const handleConfirmBulkDelete = useCallback(() => {
    // Snapshot ids before closing the modal — `selectedWorkflowIds`
    // mutates during the per-id `deleteWorkflow` calls (which
    // bumps workflow store and triggers re-renders) and we want
    // to delete exactly the ids the user confirmed, no more.
    const idsToDelete = selectedWorkflowIds.slice()
    const wasActiveSelected = activeWorkflowId !== null
      && idsToDelete.includes(activeWorkflowId)
    setBulkDeleteConfirmOpen(false)
    setSelectedWorkflowIds([])
    for (const id of idsToDelete) {
      deleteWorkflow(id)
    }
    if (wasActiveSelected) setView('workflows')
  }, [selectedWorkflowIds, deleteWorkflow, activeWorkflowId])

  const handleImportWorkflow = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const text = await file.text()
      const payload = JSON.parse(text) as unknown

      // [AssetBundle] Bundle path: a `.aiflow.json` payload carries
      // workflow + assets. Decode first, surface partial failures
      // as alerts only when something is broken. A fully-successful
      // import is silent (no toast library in this codebase).
      const bundle = parseWorkflowAssetBundle(payload)
      if (bundle) {
        const result = await importWorkflowAssetBundle(bundle)
        if (!result.ok || !result.workflow) {
          const firstError = result.errors[0] || 'Asset bundle was empty or unreadable.'
          window.alert(`Asset bundle import failed.\n\n${firstError}`)
          return
        }
        // Warn the user when the local IndexedDB was missing
        // assets the bundle expected — the imported workflow will
        // still open, but those slots will show placeholder.
        if (result.missingAssetIds.length > 0) {
          // eslint-disable-next-line no-console
          console.warn('[AssetBundle] imported workflow has missing assets', {
            missingAssetIds: result.missingAssetIds,
            count: result.missingAssetIds.length
          })
        }
        importWorkflow(result.workflow)
        await openWorkflowEditorWindow(result.workflow)
        return
      }

      // Plain JSON path — keep the original behavior untouched.
      const workflow = normalizeImportedWorkflow(payload)
      if (!workflow) {
        window.alert('This file does not look like a workflow export.')
        return
      }
      importWorkflow(workflow)
      await openWorkflowEditorWindow(workflow)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to import workflow.')
    }
  }

  const handleRunWorkflow = async (workflow: Workflow) => {
    setActiveWorkflow(workflow.id)
    const runWarning = getWorkflowRunWarning(workflow)
    if (runWarning) {
      window.alert(runWarning)
      return
    }
    try {
      await openWorkflowEditorWindow(workflow)
      probeRunRequest('dashboard-quick-run', workflow.id)
      await runPipeline(workflow)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to run workflow.')
    }
  }

  if (view === 'editor' && activeWorkflow) {
    return (
      <WorkflowCanvas
        workflow={activeWorkflow}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={onToggleSidebar}
        onBackToDashboard={() => setView('workflows')}
      />
    )
  }

  return (
    <div className="flex h-full flex-col bg-[#0F0F0F]">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json,.aiflow.json"
        className="hidden"
        onChange={handleImportWorkflow}
      />

      <div className="flex min-h-[64px] items-center justify-between gap-3 border-b border-white/[0.06] px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#7C5CFF]/10 text-[#B8A8FF]">
            <WorkflowIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[12px] font-medium text-white/80">Workflow</h2>
            <p className="truncate text-[11px] text-white/30">{visibleWorkflows.length} saved flows</p>
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-[#1A1A1A] p-1">
          <button
            type="button"
            onClick={() => setView('templates')}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-md px-3 text-[11px] font-medium transition-colors',
              view === 'templates' ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/[0.06] hover:text-white/75'
            )}
          >
            <LayoutTemplate className="h-3.5 w-3.5" />
            Templates
          </button>
          <button
            type="button"
            onClick={() => setView('workflows')}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-md px-3 text-[11px] font-medium transition-colors',
              view === 'workflows' ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/[0.06] hover:text-white/75'
            )}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Workflows
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            title="Asset storage"
            onClick={() => {
              setStorageModalOpen(true)
              void refreshStorageReport()
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1A1A1A] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <HardDrive className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Import workflow"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1A1A1A] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <Upload className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleCreateBlank}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-[#7C5CFF] px-3 text-[11px] font-medium text-white transition-colors hover:bg-[#6B4EE0]"
          >
            <Plus className="h-4 w-4" />
            New
          </button>
        </div>
      </div>

      {view === 'templates' && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {TEMPLATE_MEDIA_FILTERS.map((category) => (
                <button
                  type="button"
                  key={category}
                  onClick={() => setTemplateCategory(category)}
                  className={cn(
                    'h-8 shrink-0 rounded-lg px-3 text-[11px] font-medium transition-colors',
                    normalizedTemplateCategory === category
                      ? 'bg-[#7C5CFF]/15 text-[#B8A8FF]'
                      : 'bg-white/[0.04] text-white/45 hover:bg-white/[0.07] hover:text-white/75'
                  )}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>

          {/* [WorkflowTemplate] Outer scroll container owns the
              vertical scroll only. `overflow-x-hidden` guards
              against any inner element overflowing horizontally.
              `min-w-0` lets the flex item shrink to fit the column,
              since `flex-1` alone has `min-width: auto` which would
              otherwise keep it at content-min and overflow.
              `templatesScrollRef` is observed by a ResizeObserver
              that drives `templateColumnCount` for the JS masonry
              below. */}
          <div
            ref={templatesScrollRef}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pr-1"
          >
            {/* [WorkflowTemplate] Inner JS masonry — a flex row of N
                equal-width columns. Each column stacks cards top-to-
                bottom. This replaced the previous CSS-columns
                implementation because `column-fill: balance` left
                columns empty when card count < `column-count` (e.g.
                3 saved cards at 1229px collapsed into 2 columns with
                column 3 unused → ≈258px dead right area). Round-robin
                distribution guarantees every column gets at least one
                card whenever the count permits it. */}
            <div className="templates-masonry">
              {templateColumns.map((column, columnIndex) => (
                <div
                  key={`templates-col-${columnIndex}`}
                  className="templates-masonry-column"
                >
                  {column.map((template) => {
                    const colors = NODE_COLORS[template.accent]
                    const isUserTemplate = template.source === 'user'
                    const hasCover = Boolean(template.thumbnail)
              // [WorkflowTemplate] Two card shapes share one column.
              // - hasCover: <img className="block w-full h-auto"> at
              //   the top — intrinsic ratio, no fixed container, no
              //   object-cover. Title / category / description
              //   overlay the cover (gradient + absolute bottom).
              //   Body below is just tags + footer.
              // - !hasCover: no hero placeholder — the body is the
              //   whole card (header + description + tags + footer).
              //
              // The container uses CSS columns (masonry-style): tall
              // portrait cards no longer stretch their grid row, so
              // built-in text-only cards flow into the gap-free
              // columns instead of being dragged into a ragged
              // grid.
              //
              // Architecture: two layers.
              //   - OUTER: scroll container with `flex-1`,
              //     `overflow-y-auto`, `overflow-x-hidden`. It owns
              //     vertical scrolling and blocks any horizontal
              //     spill.
              //   - INNER: auto-height `.templates-masonry` div with
              //     `column-count: 1/2/3/4`. CSS columns only
              //     balance correctly when the element can grow
              //     vertically — putting `columns-*` on the same
              //     element that has a constrained height (the
              //     outer scroll container) would force content to
              //     fragment into extra columns to fit the fixed
              //     height. Keeping it on the auto-height inner
              //     div makes content flow top-to-bottom and lets
              //     the outer handle vertical scrolling.
              //
              // Each card is wrapped in a `.template-masonry-item`
              // div carrying `break-inside-avoid` + `margin-bottom:
              // 12px`. That keeps cards atomic across columns and
              // gives a uniform vertical gap.
              //
              // `min-w-0` on the outer lets the flex item shrink
              // below its content-min width — without it, the
              // flex item has `min-width: auto` and would refuse
              // to shrink, which previously manifested as a
              // horizontal scrollbar at narrow viewports.
              const cardClass = cn(
                // [WorkflowTemplate] `w-full` keeps the card
                // filling its column width. The `mb-3` and
                // `break-inside-avoid` masonry glue lives on the
                // outer wrapper (`.template-masonry-item`) so the
                // spacing and break avoidance are independent of
                // the card's own visual style. The wrapper is
                // what CSS columns see; the card root just
                // renders the visual.
                'flex w-full flex-col overflow-hidden rounded-lg border border-white/[0.06] bg-[#171717] transition-colors hover:border-[#7C5CFF]/55',
                colors.border,
                'border-l-2 border-white/[0.06]'
              )
              const footerClass = 'mt-1 flex items-center justify-between gap-2'
              return (
                <div
                  key={template.id}
                  className="flex w-full"
                >
                  <div
                    className={cardClass}
                    onDoubleClick={(event) => {
                      if ((event.target as HTMLElement).closest('button')) return
                      handleUseTemplate(template)
                    }}
                  >
{hasCover ? (
                    <>
                      {/* [WorkflowTemplate] Cover image with title /
                          category badge / saved-description rendered
                          INSIDE the cover as a bottom overlay. The
                          overlay block gets a bottom-to-black
                          gradient so white text stays legible on any
                          JPEG. Tags + footer live below the cover
                          (not floating on the image) so the
                          action row stays crisp on the dark card
                          background.

                          The cover sizes itself from the
                          thumbnail's intrinsic ratio: the `<img>`
                          is `w-full h-auto` (no `aspect-video`,
                          no `object-cover`, no `max-height`) so a
                          9:16 portrait renders as a 9:16 cover and
                          a 16:9 landscape renders as a 16:9 cover.
                          `aspect-video` and `object-cover` were
                          cropping portrait thumbnails because they
                          forced the container to a fixed 16:9 frame
                          regardless of the source image. With
                          intrinsic sizing, every thumbnail renders
                          full-frame with no letterboxing or crop. */}
                      <div className="relative w-full overflow-hidden border-b border-white/[0.06] bg-[#111]">
                        <img
                          src={template.thumbnail}
                          alt={`${template.name} preview`}
                          className="block h-auto w-full"
                          draggable={false}
                        />
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-b from-transparent via-black/40 to-black/80"
                        />
                        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Sparkles className={cn('h-4 w-4 shrink-0 text-white/85')} />
                              <h3 className="truncate text-[12px] font-medium text-white">{template.name}</h3>
                            </div>
                            <p className="mt-1 line-clamp-2 text-[11px] leading-[16px] text-white/70">{template.description}</p>
                          </div>
                          <span className="shrink-0 rounded-md bg-white/15 px-2 py-1 text-[10px] font-medium text-white">
                            {template.category}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-3 p-3">
                        {template.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {template.tags.map((tag) => (
                              <span key={tag} className="rounded-md bg-white/[0.05] px-2 py-1 text-[10px] text-white/35">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className={footerClass}>
                          <div className="flex items-center gap-3 text-[11px] text-white/30">
                            <span className="inline-flex items-center gap-1">
                              <WorkflowIcon className="h-3 w-3" aria-hidden="true" />
                              {template.nodes.length} nodes
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Zap className="h-3 w-3" aria-hidden="true" />
                              {template.edges.length} links
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {isUserTemplate && (
                              <button
                                type="button"
                                title="Delete template"
                                onClick={() => {
                                  const saved = savedTemplates.find((t) => t.id === template.id)
                                  if (saved) setDeleteConfirmTemplate(saved)
                                }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 transition-colors hover:bg-rose-500/15 hover:text-rose-200"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleUseTemplate(template)}
                              className="flex h-8 items-center gap-1.5 rounded-lg bg-[#7C5CFF]/15 px-3 text-[11px] font-medium text-[#B8A8FF] transition-colors hover:bg-[#7C5CFF]/25"
                            >
                              <Play className="h-3.5 w-3.5" />
                              Use
                            </button>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      {/* [WorkflowTemplate] Text-only card for
                          templates with no thumbnail (built-ins,
                          plus saved templates whose source nodes
                          could not be resolved). No hero placeholder
                          — the body wraps directly to a compact
                          padded block so the card height is driven
                          by content (header + description + tags +
                          footer). The Sparkles accent sits inline
                          with the title instead of inside a giant
                          empty block. */}
                      <div className="flex flex-col gap-3 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Sparkles className={cn('h-4 w-4', colors.text)} />
                              <h3 className="truncate text-[12px] font-medium text-white/80">{template.name}</h3>
                            </div>
                            <p className="mt-1 line-clamp-2 text-[11px] leading-[18px] text-white/40">{template.description}</p>
                          </div>
                          <span className="rounded-md bg-white/[0.05] px-2 py-1 text-[10px] font-medium text-white/40">
                            {template.category}
                          </span>
                        </div>

                        {template.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {template.tags.map((tag) => (
                              <span key={tag} className="rounded-md bg-white/[0.05] px-2 py-1 text-[10px] text-white/35">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className={footerClass}>
                          <div className="flex items-center gap-3 text-[11px] text-white/30">
                            <span className="inline-flex items-center gap-1">
                              <WorkflowIcon className="h-3 w-3" aria-hidden="true" />
                              {template.nodes.length} nodes
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Zap className="h-3 w-3" aria-hidden="true" />
                              {template.edges.length} links
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {isUserTemplate && (
                              <button
                                type="button"
                                title="Delete template"
                                onClick={() => {
                                  const saved = savedTemplates.find((t) => t.id === template.id)
                                  if (saved) setDeleteConfirmTemplate(saved)
                                }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 transition-colors hover:bg-rose-500/15 hover:text-rose-200"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleUseTemplate(template)}
                              className="flex h-8 items-center gap-1.5 rounded-lg bg-[#7C5CFF]/15 px-3 text-[11px] font-medium text-[#B8A8FF] transition-colors hover:bg-[#7C5CFF]/25"
                            >
                              <Play className="h-3.5 w-3.5" />
                              Use
                            </button>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                  </div>
                </div>
              )
            })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {view === 'workflows' && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/25" />
              <input
                value={workflowSearch}
                onChange={(event) => setWorkflowSearch(event.target.value)}
                placeholder="Search workflows"
                className="h-9 w-full rounded-lg border border-white/[0.06] bg-[#171717] pl-9 pr-3 text-[11px] text-white/65 outline-none transition-colors placeholder:text-white/20 focus:border-white/15"
              />
            </div>
            {/* [WorkflowEditor] Multi-select toolbar. Hidden when
                nothing is selected (the per-card checkbox is the
                primary affordance) so the toolbar stays visually
                quiet until the user has expressed intent. When the
                user has selected ≥1 card, we swap the Import button
                for a "Delete N selected" affordance — this keeps the
                destructive action at the same screen position the
                user's eye is already tracking, and the Import button
                returns when selection clears. */}
            {selectedWorkflowIds.length > 0 ? (
              <>
                <span
                  aria-live="polite"
                  className="rounded-md bg-[#7C5CFF]/15 px-2 py-1 text-[11px] font-medium text-[#B8A8FF]"
                >
                  {selectedWorkflowIds.length} selected
                </span>
                <button
                  type="button"
                  title="Clear selection"
                  onClick={clearWorkflowSelection}
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1A1A1A] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title={`Delete ${selectedWorkflowIds.length} workflow${selectedWorkflowIds.length === 1 ? '' : 's'}`}
                  onClick={handleBulkDeleteRequest}
                  className="flex h-9 items-center gap-1.5 rounded-lg bg-red-500/15 px-3 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/25"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              </>
            ) : (
              <button
                type="button"
                title="Import workflow"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1A1A1A] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                <Upload className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* [WorkflowEditor] "Select all" sub-toolbar. Sits between
              the search/import row and the grid so the user has a
              visible mode switch ("selection mode on") before they
              start checking cards. Hidden when the list is empty —
              selecting nothing has no meaning. */}
          {filteredWorkflows.length > 0 && (() => {
            const visibleIds = filteredWorkflows.map((w) => w.id)
            const allVisibleSelected = visibleIds.length > 0
              && visibleIds.every((id) => selectedWorkflowIds.includes(id))
            const visibleSelectedCount = visibleIds.filter((id) => selectedWorkflowIds.includes(id)).length
            return (
              <div className="flex min-h-8 items-center gap-3">
                <button
                  type="button"
                  onClick={() => toggleSelectAllVisible(visibleIds)}
                  aria-pressed={allVisibleSelected}
                  className={cn(
                    'group flex h-8 items-center gap-2 rounded-md px-0.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#7C5CFF]/30',
                    allVisibleSelected
                      ? 'text-[#C8BCFF]'
                      : 'text-white/45 hover:text-white/72'
                  )}
                >
                  <span className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-all',
                    allVisibleSelected
                      ? 'border-[#8D73FF] bg-[#7C5CFF] text-white shadow-[0_0_12px_rgba(124,92,255,0.22)]'
                      : 'border-white/20 bg-transparent text-transparent group-hover:border-white/35'
                  )}>
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>
                  {allVisibleSelected ? 'Deselect all' : 'Select all'}
                </button>
                {visibleSelectedCount > 0 && (
                  <span className="text-[10px] font-medium text-white/25">
                    {visibleSelectedCount} of {visibleIds.length} selected
                  </span>
                )}
              </div>
            )
          })()}

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {filteredWorkflows.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white/[0.04] text-white/25">
                  <FolderOpen className="h-5 w-5" />
                </div>
                <p className="mt-3 text-[11px] font-medium text-white/50">No workflows</p>
                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setView('templates')}
                    className="flex h-9 items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 text-[11px] font-medium text-white/65 transition-colors hover:bg-white/[0.1] hover:text-white"
                  >
                    <LayoutTemplate className="h-4 w-4" />
                    Templates
                  </button>
                  <button
                    type="button"
                    onClick={handleCreateBlank}
                    className="flex h-9 items-center gap-1.5 rounded-lg bg-[#7C5CFF] px-3 text-[11px] font-medium text-white transition-colors hover:bg-[#6B4EE0]"
                  >
                    <Plus className="h-4 w-4" />
                    New
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
                {filteredWorkflows.map((workflow) => {
                  const isSelected = selectedWorkflowIds.includes(workflow.id)
                  return (
                    <div
                      key={workflow.id}
                      onDoubleClick={() => handleOpenWorkflow(workflow)}
                      className={cn(
                        'flex min-h-[118px] flex-col rounded-lg border bg-[#171717] p-3 transition-colors hover:border-[#7C5CFF]/55',
                        isSelected
                          ? 'border-white/[0.06] bg-[#7C5CFF]/[0.04]'
                          : 'border-white/[0.06]'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        {/* [WorkflowEditor] Per-card selection
                            checkbox. Sits at the start of the
                            header row, to the left of the name.
                            `stopPropagation` covers both bubbling
                            click + doubleclick paths so the
                            user's intent is unambiguous (clicking
                            the checkbox never opens the workflow,
                            only toggles selection). The visual
                            mirrors a desktop file-manager check:
                            small, square, accent when on, ghost
                            when off. */}
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={isSelected}
                          aria-label={isSelected ? `Deselect ${workflow.name}` : `Select ${workflow.name}`}
                          title={isSelected ? 'Deselect' : 'Select'}
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleSelectWorkflow(workflow.id)
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors',
                            isSelected
                              ? 'border-[#7C5CFF]/45 bg-[#7C5CFF]/20 text-[#B8A8FF]'
                              : 'border-white/[0.1] bg-transparent text-transparent hover:border-white/25 hover:bg-white/[0.06] hover:text-white/55'
                          )}
                        >
                          <Check className="h-3.5 w-3.5" strokeWidth={3} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenWorkflow(workflow)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <h3 className="truncate text-[12px] font-medium text-white/80">{workflow.name}</h3>
                          <p className="mt-1 line-clamp-1 text-[11px] leading-[16px] text-white/35">
                            {workflow.description || 'Local workflow'}
                          </p>
                        </button>
                        <button
                          type="button"
                          title="Run"
                          onClick={() => handleRunWorkflow(workflow)}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#7C5CFF]/15 text-[#B8A8FF] transition-colors hover:bg-[#7C5CFF]/25"
                        >
                          <Play className="h-3.5 w-3.5" />
                        </button>
                      </div>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {(workflow.tags?.length ? workflow.tags : ['Workflow']).slice(0, 3).map((tag) => (
                        <span key={tag} className="rounded-md bg-white/[0.05] px-2 py-1 text-[10px] text-white/35">
                          {tag}
                        </span>
                      ))}
                    </div>

                    <div className="mt-auto flex items-center justify-between pt-3">
                      <div className="text-[11px] text-white/30">
                        <span>{workflow.nodes.length} nodes</span>
                        <span className="mx-2">/</span>
                        <span>{formatDate(workflow.updatedAt)}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          title="Rename"
                          onClick={() => handleRenameWorkflow(workflow)}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/75"
                        >
                          <FileText className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Duplicate"
                          onClick={() => handleDuplicateWorkflow(workflow)}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/75"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Export"
                          onClick={() => void downloadWorkflowAssetBundle(workflow)}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/75"
                        >
                          <FileDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Delete"
                          onClick={() => handleDeleteWorkflow(workflow)}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
      {deleteConfirmWorkflow && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="workflow-confirm-title"
          aria-describedby="workflow-confirm-desc"
          className="workflow-confirm-overlay"
          onClick={() => setDeleteConfirmWorkflow(null)}
        >
          <div
            className="workflow-confirm-modal workflow-template-delete-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="workflow-template-delete-content">
              <div className="workflow-confirm-icon">
                <Trash2 className="h-[18px] w-[18px]" />
              </div>
              <div className="workflow-confirm-body">
                <h2 id="workflow-confirm-title" className="workflow-confirm-title">
                  Delete {deleteConfirmWorkflow.name.replace(/\s+workflow$/i, '')} Workflow
                </h2>
                <p id="workflow-confirm-desc" className="workflow-confirm-desc">
                  This workflow will be permanently removed.
                </p>
              </div>
            </div>
            <div className="workflow-confirm-actions">
              <button
                type="button"
                className="workflow-confirm-cancel"
                onClick={() => setDeleteConfirmWorkflow(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="workflow-confirm-delete"
                onClick={handleConfirmDeleteWorkflow}
              >
                <Trash2 className="h-4 w-4" />
                Delete workflow
              </button>
            </div>
          </div>
        </div>
      )}
      {/* [WorkflowEditor] Bulk delete confirm modal. Reuses the
          same `workflow-confirm-overlay` + `workflow-confirm-modal`
          CSS classes as the single-delete dialog so the modal
          markup and behavior stay uniform. The body intentionally
          does NOT list individual names — selection count is the
          single decision signal the user needs to confirm. Cancel
          closes without action; Delete delegates to
          `handleConfirmBulkDelete` which loops over the snapshotted
          ids, then clears selection. */}
      {bulkDeleteConfirmOpen && (() => {
        const ids = selectedWorkflowIds
        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-delete-confirm-title"
            aria-describedby="bulk-delete-confirm-desc"
            className="workflow-confirm-overlay"
            onClick={() => setBulkDeleteConfirmOpen(false)}
          >
            <div
              className="workflow-confirm-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="workflow-confirm-icon">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="workflow-confirm-body">
                <h2 id="bulk-delete-confirm-title" className="workflow-confirm-title">
                  Delete {ids.length} workflow{ids.length === 1 ? '' : 's'}?
                </h2>
                <p id="bulk-delete-confirm-desc" className="workflow-confirm-desc">
                  This action cannot be undone.
                </p>
              </div>
              <div className="workflow-confirm-actions">
                <button
                  type="button"
                  className="workflow-confirm-cancel"
                  onClick={() => setBulkDeleteConfirmOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="workflow-confirm-delete"
                  onClick={handleConfirmBulkDelete}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete{ids.length > 1 ? ` ${ids.length}` : ''}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
      {deleteConfirmTemplate && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="template-confirm-title"
          aria-describedby="template-confirm-desc"
          className="workflow-confirm-overlay"
          onClick={() => setDeleteConfirmTemplate(null)}
        >
          <div
            className="workflow-confirm-modal workflow-template-delete-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="workflow-template-delete-content">
              <div className="workflow-confirm-icon">
                <Trash2 className="h-[18px] w-[18px]" />
              </div>
              <div className="workflow-confirm-body">
                <h2 id="template-confirm-title" className="workflow-confirm-title">
                  Delete {deleteConfirmTemplate.name.replace(/\s+template$/i, '')} Template
                </h2>
                <p id="template-confirm-desc" className="workflow-confirm-desc">
                  This template will be permanently removed.
                </p>
              </div>
            </div>
            <div className="workflow-confirm-actions">
              <button
                type="button"
                className="workflow-confirm-cancel"
                onClick={() => setDeleteConfirmTemplate(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="workflow-confirm-delete"
                onClick={() => {
                  void handleDeleteSavedTemplate(deleteConfirmTemplate)
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete template
              </button>
            </div>
          </div>
        </div>
      )}
      {renameWorkflow && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="workflow-rename-title"
          className="workflow-confirm-overlay"
          onClick={handleCancelRenameWorkflow}
        >
          <div
            className="workflow-confirm-modal workflow-template-delete-modal workflow-rename-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="workflow-template-delete-content">
              <div className="workflow-rename-icon">
                <Pencil className="h-[18px] w-[18px]" />
              </div>
              <div className="workflow-confirm-body">
                <h2 id="workflow-rename-title" className="workflow-confirm-title">
                  Rename workflow
                </h2>
                <p className="workflow-confirm-desc">
                  Enter a clear name for this workflow.
                </p>
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.stopPropagation()
                      handleConfirmRenameWorkflow()
                    }
                  }}
                  placeholder="Workflow name"
                  className="workflow-rename-input"
                />
              </div>
            </div>
            <div className="workflow-confirm-actions">
              <button
                type="button"
                className="workflow-confirm-cancel"
                onClick={handleCancelRenameWorkflow}
              >
                Cancel
              </button>
              <button
                type="button"
                className="workflow-confirm-delete"
                onClick={handleConfirmRenameWorkflow}
                disabled={!renameDraft.trim()}
              >
                <Pencil className="h-4 w-4" />
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}
      {storageModalOpen && (
        <AssetStorageModal
          report={storageReport}
          estimate={storageEstimate}
          orphan={storageOrphan}
          loading={storageLoading}
          error={storageError}
          confirmDelete={storageConfirmDelete}
          deleting={storageDeleting}
          deleteSummary={storageDeleteSummary}
          onRefresh={() => void refreshStorageReport()}
          onRequestCleanup={() => void beginStorageCleanup()}
          onCancelCleanup={cancelStorageCleanup}
          onConfirmCleanup={() => void confirmStorageCleanup()}
          onClose={closeStorageModal}
        />
      )}
    </div>
  )
}

export const WorkflowEditorWindow: React.FC = () => {
  const workflows = useWorkflowStore((s) => s.workflows)
  const activeWorkflowId = useWorkflowStore((s) => s.activeWorkflowId)
  const hydrateFromStorage = useWorkflowStore((s) => s.hydrateFromStorage)
  const createWorkflow = useWorkflowStore((s) => s.createWorkflow)
  const importWorkflow = useWorkflowStore((s) => s.importWorkflow)
  const updateWorkflow = useWorkflowStore((s) => s.updateWorkflow)
  const deleteWorkflow = useWorkflowStore((s) => s.deleteWorkflow)
  const setActiveWorkflow = useWorkflowStore((s) => s.setActiveWorkflow)

  const [isReady, setIsReady] = useState(false)
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [saveDraftOpen, setSaveDraftOpen] = useState(false)
  const [saveDraftName, setSaveDraftName] = useState('')
  const saveDraftInputRef = useRef<HTMLInputElement>(null)
  const allowWindowCloseRef = useRef(false)
  const initialTemplateDraftSnapshotRef = useRef<string | null>(null)
  const openedFromTemplateRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      await hydrateFromStorage().catch(() => {})

      const params = new URLSearchParams(window.location.search)
      let nextWorkflowId = params.get('workflowId')
      openedFromTemplateRef.current = params.get('fromTemplate') === '1'

      try {
        const pending = await chrome.storage.local.get('_pendingWorkflowEditor')
        const pendingData = pending._pendingWorkflowEditor as {
          workflow?: Workflow
          workflowId?: string
          fromTemplate?: boolean
          timestamp?: number
        } | undefined
        const isFresh = pendingData?.timestamp && Date.now() - pendingData.timestamp < 5 * 60 * 1000
        const matchesQuery = !nextWorkflowId || pendingData?.workflowId === nextWorkflowId

        if (pendingData?.workflow && isFresh && matchesQuery) {
          const pendingWorkflow: Workflow = pendingData.fromTemplate
            ? { ...pendingData.workflow, isTemplateDraft: true }
            : pendingData.workflow
          openedFromTemplateRef.current = pendingData.fromTemplate === true || pendingWorkflow.isTemplateDraft === true
          importWorkflow(pendingWorkflow)
          nextWorkflowId = pendingWorkflow.id
          await chrome.storage.local.remove('_pendingWorkflowEditor')
        }
      } catch {
        // Pending handoff is best-effort; persisted workflows remain the source of truth.
      }

      let state = useWorkflowStore.getState()
      if (!nextWorkflowId) {
        nextWorkflowId = state.activeWorkflowId || state.workflows[0]?.id || null
      }

      if (!nextWorkflowId) {
        const workflow = createWorkflow('Untitled Workflow')
        nextWorkflowId = workflow.id
        state = useWorkflowStore.getState()
      }

      setActiveWorkflow(nextWorkflowId)

      const openedWorkflow = useWorkflowStore.getState().workflows.find((item) => item.id === nextWorkflowId)
      openedFromTemplateRef.current = openedFromTemplateRef.current || openedWorkflow?.isTemplateDraft === true
      initialTemplateDraftSnapshotRef.current = openedFromTemplateRef.current && openedWorkflow
        ? templateDraftSnapshot(openedWorkflow)
        : null

      if (!cancelled) {
        setWorkflowId(nextWorkflowId)
        setIsReady(true)
      }
    }

    init()

    return () => {
      cancelled = true
    }
  }, [createWorkflow, hydrateFromStorage, importWorkflow, setActiveWorkflow])

  const workflow = workflows.find((item) => item.id === workflowId)
    || workflows.find((item) => item.id === activeWorkflowId)
    || workflows[0]
    || null

  const closeWindowAfterPersist = useCallback(() => {
    allowWindowCloseRef.current = true
    window.setTimeout(() => window.close(), 180)
  }, [])

  const requestEditorClose = useCallback(() => {
    const current = useWorkflowStore.getState().workflows.find((item) => item.id === workflowId)
      || useWorkflowStore.getState().workflows.find((item) => item.id === activeWorkflowId)
    if (current && (openedFromTemplateRef.current || current.isTemplateDraft)) {
      const changed = initialTemplateDraftSnapshotRef.current !== templateDraftSnapshot(current)
      if (changed) {
        setSaveDraftName(current.name)
        setSaveDraftOpen(true)
        return
      }
      deleteWorkflow(current.id)
      closeWindowAfterPersist()
      return
    }
    allowWindowCloseRef.current = true
    window.close()
  }, [activeWorkflowId, closeWindowAfterPersist, deleteWorkflow, workflowId])

  const saveTemplateDraftToWorkflows = useCallback(() => {
    if (!workflowId || !saveDraftName.trim()) return
    updateWorkflow(workflowId, {
      name: saveDraftName.trim(),
      isTemplateDraft: false,
      sourceTemplateId: undefined
    })
    setSaveDraftOpen(false)
    closeWindowAfterPersist()
  }, [closeWindowAfterPersist, saveDraftName, updateWorkflow, workflowId])

  const discardTemplateDraft = useCallback(() => {
    if (!workflowId) return
    deleteWorkflow(workflowId)
    setSaveDraftOpen(false)
    closeWindowAfterPersist()
  }, [closeWindowAfterPersist, deleteWorkflow, workflowId])

  useEffect(() => {
    if (!saveDraftOpen) return
    const timer = window.setTimeout(() => {
      saveDraftInputRef.current?.focus()
      saveDraftInputRef.current?.select()
    }, 30)
    return () => window.clearTimeout(timer)
  }, [saveDraftOpen])

  useEffect(() => {
    const protectTemplateDraft = (event: BeforeUnloadEvent) => {
      if (allowWindowCloseRef.current) return
      const current = useWorkflowStore.getState().workflows.find((item) => item.id === workflowId)
      if (!current || (!openedFromTemplateRef.current && !current.isTemplateDraft)) return
      if (initialTemplateDraftSnapshotRef.current === templateDraftSnapshot(current)) return
      event.preventDefault()
      event.returnValue = ''
    }
    const discardDraftAfterNativeClose = () => {
      if (allowWindowCloseRef.current) return
      const current = useWorkflowStore.getState().workflows.find((item) => item.id === workflowId)
      if (current && (openedFromTemplateRef.current || current.isTemplateDraft)) deleteWorkflow(current.id)
    }
    window.addEventListener('beforeunload', protectTemplateDraft)
    window.addEventListener('pagehide', discardDraftAfterNativeClose)
    return () => {
      window.removeEventListener('beforeunload', protectTemplateDraft)
      window.removeEventListener('pagehide', discardDraftAfterNativeClose)
    }
  }, [deleteWorkflow, workflowId])

  if (!isReady || !workflow) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0F0F0F] text-white/45">
        <div className="flex items-center gap-3 text-[11px]">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#7C5CFF] border-t-transparent" />
          Loading workflow editor
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <WorkflowCanvas
        workflow={workflow}
        isSidebarOpen={false}
        onToggleSidebar={() => {}}
        onBackToDashboard={requestEditorClose}
        windowMode
      />

      {saveDraftOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-template-draft-title"
          className="workflow-confirm-overlay"
        >
          <div className="workflow-save-draft-modal" onClick={(event) => event.stopPropagation()}>
            <div className="workflow-save-draft-content">
              <div className="workflow-save-draft-icon">
                <HardDrive className="h-[18px] w-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="save-template-draft-title" className="workflow-save-draft-title">Save this workflow?</h2>
                <p className="workflow-save-draft-desc">
                  You changed a workflow created from a template. Save it to the Workflow tab before closing.
                </p>
              </div>
            </div>

            <label className="workflow-save-draft-field">
              <span>Workflow name</span>
              <input
                ref={saveDraftInputRef}
                value={saveDraftName}
                maxLength={120}
                onChange={(event) => setSaveDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && saveDraftName.trim()) saveTemplateDraftToWorkflows()
                  if (event.key === 'Escape') setSaveDraftOpen(false)
                }}
                placeholder="Enter workflow name"
              />
            </label>

            <div className="workflow-save-draft-actions">
              <button type="button" className="workflow-save-draft-cancel" onClick={() => setSaveDraftOpen(false)}>
                Continue editing
              </button>
              <button type="button" className="workflow-save-draft-discard" onClick={discardTemplateDraft}>
                Don’t save
              </button>
              <button
                type="button"
                className="workflow-save-draft-save"
                disabled={!saveDraftName.trim()}
                onClick={saveTemplateDraftToWorkflows}
              >
                <HardDrive className="h-3.5 w-3.5" />
                Save & close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
