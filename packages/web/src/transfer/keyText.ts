/**
 * Seventeenth review of explain masking (M-4): the key fields typed in a copy or a restore, and the
 * first the server would refuse (a part starting with "$" is an operator there; "[n]" is not a key's
 * syntax; at most 32 parts), so the form says it before anything is sent.
 */
export const keysOf = (text: string): string[] =>
  text
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

export function badKeyIn(text: string): string | undefined {
  return keysOf(text).find((k) => {
    const parts = k.split('.')
    return (
      k.includes('[') ||
      k.includes('\0') ||
      k.length > 1024 ||
      parts.length > 32 ||
      parts.some((p) => p === '' || p.startsWith('$'))
    )
  })
}

/** Nineteenth review of explain masking (M-3): a key mode with no key field at all. */
export const noKeyIn = (text: string): boolean => keysOf(text).length === 0

/** At most 32 keys name a document (the server's limit). */
export const MAX_KEYS = 32

/** What the key field says, if anything: no key, or the first one refused. */
export function keyError(
  text: string,
  t: (key: string, values?: Record<string, unknown>) => string,
): string | undefined {
  if (noKeyIn(text)) return t('dataTransfer.noKey')
  if (keysOf(text).length > MAX_KEYS) return t('dataTransfer.tooManyKeys', { max: MAX_KEYS })
  const bad = badKeyIn(text)
  return bad === undefined ? undefined : t('dataTransfer.badKey', { key: bad.slice(0, 200) })
}
