import {
  diagnosisWindowSchema,
  type DiagnosisActionKind,
  type DiagnosisAnomaly,
  type DiagnosisConfidence,
  type DiagnosisFinding,
  type DiagnosisWindow,
  type HistoricalHourRoomAggregate,
  type LiveWindowAggregate,
  type MvpStateId
} from "@live-growth/contracts";
import { computeSameWeekdayHourBaseline, computeSameWeekdayHourRatio, hourForSlotIndex } from "./historical-hour-baseline";
import {
  consecutiveObviousStageCount,
  diagnoseFunnelAdvice,
  missingSpeechKeys,
  STREAK_STAGE_LABEL,
  type FunnelStage
} from "./live-diagnosis-funnel";

const HOUR_NOTE = "整点除以4只作弱参考，小偏离不作为动作。" as const;
const QUARTERS_PER_HOUR = 4;
const SPEECH_LABEL: Record<string, string> = {
  product_benefit: "卖点",
  product_efficacy: "功效",
  ingredient_or_principle: "成分",
  usage_scenario: "使用场景",
  suitable_audience: "适用人群",
  price: "价格",
  offer: "优惠",
  gift: "赠品",
  guarantee: "保障",
  after_sale: "售后",
  product_card_cta: "点小黄车",
  purchase_cta: "催下单",
  urgency: "紧迫感",
  interaction: "互动",
  chatter: "闲聊"
};

export type DiagnoseLiveWindowInput = {
  sessionId: string;
  current: LiveWindowAggregate;
  previous?: LiveWindowAggregate;
  priorWindows?: readonly LiveWindowAggregate[];
  rooms: readonly HistoricalHourRoomAggregate[];
  asOfLocalDate?: string;
  stateShare: Record<MvpStateId, number>;
  currentProductName?: string;
  speechPresentKeys?: readonly string[];
};

function optionalFen(window: LiveWindowAggregate | undefined, compassKey: string, qianchuanKey?: string): number | undefined {
  if (!window) return undefined;
  const compass = window.compass[compassKey]?.delta ?? (window.compass[compassKey]?.semantic === "instant" ? window.compass[compassKey]?.last : undefined);
  if (compass !== undefined) return compass;
  if (!qianchuanKey) return undefined;
  const qc = window.qianchuan[qianchuanKey];
  if (!qc) return undefined;
  if (qc.semantic === "cumulative") return qc.delta !== undefined ? Math.round(qc.delta * 100) : undefined;
  return qc.last;
}

function optionalCount(window: LiveWindowAggregate | undefined, qianchuanKey: string): number | undefined {
  if (!window) return undefined;
  const qc = window.qianchuan[qianchuanKey];
  if (!qc) return undefined;
  if (qc.semantic === "cumulative") return qc.delta;
  if (qc.semantic === "instant") return qc.last;
  return undefined;
}

function yuan(fen: number): number {
  return Math.round(fen) / 100;
}

function yuanText(fen: number): string {
  return Math.round(yuan(fen)).toLocaleString("zh-CN");
}

function evenPaceFen(hourMedianFen: number): number {
  return Math.round(hourMedianFen / QUARTERS_PER_HOUR);
}

function speechLabels(keys: readonly string[]): string[] {
  return keys.flatMap((key) => {
    const label = SPEECH_LABEL[key];
    return label ? [label] : [];
  }).filter((label, index, list) => list.indexOf(label) === index);
}

function finding(id: string, text: string, citedNumbers: DiagnosisFinding["citedNumbers"]): DiagnosisFinding {
  return { id, text, citedNumbers };
}

function holdAction(text: string, citedNumbers: DiagnosisFinding["citedNumbers"]): DiagnosisFinding {
  return finding("action", text, citedNumbers);
}

function pickConfidence(input: {
  obvious: boolean;
  dataEvidence: boolean;
  speechEvidence: boolean;
  speechAligned: boolean;
}): DiagnosisConfidence {
  if (!input.obvious) return "unknown";
  if (input.dataEvidence && input.speechEvidence && input.speechAligned) return "confirmed";
  if (input.dataEvidence || input.speechEvidence) return "leaning";
  return "unknown";
}

