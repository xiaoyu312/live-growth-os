import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLiveDiagExport, collectDiagnosisCitations, copilotHeaderPayment, copilotOnlineSnapshot, clockHourLabel, clockHourSlotLabel, formatActionDealEvidence, formatCitedNumber, formatFenAsYuan, formatHourComparison, formatWatchDuration, formatClickToPaidDisplay, formatQianchuanDeltaDisplay, hourMonitorPace, lastKnownCompassNumber, liveDiagExportFilename, liveMetricPrimaryClass, livePilotInterruptBanner, liveSourceHeaderLabel, monitoredDuration, normalizeLiveView, qianchuanBackgroundThrottleNote, qianchuanClickToPaidSlot, qianchuanClickToPaidWindow, qianchuanDelta, qianchuanDeltaWithLastKnown, qianchuanFourRateFunnel, qianchuanOfficialApiStatusLabel, qianchuanSlotDelta, qianchuanStatusLabel, qianchuanWindowDelta, selectQianchuanPaidTrendPoints, selectQianchuanDeltaTrendPoints, selectTrendPoints, sourceGroupLine, stripSensitiveDiagFields, trendAnchorMs, trendWindowUnit, WAITING_MINUTE_BASELINE_NOTE, WAITING_QUARTER_BASELINE_NOTE, WAITING_SHARED_WINDOW_NOTE, type QianchuanMetric, type QianchuanMetricValue } from "../app/live/[sessionId]/page";
import { liveAudioStatusLabel } from "../app/live/audio-status";

describe("真实直播页旧版 view 兼容", () => {
  it("缺少可选投影时仍能得到可渲染的安全默认值，不制造经营指标", () => {
    const view = normalizeLiveView({
      session: { name: "现场", status: "running" },
      latestMetric: null,
      source: { status: "unknown", firstMetricTimedOut: false },
      audio: { status: "not_started", transcriptionStatus: "not_started" }
    });

    expect(view.metricComparisons).toEqual({});
    expect(view.qianchuan).toEqual({ status: "unknown", latestMetric: null, metricHistory: [] });
    expect(view.recentTranscripts).toEqual([]);
    expect(view.actionHistory).toEqual([]);
    expect(view.source.coverage.core).toEqual({ available: 0, total: 0, missing: [] });
    expect(view.latestMetric).toBeNull();
    expect(view.productRole).toBe("unknown");
  });

  it("严格透传官方千川 API 状态，并把首轮失败翻译成现场状态", () => {
    const base = {
      source: "official_api",
      configured: true,
      state: "healthy",
      activeSessions: 1,
      lastSuccessAt: "2026-09-10T08:00:00.000Z",
      consecutiveFailures: 0
    } as const;
    const view = normalizeLiveView({
      qianchuan: { sourceKind: "official_api", officialApi: base },
      source: { status: "unknown", firstMetricTimedOut: false },
      audio: { status: "not_started", transcriptionStatus: "not_started" }
    });
    expect(view.qianchuan.officialApi).toEqual(base);
    expect(qianchuanOfficialApiStatusLabel(base)).toBe("正常");
    expect(qianchuanOfficialApiStatusLabel({ source: "official_api", configured: true, state: "idle", activeSessions: 1, consecutiveFailures: 0 })).toBe("等待首读");
    expect(qianchuanOfficialApiStatusLabel({ source: "official_api", configured: true, state: "error", activeSessions: 1, consecutiveFailures: 1, lastErrorCode: "QIANCHUAN_NO_LIVING_ROOM" })).toBe("没有正在直播房间");
    expect(qianchuanOfficialApiStatusLabel({ source: "official_api", configured: true, state: "error", activeSessions: 1, consecutiveFailures: 1, lastErrorCode: "QIANCHUAN_TOOL_40102" })).toBe("授权失效");
    expect(qianchuanOfficialApiStatusLabel({ source: "official_api", configured: true, state: "error", activeSessions: 1, consecutiveFailures: 1, lastErrorCode: "QIANCHUAN_TOOL_40103" })).toBe("权限不足");
    expect(qianchuanOfficialApiStatusLabel({ source: "official_api", configured: true, state: "error", activeSessions: 1, consecutiveFailures: 1, lastErrorCode: "QIANCHUAN_NETWORK_FAILED" })).toBe("网络失败");
    expect(qianchuanOfficialApiStatusLabel({ source: "official_api", configured: true, state: "stale", activeSessions: 1, consecutiveFailures: 0 })).toBe("等待更新");
    expect(qianchuanOfficialApiStatusLabel({ ...base, configured: false, state: "not_configured", activeSessions: 0 })).toBe("未配置");

    const malformed = normalizeLiveView({
      qianchuan: {
        officialApi: { ...base, lastErrorCode: "QIANCHUAN_BAD\\nCODE" },
      },
      source: { status: "unknown", firstMetricTimedOut: false },
      audio: { status: "not_started", transcriptionStatus: "not_started" }
    });
    expect(malformed.qianchuan.officialApi).toBeUndefined();
  });
});

describe("副驾采集中断提示", () => {
  it("登录中断或服务重启时提示采集中断，不用空白或 404", () => {
    expect(livePilotInterruptBanner({
      session: { status: "running" },
      needsReconnect: true,
      source: { status: "stale" },
      audio: { status: "offline" }
    })).toContain("采集中断");
    expect(livePilotInterruptBanner({
      session: { status: "running" },
      needsReconnect: false,
      source: { status: "stale" },
      audio: { status: "offline" }
    })).toContain("恢复上一场直播");
    expect(livePilotInterruptBanner({
      session: { status: "running" },
      needsReconnect: false,
      source: { status: "fresh" },
      audio: { status: "active" }
    })).toBeNull();
    expect(livePilotInterruptBanner({
      session: { status: "stopped" },
      needsReconnect: false,
      source: { status: "stale" },
      audio: { status: "offline" }
    })).toBeNull();
  });
});

describe("副驾办公网分享", () => {
  it("固定 /live/current，不把当场 sessionId 写进分享链接", () => {
    const sessionPage = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app/live/[sessionId]/page.tsx"), "utf8");
    const shareBar = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app/live/lan-share.tsx"), "utf8");
    expect(sessionPage).toContain("LanShareBar");
    expect(sessionPage).not.toContain("/live/${params.sessionId}");
    expect(shareBar).toContain("lanColleagueWatchUrl");
    expect(shareBar).toContain("复制链接");
    expect(shareBar).toContain("/live/current");
    expect(shareBar).toContain("不要发 127.0.0.1");
  });
});

