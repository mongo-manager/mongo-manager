# Kişisel veri bulucu

Kişisel veri bulucu, bir koleksiyonun kişisel veri taşıyan alanlarını — e-posta adresleri, telefon numaraları, kart numaraları, IBAN'lar, kimlik numaraları, IP adresleri, adlar, adresler, doğum tarihleri, parolalar ve anahtarlar — arar; böylece kimse görmemesi gerekeni görmeden önce kişisel veri kurallarıyla gizlenebilirler. Koleksiyonun belgelerinden rastgele bir örnek okur ve bulduğu her alanı değerlerinden ve adından, ne kadar emin olduğu ve nedeniyle birlikte söyler.

Eklenti yalnızca okur. Hiçbir değer maskesiz gösterilmez (`u•••@e•••.com`, `+•• ••• ••• •• 67`); hiçbiri saklanmaz ya da bir yere gönderilmez: değerler yalnızca ayırt edilmek için okunur.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyonun Belgeler, Aggregation ve diğer sekmelerinin yanında bir **Kişisel veri bul** sekmesi.

## Nasıl kullanılır

Bir koleksiyon açın, ardından **Kişisel veri bul** sekmesine geçin. Sekme açılır açılmaz rastgele 300 belgelik bir örnek alır (o kadar büyük belge tek bir yanıta sığmazsa 60); **Yeniden tara** yeni bir örnek çeker.

Bulunan her alan bir satırdır:

- **Taşıdığı:** neye benzediği — e-posta adresi, telefon numarası, kart numarası, IBAN, kimlik numarası, IP adresi, kişi adı, adres, doğum tarihi ya da parola veya anahtar.
- **Ne kadar emin:** değerlerinin çoğu o türdense (ya da değerleri ve adı uyuşuyorsa) **Yüksek**, birçoğu öyleyse ya da adı bunu söylüyorsa **Orta**, yalnızca bazı değerleri öyleyse ya da adı söylediği hâlde değerleri benzemiyorsa **Düşük**.
- **Neden:** örnekteki değerlerinden kaçının ona benzediği ve adının bunu söyleyip söylemediği.
- **Örnekler:** değerlerinden en fazla ikisi, maskelenmiş.

Olası alanlar (yüksek ve orta) seçili gelir; istediğinizi işaretleyin ya da kaldırın. **Kural olarak öner**, koleksiyonun **Kişisel veriler** bölümünü bu eklentinin önerisi olarak listelenen seçili alanlarla açar: bağlantının bir yöneticisi her birini orada (ya da hepsini birden) ekler; o andan sonra kişisel verileri göremeyenler değerlerini `***` olarak görür. Eklentinin sözüyle hiçbir şey kaydedilmez. **Listeyi kopyala**, seçilen alanları bir yöneticiye göndermek için her satıra bir tane olacak şekilde (`veritabanı.koleksiyon.alan`, taşıdığı, ne kadar emin) kopyalar.

## Değerler nasıl ayırt edilir

- **E-posta adresleri** ve **IP adresleri** (IPv4 ve IPv6; `12:30:45` gibi bir saat değildir).
- Bir kart ağının aralığında ve uzunluğunda olan (Visa, Mastercard, Mir, American Express, Discover, UnionPay, Diners Club, JCB, Troy) ve Luhn denetimini geçen **kart numaraları** — tek başına Luhn denetimi her on sayıdan birini alırdı.
- mod 97 denetimini geçen **IBAN'lar** (Türkiye'ninki ayrıca 26 karakter).
- **Kimlik numaraları:** iki kontrol basamağı tutan T.C. kimlik numaraları ve `123-45-6789` biçiminde yazılmış ABD sosyal güvenlik numaraları.
- Telefon numarası gibi yazılmış 9 ile 15 basamaklı **telefon numaraları**: `+` ya da `00` ile, ayırıcılarla ya da 9 veya 10 basamaktan önce bir 0 ile. Çıplak bir sayı ya da sayı olarak saklanmış bir değer (bir koordinat, bir tutar) yalnızca telefon gibi adlandırılmış bir alanda ve yalnızca tam sayıysa telefon sayılır.
- Onları üretenin yazdığı biçimde **parolalar ve anahtarlar**: bcrypt, Argon2 ve scrypt karmaları, JSON Web Token'lar, AWS erişim anahtarları, GitHub ve Stripe token'ları, özel anahtarlar.
- **Adından:** `email`, `phoneNumber`, `iban`, `cardNumber`, `tckn`, `ssn`, `passportNumber`, `ipAddress`, `firstName`, `lastName`, bir kişinin `name` alanı (`customer.name`), `billingAddress`, `street`, `postalCode`, `birthDate`, `dateOfBirth`, `password`, `apiKey`, `accessToken` ve benzerleri, İngilizce, Türkçe ve uygulamanın diğer dilleri (`eposta`, `telefon`, `soyad`, `dogumTarihi`, `telefono`, `nachname`, `date_naissance`, `телефон`, `电话`, `電話番号`, `전화번호`…). Verinin kendisini değil veri hakkında bir şeyi söyleyen ad sayılmaz: `emailVerified`, `phoneType`, `passwordChangedAt`, `isMobile`.

