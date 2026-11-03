// Mongo Manager's landing page in ten languages. English is the source, and is also written in the
// HTML for visitors without JavaScript and for crawlers. Values under data-i18n-html are trusted,
// static strings of this file (they may hold <code>).
window.MM_I18N = {
  en: {
    'nav.ai': 'AI',
    'ai.title': 'An AI agent for your databases',
    'ai.lead':
      'Ask in your own words. The agent works with your connections by name, reads what it needs, and puts every change on a card you confirm.',
    'ai.p1':
      'Answers from your data: it writes and runs the query or the pipeline, and shows each step it took.',
    'ai.p2':
      'Changes you confirm: collections, documents, indexes, backups, schedules and users, each on its own card. Decline, and nothing is written.',
    'ai.p3':
      'Your provider: Anthropic, Google Gemini, any OpenAI-compatible server, or Ollama on your own network.',
    'ai.p4':
      'Your rules: personal data stays hidden from it, each connection has its own AI policy, and every request is kept in your history with its tokens.',
    'tour.ai.t': 'Ask the AI agent',
    'tour.ai.d':
      'It answers from your data — writing and running the query or pipeline it needs — and proposes each change on a card: confirm it, or decline and nothing is written.',
    'shots.ai-agent': 'The AI agent: an answer from the data, and an index waiting for confirmation',
    'meta.title': 'Mongo Manager — a secure MongoDB manager in your browser',
    'meta.description':
      'A self-hosted MongoDB manager that works fully offline: documents, aggregations, schema, performance, backups, team access and an AI assistant, in ten languages. Free for non-commercial use.',
    'a11y.skip': 'Skip to content',
    'a11y.nav': 'Primary',
    'a11y.lang': 'Language',
    'a11y.github': 'Mongo Manager on GitHub',
    'a11y.theme': 'Theme: {mode}',
    'theme.auto': 'automatic',
    'theme.light': 'light',
    'theme.dark': 'dark',
    'nav.features': 'Features',
    'nav.tour': 'Tour',
    'nav.screens': 'Screenshots',
    'nav.security': 'Security',
    'nav.install': 'Install',
    'nav.faq': 'FAQ',
    'hero.eyebrow': 'Self-hosted · Works offline · Free for non-commercial use',
    'hero.title': 'Your MongoDB, in your browser.',
    'hero.lead':
      'Browse and edit documents, build aggregations, read the schema, see why a query is slow and watch your servers — from one app you run yourself, with nothing sent anywhere else.',
    'hero.install': 'Install',
    'hero.github': 'View on GitHub',
    'hero.meta':
      'CC BY-NC-SA 4.0 license · Node.js 24+, a standalone binary or Docker · MongoDB 6.0 and later',
    'release.info': 'Latest: v{v} · {date}',
    'features.title': 'Everything you need to work with MongoDB',
    'features.lead': 'From a quick look at a collection to running a team’s databases.',
    'f.documents.t': 'Browse and edit',
    'f.documents.d':
      'Table, cards and JSON views; inline edits that write only what changed; bulk updates previewed before they run.',
    'f.query.t': 'Query with help',
    'f.query.d':
      'Field completion, a visual filter builder, collation and hints; a find copied as a shell command or exported to code.',
    'f.aggregation.t': 'Aggregation builder',
    'f.aggregation.d':
      'Stage cards with a live preview of each stage, a text mode, and export to eight languages.',
    'f.schema.t': 'Schema and indexes',
    'f.schema.d':
      'A sampled analysis of every field, index usage, and Atlas Search and Vector Search indexes.',
    'f.explain.t': 'Why is it slow?',
    'f.explain.d': 'The query plan as a tree with warnings, and the index that would help, prefilled.',
    'f.performance.t': 'Performance and alerts',
    'f.performance.d':
      'Live charts with a seven-day history, slow queries, index advice, and alerts by e-mail or webhook.',
    'f.shell.t': 'Advanced shell',
    'f.shell.d': 'mongosh’s runtime in a tab, sandboxed, with every command audited.',
    'f.transfer.t': 'Import, export and sync',
    'f.transfer.d': 'CSV, JSON, Excel and SQL dumps; copy, compare and live sync between servers.',
    'f.backup.t': 'Backups',
    'f.backup.d':
      'mongodump archives or encrypted files, scheduled, and sent to S3, Google Drive, WebDAV or a folder.',
    'f.ai.t': 'AI assistant',
    'f.ai.d':
      'Queries, pipelines and explanations from your words, with your own provider; every change asks first.',
    'f.team.t': 'Built for teams',
    'f.team.d':
      'Roles and per-connection access, two-factor sign-in, panel access by address, and an audit log.',
    'f.plugins.t': 'Plugins',
    'f.plugins.d':
      'Sandboxed tabs, actions and pages, each approved by an administrator after a security scan.',
    'tour.title': 'A quick tour',
    'tour.lead': 'Short clips of the app at work on a sample store.',
    'tour.query.t': 'Find and filter',
    'tour.query.d':
      'Type a filter with field completion, or click a value to add it; results page in a table, cards or JSON.',
    'tour.aggregation.t': 'Build pipelines stage by stage',
    'tour.aggregation.d':
      'Each stage shows its output on a sample as you type; run it, save it, or export it to code.',
    'tour.schema.t': 'Know the shape of your data',
    'tour.schema.d': 'A sampled analysis of every field: its types, how often it is there, and its values.',
    'tour.explain.t': 'See why a query is slow',
    'tour.explain.d':
      'The query plan as a tree, with the step that read the whole collection and the index that would help.',
    'tour.palette.t': 'Everything a keystroke away',
    'tour.palette.d': 'The command palette (Ctrl+K) finds any command, collection or setting.',
    'tour.performance.t': 'Watch the server live',
    'tour.performance.d':
      'Operations, connections, network and memory, live and over seven days, with alerts.',
    'tour.play': 'Play the clip',
    'tour.pause': 'Pause the clip',
    'shots.title': 'Screenshots',
    'shots.lead': 'Shown in this page’s theme; select one to enlarge it.',
    'shots.documents': 'Documents in a table, with a filter and one-click suggestions',
    'shots.aggregation': 'An aggregation pipeline, each stage previewed',
    'shots.schema': 'The schema of a sampled collection',
    'shots.explain': 'Why is it slow? The query plan',
    'shots.performance': 'Live server performance',
    'shots.palette': 'The command palette (Ctrl+K)',
    'shots.plugins': 'Plugins, each one approved by an administrator',
    'shots.security': 'Team mode: two-factor rules, sessions, panel access and sign-in bans',
    'security.title': 'Private and secure by design',
    'security.lead':
      'Mongo Manager runs on your machine or your server and talks only to what you configure.',
    'security.p1':
      'Works fully offline: no telemetry, CDN or external fonts, and no update check unless an administrator turns on the daily one.',
    'security.p2': 'Passwords and keys are encrypted at rest, never shown again and never written to logs.',
    'security.p3':
      'Personal data rules hide fields from those who may not see them — in documents, exports, backups and the AI assistant.',
    'security.p4': 'In team mode: two-factor sign-in, sign-in bans and an address allow list for the panel.',
    'security.p5': 'An append-only audit log of every change.',
    'security.p6': 'Plugins run in a sandbox, and only after an administrator approves them.',
    'security.p7':
      'Updates are signed: only a release signed with Mongo Manager’s key is installed, every file is checked again at each start, and a version that does not start is rolled back.',
    'install.title': 'Install',
    'install.lead':
      'Pick one. Every release ships SHA-256 checksums, so it also works on an air-gapped machine.',
    'install.copy': 'Copy',
    'install.copied': 'Copied',
    'install.npm.note': 'Needs Node.js 24 or later. To keep it: npm install --global @mongo-manager/app.',
    'install.docker.note': 'Your data stays in the mm-data volume.',
    'install.binary.tab': 'Binary',
    'install.binary.d':
      'Download the file for your system from the latest release and run it: Linux x64 and arm64, Windows x64, macOS arm64. It carries its own runtime and the web app.',
    'install.binary.link': 'Latest release',
    'install.then':
      'Then open <code>http://127.0.0.1:4321</code>. For a team, start it with <code>--auth</code>: the first start prints a one-time setup token.',
    'install.update': 'Later versions come from the About page: an administrator checks and presses Update.',
    'faq.title': 'Questions',
    'faq.q1': 'Is it free?',
    'faq.a1':
      'Yes, for non-commercial use. Mongo Manager is licensed under Creative Commons BY-NC-SA 4.0: you may use, share and adapt it, giving credit, not for commercial purposes, and sharing your changes under the same license.',
    'faq.q2': 'Does it send my data anywhere?',
    'faq.a2':
      'No. The app loads nothing from other sites, and the server reaches only your MongoDB deployments and SSH hosts, and the AI providers, backup destinations, plugin installs and update check you turn on.',
    'faq.q3': 'Which MongoDB versions does it support?',
    'faq.a3':
      'MongoDB 6.0 and later: standalone servers, replica sets, sharded clusters through mongos, and Atlas.',
    'faq.q4': 'Can my team use it?',
    'faq.a4':
      'Yes. Start it with --auth for team mode: accounts with admin, editor and viewer roles, per-connection access and two-factor sign-in.',
    'faq.q5': 'Do I need an AI provider?',
    'faq.a5':
      'No. The assistant is optional; turned on, it works with Anthropic, Google Gemini, any OpenAI-compatible server or Ollama on your own network.',
    'faq.q6': 'Which languages does it speak?',
    'faq.a6':
      'Ten: English, Turkish, Simplified Chinese, Japanese, Spanish, Brazilian Portuguese, Korean, German, French and Russian.',
    'faq.q7': 'How do I update it?',
    'faq.a7':
      'From the About page. An administrator presses Check now, or turns on the daily check, and installs a new version with Update: the npm package, the standalone binary, a service and Docker all update themselves, and a release that needs a newer Docker image says which docker pull to run. Version 1.1.0 is the first that does this: install it by hand once.',
    'footer.license': 'CC BY-NC-SA 4.0 license',
    'footer.source': 'Source code',
    'footer.trademark':
      'MongoDB is a trademark of MongoDB, Inc. Mongo Manager is not affiliated with MongoDB, Inc.',
    'lb.label': 'Screenshot',
    'lb.close': 'Close',
    'lb.prev': 'Previous',
    'lb.next': 'Next',
    'lb.open': 'Enlarge: {caption}',
  },
  tr: {
    'nav.ai': 'Yapay zekâ',
    'ai.title': 'Veritabanların için bir yapay zekâ ajanı',
    'ai.lead':
      'Kendi sözlerinle sor. Ajan bağlantılarınla adlarıyla çalışır, gerekeni okur ve her değişikliği onaylaman için bir karta koyar.',
    'ai.p1': 'Verinden yanıtlar: sorguyu ya da hattı kendisi yazıp çalıştırır ve attığı her adımı gösterir.',
    'ai.p2':
      'Onayladığın değişiklikler: koleksiyonlar, belgeler, indeksler, yedekler, zamanlamalar ve kullanıcılar, her biri kendi kartında. Reddedersen hiçbir şey yazılmaz.',
    'ai.p3':
      'Kendi sağlayıcın: Anthropic, Google Gemini, OpenAI uyumlu herhangi bir sunucu ya da kendi ağındaki Ollama.',
    'ai.p4':
      'Kendi kuralların: kişisel veriler ondan gizli kalır, her bağlantının kendi yapay zekâ politikası vardır ve her istek token sayısıyla birlikte geçmişinde durur.',
    'tour.ai.t': 'Yapay zekâ ajanına sor',
    'tour.ai.d':
      'Verinden yanıt verir — gereken sorguyu ya da hattı kendisi yazıp çalıştırır — ve her değişikliği bir kartta önerir: onayla ya da reddet; reddedersen hiçbir şey yazılmaz.',
    'shots.ai-agent': 'Yapay zekâ ajanı: veriden bir yanıt ve onay bekleyen bir indeks',
    'meta.title': 'Mongo Manager — tarayıcında güvenli bir MongoDB yöneticisi',
    'meta.description':
      'Tamamen çevrimdışı çalışan, kendi sunucunda barındırdığın bir MongoDB yöneticisi: belgeler, toplama hatları, şema, performans, yedekler, ekip erişimi ve bir yapay zekâ asistanı, on dilde. Ticari olmayan kullanım için ücretsiz.',
    'a11y.skip': 'İçeriğe geç',
    'a11y.nav': 'Ana menü',
    'a11y.lang': 'Dil',
    'a11y.github': 'GitHub’da Mongo Manager',
    'a11y.theme': 'Tema: {mode}',
    'theme.auto': 'otomatik',
    'theme.light': 'açık',
    'theme.dark': 'koyu',
    'nav.features': 'Özellikler',
    'nav.tour': 'Tur',
    'nav.screens': 'Ekran görüntüleri',
    'nav.security': 'Güvenlik',
    'nav.install': 'Kurulum',
    'nav.faq': 'SSS',
    'hero.eyebrow': 'Kendi sunucunda · Çevrimdışı çalışır · Ticari olmayan kullanım için ücretsiz',
    'hero.title': 'MongoDB’n, tarayıcında.',
    'hero.lead':
      'Belgeleri gez ve düzenle, toplama hatları kur, şemayı oku, bir sorgunun neden yavaş olduğunu gör ve sunucularını izle — kendi çalıştırdığın tek bir uygulamadan, başka hiçbir yere bir şey gönderilmeden.',
    'hero.install': 'Kur',
    'hero.github': 'GitHub’da gör',
    'hero.meta':
      'CC BY-NC-SA 4.0 lisansı · Node.js 24+, tek başına çalışan bir dosya ya da Docker · MongoDB 6.0 ve sonrası',
    'release.info': 'Son sürüm: v{v} · {date}',
    'features.title': 'MongoDB ile çalışmak için gereken her şey',
    'features.lead': 'Bir koleksiyona hızlıca göz atmaktan bir ekibin veritabanlarını yönetmeye kadar.',
    'f.documents.t': 'Gez ve düzenle',
    'f.documents.d':
      'Tablo, kart ve JSON görünümleri; yalnızca değişeni yazan satır içi düzenlemeler; çalışmadan önce önizlenen toplu güncellemeler.',
    'f.query.t': 'Yardımlı sorgu',
    'f.query.d':
      'Alan tamamlama, görsel filtre oluşturucu, collation ve hint; kabuk komutu olarak kopyalanan ya da koda aktarılan bir find.',
    'f.aggregation.t': 'Toplama hattı oluşturucu',
    'f.aggregation.d':
      'Her aşamanın canlı önizlemesiyle aşama kartları, bir metin modu ve sekiz dile aktarma.',
    'f.schema.t': 'Şema ve indeksler',
    'f.schema.d':
      'Her alanın örneklemle çözümlemesi, indeks kullanımı, Atlas Search ve Vector Search indeksleri.',
    'f.explain.t': 'Neden yavaş?',
    'f.explain.d': 'Uyarılarıyla bir ağaç olarak sorgu planı ve işe yarayacak indeks, hazır doldurulmuş.',
    'f.performance.t': 'Performans ve uyarılar',
    'f.performance.d':
      'Yedi günlük geçmişiyle canlı grafikler, yavaş sorgular, indeks önerileri, e-posta ya da webhook ile uyarılar.',
    'f.shell.t': 'Gelişmiş kabuk',
    'f.shell.d': 'Bir sekmede, korumalı alanda mongosh; her komut denetim kaydına yazılır.',
    'f.transfer.t': 'İçe aktar, dışa aktar, eşitle',
    'f.transfer.d':
      'CSV, JSON, Excel ve SQL dökümleri; sunucular arasında kopyalama, karşılaştırma ve canlı eşitleme.',
    'f.backup.t': 'Yedekler',
    'f.backup.d':
      'mongodump arşivleri ya da şifreli dosyalar; zamanlanır, S3’e, Google Drive’a, WebDAV’a ya da bir klasöre gönderilir.',
    'f.ai.t': 'Yapay zekâ asistanı',
    'f.ai.d':
      'Kendi sözlerinden sorgular, hatlar ve açıklamalar, kendi sağlayıcınla; her değişiklik önce sorar.',
    'f.team.t': 'Ekipler için',
    'f.team.d':
      'Roller ve bağlantı başına erişim, iki adımlı oturum açma, adrese göre panel erişimi ve bir denetim kaydı.',
    'f.plugins.t': 'Eklentiler',
    'f.plugins.d':
      'Korumalı alanda çalışan sekmeler, eylemler ve sayfalar; her biri bir güvenlik taramasından sonra bir yönetici tarafından onaylanır.',
    'tour.title': 'Kısa bir tur',
    'tour.lead': 'Örnek bir mağaza üzerinde çalışırken uygulamadan kısa kesitler.',
    'tour.query.t': 'Bul ve süz',
    'tour.query.d':
      'Alan tamamlamalı bir filtre yaz ya da bir değere tıklayıp ekle; sonuçlar tablo, kart ya da JSON olarak sayfalanır.',
    'tour.aggregation.t': 'Hattı aşama aşama kur',
    'tour.aggregation.d':
      'Her aşama, sen yazarken bir örnek üzerindeki çıktısını gösterir; çalıştır, kaydet ya da koda aktar.',
    'tour.schema.t': 'Verinin biçimini tanı',
    'tour.schema.d': 'Her alanın örneklemle çözümlemesi: türleri, ne sıklıkla bulunduğu ve değerleri.',
    'tour.explain.t': 'Bir sorgunun neden yavaş olduğunu gör',
    'tour.explain.d': 'Sorgu planı bir ağaç olarak; tüm koleksiyonu okuyan adım ve işe yarayacak indeks.',
    'tour.palette.t': 'Her şey bir tuş uzağında',
    'tour.palette.d': 'Komut paleti (Ctrl+K) her komutu, koleksiyonu ya da ayarı bulur.',
    'tour.performance.t': 'Sunucuyu canlı izle',
    'tour.performance.d':
      'İşlemler, bağlantılar, ağ ve bellek; canlı ve yedi günlük geçmişiyle, uyarılarla birlikte.',
    'tour.play': 'Kesiti oynat',
    'tour.pause': 'Kesiti duraklat',
    'shots.title': 'Ekran görüntüleri',
    'shots.lead': 'Bu sayfanın temasıyla gösterilir; büyütmek için birini seç.',
    'shots.documents': 'Tabloda belgeler, bir filtre ve tek tıkla öneriler',
    'shots.aggregation': 'Her aşaması önizlenen bir toplama hattı',
    'shots.schema': 'Örneklenmiş bir koleksiyonun şeması',
    'shots.explain': 'Neden yavaş? Sorgu planı',
    'shots.performance': 'Canlı sunucu performansı',
    'shots.palette': 'Komut paleti (Ctrl+K)',
    'shots.plugins': 'Her biri bir yöneticinin onayladığı eklentiler',
    'shots.security':
      'Ekip modu: iki adımlı doğrulama kuralları, oturumlar, panel erişimi ve oturum açma engelleri',
    'security.title': 'Baştan gizli ve güvenli',
    'security.lead':
      'Mongo Manager senin bilgisayarında ya da sunucunda çalışır ve yalnızca senin yapılandırdığın yerlerle konuşur.',
    'security.p1':
      'Tamamen çevrimdışı çalışır: telemetri, CDN ya da harici yazı tipi yoktur; bir yönetici günlük denetimi açmadıkça güncelleme de denetlenmez.',
    'security.p2':
      'Parolalar ve anahtarlar diskte şifreli durur, bir daha gösterilmez ve günlüklere asla yazılmaz.',
    'security.p3':
      'Kişisel veri kuralları, görmemesi gerekenlerden alanları gizler — belgelerde, dışa aktarmalarda, yedeklerde ve yapay zekâ asistanında.',
    'security.p4':
      'Ekip modunda: iki adımlı oturum açma, oturum açma engelleri ve panel için bir adres izin listesi.',
    'security.p5': 'Her değişikliğin yalnızca eklenebilen bir denetim kaydı.',
    'security.p6': 'Eklentiler korumalı alanda çalışır, hem de yalnızca bir yönetici onayladıktan sonra.',
    'security.p7':
      'Güncellemeler imzalıdır: yalnızca Mongo Manager’ın anahtarıyla imzalanmış bir sürüm kurulur, her açılışta tüm dosyalar yeniden denetlenir ve açılmayan bir sürüm geri alınır.',
    'install.title': 'Kurulum',
    'install.lead':
      'Birini seç. Her sürüm SHA-256 sağlama toplamlarıyla gelir; ağa bağlı olmayan bir makinede de çalışır.',
    'install.copy': 'Kopyala',
    'install.copied': 'Kopyalandı',
    'install.npm.note':
      'Node.js 24 ya da sonrası gerekir. Kalıcı kurmak için: npm install --global @mongo-manager/app.',
    'install.docker.note': 'Verilerin mm-data biriminde kalır.',
    'install.binary.tab': 'Tek dosya',
    'install.binary.d':
      'Sisteminin dosyasını son sürümden indir ve çalıştır: Linux x64 ve arm64, Windows x64, macOS arm64. Kendi çalışma ortamını ve web uygulamasını içinde taşır.',
    'install.binary.link': 'Son sürüm',
    'install.then':
      'Sonra <code>http://127.0.0.1:4321</code> adresini aç. Bir ekip için <code>--auth</code> ile başlat: ilk açılış tek kullanımlık bir kurulum anahtarı yazar.',
    'install.update':
      'Sonraki sürümler Mongo Manager hakkında sayfasından gelir: bir yönetici denetler ve Güncelle’ye basar.',
    'faq.title': 'Sorular',
    'faq.q1': 'Ücretsiz mi?',
    'faq.a1':
      'Evet, ticari olmayan kullanım için. Mongo Manager, Creative Commons BY-NC-SA 4.0 lisansıyla sunulur: kaynak göstererek kullanabilir, paylaşabilir ve uyarlayabilirsin; ticari amaçla kullanamazsın ve yaptığın değişiklikleri aynı lisansla paylaşırsın.',
    'faq.q2': 'Verilerimi bir yere gönderiyor mu?',
    'faq.a2':
      'Hayır. Uygulama başka sitelerden hiçbir şey yüklemez; sunucu yalnızca MongoDB dağıtımlarına ve SSH sunucularına, bir de açtığın yapay zekâ sağlayıcılarına, yedekleme hedeflerine, eklenti kurulumlarına ve güncelleme denetimine erişir.',
    'faq.q3': 'Hangi MongoDB sürümlerini destekliyor?',
    'faq.a3':
      'MongoDB 6.0 ve sonrası: tek sunucular, replica set’ler, mongos üzerinden parçalanmış kümeler ve Atlas.',
    'faq.q4': 'Ekibim kullanabilir mi?',
    'faq.a4':
      'Evet. Ekip modu için --auth ile başlat: yönetici, düzenleyici ve izleyici rolleriyle hesaplar, bağlantı başına erişim ve iki adımlı oturum açma.',
    'faq.q5': 'Bir yapay zekâ sağlayıcısı gerekiyor mu?',
    'faq.a5':
      'Hayır. Asistan isteğe bağlıdır; açınca Anthropic, Google Gemini, OpenAI uyumlu herhangi bir sunucu ya da kendi ağındaki Ollama ile çalışır.',
    'faq.q6': 'Hangi dilleri konuşuyor?',
    'faq.a6':
      'On dil: İngilizce, Türkçe, Basitleştirilmiş Çince, Japonca, İspanyolca, Brezilya Portekizcesi, Korece, Almanca, Fransızca ve Rusça.',
    'faq.q7': 'Nasıl güncellerim?',
    'faq.a7':
      'Mongo Manager hakkında sayfasından. Bir yönetici Şimdi denetle’ye basar ya da günlük denetimi açar ve yeni sürümü Güncelle ile kurar: npm paketi, tek dosyalık program, servis ve Docker kendini günceller; daha yeni bir Docker imajı gereken sürüm, çalıştırılacak docker pull komutunu söyler. Bunu yapan ilk sürüm 1.1.0: onu bir kez elle kur.',
    'footer.license': 'CC BY-NC-SA 4.0 lisansı',
    'footer.source': 'Kaynak kodu',
    'footer.trademark':
      'MongoDB, MongoDB, Inc.’in ticari markasıdır. Mongo Manager’ın MongoDB, Inc. ile bir bağı yoktur.',
    'lb.label': 'Ekran görüntüsü',
    'lb.close': 'Kapat',
    'lb.prev': 'Önceki',
    'lb.next': 'Sonraki',
    'lb.open': 'Büyüt: {caption}',
  },
  zh: {
    'nav.ai': 'AI',
    'ai.title': '为你的数据库配备的 AI 代理',
    'ai.lead': '用你自己的话提问。代理按名称使用你的连接，读取所需内容，并把每项更改放在卡片上由你确认。',
    'ai.p1': '根据数据作答：它自行编写并运行查询或管道，并展示执行的每一步。',
    'ai.p2':
      '由你确认的更改：集合、文档、索引、备份、计划任务和用户，每项都有自己的卡片。拒绝则不会写入任何内容。',
    'ai.p3': '你自己的服务商：Anthropic、Google Gemini、任何兼容 OpenAI 的服务器，或你自己网络中的 Ollama。',
    'ai.p4':
      '你自己的规则：个人数据对它保持隐藏，每个连接都有自己的 AI 策略，每次请求都会连同令牌数保存在你的历史中。',
    'tour.ai.t': '向 AI 代理提问',
    'tour.ai.d':
      '它根据你的数据作答——自行编写并运行所需的查询或管道——并以卡片形式提出每项更改：确认即可，拒绝则不会写入任何内容。',
    'shots.ai-agent': 'AI 代理：根据数据给出的回答，以及等待确认的索引',
    'meta.title': 'Mongo Manager — 在浏览器中安全地管理 MongoDB',
    'meta.description':
      '一款可完全离线运行的自托管 MongoDB 管理工具：文档、聚合、模式、性能、备份、团队访问和 AI 助手，支持十种语言。非商业用途免费。',
    'a11y.skip': '跳到内容',
    'a11y.nav': '主导航',
    'a11y.lang': '语言',
    'a11y.github': 'GitHub 上的 Mongo Manager',
    'a11y.theme': '主题：{mode}',
    'theme.auto': '自动',
    'theme.light': '浅色',
    'theme.dark': '深色',
    'nav.features': '功能',
    'nav.tour': '浏览',
    'nav.screens': '截图',
    'nav.security': '安全',
    'nav.install': '安装',
    'nav.faq': '常见问题',
    'hero.eyebrow': '自托管 · 离线可用 · 非商业用途免费',
    'hero.title': '你的 MongoDB，就在浏览器里。',
    'hero.lead':
      '浏览和编辑文档、构建聚合、查看模式、找出查询变慢的原因并监视服务器——全部在一个由你自己运行的应用中完成，不会向任何其他地方发送数据。',
    'hero.install': '安装',
    'hero.github': '在 GitHub 上查看',
    'hero.meta': 'CC BY-NC-SA 4.0 许可证 · Node.js 24+、独立可执行文件或 Docker · MongoDB 6.0 及更高版本',
    'release.info': '最新版本：v{v} · {date}',
    'features.title': '使用 MongoDB 所需的一切',
    'features.lead': '从快速查看一个集合，到管理整个团队的数据库。',
    'f.documents.t': '浏览与编辑',
    'f.documents.d': '表格、卡片和 JSON 视图；只写入更改部分的单元格内编辑；批量更新在执行前先预览。',
    'f.query.t': '有帮助的查询',
    'f.query.d': '字段补全、可视化筛选构建器、排序规则和索引提示；可将 find 复制为 shell 命令或导出为代码。',
    'f.aggregation.t': '聚合构建器',
    'f.aggregation.d': '带有每个阶段实时预览的阶段卡片、文本模式，以及导出为八种语言。',
    'f.schema.t': '模式与索引',
    'f.schema.d': '对每个字段的抽样分析、索引使用情况，以及 Atlas Search 和 Vector Search 索引。',
    'f.explain.t': '为什么慢？',
    'f.explain.d': '以带警告的树形显示查询计划，并预先填好有帮助的索引。',
    'f.performance.t': '性能与告警',
    'f.performance.d': '带七天历史的实时图表、慢查询、索引建议，以及通过电子邮件或 webhook 发送的告警。',
    'f.shell.t': '高级 Shell',
    'f.shell.d': '在标签页中运行沙箱化的 mongosh，每条命令都会被审计。',
    'f.transfer.t': '导入、导出与同步',
    'f.transfer.d': 'CSV、JSON、Excel 和 SQL 转储；在服务器之间复制、比较和实时同步。',
    'f.backup.t': '备份',
    'f.backup.d': 'mongodump 归档或加密文件，可定时执行，并发送到 S3、Google Drive、WebDAV 或文件夹。',
    'f.ai.t': 'AI 助手',
    'f.ai.d': '根据你的描述生成查询、管道和解释，使用你自己的服务商；每次更改都会先征求同意。',
    'f.team.t': '为团队而生',
    'f.team.d': '角色和按连接的访问权限、双重验证登录、按地址限制面板访问，以及审计日志。',
    'f.plugins.t': '插件',
    'f.plugins.d': '沙箱化的标签页、操作和页面，每个插件都需在安全扫描后由管理员批准。',
    'tour.title': '快速浏览',
    'tour.lead': '应用在示例商店数据上运行的短片。',
    'tour.query.t': '查找与筛选',
    'tour.query.d': '输入带字段补全的筛选条件，或点击某个值将其加入；结果以表格、卡片或 JSON 分页显示。',
    'tour.aggregation.t': '逐阶段构建管道',
    'tour.aggregation.d': '每个阶段在你输入时就会显示其在样本上的输出；可运行、保存或导出为代码。',
    'tour.schema.t': '了解数据的结构',
    'tour.schema.d': '对每个字段进行抽样分析：类型、出现频率及其取值。',
    'tour.explain.t': '查看查询为什么慢',
    'tour.explain.d': '以树形显示查询计划，标出读取整个集合的步骤以及有帮助的索引。',
    'tour.palette.t': '一键即达',
    'tour.palette.d': '命令面板（Ctrl+K）可查找任何命令、集合或设置。',
    'tour.performance.t': '实时监视服务器',
    'tour.performance.d': '操作、连接、网络和内存，实时显示并保留七天历史，附带告警。',
    'tour.play': '播放短片',
    'tour.pause': '暂停短片',
    'shots.title': '截图',
    'shots.lead': '按本页面的主题显示；选择一张即可放大。',
    'shots.documents': '表格中的文档，附带筛选和一键建议',
    'shots.aggregation': '聚合管道，每个阶段都有预览',
    'shots.schema': '抽样集合的模式',
    'shots.explain': '为什么慢？查询计划',
    'shots.performance': '实时服务器性能',
    'shots.palette': '命令面板（Ctrl+K）',
    'shots.plugins': '插件，每个都需管理员批准',
    'shots.security': '团队模式：双重验证规则、会话、面板访问和登录封禁',
    'security.title': '从设计上保护隐私与安全',
    'security.lead': 'Mongo Manager 运行在你的电脑或服务器上，只与你配置的对象通信。',
    'security.p1': '完全离线运行：没有遥测、CDN 或外部字体；除非管理员开启每日检查，也不检查更新。',
    'security.p2': '密码和密钥以加密形式存储，不会再次显示，也绝不会写入日志。',
    'security.p3': '个人数据规则会对无权查看的人隐藏字段——在文档、导出、备份和 AI 助手中均是如此。',
    'security.p4': '团队模式下：双重验证登录、登录封禁，以及面板的地址允许列表。',
    'security.p5': '记录每项更改的只追加审计日志。',
    'security.p6': '插件在沙箱中运行，且仅在管理员批准后才会启用。',
    'security.p7':
      '更新经过签名：只安装用 Mongo Manager 密钥签名的发布，每次启动都会再次检查每个文件，无法启动的版本会被回滚。',
    'install.title': '安装',
    'install.lead': '任选其一。每个版本都附带 SHA-256 校验和，因此在隔离网络的机器上也能使用。',
    'install.copy': '复制',
    'install.copied': '已复制',
    'install.npm.note': '需要 Node.js 24 或更高版本。长期安装：npm install --global @mongo-manager/app。',
    'install.docker.note': '你的数据保存在 mm-data 卷中。',
    'install.binary.tab': '可执行文件',
    'install.binary.d':
      '从最新版本下载适合你系统的文件并运行：Linux x64 和 arm64、Windows x64、macOS arm64。它自带运行时和网页应用。',
    'install.binary.link': '最新版本',
    'install.then':
      '然后打开 <code>http://127.0.0.1:4321</code>。团队使用时，用 <code>--auth</code> 启动：首次启动会打印一次性设置令牌。',
    'install.update': '之后的版本来自“关于 Mongo Manager”页面：管理员检查后点击“更新”。',
    'faq.title': '常见问题',
    'faq.q1': '它免费吗？',
    'faq.a1':
      '是的，非商业用途免费。Mongo Manager 采用知识共享 BY-NC-SA 4.0 许可：你可以在署名的前提下使用、分享和改编，但不得用于商业目的，且须以相同许可分享你的修改。',
    'faq.q2': '它会把我的数据发送到别处吗？',
    'faq.a2':
      '不会。应用不会从其他网站加载任何内容，服务器只会连接你的 MongoDB 部署和 SSH 主机，以及你启用的 AI 服务商、备份目标、插件安装来源和更新检查。',
    'faq.q3': '支持哪些 MongoDB 版本？',
    'faq.a3': 'MongoDB 6.0 及更高版本：独立服务器、副本集、通过 mongos 访问的分片集群以及 Atlas。',
    'faq.q4': '我的团队能用吗？',
    'faq.a4':
      '能。用 --auth 启动团队模式：带有管理员、编辑者和查看者角色的账户、按连接的访问权限和双重验证登录。',
    'faq.q5': '需要 AI 服务商吗？',
    'faq.a5':
      '不需要。助手是可选的；启用后，它可与 Anthropic、Google Gemini、任何兼容 OpenAI 的服务器或你自己网络中的 Ollama 配合使用。',
    'faq.q6': '它支持哪些语言？',
    'faq.a6': '十种：英语、土耳其语、简体中文、日语、西班牙语、巴西葡萄牙语、韩语、德语、法语和俄语。',
    'faq.q7': '如何更新？',
    'faq.a7':
      '在“关于 Mongo Manager”页面。管理员点击“立即检查”或开启每日检查，然后用“更新”安装新版本：npm 包、独立可执行文件、服务和 Docker 都能自行更新；需要更新的 Docker 镜像的发布会告诉你要运行的 docker pull。1.1.0 是第一个能这样做的版本，请手动安装一次。',
    'footer.license': 'CC BY-NC-SA 4.0 许可证',
    'footer.source': '源代码',
    'footer.trademark': 'MongoDB 是 MongoDB, Inc. 的商标。Mongo Manager 与 MongoDB, Inc. 无关联。',
    'lb.label': '截图',
    'lb.close': '关闭',
    'lb.prev': '上一张',
    'lb.next': '下一张',
    'lb.open': '放大：{caption}',
  },
  ja: {
    'nav.ai': 'AI',
    'ai.title': 'データベースのための AI エージェント',
    'ai.lead':
      '自分の言葉で頼めます。エージェントは接続を名前で扱い、必要なものを読み取り、変更はすべてカードにしてあなたの確認を待ちます。',
    'ai.p1': 'データからの回答：クエリやパイプラインを自分で書いて実行し、行った手順をすべて表示します。',
    'ai.p2':
      '確認してから変更：コレクション、ドキュメント、インデックス、バックアップ、スケジュール、ユーザーを、それぞれ専用のカードで。断れば何も書き込まれません。',
    'ai.p3':
      '自分のプロバイダー：Anthropic、Google Gemini、OpenAI 互換の任意のサーバー、または自分のネットワーク上の Ollama。',
    'ai.p4':
      '自分のルール：個人データはエージェントから隠され、接続ごとに AI ポリシーがあり、すべてのリクエストはトークン数とともに履歴に残ります。',
    'tour.ai.t': 'AI エージェントに頼む',
    'tour.ai.d':
      '必要なクエリやパイプラインを自分で書いて実行し、データから答えます。変更はカードで提案され、確認すれば実行、断れば何も書き込まれません。',
    'shots.ai-agent': 'AI エージェント：データからの回答と、確認待ちのインデックス',
    'meta.title': 'Mongo Manager — ブラウザで使える安全な MongoDB マネージャー',
    'meta.description':
      '完全にオフラインで動作するセルフホスト型の MongoDB マネージャー。ドキュメント、集計、スキーマ、パフォーマンス、バックアップ、チームでのアクセス、AI アシスタントを 10 言語で。非商用なら無料です。',
    'a11y.skip': '本文へ移動',
    'a11y.nav': 'メインメニュー',
    'a11y.lang': '言語',
    'a11y.github': 'GitHub の Mongo Manager',
    'a11y.theme': 'テーマ：{mode}',
    'theme.auto': '自動',
    'theme.light': 'ライト',
    'theme.dark': 'ダーク',
    'nav.features': '機能',
    'nav.tour': 'ツアー',
    'nav.screens': 'スクリーンショット',
    'nav.security': 'セキュリティ',
    'nav.install': 'インストール',
    'nav.faq': 'FAQ',
    'hero.eyebrow': 'セルフホスト · オフラインで動作 · 非商用なら無料',
    'hero.title': 'あなたの MongoDB を、ブラウザで。',
    'hero.lead':
      'ドキュメントの閲覧と編集、集計の構築、スキーマの確認、クエリが遅い理由の把握、サーバーの監視まで。自分で動かす一つのアプリで完結し、どこにもデータは送られません。',
    'hero.install': 'インストール',
    'hero.github': 'GitHub で見る',
    'hero.meta': 'CC BY-NC-SA 4.0 ライセンス · Node.js 24 以降、単体バイナリまたは Docker · MongoDB 6.0 以降',
    'release.info': '最新：v{v} · {date}',
    'features.title': 'MongoDB を扱うのに必要なものがすべて',
    'features.lead': 'コレクションをさっと確認するところから、チームのデータベース運用まで。',
    'f.documents.t': '閲覧と編集',
    'f.documents.d':
      'テーブル、カード、JSON 表示。変更した部分だけを書き込むセル編集。実行前にプレビューできる一括更新。',
    'f.query.t': '頼れるクエリ',
    'f.query.d':
      'フィールド補完、ビジュアルなフィルタービルダー、照合順序とヒント。find をシェルコマンドとしてコピーしたりコードに書き出したりできます。',
    'f.aggregation.t': '集計ビルダー',
    'f.aggregation.d':
      '各ステージをライブでプレビューできるステージカード、テキストモード、8 言語へのエクスポート。',
    'f.schema.t': 'スキーマとインデックス',
    'f.schema.d':
      '全フィールドのサンプル分析、インデックスの使用状況、Atlas Search と Vector Search のインデックス。',
    'f.explain.t': 'なぜ遅い？',
    'f.explain.d': '警告付きのツリーでクエリプランを表示し、役立つインデックスを入力済みで提案します。',
    'f.performance.t': 'パフォーマンスとアラート',
    'f.performance.d':
      '7 日間の履歴付きのライブグラフ、スロークエリ、インデックスの提案、メールや Webhook でのアラート。',
    'f.shell.t': '高度なシェル',
    'f.shell.d': 'タブ内のサンドボックスで動く mongosh。すべてのコマンドが監査されます。',
    'f.transfer.t': 'インポート、エクスポート、同期',
    'f.transfer.d': 'CSV、JSON、Excel、SQL ダンプ。サーバー間のコピー、比較、ライブ同期。',
    'f.backup.t': 'バックアップ',
    'f.backup.d':
      'mongodump アーカイブや暗号化ファイルをスケジュール実行し、S3、Google Drive、WebDAV、フォルダーに送信。',
    'f.ai.t': 'AI アシスタント',
    'f.ai.d': '言葉からクエリ、パイプライン、説明を生成。自分のプロバイダーを使い、変更のたびに確認します。',
    'f.team.t': 'チームのために',
    'f.team.d': 'ロールと接続ごとのアクセス、二要素サインイン、アドレスによるパネルアクセス制限、監査ログ。',
    'f.plugins.t': 'プラグイン',
    'f.plugins.d':
      'サンドボックスで動くタブ、アクション、ページ。どれもセキュリティスキャンの後に管理者が承認します。',
    'tour.title': 'クイックツアー',
    'tour.lead': 'サンプルのストアで動くアプリの短いクリップです。',
    'tour.query.t': '検索と絞り込み',
    'tour.query.d':
      'フィールド補完付きのフィルターを入力するか、値をクリックして追加します。結果はテーブル、カード、JSON で表示されます。',
    'tour.aggregation.t': 'ステージごとにパイプラインを構築',
    'tour.aggregation.d':
      '入力に合わせて、各ステージがサンプルに対する出力を表示します。実行、保存、コードへのエクスポートもできます。',
    'tour.schema.t': 'データの形を把握',
    'tour.schema.d': '各フィールドをサンプリングして分析します。型、出現頻度、値がわかります。',
    'tour.explain.t': 'クエリが遅い理由を確認',
    'tour.explain.d':
      'クエリプランをツリーで表示し、コレクション全体を読み取った箇所と役立つインデックスを示します。',
    'tour.palette.t': 'すべてがキー一つで',
    'tour.palette.d': 'コマンドパレット（Ctrl+K）で、あらゆるコマンド、コレクション、設定を見つけられます。',
    'tour.performance.t': 'サーバーをリアルタイムで監視',
    'tour.performance.d':
      'オペレーション、接続、ネットワーク、メモリをリアルタイムと 7 日間の履歴で表示し、アラートも備えます。',
    'tour.play': 'クリップを再生',
    'tour.pause': 'クリップを一時停止',
    'shots.title': 'スクリーンショット',
    'shots.lead': 'このページのテーマで表示しています。選ぶと拡大します。',
    'shots.documents': 'フィルターとワンクリックの候補が付いたテーブル表示のドキュメント',
    'shots.aggregation': '各ステージをプレビューできる集計パイプライン',
    'shots.schema': 'サンプリングしたコレクションのスキーマ',
    'shots.explain': 'なぜ遅い？ クエリプラン',
    'shots.performance': 'サーバーのリアルタイムのパフォーマンス',
    'shots.palette': 'コマンドパレット（Ctrl+K）',
    'shots.plugins': '管理者が一つずつ承認するプラグイン',
    'shots.security':
      'チームモード：二要素認証のルール、セッション、パネルへのアクセス、サインインのブロック',
    'security.title': '設計からプライベートで安全',
    'security.lead': 'Mongo Manager はあなたのマシンやサーバーで動き、設定した相手とだけ通信します。',
    'security.p1':
      '完全にオフラインで動作。テレメトリー、CDN、外部フォントはなく、管理者が毎日の確認をオンにしない限り更新も確認しません。',
    'security.p2': 'パスワードと鍵は暗号化して保存し、再表示もログへの書き込みもしません。',
    'security.p3':
      '個人データのルールで、見るべきでない人からフィールドを隠します。ドキュメント、エクスポート、バックアップ、AI アシスタントのどこでも。',
    'security.p4': 'チームモードでは、二要素サインイン、サインインのブロック、パネルのアドレス許可リスト。',
    'security.p5': 'すべての変更を記録する追記専用の監査ログ。',
    'security.p6': 'プラグインはサンドボックスで動き、管理者が承認した後にだけ有効になります。',
    'security.p7':
      '更新は署名付きです。Mongo Manager の鍵で署名されたリリースだけがインストールされ、起動のたびにすべてのファイルが確認し直され、起動しないバージョンはロールバックされます。',
    'install.title': 'インストール',
    'install.lead':
      'どれか一つを選んでください。各リリースには SHA-256 チェックサムが付くため、ネットワークから隔離されたマシンでも使えます。',
    'install.copy': 'コピー',
    'install.copied': 'コピーしました',
    'install.npm.note': 'Node.js 24 以降が必要です。常用するなら：npm install --global @mongo-manager/app。',
    'install.docker.note': 'データは mm-data ボリュームに保存されます。',
    'install.binary.tab': 'バイナリ',
    'install.binary.d':
      '最新リリースからお使いのシステム用のファイルをダウンロードして実行します：Linux x64 / arm64、Windows x64、macOS arm64。ランタイムとウェブアプリを内蔵しています。',
    'install.binary.link': '最新リリース',
    'install.then':
      'その後 <code>http://127.0.0.1:4321</code> を開きます。チームで使うなら <code>--auth</code> 付きで起動します。初回起動時に一度だけ使えるセットアップトークンが表示されます。',
    'install.update':
      '以降のバージョンは「Mongo Manager について」ページから届きます。管理者が確認して「更新」を押します。',
    'faq.title': 'よくある質問',
    'faq.q1': '無料ですか？',
    'faq.a1':
      'はい、非商用であれば無料です。Mongo Manager はクリエイティブ・コモンズ BY-NC-SA 4.0 で提供されています。クレジットを表示すれば使用・共有・改変でき、商用目的には使えず、改変したものは同じライセンスで共有します。',
    'faq.q2': 'データをどこかに送りますか？',
    'faq.a2':
      'いいえ。アプリは他のサイトから何も読み込まず、サーバーが接続するのは MongoDB のデプロイと SSH ホスト、そしてあなたが有効にした AI プロバイダー、バックアップ先、プラグインのインストール元、更新確認だけです。',
    'faq.q3': '対応している MongoDB のバージョンは？',
    'faq.a3': 'MongoDB 6.0 以降：スタンドアロン、レプリカセット、mongos 経由のシャードクラスター、Atlas。',
    'faq.q4': 'チームで使えますか？',
    'faq.a4':
      'はい。--auth を付けて起動するとチームモードになります。管理者・編集者・閲覧者ロールのアカウント、接続ごとのアクセス、二要素サインインが使えます。',
    'faq.q5': 'AI プロバイダーは必要ですか？',
    'faq.a5':
      'いいえ。アシスタントは任意です。有効にすると、Anthropic、Google Gemini、OpenAI 互換の任意のサーバー、または自分のネットワーク上の Ollama で動きます。',
    'faq.q6': '対応言語は？',
    'faq.a6':
      '10 言語：英語、トルコ語、簡体字中国語、日本語、スペイン語、ブラジルポルトガル語、韓国語、ドイツ語、フランス語、ロシア語。',
    'faq.q7': 'どうやって更新しますか？',
    'faq.a7':
      '「Mongo Manager について」ページから。管理者が「今すぐ確認」を押すか毎日の確認をオンにし、「更新」で新しいバージョンをインストールします。npm パッケージ、単体のバイナリ、サービス、Docker のどれも自分で更新し、新しい Docker イメージが必要なリリースは実行する docker pull を示します。これができる最初のバージョンは 1.1.0 です。一度だけ手動でインストールしてください。',
    'footer.license': 'CC BY-NC-SA 4.0 ライセンス',
    'footer.source': 'ソースコード',
    'footer.trademark':
      'MongoDB は MongoDB, Inc. の商標です。Mongo Manager は MongoDB, Inc. とは関係ありません。',
    'lb.label': 'スクリーンショット',
    'lb.close': '閉じる',
    'lb.prev': '前へ',
    'lb.next': '次へ',
    'lb.open': '拡大：{caption}',
  },
  es: {
    'nav.ai': 'IA',
    'ai.title': 'Un agente de IA para tus bases de datos',
    'ai.lead':
      'Pídelo con tus palabras. El agente trabaja con tus conexiones por su nombre, lee lo que necesita y pone cada cambio en una tarjeta que tú confirmas.',
    'ai.p1':
      'Respuestas a partir de tus datos: escribe y ejecuta la consulta o el pipeline, y muestra cada paso que dio.',
    'ai.p2':
      'Cambios que tú confirmas: colecciones, documentos, índices, copias de seguridad, programaciones y usuarios, cada uno en su tarjeta. Si lo rechazas, no se escribe nada.',
    'ai.p3':
      'Tu proveedor: Anthropic, Google Gemini, cualquier servidor compatible con OpenAI u Ollama en tu propia red.',
    'ai.p4':
      'Tus reglas: los datos personales quedan ocultos para él, cada conexión tiene su propia política de IA y cada petición queda en tu historial con sus tokens.',
    'tour.ai.t': 'Pregunta al agente de IA',
    'tour.ai.d':
      'Responde a partir de tus datos —escribe y ejecuta la consulta o el pipeline que necesita— y propone cada cambio en una tarjeta: confírmalo, o recházalo y no se escribe nada.',
    'shots.ai-agent':
      'El agente de IA: una respuesta a partir de los datos y un índice que espera confirmación',
    'meta.title': 'Mongo Manager — un gestor de MongoDB seguro en tu navegador',
    'meta.description':
      'Un gestor de MongoDB autoalojado que funciona sin conexión: documentos, agregaciones, esquema, rendimiento, copias de seguridad, acceso en equipo y un asistente de IA, en diez idiomas. Gratuito para uso no comercial.',
    'a11y.skip': 'Saltar al contenido',
    'a11y.nav': 'Menú principal',
    'a11y.lang': 'Idioma',
    'a11y.github': 'Mongo Manager en GitHub',
    'a11y.theme': 'Tema: {mode}',
    'theme.auto': 'automático',
    'theme.light': 'claro',
    'theme.dark': 'oscuro',
    'nav.features': 'Funciones',
    'nav.tour': 'Recorrido',
    'nav.screens': 'Capturas',
    'nav.security': 'Seguridad',
    'nav.install': 'Instalación',
    'nav.faq': 'Preguntas',
    'hero.eyebrow': 'Autoalojado · Funciona sin conexión · Gratuito para uso no comercial',
    'hero.title': 'Tu MongoDB, en tu navegador.',
    'hero.lead':
      'Explora y edita documentos, construye agregaciones, lee el esquema, descubre por qué una consulta es lenta y vigila tus servidores, desde una sola aplicación que ejecutas tú mismo, sin enviar nada a ninguna otra parte.',
    'hero.install': 'Instalar',
    'hero.github': 'Ver en GitHub',
    'hero.meta':
      'Licencia CC BY-NC-SA 4.0 · Node.js 24+, un binario independiente o Docker · MongoDB 6.0 y posteriores',
    'release.info': 'Última versión: v{v} · {date}',
    'features.title': 'Todo lo que necesitas para trabajar con MongoDB',
    'features.lead':
      'Desde echar un vistazo a una colección hasta gestionar las bases de datos de un equipo.',
    'f.documents.t': 'Explora y edita',
    'f.documents.d':
      'Vistas de tabla, tarjetas y JSON; ediciones en línea que escriben solo lo que cambió; actualizaciones masivas con vista previa antes de ejecutarse.',
    'f.query.t': 'Consultas con ayuda',
    'f.query.d':
      'Autocompletado de campos, un constructor visual de filtros, intercalación e índices sugeridos; un find copiado como comando de shell o exportado a código.',
    'f.aggregation.t': 'Constructor de agregaciones',
    'f.aggregation.d':
      'Tarjetas de etapas con la vista previa en vivo de cada una, un modo de texto y exportación a ocho lenguajes.',
    'f.schema.t': 'Esquema e índices',
    'f.schema.d':
      'Un análisis por muestreo de cada campo, el uso de los índices y los índices de Atlas Search y Vector Search.',
    'f.explain.t': '¿Por qué es lenta?',
    'f.explain.d':
      'El plan de la consulta como un árbol con advertencias, y el índice que ayudaría, ya rellenado.',
    'f.performance.t': 'Rendimiento y alertas',
    'f.performance.d':
      'Gráficos en vivo con un historial de siete días, consultas lentas, consejos de índices y alertas por correo o webhook.',
    'f.shell.t': 'Shell avanzado',
    'f.shell.d': 'El entorno de mongosh en una pestaña, aislado, con cada comando auditado.',
    'f.transfer.t': 'Importa, exporta y sincroniza',
    'f.transfer.d': 'CSV, JSON, Excel y volcados SQL; copia, compara y sincroniza en vivo entre servidores.',
    'f.backup.t': 'Copias de seguridad',
    'f.backup.d':
      'Archivos de mongodump o archivos cifrados, programados y enviados a S3, Google Drive, WebDAV o una carpeta.',
    'f.ai.t': 'Asistente de IA',
    'f.ai.d':
      'Consultas, pipelines y explicaciones a partir de tus palabras, con tu propio proveedor; cada cambio pide confirmación.',
    'f.team.t': 'Hecho para equipos',
    'f.team.d':
      'Roles y acceso por conexión, inicio de sesión con doble factor, acceso al panel por dirección y un registro de auditoría.',
    'f.plugins.t': 'Complementos',
    'f.plugins.d':
      'Pestañas, acciones y páginas aisladas, cada una aprobada por un administrador tras un análisis de seguridad.',
    'tour.title': 'Un recorrido rápido',
    'tour.lead': 'Clips breves de la aplicación trabajando con una tienda de ejemplo.',
    'tour.query.t': 'Busca y filtra',
    'tour.query.d':
      'Escribe un filtro con autocompletado de campos o haz clic en un valor para añadirlo; los resultados se paginan en tabla, tarjetas o JSON.',
    'tour.aggregation.t': 'Construye pipelines etapa por etapa',
    'tour.aggregation.d':
      'Cada etapa muestra su salida sobre una muestra mientras escribes; ejecútalo, guárdalo o expórtalo a código.',
    'tour.schema.t': 'Conoce la forma de tus datos',
    'tour.schema.d':
      'Un análisis por muestreo de cada campo: sus tipos, con qué frecuencia aparece y sus valores.',
    'tour.explain.t': 'Descubre por qué una consulta es lenta',
    'tour.explain.d':
      'El plan de la consulta como un árbol, con el paso que leyó toda la colección y el índice que ayudaría.',
    'tour.palette.t': 'Todo a una tecla',
    'tour.palette.d': 'La paleta de comandos (Ctrl+K) encuentra cualquier comando, colección o ajuste.',
    'tour.performance.t': 'Observa el servidor en vivo',
    'tour.performance.d':
      'Operaciones, conexiones, red y memoria, en vivo y durante siete días, con alertas.',
    'tour.play': 'Reproducir el clip',
    'tour.pause': 'Pausar el clip',
    'shots.title': 'Capturas de pantalla',
    'shots.lead': 'Se muestran con el tema de esta página; elige una para ampliarla.',
    'shots.documents': 'Documentos en una tabla, con un filtro y sugerencias de un clic',
    'shots.aggregation': 'Un pipeline de agregación, con la vista previa de cada etapa',
    'shots.schema': 'El esquema de una colección muestreada',
    'shots.explain': '¿Por qué es lenta? El plan de la consulta',
    'shots.performance': 'El rendimiento del servidor en vivo',
    'shots.palette': 'La paleta de comandos (Ctrl+K)',
    'shots.plugins': 'Complementos, cada uno aprobado por un administrador',
    'shots.security':
      'Modo equipo: reglas de doble factor, sesiones, acceso al panel y bloqueos de inicio de sesión',
    'security.title': 'Privado y seguro desde el diseño',
    'security.lead':
      'Mongo Manager se ejecuta en tu equipo o tu servidor y solo se comunica con lo que configuras.',
    'security.p1':
      'Funciona totalmente sin conexión: sin telemetría, CDN ni fuentes externas, y sin comprobar actualizaciones salvo que un administrador active la comprobación diaria.',
    'security.p2':
      'Las contraseñas y claves se guardan cifradas, no se vuelven a mostrar y nunca se escriben en los registros.',
    'security.p3':
      'Las reglas de datos personales ocultan campos a quien no debe verlos: en documentos, exportaciones, copias de seguridad y el asistente de IA.',
    'security.p4':
      'En modo equipo: inicio de sesión con doble factor, bloqueos de inicio de sesión y una lista de direcciones permitidas para el panel.',
    'security.p5': 'Un registro de auditoría de solo adición de cada cambio.',
    'security.p6':
      'Los complementos se ejecutan aislados, y solo después de que un administrador los apruebe.',
    'security.p7':
      'Las actualizaciones van firmadas: solo se instala una versión firmada con la clave de Mongo Manager, cada archivo se vuelve a comprobar en cada arranque y una versión que no arranca se revierte.',
    'install.title': 'Instalación',
    'install.lead':
      'Elige una opción. Cada versión incluye sumas de comprobación SHA-256, así que también funciona en un equipo sin red.',
    'install.copy': 'Copiar',
    'install.copied': 'Copiado',
    'install.npm.note':
      'Necesita Node.js 24 o posterior. Para dejarlo instalado: npm install --global @mongo-manager/app.',
    'install.docker.note': 'Tus datos se quedan en el volumen mm-data.',
    'install.binary.tab': 'Binario',
    'install.binary.d':
      'Descarga el archivo para tu sistema desde la última versión y ejecútalo: Linux x64 y arm64, Windows x64, macOS arm64. Incluye su propio entorno de ejecución y la aplicación web.',
    'install.binary.link': 'Última versión',
    'install.then':
      'Después abre <code>http://127.0.0.1:4321</code>. Para un equipo, inícialo con <code>--auth</code>: el primer arranque muestra un token de configuración de un solo uso.',
    'install.update':
      'Las versiones siguientes llegan desde la página Acerca de Mongo Manager: un administrador comprueba y pulsa Actualizar.',
    'faq.title': 'Preguntas',
    'faq.q1': '¿Es gratuito?',
    'faq.a1':
      'Sí, para uso no comercial. Mongo Manager tiene licencia Creative Commons BY-NC-SA 4.0: puedes usarlo, compartirlo y adaptarlo citando la autoría, sin fines comerciales y compartiendo tus cambios con la misma licencia.',
    'faq.q2': '¿Envía mis datos a algún sitio?',
    'faq.a2':
      'No. La aplicación no carga nada de otros sitios, y el servidor solo se conecta a tus despliegues de MongoDB y hosts SSH, y a los proveedores de IA, destinos de copias de seguridad, instalaciones de complementos y comprobación de actualizaciones que actives.',
    'faq.q3': '¿Qué versiones de MongoDB admite?',
    'faq.a3':
      'MongoDB 6.0 y posteriores: servidores independientes, conjuntos de réplicas, clústeres fragmentados a través de mongos y Atlas.',
    'faq.q4': '¿Puede usarlo mi equipo?',
    'faq.a4':
      'Sí. Inícialo con --auth para el modo equipo: cuentas con roles de administrador, editor y lector, acceso por conexión e inicio de sesión con doble factor.',
    'faq.q5': '¿Necesito un proveedor de IA?',
    'faq.a5':
      'No. El asistente es opcional; activado, funciona con Anthropic, Google Gemini, cualquier servidor compatible con OpenAI u Ollama en tu propia red.',
    'faq.q6': '¿En qué idiomas está?',
    'faq.a6':
      'En diez: inglés, turco, chino simplificado, japonés, español, portugués de Brasil, coreano, alemán, francés y ruso.',
    'faq.q7': '¿Cómo lo actualizo?',
    'faq.a7':
      'Desde la página Acerca de Mongo Manager. Un administrador pulsa Comprobar ahora o activa la comprobación diaria, e instala la versión nueva con Actualizar: el paquete npm, el binario independiente, un servicio y Docker se actualizan solos, y una versión que necesita una imagen de Docker más reciente indica qué docker pull ejecutar. La 1.1.0 es la primera que lo hace: instálala a mano una vez.',
    'footer.license': 'Licencia CC BY-NC-SA 4.0',
    'footer.source': 'Código fuente',
    'footer.trademark':
      'MongoDB es una marca registrada de MongoDB, Inc. Mongo Manager no está afiliado a MongoDB, Inc.',
    'lb.label': 'Captura de pantalla',
    'lb.close': 'Cerrar',
    'lb.prev': 'Anterior',
    'lb.next': 'Siguiente',
    'lb.open': 'Ampliar: {caption}',
  },
  pt: {
    'nav.ai': 'IA',
    'ai.title': 'Um agente de IA para os seus bancos de dados',
    'ai.lead':
      'Peça com as suas palavras. O agente trabalha com suas conexões pelo nome, lê o que precisa e coloca cada mudança em um cartão que você confirma.',
    'ai.p1':
      'Respostas a partir dos seus dados: ele escreve e executa a consulta ou o pipeline, e mostra cada passo que deu.',
    'ai.p2':
      'Mudanças que você confirma: coleções, documentos, índices, backups, agendamentos e usuários, cada um em seu cartão. Recuse, e nada é gravado.',
    'ai.p3':
      'O seu provedor: Anthropic, Google Gemini, qualquer servidor compatível com OpenAI ou Ollama na sua própria rede.',
    'ai.p4':
      'As suas regras: os dados pessoais ficam ocultos para ele, cada conexão tem sua própria política de IA e cada pedido fica no seu histórico com seus tokens.',
    'tour.ai.t': 'Pergunte ao agente de IA',
    'tour.ai.d':
      'Ele responde a partir dos seus dados — escrevendo e executando a consulta ou o pipeline de que precisa — e propõe cada mudança em um cartão: confirme, ou recuse e nada é gravado.',
    'shots.ai-agent': 'O agente de IA: uma resposta a partir dos dados e um índice aguardando confirmação',
    'meta.title': 'Mongo Manager — um gerenciador de MongoDB seguro no seu navegador',
    'meta.description':
      'Um gerenciador de MongoDB auto-hospedado que funciona totalmente offline: documentos, agregações, esquema, desempenho, backups, acesso em equipe e um assistente de IA, em dez idiomas. Gratuito para uso não comercial.',
    'a11y.skip': 'Pular para o conteúdo',
    'a11y.nav': 'Menu principal',
    'a11y.lang': 'Idioma',
    'a11y.github': 'Mongo Manager no GitHub',
    'a11y.theme': 'Tema: {mode}',
    'theme.auto': 'automático',
    'theme.light': 'claro',
    'theme.dark': 'escuro',
    'nav.features': 'Recursos',
    'nav.tour': 'Tour',
    'nav.screens': 'Capturas',
    'nav.security': 'Segurança',
    'nav.install': 'Instalação',
    'nav.faq': 'Perguntas',
    'hero.eyebrow': 'Auto-hospedado · Funciona offline · Gratuito para uso não comercial',
    'hero.title': 'Seu MongoDB, no seu navegador.',
    'hero.lead':
      'Navegue e edite documentos, monte agregações, leia o esquema, veja por que uma consulta está lenta e acompanhe seus servidores — em um só aplicativo que você mesmo executa, sem enviar nada para nenhum outro lugar.',
    'hero.install': 'Instalar',
    'hero.github': 'Ver no GitHub',
    'hero.meta':
      'Licença CC BY-NC-SA 4.0 · Node.js 24+, um binário independente ou Docker · MongoDB 6.0 e posteriores',
    'release.info': 'Mais recente: v{v} · {date}',
    'features.title': 'Tudo o que você precisa para trabalhar com o MongoDB',
    'features.lead': 'De uma olhada rápida em uma coleção até cuidar dos bancos de dados de uma equipe.',
    'f.documents.t': 'Navegue e edite',
    'f.documents.d':
      'Visões de tabela, cartões e JSON; edições na célula que gravam só o que mudou; atualizações em massa com prévia antes de rodar.',
    'f.query.t': 'Consultas com ajuda',
    'f.query.d':
      'Preenchimento de campos, um construtor visual de filtros, collation e hints; um find copiado como comando do shell ou exportado para código.',
    'f.aggregation.t': 'Construtor de agregações',
    'f.aggregation.d':
      'Cartões de etapas com a prévia ao vivo de cada uma, um modo de texto e exportação para oito linguagens.',
    'f.schema.t': 'Esquema e índices',
    'f.schema.d':
      'Uma análise por amostragem de cada campo, o uso dos índices e os índices do Atlas Search e do Vector Search.',
    'f.explain.t': 'Por que está lenta?',
    'f.explain.d': 'O plano da consulta como uma árvore com avisos, e o índice que ajudaria, já preenchido.',
    'f.performance.t': 'Desempenho e alertas',
    'f.performance.d':
      'Gráficos ao vivo com sete dias de histórico, consultas lentas, sugestões de índices e alertas por e-mail ou webhook.',
    'f.shell.t': 'Shell avançado',
    'f.shell.d': 'O runtime do mongosh em uma aba, isolado, com cada comando auditado.',
    'f.transfer.t': 'Importe, exporte e sincronize',
    'f.transfer.d': 'CSV, JSON, Excel e dumps SQL; copie, compare e sincronize ao vivo entre servidores.',
    'f.backup.t': 'Backups',
    'f.backup.d':
      'Arquivos do mongodump ou arquivos criptografados, agendados e enviados para S3, Google Drive, WebDAV ou uma pasta.',
    'f.ai.t': 'Assistente de IA',
    'f.ai.d':
      'Consultas, pipelines e explicações a partir das suas palavras, com o seu próprio provedor; cada mudança pede confirmação.',
    'f.team.t': 'Feito para equipes',
    'f.team.d':
      'Papéis e acesso por conexão, login com dois fatores, acesso ao painel por endereço e um log de auditoria.',
    'f.plugins.t': 'Plugins',
    'f.plugins.d':
      'Abas, ações e páginas isoladas, cada uma aprovada por um administrador após uma análise de segurança.',
    'tour.title': 'Um tour rápido',
    'tour.lead': 'Clipes curtos do aplicativo trabalhando em uma loja de exemplo.',
    'tour.query.t': 'Encontre e filtre',
    'tour.query.d':
      'Digite um filtro com preenchimento de campos ou clique em um valor para adicioná-lo; os resultados são paginados em tabela, cartões ou JSON.',
    'tour.aggregation.t': 'Monte pipelines etapa por etapa',
    'tour.aggregation.d':
      'Cada etapa mostra sua saída em uma amostra enquanto você digita; execute, salve ou exporte para código.',
    'tour.schema.t': 'Conheça a forma dos seus dados',
    'tour.schema.d':
      'Uma análise por amostragem de cada campo: seus tipos, com que frequência aparece e seus valores.',
    'tour.explain.t': 'Veja por que uma consulta está lenta',
    'tour.explain.d':
      'O plano da consulta como uma árvore, com a etapa que leu a coleção inteira e o índice que ajudaria.',
    'tour.palette.t': 'Tudo a uma tecla',
    'tour.palette.d': 'A paleta de comandos (Ctrl+K) encontra qualquer comando, coleção ou configuração.',
    'tour.performance.t': 'Acompanhe o servidor ao vivo',
    'tour.performance.d':
      'Operações, conexões, rede e memória, ao vivo e ao longo de sete dias, com alertas.',
    'tour.play': 'Reproduzir o clipe',
    'tour.pause': 'Pausar o clipe',
    'shots.title': 'Capturas de tela',
    'shots.lead': 'Mostradas no tema desta página; escolha uma para ampliá-la.',
    'shots.documents': 'Documentos em uma tabela, com um filtro e sugestões em um clique',
    'shots.aggregation': 'Um pipeline de agregação, com a prévia de cada etapa',
    'shots.schema': 'O esquema de uma coleção amostrada',
    'shots.explain': 'Por que está lenta? O plano da consulta',
    'shots.performance': 'O desempenho do servidor ao vivo',
    'shots.palette': 'A paleta de comandos (Ctrl+K)',
    'shots.plugins': 'Plugins, cada um aprovado por um administrador',
    'shots.security': 'Modo equipe: regras de dois fatores, sessões, acesso ao painel e bloqueios de entrada',
    'security.title': 'Privado e seguro desde o projeto',
    'security.lead':
      'O Mongo Manager roda na sua máquina ou no seu servidor e só se comunica com o que você configura.',
    'security.p1':
      'Funciona totalmente offline: sem telemetria, CDN ou fontes externas, e sem verificar atualizações a menos que um administrador ative a verificação diária.',
    'security.p2':
      'Senhas e chaves ficam criptografadas, nunca são mostradas de novo e nunca vão para os logs.',
    'security.p3':
      'As regras de dados pessoais escondem campos de quem não pode vê-los — em documentos, exportações, backups e no assistente de IA.',
    'security.p4':
      'No modo equipe: login com dois fatores, bloqueios de entrada e uma lista de endereços permitidos para o painel.',
    'security.p5': 'Um log de auditoria somente de inclusão de cada mudança.',
    'security.p6': 'Os plugins rodam isolados, e só depois que um administrador os aprova.',
    'security.p7':
      'As atualizações são assinadas: só é instalada uma versão assinada com a chave do Mongo Manager, cada arquivo é conferido de novo a cada inicialização e uma versão que não inicia é revertida.',
    'install.title': 'Instalação',
    'install.lead':
      'Escolha uma opção. Cada versão traz somas de verificação SHA-256, então também funciona em uma máquina sem rede.',
    'install.copy': 'Copiar',
    'install.copied': 'Copiado',
    'install.npm.note':
      'Precisa do Node.js 24 ou posterior. Para deixar instalado: npm install --global @mongo-manager/app.',
    'install.docker.note': 'Seus dados ficam no volume mm-data.',
    'install.binary.tab': 'Binário',
    'install.binary.d':
      'Baixe o arquivo do seu sistema na versão mais recente e execute-o: Linux x64 e arm64, Windows x64, macOS arm64. Ele traz o próprio runtime e o aplicativo web.',
    'install.binary.link': 'Versão mais recente',
    'install.then':
      'Depois abra <code>http://127.0.0.1:4321</code>. Para uma equipe, inicie com <code>--auth</code>: a primeira inicialização mostra um token de configuração de uso único.',
    'install.update':
      'As próximas versões chegam pela página Sobre o Mongo Manager: um administrador verifica e clica em Atualizar.',
    'faq.title': 'Perguntas',
    'faq.q1': 'É gratuito?',
    'faq.a1':
      'Sim, para uso não comercial. O Mongo Manager é licenciado sob Creative Commons BY-NC-SA 4.0: você pode usá-lo, compartilhá-lo e adaptá-lo dando os créditos, sem fins comerciais e compartilhando suas alterações sob a mesma licença.',
    'faq.q2': 'Ele envia meus dados para algum lugar?',
    'faq.a2':
      'Não. O aplicativo não carrega nada de outros sites, e o servidor só acessa suas implantações do MongoDB e hosts SSH, e os provedores de IA, destinos de backup, instalações de plugins e a verificação de atualizações que você ativar.',
    'faq.q3': 'Quais versões do MongoDB ele suporta?',
    'faq.a3':
      'MongoDB 6.0 e posteriores: servidores independentes, conjuntos de réplicas, clusters fragmentados via mongos e Atlas.',
    'faq.q4': 'Minha equipe pode usar?',
    'faq.a4':
      'Sim. Inicie com --auth para o modo equipe: contas com papéis de administrador, editor e leitor, acesso por conexão e login com dois fatores.',
    'faq.q5': 'Preciso de um provedor de IA?',
    'faq.a5':
      'Não. O assistente é opcional; ativado, funciona com Anthropic, Google Gemini, qualquer servidor compatível com OpenAI ou Ollama na sua própria rede.',
    'faq.q6': 'Em quais idiomas ele está?',
    'faq.a6':
      'Dez: inglês, turco, chinês simplificado, japonês, espanhol, português do Brasil, coreano, alemão, francês e russo.',
    'faq.q7': 'Como eu atualizo?',
    'faq.a7':
      'Pela página Sobre o Mongo Manager. Um administrador clica em Verificar agora ou ativa a verificação diária e instala a nova versão com Atualizar: o pacote npm, o binário independente, um serviço e o Docker se atualizam sozinhos, e uma versão que precisa de uma imagem Docker mais recente diz qual docker pull executar. A 1.1.0 é a primeira que faz isso: instale-a manualmente uma vez.',
    'footer.license': 'Licença CC BY-NC-SA 4.0',
    'footer.source': 'Código-fonte',
    'footer.trademark':
      'MongoDB é uma marca registrada da MongoDB, Inc. O Mongo Manager não é afiliado à MongoDB, Inc.',
    'lb.label': 'Captura de tela',
    'lb.close': 'Fechar',
    'lb.prev': 'Anterior',
    'lb.next': 'Próxima',
    'lb.open': 'Ampliar: {caption}',
  },
  ko: {
    'nav.ai': 'AI',
    'ai.title': '데이터베이스를 위한 AI 에이전트',
    'ai.lead':
      '원하는 말로 요청하세요. 에이전트가 연결을 이름으로 다루고, 필요한 것을 읽고, 모든 변경을 카드에 담아 당신의 확인을 기다립니다.',
    'ai.p1': '데이터로 답합니다: 쿼리나 파이프라인을 직접 작성해 실행하고, 거친 모든 단계를 보여 줍니다.',
    'ai.p2':
      '확인 후에만 변경: 컬렉션, 문서, 인덱스, 백업, 예약, 사용자를 각각의 카드로. 거절하면 아무것도 쓰이지 않습니다.',
    'ai.p3': '직접 고른 제공자: Anthropic, Google Gemini, OpenAI 호환 서버 또는 자체 네트워크의 Ollama.',
    'ai.p4':
      '당신의 규칙: 개인 데이터는 에이전트에게서 숨겨지고, 연결마다 AI 정책이 있으며, 모든 요청은 토큰 수와 함께 기록에 남습니다.',
    'tour.ai.t': 'AI 에이전트에게 요청',
    'tour.ai.d':
      '필요한 쿼리나 파이프라인을 직접 작성해 실행하고 데이터로 답합니다. 변경은 카드로 제안되며, 확인하면 실행되고 거절하면 아무것도 쓰이지 않습니다.',
    'shots.ai-agent': 'AI 에이전트: 데이터에서 나온 답과 확인을 기다리는 인덱스',
    'meta.title': 'Mongo Manager — 브라우저에서 쓰는 안전한 MongoDB 관리 도구',
    'meta.description':
      '완전히 오프라인으로 작동하는 자체 호스팅 MongoDB 관리 도구: 문서, 집계, 스키마, 성능, 백업, 팀 접근, AI 도우미를 10개 언어로. 비상업적 용도로는 무료입니다.',
    'a11y.skip': '본문으로 건너뛰기',
    'a11y.nav': '주 메뉴',
    'a11y.lang': '언어',
    'a11y.github': 'GitHub의 Mongo Manager',
    'a11y.theme': '테마: {mode}',
    'theme.auto': '자동',
    'theme.light': '라이트',
    'theme.dark': '다크',
    'nav.features': '기능',
    'nav.tour': '둘러보기',
    'nav.screens': '스크린샷',
    'nav.security': '보안',
    'nav.install': '설치',
    'nav.faq': 'FAQ',
    'hero.eyebrow': '자체 호스팅 · 오프라인 작동 · 비상업적 용도 무료',
    'hero.title': '당신의 MongoDB를 브라우저에서.',
    'hero.lead':
      '문서를 보고 편집하고, 집계를 만들고, 스키마를 읽고, 쿼리가 느린 이유를 확인하고, 서버를 지켜보세요. 직접 실행하는 하나의 앱에서, 어디로도 데이터를 보내지 않고.',
    'hero.install': '설치',
    'hero.github': 'GitHub에서 보기',
    'hero.meta': 'CC BY-NC-SA 4.0 라이선스 · Node.js 24 이상, 단일 실행 파일 또는 Docker · MongoDB 6.0 이상',
    'release.info': '최신: v{v} · {date}',
    'features.title': 'MongoDB 작업에 필요한 모든 것',
    'features.lead': '컬렉션을 빠르게 살펴보는 일부터 팀의 데이터베이스 운영까지.',
    'f.documents.t': '보기와 편집',
    'f.documents.d': '표, 카드, JSON 보기. 바뀐 부분만 쓰는 셀 편집. 실행 전에 미리 보는 대량 업데이트.',
    'f.query.t': '도움을 주는 쿼리',
    'f.query.d':
      '필드 자동 완성, 시각적 필터 빌더, 콜레이션과 힌트. find를 셸 명령으로 복사하거나 코드로 내보낼 수 있습니다.',
    'f.aggregation.t': '집계 빌더',
    'f.aggregation.d': '단계마다 실시간 미리 보기가 있는 단계 카드, 텍스트 모드, 8개 언어로 내보내기.',
    'f.schema.t': '스키마와 인덱스',
    'f.schema.d': '모든 필드의 샘플 분석, 인덱스 사용량, Atlas Search와 Vector Search 인덱스.',
    'f.explain.t': '왜 느린가요?',
    'f.explain.d': '경고가 포함된 트리로 쿼리 계획을 보여 주고, 도움이 될 인덱스를 미리 채워 제안합니다.',
    'f.performance.t': '성능과 알림',
    'f.performance.d': '7일 기록이 있는 실시간 차트, 느린 쿼리, 인덱스 제안, 이메일이나 웹훅 알림.',
    'f.shell.t': '고급 셸',
    'f.shell.d': '탭 안의 샌드박스에서 실행되는 mongosh. 모든 명령이 감사 기록에 남습니다.',
    'f.transfer.t': '가져오기, 내보내기, 동기화',
    'f.transfer.d': 'CSV, JSON, Excel, SQL 덤프. 서버 간 복사, 비교, 실시간 동기화.',
    'f.backup.t': '백업',
    'f.backup.d':
      'mongodump 아카이브나 암호화 파일을 예약 실행하고 S3, Google Drive, WebDAV, 폴더로 보냅니다.',
    'f.ai.t': 'AI 도우미',
    'f.ai.d':
      '말로 설명하면 쿼리, 파이프라인, 설명을 만들어 줍니다. 직접 고른 제공자를 쓰며, 모든 변경은 먼저 확인을 받습니다.',
    'f.team.t': '팀을 위한 설계',
    'f.team.d': '역할과 연결별 접근, 2단계 로그인, 주소별 패널 접근 제한, 감사 로그.',
    'f.plugins.t': '플러그인',
    'f.plugins.d': '샌드박스에서 실행되는 탭, 작업, 페이지. 각각 보안 검사 후 관리자가 승인합니다.',
    'tour.title': '빠른 둘러보기',
    'tour.lead': '샘플 상점 데이터로 작동하는 앱의 짧은 클립입니다.',
    'tour.query.t': '찾기와 필터',
    'tour.query.d':
      '필드 자동 완성이 되는 필터를 입력하거나 값을 클릭해 추가하세요. 결과는 표, 카드, JSON으로 페이지별로 표시됩니다.',
    'tour.aggregation.t': '단계별로 파이프라인 구성',
    'tour.aggregation.d':
      '입력하는 동안 각 단계가 샘플에 대한 출력을 보여 줍니다. 실행하거나 저장하거나 코드로 내보낼 수 있습니다.',
    'tour.schema.t': '데이터 구조 파악',
    'tour.schema.d': '모든 필드를 샘플링해 분석합니다. 유형, 존재 빈도, 값을 보여 줍니다.',
    'tour.explain.t': '쿼리가 느린 이유 확인',
    'tour.explain.d':
      '쿼리 계획을 트리로 보여 주며, 컬렉션 전체를 읽은 단계와 도움이 될 인덱스를 알려 줍니다.',
    'tour.palette.t': '모든 것이 키 하나로',
    'tour.palette.d': '명령 팔레트(Ctrl+K)에서 모든 명령, 컬렉션, 설정을 찾을 수 있습니다.',
    'tour.performance.t': '서버를 실시간으로 확인',
    'tour.performance.d': '작업, 연결, 네트워크, 메모리를 실시간과 7일 기록으로 보여 주며 알림도 제공합니다.',
    'tour.play': '클립 재생',
    'tour.pause': '클립 일시 정지',
    'shots.title': '스크린샷',
    'shots.lead': '이 페이지의 테마로 표시됩니다. 하나를 선택하면 크게 볼 수 있습니다.',
    'shots.documents': '필터와 원클릭 제안이 있는 표 형식의 문서',
    'shots.aggregation': '단계마다 미리 보기가 있는 집계 파이프라인',
    'shots.schema': '샘플링한 컬렉션의 스키마',
    'shots.explain': '왜 느린가요? 쿼리 계획',
    'shots.performance': '실시간 서버 성능',
    'shots.palette': '명령 팔레트(Ctrl+K)',
    'shots.plugins': '관리자가 하나씩 승인하는 플러그인',
    'shots.security': '팀 모드: 2단계 인증 규칙, 세션, 패널 접근, 로그인 차단',
    'security.title': '설계부터 비공개와 보안',
    'security.lead': 'Mongo Manager는 당신의 컴퓨터나 서버에서 실행되며 당신이 설정한 대상과만 통신합니다.',
    'security.p1':
      '완전히 오프라인으로 작동: 원격 측정, CDN, 외부 글꼴이 없으며, 관리자가 하루 한 번 확인을 켜지 않는 한 업데이트도 확인하지 않습니다.',
    'security.p2': '비밀번호와 키는 암호화되어 저장되며 다시 표시되지 않고 로그에도 절대 기록되지 않습니다.',
    'security.p3':
      '개인 데이터 규칙이 볼 수 없는 사람에게서 필드를 숨깁니다. 문서, 내보내기, 백업, AI 도우미 어디에서나.',
    'security.p4': '팀 모드에서는 2단계 로그인, 로그인 차단, 패널의 주소 허용 목록.',
    'security.p5': '모든 변경을 남기는 추가 전용 감사 로그.',
    'security.p6': '플러그인은 샌드박스에서 실행되며, 관리자가 승인한 뒤에만 사용됩니다.',
    'security.p7':
      '업데이트는 서명되어 있습니다. Mongo Manager의 키로 서명된 릴리스만 설치하고, 시작할 때마다 모든 파일을 다시 확인하며, 시작되지 않는 버전은 롤백합니다.',
    'install.title': '설치',
    'install.lead':
      '하나를 고르세요. 모든 릴리스에 SHA-256 체크섬이 포함되어 있어 네트워크와 분리된 컴퓨터에서도 쓸 수 있습니다.',
    'install.copy': '복사',
    'install.copied': '복사됨',
    'install.npm.note': 'Node.js 24 이상이 필요합니다. 계속 쓰려면: npm install --global @mongo-manager/app.',
    'install.docker.note': '데이터는 mm-data 볼륨에 남습니다.',
    'install.binary.tab': '실행 파일',
    'install.binary.d':
      '최신 릴리스에서 시스템에 맞는 파일을 내려받아 실행하세요: Linux x64와 arm64, Windows x64, macOS arm64. 자체 런타임과 웹 앱이 들어 있습니다.',
    'install.binary.link': '최신 릴리스',
    'install.then':
      '그런 다음 <code>http://127.0.0.1:4321</code>을 여세요. 팀으로 쓰려면 <code>--auth</code>로 시작하세요. 처음 시작할 때 일회용 설정 토큰이 출력됩니다.',
    'install.update':
      '이후 버전은 Mongo Manager 정보 페이지에서 받습니다. 관리자가 확인하고 업데이트를 누릅니다.',
    'faq.title': '자주 묻는 질문',
    'faq.q1': '무료인가요?',
    'faq.a1':
      '네, 비상업적 용도라면 무료입니다. Mongo Manager는 크리에이티브 커먼즈 BY-NC-SA 4.0 라이선스를 따릅니다. 저작자를 표시하면 사용·공유·변경할 수 있으며, 상업적 목적으로는 쓸 수 없고 변경한 내용은 같은 라이선스로 공유해야 합니다.',
    'faq.q2': '내 데이터를 어딘가로 보내나요?',
    'faq.a2':
      '아니요. 앱은 다른 사이트에서 아무것도 불러오지 않으며, 서버는 MongoDB 배포와 SSH 호스트, 그리고 당신이 켠 AI 제공자, 백업 대상, 플러그인 설치 경로, 업데이트 확인에만 연결합니다.',
    'faq.q3': '어떤 MongoDB 버전을 지원하나요?',
    'faq.a3': 'MongoDB 6.0 이상: 단일 서버, 레플리카 세트, mongos를 통한 샤딩 클러스터, Atlas.',
    'faq.q4': '팀에서 쓸 수 있나요?',
    'faq.a4':
      '네. --auth로 시작하면 팀 모드가 됩니다. 관리자, 편집자, 뷰어 역할의 계정, 연결별 접근, 2단계 로그인을 쓸 수 있습니다.',
    'faq.q5': 'AI 제공자가 필요한가요?',
    'faq.a5':
      '아니요. 도우미는 선택 사항입니다. 켜면 Anthropic, Google Gemini, OpenAI 호환 서버 또는 자체 네트워크의 Ollama와 함께 작동합니다.',
    'faq.q6': '어떤 언어를 지원하나요?',
    'faq.a6':
      '10개 언어: 영어, 터키어, 중국어 간체, 일본어, 스페인어, 브라질 포르투갈어, 한국어, 독일어, 프랑스어, 러시아어.',
    'faq.q7': '어떻게 업데이트하나요?',
    'faq.a7':
      'Mongo Manager 정보 페이지에서 합니다. 관리자가 지금 확인을 누르거나 하루 한 번 확인을 켜고, 업데이트로 새 버전을 설치합니다. npm 패키지, 단독 실행 파일, 서비스, Docker 모두 스스로 업데이트하며, 더 새로운 Docker 이미지가 필요한 릴리스는 실행할 docker pull을 알려 줍니다. 이렇게 하는 첫 버전은 1.1.0이니 한 번만 직접 설치하세요.',
    'footer.license': 'CC BY-NC-SA 4.0 라이선스',
    'footer.source': '소스 코드',
    'footer.trademark':
      'MongoDB는 MongoDB, Inc.의 상표입니다. Mongo Manager는 MongoDB, Inc.와 관련이 없습니다.',
    'lb.label': '스크린샷',
    'lb.close': '닫기',
    'lb.prev': '이전',
    'lb.next': '다음',
    'lb.open': '크게 보기: {caption}',
  },
  de: {
    'nav.ai': 'KI',
    'ai.title': 'Ein KI-Agent für Ihre Datenbanken',
    'ai.lead':
      'Fragen Sie in Ihren eigenen Worten. Der Agent arbeitet mit Ihren Verbindungen beim Namen, liest, was er braucht, und legt jede Änderung auf eine Karte, die Sie bestätigen.',
    'ai.p1':
      'Antworten aus Ihren Daten: Er schreibt und startet die Abfrage oder Pipeline und zeigt jeden Schritt.',
    'ai.p2':
      'Änderungen, die Sie bestätigen: Collections, Dokumente, Indizes, Backups, Zeitpläne und Benutzer, jede auf ihrer eigenen Karte. Lehnen Sie ab, wird nichts geschrieben.',
    'ai.p3':
      'Ihr Anbieter: Anthropic, Google Gemini, jeder OpenAI-kompatible Server oder Ollama in Ihrem eigenen Netz.',
    'ai.p4':
      'Ihre Regeln: Personenbezogene Daten bleiben ihm verborgen, jede Verbindung hat ihre eigene KI-Richtlinie, und jede Anfrage bleibt mit ihren Tokens in Ihrem Verlauf.',
    'tour.ai.t': 'Den KI-Agenten fragen',
    'tour.ai.d':
      'Er antwortet aus Ihren Daten — und schreibt und startet dafür die nötige Abfrage oder Pipeline — und schlägt jede Änderung auf einer Karte vor: bestätigen, oder ablehnen, und nichts wird geschrieben.',
    'shots.ai-agent': 'Der KI-Agent: eine Antwort aus den Daten und ein Index, der auf Bestätigung wartet',
    'meta.title': 'Mongo Manager — ein sicherer MongoDB-Manager im Browser',
    'meta.description':
      'Ein selbst gehosteter MongoDB-Manager, der vollständig offline arbeitet: Dokumente, Aggregationen, Schema, Leistung, Backups, Teamzugriff und ein KI-Assistent, in zehn Sprachen. Kostenlos für nicht kommerzielle Nutzung.',
    'a11y.skip': 'Zum Inhalt springen',
    'a11y.nav': 'Hauptmenü',
    'a11y.lang': 'Sprache',
    'a11y.github': 'Mongo Manager auf GitHub',
    'a11y.theme': 'Design: {mode}',
    'theme.auto': 'automatisch',
    'theme.light': 'hell',
    'theme.dark': 'dunkel',
    'nav.features': 'Funktionen',
    'nav.tour': 'Rundgang',
    'nav.screens': 'Screenshots',
    'nav.security': 'Sicherheit',
    'nav.install': 'Installation',
    'nav.faq': 'FAQ',
    'hero.eyebrow': 'Selbst gehostet · Arbeitet offline · Kostenlos für nicht kommerzielle Nutzung',
    'hero.title': 'Ihr MongoDB, im Browser.',
    'hero.lead':
      'Dokumente durchsuchen und bearbeiten, Aggregationen bauen, das Schema lesen, sehen, warum eine Abfrage langsam ist, und Ihre Server beobachten — in einer App, die Sie selbst betreiben, ohne dass etwas anderswohin gesendet wird.',
    'hero.install': 'Installieren',
    'hero.github': 'Auf GitHub ansehen',
    'hero.meta':
      'CC BY-NC-SA 4.0-Lizenz · Node.js 24+, eine eigenständige Datei oder Docker · MongoDB 6.0 und neuer',
    'release.info': 'Aktuell: v{v} · {date}',
    'features.title': 'Alles, was Sie für die Arbeit mit MongoDB brauchen',
    'features.lead': 'Vom schnellen Blick in eine Collection bis zum Betrieb der Datenbanken eines Teams.',
    'f.documents.t': 'Durchsuchen und bearbeiten',
    'f.documents.d':
      'Tabellen-, Karten- und JSON-Ansicht; Zellbearbeitung, die nur Geändertes schreibt; Massenänderungen mit Vorschau vor dem Ausführen.',
    'f.query.t': 'Abfragen mit Hilfe',
    'f.query.d':
      'Feldvervollständigung, ein grafischer Filterbaukasten, Collation und Hints; ein find als Shell-Befehl kopiert oder als Code exportiert.',
    'f.aggregation.t': 'Aggregations-Baukasten',
    'f.aggregation.d':
      'Stufenkarten mit einer Live-Vorschau jeder Stufe, ein Textmodus und Export in acht Sprachen.',
    'f.schema.t': 'Schema und Indizes',
    'f.schema.d':
      'Eine Stichprobenanalyse jedes Felds, die Nutzung der Indizes sowie Atlas-Search- und Vector-Search-Indizes.',
    'f.explain.t': 'Warum ist es langsam?',
    'f.explain.d':
      'Der Abfrageplan als Baum mit Warnungen, und der Index, der helfen würde, schon ausgefüllt.',
    'f.performance.t': 'Leistung und Warnungen',
    'f.performance.d':
      'Live-Diagramme mit sieben Tagen Verlauf, langsame Abfragen, Index-Empfehlungen und Warnungen per E-Mail oder Webhook.',
    'f.shell.t': 'Erweiterte Shell',
    'f.shell.d': 'Die Laufzeit von mongosh in einem Tab, abgeschottet, jeder Befehl protokolliert.',
    'f.transfer.t': 'Import, Export und Abgleich',
    'f.transfer.d':
      'CSV, JSON, Excel und SQL-Dumps; kopieren, vergleichen und live abgleichen zwischen Servern.',
    'f.backup.t': 'Backups',
    'f.backup.d':
      'mongodump-Archive oder verschlüsselte Dateien, geplant und an S3, Google Drive, WebDAV oder einen Ordner gesendet.',
    'f.ai.t': 'KI-Assistent',
    'f.ai.d':
      'Abfragen, Pipelines und Erklärungen aus Ihren Worten, mit Ihrem eigenen Anbieter; jede Änderung fragt zuerst.',
    'f.team.t': 'Für Teams gemacht',
    'f.team.d':
      'Rollen und Zugriff pro Verbindung, Zwei-Faktor-Anmeldung, Panelzugriff nach Adresse und ein Audit-Log.',
    'f.plugins.t': 'Plugins',
    'f.plugins.d':
      'Abgeschottete Tabs, Aktionen und Seiten, jede nach einer Sicherheitsprüfung von einem Administrator freigegeben.',
    'tour.title': 'Ein kurzer Rundgang',
    'tour.lead': 'Kurze Clips der App bei der Arbeit an einem Beispielshop.',
    'tour.query.t': 'Finden und filtern',
    'tour.query.d':
      'Geben Sie einen Filter mit Feldvervollständigung ein oder klicken Sie auf einen Wert, um ihn hinzuzufügen; die Ergebnisse erscheinen seitenweise als Tabelle, Karten oder JSON.',
    'tour.aggregation.t': 'Pipelines Stufe für Stufe aufbauen',
    'tour.aggregation.d':
      'Jede Stufe zeigt schon beim Tippen ihre Ausgabe auf einer Stichprobe; ausführen, speichern oder als Code exportieren.',
    'tour.schema.t': 'Die Struktur Ihrer Daten kennen',
    'tour.schema.d': 'Eine Stichprobenanalyse jedes Felds: seine Typen, wie oft es vorkommt und seine Werte.',
    'tour.explain.t': 'Sehen, warum eine Abfrage langsam ist',
    'tour.explain.d':
      'Der Abfrageplan als Baum, mit dem Schritt, der die ganze Collection gelesen hat, und dem Index, der helfen würde.',
    'tour.palette.t': 'Alles nur einen Tastendruck entfernt',
    'tour.palette.d':
      'Die Befehlspalette (Ctrl+K) findet jeden Befehl, jede Collection und jede Einstellung.',
    'tour.performance.t': 'Den Server live beobachten',
    'tour.performance.d':
      'Operationen, Verbindungen, Netzwerk und Speicher, live und über sieben Tage, mit Warnungen.',
    'tour.play': 'Clip abspielen',
    'tour.pause': 'Clip anhalten',
    'shots.title': 'Screenshots',
    'shots.lead': 'Im Design dieser Seite gezeigt; wählen Sie einen aus, um ihn zu vergrößern.',
    'shots.documents': 'Dokumente in einer Tabelle, mit einem Filter und Vorschlägen per Klick',
    'shots.aggregation': 'Eine Aggregations-Pipeline mit einer Vorschau jeder Stufe',
    'shots.schema': 'Das Schema einer Collection aus einer Stichprobe',
    'shots.explain': 'Warum ist es langsam? Der Abfrageplan',
    'shots.performance': 'Die Leistung des Servers, live',
    'shots.palette': 'Die Befehlspalette (Ctrl+K)',
    'shots.plugins': 'Plugins, jedes von einem Administrator freigegeben',
    'shots.security':
      'Teammodus: Regeln für die Zwei-Faktor-Anmeldung, Sitzungen, Panelzugriff und Anmeldesperren',
    'security.title': 'Von Grund auf privat und sicher',
    'security.lead':
      'Mongo Manager läuft auf Ihrem Rechner oder Ihrem Server und spricht nur mit dem, was Sie einrichten.',
    'security.p1':
      'Arbeitet vollständig offline: keine Telemetrie, kein CDN und keine externen Schriften, und keine Update-Prüfung, solange kein Administrator die tägliche einschaltet.',
    'security.p2':
      'Passwörter und Schlüssel werden verschlüsselt gespeichert, nie wieder angezeigt und nie in Logs geschrieben.',
    'security.p3':
      'Regeln für personenbezogene Daten verbergen Felder vor allen, die sie nicht sehen dürfen — in Dokumenten, Exporten, Backups und im KI-Assistenten.',
    'security.p4':
      'Im Teammodus: Zwei-Faktor-Anmeldung, Anmeldesperren und eine Adress-Freigabeliste für das Panel.',
    'security.p5': 'Ein Audit-Log jeder Änderung, an das nur angefügt wird.',
    'security.p6': 'Plugins laufen abgeschottet, und erst nachdem ein Administrator sie freigegeben hat.',
    'security.p7':
      'Updates sind signiert: Installiert wird nur eine Version, die mit dem Schlüssel von Mongo Manager signiert ist, bei jedem Start wird jede Datei erneut geprüft, und eine Version, die nicht startet, wird zurückgenommen.',
    'install.title': 'Installation',
    'install.lead':
      'Wählen Sie einen Weg. Jede Version liefert SHA-256-Prüfsummen mit, so funktioniert sie auch auf einem Rechner ohne Netz.',
    'install.copy': 'Kopieren',
    'install.copied': 'Kopiert',
    'install.npm.note':
      'Braucht Node.js 24 oder neuer. Dauerhaft installieren: npm install --global @mongo-manager/app.',
    'install.docker.note': 'Ihre Daten bleiben im Volume mm-data.',
    'install.binary.tab': 'Datei',
    'install.binary.d':
      'Laden Sie die Datei für Ihr System aus der neuesten Version herunter und starten Sie sie: Linux x64 und arm64, Windows x64, macOS arm64. Sie bringt ihre eigene Laufzeit und die Web-App mit.',
    'install.binary.link': 'Neueste Version',
    'install.then':
      'Öffnen Sie dann <code>http://127.0.0.1:4321</code>. Für ein Team starten Sie mit <code>--auth</code>: Der erste Start gibt ein einmaliges Einrichtungstoken aus.',
    'install.update':
      'Spätere Versionen kommen über die Seite „Über Mongo Manager“: Ein Administrator prüft und klickt auf Aktualisieren.',
    'faq.title': 'Fragen',
    'faq.q1': 'Ist es kostenlos?',
    'faq.a1':
      'Ja, für nicht kommerzielle Nutzung. Mongo Manager steht unter Creative Commons BY-NC-SA 4.0: Sie dürfen es mit Namensnennung nutzen, teilen und bearbeiten, nicht für kommerzielle Zwecke, und Ihre Änderungen unter derselben Lizenz weitergeben.',
    'faq.q2': 'Sendet es meine Daten irgendwohin?',
    'faq.a2':
      'Nein. Die App lädt nichts von anderen Websites, und der Server erreicht nur Ihre MongoDB-Deployments und SSH-Hosts sowie die KI-Anbieter, Backup-Ziele, Plugin-Installationen und die Update-Prüfung, die Sie einschalten.',
    'faq.q3': 'Welche MongoDB-Versionen werden unterstützt?',
    'faq.a3': 'MongoDB 6.0 und neuer: einzelne Server, Replica Sets, Sharded Cluster über mongos und Atlas.',
    'faq.q4': 'Kann mein Team es nutzen?',
    'faq.a4':
      'Ja. Mit --auth starten Sie den Teammodus: Konten mit den Rollen Administrator, Bearbeiter und Betrachter, Zugriff pro Verbindung und Zwei-Faktor-Anmeldung.',
    'faq.q5': 'Brauche ich einen KI-Anbieter?',
    'faq.a5':
      'Nein. Der Assistent ist optional; eingeschaltet arbeitet er mit Anthropic, Google Gemini, jedem OpenAI-kompatiblen Server oder Ollama in Ihrem eigenen Netz.',
    'faq.q6': 'Welche Sprachen spricht es?',
    'faq.a6':
      'Zehn: Englisch, Türkisch, vereinfachtes Chinesisch, Japanisch, Spanisch, brasilianisches Portugiesisch, Koreanisch, Deutsch, Französisch und Russisch.',
    'faq.q7': 'Wie aktualisiere ich es?',
    'faq.a7':
      'Auf der Seite „Über Mongo Manager“. Ein Administrator klickt auf Jetzt prüfen oder schaltet die tägliche Prüfung ein und installiert die neue Version mit Aktualisieren: npm-Paket, eigenständiges Programm, Dienst und Docker aktualisieren sich selbst, und eine Version, die ein neueres Docker-Image braucht, nennt das passende docker pull. 1.1.0 ist die erste Version, die das kann: Installieren Sie sie einmal von Hand.',
    'footer.license': 'CC BY-NC-SA 4.0-Lizenz',
    'footer.source': 'Quellcode',
    'footer.trademark':
      'MongoDB ist eine Marke von MongoDB, Inc. Mongo Manager steht in keiner Verbindung zu MongoDB, Inc.',
    'lb.label': 'Screenshot',
    'lb.close': 'Schließen',
    'lb.prev': 'Zurück',
    'lb.next': 'Weiter',
    'lb.open': 'Vergrößern: {caption}',
  },
  fr: {
    'nav.ai': 'IA',
    'ai.title': 'Un agent IA pour vos bases de données',
    'ai.lead':
      'Demandez-le avec vos mots. L’agent travaille avec vos connexions par leur nom, lit ce qu’il lui faut et place chaque changement sur une carte que vous confirmez.',
    'ai.p1':
      'Des réponses tirées de vos données : il écrit et lance la requête ou le pipeline, et montre chaque étape.',
    'ai.p2':
      'Des changements que vous confirmez : collections, documents, index, sauvegardes, planifications et utilisateurs, chacun sur sa carte. Refusez, et rien n’est écrit.',
    'ai.p3':
      'Votre fournisseur : Anthropic, Google Gemini, tout serveur compatible OpenAI ou Ollama sur votre propre réseau.',
    'ai.p4':
      'Vos règles : les données personnelles lui restent masquées, chaque connexion a sa propre politique d’IA, et chaque demande reste dans votre historique avec ses jetons.',
    'tour.ai.t': 'Demander à l’agent IA',
    'tour.ai.d':
      'Il répond à partir de vos données — en écrivant et en lançant la requête ou le pipeline nécessaire — et propose chaque changement sur une carte : confirmez-le, ou refusez et rien n’est écrit.',
    'shots.ai-agent': 'L’agent IA : une réponse tirée des données et un index en attente de confirmation',
    'meta.title': 'Mongo Manager — un gestionnaire MongoDB sûr dans votre navigateur',
    'meta.description':
      'Un gestionnaire MongoDB auto-hébergé qui fonctionne entièrement hors ligne : documents, agrégations, schéma, performances, sauvegardes, accès en équipe et un assistant IA, en dix langues. Gratuit pour un usage non commercial.',
    'a11y.skip': 'Aller au contenu',
    'a11y.nav': 'Menu principal',
    'a11y.lang': 'Langue',
    'a11y.github': 'Mongo Manager sur GitHub',
    'a11y.theme': 'Thème : {mode}',
    'theme.auto': 'automatique',
    'theme.light': 'clair',
    'theme.dark': 'sombre',
    'nav.features': 'Fonctions',
    'nav.tour': 'Visite',
    'nav.screens': 'Captures',
    'nav.security': 'Sécurité',
    'nav.install': 'Installation',
    'nav.faq': 'FAQ',
    'hero.eyebrow': 'Auto-hébergé · Fonctionne hors ligne · Gratuit pour un usage non commercial',
    'hero.title': 'Votre MongoDB, dans votre navigateur.',
    'hero.lead':
      'Parcourez et modifiez les documents, construisez des agrégations, lisez le schéma, voyez pourquoi une requête est lente et suivez vos serveurs — depuis une seule application que vous faites tourner vous-même, sans rien envoyer ailleurs.',
    'hero.install': 'Installer',
    'hero.github': 'Voir sur GitHub',
    'hero.meta':
      'Licence CC BY-NC-SA 4.0 · Node.js 24+, un binaire autonome ou Docker · MongoDB 6.0 et versions ultérieures',
    'release.info': 'Dernière version : v{v} · {date}',
    'features.title': 'Tout ce qu’il faut pour travailler avec MongoDB',
    'features.lead': 'D’un coup d’œil à une collection jusqu’aux bases de données de toute une équipe.',
    'f.documents.t': 'Parcourir et modifier',
    'f.documents.d':
      'Vues tableau, cartes et JSON ; modifications en ligne qui n’écrivent que ce qui a changé ; mises à jour en masse prévisualisées avant de s’exécuter.',
    'f.query.t': 'Des requêtes assistées',
    'f.query.d':
      'Complétion des champs, un constructeur de filtres visuel, collation et hints ; un find copié en commande shell ou exporté en code.',
    'f.aggregation.t': 'Constructeur d’agrégations',
    'f.aggregation.d':
      'Des cartes d’étapes avec l’aperçu en direct de chacune, un mode texte, et l’export vers huit langages.',
    'f.schema.t': 'Schéma et index',
    'f.schema.d':
      'Une analyse par échantillon de chaque champ, l’usage des index, et les index Atlas Search et Vector Search.',
    'f.explain.t': 'Pourquoi est-ce lent ?',
    'f.explain.d':
      'Le plan de la requête sous forme d’arbre avec des avertissements, et l’index qui aiderait, prérempli.',
    'f.performance.t': 'Performances et alertes',
    'f.performance.d':
      'Des graphiques en direct avec sept jours d’historique, les requêtes lentes, des conseils d’index et des alertes par e-mail ou webhook.',
    'f.shell.t': 'Shell avancé',
    'f.shell.d': 'L’environnement de mongosh dans un onglet, isolé, chaque commande étant auditée.',
    'f.transfer.t': 'Importer, exporter, synchroniser',
    'f.transfer.d':
      'CSV, JSON, Excel et dumps SQL ; copier, comparer et synchroniser en direct entre serveurs.',
    'f.backup.t': 'Sauvegardes',
    'f.backup.d':
      'Archives mongodump ou fichiers chiffrés, planifiés, et envoyés vers S3, Google Drive, WebDAV ou un dossier.',
    'f.ai.t': 'Assistant IA',
    'f.ai.d':
      'Requêtes, pipelines et explications à partir de vos mots, avec votre propre fournisseur ; chaque changement demande d’abord.',
    'f.team.t': 'Pensé pour les équipes',
    'f.team.d':
      'Rôles et accès par connexion, connexion à double authentification, accès au panneau par adresse, et un journal d’audit.',
    'f.plugins.t': 'Plug-ins',
    'f.plugins.d':
      'Des onglets, actions et pages isolés, chacun approuvé par un administrateur après une analyse de sécurité.',
    'tour.title': 'Une visite rapide',
    'tour.lead': 'De courts extraits de l’application au travail sur une boutique d’exemple.',
    'tour.query.t': 'Trouver et filtrer',
    'tour.query.d':
      'Saisissez un filtre avec complétion des champs ou cliquez sur une valeur pour l’ajouter ; les résultats s’affichent page par page en tableau, en cartes ou en JSON.',
    'tour.aggregation.t': 'Construire un pipeline étape par étape',
    'tour.aggregation.d':
      'Chaque étape montre sa sortie sur un échantillon pendant la saisie ; exécutez-le, enregistrez-le ou exportez-le en code.',
    'tour.schema.t': 'Connaître la forme de vos données',
    'tour.schema.d': 'Une analyse par échantillon de chaque champ : ses types, sa fréquence et ses valeurs.',
    'tour.explain.t': 'Voir pourquoi une requête est lente',
    'tour.explain.d':
      'Le plan de la requête sous forme d’arbre, avec l’étape qui a lu toute la collection et l’index qui aiderait.',
    'tour.palette.t': 'Tout à portée de clavier',
    'tour.palette.d':
      'La palette de commandes (Ctrl+K) trouve n’importe quelle commande, collection ou réglage.',
    'tour.performance.t': 'Suivre le serveur en direct',
    'tour.performance.d':
      'Opérations, connexions, réseau et mémoire, en direct et sur sept jours, avec des alertes.',
    'tour.play': 'Lire l’extrait',
    'tour.pause': 'Mettre l’extrait en pause',
    'shots.title': 'Captures d’écran',
    'shots.lead': 'Affichées dans le thème de cette page ; choisissez-en une pour l’agrandir.',
    'shots.documents': 'Les documents dans un tableau, avec un filtre et des suggestions en un clic',
    'shots.aggregation': 'Un pipeline d’agrégation, chaque étape prévisualisée',
    'shots.schema': 'Le schéma d’une collection échantillonnée',
    'shots.explain': 'Pourquoi est-ce lent ? Le plan de la requête',
    'shots.performance': 'Les performances du serveur en direct',
    'shots.palette': 'La palette de commandes (Ctrl+K)',
    'shots.plugins': 'Des plug-ins, chacun approuvé par un administrateur',
    'shots.security':
      'Mode équipe : règles de double authentification, sessions, accès au panneau et blocages de connexion',
    'security.title': 'Privé et sûr dès la conception',
    'security.lead':
      'Mongo Manager tourne sur votre machine ou votre serveur et ne parle qu’à ce que vous configurez.',
    'security.p1':
      'Fonctionne entièrement hors ligne : ni télémétrie, ni CDN, ni polices externes, et aucune vérification de mises à jour tant qu’un administrateur n’active pas la vérification quotidienne.',
    'security.p2':
      'Les mots de passe et les clés sont chiffrés au repos, jamais réaffichés et jamais écrits dans les journaux.',
    'security.p3':
      'Les règles de données personnelles masquent des champs à ceux qui ne doivent pas les voir — dans les documents, les exports, les sauvegardes et l’assistant IA.',
    'security.p4':
      'En mode équipe : connexion à double authentification, blocages de connexion et une liste d’adresses autorisées pour le panneau.',
    'security.p5': 'Un journal d’audit de chaque changement, en ajout seul.',
    'security.p6':
      'Les plug-ins tournent dans un bac à sable, et seulement après qu’un administrateur les a approuvés.',
    'security.p7':
      'Les mises à jour sont signées : seule une version signée avec la clé de Mongo Manager est installée, chaque fichier est vérifié à nouveau à chaque démarrage, et une version qui ne démarre pas est annulée.',
    'install.title': 'Installation',
    'install.lead':
      'Choisissez une méthode. Chaque version fournit des sommes de contrôle SHA-256, et fonctionne donc aussi sur une machine isolée du réseau.',
    'install.copy': 'Copier',
    'install.copied': 'Copié',
    'install.npm.note':
      'Nécessite Node.js 24 ou ultérieur. Pour le garder installé : npm install --global @mongo-manager/app.',
    'install.docker.note': 'Vos données restent dans le volume mm-data.',
    'install.binary.tab': 'Binaire',
    'install.binary.d':
      'Téléchargez le fichier de votre système dans la dernière version et lancez-le : Linux x64 et arm64, Windows x64, macOS arm64. Il embarque son propre environnement d’exécution et l’application web.',
    'install.binary.link': 'Dernière version',
    'install.then':
      'Ouvrez ensuite <code>http://127.0.0.1:4321</code>. Pour une équipe, lancez-le avec <code>--auth</code> : le premier démarrage affiche un jeton d’installation à usage unique.',
    'install.update':
      'Les versions suivantes arrivent par la page À propos de Mongo Manager : un administrateur vérifie et clique sur Mettre à jour.',
    'faq.title': 'Questions',
    'faq.q1': 'Est-ce gratuit ?',
    'faq.a1':
      'Oui, pour un usage non commercial. Mongo Manager est sous licence Creative Commons BY-NC-SA 4.0 : vous pouvez l’utiliser, le partager et l’adapter en citant l’auteur, sans but commercial, et en partageant vos modifications sous la même licence.',
    'faq.q2': 'Envoie-t-il mes données quelque part ?',
    'faq.a2':
      'Non. L’application ne charge rien depuis d’autres sites, et le serveur ne joint que vos déploiements MongoDB et vos hôtes SSH, ainsi que les fournisseurs d’IA, destinations de sauvegarde, installations de plug-ins et la vérification des mises à jour que vous activez.',
    'faq.q3': 'Quelles versions de MongoDB sont prises en charge ?',
    'faq.a3':
      'MongoDB 6.0 et ultérieures : serveurs autonomes, jeux de réplicas, clusters partitionnés via mongos, et Atlas.',
    'faq.q4': 'Mon équipe peut-elle l’utiliser ?',
    'faq.a4':
      'Oui. Lancez-le avec --auth pour le mode équipe : comptes avec les rôles administrateur, éditeur et lecteur, accès par connexion et connexion à double authentification.',
    'faq.q5': 'Faut-il un fournisseur d’IA ?',
    'faq.a5':
      'Non. L’assistant est facultatif ; activé, il fonctionne avec Anthropic, Google Gemini, tout serveur compatible OpenAI ou Ollama sur votre propre réseau.',
    'faq.q6': 'Quelles langues parle-t-il ?',
    'faq.a6':
      'Dix : anglais, turc, chinois simplifié, japonais, espagnol, portugais du Brésil, coréen, allemand, français et russe.',
    'faq.q7': 'Comment le mettre à jour ?',
    'faq.a7':
      'Depuis la page À propos de Mongo Manager. Un administrateur clique sur Vérifier maintenant ou active la vérification quotidienne, puis installe la nouvelle version avec Mettre à jour : le paquet npm, le binaire autonome, un service et Docker se mettent à jour eux-mêmes, et une version qui a besoin d’une image Docker plus récente indique quel docker pull lancer. La 1.1.0 est la première à le faire : installez-la une fois à la main.',
    'footer.license': 'Licence CC BY-NC-SA 4.0',
    'footer.source': 'Code source',
    'footer.trademark':
      'MongoDB est une marque de MongoDB, Inc. Mongo Manager n’est pas affilié à MongoDB, Inc.',
    'lb.label': 'Capture d’écran',
    'lb.close': 'Fermer',
    'lb.prev': 'Précédente',
    'lb.next': 'Suivante',
    'lb.open': 'Agrandir : {caption}',
  },
  ru: {
    'nav.ai': 'ИИ',
    'ai.title': 'ИИ-агент для ваших баз данных',
    'ai.lead':
      'Просите своими словами. Агент работает с вашими подключениями по их именам, читает то, что нужно, и выносит каждое изменение на карточку, которую подтверждаете вы.',
    'ai.p1':
      'Ответы по вашим данным: он сам пишет и выполняет запрос или конвейер и показывает каждый свой шаг.',
    'ai.p2':
      'Изменения с вашего подтверждения: коллекции, документы, индексы, резервные копии, расписания и пользователи — каждое на своей карточке. Отклоните, и ничего не будет записано.',
    'ai.p3':
      'Ваш провайдер: Anthropic, Google Gemini, любой OpenAI-совместимый сервер или Ollama в вашей собственной сети.',
    'ai.p4':
      'Ваши правила: персональные данные остаются от него скрыты, у каждого подключения своя политика ИИ, а каждый запрос хранится в вашей истории вместе с числом токенов.',
    'tour.ai.t': 'Спросите ИИ-агента',
    'tour.ai.d':
      'Он отвечает по вашим данным — сам пишет и выполняет нужный запрос или конвейер — и предлагает каждое изменение на карточке: подтвердите его или отклоните, и ничего не будет записано.',
    'shots.ai-agent': 'ИИ-агент: ответ по данным и индекс, ожидающий подтверждения',
    'meta.title': 'Mongo Manager — безопасный менеджер MongoDB в браузере',
    'meta.description':
      'Самостоятельно размещаемый менеджер MongoDB, который полностью работает офлайн: документы, агрегации, схема, производительность, резервные копии, командный доступ и ИИ-помощник, на десяти языках. Бесплатно для некоммерческого использования.',
    'a11y.skip': 'Перейти к содержимому',
    'a11y.nav': 'Главное меню',
    'a11y.lang': 'Язык',
    'a11y.github': 'Mongo Manager на GitHub',
    'a11y.theme': 'Тема: {mode}',
    'theme.auto': 'автоматическая',
    'theme.light': 'светлая',
    'theme.dark': 'темная',
    'nav.features': 'Возможности',
    'nav.tour': 'Обзор',
    'nav.screens': 'Снимки',
    'nav.security': 'Безопасность',
    'nav.install': 'Установка',
    'nav.faq': 'Вопросы',
    'hero.eyebrow': 'Свой сервер · Работает офлайн · Бесплатно для некоммерческого использования',
    'hero.title': 'Ваша MongoDB — в браузере.',
    'hero.lead':
      'Просматривайте и редактируйте документы, стройте агрегации, читайте схему, выясняйте, почему запрос медленный, и следите за серверами — в одном приложении, которое вы запускаете сами, ничего никуда не отправляя.',
    'hero.install': 'Установить',
    'hero.github': 'Открыть на GitHub',
    'hero.meta':
      'Лицензия CC BY-NC-SA 4.0 · Node.js 24+, отдельный исполняемый файл или Docker · MongoDB 6.0 и новее',
    'release.info': 'Последняя версия: v{v} · {date}',
    'features.title': 'Все, что нужно для работы с MongoDB',
    'features.lead': 'От быстрого взгляда на коллекцию до управления базами данных команды.',
    'f.documents.t': 'Просмотр и правка',
    'f.documents.d':
      'Таблица, карточки и JSON; правка в ячейках, которая записывает только изменения; массовые обновления с предпросмотром до запуска.',
    'f.query.t': 'Запросы с подсказками',
    'f.query.d':
      'Автодополнение полей, визуальный конструктор фильтров, collation и hint; find можно скопировать как команду оболочки или экспортировать в код.',
    'f.aggregation.t': 'Конструктор агрегаций',
    'f.aggregation.d':
      'Карточки этапов с живым предпросмотром каждого, текстовый режим и экспорт на восемь языков.',
    'f.schema.t': 'Схема и индексы',
    'f.schema.d':
      'Анализ каждого поля по выборке, использование индексов, индексы Atlas Search и Vector Search.',
    'f.explain.t': 'Почему медленно?',
    'f.explain.d': 'План запроса в виде дерева с предупреждениями и уже заполненный индекс, который поможет.',
    'f.performance.t': 'Производительность и оповещения',
    'f.performance.d':
      'Живые графики с историей за семь дней, медленные запросы, советы по индексам и оповещения по почте или через webhook.',
    'f.shell.t': 'Расширенная оболочка',
    'f.shell.d': 'Среда mongosh во вкладке, в песочнице, каждая команда записывается в журнал аудита.',
    'f.transfer.t': 'Импорт, экспорт и синхронизация',
    'f.transfer.d':
      'CSV, JSON, Excel и дампы SQL; копирование, сравнение и живая синхронизация между серверами.',
    'f.backup.t': 'Резервные копии',
    'f.backup.d':
      'Архивы mongodump или зашифрованные файлы по расписанию, с отправкой в S3, Google Drive, WebDAV или папку.',
    'f.ai.t': 'ИИ-помощник',
    'f.ai.d':
      'Запросы, конвейеры и объяснения по вашим словам, с вашим собственным провайдером; каждое изменение сначала спрашивает.',
    'f.team.t': 'Для команд',
    'f.team.d':
      'Роли и доступ к каждому подключению, двухфакторный вход, доступ к панели по адресу и журнал аудита.',
    'f.plugins.t': 'Плагины',
    'f.plugins.d':
      'Вкладки, действия и страницы в песочнице; каждый плагин одобряет администратор после проверки безопасности.',
    'tour.title': 'Краткий обзор',
    'tour.lead': 'Короткие ролики приложения в работе с демонстрационным магазином.',
    'tour.query.t': 'Поиск и фильтры',
    'tour.query.d':
      'Введите фильтр с автодополнением полей или щелкните значение, чтобы добавить его; результаты выводятся постранично в виде таблицы, карточек или JSON.',
    'tour.aggregation.t': 'Конвейер по шагам',
    'tour.aggregation.d':
      'Каждый этап показывает свой результат на выборке прямо во время ввода; запустите, сохраните или экспортируйте его в код.',
    'tour.schema.t': 'Структура ваших данных',
    'tour.schema.d': 'Анализ каждого поля по выборке: его типы, как часто оно встречается и его значения.',
    'tour.explain.t': 'Почему запрос медленный',
    'tour.explain.d':
      'План запроса в виде дерева: шаг, который прочитал всю коллекцию, и индекс, который помог бы.',
    'tour.palette.t': 'Все под рукой',
    'tour.palette.d': 'Палитра команд (Ctrl+K) находит любую команду, коллекцию или настройку.',
    'tour.performance.t': 'Сервер в реальном времени',
    'tour.performance.d':
      'Операции, подключения, сеть и память в реальном времени и за семь дней, с оповещениями.',
    'tour.play': 'Воспроизвести ролик',
    'tour.pause': 'Приостановить ролик',
    'shots.title': 'Снимки экрана',
    'shots.lead': 'Показаны в теме этой страницы; выберите снимок, чтобы увеличить его.',
    'shots.documents': 'Документы в таблице, с фильтром и подсказками в один клик',
    'shots.aggregation': 'Конвейер агрегации с предпросмотром каждого этапа',
    'shots.schema': 'Схема коллекции по выборке',
    'shots.explain': 'Почему медленно? План запроса',
    'shots.performance': 'Производительность сервера в реальном времени',
    'shots.palette': 'Палитра команд (Ctrl+K)',
    'shots.plugins': 'Плагины, каждый одобрен администратором',
    'shots.security':
      'Командный режим: правила двухфакторной аутентификации, сеансы, доступ к панели и блокировки входа',
    'security.title': 'Приватность и безопасность изначально',
    'security.lead':
      'Mongo Manager работает на вашем компьютере или сервере и общается только с тем, что вы настроили.',
    'security.p1':
      'Полностью работает офлайн: без телеметрии, CDN и внешних шрифтов и без проверки обновлений, пока администратор не включит ежедневную проверку.',
    'security.p2':
      'Пароли и ключи хранятся в зашифрованном виде, больше не показываются и никогда не попадают в журналы.',
    'security.p3':
      'Правила персональных данных скрывают поля от тех, кому их видеть нельзя, — в документах, экспорте, резервных копиях и ИИ-помощнике.',
    'security.p4':
      'В командном режиме: двухфакторный вход, блокировки входа и список разрешенных адресов для панели.',
    'security.p5': 'Журнал аудита каждого изменения, в который можно только дописывать.',
    'security.p6': 'Плагины работают в песочнице и только после одобрения администратором.',
    'security.p7':
      'Обновления подписаны: устанавливается только выпуск, подписанный ключом Mongo Manager, при каждом запуске каждый файл проверяется снова, а версия, которая не запускается, откатывается.',
    'install.title': 'Установка',
    'install.lead':
      'Выберите способ. Каждая версия поставляется с контрольными суммами SHA-256, поэтому работает и на машине без сети.',
    'install.copy': 'Копировать',
    'install.copied': 'Скопировано',
    'install.npm.note':
      'Нужен Node.js 24 или новее. Чтобы установить насовсем: npm install --global @mongo-manager/app.',
    'install.docker.note': 'Ваши данные остаются в томе mm-data.',
    'install.binary.tab': 'Файл',
    'install.binary.d':
      'Скачайте файл для вашей системы из последней версии и запустите его: Linux x64 и arm64, Windows x64, macOS arm64. Он содержит собственную среду выполнения и веб-приложение.',
    'install.binary.link': 'Последняя версия',
    'install.then':
      'Затем откройте <code>http://127.0.0.1:4321</code>. Для команды запустите с <code>--auth</code>: при первом запуске будет выведен одноразовый токен настройки.',
    'install.update':
      'Следующие версии приходят со страницы «О программе Mongo Manager»: администратор проверяет и нажимает «Обновить».',
    'faq.title': 'Вопросы',
    'faq.q1': 'Это бесплатно?',
    'faq.a1':
      'Да, для некоммерческого использования. Mongo Manager распространяется по лицензии Creative Commons BY-NC-SA 4.0: его можно использовать, распространять и изменять с указанием автора, но не в коммерческих целях, а свои изменения нужно распространять на тех же условиях.',
    'faq.q2': 'Отправляет ли он мои данные куда-либо?',
    'faq.a2':
      'Нет. Приложение ничего не загружает с других сайтов, а сервер обращается только к вашим развертываниям MongoDB и SSH-хостам, а также к включенным вами ИИ-провайдерам, местам хранения резервных копий, источникам установки плагинов и проверке обновлений.',
    'faq.q3': 'Какие версии MongoDB поддерживаются?',
    'faq.a3':
      'MongoDB 6.0 и новее: отдельные серверы, наборы реплик, шардированные кластеры через mongos и Atlas.',
    'faq.q4': 'Может ли им пользоваться моя команда?',
    'faq.a4':
      'Да. Запустите с --auth для командного режима: учетные записи с ролями администратора, редактора и наблюдателя, доступ к каждому подключению и двухфакторный вход.',
    'faq.q5': 'Нужен ли ИИ-провайдер?',
    'faq.a5':
      'Нет. Помощник необязателен; если его включить, он работает с Anthropic, Google Gemini, любым OpenAI-совместимым сервером или Ollama в вашей собственной сети.',
    'faq.q6': 'На каких языках он работает?',
    'faq.a6':
      'На десяти: английском, турецком, упрощенном китайском, японском, испанском, бразильском португальском, корейском, немецком, французском и русском.',
    'faq.q7': 'Как его обновить?',
    'faq.a7':
      'На странице «О программе Mongo Manager». Администратор нажимает «Проверить сейчас» или включает ежедневную проверку и устанавливает новую версию кнопкой «Обновить»: пакет npm, автономный исполняемый файл, служба и Docker обновляются сами, а выпуск, которому нужен более новый образ Docker, подсказывает, какой docker pull выполнить. Первая версия, которая так умеет, — 1.1.0: установите ее один раз вручную.',
    'footer.license': 'Лицензия CC BY-NC-SA 4.0',
    'footer.source': 'Исходный код',
    'footer.trademark': 'MongoDB — товарный знак MongoDB, Inc. Mongo Manager не связан с MongoDB, Inc.',
    'lb.label': 'Снимок экрана',
    'lb.close': 'Закрыть',
    'lb.prev': 'Предыдущий',
    'lb.next': 'Следующий',
    'lb.open': 'Увеличить: {caption}',
  },
}
