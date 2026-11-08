// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * The static service files in deploy/ are generated from the same renderers `service install`
 * uses, so they never drift. Regenerate with: node packages/cli/scripts/deploy-files.mjs
 */
export async function staticUnits() {
  const { renderSystemdUnit, renderLaunchdPlist } = await import('../src/service/render.ts')
  const { layoutFor } = await import('../src/service/layout.ts')
  const linux = layoutFor('linux', {})
  const mac = layoutFor('darwin', {})
  return {
    'deploy/systemd/mongo-manager.service': renderSystemdUnit({
      command: [`${linux.programDir}/bin/node`, `${linux.programDir}/dist/cli.cjs`],
      config: linux.configFile,
      dataDir: linux.dataDir,
      user: linux.defaultUser,
      envFile: linux.envFile,
      logFile: null,
    }),
    'deploy/launchd/com.mongo-manager.server.plist': renderLaunchdPlist({
      command: [`${mac.programDir}/bin/node`, `${mac.programDir}/dist/cli.cjs`],
      config: mac.configFile,
      dataDir: mac.dataDir,
      user: mac.defaultUser,
      envFile: null,
      logFile: mac.logFile,
    }),
  }
}

if (import.meta.main) {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const root = join(import.meta.dirname, '..', '..', '..')
  for (const [path, text] of Object.entries(await staticUnits())) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
    console.log(`wrote ${path}`)
  }
}
