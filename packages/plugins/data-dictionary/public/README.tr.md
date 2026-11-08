# Veri sözlüğü

Bir veritabanını paylaşan ekibin her koleksiyonun ne tuttuğunu bilmesi gerekir: hangi alanlar, hangi türde, hangileri zorunlu, ne anlama geliyorlar, koleksiyonlar birbirine nasıl başvuruyor ve hangi dizinler var. Veri sözlüğü bunu, uygulamanın kendi veri modelinden, bütün bir veritabanı için yazar ve belge olarak kaydeder. NoSQLBooster ("Schema documentation"), Hackolade (HTML ve PDF), DbSchema (Markdown) ve Dataedo da aynısını yapar.

## Nasıl kullanılır

Herhangi bir koleksiyonu ve onun **Veri sözlüğü** sekmesini açın: koleksiyonun tüm veritabanını belgeler.

1. Eklenti veritabanının modelini — Veritabanı sekmesinin çizdiği modeli — tek bir okumayla alır: koleksiyonlar, alanlar türleri ve ne sıklıkta bulunduklarıyla, gizli alanlar, referanslar.
2. Ardından her koleksiyonun dizinlerini ve doğrulama kurallarını koleksiyon koleksiyon okur ve nereye geldiğini söyler. Dakikanın okumaları biterse bekleyip devam eder; dizinleri ya da kuralları okunamayan bir koleksiyon nedenini söyler, diğerleri yine okunur.
3. **Markdown** ve **HTML** sözlüğü dosya olarak kaydeder; **Markdown kopyala** onu bir wiki ya da bir pull request için panoya koyar. 100.000 karakterden uzun bir sözlük, o sınırdan önceki son tam satıra kadar kopyalanır ve sayfa bunu söyler: tamamı için dosya olarak kaydedin. Bir dosya en fazla 1 MB'tır: bundan büyük bir sözlük, sığan ilk koleksiyonlarıyla kaydedilir ve hem sayfa hem dosya kaçının kaydedildiğini söyler; tek bir koleksiyon bile sığmazsa hiçbir şey kaydedilmez ve sayfa nedenini söyler.

## Ne söyler

Her koleksiyon için:

- **Alanlar:** yolu, türleri, ne sıklıkta bulunduğu, `$jsonSchema`'nın onu zorunlu tutup tutmadığı ve kurallarının verdiği açıklama, izin verilen değerler ve tür. Kişisel veri olarak sizden gizlenen bir alan gizli olarak listelenir: yalnızca adı ve kurallarının onu zorunlu tutup tutmadığı.
- **Referanslar:** başvurduğu koleksiyonlar (hangi alanla) ve ona başvuranlar.
- **Dizinler:** her dizinin anahtarları ve benzersiz olup olmadığı, belgelerini süre dolunca silip silmediği (TTL) ya da kısmi olup olmadığı. Kısmi bir dizinin filtresi asla gösterilmez: değer içerebilir.
- **Doğrulama:** düzeyi ve eylemi, kuralı olmadığı ya da kurallarının neden okunamadığı. Diğer kurallara `$and` ile bağlanmış bir `$jsonSchema` da okunur.

Bir görünüm, hangi koleksiyonun görünümü olduğunu söyler. Modelin okuyamadığı bir koleksiyon bunu söyler. Sayfa ve HTML dosyası asla betik çalıştırmaz. Dosyalarda bir koleksiyonun ya da alanın adı ve bir kuralın metni metin olarak yazılır: asla bağlantı (bir adres, bir `www.` adı ya da bir e-posta da), görsel, etiket ya da bozuk tablo olmaz; görünmeyen ya da metni ters çeviren karakterler, sayfada da, atılır. İzin verilen bir değer en fazla 80 karakterle yazılır. İçindekilerdeki her koleksiyon girişi, HTML'de de Markdown'da da ona götürür.

## İzinler

- **Veritabanını okuma:** veritabanının diğer koleksiyonları ve modeli.
- **Koleksiyon ayrıntılarını okuma:** her koleksiyonun dizinleri ve doğrulama kuralları.
