import Redis from "ioredis";
import type { MvpStateSnapshot, SessionState } from "@live-growth/contracts";
import type { ComponentHealth } from "./storage";

export type StateBusPayload = SessionState | MvpStateSnapshot;

export function isMvpStatePayload(state: StateBusPayload): state is MvpStateSnapshot {
  return Object.hasOwn(state, "latestPoint") && Object.hasOwn(state, "currentProductId");
}

export interface StateBus {
  readonly mode: "local-demo" | "redis";
  publish(sessionId: string, state: StateBusPayload): Promise<void>;
  subscribe(sessionId: string, listener: (state: StateBusPayload) => void): Promise<() => Promise<void>>;
  health(): Promise<ComponentHealth>;
  close(): Promise<void>;
}

export interface RedisClientPort {
  status: string;
  connect(): Promise<void>;
  xadd(...args: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  ping(): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  quit(): Promise<unknown>;
}

export class LocalStateBus implements StateBus {
  readonly mode = "local-demo" as const;
  private readonly listeners = new Map<string, Set<(state: StateBusPayload) => void>>();
  async publish(sessionId: string, state: StateBusPayload): Promise<void> {
    for (const listener of this.listeners.get(sessionId) ?? []) listener(structuredClone(state));
  }
  async subscribe(sessionId: string, listener: (state: StateBusPayload) => void): Promise<() => Promise<void>> {
    const current = this.listeners.get(sessionId) ?? new Set();
    current.add(listener);
    this.listeners.set(sessionId, current);
    return async () => { current.delete(listener); };
  }
  async health(): Promise<ComponentHealth> { return { status: "not_configured", message: "本地演示广播，未使用 Redis" }; }
  async close(): Promise<void> { this.listeners.clear(); }
}

type RedisClients = { publisher: RedisClientPort; subscriber: RedisClientPort };

export class RedisStateBus implements StateBus {
  readonly mode = "redis" as const;
  private readonly publisher: RedisClientPort;
  private readonly subscriber: RedisClientPort;
  private readonly listenersByChannel = new Map<string, Set<(state: StateBusPayload) => void>>();
  private readonly subscriptionReadyByChannel = new Map<string, Promise<unknown>>();
  private readonly subscribedChannels = new Set<string>();
  private subscriberReady: boolean;
  private lastFailureAt: string | undefined;
  private readonly messageHandler = (...args: unknown[]) => {
    const [channel, body] = args;
    if (typeof channel !== "string" || typeof body !== "string") return;
    const listeners = this.listenersByChannel.get(channel);
    if (!listeners?.size) return;
    const state = JSON.parse(body) as StateBusPayload;
    for (const listener of listeners) listener(state);
  };
  private readonly readyHandler = () => {
    this.subscriberReady = true;
    this.subscribedChannels.clear();
    for (const channel of this.listenersByChannel.keys()) {
      this.subscriptionReadyByChannel.delete(channel);
      void this.subscribeChannel(channel).catch(() => this.markDegraded());
    }
  };
  private readonly publisherErrorHandler = () => { this.markDegraded(); };
  private readonly subscriberErrorHandler = () => {
    this.subscriberReady = false;
    this.subscribedChannels.clear();
    this.markDegraded();
  };

  constructor(redisUrlOrClients: string | RedisClients) {
    if (typeof redisUrlOrClients === "string") {
      const options = {
        lazyConnect: true,
        connectTimeout: 1_000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (attempt: number) => Math.min(attempt * 200, 1_000)
      };
      this.publisher = new Redis(redisUrlOrClients, options) as unknown as RedisClientPort;
      this.subscriber = new Redis(redisUrlOrClients, options) as unknown as RedisClientPort;
    } else {
      this.publisher = redisUrlOrClients.publisher;
      this.subscriber = redisUrlOrClients.subscriber;
    }
    this.subscriberReady = this.subscriber.status === "ready";
    this.subscriber.on("message", this.messageHandler);
    this.subscriber.on("ready", this.readyHandler);
    this.publisher.on("error", this.publisherErrorHandler);
    this.subscriber.on("error", this.subscriberErrorHandler);
  }

