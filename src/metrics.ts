type MetricType = "counter" | "gauge" | "histogram";

interface MetricDefinition {
  type: MetricType;
  help: string;
  buckets?: number[]; // histogram only
}

function labelsKey(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return "";
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
}

function formatLabels(key: string): string {
  return key ? `{${key}}` : "";
}

export class MetricsRegistry {
  private definitions = new Map<string, MetricDefinition>();
  private counters = new Map<string, Map<string, number>>();
  private gauges = new Map<string, number>();
  private histograms = new Map<
    string,
    Map<string, { buckets: number[]; counts: number[]; sum: number; count: number }>
  >();

  defineCounter(name: string, help: string): void {
    this.definitions.set(name, { type: "counter", help });
    if (!this.counters.has(name)) {
      this.counters.set(name, new Map());
    }
  }

  defineGauge(name: string, help: string): void {
    this.definitions.set(name, { type: "gauge", help });
  }

  defineHistogram(name: string, help: string, buckets: number[]): void {
    this.definitions.set(name, {
      type: "histogram",
      help,
      buckets: [...buckets].sort((a, b) => a - b),
    });
    if (!this.histograms.has(name)) {
      this.histograms.set(name, new Map());
    }
  }

  incrementCounter(
    name: string,
    labels?: Record<string, string>
  ): void {
    const map = this.counters.get(name);
    if (!map) return;
    const key = labelsKey(labels);
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observeHistogram(
    name: string,
    value: number,
    labels?: Record<string, string>
  ): void {
    const map = this.histograms.get(name);
    if (!map) return;
    const def = this.definitions.get(name);
    if (!def || !def.buckets) return;

    const key = labelsKey(labels);
    let entry = map.get(key);
    if (!entry) {
      entry = {
        buckets: def.buckets,
        counts: new Array(def.buckets.length + 1).fill(0), // +1 for +Inf
        sum: 0,
        count: 0,
      };
      map.set(key, entry);
    }

    for (let i = 0; i < entry.buckets.length; i++) {
      if (value <= entry.buckets[i]) {
        entry.counts[i]++;
      }
    }
    entry.counts[entry.buckets.length]++; // +Inf
    entry.sum += value;
    entry.count++;
  }

  toPrometheus(): string {
    const lines: string[] = [];

    for (const [name, def] of this.definitions) {
      if (def.type === "counter") {
        const map = this.counters.get(name);
        if (!map || map.size === 0) continue;
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} counter`);
        for (const [key, value] of map) {
          lines.push(`${name}${formatLabels(key)} ${value}`);
        }
      } else if (def.type === "gauge") {
        const value = this.gauges.get(name);
        if (value === undefined) continue;
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} gauge`);
        lines.push(`${name} ${value}`);
      } else if (def.type === "histogram") {
        const map = this.histograms.get(name);
        if (!map || map.size === 0) continue;
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} histogram`);
        for (const [key, entry] of map) {
          const baseLabels = key;
          for (let i = 0; i < entry.buckets.length; i++) {
            const leLabel = `le="${entry.buckets[i]}"`;
            const combined = baseLabels
              ? `${baseLabels},${leLabel}`
              : leLabel;
            lines.push(
              `${name}_bucket{${combined}} ${entry.counts[i]}`
            );
          }
          const infLabel = `le="+Inf"`;
          const infCombined = baseLabels
            ? `${baseLabels},${infLabel}`
            : infLabel;
          lines.push(
            `${name}_bucket{${infCombined}} ${entry.counts[entry.buckets.length]}`
          );
          lines.push(
            `${name}_sum${formatLabels(baseLabels)} ${entry.sum}`
          );
          lines.push(
            `${name}_count${formatLabels(baseLabels)} ${entry.count}`
          );
        }
      }
    }

    return lines.length > 0 ? lines.join("\n") + "\n" : "";
  }
}
