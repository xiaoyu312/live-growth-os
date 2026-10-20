import {
  operatorEvaluationListSchema,
  operatorFactsSchema,
  operatorSettingsSchema,
  type OperatorEvaluation,
  type OperatorFacts,
  type OperatorPriority,
  type OperatorRuleId,
  type OperatorSettings,
  type OperatorValue
} from "@live-growth/contracts";

export const OPERATOR_RECHECK_MINUTES = 10 as const;
export const OPERATOR_RULE_COUNT = 17 as const;

type MetricName =
  | "spendHour"
  | "enters5m"
  | "staySeconds"
  | "gmvHour"
  | "ordersHour"
  | "orders30m"
  | "gpm"
  | "cvr"
  | "ctr"
  | "aov"
  | "cpm"
  | "exposureEntryRate"
  | "productExposureRate"
  | "productExposureWatchRate"
  | "commentRate"
  | "followRate";

type Definition = {
  ruleId: OperatorRuleId;
  title: string;
  priority: OperatorPriority;
  owner: string;
};

/** 试运行优先序：违规 → 无单/低在线 → CVR → GPM/AOV → 流量/CPM → 人群/互动。CTR 仅作 GPM 抓手。 */
export const OPERATOR_RULE_DEFINITIONS: readonly Definition[] = [
  { ruleId: "compliance-violation", title: "直播间出现违规提示", priority: "critical", owner: "主播/运营" },
  { ruleId: "no-output-30m", title: "直播间超过半小时没有产出", priority: "high", owner: "投手/运营" },
  { ruleId: "low-online", title: "直播间连续 5 分钟低在线", priority: "high", owner: "投手/运营" },
  { ruleId: "cvr-low", title: "商品点击→支付订单率低于本场均值", priority: "high", owner: "主播/投手" },
  { ruleId: "gpm-low", title: "GPM 低于本场 30 分钟内均值", priority: "medium", owner: "运营" },
  { ruleId: "aov-low", title: "客单价低于本场均值", priority: "medium", owner: "主播" },
  { ruleId: "view-rate-low", title: "曝光观看率低于本场均值", priority: "medium", owner: "主播/投手" },
  { ruleId: "cpm-high", title: "千次曝光成本高于已设置目标", priority: "medium", owner: "投手/主播" },
  { ruleId: "online-spike", title: "在线人数突然暴涨", priority: "low", owner: "主播/运营" },
  { ruleId: "big-orders", title: "30 分钟连续出现大单", priority: "low", owner: "投手/主播" },
  { ruleId: "new-customer-heavy", title: "在线新客占比超过 60%", priority: "low", owner: "主播/运营" },
  { ruleId: "old-customer-heavy", title: "在线老客占比超过 60%", priority: "low", owner: "主播/运营" },
  { ruleId: "product-exposure-low", title: "商品曝光率低于 30 分钟内均值", priority: "low", owner: "中控/主播" },
  { ruleId: "product-exposure-watch-low", title: "商品曝光观看率低于 30 分钟内均值", priority: "low", owner: "中控/主播" },
  { ruleId: "short-stay", title: "平均停留时长低于 1 分钟", priority: "low", owner: "主播/中控" },
  { ruleId: "comment-rate-low", title: "评论率低于本场均值", priority: "low", owner: "主播/中控" },
  { ruleId: "follow-rate-low", title: "转粉率低于本场均值", priority: "low", owner: "主播/中控" }
];

function metric(facts: OperatorFacts, key: MetricName): OperatorValue | undefined {
  return facts[key];
}

function missingMetric(name: string, value: OperatorValue | undefined, baseline = false): string[] {
  if (!value) return [name];
  if (baseline && value.baseline === undefined) return [`${name}.baseline`];
  return [];
}

function valueText(value: OperatorValue): string {
  return `${value.value}${value.unit}`;
}

