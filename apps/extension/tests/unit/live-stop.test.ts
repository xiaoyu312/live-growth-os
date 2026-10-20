import { describe, expect, it } from "vitest";
import { liveStopSucceeded } from "../../src/live-stop";

describe("真实直播停止响应", () => {
  it("只有 2xx 才允许清理本机配对令牌", () => {
    expect(liveStopSucceeded(200)).toBe(true);
    expect(liveStopSucceeded(204)).toBe(true);
    expect(liveStopSucceeded(401)).toBe(false);
    expect(liveStopSucceeded(500)).toBe(false);
  });
});
