import { describe, expect, it } from "vitest";
import {
  HISTORICAL_HOUR_MAPPING_VERSION,
  historicalHourRoomAggregateSchema,
  liveWindowAggregateSchema,
  type HistoricalHourRoomAggregate,
  type LiveWindowAggregate
} from "@live-growth/contracts";
import { compareLiveHourToBaseline, liveHourToDateFromWindows } from "../src/live-hour-vs-baseline";

function room(localDate: string, hour: number, metrics: HistoricalHourRoomAggregate["metrics"]): HistoricalHourRoomAggregate {
  const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  const windowStartMs = Date.parse(`${localDate}T00:00:00.000Z`) + hour * 3600_000 - 8 * 3600_000;
  return historicalHourRoomAggregateSchema.parse({
    schemaVersion: 1, mappingVersion: HISTORICAL_HOUR_MAPPING_VERSION, source: "csv_import",
    sourceKind: "live-register", rowKind: "room_hour",
    window: {
      localDate, weekday, hour,
      windowLabel: `${String(hour).padStart(2, "0")}:00-${String(hour + 1).padStart(2, "0")}:00`,
      utcOffsetMinutes: 480,
      windowStartAt: new Date(windowStartMs).toISOString(),
      windowEndAt: new Date(windowStartMs + 3600_000).toISOString(),
      grain: "hour"
    },
    sliceCount: 1, anchorNames: ["主播甲"], dataStatus: "complete", metrics
  });
}

function windowAt(start: string, compass: LiveWindowAggregate["compass"], slotIndex: number, weekday = 5, qianchuan: LiveWindowAggregate["qianchuan"] = {}): LiveWindowAggregate {
  const startMs = Date.parse(start);
  return liveWindowAggregateSchema.parse({
    schemaVersion: 1, tenantId: "tenant-demo", sessionId: "session-1",
    windowStartAt: start, windowEndAt: new Date(startMs + 15 * 60_000).toISOString(),
    windowMinutes: 15, utcOffsetMinutes: 480, weekday, slotIndex,
    compass, qianchuan, speech: { finalCount: 0, charCount: 0 },
    sampleCounts: { compassSnapshots: Object.keys(compass).length ? 1 : 0, qianchuanSnapshots: Object.keys(qianchuan).length ? 1 : 0, speechFinals: 0 },
    coverage: "full"
  });
}

function cumulative(firstAt: string, lastAt: string, first: number, last: number, delta = Math.max(0, last - first)) {
  return { semantic: "cumulative" as const, sampleCount: firstAt === lastAt ? 1 : 2, firstAt, lastAt, first, last, min: Math.min(first, last), max: Math.max(first, last), delta, resetCount: 0 };
}

