import {
  anchorReviewSchema,
  type AnchorPointCoverage,
  type AnchorReview,
  type AnchorReviewFinding,
  type AnchorReviewNarrative,
  type AnchorSessionReport,
  type LiveWindowAggregate
} from "@live-growth/contracts";
import { DEFAULT_LIVE_WINDOW_UTC_OFFSET_MINUTES, LIVE_WINDOW_MS, liveWindowKeyFor } from "./live-window-aggregate";
import { windowMetrics } from "./reference-script";

export const ANCHOR_REVIEW_PROMPT_VERSION = "anchor-review-v2" as const;
export const ANCHOR_REVIEW_MAX_WINDOWS = 16;

const COACH_LINE: Record<string, string> = {
  "hook_welcome": "下一场明确说明「开场说明」，只使用已核实的信息",
  "pain_point": "下一场明确说明「使用场景」，只使用已核实的信息",
  "core_ingredient": "下一场明确说明「原理或材料」，只使用已核实的信息",
  "efficacy": "下一场明确说明「产品特点」，只使用已核实的信息",
  "usage": "下一场明确说明「使用方法」，只使用已核实的信息",
  "suitable_audience": "下一场明确说明「适用范围」，只使用已核实的信息",
  "price_anchor": "下一场明确说明「到手价」，只使用已核实的信息",
  "offer_mechanism": "下一场明确说明「优惠说明」，只使用已核实的信息",
  "gift": "下一场明确说明「赠品说明」，只使用已核实的信息",
  "guarantee": "下一场明确说明「售后保障」，只使用已核实的信息",
  "product_card_cta": "下一场明确说明「商品信息入口」，只使用已核实的信息",
  "purchase_cta": "下一场明确说明「下单步骤」，只使用已核实的信息",
  "urgency": "下一场明确说明「活动时限」，只使用已核实的信息",
  "follow_guide": "下一场明确说明「关注入口」，只使用已核实的信息"
};

export class AnchorReviewRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorReviewRangeError";
  }
}

export function shanghaiClock(iso: string, utcOffsetMinutes = DEFAULT_LIVE_WINDOW_UTC_OFFSET_MINUTES): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const local = new Date(ms + utcOffsetMinutes * 60_000);
  return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

export function shanghaiRangeLabel(startAt: string, endAt: string): string {
  return `${shanghaiClock(startAt)}–${shanghaiClock(endAt)}`;
}

export function assertAnchorReviewRange(rangeStartAt: string, rangeEndAt: string, generatedAt: string): void {
  const startMs = Date.parse(rangeStartAt);
  const endMs = Date.parse(rangeEndAt);
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(generatedMs)) {
    throw new AnchorReviewRangeError("时段不是合法时间");
  }
  if (liveWindowKeyFor(startMs).windowStartAt !== rangeStartAt) {
    throw new AnchorReviewRangeError("开始时间必须落在15分钟窗口边界");
  }
  if (liveWindowKeyFor(endMs).windowStartAt !== rangeEndAt) {
    throw new AnchorReviewRangeError("结束时间必须落在15分钟窗口边界");
  }
  const durationMs = endMs - startMs;
  if (durationMs < LIVE_WINDOW_MS) throw new AnchorReviewRangeError("复盘时段至少15分钟");
  if (durationMs > ANCHOR_REVIEW_MAX_WINDOWS * LIVE_WINDOW_MS) throw new AnchorReviewRangeError("复盘时段最多4小时");
  if (endMs > generatedMs) throw new AnchorReviewRangeError("只能复盘已经结束的时段");
}

function cite(label: string, value: number, unit: string): AnchorReviewFinding["citedNumbers"][number] {
  return { label, value, unit };
}

function personalize(hostName: string, text: string): string {
  if (text.startsWith("主播")) return text.slice(0, 240);
  return `主播${hostName}：${text}`.slice(0, 240);
}

export function coachLine(point: Pick<AnchorPointCoverage, "key" | "label">): string {
  return COACH_LINE[point.key] ?? `下一场明确讲到「${point.label}」`;
}

export function shortQuote(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= 48 ? trimmed : `${trimmed.slice(0, 47)}…`;
}

