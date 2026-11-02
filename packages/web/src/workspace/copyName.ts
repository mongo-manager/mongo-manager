import { useToastStore } from '@/stores/toasts'

type Translate = (key: string, values?: Record<string, unknown>) => string

/** A name in a toast is cut short; the clipboard gets it whole. */
const MAX_SHOWN = 60

/**
 * W1 (completion §2): "Copy name" on a database, a collection or a field — the plain name, as
 * typed in a query or the shell — said by a toast (text only: names are user data).
 */
export async function copyName(name: string, t: Translate): Promise<void> {
  const toasts = useToastStore()
  try {
    await navigator.clipboard.writeText(name)
    const shown = name.length > MAX_SHOWN ? `${name.slice(0, MAX_SHOWN)}…` : name
    toasts.push({ kind: 'success', message: t('explorer.copyName.copied', { name: shown }) })
  } catch {
    toasts.push({ kind: 'error', message: t('documents.copyFailed') })
  }
}
