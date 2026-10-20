const LOCAL_API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";
const LOCAL_WS = process.env.NEXT_PUBLIC_WS_URL ?? "ws://127.0.0.1:4100";

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function resolveLiveBackend(
  location: { protocol: string; hostname: string },
  fallback: { api: string; ws: string } = { api: LOCAL_API, ws: LOCAL_WS }
): { api: string; ws: string } {
  if (isLoopbackHost(location.hostname)) return fallback;
  const http = location.protocol === "https:" ? "https:" : "http:";
  const ws = location.protocol === "https:" ? "wss:" : "ws:";
  return { api: `${http}//${location.hostname}:4100`, ws: `${ws}//${location.hostname}:4100` };
}

/** 同事观看固定走 /live/current，不绑当场 sessionId。 */
export function lanColleagueWatchUrl(shareOrigin: string): string {
  return `${shareOrigin.trim().replace(/\/+$/, "")}/live/current`;
}
