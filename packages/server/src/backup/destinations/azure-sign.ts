import { createHmac } from 'node:crypto'

/** W4.5: the Blob service version every request asks for (the Cold tier needs 2021-12-02 or later). */
export const AZURE_VERSION = '2023-11-03'

/** The standard headers Shared Key signs, in their order (Date is empty: x-ms-date is sent). */
const SIGNED = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-md5',
  'content-type',
  'date',
  'if-modified-since',
  'if-match',
  'if-none-match',
  'if-unmodified-since',
  'range',
] as const

/**
 * W4.5: Azure Storage Shared Key authorization (the Blob service's string to sign, 2015-02-21 and
 * later): the verb, the standard headers (a zero Content-Length signs as empty), the x-ms-* headers
 * sorted, then "/<account><path>" and each query field (lowercased name, decoded values) sorted.
 * `headers` must hold every header sent, with lowercase names.
 */
export function stringToSign(method: string, url: URL, headers: Record<string, string>, account: string) {
  const std = SIGNED.map((h) => {
    const v = headers[h] ?? ''
    return h === 'content-length' && v === '0' ? '' : v
  })
  const ms = Object.keys(headers)
    .filter((h) => h.startsWith('x-ms-'))
    .sort()
    .map((h) => `${h}:${headers[h]!.replace(/\s+/g, ' ').trim()}\n`)
    .join('')
  const query = new Map<string, string[]>()
  for (const [k, v] of url.searchParams) {
    const name = k.toLowerCase()
    query.set(name, [...(query.get(name) ?? []), v])
  }
  const resource =
    `/${account}${url.pathname}` +
    [...query.keys()]
      .sort()
      .map((k) => `\n${k}:${query.get(k)!.sort().join(',')}`)
      .join('')
  return `${method.toUpperCase()}\n${std.join('\n')}\n${ms}${resource}`
}

export function sharedKeyAuthorization(
  method: string,
  url: URL,
  headers: Record<string, string>,
  account: string,
  key: Buffer,
): string {
  const sig = createHmac('sha256', key)
    .update(stringToSign(method, url, headers, account), 'utf8')
    .digest('base64')
  return `SharedKey ${account}:${sig}`
}
