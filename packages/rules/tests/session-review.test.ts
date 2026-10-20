// Public synthetic fixtures; no private person, product, transcript, or historical calibration is included.
import { describe, expect, it } from "vitest";
import { liveEventSchema, type LiveEvent } from "@live-growth/contracts";
import { aggregateLiveWindows } from "../src/live-window-aggregate";
import { assembleSessionReview, pickSessionBottleneck, SessionReviewRangeError } from "../src/session-review";
import { buildAnchorSessionReport } from "../src/reference-script";

const TENANT = "tenant-demo";
const SESSION = "session-session-review";
const GENERATED_AT = "2026-08-14T03:00:00.000Z";
const RANGE_START = "2026-08-14T00:00:00.000Z";
const RANGE_END = "2026-08-14T01:00:00.000Z";

let sequence = 0;
function compassEvent(eventAt: string, payload: Record<string, unknown>): LiveEvent {
  sequence += 1;
  return liveEventSchema.parse({
    schemaVersion: 1, eventId: `evt-compass-${sequence}`, tenantId: TENANT, sessionId: SESSION,
    eventAt, capturedAt: eventAt, ingestedAt: eventAt, source: "browser_extension", kind: "live.compass.metric", provisional: false,
    payload: { observedAt: eventAt, sourceEndpoint: "/compass_api/shop/live/live_screen/core_data", mappingVersion: "compass-live-v1", dataStatus: "fresh", ...payload }
  });
}
function qianchuanEvent(eventAt: string, metrics: Record<string, { value: number; semantic: "instant" | "cumulative" | "rolling" | "rate" }>): LiveEvent {
  sequence += 1;
  const fullMetrics = Object.fromEntries(Object.entries(metrics).map(([key, item]) => [key, {
    value: item.value, unit: "次" as const, semantic: item.semantic, sourceField: `source_${key}`
  }]));
  return liveEventSchema.parse({
    schemaVersion: 1, eventId: `evt-qc-${sequence}`, tenantId: TENANT, sessionId: SESSION,
    eventAt, capturedAt: eventAt, ingestedAt: eventAt, source: "browser_extension", kind: "live.qianchuan.metric", provisional: false,
    payload: { observedAt: eventAt, sourceEndpoint: "/ad/api/data/v1/common/statQuery", mappingVersion: "qianchuan-live-v1", dataStatus: "fresh", metricSource: "qianchuan", metrics: fullMetrics }
  });
}

