export const COMPASS_PAGE = {
  id: "compass" as const,
  routeId: "compass-live-shop" as const,
  host: "compass.jinritemai.com",
  pathname: "/screen/live/shop"
};

export const COMPASS_OFFICIAL_PAGE = {
  id: "compass" as const,
  routeId: "compass-live-shop" as const,
  host: "compass.jinritemai.com",
  pathname: "/screen/live/shop-official"
};

export const QIANCHUAN_PAGE = {
  id: "qianchuan" as const,
  routeId: "qianchuan-agent" as const,
  host: "agent.oceanengine.com",
  pathname: "/admin/optimizeModule/qianchuan/"
};

export const QIANCHUAN_BOARD_PAGE = {
  id: "qianchuan" as const,
  routeId: "qianchuan-board" as const,
  host: "qianchuan.jinritemai.com",
  pathname: "/board-next"
};

export const ALLOWED_PAGES = [COMPASS_PAGE, COMPASS_OFFICIAL_PAGE, QIANCHUAN_PAGE, QIANCHUAN_BOARD_PAGE] as const;
export type AllowedPageId = (typeof ALLOWED_PAGES)[number]["id"];
export type AllowedRouteId = (typeof ALLOWED_PAGES)[number]["routeId"];
export interface ProbeSessionIdentity {
  routeId: AllowedRouteId;
  sessionId: string;
}
export interface LiveCompassMetricInput {
  observedAt: string;
  sourceEndpoint: string;
  mappingVersion: string;
  dataStatus: "fresh" | "stale" | "offline" | "unknown";
  onlineSnapshot?: number;
  sessionPaidGmvFen?: number;
  adSpendFen?: number;
  paidBuyerCount?: number;
  paidItemCount?: number;
  watchToPaidRate?: number;
  productClickToPaidRate?: number;
  roomEnterCount5m?: number;
  userPaidGmvFen5m?: number;
  productClickCount?: number;
  productPayGmvFen?: number;
  unpaidOrderCount?: number;
  productName?: string;
  currentProductName?: string;
  productPaidGmvFen?: number;
  liveStatus?: "live" | "ended" | "unknown";
  windowLabel?: string;
}

export type PageAccessStatus = "allowed" | "login" | "blocked";

export interface PageAccess {
  status: PageAccessStatus;
  page: AllowedPageId | null;
  routeId: AllowedRouteId | null;
  origin: string | null;
  pathname: string | null;
  reason: string;
}

export type ProbeLifecycle = "idle" | "starting" | "active" | "stale" | "offline" | "blocked" | "stopped";
export type AudioLifecycle = "idle" | "requesting" | "authorized" | "active" | "muted" | "stale" | "offline" | "blocked" | "stopped";
export type NetworkStatus = "unknown" | "online" | "offline";

export const BUSINESS_MARKER_CODES = [
  "action_open", "action_switch", "action_refresh", "action_compare",
  "subject_product_click", "subject_conversion", "subject_ad_spend", "subject_roi",
  "subject_product_list", "subject_audience", "subject_comment", "subject_other"
] as const;
export type BusinessMarkerCode = (typeof BUSINESS_MARKER_CODES)[number];
export const SYSTEM_MARKER_CODES = [
  "refresh_observed", "network_offline", "network_online", "session_started", "network_started",
  "network_stopped", "debugger_reused", "debugger_setup_failed", "debugger_detached", "user_stopped_debugger",
  "dom_fallback_failed", "observation_failed", "page_left_allowlist", "page_login", "page_switched", "document_navigation_blocked"
] as const;
export type SystemMarkerCode = (typeof SYSTEM_MARKER_CODES)[number];
export type MarkerCode = BusinessMarkerCode | SystemMarkerCode;
export function isMarkerCode(value: unknown): value is MarkerCode {
  return typeof value === "string" && [...BUSINESS_MARKER_CODES, ...SYSTEM_MARKER_CODES].includes(value as MarkerCode);
}

