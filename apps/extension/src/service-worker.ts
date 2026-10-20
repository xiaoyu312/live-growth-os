import { desktopCaptureOnly } from "./desktop-mode.js";
import { audioCaptureAllowedRoute, classifyPageUrl, sameRouteIdentity } from "./allowlist.js";
import { transitionAudio } from "./audio.js";
import { requestAudioConsume } from "./audio-consume.js";
import { applyAudioStatusMessage, recordAudioRefresh } from "./audio-message.js";
import { attachDebuggerWithCleanup } from "./debugger-lifecycle.js";
import { domFallbackAllowed, collectCompassDomMetricSnapshots, collectDomFieldCandidates, mapCompassDomMetricSnapshots } from "./dom-fallback.js";
import { inspectJsonResponseBody, observeDebuggerEvent, createDebuggerObservationContext, resetDebuggerObservationContext, setDebuggerObservationOwner, setMainFrameTree } from "./probe-observation.js";
import { sanitizeDomFields } from "./sanitize.js";
import { ChromeProbeStorage, createProbeSession, exportProbeSession, ProbeSessionStore, PROBE_STORAGE_KEY } from "./storage.js";
import { isMarkerCode, type AudioErrorCode, type BusinessMarkerCode, type LifecycleReasonCode, type PageAccess, type ProbeMessage, type ProbeSessionIdentity, type RuntimeProbeState, type RuntimeResponse } from "./types.js";
import { audioStartErrorMessage } from "./audio-error.js";
import { COMPASS_LIVE_MAPPING_VERSION } from "@live-growth/source-adapters/live-browser";
import { liveStopSucceeded } from "./live-stop.js";
import { LIVE_START_DEADLINE_MS, LIVE_SERVER_UNREACHABLE_MESSAGE, LiveStartTimeoutError, awaitAudioConsumeForLiveStart, closeOffscreenAudioDocument, liveServerUnreachableMessage, liveStartDomWarning, runLiveStartTransaction, shouldCleanupLiveStart, shouldOpenLiveDashboard, shouldPollLiveDom } from "./live-start.js";
import { LIVE_DASHBOARD_STORAGE_KEY, liveDashboardUrl, liveDashboardWindowCreateOptions, liveDashboardSidePanelOptions } from "./live-dashboard.js";
import { clearPersistedLivePair, interpretLiveReattachStatus, liveStartAudioRetryWarning, loadPersistedLivePair, persistLivePair, publicResumableLive, resolveLiveSession, shouldClearLivePairAfterStop, shouldPersistLivePairOnInvalidate, shouldStopRemoteLiveOnInvalidate, type DurableLivePairStorage, type LivePairRecord } from "./live-pair.js";
import { compassAudioOwnedByTab, SerializedRuntimeQueue, SharedLiveConnectionStore, TabRuntimeRegistry, type SharedLiveConnection } from "./tab-runtime.js";
import { parseLiveMetricForRoute } from "./live-metric-routing.js";
import { assemblePageRuntime, collectPageRuntimeFlags, sanitizePageRuntimeFlags } from "./page-runtime.js";
import {
  SOURCE_HEALTH_TICK_MS,
  createRecoveryLock,
  decideSourceRecovery,
  noteReloadAttempt,
  releaseRecoveryLock,
  tryAcquireRecoveryLock,
  worstBusinessStatus,
  type RecoveryLock
} from "@live-growth/rules/source-recovery";

type TabContext = {
  tabId: number;
  store: ProbeSessionStore;
  observationContext: ReturnType<typeof createDebuggerObservationContext>;
  access: PageAccess | null;
  identity: ProbeSessionIdentity | null;
  debuggerAttached: boolean;
  domFallbackEnabled: boolean;
  revocation: Promise<void> | null;
  liveDomPollTimer: ReturnType<typeof setInterval> | null;
  lastLiveDomPollAt: number;
  lastNavigationAt?: string;
};

const chromeStorage = new ChromeProbeStorage();
const contexts = new TabRuntimeRegistry<TabContext>((tabId) => ({
    tabId,
    store: new ProbeSessionStore(chromeStorage, `${PROBE_STORAGE_KEY}:${tabId}`),
    observationContext: createDebuggerObservationContext(),
    access: null,
    identity: null,
    debuggerAttached: false,
    domFallbackEnabled: false,
    revocation: null,
    liveDomPollTimer: null,
    lastLiveDomPollAt: 0
  }));
const recoveryLocks = new Map<number, RecoveryLock>();
let sourceHealthTickTimer: ReturnType<typeof setTimeout> | null = null;
function contextFor(tabId: number): TabContext { return contexts.get(tabId).state; }
const sharedLive = new SharedLiveConnectionStore();

// The legacy helper functions below operate on the selected tab. Event handlers
// use the per-tab context directly; selecting a tab never revokes another tab.
let activeTabId: number | null = null;
let activeAccess: PageAccess | null = null;
let activeSessionIdentity: ProbeSessionIdentity | null = null;
let debuggerAttached = false;
let debuggerTabId: number | null = null;
let domFallbackEnabled = false;
let activeRevocation: Promise<void> | null = null;
let liveDomPollTimer: ReturnType<typeof setInterval> | null = null;
let lastLiveDomPollAt = 0;
let store: ProbeSessionStore = contextFor(-1).store;
let observationContext = contextFor(-1).observationContext;
function activateContext(tabId: number): TabContext {
  const context = contextFor(tabId);
  activeTabId = context.tabId;
  activeAccess = context.access;
  activeSessionIdentity = context.identity;
  debuggerAttached = context.debuggerAttached;
  debuggerTabId = context.debuggerAttached ? context.tabId : null;
  domFallbackEnabled = context.domFallbackEnabled;
  activeRevocation = context.revocation;
  liveDomPollTimer = context.liveDomPollTimer;
  lastLiveDomPollAt = context.lastLiveDomPollAt;
  store = context.store;
  observationContext = context.observationContext;
  return context;
}
function persistContext(context: TabContext): void {
  context.access = activeAccess;
  context.identity = activeSessionIdentity;
  context.debuggerAttached = debuggerAttached;
  context.domFallbackEnabled = domFallbackEnabled;
  context.revocation = activeRevocation;
  context.liveDomPollTimer = liveDomPollTimer;
  context.lastLiveDomPollAt = lastLiveDomPollAt;
}

const LIVE_SERVER_ORIGIN = "http://127.0.0.1:4100";
const runtimeQueue = new SerializedRuntimeQueue();
const liveStartAttempts = new Map<number, symbol>();

function beginLiveStart(tabId: number): symbol {
  const attempt = Symbol(`live-start:${tabId}`);
  liveStartAttempts.set(tabId, attempt);
  return attempt;
}

function isLiveStartCurrent(tabId: number, attempt: symbol): boolean { return liveStartAttempts.get(tabId) === attempt; }

function cancelLiveStart(tabId: number, attempt: symbol): void {
  if (isLiveStartCurrent(tabId, attempt)) liveStartAttempts.delete(tabId);
}

type LiveSessionResponse = { sessionId?: unknown; pairToken?: unknown; dashboardPath?: unknown };

