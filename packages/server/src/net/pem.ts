// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { rootCertificates } from 'node:tls'

/**
 * Pasted PEM often loses the newline between blocks ("-----END X----------BEGIN Y"); restore it.
 * OpenSSL refuses such a file ("bad end line"), and stops at the first such line of a CA bundle, so
 * none of it is trusted (second review 2026-10-17: not only the first CA). Everything that reads a
 * pasted PEM — the driver, the database tools, a KMIP socket, a destination, the mail server — gets
 * it mended the same way.
 */
export function normalizePem(pem: string): string {
  return pem.trim().replace(/(-----END [^-]+-----)\s*(?=-----BEGIN )/g, '$1\n')
}

/** A pasted PEM, mended; undefined when it is missing or only white space (nothing to use). */
export function pastedPem(pem: string | undefined): string | undefined {
  const mended = pem === undefined ? '' : normalizePem(pem)
  return mended === '' ? undefined : mended
}

/** The CAs Node trusts and a pasted one (or a bundle), mended; undefined when none was pasted. */
export function trustedCa(caPem: string | undefined): string[] | undefined {
  const ca = pastedPem(caPem)
  return ca === undefined ? undefined : [...rootCertificates, ca]
}