function buildStrengths(coverage: AnchorSessionReport): AnchorReviewFinding[] {
  const covered = coverage.points.filter((point) => point.covered && point.firstEvidence);
  const groups = new Map<string, AnchorPointCoverage[]>();
  for (const point of covered) {
    const key = point.firstEvidence!.quote;
    const list = groups.get(key) ?? [];
    list.push(point);
    groups.set(key, list);
  }
  return [...groups.values()]
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
        text: text.slice(0, 400),
        at: evidence.at,
        quote: shortQuote(evidence.quote),
        citedNumbers: [cite("要点", labels.length, "个")]
      };
    });
}

function buildGaps(coverage: AnchorSessionReport): AnchorReviewFinding[] {
  if (coverage.speechFinalCount === 0) return [];
  return [...coverage.points.filter((point) => !point.covered)]
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 3)
    .map((point, index) => ({
      id: `gap-${index + 1}`,
      kind: "gap" as const,
      text: `转写里没有出现「${point.label}」（0 次）。下一场先补：${coachLine(point)}。`.slice(0, 400),
      citedNumbers: [cite("提及次数", 0, "次")]
    }));
}

function highlightWindows(input: {
  coverage: AnchorSessionReport;
  windows: readonly LiveWindowAggregate[];
}): AnchorReviewFinding[] {
  const { coverage } = input;
  const totalPoints = coverage.points.length;
  const windowByStart = new Map(input.windows.map((window) => [window.windowStartAt, window]));
  const scored = coverage.windows.slice(0, ANCHOR_REVIEW_MAX_WINDOWS).map((window) => {
    const metrics = windowByStart.get(window.windowStartAt);
    const clickPaid = metrics ? windowMetrics(metrics) : {};
    return {
      window,
      clicks: clickPaid.productClicks,
      paid: clickPaid.paidBuyersDelta,
      coverageCount: window.coveredKeys.length
    };
  });
  if (scored.length === 0) return [];
  const picks: typeof scored = [];
  const paidBest = [...scored].sort((left, right) => (right.paid ?? -1) - (left.paid ?? -1))[0];
  if (paidBest && paidBest.paid !== undefined) picks.push(paidBest);
  const clickBest = [...scored].sort((left, right) => (right.clicks ?? -1) - (left.clicks ?? -1))[0];
  if (clickBest && clickBest.clicks !== undefined && !picks.includes(clickBest)) picks.push(clickBest);
  const weak = [...scored]
    .filter((item) => item.window.speechFinals > 0)
    .sort((left, right) => left.coverageCount - right.coverageCount || (left.paid ?? 0) - (right.paid ?? 0))[0];
  if (weak && !picks.includes(weak)) picks.push(weak);
  if (picks.length === 0) picks.push(scored[0]!);
  return picks.slice(0, 3).map((item, index) => {
    const label = shanghaiRangeLabel(item.window.windowStartAt, item.window.windowEndAt);
    const parts = [`${label}：转写 ${item.window.speechFinals} 句，要点 ${item.coverageCount}/${totalPoints}`];
    const cited = [cite("完整句子", item.window.speechFinals, "条"), cite("覆盖要点", item.coverageCount, "个")];
    if (item.clicks !== undefined) {
      parts.push(`商品点击增量 ${item.clicks}`);
      cited.push(cite("商品点击增量", item.clicks, "次"));
    }
    if (item.paid !== undefined && cited.length < 4) {
      parts.push(`支付人数增量 ${item.paid}`);
      cited.push(cite("支付人数增量", item.paid, "人"));
    }
    if (item.clicks !== undefined && item.clicks > 0 && (item.paid === 0 || item.paid === undefined)) {
      parts.push("有点击，成交还没跟上，下一轮讲完价就接锁单或保障");
    } else if ((item.paid ?? 0) > 0) {
      parts.push("这段成交相对更好，可把当时怎么报价固定下来");
    }
    return {
      id: `window-${index + 1}`,
      kind: "watch" as const,
      text: `${parts.join("。")}。`.slice(0, 400),
      at: item.window.windowStartAt,
      citedNumbers: cited.slice(0, 4)
    };
  });
}

