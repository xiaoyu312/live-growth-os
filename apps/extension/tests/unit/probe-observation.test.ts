import { describe, expect, it } from "vitest";
import { inspectJsonResponseBody, observeDebuggerEvent, createDebuggerObservationContext, MAX_RESPONSE_BODY_BYTES, setMainFrameTree } from "../../src/probe-observation";
import { classifyPageUrl } from "../../src/allowlist";
import { createProbeSession, exportProbeSession, MemoryProbeStorage, ProbeSessionStore } from "../../src/storage";

function identityOf(session: ReturnType<typeof createProbeSession>) {
  return { routeId: session.routeId, sessionId: session.sessionId };
}

describe("Phase 2A CDP 结构监听", () => {
  it("HTTP、WS、iframe/Worker 生命周期只落结构摘要", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const identity = identityOf(initialSession);
    const context = createDebuggerObservationContext(7, initialSession.routeId, initialSession.sessionId);
    await observeDebuggerEvent(store, "Network.requestWillBeSent", { request: { url: "https://compass.jinritemai.com/screen/live/shop/data?secret=1", method: "GET" }, type: "XHR" }, "2026-08-06T00:00:01.000Z", context, 7, identity);
    await observeDebuggerEvent(store, "Network.webSocketCreated", { requestId: "ws-1", url: "wss://compass.jinritemai.com/screen/live/shop/ws?token=x" }, "2026-08-06T00:00:02.000Z", context, 7, identity);
    await observeDebuggerEvent(store, "Network.webSocketFrameReceived", { requestId: "ws-1", response: { payloadData: "raw secret payload" } }, "2026-08-06T00:00:03.000Z", context, 7, identity);
    setMainFrameTree(context, { frame: { id: "main-frame", url: "https://compass.jinritemai.com/screen/live/shop" } });
    await observeDebuggerEvent(store, "Page.frameAttached", { frameId: "frame-1", parentFrameId: "main-frame" }, "2026-08-06T00:00:04.000Z", context, 7, identity);
    await observeDebuggerEvent(store, "Page.frameNavigated", { frame: { id: "frame-1", parentId: "main-frame", url: "https://compass.jinritemai.com/screen/live/shop/frame" } }, "2026-08-06T00:00:04.100Z", context, 7, identity);
    await observeDebuggerEvent(store, "Page.frameDetached", { frameId: "frame-1" }, "2026-08-06T00:00:05.000Z", context, 7, identity);
    const session = await store.load();
    expect(session?.network).toHaveLength(3);
    expect(session?.targets).toHaveLength(2);
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("secret=1");
    expect(serialized).not.toContain("raw secret payload");
    expect(serialized).toContain("/screen/live/shop");
  });

  it("网络和 Target 观察不持久化动态 pathname 片段", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const identity = identityOf(initialSession);
    const context = createDebuggerObservationContext(7, initialSession.routeId, initialSession.sessionId);
    setMainFrameTree(context, { frame: { id: "main-frame", url: "https://compass.jinritemai.com/screen/live/shop" } });
    await observeDebuggerEvent(store, "Network.requestWillBeSent", { request: { url: "https://api.example.test/live/room/123456/metrics" } }, "2026-08-06T00:00:01.000Z", context, 7, identity);
    await observeDebuggerEvent(store, "Page.frameAttached", { frameId: "frame-1", parentFrameId: "main-frame" }, "2026-08-06T00:00:02.000Z", context, 7, identity);
    await observeDebuggerEvent(store, "Page.frameNavigated", { frame: { id: "frame-1", parentId: "main-frame", url: "https://api.example.test/assets/9f86d081884c7d659a2feaa0c55ad015.png" } }, "2026-08-06T00:00:02.100Z", context, 7, identity);
    const session = await store.load();
    const serialized = JSON.stringify(session);
    expect(session?.network[0]?.pathname).toBe("/live/room/[dynamic-segment]/metrics");
    expect(session?.targets[0]?.pathname).toBe("/assets/[dynamic-segment]");
    expect(context.frameUrls.get("frame-1")).toBe("https://api.example.test/assets/[dynamic-segment]");
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("9f86d081884c7d659a2feaa0c55ad015");
    expect(serialized).toContain("[dynamic-segment]");
  });

  it("纯字母 opaque 与长稳定 endpoint 在 context、storage、export 全链路固定占位", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const identity = identityOf(initialSession);
    const context = createDebuggerObservationContext(7, initialSession.routeId, initialSession.sessionId);
    setMainFrameTree(context, { frame: { id: "main-frame", url: "https://compass.jinritemai.com/screen/live/shop" } });
    const opaqueUrl = "https://api.example.test/api/AbCdEfGhIjKlMnOpQrStUvWx";
    await observeDebuggerEvent(store, "Network.requestWillBeSent", { requestId: "opaque-request", request: { url: opaqueUrl } }, "2026-08-06T00:00:01.000Z", context, 7, identity);
    await observeDebuggerEvent(store, "Network.requestWillBeSent", { request: { url: "https://api.example.test/api/getLiveRoomMetricsV2" } }, "2026-08-06T00:00:01.100Z", context, 7, identity);
    await observeDebuggerEvent(store, "Network.requestWillBeSent", { request: { url: "https://api.example.test/api/liveRoomPerformanceMetricsV2" } }, "2026-08-06T00:00:01.200Z", context, 7, identity);
    await observeDebuggerEvent(store, "Page.frameAttached", { frameId: "frame-1", parentFrameId: "main-frame" }, "2026-08-06T00:00:02.000Z", context, 7, identity);
    await observeDebuggerEvent(store, "Page.frameNavigated", { frame: { id: "frame-1", parentId: "main-frame", url: opaqueUrl } }, "2026-08-06T00:00:02.100Z", context, 7, identity);
    const session = await store.load();
    const serialized = JSON.stringify(session);
    const exported = JSON.stringify(exportProbeSession(session!, "2026-08-06T00:00:03.000Z"));
    expect(context.frameUrls.get("frame-1")).toBe("https://api.example.test/api/[dynamic-segment]");
    expect(context.httpRequests.get("opaque-request")?.url).toBe("https://api.example.test/api/[dynamic-segment]");
    expect(session?.network.map((item) => item.pathname)).toContain("/api/[dynamic-segment]");
    expect(session?.network.filter((item) => item.pathname === "/api/[dynamic-segment]")).toHaveLength(3);
    expect(session?.targets.map((item) => item.pathname)).toContain("/api/[dynamic-segment]");
    expect(serialized).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
    expect(exported).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
    expect(exported).toContain("[dynamic-segment]");
    expect(exported).not.toContain("getLiveRoomMetricsV2");
    expect(exported).not.toContain("liveRoomPerformanceMetricsV2");
  });

  it("loadingFinished 后仅短暂解析 JSON XHR/fetch，落字段 shape 与受控 metric 序列", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const identity = identityOf(initialSession);
    const context = createDebuggerObservationContext(undefined, initialSession.routeId, initialSession.sessionId);
    await observeDebuggerEvent(store, "Network.requestWillBeSent", {
      requestId: "req-1",
      request: { url: "https://api.example.test/live/data?token=never-store", method: "GET" }
    }, "2026-08-06T00:00:01.000Z", context, undefined, identity);
    await observeDebuggerEvent(store, "Network.responseReceived", {
      requestId: "req-1",
      type: "XHR",
      response: { url: "https://api.example.test/live/data?token=never-store", status: 200, mimeType: "application/json" }
    }, "2026-08-06T00:00:01.100Z", context, undefined, identity);
    await observeDebuggerEvent(store, "Network.loadingFinished", { requestId: "req-1", encodedDataLength: 120 }, "2026-08-06T00:00:01.200Z", context, undefined, identity);
    let readCount = 0;
    await inspectJsonResponseBody(store, "req-1", "2026-08-06T00:00:01.300Z", context, async () => {
      readCount += 1;
      return { body: JSON.stringify({ metrics: { onlineCount: 18, roi: 1.2 }, orderId: 20260806123456, label: "raw-business-value" }) };
    }, identity);
    const loaded = await store.load();
    expect(readCount).toBe(1);
    expect(context.httpRequests.has("req-1")).toBe(false);
    expect(loaded?.metricObservations).toEqual([
      { path: "root.metrics.onlineCount", observedAt: "2026-08-06T00:00:01.300Z", value: 18 },
      { path: "root.metrics.roi", observedAt: "2026-08-06T00:00:01.300Z", value: 1.2 }
    ]);
    expect(JSON.stringify(loaded?.network)).not.toContain("raw-business-value");
    expect(JSON.stringify(loaded?.network)).not.toContain("20260806123456");
    expect(JSON.stringify(loaded?.network)).not.toContain("token=never-store");
    const exported = JSON.stringify((await import("../../src/storage")).exportProbeSession(loaded!, "2026-08-06T00:00:02.000Z"));
    expect(exported).toContain("onlineCount");
    expect(exported).not.toContain('"value":18');
    expect(loaded?.network.map((item) => item.phase)).toEqual(["request_start", "response_metadata", "body_shape"]);
  });

  it("响应体和 WS frame 都受 1 MiB／非 JSON 边界约束", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const identity = identityOf(initialSession);
    const context = createDebuggerObservationContext(undefined, initialSession.routeId, initialSession.sessionId);
    await observeDebuggerEvent(store, "Network.requestWillBeSent", { requestId: "large", request: { url: "https://api.example.test/data", method: "GET" } }, "2026-08-06T00:00:01.000Z", context, undefined, identity);
    await observeDebuggerEvent(store, "Network.responseReceived", { requestId: "large", type: "Fetch", response: { url: "https://api.example.test/data", status: 200, mimeType: "application/json" } }, "2026-08-06T00:00:01.100Z", context, undefined, identity);
    await observeDebuggerEvent(store, "Network.loadingFinished", { requestId: "large", encodedDataLength: MAX_RESPONSE_BODY_BYTES + 1 }, "2026-08-06T00:00:01.200Z", context, undefined, identity);
    let readCount = 0;
    await inspectJsonResponseBody(store, "large", "2026-08-06T00:00:01.300Z", context, async () => { readCount += 1; return { body: "{}" }; }, identity);
    expect(readCount).toBe(0);

    await observeDebuggerEvent(store, "Network.webSocketCreated", { requestId: "ws-2", url: "wss://compass.jinritemai.com/socket?secret=x#fragment" }, "2026-08-06T00:00:02.000Z", context, undefined, identity);
    const receivedJson: unknown[] = [];
    const wsObserver = async (input: { origin: string; endpoint: string; body: unknown; observedAt: string; direction: "received" }) => { receivedJson.push(input); };
    await observeDebuggerEvent(store, "Network.webSocketFrameReceived", { requestId: "ws-2", response: { opcode: 1, payloadData: JSON.stringify({ metrics: { clickCount: 3 }, note: "ws-raw-value" }) } }, "2026-08-06T00:00:02.100Z", context, undefined, identity, wsObserver);
    await observeDebuggerEvent(store, "Network.webSocketFrameSent", { requestId: "ws-2", response: { opcode: 1, payloadData: JSON.stringify({ metrics: { clickCount: 4 } }) } }, "2026-08-06T00:00:02.150Z", context, undefined, identity, wsObserver);
    await observeDebuggerEvent(store, "Network.webSocketFrameReceived", { requestId: "ws-2", response: { opcode: 2, payloadLength: 9, payloadData: "binary-not-persisted" } }, "2026-08-06T00:00:02.200Z", context, undefined, identity, wsObserver);
    expect(receivedJson).toHaveLength(1);
    expect(receivedJson[0]).toMatchObject({ origin: "wss://compass.jinritemai.com", endpoint: "/socket", direction: "received" });
    const session = await store.load();
    const frames = session?.network.filter((item) => item.kind === "ws") ?? [];
    expect(frames.some((item) => item.frameType === "json" && item.fields.some((field) => field.path === "root.metrics.clickCount"))).toBe(true);
    expect(frames.some((item) => item.frameType === "binary" && item.messageBytes === 9 && item.fields.length === 0)).toBe(true);
    expect(JSON.stringify(session)).not.toContain("ws-raw-value");
    expect(JSON.stringify(session)).not.toContain("binary-not-persisted");
  });

  it("WS 只接受 Compass 的 wss origin，拒绝 https、其他主机和非默认端口", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const session = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(session);
    const identity = identityOf(session);
    const context = createDebuggerObservationContext(undefined, session.routeId, session.sessionId);
    for (const [requestId, url] of [["https", "https://compass.jinritemai.com/socket"], ["other", "wss://agent.oceanengine.com/socket"], ["port", "wss://compass.jinritemai.com:8443/socket"]]) {
      await observeDebuggerEvent(store, "Network.webSocketCreated", { requestId, url }, "2026-08-06T00:00:01.000Z", context, undefined, identity);
    }
    await observeDebuggerEvent(store, "Network.webSocketCreated", { requestId: "ok", url: "wss://compass.jinritemai.com/socket?token=redacted#hash" }, "2026-08-06T00:00:01.000Z", context, undefined, identity);
    const received: unknown[] = [];
    await observeDebuggerEvent(store, "Network.webSocketFrameReceived", { requestId: "ok", response: { opcode: 1, payloadData: JSON.stringify({ data: { core_data: [{ index_name: "pay_ucnt", value: { value: 9, unit: "人" } }] } }) } }, "2026-08-06T00:00:02.000Z", context, undefined, identity, (input) => { received.push(input); });
    expect(received).toHaveLength(1);
    expect((await store.load())?.network.filter((item) => item.kind === "ws").every((item) => item.origin === "wss://compass.jinritemai.com")).toBe(true);
  });

  it("WS 超过 1 MiB 时不尝试 JSON.parse，只保留 text 类型和长度", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const identity = identityOf(initialSession);
    const context = createDebuggerObservationContext(undefined, initialSession.routeId, initialSession.sessionId);
    await observeDebuggerEvent(store, "Network.webSocketCreated", { requestId: "ws-large", url: "wss://compass.jinritemai.com/socket" }, "2026-08-06T00:00:01.000Z", context, undefined, identity);
    const payload = JSON.stringify({ metrics: { onlineCount: 3 }, padding: "x".repeat(MAX_RESPONSE_BODY_BYTES) });
    await observeDebuggerEvent(store, "Network.webSocketFrameReceived", { requestId: "ws-large", response: { opcode: 1, payloadData: payload } }, "2026-08-06T00:00:02.000Z", context, undefined, identity);
    const session = await store.load();
    const frame = session?.network.at(-1);
    expect(frame).toMatchObject({ frameType: "text", fields: [] });
    expect(frame?.messageBytes).toBeGreaterThan(MAX_RESPONSE_BODY_BYTES);
    expect(JSON.stringify(session)).not.toContain(payload);
  });

  it("Target child 只接受当前 owner 的 attached target", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const identity = identityOf(initialSession);
    const context = createDebuggerObservationContext(7, initialSession.routeId, initialSession.sessionId);
    setMainFrameTree(context, { frame: { id: "main-frame", url: "https://compass.jinritemai.com/screen/live/shop" } });
    await observeDebuggerEvent(store, "Target.attachedToTarget", { sessionId: "foreign-session", targetInfo: { targetId: "foreign", type: "iframe", url: "https://other.example.test/frame", openerId: "not-owned", attached: true } }, "2026-08-06T00:00:01.000Z", context, 7, identity);
    await observeDebuggerEvent(store, "Target.attachedToTarget", { sessionId: "owned-session", targetInfo: { targetId: "owned", type: "iframe", url: "https://other.example.test/frame", openerId: "main-frame", attached: true } }, "2026-08-06T00:00:02.000Z", context, 7, identity);
    const session = await store.load();
    expect(session?.targets).toHaveLength(1);
    expect(session?.targets[0]?.origin).toBe("https://other.example.test");
  });

  it("main Document 非白名单请求先被丢弃，不进入 storage/export", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const initialSession = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(initialSession);
    const identity = identityOf(initialSession);
    const context = createDebuggerObservationContext(7, initialSession.routeId, initialSession.sessionId);
    setMainFrameTree(context, { frame: { id: "main-frame", url: "https://compass.jinritemai.com/screen/live/shop" } });
    await observeDebuggerEvent(store, "Network.requestWillBeSent", { requestId: "doc-1", frameId: "main-frame", type: "Document", request: { url: "https://compass.jinritemai.com/screen/live/shop/detail" } }, "2026-08-06T00:00:01.000Z", context, 7, identity);
    const session = await store.load();
    expect(session?.network).toHaveLength(0);
    expect(JSON.stringify((await import("../../src/storage")).exportProbeSession(session!, "2026-08-06T00:00:02.000Z"))).not.toContain("/screen/live/shop/detail");
  });

  it("迟到 loadingFinished body 使用旧 session identity 时不写入新会话", async () => {
    const store = new ProbeSessionStore(new MemoryProbeStorage());
    const first = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:00.000Z");
    await store.save(first);
    const oldIdentity = { routeId: first.routeId, sessionId: first.sessionId };
    const context = createDebuggerObservationContext(7, first.routeId, first.sessionId);
    await observeDebuggerEvent(store, "Network.requestWillBeSent", { requestId: "late-body", request: { url: "https://api.example.test/data", method: "GET" }, type: "XHR" }, "2026-08-06T00:00:01.000Z", context, 7, oldIdentity);
    await observeDebuggerEvent(store, "Network.responseReceived", { requestId: "late-body", type: "XHR", response: { url: "https://api.example.test/data", status: 200, mimeType: "application/json" } }, "2026-08-06T00:00:01.100Z", context, 7, oldIdentity);
    await observeDebuggerEvent(store, "Network.loadingFinished", { requestId: "late-body", encodedDataLength: 20 }, "2026-08-06T00:00:01.200Z", context, 7, oldIdentity);
    const next = createProbeSession(classifyPageUrl("https://compass.jinritemai.com/screen/live/shop"), "2026-08-06T00:00:02.000Z");
    await store.save(next);
    context.ownerRouteId = next.routeId;
    context.ownerSessionId = next.sessionId;
    await inspectJsonResponseBody(store, "late-body", "2026-08-06T00:00:02.100Z", context, async () => ({ body: JSON.stringify({ metrics: { onlineCount: 9 } }) }), oldIdentity);
    expect((await store.load())?.sessionId).toBe(next.sessionId);
    expect((await store.load())?.network).toHaveLength(0);
  });
});
