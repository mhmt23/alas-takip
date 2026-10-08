// Giriş/çıkış, oturum bilgisi ve sihirli link rotaları (V1-SPEC §4–§5).
import { requireAuth, safeNext, isWebview, isCrawler } from '../auth.js';
import { disKok } from '../config.js';

const SAYFA_STIL = `
  :root{color-scheme:light dark;--bg:#f4f6f8;--card:#fff;--ink:#1c2630;--mut:#5b6773;--line:#d5dce3;--acc:#2b5d8c}
  @media (prefers-color-scheme:dark){:root{--bg:#12181e;--card:#1b232b;--ink:#e8edf2;--mut:#9aa7b3;--line:#2c3742;--acc:#6aa5d8}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
  h1{margin:0 0 12px;font-size:20px;line-height:1.3}
  p{margin:0 0 14px;color:var(--mut)}
  input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font:14px ui-monospace,monospace}
  button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:600 16px system-ui,sans-serif;cursor:pointer}
`;

function html(baslik, icerik) {
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${baslik}</title><style>${SAYFA_STIL}</style></head>
<body><main>${icerik}</main></body></html>`;
}

function kacir(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const GECERSIZ_MESAJ = {
  yok: 'Bu bağlantı geçerli değil.',
  'suresi-doldu': 'Bu bağlantının süresi dolmuş.',
  dolu: 'Bu bağlantı izin verilen cihaz sayısına ulaşmış.',
};

function gecersizSayfa(durum) {
  return html(
    'Bağlantı geçersiz',
    `<h1>${GECERSIZ_MESAJ[durum] ?? GECERSIZ_MESAJ.yok}</h1>
     <p>Lütfen şantiye şefinden yeni bir bağlantı isteyin.</p>`,
  );
}

function webviewSayfa(url) {
  const u = kacir(url);
  return html(
    'Tarayıcıda açın',
    `<h1>Bu bağlantıyı Safari/Chrome'da açın</h1>
     <p>Uygulama içi tarayıcı (WhatsApp, Instagram vb.) giriş bilgisini saklayamaz. Bağlantıyı kopyalayıp Safari veya Chrome'da açın; bir kez açmanız yeterli.</p>
     <input id="adres" readonly value="${u}" onfocus="this.select()">
     <button id="kopyala" type="button">Bağlantıyı kopyala</button>
     <p id="durum" style="margin-top:12px" role="status"></p>
     <script>
       (function(){
         var d=document.getElementById('durum'), a=document.getElementById('adres');
         document.getElementById('kopyala').addEventListener('click', function(){
           function tamam(){ d.textContent='Kopyalandı. Şimdi Safari/Chrome\\'u açıp adres çubuğuna yapıştırın.'; }
           function yedek(){ a.focus(); a.select(); try{ document.execCommand('copy'); tamam(); }catch(e){ d.textContent='Bağlantıyı elle seçip kopyalayın.'; } }
           if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(a.value).then(tamam, yedek); } else { yedek(); }
         });
       })();
     </script>`,
  );
}

export default async function authRoutes(app, { config, auth, audit }) {
  // ---- POST /api/login (JSON ya da form)
  app.post(
    '/api/login',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const govde = req.body && typeof req.body === 'object' ? req.body : {};
      const formMu = String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
      const kullanici = await auth.verifyLogin(govde.username, govde.password);
      if (!kullanici) {
        // Şifre hiçbir zaman yazılmaz; kullanıcı adı yalnız geçerli biçimdeyse kaydedilir
        const ad = typeof govde.username === 'string' ? govde.username.trim().toLowerCase() : '';
        await audit(req, 'giris-basarisiz', { username: /^[a-z0-9._-]{2,32}$/.test(ad) ? ad : '(geçersiz-biçim)' }, { username: null, role: null });
        return reply.code(401).send({ error: 'sifre-yanlis' });
      }
      if (req.sid) auth.destroySession(req.sid); // eski oturumu bırak (oturum sabitleme olmasın)
      const sid = auth.createSession({ username: kullanici.username, role: kullanici.role, ua: req.headers['user-agent'] });
      auth.setCookie(reply, sid, kullanici.role);
      await audit(req, 'giris', null, { username: kullanici.username, role: kullanici.role });
      const next = safeNext(govde.next) ?? '/app.html';
      if (formMu) return reply.redirect(next, 302);
      return { ok: true, role: kullanici.role, next };
    },
  );

  // ---- GET /api/me
  app.get('/api/me', { onRequest: requireAuth }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { username: req.user.username, role: req.user.role };
  });

  // ---- GET /g/:token — patron için şifresiz sihirli link
  app.get('/g/:token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = req.params.token;

    // Zaten oturumu olan (patron, admin, şef...) cihazda linki yakma: cihaz hakkı harcanmasın,
    // mevcut oturum ezilip yetim kalmasın. Doğrudan panoya git.
    if (req.user) return reply.redirect('/app.html', 302);

    const { durum } = auth.inspectToken(token);
    if (durum !== 'ok') {
      await audit(req, 'sihirli-link-red', { neden: durum }, { username: null, role: null });
      return reply.code(410).type('text/html; charset=utf-8').send(gecersizSayfa(durum));
    }

    // Uygulama içi tarayıcı (webview), link önizleme botu, HEAD ya da ön-yükleme isteği:
    // oturum açma, token yakma; Safari/Chrome'a yönlendir
    const ua = req.headers['user-agent'];
    const onYukleme = /prefetch|prerender/i.test(`${req.headers.purpose ?? ''} ${req.headers['sec-purpose'] ?? ''}`);
    if (isWebview(ua) || isCrawler(ua) || req.method === 'HEAD' || onYukleme) {
      const url = `${disKok(config, req)}/g/${token}`;
      return reply.type('text/html; charset=utf-8').send(webviewSayfa(url));
    }

    const sonuc = await auth.consumeToken(token, { ua: req.headers['user-agent'], ip: req.ip });
    if (!sonuc) {
      return reply.code(410).type('text/html; charset=utf-8').send(gecersizSayfa('yok'));
    }
    auth.setCookie(reply, sonuc.sid, 'patron');
    await audit(req, 'sihirli-link-giris', { label: sonuc.label }, { username: `patron:${sonuc.label || 'link'}`, role: 'patron' });
    return reply.redirect('/app.html', 302);
  });

  // ---- GET /cikis
  app.get('/cikis', async (req, reply) => {
    if (req.user && req.sid) {
      await audit(req, 'cikis', null);
      auth.destroySession(req.sid);
    }
    auth.clearCookie(reply);
    reply.header('Cache-Control', 'no-store');
    return reply.redirect('/', 302);
  });
}
