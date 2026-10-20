import { sanitizeNetworkObservation, sanitizeTargetObservation } from "./sanitize.js";
import { classifyPageUrl, sanitizeCompassWebSocketUrl, sanitizePageUrl } from "./allowlist.js";
import type { AllowedRouteId, ProbeSessionExport, ProbeSessionIdentity } from "./types.js";
import type { ProbeSessionStore } from "./storage.js";

const MAX_RESPONSE_BODY_BYTES = 1_048_576;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function targetType(value: string | null): string {
  if (value === "iframe" || value === "worker" || value === "service_worker" || value === "page") return value;
  return "other";
}

function sanitizedUrl(value: string): string | null {
  const location = sanitizePageUrl(value);
  return location ? `${location.origin}${location.pathname}` : null;
}

function sanitizedWebSocketUrl(value: string): string | null {
  const location = sanitizeCompassWebSocketUrl(value);
  return location ? `${location.origin}${location.pathname}` : null;
}

interface HttpRequestObservation {
  url: string;
  method?: string;
  resourceType?: string;
  status?: number;
  mimeType?: string;
  encodedDataLength?: number;
}

export interface DebuggerObservationContext {
  ownerTabId: number | null;
  ownerRouteId: AllowedRouteId | null;
  ownerSessionId: string | null;
  mainFrameId: string | null;
  frameParents: Map<string, string | null>;
  frameUrls: Map<string, string>;
  wsUrls: Map<string, string>;
  targetUrls: Map<string, string>;
  targetTypes: Map<string, string>;
  targetSessions: Map<string, string>;
  httpRequests: Map<string, HttpRequestObservation>;
}

export interface TransientResponseBody {
  body?: string;
  base64Encoded?: boolean;
}

export type ResponseBodyReader = (requestId: string) => Promise<TransientResponseBody>;
export type JsonBodyObserver = (input: { origin: string; endpoint: string; body: unknown; observedAt: string }) => Promise<void> | void;
export type JsonWebSocketObserver = (input: { origin: string; endpoint: string; body: unknown; observedAt: string; direction: "received" }) => Promise<void> | void;

export function createDebuggerObservationContext(ownerTabId: number | null = null, ownerRouteId: AllowedRouteId | null = null, ownerSessionId: string | null = null): DebuggerObservationContext {
  return {
    ownerTabId,
    ownerRouteId,
    ownerSessionId,
    mainFrameId: null,
    frameParents: new Map(),
    frameUrls: new Map(),
    wsUrls: new Map(),
    targetUrls: new Map(),
    targetTypes: new Map(),
    targetSessions: new Map(),
    httpRequests: new Map()
  };
}

export function setDebuggerObservationOwner(context: DebuggerObservationContext, ownerTabId: number | null, ownerRouteId: AllowedRouteId | null = null, ownerSessionId: string | null = null): void {
  context.ownerTabId = ownerTabId;
  context.ownerRouteId = ownerRouteId;
  context.ownerSessionId = ownerSessionId;
}

export function resetDebuggerObservationContext(context: DebuggerObservationContext): void {
  context.mainFrameId = null;
  context.ownerRouteId = null;
  context.ownerSessionId = null;
  context.frameParents.clear();
  context.frameUrls.clear();
  context.wsUrls.clear();
  context.targetUrls.clear();
  context.targetTypes.clear();
  context.targetSessions.clear();
  context.httpRequests.clear();
}

function frameRecord(value: unknown): Record<string, unknown> {
  return record(value);
}

function visitFrameTree(context: DebuggerObservationContext, value: unknown, parentId: string | null, root: boolean): void {
  const tree = frameRecord(value);
  const frame = frameRecord(tree.frame);
  const frameId = text(frame.id);
  if (!frameId) return;
  const frameParentId = text(frame.parentId) ?? parentId;
  context.frameParents.set(frameId, frameParentId);
  const url = text(frame.url);
  if (url) {
    const cleanUrl = sanitizedUrl(url);
    if (cleanUrl) context.frameUrls.set(frameId, cleanUrl);
  }
  if (root || context.mainFrameId === null) context.mainFrameId = frameId;
  const children = Array.isArray(tree.childFrames) ? tree.childFrames : [];
  for (const child of children) visitFrameTree(context, child, frameId, false);
}

export function setMainFrameTree(context: DebuggerObservationContext, frameTree: unknown): string | null {
  context.mainFrameId = null;
  context.frameParents.clear();
  context.frameUrls.clear();
  visitFrameTree(context, frameTree, null, true);
  return context.mainFrameId;
}

