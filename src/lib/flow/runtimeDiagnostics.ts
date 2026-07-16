export const FLOW_RUNTIME_DIAGNOSTICS_VERSION = 1

// Independent runtime markers. The background compares the values returned by
// each execution world with these expected values; bundle presence alone is
// never treated as proof that the live page is current.
export const FLOW_BACKGROUND_BUILD_MARKER = 'flow-background:phase-2.6:2026-07-17-025202'
export const FLOW_CONTENT_BUILD_MARKER = 'flow-content:phase-2.6:2026-07-17-025202'
export const FLOW_BRIDGE_BUILD_MARKER = 'flow-bridge:phase-2.6:2026-07-17-025202'

export type RuntimeMarkerStatus = 'MATCH' | 'MISSING' | 'MISMATCH'
export type SignalStatus = 'pass' | 'fail' | 'unknown'
export type SignalConfidence = 'low' | 'medium' | 'high'

export interface SignalResult<T = unknown> {
  status: SignalStatus
  reason: string
  evidenceSource: string
  confidence: SignalConfidence
  value?: T
}

export interface FlowRuntimeHealthReport {
  timestamp: number
  tabExists: SignalResult
  validFlowRoute: SignalResult
  bridgeReady: SignalResult
  composerDetected: SignalResult
  blockingDialogDetected: SignalResult
  sessionWarningDetected: SignalResult
  unusualActivityDetected: SignalResult
  rateLimitDetected: SignalResult
  processingTileCount: SignalResult<number>
  pendingTileCount: SignalResult<number>
  generatingTileCount: SignalResult<number>
}

export interface FlowRuntimeHealthInput {
  timestamp?: number
  tabExists: boolean | null
  validFlowRoute: boolean | null
  bridgeReady: boolean | null
  composerDetected: boolean | null
  blockingDialogDetected: boolean | null
  errorCode: string | null
  processingTileCount: number | null
  pendingTileCount: number | null
  generatingTileCount: number | null
}

export interface RuntimeInstanceRecord {
  instanceId: string
  documentId: string
  active: boolean
}

export interface RuntimeDuplicateResult {
  documentId: string
  activeCount: number
  activeInstanceIds: string[]
  duplicateDetected: boolean
}

export interface FlowRuntimeContentHandshakeResponse {
  contentReady?: boolean
  contentInstanceId?: string
  contentMarker?: string
  bridgeReady?: boolean
  bridgeInstanceId?: string
  bridgeMarker?: string
  composerDetected?: boolean
  duplicateBridgeDetected?: boolean
  duplicateListenerDetected?: boolean
  injectionCounts?: Record<string, unknown>
  error?: string
}

export interface FlowRuntimeHandshakeInput {
  timestamp?: number
  backgroundInstanceId: string
  tabId?: number
  flowUrlValid: boolean
  contentResponse?: FlowRuntimeContentHandshakeResponse | null
  error?: string
}

export interface FlowRuntimeHandshakeResult {
  success: boolean
  backgroundReady: boolean
  contentReady: boolean
  bridgeReady: boolean
  backgroundMarker: string
  contentMarker?: string
  bridgeMarker?: string
  backgroundInstanceId: string
  contentInstanceId?: string
  bridgeInstanceId?: string
  tabId?: number
  flowUrlValid: boolean
  composerDetected: boolean
  duplicateBridgeDetected: boolean
  duplicateListenerDetected: boolean
  markerStatus: {
    background: RuntimeMarkerStatus
    content: RuntimeMarkerStatus
    bridge: RuntimeMarkerStatus
  }
  injectionCounts?: Record<string, unknown>
  timestamp: number
  error?: string
}

export interface FlowRuntimeDiagnosticRecord {
  timestamp: number
  event: string
  runtimeSessionId: string
  [key: string]: unknown
}

export interface FlowRuntimeDiagnosticState {
  version: number
  enabled: boolean
  runtimeSessionId: string | null
  startedAt: number | null
  updatedAt: number
  logs: FlowRuntimeDiagnosticRecord[]
  testCaseResults: Array<Record<string, unknown>>
  consoleErrors: Array<Record<string, unknown>>
  lastHandshake: FlowRuntimeHandshakeResult | null
  lastHealthProbe: FlowRuntimeHealthReport | null
}

function createRuntimeSessionId(now: number): string {
  return `flow-runtime-${now}-${Math.random().toString(36).slice(2, 10)}`
}

export function createFlowRuntimeDiagnosticState(options: { enabled?: boolean; now?: number } = {}): FlowRuntimeDiagnosticState {
  const now = options.now ?? Date.now()
  const enabled = options.enabled === true
  return {
    version: FLOW_RUNTIME_DIAGNOSTICS_VERSION,
    enabled,
    runtimeSessionId: enabled ? createRuntimeSessionId(now) : null,
    startedAt: enabled ? now : null,
    updatedAt: now,
    logs: [],
    testCaseResults: [],
    consoleErrors: [],
    lastHandshake: null,
    lastHealthProbe: null,
  }
}

