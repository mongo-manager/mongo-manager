/*
 * Hello documents: a starter plugin for Mongo Manager, in plain JavaScript with no build step.
 *
 * The page runs in a sandboxed frame with an opaque origin: no network, no storage, no access to the
 * app's page. It talks to the app only through postMessage, with the protocol of the app's plugin kit
 * (packages/plugins/kit/src/client.ts), which the small client below follows exactly.
 *
 * Everything shown is set as text (textContent, or strings appended as text nodes): never as markup.
 */

// ---------------------------------------------------------------------------------------------------
// The bridge client
// ---------------------------------------------------------------------------------------------------

/** A request the app did not take: its code (not_permitted, too_many, ...) and its message. */
class AskError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * The frame side of the bridge.
 * - Only messages from the app that framed the page (window.parent) are read, and only `mm: 1` ones.
 * - The app greets the page once it has loaded: `{ mm: 1, type: 'hello', token }`. Requests wait for
 *   the greeting and carry its token; the app ignores a request without it.
 * - A request is `{ mm: 1, id, method, params, token }` with a numeric id; the answer comes back with
 *   the same id as `{ mm: 1, id, result }` or `{ mm: 1, id, error: { code, message } }`.
 * - `{ mm: 1, type: 'context.changed', locale, theme, accent }` arrives when the user changes them,
 *   and, to a plugin with documents:read, when the Documents filter changes (ask `context.get` again
 *   for it; a collection tab that asked `ui.keepOpen` hears of it while out of sight).
 * - The app may ask a cell renderer `cells.render` (a string id); the answer carries the token.
 * - A request gives up after `timeoutMs` with the code `timeout`, except those the app may ask the
 *   user about first, which wait as long as the question can stay (the app ends its question
 *   sooner, so the page never gives up while the user may still say yes), and `ui.compact`, which
 *   answers when the compaction ends.
 */
const QUESTION_METHODS = new Set([
  'documents.update',
  'ui.useAggregation',
  'ui.copy',
  'ui.download',
  'ui.importDocuments',
])
const QUESTION_TIMEOUT_MS = 180_000
const LONG_METHODS = new Map([['ui.compact', 12 * 3_600_000]])

