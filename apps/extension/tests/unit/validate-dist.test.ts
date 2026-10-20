import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

describe("extension dist contract", () => {
  it.each([
    ['import { runtime } from "@invalid/runtime";'],
    ['import {\n  runtime\n} from "@invalid/runtime";'],
    ['export { runtime } from "@invalid/runtime";'],
    ['import "#invalid/runtime";'],
    ['import("@invalid/runtime");']
  ])("rejects a static bare import: %s", (source) => {
    const script = resolve(process.cwd(), "scripts/validate-dist.mjs");
    const fixture = mkdtempSync(resolve(tmpdir(), "phase-2a-dist-"));
    try {
      writeFileSync(resolve(fixture, "manifest.json"), JSON.stringify({
        permissions: ["storage", "activeTab", "scripting", "debugger", "tabCapture", "offscreen", "sidePanel"],
        host_permissions: ["http://127.0.0.1:4100/*"],
        background: { service_worker: "service-worker.js" },
        side_panel: { default_path: "sidepanel.html" }
      }));
      writeFileSync(resolve(fixture, "service-worker.js"), source);
      writeFileSync(resolve(fixture, "popup.js"), "export {};\n");
      writeFileSync(resolve(fixture, "offscreen.js"), "export {};\n");
      writeFileSync(resolve(fixture, "sidepanel.js"), "export {};\n");
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { ...process.env, PHASE_2A_DIST_DIR: fixture }
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/bare import|裸导入/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("accepts the bundled current dist without false positives from string values", () => {
    const script = resolve(process.cwd(), "scripts/validate-dist.mjs");
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("accepts relative imports and ignores comments, templates and ordinary string contents", () => {
    const script = resolve(process.cwd(), "scripts/validate-dist.mjs");
    const fixture = mkdtempSync(resolve(tmpdir(), "phase-2a-dist-"));
    try {
      writeFileSync(resolve(fixture, "manifest.json"), JSON.stringify({
        permissions: ["storage", "activeTab", "scripting", "debugger", "tabCapture", "offscreen", "sidePanel"],
        host_permissions: ["http://127.0.0.1:4100/*"],
        background: { service_worker: "service-worker.js" },
        side_panel: { default_path: "sidepanel.html" }
      }));
      writeFileSync(resolve(fixture, "service-worker.js"), 'import { helper } from "./helper.js"; // import "@not/a-package"\n/* export { bad } from "@not/a-package"; */\nconst copy = `import("@not/a-package")`; void helper; void copy;');
      writeFileSync(resolve(fixture, "helper.js"), "export const helper = true;\n");
      writeFileSync(resolve(fixture, "popup.js"), "export {};\n");
      writeFileSync(resolve(fixture, "offscreen.js"), "export {};\n");
      writeFileSync(resolve(fixture, "sidepanel.js"), "export {};\n");
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { ...process.env, PHASE_2A_DIST_DIR: fixture }
      });
      expect(result.status).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
