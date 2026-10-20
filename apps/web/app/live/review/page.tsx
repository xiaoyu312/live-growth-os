"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { resolveLiveBackend } from "../backend-url";

function liveApiUrl(): string {
  if (typeof window === "undefined") return resolveLiveBackend({ protocol: "http:", hostname: "127.0.0.1" }).api;
  return resolveLiveBackend(window.location).api;
}

type PastWindow = { windowStartAt: string; windowEndAt: string; speechFinals: number; coverage: "full" | "partial" };
type CatalogSession = {
  sessionId: string;
  name: string;
  status: string;
  startedAt?: string;
  windowCount: number;
  speechFinalCount: number;
  pastWindows: PastWindow[];
};
type Finding = { id: string; kind: string; text: string; at?: string; quote?: string };
type AnchorReview = {
  hostName: string;
  sessionId: string;
  rangeStartAt: string;
  rangeEndAt: string;
  generatedAt: string;
  provider: "deterministic-template" | "ark-expression";
  promptVersion: string;
  scriptVersion: string;
  coverage: {
    speechFinalCount: number;
    score: { total: number; coveredPoints: number; totalPoints: number } | null;
    points: Array<{ key: string; label: string; covered: boolean; mentionCount: number; firstEvidence?: { at: string; quote: string } }>;
  };
  narrative: { summary: Finding; strengths: Finding[]; gaps: Finding[]; timeline: Finding[]; nextSteps: string[] };
  dataNotes: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(body: unknown, fallback: string): string {
  return isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" ? body.error.message : fallback;
}

function shanghaiClock(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

function shanghaiStamp(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

function windowLabel(window: PastWindow): string {
  const clock = `${shanghaiClock(window.windowStartAt)}–${shanghaiClock(window.windowEndAt)}`;
  return window.speechFinals > 0 ? `${clock} · ${window.speechFinals} 句` : clock;
}

export default function AnchorReviewPage() {
  const [catalog, setCatalog] = useState<CatalogSession[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [rangeStartAt, setRangeStartAt] = useState("");
  const [rangeEndAt, setRangeEndAt] = useState("");
  const [hostName, setHostName] = useState("");
  const [scriptSource, setScriptSource] = useState<"library-v1" | "pasted">("library-v1");
  const [scriptText, setScriptText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<AnchorReview | null>(null);
  const [arkReady, setArkReady] = useState<boolean | null>(null);

  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get("sessionId") ?? "";
    if (preset) setSessionId(preset);
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${liveApiUrl()}/api/live/sessions`, { cache: "no-store" });
        const body = await response.json() as unknown;
        if (!response.ok) throw new Error(errorMessage(body, "场次列表读取失败"));
        const sessions = isRecord(body) && Array.isArray(body.sessions) ? body.sessions as CatalogSession[] : [];
        if (!cancelled) {
          setCatalog(sessions);
          setCatalogError(null);
        }
        const health = await fetch(`${liveApiUrl()}/health`, { cache: "no-store" });
        const healthBody = await health.json() as unknown;
        if (!cancelled && isRecord(healthBody) && isRecord(healthBody.arkExpression)) {
          setArkReady(healthBody.arkExpression.status === "healthy");
        }
      } catch (reason) {
        if (!cancelled) setCatalogError(reason instanceof Error ? reason.message : "场次列表读取失败");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selected = catalog.find((item) => item.sessionId === sessionId);
  const pastWindows = selected?.pastWindows ?? [];
  const endWindows = useMemo(() => {
    if (!rangeStartAt) return pastWindows;
    return pastWindows.filter((window) => Date.parse(window.windowEndAt) > Date.parse(rangeStartAt));
  }, [pastWindows, rangeStartAt]);

  useEffect(() => {
    if (!selected) {
      setRangeStartAt("");
      setRangeEndAt("");
      return;
    }
    const windows = selected.pastWindows;
    if (windows.length === 0) {
      setRangeStartAt("");
      setRangeEndAt("");
      return;
    }
    const slice = windows.slice(-1);
    setRangeStartAt(slice[0]!.windowStartAt);
    setRangeEndAt(slice.at(-1)!.windowEndAt);
  }, [selected?.sessionId]);

  const canSubmit = Boolean(sessionId && hostName.trim() && rangeStartAt && rangeEndAt && (scriptSource === "library-v1" || scriptText.trim()) && !loading);

  const runReview = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${liveApiUrl()}/api/live/anchor-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          hostName: hostName.trim(),
          rangeStartAt,
          rangeEndAt,
          scriptSource,
          ...(scriptSource === "pasted" ? { scriptText } : {})
        })
      });
      const body = await response.json() as unknown;
      if (!response.ok) throw new Error(errorMessage(body, "主播复盘失败"));
      if (!isRecord(body) || body.schemaVersion !== 1 || !isRecord(body.narrative)) throw new Error("复盘结果格式异常");
      setReview(body as AnchorReview);
    } catch (reason) {
      setReview(null);
      setError(reason instanceof Error ? reason.message : "主播复盘失败");
    } finally {
      setLoading(false);
    }
  };

  return <main className="live-pilot-shell">
    <header className="live-pilot-header">
      <div className="live-pilot-header-title">
        <p className="live-pilot-eyebrow">LIVE GROWTH OS · 主播复盘</p>
        <h1>主播复盘</h1>
        <p>选择已经结束的时段做一轮分析。开播中请把副驾留在原来的标签，这里用新标签打开；不要重新点扩展连接，否则会开成新场，上一场数据还在目录里。</p>
      </div>
      <div className="live-pilot-header-actions">
        {sessionId && <Link href={`/live/${encodeURIComponent(sessionId)}`} className="live-pilot-link">返回副驾</Link>}
        <Link href={sessionId ? `/live/session-review?sessionId=${encodeURIComponent(sessionId)}` : "/live/session-review"} className="live-pilot-link">本场复盘</Link>
        <Link href="/live" className="live-pilot-link">接入说明</Link>
      </div>
    </header>
    {catalogError && <div className="live-pilot-error" role="alert">{catalogError}</div>}
    {error && <div className="live-pilot-error" role="alert">{error}</div>}
    <div className="live-review-layout">
      <form className="live-review-form" onSubmit={(event) => { event.preventDefault(); void runReview(); }}>
        <label>场次
          <select value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
            <option value="">选择一场已采集的直播</option>
            {catalog.map((item) => <option key={item.sessionId} value={item.sessionId}>{item.startedAt ? shanghaiStamp(item.startedAt) : item.name} · 转写 {item.speechFinalCount} 句</option>)}
          </select>
        </label>
        <label>已结束时段 · 起
          <select value={rangeStartAt} onChange={(event) => setRangeStartAt(event.target.value)} disabled={pastWindows.length === 0}>
            <option value="">{pastWindows.length ? "选择开始窗口" : "这场还没有已结束的15分钟时段"}</option>
            {pastWindows.map((window) => <option key={window.windowStartAt} value={window.windowStartAt}>{windowLabel(window)}</option>)}
          </select>
        </label>
        <label>已结束时段 · 止
          <select value={rangeEndAt} onChange={(event) => setRangeEndAt(event.target.value)} disabled={endWindows.length === 0}>
            <option value="">选择结束窗口</option>
            {endWindows.map((window) => <option key={window.windowEndAt} value={window.windowEndAt}>{windowLabel(window)}</option>)}
          </select>
          <small>只纳入已经走完的 15 分钟窗，最多 4 小时。开播中默认最近一段，分析会快一些。</small>
        </label>
        <label>主播名字
          <input value={hostName} onChange={(event) => setHostName(event.target.value)} maxLength={40} placeholder="例如 春玉" autoComplete="off" />
        </label>
        <div>
          <span className="live-pilot-eyebrow">参考话术</span>
          <div className="live-review-script-source">
            <button type="button" aria-pressed={scriptSource === "library-v1"} onClick={() => setScriptSource("library-v1")}>依蔻庭话术库 v1</button>
            <button type="button" aria-pressed={scriptSource === "pasted"} onClick={() => setScriptSource("pasted")}>当场粘贴</button>
          </div>
        </div>
        {scriptSource === "library-v1" ? <small>覆盖开场钩子、痛点、成分、功效、用法、人群、到手价、优惠、赠品、保障、小黄车、下单、催单、关注。</small> : <label>粘贴要点
          <textarea value={scriptText} onChange={(event) => setScriptText(event.target.value)} maxLength={8000} placeholder={"开场钩子：福利,宠粉,刚进来的\n到手价：到手价,309\n点开小黄车：点开小黄车,拍1号"} />
          <small>一行一个要点，格式「要点名：关键词1,关键词2」。可选「要点名|3：关键词」指定权重。</small>
        </label>}
        <button type="submit" className="live-review-submit" disabled={!canSubmit}>{loading ? (arkReady ? "正在走一轮表达…" : "正在分析…") : "开始复盘"}</button>
        <small>{arkReady === false ? "还没配方舟，这次用规则底稿。把 ARK_API_KEY 和 ARK_MODEL 写进项目 .env 后重新启动。" : arkReady ? "已配方舟，点开始会走一轮表达，大约半分钟。" : "有转写时会尝试走一轮表达。"}</small>
      </form>
      {!review && <section className="live-review-result live-review-empty">选好场次、时段、主播和参考话术后点「开始复盘」。先看下一场怎么讲，不堆转写原文。</section>}
      {review && <section className="live-review-result">
        <div>
          <h2>{review.narrative.summary.text}</h2>
          <div className="live-review-meta">
            <span>主播 <strong>{review.hostName}</strong></span>
            <span>{shanghaiClock(review.rangeStartAt)}–{shanghaiClock(review.rangeEndAt)}</span>
            {review.coverage.score
              ? <span>参考要点 <strong>{review.coverage.score.coveredPoints}/{review.coverage.score.totalPoints}</strong></span>
              : <span>样本不足</span>}
            <span>{review.provider === "ark-expression" ? "已走一轮表达" : "规则底稿"}</span>
          </div>
        </div>
        <div className="live-review-block"><h3>下一场先改</h3><ol className="live-review-next">{review.narrative.nextSteps.map((text, index) => <li key={index}>{text}</li>)}</ol></div>
        {review.narrative.gaps.length > 0 && <div className="live-review-block"><h3>转写里还缺，下一场这样补</h3><ul>{review.narrative.gaps.map((item) => <li key={item.id}>{item.text}</li>)}</ul></div>}
        {review.narrative.strengths.length > 0 && <div className="live-review-block"><h3>讲到了</h3><ul>{review.narrative.strengths.map((item) => <li key={item.id}>{item.at && <time>{shanghaiClock(item.at)}</time>}{item.text}{item.quote && <div className="live-review-quote">「{item.quote}」</div>}</li>)}</ul></div>}
        {review.narrative.timeline.length > 0 && <div className="live-review-block"><h3>关键时段</h3><ul>{review.narrative.timeline.map((item) => <li key={item.id}>{item.text}</li>)}</ul></div>}
        <details className="live-review-block">
          <summary>要点对照</summary>
          <ul className="live-pilot-anchor-points">{review.coverage.points.map((point) => <li key={point.key} className={point.covered ? "live-pilot-anchor-covered" : "live-pilot-anchor-missing"}><span className="live-pilot-anchor-flag">{point.covered ? "讲到" : "还缺"}</span><div><strong>{point.label}</strong></div></li>)}</ul>
        </details>
        <div className="live-pilot-anchor-notes">{review.dataNotes.map((note, index) => <small key={index}>{note}</small>)}</div>
      </section>}
    </div>
  </main>;
}
