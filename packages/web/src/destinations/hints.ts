/**
 * Phase 3d-3b D2: what an address will need, said while it is typed — a private address works only
 * inside MM_BACKUP_PRIVATE_NETWORKS, and plain http is not encrypted. The server decides; this only warns.
 */
export function addressHints(address: string, t: (key: string) => string): string | undefined {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return undefined
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const notes: string[] = []
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host)
  const a = m ? Number(m[1]) : -1
  const b = m ? Number(m[2]) : -1
  const privateV4 = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  if (privateV4 || host === 'localhost' || host.endsWith('.local') || /^f[cd]/i.test(host))
    notes.push(t('destinations.editor.privateHint'))
  if (url.protocol === 'http:') notes.push(t('destinations.editor.httpHint'))
  return notes.length ? notes.join(' ') : undefined
}
