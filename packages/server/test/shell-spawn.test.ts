// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { workerCommandArgs, workerForkOptions } from '../src/shell/spawn'

describe('worker fork options (phase 3a-1 §3.1)', () => {
  it('drops to an unprivileged uid/gid on a root POSIX server', () => {
    const root = workerForkOptions({ bundlePath: '/w.cjs', platform: 'linux', isRoot: true })
    expect(root.uid).toBe(65534)
    expect(root.gid).toBe(65534)
    const custom = workerForkOptions({
      bundlePath: '/w.cjs',
      platform: 'linux',
      isRoot: true,
      uid: 1001,
      gid: 1001,
    })
    expect(custom.uid).toBe(1001)
    expect(custom.gid).toBe(1001)
  })

  it('does not set uid/gid for a non-root server or on Windows', () => {
    expect(workerForkOptions({ bundlePath: '/w.cjs', platform: 'linux', isRoot: false }).uid).toBeUndefined()
    expect(workerForkOptions({ bundlePath: '/w.cjs', platform: 'win32', isRoot: true }).uid).toBeUndefined()
  })

  // Security audit 2026-10-16 (minor): messages are bounded lines on plain pipes; Node's IPC channel
  // parsed whatever the worker wrote before its size could be checked, so there is none.
  it('always carries the sandbox flags, and plain pipes with no IPC channel', () => {
    const o = workerForkOptions({ bundlePath: '/w.cjs', platform: 'linux', isRoot: false })
    expect(o.execArgv).toContain('--permission')
    expect(o.execArgv).toContain('--disallow-code-generation-from-strings')
    expect(o.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(o.stdio).not.toContain('ipc')
  })

  it('builds the command line fork would for a bundle', () => {
    expect(workerCommandArgs(['--permission'], '/w.cjs', [])).toEqual(['--permission', '/w.cjs'])
  })

  // Review of the CI fix 2026-10-20: a standalone binary takes Node's flags only through
  // --node-options (its execArgvExtension is 'cli'); given as they are, they were its own arguments
  // and the shell never started.
  it('gives a standalone binary the sandbox flags through --node-options, then its subcommand', () => {
    expect(
      workerCommandArgs(['--permission', '--max-old-space-size=256'], '/bin/mm', ['__mm-shell-worker'], {
        sea: true,
      }),
    ).toEqual(['--node-options=--permission --max-old-space-size=256', '__mm-shell-worker'])
    // A flag Node would read otherwise there (split at a space, a quote or backslash taken away)
    // is never given (review of the SEA fix 2026-10-20, minor 1).
    for (const flag of ['--allow-fs-read=/a b', '--allow-fs-read=C:/a"b', '--allow-fs-read=C:\\a'])
      expect(() => workerCommandArgs([flag], '/bin/mm', ['__mm-shell-worker'], { sea: true })).toThrow(
        /would read differently/,
      )
  })
})
