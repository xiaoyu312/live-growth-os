import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  HISTORICAL_HOUR_MAPPING_VERSION,
  type HistoricalCaptureSnapshot,
  type HistoricalHourAnchorSlice,
  type HistoricalHourRoomAggregate
} from "@live-growth/contracts";
import {
  addLocalDateDays,
  aggregateLiveRegisterRoomHours,
  attachCaptureOnlineToRoomHours,
  fromShanghaiWallClock,
  parseCaptureSnapshotMatrix,
  parseLiveRegisterMatrix,
  parseSheetDate,
  shanghaiLocalDate
} from "./historical-hours";

export const HISTORY_LIVE_REGISTER_WIKI_URL = process.env.HISTORY_REGISTER_URL ?? "";
/** 运营副本仅文档对照，本轮不拉、不当消耗权威。 */
export const HISTORY_OPS_COPY_WIKI_URL = "";
export const HISTORY_CAPTURE_SHEET_NAME = "采集数据源";
export const HISTORY_START_MONTH = process.env.HISTORY_START_MONTH?.trim() || new Date().toISOString().slice(0, 7);

export type HistoricalHistorySheetPayload = {
  sheetName: string;
  rows: string[][];
  revision?: number;
};

export type HistoricalHistoryFetchResult = {
  registerSheets: HistoricalHistorySheetPayload[];
  capture?: HistoricalHistorySheetPayload;
};

export type HistoricalHistoryFetcher = (input: { asOfLocalDate: string; sheetNames: string[] }) => Promise<HistoricalHistoryFetchResult>;

export type HistoricalDateChecksum = { checksum: string; rowCount: number };

export type HistoricalHourSnapshotV1 = {
  schemaVersion: 1;
  mappingVersion: typeof HISTORICAL_HOUR_MAPPING_VERSION;
  lastSuccessAt: string;
  asOfLocalDate: string;
  dateChecksums: Record<string, HistoricalDateChecksum>;
  sheetSummaries: Array<{ sheetName: string; rowCount: number }>;
  lastImportedDates: string[];
  lastSkippedUnchangedDates: number;
  rooms: HistoricalHourRoomAggregate[];
  slices: HistoricalHourAnchorSlice[];
  snapshots: HistoricalCaptureSnapshot[];
};

export type HistoricalBaselineStoreStatus = {
  lastSuccessAt?: string;
  lastError?: { at: string; message: string };
  lastAttemptAt?: string;
};

export interface HistoricalHourSnapshotStore {
  loadSnapshot(): Promise<HistoricalHourSnapshotV1 | undefined>;
  loadStatus(): Promise<HistoricalBaselineStoreStatus>;
  saveSuccess(snapshot: HistoricalHourSnapshotV1): Promise<void>;
  recordFailure(error: { at: string; message: string }): Promise<void>;
}

export type HistoricalHourSyncOptions = {
  now?: Date;
  asOfLocalDate?: string;
  force?: boolean;
  fetch: HistoricalHistoryFetcher;
  store: HistoricalHourSnapshotStore;
};

export type HistoricalHourSyncSuccess = {
  snapshot: HistoricalHourSnapshotV1;
  skippedUnchangedDates: string[];
  importedDates: string[];
};

