// Independently chosen synthetic rule thresholds; no historical calibration records.
import { describe, expect, it } from "vitest";
import { liveEventSchema, type LiveEvent, type Scenario, type SpeechTag } from "@live-growth/contracts";
import { generateSimulation } from "@live-growth/source-adapters";
import { ANALYSIS_WINDOWS_SEC, RULE_CONFIGS, analyzeRules, buildAnalysisWindows, concurrentViewerTrend, maxConsecutiveSpeechTag } from "../src/index";

const base = { tenantId: "tenant-demo", sessionId: "session-rules", seed: 42, includeCommentIntent: true };

function eventsUntil(scenario: Scenario, minute: number): LiveEvent[] {
  return generateSimulation({ ...base, scenario }).filter((event) => Date.parse(event.eventAt) <= Date.parse("2026-01-01T12:00:00.000Z") + minute * 60_000);
}

function everTriggered(scenario: Scenario, ruleId: string): boolean {
  const events = generateSimulation({ ...base, scenario });
  return everTriggeredEvents(events, ruleId);
}

function everTriggeredEvents(events: LiveEvent[], ruleId: string): boolean {
  return events.some((event, index) => event.kind === "metric.snapshot" && analyzeRules(events.slice(0, index + 1)).detectedEvents.some((item) => item.ruleId === ruleId));
}

function replaceSpeechTags(events: LiveEvent[], tagsForIndex: (index: number) => SpeechTag[]): LiveEvent[] {
  let speechIndex = 0;
  return events.map((event) => {
    if (event.kind !== "speech.final") return event;
    const tags = tagsForIndex(speechIndex);
    speechIndex += 1;
    return liveEventSchema.parse({ ...event, payload: { ...(event.payload as object), tags } });
  });
}

