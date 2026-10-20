/** Per-tab state must be isolated because MV3 debugger events are concurrent. */
export interface TabRuntimeContext<T> {
  tabId: number;
  state: T;
}

export class TabRuntimeRegistry<T> {
  private readonly values = new Map<number, TabRuntimeContext<T>>();

  constructor(private readonly create: (tabId: number) => T) {}

  get(tabId: number): TabRuntimeContext<T> {
    const existing = this.values.get(tabId);
    if (existing) return existing;
    const context = { tabId, state: this.create(tabId) };
    this.values.set(tabId, context);
    return context;
  }

  peek(tabId: number): TabRuntimeContext<T> | undefined { return this.values.get(tabId); }
  has(tabId: number): boolean { return this.values.has(tabId); }
  remove(tabId: number): void { this.values.delete(tabId); }
  tabIds(): number[] { return [...this.values.keys()].sort((a, b) => a - b); }
}

export interface SharedLiveConnection {
  sessionId: string;
  pairToken: string;
  dashboardPath: string;
  compassTabId: number;
}

export function compassAudioOwnedByTab(routeId: string | null | undefined, tabId: number, ownerTabId?: number): boolean {
  return routeId === "compass-live-shop" && (ownerTabId === undefined || ownerTabId === tabId);
}

export class SharedLiveConnectionStore {
  private value: SharedLiveConnection | null = null;

  setFromCompass(tabId: number, value: SharedLiveConnection): boolean {
    if (value.compassTabId !== tabId) return false;
    this.value = { ...value };
    return true;
  }

  get(): SharedLiveConnection | null { return this.value ? { ...this.value } : null; }

  restore(value: SharedLiveConnection): void {
    this.value = { ...value };
  }

  clear(): void {
    this.value = null;
  }

  clearFromCompass(tabId: number): boolean {
    if (!this.value || this.value.compassTabId !== tabId) return false;
    this.value = null;
    return true;
  }
}

/** Serializes lifecycle and debugger work so activateContext cannot race across tabs. */
export class SerializedRuntimeQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Waits for the queue only until a caller-owned deadline.  The queued
   * operation still starts later, but receives the same deadline guard so it
   * cannot perform work after the caller has already received a timeout.
   */
  enqueueWithDeadline<T>(operation: () => Promise<T>, deadlineAt: number, onExpired: () => T): Promise<T> {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = (): T => {
      if (settled) return onExpired();
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      return onExpired();
    };
    const remaining = Math.max(0, deadlineAt - Date.now());
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(expired()), remaining);
    });
    const queued = this.enqueue(async () => {
      if (Date.now() >= deadlineAt) return expired();
      const value = await operation();
      if (settled) return value;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      return value;
    });
    void queued.catch(() => undefined);
    return Promise.race([queued, timeout]);
  }
}
