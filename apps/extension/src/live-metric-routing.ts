import {
  parseCompassLiveJsonResponse,
  parseCompassLiveResponse,
  parseQianchuanStatQuery,
  type CompassLiveResponse,
  type QianchuanLiveResponse
} from "@live-growth/source-adapters/live-browser";
export type BrowserMetricObservation = CompassLiveResponse & { direction?: "received" | "sent" | "binary" };
export type BrowserMetricSnapshot = NonNullable<ReturnType<typeof parseCompassLiveJsonResponse>> | NonNullable<ReturnType<typeof parseQianchuanStatQuery>>;

/** Route-specific parser gate: no endpoint-agnostic or cross-page fallback. */
export function parseLiveMetricForRoute(routeId: string, input: BrowserMetricObservation): BrowserMetricSnapshot | null {
  // HTTP response bodies have no direction. For WS, only a received JSON
  // frame is eligible; sent, binary and other frame kinds are fail-closed.
  if (input.direction !== undefined && input.direction !== "received") return null;
  if (routeId === "compass-live-shop") {
    return parseCompassLiveJsonResponse(input) ?? parseCompassLiveResponse(input);
  }
  if (routeId === "qianchuan-board") {
    return parseQianchuanStatQuery(input as QianchuanLiveResponse);
  }
  return null;
}
