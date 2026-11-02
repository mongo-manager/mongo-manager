import '../../kit/src/ui.css'
import './style.css'
import { AskError, askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  badge,
  button,
  callout,
  emptyState,
  h,
  langTag,
  type Language,
  pick,
  shown,
  pageHeader,
  skeleton,
  statusLine,
} from '../../kit/src/ui'
import {
  buildDictionary,
  dictionaryMarkdown,
  indexesNote,
  indexKind,
  notesOf,
  plainText,
  savable,
  rulesNote,
  when,
  wordsFor,
  type Dictionary,
  type Extras,
  type IndexDef,
  type Model,
  type Validation,
} from './dictionary'

/**
 * Plugins wave 3 (spec §5): the data dictionary of the collection's database — read from the
 * database's model (one read), then each collection's indexes and validation rules (definition
 * reads, a minute of their own), shown as they arrive; saved as Markdown or HTML, or copied.
 */
export interface PageText {
  title: string
  description: (db: string) => string
  reading: string
  readingDefs: (n: number, of: number) => string
  noPlace: string
  failed: string
  markdown: string
  html: string
  copy: string
  saveHint: string
  notAllowed: string
  waiting: string
  copyCut: (n: string) => string
  savedPart: (kept: string, total: string) => string
  tooLarge: string
}

