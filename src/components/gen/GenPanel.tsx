import React, { useState, useRef, useCallback, useEffect } from 'react'
import * as Select from '@radix-ui/react-select'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Upload, Bookmark, Minus, Plus, Trash2,
  Image as ImageIcon, Video, ChevronDown, Download, RotateCcw,
  Search, X, FileText, GripVertical, WandSparkles, Check, ChevronUp
} from 'lucide-react'
import { cn, usePersistedState } from '@/lib/utils'
import { usePromptStore } from '@/stores/dataStore'

// ─── Flow Model Constants ───────────────────────────────────────────────────────

interface FlowModelOption {
  label: string
  value: string
  aliases: string[]
}

// Enable with: localStorage.setItem('AI_FLOW_DEBUG', '1')
// Guard: localStorage only exists in window contexts (popup, options).
// Service worker and content scripts don't have it → avoid throwing ReferenceError
// that would abort bundle evaluation and break service worker registration.
function readDebugFlag(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('AI_FLOW_DEBUG') === '1') {
      return true
    }
  } catch {
    // localStorage access can throw in sandboxed/incognito contexts — ignore
  }
  if (typeof window !== 'undefined') {
    return (window as Record<string, unknown>).__AI_FLOW_DEBUG__ === true
  }
  return false
}
var GP_DEBUG = readDebugFlag()

const FLOW_IMAGE_MODELS: FlowModelOption[] = [
  { label: 'Nano Banana Pro', value: 'Nano Banana Pro', aliases: ['nano-banana-pro', '🍌 Nano Banana Pro'] },
  { label: 'Nano Banana 2',   value: 'Nano Banana 2',   aliases: ['nano-banana-2', '🍌 Nano Banana 2'] },
  { label: 'Nano Banana 2 Lite', value: 'Nano Banana 2 Lite', aliases: ['nano-banana-2-lite'] },
]

const FLOW_VIDEO_MODELS: FlowModelOption[] = [
  { label: 'Omni Flash',             value: 'Omni Flash',                       aliases: ['omni-flash'] },
  { label: 'Veo 3.1 - Lite',         value: 'Veo 3.1 - Lite',                   aliases: ['veo-3.1-lite', 'Veo 3.1 Lite'] },
  { label: 'Veo 3.1 - Fast',         value: 'Veo 3.1 - Fast',                   aliases: ['veo-3.1-fast', 'Veo 3.1 Fast'] },
  { label: 'Veo 3.1 - Quality',       value: 'Veo 3.1 - Quality',                 aliases: ['veo-3.1-quality', 'Veo 3.1 Quality'] },
  { label: 'Veo 3.1 - Lite [Lower Priority]', value: 'Veo 3.1 - Lite [Lower Priority]', aliases: ['veo-3.1-lite-lower-priority', 'Veo 3.1 Lite Lower Priority', 'Veo 3.1 - Lite Lower Priority'] },
]

const DEFAULT_FLOW_IMAGE_MODEL = 'Nano Banana 2'
const DEFAULT_FLOW_VIDEO_MODEL = 'Omni Flash'

// ─── Constants ────────────────────────────────────────────────────────────────

type Provider = 'flow' | 'chatgpt'
type GenMode = 'image' | 'video'
type AspectRatio = '16:9' | '4:3' | '1:1' | '3:4' | '9:16'

const FLOW_LOGO = (
  <svg width="14" height="14" viewBox="0 0 24 24">
    <path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF" />
  </svg>
)

const PROVIDERS: { id: Provider; label: string; svg: React.ReactNode; patterns: (string | RegExp)[] }[] = [
  {
    id: 'flow',
    label: 'Google Flow',
    svg: FLOW_LOGO,
    patterns: [/labs\.google\/fx\/[a-z]{2}\/tools\/flow/],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    svg: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
      </svg>
    ),
    patterns: ['chatgpt.com'],
  },
]

const STYLES = [
  { id: '', name: 'Không chọn phong cách' },
  { id: '1', name: 'Anime' },
  { id: '2', name: 'Realistic' },
  { id: '3', name: 'Watercolor' },
  { id: '4', name: 'Oil Painting' },
  { id: '5', name: 'Pencil Sketch' },
  { id: '6', name: 'Pop Art' },
  { id: '7', name: 'Minimalist' },
  { id: '8', name: 'Impressionist' },
  { id: '9', name: 'Art Nouveau' },
  { id: '10', name: 'Ukiyo-e' },
  { id: '11', name: 'Vintage Film' },
  { id: '12', name: 'Cinematic' },
  { id: '13', name: 'Studio Photo' },
  { id: '14', name: 'Editorial Fashion' },
  { id: '15', name: 'Street Photography' },
  { id: '16', name: 'Drone Aerial' },
  { id: '17', name: 'Macro Close-up' },
  { id: '18', name: 'Long Exposure' },
  { id: '19', name: 'Polaroid' },
  { id: '20', name: 'Tilt-Shift' },
  { id: '21', name: 'Studio Ghibli' },
  { id: '22', name: 'Action Figure Box' },
  { id: '23', name: 'POP Mart Blind Box' },
  { id: '24', name: 'Chibi Kawaii' },
  { id: '25', name: 'AI Generated Portrait' },
  { id: '26', name: 'Y2K Aesthetic' },
  { id: '27', name: 'Cottagecore' },
  { id: '28', name: 'Dark Academia' },
  { id: '29', name: 'Dopamine Decor' },
  { id: '30', name: 'Aesthetic Collage' },
  { id: '31', name: 'Pixar 3D' },
  { id: '32', name: 'Claymorphism' },
  { id: '33', name: 'Isometric 3D' },
  { id: '34', name: 'Low Poly' },
  { id: '35', name: 'Voxel Art' },
  { id: '36', name: 'Glassmorphism' },
  { id: '37', name: 'Neon Wireframe' },
  { id: '38', name: 'Fantasy' },
  { id: '39', name: 'Cyberpunk' },
  { id: '40', name: 'Steampunk' },
  { id: '41', name: 'Pixel Art' },
  { id: '42', name: 'Comic Book' },
  { id: '43', name: 'Stained Glass' },
  { id: '44', name: 'Paper Craft' },
  { id: '45', name: 'Embroidery' },
  { id: '46', name: 'Double Exposure' },
  { id: '47', name: 'Surrealist' },
  { id: '48', name: 'Psychedelic' },
  { id: '49', name: 'Botanical Illustration' },
  { id: '50', name: 'Graffiti Street Art' },
  { id: '51', name: 'Retro Futurism' },
  { id: '52', name: 'Noir Detective' },
  { id: '53', name: 'Baroque' },
]

const ASPECT_RATIOS: { value: AspectRatio; label: string }[] = [
  { value: '16:9', label: '▬ 16:9' },
  { value: '4:3', label: '▭ 4:3' },
  { value: '1:1', label: '□ 1:1' },
  { value: '3:4', label: '▯ 3:4' },
  { value: '9:16', label: '▮ 9:16' },
]

// ─── Toggle component ─────────────────────────────────────────────────────────

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({ checked, onChange }) => (
  <button
    onClick={() => onChange(!checked)}
    className={cn(
      'relative inline-flex h-[20px] w-9 items-center rounded-full transition-colors cursor-pointer',
      checked ? 'bg-[#7C5CFF]' : 'bg-white/10'
    )}
  >
    <span
      className={cn(
        'inline-block h-[14px] w-[14px] rounded-full bg-white transition-transform shadow',
        checked ? 'translate-x-[20px]' : 'translate-x-[3px]'
      )}
    />
  </button>
)

// ─── Style Dropdown ──────────────────────────────────────────────────────────

type CompactDropdownOption = {
  value: string
  label: string
}

