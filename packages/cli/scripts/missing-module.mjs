// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Optional native add-ons and optional MongoDB driver add-ons are not bundled. Their callers load
 * them inside try/catch and fall back to pure JavaScript (or report the missing dependency), so
 * they are replaced by modules that fail to load.
 */
export const NATIVE = /\.node$|^cpu-features$/
export const OPTIONAL = new Set([
  'kerberos',
  'snappy',
  '@mongodb-js/zstd',
  'mongodb-client-encryption',
  '@aws-sdk/credential-providers',
  'gcp-metadata',
  'aws4',
  '@napi-rs/snappy-wasm',
])

/**
 * A JavaScript string literal of `value`, safe wherever the generated source goes (CodeQL
 * js/bad-code-sanitization): JSON.stringify quotes it and escapes quotes, backslashes and control
 * characters; then `<`, `>` and `/` (no `</script>` or comment can close or open around it) and the
 * line separators U+2028 and U+2029 (line breaks in older JavaScript) become \u escapes, which read
 * back as the same characters.
 */
const UNSAFE_IN_SOURCE = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}
export function jsString(value) {
  return JSON.stringify(String(value)).replace(/[<>/\u2028\u2029]/g, (c) => UNSAFE_IN_SOURCE[c])
}

/**
 * Source of a module that stands in for an optional add-on that is not bundled. Loading it throws
 * MODULE_NOT_FOUND. The bundler caches a module that threw, so later loads get its exports: those
 * are a proxy that still reports the dependency as missing (the MongoDB driver checks kModuleError)
 * and throws on any other use, instead of an empty object that fails later in obscure ways.
 */
export function missingModuleSource(name) {
  return [
    `const e = new Error('Optional module not bundled: ' + ${jsString(name)})`,
    "e.code = 'MODULE_NOT_FOUND'",
    'module.exports = new Proxy({}, {',
    "  has: (_, key) => key === 'kModuleError',",
    "  get: (_, key) => { if (key === 'kModuleError') return e; if (key === '__esModule' || typeof key === 'symbol') return undefined; throw e },",
    '})',
    'throw e',
  ].join('\n')
}

/**
 * The AWS SDK stands in loaded: the MongoDB driver checks it before it calls the credential
 * provider each MONGODB-AWS connection is given (the connection's own keys). Its provider chain,
 * the host's own AWS identity, is never what a connection signs in with.
 */
export const AWS_SDK = '@aws-sdk/credential-providers'
export function awsSdkSource() {
  const message =
    'Mongo Manager signs in to AWS with the keys of the connection only, never its host’s own identity'
  return [
    `const refuse = () => { throw new Error(${jsString(message)}) }`,
    'module.exports = { fromNodeProviderChain: refuse }',
  ].join('\n')
}

/**
 * W8 (completion, owner's ruling 2026-10-16): Kerberos and client-side encryption ship in the npm
 * package only, through these two packages the user installs next to it
 * (`npm i -g @mongo-manager/app kerberos mongodb-client-encryption`); none is declared as a dependency
 * (verify-pack: installing mongo-manager runs no package's install script).
 *
 * Security review C2: the bundle never searches for them — Node's search walks up from the program
 * and would load one planted in C:\node_modules above the service's copy. Their stand-in asks the
 * server's verified loader (server/src/optional/modules.ts, registered at the global OPTIONAL_HOOK),
 * which loads them from the global node_modules holding this package only, and only when a connection
 * needs one; without it, or when it has none, the stand-in reports them missing. The shell worker's
 * build keeps them stubbed (it loads no add-on).
 */
export const INSTALLABLE = new Set(['kerberos', 'mongodb-client-encryption'])

export function installableSource(name) {
  return [
    "const hook = globalThis[Symbol.for('mongo-manager.optional-modules')]",
    `const verified = typeof hook === 'function' ? hook(${jsString(name)}) : null`,
    'if (verified) module.exports = verified',
    'else {',
    missingModuleSource(name),
    '}',
  ].join('\n')
}

export function missingModulesPlugin(opts = {}) {
  return {
    name: 'mongo-manager:missing-modules',
    resolveId(id) {
      if (opts.installable && INSTALLABLE.has(id)) return `\0installable:${id}`
      if (NATIVE.test(id) || OPTIONAL.has(id)) return `\0missing:${id}`
      return null
    },
    load(id) {
      if (id.startsWith('\0installable:')) return installableSource(id.slice('\0installable:'.length))
      if (!id.startsWith('\0missing:')) return null
      const name = id.slice('\0missing:'.length)
      return name === AWS_SDK ? awsSdkSource() : missingModuleSource(name)
    },
  }
}
