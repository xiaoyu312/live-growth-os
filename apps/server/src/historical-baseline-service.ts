import { historicalBaselineViewSchema, type HistoricalBaselineView } from "@live-growth/contracts";
import { buildHistoricalBaselineCoverage } from "@live-growth/rules";
import {
  FileHistoricalHourSnapshotStore,
  HistoricalBaselineSyncFailedError,
  MemoryHistoricalHourSnapshotStore,
  nextShanghaiDailySyncAt,
  syncHistoricalHourBaseline,
  type HistoricalHistoryFetcher,
  type HistoricalHourSnapshotStore,
  type HistoricalHourSnapshotV1
} from "@live-growth/source-adapters";
import { createLarkHistoricalHistoryFetcher, defaultHistoricalHistoryCacheDir, sanitizeLarkError } from "./historical-hours-lark";

export class HistoricalBaselineSyncInProgressError extends Error {
  constructor() {
    super("历史基线同步正在进行");
    this.name = "HistoricalBaselineSyncInProgressError";
  }
}

export function historicalBaselineViewOf(
  snapshot: HistoricalHourSnapshotV1 | undefined,
  status: { lastSuccessAt?: string; lastError?: { at: string; message: string }; lastAttemptAt?: string },
  extras: { skippedUnchangedDates?: number; importedDates?: string[] } = {}
): HistoricalBaselineView {
  const importedCompleteDates = snapshot
    ? [...new Set(snapshot.rooms.filter((room) => room.dataStatus === "complete").map((room) => room.window.localDate))].sort()
    : [];
  const hasError = Boolean(status.lastError);
  return historicalBaselineViewSchema.parse({
    status: snapshot ? (hasError ? "degraded" : "ok") : "never_synced",
    mappingVersion: "historical-hours-hour-v1",
    grain: "hour",
    importedCompleteDates,
    completeRoomHours: snapshot?.rooms.filter((room) => room.dataStatus === "complete").length ?? 0,
    skippedUnchangedDates: extras.skippedUnchangedDates ?? snapshot?.lastSkippedUnchangedDates ?? 0,
    importedDates: extras.importedDates ?? snapshot?.lastImportedDates ?? [],
    sourceSheets: snapshot?.sheetSummaries ?? [],
    coverage: snapshot ? buildHistoricalBaselineCoverage(snapshot.rooms, snapshot.asOfLocalDate) : [],
    ...(status.lastSuccessAt ? { lastSuccessAt: status.lastSuccessAt } : {}),
    ...(status.lastError ? { lastError: { at: status.lastError.at, message: sanitizeLarkError(status.lastError.message) } } : {}),
    ...(status.lastAttemptAt ? { lastAttemptAt: status.lastAttemptAt } : {}),
    ...(snapshot ? { asOfLocalDate: snapshot.asOfLocalDate } : {})
  });
}

export class HistoricalBaselineService {
  private syncing: Promise<HistoricalBaselineView> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: HistoricalHourSnapshotStore,
    private readonly fetch: HistoricalHistoryFetcher
  ) {}

  async view(): Promise<HistoricalBaselineView> {
    const [snapshot, status] = await Promise.all([this.store.loadSnapshot(), this.store.loadStatus()]);
    return historicalBaselineViewOf(snapshot, status);
  }

  async comparisonInput(): Promise<{
    rooms: import("@live-growth/contracts").HistoricalHourRoomAggregate[];
    asOfLocalDate?: string;
    lastSuccessAt?: string;
  }> {
    const [snapshot, status] = await Promise.all([this.store.loadSnapshot(), this.store.loadStatus()]);
    return {
      rooms: snapshot?.rooms ?? [],
      ...(snapshot?.asOfLocalDate ? { asOfLocalDate: snapshot.asOfLocalDate } : {}),
      ...(status.lastSuccessAt ? { lastSuccessAt: status.lastSuccessAt } : {})
    };
  }

  health(): Promise<HistoricalBaselineView> {
    return this.view();
  }

  async sync(options: { now?: Date; force?: boolean } = {}): Promise<HistoricalBaselineView> {
    if (this.syncing) throw new HistoricalBaselineSyncInProgressError();
    this.syncing = this.runSync(options).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private async runSync(options: { now?: Date; force?: boolean }): Promise<HistoricalBaselineView> {
    try {
      const result = await syncHistoricalHourBaseline({
        store: this.store,
        fetch: this.fetch,
        ...(options.now ? { now: options.now } : {}),
        ...(options.force ? { force: true } : {})
      });
      return historicalBaselineViewOf(result.snapshot, {
        lastSuccessAt: result.snapshot.lastSuccessAt,
        lastAttemptAt: result.snapshot.lastSuccessAt
      }, { skippedUnchangedDates: result.skippedUnchangedDates.length, importedDates: result.importedDates });
    } catch (error) {
      if (error instanceof HistoricalBaselineSyncFailedError) {
        throw error;
      }
      throw error;
    }
  }

  startDailyTimer(now = new Date()): void {
    if (process.env.HISTORY_DAILY_SYNC !== "1") return;
    const fire = () => {
      void this.sync().catch(() => undefined);
      this.timer = setTimeout(fire, 24 * 60 * 60 * 1000);
    };
    const delay = Math.max(1_000, nextShanghaiDailySyncAt(now).getTime() - now.getTime());
    this.timer = setTimeout(fire, delay);
  }

  stopDailyTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export function createDefaultHistoricalBaselineService(): HistoricalBaselineService {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test" || !process.env.HISTORY_REGISTER_URL) {
    return new HistoricalBaselineService(new MemoryHistoricalHourSnapshotStore(), async () => ({ registerSheets: [] }));
  }
  const cacheDir = defaultHistoricalHistoryCacheDir();
  return new HistoricalBaselineService(
    new FileHistoricalHourSnapshotStore(cacheDir),
    createLarkHistoricalHistoryFetcher({ cacheDir })
  );
}

export function historicalBaselineHealthComponent(view: HistoricalBaselineView): {
  status: "healthy" | "degraded" | "not_configured";
  message: string;
  lastSuccessAt?: string;
} {
  if (view.status === "never_synced") {
    return { status: "not_configured", message: "历史小时基线尚未同步" };
  }
  if (view.status === "degraded") {
    return {
      status: "degraded",
      message: "历史基线沿用上一份成功快照",
      ...(view.lastSuccessAt ? { lastSuccessAt: view.lastSuccessAt } : {})
    };
  }
  return {
    status: "healthy",
    message: view.lastSuccessAt ? `基线更新于 ${view.lastSuccessAt}` : "历史小时基线可用",
    ...(view.lastSuccessAt ? { lastSuccessAt: view.lastSuccessAt } : {})
  };
}