function createClient(timeoutMs = 15000) {
  const host = window.parent
  let token = null
  let counter = 0
  const waiting = new Map()
  const ready = []
  const contextListeners = []
  let cells = null
  // The contribution this page shows, from the address's fragment: `#collectionTab=list`.
  const [kind = '', id = ''] = location.hash.slice(1).split('=')

  window.addEventListener('message', (event) => {
    if (event.source !== host) return
    const m = event.data
    if (!m || typeof m !== 'object' || m.mm !== 1) return
    if (m.type === 'hello' && typeof m.token === 'string' && token === null) {
      token = m.token
      for (const send of ready.splice(0)) send()
      return
    }
    if (m.type === 'context.changed') {
      if (typeof m.locale === 'string' && (m.theme === 'light' || m.theme === 'dark'))
        for (const fn of contextListeners) fn({ locale: m.locale, theme: m.theme, accent: m.accent })
      return
    }
    if (m.method === 'cells.render' && typeof m.id === 'string') {
      // One answer per value ({ text, tone } or null), in the same order; at most 200 values a batch.
      const p = m.params && typeof m.params === 'object' ? m.params : {}
      const values = Array.isArray(p.values) ? p.values.slice(0, 200) : []
      const paths = Array.isArray(p.paths) ? p.paths : []
      Promise.resolve()
        .then(() =>
          cells ? cells(String(p.renderer ?? ''), values, String(p.locale ?? ''), paths, p.place) : [],
        )
        .catch(() => [])
        .then((result) => {
          host.postMessage({ mm: 1, id: m.id, token, result: Array.isArray(result) ? result : [] }, '*')
        })
      return
    }
    const pending = typeof m.id === 'number' ? waiting.get(m.id) : undefined
    if (!pending) return
    waiting.delete(m.id)
    if (m.error) pending.reject(new AskError(m.error.code, m.error.message))
    else pending.resolve(m.result)
  })

  return {
    contribution: { kind, id: decodeURIComponent(id) },
    /** Asks the app; answered by id, or failed with the code `timeout` after a while. */
    ask(method, params) {
      const n = ++counter
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            waiting.delete(n)
            reject(new AskError('timeout', 'No answer'))
          },
          LONG_METHODS.get(method) ??
            (QUESTION_METHODS.has(method) ? Math.max(timeoutMs, QUESTION_TIMEOUT_MS) : timeoutMs),
        )
        waiting.set(n, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        const send = () => host.postMessage({ mm: 1, id: n, method, params, token }, '*')
        if (token !== null) send()
        else ready.push(send)
      })
    },
    /** Called once the app greeted the page. */
    onReady(fn) {
      if (token !== null) fn()
      else ready.push(fn)
    },
    /** The app's language, theme or accent changed. */
    onContext(fn) {
      contextListeners.push(fn)
    },
    /** Answers the app's questions about cell values (only for a plugin with cellRenderers). */
    onCells(fn) {
      cells = fn
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// Small DOM helpers: text is always a text node
// ---------------------------------------------------------------------------------------------------

/** An element; strings among the children become text nodes, never markup. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  if (props.class) el.className = props.class
  if (props.text !== undefined) el.textContent = props.text
  if (props.title) el.title = props.title
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    // Event handlers go through addEventListener only, never through an attribute.
    if (/^on/i.test(name)) throw new Error(`No ${name} attribute`)
    el.setAttribute(name, value)
  }
  if (props.onClick) el.addEventListener('click', props.onClick)
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child)
  return el
}

const ACCENTS = ['emerald', 'indigo', 'violet', 'ocean', 'rose']

/** The app's theme and accent on this page: style.css reads `html.dark` and `html[data-accent]`. */
function applyLook(theme, accent) {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.accent = ACCENTS.includes(accent) ? accent : 'emerald'
}

/** A value of canonical Extended JSON as one line of text. */
function describe(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return `[ ${value.length} ]`
  if (typeof value.$oid === 'string') return value.$oid
  for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'])
    if (typeof value[key] === 'string') return value[key]
  if ('$date' in value) {
    const d = value.$date
    const ms = typeof d === 'string' ? Date.parse(d) : Number(d?.$numberLong)
    if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) return new Date(ms).toISOString()
  }
  const keys = Object.keys(value)
  if (keys.length && keys.every((k) => k.startsWith('$'))) return JSON.stringify(value)
  return `{ ${text().fields(num(keys.length), keys.length)} }`
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// ---------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------

const LIMIT = 50
const MAX_COLUMNS = 4

/** A count's plural form in a language, by its own rules: `one`, `few`, `many` or `other`. */
const pluralOf = (language, n) => new Intl.PluralRules(langTag(language)).select(n)
/** The three Russian plural forms: 1, 21, 31… / 2–4, 22–24… / 0, 5–20, 25–30… */
const ruForm = (n, one, few, many) => {
  const form = pluralOf('ru', n)
  return form === 'one' ? one : form === 'few' ? few : many
}

/*
 * Every language builds its counts as a whole phrase (`shown`, `fields`), because the order of number
 * and word differs: "50 documents", "도큐먼트 50개", "50 документов". `num` is the count already
 * formatted in the language the words are in.
 */
const TEXT = {
  en: {
    title: 'Hello documents',
    loading: 'Loading…',
    reload: 'Reload',
    open: 'Open',
    actions: 'Actions',
    view: 'View (read-only)',
    shown: (num, n, more) =>
      `${num}${more ? '+' : ''} ${pluralOf('en', n) === 'one' ? 'document' : 'documents'}`,
    fields: (num, n) => `${num} ${pluralOf('en', n) === 'one' ? 'field' : 'fields'}`,
    filtered: 'as the Documents filter keeps them',
    noPlaceTitle: 'No collection',
    noPlaceHint: "Open a collection's tab, then click Hello documents in the sidebar.",
    emptyTitle: 'No documents',
    emptyHint: 'This collection, or this filter, has no documents.',
    failed: 'Could not read the documents',
    errors: {
      not_permitted: 'The plugin is not allowed to do this.',
      too_many: 'Too many requests in a minute: try again shortly.',
      not_visible: 'This cannot be done from here.',
      no_collection: 'Open a collection first.',
      timeout: 'The app did not answer in time.',
      busy: 'The app is busy with another request: try again shortly.',
      blocked: 'This is blocked after being declined twice.',
      declined: 'The request was declined.',
      unanswered: 'The question in the app got no answer.',
      no_activation: 'This works only right after a click in the page.',
      read_only: 'This is a view, which is read-only: nothing was changed.',
      not_found: 'It was not found: it may have been deleted or moved.',
      unavailable: 'This is not available here.',
      too_large: 'This is too large to send: ask for less at a time.',
    },
  },
  tr: {
    title: 'Merhaba belgeler',
    loading: 'Yükleniyor…',
    reload: 'Yenile',
    open: 'Aç',
    actions: 'İşlemler',
    view: 'Görünüm (salt okunur)',
    shown: (num, n, more) => `${num}${more ? '+' : ''} belge`,
    fields: (num) => `${num} alan`,
    filtered: 'Belgeler filtresine göre',
    noPlaceTitle: 'Koleksiyon yok',
    noPlaceHint: 'Bir koleksiyonun sekmesini açın, sonra kenar çubuğunda Merhaba belgeler’e tıklayın.',
    emptyTitle: 'Belge yok',
    emptyHint: 'Bu koleksiyonda ya da bu filtreyle hiç belge yok.',
    failed: 'Belgeler okunamadı',
    errors: {
      not_permitted: 'Eklentinin bunu yapmasına izin verilmiyor.',
      too_many: 'Bir dakikada çok fazla istek: biraz sonra yeniden deneyin.',
      not_visible: 'Bu, buradan yapılamaz.',
      no_collection: 'Önce bir koleksiyon açın.',
      timeout: 'Uygulama zamanında yanıt vermedi.',
      busy: 'Uygulama başka bir istekle meşgul: biraz sonra yeniden deneyin.',
      blocked: 'İki kez reddedildiği için bu engellendi.',
      declined: 'İstek reddedildi.',
      unanswered: 'Uygulamadaki soru yanıtsız kaldı.',
      no_activation: 'Bu, yalnızca sayfada bir tıklamadan hemen sonra çalışır.',
      read_only: 'Bu bir görünüm, salt okunur: hiçbir şey değişmedi.',
      not_found: 'Bulunamadı: silinmiş ya da taşınmış olabilir.',
      unavailable: 'Bu, burada kullanılamıyor.',
      too_large: 'Bu, göndermek için fazla büyük: tek seferde daha azını isteyin.',
    },
  },
  zh: {
    title: '你好，文档',
    loading: '加载中…',
    reload: '重新加载',
    open: '打开',
    actions: '操作',
    view: '视图（只读）',
    shown: (num, n, more) => `${num}${more ? '+' : ''} 个文档`,
    fields: (num) => `${num} 个字段`,
    filtered: '按文档筛选保留的结果',
    noPlaceTitle: '没有集合',
    noPlaceHint: '先打开一个集合的标签页，再点击侧边栏中的“你好，文档”。',
    emptyTitle: '没有文档',
    emptyHint: '此集合或此筛选条件下没有文档。',
    failed: '无法读取文档',
    errors: {
      not_permitted: '不允许该插件执行此操作。',
      too_many: '一分钟内请求过多：请稍后再试。',
      not_visible: '无法在此处执行此操作。',
      no_collection: '请先打开一个集合。',
      timeout: '应用未在规定时间内响应。',
      busy: '应用正忙于处理另一个请求：请稍后再试。',
      blocked: '因被拒绝两次，此操作已被阻止。',
      declined: '请求已被拒绝。',
      unanswered: '应用中的提问没有得到回应。',
      no_activation: '此操作只能在页面中点击后立即执行。',
      read_only: '这是一个视图，只读：未做任何更改。',
      not_found: '未找到：它可能已被删除或移动。',
      unavailable: '此处不可用。',
      too_large: '内容太大，无法发送：请每次请求更少的内容。',
    },
  },
  ja: {
    title: 'こんにちは、ドキュメント',
    loading: '読み込み中…',
    reload: '再読み込み',
    open: '開く',
    actions: '操作',
    view: 'ビュー（読み取り専用）',
    shown: (num, n, more) => `${num}${more ? '+' : ''} 件のドキュメント`,
    fields: (num) => `${num} 個のフィールド`,
    filtered: 'ドキュメントのフィルターで絞り込み済み',
    noPlaceTitle: 'コレクションがありません',
    noPlaceHint:
      'コレクションのタブを開いてから、サイドバーの「こんにちは、ドキュメント」をクリックしてください。',
    emptyTitle: 'ドキュメントがありません',
    emptyHint: 'このコレクション、またはこのフィルターにはドキュメントがありません。',
    failed: 'ドキュメントを読み取れませんでした',
    errors: {
      not_permitted: 'このプラグインにはこの操作が許可されていません。',
      too_many: '1 分間のリクエストが多すぎます。しばらくしてからもう一度お試しください。',
      not_visible: 'ここからは実行できません。',
      no_collection: '先にコレクションを開いてください。',
      timeout: 'アプリが時間内に応答しませんでした。',
      busy: 'アプリは別のリクエストを処理中です。しばらくしてからもう一度お試しください。',
      blocked: '2 回拒否されたため、この操作はブロックされています。',
      declined: 'リクエストは拒否されました。',
      unanswered: 'アプリでの確認に応答がありませんでした。',
      no_activation: 'この操作は、ページ内でクリックした直後にのみ実行できます。',
      read_only: 'これはビューのため読み取り専用です。何も変更されていません。',
      not_found: '見つかりませんでした。削除または移動された可能性があります。',
      unavailable: 'ここでは利用できません。',
      too_large: '大きすぎて送信できません。一度に求める量を減らしてください。',
    },
  },
  es: {
    title: 'Hola documentos',
    loading: 'Cargando…',
    reload: 'Recargar',
    open: 'Abrir',
    actions: 'Acciones',
    view: 'Vista (solo lectura)',
    shown: (num, n, more) =>
      `${num}${more ? '+' : ''} ${pluralOf('es', n) === 'one' ? 'documento' : 'documentos'}`,
    fields: (num, n) => `${num} ${pluralOf('es', n) === 'one' ? 'campo' : 'campos'}`,
    filtered: 'según los conserva el filtro de Documentos',
    noPlaceTitle: 'Ninguna colección',
    noPlaceHint: 'Abre la pestaña de una colección y luego haz clic en Hola documentos en la barra lateral.',
    emptyTitle: 'Sin documentos',
    emptyHint: 'Esta colección, o este filtro, no tiene documentos.',
    failed: 'No se pudieron leer los documentos',
    errors: {
      not_permitted: 'El plugin no tiene permiso para hacer esto.',
      too_many: 'Demasiadas solicitudes en un minuto: inténtalo de nuevo en breve.',
      not_visible: 'Esto no se puede hacer desde aquí.',
      no_collection: 'Abre primero una colección.',
      timeout: 'La aplicación no respondió a tiempo.',
      busy: 'La aplicación está ocupada con otra solicitud: inténtalo de nuevo en breve.',
      blocked: 'Esto está bloqueado tras rechazarse dos veces.',
      declined: 'La solicitud fue rechazada.',
      unanswered: 'La pregunta en la aplicación quedó sin respuesta.',
      no_activation: 'Esto solo funciona justo después de un clic en la página.',
      read_only: 'Es una vista, de solo lectura: no se cambió nada.',
      not_found: 'No se encontró: puede que se haya eliminado o movido.',
      unavailable: 'Esto no está disponible aquí.',
      too_large: 'Es demasiado grande para enviarlo: pide menos cada vez.',
    },
  },
  pt: {
    title: 'Olá documentos',
    loading: 'Carregando…',
    reload: 'Recarregar',
    open: 'Abrir',
    actions: 'Ações',
    view: 'Visualização (somente leitura)',
    shown: (num, n, more) =>
      `${num}${more ? '+' : ''} ${pluralOf('pt', n) === 'one' ? 'documento' : 'documentos'}`,
    fields: (num, n) => `${num} ${pluralOf('pt', n) === 'one' ? 'campo' : 'campos'}`,
    filtered: 'como o filtro de Documentos os mantém',
    noPlaceTitle: 'Nenhuma coleção',
    noPlaceHint: 'Abra a guia de uma coleção e depois clique em Olá documentos na barra lateral.',
    emptyTitle: 'Nenhum documento',
    emptyHint: 'Esta coleção, ou este filtro, não tem documentos.',
    failed: 'Não foi possível ler os documentos',
    errors: {
      not_permitted: 'O plugin não tem permissão para fazer isso.',
      too_many: 'Muitas solicitações em um minuto: tente novamente em instantes.',
      not_visible: 'Isso não pode ser feito daqui.',
      no_collection: 'Abra uma coleção primeiro.',
      timeout: 'O aplicativo não respondeu a tempo.',
      busy: 'O aplicativo está ocupado com outra solicitação: tente novamente em instantes.',
      blocked: 'Isso está bloqueado após ser recusado duas vezes.',
      declined: 'A solicitação foi recusada.',
      unanswered: 'A pergunta no aplicativo ficou sem resposta.',
      no_activation: 'Isso só funciona logo após um clique na página.',
      read_only: 'Isto é uma view, somente leitura: nada foi alterado.',
      not_found: 'Não foi encontrado: pode ter sido excluído ou movido.',
      unavailable: 'Isso não está disponível aqui.',
      too_large: 'É grande demais para enviar: peça menos de cada vez.',
    },
  },
  ko: {
    title: '안녕하세요, 도큐먼트',
    loading: '불러오는 중…',
    reload: '새로고침',
    open: '열기',
    actions: '작업',
    view: '뷰(읽기 전용)',
    shown: (num, n, more) => `도큐먼트 ${num}${more ? '+' : ''}개`,
    fields: (num) => `필드 ${num}개`,
    filtered: '도큐먼트 필터로 걸러진 결과',
    noPlaceTitle: '컬렉션 없음',
    noPlaceHint: '컬렉션 탭을 연 다음 사이드바에서 “안녕하세요, 도큐먼트”를 클릭하세요.',
    emptyTitle: '도큐먼트 없음',
    emptyHint: '이 컬렉션 또는 이 필터에 도큐먼트가 없습니다.',
    failed: '도큐먼트를 읽을 수 없습니다',
    errors: {
      not_permitted: '플러그인에 이 작업이 허용되지 않았습니다.',
      too_many: '1분 동안 요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
      not_visible: '여기에서는 수행할 수 없습니다.',
      no_collection: '먼저 컬렉션을 여세요.',
      timeout: '앱이 제때 응답하지 않았습니다.',
      busy: '앱이 다른 요청을 처리 중입니다. 잠시 후 다시 시도하세요.',
      blocked: '두 번 거부되어 이 작업은 차단되었습니다.',
      declined: '요청이 거부되었습니다.',
      unanswered: '앱의 확인 요청에 응답이 없었습니다.',
      no_activation: '이 작업은 페이지에서 클릭한 직후에만 동작합니다.',
      read_only: '뷰는 읽기 전용이라 아무것도 변경되지 않았습니다.',
      not_found: '찾을 수 없습니다. 삭제되었거나 이동되었을 수 있습니다.',
      unavailable: '여기에서는 사용할 수 없습니다.',
      too_large: '너무 커서 보낼 수 없습니다. 한 번에 더 적게 요청하세요.',
    },
  },
  de: {
    title: 'Hallo Dokumente',
    loading: 'Wird geladen…',
    reload: 'Neu laden',
    open: 'Öffnen',
    actions: 'Aktionen',
    view: 'View (schreibgeschützt)',
    shown: (num, n, more) =>
      `${num}${more ? '+' : ''} ${pluralOf('de', n) === 'one' ? 'Dokument' : 'Dokumente'}`,
    fields: (num, n) => `${num} ${pluralOf('de', n) === 'one' ? 'Feld' : 'Felder'}`,
    filtered: 'gefiltert nach dem Dokumente-Filter',
    noPlaceTitle: 'Keine Collection',
    noPlaceHint:
      'Öffnen Sie den Tab einer Collection und klicken Sie dann in der Seitenleiste auf Hallo Dokumente.',
    emptyTitle: 'Keine Dokumente',
    emptyHint: 'Diese Collection oder dieser Filter enthält keine Dokumente.',
    failed: 'Die Dokumente konnten nicht gelesen werden',
    errors: {
      not_permitted: 'Das Plugin darf dies nicht tun.',
      too_many: 'Zu viele Anfragen in einer Minute: Versuchen Sie es gleich noch einmal.',
      not_visible: 'Das ist von hier aus nicht möglich.',
      no_collection: 'Öffnen Sie zuerst eine Collection.',
      timeout: 'Die App hat nicht rechtzeitig geantwortet.',
      busy: 'Die App bearbeitet gerade eine andere Anfrage: Versuchen Sie es gleich noch einmal.',
      blocked: 'Dies ist gesperrt, nachdem es zweimal abgelehnt wurde.',
      declined: 'Die Anfrage wurde abgelehnt.',
      unanswered: 'Die Rückfrage in der App blieb unbeantwortet.',
      no_activation: 'Das funktioniert nur unmittelbar nach einem Klick auf der Seite.',
      read_only: 'Das ist eine View und nur lesbar: Es wurde nichts geändert.',
      not_found: 'Nicht gefunden: Es wurde vielleicht gelöscht oder verschoben.',
      unavailable: 'Das ist hier nicht verfügbar.',
      too_large: 'Das ist zu groß zum Senden: Fragen Sie jeweils nach weniger.',
    },
  },
  fr: {
    title: 'Bonjour documents',
    loading: 'Chargement…',
    reload: 'Recharger',
    open: 'Ouvrir',
    actions: 'Actions',
    view: 'Vue (lecture seule)',
    // French counts 0 and 1 as singular.
    shown: (num, n, more) =>
      `${num}${more ? '+' : ''} ${pluralOf('fr', n) === 'one' ? 'document' : 'documents'}`,
    fields: (num, n) => `${num} ${pluralOf('fr', n) === 'one' ? 'champ' : 'champs'}`,
    filtered: 'tels que les conserve le filtre Documents',
    noPlaceTitle: 'Aucune collection',
    noPlaceHint:
      'Ouvrez l’onglet d’une collection, puis cliquez sur Bonjour documents dans la barre latérale.',
    emptyTitle: 'Aucun document',
    emptyHint: 'Cette collection, ou ce filtre, ne contient aucun document.',
    failed: 'Impossible de lire les documents',
    errors: {
      not_permitted: 'Le plug-in n’est pas autorisé à faire cela.',
      too_many: 'Trop de demandes en une minute : réessayez dans un instant.',
      not_visible: 'Impossible de faire cela depuis ici.',
      no_collection: 'Ouvrez d’abord une collection.',
      timeout: 'L’application n’a pas répondu à temps.',
      busy: 'L’application traite une autre demande : réessayez dans un instant.',
      blocked: 'Cette action est bloquée après deux refus.',
      declined: 'La demande a été refusée.',
      unanswered: 'La question posée dans l’application est restée sans réponse.',
      no_activation: 'Cela ne fonctionne que juste après un clic dans la page.',
      read_only: 'C’est une vue, en lecture seule : rien n’a été modifié.',
      not_found: 'Introuvable : cela a peut-être été supprimé ou déplacé.',
      unavailable: 'Ce n’est pas disponible ici.',
      too_large: 'C’est trop volumineux pour être envoyé : demandez-en moins à la fois.',
    },
  },
  ru: {
    title: 'Привет, документы',
    loading: 'Загрузка…',
    reload: 'Обновить',
    open: 'Открыть',
    actions: 'Действия',
    view: 'Представление (только чтение)',
    shown: (num, n, more) => `${num}${more ? '+' : ''} ${ruForm(n, 'документ', 'документа', 'документов')}`,
    fields: (num, n) => `${num} ${ruForm(n, 'поле', 'поля', 'полей')}`,
    filtered: 'как их оставляет фильтр документов',
    noPlaceTitle: 'Нет коллекции',
    noPlaceHint: 'Откройте вкладку коллекции, затем нажмите «Привет, документы» на боковой панели.',
    emptyTitle: 'Нет документов',
    emptyHint: 'В этой коллекции или с этим фильтром нет документов.',
    failed: 'Не удалось прочитать документы',
    errors: {
      not_permitted: 'Плагину не разрешено это делать.',
      too_many: 'Слишком много запросов за минуту: повторите попытку чуть позже.',
      not_visible: 'Отсюда это сделать нельзя.',
      no_collection: 'Сначала откройте коллекцию.',
      timeout: 'Приложение не ответило вовремя.',
      busy: 'Приложение занято другим запросом: повторите попытку чуть позже.',
      blocked: 'Действие заблокировано после двух отказов.',
      declined: 'Запрос отклонен.',
      unanswered: 'Вопрос в приложении остался без ответа.',
      no_activation: 'Это работает только сразу после щелчка на странице.',
      read_only: 'Это представление, оно только для чтения: ничего не изменено.',
      not_found: 'Не найдено: возможно, это удалено или перемещено.',
      unavailable: 'Здесь это недоступно.',
      too_large: 'Слишком большой объем для отправки: запрашивайте меньше за раз.',
    },
  },
}

/** The app's languages this template speaks; anything else falls back to English. */
const LANGUAGES = ['en', 'tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru']
const languageOf = (locale) => (LANGUAGES.includes(locale) ? locale : 'en')
/** The language the words are really in: the reader's, or English where TEXT has none. */
const shown = (locale) => {
  const language = languageOf(locale)
  return Object.hasOwn(TEXT, language) ? language : 'en'
}
/** The `<html lang>` value for a language. */
const langTag = (language) => (language === 'zh' ? 'zh-CN' : language === 'pt' ? 'pt-BR' : language)

const client = createClient()
const root = document.getElementById('app')
const state = {
  locale: 'en',
  context: null,
  loading: true,
  documents: [],
  hasMore: false,
  error: null,
  notice: null,
}

const text = () => TEXT[shown(state.locale)] ?? TEXT.en
/** A number in the language the words are in. */
const num = (n) => new Intl.NumberFormat(langTag(shown(state.locale))).format(n)
/** A failure in the user's language: a known code's words, else the app's own message. */
const explain = (error) => {
  const errors = text().errors
  if (typeof error?.code === 'string' && Object.hasOwn(errors, error.code)) return errors[error.code]
  return error instanceof Error ? error.message : String(error)
}

/** The fields shown: `_id`, then the top-level fields most documents have. */
function columnsOf(documents) {
  const counts = new Map()
  for (const doc of documents)
    for (const key of Object.keys(doc)) if (key !== '_id') counts.set(key, (counts.get(key) ?? 0) + 1)
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_COLUMNS)
    .map(([key]) => key)
  return ['_id', ...top]
}

