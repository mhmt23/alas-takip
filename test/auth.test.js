// auth.js testleri: şifre hash'i, çerez imzası, oturum süresi, webview/next yardımcıları
// ve uçtan uca giriş, sihirli link, yetki, dosya sunumu/yükleme akışları (app.inject ile).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hashPassword, verifyPassword, signSid, verifyCookie, newSid, sessionTtl, isExpired,
  safeNext, isWebview, normalizeUsername, isValidUsername, OTURUM_SURESI, COOKIE_ADI,
} from '../server/auth.js';
import { loadConfig, YapilandirmaHatasi } from '../server/config.js';
import { buildApp, urlMaskele } from '../server/index.js';

const GUN = 24 * 60 * 60 * 1000;
const SECRET = 'test-gizli-anahtar-0123456789';

// ------------------------------------------------------------------ saf yardımcılar

test('scrypt: hash üretir ve doğrular; yanlış şifre/salt reddedilir', async () => {
  const { salt, hash } = await hashPassword('deneme123');
  assert.match(salt, /^[0-9a-f]{32}$/); // 16 bayt
  assert.match(hash, /^[0-9a-f]{128}$/); // 64 bayt
  assert.equal(await verifyPassword('deneme123', salt, hash), true);
  assert.equal(await verifyPassword('deneme124', salt, hash), false);
  assert.equal(await verifyPassword('', salt, hash), false);
  assert.equal(await verifyPassword('deneme123', '00'.repeat(16), hash), false);
  assert.equal(await verifyPassword(undefined, salt, hash), false);
  assert.equal(await verifyPassword('x'.repeat(1000), salt, hash), false);
  // her hash farklı salt kullanır
  const baska = await hashPassword('deneme123');
  assert.notEqual(baska.salt, salt);
  assert.notEqual(baska.hash, hash);
  // aynı salt → aynı hash (deterministik)
  assert.deepEqual(await hashPassword('deneme123', salt), { salt, hash });
});

test('scrypt: Türkçe karakterlerde bileşik/ayrık (NFC/NFD) şifre aynı sayılır', async () => {
  const bilesik = 'şifreğüçöı1'.normalize('NFC');
  const ayrik = 'şifreğüçöı1'.normalize('NFD');
  assert.notEqual(bilesik, ayrik);
  const { salt, hash } = await hashPassword(bilesik);
  assert.equal(await verifyPassword(ayrik, salt, hash), true);
});

test('çerez imzası: doğru çerez sid verir; kurcalanmış/yanlış gizli/bozuk reddedilir', () => {
  const sid = newSid();
  assert.match(sid, /^[A-Za-z0-9_-]{43}$/);
  const cerez = signSid(sid, SECRET);
  assert.match(cerez, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(verifyCookie(cerez, SECRET), sid);

  assert.equal(verifyCookie(cerez, 'baska-gizli'), null);
  const [s, imza] = cerez.split('.');
  const degisikSid = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  assert.equal(verifyCookie(`${degisikSid}.${imza}`, SECRET), null);
  // İmzanın İLK karakteri değiştirilir: son karakterin alt 4 biti base64url dolgusudur,
  // orada yapılan değişiklik aynı 16 bayta çözülür (rastgele düşen test buydu).
  const degisikImza = (imza[0] === 'A' ? 'B' : 'A') + imza.slice(1);
  assert.equal(verifyCookie(`${s}.${degisikImza}`, SECRET), null);
  // Kanonik olmayan kodlama (dolgu bitleri farklı, aynı bayt dizisi) da reddedilir
  const son = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const sonIdx = son.indexOf(imza.at(-1));
  const dolguFarkli = imza.slice(0, -1) + son[sonIdx ^ 1]; // alt bit dolgu: aynı bayt, farklı yazım
  assert.equal(Buffer.from(dolguFarkli, 'base64url').equals(Buffer.from(imza, 'base64url')), true);
  assert.equal(verifyCookie(`${s}.${dolguFarkli}`, SECRET), null);

  for (const kotu of ['', 'abc', `${s}`, `${s}.`, `.${imza}`, `${s}.${imza}x`, null, undefined, 42, `${s}.${imza}.${imza}`]) {
    assert.equal(verifyCookie(kotu, SECRET), null, `kabul edildi: ${String(kotu)}`);
  }
});

test('oturum süreleri ve süre dolumu', () => {
  assert.equal(sessionTtl('patron'), 90 * GUN);
  assert.equal(sessionTtl('sef'), 30 * GUN);
  assert.equal(sessionTtl('pilot'), 30 * GUN);
  assert.equal(sessionTtl('admin'), 7 * GUN);
  assert.deepEqual(Object.keys(OTURUM_SURESI).sort(), ['admin', 'patron', 'pilot', 'sef']);

  const simdi = 1_000_000_000_000;
  assert.equal(isExpired({ expiresAt: simdi + 1 }, simdi), false);
  assert.equal(isExpired({ expiresAt: simdi }, simdi), true); // tam sınır = dolmuş
  assert.equal(isExpired({ expiresAt: simdi - 1 }, simdi), true);
  assert.equal(isExpired(undefined, simdi), true);
  assert.equal(isExpired({}, simdi), true);
});

test('kullanıcı adı normalizasyonu ve doğrulama', () => {
  assert.equal(normalizeUsername('  Sef.Ahmet '), 'sef.ahmet');
  assert.equal(normalizeUsername(5), '');
  for (const ok of ['ab', 'sef', 'a.b_c-9', 'x'.repeat(32)]) assert.equal(isValidUsername(ok), true, ok);
  for (const kotu of ['a', 'x'.repeat(33), 'Büyük', 'a b', 'a:b', '', 'şef']) assert.equal(isValidUsername(kotu), false, kotu);
});

test('safeNext: yalnız site içi yollar; açık yönlendirme engellenir', () => {
  assert.equal(safeNext('/app.html'), '/app.html');
  assert.equal(safeNext('/app.html?dataset=ornek'), '/app.html?dataset=ornek');
  assert.equal(safeNext('/rapor/2026-10-07/'), '/rapor/2026-10-07/');
  for (const kotu of ['//evil.com', '/\\evil.com', 'https://evil.com', 'app.html', '', null, undefined, 5, '/a\r\nSet-Cookie: x=1', '/a\\b', '/', '/index.html', '/index.html?next=/x', '/' + 'a'.repeat(600)]) {
    assert.equal(safeNext(kotu), null, `kabul edildi: ${String(kotu)}`);
  }
});

test('webview tespiti', () => {
  const webview = [
    'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/430.0.0.0]',
    'Mozilla/5.0 (iPhone) AppleWebKit/605 Mobile/15E148 Instagram 300.0.0',
    'Mozilla/5.0 (Linux; Android 12) Chrome/110 Mobile Safari/537.36 WhatsApp/2.23',
    'Mozilla/5.0 (iPhone) AppleWebKit/605 Safari Line/13.0.0',
  ];
  const tarayici = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
  ];
  for (const ua of webview) assert.equal(isWebview(ua), true, ua);
  for (const ua of tarayici) assert.equal(isWebview(ua), false, ua);
  assert.equal(isWebview(undefined), false);
});

