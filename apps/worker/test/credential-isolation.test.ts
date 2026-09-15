/**
 * The worker half of the credential-isolation guarantees, against a real Postgres.
 *
 * The container-level proof (one member cannot read another's credential out of
 * `/proc`) lives in `apps/orchestrator/test/docker.e2e.test.ts`. These tests cover
 * what happens before the process starts and what is written down afterwards: which
 * uid a run is given, whose credential it may use, and whether the secret can reach
 * a log, a task event, the agent's brief or the run's summary.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ScriptedCommandRunner,
  encryptSecret,
  parseCredentialsKey,
  type AgentRunContext,
  type AgentRunEvent,
  type AgentRunHandle,
  type AgentRuntime,
  type WorkspaceSession,
} from '@notea/agents';
import {
  agentRunEvents,
  agentRuns,
  agentTasks,
  createDatabase,
  providerCredentials,
  runMigrations,
  users,
  workspaceEvents,
  workspaceMembers,
  workspaces,
  type DatabaseHandle,
} from '@notea/db';
import { runTask, type ProcessorDeps } from '../src/processor';

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const KEY = parseCredentialsKey('a'.repeat(64));
const ANDREJ_TOKEN = 'sk-ant-oat01-ANDREJ-SUBSCRIPTION-TOKEN';
const NICHE_KEY = 'sk-ant-api03-NICHE-API-KEY-VALUE';

function fakeSession(): WorkspaceSession {
  return {
    createTerminal: async () => ({ sessionId: 'fake-session' }),
    killTerminal: async () => undefined,
    onTerminalOutput: () => () => undefined,
    onTerminalExit: () => () => undefined,
    writeHostFile: async () => undefined,
    ensureHostFile: async () => undefined,
  };
}

function scriptedGit(): ScriptedCommandRunner {
  return new ScriptedCommandRunner()
    .on('git rev-parse --is-inside-work-tree', { exitCode: 0 })
    .on('git rev-parse --verify HEAD', { exitCode: 0 })
    .on('git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' })
    .on(/^test -d/, { exitCode: 1 })
    .on(/^git rev-parse --verify 'notea\/task/, { exitCode: 128 })
    .on('git status --porcelain', { stdout: '' })
    .on(/^git diff --stat/, { stdout: ' src/a.ts | 2 +-\n' });
}

/** Records the context and session it was handed, then finishes immediately. */
function recordingRuntime() {
  const seen: { ctx: AgentRunContext | null } = { ctx: null };
  const runtime: AgentRuntime = {
    id: 'generic-cli',
    label: 'recorder',
    provider: null,
    supports: () => true,
    async start(ctx): Promise<AgentRunHandle> {
      seen.ctx = ctx;
      const events: AsyncIterable<AgentRunEvent> = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'started', sessionId: 'fake-session', at: new Date().toISOString() };
          yield { type: 'finished', outcome: 'completed', summary: 'done', exitCode: 0, at: new Date().toISOString() };
        },
      };
      return { sessionId: 'fake-session', events, cancel: async () => undefined };
    },
  };
  return { runtime, seen };
}

