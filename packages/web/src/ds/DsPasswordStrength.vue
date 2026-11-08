<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, X } from 'lucide-vue-next'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, accountPasswordCheck } from '@mongo-manager/shared/browser'

/**
 * Password strength (2026-10-28): how strong an account's new password is, as it is typed, and the
 * rules the server enforces — the same shared check, so the meter never promises what is refused.
 * Its id describes the field it stands under (final review M3).
 */
const props = defineProps<{ id?: string; password: string; username?: string }>()
const { t } = useI18n()
/** One check a keystroke (final review M6). */
const check = computed(() => accountPasswordCheck(props.password, props.username))
const strength = computed(() => check.value.strength)
const rules = computed(() => [
  {
    name: 'length',
    text: check.value.tooLong
      ? t('security.strength.ruleMaxLength', { n: PASSWORD_MAX_LENGTH })
      : t('security.strength.ruleLength', { n: PASSWORD_MIN_LENGTH }),
    ok: check.value.rules.length,
  },
  // Listed whenever a username belongs to the password, typed yet or not: the list does not jump.
  ...(props.username !== undefined
    ? [{ name: 'username', text: t('security.strength.ruleUsername'), ok: check.value.rules.username }]
    : []),
  { name: 'guessable', text: t('security.strength.ruleGuessable'), ok: check.value.rules.guessable },
])
/** Final review M2: refused (one red bar) never looks like accepted but weak (two amber). */
const LIT = [1, 2, 3, 4, 4] as const
const COLOR = ['bg-danger', 'bg-warning', 'bg-warning', 'bg-success', 'bg-success'] as const
const lit = computed(() => (props.password ? LIT[strength.value.score] : 0))
</script>

<template>
  <div :id="id" data-password-strength class="flex flex-col gap-1.5 text-small">
    <div class="flex min-h-4 items-center gap-3" aria-live="polite" aria-atomic="true">
      <div class="flex h-1.5 w-40 gap-1" aria-hidden="true">
        <span
          v-for="n in 4"
          :key="n"
          data-bar
          :data-lit="n <= lit"
          class="flex-1 rounded-full transition-colors duration-200"
          :class="n <= lit ? COLOR[strength.score] : 'bg-muted'"
        />
      </div>
      <span v-if="password" data-level class="text-fg-muted"
        >{{ t('security.strength.label') }}: {{ t(`security.strength.${strength.level}`) }}</span
      >
    </div>
    <ul class="flex flex-col gap-0.5">
      <li
        v-for="r in rules"
        :key="r.name"
        :data-rule="r.name"
        :data-ok="r.ok"
        class="flex items-center gap-1.5"
        :class="r.ok ? 'text-success' : 'text-fg-subtle'"
      >
        <component :is="r.ok ? Check : X" class="size-3.5 shrink-0" aria-hidden="true" />
        <span>{{ r.text }}</span>
        <span class="sr-only">{{ r.ok ? t('security.strength.met') : t('security.strength.notMet') }}</span>
      </li>
    </ul>
    <p v-if="password && strength.score > 0 && strength.score < 3" class="text-fg-subtle">
      {{ t('security.strength.tip') }}
    </p>
  </div>
</template>
