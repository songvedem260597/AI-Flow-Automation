import type { FlowHealthProbeResult, FlowHealthSignal } from '../../types/flow.ts'

type ProbeInput = {
  checkedAt: number
  tabExists?: boolean | null
  routeValid?: boolean | null
  bridgeReady?: boolean | null
  composerReady?: boolean | null
  loginRequired?: boolean | null
  sessionWarning?: boolean | null
  unusualActivityWarning?: boolean | null
  rateLimitWarning?: boolean | null
  blockingDialog?: boolean | null
  activeGenerationCount?: number | null
}

const positiveRequired = (value: boolean | null | undefined, reason: string): FlowHealthSignal => {
  if (typeof value !== 'boolean') return { status: 'unknown', reason: `${reason}_unknown` }
  return value ? { status: 'pass', value } : { status: 'fail', value, reason }
}

const negativeRequired = (value: boolean | null | undefined, reason: string): FlowHealthSignal => {
  if (typeof value !== 'boolean') return { status: 'unknown', reason: `${reason}_unknown` }
  return value ? { status: 'fail', value, reason } : { status: 'pass', value }
}

const countSignal = (value: number | null | undefined): FlowHealthSignal<number> => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { status: 'unknown', reason: 'active_generation_count_unknown' }
  }
  return { status: 'pass', value }
}

export function createFlowHealthProbeResult(input: ProbeInput): FlowHealthProbeResult {
  const result: FlowHealthProbeResult = {
    checkedAt: input.checkedAt,
    tabExists: positiveRequired(input.tabExists, 'flow_tab_missing'),
    routeValid: positiveRequired(input.routeValid, 'flow_route_invalid'),
    bridgeReady: positiveRequired(input.bridgeReady, 'flow_bridge_unavailable'),
    composerReady: positiveRequired(input.composerReady, 'flow_composer_missing'),
    loginRequired: negativeRequired(input.loginRequired, 'flow_login_required'),
    sessionWarning: negativeRequired(input.sessionWarning, 'flow_session_warning'),
    unusualActivityWarning: negativeRequired(input.unusualActivityWarning, 'flow_unusual_activity_warning'),
    rateLimitWarning: negativeRequired(input.rateLimitWarning, 'flow_rate_limit_warning'),
    blockingDialog: negativeRequired(input.blockingDialog, 'flow_blocking_dialog'),
    activeGenerationCount: countSignal(input.activeGenerationCount),
    overall: 'unknown',
  }

  if (result.unusualActivityWarning.status === 'fail' || result.blockingDialog.status === 'fail') {
    result.overall = 'blocked'
  } else if (result.rateLimitWarning.status === 'fail') {
    result.overall = 'rate_limited'
  } else if (result.loginRequired.status === 'fail' || result.sessionWarning.status === 'fail') {
    result.overall = 'session_suspect'
  } else if ((result.activeGenerationCount.value || 0) > 0) {
    result.overall = 'busy'
  } else {
    const requiredSignals = [
      result.tabExists,
      result.routeValid,
      result.bridgeReady,
      result.composerReady,
      result.loginRequired,
      result.sessionWarning,
      result.unusualActivityWarning,
      result.rateLimitWarning,
      result.blockingDialog,
      result.activeGenerationCount,
    ]
    if (requiredSignals.every((signal) => signal.status === 'pass')) result.overall = 'healthy'
    else result.overall = 'unknown'
  }

  return result
}
