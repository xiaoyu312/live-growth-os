"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveEvent, MetricSnapshot, Scenario, Session, SessionState, SourceHealth, SpeechTag } from "@live-growth/contracts";
import Link from "next/link";
import { AdviceCard, type AdviceAction, RuleStatusList } from "../advice-ui";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://127.0.0.1:4100";

const scenarioNames: Record<Scenario, string> = {
  stable: "正常稳定",
  low_click: "直播间进入正常，但点击低",
  low_payment: "点击高，但支付低",
  online_drop: "在线快速下降",
  roi_drop: "消耗加速，ROI 下降",
  price_close_improves: "完整价格收口后改善",
  no_cta: "长时间缺少行动指令",
  price_objection: "价格异议集中",
  long_knowledge: "知识讲解过长",
  positive_segment: "正向高效片段",
  historical_morning: "历史校准（公开版未提供）",
  historical_afternoon: "历史校准（公开版未提供）",
  historical_evening: "历史校准（公开版未提供）",
  mvp_stable: "MVP｜稳定运行",
  mvp_traffic_surge: "MVP｜流量突然涌入",
  mvp_retention: "MVP｜进人较多但留不住",
  mvp_high_intent: "MVP｜低流量但高意向",
  mvp_high_click_low_pay: "MVP｜点击较高但支付偏低",
  mvp_standout: "MVP｜商品表现突出",
  mvp_low_efficiency: "MVP｜整体低效",
  mvp_comprehensive: "MVP｜综合场次",
  live_compass: "真实直播｜罗盘"
};


const speechTagNames: Record<SpeechTag, string> = {
  opening: "开场", interaction: "互动", product_benefit: "商品利益", ingredient_or_principle: "成分原理",
  usage_scenario: "使用场景", price: "价格", gift: "赠品", trust: "信任", guarantee: "保障",
  objection_handling: "异议处理", urgency: "紧迫感", cta: "行动指令", transition: "转场", other: "其他"
};

const eventKindNames: Record<LiveEvent["kind"], string> = {
  "metric.snapshot": "指标快照", "metric.delta": "指标增量", "speech.partial": "临时话术",
  "speech.final": "确认话术", "speech.tag": "话术标签", "comment.raw": "原始评论",
  "comment.intent": "评论意图", "product.round.started": "商品轮次开始", "product.round.ended": "商品轮次结束",
  "product.changed": "商品切换", "traffic.changed": "投流变化", "rule.triggered": "建议条件满足",
  "advice.created": "建议创建", "advice.feedback": "建议反馈", "advice.execution": "建议执行",
  "advice.delivery": "建议送达", "advice.outcome": "效果观察", "rule.status": "判断状态",
  "business.review.submitted": "业务建议评分", "source.health": "数据源健康", "session.marker": "场次标记",
  "mvp.point": "MVP 指标", "mvp.action": "MVP 行动", "mvp.feedback": "MVP 执行反馈",
  "live.compass.metric": "罗盘直播指标", "live.qianchuan.metric": "千川数据更新", "live.compass.action": "真实直播行动", "live.compass.action.feedback": "行动已反馈", "live.compass.action.resolved": "问题已缓解", "live.product.context": "商品角色", "live.operator.settings": "运营规则设置", "live.operator.observation": "运营现场确认", "live.operator.state": "运营规则复查"
};

const sourceNames: Record<LiveEvent["source"], string> = {
  simulator: "模拟器", replay: "历史回放", csv_import: "表格导入", manual: "手动接入",
  browser_extension: "浏览器插件", official_api: "官方接口", asr: "语音识别", operator: "运营操作", system: "系统分析"
};

const sourceHealthNames: Record<string, string> = { "simulator-metrics": "模拟经营指标", "comment-intent": "评论意图" };

type ConnectionStatus = "未连接" | "连接中" | "在线" | "重连中" | "离线";
type InfrastructureHealth = {
  persistenceMode: string;
  storage: "memory-demo" | "postgres";
  postgres: { status: "healthy" | "degraded" | "offline" | "not_configured" };
  pgvector: { status: "healthy" | "degraded" | "offline" | "not_configured" };
  redis: { status: "healthy" | "degraded" | "offline" | "not_configured" };
};

