export type FlowErrorCode =
  | 'unusual_activity'
  | 'rate_limited'
  | 'session_expired'
  | 'generation_failed'
  | 'generation_timeout'
  | 'composer_missing'
  | 'bridge_unavailable'
  | 'flow_busy'
  | 'submit_uncertain'
  | 'download_failed'
  | 'cancelled'
  | 'unknown'

export type FlowEvidenceSource = 'dom' | 'bridge' | 'network' | 'timeout' | 'orchestrator'
export type FlowEvidenceConfidence = 'low' | 'medium' | 'high'

export interface FlowErrorEvidence {
  source: FlowEvidenceSource
  detectedAt: number
  confidence: FlowEvidenceConfidence
  statusReason?: string
  matchedText?: string[]
  selector?: string
  tileId?: string
  fileName?: string
}

export interface FlowStructuredError {
  code: FlowErrorCode
  message: string
  statusReason?: string
  evidence: FlowErrorEvidence[]
}

export interface FlowGenerationOutcome {
  expected: number
  generated: number
  failed: number
  pending: number
  partial: boolean
  status: 'not_started' | 'in_progress' | 'success' | 'partial' | 'failed' | 'timeout' | 'cancelled' | 'unknown'
}

export interface FlowDownloadOutcome {
  attempted: boolean
  downloaded: number
  failed: number
  skipped: number
  status: 'not_requested' | 'success' | 'partial' | 'failed' | 'cancelled' | 'unknown'
}

/**
 * Structured Google Flow result. `error` remains the legacy string field so
 * existing consumers do not receive an object where they expect text.
 * `flowError` is the additive structured contract used by new callers.
 */
export interface FlowResultContract {
  success: boolean
  status?: string
  error?: string
  errorCode?: FlowErrorCode
  flowError?: FlowStructuredError | null
  statusReason?: string
  evidence: FlowErrorEvidence[]
  generationOutcome: FlowGenerationOutcome
  downloadOutcome: FlowDownloadOutcome
  [key: string]: unknown
}

export type FlowAdmissionState =
  | 'idle'
  | 'checking'
  | 'admitted'
  | 'in_flight'
  | 'submit_uncertain'
  | 'terminal'
  | 'blocked'
  | 'cancelled'
  | 'manual_reset'

export interface FlowAdmissionJob {
  jobId: string
  source: string
  callerId?: string
  tabId: number
  mediaType: 'image' | 'video'
  requestedAt: number
  admittedAt?: number
  submittedAt?: number
  submitConfirmedAt?: number
  completedAt?: number
  state: FlowAdmissionState
  errorCode?: FlowErrorCode
  statusReason?: string
  cancellationRequestedAt?: number
}

export interface FlowAdmissionHealth {
  healthy: boolean
  tabExists: boolean
  url?: string
  bridgeReady: boolean
  composerPresent: boolean
  processing: number
  pending: number
  generating: number
  blockingDialog: boolean
  errorCode?: FlowErrorCode
  statusReason?: string
  evidence: FlowErrorEvidence[]
}

export interface FlowAdmissionSnapshot {
  scope: 'google-flow-global'
  state: FlowAdmissionState
  activeJob: FlowAdmissionJob | null
  lastJob: FlowAdmissionJob | null
  cooldownUntil: number
  capturedAt: number
}

export interface FlowAdmissionDiagnosticSnapshot {
  scope: 'google-flow-global'
  state: FlowAdmissionState
  ownerJobId?: string
  source?: string
  tabId?: number
  requestedAt?: number
  admittedAt?: number
  submittedAt?: number
  completedAt?: number
  blockedUntil?: number
  errorCode?: FlowErrorCode
  persistenceLoaded: boolean
  persistenceVersion: number
  safetyTimeoutRemainingMs?: number
  preSubmitLeaseRemainingMs?: number
  capturedAt: number
}