export function startFlowRuntimeDiagnosticSession(
  state: FlowRuntimeDiagnosticState,
  now = Date.now(),
): FlowRuntimeDiagnosticState {
  return {
    ...state,
    version: FLOW_RUNTIME_DIAGNOSTICS_VERSION,
    enabled: true,
    runtimeSessionId: createRuntimeSessionId(now),
    startedAt: now,
    updatedAt: now,
    logs: [],
    testCaseResults: [],
    consoleErrors: [],
    lastHandshake: null,
    lastHealthProbe: null,
  }
}

export function resetFlowRuntimeDiagnosticLogs(
  state: FlowRuntimeDiagnosticState,
  now = Date.now(),
): FlowRuntimeDiagnosticState {
  // Admission state is deliberately not an input to this reducer. Resetting
  // diagnostics cannot release, block, admit, or otherwise mutate the mutex.
  return {
    ...state,
    updatedAt: now,
    logs: [],
    testCaseResults: [],
    consoleErrors: [],
    lastHandshake: null,
    lastHealthProbe: null,
  }
}

export function evaluateRuntimeMarker(expected: string, actual?: string | null): RuntimeMarkerStatus {
  if (!actual) return 'MISSING'
  return actual === expected ? 'MATCH' : 'MISMATCH'
}

export function detectDuplicateRuntimeInstances(
  instances: RuntimeInstanceRecord[],
  currentDocumentId: string,
): RuntimeDuplicateResult {
  const activeInstanceIds = Array.from(new Set(
    instances
      .filter((instance) => instance.active && instance.documentId === currentDocumentId)
      .map((instance) => instance.instanceId)
      .filter(Boolean),
  ))
  return {
    documentId: currentDocumentId,
    activeCount: activeInstanceIds.length,
    activeInstanceIds,
    duplicateDetected: activeInstanceIds.length > 1,
  }
}

export function buildFlowRuntimeHandshake(input: FlowRuntimeHandshakeInput): FlowRuntimeHandshakeResult {
  const content = input.contentResponse || null
  const contentReady = content?.contentReady === true
  const bridgeReady = content?.bridgeReady === true
  const contentMarker = content?.contentMarker
  const bridgeMarker = content?.bridgeMarker
  const markerStatus = {
    background: evaluateRuntimeMarker(FLOW_BACKGROUND_BUILD_MARKER, FLOW_BACKGROUND_BUILD_MARKER),
    content: evaluateRuntimeMarker(FLOW_CONTENT_BUILD_MARKER, contentMarker),
    bridge: evaluateRuntimeMarker(FLOW_BRIDGE_BUILD_MARKER, bridgeMarker),
  }
  const success = contentReady && bridgeReady && input.flowUrlValid &&
    markerStatus.background === 'MATCH' && markerStatus.content === 'MATCH' && markerStatus.bridge === 'MATCH' &&
    content?.duplicateBridgeDetected !== true && content?.duplicateListenerDetected !== true

  return {
    success,
    backgroundReady: true,
    contentReady,
    bridgeReady,
    backgroundMarker: FLOW_BACKGROUND_BUILD_MARKER,
    ...(contentMarker ? { contentMarker } : {}),
    ...(bridgeMarker ? { bridgeMarker } : {}),
    backgroundInstanceId: input.backgroundInstanceId,
    ...(content?.contentInstanceId ? { contentInstanceId: content.contentInstanceId } : {}),
    ...(content?.bridgeInstanceId ? { bridgeInstanceId: content.bridgeInstanceId } : {}),
    ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
    flowUrlValid: input.flowUrlValid,
    composerDetected: content?.composerDetected === true,
    duplicateBridgeDetected: content?.duplicateBridgeDetected === true,
    duplicateListenerDetected: content?.duplicateListenerDetected === true,
    markerStatus,
    ...(content?.injectionCounts ? { injectionCounts: content.injectionCounts } : {}),
    timestamp: input.timestamp ?? Date.now(),
    ...((input.error || content?.error) ? { error: String(input.error || content?.error) } : {}),
  }
}

function booleanSignal(
  value: boolean | null,
  passReason: string,
  failReason: string,
  evidenceSource: string,
  confidence: SignalConfidence = 'high',
): SignalResult {
  if (value === null) {
    return { status: 'unknown', reason: 'signal_not_observed', evidenceSource, confidence: 'low' }
  }
  return {
    status: value ? 'pass' : 'fail',
    reason: value ? passReason : failReason,
    evidenceSource,
    confidence,
  }
}

function absenceSignal(
  detected: boolean | null,
  absentReason: string,
  detectedReason: string,
  evidenceSource: string,
): SignalResult {
  if (detected === null) {
    return { status: 'unknown', reason: 'signal_not_observed', evidenceSource, confidence: 'low' }
  }
  return {
    status: detected ? 'fail' : 'pass',
    reason: detected ? detectedReason : absentReason,
    evidenceSource,
    confidence: 'high',
  }
}

function countSignal(value: number | null, evidenceSource: string): SignalResult<number> {
  if (value === null || !Number.isFinite(value)) {
    return { status: 'unknown', reason: 'count_not_observed', evidenceSource, confidence: 'low' }
  }
  return {
    status: 'pass',
    reason: 'count_observed',
    evidenceSource,
    confidence: 'high',
    value: Math.max(0, value),
  }
}

