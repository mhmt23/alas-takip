// Kimlik, oturum, sihirli link (V1-SPEC §4).
//  - Saf yardımcılar (hash, çerez imzası, süre, webview tespiti) dışa açıktır ve test edilir.
//  - createAuth(): users.json / sessions.json / tokens.json'u bellekte tutar, değişince atomik yazar.
// Gizli değerler (şifre, SESSION_SECRET, sihirli link token'ı) ASLA loglanmaz.
import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { readJson, writeJsonAtomic, ensureDir } from './store.js';

const scryptAsync = promisify(scrypt);

export const ROLLER = ['admin', 'sef', 'pilot', 'patron'];
export const COOKIE_ADI = 'alas_sid';

const GUN_MS = 24 * 60 * 60 * 1000;
/** Kayan oturum süreleri (§4). */
export const OTURUM_SURESI = {
  patron: 90 * GUN_MS,
  sef: 30 * GUN_MS,
  pilot: 30 * GUN_MS,
  admin: 7 * GUN_MS,
};
/** lastSeen en fazla bu aralıkta bir güncellenir/yazılır. */
export const LASTSEEN_ARALIK_MS = 10 * 60 * 1000;
const TEMIZLIK_ARALIK_MS = 60 * 60 * 1000;

const KULLANICI_RE = /^[a-z0-9._-]{2,32}$/;
const SID_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bayt base64url
const IMZA_RE = /^[A-Za-z0-9_-]{22}$/; // 16 bayt base64url
const SIFRE_MIN = 8;
const SIFRE_MAX = 256;

// ---------------------------------------------------------------- saf yardımcılar

export function normalizeUsername(u) {
  return typeof u === 'string' ? u.trim().toLowerCase() : '';
}

export function isValidUsername(u) {
  return typeof u === 'string' && KULLANICI_RE.test(u);
}

export function sifreGecerliMi(p) {
  return typeof p === 'string' && p.length >= SIFRE_MIN && p.length <= SIFRE_MAX;
}

/** Şifreyi NFC'ye çevirir (klavyeler arasında Türkçe karakter bileşimi farkı olmasın). */
function sifreHazirla(p) {
  return String(p).normalize('NFC');
}

/**
 * scrypt(password, salt, 64). Dönen salt/hash hex dizgidir.
 * @param {string} password
 * @param {string} [saltHex]  verilmezse 16 bayt rastgele üretilir
 */
export async function hashPassword(password, saltHex = randomBytes(16).toString('hex')) {
  const anahtar = await scryptAsync(sifreHazirla(password), Buffer.from(saltHex, 'hex'), 64);
  return { salt: saltHex, hash: anahtar.toString('hex') };
}

/** Zamanlama saldırısına dayanıklı (timingSafeEqual) şifre doğrulama. */
export async function verifyPassword(password, saltHex, hashHex) {
  if (typeof password !== 'string' || password.length > SIFRE_MAX) return false;
  if (typeof saltHex !== 'string' || typeof hashHex !== 'string') return false;
  const beklenen = Buffer.from(hashHex, 'hex');
  const hesaplanan = await scryptAsync(sifreHazirla(password), Buffer.from(saltHex, 'hex'), 64);
  return beklenen.length === hesaplanan.length && timingSafeEqual(beklenen, hesaplanan);
}

function imzaBayti(sid, secret) {
  return createHmac('sha256', secret).update(sid).digest().subarray(0, 16);
}

/** Çerez değeri: sid + "." + HMAC-SHA256(sid, secret) ilk 16 bayt (base64url). */
export function signSid(sid, secret) {
  return `${sid}.${imzaBayti(sid, secret).toString('base64url')}`;
}

