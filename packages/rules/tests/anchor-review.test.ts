// Public synthetic fixtures; no private person, product, transcript, or historical calibration is included.
import { describe, expect, it } from "vitest";
import { liveEventSchema, type LiveEvent } from "@live-growth/contracts";
import { aggregateLiveWindows } from "../src/live-window-aggregate";
import { assembleAnchorReview, assertAnchorReviewRange, AnchorReviewRangeError, shanghaiRangeLabel } from "../src/anchor-review";
import { buildAnchorSessionReport } from "../src/reference-script";

const TENANT = "tenant-demo";
const SESSION = "session-anchor-review";
const GENERATED_AT = "2026-08-14T01:00:00.000Z";
const RANGE_START = "2026-08-14T00:00:00.000Z";
const RANGE_END = "2026-08-14T00:30:00.000Z";

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
function twoWindows() {
  const events = [
    qianchuanEvent("2026-08-14T00:01:00.000Z", { productClicks: { value: 0, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:10:00.000Z", { productClicks: { value: 20, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:16:00.000Z", { productClicks: { value: 30, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:25:00.000Z", { productClicks: { value: 60, semantic: "cumulative" } }),
    compassEvent("2026-08-14T00:01:00.000Z", { paidBuyerCount: 5 }),
    compassEvent("2026-08-14T00:10:00.000Z", { paidBuyerCount: 8 }),
    compassEvent("2026-08-14T00:16:00.000Z", { paidBuyerCount: 8 }),
    compassEvent("2026-08-14T00:25:00.000Z", { paidBuyerCount: 14 })
  ];
  return aggregateLiveWindows(events, { sessionStartAt: RANGE_START, sessionEndAt: RANGE_END });
}

describe("assertAnchorReviewRange", () => {
  it("只接受已结束的15分钟边界，最多4小时", () => {
    expect(() => assertAnchorReviewRange(RANGE_START, RANGE_END, GENERATED_AT)).not.toThrow();
    expect(() => assertAnchorReviewRange("2026-08-14T00:01:00.000Z", RANGE_END, GENERATED_AT)).toThrow(AnchorReviewRangeError);
    expect(() => assertAnchorReviewRange(RANGE_START, "2026-08-14T04:15:00.000Z", "2026-08-14T05:00:00.000Z")).toThrow("最多4小时");
    expect(() => assertAnchorReviewRange(RANGE_START, RANGE_END, "2026-08-14T00:10:00.000Z")).toThrow("已经结束");
  });
});

describe("assembleAnchorReview", () => {
  it("无转写时样本不足，不做话术好坏判断", () => {
    const windows = twoWindows();
    const coverage = buildAnchorSessionReport({
      tenantId: TENANT, sessionId: SESSION, sessionStatus: "stopped",
      transcripts: [], windows, generatedAt: GENERATED_AT
    });
    const review = assembleAnchorReview({
      hostName: "演示主播 A", sessionId: SESSION, rangeStartAt: RANGE_START, rangeEndAt: RANGE_END,
      generatedAt: GENERATED_AT, coverage, windows
    });
    expect(review.narrative.summary.text).toContain("演示主播 A");
    expect(review.narrative.summary.text).toContain("样本不足");
    expect(review.narrative.strengths).toEqual([]);
    expect(review.narrative.gaps).toEqual([]);
    expect(review.narrative.nextSteps[0]).toContain("完整转写");
    expect(review.provider).toBe("deterministic-template");
  });

  it("结合覆盖与窗口数据产出讲得好、缺口、时段和建议", () => {
    const windows = twoWindows();
    const coverage = buildAnchorSessionReport({
      tenantId: TENANT, sessionId: SESSION, sessionStatus: "stopped",
      transcripts: [
        { at: "2026-08-14T00:05:00.000Z", text: "演示商品到手价100元，点开商品卡查看说明" }
      ],
      windows, generatedAt: GENERATED_AT
    });
    const review = assembleAnchorReview({
      hostName: "演示主播 A", sessionId: SESSION, rangeStartAt: RANGE_START, rangeEndAt: RANGE_END,
      generatedAt: GENERATED_AT, coverage, windows
    });
    expect(shanghaiRangeLabel(RANGE_START, RANGE_END)).toBe("08:00–08:30");
    expect(review.narrative.summary.text).toContain("08:00–08:30");
    expect(review.narrative.summary.text).toMatch(/下一场先补|保持这套/);
    expect(review.narrative.strengths.some((item) => item.text.includes("到手价") && item.quote?.includes("100"))).toBe(true);
    expect(review.narrative.strengths.some((item) => item.text.includes("「") && item.text.includes(item.quote ?? "___"))).toBe(false);
    expect(review.narrative.gaps.some((item) => item.text.includes("没有出现") && item.text.includes("下一场先补"))).toBe(true);
    expect(review.narrative.gaps.every((item) => !item.text.includes("不要写成"))).toBe(true);
    expect(review.narrative.timeline.some((item) => item.text.includes("商品点击增量"))).toBe(true);
    expect(review.narrative.timeline.every((item) => !item.text.includes("仅相关性"))).toBe(true);
    expect(review.narrative.nextSteps[0]).toContain("演示主播 A");
    expect(review.narrative.nextSteps[0]).toMatch(/明确说明|保持/);
    expect(review.dataNotes.some((note) => note.includes("副驾留在原来的标签"))).toBe(true);
    for (const item of [review.narrative.summary, ...review.narrative.strengths, ...review.narrative.gaps, ...review.narrative.timeline]) {
      for (const number of item.citedNumbers) {
        expect(item.text).toMatch(new RegExp(`(?<!\\d)${String(number.value)}(?!\\d)`));
      }
    }
  });
});
