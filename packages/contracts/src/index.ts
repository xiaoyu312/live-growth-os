import { z } from "zod";
export * from "./qianchuan-connection";
export * from "./operator-rules";
export * from "./operator-rules-runtime";
export * from "./operator-history";
import { operatorSettingsSchema } from "./operator-rules";
import { operatorObservationRecordSchema, operatorStateSchema } from "./operator-rules-runtime";

const isoDate = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"), "时间必须使用 UTC Z 格式");
const id = z.string().min(1).max(160);
const nonNegative = z.number().finite().nonnegative();
const nonNegativeInteger = z.number().int().nonnegative();
const rate = z.number().finite().min(0).max(1);

export const speechTagSchema = z.enum([
  "opening", "interaction", "product_benefit", "ingredient_or_principle",
  "usage_scenario", "price", "gift", "trust", "guarantee",
  "objection_handling", "urgency", "cta", "transition", "other"
]);

export const legacyMetricSnapshotSchema = z.object({
  onlineUsers: nonNegative.optional(), entersTotal: nonNegative.optional(),
  entersPerMin: nonNegative.optional(), exposureEnterRate: rate.optional(),
  avgWatchSec: nonNegative.optional(), productClicksTotal: nonNegative.optional(),
  productClickUsersTotal: nonNegative.optional(), productClickRate: rate.optional(),
  ordersTotal: nonNegative.optional(), orderUsersTotal: nonNegative.optional(),
  paidOrdersTotal: nonNegative.optional(), paidUsersTotal: nonNegative.optional(),
  payConversionRate: rate.optional(), gmvTotal: nonNegative.optional(),
  gmvPerMin: nonNegative.optional(), gpm: nonNegative.optional(),
  adSpendTotal: nonNegative.optional(), adSpendPerMin: nonNegative.optional(),
  roi: nonNegative.optional(), commentsTotal: nonNegative.optional(),
  commentsPerMin: nonNegative.optional(), currentProductId: id.optional(),
  currentHostId: id.optional(), unit: z.record(z.string()).optional()
}).strict();

export const canonicalMetricSnapshotSchema = z.object({
  room_impression_uv: nonNegativeInteger.optional(),
  room_enter_uv: nonNegativeInteger.optional(),
  concurrent_viewers: nonNegativeInteger.optional(),
  product_impression_uv: nonNegativeInteger.optional(),
  product_click_uv: nonNegativeInteger.optional(),
  paid_order_count: nonNegativeInteger.optional(),
  paid_buyer_count: nonNegativeInteger.optional(),
  gross_paid_gmv_fen: nonNegativeInteger.optional(),
  refund_gmv_fen: nonNegativeInteger.optional(),
  ad_spend_fen: nonNegativeInteger.optional(),
  room_entry_rate: rate.optional(),
  product_click_rate: rate.optional(),
  click_to_paid_rate: rate.optional(),
  gross_roi: nonNegative.optional(),
  net_paid_gmv_fen: nonNegativeInteger.optional(),
  net_roi: nonNegative.optional(),
  current_product_id: id.optional(),
  current_host_id: id.optional()
}).strict();

/**
 * Compass live-screen fields keep the page's own time-window semantics. These
 * are deliberately separate from canonical cumulative/UV metrics until the
 * source contract is confirmed on a real account.
 */
export const liveCompassMetricSnapshotSchema = z.object({
  observedAt: isoDate,
  sourceEndpoint: z.string().min(1).max(180),
  mappingVersion: z.string().min(1).max(40),
  dataStatus: z.enum(["fresh", "stale", "offline", "unknown"]),
  onlineSnapshot: nonNegativeInteger.optional(),
  sessionPaidGmvFen: nonNegativeInteger.optional(),
  adSpendFen: nonNegativeInteger.optional(),
  paidBuyerCount: nonNegativeInteger.optional(),
  paidItemCount: nonNegativeInteger.optional(),
  watchToPaidRate: nonNegative.optional(),
  productClickToPaidRate: nonNegative.optional(),
  averageWatchDurationSec: nonNegativeInteger.max(86400).optional(),
  roomEnterCount5m: nonNegativeInteger.optional(),
  userPaidGmvFen5m: nonNegativeInteger.optional(),
  productClickCount: nonNegativeInteger.optional(),
  productPayGmvFen: nonNegativeInteger.optional(),
  unpaidOrderCount: nonNegativeInteger.optional(),
  productName: z.string().min(1).max(180).optional(),
  currentProductName: z.string().min(1).max(180).optional(),
  productPaidGmvFen: nonNegativeInteger.optional(),
  liveStatus: z.enum(["live", "ended", "unknown"]).optional(),
  windowLabel: z.string().min(1).max(80).optional()
}).strict();

/**
 * Qianchuan metrics keep their paid-traffic source and display unit explicit.
 * They are intentionally separate from the Compass snapshot: same-name
 * amounts/clicks must never be merged across platforms.
 */
export const qianchuanMetricValueSchema = z.object({
  value: nonNegative,
  unit: z.enum(["元", "%", "人", "次", "单", "unknown"]),
  semantic: z.enum(["instant", "cumulative", "rolling", "rate"]),
  sourceField: z.string().min(1).max(120),
  windowLabel: z.string().min(1).max(80).optional()
}).strict();

export const qianchuanMetricSnapshotSchema = z.object({
  observedAt: isoDate,
  sourceEndpoint: z.string().min(1).max(180),
  mappingVersion: z.string().min(1).max(40),
  dataStatus: z.enum(["fresh", "stale", "offline", "unknown"]),
  metricSource: z.literal("qianchuan"),
  roomId: z.string().regex(/^[0-9]+$/).optional(),
  roomStartedAt: isoDate.optional(),
  metrics: z.object({
    adSpend: qianchuanMetricValueSchema.optional(),
    paidOrderGmv: qianchuanMetricValueSchema.optional(),
    paidOrderCount: qianchuanMetricValueSchema.optional(),
    productImpressions: qianchuanMetricValueSchema.optional(),
    productClicks: qianchuanMetricValueSchema.optional(),
    liveImpressions: qianchuanMetricValueSchema.optional(),
    liveWatchCount: qianchuanMetricValueSchema.optional(),
    onlineSnapshot: qianchuanMetricValueSchema.optional(),
    gpm: qianchuanMetricValueSchema.optional(),
    watchToPaid: qianchuanMetricValueSchema.optional(),
    productClickToPaid: qianchuanMetricValueSchema.optional(),
    showToWatch: qianchuanMetricValueSchema.optional(),
    watchToProductClick: qianchuanMetricValueSchema.optional(),
    liveWatchToPaid: qianchuanMetricValueSchema.optional(),
    costPerPaidOrder: qianchuanMetricValueSchema.optional(),
    roi: qianchuanMetricValueSchema.optional(),
    cpmPlatform: qianchuanMetricValueSchema.optional(),
    platformCtr: qianchuanMetricValueSchema.optional(),
    platformConvertRate: qianchuanMetricValueSchema.optional(),
    commentCount: qianchuanMetricValueSchema.optional(),
    followCount: qianchuanMetricValueSchema.optional(),
    fansClubJoinCount: qianchuanMetricValueSchema.optional(),
    shareCount: qianchuanMetricValueSchema.optional(),
    payOrderAverage: qianchuanMetricValueSchema.optional()
  }).strict()
}).strict();

export const sourceGroupStatusSchema = z.enum([
  "fresh", "suspected_stall", "stalled", "recovering", "recovered", "login_required", "offline", "unknown"
]);
export const sourceOverallHealthSchema = z.enum([
  "fresh", "partial", "stalled", "login_required", "offline", "unknown"
]);
export const sourceGroupIdSchema = z.enum([
  "spend", "traffic", "interest", "conversion", "efficiency", "core", "product", "audio"
]);
export const liveSourceKindSchema = z.enum(["qianchuan", "compass"]);
export const sourceGroupHealthSchema = z.object({
  source: liveSourceKindSchema,
  group: sourceGroupIdSchema,
  status: sourceGroupStatusSchema,
  lastSeenAt: isoDate.optional(),
  expectedCadenceMs: nonNegativeInteger.optional(),
  suspectedAt: isoDate.optional(),
  stalledAt: isoDate.optional(),
  lastRecoveryAttemptAt: isoDate.optional(),
  lastRecoveredAt: isoDate.optional(),
  recoveryAttempts: nonNegativeInteger,
  missingFields: z.array(z.string().min(1).max(60)).max(16)
}).strict();
export const pageRuntimeStateSchema = z.object({
  source: liveSourceKindSchema,
  observedAt: isoDate,
  visibilityState: z.enum(["visible", "hidden", "prerender"]),
  hasFocus: z.boolean(),
  navigatorOnline: z.boolean(),
  debuggerAttached: z.boolean(),
  allowlistStatus: z.enum(["allowed", "login", "blocked"]),
  topFrameLifecycle: z.enum(["live", "loading", "stopped"]),
  lastNavigationAt: isoDate.optional()
}).strict();
export const recoveryHistoryEntrySchema = z.object({
  source: liveSourceKindSchema,
  group: sourceGroupIdSchema.optional(),
  action: z.enum(["rebuild_observer", "reload", "aborted", "blocked"]),
  outcome: z.enum(["pending", "recovered", "failed", "aborted", "blocked"]),
  attemptedAt: isoDate,
  recoveredAt: isoDate.optional(),
  reason: z.string().min(1).max(80)
}).strict();
export const sourceHealthReportSchema = z.object({
  qianchuan: z.object({
    overallHealth: sourceOverallHealthSchema,
    groups: z.array(sourceGroupHealthSchema).max(8)
  }).strict(),
  compass: z.object({
    overallHealth: sourceOverallHealthSchema,
    groups: z.array(sourceGroupHealthSchema).max(8)
  }).strict()
}).strict();
export const liveRecoveryRequestSchema = z.object({
  source: liveSourceKindSchema,
  action: z.enum(["request_reload", "rebuild_observer", "report"]),
  confirm: z.boolean().optional(),
  outcome: z.enum(["pending", "recovered", "failed", "aborted", "blocked"]).optional(),
  reason: z.string().min(1).max(80).optional()
}).strict();

