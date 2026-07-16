import type { FlowReconciliationResult } from '../../types/flow.ts'

export interface SubmitUncertainEvidence {
  jobId: string
  observedJobId?: string
  observedProcessing?: boolean
  terminalResultObserved?: boolean
  activeGenerationCount: number
}

export function reconcileSubmitUncertain(evidence: SubmitUncertainEvidence): FlowReconciliationResult {
  const identityMatches = !!evidence.observedJobId && evidence.observedJobId === evidence.jobId
  if (identityMatches && evidence.terminalResultObserved) {
    return { status: 'job_found_terminal', reason: 'matching_terminal_job_evidence' }
  }
  if (identityMatches && evidence.observedProcessing) {
    return { status: 'job_found_active', reason: 'matching_processing_job_evidence' }
  }
  if (evidence.activeGenerationCount > 0) {
    return { status: 'ambiguous', reason: 'provider_active_without_matching_job_identity' }
  }
  return { status: 'no_evidence', reason: 'no_matching_job_evidence' }
}
