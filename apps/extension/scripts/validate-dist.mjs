import { buildSync } from "esbuild";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const dist = process.env.PHASE_2A_DIST_DIR ? resolve(process.env.PHASE_2A_DIST_DIR) : join(root, "dist");
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const expectedPermissions = ["storage", "activeTab", "scripting", "debugger", "tabCapture", "offscreen", "sidePanel"];
if (JSON.stringify(manifest.permissions) !== JSON.stringify(expectedPermissions)) throw new Error("dist manifest 权限漂移");
if (JSON.stringify(manifest.host_permissions ?? []) !== JSON.stringify(["http://127.0.0.1:4100/*"])) throw new Error("dist manifest 只允许本机 Server host_permissions");
if (manifest.background?.service_worker !== "service-worker.js") throw new Error("dist service worker 缺失");
if (manifest.side_panel?.default_path !== "sidepanel.html") throw new Error("dist side_panel 缺失");

const visited = new Set();
function resolveModule(from, specifier) {
  if (!specifier.startsWith(".")) throw new Error(`dist 禁止非相对 import：${from} -> ${specifier}`);
  const candidate = resolve(dirname(from), specifier);
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  if (!candidate.endsWith(".js") && existsSync(`${candidate}.js`)) return `${candidate}.js`;
  throw new Error(`dist ESM import 无法解析：${from} -> ${specifier}`);
}

function importsOf(file) {
  const result = buildSync({
    entryPoints: [file],
    bundle: false,
    format: "esm",
    metafile: true,
    write: false,
    logLevel: "silent"
  });
  const output = Object.values(result.metafile?.outputs ?? {})[0];
  return output?.imports ?? [];
}

function visit(file) {
  if (visited.has(file)) return;
  visited.add(file);
  for (const record of importsOf(file)) {
    const specifier = record.path;
    if (!specifier.startsWith(".")) throw new Error(`dist 禁止 bare import：${file} -> ${specifier}`);
    visit(resolveModule(file, specifier));
  }
}

const entries = [manifest.background.service_worker, "popup.js", "offscreen.js", "sidepanel.js"].map((file) => join(dist, file));
for (const entry of entries) {
  if (!existsSync(entry)) throw new Error(`dist 入口缺失：${entry}`);
}
const javascriptFiles = readdirSync(dist).filter((file) => file.endsWith(".js")).map((file) => join(dist, file));
for (const file of javascriptFiles) visit(file);
const files = readdirSync(dist).filter((file) => file.endsWith(".js") || file.endsWith(".html") || file === "manifest.json");
const output = files.map((file) => readFileSync(join(dist, file), "utf8")).join("\n");
const forbiddenValues = ["raw-business-value", "raw secret payload", "20260806123456", ["138001", "38000"].join(""), "buyer@example.com", "7390", "#region agent log", "X-Debug-Session-Id"];
for (const forbidden of forbiddenValues) {
  if (output.includes(forbidden)) throw new Error(`dist 包含测试敏感值：${forbidden}`);
}
console.log(`Phase 2A dist module graph 校验通过：${visited.size} 个 JS 模块`);
