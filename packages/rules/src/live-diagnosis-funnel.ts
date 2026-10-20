import type { DiagnosisActionKind, DiagnosisFinding } from "@live-growth/contracts";

const WEAK_RATIO = 0.9;
const CLEAR_RATIO = 0.6;
const MIN_IMPRESSIONS_FOR_ENTRY = 10;
const MIN_PRODUCT_IMPRESSIONS_FOR_CLICK = 5;
export const MIN_CLICKS_FOR_CONVERT = 10;

export type FunnelStage = "spend_spike" | "spend" | "exposure" | "entry" | "click" | "convert" | "aov" | "maintain" | "wait";

const STREAKABLE_STAGES: ReadonlySet<FunnelStage> = new Set(["spend_spike", "spend", "exposure", "entry", "click", "convert"]);

export const STREAK_STAGE_LABEL: Record<"spend_spike" | "spend" | "exposure" | "entry" | "click" | "convert", string> = {
  spend_spike: "消耗突然加快",
  spend: "消耗起不来",
  exposure: "花钱但没曝光",
  entry: "刷到了没进来",
  click: "有曝光没点击",
  convert: "点击转化偏弱"
};

export function consecutiveObviousStageCount(
  current: { stage: FunnelStage; obvious: boolean },
  prior: readonly { stage: FunnelStage; obvious: boolean }[]
): number {
  if (!current.obvious || !STREAKABLE_STAGES.has(current.stage)) return 1;
  let count = 1;
  for (let index = prior.length - 1; index >= 0; index -= 1) {
    const item = prior[index]!;
    if (!item.obvious || item.stage !== current.stage) break;
    count += 1;
  }
  return Math.min(8, count);
}

export const STAGE_SPEECH_EXPECTATIONS: Record<FunnelStage, readonly string[]> = {
  spend_spike: [],
  spend: [],
  exposure: [],
  entry: ["interaction"],
  click: ["product_benefit", "usage_scenario", "product_card_cta"],
  convert: ["offer", "urgency", "gift", "guarantee", "after_sale"],
  aov: ["gift", "guarantee", "after_sale"],
  maintain: ["gift", "guarantee", "after_sale"],
  wait: []
};

export type FunnelLiveInput = {
  hour: number;
  gmvFen?: number;
  evenGmvFen?: number;
  adSpendFen?: number;
  evenSpendFen?: number;
  prevAdSpendFen?: number;
  impressions?: number;
  prevImpressions?: number;
  watch?: number;
  prevWatch?: number;
  productImpressions?: number;
  productClicks?: number;
  prevProductClicks?: number;
  paidOrders?: number;
  /** 历史小时：观看次数 / 曝光次数。 */
  entryRateMedian?: number;
  /** 上一刻同窗：商品点击次数 / 商品展示次数。 */
  clickRateMedian?: number;
  /** 上一刻同窗：支付订单 / 商品点击次数。 */
  convertRateMedian?: number;
  speechPresentKeys: readonly string[];
  spendSpike: boolean;
};

export type FunnelAdvice = {
  stage: FunnelStage;
  obvious: boolean;
  /** 消耗加快时即使不够打断，结论也要写出漏斗对照。 */
  showFinding: boolean;
  finding?: DiagnosisFinding;
  suggestedKind: DiagnosisActionKind;
  next: DiagnosisFinding;
};

type SpikeLayer = { current: number; prev: number; weak: boolean; clear: boolean };
type SpikeFollow = {
  spendRatio: number;
  exposure?: SpikeLayer;
  watch?: SpikeLayer;
  clicks?: SpikeLayer;
};

function finding(id: string, text: string, citedNumbers: DiagnosisFinding["citedNumbers"]): DiagnosisFinding {
  return { id, text, citedNumbers };
}

function yuan(fen: number): number {
  return Math.round(fen) / 100;
}

function yuanText(fen: number): string {
  return Math.round(yuan(fen)).toLocaleString("zh-CN");
}

