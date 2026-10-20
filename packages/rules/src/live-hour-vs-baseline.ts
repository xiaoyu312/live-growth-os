import {
  liveHourVsBaselineSchema,
  type HistoricalHourBaseline,
  type HistoricalHourRoomAggregate,
  type LiveHourComparisonMetric,
  type LiveHourVsBaseline,
  type LiveWindowAggregate
} from "@live-growth/contracts";
import { computeSameWeekdayHourBaseline, hourForSlotIndex } from "./historical-hour-baseline";
import { DEFAULT_LIVE_WINDOW_UTC_OFFSET_MINUTES, liveWindowKeyFor } from "./live-window-aggregate";

const PEAK_METRIC_ORDER = ["gmvFen", "gsvFen", "adSpendFen"] as const;

export type LiveHourToDate = {
  weekday: number;
  hour: number;
  grain: "hour";
  windowStartAt: string;
  windowEndAt: string;
  liveCoverage: "hour_to_date" | "full_hour";
  gmvFen?: number;
  adSpendFen?: number;
  onlineSnapshot?: number;
};

function fenFromYuan(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(value * 100);
}

type CumulativePoint = { value: number; at: string };

function lastCompassCumulative(windows: readonly LiveWindowAggregate[], key: "sessionPaidGmvFen" | "adSpendFen"): CumulativePoint | undefined {
  for (const window of [...windows].reverse()) {
    const stat = window.compass[key];
    if (stat && Number.isFinite(stat.last) && stat.lastAt) return { value: stat.last, at: stat.lastAt };
  }
  return undefined;
}

function firstCompassCumulative(windows: readonly LiveWindowAggregate[], key: "sessionPaidGmvFen" | "adSpendFen"): CumulativePoint | undefined {
  for (const window of windows) {
    const stat = window.compass[key];
    if (stat && Number.isFinite(stat.first) && stat.firstAt) return { value: stat.first, at: stat.firstAt };
  }
  return undefined;
}

function lastQianchuanCumulative(windows: readonly LiveWindowAggregate[], key: "paidOrderGmv" | "adSpend"): CumulativePoint | undefined {
  for (const window of [...windows].reverse()) {
    const stat = window.qianchuan[key];
    if (stat && Number.isFinite(stat.last) && stat.lastAt) return { value: stat.last, at: stat.lastAt };
  }
  return undefined;
}

function firstQianchuanCumulative(windows: readonly LiveWindowAggregate[], key: "paidOrderGmv" | "adSpend"): CumulativePoint | undefined {
  for (const window of windows) {
    const stat = window.qianchuan[key];
    if (stat && Number.isFinite(stat.first) && stat.firstAt) return { value: stat.first, at: stat.firstAt };
  }
  return undefined;
}

/** 时段增量：本小时最新累计 − 整点前最后一次累计。禁止把整场累计当成这个钟点的成交。 */
function periodIncrement(lastInHour: CumulativePoint | undefined, lastBeforeHour: CumulativePoint | undefined, firstInHour: CumulativePoint | undefined): number | undefined {
  if (!lastInHour) return undefined;
  if (lastBeforeHour) return Math.max(0, lastInHour.value - lastBeforeHour.value);
  if (!firstInHour) return undefined;
  if (firstInHour.at === lastInHour.at) return undefined;
  return Math.max(0, lastInHour.value - firstInHour.value);
}

function hourGmvFen(before: readonly LiveWindowAggregate[], inHour: readonly LiveWindowAggregate[]): number | undefined {
  const compassBefore = lastCompassCumulative(before, "sessionPaidGmvFen");
  const qianchuanBefore = lastQianchuanCumulative(before, "paidOrderGmv");
  const compass = periodIncrement(lastCompassCumulative(inHour, "sessionPaidGmvFen"), compassBefore, firstCompassCumulative(inHour, "sessionPaidGmvFen"));
  const qianchuanYuan = periodIncrement(lastQianchuanCumulative(inHour, "paidOrderGmv"), qianchuanBefore, firstQianchuanCumulative(inHour, "paidOrderGmv"));
  const qianchuan = fenFromYuan(qianchuanYuan);
  if (qianchuanBefore && qianchuan !== undefined) return qianchuan;
  if (compassBefore && compass !== undefined) return compass;
  return qianchuan ?? compass;
}

function hourSpendFen(before: readonly LiveWindowAggregate[], inHour: readonly LiveWindowAggregate[]): number | undefined {
  const compass = periodIncrement(lastCompassCumulative(inHour, "adSpendFen"), lastCompassCumulative(before, "adSpendFen"), firstCompassCumulative(inHour, "adSpendFen"));
  const qianchuanYuan = periodIncrement(lastQianchuanCumulative(inHour, "adSpend"), lastQianchuanCumulative(before, "adSpend"), firstQianchuanCumulative(inHour, "adSpend"));
  return compass ?? fenFromYuan(qianchuanYuan);
}

function clockHourWindow(atMs: number, utcOffsetMinutes: number): { weekday: number; hour: number; windowStartAt: string; windowEndAt: string } {
  const slot = liveWindowKeyFor(atMs, utcOffsetMinutes);
  const hour = hourForSlotIndex(slot.slotIndex).hour;
  const localMs = atMs + utcOffsetMinutes * 60_000;
  const hourStartLocalMs = Math.floor(localMs / 3_600_000) * 3_600_000;
  const windowStartMs = hourStartLocalMs - utcOffsetMinutes * 60_000;
  return {
    weekday: slot.weekday,
    hour,
    windowStartAt: new Date(windowStartMs).toISOString(),
    windowEndAt: new Date(windowStartMs + 3_600_000).toISOString()
  };
}

