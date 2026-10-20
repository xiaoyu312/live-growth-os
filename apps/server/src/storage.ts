import type { LiveEvent, MvpProduct, Session } from "@live-growth/contracts";
import postgres from "postgres";
type PostgresJson = Parameters<ReturnType<typeof postgres>["json"]>[0];

export type LivePilotAuthRecord = { tokenHashHex: string; createdAt: string };

export interface EventStore {
  readonly mode: "memory-demo" | "postgres" | "sqlite";
  createSession(session: Session): Promise<Session>;
  getSession(id: string): Promise<Session | undefined>;
  tryStartSession(id: string, startedAt: string): Promise<Session | undefined>;
  updateSession(session: Session): Promise<void>;
  listSessions(scenario?: Session["scenario"]): Promise<Session[]>;
  saveLivePilotAuth(sessionId: string, auth: LivePilotAuthRecord): Promise<void>;
  loadLivePilotAuth(sessionId: string): Promise<LivePilotAuthRecord | undefined>;
  appendEvent(event: LiveEvent): Promise<boolean>;
  listEvents(sessionId: string): Promise<LiveEvent[]>;
  countEvents(sessionId: string, kind?: LiveEvent["kind"]): Promise<number>;
  listEventsBetween(sessionId: string, fromInclusive?: string, toExclusive?: string): Promise<LiveEvent[]>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
}

export type MvpCatalogStore = {
  listMvpProducts(): Promise<MvpProduct[]>;
  saveMvpProduct(product: MvpProduct): Promise<MvpProduct>;
};

export type ComponentHealth = {
  status: "healthy" | "degraded" | "offline" | "not_configured";
  message: string;
  version?: string;
  lastFailureAt?: string;
};

export type StorageHealth = { postgres: ComponentHealth; pgvector: ComponentHealth; sqlite?: ComponentHealth };

export class MemoryEventStore implements EventStore {
  readonly mode = "memory-demo" as const;
  private readonly sessions = new Map<string, Session>();
  private readonly events = new Map<string, LiveEvent[]>();
  private readonly eventIds = new Set<string>();
  private readonly dedupeKeys = new Set<string>();
  private readonly mvpProducts = new Map<string, MvpProduct>();
  private readonly pilotAuth = new Map<string, LivePilotAuthRecord>();

  async createSession(session: Session): Promise<Session> {
    this.sessions.set(session.id, structuredClone(session));
    this.events.set(session.id, []);
    return structuredClone(session);
  }

