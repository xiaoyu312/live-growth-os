import {
  scriptIterationReportSchema,
  type AnchorSessionReport,
  type ScriptIterationPointStat,
  type ScriptIterationReport,
  type ScriptIterationVersionStat
} from "@live-growth/contracts";

/**
 * Phase 2B / M5（D045）：多场"要点 × 窗口 × 指标响应"关联统计。
 * 最低样本量 5 场；不足只报样本数，不出结论。全部确定性计算，只描述相关性。
 */

export const SCRIPT_ITERATION_MIN_SESSIONS = 5;

export type ScriptIterationInput = {
  reports: readonly AnchorSessionReport[];
  generatedAt: string;
  minSessions?: number;
};

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** 单场里某要点"提及窗→下一窗"的指标变化；同场多次提及取中位数。 */
function sessionLinkageDelta(report: AnchorSessionReport, pointKey: string, metric: "productClicks" | "paidBuyersDelta"): number | undefined {
  const deltas = report.linkage
    .filter((item) => item.pointKey === pointKey && item.nextWindow !== undefined)
    .flatMap((item) => {
      const current = item.window[metric];
      const next = item.nextWindow![metric];
      return current !== undefined && next !== undefined ? [next - current] : [];
    });
  return median(deltas);
}

export function aggregateScriptIteration(input: ScriptIterationInput): ScriptIterationReport {
  const minSessions = input.minSessions ?? SCRIPT_ITERATION_MIN_SESSIONS;
  // 只统计有转写样本的场次；无样本场次不参与，不当作"未覆盖"。
  const usable = input.reports.filter((report) => report.score !== null);

  const pointOrder: string[] = [];
  const pointMeta = new Map<string, { label: string; group: ScriptIterationPointStat["group"]; weight: number }>();
  for (const report of usable) {
    for (const point of report.points) {
      if (!pointMeta.has(point.key)) {
        pointOrder.push(point.key);
        pointMeta.set(point.key, { label: point.label, group: point.group, weight: point.weight });
      }
    }
  }

  const points: ScriptIterationPointStat[] = pointOrder.map((key) => {
    const meta = pointMeta.get(key)!;
    const withPoint = usable.filter((report) => report.points.some((point) => point.key === key));
    const covered = withPoint.filter((report) => report.points.find((point) => point.key === key)!.covered);
    const ok = withPoint.length >= minSessions;
    const clickDeltas = covered.flatMap((report) => {
      const delta = sessionLinkageDelta(report, key, "productClicks");
      return delta !== undefined ? [delta] : [];
    });
    const paidDeltas = covered.flatMap((report) => {
      const delta = sessionLinkageDelta(report, key, "paidBuyersDelta");
      return delta !== undefined ? [delta] : [];
    });
    const clickMedian = clickDeltas.length >= minSessions ? median(clickDeltas) : undefined;
    const paidMedian = paidDeltas.length >= minSessions ? median(paidDeltas) : undefined;
    return {
      pointKey: key,
      label: meta.label,
      group: meta.group,
      weight: meta.weight,
      sessionsAnalyzed: withPoint.length,
      sessionsCovered: covered.length,
      status: ok ? "ok" as const : "insufficient_sample" as const,
      ...(ok ? { coverageRate: covered.length / withPoint.length } : {}),
      ...(clickMedian !== undefined ? { clickDeltaMedianWhenCovered: clickMedian } : {}),
      ...(paidMedian !== undefined ? { paidDeltaMedianWhenCovered: paidMedian } : {})
    };
  });

  const versionOrder: string[] = [];
  for (const report of usable) {
    if (!versionOrder.includes(report.scriptVersion)) versionOrder.push(report.scriptVersion);
  }
  const versions: ScriptIterationVersionStat[] = versionOrder.map((version) => {
    const own = usable.filter((report) => report.scriptVersion === version);
    const ok = own.length >= minSessions;
    const coverageMedian = median(own.map((report) => report.score!.weightedCoverageRate));
    const scoreMedian = median(own.map((report) => report.score!.total));
    return {
      scriptVersion: version,
      sessionsAnalyzed: own.length,
      status: ok ? "ok" as const : "insufficient_sample" as const,
      ...(ok && coverageMedian !== undefined ? { weightedCoverageRateMedian: coverageMedian } : {}),
      ...(ok && scoreMedian !== undefined ? { scoreMedian: Math.round(scoreMedian) } : {})
    };
  });

  const dataNotes = [
    `最低样本量 ${minSessions} 场；不足时只报样本数，不出结论。`,
    "统计只描述覆盖与指标变化的相关性，不构成因果结论。"
  ];
  if (usable.length < input.reports.length) dataNotes.push(`${input.reports.length - usable.length} 场没有转写样本，未参与统计。`);

  return scriptIterationReportSchema.parse({
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    minSessions,
    sessionsAnalyzed: usable.length,
    points,
    versions,
    dataNotes
  });
}