export const liveCompassActionSchema = z.object({
  id, createdAt: isoDate, kind: z.enum(["action", "review", "recovery"]), title: z.string().min(1).max(180),
  message: z.string().min(1).max(500), reason: z.string().min(1).max(800), evidenceEventIds: z.array(id).max(8),
  issueKey: z.string().min(1).max(160), confidence: z.enum(["high", "medium", "low"])
}).strict();
export const liveCompassActionFeedbackSchema = z.object({
  id, actionId: id, status: z.enum(["executed", "not_executed", "not_applicable"]), operatorId: id, createdAt: isoDate
}).strict();
export const liveCompassActionResolutionSchema = z.object({
  id, actionId: id, status: z.literal("resolved"), reason: z.enum(["payment_recovered", "condition_cleared", "superseded"]), resolvedAt: isoDate
}).strict();

/**
 * Phase 2B（D029）：15 分钟窗口聚合。窗口按本地整点对齐（:00/:15/:30/:45），
 * weekday 与 slotIndex 用固定 UTC 偏移（默认 +08:00）从事件时间确定性计算。
 * 字段没有样本时不出现在聚合里，不得用 0 代替缺失。
 */
export const liveWindowFieldStatSchema = z.object({
  semantic: z.enum(["instant", "cumulative", "rolling", "rate"]),
  sampleCount: z.number().int().positive(),
  firstAt: isoDate,
  lastAt: isoDate,
  first: z.number().finite(),
  last: z.number().finite(),
  min: z.number().finite(),
  max: z.number().finite(),
  /** 仅 cumulative：窗口内正向增量之和（跨窗口以上一窗末值为基准，计数器回退不产生负增量）。 */
  delta: nonNegative.optional(),
  /** 仅 cumulative：窗口内观察到的计数器回退次数。 */
  resetCount: nonNegativeInteger.optional()
}).strict();

export const liveWindowSpeechStatSchema = z.object({
  finalCount: nonNegativeInteger,
  charCount: nonNegativeInteger,
  firstAt: isoDate.optional(),
  lastAt: isoDate.optional(),
  /** 相邻 final 之间的最大间隔毫秒；不足 2 条时缺省。 */
  maxGapMs: nonNegativeInteger.optional()
}).strict();

export const liveWindowAggregateSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: id,
  sessionId: id,
  windowStartAt: isoDate,
  windowEndAt: isoDate,
  windowMinutes: z.literal(15),
  utcOffsetMinutes: z.number().int().min(-720).max(840),
  /** 0=周日 … 6=周六，按 utcOffsetMinutes 的本地时间计算。 */
  weekday: z.number().int().min(0).max(6),
  /** 本地一天内第几个 15 分钟槽：0=00:00–00:15 … 95=23:45–24:00。 */
  slotIndex: z.number().int().min(0).max(95),
  /** key 为罗盘快照字段名；仅包含房间级字段，不聚合跨商品字段。 */
  compass: z.record(z.string().min(1).max(60), liveWindowFieldStatSchema),
  /** key 为千川 metrics 字段名，semantic 来自源值自带声明。 */
  qianchuan: z.record(z.string().min(1).max(60), liveWindowFieldStatSchema),
  speech: liveWindowSpeechStatSchema,
  sampleCounts: z.object({
    compassSnapshots: nonNegativeInteger,
    qianchuanSnapshots: nonNegativeInteger,
    speechFinals: nonNegativeInteger
  }).strict(),
  /** full：会话覆盖整个窗口；partial：窗口首尾越出会话范围；不发射无样本窗口。 */
  coverage: z.enum(["full", "partial"])
}).strict().refine(
  (value) => Date.parse(value.windowEndAt) - Date.parse(value.windowStartAt) === 15 * 60 * 1000,
  { path: ["windowEndAt"], message: "窗口必须是完整15分钟区间" }
);

/**
 * Phase 2B / M1（D031）：同星期同时钟小时历史基线。
 * 房间合计是默认基线；主播切片保留给 M4。缺失字段不出现，不得用 0 代替无样本。
 */
export const HISTORICAL_HOUR_MAPPING_VERSION = "historical-hours-hour-v1" as const;
export const historicalHourGrainSchema = z.literal("hour");
export const historicalSnapshotGrainSchema = z.literal("snapshot");
export const historicalSourceKindSchema = z.enum(["live-register", "capture-snapshot"]);
export const historicalRowKindSchema = z.enum(["room_hour", "anchor_slice"]);
export const historicalGsvDerivationSchema = z.enum(["source_column", "gmv_minus_refund"]);
export const historicalDataStatusSchema = z.enum(["complete", "incomplete", "excluded"]);

export const historicalHourWindowKeySchema = z.object({
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  windowLabel: z.string().min(1).max(32),
  utcOffsetMinutes: z.literal(480),
  windowStartAt: isoDate,
  windowEndAt: isoDate,
  grain: historicalHourGrainSchema
}).strict().refine(
  (value) => Date.parse(value.windowEndAt) - Date.parse(value.windowStartAt) === 60 * 60 * 1000,
  { path: ["windowEndAt"], message: "小时窗口必须是完整60分钟区间" }
);

export const historicalHourMetricsSchema = z.object({
  gmvFen: nonNegativeInteger.optional(),
  refundFen: nonNegativeInteger.optional(),
  gsvFen: nonNegativeInteger.optional(),
  gsvDerivation: historicalGsvDerivationSchema.optional(),
  adSpendFen: nonNegativeInteger.optional(),
  onlineSnapshot: nonNegativeInteger.optional(),
  roomImpressionUv: nonNegativeInteger.optional(),
  roomEnterUv: nonNegativeInteger.optional(),
  roomImpressionPv: nonNegativeInteger.optional(),
  roomEnterPv: nonNegativeInteger.optional(),
  productImpressionUv: nonNegativeInteger.optional(),
  productClickUv: nonNegativeInteger.optional(),
  paidBuyerCount: nonNegativeInteger.optional(),
  watchToPaidRate: rate.optional(),
  productClickRate: rate.optional(),
  productClickToPaidRate: rate.optional(),
  roi: nonNegative.optional(),
  gsvRoi: nonNegative.optional(),
  averageWatchDurationSec: nonNegativeInteger.max(86400).optional()
}).strict();

const historicalImportBaseSchema = z.object({
  schemaVersion: z.literal(1),
  mappingVersion: z.literal(HISTORICAL_HOUR_MAPPING_VERSION),
  source: z.literal("csv_import"),
  window: historicalHourWindowKeySchema,
  metrics: historicalHourMetricsSchema,
  dataStatus: historicalDataStatusSchema,
  exclusionReason: z.string().min(1).max(180).optional(),
  shift: z.string().min(1).max(40).optional(),
  durationMin: nonNegative.optional()
});

export const historicalHourAnchorSliceSchema = historicalImportBaseSchema.extend({
  sourceKind: z.literal("live-register"),
  rowKind: z.literal("anchor_slice"),
  anchorName: z.string().min(1).max(80).optional(),
  controllerName: z.string().min(1).max(80).optional(),
  startedAtLocal: z.string().min(1).max(40).optional(),
  endedAtLocal: z.string().min(1).max(40).optional()
}).strict();

export const historicalHourRoomAggregateSchema = historicalImportBaseSchema.extend({
  sourceKind: z.literal("live-register"),
  rowKind: z.literal("room_hour"),
  sliceCount: z.number().int().positive(),
  anchorNames: z.array(z.string().min(1).max(80)).max(16),
  onlineSourceKind: z.literal("capture-snapshot").optional()
}).strict();

export const historicalCaptureSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  mappingVersion: z.literal(HISTORICAL_HOUR_MAPPING_VERSION),
  source: z.literal("csv_import"),
  sourceKind: z.literal("capture-snapshot"),
  grain: historicalSnapshotGrainSchema,
  observedAt: isoDate,
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  utcOffsetMinutes: z.literal(480),
  anchorName: z.string().min(1).max(80).optional(),
  shift: z.string().min(1).max(40).optional(),
  onlineSnapshot: nonNegativeInteger.optional(),
  dataStatus: historicalDataStatusSchema
}).strict();

export const historicalHourBaselineMetricKeySchema = z.enum([
  "gmvFen", "gsvFen", "refundFen", "adSpendFen", "onlineSnapshot",
  "roomImpressionUv", "roomEnterUv", "roomImpressionPv", "roomEnterPv",
  "productImpressionUv", "productClickUv", "paidBuyerCount",
  "watchToPaidRate", "productClickRate", "productClickToPaidRate", "roi", "gsvRoi", "averageWatchDurationSec"
]);

export const historicalHourBaselineOkSchema = z.object({
  status: z.literal("ok"),
  grain: historicalHourGrainSchema,
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  metricKey: historicalHourBaselineMetricKeySchema,
  n: z.number().int().min(3).max(8),
  median: z.number().finite(),
  p25: z.number().finite(),
  p75: z.number().finite(),
  sampleLocalDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(3).max(8)
}).strict();

export const historicalHourBaselineInsufficientSchema = z.object({
  status: z.literal("sampleInsufficient"),
  grain: historicalHourGrainSchema,
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  metricKey: historicalHourBaselineMetricKeySchema,
  n: nonNegativeInteger,
  reason: z.enum(["n_lt_3", "hour_not_split_to_quarter", "no_complete_samples"])
}).strict();

export const historicalHourBaselineSchema = z.discriminatedUnion("status", [
  historicalHourBaselineOkSchema,
  historicalHourBaselineInsufficientSchema
]);

export const historicalBaselineSyncHealthSchema = z.enum(["never_synced", "ok", "degraded"]);
export const historicalBaselineErrorSchema = z.object({
  at: isoDate,
  message: z.string().min(1).max(300)
}).strict();
export const historicalBaselineSheetSummarySchema = z.object({
  sheetName: z.string().min(1).max(80),
  rowCount: nonNegativeInteger
}).strict();
export const historicalBaselineCoverageCountSchema = z.object({
  metricKey: historicalHourBaselineMetricKeySchema,
  okCells: nonNegativeInteger,
  totalCells: z.literal(168)
}).strict();
export const historicalBaselineViewSchema = z.object({
  status: historicalBaselineSyncHealthSchema,
  mappingVersion: z.literal(HISTORICAL_HOUR_MAPPING_VERSION),
  grain: historicalHourGrainSchema,
  lastSuccessAt: isoDate.optional(),
  lastError: historicalBaselineErrorSchema.optional(),
  lastAttemptAt: isoDate.optional(),
  asOfLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  importedCompleteDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  completeRoomHours: nonNegativeInteger,
  skippedUnchangedDates: nonNegativeInteger,
  importedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  sourceSheets: z.array(historicalBaselineSheetSummarySchema),
  coverage: z.array(historicalBaselineCoverageCountSchema)
}).strict();

