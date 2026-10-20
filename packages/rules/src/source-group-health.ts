import type {
  LiveCompassMetricSnapshot,
  PageRuntimeState,
  QianchuanMetricSnapshot,
  SourceGroupHealth,
  SourceGroupId,
  SourceGroupStatus,
  SourceHealthReport,
  SourceOverallHealth
} from "@live-growth/contracts";

export const COMPASS_STALE_FLOOR_MS = 45_000;
export const QIANCHUAN_STALE_FLOOR_MS = 90_000;
export const AUDIO_STALE_FLOOR_MS = 10_000;
export const CADENCE_INTERVAL_LIMIT = 8;
export const MIN_CADENCE_INTERVALS = 3;
export const APPEARANCE_LIMIT = 16;

export const QIANCHUAN_GROUP_FIELDS = {
  spend: ["adSpend"],
  traffic: ["liveImpressions", "liveWatchCount", "onlineSnapshot"],
  interest: ["productImpressions", "productClicks"],
  conversion: ["paidOrderCount", "paidOrderGmv"],
  efficiency: ["roi", "gpm", "costPerPaidOrder", "watchToPaid", "productClickToPaid", "showToWatch", "watchToProductClick", "liveWatchToPaid"]
} as const;

export const COMPASS_GROUP_FIELDS = {
  core: [
    "onlineSnapshot", "sessionPaidGmvFen", "paidBuyerCount", "paidItemCount",
    "averageWatchDurationSec", "watchToPaidRate", "productClickToPaidRate",
    "adSpendFen", "roomEnterCount5m", "userPaidGmvFen5m"
  ],
  product: [
    "productName", "currentProductName", "productClickCount",
    "productPayGmvFen", "unpaidOrderCount", "productPaidGmvFen"
  ],
  audio: []
} as const;

export const QIANCHUAN_DIAGNOSIS_REQUIRED = ["spend", "traffic", "interest", "conversion"] as const;
export const COMPASS_DIAGNOSIS_REQUIRED = ["core", "product"] as const;
export const QIANCHUAN_BUSINESS_GROUPS = ["spend", "traffic", "interest", "conversion", "efficiency"] as const;

export const DIAGNOSIS_TRIGGER_GROUPS = {
  scheduled_15m: ["traffic", "interest", "conversion"],
  event_spend_spike: ["spend", "traffic"],
  event_traffic_drop: ["traffic"],
  event_click_no_pay: ["interest", "conversion"]
} as const;

export const INCOMPLETE_DIAGNOSIS_WHAT = "本窗数据不完整，暂不做经营判断。";
export const INCOMPLETE_QIANCHUAN_FUNNEL_WHY = "千川消耗仍在更新，但漏斗／成交数据已经停止。";
export const INCOMPLETE_COMPASS_PRODUCT_WHY = "罗盘经营仍在更新，但商品数据已经停止。";

export type DiagnosisTriggerGroupKey = keyof typeof DIAGNOSIS_TRIGGER_GROUPS;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function validTimes(values: readonly string[]): number[] {
  return values.map((item) => Date.parse(item)).filter((item) => Number.isFinite(item)).sort((left, right) => left - right);
}

export function cadenceIntervals(appearanceTimes: readonly string[]): number[] {
  const times = validTimes(appearanceTimes);
  const intervals: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const delta = times[index]! - times[index - 1]!;
    if (delta > 0) intervals.push(delta);
  }
  return intervals.slice(-CADENCE_INTERVAL_LIMIT);
}

export function expectedCadenceMs(appearanceTimes: readonly string[], floorMs: number): number {
  const recent = cadenceIntervals(appearanceTimes);
  if (recent.length < MIN_CADENCE_INTERVALS) return floorMs;
  return median(recent);
}

export function stallThresholdMs(floorMs: number, cadenceMs: number, sampleSufficient = cadenceMs !== floorMs): number {
  return sampleSufficient ? Math.max(floorMs, 2 * cadenceMs) : floorMs;
}

