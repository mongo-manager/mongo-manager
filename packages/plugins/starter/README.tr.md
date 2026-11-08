# Merhaba belgeler

Merhaba belgeler, bir koleksiyonun belgelerini basit bir tabloda listeler: `_id` ve belgelerin çoğunda bulunan alanlar. Mongo Manager eklentileri için başlangıç şablonudur; birkaç dakikada okunacak kadar küçüktür ve yerine kendi eklentinizi koymanız için hazırlanmıştır.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyonda, uygulamanın kendi sekmelerinden sonra bir **Merhaba** sekmesi. Belgeler filtresinin bıraktığı ilk 50 belgeyi listeler.
- **Sayfa:** kenar çubuğunda **Merhaba belgeler**. Bir koleksiyonun sekmesi etkinken açılırsa o koleksiyonun ilk 50 belgesini listeler; başka bir yerden açılırsa önce bir koleksiyon açmanızı ister.

## Nasıl kullanılır

- Bir koleksiyon açın ve **Merhaba** sekmesini seçin.
- Bir satırdaki **Aç** düğmesine tıklayarak o belgeyi Belgeler'de gösterin.
- Belgeleri yeniden okumak için **Yenile** düğmesine tıklayın; örneğin Belgeler filtresini değiştirdikten sonra.

Görünümlerde de çalışır: salt okunur olarak işaretlenirler ve eklenti hiçbir şey yazmaz.

## İzinler

- **Belgeleri okuma** (`documents:read`): açıldığı koleksiyonun belgelerini sizin adınıza, sizin yetkilerinizle ve uygulamanın maskelemesiyle listelemek için.

## Ayarlar

Yok.

## Sınırlar

- En fazla 50 belge ve `_id` dışında en fazla dört alan listelenir.
- Değerler tek satırlık metin olarak gösterilir ve 80 karakterde kesilir; iç içe belgeler ve diziler yalnızca boyutlarını gösterir.

## Bu eklentiden kendi eklentinizi yapmak

Bu README'yi kendi eklentinizinkiyle değiştirin: yöneticiler eklentiyi onaylamadan önce onu eklentinin ayrıntılar sayfasında okur. Başlık, paragraf, liste ve kod kullanın: bağlantılar, resimler, tablolar ve HTML düz metin olarak gösterilir.

Kendi eklentinizi yapmak için:

1. `mongo-manager-plugin.json` içinde `id`, `name`, `version`, `author`, `repository` alanlarını ve katkıları değiştirin.
2. Sayfanızı `main.js` ve `style.css` içinde yazın.
3. Her metni uygulamanın on dilinin hepsinde yazın (İngilizce, Türkçe, Çince, Japonca, İspanyolca, Portekizce, Korece, Almanca, Fransızca ve Rusça): sayfanın ve manifestin her metnini, her sürüm notunu ve bu README'yi; diğer dokuz dilin her biri için `README.md` dosyasının yanına bir `README.<lang>.md` ekleyin.
4. `<id>-<version>.tgz` dosyasını almak için `node scripts/pack.mjs` komutunu, kendi sunucunuzda denemek için `node scripts/pack.mjs --folder <veri-dizini>/plugins` komutunu çalıştırın.
5. Arşivi bir GitHub sürümünün (release) dosyası olarak yayımlayın.

Mongo Manager belgelerindeki Eklentiler rehberi her alanı, her yöntemi ve her kuralı anlatır.