/**
 * Phase 2B / M1（D035）：驾驶舱当前时钟小时 vs 同星期同时钟小时基线。
 * 比较的是 hour grain；禁止把小时基线均分成 15 分钟。缺失不补 0。
 */
export const liveHourComparisonMetricKeySchema = z.enum(["gmvFen", "gsvFen", "adSpendFen", "onlineSnapshot"]);
export const liveHourCitedNumberSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.number().finite(),
  unit: z.string().min(1).max(24)
}).strict();
export const liveHourComparisonMetricSchema = z.object({
  metricKey: liveHourComparisonMetricKeySchema,
  grain: historicalHourGrainSchema,
  liveStatus: z.enum(["ok", "missing"]),
  liveValue: z.number().finite().optional(),
  liveCoverage: z.enum(["hour_to_date", "full_hour", "unavailable"]),
  baseline: historicalHourBaselineSchema,
  band: z.enum(["above_p75", "within_iqr", "below_p25"]).optional()
}).strict();
export const liveHourVsBaselineSchema = z.object({
  grain: historicalHourGrainSchema,
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  lastSuccessAt: isoDate.optional(),
  asOfLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  metrics: z.array(liveHourComparisonMetricSchema).max(4)
}).strict();

/** Phase 0 camelCase payloads remain readable; Phase 1 producers must use canonicalMetricSnapshotSchema. */
export const metricSnapshotSchema = z.union([canonicalMetricSnapshotSchema, legacyMetricSnapshotSchema]);

export const transcriptSegmentSchema = z.object({
  id, tenantId: id, sessionId: id, startMs: nonNegative, endMs: nonNegative,
  text: z.string().min(1).max(3000), isFinal: z.boolean(), confidence: rate.optional(),
  speakerId: id.optional(), hostId: id.optional(), productId: id.optional(),
  productRoundId: id.optional(), tags: z.array(speechTagSchema), sourceEventId: id
}).strict().refine((value) => value.endMs >= value.startMs, "endMs 必须大于等于 startMs");

export const productRoundSchema = z.object({
  id, sessionId: id, productId: id, hostId: id.optional(), startedAt: isoDate,
  endedAt: isoDate.optional(), startEventId: id, endEventId: id.optional(),
  tagsSummary: z.record(speechTagSchema, z.number().int().nonnegative()),
  metricSummary: z.record(z.number().finite()).optional()
}).strict();

export const detectedEventSchema = z.object({
  id, sessionId: id, ruleId: id, ruleVersion: z.number().int().positive(),
  severity: z.enum(["info", "warning", "critical"]), detectedAt: isoDate,
  title: z.string().min(1), summary: z.string().min(1),
  evidenceEventIds: z.array(id), metricWindowIds: z.array(id),
  speechSegmentIds: z.array(id), sampleSufficient: z.boolean(),
  suppressedReason: z.string().optional()
}).strict();

export const metricEvidenceSchema = z.object({
  metric: z.enum([
    "room_impression_uv", "room_enter_uv", "concurrent_viewers", "product_impression_uv",
    "product_click_uv", "paid_order_count", "paid_buyer_count", "gross_paid_gmv_fen",
    "refund_gmv_fen", "ad_spend_fen", "room_entry_rate", "product_click_rate",
    "click_to_paid_rate", "gross_roi", "net_paid_gmv_fen", "net_roi"
  ]),
  windowSec: z.number().int().positive(),
  value: z.number().finite(),
  baseline: z.number().finite().optional(),
  summary: z.string().min(1),
  eventIds: z.array(id)
}).strict();

export const speechEvidenceSchema = z.object({
  segmentId: id,
  summary: z.string().min(1),
  tags: z.array(speechTagSchema)
}).strict();

export const dataEvidenceSchema = z.object({
  type: z.enum(["metric_window", "metric_comparison", "comment_intent", "traffic_change"]),
  label: z.string().min(1),
  summary: z.string().min(1),
  windowSec: z.number().int().positive().optional(),
  value: z.number().finite().optional(),
  baseline: z.number().finite().optional(),
  unit: z.string().min(1).optional(),
  eventIds: z.array(id)
}).strict();

export const adviceStatusSchema = z.enum(["generated", "delivered", "seen", "accepted", "rejected", "expired"]);
export const adviceSchema = z.object({
  id, tenantId: id, sessionId: id, detectedEventId: id,
  ruleId: id, ruleVersion: z.number().int().positive(), createdAt: isoDate, triggeredAt: isoDate,
  expiresAt: isoDate, priority: z.enum(["low", "medium", "high"]),
  title: z.string().min(1), problem: z.string().min(1),
  currentProductId: id, currentHostId: id,
  metricEvidence: z.array(metricEvidenceSchema), speechEvidence: z.array(speechEvidenceSchema),
  dataEvidence: z.array(dataEvidenceSchema).min(1),
  action: z.string().min(1), hostMessage: z.string().min(1),
  limitations: z.array(z.string().min(1)).min(1),
  status: z.literal("generated"), provider: z.literal("deterministic-rule-advice")
}).strict();

export const adviceDeliverySchema = z.object({
  id, adviceId: id, deliveredAt: isoDate
}).strict();

export const adviceFeedbackSchema = z.object({
  id, adviceId: id, operatorId: id, type: z.enum(["seen", "accepted", "rejected"]),
  reason: z.string().optional(), createdAt: isoDate
}).strict();

export const businessReviewProblemSchema = z.enum(["yes", "partial", "no"]);
export const businessReviewTranscriptSchema = z.enum(["accurate", "partial", "inaccurate"]);
export const businessReviewActionabilitySchema = z.enum(["yes", "average", "no"]);
export const businessReviewRelayabilitySchema = z.enum(["can", "edit", "cannot"]);
export const businessReviewTimingSchema = z.enum(["early", "right", "late"]);
export const businessReviewAdviceTypeSchema = z.enum(["realtime", "post_session"]);

/** A reviewer submission is an append-only event payload, not a mutable advice record. */
export const businessReviewSubmissionSchema = z.object({
  reviewSubmissionId: id, adviceId: id, operatorId: id,
  problemExists: businessReviewProblemSchema,
  transcriptAccuracy: businessReviewTranscriptSchema,
  realProblem: businessReviewProblemSchema,
  actionable: businessReviewActionabilitySchema,
  relayability: businessReviewRelayabilitySchema,
  timing: businessReviewTimingSchema,
  adviceType: businessReviewAdviceTypeSchema,
  usefulness: z.number().int().min(1).max(5),
  comment: z.string().max(1000)
}).strict();

export const adviceExecutionSchema = z.object({
  id, adviceId: id, operatorId: id,
  status: z.enum(["not_executed", "executing", "executed", "unknown"]),
  createdAt: isoDate, anchorEventAt: isoDate,
  startedAt: isoDate.optional(), executedAt: isoDate.optional(), notes: z.string().optional()
}).strict().superRefine((value, context) => {
  if (value.status === "executing" && !value.startedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["startedAt"], message: "开始执行必须记录 startedAt" });
  }
  if (value.status === "executed" && (!value.startedAt || !value.executedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["executedAt"], message: "已执行必须记录 startedAt 和 executedAt" });
  }
});

export const observationStatusSchema = z.enum(["pending", "observed", "insufficient_sample", "confounded"]);
export const outcomeInterpretationSchema = z.enum(["上升", "下降", "无明显变化", "样本不足", "明显干扰无法判断"]);

export const adviceOutcomeSchema = z.object({
  id, adviceId: id, executionId: id,
  windowSec: z.union([z.literal(60), z.literal(120), z.literal(180), z.literal(300)]),
  metric: z.string().min(1),
  observationStatus: observationStatusSchema,
  observedAt: isoDate, anchorEventAt: isoDate,
  operatorId: id.optional(),
  currentProductId: id,
  currentHostId: id,
  trafficState: z.enum(["baseline", "scale_up", "scale_down", "unknown"]),
  productSwitched: z.boolean(),
  trafficChanged: z.boolean(),
  sampleSufficient: z.boolean(),
  beforeMetrics: canonicalMetricSnapshotSchema.optional(),
  afterMetrics: canonicalMetricSnapshotSchema.optional(),
  beforeValue: z.number().finite().optional(), afterValue: z.number().finite().optional(),
  absoluteChange: z.number().finite().optional(), relativeChange: z.number().finite().optional(),
  sampleSize: nonNegative.optional(), confounders: z.array(z.string()),
  interpretation: outcomeInterpretationSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.observationStatus === "pending" && value.interpretation !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["interpretation"], message: "等待观察时不能提前写入结果" });
  }
  if (value.observationStatus !== "pending" && value.interpretation === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["interpretation"], message: "观察结束后必须写入结果" });
  }
});

export const ruleStatusSchema = z.object({
  id, sessionId: id, ruleId: id, ruleVersion: z.number().int().positive(),
  status: z.enum(["monitoring", "triggered", "insufficient_sample", "cooldown", "confounded"]),
  evaluatedAt: isoDate, reason: z.string().min(1), evidenceEventIds: z.array(id)
}).strict();

export const caseCardSchema = z.object({
  id, tenantId: id, sessionId: id, title: z.string().min(1),
  context: z.object({
    brandId: id.optional(), roomId: id.optional(), hostId: id.optional(), productId: id.optional(),
    audienceType: z.string().optional(), trafficType: z.string().optional(), timeOfDay: z.string().optional(),
    productRoundId: id.optional()
  }).strict(), problemType: z.string().min(1), observedSignals: z.array(z.string()),
  speechEvidenceIds: z.array(id), metricEvidenceIds: z.array(id), actionTaken: z.string().optional(),
  executionDelaySec: nonNegative.optional(), outcomeWindows: z.array(z.object({
    windowSec: z.number().int().positive(), metric: z.string().min(1), before: z.number().optional(),
    after: z.number().optional(), change: z.number().optional()
  }).strict()), confounders: z.array(z.string()), conclusion: z.string(), applicability: z.array(z.string()),
  limitations: z.array(z.string()), status: z.enum(["candidate", "observed", "validated", "approved_sop", "unstable", "deprecated"]),
  evidenceCount: z.number().int().nonnegative(), confidence: rate, createdAt: isoDate, reviewedBy: id.optional()
}).strict();

