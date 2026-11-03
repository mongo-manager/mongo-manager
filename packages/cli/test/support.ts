import { expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Io } from '../src/io'

export interface FakeIo extends Io {
  out(): string
  err(): string
  opened: string[]
  input: PassThrough & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }
}

/** An Io that records output; `whileRunning` runs while `start` waits for shutdown. */
export function fakeIo(
  opts: {
    tty?: boolean
    env?: Record<string, string>
    whileRunning?: () => Promise<void>
    /** No browser opens (a headless computer). */
    openFails?: boolean
  } = {},
): FakeIo {
  let out = ''
  let err = ''
  const input = new PassThrough() as FakeIo['input']
  if (opts.tty) {
    input.isTTY = true
    input.setRawMode = () => input
  }
  const opened: string[] = []
  return {
    stdout: { write: (s: string) => ((out += s), true), isTTY: opts.tty ?? false },
    stderr: { write: (s: string) => ((err += s), true) },
    stdin: input,
    input,
    env: opts.env ?? {},
    cwd: process.cwd(),
    platform: process.platform,
    openBrowser: async (target) => {
      opened.push(target)
      return !opts.openFails
    },
    waitForShutdown: async () => {
      await opts.whileRunning?.()
    },
    out: () => out,
    err: () => err,
    opened,
  }
}

const dirs: string[] = []
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mm-cli-'))
  dirs.push(d)
  return d
}
export function cleanTempDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const
const LAUNCH_PATH = /^\/launch\/([A-Za-z0-9._-]{1,512})$/

/**
 * The launch link `link` names, rebuilt from checked parts: plain HTTP to a loopback host (the origin
 * of `base`, when given), the `launch/` path and its one-time token, nothing else. A test reads the
 * link from a file or a process's output; this keeps it from sending a request anywhere else.
 */
export function checkedLaunchLink(link: string, base?: string): URL {
  const parsed = new URL(link)
  const host = LOOPBACK_HOSTS.find((h) => h === parsed.hostname)
  const port = Number(parsed.port)
  const token = LAUNCH_PATH.exec(parsed.pathname)?.[1]
  if (
    parsed.protocol !== 'http:' ||
    !host ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !token ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new Error(`not a launch link of a server on this computer: ${link}`)
  const origin = `http://${host}:${port}`
  if (base !== undefined) expect(origin).toBe(new URL(base).origin)
  return new URL(`/launch/${encodeURIComponent(token)}`, origin)
}

/**
 * Opens the launch link a started CLI wrote to `file` as a browser does — the cookie it sets, then
 * the key its page claims — and gives the headers that browser's API calls carry and its CSRF token
 * (CI 2026-10-18: local mode answers only such a browser, security audit 2026-10-16).
 */
export async function openLaunchLink(
  url: string,
  file: string,
): Promise<{ headers: Record<string, string>; csrfToken: string }> {
  const origin = new URL(url).origin
  const link = checkedLaunchLink(/href="([^"]+)"/.exec(readFileSync(file, 'utf8'))![1]!, url)
  const opened = await fetch(link, { redirect: 'manual' })
  const cookie = opened.headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0])
    .join('; ')
  expect(cookie).not.toBe('')
  const claim = await fetch(new URL('api/auth/local/claim', url), {
    method: 'POST',
    headers: { cookie, origin },
  })
  expect(claim.status).toBe(200)
  const headers = { cookie, origin, 'x-mm-local': ((await claim.json()) as { key: string }).key }
  const me = await fetch(new URL('api/auth/me', url), { headers })
  expect(me.status).toBe(200)
  return { headers, csrfToken: ((await me.json()) as { csrfToken: string }).csrfToken }
}

/** Removes the folder a CLI made for its launch link: only such a folder, under the temporary one. */
export function removeLaunchDir(dir: string | undefined): void {
  if (dir && dirname(dir) === tmpdir() && basename(dir).startsWith('mongo-manager-launch-'))
    rmSync(dir, { recursive: true, force: true })
}

const system32 = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
let me: string | undefined
/** Windows: this account's SID (S-1-5-21-… locally, S-1-12-1-… on a machine joined to Entra ID). */
export function mySid(): string {
  me ??= /"(S-1-\d+(?:-\d+)+)"/.exec(
    spawnSync(join(system32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout,
  )?.[1]
  expect(me).toMatch(/^S-1-\d+(?:-\d+)+$/)
  return me!
}

/**
 * Windows: makes this account the owner of `paths`, as it is of what it makes unless it runs
 * elevated. GitHub's Windows runner is elevated, so what a test makes there is Administrators'
 * (CI 2026-10-20); the tests that use this are about what a user's account owns.
 */
export function ownedByMe(...paths: string[]): void {
  for (const p of paths)
    expect(spawnSync(join(system32(), 'icacls.exe'), [p, '/setowner', `*${mySid()}`]).status).toBe(0)
}
