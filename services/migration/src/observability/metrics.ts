/**
 * Metrics (Scope §55).
 *
 * An in-process counter/gauge/histogram registry with a Prometheus text
 * exposition endpoint. Deliberately dependency-free: the metric *names* are the
 * contract the scope specifies, and those must not change if the exporter is
 * later swapped for a vendor client.
 */

export const METRIC_NAMES = [
  'migration_records_processed_total',
  'migration_records_failed_total',
  'migration_files_processed_total',
  'migration_api_requests_total',
  'migration_api_errors_total',
  'migration_retry_total',
  'migration_duration',
  'migration_queue_depth',
  'migration_source_rate_limit_total',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export type Labels = Readonly<Record<string, string | number | undefined>>;

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return entries.map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
}

interface Histogram {
  count: number;
  sum: number;
  buckets: Map<number, number>;
}

const DURATION_BUCKETS_MS = [50, 250, 1_000, 5_000, 30_000, 120_000, 600_000, 3_600_000];

class Registry {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, Histogram>();

  increment(name: MetricName, labels: Labels = {}, by = 1): void {
    const key = `${name}{${labelKey(labels)}}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  gauge(name: MetricName, value: number, labels: Labels = {}): void {
    this.gauges.set(`${name}{${labelKey(labels)}}`, value);
  }

  observe(name: MetricName, valueMs: number, labels: Labels = {}): void {
    const key = `${name}{${labelKey(labels)}}`;
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = { count: 0, sum: 0, buckets: new Map(DURATION_BUCKETS_MS.map((b) => [b, 0])) };
      this.histograms.set(key, histogram);
    }
    histogram.count += 1;
    histogram.sum += valueMs;
    for (const bucket of DURATION_BUCKETS_MS) {
      if (valueMs <= bucket) histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
    }
  }

  /** Time an async operation into a duration histogram. */
  async time<T>(name: MetricName, labels: Labels, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.observe(name, Date.now() - start, labels);
    }
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters, ...this.gauges]);
  }

  /** Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${normalize(key)} ${value}`);
    for (const [key, value] of this.gauges) lines.push(`${normalize(key)} ${value}`);
    for (const [key, histogram] of this.histograms) {
      const { name, labels } = split(key);
      for (const [bucket, count] of histogram.buckets) {
        lines.push(`${name}_bucket{${join(labels, `le="${bucket}"`)}} ${count}`);
      }
      lines.push(`${name}_bucket{${join(labels, 'le="+Inf"')}} ${histogram.count}`);
      lines.push(`${name}_sum{${labels}} ${histogram.sum}`);
      lines.push(`${name}_count{${labels}} ${histogram.count}`);
    }
    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

function normalize(key: string): string {
  return key.replace('{}', '');
}
function split(key: string): { name: string; labels: string } {
  const index = key.indexOf('{');
  return { name: key.slice(0, index), labels: key.slice(index + 1, -1) };
}
function join(labels: string, extra: string): string {
  return labels ? `${labels},${extra}` : extra;
}

export const metrics = new Registry();
