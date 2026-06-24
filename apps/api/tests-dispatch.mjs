import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

const base = String(process.env.TEST_BASE_URL || process.env.API_BASE_URL || "http://localhost:3000");
const debugServerUrl = "http://127.0.0.1:7777/event";
const debugSessionId = "notification-test-connrefused";

// #region debug-point A:test-http
async function debugReport(hypothesisId, msg, data = {}, runId = "pre-fix") {
  try {
    await fetch(debugServerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: debugSessionId,
        runId,
        hypothesisId,
        location: "apps/api/tests-dispatch.mjs:req",
        msg: `[DEBUG] ${msg}`,
        data,
        ts: Date.now(),
      }),
    });
  } catch {}
}
// #endregion

async function req(path, { method = "GET", headers = {}, body } = {}) {
  // #region debug-point B:req-start
  await debugReport("B", "request_start", { base, path, method });
  // #endregion
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        ...headers,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    // #region debug-point C:req-failed
    await debugReport("C", "request_failed", {
      base,
      path,
      method,
      error: error && error.message ? String(error.message) : String(error),
      causeCode: error && error.cause && error.cause.code ? String(error.cause.code) : null,
      causeErrors: error && error.cause && Array.isArray(error.cause.errors) ? error.cause.errors.map((item) => ({
        code: item && item.code ? String(item.code) : null,
        address: item && item.address ? String(item.address) : null,
        port: item && item.port ? Number(item.port) : null,
      })) : [],
    });
    // #endregion
    throw error;
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  // #region debug-point D:req-finished
  await debugReport("D", "request_finished", { base, path, method, status: res.status });
  // #endregion
  return { status: res.status, json, text, headers: Object.fromEntries(res.headers.entries()) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryUntil(fn, { timeoutMs = 10_000, intervalMs = 250 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn();
      if (last && last.ok) return last;
    } catch (e) {
      last = { ok: false, error: e && e.message ? String(e.message) : String(e) };
    }
    await sleep(intervalMs);
  }
  return last || { ok: false, error: "timeout" };
}

async function waitForApiReady({ timeoutMs = 30_000 } = {}) {
  return await retryUntil(
    async () => {
      try {
        const res = await fetch(`${base}/api/modules`);
        return res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` };
      } catch (error) {
        return { ok: false, error: error && error.message ? String(error.message) : String(error) };
      }
    },
    { timeoutMs, intervalMs: 500 },
  );
}

async function waitForJobDone(jobId, { timeoutMs = 30_000 } = {}) {
  return await retryUntil(
    async () => {
      const r = await req(`/api/jobs?id=${encodeURIComponent(jobId)}`, { headers: AdminHeaders });
      if (r.status !== 200) return { ok: false, error: `job_status_http_${r.status}` };
      const st = r.json?.item?.status;
      if (st === "succeeded") return { ok: true, status: st, item: r.json?.item };
      if (st === "failed" || st === "dead" || st === "cancelled") return { ok: false, error: `job_${st}`, item: r.json?.item };
      return { ok: false, error: "job_pending", item: r.json?.item };
    },
    { timeoutMs, intervalMs: 500 },
  );
}

async function reqBinary(path, { method = "GET", headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, headers: Object.fromEntries(res.headers.entries()) };
}

function iso(d) {
  return new Date(d).toISOString();
}

const AdminHeaders = { "x-user": "fleet_admin", "x-permissions": "FLEET_ADMIN" };
const ApproverAdminHeaders = { "x-user": "approver_admin", "x-permissions": "FLEET_ADMIN" };
const WorkshopAdminHeaders = { "x-user": "workshop_admin", "x-permissions": "WORKSHOP_ADMIN" };
const WorkshopLeadHeaders = { "x-user": "workshop_lead", "x-permissions": "WORKSHOP_ASSIGN,WORKSHOP_VIEW" };
const DriverHeaders = { "x-user": "driver_01", "x-permissions": "WORKSHOP_CREATE,WORKSHOP_VIEW" };
const DispatcherHeaders = { "x-user": "dispatcher", "x-permissions": "CREATE_BLOCK" };
const AuditorHeaders = { "x-user": "auditor", "x-permissions": "VIEW_AUDIT" };
const OverrideHeaders = { "x-user": "admin", "x-permissions": "OVERRIDE_DISPATCH" };
const OverrideHardHeaders = { "x-user": "admin", "x-permissions": "OVERRIDE_DISPATCH,OVERRIDE_HARD" };
const DocAdminHeaders = { "x-user": "doc_admin", "x-permissions": "DOCUMENT_ADMIN,DOCUMENT_VIEW,DOCUMENT_MANAGE,DOCUMENT_EXPORT,DOCUMENT_SIGN,DOCUMENT_CONTRACT_VIEW" };
const DocViewerHeaders = { "x-user": "doc_viewer", "x-permissions": "DOCUMENT_VIEW" };
const ContractViewerHeaders = { "x-user": "contract_viewer", "x-permissions": "DOCUMENT_VIEW,DOCUMENT_CONTRACT_VIEW" };
const DocSignerHeaders = { "x-user": "doc_signer_1", "x-permissions": "DOCUMENT_VIEW,DOCUMENT_SIGN,DOCUMENT_CONTRACT_VIEW" };
const MdmAdminHeaders = { "x-user": "mdm_admin", "x-permissions": "MDM_ADMIN,MDM_VIEW,MDM_MANAGE,MDM_LABEL,APPROVAL_APPROVE_MASTERDATA" };
const ControllingHeaders = { "x-user": "controlling_admin", "x-permissions": "CONTROLLING_VIEW,CONTROLLING_MANAGE,VIEW_AUDIT" };
const ReportingHeaders = { "x-user": "reporting_admin", "x-permissions": "REPORTING_VIEW,REPORTING_MANAGE,VIEW_AUDIT" };
const MobileHeaders = { "x-user": "mobile_tech_01", "x-permissions": "MOBILE_SYNC,WORKSHOP_VIEW,WORKSHOP_CREATE,WORKSHOP_WORK" };

function expectBadRequest(r, message) {
  assert.equal(r.status, 400);
  assert.equal(r.json?.error, "bad_request");
  assert.equal(r.json?.message, message);
}

function percentile(values, p) {
  const arr = Array.isArray(values) ? values.filter((x) => Number.isFinite(x)).slice() : [];
  if (arr.length === 0) return null;
  arr.sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(p * arr.length) - 1));
  return arr[idx];
}

async function approveUntilApplied(approvalId) {
  let applied = null;
  for (let i = 0; i < 5; i += 1) {
    const current = await req(`/api/approvals/request?id=${encodeURIComponent(approvalId)}`, { headers: ApproverAdminHeaders });
    assert.equal(current.status, 200);
    const status = current.json?.item?.status;
    if (status === "applied") return { item: current.json?.item, applied };
    const r = await req("/api/approvals/approve", { method: "POST", headers: ApproverAdminHeaders, body: { requestId: approvalId, reason: "test-approval" } });
    assert.equal(r.status, 200);
    if (r.json?.applied) applied = r.json?.applied;
    if (r.json?.item?.status === "applied") return { item: r.json?.item, applied };
  }
  throw new Error("approval_not_applied");
}

async function ensureAnyCatalogContainer() {
  const containers = await req("/api/catalog/containers?activeOnly=true", { headers: AuditorHeaders });
  assert.equal(containers.status, 200);
  const any = containers.json?.items?.[0] || null;
  if (any?.sourceKey) return any.sourceKey;
  const run = await req("/api/reconcile/ahlert24/run", { method: "POST", headers: AdminHeaders, body: { mode: "mock" } });
  assert.equal(run.status, 201);
  const containers2 = await req("/api/catalog/containers?activeOnly=true", { headers: AuditorHeaders });
  assert.equal(containers2.status, 200);
  const any2 = containers2.json?.items?.[0] || null;
  assert.ok(any2?.sourceKey);
  return any2.sourceKey;
}

async function pickUnblockedWasteVehicle({ windowStart, windowEnd }) {
  const vehicles = await req("/api/fleet/vehicles");
  assert.equal(vehicles.status, 200);
  const list = vehicles.json?.items || [];
  for (const v of list) {
    const d = await req(
      `/api/fleet/dispatch/decision?vehicleId=${encodeURIComponent(v.id)}&module=waste&${windowQuery(windowStart, windowEnd)}&siteDepot=GREVEN`,
    );
    if (d.status !== 200) continue;
    const hard = d.json?.hardBlocks || [];
    if (hard.length > 0) continue;
    if (d.json?.reasonCode === "manual_override") continue;
    if (d.json?.baseDecision !== "allow") continue;
    if (d.json?.decision !== "allow") continue;
    return { vehicleId: v.id, decision: d.json };
  }
  return null;
}

const now = new Date();
const baseTs = Date.UTC(2000, 0, 1) + Math.floor(Math.random() * 1_000_000) * 60_000;
const baseWindowStart = new Date(baseTs);
const baseWindowEnd = new Date(baseTs + 60 * 60 * 1000);
const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);

function windowQuery(start, end) {
  return `windowStart=${encodeURIComponent(iso(start))}&windowEnd=${encodeURIComponent(iso(end))}`;
}

const baseWindowQuery = windowQuery(baseWindowStart, baseWindowEnd);

const apiReady = await waitForApiReady({ timeoutMs: 30_000 });
assert.ok(apiReady && apiReady.ok, `api_not_ready:${apiReady && apiReady.error ? apiReady.error : "unknown"}`);

await req("/api/fleet/admin/vehicle-location", {
  method: "POST",
  headers: AdminHeaders,
  body: { vehicleId: "veh_01", homeDepot: "GREVEN", homeLat: 52.091, homeLon: 7.612 },
}).then((r) => assert.equal(r.status, 200));

{
  const legacy = await req("/api/modules");
  const v1 = await req("/api/v1/modules");
  const v2 = await req("/api/v2/modules");
  assert.equal(legacy.status, 200);
  assert.equal(v1.status, 200);
  assert.equal(v2.status, 200);
  assert.equal(legacy.headers["api-version"], "legacy");
  assert.equal(v1.headers["api-version"], "v1");
  assert.equal(v2.headers["api-version"], "v2");
  assert.equal(v1.headers["deprecation"], "true");
  assert.ok(!v2.headers["deprecation"]);

  const openapiV1 = await req("/api/docs/openapi/v1.json");
  const openapiV2 = await req("/api/docs/openapi/v2.json");
  const openapiVersioned = await req("/api/v2/docs/openapi.json");
  const validation = await req("/api/docs/validate");
  const metrics = await req("/api/docs/metrics");
  assert.equal(openapiV1.status, 200);
  assert.equal(openapiV2.status, 200);
  assert.equal(openapiVersioned.status, 200);
  assert.equal(validation.status, 200);
  assert.equal(metrics.status, 200);
  assert.equal(openapiV1.json?.openapi, "3.1.0");
  assert.equal(openapiV2.json?.openapi, "3.1.0");
  assert.equal(openapiV2.json?.info?.version, "2.0.0");
  assert.equal(validation.json?.ok, true);
  assert.ok((metrics.json?.item?.parallelVersionsSupported || 0) >= 2);
}

{
  const sim = await req("/api/observability/simulate?case=flaky&force=1", { headers: AuditorHeaders });
  assert.equal(sim.status, 500);
  assert.equal(sim.json?.error, "simulated_failure");
  const traceId = sim.headers["x-trace-id"] || "";
  assert.equal(traceId.length, 32);

  const m = await req("/api/metrics");
  assert.equal(m.status, 200);
  assert.ok((m.text || "").includes("ahlert_http_request_duration_ms_bucket"));
  assert.ok((m.text || "").includes("ahlert_erp_events_published_total"));

  if (process.env.OBS_VERIFY_STACK === "true") {
    const tempo = await retryUntil(
      async () => {
        const r = await fetch(`http://tempo:3200/api/traces/${encodeURIComponent(traceId)}`);
        const text = await r.text();
        return { ok: r.status === 200, status: r.status, text };
      },
      { timeoutMs: 15_000, intervalMs: 500 },
    );
    assert.equal(tempo.ok, true, `tempo_trace_not_found status=${tempo?.status}`);

    const nowNs = Date.now() * 1_000_000;
    const startNs = (Date.now() - 120_000) * 1_000_000;
    const logql = `{service="ahlert-erp-api"} | json | traceId="${traceId}"`;
    const lokiUrl =
      `http://loki:3100/loki/api/v1/query_range?query=${encodeURIComponent(logql)}&limit=50&start=${startNs}&end=${nowNs}`;
    const loki = await retryUntil(
      async () => {
        const r = await fetch(lokiUrl);
        const j = await r.json().catch(() => null);
        const count = Array.isArray(j?.data?.result) ? j.data.result.length : 0;
        return { ok: r.status === 200 && count > 0, status: r.status, count, json: j };
      },
      { timeoutMs: 20_000, intervalMs: 500 },
    );
    assert.equal(loki.ok, true, `loki_no_logs status=${loki?.status} count=${loki?.count}`);

    const promQuery = `sum(ahlert_http_requests_total{path=\"/api/observability/simulate\",status=\"500\"})`;
    const promUrl = `http://prometheus:9090/api/v1/query?query=${encodeURIComponent(promQuery)}`;
    const prom = await retryUntil(
      async () => {
        const r = await fetch(promUrl);
        const j = await r.json().catch(() => null);
        const v = j?.data?.result?.[0]?.value?.[1];
        const num = v !== undefined ? Number(v) : NaN;
        return { ok: r.status === 200 && Number.isFinite(num) && num >= 1, status: r.status, value: num };
      },
      { timeoutMs: 20_000, intervalMs: 500 },
    );
    assert.equal(prom.ok, true, `prom_metric_missing status=${prom?.status} value=${prom?.value}`);
  }
}

if (process.env.OBS_LOADTEST === "true") {
  const plannedRps = Math.max(1, Number(process.env.OBS_PLANNED_RPS || 20));
  const seconds = Math.max(5, Number(process.env.OBS_LOADTEST_SECONDS || 20));
  const maxInflight = Math.max(10, Number(process.env.OBS_MAX_INFLIGHT || 200));
  const path = "/api/healthz";

  const healthChecks = await Promise.all([
    fetch("http://loki:3100/ready").then((r) => r.status).catch(() => 0),
    fetch("http://tempo:3200/ready").then((r) => r.status).catch(() => 0),
    fetch("http://prometheus:9090/-/ready").then((r) => r.status).catch(() => 0),
  ]);
  assert.deepEqual(healthChecks, [200, 200, 200], `stack_not_ready loki/tempo/prom=${healthChecks.join(",")}`);

  async function runRps({ rps, label }) {
    const startedAt = Date.now();
    const endAt = startedAt + seconds * 1000;
    let sent = 0;
    let ok = 0;
    let errors = 0;
    let inflight = 0;
    const latencies = [];
    let sampleTraceId = "";

    async function fireOne() {
      inflight += 1;
      const t0 = Date.now();
      try {
        const res = await fetch(base + path, { headers: AuditorHeaders });
        const ms = Date.now() - t0;
        latencies.push(ms);
        if (res.status >= 200 && res.status < 300) ok += 1;
        else errors += 1;
        if (!sampleTraceId) {
          const tid = res.headers.get("x-trace-id") || "";
          if (tid.length === 32) sampleTraceId = tid;
        }
        await res.arrayBuffer().catch(() => null);
      } catch {
        const ms = Date.now() - t0;
        latencies.push(ms);
        errors += 1;
      } finally {
        inflight -= 1;
      }
    }

    while (Date.now() < endAt) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const targetSent = Math.floor(elapsed * rps);
      while (sent < targetSent && inflight < maxInflight && Date.now() < endAt) {
        sent += 1;
        void fireOne();
      }
      await sleep(5);
    }

    while (inflight > 0) await sleep(10);
    const p50 = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);
    const errorRate = sent > 0 ? errors / sent : 0;
    return { label, rps, seconds, sent, ok, errors, errorRate, p50, p95, p99, sampleTraceId };
  }

  const baseline = await runRps({ rps: plannedRps, label: "planned" });
  const overload = await runRps({ rps: plannedRps * 3, label: "planned_plus_200pct" });

  assert.ok(baseline.sent > 0 && overload.sent > 0, "loadtest_no_requests_sent");
  assert.ok(baseline.errorRate <= 0.01, `baseline_error_rate_too_high:${baseline.errorRate}`);
  assert.ok(overload.errorRate <= 0.01, `overload_error_rate_too_high:${overload.errorRate}`);
  if (baseline.p95 !== null && overload.p95 !== null) {
    assert.ok(overload.p95 <= baseline.p95 * 1.2, `p95_degraded baseline=${baseline.p95} overload=${overload.p95}`);
  }

  if (overload.sampleTraceId) {
    const tempo = await retryUntil(
      async () => {
        const r = await fetch(`http://tempo:3200/api/traces/${encodeURIComponent(overload.sampleTraceId)}`);
        return { ok: r.status === 200, status: r.status };
      },
      { timeoutMs: 20_000, intervalMs: 500 },
    );
    assert.equal(tempo.ok, true, `tempo_trace_not_found_after_load status=${tempo?.status}`);
  }
}

