export interface DebuggerSetupOperations {
  attach(): Promise<void>;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<void>;
  detach(): Promise<void>;
}

const ENABLE_COMMANDS: Array<[string, Record<string, unknown>?]> = [
  ["Network.enable"],
  ["Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }],
  ["Page.enable"],
  ["Runtime.enable"]
];

export async function attachDebuggerWithCleanup(operations: DebuggerSetupOperations): Promise<void> {
  let attached = false;
  try {
    await operations.attach();
    attached = true;
    for (const [method, params] of ENABLE_COMMANDS) await operations.sendCommand(method, params);
  } catch (error) {
    if (attached) {
      try { await operations.detach(); } catch { /* cleanup is best effort; original setup error wins */ }
    }
    throw error;
  }
}
