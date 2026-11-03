import type { RebindableAction, ShortcutBindings } from '@mongo-manager/shared/browser'
import { api } from './client'

/** W5: the signed-in user's own bindings of the global keyboard shortcuts. */
export const shortcutsApi = {
  /** `dropped`: bindings this version could not keep (back to their own keys), named once. */
  get: () => api.get<{ bindings: ShortcutBindings; dropped?: RebindableAction[] }>('me/shortcuts'),
  save: (bindings: ShortcutBindings) => api.put<{ bindings: ShortcutBindings }>('me/shortcuts', { bindings }),
  reset: () => api.delete<void>('me/shortcuts'),
}