function twoHours() {
  const events = [
    qianchuanEvent("2026-08-14T00:01:00.000Z", { productClicks: { value: 0, semantic: "cumulative" }, liveImpressions: { value: 0, semantic: "cumulative" }, liveWatchCount: { value: 0, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:10:00.000Z", { productClicks: { value: 40, semantic: "cumulative" }, liveImpressions: { value: 800, semantic: "cumulative" }, liveWatchCount: { value: 200, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:16:00.000Z", { productClicks: { value: 40, semantic: "cumulative" }, liveImpressions: { value: 800, semantic: "cumulative" }, liveWatchCount: { value: 200, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:25:00.000Z", { productClicks: { value: 80, semantic: "cumulative" }, liveImpressions: { value: 1200, semantic: "cumulative" }, liveWatchCount: { value: 360, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:46:00.000Z", { productClicks: { value: 80, semantic: "cumulative" }, liveImpressions: { value: 1200, semantic: "cumulative" }, liveWatchCount: { value: 360, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:55:00.000Z", { productClicks: { value: 90, semantic: "cumulative" }, liveImpressions: { value: 1500, semantic: "cumulative" }, liveWatchCount: { value: 400, semantic: "cumulative" } }),
    compassEvent("2026-08-14T00:01:00.000Z", { paidBuyerCount: 0 }),
    compassEvent("2026-08-14T00:10:00.000Z", { paidBuyerCount: 0 }),
    compassEvent("2026-08-14T00:16:00.000Z", { paidBuyerCount: 0 }),
    compassEvent("2026-08-14T00:25:00.000Z", { paidBuyerCount: 0 }),
    compassEvent("2026-08-14T00:46:00.000Z", { paidBuyerCount: 0 }),
    compassEvent("2026-08-14T00:55:00.000Z", { paidBuyerCount: 0 })
  ];
  return aggregateLiveWindows(events, { sessionStartAt: RANGE_START, sessionEndAt: RANGE_END });
}

describe("pickSessionBottleneck", () => {
  it("有点击没支付时卡在成交，曝光进来少时卡在进线", () => {
    expect(pickSessionBottleneck({ speechFinalCount: 10, productClicks: 20, paidBuyers: 0 })).toBe("convert");
    expect(pickSessionBottleneck({ speechFinalCount: 10, liveImpressions: 200, liveWatch: 10 })).toBe("entry");
    expect(pickSessionBottleneck({ speechFinalCount: 10, liveWatch: 40, productClicks: 2 })).toBe("click");
    expect(pickSessionBottleneck({ speechFinalCount: 10, productClicks: 20, paidBuyers: 6 })).toBe("steady");
  });
});

describe("assembleSessionReview", () => {
  it("没有走完的时段时拒绝复盘", () => {
    expect(() => assembleSessionReview({
      hostName: "演示主播 A", sessionId: SESSION, rangeStartAt: RANGE_START, rangeEndAt: RANGE_END,
      generatedAt: GENERATED_AT,
      coverage: buildAnchorSessionReport({
        tenantId: TENANT, sessionId: SESSION, sessionStatus: "stopped",
        transcripts: [], windows: [], generatedAt: GENERATED_AT
      }),
      windows: [], truncated: false
    })).toThrow(SessionReviewRangeError);
  });

  it("按钟点写成整场报告，不写加权和工程词", () => {
    const windows = twoHours();
    const coverage = buildAnchorSessionReport({
      tenantId: TENANT, sessionId: SESSION, sessionStatus: "stopped",
      transcripts: [
        { at: "2026-08-14T00:05:00.000Z", text: "演示商品到手价100元，点开商品卡查看说明" },
        { at: "2026-08-14T00:50:00.000Z", text: "演示商品到手价100元，点开商品卡查看说明" }
      ],
      windows, generatedAt: GENERATED_AT
    });
    const review = assembleSessionReview({
      hostName: "演示主播 A", sessionId: SESSION,
      rangeStartAt: windows[0]!.windowStartAt, rangeEndAt: windows.at(-1)!.windowEndAt,
      generatedAt: GENERATED_AT, coverage, windows, truncated: false
    });
    expect(review.narrative.summary.text).toContain("演示主播 A");
    expect(review.narrative.summary.text).toContain("这场");
    expect(review.narrative.summary.text).not.toMatch(/加权|GMV|LLM|窗口|底稿/);
    expect(review.narrative.bottleneck.text).toContain("成交");
    expect(review.narrative.chapters.length).toBeGreaterThanOrEqual(1);
    expect(review.narrative.chapters[0]?.label).toMatch(/^\d{2}:00–\d{2}:00$/);
    expect(review.narrative.strengths.some((item) => item.text.includes("到手价"))).toBe(true);
    expect(review.narrative.gaps.some((item) => item.text.includes("转写里没有出现"))).toBe(true);
    expect(review.narrative.gaps.every((item) => !item.text.includes("权重") && !item.text.includes("不要写成"))).toBe(true);
    expect(review.narrative.nextSteps[0]).toContain("演示主播 A");
    expect(review.narrative.nextSteps.length).toBeLessThanOrEqual(3);
    expect(review.dataNotes.some((note) => note.includes("不等于主播没讲"))).toBe(true);
    for (const item of [review.narrative.summary, review.narrative.bottleneck, ...review.narrative.chapters, ...review.narrative.strengths, ...review.narrative.gaps]) {
      for (const number of item.citedNumbers) {
        expect(item.text).toMatch(new RegExp(`(?<!\\d)${String(number.value)}(?!\\d)`));
      }
    }
  });
});
