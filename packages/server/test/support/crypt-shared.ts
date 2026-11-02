import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Security review I2: a crypt_shared path a connection names must be a mongo_crypt_v1 file on this
 * computer. Tests that never load it (the client is faked or never encrypts) name this one: an
 * empty file of that name in the system's temporary folder, made once per test file.
 */
let made: string | undefined
export function fakeCryptSharedLib(): string {
  if (made) return made
  const dir = mkdtempSync(join(tmpdir(), 'mm-crypt-shared-'))
  made = join(dir, process.platform === 'win32' ? 'mongo_crypt_v1.dll' : 'mongo_crypt_v1.so')
  writeFileSync(made, '')
  return made
}