function base(definition: Definition, state: OperatorEvaluation["state"], reason: string, options?: {
  actions?: string[];
  fallback?: string[];
  hypotheses?: string[];
  evidence?: OperatorValue[];
  missing?: string[];
}): OperatorEvaluation {
  return {
    ruleId: definition.ruleId,
    title: definition.title,
    priority: definition.priority,
    state,
    owner: definition.owner,
    actions: options?.actions ?? [],
    fallback: options?.fallback ?? [],
    hypotheses: options?.hypotheses ?? [],
    evidence: options?.evidence ?? [],
    missing: options?.missing ?? [],
    reason
  };
}

function insufficient(definition: Definition, missing: string[], reason: string, evidence: OperatorValue[] = []): OperatorEvaluation {
  return base(definition, "insufficient_data", reason, { missing, evidence });
}

function clear(definition: Definition, reason: string, evidence: OperatorValue[] = []): OperatorEvaluation {
  return base(definition, "clear", reason, { evidence });
}

function triggered(definition: Definition, reason: string, options: {
  actions: string[];
  fallback: string[];
  evidence?: OperatorValue[];
  hypotheses?: string[];
}): OperatorEvaluation {
  return base(definition, "triggered", reason, options);
}

function configuredActivity(settings: OperatorSettings, action: string): string {
  return settings.activityPlan.trim()
    ? `${action}；按已确认活动方案执行：${settings.activityPlan.trim()}`
    : `${action}；负责人先确认当前可用的活动／商品方案，再由人工执行`;
}

function configuredRetarget(settings: OperatorSettings): string {
  if (settings.retargetMaterials.length === 0) {
    return "投手先确认当前可用的 1–2 条追投素材，再人工追投并观察转化";
  }
  return `投手从已确认的追投素材（${settings.retargetMaterials.join("、")}）中选择并人工追投，观察转化`;
}

function lowSpendRouting(settings: OperatorSettings, enters: OperatorValue): { actions: string[]; hypotheses: string[] } {
  if (enters.baseline !== undefined && enters.value >= enters.baseline) {
    return {
      actions: ["当前 5 分钟直播间进入未低于此前同口径均值，优先调整直播间承接，不直接追投"],
      hypotheses: ["低消耗但进入未减弱，优先检查直播间承接"]
    };
  }
  return {
    actions: ["当前 5 分钟直播间进入低于此前同口径均值，反馈投手排查计划、定向和素材衰减", configuredRetarget(settings)],
    hypotheses: ["进入人数低于同场基线", "计划可能关停", "定向可能偏移", "素材可能衰减"]
  };
}

function evaluateCompliance(facts: OperatorFacts, definition: Definition): OperatorEvaluation {
  const observation = facts.observation;
  if (observation?.violationActive === undefined) {
    return insufficient(definition, ["observation.violationActive"], "没有人工确认的违规提示状态，不判断合规问题");
  }
  if (!observation.violationActive) return clear(definition, "人工确认当前没有违规提示");
  const reason = observation.violationReason?.trim();
  return triggered(definition, reason ? `已收到人工确认的违规提示：${reason}` : "已收到人工确认的违规提示，但违规原因尚未补充", {
    actions: [
      "主播立即查看违规细则，运营人工确认原因、申诉可能性和需要调整的内容",
      "把确认后的调整方案明确传达给主播，保持人工复核"
    ],
    fallback: ["在大屏保留违规提醒，并在主播再次触发相关表达前人工提醒"],
    hypotheses: reason ? [reason] : []
  });
}

