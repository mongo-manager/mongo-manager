import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { z } from 'zod'
import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './assets/main.css'
import App from './App.vue'
import { i18n, loadLocale } from './i18n'
import { createAppRouter } from './router'
import { onIpNotAllowed, onOidcSignIn, onUnauthenticated } from './api/client'
import { useOidcSignInStore } from './stores/oidcSignIn'
import { useSessionStore } from './stores/session'
import { afterIpNotAllowed, afterUnauthenticated } from './auth/unauthenticated'
import { usePreferencesStore } from './stores/preferences'
import { useTreeStore } from './stores/tree'
import { useCollectionViewsStore } from './stores/collectionViews'
import { useWorkspaceDialogs } from './stores/workspaceDialogs'
import { registerServiceWorker } from './pwa'
import { useAssistantStore } from './ai/chat/store'
import { installStaleBuildNotice } from './staleBuild'
import { installLocalLinks } from './api/localLinks'
import { useToastStore } from './stores/toasts'
import { installUnexpectedErrorNotice } from './unexpectedError'
import { watchAppInput } from './plugins/appInput'
import { useModelPlacesStore } from './model/places'

// CSP (spec §5 S6): no eval, so zod must not probe new Function.
z.config({ jitless: true })

const pinia = createPinia()
const router = createAppRouter()
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } },
})

const app = createApp(App).use(pinia).use(i18n).use(router).use(VueQueryPlugin, { queryClient })
// An error nothing caught says so instead of doing nothing (review 2026-10-13, web); installed
// first, so a page older than the server keeps its own notice.
installUnexpectedErrorNotice(app, { target: window, t: i18n.global.t })
// A page older than the server says so instead of doing nothing (user review 2026-10-08).
installStaleBuildNotice(app, { target: window, reload: () => window.location.reload(), t: i18n.global.t })

/** What a session leaves on screen, gone (another user may sign in next). */
function forgetSession(): void {
  const session = useSessionStore(pinia)
  session.ready = false
  queryClient.clear()
  // Another user may sign in next: nothing of this session stays on screen.
  useWorkspaceDialogs(pinia).close()
  useTreeStore(pinia).reset()
  useCollectionViewsStore(pinia).reset()
  // Where the boxes of a data model were put (2026-10-26).
  useModelPlacesStore(pinia).reset()
  // Phase 4a-2 final review C1: and the assistant's chat.
  useAssistantStore(pinia).reset()
}

// Any 401 (session expired, revoked, user disabled) sends the user back to sign in.
onUnauthenticated(() => {
  const wasIn = useSessionStore(pinia).status?.authenticated === true
  forgetSession()
  // A session that ended goes to sign-in and back where it was; a signed-out page stays as it is.
  void afterUnauthenticated(router, wasIn)
})

// Panel access (2026-10-30): an address the administrator's list leaves out sees why, and nothing else.
onIpNotAllowed((address) => {
  const session = useSessionStore(pinia)
  const wasReady = session.ready
  forgetSession()
  session.blockedAddress = address
  void afterIpNotAllowed(router, wasReady)
})

// W7: a connection that signs this person in with OIDC asks for it wherever it is used.
onOidcSignIn((connectionId) => useOidcSignInStore(pinia).request(connectionId))

// Security review 2026-10-16: the app's own presses are watched from the start — the click that
// opens a plugin comes before its frame (plugins/appInput.ts).
watchAppInput()

// Review of the audit fixes (important 1): local mode's download links carry a one-time ticket.
installLocalLinks(
  document,
  () => useSessionStore(pinia).status?.mode === 'local',
  () => useToastStore(pinia).push({ kind: 'error', message: i18n.global.t('openLink.downloadFailed') }),
)

// Apply theme, accent and language before the first paint (no light flash for dark-mode users).
// Languages (2026-10-29): one not in the bundle is loaded first, so the page never opens in English
// — for at most 3 s (review, minor 1): a stalled download opens the page, and the language follows.
const preferences = usePreferencesStore(pinia)
preferences.start()
void Promise.race([
  loadLocale(preferences.locale).catch(() => undefined),
  new Promise((resolve) => setTimeout(resolve, 3_000)),
]).then(() => {
  preferences.start()
  app.mount('#app')
})
void registerServiceWorker(navigator, document.baseURI, import.meta.env.PROD)
