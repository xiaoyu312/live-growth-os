import { MVP_SPEECH_COVERAGE_KEYS, mvpMetricPointSchema, type MvpMetricPoint, type MvpProduct } from "@live-growth/contracts";

// Independent public demonstration prices; matching GMV examples are recomputed from these values.
export const MVP_PRODUCT_SEEDS: readonly MvpProduct[] = [
  { productId: "mvp-low-pan", name: "低客单演示商品A", type: "low_price_new_customer", priceFen: 10000, enabled: true, note: "低客单新客演示商品" },
  { productId: "mvp-low-care", name: "低客单演示商品B", type: "low_price_new_customer", priceFen: 5000, enabled: true, note: "低客单新客演示商品" },
  { productId: "mvp-high-set", name: "高客单演示商品A", type: "high_price_repeat_customer", priceFen: 40000, enabled: true, note: "高客单复购演示商品" },
  { productId: "mvp-high-reserve", name: "高客单演示商品B", type: "high_price_repeat_customer", priceFen: 60000, enabled: true, note: "高客单复购演示商品" }
];

export type MvpScenario = "mvp_stable" | "mvp_traffic_surge" | "mvp_retention" | "mvp_high_intent" | "mvp_high_click_low_pay" | "mvp_standout" | "mvp_low_efficiency" | "mvp_comprehensive";
export const MVP_SCENARIO_NAMES: Record<MvpScenario, string> = {
  mvp_stable: "稳定运行", mvp_traffic_surge: "流量突然涌入", mvp_retention: "进人较多但留不住", mvp_high_intent: "低流量但高意向",
  mvp_high_click_low_pay: "点击较高但支付偏低", mvp_standout: "商品表现突出", mvp_low_efficiency: "整体低效需要复位", mvp_comprehensive: "综合场次（30—40 分钟）"
};

export type MvpSimulationOptions = { sessionId: string; seed: number; scenario: MvpScenario; startAt?: string; durationSec?: number; products?: readonly MvpProduct[] };
const DEFAULT_START = "2030-01-01T00:00:00.000Z";
const STEP_SEC = 5;