function evaluateNoOutput(facts: OperatorFacts, settings: OperatorSettings, definition: Definition): OperatorEvaluation {
  const orders = metric(facts, "orders30m");
  if (facts.elapsedMinutes < 30) {
    return insufficient(definition, ["elapsedMinutes>=30", "orders30m"], "尚未满 30 分钟窗口，不判断半小时无产出");
  }
  const missingOrders = missingMetric("orders30m", orders);
  if (missingOrders.length) return insufficient(definition, missingOrders, "缺少完整的 30 分钟订单数据，不把缺失当作无订单");
  if (orders!.value > 0) return clear(definition, `最近 30 分钟已有 ${valueText(orders!)}，无订单规则不触发`, [orders!]);
  if (facts.elapsedMinutes < 60) {
    return triggered(definition, `最近 30 分钟订单为 0，当前开播 ${facts.elapsedMinutes} 分钟，先检查直播间承接并等待满 1 小时消耗`, {
      actions: ["运营人工检查直播间承接，先等待满 1 小时消耗分流"],
      fallback: ["满 1 小时后再按消耗和直播间进入分流；10 分钟后复查"],
      evidence: [orders!]
    });
  }
  const spend = metric(facts, "spendHour");
  const missingSpend = missingMetric("spendHour", spend);
  if (missingSpend.length) return triggered(definition, "最近 30 分钟订单为 0，已满 1 小时但小时消耗尚未获得，先核对消耗和直播间进入，不猜追投", {
    actions: ["运营人工核对满 1 小时消耗和直播间进入，暂不追投或重开"],
    fallback: ["补齐小时消耗和进入后再分流；10 分钟后复查"],
    evidence: [orders!]
  });
  if (spend!.value < 300) {
    const enters = metric(facts, "enters5m");
    if (!enters) return triggered(definition, "最近 30 分钟订单为 0，小时消耗低于 300 元但直播间进入缺失，先补进入数据，不猜追投", {
      actions: ["运营人工核对当前 5 分钟直播间进入及此前同口径均值，暂不追投"],
      fallback: ["补齐进入数据后再决定承接或追投；10 分钟后复查"],
      evidence: [orders!, spend!]
    });
    if (enters.baseline === undefined) return triggered(definition, "最近 30 分钟订单为 0，小时消耗低于 300 元但直播间进入基线缺失，先补基线，不猜追投", {
      actions: ["运营人工核对此前同口径直播间进入均值，暂不追投"],
      fallback: ["补齐进入基线后再分流；10 分钟后复查"],
      evidence: [orders!, spend!, enters]
    });
    const routing = lowSpendRouting(settings, enters);
    return triggered(definition, `最近 30 分钟订单为 0，且满 1 小时消耗 ${valueText(spend!)}<300 元`, {
      actions: routing.actions,
      fallback: ["人工确认是否重开直播间并同步运营；10 分钟后复查"],
      evidence: [orders!, spend!, enters],
      hypotheses: routing.hypotheses
    });
  }
  return triggered(definition, `最近 30 分钟订单为 0，但满 1 小时消耗 ${valueText(spend!)}≥300 元`, {
    actions: ["人工切换已确认的主推链接，先承接成交", configuredActivity(settings, "适当提已确认的福利方案")],
    fallback: ["无改善时人工确认是否重开直播间，并同步运营；10 分钟后复查"],
    evidence: [orders!, spend!]
  });
}

