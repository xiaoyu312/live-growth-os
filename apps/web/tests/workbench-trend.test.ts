import { describe, expect, it } from "vitest";
import { buildWorkbenchTrendModel, type WorkbenchTrendSnapshot } from "../app/live/workbench-trend";

const nowMs = Date.parse("2026-09-16T10:15:00.000Z");

function snapshot(offsetSeconds: number, gmv: number | undefined, spend: number | undefined, overrides: Partial<WorkbenchTrendSnapshot> = {}): WorkbenchTrendSnapshot {
  return {
    observedAt: new Date(nowMs - offsetSeconds * 1000).toISOString(),
    dataStatus: "fresh",
    roomId: "room-a",
    sourceEndpoint: "qianchuan/live",
    mappingVersion: "qianchuan-v1",
    metrics: {
      ...(gmv === undefined ? {} : { paidOrderGmv: { value: gmv, unit: "元", semantic: "cumulative", sourceField: "paid_gmv" } }),
      ...(spend === undefined ? {} : { adSpend: { value: spend, unit: "元", semantic: "cumulative", sourceField: "spend" } })
    },
    ...overrides
  };
}

describe("WorkbenchTrend 纯计算模型", () => {
  it("只用同源累计快照间的 45–90 秒增量", () => {
    const model = buildWorkbenchTrendModel([
      snapshot(180, 100, 20),
      snapshot(120, 125, 24),
      snapshot(60, 125, 25),
      snapshot(0, 140, 30)
    ], nowMs);
    expect(model.status).toBe("ready");
    expect(model.points.map((point) => [point.gmvYuan, point.spendYuan])).toEqual([[25, 4], [0, 1], [15, 5]]);
  });

  it("房间切换不跨房间相减", () => {
    const model = buildWorkbenchTrendModel([
      snapshot(120, 100, 20),
      snapshot(60, 125, 25, { roomId: "room-b" }),
      snapshot(0, 140, 30, { roomId: "room-b" })
    ], nowMs);
    expect(model.points[0]).toMatchObject({ observedAt: new Date(nowMs).toISOString(), observedAtMs: nowMs, gmvYuan: 15, spendYuan: 5 });
  });

  it("累计计数回退会断开边界，不伪造零增长", () => {
    const model = buildWorkbenchTrendModel([
      snapshot(180, 100, 20),
      snapshot(120, 80, 19),
      snapshot(60, 90, 22),
      snapshot(0, 105, 25)
    ], nowMs);
    expect(model.points).toHaveLength(1);
    expect(model.points[0]?.gmvYuan).toBe(15);
    expect(model.points[0]?.spendYuan).toBe(3);
  });

  it("稀疏、未来和非人民币口径不生成有效点", () => {
    const model = buildWorkbenchTrendModel([
      snapshot(240, 100, 20),
      snapshot(120, 125, 24),
      snapshot(-60, 150, 30),
      snapshot(60, 130, 26, { metrics: { paidOrderGmv: { value: 130, unit: "分", semantic: "cumulative", sourceField: "paid_gmv" }, adSpend: { value: 26, unit: "元", semantic: "cumulative", sourceField: "spend" } } })
    ], nowMs);
    expect(model.points).toEqual([]);
    expect(model.status).toBe("stopped");
  });

  it("零增量保留零柱，不设置最小假高度", () => {
    const model = buildWorkbenchTrendModel([snapshot(60, 100, 20), snapshot(0, 100, 20)], nowMs);
    expect(model.status).toBe("ready");
    expect(model.points[0]).toMatchObject({ observedAt: new Date(nowMs).toISOString(), observedAtMs: nowMs, gmvYuan: 0, spendYuan: 0 });
  });

  it("最新字段超过 90 秒标为停更，但保留历史点且不宣称实时", () => {
    const model = buildWorkbenchTrendModel([snapshot(180, 100, 20), snapshot(120, 110, 22), snapshot(100, 120, 24)], nowMs);
    expect(model.status).toBe("stopped");
    expect(model.reason).toBe("stopped_over_90_seconds");
    expect(model.points.length).toBeGreaterThan(0);
    expect(model.staleMetricKeys).toEqual(["paidOrderGmv", "adSpend"]);
  });

  it("最新换房间只有一个快照时不显示旧房间走势", () => {
    const model = buildWorkbenchTrendModel([
      snapshot(180, 100, 20),
      snapshot(120, 110, 22),
      snapshot(60, 120, 24),
      snapshot(0, undefined, undefined, { roomId: "room-b", metrics: { roi: { value: 2, unit: "", semantic: "rate", sourceField: "roi" } } })
    ], nowMs);
    expect(model.points).toEqual([]);
    expect(model.status).toBe("empty");
  });

  it("同一来源 A→B→A 会从最后一段重新起算，不桥接旧 A", () => {
    const model = buildWorkbenchTrendModel([
      snapshot(180, 100, 20),
      snapshot(120, 110, 22),
      snapshot(60, undefined, undefined, { roomId: "room-b", metrics: { roi: { value: 2, unit: "", semantic: "rate", sourceField: "roi" } } }),
      snapshot(0, 120, 24)
    ], nowMs);
    expect(model.points).toEqual([]);
  });

  it("同一时间的矛盾重复快照不参与下一段差分", () => {
    const model = buildWorkbenchTrendModel([
      snapshot(120, 100, 20),
      snapshot(60, 110, 22),
      snapshot(30, 115, 23),
      snapshot(30, 120, 24),
      snapshot(0, 130, 26)
    ], nowMs);
    expect(model.points).toHaveLength(1);
    expect(model.points[0]?.gmvYuan).toBe(10);
    expect(model.points[0]?.spendYuan).toBe(2);
  });
});


it("non-fresh snapshots never become deltas or a current source", () => {
  for (const dataStatus of ["stale", "offline", "unknown", undefined]) {
    const latest = snapshot(0, 200, 60, { roomId: "room-b" });
    if (dataStatus === undefined) delete latest.dataStatus; else latest.dataStatus = dataStatus;
    const model = buildWorkbenchTrendModel([snapshot(120, 100, 20), snapshot(60, 110, 22), latest], nowMs);
    expect(model.status).toBe("stopped");
    expect(model.points.map(point => point.gmvYuan)).toEqual([10]);
  }
});

it("excludes deltas starting outside the fifteen-minute window", () => {
  const model = buildWorkbenchTrendModel([snapshot(930, 100, 20), snapshot(870, 150, 25), snapshot(810, 160, 26)], nowMs);
  expect(model.points.map(point => point.gmvYuan)).toEqual([10]);
});
