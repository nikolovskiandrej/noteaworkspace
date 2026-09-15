export interface BriefInput {
  taskTitle: string;
  taskDescription: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  projectDir: string;
  scope: string[];
  /** Paths other running tasks have declared; the agent must leave them alone. */
  reservedPaths: string[];
  checkCommand: string | null;
  portRange: { from: number; to: number } | null;
}

/**
 * The prompt handed to an agent for one run. Points at the repository's own docs
 * (the durable memory) and states the coordination rules that keep several agents
 * from colliding.
 */
export function buildTaskBrief(input: BriefInput): string {
  const lines: string[] = [];
  lines.push(`# Task: ${input.taskTitle}`, '');
  lines.push(input.taskDescription.trim(), '');
  lines.push('## Where you are working', '');
  lines.push(`- You are inside a dedicated git worktree at \`${input.worktreePath}\` on branch \`${input.branch}\` (based on \`${input.baseBranch}\`).`);
  lines.push(`- Do NOT modify \`${input.projectDir}\` (the main tree) or any other worktree. Work only inside your worktree.`);
  lines.push('- Commit your work on this branch with clear messages. Do not merge, rebase, push, or change branches.');
  if (input.scope.length > 0) {
    lines.push(`- Your task scope: ${input.scope.map((s) => `\`${s}\``).join(', ')}. Stay within it unless the task cannot be completed otherwise; if so, say why in your summary.`);
  }
  if (input.reservedPaths.length > 0) {
    lines.push(`- Other agents are currently working on: ${input.reservedPaths.map((s) => `\`${s}\``).join(', ')}. Do not touch those paths.`);
  }
  lines.push('- Environment-level changes (dependencies, lockfiles, migrations, CI config) are integration-sensitive: keep them minimal and mention them explicitly.');
  if (input.portRange) lines.push(`- If you need to run a server, use a port between ${input.portRange.from} and ${input.portRange.to}.`);
  lines.push('');
  lines.push('## Before you start', '');
  lines.push('- Read `AGENTS.md` and `docs/CURRENT_STATE.md` if they exist; they describe the project and its conventions.');
  if (input.checkCommand) lines.push(`- The integration check is \`${input.checkCommand}\`; make sure it passes before you finish.`);
  lines.push('');
  lines.push('## When you finish', '');
  lines.push('- Ensure everything is committed on your branch.');
  lines.push('- End with a short summary: what changed, what was tested, anything left undone.');
  return lines.join('\n');
}
