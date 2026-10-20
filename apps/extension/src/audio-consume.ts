import { AUDIO_ERROR_CODES, type AudioErrorCode, type ProbeSessionIdentity } from "./types.js";

export type AudioConsumeResponse =
  | { ok: true }
  | { ok: false; errorCode: AudioErrorCode };

export interface AudioConsumeFailure {
  errorCode: AudioErrorCode;
}

export type AudioNetworkEvent = "online" | "offline";

export function initialNetworkEvent(online: boolean): AudioNetworkEvent {
  return online ? "online" : "offline";
}

type SendMessage = (message: unknown, callback: (response?: unknown) => void) => void;
type LastErrorReader = () => unknown;

export const AUDIO_CONSUME_TIMEOUT_MS = 20_000;
export const AUDIO_WS_AUTHORIZE_TIMEOUT_MS = 8_000;

function isAudioErrorCode(value: unknown): value is AudioErrorCode {
  return typeof value === "string" && AUDIO_ERROR_CODES.includes(value as AudioErrorCode);
}

function parseResponse(value: unknown): AudioConsumeResponse {
  if (value !== null && typeof value === "object" && (value as { ok?: unknown }).ok === true) return { ok: true };
  const errorCode = value !== null && typeof value === "object" ? (value as { errorCode?: unknown }).errorCode : undefined;
  return { ok: false, errorCode: isAudioErrorCode(errorCode) ? errorCode : "offscreen_response_invalid" };
}

export function requestAudioConsume(sendMessage: SendMessage, readLastError: LastErrorReader, streamId: string, tabId: number, identity: ProbeSessionIdentity, live?: { sessionId: string; pairToken: string; audioWsUrl: string }, timeoutMs = AUDIO_CONSUME_TIMEOUT_MS): Promise<AudioConsumeResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AudioConsumeResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, errorCode: "offscreen_unavailable" }), timeoutMs);
    try {
      sendMessage({ type: "audio:consume", streamId, tabId, routeId: identity.routeId, sessionId: identity.sessionId, ...(live ? { live } : {}) }, (response) => {
        if (readLastError()) {
          finish({ ok: false, errorCode: "offscreen_unavailable" });
          return;
        }
        finish(parseResponse(response));
      });
    } catch {
      finish({ ok: false, errorCode: "offscreen_unavailable" });
    }
  });
}

export function audioConsumeFailureCode(error: unknown): AudioErrorCode {
  if (error instanceof Error && (error.message === "audio_ws_timeout" || error.message === "audio_ws_failed")) {
    return "asr_ws_failed";
  }
  if (error !== null && typeof error === "object") {
    const errorCode = (error as { errorCode?: unknown }).errorCode;
    if (isAudioErrorCode(errorCode)) return errorCode;
  }
  return "audio_consume_failed";
}

export function createAudioConsumeFailure(errorCode: AudioErrorCode): AudioConsumeFailure {
  return { errorCode };
}
