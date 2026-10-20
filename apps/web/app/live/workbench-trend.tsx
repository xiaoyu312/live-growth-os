"use client";

import { useState } from "react";
import "./workbench-trend.css";

export type WorkbenchTrendMetricValue = {
  value: number;
  unit: string;
  semantic: string;
  sourceField: string;
  windowLabel?: string;
};

export type WorkbenchTrendSnapshot = {
  observedAt: string;
  dataStatus?: string;
  roomId?: string;
  sourceEndpoint?: string;
  mappingVersion?: string;
  metrics: Partial<Record<"paidOrderGmv" | "adSpend" | string, WorkbenchTrendMetricValue | undefined>>;
};

export type WorkbenchTrendPoint = {
  observedAt: string;
  observedAtMs: number;
  gmvYuan?: number;
  spendYuan?: number;
  gmvStartObservedAt?: string;
  spendStartObservedAt?: string;
  gmvIntervalSeconds?: number;
  spendIntervalSeconds?: number;
};

export type WorkbenchTrendModel = {
  status: "ready" | "empty" | "stopped";
  reason: "ready" | "waiting_for_same_source_minute" | "stopped_over_90_seconds" | "no_current_snapshot" | "source_not_fresh";
  points: WorkbenchTrendPoint[];
  windowStartMs: number;
  windowEndMs: number;
  domainMaxYuan: number;
  latestObservedAtMs?: number;
  staleMetricKeys: Array<"paidOrderGmv" | "adSpend">;
};

export type WorkbenchTrendProps = {
  history: readonly WorkbenchTrendSnapshot[];
  nowMs?: number;
};

export const WORKBENCH_TREND_WINDOW_MS = 15 * 60 * 1000;
export const WORKBENCH_TREND_MIN_INTERVAL_MS = 45 * 1000;
export const WORKBENCH_TREND_MAX_INTERVAL_MS = 90 * 1000;
export const WORKBENCH_TREND_STALE_AFTER_MS = 90 * 1000;

type MetricKey = "paidOrderGmv" | "adSpend";
type ParsedValue = {
  observedAt: string;
  observedAtMs: number;
  value: number;
  unit: string;
  semantic: string;
  sourceField: string;
  sourceKey: string;
};
type DeltaValue = { observedAt: string; observedAtMs: number; startObservedAt: string; intervalSeconds: number; value: number };

const METRIC_KEYS: readonly MetricKey[] = ["paidOrderGmv", "adSpend"];

function safeNowMs(nowMs?: number): number {
  return nowMs !== undefined && Number.isFinite(nowMs) ? nowMs : Date.now();
}

function snapshotSourceKey(snapshot: WorkbenchTrendSnapshot): string {
  return [snapshot.sourceEndpoint ?? "", snapshot.roomId ?? "", snapshot.mappingVersion ?? ""].join("\u001f");
}

function parseValues(history: readonly WorkbenchTrendSnapshot[], key: MetricKey, nowMs: number): ParsedValue[] {
  return history.flatMap((snapshot) => {
    const observedAtMs = Date.parse(snapshot.observedAt);
    const metric = snapshot.metrics[key];
    if (!Number.isFinite(observedAtMs) || observedAtMs > nowMs || !metric || metric.unit !== "元" || metric.semantic !== "cumulative" || typeof metric.sourceField !== "string" || metric.sourceField.length === 0 || !Number.isFinite(metric.value) || metric.value < 0 || snapshot.dataStatus !== "fresh") return [];
    return [{ observedAt: snapshot.observedAt, observedAtMs, value: metric.value, unit: metric.unit, semantic: metric.semantic, sourceField: metric.sourceField, sourceKey: snapshotSourceKey(snapshot) }];
  });
}

