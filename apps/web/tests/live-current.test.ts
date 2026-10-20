import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pickLatestRunningSession } from "../app/live/current-session";

describe("当前进行中场次", () => {
  it("跳到最新 running 场，没有则空", () => {
    expect(pickLatestRunningSession([])).toBeUndefined();
    expect(pickLatestRunningSession([
      { sessionId: "stopped-1", status: "stopped", startedAt: "2026-08-19T04:00:00.000Z" }
    ])).toBeUndefined();
    expect(pickLatestRunningSession([
      { sessionId: "old-run", status: "running", startedAt: "2026-08-19T02:00:00.000Z" },
      { sessionId: "stopped-1", status: "stopped", startedAt: "2026-08-19T05:00:00.000Z" },
      { sessionId: "new-run", status: "running", startedAt: "2026-08-19T04:00:00.000Z" }
    ])?.sessionId).toBe("new-run");
  });

  it("空态页写中文说明，不改扩展去连局域网", () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app/live/current/page.tsx"), "utf8");
    expect(source).toContain("当前没有进行中的直播");
    expect(source).toContain("/api/live/sessions");
    expect(source).toContain("resolveLiveBackend");
    expect(source).toContain("LanShareBar");
  });
});
