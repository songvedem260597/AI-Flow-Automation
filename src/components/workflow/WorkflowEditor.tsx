import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Drawflow from '@/lib/drawflow/drawflow.min.js'
import '@/lib/drawflow/drawflow.min.css'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useWorkflowStore } from '@/stores/workflowStore'
import { canvasLog } from '@/lib/canvasInvestigate'
import { cn, usePersistedState } from '@/lib/utils'
import type { AIProvider, FlowNodeData, FlowNodeType, Workflow, WorkflowEdge, WorkflowNode } from '@/types'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileDown,
  FileText,
  FolderOpen,
  Image,
  LayoutTemplate,
  List,
  Maximize2,
  PanelLeft,
  PanelLeftClose,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
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
  Settings2
} from 'lucide-react'
import { runPipeline, stopPipeline, pausePipeline, resumePipeline } from '@/pipeline'
import type { PipelineCallbacks } from '@/pipeline'
import { usePipelineStore } from '@/stores/pipelineStore'
import { debugLog, debugWarn } from '@/lib/debug'

const WORKFLOW_PERSIST_DEBUG = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('AI_FLOW_DEBUG') === '1'
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
type NodePillField = 'provider' | 'aspectRatio' | 'mediaType' | 'model' | 'videoDuration' | 'quantity' | 'resolution'

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

interface ImagePreviewState {
  src: string
  name: string
  mediaType: MediaNodeType
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

  return sanitized
}