function deltasForSegment(values: ParsedValue[], targetSourceKey: string, segmentStartMs: number): DeltaValue[] {
  const groupedByTimestamp = new Map<number, ParsedValue[]>();
  for (const value of values.filter((candidate) => candidate.sourceKey === targetSourceKey && candidate.observedAtMs > segmentStartMs)) {
    const group = groupedByTimestamp.get(value.observedAtMs) ?? [];
    group.push(value);
    groupedByTimestamp.set(value.observedAtMs, group);
  }
  const sorted = [...groupedByTimestamp.entries()].sort(([left], [right]) => left - right);
  const points: DeltaValue[] = [];
  let previous: ParsedValue | undefined;
  for (const [, group] of sorted) {
    const fields = new Set(group.map((value) => value.sourceField));
    const numbers = new Set(group.map((value) => value.value));
    if (fields.size !== 1 || numbers.size !== 1) {
      // A contradictory duplicate timestamp is a hard boundary. Dropping
      // only the duplicate would allow the next sample to bridge over it.
      previous = undefined;
      continue;
    }
    const current = group[0]!;
    if (!previous || current.sourceField !== previous.sourceField) {
      previous = current;
      continue;
    }
    const interval = current.observedAtMs - previous.observedAtMs;
    if (interval < WORKBENCH_TREND_MIN_INTERVAL_MS || interval > WORKBENCH_TREND_MAX_INTERVAL_MS) {
      previous = undefined;
      continue;
    }
    const delta = current.value - previous.value;
    if (delta < 0) {
      // A cumulative reset invalidates the boundary on both sides. Keep the
      // raw observations out of the chart instead of drawing a fake zero.
      previous = undefined;
      continue;
    }
    points.push({ observedAt: current.observedAt, observedAtMs: current.observedAtMs, startObservedAt: previous.observedAt, intervalSeconds: interval / 1000, value: delta });
    previous = current;
  }
  return points;
}

function chooseLatestSource(history: readonly WorkbenchTrendSnapshot[], nowMs: number): { sourceKey: string; segmentStartMs: number } | undefined {
  const validSnapshots = history.flatMap((snapshot) => {
    const observedAtMs = Date.parse(snapshot.observedAt);
    return snapshot.dataStatus === "fresh" && Number.isFinite(observedAtMs) && observedAtMs <= nowMs ? [{ snapshot, observedAtMs, sourceKey: snapshotSourceKey(snapshot) }] : [];
  });
  const latest = [...validSnapshots].sort((left, right) => left.observedAtMs - right.observedAtMs).at(-1);
  if (!latest) return undefined;
  const previousSource = validSnapshots
    .filter((value) => value.observedAtMs <= latest.observedAtMs && value.sourceKey !== latest.sourceKey)
    .sort((left, right) => left.observedAtMs - right.observedAtMs)
    .at(-1);
  return { sourceKey: latest.sourceKey, segmentStartMs: previousSource?.observedAtMs ?? Number.NEGATIVE_INFINITY };
}

function latestValueAt(values: ParsedValue[]): number | undefined {
  return values.reduce<number | undefined>((latest, value) => latest === undefined || value.observedAtMs > latest ? value.observedAtMs : latest, undefined);
}

