/**
 * Minimal JSON-lines logger. The agent is bundled into the workspace image, and a
 * dependency-free logger keeps that bundle small and predictable. The orchestrator
 * collects container stdout, so structured lines are enough.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  minLevel: LogLevel = 'info',
  base: Record<string, unknown> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    write(JSON.stringify({ level, time: new Date().toISOString(), msg, ...base, ...fields }));
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger(minLevel, { ...base, ...fields }, write),
  };
}

export const silentLogger: Logger = createLogger('error', {}, () => {});
