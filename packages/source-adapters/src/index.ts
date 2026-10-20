import { liveEventSchema, type CanonicalMetricSnapshot, type LiveEvent, type ProductRound, type Scenario, type SourceHealth, type SpeechTag, type TranscriptSegment } from "@live-growth/contracts";
import { HISTORICAL_CONCURRENT_VIEWERS_CALIBRATION, HISTORICAL_TIME_PROFILES, type HistoricalTimeProfile } from "./calibrations/historical";
// Public time profiles are independently synthetic; they contain no historical calibration.

export * from "./calibrations/historical";
export * from "./offline-real-session";
export * from "./audio-first";
export * from "./v01-simulator";
export * from "./real-session-replay";
export * from "./compass-live";
export * from "./qianchuan-live";
export * from "./qianchuan-official-live";
export * from "./historical-hours";
export * from "./historical-hours-sync";

export interface AdapterContext {
  tenantId: string;
  sessionId: string;
  seed: number;
}

export interface SourceAdapter {
  id: string;
  type: string;
  start(context: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<SourceHealth>;
  normalize(raw: unknown): LiveEvent[];
}

export interface SimulationOptions extends AdapterContext {
  scenario: Scenario;
  includeCommentIntent: boolean;
  startAt?: string;
}

const DEFAULT_START = "2026-01-01T12:00:00.000Z";
const DURATION_SECONDS = 30 * 60;
const STEP_SECONDS = 30;
const HISTORICAL_ONLINE_JITTER_PATTERN = [0, 1, 0, -1, 0, -1, 0, 1] as const;

function seededNoise(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 10_000) / 10_000;
  };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function emptyTagSummary(tags: SpeechTag[]): Record<SpeechTag, number> {
  const all: SpeechTag[] = [
    "opening", "interaction", "product_benefit", "ingredient_or_principle", "usage_scenario",
    "price", "gift", "trust", "guarantee", "objection_handling", "urgency", "cta", "transition", "other"
  ];
  return Object.fromEntries(all.map((tag) => [tag, tags.includes(tag) ? 1 : 0])) as Record<SpeechTag, number>;
}

function atOffset(startAt: string, seconds: number): string {
  return new Date(Date.parse(startAt) + seconds * 1000).toISOString();
}

function simulationEventId(options: SimulationOptions, sequence: number): string {
  return `${options.sessionId}:${options.scenario}:${options.seed}:${sequence}`;
}

function event(
  options: SimulationOptions,
  sequence: number,
  seconds: number,
  kind: LiveEvent["kind"],
  payload: unknown,
  source: LiveEvent["source"] = "simulator"
): LiveEvent {
  const timestamp = atOffset(options.startAt ?? DEFAULT_START, seconds);
  return {
    schemaVersion: 1,
    eventId: simulationEventId(options, sequence),
    dedupeKey: `${options.sessionId}:${kind}:${seconds}:${sequence}`,
    tenantId: options.tenantId,
    sessionId: options.sessionId,
    eventAt: timestamp,
    capturedAt: timestamp,
    ingestedAt: timestamp,
    source,
    kind,
    provisional: false,
    payload
  };
}

function scenarioRates(scenario: Scenario, minute: number): { onlineFactor: number; clickRate: number; payRate: number; spendRate: number } {
  switch (scenario) {
    case "low_click":
      return { onlineFactor: 1, clickRate: 0.08, payRate: 0.13, spendRate: 18 };
    case "low_payment":
      return { onlineFactor: 1, clickRate: 0.24, payRate: 0.025, spendRate: 18 };
    case "online_drop":
      return { onlineFactor: minute < 10 ? 1 : Math.max(0.28, 1 - (minute - 10) * 0.045), clickRate: 0.23, payRate: 0.12, spendRate: 17 };
    case "roi_drop":
      return { onlineFactor: 1, clickRate: 0.24, payRate: minute < 12 ? 0.12 : 0.02, spendRate: minute < 12 ? 17 : 38 };
    case "price_close_improves":
    case "positive_segment":
      return { onlineFactor: 1, clickRate: minute < 15 ? 0.17 : 0.29, payRate: minute < 15 ? 0.045 : 0.16, spendRate: 18 };
    case "no_cta":
      return { onlineFactor: 1, clickRate: 0.10, payRate: 0.1, spendRate: 18 };
    case "price_objection":
      return { onlineFactor: 1, clickRate: 0.24, payRate: 0.03, spendRate: 18 };
    case "long_knowledge":
      return { onlineFactor: minute < 8 ? 1 : Math.max(0.58, 1 - (minute - 8) * 0.025), clickRate: 0.12, payRate: 0.08, spendRate: 18 };
    default:
      return { onlineFactor: 1, clickRate: 0.25, payRate: 0.11, spendRate: 18 };
  }
}

