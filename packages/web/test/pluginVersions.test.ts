import { describe, expect, it } from 'vitest'
import { compareVersions } from '../src/admin/pluginVersions'

// User request 2026-10-10: a plugin's release notes, newest first.
describe('plugin versions in order', () => {
  it('compares each part as a number', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.3', '1.0.3')).toBe(0)
  })

  it('puts a pre-release before its release, its parts as numbers or text', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0)
  })

  it('puts what is no version first', () => {
    expect(compareVersions('soon', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', 'soon')).toBeGreaterThan(0)
    expect(compareVersions('soon', 'later')).toBe(0)
  })
})