function checksumText(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function liveRegisterSheetNames(asOfLocalDate: string, startMonth = HISTORY_START_MONTH): string[] {
  const names: string[] = [];
  let cursor = startMonth;
  const end = asOfLocalDate.slice(0, 7);
  while (cursor <= end) {
    const [yearText, monthText] = cursor.split("-");
    names.push(`${yearText}年${Number(monthText)}月`);
    const year = Number(yearText);
    const month = Number(monthText);
    cursor = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  }
  return names;
}

export function dateChecksumsFromRegisterRows(rows: string[][]): Record<string, HistoricalDateChecksum> {
  const grouped = new Map<string, string[][]>();
  for (const row of rows) {
    const localDate = parseSheetDate(row.find((cell) => parseSheetDate(cell)));
    if (!localDate) continue;
    const list = grouped.get(localDate) ?? [];
    list.push(row);
    grouped.set(localDate, list);
  }
  return Object.fromEntries([...grouped.entries()].map(([localDate, dateRows]) => [
    localDate,
    { checksum: checksumText(JSON.stringify(dateRows)), rowCount: dateRows.length }
  ]));
}

function mergeDateChecksums(registerSheets: HistoricalHistorySheetPayload[]): Record<string, HistoricalDateChecksum> {
  const merged: Record<string, HistoricalDateChecksum> = {};
  for (const sheet of registerSheets) Object.assign(merged, dateChecksumsFromRegisterRows(sheet.rows));
  return merged;
}

export function mergeHistoricalHourSnapshot(input: {
  previous?: HistoricalHourSnapshotV1;
  fetched: HistoricalHistoryFetchResult;
  asOfLocalDate: string;
  syncedAt: string;
  force?: boolean;
}): HistoricalHourSyncSuccess {
  const incompleteLocalDate = input.asOfLocalDate;
  const slices: HistoricalHourAnchorSlice[] = [];
  for (const sheet of input.fetched.registerSheets) {
    slices.push(...parseLiveRegisterMatrix(sheet.rows, { incompleteLocalDate }).slices);
  }
  const capture = input.fetched.capture ? parseCaptureSnapshotMatrix(input.fetched.capture.rows).snapshots : [];
  const rooms = attachCaptureOnlineToRoomHours(aggregateLiveRegisterRoomHours(slices), capture);
  const incomingChecksums = mergeDateChecksums(input.fetched.registerSheets);
  const completeDates = [...new Set(rooms.map((room) => room.window.localDate))]
    .filter((localDate) => localDate < input.asOfLocalDate)
    .sort();

  const skippedUnchangedDates: string[] = [];
  const importedDates: string[] = [];
  for (const localDate of completeDates) {
    const incoming = incomingChecksums[localDate];
    const previous = input.previous?.dateChecksums[localDate];
    const unchanged = !input.force && Boolean(incoming && previous && previous.checksum === incoming.checksum && previous.rowCount === incoming.rowCount);
    if (unchanged) skippedUnchangedDates.push(localDate);
    else importedDates.push(localDate);
  }

  const kept = new Set(skippedUnchangedDates);
  const nextRooms = [
    ...(input.previous?.rooms.filter((room) => kept.has(room.window.localDate)) ?? []),
    ...rooms.filter((room) => room.window.localDate < input.asOfLocalDate && !kept.has(room.window.localDate) && room.dataStatus === "complete")
  ].sort((left, right) => left.window.windowStartAt.localeCompare(right.window.windowStartAt));
  const nextSlices = [
    ...(input.previous?.slices.filter((slice) => kept.has(slice.window.localDate)) ?? []),
    ...slices.filter((slice) => slice.window.localDate < input.asOfLocalDate && !kept.has(slice.window.localDate) && slice.dataStatus === "complete")
  ];
  return {
    skippedUnchangedDates,
    importedDates,
    snapshot: {
      schemaVersion: 1,
      mappingVersion: HISTORICAL_HOUR_MAPPING_VERSION,
      lastSuccessAt: input.syncedAt,
      asOfLocalDate: input.asOfLocalDate,
      dateChecksums: {
        ...(input.previous ? Object.fromEntries(Object.entries(input.previous.dateChecksums).filter(([localDate]) => kept.has(localDate))) : {}),
        ...Object.fromEntries(importedDates.flatMap((localDate) => {
          const checksum = incomingChecksums[localDate];
          return checksum ? [[localDate, checksum] as const] : [];
        }))
      },
      sheetSummaries: [
        ...input.fetched.registerSheets.map((sheet) => ({ sheetName: sheet.sheetName, rowCount: sheet.rows.length })),
        ...(input.fetched.capture ? [{ sheetName: input.fetched.capture.sheetName, rowCount: input.fetched.capture.rows.length }] : [])
      ],
      lastImportedDates: importedDates,
      lastSkippedUnchangedDates: skippedUnchangedDates.length,
      rooms: nextRooms,
      slices: nextSlices,
      snapshots: capture
    }
  };
}

export async function syncHistoricalHourBaseline(options: HistoricalHourSyncOptions): Promise<HistoricalHourSyncSuccess> {
  const now = options.now ?? new Date();
  const asOfLocalDate = options.asOfLocalDate ?? shanghaiLocalDate(now);
  const syncedAt = now.toISOString();
  const previous = await options.store.loadSnapshot();
  try {
    const fetched = await options.fetch({ asOfLocalDate, sheetNames: [...liveRegisterSheetNames(asOfLocalDate), HISTORY_CAPTURE_SHEET_NAME] });
    if (fetched.registerSheets.some((sheet) => /投放|运营副本/.test(sheet.sheetName))) {
      throw new Error("拒绝把运营副本投放小时表当消耗权威");
    }
    const merged = mergeHistoricalHourSnapshot({
      ...(previous ? { previous } : {}),
      fetched,
      asOfLocalDate,
      syncedAt,
      ...(options.force ? { force: true } : {})
    });
    await options.store.saveSuccess(merged.snapshot);
    return merged;
  } catch (error) {
    const message = error instanceof Error ? error.message : "历史基线同步失败";
    await options.store.recordFailure({ at: syncedAt, message });
    const status = await options.store.loadStatus();
    const snapshot = await options.store.loadSnapshot();
    throw new HistoricalBaselineSyncFailedError(message, { status, ...(snapshot ? { snapshot } : {}) });
  }
}

export class HistoricalBaselineSyncFailedError extends Error {
  readonly status: HistoricalBaselineStoreStatus;
  readonly snapshot: HistoricalHourSnapshotV1 | undefined;
  constructor(message: string, input: { status: HistoricalBaselineStoreStatus; snapshot?: HistoricalHourSnapshotV1 }) {
    super(message);
    this.name = "HistoricalBaselineSyncFailedError";
    this.status = input.status;
    this.snapshot = input.snapshot;
  }
}

export class MemoryHistoricalHourSnapshotStore implements HistoricalHourSnapshotStore {
  private snapshot: HistoricalHourSnapshotV1 | undefined;
  private status: HistoricalBaselineStoreStatus = {};

  async loadSnapshot(): Promise<HistoricalHourSnapshotV1 | undefined> {
    return this.snapshot ? structuredClone(this.snapshot) : undefined;
  }

  async loadStatus(): Promise<HistoricalBaselineStoreStatus> {
    return { ...this.status };
  }

  async saveSuccess(snapshot: HistoricalHourSnapshotV1): Promise<void> {
    this.snapshot = structuredClone(snapshot);
    this.status = { lastSuccessAt: snapshot.lastSuccessAt, lastAttemptAt: snapshot.lastSuccessAt };
  }

  async recordFailure(error: { at: string; message: string }): Promise<void> {
    this.status = { ...this.status, lastAttemptAt: error.at, lastError: error };
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value)}\n`, "utf8");
  await rename(tempPath, path);
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class FileHistoricalHourSnapshotStore implements HistoricalHourSnapshotStore {
  constructor(private readonly directory: string) {}

  private snapshotPath(): string { return join(this.directory, "snapshot.json"); }
  private statusPath(): string { return join(this.directory, "status.json"); }

  async loadSnapshot(): Promise<HistoricalHourSnapshotV1 | undefined> {
    return readJsonIfExists<HistoricalHourSnapshotV1>(this.snapshotPath());
  }

  async loadStatus(): Promise<HistoricalBaselineStoreStatus> {
    return (await readJsonIfExists<HistoricalBaselineStoreStatus>(this.statusPath())) ?? {};
  }

  async saveSuccess(snapshot: HistoricalHourSnapshotV1): Promise<void> {
    await atomicWriteJson(this.snapshotPath(), snapshot);
    await atomicWriteJson(this.statusPath(), { lastSuccessAt: snapshot.lastSuccessAt, lastAttemptAt: snapshot.lastSuccessAt });
  }

  async recordFailure(error: { at: string; message: string }): Promise<void> {
    const current = await this.loadStatus();
    await atomicWriteJson(this.statusPath(), { ...current, lastAttemptAt: error.at, lastError: error });
  }
}

export function nextShanghaiDailySyncAt(now: Date, hour = 0, minute = 30): Date {
  const today = shanghaiLocalDate(now);
  const candidate = fromShanghaiWallClock(today, hour, minute);
  if (candidate.getTime() > now.getTime()) return candidate;
  return fromShanghaiWallClock(addLocalDateDays(today, 1), hour, minute);
}
