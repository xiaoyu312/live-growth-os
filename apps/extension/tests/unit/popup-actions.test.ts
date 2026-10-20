import { describe, expect, it } from "vitest";
import { popupCanResume, popupPrimaryActions, popupProbeActive, popupRecoverAction } from "../../src/popup-actions";

describe("扩展弹窗主按钮", () => {
  it("千川独立直播大屏露出连接千川数据，不露连接罗盘", () => {
    const actions = popupPrimaryActions("qianchuan-board");
    expect(actions.showQianchuan).toBe(true);
    expect(actions.showCompassLive).toBe(false);
    expect(actions.hint).toContain("连接千川数据");
  });

  it("罗盘经营页露出连接真实直播，不露连接千川", () => {
    const actions = popupPrimaryActions("compass-live-shop");
    expect(actions.showCompassLive).toBe(true);
    expect(actions.showQianchuan).toBe(false);
    expect(actions.startLiveLabel).toBe("连接真实直播（罗盘）");
    expect(actions.hint).toContain("连接真实直播");
  });

  it("有可恢复配对时按钮改为恢复上一场直播", () => {
    const actions = popupPrimaryActions("compass-live-shop", { canResume: true });
    expect(actions.startLiveLabel).toBe("恢复上一场直播");
    expect(actions.hint).toContain("恢复上一场直播");
    expect(popupCanResume({ routeId: "compass-live-shop", hasPair: true, probeActive: false })).toBe(true);
    expect(popupCanResume({ routeId: "compass-live-shop", hasPair: true, probeActive: true })).toBe(false);
    expect(popupProbeActive({ session: { lifecycle: "active" } })).toBe(true);
    expect(popupProbeActive({ session: { lifecycle: "blocked" } })).toBe(false);
  });

  it("千川与罗盘分别露出受控刷新按钮", () => {
    expect(popupRecoverAction("qianchuan-board")).toMatchObject({ showRecover: true, source: "qianchuan", label: "刷新千川页面" });
    expect(popupRecoverAction("compass-live-shop")).toMatchObject({ showRecover: true, source: "compass", label: "刷新并重新连接" });
    expect(popupRecoverAction(null).showRecover).toBe(false);
  });
});
