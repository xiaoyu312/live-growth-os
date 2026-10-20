import {
  diagnosisEvidencePacketSchema,
  diagnosisWindowSchema,
  type DiagnosisActionKind,
  type DiagnosisEvidencePacket,
  type DiagnosisExecutionState,
  type DiagnosisInterruptDecision,
  type DiagnosisTriggerType,
  type DiagnosisWindow,
  type LiveEvent,
  type LiveProductRole,
  type SourceGroupHealth
} from "@live-growth/contracts";
import { MIN_CLICKS_FOR_CONVERT, STAGE_SPEECH_EXPECTATIONS } from "./live-diagnosis-funnel";
import { diagnoseLiveWindow, type DiagnoseLiveWindowInput } from "./live-diagnosis-window";
import { closureActionKind, latestProductRole, missingExpectedSpeech, productRoleConfounded } from "./live-product-role";
import { incompleteDiagnosisCopy, stalledTriggerGroups } from "./source-group-health";

export const DIAGNOSIS_OBSERVATION_MINUTES = 5 as const;
const SPEND_SPIKE_RATIO = 1.5;
const TRAFFIC_DROP_RATIO = 0.6;
const TRAFFIC_DROP_ABS_ONLINE = 3;
const EVENT_FAMILIES = new Set(["event_spend_spike", "event_traffic_drop", "event_click_no_pay"]);
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
  product_card_cta: "小黄车指令",
  purchase_cta: "购买指令",
  urgency: "催单",
  interaction: "互动"
};

export type DiagnosisQuality = {
  dataFreshness: "fresh" | "stale" | "offline" | "unknown";
  windowComplete: boolean;
  speechAvailable: boolean;
  statusOnly: boolean;
  unknowns: string[];
};

export type QianchuanSliceSnapshot = {
  observedAt: string;
  mappingVersion?: string;
  sourceEndpoint?: string;
  metrics: Partial<Record<"adSpend" | "liveImpressions" | "liveWatchCount" | "productClicks" | "paidOrderCount" | "onlineSnapshot", { value: number } | undefined>>;
};

function latestContinuousQianchuanSlice(snapshots: readonly QianchuanSliceSnapshot[]): QianchuanSliceSnapshot[] {
  const ordered = [...snapshots].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const latest = ordered.at(-1);
  if (!latest) return [];
  const identity = `${latest.mappingVersion ?? "legacy"}|${latest.sourceEndpoint ?? "legacy"}`;
  const segment: QianchuanSliceSnapshot[] = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index]!;
    if (`${item.mappingVersion ?? "legacy"}|${item.sourceEndpoint ?? "legacy"}` !== identity) break;
    segment.push(item);
  }
  return segment.reverse();
}

function snapshotWindowDelta(
  snapshots: readonly QianchuanSliceSnapshot[],
  key: keyof QianchuanSliceSnapshot["metrics"],
  fromMs: number,
  toMs: number
): number | undefined {
  const inRange = snapshots
    .filter((item) => {
      const at = Date.parse(item.observedAt);
      return at >= fromMs && at <= toMs;
    })
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  if (inRange.length < 2) return undefined;
  const first = inRange[0]?.metrics[key]?.value;
  const last = inRange.at(-1)?.metrics[key]?.value;
  if (first === undefined || last === undefined) return undefined;
  return Math.max(0, last - first);
}

