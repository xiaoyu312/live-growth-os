import type { AudioErrorCode } from "./types.js";

export function audioStartErrorMessage(errorCode: AudioErrorCode): string {
  switch (errorCode) {
    case "tab_capture_failed":
      return "没拿到这个标签页的声音。请关掉罗盘页上的开发者工具，在系统设置 → 隐私与安全性 → 屏幕录制里打开 Google Chrome，再只点「连接真实直播」。";
    case "get_user_media_failed":
      return "浏览器没批准标签页音频。若弹出授权，请选「Chrome 标签页」并勾选分享音频，不要选整个屏幕或麦克风。";
    case "no_audio_track":
      return "这个标签页现在没有音轨。请把罗盘直播解除静音，确认右下角画面有声音，再点「连接真实直播」。";
    case "asr_ws_failed":
      return "本机转写通道没接通。请确认 START_LAN_VIEW 还在跑，然后到 chrome://extensions 重新加载扩展再连一次。";
    case "offscreen_unavailable":
    case "offscreen_response_invalid":
      return "音频组件没有在时限内就绪。请到 chrome://extensions 重新加载本扩展后，只点「连接真实直播」。";
    default:
      return "音频没接通。请只点「连接真实直播」，不要点开始网络探针或开始音频探针。";
  }
}