export function buildWorkbenchTrendModel(history: readonly WorkbenchTrendSnapshot[], nowMs?: number): WorkbenchTrendModel {
  const safeNow = safeNowMs(nowMs);
  const windowStartMs = safeNow - WORKBENCH_TREND_WINDOW_MS;
  const latestRaw = history.filter(item => Number.isFinite(Date.parse(item.observedAt)) && Date.parse(item.observedAt) <= safeNow).sort((a,b) => Date.parse(a.observedAt)-Date.parse(b.observedAt)).at(-1);
  const sourceNotFresh = latestRaw !== undefined && latestRaw.dataStatus !== "fresh";
  const values = Object.fromEntries(METRIC_KEYS.map((key) => [key, parseValues(history, key, safeNow)])) as Record<MetricKey, ParsedValue[]>;
  const latestSource = chooseLatestSource(history, safeNow);
  const selectedGmvValues = latestSource ? values.paidOrderGmv.filter((value) => value.sourceKey === latestSource.sourceKey && value.observedAtMs > latestSource.segmentStartMs) : [];
  const selectedSpendValues = latestSource ? values.adSpend.filter((value) => value.sourceKey === latestSource.sourceKey && value.observedAtMs > latestSource.segmentStartMs) : [];
  const latestGmvAt = latestValueAt(selectedGmvValues);
  const latestSpendAt = latestValueAt(selectedSpendValues);
  const latestObservedAtMs = [latestGmvAt, latestSpendAt].flatMap((value) => value === undefined ? [] : [value]).sort((left, right) => right - left)[0];
  const staleMetricKeys = METRIC_KEYS.filter((key) => {
    const latest = latestValueAt(key === "paidOrderGmv" ? selectedGmvValues : selectedSpendValues);
    return latest !== undefined && safeNow - latest > WORKBENCH_TREND_STALE_AFTER_MS;
  });
  const selectedGmv = latestSource ? deltasForSegment(values.paidOrderGmv, latestSource.sourceKey, latestSource.segmentStartMs) : [];
  const selectedSpend = latestSource ? deltasForSegment(values.adSpend, latestSource.sourceKey, latestSource.segmentStartMs) : [];
  const pointsByTime = new Map<number, WorkbenchTrendPoint>();
  for (const point of selectedGmv) {
    if (Date.parse(point.startObservedAt) < windowStartMs || point.observedAtMs > safeNow) continue;
    pointsByTime.set(point.observedAtMs, { observedAt: point.observedAt, observedAtMs: point.observedAtMs, gmvYuan: point.value, gmvStartObservedAt: point.startObservedAt, gmvIntervalSeconds: point.intervalSeconds });
  }
  for (const point of selectedSpend) {
    if (Date.parse(point.startObservedAt) < windowStartMs || point.observedAtMs > safeNow) continue;
    const existing = pointsByTime.get(point.observedAtMs);
    pointsByTime.set(point.observedAtMs, existing ? { ...existing, spendYuan: point.value, spendStartObservedAt: point.startObservedAt, spendIntervalSeconds: point.intervalSeconds } : { observedAt: point.observedAt, observedAtMs: point.observedAtMs, spendYuan: point.value, spendStartObservedAt: point.startObservedAt, spendIntervalSeconds: point.intervalSeconds });
  }
  const points = [...pointsByTime.values()].sort((left, right) => left.observedAtMs - right.observedAtMs);
  const observedValues = points.flatMap((point) => [point.gmvYuan, point.spendYuan].filter((value): value is number => value !== undefined));
  const domainMaxYuan = Math.max(1, ...(observedValues.length ? observedValues : [0]));
  const reason = sourceNotFresh ? "source_not_fresh" : staleMetricKeys.length > 0 ? "stopped_over_90_seconds" : points.length > 0 ? "ready" : latestObservedAtMs === undefined ? "no_current_snapshot" : "waiting_for_same_source_minute";
  return {
    status: sourceNotFresh || staleMetricKeys.length > 0 ? "stopped" : points.length > 0 ? "ready" : "empty",
    reason,
    points,
    windowStartMs,
    windowEndMs: safeNow,
    domainMaxYuan,
    ...(latestObservedAtMs !== undefined ? { latestObservedAtMs } : {}),
    staleMetricKeys
  };
}

