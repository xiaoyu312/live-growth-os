import type { AllowedRouteId, PageAccess, DomFieldCandidate, LiveCompassMetricInput } from "./types.js";

export type DomMetricSnapshot = {
  semanticCode: "onlineSnapshot" | "roomEnterCount5m" | "userPaidGmvFen5m" | "productClickCount" | "productPayGmvFen" | "unpaidOrderCount";
  value: number;
  unit: "count" | "yuan";
};

type DomMetricUnit = DomMetricSnapshot["unit"];
export type BoundedDomMetricCandidate = { scope: string; text: string };

const COMPASS_DOM_LABELS: Record<string, DomMetricSnapshot["semanticCode"]> = {
  "实时在线人数": "onlineSnapshot",
  "在线人数": "onlineSnapshot",
  "近5分钟用户支付金额": "userPaidGmvFen5m",
  "近5分钟商品点击次数": "productClickCount",
  "近5分钟进入人数": "roomEnterCount5m",
  "未支付订单数": "unpaidOrderCount",
  "商品支付金额": "productPayGmvFen",
  "累计用户支付金额": "productPayGmvFen",
  "当前商品支付金额": "productPayGmvFen"
};

function parseDomNumber(value: string, semanticCode: DomMetricSnapshot["semanticCode"]): { value: number; unit: DomMetricUnit } | undefined {
  const money = /[¥￥元]/.test(value);
  const isMoneyMetric = semanticCode === "userPaidGmvFen5m" || semanticCode === "productPayGmvFen";
  if (isMoneyMetric && !money) return undefined;
  if (!isMoneyMetric && money) return undefined;
  const normalized = value.replace(/[¥￥,\s]/g, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)(?:元|分|人|次)?$/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000 ? { value: parsed, unit: money ? "yuan" : "count" } : undefined;
}

function looksNumericDomValue(value: string): boolean {
  return /^[$¥￥]?\s*\d[\d,.]*(?:\.\d+)?\s*(?:%|元|分|人|次)?$/.test(value.trim());
}

/**
 * Select one numeric value only when a bounded DOM scope has exactly one
 * unambiguous candidate. Multiple values in one card, or values from more
 * than one card sharing an ancestor, remain unknown instead of being mixed.
 */
export function selectMetricValue(label: string, boundedCandidates: readonly BoundedDomMetricCandidate[]): { value: number; unit: DomMetricUnit } | undefined {
  if (!Object.hasOwn(COMPASS_DOM_LABELS, label)) return undefined;
  const scopes = new Map<string, Array<{ value: number; unit: DomMetricUnit } | undefined>>();
  for (const candidate of boundedCandidates) {
    if (!looksNumericDomValue(candidate.text)) continue;
    const parsed = parseDomNumber(candidate.text, COMPASS_DOM_LABELS[label]!);
    const values = scopes.get(candidate.scope) ?? [];
    values.push(parsed);
    scopes.set(candidate.scope, values);
  }
  if (scopes.size !== 1) return undefined;
  const values = [...scopes.values()][0] ?? [];
  return values.length === 1 ? values[0] : undefined;
}

const COMPASS_DOM_METRIC_ENDPOINT = "/dom/fallback";
export { COMPASS_DOM_METRIC_ENDPOINT };

export function mapCompassDomMetricSnapshots(snapshots: DomMetricSnapshot[], observedAt: string): LiveCompassMetricInput | null {
  const output: LiveCompassMetricInput = { observedAt, sourceEndpoint: COMPASS_DOM_METRIC_ENDPOINT, mappingVersion: "compass-live-v1", dataStatus: "fresh" };
  const seen = new Set<DomMetricSnapshot["semanticCode"]>();
  const ambiguous = new Set<DomMetricSnapshot["semanticCode"]>();
  for (const snapshot of snapshots) {
    if (ambiguous.has(snapshot.semanticCode)) continue;
    const moneyMetric = snapshot.semanticCode === "userPaidGmvFen5m" || snapshot.semanticCode === "productPayGmvFen";
    if ((moneyMetric && snapshot.unit !== "yuan") || (!moneyMetric && snapshot.unit !== "count")) continue;
    if (seen.has(snapshot.semanticCode)) {
      ambiguous.add(snapshot.semanticCode);
      delete output[metricFieldForSemantic(snapshot.semanticCode)];
      continue;
    }
    const value = snapshot.unit === "yuan" ? Math.round(snapshot.value * 100) : Math.round(snapshot.value);
    const field = metricFieldForSemantic(snapshot.semanticCode);
    (output as unknown as Record<string, unknown>)[field] = value;
    seen.add(snapshot.semanticCode);
  }
  return Object.keys(output).length > 4 ? output : null;
}