export type FlowRecoveryState =
  | 'healthy'
  | 'transient_failure'
  | 'session_suspect'
  | 'rate_limited'
  | 'cooldown'
  | 'recovering'
  | 'blocked'

export type FlowHealthSignalStatus = 'pass' | 'fail' | 'unknown'

export interface FlowHealthSignal<T = boolean> {
  status: FlowHealthSignalStatus
  value?: T
  reason?: string
}

export interface FlowHealthProbeResult {
  checkedAt: number
  tabExists: FlowHealthSignal
  routeValid: FlowHealthSignal
  bridgeReady: FlowHealthSignal
  composerReady: FlowHealthSignal
  loginRequired: FlowHealthSignal
  sessionWarning: FlowHealthSignal
  unusualActivityWarning: FlowHealthSignal
  rateLimitWarning: FlowHealthSignal
  blockingDialog: FlowHealthSignal
  activeGenerationCount: FlowHealthSignal<number>
  overall: 'healthy' | 'session_suspect' | 'rate_limited' | 'blocked' | 'busy' | 'unknown'
}

export interface FlowRecoveryStateHistoryEntry {
  previousState: FlowRecoveryState
  nextState: FlowRecoveryState
  timestamp: number
  reason: string
}

export interface FlowRecoveryAttemptHistoryEntry {
  attempt: number
  timestamp: number
  action: 'session_refresh' | 'bridge_reconnect' | 'health_probe' | 'controlled_reload' | 'reconciliation'
  result: string
}

export interface FlowRecoveryProbeHistoryEntry {
  timestamp: number
  overall: FlowHealthProbeResult['overall']
}

export interface FlowRecoverySnapshot {
  state: FlowRecoveryState
  incidentId?: string
  errorCode?: FlowErrorCode
  failureCount: number
  recoveryAttemptCount: number
  firstFailureAt?: number
  lastFailureAt?: number
  cooldownStartedAt?: number
  blockedUntil?: number
  recoveryStartedAt?: number
  recoveryCompletedAt?: number
  lastProbeAt?: number
  lastProbeResult?: FlowHealthProbeResult
  sessionRefreshAttempted: boolean
  sessionRefreshSucceeded?: boolean
  userInterventionRequired: boolean
  persistenceVersion: number
  persistenceError?: string
  triggeringJobId?: string
  triggeringTabId?: number
  triggeringEvidence?: FlowErrorEvidence[]
  startedAt?: number
  stateHistory: FlowRecoveryStateHistoryEntry[]
  recoveryAttemptHistory: FlowRecoveryAttemptHistoryEntry[]
  probeHistory: FlowRecoveryProbeHistoryEntry[]
  terminalDecision?: string
  reloadCount: number
  lastSessionRefreshAt?: number
  recentIncidentStartedAt: number[]
  capturedAt: number
}

export interface FlowRecoveryAdmissionDecision {
  allowed: boolean
  state: FlowRecoveryState
  statusReason: string
  errorCode?: FlowErrorCode
  blockedUntil?: number
  snapshot?: FlowRecoverySnapshot
}

export type FlowReconciliationResult =
  | { status: 'job_found_active'; reason: string }
  | { status: 'job_found_terminal'; reason: string }
  | { status: 'no_evidence'; reason: string }
  | { status: 'ambiguous'; reason: string }

export type FlowWaitCondition =
  | 'manual'
  | 'provider-idle'
  | 'flow-cooldown-ended'
  | 'selector-exists'
  | 'selector-disappears'
  | 'dom-change'

export interface FlowWaitResult {
  success: boolean
  condition: FlowWaitCondition
  startedAt: number
  completedAt: number
  elapsedMs: number
  timedOut: boolean
  cancelled: boolean
  statusReason: string
  evidence: FlowErrorEvidence[]
}

export interface FlowTileIdentity {
  id?: string
  fileName?: string
  mediaUrl?: string
  firstSeenAt: number
  firstSeenState: string
  observedProcessing: boolean
  domFingerprint?: string
}
