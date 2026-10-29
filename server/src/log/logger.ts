import { pino } from "pino";

// The subset of pino the server uses. Structured first: fields (roomId,
// playerId, err, ...) go in the object, the message is a short constant, so
// a log query can filter on fields instead of grepping sentences.
export interface LogFn {
  (fields: object, message?: string): void;
  (message: string): void;
}

export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child?(bindings: object): Logger;
}

// The process-wide logger: pino, with fatal for crash reports.
export interface RootLogger extends Logger {
  fatal: LogFn;
}

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// One JSON object per line on stdout: the platform (Docker, Fly, Render)
// collects stdout, so the process never manages log files itself.
export function createLogger({ level = "info", version }: { level?: LogLevel; version: string }): RootLogger {
  return pino({
    level,
    base: { service: "dogfight", version },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

// A child logger when the logger supports it (tests pass plain objects).
export function childLogger(logger: Logger, bindings: object): Logger {
  return logger.child?.(bindings) ?? logger;
}
