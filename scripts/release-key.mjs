// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// The updater (2026-11-03): makes the Ed25519 key pair releases are signed with. The private key
// goes to the file named (only this account may read it; an existing file is never overwritten);
// only the public key is printed, for RELEASE_PUBLIC_KEYS in packages/shared/src/updates/source.ts.
// The private key becomes the "signing" environment's secret MM_RELEASE_SIGNING_KEY: keep it
// offline, never commit it. Usage: node scripts/release-key.mjs <file outside the repository>
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  process.stderr.write('Usage: node scripts/release-key.mjs <file for the private key>\n')
  process.exit(2)
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
try {
  writeFileSync(file, `${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
} catch (e) {
  process.stderr.write(`release-key: cannot write ${file}: ${e.message}\n`)
  process.exit(1)
}
process.stdout.write(
  `The private key is in ${file}.\nPublic key, for RELEASE_PUBLIC_KEYS in packages/shared/src/updates/source.ts:\n` +
    `${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}\n`,
)
