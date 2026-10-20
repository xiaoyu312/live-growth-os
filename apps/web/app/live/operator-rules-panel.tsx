"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveLiveBackend } from "./backend-url";
import "./operator-rules.css";

export type OperatorMode = "regular" | "pulse";

export type OperatorSettings = {
  mode: OperatorMode;
  cpmTargetYuan?: number;
  retargetMaterials: string[];
  activityPlan: string;
};

export type OperatorObservationValues = {
  violationActive?: boolean;
  violationReason?: string;
  botsSuspected?: boolean;
  interactionPresent?: boolean;
  pluginAbnormal?: boolean;
  newCustomerSharePct?: number;
  oldCustomerSharePct?: number;
  bigOrders30m?: number;
};

export type OperatorObservation = {
  values: OperatorObservationValues;
  observedAt: string;
};

export type OperatorPriority = "critical" | "high" | "medium" | "low";

export type OperatorEvidence = {
  value: number;
  baseline?: number;
  unit: string;
  source: string;
  observedAt: string;
  samples: number;
  note?: string;
};

export type OperatorEvaluation = {
  ruleId: string;
  title: string;
  priority: OperatorPriority;
  state: "triggered" | "clear" | "insufficient_data";
  owner: string;
  actions: string[];
  fallback: string[];
  hypotheses: string[];
  evidence: OperatorEvidence[];
  missing: string[];
  reason: string;
};

export type OperatorPrompt = OperatorEvaluation & {
  firstDetectedAt: string;
  lastReviewedAt: string;
  nextReviewAt: string;
  recheckCount: number;
};

export type OperatorRulesView = {
  enabled: boolean;
  version: string;
  updatedAt: string;
  settings: OperatorSettings;
  observation?: OperatorObservation;
  active: OperatorPrompt[];
  coverage: OperatorEvaluation[];
};

export type OperatorRulesPanelProps = { sessionId: string };

const DEFAULT_SETTINGS: OperatorSettings = {
  mode: "regular",
  retargetMaterials: [],
  activityPlan: ""
};

const DEFAULT_OBSERVATION: OperatorObservationValues = {};
const REVIEW_NOTE = "人工信息每 10 分钟复查一次；未填写不等于 0，也不会被视为问题消失。";
export const OPERATOR_RULES_POLL_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeSettings(value: unknown): OperatorSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS, retargetMaterials: [] };
  const materials = Array.isArray(value.retargetMaterials)
    ? value.retargetMaterials.filter((item): item is string => typeof item === "string").slice(0, 2)
    : [];
  const mode: OperatorMode = value.mode === "pulse" ? "pulse" : "regular";
  const cpmTargetYuan = optionalNumber(value.cpmTargetYuan);
  return {
    mode,
    ...(cpmTargetYuan !== undefined ? { cpmTargetYuan } : {}),
    retargetMaterials: materials,
    activityPlan: stringValue(value.activityPlan)
  };
}

function normalizeObservationValues(value: unknown): OperatorObservationValues {
  if (!isRecord(value)) return {};
  const result: OperatorObservationValues = {};
  const violationActive = optionalBoolean(value.violationActive);
  const violationReason = typeof value.violationReason === "string" ? value.violationReason : undefined;
  const botsSuspected = optionalBoolean(value.botsSuspected);
  const interactionPresent = optionalBoolean(value.interactionPresent);
  const pluginAbnormal = optionalBoolean(value.pluginAbnormal);
  const newCustomerSharePct = optionalNumber(value.newCustomerSharePct);
  const oldCustomerSharePct = optionalNumber(value.oldCustomerSharePct);
  const bigOrders30m = optionalNumber(value.bigOrders30m);
  if (violationActive !== undefined) result.violationActive = violationActive;
  if (violationReason !== undefined) result.violationReason = violationReason;
  if (botsSuspected !== undefined) result.botsSuspected = botsSuspected;
  if (interactionPresent !== undefined) result.interactionPresent = interactionPresent;
  if (pluginAbnormal !== undefined) result.pluginAbnormal = pluginAbnormal;
  if (newCustomerSharePct !== undefined) result.newCustomerSharePct = newCustomerSharePct;
  if (oldCustomerSharePct !== undefined) result.oldCustomerSharePct = oldCustomerSharePct;
  if (bigOrders30m !== undefined) result.bigOrders30m = bigOrders30m;
  return result;
}

