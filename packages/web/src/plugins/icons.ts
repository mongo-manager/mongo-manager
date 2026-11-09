// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Component } from 'vue'
import {
  BookOpen,
  Calendar,
  ChartColumn,
  Code,
  FileText,
  FingerprintPattern,
  Globe,
  Hourglass,
  Image,
  Layers,
  Map,
  Puzzle,
  Ruler,
  ScrollText,
  Shapes,
  ShieldCheck,
  Table,
  WandSparkles,
} from 'lucide-vue-next'

/** Phase 4b §2: a contribution's icon, from the app's own set (a plugin brings none). */
const ICONS: Record<string, Component> = {
  map: Map,
  chart: ChartColumn,
  table: Table,
  file: FileText,
  image: Image,
  globe: Globe,
  layers: Layers,
  puzzle: Puzzle,
  // Plugins wave 3.
  book: BookOpen,
  wand: WandSparkles,
  shapes: Shapes,
  scroll: ScrollText,
  // Research plugins.
  code: Code,
  calendar: Calendar,
  hourglass: Hourglass,
  shield: ShieldCheck,
  fingerprint: FingerprintPattern,
  ruler: Ruler,
}
export const pluginIcon = (name?: string): Component => (name && ICONS[name]) || Puzzle
