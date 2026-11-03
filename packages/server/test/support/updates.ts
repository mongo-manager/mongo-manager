import { createHash, sign } from 'node:crypto'
import { Readable } from 'node:stream'
import { RELEASE_REPO } from '@mongo-manager/shared'
import { EgressError, type Egress, type EgressRequest } from '../../src/net/egress'
import { testKey, type TestKey } from '../../../shared/test/versionFixture'
import { tgz } from '../../../shared/test/tarFixture'

export { testKey, type TestKey }

export type Answer =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { redirect: string }
  | { error: EgressError }
  /** The body stops half-way (a dropped connection). */
  | { status: number; body: Buffer; cut: true }

/** GitHub as a test sees it: an answer for each address, every request recorded. */
export function fakeGithub(answers: Record<string, Answer>) {
  const asked: EgressRequest[] = []
  const find = (r: EgressRequest) => {
    asked.push(r)
    const a = answers[String(r.url)]
    if (!a) throw new EgressError('connect', 'The destination cannot be reached')
    if ('error' in a) throw a.error
    if ('redirect' in a)
      throw new EgressError(
        'redirect',
        'The destination answered with a redirect; redirects are not followed',
        new URL(a.redirect).host,
        a.redirect,
      )
    const body = Buffer.isBuffer(a.body) ? a.body : Buffer.from(JSON.stringify(a.body))
    return { a, body }
  }
  const egress: Egress = {
    buffer: async (r, limit = 1024 * 1024) => {
      const { a, body } = find(r)
      if (body.length > limit) throw new EgressError('too_large', 'The destination sent too large an answer')
      return {
        status: (a as { status: number }).status,
        headers: (a as { headers?: Record<string, string> }).headers ?? {},
        body,
      }
    },
    request: async (r) => {
      const { a, body } = find(r)
      const cut = 'cut' in a
      const stream = new Readable({
        read() {
          if (cut) {
            this.push(body.subarray(0, Math.floor(body.length / 2)))
            this.destroy(new Error('socket hang up'))
          } else {
            this.push(body)
            this.push(null)
          }
        },
      })
      return {
        status: (a as { status: number }).status,
        headers: {
          'content-length': String(body.length),
          ...((a as { headers?: Record<string, string> }).headers ?? {}),
        },
        body: stream,
      }
    },
    probe: () => Promise.reject(new Error('not used')),
    listed: () => false,
  }
  return { egress, asked }
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
export const API_LATEST = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`
const download = (version: string, name: string) =>
  `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${name}`

export interface ReleaseOptions {
  draft?: boolean
  prerelease?: boolean
  tag?: string
  node?: string
  minImage?: string
  minLauncher?: string
  notes?: string
  /** Signs with this key instead (a wrong key). */
  signer?: TestKey
  /** The package's files under package/. */
  files?: Record<string, string>
  /** Leaves these assets out of the release. */
  without?: string[]
}

/** A signed release as GitHub serves it: the latest-release answer and every asset. */
export function signedRelease(key: TestKey, version: string, opts: ReleaseOptions = {}) {
  const files = opts.files ?? {
    'package.json': JSON.stringify({ name: '@mongo-manager/app', version }),
    'dist/cli.cjs': 'process.exit(0)\n',
  }
  const archive = tgz(Object.entries(files).map(([name, data]) => ({ name: `package/${name}`, data })))
  const binary = Buffer.from(`binary ${version}`)
  const info = JSON.stringify({
    schema: 1,
    version,
    node: opts.node ?? '20.0.0',
    minImage: opts.minImage ?? '1.0.0',
    ...(opts.minLauncher ? { minLauncher: opts.minLauncher } : {}),
  })
  const tgzName = `mongo-manager-${version}.tgz`
  const binName = `mongo-manager-${version}-linux-x64`
  const sums = Buffer.from(
    `${sha(archive)}  ${tgzName}\n${sha(binary)}  ${binName}\n${sha(info)}  release.json\n`,
  )
  const sig = `${sign(null, sums, (opts.signer ?? key).privateKey).toString('base64')}\n`
  const bodies: Record<string, Buffer> = {
    SHA256SUMS: sums,
    'SHA256SUMS.sig': Buffer.from(sig),
    'release.json': Buffer.from(info),
    [tgzName]: archive,
    [binName]: binary,
  }
  const names = Object.keys(bodies).filter((n) => !opts.without?.includes(n))
  const latest = {
    tag_name: opts.tag ?? `v${version}`,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    published_at: '2026-11-03T10:00:00Z',
    html_url: `https://github.com/${RELEASE_REPO}/releases/tag/${opts.tag ?? `v${version}`}`,
    body: opts.notes ?? '## Added\n- Updates from the panel',
    assets: names.map((name) => ({
      name,
      size: bodies[name]!.length,
      browser_download_url: download(version, name),
    })),
  }
  const answers: Record<string, Answer> = {
    [API_LATEST]: { status: 200, body: latest },
    [`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/v${version}`]: { status: 200, body: latest },
  }
  for (const name of names) answers[download(version, name)] = { status: 200, body: bodies[name]! }
  return { answers, latest, bodies, url: (name: string) => download(version, name) }
}
