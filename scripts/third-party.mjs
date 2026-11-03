// Security review 2026-10-13 (ops): the release bundles other people's code — the CLI bundle, the
// shell worker, the web app and the plugins — and ships their licences with it. Each build records
// the packages its output was made from (the bundler's own module list, so exactly what ships); the
// CLI build writes them as one THIRD-PARTY-NOTICES.txt.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Licence files a package ships (LICENSE, LICENCE.md, COPYING, NOTICE, …). */
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.\-_].*)?$/i
/** A licence file is text of a few kilobytes; a longer one is cut. */
const MAX_TEXT = 64 * 1024

/** The folder of the package a bundled module came from (under its last node_modules), or null. */
export function packageDirOf(id) {
  const path = String(id).replace(/^\0+/, '').split('?')[0].replace(/\\/g, '/')
  const at = path.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const parts = path.slice(at + '/node_modules/'.length).split('/')
  if (!parts[0] || (parts[0].startsWith('@') && !parts[1])) return null
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  return `${path.slice(0, at)}/node_modules/${name}`
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses))
    return pkg.licenses
      .map((l) => (typeof l === 'string' ? l : l?.type))
      .filter(Boolean)
      .join(' OR ')
  return 'UNKNOWN'
}

/**
 * The packages of these module ids: name, version, licence and the text of their licence files,
 * one entry per name and version, sorted.
 */
export function packagesOf(moduleIds) {
  const found = new Map()
  for (const id of moduleIds) {
    const dir = packageDirOf(id)
    if (!dir || !existsSync(join(dir, 'package.json'))) continue
    let pkg
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (typeof pkg.name !== 'string') continue
    const key = `${pkg.name}@${pkg.version ?? ''}`
    if (found.has(key)) continue
    const texts = readdirSync(dir)
      .filter((f) => LICENSE_FILE.test(f))
      .sort()
      .map((f) => readFileSync(join(dir, f), 'utf8').slice(0, MAX_TEXT).trim())
      .filter(Boolean)
    found.set(key, { name: pkg.name, version: String(pkg.version ?? ''), license: licenseOf(pkg), texts })
  }
  return mergePackages([...found.values()])
}

/** Several builds' lists as one: one entry per name and version, sorted. */
export function mergePackages(...lists) {
  const byKey = new Map()
  for (const list of lists) for (const p of list) byKey.set(`${p.name}@${p.version}`, p)
  return [...byKey.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  )
}

/**
 * Review of the ops fixes (I4): Node.js itself, which the standalone binaries and the image are
 * made of — its LICENSE file covers V8, OpenSSL, ICU, libuv and the rest it bundles. Read beside the
 * program that runs the build (an install keeps it next to node.exe, or one folder up from bin/node);
 * where none is found, the entry says where it is published.
 */
export function nodePackage(execPath = process.execPath, version = process.version) {
  const v = version.replace(/^v/, '')
  const places = [join(dirname(execPath), 'LICENSE'), join(dirname(dirname(execPath)), 'LICENSE')]
  const found = places.find((p) => existsSync(p))
  const text = found
    ? readFileSync(found, 'utf8').trim()
    : `See https://github.com/nodejs/node/blob/v${v}/LICENSE`
  return { name: 'node', version: v, license: 'MIT AND others (see below)', texts: [text] }
}

/** The notices file: a heading, then each package with its licence's own words. */
export function renderNotices(packages) {
  const out = [
    'THIRD-PARTY NOTICES',
    '',
    'Mongo Manager includes the following third-party software, each under its own licence.',
    '',
  ]
  for (const p of packages) {
    out.push('='.repeat(78), `${p.name} ${p.version}`, `License: ${p.license}`, '')
    if (p.texts.length) out.push(p.texts.join('\n\n---\n\n'), '')
    else out.push('(The package ships no licence file; see its licence identifier above.)', '')
  }
  return `${out.join('\n')}\n`
}

/** A package's folder, looked up from the working directory as Node would (node_modules upwards). */
function installedDir(name) {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(dir) === dir) return null
  }
}

/**
 * A Vite plugin: writes the packages the build's output was made from to `third-party.json`.
 * `also`: packages whose code reaches the output another way than as a module (Tailwind's CSS,
 * written by its own plugin). `data`: files bundled from outside node_modules, each with the entry
 * the notices give it, listed when the build read the file (W2: the Schema map's world outline).
 */
export function thirdPartyList(also = [], data = []) {
  return {
    name: 'mongo-manager:third-party',
    apply: 'build',
    generateBundle(_options, bundle) {
      // Every module the build read, not only those rendered: a package that only re-exports another
      // (vue) and CSS pulled in by @import (tailwindcss) ship too (review of the ops fixes, M1).
      const ids = [
        ...this.getModuleIds(),
        ...also
          .map(installedDir)
          .filter(Boolean)
          .map((d) => `${d}/package.json`),
      ]
      for (const item of Object.values(bundle)) if (item.type === 'chunk') ids.push(...item.moduleIds)
      const read = ids.map((id) => String(id).split('?')[0].replace(/\\/g, '/'))
      const bundled = data.filter((d) => read.some((id) => id.endsWith(`/${d.file}`))).map((d) => d.entry)
      this.emitFile({
        type: 'asset',
        fileName: 'third-party.json',
        source: JSON.stringify(mergePackages(packagesOf(ids), bundled)),
      })
    },
  }
}

/** The names among `required` that a notices list leaves out (a build that lost track of its packages). */
export function missingPackages(packages, required) {
  const names = new Set(packages.map((p) => p.name))
  return required.filter((n) => !names.has(n))
}