function evaluateLowOnline(facts: OperatorFacts, settings: OperatorSettings, definition: Definition): OperatorEvaluation {
  if (facts.onlineLow5m === undefined) return insufficient(definition, ["onlineLow5m"], "缺少连续 5 分钟低在线状态");
  if (!facts.onlineLow5m) return clear(definition, "最近连续 5 分钟没有低在线信号");
  if (facts.elapsedMinutes < 60) return insufficient(definition, ["elapsedMinutes>=60", "spendHour"], "低在线虽已持续 5 分钟，但未满 1 小时，不用小时消耗分流");
  const spend = metric(facts, "spendHour");
  if (!spend) return insufficient(definition, ["spendHour"], "低在线分流需要满 1 小时消耗");
  if (spend.value < 300) {
    const enters = metric(facts, "enters5m");
    if (!enters) return insufficient(definition, ["enters5m"], "低消耗分流需要当前 5 分钟进入及此前同口径基线，进入缺失不猜", [spend]);
    if (enters.baseline === undefined) return insufficient(definition, ["enters5m.baseline"], "低消耗分流需要此前同口径进入基线", [spend, enters]);
    const routing = lowSpendRouting(settings, enters);
    return triggered(definition, `连续 5 分钟低在线，满 1 小时消耗 ${valueText(spend)}<300 元`, {
      actions: routing.actions,
      fallback: [configuredActivity(settings, "若 10 分钟后仍无改善，人工调整引流话术或切已确认的低价福利款")],
      evidence: [spend, enters],
      hypotheses: routing.hypotheses
    });
  }
  const stay = metric(facts, "staySeconds");
  if (!stay) return insufficient(definition, ["staySeconds"], "消耗正常时还需平均停留判断秒进秒出", [spend]);
  if (stay.value < 30) {
    return triggered(definition, `连续 5 分钟低在线，消耗正常但平均停留 ${valueText(stay)}<30 秒`, {
      actions: [configuredActivity(settings, "先稳定停留并人工提醒主播互动")],
      fallback: ["10 分钟后仍无改善，人工调整引流话术并确认低价福利款方案"],
      evidence: [spend, stay]
    });
  }
  return triggered(definition, `连续 5 分钟低在线，消耗 ${valueText(spend)}≥300 元但平均停留未低于 30 秒`, {
    actions: ["运营人工排查直播间承接和直播间进入后的流失，暂不自动追投"],
    fallback: ["10 分钟后复查低在线与进入数据"],
    evidence: [spend, stay]
  });
}

function evaluateMetricBelowBaseline(
  facts: OperatorFacts,
  definition: Definition,
  key: MetricName,
  label: string,
  action: string,
  fallback: string,
  options?: { ownerHypotheses?: string[] }
): OperatorEvaluation {
  const value = metric(facts, key);
  if (!value) return insufficient(definition, [label], `缺少${label}及其同口径本场基线，不判断`);
  if (value.baseline === undefined) return insufficient(definition, [`${label}.baseline`], `缺少${label}及其同口径本场基线，不判断`, [value]);
  if (value.value >= value.baseline) return clear(definition, `${label} ${valueText(value)}未低于本场基线 ${value.baseline}${value.unit}`, [value]);
  return triggered(definition, `${label} ${valueText(value)}低于本场基线 ${value.baseline}${value.unit}`, {
    actions: [action], fallback: [fallback], evidence: [value], ...(options?.ownerHypotheses ? { hypotheses: options.ownerHypotheses } : {})
  });
}

function evaluateCvr(facts: OperatorFacts, settings: OperatorSettings, definition: Definition): OperatorEvaluation {
  const value = metric(facts, "cvr");
  if (!value) return insufficient(definition, ["cvr"], "缺少同源订单/点击 CVR 及本场模式基线，不判断");
  if (value.baseline === undefined) return insufficient(definition, ["cvr.baseline"], "缺少同源订单/点击 CVR 及本场模式基线，不判断", [value]);
  if (value.value >= value.baseline) return clear(definition, `当前${settings.mode === "pulse" ? "脉冲" : "非脉冲"}场 CVR 未低于基线`, [value]);
  return triggered(definition, `当前${settings.mode === "pulse" ? "脉冲" : "非脉冲"}场 CVR ${valueText(value)}低于本场模式基线 ${value.baseline}${value.unit}`, {
    actions: settings.mode === "pulse"
      ? ["脉冲场：先关注成交密度，人工检查利益点和承接，再决定是否切已确认方案"]
      : ["非脉冲场：人工检查人群、价值塑造、痛点和信任表达，必要时调整主推品"],
    fallback: ["10 分钟后复查同源 CVR，仍低时人工减少科普并补利益点"],
    evidence: [value],
    hypotheses: ["人群不匹配", "价值塑造或信任不足", "痛点未打透"]
  });
}