export type AudioReasonCode =
  | "not_started" | "awaiting_user_authorization" | "tab_audio_authorized" | "track_continuous"
  | "track_reconnected" | "energy_observed" | "muted" | "unmuted" | "refresh_observed"
  | "tab_switched_observed" | "track_ended_needs_restart" | "audio_error_needs_restart"
  | "network_offline_observed" | "network_online_observed" | "user_stopped";
export const AUDIO_ERROR_CODES = [
  "invalid_stream_id", "get_user_media_failed", "no_audio_track", "audio_context_failed", "capture_failed",
  "offscreen_unavailable", "offscreen_response_invalid", "audio_consume_failed", "tab_capture_failed", "asr_ws_failed"
] as const;
export type AudioErrorCode = (typeof AUDIO_ERROR_CODES)[number];
export type LifecycleReasonCode =
  | "session_started" | "network_started" | "network_stopped" | "debugger_reused"
  | "debugger_setup_failed" | "debugger_detached" | "user_stopped_debugger" | "dom_fallback_failed"
  | "observation_failed" | "page_left_allowlist" | "page_login" | "page_switched" | "document_navigation_blocked";

export interface FieldShape {
  path: string;
  valueType: "string" | "number" | "boolean" | "null" | "object" | "array" | "unknown";
  sample: string;
  /** Optional bounded semantic metric code, only for an allowlisted leaf shape. */
  semanticCode?: string;
}

export interface MetricObservation {
  path: string;
  observedAt: string;
  value: number;
  /** Optional semantic code from a sibling index/metric/indicator field; runtime only. */
  semanticCode?: string;
}

export interface EndpointFieldCatalogEntry {
  path: string;
  valueType: FieldShape["valueType"];
  /** All value types observed for this path; valueType remains the first observed type for compatibility. */
  observedValueTypes?: FieldShape["valueType"][];
  /** Number of observations whose value type differed from the first observed type. */
  typeDriftCount?: number;
  semanticCode?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
}

export interface EndpointCatalogEntry {
  kind: "http" | "ws";
  phase: "request_start" | "response_metadata" | "body_shape" | "ws_frame";
  origin: string;
  pathname: string;
  fields?: EndpointFieldCatalogEntry[];
  firstObservedAt: string;
  lastObservedAt: string;
  observationCount: number;
  retainedObservationCount: number;
  droppedObservationCount: number;
  fieldOverflow: number;
}

export interface EndpointCatalogMissingGroup {
  kind: EndpointCatalogEntry["kind"];
  phase: EndpointCatalogEntry["phase"];
  origin: string;
  pathname: string;
  firstObservedAt: string;
  lastObservedAt: string;
  observationCount: number;
}

export interface EndpointCatalogOverflow {
  droppedGroupCount: number;
  missingGroups: EndpointCatalogMissingGroup[];
}

export interface MetricCatalogEntry {
  origin: string;
  pathname: string;
  path: string;
  semanticCode?: string;
  valueType: "number";
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
  increaseCount: number;
  decreaseCount: number;
  sameCount: number;
    resetCount: number;
  /** Runtime-only comparison state; never included in sanitized export. */
  lastValue?: number;
  lastValueAt?: string;
}

export interface MetricCatalogMissingMetric {
  origin: string;
  pathname: string;
  path: string;
  semanticCode?: string;
}

export interface MetricCatalogOverflow {
  droppedMetricCount: number;
  missingMetrics: MetricCatalogMissingMetric[];
}

export interface AudioAuditTransition {
  from: AudioLifecycle;
  to: AudioLifecycle;
  observedAt: string;
}

export interface AudioAudit {
  trackStartedAt: string | null;
  trackEndedAt: string | null;
  firstHeartbeatAt: string | null;
  lastHeartbeatAt: string | null;
  heartbeatCount: number;
  maxGapMs: number;
  transitions: AudioAuditTransition[];
}

