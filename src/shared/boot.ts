import { z } from 'zod';

export const bootPhaseSchema = z.enum(['splash', 'shell', 'login', 'blocked', 'unknown']);
export type BootPhase = z.infer<typeof bootPhaseSchema>;
export const bootObservationSchema = z.object({
  phase: bootPhaseSchema, progress: z.number().int().min(0).max(10).nullable(),
  visible: z.boolean(), online: z.boolean()
}).strict();
export type BootObservation = z.infer<typeof bootObservationSchema>;
export const bootSessionSchema = z.object({ nonce: z.string().uuid(), generation: z.number().int().nonnegative() }).strict();
export type BootSession = z.infer<typeof bootSessionSchema>;
export const bootHeartbeatSchema = bootObservationSchema.extend({
  nonce: z.string().uuid(), generation: z.number().int().nonnegative()
}).strict();
