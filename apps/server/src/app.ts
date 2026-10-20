import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { startSessionSchema, anchorReviewRequestSchema, sessionReviewRequestSchema, QIANCHUAN_LOCAL_ADMIN_PORT } from "@live-growth/contracts";
import { z, ZodError } from "zod";
import {
  AdviceNotFoundError, InvalidAdviceTransitionError, SessionService,
  InvalidEventScopeError, InvalidLifecycleError, ReadOnlySessionError, SessionNotFoundError
} from "./session-service";
import { LocalStateBus, RedisStateBus, type StateBus } from "./state-bus";
import { MemoryEventStore, PostgresEventStore, type EventStore } from "./storage";
import { runMigrations } from "./migrations";
import { BusinessReviewDataUnavailableError, BusinessReviewNotFoundError, Phase15bReviewService } from "./phase1-5b-review";
import { MvpActionNotFoundError, MvpFeedbackConflictError, MvpReadOnlySessionError, MvpReviewNotReadyError, MvpService, MvpSessionNotFoundError } from "./mvp-service";
import { LivePilotActionFeedbackConflictError, LivePilotActionNotFoundError, LivePilotNotFoundError, LivePilotReviewError, LivePilotService, LivePilotStoppedError, LivePilotUnauthorizedError, LivePilotUnavailableError } from "./live-pilot";
import { HistoricalBaselineService, HistoricalBaselineSyncInProgressError, createDefaultHistoricalBaselineService, historicalBaselineHealthComponent, historicalBaselineViewOf } from "./historical-baseline-service";
import { HistoricalBaselineSyncFailedError, MemoryHistoricalHourSnapshotStore } from "@live-growth/source-adapters";
import { DiagnosisExpressionService } from "./diagnosis-expression";
import { AnchorReviewExpressionService } from "./anchor-review-expression";
import { SessionReviewExpressionService } from "./session-review-expression";
import { isAllowedWebOrigin, lanViewStatus } from "./web-origin";
import { resolveHealthBuildId } from "./health-build";
import { createOfficialQianchuanLiveSource, OfficialQianchuanLiveSource, type QianchuanOfficialLiveSourceLike } from "./qianchuan-official-live";
import { QianchuanConnectionService } from "./qianchuan-connection";
import { registerQianchuanConnectionRoutes } from "./qianchuan-connection-routes";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { OperatorRulesService } from "./operator-rules-service";
import { OperatorHistoryService } from "./operator-history-service";

export type BuildAppOptions = {
  captureOnly?: boolean;
  operatorRulesEnabled?: boolean;
  operatorHistoryPath?: string;
  store?: EventStore;
  bus?: StateBus;
  logger?: boolean;
  loggerStream?: { write(message: string): void };
  historicalBaseline?: HistoricalBaselineService;
  diagnosisExpression?: DiagnosisExpressionService;
  anchorReviewExpression?: AnchorReviewExpressionService;
  sessionReviewExpression?: SessionReviewExpressionService;
  qianchuanOfficialLiveSource?: QianchuanOfficialLiveSourceLike;
  qianchuanSetup?: { projectRoot: string; fetchImpl?: typeof fetch; authorize?: ConstructorParameters<typeof QianchuanConnectionService>[0]["authorize"]; hostLoopbackPublished?: boolean; adminListenHost?: "127.0.0.1" };
};
type SnapshotCursor = { eventCount: number; updatedAt: string };

export const productionLoggerOptions = {
  redact: {
    paths: [
      "req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']",
      "req.body.password", "req.body.databaseUrl", "req.body.redisUrl", "req.body.connectionString",
      "password", "databaseUrl", "redisUrl", "connectionString",
      "req.body.appSecret", "appSecret", "*.appSecret", "req.headers['x-qianchuan-setup-token']",
      "*.password", "*.databaseUrl", "*.redisUrl", "*.connectionString"
    ],
    censor: "[REDACTED]"
  }
};

export function isNewerSnapshot(cursor: SnapshotCursor | undefined, state: { eventCount: number; updatedAt: string }): boolean {
  if (!cursor) return true;
  if (state.eventCount !== cursor.eventCount) return state.eventCount > cursor.eventCount;
  return Date.parse(state.updatedAt) > Date.parse(cursor.updatedAt);
}