function errorAbsenceSignal(errorCode: string | null, target: string): SignalResult {
  if (errorCode === null) {
    return { status: 'unknown', reason: 'warning_classification_not_observed', evidenceSource: 'bridge', confidence: 'low' }
  }
  const detected = errorCode === target
  return {
    status: detected ? 'fail' : 'pass',
    reason: detected ? `${target}_detected` : `${target}_not_detected`,
    evidenceSource: 'bridge',
    confidence: 'high',
  }
}

export function buildFlowRuntimeHealthReport(input: FlowRuntimeHealthInput): FlowRuntimeHealthReport {
  return {
    timestamp: input.timestamp ?? Date.now(),
    tabExists: booleanSignal(input.tabExists, 'flow_tab_exists', 'flow_tab_missing', 'background'),
    validFlowRoute: booleanSignal(input.validFlowRoute, 'flow_route_valid', 'flow_route_invalid', 'background'),
    bridgeReady: booleanSignal(input.bridgeReady, 'bridge_ready', 'bridge_unavailable', 'bridge'),
    composerDetected: booleanSignal(input.composerDetected, 'composer_detected', 'composer_missing', 'dom'),
    blockingDialogDetected: absenceSignal(input.blockingDialogDetected, 'blocking_dialog_not_detected', 'blocking_dialog_detected', 'dom'),
    sessionWarningDetected: errorAbsenceSignal(input.errorCode, 'session_expired'),
    unusualActivityDetected: errorAbsenceSignal(input.errorCode, 'unusual_activity'),
    rateLimitDetected: errorAbsenceSignal(input.errorCode, 'rate_limited'),
    processingTileCount: countSignal(input.processingTileCount, 'dom'),
    pendingTileCount: countSignal(input.pendingTileCount, 'dom'),
    generatingTileCount: countSignal(input.generatingTileCount, 'dom'),
  }
}

const FORBIDDEN_KEY_PATTERN = /(prompt|editor(?:Text|Content)?|cookie|authorization|token|apiKey|password|credential|secret|requestBody|responseBody)/i
const HASH_KEY_PATTERN = /^(tileIds?|fileNames?|filename|originalName|taskName|domFingerprints?)$/i
const MEDIA_URL_KEY_PATTERN = /^(mediaUrls?|thumbnailUrls?|downloadUrls?)$/i
const PAGE_URL_KEY_PATTERN = /^(url|currentUrl|flowUrl)$/i

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

async function sanitizeUrl(value: string, hashPathname: boolean): Promise<string> {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[REDACTED_URL]'
    const mediaHost = /(^|\.)googleusercontent\.com$/i.test(url.hostname) || /(^|\.)ggpht\.com$/i.test(url.hostname)
    if (hashPathname || mediaHost) {
      return `${url.origin}/[${await sha256(url.pathname)}]`
    }
    return `${url.origin}${url.pathname}`
  } catch {
    return '[REDACTED_URL]'
  }
}

function scrubSensitiveText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/authorization\s*:\s*(?:bearer\s+)?[^\s,;]+/gi, 'Authorization: [REDACTED]')
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b/g, '[REDACTED_TOKEN]')
    .replace(/(?:^|[;\s])(?:cookie|sid|ssid|hsid)\s*=\s*[^;\s]+/gi, ' [REDACTED_COOKIE]')
}

async function sanitizeUrlsInText(value: string): Promise<string> {
  const urlPattern = /https?:\/\/[^\s"'<>]+/gi
  let output = ''
  let cursor = 0
  for (const match of value.matchAll(urlPattern)) {
    const index = match.index ?? 0
    output += value.slice(cursor, index)
    output += await sanitizeUrl(match[0], false)
    cursor = index + match[0].length
  }
  return output + value.slice(cursor)
}

async function sanitizeValue(value: unknown, keyHint: string, depth: number): Promise<unknown> {
  if (depth > 12) return '[TRUNCATED_DEPTH]'
  if (FORBIDDEN_KEY_PATTERN.test(keyHint) && value !== undefined) return '[REDACTED]'
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (value === undefined) return undefined

  if (typeof value === 'string') {
    if (HASH_KEY_PATTERN.test(keyHint)) return sha256(value)
    if (MEDIA_URL_KEY_PATTERN.test(keyHint)) return sanitizeUrl(value, true)
    if (PAGE_URL_KEY_PATTERN.test(keyHint)) return sanitizeUrl(value, false)
    const scrubbed = scrubSensitiveText(value.slice(0, 2_000))
    return sanitizeUrlsInText(scrubbed)
  }

  if (Array.isArray(value)) {
    return Promise.all(value.slice(0, 500).map((item) => sanitizeValue(item, keyHint, depth + 1)))
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
      result[key] = await sanitizeValue(child, key, depth + 1)
    }
    return result
  }

  return scrubSensitiveText(String(value))
}

export async function sanitizeFlowRuntimeReport<T>(report: T): Promise<T> {
  return await sanitizeValue(report, '', 0) as T
}
