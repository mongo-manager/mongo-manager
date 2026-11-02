import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parse } from 'yaml'
import { checkWorkflow } from './check-workflows.mjs'

const dir = join(import.meta.dirname, '..', '.github', 'workflows')
const release = parse(readFileSync(join(dir, 'release.yml'), 'utf8'))
const steps = (job) => release.jobs[job].steps
const run = (job) =>
  steps(job)
    .map((s) => s.run ?? '')
    .join('\n')

test('checkout never leaves the job token in .git/config (final review Minor 7)', () => {
  const SHA = 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09'
  const wf = (withBlock) =>
    `on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n${withBlock}`
  assert.deepEqual(checkWorkflow(wf(''), 'x.yml'), [
    'x.yml:8: checkout keeps the job token in .git/config: set persist-credentials: false',
  ])
  assert.deepEqual(checkWorkflow(wf('        with:\n          persist-credentials: false\n'), 'x.yml'), [])
  for (const f of readdirSync(dir)) assert.deepEqual(checkWorkflow(readFileSync(join(dir, f), 'utf8'), f), [])
})

// Security review 2026-10-13 (ops): the release carries the licences of what it bundles.
// 2026-11-01: the package is scoped (@mongo-manager/app); npm pack names its tarball after the
// scope, and the release renames it to the plain name the docs and SHA256SUMS use.
test('the npm tarball gets the plain name, from the version the tag was checked against', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'packages', 'cli', 'package.json'), 'utf8'),
  )
  const packed = pkg.name.replace(/^@/, '').replace('/', '-')
  const step = steps('package').find((s) => /npm pack/.test(s.run ?? ''))
  assert.equal(step.env?.VERSION, '${{ steps.version.outputs.version }}')
  assert.ok(
    steps('package').some((s) => s.id === 'version'),
    'the step that sets the version',
  )
  assert.ok(
    step.run.includes(`mv "../../out/${packed}-$VERSION.tgz" "../../out/mongo-manager-$VERSION.tgz"`),
    step.run,
  )
  assert.match(run('npm'), /npm publish "mongo-manager-\$VERSION\.tgz"/)
})

test('the release carries the third-party notices beside its files', () => {
  assert.match(run('package'), /cp packages\/cli\/dist\/THIRD-PARTY-NOTICES\.txt out\//)
  const upload = steps('package').find((s) => /upload-artifact/.test(s.uses ?? ''))
  assert.match(upload.with.path, /out\/THIRD-PARTY-NOTICES\.txt/)
})

test('GHCR gets the tested, checksummed image, only after the release and an approval (final review Important 3)', () => {
  assert.ok(!release.jobs.docker.permissions?.packages, 'the image build job cannot push')
  assert.doesNotMatch(run('docker'), /--push/)
  const ghcr = release.jobs.ghcr
  assert.deepEqual(ghcr.needs, ['package', 'release'])
  assert.equal(ghcr.environment, 'ghcr')
  assert.equal(ghcr.permissions.packages, 'write')
  // It pushes what docker load reads from the archives listed in SHA256SUMS, never a new build.
  assert.match(run('ghcr'), /sha256sum --check/)
  assert.match(run('ghcr'), /docker load -i/)
  assert.doesNotMatch(run('ghcr'), /docker (buildx )?build\b/)
  assert.ok(
    steps('ghcr').some((s) => /attest-build-provenance/.test(s.uses ?? '') && s.with['push-to-registry']),
  )
})

test('the npm package is published with provenance through trusted publishing, after approval', () => {
  const npm = release.jobs.npm
  assert.equal(npm.environment, 'npm')
  assert.equal(npm.permissions['id-token'], 'write')
  assert.match(run('npm'), /npm publish .* --provenance/)
  assert.doesNotMatch(JSON.stringify(npm), /NPM_TOKEN/)
})

test('release builds are reproducible: exact Node, fixed timestamps, attestations only for tags', () => {
  for (const [name, job] of Object.entries(release.jobs)) {
    for (const s of job.steps) {
      if (/setup-node/.test(s.uses ?? ''))
        assert.match(String(s.with['node-version']), /^\d+\.\d+\.\d+$/, name)
    }
  }
  assert.match(run('docker'), /rewrite-timestamp=true/)
  const attest = steps('release').find((s) => /attest-build-provenance/.test(s.uses ?? ''))
  assert.equal(attest.if, "github.event_name == 'push'")
})

test('the package declares provenance for publishing (final review Minor 9)', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'packages', 'cli', 'package.json'), 'utf8'),
  )
  assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true })
})

