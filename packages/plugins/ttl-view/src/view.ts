import '../../kit/src/ui.css'
import './style.css'
import { type Language } from '../../kit/src/i18n'
import { askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  badge,
  button,
  callout,
  emptyState,
  formatNumber,
  h,
  langTag,
  pageHeader,
  pick,
  pluralOf,
  setBusy,
  setLabel,
  shown,
  skeleton,
  statusLine,
} from '../../kit/src/ui'
import { shellText } from '../../kit/src/shell'
import {
  BUCKETS,
  bucketFilter,
  countOf,
  countPipeline,
  duration,
  ttlIndexes,
  type Bucket,
  type ListedIndex,
  type TtlIndex,
} from './ttl'

interface Text {
  title: string
  description: (coll: string) => string
  count: string
  counting: (n: number, of: number) => string
  reading: string
  noPlace: string
  view: string
  none: string
  noneHint: string
  failed: string
  tryAgain: string
  removes: (field: string, after: string, zero: boolean) => string
  partial: (filter: string) => string
  buckets: Record<Bucket, string>
  neverHint: string
  waitingHint: string
  /** The count of documents, `n` formatted and `count` for the singular and plural forms. */
  documents: (n: string, count: number) => string
  countFailed: string
  show: string
  showHint: (group: string) => string
  showFailed: string
  arrays: string
}

/**
 * Expiry (research 2026-10-28: CUSTOMER-I-6486): a collection's TTL indexes, and for each how many
 * documents it removes when — already due, within the hour, the day, the week, later — and how many
 * it never removes; each group shown in Documents on a click. It only reads.
 */
