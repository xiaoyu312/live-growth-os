"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { resolveLiveBackend } from "../backend-url";
import { pickLatestRunningSession, type LiveCatalogSession } from "../current-session";
import { LanShareBar } from "../lan-share";

function liveApiUrl(): string {
  if (typeof window === "undefined") return resolveLiveBackend({ protocol: "http:", hostname: "127.0.0.1" }).api;
  return resolveLiveBackend(window.location).api;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default function LiveCurrentPage() {
  const router = useRouter();
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${liveApiUrl()}/api/live/sessions`, { cache: "no-store" });
        const body = await response.json() as unknown;
        if (!response.ok) throw new Error("场次列表读取失败");
        const sessions = isRecord(body) && Array.isArray(body.sessions) ? body.sessions as LiveCatalogSession[] : [];
        const latest = pickLatestRunningSession(sessions);
        if (cancelled) return;
        if (latest) {
          router.replace(`/live/${encodeURIComponent(latest.sessionId)}`);
          return;
        }
        setEmpty(true);
      } catch {
        if (!cancelled) setError("读不到进行中的直播，请确认这台电脑上的服务已启动。");
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [router]);

  return <main className="live-pilot-shell">
    <header className="live-pilot-header">
      <div>
        <p className="live-pilot-eyebrow">LIVE GROWTH OS · 当前场次</p>
        <h1>进行中的直播</h1>
      </div>
      <div className="live-pilot-header-actions">
        <Link href="/live" className="live-pilot-link">接入说明</Link>
      </div>
    </header>
    {process.env.NEXT_PUBLIC_CAPTURE_ONLY !== "1" && <LanShareBar />}
    {error && <section className="live-pilot-guide" role="alert"><h2>暂时打不开</h2><p>{error}</p></section>}
    {!error && empty && <section className="live-pilot-guide"><h2>当前没有进行中的直播</h2><p>请在 Chrome 的罗盘直播大屏点击扩展连接。这里会自动显示本场数据。</p></section>}
    {!error && !empty && <section className="live-pilot-guide"><h2>正在查找进行中的直播</h2><p>找到后会自动跳到副驾。</p></section>}
  </main>;
}
