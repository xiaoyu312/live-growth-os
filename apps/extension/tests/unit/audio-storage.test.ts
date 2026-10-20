import { describe, expect, it } from "vitest";
import { initialAudioStatus, transitionAudio } from "../../src/audio";
import { classifyPageUrl } from "../../src/allowlist";
import { createProbeSession, exportProbeSession, LEGACY_PROBE_STORAGE_KEY, MAX_ENDPOINT_CATALOG, MAX_ENDPOINT_FIELDS, MAX_METRIC_OBSERVATIONS, MAX_NETWORK_OBSERVATIONS, MAX_STORAGE_BYTES, MemoryProbeStorage, PROBE_STORAGE_KEY, ProbeSessionStore } from "../../src/storage";
import { sanitizeNetworkObservation } from "../../src/sanitize";

describe("Phase 2A 音频状态与滚动存储", () => {
  it("覆盖授权、连续、静音、刷新、离线和停止，不生成录音状态", () => {
    const start = initialAudioStatus("2026-08-06T00:00:00.000Z");
    const authorized = transitionAudio(start, { type: "authorized", observedAt: "2026-08-06T00:00:01.000Z", trackCount: 1 });
    const active = transitionAudio(authorized, { type: "track_started", observedAt: "2026-08-06T00:00:02.000Z", trackCount: 1 });
    expect(active.captureLifecycle).toBe("active");
    expect(transitionAudio(active, { type: "mute", observedAt: "2026-08-06T00:00:03.000Z" }).captureLifecycle).toBe("muted");
    const refreshed = transitionAudio(active, { type: "refreshed", observedAt: "2026-08-06T00:00:04.000Z" });
    expect(refreshed.captureLifecycle).toBe("active");
    expect(refreshed.reason).toBe("refresh_observed");
    expect(refreshed.lastRefreshObservedAt).toBe("2026-08-06T00:00:04.000Z");
    const networkLost = transitionAudio(active, { type: "network_lost", observedAt: "2026-08-06T00:00:05.000Z" });
    expect(networkLost.captureLifecycle).toBe("active");
    expect(networkLost.networkStatus).toBe("offline");
    expect(networkLost.lastNetworkChangedAt).toBe("2026-08-06T00:00:05.000Z");
    const ended = transitionAudio(active, { type: "track_ended", observedAt: "2026-08-06T00:00:05.700Z" });
    expect(ended.captureLifecycle).toBe("offline");
    expect(ended.needsUserRestart).toBe(true);
    expect(transitionAudio(ended, { type: "energy", observedAt: "2026-08-06T00:00:05.800Z", band: "normal", activeSeconds: 12 }).captureLifecycle).toBe("offline");
    const reconnected = transitionAudio(ended, { type: "track_started", observedAt: "2026-08-06T00:00:05.900Z", trackCount: 1 });
    expect(reconnected.reason).toBe("track_reconnected");
    expect(reconnected.needsUserRestart).toBe(false);
    expect(transitionAudio(active, { type: "stop", observedAt: "2026-08-06T00:00:06.000Z" }).captureLifecycle).toBe("stopped");
    expect(JSON.stringify(active)).not.toContain("MediaRecorder");
  });

  it("滚动上限生效，导出不含 tabId 且同输入稳定", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    for (let index = 0; index < MAX_NETWORK_OBSERVATIONS + 20; index += 1) {
      await store.appendNetwork({ kind: "http", observedAt: `2026-08-06T00:00:${String(index % 60).padStart(2, "0")}.000Z`, origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop", fields: [] }, identity);
    }
    const loaded = await store.load();
    expect(loaded?.network).toHaveLength(MAX_NETWORK_OBSERVATIONS);
    const first = exportProbeSession(loaded!, "2026-08-06T00:10:00.000Z");
    const second = exportProbeSession(loaded!, "2026-08-06T00:10:00.000Z");
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain("tabId");
  });

  it("network retention 按 endpoint/phase 分组，热点 comment 不得挤掉低频 metric", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    const lowFrequency = { kind: "http" as const, phase: "body_shape" as const, observedAt: "2026-08-06T00:00:00.000Z", origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop/metrics", fields: [] };
    await store.appendNetwork(lowFrequency, identity);
    for (let index = 0; index < MAX_NETWORK_OBSERVATIONS + 80; index += 1) {
      await store.appendNetwork({ kind: "http", phase: "response_metadata", observedAt: `2026-08-06T00:00:${String(index % 60).padStart(2, "0")}.000Z`, origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop/comment", fields: [] }, identity);
    }
    const loaded = await store.load();
    expect(loaded?.network.length).toBeLessThanOrEqual(MAX_NETWORK_OBSERVATIONS);
    expect(loaded?.network.some((item) => item.pathname === "/screen/live/shop/metrics" && item.phase === "body_shape")).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(loaded)).byteLength).toBeLessThanOrEqual(MAX_STORAGE_BYTES);
  });

  it("会话保存来源 route contract identity", () => {
    const session = createProbeSession(classifyPageUrl("https://qianchuan.jinritemai.com/board-next"), "2026-08-06T00:00:00.000Z");
    expect(session.routeId).toBe("qianchuan-board");
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("旧 route contract 的异步观察不得写入新会话", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    await store.save(createProbeSession(classifyPageUrl("https://qianchuan.jinritemai.com/board-next"), "2026-08-06T00:00:00.000Z"));
    await store.appendNetwork({ kind: "http", observedAt: "2026-08-06T00:00:01.000Z", origin: "https://agent.oceanengine.com", pathname: "/admin/optimizeModule/qianchuan/", fields: [] }, { routeId: "qianchuan-agent", sessionId: "00000000-0000-4000-8000-000000000001" });
    expect((await store.load())?.network).toHaveLength(0);
  });

  it("所有异步写入缺少完整 routeId/sessionId 时明确拒绝", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const observation = { kind: "http" as const, observedAt: "2026-08-06T00:00:01.000Z", origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop", fields: [] };
    expect(await store.appendNetwork(observation, undefined as never)).toBeNull();
    expect(await store.appendNetwork(observation, session.routeId as never)).toBeNull();
    expect(await store.setAudio(session.audio, "2026-08-06T00:00:01.000Z", undefined as never)).toBeNull();
    expect(await store.setDom([], "2026-08-06T00:00:01.000Z", session.routeId as never)).toBeNull();
    expect(await store.addMarker("subject_comment", "marker-missing-identity", "2026-08-06T00:00:01.000Z", undefined as never)).toBeNull();
    expect((await store.load())?.network).toHaveLength(0);
    expect((await store.load())?.markers).toHaveLength(0);
  });

  it("旧 session identity 的迟到 network、DOM、audio 和 marker 不得写入新 session", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const first = createProbeSession(classifyPageUrl("https://qianchuan.jinritemai.com/board-next"), "2026-08-06T00:00:00.000Z");
    await store.save(first);
    const identity = { routeId: first.routeId, sessionId: first.sessionId };
    const next = createProbeSession(classifyPageUrl("https://qianchuan.jinritemai.com/board-next"), "2026-08-06T00:00:01.000Z");
    await store.save(next);
    expect(await store.appendNetwork({ kind: "http", observedAt: "2026-08-06T00:00:02.000Z", origin: "https://qianchuan.jinritemai.com", pathname: "/board-next", fields: [] }, identity)).toBeNull();
    expect(await store.setDom([], "2026-08-06T00:00:02.000Z", identity)).toBeNull();
    expect(await store.setAudio(next.audio, "2026-08-06T00:00:02.000Z", identity)).toBeNull();
    expect(await store.addMarker("refresh_observed", "late", "2026-08-06T00:00:02.000Z", identity)).toBeNull();
    expect((await store.load())?.sessionId).toBe(next.sessionId);
    expect((await store.load())?.network).toHaveLength(0);
  });

  it("blocked/stopped session 拒绝迟到 active 写入，但正常 stop 可落库", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    expect(await store.setLifecycle("stopped", "2026-08-06T00:00:01.000Z", "network_stopped", identity)).not.toBeNull();
    expect(await store.appendNetwork({ kind: "http", observedAt: "2026-08-06T00:00:02.000Z", origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop", fields: [] }, identity)).toBeNull();
    expect(await store.setLifecycle("active", "2026-08-06T00:00:03.000Z", "network_started", identity)).toBeNull();
  });

  it("同步 revoke 后所有迟到观察拒绝，仅允许最终 blocked 原因落库", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    store.revokeSession(identity);
    store.revokeSession(identity);
    const observation = { kind: "http" as const, observedAt: "2026-08-06T00:00:01.000Z", origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop", fields: [] };
    const lateWrites = await Promise.all([
      store.appendNetwork(observation, identity),
      store.appendNetwork(observation, identity),
      store.setDom([], "2026-08-06T00:00:01.000Z", identity),
      store.setAudio(session.audio, "2026-08-06T00:00:01.000Z", identity),
      store.addMarker("subject_comment", "late-marker", "2026-08-06T00:00:01.000Z", identity),
      store.setLifecycle("stale", "2026-08-06T00:00:01.000Z", "observation_failed", identity)
    ]);
    expect(lateWrites.every((value) => value === null)).toBe(true);
    let cleanupFinished = false;
    void cleanup.then(() => { cleanupFinished = true; });
    expect(cleanupFinished).toBe(false);
    releaseCleanup();
    await cleanup;
    const blocked = await store.setLifecycle("blocked", "2026-08-06T00:00:02.000Z", "page_switched", identity);
    expect(blocked?.lifecycle).toBe("blocked");
    expect(blocked?.markers.at(-1)?.code).toBe("page_switched");
  });

  it("新版 v2 storage key 忽略 legacy v1，v1 export 明确拒绝", async () => {
    const storage = new MemoryProbeStorage();
    const legacy = { schemaVersion: "phase-2a-probe-v1", session: { page: "compass" } };
    await storage.set({ [LEGACY_PROBE_STORAGE_KEY]: legacy });
    const store = new ProbeSessionStore(storage);
    expect(PROBE_STORAGE_KEY).toBe("phase2a:probe-session:v2");
    expect(await store.load()).toBeNull();
    expect(() => exportProbeSession(legacy as never, "2026-08-06T00:00:00.000Z")).toThrow();
  });

  it("load 只接受 routeId、page、origin、pathname、sessionId 完整一致的 v2 会话", async () => {
    const access = classifyPageUrl("https://compass.jinritemai.com/screen/live/shop");
    const base = createProbeSession(access, "2026-08-06T00:00:00.000Z");
    const candidates = [
      { ...base, routeId: "qianchuan-board" },
      { ...base, page: "qianchuan" },
      { ...base, origin: "https://qianchuan.jinritemai.com" },
      { ...base, pathname: "/screen/live/shop/detail" },
      { ...base, sessionId: "not-a-session-id" },
      { ...base, origin: "https://user:password@compass.jinritemai.com" },
      { ...base, origin: "https://compass.jinritemai.com:443" }
    ];
    for (const candidate of candidates) {
      const storage = new MemoryProbeStorage();
      await storage.set({ [PROBE_STORAGE_KEY]: candidate });
      expect(await new ProbeSessionStore(storage).load()).toBeNull();
    }
    const validStorage = new MemoryProbeStorage();
    await validStorage.set({ [PROBE_STORAGE_KEY]: base });
    const validStore = new ProbeSessionStore(validStorage);
    expect((await validStore.load())?.sessionId).toBe(base.sessionId);
    expect(exportProbeSession((await validStore.load())!, "2026-08-06T00:00:01.000Z").schemaVersion).toBe("phase-2a-probe-v2");

    const agent = createProbeSession(classifyPageUrl("https://agent.oceanengine.com/admin/optimizeModule/qianchuan/"), "2026-08-06T00:00:00.000Z");
    for (const pathname of [
      "/admin/optimizeModule/qianchuan/123456789012",
      "/admin/optimizeModule/qianchuan/550e8400-e29b-41d4-a716-446655440000",
      "/admin/optimizeModule/qianchuan/abcdef0123456789abcdef",
      "/admin/optimizeModule/qianchuan/%31%32%33%34%35%36%37%38%39%30%31%32"
    ]) {
      const storage = new MemoryProbeStorage();
      await storage.set({ [PROBE_STORAGE_KEY]: { ...agent, pathname } });
      expect(await new ProbeSessionStore(storage).load()).toBeNull();
    }
  });

  it("metric 数字只保存真实观测，可用于刷新／单调性判断，缺失不转 0", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    const first = sanitizeNetworkObservation({ kind: "http", url: "https://api.example.test/metrics", observedAt: "2026-08-06T00:00:01.000Z", body: { metrics: { onlineCount: 3 } } });
    const missing = sanitizeNetworkObservation({ kind: "http", url: "https://api.example.test/metrics", observedAt: "2026-08-06T00:00:02.000Z", body: { metrics: {} } });
    const next = sanitizeNetworkObservation({ kind: "http", url: "https://api.example.test/metrics", observedAt: "2026-08-06T00:00:03.000Z", body: { metrics: { onlineCount: 5 } } });
    if (first) await store.appendNetwork(first, identity);
    if (missing) await store.appendNetwork(missing, identity);
    if (next) await store.appendNetwork(next, identity);
    const loaded = await store.load();
    expect(loaded?.metricObservations?.map((item) => item.value)).toEqual([3, 5]);
    expect((loaded?.metricObservations?.[1]?.value ?? 0) >= (loaded?.metricObservations?.[0]?.value ?? 0)).toBe(true);
    expect(loaded?.metricObservations?.some((item) => item.value === 0)).toBe(false);
  });

  it("metricObservations 按 path 有界压缩并在 v2 export 保留", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    for (let index = 0; index < MAX_METRIC_OBSERVATIONS + 80; index += 1) {
      const observedAt = `2026-08-06T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
      await store.appendNetwork({ kind: "http", phase: "body_shape", observedAt, origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop/metrics", fields: [], metricObservations: [
        { path: "root.room_enter_uv", observedAt, value: index },
        { path: "root.product_click_uv", observedAt, value: index % 7 }
      ] }, identity);
    }
    const loaded = await store.load();
    expect(loaded?.metricObservations?.length).toBeLessThanOrEqual(MAX_METRIC_OBSERVATIONS);
    expect(new Set(loaded?.metricObservations?.map((item) => item.path))).toEqual(new Set(["root.room_enter_uv", "root.product_click_uv"]));
    const exported = exportProbeSession(loaded!, "2026-08-06T00:30:00.000Z");
    expect(exported.session.metricCatalog?.length).toBeGreaterThan(0);
    expect(exported.session.metricCatalog?.every((item) => !Object.prototype.hasOwnProperty.call(item, "lastValue"))).toBe(true);
    expect(JSON.stringify(exported.session)).not.toContain('"value":319');
  });

  it("metricObservations 拒绝 identity-like path 和非法时间/数字", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    await store.appendNetwork({ kind: "http", phase: "body_shape", observedAt: "2026-08-06T00:00:01.000Z", origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop/metrics", fields: [], metricObservations: [
      { path: "root.order_id", observedAt: "2026-08-06T00:00:01.000Z", value: 1 },
      { path: "root.room_enter_uv", observedAt: "not-a-time", value: 2 },
      { path: "root.room_enter_uv", observedAt: "2026-08-06T00:00:01.000Z", value: Number.NaN }
    ] }, identity);
    expect((await store.load())?.metricObservations).toEqual([]);
  });

  it("metric catalog 关联 sibling semanticCode 且导出不含 raw value", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    const observation = sanitizeNetworkObservation({ kind: "http", phase: "body_shape", url: "https://compass.jinritemai.com/screen/live/shop/metrics", observedAt: "2026-08-06T00:00:01.000Z", body: { metrics: [{ index_name: "room_enter_uv", value: 12 }, { index_name: "product_click_rate", value: 0.25 }] } });
    if (observation) await store.appendNetwork(observation, identity);
    const loaded = await store.load();
    expect(loaded?.metricCatalog?.map((item) => item.semanticCode)).toEqual(["room_enter_uv", "product_click_rate"]);
    const exported = exportProbeSession(loaded!, "2026-08-06T00:00:02.000Z");
    expect(JSON.stringify(exported)).not.toContain('"value":12');
    expect(exported.session.metricCatalog?.every((item) => !Object.prototype.hasOwnProperty.call(item, "lastValue"))).toBe(true);
  });

  it("audio audit 保留 track／heartbeat 有界摘要", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    const requesting = transitionAudio(session.audio, { type: "request", observedAt: "2026-08-06T00:00:01.000Z" });
    const active = transitionAudio(requesting, { type: "track_started", observedAt: "2026-08-06T00:00:02.000Z", trackCount: 1 });
    const heartbeat = transitionAudio(active, { type: "energy", observedAt: "2026-08-06T00:00:04.000Z", band: "normal", activeSeconds: 2 });
    const stopped = transitionAudio(heartbeat, { type: "stop", observedAt: "2026-08-06T00:00:05.000Z" });
    await store.setAudio(requesting, requesting.observedAt, identity);
    await store.setAudio(active, active.observedAt, identity);
    await store.setAudio(heartbeat, heartbeat.observedAt, identity);
    await store.setAudio(stopped, stopped.observedAt, identity);
    const loaded = await store.load();
    expect(loaded?.audioAudit).toMatchObject({ trackStartedAt: "2026-08-06T00:00:02.000Z", firstHeartbeatAt: "2026-08-06T00:00:04.000Z", heartbeatCount: 1, maxGapMs: 0 });
    expect(loaded?.audioAudit?.transitions.map((item) => `${item.from}->${item.to}`)).toEqual(["idle->requesting", "requesting->active", "active->stopped"]);
  });

  it("endpoint field catalog 超上限时保留 overflow 证据", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    const body: Record<string, number> = {};
    for (let index = 0; index < MAX_ENDPOINT_FIELDS + 10; index += 1) body[`shape_${index}`] = index;
    const observation = sanitizeNetworkObservation({ kind: "http", phase: "body_shape", url: "https://compass.jinritemai.com/screen/live/shop/metrics", observedAt: "2026-08-06T00:00:01.000Z", body });
    if (observation) await store.appendNetwork(observation, identity);
    const catalog = (await store.load())?.endpointCatalog?.[0];
    expect(catalog?.fields?.length).toBeLessThanOrEqual(MAX_ENDPOINT_FIELDS);
    expect(catalog?.fieldOverflow).toBeGreaterThan(0);
    expect(exportProbeSession((await store.load())!, "2026-08-06T00:00:02.000Z").session.endpointCatalog?.[0]?.fieldOverflow).toBeGreaterThan(0);
  });

  it("endpoint catalog 超 64 个 group 时保留全局 missingGroups 证据", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    for (let index = 0; index <= MAX_ENDPOINT_CATALOG; index += 1) {
      await store.appendNetwork({ kind: "http", phase: "response_metadata", observedAt: `2026-08-06T00:01:${String(index).padStart(2, "0")}.000Z`, origin: "https://compass.jinritemai.com", pathname: `/screen/live/shop/endpoint-${index}`, fields: [] }, identity);
    }
    const loaded = await store.load();
    expect(loaded?.endpointCatalog?.length).toBeLessThanOrEqual(MAX_ENDPOINT_CATALOG);
    expect(loaded?.endpointCatalogOverflow?.droppedGroupCount).toBe(1);
    expect(loaded?.endpointCatalogOverflow?.missingGroups.some((group) => group.pathname === `/screen/live/shop/endpoint-${MAX_ENDPOINT_CATALOG}`)).toBe(true);
    const exported = exportProbeSession(loaded!, "2026-08-06T00:02:00.000Z");
    expect(exported.session.endpointCatalogOverflow?.droppedGroupCount).toBe(1);
  });

  it("同一 endpoint/path 的 valueType 漂移保留 observedValueTypes 和 typeDriftCount", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    await store.appendNetwork({ kind: "http", phase: "body_shape", observedAt: "2026-08-06T00:00:01.000Z", origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop/metrics", fields: [{ path: "root.metrics.onlineCount", valueType: "number", sample: "<number>" }] }, identity);
    await store.appendNetwork({ kind: "http", phase: "body_shape", observedAt: "2026-08-06T00:00:02.000Z", origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop/metrics", fields: [{ path: "root.metrics.onlineCount", valueType: "string", sample: "<string>" }] }, identity);
    const field = (await store.load())?.endpointCatalog?.[0]?.fields?.find((item) => item.path === "root.metrics.onlineCount");
    expect(field?.valueType).toBe("number");
    expect(field?.observedValueTypes).toEqual(["number", "string"]);
    expect(field?.typeDriftCount).toBe(1);
  });

  it("metric catalog 超上限时保留 droppedMetricCount 和 missingMetrics", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    for (let index = 0; index <= MAX_METRIC_OBSERVATIONS; index += 1) {
      const observedAt = `2026-08-06T00:01:${String(index % 60).padStart(2, "0")}.${String(Math.floor(index / 60)).padStart(3, "0")}Z`;
      await store.appendNetwork({ kind: "http", phase: "body_shape", observedAt, origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop/metrics", fields: [], metricObservations: [{ path: `root.metric_${index}_count`, observedAt, value: index }] }, identity);
    }
    const loaded = await store.load();
    expect(loaded?.metricCatalog?.length).toBeLessThanOrEqual(MAX_METRIC_OBSERVATIONS);
    expect(loaded?.metricCatalogOverflow?.droppedMetricCount).toBeGreaterThanOrEqual(1);
    expect(loaded?.metricCatalogOverflow?.missingMetrics.some((metric) => metric.path === `root.metric_${MAX_METRIC_OBSERVATIONS}_count`)).toBe(true);
    expect(exportProbeSession(loaded!, "2026-08-06T00:02:00.000Z").session.metricCatalogOverflow?.droppedMetricCount).toBeGreaterThanOrEqual(1);
  });

  it("byte trim 后 endpoint retained/dropped coverage 与 markers 保持一致", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    await store.addMarker("subject_comment", "marker-before-byte-trim", "2026-08-06T00:00:01.000Z", identity);
    const network = Array.from({ length: 180 }, (_, index) => ({ kind: "http" as const, phase: "body_shape" as const, observedAt: `2026-08-06T00:01:${String(index % 60).padStart(2, "0")}.${String(Math.floor(index / 60)).padStart(3, "0")}Z`, origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop/large", fields: [{ path: "root.onlineCount", valueType: "number" as const, sample: "x".repeat(10000) }] }));
    await store.save({ ...session, network, endpointCatalog: [{ kind: "http", phase: "body_shape", origin: "https://compass.jinritemai.com", pathname: "/screen/live/shop/large", firstObservedAt: network[0]!.observedAt, lastObservedAt: network.at(-1)!.observedAt, observationCount: network.length, retainedObservationCount: 0, droppedObservationCount: network.length, fieldOverflow: 0, fields: [{ path: "root.onlineCount", valueType: "number", firstSeenAt: network[0]!.observedAt, lastSeenAt: network.at(-1)!.observedAt, observationCount: network.length }] }], markers: [{ markerId: "marker-before-byte-trim", code: "subject_comment", createdAt: "2026-08-06T00:00:01.000Z" }] });
    const loaded = await store.load();
    const catalog = loaded?.endpointCatalog?.find((item) => item.pathname === "/screen/live/shop/large");
    const retained = loaded?.network.filter((item) => item.pathname === "/screen/live/shop/large").length ?? 0;
    expect(catalog?.retainedObservationCount).toBe(retained);
    expect(catalog?.droppedObservationCount).toBe(catalog!.observationCount - retained);
    expect(loaded?.markers).toEqual([{ markerId: "marker-before-byte-trim", code: "subject_comment", createdAt: "2026-08-06T00:00:01.000Z" }]);
    expect(new TextEncoder().encode(JSON.stringify(loaded)).byteLength).toBeLessThanOrEqual(MAX_STORAGE_BYTES);
  });

  it("业务标记只保存固定枚举 code，不接收自由文本", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = { routeId: session.routeId, sessionId: session.sessionId };
    await store.addMarker("subject_comment", "marker-1", "2026-08-06T00:00:01.000Z", identity);
    const exported = exportProbeSession((await store.load())!, "2026-08-06T00:00:02.000Z");
    expect(exported.session.markers).toEqual([{ markerId: "marker-1", code: "subject_comment", createdAt: "2026-08-06T00:00:01.000Z" }]);
    expect(JSON.stringify(exported)).not.toContain("text");
  });
});
