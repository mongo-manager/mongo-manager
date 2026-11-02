<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-vue-next'
import type { PreflightCheck, PreflightFix } from '@mongo-manager/shared/browser'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import { useCheckText } from './checkText'

/** U2: the live checks, each in words, with its one-click fix. */
defineProps<{ checks: PreflightCheck[]; loading?: boolean }>()
const emit = defineEmits<{ fix: [kind: PreflightFix, names?: string[]] }>()
const { t } = useI18n()
const text = useCheckText()
</script>

<template>
  <ul class="flex flex-col gap-2" :aria-busy="loading ? 'true' : 'false'" aria-live="polite">
    <template v-if="loading && !checks.length">
      <li v-for="n in 4" :key="n"><DsSkeleton class="h-9 rounded-lg" /></li>
    </template>
    <TransitionGroup
      v-else
      enter-active-class="transition duration-200 motion-reduce:transition-none"
      enter-from-class="translate-y-1 opacity-0"
      move-class="transition duration-200 motion-reduce:transition-none"
    >
      <li
        v-for="c in checks"
        :key="c.key"
        class="flex flex-wrap items-start gap-x-2.5 gap-y-1 rounded-lg border px-3 py-2 text-ui"
        :class="{
          'border-line bg-surface text-fg': c.level === 'ok',
          'border-warning/25 bg-warning-soft text-warning': c.level === 'warn',
          'border-danger/25 bg-danger-soft text-danger': c.level === 'block',
        }"
      >
        <CheckCircle2
          v-if="c.level === 'ok'"
          class="mt-0.5 size-4 shrink-0 text-success"
          role="img"
          :aria-label="t('backup.level.ok')"
        />
        <AlertTriangle
          v-else-if="c.level === 'warn'"
          class="mt-0.5 size-4 shrink-0 text-warning"
          role="img"
          :aria-label="t('backup.level.warn')"
        />
        <XCircle
          v-else
          class="mt-0.5 size-4 shrink-0 text-danger"
          role="img"
          :aria-label="t('backup.level.block')"
        />
        <span class="flex-1">{{ text(c) }}</span>
        <span
          v-if="c.fix"
          class="flex shrink-0 flex-wrap gap-1"
          :class="{ 'basis-full pl-6.5': c.more?.length }"
        >
          <button
            type="button"
            class="-my-0.5 shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-small font-medium text-accent-fg underline-offset-2 transition-colors duration-150 hover:bg-surface/60 hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            @click="emit('fix', c.fix.kind, c.fix.names)"
          >
            {{ t(`backup.fix.${c.fix.kind}`) }}
          </button>
          <button
            v-for="(m, k) in c.more ?? []"
            :key="k"
            type="button"
            class="-my-0.5 shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-small font-medium text-accent-fg underline-offset-2 transition-colors duration-150 hover:bg-surface/60 hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            @click="emit('fix', m.kind, m.names)"
          >
            {{ t(`backup.fix.${m.kind}`) }}
          </button>
        </span>
      </li>
    </TransitionGroup>
  </ul>
</template>
