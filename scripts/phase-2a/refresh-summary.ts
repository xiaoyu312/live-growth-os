export interface RefreshIntervalSummary {
  count: number;
  min: number;
  median: number;
  max: number;
}

export interface CadenceObservation {
  kind?: string;
  phase?: string;
  origin?: string;
  pathname?: string;
  observedAt?: string;
  fields?: Array<{ path?: string }>;
}

export function summarizeIntervals(timestamps: string[]): RefreshIntervalSummary | null {
  const sorted = timestamps.map((value) => Date.parse(value)).filter(Number.isFinite).sort((left, right) => left - right);
  const intervals = sorted.slice(1).map((value, index) => value - sorted[index]!).filter((value) => value > 0).sort((left, right) => left - right);
  if (intervals.length === 0) return null;
  return { count: sorted.length, min: intervals[0]!, median: intervals[Math.floor(intervals.length / 2)]!, max: intervals.at(-1)! };
}

export function cadenceGroups(network: CadenceObservation[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const item of network) {
    if (item.kind !== "http" || typeof item.origin !== "string" || typeof item.pathname !== "string" || typeof item.observedAt !== "string") continue;
    const fieldPaths = item.phase === "body_shape" ? item.fields?.map((field) => field.path).filter((path): path is string => typeof path === "string" && path.length > 0) ?? [] : [];
    const summaryKeys = item.phase === "request_start" ? ["<endpoint>"] : fieldPaths;
    for (const fieldPath of summaryKeys) {
      const key = `${item.origin}${item.pathname} · ${fieldPath}`;
      const values = groups.get(key) ?? [];
      values.push(item.observedAt);
      groups.set(key, values);
    }
  }
  return groups;
}
