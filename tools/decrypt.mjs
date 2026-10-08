// Alas Takip – şifreli paketi (d/*.enc) çözüp düz dosyalara açar.
// Kullanım:  node tools/decrypt.mjs "<şifre>" [repoKlasörü=.] [çıktıKlasörü=_acik]
// Çıktı klasörü (_acik/) .gitignore'da; düz içerik commit'lenmez.
// Şifreleme düzeni index.html + sw.js ile birebir aynı: PBKDF2(210000, SHA-256) → AES-GCM-256,
// dosya adı = SHA-256(KID + ':' + görelAd)'nin ilk 32 hex karakteri.
import { webcrypto as crypto } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const [, , password, repoArg = '.', outArg] = process.argv;
if (!password) {
  console.error('Kullanım: node tools/decrypt.mjs "<şifre>" [repoKlasörü] [çıktıKlasörü]');
  process.exit(1);
}
const repo = path.resolve(repoArg);
const out = path.resolve(outArg || path.join(repo, '_acik'));
const KID = '6a836cf4a615ffd5';
const SALT = Buffer.from('R614gLcuIUGoyU7IUVmniQ==', 'base64');
const ITER = 210000;
const enc = new TextEncoder();

const base = await crypto.subtle.importKey('raw', enc.encode(password.trim()), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt: SALT, iterations: ITER, hash: 'SHA-256' },
  base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);

async function decrypt(buf) {
  const b = new Uint8Array(buf);
  return Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12)));
}
async function hexName(rel) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(KID + ':' + rel));
  return Buffer.from(d).toString('hex').slice(0, 32);
}

// 1) Şifre doğru mu? (giriş sayfasıyla aynı kontrol)
let ok = false;
try { ok = (await decrypt(await readFile(path.join(repo, 'check.enc')))).toString() === 'alas-ok'; } catch {}
if (!ok) { console.error('Şifre yanlış (check.enc çözülemedi).'); process.exit(2); }

// 2) Bilinen sayfalardan başlayıp HTML/JS içindeki referansları izleyerek adları çöz.
const dDir = path.join(repo, 'd');
const available = new Set((await readdir(dDir)).filter(f => f.endsWith('.enc')).map(f => f.slice(0, -4)));
const map = {};            // hex -> görel ad
const seen = new Set();
const queue = ['app.html', 'ornek/index.html'];
const REF_RE = /(?:src|href|poster|data-src|data-full|data-pdf|data-video)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)|["'`]([\w\-\/.%çğıöşüÇĞİÖŞÜ ]+\.(?:jpe?g|png|webp|gif|svg|mp4|webm|pdf|json|js|css|html))["'`]/gi;

function normalize(fromRel, ref) {
  ref = ref.trim();
  if (/^(https?:|data:|blob:|mailto:|tel:|#|javascript:)/i.test(ref)) return null;
  ref = ref.split(/[?#]/)[0];
  try { ref = decodeURIComponent(ref); } catch {}
  let rel;
  if (ref.startsWith('/')) rel = ref.replace(/^\/alas-takip\//, '').replace(/^\/+/, '');
  else {
    const dir = path.posix.dirname(fromRel);
    rel = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, ref));
  }
  if (!rel || rel === '.' || rel.startsWith('../')) return null;
  if (rel.endsWith('/')) rel += 'index.html';
  return rel;
}

while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const hex = await hexName(rel);
  if (!available.has(hex)) continue;
  const plain = await decrypt(await readFile(path.join(dDir, hex + '.enc')));
  map[hex] = rel;
  const dest = path.join(out, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, plain);
  console.log(`✓ ${rel}  (${plain.length} bayt)`);
  if (/\.(html|js|css|json)$/i.test(rel)) {
    for (const m of plain.toString('utf8').matchAll(REF_RE)) {
      const r = normalize(rel, m[1] || m[2] || m[3]);
      if (r && !seen.has(r)) queue.push(r);
    }
  }
}

// 3) Adı bulunamayan dosyalar: yine de çöz, türünü ilk baytlardan tahmin et.
const SNIFF = [
  [b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF, 'jpg'],
  [b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47, 'png'],
  [b => b.slice(0, 4).toString() === '%PDF', 'pdf'],
  [b => b.slice(4, 8).toString() === 'ftyp', 'mp4'],
  [b => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP', 'webp'],
  [b => /^\s*<(!doctype|html|meta|head)/i.test(b.slice(0, 64).toString()), 'html'],
];
let unmapped = 0;
for (const hex of available) {
  if (map[hex]) continue;
  let plain;
  try { plain = await decrypt(await readFile(path.join(dDir, hex + '.enc'))); }
  catch { console.log(`✗ d/${hex}.enc çözülemedi`); continue; }
  const ext = (SNIFF.find(([test]) => test(plain)) || [null, 'bin'])[1];
  const dest = path.join(out, '_eslesmeyen', `${hex}.${ext}`);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, plain);
  unmapped++;
  console.log(`? _eslesmeyen/${hex}.${ext}  (${plain.length} bayt)`);
}
await writeFile(path.join(out, '_harita.json'), JSON.stringify(map, null, 2));
console.log(`\nBitti: ${Object.keys(map).length} dosya adıyla, ${unmapped} dosya adsız (_eslesmeyen/) olarak şuraya açıldı:\n${out}`);
