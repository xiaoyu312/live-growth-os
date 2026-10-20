import {
  mvpActionSchema,
  type MvpAction,
  type MvpActionKey,
  type MvpMetricPoint,
  type MvpProduct,
  type MvpProductMetric,
  type MvpStateId
} from "@live-growth/contracts";

export type LiveStateEngineConfig = {
  warmupSec: number;
  staleSec: number;
  confirmationPoints: number;
  surgeConfirmationPoints: number;
  exitConfirmationPoints: number;
  minClicks: number;
  minUnpaid: number;
  lowRetention: number;
  highRetention: number;
  surgeEntersPerMin: number;
  surgeVs5mBaseline: number;
  lowTrafficEntersPerMin: number;
  highClickRate: number;
  lowPayRate: number;
  standoutMultiplier: number;
  /** 最近切品后的观察窗口，避免把切品瞬间的支付缺口当作稳定问题。 */
  recentProductSwitchSec?: number;
  /** 投流消耗或相对投流基线突变时的抑制阈值。 */
  trafficSpikeThreshold?: number;
  scarcityInventoryThreshold?: number;
  scarcityOfferWindowSec?: number;
};

export const DEFAULT_LIVE_STATE_ENGINE_CONFIG: Readonly<LiveStateEngineConfig> = {
  warmupSec: 180, staleSec: 30, confirmationPoints: 4, surgeConfirmationPoints: 2, exitConfirmationPoints: 4,
  minClicks: 5, minUnpaid: 2, lowRetention: 0.35, highRetention: 0.55, surgeEntersPerMin: 18,
  lowTrafficEntersPerMin: 8, surgeVs5mBaseline: 1.6, highClickRate: 0.12, lowPayRate: 0.04, standoutMultiplier: 1.5,
  recentProductSwitchSec: 60, trafficSpikeThreshold: 0.3, scarcityInventoryThreshold: 10, scarcityOfferWindowSec: 900
};

export type LiveStateCandidate = {
  state: MvpStateId;
  topIntentProductId: string | undefined;
  reason: string;
  productStrategy: string;
  priority: "low" | "medium" | "high" | "critical";
  actionKey: MvpActionKey;
  evidence: Array<{ type: "metric" | "speech" | "context"; label: string; value: string }>;
  realScarcity: boolean;
  missingCoverage?: string[];
};

export type LiveStateDecision = {
  state: MvpStateId | null;
  stateName: string;
  confidence: "high" | "medium" | "low";
  preheat: boolean;
  stale: boolean;
  candidate: LiveStateCandidate | null;
  topIntentProductId: string | undefined;
  stateDurationSec: number;
};

export type LiveStateEngineInput = {
  point: MvpMetricPoint;
  history: readonly MvpMetricPoint[];
  products: readonly MvpProduct[];
  now?: string;
};

const STATE_NAMES: Record<MvpStateId, string> = {
  S0: "稳定运行，无需干预", S1: "流量突然涌入，正在接流", S2: "进人较多但留不住", S3: "低流量但高意向",
  S4: "点击较高但支付偏低", S5: "商品表现突出", S6: "整体低效，需要复位"
};
const PRIORITY: MvpStateId[] = ["S2", "S4", "S1", "S5", "S3", "S6", "S0"];

function productMetric(point: MvpMetricPoint, productId: string): MvpProductMetric {
  return point.products.find((item) => item.productId === productId) ?? {
    productId, exposure5m: 0, clicks5m: 0, unpaid5m: 0, paidBuyers5m: 0, gmvFen5m: 0
  };
}

function rate(value: number, denominator: number): number { return denominator > 0 ? value / denominator : 0; }
function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function productLabel(products: readonly MvpProduct[], productId: string | undefined): string {
  if (!productId) return "待确认商品";
  return products.find((item) => item.productId === productId)?.name ?? productId;
}

