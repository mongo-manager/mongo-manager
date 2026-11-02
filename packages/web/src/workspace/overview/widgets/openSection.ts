import { useQuery } from '@tanstack/vue-query'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useTabsStore } from '@/stores/tabs'
import { useTabSectionsStore } from '@/stores/tabSections'
import { openConnectionTab } from '@/workspace/openTabs'

/** Widgets wave 2: opens a connection's tab at one of its sections (a widget's "see all"). */
export function useOpenSection(): (connectionId: string, section: string) => void {
  const tabs = useTabsStore()
  const sections = useTabSectionsStore()
  const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
  return (connectionId, section) => {
    const c = connections.data.value?.find((x) => x.id === connectionId)
    if (!c) return
    sections.set(openConnectionTab(tabs, c), section)
  }
}