export const modelRunSchema = z.object({
  id, tenantId: id, sessionId: id.optional(), purpose: z.enum(["advice", "review", "case_extraction", "speech_tagging"]),
  provider: z.string().min(1), model: z.string().min(1), promptVersion: z.string().min(1),
  triggeredBy: z.string().min(1), inputHash: z.string().min(1), inputSummary: z.string(),
  retrievedCaseIds: z.array(id), outputJson: z.unknown().optional(), status: z.enum(["success", "failed", "fallback", "cached"]),
  latencyMs: nonNegative.optional(), inputTokens: nonNegative.optional(), outputTokens: nonNegative.optional(),
  estimatedCost: nonNegative.optional(), errorCode: z.string().optional(), createdAt: isoDate
}).strict();

export const sourceHealthSchema = z.object({
  sourceId: id, status: z.enum(["healthy", "degraded", "offline", "unauthorized"]),
  lastEventAt: isoDate.optional(), latencyMs: nonNegative.optional(), completeness: rate.optional(),
  schemaVersion: z.string().optional(), message: z.string().optional(), checkedAt: isoDate
}).strict();

export const legacyTrafficChangeSchema = z.object({
  adSpendPerMin: nonNegative, reason: z.enum(["baseline", "scale_up", "scale_down"]), planName: z.string().min(1)
}).strict();
export const canonicalTrafficChangeSchema = z.object({
  ad_spend_fen_per_min: nonNegativeInteger,
  reason: z.enum(["baseline", "scale_up", "scale_down"]),
  plan_name: z.string().min(1)
}).strict();
export const trafficChangeSchema = z.union([canonicalTrafficChangeSchema, legacyTrafficChangeSchema]);

export const commentIntentSchema = z.object({
  intent: z.enum(["price", "usage", "quality", "shipping", "positive"]), count: z.number().int().positive()
}).strict();

export const sessionMarkerSchema = z.object({ marker: z.enum(["started", "stopped", "completed", "interrupted"]) }).strict();

/** v0.1 contracts are additive; the legacy Phase 0/1 event schemas remain unchanged. */
export const mvpProductTypeSchema = z.enum(["low_price_new_customer", "high_price_repeat_customer"]);
export const mvpProductSchema = z.object({
  productId: id, name: z.string().min(1).max(120), type: mvpProductTypeSchema,
  priceFen: nonNegativeInteger, enabled: z.boolean(), note: z.string().max(300).optional()
}).strict();
export const mvpStateIdSchema = z.enum(["S0", "S1", "S2", "S3", "S4", "S5", "S6"]);
export const mvpActionKeySchema = z.enum([
  "none", "retain_and_rehook", "switch_to_top_intent", "shorten_and_retain", "close_high_intent",
  "complete_closure", "complete_closure_with_real_scarcity", "keep_and_short_close", "reset_segment",
  "strengthen_product_card", "strengthen_purchase_instruction", "quick_product_value", "add_price_mechanism",
  "send_giveaway", "create_order_hold", "lock_real_inventory", "emphasize_real_deadline", "continue_observing"
]);

export const diagnosisProviderSchema = z.enum(["deterministic-template", "ark-expression"]);
export const diagnosisConfidenceSchema = z.enum(["confirmed", "leaning", "unknown"]);
export const diagnosisActionKindSchema = z.enum([
  "hold", "check_spend", "traffic_quality", "retain", "click_cta", "close_gift", "close_price", "close_urgency", "wait"
]);
export const diagnosisFunnelStageSchema = z.enum([
  "spend_spike", "spend", "exposure", "entry", "click", "convert", "aov", "maintain", "wait"
]);
const diagnosisExpressionTextSchema = z.object({
  id: z.string().min(1).max(80),
  text: z.string().min(1).max(400)
}).strict();
export const diagnosisExpressionOutputSchema = z.object({
  verdict: diagnosisExpressionTextSchema,
  evidence: z.array(diagnosisExpressionTextSchema).min(1).max(4),
  action: diagnosisExpressionTextSchema,
  watchNext: diagnosisExpressionTextSchema,
  pending: z.array(diagnosisExpressionTextSchema).max(3)
}).strict();
export const liveProductRoleSchema = z.enum([
  "trial_acquisition", "value_bundle", "repeat_purchase", "welfare_item", "unknown"
]);
export const diagnosisExecutionStateSchema = z.enum(["complete", "incomplete", "unknown", "not_applicable"]);
export const diagnosisTriggerTypeSchema = z.enum([
  "scheduled_15m", "event_spend_spike", "event_traffic_drop", "event_click_no_pay"
]);
export const diagnosisInterruptDecisionSchema = z.enum(["interrupt", "observe", "status_only"]);
export const diagnosisCardFieldSchema = z.string().min(1).max(400);
export const diagnosisExpressionV2OutputSchema = z.object({
  whatHappened: diagnosisCardFieldSchema,
  why: diagnosisCardFieldSchema,
  action: diagnosisCardFieldSchema,
  watchNext: diagnosisCardFieldSchema
}).strict();
export const liveProductContextPayloadSchema = z.object({
  role: liveProductRoleSchema,
  source: z.literal("operator"),
  productName: z.string().min(1).max(120).optional(),
  productId: id.optional()
}).strict();
export const diagnosisEvidencePacketSchema = z.object({
  triggerType: diagnosisTriggerTypeSchema,
  triggerAt: isoDate,
  windowStartAt: isoDate,
  windowEndAt: isoDate,
  dataFreshness: z.enum(["fresh", "stale", "offline", "unknown"]),
  productContext: z.object({
    role: liveProductRoleSchema,
    confounded: z.boolean(),
    productName: z.string().max(120).optional()
  }).strict(),
  funnelStage: diagnosisFunnelStageSchema,
  executionState: diagnosisExecutionStateSchema,
  confidence: diagnosisConfidenceSchema,
  currentMetrics: z.record(z.string(), z.number()),
  previousMetrics: z.record(z.string(), z.number()),
  historicalBaseline: z.record(z.string(), z.number()),
  speechPresentKeys: z.array(z.string().min(1).max(40)).max(15),
  speechMissingKeys: z.array(z.string().min(1).max(40)).max(15),
  relevantQuotes: z.array(z.string().min(1).max(200)).max(4),
  lockedActionKind: diagnosisActionKindSchema,
  interruptDecision: diagnosisInterruptDecisionSchema,
  unknowns: z.array(z.string().min(1).max(80)).max(8),
  previousActionOutcome: z.enum(["relieved", "unrelieved", "observing", "not_evaluated"]).optional(),
  dataCompleteness: z.enum(["complete", "data_incomplete"]).optional()
}).strict();

/**
 * Phase 2B / M2（D036）+ M3（D038）+ D040：15 分钟诊断卡。
 * 规则层始终先出 deterministic-template；表达层只改写中文。
 * 主结构是结论 / 证据 / 动作 / 待确认；conclusions 与 nextWindowSuggestion 为兼容投影。
 */
export const diagnosisFindingSchema = z.object({
  id: z.string().min(1).max(80),
  text: z.string().min(1).max(400),
  citedNumbers: z.array(liveHourCitedNumberSchema).min(1).max(6)
}).strict();
export const diagnosisAnomalySchema = z.object({
  type: z.enum(["ad_spend_spike", "counter_reset"]),
  text: z.string().min(1).max(240),
  citedNumbers: z.array(liveHourCitedNumberSchema).min(1).max(4)
}).strict();
export const diagnosisWindowCurrentSchema = z.object({
  gmvFen: nonNegativeInteger.optional(),
  adSpendFen: nonNegativeInteger.optional(),
  onlineSnapshot: nonNegativeInteger.optional(),
  productClicks: nonNegativeInteger.optional(),
  paidOrders: nonNegativeInteger.optional(),
  speechFinalCount: nonNegativeInteger,
  currentProductName: z.string().min(1).max(120).optional()
}).strict();
export const diagnosisWindowSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: id,
  windowStartAt: isoDate,
  windowEndAt: isoDate,
  windowMinutes: z.union([z.literal(5), z.literal(15)]),
  weekday: z.number().int().min(0).max(6),
  slotIndex: z.number().int().min(0).max(95),
  hourAlignment: z.object({
    hour: z.number().int().min(0).max(23),
    grain: z.literal("hour"),
    note: z.string().min(8).max(80)
  }).strict(),
  coverage: z.enum(["full", "partial"]),
  provider: diagnosisProviderSchema,
  confidence: diagnosisConfidenceSchema,
  actionKind: diagnosisActionKindSchema,
  funnelStage: diagnosisFunnelStageSchema,
  streakCount: z.number().int().min(1).max(8),
  current: diagnosisWindowCurrentSchema,
  previous: z.object({
    gmvFen: nonNegativeInteger.optional(),
    adSpendFen: nonNegativeInteger.optional(),
    onlineSnapshot: nonNegativeInteger.optional()
  }).strict().nullable(),
  hourBaseline: z.object({
    grain: z.literal("hour"),
    gmvFen: historicalHourBaselineSchema,
    gsvFen: historicalHourBaselineSchema,
    adSpendFen: historicalHourBaselineSchema,
    onlineSnapshot: historicalHourBaselineSchema.optional()
  }).strict(),
  stateShare: z.record(mvpStateIdSchema, z.number().min(0).max(1)),
  speechPresentKeys: z.array(z.string().min(1).max(40)).max(15),
  anomalies: z.array(diagnosisAnomalySchema).max(4),
  verdict: diagnosisFindingSchema,
  evidence: z.array(diagnosisFindingSchema).min(1).max(4),
  action: diagnosisFindingSchema,
  watchNext: diagnosisFindingSchema,
  pending: z.array(diagnosisFindingSchema).max(3),
  conclusions: z.array(diagnosisFindingSchema).max(3),
  nextWindowSuggestion: diagnosisFindingSchema,
  triggerType: diagnosisTriggerTypeSchema.optional(),
  executionState: diagnosisExecutionStateSchema.optional(),
  interruptDecision: diagnosisInterruptDecisionSchema.optional(),
  productRole: liveProductRoleSchema.optional(),
  productRoleConfounded: z.boolean().optional(),
  issueKey: z.string().min(1).max(120).optional(),
  observationMinutes: z.number().int().min(3).max(5).optional(),
  previousActionOutcome: z.enum(["relieved", "unrelieved", "observing", "not_evaluated"]).optional(),
  dataCompleteness: z.enum(["complete", "data_incomplete"]).optional(),
  incompleteGroups: z.array(z.string().min(1).max(40)).max(8).optional()
}).strict().refine(
  (value) => Date.parse(value.windowEndAt) - Date.parse(value.windowStartAt) === value.windowMinutes * 60 * 1000,
  { path: ["windowEndAt"], message: "诊断窗口时长必须等于 windowMinutes" }
);

