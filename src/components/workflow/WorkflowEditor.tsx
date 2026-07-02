import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Drawflow from '@/lib/drawflow/drawflow.min.js'
import '@/lib/drawflow/drawflow.min.css'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useWorkflowStore } from '@/stores/workflowStore'
import { cn } from '@/lib/utils'
import type { AIProvider, FlowNodeData, FlowNodeType, Workflow, WorkflowEdge, WorkflowNode } from '@/types'
import {
  ArrowLeft,
  Check,
  ChevronDown,
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
import { usePipelineStore } from '@/stores/pipelineStore'

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
type NodePillField = 'provider' | 'aspectRatio' | 'mediaType' | 'model' | 'videoDuration'

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

  return sanitized
}

function getPillOptions(field: NodePillField, data: Record<string, unknown> = {}): NodePillOption[] {
  if (field === 'provider') return normalizePillOptions(PROVIDER_OPTIONS)
  if (field === 'mediaType') return normalizePillOptions(GENERATE_MEDIA_TYPE_OPTIONS)
  if (field === 'model') return normalizePillOptions(getGenerateModelOptions(data))
  if (field === 'videoDuration') return normalizePillOptions(getGenerateVideoDurationOptions(data))
  return normalizePillOptions(
    data && Object.keys(data).length > 0 ? getGenerateAspectRatioOptions(data) : ASPECT_RATIO_OPTIONS
  )
}

