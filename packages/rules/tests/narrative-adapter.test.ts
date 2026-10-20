import { describe, expect, it } from "vitest";
import { defaultNarrativeAdapter, NarrativeAdapter } from "../src/narrative-adapter";
import type { MvpAction } from "@live-growth/contracts";

const action: MvpAction = {
  id: "mvp-action-1", state: "S4", actionKey: "complete_closure", priority: "critical",
  coreInstruction: "保持当前商品，只补齐确认缺失的价格机制和购买指令。", whatHappened: "点击后支付偏低。",
  why: "点击样本充足但支付承接偏弱。", productStrategy: "只补齐确认缺失环节。", evidence: [{ type: "metric", label: "点击后支付", value: "2%" }],
  createdAt: "2026-08-10T08:00:00.000Z", expiresAt: "2026-08-10T08:05:00.000Z", currentProductId: "mvp-low-pan", realScarcity: false
};

describe("NarrativeAdapter", () => {
  it("默认关闭时返回原确定性动作并标记 fallback", async () => {
    const result = await defaultNarrativeAdapter.rewrite(action);
    expect(result).toMatchObject({ fallback: true, reason: "disabled", action });
  });

  it("只允许改写 coreInstruction，结构化状态、动作键和证据保持不变", async () => {
    const result = await new NarrativeAdapter(true, () => "现在先用一句话补齐价格机制，再给出购买指令。\\n").rewrite(action);
    expect(result.fallback).toBe(false);
    expect(result.action).toMatchObject({ state: action.state, actionKey: action.actionKey, currentProductId: action.currentProductId, evidence: action.evidence });
    expect(result.action.coreInstruction).toContain("价格机制");
  });

  it("投流禁词、无真实稀缺依据或非法输出回退确定性模板", async () => {
    const rejected = await new NarrativeAdapter(true, () => "建议追投并降低消耗").rewrite(action);
    expect(rejected).toMatchObject({ fallback: true, reason: "invalid_output", action });
    for (const phrase of ["最后几单", "马上没货", "再不抢就没了", "马上恢复原价", "即将结束", "锁库存", "库存仅剩", "库存只剩", "限量", "倒计时", "优惠即将结束"]) {
      const scarcity = await new NarrativeAdapter(true, () => `现在${phrase}，请完成收口。`).rewrite(action);
      expect(scarcity).toMatchObject({ fallback: true, reason: "invalid_output" });
    }
    const factualScarcity = await new NarrativeAdapter(true, () => "库存已确认只剩少量，按已确认事实完成收口。").rewrite({ ...action, realScarcity: true });
    expect(factualScarcity).toMatchObject({ fallback: false, reason: "accepted" });
    const malformed = await new NarrativeAdapter(true, () => ({ coreInstruction: "改写" } as unknown as string)).rewrite(action);
    expect(malformed.fallback).toBe(true);
  });
});
