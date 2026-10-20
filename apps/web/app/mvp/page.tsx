"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MvpAction, MvpMetricPoint, MvpProduct, MvpRealReplayWindow, MvpSession, MvpStateSnapshot, MvpTranscriptEvidence } from "@live-growth/contracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://127.0.0.1:4100";
const SCENARIOS = [
  ["mvp_stable", "稳定运行"], ["mvp_traffic_surge", "流量突然涌入"], ["mvp_retention", "进人较多但留不住"],
  ["mvp_high_intent", "低流量但高意向"], ["mvp_high_click_low_pay", "点击较高但支付偏低"],
  ["mvp_standout", "商品表现突出"], ["mvp_low_efficiency", "整体低效，需要复位"], ["mvp_comprehensive", "综合场次（约 40 分钟）"]
] as const;
type MvpScenario = typeof SCENARIOS[number][0];
type FeedbackStatus = "executed" | "not_executed" | "not_applicable";
const REAL_SESSION_KEY = "live-growth-os:mvp-real-session";
const SIMULATION_SCENARIOS = SCENARIOS.slice(1);

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function homeLoadError(reason: unknown, fallback: string): string {
  if (reason instanceof ApiRequestError) return reason.message;
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/failed to fetch|networkerror|network request failed|econnrefused|fetch failed/i.test(message)) {
    return "本地服务未启动，请先运行 pnpm dev 后刷新页面";
  }
  return message || fallback;
}

function formatTime(value?: string): string {
  if (!value) return "未更新";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(value));
}

function moneyFen(value?: number): string {
  if (value === undefined) return "未更新";
  const decimals = value % 100 === 0 ? 0 : 2;
  return `¥${(value / 100).toLocaleString("zh-CN", { minimumFractionDigits: decimals, maximumFractionDigits: 2 })}`;
}

function percent(value: number | undefined): string {
  return value === undefined ? "未更新" : `${(value * 100).toFixed(1)}%`;
}

