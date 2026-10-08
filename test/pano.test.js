// pano.js testleri: buildPano/getPano (11 anahtar, tarih biçimi, log sırası, ETag) ve
// /api/pano.json rotası (oturum, dataset yetkisi, 304).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync as varMi } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPano, getPano, etagOf, etagEslesiyor, onbellegiTemizle, zamanDizgisi, gunDizgisi, PANO_ANAHTARLARI,
} from '../server/pano.js';
import { loadConfig } from '../server/config.js';
import { buildApp } from '../server/index.js';
import { COOKIE_ADI } from '../server/auth.js';

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const yaz = (dosya, veri) => mkdir(path.dirname(dosya), { recursive: true }).then(() => writeFile(dosya, typeof veri === 'string' ? veri : JSON.stringify(veri)));

/** Küçük ama gerçekçi bir dataset yazar. Günlük raporlar bilerek ters sırada yazılır. */
async function ornekVeriYaz(dataDir, dataset = 'main') {
  const d = path.join(dataDir, dataset);
  await yaz(path.join(d, 'project.json'), { title: 'TEST PROJE', place: 'Urla', statusDate: '2026-10-06', baseline: false });
  await yaz(path.join(d, 'tasks.json'), [
    { id: 1, uid: 11, name: 'Kazı', level: 1, summary: false, milestone: false, start: '2026-10-01', finish: '2026-10-06', pct: 100 },
    { id: 2, uid: 12, name: 'Temel', level: 1, summary: false, milestone: false, start: '2026-10-07', finish: '2026-10-20', pct: 0 },
  ]);
  await yaz(path.join(d, 'days.json'), [
    { date: '2026-10-06', total: 2, videos: 1, sessions: [{ id: 'S1', start: '16:56', end: '17:20', n: 2, photos: [] }] },
    { date: '2026-10-07', total: 0, videos: 3, sessions: [] },
  ]);
  await yaz(path.join(d, 'video.json'), { src: 'web/video/a.mp4', date: '2026-10-07', time: '14:24', file: 'a.MP4' });
  await yaz(path.join(d, 'crewplan.json'), { '2026-10-08': { Demirci: 4 } });
  await yaz(path.join(d, 'reports.json'), [{ date: '2026-10-07', url: 'rapor/2026-10-07/', pdf: 'rapor/2026-10-07/rapor.pdf', people: 12, planned: 10 }]);
  await yaz(path.join(d, 'trades.json'), [{ ad: 'Demirci', kol: 'Betonarme', ekip: 7 }]);
  await yaz(path.join(d, 'banner.json'), { text: 'Test duyurusu' });
  await yaz(path.join(d, 'meta.json'), { photosGenerated: '2026-10-07 15:49', importedAt: '2026-10-08', source: 'test' });
  await yaz(path.join(d, 'logs', '2026-10-07.json'), { date: '2026-10-07', saved: '2026-10-07 18:30', weather: 'Güneşli', entries: [], extra: [], crews: {}, machines: [], notes: '' });
  await yaz(path.join(d, 'logs', '2026-10-06.json'), { date: '2026-10-06', saved: '2026-10-06 18:00', weather: 'Bulutlu', entries: [], extra: [], crews: {}, machines: [], notes: '' });
}

async function geciciDizin(t) {
  const dizin = await mkdtemp(path.join(tmpdir(), 'alas-pano-'));
  t.after(() => rm(dizin, { recursive: true, force: true }));
  return dizin;
}

const SABIT_ZAMAN = new Date('2026-10-08T10:44:00Z'); // Istanbul = UTC+3 → 13:44