function buildSpeechEvidence(
  presentKeys: readonly string[],
  missingKeys: readonly string[],
  speechFinalCount: number
): DiagnosisFinding {
  const heard = speechLabels(presentKeys).slice(0, 6);
  const missing = speechLabels(missingKeys).slice(0, 4);
  if (speechFinalCount <= 0) {
    return finding("speech-coverage", "这15分钟窗口内没有转写出完整句子。", [
      { label: "完整句子", value: 0, unit: "条" },
      { label: "窗口分钟", value: 15, unit: "分钟" }
    ]);
  }
  const heardLine = heard.length > 0 ? `转写里有${heard.join("、")}。` : "转写里没有可点名的要点。";
  const missingLine = missing.length > 0 ? `没有${missing.join("、")}。` : "";
  return finding("speech-coverage", `这15分钟${heardLine}${missingLine}`, [
    { label: "听清的要点", value: heard.length, unit: "个" },
    { label: "完整句子", value: speechFinalCount, unit: "条" }
  ]);
}

function watchFor(kind: DiagnosisActionKind, stage: FunnelStage): DiagnosisFinding {
  const cited: DiagnosisFinding["citedNumbers"] = [{ label: "窗口分钟", value: 15, unit: "分钟" }];
  if (kind === "hold" && stage === "spend_spike") return finding("watch", "下个15分钟看曝光、观看、点击有没有一起跟上消耗，不要只看花钱变快。", cited);
  if (kind === "check_spend") return finding("watch", "下个15分钟看消耗还在不在跑，先不要用成交判断投放。", cited);
  if (kind === "close_urgency") return finding("watch", "下个15分钟看支付人数有没有出现。先看机制和稀缺感有没有讲完。", cited);
  if (kind === "close_gift" || kind === "close_price") return finding("watch", "下个15分钟看支付人数有没有出现。先看赠品、保障、售后有没有讲完。", cited);
  if (kind === "click_cta") return finding("watch", "下个15分钟看商品点击有没有增加，先不要用成交判断这段话术。", cited);
  if (kind === "retain") return finding("watch", "下个15分钟看进入和停留有没有一起改善，不要只看在线人数。", cited);
  if (kind === "traffic_quality") return finding("watch", "下个15分钟先看曝光还在不在，不要加戏。", cited);
  return finding("watch", "下个15分钟先看点击还在不在累计。若点击明显增加仍没有单，再查赠品和保障有没有讲；消耗若掉一截，再核投放。", cited);
}

function spendSpikeBetween(current: LiveWindowAggregate, previous?: LiveWindowAggregate): boolean {
  const adSpendFen = optionalFen(current, "adSpendFen", "adSpend");
  const prevAdSpendFen = optionalFen(previous, "adSpendFen", "adSpend");
  return adSpendFen !== undefined && prevAdSpendFen !== undefined && prevAdSpendFen > 0 && adSpendFen >= prevAdSpendFen * 1.5;
}

