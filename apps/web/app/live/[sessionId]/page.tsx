"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { resolveLiveBackend } from "../backend-url";
import { liveAudioStatusLabel } from "../audio-status";
import { LanShareBar } from "../lan-share";

import OperatorRulesPanel from "../operator-rules-panel";
import HistoryReference from "../history-reference";
import WorkbenchTrend from "../workbench-trend";
import "../workbench.css";

const OPERATOR_RULES = process.env.NEXT_PUBLIC_OPERATOR_RULES === "1";
const CAPTURE_ONLY = process.env.NEXT_PUBLIC_CAPTURE_ONLY === "1";

type LiveMetric = {
  observedAt: string;
  dataStatus: "fresh" | "stale" | "offline" | "unknown";
  onlineSnapshot?: number;
  sessionPaidGmvFen?: number;
  adSpendFen?: number;
  paidBuyerCount?: number;
  paidItemCount?: number;
  watchToPaidRate?: number;
  productClickToPaidRate?: number;
  averageWatchDurationSec?: number;
  roomEnterCount5m?: number;
  userPaidGmvFen5m?: number;
  productClickCount?: number;
  productPayGmvFen?: number;
  unpaidOrderCount?: number;
  productName?: string;
  currentProductName?: string;
  productPaidGmvFen?: number;
  windowLabel?: string;
};
type LiveActionEvidence = { metricSnapshot: LiveMetric | null; quotedSpeech: Array<{ at: string; text: string }>; observationStatus: "pending" | "observed" | "insufficient_sample" | "confounded" };
type LiveAction = { id: string; kind: "action" | "review" | "recovery"; title: string; message: string; reason: string; confidence: "high" | "medium" | "low"; createdAt: string; resolution?: { status: "executed" | "not_executed" | "not_applicable" | "resolved"; operatorId?: string; at: string; reason?: string }; actionEvidence?: LiveActionEvidence };
type LiveMetricComparison = { semantic: "instant" | "cumulative" | "rolling" | "rate"; status: "baseline" | "changed" | "unchanged" | "reset"; reason: "first_sample" | "same_timestamp" | "different_source" | "different_product" | "unknown_product" | "matched" | "counter_reset"; delta?: number; previousObservedAt?: string };
type CoverageGroup = { available: number; total: number; missing: string[] };
export type QianchuanMetricValue = { value: number; unit: "元" | "%" | "人" | "次" | "单" | "unknown"; semantic: "instant" | "cumulative" | "rolling" | "rate"; sourceField: string; windowLabel?: string };
export type QianchuanMetric = { roomId?: string; sourceEndpoint?: string; mappingVersion?: string; observedAt: string; dataStatus: "fresh" | "stale" | "offline" | "unknown"; metricSource: "qianchuan"; metrics: Partial<Record<"adSpend" | "paidOrderGmv" | "paidOrderCount" | "productImpressions" | "productClicks" | "liveImpressions" | "liveWatchCount" | "onlineSnapshot" | "gpm" | "watchToPaid" | "productClickToPaid" | "showToWatch" | "watchToProductClick" | "liveWatchToPaid" | "costPerPaidOrder" | "roi" | "cpmPlatform" | "platformCtr" | "platformConvertRate" | "commentCount" | "followCount" | "fansClubJoinCount" | "shareCount" | "payOrderAverage", QianchuanMetricValue>>; };
export type HourBaselineStatus =
  | { status: "ok"; grain: "hour"; n: number; median: number; p25: number; p75: number }
  | { status: "sampleInsufficient"; grain: "hour"; n: number; reason: "n_lt_3" | "hour_not_split_to_quarter" | "no_complete_samples" };
export type LiveHourComparisonMetric = {
  metricKey: "gmvFen" | "gsvFen" | "adSpendFen" | "onlineSnapshot";
  grain: "hour";
  liveStatus: "ok" | "missing";
  liveValue?: number;
  liveCoverage: "hour_to_date" | "full_hour" | "unavailable";
  baseline: HourBaselineStatus;
  band?: "above_p75" | "within_iqr" | "below_p25";
};
export type LiveHourVsBaseline = {
  grain: "hour";
  weekday: number;
  hour: number;
  lastSuccessAt?: string;
  asOfLocalDate?: string;
  metrics: LiveHourComparisonMetric[];
};
export type DiagnosisCitedNumber = { label: string; value: number; unit: string };
export type DiagnosisFinding = { id: string; text: string; citedNumbers: DiagnosisCitedNumber[] };
export type DiagnosisWindow = {
  windowStartAt: string;
  windowEndAt: string;
  hourAlignment: { hour: number; grain: "hour"; note: string };
  coverage: "full" | "partial";
  provider: "deterministic-template" | "ark-expression";
  confidence: "confirmed" | "leaning" | "unknown";
  actionKind: "hold" | "check_spend" | "traffic_quality" | "retain" | "click_cta" | "close_gift" | "close_price" | "close_urgency" | "wait";
  funnelStage: "spend_spike" | "spend" | "exposure" | "entry" | "click" | "convert" | "aov" | "maintain" | "wait";
  streakCount: number;
  triggerType?: "scheduled_15m" | "event_spend_spike" | "event_traffic_drop" | "event_click_no_pay";
  executionState?: "complete" | "incomplete" | "unknown" | "not_applicable";
  interruptDecision?: "interrupt" | "observe" | "status_only";
  productRole?: "trial_acquisition" | "value_bundle" | "repeat_purchase" | "welfare_item" | "unknown";
  previousActionOutcome?: "relieved" | "unrelieved" | "observing" | "not_evaluated";
  dataCompleteness?: "complete" | "data_incomplete";
  verdict: DiagnosisFinding;
  evidence: DiagnosisFinding[];
  action: DiagnosisFinding;
  watchNext: DiagnosisFinding;
  pending: DiagnosisFinding[];
  conclusions: DiagnosisFinding[];
  nextWindowSuggestion: DiagnosisFinding;
  anomalies: Array<{ type: string; text: string; citedNumbers: DiagnosisCitedNumber[] }>;
};
type LiveProductRole = "trial_acquisition" | "value_bundle" | "repeat_purchase" | "welfare_item" | "unknown";
export type LiveSourceStatus = "fresh" | "stale" | "offline" | "unknown" | "partial";
export type LiveSourceGroupHealth = {
  source: "qianchuan" | "compass";
  group: string;
  status: string;
  lastSeenAt?: string;
};
export type LivePageRuntimeState = {
  source: "qianchuan" | "compass";
  observedAt: string;
  visibilityState: "visible" | "hidden" | "prerender";
  hasFocus: boolean;
  navigatorOnline: boolean;
  debuggerAttached: boolean;
  allowlistStatus: "allowed" | "login" | "blocked";
  topFrameLifecycle: "live" | "loading" | "stopped";
  lastNavigationAt?: string;
};
export type LiveRecoveryHistoryEntry = {
  source: "qianchuan" | "compass";
  action: string;
  outcome: string;
  attemptedAt: string;
  recoveredAt?: string;
  reason: string;
};
export type QianchuanOfficialApiStatus = {
  source: "official_api";
  configured: boolean;
  state: "not_configured" | "idle" | "healthy" | "stale" | "error";
  activeSessions: number;
  lastSuccessAt?: string;
  lastErrorCode?: string;
  consecutiveFailures: number;
};
type LiveView = {
  session: { name: string; status: string; startedAt?: string };
  needsReconnect: boolean;
  latestMetric: LiveMetric | null;
  qianchuan: { status: LiveSourceStatus; overallHealth?: string; groups?: LiveSourceGroupHealth[]; latestMetric: QianchuanMetric | null; metricHistory: QianchuanMetric[]; lastMetricAt?: string; sourceKind?: "official_api" | "browser_extension" | "none"; officialApi?: QianchuanOfficialApiStatus };
  metricHistory: LiveMetric[];
  metricFieldTimes: Record<string, string>;
  metricComparisons: Record<string, LiveMetricComparison>;
  latestTranscript: { text: string; at: string } | null;
  recentTranscripts: Array<{ at: string; text: string }>;
  source: { status: LiveSourceStatus; overallHealth?: string; groups?: LiveSourceGroupHealth[]; lastMetricAt?: string; mappingVersion: string; firstMetricTimedOut: boolean; coverage: { core: CoverageGroup; fiveMinute: CoverageGroup; product: CoverageGroup } };
  audio: { status: "not_started" | "connecting" | "active" | "stale" | "offline" | "error"; transcriptionStatus: "not_started" | "waiting_final" | "active" | "stale" | "offline" | "error"; lastAudioAt?: string; lastFinalAt?: string; finalCount: number; audioFrames: number; nonSilentAudioFrames: number; energyBand: "silent" | "low" | "normal" | "unknown"; firstFinalTimedOut: boolean; errorCode?: string };
  action: LiveAction | null;
  actionEvidence: LiveActionEvidence | null;
  actionHistory: LiveAction[];
  eventMarkers: Array<{ at: string; type: string; label: string }>;
  hourVsBaseline: LiveHourVsBaseline | null;
  diagnosis: DiagnosisWindow | null;
  productRole: LiveProductRole;
  sourceGroupHealth?: { qianchuan: { overallHealth: string; groups: LiveSourceGroupHealth[] }; compass: { overallHealth: string; groups: LiveSourceGroupHealth[] } };
  pageRuntimeState?: { qianchuan?: LivePageRuntimeState; compass?: LivePageRuntimeState };
  recoveryHistory?: LiveRecoveryHistoryEntry[];
  pendingRecovery?: { source: "qianchuan" | "compass"; requestedAt: string; confirm: boolean };
  lastRecoveredAt?: string;
  recovering?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeSourceStatus(value: unknown): LiveSourceStatus {
  return value === "fresh" || value === "stale" || value === "offline" || value === "partial" ? value : "unknown";
}

function normalizeGroupHealth(value: unknown): LiveSourceGroupHealth[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || (item.source !== "qianchuan" && item.source !== "compass") || typeof item.group !== "string" || typeof item.status !== "string") return [];
    return [{
      source: item.source,
      group: item.group,
      status: item.status,
      ...(typeof item.lastSeenAt === "string" ? { lastSeenAt: item.lastSeenAt } : {})
    }];
  });
}

function normalizePageRuntime(value: unknown): LivePageRuntimeState | undefined {
  if (!isRecord(value) || (value.source !== "qianchuan" && value.source !== "compass") || typeof value.observedAt !== "string") return undefined;
  if (value.visibilityState !== "visible" && value.visibilityState !== "hidden" && value.visibilityState !== "prerender") return undefined;
  if (typeof value.hasFocus !== "boolean" || typeof value.navigatorOnline !== "boolean" || typeof value.debuggerAttached !== "boolean") return undefined;
  if (value.allowlistStatus !== "allowed" && value.allowlistStatus !== "login" && value.allowlistStatus !== "blocked") return undefined;
  if (value.topFrameLifecycle !== "live" && value.topFrameLifecycle !== "loading" && value.topFrameLifecycle !== "stopped") return undefined;
  return {
    source: value.source,
    observedAt: value.observedAt,
    visibilityState: value.visibilityState,
    hasFocus: value.hasFocus,
    navigatorOnline: value.navigatorOnline,
    debuggerAttached: value.debuggerAttached,
    allowlistStatus: value.allowlistStatus,
    topFrameLifecycle: value.topFrameLifecycle,
    ...(typeof value.lastNavigationAt === "string" ? { lastNavigationAt: value.lastNavigationAt } : {})
  };
}

const QIANCHUAN_OFFICIAL_API_STATE = ["not_configured", "idle", "healthy", "stale", "error"] as const;
const QIANCHUAN_SAFE_ERROR_CODE = /^QIANCHUAN_[A-Z0-9_]{1,80}$/;

function normalizeQianchuanOfficialApi(value: unknown): QianchuanOfficialApiStatus | undefined {
  if (!isRecord(value) || value.source !== "official_api" || typeof value.configured !== "boolean") return undefined;
  if (!QIANCHUAN_OFFICIAL_API_STATE.includes(value.state as QianchuanOfficialApiStatus["state"])) return undefined;
  if (typeof value.activeSessions !== "number" || !Number.isSafeInteger(value.activeSessions) || value.activeSessions < 0) return undefined;
  if (typeof value.consecutiveFailures !== "number" || !Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0) return undefined;
  if (value.configured === false && value.state !== "not_configured") return undefined;
  if (value.configured === true && value.state === "not_configured") return undefined;
  if (value.lastSuccessAt !== undefined && (typeof value.lastSuccessAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.lastSuccessAt) || !Number.isFinite(Date.parse(value.lastSuccessAt)))) return undefined;
  if (value.lastErrorCode !== undefined && (typeof value.lastErrorCode !== "string" || !QIANCHUAN_SAFE_ERROR_CODE.test(value.lastErrorCode))) return undefined;
  return {
    source: "official_api",
    configured: value.configured,
    state: value.state as QianchuanOfficialApiStatus["state"],
    activeSessions: value.activeSessions,
    consecutiveFailures: value.consecutiveFailures,
    ...(typeof value.lastSuccessAt === "string" ? { lastSuccessAt: value.lastSuccessAt } : {}),
    ...(typeof value.lastErrorCode === "string" ? { lastErrorCode: value.lastErrorCode } : {})
  };
}

function normalizeCoverageGroup(value: unknown): CoverageGroup {
  if (!isRecord(value)) return { available: 0, total: 0, missing: [] };
  const available = typeof value.available === "number" ? value.available : 0;
  const total = typeof value.total === "number" ? value.total : 0;
  const missing = Array.isArray(value.missing) ? value.missing.filter((item): item is string => typeof item === "string") : [];
  return { available, total, missing };
}

function normalizeSpeech(value: unknown): Array<{ at: string; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.at !== "string" || typeof item.text !== "string") return [];
    return [{ at: item.at, text: item.text }];
  });
}

function normalizeCitedNumbers(value: unknown): DiagnosisCitedNumber[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== "string" || typeof item.value !== "number" || typeof item.unit !== "string") return [];
    return [{ label: item.label, value: item.value, unit: item.unit }];
  });
}

function normalizeFinding(value: unknown): DiagnosisFinding | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.text !== "string") return null;
  const citedNumbers = normalizeCitedNumbers(value.citedNumbers);
  return citedNumbers.length ? { id: value.id, text: value.text, citedNumbers } : null;
}

