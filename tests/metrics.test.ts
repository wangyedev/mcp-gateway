import { describe, test, expect } from "vitest";
import { MetricsRegistry } from "../src/metrics.js";

describe("MetricsRegistry", () => {
  test("counter increments", () => {
    const metrics = new MetricsRegistry();
    metrics.defineCounter(
      "test_total",
      "A test counter"
    );
    metrics.incrementCounter("test_total");
    metrics.incrementCounter("test_total");

    const output = metrics.toPrometheus();
    expect(output).toContain("# HELP test_total A test counter");
    expect(output).toContain("# TYPE test_total counter");
    expect(output).toContain("test_total 2");
  });

  test("counter with labels tracks separately", () => {
    const metrics = new MetricsRegistry();
    metrics.defineCounter(
      "requests_total",
      "Total requests"
    );
    metrics.incrementCounter("requests_total", {
      status: "success",
    });
    metrics.incrementCounter("requests_total", {
      status: "success",
    });
    metrics.incrementCounter("requests_total", {
      status: "error",
    });

    const output = metrics.toPrometheus();
    expect(output).toContain(
      'requests_total{status="success"} 2'
    );
    expect(output).toContain(
      'requests_total{status="error"} 1'
    );
  });

  test("gauge sets and updates value", () => {
    const metrics = new MetricsRegistry();
    metrics.defineGauge(
      "active_sessions",
      "Active sessions"
    );
    metrics.setGauge("active_sessions", 5);

    let output = metrics.toPrometheus();
    expect(output).toContain("# TYPE active_sessions gauge");
    expect(output).toContain("active_sessions 5");

    metrics.setGauge("active_sessions", 3);
    output = metrics.toPrometheus();
    expect(output).toContain("active_sessions 3");
  });

  test("histogram records observations into buckets", () => {
    const metrics = new MetricsRegistry();
    metrics.defineHistogram(
      "duration_seconds",
      "Request duration",
      [0.01, 0.05, 0.1, 0.5, 1]
    );
    metrics.observeHistogram("duration_seconds", 0.03, {
      tool: "query",
    });
    metrics.observeHistogram("duration_seconds", 0.07, {
      tool: "query",
    });
    metrics.observeHistogram("duration_seconds", 0.5, {
      tool: "query",
    });

    const output = metrics.toPrometheus();
    expect(output).toContain("# TYPE duration_seconds histogram");
    // 0.03 fits in 0.05 bucket and above
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="0.01"} 0'
    );
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="0.05"} 1'
    );
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="0.1"} 2'
    );
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="0.5"} 3'
    );
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="1"} 3'
    );
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="+Inf"} 3'
    );
    expect(output).toContain(
      'duration_seconds_sum{tool="query"} 0.6'
    );
    expect(output).toContain(
      'duration_seconds_count{tool="query"} 3'
    );
  });

  test("histogram with multiple label sets", () => {
    const metrics = new MetricsRegistry();
    metrics.defineHistogram(
      "duration_seconds",
      "Request duration",
      [0.1, 1]
    );
    metrics.observeHistogram("duration_seconds", 0.05, {
      server: "a",
    });
    metrics.observeHistogram("duration_seconds", 0.5, {
      server: "b",
    });

    const output = metrics.toPrometheus();
    expect(output).toContain(
      'duration_seconds_bucket{server="a",le="0.1"} 1'
    );
    expect(output).toContain(
      'duration_seconds_bucket{server="b",le="0.1"} 0'
    );
  });

  test("empty registry returns empty string", () => {
    const metrics = new MetricsRegistry();
    expect(metrics.toPrometheus()).toBe("");
  });

  test("multiple metric types in output", () => {
    const metrics = new MetricsRegistry();
    metrics.defineCounter("calls_total", "Total calls");
    metrics.defineGauge("sessions", "Active sessions");
    metrics.incrementCounter("calls_total");
    metrics.setGauge("sessions", 2);

    const output = metrics.toPrometheus();
    expect(output).toContain("# TYPE calls_total counter");
    expect(output).toContain("# TYPE sessions gauge");
    expect(output).toContain("calls_total 1");
    expect(output).toContain("sessions 2");
  });
});