function normalizeEvidence(value: unknown): OperatorEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.value !== "number" || !Number.isFinite(item.value) || typeof item.unit !== "string" || typeof item.source !== "string" || typeof item.observedAt !== "string" || typeof item.samples !== "number") return [];
    const baseline = optionalNumber(item.baseline);
    return [{
      value: item.value,
      ...(baseline !== undefined ? { baseline } : {}),
      unit: item.unit,
      source: item.source,
      observedAt: item.observedAt,
      samples: item.samples,
      ...(typeof item.note === "string" ? { note: item.note } : {})
    }];
  });
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeEvaluation(value: unknown): OperatorEvaluation | null {
  if (!isRecord(value) || typeof value.ruleId !== "string" || typeof value.title !== "string" || typeof value.owner !== "string" || typeof value.reason !== "string") return null;
  const state = value.state === "triggered" || value.state === "clear" || value.state === "insufficient_data" ? value.state : "insufficient_data";
  return {
    ruleId: value.ruleId,
    title: value.title,
    priority: value.priority === "critical" || value.priority === "high" || value.priority === "medium" || value.priority === "low" ? value.priority : "low",
    state,
    owner: value.owner,
    actions: normalizeStringList(value.actions),
    fallback: normalizeStringList(value.fallback),
    hypotheses: normalizeStringList(value.hypotheses),
    evidence: normalizeEvidence(value.evidence),
    missing: normalizeStringList(value.missing),
    reason: value.reason
  };
}

function normalizePrompt(value: unknown): OperatorPrompt | null {
  const evaluation = normalizeEvaluation(value);
  if (!evaluation || !isRecord(value)) return null;
  return {
    ...evaluation,
    firstDetectedAt: stringValue(value.firstDetectedAt),
    lastReviewedAt: stringValue(value.lastReviewedAt),
    nextReviewAt: stringValue(value.nextReviewAt),
    recheckCount: typeof value.recheckCount === "number" ? value.recheckCount : 0
  };
}

export function normalizeOperatorRulesView(value: unknown): OperatorRulesView | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean") return null;
  const observation = isRecord(value.observation) && typeof value.observation.observedAt === "string"
    ? { values: normalizeObservationValues(value.observation.values), observedAt: value.observation.observedAt }
    : undefined;
  return {
    enabled: value.enabled,
    version: stringValue(value.version, "unknown"),
    updatedAt: stringValue(value.updatedAt),
    settings: normalizeSettings(value.settings),
    ...(observation ? { observation } : {}),
    active: Array.isArray(value.active) ? value.active.flatMap((item) => { const prompt = normalizePrompt(item); return prompt ? [prompt] : []; }) : [],
    coverage: Array.isArray(value.coverage) ? value.coverage.flatMap((item) => { const evaluation = normalizeEvaluation(item); return evaluation ? [evaluation] : []; }) : []
  };
}

export function operatorRulesUrl(api: string, sessionId: string, suffix = ""): string {
  return `${api}/api/live/sessions/${encodeURIComponent(sessionId)}/operator-rules${suffix}`;
}

export function buildOperatorPostRequest(api: string, sessionId: string, suffix: string, body: unknown): { url: string; init: RequestInit } {
  return {
    url: `${api}/api/live/sessions/${encodeURIComponent(sessionId)}${suffix}`,
    init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  };
}

