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
    await this.write(path, content, false);
  }

  async ensureHostFile(path: string, content: string): Promise<void> {
    await this.write(path, content, true);
  }

  private async write(path: string, content: string, onlyIfMissing: boolean): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const guard = onlyIfMissing ? `if [ -e ${shellQuote(path)} ]; then cat > /dev/null; exit 0; fi; ` : '';
    const result = await this.client.runExec({
      command: `mkdir -p ${shellQuote(dir)} && ${guard}cat > ${shellQuote(path)}`,
      shell: true,
      timeoutMs: 30_000,
      stdin: content,
    });
    if (result.exitCode !== 0) throw new Error(`failed to write ${path}: ${result.stderr}`);
  }
}