describe("副驾导出诊断", () => {
  it("文件名用 sessionId 前8位，并去掉 pairToken", () => {
    expect(liveDiagExportFilename("abcdef12-3456-7890")).toBe("live-diag-abcdef12.json");
    expect(liveDiagExportFilename("short")).toBe("live-diag-short.json");
    const view = normalizeLiveView({
      session: { name: "现场", status: "running" },
      latestMetric: null,
      source: { status: "unknown", firstMetricTimedOut: false },
      audio: { status: "error", transcriptionStatus: "error", errorCode: "ASR_CODE_4005" },
      pairToken: "should-not-export"
    });
    const { filename, payload } = buildLiveDiagExport({
      sessionId: "sess1234-rest",
      view: { ...view, pairToken: "should-not-export" },
      health: { status: "ok", pairToken: "health-token", build: "duty" },
      exportedAt: "2026-08-21T03:00:00.000Z"
    });
    expect(filename).toBe("live-diag-sess1234.json");
    expect(JSON.stringify(payload)).not.toContain("should-not-export");
    expect(JSON.stringify(payload)).not.toContain("health-token");
    expect(JSON.stringify(payload)).not.toContain("pairToken");
    expect(payload.sessionId).toBe("sess1234-rest");
    expect(payload.health).toEqual({ status: "ok", build: "duty" });
    expect((payload.view as { audio?: { errorCode?: string } }).audio?.errorCode).toBe("ASR_CODE_4005");
    expect(stripSensitiveDiagFields({ pairToken: "x", nested: { pair_token: "y", keep: 1 } })).toEqual({ nested: { keep: 1 } });
    const healthView = normalizeLiveView({
      session: { name: "现场", status: "running" },
      qianchuan: { status: "partial", overallHealth: "partial", groups: [{ source: "qianchuan", group: "spend", status: "fresh" }] },
      source: { status: "fresh", firstMetricTimedOut: false },
      sourceGroupHealth: { qianchuan: { overallHealth: "partial", groups: [{ source: "qianchuan", group: "spend", status: "fresh" }] }, compass: { overallHealth: "fresh", groups: [] } },
      pageRuntimeState: { qianchuan: { source: "qianchuan", observedAt: "2026-08-21T08:00:00.000Z", visibilityState: "hidden", hasFocus: false, navigatorOnline: true, debuggerAttached: true, allowlistStatus: "allowed", topFrameLifecycle: "live" } },
      recoveryHistory: [{ source: "qianchuan", action: "reload", outcome: "pending", attemptedAt: "2026-08-21T08:00:00.000Z", reason: "user_confirmed_reload" }],
      recovering: true,
      pairToken: "should-not-export",
      tabId: 99
    });
    const exported = buildLiveDiagExport({ sessionId: "diag1234-rest", view: { ...healthView, pairToken: "should-not-export", tabId: 99 } });
    expect(exported.payload.sourceGroupHealth).toMatchObject({ qianchuan: { overallHealth: "partial" } });
    expect(exported.payload.pageRuntimeState).toMatchObject({ qianchuan: { visibilityState: "hidden", hasFocus: false } });
    expect(exported.payload.recoveryHistory).toEqual(expect.arrayContaining([expect.objectContaining({ action: "reload" })]));
    expect(JSON.stringify(exported.payload)).not.toContain("should-not-export");
    expect(JSON.stringify(exported.payload)).not.toContain("\"tabId\"");
  });
});

describe("副驾音频状态文案", () => {
  it("已接到声音但转写鉴权失败时不写成未接入", () => {
    expect(liveAudioStatusLabel({ transcriptionStatus: "offline", audioFrames: 1448, errorCode: "ASR_CODE_4002" })).toBe("声音已接到，转写鉴权失败（4002）");
    expect(liveAudioStatusLabel({ transcriptionStatus: "error", audioFrames: 20 })).toBe("声音已接到，转写失败");
    expect(liveAudioStatusLabel({ transcriptionStatus: "error", audioFrames: 20, errorCode: "ASR_CODE_2005" })).toBe("声音已接到，转写失败（2005）");
    expect(liveAudioStatusLabel({ transcriptionStatus: "error", audioFrames: 0, errorCode: "ASR_CODE_4004" })).toBe("声音已接到，转写额度用尽（4004）");
    expect(liveAudioStatusLabel({ transcriptionStatus: "error", audioFrames: 0, errorCode: "ASR_CODE_4005" })).toBe("声音已接到，转写账户欠费（4005）");
    expect(liveAudioStatusLabel({ transcriptionStatus: "error", audioFrames: 0, errorCode: "ASR_CODE_4006" })).toBe("声音已接到，转写并发超限（4006）");
    expect(liveAudioStatusLabel({ transcriptionStatus: "error", audioFrames: 0, errorCode: "ASR_HANDSHAKE_ERROR" })).toBe("转写失败（HANDSHAKE_ERROR）");
    expect(liveAudioStatusLabel({ transcriptionStatus: "offline", audioFrames: 10 })).toBe("声音已接到，转写已断开");
    expect(liveAudioStatusLabel({ transcriptionStatus: "not_started" })).toBe("未接入");
    expect(liveAudioStatusLabel({ transcriptionStatus: "active" })).toBe("正常");
  });
});

function qianchuanSnapshot(observedAt: string, value: number, sourceField = "stat_cost_for_roi2", unit: "元" | "%" | "人" | "次" | "单" | "unknown" = "元"): QianchuanMetric {
  return {
    observedAt,
    dataStatus: "fresh",
    metricSource: "qianchuan",
    metrics: { adSpend: { value, unit, semantic: "cumulative", sourceField } }
  };
}

function qianchuanCumulativeSnapshot(observedAt: string, metrics: Partial<Record<"liveWatchCount" | "productClicks" | "paidOrderCount" | "paidOrderGmv" | "adSpend", number>>, sourceFields?: Partial<Record<"liveWatchCount" | "productClicks" | "paidOrderCount" | "paidOrderGmv" | "adSpend", string>>, dataStatus: QianchuanMetric["dataStatus"] = "fresh"): QianchuanMetric {
  const units: Record<string, QianchuanMetricValue["unit"]> = { liveWatchCount: "次", productClicks: "次", paidOrderCount: "单", paidOrderGmv: "元", adSpend: "元" };
  return {
    observedAt,
    dataStatus,
    metricSource: "qianchuan",
    metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, { value, unit: units[key], semantic: "cumulative", sourceField: sourceFields?.[key as keyof typeof sourceFields] ?? `qianchuan_${key}` }])) as QianchuanMetric["metrics"]
  };
}

function funnelSnapshot(observedAt: string, clicks: number, paidOrders: number, clickField = "product_clicks", paidField = "paid_order_count"): QianchuanMetric {
  return {
    observedAt,
    dataStatus: "fresh",
    metricSource: "qianchuan",
    metrics: {
      productClicks: { value: clicks, unit: "次", semantic: "cumulative", sourceField: clickField },
      paidOrderCount: { value: paidOrders, unit: "单", semantic: "cumulative", sourceField: paidField }
    }
  };
}