  async getSession(id: string): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : undefined;
  }

  async tryStartSession(id: string, startedAt: string): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    if (!session || session.status !== "created") return undefined;
    const running: Session = { ...session, status: "running", startedAt };
    this.sessions.set(id, structuredClone(running));
    return structuredClone(running);
  }

  async updateSession(session: Session): Promise<void> {
    if (!this.sessions.has(session.id)) throw new Error(`场次不存在：${session.id}`);
    this.sessions.set(session.id, structuredClone(session));
  }

  async listSessions(scenario?: Session["scenario"]): Promise<Session[]> {
    return [...this.sessions.values()]
      .filter((session) => !scenario || session.scenario === scenario)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .map((session) => structuredClone(session));
  }

  async saveLivePilotAuth(sessionId: string, auth: LivePilotAuthRecord): Promise<void> {
    this.pilotAuth.set(sessionId, { ...auth });
  }

  async loadLivePilotAuth(sessionId: string): Promise<LivePilotAuthRecord | undefined> {
    const auth = this.pilotAuth.get(sessionId);
    return auth ? { ...auth } : undefined;
  }

  async appendEvent(event: LiveEvent): Promise<boolean> {
    const scopedDedupeKey = event.dedupeKey ? `${event.sessionId}:${event.dedupeKey}` : undefined;
    if (this.eventIds.has(event.eventId) || (scopedDedupeKey && this.dedupeKeys.has(scopedDedupeKey))) return false;
    this.eventIds.add(event.eventId);
    if (scopedDedupeKey) this.dedupeKeys.add(scopedDedupeKey);
    const current = this.events.get(event.sessionId);
    if (!current) throw new Error(`场次不存在：${event.sessionId}`);
    current.push(structuredClone(event));
    current.sort((left, right) => Date.parse(left.eventAt) - Date.parse(right.eventAt) || left.eventId.localeCompare(right.eventId));
    return true;
  }

  async listEvents(sessionId: string): Promise<LiveEvent[]> {
    return structuredClone(this.events.get(sessionId) ?? []);
  }

  async countEvents(sessionId: string, kind?: LiveEvent["kind"]): Promise<number> {
    const events = this.events.get(sessionId) ?? [];
    return kind ? events.reduce((total, event) => total + (event.kind === kind ? 1 : 0), 0) : events.length;
  }

  async listEventsBetween(sessionId: string, fromInclusive?: string, toExclusive?: string): Promise<LiveEvent[]> {
    const fromMs = fromInclusive ? Date.parse(fromInclusive) : Number.NEGATIVE_INFINITY;
    const toMs = toExclusive ? Date.parse(toExclusive) : Number.POSITIVE_INFINITY;
    return (this.events.get(sessionId) ?? [])
      .filter((event) => {
        const at = Date.parse(event.eventAt);
        return Number.isFinite(at) && at >= fromMs && at < toMs;
      })
      .map((event) => structuredClone(event));
  }

  async health(): Promise<StorageHealth> {
    const notConfigured = { status: "not_configured" as const, message: "内存演示模式未使用 PostgreSQL" };
    return { postgres: notConfigured, pgvector: notConfigured };
  }

  async close(): Promise<void> {}

  async listMvpProducts(): Promise<MvpProduct[]> { return structuredClone([...this.mvpProducts.values()]); }
  async saveMvpProduct(product: MvpProduct): Promise<MvpProduct> { this.mvpProducts.set(product.productId, structuredClone(product)); return structuredClone(product); }
}

type SessionRow = {
  id: string; tenant_id: string; name: string; scenario: Session["scenario"]; seed: number;
  include_comment_intent: boolean; status: Session["status"]; created_at: Date;
  started_at: Date | null; stopped_at: Date | null;
};

function mapSession(row: SessionRow): Session {
  return {
    id: row.id, tenantId: row.tenant_id, name: row.name, scenario: row.scenario, seed: row.seed,
    includeCommentIntent: row.include_comment_intent, status: row.status, createdAt: row.created_at.toISOString(),
    ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.stopped_at ? { stoppedAt: row.stopped_at.toISOString() } : {})
  };
}

type EventRow = {
  event_id: string; dedupe_key: string | null; tenant_id: string; session_id: string; event_at: Date;
  captured_at: Date; ingested_at: Date; source: LiveEvent["source"]; kind: LiveEvent["kind"];
  schema_version: 1; provisional: boolean; payload: unknown; metadata: Record<string, unknown> | null;
};

function mapEventRow(row: EventRow): LiveEvent {
  return {
    schemaVersion: row.schema_version, eventId: row.event_id, ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    tenantId: row.tenant_id, sessionId: row.session_id, eventAt: row.event_at.toISOString(),
    capturedAt: row.captured_at.toISOString(), ingestedAt: row.ingested_at.toISOString(), source: row.source,
    kind: row.kind, provisional: row.provisional, payload: row.payload, ...(row.metadata ? { metadata: row.metadata } : {})
  };
}

export class PostgresEventStore implements EventStore {
  readonly mode = "postgres" as const;
  private readonly sql: ReturnType<typeof postgres>;
  constructor(databaseUrl: string) { this.sql = postgres(databaseUrl, { max: 10, connect_timeout: 2 }); }

