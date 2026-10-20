export const PLATFORM_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const PLAN_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
export const DEFAULT_ARK_BASE_URL = PLATFORM_ARK_BASE_URL;
export const DEFAULT_AGENT_PLAN_MODEL = "doubao-seed-2-0-lite";
export const DEFAULT_CODING_PLAN_MODEL = "ark-code-latest";
export const ARK_COST_TABLE_VERSION = "estimate-v1";
/** 主播复盘／本场复盘是运营主动点的一轮表达，给够时间，不按诊断卡的 8 秒。 */
export const REVIEW_ARK_TIMEOUT_MS = 45_000;
export const ARK_INPUT_YUAN_PER_MILLION = 0.8;
export const ARK_OUTPUT_YUAN_PER_MILLION = 2;

export function usesArkPlanDataPlane(model: string | undefined): boolean {
  if (!model) return false;
  if (model.startsWith("ep-")) return false;
  return /^ark-code(?:-|$)/.test(model) || model.startsWith("doubao-");
}

export function resolveArkBaseUrl(model: string | undefined, explicitBaseUrl?: string): string {
  const override = explicitBaseUrl?.trim();
  if (override) return override.replace(/\/+$/, "");
  return usesArkPlanDataPlane(model) ? PLAN_ARK_BASE_URL : PLATFORM_ARK_BASE_URL;
}

export type ArkChatRequest = {
  apiKey: string;
  model: string;
  baseUrl: string;
  system: string;
  user: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type ArkChatResult = {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
};

export function estimateArkCostYuan(inputTokens: number | undefined, outputTokens: number | undefined): number | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const cost = ((inputTokens ?? 0) / 1_000_000) * ARK_INPUT_YUAN_PER_MILLION
    + ((outputTokens ?? 0) / 1_000_000) * ARK_OUTPUT_YUAN_PER_MILLION;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function parseArkMessageText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) throw new Error("ARK_EMPTY_RESPONSE");
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("ARK_EMPTY_RESPONSE");
  const message = choices[0] as { message?: { content?: unknown } };
  const content = message.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) throw new Error("ARK_EMPTY_RESPONSE");
  return content;
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? trimmed).trim();
  return JSON.parse(raw) as unknown;
}

function usageTokens(payload: unknown): { inputTokens?: number; outputTokens?: number } {
  if (typeof payload !== "object" || payload === null) return {};
  const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  const inputTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {})
  };
}

export async function arkChatCompletion(request: ArkChatRequest): Promise<ArkChatResult> {
  const timeoutMs = request.timeoutMs ?? 8000;
  const fetchImpl = request.fetchImpl ?? fetch;
  const base = request.baseUrl.replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: request.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user }
      ]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`ARK_HTTP_${response.status}`);
  const payload: unknown = await response.json();
  return { text: parseArkMessageText(payload), ...usageTokens(payload) };
}