describe("首页千川累计快照差分口径", () => {
	it("允许目标字段比后续点击分片落后5秒，仍按目标字段时间计算1分钟差值", () => {
		const history = [
			qianchuanCumulativeSnapshot("2026-08-13T01:59:00.000Z", { adSpend: 100 }),
			qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { adSpend: 125 }),
			qianchuanCumulativeSnapshot("2026-08-13T02:00:05.000Z", { productClicks: 1 })
		];
		expect(qianchuanDelta(history, "adSpend", Date.parse("2026-08-13T02:00:05.000Z"))).toMatchObject({ status: "ready", value: 25 });
	});

	it("目标字段相对当前时间落后10分钟时不生成差值或趋势点", () => {
		const history = [
			qianchuanCumulativeSnapshot("2026-08-13T01:59:00.000Z", { paidOrderCount: 2 }),
			qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { paidOrderCount: 5 }),
			qianchuanCumulativeSnapshot("2026-08-13T02:10:00.000Z", { adSpend: 100 })
		];
		const nowMs = Date.parse("2026-08-13T02:10:00.000Z");
		expect(qianchuanDelta(history, "paidOrderCount", nowMs)).toMatchObject({ status: "missing", note: "字段待更新" });
		expect(selectQianchuanDeltaTrendPoints(history, "paidOrderCount", nowMs)).toEqual([]);
	});

	it("千川后台节流时消耗分片不得把点击字段误报为字段待更新", () => {
		const history = [
			qianchuanCumulativeSnapshot("2026-08-14T08:48:48.000Z", { productClicks: 40, paidOrderCount: 3, adSpend: 10 }),
			qianchuanCumulativeSnapshot("2026-08-14T08:48:56.000Z", { productClicks: 42, paidOrderCount: 3, adSpend: 10.2 }),
			qianchuanCumulativeSnapshot("2026-08-14T08:49:57.000Z", { adSpend: 10.8 }),
			qianchuanCumulativeSnapshot("2026-08-14T08:50:58.000Z", { adSpend: 11.07 })
		];
		const nowMs = Date.parse("2026-08-14T08:51:11.000Z");
		expect(qianchuanDelta(history, "productClicks", nowMs)).toMatchObject({ status: "baseline", note: "待形成1分钟基线" });
		expect(qianchuanDelta(history, "paidOrderCount", nowMs)).toMatchObject({ status: "baseline", note: "待形成1分钟基线" });
		expect(qianchuanDelta(history, "adSpend", nowMs).status).toBe("ready");
		expect(qianchuanDelta(history, "adSpend", nowMs).value).toBeCloseTo(0.27);
		expect(qianchuanDelta(history, "liveWatchCount", nowMs)).toMatchObject({ status: "missing", note: "本场尚未获取" });
		expect(qianchuanClickToPaidWindow(history, nowMs)).toMatchObject({ status: "baseline", note: "待形成共同1分钟窗口" });
		expect(selectQianchuanDeltaTrendPoints(history, "productClicks", nowMs)).toEqual([]);
		expect(qianchuanBackgroundThrottleNote(history, history.at(-1), "fresh", nowMs)).toBe("千川页面在后台会停止拉数。请在千川标签打开扩展侧栏看副驾，并保持该窗口可见；双屏时把千川放在另一块屏。完全隐藏的标签无法继续采集。");
	});

	it("merged last-known 已读到的累计字段不得因历史窗口缺失而写成尚未获取", () => {
		const lastKnown = qianchuanCumulativeSnapshot("2026-08-14T08:26:00.000Z", { liveWatchCount: 348, paidOrderGmv: 1894.2, productClicks: 66, adSpend: 11.07 });
		const history = [qianchuanCumulativeSnapshot("2026-08-14T08:50:58.000Z", { adSpend: 11.07 })];
		const nowMs = Date.parse("2026-08-14T08:51:11.000Z");
		expect(qianchuanDelta(history, "liveWatchCount", nowMs)).toMatchObject({ status: "missing", note: "本场尚未获取" });
		expect(qianchuanDeltaWithLastKnown(history, "liveWatchCount", lastKnown, nowMs)).toMatchObject({ status: "baseline", note: "待形成1分钟基线" });
		expect(qianchuanDeltaWithLastKnown(history, "paidOrderGmv", lastKnown, nowMs)).toMatchObject({ status: "baseline", note: "待形成1分钟基线" });
		expect(qianchuanDeltaWithLastKnown(history, "productClicks", lastKnown, nowMs)).toMatchObject({ status: "baseline", note: "待形成1分钟基线" });
		expect(formatQianchuanDeltaDisplay(qianchuanDeltaWithLastKnown(history, "liveWatchCount", lastKnown, nowMs))).toBe(WAITING_MINUTE_BASELINE_NOTE);
		expect(qianchuanDeltaWithLastKnown(history, "liveWatchCount", lastKnown, nowMs).note).toBe(WAITING_MINUTE_BASELINE_NOTE);
		expect(qianchuanDeltaWithLastKnown(history, "liveWatchCount", qianchuanCumulativeSnapshot("2026-08-14T08:26:00.000Z", { liveWatchCount: 0 }), nowMs)).toMatchObject({ status: "ready", value: 0 });
		expect(qianchuanDeltaWithLastKnown(history, "liveWatchCount", qianchuanCumulativeSnapshot("2026-08-14T08:50:58.000Z", { adSpend: 11.07 }), nowMs)).toMatchObject({ status: "missing", note: "本场尚未获取" });
		expect(lastKnownCompassNumber({ observedAt: "2026-08-14T08:52:00.000Z", dataStatus: "fresh", onlineSnapshot: 4 }, [
			{ observedAt: "2026-08-14T08:40:00.000Z", dataStatus: "fresh", unpaidOrderCount: 3, productClickCount: 15 },
			{ observedAt: "2026-08-14T08:52:00.000Z", dataStatus: "fresh", onlineSnapshot: 4 }
		], "unpaidOrderCount")).toBe(3);
		expect(lastKnownCompassNumber({ observedAt: "2026-08-14T08:52:00.000Z", dataStatus: "fresh", onlineSnapshot: 4 }, [
			{ observedAt: "2026-08-14T08:52:00.000Z", dataStatus: "fresh", onlineSnapshot: 4 }
		], "unpaidOrderCount")).toBeUndefined();
		expect(qianchuanBackgroundThrottleNote(history, lastKnown, "fresh", nowMs)).toBe("千川页面在后台会停止拉数。请在千川标签打开扩展侧栏看副驾，并保持该窗口可见；双屏时把千川放在另一块屏。完全隐藏的标签无法继续采集。");
		expect(qianchuanBackgroundThrottleNote([
			qianchuanCumulativeSnapshot("2026-08-14T08:50:00.000Z", { productClicks: 40, paidOrderCount: 3, adSpend: 10 }),
			qianchuanCumulativeSnapshot("2026-08-14T08:51:00.000Z", { productClicks: 42, paidOrderCount: 3, adSpend: 10.2 })
		], qianchuanCumulativeSnapshot("2026-08-14T08:51:00.000Z", { productClicks: 42, paidOrderCount: 3, adSpend: 10.2 }), "fresh", Date.parse("2026-08-14T08:51:05.000Z"))).toBeUndefined();
	});

	it("共同点击支付窗口落后全局最新5秒时仍计算支付订单0和0%", () => {
		const history = [
			funnelSnapshot("2026-08-13T01:59:00.000Z", 10, 2),
			funnelSnapshot("2026-08-13T02:00:00.000Z", 20, 2),
			qianchuanCumulativeSnapshot("2026-08-13T02:00:05.000Z", { adSpend: 100 })
		];
		const nowMs = Date.parse("2026-08-13T02:00:05.000Z");
		expect(qianchuanDelta(history, "paidOrderCount", nowMs)).toMatchObject({ status: "ready", value: 0 });
		expect(qianchuanClickToPaidWindow(history, nowMs)).toMatchObject({ status: "ready", clicks: 10, paidOrders: 0, rate: 0 });
	});

	it("只对同字段、同单位且相隔约一分钟的累计快照计算差值", () => {
    const result = qianchuanDelta([
      qianchuanSnapshot("2026-08-13T01:59:00.000Z", 100),
      qianchuanSnapshot("2026-08-13T02:00:00.000Z", 125)
    ], "adSpend", Date.parse("2026-08-13T02:00:00.000Z"));
    expect(result).toMatchObject({ status: "ready", value: 25, note: "近1分钟变化 +¥25.00" });
  });

	it("基线不足、太老基线、字段切换和累计回退都不制造近1分钟数字", () => {
		const nowMs = Date.parse("2026-08-13T02:00:00.000Z");
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:59:40.000Z", 100), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 125)], "adSpend", nowMs)).toMatchObject({ status: "baseline", note: "待形成1分钟基线" });
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:59:20.000Z", 100), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 125)], "adSpend", nowMs)).toMatchObject({ status: "baseline", note: "待形成1分钟基线" });
		expect(qianchuanDelta([
			qianchuanCumulativeSnapshot("2026-08-14T08:25:51.802Z", { productClicks: 43 }),
			qianchuanCumulativeSnapshot("2026-08-14T08:26:49.806Z", { productClicks: 43 })
		], "productClicks", Date.parse("2026-08-14T08:26:49.806Z"))).toMatchObject({ status: "ready", value: 0 });
		expect(qianchuanDelta([
			qianchuanCumulativeSnapshot("2026-08-14T08:26:49.806Z", { productClicks: 43 }),
			qianchuanCumulativeSnapshot("2026-08-14T08:27:20.818Z", { productClicks: 43 })
		], "productClicks", Date.parse("2026-08-14T08:27:20.818Z"))).toMatchObject({ status: "baseline", note: "待形成1分钟基线" });
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:58:30.000Z", 100), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 125)], "adSpend", Date.parse("2026-08-13T02:00:00.000Z"))).toMatchObject({ status: "ready", value: 25 });
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:58:29.000Z", 100), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 125)], "adSpend", Date.parse("2026-08-13T02:00:00.000Z")).status).toBe("baseline");
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:59:00.000Z", 100), qianchuanSnapshot("2026-08-13T02:01:00.000Z", 125)], "adSpend", Date.parse("2026-08-13T02:00:00.000Z")).status).toBe("baseline");
			expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:59:00.000Z", 100), qianchuanSnapshot("2026-08-13T01:59:00.000Z", 110), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 125)], "adSpend", Date.parse("2026-08-13T02:00:00.000Z"))).toMatchObject({ status: "baseline", note: "同时间数据冲突" });
			expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:59:00.000Z", 100), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 125), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 130)], "adSpend", Date.parse("2026-08-13T02:00:00.000Z"))).toMatchObject({ status: "baseline", note: "同时间数据冲突" });
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:57:00.000Z", 100), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 125)], "adSpend", nowMs)).toMatchObject({ status: "baseline", note: "待形成1分钟基线" });
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:59:00.000Z", 100), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 125, "stat_real_cost_for_roi2")], "adSpend", nowMs).status).toBe("baseline");
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:59:00.000Z", 100), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 125, "stat_cost_for_roi2", "%")], "adSpend", nowMs).status).toBe("baseline");
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:59:00.000Z", 100), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 90)], "adSpend", nowMs).status).toBe("reset");
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:59:00.000Z", 100), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 100)], "adSpend", nowMs)).toMatchObject({ status: "ready", value: 0, note: "近1分钟变化 +¥0.00" });
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T02:00:00.000Z", 0)], "adSpend", Date.parse("2026-08-13T02:00:00.000Z"))).toMatchObject({ status: "ready", value: 0, note: "近1分钟变化 +¥0.00" });
		expect(qianchuanDelta([qianchuanSnapshot("2026-08-13T01:59:40.000Z", 0), qianchuanSnapshot("2026-08-13T02:00:00.000Z", 0)], "adSpend", Date.parse("2026-08-13T02:00:00.000Z"))).toMatchObject({ status: "ready", value: 0 });
	});

	it("近1分钟展示：已读到的 0 显示 0，基线不足不再写成尚未获取", () => {
		expect(formatQianchuanDeltaDisplay({ status: "ready", value: 0, note: "近1分钟变化 +0次" })).toBe("0");
		expect(formatQianchuanDeltaDisplay({ status: "ready", value: 0, note: "近1分钟变化 +¥0.00" }, "money")).toBe("¥0.00");
		expect(formatQianchuanDeltaDisplay({ status: "baseline", note: WAITING_MINUTE_BASELINE_NOTE })).toBe(WAITING_MINUTE_BASELINE_NOTE);
		expect(formatQianchuanDeltaDisplay({ status: "baseline", note: WAITING_MINUTE_BASELINE_NOTE }, "money")).toBe(WAITING_MINUTE_BASELINE_NOTE);
		expect(formatQianchuanDeltaDisplay({ status: "reset", note: "基线已重置" })).toBe("基线已重置");
		expect(formatQianchuanDeltaDisplay({ status: "missing", note: "本场尚未获取" })).toBe("本场尚未获取");
	});

	it("首页指定空槽：从未读到显示 0，非 0 无基线仍待形成1分钟基线", () => {
		const nowMs = Date.parse("2026-08-14T08:51:11.000Z");
			const emptyLatest = qianchuanCumulativeSnapshot("2026-08-14T08:50:58.000Z", { adSpend: 11.07 });
			const emptyHistory = [emptyLatest];
			const watchMissing = qianchuanDeltaWithLastKnown(emptyHistory, "liveWatchCount", emptyLatest, nowMs);
			const gmvMissing = qianchuanDeltaWithLastKnown(emptyHistory, "paidOrderGmv", emptyLatest, nowMs);
			expect(formatQianchuanDeltaDisplay(watchMissing)).toBe("本场尚未获取");
			expect(formatQianchuanDeltaDisplay(gmvMissing, "money")).toBe("本场尚未获取");
			expect(qianchuanDeltaWithLastKnown(emptyHistory, "liveImpressions", emptyLatest, nowMs)).toMatchObject({ status: "missing", note: "本场尚未获取" });
			expect(qianchuanDeltaWithLastKnown(emptyHistory, "productClicks", emptyLatest, nowMs)).toMatchObject({ status: "missing", note: "本场尚未获取" });

		const nonzeroNoBaseline = qianchuanCumulativeSnapshot("2026-08-14T08:26:00.000Z", { liveWatchCount: 348, paidOrderGmv: 1894.2 });
			expect(formatQianchuanDeltaDisplay(qianchuanDeltaWithLastKnown(emptyHistory, "liveWatchCount", nonzeroNoBaseline, nowMs))).toBe(WAITING_MINUTE_BASELINE_NOTE);
			expect(qianchuanDeltaWithLastKnown(emptyHistory, "liveWatchCount", nonzeroNoBaseline, nowMs).note).toBe(WAITING_MINUTE_BASELINE_NOTE);
			expect(formatQianchuanDeltaDisplay(qianchuanDeltaWithLastKnown(emptyHistory, "paidOrderGmv", nonzeroNoBaseline, nowMs), "money")).toBe(WAITING_MINUTE_BASELINE_NOTE);

		const confirmedZero = qianchuanCumulativeSnapshot("2026-08-14T08:26:00.000Z", { liveWatchCount: 0, paidOrderGmv: 0 });
			expect(formatQianchuanDeltaDisplay(qianchuanDeltaWithLastKnown(emptyHistory, "liveWatchCount", confirmedZero, nowMs))).toBe("0");
			expect(formatQianchuanDeltaDisplay(qianchuanDeltaWithLastKnown(emptyHistory, "paidOrderGmv", confirmedZero, nowMs), "money")).toBe("¥0.00");
		expect(formatQianchuanDeltaDisplay(qianchuanDelta([qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { liveWatchCount: 0 })], "liveWatchCount", Date.parse("2026-08-13T02:00:00.000Z")))).toBe("0");
		expect(formatQianchuanDeltaDisplay(qianchuanDelta([qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { paidOrderGmv: 0 })], "paidOrderGmv", Date.parse("2026-08-13T02:00:00.000Z")), "money")).toBe("¥0.00");

			expect(formatQianchuanDeltaDisplay({ status: "missing", note: "本场尚未获取" })).toBe("本场尚未获取");
	});

	it("待形成1分钟基线显示等待文案；实际 0 与有效差分 0 才显示 0", () => {
		const nowMs = Date.parse("2026-08-14T08:51:11.000Z");
		const readyHistory = [
			qianchuanCumulativeSnapshot("2026-08-14T08:49:00.000Z", { productClicks: 40, paidOrderCount: 3, adSpend: 10 }),
			qianchuanCumulativeSnapshot("2026-08-14T08:50:00.000Z", { productClicks: 42, paidOrderCount: 3, adSpend: 10.2 })
		];
		const readyLatest = readyHistory.at(-1);
		expect(formatQianchuanDeltaDisplay(qianchuanSlotDelta(readyHistory, "productClicks", readyLatest, "stale", nowMs))).toBe("2");
		expect(formatQianchuanDeltaDisplay(qianchuanSlotDelta(readyHistory, "adSpend", readyLatest, "stale", nowMs), "money")).toBe("¥0.20");
		expect(formatClickToPaidDisplay(qianchuanClickToPaidSlot(readyHistory, "stale", nowMs))).toBe("0.00%");

		const waitingLatest = qianchuanCumulativeSnapshot("2026-08-14T08:50:58.000Z", { productClicks: 66, adSpend: 11.07 });
		const waiting = qianchuanSlotDelta([waitingLatest], "productClicks", waitingLatest, "fresh", nowMs);
		expect(waiting).toMatchObject({ status: "baseline", note: WAITING_MINUTE_BASELINE_NOTE });
		expect(formatQianchuanDeltaDisplay(waiting)).toBe(WAITING_MINUTE_BASELINE_NOTE);
		expect(liveMetricPrimaryClass("0")).toBe("live-pilot-metric-value");
		expect(liveMetricPrimaryClass("已超过90秒未更新")).toBe("live-pilot-metric-copy");

		expect(qianchuanSlotDelta([], "productClicks", undefined, "stale", nowMs)).toMatchObject({ status: "missing", note: "已超过90秒未更新" });
		expect(formatQianchuanDeltaDisplay(qianchuanSlotDelta([], "productClicks", undefined, "stale", nowMs))).toBe("已超过90秒未更新");
		expect(formatQianchuanDeltaDisplay({ status: "baseline", note: "同时间数据冲突" })).toBe("同时间数据冲突");
		expect(formatClickToPaidDisplay({ status: "baseline", note: WAITING_SHARED_WINDOW_NOTE })).toBe("0.00%");
		expect(formatClickToPaidDisplay(qianchuanClickToPaidSlot([], "stale", nowMs))).toBe("已超过90秒未更新");
		expect(formatClickToPaidDisplay(qianchuanClickToPaidWindow([
			{ observedAt: "2026-08-13T02:00:00.000Z", dataStatus: "fresh", metricSource: "qianchuan", metrics: { productClicks: { value: 0, unit: "次", semantic: "cumulative", sourceField: "product_clicks" }, paidOrderCount: { value: 0, unit: "单", semantic: "cumulative", sourceField: "paid_order_count" } } }
		], Date.parse("2026-08-13T02:00:00.000Z")))).toBe("不适用");
	});

	it("平均观看时长格式化为分钟和秒", () => {
		expect(formatWatchDuration(96)).toBe("1分36秒");
		expect(formatWatchDuration(36)).toBe("36秒");
		expect(formatWatchDuration()).toBe("本场尚未获取");
	});

	it("超过十二个中间快照后仍按二十分钟有界历史找到最近1分钟基线", () => {
    const history = Array.from({ length: 18 }, (_, index) => qianchuanSnapshot(new Date(Date.parse("2026-08-13T01:40:00.000Z") + index * 60_000).toISOString(), 100 + index));
	expect(qianchuanDelta(history, "adSpend", Date.parse("2026-08-13T01:57:00.000Z"))).toMatchObject({ status: "ready", value: 1 });
  });

	it("只有共同1分钟窗口才计算点击到支付，基线错位、来源不一致拒绝", () => {
		const nowMs = Date.parse("2026-08-13T02:00:00.000Z");
    expect(qianchuanClickToPaidWindow([
      funnelSnapshot("2026-08-13T01:59:00.000Z", 10, 2),
      funnelSnapshot("2026-08-13T02:00:00.000Z", 20, 5)
    ], nowMs).rate).toBe(30);
    expect(qianchuanClickToPaidWindow([
      funnelSnapshot("2026-08-13T01:54:30.000Z", 10, 2),
      funnelSnapshot("2026-08-13T01:59:00.000Z", 20, 5)
    ], Date.parse("2026-08-13T01:59:00.000Z")).status).toBe("baseline");
    expect(qianchuanClickToPaidWindow([
      funnelSnapshot("2026-08-13T01:59:00.000Z", 10, 2, "different_clicks"),
      funnelSnapshot("2026-08-13T02:00:00.000Z", 20, 5)
    ], nowMs).status).toBe("baseline");
		 expect(qianchuanClickToPaidWindow([
      funnelSnapshot("2026-08-13T01:59:00.000Z", 10, 2),
      funnelSnapshot("2026-08-13T02:00:00.000Z", 10, 5)
    ], nowMs).note).toContain("点击为0");
		expect(qianchuanClickToPaidWindow([
			funnelSnapshot("2026-08-13T01:59:00.000Z", 10, 2),
			funnelSnapshot("2026-08-13T01:59:00.000Z", 11, 2),
			funnelSnapshot("2026-08-13T02:00:00.000Z", 20, 5)
			], nowMs)).toMatchObject({ status: "baseline", note: "同时间数据冲突" });
		 expect(qianchuanClickToPaidWindow([
			{ ...funnelSnapshot("2026-08-13T01:59:00.000Z", 10, 2), metrics: { productClicks: { value: 10, unit: "次", semantic: "cumulative", sourceField: "product_clicks" } } },
			{ ...funnelSnapshot("2026-08-13T01:59:00.000Z", 10, 2), metrics: { paidOrderCount: { value: 2, unit: "单", semantic: "cumulative", sourceField: "paid_order_count" } } },
			funnelSnapshot("2026-08-13T02:00:00.000Z", 20, 5)
		], nowMs).status).toBe("baseline");
		const partialLatest = [
			qianchuanCumulativeSnapshot("2026-08-13T01:59:00.000Z", { productClicks: 10, paidOrderCount: 2 }),
			qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { paidOrderCount: 5 })
		];
		expect(qianchuanClickToPaidWindow(partialLatest, Date.parse("2026-08-13T02:00:00.000Z"))).toMatchObject({ status: "baseline", note: "待形成共同1分钟窗口" });
		expect(qianchuanClickToPaidWindow([
			funnelSnapshot("2026-08-13T02:00:00.000Z", 0, 0)
		], Date.parse("2026-08-13T02:00:00.000Z"))).toMatchObject({ status: "ready", clicks: 0, paidOrders: 0, note: "近1分钟点击为0，不适用" });
	  });

	it("用千川观看累计差分作为近1分钟观看增量", () => {
		const result = qianchuanDelta([
			qianchuanCumulativeSnapshot("2026-08-13T01:59:00.000Z", { liveWatchCount: 20 }),
			qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { liveWatchCount: 28 })
		], "liveWatchCount", Date.parse("2026-08-13T02:00:00.000Z"));
		expect(result).toMatchObject({ status: "ready", value: 8, note: "近1分钟变化 +8次" });
	});

	it("stale、offline、unknown 快照不参与短窗基线或共同窗口", () => {
		const nowMs = Date.parse("2026-08-13T02:00:00.000Z");
		const freshLatest = qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { liveWatchCount: 28 });
		expect(qianchuanDelta([qianchuanCumulativeSnapshot("2026-08-13T01:59:00.000Z", { liveWatchCount: 20 }, undefined, "stale"), freshLatest], "liveWatchCount", nowMs).status).toBe("baseline");
		expect(qianchuanDelta([qianchuanCumulativeSnapshot("2026-08-13T01:58:00.000Z", { liveWatchCount: 19 }, undefined, "offline"), qianchuanCumulativeSnapshot("2026-08-13T01:59:00.000Z", { liveWatchCount: 20 }), freshLatest], "liveWatchCount", nowMs).status).toBe("ready");
		expect(qianchuanDelta([qianchuanCumulativeSnapshot("2026-08-13T01:59:00.000Z", { liveWatchCount: 20 }), { ...freshLatest, dataStatus: "offline" }], "liveWatchCount", nowMs).status).toBe("baseline");
		expect(qianchuanClickToPaidWindow([funnelSnapshot("2026-08-13T01:59:00.000Z", 10, 2), { ...funnelSnapshot("2026-08-13T02:00:00.000Z", 20, 5), dataStatus: "unknown" }], nowMs).status).toBe("baseline");
		expect(selectQianchuanPaidTrendPoints([
			qianchuanCumulativeSnapshot("2026-08-13T01:59:00.000Z", { paidOrderCount: 2 }),
			qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { paidOrderCount: 5 }),
			qianchuanCumulativeSnapshot("2026-08-13T02:01:00.000Z", { paidOrderCount: 6 }, undefined, "stale")
		], Date.parse("2026-08-13T02:05:00.000Z"))).toEqual([{ observedAt: "2026-08-13T02:00:00.000Z", value: 3 }]);
		expect(qianchuanStatusLabel("stale")).toBe("已超过90秒未更新");
		expect(qianchuanStatusLabel("offline")).toBe("已离线");
		expect(qianchuanStatusLabel("unknown")).toBe("未接入");
		expect(qianchuanStatusLabel("partial")).toBe("部分停更");
		expect(liveSourceHeaderLabel({ status: "partial" })).toBe("部分停更");
		expect(liveSourceHeaderLabel({ status: "fresh", recovering: true })).toBe("恢复中");
		expect(liveSourceHeaderLabel({ status: "fresh", needLogin: true })).toBe("需要登录");
		expect(sourceGroupLine({ source: "qianchuan", group: "spend", status: "fresh" })).toBe("消耗 正常");
		expect(sourceGroupLine({ source: "qianchuan", group: "traffic", status: "stalled", lastSeenAt: "2026-08-21T07:57:00.000Z" }, Date.parse("2026-08-21T08:00:00.000Z"))).toBe("流量漏斗 3分钟前停止");
		expect(sourceGroupLine({ source: "compass", group: "product", status: "unknown" })).toBe("商品 等待讲解数据（只在讲解时更新）");
	});

  it("趋势锚定最新有效点、过滤未来与无效值并限制15分钟内最多15点", () => {
    const history = Array.from({ length: 20 }, (_, index) => ({ observedAt: new Date(Date.parse("2026-08-13T01:40:00.000Z") + index * 60_000).toISOString(), dataStatus: "fresh" as const, onlineSnapshot: index }));
    history.push({ observedAt: "2026-08-13T02:10:00.000Z", dataStatus: "fresh", onlineSnapshot: 999 });
    history.push({ observedAt: "2026-08-13T02:30:00.000Z", dataStatus: "fresh", onlineSnapshot: 1000 });
    expect(selectTrendPoints(history, "onlineSnapshot", Date.parse("2026-08-13T02:15:00.000Z"))).toEqual([15, 16, 17, 18, 19, 999]);
    expect(selectTrendPoints(history, "onlineSnapshot", Date.parse("2026-08-13T02:15:00.000Z"), Date.parse("2026-08-13T02:00:00.000Z"))).toEqual(Array.from({ length: 15 }, (_, index) => index + 5));
    expect(selectTrendPoints(history, "onlineSnapshot", Date.parse("2026-08-13T02:15:00.000Z"), Date.parse("2026-08-13T01:30:00.000Z"))).toEqual([]);
    expect(selectTrendPoints(history, "roomEnterCount5m", Date.parse("2026-08-13T02:15:00.000Z"))).toEqual([]);
  });

	 it("支付趋势也按共同全局时间轴过滤，不回退到更早窗口", () => {
    const history = [
      funnelSnapshot("2026-08-13T01:59:00.000Z", 10, 2),
      funnelSnapshot("2026-08-13T02:00:00.000Z", 20, 5),
      funnelSnapshot("2026-08-13T02:09:00.000Z", 29, 6),
      funnelSnapshot("2026-08-13T02:10:00.000Z", 30, 7)
    ];
    const anchor = trendAnchorMs([], history, Date.parse("2026-08-13T02:10:00.000Z"));
    expect(anchor).toBe(Date.parse("2026-08-13T02:10:00.000Z"));
    expect(selectQianchuanPaidTrendPoints(history, Date.parse("2026-08-13T02:10:00.000Z"), anchor)).toEqual([{ observedAt: "2026-08-13T02:00:00.000Z", value: 3 }, { observedAt: "2026-08-13T02:10:00.000Z", value: 1 }]);
    expect(selectQianchuanPaidTrendPoints(history, Date.parse("2026-08-13T02:10:00.000Z"), Date.parse("2026-08-13T02:00:00.000Z"))).toEqual([{ observedAt: "2026-08-13T02:00:00.000Z", value: 3 }]);
  });

  it("全局最新批次只有其他字段更新时，不回退旧字段差分或趋势点", () => {
    const history = [
      qianchuanCumulativeSnapshot("2026-08-13T01:59:00.000Z", { paidOrderCount: 2, adSpend: 100 }),
      qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { adSpend: 125 })
    ];
    const nowMs = Date.parse("2026-08-13T02:00:00.000Z");
    expect(qianchuanDelta(history, "paidOrderCount", nowMs)).toMatchObject({ status: "baseline", note: "待形成1分钟基线" });
    expect(selectQianchuanPaidTrendPoints(history, nowMs)).toEqual([]);
  });

  it("右栏用近15分钟累计，不用近1分钟差分，也不把整场累计标成15分钟", () => {
    const nowMs = Date.parse("2026-08-13T02:15:00.000Z");
    const fullWindow = [
      qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { paidOrderGmv: 100, paidOrderCount: 2, productClicks: 10, liveWatchCount: 40 }),
      qianchuanCumulativeSnapshot("2026-08-13T02:15:00.000Z", { paidOrderGmv: 160, paidOrderCount: 5, productClicks: 18, liveWatchCount: 52 })
    ];
    expect(qianchuanWindowDelta(fullWindow, "paidOrderGmv", nowMs)).toMatchObject({ status: "ready", value: 60, note: "近15分钟累计 +¥60.00" });
    expect(qianchuanWindowDelta(fullWindow, "paidOrderCount", nowMs)).toMatchObject({ status: "ready", value: 3, note: "近15分钟累计 +3单" });
    expect(qianchuanWindowDelta(fullWindow, "productClicks", nowMs)).toMatchObject({ status: "ready", value: 8 });
    expect(qianchuanWindowDelta(fullWindow, "liveWatchCount", nowMs)).toMatchObject({ status: "ready", value: 12 });
    expect(trendWindowUnit(qianchuanWindowDelta(fullWindow, "paidOrderGmv", nowMs), "money")).toBe("千川近15分钟累计 · 元");
    expect(trendWindowUnit(qianchuanWindowDelta(fullWindow, "liveWatchCount", nowMs), "count", true)).toBe("千川近15分钟累计，非去重进入人数");
    expect(qianchuanDelta(fullWindow, "paidOrderGmv", nowMs).status).toBe("baseline");

    const partial = [
      qianchuanCumulativeSnapshot("2026-08-13T02:07:00.000Z", { paidOrderGmv: 120 }),
      qianchuanCumulativeSnapshot("2026-08-13T02:15:00.000Z", { paidOrderGmv: 150 })
    ];
    expect(qianchuanWindowDelta(partial, "paidOrderGmv", nowMs)).toMatchObject({ status: "ready", value: 30, note: "近8分钟累计 +¥30.00" });

    const tooOldOnly = [
      qianchuanCumulativeSnapshot("2026-08-13T01:50:00.000Z", { paidOrderGmv: 40 }),
      qianchuanCumulativeSnapshot("2026-08-13T02:15:00.000Z", { paidOrderGmv: 160 })
    ];
    expect(qianchuanWindowDelta(tooOldOnly, "paidOrderGmv", nowMs)).toMatchObject({ status: "baseline", note: WAITING_QUARTER_BASELINE_NOTE });
    expect(formatQianchuanDeltaDisplay(qianchuanWindowDelta(tooOldOnly, "paidOrderGmv", nowMs), "money")).toBe(WAITING_QUARTER_BASELINE_NOTE);

    const preferFifteenOverEight = [
      qianchuanCumulativeSnapshot("2026-08-13T01:55:00.000Z", { paidOrderGmv: 20 }),
      qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { paidOrderGmv: 100 }),
      qianchuanCumulativeSnapshot("2026-08-13T02:07:00.000Z", { paidOrderGmv: 120 }),
      qianchuanCumulativeSnapshot("2026-08-13T02:15:00.000Z", { paidOrderGmv: 160 })
    ];
    expect(qianchuanWindowDelta(preferFifteenOverEight, "paidOrderGmv", nowMs)).toMatchObject({ status: "ready", value: 60 });

    expect(qianchuanWindowDelta([qianchuanCumulativeSnapshot("2026-08-13T02:15:00.000Z", { paidOrderGmv: 0 })], "paidOrderGmv", nowMs)).toMatchObject({ status: "ready", value: 0, note: "近15分钟累计 +¥0.00" });
    expect(qianchuanWindowDelta([qianchuanCumulativeSnapshot("2026-08-13T02:15:00.000Z", { paidOrderGmv: 80 })], "paidOrderGmv", nowMs)).toMatchObject({ status: "baseline", note: WAITING_QUARTER_BASELINE_NOTE });
    expect(qianchuanWindowDelta([
      qianchuanCumulativeSnapshot("2026-08-13T02:00:00.000Z", { paidOrderGmv: 180 }),
      qianchuanCumulativeSnapshot("2026-08-13T02:15:00.000Z", { paidOrderGmv: 160 })
    ], "paidOrderGmv", nowMs)).toMatchObject({ status: "reset", note: "基线已重置" });
  });
});