describe('buildPano', () => {
  test('11 anahtar, app.html\'in beklediği sırayla; tarih biçimi ve içerik', async (t) => {
    const dataDir = await geciciDizin(t);
    await ornekVeriYaz(dataDir);
    const pano = await buildPano('main', { dataDir, now: SABIT_ZAMAN });

    assert.deepEqual(Object.keys(pano), PANO_ANAHTARLARI);
    assert.deepEqual(Object.keys(pano), ['project', 'generated', 'photosGenerated', 'banner', 'tasks', 'days', 'logs', 'video', 'reports', 'trades', 'crewPlan']);
    assert.equal(pano.generated, '2026-10-08 13:44');
    assert.match(pano.generated, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(pano.project.title, 'TEST PROJE');
    assert.equal(pano.photosGenerated, '2026-10-07 15:49');
    assert.equal(pano.banner, 'Test duyurusu');
    assert.equal(pano.tasks.length, 2);
    assert.equal(pano.days.length, 2);
    assert.equal(pano.video.file, 'a.MP4');
    assert.equal(pano.reports[0].pdf, 'rapor/2026-10-07/rapor.pdf');
    assert.equal(pano.trades[0].ad, 'Demirci');
    assert.deepEqual(pano.crewPlan, { '2026-10-08': { Demirci: 4 } });
  });

  test('günlük raporlar tarih sırasında gelir (dosya yazım sırasından bağımsız)', async (t) => {
    const dataDir = await geciciDizin(t);
    await ornekVeriYaz(dataDir);
    await yaz(path.join(dataDir, 'main', 'logs', '2026-10-05.json'), { date: '2026-10-05', weather: 'Yağmurlu' });
    await yaz(path.join(dataDir, 'main', 'logs', 'notlar.json'), { date: 'x' }); // log dosyası adı değil → yok sayılır
    const pano = await buildPano('main', { dataDir, now: SABIT_ZAMAN });
    assert.deepEqual(pano.logs.map((l) => l.date), ['2026-10-05', '2026-10-06', '2026-10-07']);
  });

  test('Europe/Istanbul: UTC gece yarısına yakın saat doğru güne düşer', () => {
    assert.equal(zamanDizgisi(new Date('2026-10-08T21:30:00Z')), '2026-10-09 00:30');
    assert.equal(zamanDizgisi(new Date('2026-10-08T20:59:00Z')), '2026-10-08 23:59');
    assert.equal(gunDizgisi(new Date('2026-12-31T22:00:00Z')), '2027-01-01');
    assert.equal(zamanDizgisi(new Date('2026-10-08T00:05:00Z'), 'UTC'), '2026-10-08 00:05');
    assert.equal(zamanDizgisi(new Date('2026-10-08T21:30:00Z'), 'UTC'), '2026-10-08 21:30');
  });

  test('veri yoksa 11 anahtarlı ama boş döner (hiçbir şey uydurulmaz)', async (t) => {
    const dataDir = await geciciDizin(t); // dataset dizini bile yok
    const pano = await buildPano('main', { dataDir, now: SABIT_ZAMAN });
    assert.deepEqual(Object.keys(pano), PANO_ANAHTARLARI);
    assert.deepEqual(pano.project, {});
    assert.equal(pano.photosGenerated, '');
    assert.equal(pano.banner, '');
    for (const k of ['tasks', 'days', 'logs', 'reports', 'trades']) assert.deepEqual(pano[k], [], k);
    assert.equal(pano.video, null);
    assert.deepEqual(pano.crewPlan, {});
  });

  test('yanlış türde dosya içeriği boş varsayılana düşer', async (t) => {
    const dataDir = await geciciDizin(t);
    await yaz(path.join(dataDir, 'main', 'tasks.json'), { degil: 'dizi' });
    await yaz(path.join(dataDir, 'main', 'banner.json'), []);
    await yaz(path.join(dataDir, 'main', 'video.json'), 'null');
    const pano = await buildPano('main', { dataDir, now: SABIT_ZAMAN });
    assert.deepEqual(pano.tasks, []);
    assert.equal(pano.banner, '');
    assert.equal(pano.video, null);
  });

  test('yalnız main ve ornek; başkası DATASET_YOK (404)', async (t) => {
    const dataDir = await geciciDizin(t);
    await ornekVeriYaz(dataDir, 'ornek');
    assert.equal((await buildPano('ornek', { dataDir, now: SABIT_ZAMAN })).project.title, 'TEST PROJE');
    for (const kotu of ['baska', '../main', '', undefined, 'MAIN']) {
      await assert.rejects(() => buildPano(kotu, { dataDir }), (e) => e.code === 'DATASET_YOK' && e.statusCode === 404, String(kotu));
    }
  });

  test('bozuk bir günlük rapor atlanır (uyarı loglanır), pano düşmez; bozuk ana dosya hata verir', async (t) => {
    const dataDir = await geciciDizin(t);
    await ornekVeriYaz(dataDir);
    await yaz(path.join(dataDir, 'main', 'logs', '2026-10-08.json'), '{ bozuk');
    const uyarilar = [];
    const pano = await buildPano('main', { dataDir, now: SABIT_ZAMAN, log: { warn: (...a) => uyarilar.push(a) } });
    assert.deepEqual(pano.logs.map((l) => l.date), ['2026-10-06', '2026-10-07']);
    assert.equal(uyarilar.length, 1);

    await yaz(path.join(dataDir, 'main', 'tasks.json'), '{ bozuk');
    await assert.rejects(() => buildPano('main', { dataDir }), (e) => e.code === 'JSON_BOZUK');
  });

  test('JSON gövdesi tam olarak pano nesnesidir (serileştirme gidiş-dönüş)', async (t) => {
    const dataDir = await geciciDizin(t);
    await ornekVeriYaz(dataDir);
    onbellegiTemizle();
    const { data, body } = await getPano('main', { dataDir, now: SABIT_ZAMAN });
    assert.deepEqual(JSON.parse(body), data);
    assert.deepEqual(Object.keys(JSON.parse(body)), PANO_ANAHTARLARI);
  });
});

describe('getPano: ETag ve önbellek', () => {
  test('ETag deterministik (içerik SHA-1) ve veri/dakika değişince değişir', async (t) => {
    const dataDir = await geciciDizin(t);
    await ornekVeriYaz(dataDir);
    onbellegiTemizle();
    const a = await getPano('main', { dataDir, now: SABIT_ZAMAN });
    const b = await getPano('main', { dataDir, now: SABIT_ZAMAN });
    assert.equal(a.etag, b.etag);
    assert.match(a.etag, /^"[0-9a-f]{40}"$/);
    assert.equal(a.etag, etagOf(a.body));
    assert.equal(a.body, b.body);

    // önbellek temizlense bile aynı içerik → aynı ETag
    onbellegiTemizle();
    assert.equal((await getPano('main', { dataDir, now: SABIT_ZAMAN })).etag, a.etag);

    // aynı dakika içinde (saniye farkı) ETag aynı kalır; dakika değişince generated → ETag değişir
    assert.equal((await getPano('main', { dataDir, now: new Date(SABIT_ZAMAN.getTime() + 15_000) })).etag, a.etag);
    const sonraki = await getPano('main', { dataDir, now: new Date(SABIT_ZAMAN.getTime() + 60_000) });
    assert.notEqual(sonraki.etag, a.etag);
    assert.equal(sonraki.data.generated, '2026-10-08 13:45');
  });

  test('dosya değişince önbellek geçersizlenir (mtime/boyut), yeni dosya eklenince de', async (t) => {
    const dataDir = await geciciDizin(t);
    await ornekVeriYaz(dataDir);
    onbellegiTemizle();
    const once = await getPano('main', { dataDir, now: SABIT_ZAMAN });
    assert.equal(once.data.banner, 'Test duyurusu');

    await yaz(path.join(dataDir, 'main', 'banner.json'), { text: 'Yeni duyuru, daha uzun bir metin' });
    const sonra = await getPano('main', { dataDir, now: SABIT_ZAMAN });
    assert.equal(sonra.data.banner, 'Yeni duyuru, daha uzun bir metin');
    assert.notEqual(sonra.etag, once.etag);

    await yaz(path.join(dataDir, 'main', 'logs', '2026-10-08.json'), { date: '2026-10-08', weather: 'Rüzgarlı' });
    assert.deepEqual((await getPano('main', { dataDir, now: SABIT_ZAMAN })).data.logs.map((l) => l.date), ['2026-10-06', '2026-10-07', '2026-10-08']);
  });

  test('main ve ornek önbellekleri birbirine karışmaz', async (t) => {
    const dataDir = await geciciDizin(t);
    await ornekVeriYaz(dataDir, 'main');
    await ornekVeriYaz(dataDir, 'ornek');
    await yaz(path.join(dataDir, 'ornek', 'banner.json'), { text: 'ÖRNEK' });
    onbellegiTemizle();
    assert.equal((await getPano('main', { dataDir, now: SABIT_ZAMAN })).data.banner, 'Test duyurusu');
    assert.equal((await getPano('ornek', { dataDir, now: SABIT_ZAMAN })).data.banner, 'ÖRNEK');
  });

  test('etagEslesiyor: tekil, liste, zayıf ve * biçimleri', () => {
    const e = '"abc"';
    assert.equal(etagEslesiyor('"abc"', e), true);
    assert.equal(etagEslesiyor('W/"abc"', e), true);
    assert.equal(etagEslesiyor('"x", "abc"', e), true);
    assert.equal(etagEslesiyor('*', e), true);
    assert.equal(etagEslesiyor('"x"', e), false);
    assert.equal(etagEslesiyor(undefined, e), false);
    assert.equal(etagEslesiyor('', e), false);
  });
});

// Gerçek veri (migrate-from-static çalıştırıldıysa) varsa 126 iş beklenir
const gercekVeri = path.join(KOK, 'data', 'main', 'tasks.json');
test('gerçek data/ varsa: 126 iş', { skip: !varMi(gercekVeri) && 'data/main/tasks.json yok (migrate çalıştırılmamış)' }, async () => {
  const pano = await buildPano('main', { dataDir: path.join(KOK, 'data') });
  assert.equal(pano.tasks.length, 126);
  assert.deepEqual(Object.keys(pano), PANO_ANAHTARLARI);
});

// ------------------------------------------------------------------ rota

describe('GET /api/pano.json', () => {
  let kok, dataDir, app;
  let adminCerez;
  let ipN = 100;

  async function giris(username, password) {
    const y = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password }, remoteAddress: `10.9.0.${++ipN}` });
    const c = y.cookies.find((x) => x.name === COOKIE_ADI);
    return c ? `${COOKIE_ADI}=${c.value}` : null;
  }

  before(async () => {
    kok = await mkdtemp(path.join(tmpdir(), 'alas-panoroute-'));
    dataDir = path.join(kok, 'data');
    const publicDir = path.join(kok, 'public');
    await mkdir(publicDir, { recursive: true });
    await ornekVeriYaz(dataDir, 'main');
    await ornekVeriYaz(dataDir, 'ornek');
    await yaz(path.join(dataDir, 'ornek', 'banner.json'), { text: 'ÖRNEK' });
    onbellegiTemizle();
    const config = loadConfig({
      DATA_DIR: dataDir, PUBLIC_DIR: publicDir, SESSION_SECRET: 'test-gizli-anahtar-0123456789',
      ADMIN_USER: 'admin', ADMIN_PASSWORD: 'deneme123', LOG_LEVEL: 'silent',
    });
    app = await buildApp(config, { logger: false });
    await app.ready();
    adminCerez = await giris('admin', 'deneme123');
  });
  after(async () => {
    await app.close();
    await rm(kok, { recursive: true, force: true });
  });

  const get = (url, cerez, headers = {}) => app.inject({ url, headers: { ...headers, ...(cerez ? { cookie: cerez } : {}) } });

  test('oturumsuz 401', async () => {
    const y = await get('/api/pano.json');
    assert.equal(y.statusCode, 401);
    assert.deepEqual(y.json(), { error: 'giris-gerekli' });
  });

  test('oturumla 200: JSON, no-store, ETag, 11 anahtar, generated bugün', async () => {
    const y = await get('/api/pano.json', adminCerez);
    assert.equal(y.statusCode, 200);
    assert.match(y.headers['content-type'], /^application\/json/);
    assert.equal(y.headers['cache-control'], 'no-store');
    assert.match(y.headers.etag, /^"[0-9a-f]{40}"$/);
    const pano = y.json();
    assert.deepEqual(Object.keys(pano), PANO_ANAHTARLARI);
    assert.equal(pano.banner, 'Test duyurusu');
    assert.equal(pano.generated.slice(0, 10), gunDizgisi(new Date()));
    assert.deepEqual(pano.logs.map((l) => l.date), ['2026-10-06', '2026-10-07']);
  });

  test('If-None-Match eşleşirse 304 (gövdesiz)', async () => {
    const ilk = await get('/api/pano.json', adminCerez);
    const etag = ilk.headers.etag;
    const y = await get('/api/pano.json', adminCerez, { 'if-none-match': etag });
    // dakika değiştiyse (nadir) ETag farklı olabilir; bu durumda yeniden dene
    if (y.statusCode === 200) {
      const yeni = await get('/api/pano.json', adminCerez);
      const tekrar = await get('/api/pano.json', adminCerez, { 'if-none-match': yeni.headers.etag });
      assert.equal(tekrar.statusCode, 304);
      return;
    }
    assert.equal(y.statusCode, 304);
    assert.equal(y.body, '');
    assert.equal(y.headers.etag, etag);
    assert.equal(y.headers['cache-control'], 'no-store');
    const eski = await get('/api/pano.json', adminCerez, { 'if-none-match': '"eski"' });
    assert.equal(eski.statusCode, 200);
  });

  test('dataset: ornek yalnız admin; bilinmeyen 404; şef ornek göremez', async () => {
    const ornek = await get('/api/pano.json?dataset=ornek', adminCerez);
    assert.equal(ornek.statusCode, 200);
    assert.equal(ornek.json().banner, 'ÖRNEK');
    assert.equal((await get('/api/pano.json?dataset=main', adminCerez)).json().banner, 'Test duyurusu');
    assert.equal((await get('/api/pano.json?dataset=baska', adminCerez)).statusCode, 404);
    assert.equal((await get('/api/pano.json?dataset=..%2Fmain', adminCerez)).statusCode, 404);
    assert.equal((await get('/api/pano.json?dataset=main&dataset=ornek', adminCerez)).statusCode, 404);

    const olustur = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: { cookie: adminCerez },
      payload: { username: 'sef', password: 'sef-sifresi-1', role: 'sef' },
    });
    assert.equal(olustur.statusCode, 200);
    const sefCerez = await giris('sef', 'sef-sifresi-1');
    assert.equal((await get('/api/pano.json', sefCerez)).statusCode, 200);
    const yasak = await get('/api/pano.json?dataset=ornek', sefCerez);
    assert.equal(yasak.statusCode, 403);
    assert.deepEqual(yasak.json(), { error: 'yetki-yok' });
    assert.equal((await get('/api/pano.json?dataset=baska', sefCerez)).statusCode, 404);
  });

  test('admin günlük raporu kaydedince pano yeni raporu içerir (önbellek geçersizlenir)', async () => {
    const once = await get('/api/pano.json', adminCerez);
    const kaydet = await app.inject({
      method: 'POST', url: '/api/admin/rapor/main/2026-10-08', headers: { cookie: adminCerez },
      payload: { saved: '2026-10-08 18:30', weather: 'Güneşli', entries: [], extra: [], crews: {}, machines: [], notes: '' },
    });
    assert.equal(kaydet.statusCode, 200, kaydet.body);
    const sonra = await get('/api/pano.json', adminCerez);
    assert.deepEqual(sonra.json().logs.map((l) => l.date), ['2026-10-06', '2026-10-07', '2026-10-08']);
    assert.notEqual(sonra.headers.etag, once.headers.etag);
    assert.deepEqual(sonra.json().crewPlan, once.json().crewPlan, 'rapor crewplan.json\'a dokunmamalı');
  });

  test('/health son foto ve rapor gününü bildirir', async () => {
    const y = await get('/health');
    const g = y.json();
    assert.equal(g.ok, true);
    assert.equal(g.lastPhotoDay, '2026-10-06'); // 2026-10-07 gününde foto yok (total 0), yalnız video
    assert.equal(g.lastLogDay, '2026-10-08');
  });
});
