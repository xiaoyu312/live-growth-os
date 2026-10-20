import { describe, expect, it } from "vitest";
import { diagnosisWindowSchema } from "@live-growth/contracts";
import {
  DIAGNOSIS_EXPRESSION_PROMPT_VERSION,
  DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT,
  buildDiagnosisExpressionUserPayload,
  diagnosisExpressionInputSummary
} from "../src/diagnosis-expression-v1";

const finding = { id: "verdict", text: "这15分钟没有形成值得打断的问题。点了 5 次，成交 0 单。", citedNumbers: [{ label: "商品点击", value: 5, unit: "次" }, { label: "支付订单", value: 0, unit: "单" }] };
const speech = { id: "speech-coverage", text: "这15分钟转写里有价格。没有赠品、保障、售后。", citedNumbers: [{ label: "听清的要点", value: 1, unit: "个" }, { label: "完整句子", value: 2, unit: "条" }] };
const action = { id: "action", text: "暂不调整，保持现在的讲解节奏。这15分钟还没有形成值得打断的问题。", citedNumbers: [{ label: "窗口分钟", value: 15, unit: "分钟" }] };
const watch = { id: "watch", text: "下个15分钟先看点击还在不在累计。", citedNumbers: [{ label: "窗口分钟", value: 15, unit: "分钟" }] };
const window = diagnosisWindowSchema.parse({
  schemaVersion: 1, sessionId: "session-secret",
  windowStartAt: "2026-08-14T00:00:00.000Z", windowEndAt: "2026-08-14T00:15:00.000Z",
  windowMinutes: 15, weekday: 5, slotIndex: 32,
  hourAlignment: { hour: 8, grain: "hour", note: "整点除以4只作弱参考，小偏离不作为动作。" },
  coverage: "full", provider: "deterministic-template",
  confidence: "unknown", actionKind: "hold",
  funnelStage: "maintain", streakCount: 1,
  current: { speechFinalCount: 2, gmvFen: 1200 },
  previous: null,
  hourBaseline: {
    grain: "hour",
    gmvFen: { status: "sampleInsufficient", grain: "hour", weekday: 5, hour: 8, metricKey: "gmvFen", n: 0, reason: "no_complete_samples" },
    gsvFen: { status: "sampleInsufficient", grain: "hour", weekday: 5, hour: 8, metricKey: "gsvFen", n: 0, reason: "no_complete_samples" },
    adSpendFen: { status: "sampleInsufficient", grain: "hour", weekday: 5, hour: 8, metricKey: "adSpendFen", n: 0, reason: "no_complete_samples" }
  },
  stateShare: { S0: 1, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S6: 0 },
  speechPresentKeys: ["product_efficacy", "price"],
  anomalies: [],
  verdict: finding,
  evidence: [speech],
  action,
  watchNext: watch,
  pending: [],
  conclusions: [finding, speech],
  nextWindowSuggestion: action
});

describe("diagnosis-expression-v1", () => {
  it("用户包只含结论与数字，不含场次号、状态码或原始话术", () => {
    const payload = buildDiagnosisExpressionUserPayload(window);
    const serialized = JSON.stringify(payload);
    expect(payload.locked.action).toBe("暂不调整");
    expect(payload.analysisFramework.length).toBeGreaterThan(3);
    expect(payload.metrics.some((item) => item.label === "商品点击" && item.value === 5)).toBe(true);
    expect(serialized).not.toContain("session-secret");
    expect(serialized).not.toContain("product_efficacy");
    expect(serialized).not.toMatch(/"S4"/);
    expect(serialized).not.toContain("演示商品目录之外的名称");
    expect(diagnosisExpressionInputSummary(window)).toMatchObject({
      promptVersion: DIAGNOSIS_EXPRESSION_PROMPT_VERSION,
      windowStartAt: window.windowStartAt,
      actionKind: "hold",
      confidence: "unknown"
    });
  });

  it("系统提示禁止编造数字、因果，以及把暂不调整改成动作", () => {
    expect(DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT).toContain("不得编造");
    expect(DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT).toContain("导致");
    expect(DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT).toContain("citedNumbers");
    expect(DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT).toContain("不要把成交金额当成动作");
    expect(DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT).toContain("不要写没听到不等于没讲");
    expect(DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT).toContain("不得把动作改成断播");
    expect(DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT).toContain("暂不调整");
    expect(DIAGNOSIS_EXPRESSION_PROMPT_VERSION).toBe("diagnosis-expression-v6");
    expect(DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT).toContain("成交单数大于 0");
  });
});