function getPillOptions(field: NodePillField, data: Record<string, unknown> = {}): NodePillOption[] {
  if (field === 'provider') return normalizePillOptions(PROVIDER_OPTIONS)
  if (field === 'mediaType') return normalizePillOptions(GENERATE_MEDIA_TYPE_OPTIONS)
  if (field === 'model') return normalizePillOptions(getGenerateModelOptions(data))
  if (field === 'videoDuration') return normalizePillOptions(getGenerateVideoDurationOptions(data))
  if (field === 'quantity') return normalizePillOptions(GENERATE_QUANTITY_OPTIONS)
  if (field === 'resolution') return normalizePillOptions(GENERATE_RESOLUTION_OPTIONS)
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

function getMediaNodeSource(data: Record<string, unknown>) {
  const mediaType = getMediaNodeType(data)
  if (mediaType === 'video') {
    return String(data.videoData || data.videoUrl || data.mediaData || data.mediaUrl || '')
  }
  return String(data.imageData || data.imageUrl || data.mediaData || data.mediaUrl || '')
}

function getMediaNodePoster(data: Record<string, unknown>) {
  return String(data.videoPoster || data.mediaPoster || '')
}

function captureVideoPoster(videoSrc: string): Promise<{ width?: number; height?: number; poster?: string }> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    let settled = false
    let waitingForSeek = false

    const finish = (poster?: string) => {
      if (settled) return
      settled = true
      const width = video.videoWidth || undefined
      const height = video.videoHeight || undefined
      video.removeAttribute('src')
      video.load()
      resolve({
        width,
        height,
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
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
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

function coerceNodeData(type: FlowNodeType, raw: Record<string, unknown>): FlowNodeData {
  const label = String(raw.label || raw.node_name || raw.name || type)
  const provider = coerceProvider(raw.provider || raw.gen_type || raw.model_provider)

  if (type === 'prompt') {
    return {
      label,
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
      provider
    }
  }

  if (type === 'generate') {
    const mediaType = String(raw.mediaType || raw.media_type || 'image').toLowerCase() === 'video' ? 'video' : 'image'
    const nodeData: Record<string, unknown> = {
      label,
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
    return { ...nodeData, ...sanitizeGenerateDataPatch(nodeData, {}) } as FlowNodeData
  }

  if (type === 'delay') {
    const seconds = Number(raw.delay_seconds || 0)
    return {
      label,
      duration: Number(raw.duration || (seconds > 0 ? seconds * 1000 : 1000))
    }
  }

  if (type === 'download') {
    return {
      label,
      format: String(raw.format || 'png') as FlowNodeData['format'],
      autoDownload: raw.autoDownload !== false,
      filename: typeof raw.filename === 'string' ? raw.filename : undefined
    } as FlowNodeData
  }

  if (type === 'wait') {
    return {
      label,
      condition: String(raw.condition || 'dom-change') as FlowNodeData['condition'],
      selector: typeof raw.selector === 'string' ? raw.selector : undefined,
      expectedText: typeof raw.expectedText === 'string' ? raw.expectedText : undefined,
      timeout: Number(raw.timeout || 30000)
    } as FlowNodeData
  }

  return { label } as FlowNodeData
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
  anchor.download = `${workflow.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'workflow'}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
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
  download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  delay: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  prompt: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.39 5.26L20 10l-4.5 4.13L17 20l-5-3-5 3 1.5-5.87L4 10l5.61-1.74L12 3z"/></svg>',
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

function nodeHoverToolbar() {
  return `
    <div class="df-hover-toolbar">
      <button type="button" class="df-hover-btn" data-node-action="run" title="Run node">${DF_ICONS.generate}</button>
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
      return {
        url,
        name,
        savedFilename,
        mediaType,
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

function renderDrawflowNode(node: WorkflowNode) {
  const data = node.data as Record<string, unknown>
  const generateData = node.type === 'generate'
    ? { ...data, ...sanitizeGenerateDataPatch(data, {}) }
    : data
  const meta = nodeMeta(node.type)
  const rawLabel = node.type === 'image' && (!data.label || data.label === 'New Image Node' || data.label === 'image')
    ? 'New Media Node'
    : data.label || meta.title
  const label = escapeHtml(rawLabel)
  const provider = providerSlug(generateData.provider)
  const prompt = escapeHtml(String(data.prompt || '').slice(0, 150))
  const enabled = data.enabled !== false
  const providerPill = node.type === 'generate' ? providerBadge(generateData.provider) : ''
  const aspectRatio = String(data.aspectRatio || '1:1')
  const ratioClass = `ratio-${aspectRatio.replace(':', '-')}`

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
    const previewMediaType: 'image' | 'video' = selectedOutputItem?.mediaType === 'video'
      ? 'video'
      : 'image'
    // For video previews: resolve the playable URL and poster. The
    // runner.normalizeWorkflowOutput contract guarantees `videoUrl`
    // is populated for video outputs; we still fall back to mediaUrl
    // / url / thumbnailUrl for legacy bundles.
    const previewVideoSrc = selectedOutputItem
      ? String(selectedOutputItem.url || '')
      : ''
    const previewPoster = selectedOutputItem
      ? String(
        (output as Record<string, unknown> | undefined)?.thumbnailUrl ||
        (output as Record<string, unknown> | undefined)?.poster ||
        ''
      )
      : ''
    const hasOutput = firstImageUrl.length > 0

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
              <img class="df-node-preview-media" src="${escapeHtml(firstImageUrl)}" alt="Generated output" draggable="false">
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
      ${nodeHoverToolbar()}
      <div class="df-node-status pending"></div>
      <div class="df-node-header">
        <div class="df-node-icon ${meta.color}">${meta.icon}</div>
        <div class="df-node-title">${label}</div>
        <button class="df-node-toggle ${enabled ? 'on' : 'off'}" title="${enabled ? 'Disable node' : 'Enable node'}">
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

interface NodeInspectorProps {
  workflow: Workflow
  nodeId: string
  onClose: () => void
}

const NodeInspector: React.FC<NodeInspectorProps> = ({ workflow, nodeId, onClose }) => {
  const updateNode = useWorkflowStore((s) => s.updateNode)
  const deleteNode = useWorkflowStore((s) => s.deleteNode)
  const node = workflow.nodes.find((item) => item.id === nodeId)

  if (!node) {
    return null
  }

  const data = node.data as Record<string, unknown>
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

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-white/[0.06] bg-[#111111]">
      <div className="flex h-14 items-center justify-between border-b border-white/[0.06] px-4">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium text-white/80">
            {String(node.type === 'image' && (!data.label || data.label === 'New Image Node') ? 'New Media Node' : data.label || node.type)}
          </p>
          <p className="text-[10px] text-white/30">{node.type === 'image' ? 'media' : node.type}</p>
        </div>
        <div className="flex items-center gap-1">
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
        <label className="block">
          <span className={fieldLabelClass}>Name</span>
          <input
            value={String(node.type === 'image' && (!data.label || data.label === 'New Image Node') ? 'New Media Node' : data.label || '')}
            onChange={(event) => update('label', event.target.value)}
            className={fieldControlClass}
          />
        </label>

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
          <>
            <label className="block">
              <span className={fieldLabelClass}>Media URL</span>
              <input
                value={String(getMediaNodeType(data) === 'video' ? data.videoUrl || data.mediaUrl || '' : data.imageUrl || data.mediaUrl || '')}
                onChange={(event) => {
                  const mediaType = getMediaNodeType(data)
                  updateNode(node.id, {
                    mediaUrl: event.target.value,
                    imageUrl: mediaType === 'image' ? event.target.value : '',
                    videoUrl: mediaType === 'video' ? event.target.value : ''
                  } as Partial<FlowNodeData>)
                }}
                className={fieldControlClass}
              />
            </label>
          </>
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

const WorkflowCanvas: React.FC<WorkflowCanvasProps> = ({ workflow, isSidebarOpen, onToggleSidebar, onBackToDashboard, windowMode = false }) => {
  const updateWorkflow = useWorkflowStore((s) => s.updateWorkflow)
  const addNode = useWorkflowStore((s) => s.addNode)
  const updateNode = useWorkflowStore((s) => s.updateNode)
  const updateNodePosition = useWorkflowStore((s) => s.updateNodePosition)
  const updateNodePositions = useWorkflowStore((s) => s.updateNodePositions)
  const addEdgeToStore = useWorkflowStore((s) => s.addEdge)
  const deleteNode = useWorkflowStore((s) => s.deleteNode)
  const deleteEdge = useWorkflowStore((s) => s.deleteEdge)
  const setSelectedNode = useWorkflowStore((s) => s.setSelectedNode)
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
  const suppressEdgeEventRef = useRef(false)
  const connectionSyncFrameRef = useRef<number | null>(null)
  const connectionRefreshFrameRef = useRef<number | null>(null)
  const pendingConnectionRefreshIdsRef = useRef<Set<string>>(new Set())
  const refreshAllConnectionsRef = useRef(false)
  const nodeResizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map())
  const overlayObserversRef = useRef<WeakMap<SVGPathElement, MutationObserver>>(new WeakMap())
  const nodePickerSpawnRef = useRef<{ x: number; y: number } | null>(null)
  const copiedNodeRef = useRef<WorkflowNode | null>(null)
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

  const [isPaletteOpen, setIsPaletteOpen] = useState(false)
  const [nodePickerSearch, setNodePickerSearch] = useState('')
  const [selectedPickerIndex, setSelectedPickerIndex] = useState(0)
  const [nodePickerPosition, setNodePickerPosition] = useState<{ x: number; y: number } | null>(null)
  const [nodePillMenu, setNodePillMenu] = useState<NodePillMenuState | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(100)
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null)
  const [inspectorNodeId, setInspectorNodeId] = useState<string | null>(null)

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
      const incoming = (workflow.edges || [])
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
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })]
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
      filename = `image-${Date.now()}.png`
    }
    if (!/\.[a-zA-Z0-9]{2,5}$/.test(filename)) {
      filename = `${filename}.png`
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

  const rerenderDrawflowNode = (nodeId: string) => {
    const editor = editorRef.current
    const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
    if (!editor || !node) return

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

  const syncConnectionOverlays = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const selectedId = useWorkflowStore.getState().selectedNodeId

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
        Boolean(
          selectedId &&
          (connection.classList.contains(`node_in_node-${selectedId}`) || connection.classList.contains(`node_out_node-${selectedId}`))
        )
      )
    })
  }

  const scheduleConnectionSync = () => {
    if (connectionSyncFrameRef.current !== null) return
    connectionSyncFrameRef.current = requestAnimationFrame(() => {
      connectionSyncFrameRef.current = null
      syncConnectionOverlays()
    })
  }

  const syncSelectedNodeDom = (selectedId = useWorkflowStore.getState().selectedNodeId) => {
    const canvas = canvasRef.current
    const editor = editorRef.current
    if (!canvas) return

    let selectedEl: HTMLElement | null = null
    canvas.querySelectorAll<HTMLElement>('.drawflow-node.selected').forEach((el) => {
      if (!selectedId || el.id !== `node-${selectedId}`) el.classList.remove('selected')
    })

    if (selectedId) {
      selectedEl = canvas.querySelector<HTMLElement>(`#node-${CSS.escape(selectedId)}`)
      selectedEl?.classList.add('selected')
    }

    if (editor) editor.node_selected = selectedEl
    scheduleConnectionSync()
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
    editor.contextmenu = (event: Event) => {
      event.preventDefault()
      return false
    }
    editor.start()

    editor.on('nodeSelected', (id: string | number) => {
      setSelectedNode(String(id))
      requestAnimationFrame(() => syncSelectedNodeDom(String(id)))
    })

    editor.on('nodeUnselected', () => {
      const selectionIntent = selectionMouseDownRef.current
      if (selectionIntent?.nodeId) {
        requestAnimationFrame(() => syncSelectedNodeDom(selectionIntent.nodeId))
        return
      }

      if (!selectionIntent || selectionIntent.clearOnUnselect) {
        setSelectedNode(null)
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
      // Transient only — Drawflow already moved the DOM. We just
      // remember where to commit on mouseUp. No store write, no
      // history, no `isDirty`, no `updatedAt`.
      pendingDragPositionsRef.current.set(nodeId, { x: node.pos_x, y: node.pos_y })
      // Lightweight per-node connection repaint — only the line
      // endpoints touching this node. One rAF; one
      // `editor.updateConnectionNodes(draggedId)` call. No
      // applyPortAttributes / no attachNodeResizeObservers / no
      // full canvas pass.
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
      const pending = pendingDragPositionsRef.current
      if (pending.size > 0) {
        const positions: Record<string, { x: number; y: number }> = {}
        for (const [nodeId, position] of pending.entries()) {
          positions[nodeId] = position
        }
        pending.clear()
        const activeWorkflowId = useWorkflowStore.getState().activeWorkflowId
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

      selectionMouseDownRef.current = {
        nodeId,
        clearOnUnselect: Boolean(outputPort || connectionPath || canvasSurface)
      }

      if (nodeId) {
        setSelectedNode(nodeId)
        requestAnimationFrame(() => syncSelectedNodeDom(nodeId))
      } else if (canvasSurface || connectionPath) {
        setSelectedNode(null)
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

        if (commit) {
          updateNode(nodeId, { prompt: textarea.value } as Partial<FlowNodeData>)
        } else {
          rerenderDrawflowNode(nodeId)
        }
      }
      const commitEdit = () => finish(true)
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

          const finishUpload = (width?: number, height?: number, poster?: string) => {
            const aspectRatio = width && height ? closestImageAspectRatio(width, height) : fileMediaType === 'video' ? '16:9' : '1:1'
            const basePatch: Record<string, unknown> = {
              mediaType: fileMediaType,
              mediaData: imageData,
              mediaUrl: '',
              mediaName: file.name,
              mediaMimeType: file.type,
              mediaWidth: width,
              mediaHeight: height,
              mediaPoster: fileMediaType === 'video' ? poster || '' : '',
              aspectRatio
            }

            updateNode(nodeId, {
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
              videoPoster: fileMediaType === 'video' ? poster || '' : ''
            } as Partial<FlowNodeData>)
            scheduleDrawflowConnectionRefresh(nodeId)
            cleanup()
          }

          if (fileMediaType === 'video') {
            captureVideoPoster(imageData)
              .then(({ width, height, poster }) => finishUpload(width, height, poster))
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
      if (!target?.closest('.df-node-pill-trigger, .df-hover-btn, .df-node-prompt-editor, .df-node-image-preview-button')) return
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
      if (action === 'delete') {
        closeNodePillMenu()
        deleteNode(nodeId)
        setInspectorNodeId((current) => (current === nodeId ? null : current))
      } else if (action === 'settings') {
        closeNodePillMenu()
        setInspectorNodeId(nodeId)
      }
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
          closeNodePillMenu()
          setSelectedNode(nodeId)
          setImagePreview({
            src: mediaSrc,
            name,
            mediaType: initialMediaType,
            outputItems,
            selectedIndex: liveIndex,
            outputName: initialItem?.name,
            downloadFilename: initialDownloadFilename,
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
        mediaType
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
    canvasEl.addEventListener('pointerdown', handleViewportPanPointerDown, true)
    canvasEl.addEventListener('dblclick', handlePromptInlineEdit)
    canvasEl.addEventListener('dblclick', handleImageNodeUpload)
    canvasEl.addEventListener('click', handleNodePillClick)
    canvasEl.addEventListener('click', handleNodeToolbarClick)
    canvasEl.addEventListener('click', handleImagePreviewClick)
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
      disconnectNodeResizeObservers()
      canvasEl.removeEventListener('mousemove', syncOnPointerMove)
      canvasEl.removeEventListener('pointermove', syncOnPointerMove)
      canvasEl.removeEventListener('touchmove', syncOnPointerMove)
      canvasEl.removeEventListener('mousedown', rememberCanvasPointer)
      canvasEl.removeEventListener('touchstart', rememberCanvasPointer)
      canvasEl.removeEventListener('mousedown', handleBidirectionalPortMouseDown, true)
      canvasEl.removeEventListener('mousedown', handleSelectionMouseDown, true)
      canvasEl.removeEventListener('mousedown', stopNodePillDragStart, true)
      canvasEl.removeEventListener('pointerdown', handleViewportPanPointerDown, true)
      canvasEl.removeEventListener('dblclick', handlePromptInlineEdit)
      canvasEl.removeEventListener('dblclick', handleImageNodeUpload)
      canvasEl.removeEventListener('click', handleNodePillClick)
      canvasEl.removeEventListener('click', handleNodeToolbarClick)
      canvasEl.removeEventListener('click', handleImagePreviewClick)
      canvasEl.removeEventListener('dragstart', preventNativeMediaDrag, true)
      canvasEl.removeEventListener('load', handlePreviewMediaLoaded, true)
      canvasEl.removeEventListener('error', handlePreviewMediaError, true)
      canvasEl.removeEventListener('wheel', zoomOnWheel)
      editorRef.current = null
      portDragCleanupRef.current?.()
      canvasEl.replaceChildren()
    }
  }, [addEdgeToStore, deleteEdge, deleteNode, setSelectedNode, updateNode, updateNodePosition])

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
    if (canvasDragInFlightRef.current.nodeId) {
      canvasLog('positionUndoRedoSyncSkippedDuringDrag', {
        positionSignature,
        activeNodeId: canvasDragInFlightRef.current.nodeId,
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
    const nodeId = useWorkflowStore.getState().selectedNodeId
    if (!nodeId) return false

    const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
    if (!node) return false

    copiedNodeRef.current = cloneDeep(node)
    return true
  }

  const pasteCopiedNode = () => {
    const copiedNode = copiedNodeRef.current
    const currentWorkflow = workflowRef.current
    if (!copiedNode || !currentWorkflow) return false

    const pointer = lastCanvasPointerRef.current || getCanvasCenterPoint()
    const pastedNode: WorkflowNode = {
      ...cloneDeep(copiedNode),
      id: createId('node'),
      position: {
        x: Math.max(0, Math.round(pointer.x)),
        y: Math.max(0, Math.round(pointer.y))
      }
    }

    updateWorkflow(currentWorkflow.id, {
      nodes: [...currentWorkflow.nodes, pastedNode]
    })
    setSelectedNode(pastedNode.id)

    requestAnimationFrame(() => {
      attachNodeResizeObserver(pastedNode.id)
      scheduleDrawflowConnectionRefresh(pastedNode.id)
      syncSelectedNodeDom(pastedNode.id)
    })

    return true
  }

  useEffect(() => {
    const handleUndoRedoShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return

      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return

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

    window.addEventListener('keydown', handleUndoRedoShortcut)
    return () => window.removeEventListener('keydown', handleUndoRedoShortcut)
  }, [redoWorkflow, undoWorkflow, updateWorkflow, workflow.id])

  const handleAddNode = (type: FlowNodeType) => {
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
    if (node) setSelectedNode(node.id)
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

    // Clear previous run visual state before starting.
    // Order matters: clear the DOM classes FIRST so the next
    // syncNodeRunStates() pass (triggered by the React state changes
    // below) re-applies classes from a clean slate, instead of having
    // to first fight stale `ai-node-completed` from the previous run.
    clearAllRunDomClasses()
    setNodeRunStates({})
    setActiveEdges({})
    setNodeOutputs({})

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
    if (!editor || !canvas || !editor.precanvas) return

    const nodes = Array.from(canvas.querySelectorAll<HTMLElement>('.drawflow-node'))
    if (nodes.length === 0) {
      editor.zoom_reset()
      refreshZoom()
      scheduleConnectionSync()
      return
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
    editor.precanvas.style.transform = `translate(${editor.canvas_x}px, ${editor.canvas_y}px) scale(${zoom})`
    refreshZoom()
    scheduleConnectionSync()
  }

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
            <input
              value={workflow.name}
              onChange={(event) => updateWorkflow(workflow.id, { name: event.target.value })}
              className="h-6 w-[min(42vw,360px)] min-w-[150px] bg-transparent text-[12px] font-medium text-white/85 outline-none"
              aria-label="Workflow name"
            />
            <div className="text-[10px] font-medium text-white/28">
              {workflow.nodes.length} nodes / {workflow.edges.length} connections
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Export workflow"
            onClick={() => downloadWorkflowJson(workflow)}
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
          className="relative min-w-0 flex-1 overflow-hidden bg-[#101010]"
          onContextMenu={handleCanvasContextMenu}
        >
          <div className="pointer-events-none absolute inset-0 opacity-[0.32] [background-image:radial-gradient(circle,rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:22px_22px]" />
          <div ref={canvasRef} className="ai-drawflow-canvas absolute inset-0" />

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
            <button type="button" title="Export workflow" onClick={() => downloadWorkflowJson(workflow)} className="aiflow-wf-tool-btn">
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
            // Header title: when inside a Generate carousel, show
            // the current item's name so the label tracks the
            // visible asset. Otherwise fall back to the static
            // preview title.
            const headerTitle =
              lightboxHasCarousel && imagePreview.outputItems
                ? imagePreview.outputItems[lightboxSelectedIndex]?.name || imagePreview.name
                : imagePreview.name
            // [Workflow] Lightbox download — enabled when there's a usable src.
// Previously gated to `mediaType === 'image'`, which silently
// disabled download for video outputs even though
// `handleDownloadPreview` already handles both via the SW
// download route + chrome.downloads fallback chain. The
// filename is derived per-asset (`resolveGenerateOutputFilename`)
// so a video download naturally gets `.mp4`.
const lightboxCanDownload = Boolean(imagePreview.src) && (
  imagePreview.mediaType === 'image' || imagePreview.mediaType === 'video'
)
            return (
              <div
                className="absolute inset-0 z-[70] flex flex-col bg-black/85 backdrop-blur-sm"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) setImagePreview(null)
                }}
              >
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.08] bg-[#111111]/92 px-4">
                  <div className="flex min-w-0 items-center gap-3 text-[11px] font-medium text-white/62">
                    <span className="block truncate">{headerTitle}</span>
                    {lightboxHasCarousel && (
                      <div className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-1 py-0.5 text-white/72">
                        <button
                          type="button"
                          title="Previous output"
                          aria-label="Previous output"
                          onClick={handleLightboxPrev}
                          className="flex h-6 w-6 items-center justify-center rounded text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </button>
                        <span className="min-w-[40px] px-1 text-center font-variant-numeric tabular-nums">
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
                  <div className="flex items-center gap-1">
                    {lightboxCanDownload && (
                      <button
                        type="button"
                        title={lightboxHasCarousel ? 'Download current output' : 'Download'}
                        aria-label={lightboxHasCarousel ? 'Download current output' : 'Download'}
                        onClick={handleDownloadPreview}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      title="Close preview"
                      onClick={() => setImagePreview(null)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div
                  className="flex min-h-0 flex-1 items-center justify-center p-5"
                  onMouseDown={(event) => {
                    if (event.target === event.currentTarget) setImagePreview(null)
                  }}
                >
                  {imagePreview.mediaType === 'video' ? (
                    <video
                      src={imagePreview.src}
                      controls
                      autoPlay
                      className="max-h-full max-w-full rounded-lg border border-white/[0.08] object-contain shadow-2xl"
                    />
                  ) : (
                    <img
                      key={imagePreview.src}
                      src={imagePreview.src}
                      alt={headerTitle}
                      className="max-h-full max-w-full rounded-lg border border-white/[0.08] object-contain shadow-2xl"
                    />
                  )}
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
        {windowMode && inspectorNodeId && (
          <NodeInspector
            workflow={workflow}
            nodeId={inspectorNodeId}
            onClose={() => setInspectorNodeId(null)}
          />
        )}
      </div>
    </div>
  )
}
async function openWorkflowEditorWindow(workflow: Workflow) {
  await chrome.storage.local.set({
    _pendingWorkflowEditor: {
      workflow,
      workflowId: workflow.id,
      timestamp: Date.now()
    }
  })

  await chrome.runtime.sendMessage({
    action: 'OPEN_WORKFLOW_EDITOR_WINDOW',
    payload: { workflowId: workflow.id },
    timestamp: Date.now()
  })
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

  const [view, setView] = usePersistedState<WorkflowShellView>('workflow.view', workflows.length > 0 ? 'workflows' : 'templates')
  const [templateCategory, setTemplateCategory] = usePersistedState<string>('workflow.templateCategory', 'All')
  const [workflowSearch, setWorkflowSearch] = useState('')
  const [deleteConfirmWorkflow, setDeleteConfirmWorkflow] = useState<Workflow | null>(null)
  const [renameWorkflow, setRenameWorkflow] = useState<Workflow | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
          console.log('[WorkflowPersist][storage.onChanged]', JSON.stringify({
            key: 'ai-flow-workflows',
            oldWorkflowCount: countFrom(oldVal),
            newWorkflowCount: newWc,
            oldActiveWorkflowId: activeFrom(oldVal),
            newActiveWorkflowId: activeFrom(newVal)
          }))
          if (newWc === 0) {
            console.trace('[WorkflowPersist][storage.onChanged:zero-workflows]')
          }
        }
        hydrateFromStorage().catch(() => {})
      }
    }
    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleStorageChange)
  }, [hydrateFromStorage])

  useEffect(() => {
    if (!deleteConfirmWorkflow && !renameWorkflow) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (renameWorkflow) {
          handleCancelRenameWorkflow()
        } else if (deleteConfirmWorkflow) {
          setDeleteConfirmWorkflow(null)
        }
      } else if (event.key === 'Enter' && renameWorkflow) {
        const target = event.target as HTMLElement | null
        if (target && target.tagName === 'TEXTAREA') return
        event.preventDefault()
        handleConfirmRenameWorkflow()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [deleteConfirmWorkflow, renameWorkflow, renameDraft])

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
      console.log('[WorkflowPersist][editorMount]', JSON.stringify({
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
        console.log('[WorkflowPersist][viewMismatch]', JSON.stringify({
          view,
          workflowCount: workflows.length,
          activeWorkflowId,
          persistedView
        }))
      }
    }
  }, [view, workflows.length, activeWorkflowId])

  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) || workflows[0] || null
  const templateCategories = useMemo(
    () => ['All', ...Array.from(new Set(BUILT_IN_TEMPLATES.map((template) => template.category)))],
    []
  )
  const filteredTemplates = templateCategory === 'All'
    ? BUILT_IN_TEMPLATES
    : BUILT_IN_TEMPLATES.filter((template) => template.category === templateCategory)
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
    const filtered = workflows.filter((workflow) =>
      workflow.name.toLowerCase().includes(lowerSearch)
    )
    const sorted = [...filtered].sort((a, b) => {
      const ac = typeof a.createdAt === 'number' ? a.createdAt : 0
      const bc = typeof b.createdAt === 'number' ? b.createdAt : 0
      if (bc !== ac) return bc - ac
      return String(a.id).localeCompare(String(b.id))
    })
    if (WORKFLOW_LIST_DEBUG()) {
      console.log('[WorkflowList][renderOrder]', JSON.stringify({
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
      console.log('[WorkflowList][sortPolicy]', JSON.stringify({ policy: 'createdAt-desc' }))
    }
    return sorted
  }, [workflows, workflowSearch])

  const handleCreateBlank = async () => {
    const workflow = createWorkflow(`Workflow ${workflows.length + 1}`)
    setActiveWorkflow(workflow.id)
    await openWorkflowEditorWindow(workflow)
  }

  const handleUseTemplate = async (template: WorkflowTemplate) => {
    const workflow = instantiateTemplate(template)
    importWorkflow(workflow)
    await openWorkflowEditorWindow(workflow)
  }

  const handleOpenWorkflow = async (workflow: Workflow) => {
    setActiveWorkflow(workflow.id)
    await openWorkflowEditorWindow(workflow)
  }

  const handleDuplicateWorkflow = async (workflow: Workflow) => {
    const duplicate = duplicateWorkflow(workflow.id)
    if (duplicate) await openWorkflowEditorWindow(duplicate)
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

  const handleImportWorkflow = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const text = await file.text()
      const payload = JSON.parse(text) as unknown
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
    try {
      await openWorkflowEditorWindow(workflow)
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
        accept="application/json,.json"
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
            <p className="truncate text-[11px] text-white/30">{workflows.length} saved flows</p>
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
              {templateCategories.map((category) => (
                <button
                  type="button"
                  key={category}
                  onClick={() => setTemplateCategory(category)}
                  className={cn(
                    'h-8 shrink-0 rounded-lg px-3 text-[11px] font-medium transition-colors',
                    templateCategory === category
                      ? 'bg-[#7C5CFF]/15 text-[#B8A8FF]'
                      : 'bg-white/[0.04] text-white/45 hover:bg-white/[0.07] hover:text-white/75'
                  )}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3 overflow-y-auto pr-1">
            {filteredTemplates.map((template) => {
              const colors = NODE_COLORS[template.accent]
              return (
                <div
                  key={template.id}
                  className={cn(
                    'flex min-h-[190px] flex-col rounded-lg border bg-[#171717] p-4 transition-colors hover:border-white/15',
                    colors.border,
                    'border-l-2 border-white/[0.06]'
                  )}
                >
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

                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {template.tags.map((tag) => (
                      <span key={tag} className="rounded-md bg-white/[0.05] px-2 py-1 text-[10px] text-white/35">
                        {tag}
                      </span>
                    ))}
                  </div>

                  <div className="mt-auto flex items-center justify-between pt-4">
                    <div className="flex items-center gap-3 text-[11px] text-white/30">
                      <span>{template.nodes.length} nodes</span>
                      <span>{template.edges.length} links</span>
                    </div>
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
              )
            })}
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
            <button
              type="button"
              title="Import workflow"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1A1A1A] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <Upload className="h-4 w-4" />
            </button>
          </div>

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
                {filteredWorkflows.map((workflow) => (
                  <div
                    key={workflow.id}
                    onDoubleClick={() => handleOpenWorkflow(workflow)}
                    className={cn(
                      'flex min-h-[118px] flex-col rounded-lg border bg-[#171717] p-3 transition-colors hover:border-white/15',
                      activeWorkflowId === workflow.id ? 'border-[#7C5CFF]/45' : 'border-white/[0.06]'
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
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
                          onClick={() => downloadWorkflowJson(workflow)}
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
                ))}
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
            className="workflow-confirm-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="workflow-confirm-icon">
              <Trash2 className="h-4 w-4" />
            </div>
            <div className="workflow-confirm-body">
              <h2 id="workflow-confirm-title" className="workflow-confirm-title">
                Delete “{deleteConfirmWorkflow.name}”?
              </h2>
              <p id="workflow-confirm-desc" className="workflow-confirm-desc">
                This action cannot be undone.
              </p>
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
                Delete
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
          aria-describedby="workflow-rename-desc"
          className="workflow-confirm-overlay"
          onClick={handleCancelRenameWorkflow}
        >
          <div
            className="workflow-confirm-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="workflow-rename-icon">
              <Pencil className="h-4 w-4" />
            </div>
            <div className="workflow-confirm-body">
              <h2 id="workflow-rename-title" className="workflow-confirm-title">
                Rename workflow
              </h2>
              <p id="workflow-rename-desc" className="workflow-confirm-desc">
                Choose a new name for this workflow.
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
                Save
              </button>
            </div>
          </div>
        </div>
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
  const setActiveWorkflow = useWorkflowStore((s) => s.setActiveWorkflow)

  const [isReady, setIsReady] = useState(false)
  const [workflowId, setWorkflowId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      await hydrateFromStorage().catch(() => {})

      const params = new URLSearchParams(window.location.search)
      let nextWorkflowId = params.get('workflowId')

      try {
        const pending = await chrome.storage.local.get('_pendingWorkflowEditor')
        const pendingData = pending._pendingWorkflowEditor as {
          workflow?: Workflow
          workflowId?: string
          timestamp?: number
        } | undefined
        const isFresh = pendingData?.timestamp && Date.now() - pendingData.timestamp < 5 * 60 * 1000
        const matchesQuery = !nextWorkflowId || pendingData?.workflowId === nextWorkflowId

        if (pendingData?.workflow && isFresh && matchesQuery) {
          importWorkflow(pendingData.workflow)
          nextWorkflowId = pendingData.workflow.id
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
    <WorkflowCanvas
      workflow={workflow}
      isSidebarOpen={false}
      onToggleSidebar={() => {}}
      onBackToDashboard={() => window.close()}
      windowMode
    />
  )
}
