export type AudioTranscriptionProvider = "ark_audio" | "local_asr" | "user_provided_transcript";
export type TextAnalysisProvider = "ark_text" | "deterministic_rules" | "blocked_missing_ark_api_key";
export type AudioQualityStatus = "reliable" | "needs_review" | "unusable";
export type CoverageStatus = "present" | "absent" | "unknown";
export type AdviceState = "observe" | "review" | "actionable";
export type AdvicePriority = "low" | "medium" | "high" | "critical";

export interface AudioTranscriptionProviderContract {
  provider: AudioTranscriptionProvider;
  transcribeOnce(audioPath: string, options?: { startMs?: number; endMs?: number }): Promise<AudioFirstTranscriptSegment[]>;
}

export interface TextAnalysisProviderContract {
  provider: TextAnalysisProvider;
  analyzeText(input: { speech: AudioFirstTranscriptSegment[]; visibleData: Record<string, unknown>; stateSummary: string }): Promise<unknown>;
}

export interface AudioFirstTranscriptSegment {
  utteranceId: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  text: string;
  isFinal: true;
  transcriptProvider: AudioTranscriptionProvider;
  transcriptVersion: string;
  qualityStatus: AudioQualityStatus;
  confidence: number | null;
  confidenceNote: string;
  speakerLabel: string | null;
  hostId: string | null;
  productId: string | null;
  productRoundId: string | null;
  tags: string[];
  actionSemantics: string[];
  uncertainTerms: string[];
}

export const AUDIO_FIRST_TAGS = [
  "opening", "interaction", "product_benefit", "product_effect", "ingredient_or_principle", "usage_scenario",
  "trust", "price", "promotion", "gift", "guarantee", "objection_handling", "cta", "order_or_payment",
  "urgency", "low_efficiency", "product_transition", "uncertain"
] as const;

export type AudioFirstTag = typeof AUDIO_FIRST_TAGS[number];

export const ACTION_SEMANTICS: Record<string, RegExp> = {
  click_product_card: /点开(?:[一二三四五六七八九\d]+号)?(?:商品卡|链接|小黄车)|点击(?:商品卡|链接)|刷新(?:我们)?的?[一二三四五六七八九\d]+号链接|看(?:一下)?(?:商品卡|链接)/,
  purchase: /去拍|拍下|拍到|下单|付款|支付|秒拍秒付|完成支付|先锁单|先占(?:权益|名额)|放购物车|购买|买到/,
  membership: /先入会|加入(?:店铺)?会员|会员.*减|入会.*优惠/,
  urgency: /抓紧|赶紧|倒计时|最后|先来先得|不加不补|就这一波|名额|马上/,
};

const TAG_PATTERNS: Array<[AudioFirstTag, RegExp]> = [
  ["opening", /欢迎|新进|刚来|开播/],
  ["interaction", /宝宝|姐妹|家人们|朋友们|评论区|有没有|听明白|看一下/],
  ["product_benefit", /淡纹|紧致|提亮|收缩毛孔|控油|保湿|抗老|抗衰|提拉|改善|不挑肤质|不挑年龄/],
  ["product_effect", /效果|结果|真人实测|变化|改善/],
  ["ingredient_or_principle", /成分|原理|六胜肽|多肽|A醇|视黄醇|胶原|弹性蛋白|放松面部肌肉|促胶原/],
  ["usage_scenario", /白天|晚上|早上|洗完脸|护肤|用法|使用|动态纹|静态纹/],
  ["trust", /官方旗舰店|品牌|报告|认证|20多年|丹麦|榜一|top one|回购率/],
  ["price", /到手价|价格|只要\s*\d{3}|\d{2,3}元|\d{2,3}块|\d{3}带回家/],
  ["promotion", /优惠|立减|优惠券|券|机制|会员|积分|回购/],
  ["gift", /赠品|送\s*\d+粒|买\s*\d+粒.*送|小样|试用装|送装/],
  ["guarantee", /售后|退换|七天无理由|运费险|保价|兜底/],
  ["objection_handling", /担心|顾虑|不合适|不喜欢|敏感|犹豫|贵/],
  ["cta", /点开|点击|商品卡|小黄车|链接|去拍|拍下|先入会|秒拍秒付|抓紧手速/],
  ["order_or_payment", /下单|付款|支付|秒拍秒付|拍到|买到|一单|加单/],
  ["urgency", /抓紧|赶紧|倒计时|最后|就这一波|先来先得|马上|不加不补/],
  ["low_efficiency", /等一下|先等等|题外话|闲聊/],
  ["product_transition", /一号链接|二号链接|三号链接|四号链接|九号链接|换.*链接|下架|改回/]
];

export function tagAudioFirstSpeech(text: string): AudioFirstTag[] {
  const tags = TAG_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
  return tags.length > 0 ? [...new Set(tags)] : ["uncertain"];
}

