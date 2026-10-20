import {
  anchorSessionReportSchema,
  referenceScriptSchema,
  type AnchorLinkage,
  type AnchorPointCoverage,
  type AnchorSessionReport,
  type AnchorWindowCoverage,
  type LiveWindowAggregate,
  type ReferenceScript,
  type ReferenceScriptPoint
} from "@live-growth/contracts";

/**
 * Phase 2B / M4（D045）：主播话术评分。
 * 参考话术 = 版本化要点清单；覆盖度 = 确定性关键词匹配打底（未命中不推断"没讲"以外的语义）。
 * 报告全部由确定性计算产出，措辞只说相关性；生成时间由调用方传入，本模块不读当前时间。
 */

export const REFERENCE_SCRIPT_VERSION_V1 = "synthetic-reference-script-v1" as const;

/** Independent synthetic demonstration only. Pass a versioned script for real use. */
export const REFERENCE_SCRIPT_V1: ReferenceScript = referenceScriptSchema.parse({
  "version": "synthetic-reference-script-v1",
  "basedOn": "Independent synthetic public fixture, seed 42001; no source transcript or private corpus.",
  "points": [
    {
      "key": "hook_welcome",
      "label": "开场说明",
      "group": "hook",
      "weight": 1,
      "keywords": [
        "欢迎",
        "演示开始"
      ]
    },
    {
      "key": "pain_point",
      "label": "使用场景",
      "group": "pain_point",
      "weight": 1,
      "keywords": [
        "收纳",
        "空间"
      ]
    },
    {
      "key": "core_ingredient",
      "label": "原理或材料",
      "group": "selling_point",
      "weight": 1,
      "keywords": [
        "材料",
        "设计"
      ]
    },
    {
      "key": "efficacy",
      "label": "产品特点",
      "group": "selling_point",
      "weight": 1,
      "keywords": [
        "特点",
        "便于组装"
      ]
    },
    {
      "key": "usage",
      "label": "使用方法",
      "group": "selling_point",
      "weight": 1,
      "keywords": [
        "使用方法",
        "操作步骤"
      ]
    },
    {
      "key": "suitable_audience",
      "label": "适用范围",
      "group": "selling_point",
      "weight": 1,
      "keywords": [
        "适用范围",
        "适合"
      ]
    },
    {
      "key": "price_anchor",
      "label": "到手价",
      "group": "price_mechanism",
      "weight": 1,
      "keywords": [
        "到手价",
        "价格"
      ]
    },
    {
      "key": "offer_mechanism",
      "label": "优惠说明",
      "group": "price_mechanism",
      "weight": 1,
      "keywords": [
        "优惠机制",
        "折扣"
      ]
    },
    {
      "key": "gift",
      "label": "赠品说明",
      "group": "price_mechanism",
      "weight": 1,
      "keywords": [
        "赠品",
        "附赠"
      ]
    },
    {
      "key": "guarantee",
      "label": "售后保障",
      "group": "trust",
      "weight": 1,
      "keywords": [
        "售后",
        "保障"
      ]
    },
    {
      "key": "product_card_cta",
      "label": "商品信息入口",
      "group": "cta",
      "weight": 1,
      "keywords": [
        "商品卡",
        "小黄车"
      ]
    },
    {
      "key": "purchase_cta",
      "label": "下单步骤",
      "group": "cta",
      "weight": 1,
      "keywords": [
        "下单",
        "确认参数"
      ]
    },
    {
      "key": "urgency",
      "label": "活动时限",
      "group": "urgency",
      "weight": 1,
      "keywords": [
        "限时",
        "截止时间"
      ]
    },
    {
      "key": "follow_guide",
      "label": "关注入口",
      "group": "follow",
      "weight": 1,
      "keywords": [
        "关注",
        "收藏"
      ]
    }
  ]
});

export class ReferenceScriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceScriptParseError";
  }
}

