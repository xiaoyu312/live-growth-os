import { describe, expect, it } from "vitest";
import type { LiveCompassMetricSnapshot, QianchuanMetricSnapshot } from "@live-growth/contracts";
import { LivePointMapper, UNKNOWN_PRODUCT_ID, positiveDeltaInWindow } from "../src/live-point-mapper";
import { LiveStateEngine } from "../src/live-state-engine";

function compass(observedAt: string, fields: Partial<LiveCompassMetricSnapshot>): LiveCompassMetricSnapshot {
  return { observedAt, sourceEndpoint: "/compass_api/shop/live/live_screen/core_data", mappingVersion: "compass-live-v1", dataStatus: "fresh", ...fields };
}

function qianchuan(observedAt: string, adSpendYuan?: number, roi?: number): QianchuanMetricSnapshot {
  return {
    observedAt, sourceEndpoint: "/ad/api/data/v1/common/statQuery", mappingVersion: "qianchuan-live-v1", dataStatus: "fresh", metricSource: "qianchuan",
    metrics: {
      ...(adSpendYuan !== undefined ? { adSpend: { value: adSpendYuan, unit: "元" as const, semantic: "cumulative" as const, sourceField: "stat_cost_for_roi2" } } : {}),
      ...(roi !== undefined ? { roi: { value: roi, unit: "unknown" as const, semantic: "rate" as const, sourceField: "total_prepay_and_pay_settle_realtime_roi2_1h" } } : {})
    }
  };
}

const T0 = Date.parse("2026-08-14T02:00:00.000Z");
const at = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

describe("positiveDeltaInWindow", () => {
  it("以窗口前最后样本为基准，回退不产生负增量，区分无数据与增量为 0", () => {
    const series = [
      { atMs: T0, value: 100 },
      { atMs: T0 + 60_000, value: 130 },
      { atMs: T0 + 120_000, value: 20 },
      { atMs: T0 + 180_000, value: 50 }
    ];
    expect(positiveDeltaInWindow(series, T0, T0 + 180_000)).toBe(60);
    expect(positiveDeltaInWindow(series, T0 + 180_000, T0 + 240_000)).toBe(0);
    expect(positiveDeltaInWindow([], T0, T0 + 60_000)).toBeUndefined();
  });
});

