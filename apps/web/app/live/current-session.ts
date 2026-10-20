export type LiveCatalogSession = {
  sessionId: string;
  status: string;
  startedAt?: string;
};

export function pickLatestRunningSession<T extends LiveCatalogSession>(sessions: readonly T[]): T | undefined {
  const running = sessions.filter((item) => item.status === "running");
  if (running.length === 0) return undefined;
  return [...running].sort((left, right) => {
    const rightAt = Date.parse(right.startedAt ?? "") || 0;
    const leftAt = Date.parse(left.startedAt ?? "") || 0;
    if (rightAt !== leftAt) return rightAt - leftAt;
    return right.sessionId.localeCompare(left.sessionId);
  })[0];
}
