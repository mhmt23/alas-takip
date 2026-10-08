// Alas Takip service worker (V1): çevrimdışı yedek için önbellek.
// Şifreleme yok; oturum çerezle sunucuda tutulur. Burada yalnız ağ yoksa son görülen pano/fotoğraflar gösterilir.
const WEB = "alas-web-v1";   // fotoğraflar: cache-first (dosyalar değişmez)
const APP = "alas-app-v1";   // pano sayfası, veri, font, ikon: network-first

// Hiç dokunulmayacak yollar: giriş, oturum, yönetim (her zaman doğrudan ağ)
const dokunma = y => y === "/" || y === "/index.html" || y === "/api/login" || y === "/cikis" || y.startsWith("/g/") || y.startsWith("/api/admin");
const IKONLAR = ["/icon-192.png", "/icon-512.png"];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(adlar => Promise.all(adlar.filter(a => a !== WEB && a !== APP).map(a => caches.delete(a))))
      .then(() => self.clients.claim())
  );
});

// Yalnız başarılı (200) yanıtlar saklanır; 401/403/206 asla.
async function sakla(ad, req, res) {
  if (!res || res.status !== 200) return;
  try { await (await caches.open(ad)).put(req, res.clone()); } catch (e) { /* kota dolu vb.: sessizce geç */ }
}

async function onceOnbellek(req) {
  const c = await caches.open(WEB);
  const bulunan = await c.match(req);
  if (bulunan) return bulunan;
  const res = await fetch(req);
  await sakla(WEB, req, res);
  return res;
}

async function onceAg(req, yol) {
  try {
    const res = await fetch(req);
    await sakla(APP, req, res);
    return res;
  } catch (hata) {
    const c = await caches.open(APP);
    // app.html farklı ?dataset= ile açılmış olabilir; yalnız sayfa için sorguyu yok say
    const bulunan = (await c.match(req)) || (yol === "/app.html" ? await c.match(req, { ignoreSearch: true }) : undefined);
    if (bulunan) return bulunan;
    throw hata;
  }
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const yol = url.pathname;
  // Çıkış: istek yine doğrudan ağa gider, ama cihazdaki pano/fotoğraf önbelleği silinir
  // (ortak cihazda çıkıştan sonra ağ kesilince eski pano görünmesin)
  if (yol === "/cikis") {
    e.waitUntil(Promise.all([caches.delete(APP), caches.delete(WEB)]));
    return;
  }
  if (dokunma(yol)) return;
  if (req.headers.has("range")) return;          // video parçaları (206) önbelleğe girmez

  if (yol.startsWith("/web/")) {
    e.respondWith(onceOnbellek(req));
  } else if (yol === "/app.html" || yol === "/api/pano.json" || yol.startsWith("/fonts/") || IKONLAR.includes(yol)) {
    e.respondWith(onceAg(req, yol));
  }
});
