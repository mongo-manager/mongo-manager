<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { RouterView } from 'vue-router'
import { usePreferencesStore } from '@/stores/preferences'
import DsToastHost from '@/ds/DsToastHost.vue'
import DsConfirmHost from '@/ds/DsConfirmHost.vue'
import OidcSignInHost from '@/connections/OidcSignInHost.vue'

// Started in main.ts before mount; stopped with the app.
const preferences = usePreferencesStore()
onBeforeUnmount(() => preferences.stop())
</script>

<template>
  <RouterView />
  <DsToastHost />
  <DsConfirmHost />
  <OidcSignInHost />
</template>
