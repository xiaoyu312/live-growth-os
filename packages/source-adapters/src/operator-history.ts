import {
  OPERATOR_HISTORY_MAPPING_VERSION,
  operatorHistoryBundleSchema,
  operatorHistoryReferenceQuerySchema,
  operatorHistoryReferenceSchema,
  type OperatorHistoryBundle,
  type OperatorHistoryHourRecord,
  type OperatorHistoryMode,
  type OperatorHistoryReference,
  type OperatorHistoryReferenceQuery
} from "@live-growth/contracts";
import {
  aggregateLiveRegisterRoomHours,
  parseLiveRegisterMatrix,
  parseSheetDate
} from "./historical-hours";

export type OperatorHistoryRows = string[][];

export type OperatorHistoryBuildMetadata = {
  builtAt: string;
  sourceRevision: string | number;
  asOfLocalDate?: string;
  incompleteLocalDate?: string;
};

type PulseConfig = {
  date: string;
  startMinutes: number;
  endMinutes: number;
};

function cell(record: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const direct = record[name];
    if (direct !== undefined && direct.trim() !== "") return direct.trim();
    const wanted = name.replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
    for (const [key, value] of Object.entries(record)) {
      if (key.replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")") === wanted && value.trim() !== "") return value.trim();
    }
  }
  return undefined;
}

function parseClock(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59 || (hour === 24 && minute !== 0)) return undefined;
  return hour * 60 + minute;
}

function derivedRate(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  const ratio = numerator / denominator;
  // Keep the raw source counts. An impossible ratio means the source rows do
  // not share a comparable denominator, so do not turn it into a false 100%.
  return ratio >= 0 && ratio <= 1 ? ratio : undefined;
}

function recordsFromRows(rows: string[][]): Array<Record<string, string>> {
  const headerIndex = rows.findIndex((row) => {
    const keys = new Set(row.map((value) => value.replace(/\s+/g, "")));
    return keys.has("日期") && keys.has("时段");
  });
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex] ?? [];
  return rows.slice(headerIndex + 1).map((row) => Object.fromEntries(headers.flatMap((header, index) => header.trim() ? [[header, row[index] ?? ""]] : [])));
}

function dataRowCount(rows: string[][]): number {
  const headerIndex = rows.findIndex((row) => {
    const keys = new Set(row.map((value) => value.replace(/\s+/g, "")));
    return keys.has("日期") && keys.has("时段");
  });
  return headerIndex < 0 ? 0 : Math.max(0, rows.length - headerIndex - 1);
}

function parsePulseConfigs(rows: OperatorHistoryRows): PulseConfig[] {
  const records = recordsFromRows(rows);
  if (records.length === 0) {
    const headerIndex = rows.findIndex((row) => row.some((value) => value.trim() === "测试类型"));
    if (headerIndex < 0) return [];
    const headers = rows[headerIndex] ?? [];
    return rows.slice(headerIndex + 1).flatMap((row) => {
      const record = Object.fromEntries(headers.flatMap((header, index) => header.trim() ? [[header, row[index] ?? ""]] : []));
      const date = parseSheetDate(cell(record, "日期"));
      const testType = cell(record, "测试类型");
      const startMinutes = parseClock(cell(record, "开始时间"));
      const endMinutes = parseClock(cell(record, "结束时间"));
      if (!date || testType !== "脉冲测试" || startMinutes === undefined || endMinutes === undefined || endMinutes <= startMinutes) return [];
      return [{ date, startMinutes, endMinutes }];
    });
  }
  return [];
}

function modeForHour(date: string, hour: number, configs: PulseConfig[]): { mode: "pulse" | "unlabeled" | "unknown"; reason: OperatorHistoryHourRecord["modeReason"] } {
  const start = hour * 60;
  const end = start + 60;
  const sameDate = configs.filter((config) => config.date === date && config.startMinutes < end && config.endMinutes > start);
  if (sameDate.length === 0) return { mode: "unlabeled", reason: "unlabeled_source_window" };
  if (sameDate.length !== 1) return { mode: "unknown", reason: "ambiguous_test_window" };
  const config = sameDate[0]!;
  if (start >= config.startMinutes && end <= config.endMinutes) return { mode: "pulse", reason: "pulse_test_window" };
  return { mode: "unknown", reason: "ambiguous_test_window" };
}

