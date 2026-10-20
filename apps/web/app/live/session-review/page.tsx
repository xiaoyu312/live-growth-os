"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { resolveLiveBackend } from "../backend-url";

function liveApiUrl(): string {
  if (typeof window === "undefined") return resolveLiveBackend({ protocol: "http:", hostname: "127.0.0.1" }).api;
  return resolveLiveBackend(window.location).api;
}

type CatalogSession = {
  sessionId: string;
  name: string;
  status: string;
  startedAt?: string;
  windowCount: number;
  speechFinalCount: number;
  pastWindows: unknown[];
};
type Finding = { id: string; kind: string; text: string; at?: string; label?: string; quote?: string };
type SessionReview = {
  hostName: string;
  rangeStartAt: string;
  rangeEndAt: string;
  provider?: "deterministic-template" | "ark-expression";
  totals: { speechFinalCount: number; truncated: boolean };
  narrative: {
    summary: Finding;
    bottleneck: Finding;
    chapters: Finding[];
    strengths: Finding[];
    gaps: Finding[];
    nextSteps: string[];
  };
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

export default function SessionReviewPage() {
  const [catalog, setCatalog] = useState<CatalogSession[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [hostName, setHostName] = useState("");
  const [scriptSource, setScriptSource] = useState<"library-v1" | "pasted">("library-v1");
  const [scriptText, setScriptText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<SessionReview | null>(null);
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
  const canSubmit = Boolean(sessionId && hostName.trim() && (scriptSource === "library-v1" || scriptText.trim()) && !loading);

  const runReview = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${liveApiUrl()}/api/live/session-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          hostName: hostName.trim(),
          scriptSource,
          ...(scriptSource === "pasted" ? { scriptText } : {})
        })
      });
      const body = await response.json() as unknown;
      if (!response.ok) throw new Error(errorMessage(body, "本场复盘失败"));
      if (!isRecord(body) || body.schemaVersion !== 1 || !isRecord(body.narrative)) throw new Error("复盘结果格式异常");
      setReview(body as SessionReview);
    } catch (reason) {
      setReview(null);
      setError(reason instanceof Error ? reason.message : "本场复盘失败");
    } finally {
      setLoading(false);
    }
  };

  return <main className="live-pilot-shell">
    <header className="live-pilot-header">
      <div className="live-pilot-header-title">
        <p className="live-pilot-eyebrow">LIVE GROWTH OS · 本场复盘</p>
        <h1>本场复盘</h1>
        <p>把这场已经走完的经营数据和转写写成一份整场分析。配了方舟会走一轮表达；没配或没过校验才用规则底稿。直播还没停也可以看，当前这一段不算进去。</p>
      </div>
      <div className="live-pilot-header-actions">
        {sessionId && <Link href={`/live/${encodeURIComponent(sessionId)}`} className="live-pilot-link">返回副驾</Link>}
        <Link href={sessionId ? `/live/review?sessionId=${encodeURIComponent(sessionId)}` : "/live/review"} className="live-pilot-link">主播复盘</Link>
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
        {selected && <small>{selected.pastWindows.length ? `已走完 ${selected.pastWindows.length} 段，会按整场来写。` : "这场还没有走完的时段，等过了一段再复盘。"}</small>}
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
        {scriptSource === "library-v1" ? <small>对照开场钩子、痛点、成分、功效、用法、人群、到手价、优惠、赠品、保障、小黄车、下单、催单、关注。</small> : <label>粘贴要点
          <textarea value={scriptText} onChange={(event) => setScriptText(event.target.value)} maxLength={8000} placeholder={"开场钩子：福利,宠粉,刚进来的\n到手价：到手价,309\n点开小黄车：点开小黄车,拍1号"} />
          <small>一行一个要点，格式「要点名：关键词1,关键词2」。</small>
        </label>}
        <button type="submit" className="live-review-submit" disabled={!canSubmit}>{loading ? (arkReady ? "正在走一轮表达…" : "正在写本场复盘…") : "开始复盘"}</button>
        <small>{arkReady === false ? "还没配方舟，这次用规则底稿。把 ARK_API_KEY 和 ARK_MODEL 写进项目 .env 后重新启动。" : arkReady ? "已配方舟，点开始会走一轮表达，大约半分钟。" : "有转写时会尝试走一轮表达。"}</small>
      </form>
      {!review && <section className="live-review-result live-review-empty">选好场次、主播和参考话术，点「开始复盘」。会按整场已经走完的时段来写，不需要再选起止时间。</section>}
      {review && <section className="live-review-result">
        <div>
          <h2>{review.narrative.summary.text}</h2>
          <div className="live-review-meta">
            <span>主播 <strong>{review.hostName}</strong></span>
            <span>{shanghaiClock(review.rangeStartAt)}–{shanghaiClock(review.rangeEndAt)}</span>
            <span>转写 <strong>{review.totals.speechFinalCount}</strong> 句</span>
            <span>{review.provider === "ark-expression" ? "已走一轮表达" : "规则底稿"}</span>
          </div>
        </div>
        <div className="live-review-block live-review-bottleneck"><h3>这场卡在哪</h3><p>{review.narrative.bottleneck.text}</p></div>
        <div className="live-review-block"><h3>经营走过的路</h3>
          <ol className="live-review-chapters">
            {review.narrative.chapters.map((item) => <li key={item.id}><strong>{item.label ?? (item.at ? shanghaiClock(item.at) : "")}</strong><p>{item.text}</p></li>)}
          </ol>
        </div>
        {review.narrative.strengths.length > 0 && <div className="live-review-block"><h3>讲到了</h3><ul>{review.narrative.strengths.map((item) => <li key={item.id}>{item.at && <time>{shanghaiClock(item.at)}</time>}{item.text}{item.quote && <div className="live-review-quote">「{item.quote}」</div>}</li>)}</ul></div>}
        {review.narrative.gaps.length > 0 && <div className="live-review-block"><h3>转写里没出现</h3><ul>{review.narrative.gaps.map((item) => <li key={item.id}>{item.text}</li>)}</ul></div>}
        <div className="live-review-block"><h3>下一场先改这几件事</h3><ol className="live-review-next">{review.narrative.nextSteps.map((text, index) => <li key={index}>{text}</li>)}</ol></div>
        <div className="live-pilot-anchor-notes">{review.dataNotes.map((note, index) => <small key={index}>{note}</small>)}</div>
      </section>}
    </div>
  </main>;
}
