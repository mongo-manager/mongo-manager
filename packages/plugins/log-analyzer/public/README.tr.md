# Log analizcisi

Bir veritabanı yavaşladığında logu nedenini söyler: yavaş sorgular, dizinsiz taramalar, hatalar ve bağlantılar. Onu elle okumak ise yavaştır. Log analizcisi bir mongod ya da mongos log dosyasını tarayıcınızda okur ve özetler — mtools'un `mloginfo --queries` komutunun komut satırında, NoSQLBooster'ın log ayrıştırıcısının kendi penceresinde ve Atlas'ın Query Insights'ının yönettiği kümelerde yaptığı gibi.

## Nasıl kullanılır

1. Kenar çubuğunda **Log analizcisi**ni açın.
2. Bir log dosyasını sayfaya bırakın ya da seçin: MongoDB 4.4 ve sonrasının yapılandırılmış JSON logları, eski metin loglar ya da bunların gzip hâlleri (`mongod.log.gz`; birleştirilmiş birkaç gzip parçasından oluşan tek dosya da), 2 GB'a kadar (gzip'liyse açıldığında). Bir ilerleme çubuğu ve **Durdur** ile akış olarak okunur. 1 MB'tan uzun bir satır — hiçbir log satırı öyle değildir — atlanır ve okunmayan olarak sayılır; yarım kalmış bir gzip dosyası, ondan önce okunanla birlikte, öyle olduğu söylenerek gösterilir.
3. Bulduklarını okuyun:
   - **Özet:** satırlar, log satırı olarak okunmayan satırlar, zaman aralığı, yavaş işlemler, hatalar, uyarılar, sunucunun sürümü ve adı. Önem dereceleri ve bileşenler adıyla 16'ya ve 200'e kadar tutulur; ötekilerin satırları sayılır ve söylenir (hatalar ve uyarılar her zaman sayılır).
   - **Zaman çizelgesi:** dakika başına log satırları ve yavaş işlemler (daha uzun bir log için saat, gün, hafta ya da dört hafta başına). Zamanı 2009'dan önce ya da şimdiden bir günden fazla sonra olan bir satır — bozuk bir saat — sayılır ama aralığa ve zaman çizelgesine katılmaz; sayfa kaç tane olduğunu söyler.
   - **Yavaş işlemler:** ad alanı, işlem ve **sorgu biçimine** göre gruplanır — değerleri `?` ile değiştirilmiş sorgu; böylece benzer sorgular birlikte sayılır. Her biri için: sayı, toplam, ortalama, p95 (sürelerinden en çok 1.000 tanelik bir örnekten) ve en yavaş süre, planlar (dizinsiz bir tarama işaretlenir) ve döndürülenlere karşı okunan anahtarlar ve belgeler. Toplam süre, sayı, en yavaş ya da p95'e göre, en yüksek önce sıralayın: tablonun üstünden ya da sütun başlığından; sıralanan sütun işaretlenir. **Biçimi kopyala** ya da bir satırı yazıldığı gibi görmek için **Örnek**.
   - İletiye göre **hatalar ve uyarılar**, ne sıklıkta ve ne zaman oldukları.
   - **Bağlantılar:** kaç tanesinin açılıp kapandığı, aynı anda en çok kaç tane olduğu ve uygulamalarıyla her istemci (en çok 1.000 istemci; ötekilerin satırları sayılır ve söylenir).
4. Bir hesap tablosu için **Yavaş işlemleri CSV olarak kaydet** — uygulama en çok 1 MB kaydeder; çok yoğun bir logun CSV'si en yavaş biçimlerini bütün satırlar hâlinde tutar ve sayfa kaç satırın girmediğini söyler — ya da **Başka bir dosya oku**.

## Gizlilik

Dosya tarayıcınızdan asla çıkmaz: eklentinin sayfası hiçbir adrese erişemez ve veritabanlarınızdan hiçbir şey okumaz. Biçimler değer taşımaz. Bir satırın yazıldığı hâli — değer içerebilir — yalnızca örneğini istediğinizde gösterilir ve hiçbir yere gönderilmez.

## İzinler

Yok: yalnızca verdiğiniz dosyayı okur.
