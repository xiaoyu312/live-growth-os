import {
  diagnosisExpressionOutputSchema,
  diagnosisExpressionV2OutputSchema,
  diagnosisWindowSchema,
  type DiagnosisFinding,
  type DiagnosisWindow
} from "@live-growth/contracts";
import {
  DIAGNOSIS_EXPRESSION_PROMPT_VERSION,
  DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT,
  DIAGNOSIS_EXPRESSION_V2_PROMPT_VERSION,
  DIAGNOSIS_EXPRESSION_V2_SYSTEM_PROMPT,
  buildDiagnosisExpressionUserPayload,
  buildDiagnosisExpressionV2UserPayload,
  diagnosisExpressionInputSummary
} from "@live-growth/prompts";
import { buildDiagnosisEvidencePacket, shouldSkipDiagnosisExpression } from "@live-growth/rules";
import {
  ARK_COST_TABLE_VERSION,
  arkChatCompletion,
  estimateArkCostYuan,
  parseJsonObject,
  resolveArkBaseUrl,
  type ArkChatResult
} from "./ark-client";

const FORBIDDEN = /grain\s*=\s*hour|\bunknown\b|\bS[0-6]\b|\bGMV\b|\bLLM\b|\bGPT\b|[a-z]{2,}_[a-z]{2,}|导致|因果/;
const HOLD_ACTION = /暂不|继续观察|先不|保持现在|等下一个/;
const ACTION_INTENT: Record<DiagnosisWindow["actionKind"], RegExp> = {
  hold: HOLD_ACTION,
  wait: HOLD_ACTION,
  check_spend: /投放/,
  traffic_quality: /流量/,
  retain: /状态|留人|互动/,
  click_cta: /小黄车|商品卡|购物车/,
  close_gift: /赠品|保障|售后/,
  close_price: /到手价|价格/,
  close_urgency: /催单|购买指令|锁单|抓紧|逼单/
};

export type DiagnosisExpressionChat = (input: { system: string; user: string }) => Promise<ArkChatResult>;

