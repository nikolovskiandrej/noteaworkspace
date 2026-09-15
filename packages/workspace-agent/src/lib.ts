/**
 * Library entry point: lets other packages (notably the orchestrator's tests) run
 * an agent in-process. The container entry point is `index.ts`.
 */
export { AgentError } from './errors';
export { FsService } from './fs-service';
export { AgentHub, type HubOptions } from './hub';
export { createLogger, silentLogger, type Logger, type LogLevel } from './logger';
export { createNodePtyFactory, type PtyFactory, type PtyProcess, type PtySpawnOptions } from './pty';
export {
  ProcessManager,
  createNodeProcessFactory,
  type ProcessFactory,
  type ProcessHandle,
  type ProcessManagerOptions,
  type ProcessSpawnOptions,
} from './process-manager';
export { ScrollbackBuffer } from './scrollback';
export { createAgentServer, type AgentServer, type AgentServerOptions } from './server';
export { SessionManager, type SessionManagerOptions, type CreateSessionInput } from './session-manager';