export function isHealthyGroupStatus(status: SourceGroupStatus): boolean {
  return status === "fresh" || status === "recovered";
}

export function isUnusableGroupStatus(status: SourceGroupStatus): boolean {
  return status === "stalled" || status === "login_required" || status === "offline";
}

export function pageAuxiliaryMustNotOverrideHeartbeat(input: {
  visibilityState?: "visible" | "hidden" | "prerender";
  hasFocus?: boolean;
  groupStatus: SourceGroupStatus;
}): SourceGroupStatus {
  void input.visibilityState;
  void input.hasFocus;
  return input.groupStatus;
}

export type EvaluateGroupHealthInput = {
  source: "qianchuan" | "compass";
  group: SourceGroupId;
  appearanceTimes: readonly string[];
  nowMs: number;
  floorMs: number;
  loginRequired?: boolean;
  offline?: boolean;
  recovering?: boolean;
  previousStatus?: SourceGroupStatus;
  lastRecoveredAt?: string;
  lastRecoveryAttemptAt?: string;
  recoveryAttempts?: number;
  presentFields?: readonly string[];
  expectedFields?: readonly string[];
  visibilityState?: "visible" | "hidden" | "prerender";
  hasFocus?: boolean;
};

export function evaluateGroupHealth(input: EvaluateGroupHealthInput): SourceGroupHealth {
  const recoveryAttempts = input.recoveryAttempts ?? 0;
  const missingFields = (input.expectedFields ?? []).filter((field) => !(input.presentFields ?? []).includes(field)).slice(0, 16);
  const base = {
    source: input.source,
    group: input.group,
    recoveryAttempts,
    missingFields
  };
  if (input.loginRequired) {
    return { ...base, status: "login_required", ...(input.lastRecoveryAttemptAt ? { lastRecoveryAttemptAt: input.lastRecoveryAttemptAt } : {}), ...(input.lastRecoveredAt ? { lastRecoveredAt: input.lastRecoveredAt } : {}) };
  }
  if (input.offline) {
    return { ...base, status: "offline", ...(input.lastRecoveryAttemptAt ? { lastRecoveryAttemptAt: input.lastRecoveryAttemptAt } : {}), ...(input.lastRecoveredAt ? { lastRecoveredAt: input.lastRecoveredAt } : {}) };
  }
  const times = validTimes(input.appearanceTimes);
  if (!times.length) {
    return { ...base, status: "unknown", ...(input.lastRecoveryAttemptAt ? { lastRecoveryAttemptAt: input.lastRecoveryAttemptAt } : {}), ...(input.lastRecoveredAt ? { lastRecoveredAt: input.lastRecoveredAt } : {}) };
  }
  const lastSeenMs = times[times.length - 1]!;
  const lastSeenAt = new Date(lastSeenMs).toISOString();
  const sampleSufficient = cadenceIntervals(input.appearanceTimes).length >= MIN_CADENCE_INTERVALS;
  const cadence = expectedCadenceMs(input.appearanceTimes, input.floorMs);
  const threshold = stallThresholdMs(input.floorMs, cadence, sampleSufficient);
  const age = Math.max(0, input.nowMs - lastSeenMs);
  const extras = {
    lastSeenAt,
    expectedCadenceMs: Math.round(cadence),
    ...(input.lastRecoveryAttemptAt ? { lastRecoveryAttemptAt: input.lastRecoveryAttemptAt } : {}),
    ...(input.lastRecoveredAt ? { lastRecoveredAt: input.lastRecoveredAt } : {})
  };
  const previousUnhealthy = input.previousStatus === "stalled" || input.previousStatus === "suspected_stall" || input.previousStatus === "recovering";
  if (age <= threshold) {
    const status = pageAuxiliaryMustNotOverrideHeartbeat({
      groupStatus: input.recovering || previousUnhealthy ? "recovered" : "fresh",
      ...(input.visibilityState ? { visibilityState: input.visibilityState } : {}),
      ...(input.hasFocus !== undefined ? { hasFocus: input.hasFocus } : {})
    });
    return {
      ...base,
      ...extras,
      status,
      ...(status === "recovered" ? { lastRecoveredAt: new Date(input.nowMs).toISOString() } : {})
    };
  }
  if (!sampleSufficient) {
    return { ...base, ...extras, status: "unknown" };
  }
  if (input.recovering) {
    return { ...base, ...extras, status: "recovering", suspectedAt: new Date(lastSeenMs + threshold).toISOString() };
  }
  if (age <= threshold + cadence) {
    return { ...base, ...extras, status: "suspected_stall", suspectedAt: new Date(lastSeenMs + threshold).toISOString() };
  }
  return {
    ...base,
    ...extras,
    status: "stalled",
    suspectedAt: new Date(lastSeenMs + threshold).toISOString(),
    stalledAt: new Date(lastSeenMs + threshold + cadence).toISOString()
  };
}