/**
 * Phase 2B / M4（D045）：主播话术评分。
 * 参考话术是版本化的要点清单；覆盖度由确定性关键词匹配打底计算；
 * 报告措辞只说相关性，不说因果；无样本时显示"样本不足"，不得用 0 代替缺失。
 */
export const referenceScriptGroupSchema = z.enum([
  "hook", "pain_point", "selling_point", "price_mechanism", "cta", "urgency", "trust", "follow"
]);
export const referenceScriptPointSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  group: referenceScriptGroupSchema,
  keywords: z.array(z.string().min(1).max(40)).min(1).max(40),
  /** 权重 1~3：3 为必讲要点，缺讲优先进建议。 */
  weight: z.number().int().min(1).max(3),
  note: z.string().min(1).max(240).optional()
}).strict();
export const referenceScriptSchema = z.object({
  version: z.string().min(1).max(60),
  /** 版本依据：来源材料或依据场次，v1→v2 修改必须写明。 */
  basedOn: z.string().min(1).max(240),
  points: z.array(referenceScriptPointSchema).min(1).max(60)
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  for (const [index, point] of value.points.entries()) {
    if (keys.has(point.key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["points", index, "key"], message: `要点 key 重复：${point.key}` });
    keys.add(point.key);
  }
});

export const anchorPointEvidenceSchema = z.object({
  at: isoDate,
  quote: z.string().min(1).max(120)
}).strict();
export const anchorPointCoverageSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  group: referenceScriptGroupSchema,
  weight: z.number().int().min(1).max(3),
  covered: z.boolean(),
  mentionCount: nonNegativeInteger,
  mentionWindowStarts: z.array(isoDate).max(64),
  firstEvidence: anchorPointEvidenceSchema.optional()
}).strict();
export const anchorWindowCoverageSchema = z.object({
  windowStartAt: isoDate,
  windowEndAt: isoDate,
  speechFinals: nonNegativeInteger,
  coveredKeys: z.array(z.string().min(1).max(60)).max(60),
  coverageRate: rate,
  urgencyMentions: nonNegativeInteger
}).strict();
export const anchorLinkageSchema = z.object({
  pointKey: z.string().min(1).max(60),
  windowStartAt: isoDate,
  at: isoDate,
  quote: z.string().min(1).max(120),
  window: z.object({ productClicks: nonNegativeInteger.optional(), paidBuyersDelta: nonNegativeInteger.optional() }).strict(),
  nextWindow: z.object({
    windowStartAt: isoDate,
    productClicks: nonNegativeInteger.optional(),
    paidBuyersDelta: nonNegativeInteger.optional()
  }).strict().optional(),
  /** 只描述相关性（提及后下一窗指标变化），不得写成因果。 */
  note: z.string().min(1).max(240)
}).strict();
export const anchorScoreSchema = z.object({
  total: z.number().int().min(0).max(100),
  weightedCoverageRate: rate,
  coveredPoints: nonNegativeInteger,
  totalPoints: z.number().int().positive(),
  /** 平均每个 15 分钟窗口的催单类要点提及次数；无完整窗口时缺省。 */
  urgencyPerWindow: nonNegative.optional()
}).strict();
export const anchorSessionReportSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: id,
  sessionId: id,
  scriptVersion: z.string().min(1).max(60),
  generatedAt: isoDate,
  sessionStatus: z.enum(["running", "stopped"]),
  windowCount: nonNegativeInteger,
  speechFinalCount: nonNegativeInteger,
  /** 转写样本不足时为 null，前端显示"样本不足"，不显示假分数。 */
  score: anchorScoreSchema.nullable(),
  points: z.array(anchorPointCoverageSchema).min(1).max(60),
  windows: z.array(anchorWindowCoverageSchema).max(64),
  linkage: z.array(anchorLinkageSchema).max(20),
  suggestions: z.array(z.string().min(1).max(240)).max(3),
  dataNotes: z.array(z.string().min(1).max(240)).max(6)
}).strict();

/**
 * Phase 2B / D047：主播复盘是独立分析动作，不在副驾折叠区自动跑。
 * 输入：参考话术（库 v1 或当场粘贴）、已结束的 15 分钟时段、主播名字。
 * 主播名字用于叙述；ASR 按场次存储，不按主播过滤。
 */
export const anchorReviewScriptSourceSchema = z.enum(["library-v1", "pasted"]);
export const anchorReviewRequestSchema = z.object({
  sessionId: id,
  hostName: z.string().trim().min(1).max(40).refine((value) => !/\d{6,}/.test(value), "主播名字不能包含连续6位以上数字"),
  rangeStartAt: isoDate,
  rangeEndAt: isoDate,
  scriptSource: anchorReviewScriptSourceSchema,
  scriptText: z.string().min(1).max(8000).optional()
}).strict().superRefine((value, context) => {
  if (value.scriptSource === "pasted" && !value.scriptText?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scriptText"], message: "粘贴参考话术不能为空" });
  }
  if (Date.parse(value.rangeEndAt) <= Date.parse(value.rangeStartAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["rangeEndAt"], message: "结束时间必须晚于开始时间" });
  }
});
export const livePastWindowOptionSchema = z.object({
  windowStartAt: isoDate,
  windowEndAt: isoDate,
  speechFinals: nonNegativeInteger,
  coverage: z.enum(["full", "partial"])
}).strict();
export const liveSessionCatalogItemSchema = z.object({
  sessionId: id,
  name: z.string().min(1).max(100),
  status: z.enum(["created", "running", "stopped", "completed"]),
  startedAt: isoDate.optional(),
  stoppedAt: isoDate.optional(),
  windowCount: nonNegativeInteger,
  speechFinalCount: nonNegativeInteger,
  pastWindows: z.array(livePastWindowOptionSchema).max(48)
}).strict();
export const liveSessionCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  sessions: z.array(liveSessionCatalogItemSchema).max(50)
}).strict();
export const livePilotSessionRefSchema = z.object({
  sessionId: id,
  dashboardPath: z.string().min(1).max(200)
}).strict();
export const livePilotCreateResponseSchema = livePilotSessionRefSchema.extend({
  pairToken: z.string().min(32).max(128)
}).strict();
export const livePilotReattachResponseSchema = livePilotSessionRefSchema;
export type LivePilotCreateResponse = z.infer<typeof livePilotCreateResponseSchema>;
export type LivePilotReattachResponse = z.infer<typeof livePilotReattachResponseSchema>;
export const anchorReviewFindingKindSchema = z.enum(["summary", "strength", "gap", "watch"]);
export const anchorReviewFindingSchema = z.object({
  id: z.string().min(1).max(80),
  kind: anchorReviewFindingKindSchema,
  text: z.string().min(1).max(400),
  at: isoDate.optional(),
  quote: z.string().min(1).max(120).optional(),
  citedNumbers: z.array(liveHourCitedNumberSchema).max(4)
}).strict();
export const anchorReviewNarrativeSchema = z.object({
  summary: anchorReviewFindingSchema,
  strengths: z.array(anchorReviewFindingSchema).max(5),
  gaps: z.array(anchorReviewFindingSchema).max(5),
  timeline: z.array(anchorReviewFindingSchema).max(16),
  nextSteps: z.array(z.string().min(1).max(240)).min(1).max(4)
}).strict();
export const anchorReviewSchema = z.object({
  schemaVersion: z.literal(1),
  hostName: z.string().min(1).max(40),
  sessionId: id,
  rangeStartAt: isoDate,
  rangeEndAt: isoDate,
  generatedAt: isoDate,
  provider: diagnosisProviderSchema,
  promptVersion: z.string().min(1).max(60),
  scriptVersion: z.string().min(1).max(60),
  coverage: anchorSessionReportSchema,
  narrative: anchorReviewNarrativeSchema,
  dataNotes: z.array(z.string().min(1).max(240)).max(8)
}).strict();
export const anchorReviewExpressionOutputSchema = z.object({
  summary: z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(400) }).strict(),
  strengths: z.array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(400) }).strict()).max(5),
  gaps: z.array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(400) }).strict()).max(5),
  timeline: z.array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(400) }).strict()).max(16),
  nextSteps: z.array(z.string().min(1).max(240)).min(1).max(4)
}).strict();

/**
 * Phase 2B / D050：本场复盘是独立分析动作，覆盖一场已结束时段（不选手动 15 分钟切片）。
 * 运营选择场次、主播名字和参考话术；系统按钟点写成说人话的整场报告。
 */
