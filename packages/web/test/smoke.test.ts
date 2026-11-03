import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// happy-dom replaces the global URL, so resolve paths with node:path, not new URL(…, import.meta.url).
const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')

describe('index.html', () => {
  it('has a rewritable base href and no inline scripts or styles (CSP)', () => {
    expect(html).toContain('<base href="/" />')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    expect(html).not.toMatch(/<style/)
    expect(html).not.toMatch(/https?:\/\//)
  })
})