export function evaluateOverallHealth(input: {
  groups: readonly SourceGroupHealth[];
  diagnosisRequired: readonly string[];
  loginRequired?: boolean;
  offline?: boolean;
}): SourceOverallHealth {
  if (input.loginRequired) return "login_required";
  if (input.offline) return "offline";
  const required = input.groups.filter((item) => input.diagnosisRequired.includes(item.group) && item.status !== "unknown");
  const business = input.groups.filter((item) => item.group !== "audio" && item.status !== "unknown");
  if (required.length > 0 && required.every((item) => isHealthyGroupStatus(item.status))) return "fresh";
  const anyFresh = input.groups.some((item) => item.group !== "audio" && isHealthyGroupStatus(item.status));
  const anyRequiredStalled = required.some((item) => item.status === "stalled");
  if (anyFresh && anyRequiredStalled) return "partial";
  if (business.length > 0 && business.every((item) => item.status === "stalled")) return "stalled";
  return "unknown";
}

export function compatibleSourceStatus(
  overall: SourceOverallHealth,
  lastAnyAt: string | undefined,
  nowMs: number,
  floorMs: number
): "fresh" | "stale" | "offline" | "unknown" | "partial" {
  if (overall === "login_required" || overall === "offline") return "offline";
  if (overall === "fresh") return "fresh";
  if (overall === "partial") return "partial";
  if (overall === "stalled") return "stale";
  if (!lastAnyAt) return "unknown";
  return nowMs - Date.parse(lastAnyAt) > floorMs ? "stale" : "fresh";
}

export function appendAppearance(times: readonly string[], observedAt: string, limit = APPEARANCE_LIMIT): string[] {
  const next = [...times, observedAt].filter((item) => Number.isFinite(Date.parse(item))).sort();
  return next.slice(-limit);
}

export function appearancesFromQianchuanSnapshots(snapshots: readonly QianchuanMetricSnapshot[]): Record<(typeof QIANCHUAN_BUSINESS_GROUPS)[number], string[]> {
  const store: Record<(typeof QIANCHUAN_BUSINESS_GROUPS)[number], string[]> = {
    spend: [], traffic: [], interest: [], conversion: [], efficiency: []
  };
  for (const snapshot of snapshots) {
    for (const group of QIANCHUAN_BUSINESS_GROUPS) {
      const present = QIANCHUAN_GROUP_FIELDS[group].some((field) => snapshot.metrics[field as keyof typeof snapshot.metrics] !== undefined);
      if (present) store[group] = appendAppearance(store[group], snapshot.observedAt);
    }
  }
  return store;
}

export function appearancesFromCompassSnapshots(snapshots: readonly LiveCompassMetricSnapshot[]): Record<"core" | "product", string[]> {
  const store: Record<"core" | "product", string[]> = { core: [], product: [] };
  for (const snapshot of snapshots) {
    for (const group of ["core", "product"] as const) {
      const present = COMPASS_GROUP_FIELDS[group].some((field) => snapshot[field as keyof LiveCompassMetricSnapshot] !== undefined);
      if (present) store[group] = appendAppearance(store[group], snapshot.observedAt);
    }
  }
  return store;
}

