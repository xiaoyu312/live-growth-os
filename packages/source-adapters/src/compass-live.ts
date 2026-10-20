import { liveCompassMetricSnapshotSchema, type LiveCompassMetricSnapshot } from "@live-growth/contracts";

export const COMPASS_LIVE_MAPPING_VERSION = "compass-live-v1";
export const COMPASS_LIVE_ORIGIN = "https://compass.jinritemai.com";
export const COMPASS_LIVE_WS_ORIGIN = "wss://compass.jinritemai.com";
export const COMPASS_LIVE_ENDPOINTS = {
  coreData: "/compass_api/shop/live/live_screen/core_data",
  fiveMinuteData: "/compass_api/content_live/shop/live_screen/five_min_data",
  liveBaseInfo: "/compass_api/shop/live/live_screen/live_base_info",
  product: "/compass_api/shop/live/live_screen/product",
  productExplainDetail: "/compass_api/shop/live/live_screen/product_explain_detail",
  /** Safe local marker for a bounded, allowlisted DOM KPI fallback. */
  domFallback: "/dom/fallback"
} as const;

export type CompassLiveResponse = {
  origin: string;
  endpoint: string;
  body: unknown;
  observedAt: string;
};

export type CompassLiveJsonResponse = CompassLiveResponse;

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "-") return 0;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  }
  return undefined;
}
function valueAt(root: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === "number") current = current[key];
    else if (current !== null && typeof current === "object") current = (current as JsonRecord)[String(key)];
    else return undefined;
  }
  return current;
}
function moneyFen(value: unknown, unit: unknown): number | undefined {
  const parsed = number(value);
  if (parsed === undefined) return undefined;
  if (unit === "分" || unit === "price" || unit === "priceV2") return Math.round(parsed);
  if (unit === "元") return Math.round(parsed * 100);
  return undefined;
}
function merge(target: Partial<LiveCompassMetricSnapshot>, field: keyof LiveCompassMetricSnapshot, value: unknown): void {
  if (value !== undefined) (target as Record<string, unknown>)[field] = value;
}

type ConfirmedSemantic = "onlineSnapshot" | "roomEnterCount5m" | "userPaidGmvFen5m" | "productClickCount" | "productPayGmvFen" | "unpaidOrderCount" | "sessionPaidGmvFen" | "adSpendFen" | "paidBuyerCount" | "paidItemCount" | "watchToPaidRate" | "productClickToPaidRate" | "averageWatchDurationSec";
const FIVE_MINUTE_LABELS: Record<string, ConfirmedSemantic> = {
  "实时在线人数": "onlineSnapshot",
  "在线人数": "onlineSnapshot",
  "直播间进入人数": "roomEnterCount5m",
  "近5分钟进入人数": "roomEnterCount5m",
  "直播间用户支付金额": "userPaidGmvFen5m",
  "近5分钟用户支付金额": "userPaidGmvFen5m",
  "商品点击次数": "productClickCount",
  "近5分钟商品点击次数": "productClickCount",
  "未支付订单数": "unpaidOrderCount"
};
const CORE_DATA_CODES: Record<string, ConfirmedSemantic> = {
  pay_amt: "sessionPaidGmvFen",
  stat_cost: "adSpendFen",
  pay_ucnt: "paidBuyerCount",
  pay_combo_cnt: "paidItemCount",
  watch_pay_ucnt_ratio: "watchToPaidRate",
  product_click_pay_ucnt_ratio: "productClickToPaidRate"
};

function exactValueObject(value: unknown): { value: unknown; unit: unknown } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as JsonRecord;
  if (!Object.hasOwn(candidate, "value")) return undefined;
  return { value: candidate.value, unit: candidate.unit };
}

