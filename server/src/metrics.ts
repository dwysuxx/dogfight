// A minimal Prometheus registry: counters only go up (rates come from
// rate() on the scraper), gauges are read at scrape time. Text format 0.0.4.
type Labels = Readonly<Record<string, string>>;

interface Metric {
  readonly name: string;
  readonly help: string;
  readonly type: "counter" | "gauge";
  samples(): Iterable<readonly [Labels, number]>;
}

export interface Counter {
  inc(labels?: Labels, by?: number): void;
}

const labelKey = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
const escapeLabel = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

export class Registry {
  readonly #metrics: Metric[] = [];

  counter(name: string, help: string): Counter {
    const values = new Map<string, [Labels, number]>();
    this.#metrics.push({ name, help, type: "counter", samples: () => values.values() });
    return {
      inc(labels = {}, by = 1) {
        const key = labelKey(labels);
        const current = values.get(key);
        if (current) current[1] += by;
        else values.set(key, [labels, by]);
      },
    };
  }

  // `read` returns one number, or labelled samples, when scraped.
  gauge(name: string, help: string, read: () => number | Iterable<readonly [Labels, number]>): void {
    this.#metrics.push({
      name,
      help,
      type: "gauge",
      samples: () => {
        const value = read();
        return typeof value === "number" ? [[{}, value] as const] : value;
      },
    });
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of this.#metrics) {
      lines.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`);
      for (const [labels, value] of metric.samples()) lines.push(`${metric.name}${formatLabels(labels)} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
