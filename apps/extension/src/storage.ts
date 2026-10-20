import { initialAudioStatus } from "./audio.js";
import { classifyPageUrl } from "./allowlist.js";
import { isMetricFieldPath, isSemanticMetricCode, isSemanticMetricPath, isValidMetricObservation } from "./sanitize.js";
import type { AudioAudit, AudioAuditTransition, AudioStatus, BusinessMarker, EndpointCatalogEntry, EndpointCatalogOverflow, EndpointFieldCatalogEntry, FieldShape, LifecycleReasonCode, MarkerCode, MetricCatalogEntry, MetricCatalogOverflow, MetricObservation, PageAccess, ProbeSessionExport, ProbeLifecycle, ProbeSessionIdentity, SanitizedDomField, SanitizedNetworkObservation, SanitizedTargetObservation } from "./types.js";

export const PROBE_STORAGE_KEY = "phase2a:probe-session:v2";
export const LEGACY_PROBE_STORAGE_KEY = "phase2a:probe-session:v1";
export const MAX_NETWORK_OBSERVATIONS = 240;
export const MAX_TARGET_OBSERVATIONS = 120;
export const MAX_DOM_FIELDS = 120;
export const MAX_MARKERS = 240;
export const MAX_METRIC_OBSERVATIONS = 240;
export const MAX_ENDPOINT_CATALOG = 64;
export const MAX_ENDPOINT_FIELDS = 64;
export const MAX_STORAGE_BYTES = 1_000_000;
const MAX_ENDPOINT_MISSING_GROUPS = 64;
const MAX_METRIC_MISSING = 64;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROUTE_IDS = new Set<ProbeSessionIdentity["routeId"]>(["compass-live-shop", "qianchuan-agent", "qianchuan-board"]);
const SESSION_LIFECYCLES = new Set<ProbeLifecycle>(["idle", "starting", "active", "stale", "offline", "blocked", "stopped"]);
const AUDIO_CAPTURE_LIFECYCLES = new Set(["idle", "requesting", "authorized", "active", "muted", "stale", "offline", "blocked", "stopped"]);
const AUDIO_KEYS = ["captureLifecycle", "networkStatus", "observedAt", "trackCount", "muted", "energyBand", "activeSeconds", "userPlayback", "reason", "lastRefreshObservedAt", "lastNetworkChangedAt", "needsUserRestart"];
const SESSION_KEYS = ["page", "routeId", "sessionId", "origin", "pathname", "lifecycle", "startedAt", "lastSeenAt", "network", "metricObservations", "endpointCatalog", "endpointCatalogOverflow", "metricCatalog", "metricCatalogOverflow", "targets", "dom", "audio", "audioAudit", "markers"];
const ENDPOINT_CATALOG_KEYS = ["kind", "phase", "origin", "pathname", "fields", "firstObservedAt", "lastObservedAt", "observationCount", "retainedObservationCount", "droppedObservationCount", "fieldOverflow"];
const ENDPOINT_FIELD_CATALOG_KEYS = ["path", "valueType", "observedValueTypes", "typeDriftCount", "semanticCode", "firstSeenAt", "lastSeenAt", "observationCount"];
const METRIC_CATALOG_KEYS = ["origin", "pathname", "path", "semanticCode", "valueType", "firstSeenAt", "lastSeenAt", "observationCount", "increaseCount", "decreaseCount", "sameCount", "resetCount", "lastValue", "lastValueAt"];
const AUDIO_AUDIT_KEYS = ["trackStartedAt", "trackEndedAt", "firstHeartbeatAt", "lastHeartbeatAt", "heartbeatCount", "maxGapMs", "transitions"];
const NETWORK_GROUP_MAX = 240;