function emptyState(title, hint) {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: title }), h('p', { text: hint }))
}

async function openDocument(id) {
  try {
    await client.ask('ui.openDocument', { id })
  } catch (error) {
    state.notice = explain(error)
    render()
  }
}

function documentsTable(documents) {
  const columns = columnsOf(documents)
  const head = h(
    'tr',
    {},
    ...columns.map((c) => h('th', { text: c, attrs: { scope: 'col' } })),
    // Every column is named for a screen reader, the buttons' one too.
    h('th', { attrs: { scope: 'col' } }, h('span', { class: 'sr-only', text: text().actions })),
  )
  const rows = documents.map((doc) =>
    h(
      'tr',
      {},
      ...columns.map((c) => {
        const full = c in doc ? describe(doc[c]) : ''
        return h('td', { text: cut(full, 80), title: full.length > 80 ? full.slice(0, 2000) : '' })
      }),
      h(
        'td',
        { class: 'actions' },
        h('button', {
          class: 'btn btn-small',
          text: text().open,
          attrs: { type: 'button' },
          onClick: () => openDocument(doc._id),
        }),
      ),
    ),
  )
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), h('tbody', {}, ...rows)))
}

function render() {
  const t = text()
  const place = state.context?.place ?? null
  document.documentElement.lang = langTag(shown(state.locale))
  document.title = t.title

  const reload = h('button', {
    class: 'btn',
    text: t.reload,
    attrs: { type: 'button' },
    onClick: () => void load(),
  })
  reload.disabled = state.loading || !place

  const where = place
    ? `${place.db}.${place.coll}${place.connectionName ? ` · ${place.connectionName}` : ''}`
    : ''
  const header = h(
    'header',
    { class: 'head' },
    h(
      'div',
      { class: 'head-text' },
      h('h1', { text: t.title }),
      where ? h('p', { class: 'muted', text: where }) : null,
    ),
    place?.view ? h('span', { class: 'badge', text: t.view }) : null,
    reload,
  )

  let body
  if (state.loading) body = h('p', { class: 'muted', text: t.loading })
  else if (state.error)
    body = h(
      'div',
      { class: 'callout', attrs: { role: 'alert' } },
      h('strong', { text: t.failed }),
      h('p', { text: explain(state.error) }),
    )
  else if (!place) body = emptyState(t.noPlaceTitle, t.noPlaceHint)
  else if (!state.documents.length) body = emptyState(t.emptyTitle, t.emptyHint)
  else {
    const filtered = place.filter && Object.keys(place.filter).length > 0
    body = h(
      'div',
      { class: 'stack' },
      h('p', {
        class: 'muted',
        text: `${t.shown(num(state.documents.length), state.documents.length, state.hasMore)}${filtered ? ` · ${t.filtered}` : ''}`,
      }),
      documentsTable(state.documents),
    )
  }

  const notice = h('p', {
    class: 'notice',
    text: state.notice ?? '',
    attrs: { role: 'status', 'aria-live': 'polite' },
  })
  root.replaceChildren(header, h('main', { class: 'body' }, notice, body))
}

async function load() {
  state.loading = true
  state.error = null
  state.notice = null
  render()
  try {
    // Asked each time: the Documents filter may have changed since the page opened.
    const context = await client.ask('context.get')
    state.context = context
    state.locale = context.locale
    applyLook(context.theme, context.accent)
    const place = context.place
    // The Documents filter, for a collection tab ({} on a page); canonical Extended JSON both ways.
    const result = place
      ? await client.ask('documents.find', { filter: place.filter ?? {}, limit: LIMIT })
      : null
    state.documents = Array.isArray(result?.documents) ? result.documents : []
    state.hasMore = !!result?.hasMore
  } catch (error) {
    state.error = error
  } finally {
    state.loading = false
    render()
  }
}

client.onContext(({ locale, theme, accent }) => {
  state.locale = locale
  applyLook(theme, accent)
  render()
})

client.onReady(() => void load())

render()