{
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.ok(databaseUrl, "DATABASE_URL_required_for_rbac_bootstrap_test");

  const expected = {
    pricing_approver_l1: ["APPROVAL_VIEW", "APPROVAL_APPROVE_PRICING_L1"],
    pricing_approver_l2: ["APPROVAL_VIEW", "APPROVAL_APPROVE_PRICING_L2"],
    billing_approver: ["APPROVAL_VIEW", "APPROVAL_APPROVE_BILLING"],
    masterdata_approver: ["APPROVAL_VIEW", "APPROVAL_APPROVE_MASTERDATA"],
    route_override_approver_l1: ["APPROVAL_VIEW", "APPROVAL_APPROVE_ROUTE_OVERRIDE_L1"],
    route_override_approver_l2: ["APPROVAL_VIEW", "APPROVAL_APPROVE_ROUTE_OVERRIDE_L2"],
  };

  const roleNames = Object.keys(expected);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const rows = await client.query(
      `
      select r.name as role_name, rp.permission_name as permission_name
      from auth_role r
      left join auth_role_permission rp on rp.role_id = r.id
      where r.name = any($1::text[]);
      `,
      [roleNames],
    );
    const got = new Map(roleNames.map((r) => [r, new Set()]));
    for (const row of rows.rows) {
      const rn = String(row.role_name || "");
      if (!got.has(rn)) continue;
      const pn = row.permission_name ? String(row.permission_name) : "";
      if (pn) got.get(rn).add(pn);
    }

    for (const roleName of roleNames) {
      const perms = got.get(roleName) || new Set();
      assert.ok(rows.rows.some((r) => r.role_name === roleName), `role_missing:${roleName}`);
      const want = new Set(expected[roleName]);
      assert.deepEqual(Array.from(perms).sort(), Array.from(want).sort(), `role_permissions_mismatch:${roleName}`);
    }
  } finally {
    await client.end();
  }
}

{
  const pdfBase64 = Buffer.from("%PDF-1.4\n%ERP-TEST\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8").toString("base64");
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAGUlEQVR4nGP8//8/AymAhSTVoxpGNQwpDQCDXQM7jf4OjwAAAABJRU5ErkJggg==";

  await req("/api/documents/metadata/fields", {
    method: "POST",
    headers: DocAdminHeaders,
    body: { docType: "contract", key: "contract_no", label: "Vertragsnummer", valueType: "text", required: true, filterable: true, fulltext: true },
  }).then((r) => assert.ok([201, 400].includes(r.status)));
  await req("/api/documents/metadata/fields", {
    method: "POST",
    headers: DocAdminHeaders,
    body: { docType: "contract", key: "customer_no", label: "Kundennummer", valueType: "text", required: false, filterable: true, fulltext: true },
  }).then((r) => assert.ok([201, 400].includes(r.status)));
  await req("/api/documents/metadata/fields", {
    method: "POST",
    headers: DocAdminHeaders,
    body: { docType: "photo", key: "order_id", label: "Auftrag", valueType: "text", required: false, filterable: true, fulltext: true },
  }).then((r) => assert.ok([201, 400].includes(r.status)));

  const contractNo = `CTR_${Math.floor(Math.random() * 1_000_000)}`;
  const custNo = `CUST_${Math.floor(Math.random() * 1_000_000)}`;
  const created = await req("/api/documents/upload", {
    method: "POST",
    headers: DocAdminHeaders,
    body: { docType: "contract", title: `Vertrag ${contractNo}`, filename: `${contractNo}.pdf`, mimeType: "application/pdf", contentBase64: pdfBase64, comment: "initial", metadata: { contract_no: contractNo, customer_no: custNo } },
  });
  assert.equal(created.status, 201);
  const contractDocId = created.json?.documentId;
  const contractVer1 = created.json?.versionId;
  assert.ok(contractDocId);
  assert.ok(contractVer1);

  const forbidListContracts = await req("/api/documents?docType=contract&limit=5", { headers: DocViewerHeaders });
  assert.equal(forbidListContracts.status, 403);
  const listNoType = await req("/api/documents?limit=100", { headers: DocViewerHeaders });
  assert.equal(listNoType.status, 200);
  assert.ok(!(listNoType.json?.items || []).some((x) => x.docType === "contract"));

  const contractDetail = await req(`/api/documents/document?id=${encodeURIComponent(contractDocId)}`, { headers: ContractViewerHeaders });
  assert.equal(contractDetail.status, 200);
  assert.equal(contractDetail.json?.item?.docType, "contract");
  assert.equal(contractDetail.json?.item?.metadata?.contract_no, contractNo);

  const addV2 = await req("/api/documents/version", {
    method: "POST",
    headers: DocAdminHeaders,
    body: { documentId: contractDocId, filename: `${contractNo}_v2.pdf`, mimeType: "application/pdf", contentBase64: pdfBase64, comment: "v2" },
  });
  assert.equal(addV2.status, 201);

  const versions = await req(`/api/documents/versions?documentId=${encodeURIComponent(contractDocId)}&limit=10`, { headers: ContractViewerHeaders });
  assert.equal(versions.status, 200);
  assert.ok((versions.json?.items || []).length >= 2);
  const v1 = (versions.json?.items || []).find((x) => x.versionNo === 1);
  assert.ok(v1?.id);
  const restore = await req("/api/documents/restore", { method: "POST", headers: DocAdminHeaders, body: { documentId: contractDocId, versionId: v1.id, comment: "restore v1" } });
  assert.equal(restore.status, 201);

  const updatedCust = `CUST_${Math.floor(Math.random() * 1_000_000)}`;
  const metaSet = await req("/api/documents/metadata/set", { method: "POST", headers: DocAdminHeaders, body: { documentId: contractDocId, metadata: { customer_no: updatedCust } } });
  assert.equal(metaSet.status, 200);

  const search = await req("/api/documents/search", { method: "POST", headers: ContractViewerHeaders, body: { docType: "contract", q: updatedCust, filters: [{ key: "customer_no", op: "eq", value: updatedCust }], limit: 20 } });
  assert.equal(search.status, 200);
  assert.ok((search.json?.items || []).some((x) => x.id === contractDocId));

  const photo = await req("/api/documents/upload", {
    method: "POST",
    headers: DocAdminHeaders,
    body: { docType: "photo", title: "Foto 1", filename: "p1.png", mimeType: "image/png", contentBase64: pngBase64, comment: "photo", metadata: { order_id: "ord_test_photo" } },
  });
  assert.equal(photo.status, 201);
  const photoVer = photo.json?.versionId;
  assert.ok(photoVer);
  const preview = await reqBinary(`/api/documents/version/content?id=${encodeURIComponent(photoVer)}`, { headers: DocViewerHeaders });
  assert.equal(preview.status, 200);
  assert.ok(String(preview.headers["content-type"] || "").startsWith("image/png"));
  assert.ok(preview.buf.length > 0);

  const photoMedia = await req(`/api/documents/media/analysis?versionId=${encodeURIComponent(photoVer)}`, { headers: DocViewerHeaders });
  assert.equal(photoMedia.status, 200);
  assert.equal(photoMedia.json?.item?.mediaKind, "image");
  assert.equal(photoMedia.json?.item?.status, "processed");

  const scanText = "RECHNUNG 4711\nKanalinspektion Schaden 2026\nBelegnr 9001";
  const scanDoc = await req("/api/documents/upload", {
    method: "POST",
    headers: DocAdminHeaders,
    body: { docType: "scan", title: "Scan Beleg", filename: "scan.txt", mimeType: "text/plain", contentBase64: Buffer.from(scanText, "utf8").toString("base64"), comment: "scan import", metadata: {} },
  });
  assert.equal(scanDoc.status, 201);
  const scanVersionId = scanDoc.json?.versionId;
  assert.ok(scanVersionId);
  const scanMedia = await req(`/api/documents/media/analysis?versionId=${encodeURIComponent(scanVersionId)}`, { headers: DocViewerHeaders });
  assert.equal(scanMedia.status, 200);
  assert.equal(scanMedia.json?.item?.mediaKind, "text");
  assert.equal(scanMedia.json?.item?.status, "processed");
  assert.ok(String(scanMedia.json?.item?.ocrText || "").includes("RECHNUNG 4711"));
  const forceScan = await req("/api/documents/media/process", { method: "POST", headers: DocAdminHeaders, body: { versionId: scanVersionId, force: true } });
  assert.equal(forceScan.status, 200);
  assert.equal(forceScan.json?.item?.status, "processed");

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const setKey = await req("/api/documents/signing-key", { method: "POST", headers: DocSignerHeaders, body: { alg: "ed25519", publicKeyPem } });
  assert.equal(setKey.status, 200);

  const signingPayload = await req(`/api/documents/signing-payload?versionId=${encodeURIComponent(contractVer1)}`, { headers: DocSignerHeaders });
  assert.equal(signingPayload.status, 200);
  const payloadText = signingPayload.json?.item?.payloadText;
  assert.ok(payloadText);
  const sig = crypto.sign(null, Buffer.from(payloadText, "utf8"), privateKey);
  const sigB64 = Buffer.from(sig).toString("base64");

  const signed = await req("/api/documents/sign", { method: "POST", headers: DocSignerHeaders, body: { versionId: contractVer1, alg: "ed25519", signatureBase64: sigB64, meta: { reason: "integration_test" } } });
  assert.equal(signed.status, 201);
  const signatureId = signed.json?.item?.id;
  assert.ok(signatureId);

  const sigs = await req(`/api/documents/signatures?versionId=${encodeURIComponent(contractVer1)}`, { headers: ContractViewerHeaders });
  assert.equal(sigs.status, 200);
  assert.ok((sigs.json?.items || []).some((x) => x.id === signatureId));

  const verify = await req(`/api/documents/signature/verify?signatureId=${encodeURIComponent(signatureId)}`, { headers: ContractViewerHeaders });
  assert.equal(verify.status, 200);
  assert.equal(verify.json?.item?.valid, true);

  const exportRes = await reqBinary(`/api/documents/export?documentId=${encodeURIComponent(contractDocId)}`, { headers: DocAdminHeaders });
  assert.equal(exportRes.status, 200);
  assert.ok(String(exportRes.headers["content-type"] || "").includes("application/pdf"));
  assert.ok(exportRes.buf.length > 0);
}

