import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  qianchuanAppSetupSchema, qianchuanBindingSchema, qianchuanBindingRequestSchema,
  qianchuanConnectionViewSchema, type QianchuanAppSetup, type QianchuanBinding,
  type QianchuanConnectionView, type QianchuanAccountList, type QianchuanAweme
} from "@live-growth/contracts";
import { atomicWrite, persistQianchuanTokens, runQianchuanAuthorization } from "./qianchuan-connect";
import { OfficialQianchuanLiveSource } from "./qianchuan-official-live";

const storedSchema = z.object({ version: z.literal(1), app: qianchuanAppSetupSchema, binding: qianchuanBindingSchema.optional() }).strict();
export class QianchuanConnectionError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function connectionErrorCode(error: unknown): string {
  return error instanceof Error && /^QIANCHUAN_[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "QIANCHUAN_CONNECTION_FAILED";
}

type Options = {
  projectRoot: string;
  source: OfficialQianchuanLiveSource;
  fetchImpl?: typeof fetch;
  authorize?: typeof runQianchuanAuthorization;
  now?: () => number;
  onBound: () => Promise<void>;
  hostLoopbackPublished?: boolean;
  callbackListenHost?: "127.0.0.1";
};

/** 本机连接状态。令牌的读取与续期始终委托同一个 OfficialQianchuanLiveSource。 */
export class QianchuanConnectionService {
  private app?: QianchuanAppSetup;
  private binding?: QianchuanBinding;
  private authorization: QianchuanConnectionView["authorization"] = { state: "idle" };
  private errorCode?: string;
  private accounts?: QianchuanAccountList;
  private awemes = new Map<string, QianchuanAweme[]>();
  private abort?: AbortController;
  private authFlight?: Promise<void>;
  private operations: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly configPath: string;
  private readonly tokenPath: string;
  private readonly clock: () => number;

  constructor(private readonly options: Options) {
    this.configPath = join(options.projectRoot, ".runtime", "qianchuan-connection.json");
    this.tokenPath = join(options.projectRoot, ".runtime", "qianchuan-tokens.json");
    this.clock = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    try {
      const stored = storedSchema.parse(JSON.parse(await readFile(this.configPath, "utf8")));
      this.app = stored.app;
      if (stored.binding) this.binding = stored.binding;
      await this.apply();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.errorCode = "QIANCHUAN_CONFIG_INVALID";
      }
      // 网页连接以自己的配置为唯一身份；缺失/损坏时不暗中沿用旧环境令牌。
      await this.options.source.configure(undefined);
    }
  }

  view(): QianchuanConnectionView {
    const source = this.options.source.status();
    const invalid = /QIANCHUAN_(HTTP_401|TOOL_40102|TOOL_40103)$/.test(this.errorCode ?? source.lastErrorCode ?? "");
    return qianchuanConnectionViewSchema.parse({
      appConfigured: Boolean(this.app), ...(this.app ? { appId: this.app.appId } : {}),
      independentApp: this.app?.independentApp === true,
      authorized: Boolean(this.app && this.options.source.authorizationAvailable() && !invalid && !this.pending()),
      ...(this.binding ? { binding: this.binding } : {}), authorization: this.authorization,
      source: { state: source.state, activeSessions: source.activeSessions,
        ...(source.lastSuccessAt ? { lastSuccessAt: source.lastSuccessAt } : {}),
        ...(source.lastErrorCode ? { lastErrorCode: source.lastErrorCode } : {}) },
      ...(this.errorCode ? { errorCode: this.errorCode } : {})
    });
  }

