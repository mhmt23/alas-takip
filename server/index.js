// Alas Takip V1 sunucusu: Fastify kurulumu, eklentiler, rotalar, dinleme (V1-SPEC §1).
// `node server/index.js` ile çalışır; testler `buildApp(config, {logger:false})` ile uygulamayı
// dinlemeden (inject) kurar.
import Fastify, { LogController } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, YapilandirmaHatasi } from './config.js';
import { ensureDir } from './store.js';
import { createAudit } from './audit.js';
import { createAuth, safeNext } from './auth.js';
import { datasetDizinleriniHazirla } from './pano.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import panoRoutes from './routes/pano.js';
import fileRoutes from './routes/files.js';
import adminRoutes from './routes/admin.js';

const KALICI_UZANTI_RE = /\.(woff2?|ttf|otf|png|jpe?g|gif|webp|ico|svg)$/i;

/** Loglarda sihirli link token'ını gizle: /g/<token> → /g/*** */
export function urlMaskele(url) {
  return typeof url === 'string' ? url.replace(/^(\/g\/)[^/?#]+/, '$1***') : url;
}

function surumOku() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Uygulamayı kurar (dinlemez).
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{logger?: object|boolean}} [secenek]
 */
export async function buildApp(config, { logger } = {}) {
  const version = surumOku();
  const app = Fastify({
    logger: logger ?? {
      level: config.LOG_LEVEL,
      serializers: {
        // Token içeren adresler loga ham yazılmaz
        req(req) {
          return { method: req.method, url: urlMaskele(req.url), host: req.host, remoteAddress: req.ip };
        },
      },
    },
    logController: new LogController({ disableRequestLogging: true }), // Türkçe kendi istek günlüğümüz var (aşağıda)
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  // ---- veri dizinleri
  await ensureDir(config.DATA_DIR);
  await ensureDir(path.join(config.DATA_DIR, 'web'));
  await ensureDir(path.join(config.DATA_DIR, 'rapor'));
  await datasetDizinleriniHazirla(config.DATA_DIR);

  // ---- eklentiler
  await app.register(fastifyCookie); // imzayı kendimiz yapıyoruz (HMAC); eklenti yalnız ayrıştırır
  await app.register(fastifyFormbody);
  await app.register(fastifyRateLimit, {
    global: false, // yalnız route config'inde rateLimit olan rotalar (/api/login)
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'cok-fazla-deneme',
      message: `Çok fazla deneme. Yaklaşık ${Math.max(1, Math.ceil((ctx.ttl ?? 0) / 60000))} dakika sonra tekrar deneyin.`,
    }),
  });

  const publicKok = path.resolve(config.PUBLIC_DIR);
  await app.register(fastifyStatic, {
    root: publicKok,
    prefix: '/',
    index: false, // "/" için özel rota var (oturumluysa yönlendirir)
    cacheControl: false, // başlığı aşağıda biz yazarız
    setHeaders(reply, dosya) {
      // Yalnız public/ dosyaları; DATA_DIR dosyalarının başlığını rotalar kendisi koyar
      const gor = path.relative(publicKok, dosya);
      if (gor.startsWith('..') || path.isAbsolute(gor)) return;
      // Fontlar (fonts.css dâhil) ve ikonlar 30 gün immutable; html/sw/manifest no-cache (§5)
      const kalici = gor.startsWith('fonts' + path.sep) || KALICI_UZANTI_RE.test(dosya);
      reply.header('Cache-Control', kalici ? 'public, max-age=2592000, immutable' : 'no-cache');
    },
  });

  // ---- kimlik katmanı
  const { audit, tail: auditTail } = createAudit({ dataDir: config.DATA_DIR, log: app.log });
  const auth = createAuth({ config, log: app.log, audit });
  await auth.init();
  app.addHook('onClose', async () => {
    await auth.close();
  });

  app.decorateRequest('user', null);
  app.decorateRequest('sid', null);

  // ---- hook'lar
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    if (config.isProd) reply.header('Strict-Transport-Security', 'max-age=15552000');
    req.user = auth.resolve(req, reply);
  });

  app.addHook('onResponse', async (req, reply) => {
    const seviye = req.url === '/health' ? 'debug' : 'info';
    req.log[seviye](
      { method: req.method, url: urlMaskele(req.url), durum: reply.statusCode, ms: Math.round(reply.elapsedTime), kullanici: req.user?.username ?? null },
      'istek tamamlandı',
    );
  });

  // ---- hata ve 404 yöneticileri
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'bulunamadi' });
  });

  app.setErrorHandler((err, req, reply) => {
    const durum = Number.isInteger(err?.statusCode) && err.statusCode >= 400 ? err.statusCode : 500;
    if (durum >= 500) {
      req.log.error({ err }, 'istek işlenirken hata');
      return reply.code(500).send({ error: 'sunucu-hatasi' });
    }
    // Bilinen hata kodlarını sabit, Türkçe-ASCII kısa kodlara çevir
    const kod = ({
      FST_ERR_CTP_BODY_TOO_LARGE: 'govde-cok-buyuk',
      BOYUT_ASILDI: 'govde-cok-buyuk',
      FST_ERR_CTP_INVALID_MEDIA_TYPE: 'icerik-turu-desteklenmiyor',
      FST_ERR_CTP_INVALID_JSON_BODY: 'govde-gecersiz',
      FST_ERR_CTP_EMPTY_JSON_BODY: 'govde-gecersiz',
      YOL_GECERSIZ: 'yol-gecersiz',
    }[err.code])
      ?? (typeof err.code === 'string' && !err.code.startsWith('FST_') ? err.code : null)
      ?? (typeof err.error === 'string' ? err.error : null)
      ?? 'istek-gecersiz';
    return reply.code(durum).send({ error: kod, mesaj: err.message });
  });

  // ---- rotalar
  const bagimliliklar = { config, auth, audit, auditTail, version };
  await app.register(healthRoutes, bagimliliklar);
  await app.register(authRoutes, bagimliliklar);
  await app.register(panoRoutes, bagimliliklar);
  await app.register(fileRoutes, bagimliliklar);
  await app.register(adminRoutes, bagimliliklar);

  // "/" giriş sayfası: oturumu olan panoya (ya da ?next'e) yönlenir
  const girisSayfasi = async (req, reply) => {
    if (req.user) {
      const next = typeof req.query?.next === 'string' ? req.query.next : undefined;
      return reply.redirect(safeNext(next) ?? '/app.html', 302);
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  };
  app.get('/', girisSayfasi);
  app.get('/index.html', girisSayfasi);

  return app;
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof YapilandirmaHatasi) {
      console.error(`Yapılandırma hatası: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const app = await buildApp(config);
  if (config.secretGenerated) {
    app.log.warn('SESSION_SECRET tanımlı değil: geçici rastgele bir gizli üretildi; sunucu yeniden başlayınca tüm oturumlar düşer');
  } else if (config.zayifSecret) {
    app.log.warn('SESSION_SECRET çok kısa (en az 16 karakter önerilir)');
  }
  app.log.info({ dataDir: config.DATA_DIR, publicDir: config.PUBLIC_DIR, ortam: config.isProd ? 'production' : 'gelistirme' }, 'sunucu başlatılıyor');

  let kapaniyor = false;
  const kapat = async (sinyal) => {
    if (kapaniyor) return;
    kapaniyor = true;
    app.log.info(`${sinyal} alındı, oturumlar diske yazılıp kapanıyor`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'kapanış sırasında hata');
      process.exit(1);
    }
  };
  process.once('SIGINT', () => kapat('SIGINT'));
  process.once('SIGTERM', () => kapat('SIGTERM'));

  try {
    await app.listen({
      port: config.PORT,
      host: config.HOST,
      listenTextResolver: (adres) => `Sunucu dinliyor: ${adres}`,
    });
  } catch (err) {
    app.log.error({ err }, 'sunucu dinlemeye başlayamadı');
    process.exit(1);
  }
}

// Doğrudan çalıştırıldıysa başlat (test/import sırasında başlatma)
const girisDosyasi = process.argv[1] ? pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href : '';
if (import.meta.url === girisDosyasi || fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error('Sunucu başlatılamadı:', err);
    process.exit(1);
  });
}