  async createSession(session: Session): Promise<Session> {
    const [row] = await this.sql<SessionRow[]>`
      INSERT INTO sessions (id, tenant_id, name, scenario, seed, include_comment_intent, status, created_at)
      VALUES (${session.id}, ${session.tenantId}, ${session.name}, ${session.scenario}, ${session.seed}, ${session.includeCommentIntent}, ${session.status}, ${session.createdAt})
      RETURNING *`;
    if (!row) throw new Error("创建场次后未返回数据");
    return mapSession(row);
  }

  async getSession(id: string): Promise<Session | undefined> {
    const [row] = await this.sql<SessionRow[]>`SELECT * FROM sessions WHERE id = ${id}`;
    return row ? mapSession(row) : undefined;
  }

  async tryStartSession(id: string, startedAt: string): Promise<Session | undefined> {
    const [row] = await this.sql<SessionRow[]>`
      UPDATE sessions SET status = 'running', started_at = ${startedAt}
      WHERE id = ${id} AND status = 'created'
      RETURNING *`;
    return row ? mapSession(row) : undefined;
  }

  async updateSession(session: Session): Promise<void> {
    await this.sql`UPDATE sessions SET status = ${session.status}, started_at = ${session.startedAt ?? null}, stopped_at = ${session.stoppedAt ?? null} WHERE id = ${session.id}`;
  }

  async listSessions(scenario?: Session["scenario"]): Promise<Session[]> {
    const rows = scenario
      ? await this.sql<SessionRow[]>`SELECT * FROM sessions WHERE scenario = ${scenario} ORDER BY created_at, id`
      : await this.sql<SessionRow[]>`SELECT * FROM sessions ORDER BY created_at, id`;
    return rows.map(mapSession);
  }

  async saveLivePilotAuth(sessionId: string, auth: LivePilotAuthRecord): Promise<void> {
    await this.sql`
      INSERT INTO live_pilot_auth (session_id, token_hash, created_at)
      VALUES (${sessionId}, ${auth.tokenHashHex}, ${auth.createdAt})
      ON CONFLICT (session_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = EXCLUDED.created_at`;
  }

  async loadLivePilotAuth(sessionId: string): Promise<LivePilotAuthRecord | undefined> {
    const [row] = await this.sql<Array<{ token_hash: string; created_at: Date }>>`
      SELECT token_hash, created_at FROM live_pilot_auth WHERE session_id = ${sessionId}`;
    return row ? { tokenHashHex: row.token_hash, createdAt: row.created_at.toISOString() } : undefined;
  }

