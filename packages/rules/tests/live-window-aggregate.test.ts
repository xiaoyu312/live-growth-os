import { describe, expect, it } from "vitest";
import { liveEventSchema, type LiveEvent } from "@live-growth/contracts";
import { aggregateLiveWindows, completedWindowOptions, liveWindowKeyFor, DEFAULT_LIVE_WINDOW_UTC_OFFSET_MINUTES } from "../src/live-window-aggregate";

const TENANT = "tenant-demo";
const SESSION = "session-window-test";

let sequence = 0;
function compassEvent(eventAt: string, payload: Record<string, unknown>): LiveEvent {
  sequence += 1;
  return liveEventSchema.parse({
    schemaVersion: 1, eventId: `evt-compass-${sequence}`, tenantId: TENANT, sessionId: SESSION,
    eventAt, capturedAt: eventAt, ingestedAt: eventAt, source: "browser_extension", kind: "live.compass.metric", provisional: false,
    payload: { observedAt: eventAt, sourceEndpoint: "/compass_api/shop/live/live_screen/core_data", mappingVersion: "compass-live-v1", dataStatus: "fresh", ...payload }
  });
}

function qianchuanEvent(eventAt: string, metrics: Record<string, { value: number; semantic: "instant" | "cumulative" | "rolling" | "rate" }>, source: "browser_extension" | "official_api" = "browser_extension"): LiveEvent {
  sequence += 1;
  const fullMetrics = Object.fromEntries(Object.entries(metrics).map(([key, item]) => [key, {
    value: item.value, unit: "元" as const, semantic: item.semantic, sourceField: `source_${key}`
  }]));
  return liveEventSchema.parse({
    schemaVersion: 1, eventId: `evt-qc-${sequence}`, tenantId: TENANT, sessionId: SESSION,
    eventAt, capturedAt: eventAt, ingestedAt: eventAt, source, kind: "live.qianchuan.metric", provisional: false,
    payload: {
      observedAt: eventAt,
      sourceEndpoint: source === "official_api" ? "/open_api/v1.0/qianchuan/today_live/room/get/" : "/ad/api/data/v1/common/statQuery",
      mappingVersion: source === "official_api" ? "qianchuan-official-live-v1" : "qianchuan-live-v1",
      dataStatus: "fresh", metricSource: "qianchuan", metrics: fullMetrics
    }
  });
}

function speechEvent(eventAt: string, text: string): LiveEvent {
  sequence += 1;
  return liveEventSchema.parse({
    schemaVersion: 1, eventId: `evt-speech-${sequence}`, tenantId: TENANT, sessionId: SESSION,
    eventAt, capturedAt: eventAt, ingestedAt: eventAt, source: "asr", kind: "speech.final", provisional: false,
    payload: { id: `seg-${sequence}`, tenantId: TENANT, sessionId: SESSION, startMs: 0, endMs: 1000, text, isFinal: true, tags: ["other"], sourceEventId: `seg-${sequence}` }
  });
}

describe("liveWindowKeyFor", () => {
  it("按 +08:00 本地时间对齐 15 分钟窗口并计算 weekday/slotIndex", () => {
    // 2026-08-14 是周五；UTC 00:07 = 本地 08:07 → 槽 32（08:00–08:15）
    const key = liveWindowKeyFor(Date.parse("2026-08-14T00:07:00.000Z"), DEFAULT_LIVE_WINDOW_UTC_OFFSET_MINUTES);
    expect(key.windowStartAt).toBe("2026-08-14T00:00:00.000Z");
    expect(key.windowEndAt).toBe("2026-08-14T00:15:00.000Z");
    expect(key.weekday).toBe(5);
    expect(key.slotIndex).toBe(32);
  });

  it("跨本地日界时 slotIndex 归零且 weekday 前进", () => {
    // UTC 16:01 = 本地次日 00:01 → 周六 槽 0
    const key = liveWindowKeyFor(Date.parse("2026-08-14T16:01:00.000Z"));
    expect(key.weekday).toBe(6);
    expect(key.slotIndex).toBe(0);
    expect(key.windowStartAt).toBe("2026-08-14T16:00:00.000Z");
  });
});

describe("completedWindowOptions", () => {
  it("只列出已经走完的15分钟槽，不包含当前未结束窗", () => {
    const options = completedWindowOptions("2026-08-14T00:07:00.000Z", Date.parse("2026-08-14T00:40:00.000Z"));
    expect(options.map((item) => item.windowStartAt)).toEqual([
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T00:15:00.000Z"
    ]);
    expect(options.at(-1)?.windowEndAt).toBe("2026-08-14T00:30:00.000Z");
  });
});

