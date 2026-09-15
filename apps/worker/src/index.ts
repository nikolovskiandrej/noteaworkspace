import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRuntimeRegistry, parseCredentialsKey } from '@notea/agents';
import { createDatabase } from '@notea/db';
import { OrchestratorClient } from '@notea/workspace-client';
import { loadConfig } from './config';
import { RunSlots, findApprovedTasks, integrateApprovedTask, recoverStaleRuns, runTask, startDueRuns, type ProcessorDeps } from './processor';
import { createWorkspaceConnector } from './workspace-connection';

for (const candidate of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

function logger(level: string) {
  const order: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[level] ?? 20;
  const emit = (lvl: string, msg: string, fields?: Record<string, unknown>) => {
    if ((order[lvl] ?? 20) < min) return;
    process.stdout.write(JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...fields }) + '\n');
  };
  return {
    info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
    error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
  };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = logger(config.LOG_LEVEL);
  const handle = createDatabase(config.DATABASE_URL, { max: 5 });
  const orchestrator = new OrchestratorClient({ baseUrl: config.ORCHESTRATOR_URL, apiKey: config.ORCHESTRATOR_API_KEY });
  const deps: ProcessorDeps = {
    db: handle.db,
    runtimes: createRuntimeRegistry(),
    connect: createWorkspaceConnector(orchestrator),
    credentialsKey: config.CREDENTIALS_KEY ? parseCredentialsKey(config.CREDENTIALS_KEY) : null,
    workerId: config.WORKER_ID,
    log,
  };
  log.info('worker starting', { workerId: config.WORKER_ID, maxConcurrentRuns: config.WORKER_MAX_CONCURRENT_RUNS, credentials: !!deps.credentialsKey });

  const inFlight = new Set<Promise<void>>();
  const slots = new RunSlots(config.WORKER_MAX_CONCURRENT_RUNS);
  let stopping = false;
  const track = (promise: Promise<void>) => {
    inFlight.add(promise);
    void promise.catch(() => undefined).finally(() => inFlight.delete(promise));
  };

  const tick = async () => {
    await recoverStaleRuns(deps);
    for (const task of await findApprovedTasks(handle.db)) track(integrateApprovedTask(deps, task));
    await startDueRuns(deps, slots, (task) => {
      const promise = runTask(deps, task);
      track(promise);
      return promise;
    });
  };

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      log.error('tick failed', { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_INTERVAL_MS));
  }

  const shutdown = async (signal: string) => {
    stopping = true;
    log.info('shutting down', { signal, inFlight: inFlight.size, runs: slots.size });
    await Promise.allSettled([...inFlight]);
    await slots.drain();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`worker failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
