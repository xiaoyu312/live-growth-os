import { createHmac, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";

export type TencentCredentials = { secretId: string; secretKey: string };
export type TencentAsrFinal = { text: string; startMs?: number; endMs?: number; latencyMs: number };

export async function readTencentCredentials(filePath: string): Promise<TencentCredentials> {
  const text = await readFile(filePath, "utf8");
  const rows = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map((line) => line.split(",").map((cell) => cell.trim()));
  if (rows.length !== 2 || rows[0]?.[0] !== "SecretId" || rows[0]?.[1] !== "SecretKey" || rows[1]?.length !== 2 || !rows[1][0] || !rows[1][1]) {
    throw new Error("腾讯云凭证文件必须是严格的 SecretId,SecretKey 两行 CSV");
  }
  return { secretId: rows[1][0]!, secretKey: rows[1][1]! };
}

export function credentialsFromEnvSecrets(env: Record<string, string | undefined> = process.env): TencentCredentials | undefined {
  const secretId = env.TENCENT_ASR_SECRET_ID?.trim();
  const secretKey = env.TENCENT_ASR_SECRET_KEY?.trim();
  if (!secretId || !secretKey) return undefined;
  return { secretId, secretKey };
}

export async function resolveTencentAsrCredentials(env: Record<string, string | undefined> = process.env): Promise<TencentCredentials | undefined> {
  const fromEnv = credentialsFromEnvSecrets(env);
  if (fromEnv) return fromEnv;
  const filePath = env.TENCENT_ASR_CREDENTIALS_FILE?.trim();
  if (!filePath) return undefined;
  return readTencentCredentials(filePath);
}

/** 官方实时语音识别 V2（2026-07-23）：大模型 2.0 计费对应 16k_zh_en_2.0，不带说话人分离。 */
export const DEFAULT_TENCENT_ASR_ENGINE_MODEL_TYPE = "16k_zh_en_2.0";

/** Hy-ASR-* 官方：不支持 VAD、单次识别约 60 秒。仅对这些引擎主动 end 再重连。16k_zh_en_2.0 靠 needvad，不按此时限切。 */
export const HY_ASR_SEGMENT_LIMIT_MS = 20_000;

/** 只允许腾讯引擎 id 形态，拒绝空格与 query 注入。 */
const SAFE_ENGINE_MODEL_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function resolveTencentAsrEngineModelType(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value.length > 0 && SAFE_ENGINE_MODEL_TYPE.test(value)) return value;
  return DEFAULT_TENCENT_ASR_ENGINE_MODEL_TYPE;
}

export function isHyAsrEngine(engineModelType?: string, env: Record<string, string | undefined> = process.env): boolean {
  const engine = resolveTencentAsrEngineModelType(engineModelType ?? env.TENCENT_ASR_ENGINE_MODEL_TYPE);
  return engine.startsWith("Hy-ASR");
}

/** 官方写明仅适用于大模型 2.0 计费方案的引擎。Hy-ASR-3.0-preview 不在此列、不扣该资源包。 */
export function isTencentAsr20Engine(engineModelType?: string, env: Record<string, string | undefined> = process.env): boolean {
  const engine = resolveTencentAsrEngineModelType(engineModelType ?? env.TENCENT_ASR_ENGINE_MODEL_TYPE);
  return engine === "16k_zh_en_2.0" || engine === "16k_zh_en_speaker_2.0";
}

export type TencentAsrHotwordInjection = { injectList: boolean; injectId: boolean };

/** 2.0 / Hy-ASR 默认不注入热词，须 TENCENT_ASR_INJECT_HOTWORDS=1。16k_zh 保持原默认注入。 */
export function resolveTencentAsrHotwordInjection(input: {
  engineModelType?: string;
  env?: Record<string, string | undefined>;
  skipHotwords?: boolean;
} = {}): TencentAsrHotwordInjection {
  const env = input.env ?? process.env;
  const engine = resolveTencentAsrEngineModelType(input.engineModelType ?? env.TENCENT_ASR_ENGINE_MODEL_TYPE);
  const flag = env.TENCENT_ASR_INJECT_HOTWORDS?.trim();
  const explicitOn = flag === "1";
  const explicitOff = flag === "0";
  const hasId = Boolean(env.TENCENT_ASR_HOTWORD_ID?.trim());
  if (isHyAsrEngine(engine, env) || isTencentAsr20Engine(engine, env)) {
    return { injectList: !input.skipHotwords && explicitOn, injectId: explicitOn && hasId };
  }
  return { injectList: !input.skipHotwords && !explicitOff, injectId: hasId };
}

function isSliceFinal(sliceType: unknown): boolean {
  return sliceType === 2 || sliceType === "2";
}

function isSentenceFinal(sentenceType: unknown): boolean {
  return sentenceType === 1 || sentenceType === "1";
}

