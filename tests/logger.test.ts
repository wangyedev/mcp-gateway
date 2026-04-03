import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, LogLevel } from "../src/logger.js";

describe("Logger", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      LOG_LEVEL: process.env.LOG_LEVEL,
      LOG_FORMAT: process.env.LOG_FORMAT,
    };
  });

  afterEach(() => {
    process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
    process.env.LOG_FORMAT = originalEnv.LOG_FORMAT;
  });

  test("JSON mode outputs valid JSON with required fields", () => {
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("test message", { key: "value" });

    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.level).toBe("info");
    expect(output.msg).toBe("test message");
    expect(output.key).toBe("value");
    expect(output.timestamp).toBeDefined();
    spy.mockRestore();
  });

  test("pretty mode outputs human-readable format", () => {
    process.env.LOG_FORMAT = "pretty";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("test message", { server: "postgres" });

    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("[INFO]");
    expect(output).toContain("test message");
    expect(output).toContain("server=postgres");
    spy.mockRestore();
  });

  test("debug messages suppressed at info level", () => {
    process.env.LOG_LEVEL = "info";
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.debug("should not appear");

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("debug messages shown at debug level", () => {
    process.env.LOG_LEVEL = "debug";
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.debug("should appear");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("warn uses console.warn", () => {
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logger.warn("warning message");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("error uses console.error", () => {
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.error("error message");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("level filtering respects hierarchy", () => {
    process.env.LOG_LEVEL = "warn";
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.debug("no");
    logger.info("no");
    logger.warn("yes");
    logger.error("yes");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("defaults to info level when LOG_LEVEL not set", () => {
    delete process.env.LOG_LEVEL;
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.debug("should not appear");
    logger.info("should appear");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("context with no extra fields works", () => {
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("simple message");

    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.msg).toBe("simple message");
    expect(output.level).toBe("info");
    spy.mockRestore();
  });
});
