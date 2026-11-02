import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { firstPluginFolder } from '@mongo-manager/server'

/**
 * The web app shipped inside the package (`<package>/public`). The build maps `import.meta.dirname`
 * to the bundle's own directory; when running from source it points at `src`, where no build
 * exists, and the server falls back to the monorepo's `packages/web/dist`.
 */
export function packagedWebRoot(): string | undefined {
  const root = join(import.meta.dirname, '..', 'public')
  return existsSync(join(root, 'index.html')) ? root : undefined
}

/**
 * Phase 4b §4: the plugins shipped inside the package (`<package>/plugins`), when it has them. The
 * standalone binary has none (its files are in memory; plugins are uploaded there).
 */
export function packagedBundledPlugins(): string | undefined {
  return firstPluginFolder([join(import.meta.dirname, '..', 'plugins')])
    ? join(import.meta.dirname, '..', 'plugins')
    : undefined
}
