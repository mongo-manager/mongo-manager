# Anonimleştirici

Bir geliştiricinin bir hatayı yeniden üretmek için üretime benzer veriye ihtiyacı olur; bir ekip bir tedarikçiyle örnek paylaşmak ister; bir test ortamı kimsenin kişisel verisini tutmadan gerçek görünmelidir. Uygulamanın kendi anonim kopyası gizli değerlerin yerine `***` yazar. Anonimleştirici ise hâlâ asıl veri gibi görünen ve davranan veri üretir — Studio 3T'nin veri maskeleme özelliği, Hackolade ve veritabanı platformlarının maskeleme özelliklerinin yaklaşımı: aynı türden sahte değerler, birleştirmeleri çalışır tutan hash'ler, belgeler arasında karıştırılan değerler, biraz kaydırılan tarihler, gürültü eklenen sayılar.

## Nasıl kullanılır

Bir koleksiyonu ve onun **Anonimleştir** sekmesini aç.

1. Eklenti rastgele 100 belge örnekler ve alanlarını listeler (bir nesnenin ya da nesne dizisinin içindeki alan kendi başına listelenir; onu tutan nesne listelenmez — bazı belgeler orada nesne yerine bir değer tutuyorsa o da, o değerler için *nesne olmadığında* işaretiyle listelenir). Her alan bir teknik alır:
   - **Koru** — değer olduğu gibi.
   - **Sahte değer** — türüne uygun gerçekçi bir değer; adına ve türüne göre ya da seçtiğin türde (ad soyad, e-posta, telefon, sokak adresi, şehir, posta kodu, şirket, cümle, UUID, tarih…): e-posta, örnek bir alan adında e-posta kalır; telefon numarası hiçbir hattın olmadığı bir aralıkta.
   - **Tutarlı hash** — kopyanın tamamında aynı girdi aynı çıktıyı verir (bir e-posta, onu tutan her belgede aynı hash kalır, böylece yine onunla gruplayabilir ya da birleştirebilirsin), tür korunur (ObjectId ObjectId, tam sayı tam sayı kalır). Anahtarı sekme açıldığında çekilir ve asla kaydedilmez: iki oturum farklı hash'ler verir.
   - **Karıştır** — alanın değerleri belgeler arasında yer değiştirir: her değer hâlâ oradadır, hiçbiri kendi belgesinde değil.
   - **Tarihleri kaydır** — tarihler verdiğin gün kadar ± kaydırılır, bir belgenin her tarihi için aynı gün (bir kişinin olaylarının sırası korunur). Metin olarak yazılmış tarihler biçimlerini korur.
   - **Sayı gürültüsü** — sayılar verdiğin pay kadar ± değişir; tam sayı tam sayı kalır.
   - **Null**, **Kaldır**, **Maskele** (`***`).
   Bir `_id` yalnızca korunabilir, hash'lenebilir, sahte değer alabilir (ObjectId ya da UUID olarak), karıştırılabilir ya da kaldırılabilir (içe aktarma o zaman yenilerini verir): iki belgenin aynı `_id`'yi paylaşmasına yol açacak hiçbir şey yapılmaz.
   Bir kişiyi, adresi ya da hesabı adlandıran alanlar (adlar, e-postalar, telefonlar, sokaklar, posta kodları, doğum tarihleri, parolalar, IBAN'lar…) **Sahte değer** ile başlar; diğerleri **Koru** ile.
2. **Örnekte olmayan alanlar**: sonraki bir belgede olup örnekte olmayanlar ve örneğin yalnızca nesne gördüğü yerde bulunan bir değer varsayılan olarak dışarıda bırakılır; korumayı seçebilirsin.
3. Önizleme önce ve sonra beş belge gösterir ve her değişikliği izler. **Yeni değerler** yeni sahte değerler, karıştırmalar ve yeni bir hash anahtarı çeker.
4. **Kopyayı oluştur** en fazla 1.000 belgeyi (kaç tane olacağını sen seçersin) `_id` sırasıyla (her türden `_id`, MongoDB'nin sıraladığı gibi önce sayılar sonra ObjectId'ler) sayfa sayfa okur ve sayfada anonimleştirir. Kopya en fazla uygulamanın tek mesajda aldığı kadardır (yaklaşık 1 MB): fazlası sığmayacaksa bütün bir belgede kesilir ve sayfa bunu söyler.
5. Ardından:
   - **NDJSON kaydet** ya da **JSON kaydet** kopyayı dosya olarak kaydeder;
   - **İçe aktar…**, uygulamanın İçe Aktarma sihirbazını aynı veritabanının yeni bir koleksiyonunda (varsayılan olarak `<koleksiyon>_anonymised`) kopya dosyasıyla açar: içe aktarmayı orada denetler, eşler ve başlatırsın.

**Ayarları kaydet** her alanın tekniğini bir JSON dosyası olarak kaydeder (hash anahtarını ya da bir değeri asla); **Ayarları yükle** bir dosyayı yeniden uygular — dosyanın adlandırdığı ama bu koleksiyonda olmayan bir alan sayılır ve atlanır.

## Kişisel veriler

Kişisel veri kurallarının senden gizlediği bir alan asla korunmaz: eklentinin elinde onun için yalnızca `***` vardı. Maskelenebilir, sahte değer alabilir, null yapılabilir ya da kaldırılabilir; örnekte görünmeyen gizli bir alan da göründüğü her yerde maskelenir. Koleksiyonun kendisi hiç değişmez: kopya yalnızca senin kaydettiğin ya da aktardığın yere gider.

## İzinler

- **Belgeleri oku:** kopyanın yapıldığı belgeler.
- **Veritabanını oku:** kopyayı veritabanının başka bir koleksiyonu için İçe Aktarma sihirbazına vermek.
