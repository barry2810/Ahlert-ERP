const ApiVersions = {
  v1: {
    version: "1.0.0",
    deprecated: true,
    serverUrl: "/api/v1",
    title: "Ahlert ERP Core API",
    description:
      "Version 1 der Kernschnittstellen. Diese Version bleibt fuer abwaertskompatible Uebergaenge verfuegbar, ist jedoch als veraltet markiert.",
    sunset: "2027-12-31",
  },
  v2: {
    version: "2.0.0",
    deprecated: false,
    serverUrl: "/api/v2",
    title: "Ahlert ERP Core API",
    description: "Aktive Version der Kernschnittstellen mit paralleler Unterstuetzung zu v1.",
    sunset: null,
  },
};

const JsonObject = { type: "object", additionalProperties: true };

function op(method, config) {
  return {
    [method]: {
      tags: config.tags || ["General"],
      summary: config.summary,
      description: config.description || config.summary,
      operationId: config.operationId,
      deprecated: Boolean(config.deprecated),
      parameters: config.parameters || [],
      requestBody: config.requestBody || undefined,
      responses: config.responses,
      security: config.security === false ? [] : [{ HeaderUserAuth: [] }],
    },
  };
}

function qp(name, schema, description, required = false) {
  return { name, in: "query", required, description, schema };
}

function requestBody(required, schema, description = "JSON Request Body") {
  return {
    required,
    description,
    content: {
      "application/json": {
        schema,
      },
    },
  };
}

function resp(description, schema = JsonObject, headers = undefined) {
  return {
    description,
    headers,
    content: {
      "application/json": {
        schema,
      },
    },
  };
}

function csvResp(description) {
  return {
    description,
    content: {
      "text/csv": {
        schema: { type: "string" },
      },
    },
  };
}

function deprecatedHeaders(versionKey) {
  const version = ApiVersions[versionKey];
  if (!version?.deprecated) return undefined;
  return {
    Deprecation: { schema: { type: "string" }, description: "Kennzeichnet die API-Version als veraltet." },
    Sunset: { schema: { type: "string" }, description: "Geplantes Enddatum fuer die Version." },
    Link: { schema: { type: "string" }, description: "Verweis auf Nachfolgeversion und Spezifikation." },
  };
}

function errorResponses(versionKey) {
  const headers = deprecatedHeaders(versionKey);
  return {
    400: resp("Ungueltige Anfrage", { $ref: "#/components/schemas/ErrorResponse" }, headers),
    401: resp("Nicht authentifiziert", { $ref: "#/components/schemas/ErrorResponse" }, headers),
    403: resp("Keine Berechtigung", { $ref: "#/components/schemas/ErrorResponse" }, headers),
    404: resp("Nicht gefunden", { $ref: "#/components/schemas/ErrorResponse" }, headers),
    409: resp("Konflikt", { $ref: "#/components/schemas/ErrorResponse" }, headers),
    500: resp("Serverfehler", { $ref: "#/components/schemas/ErrorResponse" }, headers),
  };
}

function withCommon(versionKey, okResponses) {
  return { ...okResponses, ...errorResponses(versionKey) };
}

