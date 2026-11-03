<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Check, Plus } from 'lucide-vue-next'
import { DASHBOARD_LIMITS, type WidgetType } from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useDashboardStore } from '@/stores/dashboard'
import { WIDGET_GROUPS, WIDGETS, type WidgetDef } from './widgets/registry'

/**
 * User review 2026-10-09 ("ekstra widgetlar ekle"): the widgets the Overview offers, by group, each
 * with what it shows; one of a kind already there says so; settings are asked before it is added.
 */
defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; add: [def: WidgetDef] }>()
const { t } = useI18n()
const store = useDashboardStore()
const groups = computed(() =>
  WIDGET_GROUPS.map((group) => ({
    group,
    defs: Object.values(WIDGETS).filter((d): d is WidgetDef => !!d && d.group === group),
  })).filter((g) => g.defs.length > 0),
)
const present = (type: WidgetType) => store.widgets.some((w) => w.type === type)
// User report 2026-10-27: a server's widget that is there for every server the user may watch.
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
function onEveryServer(d: WidgetDef): boolean {
  if (d.settings !== 'connection') return false
  const allowed = (connections.data.value ?? []).filter((c) =>
    c.permissions.includes(d.permission ?? 'server:monitor'),
  )
  return (
    allowed.length > 0 &&
    allowed.every((c) => store.shownBy({ type: d.type, settings: { connectionId: c.id } }))
  )
}
const full = computed(() => store.widgets.length >= DASHBOARD_LIMITS.widgets)
</script>

<template>
  <DsDialog
    :open="open"
    size="lg"
    :title="t('overview.dashboard.gallery.title')"
    :description="t('overview.dashboard.gallery.description')"
    @close="emit('close')"
  >
    <div data-widget-gallery class="flex flex-col gap-5">
      <p v-if="full" role="status" class="rounded-lg bg-warning-soft px-3 py-2 text-ui text-warning">
        {{ t('overview.dashboard.full', { n: DASHBOARD_LIMITS.widgets }) }}
      </p>
      <section v-for="g in groups" :key="g.group" :aria-labelledby="`gallery-${g.group}`">
        <h3
          :id="`gallery-${g.group}`"
          class="mb-2 text-caption font-semibold tracking-wide text-fg-subtle uppercase"
        >
          {{ t(`overview.dashboard.gallery.groups.${g.group}`) }}
        </h3>
        <ul class="grid gap-2 sm:grid-cols-2">
          <li
            v-for="d in g.defs"
            :key="d.type"
            :data-gallery="d.type"
            class="flex items-start gap-3 rounded-xl border border-line bg-surface p-3"
          >
            <span
              class="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-fg"
              aria-hidden="true"
            >
              <component :is="d.icon" class="size-4" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-ui font-medium text-fg">{{ t(d.title) }}</span>
              <span class="block text-small text-fg-subtle">{{ t(d.description) }}</span>
            </span>
            <span
              v-if="(!d.many && present(d.type)) || onEveryServer(d)"
              class="inline-flex shrink-0 items-center gap-1 text-small text-fg-subtle"
            >
              <Check class="size-3.5" aria-hidden="true" />{{
                d.many ? t('overview.dashboard.gallery.everyServer') : t('overview.dashboard.gallery.added')
              }}
            </span>
            <DsButton
              v-else
              size="sm"
              :icon="Plus"
              :disabled="full"
              :aria-label="t('overview.dashboard.gallery.addNamed', { title: t(d.title) })"
              @click="emit('add', d)"
            >
              {{ t('overview.dashboard.gallery.add') }}
            </DsButton>
          </li>
        </ul>
      </section>
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
    </template>
  </DsDialog>
</template>
