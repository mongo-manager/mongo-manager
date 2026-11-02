import { describe, expect, it } from 'vitest'
import { MIN_MONGODB_VERSION, isSupportedMongoVersion, parseMongoVersion } from '../src/mongo-version'

describe('supported MongoDB versions (phase 1h spec §10)', () => {
  it('names 6.0 as the floor', () => {
    expect(MIN_MONGODB_VERSION).toBe('6.0')
  })

  it.each([
    ['4.4.29', false],
    ['5.0.26', false],
    ['5.3.0', false],
    ['6.0.0', true],
    ['6.0.0-rc1', true],
    ['7.0.43', true],
    ['8.3.11', true],
    ['10.0', true],
    [' 7.0.1 ', true],
    ['garbage', false],
    ['', false],
    ['6', false],
    ['v7.0.0', false],
  ])('%j supported: %s', (version, supported) => {
    expect(isSupportedMongoVersion(version)).toBe(supported)
  })

  it('parses major and minor', () => {
    expect(parseMongoVersion('8.3.11')).toEqual({ major: 8, minor: 3 })
    expect(parseMongoVersion('6.0.0-rc1')).toEqual({ major: 6, minor: 0 })
    expect(parseMongoVersion('x.y')).toBeNull()
  })
})
