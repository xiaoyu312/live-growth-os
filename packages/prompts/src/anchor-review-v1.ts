import type { AnchorReview, AnchorReviewFinding } from "@live-growth/contracts";

export const ANCHOR_REVIEW_PROMPT_VERSION = "anchor-review-v2" as const;

export const ANCHOR_REVIEW_ANALYSIS_FRAMEWORK = [
  "先用一两句告诉运营下一场先改什么，不要报加权分。",
  "讲到的要点：同一句转写只写一次，列出要点名，原句放 quote，不要把原句再抄进 text。",
  "转写缺口写成下一场怎么讲，不要写「不要写成主播没讲」这类操作说明。",
  "时段只保留关键窗，写点击和成交数字；有点击没成交时提示补锁单或保障，禁止因果。",
  "nextSteps 必须是输入的同一方向，写成能直接转述给主播的短句。"
] as const;

export const ANCHOR_REVIEW_SYSTEM_PROMPT = [
  "你是直播场后主播复盘的表达层，不是聊天机器人。",
  "根据 analysisFramework 把规则已锁定的复盘改写成运营能直接讲给主播的短建议，不得改判断、不得编造输入里没有的数字或原句。",
  "只输出一个 JSON 对象，不要 markdown，不要解释。",
  "JSON 形状：{\"summary\":{\"id\":\"与输入相同\",\"text\":\"中文\"},\"strengths\":[{\"id\":\"与输入相同\",\"text\":\"中文\"}],\"gaps\":[{\"id\":\"与输入相同\",\"text\":\"中文\"}],\"timeline\":[{\"id\":\"与输入相同\",\"text\":\"中文\"}],\"nextSteps\":[\"中文\"]}。",
  "必须保持输入的 id 和条数，不得增删、合并或改 id。strengths、gaps、timeline 可为空数组但长度必须与输入相同。",
  "nextSteps 条数必须与输入相同，方向不变。",
  "每条 text 必须出现该条 citedNumbers 里的全部数字（可用千分位）。summary 同样。",
  "句子要短，不要重复粘贴转写，不要写加权覆盖、底稿、窗口、漏斗。",
  "不得编造输入里没有的数字、商品名或话术要点。",
  "不得写因果（禁止「导致」「所以没成交」「因为没讲」）。",
  "不得出现英文键名、grain=hour、unknown、S0-S6、GMV、LLM。",
  "成交用「成交」，不要写 GMV。",
  "转写里没有出现不等于主播没讲。",
  "不要给投放或切品指令。"
].join("");

type PayloadFinding = {
  id: string;
  text: string;
  at?: string;
  quote?: string;
  citedNumbers: AnchorReviewFinding["citedNumbers"];
};

export type AnchorReviewUserPayload = {
  hostName: string;
  rangeLabel: string;
  speechFinalCount: number;
  coveredPoints: number;
  totalPoints: number;
  weightedScore: number | null;
  analysisFramework: string[];
  summary: PayloadFinding;
  strengths: PayloadFinding[];
  gaps: PayloadFinding[];
  timeline: PayloadFinding[];
  nextSteps: string[];
};

function findingPayload(item: AnchorReviewFinding): PayloadFinding {
  return {
    id: item.id,
    text: item.text,
    ...(item.at ? { at: item.at } : {}),
    ...(item.quote ? { quote: item.quote } : {}),
    citedNumbers: item.citedNumbers
  };
}

export function buildAnchorReviewUserPayload(review: AnchorReview, rangeLabel: string): AnchorReviewUserPayload {
  return {
    hostName: review.hostName,
    rangeLabel,
    speechFinalCount: review.coverage.speechFinalCount,
    coveredPoints: review.coverage.score?.coveredPoints ?? review.coverage.points.filter((point) => point.covered).length,
    totalPoints: review.coverage.points.length,
    weightedScore: review.coverage.score?.total ?? null,
    analysisFramework: [...ANCHOR_REVIEW_ANALYSIS_FRAMEWORK],
    summary: findingPayload(review.narrative.summary),
    strengths: review.narrative.strengths.map(findingPayload),
    gaps: review.narrative.gaps.map(findingPayload),
    timeline: review.narrative.timeline.map(findingPayload),
    nextSteps: [...review.narrative.nextSteps]
  };
}

export function anchorReviewInputSummary(review: AnchorReview): {
  promptVersion: typeof ANCHOR_REVIEW_PROMPT_VERSION;
  hostName: string;
  rangeStartAt: string;
  rangeEndAt: string;
  speechFinalCount: number;
  scriptVersion: string;
} {
  return {
    promptVersion: ANCHOR_REVIEW_PROMPT_VERSION,
    hostName: review.hostName,
    rangeStartAt: review.rangeStartAt,
    rangeEndAt: review.rangeEndAt,
    speechFinalCount: review.coverage.speechFinalCount,
    scriptVersion: review.scriptVersion
  };
}
