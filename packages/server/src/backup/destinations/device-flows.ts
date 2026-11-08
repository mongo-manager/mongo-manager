// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import { Errors } from '../../errors'

export interface DeviceFlow {
  id: string
  adminId: string
  clientId: string
  clientSecret: string
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresAt: number
  /** Seconds between polls, as Google says (grown by 5 on slow_down). */
  interval: number
  nextPollAt: number
  state: 'pending' | 'approved' | 'denied' | 'expired'
  refreshToken?: string
  account?: string
}

/**
 * Spec §2.4, §4.5: a flow belongs to the administrator who started it, lives at most 15 minutes
 * (Google's own expiry, capped), and at most five run at once on the server. The refresh token it
 * receives stays here, in memory, until the destination is saved.
 */
export class DeviceFlows {
  private readonly flows = new Map<string, DeviceFlow>()
  constructor(
    private readonly now: () => number,
    private readonly max = 5,
  ) {}

  prune(): void {
    for (const [id, f] of this.flows) if (f.expiresAt <= this.now()) this.flows.delete(id)
  }

  add(adminId: string, flow: Omit<DeviceFlow, 'id' | 'adminId' | 'state' | 'nextPollAt'>): DeviceFlow {
    this.prune()
    if (this.flows.size >= this.max)
      throw Errors.conflict('Five Google sign-ins are already waiting; finish or let one expire', {
        reason: 'device_flows_busy',
      })
    const f: DeviceFlow = {
      ...flow,
      id: randomUUID(),
      adminId,
      state: 'pending',
      // Phase 3d-3b final review: an expiry that is not a number (NaN never compares) is the cap.
      expiresAt: Number.isFinite(flow.expiresAt)
        ? Math.min(flow.expiresAt, this.now() + 15 * 60_000)
        : this.now() + 15 * 60_000,
      nextPollAt: this.now(),
    }
    this.flows.set(f.id, f)
    return f
  }

  get(adminId: string, id: string): DeviceFlow | undefined {
    this.prune()
    const f = this.flows.get(id)
    return f && f.adminId === adminId ? f : undefined
  }

  /** An approved sign-in, used up — only when it was made for this OAuth client (checked first). */
  take(adminId: string, id: string, clientId?: string): DeviceFlow {
    const f = this.get(adminId, id)
    if (!f || f.state !== 'approved' || !f.refreshToken)
      throw Errors.validation('Connect the Google account first: the sign-in is not approved', {
        reason: 'device_flow_not_approved',
      })
    if (clientId !== undefined && f.clientId !== clientId)
      throw Errors.validation('The client id differs from the one that was connected', {
        reason: 'device_flow_client',
      })
    this.flows.delete(id)
    return f
  }
}
