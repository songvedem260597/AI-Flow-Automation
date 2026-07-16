import type {
  FlowAdmissionSnapshot,
  FlowEvidenceConfidence,
  FlowHealthProbeResult,
} from '../../types/flow.ts'

export interface FlowSafeOperationResult {
  success: boolean
  reason: string
  supported?: boolean
}

export interface FlowSessionRefreshRequest {
  incidentId: string
  tabId: number
  confidence: FlowEvidenceConfidence
  allowControlledReload: boolean
  signal?: AbortSignal
}

export interface FlowSessionRefreshResult {
  success: boolean
  reason: string
  probe?: FlowHealthProbeResult
  reloadCount: number
}

export interface FlowSessionRefresherOptions {
  getAdmissionSnapshot(): Promise<FlowAdmissionSnapshot>
  revalidateSession(tabId: number, signal?: AbortSignal): Promise<FlowSafeOperationResult>
  reconnectBridge(tabId: number, signal?: AbortSignal): Promise<FlowSafeOperationResult>
  probeHealth(tabId: number, signal?: AbortSignal): Promise<FlowHealthProbeResult>
  controlledReload(tabId: number, signal?: AbortSignal): Promise<FlowSafeOperationResult>
  maxReloadsPerIncident?: number
}

export class FlowSessionRefresher {
  private readonly options: FlowSessionRefresherOptions

  constructor(options: FlowSessionRefresherOptions) {
    this.options = options
  }

  async refresh(request: FlowSessionRefreshRequest): Promise<FlowSessionRefreshResult> {
    const admission = await this.options.getAdmissionSnapshot()
    if (admission.state === 'submit_uncertain') {
      return { success: false, reason: 'submit_uncertain_prevents_refresh', reloadCount: 0 }
    }
    if (admission.state === 'in_flight') {
      return { success: false, reason: 'active_flow_job_prevents_refresh', reloadCount: 0 }
    }
    if (request.signal?.aborted) {
      return { success: false, reason: String(request.signal.reason || 'session_refresh_aborted'), reloadCount: 0 }
    }

    await this.options.revalidateSession(request.tabId, request.signal)
    await this.options.reconnectBridge(request.tabId, request.signal)
    let probe = await this.options.probeHealth(request.tabId, request.signal)
    if (probe.overall === 'healthy') {
      return { success: true, reason: 'session_refresh_health_probe_healthy', probe, reloadCount: 0 }
    }

    const maxReloads = this.options.maxReloadsPerIncident ?? 1
    const mayReload = request.allowControlledReload && request.confidence === 'high' && maxReloads > 0
    if (!mayReload) {
      return { success: false, reason: 'session_refresh_probe_not_healthy', probe, reloadCount: 0 }
    }

    // Re-read admission immediately before the visible reload fallback. A job
    // may have acquired ownership while the read-only revalidation was running.
    const beforeReload = await this.options.getAdmissionSnapshot()
    if (beforeReload.state === 'submit_uncertain') {
      return { success: false, reason: 'submit_uncertain_prevents_reload', probe, reloadCount: 0 }
    }
    if (beforeReload.state === 'in_flight') {
      return { success: false, reason: 'active_flow_job_prevents_reload', probe, reloadCount: 0 }
    }

    const reload = await this.options.controlledReload(request.tabId, request.signal)
    if (!reload.success) {
      return { success: false, reason: reload.reason || 'controlled_reload_failed', probe, reloadCount: 1 }
    }
    await this.options.reconnectBridge(request.tabId, request.signal)
    probe = await this.options.probeHealth(request.tabId, request.signal)
    return {
      success: probe.overall === 'healthy',
      reason: probe.overall === 'healthy' ? 'controlled_reload_probe_healthy' : 'controlled_reload_probe_not_healthy',
      probe,
      reloadCount: 1,
    }
  }
}
