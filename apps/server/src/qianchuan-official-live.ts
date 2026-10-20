import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  QIANCHUAN_AUTHORIZED_AWEME_ENDPOINT,
  QIANCHUAN_OFFICIAL_LIVE_ENDPOINT,
  QIANCHUAN_OFFICIAL_LIVE_EXTENDED_REQUEST_FIELDS,
  QIANCHUAN_OFFICIAL_LIVE_OPTIONAL_REQUEST_FIELDS,
  QIANCHUAN_OFFICIAL_LIVE_REQUEST_FIELDS,
  authorizedAwemePageHasMore,
  authorizedAwemeRows,
  buildLiveAuthorizedAwemeIndex,
  normalizeLiveAnchorId,
  parseQianchuanJson,
  parseQianchuanOfficialLiveResponse
} from "@live-growth/source-adapters";
import type { QianchuanMetricSnapshot } from "@live-growth/contracts";
import { qianchuanAwemeListSchema, type QianchuanAccountList, type QianchuanAweme } from "@live-growth/contracts";
import { normalizeAuthorizedAwemeId } from "@live-growth/source-adapters";
import { discoverQianchuanAccounts, QIANCHUAN_ACCOUNT_ENDPOINTS } from "./qianchuan-accounts";

const DEFAULT_BASE_URL = "https://api.oceanengine.com";
const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 25_000;
const PRE_REFRESH_MS = 60_000;
const FRESH_AFTER_MS = 90_000;
const AUTHORIZED_AWEME_TTL_MS = 15 * 60_000;
const AUTHORIZED_AWEME_PAGE_SIZE = 100;
const AUTHORIZED_AWEME_PAGE_LIMIT = 100;
const TOKEN_STORE_VERSION = 1;

export type QianchuanOfficialLiveConfig = {
  appId: string;
  appSecret: string;
  advertiserId?: string;
  awemeId?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  baseUrl?: string;
  pollMs?: number;
  tokenStorePath?: string;
};

export type QianchuanOfficialLiveStatus = {
  source: "official_api";
  configured: boolean;
  state: "not_configured" | "idle" | "healthy" | "stale" | "error";
  activeSessions: number;
  lastSuccessAt?: string;
  lastErrorCode?: string;
  consecutiveFailures: number;
};

export type QianchuanLiveFieldCapability = "available" | "missing" | "unsupported" | "not_requested";
export type QianchuanLiveProbeResult = {
  observedAt: string;
  status: "fresh" | "no_living_room" | "error";
  requestedFields: string[];
  fallbackUsed: boolean;
  capabilities: Record<string, QianchuanLiveFieldCapability>;
  snapshot: QianchuanMetricSnapshot | null;
  errorCode?: string;
};

type TokenState = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
};

type FetchLike = typeof fetch;
type Clock = () => number;
export type QianchuanOfficialLiveSnapshotListener = (snapshot: QianchuanMetricSnapshot) => void | Promise<void>;
type SnapshotListener = QianchuanOfficialLiveSnapshotListener;
type SessionPoll = { listener: SnapshotListener };
type RoomRequestResult = { body: unknown; requestedFields: string[]; fallbackUsed: boolean; rejectedField?: string };

export interface QianchuanOfficialLiveSourceLike {
  start(sessionId: string, listener: SnapshotListener): Promise<void>;
  stop(sessionId: string): Promise<void>;
  close(): Promise<void>;
  status(): QianchuanOfficialLiveStatus;
  isFresh(nowMs?: number): boolean;
  probeLiveData?(): Promise<QianchuanLiveProbeResult>;
  inspectCapabilities?(): Promise<QianchuanLiveProbeResult>;
}

export class QianchuanOfficialLiveError extends Error {
  constructor(readonly code: string, readonly upstreamMessage?: string) {
    super(code);
    this.name = "QianchuanOfficialLiveError";
  }
}

function isOptionalFieldRequestError(error: unknown): boolean {
  if (!(error instanceof QianchuanOfficialLiveError)) return false;
  if (/(?:HTTP|TOOL)_40[13]\d*/.test(error.code)) return false;
  const message = error.upstreamMessage?.toLowerCase() ?? "";
  return /^QIANCHUAN_TOOL_4\d{4}$/.test(error.code)
    && /(field|metric|字段|指标)/.test(message)
    && /(invalid|unsupported|unknown|not support|不支持|无效|不存在|参数)/.test(message);
}