function inferScriptGroup(text: string): ReferenceScript["points"][number]["group"] {
  if (/价|券|赠|机制|折扣|优惠/.test(text)) return "price_mechanism";
  if (/拍|锁单|小黄车|链接|商品卡|下单|支付/.test(text)) return "cta";
  if (/抓紧|最后|限时|稀缺|先得/.test(text)) return "urgency";
  if (/痛|场景|空间|收纳/.test(text)) return "pain_point";
  if (/关注|入会|粉丝/.test(text)) return "follow";
  if (/保障|无理由|运费|正品/.test(text)) return "trust";
  if (/欢迎|刚进来|福利|钩子|宠粉/.test(text)) return "hook";
  return "selling_point";
}

function pastedPointKey(label: string, index: number): string {
  const slug = Array.from(label).filter((char) => /[\w\u4e00-\u9fff]/.test(char)).join("").slice(0, 24);
  return `p${index}_${slug || "point"}`.slice(0, 60);
}

/**
 * 运营粘贴参考话术：一行一个要点，格式「要点名：关键词1,关键词2」。
 * 可选「要点名|3：关键词」指定权重 1–3。# 开头为注释。
 */
export function parseReferenceScriptText(text: string, basedOn = "运营当场粘贴的参考话术要点，未入库版本化。"): ReferenceScript {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) throw new ReferenceScriptParseError("粘贴的参考话术是空的");
  const points: ReferenceScript["points"] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(.+?)(?:\|([123]))?[：:]\s*(.+)$/u);
    if (!match) throw new ReferenceScriptParseError(`第 ${index + 1} 行格式不对，应为「要点名：关键词1,关键词2」`);
    const label = match[1]!.trim().slice(0, 80);
    const weight = match[2] ? Number(match[2]) : /价|催单|小黄车|拍/.test(label) ? 3 : 2;
    const keywords = match[3]!.split(/[,，、;；]/u).map((item) => item.trim()).filter((item) => item.length > 0).slice(0, 40).map((item) => item.slice(0, 40));
    if (!label) throw new ReferenceScriptParseError(`第 ${index + 1} 行缺少要点名`);
    if (keywords.length === 0) throw new ReferenceScriptParseError(`第 ${index + 1} 行缺少关键词`);
    points.push({
      key: pastedPointKey(label, index),
      label,
      group: inferScriptGroup(`${label} ${keywords.join(" ")}`),
      keywords,
      weight: weight as 1 | 2 | 3
    });
  }
  if (points.length > 60) throw new ReferenceScriptParseError("粘贴要点不能超过 60 条");
  return referenceScriptSchema.parse({ version: "pasted-operator-v1", basedOn, points });
}

export type AnchorReportInput = {
  tenantId: string;
  sessionId: string;
  sessionStatus: "running" | "stopped";
  /** 缺省用 REFERENCE_SCRIPT_V1。 */
  script?: ReferenceScript;
  transcripts: ReadonlyArray<{ at: string; text: string }>;
  windows: readonly LiveWindowAggregate[];
  /** 由调用方传入以保证确定性。 */
  generatedAt: string;
};

const LINKAGE_GROUPS = new Set(["price_mechanism", "cta", "urgency"]);
const QUOTE_MAX = 120;
const LINKAGE_MAX = 20;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pointPattern(point: ReferenceScriptPoint): RegExp {
  return new RegExp(point.keywords.map(escapeRegExp).join("|"), "i");
}

function windowOf(windows: readonly LiveWindowAggregate[], atMs: number): LiveWindowAggregate | undefined {
  return windows.find((window) => atMs >= Date.parse(window.windowStartAt) && atMs < Date.parse(window.windowEndAt));
}

