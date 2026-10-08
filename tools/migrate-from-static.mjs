#!/usr/bin/env node
// Alas Takip — eski statik paketten (_acik/) sunucu veri düzenine (data/) taşıma aracı.
// Sözleşme: docs/V1-SPEC.md §3 (veri düzeni) ve §6 (bu araç).
//
// Kullanım:
//   node tools/migrate-from-static.mjs [--acik _acik] [--data data] [--force]
//
//   --acik   Çözülmüş eski paket klasörü (varsayılan: _acik)
//   --data   Hedef veri klasörü (varsayılan: data) — Railway'de /data Volume'unun karşılığı
//   --force  Dolu bir hedefin üzerine yazmaya izin verir (JSON/HTML/PDF dosyaları ezilir;
//            aynı adlı fotoğraf/video yalnız boyutu farklıysa yeniden kopyalanır)
//
// Göreli yollar, komutun çalıştırıldığı klasöre (cwd) göre çözülür.
// Bağımlılıksızdır: yalnız Node yerleşik modülleri.

import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------- argümanlar

function argumanlariOku(argv) {
  const sonuc = { acik: '_acik', data: 'data', force: false, yardim: false };
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
    if (a === '--acik') sonuc.acik = degerAl();
    else if (a === '--data') sonuc.data = degerAl();
    else if (a === '--force') sonuc.force = true;
    else if (a === '--yardim' || a === '--help' || a === '-h') sonuc.yardim = true;
    else hataCik(`Bilinmeyen argüman: ${a}  (yardım için: --yardim)`);
  }
  return sonuc;
}

function hataCik(mesaj) {
  console.error(`HATA: ${mesaj}`);
  process.exit(1);
}

const YARDIM = `Kullanım: node tools/migrate-from-static.mjs [--acik _acik] [--data data] [--force]
  --acik   Çözülmüş eski paket klasörü (varsayılan: _acik)
  --data   Hedef veri klasörü (varsayılan: data)
  --force  Dolu hedefin üzerine yazmaya izin verir`;

// ---------------------------------------------------------------- dosya yardımcıları

const TARIH_RE = /^\d{4}-\d{2}-\d{2}$/;

