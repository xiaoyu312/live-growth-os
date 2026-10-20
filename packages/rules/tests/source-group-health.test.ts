import { describe, expect, it } from "vitest";
import type { LiveCompassMetricSnapshot, QianchuanMetricSnapshot, SourceGroupHealth } from "@live-growth/contracts";
import {
  QIANCHUAN_STALE_FLOOR_MS,
  appearancesFromQianchuanSnapshots,
  buildSourceHealthFromSnapshots,
  compatibleSourceStatus,
  evaluateGroupHealth,
  evaluateOverallHealth,
  expectedCadenceMs,
  incompleteDiagnosisCopy,
  stallThresholdMs,
  stalledTriggerGroups
} from "../src/source-group-health";
import { decideSourceRecovery, worstBusinessStatus } from "../src/source-recovery";

const t0 = Date.parse("2026-08-21T08:00:00.000Z");
const iso = (offsetMs: number): string => new Date(t0 + offsetMs).toISOString();

function metric(observedAt: string, keys: string[]): QianchuanMetricSnapshot {
  const value = { value: 1, unit: "元" as const, semantic: "cumulative" as const, sourceField: "stat" };
  return {
    observedAt,
    sourceEndpoint: "/qianchuan/statQuery",
    mappingVersion: "qianchuan-live-v1",
    dataStatus: "fresh",
    metricSource: "qianchuan",
    metrics: Object.fromEntries(keys.map((key) => [key, value]))
  };
}

function group(partial: Partial<SourceGroupHealth> & Pick<SourceGroupHealth, "group" | "status">): SourceGroupHealth {
  return {
    source: "qianchuan",
    recoveryAttempts: 0,
    missingFields: [],
    ...partial
  };
}

function compass(observedAt: string, fields: Partial<LiveCompassMetricSnapshot> = {}): LiveCompassMetricSnapshot {
  return {
    observedAt,
    sourceEndpoint: fields.sourceEndpoint ?? "/compass_api/shop/live/live_screen/core_data",
    mappingVersion: "compass-live-v1",
    dataStatus: "fresh",
    ...fields
  };
}

const establishedCadence = [iso(0), iso(10_000), iso(20_000), iso(30_000)];