/** 与诊断窗口同口径：商品点击取千川 productClicks 增量，支付人数取罗盘 paidBuyerCount 增量。 */
export function windowMetrics(window: LiveWindowAggregate): { productClicks?: number; paidBuyersDelta?: number } {
  const clicksStat = window.qianchuan["productClicks"];
  const clicks = clicksStat?.semantic === "cumulative" ? clicksStat.delta : clicksStat?.semantic === "instant" ? clicksStat.last : undefined;
  const paidDelta = window.compass["paidBuyerCount"]?.delta;
  return {
    ...(clicks !== undefined && Number.isFinite(clicks) ? { productClicks: Math.max(0, Math.round(clicks)) } : {}),
    ...(paidDelta !== undefined && Number.isFinite(paidDelta) ? { paidBuyersDelta: Math.max(0, Math.round(paidDelta)) } : {})
  };
}

export function buildAnchorSessionReport(input: AnchorReportInput): AnchorSessionReport {
  const script = input.script ?? REFERENCE_SCRIPT_V1;
  const orderedTranscripts = [...input.transcripts]
    .filter((item) => Number.isFinite(Date.parse(item.at)) && item.text.trim().length > 0)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const orderedWindows = [...input.windows].sort((left, right) => Date.parse(left.windowStartAt) - Date.parse(right.windowStartAt));

  const patterns = new Map(script.points.map((point) => [point.key, pointPattern(point)] as const));
  type Mention = { point: ReferenceScriptPoint; at: string; quote: string; windowStartAt?: string };
  const mentions: Mention[] = [];
  for (const transcript of orderedTranscripts) {
    const atMs = Date.parse(transcript.at);
    const window = windowOf(orderedWindows, atMs);
    for (const point of script.points) {
      if (!patterns.get(point.key)!.test(transcript.text)) continue;
      mentions.push({
        point,
        at: transcript.at,
        quote: transcript.text.slice(0, QUOTE_MAX),
        ...(window ? { windowStartAt: window.windowStartAt } : {})
      });
    }
  }

  const points: AnchorPointCoverage[] = script.points.map((point) => {
    const own = mentions.filter((mention) => mention.point.key === point.key);
    const windowStarts = [...new Set(own.flatMap((mention) => (mention.windowStartAt ? [mention.windowStartAt] : [])))].sort();
    const first = own[0];
    return {
      key: point.key,
      label: point.label,
      group: point.group,
      weight: point.weight,
      covered: own.length > 0,
      mentionCount: own.length,
      mentionWindowStarts: windowStarts,
      ...(first ? { firstEvidence: { at: first.at, quote: first.quote } } : {})
    };
  });

  const totalPoints = script.points.length;
  const windows: AnchorWindowCoverage[] = orderedWindows.map((window) => {
    const inWindow = mentions.filter((mention) => mention.windowStartAt === window.windowStartAt);
    const coveredKeys = [...new Set(inWindow.map((mention) => mention.point.key))].sort();
    return {
      windowStartAt: window.windowStartAt,
      windowEndAt: window.windowEndAt,
      speechFinals: window.speech.finalCount,
      coveredKeys,
      coverageRate: totalPoints > 0 ? coveredKeys.length / totalPoints : 0,
      urgencyMentions: inWindow.filter((mention) => mention.point.group === "urgency").length
    };
  });

  const speechFinalCount = orderedTranscripts.length;
  const totalWeight = script.points.reduce((sum, point) => sum + point.weight, 0);
  const coveredWeight = points.filter((point) => point.covered).reduce((sum, point) => sum + point.weight, 0);
  const urgencyTotal = windows.reduce((sum, window) => sum + window.urgencyMentions, 0);
  const score = speechFinalCount === 0 ? null : {
    total: Math.round((coveredWeight / totalWeight) * 100),
    weightedCoverageRate: coveredWeight / totalWeight,
    coveredPoints: points.filter((point) => point.covered).length,
    totalPoints,
    ...(windows.length > 0 ? { urgencyPerWindow: Math.round((urgencyTotal / windows.length) * 100) / 100 } : {})
  };

  const linkage: AnchorLinkage[] = [];
  const seenLinkage = new Set<string>();
  for (const mention of mentions) {
    if (linkage.length >= LINKAGE_MAX) break;
    if (!LINKAGE_GROUPS.has(mention.point.group) || !mention.windowStartAt) continue;
    const dedupe = `${mention.point.key}:${mention.windowStartAt}`;
    if (seenLinkage.has(dedupe)) continue;
    const index = orderedWindows.findIndex((window) => window.windowStartAt === mention.windowStartAt);
    if (index < 0) continue;
    const current = orderedWindows[index]!;
    const next = orderedWindows[index + 1];
    const isAdjacent = next !== undefined && Date.parse(next.windowStartAt) === Date.parse(current.windowEndAt);
    seenLinkage.add(dedupe);
    const currentMetrics = windowMetrics(current);
    const nextMetrics = next && isAdjacent ? windowMetrics(next) : undefined;
    const noteParts: string[] = [];
    if (nextMetrics) {
      if (currentMetrics.productClicks !== undefined && nextMetrics.productClicks !== undefined) noteParts.push(`商品点击 ${currentMetrics.productClicks}→${nextMetrics.productClicks}`);
      if (currentMetrics.paidBuyersDelta !== undefined && nextMetrics.paidBuyersDelta !== undefined) noteParts.push(`支付人数增量 ${currentMetrics.paidBuyersDelta}→${nextMetrics.paidBuyersDelta}`);
    }
    const note = nextMetrics && noteParts.length > 0
      ? `提及「${mention.point.label}」后下一窗：${noteParts.join("，")}（仅相关性，非因果）。`
      : nextMetrics
        ? `提及「${mention.point.label}」，但相邻窗口对应指标缺失，无法对比。`
        : `提及「${mention.point.label}」，尚无相邻的下一个15分钟窗口可对比。`;
    linkage.push({
      pointKey: mention.point.key,
      windowStartAt: mention.windowStartAt,
      at: mention.at,
      quote: mention.quote,
      window: currentMetrics,
      ...(next && isAdjacent ? { nextWindow: { windowStartAt: next.windowStartAt, ...nextMetrics } } : {}),
      note
    });
  }

  const suggestions: string[] = [];
  if (speechFinalCount > 0) {
    const missing = points.filter((point) => !point.covered).sort((left, right) => right.weight - left.weight);
    for (const point of missing.slice(0, 2)) {
      suggestions.push(`本场转写里没有出现「${point.label}」（权重${point.weight}）的关键词，下一场安排明确讲到。`);
    }
    const urgencyPerWindow = windows.length > 0 ? urgencyTotal / windows.length : undefined;
    if (suggestions.length < 3 && urgencyPerWindow !== undefined && urgencyPerWindow < 1) {
      suggestions.push(`催单类要点平均每15分钟提及 ${Math.round(urgencyPerWindow * 100) / 100} 次，低于每窗1次，可在每轮讲解结尾补一次催单。`);
    }
    if (suggestions.length === 0) {
      suggestions.push("本场参考要点全部覆盖，可保持当前节奏并对比下一场表现。");
    }
  }

  const dataNotes: string[] = [
    `覆盖度由确定性关键词匹配计算（${script.version}），近义表达可能漏报，未接语义纠偏。`,
    "联动统计只描述提及后下一窗指标变化的相关性，不构成因果结论。"
  ];
  if (speechFinalCount === 0) dataNotes.unshift("本场没有转写样本，不评分，只显示样本不足。");
  if (orderedWindows.length === 0) dataNotes.push("尚无完整15分钟窗口，按窗统计缺省。");

  return anchorSessionReportSchema.parse({
    schemaVersion: 1,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    scriptVersion: script.version,
    generatedAt: input.generatedAt,
    sessionStatus: input.sessionStatus,
    windowCount: orderedWindows.length,
    speechFinalCount,
    score,
    points,
    windows,
    linkage,
    suggestions,
    dataNotes
  });
}
