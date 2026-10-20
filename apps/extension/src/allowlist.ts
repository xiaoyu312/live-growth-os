import { ALLOWED_PAGES, type AllowedPageId, type AllowedRouteId, type PageAccess } from "./types.js";

const DYNAMIC_PATH_SEGMENT = "[dynamic-segment]";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_HEX_PATTERN = /[0-9a-f]{16,}/i;
const LONG_DIGIT_PATTERN = /\d{6,}/;

function matchesPath(pathname: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname === `${prefix}/`;
}

function pageForLocation(url: URL): (typeof ALLOWED_PAGES)[number] | null {
  if (url.protocol !== "https:" || url.port !== "") return null;
  return ALLOWED_PAGES.find((candidate) => candidate.host === url.hostname && matchesPath(url.pathname, candidate.pathname)) ?? null;
}

function isDynamicPathSegment(segment: string): boolean {
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch { /* keep the encoded segment for conservative matching */ }
  return UUID_PATTERN.test(decoded)
    || LONG_DIGIT_PATTERN.test(decoded)
    || LONG_HEX_PATTERN.test(decoded)
    || decoded.length >= 20;
}

export function sanitizePathname(pathname: string): string {
  return pathname.split("/").map((segment) => isDynamicPathSegment(segment) ? DYNAMIC_PATH_SEGMENT : segment).join("/");
}

export function sanitizePageUrl(value: string | URL): { origin: string; pathname: string } | null {
  try {
    const url = typeof value === "string" ? new URL(value) : value;
    if (url.protocol !== "https:" || url.port !== "") return null;
    return { origin: url.origin, pathname: sanitizePathname(url.pathname) };
  } catch {
    return null;
  }
}

/**
 * WebSocket observations have a separate, narrower scheme boundary. Page
 * allowlisting remains HTTPS-only; only the known Compass WSS origin is
 * retained for transient WS endpoint observations.
 */
export function sanitizeCompassWebSocketUrl(value: string | URL): { origin: string; pathname: string } | null {
  try {
    const url = typeof value === "string" ? new URL(value) : value;
    if (url.protocol !== "wss:" || url.hostname !== "compass.jinritemai.com" || url.port !== "" || url.username || url.password) return null;
    return { origin: url.origin, pathname: sanitizePathname(url.pathname) };
  } catch {
    return null;
  }
}

export function isAllowedOrigin(value: string | URL): boolean {
  try {
    const url = typeof value === "string" ? new URL(value) : value;
    return url.protocol === "https:" && url.port === "" && ALLOWED_PAGES.some((page) => page.host === url.hostname);
  } catch {
    return false;
  }
}

export function classifyPageUrl(value: string | URL | null | undefined): PageAccess {
  if (!value) return { status: "blocked", page: null, routeId: null, origin: null, pathname: null, reason: "缺少当前 Tab URL" };
  let url: URL;
  try { url = typeof value === "string" ? new URL(value) : value; }
  catch { return { status: "blocked", page: null, routeId: null, origin: null, pathname: null, reason: "URL 格式无效" }; }
  const sanitized = sanitizePageUrl(url);
  if (!sanitized) return { status: "blocked", page: null, routeId: null, origin: null, pathname: null, reason: "仅允许 HTTPS 页面和默认端口" };
  const page = pageForLocation(url);
  const loginPage = page ?? ALLOWED_PAGES.find((candidate) => candidate.host === url.hostname && url.port === "" && url.pathname.startsWith(`${candidate.pathname}/`)) ?? null;
  if (loginPage && /\/(?:login|passport|auth)(?:\/|$)/i.test(url.pathname)) {
    return { status: "login", page: loginPage.id, routeId: loginPage.routeId, ...sanitized, reason: "当前页面疑似登录或认证页" };
  }
  if (!page) return { status: "blocked", page: null, routeId: null, ...sanitized, reason: "页面不在 Phase 2A 白名单" };
  return { status: "allowed", page: page.id, routeId: page.routeId, ...sanitized, reason: "页面命中 Phase 2A 白名单" };
}

export function sameRouteIdentity(left: Pick<PageAccess, "routeId"> | null, right: Pick<PageAccess, "routeId"> | null): boolean {
  return left?.routeId !== null && left?.routeId !== undefined && left.routeId === right?.routeId;
}

export function audioCaptureAllowedRoute(routeId: AllowedRouteId | null): routeId is "compass-live-shop" {
  return routeId === "compass-live-shop";
}

export function navigationDecision(value: string | URL | null | undefined): { allowed: boolean; shouldRevoke: boolean; status: PageAccess["status"]; access: PageAccess } {
  const access = classifyPageUrl(value);
  return { allowed: access.status === "allowed", shouldRevoke: access.status !== "allowed", status: access.status, access };
}

export function pageDisplayName(page: AllowedPageId | AllowedRouteId | null, routeId: AllowedRouteId | null = null): string {
  const selectedRoute = routeId ?? (page === "compass-live-shop" || page === "qianchuan-agent" || page === "qianchuan-board" ? page : null);
  if (selectedRoute === "compass-live-shop") return "罗盘经营页";
  if (selectedRoute === "qianchuan-agent") return "千川投放后台";
  if (selectedRoute === "qianchuan-board") return "千川独立直播大屏";
  if (page === "compass") return "罗盘经营页";
  if (page === "qianchuan") return "千川独立投放页";
  return "未确认页面";
}
