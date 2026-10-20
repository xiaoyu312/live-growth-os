import { describe, expect, it } from "vitest";
import { audioConsumeFailureCode, createAudioConsumeFailure, initialNetworkEvent, requestAudioConsume } from "../../src/audio-consume";
import { applyAudioStatusMessage } from "../../src/audio-message";
import { classifyPageUrl } from "../../src/allowlist";
import { createProbeSession, MemoryProbeStorage, ProbeSessionStore } from "../../src/storage";

describe("Phase 2A offscreen audio consume contract", () => {
  it("track_started 后必须记录初始 online/offline，且不覆盖音轨生命周期", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const identity = { routeId: initialSession.routeId, sessionId: initialSession.sessionId };
    await applyAudioStatusMessage(store, { event: "track_started", trackCount: 1, observedAt: "2026-08-06T00:00:01.000Z" }, "fallback", identity);
    await applyAudioStatusMessage(store, { event: initialNetworkEvent(true), observedAt: "2026-08-06T00:00:01.100Z" }, "fallback", identity);
    let session = await store.load();
    expect(session?.audio.captureLifecycle).toBe("active");
    expect(session?.audio.networkStatus).toBe("online");

    await applyAudioStatusMessage(store, { event: initialNetworkEvent(false), observedAt: "2026-08-06T00:00:01.200Z" }, "fallback", identity);
    session = await store.load();
    expect(session?.audio.captureLifecycle).toBe("active");
    expect(session?.audio.networkStatus).toBe("offline");
  });

  it("offscreen failure response stays failed and service state never becomes authorized", async () => {
    let sent: unknown;
    const identity = { routeId: "compass-live-shop" as const, sessionId: "00000000-0000-4000-8000-000000000007" };
    const failure = await requestAudioConsume((message, callback) => {
      sent = message;
      callback({ ok: false, errorCode: "no_audio_track" });
    }, () => undefined, "stream-1", 7, identity);
    expect(sent).toEqual({ type: "audio:consume", streamId: "stream-1", tabId: 7, routeId: identity.routeId, sessionId: identity.sessionId });
    expect(failure).toEqual({ ok: false, errorCode: "no_audio_track" });
    if (failure.ok) throw new Error("synthetic consume response unexpectedly succeeded");

    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const seedSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(seedSession);
    await applyAudioStatusMessage(store, { event: "error", errorCode: failure.errorCode, observedAt: "2026-08-06T00:00:01.000Z" }, "fallback", { routeId: seedSession.routeId, sessionId: seedSession.sessionId });
    const session = await store.load();
    expect(session?.audio.captureLifecycle).toBe("offline");
    expect(session?.audio.needsUserRestart).toBe(true);
    expect(session?.audio.reason).not.toBe("tab_audio_authorized");
  });

  it("only successful offscreen response can continue to authorization", async () => {
    const success = await requestAudioConsume((_message, callback) => callback({ ok: true }), () => undefined, "stream-2", 8, { routeId: "compass-live-shop", sessionId: "00000000-0000-4000-8000-000000000008" });
    expect(success).toEqual({ ok: true });
    expect(audioConsumeFailureCode(createAudioConsumeFailure("no_audio_track"))).toBe("no_audio_track");
    expect(audioConsumeFailureCode(new Error("audio_ws_timeout"))).toBe("asr_ws_failed");
    expect(audioConsumeFailureCode({})).toBe("audio_consume_failed");
  });

  it("chrome.runtime.lastError maps to a fixed failure code", async () => {
    const result = await requestAudioConsume((_message, callback) => callback(undefined), () => ({ message: "message port closed" }), "stream-3", 9, { routeId: "compass-live-shop", sessionId: "00000000-0000-4000-8000-000000000009" });
    expect(result).toEqual({ ok: false, errorCode: "offscreen_unavailable" });
  });

  it("offscreen 无响应时在有限时间内返回可重试错误", async () => {
    const result = await requestAudioConsume(() => undefined, () => undefined, "stream-timeout", 10, { routeId: "compass-live-shop", sessionId: "00000000-0000-4000-8000-000000000010" }, undefined, 10);
    expect(result).toEqual({ ok: false, errorCode: "offscreen_unavailable" });
  });

  it("迟到 audio status 不能写入同路由的新 session", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const first = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(first);
    const next = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:01.000Z");
    await store.save(next);
    const lateResult = await applyAudioStatusMessage(store, { event: "track_started", trackCount: 1, observedAt: "2026-08-06T00:00:02.000Z" }, "fallback", { routeId: first.routeId, sessionId: first.sessionId });
    expect(lateResult.ok).toBe(false);
    expect((await store.load())?.sessionId).toBe(next.sessionId);
    expect((await store.load())?.audio.captureLifecycle).toBe("idle");
  });
});
