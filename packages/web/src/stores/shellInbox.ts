import { ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * Phase 3a-2: a snippet opened from the Library or the palette, waiting for its connection's shell
 * tab. The tab takes it (once) and shows the parameter form; nothing runs by itself.
 */
export const useShellInbox = defineStore('shellInbox', () => {
  const pending = ref<Record<string, string>>({})

  function deliver(connectionId: string, snippetId: string): void {
    pending.value = { ...pending.value, [connectionId]: snippetId }
  }

  function take(connectionId: string): string | null {
    const id = pending.value[connectionId] ?? null
    if (id !== null) {
      const next = { ...pending.value }
      delete next[connectionId]
      pending.value = next
    }
    return id
  }

  return { pending, deliver, take }
})
