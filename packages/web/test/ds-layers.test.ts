import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The z-index of a component's floating layer, from its class list. */
function layer(file: string, marker: string): number {
  const source = readFileSync(join(process.cwd(), 'src', file), 'utf8')
  const line = source.split('\n').find((l) => l.includes(marker) && /\bz-/.test(l))
  const z = line?.match(/\bz-(?:\[(\d+)\]|(\d+))/)
  if (!z) throw new Error(`No z-index in ${file}`)
  return Number(z[1] ?? z[2])
}

describe('layers (reviewer C Minor 6)', () => {
  const dialogs = [
    layer('ds/DsDialog.vue', 'fixed inset-0'),
    layer('ds/DsSheet.vue', 'fixed inset-0'),
    layer('workspace/CommandPalette.vue', 'fixed inset-0'),
  ]
  // Teleported to the body: inside a dialog they must still be drawn above it.
  const floating = {
    tooltip: layer('ds/DsTooltip.vue', 'fixed'),
    menu: layer('ds/DsMenu.vue', 'fixed'),
    combobox: layer('ds/DsCombobox.vue', 'fixed'),
    popover: layer('ds/DsPopover.vue', 'fixed'),
  }
  for (const [name, z] of Object.entries(floating))
    it(`draws the ${name} above every dialog, and below the toasts`, () => {
      expect(z).toBeGreaterThan(Math.max(...dialogs))
      expect(z).toBeLessThan(layer('ds/DsToastHost.vue', 'fixed'))
    })
})
