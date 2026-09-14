// Start up OpenTelemetry.
//
// Points at whatever OTLP collector the OTEL_EXPORTER_OTLP_ENDPOINT
// environment variable names; this service does not stand up its own
// collector. Check what your observability stack already runs before
// wiring traces here — a second collector next to one you already have is
// just one more thing to operate.
//
// An empty endpoint turns this off entirely: running locally or under
// test doesn't need it, and an exporter pointed at nothing would spam
// error logs every few seconds.

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
    // A telemetry failure must NOT stop the service from starting —
    // observability is nice to have, not a precondition to run.
    log.warn("could not enable OTLP, service still running", { service: serviceName, err });
  }
}
