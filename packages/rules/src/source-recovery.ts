import type { SourceGroupStatus } from "@live-growth/contracts";

export const RECOVERY_COOLDOWN_MS = 120_000;
export const RECOVERY_MAX_ATTEMPTS = 3;
export const SOURCE_HEALTH_TICK_MS = 15_000;

export const QIANCHUAN_RECOVER_PROMPT = "千川部分数据已停止更新。可一键刷新千川页面，不会中断罗盘音频和转写。";
export const QIANCHUAN_RECOVER_BUTTON = "刷新千川页面";
export const QIANCHUAN_RECOVERED = "千川数据已恢复";
export const COMPASS_RECOVER_PROMPT = "罗盘数据已停止更新。刷新会暂时中断音频和转写，刷新后需要重新授权音频。";
export const COMPASS_RECOVER_BUTTON = "刷新并重新连接";

export type RecoveryAction = "none" | "rebuild_observer" | "prompt_reload" | "execute_reload" | "blocked";

export type RecoveryDecision = {
  action: RecoveryAction;
  reason: string;
  source: "qianchuan" | "compass";
  stopAudioFirst: boolean;
  autoRestartAudio: boolean;
  createNewSession: boolean;
  stopCompassAudio: boolean;
};

export type RecoveryDecisionInput = {
  source: "qianchuan" | "compass";
  worstBusinessStatus: SourceGroupStatus;
  allowlistStatus: "allowed" | "login" | "blocked";
  debuggerAttached: boolean;
  userConfirmed: boolean;
  lockHeld: boolean;
  lastAttemptAt?: number;
  attemptCount: number;
  alreadyReloadedThisEpisode: boolean;
  swGenerationMatches: boolean;
  nowMs: number;
};

export type RecoveryLock = {
  tabId: number;
  held: boolean;
  attemptCount: number;
  lastAttemptAt?: number;
  reloadedThisEpisode: boolean;
};

export function createRecoveryLock(tabId: number): RecoveryLock {
  return { tabId, held: false, attemptCount: 0, reloadedThisEpisode: false };
}

export function tryAcquireRecoveryLock(lock: RecoveryLock, nowMs: number): boolean {
  if (lock.held) return false;
  if (lock.lastAttemptAt !== undefined && nowMs - lock.lastAttemptAt < RECOVERY_COOLDOWN_MS) return false;
  if (lock.attemptCount >= RECOVERY_MAX_ATTEMPTS) return false;
  lock.held = true;
  return true;
}

export function releaseRecoveryLock(lock: RecoveryLock): void {
  lock.held = false;
}

export function noteReloadAttempt(lock: RecoveryLock, nowMs: number): void {
  lock.attemptCount += 1;
  lock.lastAttemptAt = nowMs;
  lock.reloadedThisEpisode = true;
}

export function swRestartResumesPendingAutoReload(): false {
  return false;
}

export function qianchuanReloadStopsCompassAudio(): false {
  return false;
}

export function compassReloadAutoRestartsAudio(): false {
  return false;
}

export function compassReloadRequiresConfirm(userConfirmed: boolean): boolean {
  return userConfirmed === true;
}

export function reloadSessionPolicy(): {
  createNewSession: false;
  reattachExisting: true;
  stopCompassAudioOnQianchuanReload: false;
  autoRestartAudioAfterCompassReload: false;
} {
  return {
    createNewSession: false,
    reattachExisting: true,
    stopCompassAudioOnQianchuanReload: false,
    autoRestartAudioAfterCompassReload: false
  };
}

export function decideSourceRecovery(input: RecoveryDecisionInput): RecoveryDecision {
  const policy = reloadSessionPolicy();
  const base = {
    source: input.source,
    stopAudioFirst: input.source === "compass",
    autoRestartAudio: false,
    createNewSession: policy.createNewSession,
    stopCompassAudio: input.source === "qianchuan" ? policy.stopCompassAudioOnQianchuanReload : input.source === "compass"
  };
  if (input.allowlistStatus === "login") {
    return { ...base, action: "blocked", reason: "login" };
  }
  if (input.allowlistStatus === "blocked") {
    return { ...base, action: "blocked", reason: "left_allowlist" };
  }
  if (!input.swGenerationMatches) {
    return { ...base, action: "blocked", reason: "sw_restart" };
  }
  if (input.lockHeld) {
    return { ...base, action: "blocked", reason: "lock" };
  }
  if (input.attemptCount >= RECOVERY_MAX_ATTEMPTS) {
    return { ...base, action: "blocked", reason: "max_attempts" };
  }
  if (input.lastAttemptAt !== undefined && input.nowMs - input.lastAttemptAt < RECOVERY_COOLDOWN_MS) {
    return { ...base, action: "blocked", reason: "cooldown" };
  }
  if (input.worstBusinessStatus === "suspected_stall") {
    return { ...base, action: "rebuild_observer", reason: "l1_rebuild" };
  }
  if (input.worstBusinessStatus !== "stalled") {
    return { ...base, action: "none", reason: "healthy_or_unknown" };
  }
  if (input.alreadyReloadedThisEpisode && !input.userConfirmed) {
    return { ...base, action: "prompt_reload", reason: "human_after_reload" };
  }
  if (!input.userConfirmed) {
    return { ...base, action: "prompt_reload", reason: "await_confirm" };
  }
  if (input.source === "compass" && !compassReloadRequiresConfirm(input.userConfirmed)) {
    return { ...base, action: "prompt_reload", reason: "compass_confirm_required" };
  }
  return { ...base, action: "execute_reload", reason: "user_confirmed_reload" };
}

export function worstBusinessStatus(statuses: readonly SourceGroupStatus[]): SourceGroupStatus {
  if (statuses.includes("stalled")) return "stalled";
  if (statuses.includes("suspected_stall")) return "suspected_stall";
  if (statuses.includes("recovering")) return "recovering";
  if (statuses.includes("login_required")) return "login_required";
  if (statuses.includes("offline")) return "offline";
  if (statuses.includes("recovered")) return "recovered";
  if (statuses.includes("fresh")) return "fresh";
  return "unknown";
}