export function recentSliceFromQianchuanSnapshots(
  snapshots: readonly { observedAt: string; metrics: QianchuanSliceSnapshot["metrics"] }[],
  nowMs: number,
  minutes = 5
): DiagnosisRecentSlice | undefined {
  const activeSnapshots = latestContinuousQianchuanSlice(snapshots);
  if (activeSnapshots.length < 4) return undefined;
  const windowMs = minutes * 60_000;
  const currentStart = nowMs - windowMs;
  const previousStart = nowMs - windowMs * 2;
  const spendYuan = snapshotWindowDelta(activeSnapshots, "adSpend", currentStart, nowMs);
  const prevSpendYuan = snapshotWindowDelta(activeSnapshots, "adSpend", previousStart, currentStart);
  return {
    startAt: new Date(currentStart).toISOString(),
    endAt: new Date(nowMs).toISOString(),
    ...(spendYuan !== undefined ? { adSpendFen: Math.round(spendYuan * 100) } : {}),
    ...(prevSpendYuan !== undefined ? { prevAdSpendFen: Math.round(prevSpendYuan * 100) } : {}),
    ...(optionalDelta(activeSnapshots, "liveImpressions", currentStart, nowMs, "impressions")),
    ...(optionalDelta(activeSnapshots, "liveImpressions", previousStart, currentStart, "prevImpressions")),
    ...(optionalDelta(activeSnapshots, "liveWatchCount", currentStart, nowMs, "watch")),
    ...(optionalDelta(activeSnapshots, "liveWatchCount", previousStart, currentStart, "prevWatch")),
    ...(optionalDelta(activeSnapshots, "productClicks", currentStart, nowMs, "productClicks")),
    ...(optionalDelta(activeSnapshots, "productClicks", previousStart, currentStart, "prevProductClicks")),
    ...(optionalDelta(activeSnapshots, "paidOrderCount", currentStart, nowMs, "paidOrders")),
    ...(optionalInstant(activeSnapshots, nowMs, currentStart))
  };
}

function optionalDelta(
  snapshots: readonly QianchuanSliceSnapshot[],
  key: keyof QianchuanSliceSnapshot["metrics"],
  fromMs: number,
  toMs: number,
  name: keyof DiagnosisRecentSlice
): Partial<DiagnosisRecentSlice> {
  const value = snapshotWindowDelta(snapshots, key, fromMs, toMs);
  return value === undefined ? {} : { [name]: value };
}

function optionalInstant(
  snapshots: readonly QianchuanSliceSnapshot[],
  nowMs: number,
  currentStart: number
): Partial<DiagnosisRecentSlice> {
  const latest = [...snapshots].reverse().find((item) => Date.parse(item.observedAt) <= nowMs);
  const previous = [...snapshots].reverse().find((item) => Date.parse(item.observedAt) <= currentStart);
  return {
    ...(latest?.metrics.onlineSnapshot ? { onlineSnapshot: latest.metrics.onlineSnapshot.value } : {}),
    ...(previous?.metrics.onlineSnapshot ? { prevOnlineSnapshot: previous.metrics.onlineSnapshot.value } : {})
  };
}

export type DiagnosisRecentSlice = {
  startAt: string;
  endAt: string;
  adSpendFen?: number;
  prevAdSpendFen?: number;
  impressions?: number;
  prevImpressions?: number;
  watch?: number;
  prevWatch?: number;
  productClicks?: number;
  prevProductClicks?: number;
  paidOrders?: number;
  onlineSnapshot?: number;
  prevOnlineSnapshot?: number;
};

export type DiagnoseLiveOperatingInput = DiagnoseLiveWindowInput & {
  nowMs: number;
  dataFreshness: DiagnosisQuality["dataFreshness"];
  compassStatus?: "fresh" | "stale" | "offline" | "unknown" | "partial";
  qianchuanStatus?: "fresh" | "stale" | "offline" | "unknown" | "partial";
  audioStatus?: "active" | "stale" | "offline" | "error" | "not_started" | "connecting";
  productRole?: LiveProductRole;
  productRoleConfounded?: boolean;
  recent?: DiagnosisRecentSlice;
  previousIssueKey?: string;
  previousActionKind?: DiagnosisActionKind;
  previousResolution?: "executed" | "not_executed" | "not_applicable";
  previousResolvedAt?: string;
  relevantQuotes?: readonly string[];
  events?: readonly LiveEvent[];
  groupHealth?: readonly SourceGroupHealth[];
};

function yuan(fen: number): number {
  return Math.round(fen) / 100;
}

function finding(id: string, text: string, cited: DiagnosisWindow["verdict"]["citedNumbers"]): DiagnosisWindow["verdict"] {
  return { id, text, citedNumbers: cited };
}

function hasCounterReset(window: DiagnoseLiveOperatingInput["current"]): boolean {
  return [...Object.values(window.compass), ...Object.values(window.qianchuan)].some((series) => (series?.resetCount ?? 0) > 0);
}

