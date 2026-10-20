export type PageRuntimeFlags = {
  visibilityState: "visible" | "hidden" | "prerender";
  hasFocus: boolean;
  navigatorOnline: boolean;
};

function readVisibilityState(value: string): PageRuntimeFlags["visibilityState"] {
  if (value === "hidden") return "hidden";
  if (value === "prerender") return "prerender";
  return "visible";
}

export function collectPageRuntimeFlags(): PageRuntimeFlags {
  return {
    visibilityState: readVisibilityState(document.visibilityState),
    hasFocus: document.hasFocus(),
    navigatorOnline: navigator.onLine === true
  };
}

export function sanitizePageRuntimeFlags(value: unknown): PageRuntimeFlags | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const visibilityState = record.visibilityState === "hidden" || record.visibilityState === "prerender" ? record.visibilityState : record.visibilityState === "visible" ? "visible" : null;
  if (!visibilityState || typeof record.hasFocus !== "boolean" || typeof record.navigatorOnline !== "boolean") return null;
  return {
    visibilityState,
    hasFocus: record.hasFocus,
    navigatorOnline: record.navigatorOnline
  };
}

export function assemblePageRuntime(input: {
  source: "qianchuan" | "compass";
  flags: PageRuntimeFlags;
  debuggerAttached: boolean;
  allowlistStatus: "allowed" | "login" | "blocked";
  topFrameLifecycle: "live" | "loading" | "stopped";
  observedAt: string;
  lastNavigationAt?: string;
}): {
  source: "qianchuan" | "compass";
  observedAt: string;
  visibilityState: "visible" | "hidden" | "prerender";
  hasFocus: boolean;
  navigatorOnline: boolean;
  debuggerAttached: boolean;
  allowlistStatus: "allowed" | "login" | "blocked";
  topFrameLifecycle: "live" | "loading" | "stopped";
  lastNavigationAt?: string;
} {
  return {
    source: input.source,
    observedAt: input.observedAt,
    visibilityState: input.flags.visibilityState,
    hasFocus: input.flags.hasFocus,
    navigatorOnline: input.flags.navigatorOnline,
    debuggerAttached: input.debuggerAttached,
    allowlistStatus: input.allowlistStatus,
    topFrameLifecycle: input.topFrameLifecycle,
    ...(input.lastNavigationAt ? { lastNavigationAt: input.lastNavigationAt } : {})
  };
}

const FORBIDDEN_RUNTIME_KEYS = new Set(["tabid", "title", "query", "url", "href", "cookie", "authorization", "pairtoken", "innerhtml", "outerhtml"]);

export function pageRuntimeExportHasSecrets(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(pageRuntimeExportHasSecrets);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_RUNTIME_KEYS.has(key.toLowerCase()) || pageRuntimeExportHasSecrets(child));
}
