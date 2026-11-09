# Yerel saat

MongoDB tarihleri UTC olarak saklar ve Belgeler onları böyle gösterir: `2026-10-26T11:03:12.000Z`. Yerel saat, her tarihi saati okuduğunuz gibi — tarayıcınızın saat diliminde ya da ayarladığınız bir dilimde — UTC'den farkıyla gösterir; böylece üç saati kafanızdan eklemeniz gerekmez. Bu, MongoDB Compass geri bildirim forumunda en çok istenen değişikliklerden biridir ("tarihleri UTC yerine yerel saatle göster").

Eklentinin kendi sayfası yoktur ve veritabanından hiçbir şey okumaz. Yalnızca uygulamanın zaten gösterdiği tarihlere bakar.

## Nerede görünür

- **Hücre değerleri:** Belgelerde bir tarihin üzerine geldiğinizde, tarihin yerel saatle hâli: `26 Eki 2026 14:03:12 (UTC+3)`.

Belgelerin bir tarihi gösterdiği her yerde (tablo, ağaç, kartlar, belge denetçisi) hücresinin araç ipucunda görünür — ayarlarda seçerseniz değerin yanında. Belgenin kendisine hiçbir şey eklenmez; değer saklandığı gibi kalır.

## Ayarlar

Bunları bir yönetici, herkes için Eklentiler sayfasında belirler:

- **Tarihin yanında göster:** kapalıyken yerel saat araç ipucundadır; açıkken değerin yanına yazılır.
- **Saat dilimi:** `Europe/Istanbul` ya da `America/New_York` gibi bir IANA adı. Boşsa herkes kendi tarayıcısının dilimini görür. Tarayıcının tanımadığı bir ad boş sayılır ve her tarih bunu söyler: `· bilinmeyen saat dilimi "Europe/Istambul"`. UTC'nin kendisi olan bir dilim bir kez anılır: `(UTC)`.
- **Ne kadar önce olduğunu ekle:** tarihten sonra "3 gün önce" ya da "2 saat sonra" ekler — bir üst birime yuvarlandığında o birimle: "24 saat önce" değil, "dün".

## Örnek

Şöyle bir belge:

```json
{ "createdAt": { "$date": "2026-10-26T11:03:12Z" } }
```

İstanbul'daki biri için şunu gösterir: `26 Eki 2026 14:03:12 (UTC+3)` — bir dilim ayarlandıysa `26 Eki 2026 14:03:12 (Europe/Istanbul, UTC+3)`.

1900'den önceki ve 2200'den sonraki tarihler uygulamanın gösterdiği gibi bırakılır.

## İzinler

- **Belgeleri okuma:** bir hücre görüntüleyicisine, hakkında yanıt verdiği hücrelerin değerleri gösterilir; bu eklenti yalnızca tarihleri ve yalnızca ekrandakileri okur.