export const sessionReviewRequestSchema = z.object({
  sessionId: id,
  hostName: z.string().trim().min(1).max(40).refine((value) => !/\d{6,}/.test(value), "主播名字不能包含连续6位以上数字"),
  scriptSource: anchorReviewScriptSourceSchema,
  scriptText: z.string().min(1).max(8000).optional()
}).strict().superRefine((value, context) => {
  if (value.scriptSource === "pasted" && !value.scriptText?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scriptText"], message: "粘贴参考话术不能为空" });
  }
});
export const sessionReviewFindingSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(["summary", "bottleneck", "chapter", "strength", "gap"]),
  text: z.string().min(1).max(480),
  at: isoDate.optional(),
  label: z.string().min(1).max(40).optional(),
  quote: z.string().min(1).max(120).optional(),
  citedNumbers: z.array(liveHourCitedNumberSchema).max(4)
}).strict();
export const sessionReviewTotalsSchema = z.object({
  windowCount: nonNegativeInteger,
  speechFinalCount: nonNegativeInteger,
  truncated: z.boolean(),
  paidBuyers: nonNegativeInteger.optional(),
  productClicks: nonNegativeInteger.optional(),
  liveImpressions: nonNegativeInteger.optional(),
  liveWatch: nonNegativeInteger.optional(),
  paidYuan: nonNegativeInteger.optional(),
  spendYuan: nonNegativeInteger.optional()
}).strict();
export const sessionReviewNarrativeSchema = z.object({
  summary: sessionReviewFindingSchema,
  bottleneck: sessionReviewFindingSchema,
  chapters: z.array(sessionReviewFindingSchema).min(1).max(8),
  strengths: z.array(sessionReviewFindingSchema).max(5),
  gaps: z.array(sessionReviewFindingSchema).max(5),
  nextSteps: z.array(z.string().min(1).max(240)).min(1).max(3)
}).strict();
export const sessionReviewSchema = z.object({
  schemaVersion: z.literal(1),
  hostName: z.string().min(1).max(40),
  sessionId: id,
  rangeStartAt: isoDate,
  rangeEndAt: isoDate,
  generatedAt: isoDate,
  provider: diagnosisProviderSchema,
  promptVersion: z.string().min(1).max(60),
  scriptVersion: z.string().min(1).max(60),
  totals: sessionReviewTotalsSchema,
  coverage: anchorSessionReportSchema,
  narrative: sessionReviewNarrativeSchema,
  dataNotes: z.array(z.string().min(1).max(240)).max(8)
}).strict();
export const sessionReviewExpressionOutputSchema = z.object({
  summary: z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(480) }).strict(),
  bottleneck: z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(480) }).strict(),
  chapters: z.array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(480) }).strict()).min(1).max(8),
  strengths: z.array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(480) }).strict()).max(5),
  gaps: z.array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(480) }).strict()).max(5),
  nextSteps: z.array(z.string().min(1).max(240)).min(1).max(3)
}).strict();

/**
 * Phase 2B / M5（D045）：多场话术迭代统计。
 * 每个要点跨场聚合，最低样本量 5 场；不足时 status=insufficient_sample，只报样本数。
 */
export const scriptIterationPointStatSchema = z.object({
  pointKey: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  group: referenceScriptGroupSchema,
  weight: z.number().int().min(1).max(3),
  sessionsAnalyzed: nonNegativeInteger,
  sessionsCovered: nonNegativeInteger,
  status: z.enum(["ok", "insufficient_sample"]),
  coverageRate: rate.optional(),
  /** 覆盖场次的"提及窗→下一窗商品点击"变化中位数；样本不足缺省。 */
  clickDeltaMedianWhenCovered: z.number().finite().optional(),
  /** 覆盖场次的"提及窗→下一窗支付人数增量"变化中位数；样本不足缺省。 */
  paidDeltaMedianWhenCovered: z.number().finite().optional()
}).strict();
export const scriptIterationVersionStatSchema = z.object({
  scriptVersion: z.string().min(1).max(60),
  sessionsAnalyzed: nonNegativeInteger,
  status: z.enum(["ok", "insufficient_sample"]),
  weightedCoverageRateMedian: rate.optional(),
  scoreMedian: z.number().int().min(0).max(100).optional()
}).strict();
export const scriptIterationReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoDate,
  minSessions: z.number().int().positive(),
  sessionsAnalyzed: nonNegativeInteger,
  points: z.array(scriptIterationPointStatSchema).max(60),
  versions: z.array(scriptIterationVersionStatSchema).max(20),
  dataNotes: z.array(z.string().min(1).max(240)).max(6)
}).strict();

export const mvpFeedbackStatusSchema = z.enum(["executed", "not_executed", "not_applicable"]);
export const MVP_SPEECH_COVERAGE_KEYS = [
  "product_benefit", "product_efficacy", "ingredient_or_principle", "usage_scenario", "suitable_audience",
  "price", "offer", "gift", "guarantee", "after_sale", "product_card_cta", "purchase_cta", "urgency", "interaction", "chatter"
] as const;
export const mvpSpeechCoverageKeySchema = z.enum(MVP_SPEECH_COVERAGE_KEYS);
export const mvpReplayMetadataSchema = z.object({
  mode: z.literal("real_offline_sample"), actualSessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hostName: z.string().min(1).max(80),
  dataClassification: z.literal("internal_real_sample"), sourceDeliveryMode: z.literal("offline_not_realtime"),
  sourceTimeZone: z.string().min(1).max(80), timeDisplay: z.string().min(1).max(120),
  dataCadenceMinutes: z.literal(15), dataPointCount: z.literal(4),
  sessionStartAt: isoDate, sessionEndAt: isoDate, transcriptHeaderEndMs: nonNegative,
  transcriptSegmentCount: z.number().int().positive(), dataSemantics: z.string().min(1).max(240),
  productDataStatus: z.literal("unknown"),
  transcriptQualityStatus: z.literal("PENDING HUMAN REVIEW"), notice: z.string().min(1).max(240),
  sourceHashes: z.object({ transcriptSha256: z.string().regex(/^[a-f0-9]{64}$/), workbookSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
}).strict();
export const mvpTranscriptEvidenceSchema = z.object({
  id, startMs: nonNegative, endMs: nonNegative, text: z.string().min(1).max(3000), qualityStatus: z.literal("needs_review"),
  tags: z.array(z.string().min(1).max(80)).max(20)
}).strict().refine((value) => value.endMs >= value.startMs, "endMs 必须大于等于 startMs");
export const mvpRealReplayWindowSchema = z.object({
  windowStartAt: isoDate, windowEndAt: isoDate, sourceLocalClock: z.string().regex(/^\d{2}:\d{2}$/), windowMinutes: z.literal(15),
  roomImpressionUv: nonNegativeInteger, roomEnterUv: nonNegativeInteger, onlineSnapshot: nonNegativeInteger,
  productImpressionUv: nonNegativeInteger, productClickUv: nonNegativeInteger, paidOrderCount: nonNegativeInteger,
  paidBuyerCount: nonNegativeInteger, grossPaidGmvFen: nonNegativeInteger, adSpendFen: nonNegativeInteger,
  roomEntryRate: rate, productClickRate: rate, clickToPaidRate: rate, grossRoi: nonNegative,
  transcriptEvidenceIds: z.array(id).max(12)
}).strict().refine((value) => Date.parse(value.windowEndAt) - Date.parse(value.windowStartAt) === 15 * 60 * 1000, {
  path: ["windowEndAt"], message: "真实回放窗口必须是完整15分钟区间"
});
export const mvpTrafficFactSchema = z.object({
  spendFen5m: nonNegativeInteger, spendChangeRate5m: z.number().finite(), roi: nonNegative,
  roiVs10mBaseline: z.number().finite(), trafficVs10mBaseline: z.number().finite(), updatedAt: isoDate
}).strict();
export const mvpProductMetricSchema = z.object({
  productId: id, exposure5m: nonNegativeInteger, clicks5m: nonNegativeInteger,
  unpaid5m: nonNegativeInteger, paidBuyers5m: nonNegativeInteger, gmvFen5m: nonNegativeInteger,
  inventory: nonNegativeInteger.optional(), offerEndsAt: isoDate.optional()
}).strict();
const mvpSpeechCoverageValueSchema = z.enum(["present", "absent", "unknown"]);
const mvpSpeechCoverageSchema = z.record(mvpSpeechCoverageKeySchema, mvpSpeechCoverageValueSchema).superRefine((value, context) => {
  for (const key of MVP_SPEECH_COVERAGE_KEYS) {
    if (!(key in value)) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "话术覆盖矩阵必须包含全部 15 个维度" });
  }
});
export const mvpMetricPointSchema = z.object({
  at: isoDate, online: nonNegativeInteger, enters1m: nonNegativeInteger, retentionProxy: rate,
  currentProductId: id, topIntentProductId: id.optional(), products: z.array(mvpProductMetricSchema).min(1),
  traffic: mvpTrafficFactSchema, dataComplete: z.boolean(), speechCoverage: mvpSpeechCoverageSchema,
  speechEvidence: z.array(z.string().min(1)).max(3)
}).strict();
export const mvpEvidenceSchema = z.object({ type: z.enum(["metric", "speech", "context"]), label: z.string().min(1), value: z.string().min(1) }).strict();
export const mvpRealReplayReviewSchema = z.object({
  windowEndAt: isoDate, stateName: z.string().min(1).max(160), summary: z.string().min(1).max(500),
  singleAction: z.string().min(1).max(500), evidence: z.array(mvpEvidenceSchema).max(3),
  transcriptEvidenceIds: z.array(id).max(3), status: z.literal("PENDING HUMAN REVIEW")
}).strict();
export const mvpActionSchema = z.object({
  id, state: mvpStateIdSchema, actionKey: mvpActionKeySchema, priority: z.enum(["low", "medium", "high", "critical"]),
  coreInstruction: z.string().min(1).max(300), whatHappened: z.string().min(1).max(500), why: z.string().min(1).max(500),
  productStrategy: z.string().min(1).max(300), evidence: z.array(mvpEvidenceSchema).max(3), createdAt: isoDate,
  expiresAt: isoDate, currentProductId: id, topIntentProductId: id.optional(), realScarcity: z.boolean()
}).strict();
export const mvpFeedbackSchema = z.object({
  adviceId: id, status: mvpFeedbackStatusSchema, operatorId: id, createdAt: isoDate, state: mvpStateIdSchema.nullable(),
  currentProductId: id, topIntentProductId: id.optional(), snapshot: mvpMetricPointSchema
}).strict();

export const eventSourceSchema = z.enum([
  "simulator", "replay", "csv_import", "manual", "browser_extension", "official_api", "asr", "operator", "system"
]);

export const eventKindSchema = z.enum([
  "metric.snapshot", "metric.delta", "speech.partial", "speech.final", "speech.tag",
  "comment.raw", "comment.intent", "product.round.started", "product.round.ended", "product.changed",
  "traffic.changed", "rule.triggered", "advice.created", "advice.feedback", "advice.execution",
  "advice.delivery", "advice.outcome", "business.review.submitted", "rule.status", "source.health", "session.marker",
  "mvp.point", "mvp.action", "mvp.feedback", "live.compass.metric", "live.qianchuan.metric", "live.compass.action", "live.compass.action.feedback", "live.compass.action.resolved", "live.product.context", "live.operator.settings", "live.operator.observation", "live.operator.state"
]);