function appendNetworkObservation(store: ProbeSessionStore, input: Parameters<typeof sanitizeNetworkObservation>[0], expectedIdentity: ProbeSessionIdentity): Promise<ProbeSessionExport["session"] | null> {
  const observation = sanitizeNetworkObservation(input);
  return observation ? store.appendNetwork(observation, expectedIdentity) : Promise.resolve(null);
}

function resourceType(value: unknown): string | undefined {
  const normalized = text(value)?.toLowerCase();
  return normalized ? normalized : undefined;
}

/**
 * Read a JSON XHR/fetch response only after loadingFinished. The body is kept in
 * local variables for this call, converted to shape/metric summaries, and
 * discarded in the finally block. Headers, postData and credentials never enter
 * this path.
 */
export async function inspectJsonResponseBody(
  store: ProbeSessionStore,
  requestId: string,
  observedAt: string,
  context: DebuggerObservationContext,
  readBody: ResponseBodyReader,
  expectedIdentity: ProbeSessionIdentity,
  onJsonBody?: JsonBodyObserver
): Promise<ProbeSessionExport["session"] | null> {
  if (context.ownerRouteId !== expectedIdentity.routeId || context.ownerSessionId !== expectedIdentity.sessionId) return null;
  const request = context.httpRequests.get(requestId);
  if (!request) return null;
  try {
    const kind = request.resourceType?.toLowerCase();
    if (kind !== "xhr" && kind !== "fetch") return null;
    if (!request.mimeType?.toLowerCase().includes("json")) return null;
    if (request.encodedDataLength !== undefined && request.encodedDataLength > MAX_RESPONSE_BODY_BYTES) return null;
    const result = await readBody(requestId);
    if (!result || result.base64Encoded || typeof result.body !== "string") return null;
    if (new TextEncoder().encode(result.body).byteLength > MAX_RESPONSE_BODY_BYTES) return null;
    const parsed: unknown = JSON.parse(result.body);
    const requestUrl = new URL(request.url);
    if (onJsonBody) await onJsonBody({ origin: requestUrl.origin, endpoint: requestUrl.pathname, body: parsed, observedAt });
    const input: Parameters<typeof sanitizeNetworkObservation>[0] = {
      kind: "http",
      phase: "body_shape",
      url: request.url,
      observedAt,
      body: parsed
    };
    if (request.method !== undefined) input.method = request.method;
    if (request.resourceType !== undefined) input.resourceType = request.resourceType;
    if (request.status !== undefined) input.status = request.status;
    if (request.mimeType !== undefined) input.mimeType = request.mimeType;
    return (await appendNetworkObservation(store, input, expectedIdentity)) ?? null;
  } catch {
    // The raw response and parser error are intentionally not persisted.
    return null;
  } finally {
    context.httpRequests.delete(requestId);
  }
}

function wsFrameType(opcode: number | undefined, payload: string | null, messageBytes: number | undefined): "json" | "text" | "binary" {
  if (opcode === 2) return "binary";
  if (messageBytes !== undefined && messageBytes > MAX_RESPONSE_BODY_BYTES) return "text";
  if (opcode === 1 || payload !== null) {
    if (payload !== null) {
      try {
        JSON.parse(payload);
        return "json";
      } catch {
        return "text";
      }
    }
    return "text";
  }
  return "binary";
}

