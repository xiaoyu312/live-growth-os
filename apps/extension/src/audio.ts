import type { AudioLifecycle, AudioReasonCode, AudioStatus } from "./types.js";

export type AudioEvent =
  | { type: "request"; observedAt: string }
  | { type: "authorized"; observedAt: string; trackCount: number }
  | { type: "track_started"; observedAt: string; trackCount: number }
  | { type: "energy"; observedAt: string; band: "silent" | "low" | "normal"; activeSeconds: number }
  | { type: "mute"; observedAt: string }
  | { type: "unmute"; observedAt: string }
  | { type: "tab_switched"; observedAt: string }
  | { type: "refreshed"; observedAt: string }
  | { type: "reconnected"; observedAt: string }
  | { type: "network_lost"; observedAt: string }
  | { type: "network_online"; observedAt: string }
  | { type: "track_ended"; observedAt: string }
  | { type: "error"; observedAt: string }
  | { type: "stop"; observedAt: string };

export function initialAudioStatus(observedAt = "1970-01-01T00:00:00.000Z"): AudioStatus {
  return { captureLifecycle: "idle", networkStatus: "unknown", observedAt, trackCount: 0, muted: false, energyBand: "unknown", activeSeconds: 0, userPlayback: "unknown", reason: "not_started", lastRefreshObservedAt: null, lastNetworkChangedAt: null, needsUserRestart: false };
}

function status(captureLifecycle: AudioLifecycle, observedAt: string, current: AudioStatus, reason: AudioReasonCode, needsUserRestart = current.needsUserRestart): AudioStatus {
  return { ...current, captureLifecycle, observedAt, reason, needsUserRestart, userPlayback: captureLifecycle === "active" || captureLifecycle === "muted" || captureLifecycle === "authorized" ? "preserved" : current.userPlayback };
}

export function transitionAudio(current: AudioStatus, event: AudioEvent): AudioStatus {
  // Once the user explicitly stops capture, late offscreen callbacks must not
  // resurrect the audio state. A fresh user request is the only restart gate.
  if (current.captureLifecycle === "stopped" && event.type !== "request") return current;
  switch (event.type) {
    case "request": return status("requesting", event.observedAt, current, "awaiting_user_authorization");
    case "authorized": return { ...status("authorized", event.observedAt, current, "tab_audio_authorized"), trackCount: Math.max(0, Math.trunc(event.trackCount)) };
    case "track_started": return { ...status("active", event.observedAt, current, current.captureLifecycle === "offline" ? "track_reconnected" : "track_continuous", false), trackCount: Math.max(0, Math.trunc(event.trackCount)) };
    case "energy": {
      return { ...status(current.captureLifecycle, event.observedAt, current, "energy_observed"), energyBand: event.band, activeSeconds: Math.max(current.activeSeconds, Math.trunc(event.activeSeconds)), userPlayback: current.userPlayback };
    }
    case "mute": return current.captureLifecycle === "active" || current.captureLifecycle === "muted" ? { ...status("muted", event.observedAt, current, "muted"), muted: true } : { ...current, observedAt: event.observedAt, reason: "muted" };
    case "unmute": return current.captureLifecycle === "muted" ? { ...status("active", event.observedAt, current, "unmuted"), muted: false } : { ...current, observedAt: event.observedAt, reason: "unmuted" };
    case "tab_switched": return { ...current, observedAt: event.observedAt, reason: "tab_switched_observed" };
    case "refreshed": return { ...current, observedAt: event.observedAt, reason: "refresh_observed", lastRefreshObservedAt: event.observedAt };
    case "reconnected": return { ...current, observedAt: event.observedAt };
    case "network_lost": return { ...current, observedAt: event.observedAt, reason: "network_offline_observed", networkStatus: "offline", lastNetworkChangedAt: event.observedAt };
    case "network_online": return { ...current, observedAt: event.observedAt, reason: "network_online_observed", networkStatus: "online", lastNetworkChangedAt: event.observedAt };
    case "track_ended": return status("offline", event.observedAt, current, "track_ended_needs_restart", true);
    case "error": return status("offline", event.observedAt, current, "audio_error_needs_restart", true);
    case "stop": return status("stopped", event.observedAt, current, "user_stopped", false);
  }
}

export function energyBandFromRms(rms: number): "silent" | "low" | "normal" {
  if (!Number.isFinite(rms) || rms < 0.01) return "silent";
  if (rms < 0.08) return "low";
  return "normal";
}
