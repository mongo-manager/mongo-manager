# Grafikler

Grafikler, bir koleksiyonun değerlerini çizer: bir alanın her değerini kaç belgenin taşıdığını, bir sayının ya da toplamın zaman içinde nasıl değiştiğini, bir sayının nasıl dağıldığını ya da iki sayının birbiriyle ilişkisini. Her grafiğin yanında bir özet tablosu vardır ve tablonun her satırı kendi belgelerini Belgeler sekmesinde gösterebilir.

Eklenti yalnızca okur. Veritabanında hiçbir şeyi değiştirmez.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyon ve görünümde Belgeler, Aggregation ve diğer sekmelerin yanında bir **Grafikler** sekmesi.

## Nasıl kullanılır

Bir koleksiyon açın, ardından **Grafikler** sekmesine geçin.

1. Bir grafik türü seçin: **Çubuk**, **Zamana göre**, **Halka**, **Histogram** ya da **Saçılım**.
2. Alanı seçin (Zamana göre için bir tarih alanı, Histogram için bir sayısal alan, Saçılım için X ve Y olarak iki sayısal alan).
3. Çubuk, Halka ve Zamana göre için bir **Ölçü** seçin: Adet ya da başka bir sayısal alanın Toplam, Ortalama, En küçük veya En büyük değeri.
4. Zamana göre için bir **Dönem** seçin: Saat, Gün, Hafta, Ay ya da Yıl.
5. **Hangi belgeler** çizilecek, seçin: **Belgeler filtresi** (Belgeler sekmesindeki sorgu) ya da **Tüm koleksiyon**.

Seçimler tamamlanınca grafik hemen çizilir ve her değişiklikte yeniden çizilir. Değerini görmek için imleci bir çubuğun, dilimin ya da noktanın üzerine getirin. Grafiğin altındaki **Veri** tablosu çizilenleri listeler; **Göster**, o satırın belgelerini seçen bir filtreyi Belgeler sorgusuna koyar.

## Örnek

`status` alanı ve `createdAt` tarihi olan bir `orders` koleksiyonu:

- Çubuk, alan `status`, ölçü Adet: her durum için bir çubuk, en büyüğü başta.
- Zamana göre, tarih alanı `createdAt`, dönem Ay, ölçü `total` alanının Toplamı: aylık ciro.
- `total` alanının Histogramı: sipariş tutarlarının 12 eşit aralığa nasıl dağıldığı.

Çubuk grafikte `shipped` satırındaki **Göster**, Belgeler'e şu filtreyi koyar:

```json
{ "status": { "$eq": "shipped" } }
```

## Grafik türleri

- **Çubuk:** metin, sayı, doğru/yanlış ya da ObjectId alanının değerleri, gruplanıp sayılmış (ya da toplanmış, ortalaması alınmış…) olarak, en büyüğü başta. Eksik değer kendi başına bir çubuktur.
- **Zamana göre:** bir tarih alanının her dönemindeki belgeler; sunucunun `$dateTrunc` işleciyle, UTC olarak.
- **Halka:** Çubuk gibi, ama bir bütünün payları olarak.
- **Histogram:** bir sayısal alan, en küçük ve en büyük değeri arasında eşit genişlikte 12 aralıkta.
- **Saçılım:** aynı belgelerin iki sayısal alanı, noktalar olarak.

## İzinler

- **Belgeleri okuma** (`documents:read`): grafikler, açık koleksiyonda çalıştırılan aggregation pipeline'larıdır; alan listesi de belgelerinden alınan bir örnekten gelir.

Okumalar uygulama üzerinden, oturum açmış kullanıcının yetkileri ve alan maskelemesiyle yapılır. Eklenti başka koleksiyonları, indeksleri ya da açıldığı koleksiyonun dışındaki hiçbir şeyi okuyamaz.

## Ayarlar

Yok.

## Sınırlar

- Alan listesi rastgele 200 belgelik bir örnekten gelir. Bu belgelerin hiçbirinde bulunmayan bir alan listede yer almaz. Büyük belgelerden daha azı örneklenir: sayfaya giden tek bir cevaba (1 MB) sığacak kadarı.
- İç içe alanlar iki düzeye kadar sunulur (örneğin `address.city`).
- Çubuk en büyük 12 grubu, Halka 7 grubu gösterir. Geri kalanı **Diğer** altında toplanır ve tablo, Diğer'in neleri kapsadığını söyler.
- Zamana göre en yeni 1.000 dönemi gösterir. Daha fazlası varsa eski dönemler dışarıda kalır ve grafik bunu belirtir; onları görmek için daha uzun bir dönem seçin.
- Histogram 12 aralık kullanır.
- Saçılım, iki sayıyı da taşıyan belgelerden en fazla 1.000 belgelik rastgele bir örnek çizer.
- Bir dizinin içindeki değer tarih ya da sayı olarak çizilmez: bir dizi, zamanda bir an değildir.
- Her pipeline en fazla 10 saniye, disk kullanmadan ve tek seferde bir tane çalışır. Çok büyük bir koleksiyondaki grafik zaman aşımına uğrayabilir; Belgeler filtresiyle daraltılabilir.
- Grafikler sunucuda hesaplanır; tarayıcıya yalnızca gruplanmış sonuçlar ulaşır.
