// The updater (2026-11-03): signs a release's SHA256SUMS with the project's Ed25519 key (environment
// secret MM_RELEASE_SIGNING_KEY: base64 PKCS#8 DER, from scripts/release-key.mjs) and checks the
// signature against the keys the app ships before writing it — a wrong secret never publishes a
// signature every install would refuse.
// Usage: node scripts/sign-release.mjs <SHA256SUMS> <SHA256SUMS.sig> [--public <base64 key>]
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { RELEASE_PUBLIC_KEYS } from '../packages/shared/src/updates/source.ts'

const FORKS =
  'A fork signs with a key of its own: see "Forks: turning updates on" in the README ' +
  '(packages/shared/src/updates/source.ts lists the public keys).'

function fail(message) {
  process.stderr.write(`sign-release: ${message}\n`)
  process.exit(1)
}

const [sumsPath, sigPath, ...rest] = process.argv.slice(2)
if (!sumsPath || !sigPath)
  fail('Usage: node scripts/sign-release.mjs <SHA256SUMS> <SHA256SUMS.sig> [--public <key>]')
// --public: a test's own key in place of the shipped list.
const at = rest.indexOf('--public')
const keys = at >= 0 ? [rest[at + 1] ?? ''] : RELEASE_PUBLIC_KEYS

const secret = (process.env.MM_RELEASE_SIGNING_KEY ?? '').trim()
if (!secret) fail(`MM_RELEASE_SIGNING_KEY is not set (the "signing" environment's secret). ${FORKS}`)
let key
try {
  key = createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' })
} catch {
  fail('MM_RELEASE_SIGNING_KEY is not a base64 PKCS#8 key (scripts/release-key.mjs writes one).')
}
if (key.asymmetricKeyType !== 'ed25519') fail('MM_RELEASE_SIGNING_KEY is not an Ed25519 key.')

const sums = readFileSync(sumsPath)
const signature = sign(null, sums, key)
const listed = keys.some((k) => {
  try {
    return verify(
      null,
      sums,
      createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }),
      signature,
    )
  } catch {
    return false
  }
})
if (!listed)
  fail(
    `The signing key's public half is not in RELEASE_PUBLIC_KEYS of packages/shared/src/updates/source.ts. ${FORKS}`,
  )
writeFileSync(sigPath, `${signature.toString('base64')}\n`, { flag: 'wx' })
process.stdout.write(`Signed ${sumsPath}\n`)
