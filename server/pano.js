// PANO_DATA üreticisi (V1-SPEC §3): DATA_DIR/<dataset>/ altındaki JSON dosyalarını birleştirir.
// Anahtar sırası ve adları app.html'in beklediği gibidir. Veri yoksa boş döner (hiçbir şey uydurulmaz).
// Bellek önbelleği dosya mtime+boyut imzasına bağlıdır (her istekte yalnız stat).
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { readJson, ensureDir } from './store.js';
import { resolveDataDir } from './config.js';

export const DATASETLER = ['main', 'ornek'];

/** PANO_DATA anahtarları, app.html'in beklediği sırayla. */
export const PANO_ANAHTARLARI = [
  'project', 'generated', 'photosGenerated', 'banner', 'tasks', 'days',
  'logs', 'video', 'reports', 'trades', 'crewPlan',
];

const DOSYALAR = {
  project: 'project.json',
  tasks: 'tasks.json',
  days: 'days.json',
  video: 'video.json',
  crewPlan: 'crewplan.json',
  reports: 'reports.json',
  trades: 'trades.json',
  banner: 'banner.json',
  meta: 'meta.json',
};
const LOG_DOSYA_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

// ---- Tarih dizgileri (Intl ile; TZ ortam değişkenine güvenilmez) ----
const bicimlendiriciler = new Map();
function bicimlendirici(timeZone) {
  let f = bicimlendiriciler.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    bicimlendiriciler.set(timeZone, f);
  }
  return f;
}

