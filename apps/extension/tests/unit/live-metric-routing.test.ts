import { describe, expect, it } from "vitest";
import { parseLiveMetricForRoute } from "../../src/live-metric-routing";
import { QIANCHUAN_LIVE_ENDPOINTS, QIANCHUAN_LIVE_ORIGIN } from "@live-growth/source-adapters/live-browser";

const observedAt = "2026-08-13T08:15:00.000Z";
const qianchuanBody = { data: { StatsData: { Totals: {
  stat_cost_for_roi2: { Value: 2849.45, ValueStr: "2,849.45" },
  total_live_pay_amt_for_roi2: { Value: 10582.25, ValueStr: "10,582.25" },
  total_pay_order_count_for_roi2: { Value: 28 }
} } } };

describe("live browser metric routing", () => {
  it("keeps qianchuan statQuery separate from Compass", () => {
    const input = { origin: QIANCHUAN_LIVE_ORIGIN, endpoint: QIANCHUAN_LIVE_ENDPOINTS.statQuery, observedAt, body: qianchuanBody };
    expect(parseLiveMetricForRoute("qianchuan-board", input)?.metricSource).toBe("qianchuan");
    expect(parseLiveMetricForRoute("compass-live-shop", input)).toBeNull();
  });

  it("rejects roi2Log and unknown routes", () => {
    const input = { origin: QIANCHUAN_LIVE_ORIGIN, endpoint: QIANCHUAN_LIVE_ENDPOINTS.roi2Log, observedAt, body: qianchuanBody };
    expect(parseLiveMetricForRoute("qianchuan-board", input)).toBeNull();
    expect(parseLiveMetricForRoute("unknown", input)).toBeNull();
    expect(parseLiveMetricForRoute("qianchuan-board", { ...input, endpoint: "/ad/api/data/v1/unknown" })).toBeNull();
  });

  it("千川当前仅接受 HTTPS statQuery，WSS 在证据确认前拒绝", () => {
    const input = { origin: QIANCHUAN_LIVE_ORIGIN, endpoint: QIANCHUAN_LIVE_ENDPOINTS.statQuery, observedAt, body: qianchuanBody };
    expect(parseLiveMetricForRoute("qianchuan-board", input)?.metricSource).toBe("qianchuan");
    expect(parseLiveMetricForRoute("qianchuan-board", { ...input, origin: "wss://qianchuan.jinritemai.com", direction: "received" })).toBeNull();
    expect(parseLiveMetricForRoute("qianchuan-board", { ...input, direction: "sent" })).toBeNull();
    expect(parseLiveMetricForRoute("qianchuan-board", { ...input, direction: "binary" })).toBeNull();
  });
});
