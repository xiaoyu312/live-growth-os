import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  liveCompassActionFeedbackSchema, liveCompassActionResolutionSchema, liveCompassActionSchema, liveCompassMetricSnapshotSchema, liveEventSchema, livePilotCreateResponseSchema, livePilotReattachResponseSchema, liveProductContextPayloadSchema, liveRecoveryRequestSchema, liveSessionCatalogSchema, pageRuntimeStateSchema, qianchuanMetricSnapshotSchema, transcriptSegmentSchema, type LiveProductRole,
  type AnchorReview, type AnchorReviewRequest, type LiveCompassAction, type LiveCompassActionFeedback, type LiveCompassActionResolution, type LiveCompassMetricSnapshot, type LiveEvent, type LiveSessionCatalog, type PageRuntimeState, type QianchuanMetricSnapshot, type RecoveryHistoryEntry, type Session, type SessionReview, type SessionReviewRequest, type SourceGroupHealth, type SourceHealthReport
} from "@live-growth/contracts";
import { COMPASS_LIVE_ENDPOINTS, COMPASS_LIVE_MAPPING_VERSION, QIANCHUAN_LIVE_ENDPOINTS, QIANCHUAN_LIVE_MAPPING_VERSION, QIANCHUAN_OFFICIAL_LIVE_ENDPOINT, QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION } from "@live-growth/source-adapters";
import {
  aggregateLiveWindows,
  qianchuanSourceIdentity,
  completedWindowOptions,
  LIVE_WINDOW_MS,
  diagnoseLiveOperating,
  latestCompletedWindow,
  latestProductRole,
  detectDiagnosisEvents,
  recentSliceFromQianchuanSnapshots,
  type DiagnoseLiveOperatingInput,
  liveHourToDateFromWindows,
  compareLiveHourToBaseline,
  replayLivePilotEngine,
  liveCompassActionFromMvp,
  isPaymentGapIssue,
  UNKNOWN_PRODUCT_ID,
  stateShareInWindow,
  speechPresentInWindow,
  assembleAnchorReview,
  assembleSessionReview,
  assertAnchorReviewRange,
  AnchorReviewRangeError,
  SessionReviewRangeError,
  SESSION_REVIEW_MAX_WINDOWS,
  buildAnchorSessionReport,
  parseReferenceScriptText,
  ReferenceScriptParseError,
  REFERENCE_SCRIPT_V1,
  aggregateScriptIteration,
  classifySpeechTags,
  ASR_HOTWORDS,
  COMPASS_STALE_FLOOR_MS,
  QIANCHUAN_STALE_FLOOR_MS,
  buildSourceHealthFromSnapshots,
  compatibleSourceStatus,
  COMPASS_RECOVER_PROMPT,
  QIANCHUAN_RECOVER_PROMPT,
  QIANCHUAN_RECOVERED
} from "@live-growth/rules";
import type { AnchorSessionReport, DiagnosisWindow, HistoricalHourRoomAggregate, LiveHourVsBaseline, LiveWindowAggregate, ScriptIterationReport } from "@live-growth/contracts";
import type { SessionService } from "./session-service";
import { TencentAsrConnection, HY_ASR_SEGMENT_LIMIT_MS, isHyAsrEngine, resolveTencentAsrCredentials, resolveTencentAsrEngineModelType, resolveTencentAsrHotwordInjection, type TencentAsrConnection as AsrConnection, type TencentAsrFinal } from "./tencent-asr";
import { InvalidLifecycleError } from "./session-service";
import type { EventStore } from "./storage";
import { WebSocket } from "ws";
import type { QianchuanOfficialLiveSourceLike, QianchuanOfficialLiveStatus } from "./qianchuan-official-live";

type LivePilotRecord = {
  session: Session;
  tenantId: string;
  tokenHash: Buffer;
  needsReconnect: boolean;
  stopping: boolean;
  createdAt: string;
  lastMetricAt?: string;
  lastAudioAt?: string;
  firstAudioAt?: string;
  lastFinalAt?: string;
  latestMetric?: LiveCompassMetricSnapshot;
  latestQianchuanMetric?: QianchuanMetricSnapshot;
  lastQianchuanMetricAt?: string;
  asr: AsrConnection | undefined;
  asrEpoch?: number;
  asrStarting?: boolean;
  asrRotateTimer?: ReturnType<typeof setTimeout>;
  audioSocket?: WebSocket;
  asrState: "not_configured" | "connecting" | "open" | "closed" | "error";
  asrErrorCode?: string;
  finalCount: number;
  audioFrames: number;
  nonSilentAudioFrames: number;
  audioEnergyBand: "silent" | "low" | "normal" | "unknown";
  pageRuntime?: { qianchuan?: PageRuntimeState; compass?: PageRuntimeState };
  recoveryHistory?: RecoveryHistoryEntry[];
  pendingRecovery?: { source: "qianchuan" | "compass"; requestedAt: string; confirm: boolean };
  groupHealthPrevious?: SourceGroupHealth[];
  recovering?: boolean;
  lastRecoveredAt?: string;
};

export type LivePilotView = {
  session: Session;
  needsReconnect: boolean;
  latestMetric: LiveCompassMetricSnapshot | null;
  qianchuan: { status: "fresh" | "stale" | "offline" | "unknown" | "partial"; overallHealth?: SourceHealthReport["qianchuan"]["overallHealth"]; groups?: SourceGroupHealth[]; latestMetric: QianchuanMetricSnapshot | null; metricHistory: QianchuanMetricSnapshot[]; lastMetricAt?: string; sourceKind: "official_api" | "browser_extension" | "none"; officialApi?: QianchuanOfficialLiveStatus };
  metricHistory: LiveCompassMetricSnapshot[];
  metricFieldTimes: Record<string, string>;
  metricComparisons: Record<string, LiveMetricComparison>;
  latestTranscript: { text: string; startMs: number; endMs: number; at: string } | null;
  recentTranscripts: Array<{ at: string; text: string }>;
  source: {
    status: "fresh" | "stale" | "offline" | "unknown" | "partial";
    overallHealth?: SourceHealthReport["compass"]["overallHealth"];
    groups?: SourceGroupHealth[];
    lastMetricAt?: string;
    mappingVersion: string;
    firstMetricTimedOut: boolean;
    coverage: LivePilotFieldCoverage;
  };
  audio: { status: "not_started" | "connecting" | "active" | "stale" | "offline" | "error"; transcriptionStatus: "not_started" | "waiting_final" | "active" | "stale" | "offline" | "error"; lastAudioAt?: string; lastFinalAt?: string; finalCount: number; audioFrames: number; nonSilentAudioFrames: number; energyBand: "silent" | "low" | "normal" | "unknown"; firstFinalTimedOut: boolean; errorCode?: string };
  action: LiveCompassAction | null;
  actionHistory: LiveCompassActionHistoryItem[];
  actionEvidence: LivePilotActionEvidence | null;
  eventMarkers: Array<{ at: string; type: "metric" | "speech" | "action"; label: string }>;
  productRole: LiveProductRole;
  sourceGroupHealth?: SourceHealthReport;
  pageRuntimeState?: { qianchuan?: PageRuntimeState; compass?: PageRuntimeState };
  recoveryHistory?: RecoveryHistoryEntry[];
  pendingRecovery?: { source: "qianchuan" | "compass"; requestedAt: string; confirm: boolean };
  lastRecoveredAt?: string;
  recovering?: boolean;
};

export type LivePilotFieldCoverageGroup = { available: number; total: number; missing: string[] };
export type LivePilotFieldCoverage = { core: LivePilotFieldCoverageGroup; fiveMinute: LivePilotFieldCoverageGroup; product: LivePilotFieldCoverageGroup };
export type LivePilotActionEvidence = {
  metricSnapshot: LiveCompassMetricSnapshot | null;
  quotedSpeech: Array<{ at: string; text: string }>;
  observationStatus: "pending" | "observed" | "insufficient_sample" | "confounded";
};

export type LiveMetricComparison = {
  semantic: "instant" | "cumulative" | "rolling" | "rate";
  status: "baseline" | "changed" | "unchanged" | "reset";
  reason: "first_sample" | "same_timestamp" | "different_source" | "different_product" | "unknown_product" | "matched" | "counter_reset";
  delta?: number;
  previousObservedAt?: string;
};

export type LiveCompassActionHistoryItem = LiveCompassAction & {
  resolution?: {
    status: "executed" | "not_executed" | "not_applicable" | "resolved";
    operatorId?: string;
    at: string;
    reason?: string;
  };
  actionEvidence?: LivePilotActionEvidence;
};

const TOKEN_TTL_MS = 18 * 60 * 60 * 1000;
const STALE_AFTER_MS = COMPASS_STALE_FLOOR_MS;
// 2026-08-14 真实现场：千川 statQuery 跟随大屏自身轮询，相邻完整快照约 31～61 秒。
// 45 秒阈值会在正常间隔内误报 stale；放宽到 90 秒覆盖一轮加抖动。罗盘 core_data 仍按 45 秒。见 D030。
const QIANCHUAN_STALE_AFTER_MS = QIANCHUAN_STALE_FLOOR_MS;
const AUDIO_STALE_AFTER_MS = 10_000;

function hasFreshOfficialQianchuanMetric(record: LivePilotRecord, nowMs = Date.now()): boolean {
  const metric = record.latestQianchuanMetric;
  if (!metric
    || metric.mappingVersion !== QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION
    || metric.sourceEndpoint !== QIANCHUAN_OFFICIAL_LIVE_ENDPOINT
    || metric.dataStatus !== "fresh") return false;
  const observedAtMs = Date.parse(metric.observedAt);
  return Number.isFinite(observedAtMs)
    && observedAtMs <= nowMs
    && nowMs - observedAtMs <= QIANCHUAN_STALE_AFTER_MS;
}

const LIVE_METRIC_SEMANTICS: Partial<Record<keyof LiveCompassMetricSnapshot, LiveMetricComparison["semantic"]>> = {
  onlineSnapshot: "instant",
  sessionPaidGmvFen: "cumulative",
  adSpendFen: "cumulative",
  paidBuyerCount: "cumulative",
  paidItemCount: "cumulative",
  watchToPaidRate: "rate",
  productClickToPaidRate: "rate",
  averageWatchDurationSec: "rolling",
  roomEnterCount5m: "rolling",
  userPaidGmvFen5m: "rolling",
  productClickCount: "rolling",
  productPayGmvFen: "cumulative",
  unpaidOrderCount: "cumulative",
  productPaidGmvFen: "cumulative"
};
const PRODUCT_COMPARISON_FIELDS = new Set<keyof LiveCompassMetricSnapshot>(["productClickCount", "productPayGmvFen", "unpaidOrderCount", "productPaidGmvFen"]);
const PRODUCT_IDENTITY_FIELDS = new Set<keyof LiveCompassMetricSnapshot>(["productName", "currentProductName"]);