export function assessDiagnosisQuality(input: Pick<DiagnoseLiveOperatingInput, "dataFreshness" | "compassStatus" | "qianchuanStatus" | "audioStatus" | "current" | "previous" | "productRole"> & {
  productRoleConfounded?: boolean;
  baselineInsufficient?: boolean;
}): DiagnosisQuality {
  const compass = input.compassStatus ?? input.dataFreshness;
  const qianchuan = input.qianchuanStatus ?? input.dataFreshness;
  const stale = compass === "stale" || qianchuan === "stale";
  const partial = compass === "partial" || qianchuan === "partial";
  const offline = compass === "offline" || qianchuan === "offline" || input.audioStatus === "error";
  const unknowns: string[] = [];
  if (input.current.speech.finalCount <= 0) unknowns.push("speech");
  if (stale) unknowns.push("stale_source");
  if (offline) unknowns.push("offline_or_audio_error");
  if (input.current.coverage !== "full") unknowns.push("incomplete_window");
  if (!input.previous) unknowns.push("no_previous_window");
  if (input.baselineInsufficient) unknowns.push("baseline_insufficient");
  if ((input.productRole ?? "unknown") === "unknown") unknowns.push("role_unknown");
  if (input.productRoleConfounded) unknowns.push("role_confounded");
  if (hasCounterReset(input.current)) unknowns.push("counter_reset");
  return {
    dataFreshness: offline ? "offline" : stale || partial ? "stale" : input.dataFreshness,
    windowComplete: input.current.coverage === "full",
    speechAvailable: input.current.speech.finalCount > 0,
    statusOnly: stale || offline || partial,
    unknowns: unknowns.slice(0, 8)
  };
}

export function assessExecutionState(input: {
  role: LiveProductRole;
  stageKeys: readonly string[];
  presentKeys: readonly string[];
  speechFinalCount: number;
  confounded: boolean;
}): { state: DiagnosisExecutionState; missingKeys: string[] } {
  if (input.confounded) return { state: "not_applicable", missingKeys: [] };
  if (input.speechFinalCount <= 0) return { state: "unknown", missingKeys: missingExpectedSpeech(input.role, input.stageKeys, []) };
  const missingKeys = missingExpectedSpeech(input.role, input.stageKeys, input.presentKeys);
  if (missingKeys.length === 0) return { state: "complete", missingKeys };
  return { state: "incomplete", missingKeys };
}

function layerFollowed(current?: number, prev?: number, spendRatio?: number): boolean | undefined {
  if (current === undefined || prev === undefined || spendRatio === undefined) return undefined;
  if (prev <= 0) return current > 0;
  return current >= prev * spendRatio * 0.9;
}

export function detectDiagnosisEvents(slice: DiagnosisRecentSlice | undefined): DiagnosisTriggerType | undefined {
  if (!slice) return undefined;
  const spendRatio = slice.adSpendFen !== undefined && slice.prevAdSpendFen !== undefined && slice.prevAdSpendFen > 0
    ? slice.adSpendFen / slice.prevAdSpendFen
    : undefined;
  const spendSpike = spendRatio !== undefined && spendRatio >= SPEND_SPIKE_RATIO;
  const layers = [
    layerFollowed(slice.impressions, slice.prevImpressions, spendRatio),
    layerFollowed(slice.watch, slice.prevWatch, spendRatio),
    layerFollowed(slice.productClicks, slice.prevProductClicks, spendRatio)
  ];
  const judged = layers.filter((item) => item !== undefined);
  if (spendSpike && judged.length > 0 && judged.some((item) => item === false)) {
    return "event_spend_spike";
  }
  const onlineDrop = slice.onlineSnapshot !== undefined && slice.prevOnlineSnapshot !== undefined
    && slice.prevOnlineSnapshot > 0
    && slice.onlineSnapshot <= slice.prevOnlineSnapshot * TRAFFIC_DROP_RATIO
    && slice.prevOnlineSnapshot - slice.onlineSnapshot >= TRAFFIC_DROP_ABS_ONLINE;
  const watchDrop = slice.watch !== undefined && slice.prevWatch !== undefined
    && slice.prevWatch > 0
    && slice.watch < slice.prevWatch * TRAFFIC_DROP_RATIO;
  if (onlineDrop || watchDrop) return "event_traffic_drop";
  if (slice.productClicks !== undefined && slice.paidOrders !== undefined && slice.productClicks >= MIN_CLICKS_FOR_CONVERT && slice.paidOrders === 0) {
    return "event_click_no_pay";
  }
  return undefined;
}

