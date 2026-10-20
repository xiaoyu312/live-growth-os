import { describe, expect, it } from "vitest";
import { LIVE_SERVER_UNREACHABLE_MESSAGE, closeOffscreenAudioDocument, liveServerUnreachableMessage, liveStartDomWarning, runLiveStartTransaction, shouldCleanupLiveStart, shouldOpenLiveDashboard, shouldPollLiveDom, withLiveStartDeadline, awaitAudioConsumeForLiveStart } from "../../src/live-start";

describe("真实直播首个罗盘数据等待状态", () => {
  it("DOM 首读失败只产生可见 warning，真实会话仍可打开副驾", () => {
    const response = { ok: true as const, warning: liveStartDomWarning("当前页面未读取到可靠罗盘经营指标"), live: { sessionId: "s", dashboardPath: "/live/s" } };
    expect(response.warning).toBe("已连接，正在等待首批罗盘数据");
    expect(shouldOpenLiveDashboard(response)).toBe(true);
  });

  it("只有真实会话和副驾路径都返回时才打开页面", () => {
    expect(shouldOpenLiveDashboard({ ok: true, live: { sessionId: "s", dashboardPath: "/live/s" } })).toBe(true);
    expect(shouldOpenLiveDashboard({ ok: true, warning: "已连接，正在等待首批罗盘数据", live: { sessionId: "s", dashboardPath: "/live/s" } })).toBe(true);
    expect(shouldOpenLiveDashboard({ ok: true, error: "网络连接失败", live: { sessionId: "s", dashboardPath: "/live/s" } })).toBe(false);
    expect(shouldOpenLiveDashboard({ ok: true })).toBe(false);
    expect(shouldOpenLiveDashboard({ ok: false, live: { sessionId: "s", dashboardPath: "/live/s" } })).toBe(false);
    expect(shouldOpenLiveDashboard({ ok: false, errorCode: "tab_capture_failed", error: "没拿到声音", live: { sessionId: "s", dashboardPath: "/live/s" } })).toBe(true);
  });

  it("只有当前白名单会话仍在活动时才轮询 DOM", () => {
    expect(shouldPollLiveDom({ active: true, tabId: 1, activeTabId: 1, routeAllowed: true, sessionMatches: true })).toBe(true);
    expect(shouldPollLiveDom({ active: false, tabId: 1, activeTabId: 1, routeAllowed: true, sessionMatches: true })).toBe(false);
    expect(shouldPollLiveDom({ active: true, tabId: 1, activeTabId: 2, routeAllowed: true, sessionMatches: true })).toBe(false);
    expect(shouldPollLiveDom({ active: true, tabId: 1, activeTabId: 1, routeAllowed: false, sessionMatches: true })).toBe(false);
    expect(shouldPollLiveDom({ active: true, tabId: 1, activeTabId: 1, routeAllowed: true, sessionMatches: false })).toBe(false);
  });

  it("完整连接超过弹窗期限时返回超时，而不是无限等待", async () => {
    let timedOut = false;
    await expect(withLiveStartDeadline(new Promise<void>(() => undefined), 10, () => { timedOut = true; })).rejects.toThrow("真实直播连接超时");
    expect(timedOut).toBe(true);
  });

  it("连接在期限内完成时保留结果", async () => {
    await expect(withLiveStartDeadline(Promise.resolve("connected"), 100)).resolves.toBe("connected");
  });

  it("清理只允许结束自己那一次连接尝试", () => {
    const first = Symbol("first");
    const second = Symbol("second");
    expect(shouldCleanupLiveStart(first, first)).toBe(true);
    expect(shouldCleanupLiveStart(second, first)).toBe(false);
    expect(shouldCleanupLiveStart(undefined, first)).toBe(false);
  });

  it("建会话响应晚到时先停止孤儿服务端会话，再返回超时", async () => {
    const calls: string[] = [];
    const result = await runLiveStartTransaction({
      network: async () => { calls.push("network"); return { ok: true }; },
      createSession: async () => {
        calls.push("create");
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { sessionId: "orphan" };
      },
      readDom: async () => { calls.push("dom"); },
      startAudio: async () => { calls.push("audio"); return { ok: true }; },
      cleanup: () => { calls.push("cleanup"); },
      stopOrphanSession: (session) => { calls.push(`stop:${session.sessionId}`); }
    }, 10);
    expect(result).toMatchObject({ ok: false, error: "真实直播连接超时，请重新加载扩展后重试" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toEqual(["network", "create", "cleanup", "stop:orphan"]);
  });

  it("音频消费晚到时清理过期音频尝试且不继续启动", async () => {
    const calls: string[] = [];
    const result = await runLiveStartTransaction({
      network: async () => ({ ok: true }),
      createSession: async () => ({ sessionId: "s" }),
      readDom: async () => undefined,
      startAudio: async (guard) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        guard();
        return { ok: true };
      },
      cleanup: () => { calls.push("cleanup"); },
      stopOrphanSession: () => { calls.push("stop"); }
    }, 10);
    expect(result).toMatchObject({ ok: false, error: "真实直播连接超时，请重新加载扩展后重试" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toEqual(["cleanup"]);
  });

  it("本机服务不可达时不把浏览器 Failed to fetch 直接展示给运营", async () => {
    expect(liveServerUnreachableMessage(new TypeError("Failed to fetch"))).toBe(LIVE_SERVER_UNREACHABLE_MESSAGE);
    const result = await runLiveStartTransaction({
      network: async () => ({ ok: true }),
      createSession: async () => { throw new TypeError("Failed to fetch"); },
      readDom: async () => undefined,
      startAudio: async () => ({ ok: true }),
      cleanup: () => undefined,
      stopOrphanSession: () => undefined
    }, 1_000);
    expect(result).toMatchObject({ ok: false, error: LIVE_SERVER_UNREACHABLE_MESSAGE });
  });

  it("连接超时文案保持不变", () => {
    expect(liveServerUnreachableMessage(new Error("真实直播连接超时，请重新加载扩展后重试"))).toBe("真实直播连接超时，请重新加载扩展后重试");
  });

  it("音频失败仍返回已建场次，不清理、不停孤儿场", async () => {
    const calls: string[] = [];
    const result = await runLiveStartTransaction({
      network: async () => ({ ok: true }),
      createSession: async () => ({ sessionId: "kept", reused: false }),
      readDom: async () => undefined,
      startAudio: async () => ({ ok: false, errorCode: "tab_capture_failed", error: "没拿到声音" }),
      cleanup: () => { calls.push("cleanup"); },
      stopOrphanSession: () => { calls.push("stop"); }
    }, 1_000);
    expect(result).toMatchObject({
      ok: true,
      session: { sessionId: "kept" },
      audio: { ok: false, errorCode: "tab_capture_failed" }
    });
    expect(calls).toEqual([]);
  });

  it("关闭 offscreen 时等到文档消失", async () => {
    let remaining = 2;
    const calls: string[] = [];
    await closeOffscreenAudioDocument({
      sendStop: async () => { calls.push("stop"); },
      hasDocument: async () => {
        remaining -= 1;
        return remaining >= 0;
      },
      closeDocument: async () => { calls.push("close"); },
      now: (() => { let t = 0; return () => { t += 10; return t; }; })(),
      wait: async () => undefined,
      timeoutMs: 200
    });
    expect(calls).toEqual(["stop", "close"]);
  });

  it("延迟 consume 被当前尝试拒绝后调用音频停止清理", async () => {
    const calls: string[] = [];
    const valid = false;
    await expect(awaitAudioConsumeForLiveStart(
      new Promise<string>((resolve) => setTimeout(() => resolve("late"), 20)),
      () => { if (!valid) throw new Error("expired"); },
      () => { calls.push("audio:stop"); }
    )).rejects.toThrow("expired");
    expect(calls).toEqual(["audio:stop"]);
  });
});
