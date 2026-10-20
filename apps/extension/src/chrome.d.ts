interface Phase2AChromeEvent<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

interface Phase2AChromeRuntime {
  onInstalled: Phase2AChromeEvent<(details: { reason: string }) => void>;
  onStartup: Phase2AChromeEvent<() => void>;
  onMessage: Phase2AChromeEvent<(
    message: unknown,
    sender: Phase2AChromeRuntimeMessageSender,
    sendResponse: (response: unknown) => void
  ) => boolean | void>;
  getURL(path: string): string;
  sendMessage<T = unknown>(message: unknown): Promise<T>;
  sendMessage<T = unknown>(message: unknown, callback: (response?: T) => void): void;
  readonly lastError?: { message?: string };
}

interface Phase2AChromeRuntimeMessageSender { tab?: Phase2AChromeTab; id?: string; }

interface Phase2AChromeStorageArea {
  get<T extends Record<string, unknown> = Record<string, unknown>>(keys?: string | string[] | null): Promise<T>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface Phase2AChromeStorageChange { newValue?: unknown; oldValue?: unknown; }
interface Phase2AChromeStorage {
  local: Phase2AChromeStorageArea;
  session: Phase2AChromeStorageArea;
  onChanged: Phase2AChromeEvent<(changes: Record<string, Phase2AChromeStorageChange>, areaName: string) => void>;
}
interface Phase2AChromeTab { id?: number; url?: string; title?: string; active?: boolean; windowId?: number; }
interface Phase2AChromeTabs {
  query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Phase2AChromeTab[]>;
  reload(tabId: number): Promise<void>;
}
interface Phase2AChromeWindows {
  create(createData: { url: string; type?: "normal" | "popup"; focused?: boolean; width?: number; height?: number }): Promise<{ id?: number }>;
}
interface Phase2AChromeSidePanel {
  setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
  open(options: { tabId?: number; windowId?: number }): Promise<void>;
}
interface Phase2AChromeDebuggee { tabId: number; }
interface Phase2AChromeDebugger {
  onEvent: Phase2AChromeEvent<(source: Phase2AChromeDebuggee, method: string, params?: Record<string, unknown>) => void>;
  onDetach: Phase2AChromeEvent<(source: Phase2AChromeDebuggee, reason: string) => void>;
  attach(target: Phase2AChromeDebuggee, requiredVersion: string): Promise<void>;
  detach(target: Phase2AChromeDebuggee): Promise<void>;
  sendCommand<T = unknown>(target: Phase2AChromeDebuggee, method: string, commandParams?: Record<string, unknown>): Promise<T>;
}
interface Phase2AChromeScripting { executeScript<T>(options: { target: { tabId: number; frameIds?: number[] }; func: (...args: never[]) => T; args?: unknown[] }): Promise<Array<{ result?: T }>>; }
interface Phase2AChromeTabCapture { getMediaStreamId(options: { targetTabId: number }): Promise<string>; }
interface Phase2AChromeOffscreen {
  hasDocument(): Promise<boolean>;
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
}
interface Phase2AChromeNamespace {
  runtime: Phase2AChromeRuntime;
  storage: Phase2AChromeStorage;
  tabs: Phase2AChromeTabs;
  windows: Phase2AChromeWindows;
  sidePanel: Phase2AChromeSidePanel;
  debugger: Phase2AChromeDebugger;
  scripting: Phase2AChromeScripting;
  tabCapture: Phase2AChromeTabCapture;
  offscreen: Phase2AChromeOffscreen;
}

declare const chrome: Phase2AChromeNamespace;
