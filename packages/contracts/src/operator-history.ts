import { z } from "zod";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nonNegativeInteger = z.number().int().nonnegative();
const nonNegative = z.number().finite().nonnegative();
const rate = z.number().finite().min(0).max(1);

/** The first operator-facing history bundle. It is an hourly reference only. */
export const OPERATOR_HISTORY_MAPPING_VERSION = "operator-history-hour-v1" as const;

export const operatorHistoryModeSchema = z.enum(["pulse", "regular", "unlabeled", "unknown"]);
export type OperatorHistoryMode = z.infer<typeof operatorHistoryModeSchema>;

export const operatorHistoryRecordModeSchema = z.enum(["pulse", "unlabeled", "unknown"]);
export type OperatorHistoryRecordMode = z.infer<typeof operatorHistoryRecordModeSchema>;

/** Raw counts and amounts. Missing source values stay missing; zero means an explicit source zero. */
export const operatorHistoryRawMetricsSchema = z.object({
  gmvFen: nonNegativeInteger.optional(),
  refundFen: nonNegativeInteger.optional(),
  adSpendFen: nonNegativeInteger.optional(),
  roomImpressionPv: nonNegativeInteger.optional(),
  roomEnterPv: nonNegativeInteger.optional(),
  roomImpressionUv: nonNegativeInteger.optional(),
  roomEnterUv: nonNegativeInteger.optional(),
  productImpressionUv: nonNegativeInteger.optional(),
  productClickUv: nonNegativeInteger.optional(),
  paidBuyerCount: nonNegativeInteger.optional()
}).strict();

/** Rates and value-per-volume metrics are recomputed from the raw fields above. */
export const operatorHistoryDerivedMetricsSchema = z.object({
  gsvFen: nonNegativeInteger.optional(),
  watchToPaidRate: rate.optional(),
  productClickRate: rate.optional(),
  productClickToPaidRate: rate.optional(),
  roi: nonNegative.optional(),
  gsvRoi: nonNegative.optional(),
  gpmFenPerThousandRoomEnterPv: nonNegative.optional(),
  averageWatchDurationSec: nonNegative.optional()
}).strict();

export const operatorHistoryHourRecordSchema = z.object({
  localDate,
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  windowLabel: z.string().min(1).max(32),
  grain: z.literal("hour"),
  mode: operatorHistoryRecordModeSchema,
  modeReason: z.enum(["pulse_test_window", "unlabeled_source_window", "ambiguous_test_window"]),
  sliceCount: z.number().int().positive(),
  metrics: operatorHistoryRawMetricsSchema,
  derived: operatorHistoryDerivedMetricsSchema
}).strict();
export type OperatorHistoryHourRecord = z.infer<typeof operatorHistoryHourRecordSchema>;

export const operatorHistoryDateRangeSchema = z.object({ from: localDate, to: localDate }).strict();

export const operatorHistorySourceSummarySchema = z.object({
  registerRowCount: nonNegativeInteger,
  parsedHourCount: nonNegativeInteger,
  includedHourCount: nonNegativeInteger,
  excludedFutureHourCount: nonNegativeInteger,
  excludedIncompleteHourCount: nonNegativeInteger,
  pulseHourCount: nonNegativeInteger,
  unlabeledHourCount: nonNegativeInteger,
  unknownHourCount: nonNegativeInteger,
  configCount: nonNegativeInteger,
  sourceRevision: z.string().min(1).max(160)
}).strict();

export const operatorHistoryBundleSchema = z.object({
  schemaVersion: z.literal(1),
  mappingVersion: z.literal(OPERATOR_HISTORY_MAPPING_VERSION),
  builtAt: z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"), "时间必须使用 UTC Z 格式"),
  sourceRevision: z.string().min(1).max(160),
  dateRange: operatorHistoryDateRangeSchema,
  grain: z.literal("hour"),
  records: z.array(operatorHistoryHourRecordSchema),
  sourceSummary: operatorHistorySourceSummarySchema
}).strict();
export type OperatorHistoryBundle = z.infer<typeof operatorHistoryBundleSchema>;

export const operatorHistoryReferenceQuerySchema = z.object({
  date: localDate,
  hour: z.number().int().min(0).max(23),
  mode: operatorHistoryModeSchema
}).strict();
export type OperatorHistoryReferenceQuery = z.infer<typeof operatorHistoryReferenceQuerySchema>;

export const operatorHistoryReferenceFallbackSchema = z.object({
  mode: z.literal("unlabeled"),
  records: z.array(operatorHistoryHourRecordSchema).max(8),
  sampleDates: z.array(localDate).max(8)
}).strict();

export const operatorHistoryReferenceSchema = z.object({
  status: z.enum(["ok", "insufficient_sample"]),
  query: operatorHistoryReferenceQuerySchema,
  grain: z.literal("hour"),
  records: z.array(operatorHistoryHourRecordSchema).max(8),
  sampleDates: z.array(localDate).max(8),
  sampleDateCount: nonNegativeInteger,
  reason: z.enum(["n_lt_2_dates", "no_complete_samples", "no_labeled_samples"]).optional(),
  unlabeledFallback: operatorHistoryReferenceFallbackSchema.optional()
}).strict();
export type OperatorHistoryReference = z.infer<typeof operatorHistoryReferenceSchema>;
