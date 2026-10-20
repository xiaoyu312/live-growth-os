import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";
import { qianchuanAccountListSchema, qianchuanAwemeListSchema, qianchuanSetupSessionSchema, QIANCHUAN_LOCAL_ADMIN_PORT } from "@live-growth/contracts";
import { QianchuanConnectionService, connectionErrorCode } from "./qianchuan-connection";
import { isAllowedWebOrigin } from "./web-origin";

function loopback(value: string): boolean { return ["127.0.0.1", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"].includes(value); }

export function registerQianchuanConnectionRoutes(app: FastifyInstance, service?: QianchuanConnectionService, hostLoopbackPublished = false, returnToWeb = true): void {
  const csrfToken = randomBytes(32).toString("hex");
  const guard = (req: FastifyRequest, reply: FastifyReply, bootstrap = false): boolean => {
    reply.header("Cache-Control", "no-store");
    let local = false;
    try {
      const host = new URL(`http://${req.headers.host ?? ""}`);
      const origin = new URL(req.headers.origin ?? "");
      const trustedSocket = hostLoopbackPublished ? req.raw.socket.localPort === QIANCHUAN_LOCAL_ADMIN_PORT : loopback(req.ip);
      local = trustedSocket && loopback(host.hostname) && !host.username && !host.password
        && loopback(origin.hostname) && ["http:", "https:"].includes(origin.protocol)
        && origin.origin === req.headers.origin && isAllowedWebOrigin(origin.origin);
    } catch { /* 非本机或没有明确 Origin 的管理请求拒绝。 */ }
    const token = req.headers["x-qianchuan-setup-token"];
    const validToken = typeof token === "string" && /^[a-f0-9]{64}$/.test(token)
      && timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken));
    if (!local || (!bootstrap && !validToken)) {
      const code = bootstrap && hostLoopbackPublished ? "QIANCHUAN_USE_LOCAL_PORT" : "QIANCHUAN_LOCAL_ONLY";
      void reply.status(403).send({ error: { code, message: "请在值班电脑上打开本机副驾，连接千川。" } });
      return false;
    }
    if (!service) {
      void reply.status(503).send({ error: { code: "QIANCHUAN_SETUP_UNAVAILABLE", message: "当前为隔离演示服务，请启动正式本机副驾后连接。" } });
      return false;
    }
    return true;
  };
  const handle = (action: (req: FastifyRequest) => Promise<unknown> | unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!guard(req, reply)) return;
    try { return await action(req); }
    catch (error) {
      const code = error instanceof ZodError ? "QIANCHUAN_INPUT_INVALID" : connectionErrorCode(error);
      return reply.status(error instanceof ZodError ? 400 : 409).send({ error: { code }, connection: service!.view() });
    }
  };
  app.get("/api/qianchuan/setup", async (req, reply) => {
    if (!guard(req, reply, true)) return;
    return qianchuanSetupSessionSchema.parse({ csrfToken, connection: service!.view() });
  });
  app.get("/api/qianchuan/connection", handle(() => service!.view()));
  app.post("/api/qianchuan/app", handle((req) => service!.saveApp(req.body)));
  app.post("/api/qianchuan/authorize", handle((req) => service!.startAuthorization(returnToWeb ? new URL("/live/connect", req.headers.origin!).toString() : undefined)));
  app.post("/api/qianchuan/authorize/cancel", handle((req) => {
    const { attemptId } = z.object({ attemptId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    return service!.cancelAuthorization(attemptId);
  }));
  app.get("/api/qianchuan/capabilities", handle(() => service!.probeData()));
  app.get("/api/qianchuan/accounts", handle(async () => qianchuanAccountListSchema.parse(await service!.listAccounts())));
  app.get("/api/qianchuan/awemes", handle(async (req) => {
    const query = z.object({ advertiserId: z.string().regex(/^[1-9]\d{0,19}$/) }).strict().parse(req.query);
    return qianchuanAwemeListSchema.parse(await service!.listAwemes(query.advertiserId));
  }));
  app.post("/api/qianchuan/binding", handle((req) => service!.bind(req.body)));
}
