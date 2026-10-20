import { join } from "node:path";
import { buildApp } from "./app";
import { SqliteEventStore } from "./sqlite-store";
import { LocalStateBus } from "./state-bus";
import { isAllowedWebOrigin } from "./web-origin";

export async function startDesktopServer(dataDir: string) {
  const store = new SqliteEventStore(join(dataDir, "live-pilot.sqlite"));
  const { app } = buildApp({
    store, bus: new LocalStateBus(), logger: false, captureOnly: true, operatorRulesEnabled: true,
    operatorHistoryPath: join(dataDir, ".runtime", "operator-history.json"),
    qianchuanSetup: { projectRoot: dataDir, adminListenHost: "127.0.0.1", hostLoopbackPublished: false }
  });
  app.addHook("onRequest", async (request, reply) => {
    // Refuse DNS rebinding and cross-site writes before any route is entered.
    if (request.headers.host !== "127.0.0.1:4100" && request.headers.host !== "localhost:4100") return reply.code(403).send({ error: { code: "LOCAL_ONLY" } });
    if (!isAllowedWebOrigin(request.headers.origin)) return reply.code(403).send({ error: { code: "LOCAL_ONLY" } });
    const path = request.url.split("?")[0]!;
    if (path.startsWith("/api/ingest") || path.startsWith("/api/advices") || path.startsWith("/api/mvp") || path.startsWith("/api/sessions") || path.startsWith("/api/review") ||
        /\/live\/(?:baseline\/sync|anchor-review|session-review|script-iteration)$/.test(path) ||
        /\/(?:actions\/|product-context|anchor-report)/.test(path)) {
      return reply.code(409).send({ error: { code: "CAPTURE_ONLY", message: "本测试版启用数据接入与运营规则；该功能未启用。" } });
    }
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 4100 });
    return app;
  } catch (error) { await app.close(); throw error; }
}
