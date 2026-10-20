import {
  liveCompassActionSchema,
  liveCompassMetricSnapshotSchema,
  qianchuanMetricSnapshotSchema,
  transcriptSegmentSchema,
  type LiveCompassAction,
  type LiveEvent,
  type MvpAction,
  type MvpMetricPoint,
  type MvpStateId
} from "@live-growth/contracts";
import { LivePointMapper } from "./live-point-mapper";
import { LiveStateEngine, STATE_NAMES, type LiveStateDecision, type LiveStateEngineConfig } from "./live-state-engine";

export type LivePilotEnginePoint = {
  at: string;
  point: MvpMetricPoint;
  decision: LiveStateDecision;
};

export type LivePilotEngineReplay = {
  points: LivePilotEnginePoint[];
  lastAction: MvpAction | null;
};

export function engineIssueKey(action: MvpAction): string {
  return `engine:${action.state}:${action.actionKey}`;
}

export function isPaymentGapIssue(issueKey: string): boolean {
  return issueKey.startsWith("click-pay-zero:") || issueKey.startsWith("engine:S4:");
}

export function liveCompassActionFromMvp(action: MvpAction, evidenceEventIds: string[]): LiveCompassAction {
  const kind = action.actionKey === "continue_observing" ? "review" : "action";
  return liveCompassActionSchema.parse({
    id: action.id,
    createdAt: action.createdAt,
    kind,
    title: STATE_NAMES[action.state],
    message: action.coreInstruction,
    reason: action.why,
    evidenceEventIds: evidenceEventIds.slice(0, 8),
    issueKey: engineIssueKey(action),
    confidence: action.priority === "critical" || action.priority === "high" ? "high" : action.priority === "medium" ? "medium" : "low"
  });
}

function observeEvent(mapper: LivePointMapper, event: LiveEvent): void {
  if (event.kind === "live.compass.metric") {
    const parsed = liveCompassMetricSnapshotSchema.safeParse(event.payload);
    if (parsed.success) mapper.observeCompass(parsed.data);
    return;
  }
  if (event.kind === "live.qianchuan.metric") {
    const parsed = qianchuanMetricSnapshotSchema.safeParse(event.payload);
    if (parsed.success) mapper.observeQianchuan(parsed.data);
    return;
  }
  if (event.kind === "speech.final") {
    const parsed = transcriptSegmentSchema.safeParse(event.payload);
    if (parsed.success) mapper.observeSpeech(event.eventAt, parsed.data.text);
  }
}

/**
 * 按事件逻辑时间重放罗盘／千川／话术，喂给七状态引擎。确定性、可重启。
 * 核心房间信号不齐时 dataComplete=false，引擎不判断，不再走点击-支付启发式。
 */
export function replayLivePilotEngine(
  events: readonly LiveEvent[],
  config?: LiveStateEngineConfig
): LivePilotEngineReplay {
  const mapper = new LivePointMapper();
  const engine = new LiveStateEngine([], config);
  const relevant = events
    .filter((event) => event.kind === "live.compass.metric" || event.kind === "live.qianchuan.metric" || event.kind === "speech.final")
    .slice()
    .sort((left, right) => Date.parse(left.eventAt) - Date.parse(right.eventAt) || left.eventId.localeCompare(right.eventId));
  const points: LivePilotEnginePoint[] = [];
  let lastAction: MvpAction | null = null;
  for (const event of relevant) {
    observeEvent(mapper, event);
    if (event.kind !== "live.compass.metric") continue;
    const point = mapper.pointAt(event.eventAt);
    if (!point) continue;
    const result = engine.process(point);
    points.push({ at: event.eventAt, point, decision: result.decision });
    if (result.action) lastAction = result.action;
  }
  return { points, lastAction };
}

export function stateShareInWindow(
  points: readonly LivePilotEnginePoint[],
  windowStartAt: string,
  windowEndAt: string
): Record<MvpStateId, number> {
  const startMs = Date.parse(windowStartAt);
  const endMs = Date.parse(windowEndAt);
  const totals: Record<MvpStateId, number> = { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S6: 0 };
  const inWindow = points.filter((item) => {
    const at = Date.parse(item.at);
    return at >= startMs && at < endMs;
  });
  if (inWindow.length === 0) return totals;
  let confirmedMs = 0;
  for (let index = 0; index < inWindow.length; index += 1) {
    const current = inWindow[index]!;
    const nextAt = inWindow[index + 1] ? Date.parse(inWindow[index + 1]!.at) : endMs;
    const duration = Math.max(0, Math.min(endMs, nextAt) - Date.parse(current.at));
    const state = current.decision.state;
    if (!state || current.decision.preheat || current.decision.stale) continue;
    totals[state] += duration;
    confirmedMs += duration;
  }
  if (confirmedMs <= 0) return totals;
  for (const key of Object.keys(totals) as MvpStateId[]) totals[key] = totals[key]! / confirmedMs;
  return totals;
}

export function speechPresentInWindow(
  points: readonly LivePilotEnginePoint[],
  windowStartAt: string,
  windowEndAt: string
): string[] {
  const startMs = Date.parse(windowStartAt);
  const endMs = Date.parse(windowEndAt);
  const present = new Set<string>();
  for (const item of points) {
    const at = Date.parse(item.at);
    if (at < startMs || at >= endMs) continue;
    for (const [key, status] of Object.entries(item.point.speechCoverage)) {
      if (status === "present") present.add(key);
    }
  }
  return [...present];
}