function rejectedOptionalField(error: unknown): string | undefined {
  if (!(error instanceof QianchuanOfficialLiveError)) return undefined;
  const message = error.upstreamMessage?.toLowerCase() ?? "";
  return QIANCHUAN_OFFICIAL_LIVE_OPTIONAL_REQUEST_FIELDS.find((field) => message.includes(field.toLowerCase()));
}

function envTrim(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function isAwemeRef(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && !/\s/.test(value);
}

function officialErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^QIANCHUAN_[A-Z0-9_]+$/.test(message) ? message : fallback;
}

function parsePollMs(value: string): number {
  if (!value) return DEFAULT_POLL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_MS;
  if (parsed < MIN_POLL_MS) return MIN_POLL_MS;
  return Math.floor(parsed);
}

function normalizedBaseUrl(value: string): string {
  try {
    const url = new URL(value || DEFAULT_BASE_URL);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase())) {
      throw new QianchuanOfficialLiveError("QIANCHUAN_STRICT_TLS_REQUIRED");
    }
    return url.origin;
  } catch (error) {
    if (error instanceof QianchuanOfficialLiveError) throw error;
    throw new QianchuanOfficialLiveError("QIANCHUAN_STRICT_TLS_REQUIRED");
  }
}

export function qianchuanOfficialLiveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): QianchuanOfficialLiveConfig | undefined {
  const appId = envTrim(env, "QIANCHUAN_API_APP_ID");
  const appSecret = envTrim(env, "QIANCHUAN_API_APP_SECRET");
  const advertiserId = envTrim(env, "QIANCHUAN_ADVERTISER_ID");
  const awemeId = envTrim(env, "QIANCHUAN_AWEME_ID");
  const accessToken = envTrim(env, "QIANCHUAN_API_ACCESS_TOKEN");
  const refreshToken = envTrim(env, "QIANCHUAN_API_REFRESH_TOKEN");
  const tokenStorePath = envTrim(env, "QIANCHUAN_API_TOKEN_STORE_PATH");
  if (!isDigits(appId) || !appSecret || !isDigits(advertiserId) || !isAwemeRef(awemeId) || (!accessToken && !refreshToken && !tokenStorePath)) return undefined;
  return {
    appId, appSecret, advertiserId, awemeId,
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(envTrim(env, "QIANCHUAN_API_TOKEN_EXPIRES_AT") ? { tokenExpiresAt: envTrim(env, "QIANCHUAN_API_TOKEN_EXPIRES_AT") } : {}),
    ...(envTrim(env, "QIANCHUAN_API_REFRESH_TOKEN_EXPIRES_AT") ? { refreshTokenExpiresAt: envTrim(env, "QIANCHUAN_API_REFRESH_TOKEN_EXPIRES_AT") } : {}),
    ...(envTrim(env, "QIANCHUAN_API_BASE_URL") ? { baseUrl: envTrim(env, "QIANCHUAN_API_BASE_URL") } : {}),
    pollMs: parsePollMs(envTrim(env, "QIANCHUAN_API_POLL_MS")),
    ...(tokenStorePath ? { tokenStorePath } : {})
  };
}

/** 只返回是否已配置，不暴露 appId、advertiserId 或任何 token。 */
export function qianchuanOfficialLiveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(qianchuanOfficialLiveConfigFromEnv(env));
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const asNumber = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber < 1e12 ? asNumber * 1000 : asNumber;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof QianchuanOfficialLiveError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return /^QIANCHUAN_[A-Z0-9_]+$/.test(message) ? message : "QIANCHUAN_FAILED";
}

function localDate(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(nowMs));
}

