<script setup lang="ts">
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { WEBDAV_PRESETS, type DestinationView } from '@mongo-manager/shared/browser'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import DsField from '@/ds/DsField.vue'
import DsSecretField from '@/ds/DsSecretField.vue'
import { DRAFT_KEY } from './useDestinationDraft'
import { addressHints } from './hints'

/** Phase 3d-3b §2.5, D2: Nextcloud/ownCloud (resumable chunks) or any WebDAV server. */
defineProps<{ part: 'provider' | 'connection'; existing?: DestinationView }>()
const { draft, identityChanged } = inject(DRAFT_KEY)!
const { t } = useI18n()
const c = computed(() => draft.config as Record<string, unknown>)
const str = (k: string) => String(c.value[k] ?? '')
const set = (k: string, v: unknown) => (draft.config[k] = v)
function setPreset(v: string): void {
  draft.preset = v
  set('preset', v)
}
const hints = computed(() => addressHints(str('url'), t))
const section = 'flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5'
</script>

<template>
  <template v-if="part === 'provider'">
    <div
      class="grid gap-3 md:grid-cols-2"
      role="radiogroup"
      :aria-label="t('destinations.editor.steps.provider')"
    >
      <DsChoiceCard
        v-for="p in WEBDAV_PRESETS"
        :key="p"
        :model-value="str('preset')"
        name="webdav-preset"
        :value="p"
        :title="t(`destinations.preset.${p}`)"
        :help="p === 'nextcloud' ? t('destinations.preset.nextcloudNote') : t('destinations.type.webdavHelp')"
        @update:model-value="setPreset"
      />
    </div>
  </template>
  <template v-else>
    <section :class="section">
      <DsField v-model="draft.name" :label="t('destinations.editor.name')" />
      <DsField
        :model-value="str('url')"
        :label="t('destinations.editor.url')"
        :placeholder="
          str('preset') === 'nextcloud' ? 'https://cloud.example.com' : 'https://dav.example.com/backups'
        "
        :help="hints"
        mono
        @update:model-value="(v) => set('url', v)"
      />
      <div class="grid gap-4 sm:grid-cols-2">
        <DsField
          :model-value="str('username')"
          :label="t('destinations.editor.username')"
          autocomplete="username"
          @update:model-value="(v) => set('username', v)"
        />
        <DsField
          :model-value="str('folder')"
          :label="t('destinations.editor.folder')"
          mono
          @update:model-value="(v) => set('folder', v)"
        />
      </div>
      <DsSecretField
        :label="t('destinations.editor.password')"
        :stored="Boolean(existing?.secrets.password)"
        :reenter="identityChanged"
        :model-value="draft.secrets.password ?? null"
        @update:model-value="(v) => (draft.secrets.password = v)"
      />
    </section>
    <details :class="section">
      <summary class="cursor-pointer text-ui font-medium text-fg">
        {{ t('destinations.editor.advanced') }}
      </summary>
      <div class="mt-4 flex flex-col gap-4">
        <label class="flex items-center gap-3 text-ui">
          <input
            type="checkbox"
            class="size-4 accent-accent"
            :checked="Boolean(c.verifyReadBack)"
            @change="set('verifyReadBack', ($event.target as HTMLInputElement).checked)"
          />
          {{ t('destinations.editor.readBack') }}
        </label>
        <label class="flex flex-col gap-1.5 text-ui">
          <span class="font-medium text-fg">{{ t('destinations.editor.ca') }}</span>
          <textarea
            :value="str('caPem')"
            rows="4"
            spellcheck="false"
            placeholder="-----BEGIN CERTIFICATE-----"
            class="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono text-small focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none"
            @input="
              (e) => {
                const v = (e.target as HTMLTextAreaElement).value.trim()
                if (v) set('caPem', v)
                else delete draft.config.caPem
              }
            "
          />
        </label>
      </div>
    </details>
  </template>
</template>
