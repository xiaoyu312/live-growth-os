import {
  liveCompassMetricSnapshotSchema,
  liveWindowAggregateSchema,
  qianchuanMetricSnapshotSchema,
  transcriptSegmentSchema,
  type LiveCompassMetricSnapshot,
  type LiveEvent,
  type LiveWindowAggregate,
  type LiveWindowFieldStat
} from "@live-growth/contracts";

export const LIVE_WINDOW_MINUTES = 15;
export const LIVE_WINDOW_MS = LIVE_WINDOW_MINUTES * 60_000;
/** 默认按 Asia/Shanghai（UTC+08:00）划分窗口；用固定偏移保证跨环境确定性。 */
export const DEFAULT_LIVE_WINDOW_UTC_OFFSET_MINUTES = 480;

type FieldSemantic = LiveWindowFieldStat["semantic"];

/**
 * 罗盘房间级字段的窗口聚合语义。与 live-pilot 的快照对比语义保持一致；
 * 跨商品字段（productClickCount、productPayGmvFen、unpaidOrderCount、
 * productPaidGmvFen）在窗口内可能跨越切品，v1 不做窗口聚合。
 */
export const COMPASS_WINDOW_FIELD_SEMANTICS: Readonly<Partial<Record<keyof LiveCompassMetricSnapshot, FieldSemantic>>> = {
  onlineSnapshot: "instant",
  sessionPaidGmvFen: "cumulative",
  adSpendFen: "cumulative",
  paidBuyerCount: "cumulative",
  paidItemCount: "cumulative",
  watchToPaidRate: "rate",
  productClickToPaidRate: "rate",
  averageWatchDurationSec: "rolling",
  roomEnterCount5m: "rolling",
  userPaidGmvFen5m: "rolling"
};

export type LiveWindowKey = {
  windowStartAt: string;
  windowEndAt: string;
  weekday: number;
  slotIndex: number;
};

/** 把一个 UTC 时间点映射到本地 15 分钟窗口（窗口边界回写为 UTC ISO）。 */
export function liveWindowKeyFor(atMs: number, utcOffsetMinutes: number = DEFAULT_LIVE_WINDOW_UTC_OFFSET_MINUTES): LiveWindowKey {
  const localMs = atMs + utcOffsetMinutes * 60_000;
  const windowStartLocalMs = Math.floor(localMs / LIVE_WINDOW_MS) * LIVE_WINDOW_MS;
  const windowStartMs = windowStartLocalMs - utcOffsetMinutes * 60_000;
  const dayMs = 86_400_000;
  const msIntoLocalDay = ((windowStartLocalMs % dayMs) + dayMs) % dayMs;
  return {
    windowStartAt: new Date(windowStartMs).toISOString(),
    windowEndAt: new Date(windowStartMs + LIVE_WINDOW_MS).toISOString(),
    weekday: new Date(windowStartLocalMs).getUTCDay(),
    slotIndex: Math.floor(msIntoLocalDay / LIVE_WINDOW_MS)
  };
}

type MutableFieldStat = {
  semantic: FieldSemantic;
  sampleCount: number;
  firstAt: string;
  lastAt: string;
  first: number;
  last: number;
  min: number;
  max: number;
  delta: number;
  resetCount: number;
};

type Sample = { at: string; value: number };

export function qianchuanSourceIdentity(event: LiveEvent): string | undefined {
  if (event.kind !== "live.qianchuan.metric") return undefined;
  const parsed = qianchuanMetricSnapshotSchema.safeParse(event.payload);
  return parsed.success ? `${event.source}|${parsed.data.mappingVersion}|${parsed.data.sourceEndpoint}${parsed.data.roomId ? `|room:${parsed.data.roomId}` : ""}` : undefined;
}

function updateStat(stats: Map<string, MutableFieldStat>, carry: Map<string, number>, key: string, semantic: FieldSemantic, sample: Sample): void {
  const existing = stats.get(key);
  if (!existing) {
    const base = semantic === "cumulative" ? carry.get(key) : undefined;
    const initialDelta = base !== undefined ? Math.max(0, sample.value - base) : 0;
    const initialReset = base !== undefined && sample.value < base ? 1 : 0;
    stats.set(key, {
      semantic, sampleCount: 1, firstAt: sample.at, lastAt: sample.at,
      first: sample.value, last: sample.value, min: sample.value, max: sample.value,
      delta: initialDelta, resetCount: initialReset
    });
  } else {
    existing.sampleCount += 1;
    if (semantic === "cumulative") {
      if (sample.value >= existing.last) existing.delta += sample.value - existing.last;
      else existing.resetCount += 1;
    }
    existing.lastAt = sample.at;
    existing.last = sample.value;
    existing.min = Math.min(existing.min, sample.value);
    existing.max = Math.max(existing.max, sample.value);
  }
  if (semantic === "cumulative") carry.set(key, sample.value);
}

