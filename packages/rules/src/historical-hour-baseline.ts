import {
  historicalHourBaselineSchema,
  type HistoricalHourBaseline,
  type HistoricalHourBaselineMetricKey,
  type HistoricalHourRoomAggregate
} from "@live-growth/contracts";

export const HISTORICAL_HOUR_BASELINE_MIN_SAMPLES = 3;
export const HISTORICAL_HOUR_BASELINE_MAX_SAMPLES = 8;

export type HistoricalHourBaselineQuery = {
  weekday: number;
  hour: number;
  metricKey: HistoricalHourBaselineMetricKey;
  asOfLocalDate?: string;
};

export type HistoricalHourRatioQuery = {
  weekday: number;
  hour: number;
  numeratorKey: HistoricalHourBaselineMetricKey;
  denominatorKey: HistoricalHourBaselineMetricKey;
  asOfLocalDate?: string;
};

export type HistoricalHourRatioBaseline =
  | { status: "ok"; n: number; median: number; p25: number; p75: number }
  | { status: "sampleInsufficient"; n: number; reason: "n_lt_3" | "no_complete_samples" };

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low]!;
  const weight = position - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

function median(sorted: number[]): number {
  return quantile(sorted, 0.5);
}

function metricValue(room: HistoricalHourRoomAggregate, key: HistoricalHourBaselineMetricKey): number | undefined {
  return room.metrics[key];
}

/** v1 禁止把小时值均分成 15 分钟。驾驶舱只对齐所属小时，grain 仍为 hour。 */
export function trySplitHourMetricToQuarter(value: number): { ok: false; reason: "hour_not_split_to_quarter" } {
  void value;
  return { ok: false, reason: "hour_not_split_to_quarter" };
}

export function hourForSlotIndex(slotIndex: number): { hour: number; grain: "hour" } {
  return { hour: Math.floor(slotIndex / 4), grain: "hour" };
}

const COVERAGE_METRIC_KEYS = ["gmvFen", "gsvFen", "adSpendFen", "onlineSnapshot"] as const satisfies HistoricalHourBaselineMetricKey[];

export function buildHistoricalBaselineCoverage(
  rooms: readonly HistoricalHourRoomAggregate[],
  asOfLocalDate: string
): Array<{ metricKey: HistoricalHourBaselineMetricKey; okCells: number; totalCells: 168 }> {
  return COVERAGE_METRIC_KEYS.map((metricKey) => {
    let okCells = 0;
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      for (let hour = 0; hour <= 23; hour += 1) {
        if (computeSameWeekdayHourBaseline(rooms, { weekday, hour, metricKey, asOfLocalDate }).status === "ok") okCells += 1;
      }
    }
    return { metricKey, okCells, totalCells: 168 as const };
  });
}

export function computeSameWeekdayHourBaseline(
  rooms: readonly HistoricalHourRoomAggregate[],
  query: HistoricalHourBaselineQuery
): HistoricalHourBaseline {
  const eligible = rooms.filter((room) => {
    if (room.dataStatus !== "complete") return false;
    if (room.window.weekday !== query.weekday || room.window.hour !== query.hour) return false;
    if (query.asOfLocalDate && room.window.localDate >= query.asOfLocalDate) return false;
    return metricValue(room, query.metricKey) !== undefined;
  }).sort((left, right) => right.window.localDate.localeCompare(left.window.localDate));

  const window = eligible.slice(0, HISTORICAL_HOUR_BASELINE_MAX_SAMPLES);
  const n = window.length;
  if (n < HISTORICAL_HOUR_BASELINE_MIN_SAMPLES) {
    return historicalHourBaselineSchema.parse({
      status: "sampleInsufficient",
      grain: "hour",
      weekday: query.weekday,
      hour: query.hour,
      metricKey: query.metricKey,
      n,
      reason: n === 0 ? "no_complete_samples" : "n_lt_3"
    });
  }

  const values = window.map((room) => metricValue(room, query.metricKey)!).sort((left, right) => left - right);
  return historicalHourBaselineSchema.parse({
    status: "ok",
    grain: "hour",
    weekday: query.weekday,
    hour: query.hour,
    metricKey: query.metricKey,
    n,
    median: median(values),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    sampleLocalDates: window.map((room) => room.window.localDate)
  });
}

/**
 * 同星期同时钟小时的比率中位数。对每场先算比率再取中位数，不用两个中位数相除。
 * 分母为 0 或缺测的场次不入样本。
 */
export function computeSameWeekdayHourRatio(
  rooms: readonly HistoricalHourRoomAggregate[],
  query: HistoricalHourRatioQuery
): HistoricalHourRatioBaseline {
  const eligible = rooms.filter((room) => {
    if (room.dataStatus !== "complete") return false;
    if (room.window.weekday !== query.weekday || room.window.hour !== query.hour) return false;
    if (query.asOfLocalDate && room.window.localDate >= query.asOfLocalDate) return false;
    const numerator = metricValue(room, query.numeratorKey);
    const denominator = metricValue(room, query.denominatorKey);
    return numerator !== undefined && denominator !== undefined && denominator > 0;
  }).sort((left, right) => right.window.localDate.localeCompare(left.window.localDate));

  const window = eligible.slice(0, HISTORICAL_HOUR_BASELINE_MAX_SAMPLES);
  const n = window.length;
  if (n < HISTORICAL_HOUR_BASELINE_MIN_SAMPLES) {
    return { status: "sampleInsufficient", n, reason: n === 0 ? "no_complete_samples" : "n_lt_3" };
  }
  const values = window.map((room) => metricValue(room, query.numeratorKey)! / metricValue(room, query.denominatorKey)!).sort((left, right) => left - right);
  return { status: "ok", n, median: median(values), p25: quantile(values, 0.25), p75: quantile(values, 0.75) };
}
