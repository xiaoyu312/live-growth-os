import { buildSync } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
for (const file of ["manifest.json", "popup.html", "offscreen.html", "sidepanel.html"]) cpSync(join(root, file), join(dist, file));
// tsc emits every source module into dist. Remove non-entry JS files before
// bundling so stale bare imports cannot remain in the MV3 package.
for (const file of readdirSync(dist).filter((name) => name.endsWith(".js"))) {
  rmSync(join(dist, file), { force: true });
}

const bundleDir = join(dist, ".bundle");
rmSync(bundleDir, { recursive: true, force: true });
const bundleEntries = ["service-worker", "popup", "offscreen", "sidepanel"];
buildSync({
  entryPoints: Object.fromEntries(bundleEntries.map((file) => [file, join(root, "src", `${file}.ts`)])),
  outdir: bundleDir,
  bundle: true,
  define: { __DESKTOP_CAPTURE_ONLY__: process.env.DESKTOP_CAPTURE_ONLY === "1" ? "true" : "false" },
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  legalComments: "eof",
  alias: {
    "@live-growth/source-adapters/live-browser": join(root, "..", "..", "packages", "source-adapters", "src", "live-browser.ts"),
    "@live-growth/rules/source-recovery": join(root, "..", "..", "packages", "rules", "src", "source-recovery.ts"),
    "@live-growth/rules/source-group-health": join(root, "..", "..", "packages", "rules", "src", "source-group-health.ts")
  }
});
for (const file of bundleEntries) cpSync(join(bundleDir, `${file}.js`), join(dist, `${file}.js`));
rmSync(bundleDir, { recursive: true, force: true });
console.log(`Phase 2A 扩展构建完成：${dist}`);
