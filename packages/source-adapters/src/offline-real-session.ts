export type WorkbookFieldClassification =
  | "timestamp"
  | "identifier"
  | "interval_count"
  | "instantaneous_count"
  | "ratio"
  | "interval_amount"
  | "duration"
  | "uncertain";

export interface ClassifiedWorkbookField {
  classification: WorkbookFieldClassification;
  basis: string;
  timeSemantics: "interval" | "instantaneous" | "as_of_snapshot_or_uncertain" | "identifier";
  audienceUnit?: "pv" | "uv";
}

export interface OfflineMetricField extends ClassifiedWorkbookField {
  value: string | number | null;
}

export interface OfflineMetricInterval {
  index: number;
  startAt: string;
  endAt: string;
  hostId: string | null;
  productId: string | null;
  canonicalMetrics?: {
    room_impression_uv?: number; room_enter_uv?: number; product_impression_uv?: number; product_click_uv?: number;
    paid_order_count?: number; paid_buyer_count?: number; gross_paid_gmv_fen?: number; refund_gmv_fen?: number;
    ad_spend_fen?: number; net_paid_gmv_fen?: number; concurrent_viewers?: number;
    room_entry_rate?: number; product_click_rate?: number; click_to_paid_rate?: number; gross_roi?: number; net_roi?: number;
  };
  fields: Record<string, OfflineMetricField>;
}

export interface OfflineTranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  isFinal: true;
  confidence: number | null;
  confidenceNote: string;
  hostId: string | null;
  productId: string | null;
  tags: string[];
  needsHumanReview: boolean;
  uncertainTerms?: string[];
  whisperAvgLogprob?: number | null;
  whisperNoSpeechProbability?: number;
  redacted?: boolean;
}

export interface OfflineRuleReference {
  id: string;
  version: number;
  title: string;
  offlineTitle?: string;
  mainWindowSec: number;
  trendWindowSec: number;
  severity: "info" | "warning" | "critical";
  cooldownSec: number;
  thresholds: Record<string, number>;
  businessMinimums?: {
    mainProductImpressionDelta?: number;
    mainProductClickDelta?: number;
    comparisonProductImpressionDelta?: number;
    comparisonProductClickDelta?: number;
  };
  templateVersion: string;
  adviceTemplate: { action: string; hostMessage: string };
}

export interface OfflineAsrQualityGate {
  minimumConfidence: number;
  maximumNoSpeechProbability: number;
  minimumEvaluableSegments: number;
  minimumEvaluableDurationMs: number;
}

export const DEFAULT_OFFLINE_ASR_QUALITY_GATE: OfflineAsrQualityGate = {
  minimumConfidence: 0.55,
  maximumNoSpeechProbability: 0.5,
  minimumEvaluableSegments: 2,
  minimumEvaluableDurationMs: 10_000
};

export function classifyWorkbookField(header: string): ClassifiedWorkbookField {
  if (header === "日期" || header === "截止时间") return { classification: "timestamp", basis: "工作簿时间字段", timeSemantics: "identifier" };
  if (header === "主播" || header === "班次") return { classification: "identifier", basis: "工作簿业务标识", timeSemantics: "identifier" };
  if (header === "实时在线人数") return { classification: "instantaneous_count", basis: "表头明确为截止时点实时在线人数", timeSemantics: "instantaneous", audienceUnit: "uv" };
  if (/停留时长|观看时长/.test(header)) return { classification: "duration", basis: "时长值；“整场”等字段可能是截至时点聚合，保留源文本", timeSemantics: "as_of_snapshot_or_uncertain" };
  if (/率|ROI/i.test(header)) return { classification: "ratio", basis: "比率或 ROI 值；无法仅凭表头确认是区间还是截至时点派生", timeSemantics: "as_of_snapshot_or_uncertain" };
  if (/元|金额|消耗|GPM|补贴|笔单价|成本/.test(header)) return { classification: "interval_amount", basis: "金额字段；按相邻登记行可增可减解释为 15 分钟区间值", timeSemantics: "interval" };
  if (/次数/.test(header)) return { classification: "interval_count", basis: "表头为次数；按 15 分钟区间登记值保留 PV 语义", timeSemantics: "interval", audienceUnit: "pv" };
  if (/人数|用户数|粉丝数/.test(header)) return { classification: "interval_count", basis: "表头为人数；按 15 分钟区间登记值保留 UV 语义", timeSemantics: "interval", audienceUnit: "uv" };
  if (/订单数|成交订单数|退款订单数|分享次数|打赏次数|评论次数/.test(header)) {
    return { classification: "interval_count", basis: "计数字段；按 15 分钟区间登记值", timeSemantics: "interval" };
  }
  return { classification: "uncertain", basis: "仅凭表头无法可靠确定口径，保持不确定", timeSemantics: "as_of_snapshot_or_uncertain" };
}

export function assertContinuousQuarterHourIntervals(intervals: OfflineMetricInterval[], expected: { count: number; firstEndAt: string; lastEndAt: string; intervalMs: number }): void {
  if (intervals.length !== expected.count) throw new Error(`需要恰好 ${expected.count} 个区间，实际 ${intervals.length}`);
  const expectedFirstEnd = Date.parse(expected.firstEndAt);
  const expectedLastEnd = Date.parse(expected.lastEndAt);
  for (let index = 0; index < intervals.length; index += 1) {
    const item = intervals[index]!;
    const expectedEnd = expectedFirstEnd + index * expected.intervalMs;
    if (item.index !== index || Date.parse(item.endAt) !== expectedEnd || Date.parse(item.startAt) !== expectedEnd - expected.intervalMs) {
      throw new Error(`连续性失败：index=${index}, startAt=${item.startAt}, endAt=${item.endAt}`);
    }
  }
  if (Date.parse(intervals.at(-1)!.endAt) !== expectedLastEnd) throw new Error(`末个截止点必须为 ${expected.lastEndAt}`);
}

export function parseBeijingWorkbookTimestamp(value: string): string {
  const normalized = value.trim().replace(" ", "T");
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);
  const timestamp = hasExplicitOffset ? normalized : `${normalized}+08:00`;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw new Error(`无法按北京时间解析工作簿时间：${value}`);
  return new Date(parsed).toISOString();
}

