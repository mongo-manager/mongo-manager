<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Server } from 'lucide-vue-next'
import { DESTINATION_ICON as ICON } from '@/destinations/icons'
import type { BackupFormat, DestinationSummary } from '@mongo-manager/shared/browser'
import { verificationOf } from './verification'

/** Phase 3d-3b V5: where the backup goes besides this server; incompatible ones say why and offer the fix. */
const props = defineProps<{
  destinations: DestinationSummary[]
  modelValue: string[]
  deleteLocal: boolean
  format: BackupFormat
  /** Phase 3d-3c: a schedule's choice reads "Keep on the server too" (checked = not deleteLocal). */
  keepMode?: boolean
  keepHelp?: string
  plainPersonal: boolean
  /** False where the fix cannot apply (an existing backup cannot be re-encrypted): the reason stays, the button goes. */
  noFix?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [ids: string[]]
  'update:deleteLocal': [on: boolean]
  fix: [kind: 'encrypt']
}>()
const { t, locale } = useI18n()
const uid = useId()
type Why = 'encryptedOnly' | 'personalPlain'
const blocked = (d: DestinationSummary): Why | null =>
  props.format !== 'mmbak' && d.policy.encryptedOnly
    ? 'encryptedOnly'
    : props.format !== 'mmbak' && props.plainPersonal
      ? 'personalPlain'
      : null
const list = (names: string[]) => new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(names)
const rows = computed(() =>
  props.destinations.map((d) => {
    const why = blocked(d)
    return { d, kind: why, on: props.modelValue.includes(d.id) }
  }),
)
/** One sentence per reason, naming every destination it holds back; one fix for all. */
const reasons = computed(() =>
  (['encryptedOnly', 'personalPlain'] as const).flatMap((kind) => {
    const names = rows.value.filter((r) => r.kind === kind).map((r) => r.d.name)
    return names.length
      ? [{ kind, id: `${uid}-${kind}`, text: t(`backup.where.${kind}`, { name: list(names) }, names.length) }]
      : []
  }),
)

/**
 * Phase 3d-3b final review C2: a chosen destination the current format (or data) rules out is
 * dropped from the choice — it would only refuse the start — and held: once the format allows it
 * again (Encrypt), it is chosen again. A destination the user deselects is not held.
 */
const held = ref<string[]>([])
watch(
  () => [props.format, props.plainPersonal, props.destinations, props.modelValue] as const,
  () => {
    const byId = new Map(props.destinations.map((d) => [d.id, d]))
    const out = props.modelValue.filter((id) => {
      const d = byId.get(id)
      return !d || !blocked(d)
    })
    const dropped = props.modelValue.filter((id) => !out.includes(id))
    if (dropped.length) {
      held.value = [...new Set([...held.value, ...dropped])]
      emit('update:modelValue', out)
      return
    }
    const back = held.value.filter((id) => byId.has(id) && !blocked(byId.get(id)!) && !out.includes(id))
    if (back.length) {
      held.value = held.value.filter((id) => !back.includes(id))
      emit('update:modelValue', [...out, ...back])
    }
  },
  { immediate: true },
)

/** The server's copy stays unless the sender lets it go after a verified upload. */
const kept = computed(() => !(props.deleteLocal && props.modelValue.length > 0))
function toggle(id: string, why: Why | null): void {
  held.value = held.value.filter((x) => x !== id)
  // Deselecting is always allowed; a blocked destination is never chosen.
  if (props.modelValue.includes(id))
    emit(
      'update:modelValue',
      props.modelValue.filter((x) => x !== id),
    )
  else if (!why) emit('update:modelValue', [...props.modelValue, id])
}
/** C27: what "verified" means for the chosen destinations that check the size only. */
const sizeOnly = computed(() =>
  props.destinations.filter((d) => props.modelValue.includes(d.id) && verificationOf(d) === 'size'),
)
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap gap-2" role="group" :aria-label="t('backup.where.title')">
      <span
        class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-ui transition-colors duration-150"
        :data-kept="kept"
        :class="
          kept
            ? 'border-accent bg-accent-soft text-accent-fg'
            : 'border-dashed border-line-strong text-fg-subtle'
        "
      >
        <Check v-if="kept" class="size-3.5" aria-hidden="true" />
        <Server v-else class="size-3.5" aria-hidden="true" />
        <span :class="kept ? '' : 'line-through'">{{ t('backup.where.server') }}</span>
        <span v-if="!kept" class="text-small">· {{ t('backup.where.serverGoes') }}</span>
      </span>
      <button
        v-for="r in rows"
        :key="r.d.id"
        type="button"
        :data-destination="r.d.id"
        :aria-pressed="r.on"
        :aria-disabled="r.kind && !r.on ? 'true' : 'false'"
        :aria-describedby="r.kind ? `${uid}-${r.kind}` : undefined"
        class="inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-ui transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        :class="r.on ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line text-fg hover:bg-subtle'"
        @click="toggle(r.d.id, r.kind)"
      >
        <Check v-if="r.on" class="size-3.5" aria-hidden="true" />
        <component :is="ICON[r.d.type]" v-else class="size-3.5" aria-hidden="true" />
        {{ r.d.name }}
      </button>
    </div>
    <ul v-if="reasons.length" class="flex flex-col gap-1 text-ui text-warning">
      <li v-for="r in reasons" :key="r.kind" class="flex flex-wrap items-center gap-2">
        <span :id="r.id">{{ r.text }}</span>
        <button
          v-if="!noFix"
          type="button"
          class="cursor-pointer rounded-md px-2 py-0.5 text-small font-medium text-accent-fg hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          @click="emit('fix', 'encrypt')"
        >
          {{ t('backup.fix.encrypt') }}
        </button>
      </li>
    </ul>
    <Transition
      enter-active-class="transition duration-200 motion-reduce:transition-none"
      enter-from-class="-translate-y-1 opacity-0"
    >
      <label v-if="modelValue.length" class="flex items-start gap-3 text-ui">
        <input
          type="checkbox"
          class="mt-0.5 size-4 accent-accent"
          :checked="keepMode ? !deleteLocal : deleteLocal"
          @change="
            emit(
              'update:deleteLocal',
              keepMode
                ? !($event.target as HTMLInputElement).checked
                : ($event.target as HTMLInputElement).checked,
            )
          "
        />
        <span>
          <span class="font-medium text-fg">{{
            keepMode ? t('schedules.editor.where.keep') : t('backup.where.deleteLocal')
          }}</span>
          <span class="block text-fg-subtle">{{
            keepMode ? keepHelp : t('backup.where.deleteLocalHelp')
          }}</span>
          <span v-if="sizeOnly.length" class="block text-warning">{{
            t('backup.where.verifiedSize', { names: list(sizeOnly.map((d) => d.name)) }, sizeOnly.length)
          }}</span>
        </span>
      </label>
    </Transition>
  </div>
</template>
