// Public synthetic fixtures; no private person, product, transcript, or historical calibration is included.
import { describe, expect, it } from "vitest";
import { anchorSessionReportSchema, type AnchorSessionReport } from "@live-growth/contracts";
import { aggregateScriptIteration, SCRIPT_ITERATION_MIN_SESSIONS } from "../src/script-iteration";

const GENERATED_AT = "2026-08-15T00:00:00.000Z";

function report(sessionId: string, options: {
  covered: boolean;
  scriptVersion?: string;
  score?: number;
  clickDelta?: { current: number; next: number };
  noSpeech?: boolean;
}): AnchorSessionReport {
  const covered = options.covered;
  return anchorSessionReportSchema.parse({
    schemaVersion: 1,
    tenantId: "tenant-demo",
    sessionId,
    scriptVersion: options.scriptVersion ?? "synthetic-reference-script-v1",
    generatedAt: GENERATED_AT,
    sessionStatus: "stopped",
    windowCount: 2,
    speechFinalCount: options.noSpeech ? 0 : 10,
    score: options.noSpeech ? null : {
      total: options.score ?? 60,
      weightedCoverageRate: (options.score ?? 60) / 100,
      coveredPoints: covered ? 1 : 0,
      totalPoints: 1
    },
    points: [{
      key: "price_anchor", label: "到手价", group: "price_mechanism", weight: 3,
      covered, mentionCount: covered ? 1 : 0, mentionWindowStarts: covered ? ["2026-08-14T00:00:00.000Z"] : []
    }],
    windows: [],
    linkage: covered && options.clickDelta ? [{
      pointKey: "price_anchor",
      windowStartAt: "2026-08-14T00:00:00.000Z",
      at: "2026-08-14T00:05:00.000Z",
      quote: "演示商品到手价100元",
      window: { productClicks: options.clickDelta.current },
      nextWindow: { windowStartAt: "2026-08-14T00:15:00.000Z", productClicks: options.clickDelta.next },
      note: "提及「到手价」后下一窗：商品点击变化（仅相关性，非因果）。"
    }] : [],
    suggestions: [],
    dataNotes: []
  });
}

describe("aggregateScriptIteration", () => {
  it("样本不足 5 场时 status=insufficient_sample，只报样本数", () => {
    const result = aggregateScriptIteration({
      reports: [report("s1", { covered: true }), report("s2", { covered: false })],
      generatedAt: GENERATED_AT
    });
    expect(result.minSessions).toBe(SCRIPT_ITERATION_MIN_SESSIONS);
    expect(result.sessionsAnalyzed).toBe(2);
    const point = result.points.find((item) => item.pointKey === "price_anchor")!;
    expect(point.status).toBe("insufficient_sample");
    expect(point.sessionsAnalyzed).toBe(2);
    expect(point.coverageRate).toBeUndefined();
    expect(result.versions[0]!.status).toBe("insufficient_sample");
    expect(result.versions[0]!.scoreMedian).toBeUndefined();
  });

  it("达到最低样本量后输出覆盖率与联动变化中位数", () => {
    const reports = [
      report("s1", { covered: true, clickDelta: { current: 10, next: 20 } }),
      report("s2", { covered: true, clickDelta: { current: 10, next: 14 } }),
      report("s3", { covered: true, clickDelta: { current: 10, next: 16 } }),
      report("s4", { covered: true, clickDelta: { current: 10, next: 12 } }),
      report("s5", { covered: true, clickDelta: { current: 10, next: 30 } }),
      report("s6", { covered: false })
    ];
    const result = aggregateScriptIteration({ reports, generatedAt: GENERATED_AT });
    const point = result.points.find((item) => item.pointKey === "price_anchor")!;
    expect(point.status).toBe("ok");
    expect(point.sessionsAnalyzed).toBe(6);
    expect(point.sessionsCovered).toBe(5);
    expect(point.coverageRate).toBeCloseTo(5 / 6);
    // 联动样本 5 场：deltas 10/4/6/2/20 → 中位数 6
    expect(point.clickDeltaMedianWhenCovered).toBe(6);
    // 联动的支付增量没有样本，字段缺省而不是 0
    expect(point.paidDeltaMedianWhenCovered).toBeUndefined();
    const version = result.versions.find((item) => item.scriptVersion === "synthetic-reference-script-v1")!;
    expect(version.status).toBe("ok");
    expect(version.scoreMedian).toBe(60);
  });

  it("无转写样本的场次不参与统计并写入数据说明", () => {
    const result = aggregateScriptIteration({
      reports: [report("s1", { covered: true }), report("s2", { covered: true, noSpeech: true })],
      generatedAt: GENERATED_AT
    });
    expect(result.sessionsAnalyzed).toBe(1);
    expect(result.dataNotes.some((note) => note.includes("没有转写样本"))).toBe(true);
  });

  it("不同话术版本分组对比，各自套用最低样本量门槛", () => {
    const reports = [
      ...Array.from({ length: 5 }, (_, index) => report(`v1-${index}`, { covered: true, score: 50 })),
      report("v2-0", { covered: true, scriptVersion: "synthetic-reference-script-v2", score: 80 })
    ];
    const result = aggregateScriptIteration({ reports, generatedAt: GENERATED_AT });
    const v1 = result.versions.find((item) => item.scriptVersion === "synthetic-reference-script-v1")!;
    const v2 = result.versions.find((item) => item.scriptVersion === "synthetic-reference-script-v2")!;
    expect(v1.status).toBe("ok");
    expect(v1.scoreMedian).toBe(50);
    expect(v2.status).toBe("insufficient_sample");
    expect(v2.scoreMedian).toBeUndefined();
  });
});
