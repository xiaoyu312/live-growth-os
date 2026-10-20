import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { liveEventSchema, sessionSchema, mvpProductSchema, type LiveEvent, type Session, type MvpProduct } from "@live-growth/contracts";
import type { EventStore, LivePilotAuthRecord, StorageHealth } from "./storage";

/** Desktop-only durable store. Never opens or migrates a server/PostgreSQL database. */
export class SqliteEventStore implements EventStore {
  readonly mode = "sqlite" as const;
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, scenario TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), dedupe_key TEXT, event_at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, dedupe_key));
        CREATE INDEX IF NOT EXISTS events_session_at ON events(session_id, event_at, id);
        CREATE TABLE IF NOT EXISTS pilot_auth (session_id TEXT PRIMARY KEY REFERENCES sessions(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
      chmodSync(path, 0o600);
    } catch (error) { this.db.close(); throw error; }
  }
  async createSession(input: Session): Promise<Session> {
    const s = sessionSchema.parse(input);
    this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run(s.id, s.scenario, s.status, new Date(s.createdAt).toISOString(), JSON.stringify(s));
    return s;
  }
  async getSession(id: string): Promise<Session | undefined> {
    const row = this.db.prepare("SELECT data FROM sessions WHERE id = ?").get(id);
    return row ? sessionSchema.parse(JSON.parse(String(row.data))) : undefined;
  }
  async tryStartSession(id: string, startedAt: string): Promise<Session | undefined> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT data FROM sessions WHERE id = ? AND status = 'created'").get(id);
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      const next = sessionSchema.parse({ ...JSON.parse(String(row.data)), status: "running", startedAt });
      this.db.prepare("UPDATE sessions SET status = ?, data = ? WHERE id = ?").run(next.status, JSON.stringify(next), id);
      this.db.exec("COMMIT");
      return next;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async updateSession(input: Session): Promise<void> {
    const s = sessionSchema.parse(input);
    const result = this.db.prepare("UPDATE sessions SET scenario = ?, status = ?, created_at = ?, data = ? WHERE id = ?").run(s.scenario, s.status, new Date(s.createdAt).toISOString(), JSON.stringify(s), s.id);
    if (result.changes !== 1) throw new Error("场次不存在");
  }
  async listSessions(scenario?: Session["scenario"]): Promise<Session[]> {
    const rows = scenario
      ? this.db.prepare("SELECT data FROM sessions WHERE scenario = ? ORDER BY created_at, id").all(scenario)
      : this.db.prepare("SELECT data FROM sessions ORDER BY created_at, id").all();
    return rows.map((row) => sessionSchema.parse(JSON.parse(String(row.data))));
  }
  async saveLivePilotAuth(sessionId: string, auth: LivePilotAuthRecord): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(auth.tokenHashHex) || !Number.isFinite(Date.parse(auth.createdAt))) throw new Error("配对摘要无效");
    this.db.prepare("INSERT INTO pilot_auth VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data").run(sessionId, JSON.stringify(auth));
  }
  async loadLivePilotAuth(sessionId: string): Promise<LivePilotAuthRecord | undefined> {
    const row = this.db.prepare("SELECT data FROM pilot_auth WHERE session_id = ?").get(sessionId);
    return row ? JSON.parse(String(row.data)) as LivePilotAuthRecord : undefined;
  }
  async appendEvent(input: LiveEvent): Promise<boolean> {
    const e = liveEventSchema.parse(input);
    const result = this.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").run(e.eventId, e.sessionId, e.dedupeKey ?? null, new Date(e.eventAt).toISOString(), e.kind, JSON.stringify(e));
    return result.changes === 1;
  }
  async listEvents(sessionId: string): Promise<LiveEvent[]> { return this.listEventsBetween(sessionId); }
  async listEventsBetween(sessionId: string, fromInclusive?: string, toExclusive?: string): Promise<LiveEvent[]> {
    return this.db.prepare("SELECT data FROM events WHERE session_id = ? AND (? IS NULL OR event_at >= ?) AND (? IS NULL OR event_at < ?) ORDER BY event_at, id")
      .all(sessionId, fromInclusive ? new Date(fromInclusive).toISOString() : null, fromInclusive ? new Date(fromInclusive).toISOString() : null, toExclusive ? new Date(toExclusive).toISOString() : null, toExclusive ? new Date(toExclusive).toISOString() : null)
      .map((row) => liveEventSchema.parse(JSON.parse(String(row.data))));
  }
  async countEvents(sessionId: string, kind?: LiveEvent["kind"]): Promise<number> {
    return Number(this.db.prepare("SELECT count(*) AS n FROM events WHERE session_id = ? AND (? IS NULL OR kind = ?)").get(sessionId, kind ?? null, kind ?? null)?.n ?? 0);
  }
  async listMvpProducts(): Promise<MvpProduct[]> {
    return this.db.prepare("SELECT data FROM products ORDER BY id").all().map((r) => mvpProductSchema.parse(JSON.parse(String(r.data))));
  }
  async saveMvpProduct(input: MvpProduct): Promise<MvpProduct> {
    const p = mvpProductSchema.parse(input);
    this.db.prepare("INSERT INTO products VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(p.productId, JSON.stringify(p));
    return p;
  }
  async health(): Promise<StorageHealth> {
    const unused = { status: "not_configured" as const, message: "单机版无需此服务" };
    try { this.db.prepare("SELECT 1").get(); return { postgres: unused, pgvector: unused, sqlite: { status: "healthy", message: "本机数据已持久化" } }; }
    catch { return { postgres: unused, pgvector: unused, sqlite: { status: "offline", message: "本机数据库不可用" } }; }
  }
  async close(): Promise<void> { this.db.close(); }
}