describe("source-group-health", () => {
  it("业务值不变但字段持续出现仍为 fresh", () => {
    const appearances = [iso(0), iso(8_000), iso(16_000), iso(24_000)];
    const health = evaluateGroupHealth({
      source: "qianchuan",
      group: "conversion",
      appearanceTimes: appearances,
      nowMs: t0 + 30_000,
      floorMs: QIANCHUAN_STALE_FLOOR_MS
    });
    expect(health.status).toBe("fresh");
    expect(health.lastSeenAt).toBe(iso(24_000));
  });

  it("adSpend 持续更新、traffic／conversion 停更，整体为 partial", () => {
    const snapshots = [
      metric(iso(0), ["adSpend", "liveImpressions", "paidOrderCount", "paidOrderGmv"]),
      metric(iso(10_000), ["adSpend", "liveImpressions", "paidOrderCount", "paidOrderGmv"]),
      metric(iso(20_000), ["adSpend", "liveImpressions", "paidOrderCount", "paidOrderGmv"]),
      metric(iso(30_000), ["adSpend", "liveImpressions", "paidOrderCount", "paidOrderGmv"]),
      metric(iso(200_000), ["adSpend"]),
      metric(iso(208_000), ["adSpend"]),
      metric(iso(216_000), ["adSpend"])
    ];
    const report = buildSourceHealthFromSnapshots({
      qianchuanSnapshots: snapshots,
      compassSnapshots: [],
      nowMs: t0 + 220_000
    });
    expect(report.qianchuan.groups.find((item) => item.group === "spend")?.status).toBe("fresh");
    expect(report.qianchuan.groups.find((item) => item.group === "traffic")?.status).toBe("stalled");
    expect(report.qianchuan.groups.find((item) => item.group === "conversion")?.status).toBe("stalled");
    expect(report.qianchuan.overallHealth).toBe("partial");
    expect(compatibleSourceStatus(report.qianchuan.overallHealth, iso(216_000), t0 + 220_000, QIANCHUAN_STALE_FLOOR_MS)).toBe("partial");
  });

  it("partial 快照不得刷新其他指标组 lastSeenAt", () => {
    const appearances = appearancesFromQianchuanSnapshots([
      metric(iso(0), ["adSpend", "liveImpressions", "paidOrderGmv"]),
      metric(iso(12_000), ["adSpend"])
    ]);
    expect(appearances.spend.at(-1)).toBe(iso(12_000));
    expect(appearances.traffic.at(-1)).toBe(iso(0));
    expect(appearances.conversion.at(-1)).toBe(iso(0));
  });

  it("Compass core 更新、product 已建立节奏后停更，整体为 partial", () => {
    const report = buildSourceHealthFromSnapshots({
      qianchuanSnapshots: [],
      compassSnapshots: [
        compass(iso(0), { sourceEndpoint: "/compass_api/shop/live/live_screen/product_explain_detail", productName: "演示商品 A", productClickCount: 3 }),
        compass(iso(10_000), { sourceEndpoint: "/compass_api/shop/live/live_screen/product_explain_detail", productName: "演示商品 A", productClickCount: 3 }),
        compass(iso(20_000), { sourceEndpoint: "/compass_api/shop/live/live_screen/product_explain_detail", productName: "演示商品 A", productClickCount: 3 }),
        compass(iso(30_000), { sourceEndpoint: "/compass_api/shop/live/live_screen/product_explain_detail", productName: "演示商品 A", productClickCount: 3 }),
        compass(iso(120_000), { onlineSnapshot: 11, sessionPaidGmvFen: 100 })
      ],
      nowMs: t0 + 130_000
    });
    expect(report.compass.groups.find((item) => item.group === "core")?.status).toBe("fresh");
    expect(report.compass.groups.find((item) => item.group === "product")?.status).toBe("stalled");
    expect(report.compass.overallHealth).toBe("partial");
  });

  it("商品组只出现一次、未建立节奏，不判 stalled、整体不标 partial", () => {
    const report = buildSourceHealthFromSnapshots({
      qianchuanSnapshots: [],
      compassSnapshots: [
        compass(iso(0), { sourceEndpoint: "/compass_api/shop/live/live_screen/product_explain_detail", productName: "演示商品 A", productClickCount: 1 }),
        compass(iso(120_000), { onlineSnapshot: 11, sessionPaidGmvFen: 100 })
      ],
      nowMs: t0 + 130_000
    });
    const product = report.compass.groups.find((item) => item.group === "product");
    const core = report.compass.groups.find((item) => item.group === "core");
    expect(core?.status).toBe("fresh");
    expect(product?.status).toBe("unknown");
    expect(report.compass.overallHealth).toBe("fresh");
    expect(worstBusinessStatus([core!.status, product!.status])).toBe("fresh");
    expect(decideSourceRecovery({
      source: "compass",
      worstBusinessStatus: worstBusinessStatus([core!.status, product!.status]),
      allowlistStatus: "allowed",
      debuggerAttached: true,
      userConfirmed: false,
      lockHeld: false,
      attemptCount: 0,
      alreadyReloadedThisEpisode: false,
      swGenerationMatches: true,
      nowMs: t0 + 130_000
    }).action).toBe("none");
  });

  it("visibility=hidden 但接口心跳正常不判卡死", () => {
    const health = evaluateGroupHealth({
      source: "qianchuan",
      group: "spend",
      appearanceTimes: [iso(0), iso(8_000), iso(16_000), iso(24_000)],
      nowMs: t0 + 30_000,
      floorMs: QIANCHUAN_STALE_FLOOR_MS,
      visibilityState: "hidden"
    });
    expect(health.status).toBe("fresh");
  });

  it("hasFocus=false 但接口心跳正常不判卡死", () => {
    const health = evaluateGroupHealth({
      source: "qianchuan",
      group: "spend",
      appearanceTimes: [iso(0), iso(8_000), iso(16_000), iso(24_000)],
      nowMs: t0 + 30_000,
      floorMs: QIANCHUAN_STALE_FLOOR_MS,
      hasFocus: false
    });
    expect(health.status).toBe("fresh");
  });

  it("超过 cadence 进入 suspected_stall，不因一次迟到刷新", () => {
    const cadence = expectedCadenceMs(establishedCadence, QIANCHUAN_STALE_FLOOR_MS);
    expect(cadence).toBe(10_000);
    const threshold = stallThresholdMs(QIANCHUAN_STALE_FLOOR_MS, cadence);
    expect(threshold).toBe(QIANCHUAN_STALE_FLOOR_MS);
    const health = evaluateGroupHealth({
      source: "qianchuan",
      group: "spend",
      appearanceTimes: establishedCadence,
      nowMs: t0 + 30_000 + 91_000,
      floorMs: QIANCHUAN_STALE_FLOOR_MS
    });
    expect(health.status).toBe("suspected_stall");
  });

  it("连续两个周期未恢复进入 stalled", () => {
    const health = evaluateGroupHealth({
      source: "qianchuan",
      group: "traffic",
      appearanceTimes: establishedCadence,
      nowMs: t0 + 30_000 + 181_000,
      floorMs: QIANCHUAN_STALE_FLOOR_MS
    });
    expect(health.status).toBe("stalled");
  });

  it("observer 重建后字段恢复为 recovered", () => {
    const health = evaluateGroupHealth({
      source: "qianchuan",
      group: "traffic",
      appearanceTimes: [iso(0), iso(200_000)],
      nowMs: t0 + 205_000,
      floorMs: QIANCHUAN_STALE_FLOOR_MS,
      previousStatus: "stalled"
    });
    expect(health.status).toBe("recovered");
  });

  it("efficiency 单独停更不得把整体标 partial", () => {
    const overall = evaluateOverallHealth({
      groups: [
        group({ group: "spend", status: "fresh" }),
        group({ group: "traffic", status: "fresh" }),
        group({ group: "interest", status: "fresh" }),
        group({ group: "conversion", status: "fresh" }),
        group({ group: "efficiency", status: "stalled" })
      ],
      diagnosisRequired: ["spend", "traffic", "interest", "conversion"]
    });
    expect(overall).toBe("fresh");
  });

  it("仅 spend 出现且 91 秒未更新：整体不是 partial，兼容 status 可为 stale", () => {
    const report = buildSourceHealthFromSnapshots({
      qianchuanSnapshots: [metric(iso(0), ["adSpend"])],
      compassSnapshots: [],
      nowMs: t0 + 91_000
    });
    expect(report.qianchuan.groups.find((item) => item.group === "spend")?.status).toBe("unknown");
    expect(report.qianchuan.overallHealth).not.toBe("partial");
    expect(report.qianchuan.overallHealth).toBe("unknown");
    expect(compatibleSourceStatus(report.qianchuan.overallHealth, iso(0), t0 + 91_000, QIANCHUAN_STALE_FLOOR_MS)).toBe("stale");
  });

  it("登录失效与网络断开优先", () => {
    expect(evaluateOverallHealth({
      groups: [group({ group: "spend", status: "fresh" })],
      diagnosisRequired: ["spend"],
      loginRequired: true
    })).toBe("login_required");
    expect(evaluateOverallHealth({
      groups: [group({ group: "spend", status: "fresh" })],
      diagnosisRequired: ["spend"],
      offline: true
    })).toBe("offline");
  });

  it("诊断依赖组 stalled 时返回对应文案，不把罗盘商品停更写成千川", () => {
    expect(stalledTriggerGroups("scheduled_15m", [
      group({ group: "traffic", status: "stalled" }),
      group({ group: "interest", status: "fresh" }),
      group({ group: "conversion", status: "stalled" })
    ])).toEqual(["traffic", "conversion"]);
    expect(incompleteDiagnosisCopy(["traffic", "conversion"]).why).toContain("千川消耗仍在更新");
    expect(incompleteDiagnosisCopy(["product"]).why).toContain("商品数据已经停止");
    expect(incompleteDiagnosisCopy(["product"]).why).not.toContain("千川");
  });
});
