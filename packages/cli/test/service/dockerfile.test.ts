// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', '..', '..')
const dockerfile = () => readFileSync(join(root, 'Dockerfile'), 'utf8')

describe('Dockerfile (spec §3.5, S17, S19)', () => {
  it('pins every base image by digest', () => {
    const froms = dockerfile()
      .split('\n')
      .filter((l) => /^FROM /i.test(l))
    expect(froms.length).toBeGreaterThanOrEqual(2)
    for (const from of froms) expect(from).toMatch(/@sha256:[0-9a-f]{64}/)
  })

  it('runs as 10001 in team mode with a health check and no shell entrypoint', () => {
    const text = dockerfile()
    expect(text).toMatch(/^USER 10001:10001$/m)
    expect(text).toMatch(/MM_AUTH=1/)
    expect(text).toMatch(/MM_HOST=0\.0\.0\.0/)
    expect(text).toMatch(/^HEALTHCHECK /m)
    expect(text).toMatch(/^ENTRYPOINT \["\/sbin\/tini", "--", "node", "\/app\/dist\/cli\.cjs"\]$/m)
  })

  // User request 2026-11-03: the license and its additional terms go with every copy.
  it('ships the license and NOTICE in /app', () => {
    expect(dockerfile()).toMatch(/^COPY --from=build \/src\/LICENSE \/src\/NOTICE \/app\/$/m)
  })

  it('ships the shell worker and the bundled plugins beside the bundle (4b map review I2)', () => {
    const text = dockerfile()
    expect(text).toMatch(
      /^COPY --from=build \/src\/packages\/cli\/dist\/shell-worker\.cjs \/app\/dist\/shell-worker\.cjs$/m,
    )
    expect(text).toMatch(/^COPY --from=build \/src\/packages\/cli\/plugins \/app\/plugins$/m)
  })

  it('keeps build context small and free of secrets', () => {
    const ignore = readFileSync(join(root, '.dockerignore'), 'utf8').split('\n')
    for (const entry of ['node_modules', '.git', '**/dist', '.*', '**/*.key', '**/.env*']) {
      expect(ignore).toContain(entry)
    }
  })

  // Review of the CI kernel fix (I-2): MongoDB 8 refuses Linux 6.19 to 7.0.13 (SERVER-121912), and
  // Ubuntu's 7.0.0-x kernels are refused even when they carry the fix (SERVER-136848). Those that
  // start may crash there. The MongoDB to try it out with is 7.0, which none of that touches.
  it("compose's MongoDB is a line the newer Linux kernels do not stop", () => {
    const compose = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')
    const image = /^ {2}mongo:\n(?: {4}.*\n)*? {4}image: (\S+)$/m.exec(compose)?.[1]
    expect(image).toMatch(/^mongo:7\.0\.\d+@sha256:[0-9a-f]{64}$/)
    // Review of the kernel follow-up (Minor 4): 7.0's end of life is 2027-08-31. A month before it,
    // this fails, so compose moves to a supported line that starts on those kernels.
    expect(
      Date.now() < Date.parse('2027-07-31'),
      'MongoDB 7.0 reaches end of life on 2027-08-31: give compose a supported MongoDB that starts on Linux 6.19 to 7.0.13',
    ).toBe(true)
  })

  // Review of the kernel follow-up (Minor 5): a standalone server could not show Watch or Live sync
  // (change streams). The MongoDB to try it out with is a one-member replica set, and the compose
  // header and the docs give the address that reaches it as one.
  it("compose's MongoDB is a replica set, and its address says so", () => {
    const compose = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')
    const readme = readFileSync(join(root, 'deploy', 'README.md'), 'utf8')
    const mongo = /^ {2}mongo:\n((?: {4}.*\n|\n)*)/m.exec(compose)?.[1] ?? ''
    expect(mongo).toContain("command: ['--replSet', 'rs0']")
    expect(mongo).toMatch(/rs\.initiate\(\{ _id: 'rs0', members: \[\{ _id: 0, host: 'mongo:27017' \}\] \}\)/)
    // Review of db45c424 (M-6): healthy once it is the primary, not as soon as it is initiated.
    expect(mongo).toContain('quit(db.hello().isWritablePrimary ? 0 : 1)')
    expect(compose).toContain('mongodb://mongo:27017/?replicaSet=rs0')
    expect(readme).toContain('mongodb://mongo:27017/?replicaSet=rs0')
    // Published on the host, it is reached directly: the set names itself mongo:27017.
    expect(readme).toContain('directConnection=true')
    // Review of 69adc29a (I-2): `down -v` also deletes mm-data, Mongo Manager's own data. The docs
    // remove the MongoDB's volume alone, and never give `down -v` as a command.
    expect(readme).toContain('--profile with-mongo rm -sf mongo')
    expect(readme).toContain('docker volume rm deploy_mongo-data')
    expect(readme).not.toMatch(/^\s*docker compose .*\bdown\b.*-v\b/m)
    expect(compose).not.toMatch(/mongodb:\/\/mongo:27017(?!\/\?replicaSet=rs0)/)
  })

  it('compose keeps the container locked down', () => {
    const compose = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')
    for (const line of ['read_only: true', 'cap_drop: [ALL]', 'no-new-privileges:true', '/tmp'])
      expect(compose).toContain(line)
  })

  // Security review 2026-10-13 (ops): the published port was open on every interface of the host —
  // plain HTTP to the network. It is on the host's loopback; a reverse proxy publishes it further.
  // Review of the ops fixes (I2): a reverse proxy on the host reaches the container from the compose
  // network's gateway, never from 127.0.0.1 — the gateway is fixed, and the docs name it.
  it('compose fixes the network gateway a host proxy is trusted by, and the docs name it', () => {
    const compose = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')
    expect(compose).toMatch(/subnet: 172\.31\.240\.0\/24/)
    expect(compose).toMatch(/gateway: 172\.31\.240\.1/)
    expect(readFileSync(join(root, 'deploy', 'README.md'), 'utf8')).toMatch(
      /MM_TRUSTED_PROXIES=172\.31\.240\.1/,
    )
  })

  it('compose publishes the app on the host loopback only', () => {
    const compose = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')
    const ports = [...compose.matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]!).filter((p) => p.includes(':'))
    expect(ports).toEqual(['127.0.0.1:4321:4321'])
  })
})