/** Keep optional numeric fields absent when an operator leaves them unconfirmed. */
export function buildOperatorSettingsPayload(settings: OperatorSettings): OperatorSettings {
  const cpm = typeof settings.cpmTargetYuan === "number" && Number.isFinite(settings.cpmTargetYuan) ? settings.cpmTargetYuan : undefined;
  const materials = settings.retargetMaterials.map((item) => item.trim()).filter(Boolean).slice(0, 2);
  return {
    mode: settings.mode,
    ...(cpm !== undefined ? { cpmTargetYuan: cpm } : {}),
    retargetMaterials: materials,
    activityPlan: settings.activityPlan.trim()
  };
}

export function buildOperatorObservationPayload(values: OperatorObservationValues): OperatorObservationValues {
  const normalized = normalizeObservationValues(values);
  for (const value of [normalized.newCustomerSharePct, normalized.oldCustomerSharePct]) if (value !== undefined && (value < 0 || value > 100)) throw new Error("新老客占比必须在 0 到 100 之间");
  if ((normalized.newCustomerSharePct ?? 0) + (normalized.oldCustomerSharePct ?? 0) > 100) throw new Error("新老客占比合计不能超过 100%");
  if (normalized.bigOrders30m !== undefined && (!Number.isInteger(normalized.bigOrders30m) || normalized.bigOrders30m < 0)) throw new Error("大单笔数必须是非负整数");
  if (normalized.violationReason !== undefined) {
    normalized.violationReason = normalized.violationReason.trim();
    if (normalized.violationReason === "") delete (normalized as Record<string, unknown>).violationReason;
  }
  return normalized;
}

export function activeOperatorPrompts(view: OperatorRulesView): OperatorPrompt[] {
  const priorityOrder: Record<OperatorPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return view.active
    .filter((item) => item.state === "triggered" || (item.state === "insufficient_data" && (item.firstDetectedAt !== "" || item.recheckCount > 0)))
    .sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority]);
}

export function operatorPriorityLabel(priority: OperatorPriority): string {
  return { critical: "最高", high: "高", medium: "中", low: "低" }[priority];
}

export function operatorModeLabel(mode: OperatorMode): string {
  return mode === "pulse" ? "脉冲场" : "常规场";
}

export function operatorPromptNeedsReview(prompt: OperatorPrompt): boolean {
  return prompt.state === "insufficient_data";
}

function displayTime(value: string | undefined): string {
  if (!value) return "待记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "待记录";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function displayEvidence(evidence: OperatorEvidence): string {
  const value = Number.isInteger(evidence.value) ? String(evidence.value) : evidence.value.toFixed(2);
  const baseline = evidence.baseline !== undefined ? ` · 本场基线 ${Number.isInteger(evidence.baseline) ? evidence.baseline : evidence.baseline.toFixed(2)}${evidence.unit}` : "";
  return `${value}${evidence.unit}${baseline}`;
}

function triStateValue(value: boolean | undefined): string {
  return value === undefined ? "unknown" : value ? "yes" : "no";
}

function fromTriState(value: string): boolean | undefined {
  return value === "yes" ? true : value === "no" ? false : undefined;
}

function inputNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function updateSettingsCpm(current: OperatorSettings, rawValue: string): OperatorSettings {
  const next: Record<string, unknown> = { ...current };
  if (rawValue === "") delete next.cpmTargetYuan;
  else {
    const value = Number(rawValue);
    if (Number.isFinite(value)) next.cpmTargetYuan = value;
  }
  return next as OperatorSettings;
}

