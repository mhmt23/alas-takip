// GET /api/pano.json?dataset=main|ornek — oturum gerekir; "ornek" yalnız admin görür.
import { requireAuth } from '../auth.js';
import { getPano, etagEslesiyor, DATASETLER } from '../pano.js';

export default async function panoRoutes(app, { config }) {
  app.get('/api/pano.json', { onRequest: requireAuth }, async (req, reply) => {
    const dataset = req.query?.dataset ?? 'main';
    if (typeof dataset !== 'string' || !DATASETLER.includes(dataset)) {
      return reply.code(404).send({ error: 'dataset-yok' });
    }
    if (dataset === 'ornek' && req.user.role !== 'admin') {
      return reply.code(403).send({ error: 'yetki-yok' });
    }
    const pano = await getPano(dataset, { dataDir: config.DATA_DIR, timeZone: config.TZ, log: req.log });
    reply.header('Cache-Control', 'no-store').header('ETag', pano.etag);
    if (etagEslesiyor(req.headers['if-none-match'], pano.etag)) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(pano.body);
  });
}
