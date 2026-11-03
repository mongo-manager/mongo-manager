<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheck, CircleDashed, CircleX, Loader2 } from 'lucide-vue-next'
import { TEST_STEPS, type DestinationType, type TestStep } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import { useFixHint, useReasonText } from './errors'

/** D2: the live checklist — each step ok or failed, with its time, its cause and the fix in words. */
const props = defineProps<{
  steps: TestStep[] | null
  running: boolean
  stale?: boolean
  type?: DestinationType
  /** W4.5: a host key shown by the test may be trusted from here (the editor's own checklist). */
  trustable?: boolean
}>()
const emit = defineEmits<{ trust: [hostKey: string] }>()
const reasonWords = useReasonText()
const { t } = useI18n()
const rows = computed(() =>
  TEST_STEPS.map((step) => {
    const s = props.steps?.find((x) => x.step === step) ?? null
    const state = !s
      ? props.running
        ? 'running'
        : 'idle'
      : s.ok
        ? 'ok'
        : s.reason === 'skipped'
          ? 'skipped'
          : 'failed'
    return { step, s, state }
  }),
)
// A result measured with other settings never says "ready to save" (final review C16).
const allPassed = computed(() => !props.running && !props.stale && rows.value.every((r) => r.state === 'ok'))
// Short names review 7 (M-6): which folder refusal, and the name refused, said in the cause.
const cause = (s: TestStep) => reasonWords(s.reason, props.type, s)
const fixHint = useFixHint()
const fix = (s: TestStep) => fixHint(s.reason, props.type, s)
</script>

<template>
  <div class="flex flex-col gap-2">
    <ol
      class="flex flex-col gap-1 transition-opacity duration-150"
      :class="stale ? 'opacity-60' : ''"
      :aria-label="t('destinations.test.title')"
      aria-live="polite"
    >
      <li
        v-for="r in rows"
        :key="r.step"
        class="flex items-start gap-3 rounded-lg px-2.5 py-2 text-ui transition-colors duration-150"
        :class="r.state === 'failed' ? 'bg-danger-soft' : ''"
      >
        <Loader2
          v-if="r.state === 'running'"
          class="mt-0.5 size-4 shrink-0 animate-spin text-accent-fg motion-reduce:animate-none"
          aria-hidden="true"
        />
        <CircleCheck
          v-else-if="r.state === 'ok'"
          class="mt-0.5 size-4 shrink-0 text-success"
          aria-hidden="true"
        />
        <CircleX
          v-else-if="r.state === 'failed'"
          class="mt-0.5 size-4 shrink-0 text-danger"
          aria-hidden="true"
        />
        <CircleDashed v-else class="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2">
            <span class="font-medium text-fg">{{ t(`destinations.test.step.${r.step}`) }}</span>
            <span
              v-if="r.s?.ms !== null && r.s?.ms !== undefined"
              class="text-small text-fg-subtle tabular-nums"
              >{{ t('destinations.test.ms', { ms: r.s.ms }) }}</span
            >
            <span v-else-if="r.s?.reason === 'local'" class="text-small text-fg-subtle">{{
              t('destinations.test.local')
            }}</span>
            <span v-else-if="r.state === 'skipped'" class="text-small text-fg-subtle">{{
              t('destinations.test.skipped')
            }}</span>
          </p>
          <template v-if="r.state === 'failed' && r.s">
            <p class="break-words text-danger">{{ cause(r.s) }}</p>
            <p v-if="fix(r.s)" class="text-fg-muted">{{ fix(r.s) }}</p>
            <!-- W4.5: the SFTP server's host key, to compare with the server's own before trusting it. -->
            <div v-if="r.s.hostKey" class="mt-2 flex flex-col gap-2" data-test="host-key">
              <p class="text-fg-muted">{{ t('destinations.sftp.hostKeyShown') }}</p>
              <code class="rounded-md bg-surface px-2 py-1 font-mono text-small break-all text-fg">{{
                r.s.hostKey
              }}</code>
              <DsButton
                v-if="trustable"
                size="sm"
                variant="secondary"
                class="self-start"
                @click="emit('trust', r.s.hostKey)"
                >{{ t('destinations.sftp.trust') }}</DsButton
              >
            </div>
            <details v-if="r.s.detail" class="mt-1 text-small text-fg-subtle">
              <summary class="cursor-pointer">{{ t('destinations.test.details') }}</summary>
              <code class="font-mono">{{ r.s.detail }}</code>
            </details>
          </template>
        </div>
      </li>
    </ol>
    <p
      v-if="allPassed"
      role="status"
      class="flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2 text-ui font-medium text-success"
    >
      <CircleCheck class="size-4 shrink-0" aria-hidden="true" />{{ t('destinations.test.passed') }}
    </p>
  </div>
</template>
