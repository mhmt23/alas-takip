// Ortam değişkenlerini okur, varsayılanları uygular ve doğrular (V1-SPEC §2).
// Gizli değerler (SESSION_SECRET, ADMIN_PASSWORD) numaralandırılamaz alan olarak
// tutulur; böylece yapılandırma nesnesi yanlışlıkla loglansa bile sızmaz.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Proje kökü (server/ klasörünün bir üstü). */
export const KOK_DIZIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOG_SEVIYELERI = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const KULLANICI_RE = /^[a-z0-9._-]{2,32}$/;

export class YapilandirmaHatasi extends Error {
  constructor(mesaj) {
    super(mesaj);
    this.name = 'YapilandirmaHatasi';
  }
}

function bos(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

/** "true/1/evet" benzeri değerleri mantıksala çevirir; boşsa varsayılan. */
function mantiksal(v, varsayilan) {
  if (bos(v)) return varsayilan;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'evet', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'hayir', 'hayır', 'off'].includes(s)) return false;
  throw new YapilandirmaHatasi(`Geçersiz mantıksal değer: "${v}" (true/false bekleniyordu)`);
}

/**
 * TRUST_PROXY: true/false, atlama sayısı (örn. 1) ya da Fastify'ın kabul ettiği
 * IP/CIDR listesi. Railway'de sahte X-Forwarded-For riski için sayı vermek daha güvenlidir.
 */
function proxyGuveni(v, varsayilan) {
  if (bos(v)) return varsayilan;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'evet', 'on'].includes(s)) return true;
  if (['false', 'no', 'hayir', 'hayır', 'off', '0'].includes(s)) return false;
  if (/^\d+$/.test(s)) return Number(s);
  return String(v).trim();
}

/** Veri dizinini çözer (DATA_DIR); tanımsızsa proje kökündeki ./data. */
export function resolveDataDir(env = process.env) {
  return bos(env.DATA_DIR) ? path.join(KOK_DIZIN, 'data') : path.resolve(env.DATA_DIR);
}

/**
 * Yapılandırmayı üretir. Hata varsa YapilandirmaHatasi fırlatır (çağıran çıkış 1 yapar).
 * @param {Record<string,string|undefined>} env  Varsayılan: process.env
 */
export function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';

  // PORT
  const portHam = bos(env.PORT) ? '3000' : String(env.PORT).trim();
  const PORT = Number(portHam);
  if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
    throw new YapilandirmaHatasi(`PORT geçersiz: "${env.PORT}" (0-65535 arası tam sayı olmalı)`);
  }

  const HOST = bos(env.HOST) ? '0.0.0.0' : String(env.HOST).trim();
  const DATA_DIR = resolveDataDir(env);
  const PUBLIC_DIR = bos(env.PUBLIC_DIR) ? path.join(KOK_DIZIN, 'public') : path.resolve(env.PUBLIC_DIR);

  // Saat dilimi: Intl ile doğrula (TZ ortam değişkenine güvenme)
  const TZ = bos(env.TZ) ? 'Europe/Istanbul' : String(env.TZ).trim();
  try {
    new Intl.DateTimeFormat('sv-SE', { timeZone: TZ });
  } catch {
    throw new YapilandirmaHatasi(`TZ geçersiz saat dilimi: "${TZ}"`);
  }

  const LOG_LEVEL = bos(env.LOG_LEVEL) ? 'info' : String(env.LOG_LEVEL).trim().toLowerCase();
  if (!LOG_SEVIYELERI.includes(LOG_LEVEL)) {
    throw new YapilandirmaHatasi(`LOG_LEVEL geçersiz: "${LOG_LEVEL}" (${LOG_SEVIYELERI.join(' | ')})`);
  }

  const TRUST_PROXY = proxyGuveni(env.TRUST_PROXY, isProd);

  // Oturum gizi: prod'da zorunlu; dev'de rastgele üretilir (yeniden başlatınca oturumlar düşer)
  let SESSION_SECRET = bos(env.SESSION_SECRET) ? '' : String(env.SESSION_SECRET);
  let secretGenerated = false;
  if (!SESSION_SECRET) {
    if (isProd) {
      throw new YapilandirmaHatasi('SESSION_SECRET tanımlı olmalı (NODE_ENV=production)');
    }
    SESSION_SECRET = randomBytes(32).toString('base64url');
    secretGenerated = true;
  }
  const zayifSecret = !secretGenerated && SESSION_SECRET.length < 16;

  // İlk admin (yalnız users.json boşken oluşturulur)
  let ADMIN_USER = '';
  let ADMIN_PASSWORD = '';
  if (!bos(env.ADMIN_USER) || !bos(env.ADMIN_PASSWORD)) {
    if (bos(env.ADMIN_USER) || bos(env.ADMIN_PASSWORD)) {
      throw new YapilandirmaHatasi('ADMIN_USER ve ADMIN_PASSWORD birlikte tanımlanmalı');
    }
    ADMIN_USER = String(env.ADMIN_USER).trim().toLowerCase();
    if (!KULLANICI_RE.test(ADMIN_USER)) {
      throw new YapilandirmaHatasi('ADMIN_USER geçersiz: 2-32 karakter, yalnız a-z 0-9 . _ -');
    }
    ADMIN_PASSWORD = String(env.ADMIN_PASSWORD);
    if (ADMIN_PASSWORD.length < 8) {
      throw new YapilandirmaHatasi('ADMIN_PASSWORD en az 8 karakter olmalı');
    }
  }

  const cfg = {
    PORT,
    HOST,
    DATA_DIR,
    PUBLIC_DIR,
    TZ,
    TRUST_PROXY,
    LOG_LEVEL,
    ADMIN_USER,
    isProd,
    secretGenerated,
    zayifSecret,
  };
  // Gizli alanlar: JSON.stringify / console.log çıktısında görünmez
  Object.defineProperty(cfg, 'SESSION_SECRET', { value: SESSION_SECRET, enumerable: false });
  Object.defineProperty(cfg, 'ADMIN_PASSWORD', { value: ADMIN_PASSWORD, enumerable: false });
  return Object.freeze(cfg);
}
