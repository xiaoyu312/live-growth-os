import { describe, expect, it } from "vitest";
import { requestRuntimeMessage } from "../../src/popup-request";

describe("扩展弹窗后台请求", () => {
  it("后台没有接收端时返回可重试的中文错误", async () => {
    await expect(requestRuntimeMessage((message, callback) => { void message; callback(undefined); }, () => ({ message: "Could not establish connection. Receiving end does not exist." }), { type: "probe:start_live" }, 20)).rejects.toThrow("扩展后台未响应，请在扩展管理页重新加载后重试");
  });

  it("后台响应超时返回可重试的中文错误", async () => {
    await expect(requestRuntimeMessage(() => undefined, () => undefined, { type: "probe:start_live" }, 20)).rejects.toThrow("扩展后台响应超时，请重新加载扩展后重试");
  });

  it("后台成功响应原样返回", async () => {
    await expect(requestRuntimeMessage((_message, callback) => callback({ ok: true }), () => undefined, { type: "probe:start_live" }, 20)).resolves.toEqual({ ok: true });
  });
});
