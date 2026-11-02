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
} as const

export const LICENSE = {
  name: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International',
  short: 'CC BY-NC-SA 4.0',
  deed: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
} as const

/** An address as shown: host and path, without the scheme. */
export const shownUrl = (url: string): string => url.replace(/^https:\/\//, '').replace(/\/$/, '')
