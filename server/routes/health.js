// GET /health — herkese açık, sağlık kontrolü (Railway healthcheck).
// Veri dizinine yazılabiliyor mu, son fotoğraf/rapor günü, çalışma süresi, sürüm.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { getPano } from '../pano.js';

export default async function healthRoutes(app, { config, version }) {
  async function yazilabilirMi() {
    const test = path.join(config.DATA_DIR, '.write-test');
    try {
      await fsp.writeFile(test, String(Date.now()));
      await fsp.rm(test, { force: true });
      return true;
    } catch (err) {
      app.log.error({ err }, 'veri dizinine yazılamadı');
      return false;
    }
  }

  app.get('/health', async (req, reply) => {
    const dataWritable = await yazilabilirMi();
    let lastPhotoDay = null;
    let lastLogDay = null;
    try {
      const { data } = await getPano('main', { dataDir: config.DATA_DIR, timeZone: config.TZ, log: req.log });
      for (const g of data.days) {
        if (g && typeof g.date === 'string' && Number(g.total) > 0 && (!lastPhotoDay || g.date > lastPhotoDay)) {
          lastPhotoDay = g.date;
        }
      }
      for (const l of data.logs) {
        if (typeof l.date === 'string' && (!lastLogDay || l.date > lastLogDay)) lastLogDay = l.date;
      }
    } catch (err) {
      req.log.error({ err }, 'sağlık kontrolünde pano verisi okunamadı');
    }
    reply.header('Cache-Control', 'no-store');
    // Yazılamasa da 200 döner; ok:false durumu bildirir
    return {
      ok: dataWritable,
      dataWritable,
      lastPhotoDay,
      lastLogDay,
      uptimeSec: Math.round(process.uptime()),
      version,
    };
  });
}
