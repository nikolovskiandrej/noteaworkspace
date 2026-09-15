/** Where a run's artefacts (the brief handed to the CLI) live inside the container. */
export const DEFAULT_RUNS_DIR = '/home/dev/.notea/runs';

export function runDirectory(runId: string, runsDir: string = DEFAULT_RUNS_DIR): string {
  return `${runsDir}/${runId}`;
}

export function runBriefPath(runId: string, runsDir: string = DEFAULT_RUNS_DIR): string {
  return `${runDirectory(runId, runsDir)}/brief.md`;
}