describe('supply chain pins (Review Minor 12, 13)', () => {
  it('drops npm and yarn from the runtime image', () => {
    const runtime = dockerfile()
      .split(/^FROM /m)
      .at(-1)!
    expect(runtime).toMatch(/rm -rf[^\n]*\/usr\/local\/lib\/node_modules\/npm/)
    expect(runtime).toMatch(/\/usr\/local\/bin\/npx/)
    expect(runtime).toMatch(/\/opt\/yarn-\*/)
  })

  // Security review 2026-10-13 (ops): a package published hours ago reached the lockfile after a day —
  // most poisoned releases are found and pulled within days. Renovate and pnpm itself wait three.
  it('waits three days before taking a newly published package', () => {
    const renovate = JSON.parse(readFileSync(join(root, 'renovate.json'), 'utf8')) as {
      minimumReleaseAge: string
    }
    expect(renovate.minimumReleaseAge).toBe('3 days')
    const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
    expect(Number(/^minimumReleaseAge: (\d+)$/m.exec(workspace)?.[1])).toBeGreaterThanOrEqual(3 * 24 * 60)
  })

  it('pins every compose image and every CI action by digest or commit', () => {
    const compose = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')
    for (const image of compose.match(/^\s+image: (\S+)$/gm) ?? []) {
      if (!image.includes('mongo-manager:local')) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/)
    }
    const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    // Step keys only (`- uses:` / `uses:` at the start of a line), not prose in comments.
    const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s+(\S+)/gm)].map((m) => m[1]!)
    expect(uses.length).toBeGreaterThan(5)
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/)
  })
})