// Gap scan 2026-10-15: the suites that check built output (the web build's CSP and offline rules,
// the shipped plugins' scan) skip without a build, and the job that builds never ran them.
test('CI runs the checks of the built web app and plugins where they are built, and fails without a build', () => {
  const ci = parse(readFileSync(join(dir, 'ci.yml'), 'utf8'))
  const steps = ci.jobs.e2e.steps
  const build = steps.findIndex((s) => /pnpm test:e2e/.test(s.run ?? ''))
  const checks = steps.findIndex((s) => /test\/build\.test\.ts/.test(s.run ?? ''))
  assert.ok(build >= 0 && checks > build, 'after the build')
  assert.match(steps[checks].run, /plugins-bundled-scan\.test\.ts/)
  assert.equal(steps[checks].env?.MM_REQUIRE_BUILD, '1')
})

/** server-mongo and its entries: a MongoDB version and the runner it runs on. */
function serverMongo() {
  const job = parse(readFileSync(join(dir, 'ci.yml'), 'utf8')).jobs['server-mongo']
  return { job, entries: job.strategy.matrix.include }
}

test('CI runs the server suites on MongoDB 6.0 (the supported floor), 7.0, 8.0, 8.3 and 9.0, the latest release (spec §9, phase 1h §10)', () => {
  const { job, entries } = serverMongo()
  const versions = entries.map((e) => e.mongodb)
  for (const line of ['6.0.', '7.0.', '8.0.', '8.3.', '9.0.'])
    assert.ok(
      versions.some((v) => v.startsWith(line)),
      line,
    )
  assert.equal(job['runs-on'], '${{ matrix.runner }}')
  assert.match(JSON.stringify(job.steps), /MONGOMS_VERSION/)
})

// Review of the CI kernel fix (I-1) and of its follow-up (I-1): MongoDB 8.0.30+, 8.3.9+ and 9.0
// refuse Linux 6.19 to 7.0.13 (SERVER-121912, SERVER-125742) and read Ubuntu's 7.0.0-x as such even
// when it carries the fix (SERVER-136848, open). The Linux runner they start on is ubuntu-22.04
// (Linux 6.8), which runner-images #14254 retires on 2027-04-17, with day-long brownouts from
// 2027-03-23. The problem is Linux's alone: the suite passed on Windows with 8.3.13 and 9.0.4
// (2026-10-20), and a windows-latest entry keeps showing it. From 2027-03-16, a week before the first
// brownout, this fails until no entry is left on ubuntu-22.04.
const SERVER_MONGO_RUNNER_DEADLINE = '2027-03-16'
function serverMongoRunnerProblem({ mongodb, runner }, now) {
  if (/^(windows|macos)-/.test(runner)) return null
  const major = Number(mongodb.split('.')[0])
  if (runner === 'ubuntu-22.04')
    return now >= Date.parse(SERVER_MONGO_RUNNER_DEADLINE)
      ? `ubuntu-22.04 is retired on 2027-04-17 (runner-images #14254): move MongoDB ${mongodb} to ${major >= 8 ? 'windows-latest' : 'ubuntu-latest'} before its brownouts`
      : null
  return major >= 8
    ? `MongoDB ${mongodb} refuses ${runner}'s Linux 7.0 (SERVER-121912, SERVER-136848): run it on windows-latest`
    : null
}

test('server-mongo runs each MongoDB where it starts, and leaves ubuntu-22.04 before it is retired', () => {
  const { entries } = serverMongo()
  for (const e of entries) assert.equal(serverMongoRunnerProblem(e, Date.now()), null, JSON.stringify(e))
  // Where the entries move to is shown working now.
  assert.ok(entries.some((e) => e.mongodb.startsWith('9.') && e.runner === 'windows-latest'))
  const before = Date.parse('2027-03-15T23:59:59Z')
  const after = Date.parse('2027-03-16')
  assert.equal(serverMongoRunnerProblem({ mongodb: '9.0.4', runner: 'ubuntu-22.04' }, before), null)
  assert.match(
    serverMongoRunnerProblem({ mongodb: '9.0.4', runner: 'ubuntu-22.04' }, after),
    /retired on 2027-04-17 .*move MongoDB 9\.0\.4 to windows-latest/,
  )
  assert.match(
    serverMongoRunnerProblem({ mongodb: '7.0.45', runner: 'ubuntu-22.04' }, after),
    /move MongoDB 7\.0\.45 to ubuntu-latest/,
  )
  assert.match(
    serverMongoRunnerProblem({ mongodb: '8.0.34', runner: 'ubuntu-latest' }, 0),
    /refuses ubuntu-latest's Linux 7\.0 .*windows-latest/,
  )
  assert.equal(serverMongoRunnerProblem({ mongodb: '7.0.45', runner: 'ubuntu-latest' }, after), null)
  assert.equal(serverMongoRunnerProblem({ mongodb: '9.0.4', runner: 'windows-latest' }, after), null)
})

