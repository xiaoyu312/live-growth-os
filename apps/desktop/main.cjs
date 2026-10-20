const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { fork } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync } = require('node:fs');
const { createServer } = require('node:net');
const { initializeAppPreset } = require('./app-preset.cjs');
const WEB = 'http://127.0.0.1:3000';
const COMPASS = 'https://compass.jinritemai.com/';
const children = new Set();
let window;
let shuttingDown = false;
let startupFailed = false;
let ready = false;
const runtimeRoot = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(__dirname, 'dist', 'runtime');
const dataDir = process.env.LIVE_PILOT_QA_DATA_DIR || app.getPath('userData');
function allowedExternal(address) {
  try {
    const u = new URL(address);
    if (u.username || u.password || u.hash) return false;
    if (address === COMPASS) return true;
    return u.origin === 'https://qianchuan.jinritemai.com' && u.pathname === '/openapi/qc/audit/oauth.html'
      && u.searchParams.get('redirect_uri') === 'http://127.0.0.1:18889/qianchuan/callback'
      && /^\d+$/.test(u.searchParams.get('app_id') || '') && /^[a-f0-9]{64}$/.test(u.searchParams.get('state') || '')
      && ['redirect_uri', 'app_id', 'state', 'scope'].every((k) => u.searchParams.getAll(k).length === 1)
      && u.searchParams.get('scope') === '[20101000,20121100,200000011,21121000,22100400]'
      && [...u.searchParams.keys()].every((k) => ['redirect_uri', 'app_id', 'state', 'scope'].includes(k));
  } catch { return false; }
}
function local(address) {
  try { const u = new URL(address); return u.origin === WEB && !u.username && !u.password && (u.pathname === '/live' || u.pathname.startsWith('/live/')); }
  catch { return false; }
}
async function external(address) { if (allowedExternal(address)) await shell.openExternal(address); }
function cleanEnv(mode) {
  // Do not inherit another project's API keys, credentials, proxy or database config.
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', HOST: '127.0.0.1', HOSTNAME: '127.0.0.1', PORT: mode === 'web' ? '3000' : '4100', WEB_ORIGIN: WEB, BUILD_ID: 'public-source-edition', NEXT_TELEMETRY_DISABLED: '1' };
}
function launch(mode) {
  const child = fork(join(__dirname, 'runtime.cjs'), [mode, runtimeRoot, dataDir], {
    execPath: process.execPath, execArgv: [], cwd: dataDir, env: cleanEnv(mode), silent: true, windowsHide: true
  });
  children.add(child);
  // Consume without logging request/response bodies or credentials.
  child.stdout?.resume();
  child.stderr?.resume();
  child.once('exit', () => { children.delete(child); if (ready && !shuttingDown) void fail('运行服务意外退出，请重新打开直播副驾。'); });
  return child;
}
async function stopChildren() {
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send('stop', () => {}); else child.kill();
  })));
}
async function fail(message) {
  if (shuttingDown || startupFailed) return;
  startupFailed = true;
  ready = false;
  await stopChildren();
  if (process.env.LIVE_PILOT_QA_DATA_DIR) console.error('DESKTOP_START_FAILED', message);
  else dialog.showErrorBox('直播副驾暂时无法启动', message);
  app.quit();
}
async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
async function waitWeb(child) {
  for (let i = 0; i < 100; i++) {
    if (shuttingDown || child.exitCode !== null || child.signalCode !== null) throw new Error('WEB_FAILED');
    try { const r = await fetch(`${WEB}/live`, { signal: AbortSignal.timeout(1000), redirect: 'error' }); if (r.ok) return; } catch { /* waiting for owned server */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('WEB_TIMEOUT');
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault(); shuttingDown = true; ready = false;
    void stopChildren().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      for (const port of [3000, 4100]) await checkPort(port);
      const service = launch('server');
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SERVER_TIMEOUT')), 20000);
        service.once('error', (err) => { clearTimeout(timeout); reject(err); });
        service.once('exit', () => { clearTimeout(timeout); reject(new Error('SERVER_EXIT')); });
        service.on('message', (msg) => { if (msg?.ready) { clearTimeout(timeout); resolve(); } else if (msg?.failed) { clearTimeout(timeout); reject(new Error(msg.code)); } });
      });
      if (shuttingDown) return;
      const preset = await initializeAppPreset(runtimeRoot);
      const web = launch('web');
      await waitWeb(web);
      if (shuttingDown) return;
      window = new BrowserWindow({ width: 1380, height: 900, minWidth: 980, minHeight: 650, title: '直播副驾 · 数据接入测试版', backgroundColor: '#f7f8fa', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
      window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      window.webContents.on('will-navigate', (event, address) => { if (!local(address)) { event.preventDefault(); void external(address); } });
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (local(url)) void window.loadURL(url); else void external(url);
        return { action: 'deny' };
      });
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ label: '直播副驾', submenu: [{ role: 'quit' }] }] : []),
        { label: '直播副驾', submenu: [
          { label: '接入说明', click: () => window.loadURL(`${WEB}/live`) },
          { label: '千川授权', click: () => window.loadURL(`${WEB}/live/connect`) },
          { label: '当前直播', click: () => window.loadURL(`${WEB}/live/current`) },
          { type: 'separator' },
          { label: '打开罗盘网站', click: () => external(COMPASS) },
          { label: '打开扩展文件夹', click: () => shell.openPath(join(runtimeRoot, 'extension')) },
          { label: '打开本机数据文件夹', click: () => shell.openPath(dataDir) },
          { type: 'separator' }, { role: 'quit', label: '退出副驾' }
        ] },
        { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { label: '查看', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
      ]));
      await window.loadURL(`${WEB}${preset.needsAuthorization ? '/live/connect' : '/live'}`);
      ready = true;
    } catch (error) {
      await fail(error?.code === 'EADDRINUSE' || error?.message === 'PORT_IN_USE' ? '本机 3000 或 4100 端口已被占用。请关闭旧版副驾后重试；软件不会终止其他程序。' : error?.message?.startsWith('APP_PRESET_') ? '预配置应用未能加载。已有本机配置会保留，请联系管理员检查配置或重新提供内测安装包。' : '本机服务启动失败。请确认安装完整、当前用户数据目录可写，然后重试。');
    }
  }).catch(() => fail('桌面初始化失败，请重新安装后重试。'));
}
