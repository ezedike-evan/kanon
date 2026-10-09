// Copied, not imported, from `@kanon/relayer`: the service packages share no code. Keep them in step.

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogRecord {
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

export type Logger = (entry: LogRecord) => void;

/** One JSON object per line. */
export function createJsonLogger(write: (line: string) => void = (l) => console.log(l)): Logger {
  return (entry) => write(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

export const silentLogger: Logger = () => {};
