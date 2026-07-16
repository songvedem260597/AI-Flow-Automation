import React, { useState, useRef, useCallback, useEffect } from 'react'
import * as Select from '@radix-ui/react-select'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Upload, Bookmark, Minus, Plus, Trash2,
  Image as ImageIcon, Video, ChevronDown, Download, RotateCcw,
  Search, X, FileText, GripVertical, WandSparkles, Check, ChevronUp, LoaderCircle, Copy, ArrowLeft,
  Globe2, AlignLeft, Palette, Sun, Camera, Clock3, Activity, RectangleHorizontal
} from 'lucide-react'
import { cn, usePersistedState } from '@/lib/utils'
import { promptAssistantProviderLabel, runPromptAssistant, type PromptAssistantMediaUpload, type PromptAssistantProvider } from '@/lib/promptAssistant'
import { PROMPT_ASSISTANT_STYLE_THUMBNAIL_URLS } from '@/lib/promptAssistantStyleThumbnails'
import { useSettingsStore } from '@/stores/settingsStore'
import { usePromptStore } from '@/stores/dataStore'
import type { FlowRecoverySnapshot } from '@/types/flow'

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
const FLOW_UTILITY_PANEL_CLASS = 'rounded-xl border border-white/[0.07] bg-[#141414] p-3'
const FLOW_UTILITY_ACTION_CLASS = 'rounded-lg border border-white/[0.08] bg-[#111111] px-2 py-1.5 text-[10px] text-white/45 transition-colors hover:border-[#7C5CFF]/30 hover:bg-[#7C5CFF]/[0.08] hover:text-[#C8BCFF] disabled:cursor-not-allowed disabled:border-white/[0.05] disabled:bg-[#101010] disabled:text-white/20 disabled:opacity-60'

function flowDiagnosticFilename(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `flow-runtime-diagnostics-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`
}

function textToBase64DataUrl(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return `data:application/json;base64,${btoa(binary)}`
}

function flowRecoveryStatusText(snapshot: FlowRecoverySnapshot | null): string {
  if (!snapshot) return 'Flow recovery status unavailable'
  if (snapshot.persistenceError) return 'Flow recovery persistence unavailable — admission blocked'
  if (snapshot.lastProbeResult?.overall === 'busy') return 'Flow busy — queued or generating'
  if (snapshot.errorCode === 'submit_uncertain') return 'Flow job status uncertain'
  if (snapshot.state === 'healthy') return 'Flow healthy'
  if (snapshot.state === 'session_suspect') return 'Flow session needs recovery'
  if (snapshot.state === 'recovering') return 'Refreshing Flow session'
  if (snapshot.state === 'rate_limited' || snapshot.state === 'cooldown') {
    return snapshot.blockedUntil && snapshot.blockedUntil > Date.now()
      ? `Flow rate limited — retry after ${new Date(snapshot.blockedUntil).toLocaleTimeString()}`
      : 'Flow cooldown awaiting health probe'
  }
  if (snapshot.state === 'blocked') return 'Flow blocked — user action required'
  return 'Flow transient failure — health check required'
}

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
  multiPrompt: boolean
}

interface PromptAssistantReferenceImage {
  id: string
  file: File
  previewUrl: string
}