export interface SanitizedNetworkObservation {
  kind: "http" | "ws";
  phase: "request_start" | "response_metadata" | "body_shape" | "ws_frame";
  observedAt: string;
  origin: string;
  pathname: string;
  method?: string;
  resourceType?: string;
  status?: number;
  mimeType?: string;
  direction?: "sent" | "received";
  messageBytes?: number;
  frameType?: "json" | "text" | "binary";
  fields: FieldShape[];
  /** Transient parser output; ProbeSessionStore moves it to the bounded runtime series. */
  metricObservations?: MetricObservation[];
}

export interface SanitizedTargetObservation {
  observedAt: string;
  targetType: "iframe" | "worker" | "service_worker" | "page" | "other";
  origin: string;
  pathname: string;
  lifecycle: "created" | "updated" | "destroyed";
}

export interface SanitizedDomField {
  label: string;
  selectorDigest: string;
  valueType: string;
  refreshCount: number;
  lastSeen: string;
  status: "fresh" | "stale" | "offline";
}

export interface AudioStatus {
  captureLifecycle: AudioLifecycle;
  networkStatus: NetworkStatus;
  observedAt: string;
  trackCount: number;
  muted: boolean;
  energyBand: "silent" | "low" | "normal" | "unknown";
  activeSeconds: number;
  userPlayback: "preserved" | "unknown";
  reason: AudioReasonCode;
  lastRefreshObservedAt: string | null;
  lastNetworkChangedAt: string | null;
  needsUserRestart: boolean;
}

export interface BusinessMarker {
  markerId: string;
  code: MarkerCode;
  createdAt: string;
}

export interface ProbeSessionExport {
  schemaVersion: "phase-2a-probe-v2";
  exportedAt: string;
  session: {
    page: AllowedPageId;
    routeId: AllowedRouteId;
    sessionId: string;
    origin: string;
    pathname: string;
    lifecycle: ProbeLifecycle;
    startedAt: string;
    lastSeenAt: string;
    network: SanitizedNetworkObservation[];
    metricObservations?: MetricObservation[];
    endpointCatalog?: EndpointCatalogEntry[];
    endpointCatalogOverflow?: EndpointCatalogOverflow;
    metricCatalog?: MetricCatalogEntry[];
    metricCatalogOverflow?: MetricCatalogOverflow;
    targets: SanitizedTargetObservation[];
    dom: SanitizedDomField[];
    audio: AudioStatus;
    audioAudit?: AudioAudit;
    markers: BusinessMarker[];
  };
}

export interface RuntimeProbeState {
  tabId: number;
  access: PageAccess;
  session: ProbeSessionExport["session"];
  debuggerAttached: boolean;
  domFallbackEnabled: boolean;
}

export type ProbeMessage =
  | { type: "probe:get_state"; tabId?: number }
  | { type: "probe:start_live"; tabId: number; url: string }
  | { type: "probe:stop_live"; tabId?: number }
  | { type: "probe:start_network"; tabId: number; url: string }
  | { type: "probe:stop_network"; tabId?: number }
  | { type: "probe:start_audio"; tabId: number; url: string }
  | { type: "probe:stop_audio"; tabId?: number }
  | { type: "probe:collect_dom"; tabId?: number }
  | { type: "probe:add_marker"; tabId?: number; code: BusinessMarkerCode }
  | { type: "probe:export"; tabId?: number }
  | { type: "probe:recover_source"; tabId: number; source: "qianchuan" | "compass"; confirm: boolean };

export interface RuntimeResponse {
  ok: boolean;
  state?: RuntimeProbeState | null;
  export?: ProbeSessionExport;
  error?: string;
  warning?: string;
  errorCode?: AudioErrorCode;
  live?: { sessionId: string; dashboardPath: string };
  resumableLive?: { sessionId: string; dashboardPath: string };
}

export interface DomFieldCandidate {
  label: string;
  selector: string;
  valueType: string;
}
