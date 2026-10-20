import { createHash, randomUUID } from "node:crypto";
import {
  liveEventSchema, mvpActionSchema, mvpFeedbackSchema, mvpFullReviewSchema, mvpMetricPointSchema,
  mvpProductSchema, mvpRealReplayReviewSchema, mvpSessionSchema, mvpSmallReviewSchema, mvpStateSnapshotSchema, type LiveEvent, type MvpAction,
  type MvpFeedback, type MvpFullReview, type MvpMetricPoint, type MvpProduct, type MvpSmallReview,
  type MvpSession, type MvpStateId, type MvpStateSnapshot, type Session
} from "@live-growth/contracts";
import { DEFAULT_LIVE_STATE_ENGINE_CONFIG, LiveStateEngine, type LiveStateDecision } from "@live-growth/rules";
import { generateMvpRealReplay, generateMvpSimulation, MVP_PRODUCT_SEEDS, type MvpScenario, type MvpSimulationOptions } from "@live-growth/source-adapters";
import { isMvpStatePayload, type StateBus, type StateBusPayload } from "./state-bus";
import type { EventStore, MvpCatalogStore } from "./storage";

const OPERATOR_ID = "operator-demo";
const STATE_LABELS: Record<string, string> = {
  S0: "稳定运行", S1: "流量涌入，正在承接", S2: "进入较多，但留不住", S3: "低流量，高意向",
  S4: "点击较高，支付偏低", S5: "商品表现突出", S6: "整体低效，建议复位"
};
type MvpListener = (state: MvpStateSnapshot) => void;
export type MvpSessionScenario = MvpScenario | "mvp_real_session_001";

export class MvpSessionNotFoundError extends Error {}
export class MvpActionNotFoundError extends Error {}
export class MvpReviewNotReadyError extends Error {}
export class MvpFeedbackConflictError extends Error {}
export class MvpReadOnlySessionError extends Error {}