function topIntent(point: MvpMetricPoint): string | undefined {
  if (point.topIntentProductId) return point.topIntentProductId;
  const ranked = point.products.map((item) => ({
    item, score: item.clicks5m * 2 + item.unpaid5m * 4 + item.paidBuyers5m * 8 + item.gmvFen5m / 100
  })).sort((left, right) => right.score - left.score || left.item.productId.localeCompare(right.item.productId));
  return ranked[0]?.score ? ranked[0].item.productId : undefined;
}

function buildEvidence(point: MvpMetricPoint, label: string, value: string, speech = false): LiveStateCandidate["evidence"] {
  const items: LiveStateCandidate["evidence"] = [{ type: "metric", label, value }];
  for (const text of point.speechEvidence.slice(0, 2)) items.push({ type: speech ? "speech" : "context", label: "最近话术", value: text });
  return items.slice(0, 3);
}

type CoverageGroup = { label: string; keys: string[] };
const S4_COVERAGE_GROUPS: CoverageGroup[] = [
  { label: "产品价值", keys: ["product_benefit", "product_efficacy", "usage_scenario", "suitable_audience"] },
  { label: "价格机制", keys: ["price", "offer"] },
  { label: "赠品", keys: ["gift"] },
  { label: "保障与售后", keys: ["guarantee", "after_sale"] },
  { label: "购买指令", keys: ["product_card_cta", "purchase_cta"] }
];

function coverageStatus(point: MvpMetricPoint, keys: readonly string[]): "present" | "absent" | "unknown" {
  const statuses = keys.map((key) => point.speechCoverage[key as keyof typeof point.speechCoverage]);
  if (statuses.includes("present")) return "present";
  if (statuses.length > 0 && statuses.every((status) => status === "absent")) return "absent";
  return "unknown";
}

function s4Coverage(point: MvpMetricPoint): { missing: string[]; present: string[]; unknown: string[] } {
  const statuses = S4_COVERAGE_GROUPS.map((group) => ({ group, status: coverageStatus(point, group.keys) }));
  return {
    missing: statuses.filter((item) => item.status === "absent").map((item) => item.group.label),
    present: statuses.filter((item) => item.status === "present").map((item) => item.group.label),
    unknown: statuses.filter((item) => item.status === "unknown").map((item) => item.group.label)
  };
}

function s4CoverageEvidence(point: MvpMetricPoint, coverage: ReturnType<typeof s4Coverage>): LiveStateCandidate["evidence"] {
  const evidence: LiveStateCandidate["evidence"] = [];
  const confirmed = [
    coverage.present.length ? `已覆盖：${coverage.present.join("、")}` : "",
    coverage.missing.length ? `确认缺失：${coverage.missing.join("、")}` : ""
  ].filter(Boolean).join("；");
  if (confirmed) evidence.push({ type: "speech", label: "话术覆盖摘要", value: confirmed });
  if (coverage.unknown.length) evidence.push({ type: "context", label: "无法确认话术", value: coverage.unknown.join("、") });
  return evidence.slice(0, 3);
}

function recentlySwitchedProduct(point: MvpMetricPoint, history: readonly MvpMetricPoint[], windowSec: number): boolean {
  for (let index = history.length - 1; index > 0; index -= 1) {
    const current = history[index];
    const previous = history[index - 1];
    if (!current || !previous || current.currentProductId === previous.currentProductId) continue;
    const ageSec = (Date.parse(point.at) - Date.parse(current.at)) / 1000;
    return ageSec >= 0 && ageSec <= windowSec;
  }
  return false;
}