function finalizeStats(stats: Map<string, MutableFieldStat>): Record<string, LiveWindowFieldStat> {
  const result: Record<string, LiveWindowFieldStat> = {};
  for (const [key, stat] of stats) {
    result[key] = {
      semantic: stat.semantic, sampleCount: stat.sampleCount, firstAt: stat.firstAt, lastAt: stat.lastAt,
      first: stat.first, last: stat.last, min: stat.min, max: stat.max,
      ...(stat.semantic === "cumulative" ? { delta: stat.delta, resetCount: stat.resetCount } : {})
    };
  }
  return result;
}

export type AggregateLiveWindowsOptions = {
  utcOffsetMinutes?: number;
  /** 会话覆盖范围；缺省时用首末事件时间近似，用于判定窗口 full/partial。 */
  sessionStartAt?: string;
  sessionEndAt?: string;
};

type WindowBucket = {
  key: LiveWindowKey;
  compass: Map<string, MutableFieldStat>;
  qianchuan: Map<string, MutableFieldStat>;
  speechFinals: Array<{ atMs: number; charCount: number }>;
  compassSnapshots: number;
  qianchuanSnapshots: number;
};

/**
 * 把一场直播的事件流聚合成 15 分钟窗口序列。纯函数、确定性：
 * 只依赖事件自身时间，不读取当前时间。无样本的窗口不发射。
 */
