import { desktopCaptureOnly } from "./desktop-mode.js";
import { audioCaptureAllowedRoute, classifyPageUrl, pageDisplayName } from "./allowlist.js";
import type { BusinessMarkerCode, ProbeMessage, RuntimeResponse } from "./types.js";
import { requestRuntimeMessage } from "./popup-request.js";
import { liveServerUnreachableMessage, networkActionLabel, POPUP_LIVE_START_TIMEOUT_MS } from "./live-start.js";
import { popupCanResume, popupPrimaryActions, popupProbeActive, popupRecoverAction } from "./popup-actions.js";

const pageElement = document.querySelector<HTMLElement>("#page");
const probeElement = document.querySelector<HTMLElement>("#probe");
const audioLifecycleElement = document.querySelector<HTMLElement>("#audio-lifecycle");
const audioNetworkElement = document.querySelector<HTMLElement>("#audio-network");
const audioRefreshElement = document.querySelector<HTMLElement>("#audio-refresh");
const countsElement = document.querySelector<HTMLElement>("#counts");
const errorElement = document.querySelector<HTMLElement>("#error");
const markerElement = document.querySelector<HTMLSelectElement>("#marker");

function setError(message = ""): void { if (errorElement) errorElement.textContent = message; }
function updateDomControl(routeId: string | null): void {
  const element = document.querySelector<HTMLButtonElement>("#collect-dom");
  if (!element) return;
  const compass = !desktopCaptureOnly && routeId === "compass-live-shop";
  element.hidden = !compass;
  element.disabled = !compass;
}
function applyPrimaryActions(routeId: string | null, canResume = false): void {
  const actions = popupPrimaryActions(routeId, { canResume });
  const startLive = document.querySelector<HTMLButtonElement>("#start-live");
  const stopLive = document.querySelector<HTMLButtonElement>("#stop-live");
  const startNetwork = document.querySelector<HTMLButtonElement>("#start-network");
  const stopNetwork = document.querySelector<HTMLButtonElement>("#stop-network");
  const hint = document.querySelector<HTMLElement>("#hint");
  if (startLive) {
    startLive.hidden = !actions.showCompassLive;
    startLive.textContent = actions.startLiveLabel;
  }
  if (stopLive) stopLive.hidden = !actions.showCompassLive;
  if (startNetwork) {
    startNetwork.hidden = desktopCaptureOnly || !actions.showQianchuan;
    startNetwork.textContent = networkActionLabel(routeId);
  }
  if (stopNetwork) stopNetwork.hidden = desktopCaptureOnly || !actions.showQianchuan;
  const recover = popupRecoverAction(routeId);
  const recoverButton = document.querySelector<HTMLButtonElement>("#recover-source");
  if (recoverButton) {
    recoverButton.hidden = !recover.showRecover;
    recoverButton.textContent = recover.label;
  }
  if (hint) hint.textContent = actions.hint;
}

function syncPrimaryActions(response: RuntimeResponse, url?: string): void {
  if (!url) return;
  const routeId = classifyPageUrl(url).routeId;
  applyPrimaryActions(routeId, popupCanResume({
    routeId,
    hasPair: Boolean(response.resumableLive),
    probeActive: popupProbeActive(response.state)
  }));
}
function button(id: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`#${id}`);
  if (!element) throw new Error(`缺少按钮：${id}`);
  return element;
}

async function activeTab(): Promise<{ tabId: number; url: string } | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  return tab?.id !== undefined && tab.url ? { tabId: tab.id, url: tab.url } : null;
}

async function withActiveTab(operation: (tab: { tabId: number; url: string }) => Promise<unknown>, missingMessage = "没有可操作的当前 Tab"): Promise<void> {
  const tab = await activeTab();
  if (!tab) { setError(missingMessage); return; }
  await operation(tab);
}

function render(response: RuntimeResponse, pageText?: string): void {
  const state = response.state;
  if (pageElement && pageText) pageElement.textContent = pageText;
  if (!state) {
    updateDomControl(null);
    if (probeElement) probeElement.textContent = "未启动";
    if (audioLifecycleElement) audioLifecycleElement.textContent = "未启动";
    if (audioNetworkElement) audioNetworkElement.textContent = "未知";
    if (audioRefreshElement) audioRefreshElement.textContent = "未观察";
    if (countsElement) countsElement.textContent = "暂无结构摘要";
    return;
  }
  updateDomControl(state.access.routeId);
  if (pageElement) pageElement.textContent = `${pageDisplayName(state.access.page, state.access.routeId)} · ${state.access.status}`;
  if (probeElement) probeElement.textContent = state.session.lifecycle;
  if (audioLifecycleElement) audioLifecycleElement.textContent = state.session.audio.captureLifecycle;
  if (audioNetworkElement) audioNetworkElement.textContent = state.session.audio.networkStatus;
  if (audioRefreshElement) audioRefreshElement.textContent = state.session.audio.lastRefreshObservedAt ?? "未观察";
  if (countsElement) countsElement.textContent = `HTTP/WS ${state.session.network.length} · iframe/Worker ${state.session.targets.length} · DOM ${state.session.dom.length} · 标记 ${state.session.markers.length}`;
}

