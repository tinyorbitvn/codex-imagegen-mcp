// Prometheus text-format metrics, exposed at /metrics.
//
// Hand-rolled instead of pulling in prom-client: we only need 6 metrics,
// and every dependency added to the image is one more thing to patch
// when a CVE shows up.

interface Histogram {
  buckets: Map<number, number>;
  sum: number;
  count: number;
}

const BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600, 900];

function newHistogram(): Histogram {
  return { buckets: new Map(BUCKETS.map((b) => [b, 0])), sum: 0, count: 0 };
}

function observe(h: Histogram, seconds: number): void {
  for (const b of BUCKETS) if (seconds <= b) h.buckets.set(b, (h.buckets.get(b) ?? 0) + 1);
  h.sum += seconds;
  h.count += 1;
}

function renderHistogram(name: string, help: string, h: Histogram): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
  let cumulative = 0;
  for (const b of BUCKETS) {
    cumulative = h.buckets.get(b) ?? 0;
    lines.push(`${name}_bucket{le="${b}"} ${cumulative}`);
  }
  lines.push(`${name}_bucket{le="+Inf"} ${h.count}`);
  lines.push(`${name}_sum ${h.sum}`);
  lines.push(`${name}_count ${h.count}`);
  return lines.join("\n");
}

class Metrics {
  jobsTotal = 0;
  jobsRunning = 0;
  jobsFailedTotal = 0;
  jobDuration = newHistogram();
  codexDuration = newHistogram();
  uploadDuration = newHistogram();

  jobStarted(): void {
    this.jobsTotal += 1;
    this.jobsRunning += 1;
  }
  jobFinished(seconds: number, ok: boolean): void {
    this.jobsRunning = Math.max(0, this.jobsRunning - 1);
    if (!ok) this.jobsFailedTotal += 1;
    observe(this.jobDuration, seconds);
  }
  codexRan(seconds: number): void {
    observe(this.codexDuration, seconds);
  }
  uploaded(seconds: number): void {
    observe(this.uploadDuration, seconds);
  }

  render(): string {
    return [
      "# HELP imagegen_jobs_total Total number of image-generation jobs received",
      "# TYPE imagegen_jobs_total counter",
      `imagegen_jobs_total ${this.jobsTotal}`,
      "# HELP imagegen_jobs_running Number of jobs currently running",
      "# TYPE imagegen_jobs_running gauge",
      `imagegen_jobs_running ${this.jobsRunning}`,
      "# HELP imagegen_jobs_failed_total Total number of failed jobs",
      "# TYPE imagegen_jobs_failed_total counter",
      `imagegen_jobs_failed_total ${this.jobsFailedTotal}`,
      renderHistogram("imagegen_job_duration_seconds", "Time to complete one job", this.jobDuration),
      renderHistogram("codex_process_duration_seconds", "Time spent running the Codex process", this.codexDuration),
      renderHistogram("artifact_upload_duration_seconds", "Time spent uploading the artifact to S3", this.uploadDuration),
      "",
    ].join("\n");
  }
}

export const metrics = new Metrics();
