// Metric dạng Prometheus text, phơi ở /metrics (spec §31).
//
// Tự viết thay vì kéo prom-client: chỉ cần 6 metric, và mỗi dependency
// thêm vào image là thêm một thứ phải vá khi có CVE.

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
      "# HELP imagegen_jobs_total Tổng số job sinh ảnh đã nhận",
      "# TYPE imagegen_jobs_total counter",
      `imagegen_jobs_total ${this.jobsTotal}`,
      "# HELP imagegen_jobs_running Số job đang chạy",
      "# TYPE imagegen_jobs_running gauge",
      `imagegen_jobs_running ${this.jobsRunning}`,
      "# HELP imagegen_jobs_failed_total Tổng số job thất bại",
      "# TYPE imagegen_jobs_failed_total counter",
      `imagegen_jobs_failed_total ${this.jobsFailedTotal}`,
      renderHistogram("imagegen_job_duration_seconds", "Thời gian trọn một job", this.jobDuration),
      renderHistogram("codex_process_duration_seconds", "Thời gian chạy tiến trình Codex", this.codexDuration),
      renderHistogram("artifact_upload_duration_seconds", "Thời gian đẩy artifact lên S3", this.uploadDuration),
      "",
    ].join("\n");
  }
}

export const metrics = new Metrics();