function pillFieldLabel(field: NodePillField) {
  if (field === 'provider') return 'Provider'
  if (field === 'mediaType') return 'Media type'
  if (field === 'model') return 'Model'
  if (field === 'videoDuration') return 'Duration'
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
      <div class="df-node-settings-bar">
        ${renderPillTrigger('aspectRatio', aspectRatio, ASPECT_RATIO_OPTIONS)}
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
    const mode = data.autoGenerate === false ? 'Manual' : 'Auto'
    body = `
      <div class="df-node-preview-wrap">
        <div class="df-node-preview ${generateRatioClass}">
          <div class="df-node-preview-placeholder">${mediaType === 'video' ? DF_ICONS.generate : DF_ICONS.image}</div>
        </div>
        ${prompt ? `<div class="df-node-prompt df-node-prompt-overlay nodrag">${prompt}</div>` : ''}
      </div>
      <div class="df-node-settings-bar">
        ${renderPillTrigger('provider', String(generateData.provider || 'chatgpt'), PROVIDER_OPTIONS)}
        ${supportsVideo ? renderPillTrigger('mediaType', mediaType, GENERATE_MEDIA_TYPE_OPTIONS) : ''}
        ${modelOptions.length ? renderPillTrigger('model', generateModel, modelOptions) : ''}
        ${mediaType === 'video' ? renderPillTrigger('videoDuration', generateDuration, durationOptions) : ''}
        ${renderPillTrigger('aspectRatio', generateAspectRatio, ratioOptions)}
        <button type="button" class="df-node-tag df-node-tag-editable"><span>${mode}</span></button>
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

function getWorkflowStructureSignature(workflow: Workflow) {
  const nodes = workflow.nodes
    .map((node) => `${node.id}:${node.type}:${getNodePortSignature(node)}`)
    .join('|')
  const edges = workflow.edges
    .map((edge) => `${edge.source}:${edge.target}:${edge.sourceHandle || ''}:${edge.targetHandle || ''}`)
    .join('|')
  return `${workflow.id}::${nodes}::${edges}`
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
  const addEdgeToStore = useWorkflowStore((s) => s.addEdge)
  const deleteNode = useWorkflowStore((s) => s.deleteNode)
  const deleteEdge = useWorkflowStore((s) => s.deleteEdge)
  const setSelectedNode = useWorkflowStore((s) => s.setSelectedNode)
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId)
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
  const overlayObserversRef = useRef<WeakMap<SVGPathElement, MutationObserver>>(new WeakMap())
  const nodePickerSpawnRef = useRef<{ x: number; y: number } | null>(null)
  const nodePickerRef = useRef<HTMLDivElement | null>(null)
  const nodePillMenuRef = useRef<HTMLDivElement | null>(null)
  const selectionMouseDownRef = useRef<{ nodeId: string | null; clearOnUnselect: boolean } | null>(null)
  const portDragCleanupRef = useRef<(() => void) | null>(null)

  const [isPaletteOpen, setIsPaletteOpen] = useState(false)
  const [nodePickerSearch, setNodePickerSearch] = useState('')
  const [selectedPickerIndex, setSelectedPickerIndex] = useState(0)
  const [nodePickerPosition, setNodePickerPosition] = useState<{ x: number; y: number } | null>(null)
  const [nodePillMenu, setNodePillMenu] = useState<NodePillMenuState | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(100)
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null)
  const [inspectorNodeId, setInspectorNodeId] = useState<string | null>(null)

  const activeTask = tasks.find((task) => task.id === activeTaskId)
  const taskLogs = logs.filter((log) => log.pipelineId === activeTaskId).slice(0, 24)
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
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [imagePreview])

  const handleCanvasContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('.tobyflow-node-picker, .tobyflow-wf-toolbar, button, input, textarea, select')) return

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

  const rerenderDrawflowNode = (nodeId: string) => {
    const editor = editorRef.current
    const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
    if (!editor || !node) return

    const content = canvasRef.current?.querySelector(`#node-${CSS.escape(node.id)} .drawflow_content_node`)
    if (content) content.innerHTML = renderDrawflowNode(node)
    applyPortAttributesForNode(node)
    editor.updateConnectionNodes(`node-${node.id}`)
    scheduleConnectionSync()
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

    suppressEdgeEventRef.current = true
    editor.import(buildDrawflowData(workflowRef.current), false)
    suppressEdgeEventRef.current = false

    requestAnimationFrame(() => {
      applyPortAttributes()
      for (const node of workflowRef.current.nodes) {
        editor.updateConnectionNodes(`node-${node.id}`)
      }
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

    editor.on('nodeMoved', (id: string | number) => {
      const node = editor.getNodeFromId(id)
      updateNodePosition(String(id), { x: node.pos_x, y: node.pos_y })
      scheduleConnectionSync()
    })

    editor.on('nodeRemoved', (id: string | number) => {
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
      selectionMouseDownRef.current = null
      scheduleConnectionSync()
    })
    editor.on('rerouteMoved', scheduleConnectionSync)
    editor.on('addReroute', scheduleConnectionSync)
    editor.on('removeReroute', scheduleConnectionSync)

    const syncOnPointerMove = () => scheduleConnectionSync()
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
        editor.updateConnectionNodes(`node-${nodeId}`)
        scheduleConnectionSync()
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

      const nodeEl = button.closest<HTMLElement>('.df-node[data-workflow-node-id][data-node-type="image"]')
      const nodeId = nodeEl?.dataset.workflowNodeId
      if (!nodeId) return

      const node = workflowRef.current.nodes.find((item) => item.id === nodeId)
      const data = (node?.data || {}) as Record<string, unknown>
      const mediaSrc = getMediaNodeSource(data)
      if (!node || node.type !== 'image' || !mediaSrc) return

      closeNodePillMenu()
      setSelectedNode(nodeId)
      setImagePreview({
        src: mediaSrc,
        name: String(data.mediaName || data.videoName || data.imageName || data.label || 'Media'),
        mediaType: getMediaNodeType(data)
      })
    }
    const preventNativeMediaDrag = (event: DragEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('.df-node-preview-media, .df-node-preview-image, .df-node-image-upload-target')) return

      event.preventDefault()
      event.stopPropagation()
    }
    const zoomOnWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.tobyflow-node-picker, input, textarea, select')) return
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
    canvasEl.addEventListener('mousedown', handleBidirectionalPortMouseDown, true)
    canvasEl.addEventListener('mousedown', handleSelectionMouseDown, true)
    canvasEl.addEventListener('mousedown', stopNodePillDragStart, true)
    canvasEl.addEventListener('dblclick', handlePromptInlineEdit)
    canvasEl.addEventListener('dblclick', handleImageNodeUpload)
    canvasEl.addEventListener('click', handleNodePillClick)
    canvasEl.addEventListener('click', handleNodeToolbarClick)
    canvasEl.addEventListener('click', handleImagePreviewClick)
    canvasEl.addEventListener('dragstart', preventNativeMediaDrag, true)
    canvasEl.addEventListener('wheel', zoomOnWheel, { passive: false })

    editorRef.current = editor
    hydrateDrawflow()

    return () => {
      if (connectionSyncFrameRef.current !== null) {
        cancelAnimationFrame(connectionSyncFrameRef.current)
        connectionSyncFrameRef.current = null
      }
      canvasEl.removeEventListener('mousemove', syncOnPointerMove)
      canvasEl.removeEventListener('pointermove', syncOnPointerMove)
      canvasEl.removeEventListener('touchmove', syncOnPointerMove)
      canvasEl.removeEventListener('mousedown', handleBidirectionalPortMouseDown, true)
      canvasEl.removeEventListener('mousedown', handleSelectionMouseDown, true)
      canvasEl.removeEventListener('mousedown', stopNodePillDragStart, true)
      canvasEl.removeEventListener('dblclick', handlePromptInlineEdit)
      canvasEl.removeEventListener('dblclick', handleImageNodeUpload)
      canvasEl.removeEventListener('click', handleNodePillClick)
      canvasEl.removeEventListener('click', handleNodeToolbarClick)
      canvasEl.removeEventListener('click', handleImagePreviewClick)
      canvasEl.removeEventListener('dragstart', preventNativeMediaDrag, true)
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

    for (const node of workflow.nodes) {
      try {
        editor.updateNodeDataFromId(node.id, cloneDeep(node.data))
        const content = canvasRef.current?.querySelector(`#node-${CSS.escape(node.id)} .drawflow_content_node`)
        if (content) content.innerHTML = renderDrawflowNode(node)
        applyPortAttributesForNode(node)
        editor.updateConnectionNodes(`node-${node.id}`)
        scheduleConnectionSync()
      } catch {
        // Node may not be mounted yet; the structural hydrate will catch it.
      }
    }
  }, [dataSignature, workflow.nodes])

  useEffect(() => {
    syncSelectedNodeDom(selectedNodeId)
  }, [selectedNodeId])

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
        editor.updateConnectionNodes(`node-${node.id}`)
        scheduleConnectionSync()
      })
    }
  }

  const handleRun = async () => {
    if (isRunning) {
      if (isPaused) resumePipeline()
      else pausePipeline()
      return
    }

    await runPipeline(workflow)
  }

  const handleStop = () => {
    stopPipeline()
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
        aspectRatio: { aspectRatio: option.value }
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

          <div className="tobyflow-wf-toolbar">
            <button
              type="button"
              title="Add node"
              onClick={() => {
                if (isPaletteOpen) closeNodePicker()
                else openNodePicker()
              }}
              className={cn('tobyflow-wf-tool-btn', isPaletteOpen && 'active')}
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={isRunning ? (isPaused ? 'Resume workflow' : 'Pause workflow') : 'Run workflow'}
              onClick={handleRun}
              disabled={workflow.nodes.length === 0}
              className="tobyflow-wf-tool-btn"
            >
              {isRunning && !isPaused ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <button
              type="button"
              title="Stop workflow"
              onClick={handleStop}
              className={cn('tobyflow-wf-tool-btn', !isRunning && 'hidden')}
            >
              <Square className="h-4 w-4" />
            </button>
            <div className="tobyflow-wf-tool-divider" />
            <button type="button" title="Undo" disabled className="tobyflow-wf-tool-btn">
              <Undo2 className="h-4 w-4" />
            </button>
            <button type="button" title="Redo" disabled className="tobyflow-wf-tool-btn">
              <Redo2 className="h-4 w-4" />
            </button>
            <div className="tobyflow-wf-tool-divider" />
            <button type="button" title="Console" onClick={() => setShowLogs(!showLogs)} className={cn('tobyflow-wf-tool-btn', showLogs && 'active')}>
              <List className="h-4 w-4" />
            </button>
            <button type="button" title="Fit view" onClick={fitCanvas} className="tobyflow-wf-tool-btn">
              <Maximize2 className="h-4 w-4" />
            </button>
            <button type="button" title="Reset zoom" onClick={resetCanvas} className="tobyflow-wf-tool-btn">
              <span className="text-[10px] font-medium">{zoomLevel}%</span>
            </button>
            <button type="button" title="Auto layout" onClick={fitCanvas} className="tobyflow-wf-tool-btn">
              <LayoutTemplate className="h-4 w-4" />
            </button>
            <button type="button" title="Settings" className="tobyflow-wf-tool-btn">
              <Settings2 className="h-4 w-4" />
            </button>
            <button type="button" title="Export workflow" onClick={() => downloadWorkflowJson(workflow)} className="tobyflow-wf-tool-btn">
              <FileDown className="h-4 w-4" />
            </button>
          </div>

          {isPaletteOpen && (
            <div
              ref={nodePickerRef}
              className={cn('tobyflow-node-picker', nodePickerPosition ? '' : 'left-[64px] top-1/2 -translate-y-1/2')}
              style={nodePickerPosition ? { left: nodePickerPosition.x, top: nodePickerPosition.y } : undefined}
            >
              <div className="tobyflow-node-picker-context-hint tobyflow-node-picker-context-hint--no-text">
                <button
                  type="button"
                  title="Close"
                  onClick={closeNodePicker}
                  className="tobyflow-node-picker-close"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="tobyflow-node-picker-search">
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
                  className="tobyflow-node-picker-input nodrag"
                />
              </div>
              <div className="tobyflow-node-picker-list">
                {pickerItems.map((node, index) => (
                  <button
                    type="button"
                    key={node.type}
                    onClick={() => {
                      handleAddNode(node.type)
                      closeNodePicker()
                    }}
                    className={cn('tobyflow-node-picker-item', index === selectedPickerIndex && 'selected')}
                  >
                    <span className={cn('node-palette-item-icon df-node-icon', nodeMeta(node.type).color)}>
                      {node.icon}
                    </span>
                    <span className="tobyflow-node-picker-info">
                      <span className="tobyflow-node-picker-name">{node.label}</span>
                      <span className="tobyflow-node-picker-desc">{node.description}</span>
                    </span>
                  </button>
                ))}
                {pickerItems.length === 0 && (
                  <div className="px-3 py-8 text-center text-[11px] text-white/35">No matching nodes</div>
                )}
              </div>
              <div className="tobyflow-node-picker-footer">
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

          {imagePreview && (
            <div
              className="absolute inset-0 z-[70] flex flex-col bg-black/85 backdrop-blur-sm"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setImagePreview(null)
              }}
            >
              <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.08] bg-[#111111]/92 px-4">
                <div className="min-w-0 text-[11px] font-medium text-white/62">
                  <span className="block truncate">{imagePreview.name}</span>
                </div>
                <button
                  type="button"
                  title="Close preview"
                  onClick={() => setImagePreview(null)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
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
                    src={imagePreview.src}
                    alt={imagePreview.name}
                    className="max-h-full max-w-full rounded-lg border border-white/[0.08] object-contain shadow-2xl"
                  />
                )}
              </div>
            </div>
          )}

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

  const [view, setView] = useState<WorkflowShellView>(workflows.length > 0 ? 'workflows' : 'templates')
  const [templateCategory, setTemplateCategory] = useState('All')
  const [workflowSearch, setWorkflowSearch] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    hydrateFromStorage().catch(() => {})
    const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === 'local' && changes['ai-flow-workflows']) {
        hydrateFromStorage().catch(() => {})
      }
    }
    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleStorageChange)
  }, [hydrateFromStorage])

  useEffect(() => {
    if (!activeWorkflowId && workflows.length > 0) {
      setActiveWorkflow(workflows[0].id)
    }
  }, [activeWorkflowId, workflows, setActiveWorkflow])

  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) || workflows[0] || null
  const templateCategories = useMemo(
    () => ['All', ...Array.from(new Set(BUILT_IN_TEMPLATES.map((template) => template.category)))],
    []
  )
  const filteredTemplates = templateCategory === 'All'
    ? BUILT_IN_TEMPLATES
    : BUILT_IN_TEMPLATES.filter((template) => template.category === templateCategory)
  const filteredWorkflows = workflows
    .filter((workflow) => workflow.name.toLowerCase().includes(workflowSearch.toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt)

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
    const name = window.prompt('Workflow name', workflow.name)
    if (name?.trim()) {
      updateWorkflow(workflow.id, { name: name.trim() })
    }
  }

  const handleDeleteWorkflow = (workflow: Workflow) => {
    if (window.confirm(`Delete "${workflow.name}"?`)) {
      deleteWorkflow(workflow.id)
      if (activeWorkflowId === workflow.id) {
        setView('workflows')
      }
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
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 overflow-x-auto">
              {templateCategories.map((category) => (
                <button
                  type="button"
                  key={category}
                  onClick={() => setTemplateCategory(category)}
                  className={cn(
                    'h-8 rounded-lg px-3 text-[11px] font-medium transition-colors',
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
                    className={cn(
                      'flex min-h-[170px] flex-col rounded-lg border bg-[#171717] p-4 transition-colors hover:border-white/15',
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
                        <p className="mt-1 line-clamp-2 min-h-[36px] text-[11px] leading-[18px] text-white/35">
                          {workflow.description || 'Local workflow'}
                        </p>
                      </button>
                      <button
                        type="button"
                        title="Run"
                        onClick={() => handleRunWorkflow(workflow)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#7C5CFF]/15 text-[#B8A8FF] transition-colors hover:bg-[#7C5CFF]/25"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {(workflow.tags?.length ? workflow.tags : ['Workflow']).slice(0, 3).map((tag) => (
                        <span key={tag} className="rounded-md bg-white/[0.05] px-2 py-1 text-[10px] text-white/35">
                          {tag}
                        </span>
                      ))}
                    </div>

                    <div className="mt-auto flex items-center justify-between pt-4">
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
                          className="flex h-8 w-8 items-center justify-center rounded-md text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/75"
                        >
                          <FileText className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Duplicate"
                          onClick={() => handleDuplicateWorkflow(workflow)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/75"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Export"
                          onClick={() => downloadWorkflowJson(workflow)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/75"
                        >
                          <FileDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Delete"
                          onClick={() => handleDeleteWorkflow(workflow)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
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