function normalizeHourBaseline(value: unknown): HourBaselineStatus | null {
  if (!isRecord(value) || value.grain !== "hour" || typeof value.n !== "number") return null;
  if (value.status === "ok" && typeof value.median === "number" && typeof value.p25 === "number" && typeof value.p75 === "number") {
    return { status: "ok", grain: "hour", n: value.n, median: value.median, p25: value.p25, p75: value.p75 };
  }
  if (value.status === "sampleInsufficient" && (value.reason === "n_lt_3" || value.reason === "hour_not_split_to_quarter" || value.reason === "no_complete_samples")) {
    return { status: "sampleInsufficient", grain: "hour", n: value.n, reason: value.reason };
  }
  return null;
}

function normalizeHourVsBaseline(value: unknown): LiveHourVsBaseline | null {
  if (!isRecord(value) || value.grain !== "hour" || typeof value.weekday !== "number" || typeof value.hour !== "number" || !Array.isArray(value.metrics)) return null;
  const metrics = value.metrics.flatMap((item): LiveHourComparisonMetric[] => {
    if (!isRecord(item) || item.grain !== "hour") return [];
    if (item.metricKey !== "gmvFen" && item.metricKey !== "gsvFen" && item.metricKey !== "adSpendFen" && item.metricKey !== "onlineSnapshot") return [];
    if (item.liveStatus !== "ok" && item.liveStatus !== "missing") return [];
    if (item.liveCoverage !== "hour_to_date" && item.liveCoverage !== "full_hour" && item.liveCoverage !== "unavailable") return [];
    const baseline = normalizeHourBaseline(item.baseline);
    if (!baseline) return [];
    return [{
      metricKey: item.metricKey,
      grain: "hour",
      liveStatus: item.liveStatus,
      liveCoverage: item.liveCoverage,
      baseline,
      ...(typeof item.liveValue === "number" ? { liveValue: item.liveValue } : {}),
      ...(item.band === "above_p75" || item.band === "within_iqr" || item.band === "below_p25" ? { band: item.band } : {})
    }];
  });
  if (!metrics.length) return null;
  return {
    grain: "hour",
    weekday: value.weekday,
    hour: value.hour,
    metrics,
    ...(typeof value.lastSuccessAt === "string" ? { lastSuccessAt: value.lastSuccessAt } : {}),
    ...(typeof value.asOfLocalDate === "string" ? { asOfLocalDate: value.asOfLocalDate } : {})
  };
}

const OPERATOR_HOUR_NOTE = "整点除以4只作弱参考，小偏离不作为动作。";
const DIAGNOSIS_CONFIDENCE_LABEL: Record<DiagnosisWindow["confidence"], string> = {
  confirmed: "已确认",
  leaning: "倾向判断",
  unknown: "暂不能判断"
};
const SPEECH_OPERATOR_LABEL: Record<string, string> = {
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

export function isOperatorNoiseDiagnosisText(text: string): boolean {
  return /累计口径/.test(text) && /回退/.test(text)
    || /增量已按非负处理/.test(text)
    || /不把回退写成负增长/.test(text);
}

export function translateOperatorDiagnosisText(text: string): string {
  let next = text;
  for (const key of Object.keys(SPEECH_OPERATOR_LABEL).sort((a, b) => b.length - a.length)) {
    next = next.split(key).join(SPEECH_OPERATOR_LABEL[key] ?? key);
  }
  next = next.replace(/\bunknown\b/g, "没听清");
  next = next.replace(/[（(]grain=hour[^）)]*[）)]/g, "");
  next = next.replace(/\bgrain=hour\b/g, "");
  next = next.replace(/，?\s*n=\d+/g, "");
  next = next.replace(/，?\s*不是 15 分钟真值/g, "");
  next = next.replace(/本窗 GMV/g, "这15分钟成交");
  next = next.replace(/本窗话术已命中/g, "这15分钟明确讲到了");
  next = next.replace(/未命中项保持\s*没听清，不推断为没讲。/g, "");
  next = next.replace(/没列出来的不代表没讲[，,]只是这次没听清。/g, "");
  next = next.replace(/没列出来的不代表没讲。/g, "");
  next = next.replace(/没听清的不代表没讲。/g, "");
  next = next.replace(/没听到不等于没讲。/g, "");
  next = next.replace(/对照所属\s*(\d+)\s*点小时基线中位数/g, "平时$1点整小时大约");
  next = next.replace(/下一窗继续用 15 分钟增量对照\s*(\d+)\s*点小时基线中位数/g, "下一刻先盯成交。平时$1点整小时大约");
  next = next.replace(/15分钟窗对齐所属时钟小时基线，未把小时均分成15分钟/g, OPERATOR_HOUR_NOTE);
  next = next.replace(/本窗累计口径出现\s*\d+\s*次回退[^。]*。/g, "");
  return next.replace(/\s{2,}/g, " ").replace(/[（(]\s*[）)]/g, "").replace(/[，、]\s*(?=[。])/g, "").replace(/\s+。/g, "。").trim();
}

function sanitizeFinding(item: DiagnosisFinding): DiagnosisFinding | null {
  if (isOperatorNoiseDiagnosisText(item.text)) return null;
  const text = translateOperatorDiagnosisText(item.text);
  return text.length > 0 ? { ...item, text } : null;
}

export function sanitizeDiagnosisForOperator(diagnosis: DiagnosisWindow): DiagnosisWindow {
  const sourceNote = diagnosis.hourAlignment.note;
  const hourNote = /grain|均分|对齐所属|固定除以4/.test(sourceNote) ? OPERATOR_HOUR_NOTE : (translateOperatorDiagnosisText(sourceNote) || OPERATOR_HOUR_NOTE);
  const verdict = sanitizeFinding(diagnosis.verdict) ?? diagnosis.verdict;
  const evidence = diagnosis.evidence.flatMap((item) => {
    const next = sanitizeFinding(item);
    return next ? [next] : [];
  }).slice(0, 4);
  const action = sanitizeFinding(diagnosis.action) ?? diagnosis.action;
  const watchNext = sanitizeFinding(diagnosis.watchNext) ?? diagnosis.watchNext;
  const pending = diagnosis.pending.flatMap((item) => {
    const next = sanitizeFinding(item);
    return next ? [next] : [];
  }).slice(0, 3);
  const conclusions = [verdict, ...evidence].filter((item) => !isOperatorNoiseDiagnosisText(item.text)).slice(0, 3);
  return {
    ...diagnosis,
    hourAlignment: { ...diagnosis.hourAlignment, note: hourNote },
    verdict,
    evidence: evidence.length ? evidence : [verdict],
    action,
    watchNext,
    pending,
    conclusions,
    nextWindowSuggestion: action,
    anomalies: diagnosis.anomalies
      .filter((item) => item.type !== "counter_reset" && !isOperatorNoiseDiagnosisText(item.text))
      .map((item) => ({ ...item, text: translateOperatorDiagnosisText(item.text) }))
  };
}

function normalizeDiagnosis(value: unknown): DiagnosisWindow | null {
  if (!isRecord(value) || typeof value.windowStartAt !== "string" || typeof value.windowEndAt !== "string") return null;
  const hourAlignment = isRecord(value.hourAlignment) && typeof value.hourAlignment.hour === "number" && value.hourAlignment.grain === "hour" && typeof value.hourAlignment.note === "string"
    ? { hour: value.hourAlignment.hour, grain: "hour" as const, note: value.hourAlignment.note }
    : null;
  const nextWindowSuggestion = normalizeFinding(value.nextWindowSuggestion);
  const conclusions = Array.isArray(value.conclusions) ? value.conclusions.flatMap((item) => { const found = normalizeFinding(item); return found ? [found] : []; }).slice(0, 3) : [];
  if (!hourAlignment || !nextWindowSuggestion) return null;
  const usableConclusions = conclusions.filter((item) => !isOperatorNoiseDiagnosisText(item.text));
  const verdict = normalizeFinding(value.verdict) ?? usableConclusions[0] ?? nextWindowSuggestion;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.flatMap((item) => { const found = normalizeFinding(item); return found ? [found] : []; }).slice(0, 4)
    : usableConclusions.slice(1);
  const action = normalizeFinding(value.action) ?? nextWindowSuggestion;
  const watchNext = normalizeFinding(value.watchNext) ?? nextWindowSuggestion;
  const pending = Array.isArray(value.pending) ? value.pending.flatMap((item) => { const found = normalizeFinding(item); return found ? [found] : []; }).slice(0, 3) : [];
  const confidence = value.confidence === "confirmed" || value.confidence === "leaning" || value.confidence === "unknown"
    ? value.confidence
    : "unknown";
  const actionKind = value.actionKind === "hold" || value.actionKind === "check_spend" || value.actionKind === "traffic_quality" || value.actionKind === "retain" || value.actionKind === "click_cta" || value.actionKind === "close_gift" || value.actionKind === "close_price" || value.actionKind === "close_urgency" || value.actionKind === "wait"
    ? value.actionKind
    : "hold";
  const funnelStage = value.funnelStage === "spend_spike" || value.funnelStage === "spend" || value.funnelStage === "exposure" || value.funnelStage === "entry" || value.funnelStage === "click" || value.funnelStage === "convert" || value.funnelStage === "aov" || value.funnelStage === "maintain" || value.funnelStage === "wait"
    ? value.funnelStage
    : "maintain";
  const streakCount = typeof value.streakCount === "number" && Number.isFinite(value.streakCount)
    ? Math.min(8, Math.max(1, Math.floor(value.streakCount)))
    : 1;
  return sanitizeDiagnosisForOperator({
    windowStartAt: value.windowStartAt,
    windowEndAt: value.windowEndAt,
    hourAlignment,
    coverage: value.coverage === "partial" ? "partial" : "full",
    provider: value.provider === "ark-expression" ? "ark-expression" : "deterministic-template",
    confidence,
    actionKind,
    funnelStage,
    streakCount,
    verdict,
    evidence: evidence.length ? evidence : [verdict],
    action,
    watchNext,
    pending,
    conclusions: conclusions.length ? conclusions : [verdict],
    nextWindowSuggestion,
    anomalies: Array.isArray(value.anomalies) ? value.anomalies.flatMap((item) => {
      if (!isRecord(item) || typeof item.type !== "string" || typeof item.text !== "string") return [];
      const citedNumbers = normalizeCitedNumbers(item.citedNumbers);
      return citedNumbers.length ? [{ type: item.type, text: item.text, citedNumbers }] : [];
    }) : [],
    ...(value.triggerType === "scheduled_15m" || value.triggerType === "event_spend_spike" || value.triggerType === "event_traffic_drop" || value.triggerType === "event_click_no_pay" ? { triggerType: value.triggerType } : {}),
    ...(value.executionState === "complete" || value.executionState === "incomplete" || value.executionState === "unknown" || value.executionState === "not_applicable" ? { executionState: value.executionState } : {}),
    ...(value.interruptDecision === "interrupt" || value.interruptDecision === "observe" || value.interruptDecision === "status_only" ? { interruptDecision: value.interruptDecision } : {}),
    ...(value.productRole === "trial_acquisition" || value.productRole === "value_bundle" || value.productRole === "repeat_purchase" || value.productRole === "welfare_item" || value.productRole === "unknown" ? { productRole: value.productRole } : {}),
    ...(value.previousActionOutcome === "relieved" || value.previousActionOutcome === "unrelieved" || value.previousActionOutcome === "observing" || value.previousActionOutcome === "not_evaluated" ? { previousActionOutcome: value.previousActionOutcome } : {})
  });
}