function evaluateGpm(facts: OperatorFacts, settings: OperatorSettings, definition: Definition): OperatorEvaluation {
  const value = metric(facts, "gpm");
  if (!value) return insufficient(definition, ["gpm"], "缺少平台直出当前 GPM 及此前 30 分钟同模式基线，不判断");
  if (value.baseline === undefined) return insufficient(definition, ["gpm.baseline"], "缺少平台直出当前 GPM 及此前 30 分钟同模式基线，不判断", [value]);
  if (value.value >= value.baseline) return clear(definition, `当前 GPM ${valueText(value)}未低于此前 30 分钟同模式基线`, [value]);
  const handleActions: string[] = [];
  const cvr = metric(facts, "cvr");
  if (cvr?.baseline !== undefined && cvr.value < cvr.baseline) handleActions.push("同源 CVR 也偏低，优先检查转化表达和直播间承接");
  const ctr = metric(facts, "ctr");
  if (ctr?.baseline !== undefined && ctr.value < ctr.baseline) handleActions.push("同源商品 CTR 也偏低，优先检查直播间进入钩子和商品指引");
  const actions = settings.mode === "pulse"
    ? [configuredActivity(settings, "脉冲场优先拉高成交密度，人工走已确认的福利款／脉冲方案")]
    : ["非脉冲场：若同源 CTR／CVR 偏低，按对应抓手人工调整直播间进入承接或转化表达", "若确认客单价偏低，人工切已确认的 1v1 大套组路线", "若排品不合理，人工调整福利款承接顺序"];
  actions.push(...handleActions);
  return triggered(definition, `当前 GPM ${valueText(value)}低于此前 30 分钟同模式基线`, {
    actions,
    fallback: [configuredActivity(settings, "复查仍低时优先执行已确认的脉冲／福利方案，拉高成交密度") , "10 分钟后复查"],
    evidence: [value],
    hypotheses: ["成交密度低", "客单价偏低", "排品顺序不合理"]
  });
}

function evaluateAov(facts: OperatorFacts, settings: OperatorSettings, definition: Definition): OperatorEvaluation {
  const value = metric(facts, "aov");
  if (!value) return insufficient(definition, ["aov"], "缺少订单均额及本场同口径基线，不判断");
  if (value.baseline === undefined) return insufficient(definition, ["aov.baseline"], "缺少订单均额及本场同口径基线，不判断", [value]);
  if (value.value >= value.baseline) return clear(definition, `客单价 ${valueText(value)}未低于本场基线`, [value]);
  return triggered(definition, `客单价 ${valueText(value)}低于本场基线 ${value.baseline}${value.unit}`, {
    actions: ["主播人工做价值对比，引导加购搭配并 1v1 主推已确认的大套组"],
    fallback: [configuredActivity(settings, "人工确认套餐专属活动方案，刺激多件下单")],
    evidence: [value],
    hypotheses: ["低价体验款占比高", "套组讲解不足"]
  });
}

