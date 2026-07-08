// AI Provider Types
export type AIProvider = 'google-flow' | 'chatgpt' | 'grok' | 'claude' | 'gemini'

export interface ProviderAdapter {
  name: AIProvider
  detect(): Promise<boolean>
  open(): Promise<void>
  insertPrompt(prompt: string): Promise<void>
  uploadImage?(imageData: string): Promise<void>
  clickGenerate(): Promise<void>
  waitForResult(): Promise<string>
  downloadResult?(): Promise<string>
  setModel?(modelId: string): Promise<void>
  setAspectRatio?(ratio: string): Promise<void>
  setMediaType?(mediaType: 'image' | 'video'): Promise<void>
  setDuration?(duration: string): Promise<void>
  getModels(): Promise<string[]>
  cleanup(): Promise<void>
}

export interface ProviderConfig {
  provider: AIProvider
  model?: string
  aspectRatio?: string
  customInstructions?: string
}

// Node Types
export type FlowNodeType = 
  | 'prompt' 
  | 'image' 
  | 'generate' 
  | 'delay' 
  | 'download' 
  | 'wait' 
  | 'condition' 
  | 'loop' 
  | 'merge' 
  | 'split'

export interface BaseNodeData {
  label: string
  description?: string
  provider?: AIProvider
  enabled?: boolean
  [key: string]: unknown
}

export interface PromptNodeData extends BaseNodeData {
  prompt: string
  variables?: Record<string, string>
  provider: AIProvider
  model?: string
}

export interface ImageNodeData extends BaseNodeData {
  mediaType?: 'image' | 'video'
  mediaUrl?: string
  mediaData?: string
  mediaName?: string
  mediaMimeType?: string
  mediaPoster?: string
  imageUrl?: string
  imageData?: string
  videoUrl?: string
  videoData?: string
  videoPoster?: string
  aspectRatio: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | 'custom'
  customRatio?: string
  provider: AIProvider
}

export interface GenerateNodeData extends BaseNodeData {
  provider: AIProvider
  model?: string
  mediaType?: 'image' | 'video'
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | 'custom'
  videoDuration?: string
  quantity?: number
  /**
   * Download resolution for Google Flow outputs. Distinct from
   * `aspectRatio` (which is the generation ratio). Accepted values:
   * `'1k'` | `'2k'` | `'4k'`. Defaults to `'1k'` when the
   * provider is `google-flow`. Ignored for ChatGPT.
   *
   * Wired into `RUN_FLOW_PROMPT.payload.resolution` by runner. The
   * Flow bridge passes this into `downloadTileMedia`'s resolution
   * menu so manual / auto-downloads target the requested size.
   */
  resolution?: '1k' | '2k' | '4k'
  autoGenerate?: boolean
  waitForCompletion?: boolean
  timeout?: number
}

export interface DelayNodeData extends BaseNodeData {
  duration: number // milliseconds
}

export interface DownloadNodeData extends BaseNodeData {
  format: 'png' | 'jpg' | 'webp' | 'svg' | 'txt'
  autoDownload?: boolean
  filename?: string
}

export interface WaitNodeData extends BaseNodeData {
  condition: 'dom-change' | 'text-appear' | 'element-visible' | 'manual'
  selector?: string
  expectedText?: string
  timeout?: number
}

export interface ConditionNodeData extends BaseNodeData {
  condition: string
  trueLabel?: string
  falseLabel?: string
}

export interface LoopNodeData extends BaseNodeData {
  iterations: number
  delayBetween?: number
}

export type FlowNodeData = 
  | PromptNodeData 
  | ImageNodeData 
  | GenerateNodeData 
  | DelayNodeData 
  | DownloadNodeData 
  | WaitNodeData 
  | ConditionNodeData 
  | LoopNodeData

// Workflow Types
export interface WorkflowNode {
  id: string
  type: FlowNodeType
  position: { x: number; y: number }
  data: FlowNodeData
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  label?: string
  animated?: boolean
}

export interface Workflow {
  id: string
  name: string
  description?: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  createdAt: number
  updatedAt: number
  isTemplate?: boolean
  tags?: string[]
}

// Pipeline Types
export type PipelineStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'

