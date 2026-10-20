import { describe, expect, it } from "vitest";
import { assemblePageRuntime, pageRuntimeExportHasSecrets, sanitizePageRuntimeFlags } from "../../src/page-runtime";

describe("page-runtime", () => {
  it("只保留布尔／枚举／时间，拒绝 tabId 和标题", () => {
    expect(sanitizePageRuntimeFlags({
      visibilityState: "hidden",
      hasFocus: false,
      navigatorOnline: true,
      title: "secret"
    })).toEqual({ visibilityState: "hidden", hasFocus: false, navigatorOnline: true });
    const runtime = assemblePageRuntime({
      source: "qianchuan",
      flags: { visibilityState: "hidden", hasFocus: false, navigatorOnline: true },
      debuggerAttached: true,
      allowlistStatus: "allowed",
      topFrameLifecycle: "live",
      observedAt: "2026-08-21T08:00:00.000Z"
    });
    expect(runtime).not.toHaveProperty("tabId");
    expect(pageRuntimeExportHasSecrets({ ...runtime, tabId: 12 })).toBe(true);
    expect(pageRuntimeExportHasSecrets(runtime)).toBe(false);
  });
});
