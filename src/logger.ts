export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

export function createLogger(): Logger {
  const minLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
  const format = process.env.LOG_FORMAT === "json" ? "json" : "pretty";
  const minOrder = LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.info;

  function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= minOrder;
  }

  function formatJson(
    level: LogLevel,
    msg: string,
    context?: Record<string, unknown>
  ): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      msg,
      ...context,
    });
  }

  function formatPretty(
    level: LogLevel,
    msg: string,
    context?: Record<string, unknown>
  ): string {
    const timestamp = new Date().toISOString();
    const tag = `[${level.toUpperCase()}]`;
    const contextStr = context
      ? " " +
        Object.entries(context)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      : "";
    return `${timestamp} ${tag} ${msg}${contextStr}`;
  }

  function log(
    level: LogLevel,
    msg: string,
    context?: Record<string, unknown>
  ): void {
    if (!shouldLog(level)) return;
    const formatted =
      format === "json"
        ? formatJson(level, msg, context)
        : formatPretty(level, msg, context);

    switch (level) {
      case "error":
        console.error(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
        break;
    }
  }

  return {
    debug: (msg, context) => log("debug", msg, context),
    info: (msg, context) => log("info", msg, context),
    warn: (msg, context) => log("warn", msg, context),
    error: (msg, context) => log("error", msg, context),
  };
}