export const TEXT = {
  en: {
    title: 'Expiry',
    description: (coll: string) => `When the TTL indexes of ${coll} remove its documents. Changes nothing.`,
    count: 'Count again',
    counting: (n: number, of: number) => `Counting group ${n} of ${of}…`,
    reading: 'Reading the indexes…',
    noPlace: 'Open a collection to see when its documents expire.',
    view: 'A view has no indexes of its own',
    none: 'This collection has no TTL index',
    noneHint:
      'A TTL index removes each document a set time after the date in one of its fields, for example createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }). A time series or clustered collection may instead expire documents by its own expireAfterSeconds, set on the collection, which is not shown here.',
    failed: 'The indexes could not be read',
    tryAgain: 'Try again',
    removes: (field: string, after: string, zero: boolean) =>
      `Removes a document ${zero ? after : after.replace('it', `its ${field}`)}`,
    partial: (filter: string) => `Only documents matching ${filter}`,
    buckets: {
      waiting: 'Due, not yet removed',
      hour: 'In the next hour',
      day: 'In 1–24 hours',
      week: 'In 1–7 days',
      later: 'After 7 days',
      never: 'Never',
    },
    neverHint: 'The field holds no date, or the document is outside the index’s filter.',
    waitingHint: 'The server’s TTL monitor runs about once a minute; on a busy server it may lag.',
    documents: (n: string, count: number) =>
      `${n} ${pluralOf(count, 'en') === 'one' ? 'document' : 'documents'}`,
    countFailed: 'Could not be counted',
    show: 'Show',
    showHint: (group: string) => `Puts a filter selecting the documents “${group}” in the Documents query`,
    showFailed: 'Could not open Documents: ',
    arrays: 'A document whose field holds several dates is counted by the earliest, which TTL removes it by.',
  },
  tr: {
    title: 'Süre dolumu',
    description: (coll: string) =>
      `${coll} koleksiyonunun TTL indeksleri belgelerini ne zaman siler. Hiçbir şeyi değiştirmez.`,
    count: 'Yeniden say',
    counting: (n: number, of: number) => `Grup ${n}/${of} sayılıyor…`,
    reading: 'İndeksler okunuyor…',
    noPlace: 'Belgelerinin süresinin ne zaman dolduğunu görmek için bir koleksiyon açın.',
    view: 'Bir görünümün kendine ait indeksi yoktur',
    none: 'Bu koleksiyonun TTL indeksi yok',
    noneHint:
      'Bir TTL indeksi her belgeyi alanlarından birindeki tarihten belirli bir süre sonra siler; örneğin createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }). Zaman serisi ya da kümelenmiş bir koleksiyon ise belgelerini koleksiyona tanımlanan kendi expireAfterSeconds değeriyle silebilir; bu burada gösterilmez.',
    failed: 'İndeksler okunamadı',
    tryAgain: 'Yeniden dene',
    removes: (field: string, after: string, zero: boolean) =>
      zero
        ? `Bir belgeyi ${field} alanındaki tarihte siler`
        : `Bir belgeyi ${field} alanındaki tarihten ${after} siler`,
    partial: (filter: string) => `Yalnızca ${filter} filtresine uyan belgeler`,
    buckets: {
      waiting: 'Süresi doldu, henüz silinmedi',
      hour: 'Önümüzdeki bir saatte',
      day: '1–24 saat içinde',
      week: '1–7 gün içinde',
      later: '7 günden sonra',
      never: 'Hiçbir zaman',
    },
    neverHint: 'Alan tarih taşımıyor ya da belge indeksin filtresinin dışında.',
    waitingHint: 'Sunucunun TTL izleyicisi yaklaşık dakikada bir çalışır; yoğun bir sunucuda gecikebilir.',
    documents: (n: string) => `${n} belge`,
    countFailed: 'Sayılamadı',
    show: 'Göster',
    showHint: (group: string) => `“${group}” belgelerini seçen bir filtreyi Belgeler sorgusuna koyar`,
    showFailed: 'Belgeler açılamadı: ',
    arrays: 'Alanı birden fazla tarih taşıyan bir belge, TTL’nin onu sildiği en erken tarihine göre sayılır.',
  },
  zh: {
    title: '到期',
    description: (coll: string) => `${coll} 的 TTL 索引何时删除其文档。不会更改任何内容。`,
    count: '重新统计',
    counting: (n: number, of: number) => `正在统计第 ${n} 组，共 ${of} 组…`,
    reading: '正在读取索引…',
    noPlace: '打开一个集合，即可查看其文档何时到期。',
    view: '视图没有自己的索引',
    none: '此集合没有 TTL 索引',
    noneHint:
      'TTL 索引会在文档某个字段中的日期之后经过设定的时间删除该文档，例如 createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 })。时间序列集合或聚簇集合也可以通过集合自身设置的 expireAfterSeconds 使文档到期，此处不显示。',
    failed: '无法读取索引',
    tryAgain: '重试',
    removes: (field: string, after: string, zero: boolean) =>
      zero ? `文档在其 ${field} 字段的日期时被删除` : `文档在其 ${field} 字段日期的${after}被删除`,
    partial: (filter: string) => `仅限符合 ${filter} 的文档`,
    buckets: {
      waiting: '已到期，尚未删除',
      hour: '未来 1 小时内',
      day: '1–24 小时内',
      week: '1–7 天内',
      later: '7 天之后',
      never: '永不',
    },
    neverHint: '该字段不含日期，或文档不在索引的筛选范围内。',
    waitingHint: '服务器的 TTL 监视器大约每分钟运行一次；服务器繁忙时可能会有延迟。',
    documents: (n: string) => `${n} 个文档`,
    countFailed: '无法统计',
    show: '显示',
    showHint: (group: string) => `将选择“${group}”文档的筛选条件放入“文档”查询`,
    showFailed: '无法打开“文档”：',
    arrays: '字段包含多个日期的文档，按最早的日期统计，TTL 也是按它来删除该文档的。',
  },
  ja: {
    title: '有効期限',
    description: (coll: string) =>
      `${coll} の TTL インデックスがドキュメントを削除するタイミングを表示します。何も変更しません。`,
    count: '再集計',
    counting: (n: number, of: number) => `グループ ${n}/${of} を集計中…`,
    reading: 'インデックスを読み込み中…',
    noPlace: 'コレクションを開くと、ドキュメントの有効期限を確認できます。',
    view: 'ビューには独自のインデックスがありません',
    none: 'このコレクションには TTL インデックスがありません',
    noneHint:
      'TTL インデックスは、フィールドの 1 つにある日時から一定時間が経過したドキュメントを削除します。例: createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 })。時系列コレクションやクラスター化コレクションは、コレクション自体に設定した expireAfterSeconds でドキュメントを期限切れにすることもありますが、ここには表示されません。',
    failed: 'インデックスを読み込めませんでした',
    tryAgain: '再試行',
    removes: (field: string, after: string, zero: boolean) =>
      zero
        ? `ドキュメントは ${field} フィールドの日時に削除されます`
        : `ドキュメントは ${field} フィールドの日時の${after}に削除されます`,
    partial: (filter: string) => `${filter} に一致するドキュメントのみ`,
    buckets: {
      waiting: '期限切れ（未削除）',
      hour: '今後 1 時間以内',
      day: '1～24 時間以内',
      week: '1～7 日以内',
      later: '7 日より後',
      never: '削除されない',
    },
    neverHint: 'フィールドに日時がないか、ドキュメントがインデックスのフィルターの対象外です。',
    waitingHint:
      'サーバーの TTL モニターは約 1 分ごとに実行されます。負荷の高いサーバーでは遅れることがあります。',
    documents: (n: string) => `${n} 件のドキュメント`,
    countFailed: '集計できませんでした',
    show: '表示',
    showHint: (group: string) =>
      `「${group}」のドキュメントを選択するフィルターを［ドキュメント］のクエリに設定します`,
    showFailed: '［ドキュメント］を開けませんでした: ',
    arrays: 'フィールドに複数の日時を持つドキュメントは、TTL が削除に使う最も早い日時で集計されます。',
  },
  es: {
    title: 'Caducidad',
    description: (coll: string) =>
      `Cuándo eliminan los índices TTL de ${coll} sus documentos. No cambia nada.`,
    count: 'Contar de nuevo',
    counting: (n: number, of: number) => `Contando el grupo ${n} de ${of}…`,
    reading: 'Leyendo los índices…',
    noPlace: 'Abre una colección para ver cuándo caducan sus documentos.',
    view: 'Una vista no tiene índices propios',
    none: 'Esta colección no tiene ningún índice TTL',
    noneHint:
      'Un índice TTL elimina cada documento pasado un tiempo establecido desde la fecha de uno de sus campos, por ejemplo createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }). Una colección de series temporales o agrupada (clustered) puede, en cambio, hacer caducar sus documentos con su propio expireAfterSeconds, definido en la colección, que no se muestra aquí.',
    failed: 'No se pudieron leer los índices',
    tryAgain: 'Reintentar',
    removes: (field: string, after: string, zero: boolean) =>
      zero
        ? `Elimina un documento en la fecha de ${field}`
        : `Elimina un documento ${after} de la fecha de ${field}`,
    partial: (filter: string) => `Solo los documentos que coinciden con ${filter}`,
    buckets: {
      waiting: 'Caducado, aún sin eliminar',
      hour: 'En la próxima hora',
      day: 'En 1–24 horas',
      week: 'En 1–7 días',
      later: 'Pasados 7 días',
      never: 'Nunca',
    },
    neverHint: 'El campo no contiene ninguna fecha, o el documento queda fuera del filtro del índice.',
    waitingHint:
      'El monitor TTL del servidor se ejecuta aproximadamente una vez por minuto; en un servidor con mucha carga puede retrasarse.',
    documents: (n: string, count: number) =>
      `${n} ${pluralOf(count, 'es') === 'one' ? 'documento' : 'documentos'}`,
    countFailed: 'No se pudo contar',
    show: 'Mostrar',
    showHint: (group: string) =>
      `Pone en la consulta de Documentos un filtro que selecciona los documentos «${group}»`,
    showFailed: 'No se pudo abrir Documentos: ',
    arrays:
      'Un documento cuyo campo contiene varias fechas se cuenta por la más temprana, que es la que usa TTL para eliminarlo.',
  },
  pt: {
    title: 'Expiração',
    description: (coll: string) =>
      `Quando os índices TTL de ${coll} removem seus documentos. Não altera nada.`,
    count: 'Contar novamente',
    counting: (n: number, of: number) => `Contando o grupo ${n} de ${of}…`,
    reading: 'Lendo os índices…',
    noPlace: 'Abra uma coleção para ver quando seus documentos expiram.',
    view: 'Uma visualização não tem índices próprios',
    none: 'Esta coleção não tem índice TTL',
    noneHint:
      'Um índice TTL remove cada documento depois de um tempo definido a partir da data de um de seus campos, por exemplo createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }). Uma coleção de séries temporais ou clusterizada pode, em vez disso, expirar documentos com o próprio expireAfterSeconds, definido na coleção, que não é exibido aqui.',
    failed: 'Não foi possível ler os índices',
    tryAgain: 'Tentar novamente',
    removes: (field: string, after: string, zero: boolean) =>
      zero ? `Remove um documento na data de ${field}` : `Remove um documento ${after} da data de ${field}`,
    partial: (filter: string) => `Somente documentos que correspondem a ${filter}`,
    buckets: {
      waiting: 'Expirado, ainda não removido',
      hour: 'Na próxima hora',
      day: 'Em 1–24 horas',
      week: 'Em 1–7 dias',
      later: 'Após 7 dias',
      never: 'Nunca',
    },
    neverHint: 'O campo não contém uma data, ou o documento está fora do filtro do índice.',
    waitingHint:
      'O monitor de TTL do servidor é executado cerca de uma vez por minuto; em um servidor ocupado, pode atrasar.',
    documents: (n: string, count: number) =>
      `${n} ${pluralOf(count, 'pt') === 'one' ? 'documento' : 'documentos'}`,
    countFailed: 'Não foi possível contar',
    show: 'Mostrar',
    showHint: (group: string) =>
      `Coloca na consulta de Documentos um filtro que seleciona os documentos “${group}”`,
    showFailed: 'Não foi possível abrir Documentos: ',
    arrays:
      'Um documento cujo campo contém várias datas é contado pela mais antiga, que é a que o TTL usa para removê-lo.',
  },
  ko: {
    title: '만료',
    description: (coll: string) =>
      `${coll}의 TTL 인덱스가 도큐먼트를 삭제하는 시점을 보여 줍니다. 아무것도 변경하지 않습니다.`,
    count: '다시 집계',
    counting: (n: number, of: number) => `그룹 ${n}/${of} 집계 중…`,
    reading: '인덱스를 읽는 중…',
    noPlace: '컬렉션을 열면 도큐먼트가 언제 만료되는지 볼 수 있습니다.',
    view: '뷰에는 자체 인덱스가 없습니다',
    none: '이 컬렉션에는 TTL 인덱스가 없습니다',
    noneHint:
      'TTL 인덱스는 도큐먼트의 필드 중 하나에 있는 날짜로부터 설정한 시간이 지나면 해당 도큐먼트를 삭제합니다. 예: createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }). 시계열 컬렉션이나 클러스터형 컬렉션은 대신 컬렉션 자체에 설정한 expireAfterSeconds로 도큐먼트를 만료시킬 수 있으며, 이는 여기에 표시되지 않습니다.',
    failed: '인덱스를 읽을 수 없습니다',
    tryAgain: '다시 시도',
    removes: (field: string, after: string, zero: boolean) =>
      zero
        ? `도큐먼트를 ${field} 필드의 날짜에 삭제합니다`
        : `도큐먼트를 ${field} 필드의 날짜 ${after}에 삭제합니다`,
    partial: (filter: string) => `다음 필터와 일치하는 도큐먼트만: ${filter}`,
    buckets: {
      waiting: '만료됨, 아직 삭제되지 않음',
      hour: '앞으로 1시간 이내',
      day: '1–24시간 이내',
      week: '1–7일 이내',
      later: '7일 이후',
      never: '삭제되지 않음',
    },
    neverHint: '필드에 날짜가 없거나 도큐먼트가 인덱스 필터 범위 밖에 있습니다.',
    waitingHint: '서버의 TTL 모니터는 약 1분마다 실행되며, 서버가 바쁘면 지연될 수 있습니다.',
    documents: (n: string) => `${n}개 도큐먼트`,
    countFailed: '집계할 수 없습니다',
    show: '표시',
    showHint: (group: string) => `“${group}” 도큐먼트를 선택하는 필터를 도큐먼트 쿼리에 넣습니다`,
    showFailed: '도큐먼트를 열 수 없습니다: ',
    arrays: '필드에 날짜가 여러 개인 도큐먼트는 TTL이 삭제 기준으로 삼는 가장 이른 날짜로 집계됩니다.',
  },
  de: {
    title: 'Ablauf',
    description: (coll: string) =>
      `Wann die TTL-Indizes von ${coll} ihre Dokumente entfernen. Ändert nichts.`,
    count: 'Erneut zählen',
    counting: (n: number, of: number) => `Gruppe ${n} von ${of} wird gezählt…`,
    reading: 'Indizes werden gelesen…',
    noPlace: 'Öffnen Sie eine Collection, um zu sehen, wann ihre Dokumente ablaufen.',
    view: 'Eine View hat keine eigenen Indizes',
    none: 'Diese Collection hat keinen TTL-Index',
    noneHint:
      'Ein TTL-Index entfernt jedes Dokument eine festgelegte Zeit nach dem Datum in einem seiner Felder, zum Beispiel createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }). Eine Time-Series- oder Clustered Collection kann Dokumente stattdessen über ihr eigenes expireAfterSeconds ablaufen lassen, das an der Collection festgelegt ist und hier nicht angezeigt wird.',
    failed: 'Die Indizes konnten nicht gelesen werden',
    tryAgain: 'Erneut versuchen',
    removes: (field: string, after: string, zero: boolean) =>
      zero
        ? `Entfernt ein Dokument zum Datum im Feld ${field}`
        : `Entfernt ein Dokument ${after} im Feld ${field}`,
    partial: (filter: string) => `Nur Dokumente, die ${filter} entsprechen`,
    buckets: {
      waiting: 'Abgelaufen, noch nicht entfernt',
      hour: 'In der nächsten Stunde',
      day: 'In 1–24 Stunden',
      week: 'In 1–7 Tagen',
      later: 'Nach 7 Tagen',
      never: 'Nie',
    },
    neverHint: 'Das Feld enthält kein Datum, oder das Dokument liegt außerhalb des Filters des Index.',
    waitingHint:
      'Der TTL-Monitor des Servers läuft etwa einmal pro Minute; auf einem ausgelasteten Server kann er sich verzögern.',
    documents: (n: string, count: number) =>
      `${n} ${pluralOf(count, 'de') === 'one' ? 'Dokument' : 'Dokumente'}`,
    countFailed: 'Konnte nicht gezählt werden',
    show: 'Anzeigen',
    showHint: (group: string) =>
      `Setzt einen Filter, der die Dokumente „${group}“ auswählt, in die Abfrage unter Dokumente`,
    showFailed: 'Dokumente konnten nicht geöffnet werden: ',
    arrays:
      'Ein Dokument, dessen Feld mehrere Daten enthält, wird nach dem frühesten gezählt, nach dem TTL es entfernt.',
  },
  fr: {
    title: 'Expiration',
    description: (coll: string) =>
      `Quand les index TTL de ${coll} suppriment ses documents. Ne modifie rien.`,
    count: 'Recompter',
    counting: (n: number, of: number) => `Comptage du groupe ${n} sur ${of}…`,
    reading: 'Lecture des index…',
    noPlace: 'Ouvrez une collection pour voir quand ses documents expirent.',
    view: 'Une vue n’a pas d’index propre',
    none: 'Cette collection n’a aucun index TTL',
    noneHint:
      'Un index TTL supprime chaque document au bout d’une durée définie après la date contenue dans l’un de ses champs, par exemple createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }). Une collection de séries chronologiques ou en cluster peut à la place faire expirer ses documents avec son propre expireAfterSeconds, défini sur la collection, qui n’est pas affiché ici.',
    failed: 'Impossible de lire les index',
    tryAgain: 'Réessayer',
    removes: (field: string, after: string, zero: boolean) =>
      zero
        ? `Supprime un document à la date du champ ${field}`
        : `Supprime un document ${after} du champ ${field}`,
    partial: (filter: string) => `Uniquement les documents correspondant à ${filter}`,
    buckets: {
      waiting: 'Expiré, pas encore supprimé',
      hour: 'Dans l’heure qui vient',
      day: 'Dans 1 à 24 heures',
      week: 'Dans 1 à 7 jours',
      later: 'Après 7 jours',
      never: 'Jamais',
    },
    neverHint: 'Le champ ne contient aucune date, ou le document est en dehors du filtre de l’index.',
    waitingHint:
      'Le moniteur TTL du serveur s’exécute environ une fois par minute ; sur un serveur chargé, il peut avoir du retard.',
    // Zero and one are singular in French.
    documents: (n: string, count: number) =>
      `${n} ${pluralOf(count, 'fr') === 'one' ? 'document' : 'documents'}`,
    countFailed: 'Comptage impossible',
    show: 'Afficher',
    showHint: (group: string) =>
      `Place dans la requête de Documents un filtre qui sélectionne les documents « ${group} »`,
    showFailed: 'Impossible d’ouvrir Documents : ',
    arrays:
      'Un document dont le champ contient plusieurs dates est compté selon la plus ancienne, celle d’après laquelle TTL le supprime.',
  },
  ru: {
    title: 'Срок действия',
    description: (coll: string) =>
      `Когда TTL-индексы коллекции ${coll} удаляют ее документы. Ничего не изменяет.`,
    count: 'Пересчитать',
    counting: (n: number, of: number) => `Подсчет группы ${n} из ${of}…`,
    reading: 'Чтение индексов…',
    noPlace: 'Откройте коллекцию, чтобы увидеть, когда истекает срок действия ее документов.',
    view: 'У представления нет собственных индексов',
    none: 'В этой коллекции нет TTL-индекса',
    noneHint:
      'TTL-индекс удаляет каждый документ через заданное время после даты в одном из его полей, например createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }). Коллекция временных рядов или кластеризованная коллекция может вместо этого задавать срок действия документов собственным expireAfterSeconds, указанным для коллекции; здесь он не показывается.',
    failed: 'Не удалось прочитать индексы',
    tryAgain: 'Повторить',
    removes: (field: string, after: string, zero: boolean) =>
      zero
        ? `Удаляет документ в момент даты в поле ${field}`
        : `Удаляет документ ${after} после даты в поле ${field}`,
    partial: (filter: string) => `Только документы, соответствующие ${filter}`,
    buckets: {
      waiting: 'Срок истек, еще не удалены',
      hour: 'В ближайший час',
      day: 'Через 1–24 часа',
      week: 'Через 1–7 дней',
      later: 'Позже чем через 7 дней',
      never: 'Никогда',
    },
    neverHint: 'В поле нет даты, или документ не попадает под фильтр индекса.',
    waitingHint:
      'Монитор TTL на сервере запускается примерно раз в минуту; на загруженном сервере возможна задержка.',
    documents: (n: string, count: number) =>
      `${n} ${((c) => (c === 'one' ? 'документ' : c === 'many' ? 'документов' : 'документа'))(pluralOf(count, 'ru'))}`,
    countFailed: 'Не удалось подсчитать',
    show: 'Показать',
    showHint: (group: string) =>
      `Помещает в запрос на вкладке «Документы» фильтр, выбирающий документы «${group}»`,
    showFailed: 'Не удалось открыть «Документы»: ',
    arrays: 'Документ, в поле которого несколько дат, учитывается по самой ранней: по ней TTL его и удаляет.',
  },
} satisfies Record<Language, Text>