function sharedLiveConnection(): SharedLiveConnection | null { return sharedLive.get(); }
const pairStorage: DurableLivePairStorage = {
  local: {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
    remove: (key) => chrome.storage.local.remove(key)
  },
  session: {
    get: (key) => chrome.storage.session.get(key),
    set: (items) => chrome.storage.session.set(items),
    remove: (key) => chrome.storage.session.remove(key)
  }
};

async function restoreSharedLiveFromStorage(): Promise<void> {
  if (sharedLive.get()) return;
  const persisted = await loadPersistedLivePair(pairStorage);
  if (persisted) sharedLive.restore(persisted);
}

const livePairReady = restoreSharedLiveFromStorage();

function responseWithPair(response: RuntimeResponse): RuntimeResponse {
  const resumableLive = publicResumableLive(sharedLive.get());
  return resumableLive ? { ...response, resumableLive } : response;
}

async function enableCopilotSidePanel(tabId: number): Promise<void> {
  try {
    await chrome.sidePanel.setOptions(liveDashboardSidePanelOptions(tabId));
  } catch {
    /* 侧栏手势由 popup 在点击时打开；这里只确保当前 Tab 已启用 */
  }
}

async function revealLiveDashboard(tabId: number, dashboardPath: string): Promise<void> {
  const url = liveDashboardUrl(dashboardPath);
  if (!url) return;
  await chrome.storage.local.set({ [LIVE_DASHBOARD_STORAGE_KEY]: { dashboardPath } });
  try {
    await chrome.windows.create(liveDashboardWindowCreateOptions(url));
  } catch {
    /* 独立页失败时仍可手动打开本机 /live 路径 */
  }
}


type LiveStartGuard = () => void;

function stopRemoteLiveSession(connection: Pick<SharedLiveConnection, "sessionId" | "pairToken">): void {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  void fetch(`${LIVE_SERVER_ORIGIN}/api/live/sessions/${encodeURIComponent(connection.sessionId)}/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.pairToken}` },
    signal: controller.signal
  }).catch(() => undefined).finally(() => clearTimeout(timeout));
}

function stopStaleOffscreenAudio(tabId: number, expectedIdentity: ProbeSessionIdentity): void {
  // A newer start attempt owns the offscreen document; never tear it down from
  // a late response belonging to an older attempt.
  if (liveStartAttempts.has(tabId)) return;
  const context = contexts.peek(tabId)?.state;
  if (!context?.identity || !sameSessionIdentity(context.identity, expectedIdentity)) return;
  void closeOffscreenAudioDocument({
    sendStop: () => chrome.runtime.sendMessage({ type: "audio:stop" }),
    hasDocument: () => chrome.offscreen.hasDocument(),
    closeDocument: () => chrome.offscreen.closeDocument()
  });
}

async function postLiveReattach(pair: LivePairRecord): Promise<{ ok: true; sessionId: string; dashboardPath: string } | { ok: false; unusable: boolean }> {
  let response: Response;
  try {
    response = await fetch(`${LIVE_SERVER_ORIGIN}/api/live/sessions/${encodeURIComponent(pair.sessionId)}/reattach`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pair.pairToken}` }
    });
  } catch (error) {
    throw new Error(liveServerUnreachableMessage(error));
  }
  const kind = interpretLiveReattachStatus(response.status);
  if (kind === "ok") {
    const body = await response.json() as LiveSessionResponse;
    if (typeof body.sessionId !== "string" || typeof body.dashboardPath !== "string") return { ok: false, unusable: true };
    return { ok: true, sessionId: body.sessionId, dashboardPath: body.dashboardPath };
  }
  if (kind === "unusable") return { ok: false, unusable: true };
  throw new Error(LIVE_SERVER_UNREACHABLE_MESSAGE);
}

async function postLiveCreate(): Promise<{ sessionId: string; pairToken: string; dashboardPath: string }> {
  let response: Response;
  try {
    response = await fetch(`${LIVE_SERVER_ORIGIN}/api/live/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch (error) {
    throw new Error(liveServerUnreachableMessage(error));
  }
  if (!response.ok) throw new Error(LIVE_SERVER_UNREACHABLE_MESSAGE);
  const body = await response.json() as LiveSessionResponse;
  if (typeof body.sessionId !== "string" || typeof body.pairToken !== "string" || typeof body.dashboardPath !== "string") throw new Error("真实直播服务返回无效会话");
  return { sessionId: body.sessionId, pairToken: body.pairToken, dashboardPath: body.dashboardPath };
}

async function createLiveSession(tabId: number, attempt?: symbol): Promise<LivePairRecord & { reused: boolean }> {
  if (contextFor(tabId).access?.routeId !== "compass-live-shop") throw new Error("真实直播业务会话只能由罗盘页面建立");
  const resolved = await resolveLiveSession({
    tabId,
    memory: sharedLive.get(),
    persisted: await loadPersistedLivePair(pairStorage),
    reattach: postLiveReattach,
    create: postLiveCreate
  });
  if (attempt && !isLiveStartCurrent(tabId, attempt)) {
    if (!resolved.reused) stopRemoteLiveSession(resolved.pair);
    throw new LiveStartTimeoutError();
  }
  if (!sharedLive.setFromCompass(tabId, resolved.pair)) throw new Error("真实直播业务会话页面合同无效");
  await persistLivePair(pairStorage, resolved.pair);
  return { ...resolved.pair, reused: resolved.reused };
}

async function sendLiveMetric(metric: unknown): Promise<void> {
  const connection = sharedLiveConnection();
  if (!connection) return;
  try {
    const response = await fetch(`${LIVE_SERVER_ORIGIN}/api/live/sessions/${encodeURIComponent(connection.sessionId)}/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.pairToken}` },
      body: JSON.stringify(metric)
    });
    if (!response.ok) throw new Error("真实直播指标未能送达本地服务");
  } catch (error) {
    throw error;
  }
}

function sourceFromRoute(routeId: PageAccess["routeId"]): "qianchuan" | "compass" | null {
  if (routeId === "qianchuan-board" || routeId === "qianchuan-agent") return "qianchuan";
  if (routeId === "compass-live-shop") return "compass";
  return null;
}

function lockForTab(tabId: number): RecoveryLock {
  const existing = recoveryLocks.get(tabId);
  if (existing) return existing;
  const created = createRecoveryLock(tabId);
  recoveryLocks.set(tabId, created);
  return created;
}

async function postLiveRecovery(source: "qianchuan" | "compass", action: "rebuild_observer" | "report", outcome?: "pending" | "recovered" | "failed" | "aborted" | "blocked", reason?: string): Promise<void> {
  const connection = sharedLiveConnection();
  if (!connection) return;
  await fetch(`${LIVE_SERVER_ORIGIN}/api/live/sessions/${encodeURIComponent(connection.sessionId)}/recovery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.pairToken}` },
    body: JSON.stringify({ source, action, ...(outcome ? { outcome } : {}), ...(reason ? { reason } : {}) })
  }).catch(() => undefined);
}

