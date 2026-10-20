import { describe, expect, it } from "vitest";
import { attachDebuggerWithCleanup } from "../../src/debugger-lifecycle";

describe("Phase 2A debugger 初始化清理", () => {
  it("任一 CDP enable 失败都会 detach 已附加 target", async () => {
    const calls: string[] = [];
    await expect(attachDebuggerWithCleanup({
      attach: async () => { calls.push("attach"); },
      sendCommand: async (method) => { calls.push(method); if (method === "Target.setAutoAttach") throw new Error("synthetic failure"); },
      detach: async () => { calls.push("detach"); }
    })).rejects.toThrow("synthetic failure");
    expect(calls).toEqual(["attach", "Network.enable", "Target.setAutoAttach", "detach"]);
  });
});