const speechByScenario: Record<Scenario, (minute: number) => { text: string; tags: SpeechTag[] }> = {
  stable: (minute) => ({ text: minute % 2 === 0 ? "这款锅受热均匀，商品卡有到手价、赠品和售后保障，可以直接下单。" : "日常煎炒都顺手，清洁也很方便。", tags: minute % 2 === 0 ? ["product_benefit", "cta", "price", "gift", "guarantee"] : ["usage_scenario", "product_benefit"] }),
  low_click: () => ({ text: "继续给大家讲一下复合锅底的结构和导热原理。", tags: ["ingredient_or_principle"] }),
  low_payment: () => ({ text: "喜欢的朋友先点开商品卡看看这款锅。", tags: ["cta", "product_benefit"] }),
  online_drop: (minute) => ({ text: minute < 10 ? "今天做饭想省时间的朋友看这里。" : "我们继续详细解释材料的每一层结构。", tags: minute < 10 ? ["interaction", "usage_scenario"] : ["ingredient_or_principle"] }),
  roi_drop: () => ({ text: "新进来的朋友可以看看锅体细节和使用场景。", tags: ["interaction", "usage_scenario"] }),
  price_close_improves: (minute) => minute < 15
    ? ({ text: "这套锅适合日常煎炒，锅体导热均匀。", tags: ["product_benefit", "usage_scenario"] })
    : ({ text: "现在商品卡是到手价，含赠品和售后保障，点开商品卡直接下单。", tags: ["price", "gift", "guarantee", "trust", "cta"] }),
  no_cta: () => ({ text: "这款锅受热均匀，适合日常煎炒和炖煮。", tags: ["product_benefit", "usage_scenario"] }),
  price_objection: () => ({ text: "锅体受热均匀，日常清洁也很方便。", tags: ["product_benefit", "usage_scenario"] }),
  long_knowledge: () => ({ text: "继续讲复合锅底材料结构、导热原理和每层工艺。", tags: ["ingredient_or_principle"] }),
  positive_segment: (minute) => minute < 15
    ? ({ text: "这套锅适合日常煎炒，锅体导热均匀。", tags: ["product_benefit", "usage_scenario"] })
    : ({ text: "现在是到手价，赠品和售后保障都在商品卡，点开就能下单。", tags: ["price", "gift", "guarantee", "trust", "cta"] }),
  historical_morning: () => ({ text: "这是独立合成场景：说明用途、公开价格条件和购买步骤。", tags: ["usage_scenario", "product_benefit", "price", "gift", "guarantee", "cta"] }),
  historical_afternoon: () => ({ text: "这是独立合成场景：说明用途、公开价格条件和购买步骤。", tags: ["usage_scenario", "product_benefit", "price", "gift", "guarantee", "cta"] }),
  historical_evening: () => ({ text: "这是独立合成场景：说明用途、公开价格条件和购买步骤。", tags: ["usage_scenario", "product_benefit", "price", "gift", "guarantee", "cta"] }),
  mvp_stable: () => ({ text: "这款商品适合日常使用，价格、赠品和售后保障都在商品卡，按页面步骤购买即可。", tags: ["product_benefit", "usage_scenario", "price", "gift", "guarantee", "cta"] }),
  mvp_traffic_surge: () => ({ text: "新来的朋友先看核心利益点，点开商品卡就能看到适用场景。", tags: ["product_benefit", "cta"] }),
  mvp_retention: () => ({ text: "我们继续把原理细节讲完，大家可以先听完整。", tags: ["ingredient_or_principle"] }),
  mvp_high_intent: () => ({ text: "对这套复购装感兴趣的朋友，先看适用人群和长期使用价值。", tags: ["usage_scenario", "product_benefit"] }),
  mvp_high_click_low_pay: () => ({ text: "这款产品解决的是日常使用痛点，具体到手价和赠品请看商品卡。", tags: ["product_benefit", "price"] }),
  mvp_standout: () => ({ text: "当前商品的核心利益已经讲清楚，大家按商品卡步骤下单即可。", tags: ["product_benefit", "cta"] }),
  mvp_low_efficiency: () => ({ text: "我们重新开一轮，先说清楚适合谁和一个核心使用场景。", tags: ["opening", "usage_scenario"] }),
  mvp_comprehensive: () => ({ text: "综合演示阶段话术，根据当前经营状态切换。", tags: ["transition"] }),
  live_compass: () => ({ text: "", tags: ["transition"] })
};

