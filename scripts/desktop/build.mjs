import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'apps/desktop/dist/runtime');
const require = createRequire(join(root, 'apps/extension/package.json'));
const { build } = require('esbuild');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({ entryPoints: [join(root, 'apps/server/src/desktop-server.ts')], outfile: join(out, 'service.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: false,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  external: ['node:*'], legalComments: 'eof' });
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_OUTPUT: 'standalone', NEXT_DIST_DIR: '.next-desktop', NEXT_PUBLIC_CAPTURE_ONLY: '1', NEXT_PUBLIC_OPERATOR_RULES: '1', NEXT_PUBLIC_API_URL: 'http://127.0.0.1:4100', NEXT_PUBLIC_WS_URL: 'ws://127.0.0.1:4100' };
execFileSync(process.execPath, [join(root, 'apps/web/node_modules/next/dist/bin/next'), 'build'], { cwd: join(root, 'apps/web'), env, stdio: 'inherit' });
const web = join(root, 'apps/web/.next-desktop');
const filter = (path) => !basename(path).startsWith('.env') && !basename(path).endsWith('.preset') && !['.DS_Store', '@img', 'sharp'].includes(basename(path)) && !/\.(node|dylib|so)$/.test(path) && !/(?:^|[/\\])(?:sharp@|@img\+)/.test(path);
const standalone = join(web, 'standalone');
cpSync(standalone, join(out, 'web'), { recursive: true, dereference: true, filter: (p) => basename(p) !== 'node_modules' && filter(p) });
// Flatten the traced pnpm runtime: dereferencing only 'next' loses its sibling dependencies.
const traced = join(standalone, 'node_modules/.pnpm');
for (const entry of readdirSync(traced)) {
  const modules = join(traced, entry, 'node_modules');
  if (!existsSync(modules)) continue;
  for (const name of readdirSync(modules)) {
    const source = join(modules, name);
    if (lstatSync(source).isSymbolicLink() || !filter(source)) continue;
    const names = name.startsWith('@') ? readdirSync(source).map((n) => `${name}/${n}`) : [name];
    for (const moduleName of names) {
      const moduleSource = join(modules, moduleName);
      if (lstatSync(moduleSource).isSymbolicLink() || !filter(moduleSource)) continue;
      cpSync(moduleSource, join(out, 'web/node_modules', moduleName), { recursive: true, dereference: true, filter });
    }
  }
}
cpSync(join(web, 'static'), join(out, 'web/apps/web/.next-desktop/static'), { recursive: true, filter });
if (existsSync(join(root, 'apps/web/public'))) cpSync(join(root, 'apps/web/public'), join(out, 'web/apps/web/public'), { recursive: true, filter });
execFileSync(process.execPath, [join(root, 'apps/extension/scripts/build.mjs')], { cwd: root, env: { ...process.env, DESKTOP_CAPTURE_ONLY: '1' }, stdio: 'inherit' });
cpSync(join(root, 'apps/extension/dist'), join(out, 'extension'), { recursive: true, filter });
for (const name of ['server.js', '.next-desktop/required-server-files.json']) {
  const metadata = join(out, 'web/apps/web', name);
  writeFileSync(metadata, readFileSync(metadata, 'utf8').replaceAll(root, '.'));
}
for (const name of ['offscreen.html', 'offscreen.js', 'sidepanel.html', 'sidepanel.js']) rmSync(join(out, 'extension', name), { force: true });
const mp = join(out, 'extension/manifest.json');
const manifest = JSON.parse(readFileSync(mp, 'utf8'));
manifest.name = '直播副驾 · 罗盘数据接入'; manifest.description = '桌面测试版，仅由用户手动连接罗盘读取经营数据；不采集音频。';
manifest.permissions = manifest.permissions.filter((p) => !['tabCapture', 'offscreen', 'sidePanel'].includes(p));
delete manifest.side_panel;
writeFileSync(mp, JSON.stringify(manifest, null, 2));
const popup = join(out, 'extension/popup.html');
writeFileSync(popup, readFileSync(popup, 'utf8').replace('<details>', '<details hidden>'));
writeFileSync(join(out, 'build.json'), JSON.stringify({ id: 'public-source-edition', authScope: [20101000, 20121100, 200000011, 21121000, 22100400], captureOnly: true, operatorRulesEnabled: true, workbenchEnabled: true, database: 'sqlite', electron: '44.3.0', credentialsIncluded: false }, null, 2));
console.log('Desktop runtime staged:', out);