test('loglarda sihirli link token\'ı maskelenir', () => {
  assert.equal(urlMaskele('/g/AbC123_-xyz?x=1'), '/g/***?x=1');
  assert.equal(urlMaskele('/api/me'), '/api/me');
});

test('config: prod\'da SESSION_SECRET zorunlu; admin değişkenleri birlikte; gizli alanlar görünmez', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), YapilandirmaHatasi);
  const prod = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: SECRET });
  assert.equal(prod.isProd, true);
  assert.equal(prod.TRUST_PROXY, true);
  assert.equal(prod.PORT, 3000);
  assert.equal(prod.TZ, 'Europe/Istanbul');

  const dev = loadConfig({});
  assert.equal(dev.secretGenerated, true);
  assert.ok(dev.SESSION_SECRET.length >= 32);
  assert.equal(dev.TRUST_PROXY, false);

  assert.throws(() => loadConfig({ ADMIN_USER: 'admin' }), YapilandirmaHatasi);
  assert.throws(() => loadConfig({ ADMIN_USER: 'A', ADMIN_PASSWORD: 'deneme123' }), YapilandirmaHatasi);
  assert.throws(() => loadConfig({ ADMIN_USER: 'admin', ADMIN_PASSWORD: 'kisa' }), YapilandirmaHatasi);
  assert.throws(() => loadConfig({ PORT: 'abc' }), YapilandirmaHatasi);
  assert.throws(() => loadConfig({ TZ: 'Mars/Olympus' }), YapilandirmaHatasi);

  const cfg = loadConfig({ SESSION_SECRET: SECRET, ADMIN_USER: 'Admin', ADMIN_PASSWORD: 'deneme123' });
  assert.equal(cfg.ADMIN_USER, 'admin');
  const metin = JSON.stringify(cfg) + String(Object.values(cfg));
  assert.ok(!metin.includes('deneme123') && !metin.includes(SECRET), 'gizli değer numaralandırılabiliyor');
  assert.equal(cfg.ADMIN_PASSWORD, 'deneme123');
});

// ------------------------------------------------------------------ uçtan uca (app.inject)

const UA_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_WEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/430.0]';

let ipSayaci = 10;
const yeniIp = () => `10.1.${Math.floor(++ipSayaci / 250)}.${ipSayaci % 250}`;

async function uygulamaKur({ oturumlar, env = {} } = {}) {
  const kok = await mkdtemp(path.join(tmpdir(), 'alas-auth-'));
  const publicDir = path.join(kok, 'public');
  const dataDir = path.join(kok, 'data');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Giriş</title><h1>giris</h1>');
  await writeFile(path.join(publicDir, 'app.html'), '<!doctype html><title>Pano</title>');
  await writeFile(path.join(publicDir, 'sw.js'), '// sw');
  await mkdir(path.join(publicDir, 'fonts'), { recursive: true });
  await writeFile(path.join(publicDir, 'fonts', 'x.woff2'), 'FONT');
  await writeFile(path.join(publicDir, 'fonts', 'fonts.css'), '/* fonts */');
  if (oturumlar) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'sessions.json'), JSON.stringify(oturumlar));
  }
  const config = loadConfig({
    DATA_DIR: dataDir, PUBLIC_DIR: publicDir, SESSION_SECRET: SECRET,
    ADMIN_USER: 'admin', ADMIN_PASSWORD: 'deneme123', LOG_LEVEL: 'silent', ...env,
  });
  const app = await buildApp(config, { logger: false });
  await app.ready();
  return {
    app, kok, dataDir, publicDir,
    async kapat() {
      await app.close();
      await rm(kok, { recursive: true, force: true });
    },
  };
}

function cerezDegeri(yanit) {
  const c = yanit.cookies.find((x) => x.name === COOKIE_ADI);
  return c && c.value ? `${COOKIE_ADI}=${c.value}` : null;
}

/** Giriş yapar; { yanit, cerez } döner. Her çağrı kendi IP'sinden gelir (hız sınırına takılmasın). */
async function girisYap(app, username, password, ekstra = {}) {
  const yanit = await app.inject({
    method: 'POST', url: '/api/login', payload: { username, password }, remoteAddress: yeniIp(), ...ekstra,
  });
  return { yanit, cerez: cerezDegeri(yanit) };
}

const cerezli = (cerez, headers = {}) => ({ ...headers, ...(cerez ? { cookie: cerez } : {}) });

