import type { SharedLiveConnection } from "./tab-runtime.js";
import type { LifecycleReasonCode } from "./types.js";

export const LIVE_PAIR_STORAGE_KEY = "livePilotPair";

export type LivePairRecord = SharedLiveConnection;

export type LivePairStorage = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

export type DurableLivePairStorage = {
  local: LivePairStorage;
  session?: LivePairStorage;
};

export type LivePairStorageInput = LivePairStorage | DurableLivePairStorage;

function isDurableLivePairStorage(storage: LivePairStorageInput): storage is DurableLivePairStorage {
  return "local" in storage && typeof storage.local === "object" && storage.local !== null && "get" in storage.local;
}

export function parseLivePairRecord(value: unknown): LivePairRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return null;
  if (typeof record.pairToken !== "string" || record.pairToken.length === 0) return null;
  if (typeof record.dashboardPath !== "string" || record.dashboardPath.length === 0) return null;
  if (typeof record.compassTabId !== "number" || !Number.isInteger(record.compassTabId)) return null;
  return {
    sessionId: record.sessionId,
    pairToken: record.pairToken,
    dashboardPath: record.dashboardPath,
    compassTabId: record.compassTabId
  };
}

export function publicResumableLive(pair: LivePairRecord | null): { sessionId: string; dashboardPath: string } | undefined {
  if (!pair) return undefined;
  return { sessionId: pair.sessionId, dashboardPath: pair.dashboardPath };
}

export function shouldStopRemoteLiveOnInvalidate(reason: LifecycleReasonCode): boolean {
  return reason !== "page_login";
}

export function shouldPersistLivePairOnInvalidate(reason: LifecycleReasonCode): boolean {
  return reason === "page_login";
}

export function shouldClearLivePairAfterStop(stopSucceeded: boolean): boolean {
  return stopSucceeded;
}

export function existingLivePairToReuse(input: { memory: LivePairRecord | null; persisted: LivePairRecord | null }): LivePairRecord | null {
  return input.memory ?? input.persisted;
}

export function interpretLiveReattachStatus(status: number): "ok" | "unusable" | "retryable" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 404 || status === 409) return "unusable";
  return "retryable";
}

export type LiveReattachResult =
  | { ok: true; sessionId: string; dashboardPath: string }
  | { ok: false; unusable: boolean };

export async function resolveLiveSession(input: {
  tabId: number;
  memory: LivePairRecord | null;
  persisted: LivePairRecord | null;
  reattach: (pair: LivePairRecord) => Promise<LiveReattachResult>;
  create: () => Promise<{ sessionId: string; pairToken: string; dashboardPath: string }>;
}): Promise<{ pair: LivePairRecord; reused: boolean }> {
  const existing = existingLivePairToReuse({ memory: input.memory, persisted: input.persisted });
  if (existing) {
    const result = await input.reattach(existing);
    if (result.ok) {
      return {
        pair: {
          sessionId: result.sessionId,
          pairToken: existing.pairToken,
          dashboardPath: result.dashboardPath,
          compassTabId: input.tabId
        },
        reused: true
      };
    }
    if (!result.unusable) throw new Error("真实直播挂回失败，请确认本机服务后重试");
  }
  const created = await input.create();
  return { pair: { ...created, compassTabId: input.tabId }, reused: false };
}

async function loadFromArea(storage: LivePairStorage): Promise<LivePairRecord | null> {
  try {
    const stored = await storage.get(LIVE_PAIR_STORAGE_KEY);
    return parseLivePairRecord(stored[LIVE_PAIR_STORAGE_KEY]);
  } catch {
    return null;
  }
}

async function persistToArea(storage: LivePairStorage, pair: LivePairRecord): Promise<void> {
  await storage.set({ [LIVE_PAIR_STORAGE_KEY]: pair });
}

async function clearArea(storage: LivePairStorage): Promise<void> {
  await storage.remove(LIVE_PAIR_STORAGE_KEY);
}

export async function loadPersistedLivePair(storage: LivePairStorageInput): Promise<LivePairRecord | null> {
  if (!isDurableLivePairStorage(storage)) return loadFromArea(storage);
  const fromLocal = await loadFromArea(storage.local);
  if (fromLocal) {
    if (storage.session) await persistToArea(storage.session, fromLocal).catch(() => undefined);
    return fromLocal;
  }
  if (!storage.session) return null;
  const fromSession = await loadFromArea(storage.session);
  if (!fromSession) return null;
  await persistToArea(storage.local, fromSession).catch(() => undefined);
  return fromSession;
}

export async function persistLivePair(storage: LivePairStorageInput, pair: LivePairRecord): Promise<void> {
  if (!isDurableLivePairStorage(storage)) {
    await persistToArea(storage, pair);
    return;
  }
  await persistToArea(storage.local, pair);
  if (storage.session) await persistToArea(storage.session, pair).catch(() => undefined);
}

export async function clearPersistedLivePair(storage: LivePairStorageInput): Promise<void> {
  if (!isDurableLivePairStorage(storage)) {
    await clearArea(storage);
    return;
  }
  await clearArea(storage.local);
  if (storage.session) await clearArea(storage.session).catch(() => undefined);
}

export function liveStartAudioRetryWarning(reused: boolean): string {
  return reused ? "场次已恢复，音频需再点一次采集" : "场次已连接，音频需再点一次采集";
}