describe("副驾数字口径", () => {
  const qianchuanGmv: QianchuanMetricValue = { value: 1983, unit: "元", semantic: "cumulative", sourceField: "pay_order_gmv" };

  it("有千川成交和在线时，独立页与侧栏都对千川，不把罗盘累计支付混进同一格", () => {
    expect(copilotHeaderPayment({ compassFen: 207820, qianchuanGmv })).toEqual({ label: "千川成交", display: "¥1,983.00", source: "qianchuan" });
    expect(copilotOnlineSnapshot({ compassOnline: 5, qianchuanOnline: 4 })).toEqual({ value: 4, note: "千川实时在线" });
  });

  it("没有千川成交时才回退到标明来源的罗盘累计支付", () => {
    expect(copilotHeaderPayment({ compassFen: 207820 })).toEqual({ label: "罗盘累计支付", display: "¥2,078.20", source: "compass" });
    expect(copilotOnlineSnapshot({ compassOnline: 5 })).toEqual({ value: 5, note: "罗盘实时在线" });
  });

  it("未采集的 GMV 显示未采集，不用 0 代替", () => {
    expect(copilotHeaderPayment({})).toEqual({ label: "本场GMV", display: "未采集", source: "missing" });
    expect(formatFenAsYuan()).toBe("未采集");
    expect(formatFenAsYuan(12345)).toBe("¥123.45");
    expect(formatActionDealEvidence(null)).toBe("未读取到触发时数据");
    expect(formatActionDealEvidence({ observedAt: "2026-08-14T01:00:00.000Z", dataStatus: "fresh", sessionPaidGmvFen: 39800, productPayGmvFen: 1200, productClickCount: 18 })).toContain("GMV ¥398.00");
    expect(formatActionDealEvidence({ observedAt: "2026-08-14T01:00:00.000Z", dataStatus: "fresh", productClickCount: 18 })).toContain("GMV 未采集");
  });

  it("当前小时 vs 平时：n<3 和无样本不用 0 假对比", () => {
    const insufficient = formatHourComparison({
      metricKey: "gmvFen", grain: "hour", liveStatus: "ok", liveValue: 180000, liveCoverage: "hour_to_date",
      baseline: { status: "sampleInsufficient", grain: "hour", n: 2, reason: "n_lt_3" }
    });
    expect(insufficient.liveDisplay).toBe("¥1,800.00");
    expect(insufficient.vsDisplay).toBe("仅 2 场，不够出平时");
    expect(insufficient.note).toContain("对照平时这个点");
    expect(insufficient.note).not.toContain("grain=hour");
    expect(insufficient.vsDisplay).not.toBe("¥0.00");

    const none = formatHourComparison({
      metricKey: "gmvFen", grain: "hour", liveStatus: "missing", liveCoverage: "unavailable",
      baseline: { status: "sampleInsufficient", grain: "hour", n: 0, reason: "no_complete_samples" }
    });
    expect(none.liveDisplay).toBe("未采集");
    expect(none.vsDisplay).toBe("无样本");
    expect(none.bandLabel).toBe("");

    const forming = formatHourComparison({
      metricKey: "gmvFen", grain: "hour", liveStatus: "missing", liveCoverage: "hour_to_date",
      baseline: { status: "ok", grain: "hour", n: 6, median: 247100, p25: 180000, p75: 300000 }
    });
    expect(forming.liveDisplay).toBe("待形成");
    expect(forming.vsDisplay).toBe("本小时时段还在形成");
    expect(forming.bandLabel).toBe("");
    expect(clockHourLabel(5, 17)).toBe("周五 17:00–18:00");
    expect(clockHourSlotLabel(2, 14)).toBe("周二 14点");
    expect(monitoredDuration("2026-08-18T06:38:00.000Z", Date.parse("2026-08-18T06:58:00.000Z"))).toBe("20分钟");

    const midHour = hourMonitorPace("2026-08-18T06:38:00.000Z", Date.parse("2026-08-18T06:58:00.000Z"));
    expect(midHour).toMatchObject({ minutes: 20, startedMidHour: true, comparable: true, scaleBaseline: true });
    const paced = formatHourComparison({
      metricKey: "gmvFen", grain: "hour", liveStatus: "ok", liveValue: 191000, liveCoverage: "hour_to_date",
      baseline: { status: "ok", grain: "hour", n: 6, median: 247100, p25: 180000, p75: 300000 },
      band: "below_p25"
    }, midHour);
    expect(paced.liveDisplay).toBe("¥1,910.00");
    expect(paced.vsDisplay).toBe("已监测 20 分钟 · 按这个时长平时大约 ¥823.67");
    expect(paced.bandLabel).toBe("高于这时长的平时节奏");
    expect(paced.note).toContain("不是完整小时");
    expect(paced.vsDisplay).not.toContain("¥2,471.00");

    const tooShort = formatHourComparison({
      metricKey: "gmvFen", grain: "hour", liveStatus: "ok", liveValue: 12000, liveCoverage: "hour_to_date",
      baseline: { status: "ok", grain: "hour", n: 6, median: 247100, p25: 180000, p75: 300000 }
    }, hourMonitorPace("2026-08-18T06:58:00.000Z", Date.parse("2026-08-18T06:59:00.000Z")));
    expect(tooShort.vsDisplay).toBe("已监测 1 分钟，先不比高低");
    expect(tooShort.bandLabel).toBe("");

    const view = normalizeLiveView({
      session: { name: "现场", status: "running" },
      hourVsBaseline: {
        grain: "hour", weekday: 5, hour: 17,
        metrics: [{
          metricKey: "gmvFen", grain: "hour", liveStatus: "missing", liveCoverage: "unavailable",
          baseline: { status: "sampleInsufficient", grain: "hour", weekday: 5, hour: 17, metricKey: "gmvFen", n: 0, reason: "no_complete_samples" }
        }]
      }
    });
    expect(view.hourVsBaseline?.grain).toBe("hour");
    expect(view.hourVsBaseline?.metrics[0]?.baseline.status).toBe("sampleInsufficient");
    expect(view.diagnosis).toBeNull();
  });
});

