// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * A release version: plain x.y.z, each part at most 9 digits (no prerelease, no "v"), and no
 * leading zero, so a version has one name only (final review, minor).
 */
export function parseReleaseVersion(text: string): [number, number, number] | null {
  const m = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Numeric x.y.z order; throws on a version it cannot read. */
export function compareReleaseVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parseReleaseVersion(a)
  const y = parseReleaseVersion(b)
  if (!x || !y) throw new Error(`Not a release version: ${JSON.stringify(x ? b : a)}`)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]! ? 1 : -1
  return 0
}
