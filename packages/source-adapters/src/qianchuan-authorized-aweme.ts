/** 官方授权抖音号：展示号不能直接当 aweme_id / today_live 参数发出去。 */

export const QIANCHUAN_AUTHORIZED_AWEME_ENDPOINT = "/open_api/v1.0/qianchuan/uni_aweme/authorized/get/";
export const QIANCHUAN_UINT64_MAX = BigInt("18446744073709551615");

export type LiveAuthorizedAwemeIndex = {
  lookup: Map<string, string>;
  authorizedIds: Set<string>;
};

export function parseQianchuanJson(raw: string): unknown {
  const losslessIds = raw.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, "$1\"$2\"");
  return JSON.parse(losslessIds) as unknown;
}

export function textValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    const text = String(value).trim();
    return text || null;
  }
  return null;
}

export function normalizeAuthorizedAwemeId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("QIANCHUAN_LIVE_ANCHOR_AUTHORIZED_ID_INVALID");
    return String(value);
  }
  const id = typeof value === "bigint" ? value.toString() : typeof value === "string" ? value.trim() : "";
  if (!/^[1-9]\d*$/.test(id)) throw new Error("QIANCHUAN_LIVE_ANCHOR_AUTHORIZED_ID_INVALID");
  try {
    if (BigInt(id) > QIANCHUAN_UINT64_MAX) throw new Error("QIANCHUAN_LIVE_ANCHOR_AUTHORIZED_ID_INVALID");
  } catch {
    throw new Error("QIANCHUAN_LIVE_ANCHOR_AUTHORIZED_ID_INVALID");
  }
  return id;
}

export function buildLiveAuthorizedAwemeIndex(rows: unknown[]): LiveAuthorizedAwemeIndex {
  const lookup = new Map<string, string>();
  const authorizedIds = new Set<string>();
  const register = (key: string, awemeId: string) => {
    const existing = lookup.get(key);
    if (existing && existing !== awemeId) throw new Error("QIANCHUAN_LIVE_ANCHOR_MAPPING_AMBIGUOUS");
    lookup.set(key, awemeId);
  };
  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const rawAwemeId = row.aweme_id ?? row.awemeId;
    const rawShowId = row.aweme_show_id ?? row.awemeShowId;
    if (rawAwemeId === undefined && rawShowId === undefined) continue;
    const awemeId = normalizeAuthorizedAwemeId(rawAwemeId);
    authorizedIds.add(awemeId);
    register(awemeId, awemeId);
    const showId = textValue(rawShowId);
    if (showId) register(showId, awemeId);
  }
  return { lookup, authorizedIds };
}

export function normalizeLiveAnchorId(value: unknown, index: LiveAuthorizedAwemeIndex): string {
  const reference = textValue(value);
  if (!reference) throw new Error("QIANCHUAN_LIVE_ANCHOR_REFERENCE_MISSING");
  const normalized = index.lookup.get(reference);
  if (normalized) return normalized;
  if (/^[1-9]\d*$/.test(reference)) throw new Error("QIANCHUAN_LIVE_ANCHOR_UNAUTHORIZED_ID");
  throw new Error("QIANCHUAN_LIVE_ANCHOR_UNKNOWN_SHOW_ID");
}

export function authorizedAwemeRows(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const rowLike = (value: unknown) => Boolean(value && typeof value === "object" && !Array.isArray(value) && (
    (value as Record<string, unknown>).aweme_id !== undefined
    || (value as Record<string, unknown>).awemeId !== undefined
    || (value as Record<string, unknown>).aweme_show_id !== undefined
    || (value as Record<string, unknown>).awemeShowId !== undefined
  ));
  const visited = new Set<unknown>();
  const visit = (value: unknown): unknown[] => {
    if (!value || typeof value !== "object" || visited.has(value)) return [];
    visited.add(value);
    if (Array.isArray(value)) return value.some(rowLike) ? value : [];
    const record = value as Record<string, unknown>;
    for (const key of ["aweme_id_list", "aweme_list", "aweme_infos", "aweme_info_list", "list", "data"]) {
      const found = visit(record[key]);
      if (found.length) return found;
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found.length) return found;
    }
    return [];
  };
  return visit(data);
}

export function authorizedAwemePageHasMore(data: unknown, rows: unknown[], page: number, pageSize = 100): boolean {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const pageInfo = record.page_info && typeof record.page_info === "object" ? record.page_info as Record<string, unknown> : {};
  const totalPage = Number(pageInfo.total_page || record.total_page || 0);
  if (Number.isFinite(totalPage) && totalPage > 0) return page < totalPage;
  const totalNumber = Number(pageInfo.total_number || record.total_number || 0);
  const size = Number(pageInfo.page_size || record.page_size || pageSize);
  if (Number.isFinite(totalNumber) && totalNumber > 0 && Number.isFinite(size) && size > 0) return page * size < totalNumber;
  return rows.length >= pageSize;
}
