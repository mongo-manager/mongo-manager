import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ZodType } from 'zod'
import { ConfigError, resolveConfig } from '../src/config'
import { EgressError } from '../src/net/egress'
import { UpdateService, type UpdateServiceDeps } from '../src/updates/service'
import { API_LATEST, fakeGithub, signedRelease, testKey, type Answer } from './support/updates'

const key = testKey()
let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mm-upd-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dataDir, { recursive: true, force: true })
})

/** Settings in memory, read through their schema as the repository reads them. */
function memorySettings() {
  const map = new Map<string, unknown>()
  return {
    map,
    get<T>(k: string, schema: ZodType<T>, fallback: T): T {
      if (!map.has(k)) return fallback
      const r = schema.safeParse(map.get(k))
      return r.success ? r.data : fallback
    },
    set<T>(k: string, v: T) {
      map.set(k, JSON.parse(JSON.stringify(v)))
    },
  }
}

const bundleOrigin = {
  distribution: 'bundle' as const,
  bundledVersion: '1.2.0',
  installDir: '/opt/x/dist',
  target: null,
  isolate: false,
}

function service(answers: Record<string, Answer>, over: Partial<UpdateServiceDeps> = {}) {
  const github = fakeGithub(answers)
  const settings = memorySettings()
  const s = new UpdateService({
    settings,
    egress: github.egress,
    enabled: true,
    keys: [key.pub],
    now: () => Date.now(),
    dataDir,
    installed: '1.2.0',
    origin: bundleOrigin,
    fallbackDistribution: 'npm',
    env: {},
    nodeVersion: '24.0.0',
    ...over,
  })
  return { s, github, settings }
}

describe('the check (spec §4)', () => {
  it('finds a newer signed release and offers to install it', async () => {
    const { s } = service(signedRelease(key, '1.3.0').answers)
    const st = await s.check()
    expect(st.lastCheck).toMatchObject({ outcome: 'available' })
    expect(st.latest).toMatchObject({
      version: '1.3.0',
      publishedAt: '2026-11-03T10:00:00Z',
      url: 'https://github.com/mongo-manager/mongo-manager/releases/tag/v1.3.0',
    })
    expect(st.latest!.notes).toContain('Updates from the panel')
    expect(st.offer).toBe('install')
  })

  it('says it is up to date on the same version', async () => {
    const { s } = service(signedRelease(key, '1.2.0').answers)
    const st = await s.check()
    expect(st.lastCheck).toMatchObject({ outcome: 'current' })
    expect(st.offer).toBeNull()
  })

  it('never offers a draft, a prerelease or a tag that is not vX.Y.Z', async () => {
    for (const opts of [{ draft: true }, { prerelease: true }, { tag: 'v1.3.0-rc.1' }]) {
      const { s } = service(signedRelease(key, '1.3.0', opts).answers)
      const st = await s.check()
      expect(st.lastCheck, JSON.stringify(opts)).toMatchObject({ outcome: 'failed', reason: 'bad_answer' })
      expect(st.latest).toBeNull()
      expect(st.offer).toBeNull()
    }
  })

  it('refuses a release whose page is another repository’s', async () => {
    const r = signedRelease(key, '1.3.0')
    const answers = {
      ...r.answers,
      [API_LATEST]: {
        status: 200,
        body: { ...r.latest, html_url: 'https://github.com/someone/fork/releases/tag/v1.3.0' },
      },
    }
    const st = await service(answers).s.check()
    expect(st.lastCheck).toMatchObject({ reason: 'bad_answer' })
  })

  it('offers nothing a release key did not sign', async () => {
    const st = await service(signedRelease(key, '1.3.0', { signer: testKey() }).answers).s.check()
    expect(st.lastCheck).toMatchObject({ outcome: 'failed', reason: 'signature' })
    expect(st.latest).toBeNull()
    const none = await service(signedRelease(key, '1.3.0', { without: ['SHA256SUMS.sig'] }).answers).s.check()
    expect(none.lastCheck).toMatchObject({ reason: 'no_asset' })
  })

  it('names GitHub’s rate limit and when it lifts; an unreachable GitHub as such', async () => {
    const limited = {
      [API_LATEST]: {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793000000' },
      },
    }
    const st = await service(limited).s.check()
    expect(st.lastCheck).toMatchObject({
      outcome: 'failed',
      reason: 'rate_limited',
      retryAt: 1_793_000_000_000,
    })
    const offline = { [API_LATEST]: { error: new EgressError('dns', 'The name cannot be resolved') } }
    expect((await service(offline).s.check()).lastCheck).toMatchObject({ reason: 'unreachable' })
  })

  it('follows no redirect away from GitHub', async () => {
    const r = signedRelease(key, '1.3.0')
    const answers = {
      ...r.answers,
      [r.url('SHA256SUMS')]: { redirect: 'https://evil.example.com/SHA256SUMS' },
    }
    const { s, github } = service(answers)
    expect((await s.check()).lastCheck).toMatchObject({ reason: 'unreachable' })
    expect(github.asked.some((q) => String(q.url).includes('evil.example.com'))).toBe(false)
  })

  it('sends nothing of the server’s: no cookie, token or authorization', async () => {
    const { s, github } = service(signedRelease(key, '1.3.0').answers)
    await s.check()
    for (const q of github.asked) {
      const names = Object.keys(q.headers ?? {}).map((h) => h.toLowerCase())
      expect(names).not.toContain('cookie')
      expect(names).not.toContain('authorization')
      expect(q.headers?.['user-agent']).toBe('mongo-manager')
    }
  })

  it('keeps the notes plain text, without control characters, bounded', async () => {
    const notes = `<img src=x onerror=alert(1)>\u0007\u001b[31m${'x'.repeat(30_000)}`
    const st = await service(signedRelease(key, '1.3.0', { notes }).answers).s.check()
    expect(st.latest!.notes.startsWith('<img src=x onerror=alert(1)>[31m')).toBe(true)
    expect(st.latest!.notes.length).toBeLessThanOrEqual(20_000)
  })
})

