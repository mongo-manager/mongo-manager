/**
 * User report 2026-10-11: a first-party plugin that uses bson (the SQL plugin's driver code) was
 * shown by the security scan as "1 to review": bson's Long tries to build a small WebAssembly
 * module to multiply 64-bit numbers. In a plugin's frame that never runs — the policy allows no
 * WebAssembly, and bson falls back to plain JavaScript in its catch — so the build leaves the
 * helper undefined, as the frame always had it, and the scan finds nothing.
 *
 * Should bson change that code, the build stops rather than ship it unnoticed.
 */
const HELPER =
  /new WebAssembly\.Instance\(new WebAssembly\.Module\(new Uint8Array\(\[[\d,\s]+\]\)\),\s*\{\}\)\.exports/g
const BSON = /[\\/]bson[\\/]lib[\\/][^\\/]+\.m?js$/

export function withoutWasm(code: string, id: string): string {
  const found = code.match(HELPER)?.length ?? 0
  if (found !== 1)
    throw new Error(
      `bson (${id}) no longer has the one WebAssembly helper this build removes (${found} found): look at what it does now`,
    )
  const out = code.replace(HELPER, 'undefined')
  if (out.includes('WebAssembly'))
    throw new Error(`bson (${id}) holds WebAssembly besides the helper this build removes`)
  return out
}

/** The part of a Vite plugin this one is: the kit has no Vite of its own to take the type from. */
export interface TransformPlugin {
  name: string
  enforce: 'pre'
  transform(code: string, id: string): string | null
}

export function bsonWithoutWasm(): TransformPlugin {
  return {
    name: 'mongo-manager:bson-without-wasm',
    enforce: 'pre',
    transform(code, id) {
      if (!BSON.test(id.split('?')[0]!)) return null
      return withoutWasm(code, id)
    },
  }
}
