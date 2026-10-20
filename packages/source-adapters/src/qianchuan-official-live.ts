import {
  qianchuanMetricSnapshotSchema,
  type QianchuanMetricSnapshot,
  type QianchuanMetricValue
} from "@live-growth/contracts";

export {
  QIANCHUAN_AUTHORIZED_AWEME_ENDPOINT,
  authorizedAwemePageHasMore,
  authorizedAwemeRows,
  buildLiveAuthorizedAwemeIndex,
  normalizeAuthorizedAwemeId,
  normalizeLiveAnchorId,
  parseQianchuanJson
} from "./qianchuan-authorized-aweme";
export type { LiveAuthorizedAwemeIndex } from "./qianchuan-authorized-aweme";

/** 巨量引擎官方“今日直播间”接口，不是千川网页的 statQuery。 */
export const QIANCHUAN_OFFICIAL_LIVE_ENDPOINT = "/open_api/v1.0/qianchuan/today_live/room/get/";
export const QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION = "qianchuan-official-live-v1";

/**
 * 这些字段由官方接口直接返回整场累计值。字段列表同时用于请求和审计，
 * 不把日级素材报表字段混入实时直播间来源。
 */
export const QIANCHUAN_OFFICIAL_LIVE_REQUEST_FIELDS = [
  "qualification_stat_cost", "stat_cost",
  "live_pay_order_gmv_alias", "live_pay_order_count_alias",
  "live_click_product_count_alias", "total_live_watch_cnt",
  "total_live_pay_order_gpm", "live_pay_order_gmv_roi"
] as const;

/**
 * Optional platform-level live fields. They are kept separate from the
 * original request list so an unsupported optional field can be removed
 * without making the seven-field base snapshot unavailable.
 */
export const QIANCHUAN_OFFICIAL_LIVE_OPTIONAL_REQUEST_FIELDS = [
  "cpm_platform", "ctr", "convert_rate", "total_live_comment_cnt",
  "total_live_follow_cnt", "total_live_fans_club_join_cnt", "total_live_share_cnt",
  "live_pay_order_gmv_avg"
] as const;
export const QIANCHUAN_OFFICIAL_LIVE_EXTENDED_REQUEST_FIELDS = [
  ...QIANCHUAN_OFFICIAL_LIVE_REQUEST_FIELDS,
  ...QIANCHUAN_OFFICIAL_LIVE_OPTIONAL_REQUEST_FIELDS
] as const;

/** 这三列由接口固定返回，不应放进 fields 指标请求参数。 */
export const QIANCHUAN_OFFICIAL_LIVE_RESPONSE_METADATA_FIELDS = ["room_id", "room_status", "start_time"] as const;
export const QIANCHUAN_OFFICIAL_LIVE_FIELDS = QIANCHUAN_OFFICIAL_LIVE_REQUEST_FIELDS;

export type QianchuanOfficialLiveResponse = {
  endpoint?: string;
  observedAt: string;
  body: unknown;
};

type JsonRecord = Record<string, unknown>;
type MetricName = keyof QianchuanMetricSnapshot["metrics"];
type OfficialRoom = JsonRecord;

type FieldDefinition = {
  name: MetricName;
  unit: QianchuanMetricValue["unit"];
  semantic: QianchuanMetricValue["semantic"];
  integer?: true;
};