function metricFieldForSemantic(semanticCode: DomMetricSnapshot["semanticCode"]): keyof LiveCompassMetricInput {
  if (semanticCode === "onlineSnapshot") return "onlineSnapshot";
  if (semanticCode === "roomEnterCount5m") return "roomEnterCount5m";
  if (semanticCode === "userPaidGmvFen5m") return "userPaidGmvFen5m";
  if (semanticCode === "productClickCount") return "productClickCount";
  if (semanticCode === "productPayGmvFen") return "productPayGmvFen";
  return "unpaidOrderCount";
}

export function domFallbackAllowed(access: Pick<PageAccess, "status" | "routeId">, cdpShapeCount: number, sessionRouteId: AllowedRouteId | null): boolean {
  // DOM is a Compass-only last resort. Qianchuan metrics must come from the
  // confirmed network response contract; never turn a Qianchuan page value
  // into a live metric through this fallback.
  return access.status === "allowed"
    && access.routeId === "compass-live-shop"
    && sessionRouteId === "compass-live-shop"
    && cdpShapeCount === 0;
}

/** Executed in the authorized page; it reads structure only, never textContent or values. */
export function collectDomFieldCandidates(): DomFieldCandidate[] {
  const stableSelectorInPage = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    let depth = 0;
    while (current && current.parentElement && depth < 5) {
      const tag = current.tagName.toLowerCase();
      const tagName = current.tagName;
      const siblings = Array.from(current.parentElement.children).filter((child) => child.tagName === tagName);
      const index = Math.max(0, siblings.indexOf(current) + 1);
      parts.unshift(`${tag}:nth-of-type(${index})`);
      current = current.parentElement;
      depth += 1;
    }
    return parts.join(">");
  };
  const valueTypeInPage = (element: Element): string => {
    if (element instanceof HTMLInputElement) return `input:${element.type || "text"}`;
    if (element instanceof HTMLSelectElement) return "select";
    if (element instanceof HTMLTextAreaElement) return "textarea";
    if (element.getAttribute("role")) return `role:${element.getAttribute("role")}`;
    return element.tagName.toLowerCase();
  };
  const metricLabelInPage = (value: string): boolean => /^(?:直播间)?(?:在线人数|进入人数|点击人数|曝光人数|支付人数|成交人数|消耗|GMV|ROI|GPM|CTR|CVR|转化率)$/i.test(value.replace(/\s+/g, " ").trim());
  const elements = Array.from(document.querySelectorAll("input,select,textarea,[role=button],[role=tab],[role=grid],[role=table]"));
  return elements.slice(0, 120).map((element) => {
    const ariaLabel = element.getAttribute("aria-label");
    return {
      label: ariaLabel && metricLabelInPage(ariaLabel) ? ariaLabel.slice(0, 80) : element.tagName.toLowerCase(),
      selector: stableSelectorInPage(element),
      valueType: valueTypeInPage(element)
    };
  });
}

/**
 * Executed only in the allowlisted Compass page. It returns bounded numeric
 * KPI snapshots, never arbitrary page text, comments, user profiles or DOM
 * markup. The caller immediately maps these values to a live metric event.
 */
