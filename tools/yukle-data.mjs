#!/usr/bin/env node
// Alas Takip — yerel data/ klasörünü uzak sunucuya (Railway) yükler.
// Sözleşme: docs/V1-SPEC.md §5 (PUT /api/admin/file) ve §6.
//
// Kullanım:
//   ALAS_ADMIN_PASSWORD='...' node tools/yukle-data.mjs --url https://<alan-adi> [--user admin] [--data data]
//
//   --url   Sunucunun adresi (https zorunlu; yalnız localhost için http serbest)
//   --user  Admin kullanıcı adı (varsayılan: admin)
//   --data  Yüklenecek yerel klasör (varsayılan: data)
//
// Şifre ASLA argüman olarak verilmez; ALAS_ADMIN_PASSWORD ortam değişkeninden okunur
// ve hiçbir yere yazdırılmaz.
//
// Akış: POST /api/login (JSON) → alas_sid çerezi → data/ altındaki her dosya için
// PUT /api/admin/file?path=<göreli yol> (dosya başına bir istek, en çok 3 deneme).
// Yüklenmeyenler: users.json, sessions.json, tokens.json, audit.jsonl (data/ kökünde).
// Sıra: web → rapor → ornek → main. Böylece pano verisi (main/ornek) en son gelir;
// yükleme yarıda kalsa bile günler/raporlar henüz yüklenmemiş fotoğraflara işaret etmez.

import fs from 'node:fs/promises';
import path from 'node:path';

const DENEME = 3;                    // dosya başına en çok deneme
const ISTEK_ZAMAN_ASIMI_MS = 5 * 60 * 1000;
const MAKS_BAYT = 100 * 1024 * 1024; // sunucu sınırı (§5)
const HARIC_KOK_DOSYALAR = new Set(['users.json', 'sessions.json', 'tokens.json', 'audit.jsonl']);
const IZINLI_KOKLER = ['web', 'rapor', 'ornek', 'main']; // yükleme sırası da budur

function hataCik(mesaj) {
  console.error(`HATA: ${mesaj}`);
  process.exit(1);
}

// ---------------------------------------------------------------- argümanlar

function argumanlariOku(argv) {
  const sonuc = { url: null, user: 'admin', data: 'data', yardim: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let deger = null;
    const esit = a.indexOf('=');
    if (a.startsWith('--') && esit > 0) {
      deger = a.slice(esit + 1);
      a = a.slice(0, esit);
    }
    const degerAl = () => {
      if (deger !== null) return deger;
      const s = argv[++i];
      if (s === undefined || s.startsWith('--')) hataCik(`${a} için bir değer verilmedi.`);
      return s;
    };
    if (a === '--url') sonuc.url = degerAl();
    else if (a === '--user') sonuc.user = degerAl();
    else if (a === '--data') sonuc.data = degerAl();
    else if (a === '--yardim' || a === '--help' || a === '-h') sonuc.yardim = true;
    else if (/^--(password|pass|sifre|parola)\b/.test(a)) {
      hataCik('Şifre argüman olarak verilmez. ALAS_ADMIN_PASSWORD ortam değişkenini kullanın.');
    } else hataCik(`Bilinmeyen argüman: ${a}  (yardım için: --yardim)`);
  }
  return sonuc;
}

const YARDIM = `Kullanım: ALAS_ADMIN_PASSWORD='...' node tools/yukle-data.mjs --url https://<alan-adi> [--user admin] [--data data]
  --url   Sunucu adresi (https zorunlu; yalnız localhost için http serbest)
  --user  Admin kullanıcı adı (varsayılan: admin)
  --data  Yerel veri klasörü (varsayılan: data)
Şifre yalnızca ALAS_ADMIN_PASSWORD ortam değişkeninden alınır.`;

function urlDogrula(ham) {
  if (!ham) hataCik('--url zorunlu. Örnek: --url https://alas-takip.up.railway.app');
  let u;
  try { u = new URL(ham); } catch { hataCik(`Geçersiz URL: ${ham}`); }
  const yerel = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && yerel)) {
    hataCik('Şifre düz metin gitmesin diye https zorunlu (yalnız localhost için http serbest).');
  }
  return u.origin; // yol/sorgu atılır, sondaki "/" kalmaz
}

