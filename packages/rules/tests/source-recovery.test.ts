import { describe, expect, it } from "vitest";
import {
  COMPASS_RECOVER_BUTTON,
  COMPASS_RECOVER_PROMPT,
  QIANCHUAN_RECOVER_BUTTON,
  QIANCHUAN_RECOVERED,
  RECOVERY_COOLDOWN_MS,
  compassReloadAutoRestartsAudio,
  compassReloadRequiresConfirm,
  createRecoveryLock,
  decideSourceRecovery,
  noteReloadAttempt,
  qianchuanReloadStopsCompassAudio,
  releaseRecoveryLock,
  reloadSessionPolicy,
  swRestartResumesPendingAutoReload,
  tryAcquireRecoveryLock
} from "../src/source-recovery";

const nowMs = Date.parse("2026-08-21T08:00:00.000Z");

function decide(overrides: Partial<Parameters<typeof decideSourceRecovery>[0]> = {}) {
  return decideSourceRecovery({
    source: "qianchuan",
    worstBusinessStatus: "stalled",
    allowlistStatus: "allowed",
    debuggerAttached: true,
    userConfirmed: false,
    lockHeld: false,
    attemptCount: 0,
    alreadyReloadedThisEpisode: false,
    swGenerationMatches: true,
    nowMs,
    ...overrides
  });
}

describe("source-recovery", () => {
  it("千川刷新挂回旧 session，不创建新场，不停止罗盘音频", () => {
    const policy = reloadSessionPolicy();
    expect(policy.createNewSession).toBe(false);
    expect(policy.reattachExisting).toBe(true);
    expect(qianchuanReloadStopsCompassAudio()).toBe(false);
    const decision = decide({ userConfirmed: true });
    expect(decision.action).toBe("execute_reload");
    expect(decision.createNewSession).toBe(false);
    expect(decision.stopCompassAudio).toBe(false);
  });

  it("罗盘刷新必须确认，刷新后不自动恢复音频", () => {
    expect(compassReloadRequiresConfirm(false)).toBe(false);
    expect(compassReloadRequiresConfirm(true)).toBe(true);
    expect(compassReloadAutoRestartsAudio()).toBe(false);
    expect(COMPASS_RECOVER_PROMPT).toContain("重新授权音频");
    expect(COMPASS_RECOVER_BUTTON).toBe("刷新并重新连接");
    const unconfirmed = decide({ source: "compass", userConfirmed: false });
    expect(unconfirmed.action).toBe("prompt_reload");
    expect(unconfirmed.stopAudioFirst).toBe(true);
    expect(unconfirmed.autoRestartAudio).toBe(false);
    const confirmed = decide({ source: "compass", userConfirmed: true });
    expect(confirmed.action).toBe("execute_reload");
    expect(confirmed.autoRestartAudio).toBe(false);
  });

  it("登录页和离开白名单不刷新", () => {
    expect(decide({ allowlistStatus: "login" })).toMatchObject({ action: "blocked", reason: "login" });
    expect(decide({ allowlistStatus: "blocked" })).toMatchObject({ action: "blocked", reason: "left_allowlist" });
  });

  it("恢复锁阻止并发刷新，冷却阻止循环", () => {
    const lock = createRecoveryLock(12);
    expect(tryAcquireRecoveryLock(lock, nowMs)).toBe(true);
    expect(tryAcquireRecoveryLock(lock, nowMs)).toBe(false);
    expect(decide({ lockHeld: true }).action).toBe("blocked");
    releaseRecoveryLock(lock);
    noteReloadAttempt(lock, nowMs);
    expect(tryAcquireRecoveryLock(lock, nowMs + 1_000)).toBe(false);
    expect(decide({ lastAttemptAt: nowMs, nowMs: nowMs + RECOVERY_COOLDOWN_MS - 1 }).reason).toBe("cooldown");
    expect(decide({ alreadyReloadedThisEpisode: true, userConfirmed: false }).reason).toBe("human_after_reload");
  });

  it("SW 重启不续未完成自动刷新；L1 只重建 observation", () => {
    expect(swRestartResumesPendingAutoReload()).toBe(false);
    expect(decide({ swGenerationMatches: false }).reason).toBe("sw_restart");
    expect(decide({ worstBusinessStatus: "suspected_stall" }).action).toBe("rebuild_observer");
    expect(QIANCHUAN_RECOVER_BUTTON).toBe("刷新千川页面");
    expect(QIANCHUAN_RECOVERED).toBe("千川数据已恢复");
  });
});
