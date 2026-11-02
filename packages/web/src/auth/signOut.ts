import { useQueryClient } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useTabsStore } from '@/stores/tabs'
import { useTreeStore } from '@/stores/tree'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { useTabSectionsStore } from '@/stores/tabSections'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import { useAssistantStore } from '@/ai/chat/store'
import { usePlacesStore } from '@/stores/places'
import { useDashboardStore } from '@/stores/dashboard'

/**
 * Sign-out leaves nothing of the previous user behind on a shared machine: cached server data,
 * open tabs and the workspace itself are gone before the login screen appears.
 */
export function useSignOut(): () => Promise<void> {
  const session = useSessionStore()
  const tabs = useTabsStore()
  const tree = useTreeStore()
  const views = useCollectionViewsStore()
  const tabSections = useTabSectionsStore()
  const dialogs = useWorkspaceDialogs()
  const assistant = useAssistantStore()
  const places = usePlacesStore()
  const dashboard = useDashboardStore()
  const router = useRouter()
  const queryClient = useQueryClient()
  return async () => {
    // A dashboard change waiting to be saved is saved while the session still allows it.
    await dashboard.flush().catch(() => undefined)
    try {
      await session.logout()
    } finally {
      // UI redesign R1: the workspace unmounts at once, so no screen of it asks the server again.
      session.me = null
      queryClient.clear()
      tabs.reset()
      places.reset()
      dashboard.reset()
      tree.reset()
      views.reset()
      tabSections.reset()
      // Phase 4a-2, C8: no chat stays behind on a shared machine.
      assistant.reset()
      dialogs.close()
      await router.replace({ name: 'login' })
    }
  }
}