Bir nesnenin ya da dizinin içindeki alan, bir kişisel veri kuralının adlandırdığı gibi adlandırılır: bir kişiler dizisindeki e-posta için `contacts.email`.

## Örnek

Bir `users` koleksiyonunda:

```
Alan        Taşıdığı              Ne kadar emin   Neden                                      Örnekler
email       E-posta adresi        Yüksek          200 değerden 200 tanesi; adı da bunu söylüyor   u•••@e•••.com
phone       Telefon numarası      Yüksek          196 değerden 196 tanesi; adı da bunu söylüyor   +•• ••• ••• •• 67
apiToken    Parola ya da anahtar  Yüksek          Adı bunu söylüyor                          ••••••••
firstName   Kişi adı              Orta            Adı bunu söylüyor                          A•••
```

Bulunan bir parola ya da anahtar için bir not çıkar: bir kural onu veritabanında değil, uygulamada görünümden gizler — bir parola yavaş bir karma (hash) olarak, bir anahtar bir gizli bilgi kasasında saklanmalıdır. Adı parola olduğunu söyleyen bir alan, değerleri neye benzerse benzesin parola olarak gösterilir.

## Görünümler

Bir görünüm koleksiyon gibi okunur ama verisi kaynağınındır: kurallar okuduğu koleksiyonda önerilir; oradaki kurallar görünüme de uzanır. **Kural olarak öner** bir görünümde kapalıdır.

## İzinler

- **Belgeleri okuma** (`documents:read`): koleksiyonun belgelerinden örnek almak ve alanları kişisel veri olarak önermek için.

Okumalar oturum açmış kullanıcının haklarıyla ve alan maskelemesiyle uygulama üzerinden yapılır: sizden zaten gizlenen bir alan `***` olarak gelir, asla veri sayılmaz ve zaten gizli olarak adlandırılır. Önerilen alanlar yalnızca bağlantının bir yöneticisine (onu yönetebilen kişiye) sunulabilir; başkası için **Kural olarak öner** bunu söyler, **Listeyi kopyala** da onları iletmek için oradadır.

## Ayarlar

Yok.

## Sınırlar

- Bir örneklem: az sayıda belgede kişisel veri taşıyan bir alan örneklemde görünmeyebilir. Alan başına 200 değer, bir dizinin 50 öğesi ve altı düzey derinlik okunur.
- Hiçbir kuralın adlandıramayacağı bir alan — noktalı, `$` ile başlayan, gizli karakter ya da baştaki/sondaki boşluk taşıyan bir anahtar ya da 512 baytı aşan bir kural — nedeniyle birlikte listelenir ama seçilemez.
- Bir seferde en fazla 50 alan önerilir: sekme bunu siz önermeden önce söyler ve Kişisel veriler bölümü görünürken açık kalır; diğerleri için geri dönebilirsiniz.
- Kişisel veriler bölümü önerilen alanlardan yalnızca koleksiyonun bir örneğinin taşıdıklarını sunar; taşımadığı bir alan sunulmaz olarak listelenir.
- Adlar ve adresler yalnızca alanın adından ayırt edilir: `title` adlı bir alandaki kişi adı bulunmaz.