export function tagOfflineSpeech(text: string): string[] {
  const tagMatchingText = text.replace(/[現點開號鏈價贈說緊買歡間來寶們評區賣處實護質檢證優滿減禮樣裝後換貴庫復個結單]/g, (character) => ({
    現: "现", 點: "点", 開: "开", 號: "号", 鏈: "链", 價: "价", 贈: "赠", 說: "说", 緊: "紧", 買: "买",
    歡: "欢", 間: "间", 來: "来", 寶: "宝", 們: "们", 評: "评", 區: "区", 賣: "卖", 處: "处", 實: "实",
    護: "护", 質: "质", 檢: "检", 證: "证", 優: "优", 滿: "满", 減: "减", 禮: "礼", 樣: "样", 裝: "装",
    後: "后", 換: "换", 貴: "贵", 庫: "库", 復: "复", 個: "个", 結: "结", 單: "单"
  } as Record<string, string>)[character]!);
  const patterns: Array<[string, RegExp]> = [
    ["opening", /欢迎|新进来|停留|开场/], ["interaction", /家人们|宝宝们|朋友们|评论区|是不是|有没有/],
    ["product_benefit", /卖点|好处|耐用|省心|方便|控油|保湿|提拉|紧致|收缩毛孔/], ["product_effect", /功效|效果|改善|解决|淡纹|抗老|修护|提亮/],
    ["ingredient_or_principle", /原理|材质|材料|成分|工艺|锅底|导热|知识|多肽|多太|A醇|视黄醇|胶原/],
    ["usage_scenario", /使用场景|白天|晚上|早上|洗完脸|水乳前|护肤步骤|日常使用/], ["trust", /品牌|认证|质检|正品|口碑|背书|检测|报告/],
    ["price", /到手价|价格|价钱|\d+元|\d+块/], ["promotion", /优惠|满减|券|折扣|机制/], ["gift", /赠品|赠送|送你|礼品|小样|正装|送装|买.*送/],
    ["guarantee", /售后|保障|退换|保价|质保/], ["objection_handling", /贵|担心|放心|怕|问题|异议/],
    ["cta", /(?:点开|点击|打开|去看|看一下|点)(?:这个|一下|一号|1号)?(?:商品卡|链接)|(?:商品卡|链接)(?:点开|点击|打开|去看|看一下)/], ["order_or_payment", /下单|拍下|去拍|买到|拍到|付款|结算/], ["urgency", /马上|最后|倒计时|库存|赶紧|抓紧|最后.*秒|恢复.*价|不加不补/],
    ["low_efficiency", /闲聊|跑题|先等等|题外话/], ["product_transition", /换一个|下一款|切品|换品|切.*链接|切哪个/]
  ];
  const tags = patterns.filter(([, pattern]) => pattern.test(tagMatchingText)).map(([tag]) => tag);
  return tags.length === 0 ? ["uncertain"] : tags;
}

export function selectVisibleIntervals(intervals: OfflineMetricInterval[], checkpointAt: string, delayMinutes: 0 | 2 | 5): OfflineMetricInterval[] {
  const visibleBefore = Date.parse(checkpointAt) - delayMinutes * 60_000;
  return intervals.filter((item) => Date.parse(item.endAt) <= visibleBefore);
}

export const DEFAULT_LAG_SPEND_RELATIVE_CHANGE_THRESHOLD = 0.2;

function hasMaterialAdjacentSpendChange(intervals: OfflineMetricInterval[], threshold: number): boolean {
  return intervals.some((item, index) => {
    if (index === 0) return false;
    const previousSpend = intervals[index - 1]!.canonicalMetrics?.ad_spend_fen;
    const currentSpend = item.canonicalMetrics?.ad_spend_fen;
    if (typeof previousSpend !== "number" || typeof currentSpend !== "number") return false;
    if (previousSpend === 0 || currentSpend === 0) return previousSpend !== currentSpend;
    return Math.abs(currentSpend - previousSpend) / Math.abs(previousSpend) >= threshold;
  });
}

export interface BlindReplayCheckpoint {
  checkpointAt: string;
  delayMinutes: 0 | 2 | 5;
  visibleMetricIntervalIndexes: number[];
  visibleTranscriptSegmentIds: string[];
  maxEvidenceAt: string;
  ruleEvaluations: Array<{
    ruleId: string;
    ruleVersion: number;
    templateVersion: string;
    status: "triggered" | "not_triggered" | "cooldown" | "confounded" | "insufficient_sample";
    reason: string;
    evaluationEvidence: Array<{ metric: string; value: number | null; unit: string; intervalIndex: number | null }>;
  }>;
  suggestions: Array<{
    suggestionKey: string;
    generatedAt: string;
    latestDataAt: string | null;
    delayMinutes: 0 | 2 | 5;
    ruleId: string;
    ruleVersion: number;
    templateVersion: string;
    title: string;
    source: "speech_only" | "offline_15m_confirmation";
    relatedSpeech: string[];
    dataEvidence: Array<{ metric: string; value: number | null; unit: string; intervalIndex: number | null }>;
    action: string;
    hostMessage: string;
    evidenceSegmentIds: string[];
    confidence: "low" | "medium";
    priority: "info" | "warning" | "critical";
    target: "host" | "operator" | "operator_and_host";
    hostId: string | null;
    productId: string | null;
    confounders: string[];
    limitations: string[];
  }>;
}