export function presentQianchuanFields(snapshot: QianchuanMetricSnapshot | undefined, group: keyof typeof QIANCHUAN_GROUP_FIELDS): string[] {
  if (!snapshot) return [];
  return QIANCHUAN_GROUP_FIELDS[group].filter((field) => snapshot.metrics[field as keyof typeof snapshot.metrics] !== undefined);
}

export function presentCompassFields(snapshot: LiveCompassMetricSnapshot | undefined, group: keyof typeof COMPASS_GROUP_FIELDS): string[] {
  if (!snapshot) return [];
  return COMPASS_GROUP_FIELDS[group].filter((field) => snapshot[field as keyof LiveCompassMetricSnapshot] !== undefined);
}

export function stalledTriggerGroups(
  trigger: DiagnosisTriggerGroupKey,
  groups: readonly SourceGroupHealth[] | undefined
): SourceGroupId[] {
  if (!groups) return [];
  const required = DIAGNOSIS_TRIGGER_GROUPS[trigger];
  return groups
    .filter((item) => (required as readonly string[]).includes(item.group) && isUnusableGroupStatus(item.status))
    .map((item) => item.group);
}

export function incompleteDiagnosisCopy(stalledGroups: readonly string[]): { what: string; why: string } {
  const qianchuanFunnel = stalledGroups.some((group) => group === "traffic" || group === "interest" || group === "conversion");
  const product = stalledGroups.includes("product");
  if (product && !qianchuanFunnel) {
    return { what: INCOMPLETE_DIAGNOSIS_WHAT, why: INCOMPLETE_COMPASS_PRODUCT_WHY };
  }
  if (qianchuanFunnel && product) {
    return { what: INCOMPLETE_DIAGNOSIS_WHAT, why: "罗盘商品数据与千川漏斗／成交已经停止。" };
  }
  return { what: INCOMPLETE_DIAGNOSIS_WHAT, why: INCOMPLETE_QIANCHUAN_FUNNEL_WHY };
}

export function previousGroupStatus(previous: readonly SourceGroupHealth[] | undefined, source: "qianchuan" | "compass", group: SourceGroupId): SourceGroupStatus | undefined {
  return previous?.find((item) => item.source === source && item.group === group)?.status;
}