export function detectActionSemantics(text: string): string[] {
  return Object.entries(ACTION_SEMANTICS).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function parseTranscriptTimestamp(value: string): number {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) throw new Error(`无法解析 TXT 时间戳：${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes >= 60 || seconds >= 60) throw new Error(`TXT 时间戳超出范围：${value}`);
  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + Number((match[4] ?? "0").padEnd(3, "0"));
}

export function buildCoverageStatus(args: {
  hasAudio: boolean;
  segments: AudioFirstTranscriptSegment[];
  tag: string;
  qualityAccepted: boolean;
}): CoverageStatus {
  if (!args.hasAudio || !args.qualityAccepted) return "unknown";
  return args.segments.some((segment) => segment.tags.includes(args.tag)) ? "present" : "absent";
}

export function shouldTriggerR005(args: {
  recentSegments: AudioFirstTranscriptSegment[];
  audioWindowComplete: boolean;
  qualityAccepted: boolean;
  isProductStage: boolean;
  hasUnresolvedIssue: boolean;
}): { trigger: boolean; status: "actionable" | "observe" | "insufficient_sample"; reason: string } {
  if (!args.audioWindowComplete || !args.qualityAccepted || args.recentSegments.length === 0) {
    return { trigger: false, status: "insufficient_sample", reason: "音频或转写质量未完成人工确认" };
  }
  if (!args.isProductStage) return { trigger: false, status: "observe", reason: "当前不在讲品或转化阶段" };
  if (args.recentSegments.some((segment) => segment.actionSemantics.length > 0)) {
    return { trigger: false, status: "observe", reason: "最近 180 秒已存在行动指令" };
  }
  if (args.hasUnresolvedIssue) return { trigger: false, status: "observe", reason: "同一问题已有未解决 issue" };
  return { trigger: true, status: "actionable", reason: "完整可靠话术覆盖内未发现行动指令" };
}

export type R002Coverage = Record<"price" | "promotion" | "gift" | "guarantee" | "cta" | "order_or_payment", CoverageStatus>;

export type R002CoverageKey = keyof R002Coverage;

const R002_COVERAGE_NAMES: Record<R002CoverageKey, string> = {
  price: "到手价", promotion: "优惠机制", gift: "赠品", guarantee: "保价和售后", cta: "商品卡点击指令", order_or_payment: "下单或支付指令"
};

export function extractR002CoverageCandidates(segments: Array<Pick<AudioFirstTranscriptSegment, "tags">>): R002CoverageKey[] {
  const keys = Object.keys(R002_COVERAGE_NAMES) as R002CoverageKey[];
  return keys.filter((key) => segments.some((segment) => segment.tags.includes(key)));
}

export function buildR002Action(args: { coverage: R002Coverage }): { state: AdviceState; action: string; missing: string[] } {
  const missing = Object.entries(args.coverage).filter(([, status]) => status === "absent").map(([key]) => key);
  const unknown = Object.values(args.coverage).some((status) => status === "unknown");
  if (missing.length === 0 && !unknown) {
    return { state: "review", missing: [], action: "话术基础环节已覆盖；不要机械重复价格、赠品或行动指令，运营请检查人群、货盘、价格竞争力、投流变化和下单链路。" };
  }
  if (missing.length === 0) {
    return { state: "observe", missing: [], action: "成交闭环部分内容尚无法确认，先人工回听；确认缺失后再补充，不把未识别当成没有讲。" };
  }
  return { state: "actionable", missing, action: `只补充已确认缺失的环节：${missing.map((key) => R002_COVERAGE_NAMES[key as R002CoverageKey]).join("、")}；已经讲过的内容不重复要求。` };
}

export function buildR004Action(args: { coverage: R002Coverage; presentCandidates: R002CoverageKey[] }): { action: string; presentCandidates: string[]; confirmedMissing: string[]; unknownDimensions: string[] } {
  const confirmedMissing = (Object.entries(args.coverage) as Array<[R002CoverageKey, CoverageStatus]>).filter(([, status]) => status === "absent").map(([key]) => R002_COVERAGE_NAMES[key]);
  const unknownDimensions = (Object.entries(args.coverage) as Array<[R002CoverageKey, CoverageStatus]>).filter(([, status]) => status === "unknown").map(([key]) => R002_COVERAGE_NAMES[key]);
  const presentCandidates = [...new Set(args.presentCandidates)].map((key) => R002_COVERAGE_NAMES[key]);
  const candidateText = presentCandidates.length > 0
    ? `文本中出现候选覆盖（待人工回听确认）：${presentCandidates.join("、")}，不重复要求这些内容。`
    : "当前文本没有形成可回听的覆盖候选。";
  const hostAction = confirmedMissing.length > 0
    ? `仅在回听确认后补充真正缺失的承接动作：${confirmedMissing.join("、")}。`
    : "当前没有可确认缺失的话术，不新增固定话术要求。";
  const uncertainty = unknownDimensions.length > 0 ? `正式覆盖状态仍为 unknown：${unknownDimensions.join("、")}。` : "正式覆盖未发现 unknown。";
  return {
    action: `运营优先核查投流变化、人群匹配、货盘／价格竞争力和下单链路。${candidateText}${hostAction}${uncertainty}`,
    presentCandidates,
    confirmedMissing,
    unknownDimensions
  };
}

export function buildIssueStableKey(args: { ruleId: string; hostId?: string | null; productId?: string | null }): string {
  const normalized = (value: string | null | undefined): string => value && value.trim().length > 0 ? value : "unknown";
  return `${args.ruleId}:host=${normalized(args.hostId)}:product=${normalized(args.productId)}`;
}

export function protectAdvicePriority(confidence: "low" | "medium" | "high", requested: AdvicePriority): AdvicePriority {
  if (confidence === "low") return requested === "critical" ? "medium" : requested;
  if (confidence === "medium" && requested === "critical") return "high";
  return requested;
}

export function classifyAdviceState(args: { sufficientSample: boolean; evidenceReliable: boolean; actionSpecific: boolean }): AdviceState {
  if (!args.sufficientSample) return "observe";
  if (!args.evidenceReliable || !args.actionSpecific) return "review";
  return "actionable";
}

export function shouldTriggerR004(args: { currentSpendFen: number; previousSpendFen: number; currentRoi: number; previousRoi: number; currentPaidBuyers: number; previousPaidBuyers: number; minimumSpendAccelerationRatio: number; maximumRoiDelta: number; maximumPaidBuyerDelta: number }): boolean {
  if (args.previousSpendFen <= 0) return false;
  const spendRatio = args.currentSpendFen / args.previousSpendFen;
  return spendRatio >= args.minimumSpendAccelerationRatio && args.currentRoi - args.previousRoi <= args.maximumRoiDelta && args.currentPaidBuyers - args.previousPaidBuyers <= args.maximumPaidBuyerDelta;
}

export function canReopenIssue(args: { resolvedAtMs: number; nowMs: number; cooldownMs: number }): boolean {
  return args.nowMs - args.resolvedAtMs >= args.cooldownMs;
}

export interface IssueCard {
  issueId: string;
  firstDetectedAt: string;
  lastUpdatedAt: string;
  currentStatus: "open" | "observing" | "resolved";
  evidenceHistory: string[];
  adviceHistory: string[];
  acknowledgedAt: string | null;
  executedAt: string | null;
  resolvedAt: string | null;
}

export function updateIssueCard(card: IssueCard | null, args: { issueId: string; at: string; evidenceId: string; adviceId?: string; resolved?: boolean }): IssueCard {
  if (!card) return {
    issueId: args.issueId, firstDetectedAt: args.at, lastUpdatedAt: args.at,
    currentStatus: args.resolved ? "resolved" : "open", evidenceHistory: [args.evidenceId], adviceHistory: args.adviceId ? [args.adviceId] : [],
    acknowledgedAt: null, executedAt: null, resolvedAt: args.resolved ? args.at : null
  };
  return {
    ...card, lastUpdatedAt: args.at,
    currentStatus: args.resolved ? "resolved" : card.currentStatus,
    evidenceHistory: card.evidenceHistory.includes(args.evidenceId) ? card.evidenceHistory : [...card.evidenceHistory, args.evidenceId],
    adviceHistory: args.adviceId && !card.adviceHistory.includes(args.adviceId) ? [...card.adviceHistory, args.adviceId] : card.adviceHistory,
    resolvedAt: args.resolved ? args.at : card.resolvedAt
  };
}

export function canCreateAdvice(args: { lastAdviceAt: number | null; now: number; cooldownMs: number; hourlyAdviceCount: number; maxHourlyAdvice: number; highAdviceAtSameCheckpoint: boolean }): boolean {
  if (args.lastAdviceAt !== null && args.now - args.lastAdviceAt < args.cooldownMs) return false;
  if (args.hourlyAdviceCount >= args.maxHourlyAdvice) return false;
  if (args.highAdviceAtSameCheckpoint) return false;
  return true;
}

export const AUDIO_FIRST_LAG_HYPOTHESES = ["H1", "H2", "H3", "H4", "H5"] as const;

export function classifyCoreLagConclusion(sampleCount: number): "SUPPORTED" | "INCONCLUSIVE" | "NOT_SUPPORTED" {
  return sampleCount < 8 ? "INCONCLUSIVE" : "NOT_SUPPORTED";
}
