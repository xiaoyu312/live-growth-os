import { describe, expect, it } from "vitest";
import { audioStartErrorMessage } from "../../src/audio-error";
import { audioConsumeFailureCode, AUDIO_CONSUME_TIMEOUT_MS, AUDIO_WS_AUTHORIZE_TIMEOUT_MS, createAudioConsumeFailure } from "../../src/audio-consume";
import { LIVE_START_DEADLINE_MS, POPUP_LIVE_START_TIMEOUT_MS } from "../../src/live-start";

describe("真实直播音频失败文案", () => {
  it("把捕获失败和转写通道失败说成人话，不再一律写成授权失败", () => {
    expect(audioStartErrorMessage("tab_capture_failed")).toContain("屏幕录制");
    expect(audioStartErrorMessage("get_user_media_failed")).toContain("分享音频");
    expect(audioStartErrorMessage("no_audio_track")).toContain("解除静音");
    expect(audioStartErrorMessage("asr_ws_failed")).toContain("转写通道");
    expect(audioStartErrorMessage("audio_consume_failed")).toContain("连接真实直播");
    expect(audioStartErrorMessage("audio_consume_failed")).not.toContain("音频授权失败，未生成或上传音频");
  });

  it("弹窗默认只露出真实连接，探针放进调试", async () => {
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(new URL("../../popup.html", import.meta.url), "utf8");
    expect(html).toContain("不要点下方调试里的网络探针");
    expect(html).toContain("id=\"hint\"");
    expect(html).toContain("<details>");
    expect(html).toContain("连接真实直播（罗盘）");
    expect(html.indexOf("连接真实直播（罗盘）")).toBeLessThan(html.indexOf("开始音频探针"));
  });

  it("本机转写握手超时映射为 asr_ws_failed，给运营可执行提示", () => {
    expect(audioConsumeFailureCode(new Error("audio_ws_timeout"))).toBe("asr_ws_failed");
    expect(audioConsumeFailureCode(new Error("audio_ws_failed"))).toBe("asr_ws_failed");
    expect(audioConsumeFailureCode(createAudioConsumeFailure("no_audio_track"))).toBe("no_audio_track");
  });

  it("弹窗等待长于整次连接，整次连接长于音频消费，音频消费长于转写授权", () => {
    expect(AUDIO_WS_AUTHORIZE_TIMEOUT_MS).toBeGreaterThan(4_000);
    expect(AUDIO_CONSUME_TIMEOUT_MS).toBeGreaterThan(AUDIO_WS_AUTHORIZE_TIMEOUT_MS);
    expect(LIVE_START_DEADLINE_MS).toBeGreaterThan(AUDIO_CONSUME_TIMEOUT_MS);
    expect(POPUP_LIVE_START_TIMEOUT_MS).toBeGreaterThan(LIVE_START_DEADLINE_MS);
  });
});