type Counts = Record<Bucket, number | { error: unknown }>
interface Counted {
  ttl: TtlIndex
  counts: Counts
}
type State =
  | { kind: 'idle' }
  | { kind: 'running'; step?: [number, number] }
  | { kind: 'failed'; error: unknown }
  | { kind: 'done'; counted: Counted[]; at: number }

const brief = (v: unknown) => shellText(v).replace(/\s*\n\s*/g, ' ')

export function mount(root: HTMLElement, client: PluginClient, now: () => number = () => Date.now()): void {
  let text: Text = TEXT.en
  let locale = 'en'
  let ctx: PluginContext | null = null
  let state: State = { kind: 'idle' }
  let running = 0
  let showError: unknown = null

  const countButton = button({ label: text.count, icon: 'refresh', id: 'count' })
  const header = pageHeader({ icon: 'calendar', title: text.title, description: '', actions: [countButton] })
  const status = statusLine('status')
  const notes = h('div', { id: 'notes', class: 'tt-notes' })
  const results = h('div', { id: 'ttl', class: 'tt-indexes' })
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, h('div', { class: 'mm-summary' }, status), notes, results),
    ),
  )

  const number = (n: number) => formatNumber(n, shown(TEXT, locale))

  function applyText(): void {
    header.setText(text.title, text.description(ctx?.place?.coll ?? ''))
    setLabel(countButton, text.count)
  }

  function show(ttl: TtlIndex, bucket: Bucket, at: number): void {
    void client.ask('ui.useQuery', { filter: bucketFilter(ttl, bucket, at) }).then(
      () => {
        if (showError === null) return
        showError = null
        render()
      },
      (e: unknown) => {
        showError = e
        render()
      },
    )
  }

  function section({ ttl, counts }: Counted, at: number): HTMLElement {
    const known = BUCKETS.map((b) => counts[b]).filter((c): c is number => typeof c === 'number')
    const failures = BUCKETS.flatMap((b): Array<[Bucket, unknown]> => {
      const c = counts[b]
      return typeof c === 'number' ? [] : [[b, c.error]]
    })
    const total = known.reduce((a, b) => a + b, 0)
    const rows = BUCKETS.map((bucket) => {
      const c = counts[bucket]
      const fill = h('span', { class: 'tt-meter-fill' })
      fill.style.width = `${typeof c === 'number' && total ? Math.min(100, (c / total) * 100) : 0}%`
      const showButton =
        typeof c === 'number' && c > 0
          ? button({
              label: text.show,
              size: 'sm',
              icon: 'filter',
              title: text.showHint(text.buckets[bucket]),
              onClick: () => show(ttl, bucket, at),
            })
          : null
      showButton?.setAttribute('data-show', '')
      return h(
        'div',
        { class: `tt-row tt-${bucket}`, data: { bucket } },
        h('span', { class: 'tt-name', text: text.buckets[bucket] }),
        h('div', { class: 'tt-meter', attrs: { 'aria-hidden': 'true' } }, fill),
        typeof c === 'number'
          ? h('span', { class: 'tt-count', text: text.documents(number(c), c) })
          : h('span', { class: 'tt-count tt-error', text: text.countFailed }),
        showButton ?? h('span'),
      )
    })
    return h(
      'section',
      { class: 'mm-card tt-index', data: { index: ttl.name } },
      h(
        'div',
        { class: 'tt-head' },
        h('h2', { class: 'tt-title' }, h('code', { class: 'mm-mono', text: ttl.field })),
        badge(ttl.name, 'neutral'),
      ),
      h('p', {
        class: 'tt-sub',
        text: text.removes(ttl.field, duration(ttl.after, locale), ttl.after === 0),
      }),
      ttl.partial ? h('p', { class: 'tt-sub', text: text.partial(brief(ttl.partial)) }) : null,
      h('div', { class: 'tt-rows' }, ...rows),
      // Why a group could not be counted, on the page for every reader (review 2026-10-28).
      failures.length
        ? h(
            'p',
            { class: 'tt-sub tt-errors' },
            failures
              .map(([bucket, error]) => `${text.buckets[bucket]}: ${askMessage(error, locale)}`)
              .join('; '),
          )
        : null,
    )
  }

  function render(): void {
    notes.replaceChildren()
    status.textContent = ''
    if (!ctx) return
    if (!ctx.place) return void results.replaceChildren(emptyState({ icon: 'calendar', title: text.noPlace }))
    if (state.kind === 'idle') return void results.replaceChildren()
    if (state.kind === 'running') {
      status.textContent = state.step ? text.counting(...state.step) : text.reading
      return void results.replaceChildren(skeleton(4))
    }
    if (state.kind === 'failed')
      return void results.replaceChildren(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: text.failed,
          hint: askMessage(state.error, locale),
          action: button({ label: text.tryAgain, icon: 'refresh', onClick: () => void count() }),
        }),
      )
    if (!state.counted.length)
      return void results.replaceChildren(
        ctx.place.view
          ? emptyState({ icon: 'layers', title: text.view })
          : emptyState({ icon: 'calendar', title: text.none, hint: text.noneHint }),
      )
    if (showError !== null)
      notes.append(callout('danger', `${text.showFailed}${askMessage(showError, locale)}`))
    notes.append(callout('info', text.buckets.waiting, `${text.waitingHint} ${text.arrays}`))
    const at = state.at
    results.replaceChildren(...state.counted.map((c) => section(c, at)))
  }

  async function count(): Promise<void> {
    if (!ctx?.place) return
    const run = ++running
    showError = null
    setBusy(countButton, true)
    state = { kind: 'running' }
    render()
    try {
      const ttls = ttlIndexes(await client.ask<ListedIndex[]>('indexes.list'))
      const at = now()
      const counted: Counted[] = []
      const steps = ttls.length * BUCKETS.length
      let step = 0
      for (const ttl of ttls) {
        const counts = {} as Counts
        for (const bucket of BUCKETS) {
          if (run !== running) return
          state = { kind: 'running', step: [++step, steps] }
          render()
          try {
            // The app runs one pipeline of a frame at a time: each count waits for the one before.
            const answer = await client.ask<{ documents: unknown[] }>('documents.aggregate', {
              pipeline: countPipeline(bucketFilter(ttl, bucket, at)),
              limit: 1,
            })
            counts[bucket] = countOf(answer.documents)
          } catch (error) {
            counts[bucket] = { error }
          }
        }
        counted.push({ ttl, counts })
      }
      if (run !== running) return
      state = { kind: 'done', counted, at }
    } catch (e) {
      if (run !== running) return
      state = { kind: 'failed', error: e }
    }
    setBusy(countButton, false)
    render()
  }

  countButton.addEventListener('click', () => void count())

  client.onContext((next, theme, accent) => {
    locale = next
    text = pick(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(theme, accent)
    applyText()
    render()
  })
  client.onReady(async () => {
    ctx = await client.ask<PluginContext>('context.get')
    locale = ctx.locale
    text = pick(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
    applyLook(ctx.theme, ctx.accent)
    applyText()
    if (!ctx.place) {
      countButton.disabled = true
      render()
      return
    }
    void count()
  })
  applyText()
}