  async publish(sessionId: string, state: StateBusPayload): Promise<void> {
    try {
      if (this.publisher.status === "wait" || this.publisher.status === "end") await this.publisher.connect();
      const body = JSON.stringify(state);
      await this.publisher.xadd(`session:${sessionId}:states`, "MAXLEN", "~", "1000", "*", "state", body);
      await this.publisher.publish(`session:${sessionId}:state`, body);
    } catch {
      this.markDegraded();
      throw new Error("Redis 实时广播不可用");
    }
  }

  async subscribe(sessionId: string, listener: (state: StateBusPayload) => void): Promise<() => Promise<void>> {
    const channel = `session:${sessionId}:state`;
    let listeners = this.listenersByChannel.get(channel);
    let subscriptionReady = this.subscriptionReadyByChannel.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.listenersByChannel.set(channel, listeners);
      subscriptionReady = this.subscribeChannel(channel);
    }
    listeners.add(listener);
    try { await subscriptionReady; } catch { this.markDegraded(); }
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.listenersByChannel.get(channel);
      current?.delete(listener);
      if (current?.size === 0) {
        this.listenersByChannel.delete(channel);
        this.subscriptionReadyByChannel.delete(channel);
        this.subscribedChannels.delete(channel);
        try { await this.subscriber.unsubscribe(channel); } catch { this.markDegraded(); }
      }
    };
  }

  async health(): Promise<ComponentHealth> {
    try {
      if (this.publisher.status === "wait" || this.publisher.status === "end") await this.publisher.connect();
      await Promise.race([
        this.publisher.ping(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Redis health timeout")), 1_200))
      ]);
      const activeChannels = [...this.listenersByChannel.keys()];
      if (activeChannels.length > 0) {
        if (this.subscriber.status === "wait" || this.subscriber.status === "end") await this.subscriber.connect();
        this.subscriberReady = this.subscriber.status === "ready";
        if (!this.subscriberReady) throw new Error("Redis subscriber 未 ready");
        await Promise.all(activeChannels.map((channel) => this.subscribeChannel(channel)));
        if (activeChannels.some((channel) => !this.subscribedChannels.has(channel))) throw new Error("Redis channel 未订阅");
      }
      this.lastFailureAt = undefined;
      return { status: "healthy", message: "Redis 连接正常" };
    } catch {
      this.markDegraded();
      return {
        status: "degraded",
        message: "Redis 发布或订阅链路不可用，持久化仍由 PostgreSQL 保障",
        ...(this.lastFailureAt ? { lastFailureAt: this.lastFailureAt } : {})
      };
    }
  }

  private subscribeChannel(channel: string): Promise<unknown> {
    const existing = this.subscriptionReadyByChannel.get(channel);
    if (existing) return existing;
    const subscription = (async () => {
      if (this.subscriber.status === "wait" || this.subscriber.status === "end") await this.subscriber.connect();
      this.subscriberReady = this.subscriber.status === "ready";
      if (!this.subscriberReady) throw new Error("Redis subscriber 未 ready");
      const result = await this.subscriber.subscribe(channel);
      this.subscribedChannels.add(channel);
      return result;
    })();
    this.subscriptionReadyByChannel.set(channel, subscription);
    void subscription.catch(() => {
      if (this.subscriptionReadyByChannel.get(channel) === subscription) this.subscriptionReadyByChannel.delete(channel);
    });
    return subscription;
  }

  private markDegraded(): void {
    this.lastFailureAt = new Date().toISOString();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.listenersByChannel.keys()].map((channel) => this.subscriber.unsubscribe(channel)));
    this.listenersByChannel.clear();
    this.subscriptionReadyByChannel.clear();
    this.subscribedChannels.clear();
    this.subscriber.off("message", this.messageHandler);
    this.subscriber.off("ready", this.readyHandler);
    this.publisher.off("error", this.publisherErrorHandler);
    this.subscriber.off("error", this.subscriberErrorHandler);
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }
}
