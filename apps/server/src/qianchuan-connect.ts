import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";

export const QIANCHUAN_AUTH_ORIGIN = "https://qianchuan.jinritemai.com";
export const QIANCHUAN_AUTH_PATH = "/openapi/qc/audit/oauth.html";
export const QIANCHUAN_CALLBACK_URL = "http://127.0.0.1:18889/qianchuan/callback";
export const QIANCHUAN_TOKEN_ENDPOINT = "https://api.oceanengine.com/open_api/oauth2/access_token/";
// 客户型自研应用：账户发现（客户／店铺／工作台）及直播读取；不可请求代理商专属权限。
export const QIANCHUAN_AUTH_SCOPE = JSON.stringify([20101000, 20121100, 200000011, 21121000, 22100400]);
export const QIANCHUAN_TOKEN_STORE_VERSION = 1 as const;
export const QIANCHUAN_AUTH_TTL_MS = 10 * 60_000;

const APP_ID_KEY = "QIANCHUAN_API_APP_ID";
const APP_SECRET_KEY = "QIANCHUAN_API_APP_SECRET";
const ADVERTISER_ID_KEY = "QIANCHUAN_ADVERTISER_ID";
const AWEME_ID_KEY = "QIANCHUAN_AWEME_ID";
const TOKEN_STORE_PATH_KEY = "QIANCHUAN_API_TOKEN_STORE_PATH";
const TOKEN_KEYS_TO_REMOVE = [
  "QIANCHUAN_API_ACCESS_TOKEN",
  "QIANCHUAN_API_REFRESH_TOKEN",
  "QIANCHUAN_API_TOKEN_EXPIRES_AT",
  "QIANCHUAN_API_REFRESH_TOKEN_EXPIRES_AT"
] as const;

export type QianchuanConnectConfig = {
  appId: string;
  appSecret: string;
  advertiserId: string;
  awemeId: string;
  envPath: string;
  tokenStorePath: string;
};

export type QianchuanTokenStore = {
  version: typeof QIANCHUAN_TOKEN_STORE_VERSION;
  appIdentityHash: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
};

export type QianchuanConnectOptions = {
  projectRoot: string;
  appEnvPath?: string;
  advertiserId?: string;
  awemeId?: string;
};

export type QianchuanConnectCliOptions = {
  check: boolean;
  help: boolean;
  appEnvPath?: string;
  advertiserId?: string;
  awemeId?: string;
};

export type QianchuanTokenResult = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshTokenExpiresAt: string;
};

export type QianchuanConnectStatus = {
  appIdConfigured: boolean;
  appSecretConfigured: boolean;
  appConfigured: boolean;
  advertiserConfigured: boolean;
  awemeConfigured: boolean;
  bindingConfigured: boolean;
  tokenStorePresent: boolean;
  tokenStoreIdentityMatches: boolean;
  accessTokenExpiry: "missing" | "valid" | "expired" | "invalid";
  refreshTokenExpiry: "missing" | "valid" | "expired" | "invalid";
};

export class QianchuanConnectError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QianchuanConnectError";
  }
}

function error(code: string): QianchuanConnectError {
  return new QianchuanConnectError(code);
}

function trimmed(value: string | undefined): string {
  if (value && /[\u0000\r\n]/.test(value)) throw error("QIANCHUAN_ARGUMENT_INVALID");
  return value?.trim() ?? "";
}

function safeText(value: string, maxLength: number, code: string): string {
  if (/[\u0000\r\n]/.test(value)) throw error(code);
  const result = value.trim();
  if (!result || result.length > maxLength) throw error(code);
  return result;
}

function safeAppSecret(value: string): string {
  const result = safeText(value, 2048, "QIANCHUAN_APP_SECRET_INVALID");
  if (result.includes("'")) throw error("QIANCHUAN_APP_SECRET_INVALID");
  return result;
}

