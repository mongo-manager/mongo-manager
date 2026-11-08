// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Plugin } from 'vite'

/**
 * Phase 3a-1 spec §10.1: keep the CSP at style-src 'self'. xterm creates <style> elements at run
 * time; under a strict style-src the browser blocks them. This plugin rewrites xterm's
 * `<doc>.createElement("style")` calls to `mmXtermStyle(<doc>)`, which routes the styles to a
 * constructable stylesheet (see src/shell/xtermStyle.ts). It fails the build if the number of sites
 * is not exactly what it was written for, so a new xterm version cannot slip past unnoticed.
 */
const EXPECTED_SITES = 3
const STYLE_HELPER = '@/shell/xtermStyle'

export function xtermCsp(): Plugin {
  return {
    name: 'mongo-manager:xterm-csp',
    transform(code, id) {
      if (!/@xterm[/\\]xterm[/\\]lib[/\\]xterm\.(mjs|js)$/.test(id.split('?')[0]!)) return null
      const pattern = /([\w.$]+)\.createElement\((["'])style\2\)/g
      const sites = code.match(pattern)?.length ?? 0
      if (sites !== EXPECTED_SITES) {
        this.error(
          `xterm-csp: expected ${EXPECTED_SITES} createElement("style") sites in xterm, found ${sites}. ` +
            `xterm changed; review it and update EXPECTED_SITES.`,
        )
      }
      const rewritten = code.replace(pattern, (_m, doc: string) => `mmXtermStyle(${doc})`)
      return { code: `import { mmXtermStyle } from ${JSON.stringify(STYLE_HELPER)}\n${rewritten}`, map: null }
    },
  }
}