function sourceClock(milliseconds: number): string {
  const totalMinutes = 8 * 60 + Math.floor(milliseconds / 60_000);
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}:${String(Math.floor(milliseconds % 60_000 / 1000)).padStart(2, "0")}`;
}

function chartPath(values: number[], max: number, width = 720, height = 210): string {
  if (!values.length) return "";
  return values.map((value, index) => {
    const x = 28 + (values.length === 1 ? 0 : index * (width - 56) / (values.length - 1));
    const y = 18 + (height - 46) * (1 - value / max);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function TrendChart({ snapshot }: { snapshot: MvpStateSnapshot | null }) {
  const real = snapshot?.realReplayWindows;
  const simulation = snapshot?.metricTrend;
  const labels = real?.map((window) => window.sourceLocalClock)
    ?? simulation?.map((point, index) => index === 0 || index === simulation.length - 1 || index === Math.floor(simulation.length / 2) ? formatTime(point.at).slice(0, 5) : "")
    ?? [];
  const primary = real?.map((window) => window.onlineSnapshot) ?? simulation?.map((point) => point.online) ?? [];
  const secondary = real?.map((window) => window.productClickUv) ?? simulation?.map((point) => currentMetrics(point)?.clicks ?? 0) ?? [];
  const commonMax = Math.max(1, ...primary, ...secondary);
  return <div className="mvp-chart-wrap" data-testid="mvp-main-trend">
    <div className="mvp-chart-legend"><span className="online">{real ? "在线快照（窗口结束时点）" : "在线人数"}</span><span className="clicks">{real ? "商品点击UV（完整15分钟区间）" : "商品点击"}</span><small>{real ? "四个15分钟登记点，同一人数刻度；口径不同，不直接比较两条线高低" : "最近采样走势，同一人数刻度"}</small></div>
    {primary.length ? <svg viewBox="0 0 720 210" role="img" aria-label="在线人数与商品点击趋势">
      <line x1="28" x2="692" y1="182" y2="182" className="grid" />
      <path d={chartPath(primary, commonMax)} className="online-line" />
      <path d={chartPath(secondary, commonMax)} className="click-line" />
      {primary.map((value, index) => {
        const x = 28 + (primary.length === 1 ? 0 : index * 664 / (primary.length - 1));
        return <g key={`${labels[index]}:${index}`}><circle cx={x} cy={18 + 164 * (1 - value / commonMax)} r="4" className="online-dot" />{labels[index] && <text x={x} y="204" textAnchor="middle">{labels[index]}</text>}</g>;
      })}
    </svg> : <div className="mvp-chart-empty">打开一个场景后，这里先展示经营走势，再给判断。</div>}
  </div>;
}

function currentMetrics(point: MvpMetricPoint | null) {
  if (!point) return undefined;
  const product = point.products.find((item) => item.productId === point.currentProductId);
  if (!product) return undefined;
  const clickRate = product.exposure5m > 0 ? product.clicks5m / product.exposure5m : undefined;
  const payRate = product.clicks5m > 0 ? product.paidBuyers5m / product.clicks5m : undefined;
  return { clickRate, payRate, clicks: product.clicks5m, paidBuyers: product.paidBuyers5m, gmvFen: product.gmvFen5m };
}

type WindowDecision = { title: string; fact: string; action: string; tone: "watch" | "risk" | "positive" };
function realWindowDecision(window: MvpRealReplayWindow, previous?: MvpRealReplayWindow): WindowDecision {
  switch (window.sourceLocalClock) {
    case "08:15": return {
      title: "开播首窗，样本偏少",
      fact: "本窗口进入33、商品点击6、支付0；这是开播后的首个完整窗口，没有上一窗口可比。",
      action: "继续观察下一完整窗口，同时确认商品卡、价格与购买入口是否正常。",
      tone: "watch"
    };
    case "08:30": return {
      title: "消耗增加，成交仍未出现",
      fact: `本窗口消耗${moneyFen(window.adSpendFen)}、ROI 0；上一窗口消耗${moneyFen(previous?.adSpendFen)}、ROI 0。`,
      action: "运营先检查投流、人群、货盘和下单链路，再决定是否调整直播表达。",
      tone: "risk"
    };
    case "08:45": return {
      title: "成交集中在本窗口，值得复盘",
      fact: `本窗口点击${window.productClickUv}、支付${window.paidBuyerCount}、GMV${moneyFen(window.grossPaidGmvFen)}、ROI${window.grossRoi.toFixed(2)}；上一窗口点击${previous?.productClickUv ?? "—"}、支付${previous?.paidBuyerCount ?? "—"}。`,
      action: "复盘08:30—08:45已覆盖的话术和运营变化，记录可能有用的组合，但不把同窗变化写成因果。",
      tone: "positive"
    };
    default: return {
      title: "点击回落，支付未跟上",
      fact: `本窗口点击${window.productClickUv}、支付${window.paidBuyerCount}；上一窗口点击${previous?.productClickUv ?? "—"}、支付${previous?.paidBuyerCount ?? "—"}。`,
      action: "先核对08:45—09:00是否完成价格、权益、保障和购买指令；若已覆盖，运营检查货盘、人群、投流变化和下单链路，避免让主播机械重复。",
      tone: "risk"
    };
  }
}

const STATE_LABELS: Record<string, string> = {
  S0: "稳定运行", S1: "流量涌入，正在承接", S2: "进入较多，但留不住", S3: "低流量，高意向",
  S4: "点击较高，支付偏低", S5: "商品表现突出", S6: "整体低效，建议复位"
};
function statusLabel(status: MvpSession["status"]): string {
  return { created: "待开始", running: "直播中", stopped: "已停止", completed: "回放完成" }[status];
}

export default function MvpHome() {
  const [session, setSession] = useState<MvpSession | null>(null);
  const [snapshot, setSnapshot] = useState<MvpStateSnapshot | null>(null);
  const [products, setProducts] = useState<MvpProduct[]>([]);
  const [scenario, setScenario] = useState<MvpScenario>("mvp_comprehensive");
  const seed = 42;
  const [speed, setSpeed] = useState(5);
  const [reviewWindow, setReviewWindow] = useState<10 | 15>(15);
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedReplayClock, setSelectedReplayClock] = useState("09:00");
  const socketRef = useRef<WebSocket | null>(null);
  const reviewRequestSequence = useRef(0);

  const request = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    if (init?.body) headers.set("Content-Type", "application/json");
    const response = await fetch(`${API_URL}${path}`, { ...init, headers });
    const body = await response.json() as T & { error?: { message?: string } };
    if (!response.ok) throw new ApiRequestError(body.error?.message ?? "请求失败，请稍后重试", response.status);
    return body as T;
  }, []);

  const refresh = useCallback(async (id: string) => {
    const next = await request<MvpStateSnapshot>(`/api/mvp/sessions/${encodeURIComponent(id)}/state?window=${reviewWindow}`);
    setSession(next.session); setSnapshot(next);
  }, [request, reviewWindow]);

  const loadRealSession = useCallback(async () => {
    setError("公开版不附内部真实场次。请选择合成演示场景。");
    setInitialLoading(false);
  }, []);

  useEffect(() => { void request<MvpProduct[]>("/api/mvp/products").then(setProducts).catch(() => undefined); }, [request]);


  useEffect(() => {
    if (!session?.id || session.scenario === "mvp_real_session_001") return;
    const socket = new WebSocket(`${WS_URL}/ws/mvp/${encodeURIComponent(session.id)}?window=${reviewWindow}`);
    socketRef.current = socket;
    socket.addEventListener("message", (event) => {
      try {
        const body = JSON.parse(String(event.data)) as { type?: string; state?: MvpStateSnapshot; error?: string };
        if (body.state) { setSnapshot(body.state); setSession(body.state.session); }
        if (body.error) setError(body.error);
      } catch { setError("实时状态读取失败"); }
    });
    socket.addEventListener("error", () => setError("实时连接暂时中断，页面仍会保留已保存状态"));
    return () => { socket.close(); if (socketRef.current === socket) socketRef.current = null; };
  }, [session?.id, reviewWindow]);

  async function startScenario(selectedScenario: MvpScenario) {
    if (selectedScenario === "mvp_real_session_001") { await loadRealSession(); return; }
    setBusy(true); setError(null);
    try {
      const label = SCENARIOS.find(([key]) => key === selectedScenario)?.[1] ?? selectedScenario;
      const created = await request<MvpSession>("/api/mvp/sessions", { method: "POST", body: JSON.stringify({ scenario: selectedScenario, seed, name: `MVP 演示｜${label}` }) });
      const started = await request<MvpSession>(`/api/mvp/sessions/${created.id}/start`, { method: "POST", body: JSON.stringify({ speed }) });
      setScenario(selectedScenario); setReviewWindow(10); setSession(started);
      const loaded = await request<MvpStateSnapshot>(`/api/mvp/sessions/${started.id}/state?window=10`);
      setSnapshot(loaded);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "开始模拟直播失败"); }
    finally { setBusy(false); }
  }

  async function stopSession() {
    if (!session) return;
    setBusy(true); setError(null);
    try { const updated = await request<MvpSession>(`/api/mvp/sessions/${session.id}/stop`, { method: "POST" }); setSession(updated); await refresh(updated.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "停止回放失败"); }
    finally { setBusy(false); }
  }

  async function changeReviewWindow(windowMinutes: 10 | 15) {
    if (!session || session.scenario === "mvp_real_session_001") return;
    const requestSequence = ++reviewRequestSequence.current;
    try {
      const next = await request<MvpStateSnapshot>(`/api/mvp/sessions/${encodeURIComponent(session.id)}/state?window=${windowMinutes}`);
      if (requestSequence !== reviewRequestSequence.current) return;
      setReviewWindow(windowMinutes);
      setSession(next.session); setSnapshot(next);
    } catch (reason) {
      if (requestSequence === reviewRequestSequence.current) setError(reason instanceof Error ? reason.message : "小复盘读取失败");
    }
  }

  async function feedback(action: MvpAction, status: FeedbackStatus) {
    if (!session) return;
    setBusy(true); setError(null);
    try { await request(`/api/mvp/sessions/${session.id}/feedback`, { method: "POST", body: JSON.stringify({ adviceId: action.id, status, operatorId: "operator-demo" }) }); await refresh(session.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存执行反馈失败"); }
    finally { setBusy(false); }
  }

  if (initialLoading && !snapshot) {
    return <main className="mvp-shell mvp-dark mvp-business-home">
      <header className="mvp-loading-header"><p>LIVE GROWTH OS</p><h1>直播运营副驾</h1></header>
      <section className="mvp-initial-loading" role="status" data-testid="mvp-initial-loading"><span /><p>正在启动合成演示场景</p></section>
    </main>;
  }

  if (!snapshot || !session) {
    return <main className="mvp-shell mvp-dark mvp-business-home">
      <header className="mvp-loading-header"><p>LIVE GROWTH OS</p><h1>直播运营副驾</h1></header>
      <section className="mvp-initial-loading">
        <p>选择一个合成场景，查看原应用的指标与建议流程。</p>
        <small>请先运行 pnpm dev。此入口不读取内部真实场次或录音。</small>
        <label>演示场景 <select value={scenario} onChange={(event) => setScenario(event.target.value as MvpScenario)} disabled={busy}>
          {SCENARIOS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <button className="mvp-primary" disabled={busy} onClick={() => void startScenario(scenario)}>{busy ? "正在启动" : "启动合成场景"}</button>
        {error && <p role="alert">{error}</p>}
      </section>
    </main>;
  }

  const point = snapshot.latestPoint ?? null;
  const metrics = currentMetrics(point);
  const action = snapshot?.action ?? null;
  const feedbackForAction = action ? snapshot?.feedback.find((item) => item.adviceId === action.id) : undefined;
  const recentActions = snapshot.recentActions.slice().reverse().slice(0, 5);
  const productName = (id?: string) => {
    if (!id) return "待确认";
    const product = products.find((item) => item.productId === id);
    return product?.name ?? id;
  };
  const stateHeading = snapshot.preheat || snapshot.stale ? snapshot.stateName : (snapshot.state ? (STATE_LABELS[snapshot.state] ?? snapshot.stateName) : snapshot.stateName);
  const realWindows = snapshot.realReplayWindows;
  const isRealReplay = Boolean(snapshot.replayMetadata && realWindows?.length);
  const simulationRunning = !isRealReplay && session.status === "running";
  const latestRealWindow = realWindows?.at(-1);
  const selectedRealWindow = realWindows?.find((window) => window.sourceLocalClock === selectedReplayClock) ?? latestRealWindow;
  const transcriptById = new Map((snapshot?.transcriptEvidence ?? []).map((segment) => [segment.id, segment]));
  const selectedEvidence = selectedRealWindow?.transcriptEvidenceIds.map((id) => transcriptById.get(id)).filter((segment): segment is MvpTranscriptEvidence => Boolean(segment)) ?? [];
  const evidenceCutoffMs = selectedRealWindow && snapshot?.replayMetadata ? Date.parse(selectedRealWindow.windowEndAt) - Date.parse(snapshot.replayMetadata.sessionStartAt) : 0;
  const selectedWindowIndex = selectedRealWindow && realWindows ? realWindows.indexOf(selectedRealWindow) : -1;
  const previousRealWindow = selectedWindowIndex > 0 ? realWindows?.[selectedWindowIndex - 1] : undefined;
  const decision = selectedRealWindow ? realWindowDecision(selectedRealWindow, previousRealWindow) : undefined;
  const businessKpis = isRealReplay && selectedRealWindow ? [
    { key: "online", label: "当前在线", value: String(selectedRealWindow.onlineSnapshot), note: `${selectedRealWindow.sourceLocalClock} 窗口结束` },
    { key: "entry", label: "直播间进入", value: String(selectedRealWindow.roomEnterUv), note: "完整15分钟" },
    { key: "entry-rate", label: "曝光进入率", value: percent(selectedRealWindow.roomEntryRate), note: "完整15分钟" },
    { key: "product-click", label: "商品点击", value: String(selectedRealWindow.productClickUv), note: "完整15分钟" },
    { key: "paid-buyers", label: "支付买家", value: String(selectedRealWindow.paidBuyerCount), note: "完整15分钟" },
    { key: "gmv", label: "GMV／ROI", value: `${moneyFen(selectedRealWindow.grossPaidGmvFen)}／${selectedRealWindow.grossRoi.toFixed(2)}`, note: "完整15分钟" }
  ] : [
    { key: "online", label: "当前在线", value: String(point?.online ?? "未更新"), note: "当前快照" },
    { key: "entry", label: "直播间进入", value: String(point?.enters1m ?? "未更新"), note: "最近1分钟" },
    { key: "retention", label: "留存指标", value: percent(point?.retentionProxy), note: "当前表现" },
    { key: "product-click", label: "商品点击", value: String(metrics?.clicks ?? "未更新"), note: "最近5分钟" },
    { key: "paid-buyers", label: "支付人数", value: String(metrics?.paidBuyers ?? "未更新"), note: "最近5分钟" },
    { key: "gmv", label: "GMV／ROI", value: `${moneyFen(metrics?.gmvFen)}／${point?.traffic.roi.toFixed(2) ?? "未更新"}`, note: "最近5分钟" }
  ];

  return <main className="mvp-shell mvp-dark mvp-business-home">
    <header className="mvp-session-bar" data-testid="mvp-source-banner">
      <div className="mvp-brand-lockup"><p>LIVE GROWTH OS</p><h1>直播运营副驾</h1></div>
      <dl className="mvp-session-meta">
        <div><dt>场次</dt><dd>{isRealReplay ? "内部回放未收录" : session.name}</dd></div>
        <div><dt>主播</dt><dd>{isRealReplay ? "未提供" : "演示主播"}</dd></div>
        <div><dt>数据</dt><dd>{isRealReplay ? "08:00—09:00" : formatTime(snapshot.updatedAt)}</dd></div>
        <div><dt>商品</dt><dd>{isRealReplay ? "商品未登记" : productName(snapshot.currentProductId)}</dd></div>
      </dl>
      <span className={`mvp-replay-status${isRealReplay ? " real" : ""}`}>{isRealReplay ? "离线回放" : statusLabel(session.status)}</span>
    </header>

    <section className="mvp-launchbar" aria-label="真实直播接入"><div><strong>真实直播试点</strong><span>先在罗盘打开直播并解除静音，再从 Chrome 扩展连接</span></div><div><Link className="mvp-primary" href="/live">查看接入说明</Link></div></section>

    {error && <div className="mvp-alert" role="alert">{error}</div>}

    <section className="mvp-kpi-band" aria-labelledby="overview-title">
      <div className="mvp-section-heading"><div><span className="mvp-section-kicker">当前数据</span><h2 id="overview-title">{isRealReplay ? `${selectedRealWindow?.sourceLocalClock} 经营表现` : "当前直播表现"}</h2></div><span>{isRealReplay ? "15分钟区间 · 在线为窗口结束快照" : `更新于 ${formatTime(snapshot.updatedAt)}`}</span></div>
      <div className="mvp-kpi-grid" aria-label="核心数据">{businessKpis.map((kpi) => <article key={kpi.key} data-testid={`kpi-${kpi.key}`}><span>{kpi.label}</span><strong>{kpi.value}</strong><small>{kpi.note}</small></article>)}</div>
    </section>

    <div className="mvp-primary-grid">
      <section className="mvp-trend-panel" aria-label="经营趋势和窗口切换">
        <div className="mvp-card-heading"><div><span className="mvp-section-kicker">发生了什么</span><h2>{isRealReplay ? "四个15分钟窗口" : "经营趋势"}</h2></div><span className="mvp-muted">{isRealReplay ? "点击窗口查看对应表现" : "最近采样"}</span></div>
        <TrendChart snapshot={snapshot} />
        {isRealReplay && realWindows && <div className="mvp-window-tabs" aria-label="真实样本窗口">{realWindows.map((window) => <button key={window.sourceLocalClock} className={selectedRealWindow?.sourceLocalClock === window.sourceLocalClock ? "active" : ""} onClick={() => setSelectedReplayClock(window.sourceLocalClock)}><strong>{window.sourceLocalClock}</strong><span>点击 {window.productClickUv} · 支付 {window.paidBuyerCount}</span></button>)}</div>}
      </section>

      <aside className={`mvp-decision-card ${decision?.tone ?? ""}`} data-testid="mvp-business-decision">
        <span className="mvp-section-kicker">经营判断</span>
        <h2>{decision?.title ?? stateHeading}</h2>
        <p className="mvp-decision-fact">{decision?.fact ?? (snapshot.preheat ? "正在积累最初样本，先观察直播表现。" : snapshot.stale ? "数据暂时没有更新，等待下一次采样。" : action?.whatHappened ?? "当前没有需要立即调整的问题。")}</p>
        <div className="mvp-action-block"><span>建议动作</span>{decision ? <p>{decision.action}</p> : action ? <p>{action.coreInstruction}</p> : <p>保持当前节奏，继续观察下一轮数据。</p>}</div>
        {!isRealReplay && action && <div className="mvp-simulation-action">
          <div><span>商品策略</span><p>{action.productStrategy}</p></div>
          <div><span>判断依据</span><ul>{action.evidence.map((item) => <li key={`${item.label}:${item.value}`}>{item.label}：{item.value}</li>)}</ul></div>
          <div className="mvp-feedback"><span>现场执行结果</span>{feedbackForAction ? <strong className="mvp-saved-feedback">已保存：{feedbackForAction.status === "executed" ? "已执行" : feedbackForAction.status === "not_executed" ? "未执行" : "不适用"}</strong> : <><button disabled={busy} onClick={() => void feedback(action, "executed")}>已执行</button><button disabled={busy} onClick={() => void feedback(action, "not_executed")}>未执行</button><button disabled={busy} onClick={() => void feedback(action, "not_applicable")}>不适用</button></>}</div>
        </div>}
      </aside>
    </div>

    {isRealReplay && selectedRealWindow ? <>
      <div className="mvp-detail-grid">
        <section className="mvp-funnel-panel" data-testid="mvp-window-funnel">
          <div className="mvp-card-heading"><div><span className="mvp-section-kicker">本窗口漏斗</span><h2>{selectedRealWindow.sourceLocalClock} 窗口</h2></div><span className="mvp-muted">完整15分钟</span></div>
          <div className="mvp-funnel-flow">
            {[["直播间曝光", selectedRealWindow.roomImpressionUv], ["进入", selectedRealWindow.roomEnterUv], ["商品曝光", selectedRealWindow.productImpressionUv], ["商品点击", selectedRealWindow.productClickUv], ["支付买家", selectedRealWindow.paidBuyerCount]].map(([label, value], index) => <div key={String(label)}><span>{label}</span><strong>{value}</strong>{index < 4 && <i aria-hidden="true">→</i>}</div>)}
          </div>
          <div className="mvp-rate-row"><span>曝光进入率 {percent(selectedRealWindow.roomEntryRate)}</span><span>商品点击率 {percent(selectedRealWindow.productClickRate)}</span><span>点击支付率 {percent(selectedRealWindow.clickToPaidRate)}</span></div>
        </section>
        <section className="mvp-transcript-panel" data-testid="mvp-window-transcript" data-window-end-ms={evidenceCutoffMs}>
          <div className="mvp-transcript-heading"><h2>{selectedRealWindow.sourceLocalClock} 前已发生话术</h2><span>转写待校对</span></div>
          <div className="mvp-transcript-list">{selectedEvidence.map((segment) => <article key={segment.id} data-evidence-end-ms={segment.endMs}><time>{sourceClock(segment.startMs)}—{sourceClock(segment.endMs)}</time><p>{segment.text}</p></article>)}</div>
        </section>
      </div>
      <section className="mvp-window-comparison">
        <div className="mvp-card-heading"><div><span className="mvp-section-kicker">四窗对比</span><h2>一小时经营变化</h2></div><span className="mvp-muted">按来源本地时钟</span></div>
        <div className="mvp-window-table">{realWindows?.map((window) => <article key={window.sourceLocalClock} className={selectedRealWindow.sourceLocalClock === window.sourceLocalClock ? "active" : ""} onClick={() => setSelectedReplayClock(window.sourceLocalClock)}><time>{window.sourceLocalClock}</time><span>进入 <strong>{window.roomEnterUv}</strong></span><span>商品点击 <strong>{window.productClickUv}</strong></span><span>支付 <strong>{window.paidBuyerCount}</strong></span><span>GMV <strong>{moneyFen(window.grossPaidGmvFen)}</strong></span><span>ROI <strong>{window.grossRoi.toFixed(2)}</strong></span></article>)}</div>
      </section>
    </> : <section className="mvp-window-comparison mvp-simulation-history">
      <div className="mvp-card-heading"><div><span className="mvp-section-kicker">最近行动</span><h2>本场变化记录</h2></div><div className="mvp-history-actions"><label>复盘窗口<select value={reviewWindow} onChange={(event) => void changeReviewWindow(Number(event.target.value) as 10 | 15)}><option value={10}>10 分钟</option><option value={15}>15 分钟</option></select></label><Link href={`/mvp-review/${session.id}`}>查看整场复盘</Link></div></div>
      {recentActions.length ? <div className="mvp-sim-timeline">{recentActions.map((item) => <article key={item.id}><time>{formatTime(item.createdAt)}</time><div><strong>{STATE_LABELS[item.state] ?? item.state}</strong><p>{item.whatHappened}</p></div></article>)}</div> : <p className="mvp-muted">本场暂时没有需要记录的动作。</p>}
      <div className="mvp-inline-review" data-testid="mvp-small-review" data-window-minutes={snapshot.smallReview?.windowMinutes ?? ""}><h3>{reviewWindow} 分钟小复盘</h3>{snapshot.smallReview ? <ol className="mvp-small-review">{snapshot.smallReview.lines.map((line) => <li key={line}>{line}</li>)}</ol> : <p className="mvp-muted">正在积累本窗口数据。</p>}</div>
    </section>}

    <p className="mvp-data-note">{isRealReplay ? "数据每15分钟登记一次；在线人数为窗口结束快照；转写待校对。" : "当前为确定性模拟场景，用于体验操作流程。"}</p>
    <details className="mvp-demo-tools">
      <summary>演示工具 <span>模拟场景与辅助入口</span></summary>
      <div className="mvp-tool-grid">
        <label>演示场景<select value={scenario} onChange={(event) => setScenario(event.target.value as MvpScenario)}>{SIMULATION_SCENARIOS.map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
        <label>回放速度<select value={speed} disabled={session.status === "running" && !isRealReplay} onChange={(event) => setSpeed(Number(event.target.value))}><option value={1}>1×（接近实况）</option><option value={5}>5×（演示）</option><option value={20}>20×（快速）</option></select></label>
        <div className="mvp-control-buttons"><button className="mvp-primary" onClick={() => void startScenario(scenario)} disabled={busy || simulationRunning}>启动所选演示</button>{simulationRunning && <button className="mvp-danger" onClick={() => void stopSession()} disabled={busy}>停止当前演示</button>}</div>
      </div>
      <div className="mvp-scenario-launchers">{SIMULATION_SCENARIOS.slice(0, 7).map(([key, label]) => <button key={key} data-testid={`scenario-${key.replaceAll("_", "-")}`} className="mvp-ghost" onClick={() => void startScenario(key)} disabled={busy || simulationRunning}>{label}</button>)}</div>
      <nav className="mvp-tool-links"><Link href="/products">商品配置</Link>{!isRealReplay && <Link href={`/mvp-review/${session.id}`}>整场复盘</Link>}<Link href="/lab">实验页面</Link></nav>
    </details>
  </main>;

}