function formatYuan(value: number | undefined): string {
  return value === undefined ? "—" : `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(timestampMs);
}

function linePath(points: WorkbenchTrendPoint[], valueKey: "spendYuan" | "gmvYuan", xFor: (timestampMs: number) => number, yFor: (value: number) => number): string {
  let path = "";
  let previousTimestamp: number | undefined;
  for (const point of points) {
    const value = point[valueKey];
    if (value === undefined) {
      previousTimestamp = undefined;
      continue;
    }
    const command = previousTimestamp !== undefined && point.observedAtMs - previousTimestamp <= WORKBENCH_TREND_MAX_INTERVAL_MS ? "L" : "M";
    path += `${command}${xFor(point.observedAtMs).toFixed(2)},${yFor(value).toFixed(2)} `;
    previousTimestamp = point.observedAtMs;
  }
  return path.trim();
}

function statusText(model: WorkbenchTrendModel): string {
  if (model.status === "stopped") return "已停更";
  if (model.status === "ready") return "已更新";
  return "等待同源完整分钟";
}

function pointLabel(point: WorkbenchTrendPoint): string {
  return `${formatTime(point.observedAtMs)}，成交 GMV ${formatYuan(point.gmvYuan)}，消耗 ${formatYuan(point.spendYuan)}`;
}

export default function WorkbenchTrend({ history, nowMs }: WorkbenchTrendProps) {
  const model = buildWorkbenchTrendModel(history, nowMs);
  const [activeAt, setActiveAt] = useState<number | null>(null);
  const width = 760;
  const height = 280;
  const margin = { top: 22, right: 18, bottom: 42, left: 64 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const xFor = (timestampMs: number) => margin.left + ((timestampMs - model.windowStartMs) / WORKBENCH_TREND_WINDOW_MS) * plotWidth;
  const yFor = (value: number) => margin.top + plotHeight - (value / model.domainMaxYuan) * plotHeight;
  const activePoint = activeAt === null ? undefined : model.points.find((point) => point.observedAtMs === activeAt);
  const ticks = [0, 5, 10, 15].map((minute) => model.windowStartMs + minute * 60_000);
  const barWidth = Math.min(26, Math.max(8, plotWidth / Math.max(14, model.points.length * 1.6)));
  const spendPath = linePath(model.points, "spendYuan", xFor, yFor);

  return <section className="workbench-trend" aria-labelledby="workbench-trend-title">
    <header className="workbench-trend__header">
      <div>
        <p className="workbench-trend__eyebrow">千川 · 同源走势</p>
        <h2 id="workbench-trend-title">近 15 分钟成交与消耗</h2>
        <p className="workbench-trend__subtitle">每个点约 1 分钟；缺数据处留空，成交与消耗均为千川口径。</p>
      </div>
      <span className={`workbench-trend__status is-${model.status}`} aria-live="polite"><i aria-hidden="true" />{statusText(model)}</span>
    </header>

    {model.status === "stopped" && <p className="workbench-trend__notice" role="status">{model.reason === "source_not_fresh" ? "来源尚未恢复正常更新" : "最新字段已超过 90 秒未更新"}；图中保留最近 15 分钟已计算的增量，不代表当前值。</p>}
    {model.points.length === 0 && <div className="workbench-trend__empty" role="status"><strong>累计满一个有效分钟后显示走势。</strong><span>当前没有可核对的同源增量，缺档处保持留空。</span></div>}

    {model.points.length > 0 && <div className="workbench-trend__visual">
      <div className="workbench-trend__legend" aria-label="图例"><span><i className="is-gmv" />成交 GMV（柱）</span><span><i className="is-spend" />消耗（线）</span><small>单位：元</small></div>
      <div className="workbench-trend__chart-wrap">
        <svg className="workbench-trend__chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="近 15 分钟成交 GMV 柱状图和消耗折线图">
          {[0, 0.5, 1].map((ratio) => <g key={ratio}>
            <line x1={margin.left} x2={width - margin.right} y1={yFor(model.domainMaxYuan * ratio)} y2={yFor(model.domainMaxYuan * ratio)} className="workbench-trend__gridline" />
            <text x={margin.left - 10} y={yFor(model.domainMaxYuan * ratio) + 4} textAnchor="end" className="workbench-trend__axis-label">{formatYuan(model.domainMaxYuan * ratio)}</text>
          </g>)}
          <line x1={margin.left} x2={width - margin.right} y1={margin.top + plotHeight} y2={margin.top + plotHeight} className="workbench-trend__axis" />
          {ticks.map((timestampMs, index) => <g key={timestampMs}><line x1={xFor(timestampMs)} x2={xFor(timestampMs)} y1={margin.top} y2={margin.top + plotHeight} className="workbench-trend__tickline" /><text x={xFor(timestampMs)} y={height - 14} textAnchor={index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"} className="workbench-trend__axis-label">{formatTime(timestampMs)}</text></g>)}
          {model.points.map((point) => {
            const x = xFor(point.observedAtMs);
            const y = point.gmvYuan === undefined ? margin.top + plotHeight : yFor(point.gmvYuan);
            const barHeight = point.gmvYuan === undefined ? 0 : margin.top + plotHeight - y;
            return <g key={point.observedAtMs}>
              <rect x={x - barWidth / 2} y={y} width={barWidth} height={barHeight} className="workbench-trend__bar" aria-hidden="true" />
              <rect x={x - Math.max(barWidth, 18) / 2} y={margin.top} width={Math.max(barWidth, 18)} height={plotHeight} className="workbench-trend__hit" tabIndex={0} role="button" aria-label={pointLabel(point)} onMouseEnter={() => setActiveAt(point.observedAtMs)} onFocus={() => setActiveAt(point.observedAtMs)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveAt(point.observedAtMs); } }} />
            </g>;
          })}
          <path d={spendPath} className="workbench-trend__spend-line" fill="none" />
        </svg>
        {activePoint && <div className="workbench-trend__tooltip" style={{ left: `${Math.min(92, Math.max(8, ((xFor(activePoint.observedAtMs) - margin.left) / plotWidth) * 100))}%` }} role="status"><strong>{formatTime(activePoint.observedAtMs)}</strong><span>成交 GMV {formatYuan(activePoint.gmvYuan)}{activePoint.gmvIntervalSeconds === undefined ? "" : ` · ${activePoint.gmvIntervalSeconds}秒`}</span><span>消耗 {formatYuan(activePoint.spendYuan)}{activePoint.spendIntervalSeconds === undefined ? "" : ` · ${activePoint.spendIntervalSeconds}秒`}</span></div>}
      </div>
    </div>}

    {model.latestObservedAtMs !== undefined && <p className="workbench-trend__footnote">最近字段时间：{formatTime(model.latestObservedAtMs)}{model.status === "stopped" ? " · 仅作历史查看" : ""}</p>}
    <details className="workbench-trend__table-details">
      <summary>展开同数据表 <span>{model.points.length ? `${model.points.length} 个有效增量点` : "暂无有效增量点"}</span></summary>
      {model.points.length > 0 ? <div className="workbench-trend__table-scroll"><table><thead><tr><th scope="col">时间</th><th scope="col">成交 GMV / 窗口</th><th scope="col">消耗 / 窗口</th></tr></thead><tbody>{model.points.map((point) => <tr key={point.observedAtMs}><th scope="row">{formatTime(point.observedAtMs)}</th><td>{formatYuan(point.gmvYuan)}{point.gmvStartObservedAt ? <small> · {formatTime(Date.parse(point.gmvStartObservedAt))}—{formatTime(point.observedAtMs)}（{point.gmvIntervalSeconds}秒）</small> : null}</td><td>{formatYuan(point.spendYuan)}{point.spendStartObservedAt ? <small> · {formatTime(Date.parse(point.spendStartObservedAt))}—{formatTime(point.observedAtMs)}（{point.spendIntervalSeconds}秒）</small> : null}</td></tr>)}</tbody></table></div> : <p className="workbench-trend__table-empty">累计满一个有效分钟后显示走势。</p>}
    </details>
  </section>;
}