function noise(seed: number, index: number): number {
  let value = (seed + index * 1_103_515_245 + 12_345) | 0;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  return Math.abs(value % 100) / 100;
}
function at(start: string, offset: number): string { return new Date(Date.parse(start) + offset * 1000).toISOString(); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

type Stage = { online: number; enters: number; retention: number; current: string; top: string; currentMetrics: [number, number, number, number, number]; topMetrics?: [number, number, number, number, number]; inventory?: number; deadline?: string };

function stageFor(scenario: MvpScenario, seconds: number): Stage {
  const low = "mvp-low-pan";
  const low2 = "mvp-low-care";
  const high = "mvp-high-set";
  if (scenario === "mvp_comprehensive") {
    if (seconds < 180) return { online: 30, enters: 5, retention: .3, current: low, top: low, currentMetrics: [60, 1, 0, 0, 0] };
    if (seconds < 360) return { online: 120, enters: 12, retention: .62, current: low, top: low, currentMetrics: [120, 16, 2, 2, 20000] };
    if (seconds < 480) return { online: 240 + Math.floor((seconds - 360) / STEP_SEC) * 5, enters: 34, retention: .6, current: low, top: low, currentMetrics: [150, 20, 2, 2, 20000] };
    if (seconds < 660) return { online: 150 - Math.floor((seconds - 480) / 10), enters: 25, retention: .22, current: low, top: low, currentMetrics: [140, 11, 4, 0, 0] };
    if (seconds < 840) return { online: 190, enters: 16, retention: .58, current: low, top: low, currentMetrics: [130, 20, 3, 2, 20000] };
    if (seconds < 1020) return { online: 80, enters: 6, retention: .67, current: low, top: high, currentMetrics: [70, 3, 1, 0, 0], topMetrics: [80, 15, 5, 1, 40000] };
    if (seconds < 1200) return { online: 85, enters: 6, retention: .65, current: high, top: high, currentMetrics: [100, 18, 6, 2, 80000], topMetrics: [100, 18, 6, 2, 80000] };
    if (seconds < 1440) return { online: 120, enters: 12, retention: .58, current: high, top: high, currentMetrics: [180, 35, 20, 0, 0], topMetrics: [180, 35, 20, 0, 0], inventory: seconds < 1320 ? 8 : 60 };
    if (seconds < 1620) return { online: 130, enters: 14, retention: .6, current: high, top: high, currentMetrics: [170, 32, 4, 5, 200000], topMetrics: [170, 32, 4, 5, 200000] };
    if (seconds < 1800) return { online: 210, enters: 20, retention: .7, current: high, top: high, currentMetrics: [210, 50, 12, 8, 320000], topMetrics: [210, 50, 12, 8, 320000] };
    if (seconds < 1980) return { online: 25, enters: 2, retention: .18, current: high, top: low2, currentMetrics: [50, 1, 0, 0, 0], topMetrics: [30, 1, 0, 0, 0] };
    if (seconds < 2160) return { online: 110, enters: 12, retention: .58, current: low2, top: low2, currentMetrics: [100, 15, 2, 2, 10000], topMetrics: [100, 15, 2, 2, 10000] };
    return { online: 115, enters: 10, retention: .6, current: low2, top: low2, currentMetrics: [100, 16, 2, 2, 10000], topMetrics: [100, 16, 2, 2, 10000] };
  }
  switch (scenario) {
    case "mvp_stable": return { online: 120, enters: 10, retention: .62, current: low, top: low, currentMetrics: [120, 18, 2, 2, 20000] };
    case "mvp_traffic_surge":
      // Keep the first three minutes flat so the state engine can establish a
      // short-term baseline before the deliberately introduced surge.
      if (seconds < 180) return { online: 100, enters: 10, retention: .6, current: low, top: low, currentMetrics: [150, 22, 2, 2, 20000] };
      return { online: Math.min(250, 100 + Math.floor(seconds / 5) * 2), enters: 35, retention: .6, current: low, top: low, currentMetrics: [150, 22, 2, 2, 20000] };
    case "mvp_retention": return { online: clamp(180 - seconds / 3, 70, 180), enters: 24, retention: .2, current: low, top: low, currentMetrics: [160, 12, 5, 0, 0] };
    case "mvp_high_intent": return { online: 80, enters: 6, retention: .67, current: low, top: high, currentMetrics: [70, 3, 1, 0, 0], topMetrics: [80, 16, 5, 1, 40000] };
    case "mvp_high_click_low_pay": return { online: 120, enters: 12, retention: .58, current: high, top: high, currentMetrics: [180, 36, 20, 0, 0], topMetrics: [180, 36, 20, 0, 0], inventory: 8 };
    case "mvp_standout": return { online: 130, enters: 14, retention: .62, current: high, top: high, currentMetrics: [200, 48, 8, 6, 240000], topMetrics: [200, 48, 8, 6, 240000] };
    case "mvp_low_efficiency": return { online: 25, enters: 2, retention: .18, current: high, top: low2, currentMetrics: [50, 1, 0, 0, 0], topMetrics: [30, 1, 0, 0, 0] };
  }
}

export function generateMvpSimulation(options: MvpSimulationOptions): MvpMetricPoint[] {
  const startAt = options.startAt ?? DEFAULT_START;
  const durationSec = options.durationSec ?? (options.scenario === "mvp_comprehensive" ? 2400 : 600);
  const configuredProducts = options.products ?? MVP_PRODUCT_SEEDS;
  const products = configuredProducts.filter((item) => item.enabled);
  const enabledByType = new Map<MvpProduct["type"], MvpProduct[]>();
  for (const product of products) enabledByType.set(product.type, [...(enabledByType.get(product.type) ?? []), product]);
  for (const type of ["low_price_new_customer", "high_price_repeat_customer"] as const) {
    if (!enabledByType.get(type)?.length) {
      const label = type === "low_price_new_customer" ? "低客单新客商品" : "高客单复购商品";
      throw new Error(`演示场景无法启动：至少需要一个启用的${label}`);
    }
  }
  const productById = new Map(products.map((product) => [product.productId, product]));
  const fallbackBySeed = new Map(MVP_PRODUCT_SEEDS.map((seed) => [seed.productId, enabledByType.get(seed.type)![0]!.productId]));
  const resolveProductId = (seedId: string): string => productById.has(seedId) ? seedId : (fallbackBySeed.get(seedId) ?? seedId);
  const points: MvpMetricPoint[] = [];
  for (let seconds = 0, index = 0; seconds <= durationSec; seconds += STEP_SEC, index += 1) {
    const stage = stageFor(options.scenario, seconds);
    const jitter = noise(options.seed, index);
    const productValues = new Map<string, [number, number, number, number, number, number | undefined]>();
    const currentProductId = resolveProductId(stage.current);
    const topIntentProductId = resolveProductId(stage.top);
    productValues.set(currentProductId, [...stage.currentMetrics, stage.inventory]);
    if (topIntentProductId !== currentProductId) productValues.set(topIntentProductId, [...(stage.topMetrics ?? [80, 3, 0, 0, 0]), undefined]);
    for (const product of products) if (!productValues.has(product.productId)) productValues.set(product.productId, [20, 1, 0, 0, 0, undefined]);
    const metrics = products.map((product) => {
      const values = productValues.get(product.productId) ?? [20, 1, 0, 0, 0, undefined];
      return { productId: product.productId, exposure5m: values[0] + Math.round(jitter * 2), clicks5m: values[1], unpaid5m: values[2], paidBuyers5m: values[3], gmvFen5m: values[4], ...(values[5] === undefined ? {} : { inventory: values[5] }) };
    });
    const point = mvpMetricPointSchema.parse({
      at: at(startAt, seconds), online: Math.round(stage.online), enters1m: stage.enters, retentionProxy: stage.retention,
      currentProductId, topIntentProductId, products: metrics,
      traffic: { spendFen5m: scenarioSpend(options.scenario, seconds), spendChangeRate5m: options.scenario === "mvp_high_click_low_pay" ? .35 : 0, roi: options.scenario === "mvp_high_click_low_pay" ? 2.1 : 4.2, roiVs10mBaseline: options.scenario === "mvp_high_click_low_pay" ? -.35 : 0, trafficVs10mBaseline: options.scenario === "mvp_traffic_surge" ? .8 : 0, updatedAt: at(startAt, seconds) },
      dataComplete: true,
      speechCoverage: speechCoverage(options.scenario, seconds),
      speechEvidence: speechEvidence(options.scenario, seconds)
    });
    points.push(point);
  }
  return points;
}

function scenarioSpend(scenario: MvpScenario, seconds: number): number {
  if (scenario === "mvp_high_click_low_pay") return 12_000 + Math.floor(seconds / 10) * 100;
  if (scenario === "mvp_traffic_surge") return 6_000 + Math.floor(seconds / 20) * 80;
  return 5_000 + Math.floor(seconds / 30) * 20;
}
function speechEvidence(scenario: MvpScenario, seconds: number): string[] {
  if (scenario === "mvp_retention") return ["连续讲解成分或原理，尚未回到使用场景和用户利益。"];
  if (scenario === "mvp_high_click_low_pay") return ["已讲产品价值，但价格机制和购买指令仍不完整。"];
  if (scenario === "mvp_high_intent") return ["非当前商品出现多次点击和未支付意向。"];
  if (scenario === "mvp_comprehensive" && seconds >= 1200 && seconds < 1440) return ["当前商品点击已经起来，建议快速补齐产品价值、价格机制和保障。"];
  return ["模拟主播正在按当前阶段讲解。"];
}

function speechCoverage(scenario: MvpScenario, seconds: number): Record<string, "present" | "absent" | "unknown"> {
  const coverage: Record<string, "present" | "absent" | "unknown"> = Object.fromEntries(MVP_SPEECH_COVERAGE_KEYS.map((key) => [key, "unknown" as const]));
  coverage.product_benefit = "present";
  coverage.product_efficacy = scenario === "mvp_retention" || scenario === "mvp_high_click_low_pay" ? "present" : "unknown";
  coverage.ingredient_or_principle = scenario === "mvp_retention" ? "present" : "unknown";
  coverage.usage_scenario = scenario === "mvp_stable" || scenario === "mvp_standout" ? "present" : "unknown";
  coverage.suitable_audience = scenario === "mvp_high_intent" ? "present" : "unknown";
  coverage.price = scenario === "mvp_stable" || scenario === "mvp_standout" ? "present" : "unknown";
  coverage.offer = scenario === "mvp_stable" || scenario === "mvp_standout" ? "present" : "unknown";
  coverage.gift = scenario === "mvp_standout" ? "present" : "unknown";
  coverage.guarantee = scenario === "mvp_stable" || scenario === "mvp_standout" ? "present" : "unknown";
  coverage.after_sale = scenario === "mvp_stable" || scenario === "mvp_standout" ? "present" : "unknown";
  coverage.product_card_cta = scenario === "mvp_stable" || scenario === "mvp_standout" ? "present" : "unknown";
  coverage.purchase_cta = scenario === "mvp_stable" || scenario === "mvp_standout" ? "present" : "unknown";
  coverage.urgency = scenario === "mvp_standout" ? "present" : "unknown";
  coverage.interaction = scenario === "mvp_traffic_surge" || scenario === "mvp_retention" ? "present" : "unknown";
  coverage.chatter = "absent";
  if (scenario === "mvp_high_click_low_pay") {
    coverage.price = "absent"; coverage.offer = "absent"; coverage.gift = "absent"; coverage.guarantee = "absent"; coverage.after_sale = "absent";
    coverage.product_card_cta = "absent"; coverage.purchase_cta = "absent";
  }
  if (scenario === "mvp_comprehensive" && seconds >= 1200 && seconds < 1440) {
    // 综合场景情形 C：库存事实存在，但产品价值维度仍明确缺失，
    // 让 S4 只能依据确认缺失项生成带真实库存事实的短收口。
    coverage.product_benefit = "absent";
    coverage.product_efficacy = "absent";
    coverage.usage_scenario = "absent";
    coverage.suitable_audience = "absent";
    coverage.price = "present"; coverage.offer = "present"; coverage.gift = "present"; coverage.guarantee = "present"; coverage.after_sale = "present";
    coverage.product_card_cta = "present"; coverage.purchase_cta = "present";
  }
  return coverage;
}