export function isPositiveDecimal(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function isValidAppId(value: string): boolean {
  return isPositiveDecimal(value) && Number.isSafeInteger(Number(value));
}

export function isValidAwemeReference(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && !/[\s\u0000\r\n]/.test(value);
}

/** 只解析赋值，不执行 shell；调用方会按白名单读取字段。 */
function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseEnv(text);
  } catch {
    throw error("QIANCHUAN_ENV_READ_FAILED");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && !/[\u0000\r\n]/.test(value)) result[key] = value;
  }
  return result;
}

export async function readEnvFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvText(await readFile(path, "utf8"));
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return {};
    throw error("QIANCHUAN_ENV_READ_FAILED");
  }
}

function valueFromSources(key: string, ...sources: Array<Record<string, string | undefined>>): string {
  for (const source of sources) {
    const raw = source[key];
    if (raw && /[\u0000\r\n]/.test(raw)) throw error("QIANCHUAN_ENV_VALUE_INVALID");
    const value = trimmed(raw);
    if (value) return value;
  }
  return "";
}

function appIdentityHash(appId: string, appSecret: string): string {
  return createHash("sha256").update(appId).update("\0").update(appSecret).digest("hex");
}

export function defaultQianchuanTokenStorePath(projectRoot: string): string {
  return resolve(projectRoot, ".runtime/qianchuan-tokens.json");
}

export async function resolveQianchuanConnectConfig(options: QianchuanConnectOptions): Promise<QianchuanConnectConfig> {
  const envPath = join(options.projectRoot, ".env");
  const projectEnv = await readEnvFile(envPath);
  const processEnv = process.env;
  const appEnv = options.appEnvPath ? await readEnvFile(resolve(options.projectRoot, options.appEnvPath)) : {};

  const appId = valueFromSources(APP_ID_KEY, appEnv, processEnv, projectEnv);
  const appSecret = valueFromSources(APP_SECRET_KEY, appEnv, processEnv, projectEnv);
  const advertiserId = trimmed(options.advertiserId) || valueFromSources(ADVERTISER_ID_KEY, processEnv, projectEnv);
  const awemeId = trimmed(options.awemeId) || valueFromSources(AWEME_ID_KEY, processEnv, projectEnv);

  if (!isValidAppId(appId)) throw error("QIANCHUAN_APP_ID_INVALID");
  safeAppSecret(appSecret);
  if (!isPositiveDecimal(advertiserId)) throw error("QIANCHUAN_ADVERTISER_ID_INVALID");
  if (!isValidAwemeReference(awemeId)) throw error("QIANCHUAN_AWEME_ID_INVALID");

  const tokenStorePath = defaultQianchuanTokenStorePath(options.projectRoot);
  return { appId, appSecret, advertiserId, awemeId, envPath, tokenStorePath };
}

export function buildQianchuanAuthUrl(appId: string, state: string): string {
  if (!isValidAppId(appId)) throw error("QIANCHUAN_APP_ID_INVALID");
  if (!/^[a-f0-9]{64}$/.test(state)) throw error("QIANCHUAN_STATE_INVALID");
  const url = new URL(QIANCHUAN_AUTH_PATH, QIANCHUAN_AUTH_ORIGIN);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", QIANCHUAN_CALLBACK_URL);
  url.searchParams.set("scope", QIANCHUAN_AUTH_SCOPE);
  return url.toString();
}

export function createQianchuanState(): string {
  return randomBytes(32).toString("hex");
}

function parseExpiry(value: unknown, nowMs: number): string | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(nowMs + seconds * 1000).toISOString();
}

function isSafeToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\u0000\r\n]/.test(value);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function exchangeQianchuanAuthCode(input: {
  appId: string;
  appSecret: string;
  authCode: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<QianchuanTokenResult> {
  if (!isValidAppId(input.appId)) throw error("QIANCHUAN_APP_ID_INVALID");
  safeAppSecret(input.appSecret);
  const authCode = safeText(input.authCode, 8192, "QIANCHUAN_AUTH_CODE_INVALID");
  const body = {
    grant_type: "auth_code",
    app_id: Number(input.appId),
    secret: input.appSecret,
    auth_code: authCode
  };
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(QIANCHUAN_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    throw error("QIANCHUAN_OAUTH_NETWORK");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw error("QIANCHUAN_OAUTH_RESPONSE_INVALID");
  }
  if (!response.ok) throw error(`QIANCHUAN_OAUTH_HTTP_${response.status}`);
  const envelope = objectRecord(payload);
  if (envelope?.code !== 0) throw error("QIANCHUAN_OAUTH_REJECTED");
  const data = objectRecord(envelope.data);
  const accessToken = data && isSafeToken(data.access_token) ? data.access_token : "";
  const refreshToken = data && isSafeToken(data.refresh_token) ? data.refresh_token : "";
  const nowMs = input.now?.() ?? Date.now();
  const expiresAt = parseExpiry(data?.expires_in, nowMs);
  const refreshTokenExpiresAt = parseExpiry(data?.refresh_token_expires_in, nowMs);
  if (!accessToken || !refreshToken || !expiresAt || !refreshTokenExpiresAt) throw error("QIANCHUAN_OAUTH_RESPONSE_INVALID");
  return { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt };
}

function shellQuote(value: string): string {
  if (!value || /[\u0000\r\n']/.test(value)) throw error("QIANCHUAN_ENV_VALUE_INVALID");
  return `'${value}'`;
}

function assignmentKey(line: string): string | undefined {
  return /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1];
}

export function updateQianchuanEnvText(
  original: string,
  updates: Record<string, string>,
  removeKeys: readonly string[] = TOKEN_KEYS_TO_REMOVE
): string {
  const remove = new Set(removeKeys);
  const lines = original ? original.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const line of lines) {
    const key = assignmentKey(line);
    if (!key) {
      output.push(line);
      continue;
    }
    if (remove.has(key)) continue;
    const value = updates[key];
    if (value !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(`${key}=${shellQuote(value)}`);
      continue;
    }
    output.push(line);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) output.push(`${key}=${shellQuote(value)}`);
  }
  let result = output.join("\n");
  if (result && !result.endsWith("\n")) result += "\n";
  return result;
}

export async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
    await chmod(path, mode);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

export async function persistQianchuanTokens(app: { appId: string; appSecret: string }, tokens: QianchuanTokenResult, path: string): Promise<void> {
  const payload: QianchuanTokenStore = {
    version: QIANCHUAN_TOKEN_STORE_VERSION,
    appIdentityHash: appIdentityHash(app.appId, app.appSecret),
    ...tokens
  };
  await atomicWrite(path, `${JSON.stringify(payload)}\n`);
}

export async function persistQianchuanConnectResult(input: {
  config: QianchuanConnectConfig;
  tokens: QianchuanTokenResult;
}): Promise<void> {
  const identity = appIdentityHash(input.config.appId, input.config.appSecret);
  const payload: QianchuanTokenStore = {
    version: QIANCHUAN_TOKEN_STORE_VERSION,
    appIdentityHash: identity,
    accessToken: input.tokens.accessToken,
    refreshToken: input.tokens.refreshToken,
    expiresAt: input.tokens.expiresAt,
    refreshTokenExpiresAt: input.tokens.refreshTokenExpiresAt
  };
  let existing = "";
  try {
    existing = await readFile(input.config.envPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw error("QIANCHUAN_ENV_READ_FAILED");
  }
  const envText = updateQianchuanEnvText(existing, {
    [APP_ID_KEY]: input.config.appId,
    [APP_SECRET_KEY]: input.config.appSecret,
    [ADVERTISER_ID_KEY]: input.config.advertiserId,
    [AWEME_ID_KEY]: input.config.awemeId,
    [TOKEN_STORE_PATH_KEY]: input.config.tokenStorePath
  });
  await atomicWrite(input.config.tokenStorePath, `${JSON.stringify(payload)}\n`, 0o600);
  try {
    await atomicWrite(input.config.envPath, envText, 0o600);
  } catch {
    throw error("QIANCHUAN_CONFIG_PERSIST_FAILED");
  }
}

function expiryStatus(value: unknown, nowMs: number): QianchuanConnectStatus["accessTokenExpiry"] {
  if (typeof value !== "string" || !value) return "missing";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "invalid";
  return parsed > nowMs ? "valid" : "expired";
}

async function readTokenStore(path: string): Promise<{ present: boolean; valid: boolean; store?: QianchuanTokenStore }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const record = objectRecord(parsed);
    if (!record || record.version !== QIANCHUAN_TOKEN_STORE_VERSION || typeof record.appIdentityHash !== "string" || !isSafeToken(record.accessToken)) {
      return { present: true, valid: false };
    }
    return {
      present: true,
      valid: true,
      store: {
        version: QIANCHUAN_TOKEN_STORE_VERSION,
        appIdentityHash: record.appIdentityHash,
        accessToken: record.accessToken,
        ...(isSafeToken(record.refreshToken) ? { refreshToken: record.refreshToken } : {}),
        ...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {}),
        ...(typeof record.refreshTokenExpiresAt === "string" ? { refreshTokenExpiresAt: record.refreshTokenExpiresAt } : {})
      }
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return { present: false, valid: false };
    return { present: true, valid: false };
  }
}

