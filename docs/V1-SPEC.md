# Alas Takip V1 — Teknik Spesifikasyon (Railway, canlı)

Tarih: 8 Ekim 2026. Bu belge V1 kodunu yazan herkesin (insan/ajan) uyacağı sözleşmedir. Gerekçeler için `PATRON-PLANI.md` §3.

## 0. İlkeler
- Mevcut pano (`_acik/app.html`, satır 283–594 render kodu) **korunur**; veri artık `GET /api/pano.json`'dan gelir. PANO_DATA'nın şekli değişmez.
- Tek Fastify servisi, Node ≥ 22, ESM (`"type": "module"`), harici veritabanı yok: tüm kalıcı veri `DATA_DIR` altında JSON + dosya (Railway'de `/data` Volume, yerelde `./data`).
- Dil: kod yorumları, log mesajları, kullanıcıya görünen metinler **Türkçe**. Kimlik/ad/dizin adları ASCII (`sef`, `rapor`).
- Hiçbir şey uydurulmaz: veri yoksa API boş döner, pano "girilmedi" der.
- Gizli bilgi (şifre, oturum gizi) asla repoya/loga yazılmaz. `SESSION_SECRET` ortam değişkeni; dev'de yoksa rastgele üretilir ve uyarı loglanır.

## 1. Dizin yapısı
```
alas/
  package.json          scripts: start | dev | test | migrate   (hazır; bağımlılıklar kurulu)
  Dockerfile, railway.json, .dockerignore, .env.example
  server/
    index.js            Fastify kurar, eklentiler, rotalar, 0.0.0.0:PORT dinler; kapanışta oturumları flush eder
    config.js           env okuma + varsayılanlar + doğrulama (aşağıda)
    store.js            JSON yardımcıları: readJson(p, fallback), writeJsonAtomic(p, obj) (tmp+rename), appendLine(p, str), ensureDir(p), safeJoin(root, rel) (path traversal engeli)
    auth.js             kullanıcılar, oturumlar, sihirli linkler, çerez, rol hook'ları (bkz. §4)
    audit.js            audit(req, action, detail) → DATA_DIR/audit.jsonl
    pano.js             buildPano(dataset) → PANO_DATA (bkz. §3), ETag, bellek önbelleği
    routes/health.js    GET /health
    routes/auth.js      POST /api/login, GET /api/me, GET /g/:token, GET /cikis
    routes/pano.js      GET /api/pano.json
    routes/files.js     GET /web/*, GET /rapor/*   (oturum gerekli; DATA_DIR'dan)
    routes/admin.js     /api/admin/* (yalnız admin)
  public/               oturumsuz statik (hiç veri içermez)
    index.html          giriş sayfası
    app.html            pano (değiştirilmiş kopya)
    sw.js, manifest.webmanifest, icon-192.png, icon-512.png
    fonts/              Barlow 400/500/600, Barlow Condensed 600/700 (woff2, @fontsource'tan kopya) + fonts.css
  tools/
    decrypt.mjs                 (var) şifreli paketi _acik/ altına çözer
    migrate-from-static.mjs     _acik/ → data/ (bkz. §6)
    yukle-data.mjs              yerel data/ → uzak sunucu (PUT /api/admin/file)
  test/
    pano.test.js, auth.test.js, store.test.js   (node:test, bağımlılıksız)
  data/                 (gitignore) = Railway /data
  docs/V1-SPEC.md       bu belge
```
Kök dizindeki eski GitHub Pages dosyaları (`index.html`, `sw.js`, `app.html`, `ornek/`, `d/`, `check.enc`, `manifest.webmanifest`, ikonlar, `.nojekyll`) **dokunulmaz**; canlıya geçişte ayrıca ele alınacak.

## 2. Ortam değişkenleri (`server/config.js`)
| Değişken | Varsayılan | Not |
|---|---|---|
| `PORT` | 3000 | Railway verir |
| `HOST` | 0.0.0.0 | |
| `DATA_DIR` | `./data` | Railway'de `/data` |
| `PUBLIC_DIR` | `./public` | |
| `SESSION_SECRET` | dev: rastgele + uyarı; prod (`NODE_ENV=production`): **zorunlu**, yoksa çıkış 1 | çerez imzası |
| `ADMIN_USER` / `ADMIN_PASSWORD` | — | Açılışta `users.json` boşsa bu admin oluşturulur ve loglanır ("admin oluşturuldu: <user>"); şifre loglanmaz |
| `TZ` | Europe/Istanbul | tarih dizgileri için `Intl.DateTimeFormat('sv-SE',{timeZone})` kullan, `TZ`'ye güvenme |
| `TRUST_PROXY` | prod: true | Railway edge arkasında IP için |
| `LOG_LEVEL` | info | |

## 3. Veri düzeni (`DATA_DIR`)
```
DATA_DIR/
  users.json        [{ username, role, salt, hash, createdAt, disabled }]      role ∈ admin | sef | pilot | patron
  sessions.json     { [sid]: { username, role, createdAt, expiresAt, lastSeen, ua } }
  tokens.json       { [token]: { role:"patron", label, createdAt, expiresAt, maxDevices, uses:[{at, ua, ip}] } }
  audit.jsonl       {ts, user, role, action, detail, ip} satırları
  main/             dataset "main" (gerçek)
    project.json    PANO_DATA.project (title, place, source, exported, statusDate, projectStart, projectFinish, handover, baseline, forecastHandover, baselineHandover)
    tasks.json      PANO_DATA.tasks (126 iş; alanlar: id, uid, name, level, summary, milestone, start, finish, dur, pct, critical, slack, cal, deadline, qty, crew, bStart, bFinish, actualStart, actualFinish, reason)
    days.json       PANO_DATA.days  ([{date, total, videos, sessions:[{id, start, end, n, photos:[{f, t, src, w, h, lat, lon, alt}]}]}]) — src göreli: "web/2026-10-07/x.jpg"
    video.json      PANO_DATA.video (null olabilir)
    logs/<date>.json   günlük rapor (PANO_DATA.logs elemanı: {date, saved, weather, entries, extra, crews, machines, notes})
    crewplan.json   PANO_DATA.crewPlan ({ [date]: { [meslek]: n } })
    reports.json    PANO_DATA.reports ([{date, url:"rapor/<date>/", pdf:"rapor/<date>/rapor.pdf", people, planned}])
    trades.json     PANO_DATA.trades (meslek listesi; yoksa [])
    banner.json     { text: "" }
    meta.json       { photosGenerated, importedAt, source }
  ornek/            dataset "ornek" — aynı yapı; yalnız admin görür
  web/<date>/*.jpg, web/video/*.mp4     1600 px fotoğraflar, 720p video (iki dataset aynı dosyaları paylaşır)
  rapor/<date>/index.html (+ rapor.pdf)  A4 günlük rapor
```
**`buildPano(dataset)`** şu nesneyi döner (anahtar sırası ve adları birebir; app.html bunu bekler):
`{ project, generated, photosGenerated, banner, tasks, days, logs, video, reports, trades, crewPlan }`
- `generated`: sunucu zamanı Europe/Istanbul `"YYYY-MM-DD HH:mm"`; app.html "bugün"ü buradan alır (`generated.slice(0,10)`).
- `logs`: `logs/*.json` tarih sırasıyla. `banner`: `banner.json.text`.
- ETag: içerik SHA-1; `If-None-Match` → 304. Bellek önbelleği dosya mtime'larıyla geçersizlenir (her istekte `stat`, ucuz).
- Dataset `main` dışında yalnız `ornek` kabul; başkası 404.

## 4. Kimlik ve oturum (`server/auth.js`)
- Şifre: `crypto.scrypt(password, salt, 64)`; karşılaştırma `timingSafeEqual`. Kullanıcı adı küçük harf, `[a-z0-9._-]{2,32}`.
- Çerez `alas_sid`: `HttpOnly; SameSite=Lax; Path=/; Secure` (prod). Değer = sid (32 bayt base64url) + `.` + HMAC-SHA256(sid, SESSION_SECRET) ilk 16 bayt base64url. Doğrulama HMAC'i kontrol eder, sonra `sessions.json`.
- Süre (kayan): patron 90 gün, sef/pilot 30 gün, admin 7 gün. `lastSeen` en fazla 10 dakikada bir yazılır (disk yazımı azaltmak için). Süresi dolanlar her saat temizlenir.
- `req.user = { username, role }` veya `null`. Yardımcılar: `requireAuth` (401 JSON `{error:"giris-gerekli"}`; navigate isteğinde — `Accept: text/html` — `302 /?next=<path>`), `requireRole("admin")` (403).
- `POST /api/login` gövde JSON veya form (`username`, `password`, `next?`). Başarı: oturum + `{ok:true, role, next}` (form isteğiyse `302 next||/app.html`). Hata: 401 `{error:"sifre-yanlis"}` (kullanıcı var/yok ayırt edilmez). Rate limit: 5 deneme / 15 dk / IP (`@fastify/rate-limit`, sadece bu rota).
- Sihirli link `GET /g/:token` (patron için, şifresiz): token 32 bayt base64url; `tokens.json`'da, süresi geçmemiş, `uses.length < maxDevices` ise **patron** oturumu açar (90 gün), `uses`'a ekler, `302 /app.html`. Webview tespiti (UA içinde `wv`, `FBAN`, `FBAV`, `Instagram`, `WhatsApp`, `Line/`): oturum AÇMAZ, token yakmaz, Türkçe tek sayfa döner: "Bu bağlantıyı Safari/Chrome'da açın" + aynı link + kopyala düğmesi. Geçersiz/eski token: 410 Türkçe sayfa.
- `GET /cikis`: oturumu siler, çerezi temizler, `302 /`.
- `GET /api/me` → `{ username, role }` veya 401.
- Her giriş/çıkış/sihirli link kullanımı `audit`'e yazılır.

## 5. Rotalar
| Rota | Kim | Davranış |
|---|---|---|
| `GET /health` | herkes | `{ ok:true, dataWritable, lastPhotoDay, lastLogDay, uptimeSec, version }`; `dataWritable`: DATA_DIR'a `.write-test` yazıp siler; hata olsa da 200 döner ama `ok:false` |
| `GET /` | herkes | `public/index.html` (giriş). Oturumu olan `/app.html`'e yönlenir (`?next` varsa oraya) |
| `GET /app.html`, `/sw.js`, `/manifest.webmanifest`, ikonlar, `/fonts/*` | herkes | `public/` statik; `app.html` veri içermez. `Cache-Control`: fontlar/ikonlar 30 gün immutable; html/sw no-cache |
| `GET /api/pano.json?dataset=main` | oturum | §3; `dataset=ornek` yalnız admin; `Cache-Control: no-store` + ETag |
| `GET /web/*`, `GET /rapor/*` | oturum | `DATA_DIR/web`, `DATA_DIR/rapor` altından `reply.sendFile` (`@fastify/static` `serve:false`); `web/*` 30 gün immutable, `rapor/*` no-cache; traversal → 400 |
| `POST /api/admin/users` | admin | `{username, password, role}` → oluştur/şifre değiştir |
| `GET /api/admin/users` | admin | şifresiz liste |
| `POST /api/admin/magic-link` | admin | `{label, days=2, maxDevices=3}` → `{ url, token, expiresAt }` (url: `${origin}/g/${token}`) |
| `GET /api/admin/sessions` · `DELETE /api/admin/sessions/:sid` | admin | listele / düşür |
| `PUT /api/admin/file?path=<rel>` | admin | ham gövde (≤ 100 MB) → `DATA_DIR/<rel>` (atomik); `rel` yalnız `web/`, `rapor/`, `main/`, `ornek/` altına; `tools/yukle-data.mjs` bunu kullanır |
| `POST /api/admin/rapor/:dataset/:date` | admin | gövde = günlük rapor JSON → `logs/<date>.json`; `crews` varsa `crewplan.json`'a dokunmaz |
| `GET /api/admin/audit?n=50` | admin | son n satır |
| Güvenlik başlıkları (hepsi) | | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Robots-Tag: noindex, nofollow`, prod'da `Strict-Transport-Security: max-age=15552000`. CSP V1'de **yok** (app.html inline script/style; sonraki sürümde nonce) |

## 6. `tools/migrate-from-static.mjs`
Kullanım: `node tools/migrate-from-static.mjs [--acik _acik] [--data data]`
1. `_acik/app.html` ve `_acik/ornek/index.html` içinden `window.PANO_DATA = {...};` JSON'unu çıkar (regex: `/window\.PANO_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/`) → sırasıyla `data/main/`, `data/ornek/` altına §3 dosyalarına böl (`logs/` her log ayrı dosya; `meta.json.photosGenerated`).
2. `_acik/web/**` → `data/web/**` (kopya). `_acik/ornek/web/**` aynı dosya adları → zaten varsa atla (iki dataset dosyaları paylaşır; `src` yolları `web/...` göreli olduğu için değişmez).
3. `_acik/_eslesmeyen/*.html` → `<title>Günlük Rapor YYYY-MM-DD</title>`'dan tarih → `data/rapor/<date>/index.html`; içindeki `../../web/` yolları `/web/` yapılır. `_acik/ornek/rapor/<date>/rapor.pdf` → `data/rapor/<date>/rapor.pdf`.
4. Sonunda özet yazdırır (iş sayısı, gün/foto sayısı, log sayısı, kopyalanan MB). Var olan `data/` üzerine `--force` olmadan yazmaz.

## 7. `public/` değişiklikleri
- `app.html` = `_acik/app.html` kopyası; farklar: (a) satır 278 (`<script>window.PANO_DATA=…</script>`) silinir; (b) satır 281–282 → render IIFE `async` olur ve başta `const q=new URLSearchParams(location.search); const r=await fetch("/api/pano.json"+(q.get("dataset")?"?dataset="+encodeURIComponent(q.get("dataset")):""),{credentials:"same-origin",cache:"no-store"}); if(r.status===401){location.replace("/?next="+encodeURIComponent(location.pathname+location.search));return;} if(!r.ok){document.body.innerHTML='<p style="padding:24px;font:16px system-ui">Pano verisi alınamadı ('+r.status+'). Sayfayı yenileyin.</p>';return;} const D=await r.json();`; (c) `today` sunucu gününden: `pd(D.generated.slice(0,10))` (satır ~295'teki `new Date()` yerine; `pd` zaten var); (d) satır 596 Çıkış linki `href="/cikis"`, tema renklerinde (`background:var(--surface);color:var(--accent-ink);border-color:var(--line-strong)`), `z-index:40`, `bottom:calc(12px + env(safe-area-inset-bottom))`; (e) `<title>` `<head>` içine; (f) Google Fonts `<link>` yerine `<link rel="stylesheet" href="/fonts/fonts.css">`; (g) satır 283–594 arası **başka hiçbir değişiklik yok** (diff ile kanıtlanır).
- `index.html` = eski giriş tasarımı (marka, başlık, alt metin, renkler korunur) ama kripto yok: `<form method="post" action="/api/login">` + `next` gizli alanı + JS ile fetch (JSON) ve hata metni; `?cikis` mantığı yok; "Bu cihazda bir kez girmeniz yeterli" metni kalır; Google Fonts yerine `/fonts/fonts.css`.
- `sw.js` (yeni, ≈40 satır): `install` → skipWaiting; `activate` → eski cache'leri sil + clients.claim; `fetch`: `GET` ve aynı origin; `/web/` → cache-first (cache `alas-web-v1`); `/app.html`, `/api/pano.json`, `/fonts/`, ikonlar → network-first, başarılıysa cache'e yaz (`alas-app-v1`), ağ yoksa cache; `/`, `/index.html`, `/api/login`, `/g/`, `/cikis`, `/api/admin` → **hiç dokunma** (ağ). 401 yanıtları cache'lenmez.
- `manifest.webmanifest`: `start_url: "/app.html"`, `scope: "/"`, aynı ikonlar, `theme_color #2b5d8c`.
- `fonts/fonts.css`: `@font-face` Barlow 400/500/600 ve Barlow Condensed 600/700, `font-display: swap`, dosyalar `node_modules/@fontsource/*/files/*-latin-*-normal.woff2`'den kopya (latin yeterli; Türkçe karakterler latin-ext'te → **latin-ext** de kopyalanır: `barlow-latin-ext-400-normal.woff2` vb., `unicode-range` ile).

## 8. Testler (`node --test`)
Not: `node --test test/` Node ≥ 21'de dizin argümanını dosya sayıp düşer; argümansız `node --test` `test/*.test.js` dosyalarını kendiliğinden bulur.
- `store.test.js`: writeJsonAtomic + readJson gidiş-dönüş; safeJoin traversal reddi.
- `auth.test.js`: scrypt hash/verify; çerez imza doğrulama; süre dolumu.
- `pano.test.js`: geçici DATA_DIR'a küçük örnek yazıp `buildPano('main')` → 11 anahtar, `generated` biçimi, logs sıralı; ETag deterministik. Gerçek `data/` varsa ek: `tasks.length === 126`.

## 9. Dağıtım
- `Dockerfile`: `node:22-alpine`, `apk add --no-cache ffmpeg tzdata`, `npm ci --omit=dev`, `COPY`, `ENV NODE_ENV=production TZ=Europe/Istanbul DATA_DIR=/data`, `EXPOSE 3000`, `CMD ["node","server/index.js"]`. Kök kullanıcı (Volume izni için; plan §3).
- `railway.json`: DOCKERFILE builder, `healthcheckPath: "/health"`, `healthcheckTimeout: 60`, `restartPolicyType: ON_FAILURE`, `numReplicas: 1`.
- `.dockerignore`: `node_modules`, `data`, `_acik`, `d`, `plan-ekleri`, `.git`, `.claude`, `*.md`, `check.enc`, `ornek`.
- `.env.example`: tüm değişkenler açıklamalı.
