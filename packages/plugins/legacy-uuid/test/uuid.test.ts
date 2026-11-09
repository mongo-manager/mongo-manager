// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { filterFor, formatUuid, parseUuid, readings, reorder, shellOf, stored, uuidBytes } from '../src/uuid'

// The UUID the drivers' own documentation uses, and what each driver stored for it (uuidhelpers.js).
const UUID = '00112233-4455-6677-8899-aabbccddeeff'
const JAVA = 'd2ZVRDMiEQD/7t3Mu6qZiA=='
const CSHARP = 'MyIRAFVEd2aImaq7zN3u/w=='
const PYTHON = 'ABEiM0RVZneImaq7zN3u/w=='
const bytes = () => parseUuid(UUID)!

describe('a UUID as people write it', () => {
  it('reads dashes or none, braces, UUID("…"), and any case; nothing else', () => {
    for (const text of [
      UUID,
      UUID.toUpperCase(),
      UUID.replace(/-/g, ''),
      `{${UUID}}`,
      `UUID("${UUID}")`,
      `new UUID('${UUID}')`,
      `  ${UUID}  `,
    ])
      expect(formatUuid(parseUuid(text)!), text).toBe(UUID)
    for (const text of [
      '',
      'not a uuid',
      UUID.slice(1),
      `${UUID}0`,
      '0011-2233-4455-6677-8899aabbccddeeff',
      'g'.repeat(32),
    ])
      expect(parseUuid(text), text).toBeNull()
  })
})

describe("each driver's byte order", () => {
  it('stores the UUID as the Java, C# and Python drivers did, and as the standard subtype', () => {
    expect(stored(bytes(), 'java')).toEqual({ $binary: { base64: JAVA, subType: '03' } })
    expect(stored(bytes(), 'csharp')).toEqual({ $binary: { base64: CSHARP, subType: '03' } })
    expect(stored(bytes(), 'python')).toEqual({ $binary: { base64: PYTHON, subType: '03' } })
    expect(stored(bytes(), 'standard')).toEqual({ $binary: { base64: PYTHON, subType: '04' } })
  })

  it('reads a legacy value back as the UUID in the order of the driver that stored it', () => {
    const java = uuidBytes({ $binary: { base64: JAVA, subType: '03' } })!
    expect(java.legacy).toBe(true)
    expect(readings(java.bytes).java).toBe(UUID)
    expect(readings(uuidBytes({ $binary: { base64: CSHARP, subType: '03' } })!.bytes).csharp).toBe(UUID)
    expect(readings(uuidBytes({ $binary: { base64: PYTHON, subType: '03' } })!.bytes).python).toBe(UUID)
    // The same bytes read in another order are another UUID.
    expect(readings(java.bytes).python).toBe('77665544-3322-1100-ffee-ddccbbaa9988')
  })

  it('is its own inverse', () => {
    for (const e of ['java', 'csharp', 'python', 'standard'] as const)
      expect(formatUuid(reorder(reorder(bytes(), e), e))).toBe(UUID)
  })

  it('writes the value as the shell does', () => {
    expect(shellOf(bytes(), 'java')).toBe(`BinData(3, "${JAVA}")`)
    expect(shellOf(bytes(), 'standard')).toBe(`UUID("${UUID}")`)
  })
})

describe('a filter for a UUID', () => {
  it('finds the value one driver stored, or the value of any of them', () => {
    expect(filterFor('customerId', bytes(), 'csharp')).toEqual({
      customerId: { $binary: { base64: CSHARP, subType: '03' } },
    })
    expect(filterFor('a.b', bytes(), 'any')).toEqual({
      'a.b': {
        $in: [
          { $binary: { base64: PYTHON, subType: '04' } },
          { $binary: { base64: JAVA, subType: '03' } },
          { $binary: { base64: CSHARP, subType: '03' } },
          { $binary: { base64: PYTHON, subType: '03' } },
        ],
      },
    })
  })
})

describe('a value that may hold a UUID', () => {
  it('is 16 bytes of subtype 3 or 4, as a value or as the head a renderer is sent', () => {
    expect(uuidBytes({ $binaryHead: { base64: JAVA, subType: '03', length: 16 } })?.legacy).toBe(true)
    expect(uuidBytes({ $binary: { base64: PYTHON, subType: '04' } })?.legacy).toBe(false)
    // Another subtype, another length (a head of a longer value), not binary at all.
    expect(uuidBytes({ $binary: { base64: JAVA, subType: '00' } })).toBeNull()
    expect(uuidBytes({ $binaryHead: { base64: JAVA, subType: '03', length: 32 } })).toBeNull()
    expect(uuidBytes({ $binary: { base64: 'AAAA', subType: '03' } })).toBeNull()
    expect(uuidBytes({ $binary: { base64: '***', subType: '03' } })).toBeNull()
    expect(uuidBytes('x')).toBeNull()
    expect(uuidBytes(null)).toBeNull()
  })
})
