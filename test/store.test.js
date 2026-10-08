// store.js testleri: atomik JSON yazım/okuma ve yol güvenliği.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readJson, writeJsonAtomic, appendLine, ensureDir, safeJoin, YolHatasi, writeStreamAtomic,
} from '../server/store.js';

async function geciciDizin(t) {
  const dizin = await mkdtemp(path.join(tmpdir(), 'alas-store-'));
  t.after(() => rm(dizin, { recursive: true, force: true }));
  return dizin;
}

test('writeJsonAtomic + readJson gidiş-dönüş (Türkçe karakterler dahil)', async (t) => {
  const dizin = await geciciDizin(t);
  const dosya = path.join(dizin, 'alt', 'veri.json');
  const veri = { ad: 'Şantiye şefi', liste: [1, 2, { ı: 'İğüşöç' }], bos: null, dogru: true };
  await writeJsonAtomic(dosya, veri); // alt dizin otomatik oluşur
  assert.deepEqual(await readJson(dosya, null), veri);
  // üzerine yazma
  await writeJsonAtomic(dosya, { yeni: 1 });
  assert.deepEqual(await readJson(dosya, null), { yeni: 1 });
  // geride .tmp dosyası kalmaz
  const dosyalar = await readdir(path.join(dizin, 'alt'));
  assert.deepEqual(dosyalar, ['veri.json']);
});

test('readJson: dosya yoksa fallback, bozuksa JSON_BOZUK hatası', async (t) => {
  const dizin = await geciciDizin(t);
  assert.deepEqual(await readJson(path.join(dizin, 'yok.json'), []), []);
  assert.equal(await readJson(path.join(dizin, 'yok.json')), undefined);
  const bozuk = path.join(dizin, 'bozuk.json');
  await writeFile(bozuk, '{ bozuk');
  await assert.rejects(() => readJson(bozuk, null), (e) => e.code === 'JSON_BOZUK' && e.file === bozuk);
  // BOM'lu dosya okunabilir
  const bomlu = path.join(dizin, 'bom.json');
  await writeFile(bomlu, '\uFEFF{"a":1}');
  assert.deepEqual(await readJson(bomlu, null), { a: 1 });
});

test('writeJsonAtomic eşzamanlı yazımlarda geçerli JSON bırakır', async (t) => {
  const dizin = await geciciDizin(t);
  const dosya = path.join(dizin, 'es.json');
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(dosya, { i })));
  const sonuc = await readJson(dosya, null);
  assert.equal(typeof sonuc.i, 'number');
  assert.deepEqual(await readdir(dizin), ['es.json']);
});

test('appendLine satır ekler, ensureDir tekrar çağrılabilir', async (t) => {
  const dizin = await geciciDizin(t);
  const dosya = path.join(dizin, 'a', 'b', 'log.jsonl');
  await appendLine(dosya, '{"n":1}');
  await appendLine(dosya, '{"n":2}\n');
  assert.equal(await readFile(dosya, 'utf8'), '{"n":1}\n{"n":2}\n');
  await ensureDir(path.join(dizin, 'x', 'y'));
  await ensureDir(path.join(dizin, 'x', 'y'));
});

test('safeJoin: kök altındaki yollara izin verir', () => {
  const kok = path.resolve('/veri/kok');
  assert.equal(safeJoin(kok, 'web/2026-10-07/a.jpg'), path.join(kok, 'web', '2026-10-07', 'a.jpg'));
  assert.equal(safeJoin(kok, 'a.json'), path.join(kok, 'a.json'));
  assert.equal(safeJoin(kok, '..dosya.txt'), path.join(kok, '..dosya.txt')); // ".." ile başlayan ad geçerlidir
});

test('safeJoin: traversal, mutlak yol ve null bayt reddedilir (400)', () => {
  const kok = path.resolve('/veri/kok');
  const kotuler = [
    '../etc/passwd', '..', 'a/../../b', 'a/../b', '..\\x', 'a\\..\\..\\b',
    '/etc/passwd', '\\windows\\system32', 'C:\\Windows\\win.ini', 'a\0b',
  ];
  for (const kotu of kotuler) {
    assert.throws(() => safeJoin(kok, kotu), (e) => e instanceof YolHatasi && e.statusCode === 400, `reddedilmedi: ${JSON.stringify(kotu)}`);
  }
  assert.throws(() => safeJoin(kok, 42), YolHatasi);
  assert.throws(() => safeJoin(kok, undefined), YolHatasi);
});

test('writeStreamAtomic: akışı yazar, boyut sınırında iptal eder ve tmp bırakmaz', async (t) => {
  const dizin = await geciciDizin(t);
  const hedef = path.join(dizin, 'yuk', 'dosya.bin');
  const bayt = await writeStreamAtomic(hedef, Readable.from([Buffer.from('abc'), Buffer.from('defg')]), { maxBytes: 100 });
  assert.equal(bayt, 7);
  assert.equal(await readFile(hedef, 'utf8'), 'abcdefg');

  await assert.rejects(
    () => writeStreamAtomic(hedef, Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), { maxBytes: 100 }),
    (e) => e.code === 'BOYUT_ASILDI' && e.statusCode === 413,
  );
  // başarısız yazım eski dosyayı bozmaz, tmp kalmaz
  assert.equal(await readFile(hedef, 'utf8'), 'abcdefg');
  assert.deepEqual(await readdir(path.dirname(hedef)), ['dosya.bin']);

  // doğrulama hatası dosyayı değiştirmez
  await assert.rejects(
    () => writeStreamAtomic(hedef, Readable.from([Buffer.from('x')]), { dogrula: async () => { throw new Error('olmaz'); } }),
    /olmaz/,
  );
  assert.equal(await readFile(hedef, 'utf8'), 'abcdefg');
});