export async function inspectQianchuanConnectStatus(options: QianchuanConnectOptions, nowMs = Date.now()): Promise<QianchuanConnectStatus> {
  const envPath = join(options.projectRoot, ".env");
  const projectEnv = await readEnvFile(envPath);
  const processEnv = process.env;
  const appEnv = options.appEnvPath ? await readEnvFile(resolve(options.projectRoot, options.appEnvPath)) : {};
  const appId = valueFromSources(APP_ID_KEY, appEnv, processEnv, projectEnv);
  const appSecret = valueFromSources(APP_SECRET_KEY, appEnv, processEnv, projectEnv);
  const advertiserId = trimmed(options.advertiserId) || valueFromSources(ADVERTISER_ID_KEY, processEnv, projectEnv);
  const awemeId = trimmed(options.awemeId) || valueFromSources(AWEME_ID_KEY, processEnv, projectEnv);
  const tokenStorePath = defaultQianchuanTokenStorePath(options.projectRoot);
  const store = await readTokenStore(tokenStorePath);
  const identityMatches = store.valid && store.store
    ? store.store.appIdentityHash === appIdentityHash(appId, appSecret)
    : false;
  return {
    appIdConfigured: isValidAppId(appId),
    appSecretConfigured: Boolean(appSecret) && !/[\u0000\r\n]/.test(appSecret),
    appConfigured: isValidAppId(appId) && Boolean(appSecret) && !/[\u0000\r\n]/.test(appSecret),
    advertiserConfigured: isPositiveDecimal(advertiserId),
    awemeConfigured: isValidAwemeReference(awemeId),
    bindingConfigured: isPositiveDecimal(advertiserId) && isValidAwemeReference(awemeId),
    tokenStorePresent: store.present,
    tokenStoreIdentityMatches: identityMatches,
    accessTokenExpiry: identityMatches ? expiryStatus(store.store?.expiresAt, nowMs) : "missing",
    refreshTokenExpiry: identityMatches ? expiryStatus(store.store?.refreshTokenExpiresAt, nowMs) : "missing"
  };
}

function responseHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    connection: "close"
  };
}

