// Denetim kaydı (V1-SPEC §3): DATA_DIR/audit.jsonl, satır başına bir JSON.
// Kayıt biçimi: {ts, user, role, action, detail, ip}. Şifre/token/çerez ASLA yazılmaz.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { appendLine } from './store.js';

const SON_OKUMA_BAYT = 1024 * 1024; // sondan en fazla 1 MB okunur

/**
 * @param {{dataDir: string, log?: import('fastify').FastifyBaseLogger}} secenek
 */
export function createAudit({ dataDir, log }) {
  const dosya = path.join(dataDir, 'audit.jsonl');

  /**
   * audit(req, action, detail, aktor?)
   * `aktor` verilmezse kullanıcı req.user'dan alınır (girişte henüz oturum yoktur,
   * bu yüzden çağıran aktörü açıkça geçer). Yazım hatası isteği düşürmez.
   */
  async function audit(req, action, detail = null, aktor = undefined) {
    const kisi = aktor ?? req?.user ?? null;
    const satir = {
      ts: new Date().toISOString(),
      user: kisi?.username ?? null,
      role: kisi?.role ?? null,
      action,
      detail,
      ip: req?.ip ?? null,
    };
    try {
      await appendLine(dosya, JSON.stringify(satir));
    } catch (err) {
      log?.error({ err }, 'denetim kaydı yazılamadı');
    }
  }

  /** Son n kaydı (dosya sırasıyla, eskiden yeniye) döner. */
  async function tail(n = 50) {
    const adet = Math.max(1, Math.min(1000, Math.trunc(Number(n)) || 50));
    let fh;
    try {
      fh = await fsp.open(dosya, 'r');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    try {
      const { size } = await fh.stat();
      const okunacak = Math.min(size, SON_OKUMA_BAYT);
      const tampon = Buffer.alloc(okunacak);
      await fh.read(tampon, 0, okunacak, size - okunacak);
      let satirlar = tampon.toString('utf8').split('\n');
      // Parça ortadan başlıyorsa ilk (yarım) satırı at
      if (size > okunacak) satirlar = satirlar.slice(1);
      const sonuc = [];
      for (const s of satirlar.slice(-adet - 1)) {
        if (!s.trim()) continue;
        try {
          sonuc.push(JSON.parse(s));
        } catch {
          /* bozuk satırı atla */
        }
      }
      return sonuc.slice(-adet);
    } finally {
      await fh.close();
    }
  }

  return { audit, tail, dosya };
}
