// Public synthetic fixtures; no private person, product, transcript, or historical calibration is included.
import { describe, expect, it } from "vitest";
import { liveEventSchema, type LiveEvent } from "@live-growth/contracts";
import { aggregateLiveWindows } from "../src/live-window-aggregate";
import { buildAnchorSessionReport, REFERENCE_SCRIPT_V1, REFERENCE_SCRIPT_VERSION_V1, parseReferenceScriptText } from "../src/reference-script";

const TENANT = "tenant-demo";
const SESSION = "session-anchor-test";
const GENERATED_AT = "2026-08-14T01:00:00.000Z";

let sequence = 0;
function compassEvent(eventAt: string, payload: Record<string, unknown>): LiveEvent {
  sequence += 1;
  return liveEventSchema.parse({
    schemaVersion: 1, eventId: `evt-compass-${sequence}`, tenantId: TENANT, sessionId: SESSION,
    eventAt, capturedAt: eventAt, ingestedAt: eventAt, source: "browser_extension", kind: "live.compass.metric", provisional: false,
    payload: { observedAt: eventAt, sourceEndpoint: "/compass_api/shop/live/live_screen/core_data", mappingVersion: "compass-live-v1", dataStatus: "fresh", ...payload }
  });
}

function qianchuanEvent(eventAt: string, metrics: Record<string, { value: number; semantic: "instant" | "cumulative" | "rolling" | "rate" }>): LiveEvent {
  sequence += 1;
  const fullMetrics = Object.fromEntries(Object.entries(metrics).map(([key, item]) => [key, {
    value: item.value, unit: "次" as const, semantic: item.semantic, sourceField: `source_${key}`
  }]));
  return liveEventSchema.parse({
    schemaVersion: 1, eventId: `evt-qc-${sequence}`, tenantId: TENANT, sessionId: SESSION,
    eventAt, capturedAt: eventAt, ingestedAt: eventAt, source: "browser_extension", kind: "live.qianchuan.metric", provisional: false,
    payload: { observedAt: eventAt, sourceEndpoint: "/ad/api/data/v1/common/statQuery", mappingVersion: "qianchuan-live-v1", dataStatus: "fresh", metricSource: "qianchuan", metrics: fullMetrics }
  });
}

function transcript(at: string, text: string): { at: string; text: string } {
  return { at, text };
}