async function rebuildObservation(tabId: number): Promise<void> {
  activateContext(tabId);
  if (!debuggerAttached || debuggerTabId !== tabId) {
    await attachDebugger(tabId);
    return;
  }
  resetDebuggerObservationContext(observationContext);
  setDebuggerObservationOwner(observationContext, tabId, activeAccess?.routeId ?? null, activeSessionIdentity?.sessionId ?? null);
  await chrome.debugger.sendCommand(target(tabId), "Network.enable");
  await chrome.debugger.sendCommand(target(tabId), "Page.enable");
  await chrome.debugger.sendCommand(target(tabId), "Runtime.enable");
  const frameTree = await chrome.debugger.sendCommand<{ frameTree?: unknown }>(target(tabId), "Page.getFrameTree");
  setMainFrameTree(observationContext, frameTree.frameTree);
}

async function reloadSourceTab(tabId: number, source: "qianchuan" | "compass"): Promise<void> {
  activateContext(tabId);
  if (source === "compass") await stopAudio(tabId);
  if (!debuggerAttached || debuggerTabId !== tabId) {
    try { await attachDebugger(tabId); } catch { /* fall back to tabs.reload without bringing the tab forward */ }
  }
  if (debuggerAttached && debuggerTabId === tabId) {
    await chrome.debugger.sendCommand(target(tabId), "Page.reload", { ignoreCache: false });
  } else {
    await chrome.tabs.reload(tabId);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  activateContext(tabId);
  if (!debuggerAttached || debuggerTabId !== tabId) {
    try { await attachDebugger(tabId); } catch { /* reload may detach; user can reconnect */ }
  } else {
    await rebuildObservation(tabId);
  }
}

async function collectAndPostPageRuntime(tabId: number): Promise<void> {
  const context = contexts.peek(tabId)?.state;
  const connection = sharedLiveConnection();
  const source = sourceFromRoute(context?.access?.routeId ?? null);
  if (!context?.access || !connection || !source) return;
  const injected = await chrome.scripting.executeScript({ target: { tabId }, func: collectPageRuntimeFlags });
  const flags = sanitizePageRuntimeFlags(injected[0]?.result);
  if (!flags) return;
  const payload = assemblePageRuntime({
    source,
    flags,
    debuggerAttached: context.debuggerAttached,
    allowlistStatus: context.access.status,
    topFrameLifecycle: context.identity ? "live" : "stopped",
    observedAt: now(),
    ...(context.lastNavigationAt ? { lastNavigationAt: context.lastNavigationAt } : {})
  });
  await fetch(`${LIVE_SERVER_ORIGIN}/api/live/sessions/${encodeURIComponent(connection.sessionId)}/runtime`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.pairToken}` },
    body: JSON.stringify(payload)
  }).catch(() => undefined);
}

async function recoverSource(tabId: number, source: "qianchuan" | "compass", userConfirmed: boolean): Promise<RuntimeResponse> {
  const context = activateContext(tabId);
  const access = context.access ?? activeAccess;
  if (!access) return { ok: false, error: "当前标签不在白名单合同内" };
  const mapped = sourceFromRoute(access.routeId);
  if (mapped !== source) return { ok: false, error: "当前标签与恢复来源不一致" };
  const lock = lockForTab(tabId);
  const nowMs = Date.now();
  const decision = decideSourceRecovery({
    source,
    worstBusinessStatus: "stalled",
    allowlistStatus: access.status,
    debuggerAttached,
    userConfirmed,
    lockHeld: lock.held,
    ...(lock.lastAttemptAt ? { lastAttemptAt: lock.lastAttemptAt } : {}),
    attemptCount: lock.attemptCount,
    alreadyReloadedThisEpisode: lock.reloadedThisEpisode,
    swGenerationMatches: true,
    nowMs
  });
  if (decision.action === "blocked") {
    await postLiveRecovery(source, "report", "blocked", decision.reason);
    return { ok: false, error: decision.reason === "login" ? "登录页不自动刷新" : decision.reason === "left_allowlist" ? "已离开白名单，已停止恢复" : "当前不能重复刷新" };
  }
  if (decision.action === "rebuild_observer") {
    await rebuildObservation(tabId);
    await postLiveRecovery(source, "rebuild_observer", "pending", "l1_rebuild");
    persistContext(context);
    return { ok: true, state: stateFromSession(await store.load()) };
  }
  if (decision.action !== "execute_reload") {
    return { ok: true, warning: source === "compass" ? "罗盘刷新会暂时中断音频，请确认后再点刷新并重新连接" : "千川可一键刷新页面，不会中断罗盘音频" };
  }
  if (!tryAcquireRecoveryLock(lock, nowMs)) return { ok: false, error: "恢复进行中或处于冷却" };
  try {
    await reloadSourceTab(tabId, source);
    noteReloadAttempt(lock, nowMs);
    await postLiveRecovery(source, "report", "recovered", "user_confirmed_reload");
    persistContext(context);
    return { ok: true, state: stateFromSession(await store.load()), warning: source === "qianchuan" ? "千川数据已恢复" : "罗盘已刷新，请重新授权音频" };
  } catch {
    await postLiveRecovery(source, "report", "failed", "reload_failed");
    return { ok: false, error: "受控刷新失败" };
  } finally {
    releaseRecoveryLock(lock);
  }
}

async function tickSourceHealth(): Promise<void> {
  const connection = sharedLiveConnection();
  if (!connection) return;
  let view: { pendingRecovery?: { source?: string; confirm?: boolean }; sourceGroupHealth?: { qianchuan?: { groups?: Array<{ status: string }>; overallHealth?: string }; compass?: { groups?: Array<{ status: string }>; overallHealth?: string } } } | undefined;
  try {
    const response = await fetch(`${LIVE_SERVER_ORIGIN}/api/live/sessions/${encodeURIComponent(connection.sessionId)}/view`, { cache: "no-store" });
    if (response.ok) view = await response.json() as typeof view;
  } catch {
    return;
  }
  for (const tabId of contexts.tabIds()) {
    const context = contexts.peek(tabId)?.state;
    if (!context?.access || context.access.status !== "allowed") {
      if (context?.access?.status === "login" || context?.access?.status === "blocked") {
        const source = sourceFromRoute(context.access.routeId);
        if (source) await postLiveRecovery(source, "report", "aborted", context.access.status === "login" ? "login" : "left_allowlist");
      }
      continue;
    }
    await collectAndPostPageRuntime(tabId);
    const source = sourceFromRoute(context.access.routeId);
    if (!source) continue;
    const groups = source === "qianchuan" ? view?.sourceGroupHealth?.qianchuan?.groups : view?.sourceGroupHealth?.compass?.groups;
    const worst = worstBusinessStatus((groups ?? []).map((item) => item.status as "fresh"));
    if (worst === "suspected_stall") {
      activateContext(tabId);
      await rebuildObservation(tabId);
      await postLiveRecovery(source, "rebuild_observer", "pending", "l1_rebuild");
    }
    if (view?.pendingRecovery?.confirm === true && view.pendingRecovery.source === source) {
      await recoverSource(tabId, source, true);
    }
  }
}

function scheduleSourceHealthTick(): void {
  if (sourceHealthTickTimer !== null) return;
  sourceHealthTickTimer = setTimeout(() => {
    sourceHealthTickTimer = null;
    void runtimeQueue.enqueue(() => tickSourceHealth()).finally(() => {
      if (sharedLiveConnection()) scheduleSourceHealthTick();
    });
  }, SOURCE_HEALTH_TICK_MS);
}

async function collectLiveDomMetric(tabId: number, url: string, guard?: LiveStartGuard): Promise<void> {
  const access = classifyPageUrl(url);
  const identity = activeSessionIdentity;
  if (access.status !== "allowed" || access.routeId !== "compass-live-shop" || !identity || activeTabId !== tabId || !sameRouteIdentity(activeAccess, access)) return;
  const result = await chrome.scripting.executeScript({ target: { tabId }, func: collectCompassDomMetricSnapshots });
  const snapshots = result[0]?.result ?? [];
  const metric = mapCompassDomMetricSnapshots(snapshots, now());
  if (!metric) throw new Error("当前页面未读取到可靠罗盘经营指标，请先在页面内打开直播");
  guard?.();
  if (!sharedLiveConnection() || !sameSessionIdentity(activeSessionIdentity, identity)) throw new Error("真实直播业务会话已失效，请重新连接");
  await sendLiveMetric(metric);
}

function stopLiveDomPolling(): void {
  if (liveDomPollTimer !== null) {
    clearInterval(liveDomPollTimer);
    liveDomPollTimer = null;
  }
  lastLiveDomPollAt = 0;
}

async function pollLiveDomMetricIfDue(tabId: number, identity: ProbeSessionIdentity): Promise<void> {
  activateContext(tabId);
  if (Date.now() - lastLiveDomPollAt < 5_000) return;
  const canPoll = shouldPollLiveDom({
    active: sharedLiveConnection() !== null,
    tabId,
    activeTabId,
    routeAllowed: activeAccess?.status === "allowed" && activeAccess.routeId === "compass-live-shop",
    sessionMatches: sameSessionIdentity(activeSessionIdentity, identity)
  });
  if (!canPoll) {
    stopLiveDomPolling();
    return;
  }
  lastLiveDomPollAt = Date.now();
  const currentUrl = await currentAuthorizedUrl(tabId);
  if (!currentUrl) {
    stopLiveDomPolling();
    return;
  }
  await collectLiveDomMetric(tabId, currentUrl);
}

function startLiveDomPolling(tabId: number, identity: ProbeSessionIdentity): void {
  stopLiveDomPolling();
  liveDomPollTimer = setInterval(() => {
    void runtimeQueue.enqueue(() => pollLiveDomMetricIfDue(tabId, identity)).catch(() => undefined);
  }, 5_000);
}

async function stopLiveSession(tabId = activeTabId ?? -1): Promise<RuntimeResponse> {
  const context = activateContext(tabId);
  const connection = sharedLiveConnection();
  const isCompassOwner = context.access?.routeId === "compass-live-shop" || connection?.compassTabId === tabId;
  if (!isCompassOwner) return responseWithPair({ ok: false, state: stateFromSession(await store.load()), error: "真实直播会话只能由罗盘页面停止" });
  stopLiveDomPolling();
  const sessionId = connection?.sessionId;
  const pairToken = connection?.pairToken;
  await stopAudio(tabId);
  if (sessionId && pairToken) {
    let response: Response;
    try {
      response = await fetch(`${LIVE_SERVER_ORIGIN}/api/live/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST", headers: { Authorization: `Bearer ${pairToken}` } });
    } catch {
      return responseWithPair({ ok: false, state: stateFromSession(await store.load()), error: "真实直播停止失败，本地仍保留连接，请确认服务后重试" });
    }
    if (!liveStopSucceeded(response.status)) return responseWithPair({ ok: false, state: stateFromSession(await store.load()), error: "真实直播停止失败，本地仍保留连接，请确认服务后重试" });
  }
  if (shouldClearLivePairAfterStop(true)) {
    sharedLive.clear();
    await clearPersistedLivePair(pairStorage);
  }
  const result = responseWithPair({ ok: true, state: stateFromSession(await store.load()) });
  persistContext(context);
  return result;
}

