import { describe, expect, it } from "vitest";
import {
  liveEventSchema,
  type HistoricalHourRoomAggregate,
  type LiveEvent,
  type LiveWindowAggregate,
  type MvpStateId
} from "@live-growth/contracts";
import {
  assessExecutionState,
  detectDiagnosisEvents,
  diagnoseLiveOperating,
  recentSliceFromQianchuanSnapshots,
  shouldSkipDiagnosisExpression
} from "../src/live-diagnosis-operating";
import { ROLE_SPEECH_EXPECTATIONS } from "../src/live-product-role";

function windowOf(start: string, slotIndex: number, overrides: Partial<{
  gmvDelta: number; spendDelta: number; clicks: number; paid: number;
  impressions: number; watch: number; productImpressions: number; speechFinalCount: number; coverage: "full" | "partial";
}>): LiveWindowAggregate {
  const startMs = Date.parse(start);
  const spend = overrides.spendDelta;
  const gmv = overrides.gmvDelta;
  return {
    schemaVersion: 1, tenantId: "tenant-demo", sessionId: "session-1",
    windowStartAt: start, windowEndAt: new Date(startMs + 15 * 60_000).toISOString(),
    windowMinutes: 15, utcOffsetMinutes: 480, weekday: 5, slotIndex,
    compass: {
      ...(gmv !== undefined ? { sessionPaidGmvFen: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: gmv, min: 0, max: gmv, delta: gmv, resetCount: 0 } } : {}),
      ...(spend !== undefined ? { adSpendFen: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: spend, min: 0, max: spend, delta: spend, resetCount: 0 } } : {})
    },
    qianchuan: {
      ...(overrides.clicks !== undefined ? { productClicks: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: overrides.clicks, min: 0, max: overrides.clicks, delta: overrides.clicks, resetCount: 0 } } : {}),
      ...(overrides.paid !== undefined ? { paidOrderCount: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: overrides.paid, min: 0, max: overrides.paid, delta: overrides.paid, resetCount: 0 } } : {}),
      ...(overrides.impressions !== undefined ? { liveImpressions: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: overrides.impressions, min: 0, max: overrides.impressions, delta: overrides.impressions, resetCount: 0 } } : {}),
      ...(overrides.watch !== undefined ? { liveWatchCount: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: overrides.watch, min: 0, max: overrides.watch, delta: overrides.watch, resetCount: 0 } } : {}),
      ...(overrides.productImpressions !== undefined ? { productImpressions: { semantic: "cumulative", sampleCount: 2, firstAt: start, lastAt: start, first: 0, last: overrides.productImpressions, min: 0, max: overrides.productImpressions, delta: overrides.productImpressions, resetCount: 0 } } : {})
    },
    speech: { finalCount: overrides.speechFinalCount ?? 6, charCount: 80 },
    sampleCounts: { compassSnapshots: 2, qianchuanSnapshots: 2, speechFinals: overrides.speechFinalCount ?? 6 },
    coverage: overrides.coverage ?? "full"
  };
}

const share = (state: MvpStateId, ratio: number): Record<MvpStateId, number> => ({
  S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S6: 0, [state]: ratio
});

const rooms: HistoricalHourRoomAggregate[] = [];

const screenshotSpeech = [
  "product_benefit", "product_efficacy", "ingredient_or_principle", "usage_scenario", "price", "gift"
];

function operate(overrides: Partial<Parameters<typeof diagnoseLiveOperating>[0]> & { current?: LiveWindowAggregate; previous?: LiveWindowAggregate }) {
  const previous = overrides.previous ?? windowOf("2026-08-21T00:00:00.000Z", 32, { spendDelta: 1800, clicks: 1, paid: 0, impressions: 80, watch: 40 });
  const current = overrides.current ?? windowOf("2026-08-21T00:15:00.000Z", 33, { spendDelta: 11300, clicks: 1, paid: 0, impressions: 90, watch: 42 });
  const rest = Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "current" && key !== "previous")) as Omit<typeof overrides, "current" | "previous">;
  return diagnoseLiveOperating({
    sessionId: "session-1",
    current,
    previous,
    rooms,
    stateShare: share("S0", 1),
    speechPresentKeys: screenshotSpeech,
    nowMs: Date.parse(current.windowEndAt),
    dataFreshness: "fresh",
    ...rest
  });
}

