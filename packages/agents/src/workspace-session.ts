import type { WorkspaceClient } from '@notea/workspace-client';
import { shellQuote } from './command-runner';
import type { WorkspaceSession } from './types';

/** Adapts a WorkspaceClient to the small surface the runtimes need. */
export class ClientWorkspaceSession implements WorkspaceSession {
  constructor(private readonly client: WorkspaceClient) {}

  async createTerminal(input: Parameters<WorkspaceSession['createTerminal']>[0]): Promise<{ sessionId: string }> {
    const reply = await this.client.createTerminal({
      cols: input.cols,
      rows: input.rows,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      title: input.title,
      env: input.env,
      attach: input.attach ?? true,
    });
    return { sessionId: reply.session.id };
  }

  async killTerminal(sessionId: string): Promise<void> {
    await this.client.killTerminal(sessionId);
  }

  onTerminalOutput(sessionId: string, listener: (data: string) => void): () => void {
    return this.client.on('term.output', (message) => {
      if (message.sessionId === sessionId) listener(message.data);
    });
  }

  onTerminalExit(sessionId: string, listener: (exitCode: number | null) => void): () => void {
    return this.client.on('term.exit', (message) => {
      if (message.sessionId === sessionId) listener(message.exitCode);
    });
  }

  /** Writes via a shell so paths outside the project directory (HOME) are allowed. */
  async writeHostFile(path: string, content: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const result = await this.client.runExec({
      command: `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(path)}`,
      shell: true,
      timeoutMs: 30_000,
      stdin: content,
    });
    if (result.exitCode !== 0) throw new Error(`failed to write ${path}: ${result.stderr}`);
  }
}