describe('giriş, oturum ve yetki', () => {
  let t;
  let adminCerez;

  before(async () => {
    t = await uygulamaKur();
    adminCerez = (await girisYap(t.app, 'admin', 'deneme123')).cerez;
  });
  after(() => t.kapat());

  test('ilk admin ADMIN_USER/ADMIN_PASSWORD ile oluşur, şifre düz yazılmaz', async () => {
    assert.ok(adminCerez, 'admin girişi çerez vermedi');
    const users = JSON.parse(await readFile(path.join(t.dataDir, 'users.json'), 'utf8'));
    assert.equal(users.length, 1);
    assert.equal(users[0].username, 'admin');
    assert.equal(users[0].role, 'admin');
    assert.match(users[0].hash, /^[0-9a-f]{128}$/);
    assert.ok(!JSON.stringify(users).includes('deneme123'));
  });

  test('yanlış şifre ve olmayan kullanıcı aynı 401 yanıtını alır', async () => {
    const yanlis = await girisYap(t.app, 'admin', 'yanlis-sifre');
    const yok = await girisYap(t.app, 'olmayan', 'yanlis-sifre');
    for (const { yanit, cerez } of [yanlis, yok]) {
      assert.equal(yanit.statusCode, 401);
      assert.deepEqual(yanit.json(), { error: 'sifre-yanlis' });
      assert.equal(cerez, null);
    }
    const eksik = await t.app.inject({ method: 'POST', url: '/api/login', payload: {}, remoteAddress: yeniIp() });
    assert.equal(eksik.statusCode, 401);
  });

  test('doğru giriş: 200 + HttpOnly/SameSite=Lax çerez + role/next', async () => {
    const { yanit } = await girisYap(t.app, 'ADMIN', 'deneme123', { payload: { username: 'ADMIN', password: 'deneme123', next: '/app.html?dataset=ornek' } });
    assert.equal(yanit.statusCode, 200);
    assert.deepEqual(yanit.json(), { ok: true, role: 'admin', next: '/app.html?dataset=ornek' });
    const ham = [].concat(yanit.headers['set-cookie']).find((c) => c.startsWith(`${COOKIE_ADI}=`));
    assert.match(ham, /HttpOnly/i);
    assert.match(ham, /SameSite=Lax/i);
    assert.match(ham, /Path=\//);
    assert.doesNotMatch(ham, /Secure/i, 'geliştirmede Secure olmamalı'); // prod\'da Secure
  });

  test('açık yönlendirme: dış next yok sayılır, varsayılan /app.html', async () => {
    for (const next of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
      const { yanit } = await girisYap(t.app, 'admin', 'deneme123', { payload: { username: 'admin', password: 'deneme123', next } });
      assert.equal(yanit.json().next, '/app.html', next);
    }
  });

  test('form girişi 302 ile yönlendirir', async () => {
    const yanit = await t.app.inject({
      method: 'POST', url: '/api/login', remoteAddress: yeniIp(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=admin&password=deneme123&next=%2Fapp.html',
    });
    assert.equal(yanit.statusCode, 302);
    assert.equal(yanit.headers.location, '/app.html');
    assert.ok(cerezDegeri(yanit));
  });

  test('/api/me: oturumsuz 401, oturumla kullanıcı bilgisi', async () => {
    const yok = await t.app.inject({ url: '/api/me' });
    assert.equal(yok.statusCode, 401);
    assert.deepEqual(yok.json(), { error: 'giris-gerekli' });
    const var_ = await t.app.inject({ url: '/api/me', headers: cerezli(adminCerez) });
    assert.equal(var_.statusCode, 200);
    assert.deepEqual(var_.json(), { username: 'admin', role: 'admin' });
  });

  test('sayfa isteğinde (Accept: text/html) oturumsuz → 302 /?next=', async () => {
    const yanit = await t.app.inject({ url: '/rapor/2026-10-07/', headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(yanit.statusCode, 302);
    assert.equal(yanit.headers.location, '/?next=' + encodeURIComponent('/rapor/2026-10-07/'));
  });

  test('sahte/kurcalanmış çerez reddedilir', async () => {
    const sidOlmayan = signSid(newSid(), SECRET); // imza doğru ama oturum yok
    const baskaGizli = signSid(newSid(), 'baska-gizli');
    for (const c of [`${COOKIE_ADI}=${sidOlmayan}`, `${COOKIE_ADI}=${baskaGizli}`, `${COOKIE_ADI}=bozuk`]) {
      const yanit = await t.app.inject({ url: '/api/me', headers: { cookie: c } });
      assert.equal(yanit.statusCode, 401, c);
    }
  });

  test('"/" oturumsuz giriş sayfasını verir, oturumluysa /app.html ya da next\'e yönlendirir', async () => {
    const sayfa = await t.app.inject({ url: '/' });
    assert.equal(sayfa.statusCode, 200);
    assert.match(sayfa.body, /giris/);
    assert.equal(sayfa.headers['cache-control'], 'no-cache');
    const yon = await t.app.inject({ url: '/', headers: cerezli(adminCerez) });
    assert.equal(yon.statusCode, 302);
    assert.equal(yon.headers.location, '/app.html');
    const yon2 = await t.app.inject({ url: '/?next=%2Frapor%2F2026-10-07%2F', headers: cerezli(adminCerez) });
    assert.equal(yon2.headers.location, '/rapor/2026-10-07/');
    const yon3 = await t.app.inject({ url: '/?next=%2F%2Fevil.com', headers: cerezli(adminCerez) });
    assert.equal(yon3.headers.location, '/app.html');
  });

  test('statik dosyalar herkese açık; önbellek başlıkları ve güvenlik başlıkları', async () => {
    const html = await t.app.inject({ url: '/app.html' });
    assert.equal(html.statusCode, 200);
    assert.equal(html.headers['cache-control'], 'no-cache');
    const font = await t.app.inject({ url: '/fonts/x.woff2' });
    assert.equal(font.statusCode, 200);
    assert.equal(font.headers['cache-control'], 'public, max-age=2592000, immutable');
    // fonts/ altındaki her şey (fonts.css dâhil) 30 gün immutable
    const fontCss = await t.app.inject({ url: '/fonts/fonts.css' });
    assert.equal(fontCss.statusCode, 200);
    assert.equal(fontCss.headers['cache-control'], 'public, max-age=2592000, immutable');
    const sw =await t.app.inject({ url: '/sw.js' });
    assert.equal(sw.headers['cache-control'], 'no-cache');
    for (const yanit of [html, font, await t.app.inject({ url: '/health' }), await t.app.inject({ url: '/yok' })]) {
      assert.equal(yanit.headers['x-frame-options'], 'DENY');
      assert.equal(yanit.headers['x-content-type-options'], 'nosniff');
      assert.equal(yanit.headers['referrer-policy'], 'same-origin');
      assert.equal(yanit.headers['x-robots-tag'], 'noindex, nofollow');
      assert.equal(yanit.headers['strict-transport-security'], undefined, 'HSTS yalnız prod\'da');
    }
    // DATA_DIR / sunucu kodu public üzerinden sızmaz
    for (const yol of ['/users.json', '/sessions.json', '/server/index.js', '/..%2fdata%2fusers.json']) {
      const yanit = await t.app.inject({ url: yol });
      assert.ok([400, 403, 404].includes(yanit.statusCode), `${yol} → ${yanit.statusCode}`);
    }
  });

  test('yetki: admin API oturumsuz 401, patron/şef 403', async () => {
    assert.equal((await t.app.inject({ url: '/api/admin/users' })).statusCode, 401);

    const olustur = await t.app.inject({
      method: 'POST', url: '/api/admin/users', headers: cerezli(adminCerez),
      payload: { username: 'Sef1', password: 'sef-sifre-1', role: 'sef' },
    });
    assert.equal(olustur.statusCode, 200);
    assert.deepEqual(olustur.json(), { ok: true, created: true, username: 'sef1', role: 'sef', disabled: false });

    const { cerez: sefCerez } = await girisYap(t.app, 'sef1', 'sef-sifre-1');
    assert.ok(sefCerez);
    for (const [method, url] of [['GET', '/api/admin/users'], ['GET', '/api/admin/sessions'], ['GET', '/api/admin/audit'], ['POST', '/api/admin/magic-link'], ['PUT', '/api/admin/file?path=web/x.jpg']]) {
      const yanit = await t.app.inject({ method, url, headers: cerezli(sefCerez), payload: method === 'GET' ? undefined : {} });
      assert.equal(yanit.statusCode, 403, `${method} ${url}`);
      assert.deepEqual(yanit.json(), { error: 'yetki-yok' });
    }
  });

  test('admin: kullanıcı listesi şifresiz; geçersiz girdiler 400; son admin korunur', async () => {
    const liste = await t.app.inject({ url: '/api/admin/users', headers: cerezli(adminCerez) });
    assert.equal(liste.statusCode, 200);
    for (const u of liste.json()) {
      assert.deepEqual(Object.keys(u).sort(), ['createdAt', 'disabled', 'role', 'username']);
    }
    const kotu = [
      { username: 'a', password: 'yeterince-uzun', role: 'sef' },
      { username: 'iyi.ad', password: 'kisa', role: 'sef' },
      { username: 'iyi.ad', password: 'yeterince-uzun', role: 'kral' },
      { username: 'iyi.ad', role: 'sef' }, // yeni kullanıcı için şifre şart
    ];
    for (const payload of kotu) {
      const yanit = await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: cerezli(adminCerez), payload });
      assert.equal(yanit.statusCode, 400, JSON.stringify(payload));
    }
    const sonAdmin = await t.app.inject({
      method: 'POST', url: '/api/admin/users', headers: cerezli(adminCerez),
      payload: { username: 'admin', role: 'sef' },
    });
    assert.equal(sonAdmin.statusCode, 400);
    assert.equal(sonAdmin.json().error, 'son-admin');
  });

  test('şifre değişince kullanıcının eski oturumları düşer', async () => {
    await t.app.inject({
      method: 'POST', url: '/api/admin/users', headers: cerezli(adminCerez),
      payload: { username: 'pilot1', password: 'pilot-sifre-1', role: 'pilot' },
    });
    const { cerez } = await girisYap(t.app, 'pilot1', 'pilot-sifre-1');
    assert.equal((await t.app.inject({ url: '/api/me', headers: cerezli(cerez) })).statusCode, 200);
    const degis = await t.app.inject({
      method: 'POST', url: '/api/admin/users', headers: cerezli(adminCerez),
      payload: { username: 'pilot1', password: 'pilot-sifre-2', role: 'pilot' },
    });
    assert.equal(degis.json().created, false);
    assert.equal((await t.app.inject({ url: '/api/me', headers: cerezli(cerez) })).statusCode, 401);
    assert.equal((await girisYap(t.app, 'pilot1', 'pilot-sifre-1')).yanit.statusCode, 401);
    assert.equal((await girisYap(t.app, 'pilot1', 'pilot-sifre-2')).yanit.statusCode, 200);
  });

  test('devre dışı bırakılan kullanıcı giremez ve oturumu düşer', async () => {
    await t.app.inject({
      method: 'POST', url: '/api/admin/users', headers: cerezli(adminCerez),
      payload: { username: 'gecici', password: 'gecici-sifre-1', role: 'sef' },
    });
    const { cerez } = await girisYap(t.app, 'gecici', 'gecici-sifre-1');
    await t.app.inject({
      method: 'POST', url: '/api/admin/users', headers: cerezli(adminCerez),
      payload: { username: 'gecici', role: 'sef', disabled: true },
    });
    assert.equal((await t.app.inject({ url: '/api/me', headers: cerezli(cerez) })).statusCode, 401);
    assert.equal((await girisYap(t.app, 'gecici', 'gecici-sifre-1')).yanit.statusCode, 401);
  });

  test('oturum listesi/düşürme ve çıkış', async () => {
    const { cerez } = await girisYap(t.app, 'admin', 'deneme123');
    const liste = await t.app.inject({ url: '/api/admin/sessions', headers: cerezli(adminCerez) });
    assert.equal(liste.statusCode, 200);
    const oturumlar = liste.json();
    assert.ok(oturumlar.length >= 2);
    assert.ok(oturumlar.some((o) => o.current), 'geçerli oturum işaretlenmeli');
    assert.deepEqual(Object.keys(oturumlar[0]).sort(), ['createdAt', 'current', 'expiresAt', 'lastSeen', 'role', 'sid', 'ua', 'username']);

    // başka oturumu düşür
    const hedef = oturumlar.find((o) => !o.current && verifyCookie(cerez.split('=')[1], SECRET) === o.sid);
    assert.ok(hedef);
    const sil = await t.app.inject({ method: 'DELETE', url: `/api/admin/sessions/${hedef.sid}`, headers: cerezli(adminCerez) });
    assert.equal(sil.statusCode, 200);
    assert.equal((await t.app.inject({ url: '/api/me', headers: cerezli(cerez) })).statusCode, 401);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/admin/sessions/${hedef.sid}`, headers: cerezli(adminCerez) })).statusCode, 404);

    // çıkış: oturumu siler, çerezi temizler, / adresine yönlendirir
    const { cerez: gecici } = await girisYap(t.app, 'admin', 'deneme123');
    const cikis = await t.app.inject({ url: '/cikis', headers: cerezli(gecici) });
    assert.equal(cikis.statusCode, 302);
    assert.equal(cikis.headers.location, '/');
    assert.equal(cerezDegeri(cikis), null, 'çerez temizlenmeli');
    assert.equal((await t.app.inject({ url: '/api/me', headers: cerezli(gecici) })).statusCode, 401);
  });

  test('denetim kaydı: giriş, çıkış, kullanıcı işlemleri kaydedilir; şifre/token yok', async () => {
    const yanit = await t.app.inject({ url: '/api/admin/audit?n=200', headers: cerezli(adminCerez) });
    assert.equal(yanit.statusCode, 200);
    const satirlar = yanit.json();
    const eylemler = new Set(satirlar.map((s) => s.action));
    for (const e of ['admin-olustur', 'giris', 'giris-basarisiz', 'kullanici-olustur', 'cikis']) {
      assert.ok(eylemler.has(e), `kayıt yok: ${e}`);
    }
    for (const s of satirlar) {
      assert.deepEqual(Object.keys(s).sort(), ['action', 'detail', 'ip', 'role', 'ts', 'user']);
    }
    const ham = JSON.stringify(satirlar);
    for (const gizli of ['deneme123', 'sef-sifre-1', 'pilot-sifre-2', SECRET]) {
      assert.ok(!ham.includes(gizli), `denetim kaydında gizli değer: ${gizli}`);
    }
    assert.equal((await t.app.inject({ url: '/api/admin/audit?n=2', headers: cerezli(adminCerez) })).json().length, 2);
  });

  test('/health her zaman 200, beklenen alanlar', async () => {
    const yanit = await t.app.inject({ url: '/health' });
    assert.equal(yanit.statusCode, 200);
    const g = yanit.json();
    assert.equal(g.ok, true);
    assert.equal(g.dataWritable, true);
    assert.equal(g.lastPhotoDay, null);
    assert.equal(g.lastLogDay, null);
    assert.equal(typeof g.uptimeSec, 'number');
    assert.match(g.version, /^\d+\.\d+\.\d+/);
    await assert.rejects(() => stat(path.join(t.dataDir, '.write-test')), { code: 'ENOENT' });
  });
});

describe('oturum süresi (kayan) ve diskten yükleme', () => {
  test('süresi dolmuş oturum reddedilir, geçerli olan sunucu yeniden başlayınca da çalışır', async () => {
    const simdi = Date.now();
    const gecerliSid = newSid();
    const dolmusSid = newSid();
    const t = await uygulamaKur({
      oturumlar: {
        [gecerliSid]: { username: 'admin', role: 'admin', createdAt: simdi - 1000, expiresAt: simdi + GUN, lastSeen: simdi - 1000, ua: 'x' },
        [dolmusSid]: { username: 'admin', role: 'admin', createdAt: simdi - 8 * GUN, expiresAt: simdi - 1000, lastSeen: simdi - 8 * GUN, ua: 'x' },
      },
    });
    try {
      const gecerli = await t.app.inject({ url: '/api/me', headers: { cookie: `${COOKIE_ADI}=${signSid(gecerliSid, SECRET)}` } });
      // sessions.json yüklenirken kullanıcı ("admin") ilk açılışta oluşturulmuş olmalı
      assert.equal(gecerli.statusCode, 200);
      const dolmus = await t.app.inject({ url: '/api/me', headers: { cookie: `${COOKIE_ADI}=${signSid(dolmusSid, SECRET)}` } });
      assert.equal(dolmus.statusCode, 401);
    } finally {
      await t.kapat();
    }
  });

  test('lastSeen en fazla 10 dakikada bir yazılır; kayan süre uzar; çerez tazelenir', async () => {
    const simdi = Date.now();
    const eskiSid = newSid();
    const tazeSid = newSid();
    const t = await uygulamaKur({
      oturumlar: {
        [eskiSid]: { username: 'admin', role: 'admin', createdAt: simdi - 3600_000, expiresAt: simdi + 1000, lastSeen: simdi - 11 * 60_000, ua: 'x' },
        [tazeSid]: { username: 'admin', role: 'admin', createdAt: simdi - 3600_000, expiresAt: simdi + 1000, lastSeen: simdi - 60_000, ua: 'x' },
      },
    });
    try {
      // 11 dk önce görülmüş → lastSeen güncellenir ve Set-Cookie ile çerez ömrü uzatılır
      const eski = await t.app.inject({ url: '/api/me', headers: { cookie: `${COOKIE_ADI}=${signSid(eskiSid, SECRET)}` } });
      assert.equal(eski.statusCode, 200);
      assert.ok(cerezDegeri(eski), '10 dk geçtiyse çerez tazelenmeli');
      // 1 dk önce görülmüş → çerez tazelenmez (disk yazımı azaltılır)
      const taze = await t.app.inject({ url: '/api/me', headers: { cookie: `${COOKIE_ADI}=${signSid(tazeSid, SECRET)}` } });
      assert.equal(taze.statusCode, 200);
      assert.equal(cerezDegeri(taze), null);
      // her iki oturumun süresi role göre (admin 7 gün) uzatılmış olmalı
      const liste = await t.app.inject({
        method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'deneme123' }, remoteAddress: yeniIp(),
      });
      const yonetici = cerezDegeri(liste);
      const oturumlar = (await t.app.inject({ url: '/api/admin/sessions', headers: { cookie: yonetici } })).json();
      for (const sid of [eskiSid, tazeSid]) {
        const o = oturumlar.find((x) => x.sid === sid);
        assert.ok(Date.parse(o.expiresAt) > simdi + 6 * GUN, 'kayan süre uzamadı');
      }
      assert.ok(Date.parse(oturumlar.find((x) => x.sid === eskiSid).lastSeen) >= simdi - 5000, 'lastSeen güncellenmedi');
      assert.ok(Date.parse(oturumlar.find((x) => x.sid === tazeSid).lastSeen) < simdi - 30_000, 'lastSeen gereksiz güncellendi');
    } finally {
      await t.kapat();
    }
  });
});

describe('üretim modu (NODE_ENV=production)', () => {
  test('Secure çerez, HSTS ve proxy arkasında gerçek IP/protokol', async () => {
    const t = await uygulamaKur({ env: { NODE_ENV: 'production' } });
    try {
      const proxy = { 'x-forwarded-for': '203.0.113.50', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'alas.example.com' };
      const giris = await t.app.inject({
        method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'deneme123' }, headers: proxy, remoteAddress: '10.0.0.1',
      });
      assert.equal(giris.statusCode, 200);
      const ham = [].concat(giris.headers['set-cookie']).find((c) => c.startsWith(`${COOKIE_ADI}=`));
      assert.match(ham, /HttpOnly/i);
      assert.match(ham, /Secure/i);
      assert.match(ham, /SameSite=Lax/i);
      assert.equal(giris.headers['strict-transport-security'], 'max-age=15552000');

      const cerez = cerezDegeri(giris);
      const link = await t.app.inject({ method: 'POST', url: '/api/admin/magic-link', headers: { ...proxy, cookie: cerez }, payload: { label: 'p' } });
      assert.match(link.json().url, /^https:\/\/alas\.example\.com\/g\/[A-Za-z0-9_-]{43}$/);

      const denetim = (await t.app.inject({ url: '/api/admin/audit?n=5', headers: { ...proxy, cookie: cerez } })).json();
      assert.equal(denetim.find((s) => s.action === 'giris').ip, '203.0.113.50');
    } finally {
      await t.kapat();
    }
  });

  test('geliştirmede X-Forwarded-* yok sayılır (TRUST_PROXY kapalı)', async () => {
    const t = await uygulamaKur();
    try {
      const giris = await t.app.inject({
        method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'deneme123' },
        headers: { 'x-forwarded-for': '203.0.113.50' }, remoteAddress: '10.0.0.7',
      });
      const denetim = (await t.app.inject({ url: '/api/admin/audit?n=5', headers: { cookie: cerezDegeri(giris) } })).json();
      assert.equal(denetim.find((s) => s.action === 'giris').ip, '10.0.0.7');
    } finally {
      await t.kapat();
    }
  });
});

describe('hız sınırı', () => {
  test('/api/login 5 deneme/15 dk/IP; 6. deneme 429', async () => {
    const t = await uygulamaKur();
    try {
      const ip = '203.0.113.9';
      for (let i = 0; i < 5; i++) {
        const y = await t.app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'yanlis' }, remoteAddress: ip });
        assert.equal(y.statusCode, 401, `deneme ${i + 1}`);
      }
      const sinir = await t.app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'deneme123' }, remoteAddress: ip });
      assert.equal(sinir.statusCode, 429);
      assert.equal(sinir.json().error, 'cok-fazla-deneme');
      assert.match(sinir.json().mesaj, /dakika/);
      assert.equal(cerezDegeri(sinir), null);
      // başka IP etkilenmez; diğer rotalar sınırlanmaz
      assert.equal((await girisYap(t.app, 'admin', 'deneme123')).yanit.statusCode, 200);
      for (let i = 0; i < 8; i++) assert.equal((await t.app.inject({ url: '/health', remoteAddress: ip })).statusCode, 200);
    } finally {
      await t.kapat();
    }
  });
});

describe('sihirli link (patron)', () => {
  let t;
  let adminCerez;

  before(async () => {
    t = await uygulamaKur();
    adminCerez = (await girisYap(t.app, 'admin', 'deneme123')).cerez;
  });
  after(() => t.kapat());

  const linkUret = async (payload) => {
    const y = await t.app.inject({ method: 'POST', url: '/api/admin/magic-link', headers: { ...cerezli(adminCerez), host: 'alas.example.com' }, payload });
    assert.equal(y.statusCode, 200, y.body);
    return y.json();
  };

  test('link üretimi: url, token, expiresAt; varsayılanlar 2 gün / 3 cihaz', async () => {
    const { url, token, expiresAt } = await linkUret({ label: 'Patron Telefon' });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(url, `http://alas.example.com/g/${token}`);
    const fark = Date.parse(expiresAt) - Date.now();
    assert.ok(Math.abs(fark - 2 * GUN) < 60_000, `süre ~2 gün olmalı: ${fark}`);
    const kayitlar = JSON.parse(await readFile(path.join(t.dataDir, 'tokens.json'), 'utf8'));
    assert.equal(kayitlar[token].maxDevices, 3);
    assert.equal(kayitlar[token].role, 'patron');
    assert.equal(kayitlar[token].label, 'Patron Telefon');
    assert.deepEqual(kayitlar[token].uses, []);

    for (const payload of [{ days: 0 }, { days: 400 }, { days: 'x' }, { maxDevices: 0 }, { maxDevices: 2.5 }, { maxDevices: 99 }]) {
      const kotu = await t.app.inject({ method: 'POST', url: '/api/admin/magic-link', headers: cerezli(adminCerez), payload });
      assert.equal(kotu.statusCode, 400, JSON.stringify(payload));
    }
  });

  test('link listesi token göstermez; iptal edilen link artık çalışmaz, oturumlar istenirse düşer', async () => {
    const { token } = await linkUret({ label: 'iptal-deneme', maxDevices: 2 });
    const liste = await t.app.inject({ url: '/api/admin/magic-links', headers: cerezli(adminCerez) });
    assert.equal(liste.statusCode, 200);
    assert.ok(!liste.body.includes(token), 'listede token olmamalı');
    const kayit = liste.json().find((k) => k.label === 'iptal-deneme');
    assert.match(kayit.id, /^[0-9a-f]{12}$/);
    assert.equal(kayit.durum, 'acik');
    // bir cihaz kullanır
    const ilk = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI } });
    assert.equal(ilk.statusCode, 302);
    const patronCerez = cerezDegeri(ilk);
    assert.ok(patronCerez);
    // geçersiz id ve patron yetkisi reddedilir
    assert.equal((await t.app.inject({ method: 'DELETE', url: '/api/admin/magic-links/xyz', headers: cerezli(adminCerez) })).statusCode, 400);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/admin/magic-links/${kayit.id}`, headers: cerezli(patronCerez) })).statusCode, 403);
    // iptal + oturumları düşür
    const sil = await t.app.inject({ method: 'DELETE', url: `/api/admin/magic-links/${kayit.id}?oturumlar=1`, headers: cerezli(adminCerez) });
    assert.equal(sil.statusCode, 200, sil.body);
    assert.equal(sil.json().silinen, 1);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/admin/magic-links/${kayit.id}`, headers: cerezli(adminCerez) })).statusCode, 404);
    const tekrar = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI } });
    assert.equal(tekrar.statusCode, 410, 'iptal edilen link 410 dönmeli');
    const me = await t.app.inject({ url: '/api/me', headers: cerezli(patronCerez) });
    assert.equal(me.statusCode, 401, 'iptal edilen linkle açılan oturum düşmeli');
  });

  test('webview: oturum açmaz, token yakmaz; Safari/Chrome uyarı sayfası + aynı link', async () => {
    const { token } = await linkUret({ label: 'wv', maxDevices: 1 });
    const yanit = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_WEBVIEW, host: 'alas.example.com' } });
    assert.equal(yanit.statusCode, 200);
    assert.match(yanit.headers['content-type'], /text\/html/);
    assert.match(yanit.body, /Safari\/Chrome/);
    assert.ok(yanit.body.includes(`http://alas.example.com/g/${token}`), 'aynı link sayfada olmalı');
    assert.match(yanit.body, /kopyala/i);
    assert.equal(cerezDegeri(yanit), null);
    const kayitlar = JSON.parse(await readFile(path.join(t.dataDir, 'tokens.json'), 'utf8'));
    assert.equal(kayitlar[token].uses.length, 0, 'webview token yakmamalı');
    // token hâlâ kullanılabilir
    const gercek = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI } });
    assert.equal(gercek.statusCode, 302);
  });

  test('link önizleme botu, HEAD ve ön-yükleme token yakmaz', async () => {
    const { token } = await linkUret({ label: 'bot', maxDevices: 1 });
    const botlar = [
      'WhatsApp/2.23.20 A', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Mozilla/5.0 (compatible; Applebot/0.1)', 'TelegramBot (like TwitterBot)', 'Slackbot-LinkExpanding 1.0',
    ];
    for (const ua of botlar) {
      const y = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': ua } });
      assert.equal(y.statusCode, 200, ua);
      assert.equal(cerezDegeri(y), null, ua);
    }
    const head = await t.app.inject({ method: 'HEAD', url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI } });
    assert.equal(head.statusCode, 200);
    const onYukle = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI, 'sec-purpose': 'prefetch' } });
    assert.equal(onYukle.statusCode, 200);
    assert.equal(cerezDegeri(onYukle), null);
    const kayitlar = JSON.parse(await readFile(path.join(t.dataDir, 'tokens.json'), 'utf8'));
    assert.equal(kayitlar[token].uses.length, 0);
    assert.equal((await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI } })).statusCode, 302);
  });

  test('tarayıcıda açılış: patron oturumu (302 /app.html), cihaz sınırı ve 410', async () => {
    const { token } = await linkUret({ label: 'Sınırlı', maxDevices: 2 });
    const bir = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI }, remoteAddress: '198.51.100.7' });
    assert.equal(bir.statusCode, 302);
    assert.equal(bir.headers.location, '/app.html');
    const patronCerez = cerezDegeri(bir);
    assert.ok(patronCerez);
    const ham = [].concat(bir.headers['set-cookie']).find((c) => c.startsWith(`${COOKIE_ADI}=`));
    assert.match(ham, /HttpOnly/i);
    // patron 90 gün
    const maxAge = Number(/Max-Age=(\d+)/i.exec(ham)[1]);
    assert.equal(maxAge, 90 * 86400);

    const me = await t.app.inject({ url: '/api/me', headers: cerezli(patronCerez) });
    assert.deepEqual(me.json(), { username: 'patron:Sınırlı', role: 'patron' });

    // aynı patron oturumuyla linki yeniden açmak token yakmaz
    const tekrar = await t.app.inject({ url: `/g/${token}`, headers: cerezli(patronCerez, { 'user-agent': UA_SAFARI }) });
    assert.equal(tekrar.statusCode, 302);
    assert.equal(cerezDegeri(tekrar), null);

    // ikinci cihaz
    const iki = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI } });
    assert.equal(iki.statusCode, 302);
    // üçüncü cihaz: sınır doldu → 410
    const uc = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI } });
    assert.equal(uc.statusCode, 410);
    assert.match(uc.headers['content-type'], /text\/html/);
    assert.match(uc.body, /şef/i);
    assert.equal(cerezDegeri(uc), null);

    const kayitlar = JSON.parse(await readFile(path.join(t.dataDir, 'tokens.json'), 'utf8'));
    assert.equal(kayitlar[token].uses.length, 2);
    assert.equal(kayitlar[token].uses[0].ip, '198.51.100.7');
    assert.equal(kayitlar[token].uses[0].ua, UA_SAFARI);
    assert.equal(typeof kayitlar[token].uses[0].at, 'number');
  });

  test('admin (herhangi bir oturumlu) cihazda link açmak token yakmaz, oturumu ezmez', async () => {
    const { token } = await linkUret({ label: 'adminDener', maxDevices: 1 });
    const y = await t.app.inject({ url: `/g/${token}`, headers: cerezli(adminCerez, { 'user-agent': UA_SAFARI }) });
    assert.equal(y.statusCode, 302);
    assert.equal(y.headers.location, '/app.html');
    assert.equal(cerezDegeri(y), null, 'mevcut oturum çerezi ezilmemeli');
    const kayitlar = JSON.parse(await readFile(path.join(t.dataDir, 'tokens.json'), 'utf8'));
    assert.equal(kayitlar[token].uses.length, 0, 'oturumlu cihaz token yakmamalı');
    // admin hâlâ admin; token başka (oturumsuz) cihaz için duruyor
    assert.equal((await t.app.inject({ url: '/api/me', headers: cerezli(adminCerez) })).json().role, 'admin');
    assert.equal((await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI } })).statusCode, 302);
  });

  test('geçersiz ve süresi dolmuş token 410', async () => {
    const yok = await t.app.inject({ url: '/g/yok-boyle-bir-token', headers: { 'user-agent': UA_SAFARI } });
    assert.equal(yok.statusCode, 410);
    const { token } = await linkUret({ label: 'kısa', days: 0.000001 }); // ~86 ms
    await new Promise((r) => setTimeout(r, 200));
    const dolmus = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI } });
    assert.equal(dolmus.statusCode, 410);
    assert.match(dolmus.body, /süresi dolmuş/);
    // webview'da bile geçersiz token uyarı değil 410 alır
    const wv = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_WEBVIEW } });
    assert.equal(wv.statusCode, 410);
  });

  test('patron: panoya girer, admin ve örnek verisine giremez; denetimde token yok', async () => {
    const { token } = await linkUret({ label: 'Yetki' });
    const g = await t.app.inject({ url: `/g/${token}`, headers: { 'user-agent': UA_SAFARI } });
    const patronCerez = cerezDegeri(g);
    assert.equal((await t.app.inject({ url: '/api/pano.json', headers: cerezli(patronCerez) })).statusCode, 200);
    assert.equal((await t.app.inject({ url: '/api/pano.json?dataset=ornek', headers: cerezli(patronCerez) })).statusCode, 403);
    assert.equal((await t.app.inject({ url: '/api/admin/users', headers: cerezli(patronCerez) })).statusCode, 403);

    const audit = await t.app.inject({ url: '/api/admin/audit?n=1000', headers: cerezli(adminCerez) });
    const satirlar = audit.json();
    assert.ok(satirlar.some((s) => s.action === 'sihirli-link-giris' && s.role === 'patron'));
    assert.ok(satirlar.some((s) => s.action === 'sihirli-link-olustur'));
    assert.ok(!JSON.stringify(satirlar).includes(token), 'denetim kaydında token olmamalı');
  });
});

