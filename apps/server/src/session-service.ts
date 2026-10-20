import { createHash, randomUUID } from "node:crypto";
import {
  adviceDeliverySchema, adviceExecutionSchema, adviceFeedbackSchema, adviceOutcomeSchema, adviceSchema,
  canonicalMetricSnapshotSchema, createSessionSchema, detectedEventSchema, liveEventSchema, metricSnapshotSchema,
  productRoundSchema, ruleStatusSchema, sourceHealthSchema, transcriptSegmentSchema,
  type AdviceExecution, type AdviceOutcome, type AdviceProjection, type CanonicalMetricSnapshot,
  type LiveEvent, type Session, type SessionState
} from "@live-growth/contracts";
import { analyzeRules } from "@live-growth/rules";
import { generateSimulation, replayEvents } from "@live-growth/source-adapters";
import type { EventStore } from "./storage";
import { isMvpStatePayload, type StateBus } from "./state-bus";

export class SessionNotFoundError extends Error {}
export class AdviceNotFoundError extends Error {}
export class InvalidLifecycleError extends Error {}
export class InvalidAdviceTransitionError extends Error {}
export class InvalidEventScopeError extends Error {}
export class ReadOnlySessionError extends Error {}

const EFFECT_WINDOWS = [60, 120, 180, 300] as const;
const ANALYZABLE_KINDS = new Set<LiveEvent["kind"]>([
  "metric.snapshot", "metric.delta", "speech.final", "speech.tag", "comment.intent",
  "product.round.started", "product.round.ended", "product.changed", "traffic.changed", "session.marker"
]);

type WindowSummary = { metrics?: CanonicalMetricSnapshot; samples: number };

function secondsBetween(start: string | undefined, end: string | undefined): number | undefined {
  return start && end ? Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000) : undefined;
}

function compareAuditStage<T extends { createdAt: string }>(left: T, right: T, stage: (value: T) => number): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || stage(left) - stage(right);
}

function windowSummary(events: LiveEvent[], startAt: string, endAt: string): WindowSummary {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  const points = events.flatMap((event) => {
    if (event.kind !== "metric.snapshot") return [];
    const at = Date.parse(event.eventAt);
    if (at < startMs || at > endMs) return [];
    const parsed = canonicalMetricSnapshotSchema.safeParse(event.payload);
    return parsed.success ? [parsed.data] : [];
  });
  const first = points[0];
  const latest = points.at(-1);
  if (!first || !latest) return { samples: points.length };
  const countFields = [
    "room_impression_uv", "room_enter_uv", "product_impression_uv", "product_click_uv",
    "paid_order_count", "paid_buyer_count", "gross_paid_gmv_fen", "refund_gmv_fen", "ad_spend_fen", "net_paid_gmv_fen"
  ] as const;
  const metrics: CanonicalMetricSnapshot = {
    concurrent_viewers: latest.concurrent_viewers,
    current_product_id: latest.current_product_id,
    current_host_id: latest.current_host_id
  };
  for (const field of countFields) {
    const before = first[field];
    const after = latest[field];
    if (typeof before === "number" && typeof after === "number") metrics[field] = Math.max(0, after - before);
  }
  const roomImpressions = metrics.room_impression_uv ?? 0;
  const roomEnters = metrics.room_enter_uv ?? 0;
  const productImpressions = metrics.product_impression_uv ?? 0;
  const productClicks = metrics.product_click_uv ?? 0;
  const paidBuyers = metrics.paid_buyer_count ?? 0;
  const grossGmv = metrics.gross_paid_gmv_fen ?? 0;
  const netGmv = metrics.net_paid_gmv_fen ?? 0;
  const spend = metrics.ad_spend_fen ?? 0;
  if (roomImpressions > 0) metrics.room_entry_rate = roomEnters / roomImpressions;
  if (productImpressions > 0) metrics.product_click_rate = productClicks / productImpressions;
  if (productClicks > 0) metrics.click_to_paid_rate = paidBuyers / productClicks;
  if (spend > 0) {
    metrics.gross_roi = grossGmv / spend;
    metrics.net_roi = netGmv / spend;
  }
  return { metrics, samples: points.length };
}

