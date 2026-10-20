// Runs only as a child using the Electron-bundled Node; no system Node required.
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const [mode, root, dataDir] = process.argv.slice(2);
let server;
async function stop() {
  const timer = setTimeout(() => process.exit(0), 4000);
  timer.unref();
  try { await server?.close(); } finally { process.exit(0); }
}
process.on('message', (msg) => { if (msg === 'stop') void stop(); });
process.on('disconnect', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
(async () => {
  if (mode === 'server') {
    const { startDesktopServer } = await import(pathToFileURL(join(root, 'service.mjs')).href);
    server = await startDesktopServer(dataDir);
    process.send?.({ ready: true });
  } else if (mode === 'web') {
    require(join(root, 'web', 'apps', 'web', 'server.js'));
  } else throw new Error('Unknown runtime mode');
})().catch((error) => {

  process.send?.({ failed: true, code: error?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'START_FAILED' });
  process.exit(1);
});