function derivedFromRaw(metrics: OperatorHistoryHourRecord["metrics"]): OperatorHistoryHourRecord["derived"] {
  const gsvFen = metrics.gmvFen !== undefined && metrics.refundFen !== undefined ? Math.max(0, metrics.gmvFen - metrics.refundFen) : undefined;
  const watchToPaidRate = derivedRate(metrics.paidBuyerCount, metrics.roomEnterUv);
  const productClickRate = derivedRate(metrics.productClickUv, metrics.productImpressionUv);
  const productClickToPaidRate = derivedRate(metrics.paidBuyerCount, metrics.productClickUv);
  const roi = metrics.gmvFen !== undefined && metrics.adSpendFen !== undefined && metrics.adSpendFen > 0 ? metrics.gmvFen / metrics.adSpendFen : undefined;
  const gsvRoi = gsvFen !== undefined && metrics.adSpendFen !== undefined && metrics.adSpendFen > 0 ? gsvFen / metrics.adSpendFen : undefined;
  const gpmFenPerThousandRoomEnterPv = metrics.gmvFen !== undefined && metrics.roomEnterPv !== undefined && metrics.roomEnterPv > 0 ? metrics.gmvFen * 1000 / metrics.roomEnterPv : undefined;
  return {
    ...(gsvFen !== undefined ? { gsvFen } : {}),
    ...(watchToPaidRate !== undefined ? { watchToPaidRate } : {}),
    ...(productClickRate !== undefined ? { productClickRate } : {}),
    ...(productClickToPaidRate !== undefined ? { productClickToPaidRate } : {}),
    ...(roi !== undefined ? { roi } : {}),
    ...(gsvRoi !== undefined ? { gsvRoi } : {}),
    ...(gpmFenPerThousandRoomEnterPv !== undefined ? { gpmFenPerThousandRoomEnterPv } : {})
  };
}

function recordFromRoom(room: ReturnType<typeof aggregateLiveRegisterRoomHours>[number], configs: PulseConfig[]): OperatorHistoryHourRecord {
  const mode = modeForHour(room.window.localDate, room.window.hour, configs);
  const source = room.metrics;
  const metrics: OperatorHistoryHourRecord["metrics"] = {
    ...(source.gmvFen !== undefined ? { gmvFen: source.gmvFen } : {}),
    ...(source.refundFen !== undefined ? { refundFen: source.refundFen } : {}),
    ...(source.adSpendFen !== undefined ? { adSpendFen: source.adSpendFen } : {}),
    ...(source.roomImpressionPv !== undefined ? { roomImpressionPv: source.roomImpressionPv } : {}),
    ...(source.roomEnterPv !== undefined ? { roomEnterPv: source.roomEnterPv } : {}),
    ...(source.roomImpressionUv !== undefined ? { roomImpressionUv: source.roomImpressionUv } : {}),
    ...(source.roomEnterUv !== undefined ? { roomEnterUv: source.roomEnterUv } : {}),
    ...(source.productImpressionUv !== undefined ? { productImpressionUv: source.productImpressionUv } : {}),
    ...(source.productClickUv !== undefined ? { productClickUv: source.productClickUv } : {}),
    ...(source.paidBuyerCount !== undefined ? { paidBuyerCount: source.paidBuyerCount } : {})
  };
  return {
    localDate: room.window.localDate,
    weekday: room.window.weekday,
    hour: room.window.hour,
    windowLabel: room.window.windowLabel,
    grain: "hour",
    mode: mode.mode,
    modeReason: mode.reason,
    sliceCount: room.sliceCount,
    metrics,
    derived: derivedFromRaw(metrics)
  };
}

export function buildOperatorHistoryBundle(rows: OperatorHistoryRows, configs: OperatorHistoryRows, metadata: OperatorHistoryBuildMetadata): OperatorHistoryBundle {
  const parsed = parseLiveRegisterMatrix(rows, metadata.incompleteLocalDate ? { incompleteLocalDate: metadata.incompleteLocalDate } : {});
  const rooms = aggregateLiveRegisterRoomHours(parsed.slices);
  const pulseConfigs = parsePulseConfigs(configs);
  const asOfLocalDate = metadata.asOfLocalDate;
  const datedRooms = rooms.filter((room) => asOfLocalDate === undefined || room.window.localDate < asOfLocalDate);
  const includedRooms = datedRooms.filter((room) => room.dataStatus === "complete");
  const records = includedRooms.map((room) => recordFromRoom(room, pulseConfigs)).sort((left, right) => left.localDate.localeCompare(right.localDate) || left.hour - right.hour);
  const dates = records.map((record) => record.localDate).sort();
  const sourceRevision = String(metadata.sourceRevision);
  const bundle = {
    schemaVersion: 1 as const,
    mappingVersion: OPERATOR_HISTORY_MAPPING_VERSION,
    builtAt: metadata.builtAt,
    sourceRevision,
    dateRange: { from: dates[0] ?? (asOfLocalDate ?? "1970-01-01"), to: dates.at(-1) ?? (asOfLocalDate ?? "1970-01-01") },
    grain: "hour" as const,
    records,
    sourceSummary: {
      registerRowCount: dataRowCount(rows),
      parsedHourCount: rooms.length,
      includedHourCount: records.length,
      excludedFutureHourCount: rooms.length - datedRooms.length,
      excludedIncompleteHourCount: datedRooms.filter((room) => room.dataStatus !== "complete").length,
      pulseHourCount: records.filter((record) => record.mode === "pulse").length,
      unlabeledHourCount: records.filter((record) => record.mode === "unlabeled").length,
      unknownHourCount: records.filter((record) => record.mode === "unknown").length,
      configCount: pulseConfigs.length,
      sourceRevision
    }
  };
  return operatorHistoryBundleSchema.parse(bundle);
}

