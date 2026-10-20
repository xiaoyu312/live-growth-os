import { describe, expect, it } from "vitest";
import { fireAndForgetAudioStatus } from "../../src/audio-report";

describe("音频状态上报不会阻塞音频握手", () => {
  it("发送端不等待后台处理完成即可返回", async () => {
    let resolveResponse!: () => void;
    let sent = false;
    const pending = new Promise<void>((resolve) => { resolveResponse = resolve; });
    fireAndForgetAudioStatus((message) => {
      sent = message !== undefined;
      return pending;
    }, { type: "audio:status" });
    await Promise.resolve();
    expect(sent).toBe(true);
    resolveResponse();
  });
});
