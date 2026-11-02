<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Eye, Send, UserMinus, UserPlus } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import { GRANT_LEVELS, type GrantLevel } from '@mongo-manager/shared/browser'
import { usersApi } from '@/api/account'
import { useSessionStore } from '@/stores/session'
import { DRAFT_KEY } from './useDestinationDraft'
import DsSelect from '@/ds/DsSelect.vue'

/** Phase 3d-3b D4: who may use this destination, and how far — each level said in a sentence. */
const { draft } = inject(DRAFT_KEY)!
const { t } = useI18n()
const session = useSessionStore()
const team = computed(() => session.status?.mode === 'team')
const users = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list(), enabled: team })
// Administrators may use every destination: only the others are offered.
const candidates = computed(() =>
  (users.data.value ?? []).filter(
    (u) => u.role !== 'admin' && !u.disabled && !draft.grants.some((g) => g.userId === u.id),
  ),
)
const picked = ref('')
function add(): void {
  const u = candidates.value.find((x) => x.id === picked.value)
  if (!u) return
  draft.grants.push({ userId: u.id, username: u.username, level: 'send' })
  picked.value = ''
}
function setLevel(userId: string, level: GrantLevel): void {
  const g = draft.grants.find((x) => x.userId === userId)
  if (g) g.level = level
}
function remove(userId: string): void {
  draft.grants.splice(
    draft.grants.findIndex((g) => g.userId === userId),
    1,
  )
}
const ICON = { send: Send, browse: Eye } as const
</script>

<template>
  <section class="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5">
    <header>
      <h3 class="font-semibold text-fg">{{ t('destinations.access.title') }}</h3>
      <p class="text-ui text-fg-subtle">{{ t('destinations.access.help') }}</p>
    </header>
    <dl class="grid gap-3 sm:grid-cols-2">
      <div v-for="l in GRANT_LEVELS" :key="l" class="flex gap-3 rounded-xl bg-subtle p-3">
        <component :is="ICON[l]" class="mt-0.5 size-4 shrink-0 text-accent-fg" aria-hidden="true" />
        <div>
          <dt class="text-ui font-medium text-fg">
            {{ t(`destinations.access.level.${l}`) }}
          </dt>
          <dd class="text-ui text-fg-subtle">
            {{ t(`destinations.access.levelHelp.${l}`) }}
          </dd>
        </div>
      </div>
    </dl>
    <p v-if="!team" class="text-ui text-fg-subtle">
      {{ t('destinations.access.localMode') }}
    </p>
    <template v-else>
      <div class="flex flex-wrap items-end gap-2">
        <!-- The empty choice says what to do (or that nobody is left); Add stays off until one is picked. -->
        <DsSelect
          v-model="picked"
          class="min-w-56 flex-1"
          :disabled="!candidates.length"
          :label="t('destinations.access.add')"
          :options="[
            {
              value: '',
              label: candidates.length ? t('destinations.access.pick') : t('destinations.access.noneLeft'),
            },
            ...candidates.map((u) => ({ value: u.id, label: u.username })),
          ]"
        />
        <!-- Final review (WCAG 3.2.2): choosing in the list changes nothing; Add does. -->
        <DsButton variant="secondary" :disabled="!picked" @click="add">
          <UserPlus class="size-4" aria-hidden="true" />{{ t('destinations.access.addButton') }}
        </DsButton>
      </div>
      <p v-if="!draft.grants.length" class="text-ui text-fg-subtle">
        {{ t('destinations.access.none') }}
      </p>
      <TransitionGroup
        v-else
        tag="ul"
        class="flex flex-col divide-y divide-line"
        enter-active-class="transition duration-200 motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
      >
        <li v-for="g in draft.grants" :key="g.userId" class="flex flex-wrap items-center gap-3 py-2.5">
          <span class="min-w-0 flex-1 truncate font-medium text-fg">{{ g.username }}</span>
          <div class="inline-flex rounded-lg border border-line p-0.5" role="group" :aria-label="g.username">
            <button
              v-for="l in GRANT_LEVELS"
              :key="l"
              type="button"
              :aria-pressed="g.level === l"
              class="cursor-pointer rounded-md px-2.5 py-1 text-small font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              :class="g.level === l ? 'bg-accent text-on-accent' : 'text-fg-muted hover:bg-subtle'"
              @click="setLevel(g.userId, l)"
            >
              {{ t(`destinations.access.level.${l}`) }}
            </button>
          </div>
          <button
            type="button"
            class="cursor-pointer rounded-md p-1.5 text-fg-subtle hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            :aria-label="t('destinations.access.remove', { name: g.username })"
            @click="remove(g.userId)"
          >
            <UserMinus class="size-4" aria-hidden="true" />
          </button>
        </li>
      </TransitionGroup>
    </template>
  </section>
</template>