// Review of the CI kernel fix (M-1, M-2, M-3): the offline run's MongoDB is the version the memory
// server runs beside it (and moves with it), and every run says which kernel it had, by Ubuntu's
// signature too (`uname -r` stays 7.0.0 for the whole series).
test('the offline MongoDB is the memory server default, and the run records its kernel', () => {
  const ci = parse(readFileSync(join(dir, 'ci.yml'), 'utf8'))
  const script = ci.jobs['e2e-offline'].steps.map((s) => s.run ?? '').join('\n')
  const image = /\bmongo:(\S+)@sha256:[0-9a-f]{64}\b/.exec(script)?.[1]
  const fromE2e = createRequire(join(import.meta.dirname, '..', 'packages', 'e2e', 'package.json'))
  const core = createRequire(fromE2e.resolve('mongodb-memory-server'))
  // Not a public export: if the package moves it, find the default version again (its README).
  const { DEFAULT_VERSION } = core('mongodb-memory-server-core/lib/util/resolveConfig')
  assert.equal(
    image,
    DEFAULT_VERSION,
    `the memory server now runs MongoDB ${DEFAULT_VERSION}: give e2e-offline's container that version (mongo:${DEFAULT_VERSION}@sha256:<its index digest>)`,
  )
  const start = script.indexOf('docker run -d --name mongo')
  assert.ok(start >= 0, 'the offline MongoDB is started by `docker run -d --name mongo`')
  const before = script.slice(0, start)
  assert.match(before, /^uname -r$/m)
  assert.match(before, /^cat \/proc\/version_signature \|\| true$/m)
})

test('the Node 24 check runs the suites once, with coverage (final review 1g-3, Minor 9)', () => {
  const ci = parse(readFileSync(join(dir, 'ci.yml'), 'utf8'))
  const steps = ci.jobs.check.steps.filter((s) => /pnpm (test|coverage)/.test(s.run ?? ''))
  assert.deepEqual(
    steps.map((s) => [s.if, s.run.split(' && ')[0]]),
    [
      ['matrix.node != 24', 'pnpm test'],
      ['matrix.node == 24', 'pnpm coverage'],
    ],
  )
})

// Review of the ops fixes (I3): the Windows data-directory ACL test runs where Windows is.
test('CI runs the Windows data-directory ACL test on Windows', () => {
  const ci = parse(readFileSync(join(dir, 'ci.yml'), 'utf8'))
  const job = ci.jobs['service-windows']
  assert.match(job['runs-on'], /windows/)
  assert.ok(job.steps.some((s) => /vitest run test\/data-dir-acl\.test\.ts/.test(s.run ?? '')))
})

test('the image says what it is, where it comes from and which version it is (OCI labels)', () => {
  const dockerfile = readFileSync(join(import.meta.dirname, '..', 'Dockerfile'), 'utf8')
  const final = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '))
  for (const label of ['title', 'description', 'source', 'licenses', 'version', 'revision']) {
    assert.match(final, new RegExp(`org\\.opencontainers\\.image\\.${label}=`), label)
  }
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'packages', 'cli', 'package.json'), 'utf8'),
  )
  assert.ok(
    final.includes(`org.opencontainers.image.description="${pkg.description}"`),
    'the package description',
  )
  assert.match(
    final,
    /org\.opencontainers\.image\.source="https:\/\/github\.com\/mongo-manager\/mongo-manager"/,
  )
  assert.match(final, /org\.opencontainers\.image\.version="\$VERSION"/)
  assert.match(final, /org\.opencontainers\.image\.revision="\$REVISION"/)
  // Declared in the final stage (an ARG above the first FROM leaves the label empty), after the last
  // RUN (an ARG before a RUN makes every new version rebuild that layer).
  const args = [...final.matchAll(/^ARG (VERSION|REVISION)\b/gm)].map((m) => m.index)
  assert.equal(args.length, 2)
  assert.ok(Math.min(...args) > final.lastIndexOf('\nRUN '), 'the ARGs come after the last RUN')
  assert.match(run('docker'), /--build-arg "VERSION=\$VERSION" --build-arg "REVISION=\$GITHUB_SHA"/)
  // The registry shows a multi-arch package's description from the index the release pushes.
  assert.ok(
    run('ghcr').includes(`--annotation "index:org.opencontainers.image.description=${pkg.description}"`),
    'the index carries the description',
  )
})