function candidateFor(input: LiveStateEngineInput, config: LiveStateEngineConfig): LiveStateCandidate {
  const { point, history, products } = input;
  const previous = history.at(-2);
  const topId = topIntent(point);
  const current = productMetric(point, point.currentProductId);
  const top = topId ? productMetric(point, topId) : current;
  const clickRate = rate(current.clicks5m, current.exposure5m);
  const payRate = rate(current.paidBuyers5m, current.clicks5m);
  const currentEfficiency = rate(current.clicks5m + current.paidBuyers5m * 3, current.exposure5m);
  const efficiencies = point.products.map((item) => rate(item.clicks5m + item.paidBuyers5m * 3, item.exposure5m));
  const bestEfficiency = Math.max(0, ...efficiencies);
  const onlineFalling = previous ? point.online < previous.online * 0.92 : false;
  const recent5m = history.slice(Math.max(0, history.length - 61), -1).map((item) => item.enters1m);
  // Keep already-observed surge points out of the normal baseline so a
  // sustained two-point surge does not erase its own comparison baseline.
  const baselineSamples = recent5m.filter((value) => value < config.surgeEntersPerMin);
  const surgeBaseline = median(baselineSamples.length ? baselineSamples : recent5m);
  const surge = point.enters1m >= config.surgeEntersPerMin && point.enters1m >= Math.max(1, surgeBaseline) * config.surgeVs5mBaseline && (!previous || point.online >= previous.online * 1.01);
  const retentionDrop = point.retentionProxy < config.lowRetention && (onlineFalling || point.enters1m >= config.surgeEntersPerMin);
  const s2 = point.enters1m >= config.surgeEntersPerMin * 0.7 && retentionDrop;
  const recentSwitch = recentlySwitchedProduct(point, history, config.recentProductSwitchSec ?? 60);
  const trafficSpikeThreshold = config.trafficSpikeThreshold ?? 0.3;
  const previousTraffic = history.at(-2)?.traffic;
  const trafficSpike = (point.traffic.spendChangeRate5m >= trafficSpikeThreshold || point.traffic.trafficVs10mBaseline >= trafficSpikeThreshold)
    && (!previousTraffic || (previousTraffic.spendChangeRate5m < trafficSpikeThreshold && previousTraffic.trafficVs10mBaseline < trafficSpikeThreshold));
  const currentPaymentGap = current.clicks5m >= config.minClicks && clickRate >= config.highClickRate && payRate < config.lowPayRate;
  const topPaymentGap = Boolean(topId && topId !== point.currentProductId && top.clicks5m >= config.minClicks && rate(top.clicks5m, top.exposure5m) >= config.highClickRate && rate(top.paidBuyers5m, top.clicks5m) < config.lowPayRate);
  const s4 = (currentPaymentGap || topPaymentGap) && !recentSwitch && !trafficSpike;
  const s3 = point.enters1m <= config.lowTrafficEntersPerMin && point.retentionProxy >= config.highRetention && (top.clicks5m >= config.minClicks || top.unpaid5m >= config.minUnpaid);
  const s5 = point.enters1m > config.lowTrafficEntersPerMin && (bestEfficiency >= Math.max(0.01, currentEfficiency) * config.standoutMultiplier || (topId === point.currentProductId && current.clicks5m >= config.minClicks * 2 && current.paidBuyers5m >= 3)) && top.clicks5m >= config.minClicks;
  const allLow = point.enters1m <= config.lowTrafficEntersPerMin / 2 && point.retentionProxy < config.lowRetention && point.products.every((item) => item.clicks5m < config.minClicks && item.paidBuyers5m === 0);
  const selected: MvpStateId = s2 ? "S2" : s4 ? "S4" : surge ? "S1" : s5 ? "S5" : s3 ? "S3" : allLow ? "S6" : "S0";
  const currentName = productLabel(products, point.currentProductId);
  const topName = productLabel(products, topId);
  const topDiffers = Boolean(topId && topId !== point.currentProductId && (topPaymentGap || top.clicks5m >= current.clicks5m + config.minClicks));
  const topType = products.find((item) => item.productId === topId)?.type;
  const topStrategy = topType === "low_price_new_customer" ? "切换低客单新客引流品" : topType === "high_price_repeat_customer" ? "切换高客单老客复购品" : "切换到实际高意向商品";
  const topSwitchStrategy = "切到真实高意向商品＋快速塑品＋价格机制收口";
  const inventoryThreshold = config.scarcityInventoryThreshold ?? 10;
  const offerWindowSec = config.scarcityOfferWindowSec ?? 900;
  const offerRemainingSec = current.offerEndsAt ? (Date.parse(current.offerEndsAt) - Date.parse(point.at)) / 1000 : undefined;
  const scarcity = (current.inventory !== undefined && current.inventory > 0 && current.inventory <= inventoryThreshold)
    || (offerRemainingSec !== undefined && offerRemainingSec >= 0 && offerRemainingSec <= offerWindowSec);
  switch (selected) {
    case "S1":
      return topDiffers
        ? { state: "S1", topIntentProductId: topId, reason: `最近 1 分钟直播间进入 ${point.enters1m} 人，当前在线正在上涨，但「${topName}」的意向高于当前商品。`, productStrategy: topStrategy, priority: "high", actionKey: "switch_to_top_intent", evidence: buildEvidence(point, "最近 1 分钟直播间进入", `${point.enters1m} 人`), realScarcity: false }
        : { state: "S1", topIntentProductId: topId, reason: `最近 1 分钟直播间进入 ${point.enters1m} 人，高于本场短期基线。`, productStrategy: `保持「${currentName}」，先承接新进入用户`, priority: "high", actionKey: "retain_and_rehook", evidence: buildEvidence(point, "流量突增", `${point.enters1m} 人／分钟`), realScarcity: false };
    case "S2":
      return { state: "S2", topIntentProductId: topId, reason: `最近 1 分钟直播间进入 ${point.enters1m} 人，但留存代理仅 ${(point.retentionProxy * 100).toFixed(0)}%，当前在线没有站住。`, productStrategy: "先留住新进入用户，再决定是否切商品", priority: "critical", actionKey: "shorten_and_retain", evidence: buildEvidence(point, "留存代理", `${(point.retentionProxy * 100).toFixed(0)}%`, true), realScarcity: false };
    case "S3":
      return topDiffers
        ? { state: "S3", topIntentProductId: topId, reason: `流量不高，但「${topName}」点击和未支付意向集中，当前讲解的是「${currentName}」。`, productStrategy: topStrategy, priority: "medium", actionKey: "switch_to_top_intent", evidence: buildEvidence(point, "高意向商品", `${topName} 点击 ${top.clicks5m}、未支付 ${top.unpaid5m}`), realScarcity: false }
        : { state: "S3", topIntentProductId: topId, reason: `流量不高，但「${currentName}」已有稳定点击和未支付意向。`, productStrategy: "保持真实高意向商品并做短收口", priority: "medium", actionKey: "close_high_intent", evidence: buildEvidence(point, "高意向商品", `${currentName} 点击 ${current.clicks5m}、未支付 ${current.unpaid5m}`), realScarcity: false };
    case "S4":
      if (topDiffers) return { state: "S4", topIntentProductId: topId, reason: `点击集中在真实高意向商品「${topName}」，但其点击后支付仅 ${(rate(top.paidBuyers5m, top.clicks5m) * 100).toFixed(1)}%，当前商品「${currentName}」不是优先承接对象。`, productStrategy: topSwitchStrategy, priority: "critical", actionKey: "switch_to_top_intent", evidence: ([{ type: "metric", label: "高意向商品点击后支付", value: `${topName}：点击 ${top.clicks5m}，支付 ${(rate(top.paidBuyers5m, top.clicks5m) * 100).toFixed(1)}%` }, ...buildEvidence(point, "当前商品点击后支付", `${(payRate * 100).toFixed(1)}%`)] as LiveStateCandidate["evidence"]).slice(0, 3), realScarcity: false };
      {
        const coverage = s4Coverage(point);
        const actionKey: MvpActionKey = coverage.missing.length ? (scarcity ? "complete_closure_with_real_scarcity" : "complete_closure") : "continue_observing";
        const coreStatus = coverage.missing.length
          ? `已确认缺失：${coverage.missing.join("、")}。`
          : coverage.unknown.length
            ? `已覆盖：${coverage.present.join("、") || "暂无可确认环节"}；无法确认：${coverage.unknown.join("、")}。`
            : "产品价值、价格机制、赠品、保障与购买指令均已覆盖。";
        return {
          state: "S4", topIntentProductId: topId,
          reason: `「${currentName}」最近 5 分钟点击 ${current.clicks5m}，点击后支付仅 ${(payRate * 100).toFixed(1)}%。${coreStatus}`,
          productStrategy: coverage.missing.length ? "只补齐确认缺失环节，再完成一次短收口" : "话术基础环节已覆盖，优先检查商品竞争力、人群匹配和下单链路",
          priority: coverage.missing.length ? "critical" : "medium", actionKey, evidence: ([{ type: "metric", label: "点击后支付转化", value: `${(payRate * 100).toFixed(1)}%` }, ...s4CoverageEvidence(point, coverage)] as LiveStateCandidate["evidence"]).slice(0, 3), realScarcity: actionKey === "complete_closure_with_real_scarcity",
          missingCoverage: coverage.missing
        };
      }
    case "S5":
      return topDiffers
        ? { state: "S5", topIntentProductId: topId, reason: `「${topName}」效率突出，且点击样本充足。`, productStrategy: topStrategy, priority: "high", actionKey: "switch_to_top_intent", evidence: buildEvidence(point, "商品效率", `${topName} 表现突出`), realScarcity: false }
        : { state: "S5", topIntentProductId: topId, reason: `当前商品「${currentName}」表现突出，点击和支付效率均达到乘胜条件。`, productStrategy: "保持当前商品并完成简短闭环，不延长讲解", priority: "high", actionKey: "keep_and_short_close", evidence: buildEvidence(point, "当前商品表现", `点击 ${current.clicks5m}、支付 ${current.paidBuyers5m}`), realScarcity: false };
    case "S6":
      return topType === "low_price_new_customer"
        ? { state: "S6", topIntentProductId: topId, reason: "进入、留存和商品意向都偏低，当前没有足够证据推荐高客单商品。", productStrategy: "切换低客单新客引流品重新建立首次成交", priority: "high", actionKey: "switch_to_top_intent", evidence: buildEvidence(point, "整体效率", "进入、留存、点击和支付均偏低"), realScarcity: false }
        : { state: "S6", topIntentProductId: topId, reason: "进入、留存、点击和支付都持续偏低，当前需要结束低效段落。", productStrategy: "重新开一轮简短开场，优先建立首次成交", priority: "high", actionKey: "reset_segment", evidence: buildEvidence(point, "整体效率", "进入、留存、点击和支付均偏低"), realScarcity: false };
    case "S0":
    default:
      return { state: "S0", topIntentProductId: topId, reason: "数据已完成预热，当前没有一个值得打断直播节奏的明确问题。", productStrategy: "继续观察，不主动打断", priority: "low", actionKey: "none", evidence: buildEvidence(point, "当前状态", "未发现需要干预的状态"), realScarcity: false };
  }
}

