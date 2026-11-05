// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import '../../kit/src/ui.css'
import './style.css'
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
  type Language,
  pageHeader,
  pick,
  pluralOf,
  setBusy,
  shown,
  skeleton,
  statusLine,
  table,
} from '../../kit/src/ui'
import {
  bytesText,
  percentText,
  rowsOf,
  totalsOf,
  worthCompacting,
  type CompactEstimate,
  type Row,
  type StorageReport,
} from './report'

/**
 * Plugins wave 4 (spec §2): the storage of the tab's database — every collection's sizes, the
 * space WiredTiger holds free inside its files, how much of them that is — and, for one collection,
 * what compact would give back and compact itself, which the app runs only after the user typed the
 * collection's name in its own dialog. The plugin never runs anything on the server itself.
 */
const TEXT = {
  en: {
    title: 'Storage',
    description: (db: string) =>
      `What the collections of ${db} take on disk, the free space inside their files, and what compact could give back.`,
    reading: 'Reading the storage…',
    noPlace: 'Open a collection to see its database’s storage.',
    failed: 'The storage could not be read: ',
    refresh: 'Refresh',
    totals: 'Totals',
    storage: 'Storage',
    data: 'Data',
    indexes: 'Indexes',
    reclaimable: 'Reclaimable',
    ofFiles: (p: string) => `${p} of the files`,
    notCounted: (n: number, plural: Intl.LDMLPluralRule) =>
      plural === 'one'
        ? '1 collection is not counted: its sizes are not known.'
        : `${n} collections are not counted: their sizes are not known.`,
    more: 'Only the first 500 collections by name are read.',
    columns: {
      name: 'Collection',
      documents: 'Documents',
      data: 'Data',
      storage: 'Storage',
      indexes: 'Indexes',
      reclaimable: 'Reclaimable',
      share: 'Free',
    },
    current: 'This collection',
    timeseries: 'Time series',
    hidden: 'Hidden',
    unread: 'Could not be read',
    worth: 'Worth compacting',
    worthHint: 'At least 20% of its files and 10 MB are free: compact would give them back.',
    open: (name: string) => `Show ${name}`,
    empty: 'This database has no collection to report on.',
    detailFor: (name: string) => `${name}`,
    index: 'Index',
    size: 'Size',
    free: 'Free',
    hiddenNote:
      'Its sizes are hidden from you: personal data rules reach this collection. Compact is not offered here.',
    unreadNote: 'MongoDB did not tell this collection’s sizes (a refused or failed read).',
    compactTitle: 'Compact',
    compactText:
      'Compact rewrites the collection’s and its indexes’ files to give their free space back to the disk. It can take long and slows the server while it runs; WiredTiger reuses free space by itself, so it pays only for a large share of it. The app asks you first, and you type the collection’s name.',
    estimate: 'Estimate',
    estimated: (b: string) => `Compact would give back about ${b}.`,
    noEstimate: {
      version: 'Only MongoDB 8.0 or later estimates what compact gives back.',
      mongos: 'Through mongos there is no estimate: compact runs on each shard.',
      timeseries: 'A time series collection is not compacted here.',
    },
    timeseriesNote:
      'A time series collection keeps its measurements in buckets of its own: it is not compacted here.',
    compacting: (name: string) =>
      `Compacting ${name}: answer the app’s question; compact may then take long.`,
    compact: 'Compact…',
    compacted: (name: string, b: string) => `${name} compacted: ${b} given back.`,
  },
  tr: {
    title: 'Depolama',
    description: (db: string) =>
      `${db} veritabanının koleksiyonlarının diskte kapladığı yer, dosyalarındaki boş alan ve sıkıştırmanın geri verebileceği alan.`,
    reading: 'Depolama okunuyor…',
    noPlace: 'Veritabanının depolamasını görmek için bir koleksiyon aç.',
    failed: 'Depolama okunamadı: ',
    refresh: 'Yenile',
    totals: 'Toplamlar',
    storage: 'Depolama',
    data: 'Veri',
    indexes: 'İndeksler',
    reclaimable: 'Geri kazanılabilir',
    ofFiles: (p: string) => `dosyaların ${p} kadarı`,
    notCounted: (n: number, _plural: Intl.LDMLPluralRule) =>
      `${n} koleksiyon sayılmadı: boyutları bilinmiyor.`,
    more: 'Yalnızca ada göre ilk 500 koleksiyon okunur.',
    columns: {
      name: 'Koleksiyon',
      documents: 'Belgeler',
      data: 'Veri',
      storage: 'Depolama',
      indexes: 'İndeksler',
      reclaimable: 'Geri kazanılabilir',
      share: 'Boş',
    },
    current: 'Bu koleksiyon',
    timeseries: 'Zaman serisi',
    hidden: 'Gizli',
    unread: 'Okunamadı',
    worth: 'Sıkıştırmaya değer',
    worthHint: 'Dosyalarının en az %20’si ve 10 MB boş: sıkıştırma bunları geri verir.',
    open: (name: string) => `${name} ayrıntılarını göster`,
    empty: 'Bu veritabanında raporlanacak koleksiyon yok.',
    detailFor: (name: string) => `${name}`,
    index: 'İndeks',
    size: 'Boyut',
    free: 'Boş',
    hiddenNote:
      'Boyutları senden gizleniyor: kişisel veri kuralları bu koleksiyona uzanıyor. Burada sıkıştırma sunulmaz.',
    unreadNote: 'MongoDB bu koleksiyonun boyutlarını söylemedi (reddedilen ya da başarısız bir okuma).',
    compactTitle: 'Sıkıştır',
    compactText:
      'Sıkıştırma, koleksiyonun ve indekslerinin dosyalarını yeniden yazarak boş alanlarını diske geri verir. Uzun sürebilir ve çalışırken sunucuyu yavaşlatır; WiredTiger boş alanı kendisi yeniden kullandığından ancak büyük bir pay boşsa değer. Uygulama önce sana sorar ve koleksiyonun adını yazarsın.',
    estimate: 'Tahmin et',
    estimated: (b: string) => `Sıkıştırma yaklaşık ${b} geri verir.`,
    noEstimate: {
      version: 'Sıkıştırmanın ne geri vereceğini yalnızca MongoDB 8.0 ve sonrası tahmin eder.',
      mongos: 'mongos üzerinden tahmin yok: sıkıştırma her parçada çalışır.',
      timeseries: 'Bir zaman serisi koleksiyonu burada sıkıştırılmaz.',
    },
    timeseriesNote: 'Bir zaman serisi koleksiyonu ölçümlerini kendi kovalarında tutar: burada sıkıştırılmaz.',
    compacting: (name: string) =>
      `${name} sıkıştırılıyor: uygulamanın sorusunu yanıtla; sıkıştırma ardından uzun sürebilir.`,
    compact: 'Sıkıştır…',
    compacted: (name: string, b: string) => `${name} sıkıştırıldı: ${b} geri kazanıldı.`,
  },
  zh: {
    title: '存储',
    description: (db: string) => `${db} 中各集合占用的磁盘空间、其文件内部的空闲空间，以及压缩可释放的空间。`,
    reading: '正在读取存储信息…',
    noPlace: '打开一个集合，即可查看其所在数据库的存储情况。',
    failed: '无法读取存储信息：',
    refresh: '刷新',
    totals: '合计',
    storage: '存储',
    data: '数据',
    indexes: '索引',
    reclaimable: '可回收',
    ofFiles: (p: string) => `占文件的 ${p}`,
    notCounted: (n: number, _plural: Intl.LDMLPluralRule) => `有 ${n} 个集合未计入：其大小未知。`,
    more: '仅读取按名称排序的前 500 个集合。',
    columns: {
      name: '集合',
      documents: '文档',
      data: '数据',
      storage: '存储',
      indexes: '索引',
      reclaimable: '可回收',
      share: '空闲',
    },
    current: '当前集合',
    timeseries: '时间序列',
    hidden: '已隐藏',
    unread: '无法读取',
    worth: '值得压缩',
    worthHint: '其文件至少 20% 且至少 10 MB 为空闲：压缩可将其释放。',
    open: (name: string) => `显示 ${name}`,
    empty: '此数据库中没有可报告的集合。',
    detailFor: (name: string) => `${name}`,
    index: '索引',
    size: '大小',
    free: '空闲',
    hiddenNote: '其大小已对您隐藏：个人数据规则涉及此集合。此处不提供压缩。',
    unreadNote: 'MongoDB 未返回此集合的大小（读取被拒绝或失败）。',
    compactTitle: '压缩',
    compactText:
      '压缩会重写集合及其索引的文件，将其中的空闲空间归还给磁盘。这可能耗时较长，且运行期间会拖慢服务器；WiredTiger 会自行复用空闲空间，因此只有空闲占比较大时才值得压缩。应用会先进行确认，并要求输入集合名称。',
    estimate: '估算',
    estimated: (b: string) => `压缩预计可释放约 ${b}。`,
    noEstimate: {
      version: '仅 MongoDB 8.0 及更高版本可估算压缩能释放的空间。',
      mongos: '通过 mongos 无法估算：压缩需在每个分片上运行。',
      timeseries: '此处不压缩时间序列集合。',
    },
    timeseriesNote: '时间序列集合将测量数据保存在其专属的桶中：此处不对其压缩。',
    compacting: (name: string) => `正在压缩 ${name}：请回答应用的提问；压缩随后可能耗时较长。`,
    compact: '压缩…',
    compacted: (name: string, b: string) => `${name} 已压缩：释放了 ${b}。`,
  },
  ja: {
    title: 'ストレージ',
    description: (db: string) =>
      `${db} のコレクションがディスク上で使用している容量、ファイル内の空き領域、コンパクトで解放できる容量です。`,
    reading: 'ストレージを読み込み中…',
    noPlace: 'コレクションを開くと、そのデータベースのストレージが表示されます。',
    failed: 'ストレージを読み込めませんでした: ',
    refresh: '更新',
    totals: '合計',
    storage: 'ストレージ',
    data: 'データ',
    indexes: 'インデックス',
    reclaimable: '解放可能',
    ofFiles: (p: string) => `ファイルの ${p}`,
    notCounted: (n: number, _plural: Intl.LDMLPluralRule) =>
      `${n} 件のコレクションは集計されていません。サイズが不明です。`,
    more: '名前順で最初の 500 件のコレクションのみ読み込みます。',
    columns: {
      name: 'コレクション',
      documents: 'ドキュメント',
      data: 'データ',
      storage: 'ストレージ',
      indexes: 'インデックス',
      reclaimable: '解放可能',
      share: '空き',
    },
    current: 'このコレクション',
    timeseries: '時系列',
    hidden: '非表示',
    unread: '読み込めませんでした',
    worth: 'コンパクト推奨',
    worthHint: 'ファイルの 20% 以上かつ 10 MB 以上が空いています。コンパクトで解放できます。',
    open: (name: string) => `${name} を表示`,
    empty: 'このデータベースにはレポート対象のコレクションがありません。',
    detailFor: (name: string) => `${name}`,
    index: 'インデックス',
    size: 'サイズ',
    free: '空き',
    hiddenNote:
      'サイズは非表示です。個人データのルールがこのコレクションに及んでいます。ここではコンパクトは利用できません。',
    unreadNote:
      'MongoDB がこのコレクションのサイズを返しませんでした（読み取りが拒否されたか失敗しました）。',
    compactTitle: 'コンパクト',
    compactText:
      'コンパクトは、コレクションとそのインデックスのファイルを書き直し、空き領域をディスクに返します。時間がかかる場合があり、実行中はサーバーが遅くなります。WiredTiger は空き領域を自動的に再利用するため、空きの割合が大きい場合にのみ効果があります。アプリが先に確認し、コレクション名の入力を求めます。',
    estimate: '見積もり',
    estimated: (b: string) => `コンパクトで約 ${b} を解放できます。`,
    noEstimate: {
      version: 'コンパクトで解放できる容量を見積もれるのは MongoDB 8.0 以降のみです。',
      mongos: 'mongos 経由では見積もれません。コンパクトは各シャードで実行されます。',
      timeseries: '時系列コレクションはここではコンパクトされません。',
    },
    timeseriesNote:
      '時系列コレクションは測定値を専用のバケットに保持するため、ここではコンパクトされません。',
    compacting: (name: string) =>
      `${name} をコンパクト中です。アプリの確認に回答してください。その後、コンパクトに時間がかかる場合があります。`,
    compact: 'コンパクト…',
    compacted: (name: string, b: string) => `${name} をコンパクトしました。${b} を解放しました。`,
  },
  es: {
    title: 'Almacenamiento',
    description: (db: string) =>
      `Lo que ocupan en disco las colecciones de ${db}, el espacio libre dentro de sus archivos y lo que podría devolver la compactación.`,
    reading: 'Leyendo el almacenamiento…',
    noPlace: 'Abre una colección para ver el almacenamiento de su base de datos.',
    failed: 'No se pudo leer el almacenamiento: ',
    refresh: 'Actualizar',
    totals: 'Totales',
    storage: 'Almacenamiento',
    data: 'Datos',
    indexes: 'Índices',
    reclaimable: 'Recuperable',
    ofFiles: (p: string) => `${p} de los archivos`,
    notCounted: (n: number, plural: Intl.LDMLPluralRule) =>
      plural === 'one'
        ? 'No se cuenta 1 colección: se desconocen sus tamaños.'
        : `No se cuentan ${n} colecciones: se desconocen sus tamaños.`,
    more: 'Solo se leen las primeras 500 colecciones por nombre.',
    columns: {
      name: 'Colección',
      documents: 'Documentos',
      data: 'Datos',
      storage: 'Almacenamiento',
      indexes: 'Índices',
      reclaimable: 'Recuperable',
      share: 'Libre',
    },
    current: 'Esta colección',
    timeseries: 'Serie temporal',
    hidden: 'Oculto',
    unread: 'No se pudo leer',
    worth: 'Conviene compactar',
    worthHint: 'Al menos el 20 % de sus archivos y 10 MB están libres: compactar los devolvería.',
    open: (name: string) => `Mostrar ${name}`,
    empty: 'Esta base de datos no tiene ninguna colección sobre la que informar.',
    detailFor: (name: string) => `${name}`,
    index: 'Índice',
    size: 'Tamaño',
    free: 'Libre',
    hiddenNote:
      'Sus tamaños están ocultos para ti: las reglas de datos personales alcanzan a esta colección. Aquí no se ofrece compactar.',
    unreadNote: 'MongoDB no indicó los tamaños de esta colección (una lectura rechazada o fallida).',
    compactTitle: 'Compactar',
    compactText:
      'Compactar reescribe los archivos de la colección y de sus índices para devolver su espacio libre al disco. Puede tardar mucho y ralentiza el servidor mientras se ejecuta; WiredTiger reutiliza el espacio libre por sí solo, así que solo compensa cuando es una parte grande. La aplicación te pregunta antes y tú escribes el nombre de la colección.',
    estimate: 'Estimar',
    estimated: (b: string) => `Compactar devolvería unos ${b}.`,
    noEstimate: {
      version: 'Solo MongoDB 8.0 o posterior estima lo que devuelve compactar.',
      mongos: 'A través de mongos no hay estimación: compactar se ejecuta en cada fragmento.',
      timeseries: 'Aquí no se compacta una colección de series temporales.',
    },
    timeseriesNote:
      'Una colección de series temporales guarda sus mediciones en buckets propios: aquí no se compacta.',
    compacting: (name: string) =>
      `Compactando ${name}: responde a la pregunta de la aplicación; después, compactar puede tardar mucho.`,
    compact: 'Compactar…',
    compacted: (name: string, b: string) => `${name} compactada: se devolvieron ${b}.`,
  },
  pt: {
    title: 'Armazenamento',
    description: (db: string) =>
      `O que as coleções de ${db} ocupam em disco, o espaço livre dentro dos arquivos delas e o que a compactação poderia devolver.`,
    reading: 'Lendo o armazenamento…',
    noPlace: 'Abra uma coleção para ver o armazenamento do banco de dados dela.',
    failed: 'Não foi possível ler o armazenamento: ',
    refresh: 'Atualizar',
    totals: 'Totais',
    storage: 'Armazenamento',
    data: 'Dados',
    indexes: 'Índices',
    reclaimable: 'Recuperável',
    ofFiles: (p: string) => `${p} dos arquivos`,
    notCounted: (n: number, plural: Intl.LDMLPluralRule) =>
      plural === 'one'
        ? '1 coleção não foi contada: os tamanhos dela não são conhecidos.'
        : `${n} coleções não foram contadas: os tamanhos delas não são conhecidos.`,
    more: 'Somente as primeiras 500 coleções por nome são lidas.',
    columns: {
      name: 'Coleção',
      documents: 'Documentos',
      data: 'Dados',
      storage: 'Armazenamento',
      indexes: 'Índices',
      reclaimable: 'Recuperável',
      share: 'Livre',
    },
    current: 'Esta coleção',
    timeseries: 'Série temporal',
    hidden: 'Oculto',
    unread: 'Não foi possível ler',
    worth: 'Vale compactar',
    worthHint: 'Pelo menos 20% dos arquivos dela e 10 MB estão livres: a compactação os devolveria.',
    open: (name: string) => `Mostrar ${name}`,
    empty: 'Este banco de dados não tem nenhuma coleção para relatar.',
    detailFor: (name: string) => `${name}`,
    index: 'Índice',
    size: 'Tamanho',
    free: 'Livre',
    hiddenNote:
      'Os tamanhos dela estão ocultos para você: as regras de dados pessoais alcançam esta coleção. A compactação não é oferecida aqui.',
    unreadNote: 'O MongoDB não informou os tamanhos desta coleção (uma leitura recusada ou que falhou).',
    compactTitle: 'Compactar',
    compactText:
      'A compactação reescreve os arquivos da coleção e dos índices dela para devolver o espaço livre ao disco. Pode demorar e deixa o servidor mais lento enquanto é executada; o WiredTiger reutiliza o espaço livre por conta própria, então só vale a pena quando ele é uma parte grande. O app pergunta antes e você digita o nome da coleção.',
    estimate: 'Estimar',
    estimated: (b: string) => `A compactação devolveria cerca de ${b}.`,
    noEstimate: {
      version: 'Somente o MongoDB 8.0 ou posterior estima o que a compactação devolve.',
      mongos: 'Pelo mongos não há estimativa: a compactação é executada em cada shard.',
      timeseries: 'Uma coleção de série temporal não é compactada aqui.',
    },
    timeseriesNote:
      'Uma coleção de série temporal guarda as medições em buckets próprios: ela não é compactada aqui.',
    compacting: (name: string) =>
      `Compactando ${name}: responda à pergunta do app; depois a compactação pode demorar.`,
    compact: 'Compactar…',
    compacted: (name: string, b: string) => `${name} compactada: ${b} devolvidos.`,
  },
  ko: {
    title: '스토리지',
    description: (db: string) =>
      `${db}의 컬렉션이 디스크에서 차지하는 공간, 파일 안의 여유 공간, 압축으로 반환할 수 있는 공간입니다.`,
    reading: '스토리지를 읽는 중…',
    noPlace: '컬렉션을 열면 해당 데이터베이스의 스토리지를 볼 수 있습니다.',
    failed: '스토리지를 읽을 수 없습니다: ',
    refresh: '새로고침',
    totals: '합계',
    storage: '스토리지',
    data: '데이터',
    indexes: '인덱스',
    reclaimable: '회수 가능',
    ofFiles: (p: string) => `파일의 ${p}`,
    notCounted: (n: number, _plural: Intl.LDMLPluralRule) =>
      `컬렉션 ${n}개는 집계되지 않았습니다. 크기를 알 수 없습니다.`,
    more: '이름순 처음 500개 컬렉션만 읽습니다.',
    columns: {
      name: '컬렉션',
      documents: '도큐먼트',
      data: '데이터',
      storage: '스토리지',
      indexes: '인덱스',
      reclaimable: '회수 가능',
      share: '여유',
    },
    current: '현재 컬렉션',
    timeseries: '시계열',
    hidden: '숨김',
    unread: '읽을 수 없음',
    worth: '압축 권장',
    worthHint: '파일의 20% 이상과 10 MB 이상이 비어 있습니다. 압축하면 반환됩니다.',
    open: (name: string) => `${name} 표시`,
    empty: '이 데이터베이스에는 보고할 컬렉션이 없습니다.',
    detailFor: (name: string) => `${name}`,
    index: '인덱스',
    size: '크기',
    free: '여유',
    hiddenNote:
      '크기가 숨겨져 있습니다. 개인 데이터 규칙이 이 컬렉션에 적용됩니다. 여기서는 압축을 제공하지 않습니다.',
    unreadNote: 'MongoDB가 이 컬렉션의 크기를 알려주지 않았습니다(읽기가 거부되었거나 실패함).',
    compactTitle: '압축',
    compactText:
      '압축은 컬렉션과 인덱스의 파일을 다시 작성하여 여유 공간을 디스크에 반환합니다. 시간이 오래 걸릴 수 있고 실행하는 동안 서버가 느려집니다. WiredTiger는 여유 공간을 스스로 재사용하므로 여유 비율이 클 때만 가치가 있습니다. 앱이 먼저 확인을 요청하며, 컬렉션 이름을 입력해야 합니다.',
    estimate: '예상',
    estimated: (b: string) => `압축하면 약 ${b}을(를) 반환할 수 있습니다.`,
    noEstimate: {
      version: '압축으로 반환할 수 있는 공간은 MongoDB 8.0 이상에서만 예상할 수 있습니다.',
      mongos: 'mongos를 통해서는 예상할 수 없습니다. 압축은 각 샤드에서 실행됩니다.',
      timeseries: '시계열 컬렉션은 여기서 압축하지 않습니다.',
    },
    timeseriesNote: '시계열 컬렉션은 측정값을 자체 버킷에 보관하므로 여기서 압축하지 않습니다.',
    compacting: (name: string) =>
      `${name} 압축 중: 앱의 질문에 답하세요. 이후 압축에 시간이 오래 걸릴 수 있습니다.`,
    compact: '압축…',
    compacted: (name: string, b: string) => `${name}을(를) 압축했습니다: ${b} 반환.`,
  },
  de: {
    title: 'Speicher',
    description: (db: string) =>
      `Was die Collections von ${db} auf dem Datenträger belegen, der freie Platz in ihren Dateien und was das Verdichten zurückgeben könnte.`,
    reading: 'Speicher wird gelesen…',
    noPlace: 'Öffnen Sie eine Collection, um den Speicher ihrer Datenbank zu sehen.',
    failed: 'Der Speicher konnte nicht gelesen werden: ',
    refresh: 'Aktualisieren',
    totals: 'Summen',
    storage: 'Speicher',
    data: 'Daten',
    indexes: 'Indizes',
    reclaimable: 'Rückgewinnbar',
    ofFiles: (p: string) => `${p} der Dateien`,
    notCounted: (n: number, plural: Intl.LDMLPluralRule) =>
      plural === 'one'
        ? '1 Collection wird nicht mitgezählt: ihre Größen sind nicht bekannt.'
        : `${n} Collections werden nicht mitgezählt: ihre Größen sind nicht bekannt.`,
    more: 'Es werden nur die ersten 500 Collections nach Name gelesen.',
    columns: {
      name: 'Collection',
      documents: 'Dokumente',
      data: 'Daten',
      storage: 'Speicher',
      indexes: 'Indizes',
      reclaimable: 'Rückgewinnbar',
      share: 'Frei',
    },
    current: 'Diese Collection',
    timeseries: 'Time Series',
    hidden: 'Verborgen',
    unread: 'Nicht lesbar',
    worth: 'Verdichten lohnt sich',
    worthHint: 'Mindestens 20 % der Dateien und 10 MB sind frei: Verdichten würde sie zurückgeben.',
    open: (name: string) => `${name} anzeigen`,
    empty: 'Diese Datenbank enthält keine Collection, über die berichtet werden kann.',
    detailFor: (name: string) => `${name}`,
    index: 'Index',
    size: 'Größe',
    free: 'Frei',
    hiddenNote:
      'Die Größen sind vor Ihnen verborgen: Regeln für personenbezogene Daten gelten für diese Collection. Verdichten wird hier nicht angeboten.',
    unreadNote:
      'MongoDB hat die Größen dieser Collection nicht mitgeteilt (ein abgelehnter oder fehlgeschlagener Lesevorgang).',
    compactTitle: 'Verdichten',
    compactText:
      'Verdichten schreibt die Dateien der Collection und ihrer Indizes neu, um ihren freien Platz an den Datenträger zurückzugeben. Es kann lange dauern und verlangsamt den Server, solange es läuft; WiredTiger verwendet freien Platz selbst wieder, daher lohnt es sich nur bei einem großen Anteil. Die App fragt zuerst nach, und Sie geben den Namen der Collection ein.',
    estimate: 'Schätzen',
    estimated: (b: string) => `Verdichten würde etwa ${b} zurückgeben.`,
    noEstimate: {
      version: 'Nur MongoDB 8.0 oder neuer schätzt, was Verdichten zurückgibt.',
      mongos: 'Über mongos gibt es keine Schätzung: Verdichten läuft auf jedem Shard.',
      timeseries: 'Eine Time-Series-Collection wird hier nicht verdichtet.',
    },
    timeseriesNote:
      'Eine Time-Series-Collection hält ihre Messwerte in eigenen Buckets: Sie wird hier nicht verdichtet.',
    compacting: (name: string) =>
      `${name} wird verdichtet: Beantworten Sie die Frage der App; das Verdichten kann danach lange dauern.`,
    compact: 'Verdichten…',
    compacted: (name: string, b: string) => `${name} verdichtet: ${b} zurückgegeben.`,
  },
  fr: {
    title: 'Stockage',
    description: (db: string) =>
      `Ce que les collections de ${db} occupent sur le disque, l’espace libre dans leurs fichiers et ce que le compactage pourrait restituer.`,
    reading: 'Lecture du stockage…',
    noPlace: 'Ouvrez une collection pour voir le stockage de sa base de données.',
    failed: 'Le stockage n’a pas pu être lu\u202f: ',
    refresh: 'Actualiser',
    totals: 'Totaux',
    storage: 'Stockage',
    data: 'Données',
    indexes: 'Index',
    reclaimable: 'Récupérable',
    ofFiles: (p: string) => `${p} des fichiers`,
    notCounted: (n: number, plural: Intl.LDMLPluralRule) =>
      plural === 'one'
        ? '1 collection n’est pas comptée\u202f: ses tailles sont inconnues.'
        : `${n} collections ne sont pas comptées\u202f: leurs tailles sont inconnues.`,
    more: 'Seules les 500 premières collections, par nom, sont lues.',
    columns: {
      name: 'Collection',
      documents: 'Documents',
      data: 'Données',
      storage: 'Stockage',
      indexes: 'Index',
      reclaimable: 'Récupérable',
      share: 'Libre',
    },
    current: 'Cette collection',
    timeseries: 'Série chronologique',
    hidden: 'Masqué',
    unread: 'Lecture impossible',
    worth: 'Compactage conseillé',
    worthHint:
      'Au moins 20\u202f% de ses fichiers et 10 MB sont libres\u202f: le compactage les restituerait.',
    open: (name: string) => `Afficher ${name}`,
    empty: 'Cette base de données ne contient aucune collection à présenter.',
    detailFor: (name: string) => `${name}`,
    index: 'Index',
    size: 'Taille',
    free: 'Libre',
    hiddenNote:
      'Ses tailles vous sont masquées\u202f: les règles sur les données personnelles s’appliquent à cette collection. Le compactage n’est pas proposé ici.',
    unreadNote: 'MongoDB n’a pas indiqué les tailles de cette collection (lecture refusée ou échouée).',
    compactTitle: 'Compactage',
    compactText:
      'Le compactage réécrit les fichiers de la collection et de ses index pour restituer leur espace libre au disque. Il peut être long et ralentit le serveur pendant son exécution\u202f; WiredTiger réutilise lui-même l’espace libre, donc il n’en vaut la peine que pour une grande part. L’application vous demande d’abord confirmation, et vous saisissez le nom de la collection.',
    estimate: 'Estimer',
    estimated: (b: string) => `Le compactage restituerait environ ${b}.`,
    noEstimate: {
      version: 'Seul MongoDB 8.0 ou version ultérieure estime ce que le compactage restitue.',
      mongos: 'Via mongos, il n’y a pas d’estimation\u202f: le compactage s’exécute sur chaque partition.',
      timeseries: 'Une collection de séries chronologiques n’est pas compactée ici.',
    },
    timeseriesNote:
      'Une collection de séries chronologiques garde ses mesures dans ses propres compartiments (buckets)\u202f: elle n’est pas compactée ici.',
    compacting: (name: string) =>
      `Compactage de ${name}\u202f: répondez à la question de l’application\u202f; le compactage peut ensuite être long.`,
    compact: 'Compacter…',
    compacted: (name: string, b: string) => `${name} compactée\u202f: espace restitué\u202f: ${b}.`,
  },
  ru: {
    title: 'Хранилище',
    description: (db: string) =>
      `Сколько места коллекции ${db} занимают на диске, свободное место внутри их файлов и сколько мог бы вернуть compact.`,
    reading: 'Чтение данных хранилища…',
    noPlace: 'Откройте коллекцию, чтобы увидеть хранилище ее базы данных.',
    failed: 'Не удалось прочитать данные хранилища: ',
    refresh: 'Обновить',
    totals: 'Итого',
    storage: 'Хранилище',
    data: 'Данные',
    indexes: 'Индексы',
    reclaimable: 'Можно вернуть',
    ofFiles: (p: string) => `${p} файлов`,
    notCounted: (n: number, plural: Intl.LDMLPluralRule) =>
      plural === 'one'
        ? `${n} коллекция не учтена: ее размеры неизвестны.`
        : plural === 'few'
          ? `${n} коллекции не учтены: их размеры неизвестны.`
          : `${n} коллекций не учтено: их размеры неизвестны.`,
    more: 'Читаются только первые 500 коллекций по имени.',
    columns: {
      name: 'Коллекция',
      documents: 'Документы',
      data: 'Данные',
      storage: 'Хранилище',
      indexes: 'Индексы',
      reclaimable: 'Можно вернуть',
      share: 'Свободно',
    },
    current: 'Эта коллекция',
    timeseries: 'Временной ряд',
    hidden: 'Скрыто',
    unread: 'Не удалось прочитать',
    worth: 'Стоит уплотнить',
    worthHint: 'Свободно не менее 20 % файлов и 10 MB: уплотнение вернет это место.',
    open: (name: string) => `Показать ${name}`,
    empty: 'В этой базе данных нет коллекций для отчета.',
    detailFor: (name: string) => `${name}`,
    index: 'Индекс',
    size: 'Размер',
    free: 'Свободно',
    hiddenNote:
      'Размеры скрыты от вас: правила персональных данных распространяются на эту коллекцию. Уплотнение здесь не предлагается.',
    unreadNote: 'MongoDB не сообщил размеры этой коллекции (чтение отклонено или завершилось ошибкой).',
    compactTitle: 'Уплотнение',
    compactText:
      'Уплотнение перезаписывает файлы коллекции и ее индексов, чтобы вернуть диску их свободное место. Оно может занять много времени и замедляет сервер, пока выполняется; WiredTiger сам повторно использует свободное место, поэтому уплотнение оправдано только при большой его доле. Приложение сначала спросит вас, и вы введете имя коллекции.',
    estimate: 'Оценить',
    estimated: (b: string) => `Уплотнение вернет примерно ${b}.`,
    noEstimate: {
      version: 'Оценить, сколько вернет уплотнение, может только MongoDB 8.0 и новее.',
      mongos: 'Через mongos оценки нет: уплотнение выполняется на каждом шарде.',
      timeseries: 'Коллекция временных рядов здесь не уплотняется.',
    },
    timeseriesNote:
      'Коллекция временных рядов хранит измерения в собственных бакетах: здесь она не уплотняется.',
    compacting: (name: string) =>
      `Уплотнение ${name}: ответьте на вопрос приложения; после этого уплотнение может занять много времени.`,
    compact: 'Уплотнить…',
    compacted: (name: string, b: string) => `${name} уплотнена: возвращено ${b}.`,
  },
}
type Text = (typeof TEXT)['en']
TEXT satisfies Record<Language, Text>