function storageStatusClass(health: InfrastructureHealth | null): "healthy" | "degraded" | "offline" {
  if (!health) return "offline";
  if (health.storage === "memory-demo") return "healthy";
  return health.postgres.status === "healthy" && health.pgvector.status === "healthy" ? "healthy" : "degraded";
}

function displayNumber(value: number | undefined, options?: Intl.NumberFormatOptions): string {
  return value === undefined ? "未接入" : new Intl.NumberFormat("zh-CN", options).format(value);
}

function displayRate(value: number | undefined): string {
  return value === undefined ? "未接入" : `${(value * 100).toFixed(1)}%`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(value));
}

function statusText(status: Session["status"]): string {
  return { created: "待开播", running: "直播中", stopped: "已停止", completed: "回放完成" }[status];
}

function metricValue(metrics: MetricSnapshot, canonical: string, legacy: string): number | undefined {
  const record = metrics as Record<string, unknown>;
  const value = record[canonical] ?? record[legacy];
  return typeof value === "number" ? value : undefined;
}

function Sparkline({ points }: { points: SessionState["metricTrend"] }) {
  const values = points.map((point) => metricValue(point.values, "concurrent_viewers", "onlineUsers")).filter((value): value is number => value !== undefined);
  if (values.length < 2) return <div className="empty-chart">在线趋势未接入</div>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const path = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = 35 - ((value - min) / range) * 31;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return (
    <svg className="sparkline" viewBox="0 0 100 40" role="img" aria-label={`当前在线趋势，共 ${values.length} 个点`} preserveAspectRatio="none">
      <defs><linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#ffb14a" stopOpacity=".4"/><stop offset="1" stopColor="#ffb14a" stopOpacity="0"/></linearGradient></defs>
      <path d={`${path} L100,40 L0,40 Z`} fill="url(#lineFill)"/><path d={path} fill="none" stroke="#ffb14a" strokeWidth="1.4" vectorEffect="non-scaling-stroke"/>
    </svg>
  );
}

function KpiCard({ label, value, secondary, missing = false }: { label: string; value: string; secondary?: string; missing?: boolean }) {
  return <article className={`kpi-card${missing ? " is-missing" : ""}`}><span>{label}</span><strong>{value}</strong><small>{secondary ?? (missing ? "当前源未提供此字段" : "30 秒快照")}</small></article>;
}

function SourceBadge({ health }: { health: SourceHealth }) {
  const label = { healthy: "正常", degraded: "延迟", offline: "离线", unauthorized: "未授权" }[health.status];
  return <li className="source-row"><span className={`status-dot ${health.status}`} aria-hidden="true"/><div><strong title={health.sourceId}>{sourceHealthNames[health.sourceId] ?? health.sourceId}</strong><small>{health.message ?? "无补充信息"}</small></div><b>{label}</b></li>;
}