export function collectCompassDomMetricSnapshots(): DomMetricSnapshot[] {
  // `chrome.scripting.executeScript` serializes only this function, so keep
  // the page-side label and number parsing self-contained.
  const labels: Record<string, DomMetricSnapshot["semanticCode"]> = {
    "实时在线人数": "onlineSnapshot",
    "在线人数": "onlineSnapshot",
    "近5分钟用户支付金额": "userPaidGmvFen5m",
    "近5分钟商品点击次数": "productClickCount",
    "近5分钟进入人数": "roomEnterCount5m",
    "未支付订单数": "unpaidOrderCount",
    "商品支付金额": "productPayGmvFen",
    "累计用户支付金额": "productPayGmvFen",
    "当前商品支付金额": "productPayGmvFen"
  };
  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
  const parseNumber = (value: string, semanticCode: DomMetricSnapshot["semanticCode"]): { value: number; unit: DomMetricSnapshot["unit"] } | undefined => {
    const money = /[¥￥元]/.test(value);
    const isMoneyMetric = semanticCode === "userPaidGmvFen5m" || semanticCode === "productPayGmvFen";
    if (isMoneyMetric && !money) return undefined;
    if (!isMoneyMetric && money) return undefined;
    const normalized = value.replace(/[¥￥,\s]/g, "");
    const match = normalized.match(/^(\d+(?:\.\d+)?)(?:元|分|人|次)?$/);
    if (!match) return undefined;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000 ? { value: parsed, unit: money ? "yuan" : "count" } : undefined;
  };
  const looksNumeric = (value: string): boolean => /^[$¥￥]?\s*\d[\d,.]*(?:\.\d+)?\s*(?:%|元|分|人|次)?$/.test(value.trim());
  const hasOtherConfirmedLabel = (scope: Element, current: Element): boolean => {
    const pending: Element[] = [scope];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node !== current && node.children.length === 0 && Object.hasOwn(labels, normalize(node.textContent ?? ""))) return true;
      for (const child of Array.from(node.children)) pending.push(child);
    }
    return false;
  };
  const selectBounded = (label: string, candidates: readonly { scope: string; text: string }[]): { value: number; unit: DomMetricSnapshot["unit"] } | undefined => {
    if (!Object.hasOwn(labels, label)) return undefined;
    const scopes = new Map<string, Array<{ value: number; unit: DomMetricSnapshot["unit"] } | undefined>>();
    for (const candidate of candidates) {
      if (!looksNumeric(candidate.text)) continue;
      const parsed = parseNumber(candidate.text, labels[label]!);
      const values = scopes.get(candidate.scope) ?? [];
      values.push(parsed);
      scopes.set(candidate.scope, values);
    }
    if (scopes.size !== 1) return undefined;
    const values = [...scopes.values()][0] ?? [];
    return values.length === 1 ? values[0] : undefined;
  };
  const snapshots = new Map<DomMetricSnapshot["semanticCode"], Omit<DomMetricSnapshot, "semanticCode">>();
  const ambiguous = new Set<DomMetricSnapshot["semanticCode"]>();
  for (const element of Array.from(document.querySelectorAll("*"))) {
    if (element.children.length > 0) continue;
    const labelText = normalize(element.textContent ?? "");
    const label = labels[labelText];
    if (!label) continue;
    let ancestor = element.parentElement;
    let value: { value: number; unit: DomMetricSnapshot["unit"] } | undefined;
    let depth = 0;
    while (ancestor && depth < 6 && value === undefined) {
      // A broad grid/container must not lend a neighboring KPI's value to this
      // label. Keep only a parent whose subtree contains this confirmed label.
      if (!hasOtherConfirmedLabel(ancestor, element)) {
        // Only inspect siblings in the smallest label card. Never climb to a
        // shared parent, where a neighboring KPI could be mistaken for this one.
        let labelBranch: Element = element;
        while (labelBranch.parentElement && labelBranch.parentElement !== ancestor) labelBranch = labelBranch.parentElement;
        const candidates = Array.from(ancestor.children)
          .filter((child) => child !== labelBranch)
          .flatMap((child) => child.children.length === 0 ? [child] : [child, ...Array.from(child.querySelectorAll("*"))]);
        const numericCandidates = candidates
          .filter((node) => node.children.length === 0 && looksNumeric(normalize(node.textContent ?? "")));
        value = selectBounded(labelText, numericCandidates.map((candidate) => ({ scope: "bounded-card", text: normalize(candidate.textContent ?? "") })));
      }
      ancestor = ancestor.parentElement;
      depth += 1;
    }
    if (value !== undefined) {
      if (ambiguous.has(label)) continue;
      if (snapshots.has(label)) {
        snapshots.delete(label);
        ambiguous.add(label);
        continue;
      }
      snapshots.set(label, value);
    }
  }
  return [...snapshots.entries()].map(([semanticCode, snapshot]) => ({ semanticCode, ...snapshot }));
}
