<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ShieldCheck } from 'lucide-vue-next'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import { connectionsApi, queryKeys } from '@/api/connections'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { collationLocales } from './collationLocales'
import { decodeValue } from '@/documents/values'

/**
 * W2.4 (2026-10-16): Edit collection — change-stream pre/post images on or off (collMod), confirmed
 * with the collection named. Its default collation is shown (MongoDB fixes it at creation);
 * validation stays in the Validation tab.
 */
const props = defineProps<{ connectionId: string; db: string; coll: string; tabId?: string }>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const toasts = useToastStore()

const { data: collections, isPending } = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, props.db)),
  queryFn: () => connectionsApi.collections(props.connectionId, props.db),
})
const info = computed(() => collections.value?.find((c) => c.name === props.coll))
const current = computed(() => {
  const images = info.value?.options.changeStreamPreAndPostImages as { enabled?: unknown } | undefined
  return images?.enabled === true
})
const images = ref(false)
watch(current, (on) => (images.value = on), { immediate: true })

const collationText = computed(() => {
  // The options are canonical EJSON: the strength comes as { $numberInt: "2" }.
  const raw = info.value?.options.collation
  const c = raw === undefined ? undefined : (decodeValue(raw) as Record<string, unknown>)
  if (!c || typeof c.locale !== 'string') return t('collection.edit.noCollation')
  const name =
    collationLocales(locale.value, t('collection.collation.simple')).find((l) => l.value === c.locale)
      ?.label ?? c.locale
  const strength = Number((c.strength as { valueOf(): unknown } | undefined)?.valueOf())
  return Number.isInteger(strength)
    ? t('collection.edit.collationWithStrength', { locale: name, strength })
    : name
})

const busy = ref(false)
const errors = ref<string[]>([])
async function save(): Promise<void> {
  if (busy.value) return
  if (images.value === current.value) return emit('close')
  const ok = await dialogs.confirm({
    title: images.value ? t('collection.edit.onTitle') : t('collection.edit.offTitle'),
    message: images.value
      ? t('collection.edit.onMessage', { name: props.coll })
      : t('collection.edit.offMessage', { name: props.coll }),
    confirmLabel: images.value ? t('collection.edit.turnOn') : t('collection.edit.turnOff'),
    danger: !images.value,
  })
  if (!ok) return
  busy.value = true
  errors.value = []
  try {
    await connectionsApi.setCollectionOptions(props.connectionId, props.db, props.coll, {
      changeStreamPreAndPostImages: images.value,
      confirm: props.coll,
    })
    await queryClient.invalidateQueries({
      queryKey: queryKeys.collections(props.connectionId, props.db),
      exact: true,
    })
    toasts.push({
      kind: 'success',
      message: images.value
        ? t('collection.edit.onDone', { name: props.coll })
        : t('collection.edit.offDone', { name: props.coll }),
    })
    emit('close')
  } catch (e) {
    errors.value = [describeError(e, t)]
  } finally {
    busy.value = false
  }
}
function openValidation(): void {
  if (props.tabId) useCollectionViewsStore().stateFor(props.tabId).section = 'validation'
  emit('close')
}
</script>

<template>
  <DsDialog open :title="t('collection.edit.title', { name: coll })" size="md" @close="emit('close')">
    <div v-if="isPending" class="flex flex-col gap-2" aria-hidden="true">
      <DsSkeleton v-for="i in 3" :key="i" class="h-6" />
    </div>
    <form v-else class="flex flex-col gap-5" novalidate @submit.prevent="save">
      <DsSwitch v-model="images" :label="t('collection.preImages')" :hint="t('collection.preImagesHint')" />
      <dl class="grid gap-x-4 gap-y-2 rounded-lg bg-subtle p-3 text-ui sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt class="text-fg-muted">{{ t('collection.collation.title') }}</dt>
        <dd data-collation-shown class="min-w-0 text-fg">
          {{ collationText }}
          <span class="block text-small text-fg-subtle">{{ t('collection.edit.collationFixed') }}</span>
        </dd>
        <dt class="text-fg-muted">{{ t('collection.edit.validation') }}</dt>
        <dd class="min-w-0 text-fg">
          <span class="block text-small text-fg-subtle">{{ t('collection.edit.validationHint') }}</span>
          <DsButton v-if="tabId" size="sm" class="mt-1.5" :icon="ShieldCheck" @click="openValidation">
            {{ t('collection.edit.openValidation') }}
          </DsButton>
        </dd>
      </dl>
      <DsFormErrors :messages="errors" />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="busy" :disabled="isPending" @click="save">
        {{ t('collection.edit.save') }}
      </DsButton>
    </template>
  </DsDialog>
</template>
