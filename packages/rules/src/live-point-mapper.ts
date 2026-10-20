import {
  MVP_SPEECH_COVERAGE_KEYS,
  mvpMetricPointSchema,
  type LiveCompassMetricSnapshot,
  type MvpMetricPoint,
  type QianchuanMetricSnapshot
} from "@live-growth/contracts";

/**
 * Phase 2B M0（D035）：把罗盘／千川真实快照映射成七状态引擎的 MvpMetricPoint。
 * 全部换算只依赖快照自身时间，确定性、可回放；换算取舍见 docs/DECISIONS.md D035。
 * 关键原则：缺失不补真值——核心房间信号不新鲜时 dataComplete=false，引擎不判断；
 * 话术覆盖只输出 present/unknown，从不推断 absent（D021）。
 */
export type LivePointMapperConfig = {
  /** 瞬时字段（在线人数）新鲜窗口。 */
  instantFreshMs: number;
  /** 滚动字段（近5分钟进入、平均停留、商品点击）新鲜窗口。 */
  rollingFreshMs: number;
  /** retentionProxy = min(1, 平均停留秒 / retentionFullSec)。校准假设，可配置。 */
  retentionFullSec: number;
  /** 话术覆盖回看窗口。 */
  speechWindowMs: number;
  /** 千川 ROI 视为有效的最大延迟。 */
  roiFreshMs: number;
  /** 样本保留边界，防止无界增长。 */
  horizonMs: number;
};

export const DEFAULT_LIVE_POINT_MAPPER_CONFIG: Readonly<LivePointMapperConfig> = {
  instantFreshMs: 120_000,
  rollingFreshMs: 330_000,
  retentionFullSec: 90,
  speechWindowMs: 180_000,
  roiFreshMs: 600_000,
  horizonMs: 30 * 60_000
};

/** 话术覆盖 15 维的确定性关键词打底；未命中一律 unknown，不推断 absent。 */
const SPEECH_COVERAGE_PATTERNS: Readonly<Partial<Record<(typeof MVP_SPEECH_COVERAGE_KEYS)[number], RegExp>>> = {
  product_benefit: /好用|效果好|受益|优点|亮点|好处/,
  product_efficacy: /功效|效果|作用/,
  ingredient_or_principle: /成分|材质|工艺|原理|配方/,
  usage_scenario: /场景|在家|平时|早上|晚上|上班|做饭/,
  suitable_audience: /适合|人群|宝妈|上班族|学生|老人|新手/,
  price: /到手价|价格|多少钱|[0-9]+(?:\.[0-9]+)?\s*(?:元|块)/,
  offer: /优惠|活动|机制|折扣|立减|券/,
  gift: /赠品|送你|送一|加赠|附赠/,
  guarantee: /保价|退换|质保|七天|运费险|假一/,
  after_sale: /售后|客服|包退|包换/,
  product_card_cta: /商品卡|小黄车|购物车|链接/,
  purchase_cta: /下单|去拍|锁单|付款|拍下/,
  urgency: /最后|仅剩|库存|倒计时|恢复原价|限时/,
  interaction: /扣个|评论区|弹幕|扣1|扣一|点点关注/
};

type Sample = { atMs: number; value: number };
type ProductSample = Sample & { productName?: string };

function pushSample(series: Sample[], atMs: number, value: number | undefined): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  series.push({ atMs, value });
}

function lastFresh(series: readonly Sample[], atMs: number, freshMs: number): Sample | undefined {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const sample = series[index]!;
    if (sample.atMs > atMs) continue;
    return atMs - sample.atMs <= freshMs ? sample : undefined;
  }
  return undefined;
}

/**
 * 累计序列在 (fromMs, toMs] 内的正向增量之和；基准为 fromMs 前最后一个样本。
 * 计数器回退不产生负增量（与 live-window-aggregate 的 delta 语义一致）。
 * 序列在窗口和基准位置都没有样本时返回 undefined（区分"无数据"与"增量为 0"）。
 */