/** İmza doğruysa sid'i, değilse null döner. */
export function verifyCookie(deger, secret) {
  if (typeof deger !== 'string') return null;
  const nokta = deger.indexOf('.');
  if (nokta !== 43 || deger.length !== 43 + 1 + 22) return null;
  const sid = deger.slice(0, nokta);
  const imza = deger.slice(nokta + 1);
  if (!SID_RE.test(sid) || !IMZA_RE.test(imza)) return null;
  const verilen = Buffer.from(imza, 'base64url');
  // Kanonik olmayan kodlamayı (son karakterin dolgu bitleri) reddet: aynı imza tek biçimde yazılır
  if (verilen.toString('base64url') !== imza) return null;
  const beklenen = imzaBayti(sid, secret);
  if (verilen.length !== beklenen.length || !timingSafeEqual(verilen, beklenen)) return null;
  return sid;
}

export function newSid() {
  return randomBytes(32).toString('base64url');
}

/** Role göre oturum süresi (ms). */
export function sessionTtl(role) {
  return OTURUM_SURESI[role] ?? OTURUM_SURESI.sef;
}

export function isExpired(oturum, now = Date.now()) {
  return !oturum || typeof oturum.expiresAt !== 'number' || oturum.expiresAt <= now;
}

/**
 * Giriş sonrası yönlenecek yol: yalnız aynı site içi, "/" ile başlayan yollar.
 * Geçersizse (ya da giriş sayfasının kendisiyse) null.
 */
