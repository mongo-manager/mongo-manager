import type { LaunchDeps } from './run'

/**
 * A settled version whose files no longer verify: downloaded again, as its release signed it
 * (updater, 2026-11-03). Never with updates turned off — MM_UPDATES here, and the configuration's
 * own setting, which the caller checks (final review, I5) — so that promise of no request holds.
 */
export async function repairVersion(version: string, deps: LaunchDeps): Promise<boolean> {
  if (!deps.download || /^(off|0|false|no)$/i.test(deps.env.MM_UPDATES ?? '')) return false
  const log = deps.log ?? ((m: string) => void process.stderr.write(`${m}\n`))
  log(`Mongo Manager ${version} is downloaded again from its release.`)
  try {
    return await deps.download(version)
  } catch (e) {
    log(`Mongo Manager ${version} could not be downloaded again: ${(e as Error).message}`)
    return false
  }
}