export function normalizeLiveView(raw: unknown): LiveView {
  const source = isRecord(raw) && isRecord(raw.source) ? raw.source : {};
  const sourceCoverage = isRecord(source.coverage) ? source.coverage : {};
  const qianchuan = isRecord(raw) && isRecord(raw.qianchuan) ? raw.qianchuan : {};
  const officialApi = normalizeQianchuanOfficialApi(qianchuan.officialApi);
  const session = isRecord(raw) && isRecord(raw.session) ? raw.session : {};
  const audio = isRecord(raw) && isRecord(raw.audio) ? raw.audio : {};
  const latestTranscript = isRecord(raw) && isRecord(raw.latestTranscript) && typeof raw.latestTranscript.at === "string" && typeof raw.latestTranscript.text === "string"
    ? { at: raw.latestTranscript.at, text: raw.latestTranscript.text }
    : null;
  const rawValue = isRecord(raw) ? raw : {};
  return {
    session: {
      name: stringValue(session.name, "直播实时驾驶舱"),
      status: stringValue(session.status, "unknown"),
      ...(typeof session.startedAt === "string" ? { startedAt: session.startedAt } : {})
    },
    needsReconnect: rawValue.needsReconnect === true,
    latestMetric: isRecord(rawValue.latestMetric) ? rawValue.latestMetric as LiveMetric : null,
    qianchuan: {
      status: normalizeSourceStatus(qianchuan.status),
      ...(typeof qianchuan.overallHealth === "string" ? { overallHealth: qianchuan.overallHealth } : {}),
      ...(normalizeGroupHealth(qianchuan.groups).length ? { groups: normalizeGroupHealth(qianchuan.groups) } : {}),
      latestMetric: isRecord(qianchuan.latestMetric) ? qianchuan.latestMetric as QianchuanMetric : null,
      metricHistory: Array.isArray(qianchuan.metricHistory) ? qianchuan.metricHistory.filter(isRecord) as QianchuanMetric[] : [],
      ...(typeof qianchuan.lastMetricAt === "string" ? { lastMetricAt: qianchuan.lastMetricAt } : {}),
      ...(qianchuan.sourceKind === "official_api" || qianchuan.sourceKind === "browser_extension" || qianchuan.sourceKind === "none" ? { sourceKind: qianchuan.sourceKind } : {}),
      ...(officialApi ? { officialApi } : {})
    },
    metricHistory: Array.isArray(rawValue.metricHistory) ? rawValue.metricHistory.filter(isRecord) as LiveMetric[] : [],
    metricFieldTimes: isRecord(rawValue.metricFieldTimes) ? Object.fromEntries(Object.entries(rawValue.metricFieldTimes).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {},
    metricComparisons: isRecord(rawValue.metricComparisons) ? rawValue.metricComparisons as Record<string, LiveMetricComparison> : {},
    latestTranscript,
    recentTranscripts: normalizeSpeech(rawValue.recentTranscripts),
    source: {
      status: normalizeSourceStatus(source.status),
      ...(typeof source.overallHealth === "string" ? { overallHealth: source.overallHealth } : {}),
      ...(normalizeGroupHealth(source.groups).length ? { groups: normalizeGroupHealth(source.groups) } : {}),
      ...(typeof source.lastMetricAt === "string" ? { lastMetricAt: source.lastMetricAt } : {}),
      mappingVersion: stringValue(source.mappingVersion, "unknown"),
      firstMetricTimedOut: source.firstMetricTimedOut === true,
      coverage: {
        core: normalizeCoverageGroup(sourceCoverage.core),
        fiveMinute: normalizeCoverageGroup(sourceCoverage.fiveMinute),
        product: normalizeCoverageGroup(sourceCoverage.product)
      }
    },
    audio: {
      status: audio.status === "connecting" || audio.status === "active" || audio.status === "stale" || audio.status === "offline" || audio.status === "error" ? audio.status : "not_started",
      transcriptionStatus: audio.transcriptionStatus === "waiting_final" || audio.transcriptionStatus === "active" || audio.transcriptionStatus === "stale" || audio.transcriptionStatus === "offline" || audio.transcriptionStatus === "error" ? audio.transcriptionStatus : "not_started",
      ...(typeof audio.lastAudioAt === "string" ? { lastAudioAt: audio.lastAudioAt } : {}),
      ...(typeof audio.lastFinalAt === "string" ? { lastFinalAt: audio.lastFinalAt } : {}),
      finalCount: typeof audio.finalCount === "number" ? audio.finalCount : 0,
      audioFrames: typeof audio.audioFrames === "number" ? audio.audioFrames : 0,
      nonSilentAudioFrames: typeof audio.nonSilentAudioFrames === "number" ? audio.nonSilentAudioFrames : 0,
      energyBand: audio.energyBand === "silent" || audio.energyBand === "low" || audio.energyBand === "normal" ? audio.energyBand : "unknown",
      firstFinalTimedOut: audio.firstFinalTimedOut === true,
      ...(typeof audio.errorCode === "string" ? { errorCode: audio.errorCode } : {})
    },
    action: isRecord(rawValue.action) ? rawValue.action as LiveAction : null,
    actionEvidence: isRecord(rawValue.actionEvidence) ? rawValue.actionEvidence as LiveActionEvidence : null,
    actionHistory: Array.isArray(rawValue.actionHistory) ? rawValue.actionHistory.filter(isRecord) as LiveAction[] : [],
    eventMarkers: Array.isArray(rawValue.eventMarkers) ? rawValue.eventMarkers.filter(isRecord) as Array<{ at: string; type: string; label: string }> : [],
    hourVsBaseline: normalizeHourVsBaseline(rawValue.hourVsBaseline),
    diagnosis: normalizeDiagnosis(rawValue.diagnosis),
    productRole: rawValue.productRole === "trial_acquisition" || rawValue.productRole === "value_bundle" || rawValue.productRole === "repeat_purchase" || rawValue.productRole === "welfare_item"
      ? rawValue.productRole
      : "unknown",
    ...(isRecord(rawValue.sourceGroupHealth) ? {
      sourceGroupHealth: {
        qianchuan: {
          overallHealth: isRecord(rawValue.sourceGroupHealth.qianchuan) && typeof rawValue.sourceGroupHealth.qianchuan.overallHealth === "string" ? rawValue.sourceGroupHealth.qianchuan.overallHealth : "unknown",
          groups: normalizeGroupHealth(isRecord(rawValue.sourceGroupHealth.qianchuan) ? rawValue.sourceGroupHealth.qianchuan.groups : [])
        },
        compass: {
          overallHealth: isRecord(rawValue.sourceGroupHealth.compass) && typeof rawValue.sourceGroupHealth.compass.overallHealth === "string" ? rawValue.sourceGroupHealth.compass.overallHealth : "unknown",
          groups: normalizeGroupHealth(isRecord(rawValue.sourceGroupHealth.compass) ? rawValue.sourceGroupHealth.compass.groups : [])
        }
      }
    } : {}),
    ...(isRecord(rawValue.pageRuntimeState) ? (() => {
      const qianchuanRuntime = normalizePageRuntime(rawValue.pageRuntimeState.qianchuan);
      const compassRuntime = normalizePageRuntime(rawValue.pageRuntimeState.compass);
      return qianchuanRuntime || compassRuntime ? {
        pageRuntimeState: {
          ...(qianchuanRuntime ? { qianchuan: qianchuanRuntime } : {}),
          ...(compassRuntime ? { compass: compassRuntime } : {})
        }
      } : {};
    })() : {}),
    ...(Array.isArray(rawValue.recoveryHistory) ? {
      recoveryHistory: rawValue.recoveryHistory.flatMap((item) => {
        if (!isRecord(item) || (item.source !== "qianchuan" && item.source !== "compass") || typeof item.action !== "string" || typeof item.outcome !== "string" || typeof item.attemptedAt !== "string" || typeof item.reason !== "string") return [];
        return [{
          source: item.source,
          action: item.action,
          outcome: item.outcome,
          attemptedAt: item.attemptedAt,
          reason: item.reason,
          ...(typeof item.recoveredAt === "string" ? { recoveredAt: item.recoveredAt } : {})
        }];
      })
    } : {}),
    ...(isRecord(rawValue.pendingRecovery) && (rawValue.pendingRecovery.source === "qianchuan" || rawValue.pendingRecovery.source === "compass") && typeof rawValue.pendingRecovery.requestedAt === "string"
      ? { pendingRecovery: { source: rawValue.pendingRecovery.source, requestedAt: rawValue.pendingRecovery.requestedAt, confirm: rawValue.pendingRecovery.confirm === true } }
      : {}),
    ...(typeof rawValue.lastRecoveredAt === "string" ? { lastRecoveredAt: rawValue.lastRecoveredAt } : {}),
    recovering: rawValue.recovering === true
  };
}

function time(value?: string): string { return value ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "未更新"; }
export function monitoredDuration(startedAt?: string, nowMs = Date.now()): string {
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return "时长待更新";
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  return hours > 0 ? `${hours}小时${minutes}分` : `${minutes}分钟`;
}
const MISSING_VALUE = "本场尚未获取";
export const UNCOLLECTED_VALUE = "未采集";
export const SAMPLE_INSUFFICIENT_LABEL = "样本不足";
export const NO_SAMPLE_LABEL = "无样本";
export const HOUR_GRAIN_LABEL = "对照平时这个点";
const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
export const WAITING_MINUTE_BASELINE_NOTE = "待形成1分钟基线";
export const WAITING_SHARED_WINDOW_NOTE = "待形成共同1分钟窗口";
export const WAITING_QUARTER_BASELINE_NOTE = "待形成15分钟基线";
const QIANCHUAN_BACKGROUND_NOTE = "千川页面在后台会停止拉数。请在千川标签打开扩展侧栏看副驾，并保持该窗口可见；双屏时把千川放在另一块屏。完全隐藏的标签无法继续采集。";
const QIANCHUAN_API_RETRY_NOTE = "千川官方接口暂未更新，服务端正在自动重试；无需打开或刷新千川页面。";

export function qianchuanOfficialApiStatusLabel(status?: QianchuanOfficialApiStatus): string | undefined {
  if (!status) return undefined;
  if (!status.configured || status.state === "not_configured") return "未配置";
  const code = status.lastErrorCode && QIANCHUAN_SAFE_ERROR_CODE.test(status.lastErrorCode) ? status.lastErrorCode : undefined;
  if (code === "QIANCHUAN_NOT_CONFIGURED") return "未配置";
  if (code === "QIANCHUAN_NO_LIVING_ROOM") return "没有正在直播房间";
  if (code === "QIANCHUAN_HTTP_401" || code === "QIANCHUAN_TOOL_40102") return "授权失效";
  if (code === "QIANCHUAN_HTTP_403" || code === "QIANCHUAN_TOOL_40103" || code === "QIANCHUAN_LIVE_ANCHOR_UNAUTHORIZED_ID") return "权限不足";
  if (code === "QIANCHUAN_NETWORK_FAILED" || /^QIANCHUAN_HTTP_(408|429|5\d\d)$/.test(code ?? "")) return "网络失败";
  if (code === "QIANCHUAN_EMPTY_RESPONSE") return "接口返回为空";
  if (status.state === "idle") return "等待首读";
  if (status.state === "healthy") return "正常";
  if (status.state === "stale") return "等待更新";
  if (code === "QIANCHUAN_STRICT_TLS_REQUIRED") return "接口配置错误";
  if (code) return `接口读取失败（${code.replace(/^QIANCHUAN_/, "")}）`;
  return "接口读取失败";
}

function qianchuanStatusForDisplay(view: LiveView): LiveSourceStatus {
  return view.qianchuan.status;
}
const SHORT_WINDOW_MS = 60_000;
const SHORT_WINDOW_DRIFT_MS = 30_000;
// Short-window tolerance accepts near-minute polling while rejecting substantially shorter deltas.
const SHORT_WINDOW_MIN_AGE_MS = 45_000;
const SHORT_WINDOW_MAX_AGE_MS = SHORT_WINDOW_MS + SHORT_WINDOW_DRIFT_MS;
const TREND_WINDOW_MS = 15 * 60_000;
const TREND_WINDOW_DRIFT_MS = 2 * 60_000;
const TREND_WINDOW_MIN_FULL_AGE_MS = TREND_WINDOW_MS - TREND_WINDOW_DRIFT_MS;
const TREND_WINDOW_MAX_FULL_AGE_MS = TREND_WINDOW_MS + TREND_WINDOW_DRIFT_MS;
// 消耗分片不得作其他字段过期时钟。字段相对 now 超过约 5 分钟没出现才「字段待更新」，以兼容千川大屏后台节流时完整 Totals 暂停、消耗仍继续。见 D030。
const FIELD_OBSERVATION_TTL_MS = 5 * 60_000;
function qianchuanFieldStaleVsNow(observedAtMs: number, nowMs: number): boolean {
  return nowMs - observedAtMs > FIELD_OBSERVATION_TTL_MS;
}
function money(value?: number, missing = MISSING_VALUE): string { return value === undefined ? missing : `¥${(value / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
export function formatFenAsYuan(fen?: number, missing = UNCOLLECTED_VALUE): string {
  return fen === undefined ? missing : `¥${(fen / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function value(value?: number, missing = MISSING_VALUE): string { return value === undefined ? missing : value.toLocaleString("zh-CN"); }
export function formatWatchDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return MISSING_VALUE;
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return minutes > 0 ? remainder > 0 ? `${minutes}分${remainder}秒` : `${minutes}分` : `${remainder}秒`;
}
function rate(value?: number): string { return value === undefined ? MISSING_VALUE : `${value.toFixed(2)}%`; }
function qianchuanValue(metric?: QianchuanMetricValue): string {
  if (!metric) return MISSING_VALUE;
  if (metric.unit === "元") return `¥${metric.value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (metric.unit === "%") return `${metric.value.toFixed(2)}%`;
  if (metric.unit === "unknown") return metric.value.toLocaleString("zh-CN");
  return `${metric.value.toLocaleString("zh-CN")}${metric.unit}`;
}
export type QianchuanDelta = { status: "ready" | "baseline" | "reset" | "missing"; value?: number; note: string };
type QianchuanTimestampGroup = { observedAt: string; observedAtMs: number; snapshots: QianchuanMetric[] };
type QianchuanFieldState = { status: "missing" | "ok" | "conflict"; value?: QianchuanMetricValue };
function qianchuanTimestampGroups(history: QianchuanMetric[], nowMs: number): QianchuanTimestampGroup[] {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ordered = history.filter((item) => item.metricSource === "qianchuan" && item.dataStatus === "fresh" && Number.isFinite(Date.parse(item.observedAt)) && Date.parse(item.observedAt) <= safeNow).slice().sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  return ordered.reduce<QianchuanTimestampGroup[]>((groups, snapshot) => {
    const observedAtMs = Date.parse(snapshot.observedAt);
    const current = groups.at(-1);
    if (current?.observedAtMs === observedAtMs) current.snapshots.push(snapshot);
    else groups.push({ observedAt: snapshot.observedAt, observedAtMs, snapshots: [snapshot] });
    return groups;
  }, []);
}
function qianchuanFieldAtTimestamp(group: QianchuanTimestampGroup, key: keyof QianchuanMetric["metrics"]): QianchuanFieldState {
  const values = group.snapshots.flatMap((snapshot) => snapshot.metrics[key] ? [snapshot.metrics[key]!] : []);
  if (!values.length) return { status: "missing" };
  const first = values[0];
  if (!first) return { status: "missing" };
  const conflict = values.some((value) => value.value !== first.value || value.unit !== first.unit || value.semantic !== first.semantic || value.sourceField !== first.sourceField);
  return conflict ? { status: "conflict" } : { status: "ok", value: first };
}
function qianchuanConflictDelta(): QianchuanDelta { return { status: "baseline", note: "同时间数据冲突" }; }
function qianchuanZeroDelta(unit: QianchuanMetricValue["unit"]): QianchuanDelta {
  if (unit === "元") return { status: "ready", value: 0, note: "近1分钟变化 +¥0.00" };
  return { status: "ready", value: 0, note: `近1分钟变化 +0${unit}` };
}
function qianchuanZeroWindowDelta(unit: QianchuanMetricValue["unit"]): QianchuanDelta {
  if (unit === "元") return { status: "ready", value: 0, note: "近15分钟累计 +¥0.00" };
  return { status: "ready", value: 0, note: `近15分钟累计 +0${unit}` };
}
function qianchuanWindowNote(ageMs: number, unit: QianchuanMetricValue["unit"], delta: number): string {
  const full = ageMs >= TREND_WINDOW_MIN_FULL_AGE_MS && ageMs <= TREND_WINDOW_MAX_FULL_AGE_MS;
  const minutes = full ? 15 : Math.max(1, Math.round(ageMs / 60_000));
  const windowLabel = `近${minutes}分钟累计`;
  if (unit === "元") return `${windowLabel} +¥${delta.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${windowLabel} +${delta.toLocaleString("zh-CN")}${unit}`;
}
function compatibleCumulative(candidate: QianchuanMetricValue | undefined, latest: QianchuanMetricValue): boolean {
  return Boolean(candidate && candidate.semantic === "cumulative" && candidate.unit === latest.unit && candidate.sourceField === latest.sourceField);
}
function latestQianchuanField(history: QianchuanMetric[], key: keyof QianchuanMetric["metrics"], nowMs: number): {
  groups: QianchuanTimestampGroup[];
  latestGroupIndex: number;
  latestGroup: QianchuanTimestampGroup | undefined;
  latestState: QianchuanFieldState;
} {
  const groups = qianchuanTimestampGroups(history, nowMs);
  let latestGroupIndex = -1;
  let latestGroup: QianchuanTimestampGroup | undefined;
  let latestState: QianchuanFieldState = { status: "missing" };
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const candidateState = qianchuanFieldAtTimestamp(groups[index]!, key);
    if (candidateState.status === "missing") continue;
    latestGroupIndex = index;
    latestGroup = groups[index];
    latestState = candidateState;
    break;
  }
  return { groups, latestGroupIndex, latestGroup, latestState };
}
export function trendWindowUnit(delta: QianchuanDelta, kind: "count" | "money", watchNote = false): string {
  if (delta.status === "ready" && delta.note.startsWith("近")) {
    const windowPart = delta.note.replace(/\s+\+.+$/, "");
    if (kind === "money") return `千川${windowPart} · 元`;
    if (watchNote) return `千川${windowPart}，非去重进入人数`;
    return `千川${windowPart}`;
  }
  return delta.note;
}
export function formatQianchuanDeltaDisplay(delta: QianchuanDelta, kind: "count" | "money" = "count"): string {
  if (delta.status === "ready" && delta.value !== undefined) {
    if (kind === "money") return `¥${delta.value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return delta.value.toLocaleString("zh-CN");
  }
  return delta.note;
}
export function liveMetricPrimaryClass(display: string): string {
  return /^(¥?-?[\d,.]+%?)$/.test(display) ? "live-pilot-metric-value" : "live-pilot-metric-copy";
}

export type CopilotHeaderPayment = { label: string; display: string; source: "qianchuan" | "compass" | "missing" };
export type CopilotOnlineSnapshot = { value?: number; note: string };

export function copilotHeaderPayment(options: { compassFen?: number | undefined; qianchuanGmv?: QianchuanMetricValue | undefined }): CopilotHeaderPayment {
  const qianchuanDisplay = options.qianchuanGmv ? qianchuanValue(options.qianchuanGmv) : undefined;
  if (qianchuanDisplay && qianchuanDisplay !== MISSING_VALUE) return { label: "千川成交", display: qianchuanDisplay, source: "qianchuan" };
  if (options.compassFen !== undefined) return { label: "罗盘累计支付", display: money(options.compassFen, UNCOLLECTED_VALUE), source: "compass" };
  return { label: "本场GMV", display: UNCOLLECTED_VALUE, source: "missing" };
}

export function hourBaselineSampleLabel(baseline: HourBaselineStatus): string {
  if (baseline.status === "ok") return `对照 ${baseline.n} 场`;
  if (baseline.reason === "no_complete_samples" || baseline.n === 0) return NO_SAMPLE_LABEL;
  return `仅 ${baseline.n} 场，不够出平时`;
}

export type HourMonitorPace = {
  minutes: number;
  startedMidHour: boolean;
  comparable: boolean;
  scaleBaseline: boolean;
};

const CLOCK_HOUR_MS = 3_600_000;
const SHANGHAI_OFFSET_MS = 480 * 60_000;
const FULL_HOUR_COMPARE_MINUTES = 55;
const MIN_HOUR_COMPARE_MINUTES = 3;

export function hourMonitorPace(sessionStartedAt: string | undefined, nowMs = Date.now()): HourMonitorPace {
  const localMs = nowMs + SHANGHAI_OFFSET_MS;
  const hourStartMs = Math.floor(localMs / CLOCK_HOUR_MS) * CLOCK_HOUR_MS - SHANGHAI_OFFSET_MS;
  const hourEndMs = hourStartMs + CLOCK_HOUR_MS;
  const parsedStart = sessionStartedAt ? Date.parse(sessionStartedAt) : Number.NaN;
  const sessionStartMs = Number.isFinite(parsedStart) ? parsedStart : hourStartMs;
  const fromMs = Math.min(Math.max(sessionStartMs, hourStartMs), hourEndMs);
  const toMs = Math.min(Math.max(nowMs, hourStartMs), hourEndMs);
  const minutes = Math.min(60, Math.max(0, Math.round((toMs - fromMs) / 60_000)));
  return {
    minutes,
    startedMidHour: sessionStartMs > hourStartMs + 60_000,
    comparable: minutes >= MIN_HOUR_COMPARE_MINUTES,
    scaleBaseline: minutes < FULL_HOUR_COMPARE_MINUTES
  };
}

function scaledHourBand(liveValue: number, p25: number, p75: number): { band: "above_p75" | "within_iqr" | "below_p25"; bandLabel: string } {
  if (liveValue > p75) return { band: "above_p75", bandLabel: "高于这时长的平时节奏" };
  if (liveValue < p25) return { band: "below_p25", bandLabel: "低于这时长的平时节奏" };
  return { band: "within_iqr", bandLabel: "接近这时长的平时节奏" };
}

export function formatHourComparison(metric: LiveHourComparisonMetric, pace?: HourMonitorPace): { liveDisplay: string; vsDisplay: string; note: string; bandLabel: string } {
  const liveMissing = metric.liveStatus === "missing" || metric.liveValue === undefined;
  if (liveMissing && metric.liveCoverage === "hour_to_date" && metric.metricKey !== "onlineSnapshot") {
    return { liveDisplay: "待形成", vsDisplay: "本小时时段还在形成", note: "不拿整场累计冒充这个钟点", bandLabel: "" };
  }
  const liveDisplay = liveMissing
    ? UNCOLLECTED_VALUE
    : metric.metricKey === "onlineSnapshot" ? value(metric.liveValue, UNCOLLECTED_VALUE) : formatFenAsYuan(metric.liveValue);
  const sample = hourBaselineSampleLabel(metric.baseline);
  if (metric.baseline.status !== "ok") {
    return { liveDisplay, vsDisplay: sample, note: `${HOUR_GRAIN_LABEL}，先不拿历史比高低`, bandLabel: "" };
  }
  if (metric.metricKey !== "onlineSnapshot" && pace && !pace.comparable) {
    return { liveDisplay, vsDisplay: `已监测 ${pace.minutes} 分钟，先不比高低`, note: "监测太短，不拿完整小时比", bandLabel: "" };
  }
  if (metric.metricKey !== "onlineSnapshot" && pace?.scaleBaseline && pace.comparable) {
    const fraction = pace.minutes / 60;
    const scaledMedian = Math.round(metric.baseline.median * fraction);
    const scaledP25 = Math.round(metric.baseline.p25 * fraction);
    const scaledP75 = Math.round(metric.baseline.p75 * fraction);
    const band = liveMissing || metric.liveValue === undefined
      ? { bandLabel: "" }
      : scaledHourBand(metric.liveValue, scaledP25, scaledP75);
    return {
      liveDisplay,
      vsDisplay: `已监测 ${pace.minutes} 分钟 · 按这个时长平时大约 ${formatFenAsYuan(scaledMedian)}`,
      note: `${band.bandLabel ? `${band.bandLabel} · ` : ""}不是完整小时 · ${sample}`,
      bandLabel: band.bandLabel
    };
  }
  const median = metric.metricKey === "onlineSnapshot" ? value(metric.baseline.median, UNCOLLECTED_VALUE) : formatFenAsYuan(metric.baseline.median);
  const bandLabel = metric.band === "above_p75" ? "高于同期" : metric.band === "below_p25" ? "低于同期" : "处于同期区间";
  return { liveDisplay, vsDisplay: `平时大约 ${median}`, note: `${bandLabel} · ${sample}`, bandLabel };
}

export function formatActionDealEvidence(snapshot: LiveMetric | null): string {
  if (!snapshot) return "未读取到触发时数据";
  const sessionGmv = snapshot.sessionPaidGmvFen ?? snapshot.productPaidGmvFen;
  const productPay = snapshot.productPayGmvFen;
  const gmv = sessionGmv ?? productPay;
  return `GMV ${formatFenAsYuan(gmv)} · 当前商品支付 ${formatFenAsYuan(productPay)} · 点击 ${value(snapshot.productClickCount, UNCOLLECTED_VALUE)}`;
}

export function clockHourLabel(weekday: number, hour: number): string {
  const day = WEEKDAY_LABELS[weekday] ?? String(weekday);
  const next = (hour + 1) % 24;
  return `周${day} ${String(hour).padStart(2, "0")}:00–${String(next).padStart(2, "0")}:00`;
}
export function clockHourSlotLabel(weekday: number, hour: number): string {
  const day = WEEKDAY_LABELS[weekday] ?? String(weekday);
  return `周${day} ${hour}点`;
}

export function operatorDiagnosisAnomalies(diagnosis: DiagnosisWindow): DiagnosisWindow["anomalies"] {
  return diagnosis.anomalies.filter((item) => item.type !== "counter_reset" && !diagnosis.conclusions.some((finding) => finding.id === `anomaly:${item.type}`));
}

export const QIANCHUAN_FUNNEL_STAGES = [
  { key: "liveImpressions", label: "曝光" },
  { key: "liveWatchCount", label: "观看" },
  { key: "productImpressions", label: "商品曝光" },
  { key: "productClicks", label: "商品点击" },
  { key: "paidOrderCount", label: "成交" }
] as const;

export const QIANCHUAN_FUNNEL_RATE_STEPS = [
  { key: "impressionClick", label: "曝光点击率", formula: "观看 ÷ 曝光", numeratorKey: "liveWatchCount", denominatorKey: "liveImpressions", numeratorLabel: "观看", denominatorLabel: "曝光" },
  { key: "productShowClick", label: "商品曝光点击率", formula: "商品点击 ÷ 商品曝光", numeratorKey: "productClicks", denominatorKey: "productImpressions", numeratorLabel: "商品点击", denominatorLabel: "商品曝光" },
  { key: "productClickConvert", label: "商品点击转化率", formula: "成交订单 ÷ 商品点击", numeratorKey: "paidOrderCount", denominatorKey: "productClicks", numeratorLabel: "成交订单", denominatorLabel: "商品点击" }
] as const;

export type QianchuanFunnelStage = { key: typeof QIANCHUAN_FUNNEL_STAGES[number]["key"]; label: string; display: string };
export type QianchuanFunnelRate = {
  key: typeof QIANCHUAN_FUNNEL_RATE_STEPS[number]["key"];
  label: string;
  formula: string;
  display: string;
  note: string;
  percent?: number;
  weak: boolean;
};
export type QianchuanFourRateFunnel = { source: "qianchuan"; stages: QianchuanFunnelStage[]; rates: QianchuanFunnelRate[]; note: string };

function qianchuanCountValue(metric?: QianchuanMetricValue): number | undefined {
  if (!metric || !Number.isFinite(metric.value) || metric.value < 0) return undefined;
  return metric.value;
}

function formatFunnelPercent(ratio: number): string {
  return `${(ratio * 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function formatFunnelCount(value: number, unit: QianchuanMetricValue["unit"]): string {
  const formatted = value.toLocaleString("zh-CN");
  if (unit === "unknown") return formatted;
  return `${formatted}${unit}`;
}

/** 三率只用来自同一张千川快照的累计次数现算，不用罗盘补，缺字段不写成 0%。 */
export function qianchuanFourRateFunnel(latest?: QianchuanMetric | null): QianchuanFourRateFunnel {
  const metrics = latest?.metrics ?? {};
  const stages = QIANCHUAN_FUNNEL_STAGES.map((stage) => {
    const metric = metrics[stage.key];
    const value = qianchuanCountValue(metric);
    return {
      key: stage.key,
      label: stage.label,
      display: value === undefined ? UNCOLLECTED_VALUE : formatFunnelCount(value, metric?.unit ?? "次")
    };
  });
  const rates = QIANCHUAN_FUNNEL_RATE_STEPS.map((step) => {
    const numerator = qianchuanCountValue(metrics[step.numeratorKey]);
    const denominator = qianchuanCountValue(metrics[step.denominatorKey]);
    if (numerator === undefined || denominator === undefined) {
      return { key: step.key, label: step.label, formula: step.formula, display: UNCOLLECTED_VALUE, note: `${step.formula} · 千川未齐，不写成 0%`, weak: false };
    }
    if (denominator === 0) {
      return { key: step.key, label: step.label, formula: step.formula, display: "还算不了", note: `${step.denominatorLabel}是 0，不写成 0%`, weak: false };
    }
    const percent = (numerator / denominator) * 100;
    const overHundred = percent > 100 ? " · 次数口径，可能超过100%" : "";
    return {
      key: step.key,
      label: step.label,
      formula: step.formula,
      display: formatFunnelPercent(numerator / denominator),
      note: `${step.numeratorLabel} ${formatFunnelCount(numerator, metrics[step.numeratorKey]?.unit ?? "次")} ÷ ${step.denominatorLabel} ${formatFunnelCount(denominator, metrics[step.denominatorKey]?.unit ?? "次")}${overHundred}`,
      percent,
      weak: false
    };
  });
  const comparable = rates.filter((item) => item.percent !== undefined);
  const weakest = comparable.length >= 2 ? Math.min(...comparable.map((item) => item.percent ?? Number.POSITIVE_INFINITY)) : undefined;
  return {
    source: "qianchuan",
    stages,
    rates: rates.map((item) => ({ ...item, weak: weakest !== undefined && item.percent === weakest })),
    note: latest ? "千川本场累计次数现算，不用罗盘" : "千川未连接，等待更新"
  };
}

export function copilotOnlineSnapshot(options: { compassOnline?: number | undefined; qianchuanOnline?: number | undefined }): CopilotOnlineSnapshot {
  if (options.qianchuanOnline !== undefined) return { value: options.qianchuanOnline, note: "千川实时在线" };
  if (options.compassOnline !== undefined) return { value: options.compassOnline, note: "罗盘实时在线" };
  return { note: "本场尚未获取" };
}
export function qianchuanSlotDelta(history: QianchuanMetric[], key: keyof QianchuanMetric["metrics"], lastKnown: QianchuanMetric | null | undefined, sourceStatus: LiveView["qianchuan"]["status"], nowMs = Date.now()): QianchuanDelta {
  const computed = qianchuanDeltaWithLastKnown(history, key, lastKnown, nowMs);
  if (sourceStatus === "fresh") return computed;
  if (computed.status === "ready" || computed.status === "baseline" || computed.status === "reset") return computed;
  return { status: "missing", note: qianchuanStatusLabel(sourceStatus) };
}
export function formatClickToPaidDisplay(window: QianchuanClickToPaidWindow): string {
  if (window.status === "ready") return window.clicks === 0 ? "不适用" : rate(window.rate);
  if (window.status === "baseline" && window.note === WAITING_SHARED_WINDOW_NOTE) return "0.00%";
  return window.note;
}
export function qianchuanClickToPaidSlot(history: QianchuanMetric[], sourceStatus: LiveView["qianchuan"]["status"], nowMs = Date.now()): QianchuanClickToPaidWindow {
  const computed = qianchuanClickToPaidWindow(history, nowMs);
  if (sourceStatus === "fresh") return computed;
  if (computed.status === "ready" || computed.status === "baseline" || computed.status === "reset") return computed;
  return { status: "missing", note: qianchuanStatusLabel(sourceStatus) };
}
export function qianchuanDelta(history: QianchuanMetric[], key: keyof QianchuanMetric["metrics"], nowMs = Date.now()): QianchuanDelta {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const { groups, latestGroupIndex, latestGroup, latestState } = latestQianchuanField(history, key, safeNow);
  if (latestState.status === "conflict") return qianchuanConflictDelta();
  const latestValue = latestState.value;
  if (!latestGroup || latestState.status === "missing" || !latestValue || latestValue.semantic !== "cumulative") return { status: "missing", note: latestGroup ? "字段待更新" : MISSING_VALUE };
  if (qianchuanFieldStaleVsNow(latestGroup.observedAtMs, safeNow)) return { status: "missing", note: "字段待更新" };
  const latestObservedAt = latestGroup.observedAtMs;
  let baseline: QianchuanMetricValue | undefined;
  for (const candidateGroup of groups.slice(0, latestGroupIndex).reverse()) {
    const ageMs = latestObservedAt - candidateGroup.observedAtMs;
    if (ageMs < SHORT_WINDOW_MIN_AGE_MS || ageMs > SHORT_WINDOW_MAX_AGE_MS) continue;
    const candidateState = qianchuanFieldAtTimestamp(candidateGroup, key);
    if (candidateState.status === "conflict") return qianchuanConflictDelta();
    const candidate = candidateState.value;
    if (compatibleCumulative(candidate, latestValue)) {
      baseline = candidate;
      break;
    }
  }
  if (!baseline) {
    if (latestValue.value === 0) return qianchuanZeroDelta(latestValue.unit);
    return { status: "baseline", note: WAITING_MINUTE_BASELINE_NOTE };
  }
  const delta = latestValue.value - baseline.value;
  if (delta < 0) return { status: "reset", note: "基线已重置" };
  if (latestValue.unit === "元") return { status: "ready", value: delta, note: `近1分钟变化 +¥${delta.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` };
  return { status: "ready", value: delta, note: `近1分钟变化 +${delta.toLocaleString("zh-CN")}${latestValue.unit}` };
}
export function qianchuanWindowDelta(history: QianchuanMetric[], key: keyof QianchuanMetric["metrics"], nowMs = Date.now()): QianchuanDelta {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const { groups, latestGroupIndex, latestGroup, latestState } = latestQianchuanField(history, key, safeNow);
  if (latestState.status === "conflict") return qianchuanConflictDelta();
  const latestValue = latestState.value;
  if (!latestGroup || latestState.status === "missing" || !latestValue || latestValue.semantic !== "cumulative") return { status: "missing", note: latestGroup ? "字段待更新" : MISSING_VALUE };
  if (qianchuanFieldStaleVsNow(latestGroup.observedAtMs, safeNow)) return { status: "missing", note: "字段待更新" };
  const latestObservedAt = latestGroup.observedAtMs;
  let fullBaseline: { ageMs: number; metric: QianchuanMetricValue } | undefined;
  let partialBaseline: { ageMs: number; metric: QianchuanMetricValue } | undefined;
  for (const candidateGroup of groups.slice(0, latestGroupIndex)) {
    const ageMs = latestObservedAt - candidateGroup.observedAtMs;
    if (ageMs < SHORT_WINDOW_MIN_AGE_MS || ageMs > TREND_WINDOW_MAX_FULL_AGE_MS) continue;
    const candidateState = qianchuanFieldAtTimestamp(candidateGroup, key);
    if (candidateState.status === "conflict") return qianchuanConflictDelta();
    const candidate = candidateState.value;
    if (!compatibleCumulative(candidate, latestValue) || !candidate) continue;
    if (ageMs >= TREND_WINDOW_MIN_FULL_AGE_MS) {
      if (!fullBaseline || Math.abs(ageMs - TREND_WINDOW_MS) < Math.abs(fullBaseline.ageMs - TREND_WINDOW_MS)) {
        fullBaseline = { ageMs, metric: candidate };
      }
    } else if (!partialBaseline || ageMs > partialBaseline.ageMs) {
      partialBaseline = { ageMs, metric: candidate };
    }
  }
  const picked = fullBaseline ?? partialBaseline;
  if (!picked) {
    if (latestValue.value === 0) return qianchuanZeroWindowDelta(latestValue.unit);
    return { status: "baseline", note: WAITING_QUARTER_BASELINE_NOTE };
  }
  const delta = latestValue.value - picked.metric.value;
  if (delta < 0) return { status: "reset", note: "基线已重置" };
  return { status: "ready", value: delta, note: qianchuanWindowNote(picked.ageMs, latestValue.unit, delta) };
}
export function qianchuanDeltaWithLastKnown(history: QianchuanMetric[], key: keyof QianchuanMetric["metrics"], lastKnown: QianchuanMetric | null | undefined, nowMs = Date.now()): QianchuanDelta {
  const delta = qianchuanDelta(history, key, nowMs);
  if (delta.status !== "missing" || delta.note !== MISSING_VALUE) return delta;
  const last = lastKnown?.metrics[key];
  if (!last || last.semantic !== "cumulative") return delta;
  if (last.value === 0) return qianchuanZeroDelta(last.unit);
  return { status: "baseline", note: WAITING_MINUTE_BASELINE_NOTE };
}
export function lastKnownCompassNumber(latest: LiveMetric | null | undefined, history: LiveMetric[], key: keyof LiveMetric): number | undefined {
  const fromLatest = latest?.[key];
  if (typeof fromLatest === "number" && Number.isFinite(fromLatest)) return fromLatest;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = history[index]?.[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}
export function qianchuanBackgroundThrottleNote(history: QianchuanMetric[], latest: QianchuanMetric | null | undefined, status: LiveView["qianchuan"]["status"], nowMs = Date.now()): string | undefined {
  if (status !== "fresh" || !latest?.metrics.adSpend) return undefined;
  const groups = qianchuanTimestampGroups(history, nowMs);
  const lastAt = (key: keyof QianchuanMetric["metrics"]): number | undefined => {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (qianchuanFieldAtTimestamp(groups[index]!, key).status !== "missing") return groups[index]!.observedAtMs;
    }
    return undefined;
  };
  const spendAt = lastAt("adSpend");
  if (spendAt === undefined) return undefined;
  const tracked = ["productClicks", "paidOrderCount", "liveWatchCount"] as const;
  const acquired = tracked.filter((key) => lastAt(key) !== undefined || latest.metrics[key] !== undefined);
  if (!acquired.length) return undefined;
  const lagging = acquired.some((key) => {
    const observedAt = lastAt(key);
    return observedAt === undefined || spendAt - observedAt >= 90_000;
  });
  return lagging ? QIANCHUAN_BACKGROUND_NOTE : undefined;
}
export type QianchuanClickToPaidWindow = { status: "ready" | "baseline" | "reset" | "missing"; clicks?: number; paidOrders?: number; rate?: number; note: string };
export function qianchuanClickToPaidWindow(history: QianchuanMetric[], nowMs = Date.now()): QianchuanClickToPaidWindow {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const groups = qianchuanTimestampGroups(history, safeNow);
  let latestGroupIndex = -1;
  let latestGroup: QianchuanTimestampGroup | undefined;
  let latest: QianchuanMetric | undefined;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const candidateGroup = groups[index]!;
    const candidateClicksState = qianchuanFieldAtTimestamp(candidateGroup, "productClicks");
    const candidatePaidState = qianchuanFieldAtTimestamp(candidateGroup, "paidOrderCount");
    if (candidateClicksState.status === "conflict" || candidatePaidState.status === "conflict") return { status: "baseline", note: "同时间数据冲突" };
    const candidate = candidateGroup.snapshots.find((snapshot) => snapshot.metrics.productClicks && snapshot.metrics.paidOrderCount);
    if (!candidate) continue;
    latestGroupIndex = index;
    latestGroup = candidateGroup;
    latest = candidate;
    break;
  }
  if (!latestGroup) return { status: "missing", note: MISSING_VALUE };
  if (qianchuanFieldStaleVsNow(latestGroup.observedAtMs, safeNow)) return { status: "missing", note: "字段待更新" };
  const latestClicks = latest?.metrics.productClicks;
  const latestPaidOrders = latest?.metrics.paidOrderCount;
  if (!latest || !latestClicks || !latestPaidOrders || latestClicks.semantic !== "cumulative" || latestPaidOrders.semantic !== "cumulative") return { status: "missing", note: "字段待更新" };
  const compatible = (key: "productClicks" | "paidOrderCount", baseline: QianchuanMetric): boolean => {
    const baselineValue = baseline.metrics[key];
    const currentValue = latest.metrics[key];
    return Boolean(baselineValue && currentValue && baselineValue.semantic === "cumulative" && currentValue.semantic === "cumulative" && baselineValue.unit === currentValue.unit && baselineValue.sourceField === currentValue.sourceField);
  };
  const latestObservedAt = latestGroup.observedAtMs;
  let baseline: QianchuanMetric | undefined;
  for (const candidateGroup of groups.slice(0, latestGroupIndex).reverse()) {
    const ageMs = latestObservedAt - candidateGroup.observedAtMs;
    if (ageMs < SHORT_WINDOW_MIN_AGE_MS || ageMs > SHORT_WINDOW_MAX_AGE_MS) continue;
    const candidateClicksState = qianchuanFieldAtTimestamp(candidateGroup, "productClicks");
    const candidatePaidState = qianchuanFieldAtTimestamp(candidateGroup, "paidOrderCount");
    if (candidateClicksState.status === "conflict" || candidatePaidState.status === "conflict") return { status: "baseline", note: "同时间数据冲突" };
    const candidate = candidateGroup.snapshots.find((snapshot) => snapshot.metrics.productClicks && snapshot.metrics.paidOrderCount);
    if (candidate && compatible("productClicks", candidate) && compatible("paidOrderCount", candidate)) {
      baseline = candidate;
      break;
    }
  }
  if (!baseline) {
    if (latestClicks.value === 0 && latestPaidOrders.value === 0) return { status: "ready", clicks: 0, paidOrders: 0, note: "近1分钟点击为0，不适用" };
    return { status: "baseline", note: WAITING_SHARED_WINDOW_NOTE };
  }
  const clicks = latestClicks.value - baseline.metrics.productClicks!.value;
  const paidOrders = latestPaidOrders.value - baseline.metrics.paidOrderCount!.value;
  if (clicks < 0 || paidOrders < 0) return { status: "reset", note: "共同窗口基线已重置" };
  if (clicks === 0) return { status: "ready", clicks, paidOrders, note: "近1分钟点击为0，不适用" };
  return { status: "ready", clicks, paidOrders, rate: (paidOrders / clicks) * 100, note: "近1分钟共同窗口计算" };
}
export function selectQianchuanDeltaTrendPoints(history: QianchuanMetric[], key: keyof QianchuanMetric["metrics"], nowMs = Date.now(), anchorMs?: number): Array<{ observedAt: string; value: number }> {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const groups = qianchuanTimestampGroups(history, safeNow);
  const latestFieldGroup = [...groups].reverse().find((group) => qianchuanFieldAtTimestamp(group, key).status !== "missing");
  if (!latestFieldGroup || qianchuanFieldStaleVsNow(latestFieldGroup.observedAtMs, safeNow)) return [];
  const valid = groups.flatMap((group, index) => {
    if (qianchuanFieldAtTimestamp(group, key).status !== "ok") return [];
    const delta = qianchuanDelta(groups.slice(0, index + 1).flatMap((item) => item.snapshots), key, group.observedAtMs);
    return delta.status === "ready" && delta.value !== undefined ? [{ observedAt: group.observedAt, observedAtMs: group.observedAtMs, value: delta.value }] : [];
  });
  const anchor = anchorMs ?? valid.at(-1)?.observedAtMs;
  return anchor === undefined ? [] : valid.filter((item) => item.observedAtMs >= anchor - 15 * 60_000 && item.observedAtMs <= anchor).slice(-15).map(({ observedAt, value }) => ({ observedAt, value }));
}
export function selectTrendPoints(history: LiveMetric[], key: keyof LiveMetric, nowMs = Date.now(), anchorMs?: number): number[] {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const valid = history.flatMap((item) => {
    const observedAt = Date.parse(item.observedAt);
    const candidate = item[key];
    return Number.isFinite(observedAt) && observedAt <= safeNow && typeof candidate === "number" && Number.isFinite(candidate) ? [{ observedAt, value: candidate }] : [];
  }).sort((left, right) => left.observedAt - right.observedAt);
  const anchor = anchorMs ?? valid.at(-1)?.observedAt;
  return anchor === undefined ? [] : valid.filter((item) => item.observedAt >= anchor - 15 * 60_000 && item.observedAt <= anchor).slice(-15).map((item) => item.value);
}
export function selectQianchuanPaidTrendPoints(history: QianchuanMetric[], nowMs = Date.now(), anchorMs?: number): Array<{ observedAt: string; value: number }> {
  return selectQianchuanDeltaTrendPoints(history, "paidOrderCount", nowMs, anchorMs);
}
export function trendAnchorMs(metricHistory: LiveMetric[], qianchuanHistory: QianchuanMetric[], nowMs = Date.now()): number | undefined {
  const validNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const timestamps = [...metricHistory, ...qianchuanHistory].map((item) => Date.parse(item.observedAt)).filter((timestamp) => Number.isFinite(timestamp) && timestamp <= validNow);
  return timestamps.length ? Math.max(...timestamps) : undefined;
}
export function qianchuanStatusLabel(status: LiveView["qianchuan"]["status"]): string {
  return status === "fresh" ? "正常" : status === "partial" ? "部分停更" : status === "stale" ? "已超过90秒未更新" : status === "unknown" ? "未接入" : "已离线";
}

const GROUP_LABEL: Record<string, string> = {
  spend: "消耗",
  traffic: "流量漏斗",
  interest: "兴趣",
  conversion: "成交",
  efficiency: "效率",
  core: "经营",
  product: "商品",
  audio: "音频"
};

export function sourceGroupLine(group: LiveSourceGroupHealth, nowMs = Date.now()): string {
  const label = GROUP_LABEL[group.group] ?? group.group;
  if (group.status === "fresh" || group.status === "recovered") return `${label} 正常`;
  if (group.status === "recovering") return `${label} 恢复中`;
  if ((group.status === "stalled" || group.status === "suspected_stall") && group.lastSeenAt) {
    const minutes = Math.max(1, Math.round((nowMs - Date.parse(group.lastSeenAt)) / 60_000));
    return `${label} ${minutes}分钟前停止`;
  }
  if (group.status === "login_required") return `${label} 需要登录`;
  if (group.status === "offline") return `${label} 已离线`;
  if (group.status === "unknown" && group.group === "product") return "商品 等待讲解数据（只在讲解时更新）";
  return `${label} 未出现`;
}

export function liveSourceHeaderLabel(input: {
  status: LiveSourceStatus;
  overallHealth?: string | undefined;
  recovering?: boolean | undefined;
  needLogin?: boolean | undefined;
}): string {
  if (input.needLogin || input.overallHealth === "login_required") return "需要登录";
  if (input.recovering) return "恢复中";
  if (input.overallHealth === "partial" || input.status === "partial") return "部分停更";
  if (input.status === "fresh") return "正常";
  if (input.status === "stale") return "已超过阈值未更新";
  if (input.status === "unknown") return "未接入";
  return "已离线";
}
export function livePilotInterruptBanner(view: {
  session: { status: string };
  needsReconnect: boolean;
  source: { status: string };
  audio: { status: string };
}): string | null {
  if (view.session.status !== "running") return null;
  if (view.needsReconnect) {
    return "采集中断，待更新。配对仍有效，分享链接不用换；请在罗盘点「恢复上一场直播」，音频需再点一次采集。";
  }
  if ((view.source.status === "stale" || view.source.status === "offline")
    && (view.audio.status === "offline" || view.audio.status === "error" || view.audio.status === "not_started")) {
    return "采集中断，待更新。请在罗盘重新登录后点「恢复上一场直播」，分享链接不用换。";
  }
  return null;
}

const SENSITIVE_DIAG_KEYS = new Set([
  "pairtoken",
  "pair_token",
  "authorization",
  "ark_api_key",
  "tencent_asr_secret_key",
  "tencent_asr_secret_id",
  "secretkey",
  "secretid",
  "secret",
  "tabid",
  "cookie",
  "query"
]);

export function liveDiagExportFilename(sessionId: string): string {
  const prefix = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  return `live-diag-${prefix || "unknown"}.json`;
}

export function stripSensitiveDiagFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitiveDiagFields);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_DIAG_KEYS.has(key.toLowerCase())) continue;
    out[key] = stripSensitiveDiagFields(child);
  }
  return out;
}

export function buildLiveDiagExport(input: {
  sessionId: string;
  view: unknown;
  health?: unknown;
  exportedAt?: string;
}): { filename: string; payload: {
  exportedAt: string;
  sessionId: string;
  view: unknown;
  health?: unknown;
  sourceGroupHealth?: unknown;
  pageRuntimeState?: unknown;
  recoveryHistory?: unknown;
} } {
  const rawView = isRecord(input.view) ? input.view : {};
  const payload: {
    exportedAt: string;
    sessionId: string;
    view: unknown;
    health?: unknown;
    sourceGroupHealth?: unknown;
    pageRuntimeState?: unknown;
    recoveryHistory?: unknown;
  } = {
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    sessionId: input.sessionId,
    view: stripSensitiveDiagFields(input.view)
  };
  if (input.health !== undefined) payload.health = stripSensitiveDiagFields(input.health);
  if (rawView.sourceGroupHealth !== undefined) payload.sourceGroupHealth = stripSensitiveDiagFields(rawView.sourceGroupHealth);
  if (rawView.pageRuntimeState !== undefined) payload.pageRuntimeState = stripSensitiveDiagFields(rawView.pageRuntimeState);
  if (rawView.recoveryHistory !== undefined) payload.recoveryHistory = stripSensitiveDiagFields(rawView.recoveryHistory);
  return { filename: liveDiagExportFilename(input.sessionId), payload };
}

function issueLayer(view: LiveView): string {
  const kind = view.diagnosis?.actionKind;
  if (kind === "check_spend" || view.diagnosis?.funnelStage === "spend_spike") return "投放";
  if (kind === "traffic_quality") return "流量";
  if (kind === "retain") return "留存";
  if (kind === "click_cta") return "兴趣";
  if (kind === "close_gift" || kind === "close_price" || kind === "close_urgency") return "成交";
  return "暂无";
}

export function formatCitedNumber(item: DiagnosisCitedNumber): string {
  const rounded = Number.isInteger(item.value) ? item.value : Math.round(item.value * 100) / 100;
  return `${item.label} ${rounded.toLocaleString("zh-CN")}${item.unit}`;
}

export function collectDiagnosisCitations(diagnosis: DiagnosisWindow, limit = 6): DiagnosisCitedNumber[] {
  const seen = new Set<string>();
  const out: DiagnosisCitedNumber[] = [];
  for (const finding of [diagnosis.verdict, diagnosis.evidence[0], diagnosis.action, diagnosis.watchNext]) {
    for (const item of finding?.citedNumbers ?? []) {
      const key = `${item.label}\0${item.value}\0${item.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function CopyDiagnosisAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="live-pilot-copy-action" onClick={() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => undefined);
  }}>{copied ? "已复制" : "复制给主播"}</button>;
}
function headerTitle(embedded: boolean): string {
  return embedded ? "驾驶舱" : "直播实时驾驶舱";
}

const PRODUCT_ROLE_OPTIONS: Array<{ value: LiveProductRole; label: string }> = [
  { value: "unknown", label: "未指定" },
  { value: "trial_acquisition", label: "尝新品" },
  { value: "value_bundle", label: "套组" },
  { value: "repeat_purchase", label: "复购品" },
  { value: "welfare_item", label: "福利品" }
];

const DIAGNOSIS_TRIGGER_LABEL: Record<NonNullable<DiagnosisWindow["triggerType"]>, string> = {
  scheduled_15m: "固定15分钟",
  event_spend_spike: "消耗加快",
  event_traffic_drop: "观看下跌",
  event_click_no_pay: "点击未支付"
};

const DIAGNOSIS_INTERRUPT_LABEL: Record<NonNullable<DiagnosisWindow["interruptDecision"]>, string> = {
  interrupt: "打扰",
  observe: "不打扰",
  status_only: "仅状态"
};
export async function requestLiveSourceRecovery(apiBase: string, sessionId: string, source: "qianchuan" | "compass", confirm: boolean): Promise<void> {
  await fetch(`${apiBase}/api/live/sessions/${encodeURIComponent(sessionId)}/recovery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, action: "request_reload", confirm })
  });
}

function SourceHealthExtras({ view, sessionId }: { view: LiveView; sessionId: string }) {
  const qianchuanGroups = view.qianchuan.groups ?? view.sourceGroupHealth?.qianchuan.groups ?? [];
  const compassGroups = view.source.groups ?? view.sourceGroupHealth?.compass.groups ?? [];
  const needAudioReauth = view.pageRuntimeState?.compass?.topFrameLifecycle === "live" && (view.audio.status === "not_started" || view.audio.status === "offline");
  const qianchuanApiState = view.qianchuan.officialApi?.state;
  const qianchuanUnhealthy = view.qianchuan.sourceKind === "official_api"
    ? qianchuanApiState === "stale" || qianchuanApiState === "error"
    : view.qianchuan.status === "partial" || view.qianchuan.overallHealth === "partial" || view.qianchuan.overallHealth === "stalled";
  const showQianchuanRecover = view.qianchuan.sourceKind !== "official_api" && qianchuanUnhealthy;
  const showCompassRecover = view.source.status === "partial" || view.source.overallHealth === "partial" || view.source.overallHealth === "stalled";
  const recover = async (source: "qianchuan" | "compass") => {
    if (source === "compass" && !window.confirm("罗盘数据已停止更新。刷新会暂时中断音频和转写，刷新后需要重新授权音频。")) return;
    const backend = resolveLiveBackend(window.location);
    await requestLiveSourceRecovery(backend.api, sessionId, source, true);
  };
  return <div className="live-pilot-health-extra">
    {qianchuanGroups.length > 0 && <details className="live-pilot-group-health"><summary>千川各组</summary><ul>{qianchuanGroups.map((group) => <li key={`qc-${group.group}`}>{sourceGroupLine(group)}</li>)}</ul></details>}
    {compassGroups.length > 0 && <details className="live-pilot-group-health"><summary>罗盘各组</summary><ul>{compassGroups.map((group) => <li key={`cp-${group.group}`}>{sourceGroupLine(group)}</li>)}</ul></details>}
    {view.recovering && <small>正在恢复</small>}
    {view.lastRecoveredAt && <small>最近恢复 {time(view.lastRecoveredAt)}</small>}
    {view.qianchuan.sourceKind !== "official_api" && (view.pageRuntimeState?.qianchuan?.allowlistStatus === "login" || view.qianchuan.overallHealth === "login_required") && <small>需要登录</small>}
    {view.qianchuan.sourceKind === "official_api" && qianchuanApiState === "stale" && <small>官方接口自动重试中</small>}
    {view.qianchuan.sourceKind === "official_api" && qianchuanApiState === "error" && <small>官方接口读取失败，服务端会继续重试</small>}
    {needAudioReauth && <small>需要重新授权音频</small>}
    {showQianchuanRecover && <button type="button" className="live-pilot-recover" onClick={() => { void recover("qianchuan"); }}>刷新千川页面</button>}
    {showCompassRecover && <button type="button" className="live-pilot-recover" onClick={() => { void recover("compass"); }}>刷新并重新连接</button>}
  </div>;
}

export default function LivePilotPage() {
  const params = useParams<{ sessionId: string }>();
  const [view, setView] = useState<LiveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightTheme, setLightTheme] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  const chooseProductRole = async (role: LiveProductRole) => {
    if (!params.sessionId) return;
    setView((current) => current ? { ...current, productRole: role } : current);
    const backend = resolveLiveBackend(window.location);
    await fetch(`${backend.api}/api/live/sessions/${encodeURIComponent(params.sessionId)}/product-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, source: "operator" })
    });
  };
  useEffect(() => {
    try { setEmbedded(window.self !== window.top); } catch { setEmbedded(true); }
  }, []);
  useEffect(() => {
    if (!params.sessionId) return;
    let stopped = false;
    let pollTimer: number | undefined;
    const backend = resolveLiveBackend(window.location);
    const load = async () => {
      try {
        const response = await fetch(`${backend.api}/api/live/sessions/${encodeURIComponent(params.sessionId)}/view`, { cache: "no-store" });
        const body = await response.json() as unknown;
        if (!response.ok) {
          const errorMessage = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" ? body.error.message : "驾驶舱会话读取失败";
          throw new Error(errorMessage);
        }
        if (!stopped) {
          const nextView = normalizeLiveView(body);
          setView(nextView);
          setError(null);
        }
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : "驾驶舱会话读取失败"); }
    };
    const startPoll = () => {
      if (pollTimer !== undefined || stopped) return;
      pollTimer = window.setInterval(() => { void load(); }, 2000);
    };
    const stopPoll = () => {
      if (pollTimer === undefined) return;
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    };
    void load();
    const socket = new WebSocket(`${backend.ws}/ws/live-view/${encodeURIComponent(params.sessionId)}`);
    socket.addEventListener("open", () => { if (!stopped) stopPoll(); });
    socket.addEventListener("message", (event) => {
      try {
        const body = JSON.parse(String(event.data)) as { type?: string; view?: unknown; error?: string };
        if (body.type === "live.view" && body.view) {
          if (!stopped) {
            setView(normalizeLiveView(body.view));
            setError(null);
          }
          return;
        }
        if (body.type === "live.error" && body.error && !stopped) setError(body.error);
      } catch { if (!stopped) setError("实时状态读取失败"); }
    });
    socket.addEventListener("close", () => { if (!stopped) startPoll(); });
    socket.addEventListener("error", () => { if (!stopped) startPoll(); });
    startPoll();
    return () => { stopped = true; stopPoll(); socket.close(); };
  }, [params.sessionId]);

  const exportLiveDiagnosis = async () => {
    if (!params.sessionId || !view) return;
    let health: unknown;
    try {
      const backend = resolveLiveBackend(window.location);
      const response = await fetch(`${backend.api}/health`, { cache: "no-store" });
      if (response.ok) health = await response.json();
    } catch {
      health = undefined;
    }
    const { filename, payload } = buildLiveDiagExport({ sessionId: params.sessionId, view, health });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(href);
  };

  const metric = view?.latestMetric;
  const latestQianchuan = view?.qianchuan.latestMetric;
  const qianchuanHistory = view?.qianchuan.metricHistory ?? [];
  const qianchuanDisplayStatus = view ? qianchuanStatusForDisplay(view) : "unknown";
  const qianchuanFresh = qianchuanDisplayStatus === "fresh" && latestQianchuan?.dataStatus === "fresh";
  const qianchuanWindowUnavailable = latestQianchuan
    ? qianchuanStatusLabel(qianchuanDisplayStatus)
    : view?.qianchuan.officialApi?.state === "healthy" ? UNCOLLECTED_VALUE : qianchuanOfficialApiStatusLabel(view?.qianchuan.officialApi) ?? "等待千川更新";
  const compassOnline = metric?.onlineSnapshot;
  const qianchuanOnline = latestQianchuan?.metrics.onlineSnapshot?.value;
  const onlineSnapshot = copilotOnlineSnapshot({ compassOnline, qianchuanOnline });
  const onlineValue = onlineSnapshot.value;
  const onlineNote = onlineSnapshot.note;
  const headerPayment = copilotHeaderPayment({ compassFen: metric?.sessionPaidGmvFen, qianchuanGmv: latestQianchuan?.metrics.paidOrderGmv });
  const hourVsBaseline = view?.hourVsBaseline ?? null;
  const hourPace = hourMonitorPace(view?.session.startedAt);
  const hourGmv = hourVsBaseline?.metrics.find((item) => item.metricKey === "gmvFen");
  const hourSpend = hourVsBaseline?.metrics.find((item) => item.metricKey === "adSpendFen");
  const hourGmvCopy = hourGmv ? formatHourComparison(hourGmv, hourPace) : { liveDisplay: UNCOLLECTED_VALUE, vsDisplay: NO_SAMPLE_LABEL, note: `${HOUR_GRAIN_LABEL}，先不拿历史比高低`, bandLabel: "" };
  const hourSpendCopy = hourSpend ? formatHourComparison(hourSpend, hourPace) : { liveDisplay: UNCOLLECTED_VALUE, vsDisplay: NO_SAMPLE_LABEL, note: `${HOUR_GRAIN_LABEL}，先不拿历史比高低`, bandLabel: "" };
  const hourCardTitle = hourPace.startedMidHour || hourPace.scaleBaseline ? "已监测 vs 平时节奏" : "这一小时 vs 平时";
  const hourCardClock = hourVsBaseline
    ? hourPace.scaleBaseline ? clockHourSlotLabel(hourVsBaseline.weekday, hourVsBaseline.hour) : clockHourLabel(hourVsBaseline.weekday, hourVsBaseline.hour)
    : "时钟小时";
  const qianchuanRollingDelta = (key: keyof QianchuanMetric["metrics"]): QianchuanDelta => qianchuanSlotDelta(qianchuanHistory, key, latestQianchuan, qianchuanDisplayStatus);
  const entersDelta = qianchuanRollingDelta("liveWatchCount");
  const impressionsDelta = qianchuanRollingDelta("liveImpressions");
  const productClicksDelta = qianchuanRollingDelta("productClicks");
  const paidGmvDelta = qianchuanRollingDelta("paidOrderGmv");
  const spendDelta = qianchuanRollingDelta("adSpend");
  const compassHistory = view?.metricHistory ?? [];
  const unpaidOrderCount = lastKnownCompassNumber(metric, compassHistory, "unpaidOrderCount");
  const unpaidOrderDisplay = unpaidOrderCount === undefined ? UNCOLLECTED_VALUE : value(unpaidOrderCount);
  const qianchuanThrottleNote = view?.qianchuan.sourceKind === "official_api"
    ? qianchuanDisplayStatus === "stale" || qianchuanDisplayStatus === "offline" ? QIANCHUAN_API_RETRY_NOTE : undefined
    : qianchuanDisplayStatus === "stale" || qianchuanDisplayStatus === "offline"
      ? QIANCHUAN_BACKGROUND_NOTE
      : qianchuanBackgroundThrottleNote(qianchuanHistory, latestQianchuan, qianchuanDisplayStatus);
  const interruptBanner = view ? livePilotInterruptBanner(view) : null;
  const transcriptionLabel = liveAudioStatusLabel(view?.audio);
  const moreData = metric ? [
    metric.sessionPaidGmvFen === undefined ? null : ["直播间支付金额", money(metric.sessionPaidGmvFen), "当前场次累计"],
    metric.paidBuyerCount === undefined ? null : ["支付人数", value(metric.paidBuyerCount), "已确认人数"],
    metric.paidItemCount === undefined ? null : ["支付件数", value(metric.paidItemCount), "已确认件数"],
    metric.watchToPaidRate === undefined ? null : ["观看到支付", rate(metric.watchToPaidRate), "罗盘比例"],
    metric.adSpendFen === undefined ? null : ["投放消耗", money(metric.adSpendFen), "作为流量干扰参考"],
    paidGmvDelta.status === "ready" && paidGmvDelta.value !== undefined ? ["近1分钟支付金额", formatQianchuanDeltaDisplay(paidGmvDelta, "money"), paidGmvDelta.note] : null,
  ].filter((item): item is string[] => item !== null) : [];
  const trendRows: Array<{ label: string; key: keyof QianchuanMetric["metrics"]; kind: "count" | "money"; emphasize?: boolean; watchNote?: boolean }> = [
    { label: "近15分钟支付金额", key: "paidOrderGmv", kind: "money", emphasize: true },
    { label: "近15分钟支付订单", key: "paidOrderCount", kind: "count" },
    { label: "近15分钟商品点击", key: "productClicks", kind: "count" },
    { label: "近15分钟观看增量", key: "liveWatchCount", kind: "count", watchNote: true }
  ];
  const trendAnchor = trendAnchorMs(view?.metricHistory ?? [], qianchuanHistory);
  const qianchuanCumulative = (key: keyof QianchuanMetric["metrics"]): string => latestQianchuan?.metrics[key]
    ? qianchuanValue(latestQianchuan.metrics[key])
    : qianchuanFresh ? MISSING_VALUE : qianchuanWindowUnavailable;
  const fourRateFunnel = qianchuanFourRateFunnel(latestQianchuan);
  const funnelRate = (key: QianchuanFunnelRate["key"]): [string, string, string] => {
    const item = fourRateFunnel.rates.find((rate) => rate.key === key);
    return [item?.label ?? key, item?.display ?? UNCOLLECTED_VALUE, item?.note ?? fourRateFunnel.note];
  };
  const weakRateLabel = fourRateFunnel.rates.find((item) => item.weak)?.label;
  const layerRows: Array<{ label: string; caption: string; highlight?: boolean; items: Array<[string, string, string]> }> = [
    { label: "流量", caption: "曝光有没有在涨，刷到了有没有进来", items: [["直播间整体曝光次数", qianchuanCumulative("liveImpressions"), "千川大屏累计"], funnelRate("impressionClick"), ["近1分钟曝光增量", formatQianchuanDeltaDisplay(impressionsDelta), impressionsDelta.status === "ready" ? "千川曝光累计差值" : impressionsDelta.note]] },
    { label: "留存", caption: "进来之后能不能停住", items: [["平均观看时长", formatWatchDuration(metric?.averageWatchDurationSec), "罗盘整场口径"], ["当前在线", value(onlineValue), onlineNote], ["近1分钟观看增量", formatQianchuanDeltaDisplay(entersDelta), entersDelta.status === "ready" ? "千川观看累计差值，非去重进入人数" : entersDelta.note]] },
    { label: "兴趣", caption: "商品有没有被点开", items: [["直播间商品曝光次数", qianchuanCumulative("productImpressions"), "千川大屏累计"], funnelRate("productShowClick"), ["近1分钟商品点击", formatQianchuanDeltaDisplay(productClicksDelta), productClicksDelta.status === "ready" ? "千川累计差值" : productClicksDelta.note]] },
    { label: "成交", caption: "点击有没有形成支付", highlight: true, items: [["本场GMV", headerPayment.display, headerPayment.source === "missing" ? "未采集 · 不用 0 代替" : headerPayment.label], funnelRate("productClickConvert"), ["未支付订单", unpaidOrderDisplay, "当前商品快照"]] },
    { label: "投放", caption: "付费流量带来的经营效率", items: [["当前 ROI", latestQianchuan?.metrics.roi ? qianchuanValue(latestQianchuan.metrics.roi) : qianchuanFresh ? MISSING_VALUE : qianchuanWindowUnavailable, "当前口径"], ["近1分钟消耗", formatQianchuanDeltaDisplay(spendDelta, "money"), spendDelta.note]] }
  ];
  const currentProduct = metric?.currentProductName ?? metric?.productName;
  const stuckLayer = !CAPTURE_ONLY && view ? issueLayer(view) : "暂无";
  const diagnosisCitations = view?.diagnosis ? collectDiagnosisCitations(view.diagnosis) : [];
  const qianchuanHeaderStatus = view ? qianchuanStatusForDisplay(view) : "unknown";
  const qianchuanApiState = view?.qianchuan.officialApi?.state;
  const qianchuanApiLabel = view && (view.qianchuan.sourceKind === "official_api" || view.qianchuan.sourceKind === "none")
    ? qianchuanApiState === "healthy" && !latestQianchuan ? "已接通，等待数据" : qianchuanOfficialApiStatusLabel(view.qianchuan.officialApi)
    : undefined;
  const qianchuanHeaderLabel = qianchuanApiState === "healthy" && !latestQianchuan
    ? qianchuanApiLabel ?? "已接通，等待数据"
    : qianchuanApiState !== "healthy" && qianchuanApiLabel
      ? qianchuanApiLabel
      : liveSourceHeaderLabel({ status: qianchuanHeaderStatus, overallHealth: view?.qianchuan.overallHealth, recovering: view?.recovering === true && view.pendingRecovery?.source === "qianchuan", needLogin: view?.pageRuntimeState?.qianchuan?.allowlistStatus === "login" || view?.qianchuan.overallHealth === "login_required" });
  const missingOfficialApiFields = view?.qianchuan.sourceKind === "official_api"
    ? ([
      ["liveImpressions", "曝光"],
      ["productImpressions", "商品曝光"],
      ["onlineSnapshot", "实时在线"]
    ] as const).filter(([key]) => latestQianchuan?.metrics[key] === undefined).map(([, label]) => label)
    : [];
  const qianchuanCapabilityNote = missingOfficialApiFields.length > 0
    ? `官方接口当前未读取${missingOfficialApiFields.join("、")}等字段；这些字段显示“未采集”，不代表平台不支持。`
    : undefined;
  return <main className={`live-pilot-shell${OPERATOR_RULES ? " live-pilot-operator-enabled" : ""}${lightTheme ? " live-pilot-light" : ""}${embedded ? " live-pilot-embedded" : ""}`}>
    <header className="live-pilot-header"><div className="live-pilot-header-title"><p className="live-pilot-eyebrow">LIVE GROWTH OS</p><h1>{headerTitle(embedded)}</h1><div className="live-pilot-header-context"><span className="live-pilot-header-gmv">{headerPayment.label}：<strong>{headerPayment.display}</strong></span>{!CAPTURE_ONLY && <span>卡点：<strong>{stuckLayer}</strong></span>}<span>已监测：<strong>{view?.session.status === "running" ? monitoredDuration(view.session.startedAt) : "待更新"}</strong></span>{currentProduct && <span>商品：<strong>{currentProduct}</strong></span>}{!CAPTURE_ONLY && <label className="live-pilot-role-picker" title="未指定时只给通用漏斗建议">商品角色<select aria-label="商品角色" value={view?.productRole ?? "unknown"} onChange={(event) => { void chooseProductRole(event.target.value as LiveProductRole); }}>{PRODUCT_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}{onlineValue !== undefined && <span>{onlineNote}：<strong>{value(onlineValue)}</strong></span>}</div></div><div className="live-pilot-header-actions"><div className="live-pilot-status"><div><span>罗盘</span><strong className={`status-${view?.source.status ?? "unknown"}`}>{liveSourceHeaderLabel({ status: view?.source.status ?? "unknown", overallHealth: view?.source.overallHealth, needLogin: view?.pageRuntimeState?.compass?.allowlistStatus === "login" })}</strong><small>{time(view?.source.lastMetricAt)}</small></div><div><span>千川 {view?.qianchuan.sourceKind === "official_api" ? "· 官方接口" : view?.qianchuan.sourceKind === "browser_extension" ? "· 页面回退" : ""}</span><strong className={`status-${qianchuanHeaderStatus}`}>{qianchuanHeaderLabel}</strong><small>{time(view?.qianchuan.lastMetricAt)}</small></div>{!CAPTURE_ONLY && <div><span>音频</span><strong className={`status-${view?.audio.transcriptionStatus ?? "not_started"}`}>{transcriptionLabel}</strong><small>{time(view?.audio.lastFinalAt)}</small></div>}</div>{view && params.sessionId ? <SourceHealthExtras view={view} sessionId={params.sessionId} /> : null}<nav className="live-pilot-header-tools" aria-label="副驾工具"><button type="button" className="live-pilot-theme-toggle" aria-pressed={lightTheme} onClick={() => setLightTheme((current) => !current)}>{lightTheme ? "深色" : "浅色"}</button>{!CAPTURE_ONLY && <button type="button" className="live-pilot-theme-toggle" disabled={!view || !params.sessionId} onClick={() => { void exportLiveDiagnosis(); }}>导出诊断</button>}{!CAPTURE_ONLY && <><Link href={params.sessionId ? `/live/review?sessionId=${encodeURIComponent(params.sessionId)}` : "/live/review"} className="live-pilot-link" target="_blank" rel="noreferrer">主播复盘</Link><Link href={params.sessionId ? `/live/session-review?sessionId=${encodeURIComponent(params.sessionId)}` : "/live/session-review"} className="live-pilot-link" target="_blank" rel="noreferrer">本场复盘</Link></>}<Link href="/live/connect" className="live-pilot-link" target="_blank" rel="noreferrer">千川授权</Link><Link href="/live" className="live-pilot-link">接入说明</Link></nav></div></header>
    {error && <div className="live-pilot-error" role="alert">{error}</div>}
    {!embedded && !CAPTURE_ONLY && <LanShareBar />}{CAPTURE_ONLY && <div className="live-pilot-source-note" role="status">{OPERATOR_RULES ? "运营规则试运行 · 10 分钟复查，投放与直播操作由人工执行；语音识别与模型调用未启用。" : "数据接入测试版 · 实时提示规则待配置，经营建议、语音识别与模型调用已暂停。"}</div>}
    {!view && !error && <section className="live-pilot-empty"><p>正在等待罗盘数据……</p><small>连上罗盘直播大屏后，显示经营数据、千川投放和来源更新状态。</small></section>}
    {view && <>
      {interruptBanner && <div className="live-pilot-reconnect" role="status">{interruptBanner}</div>}
      {qianchuanThrottleNote && <div className="live-pilot-source-note" role="status">{qianchuanThrottleNote}</div>}
      {qianchuanCapabilityNote && !OPERATOR_RULES && <div className="live-pilot-source-note" role="status">{qianchuanCapabilityNote}</div>}
      <section className="live-pilot-dashboard">
        <div className="live-pilot-main-column">
          {OPERATOR_RULES ? <section className="workbench-summary" aria-label="直播关键指标">
            <article><span>{headerPayment.source === "qianchuan" ? "千川成交 GMV" : "直播间 GMV"}</span><strong>{headerPayment.display}</strong><small>{headerPayment.label}</small></article>
            <article><span>千川消耗</span><strong>{qianchuanCumulative("adSpend")}</strong><small>千川累计 · {qianchuanStatusLabel(qianchuanDisplayStatus)}</small></article>
            <article><span>千川 ROI</span><strong>{qianchuanCumulative("roi")}</strong><small>平台归因口径 · {time(view.qianchuan.lastMetricAt)}</small></article>
            <article><span>当前在线</span><strong>{value(onlineValue)}</strong><small>{onlineNote}</small></article>
          </section> : <section className="live-pilot-kpis" aria-label="成交主指标">
            <article className="live-pilot-primary-kpi">
              <span>本场GMV · {headerPayment.label}</span>
              <strong>{headerPayment.display}</strong>
              <small>实际支付金额{hourVsBaseline?.lastSuccessAt ? ` · 基线更新于 ${time(hourVsBaseline.lastSuccessAt)}` : ""}</small>
            </article>
            <div className="live-pilot-secondary-kpis">
              {!CAPTURE_ONLY && <article className="live-pilot-secondary-kpi">
                <span>{hourCardTitle}</span>
                <strong>{hourGmvCopy.liveDisplay}</strong>
                <small>{hourCardClock} · {hourGmvCopy.vsDisplay}{hourGmvCopy.bandLabel ? ` · ${hourGmvCopy.bandLabel}` : ""}</small>
              </article>}
              <article className="live-pilot-secondary-kpi">
                <span>近1分钟商品点击</span>
                <strong>{formatQianchuanDeltaDisplay(productClicksDelta)}</strong>
                <small>{productClicksDelta.note}</small>
              </article>
              <article className="live-pilot-secondary-kpi">
                <span>近1分钟消耗</span>
                <strong>{formatQianchuanDeltaDisplay(spendDelta, "money")}</strong>
                <small>{hourSpendCopy.vsDisplay === NO_SAMPLE_LABEL || hourSpendCopy.vsDisplay === SAMPLE_INSUFFICIENT_LABEL || hourSpendCopy.vsDisplay.includes("不够出平时") ? hourSpendCopy.vsDisplay : spendDelta.note}</small>
              </article>
            </div>
          </section>}
          {OPERATOR_RULES && <WorkbenchTrend history={qianchuanHistory} />}
          <section className="live-pilot-five-layers" aria-label="经营主线"><div className="live-pilot-section-heading"><div><span>经营主线</span><h2>{CAPTURE_ONLY ? "从流量到成交，经营数据总览" : "从流量到成交，先看哪一层卡住"}</h2></div><small>{fourRateFunnel.note}{view.qianchuan.lastMetricAt ? ` · ${time(view.qianchuan.lastMetricAt)}` : ` · ${time(view.source.lastMetricAt)}`}</small></div><div className="live-pilot-layer-grid">{layerRows.map((layer, index) => <article key={layer.label} className={[layer.highlight ? "live-pilot-layer-deal" : "", !CAPTURE_ONLY && stuckLayer === layer.label ? "live-pilot-layer-issue" : ""].filter(Boolean).join(" ") || undefined}>{index < layerRows.length - 1 && <i className="live-pilot-layer-arrow" aria-hidden="true">→</i>}<div className="live-pilot-layer-label"><strong>{layer.label}</strong><span>{layer.caption}</span></div><div className="live-pilot-layer-metrics">{layer.items.map(([label, display, note], itemIndex) => <div key={label} className={`${layer.highlight && itemIndex === 0 ? "live-pilot-layer-gmv" : ""}${!CAPTURE_ONLY && label === weakRateLabel ? " live-pilot-layer-rate-weak" : ""}`.trim() || undefined}><span>{label}</span><strong className={liveMetricPrimaryClass(display)}>{display}</strong><small>{note}</small></div>)}</div></article>)}</div></section>
          <details className="live-pilot-more-data live-pilot-wide-only"><summary>更多经营数据{moreData.length ? ` · ${moreData.length} 项已读取` : ""}</summary>{moreData.length ? <div className="live-pilot-more-grid">{moreData.map(([label, display, note]) => <article key={label}><span>{label}</span><strong>{display}</strong><small>{note}</small></article>)}</div> : <p className="live-pilot-muted">暂时没有更多已读取数据。</p>}</details>
          <details className="live-pilot-more-data live-pilot-qianchuan-details live-pilot-wide-only"><summary>更多投放与漏斗数据 · {qianchuanStatusLabel(view.qianchuan.status)}</summary>{view.qianchuan.latestMetric ? <><div className="live-pilot-qianchuan-grid">{([ ["千川消耗", "adSpend"], ["投放成交金额", "paidOrderGmv"], ["ROI", "roi"], ["成交成本", "costPerPaidOrder"], ["平台 CPM", "cpmPlatform"], ["平台点击率（非商品 CTR）", "platformCtr"], ["平台转化率（非商品 CVR）", "platformConvertRate"], ["平台平均订单金额", "payOrderAverage"], ["评论次数", "commentCount"], ["关注次数", "followCount"], ["加团次数", "fansClubJoinCount"], ["分享次数", "shareCount"] ] as Array<[string, keyof QianchuanMetric["metrics"]]>).map(([label, key]) => <article key={key}><span>{label}</span><strong>{qianchuanValue(view.qianchuan.latestMetric?.metrics[key])}</strong><small>千川口径 · {time(view.qianchuan.lastMetricAt)}</small></article>)}</div><details className="live-pilot-qianchuan-funnel"><summary>查看千川漏斗</summary><div className="live-pilot-more-grid">{([ ["付费曝光", "liveImpressions"], ["千川观看增量", "liveWatchCount"], ["商品点击", "productClicks"], ["支付订单", "paidOrderCount"], ["观看到支付", "watchToPaid"], ["点击到支付", "productClickToPaid"], ["曝光到观看", "showToWatch"], ["观看到点击", "watchToProductClick"] ] as Array<[string, keyof QianchuanMetric["metrics"]]>).map(([label, key]) => <article key={key}><span>{label}</span><strong>{qianchuanValue(view.qianchuan.latestMetric?.metrics[key])}</strong><small>{key === "liveWatchCount" ? "千川观看累计差值 · 非去重进入人数" : "千川口径"}</small></article>)}</div></details></> : <p className="live-pilot-muted">千川未连接，等待更新；不会用 0 代替未读取数据。</p>}</details>
          {!CAPTURE_ONLY && <section className="live-pilot-details"><article className="live-pilot-speech-card"><div className="live-pilot-card-title"><span>最近话术覆盖</span><small>{time(view.latestTranscript?.at)}</small></div><p className="live-pilot-transcript">{view.latestTranscript?.text ?? "语音识别未连接"}</p><details className="live-pilot-recent-speech"><summary>查看最近3分钟完整话术</summary>{view.recentTranscripts.length ? <ul>{view.recentTranscripts.map((speech, index) => <li key={`${speech.at}:${index}`}><time>{time(speech.at)}</time><span>{speech.text}</span></li>)}</ul> : <p className="live-pilot-muted">最近3分钟没有可显示的完整话术。</p>}</details></article></section>}
          <section className="live-pilot-events live-pilot-wide-only"><div className="live-pilot-card-title"><span>时间线</span><small>最近发生的事</small></div>{view.eventMarkers.length ? <ul>{view.eventMarkers.slice(-12).reverse().map((marker, index) => <li key={`${marker.at}:${index}`}><time>{time(marker.at)}</time><span>{marker.label}</span></li>)}</ul> : <p className="live-pilot-muted">还没有可显示的事件。</p>}</section>
        </div>
        <aside className="live-pilot-guide-column" aria-label="现场指导">
          {OPERATOR_RULES && params.sessionId && <><OperatorRulesPanel sessionId={params.sessionId} /><HistoryReference sessionId={params.sessionId} /></>}
          {!CAPTURE_ONLY && <section className={`live-pilot-diagnosis${view.diagnosis?.interruptDecision === "observe" ? " live-pilot-diagnosis-hold" : ""}${view.diagnosis?.interruptDecision === "interrupt" ? " live-pilot-diagnosis-interrupt" : ""}`} aria-label="15分钟诊断">
            <div className="live-pilot-section-heading live-pilot-diagnosis-heading">
              <div>
                <span>刚过去这 15 分钟</span>
                <h2>场上发生了什么</h2>
              </div>
              <small className="live-pilot-diagnosis-meta">
                {view.diagnosis ? <>
                  <em>{view.diagnosis.triggerType ? DIAGNOSIS_TRIGGER_LABEL[view.diagnosis.triggerType] : "固定15分钟"}</em>
                  <em className={`live-pilot-diagnosis-confidence live-pilot-diagnosis-confidence-${view.diagnosis.confidence}`}>{DIAGNOSIS_CONFIDENCE_LABEL[view.diagnosis.confidence]}</em>
                  <em>{PRODUCT_ROLE_OPTIONS.find((item) => item.value === (view.diagnosis?.productRole ?? view.productRole))?.label ?? "未指定"}</em>
                  <em className={view.diagnosis.interruptDecision === "observe" ? "live-pilot-diagnosis-quiet" : undefined}>{view.diagnosis.interruptDecision ? DIAGNOSIS_INTERRUPT_LABEL[view.diagnosis.interruptDecision] : "不打扰"}</em>
                  {view.diagnosis.previousActionOutcome === "observing" && <em>观察中</em>}
                  {view.diagnosis.previousActionOutcome === "not_evaluated" && <em>未评价</em>}
                  {view.diagnosis.streakCount >= 2 && <em className="live-pilot-diagnosis-streak">连续{view.diagnosis.streakCount}窗</em>}
                  <span>{view.diagnosis.provider === "ark-expression" ? "方舟表达" : "规则模板"}</span>
                </> : "未到完整窗口"}
              </small>
            </div>
            {view.diagnosis ? <>
              <div className="live-pilot-diagnosis-block"><span>发生了什么</span><p className="live-pilot-diagnosis-verdict">{view.diagnosis.verdict.text}</p></div>
              <div className="live-pilot-diagnosis-block"><span>为什么</span><p>{view.diagnosis.evidence[0]?.text ?? view.diagnosis.verdict.text}</p></div>
              <div className="live-pilot-diagnosis-next">
                <div className="live-pilot-diagnosis-next-head">
                  <span>现在只做什么</span>
                  <CopyDiagnosisAction text={view.diagnosis.action.text} />
                </div>
                <p>{view.diagnosis.action.text}</p>
              </div>
              <div className="live-pilot-diagnosis-block"><span>做完看什么</span><p>{view.diagnosis.watchNext.text}</p></div>
              {diagnosisCitations.length > 0 && <ul className="live-pilot-cite-row">{diagnosisCitations.map((item) => <li key={`${item.label}:${item.value}:${item.unit}`} className="live-pilot-cite-chip">{formatCitedNumber(item)}</li>)}</ul>}
              {(view.diagnosis.pending.length > 0 || operatorDiagnosisAnomalies(view.diagnosis).length > 0) && <details className="live-pilot-diagnosis-fold"><summary>规则说明</summary>
                {view.diagnosis.pending.map((item) => <p key={item.id}>{item.text}</p>)}
                {operatorDiagnosisAnomalies(view.diagnosis).map((item) => <p key={item.type}>{item.text}</p>)}
              </details>}
            </> : <div className="live-pilot-diagnosis-wake"><p className="live-pilot-diagnosis-verdict">等待下一个完整15分钟</p><p className="live-pilot-muted">满窗后出一张诊断。规则先锁定做什么，再用人话写清依据。稳定窗不打扰。</p></div>}
          </section>}
          {!OPERATOR_RULES && <section className="live-pilot-mini-trends live-pilot-wide-only" aria-label="15分钟经营趋势">
            <div className="live-pilot-section-heading">
              <div><span>最近变化</span><h2>近 15 分钟累计</h2></div>
              <small>柱状是每分钟增量，数字是近15分钟合计</small>
            </div>
            <div className="live-pilot-trend-rows">{trendRows.map((row) => {
              const points = selectQianchuanDeltaTrendPoints(qianchuanHistory, row.key, Date.now(), trendAnchor).map((point) => point.value);
              const max = Math.max(...points, 1);
              const currentDelta = qianchuanWindowDelta(qianchuanHistory, row.key);
              const currentDisplay = formatQianchuanDeltaDisplay(currentDelta, row.kind);
              return <div className={`live-pilot-trend-row${row.emphasize ? " live-pilot-trend-row-gmv" : ""}`} key={row.key}>
                <div className="live-pilot-trend-label"><strong>{row.label}</strong><span>{trendWindowUnit(currentDelta, row.kind, row.watchNote)}</span></div>
                <div className="live-pilot-trend-track" aria-label={`${row.label}趋势`}>{points.length ? points.map((point, index) => <i key={`${row.key}:${index}`} style={{ height: `${Math.max(8, (point / max) * 100)}%` }} title={`${point}`} />) : <span className="live-pilot-trend-empty">{currentDelta.note}</span>}</div>
                <strong className="live-pilot-trend-current">{currentDisplay}</strong>
              </div>;
            })}</div>
          </section>}
        </aside>
      </section>
      <details className="live-pilot-coverage live-pilot-wide-only"><summary>查看接入状态与字段覆盖</summary>{OPERATOR_RULES && qianchuanCapabilityNote && <p className="live-pilot-muted">{qianchuanCapabilityNote}</p>}<div className="live-pilot-coverage-grid"><div><strong>核心经营数据 {view.source.coverage.core.available}/{view.source.coverage.core.total}</strong><span>{view.source.coverage.core.missing.length ? `本场尚未获取：${view.source.coverage.core.missing.join("、")}` : "核心数据已齐"}</span></div><div><strong>罗盘窗口字段 {view.source.coverage.fiveMinute.available}/{view.source.coverage.fiveMinute.total}</strong><span>{view.source.coverage.fiveMinute.missing.length ? `本场尚未获取：${view.source.coverage.fiveMinute.missing.join("、")}` : "窗口数据已齐"}</span></div><div><strong>商品信息 {view.source.coverage.product.available}/{view.source.coverage.product.total}</strong><span>{view.source.coverage.product.missing.length ? `本场尚未获取：${view.source.coverage.product.missing.join("、")}` : "商品信息已齐"}</span></div>{!CAPTURE_ONLY && <div><strong>音频持续状态</strong><span>{transcriptionLabel}{view.audio.errorCode ? ` · ${view.audio.errorCode}` : ""} · 最近完整话术：{time(view.audio.lastFinalAt)}</span></div>}</div></details>
    </>}
  </main>;
}
