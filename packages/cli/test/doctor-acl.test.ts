// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { powershellEnv, resolveConfig } from '@mongo-manager/server'
import { main } from '../src/main'
import { openData } from '../src/data'
import { cleanTempDirs, fakeIo, tempDir } from './support'

afterEach(cleanTempDirs)

async function run(argv: string[], env: Record<string, string> = {}) {
  const io = fakeIo({ env })
  return { code: await main(argv, io), io }
}

/**
 * What doctor says of who may read the data directory, its files and the log file, against real
 * ACLs on Windows (review of the ACL reads, fourth review, minor: apart from admin.test.ts, which
 * fetches the MongoDB tools, so the Windows job runs these).
 */
describe('doctor on who may read what it keeps', () => {
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
  /** Runs the icacls command doctor gave for `path`, as Command Prompt would (second review, important). */
  const follow = (out: string, path: string) => {
    const line = out.split('\n').find((l) => l.startsWith('[warn]') && l.includes(`icacls "${path}"`))!
    const words = line.slice(line.indexOf(`icacls "${path}"`)).match(/"[^"]*"|\S+/g)!
    const args = words
      .slice(1)
      .map((w) => w.replace(/^"|"$/g, '').replace('%USERNAME%', process.env.USERNAME!))
    execFileSync(icacls, args)
  }

  // Review of the ACL reads (minor 2): on Windows a grant the data directory passes only to what it
  // holds, (OI)(CI)(IO), lets every user read each new file, and a file in it may be open on its own.
  it.runIf(process.platform === 'win32')(
    'warns when the data directory passes every user’s reading on, or a file in it is open',
    async () => {
      const dir = tempDir()
      await (await openData(resolveConfig({ cli: { dataDir: dir } }))).close()
      const key = join(dir, 'secret.key')
      const doctorSays = async () => (await run(['doctor', '--data-dir', dir])).io.out()
      const quiet = await doctorSays()
      expect(quiet).toContain(`[ok] Data directory ${dir}\n`)
      expect(quiet).not.toMatch(/readable by all users/)

      // Passed on to what it holds: the directory says so, its files, which have it from there, not.
      execFileSync(icacls, [dir, '/grant', '*S-1-1-0:(OI)(CI)(IO)R'])
      const passed = await doctorSays()
      expect(passed).toContain(`[warn] Data directory ${dir} is readable by all users of this computer;`)
      expect(passed.match(/readable by all users/g)).toHaveLength(1)
      follow(passed, dir)
      expect(await doctorSays()).toContain(`[ok] Data directory ${dir}\n`)

      // A file's own grant.
      execFileSync(icacls, [key, '/grant', '*S-1-5-32-545:R'])
      const open = await doctorSays()
      expect(open).toContain(`[ok] Data directory ${dir}\n`)
      expect(open).toContain(
        `[warn] ${key} is readable by all users of this computer; restrict it in Command Prompt with: ` +
          `icacls "${key}" /inheritance:r /remove:g *S-1-1-0 *S-1-5-32-545 *S-1-5-11 *S-1-5-4 ` +
          '/grant:r *S-1-5-18:F *S-1-5-32-544:F "%USERNAME%:F"',
      )
      follow(open, key)
      expect(await doctorSays()).not.toMatch(/readable by all users/)
    },
    120_000,
  )

  // Third review of the ACL reads (important): the service's data directory keeps the write access
  // its install gave LocalService when the broad grants go.
  it.runIf(process.platform === 'win32')(
    'takes only the broad grants from the service’s data directory, which its account still writes',
    async () => {
      const programData = tempDir()
      const dir = join(programData, 'Mongo Manager', 'data')
      mkdirSync(dir, { recursive: true })
      await (await openData(resolveConfig({ cli: { dataDir: dir } }))).close()
      const db = join(dir, 'mongo-manager.db')
      execFileSync(icacls, [dir, '/grant', '*S-1-5-19:(OI)(CI)M', '*S-1-1-0:(OI)(CI)R'])
      const doctorSays = async () =>
        (await run(['doctor', '--data-dir', dir], { ProgramData: programData })).io.out()
      const open = await doctorSays()
      expect(open).toContain(`[warn] Data directory ${dir} is readable by all users of this computer;`)
      follow(open, dir)
      expect(await doctorSays()).not.toMatch(/readable by all users/)
      const rights = execFileSync(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "(Get-Acl -LiteralPath $env:MM_PROBE).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-19' } | ForEach-Object { $_.FileSystemRights.ToString() }",
        ],
        // Review of the ACL reads (fourth review, minor): not PowerShell 7's modules.
        { encoding: 'utf8', env: powershellEnv({ MM_PROBE: db }) },
      )
      expect(rights).toMatch(/Modify/)
    },
    120_000,
  )

  // Review of the CI fixes (doctor): the start leaves an existing log file it did not make as it is
  // (an older version's, open to everyone), so doctor says so.
  it('warns when the log file is readable by every user, and not when it is private', async () => {
    const dir = tempDir()
    const openUp = (file: string) => {
      writeFileSync(file, 'line\n')
      if (process.platform === 'win32') execFileSync(icacls, [file, '/grant', '*S-1-5-32-545:R'])
      else chmodSync(file, 0o644)
    }
    const logFile = join(dir, 'mm.log')
    openUp(logFile)
    const open = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', logFile])
    expect(open.io.out()).toContain(
      process.platform === 'win32'
        ? `[warn] Log file ${logFile} is readable by all users of this computer; restrict it in Command Prompt with: icacls "${logFile}" /inheritance:r /remove:g *S-1-1-0 *S-1-5-32-545 *S-1-5-11 *S-1-5-4 /grant:r *S-1-5-18:F *S-1-5-32-544:F "%USERNAME%:F"`
        : `[warn] Log file ${logFile} is readable by other users (mode 644); run: chmod 600 '${logFile}'`,
    )
    // Second review of the CI fixes (minor 7): the Windows service's own takes its folder's rules.
    if (process.platform === 'win32') {
      const service = join(dir, 'Mongo Manager', 'logs', 'mongo-manager.log')
      mkdirSync(dirname(service), { recursive: true })
      openUp(service)
      const { io } = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', service], {
        ProgramData: dir,
      })
      expect(io.out()).toContain(
        `[warn] Log file ${service} is readable by all users of this computer; restrict it to the service's folder's rules with: icacls "${service}" /reset`,
      )
    }
    const quiet = join(dir, 'private.log')
    writeFileSync(quiet, 'line\n')
    if (process.platform === 'win32')
      execFileSync(icacls, [
        quiet,
        '/inheritance:r',
        '/grant:r',
        '*S-1-5-18:F',
        '*S-1-5-32-544:F',
        `${process.env.USERNAME}:F`,
      ])
    else chmodSync(quiet, 0o600)
    const missing = join(dir, 'missing.log')
    const fine = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', quiet])
    expect(fine.io.out()).toContain(`[ok] Log file ${quiet}\n`)
    const none = await run(['doctor', '--data-dir', join(dir, 'data'), '--log-file', missing])
    expect(none.io.out()).toContain(`[ok] Log file ${missing} (made at the first start)\n`)
    for (const out of [fine.io.out(), none.io.out()]) expect(out).not.toMatch(/\[(warn|fail)\] Log file/)
  })
})