{
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.ok(databaseUrl, "DATABASE_URL_required_for_mdm_test");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let cust1 = null;
  let cust2 = null;
  let badCust = null;
  let extraIds = [];
  try {
    cust1 = `cus_${crypto.randomUUID().slice(0, 8)}`;
    cust2 = `cus_${crypto.randomUUID().slice(0, 8)}`;
    const vat = `DE${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0")}`;
    const email = `mdm.${Math.floor(Math.random() * 1_000_000)}@example.test`;
    await client.query(
      `
      insert into crm_customer
        (id, customer_no, name, legal_form, vat_id, billing_address, service_addresses, email, phone, payment_terms, active, meta, created_at, updated_at)
      values
        ($1,$2,$3,null,$4,$5::jsonb,'[]'::jsonb,$6,$7,'{}'::jsonb,true,'{}'::jsonb, now(), now()),
        ($8,$9,$10,null,$11,$12::jsonb,'[]'::jsonb,$13,$14,'{}'::jsonb,true,'{}'::jsonb, now(), now());
      `,
      [
        cust1,
        `CUST_${Math.floor(Math.random() * 1_000_000)}`,
        "Müller GmbH",
        vat,
        JSON.stringify({ street: "Hauptstr. 1", zip: "10115", city: "Berlin" }),
        email,
        "+49 30 1234567",
        cust2,
        `CUST_${Math.floor(Math.random() * 1_000_000)}`,
        "Mueller GMBH",
        vat,
        JSON.stringify({ street: "Hauptstraße 1", zip: "10115", city: "Berlin" }),
        email,
        "+49 (30) 123 4567",
      ],
    );

    extraIds = [];
    const truePairRefs = [[`crm_customer:${cust1}`, `crm_customer:${cust2}`]];
    const negativePairRefs = [];

    for (let i = 0; i < 25; i += 1) {
      const a = `cus_${crypto.randomUUID().slice(0, 8)}`;
      const b = `cus_${crypto.randomUUID().slice(0, 8)}`;
      const vat2 = `DE${String(100000000 + i).padStart(9, "0")}`;
      const email2 = `dup.${i}.${Math.floor(Math.random() * 1_000_000)}@example.test`;
      const prefix = String.fromCharCode(65 + i);
      const zip = String(10100 + i).padStart(5, "0");
      const phone = `+49 30 55${String(i).padStart(2, "0")}0000`;
      await client.query(
        `
        insert into crm_customer
          (id, customer_no, name, legal_form, vat_id, billing_address, service_addresses, email, phone, payment_terms, active, meta, created_at, updated_at)
        values
          ($1,$2,$3,null,$4,$5::jsonb,'[]'::jsonb,$6,$7,'{}'::jsonb,true,'{}'::jsonb, now(), now()),
          ($8,$9,$10,null,$11,$12::jsonb,'[]'::jsonb,$13,$14,'{}'::jsonb,true,'{}'::jsonb, now(), now());
        `,
        [
          a,
          `CUST_${Math.floor(Math.random() * 1_000_000)}`,
          `${prefix} Firma ${i} GmbH`,
          vat2,
          JSON.stringify({ street: `Ring ${i}`, zip, city: "Berlin" }),
          email2,
          phone,
          b,
          `CUST_${Math.floor(Math.random() * 1_000_000)}`,
          `${prefix} Firma ${i} GMBH`,
          vat2,
          JSON.stringify({ street: `Ringstr. ${i}`, zip, city: "Berlin" }),
          email2,
          phone,
        ],
      );
      extraIds.push(a, b);
      const refA = `crm_customer:${a}`;
      const refB = `crm_customer:${b}`;
      truePairRefs.push([refA, refB]);
    }

    for (let i = 0; i < 12; i += 1) {
      const leftId = `cus_${crypto.randomUUID().slice(0, 8)}`;
      const rightId = `cus_${crypto.randomUUID().slice(0, 8)}`;
      const leftEmail = `neg.left.${i}.${Math.floor(Math.random() * 1_000_000)}@example.test`;
      const rightEmail = `neg.right.${i}.${Math.floor(Math.random() * 1_000_000)}@example.test`;
      const leftVat = `DE${String(300000000 + i).padStart(9, "0")}`;
      const rightVat = `DE${String(400000000 + i).padStart(9, "0")}`;
      await client.query(
        `
        insert into crm_customer
          (id, customer_no, name, legal_form, vat_id, billing_address, service_addresses, email, phone, payment_terms, active, meta, created_at, updated_at)
        values
          ($1,$2,$3,null,$4,$5::jsonb,'[]'::jsonb,$6,$7,'{}'::jsonb,true,'{}'::jsonb, now(), now()),
          ($8,$9,$10,null,$11,$12::jsonb,'[]'::jsonb,$13,$14,'{}'::jsonb,true,'{}'::jsonb, now(), now());
        `,
        [
          leftId,
          `CUST_${Math.floor(Math.random() * 1_000_000)}`,
          `Nordstern Logistik ${i} AG`,
          leftVat,
          JSON.stringify({ street: `Elbpark ${i}`, zip: String(20000 + i), city: "Hamburg" }),
          leftEmail,
          `+49 40 700${String(i).padStart(2, "0")}00`,
          rightId,
          `CUST_${Math.floor(Math.random() * 1_000_000)}`,
          `Suedhafen Recycling ${i} SARL`,
          rightVat,
          JSON.stringify({ street: `Isarring ${i}`, zip: String(80000 + i), city: "Muenchen" }),
          rightEmail,
          `+49 89 800${String(i).padStart(2, "0")}00`,
        ],
      );
      extraIds.push(leftId, rightId);
      negativePairRefs.push([`crm_customer:${leftId}`, `crm_customer:${rightId}`]);
    }

    for (let i = 0; i < 100; i += 1) {
      const a = `cus_${crypto.randomUUID().slice(0, 8)}`;
      const email2 = `uniq.${i}.${Math.floor(Math.random() * 1_000_000)}@example.test`;
      const vat2 = `DE${String(200000000 + i).padStart(9, "0")}`;
      const name = `${crypto.randomUUID().slice(0, 8)} GmbH`;
      const zip = String(10200 + i).padStart(5, "0");
      await client.query(
        `
        insert into crm_customer
          (id, customer_no, name, legal_form, vat_id, billing_address, service_addresses, email, phone, payment_terms, active, meta, created_at, updated_at)
        values
          ($1,$2,$3,null,$4,$5::jsonb,'[]'::jsonb,$6,null,'{}'::jsonb,true,'{}'::jsonb, now(), now());
        `,
        [a, `CUST_${Math.floor(Math.random() * 1_000_000)}`, name, vat2, JSON.stringify({ street: `Uniq ${i}`, zip, city: "Berlin" }), email2],
      );
      extraIds.push(a);
    }

    const t0 = Date.now();
    const scan = await req("/api/mdm/scan", { method: "POST", headers: MdmAdminHeaders, body: { entityType: "customer", limitRecords: 2000, threshold: 0.7 } });
    const dt = Date.now() - t0;
    assert.equal(scan.status, 200);
    assert.equal(scan.json?.scan?.ok, true);
    assert.ok(dt < 60_000, "mdm_scan_should_finish");
    const scanned = Number(scan.json?.scan?.scanned) || 0;
    const perHour = scanned > 0 ? scanned / (dt / 3_600_000) : 0;
    assert.ok(perHour >= 10_000, "mdm_throughput_min_10k_per_hour");

    const forbidden = await req("/api/mdm/duplicates?entityType=customer&status=open&limit=10", { headers: DocViewerHeaders });
    assert.equal(forbidden.status, 403);

    const dups = await req("/api/mdm/duplicates?entityType=customer&status=open&limit=200", { headers: MdmAdminHeaders });
    assert.equal(dups.status, 200);
    assert.ok(Array.isArray(dups.json?.items));

    async function getExactCandidate(leftRef, rightRef) {
      const pair = await req(
        `/api/mdm/duplicates?entityType=customer&status=open&leftRef=${encodeURIComponent(leftRef)}&rightRef=${encodeURIComponent(rightRef)}&limit=5`,
        { headers: MdmAdminHeaders },
      );
      assert.equal(pair.status, 200);
      return (pair.json?.items || [])[0] || null;
    }

    let tp = 0;
    for (const [leftRef, rightRef] of truePairRefs) {
      const pair = await getExactCandidate(leftRef, rightRef);
      if (pair?.id) tp += 1;
    }

    assert.ok(negativePairRefs.length >= 10, "mdm_negative_pair_sample_min_10");

    let fp = 0;
    for (const [leftRef, rightRef] of negativePairRefs) {
      const pair = await getExactCandidate(leftRef, rightRef);
      if (pair?.id) fp += 1;
    }

    const recall = tp / Math.max(1, truePairRefs.length);
    const precision = tp / Math.max(1, tp + fp);
    assert.ok(recall >= 0.95, "mdm_recall_min_95pct");
    assert.ok(precision >= 0.97, "mdm_precision_min_97pct");

    const ref1 = `crm_customer:${cust1}`;
    const ref2 = `crm_customer:${cust2}`;
    const cand = await getExactCandidate(ref1, ref2);
    const candId = cand?.id || null;
    assert.ok(candId, "mdm_candidate_missing");

    const decide = await req("/api/mdm/duplicates/decide", { method: "POST", headers: MdmAdminHeaders, body: { id: candId, decision: "confirm", reason: "integration_test" } });
    assert.equal(decide.status, 200);

    const merge = await req("/api/mdm/golden/merge", { method: "POST", headers: MdmAdminHeaders, body: { entityType: "customer", sourceRefs: [ref1, ref2], reason: "integration_test" } });
    assert.equal(merge.status, 201);
    const goldenId = merge.json?.item?.goldenId;
    assert.ok(goldenId);
    const ev = await client.query(`select id from erp_event where event_type = 'MDM_GOLDEN_RECORD_UPSERTED' and aggregate_id = $1 order by occurred_at desc limit 1;`, [goldenId]);
    assert.ok((ev.rows || []).length >= 1, "mdm_event_missing");

    const golden = await req(`/api/mdm/golden?entityType=customer&sourceRef=${encodeURIComponent(ref1)}`, { headers: MdmAdminHeaders });
    assert.equal(golden.status, 200);
    assert.equal(golden.json?.item?.id, goldenId);
    assert.ok((golden.json?.item?.sourceRefs || []).includes(ref1));
    assert.ok((golden.json?.item?.sourceRefs || []).includes(ref2));
    assert.ok(golden.json?.item?.payload?.name);
    assert.ok(golden.json?.item?.payload?.vatId);

    const labeled = await req("/api/mdm/model/label", { method: "POST", headers: MdmAdminHeaders, body: { entityType: "customer", leftRef: ref1, rightRef: ref2, label: true } });
    assert.equal(labeled.status, 200);
    assert.equal(labeled.json?.item?.ok, true);

    badCust = `cus_${crypto.randomUUID().slice(0, 8)}`;
    await client.query(
      `
      insert into crm_customer
        (id, customer_no, name, legal_form, vat_id, billing_address, service_addresses, email, phone, payment_terms, active, meta, created_at, updated_at)
      values
        ($1,$2,$3,null,null,$4::jsonb,'[]'::jsonb,$5,null,'{}'::jsonb,true,'{}'::jsonb, now(), now());
      `,
      [badCust, `CUST_${Math.floor(Math.random() * 1_000_000)}`, "Testkunde", JSON.stringify({ street: "X", zip: "00000", city: "X" }), "invalid@@mail"],
    );
    await req("/api/mdm/scan", { method: "POST", headers: MdmAdminHeaders, body: { entityType: "customer", limitRecords: 5000, threshold: 0.95, qualityLimitRecords: 500 } }).then((r) => assert.equal(r.status, 200));
    const issues = await req("/api/mdm/issues?entityType=customer&status=open&limit=200", { headers: MdmAdminHeaders });
    assert.equal(issues.status, 200);
    const issue = (issues.json?.items || []).find((x) => x.sourceRef === `crm_customer:${badCust}` && x.issueType === "invalid_email");
    assert.ok(issue?.id);
    const resolved = await req("/api/mdm/issues/resolve", { method: "POST", headers: MdmAdminHeaders, body: { id: issue.id, resolution: "ignored" } });
    assert.equal(resolved.status, 200);
  } finally {
    try {
      if (badCust) await client.query(`delete from crm_customer where id = $1;`, [badCust]);
    } catch {}
    try {
      const all = [];
      if (cust1) all.push(cust1);
      if (cust2) all.push(cust2);
      if (Array.isArray(extraIds) && extraIds.length) all.push(...extraIds);
      if (all.length) await client.query(`delete from crm_customer where id = any($1::text[]);`, [Array.from(new Set(all))]);
    } catch {}
    try {
      if (cust1) await client.query(`delete from crm_customer where id = $1;`, [cust1]);
    } catch {}
    try {
      if (cust2) await client.query(`delete from crm_customer where id = $1;`, [cust2]);
    } catch {}
    await client.end();
  }
}

{
  const r = await req(`/api/fleet/dispatch/decision?vehicleId=veh_02&module=waste&${baseWindowQuery}`);
  assert.equal(r.status, 200);
  assert.equal(r.json?.baseDecision, "deny");
  assert.equal(r.json?.reasonCode, "missing_capability");
}

{
  const r = await req(`/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${baseWindowQuery}&siteDepot=MST`);
  assert.equal(r.status, 200);
  assert.equal(r.json?.baseDecision, "deny");
  assert.equal(r.json?.reasonCode, "wrong_depot");
}

{
  const r = await req(`/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${baseWindowQuery}&containerType=reefer`);
  assert.equal(r.status, 200);
  assert.equal(r.json?.baseDecision, "deny");
  assert.equal(r.json?.reasonCode, "container_type_not_supported");
}

{
  const r = await req(`/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${baseWindowQuery}&grapplerType=hazmat`);
  assert.equal(r.status, 200);
  assert.equal(r.json?.baseDecision, "deny");
  assert.equal(r.json?.reasonCode, "grappler_not_supported");
}

{
  const adrWindowStart = new Date(baseWindowStart.getTime() + 2 * 60 * 60 * 1000);
  const adrWindowEnd = new Date(baseWindowEnd.getTime() + 2 * 60 * 60 * 1000);
  const r = await req(`/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${windowQuery(adrWindowStart, adrWindowEnd)}&adrClass=1`);
  assert.equal(r.status, 200);
  assert.equal(r.json?.baseDecision, "deny");
  assert.equal(r.json?.reasonCode, "adr_not_supported");

  const overrideReq = await req("/api/fleet/dispatch/decision", {
    method: "POST",
    headers: OverrideHeaders,
    body: {
      vehicleId: "veh_01",
      module: "waste",
      windowStart: iso(adrWindowStart),
      windowEnd: iso(adrWindowEnd),
      decision: "allow",
      reason: "Selftest ADR-Override ohne Hard-Recht",
      context: { adrClass: "1" },
    },
  });
  assert.equal(overrideReq.status, 202);
  const approvalId = overrideReq.json?.approval?.id;
  assert.ok(approvalId);

  await approveUntilApplied(approvalId);
  const after = await req(`/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${windowQuery(adrWindowStart, adrWindowEnd)}&adrClass=1`);
  assert.equal(after.status, 200);
  assert.equal(after.json?.decision, "allow");
  assert.equal(after.json?.reasonCode, "manual_override");
}

{
  const r = await req(
    `/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${baseWindowQuery}&siteLat=52.5200&siteLon=13.4050&maxDistanceKm=50`,
  );
  assert.equal(r.status, 200);
  assert.equal(r.json?.baseDecision, "deny");
  assert.equal(r.json?.reasonCode, "distance_exceeded");
}

await req("/api/fleet/admin/depot", {
  method: "POST",
  headers: AdminHeaders,
  body: { code: "GREVEN", name: "Greven", lat: 52.091, lon: 7.612, utilization: 0.9 },
}).then((r) => assert.equal(r.status, 201));
await req("/api/fleet/admin/depot", {
  method: "POST",
  headers: AdminHeaders,
  body: { code: "MUENSTER", name: "Münster", lat: 51.962, lon: 7.628, utilization: 0.1 },
}).then((r) => assert.equal(r.status, 201));

{
  const r = await req(
    `/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${baseWindowQuery}&siteLat=52.0000&siteLon=7.7000&depotCandidates=GREVEN,MUENSTER&priorityUrgency=high&priorityCustomerTier=A`,
  );
  assert.equal(r.status, 200);
  assert.ok((r.json?.warnings || []).some((w) => w.code === "depot_recommended"));
}

{
  const shiftStart = new Date(baseWindowStart.getTime() + 2 * 60 * 60 * 1000);
  const shiftEnd = new Date(baseWindowStart.getTime() + 6 * 60 * 60 * 1000);
  const r = await req(
    `/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${baseWindowQuery}&shiftStart=${encodeURIComponent(iso(shiftStart))}&shiftEnd=${encodeURIComponent(iso(shiftEnd))}`,
  );
  assert.equal(r.status, 200);
  assert.equal(r.json?.baseDecision, "deny");
  assert.equal(r.json?.reasonCode, "shift_window_violation");
  assert.ok((r.json?.suggestions || []).some((s) => s.type === "adjust_window"));
}

const conflictWindowStart = new Date(baseWindowStart.getTime() + 4 * 60 * 60 * 1000);
const conflictWindowEnd = new Date(baseWindowEnd.getTime() + 4 * 60 * 60 * 1000);
await req("/api/fleet/admin/assignment", {
  method: "POST",
  headers: AdminHeaders,
  body: { vehicleId: "veh_01", driverId: "drv_01", module: "waste", windowStart: iso(conflictWindowStart), windowEnd: iso(conflictWindowEnd), orderId: "ord_test_1", routeId: "route_test_1" },
}).then((r) => assert.equal(r.status, 201));

{
  const r = await req(`/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${windowQuery(conflictWindowStart, conflictWindowEnd)}&driverId=drv_01`);
  assert.equal(r.status, 200);
  assert.equal(r.json?.baseDecision, "deny");
  assert.ok(["vehicle_time_conflict", "driver_time_conflict"].includes(r.json?.reasonCode));
}

await req("/api/fleet/admin/driver-binding", {
  method: "POST",
  headers: AdminHeaders,
  body: { vehicleId: "veh_01", driverId: "drv_01", driverName: "Fahrer 1", bindingType: "exclusive", active: true },
}).then((r) => assert.equal(r.status, 201));

{
  const r = await req(`/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${baseWindowQuery}&driverId=drv_02`);
  assert.equal(r.status, 200);
  assert.equal(r.json?.baseDecision, "deny");
  assert.equal(r.json?.reasonCode, "vehicle_exclusive_driver_mismatch");
}

await req("/api/fleet/admin/system-status", {
  method: "POST",
  headers: AdminHeaders,
  body: { vehicleId: "veh_01", system: "weigh", status: "down", source: "selftest", updatedAt: iso(now) },
}).then((r) => assert.equal(r.status, 201));

{
  const r = await req(`/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${baseWindowQuery}&weighRequired=true`);
  assert.equal(r.status, 200);
  assert.equal(r.json?.baseDecision, "deny");
  assert.equal(r.json?.reasonCode, "weigh_system_not_ok");
}

{
  const blockWindowStart = new Date(baseWindowStart.getTime() + 6 * 60 * 60 * 1000);
  const blockWindowEnd = new Date(baseWindowEnd.getTime() + 6 * 60 * 60 * 1000);
  const blockWindowQuery = windowQuery(blockWindowStart, blockWindowEnd);
  const denyHard = await req("/api/fleet/blocks", {
    method: "POST",
    headers: DispatcherHeaders,
    body: {
      vehicleId: "veh_01",
      sourceModule: "workshop",
      severity: "critical",
      lockType: "hard",
      reason: "Selftest: harte Sperre",
      startsAt: iso(new Date(blockWindowStart.getTime() - 60 * 60 * 1000)),
      reference: { entityType: "workshopCase", entityId: "ws_selftest_hard" },
    },
  });
  assert.equal(denyHard.status, 201);
  const createdBlockId = denyHard.json?.item?.id;
  assert.ok(createdBlockId);

  const evalHard = await req(`/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${blockWindowQuery}`);
  assert.equal(evalHard.status, 200);
  assert.equal(evalHard.json?.baseDecision, "deny");
  assert.equal(evalHard.json?.reasonCode, "hard_block");

  const overrideReq = await req("/api/fleet/dispatch/decision", {
    method: "POST",
    headers: OverrideHeaders,
    body: {
      vehicleId: "veh_01",
      module: "waste",
      windowStart: iso(blockWindowStart),
      windowEnd: iso(blockWindowEnd),
      decision: "allow",
      reason: "Selftest: Override ohne Hard-Recht",
    },
  });
  assert.equal(overrideReq.status, 202);
  const approvalId = overrideReq.json?.approval?.id;
  assert.ok(approvalId);
  await approveUntilApplied(approvalId);

  const after = await req(`/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&${blockWindowQuery}`, {
    headers: { "x-user": "admin", "x-permissions": "" },
  });
  assert.equal(after.status, 200);
  assert.equal(after.json?.decision, "allow");
  assert.equal(after.json?.baseDecision, "deny");
  assert.equal(after.json?.reasonCode, "manual_override");

  const closed = await req("/api/fleet/admin/blocks/close", {
    method: "POST",
    headers: AdminHeaders,
    body: { blockId: createdBlockId, closedReason: "Selftest Cleanup" },
  });
  assert.equal(closed.status, 200);
}

