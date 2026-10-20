import { z } from "zod";
import { operatorSettingsSchema, operatorObservationSchema, operatorEvaluationSchema, operatorEvaluationListSchema, operatorRuleIdSchema } from "./operator-rules";
const at = z.string().datetime().refine((v) => v.endsWith("Z"), "使用 UTC 时间");
export const operatorObservationRecordSchema = z.object({ observedAt: at, values: operatorObservationSchema }).strict();
export const operatorTimingSchema = z.object({ ruleId: operatorRuleIdSchema, firstDetectedAt: at, lastReviewedAt: at, nextReviewAt: at, recheckCount: z.number().int().nonnegative() }).strict();
export const operatorStateSchema = z.object({ version: z.literal("operator-live-v1"), timings: z.array(operatorTimingSchema).max(17) }).strict();
export const operatorPromptSchema = operatorEvaluationSchema.extend({ firstDetectedAt: at, lastReviewedAt: at, nextReviewAt: at, recheckCount: z.number().int().nonnegative() });
export const operatorRulesViewSchema = z.object({
  enabled: z.literal(true), version: z.literal("operator-live-v1"), updatedAt: at,
  settings: operatorSettingsSchema, observation: operatorObservationRecordSchema.optional(),
  active: z.array(operatorPromptSchema).max(17), coverage: operatorEvaluationListSchema,
  dataAvailability: z.object({compass:z.array(z.string()),qianchuan:z.array(z.string())}).optional()
}).strict();
export type OperatorObservationRecord = z.infer<typeof operatorObservationRecordSchema>;
export type OperatorTiming = z.infer<typeof operatorTimingSchema>;
export type OperatorRulesView = z.infer<typeof operatorRulesViewSchema>;
