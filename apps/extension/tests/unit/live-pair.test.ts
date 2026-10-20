import { describe, expect, it } from "vitest";
import {
  LIVE_PAIR_STORAGE_KEY,
  clearPersistedLivePair,
  existingLivePairToReuse,
  interpretLiveReattachStatus,
  liveStartAudioRetryWarning,
  loadPersistedLivePair,
  parseLivePairRecord,
  persistLivePair,
  publicResumableLive,
  resolveLiveSession,
  shouldClearLivePairAfterStop,
  shouldPersistLivePairOnInvalidate,
  shouldStopRemoteLiveOnInvalidate,
  type LivePairStorage
} from "../../src/live-pair";

const pair = { sessionId: "s1", pairToken: "token-1", dashboardPath: "/live/s1", compassTabId: 11 };
const otherPair = { sessionId: "s2", pairToken: "token-2", dashboardPath: "/live/s2", compassTabId: 22 };

function memoryStorage(initial?: Map<string, unknown>): LivePairStorage & { store: Map<string, unknown> } {
  const store = initial ?? new Map<string, unknown>();
  return {
    store,
    get: async (key: string) => ({ [key]: store.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value);
    },
    remove: async (key: string) => { store.delete(key); }
  };
}

describe("登录挂起与配对恢复", () => {
  it("page_login 不停服务端、不清配对，其它撤销仍停场", () => {
    expect(shouldStopRemoteLiveOnInvalidate("page_login")).toBe(false);
    expect(shouldPersistLivePairOnInvalidate("page_login")).toBe(true);
    expect(shouldStopRemoteLiveOnInvalidate("page_left_allowlist")).toBe(true);
    expect(shouldStopRemoteLiveOnInvalidate("document_navigation_blocked")).toBe(true);
    expect(shouldStopRemoteLiveOnInvalidate("page_switched")).toBe(true);
  });

  it("显式停止成功才清配对", () => {
    expect(shouldClearLivePairAfterStop(true)).toBe(true);
    expect(shouldClearLivePairAfterStop(false)).toBe(false);
  });

  it("已有内存或持久化配对时先 reattach，不新建", async () => {
    const calls: string[] = [];
    const resolved = await resolveLiveSession({
      tabId: 22,
      memory: null,
      persisted: pair,
      reattach: async (existing) => {
        calls.push(`reattach:${existing.sessionId}`);
        return { ok: true, sessionId: existing.sessionId, dashboardPath: existing.dashboardPath };
      },
      create: async () => {
        calls.push("create");
        return { sessionId: "new", pairToken: "new-token", dashboardPath: "/live/new" };
      }
    });
    expect(resolved.reused).toBe(true);
    expect(resolved.pair).toEqual({ ...pair, compassTabId: 22 });
    expect(calls).toEqual(["reattach:s1"]);
  });

  it("内存配对优先于持久化配对", () => {
    expect(existingLivePairToReuse({ memory: pair, persisted: { ...pair, sessionId: "other" } })).toEqual(pair);
    expect(existingLivePairToReuse({ memory: null, persisted: pair })).toEqual(pair);
    expect(existingLivePairToReuse({ memory: null, persisted: null })).toBeNull();
  });

  it("挂回令牌失效后才新建一场", async () => {
    const resolved = await resolveLiveSession({
      tabId: 11,
      memory: pair,
      persisted: pair,
      reattach: async () => ({ ok: false, unusable: true }),
      create: async () => ({ sessionId: "new", pairToken: "new-token", dashboardPath: "/live/new" })
    });
    expect(resolved).toEqual({
      reused: false,
      pair: { sessionId: "new", pairToken: "new-token", dashboardPath: "/live/new", compassTabId: 11 }
    });
  });

  it("挂回网络失败不新建场", async () => {
    await expect(resolveLiveSession({
      tabId: 11,
      memory: pair,
      persisted: null,
      reattach: async () => ({ ok: false, unusable: false }),
      create: async () => ({ sessionId: "new", pairToken: "new-token", dashboardPath: "/live/new" })
    })).rejects.toThrow("真实直播挂回失败");
  });

  it("对外只暴露场次路径，不含令牌", () => {
    expect(publicResumableLive(pair)).toEqual({ sessionId: "s1", dashboardPath: "/live/s1" });
    expect(publicResumableLive(pair)).not.toHaveProperty("pairToken");
    expect(parseLivePairRecord({ sessionId: "s", dashboardPath: "/live/s", compassTabId: 1 })).toBeNull();
    expect(interpretLiveReattachStatus(200)).toBe("ok");
    expect(interpretLiveReattachStatus(401)).toBe("unusable");
    expect(interpretLiveReattachStatus(409)).toBe("unusable");
    expect(interpretLiveReattachStatus(503)).toBe("retryable");
  });

  it("单区存储仍可读写配对", async () => {
    const storage = memoryStorage();
    await persistLivePair(storage, pair);
    expect(storage.store.get(LIVE_PAIR_STORAGE_KEY)).toEqual(pair);
    await expect(loadPersistedLivePair(storage)).resolves.toEqual(pair);
    await clearPersistedLivePair(storage);
    await expect(loadPersistedLivePair(storage)).resolves.toBeNull();
  });

  it("Chrome 重启后 session 清空，仍从 local 恢复配对", async () => {
    const local = memoryStorage();
    const session = memoryStorage();
    await persistLivePair({ local, session }, pair);
    expect(local.store.get(LIVE_PAIR_STORAGE_KEY)).toEqual(pair);
    expect(session.store.get(LIVE_PAIR_STORAGE_KEY)).toEqual(pair);
    session.store.clear();
    await expect(loadPersistedLivePair({ local, session })).resolves.toEqual(pair);
  });

  it("权威以 local 为准，session 只作热缓存", async () => {
    const local = memoryStorage();
    const session = memoryStorage();
    await persistLivePair({ local, session }, pair);
    session.store.set(LIVE_PAIR_STORAGE_KEY, otherPair);
    await expect(loadPersistedLivePair({ local, session })).resolves.toEqual(pair);
  });

  it("仅有 session 热缓存时仍可读，并回写 local", async () => {
    const local = memoryStorage();
    const session = memoryStorage();
    await persistLivePair(session, pair);
    await expect(loadPersistedLivePair({ local, session })).resolves.toEqual(pair);
    expect(local.store.get(LIVE_PAIR_STORAGE_KEY)).toEqual(pair);
  });

  it("清除配对时同时清 local 与 session", async () => {
    const local = memoryStorage();
    const session = memoryStorage();
    await persistLivePair({ local, session }, pair);
    await clearPersistedLivePair({ local, session });
    await expect(loadPersistedLivePair({ local, session })).resolves.toBeNull();
    expect(local.store.has(LIVE_PAIR_STORAGE_KEY)).toBe(false);
    expect(session.store.has(LIVE_PAIR_STORAGE_KEY)).toBe(false);
  });

  it("音频失败提示区分恢复与新建", () => {
    expect(liveStartAudioRetryWarning(true)).toBe("场次已恢复，音频需再点一次采集");
    expect(liveStartAudioRetryWarning(false)).toBe("场次已连接，音频需再点一次采集");
  });
});
