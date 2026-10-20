import { describe, expect, it } from "vitest";
import {
  HISTORICAL_HOUR_MAPPING_VERSION,
  historicalHourRoomAggregateSchema,
  type HistoricalHourRoomAggregate
} from "@live-growth/contracts";
import { computeSameWeekdayHourBaseline, computeSameWeekdayHourRatio, hourForSlotIndex, trySplitHourMetricToQuarter } from "../src/historical-hour-baseline";

function room(localDate: string, hour: number, metrics: HistoricalHourRoomAggregate["metrics"], dataStatus: "complete" | "incomplete" = "complete"): HistoricalHourRoomAggregate {
  const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  const windowStartMs = Date.parse(`${localDate}T00:00:00.000Z`) + hour * 3600_000 - 8 * 3600_000;
  return historicalHourRoomAggregateSchema.parse({
    schemaVersion: 1,
    mappingVersion: HISTORICAL_HOUR_MAPPING_VERSION,
    source: "csv_import",
    sourceKind: "live-register",
    rowKind: "room_hour",
    window: {
      localDate, weekday, hour,
      windowLabel: `${String(hour).padStart(2, "0")}:00-${String(hour + 1).padStart(2, "0")}:00`,
      utcOffsetMinutes: 480,
      windowStartAt: new Date(windowStartMs).toISOString(),
      windowEndAt: new Date(windowStartMs + 3600_000).toISOString(),
      grain: "hour"
    },
    sliceCount: 1,
    anchorNames: ["主播甲"],
    dataStatus,
    metrics
  });
}

describe("同星期同时钟小时基线", () => {
  it("n<3 只返回 sampleInsufficient，不给出假中位数", () => {
    const rooms = [
      room("2026-07-10", 8, { gmvFen: 1000 }),
      room("2026-07-17", 8, { gmvFen: 2000 })
    ];
    const result = computeSameWeekdayHourBaseline(rooms, { weekday: 5, hour: 8, metricKey: "gmvFen" });
    expect(result).toMatchObject({ status: "sampleInsufficient", n: 2, reason: "n_lt_3", grain: "hour" });
    expect(result).not.toHaveProperty("median");
  });

  it("空小时不是 0：无播出的小时不进入样本", () => {
    const rooms = [
      room("2026-07-10", 8, { gmvFen: 1000 }),
      room("2026-07-17", 8, { gmvFen: 2000 }),
      room("2026-07-24", 8, { gmvFen: 3000 }),
      room("2026-07-10", 7, { gmvFen: 4000 })
    ];
    const hourNine = computeSameWeekdayHourBaseline(rooms, { weekday: 5, hour: 9, metricKey: "gmvFen" });
    expect(hourNine).toMatchObject({ status: "sampleInsufficient", n: 0, reason: "no_complete_samples" });
    const hourEight = computeSameWeekdayHourBaseline(rooms, { weekday: 5, hour: 8, metricKey: "gmvFen" });
    expect(hourEight.status).toBe("ok");
    if (hourEight.status === "ok") {
      expect(hourEight.n).toBe(3);
      expect(hourEight.median).toBe(2000);
      expect(hourEight.sampleLocalDates).toEqual(["2026-07-24", "2026-07-17", "2026-07-10"]);
    }
  });

  it("GMV 与 GSV 分列计算，未完结小时不入样本", () => {
    const rooms = [
      room("2026-07-03", 8, { gmvFen: 1000, gsvFen: 800 }),
      room("2026-07-10", 8, { gmvFen: 2000, gsvFen: 1500 }),
      room("2026-07-17", 8, { gmvFen: 3000, gsvFen: 2200 }),
      room("2026-07-24", 8, { gmvFen: 9999, gsvFen: 1 }, "incomplete")
    ];
    const gmv = computeSameWeekdayHourBaseline(rooms, { weekday: 5, hour: 8, metricKey: "gmvFen" });
    const gsv = computeSameWeekdayHourBaseline(rooms, { weekday: 5, hour: 8, metricKey: "gsvFen" });
    expect(gmv.status).toBe("ok");
    expect(gsv.status).toBe("ok");
    if (gmv.status === "ok" && gsv.status === "ok") {
      expect(gmv.median).toBe(2000);
      expect(gsv.median).toBe(1500);
      expect(gmv.median).not.toBe(gsv.median);
      expect(gmv.n).toBe(3);
    }
  });

  it("禁止把小时基线均分成 15 分钟", () => {
    expect(trySplitHourMetricToQuarter(16000)).toEqual({ ok: false, reason: "hour_not_split_to_quarter" });
    expect(hourForSlotIndex(32)).toEqual({ hour: 8, grain: "hour" });
    const rooms = [room("2026-07-10", 8, { gmvFen: 4000 }), room("2026-07-17", 8, { gmvFen: 8000 }), room("2026-07-24", 8, { gmvFen: 12000 })];
    const result = computeSameWeekdayHourBaseline(rooms, { weekday: 5, hour: 8, metricKey: "gmvFen" });
    expect(result.grain).toBe("hour");
    expect(result).not.toHaveProperty("quarters");
    if (result.status === "ok") expect(result.median).toBe(8000);
  });

  it("滚动窗口最多取最近 8 个有样本小时", () => {
    const rooms = [
      room("2026-06-05", 8, { gmvFen: 100 }),
      room("2026-06-12", 8, { gmvFen: 200 }),
      room("2026-06-19", 8, { gmvFen: 300 }),
      room("2026-06-26", 8, { gmvFen: 400 }),
      room("2026-07-03", 8, { gmvFen: 500 }),
      room("2026-07-10", 8, { gmvFen: 600 }),
      room("2026-07-17", 8, { gmvFen: 700 }),
      room("2026-07-24", 8, { gmvFen: 800 }),
      room("2026-07-31", 8, { gmvFen: 900 })
    ];
    const result = computeSameWeekdayHourBaseline(rooms, { weekday: 5, hour: 8, metricKey: "gmvFen", asOfLocalDate: "2026-08-14" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.n).toBe(8);
      expect(result.sampleLocalDates).toEqual([
        "2026-07-31", "2026-07-24", "2026-07-17", "2026-07-10",
        "2026-07-03", "2026-06-26", "2026-06-19", "2026-06-12"
      ]);
      expect(result.sampleLocalDates).not.toContain("2026-06-05");
    }
  });

  it("比率基线对每场先算比率再取中位数，不用两个中位数相除", () => {
    const rooms = [
      room("2026-07-10", 8, { roomEnterUv: 100, roomImpressionUv: 1000, roomEnterPv: 120, roomImpressionPv: 1000 }),
      room("2026-07-17", 8, { roomEnterUv: 200, roomImpressionUv: 1000, roomEnterPv: 180, roomImpressionPv: 1000 }),
      room("2026-07-24", 8, { roomEnterUv: 300, roomImpressionUv: 1000, roomEnterPv: 300, roomImpressionPv: 1000 })
    ];
    const people = computeSameWeekdayHourRatio(rooms, {
      weekday: 5, hour: 8, numeratorKey: "roomEnterUv", denominatorKey: "roomImpressionUv"
    });
    const counts = computeSameWeekdayHourRatio(rooms, {
      weekday: 5, hour: 8, numeratorKey: "roomEnterPv", denominatorKey: "roomImpressionPv"
    });
    expect(people).toMatchObject({ status: "ok", n: 3, median: 0.2 });
    expect(counts).toMatchObject({ status: "ok", n: 3, median: 0.18 });
  });
});
