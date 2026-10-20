import { describe, expect, it } from "vitest";
import {
  operatorFactsSchema,
  operatorSettingsSchema,
  operatorValueSchema
} from "../../contracts/src/operator-rules";
import {
  OPERATOR_RECHECK_MINUTES,
  OPERATOR_RULE_COUNT,
  OPERATOR_RULE_DEFINITIONS,
  evaluateOperatorRules
} from "../src/operator-live-rules";
import type { OperatorFacts, OperatorSettings } from "../../contracts/src/operator-rules";

const observedAt = "2026-09-16T08:00:00.000Z";

function value(value: number, baseline?: number, unit = "%") {
  return {
    value,
    ...(baseline === undefined ? {} : { baseline }),
    unit,
    source: "test-source",
    observedAt,
    samples: 3
  };
}

const settings: OperatorSettings = {
  mode: "regular",
  retargetMaterials: ["material-a"],
  activityPlan: "已确认活动方案"
};

const baseFacts: OperatorFacts = { elapsedMinutes: 60, mode: "regular" };

function evaluate(overrides: Partial<OperatorFacts>, customSettings: OperatorSettings = settings) {
  return evaluateOperatorRules({ ...baseFacts, ...overrides }, customSettings);
}

function rule(ruleId: (typeof OPERATOR_RULE_DEFINITIONS)[number]["ruleId"], overrides: Partial<OperatorFacts>, customSettings: OperatorSettings = settings) {
  return evaluate(overrides, customSettings).find((item) => item.ruleId === ruleId)!;
}

describe("operator rules contract", () => {
  it("uses UTC observations, positive CPM targets and non-negative metric values", () => {
    expect(operatorValueSchema.safeParse(value(1)).success).toBe(true);
    expect(operatorValueSchema.safeParse({ ...value(1), observedAt: "2026-09-16T16:00:00+08:00" }).success).toBe(false);
    expect(operatorValueSchema.safeParse({ ...value(1), value: -1 }).success).toBe(false);
    expect(operatorValueSchema.safeParse({ ...value(1), baseline: -1 }).success).toBe(false);
    expect(operatorSettingsSchema.safeParse({ ...settings, cpmTargetYuan: 0 }).success).toBe(false);
    expect(operatorSettingsSchema.safeParse({ ...settings, cpmTargetYuan: 10 }).success).toBe(true);
  });

  it("rejects contradictory explicit new/old customer shares", () => {
    expect(operatorFactsSchema.safeParse({
      ...baseFacts,
      observation: { newCustomerSharePct: 70, oldCustomerSharePct: 31 }
    }).success).toBe(false);
    expect(operatorFactsSchema.safeParse({
      ...baseFacts,
      observation: { newCustomerSharePct: 70 }
    }).success).toBe(true);
  });

  it("returns all 17 scenarios, with CTR available only as a GPM handle", () => {
    const result = evaluate({});
    expect(result).toHaveLength(OPERATOR_RULE_COUNT);
    expect(OPERATOR_RULE_DEFINITIONS).toHaveLength(OPERATOR_RULE_COUNT);
    expect(result.some((item) => (item.ruleId as string) === "ctr-low")).toBe(false);
    expect(result.map((item) => item.ruleId)).toEqual(OPERATOR_RULE_DEFINITIONS.map((item) => item.ruleId));
  });
});