function historicalProfile(scenario: Scenario): HistoricalTimeProfile | undefined {
  return scenario in HISTORICAL_TIME_PROFILES
    ? HISTORICAL_TIME_PROFILES[scenario as keyof typeof HISTORICAL_TIME_PROFILES]
    : undefined;
}

export function generateSimulation(options: SimulationOptions): LiveEvent[] {
  const startAt = options.startAt ?? DEFAULT_START;
  const random = seededNoise(options.seed);
  const events: LiveEvent[] = [];
  let sequence = 0;
  let roomImpressionTotal = 0;
  let roomEnterTotal = 0;
  let productImpressionTotal = 0;
  let clicksTotal = 0;
  let expectedRoomImpressionTotal = 0;
  let expectedRoomEnterTotal = 0;
  let expectedProductImpressionTotal = 0;
  let expectedClicksTotal = 0;
  let paidOrderTotal = 0;
  let paidBuyerTotal = 0;
  let expectedPaidBuyerTotal = 0;
  let grossPaidGmvFen = 0;
  let adSpendFen = 0;
  let expectedGrossPaidGmvFen = 0;
  let expectedAdSpendFen = 0;
  const productRoundStartEventIds = new Map<number, string>();

  const push = (seconds: number, kind: LiveEvent["kind"], payload: unknown, source?: LiveEvent["source"]) => {
    const nextEvent = event({ ...options, startAt }, sequence++, seconds, kind, payload, source);
    events.push(nextEvent);
    return nextEvent;
  };

  push(0, "session.marker", { marker: "started" });
  const profile = historicalProfile(options.scenario);
  push(0, "source.health", {
    sourceId: "simulator-metrics", status: "healthy", lastEventAt: startAt, latencyMs: 0,
    completeness: 0.92, schemaVersion: "1",
    message: profile
      ? `独立合成回放；${profile.timeLabel}；不来自任何历史经营记录`
      : "确定性模拟数据",
    checkedAt: startAt
  });
  push(0, "source.health", {
    sourceId: "comment-intent", status: options.includeCommentIntent ? "healthy" : "offline",
    ...(options.includeCommentIntent ? { lastEventAt: startAt, latencyMs: 0, completeness: 1 } : {}),
    schemaVersion: "1", message: options.includeCommentIntent ? "模拟评论意图已接入" : "评论意图未采集",
    checkedAt: startAt
  });

  for (let seconds = 0; seconds <= DURATION_SECONDS; seconds += STEP_SECONDS) {
    const minute = seconds / 60;
    const rates = scenarioRates(options.scenario, minute);
    const historicalIntervalMinutes = seconds === 0 ? 0 : 0.5;
    const historicalIntervalFraction = seconds === 0 ? 0 : 1 / (DURATION_SECONDS / STEP_SECONDS);
    const intervalRoomEnters = profile ? profile.perMinute.roomEnterUv * historicalIntervalMinutes : Math.round(Math.max(12, (42 + random() * 8) * rates.onlineFactor) / 2);
    const intervalRoomImpressions = profile ? profile.perMinute.roomImpressionUv * historicalIntervalMinutes : intervalRoomEnters / 0.2;
    const intervalProductImpressions = profile ? profile.perMinute.productImpressionUv * historicalIntervalMinutes : intervalRoomEnters * 0.78;
    const intervalClicks = profile ? profile.perMinute.productClickUv * historicalIntervalMinutes : intervalProductImpressions * rates.clickRate;
    expectedPaidBuyerTotal += profile ? profile.perMinute.paidBuyerCount * historicalIntervalMinutes : intervalClicks * rates.payRate;
    const nextPaidBuyerTotal = Math.round(expectedPaidBuyerTotal);
    const nextPaidOrderTotal = Math.round(expectedPaidBuyerTotal * 1.07);
    const intervalPaidBuyers = Math.max(0, nextPaidBuyerTotal - paidBuyerTotal);
    const intervalPaidOrders = Math.max(0, nextPaidOrderTotal - paidOrderTotal);
    const intervalGmvFen = profile ? profile.grossGmvFen * historicalIntervalFraction : intervalPaidOrders * 10_000;
    const intervalSpendFen = profile ? profile.adSpendFen * historicalIntervalFraction : rates.spendRate * 100 / 2;
    expectedRoomImpressionTotal += intervalRoomImpressions;
    expectedRoomEnterTotal += intervalRoomEnters;
    expectedProductImpressionTotal += intervalProductImpressions;
    expectedClicksTotal += intervalClicks;
    const countTotal = profile ? Math.round : Math.floor;
    roomImpressionTotal = countTotal(expectedRoomImpressionTotal + 1e-9);
    roomEnterTotal = countTotal(expectedRoomEnterTotal + 1e-9);
    productImpressionTotal = countTotal(expectedProductImpressionTotal + 1e-9);
    clicksTotal = countTotal(expectedClicksTotal + 1e-9);
    paidBuyerTotal += intervalPaidBuyers;
    paidOrderTotal += intervalPaidOrders;
    expectedGrossPaidGmvFen += intervalGmvFen;
    expectedAdSpendFen += intervalSpendFen;
    grossPaidGmvFen = Math.round(expectedGrossPaidGmvFen);
    adSpendFen = Math.round(expectedAdSpendFen);
    random();
    const online = profile
      ? HISTORICAL_CONCURRENT_VIEWERS_CALIBRATION.median
        + HISTORICAL_ONLINE_JITTER_PATTERN[Math.floor(seconds / STEP_SECONDS) % HISTORICAL_ONLINE_JITTER_PATTERN.length]!
        * HISTORICAL_CONCURRENT_VIEWERS_CALIBRATION.syntheticJitter
      : Math.round((150 + random() * 18) * rates.onlineFactor);
    const refundGmvFen = Math.round(grossPaidGmvFen * 0.03);
    const netPaidGmvFen = grossPaidGmvFen - refundGmvFen;
    const metrics: CanonicalMetricSnapshot = {
      room_impression_uv: roomImpressionTotal,
      room_enter_uv: roomEnterTotal,
      concurrent_viewers: online,
      product_impression_uv: productImpressionTotal,
      product_click_uv: clicksTotal,
      paid_order_count: paidOrderTotal,
      paid_buyer_count: paidBuyerTotal,
      gross_paid_gmv_fen: grossPaidGmvFen,
      refund_gmv_fen: refundGmvFen,
      ad_spend_fen: adSpendFen,
      room_entry_rate: round(roomEnterTotal / Math.max(roomImpressionTotal, 1), 4),
      product_click_rate: round(clicksTotal / Math.max(productImpressionTotal, 1), 4),
      click_to_paid_rate: round(paidBuyerTotal / Math.max(clicksTotal, 1), 4),
      gross_roi: round(grossPaidGmvFen / Math.max(adSpendFen, 1), 4),
      net_paid_gmv_fen: netPaidGmvFen,
      net_roi: round(netPaidGmvFen / Math.max(adSpendFen, 1), 4),
      current_product_id: minute < 10 ? "pan-24" : minute < 20 ? "pan-28" : "pot-set",
      current_host_id: "host-demo"
    };
    push(seconds, "metric.snapshot", metrics);

    if (seconds % 60 === 0 && seconds < DURATION_SECONDS) {
      const speech = speechByScenario[options.scenario](minute);
      const segment: TranscriptSegment = {
        id: `${options.sessionId}:speech:${seconds}`, tenantId: options.tenantId, sessionId: options.sessionId,
        startMs: seconds * 1000, endMs: seconds * 1000 + 12_000, text: speech.text,
        isFinal: true, confidence: 0.96, hostId: "host-demo", productId: metrics.current_product_id,
        productRoundId: `${options.sessionId}:round:${Math.floor(minute / 10)}`, tags: speech.tags,
        sourceEventId: simulationEventId(options, sequence)
      };
      push(seconds + 1, "speech.final", segment, "asr");
    }

    const isTrafficChangePoint = seconds === 0 || (options.scenario === "roi_drop" && seconds === 12 * 60);
    if (isTrafficChangePoint) {
      push(seconds + 2, "traffic.changed", {
        ad_spend_fen_per_min: profile ? Math.round(profile.adSpendFen / 30) : Math.round(rates.spendRate * 100),
        reason: options.scenario === "roi_drop" && seconds > 0 ? "scale_up" : "baseline",
        plan_name: "模拟主计划"
      });
    }
    if (seconds % 300 === 0 && seconds < DURATION_SECONDS) {
      if (options.includeCommentIntent) {
        const priceHeavy = options.scenario === "low_payment" || options.scenario === "price_objection" || ((options.scenario === "price_close_improves" || options.scenario === "positive_segment") && minute < 15);
        push(seconds + 3, "comment.intent", { intent: priceHeavy ? "price" : "positive", count: priceHeavy ? 9 : 4 });
      }
    }

    if (seconds % 600 === 0 && seconds < DURATION_SECONDS) {
      const roundIndex = Math.floor(seconds / 600);
      const productId = roundIndex === 0 ? "pan-24" : roundIndex === 1 ? "pan-28" : "pot-set";
      const speech = speechByScenario[options.scenario](minute);
      const startEventId = simulationEventId(options, sequence);
      productRoundStartEventIds.set(roundIndex, startEventId);
      const productRound: ProductRound = {
        id: `${options.sessionId}:round:${roundIndex}`, sessionId: options.sessionId, productId,
        hostId: "host-demo", startedAt: atOffset(startAt, seconds), startEventId,
        tagsSummary: emptyTagSummary(speech.tags)
      };
      push(seconds + 4, "product.round.started", productRound);
      if (roundIndex > 0) {
        const previousProductId = roundIndex === 1 ? "pan-24" : "pan-28";
        push(seconds + 4, "product.changed", { productId, previousProductId });
      }
    }
    if (seconds > 0 && seconds % 600 === 0) {
      const roundIndex = seconds / 600 - 1;
      const productId = roundIndex === 0 ? "pan-24" : roundIndex === 1 ? "pan-28" : "pot-set";
      const speech = speechByScenario[options.scenario](minute - 1);
      const startEventId = productRoundStartEventIds.get(roundIndex);
      if (!startEventId) throw new Error(`缺少商品轮次开始事件：${roundIndex}`);
      const endEventId = simulationEventId(options, sequence);
      push(Math.min(seconds + 5, DURATION_SECONDS), "product.round.ended", {
        id: `${options.sessionId}:round:${roundIndex}`, sessionId: options.sessionId, productId,
        hostId: "host-demo", startedAt: atOffset(startAt, seconds - 600), endedAt: atOffset(startAt, seconds),
        startEventId, endEventId,
        tagsSummary: emptyTagSummary(speech.tags), metricSummary: { gross_paid_gmv_fen: grossPaidGmvFen, paid_order_count: paidOrderTotal }
      });
    }
  }
  push(DURATION_SECONDS, "session.marker", { marker: "completed" });
  return events.sort((left, right) => Date.parse(left.eventAt) - Date.parse(right.eventAt) || left.eventId.localeCompare(right.eventId));
}

export class SimulatorAdapter implements SourceAdapter {
  readonly id = "simulator";
  readonly type = "simulator";
  private active = false;
  private checkedAt = DEFAULT_START;

  async start(): Promise<void> { this.active = true; }
  async stop(): Promise<void> { this.active = false; }
  async health(): Promise<SourceHealth> {
    return { sourceId: this.id, status: this.active ? "healthy" : "offline", checkedAt: this.checkedAt, message: this.active ? "模拟器运行中" : "模拟器未运行" };
  }
  normalize(raw: unknown): LiveEvent[] {
    if (!Array.isArray(raw)) throw new TypeError("SimulatorAdapter.normalize 输入必须是事件数组");
    return raw.map((item) => liveEventSchema.parse(item));
  }
}

export async function replayEvents(
  events: LiveEvent[],
  speed: number,
  ingest: (event: LiveEvent) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let previous = events[0]?.eventAt;
  for (const next of events) {
    if (signal?.aborted) return;
    if (previous && speed < 3600) {
      const delay = Math.max(0, (Date.parse(next.eventAt) - Date.parse(previous)) / speed);
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    if (signal?.aborted) return;
    await ingest(next);
    previous = next.eventAt;
  }
}

export * from "./operator-history";
