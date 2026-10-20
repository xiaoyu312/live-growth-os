import { describe, expect, it } from "vitest";
import { isLoopbackHost, lanColleagueWatchUrl, resolveLiveBackend } from "../app/live/backend-url";

describe("副驾后端地址", () => {
  it("本机打开仍走 127.0.0.1，同事用局域网 IP 打开则连同一台电脑的 4100", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(resolveLiveBackend({ protocol: "http:", hostname: "127.0.0.1" })).toEqual({
      api: "http://127.0.0.1:4100",
      ws: "ws://127.0.0.1:4100"
    });
    expect(resolveLiveBackend({ protocol: "http:", hostname: "198.51.100.42" })).toEqual({
      api: "http://198.51.100.42:4100",
      ws: "ws://198.51.100.42:4100"
    });
  });

  it("同事观看链接固定 /live/current，不绑当场 sessionId", () => {
    expect(lanColleagueWatchUrl("http://198.51.100.42:3000")).toBe("http://198.51.100.42:3000/live/current");
    expect(lanColleagueWatchUrl("http://198.51.100.42:3000/")).toBe("http://198.51.100.42:3000/live/current");
  });
});
