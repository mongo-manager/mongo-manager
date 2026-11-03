# İndeks betiği

İndeks betiği bir koleksiyonun — ya da tüm veritabanının — indekslerini onları yeniden oluşturan komutlar olarak yazar: mongosh için, Node.js ya da Python sürücüsü için, veya JSON olarak. Aynı indeksleri başka bir ortamda oluşturmak, kodunuzla birlikte saklamak ya da bir taşımayı planlamak için kullanın.

Eklenti yalnızca okur. Hiçbir şey çalışmaz: betik kopyalanacak ya da kaydedilecek bir metindir.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyonun Belgeler, Aggregation ve diğer sekmelerinin yanında bir **İndeks betiği** sekmesi.

## Nasıl kullanılır

Bir koleksiyon açın, ardından **İndeks betiği** sekmesini. Sekme açılır açılmaz koleksiyonun indekslerini okur.

- **İndeksler:** **Bu koleksiyon** ya da **Tüm veritabanı** — onun her koleksiyonu (görünümlerin kendine ait indeksi yoktur).
- **Biçim:** **mongosh** (`db.getCollection("…").createIndex(…)`), **Node.js** (`await db.collection("…").createIndex(…)`), **Python** (PyMongo'nun `create_index`'i) ya da **JSON** — her indeks, türüne kadar tam olarak, kanonik Extended JSON'da `{ collection, key, options }` biçiminde.

**Kopyala** betiği panoya koyar; **İndir** onu kaydeder (betikler için `.txt`, JSON için `.json`).

Bir indeksin her seçeneği yazılır: adı, `unique`, `sparse`, kısmi filtre, TTL (`expireAfterSeconds`), collation, `hidden`, bir metin indeksinin ağırlıkları ve dili, ve diğerleri. Sürücünün `createIndex`'i (mongosh'unki de) tanımadığı seçenekleri, örneğin `prepareUnique`'i dışarıda bırakır: böyle bir seçeneği olan indeks hepsini koruyan `createIndexes` komutu olarak yazılır (mongosh'ta `db.runCommand(…)`, Node.js için `await db.command(…)`). Bir metin indeksi, ağırlıklarının söylediği gibi oluşturulduğu alanlarla (`{ title: "text" }`) yazılır. Kendi türü olan değerler (tarihler, kimlikler, sayılar, ikili veri, zaman damgaları) dilin onları oluşturduğu gibi yazılır. Varsayılan `_id` indeksi ya da kümelenmiş bir indeks koleksiyonuyla birlikte oluşturulur ve dışarıda bırakılır.

## Örnek

```
db.getCollection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "customerId_1_createdAt_-1", unique: true })
db.getCollection("orders").createIndex({ expires: 1 }, { name: "expires_1", expireAfterSeconds: 3600 })
```

Python için:

```
db["orders"].create_index([("customerId", 1), ("createdAt", -1)], name="customerId_1_createdAt_-1", unique=True)
```

## İzinler

- **Bu koleksiyonun tanımını okuma** (`collection:read`): indekslerini listelemek için.
- **Aynı veritabanındaki diğer koleksiyonları okuma** (`database:read`): **Tüm veritabanı** için koleksiyonlarını ve indekslerini listelemek için.

Okumalar oturum açmış kullanıcının haklarıyla ve alan maskelemesiyle uygulama üzerinden yapılır. Kısmi bir filtrenin, kullanıcıdan gizlenen bir alandaki değeri `"***"` olarak gelir: böyle bir değer taşıyan indeks betikte ve sekmede işaretlenir, çünkü betik onu olduğu gibi oluşturmaz.

## Ayarlar

Yok.

## Sınırlar

- **Tüm veritabanı** en fazla 100 koleksiyon okur; daha fazlası varsa sekme bunu söyler. İndeksleri okunamayan bir koleksiyon, nedeniyle birlikte sekmede ve betiğin en üstünde adlandırılır; bunu söyleyecek yeri olmayan JSON o zaman kopyalanmaz ve kaydedilmez. Uygulamanın dakikalık okumaları aşılınca sekme durur ve bunu söyler: bir dakika sonra yeniden deneyin.
- Arama indeksleri (Atlas Search, Vector Search) yazılmaz: başka bir yolla oluşturulurlar.
- Node.js ve Python betikleri kullandıklarını içeri alan satırlarla başlar; önce `db`'yi veritabanınıza bağlayın. Node.js betiği en üst düzeyde await kullanır: onu bir ES modülü (bir `.mjs` dosyası) olarak çalıştırın.
- Bir anahtarın alanları, adı sayı olanları (`"2"`) öne alan bir nesne olarak gelir: böyle bileşik bir anahtarın oluşturulduğu sıra kaybolur ve sekme de betik de bunu söyler (JSON bu indeksi `keyOrderUncertain` ile, JavaScript'in tutamayacağı bir tarih taşıyanı da `farDate` ile işaretler).