{
  const r = await req("/api/audit/logs?limit=50", { headers: AuditorHeaders });
  assert.equal(r.status, 200);
  const events = r.json?.items || [];
  assert.ok(events.some((e) => e.eventType === "DISPATCH_DECISION_EVALUATED"));
  assert.ok(events.some((e) => e.eventType === "DISPATCH_DECISION_OVERRIDDEN"));
  assert.ok(events.some((e) => e.eventType === "VEHICLE_SYSTEM_STATUS_SET"));
  assert.ok(events.some((e) => e.eventType === "DRIVER_BINDING_SET"));
  assert.ok(events.some((e) => e.eventType === "DEPOT_SET"));
  assert.ok(events.some((e) => e.eventType === "DISPATCH_ASSIGNMENT_CREATED"));
}

await req("/api/fleet/admin/system-status", {
  method: "POST",
  headers: AdminHeaders,
  body: { vehicleId: "veh_01", system: "weigh", status: "ok", source: "selftest_cleanup", updatedAt: iso(new Date()) },
}).then((r) => assert.equal(r.status, 201));

{
  const wasteCustomerNo = `CUST_${Math.floor(Math.random() * 1_000_000)}`;
  const customerReq = await req("/api/customers", {
    method: "POST",
    headers: AdminHeaders,
    body: { customerNo: wasteCustomerNo, name: "Testkunde Entsorgung", email: "test@example.invalid", active: true },
  });
  assert.equal(customerReq.status, 202);
  const approvalId = customerReq.json?.approval?.id;
  assert.ok(approvalId);
  await approveUntilApplied(approvalId);

  const anySourceKey = await ensureAnyCatalogContainer();

  const create = await req("/api/waste/orders", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      customerId: wasteCustomerNo,
      customerTier: "A",
      containerSourceKey: anySourceKey,
      serviceType: "deliver_pickup",
      windowDeliverStart: iso(baseWindowStart),
      windowDeliverEnd: iso(baseWindowEnd),
      site: { depot: "GREVEN", lat: 52.091, lon: 7.612, address: "Musterstraße 1, 48268 Greven" },
      priorityUrgency: "high",
      notes: "Selftest Waste Order",
    },
  });
  assert.equal(create.status, 201);
  const orderId = create.json?.order?.id;
  assert.ok(orderId);

  const validate = await req("/api/waste/orders/status", {
    method: "POST",
    headers: AdminHeaders,
    body: { id: orderId, toStatus: "validated", reason: "validated" },
  });
  assert.equal(validate.status, 200);

  const check = await req("/api/waste/orders/dispatch/check", {
    method: "POST",
    headers: AdminHeaders,
    body: { id: orderId, vehicleId: "veh_01", siteDepot: "GREVEN" },
  });
  assert.equal(check.status, 200);
  assert.ok(["allow", "deny"].includes(check.json?.decision?.decision));

  const assign = await req("/api/waste/orders/dispatch/assign", {
    method: "POST",
    headers: AdminHeaders,
    body: { id: orderId, vehicleId: "veh_01", driverId: "drv_01", reason: "scheduled" },
  });
  assert.ok([201, 409].includes(assign.status));
  if (assign.status === 201) {
    const toDelivered = await req("/api/waste/orders/status", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: orderId, toStatus: "delivered", reason: "delivered" },
    });
    assert.equal(toDelivered.status, 200);

    const toPickupRequested = await req("/api/waste/orders/status", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: orderId, toStatus: "pickup_requested", reason: "pickup_requested" },
    });
    assert.equal(toPickupRequested.status, 200);

    const toPickedUp = await req("/api/waste/orders/status", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: orderId, toStatus: "picked_up", reason: "picked_up" },
    });
    assert.equal(toPickedUp.status, 200);

    const weigh = await req("/api/waste/orders/weigh/mock", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: orderId, grossKg: 32000, tareKg: 14000 },
    });
    assert.equal(weigh.status, 201);
    assert.equal(weigh.json?.order?.status, "weighed");

    const invReq = await req("/api/waste/orders/invoice/mock", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: orderId, currency: "EUR", lines: [{ label: "Containerdienst", qty: 1, unitPriceCents: 19900 }] },
    });
    assert.equal(invReq.status, 202);
    const invApprovalId = invReq.json?.approval?.id;
    assert.ok(invApprovalId);
    await approveUntilApplied(invApprovalId);
    const invoiced = await req(`/api/waste/orders?id=${encodeURIComponent(orderId)}`, { headers: AdminHeaders });
    assert.equal(invoiced.status, 200);
    assert.equal(invoiced.json?.order?.status, "invoiced");

    const close = await req("/api/waste/orders/status", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: orderId, toStatus: "closed", reason: "closed" },
    });
    assert.equal(close.status, 200);
    assert.equal(close.json?.order?.status, "closed");

    const audit = await req("/api/audit/logs?limit=200", { headers: AuditorHeaders });
    assert.equal(audit.status, 200);
    const events = audit.json?.items || [];
    assert.ok(events.some((e) => e.eventType === "WASTE_ORDER_CREATED" && e.overrideId === orderId));
    assert.ok(events.some((e) => e.eventType === "WASTE_ORDER_STATUS_CHANGED" && e.overrideId === orderId));
    assert.ok(events.some((e) => e.eventType === "WASTE_ORDER_WEIGHED" && e.overrideId === orderId));
    assert.ok(events.some((e) => e.eventType === "WASTE_ORDER_INVOICED" && e.overrideId === orderId));
  }
}

