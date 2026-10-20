import { describe, expect, it } from "vitest";
import {
  OPERATOR_RULES_POLL_MS,
  activeOperatorPrompts,
  buildOperatorObservationPayload,
  buildOperatorPostRequest,
  buildOperatorSettingsPayload,
  normalizeOperatorRulesView,
  operatorModeLabel,
  operatorPriorityLabel,
  type OperatorPrompt,
  type OperatorRulesView
} from "../app/live/operator-rules-panel";

const evidence = {
  value: 14,
  baseline: 20,
  unit: "%",
  source: "compass.live",
  observedAt: "2026-09-16T10:00:00.000Z",
  samples: 3
};

function prompt(overrides: Partial<OperatorPrompt> = {}): OperatorPrompt {
  return {
    ruleId: "cpm-high",
    title: "CPM 高于本场目标",
    priority: "high",
    state: "triggered",
    owner: "投手",
    actions: ["先核对低消耗与直播间进入，再决定人工追投"],
    fallback: ["复查后仍有问题时，收缩投放预算并保 ROI"],
    hypotheses: ["素材老化", "行业竞争或 A3 人群资产变化"],
    evidence: [evidence],
    missing: [],
    reason: "本场 CPM 高于人工设置目标",
    firstDetectedAt: "2026-09-16T09:40:00.000Z",
    lastReviewedAt: "2026-09-16T10:00:00.000Z",
    nextReviewAt: "2026-09-16T10:10:00.000Z",
    recheckCount: 2,
    ...overrides
  };
}

function view(active: OperatorPrompt[] = [], coverage: OperatorRulesView["coverage"] = []): OperatorRulesView {
  return {
    enabled: true,
    version: "operator-live-v1",
    updatedAt: "2026-09-16T10:00:00.000Z",
    settings: { mode: "regular", retargetMaterials: [], activityPlan: "" },
    active,
    coverage
  };
}

describe("运营实时规则面板的展示边界", () => {
  it("没有问题时不生成待处理卡；数据不足且没有历史触发也不生成动作", () => {
    expect(activeOperatorPrompts(view())).toEqual([]);
    expect(activeOperatorPrompts(view([prompt({ state: "insufficient_data", firstDetectedAt: "", recheckCount: 0 })]))).toEqual([]);
  });

  it("保留已触发但当前数据不足的旧问题，用于 10 分钟复查，不把它当作正常", () => {
    const previous = prompt({ state: "insufficient_data", actions: ["等待数据恢复，10 分钟后复查"], recheckCount: 3 });
    expect(activeOperatorPrompts(view([previous]))).toEqual([previous]);
    expect(activeOperatorPrompts(view([previous]))[0]?.state).toBe("insufficient_data");
  });

  it("覆盖明细保留缺字段，不把字段缺口变成 0 或正常", () => {
    const parsed = normalizeOperatorRulesView({
      ...view([], [{ ...prompt(), state: "insufficient_data", missing: ["CPM 目标"], evidence: [] }]),
      coverage: [{
        ruleId: "cpm-high",
        title: "CPM 高于本场目标",
        priority: "high",
        state: "insufficient_data",
        owner: "投手",
        actions: [],
        fallback: [],
        hypotheses: [],
        evidence: [],
        missing: ["CPM 目标"],
        reason: "尚未设置本场 CPM 目标"
      }]
    });
    expect(parsed?.coverage[0]?.missing).toEqual(["CPM 目标"]);
    expect(parsed?.coverage[0]?.evidence).toEqual([]);
  });
});

describe("运营实时规则面板的保存请求", () => {
  it("保存脉冲场时使用 operator-settings POST，并限制追投候选为两条", () => {
    const settings = buildOperatorSettingsPayload({ mode: "pulse", retargetMaterials: [" 素材 A ", "素材 B", "素材 C"], activityPlan: " 福袋方案 " });
    const request = buildOperatorPostRequest("http://127.0.0.1:4100", "session/1", "/operator-settings", settings);
    expect(request.url).toBe("http://127.0.0.1:4100/api/live/sessions/session%2F1/operator-settings");
    expect(request.init.method).toBe("POST");
    expect(JSON.parse(String(request.init.body))).toEqual({ mode: "pulse", retargetMaterials: ["素材 A", "素材 B"], activityPlan: "福袋方案" });
  });

  it("空的 CPM、新客占比和大单数保持未确认，不被写成 0；明确填写 0 才保留 0", () => {
    const blank = buildOperatorSettingsPayload({ mode: "regular", retargetMaterials: [], activityPlan: "" });
    const observation = buildOperatorObservationPayload({ oldCustomerSharePct: 0 });
    expect(blank).not.toHaveProperty("cpmTargetYuan");
    expect(observation).not.toHaveProperty("newCustomerSharePct");
    expect(observation).not.toHaveProperty("bigOrders30m");
    expect(observation.oldCustomerSharePct).toBe(0);
  });

  it("使用固定 10 秒轮询和优先级文案", () => {
    expect(OPERATOR_RULES_POLL_MS).toBe(10_000);
    expect(operatorModeLabel("pulse")).toBe("脉冲场");
    expect(operatorPriorityLabel("critical")).toBe("最高");
  });
});