async function varMi(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function boyut(p) {
  try { return (await fs.stat(p)).size; } catch { return null; }
}

async function klasorDoluMu(dir) {
  try { return (await fs.readdir(dir)).length > 0; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

// Atomik yazım: geçici dosyaya yaz, sonra yeniden adlandır (yarım dosya kalmaz).
async function atomikYaz(dosya, icerik) {
  await fs.mkdir(path.dirname(dosya), { recursive: true });
  const gecici = `${dosya}.${process.pid}.tmp`;
  try {
    await fs.writeFile(gecici, icerik);
    await fs.rename(gecici, dosya);
  } catch (e) {
    await fs.rm(gecici, { force: true });
    throw e;
  }
}

async function jsonYaz(dosya, nesne) {
  await atomikYaz(dosya, JSON.stringify(nesne, null, 2) + '\n');
}

async function atomikKopyala(kaynak, hedef) {
  await fs.mkdir(path.dirname(hedef), { recursive: true });
  const gecici = `${hedef}.${process.pid}.tmp`;
  try {
    await fs.copyFile(kaynak, gecici);
    await fs.rename(gecici, hedef);
  } catch (e) {
    await fs.rm(gecici, { force: true });
    throw e;
  }
}

// Bir klasördeki tüm dosyaları (alt klasörler dâhil) göreli yolla, '/' ayraçlı döner.
async function dosyalariGez(kok, onek = '') {
  const sonuc = [];
  let girdiler;
  try { girdiler = await fs.readdir(path.join(kok, onek), { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return sonuc; throw e; }
  girdiler.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const g of girdiler) {
    const rel = onek ? `${onek}/${g.name}` : g.name;
    if (g.isDirectory()) sonuc.push(...await dosyalariGez(kok, rel));
    else if (g.isFile()) sonuc.push(rel);
  }
  return sonuc;
}

const mb = (bayt) => (bayt / 1048576).toFixed(1);

// ---------------------------------------------------------------- PANO_DATA çıkarımı

const PANO_RE = /window\.PANO_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/;

async function panoVerisiOku(htmlYolu) {
  const html = await fs.readFile(htmlYolu, 'utf8');
  const m = PANO_RE.exec(html);
  if (!m) throw new Error(`${htmlYolu} içinde window.PANO_DATA bulunamadı.`);
  let veri;
  try { veri = JSON.parse(m[1]); }
  catch (e) { throw new Error(`${htmlYolu} içindeki PANO_DATA geçerli JSON değil: ${e.message}`); }
  if (!veri || typeof veri !== 'object' || !Array.isArray(veri.tasks) || !Array.isArray(veri.days)) {
    throw new Error(`${htmlYolu} içindeki PANO_DATA beklenen şekilde değil (tasks/days dizisi yok).`);
  }
  return veri;
}

// PANO_DATA'yı §3 dosyalarına böler. Dönüş: özet sayıları.
async function datasetYaz(hedefDir, veri, kaynakEtiketi, uyarilar) {
  const ds = path.basename(hedefDir);
  const bilinen = new Set(['project', 'generated', 'photosGenerated', 'banner', 'tasks', 'days',
    'logs', 'video', 'reports', 'trades', 'crewPlan']);
  for (const k of Object.keys(veri)) {
    if (!bilinen.has(k)) uyarilar.push(`${ds}: PANO_DATA içinde tanınmayan anahtar atlandı: ${k}`);
  }

  await jsonYaz(path.join(hedefDir, 'project.json'), veri.project ?? {});
  await jsonYaz(path.join(hedefDir, 'tasks.json'), veri.tasks);
  await jsonYaz(path.join(hedefDir, 'days.json'), veri.days);
  await jsonYaz(path.join(hedefDir, 'video.json'), veri.video ?? null);
  await jsonYaz(path.join(hedefDir, 'crewplan.json'), veri.crewPlan ?? {});
  await jsonYaz(path.join(hedefDir, 'reports.json'), veri.reports ?? []);
  await jsonYaz(path.join(hedefDir, 'trades.json'), veri.trades ?? []);
  await jsonYaz(path.join(hedefDir, 'banner.json'), { text: veri.banner || '' });
  await jsonYaz(path.join(hedefDir, 'meta.json'), {
    photosGenerated: veri.photosGenerated ?? null,
    importedAt: new Date().toISOString(),
    source: kaynakEtiketi,
  });

  // Günlük raporlar: her biri ayrı dosya (logs/<date>.json). Klasör boş olsa da oluşturulur.
  await fs.mkdir(path.join(hedefDir, 'logs'), { recursive: true });
  let logSayisi = 0;
  for (const log of veri.logs ?? []) {
    if (!log || typeof log.date !== 'string' || !TARIH_RE.test(log.date)) {
      uyarilar.push(`${ds}: tarihi geçersiz günlük rapor atlandı (${JSON.stringify(log?.date)})`);
      continue;
    }
    await jsonYaz(path.join(hedefDir, 'logs', `${log.date}.json`), log);
    logSayisi++;
  }

  let foto = 0;
  for (const g of veri.days) for (const s of g.sessions ?? []) foto += (s.photos ?? []).length;
  return { is: veri.tasks.length, gun: veri.days.length, foto, log: logSayisi };
}

// Gün/video/rapor kayıtlarının gösterdiği dosyalar data/ altında gerçekten var mı?
async function eksikDosyalariBul(dataDir, ds, veri, uyarilar) {
  const gerekli = new Set();
  for (const g of veri.days) {
    for (const s of g.sessions ?? []) for (const f of s.photos ?? []) if (f.src) gerekli.add(f.src);
  }
  if (veri.video?.src) gerekli.add(veri.video.src);
  for (const r of veri.reports ?? []) {
    if (r.pdf) gerekli.add(r.pdf);
    if (r.url) gerekli.add(`${r.url.replace(/\/+$/, '')}/index.html`);
  }
  let eksik = 0;
  for (const rel of gerekli) {
    if (!(await varMi(path.join(dataDir, ...rel.split('/'))))) {
      eksik++;
      if (eksik <= 10) uyarilar.push(`${ds}: kayıtta geçen dosya hedef klasörde yok: ${rel}`);
    }
  }
  if (eksik > 10) uyarilar.push(`${ds}: ... ve ${eksik - 10} eksik dosya daha`);
  return eksik;
}

// ---------------------------------------------------------------- ana akış

async function main() {
  const arg = argumanlariOku(process.argv.slice(2));
  if (arg.yardim) { console.log(YARDIM); return; }

  const acik = path.resolve(arg.acik);
  const dataDir = path.resolve(arg.data);
  const uyarilar = [];

  if (acik === dataDir) hataCik('--acik ve --data aynı klasör olamaz.');
  if (!(await varMi(path.join(acik, 'app.html')))) {
    hataCik(`Kaynak bulunamadı: ${path.join(acik, 'app.html')}  (önce tools/decrypt.mjs ile paketi çözün.)`);
  }
  if ((await klasorDoluMu(dataDir)) && !arg.force) {
    hataCik(`Hedef klasör dolu: ${dataDir}\n  Üzerine yazmak için --force verin ya da başka bir --data seçin.`);
  }

  const kaynakAd = path.basename(acik);
  const istatistik = { web: { kopya: 0, atlanan: 0, bayt: 0 }, raporHtml: 0, raporPdf: 0, bayt: 0 };
  const buTurdaYazilan = new Set(); // aynı koşuda yazılan web dosyaları (ornek/web ile çakışma için)

  // 1) PANO_DATA → data/<dataset>/
  console.log(`Kaynak : ${acik}`);
  console.log(`Hedef  : ${dataDir}${arg.force ? '  (--force)' : ''}`);
  console.log('');

  const veriler = {};
  const ozetler = {};

  veriler.main = await panoVerisiOku(path.join(acik, 'app.html'));
  ozetler.main = await datasetYaz(path.join(dataDir, 'main'), veriler.main, `${kaynakAd}/app.html`, uyarilar);

  const ornekHtml = path.join(acik, 'ornek', 'index.html');
  if (await varMi(ornekHtml)) {
    veriler.ornek = await panoVerisiOku(ornekHtml);
    ozetler.ornek = await datasetYaz(path.join(dataDir, 'ornek'), veriler.ornek, `${kaynakAd}/ornek/index.html`, uyarilar);
  } else {
    uyarilar.push(`ornek veri seti atlandı: ${ornekHtml} yok.`);
  }

  // 2) Fotoğraf/video: _acik/web/** sonra _acik/ornek/web/** → data/web/**
  //    Aynı ad varsa atlanır (iki veri seti aynı dosyaları paylaşır; src yolları değişmez).
  for (const kaynakWeb of [path.join(acik, 'web'), path.join(acik, 'ornek', 'web')]) {
    const ornekMi = kaynakWeb.endsWith(`${path.sep}ornek${path.sep}web`);
    for (const rel of await dosyalariGez(kaynakWeb)) {
      const kaynak = path.join(kaynakWeb, ...rel.split('/'));
      const hedef = path.join(dataDir, 'web', ...rel.split('/'));
      const kBoyut = await boyut(kaynak);
      const hBoyut = await boyut(hedef);
      let kopyala = hBoyut === null;
      if (hBoyut !== null) {
        if (buTurdaYazilan.has(hedef)) {
          // Aynı koşuda zaten yazıldı (ornek/web, web ile aynı adlı): atla; boyut farklıysa haber ver.
          if (hBoyut !== kBoyut) {
            uyarilar.push(`web/${rel}: ${ornekMi ? 'ornek/web' : 'web'} kopyası farklı boyutta, ilk kopya korundu.`);
          }
        } else if (arg.force && hBoyut !== kBoyut) {
          kopyala = true; // eski koşudan kalan, boyutu farklı (yarım/eski) dosya
        }
      }
      if (kopyala) {
        await atomikKopyala(kaynak, hedef);
        buTurdaYazilan.add(hedef);
        istatistik.web.kopya++;
        istatistik.web.bayt += kBoyut;
        istatistik.bayt += kBoyut;
      } else {
        istatistik.web.atlanan++;
      }
    }
  }

  // 3) Günlük rapor HTML'leri: _eslesmeyen/*.html → rapor/<date>/index.html
  const eslesmeyenDir = path.join(acik, '_eslesmeyen');
  let yolDuzeltme = 0;
  for (const ad of (await dosyalariGez(eslesmeyenDir)).filter((a) => !a.includes('/') && a.toLowerCase().endsWith('.html'))) {
    const html = await fs.readFile(path.join(eslesmeyenDir, ad), 'utf8');
    const m = /<title>\s*Günlük Rapor\s+(\d{4}-\d{2}-\d{2})\s*<\/title>/i.exec(html);
    if (!m) {
      uyarilar.push(`_eslesmeyen/${ad}: <title> içinde tarih bulunamadı, atlandı.`);
      continue;
    }
    const tarih = m[1];
    const sayi = html.split('../../web/').length - 1;
    yolDuzeltme += sayi;
    const cikti = html.replaceAll('../../web/', '/web/');
    await atomikYaz(path.join(dataDir, 'rapor', tarih, 'index.html'), cikti);
    istatistik.raporHtml++;
    istatistik.bayt += Buffer.byteLength(cikti);
  }

  // 4) ornek/rapor/<date>/rapor.pdf → rapor/<date>/rapor.pdf
  const ornekRaporDir = path.join(acik, 'ornek', 'rapor');
  let tarihKlasorleri = [];
  try { tarihKlasorleri = await fs.readdir(ornekRaporDir, { withFileTypes: true }); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const g of tarihKlasorleri) {
    if (!g.isDirectory() || !TARIH_RE.test(g.name)) continue;
    const pdf = path.join(ornekRaporDir, g.name, 'rapor.pdf');
    const pBoyut = await boyut(pdf);
    if (pBoyut === null) {
      uyarilar.push(`ornek/rapor/${g.name}: rapor.pdf yok.`);
      continue;
    }
    await atomikKopyala(pdf, path.join(dataDir, 'rapor', g.name, 'rapor.pdf'));
    istatistik.raporPdf++;
    istatistik.bayt += pBoyut;
  }

  // 5) Tutarlılık: kayıtlardaki dosyalar gerçekten kopyalandı mı?
  let eksikToplam = 0;
  for (const ds of Object.keys(veriler)) {
    eksikToplam += await eksikDosyalariBul(dataDir, ds, veriler[ds], uyarilar);
  }

  // 6) Özet
  console.log('Taşıma özeti');
  for (const ds of Object.keys(ozetler)) {
    const o = ozetler[ds];
    console.log(`  ${ds.padEnd(5)}: ${o.is} iş, ${o.gun} gün, ${o.foto} fotoğraf, ${o.log} günlük rapor`);
  }
  console.log(`  web  : ${istatistik.web.kopya} dosya kopyalandı (${mb(istatistik.web.bayt)} MB), ${istatistik.web.atlanan} dosya zaten vardı, atlandı`);
  console.log(`  rapor: ${istatistik.raporHtml} HTML (${yolDuzeltme} adet ../../web/ yolu düzeltildi), ${istatistik.raporPdf} PDF`);
  console.log(`  toplam kopyalanan/yazılan: ${mb(istatistik.bayt)} MB`);
  if (eksikToplam === 0) console.log('  kontrol: kayıtlardaki tüm foto/video/rapor dosyaları hedef klasörde mevcut');
  if (uyarilar.length) {
    console.log('');
    console.log('Uyarılar');
    for (const u of uyarilar) console.log(`  ! ${u}`);
  }
  console.log('');
  console.log('Bitti.');
  if (eksikToplam > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(`HATA: ${e.message}`);
  process.exit(1);
});
