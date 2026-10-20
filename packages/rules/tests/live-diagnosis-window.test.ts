import { describe, expect, it } from "vitest";
import {
  HISTORICAL_HOUR_MAPPING_VERSION,
  historicalHourRoomAggregateSchema,
  liveWindowAggregateSchema,
  type HistoricalHourRoomAggregate,
  type LiveWindowAggregate,
  type MvpStateId
} from "@live-growth/contracts";
import { diagnoseLiveWindow, latestCompletedWindow } from "../src/live-diagnosis-window";

function room(localDate: string, hour: number, metrics: HistoricalHourRoomAggregate["metrics"]): HistoricalHourRoomAggregate {
  const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  const windowStartMs = Date.parse(`${localDate}T00:00:00.000Z`) + hour * 3600_000 - 8 * 3600_000;
  return historicalHourRoomAggregateSchema.parse({
    schemaVersion: 1, mappingVersion: HISTORICAL_HOUR_MAPPING_VERSION, source: "csv_import",
    sourceKind: "live-register", rowKind: "room_hour",
    window: {
      localDate, weekday, hour,
      windowLabel: `${String(hour).padStart(2, "0")}:00-${String(hour + 1).padStart(2, "0")}:00`,
      utcOffsetMinutes: 480,
      windowStartAt: new Date(windowStartMs).toISOString(),
      windowEndAt: new Date(windowStartMs + 3600_000).toISOString(),
      grain: "hour"
    },
    sliceCount: 1, anchorNames: ["主播甲"], dataStatus: "complete", metrics
  });
}

function windowOf(start: string, slotIndex: number, overrides: Partial<{
  gmvDelta: number; spendDelta: number; clicks: number; paid: number; resetCount: number;
  impressions: number; watch: number; productImpressions: number;
}>): LiveWindowAggregate {
  const startMs = Date.parse(start);
  const gmv = overrides.gmvDelta;
  const spend = overrides.spendDelta;
  return liveWindowAggregateSchema.parse({
    schemaVersion: 1, tenantId: "tenant-demo", sessionId: "session-1",
    windowStartAt: start, windowEndAt: new Date(startMs + 15 * 60_000).toISOString(),
    windowMinutes: 15, utcOffsetMinutes: 480, weekday: 5, slotIndex,
    compass: {
      ...(gmv !== undefined ? { sessionPaidGmvFen: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: gmv, min: 0, max: gmv, delta: gmv, resetCount: overrides.resetCount ?? 0 } } : {}),
      ...(spend !== undefined ? { adSpendFen: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: spend, min: 0, max: spend, delta: spend, resetCount: 0 } } : {})
    },
    qianchuan: {
      ...(overrides.clicks !== undefined ? { productClicks: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: overrides.clicks, min: 0, max: overrides.clicks, delta: overrides.clicks, resetCount: 0 } } : {}),
      ...(overrides.paid !== undefined ? { paidOrderCount: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: overrides.paid, min: 0, max: overrides.paid, delta: overrides.paid, resetCount: 0 } } : {}),
      ...(overrides.impressions !== undefined ? { liveImpressions: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: overrides.impressions, min: 0, max: overrides.impressions, delta: overrides.impressions, resetCount: 0 } } : {}),
      ...(overrides.watch !== undefined ? { liveWatchCount: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: overrides.watch, min: 0, max: overrides.watch, delta: overrides.watch, resetCount: 0 } } : {}),
      ...(overrides.productImpressions !== undefined ? { productImpressions: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: overrides.productImpressions, min: 0, max: overrides.productImpressions, delta: overrides.productImpressions, resetCount: 0 } } : {})
    },
    speech: { finalCount: 3, charCount: 40 },
    sampleCounts: { compassSnapshots: 2, qianchuanSnapshots: 1, speechFinals: 3 },
    coverage: "full"
  });
}

const share = (state: MvpStateId, ratio: number): Record<MvpStateId, number> => ({
  S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S6: 0, [state]: ratio
});

