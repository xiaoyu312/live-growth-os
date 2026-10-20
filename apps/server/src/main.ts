import { buildApp, productionInfrastructure } from "./app";
import { assertLanBindHost } from "./web-origin";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

type StartupEnvironment = Record<string, string | undefined>;

/** 与双击入口共用本项目配置；从 apps/server 启动也不依赖调用者先 source。 */
export function loadLocalEnvironment(path = fileURLToPath(new URL("../../../.env", import.meta.url))): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

function configured(value: string | undefined): "已配置" | "未配置" {
  return value ? "已配置" : "未配置";
}

export function sanitizeStartupMessage(message: string): string {
  return message
    .replace(/(?:postgres(?:ql)?|redis|mysql|https?|wss?):\/\/[^\s"'`]+/gi, "[已隐藏地址]")
    .replace(/\b(secretid|secretkey|password|token|authorization|signature)(\s*[=:]\s*)[^\s,}]+/gi, "$1$2[已隐藏]")
    .replace(/(['"])(\/[^'"]+)\1/g, "$1[已隐藏路径]$1")
    .replace(/(?:\/(?:Users|private|home|tmp|var|opt|Volumes)\/[^\s"'`:,;]+|[A-Za-z]:\\[^\s"'`:,;]+)/gi, "[已隐藏路径]")
    .replace(/\b[\w.-]*(?:secretkey|credentials?|private[-_ ]?key)[\w.-]*\.(?:csv|json|txt)\b/gi, "[已隐藏文件]");
}

function safeRuntimeValue(value: string | undefined, allowed: readonly string[]): string {
  if (!value) return "未设置";
  return allowed.includes(value) ? value : "非法值（已隐藏）";
}

function safeHost(value: string | undefined): string {
  if (!value) return "127.0.0.1";
  return /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|::1)$/.test(value) ? value : "非法值（已隐藏）";
}

function safePort(value: string | undefined): string {
  if (!value) return "4100";
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? String(port) : "非法值（已隐藏）";
}

export function startupFailureSummary(error: unknown, env: StartupEnvironment = process.env): Record<string, unknown> {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    event: "startup_readiness_failed",
    message: sanitizeStartupMessage(rawMessage),
    runtime: {
      NODE_ENV: safeRuntimeValue(env.NODE_ENV, ["development", "production", "test"]),
      STORAGE_DRIVER: safeRuntimeValue(env.STORAGE_DRIVER, ["memory", "postgres"]),
      HOST: safeHost(env.HOST),
      PORT: safePort(env.PORT)
    },
    configured: {
      DATABASE_URL: configured(env.DATABASE_URL),
      REDIS_URL: configured(env.REDIS_URL),
      TENCENT_ASR_APP_ID: configured(env.TENCENT_ASR_APP_ID),
      TENCENT_ASR_CREDENTIALS_FILE: configured(env.TENCENT_ASR_CREDENTIALS_FILE),
      TENCENT_ASR_SECRET_ID: configured(env.TENCENT_ASR_SECRET_ID),
      ARK_API_KEY: configured(env.ARK_API_KEY),
      ARK_MODEL: configured(env.ARK_MODEL ?? env.ARK_ENDPOINT_ID)
    },
    action: "请检查上述配置状态后重试；确认 PostgreSQL／Redis 可用，生产模式不会自动退回内存存储。"
  };
}

export function startupSuccessSummary(host: string, port: number, storageMode: string): Record<string, unknown> {
  return {
    event: "server_started",
    address: `http://${host}:${port}`,
    persistenceMode: storageMode,
    storage: storageMode === "postgres" ? "postgres" : "memory",
    note: storageMode === "postgres"
      ? "真实直播场次默认写入 PostgreSQL"
      : "内存演示（非持久化）；持久化使用请按 README 配置 DATABASE_URL／REDIS_URL 并执行迁移"
  };
}

async function main(): Promise<void> {
  let runningApp: ReturnType<typeof buildApp>["app"] | undefined;
  try {
    // 隔离测试与内存演示不隐式载入本机真实凭据。
    if (process.env.NODE_ENV !== "test" && process.env.STORAGE_DRIVER !== "memory") loadLocalEnvironment();
    const infrastructure = await productionInfrastructure();
    const { app, historicalBaseline, startLocalManagement } = buildApp({ ...infrastructure, logger: true });
    runningApp = app;
    historicalBaseline.startDailyTimer();
    const host = process.env.HOST ?? "127.0.0.1";
    const port = Number(process.env.PORT ?? 4100);
    assertLanBindHost(host);
    await app.listen({ host, port });
    await startLocalManagement();
    console.log(startupSuccessSummary(host, port, infrastructure.store.mode));
  } catch (error) {
    console.error(startupFailureSummary(error));
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    await runningApp?.close().catch(() => undefined);
    // unref 不阻止正常退出；若库仍留下句柄，启动失败也须在 5 秒内终止。
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
