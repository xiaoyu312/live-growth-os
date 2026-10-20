import {
  qianchuanMetricSnapshotSchema,
  type QianchuanMetricSnapshot,
  type QianchuanMetricValue
} from "@live-growth/contracts";

export const QIANCHUAN_LIVE_MAPPING_VERSION = "qianchuan-live-v1";
export const QIANCHUAN_LIVE_ORIGIN = "https://qianchuan.jinritemai.com";
export const QIANCHUAN_LIVE_ENDPOINTS = {
  statQuery: "/ad/api/data/v1/common/statQuery",
  roi2Log: "/ad/api/data/v1/board/roi2Log"
} as const;

export type QianchuanLiveResponse = {
  origin: string;
  endpoint: string;
  body: unknown;
  observedAt: string;
};

type JsonRecord = Record<string, unknown>;
type MetricName = keyof QianchuanMetricSnapshot["metrics"];
type MetricDefinition = {
  sourceFields: readonly string[];
  semantic: QianchuanMetricValue["semantic"];
  unit: QianchuanMetricValue["unit"];
};

const METRIC_DEFINITIONS: Partial<Record<MetricName, MetricDefinition>> = {
  // The real board exposes both an older spend field and the confirmed
  // settled spend field. Prefer the latter when both are present; do not
  // treat the two values as a conflict.
  adSpend: { sourceFields: ["stat_real_cost_for_roi2", "stat_cost_for_roi2"], semantic: "cumulative", unit: "元" },
  paidOrderGmv: { sourceFields: ["total_live_pay_amt_for_roi2"], semantic: "cumulative", unit: "元" },
  paidOrderCount: { sourceFields: ["total_pay_order_count_for_roi2", "total_pay_order_count_realtime_for_roi2"], semantic: "cumulative", unit: "单" },
  productImpressions: { sourceFields: ["live_product_show_count_for_roi2"], semantic: "cumulative", unit: "次" },
  productClicks: { sourceFields: ["live_product_click_count_for_roi2"], semantic: "cumulative", unit: "次" },
  liveImpressions: { sourceFields: ["live_show_count_for_roi2"], semantic: "cumulative", unit: "次" },
  liveWatchCount: { sourceFields: ["live_watch_count_for_roi2", "total_live_watch_count_for_roi2"], semantic: "cumulative", unit: "次" },
  onlineSnapshot: { sourceFields: ["room_pack_online_user_count"], semantic: "instant", unit: "人" },
  gpm: { sourceFields: ["total_live_pay_order_gpm_realtime_for_roi2"], semantic: "rolling", unit: "元" },
  watchToPaid: { sourceFields: ["total_watch_to_pay_rate_realtime_for_roi2"], semantic: "rate", unit: "%" },
  productClickToPaid: { sourceFields: ["total_product_click_to_pay_rate_realtime_for_roi2"], semantic: "rate", unit: "%" },
  showToWatch: { sourceFields: ["total_show_to_watch_rate_for_roi2"], semantic: "rate", unit: "%" },
  watchToProductClick: { sourceFields: ["total_watch_to_product_click_rate_for_roi2"], semantic: "rate", unit: "%" },
  liveWatchToPaid: { sourceFields: ["live_watch_to_pay_rate_for_roi2"], semantic: "rate", unit: "%" },
  costPerPaidOrder: { sourceFields: ["total_cost_per_pay_order_realtime_for_roi2"], semantic: "rolling", unit: "元" },
  roi: { sourceFields: ["total_prepay_and_pay_settle_realtime_roi2_1h"], semantic: "rolling", unit: "unknown" }
};

const DEFINITION_BY_SOURCE = new Map<string, { name: MetricName; definition: MetricDefinition }>();
for (const [name, definition] of Object.entries(METRIC_DEFINITIONS) as Array<[MetricName, MetricDefinition]>) {
  for (const sourceField of definition.sourceFields) DEFINITION_BY_SOURCE.set(sourceField, { name, definition });
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function isDashPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "-";
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "-") return 0;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  }
  return undefined;
}