const CompactDropdown: React.FC<{
  value: string
  options: CompactDropdownOption[]
  onChange: (v: string) => void
  icon?: React.ReactNode
  className?: string
  menuClassName?: string
  searchable?: boolean
}> = ({ value, options, onChange, icon, className, menuClassName, searchable }) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const filtered = searchable && query.trim()
    ? options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options

  return (
    <div className={cn('relative', className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg border border-transparent bg-[#1A1A1A] px-2 py-1.5 text-[11px] text-white/60 transition-colors hover:border-white/10 hover:bg-white/5 hover:text-white"
      >
        {icon}
        <span className="whitespace-nowrap">{selected?.label || options[0]?.label || 'Select'}</span>
        <ChevronDown className="h-3 w-3 text-white/30" />
      </button>

      {open && (
        <div className={cn('absolute left-0 top-full z-50 mt-1.5 min-w-full overflow-hidden rounded-xl border border-white/10 bg-[#1A1A1A] shadow-2xl', menuClassName)}>
          {searchable && (
            <div className="border-b border-white/5 p-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30 pointer-events-none" />
                <input
                  type="text"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search..."
                  className="w-full pl-8 pr-2 py-1.5 bg-[#141414] rounded-lg text-[11px] text-white/60 placeholder:text-white/25 outline-none border border-white/5 focus:border-white/10"
                />
              </div>
            </div>
          )}
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-white/30">No matches</div>
            ) : (
              filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => { onChange(option.value); setOpen(false) }}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left transition-colors',
                    value === option.value
                      ? 'bg-[#7C5CFF]/15 text-[#7C5CFF]'
                      : 'text-white/60 hover:bg-white/5 hover:text-white'
                  )}
                >
                  <span className="whitespace-nowrap">{option.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const StyleDropdown: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
  <CompactDropdown
    value={value}
    onChange={onChange}
    options={STYLES.map((style) => ({ value: style.id, label: style.name }))}
    menuClassName="w-60"
    searchable
    icon={(
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" />
        <path d="M17 4a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2" />
      </svg>
    )}
  />
)

type PromptAssistantLanguage = 'English' | 'Vietnamese'
type PromptAssistantDetail = 'Concise' | 'Balanced' | 'Detailed'

interface PromptAssistantResult {
  text: string
  mediaType: GenMode
  aspectRatio: AspectRatio
}

const PROMPT_ASSISTANT_STYLES = [
  'Auto',
  'Cinematic',
  'Editorial',
  'Photorealistic',
  'Anime',
  'Product',
  'Documentary',
]

const PROMPT_ASSISTANT_LIGHTING = [
  'Auto',
  'Natural light',
  'Soft studio light',
  'Golden hour',
  'Dramatic light',
  'Neon light',
]

const PROMPT_ASSISTANT_CAMERAS = [
  'Auto',
  'Eye level',
  'Close-up',
  'Wide angle',
  'Low angle',
  'Overhead',
]

const PROMPT_ASSISTANT_TONES = [
  'Auto',
  'Elegant',
  'Energetic',
  'Warm',
  'Moody',
  'Minimal',
]

function buildPromptAssistantText(args: {
  idea: string
  mediaType: GenMode
  count: number
  language: PromptAssistantLanguage
  detail: PromptAssistantDetail
  style: string
  lighting: string
  camera: string
  tone: string
}): string {
  const count = Math.max(1, Math.min(5, args.count))
  const isVietnamese = args.language === 'Vietnamese'
  const variationsEn = [
    'hero composition with a clear focal point',
    'intimate close-up storytelling',
    'wide environmental composition',
    'dynamic perspective with strong depth',
    'minimal composition with intentional negative space',
  ]
  const variationsVi = [
    'bố cục chủ đạo với điểm nhấn rõ ràng',
    'góc cận cảnh giàu tính kể chuyện',
    'bố cục toàn cảnh có môi trường rõ nét',
    'góc nhìn năng động với chiều sâu mạnh',
    'bố cục tối giản với khoảng trống có chủ đích',
  ]

  const detailEn: Record<PromptAssistantDetail, string> = {
    Concise: 'Keep the visual direction clear and concise',
    Balanced: 'Define the subject, environment, composition, materials, and visual hierarchy clearly',
    Detailed: 'Use highly specific visual details, realistic textures, spatial depth, coherent composition, and production-ready art direction',
  }
  const detailVi: Record<PromptAssistantDetail, string> = {
    Concise: 'Giữ định hướng hình ảnh rõ ràng và súc tích',
    Balanced: 'Mô tả rõ chủ thể, bối cảnh, bố cục, chất liệu và thứ bậc thị giác',
    Detailed: 'Dùng chi tiết hình ảnh cụ thể, chất liệu chân thực, chiều sâu không gian, bố cục nhất quán và chỉ đạo nghệ thuật hoàn chỉnh',
  }

  const prompts: string[] = []
  for (let index = 0; index < count; index += 1) {
    const parts = [args.idea.trim().replace(/[.\s]+$/, '')]
    if (isVietnamese) {
      parts.push(args.mediaType === 'video'
        ? 'Tạo video có chuyển động tự nhiên, diễn tiến nhất quán và chuyển động máy quay hợp lý'
        : 'Tạo một ảnh hoàn chỉnh với chủ thể và điểm nhấn thị giác rõ ràng')
      if (args.style !== 'Auto') parts.push(`Phong cách hình ảnh: ${args.style}`)
      if (args.lighting !== 'Auto') parts.push(`Ánh sáng: ${args.lighting}`)
      if (args.camera !== 'Auto') parts.push(`Góc máy: ${args.camera}`)
      if (args.tone !== 'Auto') parts.push(`Sắc thái: ${args.tone}`)
      parts.push(detailVi[args.detail])
      if (count > 1) parts.push(`Biến thể ${index + 1}: ${variationsVi[index % variationsVi.length]}`)
    } else {
      parts.push(args.mediaType === 'video'
        ? 'Create a video with natural motion, temporal continuity, and purposeful camera movement'
        : 'Create a polished still image with a clear subject and visual focal point')
      if (args.style !== 'Auto') parts.push(`Visual style: ${args.style}`)
      if (args.lighting !== 'Auto') parts.push(`Lighting: ${args.lighting}`)
      if (args.camera !== 'Auto') parts.push(`Camera: ${args.camera}`)
      if (args.tone !== 'Auto') parts.push(`Tone: ${args.tone}`)
      parts.push(detailEn[args.detail])
      if (count > 1) parts.push(`Variation ${index + 1}: ${variationsEn[index % variationsEn.length]}`)
    }
    prompts.push(parts.filter(Boolean).join('. ') + '.')
  }
  return prompts.join('\n\n')
}

const AssistantSelect: React.FC<{
  value: string
  options: string[]
  onChange: (value: string) => void
  ariaLabel: string
}> = ({ value, options, onChange, ariaLabel }) => (
  <Select.Root value={value} onValueChange={onChange}>
    <Select.Trigger
      aria-label={ariaLabel}
      className="group flex h-10 w-full items-center justify-between rounded-xl border border-white/[0.08] bg-[#121212] px-3 text-left text-[12px] font-medium text-white/70 outline-none transition-colors hover:border-white/[0.14] hover:bg-[#151515] focus:border-[#7C5CFF]/70 focus:ring-2 focus:ring-[#7C5CFF]/10 data-[placeholder]:text-white/25"
    >
      <Select.Value />
      <Select.Icon asChild>
        <ChevronDown className="h-3.5 w-3.5 text-white/30 transition-transform group-data-[state=open]:rotate-180" />
      </Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content
        position="popper"
        sideOffset={6}
        collisionPadding={12}
        className="z-[200] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-white/[0.1] bg-[#1B1B1B] p-1 shadow-[0_18px_48px_rgba(0,0,0,0.55)]"
      >
        <Select.ScrollUpButton className="flex h-6 items-center justify-center text-white/35">
          <ChevronUp className="h-3.5 w-3.5" />
        </Select.ScrollUpButton>
        <Select.Viewport>
          {options.map((option) => (
            <Select.Item
              key={option}
              value={option}
              className="relative flex h-9 cursor-pointer select-none items-center rounded-lg pl-8 pr-3 text-[12px] text-white/60 outline-none transition-colors data-[highlighted]:bg-[#7C5CFF]/12 data-[highlighted]:text-white data-[state=checked]:text-[#C4B7FF]"
            >
              <Select.ItemIndicator className="absolute left-2.5 inline-flex items-center text-[#9F87FF]">
                <Check className="h-3.5 w-3.5" />
              </Select.ItemIndicator>
              <Select.ItemText>{option}</Select.ItemText>
            </Select.Item>
          ))}
        </Select.Viewport>
        <Select.ScrollDownButton className="flex h-6 items-center justify-center text-white/35">
          <ChevronDown className="h-3.5 w-3.5" />
        </Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>
)

const PromptAssistantModal: React.FC<{
  initialIdea: string
  initialMediaType: GenMode
  initialAspectRatio: AspectRatio
  referenceAliases: string[]
  onClose: () => void
  onApply: (result: PromptAssistantResult) => void
}> = ({ initialIdea, initialMediaType, initialAspectRatio, referenceAliases, onClose, onApply }) => {
  const [idea, setIdea] = useState(initialIdea)
  const [mediaType, setMediaType] = useState<GenMode>(initialMediaType)
  const [count, setCount] = useState(1)
  const [language, setLanguage] = useState<PromptAssistantLanguage>('English')
  const [detail, setDetail] = useState<PromptAssistantDetail>('Balanced')
  const [style, setStyle] = useState('Auto')
  const [lighting, setLighting] = useState('Auto')
  const [camera, setCamera] = useState('Auto')
  const [tone, setTone] = useState('Auto')
  const [assistantAspectRatio, setAssistantAspectRatio] = useState<AspectRatio>(initialAspectRatio)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const appendReferenceAlias = (alias: string) => {
    const token = `@${alias}`
    if (new RegExp(`(^|\\s)${token}(?=\\s|$)`, 'i').test(idea)) return
    setIdea((current) => `${current.trim()}${current.trim() ? ' ' : ''}${token}`)
  }

  const applyAssistant = () => {
    if (!idea.trim()) return
    onApply({
      text: buildPromptAssistantText({
        idea,
        mediaType,
        count,
        language,
        detail,
        style,
        lighting,
        camera,
        tone,
      }),
      mediaType,
      aspectRatio: assistantAspectRatio,
    })
  }

  const labelClass = 'mb-2 block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      className="absolute inset-0 z-[80] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[5px]"
      onMouseDown={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.99 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="flex max-h-[calc(100vh-32px)] w-full max-w-[700px] flex-col overflow-hidden rounded-[18px] border border-white/[0.1] bg-[#181818] shadow-[0_28px_90px_rgba(0,0,0,0.68)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex min-h-[64px] shrink-0 items-center gap-3 border-b border-white/[0.07] px-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#7C5CFF]/25 bg-[#7C5CFF]/12 text-[#B8A8FF] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            <WandSparkles className="h-[17px] w-[17px]" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-white/90">Prompt Assistant</h2>
            <p className="mt-0.5 truncate text-[11px] text-white/35">Shape an idea into production-ready prompts</p>
          </div>
          <button type="button" onClick={onClose} className="ml-auto flex h-9 w-9 items-center justify-center rounded-xl text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white" title="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section>
            <div className="mb-2 flex items-end justify-between gap-4">
              <label className="text-[12px] font-semibold text-white/70">What do you want to create?</label>
              <span className="text-[10px] text-white/25">Idea, scene, script, or shot list</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-[#111111] p-1.5 transition-colors focus-within:border-[#7C5CFF]/55 focus-within:ring-2 focus-within:ring-[#7C5CFF]/10">
              <textarea
                autoFocus
                value={idea}
                onChange={(event) => setIdea(event.target.value)}
                placeholder="Describe the result you want. Mention references with @image1, @image2..."
                className="min-h-[138px] w-full resize-y bg-transparent px-3 py-2.5 text-[13px] leading-6 text-white/80 outline-none placeholder:text-white/22"
              />
              <div className="flex min-h-8 items-center gap-2 border-t border-white/[0.05] px-2 pt-1.5">
                <WandSparkles className="h-3.5 w-3.5 text-[#8F76F5]" />
                <span className="text-[10px] text-white/28">Assistant keeps your intent and adds visual direction.</span>
              </div>
            </div>
          </section>

          {referenceAliases.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-medium text-white/30">References</span>
              {referenceAliases.map((alias) => (
                <button
                  key={alias}
                  type="button"
                  onClick={() => appendReferenceAlias(alias)}
                  className="rounded-lg border border-[#7C5CFF]/20 bg-[#7C5CFF]/10 px-2 py-1 text-[10px] font-semibold text-[#B8A8FF] transition-colors hover:border-[#7C5CFF]/40 hover:bg-[#7C5CFF]/16"
                >
                  @{alias}
                </button>
              ))}
            </div>
          )}

          <section className="mt-5">
            <span className={labelClass}>Visual direction</span>
            <div className="flex flex-wrap gap-2">
              {PROMPT_ASSISTANT_STYLES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setStyle(option)}
                  className={cn(
                    'h-9 rounded-xl border px-3 text-[12px] font-medium transition-all',
                    style === option
                      ? 'border-[#7C5CFF]/55 bg-[#7C5CFF]/16 text-[#D0C6FF] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                      : 'border-white/[0.07] bg-[#121212] text-white/45 hover:border-white/[0.14] hover:bg-[#151515] hover:text-white/75'
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          </section>

          <section className="mt-5 rounded-2xl border border-white/[0.07] bg-[#141414] p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-[12px] font-semibold text-white/70">Output setup</h3>
                <p className="mt-0.5 text-[10px] text-white/28">Controls are applied back to the Gen tab.</p>
              </div>
              <span className="rounded-lg bg-[#7C5CFF]/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#A995FF]">{mediaType}</span>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <span className={labelClass}>Media type</span>
                <div className="grid grid-cols-2 gap-1 rounded-xl border border-white/[0.07] bg-[#0F0F0F] p-1">
                  {(['image', 'video'] as GenMode[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setMediaType(option)}
                      className={cn(
                        'flex h-9 items-center justify-center gap-2 rounded-lg text-[12px] font-semibold capitalize transition-all',
                        mediaType === option
                          ? 'bg-[#7C5CFF]/20 text-[#D0C6FF] shadow-sm'
                          : 'text-white/35 hover:bg-white/[0.04] hover:text-white/65'
                      )}
                    >
                      {option === 'image' ? <ImageIcon className="h-3.5 w-3.5" /> : <Video className="h-3.5 w-3.5" />}
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className={labelClass}>Prompt count</span>
                <div className="flex h-11 items-center justify-between rounded-xl border border-white/[0.07] bg-[#0F0F0F] px-1.5">
                  <button type="button" onClick={() => setCount((current) => Math.max(1, current - 1))} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 hover:bg-white/[0.05] hover:text-white">
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <div className="text-center">
                    <span className="text-[14px] font-semibold text-white/80">{count}</span>
                    <span className="ml-1.5 text-[10px] text-white/28">{count === 1 ? 'prompt' : 'prompts'}</span>
                  </div>
                  <button type="button" onClick={() => setCount((current) => Math.min(5, current + 1))} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 hover:bg-white/[0.05] hover:text-white">
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-4">
              <span className={labelClass}>Aspect ratio</span>
              <div className="grid grid-cols-5 gap-1 rounded-xl border border-white/[0.07] bg-[#0F0F0F] p-1">
              {ASPECT_RATIOS.map((ratio) => (
                <button
                  key={ratio.value}
                  type="button"
                  onClick={() => setAssistantAspectRatio(ratio.value)}
                  className={cn(
                    'h-9 rounded-lg text-[11px] font-semibold transition-all',
                    assistantAspectRatio === ratio.value
                      ? 'bg-[#7C5CFF]/20 text-[#D0C6FF]'
                      : 'text-white/35 hover:bg-white/[0.04] hover:text-white/65'
                  )}
                >
                  {ratio.value}
                </button>
              ))}
              </div>
            </div>
          </section>

          <button
            type="button"
            onClick={() => setAdvancedOpen((current) => !current)}
            className="mt-4 flex w-full items-center gap-2 rounded-xl border border-white/[0.07] bg-[#121212] px-3 py-2.5 text-left text-[11px] font-semibold text-white/45 transition-colors hover:border-white/[0.12] hover:text-white/75"
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-180')} />
            Advanced
          </button>

          {advancedOpen && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-3 grid grid-cols-1 gap-3 overflow-hidden sm:grid-cols-2">
              <div>
                <span className={labelClass}>Language</span>
                <AssistantSelect value={language} options={['English', 'Vietnamese']} onChange={(value) => setLanguage(value as PromptAssistantLanguage)} ariaLabel="Prompt language" />
              </div>
              <div>
                <span className={labelClass}>Detail level</span>
                <AssistantSelect value={detail} options={['Concise', 'Balanced', 'Detailed']} onChange={(value) => setDetail(value as PromptAssistantDetail)} ariaLabel="Prompt detail level" />
              </div>
              <div>
                <span className={labelClass}>Lighting</span>
                <AssistantSelect value={lighting} options={PROMPT_ASSISTANT_LIGHTING} onChange={setLighting} ariaLabel="Lighting" />
              </div>
              <div>
                <span className={labelClass}>Camera</span>
                <AssistantSelect value={camera} options={PROMPT_ASSISTANT_CAMERAS} onChange={setCamera} ariaLabel="Camera" />
              </div>
              <div className="sm:col-span-2">
                <span className={labelClass}>Tone</span>
                <AssistantSelect value={tone} options={PROMPT_ASSISTANT_TONES} onChange={setTone} ariaLabel="Tone" />
              </div>
            </motion.div>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-3 border-t border-white/[0.07] bg-[#151515] px-5 py-3.5">
          <div className="hidden min-w-0 flex-1 sm:block">
            <p className="truncate text-[11px] font-medium text-white/45">{count} {count === 1 ? 'prompt' : 'prompts'} · {mediaType} · {assistantAspectRatio}</p>
            <p className="mt-0.5 text-[9px] text-white/22">Your current prompt is replaced only after generation.</p>
          </div>
          <button type="button" onClick={onClose} className="h-10 rounded-xl px-4 text-[12px] font-semibold text-white/40 transition-colors hover:bg-white/[0.05] hover:text-white/75">
            Cancel
          </button>
          <button
            type="button"
            onClick={applyAssistant}
            disabled={!idea.trim()}
            className={cn(
              'flex h-10 min-w-[170px] items-center justify-center gap-2 rounded-xl px-5 text-[12px] font-semibold transition-all',
              idea.trim()
                ? 'bg-[#7C5CFF] text-white shadow-[0_8px_24px_rgba(124,92,255,0.28)] hover:bg-[#8768FF] active:translate-y-px'
                : 'cursor-not-allowed bg-white/5 text-white/20'
            )}
          >
            <WandSparkles className="h-4 w-4" />
            Generate prompts
          </button>
        </footer>
      </motion.div>
    </motion.div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export const GenPanel: React.FC<{
  activeGenProvider: string
  onProviderChange: (p: string) => void
  onHideFlowOverlay?: () => void
}> = ({ activeGenProvider, onProviderChange, onHideFlowOverlay }) => {
  const [prompt, setPrompt] = usePersistedState<string>('genpanel.prompt', '')
  const addPrompt = usePromptStore((s) => s.addPrompt)
  const savedPrompts = usePromptStore((s) => s.prompts)
  const activeProvider = activeGenProvider as Provider
  const [mode, setMode] = usePersistedState<GenMode>('genpanel.mode', 'image')
  const [imageModel, setImageModel] = usePersistedState<string>('genpanel.imageModel', DEFAULT_FLOW_IMAGE_MODEL)
  const [videoModel, setVideoModel] = usePersistedState<string>('genpanel.videoModel', DEFAULT_FLOW_VIDEO_MODEL)

  // ── Derived values ──────────────────────────────────────────────────────────
  const isVideoMode = mode === 'video'

  const activeModelOptions = isVideoMode ? FLOW_VIDEO_MODELS : FLOW_IMAGE_MODELS

  const activeModel = isVideoMode ? videoModel : imageModel

  const setActiveModel = (value: string) => {
    if (isVideoMode) {
      setVideoModel(value)
    } else {
      setImageModel(value)
    }
  }

  // Guard: if activeModel is stale (not in current options), reset to default
  useEffect(() => {
    const valid = activeModelOptions.some(m => m.value === activeModel)
    if (!valid) {
      if (isVideoMode) {
        setVideoModel(DEFAULT_FLOW_VIDEO_MODEL)
      } else {
        setImageModel(DEFAULT_FLOW_IMAGE_MODEL)
      }
    }
  }, [mode, activeModel])

  // ── Mode change handler ────────────────────────────────────────────────────
  // Throttle log to avoid spam
  const lastModeChangeLogRef = useRef<number>(0)
  function handleModeChange(nextMode: GenMode) {
    const now = Date.now()
    const prevMode = mode
    if (prevMode !== nextMode && now - lastModeChangeLogRef.current > 500) {
      lastModeChangeLogRef.current = now
      if (GP_DEBUG) console.log('[GenPanel][MODE_CHANGE]', JSON.stringify({
        fromMode: prevMode,
        toMode: nextMode,
        before: {
          imageModel,
          videoModel,
          aspectRatio,
          quantity,
        },
      }, null, 2))
    }
    if (nextMode === 'video') {
      if (!FLOW_VIDEO_MODELS.some(m => m.value === videoModel)) {
        setVideoModel(DEFAULT_FLOW_VIDEO_MODEL)
      }
    } else {
      if (!FLOW_IMAGE_MODELS.some(m => m.value === imageModel)) {
        setImageModel(DEFAULT_FLOW_IMAGE_MODEL)
      }
    }
    setMode(nextMode)
  }

  type FlowVideoDuration = '4s' | '6s' | '8s' | '10s'
  const FLOW_VIDEO_DURATIONS: readonly FlowVideoDuration[] = ['4s', '6s', '8s']
  const OMNI_FLASH_VIDEO_DURATIONS: readonly FlowVideoDuration[] = ['4s', '6s', '8s', '10s']
  const [videoDuration, setVideoDuration] = usePersistedState<FlowVideoDuration>('genpanel.videoDuration', '8s')
  const activeVideoDurationOptions = videoModel === 'Omni Flash'
    ? OMNI_FLASH_VIDEO_DURATIONS
    : FLOW_VIDEO_DURATIONS

  // Flow Video input mode — Khung hình / Thành phần. Google Flow only.
  // Default is 'frame' (Khung hình) so new Gen-tab users start with the
  // option we want visible first. Empty string '' stays as the legacy
  // sentinel meaning "do not touch the Flow tab — rely on whatever Flow
  // currently shows" and is only reachable by users who had it persisted
  // before this default flipped. `usePersistedState` reads existing
  // localStorage first, so existing users (persisted '' or any value
  // they picked) keep their behavior — only fresh installs get 'frame'.
  type FlowVideoMode = 'frame' | 'ingredient'
  const [flowVideoMode, setFlowVideoMode] = usePersistedState<'' | FlowVideoMode>('genpanel.flowVideoMode', 'frame')

  const [aspectRatio, setAspectRatio] = usePersistedState<AspectRatio>('genpanel.aspectRatio', '16:9')
  const [quantity, setQuantity] = usePersistedState<number>('genpanel.quantity', 1)
  const [styleId, setStyleId] = usePersistedState<string>('genpanel.styleId', '')
  const [autoDownload, setAutoDownload] = usePersistedState<boolean>('genpanel.autoDownload', true)
  const [subFolder, setSubFolder] = usePersistedState<string>('genpanel.subFolder', 'aiflow-01')
  const [downloadRes, setDownloadRes] = usePersistedState<string>('genpanel.downloadRes', '2k')
  const [videoDownloadRes, setVideoDownloadRes] = usePersistedState<string>('genpanel.videoDownloadRes', '720p')
  const [refImages, setRefImages] = useState<RefImage[]>([])
  // frameFileIds: only populated when Video Frames mode is active (not implemented yet — future)
  // isFrames is true ONLY when frameFileIds is present; never inferred from refImages.length
  const [frameFileIds, setFrameFileIds] = useState<{ frame1?: string; frame2?: string } | undefined>(undefined)
  // Pending upload store: maps upload_xxx key → real File object
  const [pendingUploads, setPendingUploads] = useState<Record<string, File>>({})
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    if (/toby[_-]?flow/i.test(subFolder)) {
      setSubFolder(subFolder.replace(/toby[_-]?flow/gi, 'aiflow'))
    }
  }, [subFolder, setSubFolder])

  useEffect(() => {
    if (!activeVideoDurationOptions.includes(videoDuration)) {
      setVideoDuration('8s')
    }
  }, [videoModel, videoDuration])
  const [isGenerating, setIsGenerating] = useState(false)
  const [genStatus, setGenStatus] = useState<'idle' | 'generating' | 'done'>('idle')
  const [flowStep, setFlowStep] = useState('')
  const [tileCounts, setTileCounts] = useState({ generating: 0, done: 0, failed: 0, total: 0 })
  const [tileMonitorActive, setTileMonitorActive] = useState(false)
  const [genCount, setGenCount] = useState(0)
  const [generatedCount, setGeneratedCount] = useState(0)
  const [multiPrompt, setMultiPrompt] = usePersistedState<boolean>('genpanel.multiPrompt', false)
  const [refMode, setRefMode] = usePersistedState<string>('genpanel.refMode', 'all')
  const [imageMention, setImageMention] = useState<{ start: number; query: string } | null>(null)
  const [imageMentionIndex, setImageMentionIndex] = useState(0)
  const [showSearch, setShowSearch] = useState(false)
  const [failedPrompts, setFailedPrompts] = useState<string[]>([])
  const [promptQueue, setPromptQueue] = useState<PromptRun[]>([])
  const [runAbortController, setRunAbortController] = useState<AbortController | null>(null)
  const [promptSaveStatus, setPromptSaveStatus] = useState<'idle' | 'saved'>('idle')
  const [promptSearchQuery, setPromptSearchQuery] = useState('')
  const [promptSearchTab, setPromptSearchTab] = useState<'my' | 'template'>('my')
  const [promptAssistantOpen, setPromptAssistantOpen] = useState(false)

  // ── Multi-Prompt Types ────────────────────────────────────────────────────────
  type PromptRunStatus = 'pending' | 'running' | 'success' | 'partial' | 'failed'

  interface PromptRun {
    id: string
    index: number
    text: string
    status: PromptRunStatus
    startedAt?: number
    finishedAt?: number
    result?: {
      successCount: number
      failCount: number
      error?: string
    }
  }

  const imageInputRef = useRef<HTMLInputElement>(null)
  const txtInputRef = useRef<HTMLInputElement>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Throttled RENDER_STATE log — only fires when key UI state changes
  const lastRenderLogRef = useRef<string>('')
  useEffect(() => {
    const snapshot = JSON.stringify({
      mode, imageModel, videoModel, aspectRatio, quantity, videoDuration, flowVideoMode,
    })
    if (snapshot !== lastRenderLogRef.current) {
      lastRenderLogRef.current = snapshot
      if (GP_DEBUG) console.log('[GenPanel][RENDER_STATE]', JSON.stringify({
        mode,
        isVideoMode: mode === 'video',
        imageModel,
        videoModel,
        activeModel: mode === 'video' ? videoModel : imageModel,
        activeModelOptions: (mode === 'video' ? FLOW_VIDEO_MODELS : FLOW_IMAGE_MODELS).map(m => m.value),
        aspectRatio,
        quantity,
        videoDuration,
        flowVideoMode,
      }, null, 2))
    }
  }, [mode, imageModel, videoModel, aspectRatio, quantity, videoDuration, flowVideoMode])

  const prompts = prompt.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
  const promptWordCount = prompt.trim().split(/\s+/).filter(Boolean).length
  const canSaveCurrentPrompt = prompts.length === 1
  const normalizedPromptSearch = promptSearchQuery.trim().toLowerCase()
  const filteredSavedPrompts = savedPrompts.filter((savedPrompt) => {
    if (!normalizedPromptSearch) return true
    return (
      savedPrompt.name.toLowerCase().includes(normalizedPromptSearch) ||
      savedPrompt.content.toLowerCase().includes(normalizedPromptSearch)
    )
  })
  const saveCurrentPromptTitle =
    prompts.length === 0
      ? 'Enter one prompt to save'
      : prompts.length > 1
        ? 'Only one prompt can be saved'
        : promptSaveStatus === 'saved'
          ? 'Prompt saved'
          : 'Save current prompt'

  // ── Auto-detect multi-prompt ──────────────────────────────────────────────────
  // Keep the toggle aligned with the actual non-empty prompt blocks, so it
  // turns back off after the user deletes a block.
  useEffect(() => {
    const shouldUseMultiPrompt = activeProvider === 'flow' && prompts.length >= 2
    if (multiPrompt !== shouldUseMultiPrompt) {
      setMultiPrompt(shouldUseMultiPrompt)
    }
  }, [prompts.length, multiPrompt, activeProvider, setMultiPrompt])

  const handleSaveCurrentPrompt = useCallback(() => {
    const blocks = prompt.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
    if (blocks.length !== 1) return

    const content = blocks[0]
    const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || content
    const name = firstLine.length > 48 ? `${firstLine.slice(0, 45).trim()}...` : firstLine
    const provider = activeProvider === 'flow' ? 'google-flow' : 'chatgpt'

    addPrompt({
      name,
      content,
      provider,
      tags: ['gen']
    })

    setPromptSaveStatus('saved')
    window.setTimeout(() => setPromptSaveStatus('idle'), 1200)
  }, [activeProvider, addPrompt, prompt])

  const openPromptSearch = useCallback(() => {
    setPromptSearchTab('my')
    setPromptSearchQuery('')
    setShowSearch(true)
  }, [])

  const closePromptSearch = useCallback(() => {
    setShowSearch(false)
    setPromptSearchQuery('')
  }, [])

  const applySavedPrompt = useCallback((content: string) => {
    setPrompt(content)
    closePromptSearch()
  }, [closePromptSearch, setPrompt])

  // ── Reference image data model ────────────────────────────────────────────────
  interface RefImage {
    /** Unique key: either tileId from Flow, or upload_xxx for local files awaiting upload */
    id: string
    /** Display name (file.name or tile filename) */
    name?: string
    /** Thumbnail preview (data URL for local files, tile thumbnail URL for generated) */
    thumbnail?: string
    /** 'image' or 'video' */
    type?: 'image' | 'video'
    /** Stable prompt alias without the @ prefix, e.g. image1 */
    alias?: string
  }

  function getRefImageAlias(ref: RefImage, index: number): string {
    return ref.alias || `image${index + 1}`
  }

  function mentionedImageAliases(promptText: string): Set<string> {
    const aliases = new Set<string>()
    for (const match of promptText.matchAll(/@image\d+\b/gi)) {
      aliases.add(match[0].slice(1).toLowerCase())
    }
    return aliases
  }

  function selectReferenceImagesForPrompt(promptText: string, images: RefImage[]): RefImage[] {
    if (refMode === 'none') return []
    if (refMode !== 'mention') return images
    const aliases = mentionedImageAliases(promptText)
    return images.filter((ref, index) => aliases.has(getRefImageAlias(ref, index).toLowerCase()))
  }

  const imageMentionOptions = refImages.map((ref, index) => ({
    ref,
    alias: getRefImageAlias(ref, index),
    index,
  }))
  const filteredImageMentionOptions = imageMention
    ? imageMentionOptions.filter((option) => option.alias.toLowerCase().includes(imageMention.query.toLowerCase()))
    : []

  useEffect(() => {
    if (refMode !== 'mention' || refImages.length === 0) {
      setImageMention(null)
      setImageMentionIndex(0)
    }
  }, [refMode, refImages.length])

  const updateImageMentionFromPrompt = (value: string, cursor: number) => {
    if (refMode !== 'mention' || refImages.length === 0) {
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

  const insertImageMention = (alias: string) => {
    const textarea = promptTextareaRef.current
    const currentCursor = textarea?.selectionStart ?? prompt.length
    const replaceStart = imageMention?.start ?? currentCursor
    const before = prompt.slice(0, replaceStart)
    const after = prompt.slice(currentCursor)
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
    const needsTrailingSpace = after.length === 0 || !/^\s/.test(after)
    const inserted = `${needsLeadingSpace ? ' ' : ''}@${alias}${needsTrailingSpace ? ' ' : ''}`
    const nextPrompt = before + inserted + after
    const nextCursor = before.length + inserted.length

    setPrompt(nextPrompt)
    setImageMention(null)
    setImageMentionIndex(0)
    requestAnimationFrame(() => {
      const input = promptTextareaRef.current
      if (!input) return
      input.focus()
      input.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const handlePromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!imageMention || filteredImageMentionOptions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setImageMentionIndex((current) => (current + 1) % filteredImageMentionOptions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setImageMentionIndex((current) => (current - 1 + filteredImageMentionOptions.length) % filteredImageMentionOptions.length)
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const selected = filteredImageMentionOptions[imageMentionIndex] || filteredImageMentionOptions[0]
      if (selected) insertImageMention(selected.alias)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setImageMention(null)
    }
  }

  // ── Pending upload store helpers ────────────────────────────────────────────
  function makeUploadKey(): string {
    return 'upload_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
  }

  /**
   * Convert a File to a serializable base64 payload (safe to pass through chrome.runtime).
   */
  function fileToBase64Payload(file: File): Promise<{ key: string; name: string; type: string; base64: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1] // strip data:... prefix
        resolve({ key: '', name: file.name, type: file.type, base64 })
      }
      reader.onerror = () => reject(new Error('FileReader failed for: ' + file.name))
      reader.readAsDataURL(file)
    })
  }

  /**
   * Upload a single file to Flow via background script, return real tileId.
   * Background handles: find Flow tab → inject scripts → route to content script → bridge → DOM upload.
   */
  async function uploadFileToFlow(base64Payload: { name: string; type: string; base64: string }): Promise<{ tileId: string; fileName: string; thumbnail?: string }> {
    const response = await chrome.runtime.sendMessage({
      action: 'FLOW_UPLOAD_IMAGE',
      payload: base64Payload,
    })

    const res = response as Record<string, unknown>

    if (!res.success) {
      throw new Error('Upload failed for: ' + base64Payload.name + ' — ' + (res.error || 'unknown'))
    }

    const tileId = String(res.tileId || '')
    const fileName = String(res.fileName || base64Payload.name || '')
    const thumbnail = res.thumbnail ? String(res.thumbnail) : undefined

    if (!tileId || tileId.startsWith('upload_')) {
      throw new Error('Invalid tileId returned for ' + base64Payload.name + ': ' + tileId)
    }

    return { tileId, fileName, thumbnail }
  }

  /**
   * Resolve all upload_xxx keys in refImages to real Flow tile IDs.
   * - tileId keys: kept as-is
   * - upload_xxx keys: uploaded to Flow, then replaced with real tileId
   * Returns resolved ref list, fileIds, and fileNameMap.
   * ABORTS with error if any upload fails.
   */
  async function resolveReferenceImagesBeforeRun(
    refImages: RefImage[],
    pendingUploads: Record<string, File>,
  ): Promise<{
    resolvedRefImages: RefImage[]
    resolvedFileIds: string[]
    resolvedFileNameMap: Record<string, string>
  }> {
    const resolvedRefImages: RefImage[] = []
    const resolvedFileIds: string[] = []
    const resolvedFileNameMap: Record<string, string> = {}

    for (const ref of refImages) {
      if (ref.id.startsWith('upload_')) {
        const file = pendingUploads[ref.id]
        if (!file) {
          throw new Error('REF_UPLOAD_FILE_MISSING: ' + ref.id)
        }

        console.log('[GenPanel][REF_UPLOAD_START] ' + ref.id + ' (' + ref.name + ')')

        const base64Payload = await fileToBase64Payload(file)
        base64Payload.key = ref.id

        let uploadResult: { tileId: string; fileName: string; thumbnail?: string }
        try {
          uploadResult = await uploadFileToFlow(base64Payload)
        } catch (err) {
          console.error('[GenPanel][REF_UPLOAD_FAILED] ' + ref.id + ' (' + ref.name + '): ' + ((err as Error).message || String(err)))
          throw new Error('REF_UPLOAD_FAILED: ' + ref.id + ' — ' + ((err as Error).message || String(err)))
        }

        const realTileId = uploadResult.tileId
        const realFileName = uploadResult.fileName || ref.name || base64Payload.name

        console.log('[GenPanel][REF_UPLOAD_DONE] ' + ref.id + ' -> ' + realTileId + ' (' + realFileName + ')')

        resolvedRefImages.push({
          id: realTileId,
          name: realFileName,
          thumbnail: uploadResult.thumbnail || ref.thumbnail,
          type: ref.type,
          alias: ref.alias,
        })
        resolvedFileIds.push(realTileId)
        resolvedFileNameMap[realTileId] = realFileName
      } else {
        // Real tileId from existing Flow image
        resolvedRefImages.push(ref)
        resolvedFileIds.push(ref.id)
        if (ref.name) resolvedFileNameMap[ref.id] = ref.name
      }
    }

    return { resolvedRefImages, resolvedFileIds, resolvedFileNameMap }
  }

  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files) return
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    // Mutable tracker shared across async onload closures
    const tracker = {
      count: 0,
      newImages: new Array<RefImage>(imageFiles.length),
      pending: {} as Record<string, File>,
    }

    imageFiles.forEach((file, fileIndex) => {
      const uploadKey = makeUploadKey()
      tracker.pending[uploadKey] = file
      const reader = new FileReader()
      reader.onload = (e) => {
        tracker.newImages[fileIndex] = {
          id: uploadKey,
          name: file.name,
          thumbnail: e.target?.result as string,
          type: 'image',
        }
        tracker.count++
        if (tracker.count === imageFiles.length) {
          setPendingUploads((prev) => ({ ...prev, ...tracker.pending }))
          setRefImages((prev) => {
            const highestAlias = prev.reduce((highest, ref, index) => {
              const match = getRefImageAlias(ref, index).match(/^image(\d+)$/i)
              return Math.max(highest, match ? Number(match[1]) : 0)
            }, 0)
            const aliasedImages = tracker.newImages.map((image, index) => ({
              ...image,
              alias: `image${highestAlias + index + 1}`,
            }))
            return [...prev, ...aliasedImages]
          })
          if (imageInputRef.current) {
            imageInputRef.current.value = ''
          }
        }
      }
      reader.readAsDataURL(file)
    })
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFileSelect(e.dataTransfer.files)
  }, [handleFileSelect])




interface FlowPayload {
  prompt: string
  provider: 'google_flow'
  mode: 'image' | 'video'
  model: string
  aspectRatio: string
  quantity: number
  duration?: string
  style: string | null
  // fileIds: stable IDs for reference images (tileId or upload_xxx for pending)
  fileIds: string[]
  // fileNameMap: maps fileId → display name for fallback when tile is stale
  fileNameMap: Record<string, string>
  // frameFileIds: only used in Video Frames mode. fileIds must be empty for Frames path.
  frameFileIds?: { frame1?: string; frame2?: string }
  // Google Flow Video only — selects "Khung hình" / "Thành phần" in the
  // settings popup. Distinct from `frameFileIds` (which targets the
  // legacy Frames code path); flowVideoMode covers the unified control
  // Flow shipped 2026-Q3. omit (undefined) to keep legacy behavior.
  flowVideoMode?: 'frame' | 'ingredient'
  // pendingFiles: REMOVED — resolved to tileIds in GenPanel before RUN_FLOW_PROMPT
  autoDownload: boolean
  outputFolder: string
  resolution: string
  videoDownloadResolution: string
  // ── Source-of-call flags ─────────────────────────────────────
  // 'gen-tab' → caller is GenPanel; autoDownload is honored.
  // 'workflow' → caller is the workflow runner; autoDownload is
  //   forced to false downstream regardless of this field so the
  //   workflow node never auto-downloads files to the user's disk.
  // Defaults to 'gen-tab' for any pre-existing code path that
  // doesn't set this explicitly (back-compat).
  source?: 'gen-tab' | 'workflow'
  // Whether the caller wants the output assets collected and
  // returned via `outputs[]` / `images[]` / `imageUrls[]` even
  // when auto-download is suppressed. Default true.
  collectOutputs?: boolean
  // Hard switch: when true, flow-content never auto-downloads,
  // even if `autoDownload === true`. Used by workflow callers
  // that set `source: 'workflow'` — the field is redundant with
  // `source` but explicit so future caller types can opt in.
  suppressAutoDownload?: boolean
  debugGenState: {
    mode: string
    isVideoMode: boolean
    imageModel: string
    videoModel: string
    activeModel: string
    activeModelOptions: string[]
    aspectRatio: string
    quantity: number
    builtAt: string
  }
  // Multi-prompt queue metadata
  promptIndex?: number
  promptTotal?: number
}

function buildGenerationPayload(
  resolvedRefImages: RefImage[],
  resolvedFileIds: string[],
  resolvedFileNameMap: Record<string, string>,
): FlowPayload {
  const isVideoMode = mode === 'video'
  const activeModelForPayload = isVideoMode ? videoModel : imageModel

  // ── isFrames: ONLY true when frameFileIds is present ─────────────
  // NEVER infer from fileIds.length.
  const hasFrameFileIds = frameFileIds && (frameFileIds.frame1 || frameFileIds.frame2)
  const isFrames = hasFrameFileIds

  // ── Ref limit enforcement ───────────────────────────────────────
  const maxRefs = isFrames
    ? 0 // Frames use frameFileIds, not fileIds
    : isVideoMode
      ? 3 // Video Ingredients max 3
      : 10 // Image max 10

  if (resolvedRefImages.length > maxRefs) {
    console.warn('[GenPanel][REF_LIMIT] ' + resolvedRefImages.length + ' refs → sliced to ' + maxRefs + ' (' + mode + ' mode)')
  }

  // ── frameFileIds: only for Video Frames ─────────────────────────
  const effectiveFrameFileIds = isFrames ? frameFileIds : undefined

  // ── Video model constraint: Veo 3.1 Lite/Fast + has refs → force 8s ─
  let effectiveDuration = isVideoMode ? videoDuration : undefined
  const modelLower = activeModelForPayload.toLowerCase()
  const needs8sConstraint =
    isVideoMode &&
    (modelLower.includes('veo 3.1') || modelLower.includes('veo3.1')) &&
    (modelLower.includes('lite') || modelLower.includes('fast')) &&
    resolvedFileIds.length > 0

  if (needs8sConstraint && effectiveDuration !== '8s') {
    effectiveDuration = '8s'
    console.warn('[GenPanel][DURATION_CONSTRAINT] Veo 3.1 Lite/Fast + refs → forced to 8s (was ' + videoDuration + ')')
  }

  const payload: FlowPayload = {
    prompt: prompt,
    provider: 'google_flow',
    mode: mode,
    model: activeModelForPayload,
    aspectRatio: aspectRatio,
    quantity: Math.max(1, Math.min(4, quantity)),
    duration: effectiveDuration,
    style: styleId || null,
    // Only real tileIds — NO upload_xxx keys in final payload
    fileIds: resolvedFileIds,
    fileNameMap: resolvedFileNameMap,
    frameFileIds: effectiveFrameFileIds,
    // Google Flow Video only — Forward flowVideoMode only when the user
    // explicitly picked a value AND we're in the right mode. Empty
    // string from persisted state means "legacy / do not touch".
    flowVideoMode: isVideoMode && (flowVideoMode === 'frame' || flowVideoMode === 'ingredient')
      ? flowVideoMode
      : undefined,
    autoDownload: autoDownload,
    outputFolder: subFolder,
    resolution: downloadRes,
    videoDownloadResolution: videoDownloadRes,
    // Source-of-call: Gen tab always honors autoDownload. Even if
    // the global setting is off, we still want collectOutputs to
    // run so the local UI can show thumbnails in the GenPanel
    // results area (downloaded=false in that case).
    source: 'gen-tab',
    collectOutputs: true,
    suppressAutoDownload: false,
    debugGenState: {
      mode,
      isVideoMode,
      imageModel,
      videoModel,
      activeModel: activeModelForPayload,
      activeModelOptions: (isVideoMode ? FLOW_VIDEO_MODELS : FLOW_IMAGE_MODELS).map(m => m.value),
      aspectRatio,
      quantity,
      videoDuration,
      builtAt: new Date().toISOString(),
    },
  }

  if (GP_DEBUG) console.log('[GenPanel][AUTO_DOWNLOAD_UI_STATE]', JSON.stringify({
    autoDownload: autoDownload,
    outputFolder: subFolder,
    downloadResolution: downloadRes,
    videoDownloadResolution: videoDownloadRes,
  }))

  // Validate: no upload_xxx keys must exist in the final payload
  for (const fid of payload.fileIds) {
    if (fid.startsWith('upload_')) {
      throw new Error('REF_UPLOAD_NOT_RESOLVED: ' + fid + ' found in fileIds — upload was not resolved before payload build')
    }
  }

  // REF_PAYLOAD log
  if (GP_DEBUG) console.log('[GenPanel][REF_PAYLOAD]', JSON.stringify({
    mode: payload.mode,
    refCount: payload.fileIds.length,
    fileIds: payload.fileIds,
    fileNameMapCount: Object.keys(payload.fileNameMap).length,
    frameFileIds: effectiveFrameFileIds,
    isFrames: isFrames,
  }))

  return payload
}

async function runFlowGeneration(payload: FlowPayload): Promise<Record<string, unknown>> {
  const response = await chrome.runtime.sendMessage({
    action: 'RUN_FLOW_PROMPT',
    payload,
  })
  return response as Record<string, unknown>
}

// ── classifyResult — shared for both single and multi paths ──────────────────
function classifyResult(
  result: Record<string, unknown> | null | undefined,
  autoDownload: boolean,
): PromptRunStatus {
  if (autoDownload) {
    const autoDl = (result?.autoDownload as Record<string, number>) || {}
    const successCount = autoDl.successCount ?? 0
    const failCount = autoDl.failCount ?? 0
    if (successCount > 0 && failCount > 0) return 'partial'
    if (successCount > 0 && failCount === 0) return 'success'
    return 'failed'
  }
  return result?.success ? 'success' : 'failed'
}

// ── runPromptQueue — multi-prompt orchestration ─────────────────────────────
const runPromptQueue = useCallback(async (
  promptTexts: string[],
): Promise<void> => {
  if (promptTexts.length === 0) return

  const controller = new AbortController()
  setRunAbortController(controller)

  const queue: PromptRun[] = promptTexts.map((text, i) => ({
    id: `${Date.now()}_${i}`,
    index: i,
    text,
    status: 'pending',
  }))
  setPromptQueue([...queue])
  setFailedPrompts([])
  setIsGenerating(true)
  setGenStatus('generating')

  let successTotal = 0
  let partialTotal = 0
  let failedTotal = 0
  const failedRuns: string[] = []

  try {
    // ── Resolve ref images ONE TIME before the loop ───────────────────────────
    let resolvedRefImages: RefImage[] = []
    let resolvedFileNameMap: Record<string, string> = {}

    const queueRefImages = refMode === 'mention'
      ? refImages.filter((ref, index) => {
          const alias = getRefImageAlias(ref, index).toLowerCase()
          return promptTexts.some((text) => mentionedImageAliases(text).has(alias))
        })
      : selectReferenceImagesForPrompt('', refImages)

    if (queueRefImages.length > 0) {
      setFlowStep('Uploading reference images...')
      const resolved = await resolveReferenceImagesBeforeRun(queueRefImages, pendingUploads)
      resolvedRefImages = resolved.resolvedRefImages
      resolvedFileNameMap = resolved.resolvedFileNameMap
    }

    // ── Sequential loop ───────────────────────────────────────────────────────
    let completed = 0

    for (let i = 0; i < queue.length; i++) {
      const run = queue[i]

      if (controller.signal.aborted) {
        setPromptQueue(prev => prev.map(r =>
          (r.status === 'pending' || r.status === 'running')
            ? { ...r, status: 'failed', startedAt: r.startedAt, finishedAt: Date.now() }
            : r
        ))
        setFlowStep('Cancelled')
        break
      }

      setPromptQueue(prev => prev.map(r =>
        r.id === run.id
          ? { ...r, status: 'running', startedAt: Date.now() }
          : r
      ))
      setFlowStep(`[${i + 1}/${queue.length}] ${run.text.slice(0, 50)}...`)

      const promptRefImages = selectReferenceImagesForPrompt(run.text, resolvedRefImages)
      const promptRefIds = promptRefImages.map((ref) => ref.id)
      const promptRefNameMap = Object.fromEntries(
        promptRefIds
          .filter((id) => resolvedFileNameMap[id])
          .map((id) => [id, resolvedFileNameMap[id]])
      )
      const payload = buildGenerationPayload(promptRefImages, promptRefIds, promptRefNameMap)
      payload.prompt = run.text
      payload.promptIndex = i
      payload.promptTotal = queue.length

      const result = await runFlowGeneration(payload)
      completed++

      const status = classifyResult(result, autoDownload)

      setPromptQueue(prev => prev.map(r =>
        r.id === run.id
          ? {
              ...r,
              status,
              finishedAt: Date.now(),
              result: {
                successCount: ((result?.autoDownload as Record<string, number>) || {}).successCount ?? 0,
                failCount: ((result?.autoDownload as Record<string, number>) || {}).failCount ?? 0,
              },
            }
          : r
      ))

      if (status === 'success') successTotal++
      else if (status === 'partial') partialTotal++
      else {
        failedTotal++
        failedRuns.push(run.text)
      }

      setFlowStep(`${completed}/${queue.length} completed`)
    }

    // ── Final state from local counters ────────────────────────────────────
    const okTotal = successTotal + partialTotal
    setGenStatus(okTotal > 0 ? 'done' : 'idle')
    setFlowStep(
      failedTotal === 0
        ? `All ${okTotal} completed`
        : `${okTotal} done, ${failedTotal} failed`
    )
    setGeneratedCount(okTotal)
    setFailedPrompts([...failedRuns])

  } catch (err) {
    setFlowStep('Error: ' + ((err as Error).message || String(err)))
    setGenStatus('idle')
  } finally {
    setIsGenerating(false)
    setRunAbortController(null)
  }
}, [autoDownload, refImages, pendingUploads, refMode, mode, aspectRatio, quantity, videoDuration,
    imageModel, videoModel, frameFileIds, styleId, subFolder,
    downloadRes, videoDownloadRes])

// ── handleRetryAll ──────────────────────────────────────────────────────────
const handleRetryAll = useCallback(async () => {
  if (isGenerating || failedPrompts.length === 0) return
  await runPromptQueue([...failedPrompts])
}, [isGenerating, failedPrompts, runPromptQueue])

// ── handleCancel ────────────────────────────────────────────────────────────
const handleCancel = useCallback(() => {
  runAbortController?.abort()
}, [runAbortController])

interface TileCounts {
  generating: number
  done: number
  failed: number
  total: number
}

const handleGenerate = useCallback(async () => {
  if (!prompt.trim()) return

  const promptTexts = prompt.split(/\n\n+/).map(p => p.trim()).filter(Boolean)

  // ── Multi-prompt path: flow + 2+ blocks ────────────────────────────────────
  if (activeProvider === 'flow' && promptTexts.length >= 2) {
    await runPromptQueue(promptTexts)
    return
  }

  // ── Single-prompt path (unchanged) ─────────────────────────────────────────
  if (activeProvider === 'flow') {
    let stopped = false

    const stopMonitor = () => {
      stopped = true
      chrome.runtime.sendMessage({ action: 'FLOW_STOP_TILE_MONITOR' }).catch(() => {})
      setTileMonitorActive(false)
    }

    try {
      setIsGenerating(true)
      setGenStatus('generating')
      setFlowStep('Finding Flow tab...')
      setTileCounts({ generating: 0, done: 0, failed: 0, total: 0 })

      // Find Flow tab
      const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' })
      const flowTab = tabs.find(t => t.url?.includes('labs.google/fx'))
      if (!flowTab?.id) {
        throw new Error('No Flow tab found. Please open a Flow project first.')
      }

      const hasFrameFileIds = frameFileIds && (frameFileIds.frame1 || frameFileIds.frame2)
      const selectedRefImages = selectReferenceImagesForPrompt(prompt, refImages)
      console.log('[GenPanel][RUN_CLICK_STATE]', JSON.stringify({
        mode,
        isVideoMode: mode === 'video',
        imageModel,
        videoModel,
        activeModel: mode === 'video' ? videoModel : imageModel,
        ratio: aspectRatio,
        quantity,
        videoDuration,
        duration: mode === 'video' ? videoDuration : '',
        isFrames: !!hasFrameFileIds,
        refCount: selectedRefImages.length,
      }, null, 2))

      // ── Step 0: Resolve all upload_xxx keys to real Flow tile IDs ──
      // This must happen BEFORE building the payload.
      // Abort early if any upload fails — don't send a broken prompt to Flow.
      let resolvedRefImages: RefImage[] = []
      let resolvedFileIds: string[] = []
      let resolvedFileNameMap: Record<string, string> = {}

      if (selectedRefImages.length > 0) {
        setFlowStep('Uploading reference images...')
        const resolved = await resolveReferenceImagesBeforeRun(selectedRefImages, pendingUploads)
        resolvedRefImages = resolved.resolvedRefImages
        resolvedFileIds = resolved.resolvedFileIds
        resolvedFileNameMap = resolved.resolvedFileNameMap
      }

      // Build base payload with resolved ref data (no upload_xxx, no File objects)
      const payload = buildGenerationPayload(resolvedRefImages, resolvedFileIds, resolvedFileNameMap)

      // Build payload throws REF_UPLOAD_NOT_RESOLVED if any upload_xxx slips through
      setFlowStep('Sending prompt to Flow...')
      const result = await runFlowGeneration(payload)

      if (result.success) {
        setFlowStep('Generate started! Monitoring tiles...')

        // Start tile monitor in bridge via background
        await chrome.runtime.sendMessage({
          action: 'FLOW_START_TILE_MONITOR',
          tabId: flowTab.id,
          intervalMs: 1000
        })
        setTileMonitorActive(true)

        // Poll tile counts every second
        const pollInterval = setInterval(async () => {
          if (stopped) {
            clearInterval(pollInterval)
            return
          }
          try {
            const counts = await chrome.runtime.sendMessage({
              action: 'FLOW_GET_TILE_COUNTS',
              tabId: flowTab.id
            }) as TileCounts

            if (counts && counts.total > 0) {
              setTileCounts(counts)

              // Check if generation complete
              if (counts.generating === 0 && (counts.done > 0 || counts.failed > 0)) {
                clearInterval(pollInterval)
                setGenStatus('done')
                setFlowStep(counts.failed > 0 ? `${counts.done} done, ${counts.failed} failed` : `${counts.done} completed`)
                stopMonitor()
              }
            }
          } catch (_) {}
        }, 1000)

      } else {
        // Partial success: Flow generated fewer than expected but we downloaded
        // at least one. No alert needed -- surface the soft message and return
        // to idle. Do NOT start tile monitor; the auto-download already ran.
        const dl = (result.downloadDetails) as { expected?: number; downloaded?: number; generationPartial?: boolean } | undefined
        const downloaded = dl?.downloaded ?? (result.autoDownload as { successCount?: number } | undefined)?.successCount ?? 0
        const expected = dl?.expected ?? 0
        const failed = expected - downloaded
        setFlowStep(
          downloaded > 0
            ? `Partial success: downloaded ${downloaded}${failed > 0 ? `, ${failed} failed in Flow` : ''}`
            : `Flow partial: ${expected} expected, downloaded 0`
        )
        setGenStatus('idle')
        setIsGenerating(false)
        return
      }
    } catch (err) {
      const msg = (err as Error).message || String(err)
      if (msg.startsWith('REF_UPLOAD_')) {
        setFlowStep('Upload failed: ' + msg)
      } else {
        setFlowStep('')
      }
      alert(msg)
      setGenStatus('idle')
    } finally {
      setIsGenerating(false)
    }
    return
  }

  // ── ChatGPT path (independent of Flow) ──────────────────────────────────
  if (activeProvider === 'chatgpt') {
    console.log('[ChatGPT][GenPanel] handleGenerate start, prompt len:', prompt.length, 'refs:', refImages.length)
    let jobId: string | undefined
    try {
      setIsGenerating(true)
      setGenStatus('generating')
      setFlowStep('[ChatGPT] Starting...')

      // 0. Build mediaUploads from any pending local files. We do NOT
      // route through resolveReferenceImagesBeforeRun — that helper is
      // Flow-specific (uploads to Flow's tile system to get a tileId).
      // ChatGPT wants raw base64 + mime type, and the content script
      // uploads them via the DOM file input.
      // Files without a matching pendingUploads entry (e.g. a real
      // tileId from a previous Flow run) are skipped — they cannot be
      // re-sent to ChatGPT without re-reading the bytes.
      const mediaUploads: { base64: string; type: string }[] = []
      for (const ref of refImages) {
        if (!ref.id.startsWith('upload_')) continue
        const file = pendingUploads[ref.id]
        if (!file) continue
        const payload = await fileToBase64Payload(file)
        mediaUploads.push({ base64: payload.base64, type: payload.type })
      }
      if (mediaUploads.length > 0) {
        console.log('[ChatGPT][GenPanel] mediaUploads prepared:', mediaUploads.length)
        setFlowStep(`[ChatGPT] Uploading ${mediaUploads.length} reference image${mediaUploads.length !== 1 ? 's' : ''}...`)
      }

      // 1. Submit: returns { accepted: true, jobId } immediately.
      const submitResult = await chrome.runtime.sendMessage({
        action: 'RUN_CHATGPT_PROMPT',
        payload: {
          prompt,
          autoDownload,
          outputFolder: subFolder,
          mediaUploads,
        },
      }) as { success: boolean; accepted?: boolean; jobId?: string; error?: string } | undefined

      if (!submitResult?.success || !submitResult.accepted || !submitResult.jobId) {
        const errMsg = submitResult?.error || 'ChatGPT job submission failed'
        console.error('[ChatGPT][GenPanel] submit failed:', errMsg)
        setFlowStep('[ChatGPT] Error: ' + errMsg)
        setGenStatus('idle')
        alert(errMsg)
        return
      }
      jobId = submitResult.jobId
      setFlowStep('[ChatGPT] Generating...')

      // 2. Poll GET_CHATGPT_JOB_STATUS until terminal state or 600s.
      const POLL_INTERVAL_MS = 1500
      const MAX_POLL_MS = 600000
      const pollStart = Date.now()
      let lastStepUpdate = 0

      // Outer loop: bounded by max poll budget.
      while (Date.now() - pollStart < MAX_POLL_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

        let statusRes
        try {
          statusRes = await chrome.runtime.sendMessage({
            action: 'GET_CHATGPT_JOB_STATUS',
            payload: { jobId },
          }) as { success: boolean; job?: { status: string; downloaded: number; imageUrls: string[]; error: string; finishedAt?: number }; error?: string } | undefined
        } catch (pollErr) {
          // Transient — keep polling.
          console.warn('[ChatGPT][GenPanel] poll error (will retry):', pollErr)
          continue
        }

        if (!statusRes?.success || !statusRes.job) {
          // Job missing from storage. Could have been cleaned up.
          console.warn('[ChatGPT][GenPanel] job not found:', jobId)
          setFlowStep('[ChatGPT] Error: Job not found in storage')
          setGenStatus('idle')
          alert('ChatGPT job not found — it may have expired')
          return
        }

        const job = statusRes.job

        // Periodic status update (every ~3s)
        const now = Date.now()
        if (now - lastStepUpdate > 3000) {
          const elapsed = Math.round((now - pollStart) / 1000)
          setFlowStep(`[ChatGPT] Generating... ${elapsed}s`)
          lastStepUpdate = now
        }

        if (job.status === 'running') continue

        // Terminal state.
        if (job.status === 'done') {
          const downloaded = job.downloaded || 0
          if (autoDownload && downloaded > 0) {
            setFlowStep(`[ChatGPT] Downloaded ${downloaded} image${downloaded !== 1 ? 's' : ''}`)
          } else {
            setFlowStep('[ChatGPT] Generation complete')
          }
          setGenStatus('done')
          console.log('[ChatGPT][GenPanel] success — downloaded:', downloaded)
          return
        }

        if (job.status === 'failed') {
          const errMsg = job.error || 'ChatGPT generation failed'
          console.error('[ChatGPT][GenPanel] job failed:', errMsg)
          setFlowStep('[ChatGPT] Error: ' + errMsg)
          setGenStatus('idle')
          alert(errMsg)
          return
        }

        // Unknown status — keep polling.
      }

      // Fell out of poll loop without reaching a terminal state.
      const timeoutErr = 'ChatGPT generation polling timed out after ' + Math.round(MAX_POLL_MS / 1000) + 's'
      console.error('[ChatGPT][GenPanel]', timeoutErr)
      setFlowStep('[ChatGPT] Error: ' + timeoutErr)
      setGenStatus('idle')
      alert(timeoutErr)
    } catch (err) {
      const msg = (err as Error).message || String(err)
      console.error('[ChatGPT][GenPanel] exception:', msg)
      setFlowStep('[ChatGPT] Error: ' + msg)
      setGenStatus('idle')
      alert(msg)
    } finally {
      setIsGenerating(false)
    }
    return
  }

}, [prompt, multiPrompt, activeProvider, isGenerating, runPromptQueue, mode, aspectRatio, quantity, videoDuration, imageModel, videoModel, refImages, pendingUploads, refMode, frameFileIds, styleId, subFolder, autoDownload, downloadRes, videoDownloadRes])

  return (
    <div className="relative flex flex-col h-full bg-[#0A0A0A]">
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">

        {/* ── Prompt Section ── */}
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/30">
                <path d="M12 3a3 3 0 0 0 -3 3v12a3 3 0 0 0 3 3" />
                <path d="M6 3a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3" />
                <path d="M13 7h7a1 1 0 0 1 1 1v8a1 1 0 0 1 -1 1h-7" />
                <path d="M5 7h-1a1 1 0 0 0 -1 1v8a1 1 0 0 0 1 1h1" />
                <path d="M17 12h.01" />
                <path d="M13 12h.01" />
              </svg>
              <label className="text-[11px] font-medium text-white/50">Prompt</label>
              <span className="text-[10px] text-white/20 ml-1">
                <span className="text-white/40">{prompts.length}</span> prompt → <span className="text-white/40">{prompts.length}</span> output(s)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-white/20">Multi-Prompt</span>
              <Toggle checked={multiPrompt} onChange={setMultiPrompt} />
            </div>
          </div>

          <div className="relative rounded-xl overflow-hidden border border-white/5">
            <textarea
              ref={promptTextareaRef}
              value={prompt}
              onChange={(event) => {
                const value = event.target.value
                setPrompt(value)
                updateImageMentionFromPrompt(value, event.target.selectionStart ?? value.length)
              }}
              onKeyDown={handlePromptKeyDown}
              placeholder={`Describe what you want to generate...\n\n${multiPrompt ? 'Separate each prompt with a blank line' : ''}`}
              className="w-full min-h-[140px] px-3 py-2.5 bg-[#141414] text-xs text-white/70 placeholder:text-white/15 outline-none resize-none leading-relaxed"
              style={{ fontFamily: 'inherit' }}
            />

            {imageMention && filteredImageMentionOptions.length > 0 && (
              <div className="absolute bottom-10 left-3 z-40 max-h-32 w-56 overflow-y-auto rounded-xl border border-white/10 bg-[#1A1A1A] py-1 shadow-2xl">
                {filteredImageMentionOptions.map((option, optionIndex) => (
                  <button
                    key={option.ref.id}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertImageMention(option.alias)}
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-2 text-left text-[11px] transition-colors',
                      optionIndex === imageMentionIndex
                        ? 'bg-[#7C5CFF]/15 text-[#B8A8FF]'
                        : 'text-white/60 hover:bg-white/5 hover:text-white'
                    )}
                  >
                    <img
                      src={option.ref.thumbnail || option.ref.id}
                      alt=""
                      className="h-7 w-7 rounded-md object-cover"
                    />
                    <span className="font-medium">@{option.alias}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Prompt toolbar */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-[#1A1A1A] border-t border-white/5">
              <button
                type="button"
                onClick={openPromptSearch}
                className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/5 transition-colors"
                title="Search prompt"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M2 14.25c.41 0 .75.34.75.75v2.5c0 2.07 1.68 3.75 3.75 3.75H9c.41 0 .75.34.75.75s-.34.75-.75.75H6.5c-2.89 0-5.25-2.35-5.25-5.25V15c0-.41.34-.75.75-.75m20 1c.41 0 .75.34.75.75v1.5c0 2.9-2.36 5.25-5.25 5.25H16c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h1.5c2.07 0 3.75-1.68 3.75-3.75V16c0-.41.34-.75.75-.75" fill="currentColor" />
                  <path fillRule="evenodd" d="M14 5.75c2.42 0 3.75 1.33 3.75 3.75v1.75H19c.41 0 .75.34.75.75s-.34.75-.75.75h-1.25v1.75c0 2.42-1.33 3.75-3.75 3.75h-4c-2.42 0-3.75-1.33-3.75-3.75v-1.75H5c-.41 0-.75-.34-.75-.75s.34-.75.75-.75h1.25V9.5c0-2.42 1.33-3.75 3.75-3.75zm-6.25 7v1.75c0 1.58.67 2.25 2.25 2.25h4c1.58 0 2.25-.67 2.25-2.25v-1.75zM10 7.25c-1.58 0-2.25.67-2.25 2.25v1.75h8.5V9.5c0-1.58-.67-2.25-2.25-2.25z" fill="currentColor" clipRule="evenodd" />
                  <path d="M9 1.25c.41 0 .75.34.75.75s-.34.75-.75.75H6.5c-2.07 0-3.75 1.68-3.75 3.75V9c0 .41-.34.75-.75.75s-.75-.34-.75-.75V6.5c0-2.9 2.36-5.25 5.25-5.25zm8.5 0c2.89 0 5.25 2.35 5.25 5.25V9c0 .41-.34.75-.75.75s-.75-.34-.75-.75V6.5c0-2.07-1.68-3.75-3.75-3.75H15c-.41 0-.75-.34-.75-.75s.34-.75.75-.75z" fill="currentColor" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setPromptAssistantOpen(true)}
                className="flex h-7 items-center gap-1.5 rounded-lg border border-[#7C5CFF]/20 bg-[#7C5CFF]/8 px-2.5 text-[11px] font-semibold text-[#B8A8FF] transition-colors hover:border-[#7C5CFF]/40 hover:bg-[#7C5CFF]/14 hover:text-[#D2C9FF]"
              >
                <WandSparkles className="h-3.5 w-3.5" />
                Prompt Assistant
              </button>
              <button
                onClick={() => txtInputRef.current?.click()}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-white/50 hover:text-white hover:bg-white/5 transition-colors border border-transparent hover:border-white/10"
              >
                <FileText className="w-3 h-3" />
                Import .txt
              </button>
              <input ref={txtInputRef} type="file" accept=".txt,.csv" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) {
                  const reader = new FileReader()
                  reader.onload = (ev) => setPrompt((ev.target?.result as string) || '')
                  reader.readAsText(file)
                }
              }} />
              <button
                type="button"
                onClick={handleSaveCurrentPrompt}
                disabled={!canSaveCurrentPrompt}
                className={cn(
                  'ml-auto p-1.5 rounded-lg transition-colors',
                  canSaveCurrentPrompt
                    ? 'text-white/30 hover:text-white hover:bg-white/5'
                    : 'cursor-not-allowed text-white/15',
                  promptSaveStatus === 'saved' && 'bg-[#7C5CFF]/10 text-[#9B82FF]'
                )}
                title={saveCurrentPromptTitle}
              >
                <Bookmark className="w-4 h-4" />
              </button>
            </div>

            {multiPrompt && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#141414] border-t border-white/5 text-[10px] text-white/25">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                Separate each prompt with a blank line
              </div>
            )}
          </div>
        </div>

        {/* ── Provider Selector ── */}
        <div className="px-4 pb-3">
          <div className="flex items-center gap-1.5 bg-[#141414] rounded-xl p-1 border border-white/5">
            {PROVIDERS.map((provider) => {
              const handleClick = async () => {
                console.log(`[Provider][GenPanel] switch provider=${provider.id}`)
                onProviderChange(provider.id)
                if (provider.id === 'flow') {
                  onHideFlowOverlay?.()
                }
                try {
                  console.log(`[Provider][GenPanel] open tab requested provider=${provider.id}`)
                  await chrome.runtime.sendMessage({
                    action: 'OPEN_PROVIDER_TAB',
                    payload: { provider: provider.id }
                  })
                } catch (err) {
                  console.warn(`[Provider][GenPanel] open tab failed provider=${provider.id}:`, (err as Error).message)
                }
              }
              return (
              <button
                key={provider.id}
                onClick={handleClick}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11px] font-medium transition-all border',
                  activeProvider === provider.id
                    ? 'bg-white/10 text-white border-white/20'
                    : 'text-white/40 border-transparent hover:bg-white/5 hover:text-white/60'
                )}
              >
                <span className="flex-shrink-0">{provider.svg}</span>
                <span>{provider.label}</span>
              </button>
              )
            })}
          </div>
        </div>

        {/* ── Generation Settings ── */}
        <div className="px-4 pb-3">
          <div className="flex items-center gap-1.5 mb-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/30">
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
            <label className="text-[11px] font-medium text-white/50">Settings</label>
          </div>

          {/* Compact settings bar */}
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Mode Toggle — Google Flow only */}
            {activeProvider === 'flow' && (
              <div className="flex items-center bg-[#141414] rounded-lg border border-white/5">
                <button
                  onClick={() => handleModeChange('image')}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all',
                    mode === 'image' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/60'
                  )}
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                  Image
                </button>
                <button
                  onClick={() => handleModeChange('video')}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all',
                    mode === 'video' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/60'
                  )}
                >
                  <Video className="w-3.5 h-3.5" />
                  Video
                </button>
              </div>
            )}

            {/* Model Select — Google Flow only */}
            {activeProvider === 'flow' && (
              <CompactDropdown
                key={`model-${mode}`}
                value={activeModel}
                onChange={setActiveModel}
                options={activeModelOptions.map((m) => ({ value: m.value, label: m.label }))}
              />
            )}

            {/* Video mode — Google Flow Video only ("Khung hình" / "Thành phần"). Default visual is "Khung hình". */}
            {activeProvider === 'flow' && mode === 'video' && (
              <CompactDropdown
                value={flowVideoMode || 'frame'}
                onChange={(value) => setFlowVideoMode(value === 'ingredient' || value === 'frame' ? value : '')}
                options={[
                  { value: 'frame', label: 'Khung hình' },
                  { value: 'ingredient', label: 'Thành phần' }
                ]}
              />
            )}

            {/* Duration — Video only */}
            {activeProvider === 'flow' && mode === 'video' && (
              <CompactDropdown
                value={videoDuration}
                onChange={(value) => setVideoDuration(value as typeof videoDuration)}
                options={activeVideoDurationOptions.map((duration) => ({ value: duration, label: duration }))}
              />
            )}

            {/* Aspect Ratio */}
            <CompactDropdown
              value={aspectRatio}
              onChange={(value) => setAspectRatio(value as AspectRatio)}
              options={ASPECT_RATIOS}
            />

            {/* Quantity — Google Flow only */}
            {activeProvider === 'flow' && (
              <div className="flex items-center gap-0.5 bg-[#141414] rounded-lg border border-white/5 px-1">
                <button
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="w-6 h-6 flex items-center justify-center rounded text-white/40 hover:text-white hover:bg-white/5 transition-colors text-sm font-medium"
                >
                  -
                </button>
                <input
                  type="number"
                  value={quantity}
                  min={1}
                  max={4}
                  onChange={(e) => setQuantity(Math.min(4, Math.max(1, parseInt(e.target.value) || 1)))}
                  className="w-7 text-center bg-transparent text-[11px] text-white/70 outline-none"
                />
                <button
                  onClick={() => setQuantity((q) => Math.min(4, q + 1))}
                  className="w-6 h-6 flex items-center justify-center rounded text-white/40 hover:text-white hover:bg-white/5 transition-colors text-sm font-medium"
                >
                  +
                </button>
              </div>
            )}

            {/* Style Dropdown */}
            <StyleDropdown value={styleId} onChange={setStyleId} />
          </div>
        </div>

        {/* ── Reference Images (Flow + ChatGPT) ── */}
        {(
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="flex items-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-white/30">
                  <path d="M9 5.62a2.38 2.38 0 1 1 0 4.76 2.38 2.38 0 0 1 0-4.76" fill="currentColor" />
                  <path fillRule="evenodd" d="M16.19 2C19.83 2 22 4.17 22 7.81v8.38c0 3.64-2.17 5.81-5.81 5.81H7.81c-2.39 0-4.157-.94-5.078-2.623l-.172-.347a5 5 0 0 1-.171-.422l-.022-.062C2.126 17.855 2 17.069 2 16.19V7.81C2 4.17 4.17 2 7.81 2zM7.81 3.5C4.99 3.5 3.5 4.99 3.5 7.81v8.38c0 .76.13 1.41.35 1.97l3.74-2.51c.8-.54 1.93-.48 2.64.14l.34.28c.78.67 2.04.67 2.82 0l4.16-3.57c.78-.67 2.04-.67 2.82 0l.13.11v-4.8c0-2.82-1.49-4.31-4.31-4.31z" fill="currentColor" fillRule="evenodd" />
                </svg>
                <label className="text-[11px] font-medium text-white/50">Reference Images</label>
              </div>
            {activeProvider === 'flow' && (
              <CompactDropdown
                value={refMode}
                onChange={setRefMode}
                className="ml-auto"
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'mention', label: '@Mention' },
                  { value: 'sequential', label: 'Sequential' },
                  { value: 'none', label: 'None' },
                ]}
              />
            )}
            <button
              onClick={() => setShowSearch(!showSearch)}
              className="p-1 rounded-lg text-white/30 hover:text-white hover:bg-white/5 transition-colors"
              title="Search..."
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </div>

          {!(activeProvider === 'flow' && refMode === 'none') && (
          <>
            {/* Upload bar */}
            <div className="flex items-center gap-1.5">
            <button
              onClick={() => imageInputRef.current?.click()}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-[#141414] rounded-xl text-[11px] text-white/40 hover:text-white/60 hover:bg-white/5 transition-colors border border-white/5 border-dashed hover:border-white/10"
            >
              <Upload className="w-4 h-4" />
              Select image / Drag here
            </button>
            <button
              className="p-2.5 bg-[#141414] rounded-xl text-white/40 hover:text-white hover:bg-white/5 transition-colors border border-white/5"
              title="Screen capture"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="4" fill="currentColor" />
                <path d="M22 12C22 16.714 22 19.0711 20.5355 20.5355C19.0711 22 16.714 22 12 22C7.28595 22 4.92893 22 3.46447 20.5355C2 19.0711 2 16.714 2 12C2 7.28595 2 4.92893 3.46447 3.46447C4.92893 2 7.28595 2 12 2C16.714 2 19.0711 2 20.5355 3.46447C21.5093 4.43821 21.8356 5.80655 21.9449 8" strokeLinecap="round" />
              </svg>
            </button>
            <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => handleFileSelect(e.target.files)} />
            </div>

          {/* Drag hint + count */}
            <div className="flex items-center justify-between mt-1.5">
            {refImages.length > 0 && activeProvider === 'flow' && (
              <span className="text-[10px] text-white/25 flex items-center gap-1">
                <GripVertical className="w-3 h-3" />
                Drag to reorder
              </span>
            )}
            {refImages.length > 0 && (
              <span className="ml-auto text-[10px] text-white/20">{refImages.length} selected</span>
            )}
            </div>

          {/* Image grid */}
            {refImages.length > 0 && (
            <div className="mt-2 grid grid-cols-4 gap-1.5 h-full">
              {refImages.map((img, i) => {
                const alias = getRefImageAlias(img, i)
                return (
                  <div key={img.id} className="relative group h-full min-h-0">
                    <img src={img.thumbnail || img.id} alt={`Reference @${alias}`} className="w-full h-full object-cover rounded-lg" />
                    <span className="pointer-events-none absolute left-1 top-1 rounded-md bg-[#7C5CFF]/85 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                      @{alias}
                    </span>
                    <button
                      onClick={() => setRefImages((prev) => prev.filter((_, idx) => idx !== i))}
                      className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-4 h-4 text-white" />
                    </button>
                  </div>
                )
              })}
            </div>
            )}
            {refImages.length > 0 && refMode === 'mention' && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-white/[0.03] px-2 py-1.5 text-[10px] text-white/30">
              <span>Use in prompt:</span>
              {refImages.map((ref, index) => {
                const alias = getRefImageAlias(ref, index)
                return (
                  <button
                    key={ref.id}
                    type="button"
                    onClick={() => insertImageMention(alias)}
                    className="rounded-md bg-[#7C5CFF]/10 px-1.5 py-0.5 font-medium text-[#B8A8FF] hover:bg-[#7C5CFF]/20"
                  >
                    @{alias}
                  </button>
                )
              })}
            </div>
            )}
          </>
          )}
        </div>
        )}

        {/* ── Auto Download Row ── */}
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Toggle checked={autoDownload} onChange={setAutoDownload} />
              <span className="text-[11px] text-white/50">Auto download</span>
            </div>

            {autoDownload && (
              <>
                {/* Subfolder input */}
                <div className="relative flex-1 min-w-[120px]">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 10V16M12 16L10 14M12 16L14 14M12.0627 6.06274L11.9373 5.93726C11.5914 5.59135 11.4184 5.4184 11.2166 5.29472C11.0376 5.18506 10.8425 5.10425 10.6385 5.05526C10.4083 5 10.1637 5 9.67452 5H6.2C5.0799 5 4.51984 5 4.09202 5.21799C3.71569 5.40973 3.40973 5.71569 3.21799 6.09202C3 6.51984 3 7.07989 3 8.2V15.8C3 16.9201 3 17.4802 3.21799 17.908C3.40973 18.2843 3.71569 18.5903 4.09202 18.782C4.51984 19 5.07989 19 6.2 19H17.8C18.9201 19 19.4802 19 19.908 18.782C20.2843 18.5903 20.5903 18.2843 20.782 17.908C21 17.4802 21 16.9201 21 15.8V10.2C21 9.0799 21 8.51984 20.782 8.09202C20.5903 7.71569 20.2843 7.40973 19.908 7.21799C19.4802 7 18.9201 7 17.8 7H14.3255C13.8363 7 13.5917 7 13.3615 6.94474C13.1575 6.89575 12.9624 6.81494 12.7834 6.70528C12.5816 6.5816 12.4086 6.40865 12.0627 6.06274" />
                  </svg>
                  <input
                    type="text"
                    value={subFolder}
                    onChange={(e) => setSubFolder(e.target.value)}
                    placeholder="Folder"
                    className="w-full pl-8 pr-2 py-1.5 bg-[#141414] rounded-lg text-[11px] text-white/60 placeholder:text-white/25 outline-none border border-white/5 focus:border-white/10"
                  />
                </div>

                {/* Resolution — image vs video based on current mode */}
                <CompactDropdown
                  value={mode === 'video' ? videoDownloadRes : downloadRes}
                  onChange={(value) => {
                    if (mode === 'video') {
                      setVideoDownloadRes(value)
                    } else {
                      setDownloadRes(value)
                    }
                  }}
                  options={
                    mode === 'video'
                      ? [
                          { value: '720p', label: '720p (HD)' },
                          { value: '1080p', label: '1080p (Full HD)' },
                          { value: '4k', label: '4K (Ultra)' },
                        ]
                      : [
                          { value: '1k', label: '1K' },
                          { value: '2k', label: '2K' },
                          { value: '4k', label: '4K (Ultra)' },
                        ]
                  }
                />
              </>
            )}
          </div>
        </div>

        {/* ── Failed Prompts Section ── */}
        {failedPrompts.length > 0 && (
          <div className="px-4 pb-3">
            <div className="bg-[#141414] rounded-xl border border-white/5 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span className="text-[11px] text-white/60">Failed prompts ({failedPrompts.length})</span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={handleRetryAll}
                    disabled={isGenerating}
                    className="px-2 py-1 rounded-lg text-[10px] text-[#7C5CFF] hover:bg-[#7C5CFF]/10 transition-colors disabled:opacity-30"
                  >
                    Retry all
                  </button>
                  <button
                    onClick={() => setFailedPrompts([])}
                    className="p-1 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="p-2 space-y-1 max-h-32 overflow-y-auto">
                {failedPrompts.map((p, i) => (
                  <div key={i} className="text-[11px] text-white/40 px-2 py-1 rounded hover:bg-white/5">
                    {p}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Prompt Queue Panel (multi only, 2+ prompts) ── */}
        {multiPrompt && promptQueue.length > 1 && (
          <div className="px-4 pb-3">
            <div className="bg-[#141414] rounded-xl border border-white/5 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[#7C5CFF]">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
                <span className="text-[11px] text-white/60">Queue ({promptQueue.length})</span>
                {isGenerating && runAbortController && (
                  <button
                    onClick={handleCancel}
                    className="ml-auto px-2 py-0.5 rounded-lg text-[10px] text-white/40 hover:text-white/60 hover:bg-white/5 transition-colors border border-white/10"
                  >
                    Cancel
                  </button>
                )}
              </div>
              <div className="p-2 space-y-1 max-h-48 overflow-y-auto">
                {promptQueue.map((run) => {
                  const statusIcon = run.status === 'success' ? (
                    <span className="text-emerald-400 font-bold text-[10px]">&#x2713;</span>
                  ) : run.status === 'partial' ? (
                    <span className="text-amber-400 font-bold text-[10px]">&#x21BB;</span>
                  ) : run.status === 'failed' ? (
                    <span className="text-red-400 font-bold text-[10px]">&#x2717;</span>
                  ) : run.status === 'running' ? (
                    <div className="w-3 h-3 border border-[#7C5CFF] border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <span className="text-white/20 font-bold text-[10px]">&#x25CB;</span>
                  )
                  return (
                    <div key={run.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5">
                      {statusIcon}
                      <span className="text-[11px] text-white/60 flex-shrink-0">{run.index + 1}.</span>
                      <span className="text-[11px] text-white/50 truncate flex-1">{run.text}</span>
                      {run.status !== 'pending' && run.result && (
                        <span className="text-[10px] text-white/30 flex-shrink-0">
                          {run.result.successCount}/{run.result.successCount + run.result.failCount}
                        </span>
                      )}
                      {run.status === 'running' && (
                        <span className="text-[10px] text-[#7C5CFF] flex-shrink-0">running...</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Spacer for bottom bar */}
        <div className="h-20" />
      </div>

      {/* ── Bottom Action Bar ── */}
      <div className="px-4 py-3 border-t border-white/5 bg-[#0A0A0A]">
        {/* Status row */}
        {genStatus !== 'idle' && (
          <div className="flex items-center gap-3 mb-2">
            {genStatus === 'generating' && (
              <>
                <div className="w-4 h-4 border-2 border-[#7C5CFF] border-t-transparent rounded-full animate-spin" />
                {tileMonitorActive ? (
                  <div className="flex items-center gap-3 text-[10px]">
                    {tileCounts.generating > 0 && (
                      <span className="text-[#7C5CFF]">
                        {tileCounts.generating} generating
                      </span>
                    )}
                    {tileCounts.done > 0 && (
                      <span className="text-emerald-400">{tileCounts.done} done</span>
                    )}
                    {tileCounts.failed > 0 && (
                      <span className="text-red-400">{tileCounts.failed} failed</span>
                    )}
                    {tileCounts.total === 0 && (flowStep ? (
                      <span className="text-white/60">{flowStep}</span>
                    ) : (
                      <span className="text-white/40">Starting...</span>
                    ))}
                  </div>
                ) : flowStep ? (
                  <span className="text-[10px] text-white/60">{flowStep}</span>
                ) : (
                  <span className="text-[10px] text-white/40">
                    Generating... <span className="text-white/60">{genCount}/{quantity}</span>
                  </span>
                )}
              </>
            )}
            {genStatus === 'done' && (
              <>
                <Download className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-[10px] text-white/40">{generatedCount} image{generatedCount !== 1 ? 's' : ''}</span>
                <button
                  onClick={() => setGenStatus('idle')}
                  className="ml-auto text-[10px] text-white/30 hover:text-white/60 transition-colors flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" /> Reset
                </button>
              </>
            )}
          </div>
        )}

        {/* Generate Button */}
        <button
          onClick={handleGenerate}
          disabled={!prompt.trim() || isGenerating}
          className={cn(
            'w-full py-3 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2',
            !prompt.trim() || isGenerating
              ? 'bg-white/5 text-white/20 cursor-not-allowed'
              : 'bg-gradient-to-r from-[#7C5CFF] to-[#A78BFA] hover:opacity-90 text-white shadow-lg shadow-[#7C5CFF]/20'
          )}
        >
          {isGenerating ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              {multiPrompt && promptQueue.length > 1
                ? `Running ${promptQueue.filter(r => r.status !== 'pending').length}/${promptQueue.length}...`
                : 'Generating...'}
            </>
          ) : (
            <>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M11.8525 4.21651L11.7221 3.2387C11.6906 3.00226 11.4889 2.82568 11.2504 2.82568C11.0118 2.82568 10.8102 3.00226 10.7786 3.23869L10.6483 4.21651C10.2658 7.0847 8.00939 9.34115 5.14119 9.72358L4.16338 9.85396C3.92694 9.88549 3.75037 10.0872 3.75037 10.3257C3.75037 10.5642 3.92694 10.7659 4.16338 10.7974L5.14119 10.9278C8.00938 11.3102 10.2658 13.5667 10.6483 16.4349L10.7786 17.4127C10.8102 17.6491 11.0118 17.8257 11.2504 17.8257C11.4889 17.8257 11.6906 17.6491 11.7221 17.4127L11.8525 16.4349C12.2349 13.5667 14.4913 11.3102 17.3595 10.9278L18.3374 10.7974C18.5738 10.7659 18.7504 10.5642 18.7504 10.3257C18.7504 10.0872 18.5738 9.88549 18.3374 9.85396L17.3595 9.72358C14.4913 9.34115 12.2349 7.0847 11.8525 4.21651Z" />
                <path d="M4.6519 14.7568L4.82063 14.2084C4.84491 14.1295 4.91781 14.0757 5.00037 14.0757C5.08292 14.0757 5.15582 14.1295 5.1801 14.2084L5.34883 14.7568C5.56525 15.4602 6.11587 16.0108 6.81925 16.2272L7.36762 16.3959C7.44652 16.4202 7.50037 16.4931 7.50037 16.5757C7.50037 16.6582 7.44652 16.7311 7.36762 16.7554L6.81926 16.9241C6.11587 17.1406 5.56525 17.6912 5.34883 18.3946L5.1801 18.9429C5.15582 19.0218 5.08292 19.0757 5.00037 19.0757C4.91781 19.0757 4.84491 19.0218 4.82063 18.9429L4.65191 18.3946C4.43548 17.6912 3.88486 17.1406 3.18147 16.9241L2.63311 16.7554C2.55421 16.7311 2.50037 16.6582 2.50037 16.5757C2.50037 16.4931 2.55421 16.4202 2.63311 16.3959L3.18148 16.2272C3.88486 16.0108 4.43548 15.4602 4.6519 14.7568Z" />
              </svg>
              Generate
            </>
          )}
        </button>
      </div>

      <AnimatePresence>
        {promptAssistantOpen && (
          <PromptAssistantModal
            initialIdea={prompt}
            initialMediaType={mode}
            initialAspectRatio={aspectRatio}
            referenceAliases={
              refMode === 'none'
                ? []
                : refImages.map((ref, index) => getRefImageAlias(ref, index))
            }
            onClose={() => setPromptAssistantOpen(false)}
            onApply={(result) => {
              setPrompt(result.text)
              handleModeChange(result.mediaType)
              setAspectRatio(result.aspectRatio)
              setPromptAssistantOpen(false)
            }}
          />
        )}
      </AnimatePresence>

      {showSearch && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-[2px]"
          onMouseDown={closePromptSearch}
        >
          <div
            className="w-full max-w-[680px] overflow-hidden rounded-xl border border-white/10 bg-[#1A1A1A] shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/[0.06] px-3">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPromptSearchTab('my')}
                  className={cn(
                    'h-10 px-3 text-xs font-semibold transition-colors',
                    promptSearchTab === 'my'
                      ? 'border-b-2 border-white text-white/85'
                      : 'border-b-2 border-transparent text-white/35 hover:text-white/65'
                  )}
                >
                  My Prompts
                </button>
                <button
                  type="button"
                  onClick={() => setPromptSearchTab('template')}
                  className={cn(
                    'h-10 px-3 text-xs font-semibold transition-colors',
                    promptSearchTab === 'template'
                      ? 'border-b-2 border-white text-white/85'
                      : 'border-b-2 border-transparent text-white/35 hover:text-white/65'
                  )}
                >
                  Template
                </button>
              </div>
              <button
                type="button"
                onClick={closePromptSearch}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white"
                title="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/25" />
                <input
                  autoFocus
                  value={promptSearchQuery}
                  onChange={(event) => setPromptSearchQuery(event.target.value)}
                  placeholder="Search my prompts..."
                  className="h-9 w-full rounded-lg border border-white/[0.08] bg-[#141414] pl-9 pr-3 text-xs text-white/70 outline-none placeholder:text-white/25 focus:border-[#7C5CFF]/60"
                />
              </div>

              <div className="mt-3 max-h-[360px] min-h-[150px] overflow-y-auto rounded-lg border border-white/[0.06] bg-[#161616]">
                {promptSearchTab === 'template' ? (
                  <div className="flex min-h-[150px] flex-col items-center justify-center text-white/30">
                    <FileText className="mb-2 h-7 w-7" />
                    <p className="text-xs">No templates yet.</p>
                  </div>
                ) : filteredSavedPrompts.length === 0 ? (
                  <div className="flex min-h-[150px] flex-col items-center justify-center text-white/30">
                    <FileText className="mb-2 h-7 w-7" />
                    <p className="text-xs">
                      {savedPrompts.length === 0
                        ? 'No prompts yet. Click "Save current prompt" to get started.'
                        : 'No prompts matched your search.'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1 p-2">
                    {filteredSavedPrompts.map((savedPrompt) => (
                      <button
                        key={savedPrompt.id}
                        type="button"
                        onClick={() => applySavedPrompt(savedPrompt.content)}
                        className="w-full rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:border-white/[0.08] hover:bg-white/[0.04]"
                      >
                        <div className="flex items-center gap-2">
                          <p className="min-w-0 flex-1 truncate text-xs font-semibold text-white/75">{savedPrompt.name}</p>
                          <span className="shrink-0 rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/30">
                            {savedPrompt.provider}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-white/35">{savedPrompt.content}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