const routeCatalog = [
  {
    path: "/auth/login",
    rawPath: "/api/auth/login",
    operations: (v) => ({
      ...op("post", {
        tags: ["Auth"],
        summary: "Login via Benutzername/Passwort",
        operationId: `authLogin_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, {
          type: "object",
          required: ["username", "password"],
          properties: { username: { type: "string" }, password: { type: "string", format: "password" } },
        }),
        security: false,
        responses: withCommon(v, {
          200: resp("Login erfolgreich", { $ref: "#/components/schemas/AuthSession" }, deprecatedHeaders(v)),
        }),
      }),
    }),
  },
  {
    path: "/auth/refresh",
    rawPath: "/api/auth/refresh",
    operations: (v) => ({
      ...op("post", {
        tags: ["Auth"],
        summary: "Session erneuern",
        operationId: `authRefresh_${v}`,
        deprecated: ApiVersions[v].deprecated,
        security: false,
        responses: withCommon(v, {
          200: resp("Session erneuert", { $ref: "#/components/schemas/AuthSession" }, deprecatedHeaders(v)),
        }),
      }),
    }),
  },
  {
    path: "/auth/logout",
    rawPath: "/api/auth/logout",
    operations: (v) => ({
      ...op("post", {
        tags: ["Auth"],
        summary: "Logout",
        operationId: `authLogout_${v}`,
        deprecated: ApiVersions[v].deprecated,
        responses: withCommon(v, {
          200: resp("Logout erfolgreich", { type: "object", properties: { ok: { type: "boolean" } } }, deprecatedHeaders(v)),
        }),
      }),
    }),
  },
  {
    path: "/auth/me",
    rawPath: "/api/auth/me",
    operations: (v) => ({
      ...op("get", {
        tags: ["Auth"],
        summary: "Aktuelle Session lesen",
        operationId: `authMe_${v}`,
        deprecated: ApiVersions[v].deprecated,
        responses: withCommon(v, {
          200: resp("Session", { $ref: "#/components/schemas/AuthSession" }, deprecatedHeaders(v)),
        }),
      }),
    }),
  },
  {
    path: "/customers",
    rawPath: "/api/customers",
    operations: (v) => ({
      ...op("get", {
        tags: ["Customers"],
        summary: "Kunden suchen oder Detail lesen",
        operationId: `customersList_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("id", { type: "string" }, "Kunden-ID oder Kundennummer"), qp("q", { type: "string" }, "Freitextsuche"), qp("activeOnly", { type: "boolean" }, "Nur aktive Kunden"), qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl")],
        responses: withCommon(v, {
          200: resp("Kundenliste oder Einzelkunde", JsonObject, deprecatedHeaders(v)),
        }),
      }),
      ...op("post", {
        tags: ["Customers"],
        summary: "Kunden anlegen",
        operationId: `customersCreate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, { $ref: "#/components/schemas/CustomerWrite" }),
        responses: withCommon(v, {
          201: resp("Kunde angelegt", JsonObject, deprecatedHeaders(v)),
        }),
      }),
    }),
  },
  {
    path: "/customers/update",
    rawPath: "/api/customers/update",
    operations: (v) => ({
      ...op("post", {
        tags: ["Customers"],
        summary: "Kunde aktualisieren",
        operationId: `customersUpdate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, { allOf: [{ $ref: "#/components/schemas/CustomerWrite" }, { type: "object", required: ["id"], properties: { id: { type: "string" } } }] }),
        responses: withCommon(v, {
          200: resp("Kunde aktualisiert", JsonObject, deprecatedHeaders(v)),
        }),
      }),
    }),
  },
  {
    path: "/contracts",
    rawPath: "/api/contracts",
    operations: (v) => ({
      ...op("get", {
        tags: ["Contracts"],
        summary: "Vertraege lesen",
        operationId: `contractsList_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("id", { type: "string" }, "Vertrags-ID"), qp("customerId", { type: "string" }, "Kunden-ID"), qp("status", { type: "string" }, "Statusfilter"), qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl")],
        responses: withCommon(v, { 200: resp("Vertragsdaten", JsonObject, deprecatedHeaders(v)) }),
      }),
      ...op("post", {
        tags: ["Contracts"],
        summary: "Vertrag anlegen",
        operationId: `contractsCreate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, { $ref: "#/components/schemas/ContractWrite" }),
        responses: withCommon(v, { 201: resp("Vertrag angelegt", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/contracts/status",
    rawPath: "/api/contracts/status",
    operations: (v) => ({
      ...op("post", {
        tags: ["Contracts"],
        summary: "Vertragsstatus wechseln",
        operationId: `contractsStatus_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, {
          type: "object",
          required: ["contractId", "toStatus", "reason"],
          properties: { contractId: { type: "string" }, toStatus: { type: "string" }, reason: { type: "string" } },
        }),
        responses: withCommon(v, { 200: resp("Status aktualisiert", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/items/materials",
    rawPath: "/api/items/materials",
    operations: (v) => ({
      ...op("get", {
        tags: ["Items"],
        summary: "Materialstammdaten lesen",
        operationId: `materialsList_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("activeOnly", { type: "boolean" }, "Nur aktive Materialien"), qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl")],
        responses: withCommon(v, { 200: resp("Materialliste", JsonObject, deprecatedHeaders(v)) }),
      }),
      ...op("post", {
        tags: ["Items"],
        summary: "Material anlegen",
        operationId: `materialsCreate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, { $ref: "#/components/schemas/MaterialWrite" }),
        responses: withCommon(v, { 201: resp("Material angelegt", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/pricing/pricelists",
    rawPath: "/api/pricing/pricelists",
    operations: (v) => ({
      ...op("get", {
        tags: ["Pricing"],
        summary: "Preislisten lesen",
        operationId: `priceListsList_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("status", { type: "string" }, "Status"), qp("at", { type: "string", format: "date" }, "Gueltigkeitsdatum"), qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl"), qp("id", { type: "string" }, "Preislisten-ID")],
        responses: withCommon(v, { 200: resp("Preislisten", JsonObject, deprecatedHeaders(v)) }),
      }),
      ...op("post", {
        tags: ["Pricing"],
        summary: "Preisliste anlegen",
        operationId: `priceListsCreate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, { $ref: "#/components/schemas/PriceListWrite" }),
        responses: withCommon(v, { 201: resp("Preisliste angelegt", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/pricing/pricelists/items",
    rawPath: "/api/pricing/pricelists/items",
    operations: (v) => ({
      ...op("post", {
        tags: ["Pricing"],
        summary: "Preisliste-Position anlegen",
        operationId: `priceListItemsCreate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, { $ref: "#/components/schemas/PriceListItemWrite" }),
        responses: withCommon(v, { 201: resp("Position angelegt", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/pricing/fees",
    rawPath: "/api/pricing/fees",
    operations: (v) => ({
      ...op("get", {
        tags: ["Pricing"],
        summary: "Gebuehren lesen",
        operationId: `feesList_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("activeOnly", { type: "boolean" }, "Nur aktive Gebuehren"), qp("at", { type: "string", format: "date" }, "Gueltigkeitsdatum"), qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl")],
        responses: withCommon(v, { 200: resp("Gebuehren", JsonObject, deprecatedHeaders(v)) }),
      }),
      ...op("post", {
        tags: ["Pricing"],
        summary: "Gebuehr anlegen",
        operationId: `feesCreate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, { $ref: "#/components/schemas/FeeWrite" }),
        responses: withCommon(v, { 201: resp("Gebuehr angelegt", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/pricing/overrides",
    rawPath: "/api/pricing/overrides",
    operations: (v) => ({
      ...op("post", {
        tags: ["Pricing"],
        summary: "Kundenspezifisches Pricing-Override anlegen",
        operationId: `pricingOverridesCreate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, JsonObject),
        responses: withCommon(v, { 201: resp("Override angelegt", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/pricing/calculate",
    rawPath: "/api/pricing/calculate",
    operations: (v) => ({
      ...op("post", {
        tags: ["Pricing"],
        summary: "Preis fuer Entsorgungsauftrag berechnen",
        operationId: `pricingCalculate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, {
          type: "object",
          required: ["orderId"],
          properties: { orderId: { type: "string" }, priceListId: { type: "string" }, at: { type: "string", format: "date" }, force: { type: "boolean" } },
        }),
        responses: withCommon(v, { 201: resp("Preis berechnet", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/pricing/calculations",
    rawPath: "/api/pricing/calculations",
    operations: (v) => ({
      ...op("get", {
        tags: ["Pricing"],
        summary: "Berechnungshistorie lesen",
        operationId: `pricingCalculationsList_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("orderId", { type: "string" }, "Auftrags-ID", true), qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl")],
        responses: withCommon(v, { 200: resp("Berechnungen", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/pricing/calculation",
    rawPath: "/api/pricing/calculation",
    operations: (v) => ({
      ...op("get", {
        tags: ["Pricing"],
        summary: "Einzelne Berechnung lesen",
        operationId: `pricingCalculationGet_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("id", { type: "string" }, "Berechnungs-ID", true)],
        responses: withCommon(v, { 200: resp("Berechnung", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/billing/waste/invoice-drafts",
    rawPath: "/api/billing/waste/invoice-drafts",
    operations: (v) => ({
      ...op("get", {
        tags: ["Billing"],
        summary: "Rechnungsentwuerfe lesen",
        operationId: `invoiceDraftsList_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("id", { type: "string" }, "Rechnungsentwurf-ID"), qp("orderId", { type: "string" }, "Auftrags-ID"), qp("customerId", { type: "string" }, "Kunden-ID"), qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl")],
        responses: withCommon(v, { 200: resp("Rechnungsentwuerfe", JsonObject, deprecatedHeaders(v)) }),
      }),
      ...op("post", {
        tags: ["Billing"],
        summary: "Rechnungsentwurf aus Pricing-Snapshot erzeugen",
        operationId: `invoiceDraftsCreate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, { type: "object", required: ["orderId"], properties: { orderId: { type: "string" }, pricingCalculationId: { type: "string" } } }),
        responses: withCommon(v, { 201: resp("Rechnungsentwurf angelegt", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/waste/orders",
    rawPath: "/api/waste/orders",
    operations: (v) => ({
      ...op("get", {
        tags: ["Waste"],
        summary: "Entsorgungsauftraege lesen",
        operationId: `wasteOrdersList_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("id", { type: "string" }, "Auftrags-ID"), qp("status", { type: "string" }, "Status"), qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl")],
        responses: withCommon(v, { 200: resp("Auftraege", JsonObject, deprecatedHeaders(v)) }),
      }),
      ...op("post", {
        tags: ["Waste"],
        summary: "Entsorgungsauftrag anlegen",
        operationId: `wasteOrdersCreate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, { $ref: "#/components/schemas/WasteOrderWrite" }),
        responses: withCommon(v, { 201: resp("Auftrag angelegt", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  ...["/waste/orders/status", "/waste/orders/dispatch/check", "/waste/orders/dispatch/assign", "/waste/orders/weigh/mock", "/waste/orders/invoice/mock"].map((raw) => ({
    path: raw.replace(/^\/api/, ""),
    rawPath: `/api${raw}`,
    operations: (v) => ({
      ...op("post", {
        tags: ["Waste"],
        summary:
          raw.endsWith("/status") ? "Auftragsstatus setzen" :
          raw.endsWith("/dispatch/check") ? "Dispatch pruefen" :
          raw.endsWith("/dispatch/assign") ? "Dispatch zuweisen" :
          raw.endsWith("/weigh/mock") ? "Mock-Wiegeschein erzeugen" : "Mock-Rechnungsentwurf erzeugen",
        operationId: `wasteAction_${raw.split("/").slice(-2).join("_").replace(/[^a-zA-Z0-9_]/g, "")}_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, JsonObject),
        responses: withCommon(v, { 200: resp("Aktion verarbeitet", JsonObject, deprecatedHeaders(v)), 201: resp("Aktion verarbeitet", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  })),
  {
    path: "/waste/routes",
    rawPath: "/api/waste/routes",
    operations: (v) => ({
      ...op("get", {
        tags: ["Routing"],
        summary: "Routen lesen",
        operationId: `wasteRoutesList_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("day", { type: "string", format: "date" }, "Tag"), qp("depotCode", { type: "string" }, "Depot"), qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl")],
        responses: withCommon(v, { 200: resp("Routen", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  {
    path: "/waste/route",
    rawPath: "/api/waste/route",
    operations: (v) => ({
      ...op("get", {
        tags: ["Routing"],
        summary: "Einzelroute lesen",
        operationId: `wasteRouteGet_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("id", { type: "string" }, "Route-ID", true)],
        responses: withCommon(v, { 200: resp("Route", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  ...["/api/waste/routes/plan", "/api/waste/routes/reoptimize"].map((raw) => ({
    path: raw.replace(/^\/api/, ""),
    rawPath: raw,
    operations: (v) => ({
      ...op("post", {
        tags: ["Routing"],
        summary: raw.endsWith("plan") ? "Route planen" : "Route reoptimieren",
        operationId: `${raw.endsWith("plan") ? "wasteRoutePlan" : "wasteRouteReopt"}_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, JsonObject),
        responses: withCommon(v, { 200: resp("Routing-Antwort", JsonObject, deprecatedHeaders(v)), 201: resp("Routing-Antwort", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  })),
  {
    path: "/disposition/integrations/status",
    rawPath: "/api/disposition/integrations/status",
    operations: (v) => ({
      ...op("get", {
        tags: ["Disposition"],
        summary: "Integrationsstatus lesen",
        operationId: `dispositionIntegrationsStatus_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("day", { type: "string", format: "date" }, "Tag"), qp("depotCode", { type: "string" }, "Depot")],
        responses: withCommon(v, { 200: resp("Integrationsstatus", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  ...[
    ["/api/traffic/here/status", "HERE Traffic Status", "get"],
    ["/api/traffic/here/latest", "HERE Snapshot lesen", "get"],
    ["/api/traffic/here/refresh", "HERE Snapshots aktualisieren", "post"],
    ["/api/traffic/here/reroute-suggest", "HERE Umleitungsalternativen berechnen", "post"],
  ].map(([raw, summary, method]) => ({
    path: raw.replace(/^\/api/, ""),
    rawPath: raw,
    operations: (v) => ({
      ...op(method, {
        tags: ["Traffic"],
        summary,
        operationId: `${raw.split("/").filter(Boolean).slice(-2).join("_")}_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: method === "get" ? [qp("depotCode", { type: "string" }, "Depot"), qp("kind", { type: "string" }, "Snapshot-Art"), qp("day", { type: "string", format: "date" }, "Tag"), qp("month", { type: "string" }, "Monat")] : [],
        requestBody: method === "post" ? requestBody(false, JsonObject) : undefined,
        responses: withCommon(v, { 200: resp("Traffic-Daten", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  })),
  ...[
    "/api/events",
    "/api/events/schema",
    "/api/events/consume",
    "/api/events/offset",
    "/api/events/deliveries",
  ].map((raw) => ({
    path: raw.replace(/^\/api/, ""),
    rawPath: raw,
    operations: (v) => ({
      ...op("get", {
        tags: ["Events"],
        summary:
          raw.endsWith("/schema") ? "Event-Schema lesen" :
          raw.endsWith("/consume") ? "Events fuer Consumer lesen" :
          raw.endsWith("/offset") ? "Consumer-Offset lesen" :
          raw.endsWith("/deliveries") ? "Consumer-Zustellungen lesen" : "Events lesen",
        operationId: `${raw.split("/").filter(Boolean).join("_")}_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("consumer", { type: "string" }, "Consumer"), qp("afterId", { type: "string" }, "Nach Event-ID"), qp("types", { type: "string" }, "CSV Eventtypen"), qp("aggregateType", { type: "string" }, "Aggregattyp"), qp("aggregateId", { type: "string" }, "Aggregat-ID"), qp("eventId", { type: "string" }, "Event-ID"), qp("limit", { type: "integer", minimum: 1, maximum: 1000 }, "Maximale Anzahl")],
        responses: withCommon(v, { 200: resp("Eventdaten", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  })),
  ...["/api/events/ack", "/api/events/fail"].map((raw) => ({
    path: raw.replace(/^\/api/, ""),
    rawPath: raw,
    operations: (v) => ({
      ...op("post", {
        tags: ["Events"],
        summary: raw.endsWith("/ack") ? "Event fuer Consumer bestaetigen" : "Event-Fehler fuer Consumer protokollieren",
        operationId: `${raw.split("/").filter(Boolean).join("_")}_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, JsonObject),
        responses: withCommon(v, { 200: resp("Consumer-Status aktualisiert", JsonObject, deprecatedHeaders(v)), 201: resp("Fehler protokolliert", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  })),
  ...["/api/exports/waste/orders", "/api/exports/waste/invoices", "/api/exports/waste/routes"].map((raw) => ({
    path: raw.replace(/^\/api/, ""),
    rawPath: raw,
    operations: (v) => ({
      ...op("get", {
        tags: ["Exports"],
        summary: `Export ${raw.split("/").slice(-1)[0]}`,
        operationId: `${raw.split("/").filter(Boolean).join("_")}_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("format", { type: "string", enum: ["json", "csv"] }, "Ausgabeformat"), qp("from", { type: "string", format: "date-time" }, "Von"), qp("to", { type: "string", format: "date-time" }, "Bis"), qp("day", { type: "string", format: "date" }, "Tag")],
        responses: { ...errorResponses(v), 200: csvResp("CSV-Export oder JSON je nach format") },
      }),
    }),
  })),
  {
    path: "/reports/disposition/summary",
    rawPath: "/api/reports/disposition/summary",
    operations: (v) => ({
      ...op("get", {
        tags: ["Reports"],
        summary: "Disposition KPI Summary lesen",
        operationId: `dispositionSummary_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("from", { type: "string", format: "date-time" }, "Von"), qp("to", { type: "string", format: "date-time" }, "Bis"), qp("depotCode", { type: "string" }, "Depot"), qp("format", { type: "string", enum: ["json", "csv"] }, "Ausgabeformat")],
        responses: { ...errorResponses(v), 200: resp("Summary", JsonObject, deprecatedHeaders(v)) },
      }),
    }),
  },
  ...["/api/reconcile/ahlert24/run", "/api/reconcile/ahlert24/latest", "/api/reconcile/ahlert24/runs"].map((raw) => ({
    path: raw.replace(/^\/api/, ""),
    rawPath: raw,
    operations: (v) =>
      raw.endsWith("/run")
        ? {
            ...op("post", {
              tags: ["Import"],
              summary: "Ahlert24 Reconcile-Lauf starten",
              operationId: `reconcileRunCreate_${v}`,
              deprecated: ApiVersions[v].deprecated,
              requestBody: requestBody(false, { type: "object", properties: { mode: { type: "string", enum: ["mock", "live"] } } }),
              responses: withCommon(v, { 201: resp("Reconcile-Lauf angelegt", JsonObject, deprecatedHeaders(v)) }),
            }),
            ...op("get", {
              tags: ["Import"],
              summary: "Reconcile-Lauf lesen",
              operationId: `reconcileRunGet_${v}`,
              deprecated: ApiVersions[v].deprecated,
              parameters: [qp("id", { type: "string" }, "Run-ID", true)],
              responses: withCommon(v, { 200: resp("Reconcile-Lauf", JsonObject, deprecatedHeaders(v)) }),
            }),
          }
        : {
            ...op("get", {
              tags: ["Import"],
              summary: raw.endsWith("/latest") ? "Letzten Reconcile-Lauf lesen" : "Reconcile-Laeufe listen",
              operationId: `${raw.endsWith("/latest") ? "reconcileLatest" : "reconcileRuns"}_${v}`,
              deprecated: ApiVersions[v].deprecated,
              parameters: raw.endsWith("/runs") ? [qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl")] : [],
              responses: withCommon(v, { 200: resp("Reconcile-Daten", JsonObject, deprecatedHeaders(v)) }),
            }),
          },
  })),
  {
    path: "/workshop/cases",
    rawPath: "/api/workshop/cases",
    operations: (v) => ({
      ...op("get", {
        tags: ["Workshop"],
        summary: "Werkstattfaelle lesen",
        operationId: `workshopCasesList_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: [qp("vehicleId", { type: "string" }, "Fahrzeug-ID"), qp("status", { type: "string" }, "Status"), qp("assignedTo", { type: "string" }, "Zugewiesen an"), qp("workState", { type: "string" }, "Arbeitsstatus"), qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl")],
        responses: withCommon(v, { 200: resp("Werkstattfaelle", JsonObject, deprecatedHeaders(v)) }),
      }),
      ...op("post", {
        tags: ["Workshop"],
        summary: "Werkstattfall anlegen",
        operationId: `workshopCasesCreate_${v}`,
        deprecated: ApiVersions[v].deprecated,
        requestBody: requestBody(true, JsonObject),
        responses: withCommon(v, { 201: resp("Werkstattfall angelegt", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  },
  ...["/api/workshop/orders/pool", "/api/workshop/orders/assign", "/api/workshop/cases/close", "/api/workshop/planning/slots", "/api/workshop/planning/slots/set", "/api/workshop/reports/kpis"].map((raw) => ({
    path: raw.replace(/^\/api/, ""),
    rawPath: raw,
    operations: (v) => ({
      ...op(raw.endsWith("/pool") || raw.endsWith("/slots") || raw.endsWith("/kpis") ? "get" : "post", {
        tags: ["Workshop"],
        summary:
          raw.endsWith("/pool") ? "Werkstatt-Pool lesen" :
          raw.endsWith("/assign") ? "Werkstattauftrag zuweisen" :
          raw.endsWith("/close") ? "Werkstattfall schliessen" :
          raw.endsWith("/slots") ? "Werkstatt-Slotplan lesen" :
          raw.endsWith("/slots/set") ? "Werkstatt-Slot setzen" : "Workshop KPI Report lesen",
        operationId: `${raw.split("/").filter(Boolean).join("_")}_${v}`,
        deprecated: ApiVersions[v].deprecated,
        parameters: raw.endsWith("/pool") || raw.endsWith("/slots") || raw.endsWith("/kpis") ? [qp("limit", { type: "integer", minimum: 1, maximum: 200 }, "Maximale Anzahl"), qp("format", { type: "string", enum: ["json", "csv"] }, "Ausgabeformat")] : [],
        requestBody: raw.endsWith("/pool") || raw.endsWith("/slots") || raw.endsWith("/kpis") ? undefined : requestBody(true, JsonObject),
        responses: withCommon(v, { 200: resp("Workshop Antwort", JsonObject, deprecatedHeaders(v)), 201: resp("Workshop Antwort", JsonObject, deprecatedHeaders(v)) }),
      }),
    }),
  })),
];

function buildPaths(versionKey) {
  const paths = {};
  for (const route of routeCatalog) {
    paths[route.path] = route.operations(versionKey);
  }
  return paths;
}

export function listDocumentedRawPaths() {
  return routeCatalog.map((x) => x.rawPath);
}

export function buildOpenApiSpec(versionKey = "v2") {
  const version = ApiVersions[versionKey];
  if (!version) throw new Error("unsupported_api_version");
  return {
    openapi: "3.1.0",
    info: {
      title: version.title,
      version: version.version,
      summary: `Versionierte Kernschnittstellen (${versionKey})`,
      description: version.description,
      contact: { name: "Ahlert ERP API Team" },
    },
    servers: [{ url: version.serverUrl, description: `${versionKey.toUpperCase()} Base URL` }],
    tags: [
      { name: "Auth" },
      { name: "Customers" },
      { name: "Contracts" },
      { name: "Items" },
      { name: "Pricing" },
      { name: "Billing" },
      { name: "Waste" },
      { name: "Routing" },
      { name: "Disposition" },
      { name: "Traffic" },
      { name: "Events" },
      { name: "Exports" },
      { name: "Reports" },
      { name: "Import" },
      { name: "Workshop" },
    ],
    paths: buildPaths(versionKey),
    components: {
      securitySchemes: {
        HeaderUserAuth: {
          type: "apiKey",
          in: "header",
          name: "x-user",
          description: "Entwicklungs-/Systemauthentifizierung ueber Request-Header; je nach Endpoint zusammen mit x-permissions.",
        },
        HeaderPermissions: {
          type: "apiKey",
          in: "header",
          name: "x-permissions",
          description: "Kommagetrennte Berechtigungen fuer Admin-/Systemzugriffe.",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            error: { type: "string" },
            message: { type: "string" },
            details: JsonObject,
          },
        },
        AuthSession: {
          type: "object",
          properties: {
            user: { type: "object", properties: { username: { type: "string" }, permissions: { type: "array", items: { type: "string" } } } },
            accessToken: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        CustomerWrite: {
          type: "object",
          required: ["customerNo", "name"],
          properties: {
            customerNo: { type: "string" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
            active: { type: "boolean" },
            legalForm: { type: "string" },
            vatId: { type: "string" },
          },
        },
        ContractWrite: {
          type: "object",
          required: ["customerId", "contractNo", "validFrom"],
          properties: {
            customerId: { type: "string" },
            contractNo: { type: "string" },
            title: { type: "string" },
            status: { type: "string" },
            validFrom: { type: "string", format: "date" },
            validTo: { type: "string", format: "date" },
          },
        },
        MaterialWrite: {
          type: "object",
          required: ["code", "name", "unit"],
          properties: {
            code: { type: "string" },
            name: { type: "string" },
            unit: { type: "string" },
            hazardClass: { type: "string" },
            active: { type: "boolean" },
          },
        },
        PriceListWrite: {
          type: "object",
          required: ["code", "name", "currency", "validFrom"],
          properties: {
            code: { type: "string" },
            name: { type: "string" },
            currency: { type: "string", pattern: "^[A-Z]{3}$" },
            status: { type: "string" },
            validFrom: { type: "string", format: "date" },
            validTo: { type: "string", format: "date" },
          },
        },
        PriceListItemWrite: {
          type: "object",
          required: ["priceListId", "itemType", "refCode", "unit", "minQty", "unitPriceCents"],
          properties: {
            priceListId: { type: "string" },
            itemType: { type: "string" },
            refCode: { type: "string" },
            unit: { type: "string" },
            minQty: { type: "number" },
            maxQty: { type: "number" },
            unitPriceCents: { type: "integer" },
          },
        },
        FeeWrite: {
          type: "object",
          required: ["code", "name", "calculationMode", "amountCents", "currency", "validFrom"],
          properties: {
            code: { type: "string" },
            name: { type: "string" },
            calculationMode: { type: "string" },
            amountCents: { type: "integer" },
            currency: { type: "string", pattern: "^[A-Z]{3}$" },
            validFrom: { type: "string", format: "date" },
            validTo: { type: "string", format: "date" },
          },
        },
        WasteOrderWrite: {
          type: "object",
          required: ["containerSourceKey", "serviceType", "windowDeliverStart", "windowDeliverEnd", "site"],
          properties: {
            customerId: { type: "string" },
            contractId: { type: "string" },
            customerTier: { type: "string" },
            containerSourceKey: { type: "string" },
            serviceType: { type: "string" },
            windowDeliverStart: { type: "string", format: "date-time" },
            windowDeliverEnd: { type: "string", format: "date-time" },
            materialCode: { type: "string" },
            plannedTons: { type: "number" },
            plannedVolumeCbm: { type: "number" },
            priorityUrgency: { type: "string" },
            site: JsonObject,
          },
        },
      },
    },
  };
}

export function validateOpenApiSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object") errors.push("spec_missing");
  if (!spec?.openapi || !String(spec.openapi).startsWith("3.")) errors.push("openapi_version_invalid");
  if (!spec?.info?.title) errors.push("info_title_missing");
  if (!spec?.info?.version) errors.push("info_version_missing");
  if (!spec?.paths || typeof spec.paths !== "object") errors.push("paths_missing");
  const pathKeys = Object.keys(spec?.paths || {});
  if (pathKeys.length === 0) errors.push("paths_empty");
  for (const path of pathKeys) {
    if (!path.startsWith("/")) errors.push(`path_invalid:${path}`);
    const ops = spec.paths[path];
    if (!ops || typeof ops !== "object") {
      errors.push(`path_ops_missing:${path}`);
      continue;
    }
    for (const [method, opDef] of Object.entries(ops)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method)) errors.push(`method_invalid:${path}:${method}`);
      if (!opDef.summary) errors.push(`summary_missing:${path}:${method}`);
      if (!opDef.responses || typeof opDef.responses !== "object") errors.push(`responses_missing:${path}:${method}`);
    }
  }
  return { ok: errors.length === 0, errors, pathCount: pathKeys.length };
}

export function buildApiDocsMetrics(serverRoutePaths = []) {
  const documentedRawPaths = listDocumentedRawPaths();
  const implemented = new Set(serverRoutePaths);
  const covered = documentedRawPaths.filter((p) => implemented.has(p));
  const docCoveragePct = documentedRawPaths.length ? Math.round((covered.length / documentedRawPaths.length) * 10000) / 100 : 0;
  return {
    documentedRouteCount: documentedRawPaths.length,
    implementedRouteCount: implemented.size,
    matchedRouteCount: covered.length,
    docCoveragePct,
    parallelVersionsSupported: Object.keys(ApiVersions).length,
    deprecatedVersions: Object.entries(ApiVersions).filter(([, v]) => v.deprecated).map(([k]) => k),
    integrationRiskReduction: {
      before: "Unversionierte und nur implizit dokumentierte Schnittstellen erhoehen Migrations- und Integrationsrisiken.",
      after: "Versionierte Spezifikationen, Deprecation-Hinweise und validierte Doku machen Releases planbar und reduzieren Breaking-Change-Risiken.",
    },
  };
}

export { ApiVersions };
