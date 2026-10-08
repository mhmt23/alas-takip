// Alas Takip – şifreli içerik service worker'ı.
// Giriş sayfası anahtarı IndexedDB'ye koyar; bu dosya istenen sayfa/fotoğraf/PDF'in .enc halini indirip çözer.
const KID = '6a836cf4a615ffd5';
const CACHE = 'alas-' + KID;
const PLAIN = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'check.enc']);
const TYPES = { html: 'text/html; charset=utf-8', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4',
  pdf: 'application/pdf', json: 'application/json', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' };
let keyP = null;

function idbKey() {
  return new Promise(res => {
    const r = indexedDB.open('alas', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onerror = () => res(null);
    r.onsuccess = () => {
      try { const g = r.result.transaction('k', 'readonly').objectStore('k').get('key'); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); }
      catch (e) { res(null); }
    };
  });
}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('alas-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('message', e => { if (e.data === 'reset') keyP = null; });

self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  const base = new URL(self.registration.scope).pathname;
  if (!u.pathname.startsWith(base)) return;
  let rel = decodeURIComponent(u.pathname.slice(base.length));
  if (rel === '' ) return;                       // giriş sayfası (index.html) ağdan
  if (rel.endsWith('/')) rel += 'index.html';
  if (PLAIN.has(rel) || rel.endsWith('.enc') || rel === '.nojekyll') return;
  e.respondWith(serve(req, rel, base));
});

async function getEnc(rel) {
  const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KID + ':' + rel));
  const hex = [...new Uint8Array(dig)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
  const url = new URL('d/' + hex + '.enc', self.registration.scope).href;
  const cache = await caches.open(CACHE);
  const immutable = !rel.endsWith('.html');   // fotoğraf/video/pdf adları değişmez
  if (immutable) { const hit = await cache.match(url); if (hit) return hit; }
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (r.ok) { cache.put(url, r.clone()); }
    return r;
  } catch (err) {
    const hit = await cache.match(url);
    if (hit) return hit;
    throw err;
  }
}

async function serve(req, rel, base) {
  keyP = keyP || idbKey();
  const key = await keyP;
  const toLogin = () => req.mode === 'navigate'
    ? Response.redirect(base + '?next=' + encodeURIComponent(rel.replace(/index\.html$/, '')), 302)
    : new Response('Giriş gerekli', { status: 401 });
  if (!key) { keyP = null; return toLogin(); }
  let r;
  try { r = await getEnc(rel); } catch (e) { return new Response('Bağlantı yok', { status: 503 }); }
  if (!r.ok) return new Response('Bulunamadı', { status: r.status === 404 ? 404 : 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const buf = await r.arrayBuffer();
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12)); }
  catch (e) {   // şifre değişmiş: yeniden giriş
    keyP = null;
    return req.mode === 'navigate' ? Response.redirect(base + '?cikis=1', 302) : new Response('Giriş gerekli', { status: 401 });
  }
  const ext = (rel.split('.').pop() || '').toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  const size = plain.byteLength;
  const range = req.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    let start = m[1] === '' ? Math.max(0, size - (+m[2])) : +m[1];
    let end = m[1] !== '' && m[2] !== '' ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(plain.slice(start, end + 1), { status: 206, headers: {
      'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' } });
  }
  return new Response(plain, { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' } });
}
