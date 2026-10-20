import {
  canonicalMetricSnapshotSchema,
  type Advice,
  type CanonicalMetricSnapshot,
  type DataEvidence,
  type DetectedEvent,
  type LiveEvent,
  type RuleStatus,
  type SpeechTag
} from "@live-growth/contracts";

export * from "./live-state-engine";
export * from "./operator-live-rules";
export * from "./live-point-mapper";
export * from "./live-window-aggregate";
export * from "./historical-hour-baseline";
export * from "./live-hour-vs-baseline";
export * from "./live-pilot-engine";
export * from "./live-diagnosis-window";
export * from "./live-diagnosis-funnel";
export * from "./live-diagnosis-operating";
export * from "./source-group-health";
export * from "./source-recovery";
export * from "./live-product-role";
export * from "./reference-script";
export * from "./anchor-review";
export * from "./session-review";
export * from "./script-iteration";
export * from "./speech-tags";
export * from "./narrative-adapter";

export const RULE_CONTRACT_VERSION = "rules-v2-synthetic-config-v1";
export const ANALYSIS_WINDOWS_SEC = [30, 60, 120, 300, 900] as const;
export type AnalysisWindowSec = typeof ANALYSIS_WINDOWS_SEC[number];

function stableToken(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface RuleConfig {
  id: `R00${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
  version: number;
  title: string;
  condition: string;
  minSamples: number;
  mainWindowSec: 120;
  trendWindowSec: 300;
  severity: "info" | "warning" | "critical";
  cooldownSec: number;
  expiresSec: number;
  thresholds: Record<string, number>;
  businessMinimums?: {
    mainProductImpressionDelta?: number;
    mainProductClickDelta?: number;
    comparisonProductImpressionDelta?: number;
    comparisonProductClickDelta?: number;
  };
  calibration?: { version: string; sourceRefs: string[]; scope: "synthetic_example" | "user_configured" };
  nonTriggerConditions: string[];
  confounders: string[];
  adviceTemplate: { problem: string; action: string; hostMessage: string; limitations: string[] };
}

/** Independent synthetic defaults for software demonstration only. Supply reviewed settings for real use. */
export const RULE_CONFIGS: readonly RuleConfig[] = [
  {
    "id": "R001",
    "version": 1,
    "title": "进入后点击偏弱",
    "condition": "仅供合成演示：使用本条显式阈值和代码中的缺失样本检查。",
    "minSamples": 5,
    "mainWindowSec": 120,
    "trendWindowSec": 300,
    "severity": "warning",
    "cooldownSec": 180,
    "expiresSec": 180,
    "thresholds": {
      "roomEnterDeltaMin": 32,
      "productClickRateMax": 0.08
    },
    "calibration": {
      "version": "public-synthetic-v1",
      "sourceRefs": [
        "synthetic-config:public-v1"
      ],
      "scope": "synthetic_example"
    },
    "nonTriggerConditions": [
      "未达到合成阈值",
      "样本不足或关键指标缺失"
    ],
    "confounders": [
      "商品切换",
      "流量变化"
    ],
    "adviceTemplate": {
      "problem": "进入后点击偏弱",
      "action": "补充产品利益点和商品卡操作说明。",
      "hostMessage": "请按已核实的商品信息继续说明，具体经营决策由人确认。",
      "limitations": [
        "全部默认参数从零构造，仅供软件演示；不是业务校准、行业标准或经营建议。"
      ]
    },
    "businessMinimums": {
      "mainProductImpressionDelta": 48
    }
  },
  {
    "id": "R002",
    "version": 1,
    "title": "点击后支付偏弱",
    "condition": "仅供合成演示：使用本条显式阈值和代码中的缺失样本检查。",
    "minSamples": 5,
    "mainWindowSec": 120,
    "trendWindowSec": 300,
    "severity": "warning",
    "cooldownSec": 180,
    "expiresSec": 180,
    "thresholds": {
      "productClickRateMin": 0.12,
      "clickToPaidRateMax": 0.07
    },
    "calibration": {
      "version": "public-synthetic-v1",
      "sourceRefs": [
        "synthetic-config:public-v1"
      ],
      "scope": "synthetic_example"
    },
    "nonTriggerConditions": [
      "未达到合成阈值",
      "样本不足或关键指标缺失"
    ],
    "confounders": [
      "商品切换",
      "流量变化"
    ],
    "adviceTemplate": {
      "problem": "点击后支付偏弱",
      "action": "确认价格、保障及下单步骤是否讲清。",
      "hostMessage": "请按已核实的商品信息继续说明，具体经营决策由人确认。",
      "limitations": [
        "全部默认参数从零构造，仅供软件演示；不是业务校准、行业标准或经营建议。"
      ]
    },
    "businessMinimums": {
      "mainProductClickDelta": 16
    }
  },
  {
    "id": "R003",
    "version": 1,
    "title": "在线趋势连续回落",
    "condition": "仅供合成演示：使用本条显式阈值和代码中的缺失样本检查。",
    "minSamples": 11,
    "mainWindowSec": 120,
    "trendWindowSec": 300,
    "severity": "warning",
    "cooldownSec": 180,
    "expiresSec": 180,
    "thresholds": {
      "relativeDropMin": 0.24,
      "absoluteDropMin": 4,
      "trendBlocks": 3
    },
    "calibration": {
      "version": "public-synthetic-v1",
      "sourceRefs": [
        "synthetic-config:public-v1"
      ],
      "scope": "synthetic_example"
    },
    "nonTriggerConditions": [
      "未达到合成阈值",
      "样本不足或关键指标缺失"
    ],
    "confounders": [
      "商品切换",
      "流量变化"
    ],
    "adviceTemplate": {
      "problem": "在线趋势连续回落",
      "action": "观察流量来源并检查当前讲解节奏。",
      "hostMessage": "请按已核实的商品信息继续说明，具体经营决策由人确认。",
      "limitations": [
        "全部默认参数从零构造，仅供软件演示；不是业务校准、行业标准或经营建议。"
      ]
    }
  },
  {
    "id": "R004",
    "version": 1,
    "title": "消耗增速与回报变化",
    "condition": "仅供合成演示：使用本条显式阈值和代码中的缺失样本检查。",
    "minSamples": 11,
    "mainWindowSec": 120,
    "trendWindowSec": 300,
    "severity": "warning",
    "cooldownSec": 180,
    "expiresSec": 180,
    "thresholds": {
      "spendAccelerationMin": 1.6,
      "grossRoiDropRateMin": 0.22,
      "grossRoiMax": 2.4
    },
    "calibration": {
      "version": "public-synthetic-v1",
      "sourceRefs": [
        "synthetic-config:public-v1"
      ],
      "scope": "synthetic_example"
    },
    "nonTriggerConditions": [
      "未达到合成阈值",
      "样本不足或关键指标缺失"
    ],
    "confounders": [
      "商品切换",
      "流量变化"
    ],
    "adviceTemplate": {
      "problem": "消耗增速与回报变化",
      "action": "核对数据完整性后由运营决定下一步。",
      "hostMessage": "请按已核实的商品信息继续说明，具体经营决策由人确认。",
      "limitations": [
        "全部默认参数从零构造，仅供软件演示；不是业务校准、行业标准或经营建议。"
      ]
    }
  },
  {
    "id": "R005",
    "version": 1,
    "title": "商品点击指令缺失",
    "condition": "仅供合成演示：使用本条显式阈值和代码中的缺失样本检查。",
    "minSamples": 5,
    "mainWindowSec": 120,
    "trendWindowSec": 300,
    "severity": "warning",
    "cooldownSec": 180,
    "expiresSec": 180,
    "thresholds": {
      "productImpressionDeltaMin": 48,
      "productClickRateMax": 0.08
    },
    "calibration": {
      "version": "public-synthetic-v1",
      "sourceRefs": [
        "synthetic-config:public-v1"
      ],
      "scope": "synthetic_example"
    },
    "nonTriggerConditions": [
      "未达到合成阈值",
      "样本不足或关键指标缺失"
    ],
    "confounders": [
      "商品切换",
      "流量变化"
    ],
    "adviceTemplate": {
      "problem": "商品点击指令缺失",
      "action": "说明如何查看当前商品信息。",
      "hostMessage": "请按已核实的商品信息继续说明，具体经营决策由人确认。",
      "limitations": [
        "全部默认参数从零构造，仅供软件演示；不是业务校准、行业标准或经营建议。"
      ]
    },
    "businessMinimums": {
      "mainProductImpressionDelta": 48
    }
  },
  {
    "id": "R006",
    "version": 1,
    "title": "价格问题尚未回应",
    "condition": "仅供合成演示：使用本条显式阈值和代码中的缺失样本检查。",
    "minSamples": 5,
    "mainWindowSec": 120,
    "trendWindowSec": 300,
    "severity": "warning",
    "cooldownSec": 180,
    "expiresSec": 180,
    "thresholds": {
      "priceIntentCountMin": 4
    },
    "calibration": {
      "version": "public-synthetic-v1",
      "sourceRefs": [
        "synthetic-config:public-v1"
      ],
      "scope": "synthetic_example"
    },
    "nonTriggerConditions": [
      "未达到合成阈值",
      "样本不足或关键指标缺失"
    ],
    "confounders": [
      "商品切换",
      "流量变化"
    ],
    "adviceTemplate": {
      "problem": "价格问题尚未回应",
      "action": "回答已核实的价格和保障信息。",
      "hostMessage": "请按已核实的商品信息继续说明，具体经营决策由人确认。",
      "limitations": [
        "全部默认参数从零构造，仅供软件演示；不是业务校准、行业标准或经营建议。"
      ]
    }
  },
  {
    "id": "R007",
    "version": 1,
    "title": "原理讲解与承接变化",
    "condition": "仅供合成演示：使用本条显式阈值和代码中的缺失样本检查。",
    "minSamples": 11,
    "mainWindowSec": 120,
    "trendWindowSec": 300,
    "severity": "warning",
    "cooldownSec": 180,
    "expiresSec": 180,
    "thresholds": {
      "principleSegmentsMin": 5,
      "concurrentViewerDropRateMin": 0.24,
      "productClickRateMax": 0.08
    },
    "calibration": {
      "version": "public-synthetic-v1",
      "sourceRefs": [
        "synthetic-config:public-v1"
      ],
      "scope": "synthetic_example"
    },
    "nonTriggerConditions": [
      "未达到合成阈值",
      "样本不足或关键指标缺失"
    ],
    "confounders": [
      "商品切换",
      "流量变化"
    ],
    "adviceTemplate": {
      "problem": "原理讲解与承接变化",
      "action": "用一个有证据支持的应用示例补充说明。",
      "hostMessage": "请按已核实的商品信息继续说明，具体经营决策由人确认。",
      "limitations": [
        "全部默认参数从零构造，仅供软件演示；不是业务校准、行业标准或经营建议。"
      ]
    },
    "businessMinimums": {
      "mainProductImpressionDelta": 48
    }
  },
  {
    "id": "R008",
    "version": 1,
    "title": "正向片段候选",
    "condition": "仅供合成演示：使用本条显式阈值和代码中的缺失样本检查。",
    "minSamples": 21,
    "mainWindowSec": 120,
    "trendWindowSec": 300,
    "severity": "info",
    "cooldownSec": 180,
    "expiresSec": 300,
    "thresholds": {
      "relativeLiftMin": 0.18
    },
    "calibration": {
      "version": "public-synthetic-v1",
      "sourceRefs": [
        "synthetic-config:public-v1"
      ],
      "scope": "synthetic_example"
    },
    "nonTriggerConditions": [
      "未达到合成阈值",
      "样本不足或关键指标缺失"
    ],
    "confounders": [
      "商品切换",
      "流量变化"
    ],
    "adviceTemplate": {
      "problem": "正向片段候选",
      "action": "保留当前片段供人工复盘，不推断因果。",
      "hostMessage": "请按已核实的商品信息继续说明，具体经营决策由人确认。",
      "limitations": [
        "全部默认参数从零构造，仅供软件演示；不是业务校准、行业标准或经营建议。"
      ]
    },
    "businessMinimums": {
      "mainProductImpressionDelta": 48,
      "mainProductClickDelta": 16,
      "comparisonProductImpressionDelta": 48,
      "comparisonProductClickDelta": 16
    }
  }
] as const;

export interface MetricWindow {
  durationSec: number | "product_round";
  startAt: string;
  endAt: string;
  samples: number;
  first: CanonicalMetricSnapshot;
  latest: CanonicalMetricSnapshot;
  eventIds: string[];
  speech: Array<{ id: string; sourceEventId: string; tags: SpeechTag[] }>;
  priceIntentCount: number;
  productSwitched: boolean;
  trafficChanged: boolean;
}

export type AnalysisWindows = Record<AnalysisWindowSec, MetricWindow> & { productRound: MetricWindow };

function canonicalMetricEvents(events: LiveEvent[], anchorAt: string) {
  const anchorMs = Date.parse(anchorAt);
  return events.flatMap((item) => {
    if (item.kind !== "metric.snapshot" || Date.parse(item.eventAt) > anchorMs) return [];
    const parsed = canonicalMetricSnapshotSchema.safeParse(item.payload);
    return parsed.success ? [{ event: item, metrics: parsed.data }] : [];
  });
}

function buildWindow(events: LiveEvent[], anchorAt: string, durationSec: number, startAtOverride?: string): MetricWindow {
  const anchorMs = Date.parse(anchorAt);
  const startMs = startAtOverride ? Date.parse(startAtOverride) : anchorMs - durationSec * 1000;
  const metrics = canonicalMetricEvents(events, anchorAt).filter(({ event }) => Date.parse(event.eventAt) >= startMs);
  const inWindow = events.filter((item) => {
    const at = Date.parse(item.eventAt);
    return at >= startMs && at <= anchorMs;
  });
  const first = metrics[0]?.metrics ?? {};
  const latest = metrics.at(-1)?.metrics ?? {};
  return {
    durationSec,
    startAt: new Date(startMs).toISOString(), endAt: anchorAt, samples: metrics.length,
    first, latest, eventIds: metrics.map(({ event }) => event.eventId),
    speech: inWindow.filter((item) => item.kind === "speech.final").map((item) => {
      const payload = item.payload as { id: string; sourceEventId: string; tags: SpeechTag[] };
      return { id: payload.id, sourceEventId: payload.sourceEventId, tags: payload.tags };
    }),
    priceIntentCount: inWindow.filter((item) => item.kind === "comment.intent" && (item.payload as { intent: string }).intent === "price")
      .reduce((total, item) => total + (item.payload as { count: number }).count, 0),
    productSwitched: inWindow.some((item) => item.kind === "product.changed"),
    trafficChanged: inWindow.some((item) => item.kind === "traffic.changed" && (item.payload as { reason?: string }).reason !== "baseline")
  };
}

export function buildAnalysisWindows(events: LiveEvent[], anchorAt?: string): AnalysisWindows | null {
  const lastMetric = [...events].reverse().find((item) => item.kind === "metric.snapshot" && canonicalMetricSnapshotSchema.safeParse(item.payload).success);
  const resolvedAnchor = anchorAt ?? lastMetric?.eventAt;
  if (!resolvedAnchor) return null;
  const currentRound = [...events].reverse().find((item) => item.kind === "product.round.started" && Date.parse(item.eventAt) <= Date.parse(resolvedAnchor));
  const windows = Object.fromEntries(ANALYSIS_WINDOWS_SEC.map((seconds) => [seconds, buildWindow(events, resolvedAnchor, seconds)])) as Record<AnalysisWindowSec, MetricWindow>;
  return {
    ...windows,
    productRound: { ...buildWindow(events, resolvedAnchor, 900, currentRound?.eventAt), durationSec: "product_round" }
  };
}

function delta(window: MetricWindow, field: keyof CanonicalMetricSnapshot): number {
  const first = window.first[field];
  const latest = window.latest[field];
  return typeof first === "number" && typeof latest === "number" ? latest - first : 0;
}

function relativeDrop(window: MetricWindow, field: keyof CanonicalMetricSnapshot): number {
  const first = window.first[field];
  const latest = window.latest[field];
  return typeof first === "number" && typeof latest === "number" && first > 0 ? (first - latest) / first : 0;
}

export interface ConcurrentViewerTrend {
  blockMedians: number[];
  relativeDrop: number;
  absoluteDrop: number;
  consistentlyDecreasing: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function concurrentViewerTrend(events: LiveEvent[], anchorAt: string, windowSec: number, blocks: number): ConcurrentViewerTrend {
  const anchorMs = Date.parse(anchorAt);
  const values = canonicalMetricEvents(events, anchorAt).filter(({ event, metrics }) => {
    const ageSec = (anchorMs - Date.parse(event.eventAt)) / 1000;
    return ageSec >= 0 && ageSec <= windowSec && typeof metrics.concurrent_viewers === "number";
  }).map(({ metrics }) => Number(metrics.concurrent_viewers));
  if (!Number.isInteger(blocks) || blocks < 2 || values.length < blocks) {
    return { blockMedians: [], relativeDrop: 0, absoluteDrop: 0, consistentlyDecreasing: false };
  }
  const blockMedians = Array.from({ length: blocks }, (_, index) => {
    const start = Math.floor(index * values.length / blocks);
    const end = Math.floor((index + 1) * values.length / blocks);
    return median(values.slice(start, end));
  });
  const first = blockMedians[0]!;
  const last = blockMedians.at(-1)!;
  const absoluteDrop = first - last;
  return {
    blockMedians,
    relativeDrop: first > 0 ? absoluteDrop / first : 0,
    absoluteDrop,
    consistentlyDecreasing: blockMedians.every((value, index) => index === 0 || blockMedians[index - 1]! > value)
  };
}

function hasSpeechTag(window: MetricWindow, tags: SpeechTag[]): boolean {
  return window.speech.some((segment) => segment.tags.some((tag) => tags.includes(tag)));
}

function hasAllSpeechTags(window: MetricWindow, tags: SpeechTag[]): boolean {
  const observed = new Set(window.speech.flatMap((segment) => segment.tags));
  return tags.every((tag) => observed.has(tag));
}

export function maxConsecutiveSpeechTag(window: MetricWindow, tag: SpeechTag): number {
  let maximum = 0;
  let current = 0;
  for (const segment of window.speech) {
    current = segment.tags.includes(tag) ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function periodRate(events: LiveEvent[], anchorAt: string, fromSec: number, toSec: number, numerator: keyof CanonicalMetricSnapshot, denominator: keyof CanonicalMetricSnapshot): number {
  const anchorMs = Date.parse(anchorAt);
  const metrics = canonicalMetricEvents(events, anchorAt).filter(({ event }) => {
    const ageSec = (anchorMs - Date.parse(event.eventAt)) / 1000;
    return ageSec >= fromSec && ageSec <= toSec;
  });
  const first = metrics[0]?.metrics;
  const last = metrics.at(-1)?.metrics;
  const numeratorDelta = first && last && typeof first[numerator] === "number" && typeof last[numerator] === "number" ? Number(last[numerator]) - Number(first[numerator]) : 0;
  const denominatorDelta = first && last && typeof first[denominator] === "number" && typeof last[denominator] === "number" ? Number(last[denominator]) - Number(first[denominator]) : 0;
  return denominatorDelta > 0 ? numeratorDelta / denominatorDelta : 0;
}

function periodDelta(events: LiveEvent[], anchorAt: string, fromSec: number, toSec: number, field: keyof CanonicalMetricSnapshot): number {
  const anchorMs = Date.parse(anchorAt);
  const metrics = canonicalMetricEvents(events, anchorAt).filter(({ event }) => {
    const ageSec = (anchorMs - Date.parse(event.eventAt)) / 1000;
    return ageSec >= fromSec && ageSec <= toSec;
  });
  const first = metrics[0]?.metrics[field];
  const last = metrics.at(-1)?.metrics[field];
  return typeof first === "number" && typeof last === "number" ? last - first : 0;
}

function periodGrossRoi(events: LiveEvent[], anchorAt: string, fromSec: number, toSec: number): number {
  const gmv = periodDelta(events, anchorAt, fromSec, toSec, "gross_paid_gmv_fen");
  const spend = periodDelta(events, anchorAt, fromSec, toSec, "ad_spend_fen");
  return spend > 0 ? gmv / spend : 0;
}

function businessSampleFailure(config: RuleConfig, windows: AnalysisWindows, events: LiveEvent[]): string | undefined {
  const minimums = config.businessMinimums;
  if (!minimums) return undefined;
  const anchorAt = windows[120].endAt;
  const mainProductImpressions = periodDelta(events, anchorAt, 0, config.id === "R008" ? 300 : 120, "product_impression_uv");
  const mainProductClicks = periodDelta(events, anchorAt, 0, config.id === "R008" ? 300 : 120, "product_click_uv");
  const comparisonProductImpressions = periodDelta(events, anchorAt, 300, 600, "product_impression_uv");
  const comparisonProductClicks = periodDelta(events, anchorAt, 300, 600, "product_click_uv");
  if (minimums.mainProductImpressionDelta !== undefined && mainProductImpressions < minimums.mainProductImpressionDelta) {
    return `业务样本不足：最近窗口商品曝光 UV 增量 ${mainProductImpressions}，需要至少 ${minimums.mainProductImpressionDelta}`;
  }
  if (minimums.mainProductClickDelta !== undefined && mainProductClicks < minimums.mainProductClickDelta) {
    return `业务样本不足：最近窗口商品点击 UV 增量 ${mainProductClicks}，需要至少 ${minimums.mainProductClickDelta}`;
  }
  if (minimums.comparisonProductImpressionDelta !== undefined && comparisonProductImpressions < minimums.comparisonProductImpressionDelta) {
    return `业务样本不足：此前 300 秒商品曝光 UV 增量 ${comparisonProductImpressions}，需要至少 ${minimums.comparisonProductImpressionDelta}`;
  }
  if (minimums.comparisonProductClickDelta !== undefined && comparisonProductClicks < minimums.comparisonProductClickDelta) {
    return `业务样本不足：此前 300 秒商品点击 UV 增量 ${comparisonProductClicks}，需要至少 ${minimums.comparisonProductClickDelta}`;
  }
  return undefined;
}

function spendRate(events: LiveEvent[], anchorAt: string, fromSec: number, toSec: number): number {
  const anchorMs = Date.parse(anchorAt);
  const metrics = canonicalMetricEvents(events, anchorAt).filter(({ event }) => {
    const ageSec = (anchorMs - Date.parse(event.eventAt)) / 1000;
    return ageSec >= fromSec && ageSec <= toSec;
  });
  const first = metrics[0];
  const last = metrics.at(-1);
  if (!first || !last || first.event.eventAt === last.event.eventAt) return 0;
  const change = Number(last.metrics.ad_spend_fen ?? 0) - Number(first.metrics.ad_spend_fen ?? 0);
  return change / ((Date.parse(last.event.eventAt) - Date.parse(first.event.eventAt)) / 1000);
}

function ruleCondition(config: RuleConfig, windows: AnalysisWindows, events: LiveEvent[]): boolean {
  const main = windows[120];
  const trend = windows[300];
  switch (config.id) {
    case "R001":
      return delta(main, "room_enter_uv") >= config.thresholds.roomEnterDeltaMin!
        && periodRate(events, main.endAt, 0, 120, "product_click_uv", "product_impression_uv") < config.thresholds.productClickRateMax!
        && !hasSpeechTag(main, ["product_benefit", "cta"]);
    case "R002":
      return periodRate(events, main.endAt, 0, 120, "product_click_uv", "product_impression_uv") >= config.thresholds.productClickRateMin!
        && periodRate(events, main.endAt, 0, 120, "paid_buyer_count", "product_click_uv") < config.thresholds.clickToPaidRateMax!
        && !hasAllSpeechTags(main, ["price", "gift", "guarantee", "cta"]);
    case "R003": {
      const viewerTrend = concurrentViewerTrend(events, trend.endAt, 300, config.thresholds.trendBlocks!);
      return viewerTrend.consistentlyDecreasing
        && viewerTrend.relativeDrop >= config.thresholds.relativeDropMin!
        && viewerTrend.absoluteDrop >= config.thresholds.absoluteDropMin!;
    }
    case "R004": {
      const recentSpend = spendRate(events, trend.endAt, 0, 120);
      const earlierSpend = spendRate(events, trend.endAt, 120, 300);
      const recentRoi = periodGrossRoi(events, trend.endAt, 0, 120);
      const earlierRoi = periodGrossRoi(events, trend.endAt, 120, 300);
      const roiDrop = earlierRoi > 0 ? (earlierRoi - recentRoi) / earlierRoi : 0;
      return earlierSpend > 0 && recentSpend / earlierSpend >= config.thresholds.spendAccelerationMin!
        && recentRoi < config.thresholds.grossRoiMax!
        && roiDrop >= config.thresholds.grossRoiDropRateMin!;
    }
    case "R005":
      return delta(main, "product_impression_uv") >= config.thresholds.productImpressionDeltaMin!
        && periodRate(events, main.endAt, 0, 120, "product_click_uv", "product_impression_uv") < config.thresholds.productClickRateMax!
        && !hasSpeechTag(main, ["cta"]);
    case "R006":
      return trend.priceIntentCount >= config.thresholds.priceIntentCountMin!
        && !hasSpeechTag(trend, ["price", "guarantee", "objection_handling"]);
    case "R007": {
      const principleStreak = maxConsecutiveSpeechTag(trend, "ingredient_or_principle");
      return principleStreak >= config.thresholds.principleSegmentsMin!
        && (relativeDrop(trend, "concurrent_viewers") >= config.thresholds.concurrentViewerDropRateMin!
          || periodRate(events, main.endAt, 0, 120, "product_click_uv", "product_impression_uv") < config.thresholds.productClickRateMax!);
    }
    case "R008": {
      const recentClick = periodRate(events, trend.endAt, 0, 300, "product_click_uv", "product_impression_uv");
      const earlierClick = periodRate(events, trend.endAt, 300, 600, "product_click_uv", "product_impression_uv");
      const recentPaid = periodRate(events, trend.endAt, 0, 300, "paid_buyer_count", "product_click_uv");
      const earlierPaid = periodRate(events, trend.endAt, 300, 600, "paid_buyer_count", "product_click_uv");
      const lift = Math.max(
        earlierClick > 0 ? (recentClick - earlierClick) / earlierClick : 0,
        earlierPaid > 0 ? (recentPaid - earlierPaid) / earlierPaid : 0
      );
      return lift >= config.thresholds.relativeLiftMin! && hasAllSpeechTags(trend, ["price", "gift", "guarantee", "cta"]);
    }
  }
}

function priceCommentEvents(events: LiveEvent[], window: MetricWindow): LiveEvent[] {
  return events.filter((event) => event.kind === "comment.intent"
    && (event.payload as { intent?: string }).intent === "price"
    && Date.parse(event.eventAt) >= Date.parse(window.startAt)
    && Date.parse(event.eventAt) <= Date.parse(window.endAt));
}

function dataEvidenceFor(config: RuleConfig, windows: AnalysisWindows, events: LiveEvent[]): DataEvidence[] {
  const main = windows[120];
  const trend = windows[300];
  const clickRate120 = periodRate(events, main.endAt, 0, 120, "product_click_uv", "product_impression_uv");
  const paidRate120 = periodRate(events, main.endAt, 0, 120, "paid_buyer_count", "product_click_uv");
  switch (config.id) {
    case "R001":
      return [
        { type: "metric_window", label: "120 秒直播间进入增量", summary: "用于确认直播间进入样本是否充分", windowSec: 120, value: delta(main, "room_enter_uv"), unit: "人", eventIds: main.eventIds },
        { type: "metric_window", label: "120 秒商品点击率", summary: "按窗口商品点击人数／商品曝光人数计算", windowSec: 120, value: clickRate120, baseline: config.thresholds.productClickRateMax, unit: "比例", eventIds: main.eventIds }
      ];
    case "R002":
      return [
        { type: "metric_window", label: "120 秒商品点击率", summary: "按窗口累计量差分计算", windowSec: 120, value: clickRate120, baseline: config.thresholds.productClickRateMin, unit: "比例", eventIds: main.eventIds },
        { type: "metric_window", label: "120 秒点击后支付率", summary: "按窗口支付买家 UV 增量／商品点击 UV 增量计算", windowSec: 120, value: paidRate120, baseline: config.thresholds.clickToPaidRateMax, unit: "比例", eventIds: main.eventIds }
      ];
    case "R003": {
      const viewerTrend = concurrentViewerTrend(events, trend.endAt, 300, config.thresholds.trendBlocks!);
      return [
        {
          type: "metric_comparison", label: "300 秒在线人数分段中位数",
          summary: `三段中位数 ${viewerTrend.blockMedians.join(" → ")}；${viewerTrend.consistentlyDecreasing ? "持续递减" : "未持续递减"}`,
          windowSec: 300, value: viewerTrend.blockMedians.at(-1)!, baseline: viewerTrend.blockMedians[0]!, unit: "人", eventIds: trend.eventIds
        },
        {
          type: "metric_comparison", label: "300 秒在线人数下降幅度",
          summary: `绝对下降 ${viewerTrend.absoluteDrop} 人，相对下降 ${(viewerTrend.relativeDrop * 100).toFixed(1)}%`,
          windowSec: 300, value: viewerTrend.relativeDrop, baseline: config.thresholds.relativeDropMin, unit: "比例", eventIds: trend.eventIds
        }
      ];
    }
    case "R004": {
      const recentSpend = spendRate(events, trend.endAt, 0, 120);
      const earlierSpend = spendRate(events, trend.endAt, 120, 300);
      const recentRoi = periodGrossRoi(events, trend.endAt, 0, 120);
      const earlierRoi = periodGrossRoi(events, trend.endAt, 120, 300);
      const roiDrop = earlierRoi > 0 ? (earlierRoi - recentRoi) / earlierRoi : 0;
      return [
        { type: "traffic_change", label: "最近 120 秒消耗速度", summary: "按窗口消耗金额增量／秒计算", windowSec: 120, value: recentSpend, unit: "分/秒", eventIds: main.eventIds },
        { type: "metric_comparison", label: "此前窗口消耗速度与加速比", summary: `最近窗口为此前窗口的 ${earlierSpend > 0 ? (recentSpend / earlierSpend).toFixed(2) : "未形成"} 倍`, windowSec: 300, value: recentSpend, baseline: earlierSpend, unit: "分/秒", eventIds: trend.eventIds },
        { type: "metric_window", label: "最近 120 秒窗口支付 ROI", summary: "按窗口支付 GMV 增量／消耗增量计算", windowSec: 120, value: recentRoi, baseline: config.thresholds.grossRoiMax, unit: "比值", eventIds: main.eventIds },
        { type: "metric_comparison", label: "此前 180 秒窗口支付 ROI 与下降比例", summary: `最近窗口较此前窗口下降 ${(roiDrop * 100).toFixed(1)}%`, windowSec: 300, value: recentRoi, baseline: earlierRoi, unit: "比值", eventIds: trend.eventIds }
      ];
    }
    case "R005":
      return [
        { type: "metric_window", label: "120 秒商品曝光增量", summary: "用于确认商品曝光样本是否充分", windowSec: 120, value: delta(main, "product_impression_uv"), unit: "人", eventIds: main.eventIds },
        { type: "metric_window", label: "120 秒商品点击率", summary: "按窗口累计量差分计算", windowSec: 120, value: clickRate120, baseline: config.thresholds.productClickRateMax, unit: "比例", eventIds: main.eventIds }
      ];
    case "R006": {
      const comments = priceCommentEvents(events, trend);
      return [{
        type: "comment_intent", label: "300 秒价格疑问数", summary: "来自价格意图评论事件",
        windowSec: 300, value: comments.reduce((total, event) => total + Number((event.payload as { count?: number }).count ?? 0), 0),
        baseline: config.thresholds.priceIntentCountMin, unit: "条", eventIds: comments.map((event) => event.eventId)
      }];
    }
    case "R007":
      return [
        { type: "metric_window", label: "300 秒连续原理话术段数", summary: "其他类型话术会重置连续计数", windowSec: 300, value: maxConsecutiveSpeechTag(trend, "ingredient_or_principle"), baseline: config.thresholds.principleSegmentsMin, unit: "段", eventIds: trend.speech.map((segment) => segment.sourceEventId) },
        { type: "metric_window", label: "120 秒商品点击率", summary: "按窗口累计量差分计算", windowSec: 120, value: clickRate120, baseline: config.thresholds.productClickRateMax, unit: "比例", eventIds: main.eventIds }
      ];
    case "R008": {
      const recentClick = periodRate(events, trend.endAt, 0, 300, "product_click_uv", "product_impression_uv");
      const earlierClick = periodRate(events, trend.endAt, 300, 600, "product_click_uv", "product_impression_uv");
      const recentPaid = periodRate(events, trend.endAt, 0, 300, "paid_buyer_count", "product_click_uv");
      const earlierPaid = periodRate(events, trend.endAt, 300, 600, "paid_buyer_count", "product_click_uv");
      const lift = Math.max(earlierClick > 0 ? (recentClick - earlierClick) / earlierClick : 0, earlierPaid > 0 ? (recentPaid - earlierPaid) / earlierPaid : 0);
      return [
        { type: "metric_comparison", label: "商品点击率前后窗口", summary: "最近 300 秒与此前 300 秒对比", windowSec: 300, value: recentClick, baseline: earlierClick, unit: "比例", eventIds: windows[900].eventIds },
        { type: "metric_comparison", label: "点击后支付率前后窗口", summary: "最近 300 秒与此前 300 秒对比", windowSec: 300, value: recentPaid, baseline: earlierPaid, unit: "比例", eventIds: windows[900].eventIds },
        { type: "metric_comparison", label: "承接指标最大提升", summary: "取商品点击率和点击后支付率中较明显的同期变化", windowSec: 300, value: lift, baseline: config.thresholds.relativeLiftMin, unit: "比例", eventIds: windows[900].eventIds }
      ];
    }
  }
}

function evidenceFor(config: RuleConfig, windows: AnalysisWindows, events: LiveEvent[]) {
  const main = windows[120];
  const metricByRule: Record<RuleConfig["id"], Advice["metricEvidence"][number]["metric"]> = {
    R001: "product_click_rate", R002: "click_to_paid_rate", R003: "concurrent_viewers", R004: "gross_roi",
    R005: "product_click_rate", R006: "click_to_paid_rate", R007: "concurrent_viewers", R008: "click_to_paid_rate"
  };
  const metric = metricByRule[config.id];
  const windowRate = metric === "product_click_rate"
    ? periodRate(events, main.endAt, 0, 120, "product_click_uv", "product_impression_uv")
    : metric === "click_to_paid_rate"
      ? periodRate(events, main.endAt, 0, 120, "paid_buyer_count", "product_click_uv")
      : metric === "gross_roi"
        ? periodGrossRoi(events, main.endAt, 0, 120)
        : Number(main.latest[metric] ?? 0);
  return [{
    metric, windowSec: 120, value: windowRate,
    summary: `${config.title}的 120 秒观察值`, eventIds: main.eventIds
  }];
}

export class RuleAdviceProvider {
  create(config: RuleConfig, detected: DetectedEvent, windows: AnalysisWindows, events: LiveEvent[], tenantId: string): Advice {
    const latest = windows[120].latest;
    return {
      id: `${detected.id}:advice`, tenantId, sessionId: detected.sessionId, detectedEventId: detected.id,
      ruleId: config.id, ruleVersion: config.version, createdAt: detected.detectedAt, triggeredAt: detected.detectedAt,
      expiresAt: new Date(Date.parse(detected.detectedAt) + config.expiresSec * 1000).toISOString(),
      priority: config.severity === "critical" ? "high" : config.severity === "warning" ? "medium" : "low",
      title: config.title, problem: config.adviceTemplate.problem,
      currentProductId: latest.current_product_id ?? "unknown-product",
      currentHostId: latest.current_host_id ?? "unknown-host",
      metricEvidence: evidenceFor(config, windows, events),
      dataEvidence: dataEvidenceFor(config, windows, events),
      speechEvidence: windows[120].speech.map((segment) => ({ segmentId: segment.id, summary: "触发窗口内的话术标签", tags: segment.tags })),
      action: config.adviceTemplate.action, hostMessage: config.adviceTemplate.hostMessage,
      limitations: config.adviceTemplate.limitations, status: "generated", provider: "deterministic-rule-advice"
    };
  }
}

export interface RuleAnalysisResult {
  detectedEvents: DetectedEvent[];
  advices: Advice[];
  ruleStatuses: RuleStatus[];
}

export function analyzeRules(events: LiveEvent[], provider = new RuleAdviceProvider(), configs: readonly RuleConfig[] = RULE_CONFIGS): RuleAnalysisResult {
  const windows = buildAnalysisWindows(events);
  const anchor = [...events].reverse().find((item) => item.kind === "metric.snapshot" && canonicalMetricSnapshotSchema.safeParse(item.payload).success);
  if (!windows || !anchor) return { detectedEvents: [], advices: [], ruleStatuses: [] };
  const result: RuleAnalysisResult = { detectedEvents: [], advices: [], ruleStatuses: [] };
  for (const config of configs) {
    const statusId = `${anchor.sessionId}:${config.id}:v${config.version}:status:${anchor.eventId}`;
    const sampleWindow = config.id === "R008" ? windows[900] : windows[config.trendWindowSec];
    if (sampleWindow.samples < config.minSamples) {
      result.ruleStatuses.push({
        id: statusId, sessionId: anchor.sessionId, ruleId: config.id, ruleVersion: config.version,
        status: "insufficient_sample", evaluatedAt: anchor.eventAt,
        reason: `需要至少 ${config.minSamples} 个指标样本`, evidenceEventIds: sampleWindow.eventIds
      });
      continue;
    }
    const businessFailure = businessSampleFailure(config, windows, events);
    if (businessFailure) {
      result.ruleStatuses.push({
        id: statusId, sessionId: anchor.sessionId, ruleId: config.id, ruleVersion: config.version,
        status: "insufficient_sample", evaluatedAt: anchor.eventAt,
        reason: businessFailure, evidenceEventIds: sampleWindow.eventIds
      });
      continue;
    }
    const confounderWindow = config.id === "R003" || config.id === "R007" || config.id === "R008" ? windows[300] : windows[120];
    const detectionConfounded = config.id !== "R004" && (confounderWindow.productSwitched || confounderWindow.trafficChanged);
    if (detectionConfounded) {
      result.ruleStatuses.push({
        id: statusId, sessionId: anchor.sessionId, ruleId: config.id, ruleVersion: config.version,
        status: "confounded", evaluatedAt: anchor.eventAt,
        reason: confounderWindow.productSwitched ? "窗口内发生商品切换" : "窗口内发生明显流量调整",
        evidenceEventIds: confounderWindow.eventIds
      });
      continue;
    }
    const previous = [...events].reverse().find((item) => item.kind === "rule.triggered" && (item.payload as { ruleId?: string }).ruleId === config.id);
    if (previous && Date.parse(anchor.eventAt) - Date.parse(previous.eventAt) < config.cooldownSec * 1000) {
      result.ruleStatuses.push({
        id: statusId, sessionId: anchor.sessionId, ruleId: config.id, ruleVersion: config.version,
        status: "cooldown", evaluatedAt: anchor.eventAt, reason: `规则冷却 ${config.cooldownSec} 秒`,
        evidenceEventIds: [previous.eventId, anchor.eventId]
      });
      continue;
    }
    if (!ruleCondition(config, windows, events)) {
      result.ruleStatuses.push({
        id: statusId, sessionId: anchor.sessionId, ruleId: config.id, ruleVersion: config.version,
        status: "monitoring", evaluatedAt: anchor.eventAt, reason: "当前条件未达到触发阈值",
        evidenceEventIds: windows[config.mainWindowSec].eventIds
      });
      continue;
    }
    const triggeredStatus: RuleStatus = {
      id: statusId, sessionId: anchor.sessionId, ruleId: config.id, ruleVersion: config.version,
      status: "triggered", evaluatedAt: anchor.eventAt, reason: config.condition,
      evidenceEventIds: windows[config.mainWindowSec].eventIds
    };
    result.ruleStatuses.push(triggeredStatus);
    const detected: DetectedEvent = {
      id: `${anchor.sessionId}:${config.id}:v${config.version}:${stableToken(anchor.eventId)}`,
      sessionId: anchor.sessionId, ruleId: config.id, ruleVersion: config.version,
      severity: config.severity, detectedAt: anchor.eventAt, title: config.title,
      summary: config.condition, evidenceEventIds: windows[config.mainWindowSec].eventIds,
      metricWindowIds: [`${anchor.sessionId}:${config.mainWindowSec}:${anchor.eventAt}`, `${anchor.sessionId}:${config.trendWindowSec}:${anchor.eventAt}`],
      speechSegmentIds: windows[config.mainWindowSec].speech.map((segment) => segment.id), sampleSufficient: true
    };
    result.detectedEvents.push(detected);
    result.advices.push(provider.create(config, detected, windows, events, anchor.tenantId));
  }
  return result;
}
