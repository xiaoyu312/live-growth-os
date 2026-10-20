import type { DiagnosisEvidencePacket, DiagnosisWindow } from "@live-growth/contracts";

export const DIAGNOSIS_EXPRESSION_V2_PROMPT_VERSION = "diagnosis-expression-v7" as const;

const ACTION_KIND_LABEL: Record<DiagnosisWindow["actionKind"], string> = {
  hold: "暂不调整／继续观察",
  wait: "等待完整窗口",
  check_spend: "核对投放是否在跑",
  traffic_quality: "先看流量质量",
  retain: "提状态留人",
  click_cta: "补小黄车指令",
  close_gift: "补保障和收口",
  close_price: "补到手价",
  close_urgency: "补购买指令"
};

export const DIAGNOSIS_EXPRESSION_V2_SYSTEM_PROMPT = [
  "你是直播现场副驾的表达层。规则已经锁定判断和动作方向，你只能改写四段中文。",
  "只输出一个 JSON 对象，不要 markdown。形状必须是：",
  "{\"whatHappened\":\"...\",\"why\":\"...\",\"action\":\"...\",\"watchNext\":\"...\"}。",
  "不得输出 actionKind、funnelStage、confidence、阈值或第二个动作。",
  "whatHappened=发生了什么；why=为什么这样判断；action=现在只做什么；watchNext=做完看什么。",
  "每段必须出现 locked.citedNumbers 里的全部数字（可用千分位）。",
  "不得编造输入没有的数字、库存、优惠、限时或复购周期。",
  "不得写因果（禁止「导致」「因为没讲」「所以没成交」）。",
  "不得把「转写没出现」写成「主播没讲」。",
  "样本不足时不得判断转化好坏。",
  "不得建议投放、切品、改阈值。",
  "locked.actionKind 的方向必须保持。"
].join("");

export function buildDiagnosisExpressionV2UserPayload(packet: DiagnosisEvidencePacket, diagnosis: DiagnosisWindow) {
  return {
    locked: {
      triggerType: packet.triggerType,
      funnelStage: packet.funnelStage,
      executionState: packet.executionState,
      confidence: packet.confidence,
      actionKind: packet.lockedActionKind,
      actionLabel: ACTION_KIND_LABEL[packet.lockedActionKind],
      interruptDecision: packet.interruptDecision,
      citedNumbers: [diagnosis.verdict, ...diagnosis.evidence, diagnosis.action, diagnosis.watchNext]
        .flatMap((item) => item.citedNumbers)
        .slice(0, 12)
    },
    productRole: packet.productContext.role,
    speechPresentKeys: packet.speechPresentKeys,
    speechMissingKeys: packet.speechMissingKeys,
    quotes: packet.relevantQuotes,
    unknowns: packet.unknowns,
    template: {
      whatHappened: diagnosis.verdict.text,
      why: diagnosis.evidence[0]?.text ?? diagnosis.verdict.text,
      action: diagnosis.action.text,
      watchNext: diagnosis.watchNext.text
    }
  };
}
