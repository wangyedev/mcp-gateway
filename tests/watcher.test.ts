import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigWatcher } from "../src/watcher.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ConfigWatcher", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mcp-gateway-watcher-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "config.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("calls onChange when config file changes", async () => {
    writeFileSync(
      configPath,
      `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
`
    );

    const onChange = vi.fn();
    const watcher = new ConfigWatcher(configPath, onChange);
    watcher.start();

    // Modify the file
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(
      configPath,
      `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
  - name: github
    url: http://localhost:3002/mcp
`
    );

    // Wait for the watcher to fire
    await new Promise((r) => setTimeout(r, 1000));
    watcher.stop();

    expect(onChange).toHaveBeenCalled();
  });

  test("does not crash on invalid config during reload", async () => {
    writeFileSync(
      configPath,
      `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
`
    );

    const onChange = vi.fn();
    const onError = vi.fn();
    const watcher = new ConfigWatcher(configPath, onChange, onError);
    watcher.start();

    // Write invalid config
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(configPath, `invalid: [yaml: {{`);

    await new Promise((r) => setTimeout(r, 1000));
    watcher.stop();

    // onChange should not have been called, onError should have been called
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});