describe("operator rules: trigger, counterexample and missing data", () => {
  const triggerCases: Array<{ ruleId: (typeof OPERATOR_RULE_DEFINITIONS)[number]["ruleId"]; facts: Partial<OperatorFacts> }> = [
    { ruleId: "compliance-violation", facts: { observation: { violationActive: true } } },
    { ruleId: "no-output-30m", facts: { orders30m: value(0, undefined, "单"), spendHour: value(200, undefined, "元"), enters5m: value(0, 10, "人") } },
    { ruleId: "low-online", facts: { onlineLow5m: true, spendHour: value(200, undefined, "元"), enters5m: value(0, 10, "人") } },
    { ruleId: "cvr-low", facts: { cvr: value(0.1, 0.2) } },
    { ruleId: "gpm-low", facts: { gpm: value(80, 100, "元"), ctr: value(0.1, 0.2) } },
    { ruleId: "aov-low", facts: { aov: value(300, 500, "元") } },
    { ruleId: "view-rate-low", facts: { exposureEntryRate: value(0.1, 0.2) } },
    { ruleId: "cpm-high", facts: { cpm: value(20, undefined, "元") } },
    { ruleId: "online-spike", facts: { onlineSpike5m: true, spendHour: value(400, undefined, "元"), observation: { botsSuspected: false, newCustomerSharePct: 70, oldCustomerSharePct: 30 } } },
    { ruleId: "big-orders", facts: { observation: { bigOrders30m: 3 } } },
    { ruleId: "new-customer-heavy", facts: { observation: { newCustomerSharePct: 61 } } },
    { ruleId: "old-customer-heavy", facts: { observation: { oldCustomerSharePct: 61 } } },
    { ruleId: "product-exposure-low", facts: { productExposureRate: value(5, 10), observation: { pluginAbnormal: false } } },
    { ruleId: "product-exposure-watch-low", facts: { productExposureWatchRate: value(5, 10) } },
    { ruleId: "short-stay", facts: { staySeconds: value(30, undefined, "秒"), gmvHour: value(0, undefined, "元"), ordersHour: value(0, undefined, "单") } },
    { ruleId: "comment-rate-low", facts: { commentRate: value(0.1, 0.2) } },
    { ruleId: "follow-rate-low", facts: { followRate: value(0.1, 0.2) } }
  ];

  const clearCases: Array<{ ruleId: (typeof OPERATOR_RULE_DEFINITIONS)[number]["ruleId"]; facts: Partial<OperatorFacts> }> = [
    { ruleId: "compliance-violation", facts: { observation: { violationActive: false } } },
    { ruleId: "no-output-30m", facts: { elapsedMinutes: 30, orders30m: value(1, undefined, "单") } },
    { ruleId: "low-online", facts: { onlineLow5m: false } },
    { ruleId: "cvr-low", facts: { cvr: value(0.2, 0.1) } },
    { ruleId: "gpm-low", facts: { gpm: value(100, 100, "元") } },
    { ruleId: "aov-low", facts: { aov: value(500, 300, "元") } },
    { ruleId: "view-rate-low", facts: { exposureEntryRate: value(0.2, 0.1) } },
    { ruleId: "cpm-high", facts: { cpm: value(10, undefined, "元") } },
    { ruleId: "online-spike", facts: { onlineSpike5m: false } },
    { ruleId: "big-orders", facts: { observation: { bigOrders30m: 2 } } },
    { ruleId: "new-customer-heavy", facts: { observation: { newCustomerSharePct: 60 } } },
    { ruleId: "old-customer-heavy", facts: { observation: { oldCustomerSharePct: 60 } } },
    { ruleId: "product-exposure-low", facts: { productExposureRate: value(10, 10) } },
    { ruleId: "product-exposure-watch-low", facts: { productExposureWatchRate: value(10, 10) } },
    { ruleId: "short-stay", facts: { staySeconds: value(60, undefined, "秒"), gmvHour: value(0, undefined, "元"), ordersHour: value(0, undefined, "单") } },
    { ruleId: "comment-rate-low", facts: { commentRate: value(0.2, 0.1) } },
    { ruleId: "follow-rate-low", facts: { followRate: value(0.2, 0.1) } }
  ];

  it.each(triggerCases)("triggers $ruleId only with its explicit condition", ({ ruleId, facts }) => {
    const evaluation = rule(ruleId, facts, ruleId === "cpm-high" ? { ...settings, cpmTargetYuan: 10 } : settings);
    expect(evaluation.state).toBe("triggered");
    expect(evaluation.missing).toEqual([]);
  });

  it.each(clearCases)("keeps $ruleId clear for its counterexample", ({ ruleId, facts }) => {
    const evaluation = rule(ruleId, facts, ruleId === "cpm-high" ? { ...settings, cpmTargetYuan: 10 } : settings);
    expect(evaluation.state).toBe("clear");
  });

  it.each(OPERATOR_RULE_DEFINITIONS)("returns insufficient_data for $ruleId when required facts are absent", ({ ruleId }) => {
    expect(rule(ruleId, {}).state).toBe("insufficient_data");
  });
});

