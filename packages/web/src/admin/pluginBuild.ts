import { downloadBlob, downloadText } from '@/download'
import { docsPage } from '@/workspace/docs'

/**
 * User request 2026-10-11: what someone building a plugin takes from the Plugins page — the starter
 * as a zip, and the instructions their AI assistant reads. The files are built into the app and
 * loaded only when saved (nothing is fetched).
 */
export const AI_FILES = [
  { tool: 'Claude Code', path: 'CLAUDE.md', name: 'CLAUDE.md' },
  { tool: 'Codex', path: 'AGENTS.md', name: 'AGENTS.md' },
  { tool: 'Gemini', path: 'GEMINI.md', name: 'GEMINI.md' },
  { tool: 'GitHub Copilot', path: '.github/copilot-instructions.md', name: 'copilot-instructions.md' },
] as const
export type AiFile = (typeof AI_FILES)[number]

export const STARTER_ZIP = 'mongo-manager-plugin-starter.zip'

/** The developer guide, in the reader's language. */
export const guidePath = (locale: string) => docsPage(locale, 'plugins.html')

/** Saves the starter as a zip; throws when it cannot (the caller says so). */
export async function saveStarter(): Promise<void> {
  const [{ STARTER_FILES, STARTER_FOLDER }, { zipStored }] = await Promise.all([
    import('./pluginStarter'),
    import('./zip'),
  ])
  const encoder = new TextEncoder()
  const files = Object.keys(STARTER_FILES)
    .sort()
    .map((path) => ({ path: `${STARTER_FOLDER}/${path}`, data: encoder.encode(STARTER_FILES[path]!) }))
  downloadBlob(new Blob([zipStored(files)], { type: 'application/zip' }), STARTER_ZIP)
}

export async function saveAiFile(file: AiFile): Promise<void> {
  const { STARTER_FILES } = await import('./pluginStarter')
  downloadText(STARTER_FILES[file.path]!, file.name)
}