export function aggregateLiveWindows(events: readonly LiveEvent[], options: AggregateLiveWindowsOptions = {}): LiveWindowAggregate[] {
  const utcOffsetMinutes = options.utcOffsetMinutes ?? DEFAULT_LIVE_WINDOW_UTC_OFFSET_MINUTES;
  const relevant = events
    .filter((event) => event.kind === "live.compass.metric" || event.kind === "live.qianchuan.metric" || event.kind === "speech.final")
    .map((event) => ({ event, atMs: Date.parse(event.eventAt) }))
    .filter(({ atMs }) => Number.isFinite(atMs))
    .sort((left, right) => left.atMs - right.atMs || Date.parse(left.event.capturedAt) - Date.parse(right.event.capturedAt) || left.event.eventId.localeCompare(right.event.eventId));
  if (relevant.length === 0) return [];

  const tenantId = relevant[0]!.event.tenantId;
  const sessionId = relevant[0]!.event.sessionId;
  const sessionStartMs = options.sessionStartAt ? Date.parse(options.sessionStartAt) : relevant[0]!.atMs;
  const sessionEndMs = options.sessionEndAt ? Date.parse(options.sessionEndAt) : relevant.at(-1)!.atMs;

  const buckets = new Map<string, WindowBucket>();
  const compassCarry = new Map<string, number>();
  const qianchuanCarry = new Map<string, number>();
  let activeQianchuanIdentity: string | undefined;

  for (const { event, atMs } of relevant) {
    const key = liveWindowKeyFor(atMs, utcOffsetMinutes);
    let bucket = buckets.get(key.windowStartAt);
    if (!bucket) {
      bucket = { key, compass: new Map(), qianchuan: new Map(), speechFinals: [], compassSnapshots: 0, qianchuanSnapshots: 0 };
      buckets.set(key.windowStartAt, bucket);
    }
    if (event.kind === "live.compass.metric") {
      const parsed = liveCompassMetricSnapshotSchema.safeParse(event.payload);
      if (!parsed.success) continue;
      bucket.compassSnapshots += 1;
      for (const [field, semantic] of Object.entries(COMPASS_WINDOW_FIELD_SEMANTICS) as Array<[keyof LiveCompassMetricSnapshot, FieldSemantic]>) {
        const value = parsed.data[field];
        if (typeof value !== "number") continue;
        updateStat(bucket.compass, compassCarry, field, semantic, { at: event.eventAt, value });
      }
    } else if (event.kind === "live.qianchuan.metric") {
      const parsed = qianchuanMetricSnapshotSchema.safeParse(event.payload);
      if (!parsed.success) continue;
      const sourceIdentity = qianchuanSourceIdentity(event);
      if (!sourceIdentity) continue;
      if (activeQianchuanIdentity && sourceIdentity !== activeQianchuanIdentity) {
        // 已完成的旧窗口保留；切源所在窗口只保留新来源连续段。新来源
        // 第一条不继承旧来源累计基线，后续窗口再沿用新来源 carry。
        qianchuanCarry.clear();
        bucket.qianchuan.clear();
        bucket.qianchuanSnapshots = 0;
      }
      activeQianchuanIdentity = sourceIdentity;
      bucket.qianchuanSnapshots += 1;
      for (const [field, metricValue] of Object.entries(parsed.data.metrics)) {
        if (!metricValue) continue;
        updateStat(bucket.qianchuan, qianchuanCarry, field, metricValue.semantic, { at: event.eventAt, value: metricValue.value });
      }
    } else {
      const parsed = transcriptSegmentSchema.safeParse(event.payload);
      if (!parsed.success) continue;
      bucket.speechFinals.push({ atMs, charCount: parsed.data.text.length });
    }
  }

  const aggregates: LiveWindowAggregate[] = [];
  for (const bucket of [...buckets.values()].sort((left, right) => Date.parse(left.key.windowStartAt) - Date.parse(right.key.windowStartAt))) {
    const windowStartMs = Date.parse(bucket.key.windowStartAt);
    const windowEndMs = Date.parse(bucket.key.windowEndAt);
    const finals = bucket.speechFinals;
    let maxGapMs: number | undefined;
    if (finals.length >= 2) {
      maxGapMs = 0;
      for (let index = 1; index < finals.length; index += 1) maxGapMs = Math.max(maxGapMs, finals[index]!.atMs - finals[index - 1]!.atMs);
    }
    aggregates.push(liveWindowAggregateSchema.parse({
      schemaVersion: 1,
      tenantId,
      sessionId,
      windowStartAt: bucket.key.windowStartAt,
      windowEndAt: bucket.key.windowEndAt,
      windowMinutes: 15,
      utcOffsetMinutes,
      weekday: bucket.key.weekday,
      slotIndex: bucket.key.slotIndex,
      compass: finalizeStats(bucket.compass),
      qianchuan: finalizeStats(bucket.qianchuan),
      speech: {
        finalCount: finals.length,
        charCount: finals.reduce((total, item) => total + item.charCount, 0),
        ...(finals.length > 0 ? { firstAt: new Date(finals[0]!.atMs).toISOString(), lastAt: new Date(finals.at(-1)!.atMs).toISOString() } : {}),
        ...(maxGapMs !== undefined ? { maxGapMs } : {})
      },
      sampleCounts: {
        compassSnapshots: bucket.compassSnapshots,
        qianchuanSnapshots: bucket.qianchuanSnapshots,
        speechFinals: finals.length
      },
      coverage: sessionStartMs <= windowStartMs && sessionEndMs >= windowEndMs ? "full" : "partial"
    }));
  }
  return aggregates;
}

/** 从开播到 untilMs 之间已经走完的 15 分钟槽，不读事件。给复盘目录用，避免扫整场日志。 */
export function completedWindowOptions(
  sessionStartAt: string,
  untilMs: number,
  utcOffsetMinutes: number = DEFAULT_LIVE_WINDOW_UTC_OFFSET_MINUTES
): Array<{ windowStartAt: string; windowEndAt: string; speechFinals: number; coverage: "full" | "partial" }> {
  const startMs = Date.parse(sessionStartAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(untilMs) || untilMs <= startMs) return [];
  const first = liveWindowKeyFor(startMs, utcOffsetMinutes);
  const options: Array<{ windowStartAt: string; windowEndAt: string; speechFinals: number; coverage: "full" | "partial" }> = [];
  let cursor = Date.parse(first.windowStartAt);
  while (cursor + LIVE_WINDOW_MS <= untilMs && options.length < 48) {
    const key = liveWindowKeyFor(cursor, utcOffsetMinutes);
    options.push({
      windowStartAt: key.windowStartAt,
      windowEndAt: key.windowEndAt,
      speechFinals: 0,
      coverage: "partial"
    });
    cursor = Date.parse(key.windowEndAt);
  }
  return options;
}