function normalizedRoomId(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function roomStartMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  return Number.NEGATIVE_INFINITY;
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const INTEGER_LIVE_FIELDS = new Set([
  "live_pay_order_count_alias", "live_click_product_count_alias", "total_live_watch_cnt",
  "total_live_comment_cnt", "total_live_follow_cnt", "total_live_fans_club_join_cnt", "total_live_share_cnt"
]);

function hasValidRawMetric(room: Record<string, unknown>, field: string): boolean {
  const value = finiteNonNegative(room[field]);
  return value !== undefined && (!INTEGER_LIVE_FIELDS.has(field) || Number.isInteger(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseTokenState(value: unknown, expectedIdentityHash: string): TokenState {
  const record = asRecord(value);
  if (!record || record.version !== TOKEN_STORE_VERSION || record.appIdentityHash !== expectedIdentityHash) return {};
  const token: TokenState = {};
  for (const [inputKey, outputKey] of [
    ["accessToken", "accessToken"], ["refreshToken", "refreshToken"],
    ["expiresAt", "expiresAt"], ["refreshTokenExpiresAt", "refreshTokenExpiresAt"]
  ] as const) {
    const item = record[inputKey];
    if (typeof item === "string" && item.trim()) token[outputKey] = item.trim();
  }
  return token;
}

function tokenStorePayload(token: TokenState, appIdentityHash: string): Record<string, unknown> {
  return {
    version: TOKEN_STORE_VERSION,
    appIdentityHash,
    ...(token.accessToken ? { accessToken: token.accessToken } : {}),
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
    ...(token.refreshTokenExpiresAt ? { refreshTokenExpiresAt: token.refreshTokenExpiresAt } : {})
  };
}

function expiryIso(nowMs: number, value: unknown): string | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(nowMs + seconds * 1000).toISOString() : undefined;
}

export type QianchuanOfficialLiveSourceOptions = {
  config?: QianchuanOfficialLiveConfig | null;
  fetchImpl?: FetchLike;
  now?: Clock;
};

/**
 * 官方千川直播间只读来源。它只输出标准 QianchuanMetricSnapshot，
 * 不把 OAuth、请求参数或上游响应泄漏到 LivePilotService。
 * today_live 的 aweme_id 必须先经授权抖音号映射，不能把展示号直接发出去。
 */
export class OfficialQianchuanLiveSource implements QianchuanOfficialLiveSourceLike {
  private config: QianchuanOfficialLiveConfig | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly sessions = new Map<string, SessionPoll>();
  private tokens: TokenState;
  private tokenStoreLoaded = false;
  private refreshFlight?: Promise<void>;
  private pollFlight?: Promise<void>;
  private roomRequestFlight?: Promise<RoomRequestResult>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastSnapshot?: QianchuanMetricSnapshot;
  private lastSuccessAt?: string;
  private lastErrorCode?: string;
  private consecutiveFailures = 0;
  private configurationFlight: Promise<void> = Promise.resolve();
  private disposed = false;
  private authorizedCache?: { advertiserId: string; awemeRef: string; awemeId: string; expiresAt: number };
  private lastFieldRequestState: { requestedFields: string[]; fallbackUsed: boolean; capabilities: Record<string, QianchuanLiveFieldCapability> } = {
    requestedFields: [...QIANCHUAN_OFFICIAL_LIVE_EXTENDED_REQUEST_FIELDS],
    fallbackUsed: false,
    capabilities: {}
  };

  constructor(options: QianchuanOfficialLiveSourceOptions = {}) {
    this.config = options.config === null ? undefined : options.config ?? qianchuanOfficialLiveConfigFromEnv();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.now ?? Date.now;
    this.tokens = {
      ...(this.config?.accessToken ? { accessToken: this.config.accessToken } : {}),
      ...(this.config?.refreshToken ? { refreshToken: this.config.refreshToken } : {}),
      ...(this.config?.tokenExpiresAt ? { expiresAt: this.config.tokenExpiresAt } : {}),
      ...(this.config?.refreshTokenExpiresAt ? { refreshTokenExpiresAt: this.config.refreshTokenExpiresAt } : {})
    };
  }

  status(): QianchuanOfficialLiveStatus {
    if (!this.config?.advertiserId || !this.config.awemeId) return { source: "official_api", configured: false, state: "not_configured", activeSessions: this.sessions.size, consecutiveFailures: 0 };
    const lastSuccessMs = parseTimestamp(this.lastSuccessAt);
    const state = this.lastErrorCode && !lastSuccessMs
      ? "error"
      : lastSuccessMs === undefined
        ? "idle"
        : this.clock() - lastSuccessMs <= FRESH_AFTER_MS
          ? "healthy"
          : "stale";
    return {
      source: "official_api", configured: true, state, activeSessions: this.sessions.size,
      ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
      consecutiveFailures: this.consecutiveFailures
    };
  }

  isFresh(nowMs = this.clock()): boolean {
    const lastSuccessMs = parseTimestamp(this.lastSuccessAt);
    return Boolean(lastSuccessMs !== undefined && nowMs - lastSuccessMs <= FRESH_AFTER_MS);
  }

  authorizationAvailable(): boolean {
    const accessExpiry = parseTimestamp(this.tokens.expiresAt);
    const refreshExpiry = parseTimestamp(this.tokens.refreshTokenExpiresAt);
    return Boolean((this.tokens.accessToken && (accessExpiry === undefined || accessExpiry > this.clock()))
      || (this.tokens.refreshToken && (refreshExpiry === undefined || refreshExpiry > this.clock())));
  }

  /** 本机连接界面热更新同一个客户端，授权列表与直播轮询共用唯一续期器。 */
  configure(config: QianchuanOfficialLiveConfig | undefined): Promise<void> {
    const run = this.configurationFlight.then(async () => {
      if (this.disposed) throw new QianchuanOfficialLiveError("QIANCHUAN_SOURCE_CLOSED");
      if (this.pollTimer) clearInterval(this.pollTimer);
      delete this.pollTimer;
      await this.pollFlight;
      await this.roomRequestFlight?.catch(() => undefined);
      this.config = config;
      this.tokens = {
        ...(config?.accessToken ? { accessToken: config.accessToken } : {}),
        ...(config?.refreshToken ? { refreshToken: config.refreshToken } : {}),
        ...(config?.tokenExpiresAt ? { expiresAt: config.tokenExpiresAt } : {}),
        ...(config?.refreshTokenExpiresAt ? { refreshTokenExpiresAt: config.refreshTokenExpiresAt } : {})
      };
      this.tokenStoreLoaded = false;
      delete this.authorizedCache;
      delete this.lastSnapshot;
      delete this.lastSuccessAt;
      delete this.lastErrorCode;
      this.consecutiveFailures = 0;
      this.lastFieldRequestState = {
        requestedFields: [...QIANCHUAN_OFFICIAL_LIVE_EXTENDED_REQUEST_FIELDS],
        fallbackUsed: false,
        capabilities: {}
      };
      await this.loadTokenStore();
      if (!this.disposed && this.sessions.size && this.status().configured) {
        await this.poll();
        this.schedulePolling();
      }
    });
    this.configurationFlight = run.catch(() => undefined);
    return run;
  }

  private schedulePolling(): void {
    if (!this.disposed && this.sessions.size && this.status().configured && !this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.poll(); }, this.config?.pollMs ?? DEFAULT_POLL_MS);
    }
  }

  async listAccounts(): Promise<QianchuanAccountList> {
    await this.configurationFlight;
    return discoverQianchuanAccounts(async (path, args) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        query.set(key, typeof value === "string" ? value
          : /_ids$/.test(key) && Array.isArray(value) && value.every((id) => typeof id === "string" && /^\d+$/.test(id))
            ? `[${value.join(",")}]` : JSON.stringify(value));
      }
      return this.getEnvelopeData(`${path}?${query}`);
    }, this.clock);
  }

  async listAwemes(advertiserId: string): Promise<QianchuanAweme[]> {
    await this.configurationFlight;
    normalizeAuthorizedAwemeId(advertiserId);
    const rows = await this.loadAuthorizedAwemeRows(advertiserId);
    const items = new Map<string, QianchuanAweme>();
    for (const value of rows) {
      const row = asRecord(value);
      if (!row) continue;
      const id = normalizeAuthorizedAwemeId(row.aweme_id ?? row.awemeId);
      const name = row.aweme_name ?? row.name;
      const showId = row.aweme_show_id ?? row.awemeShowId;
      items.set(id, { id, name: typeof name === "string" && name.trim() ? name.trim().slice(0, 160) : `抖音号 ${id}`,
        ...(typeof showId === "string" ? { showId: showId.slice(0, 64) } : {}) });
    }
    return qianchuanAwemeListSchema.parse({ items: [...items.values()] }).items;
  }

  /**
   * Execute one read-only room request without starting or touching a polling
   * timer. The result exposes only field names, availability and the validated
   * snapshot; OAuth values and upstream response bodies never leave this method.
   */
  async probeLiveData(): Promise<QianchuanLiveProbeResult> {
    await this.configurationFlight;
    const observedAt = new Date(this.clock()).toISOString();
    try {
      const request = await this.fetchRoomBody();
      const snapshot = parseQianchuanOfficialLiveResponse({ endpoint: QIANCHUAN_OFFICIAL_LIVE_ENDPOINT, observedAt, body: request.body });
      const result: QianchuanLiveProbeResult = {
        observedAt,
        status: snapshot ? "fresh" : "no_living_room",
        requestedFields: request.requestedFields,
        fallbackUsed: request.fallbackUsed,
        capabilities: this.fieldCapabilities(request.body, request.requestedFields, request.fallbackUsed, snapshot?.roomId, request.rejectedField),
        snapshot
      };
      return result;
    } catch (error) {
      return {
        observedAt,
        status: "error",
        requestedFields: [...this.lastFieldRequestState.requestedFields],
        fallbackUsed: this.lastFieldRequestState.fallbackUsed,
        capabilities: { ...this.lastFieldRequestState.capabilities },
        snapshot: null,
        errorCode: safeErrorCode(error)
      };
    }
  }

  async inspectCapabilities(): Promise<QianchuanLiveProbeResult> {
    return this.probeLiveData();
  }

  async start(sessionId: string, listener: SnapshotListener): Promise<void> {
    await this.configurationFlight;
    if (!this.status().configured || this.disposed) return;
    await this.loadTokenStore();
    const hadSubscribers = this.sessions.size > 0;
    const poll: SessionPoll = { listener };
    this.sessions.set(sessionId, poll);
    if (hadSubscribers) {
      if (this.lastSnapshot && this.isFresh()) await Promise.resolve().then(() => listener(this.lastSnapshot!)).catch(() => undefined);
      return;
    }
    await this.poll();
    this.schedulePolling();
  }

  async stop(sessionId: string): Promise<void> {
    if (!this.sessions.delete(sessionId)) return;
    if (this.sessions.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      delete this.pollTimer;
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.sessions.clear();
    delete this.authorizedCache;
    if (this.pollTimer) clearInterval(this.pollTimer);
    delete this.pollTimer;
    await this.pollFlight?.catch(() => undefined);
    delete this.pollFlight;
    await this.roomRequestFlight?.catch(() => undefined);
    delete this.roomRequestFlight;
    await this.configurationFlight;
  }

  private async loadTokenStore(): Promise<void> {
    if (this.tokenStoreLoaded || !this.config?.tokenStorePath) {
      this.tokenStoreLoaded = true;
      return;
    }
    this.tokenStoreLoaded = true;
    try {
      const raw = await readFile(this.config.tokenStorePath, "utf8");
      const persisted = parseTokenState(JSON.parse(raw), this.appIdentityHash());
      this.tokens = { ...this.tokens, ...persisted };
    } catch {
      // 首次运行、文件不存在或文件损坏都不阻断环境 token；本轮 API 失败会显式反映在 health。
    }
  }

  private async saveTokenStore(): Promise<void> {
    const path = this.config?.tokenStorePath;
    if (!path) return;
    const temporary = `${path}.tmp-${process.pid}-${this.clock()}`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(tokenStorePayload(this.tokens, this.appIdentityHash()), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new QianchuanOfficialLiveError("QIANCHUAN_TOKEN_PERSIST_FAILED");
    }
  }

  private appIdentityHash(): string {
    const config = this.config;
    if (!config) return "";
    return createHash("sha256").update(config.appId).update("\0").update(config.appSecret).digest("hex");
  }

  private async ensureToken(): Promise<void> {
    if (!this.config) throw new QianchuanOfficialLiveError("QIANCHUAN_NOT_CONFIGURED");
    await this.loadTokenStore();
    const expiresAt = parseTimestamp(this.tokens.expiresAt);
    if (this.tokens.refreshToken && (!this.tokens.accessToken || (expiresAt !== undefined && this.clock() >= expiresAt - PRE_REFRESH_MS))) {
      await this.refreshToken();
    }
    if (!this.tokens.accessToken) throw new QianchuanOfficialLiveError("QIANCHUAN_NOT_CONFIGURED");
  }

  private async refreshToken(): Promise<void> {
    if (this.refreshFlight) return this.refreshFlight;
    if (!this.config?.refreshToken && !this.tokens.refreshToken) throw new QianchuanOfficialLiveError("QIANCHUAN_NOT_CONFIGURED");
    const run = (async () => {
      const config = this.config;
      const refreshToken = this.tokens.refreshToken;
      if (!config || !refreshToken) throw new QianchuanOfficialLiveError("QIANCHUAN_NOT_CONFIGURED");
      const response = await this.request("/open_api/oauth2/refresh_token/", {
        method: "POST",
        body: JSON.stringify({ grant_type: "refresh_token", app_id: Number(config.appId), secret: config.appSecret, refresh_token: refreshToken }),
        headers: { "Content-Type": "application/json" }
      });
      const envelope = await this.readEnvelope(response);
      const data = asRecord(envelope.data);
      const accessToken = typeof data?.access_token === "string" ? data.access_token.trim() : "";
      if (!accessToken) throw new QianchuanOfficialLiveError("QIANCHUAN_EMPTY_RESPONSE");
      const expiresAt = expiryIso(this.clock(), data?.expires_in);
      const refreshTokenExpiresAt = expiryIso(this.clock(), data?.refresh_token_expires_in);
      const nextRefreshToken = typeof data?.refresh_token === "string" && data.refresh_token.trim() ? data.refresh_token.trim() : refreshToken;
      const next: TokenState = {
        accessToken,
        ...(nextRefreshToken ? { refreshToken: nextRefreshToken } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {})
      };
      this.tokens = next;
      await this.saveTokenStore();
    })();
    this.refreshFlight = run.finally(() => { delete this.refreshFlight; });
    return this.refreshFlight;
  }

  private async request(path: string, init: { method: "GET" | "POST"; body?: string; headers?: Record<string, string>; accessToken?: string }): Promise<Response> {
    const baseUrl = normalizedBaseUrl(this.config?.baseUrl ?? DEFAULT_BASE_URL);
    const url = new URL(path, `${baseUrl}/`);
    const headers: Record<string, string> = { Accept: "application/json", ...init.headers };
    if (init.accessToken) headers["Access-Token"] = init.accessToken;
    try {
      return await this.fetchImpl(url.toString(), { method: init.method, headers, ...(init.body ? { body: init.body } : {}), redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new QianchuanOfficialLiveError("QIANCHUAN_NETWORK_FAILED");
    }
  }

  private async readEnvelope(response: Response): Promise<{ data: unknown }> {
    if (response.status === 401) throw new QianchuanOfficialLiveError("QIANCHUAN_HTTP_401");
    if (response.status === 429) throw new QianchuanOfficialLiveError("QIANCHUAN_HTTP_429");
    if (!response.ok) throw new QianchuanOfficialLiveError(`QIANCHUAN_HTTP_${response.status}`);
    let body: unknown;
    try { body = parseQianchuanJson(await response.text()); } catch { throw new QianchuanOfficialLiveError("QIANCHUAN_EMPTY_RESPONSE"); }
    const record = asRecord(body);
    const code = Number(record?.code);
    if (!record || !Number.isFinite(code)) throw new QianchuanOfficialLiveError("QIANCHUAN_EMPTY_RESPONSE");
    if (code !== 0) {
      const upstreamMessage = [record.message, record.msg, record.error_message]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
      throw new QianchuanOfficialLiveError(`QIANCHUAN_TOOL_${code}`, upstreamMessage);
    }
    if (!Object.hasOwn(record, "data")) throw new QianchuanOfficialLiveError("QIANCHUAN_EMPTY_RESPONSE");
    return { data: record.data };
  }

  private async getEnvelopeData(pathWithQuery: string): Promise<unknown> {
    await this.ensureToken();
    const send = async (token: string): Promise<unknown> => {
      // 该官方 OAuth 查询端点明确要求 query token，重试必须使用续期后的值。
      const url = new URL(pathWithQuery, DEFAULT_BASE_URL);
      if (url.pathname === QIANCHUAN_ACCOUNT_ENDPOINTS.authorized) url.searchParams.set("access_token", token);
      const response = await this.request(`${url.pathname}${url.search}`, { method: "GET", accessToken: token });
      const envelope = await this.readEnvelope(response);
      return envelope.data;
    };
    const accessToken = this.tokens.accessToken;
    if (!accessToken) throw new QianchuanOfficialLiveError("QIANCHUAN_NOT_CONFIGURED");
    try {
      return await send(accessToken);
    } catch (error) {
      const refreshable = error instanceof QianchuanOfficialLiveError
        && (error.code === "QIANCHUAN_HTTP_401" || error.code === "QIANCHUAN_TOOL_40102")
        && Boolean(this.tokens.refreshToken);
      if (!refreshable) throw error;
      await this.refreshToken();
      const retryToken = this.tokens.accessToken;
      if (!retryToken) throw new QianchuanOfficialLiveError("QIANCHUAN_NOT_CONFIGURED");
      return send(retryToken);
    }
  }

  private async loadAuthorizedAwemeRows(advertiserId: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    let page = 1;
    while (true) {
      if (page > AUTHORIZED_AWEME_PAGE_LIMIT) throw new QianchuanOfficialLiveError("QIANCHUAN_LIVE_AUTHORIZED_AWEME_PAGE_LIMIT");
      const query = new URLSearchParams({
        advertiser_id: advertiserId,
        page: String(page),
        page_size: String(AUTHORIZED_AWEME_PAGE_SIZE)
      });
      const data = await this.getEnvelopeData(`${QIANCHUAN_AUTHORIZED_AWEME_ENDPOINT}?${query.toString()}`);
      const pageRows = authorizedAwemeRows(data);
      rows.push(...pageRows);
      if (!authorizedAwemePageHasMore(data, pageRows, page, AUTHORIZED_AWEME_PAGE_SIZE)) break;
      page += 1;
    }
    return rows;
  }

  private async loadAuthorizedAwemeIndex(advertiserId: string) {
    const rows = await this.loadAuthorizedAwemeRows(advertiserId);
    try {
      return buildLiveAuthorizedAwemeIndex(rows);
    } catch (error) {
      throw new QianchuanOfficialLiveError(officialErrorCode(error, "QIANCHUAN_LIVE_ANCHOR_AUTHORIZED_ID_INVALID"));
    }
  }

  private async resolveAuthorizedAwemeId(): Promise<string> {
    const config = this.config;
    if (!config?.advertiserId || !config.awemeId) throw new QianchuanOfficialLiveError("QIANCHUAN_NOT_CONFIGURED");
    const now = this.clock();
    if (
      this.authorizedCache
      && this.authorizedCache.advertiserId === config.advertiserId
      && this.authorizedCache.awemeRef === config.awemeId
      && now < this.authorizedCache.expiresAt
    ) {
      return this.authorizedCache.awemeId;
    }
    const index = await this.loadAuthorizedAwemeIndex(config.advertiserId);
    try {
      const awemeId = normalizeLiveAnchorId(config.awemeId, index);
      this.authorizedCache = {
        advertiserId: config.advertiserId,
        awemeRef: config.awemeId,
        awemeId,
        expiresAt: now + AUTHORIZED_AWEME_TTL_MS
      };
      return awemeId;
    } catch (error) {
      throw new QianchuanOfficialLiveError(officialErrorCode(error, "QIANCHUAN_LIVE_ANCHOR_REFERENCE_MISSING"));
    }
  }

  private async fetchRoomBodyWithFields(fields: readonly string[]): Promise<unknown> {
    const config = this.config;
    if (!config?.advertiserId || !config.awemeId) throw new QianchuanOfficialLiveError("QIANCHUAN_NOT_CONFIGURED");
    const awemeId = await this.resolveAuthorizedAwemeId();
    const query = new URLSearchParams({
      advertiser_id: config.advertiserId,
      aweme_id: awemeId,
      date_time: localDate(this.clock()),
      room_status: "LIVING",
      ad_status: "ALL",
      page: "1",
      page_size: "100",
      fields: JSON.stringify([...fields])
    });
    return { data: await this.getEnvelopeData(`${QIANCHUAN_OFFICIAL_LIVE_ENDPOINT}?${query.toString()}`) };
  }

  private fieldCapabilities(
    body: unknown,
    requestedFields: readonly string[],
    fallbackUsed: boolean,
    selectedRoomId?: string,
    rejectedField?: string
  ): Record<string, QianchuanLiveFieldCapability> {
    const root = asRecord(body);
    const data = asRecord(root?.data);
    const rooms = Array.isArray(data?.room_list) ? data.room_list : [];
    const livingRooms = rooms
      .map((value) => asRecord(value))
      .filter((value): value is Record<string, unknown> => value?.room_status === "LIVING");
    const room = (selectedRoomId
      ? livingRooms.find((value) => normalizedRoomId(value.room_id ?? value.roomId) === selectedRoomId)
      : livingRooms.slice().sort((left, right) => roomStartMs(right.start_time ?? right.startTime) - roomStartMs(left.start_time ?? left.startTime))[0]);
    const record = asRecord(room);
    const capabilities: Record<string, QianchuanLiveFieldCapability> = {};
    for (const field of requestedFields) capabilities[field] = record && hasValidRawMetric(record, field) ? "available" : "missing";
    for (const field of QIANCHUAN_OFFICIAL_LIVE_OPTIONAL_REQUEST_FIELDS) {
      if (requestedFields.includes(field)) continue;
      capabilities[field] = rejectedField === field ? "unsupported" : "not_requested";
    }
    return capabilities;
  }

  private async fetchRoomBody(): Promise<RoomRequestResult> {
    if (this.roomRequestFlight) return this.roomRequestFlight;
    const run = this.fetchRoomBodyInternal();
    this.roomRequestFlight = run.finally(() => { delete this.roomRequestFlight; });
    return this.roomRequestFlight;
  }

  private async fetchRoomBodyInternal(): Promise<RoomRequestResult> {
    if (this.disposed) throw new QianchuanOfficialLiveError("QIANCHUAN_SOURCE_CLOSED");
    this.lastFieldRequestState = {
      requestedFields: [...QIANCHUAN_OFFICIAL_LIVE_EXTENDED_REQUEST_FIELDS],
      fallbackUsed: false,
      capabilities: {}
    };
    try {
      const body = await this.fetchRoomBodyWithFields(QIANCHUAN_OFFICIAL_LIVE_EXTENDED_REQUEST_FIELDS);
      if (this.disposed) throw new QianchuanOfficialLiveError("QIANCHUAN_SOURCE_CLOSED");
      const capabilities = this.fieldCapabilities(body, QIANCHUAN_OFFICIAL_LIVE_EXTENDED_REQUEST_FIELDS, false);
      this.lastFieldRequestState.capabilities = capabilities;
      return { body, requestedFields: [...QIANCHUAN_OFFICIAL_LIVE_EXTENDED_REQUEST_FIELDS], fallbackUsed: false };
    } catch (error) {
      if (!isOptionalFieldRequestError(error)) throw error;
      const rejectedField = rejectedOptionalField(error);
      const body = await this.fetchRoomBodyWithFields(QIANCHUAN_OFFICIAL_LIVE_REQUEST_FIELDS);
      if (this.disposed) throw new QianchuanOfficialLiveError("QIANCHUAN_SOURCE_CLOSED");
      const capabilities = this.fieldCapabilities(body, QIANCHUAN_OFFICIAL_LIVE_REQUEST_FIELDS, true, undefined, rejectedField);
      this.lastFieldRequestState = {
        requestedFields: [...QIANCHUAN_OFFICIAL_LIVE_REQUEST_FIELDS],
        fallbackUsed: true,
        capabilities
      };
      return { body, requestedFields: [...QIANCHUAN_OFFICIAL_LIVE_REQUEST_FIELDS], fallbackUsed: true, ...(rejectedField ? { rejectedField } : {}) };
    }
  }

  private async poll(): Promise<void> {
    if (this.pollFlight) return this.pollFlight;
    const run = (async () => {
      try {
        const request = await this.fetchRoomBody();
        if (this.disposed) return;
        const observedAt = new Date(this.clock()).toISOString();
        const snapshot = parseQianchuanOfficialLiveResponse({ endpoint: QIANCHUAN_OFFICIAL_LIVE_ENDPOINT, observedAt, body: request.body });
        if (!snapshot) {
          this.lastErrorCode = "QIANCHUAN_NO_LIVING_ROOM";
          this.consecutiveFailures += 1;
          return;
        }
        this.lastSnapshot = snapshot;
        this.lastSuccessAt = observedAt;
        delete this.lastErrorCode;
        this.consecutiveFailures = 0;
        await Promise.allSettled([...this.sessions.values()].map(({ listener }) => Promise.resolve().then(() => listener(snapshot))));
      } catch (error) {
        if (this.disposed) return;
        this.lastErrorCode = safeErrorCode(error);
        this.consecutiveFailures += 1;
      }
    })();
    this.pollFlight = run.finally(() => { delete this.pollFlight; });
    return this.pollFlight;
  }
}

export function createOfficialQianchuanLiveSource(): OfficialQianchuanLiveSource {
  return new OfficialQianchuanLiveSource();
}