/** "YYYY-MM-DD HH:mm" (varsayılan Europe/Istanbul). */
export function zamanDizgisi(tarih = new Date(), timeZone = 'Europe/Istanbul') {
  const p = {};
  for (const { type, value } of bicimlendirici(timeZone).formatToParts(tarih)) p[type] = value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "YYYY-MM-DD" (varsayılan Europe/Istanbul). */
export function gunDizgisi(tarih = new Date(), timeZone = 'Europe/Istanbul') {
  return zamanDizgisi(tarih, timeZone).slice(0, 10);
}

// ---- Yardımcılar ----
const nesneMi = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const dizi = (x) => (Array.isArray(x) ? x : []);

async function statImza(dosya) {
  try {
    const s = await fsp.stat(dosya);
    return `${s.mtimeMs}:${s.size}`;
  } catch (e) {
    if (e.code === 'ENOENT') return '-';
    throw e;
  }
}

async function logDosyalari(dizin) {
  try {
    return (await fsp.readdir(dizin)).filter((a) => LOG_DOSYA_RE.test(a)).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/** Dataset dizinindeki tüm kaynak dosyaların mtime+boyut imzası. */
async function imzaHesapla(dizin) {
  const adlar = Object.values(DOSYALAR);
  const imzalar = await Promise.all(adlar.map((a) => statImza(path.join(dizin, a))));
  const logDizin = path.join(dizin, 'logs');
  const loglar = await logDosyalari(logDizin);
  const logImzalari = await Promise.all(loglar.map((a) => statImza(path.join(logDizin, a))));
  return adlar.map((a, i) => `${a}=${imzalar[i]}`).join('|') + '||' + loglar.map((a, i) => `${a}=${logImzalari[i]}`).join('|');
}

async function parcalariOku(dizin, log) {
  const oku = (ad, varsayilan) => readJson(path.join(dizin, DOSYALAR[ad]), varsayilan);
  const [project, tasks, days, video, crewPlan, reports, trades, banner, meta] = await Promise.all([
    oku('project', {}), oku('tasks', []), oku('days', []), oku('video', null), oku('crewPlan', {}),
    oku('reports', []), oku('trades', []), oku('banner', {}), oku('meta', {}),
  ]);
  const logDizin = path.join(dizin, 'logs');
  const logs = [];
  for (const ad of await logDosyalari(logDizin)) {
    try {
      const kayit = await readJson(path.join(logDizin, ad), null);
      if (nesneMi(kayit)) logs.push(kayit);
    } catch (err) {
      // Tek bir bozuk günlük raporu panoyu düşürmesin; atla ve uyar
      log?.warn({ err, dosya: ad }, 'günlük rapor okunamadı, atlandı');
    }
  }
  return { project, tasks, days, video, crewPlan, reports, trades, banner, meta, logs };
}

function birlestir(p, generated) {
  return {
    project: nesneMi(p.project) ? p.project : {},
    generated,
    photosGenerated: typeof p.meta?.photosGenerated === 'string' ? p.meta.photosGenerated : '',
    banner: typeof p.banner?.text === 'string' ? p.banner.text : '',
    tasks: dizi(p.tasks),
    days: dizi(p.days),
    logs: p.logs,
    video: nesneMi(p.video) ? p.video : null,
    reports: dizi(p.reports),
    trades: dizi(p.trades),
    crewPlan: nesneMi(p.crewPlan) ? p.crewPlan : {},
  };
}

function datasetKontrol(dataset) {
  if (!DATASETLER.includes(dataset)) {
    const e = new Error(`Bilinmeyen dataset: ${dataset}`);
    e.code = 'DATASET_YOK';
    e.statusCode = 404;
    throw e;
  }
}

function secenekler(s = {}) {
  return {
    dataDir: s.dataDir ?? resolveDataDir(),
    now: s.now ?? new Date(),
    timeZone: s.timeZone ?? 'Europe/Istanbul',
    log: s.log,
  };
}

/**
 * PANO_DATA nesnesini üretir (önbelleksiz). Dataset yalnız "main" ya da "ornek".
 * @param {string} dataset
 * @param {{dataDir?: string, now?: Date, timeZone?: string, log?: object}} [s]
 */
export async function buildPano(dataset, s) {
  datasetKontrol(dataset);
  const { dataDir, now, timeZone, log } = secenekler(s);
  const parcalar = await parcalariOku(path.join(dataDir, dataset), log);
  return birlestir(parcalar, zamanDizgisi(now, timeZone));
}

/** İçerik SHA-1'i, tırnaklı (güçlü ETag). */
export function etagOf(govde) {
  return `"${createHash('sha1').update(govde).digest('hex')}"`;
}

/** If-None-Match başlığı bu ETag ile eşleşiyor mu? */
export function etagEslesiyor(baslik, etag) {
  if (!baslik) return false;
  if (baslik.trim() === '*') return true;
  return baslik.split(',').some((e) => e.trim().replace(/^W\//, '') === etag);
}

// Önbellek: anahtar = dataDir|dataset. Dosya imzası değişmedikçe ayrıştırılmış veri yeniden kullanılır;
// `generated` dakikada bir değiştiği için çıktı (ve ETag) dakika değişince yeniden kurulur.
const onbellek = new Map();

/** Önbelleği temizler (testler için). */
export function onbellegiTemizle() {
  onbellek.clear();
}

/**
 * Önbellekli pano: { data, body, etag, generated }.
 * body: JSON dizgisi, etag: içerik SHA-1.
 */
export async function getPano(dataset, s) {
  datasetKontrol(dataset);
  const { dataDir, now, timeZone, log } = secenekler(s);
  const dizin = path.join(dataDir, dataset);
  const anahtar = `${dataDir}|${dataset}`;
  const imza = await imzaHesapla(dizin);

  let girdi = onbellek.get(anahtar);
  if (!girdi || girdi.imza !== imza) {
    girdi = { imza, parcalar: await parcalariOku(dizin, log), cikti: null };
    onbellek.set(anahtar, girdi);
  }
  const generated = zamanDizgisi(now, timeZone);
  if (!girdi.cikti || girdi.cikti.generated !== generated) {
    const data = birlestir(girdi.parcalar, generated);
    const body = JSON.stringify(data);
    girdi.cikti = { data, body, etag: etagOf(body), generated };
  }
  return girdi.cikti;
}

/** Açılışta dataset dizinlerini oluşturur. */
export async function datasetDizinleriniHazirla(dataDir) {
  for (const d of DATASETLER) await ensureDir(path.join(dataDir, d, 'logs'));
}
