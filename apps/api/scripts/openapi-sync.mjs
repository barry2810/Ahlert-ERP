import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiVersions, buildApiDocsMetrics, buildOpenApiSpec, listDocumentedRawPaths, validateOpenApiSpec } from "../openapi-specs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "..");
const repoRoot = path.resolve(apiDir, "..", "..");
const siteOpenApiDir = path.join(repoRoot, "site", "openapi");
const serverPath = path.join(apiDir, "server.mjs");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function validateAgainstServerSource() {
  const src = fs.readFileSync(serverPath, "utf8");
  const missing = [];
  for (const rawPath of listDocumentedRawPaths()) {
    if (!src.includes(`url.pathname === "${rawPath}"`) && !src.includes(`url.pathname.startsWith("${rawPath}`)) {
      missing.push(rawPath);
    }
  }
  return { ok: missing.length === 0, missing };
}

function buildArtifacts() {
  ensureDir(siteOpenApiDir);
  const results = {};
  for (const versionKey of Object.keys(ApiVersions)) {
    const spec = buildOpenApiSpec(versionKey);
    const validation = validateOpenApiSpec(spec);
    if (!validation.ok) throw new Error(`openapi_validation_failed:${versionKey}:${validation.errors.join(",")}`);
    const outPath = path.join(siteOpenApiDir, `${versionKey}.json`);
    fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
    results[versionKey] = { outPath, validation };
  }
  const routeValidation = validateAgainstServerSource();
  if (!routeValidation.ok) throw new Error(`openapi_route_validation_failed:${routeValidation.missing.join(",")}`);
  const metrics = buildApiDocsMetrics(listDocumentedRawPaths());
  fs.writeFileSync(path.join(siteOpenApiDir, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n", "utf8");
  return { results, routeValidation, metrics };
}

const command = String(process.argv[2] || "build").trim().toLowerCase();

if (command === "build") {
  const result = buildArtifacts();
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
} else if (command === "validate") {
  const routeValidation = validateAgainstServerSource();
  const validations = Object.fromEntries(
    Object.keys(ApiVersions).map((versionKey) => [versionKey, validateOpenApiSpec(buildOpenApiSpec(versionKey))]),
  );
  const ok = routeValidation.ok && Object.values(validations).every((x) => x.ok);
  process.stdout.write(JSON.stringify({ ok, validations, routeValidation }) + "\n");
  if (!ok) process.exit(1);
} else {
  throw new Error("unsupported_command");
}