describe('what Update can do here', () => {
  it('Docker: a pull when the image is older than the release needs', async () => {
    const { s } = service(signedRelease(key, '1.3.0', { minImage: '1.3.0' }).answers, {
      origin: { ...bundleOrigin, distribution: 'docker' },
      env: { MM_IMAGE_VERSION: '1.2.0', MM_IMAGE_CREATED: new Date().toISOString() },
    })
    const st = await s.check()
    expect(st).toMatchObject({ offer: 'pull_image', offerReason: 'image_old', distribution: 'docker' })
    expect(st.image).toMatchObject({ version: '1.2.0', old: false })
  })

  it('Docker: an image over 90 days old is said so, and still updates in place', async () => {
    const created = new Date(Date.now() - 100 * 86_400_000).toISOString()
    const { s } = service(signedRelease(key, '1.3.0').answers, {
      origin: { ...bundleOrigin, distribution: 'docker' },
      env: { MM_IMAGE_VERSION: '1.2.0', MM_IMAGE_CREATED: created },
    })
    const st = await s.check()
    expect(st.offer).toBe('install')
    expect(st.image!.old).toBe(true)
  })

  it('a release that needs a newer Node: a pull on Docker, a reinstall elsewhere', async () => {
    const answers = signedRelease(key, '1.3.0', { node: '99.0.0' }).answers
    expect(await service(answers).s.check()).toMatchObject({ offer: 'reinstall', offerReason: 'node_old' })
    const docker = service(answers, {
      origin: { ...bundleOrigin, distribution: 'docker' },
      env: { MM_IMAGE_VERSION: '1.2.0' },
    })
    expect(await docker.s.check()).toMatchObject({ offer: 'pull_image', offerReason: 'node_old' })
  })

  // Final review (I7): a release that needs a newer installed program than this one.
  it('a release that needs a newer launcher: a reinstall, or a pull on Docker', async () => {
    const answers = signedRelease(key, '1.3.0', { minLauncher: '9.0.0' }).answers
    expect(await service(answers).s.check()).toMatchObject({
      offer: 'reinstall',
      offerReason: 'launcher_old',
    })
    const docker = service(answers, {
      origin: { ...bundleOrigin, distribution: 'docker' },
      env: { MM_IMAGE_VERSION: '1.2.0' },
    })
    expect(await docker.s.check()).toMatchObject({ offer: 'pull_image', offerReason: 'launcher_old' })
  })

  // Final review (minor): what is shown as a link is the release page, whatever the store holds.
  it('links the release page, never a stored address', async () => {
    const { s, settings } = service(signedRelease(key, '1.3.0').answers)
    await s.check()
    const stored = settings.map.get('updates_check') as { latest: { url: string } }
    stored.latest.url = 'javascript:alert(1)'
    expect(s.status(true).latest!.url).toBe(
      'https://github.com/mongo-manager/mongo-manager/releases/tag/v1.3.0',
    )
  })

  it('without the launcher a reinstall; from source a notice', async () => {
    const answers = signedRelease(key, '1.3.0').answers
    expect(await service(answers, { origin: null }).s.check()).toMatchObject({
      offer: 'reinstall',
      offerReason: 'no_launcher',
      launcher: false,
    })
    expect(await service(answers, { origin: null, fallbackDistribution: 'source' }).s.check()).toMatchObject({
      offer: 'notice',
      offerReason: 'source',
      distribution: 'source',
    })
  })
})