{
  const wasteCustomerNo = `CUST_PRICE_${Math.floor(Math.random() * 1_000_000)}`;
  const customerReq = await req("/api/customers", {
    method: "POST",
    headers: AdminHeaders,
    body: { customerNo: wasteCustomerNo, name: "Testkunde Pricing", active: true },
  });
  assert.equal(customerReq.status, 202);
  const customerApprovalId = customerReq.json?.approval?.id;
  assert.ok(customerApprovalId);
  const customerApproval = await approveUntilApplied(customerApprovalId);
  assert.equal(customerApproval.applied?.ok, true);
  const customer = await req(`/api/customers?id=${encodeURIComponent(wasteCustomerNo)}`, { headers: AdminHeaders });
  assert.equal(customer.status, 200);
  const customerId = customer.json?.item?.id;
  assert.ok(customerId);

  const contractNo = `CON_${Math.floor(Math.random() * 1_000_000)}`;
  const contractReq = await req("/api/contracts", {
    method: "POST",
    headers: AdminHeaders,
    body: { contractNo, customerId, status: "active", validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10), title: "Testvertrag Rule Engine" },
  });
  assert.equal(contractReq.status, 202);
  const contractApprovalId = contractReq.json?.approval?.id;
  assert.ok(contractApprovalId);
  const contractApproval = await approveUntilApplied(contractApprovalId);
  assert.equal(contractApproval.applied?.ok, true);
  const contractId = contractApproval.applied?.item?.id;
  assert.ok(contractId);

  const materialCode = `MAT_${Math.floor(Math.random() * 1_000_000)}`;
  const pricingMaterialCode = `MAT_${Math.floor(Math.random() * 1_000_000)}`;
  const materialReq = await req("/api/items/materials", { method: "POST", headers: AdminHeaders, body: { code: materialCode, name: "Gemischte Abfälle", unit: "t", active: true } });
  assert.equal(materialReq.status, 202);
  const materialApprovalId = materialReq.json?.approval?.id;
  assert.ok(materialApprovalId);
  const materialApproval = await approveUntilApplied(materialApprovalId);
  assert.equal(materialApproval.applied?.ok, true);

  const pricingMaterialReq = await req("/api/items/materials", {
    method: "POST",
    headers: AdminHeaders,
    body: { code: pricingMaterialCode, name: "Wertstoffmix", unit: "t", active: true },
  });
  assert.equal(pricingMaterialReq.status, 202);
  const pricingMaterialApprovalId = pricingMaterialReq.json?.approval?.id;
  assert.ok(pricingMaterialApprovalId);
  const pricingMaterialApproval = await approveUntilApplied(pricingMaterialApprovalId);
  assert.equal(pricingMaterialApproval.applied?.ok, true);

  const plCode = `PL_${Math.floor(Math.random() * 1_000_000)}`;
  const validFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const pricelistReq = await req("/api/pricing/pricelists", {
    method: "POST",
    headers: AdminHeaders,
    body: { code: plCode, name: "Standardpreise", currency: "EUR", status: "active", validFrom },
  });
  assert.equal(pricelistReq.status, 202);
  const priceListApprovalId = pricelistReq.json?.approval?.id;
  assert.ok(priceListApprovalId);
  const pricelistApproval = await approveUntilApplied(priceListApprovalId);
  assert.equal(pricelistApproval.applied?.ok, true);
  const priceListId = pricelistApproval.applied?.item?.id;
  assert.ok(priceListId);
  assert.equal(pricelistApproval.applied?.item?.validFrom, validFrom);

  const svcItemReq = await req("/api/pricing/pricelists/items", {
    method: "POST",
    headers: AdminHeaders,
    body: { priceListId, itemType: "service", refCode: "deliver_pickup", unit: "order", minQty: 0, unitPriceCents: 15000 },
  });
  assert.equal(svcItemReq.status, 202);
  const svcApprovalId = svcItemReq.json?.approval?.id;
  assert.ok(svcApprovalId);
  await approveUntilApplied(svcApprovalId);

  const matItemReq = await req("/api/pricing/pricelists/items", {
    method: "POST",
    headers: AdminHeaders,
    body: { priceListId, itemType: "material", refCode: materialCode, unit: "t", minQty: 0, unitPriceCents: 9900 },
  });
  assert.equal(matItemReq.status, 202);
  const matApprovalId = matItemReq.json?.approval?.id;
  assert.ok(matApprovalId);
  await approveUntilApplied(matApprovalId);

  const pricingMatItemReq = await req("/api/pricing/pricelists/items", {
    method: "POST",
    headers: AdminHeaders,
    body: { priceListId, itemType: "material", refCode: pricingMaterialCode, unit: "t", minQty: 0, unitPriceCents: 9900 },
  });
  assert.equal(pricingMatItemReq.status, 202);
  const pricingMatApprovalId = pricingMatItemReq.json?.approval?.id;
  assert.ok(pricingMatApprovalId);
  await approveUntilApplied(pricingMatApprovalId);

  const feeCode = `CO2_${Math.floor(Math.random() * 1_000_000)}`;
  const feeReq = await req("/api/pricing/fees", {
    method: "POST",
    headers: AdminHeaders,
    body: { code: feeCode, name: "CO2-Abgabe", calculationMode: "per_ton", amountCents: 150, currency: "EUR", validFrom },
  });
  assert.equal(feeReq.status, 202);
  const feeApprovalId = feeReq.json?.approval?.id;
  assert.ok(feeApprovalId);
  await approveUntilApplied(feeApprovalId);

  const muniCode = `MUNI_${Math.floor(Math.random() * 1_000_000)}`;
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.ok(databaseUrl, "DATABASE_URL_required_for_business_rules_test");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const municipalityId = `mun_${crypto.randomUUID().slice(0, 12)}`;
  await client.query(
    `
    insert into waste_municipality
      (id, code, name, state, rules, active, created_at, updated_at)
    values
      ($1,$2,$3,'NRW','{}'::jsonb,true, now(), now());
    `,
    [municipalityId, muniCode, `Gemeinde ${muniCode}`],
  );
  await client.end();

  const denyRuleKey = `deny_muni_${crypto.randomUUID().slice(0, 8)}`;
  const denyRule = await req("/api/business-rules", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      ruleKey: denyRuleKey,
      name: "Kommunalregel blockiert Stoff",
      domain: "municipal_policy",
      priority: 900,
      stopOnMatch: true,
      conditions: { all: [{ path: "municipality.code", op: "eq", value: muniCode }, { path: "order.materialCode", op: "eq", value: materialCode }] },
      actions: [{ type: "deny", errorCode: "municipality_material_blocked", message: "Kommunalregel blockiert Material." }],
      tags: ["municipality", "waste"],
    },
  });
  assert.equal(denyRule.status, 200);
  assert.ok((denyRule.json?.items || []).some((x) => x.ruleKey === denyRuleKey));

  const evalRule = await req("/api/business-rules/evaluate", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      domains: ["municipal_policy"],
      context: { municipality: { code: muniCode }, order: { materialCode } },
    },
  });
  assert.equal(evalRule.status, 200);
  assert.ok((evalRule.json?.matches || []).some((x) => x.ruleKey === denyRuleKey));

  const anySourceKey = await ensureAnyCatalogContainer();
  const blocked = await req("/api/waste/orders", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      customerId: wasteCustomerNo,
      contractId,
      municipalityId: muniCode,
      customerTier: "A",
      containerSourceKey: anySourceKey,
      serviceType: "deliver_pickup",
      windowDeliverStart: iso(baseWindowStart),
      windowDeliverEnd: iso(baseWindowEnd),
      site: { depot: "GREVEN", lat: 52.091, lon: 7.612, address: "Preisstraße 1, 48268 Greven" },
      priorityUrgency: "normal",
      materialCode,
      plannedTons: 10,
      notes: "Blocked by municipal rule",
    },
  });
  expectBadRequest(blocked, "municipality_material_blocked");

  const markupRuleKey = `contract_markup_${crypto.randomUUID().slice(0, 8)}`;
  const markupRule = await req("/api/business-rules", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      ruleKey: markupRuleKey,
      name: "Vertragsaufschlag Service",
      domain: "contract_pricing_line",
      priority: 800,
      conditions: { all: [{ path: "contract.id", op: "eq", value: contractId }, { path: "line.itemType", op: "eq", value: "service" }, { path: "line.refCode", op: "eq", value: "deliver_pickup" }] },
      actions: [{ type: "adjust_unit_price", mode: "markup_pct", value: 10, target: { itemType: "service", refCode: "deliver_pickup" } }],
      tags: ["pricing", "contract"],
    },
  });
  assert.equal(markupRule.status, 200);

  const feeRuleKey2 = `muni_fee_${crypto.randomUUID().slice(0, 8)}`;
  const feeRule2 = await req("/api/business-rules", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      ruleKey: feeRuleKey2,
      name: "Kommunaler Zuschlag",
      domain: "municipal_pricing",
      priority: 700,
      conditions: { all: [{ path: "municipality.code", op: "eq", value: muniCode }] },
      actions: [{ type: "add_fee_line", refCode: "MUNI_SURCHARGE", label: "Kommunalzuschlag", unit: "order", qty: 1, amountCents: 2500 }],
      tags: ["pricing", "municipality"],
    },
  });
  assert.equal(feeRule2.status, 200);

  const create = await req("/api/waste/orders", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      customerId: wasteCustomerNo,
      contractId,
      municipalityId: muniCode,
      customerTier: "A",
      containerSourceKey: anySourceKey,
      serviceType: "deliver_pickup",
      windowDeliverStart: iso(baseWindowStart),
      windowDeliverEnd: iso(baseWindowEnd),
      site: { depot: "GREVEN", lat: 52.091, lon: 7.612, address: "Preisstraße 1, 48268 Greven" },
      priorityUrgency: "normal",
      materialCode: pricingMaterialCode,
      plannedTons: 10,
      notes: "Pricing Test",
    },
  });
  assert.equal(create.status, 201);
  const orderId = create.json?.order?.id;
  assert.ok(orderId);

  const calc1 = await req("/api/pricing/calculate", { method: "POST", headers: AdminHeaders, body: { orderId, priceListId } });
  assert.equal(calc1.status, 201);
  assert.ok(calc1.json?.calculationId);
  assert.equal(calc1.json?.currency, "EUR");
  assert.ok((calc1.json?.lines || []).length >= 2);
  const serviceLine = (calc1.json?.lines || []).find((x) => x.itemType === "service");
  assert.ok(serviceLine);
  assert.equal(serviceLine.unitPriceCents, 16500);
  assert.ok((calc1.json?.lines || []).some((x) => x.refCode === "MUNI_SURCHARGE" && x.totalCents === 2500));
  const calcDetail = await req(`/api/pricing/calculation?id=${encodeURIComponent(calc1.json?.calculationId)}`, { headers: AdminHeaders });
  assert.equal(calcDetail.status, 200);
  assert.ok((calcDetail.json?.item?.input?.ruleHits || []).some((x) => x.rule?.ruleKey === markupRuleKey));
  assert.ok((calcDetail.json?.item?.input?.ruleHits || []).some((x) => x.rule?.ruleKey === feeRuleKey2));

  const supplierReq = await req("/api/workshop/inventory/suppliers", {
    method: "POST",
    headers: AdminHeaders,
    body: { name: `Subunternehmer ${crypto.randomUUID().slice(0, 8)}`, contact: { email: "sub@example.com", phone: "+49-555-010" } },
  });
  assert.equal(supplierReq.status, 201);
  const supplierId = supplierReq.json?.item?.id;
  assert.ok(supplierId);

  const customerPortalPassword = "Portal123!";
  const subcontractorPortalPassword = "Portal456!";
  const customerPortalAccount = await req("/api/portal/accounts", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      portalType: "customer",
      displayName: "Kundenportal Test",
      email: `portal.customer.${crypto.randomUUID().slice(0, 8)}@example.com`,
      password: customerPortalPassword,
      customerId,
      settings: { modules: ["orders", "contracts", "documents"] },
    },
  });
  assert.equal(customerPortalAccount.status, 201);
  const customerPortalAccountId = customerPortalAccount.json?.item?.id;
  assert.ok(customerPortalAccountId);

  const subcontractorPortalAccount = await req("/api/portal/accounts", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      portalType: "subcontractor",
      displayName: "Subunternehmerportal Test",
      email: `portal.sub.${crypto.randomUUID().slice(0, 8)}@example.com`,
      password: subcontractorPortalPassword,
      supplierId,
      settings: { modules: ["orders", "routes"] },
    },
  });
  assert.equal(subcontractorPortalAccount.status, 201);
  const subcontractorPortalAccountId = subcontractorPortalAccount.json?.item?.id;
  assert.ok(subcontractorPortalAccountId);

  const portalDocReq = await req("/api/documents/upload", {
    method: "POST",
    headers: DocAdminHeaders,
    body: {
      docType: "contract",
      title: "Portalvertrag",
      filename: "portalvertrag.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("Portalvertrag fuer Kundenzugang", "utf8").toString("base64"),
      metadata: { customerId, contractId },
    },
  });
  assert.equal(portalDocReq.status, 201);
  const portalDocumentId = portalDocReq.json?.documentId;
  assert.ok(portalDocumentId);

  const docLink = await req("/api/portal/documents/link", {
    method: "POST",
    headers: AdminHeaders,
    body: { accountId: customerPortalAccountId, documentId: portalDocumentId, label: "Ihr Vertrag" },
  });
  assert.equal(docLink.status, 200);

  const validated = await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId, toStatus: "validated", reason: "validated" } });
  assert.equal(validated.status, 200);

  const check = await req("/api/waste/orders/dispatch/check", { method: "POST", headers: AdminHeaders, body: { id: orderId, vehicleId: "veh_01", siteDepot: "GREVEN" } });
  assert.equal(check.status, 200);

  const assign = await req("/api/waste/orders/dispatch/assign", { method: "POST", headers: AdminHeaders, body: { id: orderId, vehicleId: "veh_01", driverId: "drv_01", reason: "scheduled" } });
  assert.ok([201, 409].includes(assign.status));

  const routeCreate = await req("/api/waste/routes", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      day: new Date().toISOString().slice(0, 10),
      depotCode: "GREVEN",
      vehicleId: "veh_01",
      driverId: "drv_01",
      orderIds: [orderId],
      plannedStartAt: iso(baseWindowStart),
      slotMinutes: 30,
    },
  });
  assert.equal(routeCreate.status, 201);
  const routeId = routeCreate.json?.item?.id;
  assert.ok(routeId);

  const customerOrderAssignment = await req("/api/portal/assignments", {
    method: "POST",
    headers: AdminHeaders,
    body: { accountId: customerPortalAccountId, scopeType: "order", scopeId: orderId, accessLevel: "r" },
  });
  assert.equal(customerOrderAssignment.status, 200);

  const subcontractorRouteAssignment = await req("/api/portal/assignments", {
    method: "POST",
    headers: AdminHeaders,
    body: { accountId: subcontractorPortalAccountId, scopeType: "route", scopeId: routeId, accessLevel: "rw" },
  });
  assert.equal(subcontractorRouteAssignment.status, 200);

  const customerPortalLogin = await req("/api/portal/login", {
    method: "POST",
    body: { email: customerPortalAccount.json?.item?.email, password: customerPortalPassword },
  });
  assert.equal(customerPortalLogin.status, 200);
  const customerPortalHeaders = { Authorization: `Bearer ${customerPortalLogin.json?.accessToken}` };
  const customerPortalDash = await req("/api/portal/dashboard", { headers: customerPortalHeaders });
  assert.equal(customerPortalDash.status, 200);
  assert.equal(customerPortalDash.json?.account?.portalType, "customer");
  assert.ok((customerPortalDash.json?.recentOrders || []).some((x) => x.id === orderId));
  const customerPortalContracts = await req("/api/portal/contracts", { headers: customerPortalHeaders });
  assert.equal(customerPortalContracts.status, 200);
  assert.ok((customerPortalContracts.json?.items || []).some((x) => x.id === contractId));
  const customerPortalDocs = await req("/api/portal/documents", { headers: customerPortalHeaders });
  assert.equal(customerPortalDocs.status, 200);
  assert.ok((customerPortalDocs.json?.items || []).some((x) => x.document?.id === portalDocumentId));

  const subcontractorPortalLogin = await req("/api/portal/login", {
    method: "POST",
    body: { email: subcontractorPortalAccount.json?.item?.email, password: subcontractorPortalPassword },
  });
  assert.equal(subcontractorPortalLogin.status, 200);
  const subcontractorPortalHeaders = { Authorization: `Bearer ${subcontractorPortalLogin.json?.accessToken}` };
  const subcontractorPortalDash = await req("/api/portal/dashboard", { headers: subcontractorPortalHeaders });
  assert.equal(subcontractorPortalDash.status, 200);
  assert.equal(subcontractorPortalDash.json?.account?.portalType, "subcontractor");
  const subcontractorRoutes = await req("/api/portal/routes", { headers: subcontractorPortalHeaders });
  assert.equal(subcontractorRoutes.status, 200);
  assert.ok((subcontractorRoutes.json?.items || []).some((x) => x.id === routeId));
  const portalStatusUpdate = await req("/api/portal/orders/status", {
    method: "POST",
    headers: subcontractorPortalHeaders,
    body: { orderId, status: "scheduled" },
  });
  assert.equal(portalStatusUpdate.status, 200);
  assert.equal(portalStatusUpdate.json?.item?.status, "scheduled");
  const subcontractorAudit = await req("/api/portal/audit", { headers: subcontractorPortalHeaders });
  assert.equal(subcontractorAudit.status, 200);
  assert.ok((subcontractorAudit.json?.items || []).some((x) => x.action === "portal_login"));

  if (assign.status === 201) {
    await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId, toStatus: "delivered", reason: "delivered" } }).then((r) => assert.equal(r.status, 200));
    await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId, toStatus: "pickup_requested", reason: "pickup_requested" } }).then((r) => assert.equal(r.status, 200));
    await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId, toStatus: "picked_up", reason: "picked_up" } }).then((r) => assert.equal(r.status, 200));
    await req("/api/waste/orders/weigh/mock", { method: "POST", headers: AdminHeaders, body: { id: orderId, grossKg: 32000, tareKg: 14000 } }).then((r) => assert.equal(r.status, 201));
    const calc2 = await req("/api/pricing/calculate", { method: "POST", headers: AdminHeaders, body: { orderId, priceListId, force: true } });
    assert.equal(calc2.status, 201);
    assert.ok(calc2.json?.calculationId);
    const history = await req(`/api/pricing/calculations?orderId=${encodeURIComponent(orderId)}&limit=10`, { headers: AdminHeaders });
    assert.equal(history.status, 200);
    assert.ok((history.json?.items || []).length >= 2);

    const invReq = await req("/api/billing/waste/invoice-drafts", { method: "POST", headers: AdminHeaders, body: { orderId } });
    assert.equal(invReq.status, 202);
    const invApprovalId = invReq.json?.approval?.id;
    assert.ok(invApprovalId);
    const invApproval = await approveUntilApplied(invApprovalId);
    assert.equal(invApproval.applied?.ok, true);

    const invList = await req(`/api/billing/waste/invoice-drafts?orderId=${encodeURIComponent(orderId)}&limit=10`, { headers: AdminHeaders });
    assert.equal(invList.status, 200);
    assert.ok((invList.json?.items || []).length >= 1);
    const invDraft = (invList.json?.items || [])[0];
    assert.ok(invDraft?.id);
    assert.ok(Number.isFinite(Number(invDraft?.totalCents)));

    const contrib1 = await req(`/api/controlling/contribution?objectType=waste_order&objectId=${encodeURIComponent(orderId)}`, { headers: ControllingHeaders });
    assert.equal(contrib1.status, 200);
    const eur1 = (contrib1.json?.totals || []).find((x) => x.currency === "EUR") || null;
    assert.ok(eur1);
    assert.equal(eur1.revenueCents, Number(invDraft.totalCents));
    assert.equal(eur1.costCents, 0);
    assert.equal(eur1.contributionCents, Number(invDraft.totalCents));

    const costCreate = await req("/api/controlling/entries", {
      method: "POST",
      headers: ControllingHeaders,
      body: { entryType: "cost", objectType: "waste_order", objectId: orderId, currency: "EUR", amountCents: 1234, account: "cost_disposal", meta: { test: true } },
    });
    assert.equal(costCreate.status, 201);

    const contrib2 = await req(`/api/controlling/contribution?objectType=waste_order&objectId=${encodeURIComponent(orderId)}`, { headers: ControllingHeaders });
    assert.equal(contrib2.status, 200);
    const eur2 = (contrib2.json?.totals || []).find((x) => x.currency === "EUR") || null;
    assert.ok(eur2);
    assert.equal(eur2.revenueCents, Number(invDraft.totalCents));
    assert.equal(eur2.costCents, 1234);
    assert.equal(eur2.contributionCents, Number(invDraft.totalCents) - 1234);

    const entries = await req(`/api/controlling/entries?objectType=waste_order&objectId=${encodeURIComponent(orderId)}&limit=50`, { headers: ControllingHeaders });
    assert.equal(entries.status, 200);
    assert.ok((entries.json?.items || []).length >= 2);

    const day = new Date().toISOString().slice(0, 10);
    const mart = await req("/api/reporting/mart/refresh", { method: "POST", headers: ReportingHeaders, body: { fromDay: day, toDay: day } });
    assert.equal(mart.status, 202);
    assert.ok(mart.json?.jobId);
    const martDone = await waitForJobDone(mart.json.jobId, { timeoutMs: 60_000 });
    assert.equal(martDone.ok, true);

    const financeDaily = await req(`/api/reporting/mart/finance/daily?fromDay=${encodeURIComponent(day)}&toDay=${encodeURIComponent(day)}&limit=50`, { headers: ReportingHeaders });
    assert.equal(financeDaily.status, 200);
    assert.ok((financeDaily.json?.items || []).length >= 1);
    assert.ok((financeDaily.json?.items || []).some((x) => x.currency === "EUR" && Number(x.revenueCents) >= Number(invDraft.totalCents)));

    const wasteDaily = await req(`/api/reporting/mart/waste/daily?fromDay=${encodeURIComponent(day)}&toDay=${encodeURIComponent(day)}&limit=10`, { headers: ReportingHeaders });
    assert.equal(wasteDaily.status, 200);
    assert.ok((wasteDaily.json?.items || []).length >= 1);

    const wasteOrdersFact = await req(`/api/reporting/mart/waste/orders?limit=50`, { headers: ReportingHeaders });
    assert.equal(wasteOrdersFact.status, 200);
    assert.ok((wasteOrdersFact.json?.items || []).some((x) => x.orderId === orderId));

    const deviceId = `dev_${crypto.randomUUID().slice(0, 8)}`;
    const boot = await req(`/api/mobile/bootstrap?deviceId=${encodeURIComponent(deviceId)}`, { headers: MobileHeaders });
    assert.equal(boot.status, 200);
    assert.ok(Array.isArray(boot.json?.vehicles));

    const clientCaseId = `local_case_${crypto.randomUUID().slice(0, 8)}`;
    const opCreateId = `op_${crypto.randomUUID().slice(0, 12)}`;
    const pushCreate = await req("/api/mobile/sync/push", {
      method: "POST",
      headers: MobileHeaders,
      body: {
        deviceId,
        ops: [
          {
            opId: opCreateId,
            opType: "workshop_case_create",
            payload: {
              clientCaseId,
              vehicleId,
              title: "Offline: Werkstattfall",
              description: "Offline erfasst, spaeter synchronisiert.",
              severity: "warning",
              lockType: "soft",
              reporterRole: "driver",
            },
          },
        ],
      },
    });
    assert.equal(pushCreate.status, 202);
    assert.ok(pushCreate.json?.jobId);
    const pushCreateDone = await waitForJobDone(pushCreate.json.jobId, { timeoutMs: 60_000 });
    assert.equal(pushCreateDone.ok, true);
    const opList1 = await req(`/api/mobile/sync/ops?deviceId=${encodeURIComponent(deviceId)}&limit=10`, { headers: MobileHeaders });
    assert.equal(opList1.status, 200);
    const createdOp = (opList1.json?.items || []).find((x) => x.opId === opCreateId) || null;
    assert.ok(createdOp);
    assert.equal(createdOp.status, "applied");
    assert.ok(createdOp.result?.caseId);

    const opStatusId = `op_${crypto.randomUUID().slice(0, 12)}`;
    const pushStatus = await req("/api/mobile/sync/push", {
      method: "POST",
      headers: MobileHeaders,
      body: { deviceId, ops: [{ opId: opStatusId, opType: "workshop_case_status", payload: { caseId: clientCaseId, workState: "in_progress", reason: "mobile_offline_sync" } }] },
    });
    assert.equal(pushStatus.status, 202);
    const pushStatusDone = await waitForJobDone(pushStatus.json.jobId, { timeoutMs: 60_000 });
    assert.equal(pushStatusDone.ok, true);
    const opList2 = await req(`/api/mobile/sync/ops?deviceId=${encodeURIComponent(deviceId)}&limit=20`, { headers: MobileHeaders });
    assert.equal(opList2.status, 200);
    const statusOp = (opList2.json?.items || []).find((x) => x.opId === opStatusId) || null;
    assert.ok(statusOp);
    assert.equal(statusOp.status, "applied");

    const events = await req("/api/events?limit=50", { headers: AdminHeaders });
    assert.equal(events.status, 200);
    assert.ok(Array.isArray(events.json?.items));

    const billingFeed = await req("/api/events/consume?consumer=billing&limit=200", { headers: AdminHeaders });
    const reportingFeed = await req("/api/events/consume?consumer=reporting&limit=200", { headers: AdminHeaders });
    const mobileFeed = await req("/api/events/consume?consumer=mobile&limit=200", { headers: AdminHeaders });
    assert.equal(billingFeed.status, 200);
    assert.equal(reportingFeed.status, 200);
    assert.equal(mobileFeed.status, 200);
    assert.ok((billingFeed.json?.items || []).length > 0);
    assert.ok((reportingFeed.json?.items || []).length > 0);
    assert.ok((mobileFeed.json?.items || []).length > 0);

    const billingInvoiceEvent = (billingFeed.json?.items || []).find((x) => x.eventType === "WASTE_INVOICE_DRAFT_CREATED" && x.aggregateId === orderId);
    const reportingPricingEvent = (reportingFeed.json?.items || []).find((x) => x.eventType === "PRICING_CALCULATED" && x.aggregateId === orderId);
    const mobileOrderEvent = (mobileFeed.json?.items || []).find((x) => x.eventType === "WASTE_ORDER_STATUS_CHANGED" && x.aggregateId === orderId);
    assert.ok(billingInvoiceEvent);
    assert.ok(reportingPricingEvent);
    assert.ok(mobileOrderEvent);

    const billFail = await req("/api/events/fail", {
      method: "POST",
      headers: AdminHeaders,
      body: { consumer: "billing", eventId: billingInvoiceEvent.id, errorCode: "invoice_sink_down", errorMessage: "simulated" },
    });
    assert.equal(billFail.status, 201);

    const reportAck = await req("/api/events/ack", {
      method: "POST",
      headers: AdminHeaders,
      body: { consumer: "reporting", lastEventId: reportingPricingEvent.id },
    });
    assert.equal(reportAck.status, 200);

    const mobileAck = await req("/api/events/ack", {
      method: "POST",
      headers: AdminHeaders,
      body: { consumer: "mobile", lastEventId: mobileOrderEvent.id },
    });
    assert.equal(mobileAck.status, 200);

    const billingOffset = await req("/api/events/offset?consumer=billing", { headers: AdminHeaders });
    const reportingOffset = await req("/api/events/offset?consumer=reporting", { headers: AdminHeaders });
    const mobileOffset = await req("/api/events/offset?consumer=mobile", { headers: AdminHeaders });
    assert.equal(billingOffset.status, 200);
    assert.equal(reportingOffset.status, 200);
    assert.equal(mobileOffset.status, 200);
    assert.equal(billingOffset.json?.item?.lastEventId, null);
    assert.equal(reportingOffset.json?.item?.lastEventId, reportingPricingEvent.id);
    assert.equal(mobileOffset.json?.item?.lastEventId, mobileOrderEvent.id);

    const deliveries = await req("/api/events/deliveries?consumer=billing&limit=20", { headers: AdminHeaders });
    assert.equal(deliveries.status, 200);
    assert.ok((deliveries.json?.items || []).some((x) => x.eventId === billingInvoiceEvent.id && x.status === "failed"));
  }
}