async function abortLiveStart(tabId = activeTabId ?? -1, options?: { keepBusinessSession?: boolean }): Promise<void> {
  await stopNetwork(tabId);
  if (options?.keepBusinessSession) return;
  await stopLiveSession(tabId);
}

function abortLiveStartIfCurrent(tabId: number, attempt: symbol, options?: { keepBusinessSession?: boolean }): void {
  if (!shouldCleanupLiveStart(liveStartAttempts.get(tabId), attempt)) return;
  // Invalidate the attempt synchronously so any late stage guard fails before
  // cleanup reaches the serialized queue. A newer attempt owns the tab if it
  // appears before this best-effort cleanup runs.
  liveStartAttempts.delete(tabId);
  void runtimeQueue.enqueue(async () => {
    if (liveStartAttempts.has(tabId)) return;
    await abortLiveStart(tabId, options);
  }).catch(() => undefined);
}

interface ActiveSessionSnapshot {
  tabId: number;
  access: PageAccess | null;
  identity: ProbeSessionIdentity | null;
}

function now(): string { return new Date().toISOString(); }
function target(tabId: number): Phase2AChromeDebuggee { return { tabId }; }
function sameSessionIdentity(left: ProbeSessionIdentity | null, right: ProbeSessionIdentity | null): boolean {
  return left?.routeId === right?.routeId && left?.sessionId === right?.sessionId;
}

function isProbeMessage(value: unknown): value is ProbeMessage {
  return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" && (value as { type: string }).type.startsWith("probe:");
}

function stateFromSession(session: Awaited<ReturnType<ProbeSessionStore["load"]>>): RuntimeProbeState | null {
  if (!session || !activeAccess || !activeSessionIdentity || session.routeId !== activeAccess.routeId || session.sessionId !== activeSessionIdentity.sessionId) return null;
  return { tabId: activeTabId ?? -1, access: activeAccess, session, debuggerAttached, domFallbackEnabled };
}

async function ensureSession(tabId: number, url: string): Promise<PageAccess> {
  const access = classifyPageUrl(url);
  if (access.status !== "allowed") throw new Error(access.reason);
  if (activeRevocation) await activeRevocation;
  const routeId = access.routeId;
  if (routeId === null) throw new Error("白名单页面缺少 routeId");
  const current = await store.load();
  if (activeTabId === null || activeTabId !== tabId || !activeAccess || !sameRouteIdentity(activeAccess, access) || current?.routeId !== access.routeId || current.lifecycle === "blocked" || current.lifecycle === "stopped") {
    const session = createProbeSession(access, now());
    await store.save(session);
    activeTabId = tabId;
    activeAccess = access;
    activeSessionIdentity = { routeId, sessionId: session.sessionId };
    domFallbackEnabled = false;
  } else if (current) {
    activeSessionIdentity = { routeId, sessionId: current.sessionId };
  }
  return access;
}

async function attachDebugger(tabId: number): Promise<void> {
  if (debuggerAttached && debuggerTabId === tabId) {
    setDebuggerObservationOwner(observationContext, tabId, activeAccess?.routeId ?? null, activeSessionIdentity?.sessionId ?? null);
    return;
  }
  debuggerTabId = tabId;
  setDebuggerObservationOwner(observationContext, tabId, activeAccess?.routeId ?? null, activeSessionIdentity?.sessionId ?? null);
  try {
    await attachDebuggerWithCleanup({
      attach: () => chrome.debugger.attach(target(tabId), "1.3"),
      sendCommand: (method, params) => chrome.debugger.sendCommand(target(tabId), method, params),
      detach: () => chrome.debugger.detach(target(tabId))
    });
    const frameTree = await chrome.debugger.sendCommand<{ frameTree?: unknown }>(target(tabId), "Page.getFrameTree");
    if (!setMainFrameTree(observationContext, frameTree.frameTree)) throw new Error("missing_main_frame");
    debuggerAttached = true;
  } catch (error) {
    try { await chrome.debugger.detach(target(tabId)); } catch { /* setup cleanup is best effort */ }
    debuggerTabId = null;
    debuggerAttached = false;
    setDebuggerObservationOwner(observationContext, null, null, null);
    throw error;
  }
}

