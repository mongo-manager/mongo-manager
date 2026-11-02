import { copyFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rolldown } from 'rolldown'
import { missingModulesPlugin } from './missing-module.mjs'
import {
  mergePackages,
  missingPackages,
  nodePackage,
  packagesOf,
  renderNotices,
} from '../../../scripts/third-party.mjs'
import { ownModulesGuard } from '../../../scripts/own-modules.mjs'

const pkg = join(import.meta.dirname, '..')
const web = join(pkg, '..', 'web', 'dist')
if (!existsSync(join(web, 'index.html'))) {
  console.error('packages/web/dist is missing: run "pnpm --filter @mongo-manager/web build" first')
  process.exit(1)
}

rmSync(join(pkg, 'dist'), { recursive: true, force: true })
const bundle = await rolldown({
  input: join(pkg, 'src', 'bin.ts'),
  platform: 'node',
  logLevel: 'warn',
  transform: { define: { 'import.meta.dirname': '__dirname' } },
  // W8: kerberos and mongodb-client-encryption load from where the CLI is installed, when the user
  // installed them there (missing-module.mjs); every other optional add-on stays stubbed.
  plugins: [missingModulesPlugin({ installable: true })],
})
const { output } = await bundle.write({
  file: join(pkg, 'dist', 'cli.cjs'),
  format: 'cjs',
  codeSplitting: false,
  // Security review 2026-10-20 (critical): it loads no package from a node_modules above it.
  banner: `#!/usr/bin/env node\n${ownModulesGuard()}`,
})
await bundle.close()
const cliPackages = packagesOf(output.flatMap((o) => (o.type === 'chunk' ? o.moduleIds : [])))

rmSync(join(pkg, 'public'), { recursive: true, force: true })
cpSync(web, join(pkg, 'public'), { recursive: true })
// Phase 4b §4: the first-party plugins, next to the bundle (found disabled until approved).
const plugins = join(pkg, '..', 'plugins', 'dist')
if (!existsSync(join(plugins, 'geojson-map', 'mongo-manager-plugin.json'))) {
  console.error(
    'packages/plugins/dist is missing: run "pnpm --filter @mongo-manager/plugin-geojson-map build" first',
  )
  process.exit(1)
}
rmSync(join(pkg, 'plugins'), { recursive: true, force: true })
// Only the plugins of this repository (packages/plugins/<name>, by the id their manifest gives):
// a folder left in the build output by an older build is never shipped.
for (const name of readdirSync(join(pkg, '..', 'plugins'), { withFileTypes: true })) {
  const manifest = join(pkg, '..', 'plugins', name.name, 'public', 'mongo-manager-plugin.json')
  if (!name.isDirectory() || !existsSync(manifest)) continue
  const { id } = JSON.parse(readFileSync(manifest, 'utf8'))
  if (!existsSync(join(plugins, id, 'mongo-manager-plugin.json'))) {
    console.error(`packages/plugins/dist/${id} is missing: build the plugin first`)
    process.exit(1)
  }
  cpSync(join(plugins, id), join(pkg, 'plugins', id), { recursive: true })
}
copyFileSync(join(pkg, '..', '..', 'LICENSE'), join(pkg, 'LICENSE'))

// Phase 3a-1: build the shell worker and ship it next to cli.cjs, so npm and the SEA both have it.
const server = join(pkg, '..', 'server')
const shellBuild = spawnSync(process.execPath, [join(server, 'scripts', 'build-shell-worker.mjs')], {
  stdio: 'inherit',
})
if (shellBuild.status !== 0) process.exit(shellBuild.status ?? 1)
copyFileSync(join(server, 'dist', 'shell-worker.cjs'), join(pkg, 'dist', 'shell-worker.cjs'))

// Security review 2026-10-13 (ops): the licences of everything bundled, in one file beside it. Each
// build listed the packages its output was made from; the lists stay out of what ships.
const listed = (file) => {
  if (!existsSync(file)) {
    console.error(`${file} is missing: rebuild it (its build lists the packages it is made of)`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}
const lists = [cliPackages, listed(join(server, 'dist', 'shell-worker.third-party.json'))]
lists.push(listed(join(pkg, 'public', 'third-party.json')))
rmSync(join(pkg, 'public', 'third-party.json'))
for (const id of readdirSync(join(pkg, 'plugins'))) {
  const file = join(pkg, 'plugins', id, 'third-party.json')
  lists.push(listed(file))
  rmSync(file)
}
// Node.js itself: the standalone binaries and the image are made of it (review of the ops fixes, I4).
lists.push([nodePackage()])
const notices = mergePackages(...lists)
// A build that lost track of its packages would ship notices short of what it bundles (review M1).
const lost = missingPackages(notices, ['node', 'vue', 'tailwindcss', 'pinia', 'fastify', 'mongodb', 'zod'])
if (lost.length) {
  console.error(`THIRD-PARTY-NOTICES would leave out ${lost.join(', ')}: the builds did not list them`)
  process.exit(1)
}
writeFileSync(join(pkg, 'dist', 'THIRD-PARTY-NOTICES.txt'), renderNotices(notices))
console.log(
  'built packages/cli/dist/cli.cjs, dist/shell-worker.cjs, dist/THIRD-PARTY-NOTICES.txt, packages/cli/public and packages/cli/plugins',
)
