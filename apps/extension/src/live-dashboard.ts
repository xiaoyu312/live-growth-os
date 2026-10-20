export const LIVE_DASHBOARD_ORIGIN = "http://127.0.0.1:3000";
export const LIVE_DASHBOARD_STORAGE_KEY = "live-growth-os:live-dashboard";
export const LIVE_DASHBOARD_SIDE_PANEL_PATH = "sidepanel.html";

export type LiveDashboardRecord = { dashboardPath: string };
export type LiveDashboardWindowCreateOptions = {
  url: string;
  type: "normal";
  focused: true;
  width: number;
  height: number;
};

const DASHBOARD_PATH_PATTERN = /^\/live\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function liveDashboardUrl(dashboardPath: string): string | undefined {
  if (!DASHBOARD_PATH_PATTERN.test(dashboardPath)) return undefined;
  return `${LIVE_DASHBOARD_ORIGIN}${dashboardPath}`;
}

export function liveDashboardWindowCreateOptions(url: string): LiveDashboardWindowCreateOptions {
  return { url, type: "normal", focused: shouldFocusLiveDashboardWindow(), width: 1440, height: 920 };
}

export function shouldFocusLiveDashboardWindow(): true {
  return true;
}

export function parseLiveDashboardRecord(value: unknown): LiveDashboardRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const dashboardPath = "dashboardPath" in value ? value.dashboardPath : undefined;
  if (typeof dashboardPath !== "string" || !liveDashboardUrl(dashboardPath)) return null;
  return { dashboardPath };
}

export function liveDashboardSidePanelOptions(tabId: number): { tabId: number; path: string; enabled: true } {
  return { tabId, path: LIVE_DASHBOARD_SIDE_PANEL_PATH, enabled: true };
}