{
  const r = await req("/api/reconcile/ahlert24/run", { method: "POST", headers: AdminHeaders, body: { mode: "mock" } });
  assert.equal(r.status, 201);
  assert.ok(r.json?.runId);
  assert.ok((r.json?.report?.summary?.counts?.findings?.total || 0) > 0);
  assert.ok((r.json?.catalogSync?.containers?.added || 0) >= 0);

  const list = await req("/api/reconcile/ahlert24/runs?limit=5", { headers: AuditorHeaders });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json?.items));
  assert.ok(list.json.items.some((x) => x.id === r.json.runId));

  const run = await req(`/api/reconcile/ahlert24/run?id=${encodeURIComponent(r.json.runId)}`, { headers: AuditorHeaders });
  assert.equal(run.status, 200);
  assert.equal(run.json?.item?.id, r.json.runId);
  assert.ok(Array.isArray(run.json?.item?.findings));

  const latest = await req("/api/reconcile/ahlert24/latest", { headers: AuditorHeaders });
  assert.equal(latest.status, 200);
  assert.ok(latest.json?.item?.id);
}

{
  const acceptance = {
    name: "gateA.acceptance.prodlike",
    startedAt: new Date().toISOString(),
    steps: [],
    negative: [],
    result: "unknown",
  };
  try {
    const anySourceKey = await ensureAnyCatalogContainer();
    const pick = await pickUnblockedWasteVehicle({ windowStart: baseWindowStart, windowEnd: baseWindowEnd });
    assert.ok(pick, "no_unblocked_waste_vehicle_found");
    acceptance.vehicleId = pick.vehicleId;
    const wasteCustomerNo = `CUST_ACC_${Math.floor(Math.random() * 1_000_000)}`;
    const customerReq = await req("/api/customers", { method: "POST", headers: AdminHeaders, body: { customerNo: wasteCustomerNo, name: "Testkunde Acceptance", active: true } });
    assert.equal(customerReq.status, 202);
    const custApprovalId = customerReq.json?.approval?.id;
    assert.ok(custApprovalId);
    await approveUntilApplied(custApprovalId);

    const create = await req("/api/waste/orders", {
      method: "POST",
      headers: AdminHeaders,
      body: {
        customerId: wasteCustomerNo,
        customerTier: "A",
        containerSourceKey: anySourceKey,
        serviceType: "deliver_pickup",
        windowDeliverStart: iso(baseWindowStart),
        windowDeliverEnd: iso(baseWindowEnd),
        site: { depot: "GREVEN", lat: 52.091, lon: 7.612, address: "Musterstraße 2, 48268 Greven" },
        priorityUrgency: "high",
        notes: "GateA acceptance (prodlike, no overrides)",
      },
    });
    assert.equal(create.status, 201);
    const orderId = create.json?.order?.id;
    assert.ok(orderId);
    acceptance.orderId = orderId;
    acceptance.steps.push({ step: "create", status: create.json?.order?.status });

    const validated = await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId, toStatus: "validated", reason: "validated" } });
    assert.equal(validated.status, 200);
    acceptance.steps.push({ step: "validated", status: validated.json?.order?.status });

    const check = await req("/api/waste/orders/dispatch/check", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: orderId, vehicleId: pick.vehicleId, siteDepot: "GREVEN" },
    });
    assert.equal(check.status, 200);
    assert.equal(check.json?.decision?.baseDecision, "allow");
    assert.equal(check.json?.decision?.decision, "allow");
    assert.ok((check.json?.decision?.hardBlocks || []).length === 0);
    acceptance.steps.push({ step: "dispatch_check", decision: check.json?.decision?.decision, baseDecision: check.json?.decision?.baseDecision, reasonCode: check.json?.decision?.reasonCode });

    const assign = await req("/api/waste/orders/dispatch/assign", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: orderId, vehicleId: pick.vehicleId, driverId: "drv_02", reason: "scheduled" },
    });
    assert.equal(assign.status, 201);
    acceptance.steps.push({ step: "assign", status: assign.json?.order?.status, assignmentId: assign.json?.assignmentId });

    const delivered = await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId, toStatus: "delivered", reason: "delivered" } });
    assert.equal(delivered.status, 200);
    const pickupRequested = await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId, toStatus: "pickup_requested", reason: "pickup_requested" } });
    assert.equal(pickupRequested.status, 200);
    const pickedUp = await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId, toStatus: "picked_up", reason: "picked_up" } });
    assert.equal(pickedUp.status, 200);
    acceptance.steps.push({ step: "picked_up", status: pickedUp.json?.order?.status });

    const weigh = await req("/api/waste/orders/weigh/mock", { method: "POST", headers: AdminHeaders, body: { id: orderId, grossKg: 32000, tareKg: 14000 } });
    assert.equal(weigh.status, 201);
    acceptance.steps.push({ step: "weigh_mock", status: weigh.json?.order?.status });

    const invReq = await req("/api/waste/orders/invoice/mock", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: orderId, currency: "EUR", lines: [{ label: "Containerdienst", qty: 1, unitPriceCents: 19900 }] },
    });
    assert.equal(invReq.status, 202);
    const invApprovalId = invReq.json?.approval?.id;
    assert.ok(invApprovalId);
    await approveUntilApplied(invApprovalId);
    const afterInv = await req(`/api/waste/orders?id=${encodeURIComponent(orderId)}`, { headers: AdminHeaders });
    assert.equal(afterInv.status, 200);
    acceptance.steps.push({ step: "invoice_mock", status: afterInv.json?.order?.status });

    const closed = await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId, toStatus: "closed", reason: "closed" } });
    assert.equal(closed.status, 200);
    acceptance.steps.push({ step: "closed", status: closed.json?.order?.status });

    const badKey = await req("/api/waste/orders", {
      method: "POST",
      headers: AdminHeaders,
      body: {
        customerId: "cust_badkey",
        containerSourceKey: "does_not_exist:0:x",
        serviceType: "deliver_pickup",
        windowDeliverStart: iso(baseWindowStart),
        windowDeliverEnd: iso(baseWindowEnd),
        site: { depot: "GREVEN" },
      },
    });
    expectBadRequest(badKey, "container_not_found_or_inactive");
    acceptance.negative.push({ case: "invalid_containerSourceKey", status: "pass", http: badKey.status, message: badKey.json?.message });

    const noPermCreate = await req("/api/waste/orders", {
      method: "POST",
      headers: AuditorHeaders,
      body: {
        customerId: "cust_noperm",
        containerSourceKey: anySourceKey,
        serviceType: "deliver_pickup",
        windowDeliverStart: iso(baseWindowStart),
        windowDeliverEnd: iso(baseWindowEnd),
        site: { depot: "GREVEN" },
      },
    });
    assert.ok([401, 403].includes(noPermCreate.status));
    acceptance.negative.push({ case: "missing_permission_create", status: "pass", http: noPermCreate.status });

    const illegal = await req("/api/waste/orders", {
      method: "POST",
      headers: AdminHeaders,
      body: {
        customerId: wasteCustomerNo,
        containerSourceKey: anySourceKey,
        serviceType: "deliver_pickup",
        windowDeliverStart: iso(baseWindowStart),
        windowDeliverEnd: iso(baseWindowEnd),
        site: { depot: "GREVEN" },
      },
    });
    assert.equal(illegal.status, 201);
    const illegalId = illegal.json?.order?.id;
    assert.ok(illegalId);
    const illegalClose = await req("/api/waste/orders/status", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: illegalId, toStatus: "closed", reason: "close_illegally" },
    });
    expectBadRequest(illegalClose, "invalid_status_transition");
    acceptance.negative.push({ case: "illegal_status_transition_created_to_closed", status: "pass", http: illegalClose.status, message: illegalClose.json?.message });

    const illegalInvoice = await req("/api/waste/orders/invoice/mock", {
      method: "POST",
      headers: AdminHeaders,
      body: { id: illegalId, currency: "EUR", lines: [{ label: "X", qty: 1, unitPriceCents: 100 }] },
    });
    expectBadRequest(illegalInvoice, "order_not_weighed");
    acceptance.negative.push({ case: "invoice_before_weighed", status: "pass", http: illegalInvoice.status, message: illegalInvoice.json?.message });

    const illegalWeigh = await req("/api/waste/orders/weigh/mock", { method: "POST", headers: AdminHeaders, body: { id: illegalId, grossKg: 1000, tareKg: 500 } });
    expectBadRequest(illegalWeigh, "order_not_picked_up");
    acceptance.negative.push({ case: "weigh_before_picked_up", status: "pass", http: illegalWeigh.status, message: illegalWeigh.json?.message });

    acceptance.result = "pass";
  } catch (e) {
    acceptance.result = "fail";
    acceptance.error = String(e && e.message ? e.message : e);
  } finally {
    acceptance.finishedAt = new Date().toISOString();
    console.log("GATE_A_ACCEPTANCE_REPORT=" + JSON.stringify(acceptance));
    assert.equal(acceptance.result, "pass");
  }
}

{
  const anySourceKey = await ensureAnyCatalogContainer();
  const routeWindowStart = new Date(baseWindowStart.getTime() + 24 * 60 * 60 * 1000);
  const routeWindowEnd = new Date(baseWindowEnd.getTime() + 24 * 60 * 60 * 1000);
  const pick = await pickUnblockedWasteVehicle({ windowStart: routeWindowStart, windowEnd: routeWindowEnd });
  assert.ok(pick, "no_unblocked_waste_vehicle_found");

  const day = iso(routeWindowStart).slice(0, 10);
  const wasteCustomerNo = `CUST_ROUTE_${Math.floor(Math.random() * 1_000_000)}`;
  {
    const customerReq = await req("/api/customers", { method: "POST", headers: AdminHeaders, body: { customerNo: wasteCustomerNo, name: "Testkunde Route", active: true } });
    assert.equal(customerReq.status, 202);
    const approvalId = customerReq.json?.approval?.id;
    assert.ok(approvalId);
    await approveUntilApplied(approvalId);
  }

  const create1 = await req("/api/waste/orders", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      customerId: wasteCustomerNo,
      customerTier: "A",
      containerSourceKey: anySourceKey,
      serviceType: "deliver_pickup",
      windowDeliverStart: iso(routeWindowStart),
      windowDeliverEnd: iso(routeWindowEnd),
      site: { depot: "GREVEN", lat: 52.091, lon: 7.612, address: "Routenstraße 1, 48268 Greven" },
      priorityUrgency: "high",
      notes: "Route Test 1",
    },
  });
  assert.equal(create1.status, 201);
  const orderId1 = create1.json?.order?.id;
  assert.ok(orderId1);

  const create2 = await req("/api/waste/orders", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      customerId: wasteCustomerNo,
      customerTier: "A",
      containerSourceKey: anySourceKey,
      serviceType: "deliver_pickup",
      windowDeliverStart: iso(routeWindowStart),
      windowDeliverEnd: iso(routeWindowEnd),
      site: { depot: "GREVEN", lat: 52.091, lon: 7.613, address: "Routenstraße 2, 48268 Greven" },
      priorityUrgency: "normal",
      notes: "Route Test 2",
    },
  });
  assert.equal(create2.status, 201);
  const orderId2 = create2.json?.order?.id;
  assert.ok(orderId2);

  await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId1, toStatus: "validated", reason: "validated" } }).then((r) =>
    assert.equal(r.status, 200),
  );
  await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId2, toStatus: "validated", reason: "validated" } }).then((r) =>
    assert.equal(r.status, 200),
  );

  const plan = await req("/api/waste/routes/plan", {
    method: "POST",
    headers: AdminHeaders,
    body: { day, depotCode: "GREVEN", vehicleId: pick.vehicleId, orderIds: [orderId1, orderId2], routeStartAt: iso(routeWindowStart), slotMinutes: 30 },
  });
  assert.equal(plan.status, 201);
  const routeId = plan.json?.routeId;
  assert.ok(routeId);
  assert.ok((plan.json?.assigned || []).length >= 1);

  const route = await req(`/api/waste/route?id=${encodeURIComponent(routeId)}`, { headers: AdminHeaders });
  assert.equal(route.status, 200);
  const routed = route.json?.stops || [];
  assert.ok(routed.some((s) => s.orderId === orderId1));
  assert.ok(routed.some((s) => s.orderId === orderId2));

  const planAgain = await req("/api/waste/routes/plan", {
    method: "POST",
    headers: AdminHeaders,
    body: { day, depotCode: "GREVEN", vehicleId: pick.vehicleId, orderIds: [orderId1, orderId2], routeStartAt: iso(baseWindowStart), slotMinutes: 30 },
  });
  assert.equal(planAgain.status, 201);
  assert.equal((planAgain.json?.assigned || []).length, 0);
  assert.ok((planAgain.json?.skipped || []).length >= 2);
}

{
  const day = new Date().toISOString().slice(0, 10);
  const status = await req(`/api/disposition/integrations/status?day=${encodeURIComponent(day)}&depotCode=GREVEN`, { headers: AdminHeaders });
  assert.equal(status.status, 200);
  assert.ok(status.json?.integrations?.here);
  assert.equal(typeof status.json.integrations.here.configured, "boolean");
}

