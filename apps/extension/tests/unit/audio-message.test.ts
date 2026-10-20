import { describe, expect, it } from "vitest";
import { applyAudioStatusMessage, recordAudioRefresh } from "../../src/audio-message";
import { classifyPageUrl } from "../../src/allowlist";
import { createProbeSession, MemoryProbeStorage, ProbeSessionStore } from "../../src/storage";

describe("Phase 2A audio:status 消息链", () => {
  it("分离网络状态和音轨生命周期，刷新与 energy 不伪造断流", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const identity = { routeId: initialSession.routeId, sessionId: initialSession.sessionId };

    await applyAudioStatusMessage(store, { event: "track_started", trackCount: 1, observedAt: "2026-08-06T00:00:01.000Z" }, "fallback", identity);
    let session = await store.load();
    expect(session?.audio.captureLifecycle).toBe("active");
    expect(session?.audio.networkStatus).toBe("unknown");

    await applyAudioStatusMessage(store, { event: "offline", observedAt: "2026-08-06T00:00:02.000Z" }, "fallback", identity);
    session = await store.load();
    expect(session?.audio.captureLifecycle).toBe("active");
    expect(session?.audio.networkStatus).toBe("offline");
    expect(session?.audio.lastNetworkChangedAt).toBe("2026-08-06T00:00:02.000Z");
    expect(session?.markers.at(-1)?.code).toBe("network_offline");

    await applyAudioStatusMessage(store, { event: "online", observedAt: "2026-08-06T00:00:03.000Z" }, "fallback", identity);
    await applyAudioStatusMessage(store, { event: "energy", band: "normal", activeSeconds: 2, observedAt: "2026-08-06T00:00:04.000Z" }, "fallback", identity);
    session = await store.load();
    expect(session?.audio.captureLifecycle).toBe("active");
    expect(session?.audio.networkStatus).toBe("online");
    expect(session?.audio.lastNetworkChangedAt).toBe("2026-08-06T00:00:03.000Z");

    await recordAudioRefresh(store, "2026-08-06T00:00:05.000Z", identity);
    session = await store.load();
    expect(session?.audio.captureLifecycle).toBe("active");
    expect(session?.audio.lastRefreshObservedAt).toBe("2026-08-06T00:00:05.000Z");
    expect(session?.audio.networkStatus).toBe("online");

    await applyAudioStatusMessage(store, { event: "track_ended", observedAt: "2026-08-06T00:00:06.000Z" }, "fallback", identity);
    await applyAudioStatusMessage(store, { event: "energy", band: "normal", activeSeconds: 8, observedAt: "2026-08-06T00:00:07.000Z" }, "fallback", identity);
    session = await store.load();
    expect(session?.audio.captureLifecycle).toBe("offline");
    expect(session?.audio.needsUserRestart).toBe(true);
    expect(session?.audio.networkStatus).toBe("online");

    await applyAudioStatusMessage(store, { event: "track_started", trackCount: 1, observedAt: "2026-08-06T00:00:08.000Z" }, "fallback", identity);
    session = await store.load();
    expect(session?.audio.captureLifecycle).toBe("active");
    expect(session?.audio.reason).toBe("track_reconnected");
    expect(session?.audio.needsUserRestart).toBe(false);
    expect(session?.audio.networkStatus).toBe("online");
  });

  it("服务端音频状态再次限制为罗盘 route，拒绝伪造千川 identity", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://qianchuan.jinritemai.com/board-next"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const result = await applyAudioStatusMessage(store, { routeId: "qianchuan-board", sessionId: initialSession.sessionId, event: "track_started", trackCount: 1, observedAt: "2026-08-06T00:00:01.000Z" }, "fallback", { routeId: "qianchuan-board", sessionId: initialSession.sessionId });
    expect(result.ok).toBe(false);
    expect((await store.load())?.audio.captureLifecycle).toBe("idle");
  });
});
