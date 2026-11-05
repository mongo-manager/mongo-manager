// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Plugin } from 'vite'

export interface ThirdPartyPackage {
  name: string
  version: string
  license: string
  texts: string[]
}

export function packageDirOf(id: string): string | null
export function packagesOf(moduleIds: Iterable<string>): ThirdPartyPackage[]
export function mergePackages(...lists: ThirdPartyPackage[][]): ThirdPartyPackage[]
export function nodePackage(execPath?: string, version?: string): ThirdPartyPackage
export function renderNotices(packages: ThirdPartyPackage[]): string
export function thirdPartyList(
  also?: string[],
  data?: Array<{ file: string; entry: ThirdPartyPackage }>,
): Plugin
export function missingPackages(packages: ThirdPartyPackage[], required: string[]): string[]