function unitFromRecord(record: JsonRecord): string | undefined {
  for (const key of ["Unit", "unit", "ValueUnit", "value_unit"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function valueStringFromRecord(record: JsonRecord): string | undefined {
  for (const key of ["ValueStr", "value_str", "valueStr"]) {
    const value = record[key];
    if (typeof value === "string") return value.trim();
  }
  return undefined;
}

function metricPayload(value: unknown): { value?: number | undefined; unit?: string | undefined; valueStr?: string | undefined } {
  const object = asRecord(value);
  if (object) {
    return {
      value: finiteNumber(object.Value ?? object.value),
      unit: unitFromRecord(object),
      valueStr: valueStringFromRecord(object)
    };
  }
  return { value: finiteNumber(value) };
}

function normalizeUnit(definition: MetricDefinition, payload: { unit?: string | undefined }): QianchuanMetricValue["unit"] | undefined {
  if (payload.unit) {
    const unit = payload.unit.replace(/\s+/g, "");
    if (definition.unit === "元" && !["元", "¥", "￥"].includes(unit)) return undefined;
    if (definition.unit === "%" && unit !== "%") return undefined;
    if (definition.unit === "人" && !["人", "人次"].includes(unit)) return undefined;
    if (definition.unit === "次" && !["次", "次/人"].includes(unit)) return undefined;
    if (definition.unit === "单" && !["单", "订单"].includes(unit)) return undefined;
    if (definition.unit === "unknown") return "unknown";
    return definition.unit;
  }
  // These units are part of the confirmed Qianchuan statQuery field contract.
  // If a future response supplies a contradictory explicit unit, the branch
  // above fails closed instead of silently converting it.
  return definition.unit;
}

function sourceFieldFromRecord(record: JsonRecord): string | undefined {
  for (const key of ["Name", "name", "Key", "key", "MetricName", "metric_name", "index_name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function collectKnownValues(container: unknown, target: Map<MetricName, QianchuanMetricValue>, conflicts: Set<MetricName>): void {
  const object = asRecord(container);
  if (!object) {
    if (Array.isArray(container)) for (const item of container) collectKnownValues(item, target, conflicts);
    return;
  }
  const directName = sourceFieldFromRecord(object);
  if (directName) addMetric(directName, object.Value ?? object.value ?? object, target, conflicts, object);
  for (const [key, value] of Object.entries(object)) {
    if (key === "Name" || key === "name" || key === "Key" || key === "key" || key === "MetricName" || key === "metric_name" || key === "index_name") continue;
    if (DEFINITION_BY_SOURCE.has(key)) addMetric(key, value, target, conflicts, asRecord(value) ?? object);
  }
}

function addMetric(sourceField: string, rawValue: unknown, target: Map<MetricName, QianchuanMetricValue>, conflicts: Set<MetricName>, metadata: JsonRecord): void {
  const resolved = DEFINITION_BY_SOURCE.get(sourceField);
  if (!resolved || conflicts.has(resolved.name)) return;
  const payload = metricPayload(rawValue);
  const valueStr = payload.valueStr ?? valueStringFromRecord(metadata);
  const value = payload.value ?? (isDashPlaceholder(valueStr) ? 0 : undefined);
  const unit = normalizeUnit(resolved.definition, {
    ...(payload.unit ?? unitFromRecord(metadata) ? { unit: payload.unit ?? unitFromRecord(metadata) } : {})
  });
  if (value === undefined || unit === undefined) return;
  const metric: QianchuanMetricValue = {
    value,
    unit,
    semantic: resolved.definition.semantic,
    sourceField
  };
  const previous = target.get(resolved.name);
  if (!previous) target.set(resolved.name, metric);
  else if (resolved.name === "adSpend" && metric.sourceField === "stat_real_cost_for_roi2" && previous.sourceField === "stat_cost_for_roi2") target.set(resolved.name, metric);
  else if (resolved.name === "adSpend" && previous.sourceField === "stat_real_cost_for_roi2") return;
  else if (previous.value !== metric.value || previous.unit !== metric.unit || previous.sourceField !== metric.sourceField) {
    target.delete(resolved.name);
    conflicts.add(resolved.name);
  }
}

/** Parse only the confirmed Qianchuan statQuery containers; no recursive search. */
export function parseQianchuanStatQuery(input: QianchuanLiveResponse): QianchuanMetricSnapshot | null {
  if (input.origin !== QIANCHUAN_LIVE_ORIGIN || input.endpoint !== QIANCHUAN_LIVE_ENDPOINTS.statQuery) return null;
  const root = asRecord(input.body);
  const data = asRecord(root?.data);
  const statsData = asRecord(data?.StatsData);
  if (!statsData) return null;
  const target = new Map<MetricName, QianchuanMetricValue>();
  const conflicts = new Set<MetricName>();
  collectKnownValues(statsData.Totals, target, conflicts);
  // Rows[].Metrics are dimension details, not the board total. Until their
  // dimension identity is confirmed, never merge them into the KPI snapshot.
  if (target.size === 0) return null;
  const metrics: Partial<QianchuanMetricSnapshot["metrics"]> = {};
  for (const [name, value] of target) metrics[name] = value;
  const parsed = qianchuanMetricSnapshotSchema.safeParse({
    observedAt: input.observedAt,
    sourceEndpoint: input.endpoint,
    mappingVersion: QIANCHUAN_LIVE_MAPPING_VERSION,
    dataStatus: "fresh",
    metricSource: "qianchuan",
    metrics
  });
  return parsed.success ? parsed.data : null;
}

export function parseQianchuanLiveResponse(input: QianchuanLiveResponse): QianchuanMetricSnapshot | null {
  return parseQianchuanStatQuery(input);
}