export function buildSourceHealthFromSnapshots(input: {
  qianchuanSnapshots: readonly QianchuanMetricSnapshot[];
  compassSnapshots: readonly LiveCompassMetricSnapshot[];
  nowMs: number;
  audioAppearances?: readonly string[];
  pageRuntime?: { qianchuan?: PageRuntimeState; compass?: PageRuntimeState };
  previousGroups?: readonly SourceGroupHealth[];
  recovering?: boolean;
  lastRecoveredAt?: string;
  lastRecoveryAttemptAt?: string;
  recoveryAttempts?: number;
}): SourceHealthReport {
  const qianchuanLogin = input.pageRuntime?.qianchuan?.allowlistStatus === "login";
  const compassLogin = input.pageRuntime?.compass?.allowlistStatus === "login";
  const qianchuanOffline = input.pageRuntime?.qianchuan?.navigatorOnline === false;
  const compassOffline = input.pageRuntime?.compass?.navigatorOnline === false;
  const qianchuanAppearances = appearancesFromQianchuanSnapshots(input.qianchuanSnapshots);
  const compassAppearances = appearancesFromCompassSnapshots(input.compassSnapshots);
  const latestQianchuan = [...input.qianchuanSnapshots].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)).at(-1);
  const latestCompass = [...input.compassSnapshots].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)).at(-1);
  const qianchuanGroups = QIANCHUAN_BUSINESS_GROUPS.map((group) => {
    const previousStatus = previousGroupStatus(input.previousGroups, "qianchuan", group);
    return evaluateGroupHealth({
      source: "qianchuan",
      group,
      appearanceTimes: qianchuanAppearances[group],
      nowMs: input.nowMs,
      floorMs: QIANCHUAN_STALE_FLOOR_MS,
      loginRequired: qianchuanLogin,
      offline: qianchuanOffline,
      presentFields: presentQianchuanFields(latestQianchuan, group),
      expectedFields: QIANCHUAN_GROUP_FIELDS[group],
      ...(input.recovering === true && input.previousGroups?.some((item) => item.source === "qianchuan") ? { recovering: true } : {}),
      ...(previousStatus ? { previousStatus } : {}),
      ...(input.lastRecoveredAt ? { lastRecoveredAt: input.lastRecoveredAt } : {}),
      ...(input.lastRecoveryAttemptAt ? { lastRecoveryAttemptAt: input.lastRecoveryAttemptAt } : {}),
      ...(input.recoveryAttempts !== undefined ? { recoveryAttempts: input.recoveryAttempts } : {}),
      ...(input.pageRuntime?.qianchuan?.visibilityState ? { visibilityState: input.pageRuntime.qianchuan.visibilityState } : {}),
      ...(input.pageRuntime?.qianchuan?.hasFocus !== undefined ? { hasFocus: input.pageRuntime.qianchuan.hasFocus } : {})
    });
  });
  const compassBusiness = (["core", "product"] as const).map((group) => {
    const previousStatus = previousGroupStatus(input.previousGroups, "compass", group);
    return evaluateGroupHealth({
      source: "compass",
      group,
      appearanceTimes: compassAppearances[group],
      nowMs: input.nowMs,
      floorMs: COMPASS_STALE_FLOOR_MS,
      loginRequired: compassLogin,
      offline: compassOffline,
      presentFields: presentCompassFields(latestCompass, group),
      expectedFields: COMPASS_GROUP_FIELDS[group],
      ...(input.recovering === true && input.previousGroups?.some((item) => item.source === "compass") ? { recovering: true } : {}),
      ...(previousStatus ? { previousStatus } : {}),
      ...(input.lastRecoveredAt ? { lastRecoveredAt: input.lastRecoveredAt } : {}),
      ...(input.lastRecoveryAttemptAt ? { lastRecoveryAttemptAt: input.lastRecoveryAttemptAt } : {}),
      ...(input.recoveryAttempts !== undefined ? { recoveryAttempts: input.recoveryAttempts } : {}),
      ...(input.pageRuntime?.compass?.visibilityState ? { visibilityState: input.pageRuntime.compass.visibilityState } : {}),
      ...(input.pageRuntime?.compass?.hasFocus !== undefined ? { hasFocus: input.pageRuntime.compass.hasFocus } : {})
    });
  });
  const audioPrevious = previousGroupStatus(input.previousGroups, "compass", "audio");
  const audio = evaluateGroupHealth({
    source: "compass",
    group: "audio",
    appearanceTimes: input.audioAppearances ?? [],
    nowMs: input.nowMs,
    floorMs: AUDIO_STALE_FLOOR_MS,
    loginRequired: compassLogin,
    offline: compassOffline,
    ...(audioPrevious ? { previousStatus: audioPrevious } : {}),
    ...(input.lastRecoveredAt ? { lastRecoveredAt: input.lastRecoveredAt } : {}),
    ...(input.lastRecoveryAttemptAt ? { lastRecoveryAttemptAt: input.lastRecoveryAttemptAt } : {}),
    ...(input.recoveryAttempts !== undefined ? { recoveryAttempts: input.recoveryAttempts } : {})
  });
  return {
    qianchuan: {
      overallHealth: evaluateOverallHealth({
        groups: qianchuanGroups,
        diagnosisRequired: QIANCHUAN_DIAGNOSIS_REQUIRED,
        loginRequired: qianchuanLogin,
        offline: qianchuanOffline
      }),
      groups: qianchuanGroups
    },
    compass: {
      overallHealth: evaluateOverallHealth({
        groups: compassBusiness,
        diagnosisRequired: COMPASS_DIAGNOSIS_REQUIRED,
        loginRequired: compassLogin,
        offline: compassOffline
      }),
      groups: [...compassBusiness, audio]
    }
  };
}