// 两个相邻完整窗口：00:00–00:15 与 00:15–00:30（本地 08:00 起）
// 商品点击（千川累计）：第一窗增量 20（0→20），第二窗增量 40（20→60）
// 支付人数（罗盘累计）：第一窗增量 3（5→8），第二窗增量 6（8→14）
function twoWindows() {
  const events = [
    qianchuanEvent("2026-08-14T00:01:00.000Z", { productClicks: { value: 0, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:10:00.000Z", { productClicks: { value: 20, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:16:00.000Z", { productClicks: { value: 30, semantic: "cumulative" } }),
    qianchuanEvent("2026-08-14T00:25:00.000Z", { productClicks: { value: 60, semantic: "cumulative" } }),
    compassEvent("2026-08-14T00:01:00.000Z", { paidBuyerCount: 5 }),
    compassEvent("2026-08-14T00:10:00.000Z", { paidBuyerCount: 8 }),
    compassEvent("2026-08-14T00:16:00.000Z", { paidBuyerCount: 8 }),
    compassEvent("2026-08-14T00:25:00.000Z", { paidBuyerCount: 14 })
  ];
  return aggregateLiveWindows(events, { sessionStartAt: "2026-08-14T00:00:00.000Z", sessionEndAt: "2026-08-14T00:30:00.000Z" });
}

describe("REFERENCE_SCRIPT_V1", () => {
  it("是合法的版本化要点清单，key 不重复", () => {
    expect(REFERENCE_SCRIPT_V1.version).toBe(REFERENCE_SCRIPT_VERSION_V1);
    expect(REFERENCE_SCRIPT_V1.basedOn).toContain("synthetic public fixture");
    const keys = REFERENCE_SCRIPT_V1.points.map((point) => point.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("buildAnchorSessionReport", () => {
  it("无转写样本时不评分，只显示样本不足", () => {
    const report = buildAnchorSessionReport({
      tenantId: TENANT, sessionId: SESSION, sessionStatus: "stopped",
      transcripts: [], windows: twoWindows(), generatedAt: GENERATED_AT
    });
    expect(report.score).toBeNull();
    expect(report.speechFinalCount).toBe(0);
    expect(report.suggestions).toEqual([]);
    expect(report.dataNotes[0]).toContain("样本不足");
  });

  it("确定性关键词匹配产出覆盖、证据与加权评分", () => {
    const report = buildAnchorSessionReport({
      tenantId: TENANT, sessionId: SESSION, sessionStatus: "stopped",
      transcripts: [
        transcript("2026-08-14T00:02:00.000Z", "演示商品的材料和设计便于组装"),
        transcript("2026-08-14T00:05:00.000Z", "演示到手价100元，优惠机制为示例折扣"),
        transcript("2026-08-14T00:18:00.000Z", "点开商品卡查看，演示活动限时有效")
      ],
      windows: twoWindows(), generatedAt: GENERATED_AT
    });
    expect(report.scriptVersion).toBe(REFERENCE_SCRIPT_VERSION_V1);
    const ingredient = report.points.find((point) => point.key === "core_ingredient")!;
    expect(ingredient.covered).toBe(true);
    expect(ingredient.firstEvidence?.quote).toContain("材料");
    expect(ingredient.mentionWindowStarts).toEqual(["2026-08-14T00:00:00.000Z"]);
    const urgency = report.points.find((point) => point.key === "urgency")!;
    expect(urgency.covered).toBe(true);
    // 未提及的要点保持 covered=false，并进建议
    const followGuide = report.points.find((point) => point.key === "follow_guide")!;
    expect(followGuide.covered).toBe(false);
    expect(report.score).not.toBeNull();
    expect(report.score!.total).toBeGreaterThan(0);
    expect(report.score!.total).toBeLessThan(100);
    expect(report.suggestions.length).toBeGreaterThan(0);
    expect(report.suggestions.some((text) => text.includes("没有出现"))).toBe(true);
  });

  it("按窗覆盖与催单密度进入窗口统计", () => {
    const report = buildAnchorSessionReport({
      tenantId: TENANT, sessionId: SESSION, sessionStatus: "stopped",
      transcripts: [
        transcript("2026-08-14T00:02:00.000Z", "演示活动限时有效"),
        transcript("2026-08-14T00:20:00.000Z", "演示商品的材料说明")
      ],
      windows: twoWindows(), generatedAt: GENERATED_AT
    });
    expect(report.windows).toHaveLength(2);
    expect(report.windows[0]!.urgencyMentions).toBe(1);
    expect(report.windows[1]!.urgencyMentions).toBe(0);
    expect(report.windows[1]!.coveredKeys).toContain("core_ingredient");
    expect(report.score!.urgencyPerWindow).toBe(0.5);
  });

  it("价格/催单/CTA 提及产出下一窗联动对比，措辞只说相关性", () => {
    const report = buildAnchorSessionReport({
      tenantId: TENANT, sessionId: SESSION, sessionStatus: "stopped",
      transcripts: [transcript("2026-08-14T00:05:00.000Z", "演示到手价100元，演示活动限时有效")],
      windows: twoWindows(), generatedAt: GENERATED_AT
    });
    const priceLink = report.linkage.find((item) => item.pointKey === "price_anchor");
    expect(priceLink).toBeDefined();
    expect(priceLink!.window.productClicks).toBe(20);
    expect(priceLink!.nextWindow?.productClicks).toBe(40);
    expect(priceLink!.window.paidBuyersDelta).toBe(3);
    expect(priceLink!.nextWindow?.paidBuyersDelta).toBe(6);
    expect(priceLink!.note).toContain("非因果");
    expect(report.dataNotes.some((note) => note.includes("不构成因果"))).toBe(true);
  });

  it("最后一窗提及时明确说明没有下一窗可对比，不伪造数据", () => {
    const report = buildAnchorSessionReport({
      tenantId: TENANT, sessionId: SESSION, sessionStatus: "running",
      transcripts: [transcript("2026-08-14T00:20:00.000Z", "确认参数后再下单")],
      windows: twoWindows(), generatedAt: GENERATED_AT
    });
    const link = report.linkage.find((item) => item.pointKey === "purchase_cta")!;
    expect(link.nextWindow).toBeUndefined();
    expect(link.note).toContain("尚无相邻的下一个15分钟窗口");
  });

  it("同一要点同窗多次提及联动只记一次", () => {
    const report = buildAnchorSessionReport({
      tenantId: TENANT, sessionId: SESSION, sessionStatus: "stopped",
      transcripts: [
        transcript("2026-08-14T00:03:00.000Z", "演示到手价100元"),
        transcript("2026-08-14T00:06:00.000Z", "演示到手价100元，请查看说明")
      ],
      windows: twoWindows(), generatedAt: GENERATED_AT
    });
    expect(report.linkage.filter((item) => item.pointKey === "price_anchor")).toHaveLength(1);
  });
});

describe("parseReferenceScriptText", () => {
  it("按「要点名：关键词」解析，并推断分组", () => {
    const script = parseReferenceScriptText("# 合成解析示例\n到手价：到手价,100\n点开小黄车：点开小黄车,商品卡\n痛点场景|2：空间,收纳");
    expect(script.version).toBe("pasted-operator-v1");
    expect(script.points).toHaveLength(3);
    expect(script.points[0]).toMatchObject({ label: "到手价", group: "price_mechanism", weight: 3 });
    expect(script.points[1]).toMatchObject({ label: "点开小黄车", group: "cta" });
    expect(script.points[2]).toMatchObject({ label: "痛点场景", group: "pain_point", weight: 2 });
  });

  it("空文本或缺少关键词时报错", () => {
    expect(() => parseReferenceScriptText("   \n# only comment")).toThrow("空的");
    expect(() => parseReferenceScriptText("到手价")).toThrow("格式不对");
    expect(() => parseReferenceScriptText("到手价：")).toThrow("格式不对");
  });
});
