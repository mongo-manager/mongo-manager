# Süre dolumu (TTL)

Bir TTL indeksi, bir koleksiyonun her belgesini alanlarından birindeki tarihten belirli bir süre sonra siler — oturumları bir gün sonra, günlükleri bir ay sonra. Süre dolumu, bir koleksiyonun her TTL indeksi için belgelerinin ne zaman gittiğini gösterir: kaçının süresi dolmuş ama henüz silinmemiş, kaçı bir saat, bir gün, bir hafta içinde, daha sonra gidiyor ve kaçını hiç silmiyor.

Eklenti yalnızca okur. Veritabanında hiçbir şeyi değiştirmez ve hiçbir şey silmez.

## Nerede görünür

- **Koleksiyon sekmesi:** her koleksiyonun ve görünümün Belgeler, Aggregation ve diğer sekmelerinin yanında bir **Süre dolumu** sekmesi.

## Nasıl kullanılır

Bir koleksiyon açın, ardından **Süre dolumu** sekmesini. Sekme açılır açılmaz koleksiyonun indekslerini okur ve sayar; **Yeniden say**, tıklandığı andan itibaren yeniden sayar.

Her TTL indeksi bir karttır: alanı, bir belgenin alandaki tarihten ne kadar sonra silindiği (`expireAfterSeconds`; 0 tarihin kendisinde demektir) ve varsa kısmi filtresi. Belgeleri altı grupta sayılır:

- **Süresi doldu, henüz silinmedi:** süre geçti. Sunucunun TTL izleyicisi yaklaşık dakikada bir çalışır ve onları siler; yoğun bir sunucuda gecikebilir.
- **Önümüzdeki bir saatte**, **1–24 saat içinde**, **1–7 gün içinde**, **7 günden sonra:** her grup bir öncekinin bittiği yerde başlar.
- **Hiçbir zaman:** alan tarih taşımıyor (yok, ya da metin veya sayı), ya da kısmi bir indeks için belge filtresinin dışında.

**Göster**, bir grubun belgelerini seçen bir filtreyi Belgeler sorgusuna koyar.

## Örnek

`createIndex({ lastSeen: 1 }, { expireAfterSeconds: 86400 })` olan bir `sessions` koleksiyonunda:

```
lastSeen   Bir belgeyi lastSeen alanındaki tarihten 1 gün sonra siler
Süresi doldu, henüz silinmedi      0 belge
Önümüzdeki bir saatte             12 belge
1–24 saat içinde                 340 belge
1–7 gün içinde                     0 belge
7 günden sonra                     0 belge
Hiçbir zaman                       3 belge
```

Hiç gitmeyecek üçünün `lastSeen` alanında tarih yok: **Hiçbir zaman** üzerindeki **Göster** onları bulur.

## İzinler

- **Bu koleksiyonun tanımını okuma** (`collection:read`): indekslerini listelemek için.
- **Belgeleri okuma** (`documents:read`): her grubu salt okunur bir pipeline ile saymak ve Belgeler sorgusuna bir filtre koymak için.

Okumalar oturum açmış kullanıcının haklarıyla ve alan maskelemesiyle uygulama üzerinden yapılır: kullanıcıdan gizlenen bir TTL alanı sayılamaz ve grupları bunu söyler. Eklenti diğer koleksiyonları okuyamaz.

## Ayarlar

Yok.

## Sınırlar

- Her grup, TTL alanı üzerinde indeksinin hizmet edebildiği bir aralık olan tek bir pipeline'dır (**Hiçbir zaman** ve kısmi bir indeksin filtresi tüm koleksiyonu okuyabilir); her biri en fazla 10 saniye çalışır. Sayılamayan bir grup bunu ve nedenini söyler.
- Alanı birden fazla tarih taşıyan bir belge en erkeniyle silinir ve onun grubunda sayılır.
- Yalnızca TTL indeksleri okunur. Bir zaman serisi ya da kümelenmiş koleksiyonun kendi `expireAfterSeconds` değeri gösterilmez.
