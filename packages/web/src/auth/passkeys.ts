// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * WebAuthn only works in a secure context on a domain name: browsers reject IP addresses as the
 * relying party, even over HTTPS. Offering the button there would only produce a SecurityError.
 */
export function passkeysAvailable(env: Window = window): boolean {
  if (!('PublicKeyCredential' in env) || env.isSecureContext !== true) return false
  const host = env.location.hostname
  return !(IPV4.test(host) || host.includes(':') || host.startsWith('['))
}

/** Maps a WebAuthn ceremony failure to a message key; the user cancelling is not an error. */
export function passkeyErrorKey(e: unknown): string {
  const err = e as { name?: unknown; code?: unknown }
  return err.name === 'NotAllowedError' || err.name === 'AbortError' || err.code === 'ERROR_CEREMONY_ABORTED'
    ? 'login.passkeyCancelled'
    : 'login.passkeyFailed'
}