describe("诊断 v2 四段与角色", () => {
  it("保留触发类型、执行状态、打扰决定和观察中", () => {
    const view = normalizeLiveView({
      session: { name: "现场", status: "running" },
      productRole: "trial_acquisition",
      diagnosis: {
        windowStartAt: "2026-08-21T00:15:00.000Z",
        windowEndAt: "2026-08-21T00:30:00.000Z",
        hourAlignment: { hour: 8, grain: "hour", note: "整点除以4只作弱参考，小偏离不作为动作。" },
        coverage: "full",
        provider: "deterministic-template",
        confidence: "leaning",
        actionKind: "close_gift",
        funnelStage: "spend_spike",
        streakCount: 1,
        triggerType: "scheduled_15m",
        executionState: "incomplete",
        interruptDecision: "interrupt",
        productRole: "value_bundle",
        previousActionOutcome: "observing",
        verdict: { id: "what", text: "消耗从 18 元到 113 元。", citedNumbers: [{ label: "这15分钟消耗", value: 113, unit: "元" }] },
        evidence: [{ id: "why", text: "转写里还缺小黄车指令。", citedNumbers: [{ label: "商品点击", value: 1, unit: "次" }] }],
        action: { id: "action", text: "补齐保障后接小黄车。", citedNumbers: [{ label: "窗口分钟", value: 15, unit: "分钟" }] },
        watchNext: { id: "watch", text: "未来5分钟先看商品点击。", citedNumbers: [{ label: "观察分钟", value: 5, unit: "分钟" }] },
        pending: [],
        conclusions: [{ id: "what", text: "消耗从 18 元到 113 元。", citedNumbers: [{ label: "这15分钟消耗", value: 113, unit: "元" }] }],
        nextWindowSuggestion: { id: "action", text: "补齐保障后接小黄车。", citedNumbers: [{ label: "窗口分钟", value: 15, unit: "分钟" }] },
        anomalies: []
      }
    });
    expect(view.productRole).toBe("trial_acquisition");
    expect(view.diagnosis?.triggerType).toBe("scheduled_15m");
    expect(view.diagnosis?.executionState).toBe("incomplete");
    expect(view.diagnosis?.interruptDecision).toBe("interrupt");
    expect(view.diagnosis?.previousActionOutcome).toBe("observing");
    expect(view.diagnosis?.verdict.text).toContain("113");
  });
});

