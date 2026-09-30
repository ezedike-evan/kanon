export type LogLevel = 'info' | 'warn' | 'error';

export interface LogRecord {
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

export type Logger = (entry: LogRecord) => void;

/** One JSON object per line. bigint fields are written as decimal strings. */
export function createJsonLogger(write: (line: string) => void = (l) => console.log(l)): Logger {
  return (entry) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    write(line);
  };
}

export const silentLogger: Logger = () => {};