function funnelAdviceForWindow(
  current: LiveWindowAggregate,
  previous: LiveWindowAggregate | undefined,
  rooms: readonly HistoricalHourRoomAggregate[],
  asOfLocalDate: string | undefined,
  speechPresentKeys: readonly string[]
): ReturnType<typeof diagnoseFunnelAdvice> {
  const hour = hourForSlotIndex(current.slotIndex).hour;
  const hourQuery = { weekday: current.weekday, hour, ...(asOfLocalDate ? { asOfLocalDate } : {}) };
  const gmvBaseline = computeSameWeekdayHourBaseline(rooms, { ...hourQuery, metricKey: "gmvFen" });
  const spendBaseline = computeSameWeekdayHourBaseline(rooms, { ...hourQuery, metricKey: "adSpendFen" });
  const entryRateBaseline = computeSameWeekdayHourRatio(rooms, {
    ...hourQuery,
    numeratorKey: "roomEnterPv",
    denominatorKey: "roomImpressionPv"
  });
  const gmvFen = optionalFen(current, "sessionPaidGmvFen");
  const adSpendFen = optionalFen(current, "adSpendFen", "adSpend");
  const prevAdSpendFen = optionalFen(previous, "adSpendFen", "adSpend");
  const impressions = optionalCount(current, "liveImpressions");
  const prevImpressions = optionalCount(previous, "liveImpressions");
  const watch = optionalCount(current, "liveWatchCount");
  const prevWatch = optionalCount(previous, "liveWatchCount");
  const productImpressions = optionalCount(current, "productImpressions");
  const productClicks = optionalCount(current, "productClicks");
  const prevProductClicks = optionalCount(previous, "productClicks");
  const prevProductImpressions = optionalCount(previous, "productImpressions");
  const paidOrders = optionalCount(current, "paidOrderCount");
  const prevPaidOrders = optionalCount(previous, "paidOrderCount");
  const prevClickRate = prevProductImpressions !== undefined && prevProductImpressions >= 5 && prevProductClicks !== undefined
    ? prevProductClicks / prevProductImpressions
    : undefined;
  const prevConvertRate = prevProductClicks !== undefined && prevProductClicks >= 2 && prevPaidOrders !== undefined
    ? prevPaidOrders / prevProductClicks
    : undefined;
  return diagnoseFunnelAdvice({
    hour,
    speechPresentKeys,
    spendSpike: spendSpikeBetween(current, previous),
    ...(gmvFen !== undefined ? { gmvFen } : {}),
    ...(gmvBaseline.status === "ok" ? { evenGmvFen: evenPaceFen(gmvBaseline.median) } : {}),
    ...(adSpendFen !== undefined ? { adSpendFen } : {}),
    ...(spendBaseline.status === "ok" ? { evenSpendFen: evenPaceFen(spendBaseline.median) } : {}),
    ...(prevAdSpendFen !== undefined ? { prevAdSpendFen } : {}),
    ...(impressions !== undefined ? { impressions } : {}),
    ...(prevImpressions !== undefined ? { prevImpressions } : {}),
    ...(watch !== undefined ? { watch } : {}),
    ...(prevWatch !== undefined ? { prevWatch } : {}),
    ...(productImpressions !== undefined ? { productImpressions } : {}),
    ...(productClicks !== undefined ? { productClicks } : {}),
    ...(prevProductClicks !== undefined ? { prevProductClicks } : {}),
    ...(paidOrders !== undefined ? { paidOrders } : {}),
    ...(entryRateBaseline.status === "ok" ? { entryRateMedian: entryRateBaseline.median } : {}),
    ...(prevClickRate !== undefined ? { clickRateMedian: prevClickRate } : {}),
    ...(prevConvertRate !== undefined ? { convertRateMedian: prevConvertRate } : {})
  });
}

function streakLabel(stage: FunnelStage): string {
  return stage in STREAK_STAGE_LABEL ? STREAK_STAGE_LABEL[stage as keyof typeof STREAK_STAGE_LABEL] : "同一掉档";
}

function applyStreakToVerdict(verdict: DiagnosisFinding, stage: FunnelStage, streakCount: number): DiagnosisFinding {
  if (streakCount < 2) return verdict;
  return {
    ...verdict,
    text: `连续${streakCount}个15分钟都卡在${streakLabel(stage)}。${verdict.text}`.slice(0, 400),
    citedNumbers: [{ label: "连续窗口", value: streakCount, unit: "个" }, ...verdict.citedNumbers].slice(0, 6)
  };
}

function streakPending(stage: FunnelStage, streakCount: number): DiagnosisFinding | undefined {
  if (streakCount < 3) return undefined;
  return finding(
    "pending-streak",
    `已经连续 ${streakCount} 个15分钟都卡在${streakLabel(stage)}。先把这一层的动作做完；断播会重置推荐，先不当默认动作。`,
    [
      { label: "连续窗口", value: streakCount, unit: "个" },
      { label: "窗口分钟", value: 15, unit: "分钟" }
    ]
  );
}

/**
 * 纯函数：由已聚合的 15 分钟窗生成确定性诊断卡。不调用 LLM。
 */