  private pending(): boolean { return this.authorization.state === "waiting" || this.authorization.state === "saving"; }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.operations.then(async () => {
      if (this.closing) throw new QianchuanConnectionError("QIANCHUAN_SOURCE_CLOSED");
      try { return await work(); }
      catch (error) { this.errorCode = connectionErrorCode(error); throw error; }
    });
    this.operations = run.then(() => undefined, () => undefined);
    return run;
  }
  private assertReady(): void {
    if (this.pending()) throw new QianchuanConnectionError("QIANCHUAN_AUTH_BUSY");
    if (!this.app) throw new QianchuanConnectionError("QIANCHUAN_APP_REQUIRED");
  }
  private resetLists(): void { delete this.accounts; this.awemes.clear(); }
  private async store(app: QianchuanAppSetup, binding?: QianchuanBinding): Promise<void> {
    const payload = storedSchema.parse({ version: 1, app, ...(binding ? { binding } : {}) });
    await atomicWrite(this.configPath, `${JSON.stringify(payload)}\n`);
  }
  private async apply(): Promise<void> {
    await this.options.source.configure(this.app ? {
      appId: this.app.appId, appSecret: this.app.appSecret, tokenStorePath: this.tokenPath,
      ...(this.binding ? { advertiserId: this.binding.advertiserId, awemeId: this.binding.awemeId } : {})
    } : undefined);
  }

  saveApp(input: unknown): Promise<QianchuanConnectionView> {
    return this.exclusive(async () => {
      if (this.pending()) throw new QianchuanConnectionError("QIANCHUAN_AUTH_BUSY");
      if (this.options.source.status().activeSessions > 0) throw new QianchuanConnectionError("QIANCHUAN_LIVE_BINDING_LOCKED");
      const app = qianchuanAppSetupSchema.parse(input);
      const unchanged = this.app?.appId === app.appId && this.app.appSecret === app.appSecret;
      await this.store(app, unchanged ? this.binding : undefined);
      this.app = app;
      if (!unchanged) delete this.binding;
      this.resetLists();
      this.authorization = { state: "idle" };
      delete this.errorCode;
      await this.apply();
      return this.view();
    });
  }

  startAuthorization(returnUrl?: string): Promise<QianchuanConnectionView> {
    return this.exclusive(async () => {
      this.assertReady();
      if (this.authFlight) await this.authFlight;
      this.resetLists();
      delete this.errorCode;
      this.authorization = { state: "waiting" };
      if (this.closing) throw new QianchuanConnectionError("QIANCHUAN_SOURCE_CLOSED");
      this.abort = new AbortController();
      let sourcePaused = false;
      let opened!: () => void;
      const ready = new Promise<void>((resolve) => { opened = resolve; });
      const app = this.app!;
      const run = (this.options.authorize ?? runQianchuanAuthorization)({
        config: app, signal: this.abort.signal, now: this.clock,
        ...(this.options.hostLoopbackPublished ? { hostLoopbackPublished: true } : {}),
        ...(this.options.callbackListenHost ? { listenHost: this.options.callbackListenHost } : {}),
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(returnUrl ? { returnUrl } : {}),
        beforeExchange: async () => {
          // 等用户真正同意后再暂停旧续期；等待登录时现有直播继续取数。
          sourcePaused = true;
          await this.options.source.configure(undefined);
          if (this.closing) throw new QianchuanConnectionError("QIANCHUAN_SOURCE_CLOSED");
        },
        onAuthUrl: (authUrl, expiresAt) => {
          const attemptId = new URL(authUrl).searchParams.get("state")!;
          this.authorization = { state: "waiting", authUrl, expiresAt, attemptId }; opened();
        },
        save: async (tokens) => {
          if (this.closing) throw new QianchuanConnectionError("QIANCHUAN_SOURCE_CLOSED");
          this.authorization = { ...this.authorization, state: "saving" };
          await persistQianchuanTokens(app, tokens, this.tokenPath);
        }
      });
      const flight = run.then(async () => {
        if (!this.closing) { await this.apply(); this.authorization = { state: "ready" }; await this.options.onBound(); }
      }).catch(async (error: unknown) => {
        const code = connectionErrorCode(error);
        this.authorization = { state: code === "QIANCHUAN_AUTH_CANCELLED" ? "cancelled" : "error", errorCode: code };
        if (sourcePaused && !this.closing) await this.apply().catch(() => { this.errorCode = "QIANCHUAN_CONNECTION_FAILED"; });
      }).finally(() => { opened(); if (this.authFlight === flight) delete this.authFlight; });
      this.authFlight = flight;
      await ready;
      return this.view();
    });
  }

  async cancelAuthorization(attemptId: string): Promise<QianchuanConnectionView> {
    if (this.authorization.attemptId !== attemptId) return this.view();
    if (this.authorization.state === "saving") throw new QianchuanConnectionError("QIANCHUAN_AUTH_SAVING");
    this.abort?.abort();
    await this.authFlight;
    return this.view();
  }

  listAccounts(): Promise<QianchuanAccountList> {
    return this.exclusive(async () => {
      this.assertReady();
      this.accounts = await this.options.source.listAccounts();
      this.awemes.clear();
      delete this.errorCode;
      return this.accounts;
    });
  }

  probeData() {
    return this.exclusive(async () => {
      this.assertReady();
      if (!this.binding) throw new QianchuanConnectionError("QIANCHUAN_BINDING_REQUIRED");
      return this.options.source.probeLiveData();
    });
  }

  listAwemes(advertiserId: string): Promise<{ items: QianchuanAweme[] }> {
    return this.exclusive(async () => {
      this.assertReady();
      if (!this.accounts?.items.some((item) => item.id === advertiserId)) throw new QianchuanConnectionError("QIANCHUAN_ACCOUNT_NOT_SELECTED");
      const items = await this.options.source.listAwemes(advertiserId);
      this.awemes.set(advertiserId, items);
      delete this.errorCode;
      return { items };
    });
  }

  bind(input: unknown): Promise<QianchuanConnectionView> {
    return this.exclusive(async () => {
      this.assertReady();
      const selected = qianchuanBindingRequestSchema.parse(input);
      if (this.binding && this.options.source.status().activeSessions > 0
        && (this.binding.advertiserId !== selected.advertiserId || this.binding.awemeId !== selected.awemeId)) {
        throw new QianchuanConnectionError("QIANCHUAN_LIVE_BINDING_LOCKED");
      }
      const account = this.accounts?.items.find((item) => item.id === selected.advertiserId);
      if (!account || !this.awemes.get(account.id)?.some((item) => item.id === selected.awemeId)) throw new QianchuanConnectionError("QIANCHUAN_SELECTION_INVALID");
      // 不信任网页回传的名称或旧 ID；提交前重新核验抖音号仍在授权列表内。
      const current = await this.options.source.listAwemes(account.id);
      const aweme = current.find((item) => item.id === selected.awemeId);
      if (!aweme) throw new QianchuanConnectionError("QIANCHUAN_SELECTION_INVALID");
      const binding = qianchuanBindingSchema.parse({ ...selected, accountName: account.name, awemeName: aweme.name });
      await this.store(this.app!, binding);
      this.binding = binding;
      delete this.errorCode;
      await this.apply();
      await this.options.onBound();
      return this.view();
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.abort?.abort();
    await this.operations;
    // start 可能原本在等待暂停旧轮询；稳定后再收取最后一份授权任务。
    this.abort?.abort();
    await this.authFlight;
  }
}
