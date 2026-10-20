import { transitionAudio, type AudioEvent } from "./audio.js";
import { audioCaptureAllowedRoute } from "./allowlist.js";
import type { AudioStatus, MarkerCode, ProbeSessionExport, ProbeSessionIdentity } from "./types.js";

type AudioSession = ProbeSessionExport["session"];

export interface AudioStatusStore {
  load(): Promise<AudioSession | null>;
  setAudio(audio: AudioStatus, observedAt: string, expectedIdentity: ProbeSessionIdentity): Promise<AudioSession | null>;
  addMarker(code: MarkerCode, markerId: string, createdAt: string, expectedIdentity: ProbeSessionIdentity): Promise<AudioSession | null>;
}

export interface AudioStatusResult {
  ok: boolean;
  session?: AudioSession | null;
  error?: string;
}

function observedAtFrom(message: Record<string, unknown>, fallback: string): string {
  return typeof message.observedAt === "string" ? message.observedAt : fallback;
}

export async function applyAudioStatusMessage(store: AudioStatusStore, message: Record<string, unknown>, fallbackObservedAt: string, expectedIdentity: ProbeSessionIdentity): Promise<AudioStatusResult> {
  if (!audioCaptureAllowedRoute(expectedIdentity.routeId) || (message.routeId !== undefined && message.routeId !== expectedIdentity.routeId)) return { ok: false, error: "音频状态所属页面合同已失效" };
  const session = await store.load();
  if (!session) return { ok: false, error: "音频状态没有对应会话" };
  const eventType = message.event;
  const observedAt = observedAtFrom(message, fallbackObservedAt);
  let event: AudioEvent;
  if (eventType === "track_started") {
    event = { type: "track_started", observedAt, trackCount: typeof message.trackCount === "number" ? message.trackCount : 0 };
  }
  else if (eventType === "energy") event = { type: "energy", observedAt, band: message.band === "silent" || message.band === "low" ? message.band : "normal", activeSeconds: typeof message.activeSeconds === "number" ? message.activeSeconds : 0 };
  else if (eventType === "mute") event = { type: "mute", observedAt };
  else if (eventType === "unmute") event = { type: "unmute", observedAt };
  else if (eventType === "offline") event = { type: "network_lost", observedAt };
  else if (eventType === "online") event = { type: "network_online", observedAt };
  else if (eventType === "tab_switched") event = { type: "tab_switched", observedAt };
  else if (eventType === "stale") event = { type: "refreshed", observedAt };
  else if (eventType === "track_ended") event = { type: "track_ended", observedAt };
  else event = { type: "error", observedAt };
  const audio = transitionAudio(session.audio, event);
  const updated = await store.setAudio(audio, observedAt, expectedIdentity);
  if (!updated) return { ok: false, error: "音频状态所属会话已失效" };
  if (eventType === "offline" || eventType === "online") {
    const code = eventType === "offline" ? "network_offline" : "network_online";
    const marked = await store.addMarker(code, `system-${code}-${observedAt}`, observedAt, expectedIdentity);
    if (!marked) return { ok: false, session: updated, error: "音频状态所属会话已失效" };
    return { ok: true, session: marked };
  }
  return { ok: true, session: updated };
}

export async function recordAudioRefresh(store: AudioStatusStore, observedAt: string, expectedIdentity: ProbeSessionIdentity): Promise<AudioStatusResult> {
  const session = await store.load();
  if (!session) return { ok: false, error: "音频状态没有对应会话" };
  const audio = transitionAudio(session.audio, { type: "refreshed", observedAt });
  const updated = await store.setAudio(audio, observedAt, expectedIdentity);
  if (!updated) return { ok: false, error: "音频状态所属会话已失效" };
  const marked = await store.addMarker("refresh_observed", `system-refresh-${observedAt}`, observedAt, expectedIdentity);
  if (!marked) return { ok: false, session: updated, error: "音频状态所属会话已失效" };
  return { ok: true, session: marked };
}