function buildNextSteps(hostName: string, coverage: AnchorSessionReport, timeline: AnchorReviewFinding[]): string[] {
  if (coverage.speechFinalCount === 0) {
    return [`先确认这段有完整转写，再给主播${hostName}做话术复盘。`];
  }
  const missing = [...coverage.points.filter((point) => !point.covered)].sort((left, right) => right.weight - left.weight);
  const steps = missing.slice(0, 3).map((point) => personalize(hostName, `「${point.label}」还没在转写里出现。${coachLine(point)}。`));
  const weak = timeline.find((item) => item.text.includes("成交还没跟上"));
  if (steps.length < 4 && weak) {
    steps.push(personalize(hostName, "有点击的时段先补锁单或保障，不要只重复报价。"));
  }
  if (steps.length === 0) {
    steps.push(personalize(hostName, "参考要点都讲到了，下一场保持这套，并把成交更好的那段话术固定下来。"));
  }
  return steps.slice(0, 4);
}

export function buildAnchorReviewNarrative(input: {
  hostName: string;
  rangeStartAt: string;
  rangeEndAt: string;
  coverage: AnchorSessionReport;
  windows: readonly LiveWindowAggregate[];
}): AnchorReviewNarrative {
  const { hostName, coverage } = input;
  const rangeLabel = shanghaiRangeLabel(input.rangeStartAt, input.rangeEndAt);
  const totalPoints = coverage.points.length;
  const coveredCount = coverage.points.filter((point) => point.covered).length;
  const missing = [...coverage.points.filter((point) => !point.covered)].sort((left, right) => right.weight - left.weight);
  const summaryCited = [cite("完整句子", coverage.speechFinalCount, "条"), cite("覆盖要点", coveredCount, "个")];

  const summary: AnchorReviewFinding = coverage.speechFinalCount === 0
    ? {
        id: "summary",
        kind: "summary",
        text: `主播${hostName}在 ${rangeLabel} 这段没有可分析的完整转写，样本不足，这一轮不做话术好坏判断。完整句子 0 条，覆盖要点 0 个。`,
        citedNumbers: [cite("完整句子", 0, "条"), cite("覆盖要点", 0, "个")]
      }
    : {
        id: "summary",
        kind: "summary",
        text: missing[0]
          ? `主播${hostName}这段 ${rangeLabel} 转写 ${coverage.speechFinalCount} 句，参考要点讲到 ${coveredCount}/${totalPoints}。下一场先补「${missing[0].label}」。`
          : `主播${hostName}这段 ${rangeLabel} 转写 ${coverage.speechFinalCount} 句，参考要点讲到 ${coveredCount}/${totalPoints}。下一场保持这套，对照成交更好的时段。`,
        citedNumbers: summaryCited
      };

  const strengths = buildStrengths(coverage);
  const gaps = buildGaps(coverage);
  const timeline = highlightWindows(input);
  const nextSteps = buildNextSteps(hostName, coverage, timeline);

  return {
    summary,
    strengths,
    gaps,
    timeline,
    nextSteps
  };
}

export function assembleAnchorReview(input: {
  hostName: string;
  sessionId: string;
  rangeStartAt: string;
  rangeEndAt: string;
  generatedAt: string;
  coverage: AnchorSessionReport;
  windows: readonly LiveWindowAggregate[];
}): AnchorReview {
  const narrative = buildAnchorReviewNarrative(input);
  const dataNotes = [
    "转写里没有出现不等于主播没讲；只说明这段转写没命中关键词。",
    "只纳入已经结束的15分钟时段。开播中请把副驾留在原来的标签，不要重新点扩展连接。"
  ];
  return anchorReviewSchema.parse({
    schemaVersion: 1,
    hostName: input.hostName,
    sessionId: input.sessionId,
    rangeStartAt: input.rangeStartAt,
    rangeEndAt: input.rangeEndAt,
    generatedAt: input.generatedAt,
    provider: "deterministic-template",
    promptVersion: ANCHOR_REVIEW_PROMPT_VERSION,
    scriptVersion: input.coverage.scriptVersion,
    coverage: input.coverage,
    narrative,
    dataNotes
  });
}
