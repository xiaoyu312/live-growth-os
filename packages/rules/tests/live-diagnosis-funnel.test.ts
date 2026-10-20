import { describe, expect, it } from "vitest";
import { consecutiveObviousStageCount, diagnoseFunnelAdvice } from "../src/live-diagnosis-funnel";

const base = {
  hour: 14,
  speechPresentKeys: [] as string[],
  spendSpike: false
};

describe("diagnoseFunnelAdvice", () => {
  it("消耗够但曝光变少时，下一刻看流量质量", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      adSpendFen: 20_000,
      evenSpendFen: 20_000,
      prevAdSpendFen: 18_000,
      impressions: 80,
      prevImpressions: 400,
      gmvFen: 0,
      evenGmvFen: 24_400
    });
    expect(advice.stage).toBe("exposure");
    expect(advice.next.text).toContain("流量质量");
    expect(advice.next.text).toContain("80");
    expect(advice.next.text).not.toMatch(/往大约/);
  });

  it("曝光进入率低于平时，下一刻提状态", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      adSpendFen: 20_000,
      evenSpendFen: 20_000,
      impressions: 400,
      watch: 20,
      entryRateMedian: 0.2,
      gmvFen: 0,
      evenGmvFen: 24_400
    });
    expect(advice.stage).toBe("entry");
    expect(advice.next.text).toContain("提状态");
    expect(advice.next.text).toContain("5.0");
    expect(advice.next.text).toContain("20.0");
  });

  it("商品点击率低于上一刻，下一刻点小黄车，不写平时人数率", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      adSpendFen: 20_000,
      evenSpendFen: 20_000,
      impressions: 400,
      watch: 80,
      entryRateMedian: 0.2,
      productImpressions: 100,
      productClicks: 4,
      clickRateMedian: 0.2,
      gmvFen: 0,
      evenGmvFen: 24_400
    });
    expect(advice.stage).toBe("click");
    expect(advice.next.text).toContain("点小黄车");
    expect(advice.next.text).toContain("4.0");
    expect(advice.next.text).toContain("上一刻");
    expect(advice.finding?.text).not.toContain("平时");
    expect(advice.next.text).not.toContain("平时");
  });

  it("已有催单和紧迫感时，转化掉档改讲值不值", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      speechPresentKeys: ["purchase_cta", "urgency"],
      adSpendFen: 20_000,
      evenSpendFen: 20_000,
      impressions: 400,
      watch: 80,
      entryRateMedian: 0.2,
      productImpressions: 100,
      productClicks: 20,
      clickRateMedian: 0.2,
      paidOrders: 0,
      convertRateMedian: 0.16,
      gmvFen: 0,
      evenGmvFen: 24_400
    });
    expect(advice.stage).toBe("convert");
    expect(advice.next.text).toContain("催单已经有了");
    expect(advice.next.text).toContain("赠品");
    expect(advice.next.text).not.toMatch(/往大约.*元/);
    expect(advice.suggestedKind).toBe("close_gift");
    expect(advice.obvious).toBe(true);
  });

  it("消耗加快后曝光相对上一刻塌掉，才停在流量质量", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      spendSpike: true,
      adSpendFen: 16_000,
      prevAdSpendFen: 10_000,
      impressions: 400,
      prevImpressions: 1000,
      watch: 80,
      prevWatch: 80,
      productClicks: 20,
      prevProductClicks: 20
    });
    expect(advice.stage).toBe("exposure");
    expect(advice.obvious).toBe(true);
    expect(advice.suggestedKind).toBe("traffic_quality");
    expect(advice.finding?.text).toContain("没跟上加量");
    expect(advice.finding?.text).toContain("400");
    expect(advice.next.text).not.toContain("是不是加量");
  });

  it("消耗加快且曝光次数涨了，即使没按消耗同比跟上也先看观看", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      spendSpike: true,
      adSpendFen: 5_500,
      prevAdSpendFen: 700,
      impressions: 1_355,
      prevImpressions: 443,
      watch: 110,
      prevWatch: 200,
      productClicks: 16,
      prevProductClicks: 14,
      paidOrders: 4
    });
    expect(advice.stage).toBe("entry");
    expect(advice.suggestedKind).toBe("retain");
    expect(advice.finding?.text).toContain("观看");
    expect(advice.finding?.text).toContain("没跟上曝光");
    expect(advice.next.text).toContain("提状态");
    expect(advice.next.text).not.toContain("流量质量");
  });

  it("消耗加快、曝光没涨且有点击没成单时，当更准人群并强化逼单", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      spendSpike: true,
      adSpendFen: 8_300,
      prevAdSpendFen: 5_500,
      impressions: 1_331,
      prevImpressions: 1_355,
      watch: 400,
      prevWatch: 380,
      productClicks: 23,
      prevProductClicks: 16,
      paidOrders: 0,
      speechPresentKeys: ["product_benefit", "product_efficacy", "suitable_audience", "price", "after_sale", "product_card_cta"]
    });
    expect(advice.stage).toBe("convert");
    expect(advice.obvious).toBe(true);
    expect(advice.suggestedKind).toBe("close_urgency");
    expect(advice.finding?.text).toContain("更可能更准");
    expect(advice.finding?.text).not.toContain("流量质量");
    expect(advice.next.text).toContain("逼单");
    expect(advice.next.text).toContain("23");
    expect(advice.next.text).not.toContain("先不要催单");
  });

  it("有点击也有成交时，结论写成单偏少，不写还没变成单", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      productClicks: 46,
      paidOrders: 2,
      convertRateMedian: 0.16,
      impressions: 400,
      watch: 80,
      adSpendFen: 2_000,
      evenSpendFen: 2_000
    });
    expect(advice.stage).toBe("convert");
    expect(advice.finding?.text).toContain("成交 2 单");
    expect(advice.finding?.text).toContain("成单偏少");
    expect(advice.finding?.text).not.toContain("还没变成单");
    expect(advice.finding?.text).not.toContain("没成单");
  });

  it("有点击没成单且转写缺赠品保障时，补闭环而不是催单", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      productClicks: 14,
      paidOrders: 0,
      impressions: 400,
      watch: 80,
      adSpendFen: 2_000,
      evenSpendFen: 2_000
    });
    expect(advice.stage).toBe("convert");
    expect(advice.suggestedKind).toBe("close_gift");
    expect(advice.next.text).toContain("赠品");
    expect(advice.next.text).toContain("先不要催单");
  });

  it("消耗加快且曝光跟上后，观看没跟上就停在留人", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      spendSpike: true,
      adSpendFen: 16_000,
      prevAdSpendFen: 10_000,
      impressions: 1600,
      prevImpressions: 1000,
      watch: 50,
      prevWatch: 200,
      productClicks: 20,
      prevProductClicks: 20
    });
    expect(advice.stage).toBe("entry");
    expect(advice.obvious).toBe(true);
    expect(advice.suggestedKind).toBe("retain");
    expect(advice.finding?.text).toContain("观看");
    expect(advice.finding?.text).toContain("没跟上曝光");
  });

  it("消耗加快且人跟上后，点击没跟上就停在点小黄车", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      spendSpike: true,
      adSpendFen: 16_000,
      prevAdSpendFen: 10_000,
      impressions: 1600,
      prevImpressions: 1000,
      watch: 320,
      prevWatch: 200,
      productClicks: 5,
      prevProductClicks: 40
    });
    expect(advice.stage).toBe("click");
    expect(advice.obvious).toBe(true);
    expect(advice.suggestedKind).toBe("click_cta");
    expect(advice.finding?.text).toContain("商品点击");
    expect(advice.finding?.text).toContain("没跟上进来的人");
  });

  it("消耗加快且曝光观看点击都跟上，只观察不加戏", () => {
    const advice = diagnoseFunnelAdvice({
      ...base,
      spendSpike: true,
      adSpendFen: 16_000,
      prevAdSpendFen: 10_000,
      impressions: 1600,
      prevImpressions: 1000,
      watch: 320,
      prevWatch: 200,
      productClicks: 64,
      prevProductClicks: 40,
      paidOrders: 4
    });
    expect(advice.stage).toBe("spend_spike");
    expect(advice.obvious).toBe(false);
    expect(advice.suggestedKind).toBe("hold");
    expect(advice.showFinding).toBe(true);
    expect(advice.finding?.text).toContain("都跟上了加量");
    expect(advice.next.text).toContain("暂不调整");
  });
});

describe("consecutiveObviousStageCount", () => {
  it("同一明显掉档连数，不同层或不够明显则断开", () => {
    expect(consecutiveObviousStageCount(
      { stage: "spend", obvious: true },
      [{ stage: "spend", obvious: true }, { stage: "spend", obvious: true }]
    )).toBe(3);
    expect(consecutiveObviousStageCount(
      { stage: "spend", obvious: true },
      [{ stage: "spend", obvious: true }, { stage: "click", obvious: true }]
    )).toBe(1);
    expect(consecutiveObviousStageCount(
      { stage: "maintain", obvious: false },
      [{ stage: "spend", obvious: true }, { stage: "spend", obvious: true }]
    )).toBe(1);
  });
});
