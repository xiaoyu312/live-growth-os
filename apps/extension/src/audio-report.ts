/** Send an offscreen status update without waiting for the service worker. */
export function fireAndForgetAudioStatus(
  send: (message: Record<string, unknown>) => Promise<unknown> | void,
  message: Record<string, unknown>
): void {
  try {
    void Promise.resolve(send(message)).catch(() => undefined);
  } catch {
    // The service worker may be restarting or have no receiver.
  }
}
