import { mvpActionSchema, type MvpAction } from "@live-growth/contracts";

export type NarrativeRewriter = (input: MvpAction) => string | Promise<string>;
export type NarrativeRewriteResult = {
  action: MvpAction;
  fallback: boolean;
  reason: "disabled" | "invalid_output" | "accepted";
};

const NARRATIVE_ALWAYS_FORBIDDEN = /追投|收紧|降低消耗|暂停计划|扩大人群|调整定向|保持投放|修改预算|关闭计划|延长当前商品讲解|虚假稀缺/;
const NARRATIVE_SCARCITY_ONLY = /最后几单|马上没货|再不抢就没了|马上恢复原价|即将结束|锁库存|库存仅剩|库存只剩|限量|倒计时|优惠即将结束/;

/**
 * Optional text-only adapter. It is deliberately disabled by default and
 * cannot change any structured state; only coreInstruction may be rewritten.
 */
export class NarrativeAdapter {
  constructor(private readonly enabled = false, private readonly rewriter?: NarrativeRewriter) {}

  async rewrite(input: MvpAction): Promise<NarrativeRewriteResult> {
    const original = mvpActionSchema.parse(input);
    if (!this.enabled || !this.rewriter) return { action: original, fallback: true, reason: "disabled" };
    try {
      const output = await this.rewriter(original);
      const invalidScarcity = !original.realScarcity && NARRATIVE_SCARCITY_ONLY.test(output);
      if (typeof output !== "string" || output.trim().length === 0 || output.length > 300 || NARRATIVE_ALWAYS_FORBIDDEN.test(output) || invalidScarcity) {
        return { action: original, fallback: true, reason: "invalid_output" };
      }
      const rewritten = mvpActionSchema.parse({ ...original, coreInstruction: output.trim() });
      return { action: rewritten, fallback: false, reason: "accepted" };
    } catch {
      return { action: original, fallback: true, reason: "invalid_output" };
    }
  }
}

export const defaultNarrativeAdapter = new NarrativeAdapter();
