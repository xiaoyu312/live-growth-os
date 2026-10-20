"use client";

import { useEffect, useState } from "react";
import { isLoopbackHost, lanColleagueWatchUrl, resolveLiveBackend } from "./backend-url";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function LanShareBar() {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !isLoopbackHost(window.location.hostname)) return;
    const backend = resolveLiveBackend(window.location);
    let cancelled = false;
    void fetch(`${backend.api}/api/lan-view`, { cache: "no-store" }).then(async (response) => {
      const body = await response.json() as unknown;
      if (cancelled || !isRecord(body)) return;
      if (body.enabled === true) {
        const url = typeof body.watchUrl === "string" && body.watchUrl.startsWith("http://")
          ? body.watchUrl
          : typeof body.shareOrigin === "string" ? lanColleagueWatchUrl(body.shareOrigin) : "";
        if (url) setShareUrl(url);
        return;
      }
      if (body.requested === true) setMissing(true);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  if (shareUrl) {
    return <div className="live-pilot-source-note live-pilot-share" role="status">
      <span>发给同事的观看链接：<strong>{shareUrl}</strong>。固定入口 /live/current，同一办公网打开即可；不要发 127.0.0.1，也不要端口转发。</span>
      <button type="button" className="live-pilot-theme-toggle" onClick={() => {
        void navigator.clipboard.writeText(shareUrl).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        }).catch(() => undefined);
      }}>{copied ? "已复制" : "复制链接"}</button>
    </div>;
  }
  if (missing) {
    return <div className="live-pilot-source-note" role="status">办公网分享地址还没写上。重新双击 start.bat，打开 SHARE.txt 或 WATCH.txt 第一行；不要把 127.0.0.1 发给同事。</div>;
  }
  return null;
}
