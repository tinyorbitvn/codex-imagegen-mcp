// Start OpenTelemetry.
//
// Point this at whatever OTLP collector you already run rather than
// standing up a new one just for this service.
//
// An empty endpoint disables it entirely: running locally or under test
// doesn't need it, and an exporter pointed at nothing would spam error
// logs every few seconds.

import { log } from "@tinyorbit/contracts";

export async function startTelemetry(serviceName: string, endpoint: string): Promise<void> {
  if (!endpoint) {
    log.info("OTLP disabled (OTEL_EXPORTER_OTLP_ENDPOINT is empty)", { service: serviceName });
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
    log.info("OTLP enabled", { service: serviceName, endpoint });
  } catch (err) {
    // A broken telemetry setup must NOT stop the service from starting —
    // observability is nice to have, not a condition for running.
    log.warn("failed to enable OTLP, service still running", { service: serviceName, err });
  }
}