export function evaluateLiveState(input: LiveStateEngineInput, config: LiveStateEngineConfig = DEFAULT_LIVE_STATE_ENGINE_CONFIG): LiveStateDecision {
  const { point, history } = input;
  const firstAt = history[0]?.at ?? point.at;
  const elapsedSec = Math.max(0, (Date.parse(point.at) - Date.parse(firstAt)) / 1000);
  const stale = Boolean(input.now && Date.parse(input.now) - Date.parse(point.at) > config.staleSec * 1000);
  if (stale) return { state: null, stateName: "数据暂时中断，暂停状态判断", confidence: "low", preheat: false, stale: true, candidate: null, topIntentProductId: undefined, stateDurationSec: 0 };
  if (!point.dataComplete || elapsedSec < config.warmupSec) {
    return { state: null, stateName: "数据积累中，暂不判断", confidence: "low", preheat: true, stale: false, candidate: null, topIntentProductId: topIntent(point), stateDurationSec: 0 };
  }
  const candidate = candidateFor(input, config);
  const confidence = history.length >= config.confirmationPoints ? "high" : "medium";
  // This pure evaluator only identifies the current candidate.  Duration is
  // owned by LiveStateEngine because it depends on the confirmed state entry
  // point, not on the first point in the input history.
  return { state: candidate.state, stateName: STATE_NAMES[candidate.state], confidence, preheat: false, stale: false, candidate, topIntentProductId: candidate.topIntentProductId, stateDurationSec: 0 };
}