describe("LivePointMapper", () => {
  it("没有罗盘快照时返回 null，不构造假数据点", () => {
    const mapper = new LivePointMapper();
    expect(mapper.pointAt(at(0))).toBeNull();
    mapper.observeQianchuan(qianchuan(at(0), 100, 2));
    expect(mapper.pointAt(at(10))).toBeNull();
  });

  it("核心房间信号不全时 dataComplete=false，缺失内部占位不当真值", () => {
    const mapper = new LivePointMapper();
    mapper.observeCompass(compass(at(0), { productClickCount: 12, productPayGmvFen: 0 }));
    const point = mapper.pointAt(at(5))!;
    expect(point.dataComplete).toBe(false);
    expect(point.currentProductId).toBe(UNKNOWN_PRODUCT_ID);
  });

  it("核心信号齐备时 enters1m、retentionProxy、5 分钟增量正确换算", () => {
    const mapper = new LivePointMapper();
    mapper.observeCompass(compass(at(0), { onlineSnapshot: 60, roomEnterCount5m: 50, averageWatchDurationSec: 45, paidBuyerCount: 10, adSpendFen: 30_000, currentProductName: "演示商品 A", productClickCount: 20, unpaidOrderCount: 3, productPayGmvFen: 100_000 }));
    mapper.observeCompass(compass(at(240), { onlineSnapshot: 66, roomEnterCount5m: 55, averageWatchDurationSec: 54, paidBuyerCount: 14, adSpendFen: 42_000, currentProductName: "演示商品 A", productClickCount: 25, unpaidOrderCount: 5, productPayGmvFen: 160_000 }));
    const point = mapper.pointAt(at(240))!;
    expect(point.dataComplete).toBe(true);
    expect(point.online).toBe(66);
    expect(point.enters1m).toBe(11);
    expect(point.retentionProxy).toBeCloseTo(0.6);
    expect(point.currentProductId).toBe("演示商品 A");
    expect(point.products[0]).toMatchObject({ exposure5m: 55, clicks5m: 25, unpaid5m: 2, paidBuyers5m: 4, gmvFen5m: 60_000 });
    expect(point.traffic.spendFen5m).toBe(12_000);
  });

  it("切品后商品维度序列按当前商品过滤，不混入旧品增量", () => {
    const mapper = new LivePointMapper();
    mapper.observeCompass(compass(at(0), { onlineSnapshot: 50, roomEnterCount5m: 40, averageWatchDurationSec: 50, currentProductName: "旧品", productPayGmvFen: 500_000, unpaidOrderCount: 8 }));
    mapper.observeCompass(compass(at(120), { onlineSnapshot: 52, roomEnterCount5m: 42, averageWatchDurationSec: 51, currentProductName: "新品", productPayGmvFen: 10_000, unpaidOrderCount: 1 }));
    mapper.observeCompass(compass(at(240), { onlineSnapshot: 55, roomEnterCount5m: 45, averageWatchDurationSec: 52, currentProductName: "新品", productPayGmvFen: 30_000, unpaidOrderCount: 2 }));
    const point = mapper.pointAt(at(240))!;
    expect(point.currentProductId).toBe("新品");
    expect(point.products[0]!.gmvFen5m).toBe(20_000);
    expect(point.products[0]!.unpaid5m).toBe(1);
  });

  it("罗盘无消耗时回退千川消耗（元转分），ROI 取千川最新值", () => {
    const mapper = new LivePointMapper();
    mapper.observeCompass(compass(at(0), { onlineSnapshot: 30, roomEnterCount5m: 20, averageWatchDurationSec: 40 }));
    mapper.observeQianchuan(qianchuan(at(10), 100, 2.4));
    mapper.observeQianchuan(qianchuan(at(200), 130.5, 2.8));
    const point = mapper.pointAt(at(200))!;
    expect(point.traffic.spendFen5m).toBe(3_050);
    expect(point.traffic.roi).toBe(2.8);
  });

  it("话术覆盖只输出 present/unknown，从不输出 absent", () => {
    const mapper = new LivePointMapper();
    mapper.observeCompass(compass(at(0), { onlineSnapshot: 30, roomEnterCount5m: 20, averageWatchDurationSec: 40 }));
    mapper.observeSpeech(at(60), "今天到手价只要79元，点击下方小黄车直接下单");
    const point = mapper.pointAt(at(90))!;
    expect(point.speechCoverage["price"]).toBe("present");
    expect(point.speechCoverage["product_card_cta"]).toBe("present");
    expect(point.speechCoverage["purchase_cta"]).toBe("present");
    expect(Object.values(point.speechCoverage)).not.toContain("absent");
    expect(point.speechEvidence).toHaveLength(1);
    const later = mapper.pointAt(at(400))!;
    expect(later.speechCoverage["price"]).toBe("unknown");
  });

  it("同一输入序列两次映射结果完全一致（确定性）", () => {
    const build = () => {
      const mapper = new LivePointMapper();
      mapper.observeCompass(compass(at(0), { onlineSnapshot: 40, roomEnterCount5m: 30, averageWatchDurationSec: 60, paidBuyerCount: 2 }));
      mapper.observeSpeech(at(30), "价格机制话术");
      mapper.observeQianchuan(qianchuan(at(60), 50, 3));
      return mapper.pointAt(at(90));
    };
    expect(build()).toEqual(build());
  });

  it("端到端：真实形态快照序列可驱动引擎确认 S4 并产出行动", () => {
    const mapper = new LivePointMapper();
    const engine = new LiveStateEngine([]);
    let action: import("@live-growth/contracts").MvpAction | null = null;
    for (let step = 0; step <= 7; step += 1) {
      const time = at(step * 60);
      mapper.observeCompass(compass(time, {
        onlineSnapshot: 60, roomEnterCount5m: 50, averageWatchDurationSec: 60,
        paidBuyerCount: 2, currentProductName: "演示商品 A", productClickCount: 20, productPayGmvFen: 0
      }));
      const point = mapper.pointAt(time);
      expect(point).not.toBeNull();
      const result = engine.process(point!);
      if (result.action) action = result.action;
    }
    expect(action).not.toBeNull();
    expect(action!.state).toBe("S4");
  });
});