describe("liveHourToDateFromWindows", () => {
  it("把同小时 15 分钟窗的累计增量相加，不把小时值均分", () => {
    const windows = [
      windowAt("2026-08-14T00:00:00.000Z", { sessionPaidGmvFen: { semantic: "cumulative", sampleCount: 1, firstAt: "2026-08-14T00:01:00.000Z", lastAt: "2026-08-14T00:10:00.000Z", first: 1000, last: 4000, min: 1000, max: 4000, delta: 3000, resetCount: 0 } }, 32),
      windowAt("2026-08-14T00:15:00.000Z", { sessionPaidGmvFen: { semantic: "cumulative", sampleCount: 1, firstAt: "2026-08-14T00:16:00.000Z", lastAt: "2026-08-14T00:20:00.000Z", first: 4000, last: 7000, min: 4000, max: 7000, delta: 3000, resetCount: 0 } }, 33)
    ];
    const live = liveHourToDateFromWindows(windows, Date.parse("2026-08-14T00:20:00.000Z"));
    expect(live).toMatchObject({ hour: 8, grain: "hour", gmvFen: 6000, liveCoverage: "hour_to_date" });
    expect(live).not.toHaveProperty("quarters");
  });

  it("跨整点只用本小时新增，不把整场累计当成这个钟点的成交", () => {
    const windows = [
      windowAt("2026-08-18T06:45:00.000Z", { sessionPaidGmvFen: cumulative("2026-08-18T06:46:00.000Z", "2026-08-18T06:58:00.000Z", 191_000, 191_000, 0) }, 59, 2),
      windowAt("2026-08-18T07:00:00.000Z", { sessionPaidGmvFen: cumulative("2026-08-18T07:05:00.000Z", "2026-08-18T07:05:00.000Z", 197_291, 197_291, 197_291) }, 60, 2)
    ];
    const live = liveHourToDateFromWindows(windows, Date.parse("2026-08-18T07:05:00.000Z"));
    expect(live).toMatchObject({ weekday: 2, hour: 15, gmvFen: 6_291 });
    expect(live.gmvFen).not.toBe(197_291);
  });

  it("千川累计跨整点也只取本小时增量", () => {
    const windows = [
      windowAt("2026-08-18T06:45:00.000Z", {}, 59, 2, { paidOrderGmv: cumulative("2026-08-18T06:46:00.000Z", "2026-08-18T06:58:00.000Z", 1910, 1910, 0) }),
      windowAt("2026-08-18T07:00:00.000Z", {}, 60, 2, { paidOrderGmv: cumulative("2026-08-18T07:05:00.000Z", "2026-08-18T07:05:00.000Z", 1972.91, 1972.91, 1972.91) })
    ];
    const live = liveHourToDateFromWindows(windows, Date.parse("2026-08-18T07:05:00.000Z"));
    expect(live.gmvFen).toBe(6_291);
  });

  it("本小时只有一个累计快照、没有整点前基数时，不算时段成交", () => {
    const windows = [
      windowAt("2026-08-18T07:00:00.000Z", { sessionPaidGmvFen: cumulative("2026-08-18T07:05:00.000Z", "2026-08-18T07:05:00.000Z", 197_291, 197_291, 197_291) }, 60, 2)
    ];
    const live = liveHourToDateFromWindows(windows, Date.parse("2026-08-18T07:05:00.000Z"));
    expect(live.hour).toBe(15);
    expect(live).not.toHaveProperty("gmvFen");
  });
});

describe("compareLiveHourToBaseline", () => {
  it("工作日 17 点无样本，不补 0，在线无采集点则不出现", () => {
    const live = liveHourToDateFromWindows([], Date.parse("2026-08-14T09:10:00.000Z"));
    expect(live.hour).toBe(17);
    const compared = compareLiveHourToBaseline(live, [room("2026-07-10", 8, { gmvFen: 1000 })], { asOfLocalDate: "2026-08-14" });
    expect(compared.grain).toBe("hour");
    expect(compared.metrics.map((item) => item.metricKey)).toEqual(["gmvFen", "gsvFen", "adSpendFen"]);
    expect(compared.metrics.every((item) => item.liveStatus === "missing")).toBe(true);
    expect(compared.metrics[0]?.baseline).toMatchObject({ status: "sampleInsufficient", reason: "no_complete_samples", n: 0 });
  });

  it("n<3 为样本不足；有采集在线才比在线", () => {
    const rooms = [
      room("2026-07-10", 8, { gmvFen: 1000, gsvFen: 800, adSpendFen: 100, onlineSnapshot: 20 }),
      room("2026-07-17", 8, { gmvFen: 2000, gsvFen: 1500, adSpendFen: 200, onlineSnapshot: 30 })
    ];
    const compared = compareLiveHourToBaseline({
      weekday: 5, hour: 8, grain: "hour", windowStartAt: "2026-08-14T00:00:00.000Z",
      windowEndAt: "2026-08-14T01:00:00.000Z", liveCoverage: "hour_to_date", gmvFen: 1800, onlineSnapshot: 25
    }, rooms, { asOfLocalDate: "2026-08-14", lastSuccessAt: "2026-08-14T16:30:00.000Z" });
    expect(compared.metrics.find((item) => item.metricKey === "gmvFen")?.baseline).toMatchObject({ status: "sampleInsufficient", reason: "n_lt_3", n: 2 });
    expect(compared.metrics.find((item) => item.metricKey === "onlineSnapshot")?.liveValue).toBe(25);
    expect(compared.lastSuccessAt).toBe("2026-08-14T16:30:00.000Z");
  });
});