function dataStrength(input: DiagnoseLiveWindowInput): "weak" | "good" | "insufficient" {
  const clicks = input.current.qianchuan.productClicks?.delta ?? input.current.qianchuan.productClicks?.last;
  const paid = input.current.qianchuan.paidOrderCount?.delta ?? input.current.qianchuan.paidOrderCount?.last;
  if (clicks === undefined && paid === undefined && input.current.compass.adSpendFen === undefined && input.current.qianchuan.adSpend === undefined) {
    return "insufficient";
  }
  if (clicks !== undefined && clicks < MIN_CLICKS_FOR_CONVERT) return "weak";
  if (clicks !== undefined && clicks >= MIN_CLICKS_FOR_CONVERT && (paid ?? 0) === 0) return "weak";
  return "good";
}

export function arbitrateOperatingDirection(input: {
  quality: DiagnosisQuality;
  dataStrength: "weak" | "good" | "insufficient";
  execution: DiagnosisExecutionState;
  scheduledKind: DiagnosisActionKind;
  eventType?: DiagnosisTriggerType;
}): { actionKind: DiagnosisActionKind; interruptDecision: DiagnosisInterruptDecision } {
  if (input.quality.statusOnly) return { actionKind: "hold", interruptDecision: "status_only" };
  if (input.eventType === "event_traffic_drop") return { actionKind: "retain", interruptDecision: "interrupt" };
  if (input.eventType === "event_click_no_pay") return { actionKind: "close_gift", interruptDecision: "interrupt" };
  if (input.eventType === "event_spend_spike") {
    return {
      actionKind: input.execution === "incomplete" ? closureActionKind([]) : "traffic_quality",
      interruptDecision: "interrupt"
    };
  }
  if (input.execution === "incomplete" && (input.dataStrength === "weak" || input.dataStrength === "insufficient")) {
    return { actionKind: closureActionKind([]), interruptDecision: "interrupt" };
  }
  if (input.execution === "complete" && input.dataStrength === "weak") {
    return { actionKind: "hold", interruptDecision: "observe" };
  }
  if (input.execution === "complete" && input.dataStrength === "good") {
    return { actionKind: "hold", interruptDecision: "observe" };
  }
  if (input.execution === "complete" && input.dataStrength === "insufficient") {
    return { actionKind: "hold", interruptDecision: "observe" };
  }
  if (input.execution === "incomplete" && input.dataStrength === "good") {
    return { actionKind: input.scheduledKind === "hold" || input.scheduledKind === "wait" ? "click_cta" : input.scheduledKind, interruptDecision: "observe" };
  }
  if (input.execution === "unknown" && input.dataStrength === "insufficient") {
    return { actionKind: "wait", interruptDecision: "observe" };
  }
  if (input.scheduledKind !== "hold" && input.scheduledKind !== "wait") {
    return { actionKind: input.scheduledKind, interruptDecision: "interrupt" };
  }
  return { actionKind: input.scheduledKind, interruptDecision: "observe" };
}

function issueFamily(trigger: DiagnosisTriggerType, actionKind: DiagnosisActionKind, execution: DiagnosisExecutionState): string {
  if (trigger !== "scheduled_15m") return trigger;
  if (execution === "incomplete") return "incomplete_close";
  return actionKind;
}

export function buildIssueKey(role: LiveProductRole, productName: string | undefined, family: string): string {
  return `${role}:${productName ?? "none"}:${family}`;
}

export function familyFromIssueKey(issueKey: string): string {
  const parts = issueKey.split(":");
  return parts.length >= 3 ? parts.slice(2).join(":") : issueKey;
}

function eventDefaultKind(family: string): DiagnosisActionKind {
  if (family === "event_traffic_drop") return "retain";
  if (family === "event_click_no_pay") return "close_gift";
  return "traffic_quality";
}

function overlayClosureKind(present: readonly string[], locked: DiagnosisActionKind): DiagnosisActionKind {
  if (locked !== "close_gift" && locked !== "click_cta" && locked !== "close_urgency") return locked;
  return closureActionKind(present);
}

function speechLabel(key: string): string {
  return SPEECH_LABEL[key] ?? key;
}

