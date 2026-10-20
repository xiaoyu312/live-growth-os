import { energyBandFromRms } from "./audio.js";
import { AUDIO_WS_AUTHORIZE_TIMEOUT_MS, audioConsumeFailureCode, createAudioConsumeFailure, initialNetworkEvent } from "./audio-consume.js";
import { fireAndForgetAudioStatus } from "./audio-report.js";
import type { AllowedRouteId, AudioErrorCode, ProbeSessionIdentity } from "./types.js";

let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let interval: number | null = null;
let startedAtMs: number | null = null;
let activeRouteId: AllowedRouteId | null = null;
let activeSessionId: string | null = null;
let liveSocket: WebSocket | null = null;
let pcmNode: ScriptProcessorNode | null = null;
let pcmBuffer: number[] = [];

function report(message: Record<string, unknown>, expectedIdentity: ProbeSessionIdentity | null = activeRouteId && activeSessionId ? { routeId: activeRouteId, sessionId: activeSessionId } : null): void {
  if (!expectedIdentity) return;
  fireAndForgetAudioStatus((payload) => chrome.runtime.sendMessage(payload), { type: "audio:status", observedAt: new Date().toISOString(), routeId: expectedIdentity.routeId, sessionId: expectedIdentity.sessionId, ...message });
}

function stopTracks(): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
}

async function stopAudio(): Promise<void> {
  if (interval !== null) { window.clearInterval(interval); interval = null; }
  stopTracks();
  pcmNode?.disconnect(); pcmNode = null;
  pcmBuffer = [];
  liveSocket?.close(); liveSocket = null;
  if (context) { await context.close().catch(() => undefined); context = null; }
  startedAtMs = null;
  activeRouteId = null;
  activeSessionId = null;
}

function appendPcm(input: Float32Array, sampleRate: number): void {
  if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN || !input.length) return;
  const ratio = sampleRate / 16_000;
  const outputLength = Math.floor(input.length / ratio);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor]!;
    pcmBuffer.push(Math.max(-1, Math.min(1, sum / (end - start))));
  }
  const packetSamples = 3200;
  while (pcmBuffer.length >= packetSamples) {
    const packet = pcmBuffer.splice(0, packetSamples);
    const bytes = new ArrayBuffer(packetSamples * 2);
    const view = new DataView(bytes);
    packet.forEach((sample, index) => view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true));
    liveSocket.send(bytes);
  }
}

async function consume(streamId: string, routeId: AllowedRouteId, sessionId: string, live?: { sessionId: string; pairToken: string; audioWsUrl: string }): Promise<void> {
  await stopAudio();
  activeRouteId = routeId;
  activeSessionId = sessionId;
  if (live && routeId === "compass-live-shop") {
    liveSocket = new WebSocket(live.audioWsUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("audio_ws_timeout")), AUDIO_WS_AUTHORIZE_TIMEOUT_MS);
      let authorized = false;
      liveSocket!.onopen = () => { liveSocket!.send(JSON.stringify({ type: "authorize", token: live.pairToken })); };
      liveSocket!.onmessage = (event) => {
        if (authorized || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { type?: unknown };
          if (message.type === "authorized") {
            authorized = true;
            window.clearTimeout(timeout);
            resolve();
          }
        } catch { /* wait for the explicit authorization acknowledgement */ }
      };
      liveSocket!.onerror = () => { window.clearTimeout(timeout); reject(new Error("audio_ws_failed")); };
    });
  }
  const identity: ProbeSessionIdentity = { routeId, sessionId };
  startedAtMs = Date.now();
  try {
    const constraints = {
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
    } as unknown as MediaStreamConstraints;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      throw createAudioConsumeFailure("get_user_media_failed");
    }
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) throw createAudioConsumeFailure("no_audio_track");
    let analyser: AnalyserNode | null = null;
    try {
      context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      // Connect to destination so the page audio continues to play for the user.
      analyser.connect(context.destination);
      await context.resume();
      if (liveSocket) {
        pcmNode = context.createScriptProcessor(4096, 1, 1);
        pcmNode.onaudioprocess = (event) => appendPcm(event.inputBuffer.getChannelData(0), context?.sampleRate ?? 48_000);
        const silentSink = context.createGain();
        silentSink.gain.value = 0;
        source.connect(pcmNode); pcmNode.connect(silentSink); silentSink.connect(context.destination);
      }
    } catch {
      throw createAudioConsumeFailure("audio_context_failed");
    }
    if (!analyser) throw createAudioConsumeFailure("audio_context_failed");
    const track = tracks[0]!;
    track.onmute = () => { void report({ event: "mute" }, identity); };
    track.onunmute = () => { void report({ event: "unmute" }, identity); };
    track.onended = () => {
      if (stream?.getAudioTracks()[0] === track) void report({ event: "track_ended" }, identity);
    };
    await report({ event: "track_started", trackCount: tracks.length }, identity);
    await report({ event: initialNetworkEvent(navigator.onLine) }, identity);
    const samples = new Uint8Array(analyser.fftSize);
    interval = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) { const centered = (sample - 128) / 128; sum += centered * centered; }
      const rms = Math.sqrt(sum / samples.length);
      const activeSeconds = startedAtMs === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
      void report({ event: "energy", band: energyBandFromRms(rms), activeSeconds }, identity);
    }, 1000);
  } catch (error) {
    const errorCode: AudioErrorCode = audioConsumeFailureCode(error);
    await report({ event: "error", errorCode }, identity);
    await stopAudio();
    throw createAudioConsumeFailure(errorCode);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message !== null && typeof message === "object" && (message as { type?: unknown }).type === "audio:consume") {
    const streamId = (message as { streamId?: unknown }).streamId;
    const routeId = (message as { routeId?: unknown }).routeId;
    const sessionId = (message as { sessionId?: unknown }).sessionId;
    const live = (message as { live?: unknown }).live;
    if (typeof streamId !== "string" || !streamId || (routeId !== "compass-live-shop" && routeId !== "qianchuan-agent" && routeId !== "qianchuan-board") || typeof sessionId !== "string" || !sessionId) { sendResponse({ ok: false, errorCode: "invalid_stream_id" }); return false; }
    void consume(streamId, routeId, sessionId, live && typeof live === "object" ? live as { sessionId: string; pairToken: string; audioWsUrl: string } : undefined).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, errorCode: audioConsumeFailureCode(error) }));
    return true;
  }
  if (message !== null && typeof message === "object" && (message as { type?: unknown }).type === "audio:stop") {
    void stopAudio().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

window.addEventListener("offline", () => { void report({ event: "offline" }); });
window.addEventListener("online", () => { void report({ event: "online" }); });
