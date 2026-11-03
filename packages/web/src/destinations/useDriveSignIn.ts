import { computed, onBeforeUnmount, ref, type InjectionKey } from 'vue'
import type { DestinationView, DeviceFlowView } from '@mongo-manager/shared/browser'
import { destinationsApi } from '@/api/destinations'
import type { Draft } from './useDestinationDraft'

export type SignInState = 'idle' | 'starting' | 'waiting' | 'approved' | 'reconnect' | 'denied' | 'expired'
const CLIENT_ID = /^[A-Za-z0-9._-]{8,256}$/

/**
 * Phase 3d-3b D3, final review: the Google device sign-in belongs to the editor, not to the Drive
 * step — stepping back and forth keeps a waiting code and its polling, and closing the editor ends
 * both (a poll on its way schedules nothing more). A saved destination reconnects with its stored
 * client secret, which the server applies by destination id: the page never holds it.
 */
export function useDriveSignIn(
  draft: Draft,
  existing: DestinationView | undefined,
  describe: (e: unknown) => string,
) {
  const flow = ref<DeviceFlowView | null>(null)
  const flowStart = ref(0)
  const state = ref<SignInState>(
    draft.driveAccount ? (existing?.status.state === 'reconnect' ? 'reconnect' : 'approved') : 'idle',
  )
  const error = ref<string | null>(null)
  let poll: ReturnType<typeof setTimeout> | undefined
  let alive = true
  // Each start or cancel gets a new generation: an answer for an older one is ignored.
  let generation = 0

  const clientId = computed(() => String(draft.config.clientId ?? ''))
  /** The stored secret was made for the stored client id; another id needs its own secret. */
  const storedSecretUsable = computed(
    () =>
      Boolean(existing?.secrets.clientSecret) &&
      draft.secrets.clientSecret === null &&
      clientId.value === String(existing?.config.clientId ?? ''),
  )
  const canConnect = computed(
    () => CLIENT_ID.test(clientId.value) && (Boolean(draft.secrets.clientSecret) || storedSecretUsable.value),
  )

  async function connect(): Promise<void> {
    if (!canConnect.value) return
    const mine = ++generation
    clearTimeout(poll)
    error.value = null
    state.value = 'starting'
    draft.deviceFlowId = null
    try {
      const started = await destinationsApi.startDevice(
        draft.secrets.clientSecret
          ? { clientId: clientId.value, clientSecret: draft.secrets.clientSecret }
          : { clientId: clientId.value, destinationId: existing!.id },
      )
      if (!alive || mine !== generation) return
      flow.value = started
      flowStart.value = Date.now()
      state.value = 'waiting'
      schedule(mine)
    } catch (e) {
      if (!alive || mine !== generation) return
      state.value = idleState()
      error.value = describe(e)
    }
  }
  const idleState = (): SignInState =>
    draft.driveAccount ? (existing?.status.state === 'reconnect' ? 'reconnect' : 'approved') : 'idle'
  function schedule(mine: number): void {
    clearTimeout(poll)
    if (!alive || mine !== generation) return
    poll = setTimeout(() => void check(mine), (flow.value?.interval ?? 5) * 1000)
  }
  async function check(mine: number): Promise<void> {
    if (!flow.value) return
    try {
      const r = await destinationsApi.pollDevice(flow.value.flowId)
      if (!alive || mine !== generation) return
      if (r.state === 'approved') {
        state.value = 'approved'
        draft.deviceFlowId = flow.value.flowId
        draft.driveAccount = r.account ?? null
      } else if (r.state === 'denied' || r.state === 'expired') state.value = r.state
      else schedule(mine)
    } catch (e) {
      if (!alive || mine !== generation) return
      state.value = 'expired'
      error.value = describe(e)
    }
  }
  /** Stop waiting: the code is dropped and Connect is offered again. */
  function cancel(): void {
    generation++
    clearTimeout(poll)
    flow.value = null
    error.value = null
    state.value = idleState()
  }
  onBeforeUnmount(() => {
    alive = false
    generation++
    clearTimeout(poll)
  })
  return { flow, flowStart, state, error, canConnect, storedSecretUsable, connect, cancel }
}

export const DRIVE_KEY: InjectionKey<ReturnType<typeof useDriveSignIn>> = Symbol('drive-sign-in')
