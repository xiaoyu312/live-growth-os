import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_STATE_ENGINE_CONFIG, LiveStateEngine, evaluateLiveState, STATE_PRIORITY } from "../src/live-state-engine";
import { generateMvpSimulation, MVP_PRODUCT_SEEDS, type MvpScenario } from "@live-growth/source-adapters";
import { MVP_SPEECH_COVERAGE_KEYS, type MvpMetricPoint } from "@live-growth/contracts";

const defaultCoverage = Object.fromEntries(MVP_SPEECH_COVERAGE_KEYS.map((key) => [key, "unknown" as const]));

function point(overrides: Partial<MvpMetricPoint> = {}): MvpMetricPoint {
  const at = overrides.at ?? "2026-08-10T08:05:00.000Z";
  return {
    at, online: 120, enters1m: 10, retentionProxy: .62, currentProductId: "mvp-low-pan", topIntentProductId: "mvp-low-pan",
    products: [
      { productId: "mvp-low-pan", exposure5m: 120, clicks5m: 12, unpaid5m: 2, paidBuyers5m: 2, gmvFen5m: 79800 },
      { productId: "mvp-high-set", exposure5m: 80, clicks5m: 2, unpaid5m: 0, paidBuyers5m: 0, gmvFen5m: 0 }
    ], traffic: { spendFen5m: 5000, spendChangeRate5m: 0, roi: 4, roiVs10mBaseline: 0, trafficVs10mBaseline: 0, updatedAt: at }, dataComplete: true,
    speechCoverage: { ...defaultCoverage, product_benefit: "present", price: "unknown", product_card_cta: "unknown", purchase_cta: "unknown" }, speechEvidence: [], ...overrides
  };
}