/** 当前时钟小时的时段增量；不把整场累计或小时基线均分进窗。 */
export function liveHourToDateFromWindows(
  windows: readonly LiveWindowAggregate[],
  atMs: number,
  utcOffsetMinutes: number = DEFAULT_LIVE_WINDOW_UTC_OFFSET_MINUTES
): LiveHourToDate {
  const clock = clockHourWindow(atMs, utcOffsetMinutes);
  const hourStartMs = Date.parse(clock.windowStartAt);
  const hourEndMs = Date.parse(clock.windowEndAt);
  const ordered = [...windows].sort((left, right) => Date.parse(left.windowStartAt) - Date.parse(right.windowStartAt));
  const before = ordered.filter((window) => Date.parse(window.windowStartAt) < hourStartMs);
  const inHour = ordered.filter((window) => Date.parse(window.windowStartAt) >= hourStartMs && Date.parse(window.windowEndAt) <= hourEndMs + 1);
  const gmvFen = hourGmvFen(before, inHour);
  const adSpendFen = hourSpendFen(before, inHour);
  let onlineSnapshot: number | undefined;
  for (const window of inHour) {
    const online = window.compass["onlineSnapshot"]?.last ?? window.qianchuan["onlineSnapshot"]?.last;
    if (online !== undefined) onlineSnapshot = online;
  }
  const liveCoverage = atMs >= hourEndMs ? "full_hour" : "hour_to_date";
  return {
    weekday: clock.weekday,
    hour: clock.hour,
    grain: "hour",
    windowStartAt: clock.windowStartAt,
    windowEndAt: clock.windowEndAt,
    liveCoverage,
    ...(gmvFen !== undefined ? { gmvFen } : {}),
    ...(adSpendFen !== undefined ? { adSpendFen } : {}),
    ...(onlineSnapshot !== undefined ? { onlineSnapshot } : {})
  };
}

function bandOf(liveValue: number, baseline: HistoricalHourBaseline): LiveHourComparisonMetric["band"] | undefined {
  if (baseline.status !== "ok") return undefined;
  if (liveValue > baseline.p75) return "above_p75";
  if (liveValue < baseline.p25) return "below_p25";
  return "within_iqr";
}

function metricRow(
  metricKey: LiveHourComparisonMetric["metricKey"],
  liveValue: number | undefined,
  liveCoverage: LiveHourToDate["liveCoverage"] | "unavailable",
  baseline: HistoricalHourBaseline
): LiveHourComparisonMetric {
  if (liveValue === undefined) {
    return { metricKey, grain: "hour", liveStatus: "missing", liveCoverage: liveCoverage === "unavailable" ? "unavailable" : liveCoverage, baseline };
  }
  return {
    metricKey,
    grain: "hour",
    liveStatus: "ok",
    liveValue,
    liveCoverage: liveCoverage === "unavailable" ? "hour_to_date" : liveCoverage,
    baseline,
    ...(bandOf(liveValue, baseline) ? { band: bandOf(liveValue, baseline) } : {})
  };
}

export type CompareLiveHourToBaselineOptions = {
  asOfLocalDate?: string;
  lastSuccessAt?: string;
};

/**
 * 高峰时段先比 GMV / GSV / 时段消耗；在线只在采集快照基线有点时出现。
 * 本场无 GSV 口径时 liveStatus=missing，仍展示基线样本态，不补 0。
 */
export function compareLiveHourToBaseline(
  live: LiveHourToDate,
  rooms: readonly HistoricalHourRoomAggregate[],
  options: CompareLiveHourToBaselineOptions = {}
): LiveHourVsBaseline {
  const query = { weekday: live.weekday, hour: live.hour, ...(options.asOfLocalDate ? { asOfLocalDate: options.asOfLocalDate } : {}) };
  const gmv = computeSameWeekdayHourBaseline(rooms, { ...query, metricKey: "gmvFen" });
  const gsv = computeSameWeekdayHourBaseline(rooms, { ...query, metricKey: "gsvFen" });
  const spend = computeSameWeekdayHourBaseline(rooms, { ...query, metricKey: "adSpendFen" });
  const onlineBaseline = computeSameWeekdayHourBaseline(rooms, { ...query, metricKey: "onlineSnapshot" });
  const metrics: LiveHourComparisonMetric[] = [
    metricRow("gmvFen", live.gmvFen, live.gmvFen === undefined ? "unavailable" : live.liveCoverage, gmv),
    metricRow("gsvFen", undefined, "unavailable", gsv),
    metricRow("adSpendFen", live.adSpendFen, live.adSpendFen === undefined ? "unavailable" : live.liveCoverage, spend)
  ];
  if (onlineBaseline.status === "ok" || (onlineBaseline.status === "sampleInsufficient" && onlineBaseline.n > 0)) {
    metrics.push(metricRow("onlineSnapshot", live.onlineSnapshot, live.onlineSnapshot === undefined ? "unavailable" : live.liveCoverage, onlineBaseline));
  }
  void PEAK_METRIC_ORDER;
  return liveHourVsBaselineSchema.parse({
    grain: "hour",
    weekday: live.weekday,
    hour: live.hour,
    metrics,
    ...(options.lastSuccessAt ? { lastSuccessAt: options.lastSuccessAt } : {}),
    ...(options.asOfLocalDate ? { asOfLocalDate: options.asOfLocalDate } : {})
  });
}