describe("千川三率漏斗", () => {
  it("用同一张千川快照的累计次数现算三率，不含商品曝光率", () => {
    const funnel = qianchuanFourRateFunnel({
      observedAt: "2026-08-17T03:00:00.000Z",
      dataStatus: "fresh",
      metricSource: "qianchuan",
      metrics: {
        liveImpressions: { value: 10000, unit: "次", semantic: "cumulative", sourceField: "live_show_count_for_roi2" },
        liveWatchCount: { value: 2000, unit: "次", semantic: "cumulative", sourceField: "live_watch_count_for_roi2" },
        productImpressions: { value: 1500, unit: "次", semantic: "cumulative", sourceField: "live_product_show_count_for_roi2" },
        productClicks: { value: 300, unit: "次", semantic: "cumulative", sourceField: "live_product_click_count_for_roi2" },
        paidOrderCount: { value: 15, unit: "单", semantic: "cumulative", sourceField: "total_pay_order_count_for_roi2" }
      }
    });
    expect(funnel.source).toBe("qianchuan");
    expect(funnel.rates.map((item) => [item.label, item.display])).toEqual([
      ["曝光点击率", "20.00%"],
      ["商品曝光点击率", "20.00%"],
      ["商品点击转化率", "5.00%"]
    ]);
    expect(funnel.rates.some((item) => item.label === "商品曝光率")).toBe(false);
    expect(funnel.rates.find((item) => item.key === "productClickConvert")?.weak).toBe(true);
    expect(funnel.rates.filter((item) => item.weak)).toHaveLength(1);
  });

  it("缺字段或分母为 0 不写成 0%，也不用罗盘数字", () => {
    expect(qianchuanFourRateFunnel(null).rates.every((item) => item.display === "未采集")).toBe(true);
    const missing = qianchuanFourRateFunnel({
      observedAt: "2026-08-17T03:00:00.000Z",
      dataStatus: "fresh",
      metricSource: "qianchuan",
      metrics: {
        liveImpressions: { value: 10000, unit: "次", semantic: "cumulative", sourceField: "live_show_count_for_roi2" }
      }
    });
    expect(missing.rates[0]?.display).toBe("未采集");
    expect(missing.rates[0]?.display).not.toBe("0.00%");
    const zeroDenom = qianchuanFourRateFunnel({
      observedAt: "2026-08-17T03:00:00.000Z",
      dataStatus: "fresh",
      metricSource: "qianchuan",
      metrics: {
        liveImpressions: { value: 0, unit: "次", semantic: "cumulative", sourceField: "live_show_count_for_roi2" },
        liveWatchCount: { value: 0, unit: "次", semantic: "cumulative", sourceField: "live_watch_count_for_roi2" }
      }
    });
    expect(zeroDenom.rates[0]?.display).toBe("还算不了");
  });
});