  async appendEvent(event: LiveEvent): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO live_events (event_id, dedupe_key, tenant_id, session_id, event_at, captured_at, ingested_at, source, kind, schema_version, provisional, payload, metadata)
      VALUES (${event.eventId}, ${event.dedupeKey ?? null}, ${event.tenantId}, ${event.sessionId}, ${event.eventAt}, ${event.capturedAt}, ${event.ingestedAt}, ${event.source}, ${event.kind}, ${event.schemaVersion}, ${event.provisional}, ${this.sql.json(event.payload as PostgresJson)}, ${event.metadata ? this.sql.json(event.metadata as PostgresJson) : null})
      ON CONFLICT DO NOTHING RETURNING event_id`;
    return rows.length === 1;
  }

  async listEvents(sessionId: string): Promise<LiveEvent[]> {
    return this.listEventsBetween(sessionId);
  }

  async countEvents(sessionId: string, kind?: LiveEvent["kind"]): Promise<number> {
    const rows = kind
      ? await this.sql<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM live_events WHERE session_id = ${sessionId} AND kind = ${kind}`
      : await this.sql<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM live_events WHERE session_id = ${sessionId}`;
    return rows[0]?.count ?? 0;
  }

  async listEventsBetween(sessionId: string, fromInclusive?: string, toExclusive?: string): Promise<LiveEvent[]> {
    const fromAt = fromInclusive && Number.isFinite(Date.parse(fromInclusive)) ? new Date(fromInclusive) : undefined;
    const toAt = toExclusive && Number.isFinite(Date.parse(toExclusive)) ? new Date(toExclusive) : undefined;
    const rows = fromAt && toAt
      ? await this.sql<EventRow[]>`SELECT * FROM live_events WHERE session_id = ${sessionId} AND event_at >= ${fromAt} AND event_at < ${toAt} ORDER BY event_at, event_id`
      : fromAt
        ? await this.sql<EventRow[]>`SELECT * FROM live_events WHERE session_id = ${sessionId} AND event_at >= ${fromAt} ORDER BY event_at, event_id`
        : toAt
          ? await this.sql<EventRow[]>`SELECT * FROM live_events WHERE session_id = ${sessionId} AND event_at < ${toAt} ORDER BY event_at, event_id`
          : await this.sql<EventRow[]>`SELECT * FROM live_events WHERE session_id = ${sessionId} ORDER BY event_at, event_id`;
    return rows.map(mapEventRow);
  }

  async health(): Promise<StorageHealth> {
    try {
      await this.sql`SELECT 1`;
    } catch {
      return {
        postgres: { status: "offline", message: "PostgreSQL 连接失败" },
        pgvector: { status: "offline", message: "PostgreSQL 不可用，无法检查 pgvector" }
      };
    }
    let extension: { extversion: string } | undefined;
    try {
      [extension] = await this.sql<Array<{ extversion: string }>>`
        SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
    } catch {
      return {
        postgres: { status: "healthy", message: "PostgreSQL 连接正常" },
        pgvector: { status: "offline", message: "pgvector 扩展检查失败" }
      };
    }
    return {
      postgres: { status: "healthy", message: "PostgreSQL 连接正常" },
      pgvector: extension
        ? { status: "healthy", message: "pgvector 扩展已加载", version: extension.extversion }
        : { status: "offline", message: "pgvector 扩展未加载" }
    };
  }

  async assertReady(): Promise<void> {
    const health = await this.health();
    if (health.postgres.status !== "healthy") throw new Error(`PostgreSQL readiness 失败：${health.postgres.message}`);
    if (health.pgvector.status !== "healthy") throw new Error(`pgvector readiness 失败：${health.pgvector.message}`);
  }

  async close(): Promise<void> { await this.sql.end(); }

  async listMvpProducts(): Promise<MvpProduct[]> {
    const rows = await this.sql<Array<{ product_id: string; name: string; product_type: MvpProduct["type"]; price_fen: number; enabled: boolean; note: string | null }>>`SELECT product_id, name, product_type, price_fen, enabled, note FROM mvp_products ORDER BY product_id`;
    return rows.map((row) => ({ productId: row.product_id, name: row.name, type: row.product_type, priceFen: row.price_fen, enabled: row.enabled, ...(row.note ? { note: row.note } : {}) }));
  }

  async saveMvpProduct(product: MvpProduct): Promise<MvpProduct> {
    const [row] = await this.sql<Array<{ product_id: string; name: string; product_type: MvpProduct["type"]; price_fen: number; enabled: boolean; note: string | null }>>`
      INSERT INTO mvp_products (product_id, name, product_type, price_fen, enabled, note)
      VALUES (${product.productId}, ${product.name}, ${product.type}, ${product.priceFen}, ${product.enabled}, ${product.note ?? null})
      ON CONFLICT (product_id) DO UPDATE SET name = EXCLUDED.name, product_type = EXCLUDED.product_type, price_fen = EXCLUDED.price_fen, enabled = EXCLUDED.enabled, note = EXCLUDED.note
      RETURNING product_id, name, product_type, price_fen, enabled, note`;
    if (!row) throw new Error("保存商品后未返回数据");
    return { productId: row.product_id, name: row.name, type: row.product_type, priceFen: row.price_fen, enabled: row.enabled, ...(row.note ? { note: row.note } : {}) };
  }
}
