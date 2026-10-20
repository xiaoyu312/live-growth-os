import { sanitizeCompassWebSocketUrl, sanitizePageUrl } from "./allowlist.js";
import type {
  DomFieldCandidate,
  FieldShape,
  MetricObservation,
  SanitizedDomField,
  SanitizedNetworkObservation,
  SanitizedTargetObservation
} from "./types.js";

const SENSITIVE_KEY_PARTS = [
  "authorization", "cookie", "setcookie", "bearer", "token", "secret", "password", "passwd", "credential",
  "apikey", "accesskey", "phone", "mobile", "address", "shipping", "delivery", "openid", "userid", "customerid", "deviceid", "timestamp", "user",
  "id", "uuid", "email", "customer", "username", "nickname", "realname", "receiver", "contact", "comment",
  "content", "query", "fragment", "postdata"
];
const METRIC_KEY_PARTS = [
  "gmv", "roi", "rate", "ratio", "count", "uv", "pv", "amount", "spend", "cost", "online", "enter",
  "click", "clicks", "pay", "pays", "order", "orders", "impression", "impressions", "view", "views",
  "counts", "rates", "ratios", "amounts", "spends", "costs", "enters"
];
const METRIC_FORBIDDEN_KEY_PARTS = [
  "id", "uuid", "user", "userid", "openid", "account", "accountid", "customer", "customerid", "device", "deviceid", "phone", "mobile", "address", "token", "secret", "password",
  "credential", "auth", "email", "name", "receiver", "orderid", "plan", "planid", "identifier", "identity", "timestamp"
];
const NON_METRIC_KEY_PARTS = new Set(["ts", "time", "date", "timestamp", "status", "cursor", "interval"]);
const SEMANTIC_LEAF_KEYS = new Set(["index_name", "index_code", "metric_name", "metric_code", "indicator_name", "indicator_code"]);
const SEMANTIC_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SENSITIVE_VALUE_PATTERNS = [
  /\b(?:authorization|cookie|set-cookie)\s*[:=]/i,
  /\bbearer\s+\S+/i,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/,
  /(?:客户|订单|姓名|账号|收货地址|详细地址|省市区)/,
  /(?<!\d)\d{6,}(?!\d)/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:收货地址|详细地址|省市区|路|街|号)/
];
const DOM_METRIC_LABEL_PATTERNS = [
  /^(?:直播间)?在线人数$/,
  /^(?:直播间)?进入人数$/,
  /^(?:商品)?点击人数$/,
  /^(?:商品)?曝光人数$/,
  /^(?:支付|成交)(?:人数|订单数|金额)?$/,
  /^(?:投流)?(?:消耗|花费)$/,
  /^(?:ROI|GMV|GPM|CTR|CVR|转化率)$/i,
  /^(?:在线|进入|点击|曝光|支付|成交|消耗|ROI|GMV|GPM|CTR|CVR).*(?:人数|次数|金额|费率|率|值)$/i
];

export function isSensitiveKey(key: string): boolean {
  const tokens = key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.some((token) => SENSITIVE_KEY_PARTS.includes(token));
}

export function containsSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function valueType(value: unknown): FieldShape["valueType"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "object": return "object";
    default: return "unknown";
  }
}

function safeSample(value: unknown): string {
  if (typeof value === "string") return containsSensitiveValue(value) ? "[redacted]" : "<string>";
  if (typeof value === "number") return "<number>";
  if (typeof value === "boolean") return "<boolean>";
  if (value === null) return "<null>";
  if (Array.isArray(value)) return "<array>";
  if (typeof value === "object") return "<object>";
  return "<unknown>";
}

function dynamicPathKey(key: string): string {
  const normalized = key.trim();
  if (!/^[A-Za-z][A-Za-z0-9_:-]{0,63}$/.test(normalized) || /\d{6,}/.test(normalized) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(normalized) || /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(normalized) || /^1[3-9]\d{9}$/.test(normalized)) {
    return "[dynamic-key]";
  }
  return normalized;
}

