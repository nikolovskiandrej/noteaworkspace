import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(16),
  /** Where the web server reaches the orchestrator REST API (server to server). */
  ORCHESTRATOR_URL: z.string().url(),
  ORCHESTRATOR_API_KEY: z.string().min(16),
  /** Where browsers reach the orchestrator WebSocket endpoint. Defaults to ORCHESTRATOR_URL. */
  ORCHESTRATOR_PUBLIC_URL: z.string().url().optional(),
  /** 64 hex chars; required to store provider API keys. Must match the worker's value. */
  CREDENTIALS_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

export type WebEnv = z.infer<typeof EnvSchema>;

let cached: WebEnv | null = null;

/** Parsed lazily so `next build` does not require runtime secrets. */
export function env(): WebEnv {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid web configuration: ${details}`);
  }
  cached = parsed.data;
  return cached;
}
