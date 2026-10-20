// Public synthetic fixtures; no private person, product, transcript, or historical calibration is included.
import { describe, expect, it } from "vitest";
import {
  ANCHOR_REVIEW_PROMPT_VERSION,
  ANCHOR_REVIEW_SYSTEM_PROMPT,
  anchorReviewInputSummary,
  buildAnchorReviewUserPayload
} from "../src/anchor-review-v1";
import { assembleAnchorReview, aggregateLiveWindows, buildAnchorSessionReport } from "@live-growth/rules";
import { liveEventSchema, type LiveEvent } from "@live-growth/contracts";

const TENANT = "tenant-demo";
const SESSION = "session-secret";
const GENERATED_AT = "2026-08-14T01:00:00.000Z";

let sequence = 0;
function compassEvent(eventAt: string, payload: Record<string, unknown>): LiveEvent {
  sequence += 1;
  return liveEventSchema.parse({
    schemaVersion: 1, eventId: `evt-${sequence}`, tenantId: TENANT, sessionId: SESSION,
    eventAt, capturedAt: eventAt, ingestedAt: eventAt, source: "browser_extension", kind: "live.compass.metric", provisional: false,
    payload: { observedAt: eventAt, sourceEndpoint: "/compass_api/shop/live/live_screen/core_data", mappingVersion: "compass-live-v1", dataStatus: "fresh", ...payload }
  });
}

describe("anchor-review-v1", () => {
  it("用户包含主播、时段和证据，不含场次号", () => {
    const windows = aggregateLiveWindows([
      compassEvent("2026-08-14T00:01:00.000Z", { paidBuyerCount: 5 }),
      compassEvent("2026-08-14T00:10:00.000Z", { paidBuyerCount: 8 })
    ], { sessionStartAt: "2026-08-14T00:00:00.000Z", sessionEndAt: "2026-08-14T00:15:00.000Z" });
    const coverage = buildAnchorSessionReport({
      tenantId: TENANT, sessionId: SESSION, sessionStatus: "stopped",
      transcripts: [{ at: "2026-08-14T00:05:00.000Z", text: "演示商品到手价100元，点开商品卡查看说明" }],
      windows, generatedAt: GENERATED_AT
    });
    const review = assembleAnchorReview({
      hostName: "演示主播 A", sessionId: SESSION,
      rangeStartAt: "2026-08-14T00:00:00.000Z", rangeEndAt: "2026-08-14T00:15:00.000Z",
      generatedAt: GENERATED_AT, coverage, windows
    });
    const payload = buildAnchorReviewUserPayload(review, "08:00–08:15");
    const serialized = JSON.stringify(payload);
    expect(payload.hostName).toBe("演示主播 A");
    expect(payload.rangeLabel).toBe("08:00–08:15");
    expect(serialized).not.toContain("session-secret");
    expect(serialized).not.toContain(TENANT);
    expect(ANCHOR_REVIEW_SYSTEM_PROMPT).toContain("导致");
    expect(ANCHOR_REVIEW_SYSTEM_PROMPT).toContain("转写里没有出现不等于主播没讲");
    expect(ANCHOR_REVIEW_SYSTEM_PROMPT).toContain("不要重复粘贴转写");
    expect(ANCHOR_REVIEW_PROMPT_VERSION).toBe("anchor-review-v2");
    expect(anchorReviewInputSummary(review).promptVersion).toBe(ANCHOR_REVIEW_PROMPT_VERSION);
  });
});
