export type LiveAudioStatusInput = {
  transcriptionStatus: "not_started" | "waiting_final" | "active" | "stale" | "offline" | "error";
  audioFrames?: number;
  energyBand?: "silent" | "low" | "normal" | "unknown";
  firstFinalTimedOut?: boolean;
  errorCode?: string;
};

function shortAsrErrorCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const numbered = /^ASR_CODE_(\d+)$/.exec(code);
  if (numbered) return numbered[1];
  if (code.startsWith("ASR_")) return code.slice(4);
  return code;
}

function withAsrErrorCode(label: string, errorCode?: string): string {
  const short = shortAsrErrorCode(errorCode);
  return short ? `${label}（${short}）` : label;
}

export function liveAudioStatusLabel(audio: LiveAudioStatusInput | undefined): string {
  if (!audio) return "未接入";
  if (audio.errorCode === "ASR_CODE_4002") return withAsrErrorCode("声音已接到，转写鉴权失败", audio.errorCode);
  if (audio.errorCode === "ASR_CODE_4003") return withAsrErrorCode("声音已接到，腾讯云未开通识别", audio.errorCode);
  if (audio.errorCode === "ASR_CODE_4004") return withAsrErrorCode("声音已接到，转写额度用尽", audio.errorCode);
  if (audio.errorCode === "ASR_CODE_4005") return withAsrErrorCode("声音已接到，转写账户欠费", audio.errorCode);
  if (audio.errorCode === "ASR_CODE_4006") return withAsrErrorCode("声音已接到，转写并发超限", audio.errorCode);
  if (audio.transcriptionStatus === "active") return "正常";
  if (audio.transcriptionStatus === "waiting_final" && audio.firstFinalTimedOut) {
    return audio.energyBand === "silent" ? "音频接近静音，未收到完整话术" : "已收到有效声音，但未形成完整话术";
  }
  if (audio.transcriptionStatus === "waiting_final") return "音频已接通，等待完整话术";
  if (audio.transcriptionStatus === "error") {
    return withAsrErrorCode((audio.audioFrames ?? 0) > 0 ? "声音已接到，转写失败" : "转写失败", audio.errorCode);
  }
  if (audio.transcriptionStatus === "stale") return "已超过10秒没有新话术";
  if (audio.transcriptionStatus === "not_started") return "未接入";
  if ((audio.audioFrames ?? 0) > 0) return withAsrErrorCode("声音已接到，转写已断开", audio.errorCode);
  return "未接入";
}