export const PAGE_TEXT = {
  en: {
    title: 'Data dictionary',
    description: (db: string) => `Every collection of ${db}: its fields, references, indexes and rules.`,
    reading: 'Reading the model…',
    readingDefs: (n: number, of: number) => `Reading indexes and rules: ${n} of ${of}`,
    noPlace: 'Open a collection to see its database’s dictionary.',
    failed: 'The dictionary could not be read: ',
    markdown: 'Markdown',
    html: 'HTML',
    copy: 'Copy Markdown',
    saveHint: 'Save the dictionary as a file',
    notAllowed: 'Reading the other collections needs the plugin’s database permission.',
    waiting: 'This minute’s reads are spent: waiting a moment, then going on…',
    copyCut: (n: string) =>
      `Only the first ${n} characters were copied: save it as Markdown for the whole dictionary.`,
    savedPart: (kept: string, total: string) =>
      `Only the first ${kept} of ${total} collections were saved: the whole dictionary is over the 1 MB a saved file may be.`,
    tooLarge:
      'The dictionary is too large to save: even its first collection is over the 1 MB a saved file may be.',
  },
  tr: {
    title: 'Veri sözlüğü',
    description: (db: string) =>
      `${db} veritabanının her koleksiyonu: alanları, referansları, dizinleri ve kuralları.`,
    reading: 'Model okunuyor…',
    readingDefs: (n: number, of: number) => `Dizinler ve kurallar okunuyor: ${of} koleksiyonun ${n} tanesi`,
    noPlace: 'Veritabanının sözlüğünü görmek için bir koleksiyon açın.',
    failed: 'Sözlük okunamadı: ',
    markdown: 'Markdown',
    html: 'HTML',
    copy: 'Markdown kopyala',
    saveHint: 'Sözlüğü dosya olarak kaydet',
    notAllowed: 'Diğer koleksiyonları okumak eklentinin veritabanı iznini gerektirir.',
    waiting: 'Bu dakikanın okumaları bitti: biraz beklenip devam edilecek…',
    copyCut: (n: string) =>
      `Yalnızca ilk ${n} karakter kopyalandı: sözlüğün tamamı için Markdown olarak kaydedin.`,
    savedPart: (kept: string, total: string) =>
      `${total} koleksiyonun yalnızca ilk ${kept} tanesi kaydedildi: sözlüğün tamamı, kaydedilen bir dosyanın sınırı olan 1 MB'ı aşıyor.`,
    tooLarge:
      "Sözlük kaydedilemeyecek kadar büyük: ilk koleksiyonu bile kaydedilen bir dosyanın sınırı olan 1 MB'ı aşıyor.",
  },
  zh: {
    title: '数据字典',
    description: (db: string) => `${db} 的所有集合：字段、引用、索引和规则。`,
    reading: '正在读取模型…',
    readingDefs: (n: number, of: number) => `正在读取索引和规则：${n} / ${of}`,
    noPlace: '打开一个集合，即可查看其数据库的数据字典。',
    failed: '无法读取数据字典：',
    markdown: 'Markdown',
    html: 'HTML',
    copy: '复制 Markdown',
    saveHint: '将数据字典保存为文件',
    notAllowed: '读取其他集合需要插件的数据库权限。',
    waiting: '本分钟的读取次数已用完：稍候片刻后继续…',
    copyCut: (n: string) => `仅复制了前 ${n} 个字符：如需完整字典，请保存为 Markdown。`,
    savedPart: (kept: string, total: string) =>
      `仅保存了 ${total} 个集合中的前 ${kept} 个：完整字典超过了保存文件 1 MB 的上限。`,
    tooLarge: '数据字典太大，无法保存：即使只有第一个集合，也超过了保存文件 1 MB 的上限。',
  },
  ja: {
    title: 'データ辞書',
    description: (db: string) => `${db} のすべてのコレクション: フィールド、参照、インデックス、ルール。`,
    reading: 'モデルを読み取っています…',
    readingDefs: (n: number, of: number) => `インデックスとルールを読み取っています: ${n} / ${of}`,
    noPlace: 'コレクションを開くと、そのデータベースのデータ辞書が表示されます。',
    failed: 'データ辞書を読み取れませんでした: ',
    markdown: 'Markdown',
    html: 'HTML',
    copy: 'Markdown をコピー',
    saveHint: 'データ辞書をファイルとして保存',
    notAllowed: '他のコレクションを読み取るには、プラグインのデータベース権限が必要です。',
    waiting: 'この 1 分間の読み取り上限に達しました。しばらく待ってから再開します…',
    copyCut: (n: string) =>
      `先頭の ${n} 文字のみコピーしました。全体が必要な場合は Markdown として保存してください。`,
    savedPart: (kept: string, total: string) =>
      `${total} 件のコレクションのうち最初の ${kept} 件のみを保存しました。辞書全体が、保存できるファイルの上限である 1 MB を超えています。`,
    tooLarge:
      'データ辞書が大きすぎて保存できません。最初のコレクションだけでも、保存できるファイルの上限である 1 MB を超えています。',
  },
  es: {
    title: 'Diccionario de datos',
    description: (db: string) => `Todas las colecciones de ${db}: sus campos, referencias, índices y reglas.`,
    reading: 'Leyendo el modelo…',
    readingDefs: (n: number, of: number) => `Leyendo índices y reglas: ${n} de ${of}`,
    noPlace: 'Abre una colección para ver el diccionario de su base de datos.',
    failed: 'No se pudo leer el diccionario: ',
    markdown: 'Markdown',
    html: 'HTML',
    copy: 'Copiar Markdown',
    saveHint: 'Guardar el diccionario como archivo',
    notAllowed: 'Leer las demás colecciones requiere el permiso de base de datos del complemento.',
    waiting: 'Se agotaron las lecturas de este minuto: esperando un momento para continuar…',
    copyCut: (n: string) =>
      `Solo se copiaron los primeros ${n} caracteres: guarda el diccionario como Markdown para tenerlo completo.`,
    savedPart: (kept: string, total: string) =>
      `Solo se guardaron las primeras ${kept} de ${total} colecciones: el diccionario completo supera el máximo de 1 MB de un archivo guardado.`,
    tooLarge:
      'El diccionario es demasiado grande para guardarlo: incluso su primera colección supera el máximo de 1 MB de un archivo guardado.',
  },
  pt: {
    title: 'Dicionário de dados',
    description: (db: string) => `Todas as coleções de ${db}: campos, referências, índices e regras.`,
    reading: 'Lendo o modelo…',
    readingDefs: (n: number, of: number) => `Lendo índices e regras: ${n} de ${of}`,
    noPlace: 'Abra uma coleção para ver o dicionário do banco de dados dela.',
    failed: 'Não foi possível ler o dicionário: ',
    markdown: 'Markdown',
    html: 'HTML',
    copy: 'Copiar Markdown',
    saveHint: 'Salvar o dicionário como arquivo',
    notAllowed: 'Ler as outras coleções exige a permissão de banco de dados do plugin.',
    waiting: 'As leituras deste minuto acabaram: aguardando um instante para continuar…',
    copyCut: (n: string) =>
      `Apenas os primeiros ${n} caracteres foram copiados: salve como Markdown para ter o dicionário completo.`,
    savedPart: (kept: string, total: string) =>
      `Apenas as primeiras ${kept} de ${total} coleções foram salvas: o dicionário completo excede o limite de 1 MB de um arquivo salvo.`,
    tooLarge:
      'O dicionário é grande demais para ser salvo: até a primeira coleção excede o limite de 1 MB de um arquivo salvo.',
  },
  ko: {
    title: '데이터 사전',
    description: (db: string) => `데이터베이스 ${db}의 모든 컬렉션: 필드, 참조, 인덱스, 규칙.`,
    reading: '모델을 읽는 중…',
    readingDefs: (n: number, of: number) => `인덱스와 규칙을 읽는 중: ${n}/${of}`,
    noPlace: '컬렉션을 열면 해당 데이터베이스의 데이터 사전을 볼 수 있습니다.',
    failed: '데이터 사전을 읽을 수 없습니다: ',
    markdown: 'Markdown',
    html: 'HTML',
    copy: 'Markdown 복사',
    saveHint: '데이터 사전을 파일로 저장',
    notAllowed: '다른 컬렉션을 읽으려면 플러그인의 데이터베이스 권한이 필요합니다.',
    waiting: '이번 1분간의 읽기 한도를 모두 사용했습니다. 잠시 기다린 후 계속합니다…',
    copyCut: (n: string) => `처음 ${n}자만 복사했습니다. 전체 사전은 Markdown으로 저장하세요.`,
    savedPart: (kept: string, total: string) =>
      `컬렉션 ${total}개 중 처음 ${kept}개만 저장했습니다. 전체 사전이 저장 파일의 상한인 1 MB를 넘습니다.`,
    tooLarge:
      '데이터 사전이 너무 커서 저장할 수 없습니다. 첫 번째 컬렉션만으로도 저장 파일의 상한인 1 MB를 넘습니다.',
  },
  de: {
    title: 'Datenwörterbuch',
    description: (db: string) => `Alle Collections von ${db}: Felder, Verweise, Indizes und Regeln.`,
    reading: 'Modell wird gelesen…',
    readingDefs: (n: number, of: number) => `Indizes und Regeln werden gelesen: ${n} von ${of}`,
    noPlace: 'Öffnen Sie eine Collection, um das Wörterbuch ihrer Datenbank zu sehen.',
    failed: 'Das Wörterbuch konnte nicht gelesen werden: ',
    markdown: 'Markdown',
    html: 'HTML',
    copy: 'Markdown kopieren',
    saveHint: 'Wörterbuch als Datei speichern',
    notAllowed: 'Zum Lesen der anderen Collections ist die Datenbankberechtigung des Plugins erforderlich.',
    waiting: 'Die Lesevorgänge dieser Minute sind aufgebraucht: Es wird kurz gewartet und dann fortgefahren…',
    copyCut: (n: string) =>
      `Nur die ersten ${n} Zeichen wurden kopiert: Speichern Sie das Wörterbuch als Markdown, um es vollständig zu erhalten.`,
    savedPart: (kept: string, total: string) =>
      `Nur ${kept} von ${total} Collections (die ersten) wurden gespeichert: Das gesamte Wörterbuch überschreitet die 1 MB, die eine gespeicherte Datei haben darf.`,
    tooLarge:
      'Das Wörterbuch ist zu groß zum Speichern: Schon seine erste Collection überschreitet die 1 MB, die eine gespeicherte Datei haben darf.',
  },
  fr: {
    title: 'Dictionnaire de données',
    description: (db: string) => `Toutes les collections de ${db} : champs, références, index et règles.`,
    reading: 'Lecture du modèle…',
    readingDefs: (n: number, of: number) => `Lecture des index et des règles : ${n} sur ${of}`,
    noPlace: 'Ouvrez une collection pour voir le dictionnaire de sa base de données.',
    failed: 'Impossible de lire le dictionnaire : ',
    markdown: 'Markdown',
    html: 'HTML',
    copy: 'Copier le Markdown',
    saveHint: 'Enregistrer le dictionnaire dans un fichier',
    notAllowed: 'La lecture des autres collections nécessite l’autorisation de base de données du plugin.',
    waiting: 'Les lectures de cette minute sont épuisées : courte attente, puis reprise…',
    copyCut: (n: string) =>
      `Seuls les ${n} premiers caractères ont été copiés : enregistrez le dictionnaire en Markdown pour l’obtenir en entier.`,
    savedPart: (kept: string, total: string) =>
      `Seules les premières collections ont été enregistrées (${kept} sur ${total}) : le dictionnaire complet dépasse la limite de 1 MB d’un fichier enregistré.`,
    tooLarge:
      'Le dictionnaire est trop volumineux pour être enregistré : même sa première collection dépasse la limite de 1 MB d’un fichier enregistré.',
  },
  ru: {
    title: 'Словарь данных',
    description: (db: string) => `Все коллекции базы ${db}: поля, ссылки, индексы и правила.`,
    reading: 'Чтение модели…',
    readingDefs: (n: number, of: number) => `Чтение индексов и правил: ${n} из ${of}`,
    noPlace: 'Откройте коллекцию, чтобы увидеть словарь ее базы данных.',
    failed: 'Не удалось прочитать словарь: ',
    markdown: 'Markdown',
    html: 'HTML',
    copy: 'Копировать Markdown',
    saveHint: 'Сохранить словарь в файл',
    notAllowed: 'Для чтения других коллекций нужно разрешение плагина на доступ к базе данных.',
    waiting: 'Лимит чтения на эту минуту исчерпан: небольшая пауза, затем продолжение…',
    copyCut: (n: string) =>
      `Скопированы только первые ${n} символов: чтобы получить словарь целиком, сохраните его как Markdown.`,
    savedPart: (kept: string, total: string) =>
      `Сохранены только первые коллекции (${kept} из ${total}): весь словарь превышает 1 MB — предельный размер сохраняемого файла.`,
    tooLarge:
      'Словарь слишком велик для сохранения: даже его первая коллекция превышает 1 MB — предельный размер сохраняемого файла.',
  },
} satisfies Record<Language, PageText>

