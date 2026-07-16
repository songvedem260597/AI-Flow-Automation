export function isGoogleFlowUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:' || url.hostname !== 'labs.google') return false
    return /^\/fx(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/tools\/flow(?:\/|$)/i.test(url.pathname)
  } catch {
    return false
  }
}
