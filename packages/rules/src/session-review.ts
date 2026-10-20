import {
  sessionReviewSchema,
  type AnchorSessionReport,
  type LiveWindowAggregate,
  type SessionReview,
  type SessionReviewFinding,
  type SessionReviewNarrative,
  type SessionReviewTotals
} from "@live-growth/contracts";
import { coachLine, shanghaiClock, shanghaiRangeLabel, shortQuote } from "./anchor-review";
import { hourForSlotIndex } from "./historical-hour-baseline";
import { windowMetrics } from "./reference-script";

export const SESSION_REVIEW_PROMPT_VERSION = "session-review-v2" as const;
export const SESSION_REVIEW_MAX_WINDOWS = 48;
export const SESSION_REVIEW_MAX_CHAPTERS = 8;

export class SessionReviewRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionReviewRangeError";
  }
}

type Totals = {
  speechFinalCount: number;
  paidBuyers?: number;
  productClicks?: number;
  liveImpressions?: number;
  liveWatch?: number;
  paidYuan?: number;
  spendYuan?: number;
};

type HourBucket = {
  hour: number;
  startAt: string;
  endAt: string;
  windows: LiveWindowAggregate[];
};

function cite(label: string, value: number, unit: string): SessionReviewFinding["citedNumbers"][number] {
  return { label, value, unit };
}

function personalize(hostName: string, text: string): string {
  if (text.includes(`主播${hostName}`) || text.startsWith("主播")) return text.slice(0, 240);
  return `主播${hostName}：${text}`.slice(0, 240);
}

function roundYuan(fen: number): number {
  return Math.max(0, Math.round(fen / 100));
}

function countDelta(window: LiveWindowAggregate, source: "compass" | "qianchuan", key: string): number | undefined {
  const stat = source === "compass" ? window.compass[key] : window.qianchuan[key];
  if (!stat) return undefined;
  if (stat.semantic === "cumulative") return stat.delta !== undefined ? Math.max(0, Math.round(stat.delta)) : undefined;
  if (stat.semantic === "instant") return Math.max(0, Math.round(stat.last));
  return undefined;
}

function spendFen(window: LiveWindowAggregate): number | undefined {
  const compass = window.compass.adSpendFen?.delta;
  if (compass !== undefined) return Math.max(0, Math.round(compass));
  const qc = window.qianchuan.adSpend;
  if (!qc) return undefined;
  if (qc.semantic === "cumulative" && qc.delta !== undefined) return Math.max(0, Math.round(qc.delta * 100));
  if (qc.semantic === "instant") return Math.max(0, Math.round(qc.last));
  return undefined;
}

