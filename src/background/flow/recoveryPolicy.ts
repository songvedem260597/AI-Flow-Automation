import type {
  FlowErrorCode,
  FlowEvidenceConfidence,
  FlowRecoverySnapshot,
  FlowRecoveryState,
} from '../../types/flow.ts'

export interface FlowRecoveryContext {
  pageLoading?: boolean
  routeValid?: boolean
  bridgeReady?: boolean
  composerPreviouslyPresent?: boolean
  loginRequired?: boolean
  sessionWarning?: boolean
  sessionEvidenceConfidence?: FlowEvidenceConfidence
  admissionState?: string
}

export interface FlowRecoveryPolicyInput {
  errorCode: FlowErrorCode
  context?: FlowRecoveryContext
}

export type FlowRecoveryAction =
  | 'ignore'
  | 'cooldown'
  | 'session_refresh'
  | 'bridge_reconnect'
  | 'probe'
  | 'reconcile'
  | 'user_action'

export interface FlowRecoveryPolicyDecision {
  createIncident: boolean
  initialState: FlowRecoveryState
  action: FlowRecoveryAction
  reason: string
  userInterventionRequired: boolean
  allowControlledReload: boolean
  sessionEvidenceConfidence: FlowEvidenceConfidence
}

const decision = (
  initialState: FlowRecoveryState,
  action: FlowRecoveryAction,
  reason: string,
  options: Partial<FlowRecoveryPolicyDecision> = {},
): FlowRecoveryPolicyDecision => ({
  createIncident: options.createIncident ?? true,
  initialState,
  action,
  reason,
  userInterventionRequired: options.userInterventionRequired ?? false,
  allowControlledReload: options.allowControlledReload ?? false,
  sessionEvidenceConfidence: options.sessionEvidenceConfidence || 'low',
})

export function classifyFlowRecoveryPolicy(input: FlowRecoveryPolicyInput): FlowRecoveryPolicyDecision {
  const context = input.context || {}
  switch (input.errorCode) {
    case 'flow_busy':
    case 'download_failed':
    case 'cancelled':
      return decision('healthy', 'ignore', `${input.errorCode}_not_recovery_incident`, { createIncident: false })
    case 'session_expired':
      return decision('session_suspect', 'session_refresh', 'explicit_session_expired', {
        allowControlledReload: true,
        sessionEvidenceConfidence: 'high',
      })
    case 'rate_limited':
      return decision('rate_limited', 'cooldown', 'rate_limit_cooldown')
    case 'unusual_activity':
      return decision('blocked', 'user_action', 'unusual_activity_requires_user_review', { userInterventionRequired: true })
    case 'generation_failed':
      if ((context.loginRequired || context.sessionWarning) && context.sessionEvidenceConfidence === 'high') {
        return decision('session_suspect', 'session_refresh', 'generation_failed_with_high_session_evidence', {
          allowControlledReload: true,
          sessionEvidenceConfidence: 'high',
        })
      }
      return decision('transient_failure', 'cooldown', 'generation_failed_without_session_evidence')
    case 'generation_timeout':
      if (context.admissionState === 'in_flight' || context.admissionState === 'submit_uncertain') {
        return decision('blocked', 'reconcile', 'generation_timeout_requires_job_reconciliation', { userInterventionRequired: true })
      }
      return decision('transient_failure', 'probe', 'generation_timeout_health_probe_only')
    case 'submit_uncertain':
      return decision('blocked', 'reconcile', 'submit_uncertain_requires_reconciliation', { userInterventionRequired: true })
    case 'bridge_unavailable':
      return decision('transient_failure', 'bridge_reconnect', 'bridge_reconnect_before_reload')
    case 'composer_missing':
      if (context.pageLoading || context.routeValid === false) {
        return decision('transient_failure', 'cooldown', 'composer_missing_while_route_loading')
      }
      if ((context.loginRequired || context.sessionWarning) && context.sessionEvidenceConfidence === 'high') {
        return decision('session_suspect', 'session_refresh', 'composer_missing_with_high_session_evidence', {
          allowControlledReload: true,
          sessionEvidenceConfidence: 'high',
        })
      }
      if (context.bridgeReady === false) {
        return decision('transient_failure', 'bridge_reconnect', 'composer_missing_with_bridge_unavailable')
      }
      return decision('blocked', 'user_action', 'composer_missing_dom_stable_unknown', { userInterventionRequired: true })
    case 'unknown':
    default:
      return decision('blocked', 'user_action', 'unknown_flow_failure_requires_user_review', { userInterventionRequired: true })
  }
}

export function isManualSessionRecoveryAllowed(
  snapshot: Pick<FlowRecoverySnapshot, 'state' | 'errorCode' | 'sessionRefreshAttempted'>,
): boolean {
  return snapshot.state === 'session_suspect'
    && snapshot.errorCode === 'session_expired'
    && snapshot.sessionRefreshAttempted === false
}