function evaluateOnlineSpike(facts: OperatorFacts, settings: OperatorSettings, definition: Definition): OperatorEvaluation {
  if (facts.onlineSpike5m === undefined) return insufficient(definition, ["onlineSpike5m"], "缺少持续 5 分钟在线暴涨状态");
  if (!facts.onlineSpike5m) return clear(definition, "最近没有持续 5 分钟的在线暴涨信号");
  const spend = metric(facts, "spendHour");
  if (facts.elapsedMinutes >= 60 && !spend) return insufficient(definition, ["spendHour"], "在线暴涨已满 1 小时但缺少小时消耗，不能判断低消耗分支");
  if (facts.elapsedMinutes >= 60 && spend && spend.value < 300) {
    return triggered(definition, `在线暴涨持续 5 分钟，满 1 小时消耗 ${valueText(spend)}<300 元`, {
      actions: ["反馈投手排查计划和定向，暂不加投", "主播先稳住停留并人工观察真实互动"],
      fallback: ["10 分钟停留持续走低时，人工确认可用的活动／商品方案锁定停留"],
      evidence: [spend],
      hypotheses: ["自然流量突然增加"]
    });
  }
  const observation = facts.observation;
  if (observation?.botsSuspected === undefined) return insufficient(definition, ["observation.botsSuspected"], "在线暴涨需要人工判断账号是否异常");
  if (observation.botsSuspected) {
    if (observation.interactionPresent === undefined) return insufficient(definition, ["observation.interactionPresent"], "账号疑似异常时需要人工确认是否有真实互动");
    if (observation.interactionPresent) return clear(definition, "在线暴涨但人工确认有真实互动，暂不提示追投");
    return triggered(definition, "在线暴涨且人工判断账号疑似异常、当前无真实互动", {
      actions: ["提醒主播加强互动，人工观察真实互动，不追投"],
      fallback: [configuredActivity(settings, "10 分钟后仍无互动时人工上福袋锁人")]
    });
  }
  const newShare = observation.newCustomerSharePct;
  const oldShare = observation.oldCustomerSharePct;
  if (newShare === undefined || oldShare === undefined) return insufficient(definition, ["observation.newCustomerSharePct", "observation.oldCustomerSharePct"], "账号正常时需要人工确认新老客结构");
  if (newShare > 60) {
    return triggered(definition, `在线暴涨且人工确认新客占比 ${newShare}%>60%`, {
      actions: ["主播人工主推已确认的入门商品，讲入门体验和基础痛点"],
      fallback: [configuredActivity(settings, "新客转化弱时人工确认低门槛福利方案")],
      hypotheses: ["新客流量突然增加"]
    });
  }
  if (oldShare > 60) {
    return triggered(definition, `在线暴涨且人工确认老客占比 ${oldShare}%>60%`, {
      actions: ["主播人工主推已确认的复购套组，讲复购进阶和老客权益"],
      fallback: [configuredActivity(settings, "老客不下单时人工确认复购活动方案")],
      hypotheses: ["老客流量突然增加"]
    });
  }
  return clear(definition, `在线暴涨但人工确认新客 ${newShare}%、老客 ${oldShare}%均未超过 60%，暂不提示结构动作`);
}

function evaluateBigOrders(facts: OperatorFacts, settings: OperatorSettings, definition: Definition): OperatorEvaluation {
  const observation = facts.observation;
  if (observation?.bigOrders30m === undefined) return insufficient(definition, ["observation.bigOrders30m"], "需要人工确认 30 分钟内每笔超过 1500 元的大单笔数，不能由客单价推断");
  const orders = observation.bigOrders30m;
  if (orders < 3) return clear(definition, `人工确认 30 分钟内大单 ${orders} 笔，未达到 3 笔`, []);
  return triggered(definition, `人工确认 30 分钟内每笔超过 1500 元的大单 ${orders} 笔，已达到 3 笔`, {
    actions: [configuredRetarget(settings), "主播顺势拔高产品价值，引导高客单套组"],
    fallback: ["10 分钟后查看追投转化；持续大单时人工锁定高客单主推，减少低价款占比"],
    hypotheses: ["高客单人群正在集中"]
  });
}

function evaluateObservationShare(facts: OperatorFacts, settings: OperatorSettings, definition: Definition, kind: "new" | "old"): OperatorEvaluation {
  const observation = facts.observation;
  const key = kind === "new" ? "newCustomerSharePct" : "oldCustomerSharePct";
  const value = observation?.[key];
  if (value === undefined) return insufficient(definition, [`observation.${key}`], `缺少人工确认的${kind === "new" ? "新客" : "老客"}占比，不判断人群结构`);
  if (value <= 60) return clear(definition, `人工确认的${kind === "new" ? "新客" : "老客"}占比 ${value}%未超过 60%`);
  return triggered(definition, `人工确认的${kind === "new" ? "新客" : "老客"}占比 ${value}%>60%`, {
    actions: kind === "new"
      ? ["主播人工主推已确认的入门商品，讲入门体验和基础痛点"]
      : ["主播人工主推已确认的复购套组，讲复购进阶和老客权益"],
    fallback: [configuredActivity(settings, kind === "new" ? "新客转化弱时确认低门槛福利方案" : "老客不下单时确认复购活动方案")],
    hypotheses: [kind === "new" ? "新客流量占比高" : "老客流量占比高"]
  });
}