function metricValue(metrics: CanonicalMetricSnapshot | undefined, metric: string): number | undefined {
  const value = metrics?.[metric as keyof CanonicalMetricSnapshot];
  return typeof value === "number" ? value : undefined;
}

function outcomeInterpretation(before: number | undefined, after: number | undefined): Exclude<AdviceOutcome["interpretation"], undefined> {
  if (before === undefined || after === undefined) return "样本不足";
  const tolerance = Math.max(Math.abs(before) * 0.05, 0.0001);
  if (after - before > tolerance) return "上升";
  if (before - after > tolerance) return "下降";
  return "无明显变化";
}

export class SessionService {
  private readonly replayControllers = new Map<string, AbortController>();
  private readonly replayTasks = new Map<string, Promise<void>>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  constructor(private readonly store: EventStore, private readonly bus: StateBus) {}

  async create(input: unknown): Promise<Session> {
    const parsed = createSessionSchema.parse(input);
    const session: Session = {
      id: randomUUID(), tenantId: "tenant-demo", name: parsed.name, scenario: parsed.scenario,
      seed: parsed.seed, includeCommentIntent: parsed.includeCommentIntent, status: "created", createdAt: new Date().toISOString()
    };
    return this.store.createSession(session);
  }

  async get(id: string): Promise<Session> {
    const session = await this.store.getSession(id);
    if (!session) throw new SessionNotFoundError(`场次不存在：${id}`);
    return session;
  }

  async start(id: string, speed: number): Promise<Session> {
    return this.withLifecycleLock(id, async () => {
      const session = await this.get(id);
      if (String(session.scenario) === "mvp_real_session_001") throw new ReadOnlySessionError("真实离线回放场次只读，请使用 MVP 专属回放入口");
      if (session.status === "completed") return session;
      if (session.status === "stopped") throw new InvalidLifecycleError("已停止场次不能再次开始");
      if (session.status === "running") {
        if (session.scenario !== "live_compass" && !this.replayTasks.has(id)) await this.launchReplay(session, speed);
        return session;
      }
      const running = await this.store.tryStartSession(id, new Date().toISOString());
      if (!running) return this.get(id);
      if (running.scenario !== "live_compass") await this.launchReplay(running, speed);
      return running;
    });
  }

  async stop(id: string): Promise<Session> {
    return this.withLifecycleLock(id, async () => {
      const session = await this.get(id);
      if (String(session.scenario) === "mvp_real_session_001") throw new ReadOnlySessionError("真实离线回放场次只读，请使用 MVP 专属回放入口");
      if (session.status === "stopped" || session.status === "completed") return session;
      this.replayControllers.get(id)?.abort();
      const stopped: Session = { ...session, status: "stopped", stoppedAt: new Date().toISOString() };
      await this.store.updateSession(stopped);
      await this.publishState(id);
      return stopped;
    });
  }

  async ingest(input: unknown): Promise<boolean> {
    const parsed = liveEventSchema.parse(input);
    return this.withLifecycleLock(parsed.sessionId, () => this.ingestLocked(parsed));
  }

