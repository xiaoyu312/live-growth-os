const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { sealAppPreset, openAppPreset, initializeAppPreset, PRESET_FILE } = require('../app-preset.cjs');
const APP = { appId: '1234567', appSecret: 'synthetic_preset_secret_only', independentApp: true };
const csrfToken = 'a'.repeat(64);
async function presetRoot() { const root = await mkdtemp(join(tmpdir(), 'pilot-preset-test-')); await writeFile(join(root, PRESET_FILE), sealAppPreset(APP)); return root; }
test('portable preset contains no literal secret and accepts only the approved three fields', () => {
  const envelope = sealAppPreset(APP);
  assert.equal(envelope.includes(APP.appSecret), false);
  assert.deepEqual(openAppPreset(envelope), APP);
  for (const extra of [{ accessToken: 'synthetic' }, { binding: {} }, { refreshToken: 'synthetic' }]) assert.throws(() => sealAppPreset({ ...APP, ...extra }), /APP_PRESET_INVALID/);
  const corrupted = JSON.parse(envelope); corrupted.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => openAppPreset(JSON.stringify(corrupted)), /APP_PRESET_INVALID/);
});
test('ordinary build without preset performs no setup requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-no-preset-'));
  assert.deepEqual(await initializeAppPreset(root, () => { throw new Error('unexpected'); }), { present: false });
});
test('fresh installation seeds only the app through loopback plus CSRF, then requests login', async () => {
  const calls = [];
  const result = await initializeAppPreset(await presetRoot(), async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, 'http://127.0.0.1:4100');
    assert.equal(options.headers.Origin, 'http://127.0.0.1:3000');
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/setup')) return Response.json({ csrfToken, connection: { appConfigured: false, authorized: false } });
    assert.equal(options.headers['X-Qianchuan-Setup-Token'], csrfToken);
    assert.deepEqual(JSON.parse(options.body), APP);
    return Response.json({ appConfigured: true, authorized: false });
  });
  assert.deepEqual(result, { present: true, needsAuthorization: true });
  assert.equal(calls.length, 2);
});
test('existing app and authorization remain authoritative on restart or upgrade', async () => {
  let requests = 0;
  const result = await initializeAppPreset(await presetRoot(), async (url) => {
    requests++; assert.equal(url.endsWith('/setup'), true);
    return Response.json({ csrfToken, connection: { appConfigured: true, authorized: true, binding: { arbitrary: 'preserved' } } });
  });
  assert.deepEqual(result, { present: true, needsAuthorization: false }); assert.equal(requests, 1);
});
test('invalid existing config and missing CSRF cannot cause a write', async () => {
  const root = await presetRoot();
  for (const setup of [{ csrfToken, connection: { appConfigured: false, errorCode: 'QIANCHUAN_CONFIG_INVALID' } }, { connection: { appConfigured: false } }]) {
    await assert.rejects(() => initializeAppPreset(root, async (url) => { assert.equal(url.endsWith('/setup'), true); return Response.json(setup); }), /APP_PRESET_/);
  }
});