describe("aggregateLiveWindows", () => {
  it("空输入返回空数组，不发射无样本窗口", () => {
    expect(aggregateLiveWindows([])).toEqual([]);
  });

  it("累计字段按跨窗基准计算正向增量，instant 字段保留极值", () => {
    const events = [
      compassEvent("2026-08-14T00:01:00.000Z", { sessionPaidGmvFen: 10_000, onlineSnapshot: 50 }),
      compassEvent("2026-08-14T00:10:00.000Z", { sessionPaidGmvFen: 25_000, onlineSnapshot: 80 }),
      // 下一窗：增量应以上一窗末值 25_000 为基准
      compassEvent("2026-08-14T00:20:00.000Z", { sessionPaidGmvFen: 31_000, onlineSnapshot: 60 })
    ];
    const windows = aggregateLiveWindows(events);
    expect(windows).toHaveLength(2);
    const first = windows[0]!;
    expect(first.compass["sessionPaidGmvFen"]!.delta).toBe(15_000);
    expect(first.compass["sessionPaidGmvFen"]!.resetCount).toBe(0);
    expect(first.compass["onlineSnapshot"]!.min).toBe(50);
    expect(first.compass["onlineSnapshot"]!.max).toBe(80);
    expect(first.compass["onlineSnapshot"]!.delta).toBeUndefined();
    const second = windows[1]!;
    expect(second.compass["sessionPaidGmvFen"]!.delta).toBe(6_000);
    expect(second.sampleCounts.compassSnapshots).toBe(1);
  });

  it("累计字段回退计入 resetCount 且不产生负增量", () => {
    const events = [
      compassEvent("2026-08-14T00:01:00.000Z", { adSpendFen: 9_000 }),
      compassEvent("2026-08-14T00:05:00.000Z", { adSpendFen: 2_000 }),
      compassEvent("2026-08-14T00:09:00.000Z", { adSpendFen: 5_000 })
    ];
    const stat = aggregateLiveWindows(events)[0]!.compass["adSpendFen"]!;
    expect(stat.resetCount).toBe(1);
    expect(stat.delta).toBe(3_000);
    expect(stat.min).toBe(2_000);
    expect(stat.max).toBe(9_000);
  });

  it("跨商品字段不进入窗口聚合", () => {
    const events = [compassEvent("2026-08-14T00:01:00.000Z", { productClickCount: 30, productPayGmvFen: 5_000, sessionPaidGmvFen: 1_000 })];
    const window = aggregateLiveWindows(events)[0]!;
    expect(window.compass["productClickCount"]).toBeUndefined();
    expect(window.compass["productPayGmvFen"]).toBeUndefined();
    expect(window.compass["sessionPaidGmvFen"]).toBeDefined();
  });

  it("千川字段按源值声明的 semantic 聚合", () => {
    const events = [
      qianchuanEvent("2026-08-14T00:02:00.000Z", { adSpend: { value: 100, semantic: "cumulative" }, roi: { value: 2.5, semantic: "rate" } }),
      qianchuanEvent("2026-08-14T00:12:00.000Z", { adSpend: { value: 180, semantic: "cumulative" }, roi: { value: 2.1, semantic: "rate" } })
    ];
    const window = aggregateLiveWindows(events)[0]!;
    expect(window.qianchuan["adSpend"]!.delta).toBe(80);
    expect(window.qianchuan["roi"]!.delta).toBeUndefined();
    expect(window.qianchuan["roi"]!.last).toBe(2.1);
    expect(window.sampleCounts.qianchuanSnapshots).toBe(2);
  });

  it("浏览器切到官方 API 时只聚合最后连续来源段，不跨源计算累计差值", () => {
    const events = [
      qianchuanEvent("2026-08-14T00:01:00.000Z", { adSpend: { value: 100, semantic: "cumulative" } }),
      qianchuanEvent("2026-08-14T00:02:00.000Z", { adSpend: { value: 120, semantic: "cumulative" } }),
      qianchuanEvent("2026-08-14T00:03:00.000Z", { adSpend: { value: 110, semantic: "cumulative" } }, "official_api"),
      qianchuanEvent("2026-08-14T00:04:00.000Z", { adSpend: { value: 130, semantic: "cumulative" } }, "official_api")
    ];
    const window = aggregateLiveWindows(events)[0]!;
    expect(window.qianchuan["adSpend"]).toMatchObject({ first: 110, last: 130, delta: 20, sampleCount: 2 });
    expect(window.sampleCounts.qianchuanSnapshots).toBe(2);
  });

  it("官方 API 回退到浏览器时同样切断累计基线", () => {
    const events = [
      qianchuanEvent("2026-08-14T00:01:00.000Z", { adSpend: { value: 80, semantic: "cumulative" } }, "official_api"),
      qianchuanEvent("2026-08-14T00:02:00.000Z", { adSpend: { value: 100, semantic: "cumulative" } }, "official_api"),
      qianchuanEvent("2026-08-14T00:03:00.000Z", { adSpend: { value: 90, semantic: "cumulative" } }),
      qianchuanEvent("2026-08-14T00:04:00.000Z", { adSpend: { value: 95, semantic: "cumulative" } })
    ];
    const window = aggregateLiveWindows(events)[0]!;
    expect(window.qianchuan["adSpend"]).toMatchObject({ first: 90, last: 95, delta: 5, sampleCount: 2 });
    expect(window.sampleCounts.qianchuanSnapshots).toBe(2);
  });

  it("跨窗口切源时保留已完成旧窗口，新窗口不继承旧来源累计基线", () => {
    const events = [
      qianchuanEvent("2026-08-14T00:01:00.000Z", { adSpend: { value: 100, semantic: "cumulative" } }, "official_api"),
      qianchuanEvent("2026-08-14T00:10:00.000Z", { adSpend: { value: 120, semantic: "cumulative" } }, "official_api"),
      qianchuanEvent("2026-08-14T00:16:00.000Z", { adSpend: { value: 90, semantic: "cumulative" } }),
      qianchuanEvent("2026-08-14T00:20:00.000Z", { adSpend: { value: 95, semantic: "cumulative" } })
    ];
    const windows = aggregateLiveWindows(events);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.qianchuan["adSpend"]).toMatchObject({ first: 100, last: 120, delta: 20, sampleCount: 2 });
    expect(windows[1]!.qianchuan["adSpend"]).toMatchObject({ first: 90, last: 95, delta: 5, sampleCount: 2 });
  });

  it("浏览器→官方→浏览器三段切换分别保留已完成窗口", () => {
    const events = [
      qianchuanEvent("2026-08-14T00:01:00.000Z", { adSpend: { value: 100, semantic: "cumulative" } }),
      qianchuanEvent("2026-08-14T00:10:00.000Z", { adSpend: { value: 110, semantic: "cumulative" } }),
      qianchuanEvent("2026-08-14T00:16:00.000Z", { adSpend: { value: 80, semantic: "cumulative" } }, "official_api"),
      qianchuanEvent("2026-08-14T00:20:00.000Z", { adSpend: { value: 90, semantic: "cumulative" } }, "official_api"),
      qianchuanEvent("2026-08-14T00:31:00.000Z", { adSpend: { value: 120, semantic: "cumulative" } }),
      qianchuanEvent("2026-08-14T00:35:00.000Z", { adSpend: { value: 130, semantic: "cumulative" } })
    ];
    const windows = aggregateLiveWindows(events);
    expect(windows.map((window) => window.qianchuan["adSpend"]?.delta)).toEqual([10, 10, 10]);
    expect(windows.map((window) => window.sampleCounts.qianchuanSnapshots)).toEqual([2, 2, 2]);
  });

  it("话术统计 finalCount、charCount 与最大间隔", () => {
    const events = [
      speechEvent("2026-08-14T00:01:00.000Z", "演示商品价格一百元"),
      speechEvent("2026-08-14T00:04:00.000Z", "查看商品信息入口"),
      speechEvent("2026-08-14T00:05:00.000Z", "确认活动截止时间"),
      compassEvent("2026-08-14T00:14:00.000Z", { onlineSnapshot: 10 })
    ];
    const window = aggregateLiveWindows(events)[0]!;
    expect(window.speech.finalCount).toBe(3);
    expect(window.speech.charCount).toBe(25);
    expect(window.speech.maxGapMs).toBe(180_000);
    expect(window.speech.firstAt).toBe("2026-08-14T00:01:00.000Z");
  });

  it("会话未覆盖完整窗口时标记 partial，覆盖时标记 full", () => {
    const events = [
      compassEvent("2026-08-14T00:07:00.000Z", { onlineSnapshot: 20 }),
      compassEvent("2026-08-14T00:20:00.000Z", { onlineSnapshot: 30 }),
      compassEvent("2026-08-14T00:31:00.000Z", { onlineSnapshot: 25 })
    ];
    const windows = aggregateLiveWindows(events, { sessionStartAt: "2026-08-14T00:07:00.000Z", sessionEndAt: "2026-08-14T00:31:00.000Z" });
    expect(windows.map((item) => item.coverage)).toEqual(["partial", "full", "partial"]);
  });

  it("聚合结果确定性：同一输入两次运行完全一致", () => {
    const events = [
      compassEvent("2026-08-14T00:01:00.000Z", { sessionPaidGmvFen: 10_000, onlineSnapshot: 50 }),
      speechEvent("2026-08-14T00:02:00.000Z", "话术样本"),
      qianchuanEvent("2026-08-14T00:03:00.000Z", { adSpend: { value: 100, semantic: "cumulative" } })
    ];
    expect(aggregateLiveWindows(events)).toEqual(aggregateLiveWindows(events));
  });
});
