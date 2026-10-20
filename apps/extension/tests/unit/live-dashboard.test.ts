import { describe, expect, it } from "vitest";
import {
  LIVE_DASHBOARD_ORIGIN,
  LIVE_DASHBOARD_SIDE_PANEL_PATH,
  liveDashboardSidePanelOptions,
  liveDashboardUrl,
  liveDashboardWindowCreateOptions,
  parseLiveDashboardRecord,
  shouldFocusLiveDashboardWindow
} from "../../src/live-dashboard";

const path = "/live/11111111-1111-4111-8111-111111111111";

describe("副驾用独立页展示", () => {
  it("只打开本机 /live 路径，连接时把独立页提到前台", () => {
    expect(liveDashboardUrl(path)).toBe(`${LIVE_DASHBOARD_ORIGIN}${path}`);
    expect(liveDashboardUrl("/lab")).toBeUndefined();
    expect(liveDashboardUrl("http://example.com/live/x")).toBeUndefined();
    expect(shouldFocusLiveDashboardWindow()).toBe(true);
    expect(liveDashboardWindowCreateOptions(`${LIVE_DASHBOARD_ORIGIN}${path}`)).toEqual({
      url: `${LIVE_DASHBOARD_ORIGIN}${path}`,
      type: "normal",
      focused: true,
      width: 1440,
      height: 920
    });
  });

  it("侧栏只绑定当前平台 Tab，并拒绝非副驾路径", () => {
    expect(liveDashboardSidePanelOptions(42)).toEqual({ tabId: 42, path: LIVE_DASHBOARD_SIDE_PANEL_PATH, enabled: true });
    expect(parseLiveDashboardRecord({ dashboardPath: path })).toEqual({ dashboardPath: path });
    expect(parseLiveDashboardRecord({ dashboardPath: "/live/not-a-session" })).toBeNull();
    expect(parseLiveDashboardRecord({ dashboardPath: "https://qianchuan.jinritemai.com/board-next" })).toBeNull();
  });
});
