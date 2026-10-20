import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { classifyPageUrl } from "../../src/allowlist";
import { collectCompassDomMetricSnapshots, domFallbackAllowed, mapCompassDomMetricSnapshots, selectMetricValue } from "../../src/dom-fallback";

describe("Phase 2A DOM fallback 门控", () => {
  it("只有 Compass 白名单且 CDP 没有结构时才允许注入，千川永不注入", () => {
    const board = classifyPageUrl("https://qianchuan.jinritemai.com/board-next");
    const agent = classifyPageUrl("https://agent.oceanengine.com/admin/optimizeModule/qianchuan/");
    expect(domFallbackAllowed(board, 0, "qianchuan-board")).toBe(false);
    expect(domFallbackAllowed(board, 1, "qianchuan-board")).toBe(false);
    expect(domFallbackAllowed(board, 0, "qianchuan-agent")).toBe(false);
    expect(domFallbackAllowed(agent, 0, "qianchuan-board")).toBe(false);
    expect(domFallbackAllowed({ status: "login", routeId: null }, 0, null)).toBe(false);
    expect(domFallbackAllowed({ status: "blocked", routeId: null }, 0, null)).toBe(false);
    const compass = classifyPageUrl("https://compass.jinritemai.com/screen/live/shop");
    expect(domFallbackAllowed(compass, 0, "compass-live-shop")).toBe(true);
  });

  it("千川页面没有 DOM 经营指标入口", () => {
    const board = classifyPageUrl("https://qianchuan.jinritemai.com/board-next");
    expect(domFallbackAllowed(board, 0, "qianchuan-board")).toBe(false);
  });

  it("只把白名单 KPI 快照映射为真实直播字段，金额严格转为分", () => {
    const metric = mapCompassDomMetricSnapshots([
      { semanticCode: "onlineSnapshot", value: 9, unit: "count" },
      { semanticCode: "productClickCount", value: 12, unit: "count" },
      { semanticCode: "userPaidGmvFen5m", value: 10.5, unit: "yuan" }
    ], "2026-08-12T00:00:00.000Z");
    expect(metric).toMatchObject({ sourceEndpoint: "/dom/fallback", onlineSnapshot: 9, productClickCount: 12, userPaidGmvFen5m: 1050 });
  });

  it("没有确切的经营数值时保持空白，不生成零值快照", () => {
    expect(mapCompassDomMetricSnapshots([], "2026-08-12T00:00:00.000Z")).toBeNull();
  });

  it("同一卡片有多个数字时不猜值，共享父级的多卡数字也不串卡", () => {
    expect(selectMetricValue("在线人数", [
      { scope: "online-card", text: "9" },
      { scope: "online-card", text: "12.5%" }
    ])).toBeUndefined();
    expect(selectMetricValue("在线人数", [
      { scope: "online-card", text: "9" },
      { scope: "click-card", text: "12" }
    ])).toBeUndefined();
    expect(selectMetricValue("在线人数", [{ scope: "online-card", text: "9" }])).toEqual({ value: 9, unit: "count" });
    expect(selectMetricValue("未确认指标", [{ scope: "online-card", text: "9" }])).toBeUndefined();
    expect(selectMetricValue("进入人数", [{ scope: "entry-card", text: "9" }])).toBeUndefined();
  });

  it("DOM 采集函数序列化到隔离页面上下文后仍能读取自包含的白名单快照", () => {
    const labelNode: { children: never[]; textContent: string; parentElement: unknown } = { children: [], textContent: "在线人数", parentElement: null };
    const valueNode: { children: never[]; textContent: string; parentElement: unknown } = { children: [], textContent: "9", parentElement: null };
    const card = { children: [labelNode, valueNode], parentElement: null };
    labelNode.parentElement = card;
    valueNode.parentElement = card;
    const result = runInNewContext(`(${collectCompassDomMetricSnapshots.toString()})()`, { document: { querySelectorAll: () => [labelNode, valueNode] } }) as unknown;
    expect(result).toEqual([{ semanticCode: "onlineSnapshot", value: 9, unit: "count" }]);
  });

  it("DOM 快照严格区分人数与金额单位", () => {
    expect(selectMetricValue("在线人数", [{ scope: "card", text: "9元" }])).toBeUndefined();
    expect(selectMetricValue("商品支付金额", [{ scope: "card", text: "10" }])).toBeUndefined();
    expect(selectMetricValue("商品支付金额", [{ scope: "card", text: "¥10" }])).toEqual({ value: 10, unit: "yuan" });
  });

  it("重复同一业务指标时跳过，不使用最后一个值覆盖前一个值", () => {
    expect(mapCompassDomMetricSnapshots([
      { semanticCode: "productClickCount", value: 12, unit: "count" },
      { semanticCode: "productClickCount", value: 13, unit: "count" }
    ], "2026-08-12T00:00:00.000Z")).toBeNull();
  });

  it("隔离页面采集遇到重复标签时跳过该指标", () => {
    const cardA = { children: [] as unknown[], parentElement: null as unknown };
    const cardB = { children: [] as unknown[], parentElement: null as unknown };
    const labelA = { children: [] as never[], textContent: "在线人数", parentElement: cardA as unknown };
    const valueA = { children: [] as never[], textContent: "9", parentElement: cardA as unknown };
    const labelB = { children: [] as never[], textContent: "在线人数", parentElement: cardB as unknown };
    const valueB = { children: [] as never[], textContent: "10", parentElement: cardB as unknown };
    cardA.children = [labelA, valueA];
    cardB.children = [labelB, valueB];
    const result = runInNewContext(`(${collectCompassDomMetricSnapshots.toString()})()`, {
      document: { querySelectorAll: () => [labelA, valueA, labelB, valueB] }
    }) as unknown;
    expect(result).toEqual([]);
  });

  it("在线卡没有数字时不借用相邻卡片的数字", () => {
    const onlineCard = { children: [] as unknown[], parentElement: null as unknown };
    const clickCard = { children: [] as unknown[], parentElement: null as unknown };
    const root = { children: [onlineCard, clickCard], parentElement: null as unknown };
    const onlineLabel = { children: [] as never[], textContent: "在线人数", parentElement: onlineCard as unknown };
    const clickLabel = { children: [] as never[], textContent: "近5分钟商品点击次数", parentElement: clickCard as unknown };
    const clickValue = { children: [] as never[], textContent: "12", parentElement: clickCard as unknown };
    onlineCard.children = [onlineLabel];
    clickCard.children = [clickLabel, clickValue];
    onlineCard.parentElement = root;
    clickCard.parentElement = root;
    const result = runInNewContext(`(${collectCompassDomMetricSnapshots.toString()})()`, {
      document: { querySelectorAll: () => [onlineLabel, clickLabel, clickValue] }
    }) as unknown;
    expect(result).toEqual([{ semanticCode: "productClickCount", value: 12, unit: "count" }]);
  });

  it("共享网格中在线标签不借用点击卡数字，但点击卡仍可独立读取", () => {
    const root = { children: [] as unknown[], parentElement: null as unknown };
    const onlineLabel = { children: [] as never[], textContent: "在线人数", parentElement: root as unknown };
    const clickCard = { children: [] as unknown[], parentElement: root as unknown };
    const clickLabel = { children: [] as never[], textContent: "近5分钟商品点击次数", parentElement: clickCard as unknown };
    const clickValue = { children: [] as never[], textContent: "12", parentElement: clickCard as unknown };
    root.children = [onlineLabel, clickCard];
    clickCard.children = [clickLabel, clickValue];
    const result = runInNewContext(`(${collectCompassDomMetricSnapshots.toString()})()`, {
      document: { querySelectorAll: () => [onlineLabel, clickLabel, clickValue] }
    }) as unknown;
    expect(result).toEqual([{ semanticCode: "productClickCount", value: 12, unit: "count" }]);
  });

  it("嵌套标签和值在同一最小卡片内时可以读取", () => {
    const root = { children: [] as unknown[], parentElement: null as unknown };
    const card = { children: [] as unknown[], parentElement: root as unknown };
    const labelWrap = { children: [] as unknown[], parentElement: card as unknown, querySelectorAll: () => [label] };
    const valueWrap = { children: [] as unknown[], parentElement: card as unknown, querySelectorAll: () => [value] };
    const label = { children: [] as never[], textContent: "在线人数", parentElement: labelWrap as unknown };
    const value = { children: [] as never[], textContent: "9", parentElement: valueWrap as unknown };
    labelWrap.children = [label]; valueWrap.children = [value]; card.children = [labelWrap, valueWrap]; root.children = [card];
    const result = runInNewContext(`(${collectCompassDomMetricSnapshots.toString()})()`, {
      document: { querySelectorAll: () => [label, value] }
    }) as unknown;
    expect(result).toEqual([{ semanticCode: "onlineSnapshot", value: 9, unit: "count" }]);
  });
});