export interface PipelineTask {
  id: string
  workflowId: string
  status: PipelineStatus
  currentNodeId?: string
  progress: number // 0-100
  results: Record<string, unknown>
  errors: PipelineError[]
  startedAt?: number
  completedAt?: number
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface PipelineError {
  nodeId: string
  message: string
  timestamp: number
  recoverable: boolean
}

export interface PipelineLog {
  id: string
  pipelineId: string
  nodeId?: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
  timestamp: number
  metadata?: Record<string, unknown>
}

// History Types
export interface HistoryEntry {
  id: string
  workflowId: string
  workflowName: string
  status: PipelineStatus
  duration?: number
  completedAt: number
  nodeResults: Record<string, unknown>
  errorCount: number
  thumbnail?: string
}

// Preset Template Types
export interface PresetTemplate {
  id: string
  name: string
  description: string
  category: string
  workflow: Workflow
  icon?: string
  usageCount?: number
  createdAt: number
}

// Settings Types
export interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  autoDownload: boolean
  downloadFormat: 'png' | 'jpg' | 'webp'
  defaultProvider: AIProvider
  defaultModel?: string
  defaultAspectRatio?: string
  maxRetries: number
  retryDelay: number
  timeoutDuration: number
  wakeLockEnabled: boolean
  notifications: {
    onComplete: boolean
    onError: boolean
    onProgress: boolean
  }
  shortcuts: {
    runWorkflow: string
    pauseWorkflow: string
    stopWorkflow: string
    openPanel: string
  }
  advanced: {
    headlessMode: boolean
    debugMode: boolean
    preserveSession: boolean
    parallelExecution: boolean
  }
}

// UI State Types
export type ActiveView = 
  | 'workflow-editor' 
  | 'prompt-manager' 
  | 'task-queue' 
  | 'history' 
  | 'presets' 
  | 'settings'

export interface UIState {
  activeView: ActiveView
  selectedNodeId?: string
  isPipelineRunning: boolean
  isPanelExpanded: boolean
  showMiniProgress: boolean
  sidebarCollapsed: boolean
}

// Message Types for chrome.runtime
export type MessageAction =
  | 'EXECUTE_NODE'
  | 'NODE_COMPLETE'
  | 'NODE_ERROR'
  | 'PIPELINE_START'
  | 'PIPELINE_PAUSE'
  | 'PIPELINE_RESUME'
  | 'PIPELINE_STOP'
  | 'PIPELINE_PROGRESS'
  | 'PIPELINE_COMPLETE'
  | 'PIPELINE_ERROR'
  | 'INJECT_SCRIPT'
  | 'GET_TAB_INFO'
  | 'OPEN_TAB'
  | 'OPEN_PROVIDER_TAB'
  | 'ENSURE_PROVIDER_TAB_FOR_WORKFLOW'
  | 'FOCUS_TAB'
  | 'WAKE_LOCK_REQUEST'
  | 'WAKE_LOCK_RELEASE'
  | 'DOWNLOAD_FILE'
  | 'STORAGE_GET'
  | 'STORAGE_SET'
  | 'NOTIFICATION'
  | 'OPEN_WORKFLOW_EDITOR_WINDOW'
  | 'REGISTER_WORKFLOW_EDITOR_TAB'
  | 'RESTORE_EDITOR_FOCUS'
  | 'CHECK_FLOW_TAB'
  | 'RUN_FLOW_PROMPT'
  | 'RUN_CHATGPT_PROMPT'
  | 'GET_CHATGPT_JOB_STATUS'
  | 'FLOW_STATUS'
  | 'FLOW_INJECT_BRIDGE'
  | 'FLOW_GET_TILES'
  | 'FLOW_DEBUG_PING'

export interface ChromeMessage<T = unknown> {
  action: MessageAction
  payload?: T
  tabId?: number
  timestamp: number
}

export interface ExecuteNodePayload {
  nodeId: string
  nodeType: FlowNodeType
  nodeData: FlowNodeData
  provider: AIProvider
  context: Record<string, unknown>
}

export interface PipelineProgressPayload {
  pipelineId: string
  currentNodeId: string
  progress: number
  status: PipelineStatus
  results: Record<string, unknown>
}

// Content Script Types
export interface ContentScriptResult {
  success: boolean
  data?: unknown
  error?: string
  selector?: string
}

// Prompt Manager Types
export interface SavedPrompt {
  id: string
  name: string
  content: string
  provider: AIProvider
  variables?: PromptVariable[]
  tags?: string[]
  createdAt: number
  updatedAt: number
  usageCount?: number
}

export interface PromptVariable {
  name: string
  defaultValue?: string
  type: 'text' | 'number' | 'select' | 'boolean'
  options?: string[]
}
