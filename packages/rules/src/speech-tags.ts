import type { SpeechTag } from "@live-growth/contracts";

/**
 * Phase 2B 架构优化（D046）：speech.final 确定性打标。
 * 未命中任何要点时只标 other，不推断主播没讲。
 */

/** Independent generic demo patterns. Configure domain vocabulary before real use. */
const SPEECH_TAG_PATTERNS: ReadonlyArray<{ tag: Exclude<SpeechTag, "other">; pattern: RegExp }> = [
  { tag: "opening", pattern: /欢迎|演示开始/ },
  { tag: "interaction", pattern: /关注|评论|收藏/ },
  { tag: "ingredient_or_principle", pattern: /材料|设计|原理|成分/ },
  { tag: "product_benefit", pattern: /特点|便于组装|功能/ },
  { tag: "usage_scenario", pattern: /场景|使用方法|操作步骤/ },
  { tag: "price", pattern: /到手价|价格|[0-9]+(?:\.[0-9]+)?\s*(?:元|块)/ },
  { tag: "gift", pattern: /赠品|附赠/ },
  { tag: "guarantee", pattern: /售后|保障|质保/ },
  { tag: "trust", pattern: /官方|资质|认证/ },
  { tag: "urgency", pattern: /限时|截止时间/ },
  { tag: "cta", pattern: /商品卡|小黄车|下单|确认参数/ },
  { tag: "objection_handling", pattern: /疑问|比较|区别/ },
  { tag: "transition", pattern: /接下来|下一款/ }
];

export function classifySpeechTags(text: string): SpeechTag[] {
  const source = text.trim();
  if (!source) return ["other"];
  const tags: SpeechTag[] = [];
  for (const item of SPEECH_TAG_PATTERNS) {
    if (item.pattern.test(source)) tags.push(item.tag);
  }
  return tags.length > 0 ? tags : ["other"];
}

/** Empty by default; callers may supply vocabulary they own. */
export const ASR_HOTWORDS: readonly string[] = [];