describe("diagnoseLiveWindow", () => {
  it("小偏离时暂不调整，并带话术证据", () => {
    const rooms = [
      room("2026-07-10", 8, { gmvFen: 4000, gsvFen: 3000, adSpendFen: 800, productClickToPaidRate: 0.2 }),
      room("2026-07-17", 8, { gmvFen: 8000, gsvFen: 6000, adSpendFen: 900, productClickToPaidRate: 0.2 }),
      room("2026-07-24", 8, { gmvFen: 12000, gsvFen: 9000, adSpendFen: 1000, productClickToPaidRate: 0.2 })
    ];
    const previous = windowOf("2026-08-14T00:00:00.000Z", 32, { gmvDelta: 1000, spendDelta: 400 });
    const current = windowOf("2026-08-14T00:15:00.000Z", 33, { gmvDelta: 2500, spendDelta: 400, clicks: 18, paid: 4 });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, previous, rooms, asOfLocalDate: "2026-08-14",
      stateShare: share("S4", 0.7), currentProductName: "演示商品 A", speechPresentKeys: ["price", "product_card_cta"]
    });
    expect(diagnosis.provider).toBe("deterministic-template");
    expect(diagnosis.confidence).toBe("unknown");
    expect(diagnosis.actionKind).toBe("hold");
    expect(diagnosis.hourAlignment.note).toContain("弱参考");
    expect(diagnosis.verdict.text).toContain("没有形成值得打断");
    expect(diagnosis.action.text).toContain("暂不调整");
    expect(diagnosis.evidence.some((item) => item.text.includes("价格") && item.text.includes("点小黄车"))).toBe(true);
    expect(diagnosis.evidence.every((item) => !item.text.includes("不代表没讲"))).toBe(true);
    expect(diagnosis.nextWindowSuggestion.text).toContain("暂不调整");
    for (const item of [diagnosis.verdict, diagnosis.action, ...diagnosis.evidence, diagnosis.watchNext]) {
      expect(item.citedNumbers.length).toBeGreaterThan(0);
      expect(item.text).toMatch(/\d/);
      expect(item.text).not.toMatch(/grain=hour|unknown|S4|product_benefit|n=\d/);
    }
  });

  it("消耗 50 对 58 这种贴线不核投放，0 成交也不强行给动作", () => {
    const rooms = [
      room("2026-07-10", 15, { gmvFen: 141_000, adSpendFen: 23_200 }),
      room("2026-07-17", 15, { gmvFen: 141_000, adSpendFen: 23_200 }),
      room("2026-07-24", 15, { gmvFen: 141_000, adSpendFen: 23_200 })
    ];
    const current = windowOf("2026-08-17T07:00:00.000Z", 60, { gmvDelta: 0, spendDelta: 5_000, clicks: 5, paid: 0 });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, rooms, asOfLocalDate: "2026-08-17",
      stateShare: share("S0", 1), speechPresentKeys: ["purchase_cta"]
    });
    expect(diagnosis.confidence).toBe("unknown");
    expect(diagnosis.actionKind).toBe("hold");
    expect(diagnosis.action.text).toContain("暂不调整");
    expect(diagnosis.action.text).not.toContain("核对投放");
    expect(diagnosis.verdict.text).not.toMatch(/往大约.*元靠/);
    expect(diagnosis.pending.some((item) => item.text.includes("点击还少"))).toBe(true);
    expect(diagnosis.evidence.some((item) => item.text.includes("催下单"))).toBe(true);
  });

  it("累计数字回退只影响增量算法，不写进诊断卡", () => {
    const current = windowOf("2026-08-14T00:15:00.000Z", 33, { gmvDelta: 100, resetCount: 8 });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, rooms: [], stateShare: share("S0", 1)
    });
    expect(diagnosis.anomalies.some((item) => item.type === "counter_reset")).toBe(false);
    for (const item of [diagnosis.verdict, diagnosis.action, ...diagnosis.evidence, ...diagnosis.anomalies]) {
      expect(item.text).not.toMatch(/回退|非负|累计口径/);
    }
  });

  it("投放突变写入异常，结论改看漏斗有没有跟上，不再只问是不是加量", () => {
    const current = windowOf("2026-08-14T00:15:00.000Z", 33, { spendDelta: 900, gmvDelta: 100 });
    const previous = windowOf("2026-08-14T00:00:00.000Z", 32, { spendDelta: 200, gmvDelta: 80 });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, previous, rooms: [], stateShare: share("S0", 1)
    });
    expect(diagnosis.anomalies[0]?.type).toBe("ad_spend_spike");
    expect(diagnosis.funnelStage).toBe("spend_spike");
    expect(diagnosis.actionKind).toBe("hold");
    expect(diagnosis.verdict.text).toContain("消耗从");
    expect(diagnosis.verdict.text).toContain("还对不上");
    expect(diagnosis.verdict.text).not.toContain("先看是不是加量了");
    expect(diagnosis.watchNext.text).toContain("跟上消耗");
  });

  it("消耗加快但曝光相对上一刻塌掉时，结论停在流量质量", () => {
    const current = windowOf("2026-08-14T00:15:00.000Z", 33, {
      spendDelta: 16_000, gmvDelta: 100, impressions: 400, watch: 80, clicks: 20
    });
    const previous = windowOf("2026-08-14T00:00:00.000Z", 32, {
      spendDelta: 10_000, gmvDelta: 80, impressions: 1000, watch: 80, clicks: 20
    });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, previous, rooms: [], stateShare: share("S0", 1)
    });
    expect(diagnosis.funnelStage).toBe("exposure");
    expect(diagnosis.actionKind).toBe("traffic_quality");
    expect(diagnosis.verdict.text).toContain("没跟上加量");
    expect(diagnosis.verdict.text).toContain("400");
    expect(diagnosis.action.text).toContain("流量质量");
  });

  it("消耗加快、曝光没涨且点击够、还没成单时，强化逼单而不是看流量质量", () => {
    const current = windowOf("2026-08-14T00:15:00.000Z", 33, {
      spendDelta: 8_300, gmvDelta: 0, impressions: 1_331, watch: 400, clicks: 23, paid: 0
    });
    const previous = windowOf("2026-08-14T00:00:00.000Z", 32, {
      spendDelta: 5_500, gmvDelta: 80, impressions: 1_355, watch: 380, clicks: 16, paid: 4
    });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, previous, rooms: [], stateShare: share("S0", 1),
      speechPresentKeys: ["product_benefit", "price", "after_sale", "product_card_cta"]
    });
    expect(diagnosis.funnelStage).toBe("convert");
    expect(diagnosis.actionKind).toBe("close_urgency");
    expect(diagnosis.verdict.text).toContain("更可能更准");
    expect(diagnosis.verdict.text).not.toContain("流量质量");
    expect(diagnosis.action.text).toContain("逼单");
    expect(diagnosis.action.text).toContain("23");
    expect(diagnosis.watchNext.text).toContain("机制");
  });

  it("n<3 时写明导入历史场次数，不说全年没播过", () => {
    const rooms = [
      room("2026-07-10", 8, { gmvFen: 4000, adSpendFen: 800 }),
      room("2026-07-17", 8, { gmvFen: 5000, adSpendFen: 900 })
    ];
    const current = windowOf("2026-08-17T00:15:00.000Z", 33, { gmvDelta: 6900, spendDelta: 400, clicks: 5, paid: 0 });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, rooms, asOfLocalDate: "2026-08-17",
      stateShare: share("S0", 1)
    });
    expect(diagnosis.pending.some((item) => item.id === "pending-baseline" && item.text.includes("只有 2 场") && item.text.includes("不是全年没播过"))).toBe(true);
    expect(diagnosis.pending.every((item) => !item.text.includes("平时这档历史场次不够"))).toBe(true);
  });

  it("未完成的当前窗不作为诊断卡", () => {
    const first = windowOf("2026-08-14T00:00:00.000Z", 32, { gmvDelta: 100 });
    const second = windowOf("2026-08-14T00:15:00.000Z", 33, { gmvDelta: 200 });
    expect(latestCompletedWindow([first, second], Date.parse("2026-08-14T00:10:00.000Z"))).toBeUndefined();
    expect(latestCompletedWindow([first, second], Date.parse("2026-08-14T00:15:00.000Z"))?.current.windowStartAt).toBe(first.windowStartAt);
  });

  it("点击够、还没成交且已在催单时，动作改补赠品保障售后", () => {
    const rooms = [
      room("2026-07-10", 14, { gmvFen: 97_400, adSpendFen: 8_000, roomImpressionUv: 4000, roomEnterUv: 800, productImpressionUv: 600, productClickRate: 0.2, productClickToPaidRate: 0.16 }),
      room("2026-07-17", 14, { gmvFen: 97_400, adSpendFen: 8_000, roomImpressionUv: 4000, roomEnterUv: 800, productImpressionUv: 600, productClickRate: 0.2, productClickToPaidRate: 0.16 }),
      room("2026-07-24", 14, { gmvFen: 97_400, adSpendFen: 8_000, roomImpressionUv: 4000, roomEnterUv: 800, productImpressionUv: 600, productClickRate: 0.2, productClickToPaidRate: 0.16 })
    ];
    const current = windowOf("2026-08-17T06:00:00.000Z", 56, {
      gmvDelta: 0, spendDelta: 2_000, clicks: 20, paid: 0, productImpressions: 100, impressions: 400, watch: 80
    });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, rooms, asOfLocalDate: "2026-08-17",
      stateShare: share("S0", 1), speechPresentKeys: ["purchase_cta", "urgency"]
    });
    expect(diagnosis.confidence).toBe("confirmed");
    expect(diagnosis.actionKind).toBe("close_gift");
    expect(diagnosis.action.text).toContain("催单已经有了");
    expect(diagnosis.action.text).toContain("赠品");
    expect(diagnosis.action.text).toContain("20");
    expect(diagnosis.action.text).not.toMatch(/往大约.*元靠/);
    expect(diagnosis.verdict.text).toContain("还没变成单");
    expect(diagnosis.evidence.some((item) => item.text.includes("催下单") && item.text.includes("赠品"))).toBe(true);
  });

  it("消耗明显偏低时下一刻先核对投放，不改话术", () => {
    const rooms = [
      room("2026-07-10", 8, { gmvFen: 8_000, adSpendFen: 4_000 }),
      room("2026-07-17", 8, { gmvFen: 8_000, adSpendFen: 4_000 }),
      room("2026-07-24", 8, { gmvFen: 8_000, adSpendFen: 4_000 })
    ];
    const current = windowOf("2026-08-14T00:15:00.000Z", 33, { gmvDelta: 0, spendDelta: 200 });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, rooms, asOfLocalDate: "2026-08-14",
      stateShare: share("S0", 1)
    });
    expect(diagnosis.actionKind).toBe("check_spend");
    expect(diagnosis.action.text).toContain("核对投放");
    expect(diagnosis.action.text).toContain("先确认在跑");
    expect(diagnosis.confidence).toBe("leaning");
  });

  it("连续三个15分钟消耗起不来时升级措辞，不断播", () => {
    const rooms = [
      room("2026-07-10", 8, { gmvFen: 8_000, adSpendFen: 4_000 }),
      room("2026-07-17", 8, { gmvFen: 8_000, adSpendFen: 4_000 }),
      room("2026-07-24", 8, { gmvFen: 8_000, adSpendFen: 4_000 })
    ];
    const first = windowOf("2026-08-14T00:00:00.000Z", 32, { gmvDelta: 0, spendDelta: 200 });
    const second = windowOf("2026-08-14T00:15:00.000Z", 33, { gmvDelta: 0, spendDelta: 200 });
    const current = windowOf("2026-08-14T00:30:00.000Z", 34, { gmvDelta: 0, spendDelta: 200 });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, previous: second, priorWindows: [first, second],
      rooms, asOfLocalDate: "2026-08-14", stateShare: share("S0", 1)
    });
    expect(diagnosis.streakCount).toBe(3);
    expect(diagnosis.funnelStage).toBe("spend");
    expect(diagnosis.actionKind).toBe("check_spend");
    expect(diagnosis.verdict.text).toContain("连续3个15分钟");
    expect(diagnosis.verdict.text).toContain("消耗起不来");
    expect(diagnosis.action.text).toContain("核对投放");
    expect(diagnosis.action.text).not.toContain("断播");
    expect(diagnosis.pending.some((item) => item.text.includes("断播会重置推荐"))).toBe(true);
  });

  it("商品点击率只对照上一刻次数，不把历史人数率写成平时", () => {
    const rooms = [
      room("2026-07-10", 15, { productClickRate: 0.241, productImpressionUv: 87, productClickUv: 21, roomEnterPv: 400, roomImpressionPv: 4_000, gmvFen: 8_000, adSpendFen: 2_000 }),
      room("2026-07-17", 15, { productClickRate: 0.241, productImpressionUv: 87, productClickUv: 21, roomEnterPv: 400, roomImpressionPv: 4_000, gmvFen: 8_000, adSpendFen: 2_000 }),
      room("2026-07-24", 15, { productClickRate: 0.241, productImpressionUv: 87, productClickUv: 21, roomEnterPv: 400, roomImpressionPv: 4_000, gmvFen: 8_000, adSpendFen: 2_000 })
    ];
    const previous = windowOf("2026-08-14T07:00:00.000Z", 60, {
      spendDelta: 2_000, clicks: 20, productImpressions: 100, impressions: 400, watch: 80
    });
    const current = windowOf("2026-08-14T07:15:00.000Z", 61, {
      spendDelta: 2_000, clicks: 3, productImpressions: 115, impressions: 400, watch: 80
    });
    const diagnosis = diagnoseLiveWindow({
      sessionId: "session-1", current, previous, rooms, asOfLocalDate: "2026-08-14",
      stateShare: share("S0", 1)
    });
    expect(diagnosis.funnelStage).toBe("click");
    expect(diagnosis.verdict.text).toContain("上一刻");
    expect(diagnosis.verdict.text).toContain("2.6");
    expect(diagnosis.verdict.text).not.toContain("24.1");
    expect(diagnosis.verdict.text).not.toMatch(/平时15点/);
  });
});