export default function Dashboard() {
  const [state, setState] = useState<SessionState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("未连接");
  const [scenario, setScenario] = useState<Scenario>("stable");
  const [seed, setSeed] = useState(42);
  const [speed, setSpeed] = useState(60);
  const [includeComments, setIncludeComments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyAdviceId, setBusyAdviceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [infrastructure, setInfrastructure] = useState<InfrastructureHealth | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const shouldReconnect = useRef(true);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${API_URL}/health`);
        if (!response.ok) throw new Error("健康检查失败");
        const health = await response.json() as InfrastructureHealth;
        if (active) setInfrastructure(health);
      } catch {
        if (active) setInfrastructure(null);
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("sessionId");
    if (!sessionId) return;
    let active = true;
    setBusy(true);
    fetch(`${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/state`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? "历史场次恢复失败");
        if (active) setState(body as SessionState);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "历史场次恢复失败"); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  const connect = useCallback((sessionId: string, reconnect = false) => {
    setConnection(reconnect ? "重连中" : "连接中");
    const socket = new WebSocket(`${WS_URL}/ws/sessions/${sessionId}`);
    socketRef.current = socket;
    socket.addEventListener("open", () => setConnection("在线"));
    socket.addEventListener("message", (message) => {
      const body = JSON.parse(String(message.data)) as { type: string; state?: SessionState; error?: string };
      if (body.type === "state.snapshot" && body.state) setState(body.state);
      if (body.type === "session.error") setError(body.error ?? "实时连接失败");
    });
    socket.addEventListener("close", () => {
      if (socketRef.current === socket) socketRef.current = null;
      setConnection("离线");
      if (shouldReconnect.current) retryRef.current = setTimeout(() => connect(sessionId, true), 600);
    });
    socket.addEventListener("error", () => setConnection("离线"));
    return socket;
  }, []);

  useEffect(() => {
    if (!state?.session.id) return;
    shouldReconnect.current = true;
    const socket = connect(state.session.id);
    return () => {
      shouldReconnect.current = false;
      if (retryRef.current) clearTimeout(retryRef.current);
      socket.close();
    };
  }, [state?.session.id, connect]);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body) headers.set("Content-Type", "application/json");
    const response = await fetch(`${API_URL}${path}`, { ...init, headers });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? "请求失败");
    return body as T;
  }

  async function createSession() {
    setBusy(true); setError(null);
    try {
      const session = await request<Session>("/api/sessions", { method: "POST", body: JSON.stringify({ name: `独立合成模拟场 ${seed}`, scenario, seed, includeCommentIntent: includeComments }) });
      window.history.replaceState(null, "", `?sessionId=${encodeURIComponent(session.id)}`);
      setState(await request<SessionState>(`/api/sessions/${session.id}/state`));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败"); }
    finally { setBusy(false); }
  }

  async function startSession() {
    if (!state) return;
    setBusy(true); setError(null);
    try {
      await request(`/api/sessions/${state.session.id}/start`, { method: "POST", body: JSON.stringify({ speed }) });
      setState(await request<SessionState>(`/api/sessions/${state.session.id}/state`));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "启动失败"); }
    finally { setBusy(false); }
  }

  async function stopSession() {
    if (!state) return;
    setBusy(true);
    try {
      await request(`/api/sessions/${state.session.id}/stop`, { method: "POST" });
      setState(await request<SessionState>(`/api/sessions/${state.session.id}/state`));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "停止失败"); }
    finally { setBusy(false); }
  }

  async function actOnAdvice(adviceId: string, action: AdviceAction) {
    if (!state) return;
    setBusyAdviceId(adviceId); setError(null);
    try {
      if (action.kind === "feedback") {
        await request(`/api/advices/${encodeURIComponent(adviceId)}/feedback`, {
          method: "POST", body: JSON.stringify({ type: action.type, operatorId: "operator-demo" })
        });
      } else if (action.kind === "execution") {
        await request(`/api/advices/${encodeURIComponent(adviceId)}/executions`, {
          method: "POST", body: JSON.stringify({ status: action.status, operatorId: "operator-demo" })
        });
      } else {
        await request(`/api/advices/${encodeURIComponent(adviceId)}/confounded`, {
          method: "POST", body: JSON.stringify({ operatorId: "operator-demo", reason: "现场存在其他干扰" })
        });
      }
      setState(await request<SessionState>(`/api/sessions/${state.session.id}/state`));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "建议操作失败"); }
    finally { setBusyAdviceId(null); }
  }

  const metrics: MetricSnapshot = state?.latestMetrics ?? {};
  const currentOnline = metricValue(metrics, "concurrent_viewers", "onlineUsers");
  const roomEnter = metricValue(metrics, "room_enter_uv", "entersPerMin");
  const productClickRate = metricValue(metrics, "product_click_rate", "productClickRate");
  const paidConversionRate = metricValue(metrics, "click_to_paid_rate", "payConversionRate");
  const grossPaidGmvFen = metricValue(metrics, "gross_paid_gmv_fen", "gmvTotal");
  const adSpendFen = metricValue(metrics, "ad_spend_fen", "adSpendTotal");
  const roi = metricValue(metrics, "gross_roi", "roi");
  const avgWatchSec = metricValue(metrics, "avg_watch_sec", "avgWatchSec");
  const canonicalMetrics = "concurrent_viewers" in metrics || "room_enter_uv" in metrics;
  const latestEvents = useMemo(() => state?.recentEvents.slice().reverse().slice(0, 18) ?? [], [state?.recentEvents]);

  return (
    <main>
      <header className="masthead">
        <div className="brand"><span className="brand-mark">LG</span><div><p>LIVE GROWTH OS</p><h1>直播经营导播台</h1></div></div>
        <div className="system-statuses" style={{ display: "flex", gap: 22, alignItems: "center" }}>
          <div className="live-status"><span data-testid="persistence-status" className={`status-dot ${storageStatusClass(infrastructure)}`}/><div><small>存储模式</small><strong data-testid="persistence-mode">{infrastructure?.persistenceMode ?? "健康状态不可用"}</strong></div></div>
          <div className="live-status"><span className={`status-dot ${connection === "在线" ? "healthy" : "offline"}`}/><div><small>实时链路</small><strong data-testid="connection-status">{connection}</strong></div></div>
        </div>
      </header>

      <section className="control-strip" aria-label="模拟场次控制">
        <label>模拟场景<select value={scenario} onChange={(event) => setScenario(event.target.value as Scenario)} disabled={Boolean(state)}>{Object.entries(scenarioNames).filter(([value]) => !value.startsWith("historical_") && value !== "live_compass").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>固定 seed<input type="number" value={seed} onChange={(event) => setSeed(Number(event.target.value))} disabled={Boolean(state)}/></label>
        <label>回放速度<select aria-label="回放速度" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} disabled={state?.session.status === "running"}><option value={60}>60×（约 30 秒）</option><option value={120}>120×（约 15 秒）</option><option value={3600}>极速（测试）</option></select></label>
        <label className="checkbox"><input type="checkbox" checked={includeComments} onChange={(event) => setIncludeComments(event.target.checked)} disabled={Boolean(state)}/>接入评论意图</label>
        {!state && <button className="primary" onClick={createSession} disabled={busy}>创建模拟场</button>}
        {state?.session.status === "created" && <button className="primary" onClick={startSession} disabled={busy}>开始 30 分钟回放</button>}
        {state?.session.status === "running" && <button className="danger" onClick={stopSession} disabled={busy}>停止回放</button>}
        {state && <button className="reconnect" onClick={() => socketRef.current?.close()} disabled={connection !== "在线"}>重连实时链路</button>}
        {state && <div className="session-chip" data-testid="session-chip" data-session-id={state.session.id}><small>{state.session.name}</small><strong>{statusText(state.session.status)}</strong></div>}
      </section>
      <aside className="historical-calibration-banner" role="note"><strong>独立合成演示</strong><p>本公开版本不提供历史聚合校准数据或历史校准入口。模拟数据只用于检查工作流，不代表真实经营表现。</p></aside>
      {error && <div role="alert" className="error-banner">{error}</div>}

      {!state ? (
        <section className="empty-stage"><div className="orbit"><span>30:00</span></div><p>选择场景，创建一场可重复的确定性直播。</p><small>默认连接本机模拟服务，无需平台、ASR 或 LLM 凭据。</small></section>
      ) : (
        <div className="dashboard-grid">
          <section className="panel kpi-panel">
            <div className="section-heading"><div><span>01</span><h2>经营脉搏</h2></div><small>{state.eventCount} 个业务事件</small></div>
            <div className="kpi-grid">
              <KpiCard label="当前在线" value={displayNumber(currentOnline)} missing={currentOnline === undefined}/>
              <KpiCard label="直播间进入" value={displayNumber(roomEnter)} secondary={canonicalMetrics ? "当前累计人数" : "历史数据：每分钟人数"} missing={roomEnter === undefined}/>
              <KpiCard label="商品点击率" value={displayRate(productClickRate)} missing={productClickRate === undefined}/>
              <KpiCard label="点击－支付转化率" value={displayRate(paidConversionRate)} missing={paidConversionRate === undefined}/>
              <KpiCard label="支付 GMV" value={displayNumber(grossPaidGmvFen === undefined ? undefined : canonicalMetrics ? grossPaidGmvFen / 100 : grossPaidGmvFen, { style: "currency", currency: "CNY", maximumFractionDigits: 0 })} missing={grossPaidGmvFen === undefined}/>
              <KpiCard label="千川消耗" value={displayNumber(adSpendFen === undefined ? undefined : canonicalMetrics ? adSpendFen / 100 : adSpendFen, { style: "currency", currency: "CNY", maximumFractionDigits: 0 })} missing={adSpendFen === undefined}/>
              <KpiCard label="支付 ROI（退款前）" value={displayNumber(roi, { maximumFractionDigits: 2 })} missing={roi === undefined}/>
              <KpiCard label="平均停留" value={avgWatchSec === undefined ? "未接入" : `${avgWatchSec} 秒`} missing={avgWatchSec === undefined}/>
            </div>
            <div className="trend-card"><div><strong>当前在线趋势</strong><small>最近 {state.metricTrend.length} 个 30 秒快照</small></div><Sparkline points={state.metricTrend}/></div>
          </section>

          <aside className="panel source-panel">
            <div className="section-heading"><div><span>02</span><h2>源健康</h2></div></div>
            <ul className="source-list">{state.sourceHealth.length ? state.sourceHealth.map((health) => <SourceBadge health={health} key={health.sourceId}/>) : <li className="empty-row">数据源状态待接入</li>}</ul>
            <div className="freshness"><span>权威状态时间</span><strong>{formatTime(state.updatedAt)}</strong><small>重连后以服务端快照覆盖本地状态</small></div>
          </aside>

          <section className="panel advice-panel">
            <div className="section-heading"><div><span>03</span><h2>实时建议</h2></div>{state.advices.length > 0 && <Link className="review-link" href={`/sessions/${state.session.id}/review`}>下播复盘 →</Link>}</div>
            <div className="advice-list">{state.advices.length ? state.advices.slice().reverse().map((projection) => <AdviceCard projection={projection} busy={busyAdviceId === projection.advice.id} onAction={actOnAdvice} key={projection.advice.id}/>) : <div className="empty-row">暂无建议。系统会在样本满足且规则触发时送达。</div>}</div>
          </section>

          <aside className="panel rule-panel">
            <div className="section-heading"><div><span>04</span><h2>建议判断</h2></div><small>数据充分度、重复提醒间隔与现场变化</small></div>
            <RuleStatusList statuses={state.ruleStatuses}/>
          </aside>

          <section className="panel transcript-panel">
            <div className="section-heading"><div><span>05</span><h2>主播话术</h2></div><small>仅确认片段</small></div>
            <div className="scroll-list">{state.transcripts.slice().reverse().map((segment) => <article className="transcript" key={segment.id}><time>{Math.floor(segment.startMs / 60000).toString().padStart(2, "0")}:{Math.floor((segment.startMs % 60000) / 1000).toString().padStart(2, "0")}</time><div><p>{segment.text}</p><div>{segment.tags.map((tag) => <span key={tag} title={tag}>{speechTagNames[tag]}</span>)}</div></div></article>)}{state.transcripts.length === 0 && <div className="empty-row">等待确认话术事件</div>}</div>
          </section>

          <section className="panel rounds-panel">
            <div className="section-heading"><div><span>06</span><h2>商品轮次</h2></div></div>
            <div className="rounds">{state.productRounds.map((round, index) => <article key={round.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{round.productId}</strong><small>{formatTime(round.startedAt)} — {round.endedAt ? formatTime(round.endedAt) : "进行中"}</small></div><b>{round.endedAt ? "已收口" : "讲解中"}</b></article>)}{state.productRounds.length === 0 && <div className="empty-row">尚未开始商品轮次</div>}</div>
          </section>

          <section className="panel event-panel">
            <div className="section-heading"><div><span>07</span><h2>业务事件流</h2></div><small>最近 18 条</small></div>
            <div className="event-table" role="table"><div className="event-head" role="row"><span>时间</span><span>事件</span><span>来源</span><span>状态</span></div>{latestEvents.map((item) => <div className="event-row" role="row" key={item.eventId}><time>{formatTime(item.eventAt)}</time><strong title={item.kind}>{eventKindNames[item.kind]}</strong><span title={item.source}>{sourceNames[item.source]}</span><b>{item.provisional ? "暂定" : "已确认"}</b></div>)}</div>
          </section>
        </div>
      )}
    </main>
  );
}
