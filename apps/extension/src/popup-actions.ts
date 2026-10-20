export function popupCanResume(input: { routeId: string | null; hasPair: boolean; probeActive: boolean }): boolean {
  return input.routeId === "compass-live-shop" && input.hasPair && !input.probeActive;
}

export function popupProbeActive(state: { session?: { lifecycle?: string } } | null | undefined): boolean {
  const lifecycle = state?.session?.lifecycle;
  return lifecycle === "starting" || lifecycle === "active";
}

export function popupRecoverAction(routeId: string | null): {
  showRecover: boolean;
  source: "qianchuan" | "compass" | null;
  label: string;
  hint: string;
} {
  if (routeId === "qianchuan-board") {
    return { showRecover: true, source: "qianchuan", label: "刷新千川页面", hint: "千川部分停更时可一键刷新页面，不会中断罗盘音频。" };
  }
  if (routeId === "compass-live-shop") {
    return { showRecover: true, source: "compass", label: "刷新并重新连接", hint: "罗盘刷新会暂时中断音频和转写，刷新后需要重新授权音频。" };
  }
  return { showRecover: false, source: null, label: "刷新", hint: "" };
}

export function popupPrimaryActions(routeId: string | null, options?: { canResume?: boolean }): {
  showCompassLive: boolean;
  showQianchuan: boolean;
  hint: string;
  startLiveLabel: string;
} {
  const canResume = options?.canResume === true && routeId === "compass-live-shop";
  if (routeId === "qianchuan-board") {
    return {
      showCompassLive: false,
      showQianchuan: true,
      startLiveLabel: "连接真实直播（罗盘）",
      hint: "罗盘连上后，在这一页点「连接千川数据」。连完后把这个窗口留在能看见的位置，不要最小化。"
    };
  }
  if (routeId === "compass-live-shop") {
    return {
      showCompassLive: true,
      showQianchuan: false,
      startLiveLabel: canResume ? "恢复上一场直播" : "连接真实直播（罗盘）",
      hint: canResume
        ? "罗盘已回到大屏。点「恢复上一场直播」挂回原副驾，不要新开一场。"
        : "在这一页点「连接真实直播」。连上后再去千川独立直播大屏点「连接千川数据」。不要点下方调试里的探针。"
    };
  }
  return {
    showCompassLive: true,
    showQianchuan: false,
    startLiveLabel: "连接真实直播（罗盘）",
    hint: "请先打开罗盘直播大屏或千川独立直播大屏。"
  };
}
