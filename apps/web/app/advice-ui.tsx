"use client";

import type { AdviceOutcome, AdviceProjection, RuleStatus } from "@live-growth/contracts";

const adviceStatusNames: Record<AdviceProjection["status"], string> = {
  generated: "已生成", delivered: "待查看", seen: "已看到", accepted: "已采纳", rejected: "已拒绝", expired: "已过期"
};

const priorityNames = { low: "低", medium: "中", high: "高" } as const;
const ruleStatusNames: Record<RuleStatus["status"], string> = {
  monitoring: "持续观察", triggered: "条件已满足", insufficient_sample: "数据不足", cooldown: "暂缓重复提醒", confounded: "现场变化待排除"
};

const metricNames: Record<string, string> = {
  room_impression_uv: "直播间曝光人数", room_enter_uv: "直播间进入人数", concurrent_viewers: "当前在线人数",
  product_impression_uv: "商品曝光人数", product_click_uv: "商品点击人数", paid_order_count: "支付订单数",
  paid_buyer_count: "支付人数", gross_paid_gmv_fen: "支付 GMV", refund_gmv_fen: "退款金额",
  ad_spend_fen: "千川消耗", room_entry_rate: "直播间进入率", product_click_rate: "商品点击率",
  click_to_paid_rate: "点击－支付转化率", gross_roi: "支付 ROI（退款前）", net_paid_gmv_fen: "净支付 GMV", net_roi: "净 ROI"
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZone: "UTC"
  }).format(new Date(value));
}

function formatMetricValue(metric: string, value: number | undefined): string {
  if (value === undefined) return "未采集";
  if (metric.endsWith("_rate")) return `${(value * 100).toFixed(1)}%`;
  if (metric.endsWith("_fen")) return new Intl.NumberFormat("zh-CN", {
    style: "currency", currency: "CNY", maximumFractionDigits: 2
  }).format(value / 100);
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function formatDataEvidenceValue(value: number | undefined, unit: string | undefined): string {
  if (value === undefined) return "未采集";
  if (unit === "rate" || unit === "比例") return `${(value * 100).toFixed(1)}%`;
  if (unit === "ratio" || unit === "比值") return value.toFixed(2);
  if (["fen", "fen_per_min", "fen_per_second", "分", "分/分钟", "分/秒"].includes(unit ?? "")) {
    const amount = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(value / 100);
    if (unit === "fen_per_min" || unit === "分/分钟") return `${amount}／分钟`;
    if (unit === "fen_per_second" || unit === "分/秒") return `${amount}／秒`;
    return amount;
  }
  const countUnits = ["count", "人", "条", "段"];
  const formatted = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: countUnits.includes(unit ?? "") ? 0 : 2 }).format(value);
  return unit && unit !== "count" ? `${formatted} ${unit}` : formatted;
}

function OutcomeCard({ outcome }: { outcome: AdviceOutcome }) {
  const interpretation = outcome.observationStatus === "pending" ? "观察中" : outcome.interpretation ?? "待判断";
  return (
    <article className={`outcome-card outcome-${outcome.observationStatus}`}>
      <header><strong>{outcome.windowSec === 120 ? "2 分钟" : "5 分钟"}观察</strong><b>{interpretation}</b></header>
      <p>{metricNames[outcome.metric] ?? outcome.metric}</p>
      <div className="outcome-values">
        <span><small>执行前</small>{formatMetricValue(outcome.metric, outcome.beforeValue)}</span>
        <i aria-hidden="true">→</i>
        <span><small>执行后</small>{formatMetricValue(outcome.metric, outcome.afterValue)}</span>
      </div>
      {outcome.observationStatus === "pending" && <small>观察窗口尚未结束</small>}
      {outcome.confounders.length > 0 && <small>限制：{outcome.confounders.join("；")}</small>}
    </article>
  );
}

export type AdviceAction =
  | { kind: "feedback"; type: "seen" | "accepted" | "rejected" }
  | { kind: "execution"; status: "not_executed" | "executing" | "executed" }
  | { kind: "confounded" };