export function buildBlindReplayCheckpoints(options: {
  sessionStartAt: string;
  sessionDurationMs: number;
  metricIntervals: OfflineMetricInterval[];
  transcriptSegments: OfflineTranscriptSegment[];
  delayMinutes: 0 | 2 | 5;
  ruleReferences: readonly OfflineRuleReference[];
  spendRelativeChangeThreshold?: number;
  asrQualityGate?: OfflineAsrQualityGate;
  includeVisibilityIds?: boolean;
}): BlindReplayCheckpoint[] {
  const startMs = Date.parse(options.sessionStartAt);
  const checkpoints: BlindReplayCheckpoint[] = [];
  const spendRelativeChangeThreshold = options.spendRelativeChangeThreshold ?? DEFAULT_LAG_SPEND_RELATIVE_CHANGE_THRESHOLD;
  const asrQualityGate = options.asrQualityGate ?? DEFAULT_OFFLINE_ASR_QUALITY_GATE;
  if (!Number.isFinite(asrQualityGate.minimumConfidence) || asrQualityGate.minimumConfidence < 0 || asrQualityGate.minimumConfidence > 1) {
    throw new Error(`minimumConfidence 必须在 0 到 1 之间，实际 ${asrQualityGate.minimumConfidence}`);
  }
  if (!Number.isFinite(asrQualityGate.maximumNoSpeechProbability) || asrQualityGate.maximumNoSpeechProbability < 0 || asrQualityGate.maximumNoSpeechProbability > 1) {
    throw new Error(`maximumNoSpeechProbability 必须在 0 到 1 之间，实际 ${asrQualityGate.maximumNoSpeechProbability}`);
  }
  if (!Number.isInteger(asrQualityGate.minimumEvaluableSegments) || asrQualityGate.minimumEvaluableSegments < 1) {
    throw new Error(`minimumEvaluableSegments 必须是正整数，实际 ${asrQualityGate.minimumEvaluableSegments}`);
  }
  if (!Number.isFinite(asrQualityGate.minimumEvaluableDurationMs) || asrQualityGate.minimumEvaluableDurationMs <= 0) {
    throw new Error(`minimumEvaluableDurationMs 必须是正有限数，实际 ${asrQualityGate.minimumEvaluableDurationMs}`);
  }
  const lastTriggeredOffsetMs = new Map<string, number>();
  const triggeredSuggestionKeys = new Set<string>();
  let priorVisibleMetricCount = 0;
  for (let offsetMs = 180_000; offsetMs <= options.sessionDurationMs; offsetMs += 180_000) {
    const checkpointAt = new Date(startMs + offsetMs).toISOString();
    const visibleMetrics = selectVisibleIntervals(options.metricIntervals, checkpointAt, options.delayMinutes);
    const visibleTranscript = options.transcriptSegments.filter((item) => item.endMs <= offsetMs);
    const latestVisibleMetrics = visibleMetrics.at(-1)?.canonicalMetrics;
    const previousVisibleMetrics = visibleMetrics.at(-2)?.canonicalMetrics;
    const hasProxyMinimumSample = (rule: OfflineRuleReference): boolean => {
      if (!latestVisibleMetrics) return false;
      if (rule.id === "R001") {
        return (latestVisibleMetrics.product_impression_uv ?? 0) >= (rule.businessMinimums?.mainProductImpressionDelta ?? Number.POSITIVE_INFINITY);
      }
      if (rule.id === "R002") {
        return (latestVisibleMetrics.product_click_uv ?? 0) >= (rule.businessMinimums?.mainProductClickDelta ?? Number.POSITIVE_INFINITY);
      }
      if (rule.id === "R008") {
        return Boolean(previousVisibleMetrics)
          && (latestVisibleMetrics.product_impression_uv ?? 0) >= (rule.businessMinimums?.mainProductImpressionDelta ?? Number.POSITIVE_INFINITY)
          && (latestVisibleMetrics.product_click_uv ?? 0) >= (rule.businessMinimums?.mainProductClickDelta ?? Number.POSITIVE_INFINITY)
          && (previousVisibleMetrics?.product_impression_uv ?? 0) >= (rule.businessMinimums?.comparisonProductImpressionDelta ?? Number.POSITIVE_INFINITY)
          && (previousVisibleMetrics?.product_click_uv ?? 0) >= (rule.businessMinimums?.comparisonProductClickDelta ?? Number.POSITIVE_INFINITY);
      }
      if (rule.id === "R004") {
        return typeof previousVisibleMetrics?.ad_spend_fen === "number" && previousVisibleMetrics.ad_spend_fen > 0
          && typeof previousVisibleMetrics.gross_paid_gmv_fen === "number"
          && typeof latestVisibleMetrics.ad_spend_fen === "number"
          && typeof latestVisibleMetrics.gross_paid_gmv_fen === "number";
      }
      if (rule.id === "R003") return visibleMetrics.length >= 3
        && visibleMetrics.slice(-3).every((item) => typeof item.canonicalMetrics?.concurrent_viewers === "number" && Number.isFinite(item.canonicalMetrics.concurrent_viewers));
      return false;
    };
    const latestSpeechMs = visibleTranscript.length === 0 ? startMs : startMs + Math.max(...visibleTranscript.map((item) => item.endMs));
    const latestMetricMs = visibleMetrics.length === 0 ? startMs : Math.max(...visibleMetrics.map((item) => Date.parse(item.endAt) + options.delayMinutes * 60_000));
    const maxEvidenceAt = new Date(Math.max(latestSpeechMs, latestMetricMs)).toISOString();
    if (maxEvidenceAt > checkpointAt) throw new Error(`未来数据泄漏：${maxEvidenceAt} > ${checkpointAt}`);
    const suggestions: BlindReplayCheckpoint["suggestions"] = [];
    const cooldownRules = new Set<string>();
    const unchangedEvidenceRules = new Set<string>();
    const confoundedRules = new Set<string>();
    const speechInsufficientRules = new Set<string>();
    const asrQualityInsufficientRules = new Set<string>();
    const evaluationEvidenceByRule = new Map<string, BlindReplayCheckpoint["suggestions"][number]["dataEvidence"]>();
    for (const rule of options.ruleReferences) {
      const offlineSpeechLookbackSec = rule.id === "R005" ? 180 : rule.trendWindowSec;
      const speechWindow = visibleTranscript.filter((item) => item.endMs >= offsetMs - offlineSpeechLookbackSec * 1000);
      const evaluableSpeech = rule.id === "R005" ? speechWindow.filter((item) => item.confidence !== null
        && item.confidence >= asrQualityGate.minimumConfidence
        && (item.whisperNoSpeechProbability ?? 0) <= asrQualityGate.maximumNoSpeechProbability
        && item.text.trim().length > 0
        && item.tags.some((tag) => tag !== "uncertain")) : [];
      const evaluableDurationMs = evaluableSpeech.reduce((total, item) => total + Math.max(0,
        Math.min(item.endMs, offsetMs) - Math.max(item.startMs, offsetMs - offlineSpeechLookbackSec * 1000)), 0);
      const r005QualitySufficient = rule.id === "R005"
        && evaluableSpeech.length >= asrQualityGate.minimumEvaluableSegments
        && evaluableDurationMs >= asrQualityGate.minimumEvaluableDurationMs;
      if (rule.id === "R005") {
        evaluationEvidenceByRule.set(rule.id, [
          { metric: "evaluable_asr_segment_count", value: evaluableSpeech.length, unit: "count", intervalIndex: null },
          { metric: "evaluable_asr_duration_ms", value: evaluableDurationMs, unit: "ms", intervalIndex: null },
          { metric: "minimum_asr_confidence", value: asrQualityGate.minimumConfidence, unit: "ratio", intervalIndex: null },
          { metric: "maximum_no_speech_probability", value: asrQualityGate.maximumNoSpeechProbability, unit: "ratio", intervalIndex: null },
          { metric: "minimum_evaluable_asr_segments", value: asrQualityGate.minimumEvaluableSegments, unit: "count", intervalIndex: null },
          { metric: "minimum_evaluable_asr_duration_ms", value: asrQualityGate.minimumEvaluableDurationMs, unit: "ms", intervalIndex: null }
        ]);
        if (!r005QualitySufficient) asrQualityInsufficientRules.add(rule.id);
      }
      const conservativeActionDetected = rule.id === "R005" && speechWindow.some((item) => item.tags.includes("cta") || item.tags.includes("order_or_payment"));
      const missingCta = rule.id === "R005" && r005QualitySufficient && !conservativeActionDetected;
      const lastTriggered = lastTriggeredOffsetMs.get(rule.id);
      const coolingDown = lastTriggered !== undefined && offsetMs - lastTriggered < rule.cooldownSec * 1000;
      const missingCtaEvidence = evaluableSpeech.slice(-5);
      const missingCtaKey = `${rule.id}:speech:${missingCtaEvidence.map((item) => item.id).join(",")}`;
      const missingCtaEvidenceUnchanged = triggeredSuggestionKeys.has(missingCtaKey);
      if (missingCta && (coolingDown || missingCtaEvidenceUnchanged)) {
        cooldownRules.add(rule.id);
        if (missingCtaEvidenceUnchanged) unchangedEvidenceRules.add(rule.id);
      }
      if (missingCta && !coolingDown && !missingCtaEvidenceUnchanged) {
        const evidence = missingCtaEvidence;
        suggestions.push({
          suggestionKey: missingCtaKey,
          generatedAt: checkpointAt, latestDataAt: visibleMetrics.at(-1)?.endAt ?? null, delayMinutes: options.delayMinutes,
          ruleId: rule.id, ruleVersion: rule.version, templateVersion: rule.templateVersion, title: rule.offlineTitle ?? `${rule.title}（离线候选）`, source: "speech_only",
          relatedSpeech: evidence.map((item) => item.text), dataEvidence: [],
          action: rule.adviceTemplate.action, hostMessage: rule.adviceTemplate.hostMessage,
          evidenceSegmentIds: evidence.map((item) => item.id),
          confidence: evidence.some((item) => item.needsHumanReview) ? "low" : "medium",
          priority: rule.severity, target: "host", hostId: evidence.at(-1)?.hostId ?? null,
          productId: evidence.at(-1)?.productId ?? null, confounders: ["ASR 领域词待人工复核", "经营数据仅 15 分钟粒度"],
          limitations: [`R005 仅按 Phase 1.5 检查点前最近 180 秒、通过 ASR 质量门槛的真实转写评估话术缺口；最低置信度 ${asrQualityGate.minimumConfidence}、至少 ${asrQualityGate.minimumEvaluableSegments} 段且累计 ${asrQualityGate.minimumEvaluableDurationMs}ms；不修改正式规则阈值。`]
        });
        triggeredSuggestionKeys.add(missingCtaKey);
        lastTriggeredOffsetMs.set(rule.id, offsetMs);
      }
      if (rule.id === "R007") {
        let currentRun: OfflineTranscriptSegment[] = [];
        let principleSegments: OfflineTranscriptSegment[] = [];
        for (const segment of speechWindow) {
          if (segment.tags.includes("ingredient_or_principle")) {
            currentRun.push(segment);
            if (currentRun.length > principleSegments.length) principleSegments = [...currentRun];
          } else currentRun = [];
        }
        const principleTooLong = principleSegments.length >= (rule.thresholds.principleSegmentsMin ?? Number.POSITIVE_INFINITY);
        const principleEvidence = principleSegments.slice(-5);
        const principleKey = `${rule.id}:speech:${principleEvidence.map((item) => item.id).join(",")}`;
        const principleEvidenceUnchanged = triggeredSuggestionKeys.has(principleKey);
        if (principleTooLong && (coolingDown || principleEvidenceUnchanged)) {
          cooldownRules.add(rule.id);
          if (principleEvidenceUnchanged) unchangedEvidenceRules.add(rule.id);
        }
        if (principleTooLong && !coolingDown && !principleEvidenceUnchanged) {
          const evidence = principleEvidence;
          suggestions.push({
            suggestionKey: principleKey,
            generatedAt: checkpointAt, latestDataAt: visibleMetrics.at(-1)?.endAt ?? null, delayMinutes: options.delayMinutes,
            ruleId: rule.id, ruleVersion: rule.version, templateVersion: rule.templateVersion, title: rule.offlineTitle ?? `${rule.title}（离线候选）`, source: "speech_only",
            relatedSpeech: evidence.map((item) => item.text), dataEvidence: [],
            action: rule.adviceTemplate.action, hostMessage: rule.adviceTemplate.hostMessage,
            evidenceSegmentIds: evidence.map((item) => item.id),
            confidence: principleSegments.some((item) => item.needsHumanReview) ? "low" : "medium",
            priority: rule.severity, target: "host", hostId: principleSegments.at(-1)?.hostId ?? null,
            productId: principleSegments.at(-1)?.productId ?? null, confounders: ["ASR 领域词待人工复核", "同期承接缺少 30 秒快照"],
            limitations: ["仅确认连续原理话术片段数达到正式配置；同期承接缺少 30 秒快照，不能宣称正式规则完整触发。"]
          });
          triggeredSuggestionKeys.add(principleKey);
          lastTriggeredOffsetMs.set(rule.id, offsetMs);
        }
      }
    }
    if (visibleMetrics.length > priorVisibleMetricCount) {
      const latest = visibleMetrics.at(-1)!;
      const previous = visibleMetrics.at(-2);
      const metrics = latest.canonicalMetrics ?? {};
      const clickRate = (metrics.product_impression_uv ?? 0) > 0 ? (metrics.product_click_uv ?? 0) / metrics.product_impression_uv! : null;
      const paidRate = (metrics.product_click_uv ?? 0) > 0 ? (metrics.paid_buyer_count ?? 0) / metrics.product_click_uv! : null;
      const roi = (metrics.ad_spend_fen ?? 0) > 0 ? (metrics.gross_paid_gmv_fen ?? 0) / metrics.ad_spend_fen! : null;
      const latestSpeech = visibleTranscript.filter((item) => {
        const absoluteStart = startMs + item.startMs;
        return absoluteStart >= Date.parse(latest.startAt) && absoluteStart < Date.parse(latest.endAt);
      });
      const observedTags = new Set(latestSpeech.flatMap((item) => item.tags));
      for (const rule of options.ruleReferences) {
        let candidate = false;
        let dataEvidence: BlindReplayCheckpoint["suggestions"][number]["dataEvidence"] = [];
        if (rule.id === "R001" && clickRate !== null) {
          const missingBenefitOrAction = !latestSpeech.some((item) => item.tags.includes("product_benefit") || item.tags.includes("cta") || item.tags.includes("order_or_payment"));
          candidate = clickRate <= (rule.thresholds.productClickRateMax ?? -1)
            && (metrics.room_enter_uv ?? 0) >= (rule.thresholds.roomEnterDeltaMin ?? Number.POSITIVE_INFINITY)
            && (metrics.product_impression_uv ?? 0) >= (rule.businessMinimums?.mainProductImpressionDelta ?? Number.POSITIVE_INFINITY)
            && missingBenefitOrAction;
          dataEvidence = [
            { metric: "room_enter_uv", value: metrics.room_enter_uv ?? null, unit: "uv", intervalIndex: latest.index },
            { metric: "product_impression_uv", value: metrics.product_impression_uv ?? null, unit: "uv", intervalIndex: latest.index },
            { metric: "product_click_uv", value: metrics.product_click_uv ?? null, unit: "uv", intervalIndex: latest.index },
            { metric: "product_click_rate_uv", value: clickRate, unit: "ratio", intervalIndex: latest.index }
          ];
        }
        if (rule.id === "R002" && hasProxyMinimumSample(rule) && clickRate !== null && paidRate !== null) {
          candidate = clickRate >= (rule.thresholds.productClickRateMin ?? Number.POSITIVE_INFINITY)
            && paidRate <= (rule.thresholds.clickToPaidRateMax ?? Number.NEGATIVE_INFINITY)
            && !["price", "gift", "guarantee", "order_or_payment"].every((tag) => observedTags.has(tag));
          dataEvidence = [
            { metric: "product_click_uv", value: metrics.product_click_uv ?? null, unit: "uv", intervalIndex: latest.index },
            { metric: "product_click_rate_uv", value: clickRate, unit: "ratio", intervalIndex: latest.index },
            { metric: "paid_buyer_count", value: metrics.paid_buyer_count ?? null, unit: "uv", intervalIndex: latest.index },
            { metric: "click_to_paid_rate_uv", value: paidRate, unit: "ratio", intervalIndex: latest.index }
          ];
        }
        if (rule.id === "R004" && previous?.canonicalMetrics && roi !== null) {
          const before = previous.canonicalMetrics;
          const previousRoi = (before.ad_spend_fen ?? 0) > 0 ? (before.gross_paid_gmv_fen ?? 0) / before.ad_spend_fen! : null;
          const spendAcceleration = (before.ad_spend_fen ?? 0) > 0 ? (metrics.ad_spend_fen ?? 0) / before.ad_spend_fen! : null;
          const roiDropRate = previousRoi !== null && previousRoi > 0 ? (previousRoi - roi) / previousRoi : null;
          candidate = previousRoi !== null && previousRoi > 0 && spendAcceleration !== null
            && spendAcceleration >= (rule.thresholds.spendAccelerationMin ?? Number.POSITIVE_INFINITY)
            && (roiDropRate ?? Number.NEGATIVE_INFINITY) >= (rule.thresholds.grossRoiDropRateMin ?? Number.POSITIVE_INFINITY)
            && roi < (rule.thresholds.grossRoiMax ?? Number.NEGATIVE_INFINITY);
          dataEvidence = [
            { metric: "comparison_ad_spend_fen", value: before.ad_spend_fen ?? null, unit: "fen", intervalIndex: previous.index },
            { metric: "ad_spend_fen", value: metrics.ad_spend_fen ?? null, unit: "fen", intervalIndex: latest.index },
            { metric: "spend_acceleration", value: spendAcceleration, unit: "ratio", intervalIndex: latest.index },
            { metric: "comparison_gross_roi", value: previousRoi, unit: "ratio", intervalIndex: previous.index },
            { metric: "gross_roi", value: roi, unit: "ratio", intervalIndex: latest.index },
            { metric: "gross_roi_drop_rate", value: roiDropRate, unit: "ratio", intervalIndex: latest.index }
          ];
        }
        if (rule.id === "R003" && visibleMetrics.length >= 3) {
          const trendIntervals = visibleMetrics.slice(-3);
          const points = trendIntervals.map((item) => item.canonicalMetrics?.concurrent_viewers).filter((value): value is number => typeof value === "number");
          if (points.length === 3) {
            const absoluteDrop = points[0]! - points[2]!;
            const relativeDrop = points[0]! > 0 ? absoluteDrop / points[0]! : null;
            const declineMatches = points[0]! > points[1]! && points[1]! > points[2]!
              && absoluteDrop >= (rule.thresholds.absoluteDropMin ?? Number.POSITIVE_INFINITY)
              && (relativeDrop ?? Number.NEGATIVE_INFINITY) >= (rule.thresholds.relativeDropMin ?? Number.POSITIVE_INFINITY);
            const hostChanged = trendIntervals.some((item, index) => index > 0 && item.hostId !== trendIntervals[index - 1]!.hostId);
            const spendChanged = hasMaterialAdjacentSpendChange(trendIntervals, spendRelativeChangeThreshold);
            const spendPairs = trendIntervals.slice(1).flatMap((item, pairIndex) => {
              const previousSpend = trendIntervals[pairIndex]!.canonicalMetrics?.ad_spend_fen;
              const currentSpend = item.canonicalMetrics?.ad_spend_fen;
              if (typeof previousSpend !== "number" || typeof currentSpend !== "number") return [];
              return [{ relativeChange: previousSpend === 0 || currentSpend === 0 ? null : Math.abs(currentSpend - previousSpend) / Math.abs(previousSpend), zeroTransition: previousSpend !== currentSpend && (previousSpend === 0 || currentSpend === 0) }];
            });
            const finiteSpendChanges = spendPairs.map((item) => item.relativeChange).filter((value): value is number => value !== null);
            if (declineMatches && (hostChanged || spendChanged)) confoundedRules.add(rule.id);
            candidate = declineMatches && !hostChanged && !spendChanged;
            dataEvidence = [
              ...trendIntervals.map((item, pointIndex) => ({ metric: `concurrent_viewers_point_${pointIndex + 1}`, value: item.canonicalMetrics?.concurrent_viewers ?? null, unit: "uv", intervalIndex: item.index })),
              { metric: "concurrent_viewers_absolute_drop", value: absoluteDrop, unit: "uv", intervalIndex: latest.index },
              { metric: "concurrent_viewers_relative_drop", value: relativeDrop, unit: "ratio", intervalIndex: latest.index },
              { metric: "host_changed", value: hostChanged ? 1 : 0, unit: "boolean", intervalIndex: latest.index },
              { metric: "maximum_adjacent_spend_relative_change", value: finiteSpendChanges.length > 0 ? Math.max(...finiteSpendChanges) : null, unit: "ratio", intervalIndex: latest.index },
              { metric: "spend_zero_transition", value: spendPairs.some((item) => item.zeroTransition) ? 1 : 0, unit: "boolean", intervalIndex: latest.index },
              { metric: "spend_relative_change_threshold", value: spendRelativeChangeThreshold, unit: "ratio", intervalIndex: latest.index }
            ];
          }
        }
        if (rule.id === "R008" && hasProxyMinimumSample(rule) && previous?.canonicalMetrics && clickRate !== null) {
          const beforeClickRate = (previous.canonicalMetrics.product_impression_uv ?? 0) > 0
            ? (previous.canonicalMetrics.product_click_uv ?? 0) / previous.canonicalMetrics.product_impression_uv! : null;
          const beforePaidRate = (previous.canonicalMetrics.product_click_uv ?? 0) > 0
            ? (previous.canonicalMetrics.paid_buyer_count ?? 0) / previous.canonicalMetrics.product_click_uv! : null;
          const clickLift = beforeClickRate !== null && beforeClickRate > 0 ? (clickRate - beforeClickRate) / beforeClickRate : Number.NEGATIVE_INFINITY;
          const paidLift = beforePaidRate !== null && beforePaidRate > 0 && paidRate !== null ? (paidRate - beforePaidRate) / beforePaidRate : Number.NEGATIVE_INFINITY;
          candidate = Math.max(clickLift, paidLift) >= (rule.thresholds.relativeLiftMin ?? Number.POSITIVE_INFINITY)
            && ["price", "gift", "guarantee", "order_or_payment"].every((tag) => observedTags.has(tag));
          dataEvidence = [
            { metric: "comparison_product_impression_uv", value: previous.canonicalMetrics.product_impression_uv ?? null, unit: "uv", intervalIndex: previous.index },
            { metric: "comparison_product_click_uv", value: previous.canonicalMetrics.product_click_uv ?? null, unit: "uv", intervalIndex: previous.index },
            { metric: "product_impression_uv", value: metrics.product_impression_uv ?? null, unit: "uv", intervalIndex: latest.index },
            { metric: "product_click_uv", value: metrics.product_click_uv ?? null, unit: "uv", intervalIndex: latest.index },
            { metric: "comparison_product_click_rate_uv", value: beforeClickRate, unit: "ratio", intervalIndex: previous.index },
            { metric: "product_click_rate_uv", value: clickRate, unit: "ratio", intervalIndex: latest.index },
            { metric: "product_click_rate_lift", value: Number.isFinite(clickLift) ? clickLift : null, unit: "ratio", intervalIndex: latest.index },
            { metric: "comparison_click_to_paid_rate_uv", value: beforePaidRate, unit: "ratio", intervalIndex: previous.index },
            { metric: "click_to_paid_rate_uv", value: paidRate, unit: "ratio", intervalIndex: latest.index },
            { metric: "click_to_paid_rate_lift", value: Number.isFinite(paidLift) ? paidLift : null, unit: "ratio", intervalIndex: latest.index }
          ];
        }
        if (dataEvidence.length > 0) evaluationEvidenceByRule.set(rule.id, dataEvidence);
        if (candidate && latestSpeech.length === 0) {
          candidate = false;
          speechInsufficientRules.add(rule.id);
        }
        if (!candidate) continue;
        const closeLoopSpeech = latestSpeech.filter((item) => item.tags.some((tag) => ["price", "gift", "guarantee", "cta", "order_or_payment", "product_benefit"].includes(tag))).slice(-5);
        const r008Speech = rule.id === "R008" ? [...new Map(["price", "gift", "guarantee", "order_or_payment"].flatMap((tag) => {
          const segment = latestSpeech.find((item) => item.tags.includes(tag));
          return segment ? [[segment.id, segment] as const] : [];
        })).values()].sort((left, right) => left.startMs - right.startMs) : [];
        const relevantSpeech = ["R001", "R003", "R004"].includes(rule.id) ? latestSpeech.slice(-5) : rule.id === "R008" ? r008Speech : closeLoopSpeech.length > 0 ? closeLoopSpeech : latestSpeech.slice(-5);
        suggestions.push({
          suggestionKey: `${rule.id}:metric:${latest.index}`,
          generatedAt: checkpointAt, latestDataAt: latest.endAt, delayMinutes: options.delayMinutes,
          ruleId: rule.id, ruleVersion: rule.version, templateVersion: rule.templateVersion, title: rule.offlineTitle ?? `${rule.title}（15分钟候选）`, source: "offline_15m_confirmation",
          relatedSpeech: relevantSpeech.map((item) => item.text),
          dataEvidence,
          action: rule.adviceTemplate.action, hostMessage: rule.adviceTemplate.hostMessage,
          evidenceSegmentIds: relevantSpeech.map((item) => item.id), confidence: "low", priority: rule.severity,
          target: rule.id === "R004" ? "operator_and_host" : rule.id === "R008" ? "operator" : "host", hostId: latest.hostId, productId: latest.productId,
          confounders: [
            "15 分钟 proxy，不是正式 2／5 分钟规则触发", "时段变化", "投放计划启停未采集", "商品信息未采集", "单场小样本",
            ...(previous && hasMaterialAdjacentSpendChange([previous, latest], spendRelativeChangeThreshold) ? ["投流消耗显著变化"] : [])
          ],
          limitations: [`offline_15m_confirmation proxy；只在该区间真实可见后生成，不代表正式规则触发。${["R001", "R003", "R004"].includes(rule.id) && closeLoopSpeech.length === 0 ? "该区间未检测到目标成交标签，引用末段原话供人工复核。" : ""}`]
        });
      }
    }
    priorVisibleMetricCount = visibleMetrics.length;
    checkpoints.push({
      checkpointAt,
      delayMinutes: options.delayMinutes,
      visibleMetricIntervalIndexes: options.includeVisibilityIds === false ? [] : visibleMetrics.map((item) => item.index),
      visibleTranscriptSegmentIds: options.includeVisibilityIds === false ? [] : visibleTranscript.map((item) => item.id),
      maxEvidenceAt,
      ruleEvaluations: options.ruleReferences.map((rule) => {
        const speechEvaluable = rule.id === "R005" || rule.id === "R007";
        const proxyEvaluable = hasProxyMinimumSample(rule);
        return {
          ruleId: rule.id,
          ruleVersion: rule.version,
          templateVersion: rule.templateVersion,
          status: suggestions.some((item) => item.ruleId === rule.id) ? "triggered" : cooldownRules.has(rule.id) ? "cooldown" : confoundedRules.has(rule.id) ? "confounded" : asrQualityInsufficientRules.has(rule.id) || speechInsufficientRules.has(rule.id) ? "insufficient_sample" : speechEvaluable || proxyEvaluable ? "not_triggered" : "insufficient_sample",
          reason: unchangedEvidenceRules.has(rule.id) ? "候选条件仍成立，但证据未变化，不重复生成。" : cooldownRules.has(rule.id) ? `候选仍成立，但距离上次触发不足 ${rule.cooldownSec} 秒，本检查点抑制重复建议。` : asrQualityInsufficientRules.has(rule.id)
            ? `可用转写不足：最近 180 秒需至少 ${asrQualityGate.minimumEvaluableSegments} 个可评估片段且累计 ${asrQualityGate.minimumEvaluableDurationMs}ms；可评估片段要求 confidence>=${asrQualityGate.minimumConfidence}、no_speech_prob<=${asrQualityGate.maximumNoSpeechProbability}、文本非空并含非 uncertain 业务标签。`
            : speechEvaluable
            ? "只评估可由检查点前 final 转写支持的话术条件；数据条件仍受 15 分钟粒度门控。"
            : confoundedRules.has(rule.id)
              ? `在线下降条件成立，但三窗内存在主播切换或相邻投流变化达到 ${(spendRelativeChangeThreshold * 100).toFixed(0)}%，按干扰门控不输出建议。`
            : speechInsufficientRules.has(rule.id)
              ? "数据 proxy 条件成立，但该 15 分钟区间没有可辨 final 话术，缺少检查点前 speech evidence，不输出无依据建议。"
            : proxyEvaluable
              ? "只按已可见的 15 分钟 canonical UV／整数分指标做低可信 proxy；不代表正式规则触发。"
              : "正式规则依赖 30 秒累计快照和 2／5 分钟真实窗口；本样本只有 15 分钟区间登记值，禁止插值。",
          evaluationEvidence: evaluationEvidenceByRule.get(rule.id) ?? []
        };
      }),
      suggestions
    });
  }
  return checkpoints;
}

