export class RuntimeError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export function isDockerStatus(err: unknown, status: number): boolean {
  return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === status;
}