function countText(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

function percentPoints(rate: number): number {
  return Math.round(rate * 1000) / 10;
}

function percentText(rate: number): string {
  return percentPoints(rate).toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function clockLabel(hour: number): string {
  return `${hour}点这档`;
}

function isWeak(live: number, reference: number): boolean {
  return reference > 0 && live < WEAK_RATIO * reference;
}

function isClear(live: number, reference: number): boolean {
  return reference > 0 && live < CLEAR_RATIO * reference;
}

function hasSpeech(keys: readonly string[], tag: string): boolean {
  return keys.includes(tag);
}

function rateOf(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  return numerator / denominator;
}

function nextFinding(text: string, citedNumbers: DiagnosisFinding["citedNumbers"]): DiagnosisFinding {
  return finding("action", text, citedNumbers);
}

function ratioOf(current?: number, prev?: number): number | undefined {
  if (current === undefined || prev === undefined || prev <= 0) return undefined;
  return current / prev;
}

function vsLeader(current: number | undefined, prev: number | undefined, leaderRatio: number): SpikeLayer | undefined {
  if (current === undefined || prev === undefined) return undefined;
  if (prev <= 0) return { current, prev, weak: current <= 0, clear: current <= 0 };
  const expected = prev * Math.max(1, leaderRatio);
  return {
    current,
    prev,
    weak: current < expected * WEAK_RATIO,
    clear: current < expected * CLEAR_RATIO
  };
}

function spikeFollow(input: FunnelLiveInput): SpikeFollow | undefined {
  const spendRatio = ratioOf(input.adSpendFen, input.prevAdSpendFen);
  if (!input.spendSpike || spendRatio === undefined) return undefined;
  const exposure = vsLeader(input.impressions, input.prevImpressions, spendRatio);
  const watchLeader = ratioOf(input.impressions, input.prevImpressions) ?? spendRatio;
  const watch = vsLeader(input.watch, input.prevWatch, watchLeader);
  const clickLeader = ratioOf(input.watch, input.prevWatch) ?? watchLeader;
  const clicks = vsLeader(input.productClicks, input.prevProductClicks, clickLeader);
  return {
    spendRatio,
    ...(exposure ? { exposure } : {}),
    ...(watch ? { watch } : {}),
    ...(clicks ? { clicks } : {})
  };
}

function cite(items: DiagnosisFinding["citedNumbers"]): DiagnosisFinding["citedNumbers"] {
  return items.slice(0, 6);
}

function spendPairCited(input: FunnelLiveInput): DiagnosisFinding["citedNumbers"] {
  return [
    ...(input.adSpendFen !== undefined ? [{ label: "这15分钟消耗", value: yuan(input.adSpendFen), unit: "元" }] : []),
    ...(input.prevAdSpendFen !== undefined ? [{ label: "上一刻消耗", value: yuan(input.prevAdSpendFen), unit: "元" }] : [])
  ];
}

function layerCited(label: string, layer: SpikeLayer, unit: string): DiagnosisFinding["citedNumbers"] {
  return [
    { label: `这15分钟${label}`, value: layer.current, unit },
    { label: `上一刻${label}`, value: layer.prev, unit }
  ];
}

function fromTo(label: string, layer: SpikeLayer | undefined, unit: string): string {
  if (!layer) return `${label}还对不上上一刻`;
  return `${label}从 ${countText(layer.prev)} 到 ${countText(layer.current)} ${unit}`;
}

function spendLow(input: FunnelLiveInput, clear: boolean): boolean {
  if (input.adSpendFen === undefined || input.evenSpendFen === undefined) return false;
  return clear ? isClear(input.adSpendFen, input.evenSpendFen) : isWeak(input.adSpendFen, input.evenSpendFen);
}

function exposureWeak(input: FunnelLiveInput): boolean {
  if (input.impressions === undefined) return false;
  if (input.adSpendFen !== undefined && input.adSpendFen > 0 && input.impressions === 0) return true;
  if (input.prevImpressions === undefined || input.prevAdSpendFen === undefined || input.adSpendFen === undefined) return false;
  const spendHeld = input.prevAdSpendFen <= 0 || input.adSpendFen >= WEAK_RATIO * input.prevAdSpendFen;
  return spendHeld && isWeak(input.impressions, input.prevImpressions);
}

function exposureClear(input: FunnelLiveInput): boolean {
  if (input.impressions === undefined) return false;
  if (input.adSpendFen !== undefined && input.adSpendFen > 0 && input.impressions === 0) return true;
  if (input.prevImpressions === undefined || input.prevAdSpendFen === undefined || input.adSpendFen === undefined) return false;
  const spendHeld = input.prevAdSpendFen <= 0 || input.adSpendFen >= WEAK_RATIO * input.prevAdSpendFen;
  return spendHeld && isClear(input.impressions, input.prevImpressions);
}

function entryWeak(input: FunnelLiveInput): boolean {
  if (input.impressions === undefined || input.impressions < MIN_IMPRESSIONS_FOR_ENTRY) return false;
  const live = rateOf(input.watch, input.impressions);
  return live !== undefined && input.entryRateMedian !== undefined && isWeak(live, input.entryRateMedian);
}

function entryClear(input: FunnelLiveInput): boolean {
  if (input.impressions === undefined || input.impressions < MIN_IMPRESSIONS_FOR_ENTRY) return false;
  const live = rateOf(input.watch, input.impressions);
  return live !== undefined && input.entryRateMedian !== undefined && isClear(live, input.entryRateMedian);
}

function clickWeak(input: FunnelLiveInput): boolean {
  const live = rateOf(input.productClicks, input.productImpressions);
  return live !== undefined
    && input.productImpressions !== undefined
    && input.productImpressions >= MIN_PRODUCT_IMPRESSIONS_FOR_CLICK
    && input.clickRateMedian !== undefined
    && isWeak(live, input.clickRateMedian);
}

function clickClear(input: FunnelLiveInput): boolean {
  const live = rateOf(input.productClicks, input.productImpressions);
  return live !== undefined
    && input.productImpressions !== undefined
    && input.productImpressions >= MIN_PRODUCT_IMPRESSIONS_FOR_CLICK
    && input.clickRateMedian !== undefined
    && isClear(live, input.clickRateMedian);
}

function convertReady(input: FunnelLiveInput): boolean {
  return input.productClicks !== undefined && input.paidOrders !== undefined && input.productClicks >= MIN_CLICKS_FOR_CONVERT;
}

function convertWeak(input: FunnelLiveInput): boolean {
  if (!convertReady(input)) return false;
  if (input.paidOrders === 0) return true;
  const live = rateOf(input.paidOrders, input.productClicks);
  return live !== undefined && input.convertRateMedian !== undefined && isWeak(live, input.convertRateMedian);
}

function convertClear(input: FunnelLiveInput): boolean {
  if (!convertReady(input)) return false;
  if (input.paidOrders === 0) return true;
  const live = rateOf(input.paidOrders, input.productClicks);
  return live !== undefined && input.convertRateMedian !== undefined && isClear(live, input.convertRateMedian);
}

function gmvWeak(input: FunnelLiveInput): boolean {
  return input.gmvFen !== undefined && input.evenGmvFen !== undefined && isWeak(input.gmvFen, input.evenGmvFen);
}

function exposureRose(layer?: SpikeLayer): boolean {
  return layer !== undefined && layer.current > layer.prev;
}

function exposureCollapsed(layer?: SpikeLayer): boolean {
  return layer !== undefined && layer.prev > 0 && layer.current < layer.prev * CLEAR_RATIO;
}

/** 消耗加快、曝光绝对量没涨也没塌：当更准的人群，不判流量质量。 */
function isPreciseTraffic(follow?: SpikeFollow): boolean {
  return Boolean(follow?.exposure && !exposureRose(follow.exposure) && !exposureCollapsed(follow.exposure));
}

function hasAnyClicks(input: FunnelLiveInput): boolean {
  return input.productClicks !== undefined && input.productClicks > 0;
}

function pickAfterSpendSpike(input: FunnelLiveInput, follow: SpikeFollow): FunnelStage {
  if (follow.exposure && exposureCollapsed(follow.exposure)) return "exposure";
  const precise = isPreciseTraffic(follow);
  if (precise && convertReady(input) && convertWeak(input)) return "convert";
  if (follow.watch?.weak && !precise) return "entry";
  if (follow.watch?.weak && precise && !hasAnyClicks(input)) return "entry";
  if (follow.clicks?.weak) return "click";
  if (convertWeak(input)) return "convert";
  return "spend_spike";
}

function pickStage(input: FunnelLiveInput, follow?: SpikeFollow): FunnelStage {
  if (spendLow(input, true)) return "spend";
  if (follow) return pickAfterSpendSpike(input, follow);
  if (exposureWeak(input) && !spendLow(input, true)) return "exposure";
  if (entryWeak(input)) return "entry";
  if (clickWeak(input)) return "click";
  if (convertWeak(input)) return "convert";
  if (gmvWeak(input)) return "aov";
  if (input.gmvFen === undefined && input.adSpendFen === undefined && input.impressions === undefined && input.productClicks === undefined) return "wait";
  return "maintain";
}

function stageObvious(stage: FunnelStage, input: FunnelLiveInput, follow?: SpikeFollow): boolean {
  if (stage === "spend_spike") return false;
  if (stage === "spend") return spendLow(input, true);
  if (stage === "exposure") return follow?.exposure?.clear ?? exposureClear(input);
  if (stage === "entry") return follow?.watch?.clear ?? entryClear(input);
  if (stage === "click") return follow?.clicks?.clear ?? clickClear(input);
  if (stage === "convert") return convertClear(input);
  return false;
}

function spendCited(input: FunnelLiveInput): DiagnosisFinding["citedNumbers"] {
  return [
    ...(input.adSpendFen !== undefined ? [{ label: "这15分钟消耗", value: yuan(input.adSpendFen), unit: "元" }] : []),
    ...(input.evenSpendFen !== undefined ? [{ label: "均匀的话每15分钟消耗", value: yuan(input.evenSpendFen), unit: "元" }] : [])
  ];
}

function convertCited(input: FunnelLiveInput): DiagnosisFinding["citedNumbers"] {
  return [
    { label: "商品点击", value: input.productClicks ?? 0, unit: "次" },
    { label: "支付订单", value: input.paidOrders ?? 0, unit: "单" }
  ];
}
function convertCountSentence(clicks: number, paidOrders: number): string {
  return `点了 ${countText(clicks)} 次，成交 ${countText(paidOrders)} 单。`;
}
function convertVerdictTail(paidOrders: number): string {
  return paidOrders > 0 ? "有点击，成单偏少。" : "有点击、还没变成单。";
}

function hasSeedingSpeech(input: FunnelLiveInput): boolean {
  return hasSpeech(input.speechPresentKeys, "product_benefit")
    || hasSpeech(input.speechPresentKeys, "product_efficacy")
    || hasSpeech(input.speechPresentKeys, "usage_scenario");
}

function convertAction(input: FunnelLiveInput, preciseTraffic: boolean): { kind: DiagnosisActionKind; next: DiagnosisFinding } {
  const cited = convertCited(input);
  const clicks = countText(input.productClicks ?? 0);
  const paid = countText(input.paidOrders ?? 0);
  const hasClose = hasSpeech(input.speechPresentKeys, "gift")
    && hasSpeech(input.speechPresentKeys, "guarantee")
    && hasSpeech(input.speechPresentKeys, "after_sale");
  const hasPrice = hasSpeech(input.speechPresentKeys, "price") || hasSpeech(input.speechPresentKeys, "offer");
  const alreadyPushing = hasSpeech(input.speechPresentKeys, "purchase_cta") || hasSpeech(input.speechPresentKeys, "urgency");
  if (preciseTraffic && !alreadyPushing) {
    return {
      kind: "close_urgency",
      next: nextFinding(`消耗加快、曝光没跟着涨，这波人更可能更准。下一刻强化逼单：把机制和稀缺感讲清楚。这15分钟点了 ${clicks} 次，成交 ${paid} 单。`, cited)
    };
  }
  if (hasClose && hasPrice) {
    return {
      kind: "hold",
      next: nextFinding(`暂不调整。这15分钟点了 ${clicks} 次，成交 ${paid} 单。赠品、保障和到手价都听到了，先等支付间隔。`, cited)
    };
  }
  if (hasClose) {
    return {
      kind: "close_price",
      next: nextFinding(`赠品和保障已经有了，下一刻补到手价：这15分钟点了 ${clicks} 次，成交 ${paid} 单。`, cited)
    };
  }
  return {
    kind: "close_gift",
    next: nextFinding(
      alreadyPushing
        ? `催单已经有了，下一刻先把赠品、保障、售后讲清楚：这15分钟点了 ${clicks} 次，成交 ${paid} 单。`
        : `下一刻先把赠品、保障、售后讲清楚：这15分钟点了 ${clicks} 次，成交 ${paid} 单。先不要催单。`,
      cited
    )
  };
}

/**
 * 从漏斗上往下找第一处掉档。消耗必须明显偏低才定位到投放；
 * 消耗加快时：曝光绝对量涨了就看观看；曝光没涨且没塌则当更准人群，有点击就往成交收口；
 * 只有曝光相对上一刻塌掉（低于 60%）才停在流量质量。
 * 转化至少 10 次点击才判。suggestedKind 是「若要动作」的默认项，明显性由 obvious 给出。
 */
export function diagnoseFunnelAdvice(input: FunnelLiveInput): FunnelAdvice {
  const follow = spikeFollow(input);
  const stage = pickStage(input, follow);
  const obvious = stageObvious(stage, input, follow);
  const hour = clockLabel(input.hour);
  const showFinding = obvious || Boolean(follow && (stage === "spend_spike" || stage === "exposure" || stage === "entry" || stage === "click" || stage === "convert"));
  const advice = (partial: Omit<FunnelAdvice, "showFinding">): FunnelAdvice => ({ ...partial, showFinding });

  if (stage === "spend_spike" && input.adSpendFen !== undefined && input.prevAdSpendFen !== undefined) {
    const cited = cite([
      ...spendPairCited(input),
      ...(follow?.exposure ? [{ label: "这15分钟曝光", value: follow.exposure.current, unit: "次" }] : []),
      ...(follow?.watch ? [{ label: "这15分钟观看", value: follow.watch.current, unit: "次" }] : []),
      ...(follow?.clicks ? [{ label: "这15分钟商品点击", value: follow.clicks.current, unit: "次" }] : [])
    ]);
    const complete = Boolean(follow?.exposure && follow?.watch && follow?.clicks);
    const chainLine = `${fromTo("曝光", follow?.exposure, "次")}，${fromTo("观看", follow?.watch, "次")}，${fromTo("商品点击", follow?.clicks, "次")}`;
    const text = complete
      ? `这15分钟消耗从 ${yuanText(input.prevAdSpendFen)} 到 ${yuanText(input.adSpendFen)} 元。${chainLine}，都跟上了加量。先别改话术。`
      : follow?.exposure || follow?.watch || follow?.clicks
        ? `这15分钟消耗从 ${yuanText(input.prevAdSpendFen)} 到 ${yuanText(input.adSpendFen)} 元。${chainLine}。能对照的层跟上了加量，缺的不编。`
        : `这15分钟消耗从 ${yuanText(input.prevAdSpendFen)} 到 ${yuanText(input.adSpendFen)} 元。曝光、观看、点击还对不上上一刻，不判断有没有跟上。`;
    return advice({
      stage,
      obvious,
      finding: finding("funnel-spend", text, cited),
      suggestedKind: "hold",
      next: nextFinding(
        complete
          ? `暂不调整。消耗加快后曝光、观看、点击都跟上了，这15分钟花了 ${yuanText(input.adSpendFen)} 元。先别改话术。`
          : `暂不调整。消耗从 ${yuanText(input.prevAdSpendFen)} 到 ${yuanText(input.adSpendFen)} 元，漏斗还对不上或不完整，先看大屏。`,
        cited
      )
    });
  }

  if (stage === "spend" && input.adSpendFen !== undefined && input.evenSpendFen !== undefined) {
    const cited = spendCited(input);
    return advice({
      stage,
      obvious,
      finding: finding("funnel-spend", `这15分钟消耗 ${yuanText(input.adSpendFen)} 元，明显低于均匀节奏大约 ${yuanText(input.evenSpendFen)} 元。曝光还没铺够，先看投放在不在跑。`, cited),
      suggestedKind: "check_spend",
      next: nextFinding(`下一刻先核对投放：这15分钟花了 ${yuanText(input.adSpendFen)} 元，均匀节奏大约 ${yuanText(input.evenSpendFen)} 元。先确认在跑，再改话术。`, cited)
    });
  }

  if (stage === "exposure" && follow?.exposure && input.adSpendFen !== undefined && input.prevAdSpendFen !== undefined) {
    const cited = cite([...spendPairCited(input), ...layerCited("曝光", follow.exposure, "次")]);
    return advice({
      stage,
      obvious,
      finding: finding("funnel-exposure", `这15分钟消耗从 ${yuanText(input.prevAdSpendFen)} 到 ${yuanText(input.adSpendFen)} 元。${fromTo("曝光", follow.exposure, "次")}，没跟上加量。先看流量质量，先别改话术。`, cited),
      suggestedKind: "traffic_quality",
      next: nextFinding(`下一刻先看流量质量：消耗从 ${yuanText(input.prevAdSpendFen)} 到 ${yuanText(input.adSpendFen)} 元，曝光从 ${countText(follow.exposure.prev)} 到 ${countText(follow.exposure.current)} 次。先别加戏。`, cited)
    });
  }

  if (stage === "exposure" && input.adSpendFen !== undefined && input.impressions !== undefined) {
    const cited: DiagnosisFinding["citedNumbers"] = [
      { label: "这15分钟消耗", value: yuan(input.adSpendFen), unit: "元" },
      { label: "这15分钟曝光", value: input.impressions, unit: "次" },
      ...(input.prevAdSpendFen !== undefined ? [{ label: "上一刻消耗", value: yuan(input.prevAdSpendFen), unit: "元" }] : []),
      ...(input.prevImpressions !== undefined ? [{ label: "上一刻曝光", value: input.prevImpressions, unit: "次" }] : [])
    ];
    const vsPrev = input.prevImpressions !== undefined && input.prevAdSpendFen !== undefined
      ? `上一刻花 ${yuanText(input.prevAdSpendFen)} 元，曝光 ${countText(input.prevImpressions)} 次。`
      : "";
    return advice({
      stage,
      obvious,
      finding: finding("funnel-exposure", `这15分钟花了 ${yuanText(input.adSpendFen)} 元，曝光 ${countText(input.impressions)} 次。${vsPrev}消耗还在，带进来的曝光偏少。`.trim(), cited),
      suggestedKind: "traffic_quality",
      next: nextFinding(`下一刻先看流量质量，先别加戏：这15分钟花了 ${yuanText(input.adSpendFen)} 元，曝光 ${countText(input.impressions)} 次。`, [
        { label: "这15分钟消耗", value: yuan(input.adSpendFen), unit: "元" },
        { label: "这15分钟曝光", value: input.impressions, unit: "次" }
      ])
    });
  }

  if (stage === "entry" && follow?.watch && input.adSpendFen !== undefined && input.prevAdSpendFen !== undefined) {
    const cited = cite([
      ...spendPairCited(input),
      ...(follow.exposure ? layerCited("曝光", follow.exposure, "次") : []),
      ...layerCited("观看", follow.watch, "次")
    ]);
    return advice({
      stage,
      obvious,
      finding: finding("funnel-entry", `这15分钟消耗从 ${yuanText(input.prevAdSpendFen)} 到 ${yuanText(input.adSpendFen)} 元。${fromTo("曝光", follow.exposure, "次")}。${fromTo("观看", follow.watch, "次")}，进来的人没跟上曝光。先把人接住。`, cited),
      suggestedKind: "retain",
      next: nextFinding(
        hasSpeech(input.speechPresentKeys, "interaction")
          ? `下一刻先把互动落到商品上：观看从 ${countText(follow.watch.prev)} 到 ${countText(follow.watch.current)} 次，没跟上曝光。`
          : `下一刻先提状态、把人留住：观看从 ${countText(follow.watch.prev)} 到 ${countText(follow.watch.current)} 次，没跟上曝光。先互动把人接住。`,
        cite([...layerCited("观看", follow.watch, "次")])
      )
    });
  }

  if (stage === "entry") {
    const live = rateOf(input.watch, input.impressions)!;
    const cited: DiagnosisFinding["citedNumbers"] = [
      { label: "这15分钟曝光进入率", value: percentPoints(live), unit: "%" },
      { label: "平时曝光进入率", value: percentPoints(input.entryRateMedian!), unit: "%" }
    ];
    return advice({
      stage,
      obvious,
      finding: finding("funnel-entry", `这15分钟曝光进入率 ${percentText(live)}%，平时${hour}大约 ${percentText(input.entryRateMedian!)}%。人刷到了但没进来。`, cited),
      suggestedKind: "retain",
      next: nextFinding(
        hasSpeech(input.speechPresentKeys, "interaction")
          ? `下一刻先把互动落到商品上：这15分钟曝光进入率 ${percentText(live)}%，平时${hour}大约 ${percentText(input.entryRateMedian!)}%。`
          : `下一刻先提状态、把人留住：这15分钟曝光进入率 ${percentText(live)}%，平时${hour}大约 ${percentText(input.entryRateMedian!)}%。先互动把人接住。`,
        cited
      )
    });
  }

  if (stage === "click" && follow?.clicks && input.adSpendFen !== undefined && input.prevAdSpendFen !== undefined) {
    const cited = cite([
      ...spendPairCited(input),
      ...(follow.watch ? layerCited("观看", follow.watch, "次") : []),
      ...layerCited("商品点击", follow.clicks, "次")
    ]);
    return advice({
      stage,
      obvious,
      finding: finding("funnel-click", `这15分钟消耗从 ${yuanText(input.prevAdSpendFen)} 到 ${yuanText(input.adSpendFen)} 元。${fromTo("观看", follow.watch, "次")}。${fromTo("商品点击", follow.clicks, "次")}，点击没跟上进来的人。`, cited),
      suggestedKind: "click_cta",
      next: nextFinding(
        !hasSeedingSpeech(input)
          ? `下一刻把痛点和种草讲清楚，再让人点小黄车：点击从 ${countText(follow.clicks.prev)} 到 ${countText(follow.clicks.current)} 次，没跟上观看。`
          : hasSpeech(input.speechPresentKeys, "product_card_cta")
            ? `下一刻把利益点讲得更具体，再给一次点小黄车：点击从 ${countText(follow.clicks.prev)} 到 ${countText(follow.clicks.current)} 次，没跟上观看。`
            : `下一刻先把购物车点清楚：点击从 ${countText(follow.clicks.prev)} 到 ${countText(follow.clicks.current)} 次，没跟上观看。用一句话说完好处再让人点小黄车。`,
        cite([...layerCited("商品点击", follow.clicks, "次")])
      )
    });
  }

  if (stage === "click") {
    const liveRate = rateOf(input.productClicks, input.productImpressions);
    if (liveRate !== undefined && input.clickRateMedian !== undefined) {
      const cited: DiagnosisFinding["citedNumbers"] = [
        { label: "这15分钟商品点击率", value: percentPoints(liveRate), unit: "%" },
        { label: "上一刻商品点击率", value: percentPoints(input.clickRateMedian), unit: "%" }
      ];
      const nextText = !hasSeedingSpeech(input)
        ? `下一刻把痛点和种草讲清楚，再让人点小黄车：这15分钟商品点击率 ${percentText(liveRate)}%，上一刻 ${percentText(input.clickRateMedian)}%。`
        : hasSpeech(input.speechPresentKeys, "product_card_cta")
          ? `下一刻把利益点讲得更具体，再给一次点小黄车：这15分钟商品点击率 ${percentText(liveRate)}%，上一刻 ${percentText(input.clickRateMedian)}%。`
          : `下一刻先把购物车点清楚：这15分钟商品点击率 ${percentText(liveRate)}%，上一刻 ${percentText(input.clickRateMedian)}%。用一句话说完好处再让人点小黄车。`;
      return advice({
        stage,
        obvious,
        finding: finding("funnel-click", `这15分钟商品点击率 ${percentText(liveRate)}%，上一刻 ${percentText(input.clickRateMedian)}%。有展示但点得少。`, cited),
        suggestedKind: "click_cta",
        next: nextFinding(nextText, cited)
      });
    }
    const clicks = input.productClicks ?? 0;
    const cited: DiagnosisFinding["citedNumbers"] = [
      { label: "商品点击", value: clicks, unit: "次" }
    ];
    return advice({
      stage,
      obvious,
      finding: finding("funnel-click", `这15分钟商品点击 ${countText(clicks)} 次。还没有上一刻同口径可对照，先把人带到购物车。`, cited),
      suggestedKind: "click_cta",
      next: nextFinding(`下一刻先明确让人点小黄车：这15分钟点了 ${countText(clicks)} 次。`, cited)
    });
  }

  if (stage === "convert" && input.productClicks !== undefined && input.paidOrders !== undefined) {
    const preciseTraffic = isPreciseTraffic(follow);
    const convert = convertAction(input, preciseTraffic);
    const cited = preciseTraffic && follow?.exposure && input.adSpendFen !== undefined
      ? cite([...spendPairCited(input), ...layerCited("曝光", follow.exposure, "次"), ...convertCited(input)])
      : convertCited(input);
    const counts = convertCountSentence(input.productClicks, input.paidOrders);
    const findingText = preciseTraffic && follow?.exposure && input.adSpendFen !== undefined && input.prevAdSpendFen !== undefined
      ? `这15分钟消耗从 ${yuanText(input.prevAdSpendFen)} 到 ${yuanText(input.adSpendFen)} 元。曝光从 ${countText(follow.exposure.prev)} 到 ${countText(follow.exposure.current)} 次，没跟着加量涨，进来的人更可能更准。${counts}${input.paidOrders > 0 ? "有点击，成单偏少。" : ""}`
      : `这15分钟${counts}${convertVerdictTail(input.paidOrders)}`;
    return advice({
      stage,
      obvious,
      finding: finding("funnel-convert", findingText, cited),
      suggestedKind: convert.kind,
      next: convert.next
    });
  }

  if (stage === "aov" && input.gmvFen !== undefined && input.evenGmvFen !== undefined) {
    const cited: DiagnosisFinding["citedNumbers"] = [
      { label: "这15分钟成交", value: yuan(input.gmvFen), unit: "元" },
      { label: "均匀的话每15分钟", value: yuan(input.evenGmvFen), unit: "元" }
    ];
    return advice({
      stage,
      obvious: false,
      finding: finding("funnel-aov", `漏斗没有明显掉档，但这15分钟成交 ${yuanText(input.gmvFen)} 元，还低于均匀节奏大约 ${yuanText(input.evenGmvFen)} 元。成交是结果，先不当成动作。`, cited),
      suggestedKind: "hold",
      next: nextFinding(`暂不调整。漏斗没有明显掉档，这15分钟成交 ${yuanText(input.gmvFen)} 元，均匀节奏大约 ${yuanText(input.evenGmvFen)} 元。`, cited)
    });
  }

  if (stage === "wait") {
    return advice({
      stage,
      obvious: false,
      suggestedKind: "wait",
      next: nextFinding("等下一个完整15分钟再判断，现在先盯曝光、点击和成交大屏。", [
        { label: "窗口分钟", value: 15, unit: "分钟" }
      ])
    });
  }

  return advice({
    stage: "maintain",
    obvious: false,
    suggestedKind: "hold",
    next: nextFinding(`暂不调整，保持现在的讲解节奏。漏斗没有明显掉档。先盯 ${input.hour} 点这档。`, [
      { label: "小时", value: input.hour, unit: "点" }
    ])
  });
}

export function missingSpeechKeys(stage: FunnelStage, present: readonly string[]): string[] {
  return STAGE_SPEECH_EXPECTATIONS[stage].filter((key) => !present.includes(key));
}