describe('how it was installed, under the launcher', () => {
  it('a version run from the data directory still knows the npm install it came from', () => {
    const global = join(dataDir, 'prefix', 'node_modules')
    const home = join(global, '@mongo-manager', 'app')
    mkdirSync(join(home, 'dist'), { recursive: true })
    writeFileSync(
      join(home, 'package.json'),
      JSON.stringify({ name: '@mongo-manager/app', version: '1.2.0' }),
    )
    const npm = service({}, { origin: { ...bundleOrigin, installDir: join(home, 'dist') } })
    expect(npm.s.status(false).distribution).toBe('npm')
    expect(service({}).s.status(false).distribution).toBe('copy')
    expect(
      service({}, { origin: { ...bundleOrigin, distribution: 'standalone', target: 'win-x64' } }).s.status(
        false,
      ).distribution,
    ).toBe('standalone')
  })
})

describe('who sees what, and turned off', () => {
  it('shows anyone else the installed version only', async () => {
    const { s } = service(signedRelease(key, '1.3.0').answers)
    await s.check()
    const st = s.status(false)
    expect(st).toMatchObject({ installed: '1.2.0', latest: null, offer: null, lastCheck: null, auto: false })
  })

  it('tells everyone whether the daily check is on: the privacy line must be true for each', () => {
    const { s } = service({})
    s.setAuto(true)
    expect(s.status(false).auto).toBe(true)
  })

  it('MM_UPDATES=off and an empty key list: nothing checked or offered', async () => {
    for (const over of [{ enabled: false }, { keys: [] as string[] }]) {
      const { s, github } = service(signedRelease(key, '1.3.0').answers, over)
      expect(s.status(true)).toMatchObject({ disabled: true, offer: null })
      await expect(s.check()).rejects.toMatchObject({ statusCode: 403, details: { reason: 'updates_off' } })
      expect(() => s.setAuto(true)).toThrow()
      expect(github.asked).toHaveLength(0)
    }
  })

  it('reads MM_UPDATES and MM_UPDATE_PROXY', () => {
    const c = (env: Record<string, string>) => resolveConfig({ env, cli: { dataDir } })
    expect(c({}).updates).toEqual({ enabled: true })
    expect(c({ MM_UPDATES: 'off' }).updates.enabled).toBe(false)
    expect(c({ MM_UPDATE_PROXY: 'http://proxy.example.com:3128' }).updates.proxy).toBe(
      'http://proxy.example.com:3128',
    )
    expect(() => c({ MM_UPDATE_PROXY: 'ftp://x' })).toThrow(ConfigError)
  })
})

describe('the daily check (off unless turned on, spec §7)', () => {
  it('asks nothing in three days when it is off', async () => {
    vi.useFakeTimers()
    const { s, github } = service(signedRelease(key, '1.3.0').answers)
    s.start()
    await vi.advanceTimersByTimeAsync(3 * 86_400_000)
    expect(github.asked).toHaveLength(0)
    s.stop()
  })

  it('asks five minutes after it starts, then once a day', async () => {
    vi.useFakeTimers()
    const { s, github } = service(signedRelease(key, '1.3.0').answers)
    s.setAuto(true)
    s.start()
    const latest = () => github.asked.filter((q) => String(q.url) === API_LATEST).length
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(latest()).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(latest()).toBe(1)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(latest()).toBe(2)
    s.setAuto(false)
    await vi.advanceTimersByTimeAsync(3 * 86_400_000)
    expect(latest()).toBe(2)
    s.stop()
  })

  it('waits out the day after a recent check, and a rate limit brings no sooner retry', async () => {
    vi.useFakeTimers()
    const limited = {
      [API_LATEST]: {
        status: 429,
        body: {},
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' },
      },
    }
    const { s, github } = service(limited)
    s.setAuto(true)
    s.start()
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(github.asked).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(86_400_000 - 2 * 60_000)
    expect(github.asked).toHaveLength(1)
    s.stop()
    // A server started again soon after keeps the day: the next check is a day after the last.
    const again = new UpdateService({ ...s.deps })
    again.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(github.asked).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(github.asked).toHaveLength(2)
    again.stop()
  })
})
