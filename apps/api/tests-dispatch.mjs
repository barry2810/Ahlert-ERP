import assert from "node:assert/strict";

const base = "http://localhost:3000";

async function req(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...headers,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: Object.fromEntries(res.headers.entries()) };
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

function expectBadRequest(r, message) {
  assert.equal(r.status, 400);
  assert.equal(r.json?.error, "bad_request");
  assert.equal(r.json?.message, message);
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

  const overrideFail = await req("/api/fleet/dispatch/decision", {
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
  assert.equal(overrideFail.status, 403);

  const overrideOk = await req("/api/fleet/dispatch/decision", {
    method: "POST",
    headers: OverrideHardHeaders,
    body: {
      vehicleId: "veh_01",
      module: "waste",
      windowStart: iso(blockWindowStart),
      windowEnd: iso(blockWindowEnd),
      decision: "allow",
      reason: "Selftest: Ausnahmegenehmigung trotz Hard-Block",
      expiresAt: iso(expiresAt),
    },
  });
  assert.equal(overrideOk.status, 201);

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

  const materialCode = `MAT_${Math.floor(Math.random() * 1_000_000)}`;
  const materialReq = await req("/api/items/materials", { method: "POST", headers: AdminHeaders, body: { code: materialCode, name: "Gemischte Abfälle", unit: "t", active: true } });
  assert.equal(materialReq.status, 202);
  const materialApprovalId = materialReq.json?.approval?.id;
  assert.ok(materialApprovalId);
  const materialApproval = await approveUntilApplied(materialApprovalId);
  assert.equal(materialApproval.applied?.ok, true);

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
      site: { depot: "GREVEN", lat: 52.091, lon: 7.612, address: "Preisstraße 1, 48268 Greven" },
      priorityUrgency: "normal",
      materialCode,
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

  const validated = await req("/api/waste/orders/status", { method: "POST", headers: AdminHeaders, body: { id: orderId, toStatus: "validated", reason: "validated" } });
  assert.equal(validated.status, 200);

  const check = await req("/api/waste/orders/dispatch/check", { method: "POST", headers: AdminHeaders, body: { id: orderId, vehicleId: "veh_01", siteDepot: "GREVEN" } });
  assert.equal(check.status, 200);

  const assign = await req("/api/waste/orders/dispatch/assign", { method: "POST", headers: AdminHeaders, body: { id: orderId, vehicleId: "veh_01", driverId: "drv_01", reason: "scheduled" } });
  assert.ok([201, 409].includes(assign.status));

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

console.log("OK");
