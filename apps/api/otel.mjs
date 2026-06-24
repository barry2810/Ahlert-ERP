import process from "node:process";

const enabled = String(process.env.OTEL_ENABLED || "").trim().toLowerCase();
if (enabled && enabled !== "true") {
  process.env.OTEL_SDK_DISABLED = "true";
}

if (process.env.OTEL_SDK_DISABLED !== "true") {
  const [{ NodeSDK }, { getNodeAutoInstrumentations }, { OTLPTraceExporter }] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/auto-instrumentations-node"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
  ]);

  const base =
    String(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "").trim() ||
    "http://localhost:4318";
  const url = /\/v1\/traces\/?$/.test(base) ? base : `${base.replace(/\/+$/, "")}/v1/traces`;

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  await sdk.start();
}