export async function observeDebuggerEvent(
  store: ProbeSessionStore,
  method: string,
  params: Record<string, unknown> | undefined,
  observedAt: string,
  context: DebuggerObservationContext,
  sourceTabId: number | undefined,
  expectedIdentity: ProbeSessionIdentity,
  onJsonWebSocket?: JsonWebSocketObserver
): Promise<ProbeSessionExport["session"] | null> {
  if (context.ownerRouteId !== expectedIdentity.routeId || context.ownerSessionId !== expectedIdentity.sessionId) return null;
  const body = params ?? {};
  if (method === "Network.requestWillBeSent") {
    const request = record(body.request);
    const requestId = text(body.requestId);
    const url = text(request.url);
    const type = resourceType(body.type);
    const frameId = text(body.frameId);
    if (type === "document" && context.mainFrameId !== null && frameId === context.mainFrameId && url && classifyPageUrl(url).status !== "allowed") return null;
    const cleanUrl = url ? sanitizedUrl(url) : null;
    if (!cleanUrl) return null;
    const metadata: HttpRequestObservation = { url: cleanUrl };
    const methodName = text(request.method); if (methodName) metadata.method = methodName;
    if (type) metadata.resourceType = type;
    if (requestId) context.httpRequests.set(requestId, metadata);
    const input: Parameters<typeof sanitizeNetworkObservation>[0] = { kind: "http", phase: "request_start", url: cleanUrl, observedAt };
    if (methodName) input.method = methodName;
    if (type) input.resourceType = type;
    return appendNetworkObservation(store, input, expectedIdentity);
  }
  if (method === "Network.responseReceived") {
    const response = record(body.response);
    const requestId = text(body.requestId);
    const responseUrl = text(response.url);
    const existing = requestId ? context.httpRequests.get(requestId) : undefined;
    const cleanUrl = responseUrl ? sanitizedUrl(responseUrl) : existing?.url ?? null;
    if (!cleanUrl) return null;
    const metadata: HttpRequestObservation = existing ? { ...existing, url: cleanUrl } : { url: cleanUrl };
    const status = number(response.status); if (status !== undefined) metadata.status = status;
    const mimeType = text(response.mimeType); if (mimeType) metadata.mimeType = mimeType;
    const type = resourceType(body.type); if (type) metadata.resourceType = type;
    if (requestId) context.httpRequests.set(requestId, metadata);
    const input: Parameters<typeof sanitizeNetworkObservation>[0] = { kind: "http", phase: "response_metadata", url: cleanUrl, observedAt };
    if (metadata.status !== undefined) input.status = metadata.status;
    if (metadata.mimeType !== undefined) input.mimeType = metadata.mimeType;
    if (metadata.resourceType !== undefined) input.resourceType = metadata.resourceType;
    return appendNetworkObservation(store, input, expectedIdentity);
  }
  if (method === "Network.loadingFinished") {
    const requestId = text(body.requestId);
    const encodedDataLength = number(body.encodedDataLength);
    if (requestId && encodedDataLength !== undefined) {
      const request = context.httpRequests.get(requestId);
      if (request) request.encodedDataLength = encodedDataLength;
    }
    return null;
  }
  if (method === "Network.loadingFailed") {
    const requestId = text(body.requestId);
    if (requestId) context.httpRequests.delete(requestId);
    return null;
  }
  if (method === "Network.webSocketCreated") {
    const requestId = text(body.requestId);
    const url = text(body.url);
    const cleanUrl = url ? sanitizedWebSocketUrl(url) : null;
    if (!requestId || !cleanUrl) return null;
    context.wsUrls.set(requestId, cleanUrl);
    return appendNetworkObservation(store, { kind: "ws", phase: "ws_frame", url: cleanUrl, observedAt, frameType: "text" }, expectedIdentity);
  }
  if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
    const requestId = text(body.requestId);
    const url = requestId ? context.wsUrls.get(requestId) : undefined;
    const frame = record(body.response);
    if (!url) return null;
    const payload = typeof frame.payloadData === "string" ? frame.payloadData : null;
    const opcode = number(frame.opcode);
    const payloadLength = number(frame.payloadLength);
    const messageBytes = opcode === 2 ? payloadLength ?? (payload !== null ? new TextEncoder().encode(payload).byteLength : undefined) : payload !== null ? new TextEncoder().encode(payload).byteLength : payloadLength;
    const type = wsFrameType(opcode, payload, messageBytes);
    const input: Parameters<typeof sanitizeNetworkObservation>[0] = {
      kind: "ws",
      phase: "ws_frame",
      url,
      observedAt,
      direction: method.endsWith("Sent") ? "sent" : "received",
      frameType: type
    };
    if (messageBytes !== undefined) input.messageBytes = messageBytes;
    if (type === "json" && payload !== null && messageBytes !== undefined && messageBytes <= MAX_RESPONSE_BODY_BYTES) {
      try {
        input.body = JSON.parse(payload);
        if (method === "Network.webSocketFrameReceived" && onJsonWebSocket) {
          const parsedUrl = new URL(url);
          await onJsonWebSocket({ origin: parsedUrl.origin, endpoint: parsedUrl.pathname, body: input.body, observedAt, direction: "received" });
        }
      } catch { /* frame type is corrected below if a non-JSON payload races */ }
    }
    return appendNetworkObservation(store, input, expectedIdentity);
  }
  if (method === "Network.webSocketClosed" || method === "Network.webSocketWillSendHandshakeRequest") {
    if (method === "Network.webSocketClosed") {
      const requestId = text(body.requestId);
      if (requestId) context.wsUrls.delete(requestId);
    }
    return null;
  }
  if (method === "Page.frameAttached") {
    if (context.ownerTabId === null || sourceTabId !== context.ownerTabId) return null;
    const frameId = text(body.frameId);
    const parentFrameId = text(body.parentFrameId);
    if (!frameId || !parentFrameId || (parentFrameId !== context.mainFrameId && !context.frameParents.has(parentFrameId))) return null;
    context.frameParents.set(frameId, parentFrameId);
    return null;
  }
  if (method === "Page.frameNavigated") {
    if (context.ownerTabId === null || sourceTabId !== context.ownerTabId) return null;
    const frame = frameRecord(body.frame);
    const frameId = text(frame.id);
    const parentFrameId = text(frame.parentId);
    const url = text(frame.url);
    if (!frameId || !url) return null;
    if (frameId === context.mainFrameId) {
      const cleanMainUrl = sanitizedUrl(url);
      if (cleanMainUrl) context.frameUrls.set(frameId, cleanMainUrl);
      return null;
    }
    if (!parentFrameId || (parentFrameId !== context.mainFrameId && !context.frameParents.has(parentFrameId))) return null;
    const cleanUrl = sanitizedUrl(url);
    if (!cleanUrl) return null;
    context.frameParents.set(frameId, parentFrameId);
    const lifecycle = context.frameUrls.has(frameId) ? "updated" : "created";
    context.frameUrls.set(frameId, cleanUrl);
    const observation = sanitizeTargetObservation({ observedAt, targetType: "iframe", url: cleanUrl, lifecycle });
    return observation ? store.appendTarget(observation, expectedIdentity) : null;
  }
  if (method === "Page.frameDetached") {
    if (context.ownerTabId === null || sourceTabId !== context.ownerTabId) return null;
    const frameId = text(body.frameId);
    if (!frameId || frameId === context.mainFrameId) return null;
    const url = context.frameUrls.get(frameId);
    context.frameParents.delete(frameId);
    context.frameUrls.delete(frameId);
    if (!url) return null;
    const observation = sanitizeTargetObservation({ observedAt, targetType: "iframe", url, lifecycle: "destroyed" });
    return observation ? store.appendTarget(observation, expectedIdentity) : null;
  }
  if (method === "Target.attachedToTarget") {
    if (context.ownerTabId === null || sourceTabId !== context.ownerTabId) return null;
    const sessionId = text(body.sessionId);
    const info = record(body.targetInfo);
    const targetId = text(info.targetId);
    const url = text(info.url);
    const type = targetType(text(info.type));
    if (!sessionId || !targetId || !url || info.attached === false) return null;
    const relationIds = [text(info.openerId), text(info.openerFrameId), text(info.parentFrameId), text(info.parentId)].filter((value): value is string => value !== null);
    const hasKnownRelation = relationIds.some((relationId) => relationId === context.mainFrameId || context.frameParents.has(relationId) || context.targetUrls.has(relationId));
    const cleanUrl = sanitizedUrl(url);
    if (!cleanUrl) return null;
    if (!hasKnownRelation) {
      // Track only an authorized page target as a future parent proof; do not persist it as a child.
      if (type !== "page" || classifyPageUrl(url).status !== "allowed") return null;
    }
    context.targetSessions.set(targetId, sessionId);
    context.targetUrls.set(targetId, cleanUrl);
    context.targetTypes.set(targetId, type);
    if (!hasKnownRelation) return null;
    const observation = sanitizeTargetObservation({ observedAt, targetType: type, url: cleanUrl, lifecycle: "created" });
    return observation ? store.appendTarget(observation, expectedIdentity) : null;
  }
  if (method === "Target.detachedFromTarget") {
    if (context.ownerTabId === null || sourceTabId !== context.ownerTabId) return null;
    const sessionId = text(body.sessionId);
    const targetId = text(body.targetId) ?? [...context.targetSessions.entries()].find(([, value]) => value === sessionId)?.[0] ?? null;
    if (!targetId) return null;
    const url = context.targetUrls.get(targetId);
    const type = context.targetTypes.get(targetId) ?? "other";
    context.targetSessions.delete(targetId);
    context.targetUrls.delete(targetId);
    context.targetTypes.delete(targetId);
    if (!url) return null;
    const observation = sanitizeTargetObservation({ observedAt, targetType: type, url, lifecycle: "destroyed" });
    return observation ? store.appendTarget(observation, expectedIdentity) : null;
  }
  return null;
}

export { MAX_RESPONSE_BODY_BYTES };
