import { describe, expect, it } from "vitest";
import { sanitizePageUrl } from "../../src/allowlist";
import { isMetricFieldPath, isSemanticMetricCode, isValidMetricObservation, sanitizeDomFields, sanitizeNetworkObservation, sanitizeTargetObservation } from "../../src/sanitize";

const syntheticPhone = "138001" + "38000";

describe("Phase 2A 结构脱敏", () => {
  it("pathname 动态片段统一占位，网络和 Target 观察共用同一规则", () => {
    const numericPath = sanitizePageUrl("https://api.example.test/live/room/123456/metrics?secret=never-store#fragment");
    const uuidPath = sanitizePageUrl("https://api.example.test/live/room/550e8400-e29b-41d4-a716-446655440000/status");
    const resourcePath = sanitizePageUrl("https://api.example.test/assets/9f86d081884c7d659a2feaa0c55ad015.png");
    const opaqueResourcePath = sanitizePageUrl("https://api.example.test/assets/aZ7kP2mN9qR4tV8xC6bD");
    const cdnHashPath = sanitizePageUrl("https://api.example.test/assets/aZxQ1rT2uV3wX4yZ5-2026.webp");
    const opaqueLettersPath = sanitizePageUrl("https://api.example.test/api/AbCdEfGhIjKlMnOpQrStUvWx");
    const opaqueSymbolPath = sanitizePageUrl("https://api.example.test/assets/aBcDeFgHiJkLmNoPqRsT=+~");
    const stableCamelCasePath = sanitizePageUrl("https://api.example.test/api/getLiveRoomMetricsV2");
    const stableLongCamelCasePath = sanitizePageUrl("https://api.example.test/api/liveRoomPerformanceMetricsV2");
    const stableVeryLongPath = sanitizePageUrl("https://api.example.test/api/getRoomMetricsSummaryByHourV2");
    expect(numericPath).toEqual({ origin: "https://api.example.test", pathname: "/live/room/[dynamic-segment]/metrics" });
    expect(uuidPath).toEqual({ origin: "https://api.example.test", pathname: "/live/room/[dynamic-segment]/status" });
    expect(resourcePath).toEqual({ origin: "https://api.example.test", pathname: "/assets/[dynamic-segment]" });
    expect(opaqueResourcePath).toEqual({ origin: "https://api.example.test", pathname: "/assets/[dynamic-segment]" });
    expect(cdnHashPath).toEqual({ origin: "https://api.example.test", pathname: "/assets/[dynamic-segment]" });
    expect(opaqueLettersPath).toEqual({ origin: "https://api.example.test", pathname: "/api/[dynamic-segment]" });
    expect(opaqueSymbolPath).toEqual({ origin: "https://api.example.test", pathname: "/assets/[dynamic-segment]" });
    expect(stableCamelCasePath).toEqual({ origin: "https://api.example.test", pathname: "/api/[dynamic-segment]" });
    expect(stableLongCamelCasePath).toEqual({ origin: "https://api.example.test", pathname: "/api/[dynamic-segment]" });
    expect(stableVeryLongPath).toEqual({ origin: "https://api.example.test", pathname: "/api/[dynamic-segment]" });
    expect(sanitizePageUrl(`${resourcePath?.origin}${resourcePath?.pathname}`)).toEqual(resourcePath);
    expect(sanitizePageUrl(`${opaqueLettersPath?.origin}${opaqueLettersPath?.pathname}`)).toEqual(opaqueLettersPath);

    const network = sanitizeNetworkObservation({ kind: "http", url: "https://api.example.test/assets/9f86d081884c7d659a2feaa0c55ad015.png", observedAt: "2026-08-06T00:00:00.000Z" });
    const target = sanitizeTargetObservation({ observedAt: "2026-08-06T00:00:00.000Z", targetType: "iframe", url: "https://api.example.test/live/room/550e8400-e29b-41d4-a716-446655440000/status", lifecycle: "created" });
    const opaqueNetwork = sanitizeNetworkObservation({ kind: "http", url: "https://api.example.test/api/AbCdEfGhIjKlMnOpQrStUvWx", observedAt: "2026-08-06T00:00:00.000Z" });
    const opaqueTarget = sanitizeTargetObservation({ observedAt: "2026-08-06T00:00:00.000Z", targetType: "iframe", url: "https://api.example.test/api/AbCdEfGhIjKlMnOpQrStUvWx", lifecycle: "created" });
    const stableTarget = sanitizeTargetObservation({ observedAt: "2026-08-06T00:00:00.000Z", targetType: "iframe", url: "https://api.example.test/api/liveRoomPerformanceMetricsV2", lifecycle: "created" });
    const stableVeryLongTarget = sanitizeTargetObservation({ observedAt: "2026-08-06T00:00:00.000Z", targetType: "iframe", url: "https://api.example.test/api/getRoomMetricsSummaryByHourV2", lifecycle: "created" });
    const stable = sanitizeNetworkObservation({ kind: "http", url: "https://api.example.test/v1/live/rooms/metrics/summary", observedAt: "2026-08-06T00:00:00.000Z" });
    expect(network?.pathname).toBe("/assets/[dynamic-segment]");
    expect(target?.pathname).toBe("/live/room/[dynamic-segment]/status");
    expect(opaqueNetwork?.pathname).toBe("/api/[dynamic-segment]");
    expect(opaqueTarget?.pathname).toBe("/api/[dynamic-segment]");
    expect(stableTarget?.pathname).toBe("/api/[dynamic-segment]");
    expect(stableVeryLongTarget?.pathname).toBe("/api/[dynamic-segment]");
    expect(stable?.pathname).toBe("/v1/live/rooms/metrics/summary");
  });

  it("只保留 origin/pathname 与字段 shape，不保存 query、凭证或业务正文", () => {
    const observation = sanitizeNetworkObservation({
      kind: "http",
      url: "https://compass.jinritemai.com/screen/live/shop?token=abc&customer=storm",
      observedAt: "2026-08-06T00:00:00.000Z",
      method: "get",
      resourceType: "xhr",
      body: { metrics: { clicks: 12 }, Authorization: "Bearer secret", customerPhone: syntheticPhone, label: "safe" }
    });
    expect(observation).not.toBeNull();
    expect(observation).toMatchObject({ origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop", method: "GET", resourceType: "xhr" });
    expect(JSON.stringify(observation)).not.toContain("token");
    expect(JSON.stringify(observation)).not.toContain(syntheticPhone);
    expect(JSON.stringify(observation)).not.toContain("secret");
    expect(JSON.stringify(observation)).toContain("metrics.clicks");
    expect(observation?.metricObservations).toEqual([{ path: "root.metrics.clicks", observedAt: "2026-08-06T00:00:00.000Z", value: 12 }]);
  });

  it("WS 结构摘要不接收原始 payload，DOM 只保存稳定摘要和刷新次数", () => {
    const ws = sanitizeNetworkObservation({ kind: "ws", url: "wss://compass.jinritemai.com/socket", observedAt: "2026-08-06T00:00:00.000Z", direction: "received", messageBytes: 42 });
    expect(ws).toMatchObject({ kind: "ws", messageBytes: 42, fields: [] });
    const first = sanitizeDomFields([{ label: "在线人数", selector: "div:nth-of-type(1)", valueType: "number" }], [], "2026-08-06T00:00:00.000Z");
    const second = sanitizeDomFields([{ label: "在线人数", selector: "div:nth-of-type(1)", valueType: "number" }], first, "2026-08-06T00:00:03.000Z");
    expect(second[0]?.refreshCount).toBe(2);
    expect(second[0]?.selectorDigest).toMatch(/^s[0-9a-f]{8}$/);
  });

  it("动态键和订单 ID 数字不落盘，经营 metric 数字保留受控时间序列", () => {
    const observation = sanitizeNetworkObservation({
      kind: "http",
      url: "https://api.example.test/v1/metrics",
      observedAt: "2026-08-06T00:00:00.000Z",
      body: {
        orderId: 20260806123456,
        "550e8400-e29b-41d4-a716-446655440000": { clicks: 7 },
        "buyer@example.com": { clicks: 8 },
        metrics: { onlineCount: 18, roi: 1.2 }
      }
    });
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("20260806123456");
    expect(serialized).not.toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(serialized).not.toContain("buyer@example.com");
    expect(observation?.fields.map((field) => field.path)).toContain("root.[dynamic-key].clicks");
    expect(observation?.metricObservations).toEqual([
      { path: "root.metrics.onlineCount", observedAt: "2026-08-06T00:00:00.000Z", value: 18 },
      { path: "root.metrics.roi", observedAt: "2026-08-06T00:00:00.000Z", value: 1.2 }
    ]);
  });

  it("中文用户名／评论对象键统一归一，DOM aria-label 不保存原文", () => {
    const observation = sanitizeNetworkObservation({
      kind: "http",
      url: "https://api.example.test/comments",
      observedAt: "2026-08-06T00:00:00.000Z",
      body: { data: { "张三": "这是一条评论原文" } }
    });
    const dom = sanitizeDomFields([{ label: "回复 张三：这是一条评论原文", selector: "button.reply", valueType: "button" }], [], "2026-08-06T00:00:00.000Z");
    const serialized = JSON.stringify({ observation, dom });
    expect(serialized).not.toContain("张三");
    expect(serialized).not.toContain("评论原文");
    expect(observation?.fields.map((field) => field.path)).toContain("root.data.[dynamic-key]");
    expect(dom[0]?.label).toBe("[结构字段]");
  });

  it("合法 paidBuyerCount／clickToPaidRate metric 不因 id 子串被误删", () => {
    const observation = sanitizeNetworkObservation({
      kind: "http",
      url: "https://api.example.test/metrics",
      observedAt: "2026-08-06T00:00:00.000Z",
      body: { metrics: { paidBuyerCount: 4, clickToPaidRate: 0.25 } }
    });
    expect(observation?.metricObservations).toEqual([
      { path: "root.metrics.clickToPaidRate", observedAt: "2026-08-06T00:00:00.000Z", value: 0.25 },
      { path: "root.metrics.paidBuyerCount", observedAt: "2026-08-06T00:00:00.000Z", value: 4 }
    ]);
  });

  it("多指标数组保留安全 semanticCode，非指标时间／身份数字不进入序列", () => {
    const observation = sanitizeNetworkObservation({
      kind: "http",
      url: "https://api.example.test/metrics",
      observedAt: "2026-08-06T00:00:00.000Z",
      body: {
        metrics: [
          { index_name: "room_enter_uv", value: 12, review_start_ts: 1, room_id: 20260806123456 },
          { index_name: "product_click_rate", value: 0.25, order_id: 2 }
        ]
      }
    });
    expect(observation?.fields.map((field) => field.path)).toContain("root.metrics[1].index_name");
    expect(observation?.metricObservations).toEqual([
      { path: "root.metrics[0].value", observedAt: "2026-08-06T00:00:00.000Z", value: 12, semanticCode: "room_enter_uv" },
      { path: "root.metrics[1].value", observedAt: "2026-08-06T00:00:00.000Z", value: 0.25, semanticCode: "product_click_rate" }
    ]);
    expect(observation?.metricObservations?.some((item) => item.path.includes("review_start_ts") || item.path.includes("room_id") || item.path.includes("order_id"))).toBe(false);
  });

  it("连写或下划线身份字段及 semanticCode 一律 fail-closed", () => {
    const observation = sanitizeNetworkObservation({
      kind: "http",
      url: "https://api.example.test/metrics",
      observedAt: "2026-08-06T00:00:00.000Z",
      body: {
        userid_count: 1,
        user_id_count: 2,
        accountid_count: 3,
        orderid_count: 4,
        planid_count: 5,
        metrics: [
          { index_name: "userid_count", value: 6 },
          { index_name: "user_id_count", value: 7 },
          { index_name: "accountid_count", value: 8 },
          { index_name: "orderid_count", value: 9 },
          { index_name: "planid_count", value: 10 }
        ]
      }
    });
    expect(observation?.metricObservations ?? []).toEqual([]);
  });

  it("openid/customerid/deviceid/timestamp 及复合变体 fail-closed，经营指标正例仍保留", () => {
    for (const path of ["root.openid_count", "root.open_id_count", "root.customerid_count", "root.customer_id_count", "root.deviceid_count", "root.device_id_count", "root.timestamp_count", "root.time_stamp_count", "root.timeStampCount"]) {
      expect(isMetricFieldPath(path), path).toBe(false);
      expect(isValidMetricObservation({ path, observedAt: "2026-08-06T00:00:00.000Z", value: 1 }), path).toBe(false);
    }
    for (const code of ["openid_count", "open_id_count", "customerid_count", "customer_id_count", "deviceid_count", "device_id_count", "timestamp_count", "time_stamp_count", "timeStampCount"]) {
      expect(isSemanticMetricCode(code), code).toBe(false);
    }
    for (const code of ["room_enter_uv", "gross_roi", "paid_order_count"]) {
      expect(isSemanticMetricCode(code), code).toBe(true);
      expect(isValidMetricObservation({ path: "root.metrics.value", semanticCode: code, observedAt: "2026-08-06T00:00:00.000Z", value: 1 }), code).toBe(true);
    }
    const observation = sanitizeNetworkObservation({ kind: "http", url: "https://api.example.test/metrics", observedAt: "2026-08-06T00:00:00.000Z", body: { metrics: [{ index_name: "room_enter_uv", value: 10 }, { index_name: "gross_roi", value: 1.2 }, { index_name: "paid_order_count", value: 3 }, { index_name: "openid_count", value: 99 }] } });
    expect(observation?.metricObservations?.map((item) => item.semanticCode)).toEqual(["room_enter_uv", "gross_roi", "paid_order_count"]);
  });
});
