import { z } from "zod";
export const QIANCHUAN_LOCAL_ADMIN_PORT = 4101;

const officialId = z.string().regex(/^[1-9]\d{0,19}$/);
const safeCode = z.string().regex(/^QIANCHUAN_[A-Z0-9_]{1,100}$/);
export const qianchuanAppSetupSchema = z.object({
  appId: officialId.refine((id) => Number.isSafeInteger(Number(id)), "App ID 无效"),
  appSecret: z.string().trim().min(1).max(2048).regex(/^[^\r\n\u0000]+$/),
  independentApp: z.literal(true)
}).strict();
export const qianchuanBindingRequestSchema = z.object({ advertiserId: officialId, awemeId: officialId }).strict();
export const qianchuanAccountSchema = z.object({ id: officialId, name: z.string().min(1).max(160) }).strict();
export const qianchuanAccountListSchema = z.object({
  items: z.array(qianchuanAccountSchema).max(10000), warnings: z.array(z.string().max(200)).max(100)
}).strict();
export const qianchuanAwemeSchema = qianchuanAccountSchema.extend({ showId: z.string().max(64).optional() }).strict();
export const qianchuanAwemeListSchema = z.object({ items: z.array(qianchuanAwemeSchema).max(10000) }).strict();
export const qianchuanBindingSchema = qianchuanBindingRequestSchema.extend({
  accountName: z.string().min(1).max(160), awemeName: z.string().min(1).max(160)
}).strict();
export const qianchuanConnectionViewSchema = z.object({
  appConfigured: z.boolean(), appId: officialId.optional(), independentApp: z.boolean(), authorized: z.boolean(),
  binding: qianchuanBindingSchema.optional(),
  authorization: z.object({
    state: z.enum(["idle", "waiting", "saving", "ready", "cancelled", "error"]),
    attemptId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    authUrl: z.string().url().refine((value) => {
      const url = new URL(value);
      return url.origin === "https://qianchuan.jinritemai.com" && url.pathname === "/openapi/qc/audit/oauth.html";
    }).optional(),
    expiresAt: z.string().datetime().optional(),
    errorCode: safeCode.optional()
  }).strict(),
  source: z.object({
    state: z.enum(["not_configured", "idle", "healthy", "stale", "error"]),
    activeSessions: z.number().int().nonnegative(), lastSuccessAt: z.string().datetime().optional(), lastErrorCode: safeCode.optional()
  }).strict(),
  errorCode: safeCode.optional()
}).strict();
export const qianchuanSetupSessionSchema = z.object({
  csrfToken: z.string().regex(/^[a-f0-9]{64}$/), connection: qianchuanConnectionViewSchema
}).strict();

export type QianchuanAppSetup = z.infer<typeof qianchuanAppSetupSchema>;
export type QianchuanAccount = z.infer<typeof qianchuanAccountSchema>;
export type QianchuanAccountList = z.infer<typeof qianchuanAccountListSchema>;
export type QianchuanAweme = z.infer<typeof qianchuanAwemeSchema>;
export type QianchuanBinding = z.infer<typeof qianchuanBindingSchema>;
export type QianchuanConnectionView = z.infer<typeof qianchuanConnectionViewSchema>;

export const qianchuanCapabilitiesSchema = z.object({
  observedAt: z.string().datetime(), status: z.enum(["fresh","no_living_room","error"]),
  requestedFields: z.array(z.string().max(120)), fallbackUsed: z.boolean(),
  capabilities: z.record(z.enum(["available","missing","unsupported","not_requested"])),
  snapshot: z.unknown(), errorCode: safeCode.optional()
}).strict();
export type QianchuanCapabilities = z.infer<typeof qianchuanCapabilitiesSchema>;
