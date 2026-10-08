// JSON/dosya yardımcıları (V1-SPEC §1): atomik yazım, güvenli yol birleştirme.
// Kalıcı veri DATA_DIR altında düz JSON + dosyadır; yazımlar tmp + rename ile atomiktir.
import { promises as fsp, createWriteStream, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';

let tmpSayac = 0;

function tmpAdi(hedef) {
  tmpSayac = (tmpSayac + 1) % 1_000_000;
  return `${hedef}.${process.pid}.${Date.now().toString(36)}${tmpSayac}.tmp`;
}

function jsonMetni(obj, girinti) {
  const metin = JSON.stringify(obj, null, girinti);
  if (metin === undefined) throw new TypeError('JSON olarak yazılamayan değer');
  return metin + '\n';
}

function bomAyikla(metin) {
  return metin.charCodeAt(0) === 0xfeff ? metin.slice(1) : metin;
}

function bozukJson(dosya, hata) {
  const e = new Error(`JSON okunamadı: ${dosya} (${hata.message})`);
  e.code = 'JSON_BOZUK';
  e.file = dosya;
  e.cause = hata;
  return e;
}

/** Windows'ta antivirüs/arama dizini rename'i kısa süre kilitleyebilir: birkaç kez dene. */
async function yenidenAdlandir(kaynak, hedef) {
  for (let deneme = 0; ; deneme++) {
    try {
      await fsp.rename(kaynak, hedef);
      return;
    } catch (e) {
      const gecici = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES';
      if (!gecici || deneme >= 4) throw e;
      await new Promise((r) => setTimeout(r, 25 * (deneme + 1)));
    }
  }
}

/** Dizini (üst dizinleriyle) oluşturur; varsa dokunmaz. */
export async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

export function ensureDirSync(p) {
  mkdirSync(p, { recursive: true });
}

/**
 * JSON dosyasını okur. Dosya yoksa `fallback` döner; bozuk JSON ise hata fırlatır
 * (code: "JSON_BOZUK") — veri sessizce yok sayılmaz.
 */
export async function readJson(p, fallback) {
  let metin;
  try {
    metin = await fsp.readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(bomAyikla(metin));
  } catch (e) {
    throw bozukJson(p, e);
  }
}

export function readJsonSync(p, fallback) {
  let metin;
  try {
    metin = readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(bomAyikla(metin));
  } catch (e) {
    throw bozukJson(p, e);
  }
}

/**
 * JSON'u atomik yazar: aynı dizinde tmp dosyaya yaz, diske eşitle, rename.
 * Yarım yazılmış hedef dosya oluşmaz.
 * @param {string} p
 * @param {unknown} obj
 * @param {{indent?: number}} [secenek]  indent: 0 → sıkıştırılmış JSON (varsayılan 2)
 */
export async function writeJsonAtomic(p, obj, { indent = 2 } = {}) {
  const metin = jsonMetni(obj, indent);
  await ensureDir(path.dirname(p));
  const tmp = tmpAdi(p);
  let fh;
  try {
    fh = await fsp.open(tmp, 'w');
    await fh.writeFile(metin, 'utf8');
    await fh.sync();
    await fh.close();
    fh = null;
    await yenidenAdlandir(tmp, p);
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export function writeJsonAtomicSync(p, obj, { indent = 2 } = {}) {
  const metin = jsonMetni(obj, indent);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = tmpAdi(p);
  try {
    writeFileSync(tmp, metin, 'utf8');
    renameSync(tmp, p);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Akışı (ham gövde) atomik olarak dosyaya yazar; `maxBytes` aşılırsa iptal eder
 * (hata: code "BOYUT_ASILDI", statusCode 413). `dogrula(tmpYol)` verilirse rename'den önce
 * çağrılır; fırlatırsa tmp silinir ve hedef dosyaya dokunulmaz.
 * @returns {Promise<number>} yazılan bayt sayısı
 */
export async function writeStreamAtomic(p, okunur, { maxBytes = Infinity, dogrula } = {}) {
  await ensureDir(path.dirname(p));
  const tmp = tmpAdi(p);
  let bayt = 0;
  const sayac = new Transform({
    transform(parca, _kodlama, cb) {
      bayt += parca.length;
      if (bayt > maxBytes) {
        const e = new Error('Dosya izin verilen boyutu aşıyor');
        e.code = 'BOYUT_ASILDI';
        e.statusCode = 413;
        return cb(e);
      }
      cb(null, parca);
    },
  });
  try {
    if (okunur === undefined || okunur === null) {
      await fsp.writeFile(tmp, '');
    } else {
      await pipeline(okunur, sayac, createWriteStream(tmp));
    }
    if (dogrula) await dogrula(tmp);
    await yenidenAdlandir(tmp, p);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return bayt;
}

/** Dosyanın sonuna bir satır ekler (sonuna \n yoksa eklenir). */
export async function appendLine(p, str) {
  await ensureDir(path.dirname(p));
  await fsp.appendFile(p, str.endsWith('\n') ? str : str + '\n', 'utf8');
}

export class YolHatasi extends Error {
  constructor(mesaj) {
    super(mesaj);
    this.name = 'YolHatasi';
    this.code = 'YOL_GECERSIZ';
    this.statusCode = 400;
  }
}

/**
 * `root` altında kalan yolu üretir; üst dizine çıkan (../), mutlak ya da null baytlı
 * `rel` YolHatasi (400) ile reddedilir. Path traversal engeli.
 */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string') throw new YolHatasi('Yol metin olmalı');
  if (rel.includes('\0')) throw new YolHatasi('Yol geçersiz karakter içeriyor');
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel)) {
    throw new YolHatasi('Mutlak yola izin verilmez');
  }
  // Platformdan bağımsız sıkı kural: hiçbir bölüm ".." olamaz (/ ve \ ayırıcı sayılır)
  if (rel.split(/[\\/]+/).includes('..')) throw new YolHatasi('Yolda ".." bölümüne izin verilmez');
  const kok = path.resolve(root);
  const hedef = path.resolve(kok, rel);
  const goreli = path.relative(kok, hedef);
  if (goreli === '..' || goreli.startsWith('..' + path.sep) || path.isAbsolute(goreli)) {
    throw new YolHatasi('Yol kök dizinin dışına çıkıyor');
  }
  return hedef;
}
