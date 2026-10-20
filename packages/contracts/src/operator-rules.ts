import { z } from "zod";

/**
 * 直播运营副驾的规则输入输出契约。
 *
 * 这些类型只描述数据和人工配置，不授予副驾执行投放、重启直播间、发券或资金操作的权限。
 */
export const operatorModeSchema = z.enum(["regular", "pulse"]);
export type OperatorMode = z.infer<typeof operatorModeSchema>;

export const operatorPrioritySchema = z.enum(["critical", "high", "medium", "low"]);
export type OperatorPriority = z.infer<typeof operatorPrioritySchema>;

export const operatorRuleIdSchema = z.enum([
  "low-online",
  "online-spike",
  "view-rate-low",
  "cpm-high",
  "short-stay",
  "comment-rate-low",
  "follow-rate-low",
  "product-exposure-low",
  "product-exposure-watch-low",
  "cvr-low",
  "gpm-low",
  "no-output-30m",
  "big-orders",
  "aov-low",
  "new-customer-heavy",
  "old-customer-heavy",
  "compliance-violation"
]);
export type OperatorRuleId = z.infer<typeof operatorRuleIdSchema>;

const nonNegative = z.number().finite().nonnegative();
const percentage = nonNegative.max(100);

export const operatorSettingsSchema = z.object({
  mode: operatorModeSchema,
  cpmTargetYuan: z.number().finite().positive().optional(),
  retargetMaterials: z.array(z.string().trim().min(1).max(240)).max(2),
  activityPlan: z.string().trim().max(240)
}).strict();
export type OperatorSettings = z.infer<typeof operatorSettingsSchema>;

export const operatorObservationSchema = z.object({
  violationActive: z.boolean().optional(),
  violationReason: z.string().trim().max(500).optional(),
  botsSuspected: z.boolean().optional(),
  interactionPresent: z.boolean().optional(),
  pluginAbnormal: z.boolean().optional(),
  newCustomerSharePct: percentage.optional(),
  oldCustomerSharePct: percentage.optional(),
  /** 人工确认的 30 分钟内每笔 > 1500 元订单笔数，不能由客单价推断。 */
  bigOrders30m: z.number().int().nonnegative().optional()
}).strict().superRefine((observation, context) => {
  if (observation.newCustomerSharePct !== undefined && observation.oldCustomerSharePct !== undefined
    && observation.newCustomerSharePct + observation.oldCustomerSharePct > 100) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["newCustomerSharePct"],
      message: "新客占比与老客占比合计不能超过 100%"
    });
  }
});
export type OperatorObservation = z.infer<typeof operatorObservationSchema>;

export const operatorValueSchema = z.object({
  value: nonNegative,
  baseline: nonNegative.optional(),
  unit: z.string().trim().min(1).max(40),
  source: z.string().trim().min(1).max(200),
  /** 统一要求 UTC 时间，避免跨时区比较或把采样时间误当作本地墙上时间。 */
  observedAt: z.string().datetime({ offset: false }),
  samples: z.number().int().positive(),
  note: z.string().trim().max(500).optional()
}).strict();
export type OperatorValue = z.infer<typeof operatorValueSchema>;

export const operatorFactsSchema = z.object({
  elapsedMinutes: nonNegative,
  mode: operatorModeSchema,
  onlineLow5m: z.boolean().optional(),
  onlineSpike5m: z.boolean().optional(),
  spendHour: operatorValueSchema.optional(),
  enters5m: operatorValueSchema.optional(),
  staySeconds: operatorValueSchema.optional(),
  gmvHour: operatorValueSchema.optional(),
  ordersHour: operatorValueSchema.optional(),
  orders30m: operatorValueSchema.optional(),
  gpm: operatorValueSchema.optional(),
  cvr: operatorValueSchema.optional(),
  ctr: operatorValueSchema.optional(),
  aov: operatorValueSchema.optional(),
  cpm: operatorValueSchema.optional(),
  exposureEntryRate: operatorValueSchema.optional(),
  productExposureRate: operatorValueSchema.optional(),
  productExposureWatchRate: operatorValueSchema.optional(),
  commentRate: operatorValueSchema.optional(),
  followRate: operatorValueSchema.optional(),
  observation: operatorObservationSchema.optional()
}).strict();
export type OperatorFacts = z.infer<typeof operatorFactsSchema>;

export const operatorEvaluationSchema = z.object({
  ruleId: operatorRuleIdSchema,
  title: z.string().trim().min(1).max(160),
  priority: operatorPrioritySchema,
  state: z.enum(["triggered", "clear", "insufficient_data"]),
  owner: z.string().trim().min(1).max(120),
  actions: z.array(z.string().trim().min(1).max(500)).max(8),
  fallback: z.array(z.string().trim().min(1).max(500)).max(8),
  hypotheses: z.array(z.string().trim().min(1).max(300)).max(8),
  evidence: z.array(operatorValueSchema).max(12),
  missing: z.array(z.string().trim().min(1).max(120)).max(12),
  reason: z.string().trim().min(1).max(1000)
}).strict();
export type OperatorEvaluation = z.infer<typeof operatorEvaluationSchema>;

export const operatorEvaluationListSchema = z.array(operatorEvaluationSchema).length(17);