export function positiveDeltaInWindow(series: readonly Sample[], fromMs: number, toMs: number): number | undefined {
  let base: number | undefined;
  let delta = 0;
  let sawWindowSample = false;
  for (const sample of series) {
    if (sample.atMs > toMs) break;
    if (sample.atMs <= fromMs) { base = sample.value; continue; }
    sawWindowSample = true;
    if (base !== undefined && sample.value > base) delta += sample.value - base;
    base = sample.value;
  }
  if (!sawWindowSample) return base === undefined ? undefined : 0;
  return delta;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function nonNegativeInt(value: number): number { return Math.max(0, Math.round(value)); }

export const UNKNOWN_PRODUCT_ID = "unknown-product";

export class LivePointMapper {
  private readonly online: Sample[] = [];
  private readonly enters5m: Sample[] = [];
  private readonly avgWatchSec: Sample[] = [];
  private readonly clicks5m: ProductSample[] = [];
  private readonly gmv5mRolling: Sample[] = [];
  private readonly paidBuyersCum: Sample[] = [];
  private readonly unpaidCum: ProductSample[] = [];
  private readonly productGmvCum: ProductSample[] = [];
  private readonly adSpendCumFen: Sample[] = [];
  private readonly qcAdSpendCumYuan: Sample[] = [];
  private readonly qcRoi: Sample[] = [];
  private readonly speech: Array<{ atMs: number; text: string }> = [];
  private lastProductName: string | undefined;
  private sawCompass = false;

  constructor(private readonly config: LivePointMapperConfig = DEFAULT_LIVE_POINT_MAPPER_CONFIG) {}

  observeCompass(snapshot: LiveCompassMetricSnapshot): void {
    const atMs = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(atMs)) return;
    this.sawCompass = true;
    const productName = snapshot.currentProductName ?? snapshot.productName;
    if (productName) this.lastProductName = productName;
    pushSample(this.online, atMs, snapshot.onlineSnapshot);
    pushSample(this.enters5m, atMs, snapshot.roomEnterCount5m);
    pushSample(this.avgWatchSec, atMs, snapshot.averageWatchDurationSec);
    pushSample(this.gmv5mRolling, atMs, snapshot.userPaidGmvFen5m);
    pushSample(this.paidBuyersCum, atMs, snapshot.paidBuyerCount);
    pushSample(this.adSpendCumFen, atMs, snapshot.adSpendFen);
    if (typeof snapshot.productClickCount === "number") this.clicks5m.push({ atMs, value: snapshot.productClickCount, ...(productName ? { productName } : {}) });
    if (typeof snapshot.unpaidOrderCount === "number") this.unpaidCum.push({ atMs, value: snapshot.unpaidOrderCount, ...(productName ? { productName } : {}) });
    if (typeof snapshot.productPayGmvFen === "number") this.productGmvCum.push({ atMs, value: snapshot.productPayGmvFen, ...(productName ? { productName } : {}) });
    this.prune(atMs);
  }

  observeQianchuan(snapshot: QianchuanMetricSnapshot): void {
    const atMs = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(atMs)) return;
    pushSample(this.qcAdSpendCumYuan, atMs, snapshot.metrics.adSpend?.value);
    pushSample(this.qcRoi, atMs, snapshot.metrics.roi?.value);
    this.prune(atMs);
  }

  observeSpeech(at: string, text: string): void {
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs) || !text.trim()) return;
    this.speech.push({ atMs, text });
    this.prune(atMs);
  }

  private prune(latestMs: number): void {
    const cutoff = latestMs - this.config.horizonMs;
    for (const series of [this.online, this.enters5m, this.avgWatchSec, this.clicks5m, this.gmv5mRolling, this.paidBuyersCum, this.unpaidCum, this.productGmvCum, this.adSpendCumFen, this.qcAdSpendCumYuan, this.qcRoi]) {
      while (series.length > 1 && series[0]!.atMs < cutoff) series.shift();
    }
    while (this.speech.length > 0 && this.speech[0]!.atMs < cutoff) this.speech.shift();
  }

  /** 在指定时刻构造引擎输入点；从未收到罗盘快照时返回 null。 */
  pointAt(at: string): MvpMetricPoint | null {
    if (!this.sawCompass) return null;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) return null;
    const { instantFreshMs, rollingFreshMs, retentionFullSec, speechWindowMs, roiFreshMs } = this.config;
    const fiveMinMs = 300_000;

    const onlineSample = lastFresh(this.online, atMs, instantFreshMs);
    const entersSample = lastFresh(this.enters5m, atMs, rollingFreshMs);
    const avgWatchSample = lastFresh(this.avgWatchSec, atMs, rollingFreshMs);
    const dataComplete = Boolean(onlineSample && entersSample && avgWatchSample);

    const enters5mValue = entersSample?.value ?? 0;
    const enters1m = nonNegativeInt(enters5mValue / 5);
    const retentionProxy = avgWatchSample ? clamp01(avgWatchSample.value / retentionFullSec) : 0;

    const productName = this.lastProductName;
    const productId = productName ? productName.trim().slice(0, 120) : UNKNOWN_PRODUCT_ID;
    const productScoped = (series: readonly ProductSample[]): ProductSample[] =>
      productName ? series.filter((sample) => sample.productName === undefined || sample.productName === productName) : [...series];

    const clicksSample = lastFresh(productScoped(this.clicks5m), atMs, rollingFreshMs);
    const unpaidDelta = positiveDeltaInWindow(productScoped(this.unpaidCum), atMs - fiveMinMs, atMs);
    const paidBuyersDelta = positiveDeltaInWindow(this.paidBuyersCum, atMs - fiveMinMs, atMs);
    const productGmvDelta = positiveDeltaInWindow(productScoped(this.productGmvCum), atMs - fiveMinMs, atMs);
    const roomGmv5m = lastFresh(this.gmv5mRolling, atMs, rollingFreshMs);

    const compassSpendDelta = positiveDeltaInWindow(this.adSpendCumFen, atMs - fiveMinMs, atMs);
    const compassSpendPrevDelta = positiveDeltaInWindow(this.adSpendCumFen, atMs - 2 * fiveMinMs, atMs - fiveMinMs);
    const qcSpendDelta = positiveDeltaInWindow(this.qcAdSpendCumYuan, atMs - fiveMinMs, atMs);
    const qcSpendPrevDelta = positiveDeltaInWindow(this.qcAdSpendCumYuan, atMs - 2 * fiveMinMs, atMs - fiveMinMs);
    const spendFen5m = compassSpendDelta !== undefined ? nonNegativeInt(compassSpendDelta) : qcSpendDelta !== undefined ? nonNegativeInt(qcSpendDelta * 100) : 0;
    const spendPrevFen5m = compassSpendDelta !== undefined
      ? nonNegativeInt(compassSpendPrevDelta ?? 0)
      : qcSpendDelta !== undefined ? nonNegativeInt((qcSpendPrevDelta ?? 0) * 100) : 0;
    const spendChangeRate5m = spendPrevFen5m > 0 ? (spendFen5m - spendPrevFen5m) / spendPrevFen5m : 0;
    const roiSample = lastFresh(this.qcRoi, atMs, roiFreshMs);

    const baselineEnters = this.enters5m.filter((sample) => sample.atMs >= atMs - 15 * 60_000 && sample.atMs <= atMs - fiveMinMs).map((sample) => sample.value);
    const entersBaseline = median(baselineEnters);
    const trafficVs10mBaseline = baselineEnters.length >= 2 && entersBaseline > 0 && entersSample ? entersSample.value / entersBaseline - 1 : 0;

    const recentSpeech = this.speech.filter((item) => item.atMs <= atMs && atMs - item.atMs <= speechWindowMs);
    const combinedSpeech = recentSpeech.map((item) => item.text).join(" ");
    const speechCoverage = Object.fromEntries(MVP_SPEECH_COVERAGE_KEYS.map((key) => {
      const pattern = SPEECH_COVERAGE_PATTERNS[key];
      return [key, pattern && combinedSpeech && pattern.test(combinedSpeech) ? "present" as const : "unknown" as const];
    }));
    const speechEvidence = recentSpeech.slice(-2).map((item) => item.text.slice(0, 80));

    return mvpMetricPointSchema.parse({
      at,
      online: nonNegativeInt(onlineSample?.value ?? 0),
      enters1m,
      retentionProxy,
      currentProductId: productId,
      products: [{
        productId,
        exposure5m: nonNegativeInt(enters5mValue),
        clicks5m: nonNegativeInt(clicksSample?.value ?? 0),
        unpaid5m: nonNegativeInt(unpaidDelta ?? 0),
        paidBuyers5m: nonNegativeInt(paidBuyersDelta ?? 0),
        gmvFen5m: nonNegativeInt(productGmvDelta ?? roomGmv5m?.value ?? 0)
      }],
      traffic: {
        spendFen5m,
        spendChangeRate5m,
        roi: roiSample?.value ?? 0,
        roiVs10mBaseline: 0,
        trafficVs10mBaseline,
        updatedAt: at
      },
      dataComplete,
      speechCoverage,
      speechEvidence
    });
  }
}