function recordKey(record: OperatorHistoryHourRecord): string {
  return `${record.localDate}|${String(record.hour).padStart(2, "0")}`;
}

/** Merge separately fetched month sheets without concatenating their headers. */
export function mergeOperatorHistoryBundles(bundles: OperatorHistoryBundle[]): OperatorHistoryBundle {
  if (bundles.length === 0) throw new Error("至少需要一个小时基线包");
  const first = operatorHistoryBundleSchema.parse(bundles[0]);
  const recordsByKey = new Map<string, OperatorHistoryHourRecord>();
  let registerRowCount = 0;
  let parsedHourCount = 0;
  let excludedFutureHourCount = 0;
  let excludedIncompleteHourCount = 0;
  const revisions = new Set<string>();
  for (const candidate of bundles) {
    const bundle = operatorHistoryBundleSchema.parse(candidate);
    if (bundle.sourceSummary.configCount !== first.sourceSummary.configCount) {
      throw new Error("历史基线配置数量不一致，拒绝合并");
    }
    registerRowCount += bundle.sourceSummary.registerRowCount;
    parsedHourCount += bundle.sourceSummary.parsedHourCount;
    excludedFutureHourCount += bundle.sourceSummary.excludedFutureHourCount;
    excludedIncompleteHourCount += bundle.sourceSummary.excludedIncompleteHourCount;
    revisions.add(bundle.sourceRevision);
    for (const record of bundle.records) {
      const key = recordKey(record);
      const previous = recordsByKey.get(key);
      if (!previous) {
        recordsByKey.set(key, record);
        continue;
      }
      if (JSON.stringify(previous) !== JSON.stringify(record)) {
        throw new Error(`历史基线小时冲突：${key}`);
      }
      // Exact duplicate from overlapping source fetches: keep one record.
    }
  }
  const records = [...recordsByKey.values()].sort((left, right) => left.localDate.localeCompare(right.localDate) || left.hour - right.hour);
  const dates = records.map((record) => record.localDate);
  const sourceRevision = [...revisions].join("|").slice(0, 160);
  return operatorHistoryBundleSchema.parse({
    schemaVersion: 1 as const,
    mappingVersion: OPERATOR_HISTORY_MAPPING_VERSION,
    builtAt: first.builtAt,
    sourceRevision,
    dateRange: { from: dates[0] ?? first.dateRange.from, to: dates.at(-1) ?? first.dateRange.to },
    grain: "hour" as const,
    records,
    sourceSummary: {
      registerRowCount,
      parsedHourCount,
      includedHourCount: records.length,
      excludedFutureHourCount,
      excludedIncompleteHourCount,
      pulseHourCount: records.filter((record) => record.mode === "pulse").length,
      unlabeledHourCount: records.filter((record) => record.mode === "unlabeled").length,
      unknownHourCount: records.filter((record) => record.mode === "unknown").length,
      configCount: first.sourceSummary.configCount,
      sourceRevision
    }
  });
}

function requestedModeMatches(record: OperatorHistoryHourRecord, mode: OperatorHistoryMode): boolean {
  if (mode === "pulse") return record.mode === "pulse";
  if (mode === "regular") return false;
  return record.mode === mode;
}

export function selectOperatorHistoryReference(bundle: OperatorHistoryBundle, query: OperatorHistoryReferenceQuery): OperatorHistoryReference {
  const validatedBundle = operatorHistoryBundleSchema.parse(bundle);
  const validatedQuery = operatorHistoryReferenceQuerySchema.parse(query);
  const weekday = new Date(`${validatedQuery.date}T00:00:00Z`).getUTCDay();
  const candidates = validatedBundle.records
    .filter((record) => record.localDate < validatedQuery.date && record.weekday === weekday && record.hour === validatedQuery.hour && requestedModeMatches(record, validatedQuery.mode))
    .sort((left, right) => right.localDate.localeCompare(left.localDate))
    .slice(0, 8);
  const sampleDates = [...new Set(candidates.map((record) => record.localDate))];
  const unlabeled = validatedBundle.records
    .filter((record) => record.localDate < validatedQuery.date && record.weekday === weekday && record.hour === validatedQuery.hour && record.mode === "unlabeled")
    .sort((left, right) => right.localDate.localeCompare(left.localDate))
    .slice(0, 8);
  const unlabeledDates = [...new Set(unlabeled.map((record) => record.localDate))];
  const fallback = query.mode === "regular" && unlabeled.length > 0 ? { mode: "unlabeled" as const, records: unlabeled, sampleDates: unlabeledDates } : undefined;
  const enough = sampleDates.length >= 2;
  return operatorHistoryReferenceSchema.parse({
    status: enough ? "ok" : "insufficient_sample",
    query: validatedQuery,
    grain: "hour",
    records: candidates,
    sampleDates,
    sampleDateCount: sampleDates.length,
    ...(enough ? {} : { reason: candidates.length === 0 ? (query.mode === "regular" ? "no_labeled_samples" : "no_complete_samples") : "n_lt_2_dates" }),
    ...(fallback ? { unlabeledFallback: fallback } : {})
  });
}
