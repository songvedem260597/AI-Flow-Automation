export type ProviderWaitTarget = 'google-flow' | 'chatgpt'

const normalizeWaitProvider = (value: unknown): ProviderWaitTarget | null => {
  const provider = String(value || '').trim().toLocaleLowerCase().replace('_', '-')
  if (provider === 'chatgpt') return 'chatgpt'
  if (provider === 'google-flow' || provider === 'flow') return 'google-flow'
  return null
}

export function resolveProviderWaitTarget(
  configuredProvider: unknown,
  upstreamValues: unknown[],
): ProviderWaitTarget {
  const configured = normalizeWaitProvider(configuredProvider)
  if (configured) return configured

  for (let index = upstreamValues.length - 1; index >= 0; index--) {
    const value = upstreamValues[index]
    if (!value || typeof value !== 'object') continue
    const provider = normalizeWaitProvider((value as Record<string, unknown>).provider)
    if (provider) return provider
  }
  return 'google-flow'
}

export function collectChatGPTWaitJobIds(upstreamValues: unknown[]): string[] {
  const jobIds = new Set<string>()
  for (const value of upstreamValues) {
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    if (normalizeWaitProvider(record.provider) !== 'chatgpt') continue
    const jobId = String(record.jobId || '').trim()
    if (jobId) jobIds.add(jobId)
  }
  return [...jobIds]
}

export function isChatGPTJobIdle(status: unknown): boolean {
  return status === 'done' || status === 'failed'
}
