import { describe, expect, it } from "vitest";
import { compassAudioOwnedByTab, SerializedRuntimeQueue, SharedLiveConnectionStore, TabRuntimeRegistry } from "../../src/tab-runtime";

describe("per-tab runtime registry", () => {
  it("creates distinct state objects for two tabs", () => {
    const registry = new TabRuntimeRegistry((tabId) => ({ tabId, events: [] as string[] }));
    expect(registry.get(11).state).not.toBe(registry.get(22).state);
    expect(registry.tabIds()).toEqual([11, 22]);
  });

  it("updates one tab without overwriting the other", () => {
    const registry = new TabRuntimeRegistry((tabId) => ({ tabId, events: [] as string[] }));
    registry.get(11).state.events.push("compass");
    registry.get(22).state.events.push("qianchuan");
    expect(registry.get(11).state.events).toEqual(["compass"]);
    expect(registry.get(22).state.events).toEqual(["qianchuan"]);
  });

  it("stops one tab while retaining the other", () => {
    const registry = new TabRuntimeRegistry((tabId) => ({ tabId }));
    registry.get(11);
    registry.get(22);
    registry.remove(11);
    expect(registry.has(11)).toBe(false);
    expect(registry.peek(22)?.state).toEqual({ tabId: 22 });
  });

  it("shares one Compass connection with Qianchuan readers", () => {
    const store = new SharedLiveConnectionStore();
    const connection = { sessionId: "s", pairToken: "p", dashboardPath: "/live/s", compassTabId: 11 };
    expect(store.setFromCompass(11, connection)).toBe(true);
    expect(store.get()).toEqual(connection);
  });

  it("rejects Qianchuan overwrite and non-Compass clear", () => {
    const store = new SharedLiveConnectionStore();
    const connection = { sessionId: "s", pairToken: "p", dashboardPath: "/live/s", compassTabId: 11 };
    store.setFromCompass(11, connection);
    expect(store.setFromCompass(22, { ...connection, sessionId: "qianchuan" })).toBe(false);
    expect(store.get()).toEqual(connection);
    expect(store.clearFromCompass(22)).toBe(false);
    expect(store.get()).toEqual(connection);
    expect(store.clearFromCompass(11)).toBe(true);
    expect(store.get()).toBeNull();
  });

  it("SW 重启可从持久配对恢复，显式停止可无条件清掉", () => {
    const store = new SharedLiveConnectionStore();
    store.restore({ sessionId: "s", pairToken: "p", dashboardPath: "/live/s", compassTabId: 11 });
    expect(store.get()).toEqual({ sessionId: "s", pairToken: "p", dashboardPath: "/live/s", compassTabId: 11 });
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("serializes cross-tab async work so selected context cannot interleave", async () => {
    const queue = new SerializedRuntimeQueue();
    const order: string[] = [];
    const first = queue.enqueue(async () => {
      order.push("compass:start");
      await Promise.resolve();
      order.push("compass:end");
      return 11;
    });
    const second = queue.enqueue(async () => {
      order.push("qianchuan:start");
      return 22;
    });
    await expect(Promise.all([first, second])).resolves.toEqual([11, 22]);
    expect(order).toEqual(["compass:start", "compass:end", "qianchuan:start"]);
  });

  it("only lets the Compass owner control audio", () => {
    expect(compassAudioOwnedByTab("qianchuan-board", 22)).toBe(false);
    expect(compassAudioOwnedByTab("compass-live-shop", 11)).toBe(true);
    expect(compassAudioOwnedByTab("compass-live-shop", 11, 11)).toBe(true);
    expect(compassAudioOwnedByTab("compass-live-shop", 22, 11)).toBe(false);
  });

  it("returns a queued start timeout at receipt deadline and does not start stale work", async () => {
    const queue = new SerializedRuntimeQueue();
    const calls: string[] = [];
    const blocker = queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const result = await queue.enqueueWithDeadline(
      async () => { calls.push("late-start"); return "started"; },
      Date.now() + 10,
      () => "timeout"
    );
    expect(result).toBe("timeout");
    await blocker;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual([]);
  });
});