export interface ProbeStorageArea {
  get<T extends Record<string, unknown>>(key: string): Promise<T>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export class ChromeProbeStorage implements ProbeStorageArea {
  get<T extends Record<string, unknown>>(key: string): Promise<T> { return chrome.storage.local.get<T>(key); }
  set(value: Record<string, unknown>): Promise<void> { return chrome.storage.local.set(value); }
  remove(key: string): Promise<void> { return chrome.storage.local.remove(key); }
}

export class MemoryProbeStorage implements ProbeStorageArea {
  private values = new Map<string, unknown>();
  async get<T extends Record<string, unknown>>(key: string): Promise<T> {
    const value = this.values.get(key);
    return { [key]: value } as T;
  }
  async set(value: Record<string, unknown>): Promise<void> { for (const [key, item] of Object.entries(value)) this.values.set(key, item); }
  async remove(key: string): Promise<void> { this.values.delete(key); }
}

function byteLength(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isSanitizedUrlParts(origin: unknown, pathname: unknown): boolean {
  return typeof origin === "string" && (/^https:\/\/[^/?#]+$/.test(origin) || origin === "wss://compass.jinritemai.com")
    && typeof pathname === "string" && pathname.startsWith("/") && !/[?#]/.test(`${origin}${pathname}`);
}

function isValidEndpointCatalogEntry(value: unknown): value is EndpointCatalogEntry {
  const item = record(value);
  return item !== null
    && hasOnlyKeys(item, ENDPOINT_CATALOG_KEYS)
    && (item.kind === "http" || item.kind === "ws")
    && (item.phase === "request_start" || item.phase === "response_metadata" || item.phase === "body_shape" || item.phase === "ws_frame")
    && isSanitizedUrlParts(item.origin, item.pathname)
    && typeof item.firstObservedAt === "string" && typeof item.lastObservedAt === "string"
    && isFiniteNonNegativeInteger(item.observationCount)
    && isFiniteNonNegativeInteger(item.retainedObservationCount)
    && isFiniteNonNegativeInteger(item.droppedObservationCount)
    && isFiniteNonNegativeInteger(item.fieldOverflow)
    && item.retainedObservationCount <= item.observationCount
    && item.droppedObservationCount >= item.observationCount - item.retainedObservationCount
    && (item.fields === undefined || (Array.isArray(item.fields) && item.fields.length <= MAX_ENDPOINT_FIELDS && item.fields.every((field) => isValidEndpointFieldCatalogEntry(field))));
}

function isValidEndpointFieldCatalogEntry(value: unknown): value is EndpointFieldCatalogEntry {
  const field = record(value);
  if (!field || !hasOnlyKeys(field, ENDPOINT_FIELD_CATALOG_KEYS)) return false;
  const observedValueTypes = field.observedValueTypes;
  return typeof field.path === "string"
    && /^root(?:\.(?:[A-Za-z][A-Za-z0-9_:-]{0,63})|\[\d+\])+$/.test(field.path)
    && !field.path.includes("[dynamic-key]")
    && typeof field.valueType === "string" && ["string", "number", "boolean", "null", "object", "array", "unknown"].includes(field.valueType)
    && (observedValueTypes === undefined || (Array.isArray(observedValueTypes) && observedValueTypes.length > 0 && observedValueTypes.length <= 7 && observedValueTypes.every((item) => typeof item === "string" && ["string", "number", "boolean", "null", "object", "array", "unknown"].includes(item))))
    && (field.typeDriftCount === undefined || isFiniteNonNegativeInteger(field.typeDriftCount))
    && (field.semanticCode === undefined || (typeof field.semanticCode === "string" && isSemanticMetricPath(field.path) && isSemanticMetricCode(field.semanticCode)))
    && typeof field.firstSeenAt === "string" && typeof field.lastSeenAt === "string"
    && isFiniteNonNegativeInteger(field.observationCount);
}

function isValidEndpointCatalogOverflow(value: unknown): value is EndpointCatalogOverflow {
  const overflow = record(value);
  if (!overflow || !hasOnlyKeys(overflow, ["droppedGroupCount", "missingGroups"]) || !isFiniteNonNegativeInteger(overflow.droppedGroupCount) || !Array.isArray(overflow.missingGroups) || overflow.missingGroups.length > MAX_ENDPOINT_MISSING_GROUPS) return false;
  return overflow.missingGroups.every((group) => {
    const item = record(group);
    return item !== null && hasOnlyKeys(item, ["kind", "phase", "origin", "pathname", "firstObservedAt", "lastObservedAt", "observationCount"])
      && (item.kind === "http" || item.kind === "ws")
      && (item.phase === "request_start" || item.phase === "response_metadata" || item.phase === "body_shape" || item.phase === "ws_frame")
      && isSanitizedUrlParts(item.origin, item.pathname)
      && typeof item.firstObservedAt === "string" && typeof item.lastObservedAt === "string"
      && isFiniteNonNegativeInteger(item.observationCount);
  });
}

function isValidMetricCatalogEntry(value: unknown): value is MetricCatalogEntry {
  const item = record(value);
  const semanticPath = typeof item?.path === "string" && /^root(?:\.(?:[A-Za-z][A-Za-z0-9_:-]{0,63})|\[\d+\])+$/.test(item.path) && !item.path.includes("[dynamic-key]") && typeof item.semanticCode === "string" && isSemanticMetricCode(item.semanticCode);
  return item !== null
    && hasOnlyKeys(item, METRIC_CATALOG_KEYS)
    && isSanitizedUrlParts(item.origin, item.pathname)
    && typeof item.path === "string" && (isMetricFieldPath(item.path) || semanticPath)
    && typeof item.valueType === "string" && item.valueType === "number"
    && typeof item.firstSeenAt === "string" && typeof item.lastSeenAt === "string"
    && isFiniteNonNegativeInteger(item.observationCount)
    && isFiniteNonNegativeInteger(item.increaseCount)
    && isFiniteNonNegativeInteger(item.decreaseCount)
    && isFiniteNonNegativeInteger(item.sameCount)
    && isFiniteNonNegativeInteger(item.resetCount)
    && item.increaseCount + item.decreaseCount + item.sameCount <= item.observationCount
    && item.resetCount <= item.decreaseCount
    && (item.semanticCode === undefined || (typeof item.semanticCode === "string" && (isSemanticMetricPath(item.path) || semanticPath) && isSemanticMetricCode(item.semanticCode)))
    && (item.lastValue === undefined || (typeof item.lastValue === "number" && Number.isFinite(item.lastValue)))
    && (item.lastValueAt === undefined || typeof item.lastValueAt === "string");
}

function isValidMetricCatalogOverflow(value: unknown): value is MetricCatalogOverflow {
  const overflow = record(value);
  if (!overflow || !hasOnlyKeys(overflow, ["droppedMetricCount", "missingMetrics"]) || !isFiniteNonNegativeInteger(overflow.droppedMetricCount) || !Array.isArray(overflow.missingMetrics) || overflow.missingMetrics.length > MAX_METRIC_MISSING) return false;
  return overflow.missingMetrics.every((metric) => {
    const item = record(metric);
    const validPath = typeof item?.path === "string" && /^root(?:\.(?:[A-Za-z][A-Za-z0-9_:-]{0,63})|\[\d+\])+$/.test(item.path) && !item.path.includes("[dynamic-key]");
    return item !== null && hasOnlyKeys(item, ["origin", "pathname", "path", "semanticCode"])
      && isSanitizedUrlParts(item.origin, item.pathname)
      && validPath
      && (isMetricFieldPath(item.path as string) || typeof item.semanticCode === "string" && isSemanticMetricCode(item.semanticCode));
  });
}

function isValidAudioAudit(value: unknown): value is AudioAudit {
  const audit = record(value);
  if (!audit || !hasOnlyKeys(audit, AUDIO_AUDIT_KEYS)) return false;
  const nullableString = (item: unknown): boolean => item === null || item === undefined || typeof item === "string";
  if (!nullableString(audit.trackStartedAt) || !nullableString(audit.trackEndedAt) || !nullableString(audit.firstHeartbeatAt) || !nullableString(audit.lastHeartbeatAt)) return false;
  if (!isFiniteNonNegativeInteger(audit.heartbeatCount) || typeof audit.maxGapMs !== "number" || !Number.isFinite(audit.maxGapMs) || audit.maxGapMs < 0 || !Array.isArray(audit.transitions)) return false;
  return audit.transitions.every((transition) => {
    const item = record(transition);
    return item !== null && hasOnlyKeys(item, ["from", "to", "observedAt"])
      && typeof item.from === "string" && AUDIO_CAPTURE_LIFECYCLES.has(item.from)
      && typeof item.to === "string" && AUDIO_CAPTURE_LIFECYCLES.has(item.to)
      && typeof item.observedAt === "string";
  });
}

function sessionIdentityKey(identity: ProbeSessionIdentity): string {
  return `${identity.routeId}:${identity.sessionId}`;
}

export function isProbeSessionIdentity(value: unknown): value is ProbeSessionIdentity {
  const identity = record(value);
  return identity !== null
    && ROUTE_IDS.has(identity.routeId as ProbeSessionIdentity["routeId"])
    && typeof identity.sessionId === "string"
    && SESSION_ID_PATTERN.test(identity.sessionId);
}

export function isValidProbeSession(value: unknown): value is ProbeSessionExport["session"] {
  const session = record(value);
  if (!session || !hasOnlyKeys(session, SESSION_KEYS)) return false;
  if (typeof session.page !== "string" || (session.page !== "compass" && session.page !== "qianchuan")) return false;
  if (typeof session.routeId !== "string" || typeof session.sessionId !== "string" || !SESSION_ID_PATTERN.test(session.sessionId)) return false;
  if (typeof session.origin !== "string" || typeof session.pathname !== "string" || !session.pathname.startsWith("/") || /[?#]/.test(session.origin + session.pathname)) return false;
  const access = classifyPageUrl(`${session.origin}${session.pathname}`);
  if (access.status !== "allowed" || access.page !== session.page || access.routeId !== session.routeId || access.origin !== session.origin || access.pathname !== session.pathname) return false;
  if (typeof session.lifecycle !== "string" || !SESSION_LIFECYCLES.has(session.lifecycle as ProbeLifecycle)) return false;
  if (typeof session.startedAt !== "string" || typeof session.lastSeenAt !== "string") return false;
  if (!Array.isArray(session.network) || !Array.isArray(session.targets) || !Array.isArray(session.dom) || !Array.isArray(session.markers)) return false;
  if (session.metricObservations !== undefined && (!Array.isArray(session.metricObservations) || session.metricObservations.some((item) => !isValidMetricObservation(item)))) return false;
  if (session.endpointCatalog !== undefined && (!Array.isArray(session.endpointCatalog) || session.endpointCatalog.some((item) => !isValidEndpointCatalogEntry(item)))) return false;
  if (session.endpointCatalogOverflow !== undefined && !isValidEndpointCatalogOverflow(session.endpointCatalogOverflow)) return false;
  if (session.metricCatalog !== undefined && (!Array.isArray(session.metricCatalog) || session.metricCatalog.some((item) => !isValidMetricCatalogEntry(item)))) return false;
  if (session.metricCatalogOverflow !== undefined && !isValidMetricCatalogOverflow(session.metricCatalogOverflow)) return false;
  if (session.network.some((item) => !record(item)) || session.targets.some((item) => !record(item)) || session.dom.some((item) => !record(item)) || session.markers.some((item) => !record(item))) return false;
  const audio = record(session.audio);
  return audio !== null && AUDIO_KEYS.every((key) => key in audio) && hasOnlyKeys(audio, AUDIO_KEYS)
    && (session.audioAudit === undefined || isValidAudioAudit(session.audioAudit));
}

function writeAllowed(session: ProbeSessionExport["session"], expectedIdentity: ProbeSessionIdentity, revokedSessionIds: Set<string>): boolean {
  if (!isProbeSessionIdentity(expectedIdentity)) return false;
  if (session.routeId !== expectedIdentity.routeId || session.sessionId !== expectedIdentity.sessionId) return false;
  if (revokedSessionIds.has(sessionIdentityKey(expectedIdentity))) return false;
  return session.lifecycle !== "blocked" && session.lifecycle !== "stopped";
}

function initialAudioAudit(): AudioAudit {
  return { trackStartedAt: null, trackEndedAt: null, firstHeartbeatAt: null, lastHeartbeatAt: null, heartbeatCount: 0, maxGapMs: 0, transitions: [] };
}

function endpointCatalogKey(entry: Pick<EndpointCatalogEntry, "kind" | "phase" | "origin" | "pathname">): string {
  return [entry.kind, entry.phase, entry.origin, entry.pathname].join("|");
}

function updateEndpointFields(fields: EndpointFieldCatalogEntry[], observationFields: FieldShape[], observedAt: string): { fields: EndpointFieldCatalogEntry[]; overflow: number } {
  const next = fields.map((field) => ({ ...field }));
  let overflow = 0;
  for (const field of observationFields) {
    const existing = next.find((candidate) => candidate.path === field.path);
    if (existing) {
      existing.lastSeenAt = observedAt;
      existing.observationCount += 1;
      const observedValueTypes = existing.observedValueTypes ? [...existing.observedValueTypes] : [existing.valueType];
      if (!observedValueTypes.includes(field.valueType)) {
        observedValueTypes.push(field.valueType);
        existing.observedValueTypes = observedValueTypes;
      }
      if (field.valueType !== existing.valueType) existing.typeDriftCount = (existing.typeDriftCount ?? 0) + 1;
      if (field.semanticCode && !existing.semanticCode) existing.semanticCode = field.semanticCode;
      continue;
    }
    if (next.length >= MAX_ENDPOINT_FIELDS) { overflow += 1; continue; }
    next.push({ path: field.path, valueType: field.valueType, ...(field.semanticCode ? { semanticCode: field.semanticCode } : {}), firstSeenAt: observedAt, lastSeenAt: observedAt, observationCount: 1 });
  }
  return { fields: next, overflow };
}

function updateEndpointCatalog(catalog: EndpointCatalogEntry[], observation: SanitizedNetworkObservation, currentOverflow: EndpointCatalogOverflow | undefined): { catalog: EndpointCatalogEntry[]; overflow?: EndpointCatalogOverflow } {
  const next = catalog.map((entry) => ({ ...entry }));
  const overflow: EndpointCatalogOverflow = {
    droppedGroupCount: currentOverflow?.droppedGroupCount ?? 0,
    missingGroups: (currentOverflow?.missingGroups ?? []).map((group) => ({ ...group }))
  };
  const key = endpointCatalogKey(observation);
  const existing = next.find((entry) => endpointCatalogKey(entry) === key);
  if (existing) {
    existing.lastObservedAt = observation.observedAt;
    existing.observationCount += 1;
    const fieldUpdate = updateEndpointFields(existing.fields ?? [], observation.fields, observation.observedAt);
    existing.fields = fieldUpdate.fields;
    existing.fieldOverflow += fieldUpdate.overflow;
    return { catalog: next, ...(overflow.droppedGroupCount > 0 ? { overflow } : {}) };
  }
  if (next.length >= MAX_ENDPOINT_CATALOG) {
    const missing = overflow.missingGroups.find((group) => endpointCatalogKey(group) === key);
    if (missing) {
      missing.lastObservedAt = observation.observedAt;
      missing.observationCount += 1;
    } else {
      overflow.droppedGroupCount += 1;
      if (overflow.missingGroups.length < MAX_ENDPOINT_MISSING_GROUPS) overflow.missingGroups.push({ kind: observation.kind, phase: observation.phase, origin: observation.origin, pathname: observation.pathname, firstObservedAt: observation.observedAt, lastObservedAt: observation.observedAt, observationCount: 1 });
    }
    return { catalog: next, overflow };
  }
  const fieldUpdate = updateEndpointFields([], observation.fields, observation.observedAt);
  next.push({
    kind: observation.kind,
    phase: observation.phase,
    origin: observation.origin,
    pathname: observation.pathname,
    firstObservedAt: observation.observedAt,
    lastObservedAt: observation.observedAt,
    observationCount: 1,
    retainedObservationCount: 0,
    droppedObservationCount: 0,
    fields: fieldUpdate.fields,
    fieldOverflow: fieldUpdate.overflow
  });
  return { catalog: next, ...(overflow.droppedGroupCount > 0 ? { overflow } : {}) };
}

function compactEndpointCatalog(catalog: EndpointCatalogEntry[], currentOverflow: EndpointCatalogOverflow | undefined): { catalog: EndpointCatalogEntry[]; overflow?: EndpointCatalogOverflow } {
  const bounded = catalog.slice(-MAX_ENDPOINT_CATALOG);
  const overflow: EndpointCatalogOverflow = {
    droppedGroupCount: currentOverflow?.droppedGroupCount ?? Math.max(0, catalog.length - bounded.length),
    missingGroups: (currentOverflow?.missingGroups ?? []).map((group) => ({ ...group }))
  };
  if (catalog.length > MAX_ENDPOINT_CATALOG) {
    for (const dropped of catalog.slice(0, catalog.length - MAX_ENDPOINT_CATALOG)) {
      if (overflow.missingGroups.some((group) => endpointCatalogKey(group) === endpointCatalogKey(dropped))) continue;
      if (overflow.missingGroups.length < MAX_ENDPOINT_MISSING_GROUPS) overflow.missingGroups.push({ kind: dropped.kind, phase: dropped.phase, origin: dropped.origin, pathname: dropped.pathname, firstObservedAt: dropped.firstObservedAt, lastObservedAt: dropped.lastObservedAt, observationCount: dropped.observationCount });
    }
  }
  return { catalog: bounded, ...(overflow.droppedGroupCount > 0 ? { overflow } : {}) };
}

function reconcileEndpointCatalog(catalog: EndpointCatalogEntry[], network: SanitizedNetworkObservation[]): EndpointCatalogEntry[] {
  const retained = new Map<string, number>();
  for (const observation of network) retained.set(endpointCatalogKey(observation), (retained.get(endpointCatalogKey(observation)) ?? 0) + 1);
  return catalog.map((entry) => {
    const retainedObservationCount = retained.get(endpointCatalogKey(entry)) ?? 0;
    return { ...entry, retainedObservationCount, droppedObservationCount: Math.max(0, entry.observationCount - retainedObservationCount) };
  });
}

function metricCatalogKey(entry: Pick<MetricCatalogEntry, "origin" | "pathname" | "path">): string {
  return [entry.origin, entry.pathname, entry.path].join("|");
}

function updateMetricCatalog(catalog: MetricCatalogEntry[], observation: SanitizedNetworkObservation, metrics: MetricObservation[], currentOverflow: MetricCatalogOverflow | undefined): { catalog: MetricCatalogEntry[]; overflow?: MetricCatalogOverflow } {
  const next = catalog.map((entry) => ({ ...entry }));
  const overflow: MetricCatalogOverflow = {
    droppedMetricCount: currentOverflow?.droppedMetricCount ?? 0,
    missingMetrics: (currentOverflow?.missingMetrics ?? []).map((metric) => ({ ...metric }))
  };
  for (const metric of metrics) {
    if (!isValidMetricObservation(metric)) continue;
    const key = metricCatalogKey({ origin: observation.origin, pathname: observation.pathname, path: metric.path });
    const semanticCode = metric.semanticCode ?? observation.fields.find((field) => field.path === metric.path)?.semanticCode;
    const existing = next.find((entry) => metricCatalogKey(entry) === key);
    if (!existing) {
      if (next.length >= MAX_METRIC_OBSERVATIONS) {
        const missing = overflow.missingMetrics.find((item) => metricCatalogKey(item) === key);
        if (!missing) {
          overflow.droppedMetricCount += 1;
          if (overflow.missingMetrics.length < MAX_METRIC_MISSING) overflow.missingMetrics.push({ origin: observation.origin, pathname: observation.pathname, path: metric.path, ...(semanticCode ? { semanticCode } : {}) });
        }
        continue;
      }
      next.push({ origin: observation.origin, pathname: observation.pathname, path: metric.path, ...(semanticCode ? { semanticCode } : {}), valueType: "number", firstSeenAt: metric.observedAt, lastSeenAt: metric.observedAt, observationCount: 1, increaseCount: 0, decreaseCount: 0, sameCount: 0, resetCount: 0, lastValue: metric.value, lastValueAt: metric.observedAt });
      continue;
    }
    existing.observationCount += 1;
    if (metric.observedAt < existing.firstSeenAt) existing.firstSeenAt = metric.observedAt;
    if (metric.observedAt >= existing.lastSeenAt) existing.lastSeenAt = metric.observedAt;
    if (semanticCode && !existing.semanticCode) existing.semanticCode = semanticCode;
    if (existing.lastValue === undefined || existing.lastValueAt === undefined || metric.observedAt >= existing.lastValueAt) {
      if (existing.lastValue !== undefined) {
        if (metric.value > existing.lastValue) existing.increaseCount += 1;
        else if (metric.value < existing.lastValue) {
          existing.decreaseCount += 1;
          if (metric.value === 0 && existing.lastValue !== 0) existing.resetCount += 1;
        } else existing.sameCount += 1;
      }
      existing.lastValue = metric.value;
      existing.lastValueAt = metric.observedAt;
    }
  }
  return { catalog: next, ...(overflow.droppedMetricCount > 0 ? { overflow } : {}) };
}

function compactMetricCatalog(catalog: MetricCatalogEntry[], currentOverflow: MetricCatalogOverflow | undefined): { catalog: MetricCatalogEntry[]; overflow?: MetricCatalogOverflow } {
  const bounded = catalog.slice(-MAX_METRIC_OBSERVATIONS);
  const overflow: MetricCatalogOverflow = {
    droppedMetricCount: currentOverflow?.droppedMetricCount ?? Math.max(0, catalog.length - bounded.length),
    missingMetrics: (currentOverflow?.missingMetrics ?? []).map((metric) => ({ ...metric }))
  };
  if (catalog.length > MAX_METRIC_OBSERVATIONS) {
    for (const dropped of catalog.slice(0, catalog.length - MAX_METRIC_OBSERVATIONS)) {
      if (overflow.missingMetrics.some((metric) => metricCatalogKey(metric) === metricCatalogKey(dropped))) continue;
      if (overflow.missingMetrics.length < MAX_METRIC_MISSING) overflow.missingMetrics.push({ origin: dropped.origin, pathname: dropped.pathname, path: dropped.path, ...(dropped.semanticCode ? { semanticCode: dropped.semanticCode } : {}) });
    }
  }
  return { catalog: bounded, ...(overflow.droppedMetricCount > 0 ? { overflow } : {}) };
}

function updateAudioAudit(previous: AudioStatus, nextAudio: AudioStatus, observedAt: string, currentAudit: AudioAudit | undefined): AudioAudit {
  const audit = currentAudit ? { ...currentAudit, transitions: currentAudit.transitions.map((transition) => ({ ...transition })) } : initialAudioAudit();
  if (previous.captureLifecycle !== nextAudio.captureLifecycle) {
    const transition: AudioAuditTransition = { from: previous.captureLifecycle, to: nextAudio.captureLifecycle, observedAt };
    audit.transitions = [...audit.transitions, transition].slice(-80);
  }
  if ((nextAudio.reason === "track_continuous" || nextAudio.reason === "track_reconnected") && nextAudio.captureLifecycle === "active") audit.trackStartedAt = observedAt;
  if (nextAudio.reason === "track_ended_needs_restart" || nextAudio.reason === "audio_error_needs_restart") audit.trackEndedAt = observedAt;
  if (nextAudio.reason === "energy_observed") {
    if (audit.lastHeartbeatAt) {
      const gap = Date.parse(observedAt) - Date.parse(audit.lastHeartbeatAt);
      if (Number.isFinite(gap) && gap >= 0) audit.maxGapMs = Math.max(audit.maxGapMs, gap);
    }
    audit.firstHeartbeatAt ??= observedAt;
    audit.lastHeartbeatAt = observedAt;
    audit.heartbeatCount += 1;
  }
  return audit;
}

function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items.slice();
  if (limit <= 1) return [items[0]!];
  const result: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round(index * (items.length - 1) / (limit - 1));
    result.push(items[sourceIndex]!);
  }
  return result;
}

function networkGroupKey(observation: SanitizedNetworkObservation): string {
  return [observation.kind, observation.origin, observation.pathname, observation.phase].join("|");
}

function compactNetworkObservations(observations: SanitizedNetworkObservation[]): SanitizedNetworkObservation[] {
  const order = new Map<SanitizedNetworkObservation, number>();
  observations.forEach((observation, index) => order.set(observation, index));
  const groups = new Map<string, SanitizedNetworkObservation[]>();
  for (const observation of observations) {
    const key = networkGroupKey(observation);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  const perGroupLimit = Math.max(1, Math.floor(MAX_NETWORK_OBSERVATIONS / Math.max(1, groups.size)));
  const compacted: SanitizedNetworkObservation[] = [];
  for (const [, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    compacted.push(...sampleEvenly(group, Math.min(perGroupLimit, NETWORK_GROUP_MAX)));
  }
  return compacted.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0)).slice(-MAX_NETWORK_OBSERVATIONS);
}

function compactMetricObservations(observations: MetricObservation[]): MetricObservation[] {
  const groups = new Map<string, MetricObservation[]>();
  for (const observation of observations) {
    if (!isValidMetricObservation(observation)) continue;
    const group = groups.get(observation.path) ?? [];
    group.push(observation);
    groups.set(observation.path, group);
  }
  const perPathLimit = Math.max(1, Math.floor(MAX_METRIC_OBSERVATIONS / Math.max(1, groups.size)));
  const compacted: MetricObservation[] = [];
  for (const [, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    compacted.push(...sampleEvenly(group, perPathLimit));
  }
  return compacted.slice(-MAX_METRIC_OBSERVATIONS);
}

function removeOldestFromLargestNetworkGroup(observations: SanitizedNetworkObservation[]): boolean {
  const groups = new Map<string, { count: number; firstIndex: number }>();
  observations.forEach((observation, index) => {
    const key = networkGroupKey(observation);
    const current = groups.get(key);
    if (current) current.count += 1;
    else groups.set(key, { count: 1, firstIndex: index });
  });
  const candidates = [...groups.entries()].filter(([, value]) => value.count > 1).sort(([leftKey, left], [rightKey, right]) => right.count - left.count || left.firstIndex - right.firstIndex || leftKey.localeCompare(rightKey));
  const selected = candidates[0];
  if (!selected) return false;
  const index = selected[1].firstIndex;
  observations.splice(index, 1);
  return true;
}

export function createProbeSession(access: PageAccess, startedAt: string, sessionId = crypto.randomUUID()): ProbeSessionExport["session"] {
  if (access.status !== "allowed" || !access.page || !access.routeId || !access.origin || !access.pathname) throw new Error("只能为白名单页面创建探针会话");
  const session: ProbeSessionExport["session"] = {
    page: access.page,
    routeId: access.routeId,
    sessionId,
    origin: access.origin,
    pathname: access.pathname,
    lifecycle: "starting",
    startedAt,
    lastSeenAt: startedAt,
    network: [],
    metricObservations: [],
    endpointCatalog: [],
    metricCatalog: [],
    targets: [],
    dom: [],
    audio: initialAudioStatus(startedAt),
    audioAudit: initialAudioAudit(),
    markers: []
  };
  if (!isValidProbeSession(session)) throw new Error("探针会话来源合同无效");
  return session;
}

function trimSession(session: ProbeSessionExport["session"]): ProbeSessionExport["session"] {
  const network = compactNetworkObservations(session.network);
  const endpointResult = compactEndpointCatalog(session.endpointCatalog ?? [], session.endpointCatalogOverflow);
  const metricResult = compactMetricCatalog(session.metricCatalog ?? [], session.metricCatalogOverflow);
  const trimmed: ProbeSessionExport["session"] = {
    ...session,
    network,
    metricObservations: compactMetricObservations(session.metricObservations ?? []),
    endpointCatalog: reconcileEndpointCatalog(endpointResult.catalog, network),
    ...(endpointResult.overflow ? { endpointCatalogOverflow: endpointResult.overflow } : {}),
    metricCatalog: metricResult.catalog,
    ...(metricResult.overflow ? { metricCatalogOverflow: metricResult.overflow } : {}),
    targets: session.targets.slice(-MAX_TARGET_OBSERVATIONS),
    dom: session.dom.slice(-MAX_DOM_FIELDS),
    markers: session.markers.slice(-MAX_MARKERS)
  };
  while (byteLength(trimmed) > MAX_STORAGE_BYTES && (trimmed.network.length > 0 || trimmed.targets.length > 0 || (trimmed.metricObservations?.length ?? 0) > 0)) {
    if (trimmed.network.length > 0 && removeOldestFromLargestNetworkGroup(trimmed.network)) continue;
    if (trimmed.network.length > 1) trimmed.network.shift();
    else if (trimmed.targets.length > 0) trimmed.targets.shift();
    else if ((trimmed.metricObservations?.length ?? 0) > 0) trimmed.metricObservations?.shift();
    else trimmed.network.shift();
  }
  trimmed.endpointCatalog = reconcileEndpointCatalog(trimmed.endpointCatalog ?? [], trimmed.network);
  return trimmed;
}

export class ProbeSessionStore {
  private session: ProbeSessionExport["session"] | null = null;
  private readonly revokedSessionIds = new Set<string>();
  constructor(private readonly storage: ProbeStorageArea, private readonly storageKey = PROBE_STORAGE_KEY) {}

  revokeSession(expectedIdentity: ProbeSessionIdentity): void {
    if (isProbeSessionIdentity(expectedIdentity)) this.revokedSessionIds.add(sessionIdentityKey(expectedIdentity));
  }

  async load(): Promise<ProbeSessionExport["session"] | null> {
    if (this.session) return this.session;
    const result = await this.storage.get<{ [key: string]: unknown }>(this.storageKey);
    const candidate = result[this.storageKey];
    this.session = isValidProbeSession(candidate) ? trimSession(candidate) : null;
    return this.session;
  }

  async save(session: ProbeSessionExport["session"]): Promise<ProbeSessionExport["session"]> {
    if (!isValidProbeSession(session)) throw new Error("探针会话 schema 或来源合同无效");
    this.session = trimSession(session);
    await this.storage.set({ [this.storageKey]: this.session });
    return this.session;
  }

  async clear(): Promise<void> { this.session = null; await this.storage.remove(this.storageKey); }

  async appendNetwork(observation: SanitizedNetworkObservation, expectedIdentity: ProbeSessionIdentity): Promise<ProbeSessionExport["session"] | null> {
    const current = await this.load();
    if (!current || !writeAllowed(current, expectedIdentity, this.revokedSessionIds)) return null;
    const { metricObservations, ...networkObservation } = { ...observation };
    if (!networkObservation.phase) networkObservation.phase = "response_metadata";
    const nextMetrics = compactMetricObservations([...(current.metricObservations ?? []), ...(metricObservations ?? [])]);
    const nextNetwork = [...current.network, networkObservation];
    const endpointResult = updateEndpointCatalog(current.endpointCatalog ?? [], networkObservation, current.endpointCatalogOverflow);
    const metricResult = updateMetricCatalog(current.metricCatalog ?? [], networkObservation, metricObservations ?? [], current.metricCatalogOverflow);
    const nextEndpointCatalog = reconcileEndpointCatalog(endpointResult.catalog, compactNetworkObservations(nextNetwork));
    return this.save({ ...current, network: nextNetwork, metricObservations: nextMetrics, endpointCatalog: nextEndpointCatalog, ...(endpointResult.overflow ? { endpointCatalogOverflow: endpointResult.overflow } : {}), metricCatalog: metricResult.catalog, ...(metricResult.overflow ? { metricCatalogOverflow: metricResult.overflow } : {}), lastSeenAt: observation.observedAt, lifecycle: "active" });
  }

  async appendTarget(observation: SanitizedTargetObservation, expectedIdentity: ProbeSessionIdentity): Promise<ProbeSessionExport["session"] | null> {
    const current = await this.load();
    if (!current || !writeAllowed(current, expectedIdentity, this.revokedSessionIds)) return null;
    return this.save({ ...current, targets: [...current.targets, observation], lastSeenAt: observation.observedAt, lifecycle: "active" });
  }

  async setAudio(audio: AudioStatus, observedAt: string, expectedIdentity: ProbeSessionIdentity): Promise<ProbeSessionExport["session"] | null> {
    const current = await this.load();
    if (!current || !writeAllowed(current, expectedIdentity, this.revokedSessionIds)) return null;
    return this.save({ ...current, audio: { ...audio }, audioAudit: updateAudioAudit(current.audio, audio, observedAt, current.audioAudit), lastSeenAt: observedAt });
  }

  async setDom(dom: SanitizedDomField[], observedAt: string, expectedIdentity: ProbeSessionIdentity): Promise<ProbeSessionExport["session"] | null> {
    const current = await this.load();
    if (!current || !writeAllowed(current, expectedIdentity, this.revokedSessionIds)) return null;
    return this.save({ ...current, dom: dom.slice(-MAX_DOM_FIELDS), lastSeenAt: observedAt });
  }

  async setLifecycle(lifecycle: ProbeLifecycle, observedAt: string, reason: LifecycleReasonCode, expectedIdentity: ProbeSessionIdentity): Promise<ProbeSessionExport["session"] | null> {
    const current = await this.load();
    if (!current || !isProbeSessionIdentity(expectedIdentity) || current.routeId !== expectedIdentity.routeId || current.sessionId !== expectedIdentity.sessionId || current.lifecycle === "blocked" || current.lifecycle === "stopped") return null;
    const revoked = this.revokedSessionIds.has(sessionIdentityKey(expectedIdentity));
    if (revoked && lifecycle !== "blocked") return null;
    const isNetworkStartAttempt = reason === "network_started" && lifecycle === "starting";
    const markers = isNetworkStartAttempt ? current.markers : current.markers.concat([{ markerId: `system-${observedAt}`, code: reason, createdAt: observedAt }]).slice(-MAX_MARKERS);
    return this.save({ ...current, lifecycle, lastSeenAt: observedAt, markers });
  }

  async addMarker(code: MarkerCode, markerId: string, createdAt: string, expectedIdentity: ProbeSessionIdentity): Promise<ProbeSessionExport["session"] | null> {
    const current = await this.load();
    if (!current || !writeAllowed(current, expectedIdentity, this.revokedSessionIds)) return null;
    const marker: BusinessMarker = { markerId, code, createdAt };
    return this.save({ ...current, markers: [...current.markers, marker], lastSeenAt: createdAt });
  }
}

export function exportProbeSession(session: ProbeSessionExport["session"], exportedAt: string): ProbeSessionExport {
  if (!isValidProbeSession(session)) throw new Error("无法导出无效或 legacy 探针会话");
  const endpointCatalog = session.endpointCatalog?.map((item) => ({ ...item }));
  const endpointCatalogOverflow = session.endpointCatalogOverflow ? {
    droppedGroupCount: session.endpointCatalogOverflow.droppedGroupCount,
    missingGroups: session.endpointCatalogOverflow.missingGroups.map((group) => ({ ...group }))
  } : undefined;
  const metricCatalog = session.metricCatalog?.map((item) => {
    const sanitized = { ...item };
    delete sanitized.lastValue;
    delete sanitized.lastValueAt;
    return sanitized;
  });
  const metricCatalogOverflow = session.metricCatalogOverflow ? {
    droppedMetricCount: session.metricCatalogOverflow.droppedMetricCount,
    missingMetrics: session.metricCatalogOverflow.missingMetrics.map((metric) => ({ ...metric }))
  } : undefined;
  return {
    schemaVersion: "phase-2a-probe-v2",
    exportedAt,
    session: {
      page: session.page,
      routeId: session.routeId,
      sessionId: session.sessionId,
      origin: session.origin,
      pathname: session.pathname,
      lifecycle: session.lifecycle,
      startedAt: session.startedAt,
      lastSeenAt: session.lastSeenAt,
      network: session.network.map((observation) => {
        const item = { ...observation };
        delete item.metricObservations;
        return { ...item, fields: item.fields.map((field) => ({ ...field })) };
      }),
      ...(endpointCatalog ? { endpointCatalog } : {}),
      ...(endpointCatalogOverflow ? { endpointCatalogOverflow } : {}),
      ...(metricCatalog ? { metricCatalog } : {}),
      ...(metricCatalogOverflow ? { metricCatalogOverflow } : {}),
      targets: session.targets.map((item) => ({ ...item })),
      dom: session.dom.map((item) => ({ ...item })),
      audio: { ...session.audio },
      ...(session.audioAudit ? { audioAudit: { ...session.audioAudit, transitions: session.audioAudit.transitions.map((transition) => ({ ...transition })) } } : {}),
      markers: session.markers.map((item) => ({ ...item }))
    }
  };
}
