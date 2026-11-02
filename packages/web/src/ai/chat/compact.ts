import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * Review of the floating window (I4): a phone, or a screen too short for a window over the page — there
 * the assistant takes the whole screen, as a modal dialog.
 */
export const COMPACT_QUERY = '(max-width: 639.98px), (max-height: 559.98px)'

export function isCompactNow(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    !!window.matchMedia(COMPACT_QUERY)?.matches
  )
}

/** Whether the screen is compact, kept as it changes. */
export function useCompactScreen(): Ref<boolean> {
  const compact = ref(isCompactNow())
  let media: MediaQueryList | null = null
  const onChange = (e: MediaQueryListEvent) => (compact.value = e.matches)
  onMounted(() => {
    if (typeof window.matchMedia !== 'function') return
    media = window.matchMedia(COMPACT_QUERY)
    compact.value = !!media?.matches
    media?.addEventListener?.('change', onChange)
  })
  onBeforeUnmount(() => media?.removeEventListener?.('change', onChange))
  return compact
}