export function shouldSkipDiagnosisExpression(diagnosis: DiagnosisWindow): boolean {
  if (diagnosis.dataCompleteness === "data_incomplete") return true;
  if (diagnosis.interruptDecision === "status_only") return true;
  if (diagnosis.interruptDecision === "observe" && (diagnosis.actionKind === "hold" || diagnosis.actionKind === "wait") && diagnosis.executionState !== "incomplete") {
    return true;
  }
  if ((diagnosis.triggerType === "event_spend_spike" || diagnosis.triggerType === "event_traffic_drop") && diagnosis.current.speechFinalCount === 0) {
    return true;
  }
  return false;
}

export function diagnoseLiveOperating(input: DiagnoseLiveOperatingInput): DiagnosisWindow {
  const asOf = input.nowMs;
  const fromEvents = input.events ? latestProductRole(input.events, asOf) : undefined;
  const role = input.productRole ?? fromEvents?.role ?? "unknown";
  const confounded = input.productRoleConfounded
    ?? (input.events ? productRoleConfounded(input.events, input.current.windowStartAt, input.current.windowEndAt) : false);
  const scheduled = diagnoseLiveWindow({
    sessionId: input.sessionId,
    current: input.current,
    ...(input.previous ? { previous: input.previous } : {}),
    ...(input.priorWindows ? { priorWindows: input.priorWindows } : {}),
    rooms: input.rooms,
    ...(input.asOfLocalDate ? { asOfLocalDate: input.asOfLocalDate } : {}),
    stateShare: input.stateShare,
    ...(input.currentProductName ? { currentProductName: input.currentProductName } : {}),
    ...(input.speechPresentKeys ? { speechPresentKeys: input.speechPresentKeys } : {})
  });
  const quality = assessDiagnosisQuality({
    ...input,
    productRole: role,
    productRoleConfounded: confounded,
    baselineInsufficient: scheduled.hourBaseline.gmvFen.status === "sampleInsufficient"
      && scheduled.hourBaseline.adSpendFen.status === "sampleInsufficient"
  });
  const present = input.speechPresentKeys ?? scheduled.speechPresentKeys;
  const stageKeys = scheduled.funnelStage === "maintain" || scheduled.funnelStage === "wait" || scheduled.funnelStage === "aov" || scheduled.funnelStage === "spend_spike"
    ? []
    : STAGE_SPEECH_EXPECTATIONS[scheduled.funnelStage];
  const execution = assessExecutionState({
    role: confounded ? "unknown" : role,
    stageKeys,
    presentKeys: present,
    speechFinalCount: input.current.speech.finalCount,
    confounded
  });
  const rawEvent = quality.statusOnly ? undefined : detectDiagnosisEvents(input.recent);
  const blockedEventGroups = rawEvent ? stalledTriggerGroups(rawEvent, input.groupHealth) : [];
  const eventType = rawEvent && blockedEventGroups.length === 0 ? rawEvent : undefined;
  const scheduledIncomplete = stalledTriggerGroups("scheduled_15m", input.groupHealth);
  const incompleteGroups = eventType ? blockedEventGroups : scheduledIncomplete;
  const dataIncomplete = incompleteGroups.length > 0 && eventType === undefined;
  if (dataIncomplete) {
    quality.statusOnly = true;
    quality.unknowns = [...new Set([...quality.unknowns, "data_incomplete"])].slice(0, 8);
  }
  const strength = dataStrength(input);
  const observing = input.previousResolution === "executed"
    && input.previousResolvedAt
    && asOf - Date.parse(input.previousResolvedAt) < DIAGNOSIS_OBSERVATION_MINUTES * 60_000;
  const notEvaluated = input.previousResolution === "not_executed" || input.previousResolution === "not_applicable";
  let direction = arbitrateOperatingDirection({
    quality,
    dataStrength: strength,
    execution: execution.state,
    scheduledKind: scheduled.actionKind,
    ...(eventType ? { eventType } : {})
  });
  if (observing) {
    direction = { actionKind: input.previousActionKind ?? direction.actionKind, interruptDecision: "observe" };
  }
  direction = { ...direction, actionKind: overlayClosureKind(present, direction.actionKind) };
  const triggerType: DiagnosisTriggerType = eventType && direction.interruptDecision === "interrupt" ? eventType : "scheduled_15m";
  const family = issueFamily(triggerType, direction.actionKind, execution.state);
  let issueKey = buildIssueKey(role, input.currentProductName, family);
  const prevFamily = input.previousIssueKey ? familyFromIssueKey(input.previousIssueKey) : undefined;
  const previousOpen = Boolean(input.previousIssueKey) && input.previousResolution !== "executed" && !observing;
  if (previousOpen && prevFamily && EVENT_FAMILIES.has(prevFamily) && triggerType === "scheduled_15m") {
    direction = {
      actionKind: overlayClosureKind(present, input.previousActionKind ?? eventDefaultKind(prevFamily)),
      interruptDecision: "observe"
    };
    issueKey = input.previousIssueKey!;
  } else if (input.previousIssueKey === issueKey && direction.interruptDecision === "interrupt" && !observing) {
    direction = { ...direction, interruptDecision: input.previousResolution === "executed" ? "observe" : "interrupt" };
  }
  const windowMinutes = triggerType === "scheduled_15m" ? 15 : 5;
  const windowStartAt = windowMinutes === 15
    ? scheduled.windowStartAt
    : (input.recent?.startAt ?? scheduled.windowStartAt);
  const windowEndAt = windowMinutes === 15
    ? scheduled.windowEndAt
    : (input.recent?.endAt ?? scheduled.windowEndAt);
  const spendFen = scheduled.current.adSpendFen;
  const prevSpendFen = scheduled.previous?.adSpendFen;
  const clicks = scheduled.current.productClicks;
  const paid = scheduled.current.paidOrders;
  const citedSpend: DiagnosisWindow["verdict"]["citedNumbers"] = [
    ...(spendFen !== undefined ? [{ label: "这15分钟消耗", value: yuan(spendFen), unit: "元" as const }] : []),
    ...(prevSpendFen !== undefined ? [{ label: "上一刻消耗", value: yuan(prevSpendFen), unit: "元" as const }] : []),
    ...(clicks !== undefined ? [{ label: "商品点击", value: clicks, unit: "次" as const }] : []),
    ...(paid !== undefined ? [{ label: "支付订单", value: paid, unit: "单" as const }] : []),
    { label: "窗口分钟", value: windowMinutes, unit: "分钟" }
  ].slice(0, 6);

  const convertJudged = clicks !== undefined && clicks >= MIN_CLICKS_FOR_CONVERT;
  const missingLabels = execution.missingKeys.slice(0, 4).map(speechLabel);
  const heard = present.filter((key) => !execution.missingKeys.includes(key)).slice(0, 6).map(speechLabel);

  let what = scheduled.verdict.text;
  let why = scheduled.evidence[0]?.text ?? scheduled.verdict.text;
  let actionText = scheduled.action.text;
  let watch = scheduled.watchNext.text;

  if (dataIncomplete) {
    const copy = incompleteDiagnosisCopy(incompleteGroups);
    what = copy.what;
    why = copy.why;
    actionText = "暂不调整。先恢复停更的指标组，再看下一个完整窗口。";
    watch = "恢复新鲜数据后再看曝光、点击和支付。";
  } else if (quality.statusOnly) {
    what = "数据源或转写当前不可用，先看系统状态，不判断经营好坏。";
    why = "罗盘、千川或音频未处于可判断状态，不能生成经营建议。";
    actionText = "暂不调整。先恢复大屏或转写，再看下一个完整窗口。";
    watch = "恢复新鲜数据后再看曝光、点击和支付。";
  } else if (previousOpen && prevFamily && EVENT_FAMILIES.has(prevFamily) && triggerType === "scheduled_15m") {
    why = "上一件高优先级事件还没结束，这15分钟先不另开新行动。";
    actionText = direction.actionKind === "retain"
      ? "继续把人留住，先不要另开成交或投放动作。"
      : "继续完成上一张行动，先不另开新问题。";
    watch = "未来5分钟先看上一张行动的领先指标有没有稳住。";
  } else if (execution.state === "complete" && strength === "weak") {
    why = "讲解闭环已齐，但点击或支付还偏弱，商品、机制或流量匹配待复核。";
    actionText = "暂不调整，继续观察，不要机械重复同一段讲解。";
    watch = "下一个完整15分钟再看点击和支付有没有变化。";
  } else if (execution.state === "complete" && strength === "insufficient") {
    what = "本窗还没有足够样本判断转化。";
    why = "讲解闭环已齐，先保持一轮继续收集点击和支付。";
    actionText = "暂不调整，继续观察，不强判转化好坏。";
    watch = "下一个完整15分钟再看有没有形成可判断样本。";
  } else if (direction.interruptDecision === "observe" && direction.actionKind === "hold" && execution.state === "complete") {
    what = scheduled.verdict.text;
    why = "讲解闭环已齐，当前窗口没有形成值得打断的问题。";
    actionText = "暂不调整，继续观察，不要机械重复同一段讲解。";
    watch = "下一个完整15分钟再看点击和支付有没有变化。";
  } else if (execution.state === "incomplete" && strength === "good") {
    why = heard.length
      ? `${heard.join("、")}已经讲到；转写里还缺${missingLabels.join("、") || "收口指令"}。当前数据没有掉档，先记下这个缺口，不鼓励省略。`
      : `转写里还缺${missingLabels.join("、") || "收口指令"}。当前数据没有掉档，先记下这个缺口。`;
    actionText = "继续按当前节奏讲，但下一轮把缺失的收口要点补上。";
    watch = "下一个完整15分钟再看收口要点有没有补齐。";
  } else if (execution.state === "incomplete" && !convertJudged) {
    const spendLine = spendFen !== undefined && prevSpendFen !== undefined
      ? `消耗从 ${yuan(prevSpendFen)} 元到 ${yuan(spendFen)} 元。`
      : spendFen !== undefined ? `这窗消耗 ${yuan(spendFen)} 元。` : "";
    const clickLine = clicks !== undefined
      ? `当前只有${clicks}次商品点击，样本还不足以判断成交承接。`
      : "点击样本还不足以判断成交承接。";
    what = `${spendLine}${clickLine}`.trim();
    why = heard.length
      ? `${heard.join("、")}已经讲到；转写里还缺${missingLabels.join("、") || "收口指令"}。`
      : `转写里还缺${missingLabels.join("、") || "收口指令"}，先不判断转化好坏。`;
    actionText = direction.actionKind === "click_cta"
      ? "保持当前商品，补齐保障后立即接小黄车指令，不要继续展开成分。"
      : "保持当前商品，补齐保障和小黄车指令再收口，不要继续展开成分。";
    watch = "未来5分钟先看商品点击是否增加；满下一个15分钟后再判断支付承接。";
  } else if (triggerType === "event_traffic_drop") {
    what = "观看或在线在最近几分钟明显下跌。";
    why = "滚动窗口相对上一切片下降已经达到可确认幅度，先把人接住。";
    actionText = "缩短当前段落，用一句利益点和互动把人留住。";
    watch = "未来5分钟先看在线和观看有没有止跌。";
  } else if (triggerType === "event_click_no_pay") {
    what = `商品点击已有 ${clicks ?? 0} 次，支付还没有跟上。`;
    why = "点击已经达到可判断样本，支付未跟上，先补成交收口，不改投放。";
    actionText = "保持当前商品，把保障和购买指令讲清楚。";
    watch = "未来5分钟先看支付订单有没有出现。";
  }

  if (what.includes("转化差") || why.includes("转化差")) {
    what = what.replace(/转化差/g, "样本还不够判断");
    why = why.replace(/转化差/g, "样本还不够判断");
  }

  const previousActionOutcome = observing
    ? "observing" as const
    : notEvaluated
      ? "not_evaluated" as const
      : undefined;

  const cardWhat = finding("what", what.slice(0, 400), citedSpend);
  const cardWhy = finding("why", why.slice(0, 400), citedSpend.slice(0, 4));
  const cardAction = finding("action", actionText.slice(0, 400), citedSpend.slice(0, 4));
  const cardWatch = finding("watch", watch.slice(0, 400), [{ label: "观察分钟", value: DIAGNOSIS_OBSERVATION_MINUTES, unit: "分钟" }]);

  return diagnosisWindowSchema.parse({
    ...scheduled,
    windowMinutes,
    windowStartAt,
    windowEndAt,
    coverage: windowMinutes === 15 ? scheduled.coverage : "partial",
    actionKind: direction.actionKind,
    confidence: quality.statusOnly ? "unknown" : execution.state === "incomplete" || direction.interruptDecision === "interrupt" ? "leaning" : scheduled.confidence,
    funnelStage: triggerType === "event_traffic_drop" ? "entry" : triggerType === "event_click_no_pay" ? "convert" : scheduled.funnelStage,
    verdict: cardWhat,
    evidence: [cardWhy],
    action: cardAction,
    watchNext: cardWatch,
    pending: direction.interruptDecision === "observe" && !(execution.state === "complete" && strength === "weak")
      ? []
      : execution.state === "complete" && strength === "weak"
        ? [{ id: "review-fit", text: "商品、机制或流量匹配待复核，先不要机械重复同一段讲解。", citedNumbers: citedSpend.slice(0, 2) }]
        : scheduled.pending,
    conclusions: [cardWhat, cardWhy].slice(0, 3),
    nextWindowSuggestion: cardAction,
    triggerType,
    executionState: execution.state,
    interruptDecision: direction.interruptDecision,
    productRole: confounded ? "unknown" : role,
    productRoleConfounded: confounded,
    issueKey,
    observationMinutes: DIAGNOSIS_OBSERVATION_MINUTES,
    ...(previousActionOutcome ? { previousActionOutcome } : {}),
    ...(dataIncomplete ? { dataCompleteness: "data_incomplete" as const, incompleteGroups: incompleteGroups.slice(0, 8) } : {})
  });
}

