// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { UpdateStatus } from '@mongo-manager/shared/browser'
import { updatesApi } from '@/api/updates'
import { APP_VERSION } from '@/version'
import { useSessionStore } from './session'

/** How long a restart may take before the page says it takes longer than expected. */
export const RESTART_SLOW_MS = 3 * 60_000
const POLL_MS = 1_000
const SLOW_POLL_MS = 5_000
const SEEN_KEY = 'mm.updates.seen'

const readSeen = (): string | null => {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}
const writeSeen = (value: string): void => {
  try {
    localStorage.setItem(SEEN_KEY, value)
  } catch {
    // A private window: the note shows again next time.
  }
}

/**
 * The updater (2026-11-03): the server's update status, and the restart into a new version — asked
 * again through the restart's errors (502, 503, a dropped connection) until the server answers as
 * a new process: every second, then less often while it does not answer (user report 2026-11-05:
 * each refusal is a line in the browser's console, hundreds of them over one restart).
 */
export const useUpdatesStore = defineStore('updates', () => {
  const session = useSessionStore()
  const status = ref<UpdateStatus | null>(null)
  const checking = ref(false)
  /** The server restarts into this version (an install, or the realtime word of one). */
  const restarting = ref<{ version: string; since: number } | null>(null)
  /** The restart takes longer than expected. */
  const slow = ref(false)
  /** The version the page saw the server come back with, this visit. */
  const justUpdated = ref<string | null>(null)
  const seen = ref<string | null>(readSeen())
  let timer: ReturnType<typeof setTimeout> | null = null
  /** The server stopped answering since the restart began: an answer now is the new process. */
  let sawDown = false
  let sawRestartPhase = false
  /** The polls in a row the server did not answer. */
  let misses = 0

  const admin = computed(() => session.can('settings:manage'))
  const hasUpdate = computed(
    () =>
      admin.value &&
      !!status.value &&
      !status.value.disabled &&
      status.value.offer === 'install' &&
      !!status.value.latest,
  )
  /**
   * The server runs another version than this page was built from (user report 2026-11-05: after
   * an update the page went on as the old one until F5, and the old one's files are gone).
   */
  const outdated = computed(() => {
    const installed = status.value?.installed
    return !restarting.value && !!installed && installed !== APP_VERSION ? installed : null
  })
  /** How the last update ended, until this browser has seen it. */
  const lastUpdateNote = computed(() => {
    const last = status.value?.lastUpdate
    if (!last) return null
    return seen.value === `${last.version}:${last.at}` ? null : last
  })

  function dismissLastUpdate(): void {
    const last = status.value?.lastUpdate
    if (!last) return
    seen.value = `${last.version}:${last.at}`
    writeSeen(seen.value)
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (!restarting.value && !status.value?.progress) return
    const late = restarting.value && Date.now() - restarting.value.since > RESTART_SLOW_MS
    timer = setTimeout(() => void poll(), late ? SLOW_POLL_MS : Math.min(POLL_MS * 2 ** misses, SLOW_POLL_MS))
  }

  function apply(next: UpdateStatus): void {
    status.value = next
    misses = 0
    if (next.progress?.phase === 'restarting') {
      sawRestartPhase = true
      if (!restarting.value && next.latest)
        restarting.value = { version: next.latest.version, since: Date.now() }
    }
    const r = restarting.value
    if (r && (next.installed === r.version || (next.progress === null && (sawDown || sawRestartPhase)))) {
      if (next.installed === r.version) justUpdated.value = r.version
      restarting.value = null
      slow.value = false
      sawDown = false
      sawRestartPhase = false
    }
    schedule()
  }

  async function poll(): Promise<void> {
    try {
      apply(await updatesApi.status())
    } catch {
      // The server is restarting: its proxy's 502 or 503, or no answer at all.
      if (restarting.value) sawDown = true
      misses++
      schedule()
    }
    if (restarting.value && Date.now() - restarting.value.since > RESTART_SLOW_MS) slow.value = true
  }

  async function load(): Promise<void> {
    try {
      apply(await updatesApi.status())
    } catch {
      // The page works without it: the privacy line then says what the default is.
    }
  }

  async function check(): Promise<void> {
    checking.value = true
    try {
      apply(await updatesApi.check())
    } finally {
      checking.value = false
    }
  }

  async function setAuto(on: boolean): Promise<void> {
    apply(await updatesApi.setAuto(on))
  }

  /** Throws the server's refusal (jobs running, a newer version): the dialog shows it. */
  async function install(version: string, confirmJobs: boolean): Promise<void> {
    apply(await updatesApi.install(version, confirmJobs))
  }

  /** The realtime word that the server restarts (every signed-in page hears it). */
  function serverRestarting(version: string): void {
    if (!restarting.value) restarting.value = { version, since: Date.now() }
    schedule()
  }

  return {
    status,
    checking,
    restarting,
    slow,
    justUpdated,
    outdated,
    admin,
    hasUpdate,
    lastUpdateNote,
    dismissLastUpdate,
    load,
    check,
    setAuto,
    install,
    serverRestarting,
  }
})