export function diagnoseLiveWindow(input: DiagnoseLiveWindowInput): DiagnosisWindow {
  const { current, previous, rooms, asOfLocalDate } = input;
  const hour = hourForSlotIndex(current.slotIndex).hour;
  const hourQuery = { weekday: current.weekday, hour, ...(asOfLocalDate ? { asOfLocalDate } : {}) };
  const gmvBaseline = computeSameWeekdayHourBaseline(rooms, { ...hourQuery, metricKey: "gmvFen" });
  const gsvBaseline = computeSameWeekdayHourBaseline(rooms, { ...hourQuery, metricKey: "gsvFen" });
  const spendBaseline = computeSameWeekdayHourBaseline(rooms, { ...hourQuery, metricKey: "adSpendFen" });
  const onlineBaseline = computeSameWeekdayHourBaseline(rooms, { ...hourQuery, metricKey: "onlineSnapshot" });
  const gmvFen = optionalFen(current, "sessionPaidGmvFen");
  const prevGmvFen = optionalFen(previous, "sessionPaidGmvFen");
  const adSpendFen = optionalFen(current, "adSpendFen", "adSpend");
  const prevAdSpendFen = optionalFen(previous, "adSpendFen", "adSpend");
  const onlineSnapshot = current.compass["onlineSnapshot"]?.last ?? current.qianchuan["onlineSnapshot"]?.last;
  const prevOnline = previous ? previous.compass["onlineSnapshot"]?.last ?? previous.qianchuan["onlineSnapshot"]?.last : undefined;
  const productClicks = optionalCount(current, "productClicks");
  const paidOrders = optionalCount(current, "paidOrderCount");
  const speechFinalCount = current.speech.finalCount;
  const presentKeys = input.speechPresentKeys ?? [];
  const funnel = funnelAdviceForWindow(current, previous, rooms, asOfLocalDate, presentKeys);
  const priorStages = (input.priorWindows ?? []).map((window, index, list) => {
    const priorFunnel = funnelAdviceForWindow(window, index > 0 ? list[index - 1] : undefined, rooms, asOfLocalDate, []);
    return { stage: priorFunnel.stage, obvious: priorFunnel.obvious };
  });
  const streakCount = consecutiveObviousStageCount({ stage: funnel.stage, obvious: funnel.obvious }, priorStages);

  const anomalies: DiagnosisAnomaly[] = [];
  if (adSpendFen !== undefined && prevAdSpendFen !== undefined && prevAdSpendFen > 0 && adSpendFen >= prevAdSpendFen * 1.5) {
    anomalies.push({
      type: "ad_spend_spike",
      text: `投放消耗明显变快：这15分钟花了 ${yuanText(adSpendFen)} 元，上一刻是 ${yuanText(prevAdSpendFen)} 元。漏斗有没有跟上见结论。`,
      citedNumbers: [
        { label: "这15分钟消耗", value: yuan(adSpendFen), unit: "元" },
        { label: "上一刻消耗", value: yuan(prevAdSpendFen), unit: "元" }
      ]
    });
  }

  const missingKeys = missingSpeechKeys(funnel.stage, presentKeys);
  const speechEvidence = buildSpeechEvidence(presentKeys, missingKeys, speechFinalCount);
  const speechHeard = speechFinalCount > 0 && presentKeys.length > 0;
  const speechAligned = speechHeard && (funnel.stage === "spend" || funnel.stage === "spend_spike" || funnel.stage === "exposure" || missingKeys.length > 0 || presentKeys.length > 0);
  const confidence = pickConfidence({
    obvious: funnel.obvious,
    dataEvidence: funnel.obvious,
    speechEvidence: speechHeard,
    speechAligned
  });

  const actNow = funnel.obvious && confidence !== "unknown" && funnel.suggestedKind !== "hold";
  const actionKind: DiagnosisActionKind = actNow ? funnel.suggestedKind : funnel.stage === "wait" ? "wait" : "hold";
  const action = actNow
    ? funnel.next
    : funnel.showFinding && (funnel.suggestedKind === "hold" || funnel.suggestedKind === "wait")
      ? funnel.next
      : holdAction(
        funnel.stage === "wait"
          ? funnel.next.text
          : "暂不调整，保持现在的讲解节奏。这15分钟还没有形成值得打断的问题。",
        [{ label: "窗口分钟", value: 15, unit: "分钟" }]
      );

  const useFindingAsVerdict = Boolean(funnel.finding) && (funnel.obvious || funnel.showFinding);
  const verdict = applyStreakToVerdict(
    useFindingAsVerdict && funnel.finding
      ? finding("verdict", funnel.finding.text, funnel.finding.citedNumbers)
      : finding("verdict", productClicks !== undefined && paidOrders !== undefined
        ? `这15分钟没有形成值得打断的问题。点了 ${productClicks} 次，成交 ${paidOrders} 单。`
        : adSpendFen !== undefined
          ? `这15分钟没有形成值得打断的问题。消耗 ${yuanText(adSpendFen)} 元，先继续观察。`
          : "这15分钟没有形成值得打断的问题。先盯大屏，不编造对比。",
        productClicks !== undefined && paidOrders !== undefined
          ? [{ label: "商品点击", value: productClicks, unit: "次" }, { label: "支付订单", value: paidOrders, unit: "单" }]
          : adSpendFen !== undefined
            ? [{ label: "这15分钟消耗", value: yuan(adSpendFen), unit: "元" }, { label: "窗口分钟", value: 15, unit: "分钟" }]
            : [{ label: "窗口分钟", value: 15, unit: "分钟" }, { label: "罗盘快照", value: current.sampleCounts.compassSnapshots, unit: "条" }]
      ),
    funnel.stage,
    streakCount
  );

  const evidence: DiagnosisFinding[] = [];
  if (!useFindingAsVerdict && !funnel.obvious && funnel.finding && funnel.stage !== "aov") evidence.push(funnel.finding);
  else if (productClicks !== undefined && paidOrders !== undefined) {
    const product = input.currentProductName ? `「${input.currentProductName}」` : "当前商品";
    const fewClicks = productClicks < 10 && paidOrders === 0;
    evidence.push(finding("product-funnel", `讲${product}这段，点了 ${productClicks} 次，成交 ${paidOrders} 单。${fewClicks ? "点击还少，先不按转化坏了来判。" : ""}`.trim(), [
      { label: "商品点击", value: productClicks, unit: "次" },
      { label: "支付订单", value: paidOrders, unit: "单" }
    ]));
  } else if (adSpendFen !== undefined && spendBaseline.status === "ok") {
    const evenFen = evenPaceFen(spendBaseline.median);
    evidence.push(finding("spend-pace", `这15分钟消耗 ${yuanText(adSpendFen)} 元，均匀节奏大约 ${yuanText(evenFen)} 元。差得不够大，先不核投放。`, [
      { label: "这15分钟消耗", value: yuan(adSpendFen), unit: "元" },
      { label: "均匀的话每15分钟消耗", value: yuan(evenFen), unit: "元" }
    ]));
  }
  evidence.push(speechEvidence);
  if (gmvFen !== undefined && gmvBaseline.status === "ok" && !funnel.obvious) {
    const evenFen = evenPaceFen(gmvBaseline.median);
    evidence.push(finding("gmv-pace", `成交 ${yuanText(gmvFen)} 元，均匀节奏大约 ${yuanText(evenFen)} 元。这只是弱参考，不是动作目标。`, [
      { label: "这15分钟成交", value: yuan(gmvFen), unit: "元" },
      { label: "均匀的话每15分钟", value: yuan(evenFen), unit: "元" }
    ]));
  }
  const trimmedEvidence = evidence.slice(0, 4);
  if (trimmedEvidence.length === 0) {
    trimmedEvidence.push(finding("insufficient", "这15分钟能引用的数字还不够，先看大屏，不编造对比。", [
      { label: "罗盘快照", value: current.sampleCounts.compassSnapshots, unit: "条" },
      { label: "千川快照", value: current.sampleCounts.qianchuanSnapshots, unit: "条" }
    ]));
  }

  const pending: DiagnosisFinding[] = [];
  const continuity = streakPending(funnel.stage, streakCount);
  if (continuity) pending.push(continuity);
  if (speechFinalCount <= 0) {
    pending.push(finding("pending-speech", "话术还没能和数据对上。下个窗口先听清有没有讲赠品、保障、售后。", [
      { label: "完整句子", value: 0, unit: "条" },
      { label: "窗口分钟", value: 15, unit: "分钟" }
    ]));
  }
  if (!funnel.obvious && productClicks !== undefined && productClicks > 0 && productClicks < 10 && (paidOrders ?? 0) === 0) {
    pending.push(finding("pending-convert", `点了 ${productClicks} 次还没成交。点击还少，先不按转化坏了来判。`, [
      { label: "商品点击", value: productClicks, unit: "次" },
      { label: "支付订单", value: paidOrders ?? 0, unit: "单" }
    ]));
  }
  if (gmvBaseline.status === "sampleInsufficient") {
    const n = gmvBaseline.n;
    pending.push(finding(
      "pending-baseline",
      n === 0
        ? `同星期 ${hour} 点导入历史里没有完整场次（0 场），不是编造全年没播过。先只看本场上一刻，不用历史高低。`
        : `同星期 ${hour} 点导入历史里只有 ${n} 场，不够 3 场才出平时水平，不是全年没播过。先只看本场上一刻，不用历史高低。`,
      [
        { label: "小时", value: hour, unit: "点" },
        { label: "对照场次", value: n, unit: "场" },
        ...(n > 0 ? [{ label: "最少场次", value: 3, unit: "场" }] : [])
      ]
    ));
  }

  const watchNext = watchFor(actionKind, funnel.stage);
  const conclusions = [verdict, ...trimmedEvidence].slice(0, 3);

  return diagnosisWindowSchema.parse({
    schemaVersion: 1,
    sessionId: input.sessionId,
    windowStartAt: current.windowStartAt,
    windowEndAt: current.windowEndAt,
    windowMinutes: 15,
    weekday: current.weekday,
    slotIndex: current.slotIndex,
    hourAlignment: { hour, grain: "hour", note: HOUR_NOTE },
    coverage: current.coverage,
    provider: "deterministic-template",
    confidence,
    actionKind,
    funnelStage: funnel.stage,
    streakCount,
    current: {
      speechFinalCount,
      ...(gmvFen !== undefined ? { gmvFen } : {}),
      ...(adSpendFen !== undefined ? { adSpendFen } : {}),
      ...(onlineSnapshot !== undefined ? { onlineSnapshot } : {}),
      ...(productClicks !== undefined ? { productClicks } : {}),
      ...(paidOrders !== undefined ? { paidOrders } : {}),
      ...(input.currentProductName ? { currentProductName: input.currentProductName } : {})
    },
    previous: previous ? {
      ...(prevGmvFen !== undefined ? { gmvFen: prevGmvFen } : {}),
      ...(prevAdSpendFen !== undefined ? { adSpendFen: prevAdSpendFen } : {}),
      ...(prevOnline !== undefined ? { onlineSnapshot: prevOnline } : {})
    } : null,
    hourBaseline: {
      grain: "hour",
      gmvFen: gmvBaseline,
      gsvFen: gsvBaseline,
      adSpendFen: spendBaseline,
      ...(onlineBaseline.status === "ok" || (onlineBaseline.status === "sampleInsufficient" && onlineBaseline.n > 0)
        ? { onlineSnapshot: onlineBaseline }
        : {})
    },
    stateShare: input.stateShare,
    speechPresentKeys: [...presentKeys].slice(0, 15),
    anomalies,
    verdict,
    evidence: trimmedEvidence,
    action,
    watchNext,
    pending: pending.slice(0, 3),
    conclusions,
    nextWindowSuggestion: action
  });
}

export function latestCompletedWindow(
  windows: readonly LiveWindowAggregate[],
  asOfMs: number
): { current: LiveWindowAggregate; previous?: LiveWindowAggregate } | undefined {
  const completed = windows.filter((window) => Date.parse(window.windowEndAt) <= asOfMs);
  const current = completed.at(-1);
  if (!current) return undefined;
  const previous = completed.length >= 2 ? completed.at(-2) : undefined;
  return previous ? { current, previous } : { current };
}
