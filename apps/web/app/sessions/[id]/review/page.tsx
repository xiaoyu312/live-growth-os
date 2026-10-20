"use client";

import type { SessionState } from "@live-growth/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AdviceCard, RuleStatusList } from "../../../advice-ui";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";

type SessionReview = Pick<SessionState, "session" | "detectedEvents" | "advices" | "feedback" | "executions" | "outcomes" | "ruleStatuses">;

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return "未形成";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

export default function SessionReviewPage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  const [review, setReview] = useState<SessionReview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/review`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? "复盘加载失败");
        if (active) setReview(body as SessionReview);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "复盘加载失败"); });
    return () => { active = false; };
  }, [sessionId]);

  const summary = useMemo(() => {
    const advices = review?.advices ?? [];
    const accepted = advices.filter((item) => item.status === "accepted").length;
    const executed = advices.filter((item) => item.executions.some((execution) => execution.status === "executed")).length;
    const seenSeconds = advices.map((item) => item.timeline.generatedToSeenSec).filter((value): value is number => value !== undefined);
    const avgSeen = seenSeconds.length ? seenSeconds.reduce((total, value) => total + value, 0) / seenSeconds.length : undefined;
    return { total: advices.length, accepted, executed, avgSeen };
  }, [review]);

  return (
    <main className="review-page">
      <header className="review-masthead">
        <div><span className="eyebrow">SESSION REVIEW</span><h1>下播建议复盘</h1><p>{review?.session.name ?? "正在读取场次…"}</p></div>
        <Link href={`/?sessionId=${encodeURIComponent(sessionId)}`}>← 返回实时驾驶舱</Link>
      </header>

      {error && <div role="alert" className="error-banner">{error}</div>}
      {!review && !error && <section className="empty-stage"><p>正在整理建议、执行与观察记录…</p></section>}
      {review && <>
        <section className="review-summary" aria-label="复盘摘要">
          <article><small>建议总数</small><strong>{summary.total}</strong></article>
          <article><small>采纳</small><strong>{summary.accepted}</strong></article>
          <article><small>已执行</small><strong>{summary.executed}</strong></article>
          <article><small>平均查看响应</small><strong>{formatDuration(summary.avgSeen)}</strong></article>
        </section>

        <section className="panel review-section">
          <div className="section-heading"><div><span>01</span><h2>建议执行与效果观察</h2></div><small>重点展示 2／5 分钟窗口</small></div>
          <p className="association-note">以下仅展示建议执行前后的关联变化；请结合商品、流量和现场干扰判断。</p>
          <div className="advice-list">{review.advices.length ? review.advices.slice().reverse().map((projection) => <AdviceCard projection={projection} busy={false} reviewMode key={projection.advice.id}/>) : <div className="empty-row">本场没有形成建议</div>}</div>
        </section>

        <section className="panel review-section">
          <div className="section-heading"><div><span>02</span><h2>规则观察记录</h2></div><small>{review.detectedEvents.length} 次触发</small></div>
          <RuleStatusList statuses={review.ruleStatuses}/>
        </section>
      </>}
    </main>
  );
}