async function stopDebugger(requestedTabId?: number): Promise<void> {
  const attachedTabId = requestedTabId ?? debuggerTabId;
  if (attachedTabId !== null) {
    try { await chrome.debugger.detach(target(attachedTabId)); } catch { /* detach is best effort after a closed Tab */ }
  }
  const detachedContext = attachedTabId === null ? undefined : contexts.peek(attachedTabId)?.state;
  if (detachedContext) {
    detachedContext.debuggerAttached = false;
    resetDebuggerObservationContext(detachedContext.observationContext);
    setDebuggerObservationOwner(detachedContext.observationContext, null, null, null);
    persistContext(detachedContext);
  }
  if (debuggerTabId === attachedTabId || requestedTabId === undefined) {
    debuggerTabId = null;
    debuggerAttached = false;
    resetDebuggerObservationContext(observationContext);
    setDebuggerObservationOwner(observationContext, null, null, null);
  }
}

async function handleMainDocumentRequest(tabId: number, params: Record<string, unknown> | undefined): Promise<boolean> {
  const body = params ?? {};
  const request = body.request;
  if (request === null || typeof request !== "object" || Array.isArray(request)) return true;
  const frameId = typeof body.frameId === "string" ? body.frameId : null;
  const type = typeof body.type === "string" ? body.type.toLowerCase() : null;
  const url = typeof (request as { url?: unknown }).url === "string" ? (request as { url: string }).url : null;
  if (!url || type !== "document" || frameId !== observationContext.mainFrameId) return true;
  const access = classifyPageUrl(url);
  if (access.status !== "allowed") {
    await invalidateActiveSession(tabId, access.status === "login" ? "page_login" : "document_navigation_blocked");
    return false;
  }
  if (activeAccess && !sameRouteIdentity(activeAccess, access)) {
    await invalidateActiveSession(tabId, "page_switched");
    return false;
  }
  return true;
}

function beginActiveSessionRevocation(tabId: number): ActiveSessionSnapshot | null {
  const context = contexts.peek(tabId)?.state;
  if (!context) return null;
  const snapshot: ActiveSessionSnapshot = {
    tabId,
    access: context.access,
    identity: context.identity
  };
  if (snapshot.identity) context.store.revokeSession(snapshot.identity);
  context.access = null;
  context.identity = null;
  context.domFallbackEnabled = false;
  if (activeTabId === tabId) {
    activeAccess = null;
    activeTabId = null;
    activeSessionIdentity = null;
    domFallbackEnabled = false;
  }
  return snapshot;
}

async function invalidateActiveSession(tabId: number, reason: LifecycleReasonCode): Promise<void> {
  const current = contextFor(tabId);
  const connection = sharedLiveConnection();
  const compassOwner = current.access?.routeId === "compass-live-shop" || connection?.compassTabId === tabId;
  if (compassOwner) stopLiveDomPolling();
  const snapshot = beginActiveSessionRevocation(tabId);
  if (!snapshot) return;
  const context = contextFor(tabId);
  const cleanup = (async () => {
    if (snapshot.access?.routeId === "compass-live-shop") await stopAudio(tabId, snapshot.identity);
    if (shouldPersistLivePairOnInvalidate(reason) && connection) {
      await persistLivePair(pairStorage, connection);
    } else if (shouldStopRemoteLiveOnInvalidate(reason) && sharedLiveConnection() && compassOwner) {
      await stopLiveSession(tabId);
    }
    await stopDebugger(tabId);
    if (snapshot.identity) await context.store.setLifecycle("blocked", now(), reason, snapshot.identity);
  })();
  activeRevocation = cleanup;
  try { await cleanup; }
  finally {
    activateContext(tabId);
    persistContext(context);
    if (activeRevocation === cleanup) activeRevocation = null;
  }
}

async function handleTopFrameNavigation(tabId: number, url: string): Promise<void> {
  const context = contexts.peek(tabId)?.state;
  if (!context?.identity || !context.access) return;
  activateContext(tabId);
  const access = classifyPageUrl(url);
  if (access.status !== "allowed") {
    await invalidateActiveSession(tabId, access.status === "login" ? "page_login" : "page_left_allowlist");
    return;
  }
  if (activeAccess && !sameRouteIdentity(activeAccess, access)) {
    await invalidateActiveSession(tabId, "page_switched");
    return;
  }
  activeAccess = access;
  context.lastNavigationAt = now();
  if (activeSessionIdentity) await recordAudioRefresh(store, now(), activeSessionIdentity);
}

async function currentAuthorizedUrl(tabId: number): Promise<string | null> {
  if (!debuggerAttached || debuggerTabId !== tabId) return null;
  const result = await chrome.debugger.sendCommand<{ result?: { result?: { value?: unknown } } }>(target(tabId), "Runtime.evaluate", { expression: "location.href", returnByValue: true });
  const value = result.result?.result?.value;
  return typeof value === "string" ? value : null;
}

async function startNetwork(tabId: number, url: string, guard?: LiveStartGuard): Promise<RuntimeResponse> {
  const context = activateContext(tabId);
  const requestedAccess = classifyPageUrl(url);
  if (requestedAccess.status !== "allowed") return { ok: false, error: requestedAccess.reason };
  if (requestedAccess.routeId === "qianchuan-board" && !sharedLiveConnection()) {
    return { ok: false, error: "请先在罗盘连接真实直播，再连接千川数据" };
  }
  await ensureSession(tabId, url);
  guard?.();
  const identity = activeSessionIdentity;
  if (!identity) return { ok: false, error: "业务会话尚未准备好" };
  if (debuggerAttached && debuggerTabId === tabId) {
    await store.setLifecycle("active", now(), "debugger_reused", identity);
    const result = { ok: true, state: stateFromSession(await store.load()), ...(requestedAccess.routeId === "qianchuan-board" ? { warning: "千川数据已接入同一副驾" } : {}) };
    persistContext(context);
    if (requestedAccess.routeId === "qianchuan-board") await enableCopilotSidePanel(tabId);
    scheduleSourceHealthTick();
    return result;
  }
  await store.setLifecycle("starting", now(), "network_started", identity);
  try {
    await attachDebugger(tabId);
    guard?.();
    if (activeTabId !== tabId || activeAccess?.routeId !== requestedAccess.routeId) {
      await stopDebugger();
      return { ok: false, error: "页面合同已切换，请重新点击启动" };
    }
    await store.setLifecycle("active", now(), "network_started", identity);
    const result = { ok: true, state: stateFromSession(await store.load()), ...(requestedAccess.routeId === "qianchuan-board" ? { warning: "千川数据已接入同一副驾" } : {}) };
    persistContext(context);
    if (requestedAccess.routeId === "qianchuan-board") await enableCopilotSidePanel(tabId);
    scheduleSourceHealthTick();
    return result;
  } catch {
    if (!sameSessionIdentity(activeSessionIdentity, identity)) return { ok: false, error: "页面合同已切换，请重新点击启动" };
    debuggerAttached = false;
    await store.setLifecycle("blocked", now(), "debugger_setup_failed", identity);
    const result = { ok: false, state: stateFromSession(await store.load()), error: "调试器未能附加，请确认 DevTools 未占用后重新点击" };
    persistContext(context);
    return result;
  }
}

