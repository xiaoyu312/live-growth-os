const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { readFile, stat } = require('node:fs/promises');
const { join } = require('node:path');

const PRESET_FILE = 'application.preset';
const API = 'http://127.0.0.1:4100/api/qianchuan';
const ORIGIN = 'http://127.0.0.1:3000';
function presetError() { return new Error('APP_PRESET_INVALID'); }
function validateApp(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'appId,appSecret,independentApp'
    || typeof input.appId !== 'string' || !/^[1-9]\d{0,19}$/.test(input.appId) || !Number.isSafeInteger(Number(input.appId))
    || typeof input.appSecret !== 'string' || !input.appSecret.trim() || input.appSecret.length > 2048
    || /[\u0000\r\n]/.test(input.appSecret) || input.independentApp !== true) throw presetError();
  return { appId: input.appId, appSecret: input.appSecret.trim(), independentApp: true };
}

// Portable packaging only. The key travels with the ciphertext, so this is
// NOT secret protection against someone who possesses the installer.
function sealAppPreset(input) {
  const app = validateApp(input);
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(app), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, key: key.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
function openAppPreset(text) {
  try {
    if (typeof text !== 'string' || text.length > 16384) throw presetError();
    const item = JSON.parse(text);
    if (item.version !== 1 || Object.keys(item).sort().join(',') !== 'ciphertext,iv,key,tag,version') throw presetError();
    for (const name of ['key', 'iv', 'tag', 'ciphertext']) if (typeof item[name] !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(item[name])) throw presetError();
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(item.key, 'base64'), Buffer.from(item.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(item.tag, 'base64'));
    return validateApp(JSON.parse(Buffer.concat([decipher.update(Buffer.from(item.ciphertext, 'base64')), decipher.final()]).toString('utf8')));
  } catch { throw presetError(); }
}
async function initializeAppPreset(runtimeRoot, fetchImpl = fetch) {
  const path = join(runtimeRoot, PRESET_FILE);
  try { if ((await stat(path)).size > 16384) throw presetError(); }
  catch (error) { if (error.code === 'ENOENT') return { present: false }; throw presetError(); }
  const get = await fetchImpl(`${API}/setup`, { headers: { Origin: ORIGIN }, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!get.ok) throw new Error('APP_PRESET_SETUP_FAILED');
  const setup = await get.json();
  if (typeof setup.connection?.appConfigured !== 'boolean') throw new Error('APP_PRESET_SETUP_FAILED');
  // Existing local configuration is authoritative, including another app,
  // binding and user authorization. Never replace it on startup or upgrade.
  if (setup.connection.appConfigured) return { present: true, needsAuthorization: !setup.connection.authorized };
  if (setup.connection.errorCode) throw new Error('APP_PRESET_EXISTING_CONFIG_INVALID');
  if (typeof setup.csrfToken !== 'string' || !/^[a-f0-9]{64}$/.test(setup.csrfToken)) throw new Error('APP_PRESET_SETUP_FAILED');
  const app = openAppPreset(await readFile(path, 'utf8'));
  const saved = await fetchImpl(`${API}/app`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Qianchuan-Setup-Token': setup.csrfToken },
    body: JSON.stringify(app), redirect: 'error', signal: AbortSignal.timeout(5000)
  });
  if (!saved.ok || (await saved.json()).appConfigured !== true) throw new Error('APP_PRESET_SETUP_FAILED');
  return { present: true, needsAuthorization: true };
}
module.exports = { PRESET_FILE, validateApp, sealAppPreset, openAppPreset, initializeAppPreset };
