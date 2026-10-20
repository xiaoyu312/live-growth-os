import type { DiagnosisWindow } from "@live-growth/contracts";

export const DIAGNOSIS_EXPRESSION_PROMPT_VERSION = "diagnosis-expression-v6" as const;

export const DIAGNOSIS_ANALYSIS_FRAMEWORK = [
  "先写消耗相对上一刻怎么变。",
  "曝光次数如果比上一刻多了，不要写成流量质量，要写观看跟没跟上曝光。",
  "消耗加快但曝光次数没有增加，写成这波人更可能更准；有点击就往成交收口，不要写先看流量质量。",
  "有观看对照时，必须写观看跟没跟上曝光。",
  "有点击对照时，必须写商品点击跟没跟上观看。",
  "点击转化偏弱时，对照转写缺的是种草、机制还是赠品保障，再给对应动作。成交大于 0 只写成单偏少，不得写还没变成单或没成单。",
  "停在锁定的掉档层，不要跳到成交编故事。",
  "缺的指标写还对不上，不准编数字。"
] as const;

const ACTION_KIND_LABEL: Record<DiagnosisWindow["actionKind"], string> = {
  hold: "暂不调整",
  wait: "等待完整窗口",
  check_spend: "核对投放",
  traffic_quality: "看流量质量",
  retain: "提状态留人",
  click_cta: "点小黄车",
  close_gift: "补赠品保障售后",
  close_price: "补到手价",
  close_urgency: "强化逼单"
};

const FUNNEL_STAGE_LABEL: Record<DiagnosisWindow["funnelStage"], string> = {
  spend_spike: "消耗加快后看漏斗有没有跟上",
  spend: "消耗起不来",
  exposure: "花钱但没曝光",
  entry: "刷到了没进来",
  click: "有曝光没点击",
  convert: "点击转化偏弱",
  aov: "漏斗无明显掉档",
  maintain: "暂无掉档",
  wait: "等待完整窗口"
};

export const DIAGNOSIS_EXPRESSION_SYSTEM_PROMPT = [
  "你是直播现场副驾的表达层，不是分析师，也不是聊天机器人。",
  "根据 analysisFramework 和 metrics 把规则已锁定的诊断写成现场能听的分析，不得改判断、不得改动作方向。",
  "只输出一个 JSON 对象，不要 markdown，不要解释。",
  "JSON 形状：{\"verdict\":{\"id\":\"与输入相同\",\"text\":\"中文短句\"},\"evidence\":[{\"id\":\"与输入相同\",\"text\":\"中文短句\"}],\"action\":{\"id\":\"与输入相同\",\"text\":\"中文短句\"},\"watchNext\":{\"id\":\"与输入相同\",\"text\":\"中文短句\"},\"pending\":[{\"id\":\"与输入相同\",\"text\":\"中文短句\"}]}。",
  "必须保持输入的 id 和条数，不得增删、合并或改 id。pending 可为空数组。",
  "每条 text 必须出现该条 citedNumbers 里的全部数字（可用千分位）。",
  "必须按 analysisFramework 组织结论：消耗怎么变，曝光、观看、点击跟没跟上；没有对应 metrics 就写还对不上。",
  "locked.action 是动作方向，改写后仍必须是同一方向。",
  "不得编造输入里没有的数字、商品名或话术要点。",
  "不得写因果（禁止「导致」「所以没成交」「因为没讲」）。",
  "不得出现英文键名、grain=hour、unknown、S0-S6、GMV、LLM。",
  "成交用「成交」，不要写 GMV。",
  "输入动作若是暂不调整，改写后仍必须是暂不调整或继续观察，不得改成核对投放或改话术。",
  "输入动作若要讲赠品、保障、售后，不得改成催单或成交目标。",
  "输入动作若要强化逼单，改写后仍必须是催单、稀缺或机制，不得改成看流量或暂不调整。",
  "不要把成交金额当成动作，不要写往某某元靠。",
  "成交单数大于 0 时，不得写还没变成单、没成单或没有成交；只能写成单偏少。",
  "不得把动作改成断播或重新开播。",
  "话术只写这15分钟转写里有或没有的要点，不要写没听到不等于没讲。",
].join("");

