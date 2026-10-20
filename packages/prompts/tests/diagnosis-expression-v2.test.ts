import { describe, expect, it } from "vitest";
import { diagnosisEvidencePacketSchema, diagnosisWindowSchema } from "@live-growth/contracts";
import { DIAGNOSIS_EXPRESSION_V2_PROMPT_VERSION, DIAGNOSIS_EXPRESSION_V2_SYSTEM_PROMPT, buildDiagnosisExpressionV2UserPayload } from "../src/diagnosis-expression-v2";

const finding = {
  id: "what",
  text: "消耗从 18 元到 113 元。当前只有1次商品点击。",
  citedNumbers: [
    { label: "这15分钟消耗", value: 113, unit: "元" },
    { label: "上一刻消耗", value: 18, unit: "元" },
    { label: "商品点击", value: 1, unit: "次" }
  ]
};

const window = diagnosisWindowSchema.parse({
  schemaVersion: 1, sessionId: "session-secret",
  windowStartAt: "2026-08-21T00:15:00.000Z", windowEndAt: "2026-08-21T00:30:00.000Z",
  windowMinutes: 15, weekday: 5, slotIndex: 33,
  hourAlignment: { hour: 8, grain: "hour", note: "整点除以4只作弱参考，小偏离不作为动作。" },
  coverage: "full", provider: "deterministic-template",
  confidence: "leaning", actionKind: "close_gift",
  funnelStage: "spend_spike", streakCount: 1,
  current: { speechFinalCount: 6, adSpendFen: 11300, productClicks: 1, paidOrders: 0 },
  previous: { adSpendFen: 1800 },
  hourBaseline: {
    grain: "hour",
    gmvFen: { status: "sampleInsufficient", grain: "hour", weekday: 5, hour: 8, metricKey: "gmvFen", n: 0, reason: "no_complete_samples" },
    gsvFen: { status: "sampleInsufficient", grain: "hour", weekday: 5, hour: 8, metricKey: "gsvFen", n: 0, reason: "no_complete_samples" },
    adSpendFen: { status: "sampleInsufficient", grain: "hour", weekday: 5, hour: 8, metricKey: "adSpendFen", n: 0, reason: "no_complete_samples" }
  },
  stateShare: { S0: 1, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S6: 0 },
  speechPresentKeys: ["product_benefit", "price", "gift"],
  anomalies: [],
  verdict: finding,
  evidence: [{ id: "why", text: "转写里还缺小黄车指令和保障。", citedNumbers: finding.citedNumbers }],
  action: { id: "action", text: "补齐保障后接小黄车。", citedNumbers: finding.citedNumbers },
  watchNext: { id: "watch", text: "未来5分钟先看商品点击。", citedNumbers: [{ label: "观察分钟", value: 5, unit: "分钟" }] },
  pending: [],
  conclusions: [finding],
  nextWindowSuggestion: { id: "action", text: "补齐保障后接小黄车。", citedNumbers: finding.citedNumbers },
  triggerType: "scheduled_15m",
  executionState: "incomplete",
  interruptDecision: "interrupt",
  productRole: "value_bundle"
});

const packet = diagnosisEvidencePacketSchema.parse({
  triggerType: "scheduled_15m",
  triggerAt: window.windowEndAt,
  windowStartAt: window.windowStartAt,
  windowEndAt: window.windowEndAt,
  dataFreshness: "fresh",
  productContext: { role: "value_bundle", confounded: false },
  funnelStage: "spend_spike",
  executionState: "incomplete",
  confidence: "leaning",
  currentMetrics: { adSpendFen: 11300, productClicks: 1, paidOrders: 0 },
  previousMetrics: { adSpendFen: 1800 },
  historicalBaseline: {},
  speechPresentKeys: window.speechPresentKeys,
  speechMissingKeys: ["guarantee", "product_card_cta"],
  relevantQuotes: ["这款套组性价比高"],
  lockedActionKind: "close_gift",
  interruptDecision: "interrupt",
  unknowns: []
});

describe("diagnosis-expression-v2", () => {
  it("只允许改写四段，并锁定 actionKind", () => {
    const payload = buildDiagnosisExpressionV2UserPayload(packet, window);
    expect(DIAGNOSIS_EXPRESSION_V2_PROMPT_VERSION).toBe("diagnosis-expression-v7");
    expect(DIAGNOSIS_EXPRESSION_V2_SYSTEM_PROMPT).toContain("不得输出 actionKind");
    expect(payload.locked.actionKind).toBe("close_gift");
    expect(payload.template.whatHappened).toContain("113");
    expect(JSON.stringify(payload)).not.toContain("session-secret");
    expect(payload.locked.triggerType).toBe("scheduled_15m");
    expect(payload.locked.interruptDecision).toBe("interrupt");
    expect(DIAGNOSIS_EXPRESSION_V2_SYSTEM_PROMPT).toContain("不得把「转写没出现」写成「主播没讲」");
  });
});