export class LiveStateEngine {
  private history: MvpMetricPoint[] = [];
  private currentState: MvpStateId | null = null;
  private stateEnteredAt: string | undefined;
  private pendingState: MvpStateId | null = null;
  private pendingCount = 0;
  private lastActionKey = "";

  constructor(private readonly products: readonly MvpProduct[], private readonly config: LiveStateEngineConfig = DEFAULT_LIVE_STATE_ENGINE_CONFIG) {}

  reset(): void {
    this.history = [];
    this.currentState = null;
    this.stateEnteredAt = undefined;
    this.pendingState = null;
    this.pendingCount = 0;
    this.lastActionKey = "";
  }

  process(point: MvpMetricPoint, now?: string, check = true): { decision: LiveStateDecision; action: MvpAction | null } {
    const rawDecision = evaluateLiveState(now === undefined
      ? { point, history: [...this.history, point], products: this.products }
      : { point, history: [...this.history, point], products: this.products, now }, this.config);
    this.history.push(point);
    if (rawDecision.preheat || rawDecision.stale || !rawDecision.state) return { decision: rawDecision, action: null };
    const candidateState = rawDecision.state;

    // A metric point may arrive every five seconds, while state checks are
    // intentionally less frequent.  Observing a point must never advance a
    // pending transition or bypass its confirmation window.
    if (!check) {
      // A surge is confirmed from two consecutive raw five-second points, but
      // the action is still emitted only on the next ten-second check boundary.
      if (candidateState === "S1") {
        if (this.pendingState === "S1") this.pendingCount += 1;
        else { this.pendingState = "S1"; this.pendingCount = 1; }
      } else if (this.pendingState === "S1") {
        this.pendingState = null;
        this.pendingCount = 0;
      }
      return { decision: this.confirmedDecision(rawDecision, point), action: null };
    }

    if (this.currentState === candidateState) {
      this.pendingState = null;
      this.pendingCount = 0;
      return { decision: this.confirmedDecision(rawDecision, point), action: null };
    }

    if (this.pendingState !== candidateState) {
      this.pendingState = candidateState;
      this.pendingCount = 1;
    } else {
      this.pendingCount += 1;
    }

    // Initial entry uses the state-specific entry confirmation.  Every later
    // leave/switch uses the separately configured exit confirmation, so a
    // transient candidate cannot immediately flip the active state.
    const needed = candidateState === "S1"
      ? this.config.surgeConfirmationPoints
      : this.currentState === null ? this.config.confirmationPoints : this.config.exitConfirmationPoints;
    if (this.pendingCount < needed) {
      return { decision: { ...rawDecision, state: this.currentState, stateName: this.currentState ? STATE_NAMES[this.currentState] : rawDecision.stateName, stateDurationSec: this.durationAt(point.at) }, action: null };
    }

    this.currentState = candidateState;
    this.stateEnteredAt = point.at;
    this.pendingState = null;
    this.pendingCount = 0;
    const decision = this.confirmedDecision(rawDecision, point);
    if (!decision.candidate || decision.candidate.actionKey === "none") { this.lastActionKey = ""; return { decision, action: null }; }
    const actionKey = `${candidateState}:${decision.candidate.actionKey}:${decision.candidate.topIntentProductId ?? point.currentProductId}`;
    if (actionKey === this.lastActionKey) return { decision, action: null };
    this.lastActionKey = actionKey;
    const action = mvpActionSchema.parse({
      id: `mvp:${Date.parse(point.at)}:${actionKey.replace(/[^a-zA-Z0-9:_-]/g, "_")}`,
      state: decision.candidate.state, actionKey: decision.candidate.actionKey, priority: decision.candidate.priority,
      coreInstruction: actionInstruction(decision.candidate, point, this.products), whatHappened: decision.candidate.reason,
      why: decision.candidate.reason, productStrategy: decision.candidate.productStrategy, evidence: decision.candidate.evidence,
      createdAt: point.at, expiresAt: new Date(Date.parse(point.at) + 300_000).toISOString(), currentProductId: point.currentProductId,
      ...(decision.candidate.topIntentProductId ? { topIntentProductId: decision.candidate.topIntentProductId } : {}), realScarcity: decision.candidate.realScarcity
    });
    return { decision, action };
  }