describe('dosya sunumu ve yükleme', () => {
  let t;
  let adminCerez;

  before(async () => {
    t = await uygulamaKur();
    adminCerez = (await girisYap(t.app, 'admin', 'deneme123')).cerez;
    await mkdir(path.join(t.dataDir, 'web', '2026-10-07'), { recursive: true });
    await writeFile(path.join(t.dataDir, 'web', '2026-10-07', 'a.jpg'), Buffer.from('0123456789'));
    await mkdir(path.join(t.dataDir, 'rapor', '2026-10-07'), { recursive: true });
    await writeFile(path.join(t.dataDir, 'rapor', '2026-10-07', 'index.html'), '<h1>Rapor</h1>');
    await writeFile(path.join(t.dataDir, 'rapor', '2026-10-07', 'rapor.pdf'), '%PDF-1.4');
  });
  after(() => t.kapat());

  test('/web ve /rapor oturum ister; oturumla sunulur; önbellek başlıkları', async () => {
    assert.equal((await t.app.inject({ url: '/web/2026-10-07/a.jpg' })).statusCode, 401);
    assert.equal((await t.app.inject({ url: '/rapor/2026-10-07/rapor.pdf' })).statusCode, 401);

    const foto = await t.app.inject({ url: '/web/2026-10-07/a.jpg', headers: cerezli(adminCerez) });
    assert.equal(foto.statusCode, 200);
    assert.equal(foto.body, '0123456789');
    assert.equal(foto.headers['cache-control'], 'private, max-age=2592000, immutable');
    assert.equal(foto.headers['content-type'], 'image/jpeg');

    const rapor = await t.app.inject({ url: '/rapor/2026-10-07/', headers: cerezli(adminCerez) });
    assert.equal(rapor.statusCode, 200);
    assert.match(rapor.body, /Rapor/);
    assert.match(rapor.headers['cache-control'], /no-cache/);
    const pdf = await t.app.inject({ url: '/rapor/2026-10-07/rapor.pdf', headers: cerezli(adminCerez) });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
  });

  test('Range isteği 206 döner (video oynatma)', async () => {
    const y = await t.app.inject({ url: '/web/2026-10-07/a.jpg', headers: cerezli(adminCerez, { range: 'bytes=2-5' }) });
    assert.equal(y.statusCode, 206);
    assert.equal(y.body, '2345');
    assert.equal(y.headers['content-range'], 'bytes 2-5/10');
  });

  test('dizin adresi sona / eklenerek yönlendirilir; olmayan dosya 404', async () => {
    const y = await t.app.inject({ url: '/rapor/2026-10-07?x=1', headers: cerezli(adminCerez) });
    assert.equal(y.statusCode, 302);
    assert.equal(y.headers.location, '/rapor/2026-10-07/?x=1');
    assert.equal((await t.app.inject({ url: '/web/2026-10-07/yok.jpg', headers: cerezli(adminCerez) })).statusCode, 404);
    assert.equal((await t.app.inject({ url: '/web/', headers: cerezli(adminCerez) })).statusCode, 404);
  });

  test('path traversal 400 (kodlu biçimler dahil), oturumsuzken 401', async () => {
    const kotuler = [
      '/web/../users.json', '/web/%2e%2e/users.json', '/web/..%2fusers.json', '/web/..%2f..%2fusers.json',
      '/web/2026-10-07/..%2f..%2f..%2fusers.json', '/rapor/%2e%2e%2fusers.json', '/web/..%5cusers.json',
    ];
    for (const url of kotuler) {
      const y = await t.app.inject({ url, headers: cerezli(adminCerez) });
      assert.ok([400, 403, 404].includes(y.statusCode), `${url} → ${y.statusCode}`);
      assert.notEqual(y.statusCode, 200, url);
    }
    // users.json gerçekten var ve içinde hash'ler yer alıyor — sızmadığını doğrula
    const hepsi = await Promise.all(kotuler.map((url) => t.app.inject({ url, headers: cerezli(adminCerez) })));
    for (const y of hepsi) assert.ok(!y.body.includes('"hash"'));
  });

  test('PUT /api/admin/file: ham gövdeyi atomik yazar; izin verilmeyen yollar 400', async () => {
    const icerik = Buffer.from([1, 2, 3, 4, 5, 250, 251]);
    const ok = await t.app.inject({
      method: 'PUT', url: '/api/admin/file?path=web/2026-10-09/yeni.jpg', headers: cerezli(adminCerez, { 'content-type': 'image/jpeg' }), payload: icerik,
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(ok.json(), { ok: true, path: 'web/2026-10-09/yeni.jpg', bytes: 7 });
    assert.deepEqual(await readFile(path.join(t.dataDir, 'web', '2026-10-09', 'yeni.jpg')), icerik);
    // yüklenen dosya hemen sunulur
    const geri = await t.app.inject({ url: '/web/2026-10-09/yeni.jpg', headers: cerezli(adminCerez) });
    assert.deepEqual(geri.rawPayload, icerik);

    // uzantısız / octet-stream
    const bin = await t.app.inject({
      method: 'PUT', url: '/api/admin/file?path=rapor/2026-10-09/rapor.pdf', headers: cerezli(adminCerez, { 'content-type': 'application/octet-stream' }), payload: Buffer.from('%PDF'),
    });
    assert.equal(bin.statusCode, 200);

    const kotuYollar = [
      'users.json', 'sessions.json', 'tokens.json', 'audit.jsonl', '../disari.txt', 'web/../users.json',
      'web', 'web/', '/etc/passwd', 'baska/yer.txt', 'web/\0x', '',
    ];
    for (const yol of kotuYollar) {
      const y = await t.app.inject({
        method: 'PUT', url: `/api/admin/file?path=${encodeURIComponent(yol)}`, headers: cerezli(adminCerez, { 'content-type': 'application/octet-stream' }), payload: Buffer.from('x'),
      });
      assert.equal(y.statusCode, 400, `izin verildi: ${JSON.stringify(yol)} → ${y.statusCode}`);
    }
    await assert.rejects(() => stat(path.join(t.dataDir, '..', 'disari.txt')), { code: 'ENOENT' });
    const yolsuz = await t.app.inject({ method: 'PUT', url: '/api/admin/file', headers: cerezli(adminCerez), payload: Buffer.from('x') });
    assert.equal(yolsuz.statusCode, 400);
  });

  test('PUT /api/admin/file: JSON içerik türü bile ham yazılır; main/ornek altında bozuk JSON reddedilir', async () => {
    const tasks = JSON.stringify([{ id: 1, name: 'İş' }]);
    const ok = await t.app.inject({
      method: 'PUT', url: '/api/admin/file?path=main/tasks.json', headers: cerezli(adminCerez, { 'content-type': 'application/json' }), payload: tasks,
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(await readFile(path.join(t.dataDir, 'main', 'tasks.json'), 'utf8'), tasks);

    const bozuk = await t.app.inject({
      method: 'PUT', url: '/api/admin/file?path=main/tasks.json', headers: cerezli(adminCerez, { 'content-type': 'application/json' }), payload: '{ bozuk',
    });
    assert.equal(bozuk.statusCode, 400);
    assert.equal(await readFile(path.join(t.dataDir, 'main', 'tasks.json'), 'utf8'), tasks, 'eski dosya bozulmamalı');
    assert.deepEqual((await readdir(path.join(t.dataDir, 'main'))).filter((a) => a.endsWith('.tmp')), []);
  });

  test('PUT /api/admin/file: 100 MB sınırı aşılınca 413 ve dosya oluşmaz', async () => {
    const buyuk = await t.app.inject({
      method: 'PUT', url: '/api/admin/file?path=web/2026-10-09/dev.bin',
      headers: cerezli(adminCerez, { 'content-type': 'application/octet-stream' }), payload: Buffer.alloc(100 * 1024 * 1024 + 1),
    });
    assert.equal(buyuk.statusCode, 413);
    assert.equal(buyuk.json().error, 'govde-cok-buyuk');
    await assert.rejects(() => stat(path.join(t.dataDir, 'web', '2026-10-09', 'dev.bin')), { code: 'ENOENT' });
    // sınırın hemen altı (1 MB) kabul edilir
    const tamam = await t.app.inject({
      method: 'PUT', url: '/api/admin/file?path=web/2026-10-09/orta.bin',
      headers: cerezli(adminCerez, { 'content-type': 'application/octet-stream' }), payload: Buffer.alloc(3 * 1024 * 1024, 7),
    });
    assert.equal(tamam.statusCode, 200);
    assert.equal(tamam.json().bytes, 3 * 1024 * 1024);
  });

  test('POST /api/admin/rapor: logs/<tarih>.json yazar, doğrular, crewplan\'a dokunmaz', async () => {
    const url = '/api/admin/rapor/main/2026-10-08';
    const govde = { date: '2026-10-08', saved: '2026-10-08 18:30', weather: 'Güneşli', entries: [{ t: 'Kazı' }], crews: { Demirci: 4 } };
    const ok = await t.app.inject({ method: 'POST', url, headers: cerezli(adminCerez), payload: govde });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(ok.json(), { ok: true, dataset: 'main', date: '2026-10-08' });
    assert.deepEqual(JSON.parse(await readFile(path.join(t.dataDir, 'main', 'logs', '2026-10-08.json'), 'utf8')), govde);
    await assert.rejects(() => stat(path.join(t.dataDir, 'main', 'crewplan.json')), { code: 'ENOENT' });

    // tarih yoksa adres tarihiyle doldurulur
    const dolu = await t.app.inject({ method: 'POST', url: '/api/admin/rapor/ornek/2026-10-09', headers: cerezli(adminCerez), payload: { weather: 'Yağmurlu' } });
    assert.equal(dolu.statusCode, 200);
    assert.equal(JSON.parse(await readFile(path.join(t.dataDir, 'ornek', 'logs', '2026-10-09.json'), 'utf8')).date, '2026-10-09');

    for (const [u, payload, kod] of [
      ['/api/admin/rapor/main/2026-13-01', {}, 400], ['/api/admin/rapor/main/2026-02-30', {}, 400], ['/api/admin/rapor/main/bugun', {}, 400],
      ['/api/admin/rapor/baska/2026-10-08', {}, 404], [url, { date: '2026-10-09' }, 400], [url, [1, 2], 400],
    ]) {
      const y = await t.app.inject({ method: 'POST', url: u, headers: cerezli(adminCerez), payload });
      assert.equal(y.statusCode, kod, `${u} ${JSON.stringify(payload)} → ${y.statusCode}`);
    }
    assert.equal((await t.app.inject({ method: 'POST', url, payload: govde })).statusCode, 401);
  });
});