export function buildApp(options: BuildAppOptions = {}): { app: FastifyInstance; service: SessionService; mvpService: MvpService; historicalBaseline: HistoricalBaselineService; startLocalManagement: () => Promise<void> } {
  const app = Fastify({
    logger: options.logger
      ? { ...productionLoggerOptions, ...(options.loggerStream ? { stream: options.loggerStream } : {}) }
      : false
  });
  const store = options.store ?? new MemoryEventStore();
  const bus = options.bus ?? new LocalStateBus();
  const service = new SessionService(store, bus);
  const mvpService = new MvpService(store, bus);
  const operatorRules = options.operatorRulesEnabled ? new OperatorRulesService(service, store) : undefined;
  const operatorHistory = options.operatorHistoryPath ? new OperatorHistoryService(options.operatorHistoryPath) : undefined;
  const businessReviewService = new Phase15bReviewService(store);
  const qianchuanOfficialLiveSource = options.qianchuanOfficialLiveSource ?? createOfficialQianchuanLiveSource();
  const livePilot = new LivePilotService(service, store, qianchuanOfficialLiveSource, options.captureOnly ?? false);
  const hostLoopbackPublished = options.qianchuanSetup?.hostLoopbackPublished ?? process.env.QIANCHUAN_HOST_LOOPBACK_PORTS === "1";
  let adminServer: Server | undefined;
  const connection = qianchuanOfficialLiveSource instanceof OfficialQianchuanLiveSource
    && (store.mode === "postgres" || options.qianchuanSetup)
    ? new QianchuanConnectionService({
      projectRoot: options.qianchuanSetup?.projectRoot ?? process.env.QIANCHUAN_CONNECTION_DIR ?? fileURLToPath(new URL("../../../", import.meta.url)),
      source: qianchuanOfficialLiveSource,
      hostLoopbackPublished,
      ...(options.qianchuanSetup?.adminListenHost ? { callbackListenHost: options.qianchuanSetup.adminListenHost } : {}),
      ...(options.qianchuanSetup?.fetchImpl ? { fetchImpl: options.qianchuanSetup.fetchImpl } : {}),
      ...(options.qianchuanSetup?.authorize ? { authorize: options.qianchuanSetup.authorize } : {}),
      onBound: async () => { await livePilot.resumeRunningSource(); }
    }) : undefined;
  registerQianchuanConnectionRoutes(app, connection, hostLoopbackPublished, store.mode !== "sqlite");
  const historicalBaseline = options.historicalBaseline ?? (options.captureOnly
    ? new HistoricalBaselineService(new MemoryHistoricalHourSnapshotStore(), async () => ({ registerSheets: [] }))
    : createDefaultHistoricalBaselineService());
  const diagnosisExpression = options.diagnosisExpression ?? DiagnosisExpressionService.fromEnv();
  const anchorReviewExpression = options.anchorReviewExpression ?? AnchorReviewExpressionService.fromEnv();
  const sessionReviewExpression = options.sessionReviewExpression ?? SessionReviewExpressionService.fromEnv();

  void app.register(cors, { origin: (origin, callback) => callback(null, isAllowedWebOrigin(origin)), methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Error && error.message === "PUBLIC_REPLAY_DATA_NOT_INCLUDED") return reply.status(409).send({ error: { code: "REPLAY_NOT_INCLUDED", message: "公开版不附内部真实场次，请使用合成模拟场景。" } });
    if (error instanceof Error && /^OPERATOR_[A-Z_]+$/.test(error.message)) return reply.status(409).send({error:{code:error.message,message:"当前直播状态暂不允许此操作"}});
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: { code: "INVALID_SCHEMA", message: "请求不符合契约", issues: error.issues } });
    }
    if (error instanceof SessionNotFoundError) return reply.status(404).send({ error: { code: "SESSION_NOT_FOUND", message: error.message } });
    if (error instanceof AdviceNotFoundError) return reply.status(404).send({ error: { code: "ADVICE_NOT_FOUND", message: error.message } });
    if (error instanceof InvalidEventScopeError) return reply.status(400).send({ error: { code: "INVALID_EVENT_SCOPE", message: error.message } });
    if (error instanceof InvalidLifecycleError) return reply.status(409).send({ error: { code: "INVALID_LIFECYCLE", message: error.message } });
    if (error instanceof ReadOnlySessionError) return reply.status(409).send({ error: { code: "READ_ONLY_SESSION", message: error.message } });
    if (error instanceof InvalidAdviceTransitionError) return reply.status(409).send({ error: { code: "INVALID_ADVICE_TRANSITION", message: error.message } });
    if (error instanceof BusinessReviewNotFoundError) return reply.status(404).send({ error: { code: "BUSINESS_REVIEW_NOT_FOUND", message: error.message } });
    if (error instanceof BusinessReviewDataUnavailableError) return reply.status(503).send({ error: { code: "BUSINESS_REVIEW_UNAVAILABLE", message: error.message } });
    if (error instanceof MvpSessionNotFoundError) return reply.status(404).send({ error: { code: "MVP_SESSION_NOT_FOUND", message: error.message } });
    if (error instanceof MvpActionNotFoundError) return reply.status(404).send({ error: { code: "MVP_ACTION_NOT_FOUND", message: error.message } });
    if (error instanceof MvpReviewNotReadyError) return reply.status(409).send({ error: { code: "MVP_REVIEW_NOT_READY", message: error.message } });
    if (error instanceof MvpFeedbackConflictError) return reply.status(409).send({ error: { code: "MVP_FEEDBACK_CONFLICT", message: error.message } });
    if (error instanceof MvpReadOnlySessionError) return reply.status(409).send({ error: { code: "READ_ONLY_SESSION", message: error.message } });
    if (error instanceof LivePilotNotFoundError) return reply.status(404).send({ error: { code: "LIVE_PILOT_NOT_FOUND", message: error.message } });
    if (error instanceof LivePilotUnauthorizedError) return reply.status(401).send({ error: { code: "LIVE_PILOT_UNAUTHORIZED", message: error.message } });
    if (error instanceof LivePilotStoppedError) return reply.status(409).send({ error: { code: "LIVE_PILOT_STOPPED", message: error.message } });
    if (error instanceof LivePilotActionNotFoundError) return reply.status(404).send({ error: { code: "LIVE_ACTION_NOT_FOUND", message: error.message } });
    if (error instanceof LivePilotActionFeedbackConflictError) return reply.status(409).send({ error: { code: "LIVE_ACTION_FEEDBACK_CONFLICT", message: error.message } });
    if (error instanceof LivePilotUnavailableError) return reply.status(503).send({ error: { code: "LIVE_PILOT_UNAVAILABLE", message: error.message } });
    if (error instanceof LivePilotReviewError) return reply.status(400).send({ error: { code: "INVALID_ANCHOR_REVIEW", message: error.message } });
    if (error instanceof HistoricalBaselineSyncInProgressError) return reply.status(409).send({ error: { code: "BASELINE_SYNC_IN_PROGRESS", message: error.message } });
    if (error instanceof HistoricalBaselineSyncFailedError) {
      return reply.status(503).send({
        error: { code: "BASELINE_SYNC_FAILED", message: error.message },
        baseline: historicalBaselineViewOf(error.snapshot, error.status)
      });
    }
    app.log.error({ errorCode: "REQUEST_FAILED" }, "request_failed");
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "服务处理失败" } });
  });

  app.get("/api/lan-view", async () => lanViewStatus());
  app.get("/health", async () => {
    const [storageHealth, redisHealth, baselineView] = await Promise.all([store.health(), bus.health(), historicalBaseline.view()]);
    const productionReady = store.mode === "memory-demo" || (store.mode === "sqlite" ? storageHealth.sqlite?.status === "healthy" : storageHealth.postgres.status === "healthy" && storageHealth.pgvector.status === "healthy");
    const baselineHealth = historicalBaselineHealthComponent(baselineView);
    return {
      status: productionReady && redisHealth.status !== "degraded" && baselineHealth.status !== "degraded" ? "ok" : "degraded",
      build: resolveHealthBuildId(),
      captureOnly: options.captureOnly === true,
      operatorRulesEnabled: options.operatorRulesEnabled === true,
      desktop: store.mode === "sqlite",
      server: { status: "healthy", message: "Fastify 服务正常" },
      postgres: storageHealth.postgres,
      pgvector: storageHealth.pgvector,
      redis: store.mode === "sqlite" ? { status: "not_configured", message: "单机版使用进程内通知，无需 Redis" } : redisHealth,
      websocket: { status: "healthy", message: "WebSocket 路由已加载" },
      persistenceMode: store.mode === "postgres" ? "正式 PostgreSQL 持久化" : store.mode === "sqlite" ? "本机 SQLite 持久化" : "内存演示（非持久化）",
      ...(storageHealth.sqlite ? { sqlite: storageHealth.sqlite } : {}),
      storage: store.mode,
      realtime: store.mode === "sqlite" ? "local" : bus.mode,
      eckHistoryBaseline: baselineHealth,
      arkExpression: !options.captureOnly && diagnosisExpression.configured()
        ? { status: "healthy", message: "主播复盘和本场复盘会走一轮方舟表达" }
        : { status: "not_configured", message: options.captureOnly ? "数据接入测试版：模型调用已暂停" : "未配置方舟，复盘用规则底稿" },
      qianchuanOfficialApi: qianchuanOfficialLiveSource.status(),
      qianchuanOfficialResume: livePilot.officialSourceResumeStatus()
    };
  });
  const bearerToken = (request: { headers: Record<string, string | string[] | undefined> }): string => {
    const raw = request.headers.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header?.startsWith("Bearer ")) throw new LivePilotUnauthorizedError("缺少真实试点配对令牌");
    return header.slice("Bearer ".length).trim();
  };
  const operatorWriteAllowed = (request: {ip:string;headers:Record<string, unknown>}): boolean => {
    const origin=request.headers.origin;if(typeof origin!=="string")return false;
    try {const url=new URL(origin);return ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(request.ip) && ["127.0.0.1","localhost"].includes(url.hostname) && isAllowedWebOrigin(origin);}
    catch{return false;}
  };
  app.get<{Params:{id:string}}>("/api/live/sessions/:id/operator-history",async(request)=> {
    if(!operatorRules || !operatorHistory)return {status:"not_imported"};
    const settings=await operatorRules.currentSettings(request.params.id);return operatorHistory.reference(settings.mode,Date.now());
  });
  app.post("/api/live/operator-history",{bodyLimit:4_000_000},async(request,reply)=>{
    if(!operatorRules||!operatorHistory)return reply.code(409).send({error:{code:"OPERATOR_RULES_DISABLED"}});
    if(!operatorWriteAllowed(request))return reply.code(403).send({error:{code:"LOCAL_ONLY"}});
    return operatorHistory.import(request.body);
  });
  app.get<{Params:{id:string}}>("/api/live/sessions/:id/operator-rules",async(request)=>operatorRules?operatorRules.view(request.params.id):{enabled:false});
  app.post<{Params:{id:string}}>("/api/live/sessions/:id/operator-settings",async(request,reply)=>{
    if(!operatorRules)return reply.code(409).send({error:{code:"OPERATOR_RULES_DISABLED"}});
    if(!operatorWriteAllowed(request))return reply.code(403).send({error:{code:"LOCAL_ONLY"}});
    return operatorRules.saveSettings(request.params.id,request.body);
  });
  app.post<{Params:{id:string}}>("/api/live/sessions/:id/operator-observation",async(request,reply)=>{
    if(!operatorRules)return reply.code(409).send({error:{code:"OPERATOR_RULES_DISABLED"}});
    if(!operatorWriteAllowed(request))return reply.code(403).send({error:{code:"LOCAL_ONLY"}});
    return operatorRules.saveObservation(request.params.id,request.body);
  });
  app.post("/api/live/sessions", async (_request, reply) => reply.status(201).send(await livePilot.create()));
  app.get("/api/live/sessions", async () => livePilot.catalog());
  app.get("/api/live/baseline", async () => historicalBaseline.view());
  app.post("/api/live/baseline/sync", async () => historicalBaseline.sync());
  const composeLiveCockpit = async (sessionId: string) => {
    const view = await livePilot.view(sessionId);
    if (options.captureOnly) return { ...view, captureOnly: true, diagnosis: null, hourVsBaseline: null };
    const [baseline, comparison] = await Promise.all([historicalBaseline.view(), historicalBaseline.comparisonInput()]);
    const extras = await livePilot.cockpitExtras(sessionId, {
      ...comparison,
      audioStatus: view.audio.status
    });
    return {
      ...view,
      hourVsBaseline: extras.hourVsBaseline,
      diagnosis: extras.diagnosis ? diagnosisExpression.attach(extras.diagnosis) : null,
      historicalBaseline: {
        status: baseline.status,
        mappingVersion: baseline.mappingVersion,
        grain: baseline.grain,
        ...(baseline.lastSuccessAt ? { lastSuccessAt: baseline.lastSuccessAt } : {}),
        ...(baseline.asOfLocalDate ? { asOfLocalDate: baseline.asOfLocalDate } : {})
      }
    };
  };
  app.get<{ Params: { id: string } }>("/api/live/sessions/:id/view", async (request) => composeLiveCockpit(request.params.id));
  app.get<{ Params: { id: string } }>("/api/live/sessions/:id/windows", async (request) => livePilot.windows(request.params.id));
  app.get<{ Params: { id: string } }>("/api/live/sessions/:id/anchor-report", async (request) => livePilot.anchorReport(request.params.id));
  app.post("/api/live/anchor-review", async (request) => {
    const body = anchorReviewRequestSchema.parse(request.body);
    const packet = await livePilot.buildAnchorReview(body);
    return anchorReviewExpression.express(packet);
  });
  app.post("/api/live/session-review", async (request) => {
    const body = sessionReviewRequestSchema.parse(request.body);
    const packet = await livePilot.buildSessionReview(body);
    return sessionReviewExpression.express(packet);
  });
  app.get("/api/live/script-iteration", async () => livePilot.scriptIteration());
  app.post<{ Params: { id: string } }>("/api/live/sessions/:id/metrics", async (request) => livePilot.ingestMetric(request.params.id, bearerToken(request), request.body));
  app.post<{ Params: { id: string; actionId: string } }>("/api/live/sessions/:id/actions/:actionId/feedback", async (request) => livePilot.recordActionFeedback(request.params.id, bearerToken(request), request.params.actionId, request.body));
  app.post<{ Params: { id: string; actionId: string } }>("/api/live/sessions/:id/actions/:actionId/feedback/local", async (request) => {
    const rawOrigin = request.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    if (!origin || !isAllowedWebOrigin(origin)) throw new LivePilotUnauthorizedError("只允许本机或已开启的局域网副驾页面提交反馈");
    return livePilot.recordLocalActionFeedback(request.params.id, request.params.actionId, request.body);
  });
  app.post<{ Params: { id: string } }>("/api/live/sessions/:id/product-context", async (request) => {
    const rawOrigin = request.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    if (!origin || !isAllowedWebOrigin(origin)) throw new LivePilotUnauthorizedError("只允许本机或已开启的局域网副驾页面选择商品角色");
    return livePilot.setProductContext(request.params.id, request.body);
  });
  app.post<{ Params: { id: string } }>("/api/live/sessions/:id/runtime", async (request) => livePilot.ingestPageRuntime(request.params.id, bearerToken(request), request.body));
  app.post<{ Params: { id: string } }>("/api/live/sessions/:id/recovery", async (request) => {
    const rawOrigin = request.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    const header = request.headers.authorization;
    const rawAuth = Array.isArray(header) ? header[0] : header;
    const token = rawAuth?.startsWith("Bearer ") ? rawAuth.slice("Bearer ".length).trim() : undefined;
    return livePilot.requestRecovery(request.params.id, request.body, {
      ...(token ? { token } : {}),
      originOk: Boolean(origin && isAllowedWebOrigin(origin))
    });
  });
  app.post<{ Params: { id: string } }>("/api/live/sessions/:id/reattach", async (request) => livePilot.reattach(request.params.id, bearerToken(request)));
  app.post<{ Params: { id: string } }>("/api/live/sessions/:id/stop", async (request) => { await livePilot.stop(request.params.id, bearerToken(request)); return { stopped: true }; });
  app.post("/api/sessions", async (request, reply) => reply.status(201).send(await service.create(request.body)));
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request) => service.get(request.params.id));
  app.get<{ Params: { id: string } }>("/api/sessions/:id/state", async (request) => service.state(request.params.id));
  app.post<{ Params: { id: string } }>("/api/sessions/:id/start", async (request) => {
    const { speed } = startSessionSchema.parse(request.body ?? {});
    return service.start(request.params.id, speed);
  });
  app.post<{ Params: { id: string } }>("/api/sessions/:id/stop", async (request) => service.stop(request.params.id));
  app.get<{ Params: { id: string } }>("/api/sessions/:id/advices", async (request) => service.advices(request.params.id));
  app.get<{ Params: { id: string } }>("/api/sessions/:id/review", async (request) => service.review(request.params.id));
  app.get("/api/reviews/phase-1-5b", async () => businessReviewService.get());
  app.post("/api/reviews/phase-1-5b/ratings", async (request) => businessReviewService.submit(request.body));
  app.get<{ Params: { adviceId: string } }>("/api/reviews/phase-1-5b/audio/:adviceId", async (request, reply) => {
    const audio = businessReviewService.audioPath(request.params.adviceId);
    return reply.type("audio/mpeg").header("Content-Length", String(audio.size)).header("Cache-Control", "public, max-age=3600").send(businessReviewService.audioStream(request.params.adviceId));
  });
  app.post<{ Params: { id: string } }>("/api/advices/:id/feedback", async (request) => {
    const input = z.object({
      type: z.enum(["seen", "accepted", "rejected"]), operatorId: z.string().min(1), reason: z.string().min(1).optional()
    }).strict().parse(request.body);
    return service.recordFeedback(request.params.id, input);
  });
  app.post<{ Params: { id: string } }>("/api/advices/:id/executions", async (request) => {
    const input = z.object({
      status: z.enum(["not_executed", "executing", "executed", "unknown"]),
      operatorId: z.string().min(1), notes: z.string().min(1).optional()
    }).strict().parse(request.body);
    return service.recordExecution(request.params.id, input);
  });
  app.post<{ Params: { id: string } }>("/api/advices/:id/confounded", async (request) => {
    const input = z.object({ operatorId: z.string().min(1), reason: z.string().min(1) }).strict().parse(request.body);
    return service.markConfounded(request.params.id, input);
  });
  app.post("/api/ingest/events", async (request) => {
    const accepted = await service.ingest(request.body);
    return { accepted: accepted ? 1 : 0, duplicates: accepted ? 0 : 1 };
  });
  app.post("/api/ingest/batch", async (request) => {
    const body = z.object({ events: z.array(z.unknown()).min(1).max(1000) }).strict().parse(request.body);
    return service.ingestBatch(body.events);
  });
  const mvpScenarios = z.enum([
    "mvp_stable", "mvp_traffic_surge", "mvp_retention", "mvp_high_intent",
    "mvp_high_click_low_pay", "mvp_standout", "mvp_low_efficiency", "mvp_comprehensive", "mvp_real_session_001"
  ]);
  app.get("/api/mvp/products", async () => mvpService.products());
  app.put<{ Params: { productId: string } }>("/api/mvp/products/:productId", async (request) => {
    const body = z.object({ name: z.string().min(1), type: z.enum(["low_price_new_customer", "high_price_repeat_customer"]), priceFen: z.number().int().nonnegative(), enabled: z.boolean().default(true), note: z.string().optional() }).strict().parse(request.body);
    return mvpService.saveProduct({ productId: request.params.productId, ...body });
  });
  app.post("/api/mvp/sessions", async (request, reply) => {
    const body = z.object({ name: z.string().min(1).max(100).optional(), scenario: mvpScenarios, seed: z.number().int().default(42) }).strict().parse(request.body ?? {});
    return reply.status(201).send(await mvpService.create({ scenario: body.scenario, seed: body.seed, ...(body.name ? { name: body.name } : {}) }));
  });
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>("/api/mvp/sessions/:id/state", async (request) => {
    const windowMinutes = z.coerce.number().pipe(z.union([z.literal(10), z.literal(15)])).default(10).parse(request.query.window ?? "10");
    return mvpService.state(request.params.id, windowMinutes);
  });
  app.post<{ Params: { id: string } }>("/api/mvp/sessions/:id/start", async (request) => {
    const body = z.object({ speed: z.number().positive().max(20).default(5) }).strict().parse(request.body ?? {});
    return mvpService.start(request.params.id, body.speed);
  });
  app.post<{ Params: { id: string } }>("/api/mvp/sessions/:id/stop", async (request) => mvpService.stop(request.params.id));
  app.post<{ Params: { id: string } }>("/api/mvp/sessions/:id/feedback", async (request) => {
    const body = z.object({ adviceId: z.string().min(1), status: z.enum(["executed", "not_executed", "not_applicable"]), operatorId: z.string().min(1).optional() }).strict().parse(request.body);
    return mvpService.feedback(request.params.id, { adviceId: body.adviceId, status: body.status, ...(body.operatorId ? { operatorId: body.operatorId } : {}) });
  });
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>("/api/mvp/sessions/:id/small-review", async (request) => {
    const windowMinutes = z.coerce.number().pipe(z.union([z.literal(10), z.literal(15)])).default(10).parse(request.query.window ?? "10");
    return mvpService.smallReview(request.params.id, windowMinutes);
  });
  app.get<{ Params: { id: string } }>("/api/mvp/sessions/:id/full-review", async (request) => mvpService.fullReview(request.params.id));
  app.get<{ Querystring: { sessionId?: string } }>("/api/health/sources", async (request) => {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.query);
    return (await service.state(sessionId)).sourceHealth;
  });
  void app.register(async (wsApp) => {
    await wsApp.register(websocket);
    wsApp.get<{ Params: { id: string } }>("/ws/sessions/:id", { websocket: true }, (socket, request) => {
      let unsubscribe: (() => Promise<void>) | undefined;
      let closed = false;
      let cursor: SnapshotCursor | undefined;
      const send = (state: Awaited<ReturnType<typeof service.state>>) => {
        if (socket.readyState !== 1 || !isNewerSnapshot(cursor, state)) return;
        cursor = { eventCount: state.eventCount, updatedAt: state.updatedAt };
        socket.send(JSON.stringify({ type: "state.snapshot", state }));
      };
      void service.subscribe(request.params.id, send)
        .then(async (cleanup) => {
          if (closed) { await cleanup(); return; }
          unsubscribe = cleanup;
          send(await service.state(request.params.id));
        })
        .catch((error: unknown) => socket.send(JSON.stringify({ type: "session.error", error: error instanceof Error ? error.message : "unknown" })));
      socket.on("close", () => { closed = true; if (unsubscribe) void unsubscribe(); });
    });
    wsApp.get<{ Params: { id: string }; Querystring: { window?: string } }>("/ws/mvp/:id", { websocket: true }, (socket, request) => {
      let closed = false;
      const windowMinutes = z.coerce.number().pipe(z.union([z.literal(10), z.literal(15)])).default(10).parse(request.query.window ?? "10");
      let cursor: { eventCount: number; updatedAt: string; stale: boolean; state: string | null; stateName: string } | undefined;
      const send = (state: Awaited<ReturnType<typeof mvpService.state>>) => {
        if (closed || socket.readyState !== 1) return;
        const next = { eventCount: state.eventCount, updatedAt: state.updatedAt, stale: state.stale, state: state.state, stateName: state.stateName };
        if (cursor && cursor.eventCount === next.eventCount && cursor.updatedAt === next.updatedAt && cursor.stale === next.stale && cursor.state === next.state && cursor.stateName === next.stateName) return;
        cursor = next;
        socket.send(JSON.stringify({ type: "mvp.state", state }));
      };
      const unsubscribe = mvpService.subscribe(request.params.id, () => { void mvpService.state(request.params.id, windowMinutes).then(send).catch(() => undefined); });
      void mvpService.state(request.params.id, windowMinutes).then(send).catch((error: unknown) => {
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: "mvp.error", error: error instanceof Error ? error.message : "unknown" }));
      });
      const refreshTimer = setInterval(() => {
        void mvpService.state(request.params.id, windowMinutes).then(send).catch(() => undefined);
      }, 10_000);
      socket.on("close", () => { closed = true; unsubscribe(); clearInterval(refreshTimer); });
    });
    wsApp.get<{ Params: { id: string } }>("/ws/live-view/:id", { websocket: true }, (socket, request) => {
      let closed = false;
      let unsubscribe: (() => Promise<void>) | undefined;
      let cursor: string | undefined;
      const fingerprint = (payload: Awaited<ReturnType<typeof composeLiveCockpit>>): string => JSON.stringify({
        lastMetricAt: payload.source.lastMetricAt,
        lastQianchuanAt: payload.qianchuan.lastMetricAt,
        lastFinalAt: payload.audio.lastFinalAt,
        finalCount: payload.audio.finalCount,
        audioStatus: payload.audio.status,
        transcriptionStatus: payload.audio.transcriptionStatus,
        sourceStatus: payload.source.status,
        qianchuanStatus: payload.qianchuan.status,
        qianchuanOverall: payload.qianchuan.overallHealth,
        compassOverall: payload.source.overallHealth,
        groupSeen: [...(payload.qianchuan.groups ?? []), ...(payload.source.groups ?? [])].map((item) => `${item.group}:${item.status}:${item.lastSeenAt ?? ""}`).join("|"),
        recovering: payload.recovering === true,
        pendingRecovery: payload.pendingRecovery?.requestedAt,
        lastRecoveredAt: payload.lastRecoveredAt,
        needsReconnect: payload.needsReconnect,
        diagnosisEnd: payload.diagnosis?.windowEndAt,
        diagnosisProvider: payload.diagnosis?.provider,
        sessionStatus: payload.session.status
      });
      const send = async () => {
        if (closed || socket.readyState !== 1) return;
        try {
          const view = await composeLiveCockpit(request.params.id);
          const next = fingerprint(view);
          if (cursor === next) return;
          cursor = next;
          socket.send(JSON.stringify({ type: "live.view", view }));
        } catch (error: unknown) {
          if (socket.readyState === 1) socket.send(JSON.stringify({ type: "live.error", error: error instanceof Error ? error.message : "unknown" }));
        }
      };
      void send();
      void livePilot.subscribe(request.params.id, () => { void send(); })
        .then((cleanup) => { if (closed) void cleanup(); else unsubscribe = cleanup; })
        .catch((error: unknown) => {
          if (socket.readyState === 1) socket.send(JSON.stringify({ type: "live.error", error: error instanceof Error ? error.message : "unknown" }));
        });
      const refreshTimer = setInterval(() => { void send(); }, 5_000);
      socket.on("close", () => { closed = true; if (unsubscribe) void unsubscribe(); clearInterval(refreshTimer); });
    });
    wsApp.get<{ Params: { id: string } }>("/ws/live/:id", { websocket: true }, (socket, request) => {
      let firstMessage = true;
      socket.on("message", (data, isBinary) => {
        if (!firstMessage) return;
        if (isBinary) {
          socket.close(1008, "authorize_required");
          return;
        }
        firstMessage = false;
        let message: unknown;
        try { message = JSON.parse(data.toString()); } catch { socket.close(1008, "invalid_authorize"); return; }
        const token = message && typeof message === "object" && typeof (message as { token?: unknown }).token === "string" ? (message as { token: string }).token : "";
        if ((message as { type?: unknown } | null)?.type !== "authorize" || !token) { socket.close(1008, "authorize_required"); return; }
        void livePilot.acceptAudio(request.params.id, token, socket as unknown as import("ws").WebSocket).catch(() => socket.close(1011, "asr_unavailable"));
      });
    });
  });
  let adminStart: Promise<void> | undefined;
  const startLocalManagement = (): Promise<void> => {
    if (adminStart) return adminStart;
    adminStart = (async () => {
    if (hostLoopbackPublished && connection) {
      // 独立的 TCP listener，同一进程、同一 Fastify 路由。端口 4100 不接受管理操作。
      adminServer = createServer((request, response) => app.routing(request, response));
      await new Promise<void>((resolve, reject) => {
        adminServer!.once("error", (error: NodeJS.ErrnoException) => reject(new Error(error.code === "EADDRINUSE" ? "QIANCHUAN_ADMIN_PORT_BUSY" : "QIANCHUAN_ADMIN_LISTENER_FAILED")));
        adminServer!.listen(QIANCHUAN_LOCAL_ADMIN_PORT, options.qianchuanSetup?.adminListenHost ?? "0.0.0.0", resolve);
      });
    }
    })();
    return adminStart;
  };
  app.addHook("onReady", async () => { await connection?.initialize(); void livePilot.resumeRunningSource().catch(() => undefined); });
  app.addHook("onClose", async () => {
    historicalBaseline.stopDailyTimer();
    if (adminServer) {
      adminServer.closeAllConnections();
      await new Promise<void>((resolve) => adminServer!.close(() => resolve()));
    }
    await connection?.close(); await operatorRules?.close(); await livePilot.close(); await mvpService.close(); await service.close();
  });
  return { app, service, mvpService, historicalBaseline, startLocalManagement };
}

export function resolveStorageDriver(env: NodeJS.ProcessEnv = process.env): "memory" | "postgres" {
  const explicit = env.STORAGE_DRIVER;
  if (explicit === "memory") {
    if (env.NODE_ENV === "production") throw new Error("生产环境禁止 STORAGE_DRIVER=memory");
    return "memory";
  }
  if (explicit === "postgres") return "postgres";
  if (explicit) throw new Error(`未知 STORAGE_DRIVER：${explicit}`);
  if (env.DATABASE_URL && env.REDIS_URL) return "postgres";
  if (env.NODE_ENV === "production") return "postgres";
  return "memory";
}

export async function productionInfrastructure(): Promise<{ store: EventStore; bus: StateBus }> {
  const storageDriver = resolveStorageDriver();
  if (storageDriver === "memory") {
    return { store: new MemoryEventStore(), bus: new LocalStateBus() };
  }
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) throw new Error("PostgreSQL 模式必须配置 DATABASE_URL 和 REDIS_URL；无 Docker 演示请设 STORAGE_DRIVER=memory");
  await runMigrations(databaseUrl);
  const store = new PostgresEventStore(databaseUrl);
  await store.assertReady();
  const bus = new RedisStateBus(redisUrl);
  return { store, bus };
}