function sendCallbackResponse(response: ServerResponse, status: number, message: string, returnUrl?: string): void {
  response.writeHead(returnUrl ? 303 : status, { ...responseHeaders(), ...(returnUrl ? { Location: returnUrl } : {}) });
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>千川授权</title><h1>${message}</h1><p>请返回副驾查看结果，此页面可以关闭。</p></html>`);
}

function requestIsLocal(request: IncomingMessage, hostLoopbackPublished: boolean): boolean {
  return (hostLoopbackPublished || request.socket.remoteAddress === "127.0.0.1") && request.headers.host === "127.0.0.1:18889";
}

function allowedQueryKeys(url: URL, allowed: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const key of url.searchParams.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].every(([key, count]) => allowed.includes(key) && count === 1);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    try {
      server.close(() => resolveClose());
    } catch {
      resolveClose();
    }
    server.closeIdleConnections?.();
    const drain = setTimeout(() => server.closeAllConnections?.(), 1000);
    drain.unref?.();
  });
}

export type QianchuanAuthorizationRunOptions = {
  config: QianchuanConnectConfig | { appId: string; appSecret: string };
  /** 网页先取得授权，再选业务绑定；与 CLI 复用同一个回调接收器。 */
  save?: (tokens: QianchuanTokenResult) => Promise<void>;
  onAuthUrl?: (authUrl: string, expiresAt: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  /** 只供 Docker 127.0.0.1:18889:18889 发布模式使用，公网模式禁止开启。 */
  hostLoopbackPublished?: boolean;
  /** 测试容器入口规则时仍把实际监听限制在本机。 */
  listenHost?: "127.0.0.1";
  returnUrl?: string;
  beforeExchange?: () => Promise<void>;
};

/** 启动一次性的本机回调监听；只在 token 已原子落盘并更新配置后 resolve。 */
export function runQianchuanAuthorization(options: QianchuanAuthorizationRunOptions): Promise<QianchuanTokenResult> {
  if (!options.save && !("envPath" in options.config)) throw error("QIANCHUAN_NOT_CONFIGURED");
  if (options.returnUrl) {
    const target = new URL(options.returnUrl);
    if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
      || target.pathname !== "/live/connect" || target.search || target.hash || target.username || target.password) throw error("QIANCHUAN_RETURN_URL_INVALID");
  }
  const now = options.now ?? Date.now;
  const state = createQianchuanState();
  const expiresAtMs = now() + QIANCHUAN_AUTH_TTL_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const authUrl = buildQianchuanAuthUrl(options.config.appId, state);

  return new Promise((resolveRun, rejectRun) => {
    let server: Server | undefined;
    let claimed = false;
    let finished = false;
    const abortHandler = () => finish(undefined, error("QIANCHUAN_AUTH_CANCELLED"));
    const finish = (result?: QianchuanTokenResult, failure?: QianchuanConnectError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortHandler);
      const activeServer = server;
      server = undefined;
      const complete = () => failure ? rejectRun(failure) : resolveRun(result as QianchuanTokenResult);
      if (activeServer) void closeServer(activeServer).finally(complete);
      else complete();
    };
    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (!requestIsLocal(request, options.hostLoopbackPublished === true) || !request.url?.startsWith("/") || request.url.startsWith("//") || request.url.length > 8192) {
        sendCallbackResponse(response, 400, "无效的本机回调请求");
        return;
      }
      if (request.method !== "GET") {
        sendCallbackResponse(response, 405, "不支持的请求方式");
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url, QIANCHUAN_CALLBACK_URL);
      } catch {
        sendCallbackResponse(response, 400, "无效的授权地址");
        return;
      }
      if (url.origin !== "http://127.0.0.1:18889" || url.pathname !== "/qianchuan/callback") {
        sendCallbackResponse(response, 404, "此页面不存在");
        return;
      }
      if (finished || claimed) {
        sendCallbackResponse(response, 409, "本次授权已结束");
        return;
      }
      const stateMatches = url.searchParams.getAll("state").length === 1 && url.searchParams.get("state") === state;
      if (!stateMatches || !allowedQueryKeys(url, ["state", "auth_code", "error", "error_description"])) {
        sendCallbackResponse(response, 400, "授权信息不匹配，请重新授权");
        return;
      }
      const hasError = url.searchParams.getAll("error").length === 1 && url.searchParams.has("error");
      const hasCode = url.searchParams.getAll("auth_code").length === 1 && Boolean(url.searchParams.get("auth_code"));
      if (hasError && !hasCode && url.searchParams.getAll("auth_code").length === 0) {
        claimed = true;
        sendCallbackResponse(response, 400, "本次授权未通过", options.returnUrl);
        finish(undefined, error("QIANCHUAN_AUTH_DECLINED"));
        return;
      }
      if (!hasCode || hasError || url.searchParams.getAll("error").length > 0) {
        sendCallbackResponse(response, 400, "授权信息不匹配，请重新授权");
        return;
      }
      const authCode = url.searchParams.get("auth_code") ?? "";
      try {
        safeText(authCode, 8192, "QIANCHUAN_AUTH_CODE_INVALID");
      } catch {
        sendCallbackResponse(response, 400, "授权信息不匹配，请重新授权");
        return;
      }
      claimed = true;
      try {
        await options.beforeExchange?.();
        if (finished || options.signal?.aborted || now() >= expiresAtMs) {
          response.destroy();
          if (!finished) finish(undefined, error("QIANCHUAN_AUTH_EXPIRED"));
          return;
        }
        const tokens = await exchangeQianchuanAuthCode({
          appId: options.config.appId,
          appSecret: options.config.appSecret,
          authCode,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          now
        });
        if (finished || options.signal?.aborted) {
          response.destroy();
          return;
        }
        if (now() >= expiresAtMs) {
          response.destroy();
          finish(undefined, error("QIANCHUAN_AUTH_EXPIRED"));
          return;
        }
        // 从提交开始不再接受取消，避免告诉用户已取消却仍保存凭据。
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abortHandler);
        if (options.save) await options.save(tokens);
        else if ("envPath" in options.config) await persistQianchuanConnectResult({ config: options.config, tokens });
        sendCallbackResponse(response, 200, "授权已保存，请返回副驾；此页面可以关闭", options.returnUrl);
        finish(tokens);
      } catch (cause) {
        if (finished) {
          response.destroy();
          return;
        }
        const failure = cause instanceof QianchuanConnectError ? cause : error("QIANCHUAN_SAVE_FAILED");
        sendCallbackResponse(response, 500, failure.code === "QIANCHUAN_CONFIG_PERSIST_FAILED"
          ? "授权配置未完成，请返回副驾查看"
          : "授权未保存，请返回副驾查看", options.returnUrl);
        finish(undefined, failure);
      }
    };
    server = createServer((request, response) => { void handle(request, response); });
    server.on("error", (cause: NodeJS.ErrnoException) => {
      finish(undefined, error(cause.code === "EADDRINUSE" ? "QIANCHUAN_CALLBACK_PORT_BUSY" : "QIANCHUAN_CALLBACK_LISTENER_FAILED"));
    });
    const timer = setTimeout(() => finish(undefined, error("QIANCHUAN_AUTH_EXPIRED")), Math.max(1, expiresAtMs - now()));
    timer.unref?.();
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    if (options.signal?.aborted) abortHandler();
    if (finished) return;
    server.listen(18889, options.listenHost ?? (options.hostLoopbackPublished ? "0.0.0.0" : "127.0.0.1"), () => {
      if (!finished) options.onAuthUrl?.(authUrl, expiresAt);
    });
  });
}

export function parseQianchuanConnectArgs(argv: readonly string[]): QianchuanConnectCliOptions {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        check: { type: "boolean", short: "c" },
        help: { type: "boolean", short: "h" },
        "app-env": { type: "string" },
        "advertiser-id": { type: "string" },
        "aweme-id": { type: "string" }
      },
      allowPositionals: false,
      strict: true
    });
    const appEnvPath = values["app-env"];
    const advertiserId = values["advertiser-id"];
    const awemeId = values["aweme-id"];
    return {
      check: values.check === true,
      help: values.help === true,
      ...(typeof appEnvPath === "string" ? { appEnvPath } : {}),
      ...(typeof advertiserId === "string" ? { advertiserId } : {}),
      ...(typeof awemeId === "string" ? { awemeId } : {})
    };
  } catch {
    throw error("QIANCHUAN_ARGUMENT_INVALID");
  }
}

export function qianchuanConnectErrorCode(cause: unknown): string {
  return cause instanceof QianchuanConnectError && /^QIANCHUAN_[A-Z0-9_]+$/.test(cause.code)
    ? cause.code
    : "QIANCHUAN_FAILED";
}