  private durationAt(at: string): number {
    if (!this.stateEnteredAt) return 0;
    return Math.max(0, (Date.parse(at) - Date.parse(this.stateEnteredAt)) / 1000);
  }

  private confirmedDecision(raw: LiveStateDecision, point: MvpMetricPoint): LiveStateDecision {
    if (!this.currentState) return { ...raw, state: null, stateName: "数据积累中，暂不判断", stateDurationSec: 0 };
    return { ...raw, state: this.currentState, stateName: STATE_NAMES[this.currentState], confidence: "high", stateDurationSec: this.durationAt(point.at) };
  }
}

function actionInstruction(candidate: LiveStateCandidate, point: MvpMetricPoint, products: readonly MvpProduct[]): string {
  const current = productLabel(products, point.currentProductId);
  const top = productLabel(products, candidate.topIntentProductId);
  switch (candidate.actionKey) {
    case "retain_and_rehook": return `先保持「${current}」，用一句核心利益点接住新进来的用户，再补一个明确点小黄车指令。`;
    case "switch_to_top_intent": return candidate.productStrategy.includes("快速塑品")
      ? `结束当前段落，切到真实高意向商品「${top}」，快速塑品并完成价格机制收口。`
      : `结束当前段落，切到意向最高的「${top}」，先讲适用人群和核心价值。`;
    case "shorten_and_retain": return "现在收短，下一分钟直接讲使用场景和用户利益，随后强化点小黄车指令。";
    case "close_high_intent": return `不要换掉「${current}」，用价格、保障和一句下单指令做短收口。`;
    case "complete_closure_with_real_scarcity": return `保持「${current}」，只补充${candidate.missingCoverage?.join("、") || "确认缺失环节"}，再用已确认的库存或时限完成一次收口。`;
    case "complete_closure": return `保持「${current}」，只补充${candidate.missingCoverage?.join("、") || "确认缺失环节"}，完成一次简短收口。`;
    case "keep_and_short_close": return `保持「${current}」，重抛最强利益点后做一次简短收口，不延长讲解。`;
    case "reset_segment": return "结束当前低效段落，用目标人群、一个核心痛点和低客单商品价值重新开一轮。";
    case "continue_observing": return "话术基础环节已覆盖，当前支付偏低未必来自话术缺失；运营优先检查商品竞争力、人群匹配或下单链路。";
    default: return "继续观察，不主动打断当前直播节奏。";
  }
}

export const STATE_PRIORITY = PRIORITY;
export { STATE_NAMES };