function updateObservationField(current: OperatorObservationValues, key: keyof OperatorObservationValues, value: unknown): OperatorObservationValues {
  const next: Record<string, unknown> = { ...current };
  if (value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next as OperatorObservationValues;
}

type RequestState = "idle" | "pending" | "success" | "error";

export default function OperatorRulesPanel({ sessionId }: OperatorRulesPanelProps) {
  const [view, setView] = useState<OperatorRulesView | null>(null);
  const [settings, setSettings] = useState<OperatorSettings>(DEFAULT_SETTINGS);
  const [observation, setObservation] = useState<OperatorObservationValues>(DEFAULT_OBSERVATION);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [observationOpen, setObservationOpen] = useState(false);
  const [settingsState, setSettingsState] = useState<RequestState>("idle");
  const [observationState, setObservationState] = useState<RequestState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [showCoverage, setShowCoverage] = useState(false);
  const settingsDirty = useRef(false);
  const observationDirty = useRef(false);
  const requestGeneration = useRef(0);
  const mounted = useRef(true);

  const backendApi = useCallback(() => {
    if (typeof window === "undefined") return resolveLiveBackend({ protocol: "http:", hostname: "127.0.0.1" }).api;
    return resolveLiveBackend(window.location).api;
  }, []);

  const applyView = useCallback((next: OperatorRulesView) => {
    if (!mounted.current) return;
    setView(next);
    if (!settingsDirty.current) setSettings(next.settings);
    if (!observationDirty.current) setObservation(next.observation?.values ?? {});
  }, []);

  const refresh = useCallback(async (signal: AbortSignal, generation: number) => {
    const response = await fetch(operatorRulesUrl(backendApi(), sessionId), { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`读取实时规则失败（HTTP ${response.status}）`);
    const parsed = normalizeOperatorRulesView(await response.json() as unknown);
    if (!parsed) throw new Error("实时规则返回格式无法识别");
    if (generation !== requestGeneration.current) return;
    applyView(parsed);
  }, [applyView, backendApi, sessionId]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let pollInFlight = false;
    const run = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      const generation = requestGeneration.current;
      try {
        await refresh(controller.signal, generation);
        if (mounted.current && generation === requestGeneration.current) setError(null);
      } catch (cause) {
        if (!mounted.current || controller.signal.aborted || generation !== requestGeneration.current) return;
        setError(cause instanceof Error ? cause.message : "读取实时规则失败，请重试。");
      } finally {
        pollInFlight = false;
      }
    };
    void run();
    const timer = window.setInterval(() => { void run(); }, OPERATOR_RULES_POLL_MS);
    return () => {
      mounted.current = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const post = useCallback(async (suffix: string, body: unknown): Promise<OperatorRulesView> => {
    requestGeneration.current += 1;
    const request = buildOperatorPostRequest(backendApi(), sessionId, suffix, body);
    const response = await fetch(request.url, request.init);
    if (!response.ok) throw new Error(`保存失败（HTTP ${response.status}）`);
    const parsed = normalizeOperatorRulesView(await response.json() as unknown);
    if (!parsed) throw new Error("保存结果格式无法识别");
    return parsed;
  }, [backendApi, sessionId]);

  const saveSettings = async () => {
    setSettingsState("pending");
    setError(null);
    try {
      const next = await post("/operator-settings", buildOperatorSettingsPayload(settings));
      settingsDirty.current = false;
      applyView(next);
      setSettingsState("success");
    } catch (cause) {
      setSettingsState("error");
      setError(cause instanceof Error ? cause.message : "保存设置失败，请重试。");
    }
  };

  const saveObservation = async () => {
    setObservationState("pending");
    setError(null);
    try {
      const next = await post("/operator-observation", buildOperatorObservationPayload(observation));
      observationDirty.current = false;
      applyView(next);
      setObservationState("success");
    } catch (cause) {
      setObservationState("error");
      setError(cause instanceof Error ? cause.message : "保存人工观测失败，请重试。");
    }
  };

  const sortedActive = useMemo(() => view ? activeOperatorPrompts(view) : [], [view]);
  const primary = sortedActive[0];
  const otherActive = sortedActive.slice(1);
  const coverageMissing = view?.coverage.filter((item) => item.state === "insufficient_data" || item.missing.length > 0) ?? [];
  const coverageAvailability = view && view.coverage.length === 0
    ? "暂未返回覆盖明细，等待自动来源"
    : coverageMissing.length
      ? `${coverageMissing.length} 条等待字段／目标`
      : "当前没有字段缺口";
  const materialSlots = [settings.retargetMaterials[0] ?? "", settings.retargetMaterials[1] ?? ""];

  if (!view) {
    return error ? <section className="operator-rules-panel operator-rules-panel-error" aria-label="运营实时规则"><div className="operator-rules-error" role="alert">{error}</div></section> : null;
  }
  if (!view.enabled) return null;

  return (
    <section className="operator-rules-panel" aria-label="运营实时规则">
      <div className="operator-rules-heading">
        <div className="operator-rules-title-row">
          <h2>现场判断与下一步</h2>
          <span className="operator-rules-mode-chip">{operatorModeLabel(view.settings.mode)}</span>
        </div>
        <div className="operator-rules-meta">
          <span>每 10 分钟复查</span>
          <span>更新 {displayTime(view.updatedAt)}</span>
        </div>
      </div>

      {error && <div className="operator-rules-error" role="alert">{error}</div>}

      <div className="operator-rules-availability" role="status">
        <strong>数据可用性</strong>
        <span>{view.coverage.length - coverageMissing.length} 项具备判断条件 · {coverageAvailability}</span>
      </div>

      {!primary && coverageMissing.length > 0 && <p className="operator-rules-data-gap-note">当前没有待处理问题；仍有字段或目标缺口，规则不会据此判断问题已改善。</p>}

      {primary && <section className="operator-rules-active" aria-label="当前待处理问题">
        <div className={`operator-rules-active-kicker${operatorPromptNeedsReview(primary) ? " is-data-gap" : ""}`}><span>{operatorPromptNeedsReview(primary) ? "待数据复查" : "当前待处理"}</span><small>问题持续就继续显示，不设置停止时间</small></div>
        <article className={`operator-rules-primary-card${operatorPromptNeedsReview(primary) ? " is-data-gap" : ""}`}>
          <div className={`operator-rules-card-title${operatorPromptNeedsReview(primary) ? " is-data-gap" : ""}`}><div><span className="operator-rules-priority">{operatorPriorityLabel(primary.priority)}</span><h3>{primary.title}</h3></div><span className="operator-rules-review">下次复查 {displayTime(primary.nextReviewAt)} · 第 {primary.recheckCount} 次复查</span></div>
          <div className="operator-rules-action-line"><strong>{operatorPromptNeedsReview(primary) ? "待数据复查" : "首要动作"}</strong><p>{operatorPromptNeedsReview(primary) ? (primary.actions[0] ?? "数据暂时不足，10 分钟后复查；不据此判断问题已改善。") : (primary.actions[0] ?? "先补齐现场信息，再由负责人判断动作。")}</p></div>
          <dl className="operator-rules-owner"><div><dt>负责人</dt><dd>{primary.owner}</dd></div><div><dt>最近复查</dt><dd>{displayTime(primary.lastReviewedAt)}</dd></div></dl>
          {primary.evidence.length > 0 && <div className="operator-rules-block"><strong>事实证据</strong><ul>{primary.evidence.map((item, index) => <li key={`${item.source}-${item.observedAt}-${index}`}><span>{displayEvidence(item)}</span><small>{item.source} · {item.samples} 个样本{item.note ? ` · ${item.note}` : ""}</small></li>)}</ul></div>}
          {primary.hypotheses.length > 0 && <div className="operator-rules-block operator-rules-hypotheses"><strong>待排查原因</strong><ul>{primary.hypotheses.map((item) => <li key={item}>{item}</li>)}</ul></div>}
          {primary.fallback.length > 0 && <div className="operator-rules-block"><strong>复查后仍有问题时</strong><ul>{primary.fallback.map((item) => <li key={item}>{item}</li>)}</ul></div>}
        </article>
        {otherActive.length > 0 && <details className="operator-rules-other"><summary>同时成立的其他问题 · {otherActive.length}</summary><div>{otherActive.map((item) => <article key={item.ruleId}><strong>{item.title}</strong><span>{item.owner}</span><p>{item.actions[0] ?? item.reason}</p><small>下次复查 {displayTime(item.nextReviewAt)}</small></article>)}</div></details>}
      </section>}

      <details className="operator-rules-fold operator-rules-coverage" open={showCoverage} onToggle={(event) => setShowCoverage(event.currentTarget.open)}>
        <summary><span>规则覆盖与缺口</span><small>{coverageAvailability}</small></summary>
        <div className="operator-rules-coverage-list">{view.coverage.length === 0 ? <p>暂未返回覆盖明细。</p> : view.coverage.map((item) => <article key={item.ruleId} className={item.state === "insufficient_data" || item.missing.length ? "is-missing" : ""}><div><strong>{item.title}</strong><span>{item.state === "insufficient_data" ? "数据不足" : item.state === "triggered" ? "已触发" : "正常"}</span></div>{item.missing.length > 0 && <p>缺少：{item.missing.join("、")}</p>}{item.reason && <small>{item.reason}</small>}</article>)}</div>
      </details>

      <details className="operator-rules-fold" open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
        <summary><span>场景与投放设置</span><small>仅保存后才更新确认时间</small></summary>
        <div className="operator-rules-form">
          <fieldset>
            <legend>当前场景</legend>
            <div className="operator-rules-choice-row">
              <label className={settings.mode === "regular" ? "is-selected" : ""}><input type="radio" name={`mode-${sessionId}`} checked={settings.mode === "regular"} onChange={() => { settingsDirty.current = true; setSettings((current) => ({ ...current, mode: "regular" })); }} />常规场</label>
              <label className={settings.mode === "pulse" ? "is-selected" : ""}><input type="radio" name={`mode-${sessionId}`} checked={settings.mode === "pulse"} onChange={() => { settingsDirty.current = true; setSettings((current) => ({ ...current, mode: "pulse" })); }} />脉冲场</label>
            </div>
          </fieldset>
          <label className="operator-rules-field">CPM 目标（元 / 千次曝光）
            <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="可留空，未确认不等于 0" value={inputNumber(settings.cpmTargetYuan)} onChange={(event) => { settingsDirty.current = true; setSettings((current) => updateSettingsCpm(current, event.target.value.trim())); }} />
          </label>
          <fieldset>
            <legend>追投候选（最多 2 条，仅作记录）</legend>
            {materialSlots.map((value, index) => <input key={index} type="text" placeholder={`素材 ${index + 1} 名称或标识`} value={value} onChange={(event) => { settingsDirty.current = true; setSettings((current) => { const next = [...current.retargetMaterials]; next[index] = event.target.value; return { ...current, retargetMaterials: next.slice(0, 2) }; }); }} />)}
          </fieldset>
          <label className="operator-rules-field">活动方案／可用福利
            <textarea rows={2} placeholder="填写现场实际可用的活动或商品方案；未配置时提示负责人确认" value={settings.activityPlan} onChange={(event) => { settingsDirty.current = true; setSettings((current) => ({ ...current, activityPlan: event.target.value })); }} />
          </label>
          {(settings.activityPlan.trim() === "" || materialSlots.every((item) => item.trim() === "")) && <p className="operator-rules-config-note">活动或追投素材尚未配置；需要动作时请先由负责人确认实际可用方案。</p>}
          <div className="operator-rules-actions"><button type="button" className="operator-rules-primary" disabled={settingsState === "pending"} onClick={() => void saveSettings()}>{settingsState === "pending" ? "保存中…" : "保存设置"}</button>{settingsState === "success" && <span className="operator-rules-saved">已保存</span>}</div>
        </div>
      </details>

      <details className="operator-rules-fold" open={observationOpen} onToggle={(event) => setObservationOpen(event.currentTarget.open)}>
        <summary><span>现场人工确认</span><small>当前暂无自动来源；只确认确实看到的现象</small></summary>
        <div className="operator-rules-form">
          <div className="operator-rules-note" role="note">
            <strong>人工信息只作现场确认</strong>
            <span>{REVIEW_NOTE}</span>
          </div>
          <p className="operator-rules-manual-note">{view.observation ? `最近确认 ${displayTime(view.observation.observedAt)}。` : "尚未确认。"} 未填写不算 0，清除后保存才会回到未确认。</p>
          <div className="operator-rules-grid">
            <label className="operator-rules-field">违规提醒
              <select value={triStateValue(observation.violationActive)} onChange={(event) => { observationDirty.current = true; setObservation((current) => updateObservationField(current, "violationActive", fromTriState(event.target.value))); }}><option value="unknown">未确认</option><option value="yes">有</option><option value="no">无</option></select>
            </label>
            <label className="operator-rules-field">违规原因（仅人工填写）<input type="text" placeholder="未确认可留空" value={observation.violationReason ?? ""} onChange={(event) => { observationDirty.current = true; setObservation((current) => ({ ...current, violationReason: event.target.value })); }} /></label>
            <label className="operator-rules-field">疑似异常账号
              <select value={triStateValue(observation.botsSuspected)} onChange={(event) => { observationDirty.current = true; setObservation((current) => updateObservationField(current, "botsSuspected", fromTriState(event.target.value))); }}><option value="unknown">未确认</option><option value="yes">有</option><option value="no">无</option></select>
            </label>
            <label className="operator-rules-field">是否有真实互动
              <select value={triStateValue(observation.interactionPresent)} onChange={(event) => { observationDirty.current = true; setObservation((current) => updateObservationField(current, "interactionPresent", fromTriState(event.target.value))); }}><option value="unknown">未确认</option><option value="yes">有</option><option value="no">无</option></select>
            </label>
            <label className="operator-rules-field">购物车插件异常
              <select value={triStateValue(observation.pluginAbnormal)} onChange={(event) => { observationDirty.current = true; setObservation((current) => updateObservationField(current, "pluginAbnormal", fromTriState(event.target.value))); }}><option value="unknown">未确认</option><option value="yes">有</option><option value="no">无</option></select>
            </label>
            <label className="operator-rules-field">新客占比（%）<input type="number" min="0" max="100" step="1" placeholder="未确认" value={inputNumber(observation.newCustomerSharePct)} onChange={(event) => { observationDirty.current = true; const value = event.target.value.trim(); setObservation((current) => updateObservationField(current, "newCustomerSharePct", value === "" ? undefined : Number(value))); }} /></label>
            <label className="operator-rules-field">老客占比（%）<input type="number" min="0" max="100" step="1" placeholder="未确认" value={inputNumber(observation.oldCustomerSharePct)} onChange={(event) => { observationDirty.current = true; const value = event.target.value.trim(); setObservation((current) => updateObservationField(current, "oldCustomerSharePct", value === "" ? undefined : Number(value))); }} /></label>
            <label className="operator-rules-field">过去 30 分钟大单笔数 <span className="operator-rules-help">每笔 &gt; 1500 元</span><input type="number" min="0" step="1" placeholder="未确认" value={inputNumber(observation.bigOrders30m)} onChange={(event) => { observationDirty.current = true; const value = event.target.value.trim(); setObservation((current) => updateObservationField(current, "bigOrders30m", value === "" ? undefined : Number(value))); }} /></label>
          </div>
          <div className="operator-rules-actions"><button type="button" className="operator-rules-primary" disabled={observationState === "pending"} onClick={() => void saveObservation()}>{observationState === "pending" ? "保存中…" : "保存人工观测"}</button>{observationState === "success" && <span className="operator-rules-saved">已记录本次确认时间</span>}</div>
        </div>
      </details>

    </section>
  );
}
