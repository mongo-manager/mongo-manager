// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * User report 2026-11-02: in the Docker image, localhost is Mongo Manager's own container, so a
 * MongoDB on the computer or in another container is refused there (ECONNREFUSED ::1). The form says
 * so and offers host.docker.internal: Docker's name for the computer the container runs on.
 */
export const DOCKER_HOST = 'host.docker.internal'

/**
 * A failure that reached no server: the network or a timeout. A refused sign-in or a TLS error came
 * from a server that answered, so localhost reached one (--network host): no hint then (review of
 * 1.0.1, M4).
 */
export const unreachableKind = (kind: unknown): boolean => kind === 'network' || kind === 'timeout'

const IPV4_LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|0\.0\.0\.0)$/
/** ::ffff:127.x.x.x and ::ffff:0.0.0.0, as the URL parser writes them (review of 1.0.1, M6). */
const MAPPED_LOOPBACK = /^::ffff:(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)$/

/** An IPv6 address as the URL parser writes it (::1 for 0:0:0:0:0:0:0:1), or null for none. */
function canonicalIpv6(address: string): string | null {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1)
  } catch {
    return null
  }
}

/**
 * localhost (localhost. too), 127.x.x.x, 0.0.0.0, and ::1 or an IPv4-mapped one of those however it
 * is written, bracketed or not.
 */
export function isLoopback(host: string): boolean {
  let bare = host
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase()
  // A fully qualified name ends in one dot.
  if (bare.endsWith('.') && !bare.endsWith('..')) bare = bare.slice(0, -1)
  if (bare === 'localhost' || IPV4_LOOPBACK.test(bare)) return true
  if (!bare.includes(':')) return false
  const v6 = canonicalIpv6(bare)
  return v6 !== null && (v6 === '::1' || MAPPED_LOOPBACK.test(v6))
}

/** One `host[:port]` of a connection string, its loopback host written as {@link DOCKER_HOST}. */
function swapHost(entry: string): string {
  const bracketed = /^(\[[^\]]*\])(.*)$/.exec(entry)
  const [host, rest] = bracketed
    ? [bracketed[1]!, bracketed[2]!]
    : entry.includes(':')
      ? [entry.slice(0, entry.lastIndexOf(':')), entry.slice(entry.lastIndexOf(':'))]
      : [entry, '']
  return isLoopback(host) ? DOCKER_HOST + rest : entry
}

/**
 * The connection string with each loopback host written as {@link DOCKER_HOST}. Only its hosts are
 * read: the user and password before `@`, the database and the options after them stay as typed.
 */
export function withDockerHost(uri: string): string {
  const m = /^(\s*(?:mongodb(?:\+srv)?:\/\/)?)([^/?#]*)([\s\S]*)$/i.exec(uri)
  if (!m) return uri
  const [, scheme, authority, tail] = m as unknown as [string, string, string, string]
  const at = authority.lastIndexOf('@')
  const credentials = at >= 0 ? authority.slice(0, at + 1) : ''
  const hosts = authority
    .slice(at + 1)
    .split(',')
    .map(swapHost)
    .join(',')
  return scheme + credentials + hosts + tail
}