export function safeNext(next) {
  if (typeof next !== 'string' || next.length === 0 || next.length > 500) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return null;
  const yol = next.split(/[?#]/)[0];
  if (yol === '/' || yol === '/index.html') return null;
  return next;
}

const WEBVIEW_RE = /\bwv\b|FBAN|FBAV|Instagram|WhatsApp|\bLine\//;
/** Uygulama içi tarayıcı (webview) mı? Bu tarayıcılar çerezi kalıcı tutmaz. */
export function isWebview(ua) {
  return typeof ua === 'string' && WEBVIEW_RE.test(ua);
}

const CRAWLER_RE = /facebookexternalhit|crawler|spider|preview|bot\b/i;
/** Link önizleme/arama botu mu? Bunlar sihirli linki yakmamalı. */
export function isCrawler(ua) {
  return typeof ua === 'string' && CRAWLER_RE.test(ua);
}

/** Navigasyon (tarayıcı sayfa isteği) mi? Accept: text/html içerir. */
export function htmlIstiyor(req) {
  return (req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept ?? '').includes('text/html');
}

// ---------------------------------------------------------------- yetki hook'ları

/** Oturum yoksa 401 JSON; sayfa isteğiyse 302 /?next=<yol>. */
export async function requireAuth(req, reply) {
  if (req.user) return;
  if (htmlIstiyor(req)) return reply.redirect('/?next=' + encodeURIComponent(req.url), 302);
  return reply.code(401).send({ error: 'giris-gerekli' });
}

/** Belirtilen rollerden biri gerekir; oturum yoksa 401, rol uymuyorsa 403. */
export function requireRole(...roller) {
  return async function rolGerekli(req, reply) {
    if (!req.user) return requireAuth(req, reply);
    if (!roller.includes(req.user.role)) return reply.code(403).send({ error: 'yetki-yok' });
  };
}

// ---------------------------------------------------------------- kalıcı durum

/**
 * Yazımları sıraya dizen/birleştiren yazıcı: aynı anda tek yazım, yazım sürerken gelen
 * değişiklikler tek bir ek yazımla birleşir (rename sırası bozulmaz).
 */
function yazici(dosya, veriAl, log) {
  let calisiyor = null;
  let bekliyor = false;
  async function don() {
    try {
      do {
        bekliyor = false;
        try {
          await writeJsonAtomic(dosya, veriAl());
        } catch (err) {
          log?.error({ err }, `${path.basename(dosya)} yazılamadı`);
        }
      } while (bekliyor);
    } finally {
      calisiyor = null;
    }
  }
  return {
    planla() {
      bekliyor = true;
      if (!calisiyor) calisiyor = don();
      return calisiyor;
    },
    /** Bekleyen/sürmekte olan yazımı bitirir. */
    async bosalt() {
      if (calisiyor) await calisiyor;
    },
  };
}

/** Bozuk JSON'u atlayıp .bozuk-<zaman> olarak saklar; fallback ile devam eder. */
async function toleransliOku(dosya, fallback, log) {
  try {
    return await readJson(dosya, fallback);
  } catch (err) {
    if (err.code !== 'JSON_BOZUK') throw err;
    const yedek = `${dosya}.bozuk-${Date.now()}`;
    await fsp.copyFile(dosya, yedek).catch(() => {});
    log?.error({ err, yedek }, `${path.basename(dosya)} bozuk, boş devam ediliyor (kopya saklandı)`);
    return fallback;
  }
}

const dizi = (x) => (Array.isArray(x) ? x : []);
const nesne = (x) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? x : {});

// ---------------------------------------------------------------- durumlu kimlik katmanı

/**
 * @param {{config: ReturnType<typeof import('./config.js').loadConfig>, log?: object, audit?: Function}} deps
 */
export function createAuth({ config, log, audit }) {
  const dataDir = config.DATA_DIR;
  const secret = config.SESSION_SECRET;
  const dosyalar = {
    users: path.join(dataDir, 'users.json'),
    sessions: path.join(dataDir, 'sessions.json'),
    tokens: path.join(dataDir, 'tokens.json'),
  };

  let users = [];
  const sessions = new Map(); // sid -> kayıt
  const tokens = new Map(); // token -> kayıt
  let zamanlayici = null;

  const yaz = {
    users: yazici(dosyalar.users, () => users, log),
    sessions: yazici(dosyalar.sessions, () => Object.fromEntries(sessions), log),
    tokens: yazici(dosyalar.tokens, () => Object.fromEntries(tokens), log),
  };

  // Kullanıcı yokken de aynı sürede scrypt çalıştır (kullanıcı var/yok ayırt edilmesin)
  const SAHTE_SALT = '00'.repeat(16);
  const SAHTE_HASH = '00'.repeat(64);

  function oturumTemizle() {
    const simdi = Date.now();
    let silinen = 0;
    for (const [sid, o] of sessions) {
      if (isExpired(o, simdi)) {
        sessions.delete(sid);
        silinen++;
      }
    }
    if (silinen > 0) {
      yaz.sessions.planla();
      log?.info({ silinen }, 'süresi dolan oturumlar temizlendi');
    }
  }

  async function init() {
    await ensureDir(dataDir);
    users = dizi(await toleransliOku(dosyalar.users, [], log));
    for (const [sid, o] of Object.entries(nesne(await toleransliOku(dosyalar.sessions, {}, log)))) {
      if (SID_RE.test(sid) && o && typeof o === 'object') sessions.set(sid, o);
    }
    for (const [t, o] of Object.entries(nesne(await toleransliOku(dosyalar.tokens, {}, log)))) {
      if (o && typeof o === 'object') tokens.set(t, { ...o, uses: dizi(o.uses) });
    }
    oturumTemizle();

    // İlk admin: yalnız users.json boşsa
    if (config.ADMIN_USER && users.length === 0) {
      const { salt, hash } = await hashPassword(config.ADMIN_PASSWORD);
      users.push({
        username: config.ADMIN_USER, role: 'admin', salt, hash,
        createdAt: new Date().toISOString(), disabled: false,
      });
      await yaz.users.planla();
      log?.info(`admin oluşturuldu: ${config.ADMIN_USER}`);
      await audit?.(null, 'admin-olustur', { username: config.ADMIN_USER }, { username: 'sistem', role: null });
    }

    zamanlayici = setInterval(oturumTemizle, TEMIZLIK_ARALIK_MS);
    zamanlayici.unref();
  }

  async function close() {
    if (zamanlayici) clearInterval(zamanlayici);
    zamanlayici = null;
    // Son hâli (kayan süre/lastSeen) diske al
    await Promise.all([yaz.sessions.planla(), yaz.users.bosalt(), yaz.tokens.bosalt()]);
  }

  // ---- kullanıcılar
  const kullaniciBul = (ad) => users.find((u) => u.username === ad);

  async function verifyLogin(username, password) {
    const ad = normalizeUsername(username);
    const kullanici = isValidUsername(ad) ? kullaniciBul(ad) : undefined;
    const dogru = await verifyPassword(
      typeof password === 'string' ? password : '',
      kullanici?.salt ?? SAHTE_SALT,
      kullanici?.hash ?? SAHTE_HASH,
    );
    return kullanici && dogru && !kullanici.disabled ? kullanici : null;
  }

  function listUsers() {
    return users.map((u) => ({
      username: u.username, role: u.role, createdAt: u.createdAt, disabled: Boolean(u.disabled),
    }));
  }

  function hata(statusCode, kod, mesaj) {
    const e = new Error(mesaj);
    e.statusCode = statusCode;
    e.code = kod;
    return e;
  }

  /**
   * Kullanıcı oluştur / şifre-rol-durum güncelle. Şifre, rol ya da devre dışı değişince
   * kullanıcının diğer oturumları düşürülür (`koruSid` hariç).
   */
  async function upsertUser({ username, password, role, disabled }, koruSid = null) {
    const ad = normalizeUsername(username);
    if (!isValidUsername(ad)) throw hata(400, 'kullanici-adi-gecersiz', 'Kullanıcı adı 2-32 karakter, yalnız a-z 0-9 . _ - olabilir');
    if (!ROLLER.includes(role)) throw hata(400, 'rol-gecersiz', `Rol şunlardan biri olmalı: ${ROLLER.join(', ')}`);
    if (password !== undefined && !sifreGecerliMi(password)) {
      throw hata(400, 'sifre-gecersiz', `Şifre ${SIFRE_MIN}-${SIFRE_MAX} karakter olmalı`);
    }
    const mevcut = kullaniciBul(ad);
    if (!mevcut && password === undefined) throw hata(400, 'sifre-gerekli', 'Yeni kullanıcı için şifre gerekli');

    const yeniDisabled = disabled === undefined ? Boolean(mevcut?.disabled) : Boolean(disabled);
    // Son etkin admini kaybetme (kilitlenme) engeli
    if (mevcut && mevcut.role === 'admin' && !mevcut.disabled && (role !== 'admin' || yeniDisabled)) {
      const baskaAdmin = users.some((u) => u !== mevcut && u.role === 'admin' && !u.disabled);
      if (!baskaAdmin) throw hata(400, 'son-admin', 'Son etkin admin kullanıcısı düşürülemez');
    }

    const kayit = mevcut ?? { username: ad, createdAt: new Date().toISOString() };
    const degisti = Boolean(mevcut) && (password !== undefined || mevcut.role !== role || Boolean(mevcut.disabled) !== yeniDisabled);
    if (password !== undefined) Object.assign(kayit, await hashPassword(password));
    kayit.role = role;
    kayit.disabled = yeniDisabled;
    if (!mevcut) users.push(kayit);
    await yaz.users.planla();
    if (degisti) dropUserSessions(ad, koruSid);
    return { created: !mevcut, username: ad, role, disabled: yeniDisabled };
  }

  // ---- oturumlar
  function cookieSeceneklerini(maxAgeSn) {
    return { httpOnly: true, sameSite: 'lax', path: '/', secure: config.isProd, maxAge: maxAgeSn };
  }

  function setCookie(reply, sid, role) {
    reply.setCookie(COOKIE_ADI, signSid(sid, secret), cookieSeceneklerini(Math.floor(sessionTtl(role) / 1000)));
  }

  function clearCookie(reply) {
    reply.clearCookie(COOKIE_ADI, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProd });
  }

  /** Yeni oturum açar; sid döner. Çerezi çağıran `setCookie` ile yazar. */
  function createSession({ username, role, ua }) {
    const sid = newSid();
    const simdi = Date.now();
    sessions.set(sid, {
      username, role, createdAt: simdi, expiresAt: simdi + sessionTtl(role), lastSeen: simdi,
      ua: String(ua ?? '').slice(0, 300),
    });
    yaz.sessions.planla();
    return sid;
  }

  function destroySession(sid) {
    const silindi = sessions.delete(sid);
    if (silindi) yaz.sessions.planla();
    return silindi;
  }

  function dropUserSessions(username, koruSid = null) {
    let adet = 0;
    for (const [sid, o] of sessions) {
      if (o.username === username && sid !== koruSid) {
        sessions.delete(sid);
        adet++;
      }
    }
    if (adet > 0) yaz.sessions.planla();
    return adet;
  }

  /**
   * İstekteki çerezden oturumu çözer; { username, role } ya da null. Kayan süreyi uzatır,
   * lastSeen'i en fazla 10 dakikada bir yazar (ve çerezi tazeler). req.sid'i doldurur.
   * "ad:etiket" biçimli kullanıcı adları sihirli link (patron) oturumlarıdır; users.json'da aranmaz.
   */
  function resolve(req, reply) {
    req.sid = null;
    const ham = req.cookies?.[COOKIE_ADI];
    if (!ham) return null;
    const sid = verifyCookie(ham, secret);
    if (!sid) return null;
    const o = sessions.get(sid);
    if (!o) return null;
    const simdi = Date.now();
    if (isExpired(o, simdi)) {
      sessions.delete(sid);
      yaz.sessions.planla();
      return null;
    }
    let role = o.role;
    if (!o.username.includes(':')) {
      const k = kullaniciBul(o.username);
      if (!k || k.disabled) {
        sessions.delete(sid);
        yaz.sessions.planla();
        return null;
      }
      role = k.role; // rol değişikliği anında yansısın
    }
    o.expiresAt = simdi + sessionTtl(role);
    if (simdi - o.lastSeen >= LASTSEEN_ARALIK_MS) {
      o.lastSeen = simdi;
      o.role = role;
      yaz.sessions.planla();
      if (reply) setCookie(reply, sid, role); // çerez ömrünü de kaydır
    }
    req.sid = sid;
    return { username: o.username, role };
  }

  function listSessions(gecerliSid = null) {
    const iso = (ms) => new Date(ms).toISOString();
    return [...sessions].map(([sid, o]) => ({
      sid, username: o.username, role: o.role, createdAt: iso(o.createdAt),
      expiresAt: iso(o.expiresAt), lastSeen: iso(o.lastSeen), ua: o.ua, current: sid === gecerliSid,
    }));
  }

  // ---- sihirli link
  /** Yeni patron linki token'ı üretir. Token yalnız yanıtta döner; loglanmaz. */
  async function createMagicLink({ label = '', days = 2, maxDevices = 3 }) {
    const token = randomBytes(32).toString('base64url');
    const simdi = Date.now();
    const kayit = {
      role: 'patron', label, createdAt: simdi, expiresAt: simdi + days * GUN_MS, maxDevices, uses: [],
    };
    tokens.set(token, kayit);
    await yaz.tokens.planla();
    return { token, expiresAt: kayit.expiresAt };
  }

  /** Token durumu: 'ok' | 'yok' | 'suresi-doldu' | 'dolu' (cihaz sınırı). */
  function inspectToken(token) {
    if (typeof token !== 'string') return { durum: 'yok' };
    const kayit = tokens.get(token);
    if (!kayit || kayit.role !== 'patron') return { durum: 'yok' };
    if (typeof kayit.expiresAt !== 'number' || kayit.expiresAt <= Date.now()) return { durum: 'suresi-doldu', kayit };
    if (kayit.uses.length >= kayit.maxDevices) return { durum: 'dolu', kayit };
    return { durum: 'ok', kayit };
  }

  /** Token'ı bir cihaz için yakar ve patron oturumu açar. Geçersizse null. */
  async function consumeToken(token, { ua, ip }) {
    const { durum, kayit } = inspectToken(token);
    if (durum !== 'ok') return null;
    kayit.uses.push({ at: Date.now(), ua: String(ua ?? '').slice(0, 300), ip: ip ?? null });
    await yaz.tokens.planla();
    const sid = createSession({
      username: `patron:${String(kayit.label || 'link').slice(0, 40)}`, role: 'patron', ua,
    });
    return { sid, label: kayit.label };
  }

  return {
    init, close, resolve, verifyLogin,
    listUsers, upsertUser,
    createSession, destroySession, dropUserSessions, listSessions, setCookie, clearCookie,
    createMagicLink, inspectToken, consumeToken,
  };
}