describe("operator rules: confirmed edge conditions", () => {
  it("applies the one-hour gate to low online and no-output routing", () => {
    expect(rule("low-online", { elapsedMinutes: 59, onlineLow5m: true }).state).toBe("insufficient_data");
    expect(rule("no-output-30m", { elapsedMinutes: 59, orders30m: value(0, undefined, "单") }).state).toBe("triggered");
  });

  it("shows a confirmed no-output fact before the one-hour spend split", () => {
    const early = rule("no-output-30m", { elapsedMinutes: 45, orders30m: value(0, undefined, "单") });
    const missingEntry = rule("no-output-30m", {
      elapsedMinutes: 60,
      orders30m: value(0, undefined, "单"),
      spendHour: value(200, undefined, "元")
    });
    expect(early.state).toBe("triggered");
    expect(early.actions.join(" ")).not.toMatch(/追投|重开/);
    expect(missingEntry.state).toBe("triggered");
    expect(missingEntry.actions.join(" ")).toContain("进入");
    expect(missingEntry.actions.join(" ")).toContain("暂不追投");
  });

  it("handles the one-hour low-spend branch of online spikes without adding spend", () => {
    const lowSpend = rule("online-spike", {
      onlineSpike5m: true,
      spendHour: value(200, undefined, "元")
    });
    expect(lowSpend.state).toBe("triggered");
    expect(lowSpend.actions.join(" ")).toMatch(/暂不加投/);
    expect(lowSpend.actions.join(" ")).toMatch(/稳住停留/);
    expect(lowSpend.hypotheses).toContain("自然流量突然增加");
  });

  it("routes low spend by 5-minute entry baseline before suggesting retargeting", () => {
    const stableEntry = rule("low-online", {
      onlineLow5m: true,
      spendHour: value(200, undefined, "元"),
      enters5m: value(10, 10, "人")
    });
    const missingEntry = rule("low-online", {
      onlineLow5m: true,
      spendHour: value(200, undefined, "元")
    });
    expect(stableEntry.state).toBe("triggered");
    expect(stableEntry.actions.join(" ")).toContain("承接");
    expect(stableEntry.actions.join(" ")).toContain("不直接追投");
    expect(missingEntry.state).toBe("insufficient_data");
  });

  it("does not prompt on short stay when either confirmed output condition is met", () => {
    expect(rule("short-stay", {
      staySeconds: value(30, undefined, "秒"), gmvHour: value(1000, undefined, "元"), ordersHour: value(0, undefined, "单")
    }).state).toBe("clear");
    expect(rule("short-stay", {
      staySeconds: value(30, undefined, "秒"), gmvHour: value(0, undefined, "元"), ordersHour: value(3, undefined, "单")
    }).state).toBe("clear");
  });

  it("does not infer a big order from AOV", () => {
    expect(rule("big-orders", { aov: value(1800, 1000, "元") }).state).toBe("insufficient_data");
  });

  it("keeps GPM paths separate by mode and does not turn low AOV into a generic high-price action", () => {
    const pulse = rule("gpm-low", { gpm: value(80, 100, "元") }, { ...settings, mode: "pulse" });
    const regular = rule("gpm-low", { gpm: value(80, 100, "元") }, { ...settings, mode: "regular" });
    const lowAov = rule("aov-low", { aov: value(300, 500, "元") });
    expect(pulse.state).toBe("triggered");
    expect(pulse.actions.join(" ")).toContain("成交密度");
    expect(regular.actions.join(" ")).toMatch(/CTR.*CVR/);
    expect(lowAov.actions.join(" ")).toContain("大套组");
    expect(lowAov.actions.join(" ")).toContain("1v1");
    expect(lowAov.actions.join(" ")).not.toContain("暂停高价");
    expect(pulse.fallback.join(" ")).toMatch(/复查仍低.*成交密度/);
    expect(pulse.fallback.join(" ")).not.toMatch(/提高客单价/);
  });

  it("makes big-order retargeting explicit and requires candidate material first", () => {
    const withCandidate = rule("big-orders", { observation: { bigOrders30m: 3 } });
    const withoutCandidate = rule("big-orders", { observation: { bigOrders30m: 3 } }, { ...settings, retargetMaterials: [] });
    expect(withCandidate.actions.join(" ")).toMatch(/人工追投/);
    expect(withCandidate.fallback.join(" ")).toContain("10 分钟");
    expect(withoutCandidate.actions.join(" ")).toContain("先确认");
  });

  it("does not change ROI or execute an automatic action", () => {
    const cpm = rule("cpm-high", { cpm: value(20, undefined, "元") }, { ...settings, cpmTargetYuan: 10 });
    const lowOnline = rule("low-online", { onlineLow5m: true, spendHour: value(200, undefined, "元"), enters5m: value(0, 10, "人") });
    expect(cpm.actions.join(" ")).not.toMatch(/改 ROI|自动/);
    expect(lowOnline.actions.join(" ")).not.toMatch(/自动/);
    expect(OPERATOR_RECHECK_MINUTES).toBe(10);
  });
});
