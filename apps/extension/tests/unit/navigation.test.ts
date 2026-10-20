import { describe, expect, it } from "vitest";
import { classifyPageUrl, navigationDecision } from "../../src/allowlist";

describe("Phase 2A 顶层导航门控", () => {
  it("白名单页可继续，非白名单和登录跳转必须撤销授权", () => {
    expect(navigationDecision("https://compass.jinritemai.com/screen/live/shop/")).toMatchObject({ allowed: true, shouldRevoke: false });
    expect(navigationDecision("https://compass.jinritemai.com/login")).toMatchObject({ allowed: false, shouldRevoke: true, status: "blocked" });
    expect(navigationDecision("https://compass.jinritemai.com/screen/live/shop/login")).toMatchObject({ allowed: false, shouldRevoke: true, status: "login" });
    expect(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop/detail").status).toBe("blocked");
  });
});
