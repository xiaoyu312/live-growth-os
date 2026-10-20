import type { DiagnosisActionKind, LiveEvent, LiveProductRole } from "@live-growth/contracts";

export const LIVE_PRODUCT_ROLE_LABEL: Record<LiveProductRole, string> = {
  trial_acquisition: "低客单拉新尝新品",
  value_bundle: "高性价比套组",
  repeat_purchase: "高客单老客复购品",
  welfare_item: "低价福利品",
  unknown: "未指定"
};

export const GENERIC_LOOP_SPEECH_KEYS = ["product_benefit", "guarantee", "product_card_cta"] as const;

export const ROLE_SPEECH_EXPECTATIONS: Record<LiveProductRole, readonly string[]> = {
  trial_acquisition: ["usage_scenario", "product_benefit", "price", "product_card_cta", "guarantee"],
  value_bundle: ["suitable_audience", "product_benefit", "price", "gift", "guarantee", "product_card_cta", "purchase_cta"],
  repeat_purchase: ["usage_scenario", "product_benefit", "offer", "guarantee", "product_card_cta", "purchase_cta"],
  welfare_item: ["product_benefit", "offer", "product_card_cta"],
  unknown: [...GENERIC_LOOP_SPEECH_KEYS]
};

export const CLOSURE_SPEECH_KEYS = ["guarantee", "product_card_cta", "purchase_cta"] as const;

export function latestProductRole(events: readonly LiveEvent[], asOfMs: number): {
  role: LiveProductRole;
  productName?: string;
  eventAt?: string;
} {
  const latest = [...events].reverse().find((event) => {
    if (event.kind !== "live.product.context") return false;
    return Date.parse(event.eventAt) <= asOfMs;
  });
  if (!latest || latest.kind !== "live.product.context") return { role: "unknown" };
  const payload = latest.payload as { role?: LiveProductRole; productName?: string };
  return {
    role: payload.role ?? "unknown",
    ...(typeof payload.productName === "string" ? { productName: payload.productName } : {}),
    eventAt: latest.eventAt
  };
}

export function productRoleConfounded(events: readonly LiveEvent[], windowStartAt: string, windowEndAt: string): boolean {
  const start = Date.parse(windowStartAt);
  const end = Date.parse(windowEndAt);
  const roles = events.flatMap((event) => {
    if (event.kind !== "live.product.context") return [];
    const at = Date.parse(event.eventAt);
    if (at < start || at > end) return [];
    const role = (event.payload as { role?: LiveProductRole }).role;
    return role ? [role] : [];
  });
  return new Set(roles).size > 1;
}

export function expectedSpeechKeys(role: LiveProductRole, stageKeys: readonly string[]): string[] {
  const roleKeys = ROLE_SPEECH_EXPECTATIONS[role];
  return [...new Set([...stageKeys, ...roleKeys])];
}

export function missingExpectedSpeech(role: LiveProductRole, stageKeys: readonly string[], present: readonly string[]): string[] {
  return expectedSpeechKeys(role, stageKeys).filter((key) => !present.includes(key));
}

export function closureActionKind(present: readonly string[]): DiagnosisActionKind {
  if (!present.includes("guarantee")) return "close_gift";
  if (!present.includes("product_card_cta")) return "click_cta";
  if (!present.includes("purchase_cta")) return "close_urgency";
  return "hold";
}
