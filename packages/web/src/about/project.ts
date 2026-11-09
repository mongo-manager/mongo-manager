// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * User request 2026-10-31: who made Mongo Manager, where it lives and under which license. Names and
 * addresses are the same in every language, so they stay here rather than in the language files.
 */
const REPOSITORY = 'https://github.com/mongo-manager/mongo-manager'

export const AUTHOR = {
  name: 'Gokhan OZGEZER',
  email: 'gokhanozgezer@gmail.com',
  github: 'https://github.com/gokhanozgezer',
} as const

export const PROJECT_LINKS = {
  repository: REPOSITORY,
  issues: `${REPOSITORY}/issues`,
  security: `${REPOSITORY}/blob/main/SECURITY.md`,
  license: `${REPOSITORY}/blob/main/LICENSE`,
  notice: `${REPOSITORY}/blob/main/NOTICE`,
} as const

export const LICENSE = {
  name: 'GNU Affero General Public License v3.0 only',
  short: 'AGPL-3.0-only',
  deed: 'https://www.gnu.org/licenses/agpl-3.0.html',
} as const

/**
 * User request 2026-11-03: NOTICE's section 7(b) terms, worded as NOTICE words them and so never
 * translated: the copyright every copy keeps, and the attribution the About screen of every copy shows.
 */
export const COPYRIGHT = 'Copyright (C) 2026 Gokhan OZGEZER'
export const ATTRIBUTION = `Based on Mongo Manager by Gokhan OZGEZER - ${REPOSITORY}`

/** An address as shown: host and path, without the scheme. */
export const shownUrl = (url: string): string => url.replace(/^https:\/\//, '').replace(/\/$/, '')