async function startLive(tabId: number, url: string, deadlineAt = Date.now() + LIVE_START_DEADLINE_MS, capturedStreamId?: Promise<string | undefined> | string): Promise<RuntimeResponse> {
  const context = activateContext(tabId);
  const desktop = desktopCaptureOnly;
  const access = classifyPageUrl(url);
  if (access.status !== "allowed" || access.routeId !== "compass-live-shop") return { ok: false, error: "真实直播试点仅支持已打开并登录的罗盘直播大屏" };
  if (deadlineAt <= Date.now()) return { ok: false, error: new LiveStartTimeoutError().message };
  const attempt = beginLiveStart(tabId);
  let cleanupScheduled = false;
  const pairBeforeStart = sharedLive.get() ?? await loadPersistedLivePair(pairStorage);
  let createdLive: (LivePairRecord & { reused: boolean }) | undefined;
  const remaining = Math.max(0, deadlineAt - Date.now());
  const keepBusinessSession = (): boolean => pairBeforeStart !== null || createdLive?.reused === true;
  const transaction = await runLiveStartTransaction({
    network: (guard) => startNetwork(tabId, url, guard),
    createSession: async (guard) => {
      const live = await createLiveSession(tabId, attempt);
      createdLive = live;
      try {
        guard();
      } catch (error) {
        if (!live.reused) {
          if (sharedLiveConnection()?.sessionId === live.sessionId) sharedLive.clearFromCompass(tabId);
          stopRemoteLiveSession(live);
        }
        throw error;
      }
      return live;
    },
    readDom: async (guard) => {
      try {
        await collectLiveDomMetric(tabId, url, guard);
        return undefined;
      } catch (error) {
        if (error instanceof LiveStartTimeoutError) throw error;
        return liveStartDomWarning(error instanceof Error ? error.message : "请确认页面内已打开直播");
      }
    },
    startAudio: (guard) => desktop ? Promise.resolve({ ok: true, warning: "数据接入测试版：语音识别已暂停" }) : startAudio(tabId, url, guard, (expectedIdentity) => stopStaleOffscreenAudio(tabId, expectedIdentity), capturedStreamId),
    cleanup: () => { cleanupScheduled = true; abortLiveStartIfCurrent(tabId, attempt, { keepBusinessSession: keepBusinessSession() }); },
    stopOrphanSession: (session) => { if (!session.reused) stopRemoteLiveSession(session); }
  }, remaining);
  if (!("session" in transaction)) {
    if (transaction.errorCode === undefined && transaction.error?.includes("超时")) cleanupScheduled = true;
    if (!cleanupScheduled && transaction.error) {
      cleanupScheduled = true;
      abortLiveStartIfCurrent(tabId, attempt, { keepBusinessSession: keepBusinessSession() });
    }
    if (!cleanupScheduled) cancelLiveStart(tabId, attempt);
    return responseWithPair(transaction);
  }
  cancelLiveStart(tabId, attempt);
  const live = transaction.session;
  if (activeSessionIdentity) startLiveDomPolling(tabId, activeSessionIdentity);
  const result = responseWithPair({
    ...transaction.audio,
    ...(transaction.audio.ok
      ? (transaction.domWarning ? { warning: transaction.domWarning } : {})
      : { warning: liveStartAudioRetryWarning(live.reused) }),
    live: { sessionId: live.sessionId, dashboardPath: live.dashboardPath }
  });
  persistContext(context);
  if (!desktop && shouldOpenLiveDashboard(result)) await revealLiveDashboard(tabId, live.dashboardPath);
  return result;
}

async function stopNetwork(tabId = activeTabId ?? -1): Promise<RuntimeResponse> {
  const context = activateContext(tabId);
  const compass = activeAccess?.routeId === "compass-live-shop";
  if (compass) stopLiveDomPolling();
  const identity = activeSessionIdentity;
  // Stop the audio producer while the session is still writable. Marking the
  // network session stopped first would reject the final audio audit update.
  if (compass) await stopAudio(tabId, identity);
  await stopDebugger();
  if (identity) await store.setLifecycle("stopped", now(), "network_stopped", identity);
  const result = { ok: true, state: stateFromSession(await store.load()) };
  persistContext(context);
  return result;
}

async function failAudioStart(errorCode: AudioErrorCode, expectedIdentity: ProbeSessionIdentity): Promise<RuntimeResponse> {
  if (!sameSessionIdentity(activeSessionIdentity, expectedIdentity)) return { ok: false, error: "页面合同已切换，请重新点击启动" };
  const observedAt = now();
  const result = await applyAudioStatusMessage(store, { event: "error", errorCode, observedAt }, observedAt, expectedIdentity);
  return { ok: false, state: stateFromSession(result.session ?? await store.load()), errorCode, error: audioStartErrorMessage(errorCode) };
}

async function startAudio(tabId: number, url: string, guard?: LiveStartGuard, cleanupStaleAudio?: (expectedIdentity: ProbeSessionIdentity) => void, capturedStreamId?: Promise<string | undefined> | string): Promise<RuntimeResponse> {
  const context = activateContext(tabId);
  const requestedAccess = classifyPageUrl(url);
  if (requestedAccess.status !== "allowed") return { ok: false, error: requestedAccess.reason };
  if (!audioCaptureAllowedRoute(requestedAccess.routeId)) return { ok: false, error: "Phase 2A 音频探针仅支持罗盘经营页" };
  await ensureSession(tabId, url);
  guard?.();
  const identity = activeSessionIdentity;
  const session = await store.load();
  if (!session || !identity || session.sessionId !== identity.sessionId || session.routeId !== identity.routeId) return { ok: false, error: "业务会话尚未准备好" };
  const requestedAt = now();
  await store.setAudio(transitionAudio(session.audio, { type: "request", observedAt: requestedAt }), requestedAt, identity);
  let streamId: string;
  try {
    await closeOffscreenAudioDocument({
      sendStop: () => chrome.runtime.sendMessage({ type: "audio:stop" }),
      hasDocument: () => chrome.offscreen.hasDocument(),
      closeDocument: () => chrome.offscreen.closeDocument()
    });
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "仅测量用户授权 Tab 音频连续性，不录音" });
    const prefetched = typeof capturedStreamId === "string" ? capturedStreamId : capturedStreamId ? await capturedStreamId : undefined;
    streamId = prefetched ?? await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch {
    return failAudioStart("tab_capture_failed", identity);
  }
  guard?.();
  let consumeResponse: Awaited<ReturnType<typeof requestAudioConsume>>;
  try {
    consumeResponse = await awaitAudioConsumeForLiveStart(
      requestAudioConsume(
        (message, callback) => chrome.runtime.sendMessage(message, callback),
        () => chrome.runtime.lastError,
        streamId,
        tabId,
        identity,
        sharedLiveConnection() ? { sessionId: sharedLiveConnection()!.sessionId, pairToken: sharedLiveConnection()!.pairToken, audioWsUrl: `${LIVE_SERVER_ORIGIN.replace(/^http/, "ws")}/ws/live/${encodeURIComponent(sharedLiveConnection()!.sessionId)}` } : undefined
      ),
      guard ?? (() => undefined),
      () => cleanupStaleAudio?.(identity)
    );
  } catch (error) {
    if (error instanceof LiveStartTimeoutError) cleanupStaleAudio?.(identity);
    throw error;
  }
  if (!consumeResponse.ok) return failAudioStart(consumeResponse.errorCode, identity);
  if (activeTabId !== tabId || !sameSessionIdentity(activeSessionIdentity, identity) || activeAccess?.routeId !== requestedAccess.routeId) return { ok: false, error: "页面合同已切换，请重新点击启动" };
  const latest = await store.load();
  if (!latest) return { ok: false, errorCode: "audio_consume_failed", error: "业务会话尚未准备好" };
  if (latest.audio.captureLifecycle === "active" || latest.audio.captureLifecycle === "muted" || latest.audio.captureLifecycle === "authorized") {
    const result = { ok: true, state: stateFromSession(latest) };
    persistContext(context);
    return result;
  }
  if (latest.audio.captureLifecycle !== "requesting") return failAudioStart("audio_consume_failed", identity);
  const authorized = transitionAudio(latest.audio, { type: "authorized", observedAt: now(), trackCount: 0 });
  const updated = await store.setAudio(authorized, authorized.observedAt, identity);
  guard?.();
  const result = { ok: true, state: stateFromSession(updated ?? await store.load()) };
  persistContext(context);
  return result;
}

