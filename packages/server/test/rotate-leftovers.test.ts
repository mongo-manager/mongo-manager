import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROTATION_KEPT_MS, rotateSecretKey, sweepRotationLeftovers } from '../src/crypto/rotate'
import { resolveConfig } from '../src/config'
import { startServer } from '../src/server'

/**
 * Security audit 2026-10-16 (minor): a key rotation leaves the previous key and a database backup
 * sealed with it, which together open every secret as it was. They are kept for a recovery window
 * (seven days) and removed by the first start after it that opens the data with the new key.
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-rot-left-'))
  dirs.push(d)
  return d
}
const DAY = 86_400_000

describe('security audit 2026-10-16: rotation leftovers', () => {
  it('removes those past the recovery window, keeps the newer, and leaves anything else', () => {
    const dir = temp()
    // The sweep's "now" a week and two days ahead: the files just written are old enough by then.
    const now = Date.now() + ROTATION_KEPT_MS + 2 * DAY
    const old = now - ROTATION_KEPT_MS - DAY
    const fresh = now - DAY
    const names = [
      `secret.key.old-${old}`,
      `mongo-manager.db.bak-rotate-${old}`,
      `secret.key.new.discarded-${old}`,
      `secret.key.old-${fresh}`,
      `mongo-manager.db.bak-rotate-${fresh}`,
      'secret.key.old-not-a-time',
      'secret.key',
      'mongo-manager.db',
    ]
    for (const n of names) writeFileSync(join(dir, n), 'x')
    const swept = sweepRotationLeftovers(dir, now)
    expect(swept.removed.sort()).toEqual(names.slice(0, 3).sort())
    expect(swept.kept.sort()).toEqual([names[3], names[4]].sort())
    expect(readdirSync(dir).sort()).toEqual(names.slice(3).sort())
    expect(ROTATION_KEPT_MS).toBe(7 * DAY)
  })

  // Independent review of the security pass (minor): the time in a name alone is not trusted (a clock
  // that jumped, a name made up): the file itself must be as old.
  it('keeps a leftover whose name says old but whose file is new', () => {
    const dir = temp()
    const name = `secret.key.old-${Date.now() - ROTATION_KEPT_MS - 30 * DAY}`
    writeFileSync(join(dir, name), 'x')
    expect(sweepRotationLeftovers(dir, Date.now())).toEqual({ removed: [], kept: [name] })
    expect(readdirSync(dir)).toEqual([name])
  })

  it('a start with the new key past the window removes what the rotation left, and says so', async () => {
    const dir = temp()
    const data = join(dir, 'data')
    const first = await startServer(resolveConfig({ cli: { dataDir: data, webPort: 0 } }))
    await first.close()
    const rotated = await rotateSecretKey({ dataDir: data })
    expect(existsSync(rotated.oldKeyFile!)).toBe(true)
    expect(existsSync(rotated.backupPath)).toBe(true)
    const logFile = join(dir, 'mm.log')
    // The start eight days later: its clock only (the files are as old as they are).
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + ROTATION_KEPT_MS + DAY)
    try {
      const s = await startServer(
        resolveConfig({ cli: { dataDir: data, webPort: 0, logLevel: 'info', logFile } }),
        { logger: true },
      )
      await s.close()
    } finally {
      vi.useRealTimers()
    }
    expect(existsSync(rotated.oldKeyFile!)).toBe(false)
    expect(existsSync(rotated.backupPath)).toBe(false)
    expect(readFileSync(logFile, 'utf8')).toMatch(/key rotation: the previous key and backup were removed/)
  })

  it('a start within the window keeps them and warns how long', async () => {
    const dir = temp()
    const data = join(dir, 'data')
    const first = await startServer(resolveConfig({ cli: { dataDir: data, webPort: 0 } }))
    await first.close()
    const rotated = await rotateSecretKey({ dataDir: data })
    const logFile = join(dir, 'mm.log')
    const s = await startServer(
      resolveConfig({ cli: { dataDir: data, webPort: 0, logLevel: 'info', logFile } }),
      {
        logger: true,
      },
    )
    await s.close()
    expect(existsSync(rotated.oldKeyFile!)).toBe(true)
    expect(readFileSync(logFile, 'utf8')).toMatch(/key rotation: the previous key and backup are kept until/)
  })
})
