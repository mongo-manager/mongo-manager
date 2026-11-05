# İkili veri önizleme

Koleksiyonlar dosyaları çoğu zaman belgelerin içinde ikili değer olarak saklar: profil fotoğrafları, taranmış fişler, küçük resimler, küçük PDF'ler. Belgeler böyle bir değeri `Binary(…)` diye gösterir; bu da ne olduğu hakkında hiçbir şey söylemez. İkili veri önizleme, üzerine geldiğinizde ne taşıdığını söyler ve görselleri kendi baytlarından çizerek gösterir. NoSQLBooster aynısını "Binary Image Preview Tooltip" olarak sunar.

## Nerede görünür

- **Hücre değerleri:** Belgelerde bir ikili değerin üzerine gelmek ne taşıdığını söyler — `PNG görseli · 320 × 200 · 24 KB`, `PDF belgesi · 1,2 MB`, `ZIP arşivi`, `MP3 sesi`, `HEIC görseli`, `QuickTime videosu` — ya da başka bir şeyse alt türünü ve uzunluğunu. Uygulama eklentiye değerin yalnızca ilk 2 KB'ını gönderir, hiçbir zaman tamamını göndermez.
- **Görseller sekmesi:** koleksiyonun belgelerinde saklanan görseller (PNG, JPEG, GIF, WebP, AVIF, BMP ve SVG), Belgeler filtresi içinde, 12'şer. Bir tıklama görseli büyük gösterir; **Belgeyi aç** belgesini uygulamada açar.
- **Görselleri göster** (bir belgenin eylemi): o belgenin görselleri.

## Nasıl okur

Sekme önce hangi alanların görsel taşıdığını bulmak için 50 belge okur — 50'si birlikte uygulamanın 1 MB'lık mesaj sınırını aşıyorsa 10, sonra teker teker — sonra yalnızca o alanları ve `_id`'yi, `_id` sırasıyla ve her türden `_id`'yi geçerek sayfa sayfa okur. Sınırı aşan bir sayfa belge belge okunur; tek başına bile çok büyük olan bir belge sayılır ve sekme kaç tanesinin Belgeler'de açılması gerektiğini söyler. Büyük bir görsel kapatılana kadar (Escape ya da **Kapat**) klavyeyi kendinde tutar; odak sonra küçük resmine döner.

Görseller değerin kendi baytlarından `data:` adresleriyle çizilir; eklentinin sayfası başka hiçbir şey yükleyemez ve görsel olarak gösterilen bir SVG betik çalıştırmaz. UUID'ler hiçbir zaman dosya sanılmaz.

## İzinler

- **Belgeleri okuma:** görselleri bulmak ve göstermek için; sizin yetkilerinizle, gizli alanlarınız gizli kalarak.
