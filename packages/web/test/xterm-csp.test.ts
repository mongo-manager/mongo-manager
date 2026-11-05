// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { xtermCsp } from '../vite/xterm-csp'

/** Phase 3a-1 spec §10.1: the plugin rewrites xterm's runtime style creation so the CSP stays strict. */
function transform(code: string, id: string): { code: string } | null {
  const plugin = xtermCsp()
  const ctx = {
    error: (m: string) => {
      throw new Error(m)
    },
  }
  const fn = plugin.transform as (this: typeof ctx, code: string, id: string) => { code: string } | null
  return fn.call(ctx, code, id)
}

const XTERM_ID = '/x/node_modules/@xterm/xterm/lib/xterm.mjs'

describe('xterm CSP plugin', () => {
  it('rewrites exactly the expected createElement("style") sites and imports the helper', () => {
    const code =
      'a=n.mainDocument.createElement("style");b=this._document.createElement(\'style\');c=x.createElement("style")'
    const out = transform(code, XTERM_ID)!
    expect(out.code).toContain('import { mmXtermStyle }')
    expect(out.code).toContain('mmXtermStyle(n.mainDocument)')
    expect(out.code).toContain('mmXtermStyle(this._document)')
    expect(out.code).not.toContain('createElement("style")')
  })

  it('fails the build when the number of sites changed', () => {
    const twoSites = 'a=d.createElement("style");b=d.createElement("style")'
    expect(() => transform(twoSites, XTERM_ID)).toThrow(/expected 3/)
  })

  it('ignores modules other than xterm', () => {
    expect(transform('d.createElement("style")', '/x/src/app.ts')).toBeNull()
  })
})
