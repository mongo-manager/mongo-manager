# Mongo Manager

[![CI](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mongo-manager/app?logo=npm)](https://www.npmjs.com/package/@mongo-manager/app) [![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](README.md) · **Türkçe** · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Português (Brasil)](README.pt.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Русский](README.ru.md)

**Tarayıcında çalışan, kendi sunucunda barındırdığın güvenli bir MongoDB yöneticisi.** Tek başına ya da ekibinle kullanırsın, yapay zekâ ajanına kendi sözlerinle iş yaptırırsın ve her şey tamamen çevrimdışı çalışır.

<p align="center">
  <img src="docs/media/demo.gif" alt="Mongo Manager kullanımda: bir filtre, aşama aşama kurulan bir toplama hattı, şema, sorgu planı, canlı performans ve koyu tema" width="880">
</p>
<p align="center"><a href="docs/media/demo.mp4">Tanıtım videosunu tam kalitede izle (MP4, 55 sn)</a></p>

<p align="center">Geliştiren: <b>Gokhan OZGEZER</b> · <a href="mailto:gokhanozgezer@gmail.com">gokhanozgezer@gmail.com</a> · <a href="https://github.com/gokhanozgezer">GitHub</a></p>

## İçindekiler

- [Neden Mongo Manager?](#neden-mongo-manager)
- [Hızlı başlangıç](#hızlı-başlangıç)
- [Öne çıkanlar](#öne-çıkanlar)
  - [Yapay zekâ ajanı](#yapay-zekâ-ajanı)
  - [Replica set](#replica-set)
  - [Sharded cluster](#sharded-cluster)
  - [Ekip, güvenlik ve denetim](#ekip-güvenlik-ve-denetim)
  - [Yedekleme, kopyalama ve canlı senkron](#yedekleme-kopyalama-ve-canlı-senkron)
  - [Kişisel verileri gizleme](#kişisel-verileri-gizleme)
- [Tüm özellikler](#tüm-özellikler)
- [Kısa tur](#kısa-tur)
- [Ekran görüntüleri](#ekran-görüntüleri)
- [Kurulum](#kurulum)
- [Kullanım](#kullanım)
- [Güvenlik](#güvenlik)
- [Geliştirme](#geliştirme)
- [Lisans](#lisans)
- [Geliştirici](#geliştirici)

## Neden Mongo Manager?

MongoDB Compass tek kişilik bir masaüstü uygulamasıdır. Mongo Manager ise bir sunucuda bir kez çalışır, ekipteki herkes tarayıcısından kullanır ve Compass'ta olmayan işleri de yapar:

|                           | Mongo Manager                                                                             | MongoDB Compass                                              |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Nerede çalışır            | Tarayıcıda; kendi bilgisayarında ya da kendi sunucunda                                    | Masaüstü uygulaması                                          |
| Ekip                      | Kullanıcılar, roller, bağlantı başına erişim, iki adımlı giriş, denetim günlüğü            | Tek kullanıcı                                                |
| Yapay zekâ                | Kendi sağlayıcın (Ollama dahil); değişiklikleri yalnızca sen onaylayınca yapan bir ajan   | Atlas hesabıyla, MongoDB'nin hizmetinden sorgu üretimi       |
| Yedekleme                 | Zamanlanmış ve şifreli; S3, Google Drive, WebDAV ya da bir sunucu klasörü                 | Yok                                                          |
| Canlı senkron             | Bir koleksiyonu ya da veritabanını sürekli aktarır, doğrular, geçişle bitirir             | Yok                                                          |
| Kişisel verileri gizleme  | Kurallarla; her ekranda, dışa aktarmada, yedekte ve yapay zekâda                          | Yok                                                          |
| Uyarılar                  | Uygulamada, e-postayla ve webhook'la                                                      | Yok                                                          |
| SQL ↔ MongoDB             | mysqldump, pg_dump ve sqlite3 dökümlerini içe, koleksiyonları SQL olarak dışa aktarır     | Yok                                                          |
| Arayüz dili               | 10 dil                                                                                    | İngilizce                                                    |

<sub>Compass bilgileri, MongoDB'nin Ekim 2026'daki belgelerine göredir.</sub>

## Hızlı başlangıç

Node.js 24 ya da sonrası yeterli:

```sh
npx @mongo-manager/app
```

Tarayıcın kendiliğinden açılır (`http://127.0.0.1:4321`). Ekip olarak kullanmak için `--auth` ile başlat; ilk açılışta tek kullanımlık bir kurulum anahtarı yazdırır. Docker, tek dosyalık sürüm ve sistem hizmeti için: [Kurulum](#kurulum).

## Öne çıkanlar

### Yapay zekâ ajanı

Ne istediğini kendi sözlerinle yaz; ajan bağlantılarınla adlarıyla çalışır.

- **Verinden yanıt verir:** gereken sorguyu ya da toplama hattını kendisi yazar, çalıştırır ve attığı her adımı gösterir.
- **Hiçbir şeyi sormadan değiştirmez:** koleksiyon, belge, indeks, yedek, geri yükleme, zamanlama, MongoDB kullanıcısı ya da işlem durdurma; her değişiklik bir kartta onayını bekler. Reddedersen hiçbir şey yazılmaz.
- **Sağlayıcıyı sen seçersin:** Anthropic, Google Gemini, OpenAI uyumlu herhangi bir sunucu ya da kendi ağındaki Ollama.
- **Kurallar senin:** kişisel veriler ondan gizli kalır; her bağlantının kendi yapay zekâ ilkesi ve hız sınırı vardır; her istek token sayısı ve maliyetiyle geçmişte durur.

<p align="center"><img src="docs/media/clips/ai.gif" alt="Yapay zekâ ajanı: veriden bir yanıt ve onay bekleyen bir indeks" width="720"></p>

### Replica set

- **Üyeleri canlı gör:** primary, secondary'ler, çöken üyeler ve replikasyon gecikmesi; yedi günlük geçmişle.
- **Gecikme için uyarı al:** replikasyon gecikmesi bir eşiği geçince uygulamada, e-postayla ya da webhook'la haber verir.
- **Değişiklikleri canlı izle:** bir koleksiyonun, veritabanının ya da bütün bağlantının change stream'i; filtreler, duraklatma ve sunucu tuttuğunda değişiklikten önceki değerler.
- **Canlı senkron:** bir replica set'ten başka bir bağlantıya sürekli aktarım, doğrulama ve geçiş (cutover).
- **Genel bakışta:** replica set'in durumu kendi panosunda.

### Sharded cluster

Bir mongos'a bağlan; sharding'i uygulamanın içinden yönet:

- **Tek bakışta:** shard'lar, balancer'ın durumu ve her koleksiyonun chunk'larının shard'lara dağılımı.
- **Koleksiyonu shard'la:** seçtiğin shard anahtarı önce denetlenir, öneriler gelir. Shard Key Analyzer eklentisi anahtarı ayrıca çözümler.
- **Zone'lar:** shard'ları zone'lara ekle ya da çıkar, anahtar aralıkları tanımla.
- **Balancer:** aç, kapat ve çalışacağı saat aralığını ayarla.
- **Sorgu planı** her shard'ın planını ayrı gösterir; change stream'ler ve canlı senkron sharded cluster'da da çalışır.

### Ekip, güvenlik ve denetim

- **Ekip modu (`--auth`):** yönetici, editör ve görüntüleyici rolleri ve bağlantı başına erişim.
- **İki adımlı giriş:** kimlik doğrulayıcı uygulamalar, geçiş anahtarları (passkey) ve kurtarma kodları; tek bir kişi, yöneticiler ya da herkes için zorunlu tutulabilir.
- **Panel erişimi:** panelin yalnızca bazı adreslere yanıt vermesini uygulamanın içinden ayarla; girişte sürekli başarısız olan adresler engellenir.
- **Denetim günlüğü:** yalnızca eklenebilir, özet zinciriyle korunur; CSV ya da NDJSON olarak dışa aktarılır.
- **Sırlar şifreli:** bağlantı parolaları ve anahtarları diskte şifreli durur; kabuk hiçbir kimlik bilgisi tutmayan korumalı bir süreçte çalışır.

### Yedekleme, kopyalama ve canlı senkron

- **Yedekler:** mongodump arşivleri ya da şifreli `.mmbak` dosyaları (AES-256-GCM); zamanlanır, saklama süresi verilir, bir sunucu klasörüne, S3 uyumlu depolamaya, Google Drive'a ya da WebDAV'a gönderilir.
- **Geri yükleme:** önce bir plan ve deneme çalıştırması, sonra onay.
- **Kopyala ve karşılaştır:** bir koleksiyonu, bir sorgunun sonuçlarını ya da bir veritabanını aynı ya da başka bir bağlantıya kopyala ve karşılaştır.
- **Canlı senkron:** değişiklikleri sürekli aktarır, doğrular ve bir geçişle biter.

### Kişisel verileri gizleme

Kişisel alanları görmemesi gerekenlerden gizleyen kurallar: belgelerde, sorgularda, toplama hatlarında, dışa aktarmalarda, kopyalarda, yedeklerde, değişiklik akışlarında, canlı senkronda ve yapay zekâ asistanında. Kurallar sunucuda uygulanır; böyle bir kişi kabuğu hiç açamaz.

## Tüm özellikler

Her başlığa tıklayınca ayrıntılar açılır.

<details>
<summary><b>Gezinme ve düzenleme</b></summary>

- Veritabanları, koleksiyonlar ve view'lar; capped, time-series ve clustered koleksiyonlar (varsayılan collation ve change stream öncesi/sonrası görüntüleriyle).
- Belgeler tablo, kart (açılır ağaçla) ya da JSON olarak; ekleme, kopyalama, yalnızca değişeni yazan satır içi düzenleme ve bir seçim üzerinde işlemler.
- GridFS paketleri: listeleme, önizleme, yükleme, indirme, üst veri ve silme.

</details>

<details>
<summary><b>Sorgu, toplama hattı ve kabuk</b></summary>

- Alan tamamlamalı ve görsel oluşturuculu filtre; projeksiyon, sıralama, atlama, sınır, collation, hint ve süre sınırı.
- Toplu güncelleme ve silme: kaç belgenin eşleştiğini ve birkaçının öncesini ve sonrasını yazmadan gösterir; her belge etkilenecekse koleksiyonun adını sorar.
- Toplama hattı oluşturucu: aşama kartları ya da metin modu, her aşamanın örnek üzerinde canlı önizlemesi, `$out`/`$merge` yalnızca onaydan sonra.
- Koda aktarma: Node.js, Python, Java, Go, C#, PHP, Ruby ve Rust.
- Sorgular sayfası (Ctrl+Shift+L): favoriler, kayıtlı hatlar, kabuk parçacıkları ve geçmiş; ekip modunda paylaşılabilir.
- Gelişmiş kabuk: sekme başına mongosh, kimlik bilgisi tutmayan korumalı bir süreçte; salt okunur sınırlar sunucuda uygulanır ve her komut denetim kaydına geçer.

</details>

<details>
<summary><b>İndeksler, şema ve sorgu planı</b></summary>

- Her indeks türü (tekil, bileşik, multikey, text, 2d, 2dsphere, hashed, wildcard) ve seçenekleri (unique, sparse, partial, TTL, collation, gizli), `$indexStats` kullanımıyla.
- Atlas Search ve Vector Search indeksleri (Atlas ya da mongot'lu MongoDB 8.0+).
- "Neden yavaş?": sorgu planı uyarılarla bir ağaç olarak ve işe yarayacak indeks hazır doldurulmuş olarak.
- Şema çözümlemesi: alan türleri, bulunma oranı, histogramlar ve en yaygın değerler; bir tıklama filtreye ekler, konumlar çevrimdışı bir haritada.
- Şemayı Mongoose, JSON Schema, TypeScript, Pydantic, Go ya da C# olarak dışa aktarma; örnekten doğrulama kuralları üretip mevcut belgelere karşı deneme.

</details>

<details>
<summary><b>Performans, uyarılar ve genel bakış</b></summary>

- Bağlantı başına işlemler, bağlantılar, ağ ve bellek için yedi günlük geçmişli canlı grafikler.
- En yavaş çalışan işlemler (bağlantı yöneticileri sonlandırabilir), en yoğun koleksiyonlar, profiler, yavaş sorgular ve indeks önerileri.
- Uyarılar: bağlantılar, işlemler, replikasyon gecikmesi, WiredTiger önbelleği, disk ve yavaş işlemler için eşikler; başarısız yedekler, işler ve duran canlı senkronlar için olaylar. Erteleme, onaylama ve geçmiş.
- Genel bakış: her kullanıcının kendi düzenlediği bir pano.

</details>

<details>
<summary><b>İçe ve dışa aktarma</b></summary>

- CSV, TSV, JSON, NDJSON (Extended JSON) ve Excel (.xlsx), gzip'li olanlar da; alan eşleme, türler, insert, upsert ya da birleştirme, deneme çalıştırması ve reddedilen kayıtların dosyası.
- SQL ↔ MongoDB: mysqldump, pg_dump ve sqlite3 dökümleri koleksiyonlara; koleksiyonlar PostgreSQL, MySQL ya da SQLite olarak.

</details>

<details>
<summary><b>Bağlantılar ve şifreleme</b></summary>

- TLS, ana makine anahtarı sabitlemeli SSH tünelleri, SCRAM, X.509, LDAP (PLAIN), AWS IAM, MONGODB-OIDC ve Kerberos.
- Salt okunur bağlantılar, gruplar ve renkler; parola korumalı olarak içe ve dışa aktarma.
- İstemci tarafı şifreleme: yerel, AWS, Azure, Google Cloud ve KMIP anahtarlarıyla CSFLE ve Queryable Encryption (npm paketinde).

</details>

<details>
<summary><b>Eklentiler</b></summary>

- Korumalı (sandbox) sekmeler, belge eylemleri, hücre görünümleri ve sayfalar; her biri güvenlik taramasından ve bir yöneticinin onayından sonra açılır.
- Hazır gelenler: GeoJSON haritası, grafikler, veri sözlüğü, yinelenenleri bulma, belge farkları, şema sağlığı, SQL'den MongoDB'ye, Shard Key Analyzer ve fazlası.
- Diğerleri dosyadan ya da izin veren bir sunucuda bir GitHub deposundan kurulur.
- Başkalarının yaptığı eklentiler ve kendi eklentinizi listeye eklemek: [Awesome Mongo Manager](https://github.com/mongo-manager/awesome-mongo-manager).

</details>

<details>
<summary><b>Her yerde</b></summary>

- On dil: İngilizce, Türkçe, Çince, Japonca, İspanyolca, Portekizce, Korece, Almanca, Fransızca ve Rusça.
- Açık ve koyu tema, vurgu renkleri, komut paleti (Ctrl+K), klavye kısayolları (?) ve uygulamanın içinde belgeler.
- Arka plan işleri canlı ilerlemeyle; uygulama olarak (PWA) kendi penceresinde kurulabilir.

</details>

## Kısa tur

### Bul ve süz

Alan tamamlamalı bir filtre yaz ya da bir değere tıklayıp ekle; sonuçlar tablo, kart ya da JSON olarak sayfalanır.

<p align="center"><img src="docs/media/clips/query.gif" alt="Bul ve süz" width="720"></p>

### Hattı aşama aşama kur

Her aşama, sen yazarken bir örnek üzerindeki çıktısını gösterir; çalıştır, kaydet ya da koda aktar.

<p align="center"><img src="docs/media/clips/aggregation.gif" alt="Hattı aşama aşama kur" width="720"></p>

### Verinin biçimini tanı

Her alanın örneklemle çözümlemesi: türleri, ne sıklıkla bulunduğu ve değerleri.

<p align="center"><img src="docs/media/clips/schema.gif" alt="Verinin biçimini tanı" width="720"></p>

### Bir sorgunun neden yavaş olduğunu gör

Sorgu planı bir ağaç olarak; tüm koleksiyonu okuyan adım ve işe yarayacak indeks.

<p align="center"><img src="docs/media/clips/explain.gif" alt="Bir sorgunun neden yavaş olduğunu gör" width="720"></p>

### Her şey bir tuş uzağında

Komut paleti (Ctrl+K) her komutu, koleksiyonu ya da ayarı bulur.

<p align="center"><img src="docs/media/clips/palette.gif" alt="Her şey bir tuş uzağında" width="720"></p>

### Sunucuyu canlı izle

İşlemler, bağlantılar, ağ ve bellek; canlı ve yedi günlük geçmişiyle, uyarılarla birlikte.

<p align="center"><img src="docs/media/clips/performance.gif" alt="Sunucuyu canlı izle" width="720"></p>

## Ekran görüntüleri

Görseller GitHub temanı izler: açık ya da koyu.

<table>
  <tr>
    <td colspan="2"><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/ai-agent-dark.png"><img src="site/assets/screens/ai-agent-light.png" alt="Yapay zekâ ajanı: veriden bir yanıt ve onay bekleyen bir indeks"></picture><br><sub>Yapay zekâ ajanı: veriden bir yanıt ve onay bekleyen bir indeks</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/documents-dark.png"><img src="site/assets/screens/documents-light.png" alt="Tabloda belgeler, bir filtre ve tek tıkla öneriler"></picture><br><sub>Tabloda belgeler, bir filtre ve tek tıkla öneriler</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/aggregation-dark.png"><img src="site/assets/screens/aggregation-light.png" alt="Her aşaması önizlenen bir toplama hattı"></picture><br><sub>Her aşaması önizlenen bir toplama hattı</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/schema-dark.png"><img src="site/assets/screens/schema-light.png" alt="Örneklenmiş bir koleksiyonun şeması"></picture><br><sub>Örneklenmiş bir koleksiyonun şeması</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/explain-dark.png"><img src="site/assets/screens/explain-light.png" alt="Neden yavaş? Sorgu planı"></picture><br><sub>Neden yavaş? Sorgu planı</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/performance-dark.png"><img src="site/assets/screens/performance-light.png" alt="Canlı sunucu performansı"></picture><br><sub>Canlı sunucu performansı</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/palette-dark.png"><img src="site/assets/screens/palette-light.png" alt="Komut paleti (Ctrl+K)"></picture><br><sub>Komut paleti (Ctrl+K)</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/plugins-dark.png"><img src="site/assets/screens/plugins-light.png" alt="Her biri bir yöneticinin onayladığı eklentiler"></picture><br><sub>Her biri bir yöneticinin onayladığı eklentiler</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/security-dark.png"><img src="site/assets/screens/security-light.png" alt="Ekip modu: iki adımlı doğrulama kuralları, oturumlar, panel erişimi ve oturum açma engelleri"></picture><br><sub>Ekip modu: iki adımlı doğrulama kuralları, oturumlar, panel erişimi ve oturum açma engelleri</sub></td>
  </tr>
</table>

## Kurulum

Birini seç. Her sürüm bütün dosyaları SHA-256 sağlama toplamlarıyla (`SHA256SUMS`) yayımlar; hepsi internete bağlı olmayan bir makinede de çalışır.

| Yol                | Komut                                                                                                 | Gerekenler            |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --------------------- |
| npm                | `npx @mongo-manager/app`, ya da `npm install --global @mongo-manager/app`                                       | Node.js 24+           |
| npm, çevrimdışı    | `npm install --global ./mongo-manager-<version>.tgz`                                                  | Node.js 24+           |
| Tek dosya          | `mongo-manager-<version>-<os>-<arch>` dosyasını indir, sonra çalıştır                                 | hiçbir şey            |
| Docker             | `docker run -d -p 127.0.0.1:4321:4321 -v mm-data:/data ghcr.io/mongo-manager/mongo-manager:<version>` | Docker                |
| Docker, çevrimdışı | `docker load -i mongo-manager-<version>-<arch>.tar`, sonra `mongo-manager:<version>` çalıştır         | Docker                |
| Docker, klondan    | `docker compose -f deploy/docker-compose.yml up -d` (imajı kaynaktan derler)                          | Docker                |
| Sistem hizmeti     | `sudo mongo-manager service install` (Windows: yönetici olarak açılmış bir komut isteminden)          | npm ya da tek dosya   |

- **Tek dosyalık sürümler** (Linux x64/arm64, Windows x64, macOS arm64) kendi çalışma zamanlarını ve web uygulamasını taşır. Kod imzalı değildir; macOS'ta _Sistem Ayarları → Gizlilik ve Güvenlik_ bölümünden izin ver ya da `xattr -d com.apple.quarantine ./mongo-manager-*` çalıştır.
- **Kerberos ve istemci tarafı şifreleme** yalnızca npm paketinde çalışır (`kerberos` ve `mongodb-client-encryption` paketlerini yanına kur).
- **Desteklenen MongoDB:** 6.0 ve sonrası; tek sunucular, replica set'ler, sharded cluster'lar (mongos üzerinden) ve Atlas. Değişiklikleri izleme ve canlı senkron bir replica set ya da sharded cluster ister. Daha eski sunucular bunu söyleyen bir iletiyle reddedilir.
- **Testler:** sunucu testleri gerçek 6.0, 7.0, 8.0 ve 8.3 sunucularında ve replica set'lerinde çalışır. Sharded cluster'lar kaydedilmiş mongos yanıtlarıyla, Atlas ise bağlantı dizeleriyle test edilir; ikisi de canlı bir kuruluma karşı test edilmez.
- Hizmetler, Docker, ters proxy'ler ve yedekler için: [deploy/README.md](deploy/README.md).

**Docker**

- İmaj ekip modunda çalışır ve konteynerin içinde her adresi dinler. `http://127.0.0.1:4321` adresini aç ve tek kullanımlık kurulum anahtarını `docker exec <name> cat /data/setup-token` ile al; kurulumu hemen tamamla.
- Alan adıyla bir ters proxy'nin arkasında çalışıyorsa `MM_ALLOWED_HOSTS` değerine o adı (yoksa `403 Host not allowed` yanıtı alırsın), `MM_TRUSTED_PROXIES` değerine de Docker ağının ağ geçidini, genellikle `172.17.0.1`, ver: [deploy/README.md](deploy/README.md#docker).
- Konteynerin içinde `localhost` konteynerin kendisidir: ana makinedeki ya da başka bir konteynerdeki MongoDB'ye ulaşmak için [Konteynerden MongoDB'ye ulaşmak](deploy/README.md#reaching-your-mongodb-from-the-container) bölümüne bak.

## Kullanım

```sh
mongo-manager                 # local mode on http://127.0.0.1:4321, opens your browser
mongo-manager open            # a new one-time link that opens a running local-mode Mongo Manager
mongo-manager --auth          # team mode; the first start prints a one-time setup token
mongo-manager --help          # every command and option
mongo-manager doctor          # check the installation and the data directory
```

Her sunucu seçeneğinin bir `MM_*` ortam değişkeni de vardır, örneğin `MM_WEB_PORT`, `MM_AUTH=1` ya da `MM_DATA_DIR`. Diğer komutlar kullanıcıları, anahtarları, yedekleri ve sistem hizmetini yönetir; `mongo-manager --help` hepsini listeler.

## Güvenlik

<details>
<summary><b>Mongo Manager'ı nasıl koruduğumuz</b></summary>

- **Dinleme adresi:** varsayılan olarak yalnızca bu bilgisayar (loopback). `--auth` olmadan bir ağ adresini ya da önüne konmuş bir ters proxy'yi reddeder (tehlikeli `--unsafe-no-auth` ile başlatılmadıkça). `--allowed-hosts` verilmemişse bir ağ adresinde yalnızca IP adreslerine ve `localhost`'a yanıt verir (DNS rebinding'e karşı).
- **Yerel mod:** yalnızca tek kullanımlık bir bağlantıyla açılır; `mongo-manager open` yenisini üretir. Ardından her tarayıcı kendine ait bir HttpOnly çerez ve bir sayfa anahtarı taşır; `mongo-manager forget-browsers` hepsinin oturumunu kapatır.
- **Kayıtlı sırlar:** bağlantı parolaları ve anahtarları `secret.key` (ya da `MM_SECRET_KEY`) ile şifrelenir. Anahtarı veri diziniyle birlikte yedekle ama ayrı sakla; `mongo-manager rotate-key` anahtarı değiştirir.
- **Web koruması:** sıkı Content-Security-Policy, CSRF belirteçleri ve köken denetimleri, hız sınırlı girişler, hareketsizlikte ve 12 saatte biten oturumlar; hassas değişiklikler parolanı ya da ikinci adımı yeniden sorar.
- **İzinler:** her salt okunur ve rol denetimi sunucuda çalışır, asla yalnızca tarayıcıda değil.

</details>

Bir güvenlik açığı bulursan lütfen herkese açık bir issue açma, özel olarak bildir: [SECURITY.md](SECURITY.md).

## Geliştirme

```sh
pnpm install
pnpm dev:web                  # the web app with hot reload; /api goes to a server on port 4321
                              # (local mode: open its launch link with port 5173 in place of 4321)
pnpm lint && pnpm typecheck && pnpm test
pnpm build                    # web app, plugins and the bundled CLI in packages/cli
pnpm test:e2e                 # Playwright against the installed Chrome
pnpm --filter @mongo-manager/e2e e2e:rs  # after pnpm build: Watch and Live sync on the memory
                              # server's replica set, failing without one (as CI runs them);
                              # MM_E2E_PORT=45000 picks another port for the test server
pnpm --filter @mongo-manager/app test:sea   # build and run the standalone binary
node packages/server/scripts/capture-explain.mjs --version 7.0.43   # explain fixtures of a release;
                              # --sharded --bin <folder with mongod and mongos> for a sharded cluster
```

| Paket              | Ne olduğu                                                     |
| ------------------ | ------------------------------------------------------------- |
| `packages/shared`  | Türler, şemalar, güvenli sorgu ayrıştırıcı, EJSON             |
| `packages/server`  | Fastify API, kimlik doğrulama, SQLite deposu, MongoDB erişimi |
| `packages/web`     | Vue 3 web uygulaması                                          |
| `packages/cli`     | `mongo-manager` komutu, hizmet yükleyici                      |
| `packages/plugins` | Hazır eklentiler ve eklenti kiti                              |
| `packages/e2e`     | Uçtan uca testler                                             |

### Fork'lar: güncellemeleri açmak

Kurulumlar kendilerini yalnızca koddaki anahtarla imzalanmış sürümlere günceller (`packages/shared/src/updates/source.ts` içindeki `RELEASE_PUBLIC_KEYS`). Orada hiçbir şeyi değiştirmeyen bir fork resmî sürümleri izler. Kendi fork'unuz için güncelleme yayımlamak üzere:

1. Kendi anahtar çiftinizi üretin: `node scripts/release-key.mjs ~/mm-release-signing.key`. Gizli anahtarı o dosyaya yazar (yalnızca siz okuyabilirsiniz) ve genel anahtarı ekrana basar. Dosyayı deponun dışında tutun.
2. `packages/shared/src/updates/source.ts` içinde `RELEASE_REPO`, `RELEASE_IMAGE` ve `RELEASE_NPM_PACKAGE` değerlerini kendi deponuz, imajınız ve paketinizle değiştirin; `RELEASE_PUBLIC_KEYS` listesine de kendi genel anahtarınızı koyun.
3. GitHub deponuzda `signing` ortamını oluşturun (onaylayıcı olarak kendinizi ekleyin ve dağıtımlarını `v*` biçimindeki etiketlerle sınırlayın) ve gizli anahtar dosyasının içeriğini bu ortamın `MM_RELEASE_SIGNING_KEY` sırrı olarak ekleyin. Ardından dosyayı çevrimdışı saklayın ya da silin; asla commit etmeyin.
4. Her sürüm, `signing` işini onayladığınızda kendi `SHA256SUMS` dosyasını imzalar. `RELEASE_PUBLIC_KEYS` ile eşleşmeyen bir anahtar, sürümü hiçbir şey yayımlanmadan durdurur.

Fork'unuzda güncelleme istemiyorsanız `RELEASE_PUBLIC_KEYS` listesini boşaltın (uygulama güncellemeleri `MM_UPDATES=off` gibi gizler) ve `.github/workflows/release.yml` içinden `signing` işini, `ghcr` ve `npm` işlerinin `needs` listelerindeki adıyla birlikte kaldırın.

## Lisans

Copyright (C) 2026 Gokhan OZGEZER

Mongo Manager, [GNU Affero Genel Kamu Lisansı v3.0 (yalnızca bu sürüm, AGPL-3.0-only)](LICENSE) ve [NOTICE](NOTICE) dosyasındaki ek şartlarla sunulur. Kısaca:

- **Kullan:** her amaçla, ticari kullanım dahil çalıştır, değiştir ve paylaş.
- **Kaynağı paylaş:** değiştirdiğin sürümü aynı lisansla ve kaynak koduyla paylaş; başkaları onu ağ üzerinden kullandığında da.
- **Bildirimleri koru:** koddaki ve her kopyadaki telif bildirimini koru; her kopyanın ve değiştirilmiş sürümün Hakkında ekranında ve README dosyasında şu atfı koru:

  > Based on Mongo Manager by Gokhan OZGEZER - https://github.com/mongo-manager/mongo-manager

- **Ad ve logo:** değiştirdiğin sürümün değiştirildiğini belirt; o sürüm Mongo Manager adını ve logosunu kullanmaz.

Mongo Manager, yasaların izin verdiği ölçüde hiçbir garanti olmadan sunulur. Eklenti başlangıç şablonu (`packages/plugins/starter`) MIT lisanslıdır; ondan yapılan bir eklenti istediği lisansı seçebilir. Birlikte gelen üçüncü taraf bileşenler kendi lisanslarını korur; her sürümde `THIRD-PARTY-NOTICES.txt` dosyasında listelenir.

## Geliştirici

**Gokhan OZGEZER**

- E-posta: [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com)
- GitHub: [@gokhanozgezer](https://github.com/gokhanozgezer)
- Proje: [github.com/mongo-manager/mongo-manager](https://github.com/mongo-manager/mongo-manager)
- Hata bildirimi ve öneriler: [Issues](https://github.com/mongo-manager/mongo-manager/issues)
