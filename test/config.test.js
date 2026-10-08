// PUBLIC_URL ve disKok: sihirli link kökü proxy zincirinden bağımsız üretilmeli.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, disKok, YapilandirmaHatasi } from '../server/config.js';

const TEMEL = { NODE_ENV: 'development', PORT: '3000' };

test('PUBLIC_URL: boşsa "", geçerliyse origin (sondaki / atılır)', () => {
  assert.equal(loadConfig({ ...TEMEL }).PUBLIC_URL, '');
  assert.equal(loadConfig({ ...TEMEL, PUBLIC_URL: 'https://takip.firma.com/' }).PUBLIC_URL, 'https://takip.firma.com');
  assert.equal(loadConfig({ ...TEMEL, PUBLIC_URL: 'http://localhost:3000' }).PUBLIC_URL, 'http://localhost:3000');
});

test('PUBLIC_URL: yol, sorgu, kullanıcı adı veya başka şema reddedilir', () => {
  for (const kotu of ['takip.firma.com', 'https://a.com/pano', 'https://a.com/?x=1', 'ftp://a.com', 'https://u@a.com']) {
    assert.throws(() => loadConfig({ ...TEMEL, PUBLIC_URL: kotu }), YapilandirmaHatasi, kotu);
  }
});

test('disKok: PUBLIC_URL öncelikli; yoksa X-Forwarded-Proto ilk girdisi; o da yoksa req.protocol', () => {
  const req = (headers, protocol = 'http', host = 'ic.local') => ({ headers, protocol, host });
  assert.equal(disKok({ PUBLIC_URL: 'https://takip.firma.com' }, req({ 'x-forwarded-proto': 'http' })), 'https://takip.firma.com');
  assert.equal(disKok({ PUBLIC_URL: '' }, req({ 'x-forwarded-proto': 'https, http' }, 'http', 'x.up.railway.app')), 'https://x.up.railway.app');
  assert.equal(disKok({ PUBLIC_URL: '' }, req({}, 'http', 'localhost:3000')), 'http://localhost:3000');
  assert.equal(disKok({ PUBLIC_URL: '' }, req({ 'x-forwarded-proto': ' ' }, 'https', 'a.com')), 'https://a.com');
});
