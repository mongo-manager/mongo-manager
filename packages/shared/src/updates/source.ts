// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Where updates come from (2026-11-03). A fork that ships its own updates changes this file only:
 * see "Forks: turning updates on" in the README. Installs accept only releases whose SHA256SUMS
 * is signed by one of these keys; an empty list turns updates off, as MM_UPDATES=off does.
 */

/** The GitHub repository whose latest release is offered. */
export const RELEASE_REPO = 'mongo-manager/mongo-manager'
/** The container image a Docker install pulls. */
export const RELEASE_IMAGE = 'ghcr.io/mongo-manager/mongo-manager'
/** The npm package a global install updates. */
export const RELEASE_NPM_PACKAGE = '@mongo-manager/app'
/** Ed25519 public keys (base64 SPKI DER); one verifying a release's SHA256SUMS is enough. */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  // Mongo Manager's release key (2026-11-03).
  'MCowBQYDK2VwAyEATg7kWz7nEmhWM5tZxOeoELQzkfhjmlwzEAKZ8774J64=',
]