describe("诊断卡运营文案", () => {
  it("丢掉累计回退说明，并把旧英文模板改成现场能看懂的中文", () => {
    const view = normalizeLiveView({
      session: { name: "现场", status: "running" },
      diagnosis: {
        windowStartAt: "2026-08-17T05:00:00.000Z",
        windowEndAt: "2026-08-17T05:15:00.000Z",
        hourAlignment: { hour: 13, grain: "hour", note: "15分钟窗对齐所属时钟小时基线，未把小时均分成15分钟" },
        coverage: "full",
        provider: "deterministic-template",
        conclusions: [
          { id: "counter-reset", text: "本窗累计口径出现 8 次回退，增量已按非负处理，不把回退写成负增长。", citedNumbers: [{ label: "回退次数", value: 8, unit: "次" }] },
          { id: "vs-hour-gmv", text: "本窗 GMV 0.00 元，对照所属 13 点小时基线中位数 684.00 元 (grain=hour, n=6, 不是 15 分钟真值)。", citedNumbers: [{ label: "GMV", value: 0, unit: "元" }] },
          { id: "speech-tags", text: "本窗话术已命中 6 个要点 (product_efficacy、price、offer、gift)，未命中项保持 unknown，不推断为没讲。", citedNumbers: [{ label: "要点", value: 6, unit: "个" }] }
        ],
        nextWindowSuggestion: { id: "next", text: "下一窗继续用 15 分钟增量对照 13 点小时基线中位数 684.00 元 (grain=hour)。", citedNumbers: [{ label: "中位数", value: 684, unit: "元" }] },
        anomalies: [{ type: "counter_reset", text: "本窗累计口径出现 8 次回退，增量已按非负处理，不把回退写成负增长。", citedNumbers: [{ label: "回退次数", value: 8, unit: "次" }] }]
      }
    });
    const diagnosis = view.diagnosis;
    expect(diagnosis).not.toBeNull();
    expect(diagnosis?.hourAlignment.note).toBe("整点除以4只作弱参考，小偏离不作为动作。");
    expect(diagnosis?.confidence).toBe("unknown");
    expect(diagnosis?.verdict.text).toContain("这15分钟成交");
    expect(diagnosis?.verdict.text).toContain("平时13点整小时大约");
    expect(diagnosis?.evidence.some((item) => item.text.includes("功效") && item.text.includes("赠品"))).toBe(true);
    expect(diagnosis?.action.text).toContain("下一刻先盯成交");
    expect(diagnosis?.anomalies).toEqual([]);
    const visible = [diagnosis?.hourAlignment.note, diagnosis?.verdict.text, ...(diagnosis?.evidence.map((item) => item.text) ?? []), diagnosis?.action.text].join("\n");
    expect(visible).not.toMatch(/grain=hour|product_efficacy|\bunknown\b|\bn=\d|累计口径|非负处理|负增长/);
  });

  it("模型改写后的诊断卡保留 ark-expression 标记", () => {
    const view = normalizeLiveView({
      session: { name: "现场", status: "running" },
      diagnosis: {
        windowStartAt: "2026-08-17T05:00:00.000Z",
        windowEndAt: "2026-08-17T05:15:00.000Z",
        hourAlignment: { hour: 13, grain: "hour", note: "历史是整点成交。对照时固定除以4，好和这15分钟比。" },
        coverage: "full",
        provider: "ark-expression",
        conclusions: [
          { id: "vs-hour-gmv", text: "这15分钟成交 0 元，均匀节奏大约 171 元。", citedNumbers: [{ label: "这15分钟成交", value: 0, unit: "元" }] }
        ],
        nextWindowSuggestion: { id: "next", text: "下一刻先补怎么买。", citedNumbers: [{ label: "均匀的话每15分钟", value: 171, unit: "元" }] },
        anomalies: []
      }
    });
    expect(view.diagnosis?.provider).toBe("ark-expression");
    expect(view.diagnosis?.conclusions[0]?.text).toContain("成交");
  });
});

