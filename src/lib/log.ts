/**
 * src/lib/log.ts
 * Structured stderr-only logger. JSON lines format.
 * stdout is the MCP protocol channel — nothing must be written there.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string, ctx?: object): void;
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
  /** Create a child logger that merges the given bindings into every log entry. */
  child(bindings: object): Logger;
}

export interface LoggerOptions {
  /** Minimum level to emit. Messages below this level are silently dropped. Default: 'info'. */
  level?: LogLevel;
  /** Optional prefix string included as `prefix` field in every log entry. */
  prefix?: string;
}

function createLoggerInternal(
  minLevel: number,
  bindings: Record<string, unknown>,
): Logger {
  function emit(level: LogLevel, msg: string, ctx?: object): void {
    if (LEVEL_RANK[level] < minLevel) return;

    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      msg,
      ...bindings,
      ...(ctx ?? {}),
    };

    process.stderr.write(JSON.stringify(entry) + '\n');
  }

  return {
    debug(msg, ctx) {
      emit('debug', msg, ctx);
    },
    info(msg, ctx) {
      emit('info', msg, ctx);
    },
    warn(msg, ctx) {
      emit('warn', msg, ctx);
    },
    error(msg, ctx) {
      emit('error', msg, ctx);
    },
    child(extraBindings) {
      return createLoggerInternal(minLevel, { ...bindings, ...extraBindings });
    },
  };
}

/**
 * Create a new root logger.
 * All output goes to stderr (never stdout) in JSON-lines format.
 */
export function createLogger(opts?: LoggerOptions): Logger {
  const level: LogLevel = opts?.level ?? 'info';
  const minLevel = LEVEL_RANK[level];
  const rootBindings: Record<string, unknown> = {};

  if (opts?.prefix != null) {
    rootBindings['prefix'] = opts.prefix;
  }

  return createLoggerInternal(minLevel, rootBindings);
}
