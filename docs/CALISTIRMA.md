# Alas Takip V1 — çalıştırma ve dağıtım

Teknik sözleşme: `docs/V1-SPEC.md`. Ortam değişkenleri: `.env.example`.

## 1. Yerelde çalıştırma

Gereksinim: Node.js 22 veya üstü (`node -v`). Şifreyi bu belgeye, dosyaya ya da sohbete yazmayın; aşağıda `<şifre>` yer tutucudur.

1. **Paketi çöz.** `d/*.enc` dosyalarını düz dosyalara açar (çıktı `_acik/`, gitignore'da):
   ```
   node tools/decrypt.mjs "<şifre>"
   ```
   "Şifre yanlış" uyarısı gelirse dur ve şifreyi kontrol et.

2. **Veriyi göç ettir.** `_acik/` içeriğini `data/` altındaki sözleşme düzenine böler (`main/`, `ornek/`, `web/`, `rapor/`):
   ```
   npm run migrate
   ```
   Var olan `data/` üzerine `--force` olmadan yazmaz.

3. **Ortam değişkenlerini hazırla.** `.env.example` dosyasını `.env` olarak kopyala ve en az `SESSION_SECRET` ile (ilk kez) `ADMIN_USER` / `ADMIN_PASSWORD` değerlerini doldur:
   ```
   Copy-Item .env.example .env
   ```

4. **Başlat.** `npm start` `.env` dosyasını okumaz; bu yüzden yerelde şunu kullan:
   ```
   node --env-file=.env server/index.js
   ```
   Ya da değişkenleri kabukta tanımlayıp `npm start` çalıştır. Tarayıcıda `http://localhost:3000` açılır; giriş için `ADMIN_USER` ve `ADMIN_PASSWORD` kullanılır. Sağlık kontrolü: `http://localhost:3000/health`.

Geliştirirken otomatik yeniden başlatma için: `npm run dev`.

## 2. Testler

```
npm test
```

`node --test` (argümansız) çalışır; bağımlılık gerektirmez. Gerçek `data/` klasörü varsa ek olarak iş sayısı (126) da kontrol edilir.

## 3. Railway'e dağıtım

Gereksinim: Railway hesabı (Hobby plan) ve Railway CLI (`npm i -g @railway/cli`).

1. **Proje oluştur ve deploy et.** Repo kökünde:
   ```
   railway login
   railway init
   railway up
   ```
   `railway up` Dockerfile ile imajı derler ve servisi yayına alır.

2. **Bölge ve kapasite.** Servis ayarlarında bölgeyi **Amsterdam (EU West)** seç. Bu, Volume eklenmeden önce yapılmalı. Serverless **kapalı** olmalı. Replica sayısı **1**.

3. **Volume ekle.** Servise bir Volume bağla, mount yolu **`/data`**, başlangıç boyutu 1–5 GB. Volume bağlanmadan yazılan veri, yeniden deploy'da kaybolur.

4. **Variables.** Servis → Variables bölümüne ekle:
   - `SESSION_SECRET`: zorunlu. `.env.example` içindeki komutla üret.
   - `ADMIN_USER`, `ADMIN_PASSWORD`: ilk açılışta yönetici oluşturur. `users.json` doluyken yok sayılır.
   - `TRUST_PROXY=true`: Railway'in proxy zinciri iki atlamalı (kenar + iç). `1` veya `2` verildiğinde istemci IP'si yerine Railway'in iç adresi (100.64.x.x) görülür ve giriş hız sınırı (15 dakikada 5 deneme) herkesi tek kovada toplar. `true` ile gerçek istemci IP'si gelir (8 Ekim 2026'da canlıda doğrulandı).
   - `PUBLIC_URL=https://<alan-adi>`: sihirli linkler bu kökle üretilir. Verilmezse `X-Forwarded-Proto` "https, http" geldiğinden link `http://` çıkabilir.
   - `DATA_DIR=/data` Dockerfile'da tanımlı; Variables'a yazmak gerekmez. **Git Bash'ten yazarsanız** `MSYS_NO_PATHCONV=1` olmadan `/data` değeri `C:/Program Files/Git/data`'ya çevrilir ve uygulama Volume yerine geçici diske yazar (veri her deploy'da kaybolur — 8 Ekim 2026'da yaşandı; log satırı `dataDir="/app/C:/Program Files/Git/data"`).
   - `PORT` eklenmez; Railway verir. `NODE_ENV`, `TZ` Dockerfile'da tanımlı.

   **Windows notu:** Railway CLI'ı Git Bash'ten kullanırken her komutun başına `MSYS_NO_PATHCONV=1` koy (ör. `MSYS_NO_PATHCONV=1 railway variables --set DATA_DIR=/data`). PowerShell'de bu sorun yok. CLI 4.5.3'te `railway volume add` çöküyor (`Option::unwrap() on a None value`); Volume'u Railway panelinden ekle.

5. **Alan adı.** Settings → Networking: önce **Generate Domain** (`*.up.railway.app`) ile test et. Özel alan adı için **Custom Domain** ekle ve Railway'in istediği CNAME/TXT kayıtlarını DNS'e gir. Sertifika birkaç dakika sürebilir.

6. **Doğrula.** `https://<alan-adi>/health` çağrısında `"ok":true` ve `"dataWritable":true` görülmeli. Sonra `https://<alan-adi>/` giriş sayfasını aç.

7. **Veriyi yükle.** Yerel `data/` klasörünü canlıya göndermek için `tools/yukle-data.mjs` kullanılır (`PUT /api/admin/file`, yalnız yönetici). Şifre `ALAS_ADMIN_PASSWORD` ortam değişkeninden okunur, komut satırına yazılmaz:
   ```
   node tools/yukle-data.mjs --url https://<alan-adi> --user admin --data data
   ```
   Yükledikten sonra kalıcılığı sına: `railway redeploy -s <servis> -y` → `/health` içinde `lastPhotoDay` korunmalı. Sıfırlanıyorsa `DATA_DIR` yanlıştır (yukarıdaki Git Bash notu).

8. **Sihirli link üret.** Yönetici oturumuyla `POST /api/admin/magic-link` (`{"label":"patron","days":7,"maxDevices":3}`) → dönen `url` telefona gönderilir; Safari/Chrome'da açılır, "Ana Ekrana Ekle" yapılır.

**Deploy saati kuralı:** Volume'lu serviste her deploy 20–60 sn kesinti yapar. 07:00–08:00 ve 18:00–19:00 arasında deploy yapma.

**Yedek:** Railway panelinde Volume yedeklerinin açık olduğunu kontrol et.

## 4. Sorun giderme

1. **Konteyner açılıp hemen kapanıyor, logda `SESSION_SECRET` yazıyor.** Variables'a `SESSION_SECRET` eklenmemiş. Production'da zorunludur; yoksa uygulama kod 1 ile çıkar.
2. **`/health` içinde `"dataWritable":false`.** Volume bağlı değil ya da mount yolu `/data` değil. Volume ayarını kontrol edip yeniden deploy et.
   **`dataWritable:true` ama her deploy'da veri sıfırlanıyor.** `railway logs` içinde `dataDir=` satırına bak; `/data` değilse Variables'taki `DATA_DIR` bozuk (Git Bash yol çevirimi). Değişkeni sil ya da `MSYS_NO_PATHCONV=1` ile `/data` yaz.
3. **Pano "Pano verisi alınamadı" diyor.** `401` ise oturum yok; giriş yap. `500` veya `404` ise `data/main/` eksik; yerelde `npm run migrate` çalıştır, canlıda veriyi yükle.
4. **Build hatası (`npm ci`).** `package-lock.json` ile `package.json` uyuşmuyor. Yerelde `npm install` ile kilit dosyasını yenile ve commit et.
5. **Giriş olmuyor.** Şifreyi ve kullanıcı adını kontrol et; 15 dakikada 5 denemeden sonra giriş geçici olarak kapanır (429). Sihirli link "Bu bağlantıyı Safari/Chrome'da açın" diyorsa link WhatsApp veya Instagram içinde açılmıştır; linki tarayıcıda aç. Link süresi dolduysa yönetici yeni link üretmeli.
