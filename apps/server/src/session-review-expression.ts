import {
  sessionReviewExpressionOutputSchema,
  sessionReviewSchema,
  type SessionReview,
  type SessionReviewFinding
} from "@live-growth/contracts";
import {
  SESSION_REVIEW_PROMPT_VERSION,
  SESSION_REVIEW_SYSTEM_PROMPT,
  buildSessionReviewUserPayload,
  sessionReviewInputSummary
} from "@live-growth/prompts";
import { shanghaiRangeLabel } from "@live-growth/rules";
import {
  ARK_COST_TABLE_VERSION,
  REVIEW_ARK_TIMEOUT_MS,
  arkChatCompletion,
  estimateArkCostYuan,
  parseJsonObject,
  resolveArkBaseUrl,
  type ArkChatResult
} from "./ark-client";

const FORBIDDEN = /grain\s*=\s*hour|\bunknown\b|\bS[0-6]\b|\bGMV\b|\bLLM\b|\bGPT\b|导致|因果|加权|底稿/;

export type SessionReviewExpressionChat = (input: { system: string; user: string }) => Promise<ArkChatResult>;

export type SessionReviewExpressionAudit = {
  trigger: "operator_session_review";
  promptVersion: string;
  model: string;
  rangeStartAt: string;
  rangeEndAt: string;
  inputSummary: ReturnType<typeof sessionReviewInputSummary>;
  outputPreview: string;
  latencyMs: number;
  costTableVersion: string;
  outcome: "applied" | "fallback" | "skipped";
  inputTokens?: number;
  outputTokens?: number;
  costYuanEstimate?: number;
  reason?: string;
};