function evaluateProductExposure(facts: OperatorFacts, definition: Definition): OperatorEvaluation {
  const productExposure = metric(facts, "productExposureRate");
  const pluginAbnormal = facts.observation?.pluginAbnormal;
  if (!productExposure) return insufficient(definition, ["productExposureRate"], "缺少商品曝光率及其基线，不判断商品曝光问题");
  if (productExposure.baseline === undefined) return insufficient(definition, ["productExposureRate.baseline"], "缺少商品曝光率本场基线，不判断", [productExposure]);
  if (productExposure.value >= productExposure.baseline) return clear(definition, "商品曝光率未低于 30 分钟基线", [productExposure]);
  if (pluginAbnormal === undefined) return insufficient(definition, ["observation.pluginAbnormal"], "商品曝光率低时还需人工确认插件状态，不能直接判定插件异常", [productExposure]);
  if (pluginAbnormal) {
    return triggered(definition, "商品曝光率低于 30 分钟基线，且人工确认插件异常", {
      actions: ["中控确认插件对象、执行人和前置检查后，再人工决定是否重启插件；同时提醒主播高频指向小黄车"],
      fallback: ["人工确认后再决定是否重启插件；10 分钟后复查"],
      evidence: [productExposure],
      hypotheses: ["购物车插件可能异常"]
    });
  }
  return triggered(definition, "商品曝光率低于 30 分钟基线，但插件人工确认正常", {
    actions: ["提醒主播人工增加小黄车指引，检查当前主推链接卖点和福利表达"],
    fallback: ["持续偏低时人工调整链接顺序并复查；不自动重启插件"],
    evidence: [productExposure],
    hypotheses: ["主播较少引导看小黄车", "当前主推品吸引力不足"]
  });
}

