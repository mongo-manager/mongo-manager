# Zaman ipuçları

Zaman ipuçları, içinde bir tarih saklayan değerlerin üzerinde okunabilir bir tarih gösterir. Bir ObjectId, oluşturulduğu saniyeyi ilk dört baytında taşır; birçok koleksiyon da zamanları Unix zaman damgası olarak (1970'ten bu yana geçen saniye ya da milisaniye) saklar. Zaman ipuçları bu anları Belgeler'de, uygulamanın dilinde ve sizin yerel saatinizle gösterir; böylece onları kendiniz çözmeniz gerekmez.

Eklentinin kendine ait bir sayfası yoktur ve veritabanından hiçbir şey okumaz. Yalnızca uygulamanın zaten gösterdiği değerlere bakar.

## Nerede görünür

- **Hücre değerleri:** Belgeler'de bir ObjectId'nin üzerine gelindiğinde, oluşturulduğu an.
- **Hücre değerleri:** Unix zamanı gibi okunan bir sayının üzerine gelindiğinde, `≈` ile işaretlenmiş tarihi.

İkisi de Belgeler'in değeri gösterdiği her yerde (tablo, ağaç, kartlar, belge denetçisi), hücresinin ya da satırının üzerine geldiğinizde veya klavye odağı oraya geldiğinde açılan bir araç ipucunda görünür: ilk satırda değerin tamamı, altında eklentinin adından sonra zaman. Değerin yanına hiçbir şey yazılmaz, belgenin kendisine de hiçbir şey eklenmez. Ekran okuyucu zamanı değerle birlikte okur.

## Nasıl kullanılır

Açılacak ya da ayarlanacak bir şey yoktur: bir yönetici eklentiyi onaylayıp etkinleştirdiğinde ipuçları herkes için Belgeler'de görünür.

## Örnek

Şöyle bir belge:

```json
{
  "_id": { "$oid": "652629f0c3e5b2a1d4f0a9b7" },
  "createdAt": 1696999920,
  "updatedAtMs": 1697003520000,
  "quantity": 3
}
```

İstanbul'daki, uygulamayı Türkçe kullanan bir kullanıcıya şu araç ipuçlarıyla görünür:

```
_id           üzerine gelince:  ObjectId("652629f0c3e5b2a1d4f0a9b7")
                                Zaman ipuçları: 11 Eki 2023 07:52
createdAt     üzerine gelince:  1696999920
                                Zaman ipuçları: ≈ 11 Eki 2023 07:52
updatedAtMs   üzerine gelince:  1697003520000
                                Zaman ipuçları: ≈ 11 Eki 2023 08:52
quantity      araç ipucu yok
```

`quantity` ipucu almaz: 3, Unix zamanları aralığında değildir.

## Neler zaman olarak okunur

- **ObjectId:** her zaman. İlk sekiz onaltılık rakam, saniye cinsinden oluşturulma zamanıdır. Bu zaman, kimliğin üretildiği andır; kimliği genellikle belgeyi ekleyen programın sürücüsü üretir ve bu her zaman eklemenin yapıldığı an değildir.
- **Sayı:** 1.000.000.000'dan 4.102.444.800'e kadar (bu sayı hariç) bir int, long ya da double saniye olarak; aynı aralığın 1.000 katı milisaniye olarak okunur. Bu, 9 Eylül 2001'den 2099'un sonuna kadar olan dönemi kapsar.

Bir sayı yalnızca bir tahmindir: bu aralıktaki bir fiyat, bir adet ya da bir telefon numarası da bir tarih alır. Sayı ipuçlarının `≈` ile başlamasının nedeni budur. Gerçek BSON tarihi olarak saklanan tarihleri uygulama zaten kendisi gösterir; onların ipucuna ihtiyacı yoktur.

## Biçim

- Tarih ve saat uygulamanın dilini kullanır: orta uzunlukta tarih, kısa saat (örneğin Türkçede `11 Eki 2023 07:52`, İngilizcede `Oct 11, 2023, 7:52 AM`).
- Saat dilimi, tarayıcının yerel saat dilimidir.
- Uygulamanın dili değiştiğinde ipuçları yeni dilde yeniden gösterilir.

## İzinler

- **Belgeleri okuma** (`documents:read`): uygulama, bir hücrenin değerlerini yalnızca belge okumasına izin verilen eklentilere sorar. Zaman ipuçları sayfadaki değerleri alır ve veritabanını asla kendisi sorgulamaz.

## Ayarlar

Yok.

## Sınırlar

- Yalnızca ObjectId'ler ve düz sayılar okunur. Metin olarak (`"2023-10-11T07:52:00Z"`) ya da ondalık olarak (`$numberDecimal`) saklanan bir zaman ipucu almaz.
- Gösterilen en küçük birim saniyedir; milisaniyeler gösterilmez.
- 1.000.000.000 saniyenin altındaki (Eylül 2001 öncesi) ya da 2100 yılından itibarenki sayılar zaman olarak okunmaz.
- İpuçları uygulamanın gösterdiği değerleri izler; iç içe bir nesnenin içindeki değer, uygulamanın o iç içe değeri bir hücre olarak gösterdiği yerde ipucu alır.
