type RuntimeResponseLike = { ok: boolean; error?: string };
type SendMessage = (message: unknown, callback: (response?: RuntimeResponseLike) => void) => void;
type LastErrorReader = () => { message?: string } | undefined;

const DEFAULT_TIMEOUT_MS = 8_000;

export function requestRuntimeMessage<T extends RuntimeResponseLike>(sendMessage: SendMessage, readLastError: LastErrorReader, message: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const waitMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("扩展后台响应超时，请重新加载扩展后重试"))), waitMs);
    try {
      sendMessage(message, (response) => {
        const lastError = readLastError();
        if (lastError) {
          const messageText = lastError.message ?? "";
          finish(() => reject(new Error(messageText.includes("Receiving end does not exist") ? "扩展后台未响应，请在扩展管理页重新加载后重试" : "扩展后台连接失败，请重新加载扩展后重试")));
          return;
        }
        if (response === undefined) {
          finish(() => reject(new Error("扩展后台未响应，请在扩展管理页重新加载后重试")));
          return;
        }
        finish(() => resolve(response as T));
      });
    } catch {
      finish(() => reject(new Error("扩展后台连接失败，请重新加载扩展后重试")));
    }
  });
}