describe("Phase 1 确定性规则", () => {
  it("配置完整声明版本、主窗口、趋势窗口、冷却和建议模板", () => {
    expect(RULE_CONFIGS).toHaveLength(8);
    for (const config of RULE_CONFIGS) {
      expect(config.version).toBeGreaterThan(0);
      expect(config.mainWindowSec).toBe(120);
      expect(config.trendWindowSec).toBe(300);
      expect(config.cooldownSec).toBe(180);
      expect(config.nonTriggerConditions).toHaveLength(2);
      expect(config.adviceTemplate.hostMessage.length).toBeGreaterThan(0);
    }
  });

  it("构建 30／60／120／300／900 秒及商品轮次窗口", () => {
    const windows = buildAnalysisWindows(eventsUntil("stable", 16));
    expect(windows).not.toBeNull();
    expect(ANALYSIS_WINDOWS_SEC.map((seconds) => windows![seconds].durationSec)).toEqual([30, 60, 120, 300, 900]);
    expect(windows!.productRound.durationSec).toBe("product_round");
    expect(windows!.productRound.startAt).toBe("2026-01-01T12:10:04.000Z");
  });

  it.each([
    ["R001", "low_click"], ["R002", "low_payment"], ["R003", "online_drop"], ["R004", "roi_drop"],
    ["R005", "no_cta"], ["R006", "price_objection"], ["R007", "long_knowledge"], ["R008", "positive_segment"]
  ] as const)("%s 在对应指标和话术条件下触发", (ruleId, scenario) => {
    expect(everTriggered(scenario, ruleId)).toBe(true);
  });

  it.each(RULE_CONFIGS.map((config) => config.id))("%s 对稳定场景不触发", (ruleId) => {
    expect(everTriggered("stable", ruleId)).toBe(false);
  });

  it.each([
    ["R001", "low_payment"], ["R002", "low_click"], ["R003", "low_payment"], ["R004", "low_click"],
    ["R005", "low_payment"], ["R006", "online_drop"], ["R007", "low_payment"], ["R008", "low_click"]
  ] as const)("%s 对第二个反例场景不触发", (ruleId, scenario) => {
    expect(everTriggered(scenario, ruleId)).toBe(false);
  });

  it("样本不足时只产生可查看状态，不产生建议", () => {
    const result = analyzeRules(eventsUntil("low_click", 1));
    expect(result.detectedEvents).toHaveLength(0);
    expect(result.advices).toHaveLength(0);
    expect(result.ruleStatuses.some((status) => status.status === "insufficient_sample")).toBe(true);
  });

  it("同一输入得到相同检测和建议 ID", () => {
    const events = eventsUntil("low_click", 8);
    expect(analyzeRules(events)).toEqual(analyzeRules(events));
  });

  it("同规则近期已触发时进入冷却而不重复建议", () => {
    const events = eventsUntil("low_click", 8);
    const first = analyzeRules(events).detectedEvents.find((item) => item.ruleId === "R001");
    expect(first).toBeDefined();
    const anchor = [...events].reverse().find((event) => event.kind === "metric.snapshot")!;
    const prior: LiveEvent = {
      ...anchor, eventId: `${anchor.eventId}:prior-rule`, dedupeKey: `${anchor.dedupeKey}:prior-rule`,
      source: "system", kind: "rule.triggered", payload: first!
    };
    const result = analyzeRules([...events, prior]);
    expect(result.detectedEvents.some((item) => item.ruleId === "R001")).toBe(false);
    expect(result.ruleStatuses.some((item) => item.ruleId === "R001" && item.status === "cooldown")).toBe(true);
  });

  it("R002 只有价格或只有下单指令仍触发，四类成交闭环齐全才不触发", () => {
    const source = generateSimulation({ ...base, scenario: "low_payment" });
    expect(everTriggeredEvents(replaceSpeechTags(source, () => ["price"]), "R002")).toBe(true);
    expect(everTriggeredEvents(replaceSpeechTags(source, () => ["cta"]), "R002")).toBe(true);
    expect(everTriggeredEvents(replaceSpeechTags(source, () => ["price", "gift", "guarantee", "cta"]), "R002")).toBe(false);
  });

  it("R007 以 300 秒最大连续原理话术段数判断，其他话术会重置", () => {
    const source = generateSimulation({ ...base, scenario: "long_knowledge" });
    const consecutiveWindows = buildAnalysisWindows(source.filter((event) => Date.parse(event.eventAt) <= Date.parse("2026-01-01T12:08:00.000Z")));
    expect(consecutiveWindows).not.toBeNull();
    expect(maxConsecutiveSpeechTag(consecutiveWindows![300], "ingredient_or_principle")).toBeGreaterThanOrEqual(3);
    expect(everTriggeredEvents(source, "R007")).toBe(true);

    const alternating = replaceSpeechTags(source, (index) => index % 2 === 0 ? ["ingredient_or_principle"] : ["usage_scenario"]);
    const alternatingWindows = buildAnalysisWindows(alternating.filter((event) => Date.parse(event.eventAt) <= Date.parse("2026-01-01T12:08:00.000Z")));
    expect(maxConsecutiveSpeechTag(alternatingWindows![300], "ingredient_or_principle")).toBe(1);
    expect(everTriggeredEvents(alternating, "R007")).toBe(false);
  });

  it("R003 不把首尾下降但中间未持续下降的抖动判为趋势", () => {
    const events = eventsUntil("stable", 8);
    const anchorAt = "2026-01-01T12:08:00.000Z";
    const metricEvents = events.filter((event) => event.kind === "metric.snapshot"
      && Date.parse(event.eventAt) >= Date.parse(anchorAt) - 300_000
      && Date.parse(event.eventAt) <= Date.parse(anchorAt));
    const craftedValues = [10, 12, 12, 12, 12, 12, 12, 12, 12, 12, 7];
    const byEventId = new Map(metricEvents.map((event, index) => [event.eventId, craftedValues[index]!]));
    const crafted = events.map((event) => event.kind === "metric.snapshot" && byEventId.has(event.eventId)
      ? { ...event, payload: { ...(event.payload as object), concurrent_viewers: byEventId.get(event.eventId)! } } as LiveEvent
      : event);
    const result = analyzeRules(crafted);
    expect(result.detectedEvents.some((item) => item.ruleId === "R003")).toBe(false);
    expect(result.ruleStatuses.find((item) => item.ruleId === "R003")?.status).toBe("monitoring");
  });

  it("每条建议携带可审计结构化数据证据，且效果观察目标保持在 metricEvidence[0]", () => {
    for (const [ruleId, scenario] of [
      ["R001", "low_click"], ["R002", "low_payment"], ["R003", "online_drop"], ["R004", "roi_drop"],
      ["R005", "no_cta"], ["R006", "price_objection"], ["R007", "long_knowledge"], ["R008", "positive_segment"]
    ] as const) {
      const events = generateSimulation({ ...base, scenario });
      const advice = events.flatMap((event, index) => event.kind === "metric.snapshot" ? analyzeRules(events.slice(0, index + 1)).advices : [])
        .find((item) => item.ruleId === ruleId);
      expect(advice, `${ruleId} 缺少建议`).toBeDefined();
      expect(advice!.dataEvidence.length).toBeGreaterThan(0);
      expect(advice!.metricEvidence[0]?.metric).toBeDefined();
    }
  });

  it("R004、R006、R008 的结构化证据包含规则实际判断数据", () => {
    const adviceFor = (scenario: Scenario, ruleId: string) => {
      const events = generateSimulation({ ...base, scenario });
      const advice = events.flatMap((event, index) => event.kind === "metric.snapshot" ? analyzeRules(events.slice(0, index + 1)).advices : [])
        .find((item) => item.ruleId === ruleId);
      if (!advice) throw new Error(`${ruleId} 未触发`);
      return { advice, events };
    };
    const r004 = adviceFor("roi_drop", "R004").advice;
    expect(r004.dataEvidence.map((item) => item.label)).toEqual(expect.arrayContaining([
      "最近 120 秒消耗速度", "此前窗口消耗速度与加速比", "最近 120 秒窗口支付 ROI", "此前 180 秒窗口支付 ROI 与下降比例"
    ]));
    expect(r004.dataEvidence.find((item) => item.label === "此前窗口消耗速度与加速比")?.summary).toContain("倍");

    const r006 = adviceFor("price_objection", "R006");
    const priceEvidence = r006.advice.dataEvidence.find((item) => item.type === "comment_intent")!;
    const priceEventIds = new Set(r006.events.filter((event) => event.kind === "comment.intent" && (event.payload as { intent?: string }).intent === "price").map((event) => event.eventId));
    expect(priceEvidence.eventIds.length).toBeGreaterThan(0);
    expect(priceEvidence.eventIds.every((eventId) => priceEventIds.has(eventId))).toBe(true);
    expect(r006.advice.metricEvidence[0]!.metric).toBe("click_to_paid_rate");

    const r008 = adviceFor("positive_segment", "R008").advice;
    expect(r008.dataEvidence).toHaveLength(3);
    expect(r008.dataEvidence.every((item) => item.value !== undefined && item.baseline !== undefined)).toBe(true);
    expect(r008.dataEvidence.map((item) => item.label)).toEqual(expect.arrayContaining(["商品点击率前后窗口", "点击后支付率前后窗口", "承接指标最大提升"]));
  });

  it("每次评估为每条规则输出且只输出一个当前状态", () => {
    const insufficient = analyzeRules(eventsUntil("stable", 1));
    const monitoring = analyzeRules(eventsUntil("stable", 8));
    expect(insufficient.ruleStatuses).toHaveLength(8);
    expect(monitoring.ruleStatuses).toHaveLength(8);
    expect(new Set(insufficient.ruleStatuses.map((item) => item.ruleId)).size).toBe(8);
    expect(insufficient.ruleStatuses.find((item) => item.ruleId === "R001")?.status).toBe("insufficient_sample");
    expect(monitoring.ruleStatuses.find((item) => item.ruleId === "R001")?.status).toBe("monitoring");
  });

  it("public defaults are explicitly synthetic and configurable", () => {
    const byId = Object.fromEntries(RULE_CONFIGS.map((config) => [config.id, config]));
    expect(byId.R001).toMatchObject({ version: 1, thresholds: { roomEnterDeltaMin: 32, productClickRateMax: 0.08 }, businessMinimums: { mainProductImpressionDelta: 48 } });
    expect(byId.R004).toMatchObject({ thresholds: { spendAccelerationMin: 1.6, grossRoiDropRateMin: 0.22, grossRoiMax: 2.4 } });
    for (const config of RULE_CONFIGS) {
      expect(config.calibration).toEqual({ version: "public-synthetic-v1", scope: "synthetic_example", sourceRefs: ["synthetic-config:public-v1"] });
    }
    expect(analyzeRules(eventsUntil("stable", 8), undefined, []).ruleStatuses).toEqual([]);
  });

  it("历史聚合合成回放的低业务分母返回明确样本不足而不生成建议", () => {
    for (const scenario of ["historical_morning", "historical_afternoon", "historical_evening"] as const) {
      const result = analyzeRules(eventsUntil(scenario, 8));
      expect(result.advices).toHaveLength(0);
      for (const ruleId of ["R001", "R002", "R005", "R007"] as const) {
        expect(result.ruleStatuses.find((item) => item.ruleId === ruleId)).toMatchObject({ status: "insufficient_sample" });
        expect(result.ruleStatuses.find((item) => item.ruleId === ruleId)!.reason).toContain("业务样本不足");
      }
    }
  });

  it("三个历史聚合合成回放在全部指标锚点均不生成高优先级建议", () => {
    for (const scenario of ["historical_morning", "historical_afternoon", "historical_evening"] as const) {
      const events = generateSimulation({ ...base, scenario });
      for (let index = 0; index < events.length; index += 1) {
        if (events[index]!.kind !== "metric.snapshot") continue;
        expect(analyzeRules(events.slice(0, index + 1)).advices.filter((advice) => advice.priority === "high"), `${scenario} 在 ${events[index]!.eventAt} 生成高优先级建议`).toHaveLength(0);
      }
    }
  });

  it("R003 在线下降证据与三段趋势判断使用相同分段值", () => {
    const events = generateSimulation({ ...base, scenario: "online_drop" });
    for (let index = 0; index < events.length; index += 1) {
      if (events[index]!.kind !== "metric.snapshot") continue;
      const advice = analyzeRules(events.slice(0, index + 1)).advices.find((item) => item.ruleId === "R003");
      if (!advice) continue;
      const trend = concurrentViewerTrend(events.slice(0, index + 1), advice.triggeredAt, 300, 3);
      const segmentEvidence = advice.dataEvidence.find((item) => item.label === "300 秒在线人数分段中位数")!;
      const dropEvidence = advice.dataEvidence.find((item) => item.label === "300 秒在线人数下降幅度")!;
      expect(segmentEvidence.baseline).toBe(trend.blockMedians[0]);
      expect(segmentEvidence.value).toBe(trend.blockMedians.at(-1));
      expect(segmentEvidence.summary).toContain(trend.blockMedians.join(" → "));
      expect(dropEvidence.value).toBe(trend.relativeDrop);
      expect(dropEvidence.summary).toContain(`绝对下降 ${trend.absoluteDrop} 人`);
      return;
    }
    throw new Error("online_drop 未触发 R003");
  });

  it("点击后支付率始终按支付买家 UV 而不是订单数计算", () => {
    const events = generateSimulation({ ...base, scenario: "low_payment" }).map((event) => {
      if (event.kind !== "metric.snapshot") return event;
      const payload = event.payload as Record<string, number>;
      return { ...event, payload: { ...payload, paid_order_count: payload.product_click_uv } } as LiveEvent;
    });
    const advice = events.flatMap((event, index) => event.kind === "metric.snapshot" ? analyzeRules(events.slice(0, index + 1)).advices : [])
      .find((item) => item.ruleId === "R002");
    expect(advice).toBeDefined();
    expect(advice!.dataEvidence.find((item) => item.label.includes("点击后支付率"))!.summary).toContain("支付买家 UV");
  });

  it("R004 不因累计 ROI 低或消耗加速单独触发，必须同时满足窗口 ROI 相对下降", () => {
    const events = generateSimulation({ ...base, scenario: "roi_drop" }).map((event) => {
      if (event.kind !== "metric.snapshot") return event;
      const payload = event.payload as Record<string, number>;
      return { ...event, payload: { ...payload, gross_paid_gmv_fen: Number(payload.ad_spend_fen) * 2, gross_roi: 2 } } as LiveEvent;
    });
    expect(events.some((event, index) => event.kind === "metric.snapshot" && analyzeRules(events.slice(0, index + 1)).detectedEvents.some((item) => item.ruleId === "R004"))).toBe(false);
  });

  it("规则在触发、冷却结束后可回到监测或重新触发", () => {
    const events = eventsUntil("low_click", 8);
    const triggered = analyzeRules(events);
    const first = triggered.detectedEvents.find((item) => item.ruleId === "R001")!;
    expect(triggered.ruleStatuses.find((item) => item.ruleId === "R001")?.status).toBe("triggered");
    const anchor = [...events].reverse().find((event) => event.kind === "metric.snapshot")!;
    const recent: LiveEvent = {
      ...anchor, eventId: `${anchor.eventId}:recent`, dedupeKey: `${anchor.dedupeKey}:recent`, source: "system", kind: "rule.triggered", payload: first
    };
    expect(analyzeRules([...events, recent]).ruleStatuses.find((item) => item.ruleId === "R001")?.status).toBe("cooldown");
    const oldAt = new Date(Date.parse(anchor.eventAt) - 181_000).toISOString();
    const old = { ...recent, eventId: `${anchor.eventId}:old`, dedupeKey: `${anchor.dedupeKey}:old`, eventAt: oldAt, capturedAt: oldAt, ingestedAt: oldAt };
    expect(analyzeRules([...events, old]).ruleStatuses.find((item) => item.ruleId === "R001")?.status).toBe("triggered");
    expect(analyzeRules(eventsUntil("stable", 8)).ruleStatuses.find((item) => item.ruleId === "R001")?.status).toBe("monitoring");
  });

  it("商品切换使规则进入干扰状态", () => {
    const events = eventsUntil("low_click", 8);
    const anchor = [...events].reverse().find((event) => event.kind === "metric.snapshot")!;
    const changed: LiveEvent = {
      ...anchor, eventId: `${anchor.eventId}:changed`, dedupeKey: `${anchor.dedupeKey}:changed`,
      kind: "product.changed", payload: { productId: "pan-28", previousProductId: "pan-24" }
    };
    const result = analyzeRules([...events, changed]);
    expect(result.detectedEvents.some((item) => item.ruleId === "R001")).toBe(false);
    expect(result.ruleStatuses.some((item) => item.ruleId === "R001" && item.status === "confounded")).toBe(true);
  });

  it("正向片段建议只使用复盘和同期变化措辞", () => {
    const events = generateSimulation({ ...base, scenario: "positive_segment" });
    const advice = events.flatMap((_, index) => analyzeRules(events.slice(0, index + 1)).advices).find((item) => item.ruleId === "R008");
    expect(advice).toBeDefined();
    expect(`${advice!.title}${advice!.problem}${advice!.limitations.join("")}`).toContain("复盘");
    expect(`${advice!.problem}${advice!.limitations.join("")}`).not.toMatch(/导致|造成|归因于/);
  });
});