const eventPayloadSchemas: Record<z.infer<typeof eventKindSchema>, z.ZodTypeAny> = {
  "metric.snapshot": metricSnapshotSchema,
  "metric.delta": metricSnapshotSchema,
  "speech.partial": transcriptSegmentSchema,
  "speech.final": transcriptSegmentSchema,
  "speech.tag": z.object({ segmentId: id, tags: z.array(speechTagSchema) }).strict(),
  "comment.raw": z.object({ commentId: id, text: z.string().min(1).max(500) }).strict(),
  "product.round.started": productRoundSchema,
  "product.round.ended": productRoundSchema,
  "product.changed": z.object({ productId: id, previousProductId: id.optional() }).strict(),
  "traffic.changed": trafficChangeSchema,
  "comment.intent": commentIntentSchema,
  "source.health": sourceHealthSchema,
  "session.marker": sessionMarkerSchema,
  "rule.triggered": detectedEventSchema,
  "advice.created": adviceSchema,
  "advice.delivery": adviceDeliverySchema,
  "advice.feedback": adviceFeedbackSchema,
  "advice.execution": adviceExecutionSchema,
  "advice.outcome": adviceOutcomeSchema,
  "business.review.submitted": businessReviewSubmissionSchema,
  "rule.status": ruleStatusSchema,
  "mvp.point": mvpMetricPointSchema,
  "mvp.action": mvpActionSchema,
  "mvp.feedback": mvpFeedbackSchema
  ,"live.compass.metric": liveCompassMetricSnapshotSchema
  ,"live.qianchuan.metric": qianchuanMetricSnapshotSchema
  ,"live.compass.action": liveCompassActionSchema
  ,"live.compass.action.feedback": liveCompassActionFeedbackSchema
  ,"live.compass.action.resolved": liveCompassActionResolutionSchema
  ,"live.product.context": liveProductContextPayloadSchema
  ,"live.operator.settings": operatorSettingsSchema
  ,"live.operator.observation": operatorObservationRecordSchema
  ,"live.operator.state": operatorStateSchema
};

const liveEventBaseSchema = z.object({
  schemaVersion: z.literal(1), eventId: id, dedupeKey: id.optional(), tenantId: id,
  sessionId: id, eventAt: isoDate, capturedAt: isoDate, ingestedAt: isoDate,
  source: eventSourceSchema, kind: eventKindSchema, provisional: z.boolean(),
  payload: z.unknown(), metadata: z.record(z.unknown()).optional()
}).strict();

const sensitiveKeys = new Set([
  "authorization", "cookie", "setcookie", "phone", "phonenumber", "mobile", "mobilenumber",
  "address", "shippingaddress", "deliveryaddress", "password", "passwd", "secret", "clientsecret",
  "token", "authtoken", "bearertoken", "sessiontoken", "idtoken", "accesstoken", "refreshtoken",
  "apikey", "credential", "credentials"
]);
const payloadInternalIdKeys = new Set([
  "id", "tenantId", "sessionId", "eventId", "sourceEventId", "productRoundId", "startEventId", "endEventId",
  "adviceId", "executionId", "detectedEventId", "operatorId", "ruleId", "segmentId", "commentId", "sourceId",
  "speakerId", "hostId", "productId", "previousProductId", "currentHostId", "currentProductId", "brandId", "roomId",
  "evidenceEventIds", "metricWindowIds", "speechSegmentIds", "eventIds", "speechEvidenceIds", "metricEvidenceIds",
  "retrievedCaseIds", "current_product_id", "current_host_id", "reviewSubmissionId"
]);
const noIgnoredStringKeys = new Set<string>();
const sensitiveStrings: Array<{ label: string; pattern: RegExp }> = [
  { label: "Authorization", pattern: /\bauthorization\s*[:=]/i },
  { label: "Bearer 凭证", pattern: /\bbearer\s+\S+/i },
  { label: "中国手机号", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { label: "私钥", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "明确地址", pattern: /(?:收货地址|详细地址)\s*[:：]/ },
  { label: "高置信地址", pattern: /[\u4e00-\u9fa5]{2,}(?:省|市|区|县).{0,30}(?:路|街|街道|大道|巷).{0,20}\d+(?:号|弄|栋|室)/ }
];

type SensitiveContent = { path: Array<string | number>; message: string };
function findSensitiveContent(
  value: unknown,
  path: Array<string | number>,
  ignoredStringKeys: ReadonlySet<string> = noIgnoredStringKeys
): SensitiveContent | undefined {
  if (typeof value === "string") {
    const match = sensitiveStrings.find(({ pattern }) => pattern.test(value));
    return match ? { path, message: `包含禁止的${match.label}` } : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
    if (sensitiveKeys.has(normalizedKey)) return { path: [...path, key], message: "包含禁止的敏感字段" };
    if (ignoredStringKeys.has(key)) continue;
    const nested = findSensitiveContent(child, [...path, key], ignoredStringKeys);
    if (nested) return nested;
  }
  return undefined;
}

export const liveEventSchema = liveEventBaseSchema.superRefine((value, context) => {
  const payloadSchema = eventPayloadSchemas[value.kind];
  let payloadSchemaValid = false;
  if (payloadSchema) {
    const result = payloadSchema.safeParse(value.payload);
    if (!result.success) {
      for (const issue of result.error.issues) context.addIssue({ ...issue, path: ["payload", ...issue.path] });
    } else {
      payloadSchemaValid = true;
      const payload = result.data as Record<string, unknown>;
      if (value.kind === "speech.final" && payload.isFinal !== true) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "isFinal"], message: "speech.final 必须是 final 片段" });
      }
      if (value.kind === "speech.partial" && payload.isFinal !== false) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "isFinal"], message: "speech.partial 必须是 partial 片段" });
      }
      if (value.kind === "product.round.started" && (payload.endedAt !== undefined || payload.endEventId !== undefined)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "开始轮次不能包含结束字段" });
      }
      if (value.kind === "product.round.ended" && (payload.endedAt === undefined || payload.endEventId === undefined)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "结束轮次必须包含 endedAt 和 endEventId" });
      }
    }
  }
  const sensitiveMetadata = findSensitiveContent(value.metadata, ["metadata"]);
  const sensitivePayload = findSensitiveContent(
    value.payload,
    ["payload"],
    payloadSchemaValid ? payloadInternalIdKeys : noIgnoredStringKeys
  );
  for (const sensitive of [sensitiveMetadata, sensitivePayload]) {
    if (sensitive) context.addIssue({ code: z.ZodIssueCode.custom, path: sensitive.path, message: sensitive.message });
  }
});

export const scenarioSchema = z.enum([
  "stable", "low_click", "low_payment", "online_drop", "roi_drop", "price_close_improves",
  "no_cta", "price_objection", "long_knowledge", "positive_segment",
  "historical_morning", "historical_afternoon", "historical_evening",
  "mvp_stable", "mvp_traffic_surge", "mvp_retention", "mvp_high_intent",
  "mvp_high_click_low_pay", "mvp_standout", "mvp_low_efficiency", "mvp_comprehensive", "live_compass"
]);
export const mvpSessionScenarioSchema = z.union([scenarioSchema, z.literal("mvp_real_session_001")]);

export const sessionStatusSchema = z.enum(["created", "running", "stopped", "completed"]);
export const sessionSchema = z.object({
  id, tenantId: id, name: z.string().min(1).max(100), scenario: scenarioSchema, seed: z.number().int(),
  includeCommentIntent: z.boolean(), status: sessionStatusSchema, createdAt: isoDate,
  startedAt: isoDate.optional(), stoppedAt: isoDate.optional()
}).strict();
export const mvpSessionSchema = sessionSchema.extend({ scenario: mvpSessionScenarioSchema });

export const mvpStateSnapshotSchema = z.object({
  session: mvpSessionSchema, state: mvpStateIdSchema.nullable(), stateName: z.string().min(1), confidence: z.enum(["high", "medium", "low"]),
  preheat: z.boolean(), stale: z.boolean(), stateDurationSec: nonNegative, updatedAt: isoDate,
  currentHostId: id, currentProductId: id, topIntentProductId: id.optional(), latestPoint: mvpMetricPointSchema.nullable(),
  action: mvpActionSchema.nullable(), recentActions: z.array(mvpActionSchema).max(20), feedback: z.array(mvpFeedbackSchema),
  smallReview: z.object({ windowMinutes: z.union([z.literal(10), z.literal(15)]), lines: z.array(z.string().min(1)).min(4).max(8) }).strict().optional(),
  eventCount: z.number().int().nonnegative(), traffic: mvpTrafficFactSchema.nullable(),
  metricTrend: z.array(mvpMetricPointSchema).max(120).optional(), replayMetadata: mvpReplayMetadataSchema.optional(),
  realReplayWindows: z.array(mvpRealReplayWindowSchema).max(4).optional(), realReplayReview: mvpRealReplayReviewSchema.optional(),
  transcriptEvidence: z.array(mvpTranscriptEvidenceSchema).max(120).optional()
}).strict();
export const mvpSmallReviewSchema = z.object({
  windowMinutes: z.union([z.literal(10), z.literal(15)]), startAt: isoDate, endAt: isoDate,
  lines: z.array(z.string().min(1)).min(4).max(8)
}).strict();
export const mvpFullReviewSchema = z.object({
  sessionId: id, highlighted: z.array(z.object({ title: z.string().min(1), summary: z.string().min(1), evidence: z.array(z.string().min(1)) }).strict()).length(5),
  details: z.array(z.string().min(1)),
  speechEvidence: z.array(z.object({ at: isoDate, text: z.string().min(1).max(500) }).strict()).max(120).optional(),
  limitation: z.string().min(1)
}).strict();

export const createSessionSchema = z.object({
  name: z.string().min(1).max(100), scenario: scenarioSchema, seed: z.number().int(), includeCommentIntent: z.boolean().default(true)
}).strict();

export const startSessionSchema = z.object({ speed: z.number().positive().max(3600).default(60) }).strict();

