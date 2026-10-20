"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { MvpFullReview, MvpStateSnapshot } from "@live-growth/contracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";

export default function MvpReviewPage() {
  const params = useParams<{ id: string }>();
  const [review, setReview] = useState<MvpFullReview | null>(null);
  const [snapshot, setSnapshot] = useState<MvpStateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!params.id || params.id === "demo") return;
    Promise.all([
      fetch(`${API_URL}/api/mvp/sessions/${encodeURIComponent(params.id)}/full-review`).then((response) => response.json()),
      fetch(`${API_URL}/api/mvp/sessions/${encodeURIComponent(params.id)}/state`).then((response) => response.json())
    ]).then(([nextReview, nextState]) => { setReview(nextReview as MvpFullReview); setSnapshot(nextState as MvpStateSnapshot); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "复盘读取失败"));
  }, [params.id]);
  return <main className="mvp-shell mvp-dark"><header className="mvp-header"><div><p className="mvp-eyebrow">MVP 复盘</p><h1>{snapshot?.session.name ?? "整场复盘"}</h1><p className="mvp-subtitle">这里记录本场经历过的状态和行动，只描述时间上的变化，不把相关性写成因果。</p></div><Link className="mvp-ghost" href="/">返回副驾首页</Link></header>{error && <div className="mvp-alert" role="alert">{error}</div>}{!review && !error && <section className="mvp-state-card"><h2>暂无可展示的复盘</h2><p>请先从首页创建并运行一场 MVP 演示。</p></section>}{review && <><section className="mvp-review-strip"><div><span className="mvp-section-kicker">五项重点</span><h2>本场复盘摘要</h2><p>这些重点用于下一场验证，不会自动升级为长期规则。</p></div></section><div className="mvp-main-grid">{review.highlighted.map((item) => <article className="mvp-action-card" key={item.title}><span className="mvp-section-kicker">重点</span><h2>{item.title}</h2><p className="mvp-action-main">{item.summary}</p><ul className="mvp-evidence">{item.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul></article>)}</div><section className="mvp-timeline-card"><div className="mvp-card-heading"><div><span className="mvp-section-kicker">行动时间线</span><h2>本场系统行动</h2></div></div>{review.details.length ? <div className="mvp-timeline">{review.details.map((detail, index) => <article key={`${index}:${detail}`}><span>{index + 1}</span><div><strong>{detail}</strong></div></article>)}</div> : <p className="mvp-muted">本场没有主动行动。</p>}<p className="mvp-muted">限制：{review.limitation}</p></section><section className="mvp-timeline-card"><div className="mvp-card-heading"><div><span className="mvp-section-kicker">模拟话术证据</span><h2>按时间去重的最近话术</h2></div></div>{review.speechEvidence?.length ? <div className="mvp-timeline">{review.speechEvidence.map((item) => <article key={`${item.at}:${item.text}`}><span>{item.at.slice(11, 19)}</span><div><strong>{item.text}</strong></div></article>)}</div> : <p className="mvp-muted">本场没有可展示的话术证据。</p>}</section></>}</main>;
}
