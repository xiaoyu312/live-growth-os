import type { SessionReview, SessionReviewFinding } from "@live-growth/contracts";

export const SESSION_REVIEW_PROMPT_VERSION = "session-review-v2" as const;

export const SESSION_REVIEW_ANALYSIS_FRAMEWORK = [
  "先用一两句说这场怎么样、下一场先改什么，带上时间和关键数字。",
  "再写这场卡在进线、兴趣还是成交；数字对不上就写还对不上。",
  "按钟点只写人来了没有、点了没有、买了没有、主播讲到了什么。",
  "讲到的要点同一句只写一次；缺口写成下一场怎么补，不要写操作说明。",
  "nextSteps 必须是输入的同一方向，写成能直接转述给主播的短句。"
] as const;

export const SESSION_REVIEW_SYSTEM_PROMPT = [
  "你是直播场后整场复盘的表达层，不是聊天机器人。",
  "根据 analysisFramework 把规则已锁定的复盘改写成运营能直接讲给主播的短建议，不得改判断、不得编造输入里没有的数字或原句。",
  "只输出一个 JSON 对象，不要 markdown，不要解释。",
  "JSON 形状：{\"summary\":{\"id\":\"与输入相同\",\"text\":\"中文\"},\"bottleneck\":{\"id\":\"与输入相同\",\"text\":\"中文\"},\"chapters\":[{\"id\":\"与输入相同\",\"text\":\"中文\"}],\"strengths\":[{\"id\":\"与输入相同\",\"text\":\"中文\"}],\"gaps\":[{\"id\":\"与输入相同\",\"text\":\"中文\"}],\"nextSteps\":[\"中文\"]}。",
  "必须保持输入的 id 和条数，不得增删、合并或改 id。strengths、gaps 可为空数组但长度必须与输入相同。",
  "nextSteps 条数必须与输入相同，方向不变。",
  "每条 text 必须出现该条 citedNumbers 里的全部数字（可用千分位）。summary、bottleneck、chapters 同样。",
  "句子要短，不要重复粘贴转写，不要写加权覆盖、底稿、窗口、漏斗。",
  "说人话，有指引。不要写工程词：加权、底稿、窗口、漏斗、schema、grain、unknown、S0-S6、GMV、LLM、GPT。",
  "成交用「成交」，不要写 GMV。",
  "不得编造输入里没有的数字、商品名或话术要点。",
  "不得写因果（禁止「导致」「所以没成交」「因为没讲」）。",
  "转写里没有出现不等于主播没讲。",
  "不要给投放或切品指令。"
].join("");

type PayloadFinding = {
  id: string;
  text: string;
  at?: string;
  label?: string;
  quote?: string;
  citedNumbers: SessionReviewFinding["citedNumbers"];
};

export type SessionReviewUserPayload = {
  hostName: string;
  rangeLabel: string;
  speechFinalCount: number;
  coveredPoints: number;
  totalPoints: number;
  analysisFramework: string[];
  summary: PayloadFinding;
  bottleneck: PayloadFinding;
  chapters: PayloadFinding[];
  strengths: PayloadFinding[];
  gaps: PayloadFinding[];
  nextSteps: string[];
};

function findingPayload(item: SessionReviewFinding): PayloadFinding {
  return {
    id: item.id,
    text: item.text,
    ...(item.at ? { at: item.at } : {}),
    ...(item.label ? { label: item.label } : {}),
    ...(item.quote ? { quote: item.quote } : {}),
    citedNumbers: item.citedNumbers
  };
}

export function buildSessionReviewUserPayload(review: SessionReview, rangeLabel: string): SessionReviewUserPayload {
  return {
    hostName: review.hostName,
    rangeLabel,
    speechFinalCount: review.coverage.speechFinalCount,
    coveredPoints: review.coverage.score?.coveredPoints ?? review.coverage.points.filter((point) => point.covered).length,
    totalPoints: review.coverage.points.length,
    analysisFramework: [...SESSION_REVIEW_ANALYSIS_FRAMEWORK],
    summary: findingPayload(review.narrative.summary),
    bottleneck: findingPayload(review.narrative.bottleneck),
    chapters: review.narrative.chapters.map(findingPayload),
    strengths: review.narrative.strengths.map(findingPayload),
    gaps: review.narrative.gaps.map(findingPayload),
    nextSteps: [...review.narrative.nextSteps]
  };
}

export function sessionReviewInputSummary(review: SessionReview): {
  promptVersion: typeof SESSION_REVIEW_PROMPT_VERSION;
  hostName: string;
  rangeStartAt: string;
  rangeEndAt: string;
  speechFinalCount: number;
  chapterCount: number;
  scriptVersion: string;
} {
  return {
    promptVersion: SESSION_REVIEW_PROMPT_VERSION,
    hostName: review.hostName,
    rangeStartAt: review.rangeStartAt,
    rangeEndAt: review.rangeEndAt,
    speechFinalCount: review.coverage.speechFinalCount,
    chapterCount: review.narrative.chapters.length,
    scriptVersion: review.scriptVersion
  };
}
