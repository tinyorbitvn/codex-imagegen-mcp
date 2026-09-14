// Khởi động OpenTelemetry (spec §22).
//
// Cụm đã có sẵn alloy-traces nhận OTLP ở observability — chart trỏ thẳng
// vào đó, KHÔNG dựng collector mới (spec §33 mục 2: kiểm thứ đã có trước
// khi thêm bản sao).
//
// Endpoint rỗng thì tắt hẳn: chạy local hoặc test không cần nó, và một
// exporter trỏ vào hư không sẽ nhả log lỗi mỗi vài giây.

import { log } from "@tinyorbit/contracts";

export async function startTelemetry(serviceName: string, endpoint: string): Promise<void> {
  if (!endpoint) {
    log.info("OTLP tắt (OTEL_EXPORTER_OTLP_ENDPOINT rỗng)", { service: serviceName });
    return;
  }
  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const sdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    });
    sdk.start();
    log.info("OTLP đã bật", { service: serviceName, endpoint });
  } catch (err) {
    // Telemetry hỏng KHÔNG được làm service không khởi động nổi — quan
    // sát được là thứ tốt để có, không phải điều kiện để chạy.
    log.warn("không bật được OTLP, service vẫn chạy", { service: serviceName, err });
  }
}