export const metricPointSchema = z.object({ at: isoDate, values: metricSnapshotSchema }).strict();
export const adviceProjectionSchema = z.object({
  advice: adviceSchema,
  status: adviceStatusSchema,
  deliveredAt: isoDate.optional(),
  feedback: z.array(adviceFeedbackSchema),
  executions: z.array(adviceExecutionSchema),
  outcomes: z.array(adviceOutcomeSchema),
  timeline: z.object({
    generatedAt: isoDate,
    deliveredAt: isoDate.optional(),
    seenAt: isoDate.optional(),
    acceptedAt: isoDate.optional(),
    rejectedAt: isoDate.optional(),
    executingAt: isoDate.optional(),
    executedAt: isoDate.optional(),
    generatedToSeenSec: nonNegative.optional(),
    seenToAcceptedSec: nonNegative.optional(),
    acceptedToExecutingSec: nonNegative.optional(),
    acceptedToExecutedSec: nonNegative.optional()
  }).strict()
}).strict();
export const sessionStateSchema = z.object({
  session: sessionSchema,
  latestMetrics: metricSnapshotSchema.nullable(),
  metricTrend: z.array(metricPointSchema),
  transcripts: z.array(transcriptSegmentSchema),
  productRounds: z.array(productRoundSchema),
  detectedEvents: z.array(detectedEventSchema),
  advices: z.array(adviceProjectionSchema),
  feedback: z.array(adviceFeedbackSchema),
  executions: z.array(adviceExecutionSchema),
  outcomes: z.array(adviceOutcomeSchema),
  ruleStatuses: z.array(ruleStatusSchema),
  recentEvents: z.array(liveEventBaseSchema),
  sourceHealth: z.array(sourceHealthSchema),
  eventCount: z.number().int().nonnegative(),
  updatedAt: isoDate
}).strict();

export type SpeechTag = z.infer<typeof speechTagSchema>;
export type MetricSnapshot = z.infer<typeof metricSnapshotSchema>;
export type CanonicalMetricSnapshot = z.infer<typeof canonicalMetricSnapshotSchema>;
export type LiveCompassMetricSnapshot = z.infer<typeof liveCompassMetricSnapshotSchema>;
export type QianchuanMetricValue = z.infer<typeof qianchuanMetricValueSchema>;
export type QianchuanMetricSnapshot = z.infer<typeof qianchuanMetricSnapshotSchema>;
export type LiveWindowFieldStat = z.infer<typeof liveWindowFieldStatSchema>;
export type LiveWindowSpeechStat = z.infer<typeof liveWindowSpeechStatSchema>;
export type LiveWindowAggregate = z.infer<typeof liveWindowAggregateSchema>;
export type HistoricalHourWindowKey = z.infer<typeof historicalHourWindowKeySchema>;
export type HistoricalHourMetrics = z.infer<typeof historicalHourMetricsSchema>;
export type HistoricalHourAnchorSlice = z.infer<typeof historicalHourAnchorSliceSchema>;
export type HistoricalHourRoomAggregate = z.infer<typeof historicalHourRoomAggregateSchema>;
export type HistoricalCaptureSnapshot = z.infer<typeof historicalCaptureSnapshotSchema>;
export type HistoricalHourBaselineMetricKey = z.infer<typeof historicalHourBaselineMetricKeySchema>;
export type HistoricalHourBaseline = z.infer<typeof historicalHourBaselineSchema>;
export type HistoricalBaselineView = z.infer<typeof historicalBaselineViewSchema>;
export type HistoricalBaselineError = z.infer<typeof historicalBaselineErrorSchema>;
export type LiveHourVsBaseline = z.infer<typeof liveHourVsBaselineSchema>;
export type LiveHourComparisonMetric = z.infer<typeof liveHourComparisonMetricSchema>;
export type DiagnosisWindow = z.infer<typeof diagnosisWindowSchema>;
export type ReferenceScript = z.infer<typeof referenceScriptSchema>;
export type ReferenceScriptPoint = z.infer<typeof referenceScriptPointSchema>;
export type ReferenceScriptGroup = z.infer<typeof referenceScriptGroupSchema>;
export type AnchorPointCoverage = z.infer<typeof anchorPointCoverageSchema>;
export type AnchorWindowCoverage = z.infer<typeof anchorWindowCoverageSchema>;
export type AnchorLinkage = z.infer<typeof anchorLinkageSchema>;
export type AnchorScore = z.infer<typeof anchorScoreSchema>;
export type AnchorSessionReport = z.infer<typeof anchorSessionReportSchema>;
export type AnchorReviewScriptSource = z.infer<typeof anchorReviewScriptSourceSchema>;
export type AnchorReviewRequest = z.infer<typeof anchorReviewRequestSchema>;
export type LivePastWindowOption = z.infer<typeof livePastWindowOptionSchema>;
export type LiveSessionCatalogItem = z.infer<typeof liveSessionCatalogItemSchema>;
export type LiveSessionCatalog = z.infer<typeof liveSessionCatalogSchema>;
export type AnchorReviewFindingKind = z.infer<typeof anchorReviewFindingKindSchema>;
export type AnchorReviewFinding = z.infer<typeof anchorReviewFindingSchema>;
export type AnchorReviewNarrative = z.infer<typeof anchorReviewNarrativeSchema>;
export type AnchorReview = z.infer<typeof anchorReviewSchema>;
export type AnchorReviewExpressionOutput = z.infer<typeof anchorReviewExpressionOutputSchema>;
export type SessionReviewRequest = z.infer<typeof sessionReviewRequestSchema>;
export type SessionReviewFinding = z.infer<typeof sessionReviewFindingSchema>;
export type SessionReviewTotals = z.infer<typeof sessionReviewTotalsSchema>;
export type SessionReviewNarrative = z.infer<typeof sessionReviewNarrativeSchema>;
export type SessionReview = z.infer<typeof sessionReviewSchema>;
export type SessionReviewExpressionOutput = z.infer<typeof sessionReviewExpressionOutputSchema>;
export type ScriptIterationPointStat = z.infer<typeof scriptIterationPointStatSchema>;
export type ScriptIterationVersionStat = z.infer<typeof scriptIterationVersionStatSchema>;
export type ScriptIterationReport = z.infer<typeof scriptIterationReportSchema>;
export type DiagnosisProvider = z.infer<typeof diagnosisProviderSchema>;
export type DiagnosisConfidence = z.infer<typeof diagnosisConfidenceSchema>;
export type DiagnosisActionKind = z.infer<typeof diagnosisActionKindSchema>;
export type DiagnosisFunnelStage = z.infer<typeof diagnosisFunnelStageSchema>;
export type DiagnosisExpressionOutput = z.infer<typeof diagnosisExpressionOutputSchema>;
export type DiagnosisExpressionV2Output = z.infer<typeof diagnosisExpressionV2OutputSchema>;
export type LiveProductRole = z.infer<typeof liveProductRoleSchema>;
export type DiagnosisExecutionState = z.infer<typeof diagnosisExecutionStateSchema>;
export type DiagnosisTriggerType = z.infer<typeof diagnosisTriggerTypeSchema>;
export type DiagnosisInterruptDecision = z.infer<typeof diagnosisInterruptDecisionSchema>;
export type DiagnosisEvidencePacket = z.infer<typeof diagnosisEvidencePacketSchema>;
export type SourceGroupStatus = z.infer<typeof sourceGroupStatusSchema>;
export type SourceOverallHealth = z.infer<typeof sourceOverallHealthSchema>;
export type SourceGroupId = z.infer<typeof sourceGroupIdSchema>;
export type SourceGroupHealth = z.infer<typeof sourceGroupHealthSchema>;
export type PageRuntimeState = z.infer<typeof pageRuntimeStateSchema>;
export type RecoveryHistoryEntry = z.infer<typeof recoveryHistoryEntrySchema>;
export type SourceHealthReport = z.infer<typeof sourceHealthReportSchema>;
export type LiveRecoveryRequest = z.infer<typeof liveRecoveryRequestSchema>;
export type LiveProductContextPayload = z.infer<typeof liveProductContextPayloadSchema>;
export type DiagnosisFinding = z.infer<typeof diagnosisFindingSchema>;
export type DiagnosisAnomaly = z.infer<typeof diagnosisAnomalySchema>;
export type LiveCompassAction = z.infer<typeof liveCompassActionSchema>;
export type LiveCompassActionFeedback = z.infer<typeof liveCompassActionFeedbackSchema>;
export type LiveCompassActionResolution = z.infer<typeof liveCompassActionResolutionSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type ProductRound = z.infer<typeof productRoundSchema>;
export type DetectedEvent = z.infer<typeof detectedEventSchema>;
export type Advice = z.infer<typeof adviceSchema>;
export type AdviceStatus = z.infer<typeof adviceStatusSchema>;
export type AdviceProjection = z.infer<typeof adviceProjectionSchema>;
export type AdviceDelivery = z.infer<typeof adviceDeliverySchema>;
export type DataEvidence = z.infer<typeof dataEvidenceSchema>;
export type AdviceFeedback = z.infer<typeof adviceFeedbackSchema>;
export type BusinessReviewSubmission = z.infer<typeof businessReviewSubmissionSchema>;
export type AdviceExecution = z.infer<typeof adviceExecutionSchema>;
export type AdviceOutcome = z.infer<typeof adviceOutcomeSchema>;
export type RuleStatus = z.infer<typeof ruleStatusSchema>;
export type CaseCard = z.infer<typeof caseCardSchema>;
export type ModelRun = z.infer<typeof modelRunSchema>;
export type SourceHealth = z.infer<typeof sourceHealthSchema>;
export type LiveEvent = z.infer<typeof liveEventSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type MvpSession = z.infer<typeof mvpSessionSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type MvpProductType = z.infer<typeof mvpProductTypeSchema>;
export type MvpProduct = z.infer<typeof mvpProductSchema>;
export type MvpStateId = z.infer<typeof mvpStateIdSchema>;
export type MvpActionKey = z.infer<typeof mvpActionKeySchema>;
export type MvpTrafficFact = z.infer<typeof mvpTrafficFactSchema>;
export type MvpProductMetric = z.infer<typeof mvpProductMetricSchema>;
export type MvpMetricPoint = z.infer<typeof mvpMetricPointSchema>;
export type MvpRealReplayWindow = z.infer<typeof mvpRealReplayWindowSchema>;
export type MvpRealReplayReview = z.infer<typeof mvpRealReplayReviewSchema>;
export type MvpReplayMetadata = z.infer<typeof mvpReplayMetadataSchema>;
export type MvpTranscriptEvidence = z.infer<typeof mvpTranscriptEvidenceSchema>;
export type MvpEvidence = z.infer<typeof mvpEvidenceSchema>;
export type MvpAction = z.infer<typeof mvpActionSchema>;
export type MvpFeedback = z.infer<typeof mvpFeedbackSchema>;
export type MvpStateSnapshot = z.infer<typeof mvpStateSnapshotSchema>;
export type MvpSmallReview = z.infer<typeof mvpSmallReviewSchema>;
export type MvpFullReview = z.infer<typeof mvpFullReviewSchema>;
