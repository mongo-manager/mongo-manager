<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { CloudUpload, Plus, RotateCcw, Search, SearchX } from 'lucide-vue-next'
import { DESTINATION_ICON } from './icons'
import DsButton from '@/ds/DsButton.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import { destinationKeys, destinationsApi } from '@/api/destinations'
import { useDestinationError, useReasonText } from './errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { DESTINATION_TYPES, type DestinationType, type DestinationView } from '@mongo-manager/shared/browser'
import DestinationCard from './DestinationCard.vue'
import DestinationEditor from './DestinationEditor.vue'

/** Phase 3d-3b D1: the administrators' destinations — cards, an explaining empty state, search past six. */
const { t } = useI18n()
const destinationError = useDestinationError()
const list = useQuery({ queryKey: destinationKeys.admin, queryFn: () => destinationsApi.all() })
const filter = ref('')
const shown = computed(() =>
  (list.data.value ?? []).filter((d) => d.name.toLowerCase().includes(filter.value.trim().toLowerCase())),
)
const TYPES = DESTINATION_TYPES.map((type) => ({ type, icon: DESTINATION_ICON[type] }))
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const toasts = useToastStore()
const editor = ref<{ existing?: DestinationView; startType?: DestinationType } | null>(null)
const add = (startType?: DestinationType) => (editor.value = startType ? { startType } : {})
const reasonWords = useReasonText()
/** Final review C12: a test can take up to two minutes; its card says so and a second click waits. */
const testing = ref(new Set<string>())
async function test(d: DestinationView): Promise<void> {
  if (testing.value.has(d.id)) return
  testing.value = new Set([...testing.value, d.id])
  try {
    const out = await destinationsApi.testSaved(d.id)
    const failed = out.steps.find((s) => !s.ok && s.reason !== 'skipped')
    toasts.push(
      failed
        ? {
            kind: 'error',
            message: t('destinations.testResult.failed', {
              name: d.name,
              reason: reasonWords(failed.reason, d.type, failed),
            }),
          }
        : { kind: 'success', message: t('destinations.testResult.ok', { name: d.name }) },
    )
  } catch (e) {
    toasts.push({ kind: 'error', message: destinationError(e, d.type) })
  } finally {
    const next = new Set(testing.value)
    next.delete(d.id)
    testing.value = next
    await queryClient.invalidateQueries({ queryKey: destinationKeys.all })
  }
}
// Final review C20: card times follow the clock.
const now = ref(Date.now())
const tick = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => clearInterval(tick))
// The search box shows past six destinations; once it hides, its filter no longer applies.
const searchable = computed(() => (list.data.value?.length ?? 0) > 6)
watch(searchable, (on) => {
  if (!on) filter.value = ''
})
async function remove(d: DestinationView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('destinations.editor.deleteTitle', { name: d.name }),
    message: t('destinations.editor.deleteHelp'),
    confirmLabel: t('destinations.editor.deleteConfirm'),
    danger: true,
  })
  if (!ok) return
  try {
    await destinationsApi.remove(d.id)
    await queryClient.invalidateQueries({ queryKey: destinationKeys.all })
  } catch (e) {
    toasts.push({ kind: 'error', message: destinationError(e) })
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <DsPageHeader
      :title="t('destinations.title')"
      :icon="CloudUpload"
      :description="t('destinations.subtitle')"
    >
      <template #actions>
        <DsInput
          v-if="searchable"
          v-model="filter"
          class="w-56 max-w-full"
          type="search"
          size="sm"
          :icon="Search"
          :label="t('destinations.search')"
          hide-label
          :placeholder="t('destinations.search')"
        />
        <DsButton v-if="list.data.value?.length" size="sm" variant="primary" @click="add()"
          ><Plus class="size-4" aria-hidden="true" />{{ t('destinations.add') }}</DsButton
        >
      </template>
    </DsPageHeader>
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
        <div
          v-if="list.isPending.value"
          class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
          aria-busy="true"
        >
          <span class="sr-only" role="status">{{ t('app.loading') }}</span
          ><DsSkeleton v-for="n in 3" :key="n" class="h-44 rounded-card" />
        </div>
        <DsCallout v-else-if="list.isError.value" tone="danger"
          >{{ destinationError(list.error.value)
          }}<template #action
            ><DsButton size="sm" :loading="list.isFetching.value" @click="list.refetch()"
              ><RotateCcw class="size-4" aria-hidden="true" />{{ t('common.retry') }}</DsButton
            ></template
          ></DsCallout
        >
        <section
          v-else-if="!list.data.value?.length"
          class="flex flex-col items-center gap-6 rounded-card border border-dashed border-line-strong px-6 py-12 text-center"
        >
          <div class="flex max-w-xl flex-col gap-2">
            <h3 class="text-title-s font-semibold text-fg">
              {{ t('destinations.empty.title') }}
            </h3>
            <p class="text-ui text-fg-subtle">{{ t('destinations.empty.help') }}</p>
          </div>
          <div class="grid w-full max-w-3xl gap-3 sm:grid-cols-2">
            <button
              v-for="x in TYPES"
              :key="x.type"
              type="button"
              class="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-4 text-left transition-colors duration-150 hover:border-accent hover:bg-accent-soft/40 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              @click="add(x.type)"
            >
              <component :is="x.icon" class="mt-0.5 size-5 shrink-0 text-accent-fg" aria-hidden="true" />
              <span>
                <span class="block font-medium text-fg">{{ t(`destinations.type.${x.type}`) }}</span>
                <span class="block text-ui text-fg-subtle">{{ t(`destinations.type.${x.type}Help`) }}</span>
              </span>
            </button>
          </div>
          <DsButton variant="primary" @click="add()"
            ><Plus class="size-4" aria-hidden="true" />{{ t('destinations.add') }}</DsButton
          >
        </section>
        <div
          v-else-if="!shown.length"
          role="status"
          class="flex flex-col items-center gap-3 rounded-card border border-dashed border-line-strong px-6 py-10 text-center"
        >
          <SearchX class="size-6 text-fg-subtle" aria-hidden="true" />
          <p class="text-ui text-fg-muted">
            {{ t('destinations.noMatch', { filter: filter.trim() }) }}
          </p>
          <DsButton size="sm" variant="ghost" @click="filter = ''">{{
            t('destinations.clearSearch')
          }}</DsButton>
        </div>
        <TransitionGroup
          v-else
          tag="div"
          class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
          enter-active-class="transition duration-200 motion-reduce:transition-none"
          enter-from-class="translate-y-1 opacity-0"
          leave-active-class="transition duration-150 motion-reduce:transition-none"
          leave-to-class="opacity-0"
        >
          <DestinationCard
            v-for="d in shown"
            :key="d.id"
            :destination="d"
            :testing="testing.has(d.id)"
            :now="now"
            @edit="editor = { existing: d }"
            @test="test(d)"
            @remove="remove(d)"
          />
        </TransitionGroup>
        <DestinationEditor v-if="editor" v-bind="editor" @close="editor = null" />
      </div>
    </div>
  </div>
</template>
