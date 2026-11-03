# Depolama raporu

Bir koleksiyonun belgeleri silindiğinde ya da küçüldüğünde WiredTiger boşalan alanı koleksiyonun dosyasında tutar ve yeni yazmalar için yeniden kullanır; dosya diskte küçülmez. Verisinin büyük bir bölümünü bırakmış bir veritabanı, hiçbir şeyin kullanmadığı gigabaytlar tutabilir. Depolama raporu, bir veritabanının her koleksiyonu için kapladığı yeri ve bunun ne kadarının boş alan olduğunu gösterir; Atlas ve Compass'ın depolama görünümlerinin, `db.collection.stats()` ve MongoDB'nin kendi yönergelerinin anlattığı gibi bu alanı `compact` ile geri vermeni sağlar.

## Nasıl kullanılır

Herhangi bir koleksiyonu ve onun **Depolama** sekmesini aç: rapor koleksiyonun bütün veritabanını kapsar.

1. Eklenti her koleksiyonun depolama istatistiklerini uygulama üzerinden okur (`$collStats`): ada göre en fazla ilk 500 koleksiyon, parçalar toplanarak. Görünümlerin kendi depolaması yoktur, listelenmezler.
2. Koleksiyonlar en çok geri kazanılabilir olan önce gelir. Her satır belgelerini, veri boyutunu, depolama boyutunu (diskte), indeks boyutunu, kendi dosyasında ve indekslerinin dosyalarında boş olan baytları ve bunun bu dosyaların ne kadarı olduğunu söyler. Toplamlar, boyutları bilinen koleksiyonları toplar.
3. Dosyalarının en az %20'si ve en az 10 MB boş olan bir koleksiyon **Sıkıştırmaya değer** olarak işaretlenir. Bunun altında WiredTiger alanı kendisi yeniden kullanır ve sıkıştırmanın maliyeti getirisinden fazladır.
4. İndekslerinin boyutlarını ve boş alanını görmek için bir koleksiyon seç, sonra:
   - **Tahmin et**, sıkıştırmanın ne geri vereceğini MongoDB'ye sorar (`dryRun` ile `compact`, MongoDB 8.0 ve sonrası; daha eski bir sunucu ya da mongos arkasındaki bir sunucu bunu söyler).
   - **Sıkıştır…**, uygulamadan onu sıkıştırmasını ister. Uygulama kendi iletişim kutusunu gösterir — sıkıştırmanın ne yaptığını, sunucuyu yavaşlatabileceğini — ve ancak koleksiyonun adını yazdıktan sonra çalıştırır. Ardından rapor yeniden okunur.

**Yenile** raporu yeniden okur. Rapor dakikada en fazla iki kez okunur: yarım dakika içinde aynısı gösterilir, bir sıkıştırma ise yeniden okutur.

Bir zaman serisi koleksiyonu listelenir ama burada sıkıştırılmaz: ölçümleri kendi kovalarında durur. Uygulamanın reddedeceği yerde de sıkıştırma sunulmaz — salt okunur bir bağlantı ya da kişisel veri kurallarının değerleri senden gizlediği yer.

## Sıkıştırma hakkında bilinmesi gerekenler

- Koleksiyonun ve indekslerinin dosyalarını yeniden yazar. Büyük bir koleksiyonda uzun sürebilir ve çalışırken sunucuyu yavaşlatır: bitene kadar sayfa sıkıştırıldığını söyler ve bir koleksiyonun aynı anda yalnızca bir sıkıştırması çalışır. Bir replica set'te yalnızca çalıştığı üye sıkıştırılır: her üyede çalıştır (önce ikinciller). Uygulamanın sorusu bunu ve MongoDB verdiğinde tahmini söyler.
- Bağlantının veritabanlarını yönetme hakkını gerektirir ve salt okunur bir bağlantıda asla çalışmaz. Her çalıştırma uygulamanın denetim günlüğüne yazılır.
- Eklentinin kendisi sunucuda hiçbir şey çalıştırmaz: uygulamaya sorar, uygulama da sana sorar.

## Kişisel veriler

Kişisel veri kurallarının değerleri senden gizlediği yerde koleksiyonun boyutları da gizlidir (ne kadar gizli veri olduğunu söylerlerdi): satırında **Gizli** yazar, toplamlara katılmaz ve onun için ne tahmin ne de sıkıştırma sunulur. Belge sayısı yine gösterilir.

## İzinler

- **Veritabanını oku:** veritabanının koleksiyonlarının depolaması ve sekmenin kendi koleksiyonu dışındaki bir koleksiyonun tahmini ya da sıkıştırılması.
- **Koleksiyon ayrıntılarını oku:** sekmenin koleksiyonunun tahmini ve sıkıştırılması.