export function evaluateOperatorRules(factsInput: OperatorFacts, settingsInput: OperatorSettings): OperatorEvaluation[] {
  const facts = operatorFactsSchema.parse(factsInput);
  const settings = operatorSettingsSchema.parse(settingsInput);
  const byId = new Map<OperatorRuleId, OperatorEvaluation>();

  for (const definition of OPERATOR_RULE_DEFINITIONS) {
    let evaluation: OperatorEvaluation;
    switch (definition.ruleId) {
      case "compliance-violation": evaluation = evaluateCompliance(facts, definition); break;
      case "no-output-30m": evaluation = evaluateNoOutput(facts, settings, definition); break;
      case "low-online": evaluation = evaluateLowOnline(facts, settings, definition); break;
      case "cvr-low": evaluation = evaluateCvr(facts, settings, definition); break;
      case "gpm-low": evaluation = evaluateGpm(facts, settings, definition); break;
      case "aov-low": evaluation = evaluateAov(facts, settings, definition); break;
      case "view-rate-low": evaluation = evaluateMetricBelowBaseline(facts, definition, "exposureEntryRate", "曝光观看率", "提醒主播加快节奏、点名引导直播间进入并强化限时福利；人工观察数据", "持续走低时反馈投手人工切换引流素材，并调整直播间口播", { ownerHypotheses: ["大盘流量波动", "素材／封面标题吸引力不足", "主推品吸引力不足"] }); break;
      case "cpm-high": {
        const value = metric(facts, "cpm");
        if (!value) evaluation = insufficient(definition, ["cpm"], "缺少实际 CPM，不判断成本偏高");
        else if (settings.cpmTargetYuan === undefined) evaluation = insufficient(definition, ["settings.cpmTargetYuan"], "已提供 CPM 但未设置本场目标，不用默认阈值判断", [value]);
        else if (value.value <= settings.cpmTargetYuan) evaluation = clear(definition, `CPM ${valueText(value)}未高于目标 ${settings.cpmTargetYuan}${value.unit}`, [value]);
        else evaluation = triggered(definition, `CPM ${valueText(value)}高于已设置目标 ${settings.cpmTargetYuan}${value.unit}`, {
          actions: ["投手人工排查计划、素材与人群；主播人工强化直播间进入钩子并降低流失"],
          fallback: ["10 分钟复查仍有问题时，由投手确认是否收缩预算以保 ROI；不自动关停或改 ROI"],
          evidence: [value],
          hypotheses: ["行业竞争变化", "近期 A3 人群资产变化", "素材老化", "人群定向跑偏", "直播间承接差导致系统抬价"]
        });
        break;
      }
      case "online-spike": evaluation = evaluateOnlineSpike(facts, settings, definition); break;
      case "big-orders": evaluation = evaluateBigOrders(facts, settings, definition); break;
      case "new-customer-heavy": evaluation = evaluateObservationShare(facts, settings, definition, "new"); break;
      case "old-customer-heavy": evaluation = evaluateObservationShare(facts, settings, definition, "old"); break;
      case "product-exposure-low": evaluation = evaluateProductExposure(facts, definition); break;
      case "product-exposure-watch-low": evaluation = evaluateMetricBelowBaseline(facts, definition, "productExposureWatchRate", "商品曝光观看率", "提醒主播高频指向小黄车并强化价格、赠品信息；中控人工确认链接顺序", "持续偏低时人工调整链接置顶顺序并把已确认福利款放到 1 号链接", { ownerHypotheses: ["链接卖点不清晰", "福利力度感知弱"] }); break;
      case "short-stay": {
        const stay = metric(facts, "staySeconds");
        if (!stay) { evaluation = insufficient(definition, ["staySeconds", "gmvHour", "ordersHour"], "缺少平均停留和时均产出数据，不判断停留问题"); break; }
        const gmv = metric(facts, "gmvHour");
        const orders = metric(facts, "ordersHour");
        const missing = [...missingMetric("gmvHour", gmv), ...missingMetric("ordersHour", orders)];
        if (missing.length) { evaluation = insufficient(definition, missing, "低停留需要同时确认时均 GMV 与时均订单，避免把低产出条件判断错", [stay, ...(gmv ? [gmv] : []), ...(orders ? [orders] : [])]); break; }
        if (stay.value >= 60) { evaluation = clear(definition, `平均停留 ${valueText(stay)}未低于 60 秒`, [stay, gmv!, orders!]); break; }
        const productive = gmv!.value >= 1000 || orders!.value >= 3;
        evaluation = productive
          ? clear(definition, `平均停留 ${valueText(stay)}<60 秒，但时均 GMV ${valueText(gmv!)}或订单 ${valueText(orders!)}已达到产出条件，暂不动作`, [stay, gmv!, orders!])
          : triggered(definition, `平均停留 ${valueText(stay)}<60 秒，且时均 GMV<1000、时均订单<3`, {
            actions: ["人工确认可用活动后设置福袋任务（评论／关注）并缩短长篇科普"],
            fallback: ["停留持续下滑时人工穿插福利抽奖；10 分钟后复查"],
            evidence: [stay, gmv!, orders!],
            hypotheses: ["直播间进入承接弱", "福利任务不足"]
          });
        break;
      }
      case "comment-rate-low": evaluation = evaluateMetricBelowBaseline(facts, definition, "commentRate", "评论率", "主播人工每 3 分钟抛出互动问题，中控置顶评论引导关键词", "无改善时人工确认评论抽奖方案带动互动", { ownerHypotheses: ["直播间进入人群不匹配", "主播单向输出"] }); break;
      case "follow-rate-low": evaluation = evaluateMetricBelowBaseline(facts, definition, "followRate", "转粉率", "主播人工讲清关注权益，中控确认关注参与门槛", "长期偏低时人工确认粉丝专属小样方案", { ownerHypotheses: ["福利未与关注挂钩", "粉丝权益讲解不足"] }); break;
    }
    byId.set(definition.ruleId, evaluation);
  }

  const results = OPERATOR_RULE_DEFINITIONS.map((definition) => byId.get(definition.ruleId)!);
  return operatorEvaluationListSchema.parse(results);
}
