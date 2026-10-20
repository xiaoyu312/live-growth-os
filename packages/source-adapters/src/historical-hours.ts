import {
  HISTORICAL_HOUR_MAPPING_VERSION,
  historicalCaptureSnapshotSchema,
  historicalHourAnchorSliceSchema,
  historicalHourRoomAggregateSchema,
  type HistoricalCaptureSnapshot,
  type HistoricalHourAnchorSlice,
  type HistoricalHourMetrics,
  type HistoricalHourRoomAggregate,
  type HistoricalHourWindowKey
} from "@live-growth/contracts";

export { HISTORICAL_HOUR_MAPPING_VERSION };

export const HISTORY_UTC_OFFSET_MINUTES = 480 as const;

/** Generic importer column contract. No source workbook values are bundled. */
export const LIVE_REGISTER_FIELD_COLUMNS = [
  "日期", "场控", "主播", "班次", "开播时间", "下播时间", "时段", "开播时长",
  "时段直播GMV", "累计GMV", "时段退款金额", "累计退款金额",
  "时段消耗金额", "累计消耗金额", "时段全场roi", "全场roi",
  "时段曝光次数", "时段观看次数",
  "时段直播间曝光人数", "时段观看人数", "时段商品曝光人数", "时段商品点击人数", "时段成交人数",
  "时段观看-成交转化率", "时段商品曝光点击率（人数）", "时段商品点击-成交转化率", "停留时长"
] as const;

export const CAPTURE_SNAPSHOT_FIELD_COLUMNS = [
  "日期", "截止时间", "主播", "班次", "实时在线人数", "整体消耗(元)", "整体成交金额(元)", "净成交金额(元)"
] as const;

export type LiveRegisterSkip = { rowNumber: number; reason: string };

export type LiveRegisterParseResult = {
  slices: HistoricalHourAnchorSlice[];
  skipped: LiveRegisterSkip[];
};

export type LiveRegisterParseOptions = {
  /** 未完结当日：该日未覆盖满小时的切片标 incomplete，不进默认基线。 */
  incompleteLocalDate?: string;
};

const SENSITIVE_SKIP = /\d{6,}|Authorization|Cookie|收货|手机号/i;

function headerKey(value: string): string {
  return value.replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
}

function cell(record: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const direct = record[name];
    if (direct !== undefined && direct.trim() !== "") return direct;
    const wanted = headerKey(name);
    for (const [key, value] of Object.entries(record)) {
      if (headerKey(key) === wanted && value.trim() !== "") return value;
    }
  }
  return undefined;
}

export function parseLooseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "—") return undefined;
  const percent = trimmed.includes("%");
  const cleaned = trimmed.replace(/%/g, "").replace(/,/g, "").replace(/元/g, "").trim();
  if (cleaned === "") return undefined;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return percent ? value / 100 : value;
}

export function parseYuanToFen(raw: string | undefined): number | undefined {
  const yuan = parseLooseNumber(raw);
  return yuan === undefined ? undefined : Math.round(yuan * 100);
}

export function parseCount(raw: string | undefined): number | undefined {
  const value = parseLooseNumber(raw);
  return value === undefined ? undefined : Math.round(value);
}

export function parseStayDurationSec(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text === "") return undefined;
  const minuteAndSec = text.match(/^(\d+)\s*分钟\s*(\d+)\s*秒$/);
  if (minuteAndSec) return Number(minuteAndSec[1]) * 60 + Number(minuteAndSec[2]);
  const onlyMinute = text.match(/^(\d+)\s*分钟$/);
  if (onlyMinute) return Number(onlyMinute[1]) * 60;
  const onlySec = text.match(/^(\d+)\s*秒$/);
  if (onlySec) return Number(onlySec[1]);
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

export function parseSheetDate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const match = raw.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseHourWindow(label: string | undefined): { hour: number; windowLabel: string } | undefined {
  if (label === undefined) return undefined;
  const match = label.trim().match(/^(\d{1,2}):00\s*[-~～]\s*(\d{1,2}|24):00$/);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 0 || start > 23) return undefined;
  const expectedEnd = start === 23 ? 24 : start + 1;
  if (end !== expectedEnd) return undefined;
  return {
    hour: start,
    windowLabel: `${String(start).padStart(2, "0")}:00-${String(end).padStart(2, "0")}:00`
  };
}

