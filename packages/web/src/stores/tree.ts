import { ref } from 'vue'
import { defineStore } from 'pinia'

/** Stable key for a tree node; JSON keeps names with any characters unambiguous. */
export const treeKey = (...parts: string[]): string => JSON.stringify(parts)

export const useTreeStore = defineStore('tree', () => {
  const expanded = ref(new Set<string>())
  /** The one tree item in the tab order (roving tabindex). */
  const focused = ref<string | null>(null)

  const isExpanded = (key: string): boolean => expanded.value.has(key)

  function setExpanded(key: string, value: boolean): void {
    if (isExpanded(key) === value) return
    const next = new Set(expanded.value)
    if (value) next.add(key)
    else next.delete(key)
    expanded.value = next
  }

  const toggle = (key: string): void => setExpanded(key, !isExpanded(key))

  /** Forget everything (sign-out: the next user starts with a collapsed tree). */
  function reset(): void {
    expanded.value = new Set()
    focused.value = null
  }

  return { expanded, focused, isExpanded, setExpanded, toggle, reset }
})