async function stopAudio(tabId = activeTabId ?? -1, expectedIdentity: ProbeSessionIdentity | null = activeSessionIdentity): Promise<RuntimeResponse> {
  const context = activateContext(tabId);
  const session = await store.load();
  const identity = expectedIdentity;
  if (session && identity && session.routeId === identity.routeId && session.sessionId === identity.sessionId) {
    const observedAt = now();
    await store.setAudio(transitionAudio(session.audio, { type: "stop", observedAt }), observedAt, identity);
  }
  await closeOffscreenAudioDocument({
    sendStop: () => chrome.runtime.sendMessage({ type: "audio:stop" }),
    hasDocument: () => chrome.offscreen.hasDocument(),
    closeDocument: () => chrome.offscreen.closeDocument()
  });
  const result = { ok: true, state: stateFromSession(await store.load()) };
  persistContext(context);
  return result;
}

async function collectDom(tabId = activeTabId ?? -1): Promise<RuntimeResponse> {
  activateContext(tabId);
  const session = await store.load();
  const identity = activeSessionIdentity;
  if (!session || !identity || session.routeId !== identity.routeId || session.sessionId !== identity.sessionId || activeTabId === null || !activeAccess) return { ok: false, error: "尚未启动白名单页面探针" };
  if (!domFallbackAllowed(activeAccess, session.network.length, session.routeId)) return { ok: false, state: stateFromSession(session), error: "CDP 已有结构或页面未获授权，不注入 DOM fallback" };
  try {
    const currentUrl = await currentAuthorizedUrl(activeTabId);
    const currentAccess = currentUrl ? classifyPageUrl(currentUrl) : null;
    if (!currentAccess || currentAccess.status !== "allowed" || !sameRouteIdentity(currentAccess, activeAccess) || session.routeId !== currentAccess.routeId) {
      if (currentUrl) await invalidateActiveSession(activeTabId, "document_navigation_blocked");
      return { ok: false, error: "当前页面已无法通过白名单校验，未注入 DOM fallback" };
    }
    activeAccess = currentAccess;
    const result = await chrome.scripting.executeScript({ target: { tabId: activeTabId }, func: collectDomFieldCandidates });
    const candidates = result[0]?.result ?? [];
    const dom = sanitizeDomFields(candidates, session.dom, now(), true);
    if (!sameSessionIdentity(activeSessionIdentity, identity)) return { ok: false, error: "页面合同已切换，请重新点击启动" };
    domFallbackEnabled = true;
    await store.setDom(dom, now(), identity);
    return { ok: true, state: stateFromSession(await store.load()) };
  } catch {
    if (!sameSessionIdentity(activeSessionIdentity, identity)) return { ok: false, error: "页面合同已切换，请重新点击启动" };
    const updated = await store.setLifecycle("blocked", now(), "dom_fallback_failed", identity);
    return { ok: false, state: stateFromSession(updated), error: "DOM fallback 未能注入，请确认页面仍在白名单" };
  }
}

async function addMarker(code: BusinessMarkerCode): Promise<RuntimeResponse> {
  if (!isMarkerCode(code) || !code.startsWith("action_") && !code.startsWith("subject_")) return { ok: false, error: "业务标记枚举无效" };
  const identity = activeSessionIdentity;
  if (!identity) return { ok: false, state: null, error: "尚未启动探针会话" };
  const updated = await store.addMarker(code, `marker-${crypto.randomUUID()}`, now(), identity);
  if (updated) return { ok: true, state: stateFromSession(updated) };
  return { ok: false, state: null, error: "尚未启动探针会话" };
}

async function handleAudioStatus(message: Record<string, unknown>): Promise<RuntimeResponse> {
  const compassTabId = sharedLiveConnection()?.compassTabId;
  if (compassTabId !== undefined) activateContext(compassTabId);
  const routeId = message.routeId;
  if (typeof routeId !== "string" || !audioCaptureAllowedRoute(routeId as ProbeSessionIdentity["routeId"]) || !activeAccess || activeAccess.routeId !== routeId) {
    return { ok: false, error: "音频状态所属页面合同已失效" };
  }
  const identity = activeSessionIdentity;
  if (!identity || identity.routeId !== routeId || typeof message.sessionId !== "string" || message.sessionId !== identity.sessionId) return { ok: false, error: "音频状态所属会话已失效" };
  const result = await applyAudioStatusMessage(store, message, now(), identity);
  if (!result.ok) return { ok: false, error: result.error ?? "音频状态处理失败" };
  // The offscreen document emits a one-second energy heartbeat. Use it to
  // wake the MV3 worker and retry the DOM fallback every five seconds; an
  // interval alone can be suspended when the worker is idle.
  if (message.event === "energy" && activeTabId !== null) {
    await pollLiveDomMetricIfDue(activeTabId, identity);
  }
  return { ok: true, state: stateFromSession(result.session ?? await store.load()) };
}

