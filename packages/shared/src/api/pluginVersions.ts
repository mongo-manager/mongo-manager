// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Semantic versions in order (user request 2026-10-10: a plugin's release notes, newest first):
 * major, minor, patch as numbers; a pre-release comes before its release, its parts compared as
 * numbers or text. Anything that is no version sorts first.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split('.') ?? null } : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return x ? 1 : y ? -1 : 0
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}