function parseConfirmedValue(semantic: ConfirmedSemantic, value: unknown, unit: unknown): number | undefined {
  const parsed = number(value);
  if (parsed === undefined) return undefined;
  const money = semantic === "userPaidGmvFen5m" || semantic === "productPayGmvFen" || semantic === "sessionPaidGmvFen" || semantic === "adSpendFen";
  if (money) return moneyFen(parsed, unit);
  if (unit === "元" || unit === "分" || unit === "万元" || unit === "¥" || unit === "￥" || unit === "price" || unit === "priceV2") return undefined;
  if (semantic === "watchToPaidRate" || semantic === "productClickToPaidRate") {
    if (unit === "%") return parsed;
    if (unit === "ratio") return parsed * 100;
    return undefined;
  }
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseAverageWatchDurationSeconds(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed <= 86400 ? parsed : undefined;
}

function parseCoreDataEntries(body: unknown): { entries: Map<ConfirmedSemantic, number>; conflicts: Set<ConfirmedSemantic> } {
  const entries = new Map<ConfirmedSemantic, number>();
  const conflicts = new Set<ConfirmedSemantic>();
  const coreData = valueAt(body, ["data", "core_data"]);
  if (!Array.isArray(coreData)) return { entries, conflicts };
  for (const raw of coreData) {
    const item = record(raw);
    const display = typeof item.index_display === "string" ? item.index_display : undefined;
    if (display === "人均观看时长" || display === "直播间平均停留时长") {
      const valueObject = exactValueObject(item.value);
      addExactEntry(entries, conflicts, "averageWatchDurationSec", valueObject ? parseAverageWatchDurationSeconds(valueObject.value) : undefined);
      continue;
    }
    const semantic = typeof item.index_name === "string" ? CORE_DATA_CODES[item.index_name] : undefined;
    if (!semantic) continue;
    const valueObject = exactValueObject(item.value);
    if (!valueObject) continue;
    addExactEntry(entries, conflicts, semantic, parseConfirmedValue(semantic, valueObject.value, valueObject.unit));
  }
  return { entries, conflicts };
}

function fiveMinuteSemantic(card: JsonRecord): ConfirmedSemantic | undefined {
  for (const key of ["index_display", "index_name"] as const) {
    const label = typeof card[key] === "string" ? card[key].trim() : "";
    if (label && FIVE_MINUTE_LABELS[label]) return FIVE_MINUTE_LABELS[label];
  }
  return undefined;
}

function parseFiveMinuteEntries(body: unknown): { entries: Map<ConfirmedSemantic, number>; conflicts: Set<ConfirmedSemantic> } {
  const entries = new Map<ConfirmedSemantic, number>();
  const conflicts = new Set<ConfirmedSemantic>();
  const cards = valueAt(body, ["data", "card"]);
  if (!Array.isArray(cards)) return { entries, conflicts };
  for (const rawCard of cards) {
    const card = record(rawCard);
    const semantic = fiveMinuteSemantic(card);
    if (!semantic) continue;
    const valueObject = exactValueObject(card.value);
    if (!valueObject) continue;
    addExactEntry(entries, conflicts, semantic, parseConfirmedValue(semantic, valueObject.value, valueObject.unit));
  }
  return { entries, conflicts };
}

function parseProductExplainEntries(body: unknown): { entries: Map<ConfirmedSemantic, number>; conflicts: Set<ConfirmedSemantic> } {
  const entries = new Map<ConfirmedSemantic, number>();
  const conflicts = new Set<ConfirmedSemantic>();
  const data = record(valueAt(body, ["data"]));
  addExactEntry(entries, conflicts, "productClickCount", number(valueAt(data, ["click_data", "product_click_cnt", "value"])));
  addExactEntry(entries, conflicts, "productPayGmvFen", moneyFen(valueAt(data, ["pay_amt", "value"]), valueAt(data, ["pay_amt", "unit"])));
  addExactEntry(entries, conflicts, "unpaidOrderCount", number(valueAt(data, ["unpay_cnt", "value"])));
  return { entries, conflicts };
}

function addExactEntry(entries: Map<ConfirmedSemantic, number>, conflicts: Set<ConfirmedSemantic>, semantic: ConfirmedSemantic, value: number | undefined): void {
  if (value === undefined || conflicts.has(semantic)) return;
  const previous = entries.get(semantic);
  if (previous === undefined) entries.set(semantic, value);
  else if (previous !== value) {
    entries.delete(semantic);
    conflicts.add(semantic);
  }
}

function parseProductList(body: unknown, output: Partial<LiveCompassMetricSnapshot>): void {
  const list = valueAt(body, ["data", "product_list"]);
  if (!Array.isArray(list)) return;
  const candidates = list.filter((item): item is JsonRecord => item !== null && typeof item === "object" && !Array.isArray(item));
  const selected = candidates.length === 1 ? candidates[0] : undefined;
  if (!selected) return;
  const title = selected.product_title;
  if (typeof title === "string" && title.trim()) {
    const value = title.trim().slice(0, 180);
    output.productName = value;
    output.currentProductName = value;
  }
}

/** Parse any JSON response from the authorized Compass origin using only exact confirmed semantics. */
export function parseCompassLiveJsonResponse(input: CompassLiveJsonResponse): LiveCompassMetricSnapshot | null {
  const allowedOrigins = new Set([COMPASS_LIVE_ORIGIN, COMPASS_LIVE_WS_ORIGIN]);
  const allowedEndpoints: ReadonlySet<string> = new Set([
    COMPASS_LIVE_ENDPOINTS.coreData,
    COMPASS_LIVE_ENDPOINTS.fiveMinuteData,
    COMPASS_LIVE_ENDPOINTS.productExplainDetail
  ]);
  if (!allowedOrigins.has(input.origin) || !allowedEndpoints.has(input.endpoint)) return null;
  const parsedEntries = input.endpoint === COMPASS_LIVE_ENDPOINTS.coreData
    ? parseCoreDataEntries(input.body)
    : input.endpoint === COMPASS_LIVE_ENDPOINTS.fiveMinuteData
      ? parseFiveMinuteEntries(input.body)
      : parseProductExplainEntries(input.body);
  const entries = parsedEntries.entries;
  const output: Partial<LiveCompassMetricSnapshot> = {
    observedAt: input.observedAt,
    sourceEndpoint: input.endpoint,
    mappingVersion: COMPASS_LIVE_MAPPING_VERSION,
    dataStatus: "fresh"
  };
  const productName = input.endpoint === COMPASS_LIVE_ENDPOINTS.productExplainDetail ? valueAt(input.body, ["data", "product_name"]) : undefined;
  if (typeof productName === "string" && productName.trim()) {
    output.productName = productName.trim().slice(0, 180);
    output.currentProductName = output.productName;
  }
  const fieldForSemantic: Record<ConfirmedSemantic, keyof LiveCompassMetricSnapshot> = {
    onlineSnapshot: "onlineSnapshot",
    roomEnterCount5m: "roomEnterCount5m",
    userPaidGmvFen5m: "userPaidGmvFen5m",
    productClickCount: "productClickCount",
    productPayGmvFen: "productPayGmvFen",
    unpaidOrderCount: "unpaidOrderCount",
    sessionPaidGmvFen: "sessionPaidGmvFen",
    adSpendFen: "adSpendFen",
    paidBuyerCount: "paidBuyerCount",
    paidItemCount: "paidItemCount",
    watchToPaidRate: "watchToPaidRate",
    productClickToPaidRate: "productClickToPaidRate",
    averageWatchDurationSec: "averageWatchDurationSec"
  };
  for (const [semantic, value] of entries) merge(output, fieldForSemantic[semantic], value);
  const parsed = liveCompassMetricSnapshotSchema.safeParse(output);
  if (!parsed.success || (entries.size === 0 && parsed.data.productName === undefined && parsed.data.currentProductName === undefined)) return null;
  return parsed.data;
}

function parseFiveMinute(body: unknown, output: Partial<LiveCompassMetricSnapshot>): void {
  const cards = valueAt(body, ["data", "card"]);
  if (!Array.isArray(cards)) return;
  for (const rawCard of cards) {
    const card = record(rawCard);
    const semantic = fiveMinuteSemantic(card);
    if (!semantic) continue;
    const value = record(card.value);
    const rawValue = value.value;
    if (semantic === "userPaidGmvFen5m" || semantic === "productPayGmvFen") merge(output, semantic, moneyFen(rawValue, value.unit));
    else merge(output, semantic, number(rawValue));
  }
}

function parseBaseInfo(body: unknown, output: Partial<LiveCompassMetricSnapshot>): void {
  // The probe export shows a numeric `live_status` enum without a confirmed
  // mapping. Keep it unknown instead of turning an opaque number into a label.
  void body;
  void output;
}

function parseProduct(body: unknown, output: Partial<LiveCompassMetricSnapshot>): void {
  parseProductList(body, output);
}

function parseProductExplainDetail(body: unknown, output: Partial<LiveCompassMetricSnapshot>): void {
  const data = record(valueAt(body, ["data"]));
  const click = number(valueAt(data, ["click_data", "product_click_cnt", "value"]));
  const pay = moneyFen(valueAt(data, ["pay_amt", "value"]), valueAt(data, ["pay_amt", "unit"]));
  const unpaid = number(valueAt(data, ["unpay_cnt", "value"]));
  merge(output, "productClickCount", click);
  merge(output, "productPayGmvFen", pay);
  merge(output, "unpaidOrderCount", unpaid);
  const name = data.product_name;
  if (typeof name === "string" && name.trim()) output.productName = name.trim().slice(0, 180);
}

/** Parse only field paths confirmed by the sanitized Compass probe export. */
export function parseCompassLiveResponse(input: CompassLiveResponse): LiveCompassMetricSnapshot | null {
  if (input.origin !== COMPASS_LIVE_ORIGIN) return null;
  const fixedEndpoints = new Set<string>([
    COMPASS_LIVE_ENDPOINTS.fiveMinuteData,
    COMPASS_LIVE_ENDPOINTS.liveBaseInfo,
    COMPASS_LIVE_ENDPOINTS.product,
    COMPASS_LIVE_ENDPOINTS.productExplainDetail
  ]);
  if (!fixedEndpoints.has(input.endpoint)) return null;
  const output: Partial<LiveCompassMetricSnapshot> = {
    observedAt: input.observedAt,
    sourceEndpoint: input.endpoint,
    mappingVersion: COMPASS_LIVE_MAPPING_VERSION,
    dataStatus: "fresh"
  };
  if (input.endpoint === COMPASS_LIVE_ENDPOINTS.fiveMinuteData) parseFiveMinute(input.body, output);
  else if (input.endpoint === COMPASS_LIVE_ENDPOINTS.liveBaseInfo) parseBaseInfo(input.body, output);
  else if (input.endpoint === COMPASS_LIVE_ENDPOINTS.product) parseProduct(input.body, output);
  else parseProductExplainDetail(input.body, output);
  const parsed = liveCompassMetricSnapshotSchema.safeParse(output);
  if (!parsed.success) return null;
  const hasBusinessField = ["onlineSnapshot", "roomEnterCount5m", "userPaidGmvFen5m", "productClickCount", "productPayGmvFen", "unpaidOrderCount", "sessionPaidGmvFen", "adSpendFen", "paidBuyerCount", "paidItemCount", "watchToPaidRate", "productClickToPaidRate", "averageWatchDurationSec", "productName", "currentProductName", "liveStatus"].some((key) => Object.hasOwn(parsed.data, key));
  return hasBusinessField ? parsed.data : null;
}