{
  const workshop = {
    name: "workshop.vehicle-core.integration",
    startedAt: new Date().toISOString(),
    steps: [],
    result: "unknown",
  };
  try {
    const existing = await req("/api/workshop/cases?status=open&limit=200", { headers: AuditorHeaders });
    assert.equal(existing.status, 200);
    for (const c of existing.json?.items || []) {
      const title = String(c?.title || "");
      const caseId = String(c?.id || "");
      if (!caseId) continue;
      if (!title.startsWith("Integrationstest:")) continue;
      await req("/api/workshop/cases/close", {
        method: "POST",
        headers: WorkshopAdminHeaders,
        body: { caseId, closedReason: "Integrationstest Cleanup (preflight)" },
      });
    }

    const vehicles = await req("/api/fleet/vehicles");
    assert.equal(vehicles.status, 200);
    const wasteVehicleIds = (vehicles.json?.items || [])
      .filter((v) => Array.isArray(v?.capabilities) && v.capabilities.includes("waste"))
      .map((v) => v.id)
      .filter(Boolean);

    const blocks = await req("/api/fleet/blocks?activeOnly=true");
    assert.equal(blocks.status, 200);
    for (const b of blocks.json?.items || []) {
      if (b?.lockType !== "hard") continue;
      if (!wasteVehicleIds.includes(b?.vehicleId)) continue;
      await req("/api/fleet/admin/blocks/close", {
        method: "POST",
        headers: AdminHeaders,
        body: { blockId: b.id, closedReason: "Integrationstest Cleanup (preflight)" },
      });
    }

    const windowStart = new Date();
    const windowEnd = new Date(windowStart.getTime() + 60 * 60 * 1000);

    const pick = await pickUnblockedWasteVehicle({ windowStart, windowEnd });
    assert.ok(pick, "no_unblocked_waste_vehicle_found_for_workshop_test");
    const vehicleId = pick.vehicleId;
    workshop.vehicleId = vehicleId;

    {
      const noPermList = await req("/api/workshop/cases?limit=1");
      assert.ok([401, 403].includes(noPermList.status));
      const listAsWorkshopUser = await req("/api/workshop/cases?limit=1", { headers: DriverHeaders });
      assert.equal(listAsWorkshopUser.status, 200);
      const maintNoPerm = await req(`/api/workshop/vehicles/maintenance/status?vehicleId=${encodeURIComponent(vehicleId)}&serviceCode=maintenance`);
      assert.ok([401, 403].includes(maintNoPerm.status));
      const maintAsWorkshopUser = await req(
        `/api/workshop/vehicles/maintenance/status?vehicleId=${encodeURIComponent(vehicleId)}&serviceCode=maintenance`,
        { headers: DriverHeaders },
      );
      assert.equal(maintAsWorkshopUser.status, 200);
      workshop.steps.push({ step: "workshop_view_permissions_ok" });
    }

    {
      const missingDesc = await req("/api/workshop/orders", {
        method: "POST",
        headers: DriverHeaders,
        body: { vehicleId, title: "Integrationstest: fehlende Beschreibung", priority: "high", reporterRole: "driver" },
      });
      expectBadRequest(missingDesc, "description_required");
      workshop.steps.push({ step: "order_requires_description" });
    }

    const tinyPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/UVz8U8AAAAASUVORK5CYII=";
    const photoOrder = await req("/api/workshop/orders", {
      method: "POST",
      headers: DriverHeaders,
      body: {
        vehicleId,
        title: "Integrationstest: Foto+Pool",
        description: "Detaillierte Fehlerbeschreibung für den Integrationstest (mit Foto).",
        priority: "high",
        reporterRole: "driver",
        severity: "warning",
        lockType: "soft",
        photo: { mimeType: "image/png", base64: tinyPngBase64 },
      },
    });
    assert.equal(photoOrder.status, 201);
    const photoOrderId = photoOrder.json?.item?.id;
    assert.ok(photoOrderId);
    workshop.steps.push({ step: "order_created_by_driver", caseId: photoOrderId });

    const poolAsDriver = await req("/api/workshop/orders/pool?limit=50&priority=high", { headers: DriverHeaders });
    assert.equal(poolAsDriver.status, 200);
    assert.ok((poolAsDriver.json?.items || []).some((x) => x.id === photoOrderId));
    workshop.steps.push({ step: "pool_visible_for_authorized_users" });

    const photoGet = await req(`/api/workshop/orders/photo?caseId=${encodeURIComponent(photoOrderId)}`, { headers: DriverHeaders });
    assert.equal(photoGet.status, 200);
    assert.equal(photoGet.json?.item?.mimeType, "image/png");
    assert.equal(photoGet.json?.item?.base64, tinyPngBase64);
    workshop.steps.push({ step: "photo_roundtrip_ok" });

    const assignForbidden = await req("/api/workshop/orders/assign", {
      method: "POST",
      headers: DriverHeaders,
      body: { caseId: photoOrderId, assignedTo: "tech_01" },
    });
    assert.equal(assignForbidden.status, 403);
    workshop.steps.push({ step: "assignment_rbac_enforced" });

    const assignOk = await req("/api/workshop/orders/assign", {
      method: "POST",
      headers: WorkshopLeadHeaders,
      body: { caseId: photoOrderId, assignedTo: "tech_01" },
    });
    assert.equal(assignOk.status, 200);
    assert.equal(assignOk.json?.item?.assignedTo, "tech_01");
    workshop.steps.push({ step: "order_assigned" });

    {
      const filteredCases = await req(`/api/workshop/cases?status=open&assignedTo=${encodeURIComponent("tech_01")}&limit=50`, { headers: DriverHeaders });
      assert.equal(filteredCases.status, 200);
      assert.ok((filteredCases.json?.items || []).some((x) => x.id === photoOrderId));

      const toWaiting = await req("/api/workshop/orders/status", {
        method: "POST",
        headers: WorkshopAdminHeaders,
        body: { caseId: photoOrderId, workState: "waiting_parts", reason: "Integrationstest: Teile fehlen" },
      });
      assert.equal(toWaiting.status, 200);
      assert.equal(toWaiting.json?.item?.workState, "waiting_parts");

      const poolWaiting = await req(`/api/workshop/orders/pool?workState=waiting_parts&assignedTo=${encodeURIComponent("tech_01")}&limit=50`, { headers: DriverHeaders });
      assert.equal(poolWaiting.status, 200);
      assert.ok((poolWaiting.json?.items || []).some((x) => x.id === photoOrderId));

      const msg = await req("/api/workshop/orders/message", {
        method: "POST",
        headers: WorkshopAdminHeaders,
        body: { caseId: photoOrderId, message: "Integrationstest: Rückfrage an Verantwortlichen." },
      });
      assert.equal(msg.status, 201);

      const msgList = await req(`/api/workshop/orders/messages?caseId=${encodeURIComponent(photoOrderId)}&limit=50`, { headers: DriverHeaders });
      assert.equal(msgList.status, 200);
      assert.ok((msgList.json?.items || []).some((x) => x.message && String(x.message).includes("Integrationstest: Rückfrage")));

      const approvalReq = await req("/api/workshop/orders/approval/request", {
        method: "POST",
        headers: WorkshopAdminHeaders,
        body: { caseId: photoOrderId, note: "Integrationstest: Freigabe erforderlich." },
      });
      assert.equal(approvalReq.status, 201);
      const approvalReqId = approvalReq.json?.item?.id;
      assert.ok(approvalReqId);

      const approvalDecide = await req("/api/workshop/orders/approval/decide", {
        method: "POST",
        headers: WorkshopAdminHeaders,
        body: { requestId: approvalReqId, decision: "approved", note: "Integrationstest: Freigabe erteilt." },
      });
      assert.equal(approvalDecide.status, 201);
      assert.equal(approvalDecide.json?.item?.decision, "approved");
      workshop.steps.push({ step: "workflow_messages_approvals_ok" });
    }

    await req("/api/workshop/cases/close", {
      method: "POST",
      headers: WorkshopAdminHeaders,
      body: { caseId: photoOrderId, closedReason: "Integrationstest Cleanup (Foto+Pool)" },
    }).then((r) => assert.equal(r.status, 200));

    {
      const sign = await req("/api/workshop/orders/sign", {
        method: "POST",
        headers: WorkshopAdminHeaders,
        body: { caseId: photoOrderId, signature: { type: "typed", name: "Integrationstest Signatur" } },
      });
      assert.equal(sign.status, 201);
      const sigList = await req(`/api/workshop/orders/signatures?caseId=${encodeURIComponent(photoOrderId)}&limit=20`, { headers: DriverHeaders });
      assert.equal(sigList.status, 200);
      assert.ok((sigList.json?.items || []).some((x) => x.signature && x.signature.type === "typed"));
      workshop.steps.push({ step: "workflow_signature_ok" });
    }

    {
      const loc1 = await req("/api/workshop/inventory/locations", { method: "POST", headers: WorkshopAdminHeaders, body: { code: "A-01" } });
      assert.equal(loc1.status, 201);
      const loc2 = await req("/api/workshop/inventory/locations", { method: "POST", headers: WorkshopAdminHeaders, body: { code: "B-02" } });
      assert.equal(loc2.status, 201);
      const item = await req("/api/workshop/inventory/items", {
        method: "POST",
        headers: WorkshopAdminHeaders,
        body: { partNo: "TEST-PART-01", description: "Integrationstest Artikel", qrCode: "QR-TEST-PART-01", minQty: 0, active: true },
      });
      assert.equal(item.status, 201);

      const mv = await req("/api/workshop/inventory/move", {
        method: "POST",
        headers: WorkshopAdminHeaders,
        body: { movementType: "inbound", partNo: "TEST-PART-01", qty: 2, toLocationCode: "A-01", identifiers: { batchNo: "ch-01", serialNumbers: ["sn-1"] }, reason: "Integrationstest" },
      });
      assert.equal(mv.status, 201);
      const mvId = mv.json?.item?.id;
      assert.ok(mvId);

      const mvSearchSerial = await req(`/api/workshop/inventory/movements?serial=${encodeURIComponent("SN-1")}&limit=50`, { headers: WorkshopAdminHeaders });
      assert.equal(mvSearchSerial.status, 200);
      assert.ok((mvSearchSerial.json?.items || []).some((x) => x.id === mvId));
      workshop.steps.push({ step: "inventory_identifiers_search_ok" });
    }

    {
      const kpis = await req("/api/workshop/reports/kpis", { headers: AuditorHeaders });
      assert.equal(kpis.status, 200);
      assert.ok(kpis.json?.orders?.closed);
      assert.ok(kpis.json?.sla?.thresholdsSeconds);
      assert.ok(kpis.json?.inventory);
      assert.ok(kpis.json?.inspections);
      workshop.steps.push({ step: "reporting_kpis_ok" });
    }

    const before = await req(
      `/api/fleet/dispatch/decision?vehicleId=${encodeURIComponent(vehicleId)}&module=waste&${windowQuery(windowStart, windowEnd)}&siteDepot=GREVEN`,
    );
    assert.equal(before.status, 200);
    assert.equal(before.json?.baseDecision, "allow");
    assert.equal(before.json?.decision, "allow");
    workshop.steps.push({ step: "dispatch_allow_precondition" });

    const createCase = await req("/api/workshop/cases", {
      method: "POST",
      headers: WorkshopAdminHeaders,
      body: { vehicleId, title: "Integrationstest: kritischer Defekt", description: "Simuliert Werkstattfall", severity: "critical", lockType: "hard" },
    });
    assert.equal(createCase.status, 201);
    const caseId = createCase.json?.item?.id;
    assert.ok(caseId);
    workshop.steps.push({ step: "case_created", caseId });

    const denied = await req(
      `/api/fleet/dispatch/decision?vehicleId=${encodeURIComponent(vehicleId)}&module=waste&${windowQuery(windowStart, windowEnd)}&siteDepot=GREVEN`,
    );
    assert.equal(denied.status, 200);
    assert.equal(denied.json?.baseDecision, "deny");
    assert.equal(denied.json?.reasonCode, "hard_block");
    workshop.steps.push({ step: "dispatch_denied_by_case", reasonCode: denied.json?.reasonCode });

    const closeCase = await req("/api/workshop/cases/close", {
      method: "POST",
      headers: WorkshopAdminHeaders,
      body: { caseId, closedReason: "Integrationstest Cleanup" },
    });
    assert.equal(closeCase.status, 200);
    workshop.steps.push({ step: "case_closed" });

    const windowStartAfterClose = new Date();
    const windowEndAfterClose = new Date(windowStartAfterClose.getTime() + 60 * 60 * 1000);

    const allowed = await req(
      `/api/fleet/dispatch/decision?vehicleId=${encodeURIComponent(vehicleId)}&module=waste&${windowQuery(windowStartAfterClose, windowEndAfterClose)}&siteDepot=GREVEN`,
    );
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json?.decision, "allow");
    assert.equal(allowed.json?.baseDecision, "allow");
    workshop.steps.push({ step: "dispatch_allowed_after_close" });

    const ruleSet = await req("/api/workshop/admin/maintenance-rule", {
      method: "POST",
      headers: WorkshopAdminHeaders,
      body: { vehicleType: "LKW", serviceCode: "maintenance", kmInterval: 10000, active: true },
    });
    assert.equal(ruleSet.status, 200);
    workshop.steps.push({ step: "maintenance_rule_set" });

    const svc = await req("/api/workshop/vehicles/service/record", {
      method: "POST",
      headers: WorkshopAdminHeaders,
      body: { vehicleId, serviceCode: "maintenance", km: 50000, servicedAt: iso(new Date()) },
    });
    assert.equal(svc.status, 201);
    workshop.steps.push({ step: "service_recorded" });

    const meter1 = await req("/api/workshop/vehicles/meter", {
      method: "POST",
      headers: WorkshopAdminHeaders,
      body: { vehicleId, km: 59000, recordedAt: iso(new Date()), source: "selftest" },
    });
    assert.equal(meter1.status, 201);

    const st1 = await req(`/api/workshop/vehicles/maintenance/status?vehicleId=${encodeURIComponent(vehicleId)}&serviceCode=maintenance`, { headers: AuditorHeaders });
    assert.equal(st1.status, 200);
    assert.equal(st1.json?.item?.available, true);
    assert.equal(st1.json?.item?.due, false);
    assert.equal(st1.json?.item?.dueIn?.km, 1000);
    workshop.steps.push({ step: "maintenance_not_due", dueInKm: st1.json?.item?.dueIn?.km });

    const meter2 = await req("/api/workshop/vehicles/meter", {
      method: "POST",
      headers: WorkshopAdminHeaders,
      body: { vehicleId, km: 61000, recordedAt: iso(new Date()), source: "selftest" },
    });
    assert.equal(meter2.status, 201);

    const st2 = await req(`/api/workshop/vehicles/maintenance/status?vehicleId=${encodeURIComponent(vehicleId)}&serviceCode=maintenance`, { headers: AuditorHeaders });
    assert.equal(st2.status, 200);
    assert.equal(st2.json?.item?.due, true);
    assert.ok(st2.json?.item?.dueIn?.km <= 0);
    workshop.steps.push({ step: "maintenance_due", dueInKm: st2.json?.item?.dueIn?.km });

    workshop.result = "pass";
  } catch (e) {
    workshop.result = "fail";
    workshop.error = String(e && e.message ? e.message : e);
  } finally {
    workshop.finishedAt = new Date().toISOString();
    console.log("WORKSHOP_ACCEPTANCE_REPORT=" + JSON.stringify(workshop));
    assert.equal(workshop.result, "pass");
  }
}

{
  const r = await req("/api/auth/oidc/azure/start");
  assert.equal(r.status, 503);
  assert.equal(r.json?.error, "oidc_not_configured");
}