// ---------------------------------------------------------------- yardımcılar

const uyku = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => (b / 1048576).toFixed(1);
const boyutYazi = (b) => (b >= 1048576 ? `${mb(b)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

async function dosyalariGez(kok, onek = '') {
  const sonuc = [];
  const girdiler = await fs.readdir(path.join(kok, onek), { withFileTypes: true });
  girdiler.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const g of girdiler) {
    const rel = onek ? `${onek}/${g.name}` : g.name;
    if (g.isDirectory()) sonuc.push(...await dosyalariGez(kok, rel));
    else if (g.isFile()) sonuc.push(rel);
  }
  return sonuc;
}

// Yüklenecek dosya listesi: [{ rel, bayt }] (sıralı) + atlananlar [{ rel, neden }]
async function yuklemeListesiHazirla(dataDir) {
  const hepsi = await dosyalariGez(dataDir);
  const secilen = [];
  const atlanan = [];
  for (const rel of hepsi) {
    const kok = rel.split('/')[0];
    const ad = path.posix.basename(rel);
    if (!rel.includes('/') && HARIC_KOK_DOSYALAR.has(rel)) {
      atlanan.push({ rel, neden: 'gizli/oturum verisi, yüklenmez' });
    } else if (ad === '.write-test' || ad.endsWith('.tmp')) {
      atlanan.push({ rel, neden: 'geçici dosya' });
    } else if (!IZINLI_KOKLER.includes(kok) || !rel.includes('/')) {
      atlanan.push({ rel, neden: 'sunucu yalnız web/, rapor/, main/, ornek/ kabul eder' });
    } else {
      const bayt = (await fs.stat(path.join(dataDir, ...rel.split('/')))).size;
      if (bayt > MAKS_BAYT) atlanan.push({ rel, neden: `${mb(bayt)} MB > 100 MB sunucu sınırı` });
      else secilen.push({ rel, bayt });
    }
  }
  secilen.sort((a, b) => IZINLI_KOKLER.indexOf(a.rel.split('/')[0]) - IZINLI_KOKLER.indexOf(b.rel.split('/')[0])
    || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { secilen, atlanan };
}

// ---------------------------------------------------------------- sunucu istekleri

async function girisYap(origin, kullanici, sifre) {
  let yanit;
  try {
    yanit = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: kullanici, password: sifre }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    hataCik(`Sunucuya bağlanılamadı (${origin}): ${e.cause?.code || e.message}`);
  }
  if (yanit.status === 401) hataCik('Giriş başarısız: kullanıcı adı veya şifre yanlış.');
  if (yanit.status === 429) hataCik('Çok fazla giriş denemesi (5 deneme / 15 dk). Biraz bekleyip yeniden deneyin.');
  if (!yanit.ok) hataCik(`Giriş başarısız (HTTP ${yanit.status}).`);

  let govde = null;
  try { govde = await yanit.json(); } catch { /* gövde yoksa rolü bilmeyiz */ }
  if (govde?.role && govde.role !== 'admin') hataCik(`Bu kullanıcı admin değil (rol: ${govde.role}).`);

  const cerez = yanit.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('alas_sid='));
  if (!cerez) hataCik('Giriş yanıtında oturum çerezi (alas_sid) yok.');
  return cerez; // "alas_sid=<değer>" — asla yazdırılmaz
}

// Tek dosyayı yükler; kalıcı hata (4xx) hemen, geçici hata (ağ/5xx/429/408) en çok DENEME kez denenir.
// Dönüş: { ok:true } | { ok:false, durum, mesaj, oturum? }
async function dosyaYukle(origin, cerez, dataDir, { rel, bayt }) {
  const icerik = await fs.readFile(path.join(dataDir, ...rel.split('/')));
  let son = { ok: false, mesaj: 'bilinmeyen hata' };
  for (let deneme = 1; deneme <= DENEME; deneme++) {
    try {
      // application/octet-stream: sunucunun JSON ayrıştırıcısı .json dosyalarını yutmasın, ham gövde gelsin.
      const yanit = await fetch(`${origin}/api/admin/file?path=${encodeURIComponent(rel)}`, {
        method: 'PUT',
        headers: { cookie: cerez, 'content-type': 'application/octet-stream', accept: 'application/json' },
        body: icerik,
        redirect: 'manual',
        signal: AbortSignal.timeout(ISTEK_ZAMAN_ASIMI_MS),
      });
      if (yanit.ok) return { ok: true };
      let detay = '';
      try { detay = (await yanit.text()).slice(0, 200).replace(/\s+/g, ' '); } catch { /* yoksay */ }
      son = { ok: false, durum: yanit.status, mesaj: `HTTP ${yanit.status}${detay ? ` ${detay}` : ''}` };
      if (yanit.status === 401 || yanit.status === 403 || (yanit.status >= 300 && yanit.status < 400)) {
        return { ...son, oturum: true };
      }
      const gecici = yanit.status >= 500 || yanit.status === 429 || yanit.status === 408;
      if (!gecici) return son; // 400/413/415... yeniden denemek anlamsız
    } catch (e) {
      son = { ok: false, mesaj: `ağ hatası: ${e.cause?.code || e.name || e.message}` };
    }
    if (deneme < DENEME) {
      console.log(`      ${son.mesaj} — yeniden deneniyor (${deneme + 1}/${DENEME})`);
      await uyku(1000 * deneme);
    }
  }
  return son;
}

// ---------------------------------------------------------------- ana akış

async function main() {
  const arg = argumanlariOku(process.argv.slice(2));
  if (arg.yardim) { console.log(YARDIM); return; }

  const origin = urlDogrula(arg.url);
  const sifre = process.env.ALAS_ADMIN_PASSWORD;
  if (!sifre) hataCik('ALAS_ADMIN_PASSWORD ortam değişkeni tanımlı değil (şifre argüman olarak verilmez).');

  const dataDir = path.resolve(arg.data);
  try {
    if (!(await fs.stat(dataDir)).isDirectory()) throw new Error();
  } catch {
    hataCik(`Veri klasörü bulunamadı: ${dataDir}  (önce tools/migrate-from-static.mjs çalıştırın.)`);
  }

  const { secilen, atlanan } = await yuklemeListesiHazirla(dataDir);
  if (!secilen.length) hataCik(`${dataDir} altında yüklenecek dosya yok.`);
  const toplamBayt = secilen.reduce((t, d) => t + d.bayt, 0);

  console.log(`Kaynak : ${dataDir}`);
  console.log(`Sunucu : ${origin}  (kullanıcı: ${arg.user})`);
  console.log(`Yüklenecek: ${secilen.length} dosya, ${mb(toplamBayt)} MB` + (atlanan.length ? `  (${atlanan.length} dosya atlandı)` : ''));
  for (const a of atlanan) console.log(`  atlandı: ${a.rel} — ${a.neden}`);
  console.log('');

  const cerez = await girisYap(origin, arg.user, sifre);
  console.log('Giriş yapıldı.');

  const basarisiz = [];
  let yuklenenBayt = 0;
  let yuklenenSayi = 0;
  const hane = String(secilen.length).length;
  for (let i = 0; i < secilen.length; i++) {
    const d = secilen[i];
    const sira = `[${String(i + 1).padStart(hane)}/${secilen.length}]`;
    const sonuc = await dosyaYukle(origin, cerez, dataDir, d);
    if (sonuc.ok) {
      yuklenenBayt += d.bayt;
      yuklenenSayi++;
      console.log(`${sira} ${d.rel}  ${boyutYazi(d.bayt)}  tamam`);
    } else {
      basarisiz.push({ rel: d.rel, mesaj: sonuc.mesaj });
      console.log(`${sira} ${d.rel}  ${boyutYazi(d.bayt)}  BAŞARISIZ — ${sonuc.mesaj}`);
      if (sonuc.oturum) {
        console.error('\nOturum/yetki hatası: kalan dosyalar da reddedilir, yükleme durduruldu.');
        break;
      }
    }
  }

  console.log('');
  console.log(`Özet: ${yuklenenSayi}/${secilen.length} dosya yüklendi (${mb(yuklenenBayt)} MB).`);
  if (basarisiz.length) {
    console.log('Yüklenemeyenler:');
    for (const b of basarisiz) console.log(`  - ${b.rel}: ${b.mesaj}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`HATA: ${e.message}`);
  process.exit(1);
});