function productNameOf(metric: LiveCompassMetricSnapshot): string | undefined {
  return metric.currentProductName ?? metric.productName;
}

export function compareLiveMetricSnapshots(field: keyof LiveCompassMetricSnapshot, current: LiveCompassMetricSnapshot, previous?: LiveCompassMetricSnapshot): LiveMetricComparison | undefined {
  const semantic = LIVE_METRIC_SEMANTICS[field];
  const currentValue = current[field];
  if (!semantic || typeof currentValue !== "number") return undefined;
  if (!previous || typeof previous[field] !== "number") return { semantic, status: "baseline", reason: "first_sample" };
  if (current.observedAt <= previous.observedAt) return { semantic, status: "baseline", reason: "same_timestamp" };
  if (current.sourceEndpoint !== previous.sourceEndpoint) return { semantic, status: "baseline", reason: "different_source" };
  if (PRODUCT_COMPARISON_FIELDS.has(field)) {
    const currentProduct = productNameOf(current);
    const previousProduct = productNameOf(previous);
    if (!currentProduct || !previousProduct) return { semantic, status: "baseline", reason: "unknown_product" };
    if (currentProduct !== previousProduct) return { semantic, status: "baseline", reason: "different_product" };
  }
  const delta = currentValue - (previous[field] as number);
  if (semantic === "cumulative" && delta < 0) return { semantic, status: "reset", reason: "counter_reset", previousObservedAt: previous.observedAt };
  if (delta === 0) return { semantic, status: "unchanged", reason: "matched", delta: 0, previousObservedAt: previous.observedAt };
  return { semantic, status: "changed", reason: "matched", delta, previousObservedAt: previous.observedAt };
}
export const LIVE_AUDIO_PACKET_BYTES = 6_400;
export function isLiveAudioPacket(data: Uint8Array): boolean { return data.byteLength === LIVE_AUDIO_PACKET_BYTES; }
export function audioEnergyBandFromPcm(data: Uint8Array): "silent" | "low" | "normal" {
  if (data.byteLength < 2) return "silent";
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength - (data.byteLength % 2));
  let sum = 0;
  for (let index = 0; index < view.byteLength; index += 2) {
    const sample = view.getInt16(index, true) / 32768;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / Math.max(1, view.byteLength / 2));
  if (rms < 0.01) return "silent";
  if (rms < 0.08) return "low";
  return "normal";
}
const FIRST_METRIC_TIMEOUT_MS = 15_000;
const FIRST_FINAL_TIMEOUT_MS = 30_000;

export function deriveLiveTranscriptionStatus(input: {
  asrState: LivePilotRecord["asrState"];
  audioFrames: number;
  finalCount: number;
  lastFinalAt?: string;
  asrErrorCode?: string;
  nowMs: number;
}): LivePilotView["audio"]["transcriptionStatus"] {
  if (input.asrErrorCode || input.asrState === "error") return "error";
  if (input.asrState === "not_configured") return "not_started";
  if (input.asrState === "connecting") return "offline";
  if (input.asrState !== "open") return "offline";
  if (input.finalCount === 0) return input.audioFrames > 0 ? "waiting_final" : "stale";
  if (!input.lastFinalAt || input.nowMs - Date.parse(input.lastFinalAt) > AUDIO_STALE_AFTER_MS) return "stale";
  return "active";
}

export function isFirstFinalTimedOut(input: {
  asrState: LivePilotRecord["asrState"];
  audioFrames: number;
  finalCount: number;
  firstAudioAt?: string;
  nowMs: number;
}): boolean {
  return input.asrState === "open" && input.audioFrames > 0 && input.finalCount === 0 && Boolean(input.firstAudioAt) && input.nowMs - Date.parse(input.firstAudioAt!) >= FIRST_FINAL_TIMEOUT_MS;
}

function liveAsrIsActive(record: LivePilotRecord): boolean {
  return Boolean(record.asr) && (record.asrState === "connecting" || record.asrState === "open");
}

function releaseLiveAsr(record: LivePilotRecord): void {
  if (record.asrRotateTimer) {
    clearTimeout(record.asrRotateTimer);
    delete record.asrRotateTimer;
  }
  const asr = record.asr;
  record.asr = undefined;
  record.asrStarting = false;
  asr?.end();
}

function hashToken(token: string): Buffer { return createHash("sha256").update(token).digest(); }
function tokenMatches(record: LivePilotRecord, token: string): boolean {
  const actual = hashToken(token);
  return actual.length === record.tokenHash.length && timingSafeEqual(actual, record.tokenHash);
}
function now(): string { return new Date().toISOString(); }
function safeEndpoint(endpoint: string): boolean {
  return new Set<string>([
    COMPASS_LIVE_ENDPOINTS.coreData,
    COMPASS_LIVE_ENDPOINTS.fiveMinuteData,
    COMPASS_LIVE_ENDPOINTS.liveBaseInfo,
    COMPASS_LIVE_ENDPOINTS.product,
    COMPASS_LIVE_ENDPOINTS.productExplainDetail,
    COMPASS_LIVE_ENDPOINTS.domFallback
  ]).has(endpoint);
}
function safeQianchuanEndpoint(endpoint: string): boolean {
  return endpoint === QIANCHUAN_LIVE_ENDPOINTS.statQuery || endpoint === QIANCHUAN_OFFICIAL_LIVE_ENDPOINT;
}
export function hasContinuousSpeech(events: LiveEvent[], metricAt: number): boolean {
  const segments = events.flatMap((event) => {
    if (event.kind !== "speech.final" || Date.parse(event.eventAt) > metricAt) return [];
    const payload = transcriptSegmentSchema.safeParse(event.payload);
    return payload.success && payload.data.text.trim() ? [{ eventAt: Date.parse(event.eventAt), segment: payload.data }] : [];
  }).sort((a, b) => a.eventAt - b.eventAt);
  if (segments.length < 2) return false;
  const first = segments[0]!;
  const last = segments.at(-1)!;
  if (first.eventAt > metricAt - 172_000 || last.eventAt < metricAt - 8_000) return false;
  for (let index = 1; index < segments.length; index += 1) if (segments[index]!.eventAt - segments[index - 1]!.eventAt > 8_000) return false;
  return true;
}

type ActionResolution = LiveCompassActionFeedback | LiveCompassActionResolution;

function actionFamily(issueKey: string): string {
  if (isPaymentGapIssue(issueKey)) return "payment-gap";
  return issueKey;
}

function issueIsCleared(resolution: ActionResolution | undefined): boolean {
  return resolution?.status === "resolved";
}

export type LiveAsrFinalPersistenceContext = {
  tenantId: string;
  stopping: boolean;
  finalCount: number;
  lastFinalAt?: string;
};

export async function persistLiveAsrFinal(service: SessionService, context: LiveAsrFinalPersistenceContext, sessionId: string, result: TencentAsrFinal): Promise<boolean> {
  if (context.stopping) return false;
  const session = await service.get(sessionId);
  if (session.status !== "running") return false;
  if (context.stopping) return false;
  const id = randomUUID();
  const segment = transcriptSegmentSchema.parse({
    id, tenantId: context.tenantId, sessionId, startMs: Math.max(0, result.startMs ?? 0), endMs: Math.max(result.startMs ?? 0, result.endMs ?? result.startMs ?? 0),
    text: result.text, isFinal: true, tags: classifySpeechTags(result.text), sourceEventId: id
  });
  try {
    const accepted = await service.ingest(liveEventSchema.parse({
      schemaVersion: 1, eventId: id, dedupeKey: `asr:${sessionId}:${segment.startMs}:${segment.endMs}:${createHash("sha256").update(segment.text).digest("hex").slice(0, 12)}`,
      tenantId: context.tenantId, sessionId, eventAt: now(), capturedAt: now(), ingestedAt: now(), source: "asr", kind: "speech.final", provisional: false,
      payload: segment, metadata: { provider: "tencent-cloud", version: "realtime-wss-v2", latencyMs: result.latencyMs }
    }));
    if (accepted) {
      context.finalCount += 1;
      context.lastFinalAt = now();
    }
    return accepted;
  } catch (error) {
    if (context.stopping || error instanceof InvalidLifecycleError) return false;
    throw error;
  }
}

function actionResolutionMap(events: LiveEvent[]): Map<string, ActionResolution> {
  const resolutions = new Map<string, ActionResolution>();
  for (const event of events) {
    if (event.kind === "live.compass.action.feedback") {
      const parsed = liveCompassActionFeedbackSchema.safeParse(event.payload);
      if (parsed.success) resolutions.set(parsed.data.actionId, parsed.data);
    } else if (event.kind === "live.compass.action.resolved") {
      const parsed = liveCompassActionResolutionSchema.safeParse(event.payload);
      if (parsed.success) resolutions.set(parsed.data.actionId, parsed.data);
    }
  }
  return resolutions;
}

function actionHistoryItem(action: LiveCompassAction, resolution?: ActionResolution): LiveCompassActionHistoryItem {
  if (!resolution) return action;
  if (resolution.status === "resolved") return { ...action, resolution: { status: "resolved", at: resolution.resolvedAt, reason: resolution.reason } };
  return { ...action, resolution: { status: resolution.status, at: resolution.createdAt, operatorId: resolution.operatorId } };
}

const CORE_COVERAGE_FIELDS: Array<[keyof LiveCompassMetricSnapshot, string]> = [
  ["sessionPaidGmvFen", "直播间支付金额"], ["onlineSnapshot", "当前在线"], ["paidBuyerCount", "支付人数"],
  ["productClickToPaidRate", "点击到支付"], ["watchToPaidRate", "观看到支付"], ["adSpendFen", "投放消耗"]
];
const FIVE_MINUTE_COVERAGE_FIELDS: Array<[keyof LiveCompassMetricSnapshot, string]> = [
  ["roomEnterCount5m", "直播间进入"], ["userPaidGmvFen5m", "近5分钟支付金额"], ["productClickCount", "近5分钟商品点击"], ["unpaidOrderCount", "未支付订单"]
];
const PRODUCT_COVERAGE_FIELDS: Array<[keyof LiveCompassMetricSnapshot, string]> = [
  ["currentProductName", "当前商品"], ["productPayGmvFen", "当前商品支付金额"]
];

function coverageGroup(metric: LiveCompassMetricSnapshot | null, fields: Array<[keyof LiveCompassMetricSnapshot, string]>): LivePilotFieldCoverageGroup {
  const missing = fields.filter(([key]) => metric?.[key] === undefined).map(([, label]) => label);
  return { available: fields.length - missing.length, total: fields.length, missing };
}

