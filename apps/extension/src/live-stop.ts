/** Only a successful HTTP response permits discarding the live pair token. */
export function liveStopSucceeded(status: number): boolean { return status >= 200 && status < 300; }