function citedNumberAppears(text: string, value: number): boolean {
  const plain = String(value);
  const grouped = value.toLocaleString("zh-CN");
  const escapedPlain = plain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedGrouped = grouped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\d)(?:${escapedPlain}|${escapedGrouped})(?!\\d)`).test(text);
}

function findingAllowed(template: SessionReviewFinding, text: string): string | undefined {
  if (FORBIDDEN.test(text)) return "forbidden_token";
  for (const number of template.citedNumbers) {
    if (!citedNumberAppears(text, number.value)) return "missing_cited_number";
  }
  return undefined;
}

function idsMatch(template: Array<{ id: string }>, output: Array<{ id: string }>): boolean {
  return output.length === template.length && output.every((item, index) => item.id === template[index]?.id);
}

export function applySessionReviewExpression(template: SessionReview, raw: unknown): { ok: true; review: SessionReview } | { ok: false; reason: string } {
  const parsed = sessionReviewExpressionOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema" };
  const output = parsed.data;
  if (output.summary.id !== template.narrative.summary.id) return { ok: false, reason: "id_mismatch" };
  if (output.bottleneck.id !== template.narrative.bottleneck.id) return { ok: false, reason: "id_mismatch" };
  if (!idsMatch(template.narrative.chapters, output.chapters)) return { ok: false, reason: "id_mismatch" };
  if (!idsMatch(template.narrative.strengths, output.strengths)) return { ok: false, reason: "id_mismatch" };
  if (!idsMatch(template.narrative.gaps, output.gaps)) return { ok: false, reason: "id_mismatch" };
  if (output.nextSteps.length !== template.narrative.nextSteps.length) return { ok: false, reason: "id_mismatch" };
  if (!output.summary.text.includes(template.hostName)) return { ok: false, reason: "missing_host" };
  const rewritten: Array<{ template: SessionReviewFinding; text: string }> = [
    { template: template.narrative.summary, text: output.summary.text },
    { template: template.narrative.bottleneck, text: output.bottleneck.text },
    ...template.narrative.chapters.map((item, index) => ({ template: item, text: output.chapters[index]!.text })),
    ...template.narrative.strengths.map((item, index) => ({ template: item, text: output.strengths[index]!.text })),
    ...template.narrative.gaps.map((item, index) => ({ template: item, text: output.gaps[index]!.text }))
  ];
  for (const item of rewritten) {
    const reason = findingAllowed(item.template, item.text);
    if (reason) return { ok: false, reason };
  }
  for (const text of output.nextSteps) {
    if (FORBIDDEN.test(text)) return { ok: false, reason: "forbidden_token" };
  }
  const narrative = {
    summary: { ...template.narrative.summary, text: output.summary.text },
    bottleneck: { ...template.narrative.bottleneck, text: output.bottleneck.text },
    chapters: template.narrative.chapters.map((item, index) => ({ ...item, text: output.chapters[index]!.text })),
    strengths: template.narrative.strengths.map((item, index) => ({ ...item, text: output.strengths[index]!.text })),
    gaps: template.narrative.gaps.map((item, index) => ({ ...item, text: output.gaps[index]!.text })),
    nextSteps: output.nextSteps
  };
  return {
    ok: true,
    review: sessionReviewSchema.parse({
      ...template,
      provider: "ark-expression",
      promptVersion: SESSION_REVIEW_PROMPT_VERSION,
      narrative
    })
  };
}

export class SessionReviewExpressionService {
  readonly audits: SessionReviewExpressionAudit[] = [];
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly baseUrl: string;
  private readonly chat: SessionReviewExpressionChat;

  constructor(options: {
    env?: Record<string, string | undefined>;
    chat?: SessionReviewExpressionChat;
  } = {}) {
    const env = options.env ?? {};
    const apiKey = env.ARK_API_KEY?.trim();
    const model = env.ARK_MODEL?.trim() || env.ARK_ENDPOINT_ID?.trim();
    this.apiKey = apiKey || undefined;
    this.model = model || undefined;
    this.baseUrl = resolveArkBaseUrl(this.model, env.ARK_BASE_URL);
    this.chat = options.chat ?? ((input) => arkChatCompletion({
      apiKey: this.apiKey ?? "",
      model: this.model ?? "",
      baseUrl: this.baseUrl,
      system: input.system,
      user: input.user,
      timeoutMs: REVIEW_ARK_TIMEOUT_MS
    }));
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): SessionReviewExpressionService {
    return new SessionReviewExpressionService({ env });
  }

  configured(): boolean {
    return Boolean(this.apiKey && this.model);
  }

  private pushAudit(audit: SessionReviewExpressionAudit): void {
    this.audits.push(audit);
    if (this.audits.length > 50) this.audits.shift();
  }

  async express(template: SessionReview): Promise<SessionReview> {
    const inputSummary = sessionReviewInputSummary(template);
    const model = this.model ?? "unknown";
    if (!this.configured() || template.coverage.speechFinalCount === 0) {
      this.pushAudit({
        trigger: "operator_session_review",
        promptVersion: SESSION_REVIEW_PROMPT_VERSION,
        model,
        rangeStartAt: template.rangeStartAt,
        rangeEndAt: template.rangeEndAt,
        inputSummary,
        outputPreview: "skipped",
        latencyMs: 0,
        costTableVersion: ARK_COST_TABLE_VERSION,
        outcome: "skipped",
        reason: this.configured() ? "insufficient_speech" : "not_configured"
      });
      return template;
    }
    const started = Date.now();
    try {
      const user = JSON.stringify(buildSessionReviewUserPayload(template, shanghaiRangeLabel(template.rangeStartAt, template.rangeEndAt)));
      const result = await this.chat({ system: SESSION_REVIEW_SYSTEM_PROMPT, user });
      const applied = applySessionReviewExpression(template, parseJsonObject(result.text));
      const latencyMs = Date.now() - started;
      const costYuanEstimate = this.baseUrl.includes("/api/plan")
        ? undefined
        : estimateArkCostYuan(result.inputTokens, result.outputTokens);
      if (!applied.ok) {
        this.pushAudit({
          trigger: "operator_session_review",
          promptVersion: SESSION_REVIEW_PROMPT_VERSION,
          model,
          rangeStartAt: template.rangeStartAt,
          rangeEndAt: template.rangeEndAt,
          inputSummary,
          outputPreview: "fallback",
          latencyMs,
          costTableVersion: ARK_COST_TABLE_VERSION,
          outcome: "fallback",
          reason: applied.reason,
          ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
          ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
          ...(costYuanEstimate !== undefined ? { costYuanEstimate } : {})
        });
        return template;
      }
      this.pushAudit({
        trigger: "operator_session_review",
        promptVersion: SESSION_REVIEW_PROMPT_VERSION,
        model,
        rangeStartAt: template.rangeStartAt,
        rangeEndAt: template.rangeEndAt,
        inputSummary,
        outputPreview: applied.review.narrative.summary.text.slice(0, 120),
        latencyMs,
        costTableVersion: ARK_COST_TABLE_VERSION,
        outcome: "applied",
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(costYuanEstimate !== undefined ? { costYuanEstimate } : {})
      });
      return applied.review;
    } catch {
      this.pushAudit({
        trigger: "operator_session_review",
        promptVersion: SESSION_REVIEW_PROMPT_VERSION,
        model,
        rangeStartAt: template.rangeStartAt,
        rangeEndAt: template.rangeEndAt,
        inputSummary,
        outputPreview: "fallback",
        latencyMs: Date.now() - started,
        costTableVersion: ARK_COST_TABLE_VERSION,
        outcome: "fallback",
        reason: "request_failed"
      });
      return template;
    }
  }
}
