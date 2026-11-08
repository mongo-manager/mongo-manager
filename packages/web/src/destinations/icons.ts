// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Component } from 'vue'
import { Cloud, CloudCog, Container, FolderClosed, HardDrive, Server, Terminal } from 'lucide-vue-next'
import type { DestinationType } from '@mongo-manager/shared/browser'

/** Each kind of destination's icon (W4.5: one map, so a new kind cannot be left without one). */
export const DESTINATION_ICON: Record<DestinationType, Component> = {
  folder: FolderClosed,
  s3: Cloud,
  gdrive: HardDrive,
  webdav: Server,
  gcs: CloudCog,
  azure: Container,
  sftp: Terminal,
}