function metricKeyTokens(path: string): string[] {
  return path.split(/[.\[\]]/)
    .flatMap((part) => part.replace(/([a-z\d])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/))
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

export function isMetricFieldPath(path: string): boolean {
  if (path.includes("[dynamic-key]")) return false;
  const tokens = metricKeyTokens(path);
  if (tokens.length === 0 || tokens.some((token) => NON_METRIC_KEY_PARTS.has(token))) return false;
  if (tokens.some((token) => METRIC_FORBIDDEN_KEY_PARTS.some((part) => token === part))) return false;
  return tokens.some((token) => METRIC_KEY_PARTS.includes(token));
}

function fieldLeafKey(path: string): string | null {
  if (!/^root(?:\.(?:[A-Za-z][A-Za-z0-9_:-]{0,63})|\[\d+\])+$/.test(path)) return null;
  const leaf = path.split(".").at(-1);
  return leaf && SEMANTIC_LEAF_KEYS.has(leaf) ? leaf : null;
}

export function isSemanticMetricPath(path: string): boolean {
  return fieldLeafKey(path) !== null;
}

export function isSemanticMetricCode(value: string): boolean {
  if (value.length === 0 || value.length > 64 || !/^[\x00-\x7F]*$/.test(value) || !SEMANTIC_CODE_PATTERN.test(value)) return false;
  if (containsSensitiveValue(value) || /\d{6,}/.test(value) || /[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(value) || /[0-9a-f]{16,}/i.test(value)) return false;
  const tokens = metricKeyTokens(value);
  if (tokens.some((token) => NON_METRIC_KEY_PARTS.has(token))) return false;
  if (tokens.some((token) => METRIC_FORBIDDEN_KEY_PARTS.includes(token))) return false;
  return tokens.some((token) => METRIC_KEY_PARTS.includes(token));
}

export function isValidMetricObservation(value: unknown): value is MetricObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "path" && key !== "observedAt" && key !== "value" && key !== "semanticCode")) return false;
  const path = candidate.path;
  const semanticCode = candidate.semanticCode;
  const validPath = typeof path === "string" && /^root(?:\.(?:[A-Za-z][A-Za-z0-9_:-]{0,63})|\[\d+\])+$/.test(path) && !path.includes("[dynamic-key]");
  const validSemanticCode = semanticCode === undefined || (typeof semanticCode === "string" && isSemanticMetricCode(semanticCode));
  return validPath
    && (isMetricFieldPath(path as string) || validSemanticCode && semanticCode !== undefined)
    && typeof candidate.observedAt === "string"
    && ISO_UTC_TIMESTAMP_PATTERN.test(candidate.observedAt)
    && Number.isFinite(Date.parse(candidate.observedAt))
    && typeof candidate.value === "number"
    && Number.isFinite(candidate.value);
}

interface FieldShapeResult {
  fields: FieldShape[];
  metricObservations: MetricObservation[];
}

