import gitignore from '../../../plugins/starter/.gitignore?raw'
import copilot from '../../../plugins/starter/.github/copilot-instructions.md?raw'
import agents from '../../../plugins/starter/AGENTS.md?raw'
import claude from '../../../plugins/starter/CLAUDE.md?raw'
import gemini from '../../../plugins/starter/GEMINI.md?raw'
import readme from '../../../plugins/starter/README.md?raw'
import readmeTr from '../../../plugins/starter/README.tr.md?raw'
import readmeZh from '../../../plugins/starter/README.zh.md?raw'
import readmeJa from '../../../plugins/starter/README.ja.md?raw'
import readmeEs from '../../../plugins/starter/README.es.md?raw'
import readmePt from '../../../plugins/starter/README.pt.md?raw'
import readmeKo from '../../../plugins/starter/README.ko.md?raw'
import readmeDe from '../../../plugins/starter/README.de.md?raw'
import readmeFr from '../../../plugins/starter/README.fr.md?raw'
import readmeRu from '../../../plugins/starter/README.ru.md?raw'
import indexHtml from '../../../plugins/starter/index.html?raw'
import mainJs from '../../../plugins/starter/main.js?raw'
import manifest from '../../../plugins/starter/mongo-manager-plugin.json?raw'
import pack from '../../../plugins/starter/scripts/pack.mjs?raw'
import style from '../../../plugins/starter/style.css?raw'

/**
 * User request 2026-10-11: the plugin starter (packages/plugins/starter), every file of it as text,
 * built into the app — so the Plugins page can save it, or its AI assistant instructions, with
 * nothing fetched. Loaded only when one of them is saved.
 *
 * Each file is imported by name, not by a glob: the production build's glob leaves out hidden files
 * (.gitignore, .github/…) while the test run's keeps them (found 2026-10-11). A test checks this
 * list is the folder, file for file.
 */
export const STARTER_FILES: Readonly<Record<string, string>> = {
  '.github/copilot-instructions.md': copilot,
  '.gitignore': gitignore,
  'AGENTS.md': agents,
  'CLAUDE.md': claude,
  'GEMINI.md': gemini,
  'README.md': readme,
  'README.tr.md': readmeTr,
  'README.zh.md': readmeZh,
  'README.ja.md': readmeJa,
  'README.es.md': readmeEs,
  'README.pt.md': readmePt,
  'README.ko.md': readmeKo,
  'README.de.md': readmeDe,
  'README.fr.md': readmeFr,
  'README.ru.md': readmeRu,
  'index.html': indexHtml,
  'main.js': mainJs,
  'mongo-manager-plugin.json': manifest,
  'scripts/pack.mjs': pack,
  'style.css': style,
}
/** The folder the zip unpacks to. */
export const STARTER_FOLDER = 'mongo-manager-plugin-starter'