export type DiagnosisExpressionUserPayload = {
  confidenceLabel: "已确认" | "倾向判断" | "暂不能判断";
  hourNote: string;
  analysisFramework: string[];
  locked: { action: string; stage: string };
  metrics: Array<{ label: string; value: number; unit: string }>;
  verdict: { id: string; text: string; citedNumbers: DiagnosisWindow["verdict"]["citedNumbers"] };
  evidence: Array<{ id: string; text: string; citedNumbers: DiagnosisWindow["evidence"][number]["citedNumbers"] }>;
  action: { id: string; text: string; citedNumbers: DiagnosisWindow["action"]["citedNumbers"] };
  watchNext: { id: string; text: string; citedNumbers: DiagnosisWindow["watchNext"]["citedNumbers"] };
  pending: Array<{ id: string; text: string; citedNumbers: DiagnosisWindow["pending"][number]["citedNumbers"] }>;
};

const CONFIDENCE_LABEL: Record<DiagnosisWindow["confidence"], DiagnosisExpressionUserPayload["confidenceLabel"]> = {
  confirmed: "已确认",
  leaning: "倾向判断",
  unknown: "暂不能判断"
};

function collectMetrics(window: DiagnosisWindow): DiagnosisExpressionUserPayload["metrics"] {
  const items = [window.verdict, ...window.evidence, window.action, window.watchNext, ...window.pending];
  const seen = new Set<string>();
  const metrics: DiagnosisExpressionUserPayload["metrics"] = [];
  for (const item of items) {
    for (const number of item.citedNumbers) {
      const key = `${number.label}:${number.value}:${number.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      metrics.push({ label: number.label, value: number.value, unit: number.unit });
    }
  }
  return metrics.slice(0, 16);
}

export function buildDiagnosisExpressionUserPayload(window: DiagnosisWindow): DiagnosisExpressionUserPayload {
  return {
    confidenceLabel: CONFIDENCE_LABEL[window.confidence],
    hourNote: window.hourAlignment.note,
    analysisFramework: [...DIAGNOSIS_ANALYSIS_FRAMEWORK],
    locked: {
      action: ACTION_KIND_LABEL[window.actionKind],
      stage: FUNNEL_STAGE_LABEL[window.funnelStage]
    },
    metrics: collectMetrics(window),
    verdict: { id: window.verdict.id, text: window.verdict.text, citedNumbers: window.verdict.citedNumbers },
    evidence: window.evidence.map((item) => ({ id: item.id, text: item.text, citedNumbers: item.citedNumbers })),
    action: { id: window.action.id, text: window.action.text, citedNumbers: window.action.citedNumbers },
    watchNext: { id: window.watchNext.id, text: window.watchNext.text, citedNumbers: window.watchNext.citedNumbers },
    pending: window.pending.map((item) => ({ id: item.id, text: item.text, citedNumbers: item.citedNumbers }))
  };
}

export function diagnosisExpressionInputSummary(window: DiagnosisWindow): {
  promptVersion: string;
  windowStartAt: string;
  findingIds: string[];
  citedNumberCount: number;
  confidence: DiagnosisWindow["confidence"];
  actionKind: DiagnosisWindow["actionKind"];
} {
  const items = [window.verdict, ...window.evidence, window.action, window.watchNext, ...window.pending];
  return {
    promptVersion: DIAGNOSIS_EXPRESSION_PROMPT_VERSION,
    windowStartAt: window.windowStartAt,
    findingIds: items.map((item) => item.id),
    citedNumberCount: items.reduce((total, item) => total + item.citedNumbers.length, 0),
    confidence: window.confidence,
    actionKind: window.actionKind
  };
}