/** At most this much goes to the clipboard (the app's limit for `ui.copy`). */
const COPY_MAX = 100_000
/**
 * How long to wait before each new try when the minute's definition reads are spent (wave 3
 * review): a minute in all, then that collection is marked and the rest go on.
 */
const RETRY_WAITS = [10_000, 20_000, 30_000]

export interface MountOptions {
  /** Waits `ms` (tests pass their own). */
  wait?: (ms: number) => Promise<void>
  /** What the app saves at most (tests pass smaller ones). */
  saveLimits?: { chars: number; bytes: number }
}

export function mount(root: HTMLElement, client: PluginClient, options: MountOptions = {}): void {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let locale = 'en'
  let ctx: PluginContext | null = null
  let model: Model | null = null
  const extras = new Map<string, Extras>()
  let done = 0
  let waiting = false
  let phase: 'reading' | 'ready' | 'failed' | 'noPlace' = 'reading'
  let failure: unknown = null
  let note: { tone: 'danger' | 'warning'; text: string } | null = null

  const header = pageHeader({ icon: 'book', title: '', description: '' })
  const status = statusLine('status')
  const body = h('div', { class: 'mm-body dd-body' })
  root.append(h('div', { class: 'mm-page' }, header, status, body))

  const dictionary = (): Dictionary | null => (model ? buildDictionary(model, extras) : null)

  /**
   * One definition of a collection: its answer, or why it could not be read. When the minute's
   * reads are spent it waits and tries again, a few times; any other failure marks that collection
   * only, and the next ones are read (wave 3 review: one time-out replaced the whole dictionary).
   */
  async function readOne<T>(method: string, coll: string): Promise<{ value: T | null; error?: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return { value: await client.ask<T>(method, { coll }) }
      } catch (e) {
        if (e instanceof AskError && e.code === 'too_many' && attempt < RETRY_WAITS.length) {
          waiting = true
          render()
          await wait(RETRY_WAITS[attempt]!)
          waiting = false
          continue
        }
        return { value: null, error: askMessage(e, locale) }
      }
    }
  }

  /** Each collection's indexes and rules, one after another (they count in their own minute). */
  async function readDefinitions(): Promise<void> {
    for (const c of model!.collections) {
      if (c.type === 'view' || c.refused) {
        extras.set(c.name, { indexes: null, validation: null })
      } else {
        const indexes = await readOne<IndexDef[]>('indexes.list', c.name)
        const validation = await readOne<Validation>('validation.get', c.name)
        extras.set(c.name, {
          indexes: indexes.value,
          validation: validation.value,
          ...(indexes.error !== undefined ? { indexError: indexes.error } : {}),
          ...(validation.error !== undefined ? { validationError: validation.error } : {}),
        })
      }
      done++
      render()
    }
  }

  /**
   * Saves the dictionary — whole, or (wave 3 second review: a large one met the save limit with a
   * generic error) its first collections that fit, and says how many. A save the user declined is
   * no failure: nothing is said.
   */
  async function save(type: 'markdown' | 'html'): Promise<void> {
    const d = dictionary()
    if (!d) return
    const fit = savable(d, locale, type, options.saveLimits)
    const t = pick(PAGE_TEXT, locale)
    const number = (n: number) => new Intl.NumberFormat(langTag(shown(PAGE_TEXT, locale))).format(n)
    // Not one collection fits: nothing is saved, and the page says why (wave 3 third review).
    if (!fit.params) {
      note = { tone: 'danger', text: t.tooLarge }
      return render()
    }
    try {
      await client.ask('ui.download', fit.params)
      note =
        fit.kept < fit.total
          ? { tone: 'warning', text: t.savedPart(number(fit.kept), number(fit.total)) }
          : null
    } catch (e) {
      note =
        e instanceof AskError && e.code === 'declined'
          ? null
          : { tone: 'danger', text: askMessage(e, locale) }
    }
    render()
  }

  /** Copies the Markdown; a dictionary too long for the clipboard is cut at a line, and said so. */
  async function copy(): Promise<void> {
    const d = dictionary()
    if (!d) return
    const full = dictionaryMarkdown(d, locale)
    const cut = full.length > COPY_MAX
    const line = full.lastIndexOf('\n', COPY_MAX)
    const text = cut ? full.slice(0, line > 0 ? line : COPY_MAX) : full
    try {
      await client.ask('ui.copy', { text })
      const t = pick(PAGE_TEXT, locale)
      note = cut
        ? {
            tone: 'warning',
            text: t.copyCut(new Intl.NumberFormat(langTag(shown(PAGE_TEXT, locale))).format(COPY_MAX)),
          }
        : null
    } catch (e) {
      note =
        e instanceof AskError && e.code === 'declined'
          ? null
          : { tone: 'danger', text: askMessage(e, locale) }
    }
    render()
  }

  function section(c: Dictionary['collections'][number], lang: string): HTMLElement {
    const w = wordsFor(lang)
    const table = (head: string[], rows: Node[][]) =>
      h(
        'div',
        { class: 'mm-table-wrap' },
        h(
          'table',
          { class: 'mm-table' },
          h('thead', {}, h('tr', {}, ...head.map((x) => h('th', { attrs: { scope: 'col' }, text: x })))),
          h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((cell) => h('td', {}, cell))))),
        ),
      )
    // Wave 3 review: what the database names is shown without reversing or unseen characters.
    const mono = (s: string) => h('span', { class: 'mm-mono', text: plainText(s) })
    const plain = (s: string) => document.createTextNode(plainText(s))
    const parts: Array<Node | null> = [
      h(
        'h2',
        { class: 'dd-name' },
        plainText(c.name),
        ' ',
        badge(w.kinds[c.type] ?? c.type, c.type === 'view' ? 'info' : 'neutral'),
      ),
      c.viewOn ? h('p', { text: plainText(w.viewOf(c.viewOn)) }) : null,
      c.refused ? callout('warning', w.refused) : null,
    ]
    if (c.fields.length) {
      parts.push(
        h('h3', { class: 'mm-section-title', text: w.fields }),
        table(
          w.columns,
          c.fields.map((f) => [
            mono(f.path),
            f.hidden ? badge(w.hidden, 'warning') : plain(f.types.join(', ')),
            plain(w.percent(Math.round(f.share * 100))),
            plain(f.required ? w.yes : w.no),
            plain(notesOf(f, w)),
          ]),
        ),
        c.moreFields ? h('p', { class: 'mm-subtle', text: w.more(c.moreFields) }) : null,
      )
    }
    if (c.refsOut.length || c.refsIn.length)
      parts.push(
        h('h3', { class: 'mm-section-title', text: w.refs }),
        h(
          'ul',
          { class: 'dd-refs' },
          ...c.refsOut.map((r) => h('li', { text: plainText(w.refTo(r.field, r.to, r.many)) })),
          ...c.refsIn.map((r) => h('li', { text: plainText(w.refFrom(r.from, r.field)) })),
        ),
      )
    if (c.type !== 'view') {
      parts.push(h('h3', { class: 'mm-section-title', text: w.indexes }))
      parts.push(
        c.indexes
          ? table(
              w.indexColumns,
              c.indexes.map((ix) => [mono(ix.name), mono(ix.keys), plain(indexKind(ix, w, lang))]),
            )
          : extras.has(c.name)
            ? h('p', { class: 'mm-subtle', text: plainText(indexesNote(c, w)) })
            : skeleton(1),
      )
      if (extras.has(c.name)) parts.push(h('p', { text: plainText(rulesNote(c, w)) }))
    }
    return h(
      'section',
      { class: 'mm-card mm-card-pad dd-section', id: c.anchor, data: { collection: c.name } },
      ...parts,
    )
  }

  function render(): void {
    const text = pick(PAGE_TEXT, locale)
    document.documentElement.lang = langTag(shown(PAGE_TEXT, locale))
    const actions =
      phase === 'ready'
        ? [
            button({
              label: text.markdown,
              icon: 'download',
              id: 'save-markdown',
              title: text.saveHint,
              onClick: () => void save('markdown'),
            }),
            button({
              label: text.html,
              icon: 'download',
              id: 'save-html',
              title: text.saveHint,
              onClick: () => void save('html'),
            }),
            button({ label: text.copy, icon: 'copy', id: 'copy-markdown', onClick: () => void copy() }),
          ]
        : []
    header.setText(text.title, plainText(text.description(ctx?.place?.db ?? '')))
    header.querySelector('.mm-head-actions')!.replaceChildren(...actions)
    body.replaceChildren()
    status.textContent = ''
    if (phase === 'noPlace') return void body.append(emptyState({ icon: 'book', title: text.noPlace }))
    if (phase === 'failed')
      return void body.append(
        callout(
          'danger',
          failure instanceof AskError && failure.code === 'not_permitted'
            ? text.notAllowed
            : `${text.failed}${askMessage(failure, locale)}`,
        ),
      )
    const d = dictionary()
    if (!d) {
      status.textContent = text.reading
      return void body.append(skeleton(6))
    }
    const w = wordsFor(locale)
    const total = d.collections.length
    if (done < total) status.textContent = waiting ? text.waiting : text.readingDefs(done, total)
    body.append(
      h('p', {
        class: 'mm-subtle',
        text: w.sampled(
          new Intl.NumberFormat(langTag(shown(PAGE_TEXT, locale))).format(d.sampleSize),
          when(d.at, locale),
        ),
      }),
      h(
        'nav',
        { class: 'dd-contents', attrs: { 'aria-label': w.contents } },
        h('h2', { class: 'mm-section-title', text: w.contents }),
        h(
          'ul',
          {},
          ...d.collections.map((c) => {
            const a = h('a', { attrs: { href: `#${c.anchor}` }, text: plainText(c.name) })
            a.addEventListener('click', (e) => {
              e.preventDefault()
              document.getElementById(c.anchor)?.scrollIntoView({ block: 'start' })
            })
            return h('li', {}, a)
          }),
        ),
      ),
      ...(d.skipped ? [callout('info', w.skipped(d.skipped))] : []),
      ...(note ? [callout(note.tone, note.text)] : []),
      ...d.collections.map((c) => section(c, locale)),
    )
  }

  client.onContext((next, theme, accent) => {
    locale = next
    applyLook(theme, accent)
    render()
  })
  client.onReady(async () => {
    try {
      ctx = await client.ask<PluginContext>('context.get')
      locale = ctx.locale
      applyLook(ctx.theme, ctx.accent)
      if (!ctx.place) {
        phase = 'noPlace'
        return render()
      }
      render()
      model = await client.ask<Model>('database.model')
      phase = 'ready'
      render()
      await readDefinitions()
    } catch (e) {
      failure = e
      phase = 'failed'
    }
    render()
  })
  render()
}