async function handleMessage(message: ProbeMessage, deadlineAt?: number, capturedStreamId?: Promise<string | undefined>): Promise<RuntimeResponse> {
  if (desktopCaptureOnly && (message.type === "probe:start_audio" || ("url" in message && classifyPageUrl(message.url).routeId?.startsWith("qianchuan")))) return { ok: false, error: "桌面测试版只采集罗盘，千川请在副驾内登录官方授权" };
  const tabId = message.tabId ?? activeTabId ?? -1;
  switch (message.type) {
    case "probe:get_state": activateContext(tabId); return responseWithPair({ ok: true, state: stateFromSession(await store.load()) });
    case "probe:start_live": return startLive(message.tabId, message.url, deadlineAt, capturedStreamId);
    case "probe:stop_live": return stopLiveSession(tabId);
    case "probe:start_network": return startNetwork(message.tabId, message.url);
    case "probe:stop_network": activateContext(tabId); return stopNetwork();
    case "probe:start_audio": return startAudio(message.tabId, message.url);
    case "probe:stop_audio": {
      const requested = contextFor(tabId).access?.routeId;
      const owner = sharedLiveConnection()?.compassTabId;
      if (!compassAudioOwnedByTab(requested, tabId, owner)) return { ok: false, error: "音频探针只能由当前罗盘直播页停止" };
      return stopAudio(tabId);
    }
    case "probe:collect_dom": return collectDom(tabId);
    case "probe:add_marker": activateContext(tabId); return addMarker(message.code);
    case "probe:recover_source": return recoverSource(message.tabId, message.source, message.confirm);
    case "probe:export": {
      activateContext(tabId);
      const session = await store.load();
      return session ? { ok: true, export: exportProbeSession(session, now()), state: stateFromSession(session) } : { ok: false, error: "尚未启动探针会话" };
    }
  }
}

function enqueueProbeMessage(message: ProbeMessage, receivedAt: number): Promise<RuntimeResponse> {
  if (message.type !== "probe:start_live") return runtimeQueue.enqueue(async () => {
    await livePairReady;
    return handleMessage(message);
  });
  const deadlineAt = receivedAt + LIVE_START_DEADLINE_MS;
  const capturedStreamId = desktopCaptureOnly ? undefined : chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId }).catch(() => undefined);
  return runtimeQueue.enqueueWithDeadline(
    async () => {
      await livePairReady;
      return handleMessage(message, deadlineAt, capturedStreamId);
    },
    deadlineAt,
    () => ({ ok: false, error: "真实直播连接超时，请重新加载扩展后重试" })
  );
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const context = contexts.peek(tabId)?.state;
  if (!context?.debuggerAttached || !context.identity) return;
  void runtimeQueue.enqueue(async () => {
    try {
      // Helpers below use the selected context. A single queue prevents another
      // tab from changing that selection while an awaited debugger call runs.
      activateContext(tabId);
      const eventIdentity = context.identity;
      if (!eventIdentity || !sameSessionIdentity(activeSessionIdentity, eventIdentity)) return;
      const observedAt = now();
      if (method === "Network.requestWillBeSent" && !(await handleMainDocumentRequest(tabId, params))) return;
      if (method === "Page.frameNavigated") {
        const frame = params?.frame;
        if (frame !== null && typeof frame === "object" && !Array.isArray(frame)) {
          const frameRecord = frame as { id?: unknown; parentId?: unknown; url?: unknown };
          if ((frameRecord.id === observationContext.mainFrameId || frameRecord.parentId === undefined || frameRecord.parentId === null) && typeof frameRecord.url === "string") await handleTopFrameNavigation(tabId, frameRecord.url);
        }
        if (activeTabId === null) return;
      }
      if (method === "Page.navigatedWithinDocument") {
        const frameId = params?.frameId;
        const url = params?.url;
        if (frameId === observationContext.mainFrameId && typeof url === "string") await handleTopFrameNavigation(tabId, url);
        if (activeTabId === null) return;
      }
      await observeDebuggerEvent(store, method, params, observedAt, observationContext, tabId, eventIdentity, async ({ origin, endpoint, body, observedAt: frameObservedAt }) => {
        if (!sharedLiveConnection()) return;
        if (eventIdentity.routeId === "qianchuan-board") {
          const metric = parseLiveMetricForRoute(eventIdentity.routeId, { origin, endpoint, body, observedAt: frameObservedAt });
          if (metric) await sendLiveMetric(metric);
          return;
        }
        if (eventIdentity.routeId !== "compass-live-shop") return;
        const metric = parseLiveMetricForRoute(eventIdentity.routeId, { origin, endpoint, body, observedAt: frameObservedAt });
        if (metric) await sendLiveMetric({ ...metric, mappingVersion: COMPASS_LIVE_MAPPING_VERSION });
      });
      if (method === "Network.loadingFinished") {
        const requestId = params && typeof params.requestId === "string" ? params.requestId : null;
        if (requestId) {
          await inspectJsonResponseBody(store, requestId, observedAt, observationContext, async (id) => {
            return chrome.debugger.sendCommand<{ body?: string; base64Encoded?: boolean }>(target(tabId), "Network.getResponseBody", { requestId: id });
          }, eventIdentity, async ({ origin, endpoint, body, observedAt: bodyObservedAt }) => {
            if (!sharedLiveConnection()) return;
            if (eventIdentity.routeId === "qianchuan-board") {
              const metric = parseLiveMetricForRoute(eventIdentity.routeId, { origin, endpoint, body, observedAt: bodyObservedAt });
              if (metric) await sendLiveMetric(metric);
              return;
            }
            if (eventIdentity.routeId !== "compass-live-shop") return;
            const metric = parseLiveMetricForRoute(eventIdentity.routeId, { origin, endpoint, body, observedAt: bodyObservedAt });
            if (metric) await sendLiveMetric({ ...metric, mappingVersion: COMPASS_LIVE_MAPPING_VERSION });
          });
        }
      }
    } catch {
      activateContext(tabId);
      if (context.identity && sameSessionIdentity(activeSessionIdentity, context.identity)) await store.setLifecycle("stale", now(), "observation_failed", context.identity);
    } finally {
      activateContext(tabId);
      persistContext(context);
    }
  }).catch(() => undefined);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId === undefined || !contexts.peek(tabId)) return;
  void runtimeQueue.enqueue(async () => {
    const context = contexts.peek(tabId)?.state;
    if (!context) return;
    activateContext(tabId);
    const identity = context.identity;
    context.debuggerAttached = false;
    debuggerAttached = false;
    debuggerTabId = null;
    resetDebuggerObservationContext(context.observationContext);
    setDebuggerObservationOwner(context.observationContext, null, null, null);
    persistContext(context);
    if (identity) await context.store.setLifecycle(reason === "canceled_by_user" ? "stopped" : "stale", now(), reason === "canceled_by_user" ? "user_stopped_debugger" : "debugger_detached", identity);
  }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message !== null && typeof message === "object" && (message as { type?: unknown }).type === "audio:status") {
    void runtimeQueue.enqueue(async () => {
      const result = await handleAudioStatus(message as Record<string, unknown>);
      const compassTabId = sharedLiveConnection()?.compassTabId;
      if (compassTabId !== undefined) {
        const context = contextFor(compassTabId);
        activateContext(compassTabId);
        persistContext(context);
      }
      return result;
    }).then(sendResponse).catch(() => sendResponse({ ok: false, error: "audio_status_failed" }));
    return true;
  }
  if (!isProbeMessage(message)) return false;
  const receivedAt = Date.now();
  void enqueueProbeMessage(message, receivedAt).then(sendResponse).catch(() => sendResponse({ ok: false, error: "probe_operation_failed" }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void restoreSharedLiveFromStorage();
});
chrome.runtime.onStartup.addListener(() => {
  void restoreSharedLiveFromStorage();
});
