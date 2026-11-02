<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Lock, ServerOff, Settings2, Trash2 } from 'lucide-vue-next'
import { connectionsApi, queryKeys } from '@/api/connections'
import DsButton from '@/ds/DsButton.vue'
import WidgetFrame from './WidgetFrame.vue'
import { useWidget } from './context'

/**
 * User review 2026-10-09: a widget about one connection's server. Its title names the connection;
 * a connection gone, or one whose server the user may not watch (server:monitor), says so and offers
 * Settings and Remove — and its body (which reads the server) is never shown, so nothing is asked.
 */
/** `titleKey`: the widget's title, an i18n key (a metric widget's names its metric). */
const props = withDefaults(
  defineProps<{
    titleKey: string
    body: Component
    /** What the user needs on the connection: watching its server, or reading its databases. */
    permission?: 'server:monitor' | 'databases:read' | 'aggregation:run'
  }>(),
  { permission: 'server:monitor' },
)
const { t } = useI18n()
const widget = useWidget()
const settings = computed(() => (widget?.value.widget.settings ?? {}) as { connectionId?: string })
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connection = computed(() => connections.data.value?.find((c) => c.id === settings.value.connectionId))
const state = computed<'loading' | 'gone' | 'forbidden' | 'ready'>(() => {
  if (!connections.data.value) return 'loading'
  if (!connection.value) return 'gone'
  return connection.value.permissions.includes(props.permission) ? 'ready' : 'forbidden'
})
const shownTitle = computed(() =>
  connection.value
    ? t('overview.widgets.titled', { title: t(props.titleKey), connection: connection.value.name })
    : t(props.titleKey),
)
</script>

<template>
  <WidgetFrame :title="shownTitle">
    <component :is="body" v-if="state === 'ready'" :connection-id="settings.connectionId" />
    <div v-else-if="state !== 'loading'" data-widget-state class="flex flex-col items-start gap-3 py-1">
      <p class="flex items-start gap-2 text-ui text-fg-muted">
        <component
          :is="state === 'gone' ? ServerOff : Lock"
          class="mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        {{
          state === 'gone'
            ? t('overview.widgets.connectionGone')
            : permission === 'databases:read'
              ? t('overview.widgets.databasesNotPermitted')
              : permission === 'aggregation:run'
                ? t('overview.widgets.aggregationNotPermitted')
                : t('overview.widgets.notPermitted')
        }}
      </p>
      <div v-if="widget" class="flex flex-wrap gap-2">
        <DsButton size="sm" class="pointer-coarse:h-11" :icon="Settings2" @click="widget.configure()">{{
          t('overview.dashboard.settings')
        }}</DsButton>
        <DsButton
          size="sm"
          variant="ghost"
          class="pointer-coarse:h-11"
          :icon="Trash2"
          @click="widget.remove()"
          >{{ t('overview.dashboard.remove') }}</DsButton
        >
      </div>
    </div>
  </WidgetFrame>
</template>