const FIELD_DEFINITIONS: Record<string, FieldDefinition> = {
  qualification_stat_cost: { name: "adSpend", unit: "元", semantic: "cumulative" },
  stat_cost: { name: "adSpend", unit: "元", semantic: "cumulative" },
  live_pay_order_gmv_alias: { name: "paidOrderGmv", unit: "元", semantic: "cumulative" },
  live_pay_order_count_alias: { name: "paidOrderCount", unit: "单", semantic: "cumulative", integer: true },
  live_click_product_count_alias: { name: "productClicks", unit: "次", semantic: "cumulative", integer: true },
  total_live_watch_cnt: { name: "liveWatchCount", unit: "次", semantic: "cumulative", integer: true },
  total_live_pay_order_gpm: { name: "gpm", unit: "元", semantic: "rolling" },
  live_pay_order_gmv_roi: { name: "roi", unit: "unknown", semantic: "rolling" },
  cpm_platform: { name: "cpmPlatform", unit: "元", semantic: "rolling" },
  ctr: { name: "platformCtr", unit: "%", semantic: "rate" },
  convert_rate: { name: "platformConvertRate", unit: "%", semantic: "rate" },
  total_live_comment_cnt: { name: "commentCount", unit: "次", semantic: "cumulative", integer: true },
  total_live_follow_cnt: { name: "followCount", unit: "次", semantic: "cumulative", integer: true },
  total_live_fans_club_join_cnt: { name: "fansClubJoinCount", unit: "次", semantic: "cumulative", integer: true },
  total_live_share_cnt: { name: "shareCount", unit: "次", semantic: "cumulative", integer: true },
  live_pay_order_gmv_avg: { name: "payOrderAverage", unit: "元", semantic: "rolling" }
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function roomStatus(room: OfficialRoom): string | undefined {
  const value = room.room_status ?? room.roomStatus;
  return typeof value === "string" ? value.trim().toUpperCase() : undefined;
}

function roomStartTime(room: OfficialRoom): number {
  const value = room.start_time ?? room.startTime;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  return Number.NEGATIVE_INFINITY;
}

function roomId(room: OfficialRoom): string | undefined {
  const value = room.room_id ?? room.roomId;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function safeRoomStartIso(milliseconds: number): string | undefined {
  // ECMAScript Date's valid range is finite; guard before toISOString(),
  // which throws RangeError for values outside that range.
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 8.64e15) return undefined;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return undefined;
  try {
    return date.toISOString();
  } catch {
    return undefined;
  }
}

function roomStartedAt(room: OfficialRoom): string | undefined {
  const value = room.start_time ?? room.startTime;
  let milliseconds: number | undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    milliseconds = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const numeric = Number(text);
      if (Number.isFinite(numeric) && numeric > 0) milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
    } else if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) milliseconds = parsed;
    }
  }
  return milliseconds === undefined ? undefined : safeRoomStartIso(milliseconds);
}

function roomList(body: unknown): OfficialRoom[] {
  const root = asRecord(body);
  const data = asRecord(root?.data);
  const list = data?.room_list ?? data?.roomList;
  return Array.isArray(list) ? list.flatMap((value) => {
    const record = asRecord(value);
    return record ? [record] : [];
  }) : [];
}

function metricValue(room: OfficialRoom, field: string): number | undefined {
  const value = finiteNonNegative(room[field]);
  const definition = FIELD_DEFINITIONS[field];
  if (value === undefined || (definition?.integer && !Number.isInteger(value))) return undefined;
  return value;
}

function metricFromField(room: OfficialRoom, field: string): QianchuanMetricValue | undefined {
  const definition = FIELD_DEFINITIONS[field];
  if (!definition) return undefined;
  const value = metricValue(room, field);
  if (value === undefined) return undefined;
  return { value, unit: definition.unit, semantic: definition.semantic, sourceField: field };
}

function chooseRoom(rooms: OfficialRoom[]): OfficialRoom | undefined {
  const living = rooms.filter((room) => roomStatus(room) === "LIVING");
  if (living.length === 0) return undefined;
  return living.slice().sort((left, right) => roomStartTime(right) - roomStartTime(left))[0];
}

/**
 * 解析官方 today_live/room/get 响应，只取 LIVING 且 start_time 最新的一行。
 * 负数、非法数字和缺失字段均保持缺失；绝不把“没有直播间”变成 0 快照。
 */
export function parseQianchuanOfficialLiveResponse(input: QianchuanOfficialLiveResponse): QianchuanMetricSnapshot | null {
  if (input.endpoint && input.endpoint !== QIANCHUAN_OFFICIAL_LIVE_ENDPOINT) return null;
  const room = chooseRoom(roomList(input.body));
  if (!room) return null;

  const metrics = new Map<MetricName, QianchuanMetricValue>();
  for (const field of Object.keys(FIELD_DEFINITIONS)) {
    const metric = metricFromField(room, field);
    if (!metric) continue;
    const definition = FIELD_DEFINITIONS[field];
    if (!definition) continue;
    const previous = metrics.get(definition.name);
    // 结算消耗优先于普通消耗；如果只有普通消耗则照实保留。
    if (!previous || (definition.name === "adSpend" && field === "qualification_stat_cost" && previous.sourceField === "stat_cost")) {
      metrics.set(definition.name, metric);
    }
  }
  if (metrics.size === 0) return null;
  const selectedRoomId = roomId(room);
  const selectedRoomStartedAt = roomStartedAt(room);
  return qianchuanMetricSnapshotSchema.parse({
    observedAt: input.observedAt,
    sourceEndpoint: QIANCHUAN_OFFICIAL_LIVE_ENDPOINT,
    mappingVersion: QIANCHUAN_OFFICIAL_LIVE_MAPPING_VERSION,
    dataStatus: "fresh",
    metricSource: "qianchuan",
    ...(selectedRoomId ? { roomId: selectedRoomId } : {}),
    ...(selectedRoomStartedAt ? { roomStartedAt: selectedRoomStartedAt } : {}),
    metrics: Object.fromEntries(metrics)
  });
}