  private async ingestLocked(parsed: LiveEvent, replaySignal?: AbortSignal): Promise<boolean> {
    if (replaySignal?.aborted) return false;
    const session = await this.get(parsed.sessionId);
    if (String(session.scenario) === "mvp_real_session_001") throw new ReadOnlySessionError("真实离线回放场次只读，不接受事件写入");
    if (String(session.scenario) === "live_compass" && session.status !== "running") throw new InvalidLifecycleError("真实直播已停止，不接受新的事件");
    if (parsed.tenantId !== session.tenantId) throw new InvalidEventScopeError(`事件 tenantId 与场次不一致：${parsed.tenantId}`);
    if (parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)) {
      const payload = parsed.payload as Record<string, unknown>;
      if (Object.hasOwn(payload, "tenantId") && payload.tenantId !== parsed.tenantId) throw new InvalidEventScopeError("payload.tenantId 与事件 tenantId 不一致");
      if (Object.hasOwn(payload, "sessionId") && payload.sessionId !== parsed.sessionId) throw new InvalidEventScopeError("payload.sessionId 与事件 sessionId 不一致");
    }
    const acceptedEvent: LiveEvent = { ...parsed, ingestedAt: new Date().toISOString() };
    const inserted = await this.store.appendEvent(acceptedEvent);
    if (inserted && session.scenario !== "live_compass" && parsed.source !== "system" && parsed.source !== "operator" && ANALYZABLE_KINDS.has(parsed.kind)) {
      await this.runPhase1Analysis(session, acceptedEvent);
    }
    await this.publishState(parsed.sessionId);
    return inserted;
  }

  async ingestBatch(inputs: unknown[]): Promise<{ accepted: number; duplicates: number }> {
    let accepted = 0;
    let duplicates = 0;
    for (const input of inputs) {
      if (await this.ingest(input)) accepted += 1;
      else duplicates += 1;
    }
    return { accepted, duplicates };
  }

  async state(id: string): Promise<SessionState> {
    const session = await this.get(id);
    const events = await this.store.listEvents(id);
    return this.projectState(session, events);
  }

  async advices(id: string): Promise<Pick<SessionState, "advices" | "ruleStatuses">> {
    const state = await this.state(id);
    return { advices: state.advices, ruleStatuses: state.ruleStatuses };
  }

  async review(id: string): Promise<Pick<SessionState, "session" | "detectedEvents" | "advices" | "feedback" | "executions" | "outcomes" | "ruleStatuses">> {
    const state = await this.state(id);
    return {
      session: state.session, detectedEvents: state.detectedEvents, advices: state.advices,
      feedback: state.feedback, executions: state.executions, outcomes: state.outcomes, ruleStatuses: state.ruleStatuses
    };
  }

  async recordFeedback(adviceId: string, input: { type: "seen" | "accepted" | "rejected"; operatorId: string; reason?: string | undefined }): Promise<AdviceProjection> {
    const sessionId = this.sessionIdFromAdviceId(adviceId);
    return this.withLifecycleLock(sessionId, async () => {
      const state = await this.state(sessionId);
      const projection = state.advices.find((item) => item.advice.id === adviceId);
      if (!projection) throw new AdviceNotFoundError(`建议不存在：${adviceId}`);
      const allowed = input.type === "seen"
        ? projection.status === "delivered"
        : projection.status === "seen";
      if (!allowed) throw new InvalidAdviceTransitionError(`建议状态 ${projection.status} 不能转为 ${input.type}`);
      const now = new Date().toISOString();
      const anchorEventAt = state.recentEvents.at(-1)?.eventAt ?? projection.advice.triggeredAt;
      await this.appendOperatorEvent(sessionId, projection.advice.tenantId, anchorEventAt, "advice.feedback", adviceFeedbackSchema.parse({
        id: randomUUID(), adviceId, operatorId: input.operatorId, type: input.type,
        ...(input.reason ? { reason: input.reason } : {}), createdAt: now
      }));
      await this.publishState(sessionId);
      return (await this.state(sessionId)).advices.find((item) => item.advice.id === adviceId)!;
    });
  }

  async recordExecution(adviceId: string, input: { status: AdviceExecution["status"]; operatorId: string; notes?: string | undefined }): Promise<AdviceProjection> {
    const sessionId = this.sessionIdFromAdviceId(adviceId);
    return this.withLifecycleLock(sessionId, async () => {
      const state = await this.state(sessionId);
      const projection = state.advices.find((item) => item.advice.id === adviceId);
      if (!projection) throw new AdviceNotFoundError(`建议不存在：${adviceId}`);
      const previous = projection.executions.at(-1)?.status;
      const allowed = projection.status === "accepted" && (
        (!previous && ["executing", "executed", "not_executed", "unknown"].includes(input.status))
        || (previous === "executing" && ["executed", "not_executed", "unknown"].includes(input.status))
      );
      if (!allowed) throw new InvalidAdviceTransitionError(`建议状态 ${projection.status}／执行状态 ${previous ?? "无"} 不能转为 ${input.status}`);
      const now = new Date().toISOString();
      const activeExecution = projection.executions.find((item) => item.status === "executing");
      const anchorEventAt = activeExecution?.anchorEventAt ?? state.recentEvents.at(-1)?.eventAt ?? projection.advice.triggeredAt;
      const firstStart = activeExecution?.startedAt;
      const execution = adviceExecutionSchema.parse({
        id: activeExecution?.id ?? randomUUID(), adviceId, operatorId: input.operatorId, status: input.status,
        createdAt: now, anchorEventAt,
        ...(["executing", "executed"].includes(input.status) ? { startedAt: firstStart ?? now } : {}),
        ...(input.status === "executed" ? { executedAt: now } : {}),
        ...(input.notes ? { notes: input.notes } : {})
      });
      await this.appendOperatorEvent(sessionId, projection.advice.tenantId, anchorEventAt, "advice.execution", execution);
      if (!activeExecution && ["executing", "executed"].includes(input.status)) {
        await this.appendPendingOutcomes(projection, execution, await this.store.listEvents(sessionId));
      }
      await this.publishState(sessionId);
      return (await this.state(sessionId)).advices.find((item) => item.advice.id === adviceId)!;
    });
  }

  async markConfounded(adviceId: string, input: { operatorId: string; reason: string }): Promise<AdviceProjection> {
    const sessionId = this.sessionIdFromAdviceId(adviceId);
    return this.withLifecycleLock(sessionId, async () => {
      const state = await this.state(sessionId);
      const projection = state.advices.find((item) => item.advice.id === adviceId);
      const execution = projection?.executions.find((entry) => entry.status === "executing")
        ?? projection?.executions.find((entry) => entry.status === "executed");
      if (!projection || !execution) throw new InvalidAdviceTransitionError("建议尚未开始执行，不能标记干扰");
      if (projection.outcomes.some((outcome) => outcome.observationStatus === "confounded" && outcome.operatorId)) {
        throw new InvalidAdviceTransitionError("该建议已由操作员标记明显干扰");
      }
      const latest = canonicalMetricSnapshotSchema.safeParse(state.latestMetrics);
      const now = new Date().toISOString();
      const latestLogicalEventAt = state.recentEvents.at(-1)?.eventAt ?? execution.anchorEventAt;
      for (const windowSec of EFFECT_WINDOWS) {
        const outcome = adviceOutcomeSchema.parse({
          id: randomUUID(), adviceId, executionId: execution.id, windowSec,
          metric: projection.advice.metricEvidence[0]?.metric ?? "product_click_rate",
          observationStatus: "confounded", observedAt: now, anchorEventAt: execution.anchorEventAt, operatorId: input.operatorId,
          currentProductId: latest.success ? latest.data.current_product_id ?? projection.advice.currentProductId : projection.advice.currentProductId,
          currentHostId: latest.success ? latest.data.current_host_id ?? projection.advice.currentHostId : projection.advice.currentHostId,
          trafficState: "unknown", productSwitched: false, trafficChanged: false, sampleSufficient: false,
          confounders: [`人工标注：${input.reason}`], interpretation: "明显干扰无法判断"
        });
        await this.appendOperatorEvent(sessionId, projection.advice.tenantId, latestLogicalEventAt, "advice.outcome", outcome);
      }
      await this.publishState(sessionId);
      return (await this.state(sessionId)).advices.find((item) => item.advice.id === adviceId)!;
    });
  }

  private projectState(session: Session, events: LiveEvent[]): SessionState {
    const metricEvents = events.filter((item) => item.kind === "metric.snapshot");
    const latestMetricEvent = metricEvents.at(-1);
    const latestMetrics = latestMetricEvent ? metricSnapshotSchema.parse(latestMetricEvent.payload) : null;
    const metricTrend = metricEvents.slice(-61).map((item) => ({ at: item.eventAt, values: metricSnapshotSchema.parse(item.payload) }));
    const transcripts = events.filter((item) => item.kind === "speech.final").map((item) => transcriptSegmentSchema.parse(item.payload)).slice(-40);
    const roundMap = new Map<string, ReturnType<typeof productRoundSchema.parse>>();
    for (const item of events) {
      if (item.kind !== "product.round.started" && item.kind !== "product.round.ended") continue;
      const round = productRoundSchema.parse(item.payload);
      roundMap.set(round.id, { ...(roundMap.get(round.id) ?? {}), ...round });
    }
    const healthMap = new Map<string, ReturnType<typeof sourceHealthSchema.parse>>();
    for (const item of events) if (item.kind === "source.health") {
      const health = sourceHealthSchema.parse(item.payload);
      healthMap.set(health.sourceId, health);
    }
    const detectedEvents = events.filter((item) => item.kind === "rule.triggered").map((item) => detectedEventSchema.parse(item.payload));
    const deliveries = events.filter((item) => item.kind === "advice.delivery").map((event) => ({ event, payload: adviceDeliverySchema.parse(event.payload) }));
    const feedback = events.filter((item) => item.kind === "advice.feedback").map((item) => adviceFeedbackSchema.parse(item.payload));
    const executions = events.filter((item) => item.kind === "advice.execution").map((item) => adviceExecutionSchema.parse(item.payload));
    const outcomes = events.filter((item) => item.kind === "advice.outcome").map((item) => adviceOutcomeSchema.parse(item.payload));
    const ruleStatuses = events.filter((item) => item.kind === "rule.status").map((item) => ruleStatusSchema.parse(item.payload))
      .sort((left, right) => Date.parse(left.evaluatedAt) - Date.parse(right.evaluatedAt));
    const logicalNow = events.at(-1)?.eventAt ?? session.createdAt;
    const advices = events.filter((item) => item.kind === "advice.created").map((item): AdviceProjection => {
      const advice = adviceSchema.parse(item.payload);
      const adviceDelivery = deliveries.find((delivery) => delivery.payload.adviceId === advice.id);
      const adviceFeedback = feedback.filter((entry) => entry.adviceId === advice.id)
        .sort((left, right) => compareAuditStage(left, right, (entry) => entry.type === "seen" ? 0 : 1));
      const adviceExecutions = executions.filter((entry) => entry.adviceId === advice.id)
        .sort((left, right) => compareAuditStage(left, right, (entry) => entry.status === "executing" ? 0 : 1));
      const latestOutcomeByWindow = new Map<number, AdviceOutcome>();
      for (const entry of outcomes.filter((outcome) => outcome.adviceId === advice.id)) {
        const current = latestOutcomeByWindow.get(entry.windowSec);
        const entryFinal = entry.observationStatus !== "pending";
        const currentFinal = current?.observationStatus !== "pending";
        if (!current || (entryFinal && !currentFinal) || (entryFinal === currentFinal && Date.parse(entry.observedAt) >= Date.parse(current.observedAt))) {
          latestOutcomeByWindow.set(entry.windowSec, entry);
        }
      }
      const projectedOutcomes = [...latestOutcomeByWindow.values()].sort((left, right) => left.windowSec - right.windowSec);
      const lastFeedback = adviceFeedback.at(-1);
      let status: AdviceProjection["status"] = adviceDelivery ? "delivered" : "generated";
      if (lastFeedback) status = lastFeedback.type;
      if (["generated", "delivered", "seen"].includes(status) && Date.parse(logicalNow) >= Date.parse(advice.expiresAt)) status = "expired";
      const seenAt = adviceFeedback.find((entry) => entry.type === "seen")?.createdAt;
      const acceptedAt = adviceFeedback.find((entry) => entry.type === "accepted")?.createdAt;
      const rejectedAt = adviceFeedback.find((entry) => entry.type === "rejected")?.createdAt;
      const executingAt = adviceExecutions.find((entry) => entry.status === "executing")?.createdAt;
      const executedAt = adviceExecutions.find((entry) => entry.status === "executed")?.createdAt;
      return {
        advice, status,
        ...(adviceDelivery ? { deliveredAt: adviceDelivery.event.ingestedAt } : {}),
        feedback: adviceFeedback, executions: adviceExecutions, outcomes: projectedOutcomes,
        timeline: {
          generatedAt: item.ingestedAt,
          ...(adviceDelivery ? { deliveredAt: adviceDelivery.event.ingestedAt } : {}),
          ...(seenAt ? { seenAt, generatedToSeenSec: secondsBetween(item.ingestedAt, seenAt)! } : {}),
          ...(acceptedAt ? { acceptedAt, seenToAcceptedSec: secondsBetween(seenAt, acceptedAt)! } : {}),
          ...(rejectedAt ? { rejectedAt } : {}),
          ...(executingAt ? { executingAt, acceptedToExecutingSec: secondsBetween(acceptedAt, executingAt)! } : {}),
          ...(executedAt ? { executedAt, acceptedToExecutedSec: secondsBetween(acceptedAt, executedAt)! } : {})
        }
      };
    });
    const latestTimestamp = [session.createdAt, session.startedAt, session.stoppedAt, ...events.map((event) => event.ingestedAt)]
      .filter((value): value is string => Boolean(value)).sort((left, right) => Date.parse(right) - Date.parse(left))[0]!;
    return {
      session, latestMetrics, metricTrend, transcripts, productRounds: [...roundMap.values()],
      detectedEvents, advices, feedback, executions, outcomes, ruleStatuses,
      recentEvents: events.slice(-80), sourceHealth: [...healthMap.values()], eventCount: events.length, updatedAt: latestTimestamp
    };
  }

  private async runPhase1Analysis(session: Session, anchor: LiveEvent): Promise<void> {
    let events = await this.store.listEvents(session.id);
    if (anchor.kind === "metric.snapshot") {
      await this.settleEligibleOutcomes(session, anchor, events, false);
      events = await this.store.listEvents(session.id);
      const analysis = analyzeRules(events);
      for (const status of analysis.ruleStatuses) {
        const previousStatus = [...events].reverse().find((event) => event.kind === "rule.status"
          && (event.payload as { ruleId?: string }).ruleId === status.ruleId);
        if ((previousStatus?.payload as { status?: string } | undefined)?.status !== status.status) {
          await this.appendSystemEvent(session, anchor, "rule.status", status, `rule-status:${status.id}:${status.status}`);
        }
      }
      for (let index = 0; index < analysis.detectedEvents.length; index += 1) {
        const detected = analysis.detectedEvents[index]!;
        const advice = analysis.advices[index]!;
        await this.appendSystemEvent(session, anchor, "rule.triggered", detected, `rule:${detected.id}`);
        await this.appendSystemEvent(session, anchor, "advice.created", advice, `advice:${advice.id}:created`);
        await this.appendSystemEvent(session, anchor, "advice.delivery", {
          id: `${advice.id}:delivery`, adviceId: advice.id, deliveredAt: new Date().toISOString()
        }, `advice:${advice.id}:delivery`);
      }
    }
    if (anchor.kind === "session.marker" && (anchor.payload as { marker?: string }).marker === "completed") {
      await this.settleEligibleOutcomes(session, anchor, await this.store.listEvents(session.id), true);
    }
  }

  private async appendPendingOutcomes(projection: AdviceProjection, execution: AdviceExecution, events: LiveEvent[]): Promise<void> {
    const beforeAnchor = execution.anchorEventAt;
    const latest = canonicalMetricSnapshotSchema.safeParse(projection.advice.metricEvidence.length ? events.filter((event) => event.kind === "metric.snapshot").at(-1)?.payload : undefined);
    for (const windowSec of EFFECT_WINDOWS) {
      const before = windowSummary(events, new Date(Date.parse(beforeAnchor) - windowSec * 1000).toISOString(), beforeAnchor);
      const outcome = adviceOutcomeSchema.parse({
        id: `${execution.id}:outcome:${windowSec}:pending`, adviceId: projection.advice.id, executionId: execution.id,
        windowSec, metric: projection.advice.metricEvidence[0]?.metric ?? "product_click_rate",
        observationStatus: "pending", observedAt: execution.createdAt, anchorEventAt: beforeAnchor,
        currentProductId: latest.success ? latest.data.current_product_id ?? projection.advice.currentProductId : projection.advice.currentProductId,
        currentHostId: latest.success ? latest.data.current_host_id ?? projection.advice.currentHostId : projection.advice.currentHostId,
        trafficState: "unknown", productSwitched: false, trafficChanged: false,
        sampleSufficient: before.samples >= 3, ...(before.metrics ? { beforeMetrics: before.metrics } : {}),
        confounders: []
      });
      await this.appendSystemEvent(await this.get(projection.advice.sessionId), {
        schemaVersion: 1, eventId: execution.id, tenantId: projection.advice.tenantId,
        sessionId: projection.advice.sessionId, eventAt: execution.anchorEventAt, capturedAt: execution.createdAt,
        ingestedAt: execution.createdAt, source: "operator", kind: "advice.execution", provisional: false, payload: execution
      }, "advice.outcome", outcome, outcome.id);
    }
  }

  private async settleEligibleOutcomes(session: Session, anchor: LiveEvent, events: LiveEvent[], completing: boolean): Promise<void> {
    const state = this.projectState(session, events);
    for (const projection of state.advices) {
      const execution = projection.executions.find((item) => item.status === "executing")
        ?? projection.executions.find((item) => item.status === "executed");
      if (!execution) continue;
      for (const windowSec of EFFECT_WINDOWS) {
        const existingFinal = projection.outcomes.find((item) => item.executionId === execution.id && item.windowSec === windowSec && item.observationStatus !== "pending");
        if (existingFinal) continue;
        const targetAt = new Date(Date.parse(execution.anchorEventAt) + windowSec * 1000).toISOString();
        const elapsed = Date.parse(anchor.eventAt) >= Date.parse(targetAt);
        if (!elapsed && !completing) continue;
        const before = windowSummary(events, new Date(Date.parse(execution.anchorEventAt) - windowSec * 1000).toISOString(), execution.anchorEventAt);
        const afterEnd = elapsed ? targetAt : anchor.eventAt;
        const after = windowSummary(events, execution.anchorEventAt, afterEnd);
        const intervening = events.filter((event) => Date.parse(event.eventAt) > Date.parse(execution.anchorEventAt) && Date.parse(event.eventAt) <= Date.parse(afterEnd));
        const productSwitched = intervening.some((event) => event.kind === "product.changed");
        const trafficChanges = intervening.filter((event) => event.kind === "traffic.changed" && (event.payload as { reason?: string }).reason !== "baseline");
        const trafficChanged = trafficChanges.length > 0;
        const latestTraffic = [...events].reverse().find((event) => event.kind === "traffic.changed" && Date.parse(event.eventAt) <= Date.parse(afterEnd));
        const trafficState = (latestTraffic?.payload as { reason?: "baseline" | "scale_up" | "scale_down" } | undefined)?.reason ?? "unknown";
        const sampleSufficient = elapsed && before.samples >= 3 && after.samples >= 3;
        const confounded = productSwitched || trafficChanged;
        const metric = projection.advice.metricEvidence[0]?.metric ?? "product_click_rate";
        const beforeValue = metricValue(before.metrics, metric);
        const afterValue = metricValue(after.metrics, metric);
        const interpretation = confounded ? "明显干扰无法判断" : sampleSufficient ? outcomeInterpretation(beforeValue, afterValue) : "样本不足";
        const observationStatus = confounded ? "confounded" : sampleSufficient ? "observed" : "insufficient_sample";
        const outcome = adviceOutcomeSchema.parse({
          id: `${execution.id}:outcome:${windowSec}:${observationStatus}`, adviceId: projection.advice.id,
          executionId: execution.id, windowSec, metric, observationStatus, observedAt: anchor.eventAt,
          anchorEventAt: execution.anchorEventAt,
          currentProductId: after.metrics?.current_product_id ?? projection.advice.currentProductId,
          currentHostId: after.metrics?.current_host_id ?? projection.advice.currentHostId,
          trafficState, productSwitched, trafficChanged, sampleSufficient,
          ...(before.metrics ? { beforeMetrics: before.metrics } : {}), ...(after.metrics ? { afterMetrics: after.metrics } : {}),
          ...(beforeValue !== undefined ? { beforeValue } : {}), ...(afterValue !== undefined ? { afterValue } : {}),
          ...(beforeValue !== undefined && afterValue !== undefined ? {
            absoluteChange: afterValue - beforeValue,
            ...(beforeValue !== 0 ? { relativeChange: (afterValue - beforeValue) / Math.abs(beforeValue) } : {})
          } : {}),
          sampleSize: after.samples,
          confounders: [...(productSwitched ? ["观察窗口内发生商品切换"] : []), ...(trafficChanged ? ["观察窗口内发生明显流量调整"] : [])],
          interpretation
        });
        await this.appendSystemEvent(session, anchor, "advice.outcome", outcome, outcome.id);
      }
    }
  }

  private async appendSystemEvent(session: Session, anchor: LiveEvent, kind: LiveEvent["kind"], payload: unknown, stableKey: string): Promise<boolean> {
    const stableSuffix = createHash("sha256").update(stableKey).digest("hex").slice(0, 32);
    const eventId = `${session.id}:system:${stableSuffix}`;
    const generated = liveEventSchema.parse({
      schemaVersion: 1, eventId, dedupeKey: eventId,
      tenantId: session.tenantId, sessionId: session.id, eventAt: anchor.eventAt,
      capturedAt: anchor.capturedAt, ingestedAt: new Date().toISOString(), source: "system", kind,
      provisional: false, payload, metadata: { generatedBy: "phase1-rules" }
    });
    return this.store.appendEvent(generated);
  }

  private async appendOperatorEvent(sessionId: string, tenantId: string, anchorEventAt: string, kind: LiveEvent["kind"], payload: unknown): Promise<void> {
    const now = new Date().toISOString();
    const event = liveEventSchema.parse({
      schemaVersion: 1, eventId: randomUUID(), tenantId, sessionId, eventAt: anchorEventAt,
      capturedAt: now, ingestedAt: now, source: "operator", kind, provisional: false, payload
    });
    await this.store.appendEvent(event);
  }

  private sessionIdFromAdviceId(adviceId: string): string {
    const marker = adviceId.indexOf(":R00");
    if (marker <= 0) throw new AdviceNotFoundError(`建议 ID 无法定位场次：${adviceId}`);
    return adviceId.slice(0, marker);
  }

  async subscribe(id: string, listener: (state: SessionState) => void): Promise<() => Promise<void>> {
    await this.get(id);
    return this.bus.subscribe(id, (state) => {
      if (!isMvpStatePayload(state)) listener(state);
    });
  }

  private async publishState(id: string): Promise<void> {
    try { await this.bus.publish(id, await this.state(id)); }
    catch { console.error("state_publish_failed", { sessionId: id, message: "实时广播失败，权威状态已持久化" }); }
  }

  private async launchReplay(running: Session, speed: number): Promise<void> {
    const persistedEvents = await this.store.listEvents(running.id);
    const persistedEventIds = new Set(persistedEvents.map((event) => event.eventId));
    const persistedDedupeKeys = new Set(persistedEvents.flatMap((event) => event.dedupeKey ? [event.dedupeKey] : []));
    const events = generateSimulation({
      tenantId: running.tenantId, sessionId: running.id, scenario: running.scenario,
      seed: running.seed, includeCommentIntent: running.includeCommentIntent
    }).filter((event) => !persistedEventIds.has(event.eventId) && (!event.dedupeKey || !persistedDedupeKeys.has(event.dedupeKey)));
    const controller = new AbortController();
    this.replayControllers.set(running.id, controller);
    const replayTask = replayEvents(events, speed, async (next) => {
      await this.withLifecycleLock(running.id, () => this.ingestLocked(liveEventSchema.parse(next), controller.signal));
    }, controller.signal);
    this.replayTasks.set(running.id, replayTask);
    replayTask.then(
      () => { void this.finalizeReplay(running.id, controller, replayTask, true); },
      () => { console.error("replay_failed", { sessionId: running.id, message: "确定性回放失败" }); void this.finalizeReplay(running.id, controller, replayTask, false); }
    );
  }

  private async finalizeReplay(id: string, controller: AbortController, replayTask: Promise<void>, completed: boolean): Promise<void> {
    try {
      await this.withLifecycleLock(id, async () => {
        if (this.replayTasks.get(id) !== replayTask) return;
        this.replayTasks.delete(id);
        if (this.replayControllers.get(id) === controller) this.replayControllers.delete(id);
        if (!completed || controller.signal.aborted) return;
        const current = await this.get(id);
        if (current.status !== "running") return;
        await this.store.updateSession({ ...current, status: "completed", stoppedAt: new Date().toISOString() });
        await this.publishState(id);
      });
    } catch { console.error("replay_finalize_failed", { sessionId: id, message: "回放终态持久化失败" }); }
  }

  private async withLifecycleLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.lifecycleTails.set(id, tail);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.lifecycleTails.get(id) === tail) this.lifecycleTails.delete(id);
    }
  }

  async close(): Promise<void> {
    for (const controller of this.replayControllers.values()) controller.abort();
    await Promise.allSettled(this.replayTasks.values());
    await Promise.allSettled(this.lifecycleTails.values());
    await Promise.all([this.store.close(), this.bus.close()]);
  }
}
