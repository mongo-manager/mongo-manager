import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * W7 (completion): whose job is running. In team mode a connection that signs people in with
 * OIDC has a client per person; a job (an import, an export, a copy) uses its owner's, never anyone
 * else's. The runner sets it around the job's own work only — nothing else reads it, and work with
 * no owner behind it gets no per-person client.
 */
const owner = new AsyncLocalStorage<{ user: string }>()

export function runAsJobOwner<T>(user: string, fn: () => Promise<T>): Promise<T> {
  return owner.run({ user }, fn)
}

export function jobOwner(): string | undefined {
  return owner.getStore()?.user
}