function mvpEvents(events: LiveEvent[]): LiveEvent[] { return events.filter((event) => event.kind === "mvp.point" || event.kind === "mvp.action" || event.kind === "mvp.feedback"); }
function seconds(start: string, end: string): number { return Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000); }
function mvpScenario(value: string): MvpScenario { return value as MvpScenario; }
function isRealReplay(session: MvpSession): boolean { return session.scenario === "mvp_real_session_001"; }
function boundedId(value: string): string {
  if (value.length <= 160) return value;
  return `${value.slice(0, 96)}:${createHash("sha256").update(value).digest("hex").slice(0, 48)}`;
}
function pointProduct(point: MvpMetricPoint, productId: string): MvpMetricPoint["products"][number] | undefined {
  return point.products.find((item) => item.productId === productId);
}
function windowValue(start: MvpMetricPoint, end: MvpMetricPoint, productId: string, field: "clicks5m" | "paidBuyers5m" | "gmvFen5m"): string {
  const before = pointProduct(start, productId)?.[field];
  const after = pointProduct(end, productId)?.[field];
  return before === undefined || after === undefined ? "样本不足" : `${before}→${after}`;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function formatMetric(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
function formatFenCurrency(value: number): string {
  const decimals = value % 100 === 0 ? 0 : 2;
  return `¥${(value / 100).toLocaleString("zh-CN", { minimumFractionDigits: decimals, maximumFractionDigits: 2 })}`;
}

// 5 秒采样点至少连续覆盖 1 分钟，才允许进入“表现较好状态”排名。
const MIN_PRODUCT_REVIEW_SAMPLES = 12;

function longestFiveSecondRun(timestamps: readonly string[]): number {
  if (!timestamps.length) return 0;
  const ordered = [...timestamps].map((value) => Date.parse(value)).sort((left, right) => left - right);
  let longest = 1;
  let current = 1;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]! - ordered[index - 1]! <= 5_500) current += 1;
    else current = 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

function productTypeSummary(
  pointStates: ReadonlyArray<{ point: MvpMetricPoint; state: MvpStateId | null }>,
  products: readonly MvpProduct[],
  type: MvpProduct["type"],
  typeLabel: string
): string {
  const ids = new Set(products.filter((item) => item.type === type).map((item) => item.productId));
  const rows = pointStates.filter(({ point }) => ids.has(point.currentProductId));
  if (!rows.length) return `${typeLabel}：样本不足`;
  const byState = new Map<string, { clicks: number[]; paid: number[]; gmv: number[]; timestamps: string[] }>();
  for (const { point, state } of rows) {
    const product = point.products.find((item) => item.productId === point.currentProductId);
    if (!product) continue;
    const key = state ?? "unknown";
    const current = byState.get(key) ?? { clicks: [], paid: [], gmv: [], timestamps: [] };
    current.clicks.push(product.clicks5m); current.paid.push(product.paidBuyers5m); current.gmv.push(product.gmvFen5m);
    current.timestamps.push(point.at);
    byState.set(key, current);
  }
  const summaries = [...byState.entries()].map(([state, value]) => {
    const clicks = median(value.clicks);
    const paid = median(value.paid);
    const gmv = median(value.gmv);
    const windows = value.clicks.length;
    const continuousSamples = longestFiveSecondRun(value.timestamps);
    return { state, clicks, paid, gmv, windows, continuousSamples, paymentRate: clicks > 0 ? paid / clicks : 0 };
  });
  const eligible = summaries.filter((item) => item.continuousSamples >= MIN_PRODUCT_REVIEW_SAMPLES);
  const ranked = [...eligible].sort((left, right) => right.paymentRate - left.paymentRate || right.gmv - left.gmv);
  const best = ranked[0];
  const facts = summaries.map((item) => {
    const label = STATE_LABELS[item.state] ?? "待判断";
    const coverage = `${item.windows} 个采样点，最长连续覆盖 ${item.continuousSamples} 个5秒点`;
    if (item.continuousSamples < MIN_PRODUCT_REVIEW_SAMPLES) return `${label}：样本不足，仅列观察（${coverage}，至少 1 分钟／${MIN_PRODUCT_REVIEW_SAMPLES} 个5秒点）`;
    return `${label}：典型 5 分钟窗口中位数，点击 ${formatMetric(item.clicks)}，支付 ${formatMetric(item.paid)}，GMV ${formatMetric(item.gmv)} 分，点击后支付转化率 ${(item.paymentRate * 100).toFixed(1)}%（${coverage}，重叠窗口不相加）`;
  });
  return `${typeLabel}：${facts.join("；")}；按中位窗口效率表现较好状态：${best ? (STATE_LABELS[best.state] ?? "待判断") : "样本不足"}。`;
}

export class MvpService {
  private readonly running = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private readonly listeners = new Map<string, Set<MvpListener>>();
  private readonly busUnsubscribers = new Set<() => Promise<void>>();
  private productsCache: MvpProduct[] | undefined;

  constructor(private readonly store: EventStore, private readonly bus?: StateBus) {}

  private catalog(): MvpCatalogStore | undefined {
    const candidate = this.store as EventStore & Partial<MvpCatalogStore>;
    return candidate.listMvpProducts && candidate.saveMvpProduct ? candidate as MvpCatalogStore : undefined;
  }

  async products(): Promise<MvpProduct[]> {
    if (this.productsCache) return structuredClone(this.productsCache);
    const catalog = this.catalog();
    const stored = catalog ? await catalog.listMvpProducts() : [];
    if (stored.length === 0 && catalog) for (const product of MVP_PRODUCT_SEEDS) await catalog.saveMvpProduct(product);
    this.productsCache = stored.length ? stored : [...MVP_PRODUCT_SEEDS];
    return structuredClone(this.productsCache);
  }

  async saveProduct(input: unknown): Promise<MvpProduct> {
    const product = mvpProductSchema.parse(input);
    const catalog = this.catalog();
    if (catalog) await catalog.saveMvpProduct(product);
    const existing = this.productsCache ?? await this.products();
    this.productsCache = [...existing.filter((item) => item.productId !== product.productId), product].sort((a, b) => a.productId.localeCompare(b.productId));
    return structuredClone(product);
  }

  async create(input: { name?: string; scenario: MvpSessionScenario; seed: number }): Promise<MvpSession> {
    const createdAt = new Date().toISOString();
    const session: MvpSession = {
      id: randomUUID(), tenantId: "tenant-demo", name: input.name ?? "AI 直播运营副驾演示场",
      scenario: mvpScenario(input.scenario) as Session["scenario"], seed: input.seed,
      includeCommentIntent: false, status: "created", createdAt
    };
    await this.products();
    return mvpSessionSchema.parse(await this.store.createSession(session as Session));
  }

  async getSession(id: string): Promise<MvpSession> {
    const session = await this.store.getSession(id);
    if (!session || !String(session.scenario).startsWith("mvp_")) throw new MvpSessionNotFoundError(`演示场次不存在：${id}`);
    return mvpSessionSchema.parse(session);
  }

  async state(id: string, reviewMinutes: 10 | 15 = 10): Promise<MvpStateSnapshot> {
    const session = await this.getSession(id);
    if (isRealReplay(session)) return this.realReplayState(session, reviewMinutes);
    const events = mvpEvents(await this.store.listEvents(id));
    const points = events.filter((event) => event.kind === "mvp.point").map((event) => mvpMetricPointSchema.parse(event.payload)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const products = await this.products();
    const engine = new LiveStateEngine(products);
    let decision: LiveStateDecision = { state: null, stateName: "数据积累中，暂不判断", confidence: "low", preheat: true, stale: false, candidate: null, topIntentProductId: undefined, stateDurationSec: 0 };
    for (let index = 0; index < points.length; index += 1) {
      decision = engine.process(points[index]!, undefined, index % 2 === 0).decision;
    }
    const latestPoint = points.at(-1) ?? null;
    const latestPointEvent = events
      .filter((event) => event.kind === "mvp.point")
      .sort((left, right) => Date.parse(left.ingestedAt) - Date.parse(right.ingestedAt))
      .at(-1);
    const latestIngestionAt = latestPointEvent ? Date.parse(latestPointEvent.ingestedAt) : Number.NaN;
    const ingestionStale = session.status === "running" && Number.isFinite(latestIngestionAt)
      && Date.now() - latestIngestionAt > DEFAULT_LIVE_STATE_ENGINE_CONFIG.staleSec * 1000;
    if (ingestionStale) {
      decision = {
        state: null, stateName: "数据暂时中断，暂停状态判断", confidence: "low", preheat: false, stale: true,
        candidate: null, topIntentProductId: latestPoint?.topIntentProductId, stateDurationSec: 0
      };
    }
    const actions = events.filter((event) => event.kind === "mvp.action").map((event) => mvpActionSchema.parse(event.payload));
    const feedback = events.filter((event) => event.kind === "mvp.feedback").map((event) => mvpFeedbackSchema.parse(event.payload));
    const latestAction = actions.at(-1) ?? null;
    const action = latestPoint && decision.state && decision.state !== "S0" && latestAction && latestAction.state === decision.state
      ? latestAction.actionKey === decision.candidate?.actionKey && decision.candidate
        ? {
          ...latestAction,
          // Keep one issue card/action ID while refreshing its current evidence;
          // a changed action key is handled by the replay as a new action event.
          whatHappened: decision.candidate.reason,
          why: decision.candidate.reason,
          productStrategy: decision.candidate.productStrategy,
          evidence: decision.candidate.evidence,
          realScarcity: decision.candidate.realScarcity
        }
        : latestAction
      : null;
    const smallReview = latestPoint && points.length > 1 && points[0] && seconds(points[0].at, latestPoint.at) >= reviewMinutes * 60
      ? await this.smallReviewFrom(session, points, actions, feedback, reviewMinutes, decision.state) : undefined;
    const snapshot = mvpStateSnapshotSchema.parse({
      session, state: decision.state, stateName: decision.stateName, confidence: decision.confidence, preheat: decision.preheat, stale: decision.stale,
      stateDurationSec: decision.stateDurationSec, updatedAt: latestPoint?.at ?? session.createdAt, currentHostId: "host-demo",
      currentProductId: latestPoint?.currentProductId ?? products[0]?.productId ?? "unknown-product", ...(latestPoint?.topIntentProductId ? { topIntentProductId: latestPoint.topIntentProductId } : {}), latestPoint,
      action, recentActions: actions.slice(-20), feedback, ...(smallReview ? { smallReview: { windowMinutes: smallReview.windowMinutes, lines: smallReview.lines } } : {}),
      eventCount: events.length, traffic: latestPoint?.traffic ?? null, metricTrend: points.slice(-120)
    });
    return snapshot;
  }

  async start(id: string, speed: number): Promise<MvpSession> {
    const session = await this.getSession(id);
    if (session.status === "completed") return session;
    if (session.status === "running" && this.running.has(id)) return session;
    if (session.status === "stopped") throw new Error("已停止演示场不能再次开始");
    if (isRealReplay(session)) {
      const now = new Date().toISOString();
      const completed: MvpSession = { ...session, status: "completed", startedAt: now, stoppedAt: now };
      await this.store.updateSession(completed as Session);
      await this.publish(id);
      return completed;
    }
    // Generate and validate the complete deterministic point stream before
    // changing the session status. A missing product type must leave the
    // session retryable in created, rather than leaving a stuck running
    // record with no replay task.
    const options: MvpSimulationOptions = { sessionId: id, seed: session.seed, scenario: mvpScenario(session.scenario), products: await this.products() };
    const points = generateMvpSimulation(options);
    const running: MvpSession = { ...session, status: "running", startedAt: new Date().toISOString() };
    await this.store.updateSession(running as Session);
    const persisted = mvpEvents(await this.store.listEvents(id)).filter((event) => event.kind === "mvp.point").map((event) => mvpMetricPointSchema.parse(event.payload));
    const seen = new Set(persisted.map((point) => point.at));
    const todo = points.filter((point) => !seen.has(point.at));
    const controller = new AbortController();
    const task = this.replay(id, running, todo, Math.max(1, Math.min(20, speed)), controller, persisted);
    this.running.set(id, { controller, task });
    void task.finally(() => { if (this.running.get(id)?.task === task) this.running.delete(id); });
    return running;
  }

  async stop(id: string): Promise<MvpSession> {
    const session = await this.getSession(id);
    this.running.get(id)?.controller.abort();
    if (session.status === "running") {
      const stopped: MvpSession = { ...session, status: "stopped", stoppedAt: new Date().toISOString() };
      await this.store.updateSession(stopped as Session);
      await this.publish(id);
      return stopped;
    }
    return session;
  }

  async feedback(id: string, input: { adviceId: string; status: MvpFeedback["status"]; operatorId?: string }): Promise<MvpFeedback> {
    if (isRealReplay(await this.getSession(id))) throw new MvpReadOnlySessionError("真实离线回放场次只读，不接受反馈事件写入");
    const state = await this.state(id);
    const existingFeedback = state.feedback.find((item) => item.adviceId === input.adviceId);
    if (existingFeedback) {
      if (existingFeedback.status === input.status) return existingFeedback;
      throw new MvpFeedbackConflictError("同一行动已经记录过执行结果，不能重复改写");
    }
    const action = state.recentActions.find((item) => item.id === input.adviceId) ?? state.action;
    if (!action || action.id !== input.adviceId) throw new MvpActionNotFoundError(`行动不存在：${input.adviceId}`);
    const point = state.latestPoint;
    if (!point) throw new MvpActionNotFoundError("没有可记录反馈的数据快照");
    const payload = mvpFeedbackSchema.parse({ adviceId: input.adviceId, status: input.status, operatorId: input.operatorId ?? OPERATOR_ID, createdAt: new Date().toISOString(), state: state.state, currentProductId: point.currentProductId, ...(point.topIntentProductId ? { topIntentProductId: point.topIntentProductId } : {}), snapshot: point });
    const inserted = await this.append(id, "mvp.feedback", payload, `${id}:mvp:feedback:${input.adviceId}`);
    if (!inserted) {
      const winner = (await this.state(id)).feedback.find((item) => item.adviceId === input.adviceId);
      if (winner?.status === input.status) return winner;
      throw new MvpFeedbackConflictError("同一行动已经记录过执行结果，不能重复改写");
    }
    await this.publish(id);
    return payload;
  }

  async smallReview(id: string, windowMinutes: 10 | 15 = 10): Promise<MvpSmallReview> {
    const session = await this.getSession(id);
    if (isRealReplay(session)) {
      if (windowMinutes !== 15) throw new MvpReviewNotReadyError("真实样本只有完整15分钟登记窗口，不能生成10分钟复盘");
      return this.realReplaySmallReview(session);
    }
    const events = mvpEvents(await this.store.listEvents(id));
    const points = events.filter((event) => event.kind === "mvp.point").map((event) => mvpMetricPointSchema.parse(event.payload));
    const actions = events.filter((event) => event.kind === "mvp.action").map((event) => mvpActionSchema.parse(event.payload));
    const feedback = events.filter((event) => event.kind === "mvp.feedback").map((event) => mvpFeedbackSchema.parse(event.payload));
    const currentState = (await this.state(id, windowMinutes)).state;
    return this.smallReviewFrom(session, points, actions, feedback, windowMinutes, currentState);
  }

  async fullReview(id: string): Promise<MvpFullReview> {
    const session = await this.getSession(id);
    if (isRealReplay(session)) return this.realReplayFullReview(session);
    const state = await this.state(id);
    const actions = state.recentActions;
    const events = mvpEvents(await this.store.listEvents(id));
    const points = events.filter((event) => event.kind === "mvp.point").map((event) => mvpMetricPointSchema.parse(event.payload)).sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    const products = await this.products();
    const pointStates: Array<{ point: MvpMetricPoint; state: MvpStateId | null }> = [];
    const reviewEngine = new LiveStateEngine(products);
    for (let index = 0; index < points.length; index += 1) pointStates.push({ point: points[index]!, state: reviewEngine.process(points[index]!, undefined, index % 2 === 0).decision.state });
    const actionChanges = actions.map((action) => {
      const before = points.find((point) => Date.parse(point.at) >= Date.parse(action.createdAt));
      const after = points.find((point) => Date.parse(point.at) >= Date.parse(action.createdAt) + 300_000) ?? points.at(-1);
      return before && after
        ? `行动后窗口首尾（${STATE_LABELS[action.state] ?? action.state}）：在线 ${before.online}→${after.online}；商品点击 ${windowValue(before, after, after.currentProductId, "clicks5m")}；支付人数 ${windowValue(before, after, after.currentProductId, "paidBuyers5m")}；GMV（分） ${windowValue(before, after, after.currentProductId, "gmvFen5m")}。`
        : `行动后窗口首尾（${STATE_LABELS[action.state] ?? action.state}）：样本不足，无法比较。`;
    });
    const repeatCounts = new Map<string, { count: number; label: string }>();
    for (const action of actions) {
      const key = action.state;
      const current = repeatCounts.get(key) ?? { count: 0, label: STATE_LABELS[action.state] ?? action.state };
      current.count += 1;
      repeatCounts.set(key, current);
    }
    const repeated = [...repeatCounts.values()].filter((item) => item.count >= 2);
    const repeatSummary = repeated.length
      ? repeated.map((item) => `${item.label} ${item.count} 次`).join("；")
      : "没有同一问题在多个行动窗口重复出现（重复次数 0 次）。";
    const speechEvidence: Array<{ at: string; text: string }> = [];
    let previousSpeech = "";
    for (const point of points) {
      for (const text of point.speechEvidence) {
        if (text === previousSpeech) continue;
        speechEvidence.push({ at: point.at, text });
        previousSpeech = text;
      }
    }
    const observedExperiments = actions.map((action) => {
      const product = products.find((item) => item.productId === action.currentProductId)?.name ?? action.currentProductId;
      return `在「${product}」的${STATE_LABELS[action.state] ?? action.state}窗口验证：${action.coreInstruction}`;
    });
    const observedPairs = pointStates.map(({ point, state }) => `${state ?? "unknown"}:${point.currentProductId}`);
    for (const pair of observedPairs) {
      if (observedExperiments.length >= 3) break;
      const [state, productId] = pair.split(":");
      const product = products.find((item) => item.productId === productId)?.name ?? productId;
      const candidate = `在「${product}」的${STATE_LABELS[state!] ?? "待判断"}窗口验证当前商品点击、支付和 GMV 的后续变化。`;
      if (!observedExperiments.includes(candidate)) observedExperiments.push(candidate);
    }
    const nextExperiments = observedExperiments.slice(0, 3);
    const highlighted = [
      { title: "本场经历的关键状态", summary: actions.length ? actions.map((item) => STATE_LABELS[item.state] ?? item.state).filter((item, index, all) => all.indexOf(item) === index).join("、") : "稳定观察为主", evidence: actions.slice(0, 3).map((item) => item.whatHappened) },
      { title: "主要建议与后续变化", summary: actions.length ? `系统共给出 ${actions.length} 条主要行动；${actionChanges.join("；")}` : "本场没有主动行动", evidence: actionChanges.length ? actionChanges : ["本场没有完整可比窗口，样本不足。"] },
      { title: "两类商品表现", summary: points.length ? "按确认状态和每个采样点的典型 5 分钟滚动窗口中位数比较；重叠窗口不相加，不能视作整场总量。" : "没有可比较的商品窗口。", evidence: points.length ? [productTypeSummary(pointStates, products, "low_price_new_customer", "低客单新客商品"), productTypeSummary(pointStates, products, "high_price_repeat_customer", "高客单复购商品")] : ["样本不足"] },
      { title: "反复出现的问题", summary: repeatSummary, evidence: repeated.length ? repeated.map((item) => `${item.label} ${item.count} 次`) : ["没有同一问题在多个行动窗口重复出现（重复次数 0 次）。"] },
      { title: "下一场值得验证的动作", summary: "以下动作均从本场实际状态、商品和行动证据整理，仍需下一场对照验证。", evidence: nextExperiments.length === 3 ? nextExperiments : [...nextExperiments, "本场实际证据不足三个动作，下一场先补齐可比窗口。"].slice(0, 3) }
    ];
    return mvpFullReviewSchema.parse({ sessionId: id, highlighted, details: actions.map((item, index) => `${STATE_LABELS[item.state] ?? item.state}：${item.coreInstruction}；${actionChanges[index] ?? "后续窗口样本不足。"}`), speechEvidence, limitation: "建议执行后数据变化只表示时间上的关联，不能证明因果。" });
  }

  private realReplayState(session: MvpSession, reviewMinutes: 10 | 15): MvpStateSnapshot { throw new Error("PUBLIC_REPLAY_DATA_NOT_INCLUDED"); }

  private realReplaySmallReview(session: MvpSession): MvpSmallReview { throw new Error("PUBLIC_REPLAY_DATA_NOT_INCLUDED"); }

  private realReplayFullReview(session: MvpSession): MvpFullReview { throw new Error("PUBLIC_REPLAY_DATA_NOT_INCLUDED"); }

  subscribe(id: string, listener: MvpListener): () => void {
    let active = true;
    let unsubscribeBus: (() => Promise<void>) | undefined;
    const listeners = this.listeners.get(id) ?? new Set<MvpListener>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    const deliver = (state: StateBusPayload): void => { if (active && isMvpStatePayload(state)) listener(state); };
    if (this.bus) {
      void this.bus.subscribe(id, deliver).then((unsubscribe) => {
        if (!active) { void unsubscribe(); return; }
        unsubscribeBus = unsubscribe;
        this.busUnsubscribers.add(unsubscribe);
      }).catch((error: unknown) => {
        if (!active) return;
        void error;
        console.error("mvp_state_subscribe_failed", { sessionId: id, message: "实时广播订阅失败，本地状态监听仍保留" });
      });
    }
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
      if (unsubscribeBus) { this.busUnsubscribers.delete(unsubscribeBus); void unsubscribeBus(); }
    };
  }

  private async replay(id: string, session: MvpSession, points: MvpMetricPoint[], speed: number, controller: AbortController, priorPoints: MvpMetricPoint[] = []): Promise<void> {
    const products = await this.products();
    const engine = new LiveStateEngine(products);
    const orderedPrior = [...priorPoints].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (let index = 0; index < orderedPrior.length; index += 1) engine.process(orderedPrior[index]!, undefined, index % 2 === 0);
    const offset = orderedPrior.length;
    for (let index = 0; index < points.length; index += 1) {
      if (controller.signal.aborted) return;
      const point = points[index]!;
      await this.append(id, "mvp.point", point, `${id}:mvp:point:${point.at}`);
      const result = engine.process(point, undefined, (offset + index) % 2 === 0);
      // Metrics arrive every five seconds; state checks and action creation happen every ten seconds.
      if ((offset + index) % 2 === 0 && result.action) {
        const action = mvpActionSchema.parse({ ...result.action, id: `${id}:${result.action.id}` });
        await this.append(id, "mvp.action", action, `${id}:mvp:action:${action.id}`);
      }
      await this.publish(id);
      if (index < points.length - 1) await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.round(5_000 / speed))));
    }
    const current = await this.getSession(id);
    if (current.status === "running") { await this.store.updateSession({ ...current, status: "completed", stoppedAt: new Date().toISOString() } as Session); await this.publish(id); }
  }

  private async append(id: string, kind: "mvp.point" | "mvp.action" | "mvp.feedback", payload: unknown, dedupeKey: string): Promise<boolean> {
    const session = await this.getSession(id);
    const at = kind === "mvp.point" ? (payload as MvpMetricPoint).at : kind === "mvp.action" ? (payload as MvpAction).createdAt : (payload as MvpFeedback).createdAt;
    const compact = boundedId(dedupeKey);
    const event = liveEventSchema.parse({ schemaVersion: 1, eventId: compact, dedupeKey: compact, tenantId: session.tenantId, sessionId: id, eventAt: at, capturedAt: at, ingestedAt: new Date().toISOString(), source: kind === "mvp.feedback" ? "operator" : kind === "mvp.action" ? "system" : "simulator", kind, provisional: false, payload });
    return this.store.appendEvent(event);
  }

  private async publish(id: string): Promise<void> {
    const state = await this.state(id);
    if (this.bus) {
      try {
        // Persist first; a broadcast failure must never roll back the authoritative event log.
        await this.bus.publish(id, state);
        return;
      } catch (error: unknown) {
        void error;
        console.error("mvp_state_publish_failed", { sessionId: id, message: "实时广播失败，权威状态已持久化" });
      }
    }
    for (const listener of this.listeners.get(id) ?? []) listener(state);
  }

  private async smallReviewFrom(session: MvpSession, points: MvpMetricPoint[], actions: MvpAction[], feedback: MvpFeedback[], windowMinutes: 10 | 15, currentState: MvpStateId | null = null): Promise<MvpSmallReview> {
    const end = points.at(-1)?.at ?? session.createdAt;
    const first = points[0]?.at;
    const hasWindow = Boolean(first && points.length > 1 && seconds(first, end) >= windowMinutes * 60);
    if (!hasWindow) throw new MvpReviewNotReadyError(`尚未形成完整的 ${windowMinutes} 分钟小复盘窗口`);
    const start = new Date(Date.parse(end) - windowMinutes * 60_000).toISOString();
    const recent = actions.filter((item) => Date.parse(item.createdAt) >= Date.parse(start));
    const latest = points.at(-1);
    const previous = points.find((item) => Date.parse(item.at) >= Date.parse(start));
    const action = recent.at(-1);
    const actionFeedback = action ? feedback.find((item) => item.adviceId === action.id) : undefined;
    const latestProductId = latest?.currentProductId;
    const metricLine = previous && latest && latestProductId
      ? `在线 ${previous.online}→${latest.online}；当前商品点击 ${windowValue(previous, latest, latestProductId, "clicks5m")}；支付人数 ${windowValue(previous, latest, latestProductId, "paidBuyers5m")}；GMV（分） ${windowValue(previous, latest, latestProductId, "gmvFen5m")}`
      : "样本不足，暂无法比较在线、点击、支付人数和 GMV。";
    const feedbackLine = actionFeedback?.status === "executed" ? "现场已执行。" : actionFeedback?.status === "not_executed" ? "现场未执行。" : actionFeedback?.status === "not_applicable" ? "现场标记为不适用。" : "没有收到执行反馈。";
    const problemLine = !action ? "当前没有待解决的主要问题。" : currentState === null ? "当前数据不足，无法判断问题是否仍存在。" : currentState === action.state ? "同一问题仍存在，继续观察下一窗口。" : "当前状态已变化，原问题可能已缓解或已切换。";
    const lines = [
      `发生：${start.slice(11, 16)}—${end.slice(11, 16)}，${action?.whatHappened ?? "直播状态保持观察。"}`,
      `建议与执行反馈：${action?.coreInstruction ?? "当前没有需要打断节奏的主要行动。"}；${feedbackLine}`,
      `后续数据：${metricLine}`,
      `问题是否解决：${problemLine}`
    ];
    return mvpSmallReviewSchema.parse({ windowMinutes, startAt: start, endAt: end, lines });
  }

  async close(): Promise<void> {
    for (const item of this.running.values()) item.controller.abort();
    await Promise.allSettled([...this.running.values()].map((item) => item.task));
    const unsubscribers = [...this.busUnsubscribers];
    this.busUnsubscribers.clear();
    await Promise.allSettled(unsubscribers.map((unsubscribe) => unsubscribe()));
    this.listeners.clear();
  }
}