export type DiagnosisExpressionAudit = {
  trigger: "completed_15m_window" | "diagnosis_v2";
  promptVersion: string;
  model: string;
  windowStartAt: string;
  inputSummary: ReturnType<typeof diagnosisExpressionInputSummary>;
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

function findingAllowed(template: DiagnosisFinding, text: string): string | undefined {
  if (FORBIDDEN.test(text)) return "forbidden_token";
  for (const number of template.citedNumbers) {
    if (!citedNumberAppears(text, number.value)) return "missing_cited_number";
  }
  return undefined;
}

function idsMatch(template: Array<{ id: string }>, output: Array<{ id: string }>): boolean {
  return output.length === template.length && output.every((item, index) => item.id === template[index]?.id);
}

function inventedNumber(text: string, allowed: readonly number[]): boolean {
  const matches = text.match(/\d+(?:\.\d+)?/g) ?? [];
  return matches.some((token) => {
    const value = Number(token.replace(/,/g, ""));
    return !allowed.some((item) => item === value);
  });
}

export function applyDiagnosisExpressionV2(template: DiagnosisWindow, raw: unknown): { ok: true; diagnosis: DiagnosisWindow } | { ok: false; reason: string } {
  if (raw && typeof raw === "object" && "actionKind" in raw) return { ok: false, reason: "action_kind_locked" };
  const parsed = diagnosisExpressionV2OutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema" };
  const output = parsed.data;
  const fields: Array<{ template: DiagnosisFinding; text: string }> = [
    { template: template.verdict, text: output.whatHappened },
    { template: template.evidence[0] ?? template.verdict, text: output.why },
    { template: template.action, text: output.action },
    { template: template.watchNext, text: output.watchNext }
  ];
  const allowed = fields.flatMap((item) => item.template.citedNumbers.map((number) => number.value));
  for (const item of fields) {
    const reason = findingAllowed(item.template, item.text);
    if (reason) return { ok: false, reason };
    if (inventedNumber(item.text, allowed)) return { ok: false, reason: "invented_number" };
  }
  if (!ACTION_INTENT[template.actionKind].test(output.action)) return { ok: false, reason: "action_intent" };
  const verdict = { ...template.verdict, text: output.whatHappened };
  const evidence = [{ ...(template.evidence[0] ?? template.verdict), id: template.evidence[0]?.id ?? "why", text: output.why }];
  const action = { ...template.action, text: output.action };
  const watchNext = { ...template.watchNext, text: output.watchNext };
  return {
    ok: true,
    diagnosis: diagnosisWindowSchema.parse({
      ...template,
      provider: "ark-expression",
      verdict,
      evidence,
      action,
      watchNext,
      conclusions: [verdict, ...evidence].slice(0, 3),
      nextWindowSuggestion: action
    })
  };
}

export function applyDiagnosisExpression(template: DiagnosisWindow, raw: unknown): { ok: true; diagnosis: DiagnosisWindow } | { ok: false; reason: string } {
  if (raw && typeof raw === "object" && "whatHappened" in raw) return applyDiagnosisExpressionV2(template, raw);
  const parsed = diagnosisExpressionOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema" };
  const output = parsed.data;
  if (output.verdict.id !== template.verdict.id) return { ok: false, reason: "id_mismatch" };
  if (output.action.id !== template.action.id) return { ok: false, reason: "id_mismatch" };
  if (output.watchNext.id !== template.watchNext.id) return { ok: false, reason: "id_mismatch" };
  if (!idsMatch(template.evidence, output.evidence)) return { ok: false, reason: "id_mismatch" };
  if (!idsMatch(template.pending, output.pending)) return { ok: false, reason: "id_mismatch" };
  const rewritten: Array<{ template: DiagnosisFinding; text: string }> = [
    { template: template.verdict, text: output.verdict.text },
    ...template.evidence.map((item, index) => ({ template: item, text: output.evidence[index]!.text })),
    { template: template.action, text: output.action.text },
    { template: template.watchNext, text: output.watchNext.text },
    ...template.pending.map((item, index) => ({ template: item, text: output.pending[index]!.text }))
  ];
  for (const item of rewritten) {
    const reason = findingAllowed(item.template, item.text);
    if (reason) return { ok: false, reason };
  }
  if (!ACTION_INTENT[template.actionKind].test(output.action.text)) return { ok: false, reason: "action_intent" };
  const verdict = { ...template.verdict, text: output.verdict.text };
  const evidence = template.evidence.map((item, index) => ({ ...item, text: output.evidence[index]!.text }));
  const action = { ...template.action, text: output.action.text };
  const watchNext = { ...template.watchNext, text: output.watchNext.text };
  const pending = template.pending.map((item, index) => ({ ...item, text: output.pending[index]!.text }));
  return {
    ok: true,
    diagnosis: diagnosisWindowSchema.parse({
      ...template,
      provider: "ark-expression",
      verdict,
      evidence,
      action,
      watchNext,
      pending,
      conclusions: [verdict, ...evidence].slice(0, 3),
      nextWindowSuggestion: action
    })
  };
}

export class DiagnosisExpressionService {
  private readonly cache = new Map<string, DiagnosisWindow>();
  private readonly attempted = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();
  readonly audits: DiagnosisExpressionAudit[] = [];
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly baseUrl: string;
  private readonly chat: DiagnosisExpressionChat;

  constructor(options: {
    env?: Record<string, string | undefined>;
    chat?: DiagnosisExpressionChat;
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
      user: input.user
    }));
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): DiagnosisExpressionService {
    return new DiagnosisExpressionService({ env });
  }

  configured(): boolean {
    return Boolean(this.apiKey && this.model);
  }

  attach(template: DiagnosisWindow): DiagnosisWindow {
    if (shouldSkipDiagnosisExpression(template)) return template;
    const key = `${template.sessionId}:${template.windowStartAt}:${template.triggerType ?? "scheduled_15m"}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (!this.configured() || this.attempted.has(key)) return template;
    this.attempted.add(key);
    const job = this.execute(template).then((diagnosis) => {
      this.cache.set(key, diagnosis);
    });
    this.inflight.set(key, job);
    void job.finally(() => this.inflight.delete(key));
    return template;
  }

  async settle(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  private pushAudit(audit: DiagnosisExpressionAudit): void {
    this.audits.push(audit);
    if (this.audits.length > 50) this.audits.shift();
  }

  private async execute(template: DiagnosisWindow): Promise<DiagnosisWindow> {
    const started = Date.now();
    const inputSummary = diagnosisExpressionInputSummary(template);
    const model = this.model ?? "unknown";
    const useV2 = Boolean(template.triggerType || template.executionState);
    try {
      const user = useV2
        ? JSON.stringify(buildDiagnosisExpressionV2UserPayload(buildDiagnosisEvidencePacket(template, {
          triggerAt: template.windowEndAt,
          dataFreshness: template.interruptDecision === "status_only" ? "stale" : "fresh"
        }), template))
        : JSON.stringify(buildDiagnosisExpressionUserPayload(template));
      const result = await this.chat({
        system: useV2 ? DIAGNOSIS_EXPRESSION_V2_SYSTEM_PROMPT : DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT,
        user
      });
      const applied = applyDiagnosisExpression(template, parseJsonObject(result.text));
      const latencyMs = Date.now() - started;
      const costYuanEstimate = this.baseUrl.includes("/api/plan")
        ? undefined
        : estimateArkCostYuan(result.inputTokens, result.outputTokens);
      if (!applied.ok) {
        this.pushAudit({
          trigger: useV2 ? "diagnosis_v2" : "completed_15m_window",
          promptVersion: useV2 ? DIAGNOSIS_EXPRESSION_V2_PROMPT_VERSION : DIAGNOSIS_EXPRESSION_PROMPT_VERSION,
          model,
          windowStartAt: template.windowStartAt,
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
      const preview = [applied.diagnosis.verdict.text, applied.diagnosis.action.text].join(" ").slice(0, 120);
      this.pushAudit({
        trigger: useV2 ? "diagnosis_v2" : "completed_15m_window",
        promptVersion: useV2 ? DIAGNOSIS_EXPRESSION_V2_PROMPT_VERSION : DIAGNOSIS_EXPRESSION_PROMPT_VERSION,
        model,
        windowStartAt: template.windowStartAt,
        inputSummary,
        outputPreview: preview,
        latencyMs,
        costTableVersion: ARK_COST_TABLE_VERSION,
        outcome: "applied",
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(costYuanEstimate !== undefined ? { costYuanEstimate } : {})
      });
      return applied.diagnosis;
    } catch {
      this.pushAudit({
        trigger: useV2 ? "diagnosis_v2" : "completed_15m_window",
        promptVersion: useV2 ? DIAGNOSIS_EXPRESSION_V2_PROMPT_VERSION : DIAGNOSIS_EXPRESSION_PROMPT_VERSION,
        model,
        windowStartAt: template.windowStartAt,
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