async function send(message: ProbeMessage): Promise<RuntimeResponse> {
  try {
    const timeoutMs = message.type === "probe:start_live" ? POPUP_LIVE_START_TIMEOUT_MS : undefined;
    const response = await requestRuntimeMessage<RuntimeResponse>((request, callback) => chrome.runtime.sendMessage(request, callback), () => chrome.runtime.lastError, message, timeoutMs);
    if (response.error) setError(liveServerUnreachableMessage(response.error));
    else if (response.warning) setError(response.warning);
    else setError();
    render(response);
    const tab = await activeTab();
    if (tab) syncPrimaryActions(response, tab.url);
    return response;
  } catch (error) {
    const response: RuntimeResponse = { ok: false, error: liveServerUnreachableMessage(error instanceof Error ? error : "扩展后台连接失败，请重新加载扩展后重试") };
    setError(response.error);
    render(response);
    const tab = await activeTab();
    if (tab) syncPrimaryActions(response, tab.url);
    return response;
  }
}

async function startNetwork(): Promise<void> {
  const tab = await activeTab();
  if (!tab) { setError("没有可授权的当前 Tab"); return; }
  const access = classifyPageUrl(tab.url);
  updateDomControl(access.routeId);
  applyPrimaryActions(access.routeId);
  render(access.status === "allowed" ? { ok: true } : { ok: false, error: access.reason }, `${pageDisplayName(access.page, access.routeId)} · ${access.status}`);
  if (access.status !== "allowed") { setError(access.reason); return; }
  await send({ type: "probe:start_network", tabId: tab.tabId, url: tab.url });
}

async function startLive(): Promise<void> {
  setError("正在连接罗盘直播，请稍候…");
  const startButton = button("start-live");
  const originalText = startButton.textContent ?? "连接真实直播（罗盘）";
  startButton.textContent = "连接中…";
  startButton.disabled = true;
  try {
  const tab = await activeTab();
  if (!tab) { setError("没有可授权的当前 Tab"); return; }
  const access = classifyPageUrl(tab.url);
  if (access.status !== "allowed" || access.routeId !== "compass-live-shop") {
    setError("请先在罗盘直播大屏打开直播并解除静音，再点击连接真实直播");
    return;
  }
  await send({ type: "probe:start_live", tabId: tab.tabId, url: tab.url });
  } finally {
    startButton.disabled = false;
    if (startButton.textContent === "连接中…") startButton.textContent = originalText;
  }
}

async function startAudio(): Promise<void> {
  const tab = await activeTab();
  if (!tab) { setError("没有可授权的当前 Tab"); return; }
  const access = classifyPageUrl(tab.url);
  if (access.status !== "allowed") { setError(access.reason); return; }
  if (!audioCaptureAllowedRoute(access.routeId)) { setError("Phase 2A 音频探针仅支持罗盘经营页"); return; }
  await send({ type: "probe:start_audio", tabId: tab.tabId, url: tab.url });
}

async function exportSession(): Promise<void> {
  const tab = await activeTab();
  if (!tab) { setError("没有可读取的当前 Tab"); return; }
  const response = await send({ type: "probe:export", tabId: tab.tabId });
  if (!response.ok || !response.export) return;
  const blob = new Blob([JSON.stringify(response.export, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = "phase-2a-probe-sanitized.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

async function recoverSource(): Promise<void> {
  const tab = await activeTab();
  if (!tab) { setError("没有可操作的当前 Tab"); return; }
  const recover = popupRecoverAction(classifyPageUrl(tab.url).routeId);
  if (!recover.source) return;
  if (recover.source === "compass" && !window.confirm("罗盘数据已停止更新。刷新会暂时中断音频和转写，刷新后需要重新授权音频。")) return;
  await send({ type: "probe:recover_source", tabId: tab.tabId, source: recover.source, confirm: true });
}

button("start-network").addEventListener("click", () => { void startNetwork(); });
button("stop-network").addEventListener("click", () => { void withActiveTab((tab) => send({ type: "probe:stop_network", tabId: tab.tabId })); });
button("recover-source").addEventListener("click", () => { void recoverSource(); });
button("start-live").addEventListener("click", () => { void startLive(); });
button("stop-live").addEventListener("click", () => { void withActiveTab((tab) => send({ type: "probe:stop_live", tabId: tab.tabId })); });
button("start-audio").addEventListener("click", () => { void startAudio(); });
button("stop-audio").addEventListener("click", () => { void withActiveTab((tab) => send({ type: "probe:stop_audio", tabId: tab.tabId })); });
button("collect-dom").addEventListener("click", () => { void withActiveTab((tab) => send({ type: "probe:collect_dom", tabId: tab.tabId })); });
button("export").addEventListener("click", () => { void exportSession(); });
button("add-marker").addEventListener("click", () => {
  const code = markerElement?.value as BusinessMarkerCode | undefined;
  if (!code) { setError("请选择业务标记"); return; }
  void withActiveTab((tab) => send({ type: "probe:add_marker", tabId: tab.tabId, code }), "没有可标记的当前 Tab");
});

void (async () => {
  const tab = await activeTab();
  if (tab) {
    const access = classifyPageUrl(tab.url);
    updateDomControl(access.routeId);
    applyPrimaryActions(access.routeId);
    render(access.status === "allowed" ? { ok: true } : { ok: false, error: access.reason }, `${pageDisplayName(access.page, access.routeId)} · ${access.status}`);
  }
  await send({ type: "probe:get_state", ...(tab ? { tabId: tab.tabId } : {}) });
})();