function localDateParts(localDate: string): { year: number; month: number; day: number } {
  const [yearText, monthText, dayText] = localDate.split("-");
  return { year: Number(yearText), month: Number(monthText), day: Number(dayText) };
}

export function weekdayFromLocalDate(localDate: string): number {
  const { year, month, day } = localDateParts(localDate);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function addLocalDateDays(localDate: string, days: number): string {
  const { year, month, day } = localDateParts(localDate);
  return new Date(Date.UTC(year, month - 1, day) + days * 86_400_000).toISOString().slice(0, 10);
}

/** UTC+8 墙上日期，不读服务器本地时区。 */
export function shanghaiLocalDate(at: Date): string {
  return new Date(at.getTime() + HISTORY_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

export function shanghaiWallClock(at: Date): { localDate: string; hour: number; minute: number; second: number } {
  const shifted = new Date(at.getTime() + HISTORY_UTC_OFFSET_MINUTES * 60_000);
  return {
    localDate: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds()
  };
}

export function fromShanghaiWallClock(localDate: string, hour: number, minute = 0, second = 0): Date {
  const { year, month, day } = localDateParts(localDate);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - HISTORY_UTC_OFFSET_MINUTES * 60_000);
}

/** 前一个已完结自然日：asOf 当天整日不入默认样本。 */
export function previousCompletedLocalDate(asOfLocalDate: string): string {
  return addLocalDateDays(asOfLocalDate, -1);
}

export function historicalHourWindowKey(localDate: string, hour: number, windowLabel: string): HistoricalHourWindowKey {
  const { year, month, day } = localDateParts(localDate);
  const windowStartMs = Date.UTC(year, month - 1, day, hour, 0, 0, 0) - HISTORY_UTC_OFFSET_MINUTES * 60_000;
  return {
    localDate,
    weekday: weekdayFromLocalDate(localDate),
    hour,
    windowLabel,
    utcOffsetMinutes: HISTORY_UTC_OFFSET_MINUTES,
    windowStartAt: new Date(windowStartMs).toISOString(),
    windowEndAt: new Date(windowStartMs + 60 * 60 * 1000).toISOString(),
    grain: "hour"
  };
}

function rateFrom(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  return Math.min(1, numerator / denominator);
}

function roiFrom(amountFen: number | undefined, spendFen: number | undefined): number | undefined {
  if (amountFen === undefined || spendFen === undefined || spendFen <= 0) return undefined;
  return amountFen / spendFen;
}

function assignOptional(target: HistoricalHourMetrics, key: keyof HistoricalHourMetrics, value: number | string | undefined): void {
  if (value === undefined) return;
  Object.assign(target, { [key]: value });
}

function withMetrics(partial: HistoricalHourMetrics): HistoricalHourMetrics {
  const gmvFen = partial.gmvFen;
  const refundFen = partial.refundFen;
  const derivedGsv = gmvFen !== undefined && refundFen !== undefined ? Math.max(0, gmvFen - refundFen) : undefined;
  const gsvFen = partial.gsvFen ?? derivedGsv;
  const metrics: HistoricalHourMetrics = { ...partial };
  assignOptional(metrics, "gmvFen", gmvFen);
  assignOptional(metrics, "refundFen", refundFen);
  if (gsvFen !== undefined) {
    metrics.gsvFen = gsvFen;
    metrics.gsvDerivation = partial.gsvDerivation ?? "gmv_minus_refund";
  }
  if (partial.watchToPaidRate === undefined) assignOptional(metrics, "watchToPaidRate", rateFrom(partial.paidBuyerCount, partial.roomEnterUv));
  if (partial.productClickRate === undefined) assignOptional(metrics, "productClickRate", rateFrom(partial.productClickUv, partial.productImpressionUv));
  if (partial.productClickToPaidRate === undefined) assignOptional(metrics, "productClickToPaidRate", rateFrom(partial.paidBuyerCount, partial.productClickUv));
  if (partial.roi === undefined) assignOptional(metrics, "roi", roiFrom(gmvFen, partial.adSpendFen));
  if (partial.gsvRoi === undefined) assignOptional(metrics, "gsvRoi", roiFrom(gsvFen, partial.adSpendFen));
  return metrics;
}

function skipReason(reason: string): string {
  return SENSITIVE_SKIP.test(reason) ? "行被跳过（含敏感片段，已省略）" : reason;
}

function isGroupHeaderRow(values: string[]): boolean {
  const joined = values.join("");
  return joined.includes("直播情况") || joined.includes("千川数据") || joined.includes("漏斗数据");
}

function isFieldHeaderRow(values: string[]): boolean {
  const keys = new Set(values.map(headerKey));
  return keys.has("日期") && keys.has("时段");
}

function recordsFromMatrix(rows: string[][]): { records: Array<{ rowNumber: number; record: Record<string, string> }>; skipped: LiveRegisterSkip[] } {
  const skipped: LiveRegisterSkip[] = [];
  if (rows.length === 0) return { records: [], skipped };
  let headerIndex = 0;
  if (rows[0] && isGroupHeaderRow(rows[0]) && rows[1] && isFieldHeaderRow(rows[1])) headerIndex = 1;
  else if (rows[0] && isFieldHeaderRow(rows[0])) headerIndex = 0;
  else {
    skipped.push({ rowNumber: 1, reason: "缺少日期+时段表头" });
    return { records: [], skipped };
  }
  const headers = rows[headerIndex] ?? [];
  const records: Array<{ rowNumber: number; record: Record<string, string> }> = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const rowNumber = index + 1;
    const record: Record<string, string> = {};
    headers.forEach((header, column) => {
      if (header.trim() !== "") record[header] = row[column] ?? "";
    });
    records.push({ rowNumber, record });
  }
  return { records, skipped };
}

function parseClockToMinutes(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return undefined;
  if (hour === 24 && minute !== 0) return undefined;
  return hour * 60 + minute;
}

function sliceFromRecord(record: Record<string, string>, options: LiveRegisterParseOptions): HistoricalHourAnchorSlice | { skip: string } {
  if (!Object.values(record).some((value) => value.trim() !== "")) return { skip: "空行" };
  const dateRaw = cell(record, "日期") ?? "";
  if (/汇总|环比|目标/.test(dateRaw)) return { skip: "汇总或目标行" };
  const localDate = parseSheetDate(dateRaw);
  if (!localDate) return { skip: "无法解析日期" };
  const window = parseHourWindow(cell(record, "时段"));
  if (!window) return { skip: "无法解析小时时段" };
  const durationMin = parseLooseNumber(cell(record, "开播时长"));
  if (durationMin === 0) return { skip: "开播时长为0" };

  const gmvFen = parseYuanToFen(cell(record, "时段直播GMV"));
  const refundFen = parseYuanToFen(cell(record, "时段退款金额"));
  const adSpendFen = parseYuanToFen(cell(record, "时段消耗金额"));
  const metrics = withMetrics({
    ...(gmvFen !== undefined ? { gmvFen } : {}),
    ...(refundFen !== undefined ? { refundFen } : {}),
    ...(adSpendFen !== undefined ? { adSpendFen } : {}),
    ...(parseCount(cell(record, "时段直播间曝光人数")) !== undefined ? { roomImpressionUv: parseCount(cell(record, "时段直播间曝光人数")) } : {}),
    ...(parseCount(cell(record, "时段观看人数")) !== undefined ? { roomEnterUv: parseCount(cell(record, "时段观看人数")) } : {}),
    ...(parseCount(cell(record, "时段曝光次数")) !== undefined ? { roomImpressionPv: parseCount(cell(record, "时段曝光次数")) } : {}),
    ...(parseCount(cell(record, "时段观看次数")) !== undefined ? { roomEnterPv: parseCount(cell(record, "时段观看次数")) } : {}),
    ...(parseCount(cell(record, "时段商品曝光人数")) !== undefined ? { productImpressionUv: parseCount(cell(record, "时段商品曝光人数")) } : {}),
    ...(parseCount(cell(record, "时段商品点击人数")) !== undefined ? { productClickUv: parseCount(cell(record, "时段商品点击人数")) } : {}),
    ...(parseCount(cell(record, "时段成交人数")) !== undefined ? { paidBuyerCount: parseCount(cell(record, "时段成交人数")) } : {}),
    ...(parseStayDurationSec(cell(record, "停留时长")) !== undefined ? { averageWatchDurationSec: parseStayDurationSec(cell(record, "停留时长")) } : {})
  });

  const endedMinutes = parseClockToMinutes(cell(record, "下播时间"));
  const hourEndMinutes = (window.hour + 1) * 60;
  const incompleteByAsOf = options.incompleteLocalDate === localDate && endedMinutes !== undefined && endedMinutes < hourEndMinutes;
  const dataStatus = incompleteByAsOf ? "incomplete" : "complete";

  const anchorName = cell(record, "主播");
  const controllerName = cell(record, "场控");
  const shift = cell(record, "班次");
  const startedAtLocal = cell(record, "开播时间");
  const endedAtLocal = cell(record, "下播时间");

  return historicalHourAnchorSliceSchema.parse({
    schemaVersion: 1,
    mappingVersion: HISTORICAL_HOUR_MAPPING_VERSION,
    source: "csv_import",
    sourceKind: "live-register",
    rowKind: "anchor_slice",
    window: historicalHourWindowKey(localDate, window.hour, window.windowLabel),
    metrics,
    dataStatus,
    ...(durationMin !== undefined ? { durationMin } : {}),
    ...(shift ? { shift } : {}),
    ...(anchorName ? { anchorName } : {}),
    ...(controllerName ? { controllerName } : {}),
    ...(startedAtLocal ? { startedAtLocal } : {}),
    ...(endedAtLocal ? { endedAtLocal } : {}),
    ...(incompleteByAsOf ? { exclusionReason: "unfinished_hour" } : {})
  });
}

export function parseLiveRegisterRecords(
  records: Array<{ rowNumber: number; record: Record<string, string> }>,
  options: LiveRegisterParseOptions = {}
): LiveRegisterParseResult {
  const slices: HistoricalHourAnchorSlice[] = [];
  const skipped: LiveRegisterSkip[] = [];
  for (const item of records) {
    const parsed = sliceFromRecord(item.record, options);
    if ("skip" in parsed) skipped.push({ rowNumber: item.rowNumber, reason: skipReason(parsed.skip) });
    else slices.push(parsed);
  }
  return { slices, skipped };
}

export function parseLiveRegisterMatrix(rows: string[][], options: LiveRegisterParseOptions = {}): LiveRegisterParseResult {
  const { records, skipped } = recordsFromMatrix(rows);
  const parsed = parseLiveRegisterRecords(records, options);
  return { slices: parsed.slices, skipped: [...skipped, ...parsed.skipped] };
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : present.reduce((total, value) => total + value, 0);
}

function durationWeightedAverage(slices: HistoricalHourAnchorSlice[], pick: (metrics: HistoricalHourMetrics) => number | undefined): number | undefined {
  let weighted = 0;
  let weight = 0;
  for (const slice of slices) {
    const value = pick(slice.metrics);
    const duration = slice.durationMin;
    if (value === undefined || duration === undefined || duration <= 0) continue;
    weighted += value * duration;
    weight += duration;
  }
  return weight > 0 ? weighted / weight : undefined;
}

export function aggregateLiveRegisterRoomHours(slices: HistoricalHourAnchorSlice[]): HistoricalHourRoomAggregate[] {
  const groups = new Map<string, HistoricalHourAnchorSlice[]>();
  for (const slice of slices) {
    const key = `${slice.window.localDate}|${slice.window.hour}`;
    const list = groups.get(key) ?? [];
    list.push(slice);
    groups.set(key, list);
  }
  const rooms: HistoricalHourRoomAggregate[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const complete = group.filter((item) => item.dataStatus === "complete");
    const used = complete.length > 0 ? complete : group;
    const dataStatus = complete.length > 0 ? "complete" : "incomplete";
    const gmvFen = sumOptional(used.map((item) => item.metrics.gmvFen));
    const refundFen = sumOptional(used.map((item) => item.metrics.refundFen));
    const adSpendFen = sumOptional(used.map((item) => item.metrics.adSpendFen));
    const roomEnterUv = sumOptional(used.map((item) => item.metrics.roomEnterUv));
    const roomImpressionPv = sumOptional(used.map((item) => item.metrics.roomImpressionPv));
    const roomEnterPv = sumOptional(used.map((item) => item.metrics.roomEnterPv));
    const productImpressionUv = sumOptional(used.map((item) => item.metrics.productImpressionUv));
    const productClickUv = sumOptional(used.map((item) => item.metrics.productClickUv));
    const paidBuyerCount = sumOptional(used.map((item) => item.metrics.paidBuyerCount));
    const stay = durationWeightedAverage(used, (metrics) => metrics.averageWatchDurationSec);
    const durationMin = sumOptional(used.map((item) => item.durationMin));
    const anchorNames = [...new Set(used.flatMap((item) => item.anchorName ? [item.anchorName] : []))];
    rooms.push(historicalHourRoomAggregateSchema.parse({
      schemaVersion: 1,
      mappingVersion: HISTORICAL_HOUR_MAPPING_VERSION,
      source: "csv_import",
      sourceKind: "live-register",
      rowKind: "room_hour",
      window: first.window,
      sliceCount: used.length,
      anchorNames,
      dataStatus,
      ...(dataStatus === "incomplete" ? { exclusionReason: "unfinished_hour" } : {}),
      ...(durationMin !== undefined ? { durationMin } : {}),
      ...(used[0]?.shift ? { shift: used[0].shift } : {}),
      metrics: withMetrics({
        ...(gmvFen !== undefined ? { gmvFen } : {}),
        ...(refundFen !== undefined ? { refundFen } : {}),
        ...(adSpendFen !== undefined ? { adSpendFen } : {}),
        ...(sumOptional(used.map((item) => item.metrics.roomImpressionUv)) !== undefined ? { roomImpressionUv: sumOptional(used.map((item) => item.metrics.roomImpressionUv)) } : {}),
        ...(roomEnterUv !== undefined ? { roomEnterUv } : {}),
        ...(roomImpressionPv !== undefined ? { roomImpressionPv } : {}),
        ...(roomEnterPv !== undefined ? { roomEnterPv } : {}),
        ...(productImpressionUv !== undefined ? { productImpressionUv } : {}),
        ...(productClickUv !== undefined ? { productClickUv } : {}),
        ...(paidBuyerCount !== undefined ? { paidBuyerCount } : {}),
        ...(stay !== undefined ? { averageWatchDurationSec: Math.round(stay) } : {})
      })
    }));
  }
  return rooms.sort((left, right) => left.window.windowStartAt.localeCompare(right.window.windowStartAt));
}

function parseLocalDateTime(dateRaw: string | undefined, clockRaw: string | undefined): { localDate: string; hour: number; observedAt: string } | undefined {
  const localDate = parseSheetDate(dateRaw);
  if (!localDate || clockRaw === undefined) return undefined;
  const match = clockRaw.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  const { year, month, day } = localDateParts(localDate);
  const observedAtMs = Date.UTC(year, month - 1, day, hour, minute, second) - HISTORY_UTC_OFFSET_MINUTES * 60_000;
  return { localDate, hour, observedAt: new Date(observedAtMs).toISOString() };
}

export function parseCaptureSnapshotMatrix(rows: string[][]): { snapshots: HistoricalCaptureSnapshot[]; skipped: LiveRegisterSkip[] } {
  if (rows.length === 0) return { snapshots: [], skipped: [{ rowNumber: 1, reason: "缺少采集表头" }] };
  const headerIndex = rows.findIndex((row) => {
    const keys = new Set(row.map(headerKey));
    return keys.has("日期") && (keys.has("截止时间") || keys.has("实时在线人数"));
  });
  if (headerIndex < 0) return { snapshots: [], skipped: [{ rowNumber: 1, reason: "缺少采集表头" }] };
  const headers = rows[headerIndex] ?? [];
  const records = rows.slice(headerIndex + 1).map((row, offset) => {
    const record: Record<string, string> = {};
    headers.forEach((header, column) => {
      if (header.trim() !== "") record[header] = row[column] ?? "";
    });
    return { rowNumber: headerIndex + offset + 2, record };
  });
  return parseCaptureSnapshotRecords(records);
}

export function parseCaptureSnapshotRecords(
  records: Array<{ rowNumber: number; record: Record<string, string> }>
): { snapshots: HistoricalCaptureSnapshot[]; skipped: LiveRegisterSkip[] } {
  const snapshots: HistoricalCaptureSnapshot[] = [];
  const skipped: LiveRegisterSkip[] = [];
  for (const item of records) {
    if (!Object.values(item.record).some((value) => value.trim() !== "")) {
      skipped.push({ rowNumber: item.rowNumber, reason: "空行" });
      continue;
    }
    const clockRaw = cell(item.record, "截止时间");
    const parsed = parseLocalDateTime(cell(item.record, "日期"), clockRaw?.includes(" ") ? clockRaw.split(" ").at(-1) : clockRaw);
    if (!parsed) {
      skipped.push({ rowNumber: item.rowNumber, reason: skipReason("无法解析采集截止时间") });
      continue;
    }
    const onlineSnapshot = parseCount(cell(item.record, "实时在线人数"));
    const anchorName = cell(item.record, "主播");
    const shift = cell(item.record, "班次");
    snapshots.push(historicalCaptureSnapshotSchema.parse({
      schemaVersion: 1,
      mappingVersion: HISTORICAL_HOUR_MAPPING_VERSION,
      source: "csv_import",
      sourceKind: "capture-snapshot",
      grain: "snapshot",
      observedAt: parsed.observedAt,
      localDate: parsed.localDate,
      weekday: weekdayFromLocalDate(parsed.localDate),
      hour: parsed.hour,
      utcOffsetMinutes: HISTORY_UTC_OFFSET_MINUTES,
      dataStatus: "complete",
      ...(onlineSnapshot !== undefined ? { onlineSnapshot } : {}),
      ...(anchorName ? { anchorName } : {}),
      ...(shift ? { shift } : {})
    }));
  }
  return { snapshots, skipped };
}

/** 有采集点才写入在线；无点保持缺失。不把采集累计消耗写入房间小时。 */
export function attachCaptureOnlineToRoomHours(
  rooms: HistoricalHourRoomAggregate[],
  snapshots: HistoricalCaptureSnapshot[]
): HistoricalHourRoomAggregate[] {
  const latest = new Map<string, HistoricalCaptureSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.onlineSnapshot === undefined) continue;
    const key = `${snapshot.localDate}|${snapshot.hour}`;
    const current = latest.get(key);
    if (!current || snapshot.observedAt >= current.observedAt) latest.set(key, snapshot);
  }
  return rooms.map((room) => {
    const snapshot = latest.get(`${room.window.localDate}|${room.window.hour}`);
    if (!snapshot || snapshot.onlineSnapshot === undefined) return room;
    return historicalHourRoomAggregateSchema.parse({
      ...room,
      onlineSourceKind: "capture-snapshot",
      metrics: { ...room.metrics, onlineSnapshot: snapshot.onlineSnapshot }
    });
  });
}

export class MemoryHistoricalHourStore {
  private rooms: HistoricalHourRoomAggregate[] = [];
  private slices: HistoricalHourAnchorSlice[] = [];
  private snapshots: HistoricalCaptureSnapshot[] = [];

  ingest(input: {
    rooms?: HistoricalHourRoomAggregate[];
    slices?: HistoricalHourAnchorSlice[];
    snapshots?: HistoricalCaptureSnapshot[];
  }): void {
    if (input.slices) this.slices = [...this.slices, ...input.slices];
    if (input.rooms) this.rooms = [...this.rooms, ...input.rooms];
    if (input.snapshots) this.snapshots = [...this.snapshots, ...input.snapshots];
  }

  listRooms(): HistoricalHourRoomAggregate[] { return [...this.rooms]; }
  listSlices(): HistoricalHourAnchorSlice[] { return [...this.slices]; }
  listSnapshots(): HistoricalCaptureSnapshot[] { return [...this.snapshots]; }
}