function isStreamFinal(value: unknown): boolean {
  return value === 1 || value === "1";
}

function sameAsrFinal(left: TencentAsrFinal, right: TencentAsrFinal): boolean {
  return left.text === right.text && left.startMs === right.startMs && left.endMs === right.endMs;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readTimedText(source: Record<string, unknown>, textKey: "voice_text_str" | "sentence", latencyMs: number): TencentAsrFinal | undefined {
  const raw = source[textKey];
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return undefined;
  const startMs = typeof source.start_time === "number" ? source.start_time : undefined;
  const endMs = typeof source.end_time === "number" ? source.end_time : undefined;
  return { text, ...(startMs === undefined ? {} : { startMs }), ...(endMs === undefined ? {} : { endMs }), latencyMs };
}

function pushFinal(finals: TencentAsrFinal[], item: TencentAsrFinal): void {
  if (!finals.some((existing) => sameAsrFinal(existing, item))) finals.push(item);
}

export type TencentAsrDecode = {
  handshakeOk: boolean;
  errorCode?: string;
  finals: TencentAsrFinal[];
  lastPartial?: TencentAsrFinal;
};

/** 解析腾讯实时 ASR JSON：旧 result.slice_type=2、新 sentences.sentence_type=1、或整段 final=1 才落稳态。 */
export function decodeTencentAsrMessage(input: {
  raw: string;
  startedAt: number;
  nowMs: number;
  lastPartial?: TencentAsrFinal;
}): TencentAsrDecode {
  let message: unknown;
  try { message = JSON.parse(input.raw); } catch { return { handshakeOk: false, finals: [] }; }
  if (!message || typeof message !== "object") return { handshakeOk: false, finals: [] };
  const root = message as Record<string, unknown>;
  if (root.code !== undefined && root.code !== 0) {
    return { handshakeOk: false, errorCode: typeof root.code === "number" ? `ASR_CODE_${root.code}` : "ASR_CODE_UNKNOWN", finals: [] };
  }
  const handshakeOk = root.code === 0;
  const latencyMs = input.nowMs - input.startedAt;
  let lastPartial = input.lastPartial;
  const finals: TencentAsrFinal[] = [];
  const result = asRecord(root.result);
  if (result) {
    const partial = readTimedText(result, "voice_text_str", latencyMs);
    if (partial) {
      lastPartial = partial;
      if (isSliceFinal(result.slice_type)) pushFinal(finals, partial);
    }
  }
  const sentenceItems = Array.isArray(root.sentences) ? root.sentences : root.sentences ? [root.sentences] : [];
  for (const item of sentenceItems) {
    const sentence = asRecord(item);
    if (!sentence) continue;
    const partial = readTimedText(sentence, "sentence", latencyMs);
    if (!partial) continue;
    lastPartial = partial;
    if (isSentenceFinal(sentence.sentence_type)) pushFinal(finals, partial);
  }
  if (isStreamFinal(root.final) && lastPartial) pushFinal(finals, lastPartial);
  return { handshakeOk, finals, ...(lastPartial ? { lastPartial } : {}) };
}

export type TencentAsrUrlOptions = {
  hotwordId?: string;
  hotwordList?: readonly string[];
  engineModelType?: string;
  env?: Record<string, string | undefined>;
};

function engineModelTypeFromOptions(options: TencentAsrUrlOptions): string {
  if (options.engineModelType !== undefined) {
    return resolveTencentAsrEngineModelType(options.engineModelType);
  }
  const env = options.env ?? process.env;
  return resolveTencentAsrEngineModelType(env.TENCENT_ASR_ENGINE_MODEL_TYPE);
}

export function encodeTencentHotwordList(words: readonly string[]): string {
  return words
    .map((word) => word.trim())
    .filter((word) => word.length > 0 && !word.includes(",") && !word.includes("|"))
    .map((word) => `${word}|11`)
    .join(",");
}

export function buildTencentAsrUrl(appId: string, credentials: TencentCredentials, nowSec = Math.floor(Date.now() / 1000), voiceId = randomUUID(), options: TencentAsrUrlOptions = {}): string {
  if (!/^\d+$/.test(appId)) throw new Error("TENCENT_ASR_APP_ID 必须为数字");
  const hotwordList = options.hotwordList?.length ? encodeTencentHotwordList(options.hotwordList) : "";
  const params: Record<string, string> = {
    engine_model_type: engineModelTypeFromOptions(options),
    expired: String(nowSec + 900),
    // 16k_zh_en_2.0 官方 needvad 默认 0，超 60s 会强制断；长连接必须开 VAD。
    needvad: "1",
    // Tencent's realtime ASR contract accepts a decimal nonce no longer than
    // ten digits.  Keep it numeric and bounded; never expose it in logs.
    nonce: String(randomInt(0, 10_000_000_000)),
    secretid: credentials.secretId,
    timestamp: String(nowSec),
    voice_format: "1",
    voice_id: voiceId,
    ...(options.hotwordId ? { hotword_id: options.hotwordId } : {}),
    ...(hotwordList ? { hotword_list: hotwordList } : {})
  };
  const query = Object.keys(params).sort().map((key) => `${key}=${encodeURIComponent(params[key]!)}`).join("&");
  const base = `asr.cloud.tencent.com/asr/v2/${appId}?${query}`;
  const signature = createHmac("sha1", credentials.secretKey).update(base).digest("base64");
  return `wss://${base}&signature=${encodeURIComponent(signature)}`;
}

export type TencentAsrOptions = {
  appId: string;
  credentials: TencentCredentials;
  onFinal: (result: TencentAsrFinal) => Promise<void>;
  onState?: (state: "connecting" | "open" | "closed" | "error", detail?: string) => void;
  hotwordId?: string;
  hotwordList?: readonly string[];
  engineModelType?: string;
};

export class TencentAsrConnection {
  private readonly socket: WebSocket;
  private readonly startedAt = Date.now();
  private opened = false;
  private closed = false;
  private ending = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private readySucceeded = false;
  private readonly queued: Buffer[] = [];
  private lastPartial: TencentAsrFinal | undefined;
  private lastEmittedKey: string | undefined;

  constructor(private readonly options: TencentAsrOptions) {
    const url = buildTencentAsrUrl(options.appId, options.credentials, Math.floor(Date.now() / 1000), randomUUID(), {
      ...(options.hotwordId ? { hotwordId: options.hotwordId } : {}),
      ...(options.hotwordList?.length ? { hotwordList: options.hotwordList } : {}),
      ...(options.engineModelType ? { engineModelType: options.engineModelType } : {})
    });
    this.readyPromise = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.readyTimer = setTimeout(() => this.rejectNotReady("ASR_HANDSHAKE_TIMEOUT"), 5000);
    this.options.onState?.("connecting");
    this.socket = new WebSocket(url);
    this.socket.on("open", () => {
      this.opened = true;
      this.options.onState?.("open");
    });
    this.socket.on("message", (data) => { void this.handleMessage(data.toString()).catch(() => this.options.onState?.("error", "ASR_MESSAGE_HANDLER_ERROR")); });
    this.socket.on("error", () => { this.rejectNotReady("ASR_SOCKET_ERROR"); this.options.onState?.("error", "ASR_SOCKET_ERROR"); this.forceClose(); });
    this.socket.on("close", () => { this.closed = true; if (this.closeTimer) clearTimeout(this.closeTimer); this.rejectNotReady("ASR_SOCKET_CLOSED"); this.options.onState?.("closed"); });
  }

  private forceClose(): void {
    if (this.closed) return;
    this.ending = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }

  private rejectNotReady(code: string): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readySucceeded = false;
    this.queued.length = 0;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.rejectReady(new Error(code));
    if (!this.closed && this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }

  private resolveAsrReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readySucceeded = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.resolveReady();
    for (const chunk of this.queued.splice(0)) {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(chunk);
    }
  }

  ready(): Promise<void> { return this.readyPromise; }

  private finalKey(result: TencentAsrFinal): string {
    return `${result.startMs ?? ""}:${result.endMs ?? ""}:${result.text}`;
  }

  private async emitFinal(result: TencentAsrFinal): Promise<void> {
    const key = this.finalKey(result);
    if (this.lastEmittedKey === key) return;
    this.lastEmittedKey = key;
    await this.options.onFinal(result);
  }

  private async handleMessage(raw: string): Promise<void> {
    const decoded = decodeTencentAsrMessage({ raw, startedAt: this.startedAt, nowMs: Date.now(), ...(this.lastPartial ? { lastPartial: this.lastPartial } : {}) });
    if (decoded.errorCode) {
      this.rejectNotReady(decoded.errorCode);
      this.options.onState?.("error", decoded.errorCode);
      this.forceClose();
      return;
    }
    if (decoded.handshakeOk) this.resolveAsrReady();
    if (decoded.lastPartial) this.lastPartial = decoded.lastPartial;
    for (const result of decoded.finals) await this.emitFinal(result);
  }

  writePcm(chunk: Uint8Array): void {
    if (this.closed || chunk.byteLength === 0) return;
    const data = Buffer.from(chunk);
    if (!this.readySucceeded) {
      if (!this.readySettled && this.queued.length < 20) this.queued.push(data);
      return;
    }
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(data);
  }

  end(): void {
    if (this.closed || this.ending) return;
    this.ending = true;
    if (this.opened && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "end" }));
    if (this.lastPartial && isHyAsrEngine(this.options.engineModelType)) void this.emitFinal(this.lastPartial);
    this.closeTimer = setTimeout(() => { if (!this.closed) this.socket.close(); }, 2000);
  }
}
