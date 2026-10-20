const LOCAL_WEB_ORIGINS = ["http://127.0.0.1:3000", "http://localhost:3000", "http://127.0.0.1:3417"] as const;

export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const first = parts[0]!;
  const second = parts[1]!;
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return false;
}

export function isLanColleagueOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (parsed.port !== "3000") return false;
  if (parsed.username || parsed.password) return false;
  if (isPrivateIpv4(parsed.hostname) && !parsed.hostname.startsWith("169.254.")) return true;
  return /^[a-z0-9-]+\.local$/i.test(parsed.hostname);
}

export function isAllowedShareOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && parsed.port === "3000" && isPrivateIpv4(parsed.hostname) && !parsed.hostname.startsWith("169.254.");
}

export function isAllowedWebOrigin(origin: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (!origin) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  const extras = [env.WEB_ORIGIN, env.LAN_VIEW_SHARE_ORIGIN].filter((value): value is string => Boolean(value));
  if ((LOCAL_WEB_ORIGINS as readonly string[]).includes(origin) || extras.includes(origin)) return true;
  return env.LAN_VIEW === "1" && isLanColleagueOrigin(origin);
}

export function lanViewStatus(env: Record<string, string | undefined> = process.env):
  | { enabled: false; requested?: true }
  | { enabled: true; shareOrigin: string; watchUrl: string; note: string } {
  if (env.LAN_VIEW !== "1") return { enabled: false };
  const shareOrigin = env.LAN_VIEW_SHARE_ORIGIN?.trim();
  if (!shareOrigin || !isAllowedShareOrigin(shareOrigin)) return { enabled: false, requested: true };
  return {
    enabled: true,
    shareOrigin,
    watchUrl: `${shareOrigin.replace(/\/+$/, "")}/live/current`,
    note: "仅办公网观看。罗盘、千川、扩展和转写仍在这台电脑。"
  };
}

export function assertLanBindHost(host: string, env: Record<string, string | undefined> = process.env): void {
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (loopback) return;
  if (env.LAN_VIEW === "1" && (host === "0.0.0.0" || isPrivateIpv4(host))) return;
  throw new Error("绑定非本机地址需要 LAN_VIEW=1。这只用于办公网同事观看副驾，不是公网部署。");
}