describe("v0.1 直播状态引擎", () => {
  it("预热期不判断，断流时不把缺失当作 0", () => {
    const p = point({ at: "2026-08-10T08:00:00.000Z" });
    expect(evaluateLiveState({ point: p, history: [p], products: MVP_PRODUCT_SEEDS }).preheat).toBe(true);
    expect(evaluateLiveState({ point: p, history: [p], products: MVP_PRODUCT_SEEDS, now: "2026-08-10T08:01:00.000Z" }).stale).toBe(true);
  });

  it.each([
    ["mvp_stable", null], ["mvp_traffic_surge", "S1"], ["mvp_retention", "S2"], ["mvp_high_intent", "S3"],
    ["mvp_high_click_low_pay", "S4"], ["mvp_standout", "S5"], ["mvp_low_efficiency", "S6"]
  ] as const)("场景 %s 的主要状态可确定识别", (scenario: MvpScenario, expected: string | null) => {
    const engine = new LiveStateEngine(MVP_PRODUCT_SEEDS);
    const states: string[] = [];
    for (const item of generateMvpSimulation({ sessionId: "state-test", seed: 42, scenario })) {
      const result = engine.process(item);
      if (result.action) states.push(result.action.state);
    }
    if (expected === null) expect(states).toHaveLength(0);
    else expect(states).toContain(expected);
  });

  it("按 10 秒判断时六个问题场景仍可稳定产生唯一行动", () => {
    const expected: Array<[MvpScenario, string]> = [
      ["mvp_traffic_surge", "S1"], ["mvp_retention", "S2"], ["mvp_high_intent", "S3"],
      ["mvp_high_click_low_pay", "S4"], ["mvp_standout", "S5"], ["mvp_low_efficiency", "S6"]
    ];
    for (const [scenario, state] of expected) {
      const engine = new LiveStateEngine(MVP_PRODUCT_SEEDS);
      const actions = generateMvpSimulation({ sessionId: `check-${scenario}`, seed: 42, scenario }).flatMap((item, index) => {
        const result = engine.process(item, undefined, index % 2 === 0);
        return result.action ? [result.action] : [];
      });
      expect(actions.filter((item) => item.state === state)).toHaveLength(1);
    }
  });

  it("优先级固定为 S2>S4>S1>S5>S3>S6>S0，状态不变不重复行动", () => {
    expect(STATE_PRIORITY).toEqual(["S2", "S4", "S1", "S5", "S3", "S6", "S0"]);
    const engine = new LiveStateEngine(MVP_PRODUCT_SEEDS);
    const actions = generateMvpSimulation({ sessionId: "dedupe-test", seed: 42, scenario: "mvp_high_click_low_pay" }).flatMap((item) => {
      const action = engine.process(item).action;
      return action ? [action] : [];
    });
    expect(actions).toHaveLength(1);
    expect(actions.every((item) => item.id.length <= 160)).toBe(true);
    expect(actions[0]?.coreInstruction).not.toContain("延长当前商品讲解");
  });

  it("同一检查点同时满足 S4、S1 和 S5 时按真实条件仲裁为 S4，留存异常时 S2 最高", () => {
    const baseline = Array.from({ length: 40 }, (_, index) => point({
      at: new Date(Date.parse("2026-08-10T08:00:00.000Z") + index * 5_000).toISOString(), enters1m: 10, online: 120
    }));
    const simultaneous = point({ at: "2026-08-10T08:03:20.000Z", enters1m: 35, online: 130, retentionProxy: .62, products: [
      { productId: "mvp-low-pan", exposure5m: 180, clicks5m: 36, unpaid5m: 20, paidBuyers5m: 0, gmvFen5m: 0 },
      { productId: "mvp-high-set", exposure5m: 100, clicks5m: 45, unpaid5m: 0, paidBuyers5m: 10, gmvFen5m: 159900 }
    ] });
    expect(evaluateLiveState({ point: simultaneous, history: [...baseline, simultaneous], products: MVP_PRODUCT_SEEDS }).state).toBe("S4");
    const retentionFailure = point({ ...simultaneous, at: "2026-08-10T08:03:25.000Z", retentionProxy: .2 });
    expect(evaluateLiveState({ point: retentionFailure, history: [...baseline, retentionFailure], products: MVP_PRODUCT_SEEDS }).state).toBe("S2");
  });

  it("高意向商品不是当前商品时切换真实商品，低效时不推荐高客单", () => {
    const highIntent = new LiveStateEngine(MVP_PRODUCT_SEEDS);
    const actions = generateMvpSimulation({ sessionId: "intent-test", seed: 42, scenario: "mvp_high_intent" }).flatMap((item) => {
      const action = highIntent.process(item).action;
      return action ? [action] : [];
    });
    expect(actions[0]?.actionKey).toBe("switch_to_top_intent");
    expect(actions[0]?.topIntentProductId).toBe("mvp-high-set");
    const low = new LiveStateEngine(MVP_PRODUCT_SEEDS);
    const lowActions = generateMvpSimulation({ sessionId: "low-test", seed: 42, scenario: "mvp_low_efficiency" }).flatMap((item) => {
      const action = low.process(item).action;
      return action ? [action] : [];
    });
    expect(lowActions[0]?.coreInstruction).not.toContain("高客单");
  });

  it("无库存时不生成虚假稀缺，真实库存时才允许稀缺动作", () => {
    const noScarcity = point({ products: [{ productId: "mvp-low-pan", exposure5m: 120, clicks5m: 30, unpaid5m: 12, paidBuyers5m: 0, gmvFen5m: 0 }, { productId: "mvp-high-set", exposure5m: 1, clicks5m: 0, unpaid5m: 0, paidBuyers5m: 0, gmvFen5m: 0 }] });
    const result = evaluateLiveState({ point: noScarcity, history: [point({ at: "2026-08-10T08:00:00.000Z" }), point({ at: "2026-08-10T08:05:00.000Z" }), point({ at: "2026-08-10T08:05:00.000Z" }), point({ at: "2026-08-10T08:05:00.000Z" })], products: MVP_PRODUCT_SEEDS });
    expect(result.candidate?.realScarcity).toBe(false);
  });

  it("状态切换使用独立离开确认点，并按状态进入时间计算持续时长", () => {
    const config = {
      warmupSec: 0, staleSec: 30, confirmationPoints: 1, surgeConfirmationPoints: 3,
      exitConfirmationPoints: 3, minClicks: 5, minUnpaid: 2, lowRetention: .35,
      highRetention: .55, surgeEntersPerMin: 18, surgeVs5mBaseline: 1.6, lowTrafficEntersPerMin: 8,
      highClickRate: .12, lowPayRate: .04, standoutMultiplier: 1.5
    } as const;
    const engine = new LiveStateEngine(MVP_PRODUCT_SEEDS, config);
    const base = point({ at: "2026-08-10T08:00:00.000Z" });
    expect(engine.process(base).decision.state).toBe("S0");
    const highClickLowPay = (at: string) => point({ at, enters1m: 10, retentionProxy: .62, products: [
      { productId: "mvp-low-pan", exposure5m: 120, clicks5m: 30, unpaid5m: 12, paidBuyers5m: 0, gmvFen5m: 0 },
      { productId: "mvp-high-set", exposure5m: 80, clicks5m: 0, unpaid5m: 0, paidBuyers5m: 0, gmvFen5m: 0 }
    ] });
    expect(engine.process(highClickLowPay("2026-08-10T08:00:05.000Z")).action).toBeNull();
    expect(engine.process(highClickLowPay("2026-08-10T08:00:10.000Z")).action).toBeNull();
    const entered = engine.process(highClickLowPay("2026-08-10T08:00:15.000Z"));
    expect(entered.action?.state).toBe("S4");
    const held = engine.process(highClickLowPay("2026-08-10T08:00:45.000Z"));
    expect(held.decision.state).toBe("S4");
    expect(held.decision.stateDurationSec).toBe(30);
    const surge = (at: string, online: number) => point({ at, online, enters1m: 35, retentionProxy: .62, products: [
      { productId: "mvp-low-pan", exposure5m: 120, clicks5m: 1, unpaid5m: 0, paidBuyers5m: 0, gmvFen5m: 0 },
      { productId: "mvp-high-set", exposure5m: 80, clicks5m: 0, unpaid5m: 0, paidBuyers5m: 0, gmvFen5m: 0 }
    ] });
    expect(engine.process(surge("2026-08-10T08:00:50.000Z", 130)).decision.state).toBe("S4");
    expect(engine.process(surge("2026-08-10T08:00:55.000Z", 132)).decision.state).toBe("S4");
    expect(engine.process(surge("2026-08-10T08:01:00.000Z", 134)).action?.state).toBe("S1");
  });

  it("流量突增必须同时高于近期基线，不能只凭绝对进入人数", () => {
    const baseline = Array.from({ length: 40 }, (_, index) => point({
      at: new Date(Date.parse("2026-08-10T08:00:00.000Z") + index * 5_000).toISOString(),
      enters1m: 20, online: 120
    }));
    const belowRelativeThreshold = point({ at: "2026-08-10T08:03:20.000Z", enters1m: 25, online: 130 });
    const aboveRelativeThreshold = point({ at: "2026-08-10T08:03:25.000Z", enters1m: 35, online: 132 });
    expect(evaluateLiveState({ point: belowRelativeThreshold, history: [...baseline, belowRelativeThreshold], products: MVP_PRODUCT_SEEDS }).state).toBe("S0");
    expect(evaluateLiveState({ point: aboveRelativeThreshold, history: [...baseline, aboveRelativeThreshold], products: MVP_PRODUCT_SEEDS }).state).toBe("S1");
  });

  it("流量突增按连续两个原始 5 秒点确认，但只在 10 秒检查点发行动", () => {
    const engine = new LiveStateEngine(MVP_PRODUCT_SEEDS, { ...DEFAULT_LIVE_STATE_ENGINE_CONFIG, warmupSec: 0, confirmationPoints: 4, surgeConfirmationPoints: 2 });
    const steady = point({ at: "2026-08-10T08:00:00.000Z", enters1m: 10, online: 120 });
    expect(engine.process(steady, undefined, true).action).toBeNull();
    const surgeAtFive = point({ at: "2026-08-10T08:00:05.000Z", enters1m: 35, online: 122 });
    const five = engine.process(surgeAtFive, undefined, false);
    expect(five.action).toBeNull();
    const surgeAtTen = point({ at: "2026-08-10T08:00:10.000Z", enters1m: 35, online: 124 });
    const ten = engine.process(surgeAtTen, undefined, true);
    expect(ten.action?.state).toBe("S1");
  });

  it("S4 只针对确认缺失项，present 与 unknown 都不能被机械补讲", () => {
    const covered = point({ products: [
      { productId: "mvp-low-pan", exposure5m: 180, clicks5m: 36, unpaid5m: 20, paidBuyers5m: 0, gmvFen5m: 0 },
      { productId: "mvp-high-set", exposure5m: 80, clicks5m: 0, unpaid5m: 0, paidBuyers5m: 0, gmvFen5m: 0 }
    ], speechCoverage: {
      product_benefit: "present", product_efficacy: "present", usage_scenario: "present", suitable_audience: "present",
      price: "present", offer: "present", gift: "present", guarantee: "present", after_sale: "present",
      product_card_cta: "present", purchase_cta: "present", ingredient_or_principle: "unknown", urgency: "unknown", interaction: "unknown", chatter: "absent"
    } });
    const evaluatedCovered = evaluateLiveState({ point: covered, history: [point({ at: "2026-08-10T08:00:00.000Z" }), point({ at: "2026-08-10T08:05:00.000Z" }), point({ at: "2026-08-10T08:10:00.000Z" }), covered], products: MVP_PRODUCT_SEEDS });
    expect(evaluatedCovered.state).toBe("S4");
    expect(evaluatedCovered.candidate?.actionKey).toBe("continue_observing");

    const unknown = point({ ...covered, at: "2026-08-10T08:10:05.000Z", speechCoverage: { ...covered.speechCoverage, price: "unknown", offer: "unknown", purchase_cta: "unknown", product_card_cta: "unknown" } });
    const evaluatedUnknown = evaluateLiveState({ point: unknown, history: [point({ at: "2026-08-10T08:00:00.000Z" }), point({ at: "2026-08-10T08:05:00.000Z" }), point({ at: "2026-08-10T08:10:00.000Z" }), unknown], products: MVP_PRODUCT_SEEDS });
    expect(evaluatedUnknown.candidate?.actionKey).toBe("continue_observing");
    expect(evaluatedUnknown.candidate?.reason).toContain("无法确认");

    const missing = point({ ...covered, at: "2026-08-10T08:10:10.000Z", speechCoverage: { ...covered.speechCoverage, price: "absent", offer: "absent", gift: "absent", guarantee: "absent", after_sale: "absent", product_card_cta: "absent", purchase_cta: "absent" } });
    const evaluatedMissing = evaluateLiveState({ point: missing, history: [point({ at: "2026-08-10T08:00:00.000Z" }), point({ at: "2026-08-10T08:05:00.000Z" }), point({ at: "2026-08-10T08:10:00.000Z" }), missing], products: MVP_PRODUCT_SEEDS });
    expect(evaluatedMissing.candidate?.actionKey).toBe("complete_closure");
    expect(evaluatedMissing.candidate?.reason).toContain("价格机制");
    expect(evaluatedMissing.candidate?.reason).not.toContain("产品价值");
  });

  it("S4 只缺价格时不机械追加购买指令", () => {
    const priceOnly = point({ products: [
      { productId: "mvp-low-pan", exposure5m: 180, clicks5m: 36, unpaid5m: 20, paidBuyers5m: 0, gmvFen5m: 0 },
      { productId: "mvp-high-set", exposure5m: 80, clicks5m: 0, unpaid5m: 0, paidBuyers5m: 0, gmvFen5m: 0 }
    ], speechCoverage: {
      ...Object.fromEntries(MVP_SPEECH_COVERAGE_KEYS.map((key) => [key, "present" as const])),
      price: "absent", offer: "absent"
    } });
    const result = new LiveStateEngine(MVP_PRODUCT_SEEDS, { ...DEFAULT_LIVE_STATE_ENGINE_CONFIG, warmupSec: 0, confirmationPoints: 1, surgeConfirmationPoints: 1 }).process(priceOnly);
    expect(result.action?.actionKey).toBe("complete_closure");
    expect(result.action?.coreInstruction).toContain("价格机制");
    expect(result.action?.coreInstruction).not.toContain("购买指令");
  });

  it("S4 无库存时补齐价值、价格机制和购买指令，S5 与所有动作均不含投手禁语", () => {
    const noInventory = point({ products: [
      { productId: "mvp-low-pan", exposure5m: 180, clicks5m: 36, unpaid5m: 20, paidBuyers5m: 0, gmvFen5m: 0 },
      { productId: "mvp-high-set", exposure5m: 80, clicks5m: 0, unpaid5m: 0, paidBuyers5m: 0, gmvFen5m: 0 }
    ], speechCoverage: { ...defaultCoverage, product_benefit: "absent", product_efficacy: "absent", price: "absent", offer: "absent", gift: "unknown", guarantee: "unknown", after_sale: "unknown", product_card_cta: "absent", purchase_cta: "absent" } });
    const result = new LiveStateEngine(MVP_PRODUCT_SEEDS, { ...DEFAULT_LIVE_STATE_ENGINE_CONFIG, warmupSec: 0, confirmationPoints: 1, surgeConfirmationPoints: 1 }).process(noInventory);
    expect(result.action?.actionKey).toBe("complete_closure");
    expect(result.action?.realScarcity).toBe(false);
    expect(result.action?.coreInstruction).toContain("价格机制");
    expect(result.action?.coreInstruction).toContain("购买指令");
    expect(result.action?.coreInstruction).not.toContain("库存");

    const forbidden = /追投|收紧|降低消耗|暂停计划|扩大人群|调整定向|保持投放|修改预算|关闭计划/;
    const actions = (["mvp_traffic_surge", "mvp_retention", "mvp_high_intent", "mvp_high_click_low_pay", "mvp_standout", "mvp_low_efficiency"] as const).flatMap((scenario) => {
      const engine = new LiveStateEngine(MVP_PRODUCT_SEEDS);
      return generateMvpSimulation({ sessionId: `forbidden-${scenario}`, seed: 42, scenario }).flatMap((item) => {
        const action = engine.process(item).action;
        return action ? [action] : [];
      });
    });
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action.coreInstruction).not.toMatch(forbidden);
  });

  it("综合场景情形 C 使用真实库存稀缺，情形 D 库存恢复后不制造稀缺", () => {
    const points = generateMvpSimulation({ sessionId: "coverage-scarcity", seed: 42, scenario: "mvp_comprehensive" });
    const scarcity = points.find((item) => item.at === "2026-08-10T08:20:00.000Z")!;
    const recovered = points.find((item) => item.at === "2026-08-10T08:22:00.000Z")!;
    const config = { ...DEFAULT_LIVE_STATE_ENGINE_CONFIG, warmupSec: 0, confirmationPoints: 1, surgeConfirmationPoints: 1 };
    const scarcityAction = new LiveStateEngine(MVP_PRODUCT_SEEDS, config).process(scarcity).action;
    const recoveredAction = new LiveStateEngine(MVP_PRODUCT_SEEDS, config).process(recovered).action;
    expect(scarcityAction?.state).toBe("S4");
    expect(scarcityAction?.actionKey).toBe("complete_closure_with_real_scarcity");
    expect(scarcityAction?.realScarcity).toBe(true);
    expect(scarcityAction?.coreInstruction).toContain("库存");
    expect(recoveredAction?.state).toBe("S4");
    expect(recoveredAction?.actionKey).toBe("complete_closure");
    expect(recoveredAction?.realScarcity).toBe(false);
    expect(recoveredAction?.coreInstruction).not.toContain("库存");
  });

  it("综合场实际动作顺序从 S1 依次经历 S2、S3、S4、S5、S6，稳定段保持 S0 静默", () => {
    const config = { ...DEFAULT_LIVE_STATE_ENGINE_CONFIG, warmupSec: 0, confirmationPoints: 1, surgeConfirmationPoints: 2, exitConfirmationPoints: 1 };
    const engine = new LiveStateEngine(MVP_PRODUCT_SEEDS, config);
    const actions = generateMvpSimulation({ sessionId: "comprehensive-timeline", seed: 42, scenario: "mvp_comprehensive" }).flatMap((item, index) => {
      const result = engine.process(item, undefined, index % 2 === 0);
      return result.action ? [result.action] : [];
    });
    const states = actions.map((item) => item.state);
    expect(states).toEqual(expect.arrayContaining(["S1", "S2", "S3", "S4", "S5", "S6"]));
    const firstSurgeIndex = states.indexOf("S1");
    const orderedStates = states.slice(firstSurgeIndex).filter((state, index, all) => all.indexOf(state) === index);
    expect(orderedStates.slice(0, 6)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    expect(actions.find((item) => item.state === "S1")?.actionKey).toBeDefined();
    expect(actions.filter((item) => item.state === "S0")).toHaveLength(0);
  });

  it("综合场使用正式默认配置时稳定段确认 S0 且不生成行动，后续行动严格按 S1→S2→S3→S4→S5→S6", () => {
    const engine = new LiveStateEngine(MVP_PRODUCT_SEEDS);
    const actions: Array<{ state: string; at: string }> = [];
    let stableAt210: ReturnType<LiveStateEngine["process"]> | undefined;
    let stableAt300: ReturnType<LiveStateEngine["process"]> | undefined;
    for (const pointItem of generateMvpSimulation({ sessionId: "default-comprehensive", seed: 42, scenario: "mvp_comprehensive" })) {
      const result = engine.process(pointItem, undefined, Date.parse(pointItem.at) % 10_000 === 0);
      if (pointItem.at === "2026-08-10T08:03:30.000Z") stableAt210 = result;
      if (pointItem.at === "2026-08-10T08:05:00.000Z") stableAt300 = result;
      if (result.action) actions.push({ state: result.action.state, at: result.action.createdAt });
    }
    expect(stableAt210?.decision.state).toBe("S0");
    expect(stableAt210?.action).toBeNull();
    expect(stableAt300?.decision.state).toBe("S0");
    expect(stableAt300?.action).toBeNull();
    const states = actions.map((item) => item.state);
    expect(states.filter((state, index, all) => all.indexOf(state) === index)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
  });

  it("正式默认配置下 S0→S1 只需连续两个原始 5 秒点，第二点在 10 秒检查边界生成行动", () => {
    const engine = new LiveStateEngine(MVP_PRODUCT_SEEDS);
    const stablePoints = generateMvpSimulation({ sessionId: "default-surge", seed: 42, scenario: "mvp_stable", durationSec: 210 });
    let stable: ReturnType<LiveStateEngine["process"]> | undefined;
    for (const pointItem of stablePoints) stable = engine.process(pointItem, undefined, Date.parse(pointItem.at) % 10_000 === 0);
    expect(stable?.decision.state).toBe("S0");
    const surgeAtFive = point({ at: "2026-08-10T08:03:35.000Z", enters1m: 35, online: 130, traffic: { ...point().traffic, updatedAt: "2026-08-10T08:03:35.000Z" } });
    expect(engine.process(surgeAtFive, undefined, false).action).toBeNull();
    const surgeAtTen = point({ at: "2026-08-10T08:03:40.000Z", enters1m: 35, online: 132, traffic: { ...point().traffic, updatedAt: "2026-08-10T08:03:40.000Z" } });
    expect(engine.process(surgeAtTen, undefined, true).action?.state).toBe("S1");
  });

  it.each([
    ["zero inventory", { inventory: 0 }, false],
    ["expired offer", { offerEndsAt: "2026-08-10T08:04:00.000Z" }, false],
    ["valid inventory", { inventory: 5 }, true],
    ["valid offer", { offerEndsAt: "2026-08-10T08:14:00.000Z" }, true]
  ] as const)("稀缺事实的 %s 只有边界合法时才成立", (_name, extra, expected) => {
    const current = { productId: "mvp-low-pan", exposure5m: 180, clicks5m: 36, unpaid5m: 20, paidBuyers5m: 0, gmvFen5m: 0, ...extra };
    const p = point({ at: "2026-08-10T08:05:00.000Z", products: [current, { productId: "mvp-high-set", exposure5m: 1, clicks5m: 0, unpaid5m: 0, paidBuyers5m: 0, gmvFen5m: 0 }], speechCoverage: { ...defaultCoverage, product_benefit: "absent", price: "absent", offer: "absent", gift: "absent", guarantee: "absent", after_sale: "absent", product_card_cta: "absent", purchase_cta: "absent" } });
    const result = evaluateLiveState({ point: p, history: [point({ at: "2026-08-10T08:00:00.000Z" }), p], products: MVP_PRODUCT_SEEDS });
    expect(result.state).toBe("S4");
    expect(result.candidate?.realScarcity).toBe(expected);
  });

  it("当前商品支付正常但真实 topIntent 商品高点击低支付时优先 S4，并给出切品收口策略", () => {
    const p = point({ products: [
      { productId: "mvp-low-pan", exposure5m: 120, clicks5m: 6, unpaid5m: 0, paidBuyers5m: 1, gmvFen5m: 39900 },
      { productId: "mvp-high-set", exposure5m: 160, clicks5m: 36, unpaid5m: 20, paidBuyers5m: 0, gmvFen5m: 0 }
    ], topIntentProductId: "mvp-high-set" });
    const result = evaluateLiveState({ point: p, history: [point({ at: "2026-08-10T08:00:00.000Z" }), point({ at: "2026-08-10T08:04:00.000Z" }), p], products: MVP_PRODUCT_SEEDS });
    expect(result.state).toBe("S4");
    expect(result.candidate?.actionKey).toBe("switch_to_top_intent");
    expect(result.candidate?.productStrategy).toContain("切到真实高意向商品");
    expect(result.candidate?.productStrategy).toContain("快速塑品");
    expect(result.candidate?.productStrategy).toContain("价格机制收口");
  });

  it("刚切品或投流突变的短时点击支付缺口不立即升级 S4", () => {
    const base = point({ at: "2026-08-10T08:04:00.000Z", currentProductId: "mvp-high-set", topIntentProductId: "mvp-high-set" });
    const switched = point({ at: "2026-08-10T08:05:00.000Z", traffic: { ...point().traffic, updatedAt: "2026-08-10T08:05:00.000Z" } });
    const switchedResult = evaluateLiveState({ point: switched, history: [point({ at: "2026-08-10T08:00:00.000Z" }), base, switched], products: MVP_PRODUCT_SEEDS });
    expect(switchedResult.state).not.toBe("S4");
    const trafficSpike = point({ traffic: { ...point().traffic, spendChangeRate5m: .8, trafficVs10mBaseline: .8, updatedAt: "2026-08-10T08:05:00.000Z" } });
    const spikeResult = evaluateLiveState({ point: trafficSpike, history: [point({ at: "2026-08-10T08:00:00.000Z" }), trafficSpike], products: MVP_PRODUCT_SEEDS });
    expect(spikeResult.state).not.toBe("S4");
  });
});