export interface LagAssociation {
  lag: 0 | 1 | 2;
  tag: string;
  sourceWindowIndex: number;
  targetWindowIndex: number;
  metric: CanonicalAssociationMetric;
  beforeValue: number | null;
  afterValue: number;
  change: number | null;
  direction: "up" | "down" | "flat" | "unavailable";
  evidenceSegmentIds: string[];
  evidenceTexts: string[];
  humanReviewEvidenceCount: number;
  evidenceCount: number;
  confounders: string[];
  confidence: "low" | "medium";
  wording: string;
}

const ASSOCIATION_FIELDS = ["room_enter_uv", "product_click_uv", "paid_buyer_count", "ad_spend_fen", "gross_paid_gmv_fen", "concurrent_viewers"] as const;
type CanonicalAssociationMetric = typeof ASSOCIATION_FIELDS[number];

function numericCanonicalMetric(interval: OfflineMetricInterval, field: CanonicalAssociationMetric): number | null {
  const value = interval.canonicalMetrics?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function computeLagAssociations(
  intervals: OfflineMetricInterval[],
  transcriptSegments: OfflineTranscriptSegment[],
  sessionStartAt: string,
  options: { spendRelativeChangeThreshold?: number } = {}
): LagAssociation[] {
  const spendRelativeChangeThreshold = options.spendRelativeChangeThreshold ?? DEFAULT_LAG_SPEND_RELATIVE_CHANGE_THRESHOLD;
  if (!Number.isFinite(spendRelativeChangeThreshold) || spendRelativeChangeThreshold < 0) {
    throw new Error(`spendRelativeChangeThreshold 必须是非负有限数，实际 ${spendRelativeChangeThreshold}`);
  }
  const sessionStartMs = Date.parse(sessionStartAt);
  const tagsByWindow = new Map<number, string[]>();
  const representativeSegmentByWindowTag = new Map<string, OfflineTranscriptSegment>();
  for (const segment of transcriptSegments) {
    const absoluteStart = sessionStartMs + segment.startMs;
    const windowIndex = intervals.findIndex((item) => Date.parse(item.startAt) <= absoluteStart && absoluteStart < Date.parse(item.endAt));
    if (windowIndex >= 0) {
      tagsByWindow.set(windowIndex, [...(tagsByWindow.get(windowIndex) ?? []), ...segment.tags]);
      for (const tag of segment.tags) {
        const key = `${windowIndex}:${tag}`;
        if (!representativeSegmentByWindowTag.has(key)) representativeSegmentByWindowTag.set(key, segment);
      }
    }
  }
  const associations: LagAssociation[] = [];
  for (const lag of [0, 1, 2] as const) {
    for (const [sourceWindowIndex, tags] of tagsByWindow) {
      const targetWindowIndex = sourceWindowIndex + lag;
      if (targetWindowIndex >= intervals.length) continue;
      for (const tag of [...new Set(tags)].sort()) {
        const representativeSegment = representativeSegmentByWindowTag.get(`${sourceWindowIndex}:${tag}`)!;
        for (const metric of ASSOCIATION_FIELDS) {
          const afterValue = numericCanonicalMetric(intervals[targetWindowIndex]!, metric);
          if (afterValue === null) continue;
          const baselineWindowIndex = lag === 0 ? sourceWindowIndex - 1 : sourceWindowIndex;
          const beforeValue = baselineWindowIndex >= 0 ? numericCanonicalMetric(intervals[baselineWindowIndex]!, metric) : null;
          const change = beforeValue === null ? null : afterValue - beforeValue;
          const direction = change === null ? "unavailable" : change > 0 ? "up" : change < 0 ? "down" : "flat";
          const confounders = ["单场小样本", "时段自然变化", "商品信息未采集", "15 分钟区间粒度"];
          const pathStartIndex = lag === 0 ? Math.max(0, sourceWindowIndex - 1) : sourceWindowIndex;
          const path = intervals.slice(pathStartIndex, targetWindowIndex + 1);
          if (path.some((item, index) => index > 0 && item.hostId !== path[index - 1]!.hostId)) confounders.push("主播切换/跨主播");
          if (metric !== "ad_spend_fen") {
            const hasMaterialSpendChange = hasMaterialAdjacentSpendChange(path, spendRelativeChangeThreshold);
            if (hasMaterialSpendChange) confounders.push(`投流消耗相邻变化达到${(spendRelativeChangeThreshold * 100).toFixed(0)}%`);
          }
          if (representativeSegment.needsHumanReview) confounders.push("ASR代表证据需人工复核（1/1）");
          associations.push({
            lag, tag, sourceWindowIndex, targetWindowIndex, metric, beforeValue, afterValue, change, direction,
            evidenceSegmentIds: [representativeSegment.id], evidenceTexts: [representativeSegment.text],
            humanReviewEvidenceCount: representativeSegment.needsHumanReview ? 1 : 0, evidenceCount: 1,
            confounders,
            confidence: "low",
            wording: `Lag ${lag} 中观察到“${tag}”话术窗后目标窗的“${metric}”相对${lag === 0 ? "源窗前一窗" : "源窗"}${direction === "up" ? "上升" : direction === "down" ? "下降" : direction === "flat" ? "持平" : "缺少前值"}，仅作候选关联，不得据此作因果解释。`
          });
        }
      }
    }
  }
  return associations;
}

export interface LagCandidateChain {
  sourceWindowIndex: number;
  targetWindowIndex: number;
  speechTags: string[];
  currentWindowImprovements: string[];
  nextWindowTrafficChanges: { roomImpressionUv: number; roomEnterUv: number };
  speechEvidence: Array<{ tag: string; segmentId: string; text: string; needsHumanReview: boolean }>;
  evidenceSegmentIds: string[];
  evidenceTexts: string[];
  humanReviewEvidenceCount: number;
  evidenceCount: number;
  confidence: "low";
  confounders: string[];
  wording: string;
}

export function computeLagCandidateChains(
  intervals: OfflineMetricInterval[],
  transcriptSegments: OfflineTranscriptSegment[],
  sessionStartAt: string,
  options: { spendRelativeChangeThreshold?: number } = {}
): LagCandidateChain[] {
  const threshold = options.spendRelativeChangeThreshold ?? DEFAULT_LAG_SPEND_RELATIVE_CHANGE_THRESHOLD;
  const sessionStartMs = Date.parse(sessionStartAt);
  const relevantTags = new Set(["price", "promotion", "gift", "guarantee", "cta", "order_or_payment"]);
  const segmentsByWindow = new Map<number, OfflineTranscriptSegment[]>();
  for (const segment of transcriptSegments) {
    const absoluteStart = sessionStartMs + segment.startMs;
    const windowIndex = intervals.findIndex((item) => Date.parse(item.startAt) <= absoluteStart && absoluteStart < Date.parse(item.endAt));
    if (windowIndex < 0) continue;
    if (!segment.tags.some((tag) => relevantTags.has(tag))) continue;
    segmentsByWindow.set(windowIndex, [...(segmentsByWindow.get(windowIndex) ?? []), segment]);
  }
  const chains: LagCandidateChain[] = [];
  for (let sourceWindowIndex = 1; sourceWindowIndex < intervals.length - 1; sourceWindowIndex += 1) {
    const sourceSpeech = segmentsByWindow.get(sourceWindowIndex) ?? [];
    const speechTags = [...new Set(sourceSpeech.flatMap((segment) => segment.tags.filter((tag) => relevantTags.has(tag))))].sort();
    if (speechTags.length === 0) continue;
    const speechEvidence = speechTags.map((tag) => {
      const segment = sourceSpeech.find((item) => item.tags.includes(tag))!;
      return { tag, segmentId: segment.id, text: segment.text, needsHumanReview: segment.needsHumanReview };
    });
    const previous = intervals[sourceWindowIndex - 1]!;
    const source = intervals[sourceWindowIndex]!;
    const target = intervals[sourceWindowIndex + 1]!;
    const clickRate = (item: OfflineMetricInterval): number | null => {
      const impressions = item.canonicalMetrics?.product_impression_uv;
      const clicks = item.canonicalMetrics?.product_click_uv;
      return typeof impressions === "number" && impressions > 0 && typeof clicks === "number" ? clicks / impressions : null;
    };
    const improvements: string[] = [];
    const previousClickRate = clickRate(previous);
    const sourceClickRate = clickRate(source);
    if (previousClickRate !== null && sourceClickRate !== null && sourceClickRate > previousClickRate) improvements.push(`product_click_rate ${previousClickRate.toFixed(4)}→${sourceClickRate.toFixed(4)}`);
    const compareCount = (field: "paid_buyer_count" | "gross_paid_gmv_fen") => {
      const before = previous.canonicalMetrics?.[field];
      const after = source.canonicalMetrics?.[field];
      if (typeof before === "number" && typeof after === "number" && after > before) improvements.push(`${field} ${before}→${after}`);
    };
    compareCount("paid_buyer_count");
    compareCount("gross_paid_gmv_fen");
    if (improvements.length === 0) continue;
    const impressionChange = (target.canonicalMetrics?.room_impression_uv ?? Number.NaN) - (source.canonicalMetrics?.room_impression_uv ?? Number.NaN);
    const enterChange = (target.canonicalMetrics?.room_enter_uv ?? Number.NaN) - (source.canonicalMetrics?.room_enter_uv ?? Number.NaN);
    if (!Number.isFinite(impressionChange) || !Number.isFinite(enterChange) || Math.max(impressionChange, enterChange) <= 0) continue;
    const path = [previous, source, target];
    const confounders = ["单场小样本", "15 分钟区间粒度", "投放计划启停未采集", "商品信息未采集"];
    if (path.some((item, index) => index > 0 && item.hostId !== path[index - 1]!.hostId)) confounders.push("主播切换/跨主播");
    if (hasMaterialAdjacentSpendChange(path, threshold)) confounders.push(`投流消耗相邻变化达到${(threshold * 100).toFixed(0)}%`);
    const uniqueSpeechEvidence = [...new Map(speechEvidence.map((item) => [item.segmentId, item])).values()];
    const humanReviewEvidenceCount = uniqueSpeechEvidence.filter((item) => item.needsHumanReview).length;
    if (humanReviewEvidenceCount === uniqueSpeechEvidence.length) confounders.push(`ASR代表证据全部需人工复核（${humanReviewEvidenceCount}/${uniqueSpeechEvidence.length}）`);
    else if (humanReviewEvidenceCount > 0) confounders.push(`ASR代表证据部分需人工复核（${humanReviewEvidenceCount}/${uniqueSpeechEvidence.length}）`);
    chains.push({
      sourceWindowIndex, targetWindowIndex: sourceWindowIndex + 1, speechTags, currentWindowImprovements: improvements,
      nextWindowTrafficChanges: { roomImpressionUv: impressionChange, roomEnterUv: enterChange },
      speechEvidence, evidenceSegmentIds: uniqueSpeechEvidence.map((item) => item.segmentId), evidenceTexts: uniqueSpeechEvidence.map((item) => item.text),
      humanReviewEvidenceCount, evidenceCount: uniqueSpeechEvidence.length, confidence: "low", confounders,
      wording: `观察到权益/CTA话术、当窗承接改善与下一窗至少一项流量指标上升同时出现，仅构成待复核候选关联链路，不支持平台加推因果结论。`
    });
  }
  return chains;
}

export interface LagCorrelationSummary {
  group: "all" | string;
  sourceMetric: "product_click_uv" | "paid_buyer_count" | "gross_paid_gmv_fen";
  targetMetric: "room_impression_uv" | "room_enter_uv";
  controlMetric: "ad_spend_fen";
  lag: 0 | 1 | 2;
  n: number;
  pearsonRaw: number | null;
  pearsonSpendAdjusted: number | null;
  confidence: "low";
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index]! - rightMean), 0);
  const leftSquare = left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0);
  const rightSquare = right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator === 0 ? null : numerator / denominator;
}

