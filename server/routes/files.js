// GET /web/* ve /rapor/* — oturum gerekir; dosyalar DATA_DIR altından sunulur (V1-SPEC §5).
// Aralık (Range) istekleri desteklenir (video oynatma). Yol kaçışı (traversal) → 400.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { requireAuth } from '../auth.js';
import { safeJoin } from '../store.js';

// "private": kimlik doğrulamalı içerik paylaşılan (CDN/proxy) önbelleklerde saklanmasın
const CACHE = {
  web: 'private, max-age=2592000, immutable', // 30 gün
  rapor: 'private, no-cache',
};

export default async function fileRoutes(app, { config }) {
  for (const ad of ['web', 'rapor']) {
    const kok = path.join(config.DATA_DIR, ad);

    app.get(`/${ad}/*`, { onRequest: requireAuth }, async (req, reply) => {
      const rel = req.params['*'];
      if (!rel) return reply.callNotFound();

      let hedef;
      try {
        hedef = safeJoin(kok, rel);
      } catch {
        return reply.code(400).send({ error: 'yol-gecersiz' });
      }

      let st;
      try {
        st = await fsp.stat(hedef);
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return reply.callNotFound();
        throw e;
      }

      let gorecel = path.relative(kok, hedef).split(path.sep).join('/');
      if (st.isDirectory()) {
        // /rapor/2026-10-07 → /rapor/2026-10-07/ (göreli bağlantılar çalışsın), sonra index.html
        const [yol, ...sorgu] = req.raw.url.split('?');
        if (!yol.endsWith('/')) {
          return reply.redirect(yol + '/' + (sorgu.length ? '?' + sorgu.join('?') : ''), 302);
        }
        gorecel += '/index.html';
      }

      reply.header('Cache-Control', CACHE[ad]);
      return reply.sendFile(gorecel, kok, { cacheControl: false });
    });
  }
}
