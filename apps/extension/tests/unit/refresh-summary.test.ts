import { describe, expect, it } from "vitest";
import { cadenceGroups, summarizeIntervals } from "../../../../scripts/phase-2a/refresh-summary";

describe("Phase 2A 刷新 cadence", () => {
  it("先排序 timestamps 和 intervals，再计算 median", () => {
    expect(summarizeIntervals([
      "2026-08-06T00:00:10.000Z",
      "2026-08-06T00:00:00.000Z",
      "2026-08-06T00:00:30.000Z",
      "2026-08-06T00:00:15.000Z"
    ])).toEqual({ count: 4, min: 5000, median: 10000, max: 15000 });
  });

  it("同一请求的三阶段只分别计入 endpoint request_start 与 field body_shape", () => {
    const groups = cadenceGroups([
      { kind: "http", phase: "request_start", origin: "https://api.example.test", pathname: "/metrics", observedAt: "2026-08-06T00:00:10.000Z", fields: [] },
      { kind: "http", phase: "response_metadata", origin: "https://api.example.test", pathname: "/metrics", observedAt: "2026-08-06T00:00:11.000Z", fields: [] },
      { kind: "http", phase: "body_shape", origin: "https://api.example.test", pathname: "/metrics", observedAt: "2026-08-06T00:00:12.000Z", fields: [{ path: "root.metrics.onlineCount" }] }
    ]);
    expect([...groups.keys()]).toEqual(["https://api.example.test/metrics · <endpoint>", "https://api.example.test/metrics · root.metrics.onlineCount"]);
    expect(groups.get("https://api.example.test/metrics · <endpoint>")).toEqual(["2026-08-06T00:00:10.000Z"]);
    expect(groups.get("https://api.example.test/metrics · root.metrics.onlineCount")).toEqual(["2026-08-06T00:00:12.000Z"]);
  });
});
