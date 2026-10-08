// /api/admin/* — yalnız admin (V1-SPEC §5): kullanıcılar, sihirli link, oturumlar,
// dosya yükleme (PUT), günlük rapor kaydı, denetim kaydı.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { requireRole, ROLLER, isValidUsername, normalizeUsername } from '../auth.js';
import { safeJoin, writeStreamAtomic, writeJsonAtomic, YolHatasi } from '../store.js';
import { DATASETLER } from '../pano.js';

const YUKLEME_LIMITI = 100 * 1024 * 1024; // 100 MB
const IZINLI_KOKLER = ['web', 'rapor', 'main', 'ornek'];
const TARIH_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD gerçek bir takvim günü mü? */
function takvimGunuMu(s) {
  const m = TARIH_RE.exec(s ?? '');
  if (!m) return false;
  const [y, a, g] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(y, a - 1, g));
  return d.getUTCFullYear() === y && d.getUTCMonth() === a - 1 && d.getUTCDate() === g;
}

function hata400(reply, error, mesaj) {
  return reply.code(400).send({ error, mesaj });
}

export default async function adminRoutes(app, { config, auth, audit, auditTail }) {
  const sadeceAdmin = requireRole('admin');

  // ---- kullanıcılar
  app.post('/api/admin/users', { onRequest: sadeceAdmin }, async (req, reply) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const username = normalizeUsername(b.username);
    if (!isValidUsername(username)) return hata400(reply, 'kullanici-adi-gecersiz', 'Kullanıcı adı 2-32 karakter, yalnız a-z 0-9 . _ - olabilir');
    if (!ROLLER.includes(b.role)) return hata400(reply, 'rol-gecersiz', `Rol şunlardan biri olmalı: ${ROLLER.join(', ')}`);
    if (b.disabled !== undefined && typeof b.disabled !== 'boolean') return hata400(reply, 'disabled-gecersiz', 'disabled true/false olmalı');
    if (b.password !== undefined && typeof b.password !== 'string') return hata400(reply, 'sifre-gecersiz', 'Şifre metin olmalı');
    // upsertUser kural ihlallerinde statusCode 400 hata fırlatır (hata yöneticisi çevirir)
    const sonuc = await auth.upsertUser(
      { username, role: b.role, password: b.password, disabled: b.disabled },
      req.sid,
    );
    // Şifre kayda geçmez; yalnız şifrenin değişip değişmediği
    await audit(req, sonuc.created ? 'kullanici-olustur' : 'kullanici-guncelle', {
      username, role: b.role, disabled: sonuc.disabled, sifreDegisti: b.password !== undefined,
    });
    return { ok: true, ...sonuc };
  });

  app.get('/api/admin/users', { onRequest: sadeceAdmin }, async () => auth.listUsers());

  // ---- sihirli link
  app.post('/api/admin/magic-link', { onRequest: sadeceAdmin }, async (req, reply) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const label = typeof b.label === 'string' ? b.label.trim().slice(0, 80) : '';
    const days = b.days === undefined ? 2 : Number(b.days);
    const maxDevices = b.maxDevices === undefined ? 3 : Number(b.maxDevices);
    if (!Number.isFinite(days) || days <= 0 || days > 365) return hata400(reply, 'gun-gecersiz', 'days 0 ile 365 arasında olmalı');
    if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 20) return hata400(reply, 'cihaz-gecersiz', 'maxDevices 1-20 arası tam sayı olmalı');
    const { token, expiresAt } = await auth.createMagicLink({ label, days, maxDevices });
    // Token loga/denetime yazılmaz
    await audit(req, 'sihirli-link-olustur', { label, days, maxDevices });
    return { url: `${req.protocol}://${req.host}/g/${token}`, token, expiresAt: new Date(expiresAt).toISOString() };
  });

  // ---- oturumlar
  app.get('/api/admin/sessions', { onRequest: sadeceAdmin }, async (req) => auth.listSessions(req.sid));

  app.delete('/api/admin/sessions/:sid', { onRequest: sadeceAdmin }, async (req, reply) => {
    const silindi = auth.destroySession(req.params.sid);
    if (!silindi) return reply.code(404).send({ error: 'oturum-yok' });
    await audit(req, 'oturum-dusur', null);
    return { ok: true };
  });

  // ---- denetim kaydı
  app.get('/api/admin/audit', { onRequest: sadeceAdmin }, async (req) => {
    const n = Number(req.query?.n ?? 50);
    return auditTail(Number.isFinite(n) ? n : 50);
  });

  // ---- günlük rapor kaydı
  app.post('/api/admin/rapor/:dataset/:date', { onRequest: sadeceAdmin, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const { dataset, date } = req.params;
    if (!DATASETLER.includes(dataset)) return reply.code(404).send({ error: 'dataset-yok' });
    if (!takvimGunuMu(date)) return hata400(reply, 'tarih-gecersiz', 'Tarih YYYY-MM-DD olmalı');
    const rapor = req.body;
    if (rapor === null || typeof rapor !== 'object' || Array.isArray(rapor)) {
      return hata400(reply, 'govde-gecersiz', 'Gövde günlük rapor JSON nesnesi olmalı');
    }
    if (rapor.date !== undefined && rapor.date !== date) {
      return hata400(reply, 'tarih-uyusmuyor', 'Gövdedeki date, adres tarihiyle aynı olmalı');
    }
    // crewplan.json'a dokunulmaz; yalnız logs/<date>.json yazılır
    await writeJsonAtomic(path.join(config.DATA_DIR, dataset, 'logs', `${date}.json`), { ...rapor, date });
    await audit(req, 'rapor-kaydet', { dataset, date });
    return { ok: true, dataset, date };
  });

  // ---- dosya yükleme: ham gövde. Bu kapsamda gövde ayrıştırıcıları kaldırılır; her içerik
  // türü (JSON dahil) ham akış olarak gelir, bellekte tutulmaz.
  await app.register(async function dosyaYukleme(kapsam) {
    kapsam.removeAllContentTypeParsers();
    kapsam.addContentTypeParser('*', (_req, akis, done) => done(null, akis));

    kapsam.put('/api/admin/file', { onRequest: sadeceAdmin, bodyLimit: YUKLEME_LIMITI }, async (req, reply) => {
      // Ham akış ayrıştırıcısı bodyLimit'i kendiliğinden uygulamaz: bildirilen boyutu baştan denetle
      // (boyutsuz/chunked gövdelerde sınırı writeStreamAtomic sayaçla uygular).
      const bildirilen = Number(req.headers['content-length']);
      if (Number.isFinite(bildirilen) && bildirilen > YUKLEME_LIMITI) {
        return reply.header('Connection', 'close').code(413).send({ error: 'govde-cok-buyuk', mesaj: 'Dosya en fazla 100 MB olabilir' });
      }
      const istenen = req.query?.path;
      if (typeof istenen !== 'string' || !istenen) return hata400(reply, 'yol-gerekli', 'path sorgu parametresi gerekli');

      let hedef;
      try {
        hedef = safeJoin(config.DATA_DIR, istenen);
      } catch (e) {
        if (e instanceof YolHatasi) return hata400(reply, 'yol-gecersiz', e.message);
        throw e;
      }
      const gorecel = path.relative(config.DATA_DIR, hedef).split(path.sep).join('/');
      const parcalar = gorecel.split('/');
      if (!IZINLI_KOKLER.includes(parcalar[0]) || parcalar.length < 2) {
        return hata400(reply, 'yol-izinli-degil', `Yol yalnız ${IZINLI_KOKLER.map((k) => k + '/').join(', ')} altına yazabilir`);
      }
      if (istenen.endsWith('/') || istenen.endsWith('\\')) return hata400(reply, 'yol-gecersiz', 'Yol bir dosya adıyla bitmeli');
      const mevcut = await fsp.stat(hedef).catch(() => null);
      if (mevcut?.isDirectory()) return hata400(reply, 'yol-gecersiz', 'Hedef bir dizin');

      // main/ ve ornek/ altındaki .json dosyaları geçerli JSON olmalı (pano bozulmasın)
      const jsonDogrula = /^(main|ornek)\//.test(gorecel) && gorecel.endsWith('.json')
        ? async (tmp) => {
            try {
              JSON.parse((await fsp.readFile(tmp, 'utf8')).replace(/^﻿/, ''));
            } catch {
              const e = new Error('Yüklenen dosya geçerli JSON değil');
              e.statusCode = 400;
              e.code = 'json-gecersiz';
              throw e;
            }
          }
        : undefined;

      const bayt = await writeStreamAtomic(hedef, req.body, { maxBytes: YUKLEME_LIMITI, dogrula: jsonDogrula });
      await audit(req, 'dosya-yukle', { path: gorecel, bayt });
      return { ok: true, path: gorecel, bytes: bayt };
    });
  });
}