function residuals(values: number[], control: number[]): number[] | null {
  const controlMean = control.reduce((sum, value) => sum + value, 0) / control.length;
  const valueMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const denominator = control.reduce((sum, value) => sum + (value - controlMean) ** 2, 0);
  if (denominator === 0) return null;
  const slope = control.reduce((sum, value, index) => sum + (value - controlMean) * (values[index]! - valueMean), 0) / denominator;
  return values.map((value, index) => value - (valueMean + slope * (control[index]! - controlMean)));
}

export function computeLagCorrelationSummaries(intervals: OfflineMetricInterval[]): LagCorrelationSummary[] {
  const groups = ["all", ...new Set(intervals.map((item) => item.hostId).filter((value): value is string => value !== null))];
  const sourceMetrics = ["product_click_uv", "paid_buyer_count", "gross_paid_gmv_fen"] as const;
  const targetMetrics = ["room_impression_uv", "room_enter_uv"] as const;
  const summaries: LagCorrelationSummary[] = [];
  for (const group of groups) {
    for (const lag of [0, 1, 2] as const) {
      for (const sourceMetric of sourceMetrics) {
        for (const targetMetric of targetMetrics) {
          const sourceIntervals = lag === 0 ? intervals : intervals.slice(0, -lag);
          const pairs = sourceIntervals.flatMap((item, index) => {
          const next = intervals[index + lag]!;
          if (group !== "all" && (item.hostId !== group || next.hostId !== group)) return [];
          const source = item.canonicalMetrics?.[sourceMetric];
          const target = next.canonicalMetrics?.[targetMetric];
          const spend = item.canonicalMetrics?.ad_spend_fen;
          return typeof source === "number" && typeof target === "number" && typeof spend === "number" ? [{ source, target, spend }] : [];
        });
        const source = pairs.map((item) => item.source);
        const target = pairs.map((item) => item.target);
        const spend = pairs.map((item) => item.spend);
        const sourceResidual = residuals(source, spend);
        const targetResidual = residuals(target, spend);
          summaries.push({
          group, sourceMetric, targetMetric, controlMetric: "ad_spend_fen", lag, n: pairs.length,
          pearsonRaw: pearson(source, target),
          pearsonSpendAdjusted: sourceResidual && targetResidual ? pearson(sourceResidual, targetResidual) : null,
          confidence: "low"
          });
        }
      }
    }
  }
  return summaries;
}