describe("诊断卡引用数字", () => {
  it("把四段里的 citedNumbers 去重后收成可读筹码", () => {
    const view = normalizeLiveView({
      session: { name: "现场", status: "running" },
      diagnosis: {
        windowStartAt: "2026-08-17T05:00:00.000Z",
        windowEndAt: "2026-08-17T05:15:00.000Z",
        hourAlignment: { hour: 13, grain: "hour", note: "历史是整点成交。" },
        coverage: "full",
        provider: "deterministic-template",
        confidence: "confirmed",
        actionKind: "click_cta",
        funnelStage: "click",
        streakCount: 1,
        verdict: { id: "what", text: "消耗从 18 元到 113 元。", citedNumbers: [{ label: "这15分钟消耗", value: 113, unit: "元" }] },
        evidence: [{ id: "why", text: "点击还没跟上。", citedNumbers: [{ label: "商品点击", value: 1, unit: "次" }, { label: "这15分钟消耗", value: 113, unit: "元" }] }],
        action: { id: "action", text: "先补小黄车。", citedNumbers: [{ label: "窗口分钟", value: 15.256, unit: "分钟" }] },
        watchNext: { id: "watch", text: "先看商品点击。", citedNumbers: [{ label: "观察分钟", value: 5, unit: "分钟" }] },
        pending: [],
        conclusions: [],
        nextWindowSuggestion: { id: "next", text: "下一窗继续看点击。", citedNumbers: [{ label: "观察分钟", value: 5, unit: "分钟" }] },
        anomalies: []
      }
    });
    expect(view.diagnosis).not.toBeNull();
    const chips = collectDiagnosisCitations(view.diagnosis!);
    expect(chips.map(formatCitedNumber)).toEqual([
      "这15分钟消耗 113元",
      "商品点击 1次",
      "窗口分钟 15.26分钟",
      "观察分钟 5分钟"
    ]);
  });
});
