<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, Cloud, Cpu, Gem, HardDrive, Server, Star, Trash2, type LucideIcon } from 'lucide-vue-next'
import type { AiKind, AiProviderView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsMenu from '@/ds/DsMenu.vue'
import { useAiWords } from './words'

const props = defineProps<{ provider: AiProviderView; testing: boolean }>()
const emit = defineEmits<{ edit: []; test: []; remove: []; makeDefault: [] }>()
const { t, locale } = useI18n()
const words = useAiWords()
const p = computed(() => props.provider)
/** Phase 4a-2 final review minor 11: each kind has its own icon (no brand marks). */
const KIND_ICONS: Record<AiKind, LucideIcon> = { anthropic: Bot, openai: Cpu, ollama: Server, gemini: Gem }
const test = computed(() =>
  p.value.lastTest === null
    ? t('ai.settings.untested')
    : p.value.lastTest === 'ok'
      ? t('ai.settings.testOk', {
          when: new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
            p.value.lastTestedAt ?? 0,
          ),
        })
      : words.reason(p.value.lastTest),
)
/** User review 2026-10-09: what a million tokens cost, in and out. */
const price = computed(() => {
  const pr = p.value.price
  if (!pr) return t('ai.settings.price.none')
  const money = (n: number) =>
    new Intl.NumberFormat(locale.value, {
      style: 'currency',
      currency: pr.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(n)
  return t('ai.settings.price.card', { input: money(pr.input), output: money(pr.output) })
})
</script>

<template>
  <article
    data-provider
    class="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-xs"
    :class="{ 'opacity-70': !p.enabled }"
  >
    <header class="flex items-start gap-3">
      <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg">
        <component :is="KIND_ICONS[p.kind]" class="size-5" aria-hidden="true" />
      </span>
      <div class="min-w-0 flex-1">
        <h3 class="text-title-s font-semibold break-words text-fg">{{ p.name }}</h3>
        <p class="text-ui break-words text-fg-subtle">{{ t(`ai.kind.${p.kind}`) }} · {{ p.model }}</p>
      </div>
      <span
        v-if="p.isDefault"
        class="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-small font-medium text-accent-fg"
        ><Star class="size-3" aria-hidden="true" />{{ t('ai.settings.default') }}</span
      >
    </header>
    <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-ui">
      <dt class="text-fg-subtle">{{ t('ai.settings.where') }}</dt>
      <dd class="inline-flex items-center gap-1 text-fg">
        <template v-if="p.lastLocal !== null">
          <component :is="p.lastLocal ? HardDrive : Cloud" class="size-3.5" aria-hidden="true" />
          {{ p.lastLocal ? t('ai.sheet.local') : t('ai.sheet.cloud') }}
        </template>
        <template v-else>{{ t('ai.settings.unknownWhere') }}</template>
      </dd>
      <dt class="text-fg-subtle">{{ t('ai.settings.samples') }}</dt>
      <dd class="text-fg">
        {{ p.samples ? t('ai.settings.samplesOn') : t('ai.settings.samplesOff') }}
      </dd>
      <dt class="text-fg-subtle">{{ t('ai.settings.key') }}</dt>
      <dd class="text-fg">
        {{ p.keyStored ? t('ai.settings.keyStored') : t('ai.settings.noKey') }}
      </dd>
      <dt class="text-fg-subtle">{{ t('ai.settings.lastTest') }}</dt>
      <dd class="text-fg">{{ test }}</dd>
      <dt class="text-fg-subtle">{{ t('ai.settings.price.label') }}</dt>
      <dd data-provider-price class="text-fg tabular-nums" :class="{ 'text-fg-subtle': !p.price }">
        {{ price }}
      </dd>
    </dl>
    <p v-if="!p.enabled" class="text-ui text-fg-subtle">{{ t('ai.settings.disabled') }}</p>
    <footer class="mt-auto flex flex-wrap gap-2">
      <DsButton size="sm" :loading="testing" @click="emit('test')">{{ t('ai.settings.test') }}</DsButton>
      <DsButton size="sm" @click="emit('edit')">{{ t('ai.settings.edit') }}</DsButton>
      <DsButton v-if="!p.isDefault && p.enabled" size="sm" variant="ghost" @click="emit('makeDefault')">{{
        t('ai.settings.makeDefault')
      }}</DsButton>
      <!-- Review of R3–R5 (I-4): removing is in the card's "…", in danger colour; still confirmed. -->
      <DsMenu
        class="ml-auto"
        focusable
        size="header"
        :label="t('ai.settings.moreFor', { name: p.name })"
        :items="[{ id: 'remove', label: t('ai.settings.remove'), icon: Trash2, danger: true }]"
        @select="(id: string) => id === 'remove' && emit('remove')"
      />
    </footer>
  </article>
</template>