function fieldCoverage(metric: LiveCompassMetricSnapshot | null): LivePilotFieldCoverage {
  return {
    core: coverageGroup(metric, CORE_COVERAGE_FIELDS),
    fiveMinute: coverageGroup(metric, FIVE_MINUTE_COVERAGE_FIELDS),
    product: coverageGroup(metric, PRODUCT_COVERAGE_FIELDS)
  };
}

function actionEvidence(action: LiveCompassAction, events: LiveEvent[], resolution?: ActionResolution): LivePilotActionEvidence {
  const referenced = new Set(action.evidenceEventIds);
  const metricSnapshot = [...events].reverse().flatMap((event) => {
    if (event.kind !== "live.compass.metric" || !referenced.has(event.eventId)) return [];
    const parsed = liveCompassMetricSnapshotSchema.safeParse(event.payload);
    return parsed.success ? [parsed.data] : [];
  })[0] ?? null;
  const quotedSpeech = events.flatMap((event) => {
    if (event.kind !== "speech.final" || !referenced.has(event.eventId)) return [];
    const parsed = transcriptSegmentSchema.safeParse(event.payload);
    return parsed.success ? [{ at: event.eventAt, text: parsed.data.text }] : [];
  }).slice(-3);
  const observationStatus = resolution?.status === "resolved" ? "observed" : action.confidence === "low" ? "insufficient_sample" : "pending";
  return { metricSnapshot, quotedSpeech, observationStatus };
}

export class LivePilotNotFoundError extends Error {}
export class LivePilotUnauthorizedError extends Error {}
export class LivePilotUnavailableError extends Error {}
export class LivePilotStoppedError extends Error {}
export class LivePilotActionNotFoundError extends Error {}
export class LivePilotActionFeedbackConflictError extends Error {}
export class LivePilotReviewError extends Error {}

export type LiveOfficialSourceResumeStatus = {
  state: "not_started" | "not_configured" | "none" | "resuming" | "resumed" | "ambiguous" | "failed";
  runningSessions: number;
};

export class LivePilotService {
  private readonly records = new Map<string, LivePilotRecord>();
  private readonly localViewListeners = new Map<string, Set<() => void>>();
  private readonly officialSource: QianchuanOfficialLiveSourceLike | undefined;
  private officialActiveSessionId?: string;
  private officialActivationQueue: Promise<void> = Promise.resolve();
  private officialResume: LiveOfficialSourceResumeStatus = { state: "not_started", runningSessions: 0 };
  private closing = false;

  constructor(private readonly service: SessionService, private readonly store: EventStore, officialSource?: QianchuanOfficialLiveSourceLike, private readonly captureOnly = false) {
    this.officialSource = officialSource;
  }