function promptAssistantFileToUpload(file: File): Promise<PromptAssistantMediaUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result || '')
      const commaIndex = value.indexOf(',')
      resolve({
        base64: commaIndex >= 0 ? value.slice(commaIndex + 1) : value,
        name: file.name || `reference-${Date.now()}.png`,
        type: file.type || 'image/png',
      })
    }
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'reference image'}.`))
    reader.readAsDataURL(file)
  })
}

function remapPromptAssistantReferenceTokensAfterRemoval(text: string, removedNumber: number): string {
  return text
    .replace(/@image(\d+)\b/gi, (token, rawNumber: string) => {
      const number = Number(rawNumber)
      if (number === removedNumber) return ''
      if (number > removedNumber) return `@image${number - 1}`
      return token.toLowerCase()
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

function invalidPromptAssistantReferenceToken(text: string, availableCount: number): string | null {
  for (const match of text.matchAll(/@image(\d+)\b/gi)) {
    const number = Number(match[1])
    if (!Number.isInteger(number) || number < 1 || number > availableCount) return match[0].toLowerCase()
  }
  return null
}

function parsePromptAssistantResult(text: string, expectedCount: number): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  if (expectedCount <= 1) {
    return [normalized.replace(/^\s*\d+[.)]\s+/, '').trim()]
  }

  const numberedBlocks = normalized
    .split(/\n+(?=\s*\d+[.)]\s+)/)
    .map((block) => block.trim())
    .filter(Boolean)
  const blocks = numberedBlocks.length > 1
    ? numberedBlocks
    : normalized.split(/\n\s*\n+/).map((block) => block.trim()).filter(Boolean)

  return blocks.map((block) => block.replace(/^\s*\d+[.)]\s+/, '').trim()).filter(Boolean)
}

const PROMPT_ASSISTANT_STYLE_CATEGORIES = ['Animation', 'Storytelling', 'Lifestyle', 'Education', 'Relax', 'Fitness'] as const

type PromptAssistantStyleCategory = typeof PROMPT_ASSISTANT_STYLE_CATEGORIES[number]

interface PromptAssistantStyleAddon {
  id: string
  name: string
  category: PromptAssistantStyleCategory
  thumbnail: string
  premium?: boolean
}

function createPromptAssistantStyleThumbnail(name: string, from: string, to: string, accent: string): string {
  const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 160">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
    <rect width="120" height="160" rx="14" fill="url(#g)"/>
    <circle cx="92" cy="30" r="18" fill="${accent}" opacity=".65"/>
    <path d="M0 118 29 88l22 22 23-35 46 51v34H0Z" fill="${accent}" opacity=".28"/>
    <circle cx="59" cy="69" r="24" fill="#fff" opacity=".16"/>
    <text x="60" y="78" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#fff">${initials}</text>
  </svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const PROMPT_ASSISTANT_STYLE_ADDONS: PromptAssistantStyleAddon[] = [
  { id: 'doodle-dreams', name: 'Doodle Dreams', category: 'Animation', premium: true, thumbnail: createPromptAssistantStyleThumbnail('Doodle Dreams', '#0F1830', '#273B7A', '#F9D648') },
  { id: '3d-family', name: '3D Family', category: 'Animation', premium: true, thumbnail: createPromptAssistantStyleThumbnail('3D Family', '#6F5143', '#D3A47D', '#F3D0A9') },
  { id: 'kids-nursery', name: 'Kids Nursery', category: 'Animation', thumbnail: createPromptAssistantStyleThumbnail('Kids Nursery', '#F1B98E', '#FFD96A', '#72D6C9') },
  { id: 'anime-manga', name: 'Anime / Manga', category: 'Animation', thumbnail: createPromptAssistantStyleThumbnail('Anime Manga', '#101B49', '#DB315F', '#4E8BFF') },
  { id: 'ghibli-watercolor', name: 'Ghibli Watercolor', category: 'Animation', thumbnail: createPromptAssistantStyleThumbnail('Ghibli Watercolor', '#74A985', '#CFE1B9', '#F0D99B') },
  { id: 'clay-story', name: 'Clay Story', category: 'Animation', thumbnail: createPromptAssistantStyleThumbnail('Clay Story', '#B05B4E', '#E6A56F', '#F7D0AE') },
  { id: 'paper-cut', name: 'Paper Cut', category: 'Animation', thumbnail: createPromptAssistantStyleThumbnail('Paper Cut', '#5D397D', '#D06790', '#F4B7D2') },

  { id: 'cinematic-story', name: 'Cinematic Story', category: 'Storytelling', premium: true, thumbnail: createPromptAssistantStyleThumbnail('Cinematic Story', '#111827', '#4B5563', '#F59E0B') },
  { id: 'documentary', name: 'Documentary', category: 'Storytelling', thumbnail: createPromptAssistantStyleThumbnail('Documentary', '#2E3A3B', '#71827C', '#D7C9A5') },
  { id: 'storybook', name: 'Storybook', category: 'Storytelling', thumbnail: createPromptAssistantStyleThumbnail('Storybook', '#644B7A', '#D08AA5', '#F6D28B') },
  { id: 'fantasy-quest', name: 'Fantasy Quest', category: 'Storytelling', thumbnail: createPromptAssistantStyleThumbnail('Fantasy Quest', '#163B4D', '#5067A1', '#D0B866') },

  { id: 'editorial-fashion', name: 'Editorial Fashion', category: 'Lifestyle', premium: true, thumbnail: createPromptAssistantStyleThumbnail('Editorial Fashion', '#532D3A', '#B36B78', '#F5D6D0') },
  { id: 'product-studio', name: 'Product Studio', category: 'Lifestyle', thumbnail: createPromptAssistantStyleThumbnail('Product Studio', '#24304B', '#5977A9', '#E9E6DD') },
  { id: 'cozy-home', name: 'Cozy Home', category: 'Lifestyle', thumbnail: createPromptAssistantStyleThumbnail('Cozy Home', '#815F42', '#D3A778', '#F6E1B7') },
  { id: 'travel-diary', name: 'Travel Diary', category: 'Lifestyle', thumbnail: createPromptAssistantStyleThumbnail('Travel Diary', '#17707C', '#7FC4BA', '#FFE39C') },

  { id: 'learning-lab', name: 'Learning Lab', category: 'Education', thumbnail: createPromptAssistantStyleThumbnail('Learning Lab', '#1E4C68', '#4DA4B8', '#F5CE62') },
  { id: 'science-explainer', name: 'Science Explainer', category: 'Education', premium: true, thumbnail: createPromptAssistantStyleThumbnail('Science Explainer', '#3B3478', '#6E71D9', '#68E0C1') },
  { id: 'history-story', name: 'History Story', category: 'Education', thumbnail: createPromptAssistantStyleThumbnail('History Story', '#684B32', '#B08A5D', '#E9D1A1') },
  { id: 'infographic', name: 'Infographic', category: 'Education', thumbnail: createPromptAssistantStyleThumbnail('Infographic', '#174A5A', '#2D8FA3', '#F09A63') },

  { id: 'dreamy-pastel', name: 'Dreamy Pastel', category: 'Relax', thumbnail: createPromptAssistantStyleThumbnail('Dreamy Pastel', '#9677B5', '#E2B7CF', '#F8E1B8') },
  { id: 'nature-calm', name: 'Nature Calm', category: 'Relax', thumbnail: createPromptAssistantStyleThumbnail('Nature Calm', '#376B58', '#86B892', '#D6E6B5') },
  { id: 'lofi-night', name: 'Lo-fi Night', category: 'Relax', premium: true, thumbnail: createPromptAssistantStyleThumbnail('Lo-fi Night', '#22264B', '#70538F', '#E4A7C5') },
  { id: 'soft-watercolor', name: 'Soft Watercolor', category: 'Relax', thumbnail: createPromptAssistantStyleThumbnail('Soft Watercolor', '#7AA6B3', '#C9DDB8', '#F0C7AE') },

  { id: 'sports-energy', name: 'Sports Energy', category: 'Fitness', premium: true, thumbnail: createPromptAssistantStyleThumbnail('Sports Energy', '#4C1824', '#D63D42', '#FFB347') },
  { id: 'yoga-flow', name: 'Yoga Flow', category: 'Fitness', thumbnail: createPromptAssistantStyleThumbnail('Yoga Flow', '#385B5B', '#84AFA3', '#E8D9B9') },
  { id: 'running-campaign', name: 'Running Campaign', category: 'Fitness', thumbnail: createPromptAssistantStyleThumbnail('Running Campaign', '#173D65', '#2E7AB8', '#F3C65A') },
  { id: 'gym-editorial', name: 'Gym Editorial', category: 'Fitness', thumbnail: createPromptAssistantStyleThumbnail('Gym Editorial', '#292929', '#686868', '#D8FF62') },
]

const PROMPT_ASSISTANT_STYLE_THUMBNAILS_KEY = 'promptAssistantStyleThumbnailsV1'
const PROMPT_ASSISTANT_STYLE_PROMPTS_KEY = 'promptAssistantStylePromptsV2'
const PROMPT_ASSISTANT_STYLE_PROMPTS_LEGACY_KEY = 'promptAssistantStylePromptsV1'

const PROMPT_ASSISTANT_STYLE_CONTENT: Record<string, string> = {
  'doodle-dreams': 'Restyle the image as a whimsical hand-drawn doodle illustration. Use playful black ink linework, imperfect sketch contours, simple lavender accents, paper texture, tiny imaginative symbols, and a charming storybook mood. Keep the subject immediately recognizable and the composition uncluttered.',
  '3d-family': 'Restyle the image as a premium family-friendly 3D animated film frame. Use rounded facial forms, expressive eyes, soft realistic materials, warm skin shading, carefully groomed hair, gentle depth of field, and inviting cinematic lighting. Preserve the subject’s identity, pose, and emotional expression.',
  'kids-nursery': 'Restyle the image as a soft children’s nursery illustration with plush toy materials, rounded shapes, pastel blue and warm cream colors, friendly proportions, gentle diffuse light, and a safe comforting mood. Keep details simple, readable, and suitable for young children.',
  'anime-manga': 'Restyle the image as a polished modern anime and manga key visual. Use elegant linework, expressive eyes, refined facial anatomy, layered hair strands, cinematic cel shading, controlled highlights, atmospheric depth, and a dynamic but balanced composition. Preserve identity, clothing, pose, and scene logic.',
  'ghibli-watercolor': 'Restyle the image as a hand-painted Japanese animation background with delicate watercolor washes, softly textured brushwork, lush natural detail, warm sunlight, atmospheric perspective, and a quiet poetic mood. Keep the subject grounded in the environment with believable scale and lighting.',
  'clay-story': 'Restyle the image as handcrafted stop-motion clay animation. Use visible sculpted clay texture, rounded handmade forms, subtle fingerprints, miniature set construction, warm practical lighting, shallow depth of field, and expressive character posing. Preserve the original subject and narrative action.',
  'paper-cut': 'Restyle the image as layered paper-cut artwork. Build the scene from clean stacked paper shapes, tactile fibers, precise cut edges, soft cast shadows between layers, restrained colors, and clear foreground-to-background separation. Preserve the subject silhouette and essential composition.',
  'cinematic-story': 'Restyle the image as a premium cinematic story frame. Use purposeful visual hierarchy, realistic production design, motivated lighting, controlled contrast, atmospheric depth, nuanced color grading, and a clear emotional focal point. Preserve identity and continuity while strengthening the scene’s narrative meaning.',
  documentary: 'Restyle the image as authentic observational documentary photography. Use natural available light, believable environmental context, candid framing, realistic skin and material texture, restrained color grading, and subtle lens imperfections. Avoid glamour retouching or artificial posing; preserve factual visual details.',
  storybook: 'Restyle the image as an illustrated storybook page with painterly shapes, expressive characters, warm narrative lighting, handcrafted texture, gentle color harmony, and clear visual storytelling. Preserve the subject and action while simplifying distracting background details.',
  'fantasy-quest': 'Restyle the image as epic fantasy quest concept art. Use monumental environmental scale, rich world-building, dramatic atmospheric perspective, heroic lighting, weathered materials, cinematic depth, and a strong adventure focal point. Preserve the subject’s identity and pose while adapting wardrobe and surroundings only when requested.',
  'editorial-fashion': 'Restyle the image as a high-end editorial fashion photograph. Use refined wardrobe texture, confident posing, sophisticated set design, sculpted studio lighting, realistic skin, subtle luxury color grading, and magazine-quality composition. Preserve facial identity, garment construction, body proportions, and natural anatomy.',
  'product-studio': 'Restyle the image as premium studio product photography. Use a clean controlled backdrop, precise edge definition, realistic material response, softbox reflections, balanced contrast, commercial retouching, and intentional negative space. Preserve product geometry, colors, labels, and functional details exactly.',
  'cozy-home': 'Restyle the image as warm aspirational home-lifestyle photography. Use natural wood and fabric textures, soft practical lamps, gentle window light, warm neutral colors, lived-in details, and an intimate comfortable composition. Preserve the subject and make the environment believable rather than staged.',
  'travel-diary': 'Restyle the image as an authentic travel-diary photograph. Use vivid local atmosphere, natural daylight, environmental depth, candid composition, realistic weather and textures, restrained film color, and a strong sense of place. Preserve landmarks, cultural details, and the subject’s identity accurately.',
  'learning-lab': 'Restyle the image as a friendly educational learning-lab visual. Use an immediately readable subject, organized supporting objects, bright but controlled colors, accurate real-world details, clean spatial hierarchy, and approachable lighting. Keep the composition informative without adding unnecessary text.',
  'science-explainer': 'Restyle the image as a polished scientific explainer visual. Use accurate structures, clear scale relationships, luminous analytical accents, clean background separation, controlled depth, and a strong central concept. Preserve scientific correctness and avoid decorative elements that could imply false information.',
  'history-story': 'Restyle the image as an immersive historical narrative scene. Use period-appropriate architecture, clothing, tools, materials, weathering, naturalistic light, and cinematic atmosphere. Preserve the original action while ensuring details are coherent with the intended time and place.',
  infographic: 'Restyle the image as a clean three-dimensional infographic visual. Use simplified geometric forms, clear grouping, strong hierarchy, accessible color contrast, precise spacing, and an uncluttered neutral background. Communicate the core idea visually without inventing statistics or adding unreadable text.',
  'dreamy-pastel': 'Restyle the image with a dreamy pastel aesthetic. Use soft lavender, blush, peach, and sky-blue transitions, diffused glowing light, gentle atmospheric haze, delicate textures, and a serene romantic composition. Preserve facial identity, anatomy, and the main subject’s clarity.',
  'nature-calm': 'Restyle the image as tranquil nature-focused artwork. Use organic green and earth tones, soft natural light, subtle mist, realistic foliage and water texture, spacious composition, and quiet atmospheric depth. Preserve the subject while integrating it naturally into the environment.',
  'lofi-night': 'Restyle the image as a cozy lo-fi night illustration. Use deep indigo and muted violet colors, warm desk or window light, gentle rain or city ambience when appropriate, soft grain, intimate framing, and a calm reflective mood. Preserve the subject’s activity and recognizable features.',
  'soft-watercolor': 'Restyle the image as delicate traditional watercolor artwork. Use translucent pigment washes, softly bleeding edges, visible paper grain, restrained linework, subtle color blooms, and generous breathing space. Preserve the subject silhouette and essential details without over-rendering.',
  'sports-energy': 'Restyle the image as a high-impact professional sports campaign visual. Use dynamic action framing, realistic motion cues, crisp directional stadium light, controlled sweat and fabric detail, powerful contrast, and energetic color grading. Preserve athlete identity, anatomy, equipment, and sport-specific technique.',
  'yoga-flow': 'Restyle the image as premium wellness and yoga photography. Use calm natural light, balanced composition, realistic anatomy, breathable neutral colors, soft material texture, and a focused peaceful mood. Preserve the exact pose and ensure joints, hands, and body alignment remain physically credible.',
  'running-campaign': 'Restyle the image as an aspirational running campaign photograph. Use authentic stride mechanics, dynamic environmental perspective, sunrise or golden-hour light, realistic performance clothing, subtle motion, and motivational cinematic grading. Preserve athlete identity, body proportions, footwear, and natural movement.',
  'gym-editorial': 'Restyle the image as a sophisticated gym editorial photograph. Use sculpted but realistic directional light, dark premium training space, accurate anatomy, detailed performance fabrics, restrained contrast, and confident composition. Preserve identity and exercise form without exaggerating muscles or body proportions.',
}

function getDefaultStyleEditPrompt(addon: PromptAssistantStyleAddon): string {
  return PROMPT_ASSISTANT_STYLE_CONTENT[addon.id]
    || `Apply the complete visual identity of “${addon.name}” while preserving the original subject, anatomy, composition, and scene logic. Keep the result production-ready and free of logos, watermarks, borders, badges, and UI elements.`
}

function contextualizeStylePrompt(prompt: string, hasReferenceImages: boolean): string {
  const normalized = prompt.trim()
  if (hasReferenceImages) return normalized

  return normalized
    .replace(/^Restyle the image as (?:an?|the)\s+/i, 'Create an original ')
    .replace(/^Transform the image into (?:an?|the)\s+/i, 'Create an original ')
    .replace(/^Reframe the image as (?:an?|the)\s+/i, 'Create an original ')
    .replace(/^Turn the image into (?:an?|the)\s+/i, 'Create an original ')
    .replace(/(^|\s)Preserve [^.]*\.\s*/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const PromptAssistantStyleThumbnailImage: React.FC<{
  addon: PromptAssistantStyleAddon
  customThumbnail?: string
  className?: string
}> = ({ addon, customThumbnail, className }) => {
  return (
    <img
      src={customThumbnail || PROMPT_ASSISTANT_STYLE_THUMBNAIL_URLS[addon.id] || addon.thumbnail}
      alt={addon.name}
      className={cn('block object-cover', className)}
      loading="lazy"
    />
  )
}

function compressPromptAssistantStyleThumbnail(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Please select an image file.'))
      return
    }
    if (file.size > 12 * 1024 * 1024) {
      reject(new Error('Thumbnail image must be smaller than 12 MB.'))
      return
    }

    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      try {
        const targetWidth = 152
        const targetHeight = 208
        const canvas = document.createElement('canvas')
        canvas.width = targetWidth
        canvas.height = targetHeight
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Image canvas is unavailable.')

        const scale = Math.max(targetWidth / image.naturalWidth, targetHeight / image.naturalHeight)
        const sourceWidth = targetWidth / scale
        const sourceHeight = targetHeight / scale
        const sourceX = Math.max(0, (image.naturalWidth - sourceWidth) / 2)
        const sourceY = Math.max(0, (image.naturalHeight - sourceHeight) / 2)
        context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight)

        const webp = canvas.toDataURL('image/webp', 0.8)
        resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.8))
      } catch (error) {
        reject(error)
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Could not read this image.'))
    }
    image.src = objectUrl
  })
}

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
  totalSeconds: number
  secondsPerImage: number
  sequential: boolean
  keepConsistent: boolean
  numbered: boolean
  autoWriteScript: boolean
  burnSubtitles: boolean
  negativePrompt: string
  referenceImageCount: number
}): string {
  const count = Math.max(1, Math.min(10, args.count))
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

function buildPromptAssistantInstruction(args: {
  idea: string
  mediaType: GenMode
  aspectRatio: AspectRatio
  count: number
  language: PromptAssistantLanguage
  detail: PromptAssistantDetail
  style: string
  lighting: string
  camera: string
  tone: string
}): string {
  const structuredBrief = buildPromptAssistantText(args)
  const language = args.language === 'Vietnamese' ? 'Vietnamese' : 'English'
  const plural = args.count === 1 ? 'prompt' : 'prompts'

  return [
    'You are a professional prompt engineer for AI image and video generation.',
    `Rewrite the source brief into exactly ${args.count} production-ready ${args.mediaType} ${plural}.`,
    `Write in ${language}. Use the requested detail level: ${args.detail}.`,
    `The intended aspect ratio is ${args.aspectRatio}.`,
    `Timing target: ${args.totalSeconds} seconds total, approximately ${args.secondsPerImage} seconds per image or shot.`,
    args.referenceImageCount > 0 ? `Use the ${args.referenceImageCount} attached reference image(s) in their displayed order.` : '',
    args.referenceImageCount > 0
      ? `Reference mapping is strict: ${Array.from({ length: args.referenceImageCount }, (_, index) => `@image${index + 1} = attached image ${index + 1}`).join(', ')}. Never swap or renumber these references.`
      : '',
    args.sequential ? 'Arrange the output as a sequential storyboard with clear progression.' : '',
    args.keepConsistent ? 'Keep characters, wardrobe, locations, lighting logic, and visual identity consistent across prompts.' : '',
    args.numbered ? 'Number each prompt in sequence.' : 'Do not number the prompts.',
    args.autoWriteScript ? 'Include concise narration or subtitle copy suitable for each shot.' : '',
    args.burnSubtitles ? 'Describe subtitles as visibly burned into the generated image or video frame.' : '',
    args.negativePrompt.trim() ? `Avoid these elements: ${args.negativePrompt.trim()}.` : '',
    'Preserve every reference token such as @image1 or @image2 exactly as written.',
    'Return only the finished prompt text. Do not add explanations, headings, markdown fences, or quotation marks.',
    args.count > 1 ? 'Separate prompts with one blank line.' : '',
    '',
    'Source brief:',
    structuredBrief,
  ].filter((line) => line !== '').join('\n')
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
  const [assistantProvider, setAssistantProvider] = useState<PromptAssistantProvider>('chatgpt')
  const promptAssistantMode = useSettingsStore((state) => state.promptAssistantMode || 'tab')
  const apiProviderConfig = useSettingsStore((state) => state.apiProvider)
  const apiProviderReady = Boolean(
    apiProviderConfig?.endpoint?.trim()
    && apiProviderConfig.model?.trim()
  )
  const [mediaType, setMediaType] = useState<GenMode>(initialMediaType)
  const [count, setCount] = useState(1)
  const [language, setLanguage] = useState<PromptAssistantLanguage>('English')
  const [detail, setDetail] = useState<PromptAssistantDetail>('Concise')
  const [style, setStyle] = useState('Auto')
  const [styleCategory, setStyleCategory] = useState<PromptAssistantStyleCategory>('Animation')
  const [lighting, setLighting] = useState('Auto')
  const [camera, setCamera] = useState('Auto')
  const [tone, setTone] = useState('auto')
  const [totalSeconds, setTotalSeconds] = useState('60')
  const [secondsPerImage, setSecondsPerImage] = useState('5')
  const [sequential, setSequential] = useState(true)
  const [keepConsistent, setKeepConsistent] = useState(true)
  const [numbered, setNumbered] = useState(true)
  const [autoWriteScript, setAutoWriteScript] = useState(false)
  const [burnSubtitles, setBurnSubtitles] = useState(false)
  const [negativePrompt, setNegativePrompt] = useState('')
  const [assistantAspectRatio, setAssistantAspectRatio] = useState<AspectRatio>(initialAspectRatio)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false)
  const [generatedPrompts, setGeneratedPrompts] = useState<string[]>([])
  const [resultCopied, setResultCopied] = useState(false)
  const [assistantImageMention, setAssistantImageMention] = useState<{ start: number; query: string } | null>(null)
  const [assistantImageMentionIndex, setAssistantImageMentionIndex] = useState(0)
  const [assistantError, setAssistantError] = useState('')
  const [styleThumbnailOverrides, setStyleThumbnailOverrides] = useState<Record<string, string>>({})
  const [styleThumbnailManagerOpen, setStyleThumbnailManagerOpen] = useState(false)
  const [styleThumbnailEditorOpen, setStyleThumbnailEditorOpen] = useState(false)
  const [styleThumbnailEditorId, setStyleThumbnailEditorId] = useState(PROMPT_ASSISTANT_STYLE_ADDONS[0].id)
  const [styleThumbnailEditPrompt, setStyleThumbnailEditPrompt] = useState('')
  const [stylePromptOverrides, setStylePromptOverrides] = useState<Record<string, string>>({})
  const [assistantReferenceImages, setAssistantReferenceImages] = useState<PromptAssistantReferenceImage[]>([])
  const [referenceDropActive, setReferenceDropActive] = useState(false)
  const styleThumbnailInputRef = useRef<HTMLInputElement>(null)
  const styleThumbnailTargetRef = useRef<string | null>(null)
  const styleThumbnailManagerRef = useRef<HTMLDivElement>(null)
  const assistantReferenceInputRef = useRef<HTMLInputElement>(null)
  const assistantIdeaTextareaRef = useRef<HTMLTextAreaElement>(null)
  const assistantReferenceImagesRef = useRef<PromptAssistantReferenceImage[]>([])
  const visibleStyleAddons = PROMPT_ASSISTANT_STYLE_ADDONS.filter((addon) => addon.category === styleCategory)
  const promptAssistantReferenceAliases = assistantReferenceImages.length > 0
    ? assistantReferenceImages.map((_, index) => `image${index + 1}`)
    : referenceAliases
  const assistantImageMentionOptions = assistantReferenceImages.map((image, index) => ({
    image,
    alias: `image${index + 1}`,
  }))
  const filteredAssistantImageMentionOptions = assistantImageMention
    ? assistantImageMentionOptions.filter((option) => {
        const query = assistantImageMention.query.toLowerCase()
        return option.alias.includes(query) || option.image.file.name.toLowerCase().includes(query)
      })
    : []

  useEffect(() => {
    if (!chrome?.storage?.local) return
    chrome.storage.local.get([PROMPT_ASSISTANT_STYLE_THUMBNAILS_KEY, PROMPT_ASSISTANT_STYLE_PROMPTS_KEY, PROMPT_ASSISTANT_STYLE_PROMPTS_LEGACY_KEY]).then((stored) => {
      const value = stored?.[PROMPT_ASSISTANT_STYLE_THUMBNAILS_KEY]
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        setStyleThumbnailOverrides(value as Record<string, string>)
      }
      const promptValue = stored?.[PROMPT_ASSISTANT_STYLE_PROMPTS_KEY]
      if (promptValue && typeof promptValue === 'object' && !Array.isArray(promptValue)) {
        setStylePromptOverrides(promptValue as Record<string, string>)
      } else {
        const legacyValue = stored?.[PROMPT_ASSISTANT_STYLE_PROMPTS_LEGACY_KEY]
        if (legacyValue && typeof legacyValue === 'object' && !Array.isArray(legacyValue)) {
          const oldGeneratedPrefixes = [
            'Transform the image into a polished animated illustration',
            'Reframe the image as a cinematic storytelling scene',
            'Restyle the image as premium lifestyle editorial photography',
            'Turn the image into a clear educational visual',
            'Create a calm atmospheric interpretation',
            'Create a high-energy fitness visual',
          ]
          const preservedCustomPrompts = Object.fromEntries(
            Object.entries(legacyValue as Record<string, unknown>)
              .filter(([, prompt]) => typeof prompt === 'string' && !oldGeneratedPrefixes.some((prefix) => prompt.startsWith(prefix)))
          ) as Record<string, string>
          setStylePromptOverrides(preservedCustomPrompts)
          if (Object.keys(preservedCustomPrompts).length > 0) {
            void chrome.storage.local.set({ [PROMPT_ASSISTANT_STYLE_PROMPTS_KEY]: preservedCustomPrompts })
          }
        }
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    assistantReferenceImagesRef.current = assistantReferenceImages
  }, [assistantReferenceImages])

  useEffect(() => {
    setAssistantProvider((current) => {
      if (promptAssistantMode === 'api') return 'api'
      return current === 'api' ? 'chatgpt' : current
    })
    setAssistantError('')
  }, [promptAssistantMode])

  useEffect(() => {
    if (!styleThumbnailManagerOpen) return
    const closeManager = (event: PointerEvent) => {
      if (!styleThumbnailManagerRef.current?.contains(event.target as Node)) {
        setStyleThumbnailManagerOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeManager, true)
    return () => document.removeEventListener('pointerdown', closeManager, true)
  }, [styleThumbnailManagerOpen])

  useEffect(() => () => {
    assistantReferenceImagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl))
  }, [])

  const persistStyleThumbnailOverrides = async (next: Record<string, string>) => {
    setStyleThumbnailOverrides(next)
    if (!chrome?.storage?.local) return
    await chrome.storage.local.set({ [PROMPT_ASSISTANT_STYLE_THUMBNAILS_KEY]: next })
  }

  const openStyleThumbnailUpload = (styleId: string) => {
    styleThumbnailTargetRef.current = styleId
    if (styleThumbnailInputRef.current) {
      styleThumbnailInputRef.current.value = ''
      styleThumbnailInputRef.current.click()
    }
  }

  const handleStyleThumbnailUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const styleId = styleThumbnailTargetRef.current
    if (!file || !styleId) return
    try {
      const thumbnail = await compressPromptAssistantStyleThumbnail(file)
      await persistStyleThumbnailOverrides({ ...styleThumbnailOverrides, [styleId]: thumbnail })
      setAssistantError('')
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : 'Could not save this style thumbnail.')
    } finally {
      styleThumbnailTargetRef.current = null
      event.target.value = ''
    }
  }

  const resetStyleThumbnail = async (styleId: string) => {
    const next = { ...styleThumbnailOverrides }
    delete next[styleId]
    try {
      await persistStyleThumbnailOverrides(next)
      setAssistantError('')
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : 'Could not reset this style thumbnail.')
    }
  }

  const openStyleThumbnailEditor = () => {
    const firstStyle = visibleStyleAddons[0]
    if (firstStyle) {
      setStyleThumbnailEditorId(firstStyle.id)
      setStyleThumbnailEditPrompt(stylePromptOverrides[firstStyle.id] || getDefaultStyleEditPrompt(firstStyle))
    }
    setStyleThumbnailManagerOpen(false)
    setStyleThumbnailEditorOpen(true)
  }

  const selectStyleThumbnailEditor = (styleId: string) => {
    const addon = PROMPT_ASSISTANT_STYLE_ADDONS.find((item) => item.id === styleId)
    if (!addon) return
    setStyleThumbnailEditorId(styleId)
    setStyleThumbnailEditPrompt(stylePromptOverrides[styleId] || getDefaultStyleEditPrompt(addon))
  }

  const saveStyleEditPrompt = async () => {
    if (!styleThumbnailEditPrompt.trim()) return
    setAssistantError('')
    try {
      const next = { ...stylePromptOverrides, [styleThumbnailEditorId]: styleThumbnailEditPrompt.trim() }
      setStylePromptOverrides(next)
      await chrome.storage.local.set({ [PROMPT_ASSISTANT_STYLE_PROMPTS_KEY]: next })
      setStyleThumbnailEditorOpen(false)
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : 'Could not save this style prompt.')
    }
  }

  const addAssistantReferenceFiles = (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) {
      setAssistantError('Please select image files only.')
      return
    }
    setAssistantReferenceImages((current) => {
      const existing = new Set(current.map((image) => `${image.file.name}:${image.file.size}:${image.file.lastModified}`))
      const next = [...current]
      for (const file of imageFiles) {
        if (next.length >= 5) break
        const signature = `${file.name}:${file.size}:${file.lastModified}`
        if (existing.has(signature)) continue
        existing.add(signature)
        next.push({
          id: `assistant-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          previewUrl: URL.createObjectURL(file),
        })
      }
      return next
    })
    setAssistantError('')
  }

  const removeAssistantReferenceImage = (id: string) => {
    setAssistantReferenceImages((current) => {
      const removedIndex = current.findIndex((image) => image.id === id)
      const removed = current.find((image) => image.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      if (removedIndex >= 0) {
        setIdea((currentIdea) => remapPromptAssistantReferenceTokensAfterRemoval(currentIdea, removedIndex + 1))
      }
      return current.filter((image) => image.id !== id)
    })
  }

  const appendReferenceAlias = (alias: string) => {
    const token = `@${alias}`
    if (new RegExp(`(^|\\s)${token}(?=\\s|$)`, 'i').test(idea)) return
    setIdea((current) => `${current.trim()}${current.trim() ? ' ' : ''}${token}`)
  }

  const updateAssistantImageMention = (value: string, cursor: number) => {
    if (assistantReferenceImages.length === 0) {
      setAssistantImageMention(null)
      return
    }
    const beforeCursor = value.slice(0, cursor)
    const match = beforeCursor.match(/@([a-zA-Z0-9]*)$/)
    if (!match) {
      setAssistantImageMention(null)
      return
    }
    const start = beforeCursor.length - match[0].length
    const preceding = start > 0 ? beforeCursor[start - 1] : ''
    if (preceding && !/[\s([,{]/.test(preceding)) {
      setAssistantImageMention(null)
      return
    }
    setAssistantImageMention({ start, query: match[1] || '' })
    setAssistantImageMentionIndex(0)
  }

  const insertAssistantImageMention = (alias: string) => {
    const textarea = assistantIdeaTextareaRef.current
    const currentCursor = textarea?.selectionStart ?? idea.length
    const replaceStart = assistantImageMention?.start ?? currentCursor
    const before = idea.slice(0, replaceStart)
    const after = idea.slice(currentCursor)
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
    const needsTrailingSpace = after.length === 0 || !/^\s/.test(after)
    const inserted = `${needsLeadingSpace ? ' ' : ''}@${alias}${needsTrailingSpace ? ' ' : ''}`
    const nextIdea = before + inserted + after
    const nextCursor = before.length + inserted.length

    setIdea(nextIdea)
    setAssistantImageMention(null)
    setAssistantImageMentionIndex(0)
    requestAnimationFrame(() => {
      const input = assistantIdeaTextareaRef.current
      if (!input) return
      input.focus()
      input.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const handleAssistantIdeaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (assistantImageMention && filteredAssistantImageMentionOptions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setAssistantImageMentionIndex((current) => (current + 1) % filteredAssistantImageMentionOptions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setAssistantImageMentionIndex((current) => (current - 1 + filteredAssistantImageMentionOptions.length) % filteredAssistantImageMentionOptions.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const selected = filteredAssistantImageMentionOptions[assistantImageMentionIndex] || filteredAssistantImageMentionOptions[0]
        if (selected) insertAssistantImageMention(selected.alias)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setAssistantImageMention(null)
        return
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      void applyAssistant()
    }
  }

  const applyAssistant = async () => {
    if (!idea.trim() || isGeneratingPrompt) return
    const availableReferenceCount = assistantReferenceImages.length > 0
      ? assistantReferenceImages.length
      : referenceAliases.length
    const invalidReferenceToken = invalidPromptAssistantReferenceToken(idea, availableReferenceCount)
    if (invalidReferenceToken) {
      setAssistantError(`${invalidReferenceToken} does not have a matching uploaded reference image.`)
      return
    }
    setIsGeneratingPrompt(true)
    setAssistantError('')
    try {
      const selectedStyleAddon = PROMPT_ASSISTANT_STYLE_ADDONS.find((addon) => addon.name === style)
      const selectedStylePrompt = selectedStyleAddon
        ? stylePromptOverrides[selectedStyleAddon.id] || getDefaultStyleEditPrompt(selectedStyleAddon)
        : ''
      const styleDirection = selectedStyleAddon
        ? `${selectedStyleAddon.name}. ${contextualizeStylePrompt(selectedStylePrompt, assistantReferenceImages.length > 0)}`
        : style
      const instruction = buildPromptAssistantInstruction({
        idea,
        mediaType,
        aspectRatio: assistantAspectRatio,
        count,
        language,
        detail,
        style: styleDirection,
        lighting,
        camera,
        tone,
        totalSeconds: Math.max(1, Number(totalSeconds) || 60),
        secondsPerImage: Math.max(1, Number(secondsPerImage) || 5),
        sequential,
        keepConsistent,
        numbered,
        autoWriteScript,
        burnSubtitles,
        negativePrompt,
        referenceImageCount: assistantReferenceImages.length,
      })
      const mediaUploads = await Promise.all(assistantReferenceImages.map(async (image, index) => {
        const upload = await promptAssistantFileToUpload(image.file)
        return { ...upload, name: `image${index + 1}-${upload.name}` }
      }))
      const text = await runPromptAssistant(assistantProvider, instruction, 90000, mediaUploads)
      const parsedPrompts = parsePromptAssistantResult(text, count)
      if (parsedPrompts.length === 0) throw new Error('The AI provider returned an empty prompt result.')
      setGeneratedPrompts(parsedPrompts)
      setResultCopied(false)
    } catch (error) {
      setAssistantError(error instanceof Error ? error.message : 'Prompt Assistant failed. Please try again.')
    } finally {
      setIsGeneratingPrompt(false)
    }
  }

  const sendGeneratedPromptsToPrompt = () => {
    if (generatedPrompts.length === 0) return
    onApply({
      text: generatedPrompts.join('\n\n'),
      mediaType,
      aspectRatio: assistantAspectRatio,
      multiPrompt: generatedPrompts.length > 1,
    })
  }

  const copyGeneratedPrompts = async () => {
    if (generatedPrompts.length === 0) return
    try {
      await navigator.clipboard.writeText(generatedPrompts.join('\n\n'))
      setResultCopied(true)
      window.setTimeout(() => setResultCopied(false), 1500)
    } catch {
      setAssistantError('Could not copy prompts to the clipboard.')
    }
  }

  const labelClass = 'mb-2 block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35'
  const advancedLabelClass = 'mb-1.5 flex items-center gap-1.5 text-[10px] font-medium text-white/40'
  const advancedInputClass = 'h-10 w-full rounded-xl border border-white/[0.08] bg-[#121212] px-3 text-[12px] font-medium text-white/70 outline-none transition-colors placeholder:text-white/22 hover:border-white/[0.14] focus:border-[#7C5CFF]/70 focus:ring-2 focus:ring-[#7C5CFF]/10'

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
        className="relative flex max-h-[calc(100vh-32px)] w-full max-w-[700px] flex-col overflow-hidden rounded-[18px] border border-white/[0.1] bg-[#181818] shadow-[0_28px_90px_rgba(0,0,0,0.68)]"
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

        {generatedPrompts.length > 0 && (
          <div className="absolute inset-x-0 bottom-0 top-16 z-[75] flex flex-col bg-[#181818]">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[12px] font-semibold text-white/75">Generated {generatedPrompts.length} {generatedPrompts.length === 1 ? 'prompt' : 'prompts'}</p>
                  <p className="mt-0.5 text-[9px] text-white/28">Review the AI response before sending it to the Prompt field.</p>
                </div>
                {generatedPrompts.length > 1 && (
                  <span className="rounded-lg border border-[#7C5CFF]/20 bg-[#7C5CFF]/10 px-2 py-1 text-[9px] font-semibold text-[#C8BCFF]">Multi Prompt</span>
                )}
              </div>

              <div className="space-y-2">
                {generatedPrompts.map((generatedPrompt, index) => (
                  <div key={`${index}-${generatedPrompt.slice(0, 24)}`} className="flex gap-2.5 rounded-xl border border-white/[0.08] bg-[#1E1E1E] px-3 py-2.5">
                    <span className="mt-0.5 shrink-0 text-[11px] font-bold text-[#8EBBFF]">{index + 1}.</span>
                    <p className="whitespace-pre-wrap text-[11px] leading-[1.55] text-white/72">{generatedPrompt}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="shrink-0 border-t border-white/[0.07] bg-[#151515] p-4">
              <button
                type="button"
                onClick={sendGeneratedPromptsToPrompt}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#7C5CFF] text-[12px] font-semibold text-white shadow-[0_9px_28px_rgba(124,92,255,0.28)] transition-colors hover:bg-[#896BFF]"
              >
                <WandSparkles className="h-4 w-4" />
                Send to Prompt
              </button>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => void copyGeneratedPrompts()} className="flex h-9 items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-[#171717] text-[10px] font-medium text-white/45 hover:border-white/[0.14] hover:text-white/70">
                  {resultCopied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                  {resultCopied ? 'Copied' : 'Copy'}
                </button>
                <button type="button" onClick={() => { setGeneratedPrompts([]); setAssistantError('') }} className="flex h-9 items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-[#171717] text-[10px] font-medium text-white/45 hover:border-white/[0.14] hover:text-white/70">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section>
            <div className="mb-2 flex items-end justify-between gap-4">
              <label className="text-[12px] font-semibold text-white/70">What do you want to create?</label>
              <span className="text-[10px] text-white/25">Idea, scene, script, or shot list</span>
            </div>
            <div className="relative rounded-2xl border border-white/[0.08] bg-[#111111] p-1.5 transition-colors focus-within:border-[#7C5CFF]/55 focus-within:ring-2 focus-within:ring-[#7C5CFF]/10">
              <textarea
                ref={assistantIdeaTextareaRef}
                autoFocus
                value={idea}
                onChange={(event) => {
                  const value = event.target.value
                  setIdea(value)
                  updateAssistantImageMention(value, event.target.selectionStart ?? value.length)
                }}
                onKeyDown={handleAssistantIdeaKeyDown}
                placeholder="Describe the result you want. Mention references with @image1, @image2..."
                className="min-h-[138px] w-full resize-y bg-transparent px-3 py-2.5 text-[13px] leading-6 text-white/80 outline-none placeholder:text-white/22"
              />

              {assistantImageMention && filteredAssistantImageMentionOptions.length > 0 && (
                <div className="absolute bottom-10 left-3 z-50 max-h-40 w-64 overflow-y-auto rounded-xl border border-white/10 bg-[#1A1A1A] py-1 shadow-2xl">
                  {filteredAssistantImageMentionOptions.map((option, optionIndex) => (
                    <button
                      key={option.image.id}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertAssistantImageMention(option.alias)}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors',
                        optionIndex === assistantImageMentionIndex
                          ? 'bg-[#7C5CFF]/15 text-[#C8BCFF]'
                          : 'text-white/60 hover:bg-white/5 hover:text-white'
                      )}
                    >
                      <img src={option.image.previewUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] font-semibold">@{option.alias}</span>
                        <span className="mt-0.5 block truncate text-[9px] text-white/30">{option.image.file.name}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <div className="flex min-h-8 items-center gap-2 border-t border-white/[0.05] px-2 pt-1.5">
                <WandSparkles className="h-3.5 w-3.5 text-[#8F76F5]" />
                <span className="text-[10px] text-white/28">Assistant keeps your intent and adds visual direction.</span>
              </div>
            </div>
          </section>

          {promptAssistantReferenceAliases.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-medium text-white/30">References</span>
              {promptAssistantReferenceAliases.map((alias) => (
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

          <section className="mt-4 flex flex-col gap-2.5 rounded-2xl border border-white/[0.07] bg-[#141414] p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[11px] font-semibold text-white/65">Generate with</p>
              <p className="mt-0.5 text-[9px] text-white/25">
                {promptAssistantMode === 'api'
                  ? 'Uses the API configured in Settings and keeps provider tabs closed.'
                  : 'Uses your signed-in ChatGPT or Gemini tab and returns the finished text here.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {((promptAssistantMode === 'api'
                ? ['api']
                : ['chatgpt', 'gemini']) as PromptAssistantProvider[]
              ).map((provider) => {
                const selected = assistantProvider === provider
                const running = selected && isGeneratingPrompt
                const unavailable = provider === 'api' && !apiProviderReady
                return (
                  <button
                    key={provider}
                    type="button"
                    aria-pressed={selected}
                    disabled={isGeneratingPrompt || unavailable}
                    title={unavailable ? 'Configure and enable API Provider in Settings first.' : `Generate with ${promptAssistantProviderLabel(provider)}`}
                    onClick={() => {
                      setAssistantProvider(provider)
                      setAssistantError('')
                    }}
                    className={cn(
                      'flex h-8 items-center gap-2 rounded-lg border px-3 text-[11px] font-medium transition-all disabled:cursor-not-allowed',
                      unavailable
                        ? 'cursor-not-allowed border-white/[0.06] bg-[#101010] text-white/18'
                        : running
                        ? 'border-white/[0.1] bg-emerald-500/12 text-emerald-300'
                        : selected
                          ? 'border-[#7C5CFF]/45 bg-[#7C5CFF]/16 text-[#D0C6FF]'
                          : 'border-white/[0.09] bg-[#121212] text-white/45 hover:border-white/[0.16] hover:text-white/70'
                    )}
                  >
                    {running ? (
                      <span className="relative flex size-2.5 shrink-0" aria-label="Provider running">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-55" />
                        <span className="relative inline-flex size-2.5 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,.8)]" />
                      </span>
                    ) : (
                      <span className={cn(
                        'h-2 w-2 shrink-0 rounded-full transition-colors',
                        selected ? 'bg-[#9F87FF]' : 'bg-white/30'
                      )} />
                    )}
                    {promptAssistantProviderLabel(provider)}
                  </button>
                )
              })}
            </div>
          </section>

          {assistantError && (
            <div className="mt-3 rounded-xl border border-red-400/20 bg-red-400/[0.07] px-3 py-2.5 text-[10px] leading-4 text-red-200/80">
              {assistantError}
            </div>
          )}

          <section className="mt-5">
            <input
              ref={styleThumbnailInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleStyleThumbnailUpload}
            />
            <div className="relative z-40 flex items-center gap-4 overflow-visible">
              <div className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {PROMPT_ASSISTANT_STYLE_CATEGORIES.map((category) => (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setStyleCategory(category)}
                    className={cn(
                      'shrink-0 text-[11px] transition-colors',
                      styleCategory === category
                        ? 'font-semibold text-white'
                        : 'font-medium text-[#707070] hover:text-[#A8A8A8]'
                    )}
                  >
                    {category}
                  </button>
                ))}
              </div>
              <div ref={styleThumbnailManagerRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setStyleThumbnailManagerOpen((current) => !current)}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-lg border text-[13px] tracking-[0.08em] transition-colors',
                    styleThumbnailManagerOpen
                      ? 'border-[#7C5CFF]/45 bg-[#7C5CFF]/14 text-[#D0C6FF]'
                      : 'border-white/[0.1] bg-[#121212] text-white/40 hover:bg-white/[0.06] hover:text-white/70'
                  )}
                  title="Manage style thumbnails"
                >
                  ···
                </button>

                {styleThumbnailManagerOpen && (
                  <div className="absolute right-0 top-9 z-50 w-[218px] rounded-xl border border-white/[0.1] bg-[#1B1B1B] p-1.5 shadow-[0_18px_48px_rgba(0,0,0,0.65)]">
                    <button type="button" onClick={openStyleThumbnailEditor} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[10px] font-medium text-white/65 transition-colors hover:bg-white/[0.06] hover:text-white">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#7C5CFF]/14 text-[#C8BCFF]">
                        <ImageIcon className="h-3.5 w-3.5" />
                      </span>
                      <span>
                        <span className="block">Upload ảnh thumbnail</span>
                        <span className="mt-0.5 block text-[8px] font-normal text-white/28">Thêm, sửa hoặc xóa ảnh style</span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-3 overflow-x-auto overflow-y-hidden pb-7 [scrollbar-color:rgba(255,255,255,0.16)_transparent] [scrollbar-width:thin]">
              <div className="flex min-w-max gap-2">
                <button
                  type="button"
                  onClick={() => setStyle('Auto')}
                  className="group h-[134px] w-[76px] shrink-0 text-left transition-transform hover:-translate-y-0.5"
                  title="No visual style"
                >
                  <span className={cn(
                    'flex h-[104px] w-full items-center justify-center rounded-xl border bg-[#202020] text-white/35 transition-colors',
                    style === 'Auto'
                      ? 'border-[#7C5CFF] ring-1 ring-[#7C5CFF]/30'
                      : 'border-white/[0.1] group-hover:border-white/25 group-hover:text-white/55'
                  )}>
                    <span className="relative h-5 w-5 rounded-full border-[1.5px] border-current">
                      <span className="absolute left-1/2 top-1/2 h-[1.5px] w-6 -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-current" />
                    </span>
                  </span>
                  <span className="block truncate px-1 pt-1.5 text-center text-[9px] font-semibold text-white/55">None</span>
                </button>

                {visibleStyleAddons.map((addon) => {
                  const customThumbnail = styleThumbnailOverrides[addon.id]
                  return (
                    <div key={addon.id} className="group relative h-[134px] w-[76px] shrink-0 overflow-visible transition-transform hover:-translate-y-0.5">
                      <button type="button" onClick={() => setStyle(addon.name)} className="block h-full w-full text-left" title={addon.name}>
                        <span className={cn(
                          'block h-[104px] overflow-hidden rounded-xl border bg-[#202020] transition-colors',
                          style === addon.name
                            ? 'border-[#7C5CFF] ring-1 ring-[#7C5CFF]/30'
                            : 'border-white/[0.1] group-hover:border-white/25'
                        )}>
                          <PromptAssistantStyleThumbnailImage addon={addon} customThumbnail={customThumbnail} className="h-full w-full" />
                        </span>
                        <span className="block truncate px-1 pt-1.5 text-[9px] font-semibold text-white/75">{addon.name}</span>
                      </button>

                      {addon.premium ? (
                        <span className="absolute left-1 top-1 flex h-4 min-w-4 items-center justify-center rounded bg-black/65 px-1 text-[8px] text-[#D0C6FF]">♛</span>
                      ) : null}

                      <span className="pointer-events-none absolute left-1/2 top-[calc(100%+7px)] z-20 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/90 px-2 py-1 text-[9px] font-medium text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                        {addon.name}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>

          <section className="mt-5 rounded-2xl border border-white/[0.07] bg-[#141414] p-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex shrink-0 items-center gap-2">
                <span className="flex items-center gap-1.5 whitespace-nowrap text-[9px] font-medium text-white/35"><AlignLeft className="h-3 w-3" />Count</span>
                <div className="flex h-8 w-[112px] items-center rounded-lg border border-white/[0.08] bg-[#121212] p-0.5 transition-colors focus-within:border-[#7C5CFF]/70 focus-within:ring-2 focus-within:ring-[#7C5CFF]/10">
                <button
                  type="button"
                  onClick={() => setCount((current) => Math.max(1, current - 1))}
                  disabled={count <= 1}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:text-white/12 disabled:hover:bg-transparent"
                  aria-label="Decrease prompt count"
                >
                  <Minus className="h-3 w-3" />
                </button>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={count}
                  onChange={(event) => setCount(Math.max(1, Math.min(10, Number(event.target.value) || 1)))}
                  className="h-full min-w-0 flex-1 appearance-none bg-transparent text-center text-[11px] font-semibold text-white/75 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  aria-label="Number of prompts to return"
                />
                <button
                  type="button"
                  onClick={() => setCount((current) => Math.min(10, current + 1))}
                  disabled={count >= 10}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:text-white/12 disabled:hover:bg-transparent"
                  aria-label="Increase prompt count"
                >
                  <Plus className="h-3 w-3" />
                </button>
                </div>
              </div>

              <div className="h-5 w-px shrink-0 bg-white/[0.07]" />

              <input
                ref={assistantReferenceInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  addAssistantReferenceFiles(Array.from(event.target.files || []))
                  event.target.value = ''
                }}
              />
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[9px] font-medium text-white/35"><ImageIcon className="h-3 w-3" />Reference images</span>
              <button
                type="button"
                onClick={() => assistantReferenceInputRef.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault()
                  setReferenceDropActive(true)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  setReferenceDropActive(true)
                }}
                onDragLeave={(event) => {
                  event.preventDefault()
                  setReferenceDropActive(false)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  setReferenceDropActive(false)
                  addAssistantReferenceFiles(Array.from(event.dataTransfer.files || []))
                }}
                disabled={assistantReferenceImages.length >= 5}
                className={cn(
                  'flex h-8 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border bg-[#121212] text-[9px] font-medium transition-colors',
                  referenceDropActive
                    ? 'border-[#7C5CFF]/70 bg-[#7C5CFF]/10 text-[#D0C6FF]'
                    : 'border-white/[0.09] text-white/35 hover:border-white/[0.16] hover:text-white/60',
                  assistantReferenceImages.length >= 5 && 'cursor-not-allowed opacity-45'
                )}
              >
                <Upload className="h-3.5 w-3.5" />
                Select / Drag image
              </button>
              <span className="shrink-0 text-[9px] font-semibold text-white/30">{assistantReferenceImages.length}/5</span>
            </div>

            {assistantReferenceImages.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-white/[0.06] pt-3">
                {assistantReferenceImages.map((image, index) => (
                  <div key={image.id} className="group relative h-12 w-12 overflow-visible rounded-lg border border-white/[0.1] bg-[#101010]">
                    <img src={image.previewUrl} alt={`Reference ${index + 1}`} className="h-full w-full rounded-[7px] object-cover" />
                    <span className="absolute bottom-0.5 left-0.5 rounded bg-black/75 px-1 text-[8px] font-semibold text-[#C9BEFF]">@image{index + 1}</span>
                    <button
                      type="button"
                      onClick={() => removeAssistantReferenceImage(image.id)}
                      className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-[#141414] bg-[#282828] text-white/60 opacity-0 transition-all hover:bg-red-500 hover:text-white group-hover:opacity-100"
                      title="Remove reference"
                    >
                      <X className="h-2 w-2" />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="mt-3 overflow-hidden rounded-2xl border border-white/[0.07] bg-[#141414] p-4"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <span className={advancedLabelClass}><Globe2 className="h-3 w-3" />Language</span>
                  <AssistantSelect value={language} options={['English', 'Vietnamese']} onChange={(value) => setLanguage(value as PromptAssistantLanguage)} ariaLabel="Prompt language" />
                </div>
                <div>
                  <span className={advancedLabelClass}><AlignLeft className="h-3 w-3" />Detail</span>
                  <AssistantSelect value={detail} options={['Concise', 'Balanced', 'Detailed']} onChange={(value) => setDetail(value as PromptAssistantDetail)} ariaLabel="Prompt detail level" />
                </div>

                <div>
                  <span className={advancedLabelClass}><Palette className="h-3 w-3" />Style</span>
                  <input value={style} onChange={(event) => setStyle(event.target.value)} className={advancedInputClass} placeholder="cinematic" />
                </div>
                <div />

                <div className="sm:col-span-2">
                  <span className={advancedLabelClass}><RectangleHorizontal className="h-3 w-3" />Aspect</span>
                  <div className="flex flex-wrap gap-1.5">
                    {(['16:9', '9:16', '1:1', '4:3', '3:4'] as AspectRatio[]).map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => setAssistantAspectRatio(ratio)}
                        className={cn(
                          'flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[10px] font-medium transition-colors',
                          assistantAspectRatio === ratio
                            ? 'border-[#7C5CFF]/55 bg-[#7C5CFF]/16 text-[#D0C6FF]'
                            : 'border-white/[0.09] bg-[#121212] text-white/45 hover:border-white/[0.16] hover:text-white/70'
                        )}
                      >
                        <span className={cn('h-2.5 w-2.5 rounded-[2px] border', assistantAspectRatio === ratio ? 'border-[#9F87FF] bg-[#9F87FF]/30' : 'border-white/35')} />
                        {ratio}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className={advancedLabelClass}><Sun className="h-3 w-3" />Lighting</span>
                  <AssistantSelect value={lighting} options={PROMPT_ASSISTANT_LIGHTING} onChange={setLighting} ariaLabel="Lighting" />
                </div>
                <div>
                  <span className={advancedLabelClass}><Camera className="h-3 w-3" />Camera</span>
                  <AssistantSelect value={camera} options={PROMPT_ASSISTANT_CAMERAS} onChange={setCamera} ariaLabel="Camera" />
                </div>

                <div>
                  <span className={advancedLabelClass}><Clock3 className="h-3 w-3" />Total (sec)</span>
                  <input type="number" min="1" value={totalSeconds} onChange={(event) => setTotalSeconds(event.target.value)} className={advancedInputClass} />
                </div>
                <div>
                  <span className={advancedLabelClass}><Clock3 className="h-3 w-3" />Sec/image</span>
                  <input type="number" min="1" value={secondsPerImage} onChange={(event) => setSecondsPerImage(event.target.value)} className={advancedInputClass} />
                </div>

                <div>
                  <span className={advancedLabelClass}><Activity className="h-3 w-3" />Tone/genre</span>
                  <input value={tone} onChange={(event) => setTone(event.target.value)} className={advancedInputClass} placeholder="auto" />
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
                {[
                  { label: 'Sequential (storyboard)', checked: sequential, setChecked: setSequential },
                  { label: 'Keep consistent', checked: keepConsistent, setChecked: setKeepConsistent },
                  { label: 'Numbered', checked: numbered, setChecked: setNumbered },
                  { label: 'Auto-write script + subs', checked: autoWriteScript, setChecked: setAutoWriteScript },
                  { label: 'Burn subtitle on image/video', checked: burnSubtitles, setChecked: setBurnSubtitles },
                ].map((option) => (
                  <label key={option.label} className="flex cursor-pointer items-start gap-2 text-[10px] leading-4 text-white/65">
                    <input
                      type="checkbox"
                      checked={option.checked}
                      onChange={(event) => option.setChecked(event.target.checked)}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#7C5CFF]"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>

              <input
                value={negativePrompt}
                onChange={(event) => setNegativePrompt(event.target.value)}
                className={cn(advancedInputClass, 'mt-4')}
                placeholder="Avoid: ... (negative, optional)"
              />
            </motion.div>
          )}
        </div>

        <AnimatePresence>
          {styleThumbnailEditorOpen && (() => {
            const selectedAddon = PROMPT_ASSISTANT_STYLE_ADDONS.find((addon) => addon.id === styleThumbnailEditorId) || visibleStyleAddons[0]
            if (!selectedAddon) return null
            const hasCustomThumbnail = Boolean(styleThumbnailOverrides[selectedAddon.id])
            return (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-[70] flex items-center justify-center bg-black/70 p-5 backdrop-blur-[3px]"
                onMouseDown={() => setStyleThumbnailEditorOpen(false)}
              >
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.99 }}
                  className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-white/[0.1] bg-[#1A1A1A] shadow-[0_24px_70px_rgba(0,0,0,0.7)]"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3.5">
                    <div>
                      <p className="text-[12px] font-semibold text-white/80">Chỉnh sửa thumbnail</p>
                      <p className="mt-0.5 text-[9px] text-white/30">Upload, xóa và tùy chỉnh prompt sửa ảnh</p>
                    </div>
                    <button type="button" onClick={() => setStyleThumbnailEditorOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/30 hover:bg-white/[0.06] hover:text-white/70">
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-[164px_minmax(0,1fr)] gap-5 p-5">
                    <div className="rounded-2xl border border-white/[0.07] bg-[#141414] p-3">
                      <div className="mx-auto h-[180px] w-[128px] overflow-hidden rounded-xl bg-[#0E0E0E] shadow-[0_10px_28px_rgba(0,0,0,0.35)]">
                        <PromptAssistantStyleThumbnailImage addon={selectedAddon} customThumbnail={styleThumbnailOverrides[selectedAddon.id]} className="h-full w-full" />
                      </div>
                      <p className="mt-2.5 truncate text-center text-[10px] font-semibold text-white/70">{selectedAddon.name}</p>
                      <div className="mt-3 flex gap-2">
                        <button type="button" onClick={() => openStyleThumbnailUpload(selectedAddon.id)} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#7C5CFF] text-[9px] font-semibold text-white shadow-[0_7px_20px_rgba(124,92,255,0.2)] hover:bg-[#8768FF]">
                          <Upload className="h-3.5 w-3.5" /> Thay ảnh
                        </button>
                        <button type="button" disabled={!hasCustomThumbnail} onClick={() => void resetStyleThumbnail(selectedAddon.id)} className={cn('flex h-9 w-9 items-center justify-center rounded-xl border', hasCustomThumbnail ? 'border-red-400/20 text-red-300 hover:bg-red-500/15' : 'cursor-not-allowed border-white/[0.06] text-white/15')} title="Xóa ảnh custom">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="min-w-0">
                      <label className="mb-1.5 block text-[9px] font-semibold uppercase tracking-[0.1em] text-white/30">Style cần chỉnh</label>
                      <Select.Root value={styleThumbnailEditorId} onValueChange={selectStyleThumbnailEditor}>
                        <Select.Trigger className="group flex h-10 w-full items-center justify-between rounded-xl border border-white/[0.08] bg-[#111] px-3 text-left text-[10px] font-medium text-white/70 outline-none transition-colors hover:border-white/[0.14] focus:border-[#7C5CFF]/60">
                          <Select.Value />
                          <Select.Icon asChild><ChevronDown className="h-3.5 w-3.5 text-white/30 group-data-[state=open]:rotate-180" /></Select.Icon>
                        </Select.Trigger>
                        <Select.Portal>
                          <Select.Content position="popper" sideOffset={6} collisionPadding={12} className="z-[240] max-h-[300px] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-white/[0.1] bg-[#1B1B1B] p-1 shadow-[0_18px_48px_rgba(0,0,0,0.65)]">
                            <Select.Viewport>
                              {PROMPT_ASSISTANT_STYLE_ADDONS.map((addon) => (
                                <Select.Item key={addon.id} value={addon.id} className="relative flex h-9 cursor-pointer select-none items-center rounded-lg pl-8 pr-3 text-[10px] text-white/60 outline-none data-[highlighted]:bg-[#7C5CFF]/12 data-[highlighted]:text-white data-[state=checked]:text-[#C8BCFF]">
                                  <Select.ItemIndicator className="absolute left-2.5"><Check className="h-3.5 w-3.5" /></Select.ItemIndicator>
                                  <Select.ItemText>{addon.category} · {addon.name}</Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.Viewport>
                          </Select.Content>
                        </Select.Portal>
                      </Select.Root>

                      <label className="mb-1.5 mt-3 block text-[9px] font-semibold uppercase tracking-[0.1em] text-white/30">Prompt sửa ảnh</label>
                      <textarea value={styleThumbnailEditPrompt} onChange={(event) => setStyleThumbnailEditPrompt(event.target.value)} className="h-[134px] w-full resize-none rounded-xl border border-white/[0.09] bg-[#111] p-3 text-[10px] leading-5 text-white/75 outline-none focus:border-[#7C5CFF]/60 focus:ring-2 focus:ring-[#7C5CFF]/10" />

                      <div className="mt-3 flex items-center justify-between gap-3">
                        <button type="button" onClick={() => setStyleThumbnailEditPrompt(getDefaultStyleEditPrompt(selectedAddon))} className="flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-[9px] font-medium text-white/35 hover:bg-white/[0.05] hover:text-white/65">
                          <RotateCcw className="h-3.5 w-3.5" /> Khôi phục prompt mẫu
                        </button>
                        <button type="button" disabled={!styleThumbnailEditPrompt.trim()} onClick={() => void saveStyleEditPrompt()} className={cn('flex h-9 items-center gap-1.5 rounded-xl px-4 text-[9px] font-semibold', styleThumbnailEditPrompt.trim() ? 'bg-[#7C5CFF] text-white shadow-[0_7px_20px_rgba(124,92,255,0.2)] hover:bg-[#8768FF]' : 'cursor-not-allowed bg-white/5 text-white/20')}>
                          <Check className="h-3.5 w-3.5" /> Lưu thay đổi
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )
          })()}
        </AnimatePresence>

        <footer className="flex shrink-0 items-center gap-3 border-t border-white/[0.07] bg-[#151515] px-5 py-3.5">
          <div className="hidden min-w-0 flex-1 sm:block">
            <p className="truncate text-[11px] font-medium text-white/45">{count} {count === 1 ? 'prompt' : 'prompts'} · {mediaType} · {assistantAspectRatio} · {promptAssistantProviderLabel(assistantProvider)}</p>
            <p className="mt-0.5 text-[9px] text-white/22">Your current prompt is replaced only after the AI response is complete.</p>
          </div>
          <button type="button" onClick={onClose} className="h-10 rounded-xl px-4 text-[12px] font-semibold text-white/40 transition-colors hover:bg-white/[0.05] hover:text-white/75">
            Cancel
          </button>
          <button
            type="button"
            onClick={applyAssistant}
            disabled={!idea.trim() || isGeneratingPrompt || (assistantProvider === 'api' && !apiProviderReady)}
            className={cn(
              'flex h-10 min-w-[170px] items-center justify-center gap-2 rounded-xl px-5 text-[12px] font-semibold transition-all',
              idea.trim() && !isGeneratingPrompt && (assistantProvider !== 'api' || apiProviderReady)
                ? 'bg-[#7C5CFF] text-white shadow-[0_8px_24px_rgba(124,92,255,0.28)] hover:bg-[#8768FF] active:translate-y-px'
                : 'cursor-not-allowed bg-white/5 text-white/20'
            )}
          >
            {isGeneratingPrompt ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
            {assistantProvider === 'api' && !apiProviderReady
              ? 'Configure API in Settings'
              : isGeneratingPrompt
                ? `Waiting for ${promptAssistantProviderLabel(assistantProvider)}...`
                : 'Generate prompts'}
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
  const flowRuntimeDiagnosticsEnabled = useSettingsStore((state) => state.flowRuntimeDiagnosticsEnabled === true)
  const showFlowUtilityPanels = useSettingsStore((state) => state.showFlowUtilityPanels !== false)
  const updateSettings = useSettingsStore((state) => state.updateSettings)
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
  const [flowAdmissionResetReason, setFlowAdmissionResetReason] = useState('')
  const [flowAdmissionResetting, setFlowAdmissionResetting] = useState(false)
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
  const [flowDiagnosticBusyAction, setFlowDiagnosticBusyAction] = useState<string>('')
  const [flowDiagnosticStatus, setFlowDiagnosticStatus] = useState('Diagnostics are off.')
  const [flowDiagnosticResult, setFlowDiagnosticResult] = useState<Record<string, unknown> | null>(null)
  const [flowRuntimeSessionId, setFlowRuntimeSessionId] = useState<string>('')
  const [flowRecoverySnapshot, setFlowRecoverySnapshot] = useState<FlowRecoverySnapshot | null>(null)
  const [flowRecoveryBusyAction, setFlowRecoveryBusyAction] = useState('')
  const flowDiagnosticMountedRef = useRef(false)

  const refreshFlowRecoverySnapshot = useCallback(async () => {
    if (activeProvider !== 'flow') return
    const response = await chrome.runtime.sendMessage({ action: 'FLOW_GET_RECOVERY_SNAPSHOT' }) as {
      success?: boolean
      snapshot?: FlowRecoverySnapshot
    }
    if (response?.success === true && response.snapshot) setFlowRecoverySnapshot(response.snapshot)
  }, [activeProvider])

  useEffect(() => {
    if (activeProvider !== 'flow') return
    void refreshFlowRecoverySnapshot().catch(() => undefined)
    const interval = window.setInterval(() => {
      void refreshFlowRecoverySnapshot().catch(() => undefined)
    }, 3_000)
    return () => window.clearInterval(interval)
  }, [activeProvider, refreshFlowRecoverySnapshot])

  useEffect(() => {
    const startNewSession = flowDiagnosticMountedRef.current && flowRuntimeDiagnosticsEnabled
    flowDiagnosticMountedRef.current = true
    chrome.runtime.sendMessage({
      action: 'FLOW_RUNTIME_SET_ENABLED',
      payload: { enabled: flowRuntimeDiagnosticsEnabled, startNewSession },
    }).then((response: { runtimeSessionId?: string } | undefined) => {
      setFlowRuntimeSessionId(String(response?.runtimeSessionId || ''))
      setFlowDiagnosticStatus(flowRuntimeDiagnosticsEnabled
        ? 'Runtime diagnostics are on.'
        : 'Diagnostics are off.')
    }).catch((error) => {
      setFlowDiagnosticStatus(`Diagnostics setting failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [flowRuntimeDiagnosticsEnabled])

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

  function persistResolvedFlowReferences(
    originalRefs: RefImage[],
    resolvedRefs: RefImage[],
  ): void {
    const replacements = new Map<string, RefImage>()
    originalRefs.forEach((ref, index) => {
      const resolved = resolvedRefs[index]
      if (resolved && ref.id.startsWith('upload_')) replacements.set(ref.id, resolved)
    })
    if (replacements.size === 0) return

    // owner: google-flow — keep successful upload resolution across an
    // admission wait/denial so retry never uploads the same reference twice.
    setRefImages((current) => current.map((ref) => replacements.get(ref.id) || ref))
    setPendingUploads((current) => {
      const next = { ...current }
      replacements.forEach((_, uploadKey) => { delete next[uploadKey] })
      return next
    })
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
  callerId?: string
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

async function runFlowGeneration(payload: FlowPayload, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const callerId = payload.callerId || `gen-panel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const onAbort = () => {
    chrome.runtime.sendMessage({
      action: 'FLOW_CANCEL_ADMISSION',
      payload: { callerId },
    }).catch(() => {})
  }
  if (signal?.aborted) {
    throw signal.reason || new DOMException('Generation cancelled before admission', 'AbortError')
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'RUN_FLOW_PROMPT',
      payload: { ...payload, callerId },
    })
    return response as Record<string, unknown>
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
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

function flowResultNeedsAcknowledgedReset(result: Record<string, unknown> | null | undefined): boolean {
  const admission = result?.admission && typeof result.admission === 'object'
    ? result.admission as Record<string, unknown>
    : {}
  const state = String(admission.state || '')
  return result?.errorCode === 'submit_uncertain' || state === 'submit_uncertain' || state === 'blocked'
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
      persistResolvedFlowReferences(queueRefImages, resolved.resolvedRefImages)
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

      const result = await runFlowGeneration(payload, controller.signal)
      completed++

      if (flowResultNeedsAcknowledgedReset(result)) {
        setFlowAdmissionResetReason(String(result.statusReason || result.error || result.errorCode || 'Flow admission is blocked'))
      } else if (result.success) {
        setFlowAdmissionResetReason('')
      }

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

const handleFlowAdmissionReset = useCallback(async () => {
  if (flowAdmissionResetting) return
  const acknowledged = window.confirm(
    'Resetting extension state does not cancel an existing Flow generation. Check the Flow tab before generating again. Continue?'
  )
  if (!acknowledged) return

  setFlowAdmissionResetting(true)
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'FLOW_RESET_RECOVERY',
      payload: { userAcknowledged: true },
    }) as { success?: boolean; admission?: { state?: string }; recovery?: FlowRecoverySnapshot; error?: string }
    const state = String(response?.admission?.state || '')
    if (response?.recovery) setFlowRecoverySnapshot(response.recovery)
    if (response?.success === true && state === 'idle') {
      setFlowAdmissionResetReason('')
      setFlowStep('Flow admission and recovery state reset. Review the Flow tab before generating again.')
      return
    }
    setFlowStep(String(response?.error || `Flow admission remains ${state || 'blocked'}`))
  } catch (error) {
    setFlowStep(`Flow admission reset failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    setFlowAdmissionResetting(false)
  }
}, [flowAdmissionResetting])

const runFlowRecoveryAction = useCallback(async (action: string) => {
  if (flowRecoveryBusyAction) return
  setFlowRecoveryBusyAction(action)
  try {
    const response = await chrome.runtime.sendMessage({ action }) as {
      success?: boolean
      error?: string
      snapshot?: FlowRecoverySnapshot
      recovery?: FlowRecoverySnapshot
    }
    const snapshot = response.snapshot || response.recovery
    if (snapshot) setFlowRecoverySnapshot(snapshot)
    if (response.success === false && response.error) setFlowStep(response.error)
  } catch (error) {
    setFlowStep(`Flow recovery action failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    setFlowRecoveryBusyAction('')
    void refreshFlowRecoverySnapshot().catch(() => undefined)
  }
}, [flowRecoveryBusyAction, refreshFlowRecoverySnapshot])

const handleFlowDiagnosticToggle = useCallback((enabled: boolean) => {
  updateSettings({ flowRuntimeDiagnosticsEnabled: enabled })
  setFlowDiagnosticStatus(enabled ? 'Starting a new runtime diagnostic session…' : 'Diagnostics are off.')
  if (!enabled) setFlowDiagnosticResult(null)
}, [updateSettings])

const runFlowDiagnosticAction = useCallback(async (action: string, label: string) => {
  if (!flowRuntimeDiagnosticsEnabled || flowDiagnosticBusyAction) return
  setFlowDiagnosticBusyAction(action)
  setFlowDiagnosticStatus(`${label}…`)
  try {
    const response = await chrome.runtime.sendMessage({ action }) as Record<string, unknown>
    setFlowDiagnosticResult(response)
    const succeeded = response?.success !== false
    setFlowDiagnosticStatus(succeeded ? `${label} complete.` : `${label} returned a failure.`)
  } catch (error) {
    setFlowDiagnosticStatus(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    setFlowDiagnosticBusyAction('')
  }
}, [flowRuntimeDiagnosticsEnabled, flowDiagnosticBusyAction])

const handleFlowDiagnosticExport = useCallback(async () => {
  if (!flowRuntimeDiagnosticsEnabled || flowDiagnosticBusyAction) return
  setFlowDiagnosticBusyAction('FLOW_RUNTIME_GET_REPORT')
  setFlowDiagnosticStatus('Preparing sanitized diagnostic report…')
  try {
    const response = await chrome.runtime.sendMessage({ action: 'FLOW_RUNTIME_GET_REPORT' }) as {
      success?: boolean
      report?: Record<string, unknown>
      error?: string
    }
    if (response?.success !== true || !response.report) {
      throw new Error(response?.error || 'Diagnostic report was unavailable')
    }
    const json = JSON.stringify(response.report, null, 2)
    const filename = flowDiagnosticFilename()
    const download = await chrome.runtime.sendMessage({
      action: 'DOWNLOAD_FILE',
      payload: {
        data: textToBase64DataUrl(json),
        filename,
        mimeType: 'application/json',
      },
    }) as { success?: boolean; error?: string }
    if (download?.success !== true) throw new Error(download?.error || 'Report download failed')
    setFlowDiagnosticResult({ reportGenerated: true, filename, runtimeSessionId: flowRuntimeSessionId })
    setFlowDiagnosticStatus(`Exported ${filename}`)
  } catch (error) {
    setFlowDiagnosticStatus(`Export failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    setFlowDiagnosticBusyAction('')
  }
}, [flowRuntimeDiagnosticsEnabled, flowDiagnosticBusyAction, flowRuntimeSessionId])

const handleFlowDiagnosticResetLogs = useCallback(async () => {
  if (!flowRuntimeDiagnosticsEnabled || flowDiagnosticBusyAction) return
  setFlowDiagnosticBusyAction('FLOW_RUNTIME_RESET_LOGS')
  try {
    const response = await chrome.runtime.sendMessage({ action: 'FLOW_RUNTIME_RESET_LOGS' }) as {
      success?: boolean
      runtimeSessionId?: string
      error?: string
    }
    if (response?.success !== true) throw new Error(response?.error || 'Diagnostic reset failed')
    setFlowRuntimeSessionId(String(response.runtimeSessionId || flowRuntimeSessionId))
    setFlowDiagnosticResult(null)
    setFlowDiagnosticStatus('Diagnostic logs cleared. Flow admission was not changed.')
  } catch (error) {
    setFlowDiagnosticStatus(`Log reset failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    setFlowDiagnosticBusyAction('')
  }
}, [flowRuntimeDiagnosticsEnabled, flowDiagnosticBusyAction, flowRuntimeSessionId])

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
        persistResolvedFlowReferences(selectedRefImages, resolved.resolvedRefImages)
      }

      // Build base payload with resolved ref data (no upload_xxx, no File objects)
      const payload = buildGenerationPayload(resolvedRefImages, resolvedFileIds, resolvedFileNameMap)

      // Build payload throws REF_UPLOAD_NOT_RESOLVED if any upload_xxx slips through
      setFlowStep('Waiting for Flow to be ready...')
      const result = await runFlowGeneration(payload)

      if (result.success) {
        setFlowAdmissionResetReason('')
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
        const statusReason = String(result.statusReason || result.error || result.status || '')
        const errorCode = String(result.errorCode || '')
        const providerBusy = errorCode === 'flow_busy'
          && (statusReason === 'provider_has_pending_tiles' || statusReason === 'provider_has_generating_tiles')
        const providerBusyMessage = selectedRefImages.length > 0
          ? 'Flow is still processing another job. Your reference image is ready; wait for the queued/% tile to finish, then press Generate again.'
          : 'Flow is still processing another job. Wait for the queued/% tile to finish, then press Generate again.'
        setFlowStep(downloaded > 0
          ? `Partial success: downloaded ${downloaded}${failed > 0 ? `, ${failed} failed in Flow` : ''}`
          : providerBusy
            ? providerBusyMessage
            : `${errorCode ? `${errorCode}: ` : ''}${statusReason || `Flow partial: ${expected} expected, downloaded 0`}`
        )
        // A handled admission denial is UI state, not an extension runtime
        // warning. console.warn makes Chrome list it under extension Errors.
        console.log('[FlowAdmission][GenPanelResult]', JSON.stringify({
          jobId: result.jobId || '',
          success: false,
          errorCode,
          statusReason,
          evidenceCount: Array.isArray(result.evidence) ? result.evidence.length : 0,
        }))
        if (flowResultNeedsAcknowledgedReset(result)) {
          setFlowAdmissionResetReason(statusReason || errorCode || 'Flow admission is blocked')
        }
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

        {/* Flow Recovery */}
        {activeProvider === 'flow' && showFlowUtilityPanels && (
          <div className="px-4 pb-3">
            <div className={FLOW_UTILITY_PANEL_CLASS}>
              <div className="flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-[#9B82FF]" />
                <div className="text-[11px] font-medium text-white/70">Flow Recovery</div>
                <span className={cn(
                  'ml-auto text-[10px] font-medium',
                  flowRecoverySnapshot?.state === 'healthy'
                    ? 'text-emerald-300'
                    : flowRecoverySnapshot?.state === 'recovering'
                      ? 'text-[#B8A8FF]'
                      : 'text-amber-200',
                )}>
                  {flowRecoveryStatusText(flowRecoverySnapshot)}
                </span>
              </div>
              {flowRecoverySnapshot?.terminalDecision && flowRecoverySnapshot.state !== 'healthy' && (
                <div className="mt-1.5 break-words text-[9px] leading-4 text-white/35">
                  {flowRecoverySnapshot.terminalDecision}
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => void runFlowRecoveryAction('FLOW_RUN_RECOVERY_HEALTH_PROBE')}
                  disabled={!!flowRecoveryBusyAction}
                  className={FLOW_UTILITY_ACTION_CLASS}
                >
                  {flowRecoveryBusyAction === 'FLOW_RUN_RECOVERY_HEALTH_PROBE' ? 'Probing…' : 'Run health probe'}
                </button>
                <button
                  type="button"
                  onClick={() => void runFlowRecoveryAction('FLOW_ATTEMPT_SESSION_RECOVERY')}
                  disabled={!!flowRecoveryBusyAction || !(
                    flowRecoverySnapshot?.state === 'session_suspect'
                    && flowRecoverySnapshot.errorCode === 'session_expired'
                    && flowRecoverySnapshot.sessionRefreshAttempted === false
                  )}
                  className={FLOW_UTILITY_ACTION_CLASS}
                >
                  {flowRecoveryBusyAction === 'FLOW_ATTEMPT_SESSION_RECOVERY' ? 'Recovering…' : 'Attempt session recovery'}
                </button>
                <button
                  type="button"
                  onClick={() => void runFlowRecoveryAction('FLOW_OPEN_TAB')}
                  disabled={!!flowRecoveryBusyAction}
                  className={FLOW_UTILITY_ACTION_CLASS}
                >
                  Open Flow tab
                </button>
                <button
                  type="button"
                  onClick={handleFlowAdmissionReset}
                  disabled={flowAdmissionResetting || !!flowRecoveryBusyAction}
                  className={FLOW_UTILITY_ACTION_CLASS}
                >
                  {flowAdmissionResetting ? 'Resetting…' : 'Acknowledge / manual reset'}
                </button>
              </div>
              <div className="mt-2 text-[9px] leading-4 text-white/30">
                Resetting extension state does not cancel an existing Flow generation.
              </div>
            </div>
          </div>
        )}

        {/* Flow Runtime Verification (read-only) */}
        {activeProvider === 'flow' && showFlowUtilityPanels && (
          <div className="px-4 pb-3">
            <div className={FLOW_UTILITY_PANEL_CLASS}>
              <div className="flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-[#9B82FF]" />
                <div className="text-[11px] font-medium text-white/70">Runtime Verification</div>
                <div className="ml-auto flex items-center gap-2">
                  <span className={cn('text-[10px] font-medium', flowRuntimeDiagnosticsEnabled ? 'text-[#B8A8FF]' : 'text-white/30')}>
                    Runtime Diagnostics: {flowRuntimeDiagnosticsEnabled ? 'ON' : 'OFF'}
                  </span>
                  <Toggle checked={flowRuntimeDiagnosticsEnabled} onChange={handleFlowDiagnosticToggle} />
                </div>
              </div>
              <div className="mt-1.5 text-[10px] text-white/35">These checks do not generate media.</div>
              {flowRuntimeSessionId && flowRuntimeDiagnosticsEnabled && (
                <div className="mt-1 truncate font-mono text-[9px] text-white/25" title={flowRuntimeSessionId}>
                  Session: {flowRuntimeSessionId}
                </div>
              )}

              <div className="mt-3 grid grid-cols-2 gap-1.5">
                {[
                  ['FLOW_RUNTIME_HANDSHAKE', 'Run Handshake'],
                  ['FLOW_RUNTIME_HEALTH_PROBE', 'Run Health Probe'],
                  ['GET_FLOW_ADMISSION_DIAGNOSTICS', 'Show Admission State'],
                  ['FLOW_RUNTIME_ADMISSION_DRY_RUN', 'Admission Dry-Run'],
                ].map(([action, label]) => (
                  <button
                    key={action}
                    type="button"
                    onClick={() => void runFlowDiagnosticAction(action, label)}
                    disabled={!flowRuntimeDiagnosticsEnabled || !!flowDiagnosticBusyAction}
                    className={FLOW_UTILITY_ACTION_CLASS}
                  >
                    {flowDiagnosticBusyAction === action ? 'Running…' : label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => void handleFlowDiagnosticExport()}
                  disabled={!flowRuntimeDiagnosticsEnabled || !!flowDiagnosticBusyAction}
                  className={FLOW_UTILITY_ACTION_CLASS}
                >
                  {flowDiagnosticBusyAction === 'FLOW_RUNTIME_GET_REPORT' ? 'Exporting…' : 'Export Diagnostic Report'}
                </button>
              </div>

              <div className="mt-2 border-t border-white/[0.06] pt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 text-[9px] leading-4 text-white/35">{flowDiagnosticStatus}</span>
                  <button
                    type="button"
                    onClick={() => void handleFlowDiagnosticResetLogs()}
                    disabled={!flowRuntimeDiagnosticsEnabled || !!flowDiagnosticBusyAction}
                    className="flex-shrink-0 text-[9px] text-white/30 hover:text-white/55 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {flowDiagnosticBusyAction === 'FLOW_RUNTIME_RESET_LOGS' ? 'Clearing…' : 'Reset Diagnostic Logs'}
                  </button>
                </div>
                {flowDiagnosticResult && (
                  <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 p-2 text-[9px] leading-4 text-white/40">
                    {JSON.stringify(flowDiagnosticResult, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}

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
              <div className="flex h-[30px] items-center gap-0.5 rounded-lg border border-white/5 bg-[#141414] px-1">
                <button
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="flex h-7 w-6 items-center justify-center rounded text-sm font-medium text-white/40 transition-colors hover:bg-white/5 hover:text-white"
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
                  className="flex h-7 w-6 items-center justify-center rounded text-sm font-medium text-white/40 transition-colors hover:bg-white/5 hover:text-white"
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
        {activeProvider === 'flow' && flowAdmissionResetReason && (
          <div className="mb-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-2">
            <div className="text-[10px] leading-4 text-amber-200/80">{flowAdmissionResetReason}</div>
            <button
              type="button"
              onClick={handleFlowAdmissionReset}
              disabled={flowAdmissionResetting}
              className="mt-1 text-[10px] font-medium text-amber-300 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {flowAdmissionResetting ? 'Resetting admission…' : 'Review Flow and reset admission…'}
            </button>
          </div>
        )}
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
              if (activeProvider === 'flow') setMultiPrompt(result.multiPrompt)
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
