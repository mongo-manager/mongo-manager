# Parça anahtarı çözümleyici

Parça anahtarı, parçalı bir koleksiyonun belgelerinin parçalara nasıl dağılacağını belirler ve kötü bir seçimi geri almak zordur: çok az farklı değer varsa chunk'lar bölünemez, bir değeri çok sayıda belge tutuyorsa onların yükünü tek bir parça taşır, her eklemeyle büyüyen bir değerde (bir tarih, bir sayaç, bir ObjectId) her ekleme aynı parçaya düşer. MongoDB 7.0, parçalamadan önce bir adayı ölçmek için `analyzeShardKey` komutunu ekledi; Atlas ve MongoDB'nin belgeleri yanıtını aynı biçimde değerlendirir. Parça anahtarı çözümleyici bu komutu senin için çalıştırır ve adayları yan yana koyar.

## Nasıl kullanılır

Bir koleksiyonu ve onun **Parça anahtarı** sekmesini aç.

1. Eklenti koleksiyonun belgelerinden örnek alır (200) ve alanlarını sunar. Kişisel veri olarak senden gizlenen alanlar hiç sunulmaz; bir dizinin içindeki alanlar, dizi tutan alanlar (MongoDB bunları parça anahtarında kabul etmez) bütün hâlindeki nesneler ve tamsayı gibi adlandırılmış alanlar (`"0"`: sayfa anahtardaki yerlerini koruyamazdı) da sunulmaz.
2. Bir aday kur: bir alan seç, **Artan** ya da **Hash**, sonra **Alan ekle**; bir aday en fazla beş alan, bunlardan en fazla bir hash alan tutar. Bir çip bir alanı kaldırır.
3. **Çözümle**, MongoDB'den adayı uygulama üzerinden ve senin adına çözümlemesini ister: anahtar özellikleriyle `analyzeShardKey`, en fazla 10.000 belge örnekleyerek.
4. En fazla altı aday yan yana durur. Her biri için:
   - **Farklı değerler** — 1.000'den itibaren iyi, 100'den itibaren orta, altında zayıf (benzersiz bir anahtar her zaman iyidir);
   - **En sık değer** — onu tutan örneklenmiş belgelerin payı: %5'in altında iyi, %20'nin altında orta, %20'den itibaren zayıf;
   - **Monotonluk** — her eklemeyle büyüyen bir anahtar zayıftır; hash bir anahtar onu dağıtır ve iyidir;
   - anahtarın benzersiz olup olmadığı, kaç belgenin örneklendiği, ortalama boyutları ve sayılarıyla birlikte en sık beş değer;
   - üçünün en kötüsü olan bir **Sonuç**.

Bir adayın × düğmesi onu kaldırır.

## MongoDB'nin söyleyemeyebileceği

- Tek başına çalışan bir sunucu çözümleyemez: `analyzeShardKey` bir replica set ya da parçalı küme ister.
- 7.0'dan önceki MongoDB'de bu komut yoktur.
- MongoDB anahtarla başlayan bir indeks ister: yoksa eklenti oluşturulacak indeksi söyler ve **Kopyala** kabuk komutunu panoya koyar. Senin yerine hiçbir şey oluşturulmaz.

## Kişisel veriler

En sık değerler koleksiyonun kendi değerleridir. Kişisel veri kuralları koleksiyona senin için uzanıyorsa uygulama çözümlemeyi reddeder (gizli değerleri söylerdi) ve sayfa nedenini söyler.

## İzinler

- **Belgeleri oku:** alanların geldiği örnek belgeler ve ortak değerleri veri olan çözümleme.