function collectFieldShapes(value: unknown, observedAt: string | undefined, maxFields = 160, maxDepth = 6): FieldShapeResult {
  const result: FieldShape[] = [];
  const metricCandidates: Array<{ path: string; value: number }> = [];
  const walk = (current: unknown, path: string, depth: number): void => {
    if (result.length >= maxFields) return;
    const type = valueType(current);
    if (depth >= maxDepth || current === null || typeof current !== "object") {
      const shape: FieldShape = { path, valueType: type, sample: safeSample(current) };
      if (typeof current === "string" && isSemanticMetricPath(path) && isSemanticMetricCode(current)) shape.semanticCode = current;
      result.push(shape);
      if (typeof current === "number" && Number.isFinite(current) && observedAt && metricCandidates.length < maxFields) metricCandidates.push({ path, value: current });
      return;
    }
    if (Array.isArray(current)) {
      result.push({ path, valueType: "array", sample: "<array>" });
      for (let index = 0; index < Math.min(current.length, 8) && result.length < maxFields; index += 1) {
        if (current[index] !== undefined) walk(current[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    const entries = Object.entries(current as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) { result.push({ path, valueType: "object", sample: "<object>" }); return; }
    for (const [key, child] of entries) {
      const safeKey = dynamicPathKey(key);
      if (isSensitiveKey(key) && safeKey === key) continue;
      walk(child, path ? `${path}.${safeKey}` : safeKey, depth + 1);
      if (result.length >= maxFields) break;
    }
  };
  walk(value, "root", 0);
  const semanticCodeForPath = (path: string): string | undefined => {
    const exact = result.find((field) => field.path === path)?.semanticCode;
    if (exact) return exact;
    if (path.slice(path.lastIndexOf(".") + 1) !== "value") return undefined;
    const parent = path.slice(0, path.lastIndexOf("."));
    if (!parent) return undefined;
    for (const key of SEMANTIC_LEAF_KEYS) {
      const code = result.find((field) => field.path === `${parent}.${key}`)?.semanticCode;
      if (code) return code;
    }
    return undefined;
  };
  const metricObservations = metricCandidates.flatMap(({ path, value: numberValue }) => {
    const semanticCode = semanticCodeForPath(path);
    if (!isMetricFieldPath(path) && !semanticCode) return [];
    return [{ path, observedAt: observedAt!, value: numberValue, ...(semanticCode ? { semanticCode } : {}) }];
  });
  return { fields: result, metricObservations };
}

export function fieldShapes(value: unknown, maxFields = 160, maxDepth = 6): FieldShape[] {
  return collectFieldShapes(value, undefined, maxFields, maxDepth).fields;
}

export function sanitizeHeaderShape(headers: unknown): FieldShape[] {
  if (!headers || typeof headers !== "object") return [];
  const names = Object.keys(headers as Record<string, unknown>).filter((name) => !isSensitiveKey(name)).sort();
  return names.map((name) => ({ path: `headers.${name.toLowerCase()}`, valueType: "string", sample: "<header>" }));
}

export function sanitizeNetworkObservation(input: {
  kind: "http" | "ws";
  phase?: "request_start" | "response_metadata" | "body_shape" | "ws_frame";
  url: string;
  observedAt: string;
  method?: string;
  resourceType?: string;
  status?: number;
  mimeType?: string;
  direction?: "sent" | "received";
  messageBytes?: number;
  frameType?: "json" | "text" | "binary";
  body?: unknown;
}): SanitizedNetworkObservation | null {
  const location = input.kind === "ws" ? sanitizeCompassWebSocketUrl(input.url) : sanitizePageUrl(input.url);
  if (!location) return null;
  const parsed = input.body === undefined ? { fields: [], metricObservations: [] } : collectFieldShapes(input.body, input.observedAt);
  const base: SanitizedNetworkObservation = {
    kind: input.kind,
    phase: input.phase ?? (input.kind === "ws" ? "ws_frame" : "response_metadata"),
    observedAt: input.observedAt,
    origin: location.origin,
    pathname: location.pathname,
    fields: parsed.fields
  };
  if (input.method !== undefined) base.method = input.method.toUpperCase();
  if (input.resourceType !== undefined) base.resourceType = input.resourceType;
  if (input.status !== undefined && Number.isFinite(input.status)) base.status = Math.trunc(input.status);
  if (input.mimeType !== undefined) base.mimeType = input.mimeType.split(";", 1)[0]!.toLowerCase();
  if (input.direction !== undefined) base.direction = input.direction;
  if (input.messageBytes !== undefined && Number.isFinite(input.messageBytes)) base.messageBytes = Math.max(0, Math.trunc(input.messageBytes));
  if (input.frameType !== undefined) base.frameType = input.frameType;
  if (parsed.metricObservations.length > 0) base.metricObservations = parsed.metricObservations;
  return base;
}

function stableDigest(value: string): string {
  let hash = 2166136261;
  for (const char of value) { hash ^= char.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619); }
  return `s${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function sanitizeDomFields(candidates: DomFieldCandidate[], previous: SanitizedDomField[], observedAt: string, online = true): SanitizedDomField[] {
  const previousCounts = new Map(previous.map((field) => [field.selectorDigest, field.refreshCount]));
  return candidates.slice(0, 120).map((candidate) => {
    const selectorDigest = stableDigest(candidate.selector);
    const normalizedLabel = candidate.label.replace(/\s+/g, " ").trim().slice(0, 80);
    const label = containsSensitiveValue(normalizedLabel) || !DOM_METRIC_LABEL_PATTERNS.some((pattern) => pattern.test(normalizedLabel)) ? "[结构字段]" : normalizedLabel;
    return {
      label,
      selectorDigest,
      valueType: candidate.valueType.slice(0, 40),
      refreshCount: (previousCounts.get(selectorDigest) ?? 0) + 1,
      lastSeen: observedAt,
      status: online ? "fresh" : "offline"
    };
  });
}

export function sanitizeTargetObservation(input: {
  observedAt: string;
  targetType: string;
  url: string;
  lifecycle: "created" | "updated" | "destroyed";
}): SanitizedTargetObservation | null {
  const location = sanitizePageUrl(input.url);
  if (!location) return null;
  const targetType: SanitizedTargetObservation["targetType"] = input.targetType === "iframe" || input.targetType === "worker" || input.targetType === "service_worker" || input.targetType === "page" ? input.targetType : "other";
  return { observedAt: input.observedAt, targetType, origin: location.origin, pathname: location.pathname, lifecycle: input.lifecycle };
}