export function buildDiagnosisEvidencePacket(diagnosis: DiagnosisWindow, extras: {
  triggerAt: string;
  dataFreshness: DiagnosisQuality["dataFreshness"];
  quotes?: readonly string[];
}): DiagnosisEvidencePacket {
  return diagnosisEvidencePacketSchema.parse({
    triggerType: diagnosis.triggerType ?? "scheduled_15m",
    triggerAt: extras.triggerAt,
    windowStartAt: diagnosis.windowStartAt,
    windowEndAt: diagnosis.windowEndAt,
    dataFreshness: extras.dataFreshness,
    productContext: {
      role: diagnosis.productRole ?? "unknown",
      confounded: diagnosis.productRoleConfounded ?? false,
      ...(diagnosis.current.currentProductName ? { productName: diagnosis.current.currentProductName } : {})
    },
    funnelStage: diagnosis.funnelStage,
    executionState: diagnosis.executionState ?? "unknown",
    confidence: diagnosis.confidence,
    currentMetrics: {
      ...(diagnosis.current.adSpendFen !== undefined ? { adSpendFen: diagnosis.current.adSpendFen } : {}),
      ...(diagnosis.current.productClicks !== undefined ? { productClicks: diagnosis.current.productClicks } : {}),
      ...(diagnosis.current.paidOrders !== undefined ? { paidOrders: diagnosis.current.paidOrders } : {})
    },
    previousMetrics: {
      ...(diagnosis.previous?.adSpendFen !== undefined ? { adSpendFen: diagnosis.previous.adSpendFen } : {})
    },
    historicalBaseline: {},
    speechPresentKeys: diagnosis.speechPresentKeys,
    speechMissingKeys: missingExpectedSpeech(
      diagnosis.productRole ?? "unknown",
      diagnosis.funnelStage === "maintain" || diagnosis.funnelStage === "wait" || diagnosis.funnelStage === "aov" || diagnosis.funnelStage === "spend_spike"
        ? []
        : STAGE_SPEECH_EXPECTATIONS[diagnosis.funnelStage],
      diagnosis.speechPresentKeys
    ),
    relevantQuotes: [...(extras.quotes ?? [])].slice(0, 4),
    lockedActionKind: diagnosis.actionKind,
    interruptDecision: diagnosis.interruptDecision ?? "observe",
    unknowns: [
      ...(diagnosis.interruptDecision === "status_only" ? ["source"] : []),
      ...(diagnosis.productRole === "unknown" ? ["role_unknown"] : []),
      ...(diagnosis.productRoleConfounded ? ["role_confounded"] : []),
      ...(diagnosis.coverage !== "full" ? ["incomplete_window"] : []),
      ...(diagnosis.current.speechFinalCount <= 0 ? ["speech"] : []),
      ...(diagnosis.hourBaseline.gmvFen.status === "sampleInsufficient" ? ["baseline_insufficient"] : [])
    ].slice(0, 8),
    ...(diagnosis.previousActionOutcome ? { previousActionOutcome: diagnosis.previousActionOutcome } : {}),
    ...(diagnosis.dataCompleteness ? { dataCompleteness: diagnosis.dataCompleteness } : {})
  });
}
