import type { Component } from 'vue'
import {
  BookMarked,
  ListChecks,
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Bookmark,
  CalendarClock,
  BellRing,
  CloudUpload,
  Command as CommandIcon,
  Copy,
  Download,
  FileCode,
  GitCompareArrows,
  History,
  Info,
  Keyboard,
  Languages,
  LogOut,
  MessageSquarePlus,
  Plus,
  Radio,
  Puzzle,
  ScrollText,
  Server,
  Sparkles,
  SquareTerminal,
  SunMoon,
  Upload,
  UserCog,
  Users,
  ArrowLeftRight,
} from 'lucide-vue-next'
import type { Command } from '@/stores/commands'
import type { WorkspaceTab } from '@/stores/tabs'
import type { RebindableAction } from '@mongo-manager/shared/browser'

/**
 * UI redesign R1 spec §3: the palette's groups, told by a command's id. Opening a place is Navigate,
 * a saved item is Saved, everything else is an Action (plan ruling 14).
 */
const NAVIGATE = new Set([
  'library',
  'account',
  'schedules',
  'liveSyncs',
  'jobs',
  'aiHistory',
  'users',
  'destinations',
  'alerts',
  'aiSettings',
  'audit',
  'plugins',
  'about',
])
export type PaletteGroup = 'navigate' | 'actions' | 'saved'
export const PALETTE_GROUPS: PaletteGroup[] = ['navigate', 'actions', 'saved']

export function paletteGroup(command: Command): PaletteGroup {
  if (command.id.startsWith('library.open:')) return 'saved'
  if (
    command.id.startsWith('connection.open:') ||
    command.id.startsWith('plugin.page:') ||
    NAVIGATE.has(command.id)
  )
    return 'navigate'
  return 'actions'
}

/** The shortcut that runs a command directly; its keys (W5: as this user bound them) show beside it. */
export const PALETTE_KEYS: Record<string, RebindableAction> = {
  shortcuts: 'shortcuts',
  library: 'library',
  'assistant.open': 'assistant',
  'ai.ask': 'askAi',
}

/** Checkpoint 1 feedback: each command shows an icon, so the list scans at a glance. */
const ICONS: Record<string, Component> = {
  library: BookMarked,
  account: UserCog,
  schedules: CalendarClock,
  liveSyncs: ArrowRightLeft,
  jobs: ListChecks,
  aiHistory: History,
  users: Users,
  destinations: CloudUpload,
  alerts: BellRing,
  aiSettings: Sparkles,
  audit: ScrollText,
  plugins: Puzzle,
  about: Info,
  theme: SunMoon,
  language: Languages,
  shortcuts: Keyboard,
  'shell.open': SquareTerminal,
  'watch.open': Radio,
  'data.import': Upload,
  'data.importSql': FileCode,
  'data.exportSql': FileCode,
  'sql.open': ArrowLeftRight,
  'data.export': Download,
  'data.copy': Copy,
  'data.compare': GitCompareArrows,
  'data.liveSync': ArrowRightLeft,
  'backup.dump': Archive,
  'backup.restore': ArchiveRestore,
  'ai.ask': Sparkles,
  'assistant.open': Sparkles,
  'assistant.new': MessageSquarePlus,
  logout: LogOut,
  'connection.new': Plus,
  'connections.import': Upload,
  'connections.export': Download,
}

export function paletteIcon(command: Command): Component {
  if (command.id.startsWith('connection.open:')) return Server
  if (command.id.startsWith('shell.open:')) return SquareTerminal
  if (command.id.startsWith('library.open:')) return Bookmark
  if (command.id.startsWith('plugin.page:')) return Puzzle
  return ICONS[command.id] ?? CommandIcon
}

/**
 * Checkpoint 1 feedback: a command is listed only where it can run. These act on the active tab's
 * collection, database or connection, and do nothing elsewhere.
 */
const NEEDS: Record<string, 'collection' | 'database' | 'connection'> = {
  'data.import': 'collection',
  'data.importSql': 'database',
  'data.exportSql': 'connection',
  'data.export': 'collection',
  'data.copy': 'collection',
  'data.compare': 'collection',
  'data.liveSync': 'collection',
  'ai.ask': 'collection',
  'shell.open': 'connection',
  'watch.open': 'connection',
  'backup.dump': 'connection',
  'backup.restore': 'connection',
}

export function paletteFits(command: Command, tab: WorkspaceTab | null): boolean {
  const need = NEEDS[command.id]
  if (!need) return true
  const p = tab?.params
  if (need === 'collection') return tab?.kind === 'collection' && !!p?.connectionId && !!p.db && !!p.coll
  if (need === 'database') return !!p?.connectionId && !!p.db
  return !!p?.connectionId
}
