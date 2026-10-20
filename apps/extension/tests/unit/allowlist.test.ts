import { describe, expect, it } from "vitest";
import { audioCaptureAllowedRoute, classifyPageUrl, isAllowedOrigin, sanitizeCompassWebSocketUrl, sanitizePageUrl, sameRouteIdentity } from "../../src/allowlist";

describe("Phase 2A 页面白名单", () => {
  it("允许 Compass shop 页面并去除 query 与 fragment", () => {
    expect(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop?room=secret#x")).toMatchObject({ status: "allowed", page: "compass", routeId: "compass-live-shop", origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop" });
    expect(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop/").status).toBe("allowed");
    expect(classifyPageUrl("https://compass.jinritemai.com:443/screen/live/shop").status).toBe("allowed");
    expect(classifyPageUrl("https://compass.jinritemai.com:444/screen/live/shop").status).toBe("blocked");
    expect(isAllowedOrigin("https://compass.jinritemai.com:443/api")).toBe(true);
    expect(isAllowedOrigin("https://compass.jinritemai.com:444/api")).toBe(false);
    expect(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop/detail").status).toBe("blocked");
    expect(sanitizePageUrl("https://compass.jinritemai.com/screen/live/shop?room=secret#x")).toEqual({ origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop" });
  });

  it("允许 Compass official 直播路径的精确变体，并拒绝拼接路径", () => {
    for (const url of [
      "https://compass.jinritemai.com/screen/live/shop-official?room=live#data",
      "https://compass.jinritemai.com/screen/live/shop-official/",
      "https://compass.jinritemai.com:443/screen/live/shop-official"
    ]) {
      expect(classifyPageUrl(url)).toMatchObject({ status: "allowed", page: "compass", routeId: "compass-live-shop" });
    }
    expect(classifyPageUrl("https://compass.jinritemai.com:444/screen/live/shop-official").status).toBe("blocked");
    expect(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop-official/detail").status).toBe("blocked");
    expect(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop-officially").status).toBe("blocked");
    expect(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop-official/login").status).toBe("login");
  });

  it("允许 Qianchuan 独立投放路径前缀但拒绝猜测域名", () => {
    expect(classifyPageUrl("https://agent.oceanengine.com/admin/optimizeModule/qianchuan/promotion/domain/roi2-adv")).toMatchObject({ page: "qianchuan", routeId: "qianchuan-agent" });
    expect(classifyPageUrl("https://agent.oceanengine.com:444/admin/optimizeModule/qianchuan/").status).toBe("blocked");
    expect(classifyPageUrl("https://qianchuan.jinritemai.com/admin/optimizeModule/qianchuan/roi2-adv").status).toBe("blocked");
  });

  it("允许 qianchuan board-next exact host/path，并拒绝嵌套、认证、HTTP 和猜测子域", () => {
    expect(classifyPageUrl("https://qianchuan.jinritemai.com/board-next")).toMatchObject({ status: "allowed", page: "qianchuan", routeId: "qianchuan-board", origin: "https://qianchuan.jinritemai.com", pathname: "/board-next" });
    expect(classifyPageUrl("https://qianchuan.jinritemai.com/board-next/").status).toBe("allowed");
    expect(classifyPageUrl("https://qianchuan.jinritemai.com:443/board-next").status).toBe("allowed");
    expect(classifyPageUrl("https://qianchuan.jinritemai.com:444/board-next").status).toBe("blocked");
    expect(sanitizePageUrl("https://qianchuan.jinritemai.com/board-next?query=redacted#fragment")).toEqual({ origin: "https://qianchuan.jinritemai.com", pathname: "/board-next" });
    expect(classifyPageUrl("https://qianchuan.jinritemai.com/board-next/detail").status).toBe("blocked");
    expect(classifyPageUrl("https://qianchuan.jinritemai.com/board-next/login").status).not.toBe("allowed");
    expect(classifyPageUrl("https://qianchuan.jinritemai.com/board-next/auth").status).not.toBe("allowed");
    expect(classifyPageUrl("https://qianchuan.jinritemai.com/board-next/passport").status).not.toBe("allowed");
    expect(classifyPageUrl("http://qianchuan.jinritemai.com/board-next").status).toBe("blocked");
    expect(classifyPageUrl("https://www.qianchuan.jinritemai.com/board-next").status).toBe("blocked");
  });

  it("不同千川 routeId 必须撤销旧会话授权", () => {
    const agent = classifyPageUrl("https://agent.oceanengine.com/admin/optimizeModule/qianchuan/");
    const board = classifyPageUrl("https://qianchuan.jinritemai.com/board-next");
    expect(agent.status).toBe("allowed");
    expect(board.status).toBe("allowed");
    expect(sameRouteIdentity(agent, board)).toBe(false);
    expect(sameRouteIdentity(board, classifyPageUrl("https://qianchuan.jinritemai.com/board-next/"))).toBe(true);
  });

  it("拒绝非 HTTPS、非白名单和登录页", () => {
    expect(classifyPageUrl("http://compass.jinritemai.com/screen/live/shop").status).toBe("blocked");
    expect(classifyPageUrl("https://compass.jinritemai.com/screen/live/overview").status).toBe("blocked");
    expect(classifyPageUrl("https://agent.oceanengine.com/login").status).toBe("blocked");
    expect(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop/login").status).toBe("login");
  });

  it("音频探针只允许 Compass route", () => {
    expect(audioCaptureAllowedRoute("compass-live-shop")).toBe(true);
    expect(audioCaptureAllowedRoute("qianchuan-agent")).toBe(false);
    expect(audioCaptureAllowedRoute("qianchuan-board")).toBe(false);
  });

  it("WebSocket 脱敏拒绝 URL userinfo，不让凭据进入来源摘要", () => {
    expect(sanitizeCompassWebSocketUrl("wss://user:password@compass.jinritemai.com/socket")).toBeNull();
    expect(sanitizeCompassWebSocketUrl("wss://compass.jinritemai.com/socket?token=redacted#fragment")).toEqual({ origin: "wss://compass.jinritemai.com", pathname: "/socket" });
  });
});
