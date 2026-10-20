import { LIVE_DASHBOARD_STORAGE_KEY, liveDashboardUrl, parseLiveDashboardRecord } from "./live-dashboard.js";

const frame = document.querySelector<HTMLIFrameElement>("#frame");
const waiting = document.querySelector<HTMLElement>("#waiting");

function render(dashboardPath?: string): void {
  const url = dashboardPath ? liveDashboardUrl(dashboardPath) : undefined;
  if (!frame || !waiting) return;
  if (!url) {
    frame.removeAttribute("src");
    frame.hidden = true;
    waiting.hidden = false;
    return;
  }
  if (frame.getAttribute("src") !== url) frame.src = url;
  frame.hidden = false;
  waiting.hidden = true;
}

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(LIVE_DASHBOARD_STORAGE_KEY);
  const record = parseLiveDashboardRecord(stored[LIVE_DASHBOARD_STORAGE_KEY]);
  render(record?.dashboardPath);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[LIVE_DASHBOARD_STORAGE_KEY]) return;
  const record = parseLiveDashboardRecord(changes[LIVE_DASHBOARD_STORAGE_KEY]?.newValue);
  render(record?.dashboardPath);
});

void load();
