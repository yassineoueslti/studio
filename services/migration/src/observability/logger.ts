import { redact } from './redact.js';

/**
 * Structured logging. Scope §56 fixes the field set every migration log line
 * carries: migration_id, tenant_id, source, entity, batch_id, source_id,
 * request_id, severity, timestamp -- and excludes secrets.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogContext {
  migration_id?: string;
  tenant_id?: string;
  source?: string;
  entity?: string;
  batch_id?: string;
  source_id?: string;
  request_id?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogContext): void;
  info(message: string, fields?: LogContext): void;
  warn(message: string, fields?: LogContext): void;
  error(message: string, fields?: LogContext): void;
  /** Derive a logger that stamps `context` onto every line it emits. */
  child(context: LogContext): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Injection point for tests; defaults to stdout/stderr. */
  sink?: (line: string, level: LogLevel) => void;
}

function defaultSink(line: string, level: LogLevel): void {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions = {}, base: LogContext = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? defaultSink;
  const threshold = LEVEL_ORDER[level];

  function emit(severity: Exclude<LogLevel, 'silent'>, message: string, fields?: LogContext): void {
    if (LEVEL_ORDER[severity] < threshold) return;
    const record = {
      timestamp: new Date().toISOString(),
      severity,
      message,
      ...base,
      ...(fields ?? {}),
    };
    sink(JSON.stringify(redact(record)), severity);
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (context) => createLogger(options, { ...base, ...context }),
  };
}

/** A logger that discards everything, for tests that assert on other output. */
export const silentLogger: Logger = createLogger({ level: 'silent' });