describe("diagnoseLiveOperating", () => {
  it("事件触发短窗只使用最后连续千川来源段，切源后样本不足不跨源计算", () => {
    const base = Date.parse("2026-08-21T00:20:00.000Z");
    const snapshots = [
      { observedAt: new Date(base).toISOString(), mappingVersion: "qianchuan-live-v1", sourceEndpoint: "/statQuery", metrics: { adSpend: { value: 10 } } },
      { observedAt: new Date(base + 60_000).toISOString(), mappingVersion: "qianchuan-live-v1", sourceEndpoint: "/statQuery", metrics: { adSpend: { value: 20 } } },
      { observedAt: new Date(base + 120_000).toISOString(), mappingVersion: "qianchuan-official-live-v1", sourceEndpoint: "/room/get", metrics: { adSpend: { value: 100 } } },
      { observedAt: new Date(base + 180_000).toISOString(), mappingVersion: "qianchuan-official-live-v1", sourceEndpoint: "/room/get", metrics: { adSpend: { value: 110 } } }
    ];
    expect(recentSliceFromQianchuanSnapshots(snapshots, base + 180_000)).toBeUndefined();
  });

  it("每个完整15分钟都生成规则分析", () => {
    const diagnosis = operate({
      current: windowOf("2026-08-21T00:15:00.000Z", 33, { spendDelta: 400, clicks: 18, paid: 4, impressions: 200, watch: 80 }),
      previous: windowOf("2026-08-21T00:00:00.000Z", 32, { spendDelta: 400, clicks: 16, paid: 3, impressions: 190, watch: 75 }),
      speechPresentKeys: [...ROLE_SPEECH_EXPECTATIONS.value_bundle],
      productRole: "value_bundle"
    });
    expect(diagnosis.triggerType).toBe("scheduled_15m");
    expect(diagnosis.windowMinutes).toBe(15);
    expect(diagnosis.verdict.text.length).toBeGreaterThan(0);
  });

  it("稳定窗口不打扰、不生成新行动", () => {
    const diagnosis = operate({
      current: windowOf("2026-08-21T00:15:00.000Z", 33, { spendDelta: 400, clicks: 18, paid: 4, impressions: 200, watch: 80 }),
      previous: windowOf("2026-08-21T00:00:00.000Z", 32, { spendDelta: 400, clicks: 16, paid: 3, impressions: 190, watch: 75 }),
      speechPresentKeys: [...ROLE_SPEECH_EXPECTATIONS.value_bundle],
      productRole: "value_bundle"
    });
    expect(diagnosis.interruptDecision).toBe("observe");
    expect(diagnosis.actionKind).toBe("hold");
    expect(diagnosis.action.text).toMatch(/暂不调整|观察|重复/);
  });

  it("特殊事件可在15分钟结束前触发", () => {
    const diagnosis = operate({
      recent: {
        startAt: "2026-08-21T00:22:00.000Z",
        endAt: "2026-08-21T00:27:00.000Z",
        adSpendFen: 6000,
        prevAdSpendFen: 2000,
        impressions: 20,
        prevImpressions: 80,
        watch: 8,
        prevWatch: 40,
        productClicks: 1,
        prevProductClicks: 6
      }
    });
    expect(diagnosis.triggerType).toBe("event_spend_spike");
    expect(diagnosis.windowMinutes).toBe(5);
    expect(Date.parse(diagnosis.windowEndAt)).toBeLessThan(Date.parse("2026-08-21T00:30:00.000Z"));
  });

  it("消耗加快但下游跟上时不打扰", () => {
    expect(detectDiagnosisEvents({
      startAt: "2026-08-21T00:20:00.000Z",
      endAt: "2026-08-21T00:25:00.000Z",
      adSpendFen: 6000,
      prevAdSpendFen: 2000,
      impressions: 300,
      prevImpressions: 100,
      watch: 150,
      prevWatch: 50,
      productClicks: 30,
      prevProductClicks: 10
    })).toBeUndefined();
  });

  it("消耗加快且下游没跟上时触发", () => {
    expect(detectDiagnosisEvents({
      startAt: "2026-08-21T00:20:00.000Z",
      endAt: "2026-08-21T00:25:00.000Z",
      adSpendFen: 6000,
      prevAdSpendFen: 2000,
      impressions: 90,
      prevImpressions: 80,
      watch: 40,
      prevWatch: 38,
      productClicks: 1,
      prevProductClicks: 1
    })).toBe("event_spend_spike");
  });

  it("观看或在线明显下跌触发留存", () => {
    const diagnosis = operate({
      speechPresentKeys: [...ROLE_SPEECH_EXPECTATIONS.trial_acquisition],
      recent: {
        startAt: "2026-08-21T00:20:00.000Z",
        endAt: "2026-08-21T00:25:00.000Z",
        watch: 10,
        prevWatch: 40,
        onlineSnapshot: 4,
        prevOnlineSnapshot: 12
      }
    });
    expect(diagnosis.triggerType).toBe("event_traffic_drop");
    expect(diagnosis.actionKind).toBe("retain");
    expect(diagnosis.interruptDecision).toBe("interrupt");
  });

  it("点击低于样本门槛、支付为0，不判断转化", () => {
    const diagnosis = operate({});
    expect(diagnosis.triggerType).not.toBe("event_click_no_pay");
    expect(`${diagnosis.verdict.text}${diagnosis.evidence[0]!.text}${diagnosis.action.text}`).not.toMatch(/转化差/);
    expect(diagnosis.verdict.text).toMatch(/1/);
    expect(diagnosis.executionState).toBe("incomplete");
    expect(["close_gift", "click_cta", "close_urgency"]).toContain(diagnosis.actionKind);
    expect(diagnosis.action.text).not.toMatch(/暂不调整|先看大屏/);
  });

  it("点击达到门槛、支付未跟上，触发成交承接", () => {
    expect(detectDiagnosisEvents({
      startAt: "2026-08-21T00:20:00.000Z",
      endAt: "2026-08-21T00:25:00.000Z",
      productClicks: 10,
      paidOrders: 0
    })).toBe("event_click_no_pay");
    const diagnosis = operate({
      recent: {
        startAt: "2026-08-21T00:20:00.000Z",
        endAt: "2026-08-21T00:25:00.000Z",
        productClicks: 12,
        paidOrders: 0
      }
    });
    expect(diagnosis.triggerType).toBe("event_click_no_pay");
    expect(["close_gift", "click_cta", "close_urgency"]).toContain(diagnosis.actionKind);
  });

  it("数据源 stale 只出状态、不生成经营动作", () => {
    const diagnosis = operate({ dataFreshness: "stale", compassStatus: "stale" });
    expect(diagnosis.interruptDecision).toBe("status_only");
    expect(diagnosis.actionKind).toBe("hold");
    expect(diagnosis.verdict.text).toMatch(/系统状态|不可用/);
  });

  it("四类商品角色分别产生正确的执行期待", () => {
    for (const role of ["trial_acquisition", "value_bundle", "repeat_purchase", "welfare_item"] as const) {
      const result = assessExecutionState({
        role,
        stageKeys: [],
        presentKeys: [],
        speechFinalCount: 4,
        confounded: false
      });
      expect(result.state).toBe("incomplete");
      expect(result.missingKeys).toEqual(expect.arrayContaining([...ROLE_SPEECH_EXPECTATIONS[role]]));
    }
  });

  it("商品角色 unknown 不生成角色专属话术", () => {
    const diagnosis = operate({ productRole: "unknown" });
    const text = `${diagnosis.verdict.text}${diagnosis.evidence[0]!.text}${diagnosis.action.text}`;
    expect(text).not.toMatch(/复购周期|囤货|福利规则|套组价值/);
  });

  it("同一15分钟切换商品角色时标记 confounded", () => {
    const events: LiveEvent[] = [
      liveEventSchema.parse({
        schemaVersion: 1, eventId: "pc-1", tenantId: "tenant-demo", sessionId: "session-1",
        eventAt: "2026-08-21T00:16:00.000Z", capturedAt: "2026-08-21T00:16:00.000Z", ingestedAt: "2026-08-21T00:16:00.000Z",
        source: "operator", kind: "live.product.context", provisional: false,
        payload: { role: "trial_acquisition", source: "operator" }
      }),
      liveEventSchema.parse({
        schemaVersion: 1, eventId: "pc-2", tenantId: "tenant-demo", sessionId: "session-1",
        eventAt: "2026-08-21T00:20:00.000Z", capturedAt: "2026-08-21T00:20:00.000Z", ingestedAt: "2026-08-21T00:20:00.000Z",
        source: "operator", kind: "live.product.context", provisional: false,
        payload: { role: "value_bundle", source: "operator" }
      })
    ];
    const diagnosis = operate({ events, productRole: "value_bundle" });
    expect(diagnosis.productRoleConfounded).toBe(true);
    expect(diagnosis.executionState).toBe("not_applicable");
  });

  it("执行 incomplete 优先补执行", () => {
    const diagnosis = operate({ productRole: "value_bundle" });
    expect(diagnosis.executionState).toBe("incomplete");
    expect(diagnosis.interruptDecision).toBe("interrupt");
    expect(diagnosis.action.text).toMatch(/保障|小黄车/);
  });

  it("执行 complete 但数据弱时不得重复同一话术", () => {
    const diagnosis = operate({
      speechPresentKeys: [...ROLE_SPEECH_EXPECTATIONS.value_bundle],
      productRole: "value_bundle"
    });
    expect(diagnosis.executionState).toBe("complete");
    expect(diagnosis.action.text).toMatch(/不要机械重复|继续观察/);
    expect(diagnosis.interruptDecision).toBe("observe");
  });

  it("同一问题未解决不新开 issueKey", () => {
    const first = operate({ productRole: "value_bundle" });
    const second = operate({
      productRole: "value_bundle",
      ...(first.issueKey ? { previousIssueKey: first.issueKey } : {})
    });
    expect(second.issueKey).toBe(first.issueKey);
  });

  it("执行后产生3到5分钟观察状态", () => {
    const diagnosis = operate({
      previousResolution: "executed",
      previousResolvedAt: "2026-08-21T00:28:00.000Z",
      nowMs: Date.parse("2026-08-21T00:30:00.000Z"),
      previousActionKind: "close_gift",
      previousIssueKey: "value_bundle:none:incomplete_close",
      productRole: "value_bundle"
    });
    expect(diagnosis.previousActionOutcome).toBe("observing");
    expect(diagnosis.interruptDecision).toBe("observe");
    expect(diagnosis.observationMinutes).toBe(5);
  });

  it("未执行或不适用不评价效果", () => {
    const diagnosis = operate({
      previousResolution: "not_executed",
      previousResolvedAt: "2026-08-21T00:20:00.000Z",
      productRole: "value_bundle"
    });
    expect(diagnosis.previousActionOutcome).toBe("not_evaluated");
  });

  it("不读取未来窗口", () => {
    const future = windowOf("2026-08-21T00:30:00.000Z", 34, { spendDelta: 99999, clicks: 99, paid: 20 });
    const diagnosis = operate({ priorWindows: [future] });
    expect(diagnosis.current.adSpendFen).toBe(11300);
    expect(diagnosis.verdict.text).not.toMatch(/999/);
  });

  it("截图场景：消耗加快但点击不够样本时锁定收口，不判断转化", () => {
    const diagnosis = operate({ productRole: "value_bundle" });
    expect(diagnosis.triggerType).not.toBe("event_click_no_pay");
    expect(diagnosis.executionState).toBe("incomplete");
    expect(diagnosis.interruptDecision).toBe("interrupt");
    expect(["close_gift", "click_cta", "close_urgency"]).toContain(diagnosis.actionKind);
    const text = `${diagnosis.verdict.text}${diagnosis.evidence[0]!.text}${diagnosis.action.text}`;
    expect(text).toMatch(/113/);
    expect(text).toMatch(/1/);
    expect(text).toMatch(/小黄车|保障/);
    expect(text).not.toMatch(/转化差|暂不调整|先看大屏/);
    expect(diagnosis.evidence[0]!.text).toMatch(/卖点|功效|价格|赠品/);
  });

  it("事件和固定诊断只产出一张卡，未解决事件不被固定窗覆盖", () => {
    const both = operate({
      recent: {
        startAt: "2026-08-21T00:22:00.000Z",
        endAt: "2026-08-21T00:27:00.000Z",
        adSpendFen: 6000,
        prevAdSpendFen: 2000,
        impressions: 20,
        prevImpressions: 80,
        watch: 8,
        prevWatch: 40,
        productClicks: 1,
        prevProductClicks: 6
      }
    });
    expect(both.triggerType).toBe("event_spend_spike");
    expect(both.windowMinutes).toBe(5);
    expect(both.actionKind).toBeDefined();

    const protectedEvent = operate({
      productRole: "value_bundle",
      previousIssueKey: "value_bundle:none:event_traffic_drop",
      previousActionKind: "retain"
    });
    expect(protectedEvent.issueKey).toBe("value_bundle:none:event_traffic_drop");
    expect(protectedEvent.actionKind).toBe("retain");
    expect(protectedEvent.triggerType).toBe("scheduled_15m");
    expect(protectedEvent.windowMinutes).toBe(15);
    expect(protectedEvent.interruptDecision).toBe("observe");
  });

  it("商品角色变化时重算 issueKey", () => {
    const first = operate({ productRole: "trial_acquisition" });
    const second = operate({ productRole: "value_bundle" });
    expect(first.issueKey).not.toBe(second.issueKey);
    expect(first.issueKey).toContain("trial_acquisition");
    expect(second.issueKey).toContain("value_bundle");
  });

  it("音频异常只出状态，稳定观察卡不送表达层", () => {
    const audio = operate({ audioStatus: "error" });
    expect(audio.interruptDecision).toBe("status_only");
    expect(shouldSkipDiagnosisExpression(audio)).toBe(true);
    const stable = operate({
      current: windowOf("2026-08-21T00:15:00.000Z", 33, { spendDelta: 400, clicks: 18, paid: 4, impressions: 200, watch: 80 }),
      previous: windowOf("2026-08-21T00:00:00.000Z", 32, { spendDelta: 400, clicks: 16, paid: 3, impressions: 190, watch: 75 }),
      speechPresentKeys: [...ROLE_SPEECH_EXPECTATIONS.value_bundle],
      productRole: "value_bundle"
    });
    expect(shouldSkipDiagnosisExpression(stable)).toBe(true);
  });

  it("执行已完成但数据弱时写出待复核，不重复讲解", () => {
    const diagnosis = operate({
      speechPresentKeys: [...ROLE_SPEECH_EXPECTATIONS.value_bundle],
      productRole: "value_bundle"
    });
    expect(diagnosis.executionState).toBe("complete");
    expect(`${diagnosis.evidence[0]!.text}${diagnosis.pending.map((item) => item.text).join("")}`).toMatch(/待复核/);
    expect(diagnosis.action.text).toMatch(/不要机械重复|继续观察/);
  });

  it("partial 漏斗停更不进入 scheduled_15m 经营 LLM", () => {
    const diagnosis = operate({
      current: windowOf("2026-08-21T00:15:00.000Z", 33, { spendDelta: 400, clicks: 18, paid: 4, impressions: 200, watch: 80 }),
      previous: windowOf("2026-08-21T00:00:00.000Z", 32, { spendDelta: 400, clicks: 16, paid: 3, impressions: 190, watch: 75 }),
      speechPresentKeys: [...ROLE_SPEECH_EXPECTATIONS.value_bundle],
      productRole: "value_bundle",
      groupHealth: [
        { source: "qianchuan", group: "spend", status: "fresh", recoveryAttempts: 0, missingFields: [] },
        { source: "qianchuan", group: "traffic", status: "stalled", recoveryAttempts: 0, missingFields: [] },
        { source: "qianchuan", group: "interest", status: "stalled", recoveryAttempts: 0, missingFields: [] },
        { source: "qianchuan", group: "conversion", status: "stalled", recoveryAttempts: 0, missingFields: [] }
      ]
    });
    expect(diagnosis.interruptDecision).toBe("status_only");
    expect(diagnosis.dataCompleteness).toBe("data_incomplete");
    expect(diagnosis.verdict.text).toBe("本窗数据不完整，暂不做经营判断。");
    expect(diagnosis.evidence[0]!.text).toBe("千川消耗仍在更新，但漏斗／成交数据已经停止。");
    expect(shouldSkipDiagnosisExpression(diagnosis)).toBe(true);
  });

  it("conversion stalled 时不触发 click_no_pay", () => {
    const diagnosis = operate({
      recent: {
        startAt: "2026-08-21T00:22:00.000Z",
        endAt: "2026-08-21T00:27:00.000Z",
        productClicks: 12,
        paidOrders: 0
      },
      groupHealth: [
        { source: "qianchuan", group: "interest", status: "fresh", recoveryAttempts: 0, missingFields: [] },
        { source: "qianchuan", group: "conversion", status: "stalled", recoveryAttempts: 0, missingFields: [] },
        { source: "qianchuan", group: "traffic", status: "fresh", recoveryAttempts: 0, missingFields: [] }
      ]
    });
    expect(diagnosis.triggerType).not.toBe("event_click_no_pay");
    expect(diagnosis.dataCompleteness).toBe("data_incomplete");
  });

  it("traffic stalled 时不触发 traffic_drop", () => {
    const diagnosis = operate({
      recent: {
        startAt: "2026-08-21T00:22:00.000Z",
        endAt: "2026-08-21T00:27:00.000Z",
        watch: 4,
        prevWatch: 20,
        onlineSnapshot: 2,
        prevOnlineSnapshot: 10
      },
      groupHealth: [
        { source: "qianchuan", group: "traffic", status: "stalled", recoveryAttempts: 0, missingFields: [] },
        { source: "qianchuan", group: "interest", status: "fresh", recoveryAttempts: 0, missingFields: [] },
        { source: "qianchuan", group: "conversion", status: "fresh", recoveryAttempts: 0, missingFields: [] }
      ]
    });
    expect(diagnosis.triggerType).not.toBe("event_traffic_drop");
    expect(diagnosis.interruptDecision).toBe("status_only");
  });
});
