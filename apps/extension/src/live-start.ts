import type { RuntimeResponse } from "./types.js";

export const LIVE_START_DEADLINE_MS = 25_000;
export const POPUP_LIVE_START_TIMEOUT_MS = LIVE_START_DEADLINE_MS + 5_000;
export const LIVE_SERVER_UNREACHABLE_MESSAGE = "本机服务未启动或无法连接，请先按 README 启动本机服务（pnpm dev），再连接";

export class LiveStartTimeoutError extends Error {
  constructor() {
    super("真实直播连接超时，请重新加载扩展后重试");
    this.name = "LiveStartTimeoutError";
  }
}

export function liveServerUnreachableMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "Failed to fetch"
    || message === "NetworkError when attempting to fetch resource."
    || message === "Load failed"
    || /failed to fetch/i.test(message)
    || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/i.test(message)
  ) {
    return LIVE_SERVER_UNREACHABLE_MESSAGE;
  }
  return message || "真实直播连接失败";
}

export function shouldCleanupLiveStart(currentAttempt: symbol | undefined, attempt: symbol): boolean {
  return currentAttempt === attempt;
}

/** Bound the popup-facing start operation; late work remains observed by its caller. */
export function withLiveStartDeadline<T>(operation: Promise<T>, timeoutMs = LIVE_START_DEADLINE_MS, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      reject(new LiveStartTimeoutError());
    }, timeoutMs);
    operation.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

export type LiveStartStage = (guard: () => void) => Promise<RuntimeResponse>;

export interface LiveStartTransactionStages<TSession> {
  network: LiveStartStage;
  createSession: (guard: () => void) => Promise<TSession>;
  readDom: (guard: () => void) => Promise<string | undefined>;
  startAudio: LiveStartStage;
  cleanup: () => void | Promise<void>;
  stopOrphanSession: (session: TSession) => void | Promise<void>;
}

export type LiveStartTransactionResult<TSession> =
  | { ok: true; session: TSession; audio: RuntimeResponse; domWarning?: string }
  | RuntimeResponse;

/**
 * Runs the real-live startup stages under one attempt deadline.  The stage
 * callbacks are injected so delayed server/audio responses can be tested
 * without a Chrome runtime or a live server.
 */
export async function runLiveStartTransaction<TSession>(
  stages: LiveStartTransactionStages<TSession>,
  timeoutMs = LIVE_START_DEADLINE_MS
): Promise<LiveStartTransactionResult<TSession>> {
  let current = true;
  let cleanupStarted = false;
  const cleanupOnce = (): void => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void Promise.resolve(stages.cleanup()).catch(() => undefined);
  };
  const guard = (): void => {
    if (!current) throw new LiveStartTimeoutError();
  };
  if (timeoutMs <= 0) {
    current = false;
    cleanupOnce();
    return { ok: false, error: new LiveStartTimeoutError().message };
  }
  const operation = (async (): Promise<LiveStartTransactionResult<TSession>> => {
    const network = await stages.network(guard);
    guard();
    if (!network.ok) return network;

    const session = await stages.createSession(guard);
    try {
      guard();
    } catch (error) {
      void Promise.resolve(stages.stopOrphanSession(session)).catch(() => undefined);
      throw error;
    }

    const domWarning = await stages.readDom(guard);
    guard();
    const audio = await stages.startAudio(guard);
    guard();
    return { ok: true, session, audio, ...(domWarning ? { domWarning } : {}) };
  })();

  try {
    return await withLiveStartDeadline(operation, timeoutMs, () => {
      current = false;
      cleanupOnce();
    });
  } catch (error) {
    current = false;
    cleanupOnce();
    return { ok: false, error: liveServerUnreachableMessage(error) };
  }
}

/** Await one audio consume operation and clean up only when its attempt expires. */
export async function awaitAudioConsumeForLiveStart<T>(
  operation: Promise<T>,
  guard: () => void,
  cleanupStaleAudio: () => void | Promise<void>
): Promise<T> {
  let cleaned = false;
  const cleanupOnce = (): void => {
    if (cleaned) return;
    cleaned = true;
    void Promise.resolve(cleanupStaleAudio()).catch(() => undefined);
  };
  try {
    const result = await operation;
    try {
      guard();
    } catch (error) {
      cleanupOnce();
      throw error;
    }
    return result;
  } catch (error) {
    if (error instanceof LiveStartTimeoutError) cleanupOnce();
    throw error;
  }
}

/** DOM is a best-effort fallback; a live session can wait for network data. */
export function liveStartDomWarning(message: string): string {
  void message;
  return "已连接，正在等待首批罗盘数据";
}

export function shouldOpenLiveDashboard(response: RuntimeResponse): boolean {
  if (!response.live) return false;
  if (response.ok === true && response.error === undefined) return true;
  return response.errorCode !== undefined;
}

export async function closeOffscreenAudioDocument(input: {
  sendStop?: () => Promise<unknown>;
  hasDocument: () => Promise<boolean>;
  closeDocument: () => Promise<void>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<void> {
  try { await input.sendStop?.(); } catch { /* already closed */ }
  try {
    if (await input.hasDocument()) await input.closeDocument();
  } catch { /* best effort */ }
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const deadline = now() + (input.timeoutMs ?? 500);
  while (now() < deadline) {
    try {
      if (!(await input.hasDocument())) return;
    } catch {
      return;
    }
    await wait(20);
  }
}

export function networkActionLabel(routeId: string | null): string {
  return routeId === "qianchuan-board" ? "连接千川数据" : "开始网络探针";
}

export function shouldPollLiveDom(input: { active: boolean; tabId: number; activeTabId: number | null; routeAllowed: boolean; sessionMatches: boolean }): boolean {
  return input.active && input.activeTabId === input.tabId && input.routeAllowed && input.sessionMatches;
}