function gmvFen(window: LiveWindowAggregate): number | undefined {
  const compass = window.compass.sessionPaidGmvFen?.delta;
  return compass !== undefined ? Math.max(0, Math.round(compass)) : undefined;
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function windowTotals(window: LiveWindowAggregate): Totals {
  const clickPaid = windowMetrics(window);
  const spend = spendFen(window);
  const gmv = gmvFen(window);
  const liveImpressions = countDelta(window, "qianchuan", "liveImpressions");
  const liveWatch = countDelta(window, "qianchuan", "liveWatchCount");
  return {
    speechFinalCount: window.speech.finalCount,
    ...(clickPaid.paidBuyersDelta !== undefined ? { paidBuyers: clickPaid.paidBuyersDelta } : {}),
    ...(clickPaid.productClicks !== undefined ? { productClicks: clickPaid.productClicks } : {}),
    ...(liveImpressions !== undefined ? { liveImpressions } : {}),
    ...(liveWatch !== undefined ? { liveWatch } : {}),
    ...(gmv !== undefined ? { paidYuan: roundYuan(gmv) } : {}),
    ...(spend !== undefined ? { spendYuan: roundYuan(spend) } : {})
  };
}

function mergeTotals(left: Totals, right: Totals): Totals {
  const paidYuan = addOptional(left.paidYuan, right.paidYuan);
  const spendYuan = addOptional(left.spendYuan, right.spendYuan);
  const paidBuyers = addOptional(left.paidBuyers, right.paidBuyers);
  const productClicks = addOptional(left.productClicks, right.productClicks);
  const liveImpressions = addOptional(left.liveImpressions, right.liveImpressions);
  const liveWatch = addOptional(left.liveWatch, right.liveWatch);
  return {
    speechFinalCount: left.speechFinalCount + right.speechFinalCount,
    ...(paidBuyers !== undefined ? { paidBuyers } : {}),
    ...(productClicks !== undefined ? { productClicks } : {}),
    ...(liveImpressions !== undefined ? { liveImpressions } : {}),
    ...(liveWatch !== undefined ? { liveWatch } : {}),
    ...(paidYuan !== undefined ? { paidYuan } : {}),
    ...(spendYuan !== undefined ? { spendYuan } : {})
  };
}

function sumWindows(windows: readonly LiveWindowAggregate[]): Totals {
  return windows.reduce<Totals>((acc, window) => mergeTotals(acc, windowTotals(window)), { speechFinalCount: 0 });
}

function clockHourLabel(hour: number): string {
  const next = (hour + 1) % 24;
  return `${String(hour).padStart(2, "0")}:00–${String(next).padStart(2, "0")}:00`;
}

function groupByClockHour(windows: readonly LiveWindowAggregate[]): HourBucket[] {
  const buckets = new Map<number, HourBucket>();
  for (const window of windows) {
    const hour = hourForSlotIndex(window.slotIndex).hour;
    const existing = buckets.get(hour);
    if (existing) {
      existing.windows.push(window);
      existing.endAt = window.windowEndAt;
      continue;
    }
    buckets.set(hour, { hour, startAt: window.windowStartAt, endAt: window.windowEndAt, windows: [window] });
  }
  return [...buckets.values()].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
}

function mergeBuckets(left: HourBucket, right: HourBucket): HourBucket {
  return {
    hour: left.hour,
    startAt: left.startAt,
    endAt: right.endAt,
    windows: [...left.windows, ...right.windows]
  };
}

function collapseHours(buckets: HourBucket[], maxChapters: number): HourBucket[] {
  const result = [...buckets];
  while (result.length > maxChapters) {
    const mergeAt = result.length > 2 ? 1 : 0;
    const current = result[mergeAt]!;
    const next = result[mergeAt + 1]!;
    result.splice(mergeAt, 2, mergeBuckets(current, next));
  }
  return result;
}

function chapterLabel(bucket: HourBucket): string {
  const startHour = hourForSlotIndex(bucket.windows[0]!.slotIndex).hour;
  const last = bucket.windows.at(-1)!;
  const endHour = hourForSlotIndex(last.slotIndex).hour;
  if (startHour === endHour) return clockHourLabel(startHour);
  return `${String(startHour).padStart(2, "0")}:00–${String((endHour + 1) % 24).padStart(2, "0")}:00`;
}

export type SessionBottleneckKind = "entry" | "click" | "convert" | "steady" | "unknown";

export function pickSessionBottleneck(totals: Totals): SessionBottleneckKind {
  const impressions = totals.liveImpressions;
  const watch = totals.liveWatch;
  const clicks = totals.productClicks;
  const paid = totals.paidBuyers;
  if (impressions === undefined && watch === undefined && clicks === undefined && paid === undefined) return "unknown";
  if (clicks !== undefined && clicks >= 10 && (paid === undefined || paid === 0)) return "convert";
  if (impressions !== undefined && impressions >= 20 && watch !== undefined && watch < impressions * 0.15) return "entry";
  if ((watch !== undefined && watch >= 20 || impressions !== undefined && impressions >= 20) && (clicks === undefined || clicks < 5)) return "click";
  if (paid !== undefined && paid > 0) return "steady";
  return "unknown";
}

function bottleneckText(hostName: string, kind: SessionBottleneckKind, totals: Totals): { text: string; cited: SessionReviewFinding["citedNumbers"] } {
  const clickCite = totals.productClicks !== undefined ? [cite("商品点击", totals.productClicks, "次")] : [];
  const paidCite = totals.paidBuyers !== undefined ? [cite("支付人数", totals.paidBuyers, "人")] : [];
  const impressionCite = totals.liveImpressions !== undefined ? [cite("曝光", totals.liveImpressions, "次")] : [];
  const watchCite = totals.liveWatch !== undefined ? [cite("观看", totals.liveWatch, "次")] : [];
  const clickText = totals.productClicks !== undefined ? `商品点击 ${totals.productClicks} 次` : "商品点击还对不上";
  const paidText = totals.paidBuyers !== undefined ? `支付人数 ${totals.paidBuyers} 人` : "支付人数还对不上";
  const impressionText = totals.liveImpressions !== undefined ? `曝光 ${totals.liveImpressions} 次` : "曝光还对不上";
  const watchText = totals.liveWatch !== undefined ? `观看 ${totals.liveWatch} 次` : "观看还对不上";
  switch (kind) {
    case "convert":
      return { text: `这场卡在成交：${clickText}，${paidText}。人点了商品，单还没跟上。下一场主播${hostName}把价格、赠品和催单连着讲完。`, cited: [...clickCite, ...paidCite].slice(0, 4) };
    case "click":
      return { text: `这场卡在兴趣：${watchText}，${clickText}。人进来了，商品点得少。下一场主播${hostName}把痛点讲短，紧接着让人点开小黄车。`, cited: [...watchCite, ...clickCite].slice(0, 4) };
    case "entry":
      return { text: `这场卡在进线：${impressionText}，${watchText}。刷到的人停得少。下一场主播${hostName}进线先抛钩子和互动。`, cited: [...impressionCite, ...watchCite].slice(0, 4) };
    case "steady":
      return { text: `这场没有特别塌的一层。${clickText}，${paidText}。下一场主播${hostName}按话术缺口补齐，保持现在的收口节奏。`, cited: [...clickCite, ...paidCite].slice(0, 4) };
    default:
      return { text: `这场经营数字还对不上，先看主播${hostName}的转写缺口，对上数字后再判断卡在哪一层。`, cited: [] };
  }
}

function chapterSpeechLabels(coverage: AnchorSessionReport, windows: readonly LiveWindowAggregate[]): string[] {
  const starts = new Set(windows.map((window) => window.windowStartAt));
  const keys = new Set(coverage.windows.filter((item) => starts.has(item.windowStartAt)).flatMap((item) => item.coveredKeys));
  return coverage.points.filter((point) => keys.has(point.key)).sort((left, right) => right.weight - left.weight).map((point) => point.label);
}

function buildChapter(hostName: string, bucket: HourBucket, coverage: AnchorSessionReport, index: number): SessionReviewFinding {
  const totals = sumWindows(bucket.windows);
  const label = chapterLabel(bucket);
  const parts = [`${label}：完整句子 ${totals.speechFinalCount} 条`];
  const cited: SessionReviewFinding["citedNumbers"] = [cite("完整句子", totals.speechFinalCount, "条")];
  if (totals.productClicks !== undefined) {
    parts.push(`商品点击 ${totals.productClicks} 次`);
    cited.push(cite("商品点击", totals.productClicks, "次"));
  } else {
    parts.push("商品点击还对不上");
  }
  if (totals.paidBuyers !== undefined) {
    parts.push(`支付人数 ${totals.paidBuyers} 人`);
    if (cited.length < 4) cited.push(cite("支付人数", totals.paidBuyers, "人"));
  } else {
    parts.push("支付人数还对不上");
  }
  const spoken = chapterSpeechLabels(coverage, bucket.windows).slice(0, 3);
  if (spoken.length > 0) parts.push(`这段讲到了${spoken.join("、")}`);
  else if (totals.speechFinalCount > 0) parts.push("这段转写里没有对上参考要点");
  else parts.push(`这段没有完整转写，先不判断主播${hostName}讲了什么`);
  return {
    id: `chapter-${index + 1}`,
    kind: "chapter",
    label,
    text: `${parts.join("。")}。`,
    at: bucket.startAt,
    citedNumbers: cited.slice(0, 4)
  };
}

function buildNextSteps(hostName: string, kind: SessionBottleneckKind, coverage: AnchorSessionReport): string[] {
  if (coverage.speechFinalCount === 0) {
    return [`先确认这场有完整转写，再给主播${hostName}做整场复盘。`];
  }
  const steps: string[] = [];
  const bottleneckStep: Record<SessionBottleneckKind, string> = {
    convert: `下一场有人点了小黄车之后，主播${hostName}先把到手价、赠品和催单连着讲完，再看成交有没有跟上。`,
    click: `下一场主播${hostName}把痛点讲短，紧接着明确让人点开小黄车。`,
    entry: `下一场进线时主播${hostName}先抛钩子和互动，让刷到的人先停下来。`,
    steady: `下一场主播${hostName}保持现在的收口节奏，把转写里没出现的要点补进每轮讲解。`,
    unknown: `下一场先把经营数字对上，主播${hostName}按话术缺口改讲解。`
  };
  steps.push(bottleneckStep[kind]);
  const missing = coverage.points.filter((point) => !point.covered).sort((left, right) => right.weight - left.weight);
  for (const point of missing.slice(0, 2)) {
    const line = `「${point.label}」这场转写里没有出现。${coachLine(point)}。`;
    if (!steps.some((item) => item.includes(point.label))) steps.push(line);
    if (steps.length >= 3) break;
  }
  return steps.slice(0, 3).map((text) => personalize(hostName, text));
}

export function buildSessionReviewNarrative(input: {
  hostName: string;
  rangeStartAt: string;
  rangeEndAt: string;
  coverage: AnchorSessionReport;
  windows: readonly LiveWindowAggregate[];
  totals: Totals;
}): SessionReviewNarrative {
  const { hostName, coverage, totals } = input;
  const rangeLabel = shanghaiRangeLabel(input.rangeStartAt, input.rangeEndAt);
  const coveredCount = coverage.points.filter((point) => point.covered).length;
  const totalPoints = coverage.points.length;
  const bottleneckKind = pickSessionBottleneck(totals);
  const summaryCited = [cite("完整句子", coverage.speechFinalCount, "条"), cite("覆盖要点", coveredCount, "个")];
  if (totals.paidBuyers !== undefined) summaryCited.push(cite("支付人数", totals.paidBuyers, "人"));
  else if (totals.productClicks !== undefined) summaryCited.push(cite("商品点击", totals.productClicks, "次"));

  const summary: SessionReviewFinding = coverage.speechFinalCount === 0
    ? {
        id: "summary",
        kind: "summary",
        text: `主播${hostName}这场 ${rangeLabel} 没有可分析的完整转写，先不评话术好坏。完整句子 0 条，覆盖要点 0 个。经营数字仍可看，但讲解对不上。`,
        citedNumbers: [cite("完整句子", 0, "条"), cite("覆盖要点", 0, "个")]
      }
    : {
        id: "summary",
        kind: "summary",
        text: totals.paidBuyers !== undefined
          ? `主播${hostName}这场 ${rangeLabel}，转写 ${coverage.speechFinalCount} 句，参考要点覆盖 ${coveredCount}/${totalPoints}，支付人数 ${totals.paidBuyers} 人。下面按整场看卡在哪、各时段怎么走、下一场先改什么。`
          : totals.productClicks !== undefined
            ? `主播${hostName}这场 ${rangeLabel}，转写 ${coverage.speechFinalCount} 句，参考要点覆盖 ${coveredCount}/${totalPoints}，商品点击 ${totals.productClicks} 次。下面按整场看卡在哪、各时段怎么走、下一场先改什么。`
            : `主播${hostName}这场 ${rangeLabel}，转写 ${coverage.speechFinalCount} 句，参考要点覆盖 ${coveredCount}/${totalPoints}。经营数字还对不上，先看话术缺口。`,
        citedNumbers: summaryCited.slice(0, 4)
      };

  const bottleneckCopy = bottleneckText(hostName, bottleneckKind, totals);
  const bottleneck: SessionReviewFinding = {
    id: "bottleneck",
    kind: "bottleneck",
    text: bottleneckCopy.text,
    citedNumbers: bottleneckCopy.cited
  };

  const hours = collapseHours(groupByClockHour(input.windows), SESSION_REVIEW_MAX_CHAPTERS);
  const chapters = hours.map((bucket, index) => buildChapter(hostName, bucket, coverage, index));

  const covered = coverage.points.filter((point) => point.covered && point.firstEvidence);
  const groups = new Map<string, typeof covered>();
  for (const point of covered) {
    const key = point.firstEvidence!.quote;
    const list = groups.get(key) ?? [];
    list.push(point);
    groups.set(key, list);
  }
  const strengths: SessionReviewFinding[] = [...groups.values()]
    .sort((left, right) => Math.max(...right.map((item) => item.weight)) - Math.max(...left.map((item) => item.weight))
      || Date.parse(left[0]!.firstEvidence!.at) - Date.parse(right[0]!.firstEvidence!.at))
    .slice(0, 3)
    .map((points, index) => {
      const evidence = points[0]!.firstEvidence!;
      const labels = points.map((point) => `「${point.label}」`);
      const text = labels.length === 1
        ? `${shanghaiClock(evidence.at)} 讲到了 1 个要点：${labels[0]}。`
        : `${shanghaiClock(evidence.at)} 同一句里讲到了 ${labels.length} 个要点：${labels.join("、")}。`;
      return {
        id: `strength-${index + 1}`,
        kind: "strength" as const,
        text: text.slice(0, 480),
        at: evidence.at,
        quote: shortQuote(evidence.quote),
        citedNumbers: [cite("要点", labels.length, "个")]
      };
    });

  const missing = coverage.speechFinalCount === 0
    ? []
    : [...coverage.points.filter((point) => !point.covered)].sort((left, right) => right.weight - left.weight);
  const gaps: SessionReviewFinding[] = missing.slice(0, 3).map((point, index) => ({
    id: `gap-${index + 1}`,
    kind: "gap" as const,
    text: `这场转写里没有出现「${point.label}」（0 次）。下一场先补：${coachLine(point)}。`.slice(0, 480),
    citedNumbers: [cite("提及次数", 0, "次")]
  }));

  return {
    summary,
    bottleneck,
    chapters,
    strengths,
    gaps,
    nextSteps: buildNextSteps(hostName, bottleneckKind, coverage)
  };
}

export function assembleSessionReview(input: {
  hostName: string;
  sessionId: string;
  rangeStartAt: string;
  rangeEndAt: string;
  generatedAt: string;
  coverage: AnchorSessionReport;
  windows: readonly LiveWindowAggregate[];
  truncated: boolean;
}): SessionReview {
  if (input.windows.length === 0) {
    throw new SessionReviewRangeError("这场还没有走完的时段，等过了一段再复盘。");
  }
  const totals = sumWindows(input.windows);
  const narrative = buildSessionReviewNarrative({
    hostName: input.hostName,
    rangeStartAt: input.rangeStartAt,
    rangeEndAt: input.rangeEndAt,
    coverage: input.coverage,
    windows: input.windows,
    totals
  });
  const reviewTotals: SessionReviewTotals = {
    windowCount: input.windows.length,
    speechFinalCount: input.coverage.speechFinalCount,
    truncated: input.truncated,
    ...(totals.paidBuyers !== undefined ? { paidBuyers: totals.paidBuyers } : {}),
    ...(totals.productClicks !== undefined ? { productClicks: totals.productClicks } : {}),
    ...(totals.liveImpressions !== undefined ? { liveImpressions: totals.liveImpressions } : {}),
    ...(totals.liveWatch !== undefined ? { liveWatch: totals.liveWatch } : {}),
    ...(totals.paidYuan !== undefined ? { paidYuan: totals.paidYuan } : {}),
    ...(totals.spendYuan !== undefined ? { spendYuan: totals.spendYuan } : {})
  };
  const dataNotes = [
    "只纳入已经走完的时段，当前还在进行的这一段不算。",
    "转写里没有出现，不等于主播没讲。",
    "数字和话术只说同时发生，不说谁导致谁。",
    "主播名字用于叙述；转写按本场存储，不按主播过滤。"
  ];
  if (input.truncated) dataNotes.unshift("本场超过 12 小时，只纳入最近 12 小时已经走完的时段。");
  return sessionReviewSchema.parse({
    schemaVersion: 1,
    hostName: input.hostName,
    sessionId: input.sessionId,
    rangeStartAt: input.rangeStartAt,
    rangeEndAt: input.rangeEndAt,
    generatedAt: input.generatedAt,
    provider: "deterministic-template",
    promptVersion: SESSION_REVIEW_PROMPT_VERSION,
    scriptVersion: input.coverage.scriptVersion,
    totals: reviewTotals,
    coverage: input.coverage,
    narrative,
    dataNotes: dataNotes.slice(0, 8)
  });
}