{
  const AuthAdminHeaders = { "x-user": "auth_admin", "x-permissions": "AUTH_ADMIN" };
  const role = "training_admin";
  await req("/api/auth/admin/roles", { method: "POST", headers: AuthAdminHeaders, body: { name: role } });
  const perms = [
    "TRAINING_CATALOG_VIEW",
    "TRAINING_CATALOG_ADMIN",
    "TRAINING_PLAN_VIEW",
    "TRAINING_PLAN_MANAGE",
    "TRAINING_CREDENTIAL_VIEW",
    "TRAINING_CREDENTIAL_ISSUE",
    "TRAINING_CREDENTIAL_REVOKE",
    "TRAINING_EMPLOYEE_VIEW",
    "TRAINING_EMPLOYEE_ADMIN",
    "TRAINING_SELF_VIEW",
    "TRAINING_SENSITIVE_VIEW",
    "TRAINING_SENSITIVE_ADMIN",
  ];
  for (const p of perms) {
    await req("/api/auth/admin/roles/grant", { method: "POST", headers: AuthAdminHeaders, body: { roleName: role, permission: p } });
  }

  const username = `training_admin_${Math.floor(Math.random() * 1_000_000)}`;
  const password = "pw_training_admin_123!";
  const created = await req("/api/auth/admin/users", {
    method: "POST",
    headers: AuthAdminHeaders,
    body: { username, displayName: "Training Admin", password },
  });
  assert.ok([201, 400].includes(created.status));
  await req("/api/auth/admin/users/assign-role", { method: "POST", headers: AuthAdminHeaders, body: { username, roleName: role } });

  const login = await req("/api/auth/login", { method: "POST", body: { username, password } });
  assert.equal(login.status, 200);
  const token = login.json?.accessToken;
  assert.ok(token);
  const Bearer = { authorization: `Bearer ${token}` };

  const q = await req("/api/training/qualifications", {
    method: "POST",
    headers: Bearer,
    body: { code: `Q_${Math.floor(Math.random() * 1_000_000)}`, name: "Stapler", category: "safety", issuerType: "internal", validityDays: 365, renewalDaysBefore: 30, requiresExam: true },
  });
  assert.equal(q.status, 201);
  const qId = q.json?.item?.id;
  assert.ok(qId);

  const course = await req("/api/training/courses", {
    method: "POST",
    headers: Bearer,
    body: { code: `C_${Math.floor(Math.random() * 1_000_000)}`, name: "Staplerkurs", qualificationId: qId, durationMinutes: 120, deliveryMode: "in_person" },
  });
  assert.equal(course.status, 201);
  const courseId = course.json?.item?.id;
  assert.ok(courseId);

  const starts = new Date(Date.now() + 60 * 60 * 1000);
  const ends = new Date(starts.getTime() + 2 * 60 * 60 * 1000);
  const sess = await req("/api/training/sessions", {
    method: "POST",
    headers: Bearer,
    body: { courseId, startsAt: iso(starts), endsAt: iso(ends), location: "Werkstatt", capacity: 10 },
  });
  assert.equal(sess.status, 201);
  const sessionId = sess.json?.item?.id;
  assert.ok(sessionId);

  const me = await req("/api/auth/me", { headers: Bearer });
  assert.equal(me.status, 200);
  const userId = me.json?.user?.id;
  assert.ok(userId);

  const assigned = await req("/api/training/sessions/participants/assign", { method: "POST", headers: Bearer, body: { sessionId, userId } });
  assert.equal(assigned.status, 200);
  const marked = await req("/api/training/sessions/participants/mark", { method: "POST", headers: Bearer, body: { sessionId, userId, status: "passed", score: 95 } });
  assert.equal(marked.status, 200);
  const completed = await req("/api/training/sessions/complete", { method: "POST", headers: Bearer, body: { sessionId } });
  assert.equal(completed.status, 200);

  const creds = await req(`/api/training/credentials?userId=${encodeURIComponent(userId)}&status=valid`, { headers: Bearer });
  assert.equal(creds.status, 200);
  assert.ok((creds.json?.items || []).length >= 1);

  const overview = await req("/api/training/me/overview", { headers: Bearer });
  assert.equal(overview.status, 200);
  assert.equal(overview.json?.userId, userId);
}

if (true) {
  const sys = await req("/api/integrations/systems", {
    method: "POST",
    headers: AdminHeaders,
    body: { kind: "portal", name: `Test Portal ${crypto.randomUUID().slice(0, 8)}`, status: "active", config: {} },
  });
  assert.equal(sys.status, 201);
  const systemId = sys.json?.item?.id;
  assert.ok(systemId);

  const sub = await req("/api/integrations/subscriptions", {
    method: "POST",
    headers: AdminHeaders,
    body: { systemId, eventTypes: ["INTEGRATION_TEST_EVENT"] },
  });
  assert.equal(sub.status, 201);

  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.ok(databaseUrl, "DATABASE_URL_required_for_integrations_test");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const eventId = `ev_${crypto.randomUUID().slice(0, 18)}`;
  const aggId = `agg_${crypto.randomUUID().slice(0, 8)}`;
  await client.query(
    `
    insert into erp_event
      (id, event_type, aggregate_type, aggregate_id, occurred_at, created_by, correlation_id, payload, schema_version, source_module, causation_id, trace_id, partition_key, headers)
    values
      ($1,$2,$3,$4, now(), $5, null, $6::jsonb, 1, $7, null, null, $8, '{}'::jsonb);
    `,
    [eventId, "INTEGRATION_TEST_EVENT", "test", aggId, "tests", JSON.stringify({ ok: true, systemId }), "tests", aggId],
  );
  await client.end();

  const dispatch = await req("/api/integrations/dispatch", { method: "POST", headers: AdminHeaders, body: { systemId, limit: 10 } });
  assert.equal(dispatch.status, 202);
  const jobId = dispatch.json?.jobId;
  assert.ok(jobId);

  const done = await waitForJobDone(jobId, { timeoutMs: 30_000 });
  assert.ok(done.ok);

  const consumer = `integration:${systemId}`;
  const deliveries = await req(
    `/api/events/deliveries?consumer=${encodeURIComponent(consumer)}&eventId=${encodeURIComponent(eventId)}&limit=10`,
    { headers: AdminHeaders },
  );
  assert.equal(deliveries.status, 200);
  assert.ok((deliveries.json?.items || []).length >= 1);
  assert.equal(deliveries.json?.items?.[0]?.eventId, eventId);

  const offset = await req(`/api/events/offset?consumer=${encodeURIComponent(consumer)}`, { headers: AdminHeaders });
  assert.equal(offset.status, 200);
  assert.equal(offset.json?.item?.lastEventId, eventId);
}

if (true) {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.ok(databaseUrl, "DATABASE_URL_required_for_global_search_test");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const searchRef = `SEARCH_${crypto.randomUUID().slice(0, 8)}`;
  const customerId = `cus_${crypto.randomUUID().slice(0, 10)}`;
  const contractId = `con_${crypto.randomUUID().slice(0, 10)}`;
  await client.query(
    `
    insert into crm_customer
      (id, customer_no, name, legal_form, vat_id, billing_address, service_addresses, email, phone, payment_terms, active, meta, created_at, updated_at)
    values
      ($1,$2,$3,null,null,'{}'::jsonb,'[]'::jsonb,null,null,'{}'::jsonb,true,'{}'::jsonb, now(), now());
    `,
    [customerId, searchRef, `Kunde ${searchRef}`],
  );
  await client.query(
    `
    insert into crm_contract
      (id, contract_no, customer_id, status, valid_from, valid_to, title, terms, created_by, created_at, updated_at)
    values
      ($1,$2,$3,'active', current_date, null, $4, '{}'::jsonb, 'tests', now(), now());
    `,
    [contractId, `${searchRef}-CON`, customerId, `Vertrag ${searchRef}`],
  );
  await client.end();

  const CustomerOnlyHeaders = { "x-user": "customer_viewer", "x-permissions": "CUSTOMER_VIEW" };
  const r = await req(`/api/search?q=${encodeURIComponent(searchRef)}&modules=customers,contracts&limit=20`, { headers: CustomerOnlyHeaders });
  assert.equal(r.status, 200);
  assert.ok((r.json?.searchedModules || []).includes("customers"));
  assert.ok((r.json?.skippedModules || []).some((x) => x.module === "contracts" && x.reason === "forbidden"));
  assert.ok((r.json?.items || []).some((x) => x.module === "customers" && x.id === customerId));
  assert.ok(!(r.json?.items || []).some((x) => x.module === "contracts" && x.id === contractId));
}

if (true) {
  const ruleKey = `notif_rule_${crypto.randomUUID().slice(0, 8)}`;
  const notifUserHeaders = { "x-user": "notif_user" };

  for (const channel of ["email", "push", "in_app"]) {
    const upsert = await req("/api/notifications/center/channels", {
      method: "POST",
      headers: AdminHeaders,
      body: {
        channel,
        enabled: true,
        provider: channel === "in_app" ? "in_app" : "log",
        config: channel === "in_app" ? { mode: "store" } : { mode: "log" },
        qualityStandard: channel === "email" ? { targetDeliveryMs: 300000, targetAccuracyPct: 99.5 } : channel === "push" ? { targetDeliveryMs: 60000, targetAccuracyPct: 99.0 } : { targetDeliveryMs: 5000, targetAccuracyPct: 99.9 },
      },
    });
    assert.equal(upsert.status, 200);
  }

  const saveRule = await req("/api/notifications/center/rules", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      ruleKey,
      name: "Integration Test Notification Rule",
      eventType: "TEST_NOTIFICATION_RULE",
      aggregateType: "test_notification",
      channels: ["email", "push", "in_app"],
      priority: "high",
      ackRequired: true,
      slaMinutes: 15,
      audience: { users: ["notif_user"] },
      escalationPolicy: [{ level: 1, afterMinutes: 15, channels: ["email", "in_app"], audience: { users: ["notif_manager"] } }],
      template: { category: "test" },
    },
  });
  assert.equal(saveRule.status, 200);
  assert.ok((saveRule.json?.items || []).some((x) => x.ruleKey === ruleKey));

  const trigger = await req("/api/notifications/center/trigger", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      ruleKey,
      aggregateType: "test_notification",
      aggregateId: `agg_${crypto.randomUUID().slice(0, 8)}`,
      title: "Benachrichtigungstest",
      message: "Alle Kanaele sollen zugestellt werden.",
      payload: { source: "integration_test" },
    },
  });
  assert.equal(trigger.status, 201);
  const notificationId = trigger.json?.item?.id;
  assert.ok(notificationId);
  if (trigger.json?.jobId) {
    const done = await waitForJobDone(trigger.json.jobId, { timeoutMs: 30_000 });
    assert.ok(done.ok);
  }

  const deliveriesReady = await retryUntil(async () => {
    const r = await req(`/api/notifications/center/deliveries?notificationId=${encodeURIComponent(notificationId)}&limit=10`, { headers: AdminHeaders });
    if (r.status !== 200) return { ok: false, error: `deliveries_http_${r.status}` };
    const items = r.json?.items || [];
    const channels = new Set(items.map((x) => x.channel));
    const ready = channels.has("email") && channels.has("push") && channels.has("in_app") && items.every((x) => ["delivered", "skipped"].includes(x.status));
    return ready ? { ok: true, items } : { ok: false, error: "deliveries_pending", items };
  }, { timeoutMs: 30_000, intervalMs: 500 });
  assert.ok(deliveriesReady.ok);

  const inbox = await req("/api/notifications/center/items?limit=20", { headers: notifUserHeaders });
  assert.equal(inbox.status, 200);
  assert.ok((inbox.json?.items || []).some((x) => x.id === notificationId));

  const quality = await req("/api/notifications/center/quality?days=7", { headers: AdminHeaders });
  assert.equal(quality.status, 200);
  assert.ok((quality.json?.item?.channels || []).some((x) => x.channel === "email"));

  const ack = await req("/api/notifications/center/ack", {
    method: "POST",
    headers: notifUserHeaders,
    body: { notificationId, note: "gesehen" },
  });
  assert.equal(ack.status, 200);
  assert.equal(ack.json?.item?.status, "acknowledged");

  const audit = await req(`/api/notifications/center/audit?notificationId=${encodeURIComponent(notificationId)}&limit=50`, { headers: AdminHeaders });
  assert.equal(audit.status, 200);
  assert.ok((audit.json?.items || []).some((x) => x.eventType === "NOTIFICATION_ACKNOWLEDGED"));
}

if (true) {
  const ruleKey = `notif_escalation_${crypto.randomUUID().slice(0, 8)}`;
  const aggregateId = `agg_${crypto.randomUUID().slice(0, 8)}`;

  const saveRule = await req("/api/notifications/center/rules", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      ruleKey,
      name: "Escalation Test Rule",
      eventType: "TEST_NOTIFICATION_ESCALATION",
      aggregateType: "deadline",
      channels: ["in_app"],
      priority: "critical",
      ackRequired: true,
      slaMinutes: 1,
      audience: { users: ["deadline_owner"] },
      escalationPolicy: [{ level: 1, afterMinutes: 0, channels: ["email", "push", "in_app"], audience: { users: ["escalation_manager"] } }],
    },
  });
  assert.equal(saveRule.status, 200);

  const trigger = await req("/api/notifications/center/trigger", {
    method: "POST",
    headers: AdminHeaders,
    body: {
      ruleKey,
      aggregateType: "deadline",
      aggregateId,
      title: "Fristfall",
      message: "SLA-Test fuer Eskalation",
      payload: { category: "deadline" },
      slaDueAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  assert.equal(trigger.status, 201);
  const notificationId = trigger.json?.item?.id;
  assert.ok(notificationId);
  if (trigger.json?.jobId) {
    const done = await waitForJobDone(trigger.json.jobId, { timeoutMs: 30_000 });
    assert.ok(done.ok);
  }

  const tick = await req("/api/notifications/center/tick", { method: "POST", headers: AdminHeaders, body: {} });
  assert.equal(tick.status, 200);
  assert.ok((tick.json?.item?.escalated || 0) >= 1);
  assert.ok((tick.json?.item?.breached || 0) >= 1);

  const escalatedDeliveries = await retryUntil(async () => {
    const r = await req(`/api/notifications/center/deliveries?notificationId=${encodeURIComponent(notificationId)}&limit=20`, { headers: AdminHeaders });
    if (r.status !== 200) return { ok: false, error: `deliveries_http_${r.status}` };
    const items = r.json?.items || [];
    const channels = new Set(items.map((x) => x.channel));
    const ready = channels.has("email") && channels.has("push") && channels.has("in_app") && items.filter((x) => x.status === "delivered").length >= 3;
    return ready ? { ok: true, items } : { ok: false, error: "escalation_deliveries_pending", items };
  }, { timeoutMs: 30_000, intervalMs: 500 });
  assert.ok(escalatedDeliveries.ok);

  const esc = await req(`/api/notifications/center/escalations?notificationId=${encodeURIComponent(notificationId)}&limit=10`, { headers: AdminHeaders });
  assert.equal(esc.status, 200);
  assert.ok((esc.json?.items || []).some((x) => x.levelNo === 1 && x.status === "triggered"));

  const managerInbox = await req("/api/notifications/center/items?limit=20", { headers: { "x-user": "escalation_manager" } });
  assert.equal(managerInbox.status, 200);
  assert.ok((managerInbox.json?.items || []).some((x) => x.id === notificationId));

  const item = await req(`/api/notifications/center/items?aggregateType=deadline&aggregateId=${encodeURIComponent(aggregateId)}&limit=10`, { headers: AdminHeaders });
  assert.equal(item.status, 200);
  const found = (item.json?.items || []).find((x) => x.id === notificationId);
  assert.ok(found);
  assert.equal(found.status, "breached");
  assert.ok((found.escalationLevel || 0) >= 1);
}

if (true) {
  const customerHeaders = { "x-user": "menu_customer", "x-permissions": "CUSTOMER_VIEW" };
  const menu = await req("/api/main-menu", { headers: customerHeaders });
  assert.equal(menu.status, 200);
  assert.equal(menu.json?.item?.user?.username, "menu_customer");
  assert.ok((menu.json?.item?.modules || []).some((x) => x.key === "customers"));
  assert.ok(!(menu.json?.item?.modules || []).some((x) => x.key === "pricing"));
  assert.ok(!(menu.json?.item?.modules || []).some((x) => x.key === "disposition"));

  const auditWrite = await req("/api/main-menu/audit", {
    method: "POST",
    headers: { ...customerHeaders, "x-client": "site/index.html" },
    body: { action: "menu_item_opened", sectionKey: "modules", menuKey: "customers", menuLabel: "Kunden", meta: { source: "integration_test" } },
  });
  assert.equal(auditWrite.status, 201);

  const auditRead = await req(`/api/main-menu/audit?username=${encodeURIComponent("menu_customer")}&limit=20`, { headers: AdminHeaders });
  assert.equal(auditRead.status, 200);
  assert.ok((auditRead.json?.items || []).some((x) => x.username === "menu_customer" && x.action === "menu_item_opened" && x.menuKey === "customers" && x.client === "site/index.html"));
}

console.log("OK");