export function AdviceCard({
  projection, busy, onAction, reviewMode = false
}: {
  projection: AdviceProjection;
  busy: boolean;
  onAction?: (adviceId: string, action: AdviceAction) => Promise<void>;
  reviewMode?: boolean;
}) {
  const { advice } = projection;
  const latestExecution = projection.executions.at(-1)?.status;
  const highlightedOutcomes = projection.outcomes.filter((outcome) => outcome.windowSec === 120 || outcome.windowSec === 300);
  const canExecute = projection.status === "accepted" && (!latestExecution || latestExecution === "executing");

  return (
    <article className={`advice-card priority-${advice.priority}`} data-testid="advice-card">
      <header className="advice-card-header">
        <div><span className="eyebrow">规则 {advice.ruleId} · v{advice.ruleVersion}</span><h3>{advice.title}</h3></div>
        <div className="advice-badges"><span>{priorityNames[advice.priority]}优先级</span><b>{adviceStatusNames[projection.status]}</b></div>
      </header>

      <div className="advice-summary-grid">
        <div><small>问题／机会</small><p>{advice.problem}</p></div>
        <div><small>具体动作</small><p>{advice.action}</p></div>
      </div>
      <blockquote><small>主播可直接说</small>“{advice.hostMessage}”</blockquote>

      <dl className="advice-context">
        <div><dt>当前商品</dt><dd>{advice.currentProductId}</dd></div>
        <div><dt>当前主播</dt><dd>{advice.currentHostId}</dd></div>
        <div><dt>触发时间</dt><dd>{formatTime(advice.triggeredAt)}</dd></div>
        <div><dt>有效期至</dt><dd>{formatTime(advice.expiresAt)}</dd></div>
      </dl>

      <details className="evidence-details">
        <summary>查看数据、话术与限制</summary>
        <div className="evidence-grid">
          <section><h4>数据证据</h4>{advice.dataEvidence.map((evidence, index) => <div className="evidence-item" key={`${evidence.type}-${evidence.label}-${index}`}><strong>{evidence.label}{evidence.windowSec ? ` · ${evidence.windowSec} 秒` : ""}</strong><p>{evidence.summary}</p><small>当前 {formatDataEvidenceValue(evidence.value, evidence.unit)}{evidence.baseline === undefined ? "" : ` · 参考 ${formatDataEvidenceValue(evidence.baseline, evidence.unit)}`}</small></div>)}</section>
          <section><h4>相关话术证据</h4>{advice.speechEvidence.length ? advice.speechEvidence.map((evidence) => <div className="evidence-item" key={evidence.segmentId}><p>{evidence.summary}</p><small>{evidence.tags.join(" · ")}</small></div>) : <p className="muted-copy">本次未引用话术片段</p>}</section>
        </div>
        <div className="limitations"><strong>判断限制</strong><ul>{advice.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>
      </details>

      {highlightedOutcomes.length > 0 && <section className="outcome-grid" aria-label="执行后观察">{highlightedOutcomes.map((outcome) => <OutcomeCard outcome={outcome} key={`${outcome.executionId}-${outcome.windowSec}`}/>)}</section>}

      {reviewMode && <AdviceTimeline projection={projection}/>} 

      {onAction && <div className="advice-actions" aria-label={`${advice.title}操作`}>
        {projection.status === "delivered" && <button disabled={busy} onClick={() => onAction(advice.id, { kind: "feedback", type: "seen" })}>已看到</button>}
        {projection.status === "seen" && <><button className="primary" disabled={busy} onClick={() => onAction(advice.id, { kind: "feedback", type: "accepted" })}>采纳</button><button disabled={busy} onClick={() => onAction(advice.id, { kind: "feedback", type: "rejected" })}>拒绝</button></>}
        {canExecute && latestExecution !== "executing" && <button className="primary" disabled={busy} onClick={() => onAction(advice.id, { kind: "execution", status: "executing" })}>开始执行</button>}
        {canExecute && <><button disabled={busy} onClick={() => onAction(advice.id, { kind: "execution", status: "executed" })}>已执行</button><button disabled={busy} onClick={() => onAction(advice.id, { kind: "execution", status: "not_executed" })}>未执行</button></>}
        {projection.status === "accepted" && latestExecution && <button disabled={busy} onClick={() => onAction(advice.id, { kind: "confounded" })}>存在其他干扰</button>}
      </div>}
    </article>
  );
}

function AdviceTimeline({ projection }: { projection: AdviceProjection }) {
  const seen = projection.feedback.find((item) => item.type === "seen");
  const decision = projection.feedback.find((item) => item.type === "accepted" || item.type === "rejected");
  const executing = projection.executions.find((item) => item.status === "executing");
  const executed = projection.executions.find((item) => item.status === "executed");
  const milestones = [
    { label: "生成", at: projection.timeline.generatedAt },
    { label: "送达", at: projection.timeline.deliveredAt },
    { label: "看到", at: projection.timeline.seenAt, operatorId: seen?.operatorId },
    { label: decision?.type === "rejected" ? "拒绝" : "采纳", at: decision?.createdAt, operatorId: decision?.operatorId },
    { label: "开始执行", at: projection.timeline.executingAt, operatorId: executing?.operatorId },
    { label: "已执行", at: projection.timeline.executedAt, operatorId: executed?.operatorId }
  ];
  const delays = [
    ["生成→看到", projection.timeline.generatedToSeenSec],
    ["看到→采纳", projection.timeline.seenToAcceptedSec],
    ["采纳→开始执行", projection.timeline.acceptedToExecutingSec],
    ["采纳→已执行", projection.timeline.acceptedToExecutedSec]
  ] as const;
  return <section className="advice-timeline" aria-label="建议时间线">
    <h4>完整建议时间线</h4>
    <ol>{milestones.map((item) => <li key={item.label}><span>{item.label}</span><strong>{item.at ? formatTime(item.at) : "未发生"}</strong><small>{item.operatorId ? `操作人：${item.operatorId}` : "系统记录"}</small></li>)}</ol>
    <dl>{delays.map(([label, seconds]) => <div key={label}><dt>{label}</dt><dd>{seconds === undefined ? "未形成" : `${seconds.toFixed(1)} 秒`}</dd></div>)}</dl>
  </section>;
}

export function RuleStatusList({ statuses }: { statuses: RuleStatus[] }) {
  const latestByRule = new Map<string, RuleStatus>();
  for (const status of statuses) {
    const current = latestByRule.get(status.ruleId);
    if (!current || Date.parse(status.evaluatedAt) >= Date.parse(current.evaluatedAt)) latestByRule.set(status.ruleId, status);
  }
  const latest = [...latestByRule.values()].sort((left, right) => left.ruleId.localeCompare(right.ruleId)).slice(0, 8);
  return <div className="rule-status-list">{latest.length ? latest.map((status) => <article key={status.id}><span className={`rule-state ${status.status}`}>{ruleStatusNames[status.status]}</span><div><strong>{status.ruleId} · v{status.ruleVersion}</strong><p>{status.reason}</p></div><time>{formatTime(status.evaluatedAt)}</time></article>) : <div className="empty-row">等待判断数据</div>}</div>;
}
