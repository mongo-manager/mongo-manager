// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { powershellArgs } from '@mongo-manager/server'
import type { Sys } from './sys'

const DONE = 'MM-PS-DONE'
const INPUT = 'MM_PS_INPUT'

export interface PowerShellResult {
  /** The script ran to its end: no error stopped it (fail closed otherwise). */
  ok: boolean
  lines: string[]
  error: string
}

/**
 * Runs a fixed PowerShell script with data that never becomes code. powershell.exe re-parses
 * extra command-line arguments as PowerShell (a path with spaces splits, `;` or `$(...)` runs), so
 * the script goes as -EncodedCommand and the data as JSON in an environment variable, read as
 * `$in`. Any error stops the script, and success requires the marker it prints last. It imports
 * the modules it uses (see powershellArgs): `modules`, beyond those every script imports.
 */
export function runPowerShell(
  sys: Sys,
  script: string,
  data: unknown,
  modules: string[] = [],
): PowerShellResult {
  const full = `# A plain, readable message on stderr and a failing exit code (not a CLIXML record).
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
$in = $env:${INPUT} | ConvertFrom-Json
${script}
'${DONE}'`
  const r = sys.run('powershell', powershellArgs(full, modules), { env: { [INPUT]: JSON.stringify(data) } })
  const lines = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const ok = r.status === 0 && lines.at(-1) === DONE
  return { ok, lines: ok ? lines.slice(0, -1) : lines, error: (r.stderr || r.stdout).trim() }
}