type Estimate = { coll: string; text: string; tone: 'info' | 'warning' | 'danger' } | null

export { TEXT }

export function mount(root: HTMLElement, client: PluginClient): void {
  let locale = 'en'
  let text: Text = TEXT.en
  let ctx: PluginContext | null = null
  let report: StorageReport | null = null
  let phase: 'reading' | 'ready' | 'failed' | 'noPlace' = 'reading'
  let failure: unknown = null
  let selected: string | null = null
  let estimate: Estimate = null
  let busy: 'estimate' | 'compact' | 'refresh' | null = null
  let reading = 0

  const refresh = button({ label: text.refresh, icon: 'refresh', id: 'refresh', onClick: () => void read() })
  const header = pageHeader({ icon: 'database', title: '', description: '', actions: [refresh] })
  const status = statusLine('status')
  const body = h('div', { class: 'mm-body sr-body' })
  root.append(h('div', { class: 'mm-page' }, header, status, body))

  /** The language the words are really in: what formats the numbers and marks the page. */
  const lang = () => shown(TEXT, locale)
  const size = (n: number | null) => (n === null ? '' : bytesText(n, lang()))
  const say = (message: string) => {
    status.textContent = message
  }

  async function read(): Promise<void> {
    if (!ctx?.place) return
    const mine = ++reading
    busy = 'refresh'
    render()
    try {
      const next = await client.ask<StorageReport>('storage.stats')
      if (mine !== reading) return
      report = next
      phase = 'ready'
    } catch (e) {
      if (mine !== reading) return
      failure = e
      phase = report ? phase : 'failed'
      if (report) say(text.failed + askMessage(e, locale))
    } finally {
      if (mine === reading) busy = null
    }
    render()
  }

  async function estimateOf(coll: string): Promise<void> {
    busy = 'estimate'
    render()
    try {
      const answer = await client.ask<CompactEstimate>('storage.compactEstimate', { coll })
      estimate = answer.available
        ? { coll, text: text.estimated(bytesText(answer.estimatedBytes, lang())), tone: 'info' }
        : { coll, text: text.noEstimate[answer.reason], tone: 'warning' }
    } catch (e) {
      estimate = { coll, text: askMessage(e, locale), tone: 'danger' }
    } finally {
      busy = null
    }
    render()
  }

  async function compact(coll: string): Promise<void> {
    busy = 'compact'
    say(text.compacting(coll))
    render()
    try {
      const done = await client.ask<{ bytesFreed: number }>('ui.compact', { coll })
      busy = null
      estimate = null
      say(text.compacted(coll, bytesText(done.bytesFreed, lang())))
      await read()
    } catch (e) {
      busy = null
      say(askMessage(e, locale))
      render()
    }
  }

  function rowView(t: ReturnType<typeof table>, row: Row): void {
    const c = row.collection
    const unknown = c.unread ? text.unread : c.sizesHidden ? text.hidden : null
    const muted = (s: string) => h('span', { class: 'sr-muted', text: s })
    const name = button({
      label: c.name,
      variant: 'ghost',
      size: 'sm',
      title: text.open(c.name),
      onClick: () => {
        selected = selected === c.name ? null : c.name
        render()
      },
    })
    name.setAttribute('aria-pressed', String(selected === c.name))
    name.dataset.focus = `row:${c.name}`
    const tr = t.row(
      h(
        'span',
        { class: 'sr-name' },
        name,
        c.type === 'timeseries' ? badge(text.timeseries, 'info') : null,
        c.name === ctx?.place?.coll ? badge(text.current, 'accent') : null,
        worthCompacting(row)
          ? h('span', { data: { worth: '' }, title: text.worthHint }, badge(text.worth, 'warning'))
          : null,
      ),
      c.count === null ? muted(unknown ?? '') : formatNumber(c.count, lang(), 0),
      unknown ? muted(unknown) : size(c.size),
      unknown ? muted(unknown) : size(c.storageSize),
      unknown ? muted(unknown) : size(c.indexSize),
      row.reclaimable === null ? muted(unknown ?? '') : size(row.reclaimable),
      row.fragmentation === null ? '' : shareBar(row.fragmentation),
    )
    tr.dataset.coll = c.name
    if (selected === c.name) tr.classList.add('sr-selected')
  }

  function shareBar(share: number): HTMLElement {
    const fill = h('span', { class: 'sr-bar-fill' })
    fill.style.width = `${Math.round(share * 100)}%`
    return h(
      'span',
      { class: 'sr-share' },
      h('span', { class: 'sr-bar', attrs: { 'aria-hidden': 'true' } }, fill),
      percentText(share, lang()),
    )
  }

  function totalsView(rows: Row[]): HTMLElement {
    const t = totalsOf(rows)
    const onDisk = t.storage + t.indexes
    const tile = (label: string, value: string, hint?: string) =>
      h(
        'div',
        { class: 'sr-tile' },
        h('span', { class: 'sr-tile-label', text: label }),
        h('span', { class: 'sr-tile-value', text: value }),
        hint ? h('span', { class: 'sr-tile-hint', text: hint }) : null,
      )
    return h(
      'section',
      { id: 'totals', class: 'sr-totals', attrs: { 'aria-label': text.totals } },
      h(
        'div',
        { class: 'sr-tiles' },
        tile(text.storage, bytesText(t.storage, lang())),
        tile(text.data, bytesText(t.data, lang())),
        tile(text.indexes, bytesText(t.indexes, lang())),
        tile(
          text.reclaimable,
          bytesText(t.reclaimable, lang()),
          onDisk ? text.ofFiles(percentText(t.reclaimable / onDisk, lang())) : undefined,
        ),
      ),
      t.unknown
        ? h('p', { class: 'sr-muted', text: text.notCounted(t.unknown, pluralOf(t.unknown, lang())) })
        : null,
    )
  }

  function detailView(row: Row): HTMLElement {
    const c = row.collection
    const indexes = table([
      { label: text.index },
      { label: text.size, numeric: true },
      { label: text.free, numeric: true },
    ])
    for (const i of c.indexes)
      indexes.row(h('span', { class: 'mm-mono', text: i.name }), size(i.size), size(i.freeBytes))
    const parts: HTMLElement[] = [h('h2', { class: 'sr-detail-title', text: text.detailFor(c.name) })]
    if (c.indexes.length) parts.push(indexes.el)
    if (c.sizesHidden) parts.push(callout('info', text.hiddenNote))
    else if (c.unread) parts.push(callout('warning', text.unreadNote))
    else if (c.type === 'timeseries') parts.push(callout('info', text.timeseriesNote))
    else {
      const estimateButton = button({
        label: text.estimate,
        icon: 'search',
        id: 'estimate',
        onClick: () => void estimateOf(c.name),
      })
      estimateButton.dataset.focus = 'estimate'
      const compactButton = button({
        label: text.compact,
        icon: 'refresh',
        variant: 'danger',
        id: 'compact',
        onClick: () => void compact(c.name),
      })
      compactButton.dataset.focus = 'compact'
      if (busy) {
        setBusy(estimateButton, busy === 'estimate')
        setBusy(compactButton, busy === 'compact')
        estimateButton.disabled = compactButton.disabled = true
      }
      const est = estimate?.coll === c.name ? estimate : null
      parts.push(
        h(
          'div',
          { class: 'sr-compact' },
          h('h3', { class: 'sr-compact-title', text: text.compactTitle }),
          h('p', { class: 'sr-muted', text: text.compactText }),
          h('div', { class: 'sr-actions' }, estimateButton, compactButton),
          h(
            'p',
            {
              id: 'estimate-result',
              class: `sr-estimate sr-${est?.tone ?? 'info'}`,
              attrs: { role: 'status' },
            },
            est?.text ?? '',
          ),
        ),
      )
    }
    return h('section', { id: 'detail', class: 'sr-detail', attrs: { 'aria-label': c.name } }, ...parts)
  }

  function render(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus
    text = pick<Text>(TEXT, locale)
    document.documentElement.lang = langTag(lang())
    header.setText(text.title, ctx?.place ? text.description(ctx.place.db) : '')
    refresh.querySelector('span')!.textContent = text.refresh
    refresh.hidden = !ctx?.place
    setBusy(refresh, busy === 'refresh')
    body.replaceChildren()
    if (phase === 'noPlace') {
      body.append(emptyState({ icon: 'database', title: text.noPlace }))
      return
    }
    if (phase === 'failed') {
      body.append(callout('danger', text.failed + askMessage(failure, locale)))
      return
    }
    if (!report) {
      body.append(h('p', { class: 'sr-muted', text: text.reading }), skeleton(6))
      return
    }
    const rows = rowsOf(report)
    if (!rows.length) {
      body.append(emptyState({ icon: 'database', title: text.empty }))
      return
    }
    const t = table([
      { label: text.columns.name },
      { label: text.columns.documents, numeric: true },
      { label: text.columns.data, numeric: true },
      { label: text.columns.storage, numeric: true },
      { label: text.columns.indexes, numeric: true },
      { label: text.columns.reclaimable, numeric: true },
      { label: text.columns.share },
    ])
    t.el.id = 'collections'
    for (const row of rows) rowView(t, row)
    const chosen = rows.find((r) => r.collection.name === selected)
    body.append(
      totalsView(rows),
      ...(report.more ? [callout('info', text.more)] : []),
      h('div', { class: 'sr-table' }, t.el),
      ...(chosen ? [detailView(chosen)] : []),
    )
    if (focused) body.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus()
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
    } catch (e) {
      failure = e
      phase = 'failed'
      return render()
    }
    if (!ctx.place) {
      phase = 'noPlace'
      return render()
    }
    selected = ctx.place.coll
    await read()
  })
  render()
}