  private emitLocalView(sessionId: string): void {
    for (const listener of this.localViewListeners.get(sessionId) ?? []) listener();
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const record of this.records.values()) {
      record.stopping = true;
      delete record.audioSocket;
      releaseLiveAsr(record);
    }
    await this.officialActivationQueue.catch(() => undefined);
    delete this.officialActiveSessionId;
    await this.officialSource?.close();
    this.officialResume = { state: "none", runningSessions: 0 };
  }

  private officialSourceFreshFor(record: LivePilotRecord, nowMs = Date.now()): boolean {
    return !this.closing
      && this.officialActiveSessionId === record.session.id
      && this.officialSource?.isFresh(nowMs) === true
      && hasFreshOfficialQianchuanMetric(record, nowMs);
  }

  private activateOfficialSource(record: LivePilotRecord): Promise<void> {
    const run = this.officialActivationQueue.then(async () => {
      if (this.closing || !this.officialSource || !this.officialSource.status().configured || record.session.status !== "running") return;
      if (this.officialActiveSessionId === record.session.id) return;
      if (this.officialActiveSessionId) await this.officialSource.stop(this.officialActiveSessionId);
      delete this.officialActiveSessionId;
      try {
        await this.officialSource.start(record.session.id, async (snapshot) => { await this.ingestOfficialMetric(record.session.id, snapshot); });
        this.officialActiveSessionId = record.session.id;
        this.officialResume = { state: "resumed", runningSessions: 1 };
      } catch (error) {
        this.officialResume = { state: "failed", runningSessions: 1 };
        throw error;
      }
    });
    this.officialActivationQueue = run.catch(() => undefined);
    return run;
  }

  private deactivateOfficialSource(sessionId: string): Promise<void> {
    const run = this.officialActivationQueue.then(async () => {
      if (!this.officialSource || this.officialActiveSessionId !== sessionId) return;
      await this.officialSource.stop(sessionId);
      delete this.officialActiveSessionId;
      this.officialResume = { state: "none", runningSessions: 0 };
    });
    this.officialActivationQueue = run.catch(() => undefined);
    return run;
  }

  officialSourceResumeStatus(): LiveOfficialSourceResumeStatus {
    return { ...this.officialResume };
  }

  async resumeRunningSource(): Promise<LiveOfficialSourceResumeStatus> {
    let running: Session[];
    try {
      running = (await this.store.listSessions("live_compass")).filter((session) => session.status === "running");
    } catch {
      this.officialResume = { state: "failed", runningSessions: 0 };
      return this.officialSourceResumeStatus();
    }
    if (this.closing) return this.officialSourceResumeStatus();
    if (!this.officialSource || !this.officialSource.status().configured) {
      this.officialResume = { state: "not_configured", runningSessions: running.length };
      return this.officialSourceResumeStatus();
    }
    if (running.length === 0) {
      this.officialResume = { state: "none", runningSessions: 0 };
      return this.officialSourceResumeStatus();
    }
    if (running.length > 1) {
      this.officialResume = { state: "ambiguous", runningSessions: running.length };
      return this.officialSourceResumeStatus();
    }
    this.officialResume = { state: "resuming", runningSessions: 1 };
    try {
      const record = await this.restoreRecord(running[0]!.id);
      await this.activateOfficialSource(record);
      if (this.closing) return this.officialSourceResumeStatus();
      if (this.officialActiveSessionId !== record.session.id) {
        this.officialResume = { state: "failed", runningSessions: 1 };
        return this.officialSourceResumeStatus();
      }
      this.officialResume = { state: "resumed", runningSessions: 1 };
    } catch {
      this.officialResume = { state: "failed", runningSessions: 1 };
    }
    return this.officialSourceResumeStatus();
  }

  async create(): Promise<{ sessionId: string; pairToken: string; dashboardPath: string }> {
    const session = await this.service.create({ name: "直播实时驾驶舱", scenario: "live_compass", seed: 0, includeCommentIntent: false });
    const started = await this.service.start(session.id, 1);
    const pairToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(pairToken);
    const createdAt = started.createdAt;
    await this.store.saveLivePilotAuth(started.id, { tokenHashHex: tokenHash.toString("hex"), createdAt });
    const record: LivePilotRecord = { session: { ...started, status: "running", startedAt: started.startedAt ?? now() }, tenantId: started.tenantId, tokenHash, needsReconnect: false, stopping: false, createdAt, asr: undefined, asrState: "not_configured", finalCount: 0, audioFrames: 0, nonSilentAudioFrames: 0, audioEnergyBand: "unknown" };
    this.records.set(started.id, record);
    void this.activateOfficialSource(record).catch(() => undefined);
    return livePilotCreateResponseSchema.parse({ sessionId: started.id, pairToken, dashboardPath: `/live/${started.id}` });
  }

  async reattach(sessionId: string, token: string): Promise<{ sessionId: string; dashboardPath: string }> {
    const record = await this.authorize(sessionId, token);
    await this.ensureRunning(record);
    void this.activateOfficialSource(record).catch(() => undefined);
    return livePilotReattachResponseSchema.parse({ sessionId: record.session.id, dashboardPath: `/live/${record.session.id}` });
  }

  private expired(createdAt: string): boolean {
    return Date.now() - Date.parse(createdAt) > TOKEN_TTL_MS;
  }

  private async restoreRecord(sessionId: string): Promise<LivePilotRecord> {
    const existing = this.records.get(sessionId);
    if (existing) {
      if (this.expired(existing.createdAt)) throw new LivePilotNotFoundError(`真实试点不存在：${sessionId}`);
      return existing;
    }
    const session = await this.service.get(sessionId);
    if (session.scenario !== "live_compass") throw new LivePilotNotFoundError(`真实试点不存在：${sessionId}`);
    if (this.expired(session.createdAt)) throw new LivePilotNotFoundError(`真实试点不存在：${sessionId}`);
    const events = await this.store.listEvents(sessionId);
    const latestMetric = [...events].reverse().find((event) => event.kind === "live.compass.metric");
    const latestQianchuanMetric = [...events].reverse().find((event) => event.kind === "live.qianchuan.metric");
    const latestSpeech = [...events].reverse().find((event) => event.kind === "speech.final");
    const auth = await this.store.loadLivePilotAuth(sessionId);
    const tokenHash = auth ? Buffer.from(auth.tokenHashHex, "hex") : hashToken(randomBytes(32).toString("hex"));
    const record: LivePilotRecord = {
      session, tenantId: session.tenantId, tokenHash,
      needsReconnect: session.status === "running",
      stopping: session.status !== "running",
      createdAt: session.createdAt,
      ...(latestMetric ? { lastMetricAt: latestMetric.eventAt, latestMetric: liveCompassMetricSnapshotSchema.parse(latestMetric.payload) } : {}),
      ...(latestQianchuanMetric ? { lastQianchuanMetricAt: latestQianchuanMetric.eventAt, latestQianchuanMetric: qianchuanMetricSnapshotSchema.parse(latestQianchuanMetric.payload) } : {}),
      ...(latestSpeech ? { lastAudioAt: latestSpeech.eventAt, lastFinalAt: latestSpeech.eventAt } : {}),
      asr: undefined, asrState: "closed", finalCount: events.filter((event) => event.kind === "speech.final").length, audioFrames: 0, nonSilentAudioFrames: 0, audioEnergyBand: "unknown"
    };
    this.records.set(sessionId, record);
    return record;
  }

  private async getForView(sessionId: string): Promise<{ record: LivePilotRecord; needsReconnect: boolean }> {
    const record = await this.restoreRecord(sessionId);
    return { record, needsReconnect: record.needsReconnect };
  }

  private async authorize(sessionId: string, token: string): Promise<LivePilotRecord> {
    const record = await this.restoreRecord(sessionId);
    if (!token || !tokenMatches(record, token)) throw new LivePilotUnauthorizedError("真实试点配对令牌无效");
    return record;
  }

  private async ensureRunning(record: LivePilotRecord): Promise<void> {
    const persisted = await this.service.get(record.session.id);
    record.session = persisted;
    if (persisted.status !== "running") throw new LivePilotStoppedError("真实直播已停止，不能继续写入");
  }

  async ingestMetric(sessionId: string, token: string, input: unknown): Promise<{ accepted: boolean; metric: LiveCompassMetricSnapshot | QianchuanMetricSnapshot }> {
    const record = await this.authorize(sessionId, token);
    await this.ensureRunning(record);
    const metricSource: "qianchuan" | "compass" = input && typeof input === "object" && (input as { metricSource?: unknown }).metricSource === "qianchuan" ? "qianchuan" : "compass";
    const metric = metricSource === "qianchuan" ? qianchuanMetricSnapshotSchema.parse(input) : liveCompassMetricSnapshotSchema.parse(input);
    if (metricSource === "qianchuan") {
      if (!safeQianchuanEndpoint(metric.sourceEndpoint)) throw new LivePilotUnavailableError("仅接受已确认的千川接口字段");
      if (this.officialSourceFreshFor(record)) return { accepted: false, metric };
      record.lastQianchuanMetricAt = metric.observedAt;
      record.latestQianchuanMetric = qianchuanMetricSnapshotSchema.parse(metric);
    } else {
      if (!safeEndpoint(metric.sourceEndpoint)) throw new LivePilotUnavailableError("仅接受罗盘已确认接口的字段");
      record.lastMetricAt = metric.observedAt;
      record.latestMetric = metric;
    }
    const eventId = randomUUID();
    const eventKind = metricSource === "qianchuan" ? "live.qianchuan.metric" : "live.compass.metric";
    const event: LiveEvent = liveEventSchema.parse({
      schemaVersion: 1, eventId, dedupeKey: `${metricSource}:${metric.sourceEndpoint}:${metric.observedAt}:${createHash("sha256").update(JSON.stringify(metric)).digest("hex").slice(0, 16)}`,
      tenantId: record.session.tenantId, sessionId, eventAt: metric.observedAt, capturedAt: now(), ingestedAt: now(), source: "browser_extension", kind: eventKind, provisional: false, payload: metric,
      metadata: { sourceRoute: metricSource === "qianchuan" ? "qianchuan-board" : "compass-live-shop", mappingVersion: metricSource === "qianchuan" ? QIANCHUAN_LIVE_MAPPING_VERSION : COMPASS_LIVE_MAPPING_VERSION }
    });
    const accepted = await this.service.ingest(event);
    if (accepted) await this.maybeCreateAction(record, event, metricSource);
    return { accepted, metric };
  }

  /** 官方 API 回调只允许走标准快照入口，页面快照在 API 新鲜时被抑制。 */
  async ingestOfficialMetric(sessionId: string, metric: QianchuanMetricSnapshot): Promise<boolean> {
    const record = await this.restoreRecord(sessionId);
    await this.ensureRunning(record);
    const parsed = qianchuanMetricSnapshotSchema.parse(metric);
    if (parsed.sourceEndpoint !== QIANCHUAN_OFFICIAL_LIVE_ENDPOINT || parsed.mappingVersion !== QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION) {
      throw new LivePilotUnavailableError("仅接受已确认的千川官方接口快照");
    }
    record.lastQianchuanMetricAt = parsed.observedAt;
    record.latestQianchuanMetric = parsed;
    const eventId = randomUUID();
    const event: LiveEvent = liveEventSchema.parse({
      schemaVersion: 1,
      eventId,
      dedupeKey: `official_api:${parsed.sourceEndpoint}:${parsed.observedAt}:${createHash("sha256").update(JSON.stringify(parsed)).digest("hex").slice(0, 16)}`,
      tenantId: record.session.tenantId,
      sessionId,
      eventAt: parsed.observedAt,
      capturedAt: now(),
      ingestedAt: now(),
      source: "official_api",
      kind: "live.qianchuan.metric",
      provisional: false,
      payload: parsed,
      metadata: { sourceRoute: "qianchuan-official-api", mappingVersion: QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION }
    });
    const accepted = await this.service.ingest(event);
    if (accepted) await this.maybeCreateAction(record, event, "qianchuan");
    this.emitLocalView(sessionId);
    return accepted;
  }

  private async maybeCreateAction(record: LivePilotRecord, metricEvent: LiveEvent, metricSource: "qianchuan" | "compass"): Promise<void> {
    if (this.captureOnly) return;
    const events = await this.store.listEvents(record.session.id);
    const resolutions = actionResolutionMap(events);
    const previousActions = events.filter((event) => event.kind === "live.compass.action").flatMap((event) => {
      const parsed = liveCompassActionSchema.safeParse(event.payload);
      return parsed.success ? [parsed.data] : [];
    });
    if (metricSource === "compass") {
      const metric = liveCompassMetricSnapshotSchema.parse(metricEvent.payload);
      const unresolvedPaymentGap = previousActions.filter((item) => !issueIsCleared(resolutions.get(item.id)) && isPaymentGapIssue(item.issueKey));
      if (metric.productPayGmvFen !== undefined && metric.productPayGmvFen > 0 && unresolvedPaymentGap.length > 0) {
        for (const item of unresolvedPaymentGap) await this.appendResolution(record, item, metricEvent.eventAt, "payment_recovered");
        return;
      }
      const oldMetric = [...events].reverse().find((event) => event.kind === "live.compass.metric" && event.eventId !== metricEvent.eventId);
      if (oldMetric && Date.parse(metricEvent.capturedAt) - Date.parse(oldMetric.capturedAt) > STALE_AFTER_MS) {
        const recovery: LiveCompassAction = {
          id: randomUUID(), createdAt: now(), kind: "recovery", title: "罗盘数据已恢复",
          message: "数据重新更新，先确认当前窗口和商品状态，再继续判断。",
          reason: "此前罗盘数据超过新鲜度阈值，当前已收到新的已确认字段。",
          evidenceEventIds: [metricEvent.eventId], issueKey: "source-recovered", confidence: "high"
        };
        if (!previousActions.some((item) => item.issueKey === recovery.issueKey && !issueIsCleared(resolutions.get(item.id)))) {
          await this.persistAction(record, metricEvent.eventAt, recovery);
        }
      }
    }
    const replay = replayLivePilotEngine(events);
    if (!replay.lastAction) return;
    const recentSpeechEvents = events.filter((event) => event.kind === "speech.final" && Date.parse(event.eventAt) <= Date.parse(metricEvent.eventAt) && Date.parse(metricEvent.eventAt) - Date.parse(event.eventAt) <= 180_000);
    const action = liveCompassActionFromMvp(replay.lastAction, [metricEvent.eventId, ...recentSpeechEvents.slice(-4).map((event) => event.eventId)]);
    const sameIssueUnresolved = previousActions.some((item) => item.issueKey === action.issueKey && !issueIsCleared(resolutions.get(item.id)));
    if (sameIssueUnresolved) return;
    const family = actionFamily(action.issueKey);
    const familyHasUnresolvedFeedback = previousActions.some((item) => {
      if (actionFamily(item.issueKey) !== family) return false;
      const resolution = resolutions.get(item.id);
      return Boolean(resolution && !issueIsCleared(resolution));
    });
    if (familyHasUnresolvedFeedback) return;
    const superseded = previousActions.filter((item) => actionFamily(item.issueKey) === family && !issueIsCleared(resolutions.get(item.id)));
    for (const item of superseded) await this.appendResolution(record, item, metricEvent.eventAt, "superseded");
    await this.persistAction(record, metricEvent.eventAt, action);
  }

  private async persistAction(record: LivePilotRecord, eventAt: string, action: LiveCompassAction): Promise<void> {
    await this.service.ingest(liveEventSchema.parse({
      schemaVersion: 1, eventId: action.id, dedupeKey: `live-action:${action.id}`, tenantId: record.session.tenantId, sessionId: record.session.id,
      eventAt, capturedAt: now(), ingestedAt: now(), source: "system", kind: "live.compass.action", provisional: false, payload: action
    }));
  }

  private async appendResolution(record: LivePilotRecord, action: LiveCompassAction, eventAt: string, reason: LiveCompassActionResolution["reason"]): Promise<void> {
    const resolution = liveCompassActionResolutionSchema.parse({ id: randomUUID(), actionId: action.id, status: "resolved", reason, resolvedAt: now() });
    await this.service.ingest(liveEventSchema.parse({
      schemaVersion: 1, eventId: resolution.id, dedupeKey: `live-action-resolution:${action.id}`, tenantId: record.session.tenantId, sessionId: record.session.id,
      eventAt, capturedAt: now(), ingestedAt: now(), source: "system", kind: "live.compass.action.resolved", provisional: false, payload: resolution
    }));
  }

  async recordActionFeedback(sessionId: string, token: string, actionId: string, input: unknown): Promise<{ accepted: boolean; feedback: LiveCompassActionFeedback }> {
    const record = await this.authorize(sessionId, token);
    await this.ensureRunning(record);
    return this.recordActionFeedbackForRecord(record, sessionId, actionId, input, undefined);
  }

  async recordLocalActionFeedback(sessionId: string, actionId: string, input: unknown): Promise<{ accepted: boolean; feedback: LiveCompassActionFeedback }> {
    const record = await this.restoreRecord(sessionId);
    await this.ensureRunning(record);
    return this.recordActionFeedbackForRecord(record, sessionId, actionId, input, "local-operator");
  }

  async setProductContext(sessionId: string, input: unknown): Promise<{ accepted: boolean; role: LiveProductRole }> {
    const record = await this.restoreRecord(sessionId);
    await this.ensureRunning(record);
    const payload = liveProductContextPayloadSchema.parse({
      ...(input && typeof input === "object" && !Array.isArray(input) ? input : {}),
      source: "operator"
    });
    const eventAt = now();
    const accepted = await this.service.ingest(liveEventSchema.parse({
      schemaVersion: 1,
      eventId: randomUUID(),
      dedupeKey: `live-product-context:${sessionId}:${eventAt}:${payload.role}`,
      tenantId: record.session.tenantId,
      sessionId,
      eventAt,
      capturedAt: eventAt,
      ingestedAt: eventAt,
      source: "operator",
      kind: "live.product.context",
      provisional: false,
      payload
    }));
    return { accepted, role: payload.role };
  }

  private async recordActionFeedbackForRecord(record: LivePilotRecord, sessionId: string, actionId: string, input: unknown, fixedOperatorId?: string): Promise<{ accepted: boolean; feedback: LiveCompassActionFeedback }> {
    const feedbackInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const feedback = liveCompassActionFeedbackSchema.parse({ ...feedbackInput, ...(fixedOperatorId ? { operatorId: fixedOperatorId } : {}), id: randomUUID(), actionId, createdAt: now() });
    const events = await this.store.listEvents(sessionId);
    const action = events.filter((event) => event.kind === "live.compass.action").map((event) => liveCompassActionSchema.safeParse(event.payload)).find((parsed) => parsed.success && parsed.data.id === actionId);
    if (!action?.success) throw new LivePilotActionNotFoundError("行动不存在或不属于当前直播");
    const resolution = actionResolutionMap(events).get(actionId);
    if (resolution) {
      if (resolution.status !== "resolved" && resolution.status === feedback.status && resolution.operatorId === feedback.operatorId) {
        return { accepted: false, feedback: resolution };
      }
      throw new LivePilotActionFeedbackConflictError("该行动已经有不同处理结果");
    }
    const accepted = await this.service.ingest(liveEventSchema.parse({
      schemaVersion: 1, eventId: feedback.id, dedupeKey: `live-action-feedback:${actionId}`, tenantId: record.session.tenantId, sessionId,
      eventAt: feedback.createdAt, capturedAt: now(), ingestedAt: now(), source: "operator", kind: "live.compass.action.feedback", provisional: false, payload: feedback
    }));
    if (accepted) return { accepted: true, feedback };
    const latestResolution = actionResolutionMap(await this.store.listEvents(sessionId)).get(actionId);
    if (latestResolution && latestResolution.status !== "resolved" && latestResolution.status === feedback.status && latestResolution.operatorId === feedback.operatorId) {
      return { accepted: false, feedback: latestResolution };
    }
    throw new LivePilotActionFeedbackConflictError("该行动已经有不同处理结果");
  }

  async startAsr(sessionId: string, token: string, options: { skipHotwords?: boolean } = {}): Promise<void> {
    if (this.captureOnly) throw new LivePilotUnavailableError("本测试版暂停语音识别，先验收数据接入");
    const record = await this.authorize(sessionId, token);
    await this.ensureRunning(record);
    if (record.asrStarting) return;
    if (liveAsrIsActive(record)) return;
    releaseLiveAsr(record);
    record.asrStarting = true;
    record.asrEpoch = (record.asrEpoch ?? 0) + 1;
    const epoch = record.asrEpoch;
    const engineModelType = resolveTencentAsrEngineModelType(process.env.TENCENT_ASR_ENGINE_MODEL_TYPE);
    const injection = resolveTencentAsrHotwordInjection({ engineModelType, env: process.env, ...(options.skipHotwords !== undefined ? { skipHotwords: options.skipHotwords } : {}) });
    try {
      const appId = process.env.TENCENT_ASR_APP_ID;
      const credentials = await resolveTencentAsrCredentials();
      if (record.asrEpoch !== epoch) return;
      if (!appId || !credentials) { record.asrState = "not_configured"; throw new LivePilotUnavailableError("未配置 TENCENT_ASR_APP_ID 或腾讯云密钥（TENCENT_ASR_SECRET_ID／TENCENT_ASR_SECRET_KEY，或 TENCENT_ASR_CREDENTIALS_FILE）"); }
      record.asrState = "connecting";
      delete record.asrErrorCode;
      const connection = new TencentAsrConnection({
        appId,
        credentials,
        engineModelType,
        ...(injection.injectId && process.env.TENCENT_ASR_HOTWORD_ID ? { hotwordId: process.env.TENCENT_ASR_HOTWORD_ID } : {}),
        ...(injection.injectList ? { hotwordList: ASR_HOTWORDS } : {}),
        onState: (state, detail) => {
          if (record.asrEpoch !== epoch) return;
          if (state === "error") {
            record.asrState = "error";
            record.asrErrorCode = detail?.match(/ASR_[A-Z0-9_-]+/)?.[0] ?? "ASR_ERROR";
            releaseLiveAsr(record);
            return;
          }
          if (state === "closed") {
            releaseLiveAsr(record);
            if (record.asrState !== "error") record.asrState = "closed";
            return;
          }
          record.asrState = state === "open" ? "open" : state;
        },
        onFinal: async (result) => {
          await persistLiveAsrFinal(this.service, record, sessionId, result);
        }
      });
      if (record.asrEpoch !== epoch) {
        connection.end();
        return;
      }
      record.asr = connection;
      await connection.ready();
      if (record.asrEpoch !== epoch) {
        connection.end();
        if (record.asr === connection) record.asr = undefined;
        return;
      }
      this.scheduleHyAsrSegmentRotation(record, sessionId, token, epoch, engineModelType);
    } catch (error) {
      if (error instanceof LivePilotUnavailableError) throw error;
      if (record.asrEpoch !== epoch) return;
      releaseLiveAsr(record);
      record.asrState = "error";
      record.asrErrorCode ??= "ASR_HANDSHAKE_ERROR";
      if (!options.skipHotwords && injection.injectList && record.asrErrorCode === "ASR_CODE_4002") {
        return this.startAsr(sessionId, token, { skipHotwords: true });
      }
      throw new LivePilotUnavailableError("腾讯云 ASR 握手失败，请检查密钥和网络");
    } finally {
      if (record.asrEpoch === epoch) record.asrStarting = false;
    }
    if (record.stopping) {
      releaseLiveAsr(record);
      record.asrState = "closed";
    }
  }

  private scheduleHyAsrSegmentRotation(record: LivePilotRecord, sessionId: string, token: string, epoch: number, engineModelType: string): void {
    if (!isHyAsrEngine(engineModelType) || record.stopping) return;
    if (record.asrRotateTimer) clearTimeout(record.asrRotateTimer);
    record.asrRotateTimer = setTimeout(() => {
      if (record.stopping || record.asrEpoch !== epoch) return;
      releaseLiveAsr(record);
      if (record.asrState !== "error") record.asrState = "closed";
      if (record.stopping) return;
      void this.startAsr(sessionId, token).catch(() => undefined);
    }, HY_ASR_SEGMENT_LIMIT_MS);
  }

  async acceptAudio(sessionId: string, token: string, socket: WebSocket): Promise<void> {
    const record = await this.authorize(sessionId, token);
    await this.ensureRunning(record);
    record.needsReconnect = false;
    record.lastAudioAt = now();
    const previousSocket = record.audioSocket;
    record.audioSocket = socket;
    if (previousSocket && previousSocket !== socket) {
      try { previousSocket.close(); } catch { /* 旧音频通道已失效 */ }
    }
    releaseLiveAsr(record);
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return;
      if (data instanceof Buffer && isLiveAudioPacket(data)) {
        record.audioFrames += 1;
        record.audioEnergyBand = audioEnergyBandFromPcm(data);
        if (record.audioEnergyBand !== "silent") record.nonSilentAudioFrames += 1;
        const observedAt = now();
        record.firstAudioAt ??= observedAt;
        record.lastAudioAt = observedAt;
        if (!liveAsrIsActive(record) && !record.asrStarting && record.asrState !== "not_configured" && !record.stopping) {
          void this.startAsr(sessionId, token).catch(() => undefined);
        }
        record.asr?.writePcm(data);
      }
    });
    socket.on("close", () => {
      if (record.audioSocket !== socket) return;
      delete record.audioSocket;
      const keepError = record.asrState === "error";
      releaseLiveAsr(record);
      if (!keepError) record.asrState = "closed";
    });
    socket.send(JSON.stringify({ type: "authorized", sampleRate: 16_000, channels: 1, format: "pcm_s16le", packetMs: 200 }));
    void this.startAsr(sessionId, token).catch(() => undefined);
  }

  async stop(sessionId: string, token: string): Promise<void> {
    const record = await this.authorize(sessionId, token);
    record.stopping = true;
    const persisted = await this.service.get(sessionId);
    record.session = persisted;
    if (persisted.status === "stopped") {
      delete record.audioSocket;
      releaseLiveAsr(record);
      record.asrState = "closed";
      await this.deactivateOfficialSource(sessionId);
      return;
    }
    if (persisted.status !== "running") throw new LivePilotStoppedError("真实直播已停止，不能继续写入");
    delete record.audioSocket;
    releaseLiveAsr(record);
    record.asrState = "closed";
    await this.deactivateOfficialSource(sessionId);
    record.session = await this.service.stop(sessionId);
  }

  /** Phase 2B M0：把当前场次事件流聚合成 15 分钟窗口序列（确定性、按需计算）。 */
  subscribe(sessionId: string, listener: () => void): Promise<() => Promise<void>> {
    let locals = this.localViewListeners.get(sessionId);
    if (!locals) {
      locals = new Set();
      this.localViewListeners.set(sessionId, locals);
    }
    locals.add(listener);
    return this.service.subscribe(sessionId, () => listener()).then((unsubscribe) => async () => {
      locals.delete(listener);
      await unsubscribe();
    });
  }

  private computeSourceHealth(record: LivePilotRecord, compassSnapshots: readonly LiveCompassMetricSnapshot[], qianchuanSnapshots: readonly QianchuanMetricSnapshot[], nowMs: number, remember = true): SourceHealthReport {
    const audioAppearances = [record.lastAudioAt, record.lastFinalAt].filter((item): item is string => Boolean(item));
    const officialApiFresh = this.officialSourceFreshFor(record, nowMs);
    const pageRuntime = record.pageRuntime ? {
      ...(record.pageRuntime.compass ? { compass: record.pageRuntime.compass } : {}),
      ...(!officialApiFresh && record.pageRuntime.qianchuan ? { qianchuan: record.pageRuntime.qianchuan } : {})
    } : undefined;
    const report = buildSourceHealthFromSnapshots({
      qianchuanSnapshots,
      compassSnapshots,
      nowMs,
      audioAppearances,
      ...(pageRuntime ? { pageRuntime } : {}),
      ...(record.groupHealthPrevious ? { previousGroups: record.groupHealthPrevious } : {}),
      recovering: record.recovering === true,
      ...(record.lastRecoveredAt ? { lastRecoveredAt: record.lastRecoveredAt } : {}),
      ...(record.recoveryHistory?.at(-1)?.attemptedAt ? { lastRecoveryAttemptAt: record.recoveryHistory.at(-1)!.attemptedAt } : {}),
      recoveryAttempts: (record.recoveryHistory ?? []).filter((item) => item.action === "reload").length
    });
    if (remember) record.groupHealthPrevious = [...report.qianchuan.groups, ...report.compass.groups];
    return report;
  }

  async ingestPageRuntime(sessionId: string, token: string, input: unknown): Promise<{ accepted: boolean; pageRuntimeState: LivePilotRecord["pageRuntime"] }> {
    const record = await this.authorize(sessionId, token);
    const state = pageRuntimeStateSchema.parse(input);
    record.pageRuntime = { ...record.pageRuntime, [state.source]: state };
    this.emitLocalView(sessionId);
    return { accepted: true, pageRuntimeState: record.pageRuntime };
  }

  async requestRecovery(sessionId: string, input: unknown, auth: { token?: string; originOk?: boolean }): Promise<{
    accepted: boolean;
    reason?: string;
    prompt?: string;
    pendingRecovery?: LivePilotRecord["pendingRecovery"];
    recoveryHistory?: RecoveryHistoryEntry[];
  }> {
    if (auth.token) await this.authorize(sessionId, auth.token);
    else if (!auth.originOk) throw new LivePilotUnauthorizedError("只允许本机扩展或已开启的局域网副驾页面请求恢复");
    const record = await this.restoreRecord(sessionId);
    const body = liveRecoveryRequestSchema.parse(input);
    const attemptedAt = now();
    const appendHistory = (entry: RecoveryHistoryEntry): RecoveryHistoryEntry[] => {
      const next: RecoveryHistoryEntry[] = [...(record.recoveryHistory ?? []), entry];
      record.recoveryHistory = next.slice(-16);
      return record.recoveryHistory;
    };
    if (body.action === "request_reload") {
      if (body.confirm !== true) {
        return {
          accepted: false,
          reason: body.source === "compass" ? "compass_confirm_required" : "confirm_required",
          prompt: body.source === "compass" ? COMPASS_RECOVER_PROMPT : QIANCHUAN_RECOVER_PROMPT
        };
      }
      record.pendingRecovery = { source: body.source, requestedAt: attemptedAt, confirm: true };
      record.recovering = true;
      const history = appendHistory({
        source: body.source,
        action: "reload",
        outcome: "pending",
        attemptedAt,
        reason: "user_confirmed_reload"
      });
      this.emitLocalView(sessionId);
      return { accepted: true, pendingRecovery: record.pendingRecovery, recoveryHistory: history };
    }
    if (body.action === "rebuild_observer") {
      const history = appendHistory({
        source: body.source,
        action: "rebuild_observer",
        outcome: body.outcome ?? "pending",
        attemptedAt,
        reason: body.reason ?? "l1_rebuild"
      });
      this.emitLocalView(sessionId);
      return { accepted: true, recoveryHistory: history };
    }
    const last = [...(record.recoveryHistory ?? [])].reverse().find((item) => item.source === body.source && item.outcome === "pending");
    const recoveredAt = body.outcome === "recovered" ? attemptedAt : undefined;
    const reportAction: RecoveryHistoryEntry["action"] = body.outcome === "aborted" || body.outcome === "blocked" ? body.outcome : "reload";
    if (last) {
      last.outcome = body.outcome ?? "failed";
      if (recoveredAt) last.recoveredAt = recoveredAt;
    } else {
      appendHistory({
        source: body.source,
        action: reportAction,
        outcome: body.outcome ?? "failed",
        attemptedAt,
        reason: body.reason ?? "report",
        ...(recoveredAt ? { recoveredAt } : {})
      });
    }
    if (body.outcome === "recovered") {
      record.recovering = false;
      delete record.pendingRecovery;
      if (recoveredAt) record.lastRecoveredAt = recoveredAt;
      const recovery: LiveCompassAction = {
        id: randomUUID(), createdAt: attemptedAt, kind: "recovery", title: body.source === "qianchuan" ? QIANCHUAN_RECOVERED : "罗盘数据已恢复",
        message: body.source === "qianchuan" ? "千川指标组已重新出现，只用恢复后的真实数据。" : "罗盘数据重新更新。音频需要重新授权，不会自动恢复。",
        reason: "受控恢复后字段重新出现。",
        evidenceEventIds: [], issueKey: body.source === "qianchuan" ? "qianchuan-recovered" : "source-recovered", confidence: "high"
      };
      await this.persistAction(record, attemptedAt, recovery);
    } else if (body.outcome === "failed" || body.outcome === "aborted" || body.outcome === "blocked") {
      record.recovering = false;
      delete record.pendingRecovery;
    }
    this.emitLocalView(sessionId);
    return { accepted: true, recoveryHistory: record.recoveryHistory ?? [] };
  }

  async windows(sessionId: string): Promise<{ sessionId: string; windows: LiveWindowAggregate[] }> {
    const session = await this.service.get(sessionId);
    if (session.scenario !== "live_compass") throw new LivePilotNotFoundError(`真实试点不存在：${sessionId}`);
    const events = await this.store.listEvents(sessionId);
    const windows = aggregateLiveWindows(events, {
      ...(session.startedAt ? { sessionStartAt: session.startedAt } : {}),
      ...(session.stoppedAt ? { sessionEndAt: session.stoppedAt } : {})
    });
    return { sessionId, windows };
  }

  /** Phase 2B M4（D045）：场后主播报告 = 确定性要点覆盖 + 证据 + 相关性联动 + 建议。 */
  async anchorReport(sessionId: string): Promise<AnchorSessionReport> {
    const session = await this.service.get(sessionId);
    if (session.scenario !== "live_compass") throw new LivePilotNotFoundError(`真实试点不存在：${sessionId}`);
    return this.buildAnchorReportFor(session);
  }

  /** Phase 2B D047／D053：场次目录不扫整场事件，已结束窗按时钟槽列出。 */
  async catalog(): Promise<LiveSessionCatalog> {
    const generatedAt = now();
    const generatedMs = Date.parse(generatedAt);
    const sessions = (await this.store.listSessions("live_compass"))
      .sort((left, right) => Date.parse(right.startedAt ?? right.createdAt) - Date.parse(left.startedAt ?? left.createdAt))
      .slice(0, 50);
    const items = await Promise.all(sessions.map(async (session) => {
      const speechFinalCount = await this.store.countEvents(session.id, "speech.final");
      const pastWindows = completedWindowOptions(session.startedAt ?? session.createdAt, generatedMs);
      return {
        sessionId: session.id,
        name: session.name,
        status: session.status,
        ...(session.startedAt ? { startedAt: session.startedAt } : {}),
        ...(session.stoppedAt ? { stoppedAt: session.stoppedAt } : {}),
        windowCount: pastWindows.length,
        speechFinalCount,
        pastWindows
      };
    }));
    return liveSessionCatalogSchema.parse({ schemaVersion: 1, sessions: items });
  }

  /** Phase 2B D047：运营触发的主播复盘确定性底稿；LLM 表达由调用方 await。 */
  async buildAnchorReview(input: AnchorReviewRequest): Promise<AnchorReview> {
    const generatedAt = now();
    try {
      assertAnchorReviewRange(input.rangeStartAt, input.rangeEndAt, generatedAt);
    } catch (error) {
      if (error instanceof AnchorReviewRangeError) throw new LivePilotReviewError(error.message);
      throw error;
    }
    const session = await this.service.get(input.sessionId);
    if (session.scenario !== "live_compass") throw new LivePilotNotFoundError(`真实试点不存在：${input.sessionId}`);
    let script = REFERENCE_SCRIPT_V1;
    if (input.scriptSource === "pasted") {
      try {
        script = parseReferenceScriptText(input.scriptText ?? "");
      } catch (error) {
        if (error instanceof ReferenceScriptParseError) throw new LivePilotReviewError(error.message);
        throw error;
      }
    }
    const rangeStartMs = Date.parse(input.rangeStartAt);
    const rangeEndMs = Date.parse(input.rangeEndAt);
    const lookbackAt = new Date(rangeStartMs - LIVE_WINDOW_MS).toISOString();
    const events = await this.store.listEventsBetween(session.id, lookbackAt, input.rangeEndAt);
    const windows = this.windowsOf(session, events).filter((window) => Date.parse(window.windowStartAt) >= rangeStartMs && Date.parse(window.windowEndAt) <= rangeEndMs);
    const transcripts = this.transcriptsOf(events).filter((item) => {
      const at = Date.parse(item.at);
      return at >= rangeStartMs && at < rangeEndMs;
    });
    if (windows.length === 0 && transcripts.length === 0) {
      throw new LivePilotReviewError("这段没有可复盘的窗口或转写");
    }
    const coverage = buildAnchorSessionReport({
      tenantId: session.tenantId,
      sessionId: session.id,
      sessionStatus: session.status === "stopped" ? "stopped" : "running",
      script,
      transcripts,
      windows,
      generatedAt
    });
    return assembleAnchorReview({
      hostName: input.hostName,
      sessionId: session.id,
      rangeStartAt: input.rangeStartAt,
      rangeEndAt: input.rangeEndAt,
      generatedAt,
      coverage,
      windows
    });
  }

  /** Phase 2B D050：运营触发的本场复盘确定性底稿；LLM 表达由调用方 await。 */
  async buildSessionReview(input: SessionReviewRequest): Promise<SessionReview> {
    const generatedAt = now();
    const generatedMs = Date.parse(generatedAt);
    const session = await this.service.get(input.sessionId);
    if (session.scenario !== "live_compass") throw new LivePilotNotFoundError(`真实试点不存在：${input.sessionId}`);
    let script = REFERENCE_SCRIPT_V1;
    if (input.scriptSource === "pasted") {
      try {
        script = parseReferenceScriptText(input.scriptText ?? "");
      } catch (error) {
        if (error instanceof ReferenceScriptParseError) throw new LivePilotReviewError(error.message);
        throw error;
      }
    }
    const events = await this.store.listEvents(session.id);
    const completed = this.windowsOf(session, events).filter((window) => Date.parse(window.windowEndAt) <= generatedMs);
    if (completed.length === 0) throw new LivePilotReviewError("这场还没有走完的时段，等过了一段再复盘。");
    const truncated = completed.length > SESSION_REVIEW_MAX_WINDOWS;
    const windows = truncated ? completed.slice(-SESSION_REVIEW_MAX_WINDOWS) : completed;
    const rangeStartAt = windows[0]!.windowStartAt;
    const rangeEndAt = windows.at(-1)!.windowEndAt;
    const rangeStartMs = Date.parse(rangeStartAt);
    const rangeEndMs = Date.parse(rangeEndAt);
    const transcripts = this.transcriptsOf(events).filter((item) => {
      const at = Date.parse(item.at);
      return at >= rangeStartMs && at < rangeEndMs;
    });
    const coverage = buildAnchorSessionReport({
      tenantId: session.tenantId,
      sessionId: session.id,
      sessionStatus: session.status === "stopped" ? "stopped" : "running",
      script,
      transcripts,
      windows,
      generatedAt
    });
    try {
      return assembleSessionReview({
        hostName: input.hostName,
        sessionId: session.id,
        rangeStartAt,
        rangeEndAt,
        generatedAt,
        coverage,
        windows,
        truncated
      });
    } catch (error) {
      if (error instanceof SessionReviewRangeError) throw new LivePilotReviewError(error.message);
      throw error;
    }
  }

  /** Phase 2B M5（D045）：跨场"要点 × 窗口 × 指标响应"统计，最低样本量 5 场。 */
  async scriptIteration(): Promise<ScriptIterationReport> {
    const sessions = await this.store.listSessions("live_compass");
    const reports: AnchorSessionReport[] = [];
    for (const session of sessions.filter((item) => item.status === "stopped")) {
      reports.push(await this.buildAnchorReportFor(session));
    }
    return aggregateScriptIteration({ reports, generatedAt: now() });
  }

  private windowsOf(session: Session, events: LiveEvent[]): LiveWindowAggregate[] {
    return aggregateLiveWindows(events, {
      ...(session.startedAt ? { sessionStartAt: session.startedAt } : {}),
      ...(session.stoppedAt ? { sessionEndAt: session.stoppedAt } : {})
    });
  }

  private transcriptsOf(events: LiveEvent[]): Array<{ at: string; text: string }> {
    return events.flatMap((event) => {
      if (event.kind !== "speech.final") return [];
      const parsed = transcriptSegmentSchema.safeParse(event.payload);
      return parsed.success && parsed.data.text.trim() ? [{ at: event.eventAt, text: parsed.data.text }] : [];
    });
  }

  private async buildAnchorReportFor(session: Session): Promise<AnchorSessionReport> {
    const events = await this.store.listEvents(session.id);
    const windows = this.windowsOf(session, events);
    const transcripts = this.transcriptsOf(events);
    return buildAnchorSessionReport({
      tenantId: session.tenantId,
      sessionId: session.id,
      sessionStatus: session.status === "stopped" ? "stopped" : "running",
      transcripts,
      windows,
      generatedAt: now()
    });
  }

  async cockpitExtras(sessionId: string, baseline: {
    rooms: readonly HistoricalHourRoomAggregate[];
    asOfLocalDate?: string;
    lastSuccessAt?: string;
    audioStatus?: DiagnoseLiveOperatingInput["audioStatus"];
  }): Promise<{ hourVsBaseline: LiveHourVsBaseline; diagnosis: DiagnosisWindow | null }> {
    const session = await this.service.get(sessionId);
    if (session.scenario !== "live_compass") throw new LivePilotNotFoundError(`真实试点不存在：${sessionId}`);
    const events = await this.store.listEvents(sessionId);
    const windows = aggregateLiveWindows(events, {
      ...(session.startedAt ? { sessionStartAt: session.startedAt } : {}),
      ...(session.stoppedAt ? { sessionEndAt: session.stoppedAt } : {})
    });
    const lastMetric = [...events].reverse().find((event) => event.kind === "live.compass.metric" || event.kind === "live.qianchuan.metric");
    const atMs = lastMetric ? Date.parse(lastMetric.eventAt) : Date.parse(session.startedAt ?? new Date(0).toISOString());
    const liveHour = liveHourToDateFromWindows(windows, Number.isFinite(atMs) ? atMs : 0);
    const hourVsBaseline = compareLiveHourToBaseline(liveHour, baseline.rooms, {
      ...(baseline.asOfLocalDate ? { asOfLocalDate: baseline.asOfLocalDate } : {}),
      ...(baseline.lastSuccessAt ? { lastSuccessAt: baseline.lastSuccessAt } : {})
    });
    const completed = latestCompletedWindow(windows, Number.isFinite(atMs) ? atMs : 0);
    const qianchuanSnapshots = events.flatMap((event) => {
      if (event.kind !== "live.qianchuan.metric") return [];
      const parsed = qianchuanMetricSnapshotSchema.safeParse(event.payload);
      return parsed.success ? [parsed.data] : [];
    });
    const nowMs = Number.isFinite(atMs) ? atMs : Date.now();
    const recent = recentSliceFromQianchuanSnapshots(qianchuanSnapshots, nowMs);
    const eventReady = Boolean(detectDiagnosisEvents(recent));
    const currentWindow = completed?.current ?? (eventReady
      ? windows.filter((window) => Date.parse(window.windowStartAt) <= nowMs).at(-1)
      : undefined);
    if (!currentWindow) return { hourVsBaseline, diagnosis: null };
    const replay = replayLivePilotEngine(events);
    const lastPoint = replay.points.filter((item) => item.at >= currentWindow.windowStartAt && item.at < currentWindow.windowEndAt).at(-1)?.point;
    const speechPresentKeys = speechPresentInWindow(replay.points, currentWindow.windowStartAt, currentWindow.windowEndAt);
    const productName = lastPoint && lastPoint.currentProductId !== UNKNOWN_PRODUCT_ID ? lastPoint.currentProductId : undefined;
    const priorWindows = windows.filter((window) => Date.parse(window.windowEndAt) <= Date.parse(currentWindow.windowStartAt)).slice(-6);
    const lastCompass = [...events].reverse().find((event) => event.kind === "live.compass.metric");
    const lastQianchuan = [...events].reverse().find((event) => event.kind === "live.qianchuan.metric");
    const compassSnapshots = events.flatMap((event) => {
      if (event.kind !== "live.compass.metric") return [];
      const parsed = liveCompassMetricSnapshotSchema.safeParse(event.payload);
      return parsed.success ? [parsed.data] : [];
    });
    const record = this.records.get(sessionId);
    const health = this.computeSourceHealth(record ?? {
      session, tenantId: session.tenantId, tokenHash: Buffer.alloc(0), needsReconnect: false, stopping: false, createdAt: session.createdAt,
      asr: undefined, asrState: "closed", finalCount: 0, audioFrames: 0, nonSilentAudioFrames: 0, audioEnergyBand: "unknown"
    }, compassSnapshots, qianchuanSnapshots, nowMs, false);
    const compassStatus = compatibleSourceStatus(health.compass.overallHealth, lastCompass?.eventAt, nowMs, STALE_AFTER_MS);
    const qianchuanStatus = compatibleSourceStatus(health.qianchuan.overallHealth, lastQianchuan?.eventAt, nowMs, QIANCHUAN_STALE_AFTER_MS);
    const dataFreshness = health.qianchuan.overallHealth === "partial" || health.compass.overallHealth === "partial"
      ? "stale"
      : compassStatus === "offline" || qianchuanStatus === "offline"
        ? "offline"
        : compassStatus === "fresh" || qianchuanStatus === "fresh"
          ? "fresh"
          : !lastCompass && !lastQianchuan ? "unknown" : "stale";
    const role = latestProductRole(events, nowMs);
    const lastAction = [...events].reverse().find((event) => event.kind === "live.compass.action");
    const lastActionPayload = lastAction ? liveCompassActionSchema.safeParse(lastAction.payload) : undefined;
    const lastResolution = lastActionPayload?.success ? actionResolutionMap(events).get(lastActionPayload.data.id) : undefined;
    return {
      hourVsBaseline,
      diagnosis: diagnoseLiveOperating({
        sessionId,
        current: currentWindow,
        ...(completed?.previous ? { previous: completed.previous } : {}),
        ...(priorWindows.length ? { priorWindows } : {}),
        rooms: baseline.rooms,
        ...(baseline.asOfLocalDate ? { asOfLocalDate: baseline.asOfLocalDate } : {}),
        stateShare: stateShareInWindow(replay.points, currentWindow.windowStartAt, currentWindow.windowEndAt),
        ...(productName ? { currentProductName: productName } : {}),
        ...(speechPresentKeys.length ? { speechPresentKeys } : {}),
        nowMs,
        dataFreshness,
        compassStatus: compassStatus === "partial" ? "partial" : lastCompass ? compassStatus : "unknown",
        qianchuanStatus: qianchuanStatus === "partial" ? "partial" : lastQianchuan ? qianchuanStatus : "unknown",
        groupHealth: [...health.qianchuan.groups, ...health.compass.groups],
        ...(baseline.audioStatus ? { audioStatus: baseline.audioStatus } : {}),
        productRole: role.role,
        events,
        ...(recent ? { recent } : {}),
        ...(lastActionPayload?.success ? { previousIssueKey: lastActionPayload.data.issueKey } : {}),
        ...(lastResolution && lastResolution.status !== "resolved" ? {
          previousResolution: lastResolution.status,
          previousResolvedAt: lastResolution.createdAt
        } : {})
      })
    };
  }

  async view(sessionId: string): Promise<LivePilotView> {
    const restored = await this.getForView(sessionId);
    const record = restored.record;
    const state = await this.service.state(sessionId);
    const events = await this.store.listEvents(sessionId);
    const metrics = events.filter((event) => event.kind === "live.compass.metric").map((event) => liveCompassMetricSnapshotSchema.parse(event.payload));
    const qianchuanMetricEvents = events.filter((event) => event.kind === "live.qianchuan.metric");
    const actions = this.captureOnly ? [] : events.filter((event) => event.kind === "live.compass.action").map((event) => liveCompassActionSchema.parse(event.payload));
    const resolutions = actionResolutionMap(events);
    const actionHistory = actions.map((item) => {
      const resolution = resolutions.get(item.id);
      return { ...actionHistoryItem(item, resolution), actionEvidence: actionEvidence(item, events, resolution) };
    }).slice(-3);
    const transcriptEvents = events.flatMap((event) => {
      if (event.kind !== "speech.final") return [];
      const parsed = transcriptSegmentSchema.safeParse(event.payload);
      return parsed.success ? [{ event, segment: parsed.data }] : [];
    });
    const lastMetricAt = record.lastMetricAt;
    const viewNowMs = Date.now();
    const qianchuanNowMs = viewNowMs;
    const officialApi = this.officialSource?.status();
    const officialApiFresh = this.officialSourceFreshFor(record, qianchuanNowMs);
    // 相同采集毫秒也必须按观测时间排序，不能让随机 eventId 丢掉更新的分片。
    const orderedSourceEvents = qianchuanMetricEvents.slice().sort((left, right) => {
      const elapsed = Date.parse(left.capturedAt) - Date.parse(right.capturedAt)
        || Date.parse(left.eventAt) - Date.parse(right.eventAt);
      if (elapsed) return elapsed;
      const leftMapping = qianchuanMetricSnapshotSchema.parse(left.payload).mappingVersion;
      const rightMapping = qianchuanMetricSnapshotSchema.parse(right.payload).mappingVersion;
      const preference = Number(rightMapping === QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION) - Number(leftMapping === QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION);
      return preference || left.eventId.localeCompare(right.eventId);
    });
    const latestQianchuanEvent = orderedSourceEvents.at(-1);
    const activeQianchuanMappingVersion = officialApiFresh
      ? QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION
      : latestQianchuanEvent ? qianchuanMetricSnapshotSchema.parse(latestQianchuanEvent.payload).mappingVersion : undefined;
    // 只使用当前来源连续段。API → 页面回退 → API 后重新建立差分基线。
    const activeEvent = officialApiFresh
      ? [...orderedSourceEvents].reverse().find((event) => event.source === "official_api")
      : latestQianchuanEvent;
    const activeIdentity = activeEvent ? qianchuanSourceIdentity(activeEvent) : undefined;
    const activeIndex = activeEvent ? orderedSourceEvents.indexOf(activeEvent) : -1;
    let segmentStart = activeIndex;
    while (segmentStart > 0 && qianchuanSourceIdentity(orderedSourceEvents[segmentStart - 1]!) === activeIdentity) segmentStart -= 1;
    const qianchuanMetricsForView = activeIndex < 0 ? [] : orderedSourceEvents.slice(segmentStart, activeIndex + 1)
      .map((event) => qianchuanMetricSnapshotSchema.parse(event.payload))
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    const sourceHealth = this.computeSourceHealth(record, metrics, qianchuanMetricsForView, viewNowMs);
    const lastAudio = record.lastAudioAt;
    const audioStatus = record.asrState === "not_configured" && !record.asrErrorCode ? "not_started" : record.asrState === "error" || record.asrErrorCode ? "error" : record.asrState === "open" && lastAudio && Date.now() - Date.parse(lastAudio) <= AUDIO_STALE_AFTER_MS ? "active" : record.asrState === "open" ? "stale" : "offline";
    const transcriptionStatus = deriveLiveTranscriptionStatus({ asrState: record.asrState, audioFrames: record.audioFrames, finalCount: record.finalCount, ...(record.lastFinalAt ? { lastFinalAt: record.lastFinalAt } : {}), ...(record.asrErrorCode ? { asrErrorCode: record.asrErrorCode } : {}), nowMs: Date.now() });
    const firstMetricTimedOut = !lastMetricAt && Date.now() - Date.parse(record.createdAt) >= FIRST_METRIC_TIMEOUT_MS;
    const firstFinalTimedOut = isFirstFinalTimedOut({ asrState: record.asrState, audioFrames: record.audioFrames, finalCount: record.finalCount, ...(record.firstAudioAt ? { firstAudioAt: record.firstAudioAt } : {}), nowMs: Date.now() });
    const metricKeys: Array<keyof LiveCompassMetricSnapshot> = ["onlineSnapshot", "sessionPaidGmvFen", "adSpendFen", "paidBuyerCount", "paidItemCount", "watchToPaidRate", "productClickToPaidRate", "averageWatchDurationSec", "roomEnterCount5m", "userPaidGmvFen5m", "productClickCount", "productPayGmvFen", "unpaidOrderCount", "productName", "currentProductName", "productPaidGmvFen", "liveStatus", "windowLabel"];
    const metricFieldTimes: Record<string, string> = {};
    const metricComparisons: Record<string, LiveMetricComparison> = {};
    const orderedMetrics = metrics.slice().sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    const activeProductName = productNameOf([...orderedMetrics].reverse().find((item) => productNameOf(item) !== undefined) ?? ({} as LiveCompassMetricSnapshot));
    const latestMetricForField = new Map<keyof LiveCompassMetricSnapshot, LiveCompassMetricSnapshot>();
    for (const current of orderedMetrics) {
      const currentProduct = productNameOf(current);
      for (const key of metricKeys) {
        if (current[key] === undefined) continue;
        if (activeProductName && (PRODUCT_COMPARISON_FIELDS.has(key) || PRODUCT_IDENTITY_FIELDS.has(key)) && currentProduct !== activeProductName) continue;
        if (activeProductName && PRODUCT_COMPARISON_FIELDS.has(key) && currentProduct === undefined) continue;
        latestMetricForField.set(key, current);
      }
    }
    for (const [key, current] of latestMetricForField) {
      const sameTimestamp = [...orderedMetrics].find((candidate) => candidate !== current && candidate[key] !== undefined && candidate.sourceEndpoint === current.sourceEndpoint && candidate.observedAt === current.observedAt);
      const previous = sameTimestamp ?? [...orderedMetrics].reverse().find((candidate) => candidate !== current && candidate[key] !== undefined && candidate.sourceEndpoint === current.sourceEndpoint && Date.parse(candidate.observedAt) < Date.parse(current.observedAt));
      const comparison = compareLiveMetricSnapshots(key, current, previous);
      if (comparison) metricComparisons[key] = comparison;
      metricFieldTimes[key] = current.observedAt;
    }
    const latest = orderedMetrics.reduce<LiveCompassMetricSnapshot | null>((merged, current) => {
      const next = merged ? { ...merged } : { ...current };
      if (!merged || Date.parse(current.observedAt) >= Date.parse(merged.observedAt)) {
        next.observedAt = current.observedAt;
        next.sourceEndpoint = current.sourceEndpoint;
        next.mappingVersion = current.mappingVersion;
        next.dataStatus = current.dataStatus;
      }
      for (const key of metricKeys) {
        const value = current[key];
        const currentProduct = productNameOf(current);
        if (value !== undefined && (!activeProductName || (!PRODUCT_COMPARISON_FIELDS.has(key) && !PRODUCT_IDENTITY_FIELDS.has(key)) || currentProduct === activeProductName)) (next as Record<string, unknown>)[key] = value;
      }
      return next;
    }, null);
    if (latest && activeProductName) {
      for (const key of PRODUCT_COMPARISON_FIELDS) {
        const source = latestMetricForField.get(key);
        if (source && productNameOf(source) === activeProductName && source[key] !== undefined) (latest as Record<string, unknown>)[key] = source[key];
        else delete (latest as Record<string, unknown>)[key];
      }
    }
    const sourceStatus: LivePilotView["source"]["status"] = compatibleSourceStatus(sourceHealth.compass.overallHealth, lastMetricAt, viewNowMs, STALE_AFTER_MS);
    const canShowAction = state.session.status === "running" && !record.needsReconnect && sourceStatus === "fresh";
    const action = canShowAction ? [...actions].reverse().find((item) => !resolutions.has(item.id)) ?? null : null;
    const actionEvidenceForView = action ? actionEvidence(action, events, resolutions.get(action.id)) : null;
    const transcriptAnchorAt = Math.min(lastMetricAt ? Date.parse(lastMetricAt) : Date.now(), Date.now());
    const recentTranscriptEvents = transcriptEvents.filter(({ event }) => {
      const at = Date.parse(event.eventAt);
      return at <= transcriptAnchorAt && transcriptAnchorAt - at <= 180_000;
    }).slice(-12);
    const recentTranscripts = recentTranscriptEvents.map(({ event, segment }) => ({ at: event.eventAt, text: segment.text }));
    const latestTranscriptEvent = recentTranscriptEvents.at(-1);
    const eventMarkers = events.slice(-40).map((event) => event.kind === "live.compass.metric"
      ? { at: event.eventAt, type: "metric" as const, label: "罗盘数据更新" }
      : event.kind === "speech.final" ? { at: event.eventAt, type: "speech" as const, label: "话术已识别" }
      : event.kind === "live.compass.action" ? { at: event.eventAt, type: "action" as const, label: "行动建议" }
      : event.kind === "live.compass.action.feedback" ? { at: event.eventAt, type: "action" as const, label: "行动已反馈" }
      : event.kind === "live.compass.action.resolved" ? { at: event.eventAt, type: "action" as const, label: "问题已缓解" } : null).filter((value): value is NonNullable<typeof value> => value !== null);
    const qianchuanMetricHistory = qianchuanMetricsForView
      .map((metric, index) => ({ metric, index, observedAtMs: Date.parse(metric.observedAt) }))
      .filter(({ metric, observedAtMs }) => metric.metricSource === "qianchuan" && metric.dataStatus === "fresh" && Number.isFinite(observedAtMs) && observedAtMs <= qianchuanNowMs && observedAtMs >= qianchuanNowMs - 20 * 60_000)
      .sort((left, right) => left.observedAtMs - right.observedAtMs || left.index - right.index)
      .slice(-600)
      .map(({ metric }) => metric);
    const latestQianchuanMetric = qianchuanMetricsForView.reduce<QianchuanMetricSnapshot | null>((merged, current) => {
      // 官方轮询每次返回整份快照；没有返回的字段不能沿用旧值并盖上新时间。
      if (activeQianchuanMappingVersion === QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION) return current;
      if (!merged) return current;
      return qianchuanMetricSnapshotSchema.parse({
        ...merged,
        observedAt: current.observedAt,
        sourceEndpoint: current.sourceEndpoint,
        dataStatus: current.dataStatus,
        metrics: { ...merged.metrics, ...current.metrics }
      });
    }, null);
    const lastQianchuanMetricAt = latestQianchuanMetric?.observedAt ?? record.lastQianchuanMetricAt;
    const qianchuanStatus = compatibleSourceStatus(sourceHealth.qianchuan.overallHealth, lastQianchuanMetricAt, viewNowMs, QIANCHUAN_STALE_AFTER_MS);
    const qianchuanSourceKind: LivePilotView["qianchuan"]["sourceKind"] = officialApiFresh
      || latestQianchuanMetric?.mappingVersion === QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION
      ? "official_api"
      : latestQianchuanMetric ? "browser_extension" : "none";
    return {
      session: state.session, needsReconnect: restored.needsReconnect, latestMetric: latest, metricHistory: metrics.slice(-60), metricFieldTimes, metricComparisons,
      latestTranscript: latestTranscriptEvent ? { text: latestTranscriptEvent.segment.text, startMs: latestTranscriptEvent.segment.startMs, endMs: latestTranscriptEvent.segment.endMs, at: latestTranscriptEvent.event.eventAt } : null,
      recentTranscripts,
      source: {
        status: sourceStatus,
        overallHealth: sourceHealth.compass.overallHealth,
        groups: sourceHealth.compass.groups,
        ...(lastMetricAt ? { lastMetricAt } : {}),
        mappingVersion: COMPASS_LIVE_MAPPING_VERSION,
        firstMetricTimedOut,
        coverage: fieldCoverage(latest)
      },
      qianchuan: {
        status: qianchuanStatus,
        overallHealth: sourceHealth.qianchuan.overallHealth,
        groups: sourceHealth.qianchuan.groups,
        latestMetric: latestQianchuanMetric,
        metricHistory: qianchuanMetricHistory,
        ...(lastQianchuanMetricAt ? { lastMetricAt: lastQianchuanMetricAt } : {}),
        sourceKind: qianchuanSourceKind,
        ...(officialApi ? { officialApi } : {})
      },
      audio: { status: audioStatus, transcriptionStatus, ...(lastAudio ? { lastAudioAt: lastAudio } : {}), ...(record.lastFinalAt ? { lastFinalAt: record.lastFinalAt } : {}), finalCount: record.finalCount, audioFrames: record.audioFrames, nonSilentAudioFrames: record.nonSilentAudioFrames, energyBand: record.audioEnergyBand, firstFinalTimedOut, ...(record.asrErrorCode ? { errorCode: record.asrErrorCode } : {}) }, action, actionHistory, actionEvidence: actionEvidenceForView, eventMarkers,
      productRole: latestProductRole(events, Date.now()).role,
      sourceGroupHealth: sourceHealth,
      ...(record.pageRuntime ? { pageRuntimeState: record.pageRuntime } : {}),
      ...(record.recoveryHistory?.length ? { recoveryHistory: record.recoveryHistory } : {}),
      ...(record.pendingRecovery ? { pendingRecovery: record.pendingRecovery } : {}),
      ...(record.lastRecoveredAt ? { lastRecoveredAt: record.lastRecoveredAt } : {}),
      recovering: record.recovering === true
    };
  }
}
