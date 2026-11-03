<script setup lang="ts">
import { computed, inject, nextTick, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { HOST_FINGERPRINT, type DestinationView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsField from '@/ds/DsField.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSecretField from '@/ds/DsSecretField.vue'
import { DRAFT_KEY } from './useDestinationDraft'

/**
 * W4.5: a folder on an SFTP server. The server's host key is pinned by its fingerprint: the test
 * shows the key the server presents, to be compared with the server's own and trusted. A private
 * key pasted here is taken and cleared from the screen at once (only "loaded" stays, with Replace).
 */
const props = defineProps<{ existing?: DestinationView }>()
const { draft, identityChanged } = inject(DRAFT_KEY)!
const { t } = useI18n()
const c = computed(() => draft.config as Record<string, unknown>)
const str = (k: string) => String(c.value[k] ?? '')
const set = (k: string, v: unknown) => (draft.config[k] = v)
const auth = computed({
  get: () => (str('auth') === 'privateKey' ? 'privateKey' : 'password'),
  set: (v: 'password' | 'privateKey') => set('auth', v),
})
const fingerprintBad = computed(
  () => Boolean(str('hostFingerprint')) && !HOST_FINGERPRINT.test(str('hostFingerprint')),
)
const MAX_KEY = 16_384
const keyId = useId()
const keyInput = ref<HTMLTextAreaElement | null>(null)
const keyProblem = ref(false)
const keyLoaded = computed(() => Boolean(draft.secrets.privateKey))
const keyStored = computed(
  () =>
    Boolean(props.existing?.secrets.privateKey) &&
    draft.secrets.privateKey === null &&
    !identityChanged.value,
)
function takeKey(e: Event): void {
  const el = e.target as HTMLTextAreaElement
  const text = el.value.trim()
  el.value = ''
  keyProblem.value = false
  if (!text) return
  if (text.length > MAX_KEY || !/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) keyProblem.value = true
  else draft.secrets.privateKey = text
}
async function replaceKey(): Promise<void> {
  draft.secrets.privateKey = ''
  await nextTick()
  keyInput.value?.focus()
}
const section = 'flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5'
</script>

<template>
  <section :class="section">
    <DsField v-model="draft.name" :label="t('destinations.editor.name')" />
    <div class="grid gap-4 sm:grid-cols-[1fr_7rem]">
      <DsField
        :model-value="str('host')"
        :label="t('destinations.sftp.host')"
        placeholder="sftp.example.com"
        mono
        @update:model-value="(v) => set('host', v.trim())"
      />
      <DsField
        :model-value="str('port')"
        :label="t('destinations.sftp.port')"
        inputmode="numeric"
        mono
        @update:model-value="(v) => set('port', Number(v.replace(/\D/g, '')) || '')"
      />
    </div>
    <div class="grid gap-4 sm:grid-cols-2">
      <DsField
        :model-value="str('username')"
        :label="t('destinations.sftp.username')"
        autocomplete="off"
        mono
        @update:model-value="(v) => set('username', v.trim())"
      />
      <DsField
        :model-value="str('folder')"
        :label="t('destinations.sftp.folder')"
        :help="t('destinations.sftp.folderHelp')"
        placeholder="/srv/backups"
        mono
        @update:model-value="(v) => set('folder', v.trim())"
      />
    </div>
    <DsSegmented
      v-model="auth"
      :label="t('destinations.sftp.auth')"
      :options="[
        { value: 'password', label: t('destinations.sftp.password') },
        { value: 'privateKey', label: t('destinations.sftp.privateKey') },
      ]"
    />
    <DsSecretField
      v-if="auth === 'password'"
      :label="t('destinations.sftp.password')"
      :stored="Boolean(existing?.secrets.password)"
      :reenter="identityChanged"
      :model-value="draft.secrets.password ?? null"
      @update:model-value="(v) => (draft.secrets.password = v)"
    />
    <template v-else>
      <div class="flex flex-col gap-1.5 text-ui">
        <label :for="keyId" class="font-medium text-fg">{{ t('destinations.sftp.privateKey') }}</label>
        <p v-if="keyStored" class="flex items-center gap-2 text-fg-muted">
          {{ t('destinations.sftp.keyStored') }}
          <DsButton size="sm" variant="ghost" @click="replaceKey">{{
            t('destinations.sftp.replace')
          }}</DsButton>
        </p>
        <p v-else-if="keyLoaded" class="flex items-center gap-2 text-fg-muted" data-test="key-loaded">
          {{ t('destinations.sftp.keyLoaded') }}
          <DsButton size="sm" variant="ghost" @click="replaceKey">{{
            t('destinations.sftp.replace')
          }}</DsButton>
        </p>
        <textarea
          v-else
          :id="keyId"
          ref="keyInput"
          rows="3"
          spellcheck="false"
          autocomplete="off"
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          class="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono text-small focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none"
          @input="takeKey"
        />
        <p v-if="keyProblem" role="alert" class="text-small text-danger">
          {{ t('destinations.sftp.keyInvalid') }}
        </p>
      </div>
      <DsSecretField
        :label="t('destinations.sftp.passphrase')"
        :stored="Boolean(existing?.secrets.passphrase)"
        :reenter="identityChanged"
        :model-value="draft.secrets.passphrase ?? null"
        @update:model-value="(v) => (draft.secrets.passphrase = v)"
      />
    </template>
    <DsField
      :model-value="str('hostFingerprint')"
      :label="t('destinations.sftp.hostKey')"
      :help="t('destinations.sftp.hostKeyHelp')"
      placeholder="SHA256:…"
      mono
      @update:model-value="
        (v) => {
          if (v.trim()) set('hostFingerprint', v.trim())
          else delete draft.config.hostFingerprint
        }
      "
    />
    <p v-if="fingerprintBad" role="alert" class="-mt-2 text-small text-danger">
      {{ t('destinations.sftp.hostKeyInvalid') }}
    </p>
    <label class="flex items-start gap-3 text-ui">
      <input
        type="checkbox"
        class="mt-0.5 size-4 accent-accent"
        :checked="c.verifyReadBack !== false"
        @change="set('verifyReadBack', ($event.target as HTMLInputElement).checked)"
      />
      <span>
        <span class="font-medium text-fg">{{ t('destinations.sftp.readBack') }}</span>
        <span class="block text-fg-subtle">{{ t('destinations.sftp.readBackHelp') }}</span>
      </span>
    </label>
  </section>
</template>
