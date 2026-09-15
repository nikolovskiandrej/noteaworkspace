import os from 'node:os';
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ORCHESTRATOR_URL: z.string().url(),
  ORCHESTRATOR_API_KEY: z.string().min(16),
  /** 64 hex chars; required to use stored provider credentials. */
  CREDENTIALS_KEY: z.string().optional(),
  WORKER_ID: z.string().min(1).default(`${os.hostname()}-${process.pid}`),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
  WORKER_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).default(3),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type WorkerConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid worker configuration: ${details}`);
  }
  return parsed.data;
}
