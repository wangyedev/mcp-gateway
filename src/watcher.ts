import { watch, FSWatcher } from "chokidar";
import { loadConfig, Config } from "./config.js";

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private configPath: string,
    private onChange: (config: Config) => void,
    private onError?: (error: Error) => void
  ) {}

  start(): void {
    this.watcher = watch(this.configPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    this.watcher.on("change", () => {
      try {
        const config = loadConfig(this.configPath);
        this.onChange(config);
      } catch (error) {
        if (this.onError) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