describeDb('credential isolation (worker)', () => {
  let handle: DatabaseHandle;
  let andrejId: string;
  let nicheId: string;
  let andrejUid: number;
  let nicheUid: number;
  let workspaceId: string;
  let andrejCredentialId: string;
  let nicheCredentialId: string;
  const suffix = randomUUID().slice(0, 8);
  const logLines: string[] = [];
  const log = {
    info: (msg: string, fields?: Record<string, unknown>) => logLines.push(`${msg} ${JSON.stringify(fields ?? {})}`),
    warn: (msg: string, fields?: Record<string, unknown>) => logLines.push(`${msg} ${JSON.stringify(fields ?? {})}`),
    error: (msg: string, fields?: Record<string, unknown>) => logLines.push(`${msg} ${JSON.stringify(fields ?? {})}`),
  };

  /** Records which (workspace, uid) pairs a run asked to execute as. */
  const isolationCalls: Array<{ workspaceId: string; uid: number }> = [];

  const deps = (runtime: AgentRuntime, runner: ScriptedCommandRunner): ProcessorDeps => ({
    db: handle.db,
    runtimes: new Map([[runtime.id, runtime]]),
    connect: async () => ({ session: fakeSession(), runner, close: () => undefined }),
    isolate: (ws, uid) => {
      isolationCalls.push({ workspaceId: ws, uid });
      return fakeSession();
    },
    credentialsKey: KEY,
    workerId: 'isolation-test',
    log,
    heartbeatMs: 50,
  });

  beforeAll(async () => {
    handle = createDatabase(url as string, { max: 3 });
    await runMigrations(handle.db);
    const [andrej] = await handle.db.insert(users).values({ email: `andrej-${suffix}@example.com`, name: 'Andrej' }).returning();
    const [niche] = await handle.db.insert(users).values({ email: `niche-${suffix}@example.com`, name: 'Niche' }).returning();
    andrejId = andrej!.id;
    nicheId = niche!.id;
    andrejUid = andrej!.agentUid;
    nicheUid = niche!.agentUid;

    const [workspace] = await handle.db
      .insert(workspaces)
      .values({ slug: `iso-${suffix}`, name: 'Shared', ownerId: andrejId })
      .returning();
    workspaceId = workspace!.id;
    // One shared workspace, two members: the product's whole point.
    await handle.db.insert(workspaceMembers).values([
      { workspaceId, userId: andrejId, role: 'owner' },
      { workspaceId, userId: nicheId, role: 'editor' },
    ]);

    const [andrejCredential] = await handle.db
      .insert(providerCredentials)
      .values({ userId: andrejId, provider: 'anthropic', authMode: 'subscription', label: 'andrej claude', encryptedSecret: encryptSecret(ANDREJ_TOKEN, KEY) })
      .returning();
    const [nicheCredential] = await handle.db
      .insert(providerCredentials)
      .values({ userId: nicheId, provider: 'anthropic', authMode: 'api_key', label: 'niche api', encryptedSecret: encryptSecret(NICHE_KEY, KEY) })
      .returning();
    andrejCredentialId = andrejCredential!.id;
    nicheCredentialId = nicheCredential!.id;
  });

  afterAll(async () => {
    await handle.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await handle.db.delete(users).where(eq(users.id, andrejId));
    await handle.db.delete(users).where(eq(users.id, nicheId));
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.delete(agentTasks).where(eq(agentTasks.workspaceId, workspaceId));
    isolationCalls.length = 0;
    logLines.length = 0;
  });

  async function createTask(input: { createdBy: string; credentialId?: string; title?: string }) {
    const [task] = await handle.db
      .insert(agentTasks)
      .values({
        workspaceId,
        title: input.title ?? 'Add a CHANGELOG entry',
        description: 'describe the current milestone',
        runtime: 'generic-cli',
        agentName: 'Claude',
        command: 'true',
        status: 'running',
        provider: 'anthropic',
        credentialId: input.credentialId ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    return task!;
  }

  it('gives each member a different uid, and the credential variable their mode calls for', async () => {
    const andrejRun = recordingRuntime();
    await runTask(deps(andrejRun.runtime, scriptedGit()), await createTask({ createdBy: andrejId, credentialId: andrejCredentialId }));
    const nicheRun = recordingRuntime();
    await runTask(deps(nicheRun.runtime, scriptedGit()), await createTask({ createdBy: nicheId, credentialId: nicheCredentialId }));

    expect(andrejUid).not.toBe(nicheUid);
    expect(isolationCalls).toEqual([
      { workspaceId, uid: andrejUid },
      { workspaceId, uid: nicheUid },
    ]);
    // A subscription never becomes metered API usage, and an API key never pretends
    // to be a subscription: one variable each, chosen by the stored mode.
    expect(andrejRun.seen.ctx?.credentialEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: ANDREJ_TOKEN });
    expect(nicheRun.seen.ctx?.credentialEnv).toEqual({ ANTHROPIC_API_KEY: NICHE_KEY });
  });

  it('refuses to run one member’s task with another member’s credential', async () => {
    const { runtime, seen } = recordingRuntime();
    const task = await createTask({ createdBy: nicheId, credentialId: andrejCredentialId });
    await runTask(deps(runtime, scriptedGit()), task);

    // The run fails instead of silently borrowing the credential.
    expect(seen.ctx).toBeNull();
    const after = await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) });
    expect(after?.status).toBe('failed');
    expect(after?.lastLog).toMatch(/belongs to another user/);
    expect(isolationCalls).toEqual([]);
  });

  it('never writes a secret into a log line, a run event, a workspace event or the task row', async () => {
    const { runtime } = recordingRuntime();
    const task = await createTask({ createdBy: andrejId, credentialId: andrejCredentialId });
    await runTask(deps(runtime, scriptedGit()), task);

    const runs = await handle.db.query.agentRuns.findMany({ where: eq(agentRuns.taskId, task.id) });
    const events = await handle.db.query.agentRunEvents.findMany({ where: eq(agentRunEvents.runId, runs[0]!.id) });
    const workspaceLog = await handle.db.query.workspaceEvents.findMany({ where: eq(workspaceEvents.workspaceId, workspaceId) });
    const taskRow = await handle.db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) });

    for (const [what, payload] of [
      ['worker logs', logLines.join('\n')],
      ['run events', JSON.stringify(events)],
      ['run rows', JSON.stringify(runs)],
      ['workspace events', JSON.stringify(workspaceLog)],
      ['task row', JSON.stringify(taskRow)],
    ] as const) {
      expect(payload, `${what} leaked a credential`).not.toContain(ANDREJ_TOKEN);
      expect(payload, `${what} leaked a credential`).not.toContain(NICHE_KEY);
      expect(payload, `${what} leaked a credential`).not.toContain('sk-ant');
    }

    // The log does record *which* mode was used, by name, because that is what makes
    // the billing relationship auditable.
    expect(logLines.join('\n')).toContain('"authMode":"subscription"');
    expect(logLines.join('\n')).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(logLines.join('\n')).toContain(`"agentUid":${andrejUid}`);
  });

  it('keeps the credential out of the brief the agent is given', async () => {
    const { runtime, seen } = recordingRuntime();
    await runTask(deps(runtime, scriptedGit()), await createTask({ createdBy: andrejId, credentialId: andrejCredentialId }));
    // The brief is written into the worktree and can end up in a commit or a diff;
    // it is built from the task, never from the environment.
    expect(seen.ctx?.brief).not.toContain(ANDREJ_TOKEN);
    expect(seen.ctx?.brief).not.toContain('sk-ant');
    expect(seen.ctx?.brief).toContain('Add a CHANGELOG entry');
  });
});
