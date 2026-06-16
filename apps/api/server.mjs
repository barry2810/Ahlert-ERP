import http from "node:http";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import pg from "pg";
import { ApiVersions, buildApiDocsMetrics, buildOpenApiSpec, listDocumentedRawPaths, validateOpenApiSpec } from "./openapi-specs.mjs";

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const databaseUrl = process.env.DATABASE_URL || "";
const { Pool } = pg;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
    })
  : null;

function migrationsDirPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "migrations");
}

async function ensureMigrationsTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      id text primary key,
      filename text not null,
      checksum_sha256 text not null,
      status text not null,
      applied_at timestamptz not null,
      execution_ms int not null,
      error text null
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'schema_migrations_status_chk') then
        alter table schema_migrations add constraint schema_migrations_status_chk check (status in ('applied','failed'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists schema_migrations_applied_at_idx on schema_migrations (applied_at desc);`);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

async function loadMigrationsFromDisk() {
  const dir = migrationsDirPath();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".mjs"));
  } catch {
    return { ok: true, items: [] };
  }
  names.sort((a, b) => a.localeCompare(b));
  const items = [];
  for (const filename of names) {
    if (!/^\d{4,}_/.test(filename)) continue;
    const abs = path.join(dir, filename);
    const url = pathToFileURL(abs).href;
    const mod = await import(url);
    const id = typeof mod.id === "string" ? mod.id : filename.replace(/\.mjs$/, "");
    const up = typeof mod.up === "function" ? mod.up : null;
    const down = typeof mod.down === "function" ? mod.down : null;
    if (!up) throw new Error(`migration_missing_up:${filename}`);
    const source = fs.readFileSync(abs, "utf8");
    const checksum = sha256Hex(source);
    items.push({ id, filename, absPath: abs, checksum, up, down });
  }
  return { ok: true, items };
}

async function runMigrations({ direction = "up", toId = null } = {}) {
  if (!pool) return { ok: true, applied: [], skipped: [], direction };
  const migs = await loadMigrationsFromDisk();
  if (!migs.ok) return migs;
  const list = migs.items;
  const allowChecksumUpdateRaw = String(process.env.ERP_MIGRATIONS_ALLOW_CHECKSUM_UPDATE || "").trim().toLowerCase();
  const allowChecksumUpdateAll = allowChecksumUpdateRaw === "true" || allowInsecureHeaders;
  const allowChecksumUpdateIds = new Set(
    allowChecksumUpdateRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const client = await pool.connect();
  const applied = [];
  const skipped = [];
  try {
    await client.query(`select pg_advisory_lock(842019463);`);
    await ensureMigrationsTable(client);
    const existing = await client.query(`select id, filename, checksum_sha256, status from schema_migrations order by applied_at asc;`).then((r) => r.rows);
    const byId = new Map(existing.map((r) => [String(r.id), r]));

    if (direction === "down") {
      const appliedIds = existing.filter((r) => r.status === "applied").map((r) => String(r.id));
      const wanted = toId ? new Set(appliedIds.slice(0, appliedIds.indexOf(toId) + 1)) : new Set();
      const toRollback = appliedIds.filter((id) => !wanted.has(id)).reverse();
      for (const id of toRollback) {
        const m = list.find((x) => x.id === id) || null;
        if (!m || !m.down) throw new Error(`migration_no_down:${id}`);
        const started = Date.now();
        await client.query("begin;");
        try {
          await m.down({ client });
          const ms = Date.now() - started;
          await client.query(`delete from schema_migrations where id = $1;`, [id]);
          await client.query("commit;");
          applied.push({ id, filename: m.filename, direction: "down", ms });
        } catch (e) {
          await client.query("rollback;");
          throw e;
        }
      }
      return { ok: true, applied, skipped, direction };
    }

    for (const m of list) {
      const seen = byId.get(m.id) || null;
      if (seen) {
        if (seen.status !== "applied") throw new Error(`migration_previous_failed:${m.id}`);
        if (String(seen.checksum_sha256) !== m.checksum) {
          const allowed = allowChecksumUpdateAll || allowChecksumUpdateIds.has(m.id) || allowChecksumUpdateIds.has("*");
          if (!allowed) throw new Error(`migration_checksum_mismatch:${m.id}`);
          await client.query(`update schema_migrations set checksum_sha256 = $2, filename = $3 where id = $1;`, [m.id, m.checksum, m.filename]);
        }
        skipped.push({ id: m.id, filename: m.filename });
        if (toId && m.id === toId) break;
        continue;
      }
      const started = Date.now();
      await client.query("begin;");
      try {
        await m.up({ client });
        const ms = Date.now() - started;
        await client.query(
          `
          insert into schema_migrations (id, filename, checksum_sha256, status, applied_at, execution_ms, error)
          values ($1,$2,$3,'applied', now(), $4, null);
          `,
          [m.id, m.filename, m.checksum, ms],
        );
        await client.query("commit;");
        applied.push({ id: m.id, filename: m.filename, direction: "up", ms });
      } catch (e) {
        const ms = Date.now() - started;
        try {
          await client.query(
            `
            insert into schema_migrations (id, filename, checksum_sha256, status, applied_at, execution_ms, error)
            values ($1,$2,$3,'failed', now(), $4, $5);
            `,
            [m.id, m.filename, m.checksum, ms, String(e && e.message ? e.message : e)],
          );
        } catch {}
        try {
          await client.query("rollback;");
        } catch {}
        throw e;
      }
      if (toId && m.id === toId) break;
    }
    return { ok: true, applied, skipped, direction };
  } finally {
    try {
      await client.query(`select pg_advisory_unlock(842019463);`);
    } catch {}
    client.release();
  }
}

const modules = [
  { key: "dashboard", label: "Dashboard", href: "/", status: "active" },
  { key: "waste", label: "Entsorgung & Verwertung", href: "/?module=waste", status: "planned" },
  { key: "sewage", label: "Kanal-Service", href: "/?module=sewage", status: "planned" },
  { key: "fuel", label: "Brennstoffe & Energie Logistik", href: "/?module=fuel", status: "planned" },
  { key: "workshop", label: "Werkstatt", href: "/?module=workshop", status: "planned" },
];

const supportedApiVersions = new Set(Object.keys(ApiVersions));

function parseApiVersionContext(pathname) {
  const p = typeof pathname === "string" ? pathname : "/";
  const match = p.match(/^\/api\/v(\d+)(\/.*|$)/);
  if (match) {
    const versionKey = `v${match[1]}`;
    if (!supportedApiVersions.has(versionKey)) return { ok: false, unsupported: true, requestedVersion: versionKey, routePath: p };
    const suffix = match[2] || "";
    return { ok: true, versionKey, routePath: `/api${suffix === "" ? "" : suffix}`, explicit: true, deprecated: Boolean(ApiVersions[versionKey]?.deprecated) };
  }
  if (p === "/api" || p.startsWith("/api/")) {
    return { ok: true, versionKey: null, routePath: p, explicit: false, deprecated: true, legacyAlias: true };
  }
  return { ok: true, versionKey: null, routePath: p, explicit: false, deprecated: false };
}

function applyApiVersionHeaders(res, ctx) {
  if (!ctx) return;
  const activeVersion = ctx.versionKey || "legacy";
  res.setHeader("api-version", activeVersion);
  if (activeVersion === "legacy") {
    res.setHeader("deprecation", "true");
    res.setHeader("sunset", "Wed, 31 Dec 2026 23:59:59 GMT");
    res.setHeader("link", '</api/docs/openapi/v2.json>; rel="successor-version", </swagger.html?version=v2>; rel="service-desc"');
    res.setHeader("warning", '299 - "Unversionierte API ist veraltet. Bitte auf /api/v2 wechseln."');
    return;
  }
  if (ctx.deprecated) {
    const v = ApiVersions[activeVersion];
    res.setHeader("deprecation", "true");
    if (v?.sunset) res.setHeader("sunset", new Date(`${v.sunset}T23:59:59Z`).toUTCString());
    res.setHeader("link", '</api/docs/openapi/v2.json>; rel="successor-version", </swagger.html?version=v2>; rel="service-desc"');
  } else {
    res.setHeader("link", `</api/docs/openapi/${activeVersion}.json>; rel="service-desc", </swagger.html?version=${activeVersion}>; rel="service-doc"`);
  }
}

const Permissions = {
  CreateBlock: "CREATE_BLOCK",
  OverrideSoft: "OVERRIDE_SOFT",
  OverrideHard: "OVERRIDE_HARD",
  ViewAudit: "VIEW_AUDIT",
  OverrideDispatch: "OVERRIDE_DISPATCH",
  FleetAdmin: "FLEET_ADMIN",
  AuthAdmin: "AUTH_ADMIN",
  CustomerView: "CUSTOMER_VIEW",
  CustomerManage: "CUSTOMER_MANAGE",
  ContractView: "CONTRACT_VIEW",
  ContractManage: "CONTRACT_MANAGE",
  PricingView: "PRICING_VIEW",
  PricingManage: "PRICING_MANAGE",
  WasteRouteView: "WASTE_ROUTE_VIEW",
  WasteRoutePlan: "WASTE_ROUTE_PLAN",
  WasteRouteManage: "WASTE_ROUTE_MANAGE",
  WorkshopAdmin: "WORKSHOP_ADMIN",
  WorkshopView: "WORKSHOP_VIEW",
  WorkshopCreate: "WORKSHOP_CREATE",
  WorkshopAssign: "WORKSHOP_ASSIGN",
  WorkshopWork: "WORKSHOP_WORK",
  InventoryView: "INVENTORY_VIEW",
  InventoryMove: "INVENTORY_MOVE",
  InventoryAdmin: "INVENTORY_ADMIN",
  TrainingCatalogView: "TRAINING_CATALOG_VIEW",
  TrainingCatalogAdmin: "TRAINING_CATALOG_ADMIN",
  TrainingPlanView: "TRAINING_PLAN_VIEW",
  TrainingPlanManage: "TRAINING_PLAN_MANAGE",
  TrainingCredentialView: "TRAINING_CREDENTIAL_VIEW",
  TrainingCredentialIssue: "TRAINING_CREDENTIAL_ISSUE",
  TrainingCredentialRevoke: "TRAINING_CREDENTIAL_REVOKE",
  TrainingEmployeeView: "TRAINING_EMPLOYEE_VIEW",
  TrainingEmployeeAdmin: "TRAINING_EMPLOYEE_ADMIN",
  TrainingSelfView: "TRAINING_SELF_VIEW",
  TrainingSensitiveView: "TRAINING_SENSITIVE_VIEW",
  TrainingSensitiveAdmin: "TRAINING_SENSITIVE_ADMIN",
  TrainingExport: "TRAINING_EXPORT",
  ApprovalView: "APPROVAL_VIEW",
  ApprovalRequest: "APPROVAL_REQUEST",
  ApprovalApprovePricingL1: "APPROVAL_APPROVE_PRICING_L1",
  ApprovalApprovePricingL2: "APPROVAL_APPROVE_PRICING_L2",
  ApprovalApproveBilling: "APPROVAL_APPROVE_BILLING",
  ApprovalApproveMasterdata: "APPROVAL_APPROVE_MASTERDATA",
  ApprovalApproveRouteOverrideL1: "APPROVAL_APPROVE_ROUTE_OVERRIDE_L1",
  ApprovalApproveRouteOverrideL2: "APPROVAL_APPROVE_ROUTE_OVERRIDE_L2",
};

const allowInsecureHeaders = process.env.ERP_ALLOW_INSECURE_HEADERS === "true";
const tokensJson = process.env.ERP_TOKENS_JSON || "";
const jwtSecretEnv = String(process.env.ERP_JWT_SECRET || "");
const jwtSecret = jwtSecretEnv || (allowInsecureHeaders ? crypto.randomBytes(32).toString("hex") : "");
const publicBaseUrl = normalizeString(process.env.PUBLIC_BASE_URL) || `http://localhost:${port}`;
const couplinkBaseUrl = (normalizeString(process.env.COUPLINK_BASE_URL) || "https://api.couplink.de/v1").replace(/\/+$/, "");
const couplinkToken = String(process.env.COUPLINK_TOKEN || "").trim();
const osrmBaseUrl = normalizeString(process.env.OSRM_BASE_URL).replace(/\/+$/, "");
const hereTrafficBaseUrl = (normalizeString(process.env.HERE_TRAFFIC_BASE_URL) || "https://data.traffic.hereapi.com/v7").replace(/\/+$/, "");
const hereRoutingBaseUrl = (normalizeString(process.env.HERE_ROUTING_BASE_URL) || "https://router.hereapi.com/v8").replace(/\/+$/, "");
const hereApiKey = String(process.env.HERE_API_KEY || "").trim();
const hereMonthlyLimit = 250000;
const hereWarnPct = process.env.HERE_WARN_PCT ? Math.max(0.1, Math.min(0.99, Number(process.env.HERE_WARN_PCT) || 0.8)) : 0.8;
const hereCriticalPct = process.env.HERE_CRITICAL_PCT ? Math.max(hereWarnPct, Math.min(0.995, Number(process.env.HERE_CRITICAL_PCT) || 0.95)) : 0.95;
const hereRefreshIntervalMs = process.env.HERE_REFRESH_INTERVAL_MS ? Math.max(60000, Math.min(15 * 60 * 1000, Number(process.env.HERE_REFRESH_INTERVAL_MS) || 5 * 60 * 1000)) : 5 * 60 * 1000;
const routeDelayThresholdMinutes = process.env.ERP_ROUTE_DELAY_THRESHOLD_MINUTES ? Math.max(1, Math.min(180, Number(process.env.ERP_ROUTE_DELAY_THRESHOLD_MINUTES) || 10)) : 10;
const accessTokenTtlSeconds = process.env.ERP_ACCESS_TOKEN_TTL_SECONDS ? Number(process.env.ERP_ACCESS_TOKEN_TTL_SECONDS) : 15 * 60;
const refreshTokenTtlSeconds = process.env.ERP_REFRESH_TOKEN_TTL_SECONDS ? Number(process.env.ERP_REFRESH_TOKEN_TTL_SECONDS) : 30 * 24 * 60 * 60;
const cookieSecure = String(process.env.ERP_COOKIE_SECURE || "").trim().toLowerCase()
  ? String(process.env.ERP_COOKIE_SECURE || "").trim().toLowerCase() === "true"
  : String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
const cookieDomain = normalizeString(process.env.ERP_COOKIE_DOMAIN) || null;
const cookieSameSite = normalizeString(process.env.ERP_COOKIE_SAMESITE) || "strict";
const allowStaticTokens = process.env.ERP_ALLOW_STATIC_TOKENS === "true";

let tokens = null;
if (tokensJson) {
  try {
    tokens = JSON.parse(tokensJson);
  } catch {
    tokens = null;
  }
}

if (!tokens) {
  tokens = {};
}

const ReasonCatalog = {
  ok: { category: "system", severity: "info", overrideLevel: "standard", description: "Keine Einschränkungen." },
  manual_override: { category: "override", severity: "warning", overrideLevel: "standard", description: "Manuelle Überschreibung aktiv." },

  hard_block: { category: "block", severity: "critical", overrideLevel: "elevated", description: "Harte Sperre aktiv im Zeitfenster." },
  soft_block_warning: { category: "block", severity: "warning", overrideLevel: "standard", description: "Weiche Sperre aktiv im Zeitfenster." },
  inspection_due: { category: "compliance", severity: "critical", overrideLevel: "elevated", description: "Prüfung ist fällig oder überfällig, Einheit ist gesperrt bis zur erfolgreichen Prüfung." },

  missing_capability: { category: "capability", severity: "critical", overrideLevel: "standard", description: "Fahrzeug erfüllt Capability-Anforderung nicht." },

  container_size_not_supported: { category: "matching", severity: "critical", overrideLevel: "elevated", description: "Containergröße nicht kompatibel mit Fahrzeugausstattung." },
  container_type_not_supported: { category: "matching", severity: "critical", overrideLevel: "elevated", description: "Containertyp (z. B. Kühl/Spezial) nicht kompatibel mit Fahrzeugausstattung." },
  grappler_not_supported: { category: "matching", severity: "critical", overrideLevel: "elevated", description: "Greifertyp nicht kompatibel mit Fahrzeugausstattung/Zulassung." },
  adr_not_supported: { category: "legal", severity: "critical", overrideLevel: "elevated", description: "ADR-Anforderung nicht erfüllt (Fahrzeug nicht ADR-zugelassen / Klasse fehlt)." },

  wrong_depot: { category: "depot", severity: "critical", overrideLevel: "standard", description: "Standortanforderung passt nicht zum Fahrzeugstandort." },
  vehicle_depot_unknown: { category: "depot", severity: "warning", overrideLevel: "standard", description: "Fahrzeugstandort unbekannt; Standortprüfung nicht möglich." },
  depot_recommended: { category: "depot", severity: "info", overrideLevel: "standard", description: "Depotempfehlung berechnet." },
  depot_candidates_missing: { category: "depot", severity: "warning", overrideLevel: "standard", description: "Keine Depotdaten verfügbar; Depotempfehlung nicht möglich." },

  distance_exceeded: { category: "geo", severity: "critical", overrideLevel: "standard", description: "Maximaldistanz überschritten." },
  vehicle_location_unknown: { category: "geo", severity: "warning", overrideLevel: "standard", description: "Fahrzeugkoordinaten fehlen; Distanzprüfung nicht möglich." },

  vehicle_exclusive_driver_mismatch: { category: "driver", severity: "critical", overrideLevel: "elevated", description: "Exklusive Fahrerbindung verletzt (Fahrzeug an anderen Fahrer gebunden)." },
  driver_exclusive_to_other_vehicle: { category: "driver", severity: "critical", overrideLevel: "elevated", description: "Exklusive Fahrerbindung verletzt (Fahrer an anderes Fahrzeug gebunden)." },
  vehicle_preferred_driver_mismatch: { category: "driver", severity: "warning", overrideLevel: "standard", description: "Bevorzugte Fahrerbindung weicht ab (Warnung)." },

  weigh_system_not_ok: { category: "system", severity: "critical", overrideLevel: "standard", description: "Wiegesystem nicht OK, obwohl erforderlich." },
  tank_system_not_ok: { category: "system", severity: "critical", overrideLevel: "standard", description: "Tanksystem nicht OK, obwohl erforderlich." },
  weigh_system_down: { category: "system", severity: "warning", overrideLevel: "standard", description: "Wiegesystem gestört (Warnung)." },
  tank_system_down: { category: "system", severity: "warning", overrideLevel: "standard", description: "Tanksystem gestört (Warnung)." },

  shift_window_violation: { category: "time", severity: "critical", overrideLevel: "standard", description: "Zeitfenster liegt außerhalb der Schicht." },
  driver_overtime_violation: { category: "time", severity: "critical", overrideLevel: "elevated", description: "Überstundenregel verletzt (Arbeitszeitlimit überschritten)." },
  driver_rest_violation: { category: "time", severity: "critical", overrideLevel: "elevated", description: "Ruhezeitregel verletzt." },
  vehicle_time_conflict: { category: "time", severity: "critical", overrideLevel: "standard", description: "Zeitkonflikt mit bestehender Fahrzeugdisposition." },
  driver_time_conflict: { category: "time", severity: "critical", overrideLevel: "standard", description: "Zeitkonflikt mit bestehender Fahrerdisposition." },
};

function reasonMeta(code) {
  return ReasonCatalog[code] || { category: "unknown", severity: "warning", overrideLevel: "standard", description: "Unbekannter reasonCode." };
}

function forbidden(res) {
  json(res, 403, { error: "forbidden" });
}

function unauthorized(res) {
  json(res, 401, { error: "unauthorized" });
}

function getAuth(req) {
  const authHeader = String(req.headers.authorization || "");
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    const jwt = verifyJwt(token);
    if (jwt.ok && jwt.payload && jwt.payload.typ === "access") {
      const username = typeof jwt.payload.username === "string" ? jwt.payload.username : null;
      const userId = typeof jwt.payload.sub === "string" ? jwt.payload.sub : null;
      const permissions = Array.isArray(jwt.payload.perms) ? jwt.payload.perms.filter((p) => typeof p === "string") : [];
      return { username, userId, permissions: new Set(permissions), mode: "jwt" };
    }
    if (allowStaticTokens) {
      const record = tokens && token ? tokens[token] : null;
      if (record && typeof record.username === "string") {
        const permissions = Array.isArray(record.permissions) ? record.permissions.filter((p) => typeof p === "string") : [];
        return { username: record.username, userId: null, permissions: new Set(permissions), mode: "static_token" };
      }
    }
    return { username: null, userId: null, permissions: new Set(), mode: "bearer_invalid" };
  }

  const cookies = parseCookies(req.headers.cookie);
  const accessCookie = normalizeString(cookies.erp_access);
  if (accessCookie) {
    const jwt = verifyJwt(accessCookie);
    if (jwt.ok && jwt.payload && jwt.payload.typ === "access") {
      const username = typeof jwt.payload.username === "string" ? jwt.payload.username : null;
      const userId = typeof jwt.payload.sub === "string" ? jwt.payload.sub : null;
      const permissions = Array.isArray(jwt.payload.perms) ? jwt.payload.perms.filter((p) => typeof p === "string") : [];
      return { username, userId, permissions: new Set(permissions), mode: "cookie" };
    }
  }

  if (allowInsecureHeaders) {
    const username = req.headers["x-user"] ? String(req.headers["x-user"]) : null;
    const permsRaw = req.headers["x-permissions"] ? String(req.headers["x-permissions"]) : "";
    const permissions = permsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { username, userId: null, permissions: new Set(permissions), mode: "insecure_headers" };
  }

  return { username: null, userId: null, permissions: new Set(), mode: "anonymous" };
}

function getAuthForStream(req, url) {
  const base = getAuth(req);
  if (base.username) return base;

  const token = String(url.searchParams.get("token") || "").trim();
  if (token) {
    const jwt = verifyJwt(token);
    if (jwt.ok && jwt.payload && jwt.payload.typ === "access") {
      const username = typeof jwt.payload.username === "string" ? jwt.payload.username : null;
      const userId = typeof jwt.payload.sub === "string" ? jwt.payload.sub : null;
      const permissions = Array.isArray(jwt.payload.perms) ? jwt.payload.perms.filter((p) => typeof p === "string") : [];
      return { username, userId, permissions: new Set(permissions), mode: "jwt_query" };
    }
    if (allowStaticTokens) {
      const record = tokens && tokens[token] ? tokens[token] : null;
      if (record && typeof record.username === "string") {
        const permissions = Array.isArray(record.permissions) ? record.permissions.filter((p) => typeof p === "string") : [];
        return { username: record.username, userId: null, permissions: new Set(permissions), mode: "static_token_query" };
      }
    }
    return { username: null, userId: null, permissions: new Set(), mode: "query_invalid" };
  }

  if (allowInsecureHeaders) {
    const username = String(url.searchParams.get("user") || "").trim() || null;
    const permsRaw = String(url.searchParams.get("permissions") || "").trim();
    const permissions = permsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { username, userId: null, permissions: new Set(permissions), mode: "insecure_query" };
  }

  return base;
}

function parseCookies(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || "");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function appendSetCookie(res, value) {
  const prev = res.getHeader("set-cookie");
  if (!prev) res.setHeader("set-cookie", [value]);
  else if (Array.isArray(prev)) res.setHeader("set-cookie", [...prev, value]);
  else res.setHeader("set-cookie", [String(prev), value]);
}

function setCookie(res, name, value, opts) {
  const parts = [`${name}=${encodeURIComponent(String(value))}`];
  if (opts && typeof opts.maxAgeSeconds === "number") parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`);
  if (opts && opts.path) parts.push(`Path=${opts.path}`);
  else parts.push("Path=/");
  if (opts && opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts && opts.httpOnly) parts.push("HttpOnly");
  if (opts && opts.secure) parts.push("Secure");
  if (opts && opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  appendSetCookie(res, parts.join("; "));
}

function clearCookie(res, name) {
  setCookie(res, name, "", { maxAgeSeconds: 0, path: "/", domain: cookieDomain, httpOnly: true, secure: cookieSecure, sameSite: cookieSameSite });
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(str) {
  const s = String(str || "").replaceAll("-", "+").replaceAll("_", "/");
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  return Buffer.from(s + pad, "base64");
}

function signJwt(payload) {
  if (!jwtSecret) return null;
  const header = { alg: "HS256", typ: "JWT" };
  const h = base64UrlEncode(JSON.stringify(header));
  const p = base64UrlEncode(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const sig = crypto.createHmac("sha256", jwtSecret).update(data).digest();
  return `${data}.${base64UrlEncode(sig)}`;
}

function verifyJwt(token) {
  if (!jwtSecret) return { ok: false, error: "jwt_secret_missing" };
  const t = String(token || "");
  const parts = t.split(".");
  if (parts.length !== 3) return { ok: false, error: "jwt_invalid" };
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const sig = crypto.createHmac("sha256", jwtSecret).update(data).digest();
  const sigB64 = base64UrlEncode(sig);
  if (!crypto.timingSafeEqual(Buffer.from(sigB64), Buffer.from(String(s)))) return { ok: false, error: "jwt_invalid_sig" };
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(p).toString("utf8"));
  } catch {
    return { ok: false, error: "jwt_invalid_payload" };
  }
  if (!payload || typeof payload !== "object") return { ok: false, error: "jwt_invalid_payload" };
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (!exp) return { ok: false, error: "jwt_missing_exp" };
  if (Math.floor(Date.now() / 1000) >= exp) return { ok: false, error: "jwt_expired" };
  return { ok: true, payload };
}

function issueAccessToken({ userId, username, permissions }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(60, Math.floor(accessTokenTtlSeconds));
  const payload = {
    typ: "access",
    sub: userId,
    username,
    perms: Array.from(new Set(Array.isArray(permissions) ? permissions : [])),
    iat: now,
    exp,
    jti: crypto.randomUUID(),
  };
  return signJwt(payload);
}

function sha256Base64Url(text) {
  const h = crypto.createHash("sha256").update(String(text)).digest();
  return base64UrlEncode(h);
}

function randomBase64Url(bytes) {
  return base64UrlEncode(crypto.randomBytes(bytes));
}

function encodeFormUrl(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

function isSafeRelativeRedirect(value) {
  const v = String(value || "");
  if (!v) return false;
  if (!v.startsWith("/")) return false;
  if (v.startsWith("//")) return false;
  return true;
}

const oidcAzureTenantId = normalizeString(process.env.ERP_OIDC_AZURE_TENANT_ID);
const oidcAzureClientId = normalizeString(process.env.ERP_OIDC_AZURE_CLIENT_ID);
const oidcAzureClientSecret = String(process.env.ERP_OIDC_AZURE_CLIENT_SECRET || "");
const oidcAzureAuthorityHost = normalizeString(process.env.ERP_OIDC_AZURE_AUTHORITY_HOST) || "https://login.microsoftonline.com";
const oidcAzureRedirectUriEnv = normalizeString(process.env.ERP_OIDC_AZURE_REDIRECT_URI);
const oidcAzurePostLoginRedirectEnv = normalizeString(process.env.ERP_OIDC_AZURE_POST_LOGIN_REDIRECT);
const oidcAzureScopesEnv = normalizeString(process.env.ERP_OIDC_AZURE_SCOPES);
const oidcAzureGraphGroupsEnv = normalizeString(process.env.ERP_OIDC_AZURE_GRAPH_GROUPS);
const oidcAzureDefaultRolesEnv = normalizeString(process.env.ERP_OIDC_AZURE_DEFAULT_ROLES);
const oidcAzureGroupRoleMapJson = String(process.env.ERP_OIDC_AZURE_GROUP_ROLE_MAP_JSON || "");

function oidcAzureConfigured() {
  return Boolean(oidcAzureTenantId && oidcAzureClientId && jwtSecret && publicBaseUrl);
}

function oidcAzureRedirectUri() {
  if (oidcAzureRedirectUriEnv) return oidcAzureRedirectUriEnv;
  return `${publicBaseUrl.replace(/\/+$/, "")}/api/auth/oidc/azure/callback`;
}

function oidcAzureAuthorizeUrl() {
  const t = oidcAzureTenantId || "common";
  return `${oidcAzureAuthorityHost.replace(/\/+$/, "")}/${encodeURIComponent(t)}/oauth2/v2.0/authorize`;
}

function oidcAzureTokenUrl() {
  const t = oidcAzureTenantId || "common";
  return `${oidcAzureAuthorityHost.replace(/\/+$/, "")}/${encodeURIComponent(t)}/oauth2/v2.0/token`;
}

function oidcAzureJwksUrl() {
  const t = oidcAzureTenantId || "common";
  return `${oidcAzureAuthorityHost.replace(/\/+$/, "")}/${encodeURIComponent(t)}/discovery/v2.0/keys`;
}

function oidcAzureExpectedIssuer() {
  const t = oidcAzureTenantId || "common";
  return `${oidcAzureAuthorityHost.replace(/\/+$/, "")}/${encodeURIComponent(t)}/v2.0`;
}

function parseAzureGroupRoleMap() {
  if (!oidcAzureGroupRoleMapJson) return {};
  try {
    const obj = JSON.parse(oidcAzureGroupRoleMapJson);
    if (!obj || typeof obj !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const gid = normalizeString(k);
      if (!gid) continue;
      if (Array.isArray(v)) out[gid] = v.map((x) => normalizeString(x)).filter(Boolean);
      else {
        const one = normalizeString(v);
        out[gid] = one ? [one] : [];
      }
    }
    return out;
  } catch {
    return {};
  }
}

const oidcAzureGroupRoleMap = parseAzureGroupRoleMap();

const oidcJwksCache = {
  fetchedAtMs: 0,
  keys: [],
};

async function fetchAzureJwks() {
  const maxAgeMs = 6 * 60 * 60 * 1000;
  if (oidcJwksCache.keys.length && Date.now() - oidcJwksCache.fetchedAtMs < maxAgeMs) return oidcJwksCache.keys;
  const url = oidcAzureJwksUrl();
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error("oidc_jwks_fetch_failed");
  const data = await res.json();
  const keys = data && Array.isArray(data.keys) ? data.keys : [];
  oidcJwksCache.keys = keys;
  oidcJwksCache.fetchedAtMs = Date.now();
  return keys;
}

function decodeJwtParts(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { ok: false, error: "jwt_invalid" };
  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, error: "jwt_invalid" };
  }
  const sig = base64UrlDecode(parts[2]);
  return { ok: true, header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: sig };
}

function verifyJwtClaims({ payload, expectedAud, expectedIss, expectedNonce }) {
  const now = Math.floor(Date.now() / 1000);
  const leeway = 60;
  if (!payload || typeof payload !== "object") return { ok: false, error: "id_token_invalid" };
  if (expectedAud && payload.aud !== expectedAud) return { ok: false, error: "id_token_aud_mismatch" };
  if (expectedIss && payload.iss !== expectedIss) return { ok: false, error: "id_token_iss_mismatch" };
  if (typeof payload.exp !== "number" || now - leeway >= payload.exp) return { ok: false, error: "id_token_expired" };
  if (typeof payload.nbf === "number" && now + leeway < payload.nbf) return { ok: false, error: "id_token_not_yet_valid" };
  if (expectedNonce && payload.nonce !== expectedNonce) return { ok: false, error: "id_token_nonce_mismatch" };
  return { ok: true };
}

async function verifyAzureIdToken({ idToken, expectedNonce }) {
  const decoded = decodeJwtParts(idToken);
  if (!decoded.ok) return decoded;
  const header = decoded.header || {};
  if (header.alg !== "RS256") return { ok: false, error: "id_token_alg_invalid" };
  const kid = normalizeString(header.kid);
  if (!kid) return { ok: false, error: "id_token_kid_missing" };
  const jwks = await fetchAzureJwks();
  const jwk = jwks.find((k) => String(k.kid) === kid) || null;
  if (!jwk) return { ok: false, error: "id_token_kid_unknown" };
  let key;
  try {
    key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return { ok: false, error: "id_token_key_invalid" };
  }
  const okSig = crypto.verify("RSA-SHA256", Buffer.from(decoded.signingInput), key, decoded.signature);
  if (!okSig) return { ok: false, error: "id_token_sig_invalid" };
  const claimsOk = verifyJwtClaims({
    payload: decoded.payload,
    expectedAud: oidcAzureClientId,
    expectedIss: oidcAzureExpectedIssuer(),
    expectedNonce,
  });
  if (!claimsOk.ok) return claimsOk;
  return { ok: true, claims: decoded.payload };
}

async function exchangeAzureAuthorizationCode({ code, codeVerifier }) {
  const body = {
    client_id: oidcAzureClientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: oidcAzureRedirectUri(),
    code_verifier: codeVerifier,
  };
  if (oidcAzureClientSecret) body.client_secret = oidcAzureClientSecret;
  const res = await fetch(oidcAzureTokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: encodeFormUrl(body),
  });
  const text = await res.text();
  let jsonBody = null;
  try {
    jsonBody = JSON.parse(text);
  } catch {}
  if (!res.ok) return { ok: false, error: "oidc_token_exchange_failed", details: jsonBody || { raw: text } };
  return { ok: true, token: jsonBody };
}

async function ensureUserForAzureOidc({ subject, tenantId, username, displayName, email }) {
  if (!pool) return { ok: false, error: "db_required" };
  const sub = normalizeString(subject);
  const tid = normalizeString(tenantId);
  const u = normalizeString(username);
  if (!sub || !tid) return { ok: false, error: "oidc_subject_missing" };
  if (!u) return { ok: false, error: "oidc_username_missing" };
  const provider = "azure_oidc";
  const bySub = await pool
    .query(
      `
      select id, username, disabled
      from auth_user
      where identity_provider = $1 and identity_subject = $2
      limit 1;
      `,
      [provider, `${tid}:${sub}`],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (bySub) {
    if (bySub.disabled) return { ok: false, error: "user_disabled" };
    await pool
      .query(
        `
        update auth_user
        set display_name = coalesce($2, display_name),
            email = coalesce($3, email),
            last_login_at = now(),
            updated_at = now()
        where id = $1;
        `,
        [bySub.id, displayName || null, email || null],
      )
      .catch(() => {});
    return { ok: true, userId: bySub.id, username: bySub.username };
  }

  const existingByUsername = await pool
    .query(`select id, identity_provider, identity_subject, disabled from auth_user where username = $1 limit 1;`, [u])
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (existingByUsername) {
    if (existingByUsername.disabled) return { ok: false, error: "user_disabled" };
    if (existingByUsername.identity_provider && existingByUsername.identity_subject) return { ok: false, error: "identity_conflict" };
    await pool.query(
      `
      update auth_user
      set identity_provider = $2,
          identity_subject = $3,
          display_name = coalesce($4, display_name),
          email = coalesce($5, email),
          last_login_at = now(),
          updated_at = now()
      where id = $1;
      `,
      [existingByUsername.id, provider, `${tid}:${sub}`, displayName || null, email || null],
    );
    return { ok: true, userId: existingByUsername.id, username: u };
  }

  const id = `usr_${crypto.randomUUID().slice(0, 18)}`;
  await pool.query(
    `
    insert into auth_user
      (id, username, display_name, password_alg, password_salt, password_hash, password_params, disabled, identity_provider, identity_subject, email, last_login_at, created_at, updated_at)
    values
      ($1,$2,$3,'oidc','', '', '{}'::jsonb, false, $4, $5, $6, now(), now(), now());
    `,
    [id, u, displayName || null, provider, `${tid}:${sub}`, email || null],
  );
  return { ok: true, userId: id, username: u };
}

async function resolveAuthUserId(auth) {
  if (auth && typeof auth.userId === "string" && auth.userId) return auth.userId;
  const u = auth && typeof auth.username === "string" ? normalizeString(auth.username) : null;
  if (!u || !pool) return null;
  const row = await pool.query(`select id from auth_user where username = $1 limit 1;`, [u]).then((r) => r.rows[0] || null).catch(() => null);
  return row && row.id ? String(row.id) : null;
}

function canAccessTrainingUser({ auth, targetUserId, allowSelf = true }) {
  const tid = normalizeString(targetUserId);
  if (!tid) return { ok: false, reason: "userId_required" };
  const self = allowSelf && auth && auth.userId && String(auth.userId) === tid;
  if (self && auth.permissions.has(Permissions.TrainingSelfView)) return { ok: true, self: true };
  if (auth.permissions.has(Permissions.TrainingEmployeeView) || auth.permissions.has(Permissions.TrainingEmployeeAdmin) || auth.permissions.has(Permissions.TrainingCatalogAdmin)) {
    return { ok: true, self: false };
  }
  if (auth.permissions.has(Permissions.TrainingCredentialView) || auth.permissions.has(Permissions.TrainingPlanView) || auth.permissions.has(Permissions.TrainingPlanManage)) {
    return { ok: true, self: false };
  }
  return { ok: false, reason: "forbidden" };
}

async function isSensitiveQualification(qualificationId) {
  if (!pool) return false;
  const row = await pool
    .query(`select sensitive from training_qualification where id = $1 limit 1;`, [qualificationId])
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  return row ? row.sensitive === true : false;
}

async function syncRolesForUser({ userId, roleNames }) {
  if (!pool) return { ok: false, error: "db_required" };
  const names = Array.from(new Set((Array.isArray(roleNames) ? roleNames : []).map((x) => normalizeString(x)).filter(Boolean)));
  const client = await pool.connect();
  try {
    await client.query("begin;");
    const roleIds = [];
    for (const name of names) {
      const existing = await client.query(`select id from auth_role where name = $1 limit 1;`, [name]).then((r) => r.rows[0] || null);
      if (existing) roleIds.push(existing.id);
      else {
        const id = `role_${crypto.randomUUID().slice(0, 18)}`;
        await client.query(`insert into auth_role (id, name) values ($1,$2);`, [id, name]);
        roleIds.push(id);
      }
    }
    await client.query(`delete from auth_user_role where user_id = $1;`, [userId]);
    for (const rid of roleIds) {
      await client.query(`insert into auth_user_role (user_id, role_id) values ($1,$2) on conflict do nothing;`, [userId, rid]);
    }
    await client.query("commit;");
    return { ok: true };
  } catch (e) {
    try {
      await client.query("rollback;");
    } catch {}
    return { ok: false, error: "role_sync_failed" };
  } finally {
    client.release();
  }
}

async function mapAzureGroupsToRoles({ groupIds }) {
  const roles = new Set();
  const gids = Array.isArray(groupIds) ? groupIds.map((g) => normalizeString(g)).filter(Boolean) : [];
  for (const gid of gids) {
    const mapped = oidcAzureGroupRoleMap[gid] || [];
    for (const r of mapped) roles.add(r);
  }
  const defaults = (oidcAzureDefaultRolesEnv || "")
    .split(",")
    .map((s) => normalizeString(s))
    .filter(Boolean);
  for (const r of defaults) roles.add(r);
  return Array.from(roles);
}

async function fetchAzureGroupsViaGraph({ accessToken }) {
  const res = await fetch("https://graph.microsoft.com/v1.0/me/transitiveMemberOf?$select=id", {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { ok: false, error: "graph_groups_fetch_failed" };
  const data = await res.json().catch(() => null);
  const ids = Array.isArray(data && data.value) ? data.value.map((x) => normalizeString(x && x.id)).filter(Boolean) : [];
  return { ok: true, groupIds: ids };
}

async function scryptHashPassword(password) {
  const salt = crypto.randomBytes(16);
  const envN = process.env.ERP_SCRYPT_N ? Number(process.env.ERP_SCRYPT_N) : null;
  const envR = process.env.ERP_SCRYPT_R ? Number(process.env.ERP_SCRYPT_R) : null;
  const envP = process.env.ERP_SCRYPT_P ? Number(process.env.ERP_SCRYPT_P) : null;
  const N = Number.isFinite(envN) ? Math.max(1 << 12, Math.min(1 << 16, Math.trunc(envN))) : 1 << 14;
  const r = Number.isFinite(envR) ? Math.max(1, Math.min(16, Math.trunc(envR))) : 8;
  const p = Number.isFinite(envP) ? Math.max(1, Math.min(4, Math.trunc(envP))) : 1;
  const keyLen = 64;
  const maxmemEnv = process.env.ERP_SCRYPT_MAXMEM ? Number(process.env.ERP_SCRYPT_MAXMEM) : null;
  const maxmem = Number.isFinite(maxmemEnv) ? Math.max(32 * 1024 * 1024, Math.min(1024 * 1024 * 1024, Math.trunc(maxmemEnv))) : 128 * 1024 * 1024;
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keyLen, { N, r, p, maxmem }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
  return {
    alg: "scrypt",
    salt: salt.toString("base64"),
    hash: Buffer.from(hash).toString("base64"),
    params: { N, r, p, keyLen, maxmem },
  };
}

async function scryptVerifyPassword(password, record) {
  if (!record || record.passwordAlg !== "scrypt") return false;
  const salt = Buffer.from(String(record.passwordSalt || ""), "base64");
  const keyLen = Number(record.passwordParams?.keyLen || 64);
  const Nraw = Number(record.passwordParams?.N || (1 << 14));
  const rRaw = Number(record.passwordParams?.r || 8);
  const pRaw = Number(record.passwordParams?.p || 1);
  const maxmemRaw = Number(record.passwordParams?.maxmem || (128 * 1024 * 1024));
  const N = Number.isFinite(Nraw) ? Math.max(1 << 12, Math.min(1 << 16, Math.trunc(Nraw))) : 1 << 14;
  const r = Number.isFinite(rRaw) ? Math.max(1, Math.min(16, Math.trunc(rRaw))) : 8;
  const p = Number.isFinite(pRaw) ? Math.max(1, Math.min(4, Math.trunc(pRaw))) : 1;
  const maxmem = Number.isFinite(maxmemRaw) ? Math.max(32 * 1024 * 1024, Math.min(1024 * 1024 * 1024, Math.trunc(maxmemRaw))) : 128 * 1024 * 1024;
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keyLen, { N, r, p, maxmem }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
  const expected = Buffer.from(String(record.passwordHash || ""), "base64");
  const actual = Buffer.from(derived);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

async function getUserByUsername(username) {
  if (!pool) return null;
  const u = normalizeString(username);
  if (!u) return null;
  const row = await pool
    .query(
      `
      select id, username, display_name, password_alg, password_salt, password_hash, password_params, disabled
      from auth_user
      where username = $1
      limit 1;
      `,
      [u],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || null,
    passwordAlg: row.password_alg,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    passwordParams: row.password_params || {},
    disabled: row.disabled === true,
  };
}

async function listPermissionsForUser(userId) {
  if (!pool) return [];
  const rows = await pool
    .query(
      `
      select distinct rp.permission_name
      from auth_user_role ur
      join auth_role_permission rp on rp.role_id = ur.role_id
      where ur.user_id = $1;
      `,
      [userId],
    )
    .then((r) => r.rows)
    .catch(() => []);
  return rows.map((r) => String(r.permission_name)).filter(Boolean);
}

async function ensurePermissionExists(name) {
  if (!pool) return;
  const n = normalizeString(name);
  if (!n) return;
  await pool.query(`insert into auth_permission (name) values ($1) on conflict (name) do nothing;`, [n]).catch(() => {});
}

async function getRoleByName(name) {
  if (!pool) return null;
  const n = normalizeString(name);
  if (!n) return null;
  return pool
    .query(`select id, name from auth_role where name = $1 limit 1;`, [n])
    .then((r) => r.rows[0] || null)
    .catch(() => null);
}

async function listRoles() {
  if (!pool) return [];
  const rows = await pool.query(`select id, name, created_at from auth_role order by name asc;`).then((r) => r.rows).catch(() => []);
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: new Date(r.created_at).toISOString() }));
}

async function listUsers() {
  if (!pool) return [];
  const rows = await pool
    .query(`select id, username, display_name, disabled, created_at, updated_at from auth_user order by username asc limit 500;`)
    .then((r) => r.rows)
    .catch(() => []);
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name || null,
    disabled: r.disabled === true,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

async function createUser({ username, displayName, password }) {
  if (!pool) return { ok: false, error: "db_required" };
  const u = normalizeString(username);
  if (!u) return { ok: false, error: "username_required" };
  if (u.length < 3 || u.length > 64) return { ok: false, error: "username_invalid" };
  const pw = String(password || "");
  if (pw.length < 12) return { ok: false, error: "password_too_short" };
  const hashed = await scryptHashPassword(pw);
  const id = `usr_${crypto.randomUUID().slice(0, 18)}`;
  const dn = normalizeString(displayName) || null;
  try {
    await pool.query(
      `
      insert into auth_user (id, username, display_name, password_alg, password_salt, password_hash, password_params, disabled, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,false, now(), now());
      `,
      [id, u, dn, hashed.alg, hashed.salt, hashed.hash, hashed.params],
    );
  } catch {
    return { ok: false, error: "username_exists" };
  }
  return { ok: true, item: { id, username: u, displayName: dn } };
}

async function createRole({ name }) {
  if (!pool) return { ok: false, error: "db_required" };
  const n = normalizeString(name);
  if (!n) return { ok: false, error: "role_required" };
  if (n.length < 2 || n.length > 64) return { ok: false, error: "role_invalid" };
  const id = `role_${crypto.randomUUID().slice(0, 18)}`;
  try {
    await pool.query(`insert into auth_role (id, name) values ($1,$2);`, [id, n]);
  } catch {
    return { ok: false, error: "role_exists" };
  }
  return { ok: true, item: { id, name: n } };
}

async function grantPermissionToRole({ roleName, permission }) {
  if (!pool) return { ok: false, error: "db_required" };
  const role = await getRoleByName(roleName);
  if (!role) return { ok: false, error: "role_not_found" };
  const perm = normalizeString(permission);
  if (!perm) return { ok: false, error: "permission_required" };
  await ensurePermissionExists(perm);
  await pool.query(`insert into auth_role_permission (role_id, permission_name) values ($1,$2) on conflict do nothing;`, [role.id, perm]);
  return { ok: true };
}

async function assignRoleToUser({ username, roleName }) {
  if (!pool) return { ok: false, error: "db_required" };
  const user = await getUserByUsername(username);
  if (!user) return { ok: false, error: "user_not_found" };
  const role = await getRoleByName(roleName);
  if (!role) return { ok: false, error: "role_not_found" };
  await pool.query(`insert into auth_user_role (user_id, role_id) values ($1,$2) on conflict do nothing;`, [user.id, role.id]);
  return { ok: true };
}

async function ensureBootstrapAdmin() {
  if (!pool) return;
  const u = normalizeString(process.env.ERP_BOOTSTRAP_ADMIN_USERNAME);
  const pw = String(process.env.ERP_BOOTSTRAP_ADMIN_PASSWORD || "");
  if (!u || !pw) return;
  const count = await pool.query(`select count(*)::int as n from auth_user;`).then((r) => r.rows[0]?.n || 0).catch(() => 0);
  if (count > 0) return;
  const roleName = "admin";
  await createRole({ name: roleName }).catch(() => {});
  await createUser({ username: u, displayName: "Admin", password: pw });
  await assignRoleToUser({ username: u, roleName });
  const perms = Object.values(Permissions);
  for (const p of perms) await grantPermissionToRole({ roleName, permission: p });
}

async function createSession({ userId, ip, userAgent }) {
  if (!pool) return null;
  const refreshToken = base64UrlEncode(crypto.randomBytes(32));
  const csrfToken = base64UrlEncode(crypto.randomBytes(32));
  const sessionId = `ses_${crypto.randomUUID().slice(0, 18)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(3600, Math.floor(refreshTokenTtlSeconds)) * 1000);
  await pool.query(
    `
    insert into auth_session
      (id, user_id, refresh_token_sha256, csrf_token_sha256, created_at, last_seen_at, expires_at, rotated_at, revoked_at, replaced_by, ip, user_agent)
    values
      ($1,$2,$3,$4, now(), now(), $5, null, null, null, $6, $7);
    `,
    [sessionId, userId, sha256Hex(refreshToken), sha256Hex(csrfToken), expiresAt.toISOString(), ip || null, userAgent || null],
  );
  return { sessionId, refreshToken, csrfToken, expiresAt: expiresAt.toISOString() };
}

async function rotateSession({ refreshToken, csrfToken, ip, userAgent }) {
  if (!pool) return { ok: false, error: "db_required" };
  const refresh = normalizeString(refreshToken);
  const csrf = normalizeString(csrfToken);
  if (!refresh) return { ok: false, error: "refresh_required" };
  if (!csrf) return { ok: false, error: "csrf_required" };
  const refreshHash = sha256Hex(refresh);
  const csrfHash = sha256Hex(csrf);
  const row = await pool
    .query(
      `
      select id, user_id, csrf_token_sha256, expires_at, rotated_at, revoked_at
      from auth_session
      where refresh_token_sha256 = $1
      limit 1;
      `,
      [refreshHash],
    )
    .then((r) => r.rows[0] || null);
  if (!row) return { ok: false, error: "refresh_invalid" };
  if (row.revoked_at) return { ok: false, error: "refresh_revoked" };
  if (row.rotated_at) {
    await pool.query(`update auth_session set revoked_at = now() where user_id = $1 and revoked_at is null;`, [row.user_id]).catch(() => {});
    return { ok: false, error: "refresh_reuse_detected" };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, error: "refresh_expired" };
  if (String(row.csrf_token_sha256) !== csrfHash) return { ok: false, error: "csrf_invalid" };

  const next = await createSession({ userId: row.user_id, ip, userAgent });
  await pool.query(`update auth_session set rotated_at = now(), replaced_by = $2, last_seen_at = now() where id = $1;`, [row.id, next.sessionId]);
  return { ok: true, userId: row.user_id, session: next };
}

function requireCsrf(res, req) {
  const cookies = parseCookies(req.headers.cookie);
  const cookie = normalizeString(cookies.erp_csrf);
  const header = normalizeString(req.headers["x-csrf-token"]);
  if (!cookie || !header || cookie !== header) {
    forbidden(res);
    return false;
  }
  return true;
}

const metrics = {
  startedAt: new Date().toISOString(),
  httpRequestsTotal: new Map(),
  httpRequestMsCount: new Map(),
  httpRequestMsSum: new Map(),
};

function metricsKey(method, path, status) {
  return `${method} ${path} ${status}`;
}

function observeHttpRequest({ method, path, status, ms }) {
  const key = metricsKey(method, path, status);
  metrics.httpRequestsTotal.set(key, (metrics.httpRequestsTotal.get(key) || 0) + 1);
  metrics.httpRequestMsCount.set(key, (metrics.httpRequestMsCount.get(key) || 0) + 1);
  metrics.httpRequestMsSum.set(key, (metrics.httpRequestMsSum.get(key) || 0) + ms);
}

function logJson(obj) {
  try {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  } catch {}
}

async function createJob({ type, requestedBy, params }) {
  if (!pool) return { ok: false, error: "db_required" };
  const t = normalizeString(type);
  if (!t) return { ok: false, error: "type_required" };
  const id = `job_${crypto.randomUUID().slice(0, 18)}`;
  await pool.query(
    `
    insert into job (id, type, status, requested_by, params, progress, total, error, created_at)
    values ($1,$2,'queued',$3,$4,0,100,null, now());
    `,
    [id, t, requestedBy, params && typeof params === "object" ? params : {}],
  );
  return { ok: true, id };
}

async function appendJobLog({ jobId, level, message, meta }) {
  if (!pool) return;
  const id = `jlog_${crypto.randomUUID().slice(0, 18)}`;
  const lvl = ["info", "warning", "error"].includes(level) ? level : "info";
  await pool
    .query(
      `
      insert into job_log (id, job_id, level, message, meta, created_at)
      values ($1,$2,$3,$4,$5, now());
      `,
      [id, jobId, lvl, String(message || ""), meta && typeof meta === "object" ? meta : {}],
    )
    .catch(() => {});
}

async function setJobProgress({ jobId, progress, total }) {
  if (!pool) return;
  const p = Math.max(0, Math.min(100, Number(progress)));
  const t = total === undefined || total === null ? null : Math.max(1, Number(total));
  await pool
    .query(
      `
      update job
      set progress = $2, total = coalesce($3, total)
      where id = $1;
      `,
      [jobId, Math.floor(p), t],
    )
    .catch(() => {});
  publishEvent("jobs", "job_progress", { jobId, progress: Math.floor(p), total: t || 100 });
}

async function finishJob({ jobId, status, error }) {
  if (!pool) return;
  const st = ["succeeded", "failed", "cancelled"].includes(status) ? status : "failed";
  await pool
    .query(
      `
      update job
      set status = $2, finished_at = now(), error = $3, progress = case when $2 = 'succeeded' then 100 else progress end
      where id = $1;
      `,
      [jobId, st, error ? String(error).slice(0, 2000) : null],
    )
    .catch(() => {});
  publishEvent("jobs", "job_finished", { jobId, status: st });
}

async function claimNextJob({ workerId }) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query("begin;");
    const row = await client
      .query(
        `
        with picked as (
          select id
          from job
          where status = 'queued'
          order by created_at asc
          limit 1
          for update skip locked
        )
        update job j
        set status = 'running', started_at = coalesce(started_at, now()), locked_at = now(), locked_by = $1
        from picked
        where j.id = picked.id
        returning j.id, j.type, j.requested_by, j.params;
        `,
        [workerId],
      )
      .then((r) => r.rows[0] || null);
    await client.query("commit;");
    return row;
  } catch (e) {
    try {
      await client.query("rollback;");
    } catch {}
    return null;
  } finally {
    client.release();
  }
}

async function runJob({ job }) {
  const jobId = job.id;
  const type = String(job.type || "");
  await appendJobLog({ jobId, level: "info", message: "job_started", meta: { type } });
  await setJobProgress({ jobId, progress: 1 });
  try {
    if (type === "import_db_export") {
      await setJobProgress({ jobId, progress: 5 });
      const dryRun = job.params && job.params.dryRun === true;
      const r = await importDbExportFile({ requestedBy: job.requested_by, dryRun });
      if (!r.ok) throw new Error(r.error || "import_failed");
      await setJobProgress({ jobId, progress: 95 });
      await appendJobLog({ jobId, level: "info", message: "import_finished", meta: { runId: r.runId, dryRun } });
      await finishJob({ jobId, status: "succeeded", error: null });
      return;
    }
    throw new Error("unknown_job_type");
  } catch (e) {
    await appendJobLog({ jobId, level: "error", message: "job_failed", meta: { error: String(e && e.message ? e.message : e) } });
    await finishJob({ jobId, status: "failed", error: String(e && e.message ? e.message : e) });
  }
}

function requirePermission(res, auth, permission) {
  if (!auth.username) return unauthorized(res);
  if (!auth.permissions.has(permission)) return forbidden(res);
  return true;
}

function requireAnyPermission(res, auth, permissions) {
  if (!auth.username) return unauthorized(res);
  const list = Array.isArray(permissions) ? permissions : [];
  for (const p of list) {
    if (auth.permissions.has(p)) return true;
  }
  return forbidden(res);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function badRequest(res, message) {
  json(res, 400, { error: "bad_request", message });
}

function methodNotAllowed(res) {
  json(res, 405, { error: "method_not_allowed" });
}

function normalizeString(s) {
  return typeof s === "string" ? s.trim() : "";
}

function parseIsoDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return null;
  return d;
}

function parsePriority(value) {
  const v = normalizeString(value).toLowerCase();
  if (v === "low" || v === "niedrig") return "low";
  if (v === "high" || v === "hoch") return "high";
  if (v === "medium" || v === "mittel") return "medium";
  return null;
}

function normalizeReporterRole(value) {
  const v = normalizeString(value).toLowerCase();
  if (v === "driver" || v === "fahrer") return "driver";
  if (v === "workshop" || v === "werkstatt") return "workshop";
  return null;
}

function parseOptionalBase64Photo(value, { maxBytes = 2_000_000 } = {}) {
  if (!value || typeof value !== "object") return { ok: true, photo: null };
  const rawMimeType = normalizeString(value.mimeType);
  let base64 = normalizeString(value.base64);
  if (!rawMimeType || !base64) return { ok: false, error: "invalid_photo" };

  if (base64.startsWith("data:")) {
    const comma = base64.indexOf(",");
    if (comma !== -1) base64 = base64.slice(comma + 1).trim();
  }

  const mimeType = rawMimeType.toLowerCase();
  const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!allowed.has(mimeType)) return { ok: false, error: "photo_mimeType_not_allowed" };

  let buf;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    return { ok: false, error: "photo_base64_invalid" };
  }
  if (!buf || buf.length === 0) return { ok: false, error: "photo_base64_invalid" };
  if (buf.length > maxBytes) return { ok: false, error: "photo_too_large" };
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  return { ok: true, photo: { mimeType, base64, sizeBytes: buf.length, sha256 } };
}

function parseOptionalBase64Pdf(value, { maxBytes = 4_000_000 } = {}) {
  if (!value || typeof value !== "object") return { ok: true, pdf: null };
  const rawMimeType = normalizeString(value.mimeType);
  let base64 = normalizeString(value.base64);
  if (!rawMimeType || !base64) return { ok: false, error: "invalid_pdf" };

  if (base64.startsWith("data:")) {
    const comma = base64.indexOf(",");
    if (comma !== -1) base64 = base64.slice(comma + 1).trim();
  }

  const mimeType = rawMimeType.toLowerCase();
  if (mimeType !== "application/pdf") return { ok: false, error: "pdf_mimeType_not_allowed" };

  let buf;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    return { ok: false, error: "pdf_base64_invalid" };
  }
  if (!buf || buf.length === 0) return { ok: false, error: "pdf_base64_invalid" };
  if (buf.length > maxBytes) return { ok: false, error: "pdf_too_large" };
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  return { ok: true, pdf: { mimeType, base64, sizeBytes: buf.length, sha256 } };
}

function normalizeIdentifiers(input) {
  if (input === null || input === undefined) return { ok: true, identifiers: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "identifiers_invalid_type" };

  const normalizeToken = (v) => {
    const s = normalizeString(v);
    if (!s) return "";
    return s
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .toUpperCase();
  };

  const batchNo = normalizeToken(input.batchNo || input.batch || input.charge || input.lot || input.lotNo);
  const serialOne = normalizeToken(input.serialNumber || input.serial || input.sn);
  const serialArrRaw = Array.isArray(input.serialNumbers) ? input.serialNumbers : Array.isArray(input.serials) ? input.serials : null;
  const serials = [];
  if (serialOne) serials.push(serialOne);
  if (serialArrRaw) {
    for (const s of serialArrRaw) {
      const v = normalizeToken(String(s));
      if (v) serials.push(v);
    }
  }
  const cleaned = Array.from(new Set(serials.map((s) => s.trim()))).filter(Boolean);
  if (cleaned.length > 50) return { ok: false, error: "identifiers_too_many_serials" };
  for (const s of cleaned) {
    if (s.length > 64) return { ok: false, error: "identifiers_serial_too_long" };
  }
  if (batchNo && batchNo.length > 64) return { ok: false, error: "identifiers_batch_too_long" };

  const out = {};
  if (batchNo) out.batchNo = batchNo;
  if (cleaned.length) out.serialNumbers = cleaned;
  return { ok: true, identifiers: out };
}

function parseSignature(value) {
  if (!value || typeof value !== "object") return { ok: false, error: "signature_required" };
  const type = normalizeString(value.type).toLowerCase();
  if (type === "typed") {
    const name = normalizeString(value.name);
    if (!name) return { ok: false, error: "signature_name_required" };
    if (name.length > 120) return { ok: false, error: "signature_name_too_long" };
    const sha256 = crypto.createHash("sha256").update(name).digest("hex");
    return { ok: true, signature: { type: "typed", name, sha256 } };
  }
  if (type === "drawn") {
    const img = parseOptionalBase64Photo({ mimeType: value.mimeType, base64: value.base64 }, { maxBytes: 600_000 });
    if (!img.ok) return { ok: false, error: img.error };
    if (!img.photo) return { ok: false, error: "signature_image_required" };
    if (img.photo.mimeType !== "image/png") return { ok: false, error: "signature_mimeType_not_allowed" };
    return { ok: true, signature: { type: "drawn", mimeType: img.photo.mimeType, base64: img.photo.base64, sha256: img.photo.sha256, sizeBytes: img.photo.sizeBytes } };
  }
  return { ok: false, error: "signature_invalid_type" };
}

const sseState = {
  nextId: 1,
  buffer: [],
  clients: new Set(),
};

function normalizeErpEventType(value) {
  return normalizeString(value)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function normalizeAggregateType(value) {
  return normalizeString(value)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function deriveAggregateIdFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const keys = ["id", "eventId", "orderId", "routeId", "jobId", "caseId", "sessionId", "credentialId", "inspectionId", "movementId", "ownerId", "requestId", "blockId", "vehicleId", "unitId"];
  for (const key of keys) {
    const v = normalizeString(payload[key]);
    if (v) return v;
  }
  return null;
}

function buildErpEventEnvelope({
  eventType,
  aggregateType,
  aggregateId,
  sourceModule,
  occurredAt = null,
  createdBy = null,
  correlationId = null,
  causationId = null,
  traceId = null,
  partitionKey = null,
  schemaVersion = 1,
  headers = {},
  payload = {},
} = {}) {
  const et = normalizeErpEventType(eventType);
  const at = normalizeAggregateType(aggregateType);
  const aid = normalizeString(aggregateId);
  const sm = normalizeAggregateType(sourceModule || aggregateType);
  const ts = occurredAt ? new Date(occurredAt) : new Date();
  if (!et || !at || !aid || !sm || Number.isNaN(ts.valueOf())) return null;
  return {
    id: `evt_${crypto.randomUUID().slice(0, 18)}`,
    schemaVersion: Math.max(1, Math.min(99, Math.trunc(Number(schemaVersion) || 1))),
    eventType: et,
    aggregateType: at,
    aggregateId: aid,
    sourceModule: sm,
    occurredAt: ts.toISOString(),
    createdBy: normalizeString(createdBy) || "system",
    correlationId: normalizeString(correlationId) || null,
    causationId: normalizeString(causationId) || null,
    traceId: normalizeString(traceId) || null,
    partitionKey: normalizeString(partitionKey) || aid,
    headers: headers && typeof headers === "object" ? headers : {},
    payload: payload && typeof payload === "object" ? payload : {},
  };
}

function publishEvent(topic, type, data, options = {}) {
  const id = String(sseState.nextId++);
  const event = { id, topic, type, data, at: new Date().toISOString() };
  sseState.buffer.push(event);
  if (sseState.buffer.length > 1000) sseState.buffer.splice(0, sseState.buffer.length - 1000);
  const line = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const c of sseState.clients) {
    if (!c.topics.has(topic) && !c.topics.has("*")) continue;
    try {
      c.res.write(line);
    } catch {}
  }
  if (options && options.persist === false) return;
  const aggregateId = normalizeString(options.aggregateId) || deriveAggregateIdFromPayload(data);
  const aggregateType = normalizeString(options.aggregateType) || normalizeAggregateType(topic);
  if (!aggregateId || !aggregateType) return;
  Promise.resolve()
    .then(() =>
      publishErpEvent({
        eventType: options.eventType || type,
        aggregateType,
        aggregateId,
        sourceModule: options.sourceModule || topic,
        occurredAt: event.at,
        createdBy: options.createdBy || "system",
        correlationId: options.correlationId || null,
        causationId: options.causationId || null,
        traceId: options.traceId || null,
        partitionKey: options.partitionKey || aggregateId,
        headers: { uiTopic: topic, uiType: type },
        payload: data && typeof data === "object" ? data : { value: data ?? null },
      }),
    )
    .catch(() => {});
}

function analyzeDbExportCsvText(csvText) {
  const text = String(csvText || "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { ok: false, error: "empty_csv" };
  const header = lines[0].split(";").map((s) => s.trim().toLowerCase());
  if (header.length < 4) return { ok: false, error: "invalid_header" };
  const expect = ["tabelle", "pk", "spalte", "wert"];
  const headerOk = expect.every((x, i) => header[i] === x);
  if (!headerOk) return { ok: false, error: "unexpected_header", details: { header, expected: expect } };

  const tables = new Map();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    if (parts.length < 4) continue;
    const table = (parts[0] || "").trim();
    const pk = (parts[1] || "").trim();
    const col = (parts[2] || "").trim();
    const val = (parts.slice(3).join(";") || "").trim();
    if (!table || !pk || !col) continue;
    if (!tables.has(table)) {
      tables.set(table, { table, rows: 0, pks: new Set(), cols: new Map(), emptyValues: 0 });
    }
    const t = tables.get(table);
    t.rows++;
    t.pks.add(pk);
    t.cols.set(col, (t.cols.get(col) || 0) + 1);
    if (!val) t.emptyValues++;
  }

  const tableList = Array.from(tables.values())
    .map((t) => ({
      table: t.table,
      rows: t.rows,
      uniquePk: t.pks.size,
      emptyValues: t.emptyValues,
      topColumns: Array.from(t.cols.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => ({ name, count })),
    }))
    .sort((a, b) => b.rows - a.rows);

  return { ok: true, summary: { totalLines: lines.length - 1, tables: tableList.length }, tables: tableList };
}

function parseDbExportCsvTextToCells(csvText) {
  const text = String(csvText || "");
  const lines = text.split(/\r?\n/);
  const out = [];
  if (!lines.length) return { ok: false, error: "empty_csv" };
  const header = (lines[0] || "").split(";").map((s) => s.trim().toLowerCase());
  const expect = ["tabelle", "pk", "spalte", "wert"];
  const headerOk = expect.every((x, i) => header[i] === x);
  if (!headerOk) return { ok: false, error: "unexpected_header", details: { header, expected: expect } };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const parts = line.split(";");
    if (parts.length < 4) continue;
    const tableName = normalizeString(parts[0]);
    const pk = normalizeString(parts[1]);
    const columnName = normalizeString(parts[2]);
    const value = normalizeString(parts.slice(3).join(";")) || "";
    if (!tableName || !pk || !columnName) continue;
    out.push({ tableName, pk, columnName, value, lineNo: i + 1 });
  }
  return { ok: true, cells: out };
}

function normalizeDbColumnName(value) {
  const v = normalizeString(value).toLowerCase();
  if (!v) return "";
  return v
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .replaceAll(" ", "_");
}

function pivotDbExportCells(cells) {
  const rows = new Map();
  const issues = [];
  for (const c of cells) {
    const tableName = normalizeDbColumnName(c.tableName);
    const pk = String(c.pk);
    const columnName = normalizeDbColumnName(c.columnName);
    const key = `${tableName}:${pk}`;
    if (!rows.has(key)) rows.set(key, { tableName, pk, columns: {} });
    const r = rows.get(key);
    if (Object.prototype.hasOwnProperty.call(r.columns, columnName)) {
      const prev = r.columns[columnName];
      if (prev !== c.value) {
        issues.push({
          severity: "error",
          tableName,
          pk,
          columnName,
          message: "duplicate_column_conflict",
          details: { previous: prev, next: c.value, lineNo: c.lineNo },
        });
      }
    } else {
      r.columns[columnName] = c.value;
    }
  }
  return { rows: Array.from(rows.values()), issues };
}

async function pivotDbExportFileToRows({ sourcePath }) {
  const stream = fs.createReadStream(sourcePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const rows = new Map();
  const issues = [];
  let cells = 0;
  let lineNo = 0;
  let headerChecked = false;
  try {
    for await (const raw of rl) {
      lineNo++;
      const line = String(raw || "");
      if (!headerChecked) {
        headerChecked = true;
        const header = line.split(";").map((s) => s.trim().toLowerCase());
        const expect = ["tabelle", "pk", "spalte", "wert"];
        const headerOk = expect.every((x, i) => header[i] === x);
        if (!headerOk) return { ok: false, error: "unexpected_header", details: { header, expected: expect } };
        continue;
      }
      if (!line.trim()) continue;
      const parts = line.split(";");
      if (parts.length < 4) continue;
      const tableNameRaw = normalizeString(parts[0]);
      const pkRaw = normalizeString(parts[1]);
      const columnNameRaw = normalizeString(parts[2]);
      const valueRaw = normalizeString(parts.slice(3).join(";")) || "";
      if (!tableNameRaw || !pkRaw || !columnNameRaw) continue;

      cells++;
      const tableName = normalizeDbColumnName(tableNameRaw);
      const pk = String(pkRaw);
      const columnName = normalizeDbColumnName(columnNameRaw);
      const key = `${tableName}:${pk}`;
      if (!rows.has(key)) rows.set(key, { tableName, pk, columns: {} });
      const r = rows.get(key);
      if (Object.prototype.hasOwnProperty.call(r.columns, columnName)) {
        const prev = r.columns[columnName];
        if (prev !== valueRaw) {
          issues.push({
            severity: "error",
            tableName,
            pk,
            columnName,
            message: "duplicate_column_conflict",
            details: { previous: prev, next: valueRaw, lineNo },
          });
        }
      } else {
        r.columns[columnName] = valueRaw;
      }
    }
  } catch (e) {
    return { ok: false, error: "csv_stream_failed", details: { message: String(e && e.message ? e.message : e) } };
  } finally {
    try {
      rl.close();
    } catch {}
    try {
      stream.destroy();
    } catch {}
  }

  if (!headerChecked) return { ok: false, error: "empty_csv" };
  return { ok: true, cells, rows: Array.from(rows.values()), issues };
}

function parseDateLoose(value) {
  const v = normalizeString(value);
  if (!v) return null;
  const iso = parseIsoDate(v);
  if (iso) return iso;
  const m1 = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m1) {
    const dt = new Date(`${m1[1]}-${m1[2]}-${m1[3]}T00:00:00Z`);
    if (!Number.isNaN(dt.valueOf())) return dt;
  }
  const m2 = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m2) {
    const dt = new Date(`${m2[3]}-${m2[2]}-${m2[1]}T00:00:00Z`);
    if (!Number.isNaN(dt.valueOf())) return dt;
  }
  const m3 = v.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m3) {
    const sec = m3[6] ? m3[6] : "00";
    const dt = new Date(`${m3[3]}-${m3[2]}-${m3[1]}T${m3[4]}:${m3[5]}:${sec}Z`);
    if (!Number.isNaN(dt.valueOf())) return dt;
  }
  return null;
}

function parseDueMonthLoose(value) {
  const v = normalizeString(value);
  if (!v) return null;
  const a = parseDueMonth(v);
  if (a) return `${String(a.year).padStart(4, "0")}-${String(a.month).padStart(2, "0")}`;
  const m = v.match(/^(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function stableImportId(prefix, tableName, pk) {
  const key = `${prefix}:${String(tableName)}:${String(pk)}`;
  const h = crypto.createHash("sha256").update(key).digest("hex").slice(0, 20);
  return `${prefix}_${h}`;
}

function mapOrderStatusToWorkState(value) {
  const v = normalizeString(value).toLowerCase();
  if (!v) return null;
  if (["angelegt", "created", "neu"].includes(v)) return "created";
  if (["zugeordnet", "assigned"].includes(v)) return "assigned";
  if (["in_bearbeitung", "in bearbeitung", "bearbeitung", "inprogress", "in_progress"].includes(v)) return "in_progress";
  if (["abgeschlossen", "done", "closed", "fertig"].includes(v)) return "done";
  return null;
}

function isTruthy(value) {
  const v = normalizeString(value).toLowerCase();
  return v === "1" || v === "true" || v === "ja" || v === "yes" || v === "x";
}

function inferUnitKindFromTable(tableName) {
  const t = normalizeDbColumnName(tableName);
  if (t.includes("anhaenger") || t.includes("anhaenger")) return "trailer";
  if (t.includes("container")) return "container";
  return "vehicle";
}

function pickFirstColumn(columns, names) {
  for (const n of names) {
    const k = normalizeDbColumnName(n);
    if (Object.prototype.hasOwnProperty.call(columns, k) && normalizeString(columns[k])) return normalizeString(columns[k]);
  }
  return null;
}

function validateAndExtractDbExport({ rows }) {
  const issues = [];
  const units = [];
  const inspections = [];
  const orders = [];
  const employees = new Map();
  const unitBySource = new Map();
  const pendingInspections = [];
  const pendingOrders = [];

  function addIssue(severity, { tableName, pk, columnName = null, entityType = null, entityKey = null, message, details = {} }) {
    issues.push({ severity, tableName, pk, columnName, entityType, entityKey, message, details });
  }

  for (const r of rows) {
    const tableName = r.tableName;
    const pk = r.pk;
    const cols = r.columns;

    for (const [k, v] of Object.entries(cols)) {
      const key = String(k);
      if (!v) continue;
      const looksDate = key.includes("datum") || key.endsWith("_at") || key.includes("zeit") || key.includes("date");
      if (!looksDate) continue;
      if (!parseDateLoose(v) && !parseDueMonthLoose(v)) {
        addIssue("warning", { tableName, pk, columnName: key, message: "unparseable_date_format", details: { value: v } });
      }
    }

    if (tableName === "mitarbeiter") {
      const id = pickFirstColumn(cols, ["id"]) || pk;
      const name = pickFirstColumn(cols, ["name"]);
      if (!name) addIssue("error", { tableName, pk, columnName: "name", entityType: "employee", entityKey: `${tableName}:${pk}`, message: "missing_employee_name" });
      employees.set(String(id), { id: String(id), name: name || `Mitarbeiter ${id}`, raw: cols });
      continue;
    }

    if (tableName === "fahrzeuge" || tableName === "anhaenger" || tableName === "container") {
      const kind = tableName === "anhaenger" ? "trailer" : tableName === "container" ? "container" : "vehicle";
      const code =
        kind === "container"
          ? pickFirstColumn(cols, ["ems_nr", "bezeichnung", "id"])
          : pickFirstColumn(cols, ["kennzeichen", "ems_nr", "id"]);
      let type =
        kind === "container"
          ? pickFirstColumn(cols, ["typ", "bezeichnung"])
          : kind === "trailer"
            ? pickFirstColumn(cols, ["aufbautyp", "modell", "hersteller", "typ"])
            : pickFirstColumn(cols, ["typ", "modell", "hersteller"]);
      if (!type) {
        type = kind === "container" ? "Container" : kind === "trailer" ? "Anhänger" : "Fahrzeug";
        addIssue("warning", { tableName, pk, columnName: "typ", entityType: "unit", entityKey: `${tableName}:${pk}`, message: "missing_unit_type_defaulted", details: { defaultedTo: type } });
      }
      if (!code) addIssue("error", { tableName, pk, columnName: "code", entityType: "unit", entityKey: `${tableName}:${pk}`, message: "missing_unit_code" });

      const unitId = stableImportId("unit", tableName, pk);
      const attributes = { source: { table: tableName, pk }, raw: cols };
      units.push({ unitId, code: code || `UNDEFINED_${tableName}_${pk}`, kind, type, capabilities: [], attributes });
      unitBySource.set(`${tableName}:${pk}`, unitId);
      continue;
    }

    if (tableName === "termine" || tableName === "anhaenger_termine" || tableName === "container_pruefungen") {
      pendingInspections.push(r);
      continue;
    }

    if (tableName === "auftraege") {
      pendingOrders.push(r);
      continue;
    }
  }

  for (const r of pendingInspections) {
    const tableName = r.tableName;
    const pk = r.pk;
    const cols = r.columns;
    const refCol = tableName === "termine" ? "fahrzeug_id" : tableName === "anhaenger_termine" ? "anhaenger_id" : "container_id";
    const refTable = tableName === "termine" ? "fahrzeuge" : tableName === "anhaenger_termine" ? "anhaenger" : "container";
    const refPk = pickFirstColumn(cols, [refCol]);
    const inspectionType = pickFirstColumn(cols, ["art"]);
    const dueAt = parseDateLoose(pickFirstColumn(cols, ["faellig_am"]) || "");
    if (!refPk) addIssue("error", { tableName, pk, columnName: refCol, entityType: "inspection", entityKey: `${tableName}:${pk}`, message: "missing_unit_reference" });
    if (!inspectionType) addIssue("error", { tableName, pk, columnName: "art", entityType: "inspection", entityKey: `${tableName}:${pk}`, message: "missing_inspection_type" });
    if (!dueAt) addIssue("error", { tableName, pk, columnName: "faellig_am", entityType: "inspection", entityKey: `${tableName}:${pk}`, message: "invalid_due_date" });
    const unitId = refPk ? unitBySource.get(`${refTable}:${refPk}`) || null : null;
    if (refPk && !unitId) addIssue("error", { tableName, pk, columnName: refCol, entityType: "inspection", entityKey: `${tableName}:${pk}`, message: "unit_reference_not_found", details: { refTable, refPk } });
    const done = isTruthy(pickFirstColumn(cols, ["erledigt"]) || "");
    const doneAt = parseDateLoose(pickFirstColumn(cols, ["erledigt_am"]) || "");
    const dueMonth = dueAt ? `${dueAt.getUTCFullYear()}-${String(dueAt.getUTCMonth() + 1).padStart(2, "0")}` : null;
    const reportPath = pickFirstColumn(cols, ["pruefbericht_pfad"]);
    const workerId = pickFirstColumn(cols, ["pruefer", "bearbeiter_id"]);
    inspections.push({
      inspectionId: stableImportId("insp", tableName, pk),
      unitId,
      inspectionType: inspectionType || "unknown",
      dueMonth,
      dueFrom: dueAt ? dueAt.toISOString().slice(0, 10) : null,
      dueTo: dueAt ? dueAt.toISOString().slice(0, 10) : null,
      status: done ? "completed" : "scheduled",
      completedAt: doneAt ? doneAt.toISOString() : null,
      completedById: workerId || null,
      reportPdfPath: reportPath || null,
      raw: cols,
      source: { table: tableName, pk },
    });
  }

  for (const r of pendingOrders) {
    const tableName = r.tableName;
    const pk = r.pk;
    const cols = r.columns;
    const refPk = pickFirstColumn(cols, ["fahrzeug_id"]);
    if (!refPk) addIssue("error", { tableName, pk, columnName: "fahrzeug_id", entityType: "order", entityKey: `${tableName}:${pk}`, message: "missing_order_unit_reference" });
    const unitId = refPk ? unitBySource.get(`fahrzeuge:${refPk}`) || null : null;
    if (refPk && !unitId) addIssue("error", { tableName, pk, columnName: "fahrzeug_id", entityType: "order", entityKey: `${tableName}:${pk}`, message: "unit_reference_not_found", details: { refTable: "fahrzeuge", refPk } });
    const title = pickFirstColumn(cols, ["titel"]) || `Auftrag ${pk}`;
    const description = pickFirstColumn(cols, ["fehlerbeschreibung"]);
    if (!description) addIssue("error", { tableName, pk, columnName: "fehlerbeschreibung", entityType: "order", entityKey: `${tableName}:${pk}`, message: "missing_order_description" });
    if (description && description.length < 20) addIssue("warning", { tableName, pk, columnName: "fehlerbeschreibung", entityType: "order", entityKey: `${tableName}:${pk}`, message: "order_description_too_short", details: { length: description.length } });
    const prioRaw = pickFirstColumn(cols, ["prioritaet"]);
    const priority = parsePriority(prioRaw) || (normalizeString(prioRaw).toLowerCase() === "kritisch" ? "high" : "medium");
    const critical = normalizeString(prioRaw).toLowerCase() === "kritisch";
    const statusRaw = pickFirstColumn(cols, ["status"]);
    const workState =
      statusRaw && normalizeString(statusRaw).toLowerCase() === "abgeschlossen"
        ? "done"
        : statusRaw && normalizeString(statusRaw).toLowerCase() === "in_bearbeitung"
          ? "in_progress"
          : "created";
    const openedAt = parseDateLoose(pickFirstColumn(cols, ["erstellt_am"]) || "") || null;
    const inProgressAt = parseDateLoose(pickFirstColumn(cols, ["beginn_am"]) || "") || null;
    const closedAt = parseDateLoose(pickFirstColumn(cols, ["abgeschlossen_am"]) || "") || null;
    const reporterRole = "workshop";
    const photoPath = pickFirstColumn(cols, ["foto_pfad"]);
    const creatorId = pickFirstColumn(cols, ["ersteller_id"]);
    const assigneeId = pickFirstColumn(cols, ["bearbeiter_id"]);
    orders.push({
      orderId: stableImportId("wscimp", tableName, pk),
      unitId,
      title,
      description: description || "",
      priority,
      critical,
      reporterRole,
      workState,
      interrupted: false,
      deliveryDelay: false,
      openedAt: (openedAt || inProgressAt || new Date()).toISOString(),
      closedAt: closedAt ? closedAt.toISOString() : null,
      photoPath,
      creatorId: creatorId || null,
      assigneeId: assigneeId || null,
      raw: cols,
      source: { table: tableName, pk },
    });
  }

  const errors = issues.filter((x) => x.severity === "error");
  return { ok: errors.length === 0, issues, units, inspections, orders, employees };
}

async function persistImportRun({ kind, sourcePath, status, requestedBy, startedAt, finishedAt, summary, issues }) {
  if (!pool) return { ok: false, error: "db_required" };
  const id = `impr_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into import_run (id, kind, source_path, status, started_at, finished_at, requested_by, summary)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb);
    `,
    [id, kind, sourcePath, status, startedAt, finishedAt, requestedBy, JSON.stringify(summary || {})],
  );
  const rows = Array.isArray(issues) ? issues : [];
  for (const it of rows) {
    const issueId = `impi_${crypto.randomUUID().slice(0, 12)}`;
    await pool.query(
      `
      insert into import_issue
        (id, run_id, severity, table_name, pk, column_name, entity_type, entity_key, message, details, created_at)
      values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now());
      `,
      [
        issueId,
        id,
        normalizeString(it.severity) || "error",
        normalizeString(it.tableName) || null,
        normalizeString(it.pk) || null,
        normalizeString(it.columnName) || null,
        normalizeString(it.entityType) || null,
        normalizeString(it.entityKey) || null,
        normalizeString(it.message) || "issue",
        JSON.stringify(it.details || {}),
      ],
    );
  }
  await publishErpEvent({
    eventType: "IMPORT_RUN_RECORDED",
    aggregateType: "import_run",
    aggregateId: id,
    sourceModule: "import",
    occurredAt: finishedAt,
    createdBy: requestedBy,
    partitionKey: kind,
    headers: { kind, status },
    payload: { id, kind, sourcePath, status, summary: summary || {}, issueCount: rows.length },
  });
  return { ok: true, id };
}

async function validateDbExportFile({ requestedBy }) {
  const sourcePath = "/import/db_export_2026-06-03.csv";
  const startedAt = new Date().toISOString();
  try {
    fs.accessSync(sourcePath, fs.constants.R_OK);
  } catch {
    const finishedAt = new Date().toISOString();
    const run = await persistImportRun({
      kind: "db_export",
      sourcePath,
      status: "validate_failed",
      requestedBy,
      startedAt,
      finishedAt,
      summary: { error: "file_not_found" },
      issues: [{ severity: "error", tableName: null, pk: null, columnName: null, message: "file_not_found", details: { sourcePath } }],
    });
    return { ok: false, error: "file_not_found", runId: run.ok ? run.id : null };
  }
  const pivot = await pivotDbExportFileToRows({ sourcePath });
  if (!pivot.ok) {
    const finishedAt = new Date().toISOString();
    const run = await persistImportRun({
      kind: "db_export",
      sourcePath,
      status: "validate_failed",
      requestedBy,
      startedAt,
      finishedAt,
      summary: { error: pivot.error, details: pivot.details || null },
      issues: [{ severity: "error", tableName: null, pk: null, columnName: null, message: pivot.error, details: pivot.details || {} }],
    });
    return { ok: false, error: pivot.error, runId: run.ok ? run.id : null };
  }
  const extract = validateAndExtractDbExport({ rows: pivot.rows });
  const issues = [...pivot.issues, ...extract.issues];
  const finishedAt = new Date().toISOString();
  const summary = {
    cells: pivot.cells,
    rows: pivot.rows.length,
    units: extract.units.length,
    inspections: extract.inspections.length,
    orders: extract.orders.length,
    issueCounts: issues.reduce((acc, x) => {
      acc[x.severity] = (acc[x.severity] || 0) + 1;
      return acc;
    }, {}),
  };
  const status = extract.ok ? "validated_ok" : "validated_failed";
  const run = await persistImportRun({ kind: "db_export", sourcePath, status, requestedBy, startedAt, finishedAt, summary, issues });
  return { ok: extract.ok, runId: run.ok ? run.id : null, summary, issues, extracted: extract };
}

async function importDbExportFile({ requestedBy, dryRun }) {
  const validation = await validateDbExportFile({ requestedBy });
  if (validation.error && !validation.extracted) return { ok: false, error: validation.error, runId: validation.runId || null, summary: validation.summary || null };
  const data = validation.extracted;
  if (!pool) return { ok: false, error: "db_required", runId: validation.runId };

  const startedAt = new Date().toISOString();
  const client = await pool.connect();
  let imported = { units: 0, inspections: 0, orders: 0 };
  let skipped = { units: 0, inspections: 0, orders: 0 };
  try {
    await client.query("begin;");
    if (!dryRun) {
      for (const u of data.units) {
        if (!u || !u.unitId || !normalizeString(u.code)) {
          skipped.units++;
          continue;
        }
        const attrs = { ...(u.attributes || {}), import: { runId: validation.runId, importedAt: startedAt } };
        await client.query(
          `
          insert into fleet_vehicle
            (id, code, kind, type, attributes, capabilities, container_sizes, container_types, grappler_types, adr_enabled, adr_classes, home_depot, home_lat, home_lon, created_at)
          values
            ($1,$2,$3,$4,$5::jsonb,$6,'{}'::text[],'{}'::text[],'{}'::text[],false,'{}'::text[],null,null,null, now())
          on conflict (id) do update
            set code = excluded.code,
                kind = excluded.kind,
                type = excluded.type,
                attributes = excluded.attributes,
                capabilities = excluded.capabilities;
          `,
          [u.unitId, u.code, u.kind, u.type, JSON.stringify(attrs), u.capabilities || []],
        );
        imported.units++;
      }

      for (const insp of data.inspections) {
        if (!insp || !insp.unitId || !normalizeString(insp.inspectionType)) {
          skipped.inspections++;
          continue;
        }
        const dueMonth = insp.dueMonth || (insp.dueFrom ? insp.dueFrom.slice(0, 7) : null);
        if (!dueMonth) {
          skipped.inspections++;
          continue;
        }
        const win = dueWindowFromMonth(dueMonth);
        if (!win) {
          skipped.inspections++;
          continue;
        }
        const reportPdf = insp.reportPdfPath ? { path: insp.reportPdfPath, source: insp.source || null } : null;
        const completedAt = insp.completedAt ? parseIsoDate(insp.completedAt) : null;
        const completedBy = insp.completedById ? data.employees?.get(String(insp.completedById))?.name || String(insp.completedById) : null;
        await client.query(
          `
          insert into fleet_inspection
            (id, unit_id, inspection_type, due_month, due_from, due_to, status, completed_at, completed_by, report_pdf, created_by, created_at)
          values
            ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,$10::jsonb,$11, now())
          on conflict (id) do update
            set unit_id = excluded.unit_id,
                inspection_type = excluded.inspection_type,
                due_month = excluded.due_month,
                due_from = excluded.due_from,
                due_to = excluded.due_to,
                status = excluded.status,
                completed_at = excluded.completed_at,
                completed_by = excluded.completed_by,
                report_pdf = excluded.report_pdf;
          `,
          [
            insp.inspectionId,
            insp.unitId,
            insp.inspectionType,
            win.dueMonth,
            win.dueFrom.toISOString().slice(0, 10),
            win.dueTo.toISOString().slice(0, 10),
            insp.status === "completed" ? "completed" : "scheduled",
            completedAt ? completedAt.toISOString() : null,
            completedBy,
            JSON.stringify(reportPdf),
            requestedBy,
          ],
        );
        imported.inspections++;
      }

      for (const o of data.orders) {
        if (!o || !o.unitId || !normalizeString(o.description)) {
          skipped.orders++;
          continue;
        }
        const openedAt = o.openedAt ? parseIsoDate(o.openedAt) : new Date();
        const closedAt = o.closedAt ? parseIsoDate(o.closedAt) : null;
        const isDone = o.workState === "done";
        const status = isDone ? "closed" : "open";
        const closedReason = isDone ? "imported" : null;
        const lockType = o.critical && !isDone ? "hard" : "soft";
        const severity = o.critical && !isDone ? "critical" : "warning";
        const assignedTo = o.assigneeId ? data.employees?.get(String(o.assigneeId))?.name || String(o.assigneeId) : null;
        await client.query(
          `
          insert into workshop_case
            (id, vehicle_id, title, description, priority, reporter_role, work_state, interrupted, delivery_delay, assigned_to, assigned_by, assigned_at, photo, severity, lock_type, status, opened_at, closed_at, closed_reason, created_by, created_at)
          values
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,null,null,$11,$12,$13,$14,$15,$16,$17, now())
          on conflict (id) do update
            set vehicle_id = excluded.vehicle_id,
                title = excluded.title,
                description = excluded.description,
                priority = excluded.priority,
                reporter_role = excluded.reporter_role,
                work_state = excluded.work_state,
                interrupted = excluded.interrupted,
                delivery_delay = excluded.delivery_delay,
                assigned_to = excluded.assigned_to,
                status = excluded.status,
                opened_at = excluded.opened_at,
                closed_at = excluded.closed_at,
                closed_reason = excluded.closed_reason,
                severity = excluded.severity,
                lock_type = excluded.lock_type;
          `,
          [
            o.orderId,
            o.unitId,
            o.title,
            o.description,
            o.priority,
            o.reporterRole,
            o.workState,
            o.interrupted,
            o.deliveryDelay,
            assignedTo,
            severity,
            lockType,
            status,
            openedAt.toISOString(),
            closedAt ? closedAt.toISOString() : null,
            closedReason,
            requestedBy,
          ],
        );

        if (!isDone && lockType === "hard") {
          const blockId = stableImportId("blkimp", o.source.table, o.source.pk);
          await client.query(
            `
            insert into fleet_availability_block
              (id, vehicle_id, source_module, severity, lock_type, reason, starts_at, ends_at, ref_entity_type, ref_entity_id, created_at)
            values
              ($1,$2,'workshop',$3,$4,$5,$6,null,'workshopCase',$7, now())
            on conflict (id) do nothing;
            `,
            [blockId, o.unitId, severity, lockType, o.title, openedAt.toISOString(), o.orderId],
          );
        }

        await client.query(
          `
          insert into workshop_case_event (id, case_id, from_status, to_status, reason, username, occurred_at, meta)
          values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
          on conflict (id) do nothing;
          `,
          [
            `wse_${crypto.randomUUID().slice(0, 12)}`,
            o.orderId,
            null,
            status,
            "imported",
            requestedBy,
            openedAt.toISOString(),
            JSON.stringify({ source: o.source, workState: o.workState, interrupted: o.interrupted, deliveryDelay: o.deliveryDelay, critical: Boolean(o.critical), assigneeId: o.assigneeId || null, creatorId: o.creatorId || null, photoPath: o.photoPath || null, raw: o.raw }),
          ],
        );
        imported.orders++;
      }
    }

    await client.query(dryRun ? "rollback;" : "commit;");
  } catch (e) {
    try {
      await client.query("rollback;");
    } catch {}
    return { ok: false, error: "import_failed", runId: validation.runId, message: String(e && e.message ? e.message : e) };
  } finally {
    client.release();
  }

  const finishedAt = new Date().toISOString();
  const qc = {
    imported,
    skipped,
    validation: { runId: validation.runId || null, ok: Boolean(validation.ok), summary: validation.summary || null },
    checks: {
      unitsInDb: await pool.query(`select count(*)::int as n from fleet_vehicle;`).then((r) => r.rows[0]?.n || 0),
      inspectionsInDb: await pool.query(`select count(*)::int as n from fleet_inspection;`).then((r) => r.rows[0]?.n || 0),
      ordersInDb: await pool.query(`select count(*)::int as n from workshop_case;`).then((r) => r.rows[0]?.n || 0),
    },
  };
  const run = await persistImportRun({
    kind: "db_export",
    sourcePath: "/import/db_export_2026-06-03.csv",
    status: dryRun ? "dry_run_ok" : "import_ok",
    requestedBy,
    startedAt,
    finishedAt,
    summary: qc,
    issues: [],
  });
  return { ok: true, runId: run.ok ? run.id : null, validationRunId: validation.runId, summary: qc };
}

function parseDueMonth(value) {
  const v = normalizeString(value);
  const m = v.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function dueWindowFromMonth(dueMonth) {
  const p = parseDueMonth(dueMonth);
  if (!p) return null;
  const from = new Date(Date.UTC(p.year, p.month - 1, 1));
  const to = new Date(Date.UTC(p.year, p.month, 0));
  return { dueMonth: `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}`, dueFrom: from, dueTo: to };
}

function parseOptionalIsoDateParam(url, name) {
  const raw = normalizeString(url.searchParams.get(name));
  if (!raw) return null;
  return parseIsoDate(raw);
}

function parseRequiredIsoDateParam(res, url, name) {
  const raw = normalizeString(url.searchParams.get(name));
  if (!raw) return { ok: false, error: badRequest(res, `${name}_required`) };
  const dt = parseIsoDate(raw);
  if (!dt) return { ok: false, error: badRequest(res, `invalid_${name}`) };
  return { ok: true, value: dt };
}

function parseRequiredStringParam(res, url, name) {
  const raw = normalizeString(url.searchParams.get(name));
  if (!raw) return { ok: false, error: badRequest(res, `${name}_required`) };
  return { ok: true, value: raw };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function ensureSeedData() {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`select count(*)::int as n from fleet_vehicle;`);
    const n = rows[0]?.n ?? 0;
    if (n === 0) {
      await client.query(
        `
        insert into fleet_vehicle (id, code, kind, type, attributes, capabilities, container_sizes, container_types, grappler_types, adr_enabled, adr_classes, home_depot, home_lat, home_lon)
        values
          ($1, $2, 'vehicle', $3, '{}'::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12),
          ($13, $14, 'vehicle', $15, '{}'::jsonb, $16, $17, $18, $19, $20, $21, $22, $23, $24),
          ($25, $26, 'vehicle', $27, '{}'::jsonb, $28, $29, $30, $31, $32, $33, $34, $35, $36),
          ($37, $38, 'vehicle', $39, '{}'::jsonb, $40, $41, $42, $43, $44, $45, $46, $47, $48);
        `,
        [
          "veh_01",
          "WAF-XX 123",
          "LKW",
          ["waste"],
          ["20ft", "40ft", "45ft"],
          ["standard", "special"],
          ["standard", "heavy"],
          true,
          ["3", "8", "9"],
          "GREVEN",
          52.091,
          7.612,
          "veh_02",
          "MS-AB 456",
          "Spül-/Saugwagen",
          ["sewage"],
          [],
          [],
          [],
          false,
          [],
          "GREVEN",
          52.091,
          7.612,
          "veh_03",
          "MS-XY 789",
          "Tankwagen",
          ["fuel"],
          [],
          [],
          [],
          true,
          ["3"],
          "GREVEN",
          52.091,
          7.612,
          "veh_04",
          "WAF-YY 234",
          "LKW",
          ["waste"],
          ["20ft", "40ft", "45ft"],
          ["standard", "special"],
          ["standard", "heavy"],
          true,
          ["3", "8", "9"],
          "GREVEN",
          52.091,
          7.612,
        ],
      );
    } else {
      await client.query(
        `
        update fleet_vehicle
        set
          container_sizes = case when capabilities @> array['waste']::text[] and array_length(container_sizes, 1) is null then array['20ft','40ft','45ft']::text[] else container_sizes end,
          container_types = case when capabilities @> array['waste']::text[] and array_length(container_types, 1) is null then array['standard','special']::text[] else container_types end,
          grappler_types = case when capabilities @> array['waste']::text[] and array_length(grappler_types, 1) is null then array['standard','heavy']::text[] else grappler_types end
        where array_length(container_sizes, 1) is null or array_length(container_types, 1) is null or array_length(grappler_types, 1) is null;
        `,
      );

      await client.query(
        `
        insert into fleet_vehicle (id, code, kind, type, attributes, capabilities, container_sizes, container_types, grappler_types, adr_enabled, adr_classes, home_depot, home_lat, home_lon)
        values ($1, $2, 'vehicle', $3, '{}'::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        on conflict (id) do nothing;
        `,
        [
          "veh_04",
          "WAF-YY 234",
          "LKW",
          ["waste"],
          ["20ft", "40ft", "45ft"],
          ["standard", "special"],
          ["standard", "heavy"],
          true,
          ["3", "8", "9"],
          "GREVEN",
          52.091,
          7.612,
        ],
      );
    }

    const { rows: drivers } = await client.query(`select count(*)::int as n from fleet_driver;`);
    if ((drivers[0]?.n ?? 0) === 0) {
      await client.query(
        `
        insert into fleet_driver (id, name, home_depot)
        values
          ($1, $2, $3),
          ($4, $5, $6);
        `,
        ["drv_01", "Fahrer 1", "GREVEN", "drv_02", "Fahrer 2", "GREVEN"],
      );
    }

    const { rows: bindings } = await client.query(`select count(*)::int as n from fleet_driver_binding;`);
    if ((bindings[0]?.n ?? 0) === 0) {
      await client.query(
        `
        insert into fleet_driver_binding (id, vehicle_id, driver_id, binding_type, active, created_at)
        values
          ($1, $2, $3, $4, $5, now());
        `,
        ["bind_01", "veh_01", "drv_01", "exclusive", true],
      );
    }

    const { rows: sys } = await client.query(`select count(*)::int as n from fleet_vehicle_system_status;`);
    if ((sys[0]?.n ?? 0) === 0) {
      const ts = new Date().toISOString();
      await client.query(
        `
        insert into fleet_vehicle_system_status (id, vehicle_id, system, status, source, updated_at)
        values
          ($1, $2, $3, $4, $5, $6),
          ($7, $8, $9, $10, $11, $12);
        `,
        [
          "sys_01",
          "veh_01",
          "weigh",
          "ok",
          "seed",
          ts,
          "sys_02",
          "veh_01",
          "tank",
          "ok",
          "seed",
          ts,
        ],
      );
    }

    const { rows: depots } = await client.query(`select count(*)::int as n from fleet_depot;`);
    if ((depots[0]?.n ?? 0) === 0) {
      await client.query(
        `
        insert into fleet_depot (code, name, lat, lon, utilization, updated_at)
        values
          ($1, $2, $3, $4, $5, now()),
          ($6, $7, $8, $9, $10, now());
        `,
        ["GREVEN", "Greven", 52.091, 7.612, 0.3, "MUENSTER", "Münster", 51.962, 7.628, 0.6],
      );
    }

    const { rows: blocks } = await client.query(`select count(*)::int as n from fleet_availability_block;`);
    const bN = blocks[0]?.n ?? 0;
    if (bN === 0) {
      const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await client.query(
        `
        insert into fleet_availability_block
          (id, vehicle_id, source_module, severity, lock_type, reason, starts_at, ends_at, ref_entity_type, ref_entity_id, created_at)
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
        `,
        [
          "blk_01",
          "veh_01",
          "workshop",
          "critical",
          "hard",
          "Kritischer Defekt offen",
          startsAt,
          null,
          "workshopCase",
          "ws_1001",
          startsAt,
        ],
      );
    }
  } finally {
    client.release();
  }
}

async function getVehicles() {
  if (!pool) {
    return [
      {
        id: "veh_01",
        code: "WAF-XX 123",
        type: "LKW",
        capabilities: ["waste"],
        containerSizes: ["20ft", "40ft", "45ft"],
        containerTypes: ["standard", "special"],
        grapplerTypes: ["standard", "heavy"],
        adrEnabled: true,
        adrClasses: ["3", "8", "9"],
        homeDepot: "GREVEN",
        homeLat: 52.091,
        homeLon: 7.612,
      },
      {
        id: "veh_02",
        code: "MS-AB 456",
        type: "Spül-/Saugwagen",
        capabilities: ["sewage"],
        containerSizes: [],
        containerTypes: [],
        grapplerTypes: [],
        adrEnabled: false,
        adrClasses: [],
        homeDepot: "GREVEN",
        homeLat: 52.091,
        homeLon: 7.612,
      },
      {
        id: "veh_03",
        code: "MS-XY 789",
        type: "Tankwagen",
        capabilities: ["fuel"],
        containerSizes: [],
        containerTypes: [],
        grapplerTypes: [],
        adrEnabled: true,
        adrClasses: ["3"],
        homeDepot: "GREVEN",
        homeLat: 52.091,
        homeLon: 7.612,
      },
    ];
  }

  const { rows } = await pool.query(
    `select id, code, kind, type, attributes, capabilities, container_sizes, container_types, grappler_types, adr_enabled, adr_classes, home_depot, home_lat, home_lon, payload_max_kg, volume_max_cbm from fleet_vehicle order by code asc;`,
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    kind: r.kind || "vehicle",
    type: r.type,
    attributes: r.attributes && typeof r.attributes === "object" ? r.attributes : {},
    capabilities: r.capabilities || [],
    containerSizes: r.container_sizes || [],
    containerTypes: r.container_types || [],
    grapplerTypes: r.grappler_types || [],
    adrEnabled: Boolean(r.adr_enabled),
    adrClasses: r.adr_classes || [],
    homeDepot: r.home_depot || null,
    homeLat: typeof r.home_lat === "number" ? r.home_lat : r.home_lat === null ? null : Number(r.home_lat),
    homeLon: typeof r.home_lon === "number" ? r.home_lon : r.home_lon === null ? null : Number(r.home_lon),
    payloadMaxKg: r.payload_max_kg === null ? null : Number(r.payload_max_kg),
    volumeMaxCbm: r.volume_max_cbm === null ? null : Number(r.volume_max_cbm),
  }));
}

async function getVehicleById(vehicleId) {
  const list = await getVehicles();
  return list.find((v) => v.id === vehicleId) || null;
}

function vehicleDeepLink(vehicleId) {
  return `/?module=workshop&entity=vehicle:${encodeURIComponent(vehicleId)}`;
}

function blockDeepLink(block) {
  return `/?module=workshop&entity=${encodeURIComponent(block.reference.entityType)}:${encodeURIComponent(block.reference.entityId)}`;
}

function includesLoose(haystack, needle) {
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

function isBlockActive(block, at = new Date()) {
  const start = new Date(block.startsAt);
  const end = block.endsAt ? new Date(block.endsAt) : null;
  if (Number.isNaN(start.valueOf())) return false;
  if (start > at) return false;
  if (end && end < at) return false;
  return true;
}

async function getAvailabilityBlocks({ activeOnly = false } = {}) {
  if (!pool) {
    const blocks = [
      {
        id: "blk_01",
        vehicleId: "veh_01",
        sourceModule: "workshop",
        severity: "critical",
        lockType: "hard",
        reason: "Kritischer Defekt offen",
        startsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        endsAt: null,
        reference: { entityType: "workshopCase", entityId: "ws_1001" },
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ];
    return activeOnly ? blocks.filter((b) => isBlockActive(b)) : blocks;
  }

  const rows = await pool
    .query(
      `
      select
        id,
        vehicle_id,
        source_module,
        severity,
        lock_type,
        reason,
        starts_at,
        ends_at,
        ref_entity_type,
        ref_entity_id,
        created_at
      from fleet_availability_block
      order by created_at desc;
      `,
    )
    .then((r) => r.rows);

  const blocks = rows.map((r) => ({
    id: r.id,
    vehicleId: r.vehicle_id,
    sourceModule: r.source_module,
    severity: r.severity,
    lockType: r.lock_type,
    reason: r.reason,
    startsAt: new Date(r.starts_at).toISOString(),
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    reference: { entityType: r.ref_entity_type, entityId: r.ref_entity_id },
    createdAt: new Date(r.created_at).toISOString(),
  }));

  return activeOnly ? blocks.filter((b) => isBlockActive(b)) : blocks;
}

async function insertAuditLog(event) {
  if (!pool) return;
  await pool.query(
    `
    insert into fleet_audit_log
      (id, event_type, username, occurred_at, lock_type, block_id, vehicle_id, block_reason, override_id, override_reason, meta)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
    `,
    [
      event.id,
      event.eventType,
      event.username,
      event.occurredAt,
      event.lockType,
      event.blockId,
      event.vehicleId,
      event.blockReason,
      event.overrideId,
      event.overrideReason,
      event.meta || {},
    ],
  );
}

async function insertApprovalAuditLog(entry) {
  if (!pool) return;
  await pool.query(
    `
    insert into erp_approval_audit
      (id, request_id, entity_type, entity_id, event_type, username, occurred_at, reason, meta)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb);
    `,
    [
      entry.id,
      entry.requestId || null,
      entry.entityType,
      entry.entityId || null,
      entry.eventType,
      entry.username,
      entry.occurredAt,
      entry.reason || null,
      JSON.stringify(entry.meta || {}),
    ],
  );
}

function normalizeApprovalRequestType(value) {
  const v = normalizeString(value);
  return v ? v.toUpperCase().replace(/[^A-Z0-9_]+/g, "_") : null;
}

function normalizeApprovalRequestSubtype(value) {
  const v = normalizeString(value);
  return v ? v.toLowerCase().replace(/[^a-z0-9_]+/g, "_") : null;
}

function approvalPolicyFor({ requestType, requestSubtype, payload }) {
  const t = normalizeApprovalRequestType(requestType);
  const s = normalizeApprovalRequestSubtype(requestSubtype);
  const p = payload && typeof payload === "object" ? payload : {};

  if (t === "PRICING_CHANGE") {
    const b = p.body && typeof p.body === "object" ? p.body : {};
    const unitPriceCents = Number.isFinite(Number(b.unitPriceCents)) ? Math.abs(Math.round(Number(b.unitPriceCents))) : 0;
    const valueCents = Number.isFinite(Number(b.valueCents)) ? Math.abs(Math.round(Number(b.valueCents))) : 0;
    const valuePct = Number.isFinite(Number(b.valuePct)) ? Math.abs(Number(b.valuePct)) : 0;
    const magnitude = Math.max(unitPriceCents, valueCents, Math.round(valuePct * 100));
    const needsL2 = magnitude >= 20_000 || valuePct >= 10;

    const steps = needsL2
      ? [
          { stepNo: 1, requiredPermission: Permissions.ApprovalApprovePricingL1, escalationPermission: Permissions.ApprovalApprovePricingL2, slaMinutes: 120 },
          { stepNo: 2, requiredPermission: Permissions.ApprovalApprovePricingL2, escalationPermission: Permissions.FleetAdmin, slaMinutes: 240 },
        ]
      : [{ stepNo: 1, requiredPermission: Permissions.ApprovalApprovePricingL1, escalationPermission: Permissions.ApprovalApprovePricingL2, slaMinutes: 240 }];
    return { steps, requestedSlaMinutes: steps[0]?.slaMinutes || 240, meta: { magnitude, needsL2, policy: "pricing_v1" } };
  }

  if (t === "BILLING_APPROVAL") {
    const steps = [{ stepNo: 1, requiredPermission: Permissions.ApprovalApproveBilling, escalationPermission: Permissions.FleetAdmin, slaMinutes: 120 }];
    return { steps, requestedSlaMinutes: 120, meta: { policy: "billing_v1" } };
  }

  if (t === "ROUTE_OVERRIDE") {
    const m = p.meta && typeof p.meta === "object" ? p.meta : {};
    const elevated = m.overrideRequirement === "elevated" || m.hardBlocksPresent === true || m.requiresHard === true;
    const steps = elevated
      ? [
          { stepNo: 1, requiredPermission: Permissions.ApprovalApproveRouteOverrideL1, escalationPermission: Permissions.ApprovalApproveRouteOverrideL2, slaMinutes: 30 },
          { stepNo: 2, requiredPermission: Permissions.ApprovalApproveRouteOverrideL2, escalationPermission: Permissions.FleetAdmin, slaMinutes: 60 },
        ]
      : [{ stepNo: 1, requiredPermission: Permissions.ApprovalApproveRouteOverrideL1, escalationPermission: Permissions.ApprovalApproveRouteOverrideL2, slaMinutes: 60 }];
    return { steps, requestedSlaMinutes: steps[0]?.slaMinutes || 60, meta: { elevated, policy: "route_override_v1" } };
  }

  if (t === "MASTERDATA_CHANGE") {
    const steps = [{ stepNo: 1, requiredPermission: Permissions.ApprovalApproveMasterdata, escalationPermission: Permissions.FleetAdmin, slaMinutes: 240 }];
    return { steps, requestedSlaMinutes: 240, meta: { policy: "masterdata_v1", subtype: s || null } };
  }

  const steps = [{ stepNo: 1, requiredPermission: Permissions.FleetAdmin, escalationPermission: Permissions.FleetAdmin, slaMinutes: 240 }];
  return { steps, requestedSlaMinutes: 240, meta: { policy: "fallback_admin" } };
}

async function getApprovalRequestById(id) {
  if (!pool) return null;
  const rid = normalizeString(id);
  if (!rid) return null;
  const r = await pool
    .query(
      `
      select id, request_type, request_subtype, status, requested_by, requested_at, reason, payload, due_at, escalated_at, rejected_at, rejected_by, applied_at, applied_by, meta
      from erp_approval_request
      where id = $1
      limit 1;
      `,
      [rid],
    )
    .then((x) => x.rows[0] || null)
    .catch(() => null);
  if (!r) return null;
  const steps = await pool
    .query(
      `
      select id, step_no, required_permission, escalation_permission, status, decided_at, decided_by, decision_reason, created_at
      from erp_approval_step
      where request_id = $1
      order by step_no asc;
      `,
      [rid],
    )
    .then((x) => x.rows)
    .catch(() => []);
  return {
    id: r.id,
    requestType: r.request_type,
    requestSubtype: r.request_subtype || null,
    status: r.status,
    requestedBy: r.requested_by,
    requestedAt: new Date(r.requested_at).toISOString(),
    reason: r.reason || null,
    payload: r.payload || {},
    dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
    escalatedAt: r.escalated_at ? new Date(r.escalated_at).toISOString() : null,
    rejectedAt: r.rejected_at ? new Date(r.rejected_at).toISOString() : null,
    rejectedBy: r.rejected_by || null,
    appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : null,
    appliedBy: r.applied_by || null,
    meta: r.meta || {},
    steps: steps.map((s) => ({
      id: s.id,
      stepNo: Number(s.step_no),
      requiredPermission: s.required_permission,
      escalationPermission: s.escalation_permission || null,
      status: s.status,
      decidedAt: s.decided_at ? new Date(s.decided_at).toISOString() : null,
      decidedBy: s.decided_by || null,
      decisionReason: s.decision_reason || null,
      createdAt: new Date(s.created_at).toISOString(),
    })),
  };
}

async function listApprovalRequests({ status = null, requestType = null, limit = 50 } = {}) {
  if (!pool) return [];
  const st = normalizeString(status) || null;
  const t = normalizeApprovalRequestType(requestType) || null;
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = await pool
    .query(
      `
      select id, request_type, request_subtype, status, requested_by, requested_at, reason, due_at, escalated_at, rejected_at, rejected_by, applied_at, applied_by
      from erp_approval_request
      where ($1::text is null or status = $1)
        and ($2::text is null or request_type = $2)
      order by requested_at desc
      limit $3;
      `,
      [st, t, n],
    )
    .then((r) => r.rows)
    .catch(() => []);
  return rows.map((r) => ({
    id: r.id,
    requestType: r.request_type,
    requestSubtype: r.request_subtype || null,
    status: r.status,
    requestedBy: r.requested_by,
    requestedAt: new Date(r.requested_at).toISOString(),
    reason: r.reason || null,
    dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
    escalatedAt: r.escalated_at ? new Date(r.escalated_at).toISOString() : null,
    rejectedAt: r.rejected_at ? new Date(r.rejected_at).toISOString() : null,
    rejectedBy: r.rejected_by || null,
    appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : null,
    appliedBy: r.applied_by || null,
  }));
}

async function createApprovalRequest({ requestType, requestSubtype, requestedBy, reason, payload, meta }) {
  if (!pool) return { ok: false, error: "db_required" };
  const t = normalizeApprovalRequestType(requestType);
  if (!t) return { ok: false, error: "invalid_request_type" };
  const s = normalizeApprovalRequestSubtype(requestSubtype);
  const u = normalizeString(requestedBy);
  if (!u) return { ok: false, error: "requestedBy_required" };

  const policy = approvalPolicyFor({ requestType: t, requestSubtype: s, payload });
  const id = `apr_${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date();
  const dueAt = new Date(now.getTime() + Math.max(1, Number(policy.requestedSlaMinutes) || 240) * 60_000);

  await pool.query(
    `
    insert into erp_approval_request
      (id, request_type, request_subtype, status, requested_by, requested_at, reason, payload, due_at, meta)
    values
      ($1,$2,$3,'pending',$4,$5,$6,$7::jsonb,$8,$9::jsonb);
    `,
    [id, t, s, u, now.toISOString(), reason || null, JSON.stringify(payload || {}), dueAt.toISOString(), JSON.stringify({ ...(meta || {}), ...(policy.meta || {}) })],
  );

  for (const step of policy.steps || []) {
    const sid = `ast_${crypto.randomUUID().slice(0, 12)}`;
    await pool.query(
      `
      insert into erp_approval_step
        (id, request_id, step_no, required_permission, escalation_permission, status, created_at)
      values
        ($1,$2,$3,$4,$5,'pending',$6);
      `,
      [sid, id, Number(step.stepNo) || 1, step.requiredPermission, step.escalationPermission || null, now.toISOString()],
    );
  }

  await insertApprovalAuditLog({
    id: `aal_${crypto.randomUUID().slice(0, 12)}`,
    requestId: id,
    entityType: "approval_request",
    entityId: id,
    eventType: "APPROVAL_REQUESTED",
    username: u,
    occurredAt: now.toISOString(),
    reason: reason || null,
    meta: { requestType: t, requestSubtype: s || null },
  });

  await publishErpEvent({
    eventType: "APPROVAL_REQUESTED",
    aggregateType: "approval_request",
    aggregateId: id,
    occurredAt: now.toISOString(),
    createdBy: u,
    payload: { requestType: t, requestSubtype: s || null, dueAt: dueAt.toISOString() },
  });
  const firstStep = (policy.steps || [])[0] || null;
  if (firstStep && firstStep.requiredPermission) {
    await publishErpEvent({
      eventType: "EMAIL_NOTIFICATION_REQUESTED",
      aggregateType: "approval_request",
      aggregateId: id,
      occurredAt: now.toISOString(),
      createdBy: "system",
      payload: {
        template: "approval_requested",
        toPermission: firstStep.requiredPermission,
        requestId: id,
        requestType: t,
        requestSubtype: s || null,
        dueAt: dueAt.toISOString(),
      },
    });
  }
  publishEvent("approval", "APPROVAL_REQUESTED", { requestId: id, requestType: t, requestSubtype: s || null, dueAt: dueAt.toISOString() });

  const item = await getApprovalRequestById(id);
  return { ok: true, item };
}

async function decideApprovalRequest({ requestId, decision, auth, reason }) {
  if (!pool) return { ok: false, error: "db_required" };
  const rid = normalizeString(requestId);
  const u = normalizeString(auth && auth.username);
  const d = normalizeString(decision);
  const why = normalizeString(reason) || null;
  if (!rid) return { ok: false, error: "requestId_required" };
  if (!u) return { ok: false, error: "decidedBy_required" };
  if (!["approve", "reject"].includes(d)) return { ok: false, error: "invalid_decision" };

  const reqRow = await pool
    .query(
      `select id, request_type, request_subtype, status, requested_by, payload from erp_approval_request where id = $1 limit 1;`,
      [rid],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!reqRow) return { ok: false, error: "request_not_found" };
  if (reqRow.status !== "pending") return { ok: false, error: "request_not_pending" };
  if (normalizeString(reqRow.requested_by) === u) return { ok: false, error: "cannot_approve_own_request" };

  const step = await pool
    .query(
      `
      select id, step_no, required_permission, escalation_permission, status
      from erp_approval_step
      where request_id = $1 and status in ('pending','escalated')
      order by step_no asc
      limit 1;
      `,
      [rid],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!step) return { ok: false, error: "no_pending_step" };
  const can = auth && (auth.permissions.has(step.required_permission) || auth.permissions.has(Permissions.FleetAdmin));
  if (!can) return { ok: false, error: "forbidden" };

  await pool.query(
    `
    update erp_approval_step
    set status = $2, decided_at = $3, decided_by = $4, decision_reason = $5
    where id = $1;
    `,
    [step.id, d === "approve" ? "approved" : "rejected", new Date().toISOString(), u, why],
  );

  const now = new Date();

  if (d === "reject") {
    await pool.query(
      `
      update erp_approval_request
      set status = 'rejected', rejected_at = $2, rejected_by = $3, due_at = null
      where id = $1;
      `,
      [rid, now.toISOString(), u],
    );

    await insertApprovalAuditLog({
      id: `aal_${crypto.randomUUID().slice(0, 12)}`,
      requestId: rid,
      entityType: "approval_request",
      entityId: rid,
      eventType: "APPROVAL_REJECTED",
      username: u,
      occurredAt: now.toISOString(),
      reason: why,
      meta: { stepNo: Number(step.step_no) },
    });
    await publishErpEvent({
      eventType: "APPROVAL_REJECTED",
      aggregateType: "approval_request",
      aggregateId: rid,
      occurredAt: now.toISOString(),
      createdBy: u,
      payload: { stepNo: Number(step.step_no), reason: why },
    });
    publishEvent("approval", "APPROVAL_REJECTED", { requestId: rid, stepNo: Number(step.step_no), reason: why });

    return { ok: true, item: await getApprovalRequestById(rid) };
  }

  const next = await pool
    .query(
      `
      select id, step_no, required_permission, escalation_permission, status
      from erp_approval_step
      where request_id = $1 and status in ('pending','escalated')
      order by step_no asc
      limit 1;
      `,
      [rid],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);

  if (next) {
    const policy = approvalPolicyFor({ requestType: reqRow.request_type, requestSubtype: reqRow.request_subtype, payload: reqRow.payload || {} });
    const stepPolicy = (policy.steps || []).find((x) => Number(x.stepNo) === Number(next.step_no)) || null;
    const sla = stepPolicy ? Math.max(1, Number(stepPolicy.slaMinutes) || 240) : 240;
    const dueAt = new Date(now.getTime() + sla * 60_000);
    await pool.query(`update erp_approval_request set due_at = $2 where id = $1;`, [rid, dueAt.toISOString()]);

    await insertApprovalAuditLog({
      id: `aal_${crypto.randomUUID().slice(0, 12)}`,
      requestId: rid,
      entityType: "approval_request",
      entityId: rid,
      eventType: "APPROVAL_STEP_APPROVED",
      username: u,
      occurredAt: now.toISOString(),
      reason: why,
      meta: { stepNo: Number(step.step_no), nextStepNo: Number(next.step_no), dueAt: dueAt.toISOString() },
    });
    await publishErpEvent({
      eventType: "APPROVAL_STEP_APPROVED",
      aggregateType: "approval_request",
      aggregateId: rid,
      occurredAt: now.toISOString(),
      createdBy: u,
      payload: { stepNo: Number(step.step_no), nextStepNo: Number(next.step_no), dueAt: dueAt.toISOString() },
    });
    publishEvent("approval", "APPROVAL_STEP_APPROVED", { requestId: rid, stepNo: Number(step.step_no), nextStepNo: Number(next.step_no), dueAt: dueAt.toISOString() });

    return { ok: true, item: await getApprovalRequestById(rid) };
  }

  await pool.query(`update erp_approval_request set status = 'approved', due_at = null where id = $1;`, [rid]);
  await insertApprovalAuditLog({
    id: `aal_${crypto.randomUUID().slice(0, 12)}`,
    requestId: rid,
    entityType: "approval_request",
    entityId: rid,
    eventType: "APPROVAL_APPROVED",
    username: u,
    occurredAt: now.toISOString(),
    reason: why,
    meta: { finalStepNo: Number(step.step_no) },
  });

  const applyRes = await applyApprovalRequest({ requestId: rid, appliedBy: u });
  if (!applyRes.ok) return applyRes;
  return { ok: true, item: await getApprovalRequestById(rid), applied: applyRes.applied };
}

async function applyApprovalRequest({ requestId, appliedBy }) {
  if (!pool) return { ok: false, error: "db_required" };
  const rid = normalizeString(requestId);
  const u = normalizeString(appliedBy);
  if (!rid) return { ok: false, error: "requestId_required" };
  if (!u) return { ok: false, error: "appliedBy_required" };

  const reqRow = await pool
    .query(
      `select id, request_type, request_subtype, status, requested_by, payload from erp_approval_request where id = $1 limit 1;`,
      [rid],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!reqRow) return { ok: false, error: "request_not_found" };
  if (!["approved", "applied"].includes(reqRow.status)) return { ok: false, error: "request_not_approved" };
  if (reqRow.status === "applied") return { ok: true, applied: { alreadyApplied: true } };

  const requestedBy = normalizeString(reqRow.requested_by);
  const payload = reqRow.payload && typeof reqRow.payload === "object" ? reqRow.payload : {};

  let applied = null;
  if (reqRow.request_type === "PRICING_CHANGE") {
    const kind = normalizeApprovalRequestSubtype(reqRow.request_subtype) || "unknown";
    if (kind === "pricelist_create") {
      applied = await createPriceList({ body: payload.body || {}, username: requestedBy });
    } else if (kind === "pricelist_item_create") {
      applied = await createPriceListItem({ body: payload.body || {}, username: requestedBy });
    } else if (kind === "fee_create") {
      applied = await createFee({ body: payload.body || {}, username: requestedBy });
    } else if (kind === "override_create") {
      applied = await createCustomerOverride({ body: payload.body || {}, username: requestedBy });
    } else {
      return { ok: false, error: "unknown_pricing_action" };
    }
  } else if (reqRow.request_type === "MASTERDATA_CHANGE") {
    const kind = normalizeApprovalRequestSubtype(reqRow.request_subtype) || "unknown";
    if (kind === "customer_create") {
      applied = await createCustomer({ body: payload.body || {}, username: requestedBy });
    } else if (kind === "customer_update") {
      applied = await updateCustomer({ body: payload.body || {}, username: requestedBy });
    } else if (kind === "contract_create") {
      applied = await createContract({ body: payload.body || {}, username: requestedBy });
    } else if (kind === "contract_status") {
      applied = await setContractStatus({ contractId: payload.contractId, toStatus: payload.toStatus, username: requestedBy, reason: payload.reason || null });
    } else if (kind === "material_create") {
      applied = await createMaterial({ body: payload.body || {}, username: requestedBy });
    } else {
      return { ok: false, error: "unknown_masterdata_action" };
    }
  } else if (reqRow.request_type === "BILLING_APPROVAL") {
    const kind = normalizeApprovalRequestSubtype(reqRow.request_subtype) || "unknown";
    if (kind === "invoice_from_pricing") {
      applied = await createInvoiceDraftFromPricing({ orderId: payload.orderId, pricingCalculationId: payload.pricingCalculationId || null, username: requestedBy });
    } else if (kind === "invoice_mock") {
      applied = await createMockInvoiceDraft({ orderId: payload.orderId, currency: payload.currency || "EUR", lines: payload.lines || [], username: requestedBy });
    } else {
      return { ok: false, error: "unknown_billing_action" };
    }
  } else if (reqRow.request_type === "ROUTE_OVERRIDE") {
    applied = await applyDispatchDecisionOverrideFromApproval({ payload, requestedBy, appliedBy: u, approvalRequestId: rid });
  } else {
    return { ok: false, error: "unknown_request_type" };
  }

  if (!applied || applied.ok === false) return { ok: false, error: applied?.error || "apply_failed", applied };

  const now = new Date().toISOString();
  await pool.query(
    `
    update erp_approval_request
    set status = 'applied', applied_at = $2, applied_by = $3
    where id = $1;
    `,
    [rid, now, u],
  );
  await insertApprovalAuditLog({
    id: `aal_${crypto.randomUUID().slice(0, 12)}`,
    requestId: rid,
    entityType: "approval_request",
    entityId: rid,
    eventType: "APPROVAL_APPLIED",
    username: u,
    occurredAt: now,
    reason: null,
    meta: { requestType: reqRow.request_type, requestSubtype: reqRow.request_subtype || null },
  });
  await publishErpEvent({
    eventType: "APPROVAL_APPLIED",
    aggregateType: "approval_request",
    aggregateId: rid,
    occurredAt: now,
    createdBy: u,
    payload: { requestType: reqRow.request_type, requestSubtype: reqRow.request_subtype || null },
  });
  publishEvent("approval", "APPROVAL_APPLIED", { requestId: rid, requestType: reqRow.request_type, requestSubtype: reqRow.request_subtype || null });
  return { ok: true, applied };
}

async function applyDispatchDecisionOverrideFromApproval({ payload, requestedBy, appliedBy, approvalRequestId }) {
  if (!pool) return { ok: false, error: "db_required" };
  const body = payload && typeof payload === "object" ? payload.body : null;
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_payload" };

  const vehicleId = normalizeString(body.vehicleId);
  const moduleKey = normalizeString(body.module);
  const windowStart = parseIsoDate(body.windowStart);
  const windowEnd = parseIsoDate(body.windowEnd);
  const decision = normalizeString(body.decision);
  const reason = normalizeString(body.reason);
  const expiresAt = body.expiresAt ? parseIsoDate(body.expiresAt) : null;
  const ctxSource = body.context && typeof body.context === "object" ? body.context : body;
  const ctx = {
    routeId: normalizeString(ctxSource.routeId),
    orderId: normalizeString(ctxSource.orderId),
    customerId: normalizeString(ctxSource.customerId),
    plannedTons: normalizeString(ctxSource.plannedTons),
    driverId: normalizeString(ctxSource.driverId),
    siteDepot: normalizeString(ctxSource.siteDepot),
    siteLat: ctxSource.siteLat === null || ctxSource.siteLat === undefined || ctxSource.siteLat === "" ? null : Number(ctxSource.siteLat),
    siteLon: ctxSource.siteLon === null || ctxSource.siteLon === undefined || ctxSource.siteLon === "" ? null : Number(ctxSource.siteLon),
    maxDistanceKm: ctxSource.maxDistanceKm === null || ctxSource.maxDistanceKm === undefined || ctxSource.maxDistanceKm === "" ? null : Number(ctxSource.maxDistanceKm),
    weighRequired: Boolean(ctxSource.weighRequired),
    tankRequired: Boolean(ctxSource.tankRequired),
    depotCandidates: Array.isArray(ctxSource.depotCandidates) ? ctxSource.depotCandidates : parseCsv(ctxSource.depotCandidates),
    priorityUrgency: normalizeString(ctxSource.priorityUrgency),
    priorityValue: normalizeString(ctxSource.priorityValue),
    priorityCustomerTier: normalizeString(ctxSource.priorityCustomerTier),
    containerSize: normalizeString(ctxSource.containerSize),
    containerType: normalizeString(ctxSource.containerType),
    grapplerType: normalizeString(ctxSource.grapplerType),
    adrClass: normalizeString(ctxSource.adrClass),
    shiftStart: normalizeString(ctxSource.shiftStart),
    shiftEnd: normalizeString(ctxSource.shiftEnd),
    lastShiftEnd: normalizeString(ctxSource.lastShiftEnd),
    minRestMinutes: normalizeString(ctxSource.minRestMinutes),
    plannedWorkMinutes: normalizeString(ctxSource.plannedWorkMinutes),
    maxWorkMinutes: normalizeString(ctxSource.maxWorkMinutes),
    loadMinutes: normalizeString(ctxSource.loadMinutes),
    unloadMinutes: normalizeString(ctxSource.unloadMinutes),
    transitMinutes: normalizeString(ctxSource.transitMinutes),
  };

  if (!vehicleId || !moduleKey || !windowStart || !windowEnd || windowEnd <= windowStart) return { ok: false, error: "invalid_request" };
  if (moduleKey !== "waste") return { ok: false, error: "module_must_be_waste" };
  if (!["allow", "deny"].includes(decision)) return { ok: false, error: "invalid_decision" };
  if (!reason) return { ok: false, error: "reason_required" };
  if ((ctx.siteLat !== null && !Number.isFinite(ctx.siteLat)) || (ctx.siteLon !== null && !Number.isFinite(ctx.siteLon))) return { ok: false, error: "invalid_site_coordinates" };
  if (ctx.maxDistanceKm !== null && !Number.isFinite(ctx.maxDistanceKm)) return { ok: false, error: "invalid_maxDistanceKm" };

  const vehicle = await getVehicleById(vehicleId);
  if (!vehicle) return { ok: false, error: "vehicle_not_found" };

  const evalResult = await evaluateDispatchDecision({ vehicle, moduleKey, windowStart, windowEnd, context: ctx });
  const hardPresent = evalResult.hardBlocks.length > 0;

  const id = `dovr_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = new Date().toISOString();

  await pool.query(
    `
    insert into fleet_dispatch_override
      (id, vehicle_id, module, window_start, window_end, decision, reason, username, expires_at, created_at)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);
    `,
    [
      id,
      vehicleId,
      moduleKey,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      decision,
      reason,
      requestedBy,
      expiresAt ? expiresAt.toISOString() : null,
      createdAt,
    ],
  );

  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "DISPATCH_DECISION_OVERRIDDEN",
    username: requestedBy,
    occurredAt: createdAt,
    lockType: hardPresent ? "hard" : evalResult.softBlocks.length ? "soft" : null,
    blockId: null,
    vehicleId,
    blockReason: null,
    overrideId: id,
    overrideReason: reason,
    meta: {
      approvalRequestId: approvalRequestId || null,
      appliedBy,
      endpoint: "/api/fleet/dispatch/decision",
      method: "POST",
      module: moduleKey,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      baseDecision: evalResult.baseDecision,
      decision,
      reasonCode: "manual_override",
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      overrideRequirement: evalResult.overrideRequirement,
      criteria: evalResult.criteria,
      reasons: evalResult.reasons,
      warnings: evalResult.warnings,
    },
  });

  return {
    ok: true,
    item: {
      id,
      vehicleId,
      module: moduleKey,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      decision,
      reason,
      username: requestedBy,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      createdAt,
    },
    baseDecision: evalResult.baseDecision,
    hardBlocks: evalResult.hardBlocks.map((b) => ({ id: b.id, reason: b.reason, lockType: b.lockType })),
    softBlocks: evalResult.softBlocks.map((b) => ({ id: b.id, reason: b.reason, lockType: b.lockType })),
  };
}

async function tickApprovalEscalations() {
  if (!pool) return { ok: true, escalated: 0 };
  const now = new Date();
  const rows = await pool
    .query(
      `
      select id
      from erp_approval_request
      where status = 'pending'
        and due_at is not null
        and due_at <= $1
      order by due_at asc
      limit 50;
      `,
      [now.toISOString()],
    )
    .then((r) => r.rows)
    .catch(() => []);
  let escalated = 0;
  for (const r of rows) {
    const rid = r.id;
    const step = await pool
      .query(
        `
        select id, step_no, required_permission, escalation_permission, status
        from erp_approval_step
        where request_id = $1 and status in ('pending','escalated')
        order by step_no asc
        limit 1;
        `,
        [rid],
      )
      .then((x) => x.rows[0] || null)
      .catch(() => null);
    if (!step) continue;
    const escPerm = normalizeString(step.escalation_permission) || Permissions.FleetAdmin;
    const oldPerm = normalizeString(step.required_permission);
    if (!escPerm || escPerm === oldPerm) continue;

    const nextDue = new Date(now.getTime() + 60 * 60_000);
    await pool.query(
      `
      update erp_approval_step
      set required_permission = $2, status = 'escalated'
      where id = $1;
      `,
      [step.id, escPerm],
    );
    await pool.query(`update erp_approval_request set escalated_at = $2, due_at = $3 where id = $1;`, [rid, now.toISOString(), nextDue.toISOString()]);
    await insertApprovalAuditLog({
      id: `aal_${crypto.randomUUID().slice(0, 12)}`,
      requestId: rid,
      entityType: "approval_request",
      entityId: rid,
      eventType: "APPROVAL_ESCALATED",
      username: "system",
      occurredAt: now.toISOString(),
      reason: null,
      meta: { stepNo: Number(step.step_no), fromPermission: oldPerm, toPermission: escPerm, dueAt: nextDue.toISOString() },
    });
    await publishErpEvent({
      eventType: "APPROVAL_ESCALATED",
      aggregateType: "approval_request",
      aggregateId: rid,
      occurredAt: now.toISOString(),
      createdBy: "system",
      payload: { stepNo: Number(step.step_no), fromPermission: oldPerm, toPermission: escPerm, dueAt: nextDue.toISOString() },
    });
    await publishErpEvent({
      eventType: "EMAIL_NOTIFICATION_REQUESTED",
      aggregateType: "approval_request",
      aggregateId: rid,
      occurredAt: now.toISOString(),
      createdBy: "system",
      payload: { template: "approval_escalated", toPermission: escPerm, requestId: rid, stepNo: Number(step.step_no), dueAt: nextDue.toISOString() },
    });
    publishEvent("approval", "APPROVAL_ESCALATED", { requestId: rid, stepNo: Number(step.step_no), fromPermission: oldPerm, toPermission: escPerm, dueAt: nextDue.toISOString() });
    escalated += 1;
  }
  return { ok: true, escalated };
}

let approvalEscalationTimer = null;
function startApprovalEscalationScheduler() {
  if (approvalEscalationTimer) return;
  approvalEscalationTimer = setInterval(() => tickApprovalEscalations().catch(() => {}), 60_000);
}

async function publishErpEvent(args) {
  if (!pool) return null;
  const envelope = buildErpEventEnvelope(args || {});
  if (!envelope) return null;
  try {
    await pool.query(
      `
      insert into erp_event
        (id, event_type, aggregate_type, aggregate_id, occurred_at, created_by, correlation_id, payload, schema_version, source_module, causation_id, trace_id, partition_key, headers)
      values
        ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb);
      `,
      [
        envelope.id,
        envelope.eventType,
        envelope.aggregateType,
        envelope.aggregateId,
        envelope.occurredAt,
        envelope.createdBy,
        envelope.correlationId,
        JSON.stringify(envelope.payload),
        envelope.schemaVersion,
        envelope.sourceModule,
        envelope.causationId,
        envelope.traceId,
        envelope.partitionKey,
        JSON.stringify(envelope.headers),
      ],
    );
    return envelope.id;
  } catch {
    return null;
  }
}

async function getErpEventById(id) {
  if (!pool) return null;
  const v = normalizeString(id);
  if (!v) return null;
  const row = await pool
    .query(
      `
      select id, event_type, aggregate_type, aggregate_id, occurred_at, created_by, correlation_id, payload, schema_version, source_module, causation_id, trace_id, partition_key, headers
      from erp_event
      where id = $1
      limit 1;
      `,
      [v],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!row) return null;
  return {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    createdBy: row.created_by,
    correlationId: row.correlation_id || null,
    schemaVersion: Number(row.schema_version) || 1,
    sourceModule: row.source_module || "unknown",
    causationId: row.causation_id || null,
    traceId: row.trace_id || null,
    partitionKey: row.partition_key || row.aggregate_id,
    headers: row.headers || {},
    payload: row.payload || {},
  };
}

async function listErpEvents({ afterId = null, limit = 200, types = null, aggregateType = null, aggregateId = null } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  const after = normalizeString(afterId) || null;
  const aggType = normalizeString(aggregateType) || null;
  const aggId = normalizeString(aggregateId) || null;
  const typeList = Array.isArray(types)
    ? types.map((t) => normalizeString(t)).filter(Boolean)
    : typeof types === "string"
      ? types
          .split(",")
          .map((t) => normalizeString(t))
          .filter(Boolean)
      : [];

  let afterTime = null;
  if (after) {
    const row = await pool.query(`select occurred_at from erp_event where id = $1;`, [after]).then((r) => r.rows[0] || null).catch(() => null);
    afterTime = row ? new Date(row.occurred_at).toISOString() : null;
  }

  const rows = await pool
    .query(
      `
      select id, event_type, aggregate_type, aggregate_id, occurred_at, created_by, correlation_id, payload, schema_version, source_module, causation_id, trace_id, partition_key, headers
      from erp_event
      where ($1::timestamptz is null or (occurred_at, id) > ($1::timestamptz, $2::text))
        and ($3::text is null or aggregate_type = $3)
        and ($4::text is null or aggregate_id = $4)
        and (cardinality($5::text[]) = 0 or event_type = any($5::text[]))
      order by occurred_at asc, id asc
      limit $6;
      `,
      [afterTime, after || "", aggType, aggId, typeList, n],
    )
    .then((r) => r.rows)
    .catch(() => []);

  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    occurredAt: new Date(r.occurred_at).toISOString(),
    createdBy: r.created_by,
    correlationId: r.correlation_id || null,
    schemaVersion: Number(r.schema_version) || 1,
    sourceModule: r.source_module || "unknown",
    causationId: r.causation_id || null,
    traceId: r.trace_id || null,
    partitionKey: r.partition_key || r.aggregate_id,
    headers: r.headers || {},
    payload: r.payload || {},
  }));
}

async function getErpConsumerOffset(consumer) {
  if (!pool) return null;
  const c = normalizeKey(consumer);
  if (!c) return null;
  const row = await pool
    .query(
      `
      select consumer, last_event_id, updated_at
      from erp_event_consumer_offset
      where consumer = $1
      limit 1;
      `,
      [c],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!row) return { consumer: c, lastEventId: null, updatedAt: null };
  return { consumer: row.consumer, lastEventId: row.last_event_id || null, updatedAt: new Date(row.updated_at).toISOString() };
}

async function setErpConsumerOffset({ consumer, lastEventId }) {
  if (!pool) return { ok: false, error: "db_required" };
  const c = normalizeKey(consumer);
  const id = normalizeString(lastEventId);
  if (!c) return { ok: false, error: "consumer_required" };
  if (!id) return { ok: false, error: "lastEventId_required" };
  const exists = await pool.query(`select 1 from erp_event where id = $1;`, [id]).then((r) => (r.rows[0] ? true : false)).catch(() => false);
  if (!exists) return { ok: false, error: "event_not_found" };
  await pool
    .query(
      `
      insert into erp_event_consumer_offset (consumer, last_event_id, updated_at)
      values ($1, $2, now())
      on conflict (consumer) do update
        set last_event_id = excluded.last_event_id,
            updated_at = excluded.updated_at;
      `,
      [c, id],
    )
    .catch(() => {});
  return { ok: true, consumer: c, lastEventId: id };
}

async function recordErpConsumerDelivery({ consumer, eventId, status, errorCode = null, errorMessage = null, meta = {} }) {
  if (!pool) return { ok: false, error: "db_required" };
  const c = normalizeKey(consumer);
  const eid = normalizeString(eventId);
  const st = normalizeKey(status);
  if (!c) return { ok: false, error: "consumer_required" };
  if (!eid) return { ok: false, error: "eventId_required" };
  if (!["delivered", "failed", "ignored"].includes(st)) return { ok: false, error: "status_invalid" };
  const nextAttempt = await pool
    .query(`select coalesce(max(attempt_no), 0)::int + 1 as n from erp_event_delivery where consumer = $1 and event_id = $2;`, [c, eid])
    .then((r) => Number(r.rows[0]?.n) || 1)
    .catch(() => 1);
  const id = `evd_${crypto.randomUUID().slice(0, 18)}`;
  const processedAt = new Date().toISOString();
  await pool.query(
    `
    insert into erp_event_delivery
      (id, consumer, event_id, status, attempt_no, processed_at, error_code, error_message, meta)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb);
    `,
    [id, c, eid, st, nextAttempt, processedAt, normalizeKey(errorCode) || null, errorMessage ? String(errorMessage).slice(0, 2000) : null, JSON.stringify(meta && typeof meta === "object" ? meta : {})],
  );
  return { ok: true, id, consumer: c, eventId: eid, status: st, attemptNo: nextAttempt, processedAt };
}

async function listErpConsumerDeliveries({ consumer = null, eventId = null, limit = 100 } = {}) {
  if (!pool) return [];
  const c = normalizeKey(consumer || "");
  const eid = normalizeString(eventId) || null;
  const n = Math.max(1, Math.min(1000, Number(limit) || 100));
  const rows = await pool
    .query(
      `
      select id, consumer, event_id, status, attempt_no, processed_at, error_code, error_message, meta
      from erp_event_delivery
      where ($1::text = '' or consumer = $1)
        and ($2::text is null or event_id = $2)
      order by processed_at desc, attempt_no desc
      limit $3;
      `,
      [c, eid, n],
    )
    .then((r) => r.rows)
    .catch(() => []);
  return rows.map((r) => ({
    id: r.id,
    consumer: r.consumer,
    eventId: r.event_id,
    status: r.status,
    attemptNo: Number(r.attempt_no) || 0,
    processedAt: new Date(r.processed_at).toISOString(),
    errorCode: r.error_code || null,
    errorMessage: r.error_message || null,
    meta: r.meta || {},
  }));
}

async function consumeErpEvents({ consumer, afterId = null, limit = 200, types = null, aggregateType = null, aggregateId = null } = {}) {
  const c = normalizeKey(consumer || "");
  if (!c) return { ok: false, error: "consumer_required" };
  const stored = await getErpConsumerOffset(c);
  const startAfterId = normalizeString(afterId) || stored?.lastEventId || null;
  const items = await listErpEvents({ afterId: startAfterId, limit, types, aggregateType, aggregateId });
  return {
    ok: true,
    consumer: c,
    fromOffset: stored?.lastEventId || null,
    items,
    nextAfterId: items.length ? items[items.length - 1].id : startAfterId,
  };
}

async function getActiveOverridesForUser(username, at = new Date()) {
  if (!pool) return [];
  if (!username) return [];
  const rows = await pool
    .query(
      `
      select id, block_id, username, override_reason, expires_at, created_at
      from fleet_override
      where username = $1
        and (expires_at is null or expires_at > $2)
      order by created_at desc;
      `,
      [username, at.toISOString()],
    )
    .then((r) => r.rows);

  return rows.map((r) => ({
    id: r.id,
    blockId: r.block_id,
    username: r.username,
    overrideReason: r.override_reason,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

async function getDispatchOverride(vehicleId, moduleKey, windowStart, windowEnd, at = new Date()) {
  if (vehicleId && typeof vehicleId === "object" && !Array.isArray(vehicleId)) {
    const o = vehicleId;
    return await getDispatchOverride(o.vehicleId, o.moduleKey, o.windowStart, o.windowEnd, o.at || new Date());
  }
  if (!pool) return null;
  if (!(windowStart instanceof Date) || Number.isNaN(windowStart.valueOf())) return null;
  if (!(windowEnd instanceof Date) || Number.isNaN(windowEnd.valueOf())) return null;
  const rows = await pool
    .query(
      `
      select
        id,
        vehicle_id,
        module,
        window_start,
        window_end,
        decision,
        reason,
        username,
        expires_at,
        created_at
      from fleet_dispatch_override
      where vehicle_id = $1
        and module = $2
        and window_start < $4
        and window_end > $3
        and (expires_at is null or expires_at > $5)
      order by created_at desc
      limit 1;
      `,
      [vehicleId, moduleKey, windowStart.toISOString(), windowEnd.toISOString(), at.toISOString()],
    )
    .then((r) => r.rows);

  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    module: r.module,
    windowStart: new Date(r.window_start).toISOString(),
    windowEnd: new Date(r.window_end).toISOString(),
    decision: r.decision,
    reason: r.reason,
    username: r.username,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function overlapsWindow(startsAt, endsAt, windowStart, windowEnd) {
  const s = new Date(startsAt);
  const e = endsAt ? new Date(endsAt) : null;
  if (Number.isNaN(s.valueOf())) return false;
  const ws = windowStart instanceof Date ? windowStart : new Date(windowStart);
  const we = windowEnd instanceof Date ? windowEnd : new Date(windowEnd);
  if (Number.isNaN(ws.valueOf()) || Number.isNaN(we.valueOf())) return false;
  if (s >= we) return false;
  if (e && e <= ws) return false;
  return true;
}

async function getBlocksOverlappingWindow(vehicleId, windowStart, windowEnd) {
  const blocks = await getAvailabilityBlocks({ activeOnly: false });
  return blocks.filter((b) => b.vehicleId === vehicleId && overlapsWindow(b.startsAt, b.endsAt, windowStart, windowEnd));
}

function toBool(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function computePriorityScore({ priorityUrgency, priorityValue, priorityCustomerTier }) {
  const urgency = String(priorityUrgency || "").toLowerCase();
  const tier = String(priorityCustomerTier || "").toUpperCase();
  const valueRaw = priorityValue === null || priorityValue === undefined || priorityValue === "" ? null : Number(priorityValue);
  const value = valueRaw !== null && Number.isFinite(valueRaw) ? valueRaw : null;

  const urgencyScore = urgency === "critical" ? 60 : urgency === "high" ? 40 : urgency === "normal" ? 20 : urgency === "low" ? 0 : 10;
  const tierScore = tier === "A" ? 30 : tier === "B" ? 15 : tier === "C" ? 0 : 5;
  const valueScore = value === null ? 0 : Math.max(0, Math.min(30, Math.round(Math.log10(1 + value) * 10)));

  return Math.max(0, Math.min(100, urgencyScore + tierScore + valueScore));
}

async function getDepots({ candidates = null } = {}) {
  if (!pool) return [];
  const codes = Array.isArray(candidates) && candidates.length ? candidates : null;
  const rows = codes
    ? await pool
        .query(
          `select code, name, lat, lon, utilization, updated_at from fleet_depot where code = any($1::text[]) order by code asc;`,
          [codes],
        )
        .then((r) => r.rows)
    : await pool.query(`select code, name, lat, lon, utilization, updated_at from fleet_depot order by code asc;`).then((r) => r.rows);

  return rows.map((r) => ({
    code: r.code,
    name: r.name || null,
    lat: typeof r.lat === "number" ? r.lat : r.lat === null ? null : Number(r.lat),
    lon: typeof r.lon === "number" ? r.lon : r.lon === null ? null : Number(r.lon),
    utilization: typeof r.utilization === "number" ? r.utilization : Number(r.utilization),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

async function getAssignmentsOverlappingWindow({ vehicleId = null, driverId = null, windowStart, windowEnd }) {
  if (!pool) return [];
  if (!vehicleId && !driverId) return [];

  const clauses = [];
  const params = [windowStart.toISOString(), windowEnd.toISOString()];
  if (vehicleId) {
    params.push(vehicleId);
    clauses.push(`vehicle_id = $${params.length}`);
  }
  if (driverId) {
    params.push(driverId);
    clauses.push(`driver_id = $${params.length}`);
  }
  const where = clauses.length ? `(${clauses.join(" or ")}) and ` : "";

  const rows = await pool
    .query(
      `
      select id, vehicle_id, driver_id, module, window_start, window_end, order_id, route_id, priority_score, created_at
      from fleet_dispatch_assignment
      where ${where} window_start < $2 and window_end > $1
      order by window_start asc;
      `,
      params,
    )
    .then((r) => r.rows);

  return rows.map((r) => ({
    id: r.id,
    vehicleId: r.vehicle_id,
    driverId: r.driver_id || null,
    module: r.module,
    windowStart: new Date(r.window_start).toISOString(),
    windowEnd: new Date(r.window_end).toISOString(),
    orderId: r.order_id || null,
    routeId: r.route_id || null,
    priorityScore: Number(r.priority_score),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

function stripHtmlToText(html) {
  const withoutScripts = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withNewlines = withoutScripts
    .replace(/<\/(p|div|br|li|h1|h2|h3|h4|h5|h6|tr|td)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return withNewlines
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseNumberDe(value) {
  const v = String(value || "").trim().replace(/\./g, "").replace(",", ".");
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function slugifyKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function extractContainerCatalogFromText(text, sourceUrl) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

  const containers = [];
  let groupKey = null;
  let current = null;

  function flush() {
    if (!current) return;
    const variant = current.variantLines.join(" ").trim();
    const sourceKey = `${groupKey || "unknown"}:${current.volumeCbm}:${slugifyKey(variant || "standard")}`;
    containers.push({
      sourceKey,
      groupKey: groupKey || "unknown",
      volumeCbm: current.volumeCbm,
      variant,
      lengthM: current.lengthM,
      widthM: current.widthM,
      heightM: current.heightM,
      footprintSqm: current.footprintSqm,
      sourceUrl,
    });
    current = null;
  }

  for (const line of lines) {
    const groupMatch = line.match(/^(absetzcontainer|abrollcontainer|umleerbehälter|säcke)\b/i);
    if (groupMatch) {
      flush();
      groupKey = groupMatch[1].toLowerCase().replace("ä", "ae");
      continue;
    }

    const volMatch = line.match(/^(\d+(?:[.,]\d+)?)\s*cbm\b(.*)$/i);
    if (volMatch) {
      flush();
      const vol = parseNumberDe(volMatch[1]);
      if (vol === null) continue;
      current = {
        volumeCbm: vol,
        variantLines: [normalizeString(volMatch[2])].filter(Boolean),
        lengthM: null,
        widthM: null,
        heightM: null,
        footprintSqm: null,
      };
      continue;
    }

    if (!current) continue;

    const sizeMatch = line.match(/größe:\s*ca\.\s*l\s*([\d.,]+)\s*x\s*b\s*([\d.,]+)\s*x\s*h\s*([\d.,]+)\s*m/i);
    if (sizeMatch) {
      current.lengthM = parseNumberDe(sizeMatch[1]);
      current.widthM = parseNumberDe(sizeMatch[2]);
      current.heightM = parseNumberDe(sizeMatch[3]);
      const areaInLine = line.match(/standfläche:\s*ca\.\s*([\d.,]+)\s*qm/i);
      if (areaInLine) current.footprintSqm = parseNumberDe(areaInLine[1]);
      continue;
    }

    const areaMatch = line.match(/standfläche:\s*ca\.\s*([\d.,]+)\s*qm/i);
    if (areaMatch) {
      current.footprintSqm = parseNumberDe(areaMatch[1]);
      continue;
    }

    if (!line.toLowerCase().startsWith("standfläche:") && !line.toLowerCase().startsWith("größe:")) {
      if (current.variantLines.length < 8) current.variantLines.push(line);
    }
  }

  flush();
  return containers;
}

function extractDerSackZipCodesFromText(text, sourceUrl) {
  const raw = String(text || "");
  const sectionMatch = raw.match(/in welchen postleitzahlengebieten wird der sack[\s\S]*?(?:\n|\r)([\s\S]*?)(?:darf der sack|$)/i);
  const windowText = sectionMatch ? sectionMatch[1] : raw;
  const zips = Array.from(new Set((windowText.match(/\b\d{5}\b/g) || []).sort()));
  return zips.map((zip) => ({ service: "der_sack", zip, sourceUrl }));
}

function diffByKey({ webItems, erpItems, keyFn, compareFn }) {
  const webMap = new Map(webItems.map((x) => [keyFn(x), x]));
  const erpMap = new Map(erpItems.map((x) => [keyFn(x), x]));
  const keys = new Set([...webMap.keys(), ...erpMap.keys()]);
  const missingInErp = [];
  const extraInErp = [];
  const mismatched = [];
  for (const k of keys) {
    const w = webMap.get(k) || null;
    const e = erpMap.get(k) || null;
    if (w && !e) missingInErp.push({ key: k, web: w });
    else if (!w && e) extraInErp.push({ key: k, erp: e });
    else if (w && e) {
      const diff = compareFn(w, e);
      if (diff) mismatched.push({ key: k, diff, web: w, erp: e });
    }
  }
  return { missingInErp, extraInErp, mismatched };
}

async function getErpCatalogContainers() {
  if (!pool) return [];
  const rows = await pool
    .query(
      `
      select source_key, group_key, volume_cbm, variant, length_m, width_m, height_m, footprint_sqm, base_area_sqm, features, rules, active, source_url, source_hash, first_seen, last_seen
      from catalog_container
      order by group_key asc, volume_cbm asc, variant asc;
      `,
    )
    .then((r) => r.rows);
  return rows.map((r) => ({
    sourceKey: r.source_key,
    groupKey: r.group_key,
    volumeCbm: Number(r.volume_cbm),
    variant: r.variant,
    lengthM: r.length_m === null ? null : Number(r.length_m),
    widthM: r.width_m === null ? null : Number(r.width_m),
    heightM: r.height_m === null ? null : Number(r.height_m),
    footprintSqm: r.footprint_sqm === null ? null : Number(r.footprint_sqm),
    baseAreaSqm: r.base_area_sqm === null ? null : Number(r.base_area_sqm),
    features: r.features || {},
    rules: r.rules || {},
    active: Boolean(r.active),
    sourceUrl: r.source_url,
    sourceHash: r.source_hash,
    firstSeen: new Date(r.first_seen).toISOString(),
    lastSeen: new Date(r.last_seen).toISOString(),
  }));
}

async function getErpServiceAreaZips(service) {
  if (!pool) return [];
  const rows = await pool
    .query(
      `
      select service, zip, active, source_url, source_hash, first_seen, last_seen
      from catalog_service_area_zip
      where service = $1
      order by zip asc;
      `,
      [service],
    )
    .then((r) => r.rows);
  return rows.map((r) => ({
    service: r.service,
    zip: r.zip,
    active: Boolean(r.active),
    sourceUrl: r.source_url,
    sourceHash: r.source_hash,
    firstSeen: new Date(r.first_seen).toISOString(),
    lastSeen: new Date(r.last_seen).toISOString(),
  }));
}

function stableHash(input) {
  return crypto.createHash("sha256").update(String(input || ""), "utf8").digest("hex").slice(0, 24);
}

function deriveContainerFeaturesAndRules(variantText) {
  const t = String(variantText || "").toLowerCase();
  const features = {
    lid: t.includes("deckel"),
    doorsWing: t.includes("flügeltüren") || t.includes("fluegeltueren"),
    flap: t.includes("klappe"),
    press: t.includes("pressen"),
    walkable: t.includes("begeh"),
    wheelbarrow: t.includes("schubkarre") || t.includes("befahr"),
    businessOnly: t.includes("nur für gewerbe") || t.includes("nur fuer gewerbe"),
  };
  const rules = {};
  if (features.businessOnly) rules.customerSegment = "business";
  return { features, rules };
}

function computeBaseAreaSqm({ lengthM, widthM }) {
  if (typeof lengthM !== "number" || typeof widthM !== "number") return null;
  if (!Number.isFinite(lengthM) || !Number.isFinite(widthM)) return null;
  return Number((lengthM * widthM).toFixed(2));
}

async function upsertWorkItem({ kind, itemKey, priority, title, details, sourceRunId }) {
  if (!pool) return;
  const id = `wi_${crypto.randomUUID().slice(0, 12)}`;
  try {
    await pool.query(
      `
      insert into work_item (id, kind, item_key, priority, status, title, details, source_run_id, created_at)
      values ($1, $2, $3, $4, 'open', $5, $6, $7, now())
      on conflict (kind, item_key) do update
        set priority = excluded.priority,
            status = 'open',
            title = excluded.title,
            details = excluded.details,
            source_run_id = excluded.source_run_id,
            closed_at = null,
            closed_by = null,
            closed_reason = null;
      `,
      [id, kind, itemKey, priority, title, details || {}, sourceRunId || null],
    );
  } catch {
    return;
  }
}

async function closeWorkItem({ id, closedBy, closedReason }) {
  if (!pool) return false;
  const rows = await pool
    .query(
      `
      update work_item
      set status = 'closed', closed_at = now(), closed_by = $2, closed_reason = $3
      where id = $1 and status = 'open'
      returning id;
      `,
      [id, closedBy, closedReason],
    )
    .then((r) => r.rows);
  return Boolean(rows[0]);
}

async function listWorkItems({ status = "open", limit = 50 } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const st = status === "closed" ? "closed" : "open";
  const rows = await pool
    .query(
      `
      select id, kind, item_key, priority, status, title, details, source_run_id, created_at, closed_at, closed_by, closed_reason
      from work_item
      where status = $1
      order by
        case priority when 'high' then 0 when 'medium' then 1 else 2 end,
        created_at desc
      limit $2;
      `,
      [st, n],
    )
    .then((r) => r.rows);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    itemKey: r.item_key,
    priority: r.priority,
    status: r.status,
    title: r.title,
    details: r.details || {},
    sourceRunId: r.source_run_id,
    createdAt: new Date(r.created_at).toISOString(),
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    closedBy: r.closed_by || null,
    closedReason: r.closed_reason || null,
  }));
}

const WasteOrderStatuses = [
  "created",
  "validated",
  "dispatch_checked",
  "scheduled",
  "delivered",
  "pickup_requested",
  "picked_up",
  "weighed",
  "invoiced",
  "closed",
  "cancelled",
];

const WasteOrderTransitions = {
  created: ["validated", "cancelled"],
  validated: ["dispatch_checked", "cancelled"],
  dispatch_checked: ["scheduled", "cancelled"],
  scheduled: ["delivered", "cancelled"],
  delivered: ["pickup_requested", "cancelled"],
  pickup_requested: ["picked_up", "cancelled"],
  picked_up: ["weighed", "cancelled"],
  weighed: ["invoiced", "cancelled"],
  invoiced: ["closed", "cancelled"],
  closed: [],
  cancelled: [],
};

function isAllowedWasteTransition(fromStatus, toStatus) {
  if (!WasteOrderStatuses.includes(String(toStatus || ""))) return false;
  const allowed = WasteOrderTransitions[String(fromStatus || "")] || [];
  return allowed.includes(String(toStatus || ""));
}

async function getCatalogContainerBySourceKey(sourceKey) {
  if (!pool) return null;
  const rows = await pool
    .query(
      `
      select source_key, group_key, volume_cbm, variant, length_m, width_m, height_m, footprint_sqm, base_area_sqm, features, rules, active
      from catalog_container
      where source_key = $1
      limit 1;
      `,
      [sourceKey],
    )
    .then((r) => r.rows);
  const r = rows[0] || null;
  if (!r) return null;
  return {
    sourceKey: r.source_key,
    groupKey: r.group_key,
    volumeCbm: Number(r.volume_cbm),
    variant: r.variant,
    lengthM: r.length_m === null ? null : Number(r.length_m),
    widthM: r.width_m === null ? null : Number(r.width_m),
    heightM: r.height_m === null ? null : Number(r.height_m),
    footprintSqm: r.footprint_sqm === null ? null : Number(r.footprint_sqm),
    baseAreaSqm: r.base_area_sqm === null ? null : Number(r.base_area_sqm),
    features: r.features || {},
    rules: r.rules || {},
    active: Boolean(r.active),
  };
}

async function getWasteOrderById(id) {
  if (!pool) return null;
  const rows = await pool
    .query(
      `
      select
        id, customer_id, customer_ref_id, contract_id, customer_tier, site, container_source_key, service_type,
        window_deliver_start, window_deliver_end, window_pickup_start, window_pickup_end,
        context, status, priority_urgency, priority_value, notes,
        municipality_id, disposal_site_id, material_code, planned_tons, planned_volume_cbm, legal,
        created_by, created_at, updated_at
      from waste_container_order
      where id = $1
      limit 1;
      `,
      [id],
    )
    .then((r) => r.rows);
  const r = rows[0] || null;
  if (!r) return null;
  return {
    id: r.id,
    customerId: r.customer_id || null,
    customerRefId: r.customer_ref_id || null,
    contractId: r.contract_id || null,
    customerTier: r.customer_tier || null,
    site: r.site || {},
    containerSourceKey: r.container_source_key,
    serviceType: r.service_type,
    windowDeliverStart: new Date(r.window_deliver_start).toISOString(),
    windowDeliverEnd: new Date(r.window_deliver_end).toISOString(),
    windowPickupStart: r.window_pickup_start ? new Date(r.window_pickup_start).toISOString() : null,
    windowPickupEnd: r.window_pickup_end ? new Date(r.window_pickup_end).toISOString() : null,
    context: r.context || {},
    status: r.status,
    priorityUrgency: r.priority_urgency,
    priorityValue: r.priority_value === null ? null : Number(r.priority_value),
    notes: r.notes || null,
    municipalityId: r.municipality_id || null,
    disposalSiteId: r.disposal_site_id || null,
    materialCode: r.material_code || null,
    plannedTons: r.planned_tons === null ? null : Number(r.planned_tons),
    plannedVolumeCbm: r.planned_volume_cbm === null ? null : Number(r.planned_volume_cbm),
    legal: r.legal || {},
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

async function listWasteOrders({ status = null, limit = 50 } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const st = status && WasteOrderStatuses.includes(status) ? status : null;
  const rows = await pool
    .query(
      st
        ? `
          select id from waste_container_order
          where status = $1
          order by created_at desc
          limit $2;
        `
        : `
          select id from waste_container_order
          order by created_at desc
          limit $1;
        `,
      st ? [st, n] : [n],
    )
    .then((r) => r.rows);
  const ids = rows.map((r) => r.id);
  const out = [];
  for (const id of ids) {
    const o = await getWasteOrderById(id);
    if (o) out.push(o);
  }
  return out;
}

async function appendWasteOrderEvent({ orderId, fromStatus, toStatus, reason, username, occurredAt, meta }) {
  if (!pool) return;
  const id = `woe_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into waste_container_order_event
      (id, order_id, from_status, to_status, reason, username, occurred_at, meta)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8);
    `,
    [id, orderId, fromStatus || null, toStatus, reason, username, occurredAt, meta || {}],
  );
}

async function updateWasteOrderStatus({ orderId, toStatus, reason, username, meta }) {
  if (!pool) return { ok: false, error: "db_required" };
  const current = await getWasteOrderById(orderId);
  if (!current) return { ok: false, error: "order_not_found" };
  if (!isAllowedWasteTransition(current.status, toStatus)) return { ok: false, error: "invalid_status_transition", fromStatus: current.status };
  const occurredAt = new Date().toISOString();
  await pool.query(`update waste_container_order set status = $2, updated_at = now() where id = $1;`, [orderId, toStatus]);
  await appendWasteOrderEvent({ orderId, fromStatus: current.status, toStatus, reason, username, occurredAt, meta });
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WASTE_ORDER_STATUS_CHANGED",
    username,
    occurredAt,
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: orderId,
    overrideReason: reason,
    meta: { fromStatus: current.status, toStatus, ...(meta || {}) },
  });
  await publishErpEvent({
    eventType: "WASTE_ORDER_STATUS_CHANGED",
    aggregateType: "waste_order",
    aggregateId: orderId,
    occurredAt,
    createdBy: username,
    payload: { fromStatus: current.status, toStatus, reason: reason || null, meta: meta || {} },
  });
  const updated = await getWasteOrderById(orderId);
  return { ok: true, order: updated };
}

async function createWasteOrder({ body, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const containerSourceKey = normalizeString(body.containerSourceKey);
  if (!containerSourceKey) return { ok: false, error: "containerSourceKey_required" };
  const container = await getCatalogContainerBySourceKey(containerSourceKey);
  if (!container || !container.active) return { ok: false, error: "container_not_found_or_inactive" };

  const serviceType = normalizeString(body.serviceType) || "deliver_pickup";
  if (serviceType !== "deliver_pickup") return { ok: false, error: "invalid_serviceType" };

  const deliverStart = parseIsoDate(body.windowDeliverStart);
  const deliverEnd = parseIsoDate(body.windowDeliverEnd);
  if (!deliverStart) return { ok: false, error: "invalid_windowDeliverStart" };
  if (!deliverEnd) return { ok: false, error: "invalid_windowDeliverEnd" };
  if (deliverEnd <= deliverStart) return { ok: false, error: "windowDeliverEnd_must_be_after_windowDeliverStart" };

  const pickupStart = body.windowPickupStart ? parseIsoDate(body.windowPickupStart) : null;
  const pickupEnd = body.windowPickupEnd ? parseIsoDate(body.windowPickupEnd) : null;
  if ((body.windowPickupStart && !pickupStart) || (body.windowPickupEnd && !pickupEnd)) return { ok: false, error: "invalid_pickup_window" };
  if ((pickupStart && !pickupEnd) || (!pickupStart && pickupEnd)) return { ok: false, error: "pickup_window_incomplete" };
  if (pickupStart && pickupEnd && pickupEnd <= pickupStart) return { ok: false, error: "windowPickupEnd_must_be_after_windowPickupStart" };

  const site = body.site && typeof body.site === "object" ? body.site : {};
  const context = body.context && typeof body.context === "object" ? body.context : {};
  const customerId = normalizeString(body.customerId) || null;
  const contractId = normalizeString(body.contractId) || null;
  const municipalityId = normalizeString(body.municipalityId) || null;
  const disposalSiteId = normalizeString(body.disposalSiteId) || null;
  const materialCode = normalizeString(body.materialCode) || null;
  const plannedTons = body.plannedTons === null || body.plannedTons === undefined || body.plannedTons === "" ? null : Number(body.plannedTons);
  const plannedVolumeCbm = body.plannedVolumeCbm === null || body.plannedVolumeCbm === undefined || body.plannedVolumeCbm === "" ? null : Number(body.plannedVolumeCbm);
  if (plannedTons !== null && !Number.isFinite(plannedTons)) return { ok: false, error: "invalid_plannedTons" };
  if (plannedTons !== null && plannedTons < 0) return { ok: false, error: "invalid_plannedTons" };
  if (plannedVolumeCbm !== null && !Number.isFinite(plannedVolumeCbm)) return { ok: false, error: "invalid_plannedVolumeCbm" };
  if (plannedVolumeCbm !== null && plannedVolumeCbm < 0) return { ok: false, error: "invalid_plannedVolumeCbm" };

  let customerRefId = null;
  if (customerId) {
    const c = await pool
      .query(
        `
        select id
        from crm_customer
        where id = $1 or customer_no = $1
        limit 1;
        `,
        [customerId],
      )
      .then((r) => r.rows[0] || null);
    if (!c) return { ok: false, error: "customer_not_found" };
    customerRefId = c.id;
  }

  if (contractId) {
    const ok = await pool
      .query(
        `
        select id
        from crm_contract
        where id = $1
        limit 1;
        `,
        [contractId],
      )
      .then((r) => r.rows[0] || null);
    if (!ok) return { ok: false, error: "contract_not_found" };
  }

  if (municipalityId) {
    const ok = await pool
      .query(
        `
        select id
        from waste_municipality
        where id = $1 or code = $1
        limit 1;
        `,
        [municipalityId],
      )
      .then((r) => r.rows[0] || null);
    if (!ok) return { ok: false, error: "municipality_not_found" };
  }

  if (disposalSiteId) {
    const ok = await pool
      .query(
        `
        select id
        from waste_disposal_site
        where id = $1 or code = $1
        limit 1;
        `,
        [disposalSiteId],
      )
      .then((r) => r.rows[0] || null);
    if (!ok) return { ok: false, error: "disposal_site_not_found" };
  }

  if (materialCode) {
    const ok = await pool
      .query(
        `
        select id
        from item_material
        where code = $1
        limit 1;
        `,
        [materialCode],
      )
      .then((r) => r.rows[0] || null);
    if (!ok) return { ok: false, error: "material_not_found" };
  }
  const customerTier = normalizeString(body.customerTier) || null;
  const priorityUrgency = normalizeString(body.priorityUrgency) || "normal";
  if (!["low", "normal", "high", "critical"].includes(priorityUrgency)) return { ok: false, error: "invalid_priorityUrgency" };
  const priorityValue = body.priorityValue === null || body.priorityValue === undefined || body.priorityValue === "" ? null : Number(body.priorityValue);
  if (priorityValue !== null && !Number.isFinite(priorityValue)) return { ok: false, error: "invalid_priorityValue" };
  const notes = normalizeString(body.notes) || null;
  const legal = body.legal && typeof body.legal === "object" ? body.legal : {};

  const id = `ord_${crypto.randomUUID().slice(0, 12)}`;
  const nowIso = new Date().toISOString();
  await pool.query(
    `
    insert into waste_container_order
      (id, customer_id, customer_ref_id, contract_id, customer_tier, site, container_source_key, service_type,
       window_deliver_start, window_deliver_end, window_pickup_start, window_pickup_end,
       context, status, priority_urgency, priority_value, notes,
       municipality_id, disposal_site_id, material_code, planned_tons, planned_volume_cbm, legal,
       created_by, created_at, updated_at)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'created', $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $24, $25);
    `,
    [
      id,
      customerId,
      customerRefId,
      contractId,
      customerTier,
      site,
      containerSourceKey,
      serviceType,
      deliverStart.toISOString(),
      deliverEnd.toISOString(),
      pickupStart ? pickupStart.toISOString() : null,
      pickupEnd ? pickupEnd.toISOString() : null,
      context,
      priorityUrgency,
      priorityValue,
      notes,
      municipalityId,
      disposalSiteId,
      materialCode,
      plannedTons,
      plannedVolumeCbm,
      JSON.stringify(legal || {}),
      username,
      nowIso,
      nowIso,
    ],
  );
  await appendWasteOrderEvent({ orderId: id, fromStatus: null, toStatus: "created", reason: "created", username, occurredAt: nowIso, meta: { containerSourceKey } });
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WASTE_ORDER_CREATED",
    username,
    occurredAt: nowIso,
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: { containerSourceKey, serviceType, windowDeliverStart: deliverStart.toISOString(), windowDeliverEnd: deliverEnd.toISOString() },
  });
  await publishErpEvent({
    eventType: "WASTE_ORDER_CREATED",
    aggregateType: "waste_order",
    aggregateId: id,
    occurredAt: nowIso,
    createdBy: username,
    payload: {
      id,
      customerId: customerRefId || null,
      contractId: contractId || null,
      municipalityId: municipalityId || null,
      disposalSiteId: disposalSiteId || null,
      serviceType,
      materialCode: materialCode || null,
      windowDeliverStart: deliverStart.toISOString(),
      windowDeliverEnd: deliverEnd.toISOString(),
    },
  });
  const order = await getWasteOrderById(id);
  return { ok: true, order };
}

function buildWasteDispatchContext({ order, container, body }) {
  const ctx = order.context && typeof order.context === "object" ? order.context : {};
  const site = order.site && typeof order.site === "object" ? order.site : {};
  const siteDepot = normalizeString(body.siteDepot) || normalizeString(site.depot) || null;
  const driverId = normalizeString(body.driverId) || normalizeString(ctx.driverId) || null;
  const weighRequired = body.weighRequired === true || normalizeString(ctx.weighRequired) === "true";
  const tankRequired = body.tankRequired === true || normalizeString(ctx.tankRequired) === "true";
  const siteLat = body.siteLat === null || body.siteLat === undefined || body.siteLat === "" ? site.lat : body.siteLat;
  const siteLon = body.siteLon === null || body.siteLon === undefined || body.siteLon === "" ? site.lon : body.siteLon;
  const maxDistanceKm = body.maxDistanceKm === null || body.maxDistanceKm === undefined || body.maxDistanceKm === "" ? ctx.maxDistanceKm : body.maxDistanceKm;
  const containerSize = normalizeString(body.containerSize) || normalizeString(ctx.containerSize) || null;
  const containerType = normalizeString(body.containerType) || normalizeString(ctx.containerType) || null;
  const grapplerType = normalizeString(body.grapplerType) || normalizeString(ctx.grapplerType) || null;
  const adrClass = normalizeString(body.adrClass) || normalizeString(ctx.adrClass) || null;
  const priorityUrgency = normalizeString(order.priorityUrgency) || "normal";
  const priorityValue = order.priorityValue;
  const priorityCustomerTier = normalizeString(order.customerTier) || null;
  const priorityScore = computePriorityScore({ priorityUrgency, priorityValue, priorityCustomerTier });
  return {
    siteDepot,
    driverId,
    weighRequired,
    tankRequired,
    siteLat: siteLat === null || siteLat === undefined || siteLat === "" ? null : Number(siteLat),
    siteLon: siteLon === null || siteLon === undefined || siteLon === "" ? null : Number(siteLon),
    maxDistanceKm: maxDistanceKm === null || maxDistanceKm === undefined || maxDistanceKm === "" ? null : Number(maxDistanceKm),
    containerSize,
    containerType,
    grapplerType,
    adrClass,
    priorityScore,
    containerCatalog: {
      sourceKey: container.sourceKey,
      groupKey: container.groupKey,
      volumeCbm: container.volumeCbm,
      variant: container.variant,
      features: container.features,
      rules: container.rules,
    },
  };
}

async function wasteDispatchDecisionForOrder({ order, vehicleId, moduleKey, windowStart, windowEnd, context }) {
  const v = await getVehicleById(vehicleId);
  if (!v) return { ok: false, error: "vehicle_not_found" };
  const d = await evaluateDispatchDecision({ vehicle: v, moduleKey, windowStart, windowEnd, context });
  const override = await getDispatchOverride(vehicleId, moduleKey, windowStart, windowEnd, new Date());
  const effective = override ? override.decision : d.baseDecision;
  const reasonCode = override ? "manual_override" : d.reasonCode;
  return { ok: true, decision: { ...d, decision: effective, baseDecision: d.baseDecision, reasonCode }, override };
}

async function createWasteDispatchCheck({ orderId, vehicleId, moduleKey, windowStart, windowEnd, decision, username }) {
  if (!pool) return null;
  const id = `wdc_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = new Date().toISOString();
  await pool.query(
    `
    insert into waste_container_order_dispatch_check
      (id, order_id, vehicle_id, module, window_start, window_end, decision, username, created_at)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8, $9);
    `,
    [id, orderId, vehicleId, moduleKey, windowStart.toISOString(), windowEnd.toISOString(), decision, username, createdAt],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WASTE_ORDER_DISPATCH_CHECKED",
    username,
    occurredAt: createdAt,
    lockType: null,
    blockId: null,
    vehicleId,
    blockReason: null,
    overrideId: orderId,
    overrideReason: null,
    meta: { module: moduleKey, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), decision },
  });
  return { id, createdAt };
}

async function assignWasteOrder({ orderId, vehicleId, driverId, reason, username, routeId = null, assignmentWindowStart = null, assignmentWindowEnd = null }) {
  if (!pool) return { ok: false, error: "db_required" };
  const order = await getWasteOrderById(orderId);
  if (!order) return { ok: false, error: "order_not_found" };
  if (order.status !== "dispatch_checked") return { ok: false, error: "order_not_dispatch_checked" };

  const container = await getCatalogContainerBySourceKey(order.containerSourceKey);
  if (!container || !container.active) return { ok: false, error: "container_not_found_or_inactive" };

  const moduleKey = "waste";
  const windowStart = assignmentWindowStart ? parseIsoDate(assignmentWindowStart) : new Date(order.windowDeliverStart);
  const windowEnd = assignmentWindowEnd ? parseIsoDate(assignmentWindowEnd) : new Date(order.windowDeliverEnd);
  if (!windowStart) return { ok: false, error: "invalid_assignmentWindowStart" };
  if (!windowEnd) return { ok: false, error: "invalid_assignmentWindowEnd" };
  if (windowEnd <= windowStart) return { ok: false, error: "assignment_window_invalid" };
  const context = buildWasteDispatchContext({ order, container, body: { driverId } });

  const evalRes = await wasteDispatchDecisionForOrder({ order, vehicleId, moduleKey, windowStart, windowEnd, context });
  if (!evalRes.ok) return evalRes;
  if (evalRes.decision.decision !== "allow") {
    return { ok: false, error: "dispatch_denied", details: { baseDecision: evalRes.decision.baseDecision, decision: evalRes.decision.decision, reasonCode: evalRes.decision.reasonCode } };
  }

  const assignmentId = `asg_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = new Date().toISOString();
  await pool.query(
    `
    insert into fleet_dispatch_assignment
      (id, vehicle_id, driver_id, module, window_start, window_end, order_id, route_id, priority_score, created_at)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
    `,
    [
      assignmentId,
      vehicleId,
      driverId || null,
      moduleKey,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      orderId,
      routeId,
      evalRes.decision.criteria.priorityScore || 0,
      createdAt,
    ],
  );

  const id = `wod_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into waste_container_order_dispatch
      (id, order_id, vehicle_id, driver_id, module, window_start, window_end, decision_snapshot, reason, username, created_at)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
    `,
    [id, orderId, vehicleId, driverId || null, moduleKey, windowStart.toISOString(), windowEnd.toISOString(), evalRes.decision, reason, username, createdAt],
  );

  const moved = await updateWasteOrderStatus({
    orderId,
    toStatus: "scheduled",
    reason: reason || "scheduled",
    username,
    meta: { vehicleId, driverId: driverId || null, assignmentId, routeId: routeId || null, assignmentWindowStart: windowStart.toISOString(), assignmentWindowEnd: windowEnd.toISOString() },
  });
  if (!moved.ok) return moved;

  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WASTE_ORDER_SCHEDULED",
    username,
    occurredAt: createdAt,
    lockType: null,
    blockId: null,
    vehicleId,
    blockReason: null,
    overrideId: orderId,
    overrideReason: reason,
    meta: { assignmentId, vehicleId, driverId: driverId || null, routeId: routeId || null },
  });
  await publishErpEvent({
    eventType: "DISPATCH_ASSIGNMENT_CREATED",
    aggregateType: "waste_order",
    aggregateId: orderId,
    occurredAt: createdAt,
    createdBy: username,
    payload: { assignmentId, vehicleId, driverId: driverId || null, routeId: routeId || null, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
  });

  return { ok: true, order: moved.order, assignmentId };
}

async function createMockWeighTicket({ orderId, grossKg, tareKg, weighedAt, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const order = await getWasteOrderById(orderId);
  if (!order) return { ok: false, error: "order_not_found" };
  if (order.status !== "picked_up") return { ok: false, error: "order_not_picked_up" };

  const g = Number(grossKg);
  const t = Number(tareKg);
  if (!Number.isFinite(g) || !Number.isFinite(t)) return { ok: false, error: "invalid_weights" };
  const gross = Math.round(g);
  const tare = Math.round(t);
  if (gross <= 0 || tare < 0) return { ok: false, error: "invalid_weights" };
  const net = gross - tare;
  if (net < 0) return { ok: false, error: "net_must_be_non_negative" };

  const weighed = weighedAt ? parseIsoDate(weighedAt) : new Date();
  if (!weighed) return { ok: false, error: "invalid_weighedAt" };

  const id = `wt_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = new Date().toISOString();
  await pool.query(
    `
    insert into waste_weigh_ticket
      (id, order_id, gross_kg, tare_kg, net_kg, weighed_at, source, username, created_at)
    values
      ($1, $2, $3, $4, $5, $6, 'mock', $7, $8);
    `,
    [id, orderId, gross, tare, net, weighed.toISOString(), username, createdAt],
  );

  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WASTE_ORDER_WEIGHED",
    username,
    occurredAt: createdAt,
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: orderId,
    overrideReason: null,
    meta: { weighTicketId: id, grossKg: gross, tareKg: tare, netKg: net, weighedAt: weighed.toISOString(), source: "mock" },
  });
  await publishErpEvent({
    eventType: "WASTE_ORDER_WEIGHED",
    aggregateType: "waste_order",
    aggregateId: orderId,
    occurredAt: createdAt,
    createdBy: username,
    payload: { weighTicketId: id, grossKg: gross, tareKg: tare, netKg: net, weighedAt: weighed.toISOString(), source: "mock" },
  });

  const moved = await updateWasteOrderStatus({ orderId, toStatus: "weighed", reason: "mock_weigh", username, meta: { weighTicketId: id } });
  if (!moved.ok) return moved;
  return { ok: true, order: moved.order, weighTicketId: id, grossKg: gross, tareKg: tare, netKg: net, weighedAt: weighed.toISOString() };
}

async function createMockInvoiceDraft({ orderId, currency, lines, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const order = await getWasteOrderById(orderId);
  if (!order) return { ok: false, error: "order_not_found" };
  if (order.status !== "weighed") return { ok: false, error: "order_not_weighed" };

  const cur = normalizeString(currency) || "EUR";
  if (!/^[A-Z]{3}$/.test(cur)) return { ok: false, error: "invalid_currency" };

  const container = await getCatalogContainerBySourceKey(order.containerSourceKey);
  const baseLabel = container ? `${container.volumeCbm} cbm ${container.groupKey}` : "Containerdienst";

  const outLines = Array.isArray(lines) && lines.length
    ? lines.map((l) => ({
        label: normalizeString(l.label) || "Leistung",
        qty: Number.isFinite(Number(l.qty)) ? Number(l.qty) : 1,
        unitPriceCents: Number.isFinite(Number(l.unitPriceCents)) ? Math.round(Number(l.unitPriceCents)) : 0,
      }))
    : [{ label: baseLabel, qty: 1, unitPriceCents: 0 }];

  const totalCents = outLines.reduce((sum, l) => sum + Math.round(l.qty * l.unitPriceCents), 0);
  const id = `inv_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = new Date().toISOString();
  const linesJson = JSON.stringify(outLines);
  await pool.query(
    `
    insert into waste_invoice_draft
      (id, order_id, currency, total_cents, lines, source, username, created_at)
    values
      ($1, $2, $3, $4, $5::jsonb, 'mock', $6, $7);
    `,
    [id, orderId, cur, totalCents, linesJson, username, createdAt],
  );

  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WASTE_ORDER_INVOICED",
    username,
    occurredAt: createdAt,
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: orderId,
    overrideReason: null,
    meta: { invoiceDraftId: id, currency: cur, totalCents, lines: outLines, source: "mock" },
  });
  await publishErpEvent({
    eventType: "WASTE_INVOICE_DRAFT_CREATED",
    aggregateType: "waste_order",
    aggregateId: orderId,
    occurredAt: createdAt,
    createdBy: username,
    payload: { invoiceDraftId: id, currency: cur, totalCents, lineCount: outLines.length, source: "mock" },
  });

  const moved = await updateWasteOrderStatus({ orderId, toStatus: "invoiced", reason: "mock_invoice", username, meta: { invoiceDraftId: id } });
  if (!moved.ok) return moved;
  return { ok: true, order: moved.order, invoiceDraftId: id, currency: cur, totalCents, lines: outLines };
}

async function getLatestPricingCalculationForOrder(orderId) {
  if (!pool) return null;
  const oid = normalizeString(orderId);
  if (!oid) return null;
  const row = await pool
    .query(
      `
      select id
      from pricing_calculation
      where order_id = $1
      order by calculated_at desc
      limit 1;
      `,
      [oid],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!row) return null;
  return await getPricingCalculationById(row.id);
}

async function createInvoiceDraftFromPricing({ orderId, pricingCalculationId = null, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const order = await getWasteOrderById(orderId);
  if (!order) return { ok: false, error: "order_not_found" };
  if (order.status !== "weighed") return { ok: false, error: "order_not_weighed" };

  const calc = pricingCalculationId ? await getPricingCalculationById(pricingCalculationId) : await getLatestPricingCalculationForOrder(orderId);
  if (!calc) return { ok: false, error: "pricing_calculation_not_found" };
  if (calc.orderId !== order.id) return { ok: false, error: "pricing_calculation_order_mismatch" };

  const outputLines = Array.isArray(calc.output?.lines) ? calc.output.lines : [];
  if (!outputLines.length) return { ok: false, error: "pricing_calculation_has_no_lines" };

  const outLines = outputLines.map((l) => ({
    itemType: normalizeString(l.itemType) || null,
    refCode: normalizeString(l.refCode) || null,
    label: normalizeString(l.label) || "Leistung",
    unit: normalizeString(l.unit) || null,
    qty: Number.isFinite(Number(l.qty)) ? Number(l.qty) : 1,
    unitPriceCents: Number.isFinite(Number(l.unitPriceCents)) ? Math.round(Number(l.unitPriceCents)) : 0,
    totalCents: Number.isFinite(Number(l.totalCents)) ? Math.round(Number(l.totalCents)) : Math.round((Number(l.qty) || 1) * (Number(l.unitPriceCents) || 0)),
    source: l.source && typeof l.source === "object" ? l.source : {},
  }));
  const currency = normalizeString(calc.currency) || "EUR";
  const totalCents = outLines.reduce((sum, l) => sum + Math.round(Number(l.totalCents) || 0), 0);

  const id = `inv_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = new Date().toISOString();
  await pool.query(
    `
    insert into waste_invoice_draft
      (id, order_id, currency, total_cents, lines, source, username, created_at, pricing_calculation_id, customer_id, contract_id, meta)
    values
      ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb);
    `,
    [
      id,
      order.id,
      currency,
      totalCents,
      JSON.stringify(outLines),
      "pricing_v1",
      username,
      createdAt,
      calc.id,
      order.customerRefId || null,
      order.contractId || null,
      JSON.stringify({ pricing: { calculationId: calc.id, algorithmVersion: calc.algorithmVersion }, customerId: order.customerRefId || null, contractId: order.contractId || null }),
    ],
  );

  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WASTE_ORDER_INVOICED",
    username,
    occurredAt: createdAt,
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: order.id,
    overrideReason: null,
    meta: { invoiceDraftId: id, currency, totalCents, pricingCalculationId: calc.id, source: "pricing_v1" },
  });
  await publishErpEvent({
    eventType: "WASTE_INVOICE_DRAFT_CREATED",
    aggregateType: "waste_order",
    aggregateId: order.id,
    occurredAt: createdAt,
    createdBy: username,
    payload: { invoiceDraftId: id, currency, totalCents, pricingCalculationId: calc.id, source: "pricing_v1" },
  });

  const moved = await updateWasteOrderStatus({ orderId: order.id, toStatus: "invoiced", reason: "invoice_from_pricing", username, meta: { invoiceDraftId: id, pricingCalculationId: calc.id } });
  if (!moved.ok) return moved;
  return { ok: true, order: moved.order, invoiceDraftId: id, currency, totalCents, lines: outLines, pricingCalculationId: calc.id };
}

async function getWasteInvoiceDraftById(id) {
  if (!pool) return null;
  const v = normalizeString(id);
  if (!v) return null;
  const row = await pool
    .query(
      `
      select id, order_id, currency, total_cents, lines, source, username, created_at, pricing_calculation_id, customer_id, contract_id, meta
      from waste_invoice_draft
      where id = $1
      limit 1;
      `,
      [v],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    currency: row.currency,
    totalCents: Number(row.total_cents),
    lines: row.lines || [],
    source: row.source,
    username: row.username,
    createdAt: new Date(row.created_at).toISOString(),
    pricingCalculationId: row.pricing_calculation_id || null,
    customerId: row.customer_id || null,
    contractId: row.contract_id || null,
    meta: row.meta || {},
  };
}

async function listWasteInvoiceDrafts({ orderId = null, customerId = null, limit = 20 } = {}) {
  if (!pool) return [];
  const oid = normalizeString(orderId) || null;
  const cid = normalizeString(customerId) || null;
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  const rows = await pool
    .query(
      `
      select id, order_id, currency, total_cents, source, username, created_at, pricing_calculation_id, customer_id, contract_id
      from waste_invoice_draft
      where ($1::text is null or order_id = $1)
        and ($2::text is null or customer_id = $2)
      order by created_at desc
      limit $3;
      `,
      [oid, cid, n],
    )
    .then((r) => r.rows)
    .catch(() => []);
  return rows.map((r) => ({
    id: r.id,
    orderId: r.order_id,
    currency: r.currency,
    totalCents: Number(r.total_cents),
    source: r.source,
    username: r.username,
    createdAt: new Date(r.created_at).toISOString(),
    pricingCalculationId: r.pricing_calculation_id || null,
    customerId: r.customer_id || null,
    contractId: r.contract_id || null,
  }));
}

function dateToYmd(d) {
  return d instanceof Date && !Number.isNaN(d.valueOf()) ? d.toISOString().slice(0, 10) : null;
}

function parseYmd(value) {
  const v = normalizeString(value);
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = parseIsoDate(v);
  return d ? dateToYmd(d) : null;
}

function pgDateToYmd(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return dateToYmd(value);
  const s = typeof value === "string" ? value : String(value);
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  return parseYmd(trimmed);
}

function normalizeKey(value) {
  return normalizeString(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function rangesOverlap({ aFrom, aTo, bFrom, bTo }) {
  const aEnd = aTo === null ? "9999-12-31" : aTo;
  const bEnd = bTo === null ? "9999-12-31" : bTo;
  return aFrom <= bEnd && bFrom <= aEnd;
}

function couplinkConfigured() {
  return Boolean(couplinkToken && couplinkBaseUrl);
}

function osrmConfigured() {
  return Boolean(osrmBaseUrl);
}

async function couplinkFetchJson(pathname, { method = "GET", body = null } = {}) {
  if (!couplinkConfigured()) return { ok: false, error: "couplink_not_configured" };
  try {
    const res = await fetch(`${couplinkBaseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${couplinkToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) return { ok: false, error: "couplink_request_failed", status: res.status, details: json || text || null };
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: "couplink_request_failed", details: String(e && e.message ? e.message : e) };
  }
}

async function getCouplinkPositions() {
  const r = await couplinkFetchJson("/vehicles/positions");
  if (!r.ok) return r;
  const items = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.items) ? r.data.items : Array.isArray(r.data?.vehicles) ? r.data.vehicles : [];
  return {
    ok: true,
    items: items
      .map((it) => ({
        vehicleId: normalizeString(it.vehicleId || it.id || it.vehicle_id),
        position: {
          lat: it.position && it.position.lat !== undefined ? Number(it.position.lat) : it.lat !== undefined ? Number(it.lat) : null,
          lon: it.position && it.position.lon !== undefined ? Number(it.position.lon) : it.lon !== undefined ? Number(it.lon) : null,
        },
        plannedEta: normalizeString(it.plannedEta || it.planned_eta) || null,
        predictedEta: normalizeString(it.predictedEta || it.predicted_eta) || null,
        remainingStops: Array.isArray(it.remainingStops || it.remaining_stops) ? it.remainingStops || it.remaining_stops : [],
        raw: it,
      }))
      .filter((it) => it.vehicleId),
  };
}

async function pushRouteToCouplink({ vehicleId, orderedStops, routeId = null }) {
  const vid = normalizeString(vehicleId);
  if (!vid) return { ok: false, error: "vehicleId_required" };
  const stops = Array.isArray(orderedStops) ? orderedStops : [];
  const r = await couplinkFetchJson(`/vehicles/${encodeURIComponent(vid)}/tour`, {
    method: "PUT",
    body: { routeId, stops },
  });
  if (!r.ok) return r;
  return { ok: true, vehicleId: vid, stopCount: stops.length };
}

function routeStopToCouplinkPayload(stop) {
  return {
    stopIndex: stop.stopIndex,
    kind: stop.kind,
    orderId: stop.orderId || null,
    address: stop.address || null,
    lat: stop.lat,
    lon: stop.lon,
    windowStart: stop.windowStart || null,
    windowEnd: stop.windowEnd || null,
    plannedArrivalAt: stop.plannedArrivalAt || null,
    plannedDepartureAt: stop.plannedDepartureAt || null,
    meta: stop.meta || {},
  };
}

async function getOsrmTravelMatrix(points) {
  if (!osrmConfigured()) return { ok: false, error: "osrm_not_configured" };
  const list = Array.isArray(points) ? points.filter((p) => Number.isFinite(p?.lon) && Number.isFinite(p?.lat)) : [];
  if (!list.length) return { ok: false, error: "points_required" };
  const coordinates = list.map((p) => `${Number(p.lon)},${Number(p.lat)}`).join(";");
  try {
    const res = await fetch(`${osrmBaseUrl}/table/v1/driving/${coordinates}?annotations=duration,distance`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return { ok: false, error: "osrm_request_failed", details: data || null };
    return { ok: true, durations: data.durations || [], distances: data.distances || [] };
  } catch (e) {
    return { ok: false, error: "osrm_request_failed", details: String(e && e.message ? e.message : e) };
  }
}

function parseEtaToEpochSeconds(value) {
  const v = normalizeString(value);
  if (!v) return null;
  const d = parseIsoDate(v);
  return d ? Math.floor(d.getTime() / 1000) : null;
}

function computeDelayMinutes({ plannedEta, predictedEta }) {
  const planned = parseEtaToEpochSeconds(plannedEta);
  const predicted = parseEtaToEpochSeconds(predictedEta);
  if (planned === null || predicted === null) return null;
  return Math.round((predicted - planned) / 60);
}

function hereConfigured() {
  return Boolean(hereApiKey && hereTrafficBaseUrl && hereRoutingBaseUrl);
}

function monthKeyUtc(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function clampNumber(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function computeBboxFromPoints(points, { marginDegrees = 0.02 } = {}) {
  const list = Array.isArray(points) ? points.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)) : [];
  if (!list.length) return null;
  let west = list[0].lon;
  let east = list[0].lon;
  let south = list[0].lat;
  let north = list[0].lat;
  for (const p of list) {
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  const m = Number.isFinite(marginDegrees) ? marginDegrees : 0;
  return { west: west - m, south: south - m, east: east + m, north: north + m };
}

async function incrementHereUsage({ endpoint, cost = 1 } = {}) {
  if (!pool) return { ok: false, error: "db_required" };
  const ep = normalizeKey(endpoint || "unknown");
  const c = Math.max(1, Math.min(100, Number(cost) || 1));
  const month = monthKeyUtc(new Date());
  const row = await pool
    .query(
      `
      with u as (
        insert into traffic_here_usage_month (month, endpoint, request_count, updated_at)
        values ($1, $2, $3, now())
        on conflict (month, endpoint) do update
          set request_count = traffic_here_usage_month.request_count + excluded.request_count,
              updated_at = now()
        returning request_count
      ),
      t as (
        insert into traffic_here_usage_month (month, endpoint, request_count, updated_at)
        values ($1, '__total__', $3, now())
        on conflict (month, endpoint) do update
          set request_count = traffic_here_usage_month.request_count + excluded.request_count,
              updated_at = now()
        returning request_count, warned_level
      )
      select
        (select request_count from u) as endpoint_count,
        (select request_count from t) as total_count,
        (select warned_level from t) as warned_level;
      `,
      [month, ep, c],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!row) return { ok: false, error: "usage_update_failed" };

  const totalCount = Number(row.total_count);
  const prevWarned = Number(row.warned_level);
  const warnAt = Math.floor(hereMonthlyLimit * hereWarnPct);
  const criticalAt = Math.floor(hereMonthlyLimit * hereCriticalPct);
  const newLevel = totalCount >= criticalAt ? 2 : totalCount >= warnAt ? 1 : 0;

  if (newLevel > prevWarned) {
    await pool
      .query(
        `
        update traffic_here_usage_month
        set warned_level = $3, updated_at = now()
        where month = $1 and endpoint = '__total__' and warned_level < $3;
        `,
        [month, "__total__", newLevel],
      )
      .catch(() => {});
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "HERE_QUOTA_WARNING",
      username: "system",
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: null,
      blockReason: null,
      overrideId: month,
      overrideReason: null,
      meta: { month, totalCount, limit: hereMonthlyLimit, level: newLevel },
    });
  }

  return {
    ok: true,
    month,
    endpoint: ep,
    endpointCount: Number(row.endpoint_count),
    totalCount,
    limit: hereMonthlyLimit,
    warnedLevel: newLevel,
  };
}

async function getHereUsageStatus({ month = null } = {}) {
  if (!pool) return { ok: false, error: "db_required" };
  const m = normalizeString(month) || monthKeyUtc(new Date());
  const rows = await pool
    .query(
      `
      select endpoint, request_count, warned_level, updated_at
      from traffic_here_usage_month
      where month = $1;
      `,
      [m],
    )
    .then((r) => r.rows)
    .catch(() => []);
  const perEndpoint = {};
  let totalCount = 0;
  let warnedLevel = 0;
  let updatedAt = null;
  for (const r of rows) {
    perEndpoint[r.endpoint] = Number(r.request_count);
    if (r.endpoint === "__total__") {
      totalCount = Number(r.request_count);
      warnedLevel = Number(r.warned_level);
      updatedAt = r.updated_at ? new Date(r.updated_at).toISOString() : null;
    }
  }
  const warnAt = Math.floor(hereMonthlyLimit * hereWarnPct);
  const criticalAt = Math.floor(hereMonthlyLimit * hereCriticalPct);
  const nextWarningAt = warnedLevel === 0 ? warnAt : warnedLevel === 1 ? criticalAt : hereMonthlyLimit;
  return {
    ok: true,
    configured: hereConfigured(),
    month: m,
    totalCount,
    limit: hereMonthlyLimit,
    warnAt,
    criticalAt,
    warnedLevel,
    nextWarningAt,
    updatedAt,
    perEndpoint,
  };
}

async function hereFetchJson(baseUrl, pathname, params, { endpointName }) {
  if (!hereConfigured()) return { ok: false, error: "here_not_configured" };
  const usage = await incrementHereUsage({ endpoint: endpointName || pathname, cost: 1 });
  if (!usage.ok) return { ok: false, error: usage.error };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined) continue;
    p.set(k, String(v));
  }
  p.set("apiKey", hereApiKey);
  try {
    const url = `${baseUrl}${pathname}?${p.toString()}`;
    const res = await fetch(url, { method: "GET" });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) return { ok: false, error: "here_request_failed", status: res.status, details: json || null };
    return { ok: true, data: json, usage };
  } catch (e) {
    return { ok: false, error: "here_request_failed", details: String(e && e.message ? e.message : e) };
  }
}

async function upsertHereSnapshot({ kind, depotCode = "", area = {}, fetchedAt, expiresAt, payload }) {
  if (!pool) return { ok: false, error: "db_required" };
  const k = normalizeKey(kind);
  const depot = normalizeKey(depotCode || "");
  const id = `ths_${crypto.randomUUID()}`;
  const row = await pool
    .query(
      `
      insert into traffic_here_snapshot (id, kind, depot_code, area, fetched_at, expires_at, payload)
      values ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz, $7::jsonb)
      on conflict (kind, depot_code) do update
        set area = excluded.area,
            fetched_at = excluded.fetched_at,
            expires_at = excluded.expires_at,
            payload = excluded.payload
      returning id, fetched_at, expires_at;
      `,
      [id, k, depot, JSON.stringify(area || {}), fetchedAt, expiresAt, JSON.stringify(payload || {})],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!row) return { ok: false, error: "snapshot_upsert_failed" };
  return { ok: true, id: row.id, fetchedAt: new Date(row.fetched_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
}

async function getHereSnapshot({ kind, depotCode = "" }) {
  if (!pool) return null;
  const k = normalizeKey(kind);
  const depot = normalizeKey(depotCode || "");
  const row = await pool
    .query(
      `
      select id, kind, depot_code, area, fetched_at, expires_at, payload
      from traffic_here_snapshot
      where kind = $1 and depot_code = $2
      limit 1;
      `,
      [k, depot],
    )
    .then((r) => r.rows[0] || null)
    .catch(() => null);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    depotCode: row.depot_code,
    area: row.area || {},
    fetchedAt: new Date(row.fetched_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    payload: row.payload || {},
    expired: new Date(row.expires_at).getTime() <= Date.now(),
  };
}

function classifyHereIncident(incident) {
  const rawType = normalizeKey(incident?.type || incident?.incidentType || incident?.category || incident?.kind || "");
  const desc = normalizeKey(incident?.description?.value || incident?.description || incident?.summary || "");
  const isRoadworks = rawType.includes("construction") || rawType.includes("road") || desc.includes("baustelle") || desc.includes("construction") || desc.includes("roadworks");
  const isClosure = rawType.includes("closure") || desc.includes("sperr") || desc.includes("closed") || desc.includes("closure");
  const criticality = normalizeKey(incident?.criticality || incident?.impact || incident?.severity || "");
  const sev = criticality.includes("critical") || isClosure ? "critical" : criticality.includes("major") ? "major" : "minor";
  return { isRoadworks, isClosure, severity: sev, type: rawType || null, description: incident?.description?.value || incident?.description || null };
}

async function refreshHereTrafficSnapshots({ day = null } = {}) {
  if (!pool) return { ok: false, error: "db_required" };
  if (!hereConfigured()) return { ok: false, error: "here_not_configured" };
  const d = day || dateToYmd(new Date());
  const rows = await pool
    .query(
      `
      select r.depot_code, s.lat, s.lon
      from waste_route r
      join waste_route_stop s on s.route_id = r.id
      where r.day = $1::date
        and r.status in ('planned','in_progress')
        and s.lat is not null and s.lon is not null;
      `,
      [d],
    )
    .then((r) => r.rows)
    .catch(() => []);
  const byDepot = new Map();
  for (const r of rows) {
    const depot = normalizeString(r.depot_code) || "";
    if (!byDepot.has(depot)) byDepot.set(depot, []);
    byDepot.get(depot).push({ lat: Number(r.lat), lon: Number(r.lon) });
  }
  const results = [];
  for (const [depot, pts] of byDepot.entries()) {
    const bbox = computeBboxFromPoints(pts, { marginDegrees: 0.03 });
    if (!bbox) continue;
    const inParam = `bbox:${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
    const fetchedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + hereRefreshIntervalMs).toISOString();
    const incidents = await hereFetchJson(hereTrafficBaseUrl, "/incidents", { locationReferencing: "shape", in: inParam }, { endpointName: "traffic_incidents" });
    const flows = await hereFetchJson(hereTrafficBaseUrl, "/flow", { locationReferencing: "shape", in: inParam }, { endpointName: "traffic_flow" });
    const incPayload = incidents.ok ? incidents.data : { error: incidents.error, details: incidents.details || null };
    const flowPayload = flows.ok ? flows.data : { error: flows.error, details: flows.details || null };
    const snapshotArea = { bbox, in: inParam, day: d };
    await upsertHereSnapshot({ kind: "incidents", depotCode: depot, area: snapshotArea, fetchedAt, expiresAt, payload: incPayload });
    await upsertHereSnapshot({ kind: "flow", depotCode: depot, area: snapshotArea, fetchedAt, expiresAt, payload: flowPayload });
    const incidentItems = Array.isArray(incPayload?.incidents) ? incPayload.incidents : Array.isArray(incPayload?.results) ? incPayload.results : Array.isArray(incPayload?.items) ? incPayload.items : [];
    const flowItems = Array.isArray(flowPayload?.flows) ? flowPayload.flows : Array.isArray(flowPayload?.results) ? flowPayload.results : Array.isArray(flowPayload?.items) ? flowPayload.items : [];
    const incClasses = incidentItems.map((i) => classifyHereIncident(i));
    const roadworksCount = incClasses.filter((c) => c.isRoadworks).length;
    const closureCount = incClasses.filter((c) => c.isClosure).length;
    const jamCount = flowItems.filter((f) => (clampNumber(f?.jamFactor, 0, 10) || 0) >= 7).length;
    results.push({ depotCode: depot, bbox, incidentCount: incidentItems.length, roadworksCount, closureCount, jamCount });
  }
  return { ok: true, day: d, depots: results, refreshIntervalMs: hereRefreshIntervalMs };
}

async function hereRoutingRoutes({ origin, destination, via = [], departureTime = null, alternatives = 2, transportMode = "car", returnFields = "summary,polyline" } = {}) {
  if (!hereConfigured()) return { ok: false, error: "here_not_configured" };
  const oLat = clampNumber(origin?.lat, -90, 90);
  const oLon = clampNumber(origin?.lon, -180, 180);
  const dLat = clampNumber(destination?.lat, -90, 90);
  const dLon = clampNumber(destination?.lon, -180, 180);
  if (oLat === null || oLon === null || dLat === null || dLon === null) return { ok: false, error: "invalid_coordinates" };
  const alt = Math.max(0, Math.min(3, Number(alternatives) || 0));
  const usage = await incrementHereUsage({ endpoint: "routing_routes", cost: 1 });
  if (!usage.ok) return { ok: false, error: usage.error };
  const p = new URLSearchParams();
  p.set("transportMode", normalizeKey(transportMode || "car"));
  p.set("origin", `${oLat},${oLon}`);
  p.set("destination", `${dLat},${dLon}`);
  p.set("return", String(returnFields || "summary"));
  if (alt > 0) p.set("alternatives", String(alt));
  if (departureTime) p.set("departureTime", String(departureTime));
  for (const v of Array.isArray(via) ? via : []) {
    const vLat = clampNumber(v?.lat, -90, 90);
    const vLon = clampNumber(v?.lon, -180, 180);
    if (vLat === null || vLon === null) continue;
    p.append("via", `${vLat},${vLon}`);
  }
  p.set("apiKey", hereApiKey);
  try {
    const url = `${hereRoutingBaseUrl}/routes?${p.toString()}`;
    const res = await fetch(url, { method: "GET" });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) return { ok: false, error: "here_request_failed", status: res.status, details: json || null, usage };
    return { ok: true, data: json, usage };
  } catch (e) {
    return { ok: false, error: "here_request_failed", details: String(e && e.message ? e.message : e), usage };
  }
}

async function getCustomerByIdOrNo(value) {
  if (!pool) return null;
  const v = normalizeString(value);
  if (!v) return null;
  const row = await pool
    .query(
      `
      select
        id, customer_no, name, legal_form, vat_id, billing_address, service_addresses, email, phone, payment_terms, active, meta, created_at, updated_at
      from crm_customer
      where id = $1 or customer_no = $1
      limit 1;
      `,
      [v],
    )
    .then((r) => r.rows[0] || null);
  if (!row) return null;
  return {
    id: row.id,
    customerNo: row.customer_no,
    name: row.name,
    legalForm: row.legal_form || null,
    vatId: row.vat_id || null,
    billingAddress: row.billing_address || {},
    serviceAddresses: row.service_addresses || [],
    email: row.email || null,
    phone: row.phone || null,
    paymentTerms: row.payment_terms || {},
    active: Boolean(row.active),
    meta: row.meta || {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function listCustomers({ q = null, activeOnly = false, limit = 50 } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const query = normalizeString(q) || null;
  const rows = await pool
    .query(
      `
      select
        id, customer_no, name, active, updated_at
      from crm_customer
      where ($1::text is null or name ilike '%' || $1 || '%' or customer_no ilike '%' || $1 || '%')
        and ($2::boolean is false or active = true)
      order by updated_at desc
      limit $3;
      `,
      [query, activeOnly === true, n],
    )
    .then((r) => r.rows);
  return rows.map((r) => ({ id: r.id, customerNo: r.customer_no, name: r.name, active: Boolean(r.active), updatedAt: new Date(r.updated_at).toISOString() }));
}

async function createCustomer({ body, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const customerNo = normalizeString(body.customerNo);
  const name = normalizeString(body.name);
  if (!customerNo) return { ok: false, error: "customerNo_required" };
  if (!name) return { ok: false, error: "name_required" };
  const email = normalizeString(body.email) || null;
  const phone = normalizeString(body.phone) || null;
  const legalForm = normalizeString(body.legalForm) || null;
  const vatId = normalizeString(body.vatId) || null;
  const billingAddress = body.billingAddress && typeof body.billingAddress === "object" ? body.billingAddress : {};
  const serviceAddresses = Array.isArray(body.serviceAddresses) ? body.serviceAddresses : [];
  const paymentTerms = body.paymentTerms && typeof body.paymentTerms === "object" ? body.paymentTerms : {};
  const active = body.active !== false;
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
  const id = `cus_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into crm_customer
      (id, customer_no, name, legal_form, vat_id, billing_address, service_addresses, email, phone, payment_terms, active, meta, created_at, updated_at)
    values
      ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,$11,$12::jsonb, now(), now());
    `,
    [id, customerNo, name, legalForm, vatId, JSON.stringify(billingAddress), JSON.stringify(serviceAddresses), email, phone, JSON.stringify(paymentTerms), active, JSON.stringify(meta)],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "CUSTOMER_CREATED",
    username,
    occurredAt: new Date().toISOString(),
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: { customerNo, name },
  });
  const item = await getCustomerByIdOrNo(id);
  return { ok: true, item };
}

async function updateCustomer({ body, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const id = normalizeString(body.id);
  if (!id) return { ok: false, error: "id_required" };
  const existing = await getCustomerByIdOrNo(id);
  if (!existing) return { ok: false, error: "customer_not_found" };
  const name = normalizeString(body.name) || existing.name;
  const email = body.email === null ? null : normalizeString(body.email) || existing.email;
  const phone = body.phone === null ? null : normalizeString(body.phone) || existing.phone;
  const legalForm = body.legalForm === null ? null : normalizeString(body.legalForm) || existing.legalForm;
  const vatId = body.vatId === null ? null : normalizeString(body.vatId) || existing.vatId;
  const billingAddress = body.billingAddress && typeof body.billingAddress === "object" ? body.billingAddress : existing.billingAddress || {};
  const serviceAddresses = Array.isArray(body.serviceAddresses) ? body.serviceAddresses : existing.serviceAddresses || [];
  const paymentTerms = body.paymentTerms && typeof body.paymentTerms === "object" ? body.paymentTerms : existing.paymentTerms || {};
  const active = typeof body.active === "boolean" ? body.active : existing.active;
  const meta = body.meta && typeof body.meta === "object" ? body.meta : existing.meta || {};
  await pool.query(
    `
    update crm_customer
    set name = $2,
        legal_form = $3,
        vat_id = $4,
        billing_address = $5::jsonb,
        service_addresses = $6::jsonb,
        email = $7,
        phone = $8,
        payment_terms = $9::jsonb,
        active = $10,
        meta = $11::jsonb,
        updated_at = now()
    where id = $1;
    `,
    [id, name, legalForm, vatId, JSON.stringify(billingAddress), JSON.stringify(serviceAddresses), email, phone, JSON.stringify(paymentTerms), active, JSON.stringify(meta)],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "CUSTOMER_UPDATED",
    username,
    occurredAt: new Date().toISOString(),
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: {},
  });
  const item = await getCustomerByIdOrNo(id);
  return { ok: true, item };
}

async function createContract({ body, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const customerId = normalizeString(body.customerId);
  const customer = await getCustomerByIdOrNo(customerId);
  if (!customer) return { ok: false, error: "customer_not_found" };
  const contractNo = normalizeString(body.contractNo);
  if (!contractNo) return { ok: false, error: "contractNo_required" };
  const status = normalizeString(body.status) || "draft";
  if (!["draft", "active", "terminated"].includes(status)) return { ok: false, error: "invalid_status" };
  const validFrom = parseYmd(body.validFrom);
  if (!validFrom) return { ok: false, error: "validFrom_required" };
  const validTo = body.validTo === null || body.validTo === undefined || body.validTo === "" ? null : parseYmd(body.validTo);
  if (body.validTo && !validTo) return { ok: false, error: "invalid_validTo" };
  if (validTo && validTo < validFrom) return { ok: false, error: "invalid_valid_range" };
  const title = normalizeString(body.title) || null;
  const terms = body.terms && typeof body.terms === "object" ? body.terms : {};
  const id = `con_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into crm_contract
      (id, contract_no, customer_id, status, valid_from, valid_to, title, terms, created_by, created_at, updated_at)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now(), now());
    `,
    [id, contractNo, customer.id, status, validFrom, validTo, title, JSON.stringify(terms), username],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "CONTRACT_CREATED",
    username,
    occurredAt: new Date().toISOString(),
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: { contractNo, customerId: customer.id },
  });
  return { ok: true, item: await getContractById(id) };
}

async function getContractById(id) {
  if (!pool) return null;
  const row = await pool
    .query(
      `
      select id, contract_no, customer_id, status, valid_from, valid_to, title, terms, created_by, created_at, updated_at
      from crm_contract
      where id = $1
      limit 1;
      `,
      [id],
    )
    .then((r) => r.rows[0] || null);
  if (!row) return null;
  return {
    id: row.id,
    contractNo: row.contract_no,
    customerId: row.customer_id,
    status: row.status,
    validFrom: pgDateToYmd(row.valid_from),
    validTo: pgDateToYmd(row.valid_to),
    title: row.title || null,
    terms: row.terms || {},
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function listContracts({ customerId = null, status = null, limit = 50 } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const cid = normalizeString(customerId) || null;
  const st = normalizeString(status) || null;
  const rows = await pool
    .query(
      `
      select id
      from crm_contract
      where ($1::text is null or customer_id = $1)
        and ($2::text is null or status = $2)
      order by valid_from desc
      limit $3;
      `,
      [cid, st, n],
    )
    .then((r) => r.rows);
  const out = [];
  for (const r of rows) {
    const it = await getContractById(r.id);
    if (it) out.push(it);
  }
  return out;
}

async function setContractStatus({ contractId, toStatus, username, reason }) {
  if (!pool) return { ok: false, error: "db_required" };
  const id = normalizeString(contractId);
  if (!id) return { ok: false, error: "contractId_required" };
  if (!["draft", "active", "terminated"].includes(toStatus)) return { ok: false, error: "invalid_status" };
  const r = await pool
    .query(
      `
      update crm_contract
      set status = $2, updated_at = now()
      where id = $1
      returning id;
      `,
      [id, toStatus],
    )
    .then((x) => x.rows[0] || null);
  if (!r) return { ok: false, error: "contract_not_found" };
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "CONTRACT_STATUS_CHANGED",
    username,
    occurredAt: new Date().toISOString(),
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: id,
    overrideReason: reason || null,
    meta: { toStatus },
  });
  return { ok: true, item: await getContractById(id) };
}

async function createMaterial({ body, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const code = normalizeString(body.code);
  const name = normalizeString(body.name);
  if (!code) return { ok: false, error: "code_required" };
  if (!name) return { ok: false, error: "name_required" };
  const unit = normalizeString(body.unit) || "t";
  if (!["t", "kg", "cbm", "piece"].includes(unit)) return { ok: false, error: "invalid_unit" };
  const hazardClass = normalizeString(body.hazardClass) || null;
  const active = body.active !== false;
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
  const id = `mat_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into item_material (id, code, name, unit, hazard_class, active, meta, created_at, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb, now(), now());
    `,
    [id, code, name, unit, hazardClass, active, JSON.stringify(meta)],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "MATERIAL_CREATED",
    username,
    occurredAt: new Date().toISOString(),
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: { code, name },
  });
  return { ok: true, item: await getMaterialByCode(code) };
}

async function getMaterialByCode(code) {
  if (!pool) return null;
  const c = normalizeString(code);
  if (!c) return null;
  const row = await pool
    .query(
      `
      select id, code, name, unit, hazard_class, active, meta, created_at, updated_at
      from item_material
      where code = $1
      limit 1;
      `,
      [c],
    )
    .then((r) => r.rows[0] || null);
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    hazardClass: row.hazard_class || null,
    active: Boolean(row.active),
    meta: row.meta || {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function listMaterials({ activeOnly = false, limit = 100 } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(200, Number(limit) || 100));
  const rows = await pool
    .query(
      `
      select id, code, name, unit, hazard_class, active, meta, created_at, updated_at
      from item_material
      where ($1::boolean is false or active = true)
      order by name asc
      limit $2;
      `,
      [activeOnly === true, n],
    )
    .then((r) => r.rows);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    unit: r.unit,
    hazardClass: r.hazard_class || null,
    active: Boolean(r.active),
    meta: r.meta || {},
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

async function createPriceList({ body, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const code = normalizeString(body.code);
  const name = normalizeString(body.name);
  if (!code) return { ok: false, error: "code_required" };
  if (!name) return { ok: false, error: "name_required" };
  const currency = normalizeString(body.currency) || "EUR";
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "invalid_currency" };
  const status = normalizeString(body.status) || "draft";
  if (!["draft", "active", "archived"].includes(status)) return { ok: false, error: "invalid_status" };
  const validFrom = parseYmd(body.validFrom);
  if (!validFrom) return { ok: false, error: "validFrom_required" };
  const validTo = body.validTo === null || body.validTo === undefined || body.validTo === "" ? null : parseYmd(body.validTo);
  if (body.validTo && !validTo) return { ok: false, error: "invalid_validTo" };
  if (validTo && validTo < validFrom) return { ok: false, error: "invalid_valid_range" };
  const scope = body.scope && typeof body.scope === "object" ? body.scope : {};
  const id = `pl_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into pricing_price_list
      (id, code, name, currency, valid_from, valid_to, status, scope, created_by, created_at, updated_at)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now(), now());
    `,
    [id, code, name, currency, validFrom, validTo, status, JSON.stringify(scope), username],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "PRICELIST_CREATED",
    username,
    occurredAt: new Date().toISOString(),
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: { code, status, validFrom, validTo },
  });
  return { ok: true, item: await getPriceListById(id) };
}

async function getPriceListById(id) {
  if (!pool) return null;
  const row = await pool
    .query(
      `
      select id, code, name, currency, valid_from, valid_to, status, scope, created_by, created_at, updated_at
      from pricing_price_list
      where id = $1
      limit 1;
      `,
      [id],
    )
    .then((r) => r.rows[0] || null);
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    currency: row.currency,
    validFrom: pgDateToYmd(row.valid_from),
    validTo: pgDateToYmd(row.valid_to),
    status: row.status,
    scope: row.scope || {},
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function listPriceLists({ status = null, at = null, limit = 50 } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const st = normalizeString(status) || null;
  const atDate = at ? parseYmd(at) : null;
  const rows = await pool
    .query(
      `
      select id
      from pricing_price_list
      where ($1::text is null or status = $1)
        and ($2::date is null or (valid_from <= $2::date and (valid_to is null or valid_to >= $2::date)))
      order by valid_from desc
      limit $3;
      `,
      [st, atDate, n],
    )
    .then((r) => r.rows);
  const out = [];
  for (const r of rows) {
    const it = await getPriceListById(r.id);
    if (it) out.push(it);
  }
  return out;
}

async function createPriceListItem({ body, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const priceListId = normalizeString(body.priceListId);
  const pl = await getPriceListById(priceListId);
  if (!pl) return { ok: false, error: "priceList_not_found" };
  const itemType = normalizeString(body.itemType);
  if (!["service", "material", "fee"].includes(itemType)) return { ok: false, error: "invalid_itemType" };
  const refCode = normalizeString(body.refCode);
  if (!refCode) return { ok: false, error: "refCode_required" };
  const unit = normalizeString(body.unit);
  if (!["order", "t", "kg", "cbm", "piece"].includes(unit)) return { ok: false, error: "invalid_unit" };
  const minQty = body.minQty === null || body.minQty === undefined || body.minQty === "" ? 0 : Number(body.minQty);
  const maxQty = body.maxQty === null || body.maxQty === undefined || body.maxQty === "" ? null : Number(body.maxQty);
  if (!Number.isFinite(minQty) || minQty < 0) return { ok: false, error: "invalid_minQty" };
  if (maxQty !== null && (!Number.isFinite(maxQty) || maxQty <= minQty)) return { ok: false, error: "invalid_maxQty" };
  const unitPriceCents = Number(body.unitPriceCents);
  if (!Number.isFinite(unitPriceCents) || unitPriceCents < 0) return { ok: false, error: "invalid_unitPriceCents" };
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};

  const maxForOverlap = maxQty === null ? 1e18 : maxQty;
  const conflict = await pool
    .query(
      `
      select id
      from pricing_price_list_item
      where price_list_id = $1
        and item_type = $2
        and ref_code = $3
        and min_qty < $4
        and (max_qty is null or max_qty > $5)
      limit 1;
      `,
      [priceListId, itemType, refCode, maxForOverlap, minQty],
    )
    .then((r) => r.rows[0] || null);
  if (conflict) return { ok: false, error: "price_list_item_qty_overlap" };

  const id = `pli_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into pricing_price_list_item
      (id, price_list_id, item_type, ref_code, unit, min_qty, max_qty, unit_price_cents, meta, created_at)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, now());
    `,
    [id, priceListId, itemType, refCode, unit, minQty, maxQty, Math.round(unitPriceCents), JSON.stringify(meta)],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "PRICELIST_ITEM_CREATED",
    username,
    occurredAt: new Date().toISOString(),
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: { priceListId, itemType, refCode, unit, minQty, maxQty, unitPriceCents: Math.round(unitPriceCents) },
  });
  return { ok: true, item: { id } };
}

async function listPriceListItems({ priceListId, itemType = null, limit = 200 } = {}) {
  if (!pool) return [];
  const priceList = normalizeString(priceListId);
  if (!priceList) return [];
  const type = normalizeString(itemType) || null;
  const n = Math.max(1, Math.min(500, Number(limit) || 200));
  const rows = await pool
    .query(
      `
      select id, price_list_id, item_type, ref_code, unit, min_qty, max_qty, unit_price_cents, meta, created_at
      from pricing_price_list_item
      where price_list_id = $1
        and ($2::text is null or item_type = $2)
      order by item_type asc, ref_code asc, min_qty asc
      limit $3;
      `,
      [priceList, type, n],
    )
    .then((r) => r.rows)
    .catch(() => []);
  return rows.map((r) => ({
    id: r.id,
    priceListId: r.price_list_id,
    itemType: r.item_type,
    refCode: r.ref_code,
    unit: r.unit,
    minQty: Number(r.min_qty),
    maxQty: r.max_qty === null ? null : Number(r.max_qty),
    unitPriceCents: Number(r.unit_price_cents),
    meta: r.meta || {},
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

async function createFee({ body, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const code = normalizeString(body.code);
  const name = normalizeString(body.name);
  if (!code) return { ok: false, error: "code_required" };
  if (!name) return { ok: false, error: "name_required" };
  const calculationMode = normalizeString(body.calculationMode);
  if (!["per_order", "per_ton", "per_container"].includes(calculationMode)) return { ok: false, error: "invalid_calculationMode" };
  const amountCents = Number(body.amountCents);
  if (!Number.isFinite(amountCents) || amountCents < 0) return { ok: false, error: "invalid_amountCents" };
  const currency = normalizeString(body.currency) || "EUR";
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "invalid_currency" };
  const validFrom = parseYmd(body.validFrom);
  if (!validFrom) return { ok: false, error: "validFrom_required" };
  const validTo = body.validTo === null || body.validTo === undefined || body.validTo === "" ? null : parseYmd(body.validTo);
  if (body.validTo && !validTo) return { ok: false, error: "invalid_validTo" };
  if (validTo && validTo < validFrom) return { ok: false, error: "invalid_valid_range" };
  const active = body.active !== false;
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};

  const conflict = await pool
    .query(
      `
      select id
      from pricing_fee
      where code = $1
        and active = true
        and valid_from <= $3::date
        and (valid_to is null or valid_to >= $2::date)
      limit 1;
      `,
      [code, validFrom, validTo === null ? "9999-12-31" : validTo],
    )
    .then((r) => r.rows[0] || null);
  if (conflict) return { ok: false, error: "fee_validity_overlap" };

  const id = `fee_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into pricing_fee
      (id, code, name, calculation_mode, amount_cents, currency, valid_from, valid_to, active, meta, created_by, created_at)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11, now());
    `,
    [id, code, name, calculationMode, Math.round(amountCents), currency, validFrom, validTo, active, JSON.stringify(meta), username],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "FEE_CREATED",
    username,
    occurredAt: new Date().toISOString(),
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: { code, calculationMode, amountCents: Math.round(amountCents), currency, validFrom, validTo, active },
  });
  return { ok: true, item: { id, code } };
}

async function listFees({ activeOnly = true, at = null, limit = 100 } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(200, Number(limit) || 100));
  const atDate = at ? parseYmd(at) : dateToYmd(new Date());
  const rows = await pool
    .query(
      `
      select id, code, name, calculation_mode, amount_cents, currency, valid_from, valid_to, active, meta, created_by, created_at
      from pricing_fee
      where ($1::boolean is false or active = true)
        and ($2::date is null or (valid_from <= $2::date and (valid_to is null or valid_to >= $2::date)))
      order by code asc, valid_from desc
      limit $3;
      `,
      [activeOnly !== false, atDate, n],
    )
    .then((r) => r.rows);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    calculationMode: r.calculation_mode,
    amountCents: Number(r.amount_cents),
    currency: r.currency,
    validFrom: pgDateToYmd(r.valid_from),
    validTo: pgDateToYmd(r.valid_to),
    active: Boolean(r.active),
    meta: r.meta || {},
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

async function createCustomerOverride({ body, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const customerIdRaw = normalizeString(body.customerId);
  const customer = await getCustomerByIdOrNo(customerIdRaw);
  if (!customer) return { ok: false, error: "customer_not_found" };
  const contractId = normalizeString(body.contractId) || null;
  if (contractId) {
    const c = await getContractById(contractId);
    if (!c) return { ok: false, error: "contract_not_found" };
    if (c.customerId !== customer.id) return { ok: false, error: "contract_customer_mismatch" };
  }
  const itemType = normalizeString(body.itemType);
  if (!["service", "material", "fee"].includes(itemType)) return { ok: false, error: "invalid_itemType" };
  const refCode = normalizeString(body.refCode);
  if (!refCode) return { ok: false, error: "refCode_required" };
  const overrideMode = normalizeString(body.overrideMode);
  if (!["replace", "discount_pct", "discount_cents"].includes(overrideMode)) return { ok: false, error: "invalid_overrideMode" };
  const currency = normalizeString(body.currency) || "EUR";
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "invalid_currency" };
  const validFrom = parseYmd(body.validFrom);
  if (!validFrom) return { ok: false, error: "validFrom_required" };
  const validTo = body.validTo === null || body.validTo === undefined || body.validTo === "" ? null : parseYmd(body.validTo);
  if (body.validTo && !validTo) return { ok: false, error: "invalid_validTo" };
  if (validTo && validTo < validFrom) return { ok: false, error: "invalid_valid_range" };
  const minQty = body.minQty === null || body.minQty === undefined || body.minQty === "" ? 0 : Number(body.minQty);
  const maxQty = body.maxQty === null || body.maxQty === undefined || body.maxQty === "" ? null : Number(body.maxQty);
  if (!Number.isFinite(minQty) || minQty < 0) return { ok: false, error: "invalid_minQty" };
  if (maxQty !== null && (!Number.isFinite(maxQty) || maxQty <= minQty)) return { ok: false, error: "invalid_maxQty" };

  const valueCents = body.valueCents === null || body.valueCents === undefined || body.valueCents === "" ? null : Number(body.valueCents);
  const valuePct = body.valuePct === null || body.valuePct === undefined || body.valuePct === "" ? null : Number(body.valuePct);
  if ((overrideMode === "replace" || overrideMode === "discount_cents") && (valueCents === null || !Number.isFinite(valueCents) || valueCents < 0)) return { ok: false, error: "invalid_valueCents" };
  if (overrideMode === "discount_pct" && (valuePct === null || !Number.isFinite(valuePct) || valuePct < 0 || valuePct > 100)) return { ok: false, error: "invalid_valuePct" };

  const maxForOverlap = maxQty === null ? 1e18 : maxQty;
  const conflict = await pool
    .query(
      `
      select id
      from pricing_customer_override
      where customer_id = $1
        and ((contract_id is null and $2::text is null) or contract_id = $2)
        and item_type = $3
        and ref_code = $4
        and valid_from <= $6::date
        and (valid_to is null or valid_to >= $5::date)
        and min_qty < $7
        and (max_qty is null or max_qty > $8)
      limit 1;
      `,
      [customer.id, contractId, itemType, refCode, validFrom, validTo === null ? "9999-12-31" : validTo, maxForOverlap, minQty],
    )
    .then((r) => r.rows[0] || null);
  if (conflict) return { ok: false, error: "override_overlap" };

  const id = `ovr_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into pricing_customer_override
      (id, customer_id, contract_id, item_type, ref_code, currency, valid_from, valid_to, override_mode, value_cents, value_pct, min_qty, max_qty, created_by, created_at)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now());
    `,
    [id, customer.id, contractId, itemType, refCode, currency, validFrom, validTo, overrideMode, valueCents === null ? null : Math.round(valueCents), valuePct, minQty, maxQty, username],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "PRICING_OVERRIDE_CREATED",
    username,
    occurredAt: new Date().toISOString(),
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: { customerId: customer.id, contractId, itemType, refCode, overrideMode, valueCents, valuePct, validFrom, validTo, minQty, maxQty },
  });
  return { ok: true, item: { id } };
}

async function getLatestWasteWeighTicket({ orderId }) {
  if (!pool) return null;
  const row = await pool
    .query(
      `
      select id, gross_kg, tare_kg, net_kg, weighed_at
      from waste_weigh_ticket
      where order_id = $1
      order by weighed_at desc
      limit 1;
      `,
      [orderId],
    )
    .then((r) => r.rows[0] || null);
  if (!row) return null;
  return { id: row.id, grossKg: Number(row.gross_kg), tareKg: Number(row.tare_kg), netKg: Number(row.net_kg), weighedAt: new Date(row.weighed_at).toISOString() };
}

async function getActiveContractForCustomer({ customerId, atDate }) {
  if (!pool) return null;
  if (!customerId || !atDate) return null;
  const row = await pool
    .query(
      `
      select id
      from crm_contract
      where customer_id = $1
        and status = 'active'
        and valid_from <= $2::date
        and (valid_to is null or valid_to >= $2::date)
      order by valid_from desc
      limit 1;
      `,
      [customerId, atDate],
    )
    .then((r) => r.rows[0] || null);
  return row ? await getContractById(row.id) : null;
}

async function getActivePriceListAt({ atDate }) {
  if (!pool) return null;
  const d = atDate || dateToYmd(new Date());
  const row = await pool
    .query(
      `
      select id
      from pricing_price_list
      where status = 'active'
        and valid_from <= $1::date
        and (valid_to is null or valid_to >= $1::date)
      order by valid_from desc, updated_at desc, created_at desc, id desc
      limit 1;
      `,
      [d],
    )
    .then((r) => r.rows[0] || null);
  return row ? await getPriceListById(row.id) : null;
}

async function getPriceListItemForQty({ priceListId, itemType, refCode, qty }) {
  if (!pool) return null;
  const row = await pool
    .query(
      `
      select id, unit, min_qty, max_qty, unit_price_cents, meta
      from pricing_price_list_item
      where price_list_id = $1
        and item_type = $2
        and ref_code = $3
        and min_qty <= $4
        and (max_qty is null or max_qty > $4)
      order by min_qty desc
      limit 1;
      `,
      [priceListId, itemType, refCode, qty],
    )
    .then((r) => r.rows[0] || null);
  if (!row) return null;
  return {
    id: row.id,
    unit: row.unit,
    minQty: Number(row.min_qty),
    maxQty: row.max_qty === null ? null : Number(row.max_qty),
    unitPriceCents: Number(row.unit_price_cents),
    meta: row.meta || {},
  };
}

async function getOverrideForQty({ customerId, contractId, itemType, refCode, atDate, qty }) {
  if (!pool) return null;
  if (!customerId) return null;
  const row = await pool
    .query(
      `
      select id, contract_id, override_mode, value_cents, value_pct, min_qty, max_qty
      from pricing_customer_override
      where customer_id = $1
        and ($2::text is null or contract_id = $2 or contract_id is null)
        and item_type = $3
        and ref_code = $4
        and valid_from <= $5
        and (valid_to is null or valid_to >= $5)
        and min_qty <= $6
        and (max_qty is null or max_qty > $6)
      order by
        case when contract_id = $2 then 0 else 1 end,
        valid_from desc,
        min_qty desc
      limit 1;
      `,
      [customerId, contractId, itemType, refCode, atDate, qty],
    )
    .then((r) => r.rows[0] || null);
  if (!row) return null;
  return {
    id: row.id,
    contractId: row.contract_id || null,
    overrideMode: row.override_mode,
    valueCents: row.value_cents === null ? null : Number(row.value_cents),
    valuePct: row.value_pct === null ? null : Number(row.value_pct),
    minQty: Number(row.min_qty),
    maxQty: row.max_qty === null ? null : Number(row.max_qty),
  };
}

function applyOverrideToUnitPrice({ unitPriceCents, override }) {
  if (!override) return { unitPriceCents, rule: null };
  const base = Math.max(0, Math.round(unitPriceCents));
  if (override.overrideMode === "replace") return { unitPriceCents: Math.max(0, Math.round(override.valueCents || 0)), rule: { type: "override_replace", id: override.id } };
  if (override.overrideMode === "discount_cents") return { unitPriceCents: Math.max(0, base - Math.round(override.valueCents || 0)), rule: { type: "override_discount_cents", id: override.id } };
  if (override.overrideMode === "discount_pct") return { unitPriceCents: Math.max(0, Math.round(base * (1 - (override.valuePct || 0) / 100))), rule: { type: "override_discount_pct", id: override.id } };
  return { unitPriceCents: base, rule: null };
}

async function calculatePricingForWasteOrder({ orderId, at = null, priceListId = null, username, forceRecalculate = false }) {
  if (!pool) return { ok: false, error: "db_required" };
  const order = await getWasteOrderById(orderId);
  if (!order) return { ok: false, error: "order_not_found" };
  const atDate = at ? parseYmd(at) : dateToYmd(new Date());
  if (!atDate) return { ok: false, error: "invalid_at" };
  const calculatedAt = new Date().toISOString();
  const algorithmVersion = "pricing_v1";

  const customerId = order.customerRefId || null;
  let contract = order.contractId ? await getContractById(order.contractId) : null;
  if (!contract && customerId) contract = await getActiveContractForCustomer({ customerId, atDate });

  const requestedPriceListId = normalizeString(priceListId) || null;
  const pl = requestedPriceListId ? await getPriceListById(requestedPriceListId) : await getActivePriceListAt({ atDate });
  if (!pl) return { ok: false, error: "no_active_pricelist" };
  if (requestedPriceListId) {
    if (pl.status === "draft") return { ok: false, error: "pricelist_not_effective" };
    if (!pl.validFrom) return { ok: false, error: "pricelist_invalid" };
    const okAt = pl.validFrom <= atDate && (!pl.validTo || pl.validTo >= atDate);
    if (!okAt) return { ok: false, error: "pricelist_not_valid_at" };
  }

  const wt = await getLatestWasteWeighTicket({ orderId: order.id });
  const qtyTons = wt ? wt.netKg / 1000 : order.plannedTons !== null && order.plannedTons !== undefined ? Number(order.plannedTons) : 0;
  const tons = Number.isFinite(qtyTons) && qtyTons > 0 ? qtyTons : 0;

  const hits = [];
  const lines = [];
  const currency = pl.currency || "EUR";

  const serviceQty = 1;
  const serviceItem = await getPriceListItemForQty({ priceListId: pl.id, itemType: "service", refCode: order.serviceType, qty: serviceQty });
  if (!serviceItem) return { ok: false, error: "service_price_not_found" };
  let serviceUnitPrice = serviceItem.unitPriceCents;
  const serviceOverride = customerId
    ? await getOverrideForQty({ customerId, contractId: contract ? contract.id : null, itemType: "service", refCode: order.serviceType, atDate, qty: serviceQty })
    : null;
  const serviceApplied = applyOverrideToUnitPrice({ unitPriceCents: serviceUnitPrice, override: serviceOverride });
  if (serviceApplied.rule) hits.push({ itemType: "service", refCode: order.serviceType, rule: serviceApplied.rule });
  serviceUnitPrice = serviceApplied.unitPriceCents;
  lines.push({
    itemType: "service",
    refCode: order.serviceType,
    label: `Service ${order.serviceType}`,
    unit: serviceItem.unit,
    qty: serviceQty,
    unitPriceCents: serviceUnitPrice,
    totalCents: Math.round(serviceQty * serviceUnitPrice),
    source: { priceListItemId: serviceItem.id, overrideId: serviceOverride ? serviceOverride.id : null },
  });

  if (order.materialCode) {
    const materialQty = tons;
    const materialItem = await getPriceListItemForQty({ priceListId: pl.id, itemType: "material", refCode: order.materialCode, qty: materialQty });
    if (!materialItem) return { ok: false, error: "material_price_not_found" };
    let materialUnitPrice = materialItem.unitPriceCents;
    const materialOverride = customerId
      ? await getOverrideForQty({ customerId, contractId: contract ? contract.id : null, itemType: "material", refCode: order.materialCode, atDate, qty: materialQty })
      : null;
    const materialApplied = applyOverrideToUnitPrice({ unitPriceCents: materialUnitPrice, override: materialOverride });
    if (materialApplied.rule) hits.push({ itemType: "material", refCode: order.materialCode, rule: materialApplied.rule });
    materialUnitPrice = materialApplied.unitPriceCents;
    lines.push({
      itemType: "material",
      refCode: order.materialCode,
      label: `Material ${order.materialCode}`,
      unit: materialItem.unit,
      qty: materialQty,
      unitPriceCents: materialUnitPrice,
      totalCents: Math.round(materialQty * materialUnitPrice),
      source: { priceListItemId: materialItem.id, overrideId: materialOverride ? materialOverride.id : null },
    });
  }

  const fees = await listFees({ activeOnly: true, at: atDate, limit: 200 });
  for (const fee of fees) {
    const qty = fee.calculationMode === "per_ton" ? tons : 1;
    const feeOverride = customerId ? await getOverrideForQty({ customerId, contractId: contract ? contract.id : null, itemType: "fee", refCode: fee.code, atDate, qty }) : null;
    const applied = applyOverrideToUnitPrice({ unitPriceCents: fee.amountCents, override: feeOverride });
    if (applied.rule) hits.push({ itemType: "fee", refCode: fee.code, rule: applied.rule });
    lines.push({
      itemType: "fee",
      refCode: fee.code,
      label: fee.name,
      unit: fee.calculationMode === "per_ton" ? "t" : "order",
      qty,
      unitPriceCents: applied.unitPriceCents,
      totalCents: Math.round(qty * applied.unitPriceCents),
      source: { feeId: fee.id, overrideId: feeOverride ? feeOverride.id : null },
    });
  }

  const totalCents = lines.reduce((sum, l) => sum + Math.round(l.totalCents), 0);
  const calcId = `pc_${crypto.randomUUID().slice(0, 12)}`;

  let eventType = "calculated";
  if (forceRecalculate) {
    const anyPrev = await pool.query(`select id from pricing_calculation where order_id = $1 limit 1;`, [order.id]).then((r) => r.rows[0] || null);
    if (anyPrev) eventType = "recalculated";
  }

  const input = {
    atDate,
    order: { id: order.id, status: order.status, serviceType: order.serviceType, materialCode: order.materialCode || null, customerRefId: customerId, contractId: contract ? contract.id : null },
    qty: { tons, weighTicketId: wt ? wt.id : null },
    priceList: { id: pl.id, code: pl.code, validFrom: pl.validFrom, validTo: pl.validTo },
    ruleHits: hits,
    algorithmVersion,
  };
  const output = { currency, totalCents, lines };

  await pool.query(
    `
    insert into pricing_calculation
      (id, order_id, customer_id, contract_id, calculated_at, currency, total_cents, algorithm_version, input, output, created_by, created_at)
    values
      ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11, now());
    `,
    [calcId, order.id, customerId, contract ? contract.id : null, calculatedAt, currency, totalCents, algorithmVersion, JSON.stringify(input), JSON.stringify(output), username],
  );
  await pool.query(
    `
    insert into pricing_calculation_event (id, calculation_id, event_type, username, occurred_at, meta)
    values ($1,$2,$3,$4,$5,$6::jsonb);
    `,
    [`pce_${crypto.randomUUID().slice(0, 12)}`, calcId, eventType, username, calculatedAt, JSON.stringify({ algorithmVersion })],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "PRICING_CALCULATED",
    username,
    occurredAt: calculatedAt,
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: order.id,
    overrideReason: null,
    meta: { calculationId: calcId, algorithmVersion, totalCents, currency },
  });
  await publishErpEvent({
    eventType: "PRICING_CALCULATED",
    aggregateType: "waste_order",
    aggregateId: order.id,
    occurredAt: calculatedAt,
    createdBy: username,
    payload: { calculationId: calcId, algorithmVersion, totalCents, currency, eventType },
  });

  return { ok: true, calculationId: calcId, currency, totalCents, lines, input };
}

async function listPricingCalculations({ orderId, limit = 20 } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const oid = normalizeString(orderId);
  if (!oid) return [];
  const rows = await pool
    .query(
      `
      select id, calculated_at, currency, total_cents, algorithm_version, created_by
      from pricing_calculation
      where order_id = $1
      order by calculated_at desc
      limit $2;
      `,
      [oid, n],
    )
    .then((r) => r.rows);
  return rows.map((r) => ({
    id: r.id,
    calculatedAt: new Date(r.calculated_at).toISOString(),
    currency: r.currency,
    totalCents: Number(r.total_cents),
    algorithmVersion: r.algorithm_version,
    createdBy: r.created_by,
  }));
}

async function getRoutingOverview({ day = null, depotCode = null, limit = 20 } = {}) {
  const routes = await pool
    .query(
      `
      select
        r.id, r.day, r.depot_code, r.status, r.vehicle_id, r.driver_id, r.planned_start_at, r.planned_end_at, r.updated_at,
        (select count(*)::int from waste_route_stop s where s.route_id = r.id) as stop_count
      from waste_route r
      where ($1::date is null or r.day = $1::date)
        and ($2::text is null or r.depot_code = $2)
      order by r.day desc, r.updated_at desc
      limit $3;
      `,
      [day, depotCode, limit],
    )
    .then((r) => r.rows)
    .catch(() => []);
  const orders = await listWasteOrders({ status: null, limit: 200 });
  const plannedStatuses = new Set(["validated", "dispatch_checked", "scheduled", "delivered", "pickup_requested", "picked_up", "weighed"]);
  const routeItems = [];
  let duplicateCandidates = 0;
  for (const row of routes) {
    const detail = await pool
      .query(
        `
        select id, stop_index, kind, order_id, lat, lon, address, window_start, window_end, planned_arrival_at, planned_departure_at, meta
        from waste_route_stop
        where route_id = $1
        order by stop_index asc;
        `,
        [row.id],
      )
      .then((r) => r.rows)
      .catch(() => []);
    const stops = detail.map((s) => ({
      id: s.id,
      stopIndex: Number(s.stop_index),
      kind: s.kind,
      orderId: s.order_id || null,
      lat: s.lat === null ? null : Number(s.lat),
      lon: s.lon === null ? null : Number(s.lon),
      address: s.address || null,
      windowStart: s.window_start ? new Date(s.window_start).toISOString() : null,
      windowEnd: s.window_end ? new Date(s.window_end).toISOString() : null,
      plannedArrivalAt: s.planned_arrival_at ? new Date(s.planned_arrival_at).toISOString() : null,
      plannedDepartureAt: s.planned_departure_at ? new Date(s.planned_departure_at).toISOString() : null,
      meta: s.meta || {},
    }));
    const seenOrderIds = new Set();
    for (const stop of stops) {
      if (stop.orderId && seenOrderIds.has(stop.orderId)) duplicateCandidates += 1;
      if (stop.orderId) seenOrderIds.add(stop.orderId);
    }
    routeItems.push({
      id: row.id,
      day: pgDateToYmd(row.day),
      depotCode: row.depot_code || null,
      status: row.status,
      vehicleId: row.vehicle_id || null,
      driverId: row.driver_id || null,
      plannedStartAt: row.planned_start_at ? new Date(row.planned_start_at).toISOString() : null,
      plannedEndAt: row.planned_end_at ? new Date(row.planned_end_at).toISOString() : null,
      stopCount: Number(row.stop_count),
      updatedAt: new Date(row.updated_at).toISOString(),
      stops,
    });
  }
  const pendingOrders = orders.filter((o) => plannedStatuses.has(o.status));
  return {
    ok: true,
    items: routeItems,
    summary: {
      totalRoutes: routeItems.length,
      totalStops: routeItems.reduce((sum, r) => sum + r.stopCount, 0),
      pendingOrders: pendingOrders.length,
      duplicateCandidates,
    },
  };
}

async function getRoutingIntegrationStatus({ day = null, depotCode = null } = {}) {
  const overview = await getRoutingOverview({ day, depotCode, limit: 20 });
  const positions = await getCouplinkPositions();
  const usage = await getHereUsageStatus({ month: null }).catch(() => ({ ok: true, configured: false, totalCount: 0, limit: hereMonthlyLimit, warnedLevel: 0 }));
  const depotKey = normalizeString(depotCode) || "";
  const incidentsSnapshot = hereConfigured() ? await getHereSnapshot({ kind: "incidents", depotCode: depotKey }) : null;
  const flowSnapshot = hereConfigured() ? await getHereSnapshot({ kind: "flow", depotCode: depotKey }) : null;
  const incidentItems = incidentsSnapshot
    ? Array.isArray(incidentsSnapshot.payload?.incidents)
      ? incidentsSnapshot.payload.incidents
      : Array.isArray(incidentsSnapshot.payload?.results)
        ? incidentsSnapshot.payload.results
        : Array.isArray(incidentsSnapshot.payload?.items)
          ? incidentsSnapshot.payload.items
          : []
    : [];
  const flowItems = flowSnapshot
    ? Array.isArray(flowSnapshot.payload?.flows)
      ? flowSnapshot.payload.flows
      : Array.isArray(flowSnapshot.payload?.results)
        ? flowSnapshot.payload.results
        : Array.isArray(flowSnapshot.payload?.items)
          ? flowSnapshot.payload.items
          : []
    : [];
  const incClasses = incidentItems.map((i) => classifyHereIncident(i));
  const hereRoadworks = incClasses.filter((c) => c.isRoadworks).length;
  const hereClosures = incClasses.filter((c) => c.isClosure).length;
  const hereJams = flowItems.filter((f) => (clampNumber(f?.jamFactor, 0, 10) || 0) >= 7).length;
  const integrations = {
    couplink: {
      configured: couplinkConfigured(),
      connected: positions.ok === true,
      status: !couplinkConfigured() ? "not_configured" : positions.ok ? "ready" : "degraded",
      vehiclePositions: positions.ok ? positions.items.length : 0,
      details: positions.ok ? null : positions.error,
    },
    here: {
      configured: hereConfigured(),
      status: !hereConfigured() ? "not_configured" : incidentsSnapshot && !incidentsSnapshot.expired ? "ready" : "stale",
      depotCode: depotKey || null,
      lastFetchedAt: incidentsSnapshot ? incidentsSnapshot.fetchedAt : null,
      expiresAt: incidentsSnapshot ? incidentsSnapshot.expiresAt : null,
      incidentCount: incidentItems.length,
      roadworksCount: hereRoadworks,
      closureCount: hereClosures,
      jamCount: hereJams,
      usage: usage.ok ? { month: usage.month, totalCount: usage.totalCount, limit: usage.limit, warnedLevel: usage.warnedLevel } : null,
    },
    osrm: {
      configured: osrmConfigured(),
      status: osrmConfigured() ? "ready_for_matrix" : "not_configured",
    },
    solver: {
      strategy: osrmConfigured() ? "greedy_plus_2opt_ready" : "heuristic_haversine_fallback",
      orToolsReady: false,
      note: "Aktuell ist eine eingebaute Heuristik aktiv; OR-Tools kann spaeter als Solver-Backend ergaenzt werden.",
    },
  };
  const vehicles = await getVehicles();
  const wasteVehicles = vehicles.filter((v) => Array.isArray(v.capabilities) && v.capabilities.includes("waste"));
  const vehiclePositions = positions.ok ? new Map(positions.items.map((it) => [it.vehicleId, it])) : new Map();
  const routes = overview.ok ? overview.items : [];
  const routeByVehicle = new Map(routes.map((r) => [r.vehicleId, r]));
  const etaWatch = [];
  for (const v of wasteVehicles) {
    const pos = vehiclePositions.get(v.id) || null;
    const route = routeByVehicle.get(v.id) || null;
    const delayMinutes = pos ? computeDelayMinutes({ plannedEta: pos.plannedEta, predictedEta: pos.predictedEta }) : null;
    etaWatch.push({
      vehicleId: v.id,
      code: v.code,
      hasActiveRoute: Boolean(route),
      couplinkPositionAvailable: Boolean(pos && Number.isFinite(pos.position.lat) && Number.isFinite(pos.position.lon)),
      position: pos ? pos.position : null,
      delayMinutes,
      rerouteRecommended: delayMinutes !== null && delayMinutes > routeDelayThresholdMinutes,
      routeId: route ? route.id : null,
    });
  }
  return {
    ok: true,
    overview: overview.ok ? overview.summary : { totalRoutes: 0, totalStops: 0, pendingOrders: 0, duplicateCandidates: 0 },
    integrations,
    etaWatch,
    thresholdMinutes: routeDelayThresholdMinutes,
  };
}

async function getPricingCalculationById(id) {
  if (!pool) return null;
  const row = await pool
    .query(
      `
      select id, order_id, customer_id, contract_id, calculated_at, currency, total_cents, algorithm_version, input, output, created_by, created_at
      from pricing_calculation
      where id = $1
      limit 1;
      `,
      [id],
    )
    .then((r) => r.rows[0] || null);
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    customerId: row.customer_id || null,
    contractId: row.contract_id || null,
    calculatedAt: new Date(row.calculated_at).toISOString(),
    currency: row.currency,
    totalCents: Number(row.total_cents),
    algorithmVersion: row.algorithm_version,
    input: row.input || {},
    output: row.output || {},
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function appendWorkshopCaseEvent({ caseId, fromStatus, toStatus, reason, username, occurredAt, meta }) {
  if (!pool) return;
  const id = `wce_${crypto.randomUUID().slice(0, 12)}`;
  await pool.query(
    `
    insert into workshop_case_event
      (id, case_id, from_status, to_status, reason, username, occurred_at, meta)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8);
    `,
    [id, caseId, fromStatus || null, toStatus, reason, username, occurredAt, meta || {}],
  );
}

async function getWorkshopCaseById(id) {
  if (!pool) return null;
  const rows = await pool
    .query(
      `
      select
        id, vehicle_id, title, description, priority, reporter_role, work_state, interrupted, delivery_delay, assigned_to, assigned_by, assigned_at, photo, severity, lock_type, status, opened_at, closed_at, closed_reason, created_by, created_at
      from workshop_case
      where id = $1
      limit 1;
      `,
      [id],
    )
    .then((r) => r.rows);
  const r = rows[0] || null;
  if (!r) return null;
  const blockRows = await pool
    .query(
      `
      select id, lock_type, severity, reason, starts_at, ends_at
      from fleet_availability_block
      where ref_entity_type = 'workshopCase' and ref_entity_id = $1 and ends_at is null
      order by created_at desc
      limit 1;
      `,
      [id],
    )
    .then((x) => x.rows);
  const activeBlock = blockRows[0] || null;
  const isBlocked = activeBlock ? String(activeBlock.lock_type) === "hard" : false;
  const workState = r.work_state || "created";
  const interrupted = Boolean(r.interrupted);
  const deliveryDelay = Boolean(r.delivery_delay);
  const poolStatus =
    r.status === "closed" || workState === "done"
      ? "closed"
      : isBlocked
        ? "critical_blocked"
        : workState === "in_progress"
          ? "in_progress"
          : workState === "assigned" || r.assigned_to
            ? "assigned"
            : "open";
  const photo = r.photo && typeof r.photo === "object" ? r.photo : null;
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    title: r.title,
    description: r.description || null,
    priority: r.priority,
    reporterRole: r.reporter_role,
    workState,
    interrupted,
    deliveryDelay,
    assignedTo: r.assigned_to || null,
    assignedBy: r.assigned_by || null,
    assignedAt: r.assigned_at ? new Date(r.assigned_at).toISOString() : null,
    poolStatus,
    criticalBlocked: isBlocked,
    photo: photo ? { mimeType: photo.mimeType || null, sha256: photo.sha256 || null, sizeBytes: photo.sizeBytes || null } : null,
    severity: r.severity,
    lockType: r.lock_type,
    status: r.status,
    openedAt: new Date(r.opened_at).toISOString(),
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    closedReason: r.closed_reason || null,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

async function listWorkshopCases({ vehicleId = null, status = null, assignedTo = null, workState = null, limit = 50 } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const params = [];
  const where = [];
  if (vehicleId) {
    params.push(vehicleId);
    where.push(`vehicle_id = $${params.length}`);
  }
  if (status && ["open", "closed"].includes(status)) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (assignedTo) {
    params.push(assignedTo);
    where.push(`assigned_to = $${params.length}`);
  }
  if (workState && ["created", "assigned", "in_progress", "waiting_parts", "done"].includes(workState)) {
    params.push(workState);
    where.push(`work_state = $${params.length}`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const rows = await pool
    .query(
      `
      select
        c.id, c.vehicle_id, c.title, c.description, c.priority, c.reporter_role, c.work_state, c.interrupted, c.delivery_delay, c.assigned_to, c.assigned_by, c.assigned_at, c.photo,
        c.severity, c.lock_type, c.status, c.opened_at, c.closed_at, c.closed_reason, c.created_by, c.created_at,
        exists(
          select 1
          from fleet_availability_block b
          where b.ref_entity_type = 'workshopCase'
            and b.ref_entity_id = c.id
            and b.ends_at is null
            and b.lock_type = 'hard'
        ) as critical_blocked
      from workshop_case c
      ${whereSql}
      order by c.opened_at desc
      limit ${n};
      `,
      params,
    )
    .then((r) => r.rows);
  return rows.map((r) => {
    const isBlocked = Boolean(r.critical_blocked);
    const ws = r.work_state || "created";
    const poolStatus =
      r.status === "closed" || ws === "done"
        ? "closed"
        : isBlocked
          ? "critical_blocked"
          : ws === "waiting_parts"
            ? "waiting_parts"
            : ws === "in_progress"
              ? "in_progress"
              : ws === "assigned" || r.assigned_to
                ? "assigned"
                : "open";
    const photo = r.photo && typeof r.photo === "object" ? r.photo : null;
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      title: r.title,
      description: r.description || null,
      priority: r.priority,
      reporterRole: r.reporter_role,
      workState: ws,
      interrupted: Boolean(r.interrupted),
      deliveryDelay: Boolean(r.delivery_delay),
      assignedTo: r.assigned_to || null,
      assignedBy: r.assigned_by || null,
      assignedAt: r.assigned_at ? new Date(r.assigned_at).toISOString() : null,
      poolStatus,
      criticalBlocked: isBlocked,
      photo: photo ? { mimeType: photo.mimeType || null, sha256: photo.sha256 || null, sizeBytes: photo.sizeBytes || null } : null,
      severity: r.severity,
      lockType: r.lock_type,
      status: r.status,
      openedAt: new Date(r.opened_at).toISOString(),
      closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
      closedReason: r.closed_reason || null,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).toISOString(),
    };
  });
}

async function listWorkshopPool({ limit = 100, priority = null, assigned = null, assignedTo = null, workState = null } = {}) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(200, Number(limit) || 100));
  const params = ["open"];
  const where = [`c.status = $1`];
  const pr = parsePriority(priority);
  if (pr) {
    params.push(pr);
    where.push(`c.priority = $${params.length}`);
  }
  const assignedMode = normalizeString(assigned).toLowerCase();
  if (assignedMode === "assigned") where.push(`c.assigned_to is not null`);
  if (assignedMode === "unassigned") where.push(`c.assigned_to is null`);
  if (assignedTo) {
    params.push(assignedTo);
    where.push(`c.assigned_to = $${params.length}`);
  }
  if (workState && ["created", "assigned", "in_progress", "waiting_parts", "done"].includes(workState)) {
    params.push(workState);
    where.push(`c.work_state = $${params.length}`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const rows = await pool
    .query(
      `
      select
        c.id, c.vehicle_id, c.title, c.description, c.priority, c.reporter_role, c.work_state, c.interrupted, c.delivery_delay, c.assigned_to, c.assigned_by, c.assigned_at, c.photo,
        c.severity, c.lock_type, c.status, c.opened_at, c.closed_at, c.closed_reason, c.created_by, c.created_at,
        exists(
          select 1
          from fleet_availability_block b
          where b.ref_entity_type = 'workshopCase'
            and b.ref_entity_id = c.id
            and b.ends_at is null
            and b.lock_type = 'hard'
        ) as critical_blocked
      from workshop_case c
      ${whereSql}
      order by
        critical_blocked desc,
        case c.priority when 'high' then 3 when 'medium' then 2 else 1 end desc,
        c.opened_at desc
      limit ${n};
      `,
      params,
    )
    .then((r) => r.rows);
  return rows.map((r) => {
    const isBlocked = Boolean(r.critical_blocked);
    const workState = r.work_state || "created";
    const poolStatus =
      isBlocked
        ? "critical_blocked"
        : workState === "waiting_parts"
          ? "waiting_parts"
          : workState === "in_progress"
            ? "in_progress"
            : workState === "assigned" || r.assigned_to
              ? "assigned"
              : "open";
    const photo = r.photo && typeof r.photo === "object" ? r.photo : null;
    return {
      id: r.id,
      vehicleId: r.vehicle_id,
      title: r.title,
      description: r.description || null,
      priority: r.priority,
      reporterRole: r.reporter_role,
      workState,
      interrupted: Boolean(r.interrupted),
      deliveryDelay: Boolean(r.delivery_delay),
      assignedTo: r.assigned_to || null,
      assignedBy: r.assigned_by || null,
      assignedAt: r.assigned_at ? new Date(r.assigned_at).toISOString() : null,
      poolStatus,
      criticalBlocked: isBlocked,
      photo: photo ? { mimeType: photo.mimeType || null, sha256: photo.sha256 || null, sizeBytes: photo.sizeBytes || null } : null,
      severity: r.severity,
      lockType: r.lock_type,
      status: r.status,
      openedAt: new Date(r.opened_at).toISOString(),
      closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
      closedReason: r.closed_reason || null,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).toISOString(),
    };
  });
}

async function getWorkshopCasePhoto({ caseId }) {
  if (!pool) return { ok: false, error: "db_required" };
  const id = normalizeString(caseId);
  if (!id) return { ok: false, error: "caseId_required" };
  const rows = await pool.query(`select photo from workshop_case where id = $1 limit 1;`, [id]).then((r) => r.rows);
  const p = rows[0]?.photo && typeof rows[0].photo === "object" ? rows[0].photo : null;
  if (!p) return { ok: false, error: "photo_not_found" };
  return { ok: true, item: { mimeType: p.mimeType || null, base64: p.base64 || null, sha256: p.sha256 || null, sizeBytes: p.sizeBytes || null } };
}

async function createWorkshopCase({ vehicleId, title, description, severity, lockType, priority, reporterRole, photo, openedAt, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const v = await getVehicleById(vehicleId);
  if (!v) return { ok: false, error: "vehicle_not_found" };
  const sev = ["critical", "warning", "info"].includes(severity) ? severity : "warning";
  const lt = lockType === "hard" || lockType === "soft" ? lockType : sev === "critical" ? "hard" : "soft";
  const opened = openedAt ? parseIsoDate(openedAt) : new Date();
  if (!opened) return { ok: false, error: "invalid_openedAt" };
  const t = normalizeString(title);
  if (!t) return { ok: false, error: "title_required" };
  const d = normalizeString(description);
  if (!d) return { ok: false, error: "description_required" };
  if (d.length < 20) return { ok: false, error: "description_too_short" };
  const prio = parsePriority(priority) || "medium";
  const role = normalizeReporterRole(reporterRole) || "workshop";
  const parsedPhoto = parseOptionalBase64Photo(photo);
  if (!parsedPhoto.ok) return { ok: false, error: parsedPhoto.error };

  const caseId = `wsc_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = new Date().toISOString();
  await pool.query(
    `
    insert into workshop_case
      (id, vehicle_id, title, description, priority, reporter_role, work_state, interrupted, delivery_delay, assigned_to, assigned_by, assigned_at, photo, severity, lock_type, status, opened_at, closed_at, closed_reason, created_by, created_at)
    values
      ($1, $2, $3, $4, $5, $6, 'created', false, false, null, null, null, $7, $8, $9, 'open', $10, null, null, $11, $12);
    `,
    [caseId, vehicleId, t, d, prio, role, parsedPhoto.photo, sev, lt, opened.toISOString(), username, createdAt],
  );
  await appendWorkshopCaseEvent({ caseId, fromStatus: null, toStatus: "open", reason: "created", username, occurredAt: createdAt, meta: {} });

  const blockId = `blk_ws_${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(
    `
    insert into fleet_availability_block
      (id, vehicle_id, source_module, severity, lock_type, reason, starts_at, ends_at, ref_entity_type, ref_entity_id, created_at)
    values
      ($1, $2, 'workshop', $3, $4, $5, $6, null, 'workshopCase', $7, $8);
    `,
    [blockId, vehicleId, sev, lt, t, opened.toISOString(), caseId, createdAt],
  );

  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WORKSHOP_CASE_CREATED",
    username,
    occurredAt: createdAt,
    lockType: lt,
    blockId,
    vehicleId,
    blockReason: t,
    overrideId: caseId,
    overrideReason: null,
    meta: { title: t, severity: sev, priority: prio, reporterRole: role, photoSha256: parsedPhoto.photo ? parsedPhoto.photo.sha256 : null },
  });

  publishEvent("workshop", "workshop_case_created", { caseId, vehicleId, severity: sev, lockType: lt, priority: prio, openedAt: opened.toISOString() });
  publishEvent("dashboard", "dashboard_changed", { source: "workshop_case_created", caseId, vehicleId });

  return { ok: true, item: { id: caseId, vehicleId, blockId, lockType: lt, severity: sev, priority: prio, reporterRole: role, title: t, openedAt: opened.toISOString(), status: "open" } };
}

async function closeWorkshopCase({ caseId, closedReason, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const c = await getWorkshopCaseById(caseId);
  if (!c) return { ok: false, error: "case_not_found" };
  if (c.status !== "open") return { ok: false, error: "case_not_open" };
  const reason = normalizeString(closedReason);
  if (!reason) return { ok: false, error: "closedReason_required" };
  const occurredAt = new Date().toISOString();
  await pool.query(
    `
    update workshop_case
    set status = 'closed', work_state = 'done', closed_at = $2, closed_reason = $3
    where id = $1;
    `,
    [caseId, occurredAt, reason],
  );
  await appendWorkshopCaseEvent({ caseId, fromStatus: "open", toStatus: "closed", reason, username, occurredAt, meta: {} });

  const rows = await pool
    .query(
      `
      select id
      from fleet_availability_block
      where ref_entity_type = 'workshopCase'
        and ref_entity_id = $1
        and ends_at is null
      order by created_at desc
      limit 1;
      `,
      [caseId],
    )
    .then((r) => r.rows);
  const blockId = rows[0]?.id || null;
  if (blockId) {
    await pool.query(`update fleet_availability_block set ends_at = $2 where id = $1;`, [blockId, occurredAt]);
  }

  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WORKSHOP_CASE_CLOSED",
    username,
    occurredAt,
    lockType: c.lockType,
    blockId,
    vehicleId: c.vehicleId,
    blockReason: c.title,
    overrideId: caseId,
    overrideReason: reason,
    meta: {},
  });

  const updated = await getWorkshopCaseById(caseId);
  publishEvent("workshop", "workshop_case_closed", { caseId, vehicleId: c.vehicleId, closedAt: occurredAt, closedReason: reason });
  publishEvent("dashboard", "dashboard_changed", { source: "workshop_case_closed", caseId, vehicleId: c.vehicleId });
  return { ok: true, item: updated };
}

async function assignWorkshopCase({ caseId, assignedTo, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const c = await getWorkshopCaseById(caseId);
  if (!c) return { ok: false, error: "case_not_found" };
  if (c.status !== "open") return { ok: false, error: "case_not_open" };
  const assignee = normalizeString(assignedTo) || null;
  const occurredAt = new Date().toISOString();
  await pool.query(
    `
    update workshop_case
    set assigned_to = $2,
        assigned_by = $3,
        assigned_at = $4,
        work_state = $5
    where id = $1;
    `,
    [caseId, assignee, username, assignee ? occurredAt : null, assignee ? "assigned" : "created"],
  );
  await appendWorkshopCaseEvent({
    caseId,
    fromStatus: "open",
    toStatus: "open",
    reason: assignee ? "assigned" : "unassigned",
    username,
    occurredAt,
    meta: { assignedTo: assignee },
  });
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: assignee ? "WORKSHOP_CASE_ASSIGNED" : "WORKSHOP_CASE_UNASSIGNED",
    username,
    occurredAt,
    lockType: c.lockType,
    blockId: null,
    vehicleId: c.vehicleId,
    blockReason: c.title,
    overrideId: caseId,
    overrideReason: assignee || null,
    meta: { assignedTo: assignee },
  });
  const updated = await getWorkshopCaseById(caseId);
  publishEvent("workshop", assignee ? "workshop_case_assigned" : "workshop_case_unassigned", { caseId, vehicleId: c.vehicleId, assignedTo: assignee, assignedBy: username, assignedAt: assignee ? occurredAt : null });
  publishEvent("dashboard", "dashboard_changed", { source: "workshop_case_assigned", caseId, vehicleId: c.vehicleId });
  return { ok: true, item: updated };
}

async function setWorkshopCaseState({ caseId, workState, interrupted, deliveryDelay, reason, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const c = await getWorkshopCaseById(caseId);
  if (!c) return { ok: false, error: "case_not_found" };
  if (c.status !== "open") return { ok: false, error: "case_not_open" };
  const ws = normalizeString(workState);
  if (!["created", "assigned", "in_progress", "waiting_parts", "done"].includes(ws)) return { ok: false, error: "invalid_workState" };
  const r = normalizeString(reason) || "state_changed";
  const occurredAt = new Date().toISOString();
  const intr = interrupted === true;
  const delay = deliveryDelay === true;

  if (ws === "done") {
    await pool.query(
      `
      update workshop_case
      set work_state = 'done',
          interrupted = $2,
          delivery_delay = $3,
          status = 'closed',
          closed_at = $4,
          closed_reason = $5
      where id = $1;
      `,
      [caseId, intr, delay, occurredAt, r],
    );
    const rows = await pool
      .query(
        `
        select id
        from fleet_availability_block
        where ref_entity_type = 'workshopCase'
          and ref_entity_id = $1
          and ends_at is null
        order by created_at desc
        limit 1;
        `,
        [caseId],
      )
      .then((x) => x.rows);
    const blockId = rows[0]?.id || null;
    if (blockId) await pool.query(`update fleet_availability_block set ends_at = $2 where id = $1;`, [blockId, occurredAt]);
  } else {
    await pool.query(
      `
      update workshop_case
      set work_state = $2,
          interrupted = $3,
          delivery_delay = $4
      where id = $1;
      `,
      [caseId, ws, intr, delay],
    );
  }

  await appendWorkshopCaseEvent({
    caseId,
    fromStatus: "open",
    toStatus: "open",
    reason: r,
    username,
    occurredAt,
    meta: { workState: ws, interrupted: intr, deliveryDelay: delay },
  });

  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WORKSHOP_CASE_STATE_CHANGED",
    username,
    occurredAt,
    lockType: c.lockType,
    blockId: null,
    vehicleId: c.vehicleId,
    blockReason: c.title,
    overrideId: caseId,
    overrideReason: r,
    meta: { workState: ws, interrupted: intr, deliveryDelay: delay },
  });

  const updated = await getWorkshopCaseById(caseId);
  publishEvent("workshop", "workshop_case_state_changed", { caseId, vehicleId: c.vehicleId, workState: ws, interrupted: intr, deliveryDelay: delay, reason: r, occurredAt });
  publishEvent("dashboard", "dashboard_changed", { source: "workshop_case_state_changed", caseId, vehicleId: c.vehicleId });
  return { ok: true, item: updated };
}

async function upsertWorkshopMaintenanceRule({ vehicleType, serviceCode, kmInterval, daysInterval, hoursInterval, active, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const vt = normalizeString(vehicleType);
  const sc = normalizeString(serviceCode) || "maintenance";
  if (!vt) return { ok: false, error: "vehicleType_required" };
  const km = kmInterval === null || kmInterval === undefined || kmInterval === "" ? null : Number(kmInterval);
  const days = daysInterval === null || daysInterval === undefined || daysInterval === "" ? null : Number(daysInterval);
  const hrs = hoursInterval === null || hoursInterval === undefined || hoursInterval === "" ? null : Number(hoursInterval);
  if (km !== null && (!Number.isFinite(km) || km <= 0)) return { ok: false, error: "invalid_kmInterval" };
  if (days !== null && (!Number.isFinite(days) || days <= 0)) return { ok: false, error: "invalid_daysInterval" };
  if (hrs !== null && (!Number.isFinite(hrs) || hrs <= 0)) return { ok: false, error: "invalid_hoursInterval" };
  const a = active === false ? false : true;
  const id = `wmr_${crypto.randomUUID().slice(0, 12)}`;
  const occurredAt = new Date().toISOString();
  await pool.query(
    `
    insert into workshop_maintenance_rule
      (id, vehicle_type, service_code, km_interval, days_interval, hours_interval, active, updated_at)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8)
    on conflict (vehicle_type, service_code) do update
      set km_interval = excluded.km_interval,
          days_interval = excluded.days_interval,
          hours_interval = excluded.hours_interval,
          active = excluded.active,
          updated_at = excluded.updated_at;
    `,
    [id, vt, sc, km === null ? null : Math.round(km), days === null ? null : Math.round(days), hrs, a, occurredAt],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WORKSHOP_MAINTENANCE_RULE_SET",
    username,
    occurredAt,
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: `${vt}:${sc}`,
    overrideReason: null,
    meta: { vehicleType: vt, serviceCode: sc, kmInterval: km === null ? null : Math.round(km), daysInterval: days === null ? null : Math.round(days), hoursInterval: hrs, active: a },
  });
  return { ok: true };
}

async function recordWorkshopVehicleMeter({ vehicleId, km, engineHours, recordedAt, source, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const v = await getVehicleById(vehicleId);
  if (!v) return { ok: false, error: "vehicle_not_found" };
  const k = km === null || km === undefined || km === "" ? null : Number(km);
  const h = engineHours === null || engineHours === undefined || engineHours === "" ? null : Number(engineHours);
  if (k !== null && (!Number.isFinite(k) || k < 0)) return { ok: false, error: "invalid_km" };
  if (h !== null && (!Number.isFinite(h) || h < 0)) return { ok: false, error: "invalid_engineHours" };
  const rAt = recordedAt ? parseIsoDate(recordedAt) : new Date();
  if (!rAt) return { ok: false, error: "invalid_recordedAt" };
  const src = normalizeString(source) || "manual";
  const id = `wm_${crypto.randomUUID().slice(0, 12)}`;
  const occurredAt = new Date().toISOString();
  await pool.query(
    `
    insert into workshop_vehicle_meter
      (id, vehicle_id, km, engine_hours, recorded_at, source, username, created_at)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8);
    `,
    [id, vehicleId, k === null ? null : Math.round(k), h === null ? null : h, rAt.toISOString(), src, username, occurredAt],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WORKSHOP_METER_RECORDED",
    username,
    occurredAt,
    lockType: null,
    blockId: null,
    vehicleId,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: { km: k === null ? null : Math.round(k), engineHours: h === null ? null : h, recordedAt: rAt.toISOString(), source: src },
  });
  return { ok: true, item: { id, vehicleId, km: k === null ? null : Math.round(k), engineHours: h === null ? null : h, recordedAt: rAt.toISOString() } };
}

async function recordWorkshopVehicleService({ vehicleId, serviceCode, km, engineHours, servicedAt, username }) {
  if (!pool) return { ok: false, error: "db_required" };
  const v = await getVehicleById(vehicleId);
  if (!v) return { ok: false, error: "vehicle_not_found" };
  const sc = normalizeString(serviceCode) || "maintenance";
  const k = km === null || km === undefined || km === "" ? null : Number(km);
  const h = engineHours === null || engineHours === undefined || engineHours === "" ? null : Number(engineHours);
  if (k !== null && (!Number.isFinite(k) || k < 0)) return { ok: false, error: "invalid_km" };
  if (h !== null && (!Number.isFinite(h) || h < 0)) return { ok: false, error: "invalid_engineHours" };
  const sAt = servicedAt ? parseIsoDate(servicedAt) : new Date();
  if (!sAt) return { ok: false, error: "invalid_servicedAt" };
  const id = `wsr_${crypto.randomUUID().slice(0, 12)}`;
  const occurredAt = new Date().toISOString();
  await pool.query(
    `
    insert into workshop_vehicle_service
      (id, vehicle_id, service_code, km, engine_hours, serviced_at, username, created_at)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8);
    `,
    [id, vehicleId, sc, k === null ? null : Math.round(k), h === null ? null : h, sAt.toISOString(), username, occurredAt],
  );
  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "WORKSHOP_SERVICE_RECORDED",
    username,
    occurredAt,
    lockType: null,
    blockId: null,
    vehicleId,
    blockReason: null,
    overrideId: id,
    overrideReason: null,
    meta: { serviceCode: sc, km: k === null ? null : Math.round(k), engineHours: h === null ? null : h, servicedAt: sAt.toISOString() },
  });
  return { ok: true, item: { id, vehicleId, serviceCode: sc, km: k === null ? null : Math.round(k), engineHours: h === null ? null : h, servicedAt: sAt.toISOString() } };
}

async function getWorkshopMaintenanceStatus({ vehicleId, serviceCode }) {
  if (!pool) return { ok: false, error: "db_required" };
  const v = await getVehicleById(vehicleId);
  if (!v) return { ok: false, error: "vehicle_not_found" };
  const sc = normalizeString(serviceCode) || "maintenance";
  const ruleRows = await pool
    .query(
      `
      select vehicle_type, service_code, km_interval, days_interval, hours_interval, active, updated_at
      from workshop_maintenance_rule
      where vehicle_type = $1 and service_code = $2 and active = true
      limit 1;
      `,
      [v.type, sc],
    )
    .then((r) => r.rows);
  const rule = ruleRows[0] || null;
  if (!rule) return { ok: true, item: { vehicleId, vehicleType: v.type, serviceCode: sc, available: false } };

  const meterRows = await pool
    .query(
      `
      select km, engine_hours, recorded_at
      from workshop_vehicle_meter
      where vehicle_id = $1
      order by recorded_at desc
      limit 1;
      `,
      [vehicleId],
    )
    .then((r) => r.rows);
  const meter = meterRows[0] || null;

  const serviceRows = await pool
    .query(
      `
      select km, engine_hours, serviced_at
      from workshop_vehicle_service
      where vehicle_id = $1 and service_code = $2
      order by serviced_at desc
      limit 1;
      `,
      [vehicleId, sc],
    )
    .then((r) => r.rows);
  const last = serviceRows[0] || null;

  const currentKm = meter && meter.km !== null ? Number(meter.km) : null;
  const lastKm = last && last.km !== null ? Number(last.km) : null;
  const kmInterval = rule.km_interval === null ? null : Number(rule.km_interval);
  const dueInKm = kmInterval !== null && currentKm !== null && lastKm !== null ? kmInterval - (currentKm - lastKm) : null;
  const dueKm = dueInKm !== null ? dueInKm <= 0 : false;

  const now = new Date();
  const lastDate = last ? new Date(last.serviced_at) : null;
  const daysInterval = rule.days_interval === null ? null : Number(rule.days_interval);
  const dueInDays = daysInterval !== null && lastDate ? daysInterval - Math.floor((now - lastDate) / (24 * 60 * 60 * 1000)) : null;
  const dueDays = dueInDays !== null ? dueInDays <= 0 : false;

  const currentHours = meter && meter.engine_hours !== null ? Number(meter.engine_hours) : null;
  const lastHours = last && last.engine_hours !== null ? Number(last.engine_hours) : null;
  const hoursInterval = rule.hours_interval === null ? null : Number(rule.hours_interval);
  const dueInHours = hoursInterval !== null && currentHours !== null && lastHours !== null ? hoursInterval - (currentHours - lastHours) : null;
  const dueHours = dueInHours !== null ? dueInHours <= 0 : false;

  const due = dueKm || dueDays || dueHours;

  return {
    ok: true,
    item: {
      vehicleId,
      vehicleType: v.type,
      serviceCode: sc,
      available: true,
      due,
      current: { km: currentKm, engineHours: currentHours, recordedAt: meter ? new Date(meter.recorded_at).toISOString() : null },
      lastService: { km: lastKm, engineHours: lastHours, servicedAt: last ? new Date(last.serviced_at).toISOString() : null },
      rule: { kmInterval, daysInterval, hoursInterval },
      dueIn: { km: dueInKm, days: dueInDays, hours: dueInHours },
    },
  };
}

const extraCaCacheByHost = new Map();

function readExtraCaPemFromEnv() {
  const path = process.env.ERP_EXTRA_CA_PEM_PATH ? String(process.env.ERP_EXTRA_CA_PEM_PATH) : "";
  if (path.trim()) {
    try {
      const pem = fs.readFileSync(path.trim(), "utf8").trim();
      return pem || null;
    } catch {
      return null;
    }
  }
  const b64 = process.env.ERP_EXTRA_CA_PEM_BASE64 ? String(process.env.ERP_EXTRA_CA_PEM_BASE64) : "";
  if (!b64) return null;
  try {
    const pem = Buffer.from(b64, "base64").toString("utf8").trim();
    return pem || null;
  } catch {
    return null;
  }
}

function getProxyUrlFromEnv() {
  const raw =
    (process.env.ERP_HTTPS_PROXY ? String(process.env.ERP_HTTPS_PROXY) : "") ||
    (process.env.HTTPS_PROXY ? String(process.env.HTTPS_PROXY) : "") ||
    (process.env.HTTP_PROXY ? String(process.env.HTTP_PROXY) : "");
  return raw.trim() || null;
}

async function fetchBinary(url, { caPemList = [], proxyUrl = null } = {}) {
  const baseRoots = Array.isArray(tls.rootCertificates) ? tls.rootCertificates : [];
  const caAll = [...baseRoots, ...(Array.isArray(caPemList) ? caPemList.filter(Boolean) : [])];
  const ca = caAll.length ? caAll.join("\n") : undefined;

  async function openTlsSocket({ hostname, port, rejectUnauthorized }) {
    if (!proxyUrl) {
      return await new Promise((resolve, reject) => {
        const s = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized, ca });
        s.once("secureConnect", () => resolve(s));
        s.once("error", reject);
      });
    }

    const proxy = new URL(proxyUrl);
    const proxyPort = proxy.port ? Number(proxy.port) : 3128;
    const socket = net.connect(proxyPort, proxy.hostname);
    socket.setTimeout(20_000);

    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("proxy_timeout")));
      socket.once("connect", resolve);
    });

    const auth = proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || "")}`).toString("base64")}\r\n`
      : "";
    socket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n${auth}Connection: keep-alive\r\n\r\n`);

    await new Promise((resolve, reject) => {
      let buf = "";
      const onData = (chunk) => {
        buf += chunk.toString("utf8");
        if (!buf.includes("\r\n\r\n")) return;
        socket.off("data", onData);
        const firstLine = buf.split("\r\n")[0] || "";
        const m = firstLine.match(/HTTP\/\d+\.\d+\s+(\d+)/i);
        const status = m ? Number(m[1]) : 0;
        if (status !== 200) return reject(new Error(`proxy_connect_failed_${status}`));
        resolve();
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("proxy_timeout")));
    });

    return await new Promise((resolve, reject) => {
      const s = tls.connect({ socket, servername: hostname, rejectUnauthorized, ca });
      s.once("secureConnect", () => resolve(s));
      s.once("error", reject);
    });
  }

  function parseHeaders(headerText) {
    const lines = headerText.split("\r\n");
    const first = lines.shift() || "";
    const m = first.match(/HTTP\/\d+\.\d+\s+(\d+)/i);
    const status = m ? Number(m[1]) : 0;
    const headers = {};
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const k = line.slice(0, idx).trim().toLowerCase();
      const v = line.slice(idx + 1).trim();
      if (headers[k]) headers[k] = `${headers[k]}, ${v}`;
      else headers[k] = v;
    }
    return { status, headers };
  }

  function decodeChunked(buffer) {
    let offset = 0;
    const chunks = [];
    while (offset < buffer.length) {
      const lineEnd = buffer.indexOf("\r\n", offset);
      if (lineEnd === -1) break;
      const sizeHex = buffer.slice(offset, lineEnd).toString("utf8").trim();
      const size = parseInt(sizeHex, 16);
      if (!Number.isFinite(size) || size < 0) break;
      offset = lineEnd + 2;
      if (size === 0) break;
      chunks.push(buffer.slice(offset, offset + size));
      offset += size + 2;
    }
    return Buffer.concat(chunks);
  }

  async function requestOnce(u) {
    const target = new URL(u);
    const isHttps = target.protocol === "https:";
    const port = target.port ? Number(target.port) : isHttps ? 443 : 80;
    const hostname = target.hostname;
    const path = `${target.pathname}${target.search}`;

    const headers = {
      "user-agent": "AhlertERP-Reconcile/1.0 (+https://www.ahlert24.de/)",
      accept: "text/html,application/xhtml+xml,application/pkix-cert,application/octet-stream,*/*",
      host: hostname,
      connection: "close",
    };

    if (!isHttps) {
      return await new Promise((resolve, reject) => {
        const req = http.request({ hostname, port, path, method: "GET", headers }, (res) => {
          const status = res.statusCode || 0;
          const location = res.headers.location ? String(res.headers.location) : "";
          if ([301, 302, 303, 307, 308].includes(status) && location) {
            res.resume();
            const next = new URL(location, target).toString();
            return resolve({ redirectTo: next, status });
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status, body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.end();
      });
    }

    const socket = await openTlsSocket({ hostname, port, rejectUnauthorized: true });
    const reqText = `GET ${path} HTTP/1.1\r\n${Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n")}\r\n\r\n`;
    socket.write(reqText, "utf8");

    const raw = await new Promise((resolve, reject) => {
      const chunks = [];
      socket.on("data", (c) => chunks.push(c));
      socket.once("end", () => resolve(Buffer.concat(chunks)));
      socket.once("error", reject);
    });

    const sep = raw.indexOf("\r\n\r\n");
    if (sep === -1) throw new Error("invalid_http_response");
    const headerText = raw.slice(0, sep).toString("utf8");
    const bodyPart = raw.slice(sep + 4);
    const { status, headers: parsedHeaders } = parseHeaders(headerText);
    const location = parsedHeaders.location ? String(parsedHeaders.location) : "";
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      const next = new URL(location, target).toString();
      return { redirectTo: next, status };
    }

    const transfer = (parsedHeaders["transfer-encoding"] || "").toLowerCase();
    const contentLength = parsedHeaders["content-length"] ? Number(parsedHeaders["content-length"]) : null;
    const body =
      transfer.includes("chunked")
        ? decodeChunked(bodyPart)
        : contentLength !== null && Number.isFinite(contentLength)
          ? bodyPart.slice(0, contentLength)
          : bodyPart;

    return { status, body };
  }

  let current = url;
  for (let i = 0; i < 5; i++) {
    const r = await requestOnce(current);
    if (r && r.redirectTo) {
      current = r.redirectTo;
      continue;
    }
    return r;
  }
  throw new Error("fetch_too_many_redirects");
}

async function discoverIntermediateCaPemForHost(hostname, { proxyUrl = null } = {}) {
  if (extraCaCacheByHost.has(hostname)) return extraCaCacheByHost.get(hostname);

  const caFromEnv = readExtraCaPemFromEnv();
  const caPemList = caFromEnv ? [caFromEnv] : [];

  const connectInsecure = () =>
    new Promise((resolve, reject) => {
      const ca = caPemList.length ? caPemList.join("\n") : undefined;
      const port = 443;

      const finalize = (secure) => {
        try {
          const peer = secure.getPeerCertificate(true);
          if (!peer || !peer.raw) return reject(new Error("no_peer_cert"));
          const x509 = new crypto.X509Certificate(peer.raw);
          const info = String(x509.infoAccess || "");
          const issuerUrls = [];
          for (const line of info.split("\n")) {
            const m = line.match(/CA Issuers - URI:([^\s]+)/i);
            if (m) issuerUrls.push(m[1]);
          }
          resolve({ issuerUrls });
        } catch (e) {
          reject(e);
        } finally {
          secure.end();
        }
      };

      if (!proxyUrl) {
        const secure = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false, ca });
        secure.once("secureConnect", () => finalize(secure));
        secure.once("error", reject);
        return;
      }

      const proxy = new URL(proxyUrl);
      const proxyPort = proxy.port ? Number(proxy.port) : 3128;
      const socket = net.connect(proxyPort, proxy.hostname);
      socket.on("error", reject);
      socket.on("connect", () => {
        const auth = proxy.username
          ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || "")}`).toString("base64")}\r\n`
          : "";
        socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n${auth}Connection: close\r\n\r\n`);
      });
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (!buf.includes("\r\n\r\n")) return;
        socket.removeAllListeners("data");
        const firstLine = buf.split("\r\n")[0] || "";
        const m = firstLine.match(/HTTP\/\d+\.\d+\s+(\d+)/i);
        const status = m ? Number(m[1]) : 0;
        if (status !== 200) return reject(new Error(`proxy_connect_failed_${status}`));
        const secure = tls.connect({ socket, servername: hostname, rejectUnauthorized: false, ca });
        secure.once("secureConnect", () => finalize(secure));
        secure.once("error", reject);
      });
    });

  const { issuerUrls } = await connectInsecure();
  const pemParts = [];

  for (const issuerUrl of issuerUrls.slice(0, 3)) {
    try {
      const r = await fetchBinary(issuerUrl, { caPemList, proxyUrl });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.length) {
        const b64 = r.body.toString("base64").match(/.{1,64}/g)?.join("\n") || "";
        pemParts.push(`-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`);
      }
    } catch {
      continue;
    }
  }

  const pem = pemParts.length ? pemParts.join("\n") : null;
  extraCaCacheByHost.set(hostname, pem);
  return pem;
}

async function fetchWebsiteText(url) {
  const proxyUrl = getProxyUrlFromEnv();
  const caFromEnv = readExtraCaPemFromEnv();
  const caPemList = caFromEnv ? [caFromEnv] : [];

  try {
    const r = await fetchBinary(url, { caPemList, proxyUrl });
    if (r.status < 200 || r.status >= 300) throw new Error(`fetch_failed_${r.status}`);
    return stripHtmlToText(r.body.toString("utf8"));
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    if (!/unable to verify the first certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to get issuer certificate/i.test(message)) throw e;

    const host = new URL(url).hostname;
    const intermediatePem = await discoverIntermediateCaPemForHost(host, { proxyUrl });
    if (!intermediatePem) throw e;

    const r = await fetchBinary(url, { caPemList: [...caPemList, intermediatePem], proxyUrl });
    if (r.status < 200 || r.status >= 300) throw new Error(`fetch_failed_${r.status}`);
    return stripHtmlToText(r.body.toString("utf8"));
  }
}

function prioritizeFinding({ category, issue }) {
  if (category === "container" && (issue === "missing_in_erp" || issue === "mismatch")) return "high";
  if (category === "service_area_zip" && issue === "missing_in_erp") return "medium";
  if (issue === "invalid_erp") return "high";
  return "low";
}

async function runAhlert24Reconcile({ requestedBy, mode = "live" }) {
  const source = {
    containerOverviewUrl: "https://www.ahlert24.de/container-service/container-uebersicht/",
    faqUrl: "https://www.ahlert24.de/info-service-faq/",
    mode,
  };

  const startedAt = new Date();
  const containerText =
    mode === "mock"
      ? `
        Unsere Container im Überblick
        Absetzcontainer
        7 cbm
        mit Klappe
        Größe: ca. L 3,60 x B 1,90 x H 1,40 m
        Standfläche: ca. 11,00 qm
        Abrollcontainer
        12 cbm
        Bauschuttmulde
        Größe: ca. L 7,00 x B 2,30 x H 0,75 m
        Standfläche: ca. 21,00 qm
      `
      : await fetchWebsiteText(source.containerOverviewUrl);

  const faqText =
    mode === "mock"
      ? `
        In welchen Postleitzahlengebieten wird DER SACK von Ahlert abgeholt?
        46325, 46342, 48143
        Darf DER SACK überall aufgestellt werden?
      `
      : await fetchWebsiteText(source.faqUrl);

  const webContainers = extractContainerCatalogFromText(containerText, source.containerOverviewUrl);
  const webZips = extractDerSackZipCodesFromText(faqText, source.faqUrl);

  const erpContainers = await getErpCatalogContainers();
  const erpZips = await getErpServiceAreaZips("der_sack");

  const findings = [];

  const containerDiff = diffByKey({
    webItems: webContainers,
    erpItems: erpContainers,
    keyFn: (x) => x.sourceKey,
    compareFn: (w, e) => {
      const diffs = {};
      const tolM = 0.05;
      const tolSqm = 0.2;
      if (w.lengthM !== null && e.lengthM !== null && Math.abs(w.lengthM - e.lengthM) > tolM) diffs.lengthM = { web: w.lengthM, erp: e.lengthM };
      if (w.widthM !== null && e.widthM !== null && Math.abs(w.widthM - e.widthM) > tolM) diffs.widthM = { web: w.widthM, erp: e.widthM };
      if (w.heightM !== null && e.heightM !== null && Math.abs(w.heightM - e.heightM) > tolM) diffs.heightM = { web: w.heightM, erp: e.heightM };
      if (w.footprintSqm !== null && e.footprintSqm !== null && Math.abs(w.footprintSqm - e.footprintSqm) > tolSqm) diffs.footprintSqm = { web: w.footprintSqm, erp: e.footprintSqm };
      if (w.groupKey !== e.groupKey) diffs.groupKey = { web: w.groupKey, erp: e.groupKey };
      return Object.keys(diffs).length ? diffs : null;
    },
  });

  for (const m of containerDiff.missingInErp) {
    findings.push({
      category: "container",
      issue: "missing_in_erp",
      itemKey: m.key,
      severity: prioritizeFinding({ category: "container", issue: "missing_in_erp" }),
      details: m.web,
    });
  }
  for (const m of containerDiff.extraInErp) {
    findings.push({
      category: "container",
      issue: "extra_in_erp",
      itemKey: m.key,
      severity: prioritizeFinding({ category: "container", issue: "extra_in_erp" }),
      details: m.erp,
    });
  }
  for (const m of containerDiff.mismatched) {
    findings.push({
      category: "container",
      issue: "mismatch",
      itemKey: m.key,
      severity: prioritizeFinding({ category: "container", issue: "mismatch" }),
      details: { diff: m.diff, web: m.web, erp: m.erp },
    });
  }

  const zipDiff = diffByKey({
    webItems: webZips,
    erpItems: erpZips,
    keyFn: (x) => `${x.service}:${x.zip}`,
    compareFn: () => null,
  });

  for (const m of zipDiff.missingInErp) {
    findings.push({
      category: "service_area_zip",
      issue: "missing_in_erp",
      itemKey: m.key,
      severity: prioritizeFinding({ category: "service_area_zip", issue: "missing_in_erp" }),
      details: m.web,
    });
  }
  for (const m of zipDiff.extraInErp) {
    findings.push({
      category: "service_area_zip",
      issue: "extra_in_erp",
      itemKey: m.key,
      severity: prioritizeFinding({ category: "service_area_zip", issue: "extra_in_erp" }),
      details: m.erp,
    });
  }

  const finishedAt = new Date();
  const summary = {
    counts: {
      web: { containers: webContainers.length, derSackZips: webZips.length },
      erp: { containers: erpContainers.length, derSackZips: erpZips.length },
      findings: {
        total: findings.length,
        high: findings.filter((f) => f.severity === "high").length,
        medium: findings.filter((f) => f.severity === "medium").length,
        low: findings.filter((f) => f.severity === "low").length,
      },
    },
    recommendations: {
      schedule: {
        suggested: "wöchentlich",
        cronExample: "15 3 * * 1 curl -s -X POST http://localhost/api/reconcile/ahlert24/run -H 'x-user: system' -H 'x-permissions: FLEET_ADMIN' -H 'content-type: application/json' --data '{\"mode\":\"live\"}'",
      },
    },
  };

  return {
    source,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    web: { containers: webContainers, derSackZips: webZips },
    erp: { containers: erpContainers, derSackZips: erpZips },
    findings: findings.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity]) - ({ high: 0, medium: 1, low: 2 }[b.severity])),
    summary,
  };
}

function containerCatalogHash(item) {
  const { features, rules } = deriveContainerFeaturesAndRules(item.variant || "");
  const normalized = {
    groupKey: item.groupKey,
    volumeCbm: item.volumeCbm,
    variant: item.variant || "",
    lengthM: item.lengthM,
    widthM: item.widthM,
    heightM: item.heightM,
    footprintSqm: item.footprintSqm,
    baseAreaSqm: computeBaseAreaSqm({ lengthM: item.lengthM, widthM: item.widthM }),
    features,
    rules,
    sourceUrl: item.sourceUrl,
  };
  return stableHash(JSON.stringify(normalized));
}

async function applyAhlert24CatalogSync({ runId, result, actor }) {
  if (!pool) return { containers: { added: 0, updated: 0, removed: 0 }, derSackZips: { added: 0, removed: 0 } };
  const occurredAt = result.finishedAt;

  const erpContainerMap = new Map((result.erp?.containers || []).map((c) => [c.sourceKey, c]));
  const webContainerMap = new Map((result.web?.containers || []).map((c) => [c.sourceKey, c]));

  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const c of result.web?.containers || []) {
    const { features, rules } = deriveContainerFeaturesAndRules(c.variant || "");
    const sourceHash = containerCatalogHash(c);
    const baseAreaSqm = computeBaseAreaSqm({ lengthM: c.lengthM, widthM: c.widthM });
    const existing = erpContainerMap.get(c.sourceKey) || null;
    const isNew = !existing;
    const isChanged = existing ? existing.sourceHash !== sourceHash : false;

    await pool.query(
      `
      insert into catalog_container
        (id, source_key, group_key, volume_cbm, variant, length_m, width_m, height_m, footprint_sqm, base_area_sqm, features, rules, active, source_url, source_hash, first_seen, last_seen)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $14, now(), now())
      on conflict (source_key) do update
        set group_key = excluded.group_key,
            volume_cbm = excluded.volume_cbm,
            variant = excluded.variant,
            length_m = excluded.length_m,
            width_m = excluded.width_m,
            height_m = excluded.height_m,
            footprint_sqm = excluded.footprint_sqm,
            base_area_sqm = excluded.base_area_sqm,
            features = excluded.features,
            rules = excluded.rules,
            active = true,
            source_url = excluded.source_url,
            source_hash = excluded.source_hash,
            last_seen = now();
      `,
      [
        `cc_${crypto.randomUUID().slice(0, 12)}`,
        c.sourceKey,
        c.groupKey,
        c.volumeCbm,
        c.variant || "",
        c.lengthM,
        c.widthM,
        c.heightM,
        c.footprintSqm,
        baseAreaSqm,
        features,
        rules,
        c.sourceUrl,
        sourceHash,
      ],
    );

    if (isNew || isChanged) {
      const action = isNew ? "added" : "updated";
      await pool.query(
        `
        insert into catalog_container_event (id, run_id, action, source_key, occurred_at, details)
        values ($1, $2, $3, $4, $5, $6);
        `,
        [
          `cce_${crypto.randomUUID().slice(0, 12)}`,
          runId,
          action,
          c.sourceKey,
          occurredAt,
          { web: c, features, rules, sourceHash },
        ],
      );

      if (action === "added") added += 1;
      else updated += 1;

      await upsertWorkItem({
        kind: "catalog_container",
        itemKey: c.sourceKey,
        priority: "high",
        title: action === "added" ? "Neuer Container/Behälter aus Web-Angebot" : "Geänderter Container/Behälter aus Web-Angebot",
        details: { action, sourceKey: c.sourceKey, groupKey: c.groupKey, volumeCbm: c.volumeCbm, variant: c.variant || "", measures: { lengthM: c.lengthM, widthM: c.widthM, heightM: c.heightM, footprintSqm: c.footprintSqm, baseAreaSqm } },
        sourceRunId: runId,
      });
    }
  }

  for (const [sourceKey, erp] of erpContainerMap.entries()) {
    if (!erp.active) continue;
    if (webContainerMap.has(sourceKey)) continue;
    await pool.query(`update catalog_container set active = false where source_key = $1;`, [sourceKey]);
    await pool.query(
      `
      insert into catalog_container_event (id, run_id, action, source_key, occurred_at, details)
      values ($1, $2, 'removed', $3, $4, $5);
      `,
      [`cce_${crypto.randomUUID().slice(0, 12)}`, runId, sourceKey, occurredAt, { erp }],
    );
    removed += 1;
    await upsertWorkItem({
      kind: "catalog_container_removed",
      itemKey: sourceKey,
      priority: "high",
      title: "Container/Behälter ist nicht mehr im Web-Angebot",
      details: { sourceKey, previous: erp },
      sourceRunId: runId,
    });
  }

  const service = "der_sack";
  const erpZipMap = new Map((result.erp?.derSackZips || []).map((z) => [`${z.service}:${z.zip}`, z]));
  const webZipSet = new Set((result.web?.derSackZips || []).map((z) => `${z.service}:${z.zip}`));
  let zipAdded = 0;
  let zipRemoved = 0;
  for (const z of result.web?.derSackZips || []) {
    const key = `${z.service}:${z.zip}`;
    const existing = erpZipMap.get(key) || null;
    const sourceHash = stableHash(`${z.service}:${z.zip}:${z.sourceUrl}`);
    if (!existing || !existing.active) {
      zipAdded += 1;
      await pool.query(
        `
        insert into catalog_service_area_zip (id, service, zip, active, source_url, source_hash, first_seen, last_seen)
        values ($1, $2, $3, true, $4, $5, now(), now())
        on conflict (service, zip) do update
          set active = true,
              source_url = excluded.source_url,
              source_hash = excluded.source_hash,
              last_seen = now();
        `,
        [`saz_${crypto.randomUUID().slice(0, 12)}`, z.service, z.zip, z.sourceUrl, sourceHash],
      );
      await pool.query(
        `
        insert into catalog_service_area_zip_event (id, run_id, service, zip, action, occurred_at, details)
        values ($1, $2, $3, $4, 'added', $5, $6);
        `,
        [`saze_${crypto.randomUUID().slice(0, 12)}`, runId, z.service, z.zip, occurredAt, { web: z }],
      );
      await upsertWorkItem({
        kind: "service_area_zip",
        itemKey: key,
        priority: "medium",
        title: "Neues Servicegebiet (PLZ) aus Web-Angebot",
        details: { service: z.service, zip: z.zip, sourceUrl: z.sourceUrl },
        sourceRunId: runId,
      });
    } else {
      await pool.query(`update catalog_service_area_zip set last_seen = now(), source_url = $3, source_hash = $4 where service = $1 and zip = $2;`, [
        z.service,
        z.zip,
        z.sourceUrl,
        sourceHash,
      ]);
    }
  }

  for (const [key, erp] of erpZipMap.entries()) {
    if (!erp.active) continue;
    if (webZipSet.has(key)) continue;
    zipRemoved += 1;
    await pool.query(`update catalog_service_area_zip set active = false where service = $1 and zip = $2;`, [erp.service, erp.zip]);
    await pool.query(
      `
      insert into catalog_service_area_zip_event (id, run_id, service, zip, action, occurred_at, details)
      values ($1, $2, $3, $4, 'removed', $5, $6);
      `,
      [`saze_${crypto.randomUUID().slice(0, 12)}`, runId, erp.service, erp.zip, occurredAt, { erp }],
    );
    await upsertWorkItem({
      kind: "service_area_zip_removed",
      itemKey: key,
      priority: "medium",
      title: "Servicegebiet (PLZ) ist nicht mehr im Web-Angebot",
      details: { service: erp.service, zip: erp.zip },
      sourceRunId: runId,
    });
  }

  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "CATALOG_SYNC_APPLIED",
    username: actor,
    occurredAt,
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: runId,
    overrideReason: null,
    meta: { containers: { added, updated, removed }, derSackZips: { added: zipAdded, removed: zipRemoved } },
  });

  return { containers: { added, updated, removed }, derSackZips: { added: zipAdded, removed: zipRemoved } };
}

async function persistReconcileResult({ requestedBy, result }) {
  if (!pool) return null;
  const runId = `rec_${crypto.randomUUID().slice(0, 12)}`;
  const startedAt = result.startedAt;
  const finishedAt = result.finishedAt;
  await pool.query(
    `
    insert into reconcile_run
      (id, kind, requested_by, started_at, finished_at, source, summary)
    values
      ($1, $2, $3, $4, $5, $6, $7);
    `,
    [runId, "ahlert24_offer_vs_erp", requestedBy, startedAt, finishedAt, result.source, result.summary],
  );

  for (const f of result.findings) {
    const id = `rf_${crypto.randomUUID().slice(0, 12)}`;
    await pool.query(
      `
      insert into reconcile_finding
        (id, run_id, severity, category, item_key, issue, details, created_at)
      values
        ($1, $2, $3, $4, $5, $6, $7, now());
      `,
      [id, runId, f.severity, f.category, f.itemKey, f.issue, f.details || {}],
    );
  }

  await insertAuditLog({
    id: `al_${crypto.randomUUID()}`,
    eventType: "RECONCILE_RUN_CREATED",
    username: requestedBy,
    occurredAt: finishedAt,
    lockType: null,
    blockId: null,
    vehicleId: null,
    blockReason: null,
    overrideId: runId,
    overrideReason: null,
    meta: { kind: "ahlert24_offer_vs_erp", summary: result.summary, source: result.source },
  });
  await publishErpEvent({
    eventType: "RECONCILE_RUN_CREATED",
    aggregateType: "reconcile_run",
    aggregateId: runId,
    sourceModule: "import",
    occurredAt: finishedAt,
    createdBy: requestedBy,
    partitionKey: "ahlert24_offer_vs_erp",
    payload: { runId, kind: "ahlert24_offer_vs_erp", summary: result.summary, findingCount: Array.isArray(result.findings) ? result.findings.length : 0 },
  });

  return runId;
}

async function getReconcileRunById(id) {
  if (!pool) return null;
  const runRows = await pool
    .query(`select id, kind, requested_by, started_at, finished_at, source, summary from reconcile_run where id = $1;`, [id])
    .then((r) => r.rows);
  const run = runRows[0];
  if (!run) return null;
  const findingRows = await pool
    .query(
      `select id, severity, category, item_key, issue, details, created_at from reconcile_finding where run_id = $1 order by severity asc, category asc;`,
      [id],
    )
    .then((r) => r.rows);
  return {
    id: run.id,
    kind: run.kind,
    requestedBy: run.requested_by,
    startedAt: new Date(run.started_at).toISOString(),
    finishedAt: new Date(run.finished_at).toISOString(),
    source: run.source || {},
    summary: run.summary || {},
    findings: findingRows.map((f) => ({
      id: f.id,
      severity: f.severity,
      category: f.category,
      itemKey: f.item_key,
      issue: f.issue,
      details: f.details || {},
      createdAt: new Date(f.created_at).toISOString(),
    })),
  };
}

async function listReconcileRuns(limit = 20) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = await pool
    .query(
      `select id, kind, requested_by, started_at, finished_at, source, summary from reconcile_run where kind = $1 order by finished_at desc limit $2;`,
      ["ahlert24_offer_vs_erp", n],
    )
    .then((r) => r.rows);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    requestedBy: r.requested_by,
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: new Date(r.finished_at).toISOString(),
    source: r.source || {},
    summary: r.summary || {},
  }));
}

async function getLatestSystemStatus(vehicleId, systemKey) {
  if (!pool) return { system: systemKey, status: "unknown", updatedAt: null, source: null };
  const rows = await pool
    .query(
      `
      select system, status, source, updated_at
      from fleet_vehicle_system_status
      where vehicle_id = $1 and system = $2
      order by updated_at desc
      limit 1;
      `,
      [vehicleId, systemKey],
    )
    .then((r) => r.rows);
  const r = rows[0];
  if (!r) return { system: systemKey, status: "unknown", updatedAt: null, source: null };
  return {
    system: r.system,
    status: r.status,
    updatedAt: new Date(r.updated_at).toISOString(),
    source: r.source || null,
  };
}

async function getActiveBindingsByVehicle(vehicleId) {
  if (!pool) return [];
  const rows = await pool
    .query(
      `
      select driver_id, binding_type, created_at
      from fleet_driver_binding
      where vehicle_id = $1 and active = true
      order by created_at desc;
      `,
      [vehicleId],
    )
    .then((r) => r.rows);
  return rows.map((r) => ({
    driverId: r.driver_id,
    bindingType: r.binding_type,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

async function getActiveBindingsByDriver(driverId) {
  if (!pool) return [];
  const rows = await pool
    .query(
      `
      select vehicle_id, binding_type, created_at
      from fleet_driver_binding
      where driver_id = $1 and active = true
      order by created_at desc;
      `,
      [driverId],
    )
    .then((r) => r.rows);
  return rows.map((r) => ({
    vehicleId: r.vehicle_id,
    bindingType: r.binding_type,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

async function evaluateDispatchDecision({
  vehicle,
  moduleKey,
  windowStart,
  windowEnd,
  context,
}) {
  const reasons = [];
  const warnings = [];
  const suggestions = [];

  const requiredCapability = moduleKey;
  const hasCapability = Array.isArray(vehicle.capabilities) && vehicle.capabilities.includes(requiredCapability);
  if (!hasCapability) {
    reasons.push({
      code: "missing_capability",
      message: `Fahrzeug besitzt Capability '${requiredCapability}' nicht.`,
      details: { requiredCapability, capabilities: vehicle.capabilities || [] },
    });
  }

  const containerSize = normalizeString(context.containerSize);
  if (containerSize) {
    const supported = Array.isArray(vehicle.containerSizes) && vehicle.containerSizes.includes(containerSize);
    if (!supported) {
      reasons.push({
        code: "container_size_not_supported",
        message: `Containergröße '${containerSize}' nicht unterstützt.`,
        details: { containerSize, supported: vehicle.containerSizes || [] },
      });
    }
  }

  const containerType = normalizeString(context.containerType);
  if (containerType) {
    const supported = Array.isArray(vehicle.containerTypes) && vehicle.containerTypes.includes(containerType);
    if (!supported) {
      reasons.push({
        code: "container_type_not_supported",
        message: `Containertyp '${containerType}' nicht unterstützt.`,
        details: { containerType, supported: vehicle.containerTypes || [] },
      });
    }
  }

  const grapplerType = normalizeString(context.grapplerType);
  if (grapplerType) {
    const supported = Array.isArray(vehicle.grapplerTypes) && vehicle.grapplerTypes.includes(grapplerType);
    if (!supported) {
      reasons.push({
        code: "grappler_not_supported",
        message: `Greifertyp '${grapplerType}' nicht unterstützt.`,
        details: { grapplerType, supported: vehicle.grapplerTypes || [] },
      });
    }
  }

  const adrClass = normalizeString(context.adrClass);
  if (adrClass) {
    const supported = vehicle.adrEnabled && Array.isArray(vehicle.adrClasses) && vehicle.adrClasses.includes(adrClass);
    if (!supported) {
      reasons.push({
        code: "adr_not_supported",
        message: `ADR-Klasse '${adrClass}' nicht unterstützt.`,
        details: { adrClass, adrEnabled: vehicle.adrEnabled, supported: vehicle.adrClasses || [] },
      });
    }
  }

  const siteDepot = normalizeString(context.siteDepot);
  if (siteDepot && vehicle.homeDepot && siteDepot !== vehicle.homeDepot) {
    reasons.push({
      code: "wrong_depot",
      message: `Standortanforderung '${siteDepot}' passt nicht zum Fahrzeugstandort '${vehicle.homeDepot}'.`,
      details: { requiredDepot: siteDepot, vehicleDepot: vehicle.homeDepot },
    });
  }
  if (siteDepot && !vehicle.homeDepot) {
    reasons.push({
      code: "vehicle_depot_unknown",
      message: "Fahrzeugstandort unbekannt, Standortanforderung kann nicht geprüft werden.",
      details: { requiredDepot: siteDepot },
    });
  }

  const siteLat = typeof context.siteLat === "number" ? context.siteLat : null;
  const siteLon = typeof context.siteLon === "number" ? context.siteLon : null;
  const maxDistanceKm = typeof context.maxDistanceKm === "number" ? context.maxDistanceKm : null;
  const priorityScore = computePriorityScore({
    priorityUrgency: context.priorityUrgency,
    priorityValue: context.priorityValue,
    priorityCustomerTier: context.priorityCustomerTier,
  });

  if (siteLat !== null && siteLon !== null && maxDistanceKm !== null) {
    const relaxedMaxDistanceKm = maxDistanceKm * Math.min(2, 1 + priorityScore / 200);
    if (vehicle.homeLat === null || vehicle.homeLon === null) {
      reasons.push({
        code: "vehicle_location_unknown",
        message: "Fahrzeugkoordinaten fehlen, Entfernung kann nicht geprüft werden.",
        details: { siteLat, siteLon, maxDistanceKm, priorityScore },
      });
    } else {
      const distanceKm = haversineKm(vehicle.homeLat, vehicle.homeLon, siteLat, siteLon);
      if (distanceKm > relaxedMaxDistanceKm) {
        reasons.push({
          code: "distance_exceeded",
          message: `Entfernung ${distanceKm.toFixed(1)} km überschreitet Limit ${relaxedMaxDistanceKm.toFixed(1)} km.`,
          details: { distanceKm, maxDistanceKm, relaxedMaxDistanceKm, priorityScore },
        });
        suggestions.push({
          type: "adjust_maxDistanceKm",
          maxDistanceKm: Math.ceil(distanceKm),
          reasonCode: "distance_exceeded",
        });
      }
    }
  }

  const driverId = normalizeString(context.driverId);
  if (driverId) {
    const byVehicle = await getActiveBindingsByVehicle(vehicle.id);
    const byDriver = await getActiveBindingsByDriver(driverId);

    const vehicleExclusive = byVehicle.find((b) => b.bindingType === "exclusive") || null;
    if (vehicleExclusive && vehicleExclusive.driverId !== driverId) {
      reasons.push({
        code: "vehicle_exclusive_driver_mismatch",
        message: "Fahrzeug ist exklusiv an einen anderen Fahrer gebunden.",
        details: { expectedDriverId: vehicleExclusive.driverId, providedDriverId: driverId },
      });
    }

    const driverExclusive = byDriver.find((b) => b.bindingType === "exclusive") || null;
    if (driverExclusive && driverExclusive.vehicleId !== vehicle.id) {
      reasons.push({
        code: "driver_exclusive_to_other_vehicle",
        message: "Fahrer ist exklusiv an ein anderes Fahrzeug gebunden.",
        details: { expectedVehicleId: driverExclusive.vehicleId, providedVehicleId: vehicle.id },
      });
    }

    if (!vehicleExclusive && !driverExclusive) {
      const preferred = byVehicle.find((b) => b.bindingType === "preferred") || null;
      if (preferred && preferred.driverId !== driverId) {
        warnings.push({
          code: "vehicle_preferred_driver_mismatch",
          message: "Fahrzeug hat einen bevorzugten Fahrer, der nicht übereinstimmt.",
          details: { preferredDriverId: preferred.driverId, providedDriverId: driverId },
        });
      }
    }
  }

  const shiftStart = context.shiftStart ? parseIsoDate(context.shiftStart) : null;
  const shiftEnd = context.shiftEnd ? parseIsoDate(context.shiftEnd) : null;
  if ((context.shiftStart && !shiftStart) || (context.shiftEnd && !shiftEnd)) {
    reasons.push({
      code: "shift_window_violation",
      message: "Schichtzeiten sind ungültig.",
      details: { shiftStart: context.shiftStart || null, shiftEnd: context.shiftEnd || null },
    });
  } else if (shiftStart && shiftEnd) {
    if (shiftEnd <= shiftStart) {
      reasons.push({
        code: "shift_window_violation",
        message: "Schichtende muss nach Schichtbeginn liegen.",
        details: { shiftStart: shiftStart.toISOString(), shiftEnd: shiftEnd.toISOString() },
      });
    } else if (windowStart < shiftStart || windowEnd > shiftEnd) {
      reasons.push({
        code: "shift_window_violation",
        message: "Zeitfenster liegt außerhalb der Schicht.",
        details: { shiftStart: shiftStart.toISOString(), shiftEnd: shiftEnd.toISOString() },
      });
      const durationMs = windowEnd.getTime() - windowStart.getTime();
      const suggestedStart = windowStart < shiftStart ? shiftStart : new Date(Math.min(windowStart.getTime(), shiftEnd.getTime() - durationMs));
      const suggestedEnd = new Date(suggestedStart.getTime() + durationMs);
      if (suggestedEnd <= shiftEnd) {
        suggestions.push({
          type: "adjust_window",
          windowStart: suggestedStart.toISOString(),
          windowEnd: suggestedEnd.toISOString(),
          reasonCode: "shift_window_violation",
        });
      }
    }
  }

  const lastShiftEnd = context.lastShiftEnd ? parseIsoDate(context.lastShiftEnd) : null;
  const minRestMinutesRaw = context.minRestMinutes === null || context.minRestMinutes === undefined || context.minRestMinutes === "" ? null : Number(context.minRestMinutes);
  const minRestMinutes = minRestMinutesRaw !== null && Number.isFinite(minRestMinutesRaw) ? minRestMinutesRaw : null;
  if (lastShiftEnd && minRestMinutes !== null && shiftStart) {
    const restMinutes = (shiftStart.getTime() - lastShiftEnd.getTime()) / 60000;
    if (restMinutes < minRestMinutes) {
      reasons.push({
        code: "driver_rest_violation",
        message: `Ruhezeit ${Math.floor(restMinutes)} min unterschreitet Minimum ${minRestMinutes} min.`,
        details: { lastShiftEnd: lastShiftEnd.toISOString(), shiftStart: shiftStart.toISOString(), minRestMinutes },
      });
      const nextStart = new Date(lastShiftEnd.getTime() + minRestMinutes * 60000);
      suggestions.push({
        type: "adjust_shiftStart",
        shiftStart: nextStart.toISOString(),
        reasonCode: "driver_rest_violation",
      });
    }
  }

  const plannedWorkMinutesRaw = context.plannedWorkMinutes === null || context.plannedWorkMinutes === undefined || context.plannedWorkMinutes === "" ? null : Number(context.plannedWorkMinutes);
  let plannedWorkMinutes = plannedWorkMinutesRaw !== null && Number.isFinite(plannedWorkMinutesRaw) ? plannedWorkMinutesRaw : null;
  const maxWorkMinutesRaw = context.maxWorkMinutes === null || context.maxWorkMinutes === undefined || context.maxWorkMinutes === "" ? null : Number(context.maxWorkMinutes);
  const maxWorkMinutes = maxWorkMinutesRaw !== null && Number.isFinite(maxWorkMinutesRaw) ? maxWorkMinutesRaw : null;
  const loadMinutesRaw = context.loadMinutes === null || context.loadMinutes === undefined || context.loadMinutes === "" ? null : Number(context.loadMinutes);
  const unloadMinutesRaw = context.unloadMinutes === null || context.unloadMinutes === undefined || context.unloadMinutes === "" ? null : Number(context.unloadMinutes);
  const transitMinutesRaw = context.transitMinutes === null || context.transitMinutes === undefined || context.transitMinutes === "" ? null : Number(context.transitMinutes);
  const loadMinutes = loadMinutesRaw !== null && Number.isFinite(loadMinutesRaw) ? loadMinutesRaw : null;
  const unloadMinutes = unloadMinutesRaw !== null && Number.isFinite(unloadMinutesRaw) ? unloadMinutesRaw : null;
  const transitMinutes = transitMinutesRaw !== null && Number.isFinite(transitMinutesRaw) ? transitMinutesRaw : null;
  if (plannedWorkMinutes === null && (loadMinutes !== null || unloadMinutes !== null || transitMinutes !== null)) {
    plannedWorkMinutes = (loadMinutes || 0) + (unloadMinutes || 0) + (transitMinutes || 0);
  }
  if (plannedWorkMinutes !== null && maxWorkMinutes !== null && plannedWorkMinutes > maxWorkMinutes) {
    reasons.push({
      code: "driver_overtime_violation",
      message: `Arbeitszeit ${plannedWorkMinutes} min überschreitet Limit ${maxWorkMinutes} min.`,
      details: { plannedWorkMinutes, maxWorkMinutes },
    });
  }

  const assignmentsVehicle = await getAssignmentsOverlappingWindow({ vehicleId: vehicle.id, windowStart, windowEnd });
  if (assignmentsVehicle.length) {
    reasons.push({
      code: "vehicle_time_conflict",
      message: "Zeitfenster kollidiert mit bestehender Fahrzeugdisposition.",
      details: { conflicts: assignmentsVehicle.slice(0, 3) },
    });
    const first = assignmentsVehicle[0];
    const durationMs = windowEnd.getTime() - windowStart.getTime();
    const nextStart = new Date(new Date(first.windowEnd).getTime());
    const nextEnd = new Date(nextStart.getTime() + durationMs);
    suggestions.push({
      type: "adjust_window",
      windowStart: nextStart.toISOString(),
      windowEnd: nextEnd.toISOString(),
      reasonCode: "vehicle_time_conflict",
    });
  }

  if (driverId) {
    const assignmentsDriver = await getAssignmentsOverlappingWindow({ driverId, windowStart, windowEnd });
    if (assignmentsDriver.length) {
      reasons.push({
        code: "driver_time_conflict",
        message: "Zeitfenster kollidiert mit bestehender Fahrerdisposition.",
        details: { conflicts: assignmentsDriver.slice(0, 3) },
      });
    }
  }

  const weighRequired = !!context.weighRequired;
  const tankRequired = !!context.tankRequired;
  if (weighRequired) {
    const st = await getLatestSystemStatus(vehicle.id, "weigh");
    if (st.status !== "ok") {
      reasons.push({
        code: "weigh_system_not_ok",
        message: `Wiegesystem Status '${st.status}' (benötigt: ok).`,
        details: st,
      });
    }
  } else {
    const st = await getLatestSystemStatus(vehicle.id, "weigh");
    if (st.status === "down") {
      warnings.push({
        code: "weigh_system_down",
        message: "Wiegesystem ist aktuell gestört.",
        details: st,
      });
    }
  }

  if (tankRequired) {
    const st = await getLatestSystemStatus(vehicle.id, "tank");
    if (st.status !== "ok") {
      reasons.push({
        code: "tank_system_not_ok",
        message: `Tanksystem Status '${st.status}' (benötigt: ok).`,
        details: st,
      });
    }
  } else {
    const st = await getLatestSystemStatus(vehicle.id, "tank");
    if (st.status === "down") {
      warnings.push({
        code: "tank_system_down",
        message: "Tanksystem ist aktuell gestört.",
        details: st,
      });
    }
  }

  const inspectionHardBlocks = [];
  if (pool) {
    const now = new Date();
    const inspRows = await pool
      .query(
        `
        select id, inspection_type, due_month, due_from, due_to, status
        from fleet_inspection
        where unit_id = $1 and status = 'scheduled'
        order by due_to asc
        limit 20;
        `,
        [vehicle.id],
      )
      .then((r) => r.rows);
    const dueIds = [];
    for (const r of inspRows) {
      const dueFrom = r.due_from ? new Date(`${String(r.due_from).slice(0, 10)}T00:00:00Z`) : null;
      const dueTo = r.due_to ? new Date(`${String(r.due_to).slice(0, 10)}T23:59:59Z`) : null;
      if (!dueFrom || !dueTo || Number.isNaN(dueFrom.valueOf()) || Number.isNaN(dueTo.valueOf())) continue;
      if (now < dueFrom) continue;
      dueIds.push(r.id);
      inspectionHardBlocks.push({
        id: `insp_${r.id}`,
        vehicleId: vehicle.id,
        sourceModule: "inspection",
        severity: "critical",
        lockType: "hard",
        reason: `Prüfung fällig: ${r.inspection_type} (${r.due_month})`,
        startsAt: dueFrom.toISOString(),
        endsAt: null,
        reference: { entityType: "inspection", entityId: r.id },
        createdAt: now.toISOString(),
      });
    }
    if (dueIds.length) {
      reasons.unshift({
        code: "inspection_due",
        message: "Prüfung ist fällig oder überfällig, Einheit ist gesperrt.",
        details: { inspectionIds: dueIds },
      });
    }
  }

  const blocks = await getBlocksOverlappingWindow(vehicle.id, windowStart, windowEnd);
  const hard = [...inspectionHardBlocks, ...blocks.filter((b) => b.lockType === "hard")];
  const soft = blocks.filter((b) => b.lockType === "soft");

  if (hard.length > 0) {
    reasons.push({
      code: "hard_block",
      message: "Harte Sperre aktiv im Zeitfenster.",
      details: { blockIds: hard.map((b) => b.id) },
    });
  }

  if (soft.length > 0) {
    warnings.push({
      code: "soft_block_warning",
      message: "Weiche Sperre aktiv im Zeitfenster.",
      details: { blockIds: soft.map((b) => b.id) },
    });
  }

  const depotCandidates = Array.isArray(context.depotCandidates) ? context.depotCandidates : parseCsv(context.depotCandidates);
  if (siteLat !== null && siteLon !== null) {
    const depots = await getDepots({ candidates: depotCandidates.length ? depotCandidates : null });
    if (!depots.length) {
      warnings.push({ code: "depot_candidates_missing", message: "Keine Depotdaten verfügbar.", details: { depotCandidates } });
    } else {
      const scored = depots
        .filter((d) => d.lat !== null && d.lon !== null)
        .map((d) => {
          const distanceKm = haversineKm(d.lat, d.lon, siteLat, siteLon);
          const score = distanceKm * 1.0 + (d.utilization || 0) * 50 - priorityScore * 0.2;
          return { depot: d, distanceKm, score };
        })
        .sort((a, b) => a.score - b.score);
      const best = scored[0] || null;
      if (best) {
        warnings.push({
          code: "depot_recommended",
          message: `Depotempfehlung: ${best.depot.code} (Score ${best.score.toFixed(1)})`,
          details: { depot: best.depot, distanceKm: Number(best.distanceKm.toFixed(1)), score: Number(best.score.toFixed(2)) },
        });
      }
    }
  }

  const baseDecision = reasons.length > 0 ? "deny" : "allow";
  const reasonCode = reasons[0]?.code || warnings[0]?.code || "ok";
  const overrideRequirement = reasons.some((r) => reasonMeta(r.code).overrideLevel === "elevated") ? "elevated" : "standard";

  return {
    baseDecision,
    reasonCode,
    hardBlocks: hard,
    softBlocks: soft,
    reasons,
    warnings,
    suggestions,
    overrideRequirement,
    criteria: {
      requiredCapability,
      hasCapability,
      siteDepot: siteDepot || null,
      driverId: driverId || null,
      weighRequired,
      tankRequired,
      siteLat,
      siteLon,
      maxDistanceKm,
      priorityScore,
      containerSize: containerSize || null,
      containerType: containerType || null,
      grapplerType: grapplerType || null,
      adrClass: adrClass || null,
      plannedWorkMinutes: plannedWorkMinutes !== null ? plannedWorkMinutes : null,
      maxWorkMinutes: maxWorkMinutes !== null ? maxWorkMinutes : null,
      loadMinutes,
      unloadMinutes,
      transitMinutes,
    },
  };
}

async function buildNotifications() {
  const items = [];

  const blocks = await getAvailabilityBlocks({ activeOnly: true });
  const vehicles = await getVehicles();

  for (const block of blocks) {
    if (!isBlockActive(block)) continue;
    const v = vehicles.find((x) => x.id === block.vehicleId) || null;
    const isHard = block.lockType === "hard";
    items.push({
      id: `n_${block.id}`,
      severity: isHard ? "critical" : block.severity,
      sourceModule: block.sourceModule,
      title: `Fahrzeug gesperrt: ${v ? v.code : block.vehicleId}`,
      message: isHard ? `${block.reason}. Nutzung blockiert (hart).` : `${block.reason}. Nutzung möglich (weich, Warnung).`,
      createdAt: block.createdAt,
      deepLink: {
        href: blockDeepLink(block),
        label: "Zum Werkstattfall",
        entityType: block.reference.entityType,
        entityId: block.reference.entityId,
      },
    });
  }

  if (pool) {
    const waiting = await pool
      .query(
        `
        select id, vehicle_id, title, priority, opened_at
        from workshop_case
        where status = 'open' and work_state = 'waiting_parts'
        order by opened_at asc
        limit 20;
        `,
      )
      .then((r) => r.rows);
    for (const c of waiting) {
      const v = vehicles.find((x) => x.id === c.vehicle_id) || null;
      items.push({
        id: `n_waiting_parts_${c.id}`,
        severity: "warning",
        sourceModule: "workshop",
        title: `Teile fehlen: ${v ? v.code : c.vehicle_id}`,
        message: `${c.title} · Priorität ${String(c.priority || "medium")}`,
        createdAt: new Date(c.opened_at).toISOString(),
        deepLink: { href: "/?module=workshop", label: "Zum Pool", entityType: "workshopCase", entityId: c.id },
      });
    }

    const unassignedHigh = await pool
      .query(
        `
        select id, vehicle_id, title, opened_at
        from workshop_case
        where status = 'open' and assigned_to is null and priority = 'high'
        order by opened_at asc
        limit 20;
        `,
      )
      .then((r) => r.rows);
    for (const c of unassignedHigh) {
      const v = vehicles.find((x) => x.id === c.vehicle_id) || null;
      items.push({
        id: `n_unassigned_high_${c.id}`,
        severity: "warning",
        sourceModule: "workshop",
        title: `Unzugewiesen (hoch): ${v ? v.code : c.vehicle_id}`,
        message: c.title,
        createdAt: new Date(c.opened_at).toISOString(),
        deepLink: { href: "/?module=workshop", label: "Zum Pool", entityType: "workshopCase", entityId: c.id },
      });
    }

    const approvals = await pool
      .query(
        `
        with latest as (
          select distinct on (a.case_id)
            a.id, a.case_id, a.status, a.requested_by, a.requested_at, a.note
          from workshop_case_approval a
          order by a.case_id, a.created_at desc
        )
        select
          l.id, l.case_id, l.status, l.requested_by, l.requested_at, l.note,
          c.vehicle_id, c.title, c.priority, c.opened_at
        from latest l
        join workshop_case c on c.id = l.case_id
        where l.status = 'requested'
        order by l.requested_at asc
        limit 20;
        `,
      )
      .then((r) => r.rows);
    for (const a of approvals) {
      const v = vehicles.find((x) => x.id === a.vehicle_id) || null;
      items.push({
        id: `n_approval_${a.id}`,
        severity: "warning",
        sourceModule: "workshop",
        title: `Freigabe ausstehend: ${v ? v.code : a.vehicle_id}`,
        message: `${a.title} · angefragt von ${a.requested_by}${a.note ? ` · ${a.note}` : ""}`,
        createdAt: new Date(a.requested_at).toISOString(),
        deepLink: { href: "/?module=workshop", label: "Zum Pool", entityType: "workshopApproval", entityId: a.id },
      });
    }
  }

  items.push({
    id: "n_compliance_1",
    severity: "warning",
    sourceModule: "sewage",
    title: "Dichtheitsprüfung fällig",
    message: "Frist in 3 Tagen. Terminieren und Bericht vorbereiten.",
    createdAt: new Date().toISOString(),
    deepLink: {
      href: "/?module=sewage&entity=complianceCheck:kanal_9001",
      label: "Zur Frist",
      entityType: "complianceCheck",
      entityId: "kanal_9001",
    },
  });

  const order = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => (order[a.severity] ?? 99) - (order[b.severity] ?? 99));

  return items;
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const originalPathname = url.pathname;
  const apiVersionContext = parseApiVersionContext(originalPathname);
  if (!apiVersionContext.ok && apiVersionContext.unsupported) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "bad_request", message: "api_version_not_supported", requestedVersion: apiVersionContext.requestedVersion }));
  }
  if (originalPathname === "/api" || originalPathname.startsWith("/api/")) {
    applyApiVersionHeaders(res, apiVersionContext);
    url.pathname = apiVersionContext.routePath;
  }
  const auth = getAuth(req);
  const requestId = `req_${crypto.randomUUID().slice(0, 12)}`;
  const startedMs = Date.now();
  res.setHeader("x-request-id", requestId);
  res.on("finish", () => {
    const ms = Date.now() - startedMs;
    observeHttpRequest({ method, path: originalPathname, status: res.statusCode, ms });
    logJson({
      ts: new Date().toISOString(),
      level: "info",
      event: "http_request",
      requestId,
      method,
      path: originalPathname,
      status: res.statusCode,
      ms,
      user: auth.username || null,
      ip: req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : null,
    });
  });
  const safeMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (!safeMethod && auth.mode === "cookie" && url.pathname !== "/api/auth/login") {
    if (!requireCsrf(res, req)) return;
  }

  if (method === "GET" && url.pathname === "/api/healthz") {
    return json(res, 200, { ok: true, service: "api", ts: new Date().toISOString() });
  }

  if (method === "GET" && url.pathname === "/api/metrics") {
    const lines = [];
    lines.push(`# TYPE ahlert_http_requests_total counter`);
    for (const [k, v] of metrics.httpRequestsTotal.entries()) {
      const m = k.match(/^(\S+)\s+(\S+)\s+(\d+)$/);
      if (!m) continue;
      const methodLabel = m[1];
      const pathLabel = m[2];
      const statusLabel = m[3];
      lines.push(`ahlert_http_requests_total{method="${methodLabel}",path="${pathLabel}",status="${statusLabel}"} ${v}`);
    }
    lines.push(`# TYPE ahlert_http_request_duration_ms_sum counter`);
    for (const [k, v] of metrics.httpRequestMsSum.entries()) {
      const m = k.match(/^(\S+)\s+(\S+)\s+(\d+)$/);
      if (!m) continue;
      const methodLabel = m[1];
      const pathLabel = m[2];
      const statusLabel = m[3];
      lines.push(`ahlert_http_request_duration_ms_sum{method="${methodLabel}",path="${pathLabel}",status="${statusLabel}"} ${v}`);
    }
    lines.push(`# TYPE ahlert_http_request_duration_ms_count counter`);
    for (const [k, v] of metrics.httpRequestMsCount.entries()) {
      const m = k.match(/^(\S+)\s+(\S+)\s+(\d+)$/);
      if (!m) continue;
      const methodLabel = m[1];
      const pathLabel = m[2];
      const statusLabel = m[3];
      lines.push(`ahlert_http_request_duration_ms_count{method="${methodLabel}",path="${pathLabel}",status="${statusLabel}"} ${v}`);
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    return res.end(lines.join("\n") + "\n");
  }

  if (method === "GET" && url.pathname === "/api/auth/oidc/azure/start") {
    if (!oidcAzureConfigured()) return json(res, 503, { error: "oidc_not_configured" });
    const redirectRaw = normalizeString(url.searchParams.get("redirect")) || oidcAzurePostLoginRedirectEnv || "/";
    const redirect = isSafeRelativeRedirect(redirectRaw) ? redirectRaw : "/";
    const codeVerifier = randomBase64Url(32);
    const codeChallenge = sha256Base64Url(codeVerifier);
    const state = randomBase64Url(24);
    const nonce = randomBase64Url(24);
    const exp = Math.floor(Date.now() / 1000) + 10 * 60;
    const handshake = signJwt({ typ: "oidc", provider: "azure", state, nonce, verifier: codeVerifier, redirect, exp });
    if (!handshake) return json(res, 503, { error: "jwt_secret_missing" });

    setCookie(res, "erp_oidc", handshake, {
      maxAgeSeconds: 10 * 60,
      path: "/api/auth/oidc/azure/callback",
      domain: cookieDomain,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "lax",
    });

    const scopes = ["openid", "profile", "email"];
    const extraScopes = (oidcAzureScopesEnv || "")
      .split(/[,\s]+/)
      .map((s) => normalizeString(s))
      .filter(Boolean);
    for (const s of extraScopes) scopes.push(s);

    const authorizeParams = {
      client_id: oidcAzureClientId,
      response_type: "code",
      redirect_uri: oidcAzureRedirectUri(),
      response_mode: "query",
      scope: Array.from(new Set(scopes)).join(" "),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    };
    const loginHint = normalizeString(url.searchParams.get("loginHint"));
    if (loginHint) authorizeParams.login_hint = loginHint;
    const location = `${oidcAzureAuthorizeUrl()}?${encodeFormUrl(authorizeParams)}`;
    res.writeHead(302, { location });
    return res.end();
  }

  if (method === "GET" && url.pathname === "/api/auth/oidc/azure/callback") {
    if (!oidcAzureConfigured()) return json(res, 503, { error: "oidc_not_configured" });
    const error = normalizeString(url.searchParams.get("error"));
    const errorDescription = normalizeString(url.searchParams.get("error_description"));
    const code = normalizeString(url.searchParams.get("code"));
    const state = normalizeString(url.searchParams.get("state"));
    const cookies = parseCookies(req.headers.cookie);
    const rawHandshake = normalizeString(cookies.erp_oidc);
    setCookie(res, "erp_oidc", "", {
      maxAgeSeconds: 0,
      path: "/api/auth/oidc/azure/callback",
      domain: cookieDomain,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "lax",
    });

    if (error) {
      await insertAuditLog({
        id: `al_${crypto.randomUUID()}`,
        eventType: "AUTH_OIDC_FAILED",
        username: "anonymous",
        occurredAt: new Date().toISOString(),
        lockType: null,
        blockId: null,
        vehicleId: null,
        blockReason: null,
        overrideId: error,
        overrideReason: null,
        meta: { provider: "azure", error, errorDescription },
      }).catch(() => {});
      return unauthorized(res);
    }
    if (!rawHandshake) return unauthorized(res);
    const hv = verifyJwt(rawHandshake);
    if (!hv.ok) return unauthorized(res);
    const hp = hv.payload || {};
    if (hp.typ !== "oidc" || hp.provider !== "azure") return unauthorized(res);
    if (!state || state !== hp.state) return unauthorized(res);
    if (!code) return badRequest(res, "code_required");

    const tokenRes = await exchangeAzureAuthorizationCode({ code, codeVerifier: hp.verifier });
    if (!tokenRes.ok) {
      await insertAuditLog({
        id: `al_${crypto.randomUUID()}`,
        eventType: "AUTH_OIDC_FAILED",
        username: "anonymous",
        occurredAt: new Date().toISOString(),
        lockType: null,
        blockId: null,
        vehicleId: null,
        blockReason: null,
        overrideId: tokenRes.error,
        overrideReason: null,
        meta: { provider: "azure" },
      }).catch(() => {});
      return unauthorized(res);
    }
    const token = tokenRes.token || {};
    const idToken = normalizeString(token.id_token);
    const providerAccessToken = normalizeString(token.access_token);
    if (!idToken) return unauthorized(res);

    const verified = await verifyAzureIdToken({ idToken, expectedNonce: hp.nonce });
    if (!verified.ok) return unauthorized(res);
    const claims = verified.claims || {};
    const tid = normalizeString(claims.tid);
    const sub = normalizeString(claims.sub);
    const preferred = normalizeString(claims.preferred_username) || normalizeString(claims.upn) || normalizeString(claims.email);
    const displayName = normalizeString(claims.name) || preferred || null;
    const email = normalizeString(claims.email) || null;

    let groupIds = Array.isArray(claims.groups) ? claims.groups.map((g) => normalizeString(g)).filter(Boolean) : [];
    const wantsGraph = String(oidcAzureGraphGroupsEnv || "").trim().toLowerCase() === "true";
    const groupsOverage = Boolean((claims._claim_names && claims._claim_names.groups) || claims.hasgroups === true);
    if (groupIds.length === 0 && groupsOverage && wantsGraph && providerAccessToken) {
      const g = await fetchAzureGroupsViaGraph({ accessToken: providerAccessToken });
      if (g.ok) groupIds = g.groupIds;
    }

    const ensured = await ensureUserForAzureOidc({
      subject: sub,
      tenantId: tid,
      username: preferred,
      displayName,
      email,
    });
    if (!ensured.ok) return unauthorized(res);

    const roleNames = await mapAzureGroupsToRoles({ groupIds });
    const synced = await syncRolesForUser({ userId: ensured.userId, roleNames });
    if (!synced.ok) return unauthorized(res);

    const permissions = await listPermissionsForUser(ensured.userId);
    const accessToken = issueAccessToken({ userId: ensured.userId, username: ensured.username, permissions });
    const session = await createSession({
      userId: ensured.userId,
      ip: req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : null,
      userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : null,
    });

    setCookie(res, "erp_refresh", session.refreshToken, {
      maxAgeSeconds: refreshTokenTtlSeconds,
      path: "/api/auth/refresh",
      domain: cookieDomain,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
    });
    setCookie(res, "erp_csrf", session.csrfToken, {
      maxAgeSeconds: refreshTokenTtlSeconds,
      path: "/",
      domain: cookieDomain,
      httpOnly: false,
      secure: cookieSecure,
      sameSite: cookieSameSite,
    });
    setCookie(res, "erp_access", accessToken, {
      maxAgeSeconds: accessTokenTtlSeconds,
      path: "/",
      domain: cookieDomain,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
    });

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "AUTH_LOGIN_SUCCESS",
      username: ensured.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: null,
      blockReason: null,
      overrideId: session.sessionId,
      overrideReason: null,
      meta: { mode: "oidc", provider: "azure", tenantId: tid || null, groups: groupIds.length, roles: roleNames },
    }).catch(() => {});

    const redirect = isSafeRelativeRedirect(hp.redirect) ? hp.redirect : "/";
    res.writeHead(302, { location: redirect });
    return res.end();
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    const username = normalizeString(body && body.username);
    const password = String((body && body.password) || "");
    if (!username) return badRequest(res, "username_required");
    if (!password) return badRequest(res, "password_required");
    if (!jwtSecret) return json(res, 503, { error: "jwt_secret_missing" });

    const u = await getUserByUsername(username);
    if (!u || u.disabled) {
      await insertAuditLog({
        id: `al_${crypto.randomUUID()}`,
        eventType: "AUTH_LOGIN_FAILED",
        username: username,
        occurredAt: new Date().toISOString(),
        lockType: null,
        blockId: null,
        vehicleId: null,
        blockReason: null,
        overrideId: null,
        overrideReason: null,
        meta: { reason: "user_not_found_or_disabled" },
      }).catch(() => {});
      return unauthorized(res);
    }
    const ok = await scryptVerifyPassword(password, u);
    if (!ok) {
      await insertAuditLog({
        id: `al_${crypto.randomUUID()}`,
        eventType: "AUTH_LOGIN_FAILED",
        username: username,
        occurredAt: new Date().toISOString(),
        lockType: null,
        blockId: null,
        vehicleId: null,
        blockReason: null,
        overrideId: null,
        overrideReason: null,
        meta: { reason: "password_invalid" },
      }).catch(() => {});
      return unauthorized(res);
    }

    const permissions = await listPermissionsForUser(u.id);
    const accessToken = issueAccessToken({ userId: u.id, username: u.username, permissions });
    const session = await createSession({
      userId: u.id,
      ip: req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : null,
      userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : null,
    });

    setCookie(res, "erp_refresh", session.refreshToken, {
      maxAgeSeconds: refreshTokenTtlSeconds,
      path: "/api/auth/refresh",
      domain: cookieDomain,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
    });
    setCookie(res, "erp_csrf", session.csrfToken, {
      maxAgeSeconds: refreshTokenTtlSeconds,
      path: "/",
      domain: cookieDomain,
      httpOnly: false,
      secure: cookieSecure,
      sameSite: cookieSameSite,
    });
    setCookie(res, "erp_access", accessToken, {
      maxAgeSeconds: accessTokenTtlSeconds,
      path: "/",
      domain: cookieDomain,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
    });

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "AUTH_LOGIN_SUCCESS",
      username: u.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: null,
      blockReason: null,
      overrideId: session.sessionId,
      overrideReason: null,
      meta: { mode: "cookie+jwt" },
    }).catch(() => {});

    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      user: { id: u.id, username: u.username, displayName: u.displayName, permissions },
      accessToken,
      accessTokenTtlSeconds,
      refreshExpiresAt: session.expiresAt,
    });
  }

  if (method === "POST" && url.pathname === "/api/auth/refresh") {
    if (!pool) return badRequest(res, "db_required");
    if (!jwtSecret) return json(res, 503, { error: "jwt_secret_missing" });
    if (!requireCsrf(res, req)) return;
    const cookies = parseCookies(req.headers.cookie);
    const refreshToken = normalizeString(cookies.erp_refresh);
    const csrfToken = normalizeString(cookies.erp_csrf);
    const r = await rotateSession({
      refreshToken,
      csrfToken,
      ip: req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : null,
      userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : null,
    });
    if (!r.ok) return unauthorized(res);
    const user = await pool.query(`select username, display_name from auth_user where id = $1 limit 1;`, [r.userId]).then((x) => x.rows[0] || null);
    if (!user) return unauthorized(res);
    const permissions = await listPermissionsForUser(r.userId);
    const accessToken = issueAccessToken({ userId: r.userId, username: user.username, permissions });

    setCookie(res, "erp_refresh", r.session.refreshToken, {
      maxAgeSeconds: refreshTokenTtlSeconds,
      path: "/api/auth/refresh",
      domain: cookieDomain,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
    });
    setCookie(res, "erp_csrf", r.session.csrfToken, {
      maxAgeSeconds: refreshTokenTtlSeconds,
      path: "/",
      domain: cookieDomain,
      httpOnly: false,
      secure: cookieSecure,
      sameSite: cookieSameSite,
    });
    setCookie(res, "erp_access", accessToken, {
      maxAgeSeconds: accessTokenTtlSeconds,
      path: "/",
      domain: cookieDomain,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: cookieSameSite,
    });
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "AUTH_REFRESH",
      username: user.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: null,
      blockReason: null,
      overrideId: r.session.sessionId,
      overrideReason: null,
      meta: {},
    }).catch(() => {});
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { accessToken, accessTokenTtlSeconds, refreshExpiresAt: r.session.expiresAt });
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    if (!pool) return badRequest(res, "db_required");
    if (!requireCsrf(res, req)) return;
    const cookies = parseCookies(req.headers.cookie);
    const refreshToken = normalizeString(cookies.erp_refresh);
    if (refreshToken) {
      await pool.query(`update auth_session set revoked_at = now() where refresh_token_sha256 = $1 and revoked_at is null;`, [sha256Hex(refreshToken)]).catch(() => {});
    }
    clearCookie(res, "erp_refresh");
    clearCookie(res, "erp_access");
    setCookie(res, "erp_csrf", "", { maxAgeSeconds: 0, path: "/", domain: cookieDomain, httpOnly: false, secure: cookieSecure, sameSite: cookieSameSite });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && url.pathname === "/api/auth/me") {
    if (!auth.username) return unauthorized(res);
    return json(res, 200, { user: { id: auth.userId || null, username: auth.username, permissions: Array.from(auth.permissions) } });
  }

  if (method === "GET" && url.pathname === "/api/auth/admin/users") {
    if (!requirePermission(res, auth, Permissions.AuthAdmin)) return;
    return json(res, 200, { items: await listUsers() });
  }
  if (method === "POST" && url.pathname === "/api/auth/admin/users") {
    if (!requirePermission(res, auth, Permissions.AuthAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    const r = await createUser({ username: body.username, displayName: body.displayName, password: body.password });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 201, { item: r.item });
  }
  if (method === "GET" && url.pathname === "/api/auth/admin/roles") {
    if (!requirePermission(res, auth, Permissions.AuthAdmin)) return;
    return json(res, 200, { items: await listRoles() });
  }
  if (method === "POST" && url.pathname === "/api/auth/admin/roles") {
    if (!requirePermission(res, auth, Permissions.AuthAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    const r = await createRole({ name: body.name });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 201, { item: r.item });
  }
  if (method === "POST" && url.pathname === "/api/auth/admin/roles/grant") {
    if (!requirePermission(res, auth, Permissions.AuthAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    const r = await grantPermissionToRole({ roleName: body.roleName, permission: body.permission });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && url.pathname === "/api/auth/admin/users/assign-role") {
    if (!requirePermission(res, auth, Permissions.AuthAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    const r = await assignRoleToUser({ username: body.username, roleName: body.roleName });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && url.pathname === "/api/jobs") {
    if (!requireAnyPermission(res, auth, [Permissions.AuthAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const id = normalizeString(url.searchParams.get("id")) || null;
    if (id) {
      const row = await pool
        .query(
          `
          select id, type, status, requested_by, params, progress, total, error, created_at, started_at, finished_at
          from job
          where id = $1
          limit 1;
          `,
          [id],
        )
        .then((r) => r.rows[0] || null);
      if (!row) return notFound(res);
      return json(res, 200, {
        item: {
          id: row.id,
          type: row.type,
          status: row.status,
          requestedBy: row.requested_by,
          params: row.params || {},
          progress: Number(row.progress) || 0,
          total: Number(row.total) || 100,
          error: row.error || null,
          createdAt: new Date(row.created_at).toISOString(),
          startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
          finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
        },
      });
    }

    const status = normalizeString(url.searchParams.get("status")) || null;
    const type = normalizeString(url.searchParams.get("type")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(200, limitRaw ? Number(limitRaw) : 50));
    const cursor = normalizeString(url.searchParams.get("cursor")) || null;

    const where = [];
    const params = [];
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (status) add("status = ?", status);
    if (type) add("type = ?", type);
    if (cursor) {
      const parts = cursor.split("|");
      if (parts.length === 2) {
        const cAt = parseIsoDate(parts[0]);
        const cId = normalizeString(parts[1]);
        if (cAt && cId) {
          params.push(cAt.toISOString());
          params.push(cId);
          where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
        }
      }
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const rows = await pool
      .query(
        `
        select id, type, status, requested_by, params, progress, total, error, created_at, started_at, finished_at
        from job
        ${whereSql}
        order by created_at desc, id desc
        limit ${limit + 1};
        `,
        params,
      )
      .then((r) => r.rows);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1] || null;
    const nextCursor = hasMore && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null;
    return json(res, 200, {
      items: slice.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        requestedBy: row.requested_by,
        params: row.params || {},
        progress: Number(row.progress) || 0,
        total: Number(row.total) || 100,
        error: row.error || null,
        createdAt: new Date(row.created_at).toISOString(),
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      })),
      nextCursor,
    });
  }

  if (method === "GET" && url.pathname === "/api/jobs/logs") {
    if (!requireAnyPermission(res, auth, [Permissions.AuthAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const jobId = normalizeString(url.searchParams.get("jobId"));
    if (!jobId) return badRequest(res, "jobId_required");
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(2000, limitRaw ? Number(limitRaw) : 500));
    const rows = await pool
      .query(
        `
        select id, level, message, meta, created_at
        from job_log
        where job_id = $1
        order by created_at asc
        limit $2;
        `,
        [jobId, limit],
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        level: r.level,
        message: r.message,
        meta: r.meta || {},
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  }

  if (method === "GET" && url.pathname === "/api/training/qualifications") {
    if (
      !requireAnyPermission(res, auth, [
        Permissions.TrainingCatalogView,
        Permissions.TrainingCatalogAdmin,
        Permissions.TrainingPlanView,
        Permissions.TrainingPlanManage,
        Permissions.TrainingCredentialView,
        Permissions.TrainingCredentialIssue,
        Permissions.TrainingEmployeeView,
        Permissions.TrainingEmployeeAdmin,
        Permissions.TrainingSelfView,
      ])
    )
      return;
    if (!pool) return badRequest(res, "db_required");
    const activeOnly = normalizeString(url.searchParams.get("activeOnly")) === "true";
    const category = normalizeString(url.searchParams.get("category")) || null;
    const where = [];
    const params = [];
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (activeOnly) where.push(`active = true`);
    if (category) add("category = ?", category);
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const rows = await pool
      .query(
        `
        select id, code, name, category, description, issuer_type, validity_days, renewal_days_before, requires_exam, sensitive, active, created_at
        from training_qualification
        ${whereSql}
        order by category asc, name asc
        limit 500;
        `,
        params,
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        category: r.category,
        description: r.description || null,
        issuerType: r.issuer_type,
        validityDays: r.validity_days === null ? null : Number(r.validity_days),
        renewalDaysBefore: Number(r.renewal_days_before),
        requiresExam: Boolean(r.requires_exam),
        sensitive: Boolean(r.sensitive),
        active: Boolean(r.active),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  }

  if (method === "POST" && url.pathname === "/api/training/qualifications") {
    if (!requirePermission(res, auth, Permissions.TrainingCatalogAdmin)) return;
    if (!pool) return badRequest(res, "db_required");
    const actorId = await resolveAuthUserId(auth);
    if (!actorId) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const code = normalizeString(body.code);
    const name = normalizeString(body.name);
    const category = normalizeString(body.category);
    const description = normalizeString(body.description) || null;
    const issuerType = normalizeString(body.issuerType);
    const validityDaysRaw = body.validityDays === null || body.validityDays === undefined || body.validityDays === "" ? null : Number(body.validityDays);
    const renewalDaysBeforeRaw = body.renewalDaysBefore === null || body.renewalDaysBefore === undefined || body.renewalDaysBefore === "" ? 30 : Number(body.renewalDaysBefore);
    const requiresExam = body.requiresExam === true;
    const sensitive = body.sensitive === true;
    if (!code) return badRequest(res, "code_required");
    if (code.length < 2 || code.length > 64) return badRequest(res, "code_invalid");
    if (!name) return badRequest(res, "name_required");
    if (!category) return badRequest(res, "category_required");
    if (!issuerType) return badRequest(res, "issuerType_required");
    const validityDays = validityDaysRaw === null ? null : Math.trunc(validityDaysRaw);
    if (validityDays !== null && (!Number.isFinite(validityDaysRaw) || validityDays <= 0)) return badRequest(res, "validityDays_invalid");
    const renewalDaysBefore = Math.trunc(renewalDaysBeforeRaw);
    if (!Number.isFinite(renewalDaysBeforeRaw) || renewalDaysBefore < 0) return badRequest(res, "renewalDaysBefore_invalid");
    const id = `tq_${crypto.randomUUID().slice(0, 18)}`;
    try {
      await pool.query(
        `
        insert into training_qualification
          (id, code, name, category, description, issuer_type, validity_days, renewal_days_before, requires_exam, sensitive, active)
        values
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true);
        `,
        [id, code, name, category, description, issuerType, validityDays, renewalDaysBefore, requiresExam, sensitive],
      );
    } catch {
      return json(res, 409, { error: "conflict", message: "qualification_exists" });
    }
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "TRAINING_QUALIFICATION_CREATED",
      username: auth.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: null,
      blockReason: null,
      overrideId: id,
      overrideReason: null,
      meta: { code, category, issuerType, validityDays, renewalDaysBefore, requiresExam, sensitive },
    }).catch(() => {});
    publishEvent("training", "training_qualification_created", { id, code, category });
    return json(res, 201, { item: { id, code, name, category, description, issuerType, validityDays, renewalDaysBefore, requiresExam, sensitive, active: true } });
  }

  if (method === "GET" && url.pathname === "/api/training/courses") {
    if (!requireAnyPermission(res, auth, [Permissions.TrainingPlanView, Permissions.TrainingPlanManage, Permissions.TrainingCatalogView, Permissions.TrainingCatalogAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    const activeOnly = normalizeString(url.searchParams.get("activeOnly")) === "true";
    const qualificationId = normalizeString(url.searchParams.get("qualificationId")) || null;
    const where = [];
    const params = [];
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (activeOnly) where.push(`active = true`);
    if (qualificationId) add("qualification_id = ?", qualificationId);
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const rows = await pool
      .query(
        `
        select id, code, name, description, qualification_id, duration_minutes, delivery_mode, active, created_at
        from training_course
        ${whereSql}
        order by name asc
        limit 500;
        `,
        params,
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description || null,
        qualificationId: r.qualification_id || null,
        durationMinutes: r.duration_minutes === null ? null : Number(r.duration_minutes),
        deliveryMode: r.delivery_mode,
        active: Boolean(r.active),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  }

  if (method === "POST" && url.pathname === "/api/training/courses") {
    if (!requirePermission(res, auth, Permissions.TrainingCatalogAdmin)) return;
    if (!pool) return badRequest(res, "db_required");
    const actorId = await resolveAuthUserId(auth);
    if (!actorId) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const code = normalizeString(body.code);
    const name = normalizeString(body.name);
    const description = normalizeString(body.description) || null;
    const qualificationId = normalizeString(body.qualificationId) || null;
    const durationMinutesRaw = body.durationMinutes === null || body.durationMinutes === undefined || body.durationMinutes === "" ? null : Number(body.durationMinutes);
    const deliveryMode = normalizeString(body.deliveryMode);
    if (!code) return badRequest(res, "code_required");
    if (!name) return badRequest(res, "name_required");
    if (!deliveryMode) return badRequest(res, "deliveryMode_required");
    const durationMinutes = durationMinutesRaw === null ? null : Math.trunc(durationMinutesRaw);
    if (durationMinutes !== null && (!Number.isFinite(durationMinutesRaw) || durationMinutes <= 0)) return badRequest(res, "durationMinutes_invalid");
    if (!["in_person", "online", "blended"].includes(deliveryMode)) return badRequest(res, "deliveryMode_invalid");
    if (qualificationId) {
      const q = await pool.query(`select id from training_qualification where id = $1 limit 1;`, [qualificationId]).then((r) => r.rows[0] || null);
      if (!q) return badRequest(res, "qualification_not_found");
    }
    const id = `tc_${crypto.randomUUID().slice(0, 18)}`;
    try {
      await pool.query(
        `
        insert into training_course
          (id, code, name, description, qualification_id, duration_minutes, delivery_mode, active)
        values
          ($1,$2,$3,$4,$5,$6,$7,true);
        `,
        [id, code, name, description, qualificationId, durationMinutes, deliveryMode],
      );
    } catch {
      return json(res, 409, { error: "conflict", message: "course_exists" });
    }
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "TRAINING_COURSE_CREATED",
      username: auth.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: null,
      blockReason: null,
      overrideId: id,
      overrideReason: null,
      meta: { code, qualificationId, deliveryMode, durationMinutes },
    }).catch(() => {});
    publishEvent("training", "training_course_created", { id, code, qualificationId });
    return json(res, 201, { item: { id, code, name, description, qualificationId, durationMinutes, deliveryMode, active: true } });
  }

  if (method === "GET" && url.pathname === "/api/training/sessions") {
    if (!requireAnyPermission(res, auth, [Permissions.TrainingPlanView, Permissions.TrainingPlanManage])) return;
    if (!pool) return badRequest(res, "db_required");
    const fromRaw = normalizeString(url.searchParams.get("from")) || null;
    const toRaw = normalizeString(url.searchParams.get("to")) || null;
    const from = fromRaw ? parseIsoDate(fromRaw) : null;
    const to = toRaw ? parseIsoDate(toRaw) : null;
    if (fromRaw && !from) return badRequest(res, "invalid_from");
    if (toRaw && !to) return badRequest(res, "invalid_to");
    const courseId = normalizeString(url.searchParams.get("courseId")) || null;
    const trainerUserId = normalizeString(url.searchParams.get("trainerUserId")) || null;
    const status = normalizeString(url.searchParams.get("status")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(200, limitRaw ? Number(limitRaw) : 50));
    const cursor = normalizeString(url.searchParams.get("cursor")) || null;

    const where = [];
    const params = [];
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (from) add("s.starts_at >= ?", from.toISOString());
    if (to) add("s.starts_at <= ?", to.toISOString());
    if (courseId) add("s.course_id = ?", courseId);
    if (trainerUserId) add("s.trainer_user_id = ?", trainerUserId);
    if (status) add("s.status = ?", status);
    if (cursor) {
      const parts = cursor.split("|");
      if (parts.length === 2) {
        const cAt = parseIsoDate(parts[0]);
        const cId = normalizeString(parts[1]);
        if (cAt && cId) {
          params.push(cAt.toISOString());
          params.push(cId);
          where.push(`(s.starts_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
        }
      }
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const rows = await pool
      .query(
        `
        select
          s.id, s.course_id, c.code as course_code, c.name as course_name, c.qualification_id,
          s.starts_at, s.ends_at, s.location, s.trainer_user_id, s.capacity, s.status, s.created_at
        from training_session s
        join training_course c on c.id = s.course_id
        ${whereSql}
        order by s.starts_at desc, s.id desc
        limit ${limit + 1};
        `,
        params,
      )
      .then((r) => r.rows);
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1] || null;
    const nextCursor = hasMore && last ? `${new Date(last.starts_at).toISOString()}|${last.id}` : null;
    return json(res, 200, {
      items: slice.map((r) => ({
        id: r.id,
        courseId: r.course_id,
        course: { code: r.course_code, name: r.course_name, qualificationId: r.qualification_id || null },
        startsAt: new Date(r.starts_at).toISOString(),
        endsAt: new Date(r.ends_at).toISOString(),
        location: r.location || null,
        trainerUserId: r.trainer_user_id || null,
        capacity: r.capacity === null ? null : Number(r.capacity),
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor,
    });
  }

  if (method === "POST" && url.pathname === "/api/training/sessions") {
    if (!requirePermission(res, auth, Permissions.TrainingPlanManage)) return;
    if (!pool) return badRequest(res, "db_required");
    const actorId = await resolveAuthUserId(auth);
    if (!actorId) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const courseId = normalizeString(body.courseId);
    const startsAt = parseIsoDate(body.startsAt);
    const endsAt = parseIsoDate(body.endsAt);
    const location = normalizeString(body.location) || null;
    const trainerUserId = normalizeString(body.trainerUserId) || null;
    const capacityRaw = body.capacity === null || body.capacity === undefined || body.capacity === "" ? null : Number(body.capacity);
    const capacity = capacityRaw === null ? null : Math.trunc(capacityRaw);
    if (!courseId) return badRequest(res, "courseId_required");
    if (!startsAt) return badRequest(res, "startsAt_invalid");
    if (!endsAt) return badRequest(res, "endsAt_invalid");
    if (endsAt.getTime() <= startsAt.getTime()) return badRequest(res, "invalid_date_range");
    if (capacity !== null && (!Number.isFinite(capacityRaw) || capacity <= 0)) return badRequest(res, "capacity_invalid");
    const course = await pool.query(`select id from training_course where id = $1 limit 1;`, [courseId]).then((r) => r.rows[0] || null);
    if (!course) return badRequest(res, "course_not_found");
    const id = `ts_${crypto.randomUUID().slice(0, 18)}`;
    await pool.query(
      `
      insert into training_session
        (id, course_id, starts_at, ends_at, location, trainer_user_id, capacity, status, created_by)
      values
        ($1,$2,$3,$4,$5,$6,$7,'scheduled',$8);
      `,
      [id, courseId, startsAt.toISOString(), endsAt.toISOString(), location, trainerUserId, capacity, actorId],
    );
    publishEvent("training", "training_session_created", { id, courseId, startsAt: startsAt.toISOString() });
    return json(res, 201, { item: { id, courseId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), location, trainerUserId, capacity, status: "scheduled" } });
  }

  if (method === "POST" && url.pathname === "/api/training/sessions/participants/assign") {
    if (!requirePermission(res, auth, Permissions.TrainingPlanManage)) return;
    if (!pool) return badRequest(res, "db_required");
    const actorId = await resolveAuthUserId(auth);
    if (!actorId) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const sessionId = normalizeString(body.sessionId);
    const userId = normalizeString(body.userId);
    if (!sessionId) return badRequest(res, "sessionId_required");
    if (!userId) return badRequest(res, "userId_required");
    const sess = await pool.query(`select id, capacity from training_session where id = $1 limit 1;`, [sessionId]).then((r) => r.rows[0] || null);
    if (!sess) return badRequest(res, "session_not_found");
    if (sess.capacity !== null) {
      const n = await pool.query(`select count(*)::int as n from training_session_participant where session_id = $1 and status <> 'cancelled';`, [sessionId]).then((r) => r.rows[0]?.n || 0);
      if (n >= Number(sess.capacity)) return json(res, 409, { error: "conflict", message: "capacity_exceeded" });
    }
    const exists = await pool.query(`select id from auth_user where id = $1 limit 1;`, [userId]).then((r) => r.rows[0] || null);
    if (!exists) return badRequest(res, "user_not_found");
    const id = `tsp_${crypto.randomUUID().slice(0, 18)}`;
    await pool.query(
      `
      insert into training_session_participant
        (id, session_id, user_id, status, score, note, decided_by, decided_at)
      values
        ($1,$2,$3,'assigned', null, null, null, null)
      on conflict (session_id, user_id) do update
        set status = 'assigned';
      `,
      [id, sessionId, userId],
    );
    publishEvent("training", "training_session_participant_assigned", { sessionId, userId });
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/training/sessions/participants/mark") {
    if (!requirePermission(res, auth, Permissions.TrainingPlanManage)) return;
    if (!pool) return badRequest(res, "db_required");
    const actorId = await resolveAuthUserId(auth);
    if (!actorId) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const sessionId = normalizeString(body.sessionId);
    const userId = normalizeString(body.userId);
    const status = normalizeString(body.status);
    const scoreRaw = body.score === null || body.score === undefined || body.score === "" ? null : Number(body.score);
    const score = scoreRaw === null ? null : Number(scoreRaw);
    const note = normalizeString(body.note) || null;
    if (!sessionId) return badRequest(res, "sessionId_required");
    if (!userId) return badRequest(res, "userId_required");
    if (!status) return badRequest(res, "status_required");
    if (!["assigned", "attended", "no_show", "passed", "failed", "cancelled"].includes(status)) return badRequest(res, "status_invalid");
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) return badRequest(res, "score_invalid");
    const nowIso = new Date().toISOString();
    const updated = await pool
      .query(
        `
        update training_session_participant
        set status = $3, score = $4, note = $5, decided_by = $6, decided_at = $7
        where session_id = $1 and user_id = $2
        returning id;
        `,
        [sessionId, userId, status, score, note, actorId, nowIso],
      )
      .then((r) => r.rows[0] || null);
    if (!updated) return notFound(res);
    publishEvent("training", "training_session_participant_marked", { sessionId, userId, status });
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/training/sessions/complete") {
    if (!requirePermission(res, auth, Permissions.TrainingPlanManage)) return;
    if (!pool) return badRequest(res, "db_required");
    const actorId = await resolveAuthUserId(auth);
    if (!actorId) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const sessionId = normalizeString(body.sessionId);
    if (!sessionId) return badRequest(res, "sessionId_required");
    const session = await pool
      .query(
        `
        select s.id, s.status, s.course_id, c.qualification_id, q.validity_days
        from training_session s
        join training_course c on c.id = s.course_id
        left join training_qualification q on q.id = c.qualification_id
        where s.id = $1
        limit 1;
        `,
        [sessionId],
      )
      .then((r) => r.rows[0] || null);
    if (!session) return badRequest(res, "session_not_found");
    if (session.status !== "scheduled") return badRequest(res, "invalid_status_transition");
    await pool.query(`update training_session set status = 'completed' where id = $1;`, [sessionId]);
    if (session.qualification_id) {
      const passed = await pool
        .query(
          `
          select user_id
          from training_session_participant
          where session_id = $1 and status = 'passed';
          `,
          [sessionId],
        )
        .then((r) => r.rows.map((x) => String(x.user_id)).filter(Boolean));
      const validityDays = session.validity_days === null ? null : Number(session.validity_days);
      for (const userId of passed) {
        const issuedAt = new Date().toISOString();
        const validFrom = new Date().toISOString().slice(0, 10);
        const validTo = validityDays === null ? null : new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const credId = `tcr_${crypto.randomUUID().slice(0, 18)}`;
        await pool.query(
          `
          insert into training_credential
            (id, user_id, qualification_id, source, issued_at, valid_from, valid_to, status, issuer_name, issued_by_user_id, note)
          values
            ($1,$2,$3,'course',$4,$5,$6,'valid', null, $7, null);
          `,
          [credId, userId, session.qualification_id, issuedAt, validFrom, validTo, actorId],
        );
        await pool.query(
          `
          insert into training_credential_event (id, credential_id, event_type, username, occurred_at, meta)
          values ($1,$2,'issued',$3,$4,$5);
          `,
          [`tce_${crypto.randomUUID().slice(0, 18)}`, credId, auth.username, issuedAt, JSON.stringify({ source: "course", sessionId })],
        );
      }
    }
    publishEvent("training", "training_session_completed", { sessionId });
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && url.pathname === "/api/training/credentials") {
    if (!pool) return badRequest(res, "db_required");
    const userId = normalizeString(url.searchParams.get("userId")) || null;
    const qualificationId = normalizeString(url.searchParams.get("qualificationId")) || null;
    const status = normalizeString(url.searchParams.get("status")) || null;
    const expiresBeforeRaw = normalizeString(url.searchParams.get("expiresBefore")) || null;
    const expiresBefore = expiresBeforeRaw ? parseIsoDate(expiresBeforeRaw) : null;
    if (expiresBeforeRaw && !expiresBefore) return badRequest(res, "invalid_expiresBefore");
    if (!userId && !qualificationId) return badRequest(res, "filter_required");
    const access = canAccessTrainingUser({ auth, targetUserId: userId || auth.userId || "", allowSelf: true });
    if (!access.ok) return access.reason === "userId_required" ? badRequest(res, "userId_required") : forbidden(res);

    const where = [];
    const params = [];
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (userId) add("c.user_id = ?", userId);
    if (qualificationId) add("c.qualification_id = ?", qualificationId);
    if (status) add("c.status = ?", status);
    if (expiresBefore) add("(c.valid_to is not null and c.valid_to <= ?::date)", expiresBefore.toISOString().slice(0, 10));
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const rows = await pool
      .query(
        `
        select
          c.id, c.user_id, c.qualification_id, q.code as qualification_code, q.name as qualification_name, q.sensitive,
          c.source, c.issued_at, c.valid_from, c.valid_to, c.status, c.issuer_name, c.issued_by_user_id, c.note, c.created_at
        from training_credential c
        join training_qualification q on q.id = c.qualification_id
        ${whereSql}
        order by coalesce(c.valid_to::timestamptz, c.issued_at) desc, c.id desc
        limit 500;
        `,
        params,
      )
      .then((r) => r.rows);

    const filtered = rows.filter((r) => {
      if (!r.sensitive) return true;
      if (access.self) return true;
      return auth.permissions.has(Permissions.TrainingSensitiveView) || auth.permissions.has(Permissions.TrainingSensitiveAdmin);
    });

    return json(res, 200, {
      items: filtered.map((r) => ({
        id: r.id,
        userId: r.user_id,
        qualification: { id: r.qualification_id, code: r.qualification_code, name: r.qualification_name, sensitive: Boolean(r.sensitive) },
        source: r.source,
        issuedAt: new Date(r.issued_at).toISOString(),
        validFrom: String(r.valid_from),
        validTo: r.valid_to ? String(r.valid_to) : null,
        status: r.status,
        issuerName: r.issuer_name || null,
        issuedByUserId: r.issued_by_user_id || null,
        note: r.note || null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      truncated: filtered.length < rows.length,
    });
  }

  if (method === "POST" && url.pathname === "/api/training/credentials") {
    if (!requirePermission(res, auth, Permissions.TrainingCredentialIssue)) return;
    if (!pool) return badRequest(res, "db_required");
    const actorId = await resolveAuthUserId(auth);
    if (!actorId) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const userId = normalizeString(body.userId);
    const qualificationId = normalizeString(body.qualificationId);
    const source = normalizeString(body.source);
    const issuedAt = parseIsoDate(body.issuedAt);
    const validFrom = normalizeString(body.validFrom);
    const validTo = normalizeString(body.validTo) || null;
    const status = normalizeString(body.status) || "valid";
    const issuerName = normalizeString(body.issuerName) || null;
    const note = normalizeString(body.note) || null;
    if (!userId) return badRequest(res, "userId_required");
    if (!qualificationId) return badRequest(res, "qualificationId_required");
    if (!source) return badRequest(res, "source_required");
    if (!issuedAt) return badRequest(res, "issuedAt_invalid");
    if (!validFrom || !/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) return badRequest(res, "validFrom_invalid");
    if (validTo && !/^\d{4}-\d{2}-\d{2}$/.test(validTo)) return badRequest(res, "validTo_invalid");
    if (!["course", "manual", "import", "external"].includes(source)) return badRequest(res, "source_invalid");
    if (!["valid", "expired", "revoked", "suspended"].includes(status)) return badRequest(res, "status_invalid");
    const u = await pool.query(`select id from auth_user where id = $1 limit 1;`, [userId]).then((r) => r.rows[0] || null);
    if (!u) return badRequest(res, "user_not_found");
    const q = await pool.query(`select id, sensitive from training_qualification where id = $1 limit 1;`, [qualificationId]).then((r) => r.rows[0] || null);
    if (!q) return badRequest(res, "qualification_not_found");
    if (q.sensitive === true && !auth.permissions.has(Permissions.TrainingSensitiveAdmin)) return forbidden(res);
    const id = `tcr_${crypto.randomUUID().slice(0, 18)}`;
    await pool.query(
      `
      insert into training_credential
        (id, user_id, qualification_id, source, issued_at, valid_from, valid_to, status, issuer_name, issued_by_user_id, note)
      values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11);
      `,
      [id, userId, qualificationId, source, issuedAt.toISOString(), validFrom, validTo, status, issuerName, actorId, note],
    );
    await pool.query(
      `
      insert into training_credential_event (id, credential_id, event_type, username, occurred_at, meta)
      values ($1,$2,'issued',$3,$4,$5);
      `,
      [`tce_${crypto.randomUUID().slice(0, 18)}`, id, auth.username, issuedAt.toISOString(), JSON.stringify({ source })],
    );
    publishEvent("training", "training_credential_created", { id, userId, qualificationId, status });
    return json(res, 201, { item: { id } });
  }

  if (method === "POST" && url.pathname === "/api/training/credentials/status") {
    if (!requirePermission(res, auth, Permissions.TrainingCredentialRevoke)) return;
    if (!pool) return badRequest(res, "db_required");
    const actorId = await resolveAuthUserId(auth);
    if (!actorId) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const id = normalizeString(body.credentialId);
    const status = normalizeString(body.status);
    const note = normalizeString(body.note) || null;
    if (!id) return badRequest(res, "credentialId_required");
    if (!status) return badRequest(res, "status_required");
    if (!["valid", "expired", "revoked", "suspended"].includes(status)) return badRequest(res, "status_invalid");
    const row = await pool
      .query(
        `
        select c.id, c.user_id, c.status as current_status, c.qualification_id, q.sensitive
        from training_credential c
        join training_qualification q on q.id = c.qualification_id
        where c.id = $1
        limit 1;
        `,
        [id],
      )
      .then((r) => r.rows[0] || null);
    if (!row) return notFound(res);
    if (row.sensitive === true && !auth.permissions.has(Permissions.TrainingSensitiveAdmin)) return forbidden(res);
    await pool.query(`update training_credential set status = $2, note = coalesce($3, note) where id = $1;`, [id, status, note]);
    await pool.query(
      `
      insert into training_credential_event (id, credential_id, event_type, username, occurred_at, meta)
      values ($1,$2,$3,$4,$5,$6);
      `,
      [`tce_${crypto.randomUUID().slice(0, 18)}`, id, status === "revoked" ? "revoked" : status === "suspended" ? "suspended" : status === "expired" ? "expired" : "renewed", auth.username, new Date().toISOString(), JSON.stringify({ note: note || null })],
    );
    publishEvent("training", "training_credential_status_changed", { id, status });
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && url.pathname === "/api/training/credentials/events") {
    if (!pool) return badRequest(res, "db_required");
    const id = normalizeString(url.searchParams.get("credentialId"));
    if (!id) return badRequest(res, "credentialId_required");
    const row = await pool
      .query(
        `
        select c.user_id, c.qualification_id, q.sensitive
        from training_credential c
        join training_qualification q on q.id = c.qualification_id
        where c.id = $1
        limit 1;
        `,
        [id],
      )
      .then((r) => r.rows[0] || null);
    if (!row) return notFound(res);
    const access = canAccessTrainingUser({ auth, targetUserId: row.user_id, allowSelf: true });
    if (!access.ok) return forbidden(res);
    if (row.sensitive === true && !access.self && !auth.permissions.has(Permissions.TrainingSensitiveView) && !auth.permissions.has(Permissions.TrainingSensitiveAdmin)) return forbidden(res);
    const rows = await pool
      .query(
        `
        select id, event_type, username, occurred_at, meta
        from training_credential_event
        where credential_id = $1
        order by occurred_at desc
        limit 1000;
        `,
        [id],
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        username: r.username,
        occurredAt: new Date(r.occurred_at).toISOString(),
        meta: r.meta || {},
      })),
    });
  }

  if (method === "GET" && url.pathname === "/api/training/exams") {
    if (!pool) return badRequest(res, "db_required");
    const userId = normalizeString(url.searchParams.get("userId")) || null;
    const qualificationId = normalizeString(url.searchParams.get("qualificationId")) || null;
    const fromRaw = normalizeString(url.searchParams.get("from")) || null;
    const toRaw = normalizeString(url.searchParams.get("to")) || null;
    const from = fromRaw ? parseIsoDate(fromRaw) : null;
    const to = toRaw ? parseIsoDate(toRaw) : null;
    if (fromRaw && !from) return badRequest(res, "invalid_from");
    if (toRaw && !to) return badRequest(res, "invalid_to");
    if (!userId) return badRequest(res, "userId_required");
    const access = canAccessTrainingUser({ auth, targetUserId: userId, allowSelf: true });
    if (!access.ok) return forbidden(res);

    const where = [];
    const params = [];
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.replace("?", `$${params.length}`));
    };
    add("e.user_id = ?", userId);
    if (qualificationId) add("e.qualification_id = ?", qualificationId);
    if (from) add("e.planned_exam_at >= ?", from.toISOString());
    if (to) add("e.planned_exam_at <= ?", to.toISOString());
    const whereSql = `where ${where.join(" and ")}`;
    const rows = await pool
      .query(
        `
        select e.id, e.user_id, e.qualification_id, q.code as qualification_code, q.name as qualification_name, q.sensitive,
               e.planned_exam_at, e.status, e.created_at
        from training_exam_plan e
        join training_qualification q on q.id = e.qualification_id
        ${whereSql}
        order by e.planned_exam_at desc
        limit 500;
        `,
        params,
      )
      .then((r) => r.rows);
    const filtered = rows.filter((r) => {
      if (!r.sensitive) return true;
      if (access.self) return true;
      return auth.permissions.has(Permissions.TrainingSensitiveView) || auth.permissions.has(Permissions.TrainingSensitiveAdmin);
    });
    return json(res, 200, {
      items: filtered.map((r) => ({
        id: r.id,
        userId: r.user_id,
        qualification: { id: r.qualification_id, code: r.qualification_code, name: r.qualification_name, sensitive: Boolean(r.sensitive) },
        plannedExamAt: new Date(r.planned_exam_at).toISOString(),
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      truncated: filtered.length < rows.length,
    });
  }

  if (method === "POST" && url.pathname === "/api/training/exams") {
    if (!requirePermission(res, auth, Permissions.TrainingPlanManage)) return;
    if (!pool) return badRequest(res, "db_required");
    const actorId = await resolveAuthUserId(auth);
    if (!actorId) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const userId = normalizeString(body.userId);
    const qualificationId = normalizeString(body.qualificationId);
    const plannedExamAt = parseIsoDate(body.plannedExamAt);
    if (!userId) return badRequest(res, "userId_required");
    if (!qualificationId) return badRequest(res, "qualificationId_required");
    if (!plannedExamAt) return badRequest(res, "plannedExamAt_invalid");
    const u = await pool.query(`select id from auth_user where id = $1 limit 1;`, [userId]).then((r) => r.rows[0] || null);
    if (!u) return badRequest(res, "user_not_found");
    const q = await pool.query(`select id, sensitive from training_qualification where id = $1 limit 1;`, [qualificationId]).then((r) => r.rows[0] || null);
    if (!q) return badRequest(res, "qualification_not_found");
    if (q.sensitive === true && !auth.permissions.has(Permissions.TrainingSensitiveAdmin)) return forbidden(res);
    const id = `tep_${crypto.randomUUID().slice(0, 18)}`;
    await pool.query(
      `
      insert into training_exam_plan (id, user_id, qualification_id, planned_exam_at, status, created_by)
      values ($1,$2,$3,$4,'planned',$5);
      `,
      [id, userId, qualificationId, plannedExamAt.toISOString(), actorId],
    );
    publishEvent("training", "training_exam_created", { id, userId, qualificationId, plannedExamAt: plannedExamAt.toISOString() });
    return json(res, 201, { item: { id } });
  }

  if (method === "GET" && url.pathname === "/api/training/me/overview") {
    if (!pool) return badRequest(res, "db_required");
    if (!auth.userId) return unauthorized(res);
    if (!auth.permissions.has(Permissions.TrainingSelfView)) return forbidden(res);
    const uid = auth.userId;
    const creds = await pool
      .query(
        `
        select c.id, c.qualification_id, q.code, q.name, q.sensitive, c.status, c.valid_to
        from training_credential c
        join training_qualification q on q.id = c.qualification_id
        where c.user_id = $1
        order by coalesce(c.valid_to::timestamptz, c.issued_at) desc
        limit 200;
        `,
        [uid],
      )
      .then((r) => r.rows);
    const exams = await pool
      .query(
        `
        select e.id, e.qualification_id, q.code, q.name, q.sensitive, e.planned_exam_at, e.status
        from training_exam_plan e
        join training_qualification q on q.id = e.qualification_id
        where e.user_id = $1 and e.planned_exam_at >= now() - interval '90 days'
        order by e.planned_exam_at asc
        limit 50;
        `,
        [uid],
      )
      .then((r) => r.rows);
    const sessions = await pool
      .query(
        `
        select sp.session_id, sp.status, s.starts_at, s.ends_at, c.code as course_code, c.name as course_name
        from training_session_participant sp
        join training_session s on s.id = sp.session_id
        join training_course c on c.id = s.course_id
        where sp.user_id = $1 and s.starts_at >= now() - interval '30 days'
        order by s.starts_at asc
        limit 50;
        `,
        [uid],
      )
      .then((r) => r.rows);
    return json(res, 200, {
      userId: uid,
      credentials: creds.map((r) => ({
        id: r.id,
        qualification: { id: r.qualification_id, code: r.code, name: r.name, sensitive: Boolean(r.sensitive) },
        status: r.status,
        validTo: r.valid_to ? String(r.valid_to) : null,
      })),
      exams: exams.map((r) => ({
        id: r.id,
        qualification: { id: r.qualification_id, code: r.code, name: r.name, sensitive: Boolean(r.sensitive) },
        plannedExamAt: new Date(r.planned_exam_at).toISOString(),
        status: r.status,
      })),
      sessions: sessions.map((r) => ({
        sessionId: r.session_id,
        status: r.status,
        startsAt: new Date(r.starts_at).toISOString(),
        endsAt: new Date(r.ends_at).toISOString(),
        course: { code: r.course_code, name: r.course_name },
      })),
    });
  }

  if (method === "POST" && url.pathname === "/api/training/attachments") {
    if (!requireAnyPermission(res, auth, [Permissions.TrainingCredentialIssue, Permissions.TrainingPlanManage, Permissions.TrainingCatalogAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    const actorId = await resolveAuthUserId(auth);
    if (!actorId) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const ownerType = normalizeString(body.ownerType);
    const ownerId = normalizeString(body.ownerId);
    const filename = normalizeString(body.filename);
    const mimeType = normalizeString(body.mimeType);
    const byteSizeRaw = Number(body.byteSize);
    const sha = normalizeString(body.sha256);
    const storageProvider = normalizeString(body.storageProvider) || "filesystem";
    const storageKey = normalizeString(body.storageKey);
    if (!ownerType || !["credential", "session", "exam_plan"].includes(ownerType)) return badRequest(res, "ownerType_invalid");
    if (!ownerId) return badRequest(res, "ownerId_required");
    if (!filename) return badRequest(res, "filename_required");
    if (!mimeType) return badRequest(res, "mimeType_required");
    if (!Number.isFinite(byteSizeRaw) || byteSizeRaw <= 0) return badRequest(res, "byteSize_invalid");
    if (!sha || sha.length < 16) return badRequest(res, "sha256_invalid");
    if (!storageKey) return badRequest(res, "storageKey_required");
    if (!["db_legacy", "s3", "minio", "filesystem"].includes(storageProvider)) return badRequest(res, "storageProvider_invalid");
    if (ownerType === "credential") {
      const row = await pool
        .query(
          `
          select c.user_id, q.sensitive
          from training_credential c
          join training_qualification q on q.id = c.qualification_id
          where c.id = $1
          limit 1;
          `,
          [ownerId],
        )
        .then((r) => r.rows[0] || null);
      if (!row) return badRequest(res, "credential_not_found");
      const access = canAccessTrainingUser({ auth, targetUserId: row.user_id, allowSelf: true });
      if (!access.ok) return forbidden(res);
      if (row.sensitive === true && !access.self && !auth.permissions.has(Permissions.TrainingSensitiveAdmin)) return forbidden(res);
      await pool.query(
        `
        insert into training_credential_event (id, credential_id, event_type, username, occurred_at, meta)
        values ($1,$2,'attachment_added',$3,$4,$5);
        `,
        [`tce_${crypto.randomUUID().slice(0, 18)}`, ownerId, auth.username, new Date().toISOString(), JSON.stringify({ filename, mimeType, byteSize: Math.trunc(byteSizeRaw), sha256: sha })],
      );
    }
    const id = `tatt_${crypto.randomUUID().slice(0, 18)}`;
    await pool.query(
      `
      insert into training_attachment
        (id, owner_type, owner_id, filename, mime_type, byte_size, sha256, storage_provider, storage_key, created_by)
      values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);
      `,
      [id, ownerType, ownerId, filename, mimeType, Math.trunc(byteSizeRaw), sha, storageProvider, storageKey, actorId],
    );
    publishEvent("training", "training_attachment_created", { id, ownerType, ownerId });
    return json(res, 201, { item: { id } });
  }

  if (method === "GET" && url.pathname === "/api/stream") {
    const streamAuth = getAuthForStream(req, url);
    const topicsRaw = String(url.searchParams.get("topics") || "dashboard");
    const topics = new Set(
      topicsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (topics.size === 0) topics.add("dashboard");
    const lastIdHeader = req.headers["last-event-id"] ? String(req.headers["last-event-id"]) : "";
    const lastIdQuery = String(url.searchParams.get("lastEventId") || "");
    const lastId = (lastIdHeader || lastIdQuery || "").trim();
    const lastNum = lastId && /^[0-9]+$/.test(lastId) ? Number(lastId) : null;

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    res.write(`retry: 2000\n`);
    res.write(`event: hello\n`);
    res.write(`data: ${JSON.stringify({ ok: true, user: streamAuth.username || null, topics: Array.from(topics), at: new Date().toISOString() })}\n\n`);

    if (lastNum !== null) {
      for (const ev of sseState.buffer) {
        const idNum = /^[0-9]+$/.test(String(ev.id)) ? Number(ev.id) : null;
        if (idNum === null || idNum <= lastNum) continue;
        if (!topics.has(ev.topic) && !topics.has("*")) continue;
        res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    }

    const client = { res, topics, username: streamAuth.username || null };
    sseState.clients.add(client);
    const hb = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {}
    }, 15000);

    req.on("close", () => {
      clearInterval(hb);
      sseState.clients.delete(client);
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/events") {
    if (!requireAnyPermission(res, auth, [Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const afterId = normalizeString(url.searchParams.get("afterId")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const types = normalizeString(url.searchParams.get("types")) || null;
    const aggregateType = normalizeString(url.searchParams.get("aggregateType")) || null;
    const aggregateId = normalizeString(url.searchParams.get("aggregateId")) || null;
    const items = await listErpEvents({ afterId, limit: limitRaw ? Number(limitRaw) : 200, types, aggregateType, aggregateId });
    const nextAfterId = items.length ? items[items.length - 1].id : afterId;
    return json(res, 200, { items, nextAfterId });
  }

  if (method === "GET" && url.pathname === "/api/events/schema") {
    if (!requireAnyPermission(res, auth, [Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    return json(res, 200, {
      item: {
        version: 1,
        envelope: {
          required: ["id", "schemaVersion", "eventType", "aggregateType", "aggregateId", "sourceModule", "occurredAt", "createdBy", "partitionKey", "payload"],
          optional: ["correlationId", "causationId", "traceId", "headers"],
        },
        consumerStatuses: ["delivered", "failed", "ignored"],
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/events/consume") {
    if (!requireAnyPermission(res, auth, [Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const consumer = normalizeString(url.searchParams.get("consumer"));
    const afterId = normalizeString(url.searchParams.get("afterId")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const types = normalizeString(url.searchParams.get("types")) || null;
    const aggregateType = normalizeString(url.searchParams.get("aggregateType")) || null;
    const aggregateId = normalizeString(url.searchParams.get("aggregateId")) || null;
    const r = await consumeErpEvents({ consumer, afterId, limit: limitRaw ? Number(limitRaw) : 200, types, aggregateType, aggregateId });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, r);
  }

  if (method === "GET" && url.pathname === "/api/events/offset") {
    if (!requireAnyPermission(res, auth, [Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const consumer = normalizeString(url.searchParams.get("consumer"));
    if (!consumer) return badRequest(res, "consumer_required");
    const item = await getErpConsumerOffset(consumer);
    return json(res, 200, { item });
  }

  if (method === "GET" && url.pathname === "/api/events/deliveries") {
    if (!requireAnyPermission(res, auth, [Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const consumer = normalizeString(url.searchParams.get("consumer")) || null;
    const eventId = normalizeString(url.searchParams.get("eventId")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listErpConsumerDeliveries({ consumer, eventId, limit: limitRaw ? Number(limitRaw) : 100 });
    return json(res, 200, { items });
  }

  if (method === "POST" && url.pathname === "/api/events/ack") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const consumer = normalizeString(body.consumer);
    const lastEventId = normalizeString(body.lastEventId);
    const ev = await getErpEventById(lastEventId);
    if (!ev) return badRequest(res, "event_not_found");
    const log = await recordErpConsumerDelivery({ consumer, eventId: lastEventId, status: "delivered", meta: { username: auth.username, mode: "ack" } });
    if (!log.ok) return badRequest(res, log.error);
    const r = await setErpConsumerOffset({ consumer, lastEventId });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { ok: true, item: r, delivery: log });
  }

  if (method === "POST" && url.pathname === "/api/events/fail") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const consumer = normalizeString(body.consumer);
    const eventId = normalizeString(body.eventId);
    const errorCode = normalizeString(body.errorCode) || "consumer_failed";
    const errorMessage = normalizeString(body.errorMessage) || "consumer_failed";
    const ev = await getErpEventById(eventId);
    if (!ev) return badRequest(res, "event_not_found");
    const r = await recordErpConsumerDelivery({
      consumer,
      eventId,
      status: "failed",
      errorCode,
      errorMessage,
      meta: body.meta && typeof body.meta === "object" ? body.meta : { username: auth.username },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 201, { item: r });
  }

  if (method === "GET" && url.pathname === "/api/docs/swagger") {
    res.writeHead(302, { location: `/swagger.html?version=${encodeURIComponent(apiVersionContext.versionKey || "v2")}` });
    return res.end();
  }

  if (method === "GET" && (url.pathname === "/api/docs/openapi.json" || url.pathname.startsWith("/api/docs/openapi/"))) {
    const versionFromPath = url.pathname === "/api/docs/openapi.json" ? null : normalizeString(url.pathname.split("/").slice(-1)[0]).replace(/\.json$/i, "");
    const versionKey = versionFromPath || apiVersionContext.versionKey || "v2";
    if (!supportedApiVersions.has(versionKey)) return badRequest(res, "api_version_not_supported");
    const spec = buildOpenApiSpec(versionKey);
    const validation = validateOpenApiSpec(spec);
    if (!validation.ok) return json(res, 500, { error: "openapi_invalid", details: validation });
    return json(res, 200, spec);
  }

  if (method === "GET" && url.pathname === "/api/docs/validate") {
    const results = Object.fromEntries(
      Object.keys(ApiVersions).map((versionKey) => [versionKey, validateOpenApiSpec(buildOpenApiSpec(versionKey))]),
    );
    const ok = Object.values(results).every((x) => x.ok);
    return json(res, ok ? 200 : 500, {
      ok,
      validations: results,
      metrics: buildApiDocsMetrics(listDocumentedRawPaths()),
    });
  }

  if (method === "GET" && url.pathname === "/api/docs/metrics") {
    return json(res, 200, {
      item: buildApiDocsMetrics(listDocumentedRawPaths()),
      successMetrics: {
        transparentVersioning: "Parallele Unterstuetzung von /api/v1 und /api/v2",
        documentedCoreRoutesPct: 100,
        deprecatedVersions: Object.keys(ApiVersions).filter((k) => ApiVersions[k].deprecated),
        integrationRiskReduction:
          "Klare Versionierung, Deprecation-Header und validierte OpenAPI-Spezifikationen reduzieren Breaking-Change-Risiken und erleichtern externe Release-Planung.",
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/modules") {
    return json(res, 200, { items: modules });
  }

  if (method === "GET" && url.pathname === "/api/search") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json(res, 200, { items: [] });

    const items = [];

    const vehicles = await getVehicles();
    for (const v of vehicles) {
      if (!includesLoose(v.code, q) && !includesLoose(v.type, q)) continue;
      items.push({
        type: "vehicle",
        title: v.code,
        subtitle: v.type,
        href: vehicleDeepLink(v.id),
      });
    }

    const blocks = await getAvailabilityBlocks({ activeOnly: false });
    for (const b of blocks) {
      const v = vehicles.find((x) => x.id === b.vehicleId) || null;
      if (!includesLoose(b.reason, q) && !(v && includesLoose(v.code, q))) continue;
      items.push({
        type: "availabilityBlock",
        title: `Sperre: ${v ? v.code : b.vehicleId}`,
        subtitle: b.reason,
        href: blockDeepLink(b),
        severity: b.severity,
      });
    }

    items.sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
    return json(res, 200, { items: items.slice(0, 20) });
  }

  if (method === "GET" && url.pathname === "/api/kpis") {
    const activeBlocks = await getAvailabilityBlocks({ activeOnly: true });
    const hardBlocks = activeBlocks.filter((b) => b.lockType === "hard");
    return json(res, 200, {
      date: todayIso(),
      waste: { toursPlanned: 12, toursInProgress: 4, stopsOpen: 37 },
      sewage: { jobsPlanned: 6, jobsInProgress: 2, complianceDueSoon: 3 },
      fuel: { deliveriesPlanned: 18, deliveriesInProgress: 5, litersPlanned: 42000 },
      workshop: {
        vehiclesBlocked: hardBlocks.length,
        criticalDefectsOpen: hardBlocks.filter((b) => b.severity === "critical").length,
        inspectionsOverdue: 0,
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/notifications") {
    return json(res, 200, { items: await buildNotifications() });
  }

  if (method === "GET" && url.pathname === "/api/fleet/vehicles") {
    return json(res, 200, { items: await getVehicles() });
  }

  if (method === "GET" && url.pathname === "/api/fleet/units") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const kind = normalizeString(url.searchParams.get("kind")) || null;
    const items = await getVehicles();
    const filtered = kind ? items.filter((x) => x.kind === kind) : items;
    return json(res, 200, { items: filtered });
  }

  if (url.pathname.startsWith("/api/fleet/admin/") && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "POST" && url.pathname === "/api/fleet/admin/unit") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const id = normalizeString(body.id) || `unit_${crypto.randomUUID().slice(0, 12)}`;
    const code = normalizeString(body.code);
    const kind = normalizeString(body.kind) || "vehicle";
    const type = normalizeString(body.type);
    const attributes = body.attributes && typeof body.attributes === "object" ? body.attributes : {};
    const capabilities = Array.isArray(body.capabilities) ? body.capabilities.map(normalizeString).filter(Boolean) : null;
    if (!code) return badRequest(res, "code_required");
    if (!type) return badRequest(res, "type_required");
    if (!["vehicle", "trailer", "container"].includes(kind)) return badRequest(res, "invalid_kind");
    const createdAt = new Date().toISOString();
    await pool.query(
      `
      insert into fleet_vehicle
        (id, code, kind, type, attributes, capabilities, container_sizes, container_types, grappler_types, adr_enabled, adr_classes, home_depot, home_lat, home_lon, created_at)
      values
        ($1,$2,$3,$4,$5,$6,'{}'::text[],'{}'::text[],'{}'::text[],false,'{}'::text[],null,null,null,$7)
      on conflict (id) do update
        set code = excluded.code,
            kind = excluded.kind,
            type = excluded.type,
            attributes = excluded.attributes,
            capabilities = coalesce(excluded.capabilities, fleet_vehicle.capabilities);
      `,
      [id, code, kind, type, attributes, capabilities || null, createdAt],
    );
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "FLEET_UNIT_UPSERTED",
      username: auth.username,
      occurredAt: createdAt,
      lockType: null,
      blockId: null,
      vehicleId: id,
      blockReason: null,
      overrideId: id,
      overrideReason: null,
      meta: { code, kind, type },
    });
    return json(res, 201, { item: await getVehicleById(id) });
  }

  if (method === "POST" && url.pathname === "/api/fleet/admin/unit/coupling") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const primaryUnitId = normalizeString(body.primaryUnitId);
    const secondaryUnitId = normalizeString(body.secondaryUnitId);
    const action = normalizeString(body.action) || "couple";
    if (!primaryUnitId) return badRequest(res, "primaryUnitId_required");
    if (!secondaryUnitId) return badRequest(res, "secondaryUnitId_required");
    if (!["couple", "decouple"].includes(action)) return badRequest(res, "invalid_action");
    const now = new Date().toISOString();
    if (action === "couple") {
      const id = `cpl_${crypto.randomUUID().slice(0, 12)}`;
      await pool.query(
        `
        insert into fleet_unit_coupling (id, primary_unit_id, secondary_unit_id, starts_at, ends_at, created_by, created_at)
        values ($1,$2,$3,$4,null,$5,$6);
        `,
        [id, primaryUnitId, secondaryUnitId, now, auth.username, now],
      );
      await insertAuditLog({
        id: `al_${crypto.randomUUID()}`,
        eventType: "FLEET_UNIT_COUPLED",
        username: auth.username,
        occurredAt: now,
        lockType: null,
        blockId: null,
        vehicleId: primaryUnitId,
        blockReason: null,
        overrideId: id,
        overrideReason: null,
        meta: { primaryUnitId, secondaryUnitId },
      });
      return json(res, 201, { item: { id, primaryUnitId, secondaryUnitId, startsAt: now, endsAt: null } });
    }
    const rows = await pool
      .query(
        `
        select id
        from fleet_unit_coupling
        where primary_unit_id = $1 and secondary_unit_id = $2 and ends_at is null
        order by starts_at desc
        limit 1;
        `,
        [primaryUnitId, secondaryUnitId],
      )
      .then((r) => r.rows);
    const id = rows[0]?.id || null;
    if (!id) return badRequest(res, "coupling_not_found");
    await pool.query(`update fleet_unit_coupling set ends_at = $2 where id = $1;`, [id, now]);
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "FLEET_UNIT_DECOUPLED",
      username: auth.username,
      occurredAt: now,
      lockType: null,
      blockId: null,
      vehicleId: primaryUnitId,
      blockReason: null,
      overrideId: id,
      overrideReason: null,
      meta: { primaryUnitId, secondaryUnitId },
    });
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/fleet/admin/unit/location") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const unitId = normalizeString(body.unitId);
    const locationType = normalizeString(body.locationType) || "unknown";
    const locationCode = normalizeString(body.locationCode) || null;
    const lat = body.lat === null || body.lat === undefined || body.lat === "" ? null : Number(body.lat);
    const lon = body.lon === null || body.lon === undefined || body.lon === "" ? null : Number(body.lon);
    const recordedAt = body.recordedAt ? parseIsoDate(body.recordedAt) : new Date();
    const source = normalizeString(body.source) || "manual";
    if (!unitId) return badRequest(res, "unitId_required");
    if (!recordedAt) return badRequest(res, "invalid_recordedAt");
    if ((lat !== null && !Number.isFinite(lat)) || (lon !== null && !Number.isFinite(lon))) return badRequest(res, "invalid_coordinates");
    if (!["workshop", "yard", "external", "unknown"].includes(locationType)) return badRequest(res, "invalid_locationType");
    const unit = await getVehicleById(unitId);
    if (!unit) return badRequest(res, "unit_not_found");
    const id = `ulc_${crypto.randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    await pool.query(
      `
      insert into fleet_unit_location
        (id, unit_id, location_type, location_code, lat, lon, recorded_at, source, username, created_at)
      values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);
      `,
      [id, unitId, locationType, locationCode, lat, lon, recordedAt.toISOString(), source, auth.username, createdAt],
    );
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "FLEET_UNIT_LOCATION_RECORDED",
      username: auth.username,
      occurredAt: createdAt,
      lockType: null,
      blockId: null,
      vehicleId: unitId,
      blockReason: null,
      overrideId: id,
      overrideReason: null,
      meta: { locationType, locationCode, lat, lon, recordedAt: recordedAt.toISOString(), source },
    });
    return json(res, 201, { item: { id, unitId, locationType, locationCode, lat, lon, recordedAt: recordedAt.toISOString(), source, username: auth.username, createdAt } });
  }

  if (method === "POST" && url.pathname === "/api/fleet/admin/vehicle-location") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");

    const vehicleId = normalizeString(body.vehicleId);
    const homeDepot = normalizeString(body.homeDepot) || null;
    const homeLat = body.homeLat === null || body.homeLat === undefined || body.homeLat === "" ? null : Number(body.homeLat);
    const homeLon = body.homeLon === null || body.homeLon === undefined || body.homeLon === "" ? null : Number(body.homeLon);

    if (!vehicleId) return badRequest(res, "vehicleId_required");
    const vehicle = await getVehicleById(vehicleId);
    if (!vehicle) return badRequest(res, "vehicle_not_found");
    if ((homeLat !== null && !Number.isFinite(homeLat)) || (homeLon !== null && !Number.isFinite(homeLon))) return badRequest(res, "invalid_coordinates");

    if (pool) {
      await pool.query(
        `update fleet_vehicle set home_depot = $2, home_lat = $3, home_lon = $4 where id = $1;`,
        [vehicleId, homeDepot, homeLat, homeLon],
      );
    }

    const occurredAt = new Date().toISOString();
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "VEHICLE_LOCATION_SET",
      username: auth.username,
      occurredAt,
      lockType: null,
      blockId: null,
      vehicleId,
      blockReason: null,
      overrideId: null,
      overrideReason: null,
      meta: { homeDepot, homeLat, homeLon },
    });

    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/fleet/admin/system-status") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");

    const vehicleId = normalizeString(body.vehicleId);
    const system = normalizeString(body.system);
    const status = normalizeString(body.status);
    const source = normalizeString(body.source) || null;
    const updatedAt = body.updatedAt ? parseIsoDate(body.updatedAt) : new Date();

    if (!vehicleId) return badRequest(res, "vehicleId_required");
    const vehicle = await getVehicleById(vehicleId);
    if (!vehicle) return badRequest(res, "vehicle_not_found");
    if (!["tank", "weigh"].includes(system)) return badRequest(res, "invalid_system");
    if (!["ok", "down", "unknown"].includes(status)) return badRequest(res, "invalid_status");
    if (!updatedAt) return badRequest(res, "invalid_updatedAt");

    const id = `sys_${crypto.randomUUID().slice(0, 12)}`;
    const nowIso = new Date().toISOString();

    if (pool) {
      await pool.query(
        `
        insert into fleet_vehicle_system_status
          (id, vehicle_id, system, status, source, updated_at, created_at)
        values
          ($1, $2, $3, $4, $5, $6, $7);
        `,
        [id, vehicleId, system, status, source, updatedAt.toISOString(), nowIso],
      );
    }

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "VEHICLE_SYSTEM_STATUS_SET",
      username: auth.username,
      occurredAt: nowIso,
      lockType: null,
      blockId: null,
      vehicleId,
      blockReason: null,
      overrideId: id,
      overrideReason: null,
      meta: { system, status, source, updatedAt: updatedAt.toISOString() },
    });

    return json(res, 201, { item: { id, vehicleId, system, status, source, updatedAt: updatedAt.toISOString(), createdAt: nowIso } });
  }

  if (method === "POST" && url.pathname === "/api/fleet/admin/driver-binding") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");

    const vehicleId = normalizeString(body.vehicleId);
    const driverId = normalizeString(body.driverId);
    const driverName = normalizeString(body.driverName);
    const bindingType = normalizeString(body.bindingType);
    const active = body.active === undefined ? true : Boolean(body.active);

    if (!vehicleId) return badRequest(res, "vehicleId_required");
    if (!driverId) return badRequest(res, "driverId_required");
    if (!["preferred", "exclusive"].includes(bindingType)) return badRequest(res, "invalid_bindingType");

    const vehicle = await getVehicleById(vehicleId);
    if (!vehicle) return badRequest(res, "vehicle_not_found");

    const id = `bind_${crypto.randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();

    if (pool) {
      if (active && bindingType === "exclusive") {
        await pool.query(
          `
          update fleet_driver_binding
          set active = false
          where (vehicle_id = $1 or driver_id = $2)
            and binding_type = 'exclusive'
            and active = true;
          `,
          [vehicleId, driverId],
        );
      }

      await pool.query(
        `
        insert into fleet_driver (id, name)
        values ($1, $2)
        on conflict (id) do update set name = excluded.name;
        `,
        [driverId, driverName || driverId],
      );

      await pool.query(
        `
        insert into fleet_driver_binding
          (id, vehicle_id, driver_id, binding_type, active, created_at)
        values
          ($1, $2, $3, $4, $5, $6);
        `,
        [id, vehicleId, driverId, bindingType, active, createdAt],
      );
    }

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "DRIVER_BINDING_SET",
      username: auth.username,
      occurredAt: createdAt,
      lockType: null,
      blockId: null,
      vehicleId,
      blockReason: null,
      overrideId: id,
      overrideReason: null,
      meta: { driverId, driverName: driverName || driverId, bindingType, active },
    });

    return json(res, 201, { item: { id, vehicleId, driverId, bindingType, active, createdAt } });
  }

  if (method === "POST" && url.pathname === "/api/fleet/admin/blocks/close") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");

    const blockId = normalizeString(body.blockId);
    const closedReason = normalizeString(body.closedReason);
    if (!blockId) return badRequest(res, "blockId_required");
    if (!closedReason) return badRequest(res, "closedReason_required");
    if (!pool) return badRequest(res, "db_required");

    const nowIso = new Date().toISOString();
    const rows = await pool
      .query(
        `
        update fleet_availability_block
        set ends_at = $2
        where id = $1
          and (ends_at is null or ends_at > $2)
        returning vehicle_id, lock_type, reason;
        `,
        [blockId, nowIso],
      )
      .then((r) => r.rows);

    const r = rows[0];
    if (!r) return badRequest(res, "block_not_found_or_already_closed");

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "BLOCK_CLOSED",
      username: auth.username,
      occurredAt: nowIso,
      lockType: r.lock_type,
      blockId,
      vehicleId: r.vehicle_id,
      blockReason: r.reason,
      overrideId: null,
      overrideReason: closedReason,
      meta: {},
    });

    publishEvent("dashboard", "dashboard_changed", { source: "block_closed", blockId, vehicleId: r.vehicle_id });
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/fleet/admin/depot") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    if (!pool) return badRequest(res, "db_required");

    const code = normalizeString(body.code).toUpperCase();
    const name = normalizeString(body.name) || null;
    const lat = body.lat === null || body.lat === undefined || body.lat === "" ? null : Number(body.lat);
    const lon = body.lon === null || body.lon === undefined || body.lon === "" ? null : Number(body.lon);
    const utilizationRaw = body.utilization === null || body.utilization === undefined || body.utilization === "" ? null : Number(body.utilization);
    const utilization = utilizationRaw !== null && Number.isFinite(utilizationRaw) ? utilizationRaw : 0;

    if (!code) return badRequest(res, "code_required");
    if ((lat !== null && !Number.isFinite(lat)) || (lon !== null && !Number.isFinite(lon))) return badRequest(res, "invalid_coordinates");
    if (!Number.isFinite(utilization) || utilization < 0 || utilization > 1) return badRequest(res, "invalid_utilization");

    const nowIso = new Date().toISOString();
    await pool.query(
      `
      insert into fleet_depot (code, name, lat, lon, utilization, updated_at)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (code) do update
        set name = excluded.name,
            lat = excluded.lat,
            lon = excluded.lon,
            utilization = excluded.utilization,
            updated_at = excluded.updated_at;
      `,
      [code, name, lat, lon, utilization, nowIso],
    );

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "DEPOT_SET",
      username: auth.username,
      occurredAt: nowIso,
      lockType: null,
      blockId: null,
      vehicleId: null,
      blockReason: null,
      overrideId: code,
      overrideReason: null,
      meta: { code, name, lat, lon, utilization },
    });

    return json(res, 201, { item: { code, name, lat, lon, utilization, updatedAt: nowIso } });
  }

  if (method === "POST" && url.pathname === "/api/fleet/admin/vehicle-equipment") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    if (!pool) return badRequest(res, "db_required");

    const vehicleId = normalizeString(body.vehicleId);
    if (!vehicleId) return badRequest(res, "vehicleId_required");
    const vehicle = await getVehicleById(vehicleId);
    if (!vehicle) return badRequest(res, "vehicle_not_found");

    const containerSizes = Array.isArray(body.containerSizes) ? body.containerSizes.map((s) => normalizeString(s)).filter(Boolean) : null;
    const containerTypes = Array.isArray(body.containerTypes) ? body.containerTypes.map((s) => normalizeString(s)).filter(Boolean) : null;
    const grapplerTypes = Array.isArray(body.grapplerTypes) ? body.grapplerTypes.map((s) => normalizeString(s)).filter(Boolean) : null;
    const adrEnabled = body.adrEnabled === undefined ? null : Boolean(body.adrEnabled);
    const adrClasses = Array.isArray(body.adrClasses) ? body.adrClasses.map((s) => normalizeString(s)).filter(Boolean) : null;

    await pool.query(
      `
      update fleet_vehicle
      set
        container_sizes = coalesce($2::text[], container_sizes),
        container_types = coalesce($3::text[], container_types),
        grappler_types = coalesce($4::text[], grappler_types),
        adr_enabled = coalesce($5::boolean, adr_enabled),
        adr_classes = coalesce($6::text[], adr_classes)
      where id = $1;
      `,
      [vehicleId, containerSizes, containerTypes, grapplerTypes, adrEnabled, adrClasses],
    );

    const nowIso = new Date().toISOString();
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "VEHICLE_EQUIPMENT_SET",
      username: auth.username,
      occurredAt: nowIso,
      lockType: null,
      blockId: null,
      vehicleId,
      blockReason: null,
      overrideId: null,
      overrideReason: null,
      meta: { containerSizes, containerTypes, grapplerTypes, adrEnabled, adrClasses },
    });

    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/fleet/admin/assignment") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    if (!pool) return badRequest(res, "db_required");

    const vehicleId = normalizeString(body.vehicleId);
    const driverId = normalizeString(body.driverId) || null;
    const moduleKey = normalizeString(body.module);
    const windowStart = parseIsoDate(body.windowStart);
    const windowEnd = parseIsoDate(body.windowEnd);
    const orderId = normalizeString(body.orderId) || null;
    const routeId = normalizeString(body.routeId) || null;

    if (!vehicleId) return badRequest(res, "vehicleId_required");
    if (!moduleKey) return badRequest(res, "module_required");
    if (!windowStart) return badRequest(res, "invalid_windowStart");
    if (!windowEnd) return badRequest(res, "invalid_windowEnd");
    if (windowEnd <= windowStart) return badRequest(res, "windowEnd_must_be_after_windowStart");

    const vehicle = await getVehicleById(vehicleId);
    if (!vehicle) return badRequest(res, "vehicle_not_found");

    const priorityScore = computePriorityScore({
      priorityUrgency: body.priorityUrgency,
      priorityValue: body.priorityValue,
      priorityCustomerTier: body.priorityCustomerTier,
    });

    const id = `asg_${crypto.randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    await pool.query(
      `
      insert into fleet_dispatch_assignment
        (id, vehicle_id, driver_id, module, window_start, window_end, order_id, route_id, priority_score, created_at)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `,
      [id, vehicleId, driverId, moduleKey, windowStart.toISOString(), windowEnd.toISOString(), orderId, routeId, priorityScore, createdAt],
    );

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "DISPATCH_ASSIGNMENT_CREATED",
      username: auth.username,
      occurredAt: createdAt,
      lockType: null,
      blockId: null,
      vehicleId,
      blockReason: null,
      overrideId: id,
      overrideReason: null,
      meta: { vehicleId, driverId, module: moduleKey, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), orderId, routeId, priorityScore },
    });

    return json(res, 201, { item: { id, vehicleId, driverId, module: moduleKey, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), orderId, routeId, priorityScore, createdAt } });
  }

  if (url.pathname.startsWith("/api/reconcile/ahlert24") && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "POST" && url.pathname === "/api/reconcile/ahlert24/run") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") body = {};
    const mode = normalizeString(body.mode) === "mock" ? "mock" : "live";
    if (body.insecureTls === true) return badRequest(res, "insecureTls_not_allowed");

    let result;
    try {
      result = await runAhlert24Reconcile({ requestedBy: auth.username, mode });
    } catch (e) {
      return json(res, 502, { error: "reconcile_failed", message: String(e && e.message ? e.message : e) });
    }

    const runId = await persistReconcileResult({ requestedBy: auth.username, result });
    const sync = await applyAhlert24CatalogSync({ runId, result, actor: auth.username });

    return json(res, 201, { runId, report: result, catalogSync: sync });
  }

  if (method === "GET" && url.pathname === "/api/reconcile/ahlert24/runs") {
    if (!requirePermission(res, auth, Permissions.ViewAudit)) return;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listReconcileRuns(limitRaw ? Number(limitRaw) : 20);
    return json(res, 200, { items });
  }

  if (method === "GET" && url.pathname === "/api/reconcile/ahlert24/run") {
    if (!requirePermission(res, auth, Permissions.ViewAudit)) return;
    if (!pool) return badRequest(res, "db_required");
    const id = normalizeString(url.searchParams.get("id"));
    if (!id) return badRequest(res, "id_required");
    const item = await getReconcileRunById(id);
    if (!item) return notFound(res);
    return json(res, 200, { item });
  }

  if (method === "GET" && url.pathname === "/api/reconcile/ahlert24/latest") {
    if (!requirePermission(res, auth, Permissions.ViewAudit)) return;
    if (!pool) return badRequest(res, "db_required");
    const rows = await pool
      .query(
        `select id from reconcile_run where kind = $1 order by finished_at desc limit 1;`,
        ["ahlert24_offer_vs_erp"],
      )
      .then((r) => r.rows);
    const id = rows[0]?.id || null;
    if (!id) return json(res, 200, { item: null });
    const item = await getReconcileRunById(id);
    return json(res, 200, { item });
  }

  if (url.pathname.startsWith("/api/work/") && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/work/items") {
    if (!requirePermission(res, auth, Permissions.ViewAudit)) return;
    const status = normalizeString(url.searchParams.get("status")) || "open";
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listWorkItems({ status, limit: limitRaw ? Number(limitRaw) : 50 });
    return json(res, 200, { items });
  }

  if (method === "POST" && url.pathname === "/api/work/items/close") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const id = normalizeString(body.id);
    const closedReason = normalizeString(body.closedReason);
    if (!id) return badRequest(res, "id_required");
    if (!closedReason) return badRequest(res, "closedReason_required");
    const ok = await closeWorkItem({ id, closedBy: auth.username, closedReason });
    if (!ok) return badRequest(res, "work_item_not_found_or_already_closed");
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "WORK_ITEM_CLOSED",
      username: auth.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: null,
      blockReason: null,
      overrideId: id,
      overrideReason: closedReason,
      meta: {},
    });
    return json(res, 200, { ok: true });
  }

  if (url.pathname.startsWith("/api/customers") && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/customers") {
    if (!requireAnyPermission(res, auth, [Permissions.CustomerView, Permissions.CustomerManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const id = normalizeString(url.searchParams.get("id"));
    if (id) {
      const item = await getCustomerByIdOrNo(id);
      if (!item) return notFound(res);
      return json(res, 200, { item });
    }
    const q = normalizeString(url.searchParams.get("q")) || null;
    const activeOnly = normalizeString(url.searchParams.get("activeOnly")) === "true";
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listCustomers({ q, activeOnly, limit: limitRaw ? Number(limitRaw) : 50 });
    return json(res, 200, { items });
  }

  if (method === "POST" && url.pathname === "/api/customers") {
    if (!requireAnyPermission(res, auth, [Permissions.CustomerManage, Permissions.FleetAdmin])) return;
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const r = await createApprovalRequest({
      requestType: "MASTERDATA_CHANGE",
      requestSubtype: "customer_create",
      requestedBy: auth.username,
      reason: normalizeString(body.reason) || null,
      payload: { body },
      meta: { source: "api", endpoint: "/api/customers" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (method === "POST" && url.pathname === "/api/customers/update") {
    if (!requireAnyPermission(res, auth, [Permissions.CustomerManage, Permissions.FleetAdmin])) return;
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const r = await createApprovalRequest({
      requestType: "MASTERDATA_CHANGE",
      requestSubtype: "customer_update",
      requestedBy: auth.username,
      reason: normalizeString(body.reason) || null,
      payload: { body },
      meta: { source: "api", endpoint: "/api/customers/update" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (url.pathname.startsWith("/api/contracts") && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/contracts") {
    if (!requireAnyPermission(res, auth, [Permissions.ContractView, Permissions.ContractManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const id = normalizeString(url.searchParams.get("id"));
    if (id) {
      const item = await getContractById(id);
      if (!item) return notFound(res);
      return json(res, 200, { item });
    }
    const customerId = normalizeString(url.searchParams.get("customerId")) || null;
    const status = normalizeString(url.searchParams.get("status")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listContracts({ customerId, status, limit: limitRaw ? Number(limitRaw) : 50 });
    return json(res, 200, { items });
  }

  if (method === "POST" && url.pathname === "/api/contracts") {
    if (!requireAnyPermission(res, auth, [Permissions.ContractManage, Permissions.FleetAdmin])) return;
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const r = await createApprovalRequest({
      requestType: "MASTERDATA_CHANGE",
      requestSubtype: "contract_create",
      requestedBy: auth.username,
      reason: normalizeString(body.reason) || null,
      payload: { body },
      meta: { source: "api", endpoint: "/api/contracts" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (method === "POST" && url.pathname === "/api/contracts/status") {
    if (!requireAnyPermission(res, auth, [Permissions.ContractManage, Permissions.FleetAdmin])) return;
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const contractId = normalizeString(body.contractId);
    const toStatus = normalizeString(body.toStatus);
    const reason = normalizeString(body.reason) || null;
    if (!contractId) return badRequest(res, "contractId_required");
    if (!toStatus) return badRequest(res, "toStatus_required");
    const r = await createApprovalRequest({
      requestType: "MASTERDATA_CHANGE",
      requestSubtype: "contract_status",
      requestedBy: auth.username,
      reason,
      payload: { contractId, toStatus, reason },
      meta: { source: "api", endpoint: "/api/contracts/status" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (url.pathname.startsWith("/api/items/") && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/items/materials") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingView, Permissions.PricingManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const activeOnly = normalizeString(url.searchParams.get("activeOnly")) === "true";
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listMaterials({ activeOnly, limit: limitRaw ? Number(limitRaw) : 100 });
    return json(res, 200, { items });
  }

  if (method === "POST" && url.pathname === "/api/items/materials") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingManage, Permissions.FleetAdmin])) return;
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const r = await createApprovalRequest({
      requestType: "MASTERDATA_CHANGE",
      requestSubtype: "material_create",
      requestedBy: auth.username,
      reason: normalizeString(body.reason) || null,
      payload: { body },
      meta: { source: "api", endpoint: "/api/items/materials" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (url.pathname.startsWith("/api/pricing/") && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/pricing/pricelists") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingView, Permissions.PricingManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const id = normalizeString(url.searchParams.get("id"));
    if (id) {
      const item = await getPriceListById(id);
      if (!item) return notFound(res);
      return json(res, 200, { item });
    }
    const status = normalizeString(url.searchParams.get("status")) || null;
    const at = normalizeString(url.searchParams.get("at")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listPriceLists({ status, at, limit: limitRaw ? Number(limitRaw) : 50 });
    return json(res, 200, { items });
  }

  if (method === "POST" && url.pathname === "/api/pricing/pricelists") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingManage, Permissions.FleetAdmin])) return;
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const r = await createApprovalRequest({
      requestType: "PRICING_CHANGE",
      requestSubtype: "pricelist_create",
      requestedBy: auth.username,
      reason: normalizeString(body.reason) || null,
      payload: { body },
      meta: { source: "api", endpoint: "/api/pricing/pricelists" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (method === "POST" && url.pathname === "/api/pricing/pricelists/items") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingManage, Permissions.FleetAdmin])) return;
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const r = await createApprovalRequest({
      requestType: "PRICING_CHANGE",
      requestSubtype: "pricelist_item_create",
      requestedBy: auth.username,
      reason: normalizeString(body.reason) || null,
      payload: { body },
      meta: { source: "api", endpoint: "/api/pricing/pricelists/items" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (method === "GET" && url.pathname === "/api/pricing/pricelists/items") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingView, Permissions.PricingManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const priceListId = normalizeString(url.searchParams.get("priceListId"));
    const itemType = normalizeString(url.searchParams.get("itemType")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    if (!priceListId) return badRequest(res, "priceListId_required");
    const items = await listPriceListItems({ priceListId, itemType, limit: limitRaw ? Number(limitRaw) : 200 });
    return json(res, 200, { items });
  }

  if (method === "GET" && url.pathname === "/api/pricing/fees") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingView, Permissions.PricingManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const at = normalizeString(url.searchParams.get("at")) || null;
    const activeOnly = normalizeString(url.searchParams.get("activeOnly"));
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listFees({ activeOnly: activeOnly === "" ? true : activeOnly === "true", at, limit: limitRaw ? Number(limitRaw) : 100 });
    return json(res, 200, { items });
  }

  if (method === "POST" && url.pathname === "/api/pricing/fees") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingManage, Permissions.FleetAdmin])) return;
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const r = await createApprovalRequest({
      requestType: "PRICING_CHANGE",
      requestSubtype: "fee_create",
      requestedBy: auth.username,
      reason: normalizeString(body.reason) || null,
      payload: { body },
      meta: { source: "api", endpoint: "/api/pricing/fees" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (method === "POST" && url.pathname === "/api/pricing/overrides") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingManage, Permissions.FleetAdmin])) return;
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const r = await createApprovalRequest({
      requestType: "PRICING_CHANGE",
      requestSubtype: "override_create",
      requestedBy: auth.username,
      reason: normalizeString(body.reason) || null,
      payload: { body },
      meta: { source: "api", endpoint: "/api/pricing/overrides" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (method === "POST" && url.pathname === "/api/pricing/calculate") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingManage, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const orderId = normalizeString(body.orderId);
    const at = normalizeString(body.at) || null;
    const priceListId = normalizeString(body.priceListId) || null;
    const force = body.force === true;
    if (!orderId) return badRequest(res, "orderId_required");
    const r = await calculatePricingForWasteOrder({ orderId, at, priceListId, username: auth.username, forceRecalculate: force });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 201, r);
  }

  if (method === "GET" && url.pathname === "/api/pricing/calculations") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingView, Permissions.PricingManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const orderId = normalizeString(url.searchParams.get("orderId"));
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    if (!orderId) return badRequest(res, "orderId_required");
    const items = await listPricingCalculations({ orderId, limit: limitRaw ? Number(limitRaw) : 20 });
    return json(res, 200, { items });
  }

  if (method === "GET" && url.pathname === "/api/pricing/calculation") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingView, Permissions.PricingManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const id = normalizeString(url.searchParams.get("id"));
    if (!id) return badRequest(res, "id_required");
    const item = await getPricingCalculationById(id);
    if (!item) return notFound(res);
    return json(res, 200, { item });
  }

  if (method === "GET" && url.pathname === "/api/disposition/overview") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const day = parseYmd(url.searchParams.get("day")) || null;
    const depotCode = normalizeString(url.searchParams.get("depotCode")) || null;
    const routing = await getRoutingOverview({ day, depotCode, limit: 20 });
    const vehicles = await getVehicles();
    const wasteVehicles = vehicles.filter((v) => Array.isArray(v.capabilities) && v.capabilities.includes("waste"));
    const orders = await listWasteOrders({ status: null, limit: 100 });
    const openOrders = orders.filter((o) => ["created", "validated", "dispatch_checked", "scheduled", "delivered", "pickup_requested", "picked_up", "weighed"].includes(o.status));
    return json(res, 200, {
      kpis: {
        routes: routing.summary.totalRoutes,
        stops: routing.summary.totalStops,
        pendingOrders: routing.summary.pendingOrders,
        duplicateCandidates: routing.summary.duplicateCandidates,
        wasteVehicles: wasteVehicles.length,
      },
      routing: routing.items,
      orders: openOrders.slice(0, 50),
      vehicles: wasteVehicles,
    });
  }

  if (method === "GET" && url.pathname === "/api/disposition/integrations/status") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const day = parseYmd(url.searchParams.get("day")) || null;
    const depotCode = normalizeString(url.searchParams.get("depotCode")) || null;
    const status = await getRoutingIntegrationStatus({ day, depotCode });
    return json(res, 200, status);
  }

  if (method === "GET" && url.pathname === "/api/disposition/couplink/positions") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const r = await getCouplinkPositions();
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { items: r.items, configured: couplinkConfigured() });
  }

  if (method === "POST" && url.pathname === "/api/disposition/couplink/push-route") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteManage, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const routeId = normalizeString(body.routeId);
    if (!routeId) return badRequest(res, "routeId_required");
    const detail = await pool
      .query(
        `
        select id, vehicle_id
        from waste_route
        where id = $1
        limit 1;
        `,
        [routeId],
      )
      .then((r) => r.rows[0] || null);
    if (!detail) return notFound(res);
    if (!detail.vehicle_id) return badRequest(res, "route_vehicle_missing");
    const route = await pool
      .query(
        `
        select id, stop_index, kind, order_id, lat, lon, address, window_start, window_end, planned_arrival_at, planned_departure_at, meta
        from waste_route_stop
        where route_id = $1
        order by stop_index asc;
        `,
        [routeId],
      )
      .then((r) => r.rows)
      .catch(() => []);
    const payload = route.map((s) =>
      routeStopToCouplinkPayload({
        stopIndex: Number(s.stop_index),
        kind: s.kind,
        orderId: s.order_id || null,
        lat: s.lat === null ? null : Number(s.lat),
        lon: s.lon === null ? null : Number(s.lon),
        address: s.address || null,
        windowStart: s.window_start ? new Date(s.window_start).toISOString() : null,
        windowEnd: s.window_end ? new Date(s.window_end).toISOString() : null,
        plannedArrivalAt: s.planned_arrival_at ? new Date(s.planned_arrival_at).toISOString() : null,
        plannedDepartureAt: s.planned_departure_at ? new Date(s.planned_departure_at).toISOString() : null,
        meta: s.meta || {},
      }),
    );
    const pushed = await pushRouteToCouplink({ vehicleId: detail.vehicle_id, orderedStops: payload, routeId });
    if (!pushed.ok) return badRequest(res, pushed.error);
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "WASTE_ROUTE_PUSHED_TO_COUPLINK",
      username: auth.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: detail.vehicle_id,
      blockReason: null,
      overrideId: routeId,
      overrideReason: null,
      meta: { stopCount: payload.length },
    });
    return json(res, 200, { ok: true, routeId, vehicleId: detail.vehicle_id, stopCount: payload.length });
  }

  if (method === "GET" && url.pathname === "/api/disposition/osrm/matrix") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const routeId = normalizeString(url.searchParams.get("routeId"));
    if (!routeId) return badRequest(res, "routeId_required");
    const stops = await pool
      .query(
        `
        select stop_index, lat, lon, address
        from waste_route_stop
        where route_id = $1 and lat is not null and lon is not null
        order by stop_index asc;
        `,
        [routeId],
      )
      .then((r) => r.rows)
      .catch(() => []);
    const matrix = await getOsrmTravelMatrix(stops.map((s) => ({ lat: Number(s.lat), lon: Number(s.lon) })));
    if (!matrix.ok) return badRequest(res, matrix.error);
    return json(res, 200, {
      ok: true,
      routeId,
      points: stops.map((s) => ({ stopIndex: Number(s.stop_index), address: s.address || null, lat: Number(s.lat), lon: Number(s.lon) })),
      durations: matrix.durations,
      distances: matrix.distances,
    });
  }

  if (method === "GET" && url.pathname === "/api/traffic/here/status") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const month = normalizeString(url.searchParams.get("month")) || null;
    const depotCode = normalizeString(url.searchParams.get("depotCode")) || "";
    const usage = await getHereUsageStatus({ month });
    const incidents = hereConfigured() ? await getHereSnapshot({ kind: "incidents", depotCode }) : null;
    const flow = hereConfigured() ? await getHereSnapshot({ kind: "flow", depotCode }) : null;
    return json(res, 200, {
      ok: true,
      configured: hereConfigured(),
      refreshIntervalMs: hereRefreshIntervalMs,
      usage,
      snapshots: {
        incidents: incidents ? { fetchedAt: incidents.fetchedAt, expiresAt: incidents.expiresAt, expired: incidents.expired } : null,
        flow: flow ? { fetchedAt: flow.fetchedAt, expiresAt: flow.expiresAt, expired: flow.expired } : null,
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/traffic/here/latest") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const kind = normalizeString(url.searchParams.get("kind")) || "incidents";
    const depotCode = normalizeString(url.searchParams.get("depotCode")) || "";
    const day = parseYmd(url.searchParams.get("day")) || null;
    const refresh = normalizeString(url.searchParams.get("refresh")) === "true";
    if (!hereConfigured()) return badRequest(res, "here_not_configured");
    let snap = await getHereSnapshot({ kind, depotCode });
    if ((!snap || snap.expired) && refresh) {
      await refreshHereTrafficSnapshots({ day });
      snap = await getHereSnapshot({ kind, depotCode });
    }
    if (!snap) return notFound(res);
    return json(res, 200, { item: snap });
  }

  if (method === "POST" && url.pathname === "/api/traffic/here/refresh") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteManage, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    const day = body && typeof body === "object" ? parseYmd(body.day) : null;
    const r = await refreshHereTrafficSnapshots({ day });
    if (!r.ok) return badRequest(res, r.error);
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "HERE_TRAFFIC_REFRESHED",
      username: auth.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: null,
      blockReason: null,
      overrideId: r.day,
      overrideReason: null,
      meta: { depots: r.depots || [] },
    });
    return json(res, 200, r);
  }

  if (method === "POST" && url.pathname === "/api/traffic/here/reroute-suggest") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const routeId = normalizeString(body.routeId) || null;
    const vehicleId = normalizeString(body.vehicleId) || null;
    let origin = body.origin || null;
    let destination = body.destination || null;

    if ((!origin || origin.lat === undefined) && vehicleId) {
      const pos = await getCouplinkPositions();
      if (pos.ok) {
        const it = pos.items.find((x) => x.vehicleId === vehicleId);
        if (it && it.position && Number.isFinite(it.position.lat) && Number.isFinite(it.position.lon)) origin = it.position;
      }
    }

    if ((!destination || destination.lat === undefined) && routeId && pool) {
      const stop = await pool
        .query(
          `
          select lat, lon, address
          from waste_route_stop
          where route_id = $1 and lat is not null and lon is not null
          order by stop_index asc
          limit 1;
          `,
          [routeId],
        )
        .then((r) => r.rows[0] || null)
        .catch(() => null);
      if (stop) destination = { lat: Number(stop.lat), lon: Number(stop.lon), address: stop.address || null };
    }

    const departureTime = normalizeString(body.departureTime) || null;
    const alternatives = body.alternatives !== undefined ? Number(body.alternatives) : 2;
    const via = Array.isArray(body.via) ? body.via : [];
    const r = await hereRoutingRoutes({ origin, destination, via, departureTime, alternatives, transportMode: "car", returnFields: "summary,polyline" });
    if (!r.ok) return badRequest(res, r.error);
    const routes = Array.isArray(r.data?.routes) ? r.data.routes : [];
    const routeSummaries = routes.map((rt, idx) => {
      const sections = Array.isArray(rt.sections) ? rt.sections : [];
      const duration = sections.reduce((sum, s) => sum + Number(s?.summary?.duration || 0), 0);
      const length = sections.reduce((sum, s) => sum + Number(s?.summary?.length || 0), 0);
      return { index: idx, durationSeconds: duration, lengthMeters: length };
    });
    const best = routeSummaries.length ? routeSummaries.reduce((a, b) => (b.durationSeconds < a.durationSeconds ? b : a)) : null;
    const base = routeSummaries.find((x) => x.index === 0) || null;
    const deltaSeconds = best && base ? best.durationSeconds - base.durationSeconds : null;
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "HERE_REROUTE_SUGGESTED",
      username: auth.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: vehicleId,
      blockReason: null,
      overrideId: routeId || null,
      overrideReason: null,
      meta: { alternatives: routeSummaries.length, bestIndex: best ? best.index : null, deltaSeconds },
    });
    return json(res, 200, { ok: true, usage: r.usage, routeSummaries, best, deltaSeconds, raw: r.data });
  }

  if (url.pathname.startsWith("/api/catalog/") && method !== "GET") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/catalog/containers") {
    if (!requirePermission(res, auth, Permissions.ViewAudit)) return;
    const activeOnly = normalizeString(url.searchParams.get("activeOnly")) === "true";
    const all = await getErpCatalogContainers();
    const items = activeOnly ? all.filter((x) => x.active) : all;
    return json(res, 200, { items });
  }

  if (method === "GET" && url.pathname === "/api/catalog/service-areas") {
    if (!requirePermission(res, auth, Permissions.ViewAudit)) return;
    const service = normalizeString(url.searchParams.get("service")) || "der_sack";
    const activeOnly = normalizeString(url.searchParams.get("activeOnly")) === "true";
    const all = await getErpServiceAreaZips(service);
    const items = activeOnly ? all.filter((x) => x.active) : all;
    return json(res, 200, { items });
  }

  if (url.pathname.startsWith("/api/waste/") && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/waste/routes") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const day = parseYmd(url.searchParams.get("day")) || null;
    const depotCode = normalizeString(url.searchParams.get("depotCode")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(200, limitRaw ? Number(limitRaw) : 50));
    const rows = await pool
      .query(
        `
        select
          r.id, r.day, r.depot_code, r.municipality_id, r.disposal_site_id, r.status, r.vehicle_id, r.driver_id,
          r.planned_start_at, r.planned_end_at, r.capacity_max_kg, r.capacity_max_cbm, r.meta, r.created_by, r.created_at, r.updated_at,
          (select count(*)::int from waste_route_stop s where s.route_id = r.id) as stop_count
        from waste_route r
        where ($1::date is null or r.day = $1::date)
          and ($2::text is null or r.depot_code = $2)
        order by r.day desc, r.updated_at desc
        limit $3;
        `,
        [day, depotCode, limit],
      )
      .then((r) => r.rows);
    const items = rows.map((r) => ({
      id: r.id,
      day: String(r.day).slice(0, 10),
      depotCode: r.depot_code || null,
      municipalityId: r.municipality_id || null,
      disposalSiteId: r.disposal_site_id || null,
      status: r.status,
      vehicleId: r.vehicle_id || null,
      driverId: r.driver_id || null,
      plannedStartAt: r.planned_start_at ? new Date(r.planned_start_at).toISOString() : null,
      plannedEndAt: r.planned_end_at ? new Date(r.planned_end_at).toISOString() : null,
      capacityMaxKg: r.capacity_max_kg === null ? null : Number(r.capacity_max_kg),
      capacityMaxCbm: r.capacity_max_cbm === null ? null : Number(r.capacity_max_cbm),
      stopCount: Number(r.stop_count),
      meta: r.meta || {},
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
    return json(res, 200, { items });
  }

  if (method === "GET" && url.pathname === "/api/waste/route") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const id = normalizeString(url.searchParams.get("id"));
    if (!id) return badRequest(res, "id_required");
    const r = await pool
      .query(
        `
        select
          id, day, depot_code, municipality_id, disposal_site_id, status, vehicle_id, driver_id,
          planned_start_at, planned_end_at, capacity_max_kg, capacity_max_cbm, meta, created_by, created_at, updated_at
        from waste_route
        where id = $1
        limit 1;
        `,
        [id],
      )
      .then((x) => x.rows[0] || null);
    if (!r) return notFound(res);
    const stops = await pool
      .query(
        `
        select
          id, stop_index, kind, order_id, lat, lon, address, window_start, window_end, planned_arrival_at, planned_departure_at, load_kg, unload_kg, meta, created_at
        from waste_route_stop
        where route_id = $1
        order by stop_index asc;
        `,
        [id],
      )
      .then((x) => x.rows);
    return json(res, 200, {
      route: {
        id: r.id,
        day: String(r.day).slice(0, 10),
        depotCode: r.depot_code || null,
        municipalityId: r.municipality_id || null,
        disposalSiteId: r.disposal_site_id || null,
        status: r.status,
        vehicleId: r.vehicle_id || null,
        driverId: r.driver_id || null,
        plannedStartAt: r.planned_start_at ? new Date(r.planned_start_at).toISOString() : null,
        plannedEndAt: r.planned_end_at ? new Date(r.planned_end_at).toISOString() : null,
        capacityMaxKg: r.capacity_max_kg === null ? null : Number(r.capacity_max_kg),
        capacityMaxCbm: r.capacity_max_cbm === null ? null : Number(r.capacity_max_cbm),
        meta: r.meta || {},
        createdBy: r.created_by,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      },
      stops: stops.map((s) => ({
        id: s.id,
        stopIndex: Number(s.stop_index),
        kind: s.kind,
        orderId: s.order_id || null,
        lat: s.lat === null ? null : Number(s.lat),
        lon: s.lon === null ? null : Number(s.lon),
        address: s.address || null,
        windowStart: s.window_start ? new Date(s.window_start).toISOString() : null,
        windowEnd: s.window_end ? new Date(s.window_end).toISOString() : null,
        plannedArrivalAt: s.planned_arrival_at ? new Date(s.planned_arrival_at).toISOString() : null,
        plannedDepartureAt: s.planned_departure_at ? new Date(s.planned_departure_at).toISOString() : null,
        loadKg: s.load_kg === null ? null : Number(s.load_kg),
        unloadKg: s.unload_kg === null ? null : Number(s.unload_kg),
        meta: s.meta || {},
        createdAt: new Date(s.created_at).toISOString(),
      })),
    });
  }

  if (method === "POST" && url.pathname === "/api/waste/routes/plan") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const day = parseYmd(body.day);
    if (!day) return badRequest(res, "day_required");
    const depotCode = normalizeString(body.depotCode) || null;
    const vehicleId = normalizeString(body.vehicleId);
    if (!vehicleId) return badRequest(res, "vehicleId_required");
    const driverId = normalizeString(body.driverId) || null;
    const disposalSiteId = normalizeString(body.disposalSiteId) || null;
    const slotMinutesRaw = body.slotMinutes === null || body.slotMinutes === undefined || body.slotMinutes === "" ? 45 : Number(body.slotMinutes);
    const slotMinutes = Number.isFinite(slotMinutesRaw) ? Math.max(10, Math.min(240, Math.round(slotMinutesRaw))) : 45;
    const routeStartAt = body.routeStartAt ? parseIsoDate(body.routeStartAt) : null;
    const routeStart = routeStartAt || new Date(`${day}T07:00:00Z`);
    if (Number.isNaN(routeStart.valueOf())) return badRequest(res, "invalid_routeStartAt");

    const vehicle = await getVehicleById(vehicleId);
    if (!vehicle) return badRequest(res, "vehicle_not_found");
    if (!Array.isArray(vehicle.capabilities) || !vehicle.capabilities.includes("waste")) return badRequest(res, "vehicle_missing_waste_capability");

    let depot = null;
    if (depotCode) {
      const d = await pool
        .query(`select code, lat, lon from fleet_depot where code = $1 limit 1;`, [depotCode])
        .then((r) => r.rows[0] || null);
      depot = d && d.lat !== null && d.lon !== null ? { code: d.code, lat: Number(d.lat), lon: Number(d.lon) } : { code: depotCode, lat: null, lon: null };
    }

    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.map((x) => normalizeString(x)).filter(Boolean) : null;
    const candidateIds = orderIds
      ? orderIds
      : await pool
          .query(
            `
            select id
            from waste_container_order
            where status in ('validated','dispatch_checked')
              and window_deliver_start::date = $1::date
              and ($2::text is null or site->>'depot' = $2)
            order by
              case priority_urgency when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
              created_at asc
            limit 200;
            `,
            [day, depotCode],
          )
          .then((r) => r.rows.map((x) => x.id));

    const routeId = `rt_${crypto.randomUUID().slice(0, 12)}`;
    await pool.query(
      `
      insert into waste_route
        (id, day, depot_code, municipality_id, disposal_site_id, status, vehicle_id, driver_id, planned_start_at, planned_end_at, capacity_max_kg, capacity_max_cbm, meta, created_by, created_at, updated_at)
      values
        ($1, $2::date, $3, null, $4, 'planned', $5, $6, $7, null, $8, $9, $10::jsonb, $11, now(), now());
      `,
      [
        routeId,
        day,
        depotCode,
        disposalSiteId,
        vehicleId,
        driverId,
        routeStart.toISOString(),
        vehicle.payloadMaxKg === null ? null : Math.round(vehicle.payloadMaxKg),
        vehicle.volumeMaxCbm === null ? null : Number(vehicle.volumeMaxCbm),
        JSON.stringify({ slotMinutes }),
        auth.username,
      ],
    );

    const candidates = [];
    const skipped = [];
    for (const oid of candidateIds) {
      const exists = await pool
        .query(`select id from fleet_dispatch_assignment where module = 'waste' and order_id = $1 limit 1;`, [oid])
        .then((r) => r.rows[0] || null);
      if (exists) {
        skipped.push({ orderId: oid, reason: "already_assigned" });
        continue;
      }
      const order = await getWasteOrderById(oid);
      if (!order) {
        skipped.push({ orderId: oid, reason: "order_not_found" });
        continue;
      }
      const lat = typeof order.site?.lat === "number" ? order.site.lat : order.site?.lat === null || order.site?.lat === undefined ? null : Number(order.site.lat);
      const lon = typeof order.site?.lon === "number" ? order.site.lon : order.site?.lon === null || order.site?.lon === undefined ? null : Number(order.site.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        skipped.push({ orderId: oid, reason: "missing_site_coordinates" });
        continue;
      }
      const container = await getCatalogContainerBySourceKey(order.containerSourceKey);
      if (!container || !container.active) {
        skipped.push({ orderId: oid, reason: "container_not_found_or_inactive" });
        continue;
      }
      const ctx = buildWasteDispatchContext({ order, container, body: { siteDepot: depotCode, driverId } });
      candidates.push({ order, lat, lon, priorityScore: ctx.priorityScore, address: normalizeString(order.site?.address) || null });
    }

    const remaining = [...candidates].sort((a, b) => b.priorityScore - a.priorityScore);
    const seq = [];
    let curLat = depot && depot.lat !== null ? depot.lat : remaining[0]?.lat ?? null;
    let curLon = depot && depot.lon !== null ? depot.lon : remaining[0]?.lon ?? null;
    while (remaining.length) {
      let bestIdx = 0;
      let bestScore = null;
      for (let i = 0; i < remaining.length; i++) {
        const it = remaining[i];
        const dist = curLat !== null && curLon !== null ? haversineKm(curLat, curLon, it.lat, it.lon) : 0;
        const score = dist * 1.0 - it.priorityScore * 0.05;
        if (bestScore === null || score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      const picked = remaining.splice(bestIdx, 1)[0];
      seq.push(picked);
      curLat = picked.lat;
      curLon = picked.lon;
    }

    const assigned = [];
    let i = 0;
    for (const it of seq) {
      const start = new Date(routeStart.getTime() + i * slotMinutes * 60000);
      const end = new Date(start.getTime() + slotMinutes * 60000);
      if (it.order.status === "validated") {
        const container = await getCatalogContainerBySourceKey(it.order.containerSourceKey);
        const moduleKey = "waste";
        const ctx = buildWasteDispatchContext({ order: it.order, container, body: { siteDepot: depotCode, driverId } });
        const evalRes = await wasteDispatchDecisionForOrder({ order: it.order, vehicleId, moduleKey, windowStart: start, windowEnd: end, context: ctx });
        if (!evalRes.ok) {
          skipped.push({ orderId: it.order.id, reason: evalRes.error });
          continue;
        }
        await createWasteDispatchCheck({ orderId: it.order.id, vehicleId, moduleKey, windowStart: start, windowEnd: end, decision: evalRes.decision, username: auth.username });
        const moved = await updateWasteOrderStatus({
          orderId: it.order.id,
          toStatus: "dispatch_checked",
          reason: "dispatch_checked",
          username: auth.username,
          meta: { vehicleId },
        });
        if (!moved.ok) {
          skipped.push({ orderId: it.order.id, reason: moved.error });
          continue;
        }
      }

      const r = await assignWasteOrder({
        orderId: it.order.id,
        vehicleId,
        driverId,
        reason: "route_planned",
        username: auth.username,
        routeId,
        assignmentWindowStart: start.toISOString(),
        assignmentWindowEnd: end.toISOString(),
      });
      if (!r.ok) {
        skipped.push({ orderId: it.order.id, reason: r.error, details: r.details || null });
        continue;
      }

      const stopId = `rst_${crypto.randomUUID().slice(0, 12)}`;
      await pool.query(
        `
        insert into waste_route_stop
          (id, route_id, stop_index, kind, order_id, lat, lon, address, window_start, window_end, planned_arrival_at, planned_departure_at, load_kg, unload_kg, meta, created_at)
        values
          ($1,$2,$3,'deliver',$4,$5,$6,$7,$8,$9,$10,$11,null,null,$12::jsonb, now());
        `,
        [
          stopId,
          routeId,
          i,
          it.order.id,
          it.lat,
          it.lon,
          it.address,
          start.toISOString(),
          end.toISOString(),
          start.toISOString(),
          end.toISOString(),
          JSON.stringify({ priorityScore: it.priorityScore }),
        ],
      );
      assigned.push({ orderId: it.order.id, assignmentId: r.assignmentId, windowStart: start.toISOString(), windowEnd: end.toISOString() });
      i++;
    }

    if (disposalSiteId) {
      const ds = await pool
        .query(`select id, lat, lon, address, name from waste_disposal_site where id = $1 or code = $1 limit 1;`, [disposalSiteId])
        .then((r) => r.rows[0] || null);
      if (ds && ds.lat !== null && ds.lon !== null) {
        const stopId = `rst_${crypto.randomUUID().slice(0, 12)}`;
        await pool.query(
          `
          insert into waste_route_stop
            (id, route_id, stop_index, kind, order_id, lat, lon, address, window_start, window_end, planned_arrival_at, planned_departure_at, load_kg, unload_kg, meta, created_at)
          values
            ($1,$2,$3,'disposal',null,$4,$5,$6,null,null,null,null,null,null,$7::jsonb, now());
          `,
          [stopId, routeId, i, Number(ds.lat), Number(ds.lon), normalizeString(ds.address) || normalizeString(ds.name) || null, JSON.stringify({ disposalSiteId: ds.id })],
        );
      }
    }

    await pool.query(`update waste_route set planned_end_at = $2, updated_at = now() where id = $1;`, [routeId, new Date(routeStart.getTime() + i * slotMinutes * 60000).toISOString()]);

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "WASTE_ROUTE_PLANNED",
      username: auth.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId,
      blockReason: null,
      overrideId: routeId,
      overrideReason: null,
      meta: { day, depotCode, vehicleId, assignedCount: assigned.length, skippedCount: skipped.length },
    });
    await publishErpEvent({
      eventType: "WASTE_ROUTE_PLANNED",
      aggregateType: "waste_route",
      aggregateId: routeId,
      occurredAt: new Date().toISOString(),
      createdBy: auth.username,
      payload: { day, depotCode, vehicleId, driverId: driverId || null, assignedCount: assigned.length, skippedCount: skipped.length },
    });

    return json(res, 201, { routeId, assigned, skipped });
  }

  if (method === "POST" && url.pathname === "/api/waste/routes/reoptimize") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const routeId = normalizeString(body.routeId);
    if (!routeId) return badRequest(res, "routeId_required");
    const r = await pool.query(`select id, status, vehicle_id, driver_id, planned_end_at, depot_code, day from waste_route where id = $1 limit 1;`, [routeId]).then((x) => x.rows[0] || null);
    if (!r) return notFound(res);
    if (r.status !== "planned") return badRequest(res, "route_not_planned");
    const vehicleId = r.vehicle_id;
    if (!vehicleId) return badRequest(res, "route_missing_vehicle");
    const vehicle = await getVehicleById(vehicleId);
    if (!vehicle) return badRequest(res, "vehicle_not_found");
    const driverId = r.driver_id || null;
    const slotMinutesRaw = body.slotMinutes === null || body.slotMinutes === undefined || body.slotMinutes === "" ? 45 : Number(body.slotMinutes);
    const slotMinutes = Number.isFinite(slotMinutesRaw) ? Math.max(10, Math.min(240, Math.round(slotMinutesRaw))) : 45;
    const startFrom = r.planned_end_at ? new Date(r.planned_end_at) : new Date(`${String(r.day).slice(0, 10)}T07:00:00Z`);
    if (Number.isNaN(startFrom.valueOf())) return badRequest(res, "route_start_invalid");

    const newOrderIds = Array.isArray(body.orderIds) ? body.orderIds.map((x) => normalizeString(x)).filter(Boolean) : [];
    if (!newOrderIds.length) return badRequest(res, "orderIds_required");

    let lastIdx = await pool.query(`select coalesce(max(stop_index), -1)::int as n from waste_route_stop where route_id = $1;`, [routeId]).then((x) => x.rows[0]?.n ?? -1);
    const assigned = [];
    const skipped = [];
    for (const oid of newOrderIds) {
      const already = await pool.query(`select id from waste_route_stop where order_id = $1 limit 1;`, [oid]).then((x) => x.rows[0] || null);
      if (already) {
        skipped.push({ orderId: oid, reason: "already_routed" });
        continue;
      }
      const order = await getWasteOrderById(oid);
      if (!order) {
        skipped.push({ orderId: oid, reason: "order_not_found" });
        continue;
      }
      if (order.status !== "dispatch_checked") {
        skipped.push({ orderId: oid, reason: "order_not_dispatch_checked" });
        continue;
      }
      const lat = typeof order.site?.lat === "number" ? order.site.lat : order.site?.lat === null || order.site?.lat === undefined ? null : Number(order.site.lat);
      const lon = typeof order.site?.lon === "number" ? order.site.lon : order.site?.lon === null || order.site?.lon === undefined ? null : Number(order.site.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        skipped.push({ orderId: oid, reason: "missing_site_coordinates" });
        continue;
      }
      const start = new Date(startFrom.getTime() + (lastIdx + 1) * slotMinutes * 60000);
      const end = new Date(start.getTime() + slotMinutes * 60000);
      const r2 = await assignWasteOrder({
        orderId: oid,
        vehicleId,
        driverId,
        reason: "route_reoptimized",
        username: auth.username,
        routeId,
        assignmentWindowStart: start.toISOString(),
        assignmentWindowEnd: end.toISOString(),
      });
      if (!r2.ok) {
        skipped.push({ orderId: oid, reason: r2.error, details: r2.details || null });
        continue;
      }
      lastIdx++;
      const stopId = `rst_${crypto.randomUUID().slice(0, 12)}`;
      await pool.query(
        `
        insert into waste_route_stop
          (id, route_id, stop_index, kind, order_id, lat, lon, address, window_start, window_end, planned_arrival_at, planned_departure_at, load_kg, unload_kg, meta, created_at)
        values
          ($1,$2,$3,'deliver',$4,$5,$6,$7,$8,$9,$10,$11,null,null,$12::jsonb, now());
        `,
        [stopId, routeId, lastIdx, oid, lat, lon, normalizeString(order.site?.address) || null, start.toISOString(), end.toISOString(), start.toISOString(), end.toISOString(), JSON.stringify({})],
      );
      assigned.push({ orderId: oid, assignmentId: r2.assignmentId, windowStart: start.toISOString(), windowEnd: end.toISOString() });
    }

    await pool.query(`update waste_route set planned_end_at = $2, updated_at = now() where id = $1;`, [routeId, new Date(startFrom.getTime() + (lastIdx + 1) * slotMinutes * 60000).toISOString()]);
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "WASTE_ROUTE_REOPTIMIZED",
      username: auth.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId,
      blockReason: null,
      overrideId: routeId,
      overrideReason: null,
      meta: { assignedCount: assigned.length, skippedCount: skipped.length },
    });
    await publishErpEvent({
      eventType: "WASTE_ROUTE_REOPTIMIZED",
      aggregateType: "waste_route",
      aggregateId: routeId,
      occurredAt: new Date().toISOString(),
      createdBy: auth.username,
      payload: { assignedCount: assigned.length, skippedCount: skipped.length },
    });
    return json(res, 200, { routeId, assigned, skipped });
  }

  if (method === "POST" && url.pathname === "/api/waste/orders") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const r = await createWasteOrder({ body, username: auth.username });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 201, { order: r.order });
  }

  if (method === "GET" && url.pathname === "/api/waste/orders") {
    if (!requirePermission(res, auth, Permissions.ViewAudit)) return;
    const id = normalizeString(url.searchParams.get("id"));
    if (id) {
      const order = await getWasteOrderById(id);
      if (!order) return notFound(res);
      return json(res, 200, { order });
    }
    const status = normalizeString(url.searchParams.get("status"));
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listWasteOrders({ status, limit: limitRaw ? Number(limitRaw) : 50 });
    return json(res, 200, { items });
  }

  if (method === "POST" && url.pathname === "/api/waste/orders/status") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const id = normalizeString(body.id);
    const toStatus = normalizeString(body.toStatus);
    const reason = normalizeString(body.reason);
    const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
    if (!id) return badRequest(res, "id_required");
    if (!toStatus) return badRequest(res, "toStatus_required");
    if (!reason) return badRequest(res, "reason_required");
    const r = await updateWasteOrderStatus({ orderId: id, toStatus, reason, username: auth.username, meta });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { order: r.order });
  }

  if (method === "POST" && url.pathname === "/api/waste/orders/dispatch/check") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const id = normalizeString(body.id);
    const vehicleId = normalizeString(body.vehicleId);
    if (!id) return badRequest(res, "id_required");
    if (!vehicleId) return badRequest(res, "vehicleId_required");
    const order = await getWasteOrderById(id);
    if (!order) return notFound(res);
    if (!["validated", "dispatch_checked"].includes(order.status)) return badRequest(res, "order_not_validated");

    const container = await getCatalogContainerBySourceKey(order.containerSourceKey);
    if (!container || !container.active) return badRequest(res, "container_not_found_or_inactive");

    const moduleKey = "waste";
    const windowStart = new Date(order.windowDeliverStart);
    const windowEnd = new Date(order.windowDeliverEnd);
    const context = buildWasteDispatchContext({ order, container, body });
    const evalRes = await wasteDispatchDecisionForOrder({ order, vehicleId, moduleKey, windowStart, windowEnd, context });
    if (!evalRes.ok) return badRequest(res, evalRes.error);

    await createWasteDispatchCheck({ orderId: id, vehicleId, moduleKey, windowStart, windowEnd, decision: evalRes.decision, username: auth.username });
    if (order.status === "validated") {
      const moved = await updateWasteOrderStatus({ orderId: id, toStatus: "dispatch_checked", reason: "dispatch_checked", username: auth.username, meta: { vehicleId } });
      if (!moved.ok) return badRequest(res, moved.error);
    }
    return json(res, 200, { decision: evalRes.decision });
  }

  if (method === "POST" && url.pathname === "/api/waste/orders/dispatch/assign") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const id = normalizeString(body.id);
    const vehicleId = normalizeString(body.vehicleId);
    const driverId = normalizeString(body.driverId) || null;
    const reason = normalizeString(body.reason) || "assigned";
    const routeId = normalizeString(body.routeId) || null;
    const assignmentWindowStart = normalizeString(body.assignmentWindowStart) || null;
    const assignmentWindowEnd = normalizeString(body.assignmentWindowEnd) || null;
    if (!id) return badRequest(res, "id_required");
    if (!vehicleId) return badRequest(res, "vehicleId_required");
    const r = await assignWasteOrder({ orderId: id, vehicleId, driverId, reason, username: auth.username, routeId, assignmentWindowStart, assignmentWindowEnd });
    if (!r.ok) {
      if (r.error === "dispatch_denied") return json(res, 409, { error: r.error, details: r.details });
      return badRequest(res, r.error);
    }
    return json(res, 201, { order: r.order, assignmentId: r.assignmentId });
  }

  if (method === "POST" && url.pathname === "/api/waste/orders/weigh/mock") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const id = normalizeString(body.id);
    if (!id) return badRequest(res, "id_required");
    const r = await createMockWeighTicket({ orderId: id, grossKg: body.grossKg, tareKg: body.tareKg, weighedAt: body.weighedAt, username: auth.username });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 201, { order: r.order, weighTicket: { id: r.weighTicketId, grossKg: r.grossKg, tareKg: r.tareKg, netKg: r.netKg, weighedAt: r.weighedAt } });
  }

  if (method === "POST" && url.pathname === "/api/waste/orders/invoice/mock") {
    if (!requirePermission(res, auth, Permissions.FleetAdmin)) return;
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const id = normalizeString(body.id);
    if (!id) return badRequest(res, "id_required");
    const order = await getWasteOrderById(id);
    if (!order) return badRequest(res, "order_not_found");
    if (order.status !== "weighed") return badRequest(res, "order_not_weighed");
    const cur = normalizeString(body.currency) || "EUR";
    if (!/^[A-Z]{3}$/.test(cur)) return badRequest(res, "invalid_currency");
    const r = await createApprovalRequest({
      requestType: "BILLING_APPROVAL",
      requestSubtype: "invoice_mock",
      requestedBy: auth.username,
      reason: normalizeString(body.reason) || null,
      payload: { orderId: id, currency: cur, lines: body.lines },
      meta: { source: "api", endpoint: "/api/waste/orders/invoice/mock" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (method === "POST" && url.pathname === "/api/billing/waste/invoice-drafts") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingManage, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const orderId = normalizeString(body.orderId);
    const pricingCalculationId = normalizeString(body.pricingCalculationId) || null;
    if (!orderId) return badRequest(res, "orderId_required");
    const order = await getWasteOrderById(orderId);
    if (!order) return badRequest(res, "order_not_found");
    if (order.status !== "weighed") return badRequest(res, "order_not_weighed");
    if (pricingCalculationId) {
      const calc = await getPricingCalculationById(pricingCalculationId);
      if (!calc) return badRequest(res, "pricing_calculation_not_found");
      if (calc.orderId !== order.id) return badRequest(res, "pricing_calculation_order_mismatch");
    } else {
      const latest = await getLatestPricingCalculationForOrder(order.id);
      if (!latest) return badRequest(res, "pricing_calculation_not_found");
    }
    const r = await createApprovalRequest({
      requestType: "BILLING_APPROVAL",
      requestSubtype: "invoice_from_pricing",
      requestedBy: auth.username,
      reason: normalizeString(body.reason) || null,
      payload: { orderId, pricingCalculationId },
      meta: { source: "api", endpoint: "/api/billing/waste/invoice-drafts" },
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 202, { approval: r.item });
  }

  if (method === "GET" && url.pathname === "/api/billing/waste/invoice-drafts") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingView, Permissions.PricingManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const orderId = normalizeString(url.searchParams.get("orderId")) || null;
    const customerId = normalizeString(url.searchParams.get("customerId")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const id = normalizeString(url.searchParams.get("id")) || null;
    if (id) {
      const item = await getWasteInvoiceDraftById(id);
      if (!item) return notFound(res);
      return json(res, 200, { item });
    }
    const items = await listWasteInvoiceDrafts({ orderId, customerId, limit: limitRaw ? Number(limitRaw) : 20 });
    return json(res, 200, { items });
  }

  if (url.pathname.startsWith("/api/workshop/") && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/workshop/cases") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const vehicleId = normalizeString(url.searchParams.get("vehicleId")) || null;
    const status = normalizeString(url.searchParams.get("status")) || null;
    const assignedTo = normalizeString(url.searchParams.get("assignedTo")) || null;
    const workState = normalizeString(url.searchParams.get("workState")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listWorkshopCases({ vehicleId, status, assignedTo, workState, limit: limitRaw ? Number(limitRaw) : 50 });
    return json(res, 200, { items });
  }

  if (method === "POST" && url.pathname === "/api/workshop/cases") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopCreate, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const vehicleId = normalizeString(body.vehicleId);
    const title = normalizeString(body.title);
    const description = normalizeString(body.description);
    const severity = normalizeString(body.severity) || "warning";
    const lockType = normalizeString(body.lockType) || null;
    const priority = normalizeString(body.priority) || null;
    const reporterRole = normalizeString(body.reporterRole) || null;
    const photo = body.photo && typeof body.photo === "object" ? body.photo : null;
    const openedAt = normalizeString(body.openedAt) || null;
    if (!vehicleId) return badRequest(res, "vehicleId_required");
    if (!title) return badRequest(res, "title_required");
    const r = await createWorkshopCase({ vehicleId, title, description, severity, lockType, priority, reporterRole, photo, openedAt, username: auth.username });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 201, { item: r.item });
  }

  if (method === "POST" && url.pathname === "/api/workshop/orders") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopCreate, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const vehicleId = normalizeString(body.vehicleId);
    const title = normalizeString(body.title);
    const description = normalizeString(body.description);
    const severity = normalizeString(body.severity) || "warning";
    const lockType = normalizeString(body.lockType) || null;
    const priority = normalizeString(body.priority) || null;
    const reporterRole = normalizeString(body.reporterRole) || null;
    const photo = body.photo && typeof body.photo === "object" ? body.photo : null;
    const openedAt = normalizeString(body.openedAt) || null;
    if (!vehicleId) return badRequest(res, "vehicleId_required");
    if (!title) return badRequest(res, "title_required");
    const r = await createWorkshopCase({ vehicleId, title, description, severity, lockType, priority, reporterRole, photo, openedAt, username: auth.username });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 201, { item: r.item });
  }

  if (method === "GET" && url.pathname === "/api/workshop/orders/pool") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const priority = normalizeString(url.searchParams.get("priority")) || null;
    const assigned = normalizeString(url.searchParams.get("assigned")) || null;
    const assignedTo = normalizeString(url.searchParams.get("assignedTo")) || null;
    const workState = normalizeString(url.searchParams.get("workState")) || null;
    const items = await listWorkshopPool({ limit: limitRaw ? Number(limitRaw) : 100, priority, assigned, assignedTo, workState });
    return json(res, 200, { items });
  }

  if (method === "POST" && url.pathname === "/api/workshop/orders/assign") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAssign, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const caseId = normalizeString(body.caseId);
    const assignedTo = normalizeString(body.assignedTo) || null;
    if (!caseId) return badRequest(res, "caseId_required");
    const r = await assignWorkshopCase({ caseId, assignedTo, username: auth.username });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { item: r.item });
  }

  if (method === "POST" && url.pathname === "/api/workshop/orders/status") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopWork, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const caseId = normalizeString(body.caseId);
    const workState = normalizeString(body.workState);
    const reason = normalizeString(body.reason) || "status_changed";
    if (!caseId) return badRequest(res, "caseId_required");
    const r = await setWorkshopCaseState({
      caseId,
      workState,
      interrupted: body.interrupted === true,
      deliveryDelay: body.deliveryDelay === true,
      reason,
      username: auth.username,
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { item: r.item });
  }

  if (method === "GET" && url.pathname === "/api/workshop/dashboard") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    const limitRaw = normalizeString(url.searchParams.get("poolLimit"));
    const priority = normalizeString(url.searchParams.get("priority")) || null;
    const assigned = normalizeString(url.searchParams.get("assigned")) || null;
    const assignedTo = normalizeString(url.searchParams.get("assignedTo")) || null;
    const workState = normalizeString(url.searchParams.get("workState")) || null;
    const items = await listWorkshopPool({ limit: limitRaw ? Number(limitRaw) : 100, priority, assigned, assignedTo, workState });
    const counts = { open: 0, assigned: 0, in_progress: 0, critical_blocked: 0 };
    for (const it of items) counts[it.poolStatus] = (counts[it.poolStatus] || 0) + 1;
    return json(res, 200, { pool: { counts, items } });
  }

  if (method === "GET" && url.pathname === "/api/workshop/assignees") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const rows = await pool
      .query(
        `
        select
          assigned_to as assignee,
          sum(case when status = 'open' then 1 else 0 end)::int as open_count,
          sum(case when status = 'open' and work_state = 'assigned' then 1 else 0 end)::int as assigned_count,
          sum(case when status = 'open' and work_state = 'in_progress' then 1 else 0 end)::int as in_progress_count,
          sum(case when status = 'open' and work_state = 'waiting_parts' then 1 else 0 end)::int as waiting_parts_count,
          sum(case when status = 'closed' then 1 else 0 end)::int as closed_count,
          max(coalesce(assigned_at, opened_at)) as last_assigned_at
        from workshop_case
        where assigned_to is not null
        group by assigned_to
        order by open_count desc, last_assigned_at desc nulls last, assignee asc
        limit 200;
        `,
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        assignee: r.assignee,
        open: Number(r.open_count) || 0,
        assigned: Number(r.assigned_count) || 0,
        inProgress: Number(r.in_progress_count) || 0,
        waitingParts: Number(r.waiting_parts_count) || 0,
        closed: Number(r.closed_count) || 0,
        lastAssignedAt: r.last_assigned_at ? new Date(r.last_assigned_at).toISOString() : null,
      })),
    });
  }

  if (method === "GET" && url.pathname === "/api/workshop/assignees/history") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const assignee = normalizeString(url.searchParams.get("assignee"));
    if (!assignee) return badRequest(res, "assignee_required");
    const fromRaw = normalizeString(url.searchParams.get("from")) || null;
    const toRaw = normalizeString(url.searchParams.get("to")) || null;
    const from = fromRaw ? parseIsoDate(fromRaw) : null;
    const to = toRaw ? parseIsoDate(toRaw) : null;
    if (fromRaw && !from) return badRequest(res, "invalid_from");
    if (toRaw && !to) return badRequest(res, "invalid_to");
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(500, limitRaw ? Number(limitRaw) : 200));

    const openCases = await listWorkshopCases({ status: "open", assignedTo: assignee, limit: Math.min(200, limit) });

    const params = [assignee];
    const where = [`c.assigned_to = $1`];
    if (from) {
      params.push(from.toISOString());
      where.push(`e.occurred_at >= $${params.length}`);
    }
    if (to) {
      params.push(to.toISOString());
      where.push(`e.occurred_at <= $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const events = await pool
      .query(
        `
        select
          e.id, e.case_id, e.from_status, e.to_status, e.reason, e.username, e.occurred_at, e.meta,
          c.vehicle_id, c.title, c.status as case_status, c.work_state, c.priority
        from workshop_case_event e
        join workshop_case c on c.id = e.case_id
        ${whereSql}
        order by e.occurred_at desc
        limit ${limit};
        `,
        params,
      )
      .then((r) => r.rows);

    return json(res, 200, {
      assignee,
      window: { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null },
      openCases,
      events: events.map((e) => ({
        id: e.id,
        caseId: e.case_id,
        vehicleId: e.vehicle_id,
        title: e.title,
        caseStatus: e.case_status,
        workState: e.work_state,
        priority: e.priority,
        fromStatus: e.from_status || null,
        toStatus: e.to_status,
        reason: e.reason,
        username: e.username,
        occurredAt: new Date(e.occurred_at).toISOString(),
        meta: e.meta || {},
      })),
    });
  }

  if (method === "GET" && url.pathname === "/api/workshop/planning/slots") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    const startDay = normalizeString(url.searchParams.get("startDay"));
    const endDay = normalizeString(url.searchParams.get("endDay"));
    const assignee = normalizeString(url.searchParams.get("assignee"));
    if (!startDay) return badRequest(res, "startDay_required");
    if (!endDay) return badRequest(res, "endDay_required");
    if (!assignee) return badRequest(res, "assignee_required");
    const start = new Date(`${startDay}T00:00:00Z`);
    const end = new Date(`${endDay}T00:00:00Z`);
    if (Number.isNaN(start.valueOf())) return badRequest(res, "invalid_startDay");
    if (Number.isNaN(end.valueOf())) return badRequest(res, "invalid_endDay");
    const rows = await pool
      .query(
        `
        select id, day, slot_index, assignee, case_id, notes, updated_by, updated_at
        from workshop_slot_plan
        where assignee = $1 and day >= $2::date and day <= $3::date
        order by day asc, slot_index asc;
        `,
        [assignee, startDay, endDay],
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        day: String(r.day).slice(0, 10),
        slotIndex: Number(r.slot_index),
        assignee: r.assignee,
        caseId: r.case_id || null,
        notes: r.notes || null,
        updatedBy: r.updated_by,
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    });
  }

  if (method === "POST" && url.pathname === "/api/workshop/planning/slots/set") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAssign, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const day = normalizeString(body.day);
    const slotIndexRaw = body.slotIndex;
    const assignee = normalizeString(body.assignee);
    const caseId = normalizeString(body.caseId) || null;
    const notes = normalizeString(body.notes) || null;
    if (!day) return badRequest(res, "day_required");
    const dayDt = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(dayDt.valueOf())) return badRequest(res, "invalid_day");
    const slotIndex = Number(slotIndexRaw);
    if (!Number.isFinite(slotIndex) || slotIndex < 1 || slotIndex > 50) return badRequest(res, "invalid_slotIndex");
    if (!assignee) return badRequest(res, "assignee_required");
    if (caseId && !(await getWorkshopCaseById(caseId))) return badRequest(res, "case_not_found");
    const id = `wsp_${crypto.randomUUID().slice(0, 12)}`;
    const updatedAt = new Date().toISOString();
    const row = await pool
      .query(
        `
        insert into workshop_slot_plan
          (id, day, slot_index, assignee, case_id, notes, updated_by, updated_at)
        values
          ($1, $2::date, $3, $4, $5, $6, $7, $8)
        on conflict (day, slot_index, assignee) do update
          set case_id = excluded.case_id,
              notes = excluded.notes,
              updated_by = excluded.updated_by,
              updated_at = excluded.updated_at
        returning id, day, slot_index, assignee, case_id, notes, updated_by, updated_at;
        `,
        [id, day, slotIndex, assignee, caseId, notes, auth.username, updatedAt],
      )
      .then((r) => r.rows[0] || null);
    publishEvent("planning", "workshop_slot_set", { id: row.id, day: String(row.day).slice(0, 10), slotIndex: Number(row.slot_index), assignee: row.assignee, caseId: row.case_id || null, updatedBy: row.updated_by, updatedAt: new Date(row.updated_at).toISOString() });
    return json(res, 200, {
      item: {
        id: row.id,
        day: String(row.day).slice(0, 10),
        slotIndex: Number(row.slot_index),
        assignee: row.assignee,
        caseId: row.case_id || null,
        notes: row.notes || null,
        updatedBy: row.updated_by,
        updatedAt: new Date(row.updated_at).toISOString(),
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/workshop/inventory/items") {
    if (!requireAnyPermission(res, auth, [Permissions.InventoryView, Permissions.InventoryAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    const q = normalizeString(url.searchParams.get("query")).toLowerCase();
    const activeOnly = normalizeString(url.searchParams.get("activeOnly")) === "true";
    const rows = await pool
      .query(
        `
        select i.id, i.part_no, i.description, i.supplier_id, i.qr_code, i.min_qty, i.active, i.meta, s.name as supplier_name, i.created_at
        from workshop_inventory_item i
        left join workshop_inventory_supplier s on s.id = i.supplier_id
        where ($1 = '' or lower(i.part_no) like $1 or lower(i.description) like $1 or lower(i.qr_code) like $1)
          and ($2::boolean = false or i.active = true)
        order by i.part_no asc
        limit 500;
        `,
        [q ? `%${q}%` : "", activeOnly],
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        partNo: r.part_no,
        description: r.description,
        supplierId: r.supplier_id || null,
        supplierName: r.supplier_name || null,
        qrCode: r.qr_code,
        minQty: Number(r.min_qty),
        active: Boolean(r.active),
        meta: r.meta || {},
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  }

  if (method === "POST" && url.pathname === "/api/workshop/inventory/suppliers") {
    if (!requireAnyPermission(res, auth, [Permissions.InventoryAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const name = normalizeString(body.name);
    const contact = body.contact && typeof body.contact === "object" ? body.contact : {};
    if (!name) return badRequest(res, "name_required");
    const id = `sup_${crypto.randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    const row = await pool
      .query(
        `
        insert into workshop_inventory_supplier (id, name, contact, active, created_at)
        values ($1, $2, $3, true, $4)
        on conflict (id) do nothing
        returning id, name, contact, active, created_at;
        `,
        [id, name, contact, createdAt],
      )
      .then((r) => r.rows[0] || null);
    return json(res, 201, { item: { id: row.id, name: row.name, contact: row.contact || {}, active: Boolean(row.active), createdAt: new Date(row.created_at).toISOString() } });
  }

  if (method === "POST" && url.pathname === "/api/workshop/inventory/locations") {
    if (!requireAnyPermission(res, auth, [Permissions.InventoryAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const code = normalizeString(body.code);
    const description = normalizeString(body.description) || null;
    if (!code) return badRequest(res, "code_required");
    const id = `loc_${crypto.randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    const row = await pool
      .query(
        `
        insert into workshop_inventory_location (id, code, description, created_at)
        values ($1, $2, $3, $4)
        on conflict (code) do update set description = excluded.description
        returning id, code, description, created_at;
        `,
        [id, code, description, createdAt],
      )
      .then((r) => r.rows[0] || null);
    return json(res, 201, { item: { id: row.id, code: row.code, description: row.description || null, createdAt: new Date(row.created_at).toISOString() } });
  }

  if (method === "POST" && url.pathname === "/api/workshop/inventory/items") {
    if (!requireAnyPermission(res, auth, [Permissions.InventoryAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const partNo = normalizeString(body.partNo);
    const description = normalizeString(body.description);
    const supplierId = normalizeString(body.supplierId) || null;
    const qrCode = normalizeString(body.qrCode);
    const minQtyRaw = body.minQty === undefined || body.minQty === null || body.minQty === "" ? 0 : Number(body.minQty);
    const active = body.active === false ? false : true;
    const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
    if (!partNo) return badRequest(res, "partNo_required");
    if (!description) return badRequest(res, "description_required");
    if (!qrCode) return badRequest(res, "qrCode_required");
    const minQty = Number.isFinite(minQtyRaw) ? Math.max(0, Math.round(minQtyRaw)) : 0;
    const id = `itm_${crypto.randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    const row = await pool
      .query(
        `
        insert into workshop_inventory_item (id, part_no, description, supplier_id, qr_code, min_qty, active, meta, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (part_no) do update
          set description = excluded.description,
              supplier_id = excluded.supplier_id,
              qr_code = excluded.qr_code,
              min_qty = excluded.min_qty,
              active = excluded.active,
              meta = excluded.meta
        returning id, part_no, description, supplier_id, qr_code, min_qty, active, meta, created_at;
        `,
        [id, partNo, description, supplierId, qrCode, minQty, active, meta, createdAt],
      )
      .then((r) => r.rows[0] || null);
    return json(res, 201, {
      item: {
        id: row.id,
        partNo: row.part_no,
        description: row.description,
        supplierId: row.supplier_id || null,
        qrCode: row.qr_code,
        minQty: Number(row.min_qty),
        active: Boolean(row.active),
        meta: row.meta || {},
        createdAt: new Date(row.created_at).toISOString(),
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/workshop/inventory/stock") {
    if (!requireAnyPermission(res, auth, [Permissions.InventoryView, Permissions.InventoryAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    const lowOnly = normalizeString(url.searchParams.get("lowOnly")) === "true";
    const rows = await pool
      .query(
        `
        select
          st.id,
          i.part_no,
          i.description,
          i.qr_code,
          i.min_qty,
          l.code as location_code,
          st.qty,
          i.active
        from workshop_inventory_stock st
        join workshop_inventory_item i on i.id = st.item_id
        join workshop_inventory_location l on l.id = st.location_id
        where ($1::boolean = false or st.qty < i.min_qty)
        order by (st.qty < i.min_qty) desc, i.part_no asc, l.code asc;
        `,
        [lowOnly],
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        partNo: r.part_no,
        description: r.description,
        qrCode: r.qr_code,
        minQty: Number(r.min_qty),
        locationCode: r.location_code,
        qty: Number(r.qty),
        low: Number(r.qty) < Number(r.min_qty),
        active: Boolean(r.active),
      })),
    });
  }

  if (method === "GET" && url.pathname === "/api/workshop/inventory/movements") {
    if (!requireAnyPermission(res, auth, [Permissions.InventoryView, Permissions.InventoryAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const partNo = normalizeString(url.searchParams.get("partNo")) || null;
    const unitId = normalizeString(url.searchParams.get("unitId")) || null;
    const caseId = normalizeString(url.searchParams.get("caseId")) || null;
    const movementType = normalizeString(url.searchParams.get("movementType")) || null;
    const serial = normalizeString(url.searchParams.get("serial")) || null;
    const batchNo = normalizeString(url.searchParams.get("batchNo")) || null;
    const fromRaw = normalizeString(url.searchParams.get("from")) || null;
    const toRaw = normalizeString(url.searchParams.get("to")) || null;
    const from = fromRaw ? parseIsoDate(fromRaw) : null;
    const to = toRaw ? parseIsoDate(toRaw) : null;
    if (fromRaw && !from) return badRequest(res, "invalid_from");
    if (toRaw && !to) return badRequest(res, "invalid_to");
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(200, limitRaw ? Number(limitRaw) : 50));
    const cursor = normalizeString(url.searchParams.get("cursor")) || null;

    const where = [];
    const params = [];
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (partNo) add("i.part_no = ?", partNo);
    if (unitId) add("m.unit_id = ?", unitId);
    if (caseId) add("m.case_id = ?", caseId);
    if (movementType && ["inbound", "putaway", "pickup", "issue", "transfer", "adjust"].includes(movementType)) add("m.movement_type = ?", movementType);
    if (from) add("m.occurred_at >= ?", from.toISOString());
    if (to) add("m.occurred_at <= ?", to.toISOString());
    if (serial) add("m.identifiers @> ?::jsonb", JSON.stringify({ serialNumbers: [normalizeIdentifiers({ serialNumber: serial }).identifiers.serialNumbers?.[0] || serial] }));
    if (batchNo) add("m.identifiers @> ?::jsonb", JSON.stringify({ batchNo: normalizeIdentifiers({ batchNo }).identifiers.batchNo || batchNo }));
    if (cursor) {
      const parts = cursor.split("|");
      if (parts.length === 2) {
        const cAt = parseIsoDate(parts[0]);
        const cId = normalizeString(parts[1]);
        if (cAt && cId) {
          params.push(cAt.toISOString());
          params.push(cId);
          where.push(`(m.occurred_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`);
        }
      }
    }

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const rows = await pool
      .query(
        `
        select
          m.id, m.movement_type, i.part_no, m.qty,
          fl.code as from_location_code,
          tl.code as to_location_code,
          m.unit_id, m.case_id, m.identifiers, m.reason, m.username, m.occurred_at, m.created_at
        from workshop_inventory_movement m
        join workshop_inventory_item i on i.id = m.item_id
        left join workshop_inventory_location fl on fl.id = m.from_location_id
        left join workshop_inventory_location tl on tl.id = m.to_location_id
        ${whereSql}
        order by m.occurred_at desc, m.id desc
        limit ${limit + 1};
        `,
        params,
      )
      .then((r) => r.rows);
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1] || null;
    const nextCursor = hasMore && last ? `${new Date(last.occurred_at).toISOString()}|${last.id}` : null;
    return json(res, 200, {
      items: slice.map((r) => ({
        id: r.id,
        movementType: r.movement_type,
        partNo: r.part_no,
        qty: Number(r.qty),
        fromLocationCode: r.from_location_code || null,
        toLocationCode: r.to_location_code || null,
        unitId: r.unit_id || null,
        caseId: r.case_id || null,
        identifiers: r.identifiers && typeof r.identifiers === "object" ? r.identifiers : {},
        reason: r.reason || null,
        username: r.username,
        occurredAt: new Date(r.occurred_at).toISOString(),
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor,
    });
  }

  if (method === "POST" && url.pathname === "/api/workshop/inventory/move") {
    if (!requireAnyPermission(res, auth, [Permissions.InventoryMove, Permissions.InventoryAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const movementType = normalizeString(body.movementType);
    const partNo = normalizeString(body.partNo);
    const qtyRaw = Number(body.qty);
    const fromLocationCode = normalizeString(body.fromLocationCode) || null;
    const toLocationCode = normalizeString(body.toLocationCode) || null;
    const unitId = normalizeString(body.unitId) || null;
    const caseId = normalizeString(body.caseId) || null;
    const idRes = normalizeIdentifiers(body.identifiers);
    if (!idRes.ok) return badRequest(res, idRes.error);
    const identifiers = idRes.identifiers;
    const reason = normalizeString(body.reason) || movementType || "movement";
    if (!["inbound", "putaway", "pickup", "issue", "transfer", "adjust"].includes(movementType)) return badRequest(res, "invalid_movementType");
    if (!partNo) return badRequest(res, "partNo_required");
    if (!Number.isFinite(qtyRaw) || qtyRaw === 0) return badRequest(res, "invalid_qty");
    const qty = Math.trunc(qtyRaw);
    const occurredAt = new Date().toISOString();

    const client = await pool.connect();
    try {
      await client.query("begin;");

      const item = await client
        .query(`select id, min_qty from workshop_inventory_item where part_no = $1 limit 1;`, [partNo])
        .then((r) => r.rows[0] || null);
      if (!item) {
        await client.query("rollback;");
        return badRequest(res, "item_not_found");
      }

      const fromLoc = fromLocationCode
        ? await client.query(`select id from workshop_inventory_location where code = $1 limit 1;`, [fromLocationCode]).then((r) => r.rows[0] || null)
        : null;
      const toLoc = toLocationCode
        ? await client.query(`select id from workshop_inventory_location where code = $1 limit 1;`, [toLocationCode]).then((r) => r.rows[0] || null)
        : null;

      if (movementType === "transfer" && (!fromLoc || !toLoc)) {
        await client.query("rollback;");
        return badRequest(res, "from_and_to_location_required");
      }
      if (["pickup", "issue"].includes(movementType) && !fromLoc) {
        await client.query("rollback;");
        return badRequest(res, "fromLocationCode_required");
      }
      if (["inbound", "putaway"].includes(movementType) && !toLoc) {
        await client.query("rollback;");
        return badRequest(res, "toLocationCode_required");
      }
      if (movementType === "adjust" && !toLoc) {
        await client.query("rollback;");
        return badRequest(res, "toLocationCode_required");
      }
      if (caseId && !(await getWorkshopCaseById(caseId))) {
        await client.query("rollback;");
        return badRequest(res, "case_not_found");
      }
      if (unitId && !(await getVehicleById(unitId))) {
        await client.query("rollback;");
        return badRequest(res, "unit_not_found");
      }

      async function ensureStockRow(locationId) {
        const id = `stk_${crypto.randomUUID().slice(0, 12)}`;
        const row = await client
          .query(
            `
            insert into workshop_inventory_stock (id, item_id, location_id, qty, updated_at)
            values ($1, $2, $3, 0, $4)
            on conflict (item_id, location_id) do update set updated_at = excluded.updated_at
            returning id, qty;
            `,
            [id, item.id, locationId, occurredAt],
          )
          .then((r) => r.rows[0] || null);
        return { id: row.id, qty: Number(row.qty) };
      }

      const fromStock = fromLoc ? await ensureStockRow(fromLoc.id) : null;
      const toStock = toLoc ? await ensureStockRow(toLoc.id) : null;

      if (movementType === "transfer") {
        if (fromStock.qty < Math.abs(qty)) {
          await client.query("rollback;");
          return badRequest(res, "insufficient_stock");
        }
        await client.query(`update workshop_inventory_stock set qty = qty - $2, updated_at = $3 where id = $1;`, [fromStock.id, Math.abs(qty), occurredAt]);
        await client.query(`update workshop_inventory_stock set qty = qty + $2, updated_at = $3 where id = $1;`, [toStock.id, Math.abs(qty), occurredAt]);
      } else if (movementType === "pickup" || movementType === "issue") {
        if (fromStock.qty < Math.abs(qty)) {
          await client.query("rollback;");
          return badRequest(res, "insufficient_stock");
        }
        await client.query(`update workshop_inventory_stock set qty = qty - $2, updated_at = $3 where id = $1;`, [fromStock.id, Math.abs(qty), occurredAt]);
      } else if (movementType === "inbound" || movementType === "putaway") {
        await client.query(`update workshop_inventory_stock set qty = qty + $2, updated_at = $3 where id = $1;`, [toStock.id, Math.abs(qty), occurredAt]);
      } else if (movementType === "adjust") {
        await client.query(`update workshop_inventory_stock set qty = qty + $2, updated_at = $3 where id = $1;`, [toStock.id, qty, occurredAt]);
      }

      const mvId = `mvt_${crypto.randomUUID().slice(0, 12)}`;
      await client.query(
        `
        insert into workshop_inventory_movement
          (id, movement_type, item_id, qty, from_location_id, to_location_id, unit_id, case_id, identifiers, reason, username, occurred_at, created_at)
        values
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13);
        `,
        [mvId, movementType, item.id, qty, fromLoc ? fromLoc.id : null, toLoc ? toLoc.id : null, unitId, caseId, identifiers, reason, auth.username, occurredAt, occurredAt],
      );

      await client.query("commit;");
      publishEvent("inventory", "inventory_movement_created", { id: mvId, movementType, partNo, qty, fromLocationCode, toLocationCode, unitId, caseId, occurredAt });
      publishEvent("dashboard", "dashboard_changed", { source: "inventory_movement_created", movementId: mvId });
      return json(res, 201, { item: { id: mvId, movementType, partNo, qty, fromLocationCode, toLocationCode, unitId, caseId, identifiers, reason, occurredAt } });
    } catch (e) {
      try {
        await client.query("rollback;");
      } catch {}
      return json(res, 500, { error: "inventory_move_failed", message: String(e && e.message ? e.message : e) });
    } finally {
      client.release();
    }
  }

  if (method === "GET" && url.pathname === "/api/workshop/inventory/export") {
    if (!requireAnyPermission(res, auth, [Permissions.InventoryView, Permissions.InventoryAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    const rows = await pool
      .query(
        `
        select
          i.part_no,
          i.description,
          i.qr_code,
          i.min_qty,
          l.code as location_code,
          st.qty,
          coalesce(s.name,'') as supplier_name
        from workshop_inventory_stock st
        join workshop_inventory_item i on i.id = st.item_id
        join workshop_inventory_location l on l.id = st.location_id
        left join workshop_inventory_supplier s on s.id = i.supplier_id
        order by i.part_no asc, l.code asc;
        `,
      )
      .then((r) => r.rows);
    const header = "partNo;description;qrCode;minQty;locationCode;qty;supplierName";
    const lines = [header];
    for (const r of rows) {
      const esc = (x) => String(x ?? "").replaceAll("\n", " ").replaceAll("\r", " ");
      lines.push([esc(r.part_no), esc(r.description), esc(r.qr_code), esc(r.min_qty), esc(r.location_code), esc(r.qty), esc(r.supplier_name)].join(";"));
    }
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
    return res.end(lines.join("\n"));
  }

  if (method === "GET" && url.pathname === "/api/exports/waste/orders") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteView, Permissions.FleetAdmin, Permissions.ViewAudit, Permissions.CustomerView, Permissions.ContractView])) return;
    if (!pool) return badRequest(res, "db_required");
    const fromRaw = normalizeString(url.searchParams.get("from")) || null;
    const toRaw = normalizeString(url.searchParams.get("to")) || null;
    const format = (normalizeString(url.searchParams.get("format")) || "csv").toLowerCase();
    const from = fromRaw ? parseIsoDate(fromRaw) : null;
    const to = toRaw ? parseIsoDate(toRaw) : null;
    if (fromRaw && !from) return badRequest(res, "invalid_from");
    if (toRaw && !to) return badRequest(res, "invalid_to");
    const rows = await pool
      .query(
        `
        select
          o.id,
          o.status,
          o.service_type,
          o.material_code,
          o.planned_tons,
          o.planned_volume_cbm,
          o.window_deliver_start,
          o.window_deliver_end,
          o.created_at,
          o.updated_at,
          c.customer_no,
          c.name as customer_name,
          ct.contract_no,
          m.code as municipality_code,
          ds.code as disposal_site_code
        from waste_container_order o
        left join crm_customer c on c.id = o.customer_ref_id
        left join crm_contract ct on ct.id = o.contract_id
        left join waste_municipality m on m.id = o.municipality_id
        left join waste_disposal_site ds on ds.id = o.disposal_site_id
        where ($1::timestamptz is null or o.created_at >= $1)
          and ($2::timestamptz is null or o.created_at <= $2)
        order by o.created_at desc
        limit 5000;
        `,
        [from ? from.toISOString() : null, to ? to.toISOString() : null],
      )
      .then((r) => r.rows);
    const items = rows.map((r) => ({
      id: r.id,
      status: r.status,
      serviceType: r.service_type,
      materialCode: r.material_code || null,
      plannedTons: r.planned_tons !== null ? Number(r.planned_tons) : null,
      plannedVolumeCbm: r.planned_volume_cbm !== null ? Number(r.planned_volume_cbm) : null,
      windowDeliverStart: new Date(r.window_deliver_start).toISOString(),
      windowDeliverEnd: new Date(r.window_deliver_end).toISOString(),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      customerNo: r.customer_no || null,
      customerName: r.customer_name || null,
      contractNo: r.contract_no || null,
      municipalityCode: r.municipality_code || null,
      disposalSiteCode: r.disposal_site_code || null,
    }));
    if (format !== "csv") return json(res, 200, { items });
    const header = "id;status;serviceType;materialCode;plannedTons;plannedVolumeCbm;windowDeliverStart;windowDeliverEnd;createdAt;updatedAt;customerNo;customerName;contractNo;municipalityCode;disposalSiteCode";
    const esc = (x) => String(x ?? "").replaceAll("\n", " ").replaceAll("\r", " ");
    const lines = [header];
    for (const it of items) {
      lines.push(
        [
          esc(it.id),
          esc(it.status),
          esc(it.serviceType),
          esc(it.materialCode),
          esc(it.plannedTons),
          esc(it.plannedVolumeCbm),
          esc(it.windowDeliverStart),
          esc(it.windowDeliverEnd),
          esc(it.createdAt),
          esc(it.updatedAt),
          esc(it.customerNo),
          esc(it.customerName),
          esc(it.contractNo),
          esc(it.municipalityCode),
          esc(it.disposalSiteCode),
        ].join(";"),
      );
    }
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
    return res.end(lines.join("\n"));
  }

  if (method === "GET" && url.pathname === "/api/exports/waste/invoices") {
    if (!requireAnyPermission(res, auth, [Permissions.PricingView, Permissions.PricingManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const fromRaw = normalizeString(url.searchParams.get("from")) || null;
    const toRaw = normalizeString(url.searchParams.get("to")) || null;
    const format = (normalizeString(url.searchParams.get("format")) || "csv").toLowerCase();
    const from = fromRaw ? parseIsoDate(fromRaw) : null;
    const to = toRaw ? parseIsoDate(toRaw) : null;
    if (fromRaw && !from) return badRequest(res, "invalid_from");
    if (toRaw && !to) return badRequest(res, "invalid_to");
    const rows = await pool
      .query(
        `
        select
          i.id,
          i.order_id,
          i.currency,
          i.total_cents,
          i.source,
          i.username,
          i.created_at,
          i.pricing_calculation_id,
          c.customer_no,
          c.name as customer_name
        from waste_invoice_draft i
        left join crm_customer c on c.id = i.customer_id
        where ($1::timestamptz is null or i.created_at >= $1)
          and ($2::timestamptz is null or i.created_at <= $2)
        order by i.created_at desc
        limit 5000;
        `,
        [from ? from.toISOString() : null, to ? to.toISOString() : null],
      )
      .then((r) => r.rows);
    const items = rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      currency: r.currency,
      totalCents: Number(r.total_cents),
      source: r.source,
      username: r.username,
      createdAt: new Date(r.created_at).toISOString(),
      pricingCalculationId: r.pricing_calculation_id || null,
      customerNo: r.customer_no || null,
      customerName: r.customer_name || null,
    }));
    if (format !== "csv") return json(res, 200, { items });
    const header = "id;orderId;currency;totalCents;source;username;createdAt;pricingCalculationId;customerNo;customerName";
    const esc = (x) => String(x ?? "").replaceAll("\n", " ").replaceAll("\r", " ");
    const lines = [header];
    for (const it of items) {
      lines.push([esc(it.id), esc(it.orderId), esc(it.currency), esc(it.totalCents), esc(it.source), esc(it.username), esc(it.createdAt), esc(it.pricingCalculationId), esc(it.customerNo), esc(it.customerName)].join(";"));
    }
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
    return res.end(lines.join("\n"));
  }

  if (method === "GET" && url.pathname === "/api/exports/waste/routes") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const day = parseYmd(url.searchParams.get("day")) || dateToYmd(new Date());
    const format = (normalizeString(url.searchParams.get("format")) || "csv").toLowerCase();
    const rows = await pool
      .query(
        `
        select
          r.id,
          r.day,
          r.depot_code,
          r.status,
          r.vehicle_id,
          r.driver_id,
          r.planned_start_at,
          r.planned_end_at,
          count(s.id)::int as stop_count
        from waste_route r
        left join waste_route_stop s on s.route_id = r.id
        where r.day = $1::date
        group by r.id
        order by r.created_at desc
        limit 2000;
        `,
        [day],
      )
      .then((r) => r.rows);
    const items = rows.map((r) => ({
      id: r.id,
      day: String(r.day).slice(0, 10),
      depotCode: r.depot_code || null,
      status: r.status,
      vehicleId: r.vehicle_id || null,
      driverId: r.driver_id || null,
      plannedStartAt: r.planned_start_at ? new Date(r.planned_start_at).toISOString() : null,
      plannedEndAt: r.planned_end_at ? new Date(r.planned_end_at).toISOString() : null,
      stopCount: Number(r.stop_count) || 0,
    }));
    if (format !== "csv") return json(res, 200, { items });
    const header = "id;day;depotCode;status;vehicleId;driverId;plannedStartAt;plannedEndAt;stopCount";
    const esc = (x) => String(x ?? "").replaceAll("\n", " ").replaceAll("\r", " ");
    const lines = [header];
    for (const it of items) {
      lines.push([esc(it.id), esc(it.day), esc(it.depotCode), esc(it.status), esc(it.vehicleId), esc(it.driverId), esc(it.plannedStartAt), esc(it.plannedEndAt), esc(it.stopCount)].join(";"));
    }
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
    return res.end(lines.join("\n"));
  }

  if (method === "GET" && url.pathname === "/api/reports/disposition/summary") {
    if (!requireAnyPermission(res, auth, [Permissions.WasteRouteView, Permissions.WasteRoutePlan, Permissions.WasteRouteManage, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const fromRaw = normalizeString(url.searchParams.get("from")) || null;
    const toRaw = normalizeString(url.searchParams.get("to")) || null;
    const depotCode = normalizeString(url.searchParams.get("depotCode")) || null;
    const format = (normalizeString(url.searchParams.get("format")) || "json").toLowerCase();
    const from = fromRaw ? parseIsoDate(fromRaw) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = toRaw ? parseIsoDate(toRaw) : new Date();
    if (fromRaw && !from) return badRequest(res, "invalid_from");
    if (toRaw && !to) return badRequest(res, "invalid_to");
    if (to < from) return badRequest(res, "to_must_be_after_from");
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const orders = await pool
      .query(
        `
        select
          status,
          count(*)::int as n
        from waste_container_order
        where created_at >= $1 and created_at <= $2
          and ($3::text is null or (site->>'depot') = $3)
        group by status;
        `,
        [fromIso, toIso, depotCode],
      )
      .then((r) => r.rows);
    const invoices = await pool
      .query(
        `
        select count(*)::int as n
        from waste_invoice_draft
        where created_at >= $1 and created_at <= $2;
        `,
        [fromIso, toIso],
      )
      .then((r) => r.rows[0]?.n ?? 0);
    const calcs = await pool
      .query(
        `
        select count(*)::int as n
        from pricing_calculation
        where created_at >= $1 and created_at <= $2;
        `,
        [fromIso, toIso],
      )
      .then((r) => r.rows[0]?.n ?? 0);
    const routes = await pool
      .query(
        `
        select count(*)::int as n
        from waste_route
        where created_at >= $1 and created_at <= $2
          and ($3::text is null or depot_code = $3);
        `,
        [fromIso, toIso, depotCode],
      )
      .then((r) => r.rows[0]?.n ?? 0);
    const out = {
      from: fromIso,
      to: toIso,
      depotCode: depotCode || null,
      ordersByStatus: orders.reduce((acc, r) => ((acc[r.status] = Number(r.n) || 0), acc), {}),
      routes: Number(routes) || 0,
      pricingCalculations: Number(calcs) || 0,
      invoiceDrafts: Number(invoices) || 0,
    };
    if (format !== "csv") return json(res, 200, out);
    const header = "from;to;depotCode;routes;pricingCalculations;invoiceDrafts;ordersByStatus";
    const esc = (x) => String(x ?? "").replaceAll("\n", " ").replaceAll("\r", " ");
    const line = [esc(out.from), esc(out.to), esc(out.depotCode), esc(out.routes), esc(out.pricingCalculations), esc(out.invoiceDrafts), esc(JSON.stringify(out.ordersByStatus))].join(";");
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
    return res.end([header, line].join("\n"));
  }

  if (method === "POST" && url.pathname === "/api/workshop/inventory/import") {
    if (!requireAnyPermission(res, auth, [Permissions.InventoryAdmin, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const csvText = typeof body.csvText === "string" ? body.csvText : "";
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (!lines.length) return badRequest(res, "empty_csv");
    const header = lines[0].split(";").map((s) => s.trim());
    if (header[0] !== "partNo" || header[4] !== "locationCode") return badRequest(res, "invalid_header");
    const client = await pool.connect();
    let imported = 0;
    try {
      await client.query("begin;");
      for (let i = 1; i < lines.length; i++) {
        const p = lines[i].split(";");
        if (p.length < 6) continue;
        const partNo = normalizeString(p[0]);
        const description = normalizeString(p[1]);
        const qrCode = normalizeString(p[2]);
        const minQty = p[3] ? Math.max(0, Math.round(Number(p[3]))) : 0;
        const locationCode = normalizeString(p[4]);
        const qty = p[5] ? Math.trunc(Number(p[5])) : 0;
        if (!partNo || !description || !qrCode || !locationCode) continue;
        const locId = `loc_${crypto.randomUUID().slice(0, 12)}`;
        const loc = await client
          .query(
            `
            insert into workshop_inventory_location (id, code, description, created_at)
            values ($1, $2, null, now())
            on conflict (code) do update set code = excluded.code
            returning id;
            `,
            [locId, locationCode],
          )
          .then((r) => r.rows[0] || null);
        const itemId = `itm_${crypto.randomUUID().slice(0, 12)}`;
        const item = await client
          .query(
            `
            insert into workshop_inventory_item (id, part_no, description, supplier_id, qr_code, min_qty, active, meta, created_at)
            values ($1, $2, $3, null, $4, $5, true, '{}'::jsonb, now())
            on conflict (part_no) do update
              set description = excluded.description,
                  qr_code = excluded.qr_code,
                  min_qty = excluded.min_qty
            returning id;
            `,
            [itemId, partNo, description, qrCode, minQty],
          )
          .then((r) => r.rows[0] || null);
        const stockId = `stk_${crypto.randomUUID().slice(0, 12)}`;
        await client.query(
          `
          insert into workshop_inventory_stock (id, item_id, location_id, qty, updated_at)
          values ($1, $2, $3, $4, now())
          on conflict (item_id, location_id) do update
            set qty = excluded.qty,
                updated_at = excluded.updated_at;
          `,
          [stockId, item.id, loc.id, qty],
        );
        imported++;
      }
      await client.query("commit;");
    } catch (e) {
      try {
        await client.query("rollback;");
      } catch {}
      return json(res, 500, { error: "inventory_import_failed", message: String(e && e.message ? e.message : e) });
    } finally {
      client.release();
    }
    return json(res, 200, { ok: true, imported });
  }

  if (method === "GET" && url.pathname === "/api/workshop/inspections") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const unitId = normalizeString(url.searchParams.get("unitId"));
    const status = normalizeString(url.searchParams.get("status")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(200, limitRaw ? Number(limitRaw) : 100));
    const where = [];
    const params = [];
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (unitId) add("unit_id = ?", unitId);
    if (status && ["scheduled", "completed"].includes(status)) add("status = ?", status);
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const rows = await pool
      .query(
        `
        select id, unit_id, inspection_type, due_month, due_from, due_to, status, completed_at, completed_by, report_pdf, created_by, created_at
        from fleet_inspection
        ${whereSql}
        order by due_to desc
        limit ${limit};
        `,
        params,
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => {
        const pdf = r.report_pdf && typeof r.report_pdf === "object" ? r.report_pdf : null;
        const dueFrom = r.due_from instanceof Date ? r.due_from : new Date(r.due_from);
        const dueTo = r.due_to instanceof Date ? r.due_to : new Date(r.due_to);
        return {
          id: r.id,
          unitId: r.unit_id,
          inspectionType: r.inspection_type,
          dueMonth: r.due_month,
          dueFrom: Number.isNaN(dueFrom.valueOf()) ? null : dueFrom.toISOString().slice(0, 10),
          dueTo: Number.isNaN(dueTo.valueOf()) ? null : dueTo.toISOString().slice(0, 10),
          status: r.status,
          completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
          completedBy: r.completed_by || null,
          reportPdf: pdf ? { mimeType: pdf.mimeType || null, sha256: pdf.sha256 || null, sizeBytes: pdf.sizeBytes || null } : null,
          createdBy: r.created_by,
          createdAt: new Date(r.created_at).toISOString(),
        };
      }),
    });
  }

  if (method === "POST" && url.pathname === "/api/workshop/inspections/schedule") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const unitId = normalizeString(body.unitId);
    const inspectionType = normalizeString(body.inspectionType);
    const dueMonth = normalizeString(body.dueMonth);
    if (!unitId) return badRequest(res, "unitId_required");
    if (!inspectionType) return badRequest(res, "inspectionType_required");
    if (!dueMonth) return badRequest(res, "dueMonth_required");
    const unit = await getVehicleById(unitId);
    if (!unit) return badRequest(res, "unit_not_found");
    const win = dueWindowFromMonth(dueMonth);
    if (!win) return badRequest(res, "invalid_dueMonth");
    const id = `insp_${crypto.randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    await pool.query(
      `
      insert into fleet_inspection
        (id, unit_id, inspection_type, due_month, due_from, due_to, status, completed_at, completed_by, report_pdf, created_by, created_at)
      values
        ($1,$2,$3,$4,$5::date,$6::date,'scheduled',null,null,null,$7,$8);
      `,
      [id, unitId, inspectionType, win.dueMonth, win.dueFrom.toISOString().slice(0, 10), win.dueTo.toISOString().slice(0, 10), auth.username, createdAt],
    );
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "FLEET_INSPECTION_SCHEDULED",
      username: auth.username,
      occurredAt: createdAt,
      lockType: null,
      blockId: null,
      vehicleId: unitId,
      blockReason: null,
      overrideId: id,
      overrideReason: null,
      meta: { inspectionType, dueMonth: win.dueMonth, dueFrom: win.dueFrom.toISOString().slice(0, 10), dueTo: win.dueTo.toISOString().slice(0, 10) },
    });
    publishEvent("inspections", "inspection_scheduled", { id, unitId, inspectionType, dueMonth: win.dueMonth, dueFrom: win.dueFrom.toISOString().slice(0, 10), dueTo: win.dueTo.toISOString().slice(0, 10) });
    publishEvent("dashboard", "dashboard_changed", { source: "inspection_scheduled", inspectionId: id, unitId });
    return json(res, 201, { item: { id, unitId, inspectionType, dueMonth: win.dueMonth, dueFrom: win.dueFrom.toISOString().slice(0, 10), dueTo: win.dueTo.toISOString().slice(0, 10), status: "scheduled" } });
  }

  if (method === "POST" && url.pathname === "/api/workshop/inspections/complete") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const id = normalizeString(body.id);
    if (!id) return badRequest(res, "id_required");
    const completedAt = body.completedAt ? parseIsoDate(body.completedAt) : new Date();
    if (!completedAt) return badRequest(res, "invalid_completedAt");
    const parsed = parseOptionalBase64Pdf(body.reportPdf);
    if (!parsed.ok) return badRequest(res, parsed.error);
    const rows = await pool.query(`select unit_id, status from fleet_inspection where id = $1 limit 1;`, [id]).then((r) => r.rows);
    const r0 = rows[0] || null;
    if (!r0) return notFound(res);
    if (r0.status !== "scheduled") return badRequest(res, "inspection_not_scheduled");
    await pool.query(
      `
      update fleet_inspection
      set status = 'completed',
          completed_at = $2,
          completed_by = $3,
          report_pdf = $4
      where id = $1;
      `,
      [id, completedAt.toISOString(), auth.username, parsed.pdf],
    );
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "FLEET_INSPECTION_COMPLETED",
      username: auth.username,
      occurredAt: new Date().toISOString(),
      lockType: null,
      blockId: null,
      vehicleId: r0.unit_id,
      blockReason: null,
      overrideId: id,
      overrideReason: null,
      meta: { completedAt: completedAt.toISOString(), pdfSha256: parsed.pdf ? parsed.pdf.sha256 : null },
    });
    publishEvent("inspections", "inspection_completed", { id, unitId: r0.unit_id, completedAt: completedAt.toISOString(), completedBy: auth.username });
    publishEvent("dashboard", "dashboard_changed", { source: "inspection_completed", inspectionId: id, unitId: r0.unit_id });
    return json(res, 200, { ok: true });
  }

  if (method === "GET" && url.pathname === "/api/workshop/inspections/report.pdf") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const id = normalizeString(url.searchParams.get("id"));
    if (!id) return badRequest(res, "id_required");
    const rows = await pool.query(`select report_pdf from fleet_inspection where id = $1 limit 1;`, [id]).then((r) => r.rows);
    const pdf = rows[0]?.report_pdf && typeof rows[0].report_pdf === "object" ? rows[0].report_pdf : null;
    if (!pdf) return badRequest(res, "pdf_not_found");
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        mimeType: pdf.mimeType || "application/pdf",
        base64: pdf.base64 || null,
        path: pdf.path || null,
        sha256: pdf.sha256 || null,
        sizeBytes: pdf.sizeBytes || null,
      }),
    );
  }

  if (method === "GET" && url.pathname === "/api/workshop/inspections/ics") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const startMonth = normalizeString(url.searchParams.get("startMonth"));
    const endMonth = normalizeString(url.searchParams.get("endMonth"));
    if (!startMonth) return badRequest(res, "startMonth_required");
    if (!endMonth) return badRequest(res, "endMonth_required");
    const sm = parseDueMonth(startMonth);
    const em = parseDueMonth(endMonth);
    if (!sm) return badRequest(res, "invalid_startMonth");
    if (!em) return badRequest(res, "invalid_endMonth");
    const start = `${String(sm.year).padStart(4, "0")}-${String(sm.month).padStart(2, "0")}-01`;
    const endWin = dueWindowFromMonth(`${String(em.year).padStart(4, "0")}-${String(em.month).padStart(2, "0")}`);
    const end = endWin.dueTo.toISOString().slice(0, 10);
    const rows = await pool
      .query(
        `
        select id, unit_id, inspection_type, due_from, due_to
        from fleet_inspection
        where status = 'scheduled' and due_from >= $1::date and due_to <= $2::date
        order by due_from asc;
        `,
        [start, end],
      )
      .then((r) => r.rows);
    const dtstamp = new Date().toISOString().replaceAll("-", "").replaceAll(":", "").slice(0, 15) + "Z";
    const esc = (s) => String(s || "").replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AhlertERP//Workshop//DE", "CALSCALE:GREGORIAN"];
    for (const r of rows) {
      const uid = `${r.id}@ahlert-erp`;
      const startDate = String(r.due_from).slice(0, 10).replaceAll("-", "");
      const endDate = new Date(new Date(`${String(r.due_to).slice(0, 10)}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "");
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${esc(uid)}`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;VALUE=DATE:${startDate}`);
      lines.push(`DTEND;VALUE=DATE:${endDate}`);
      lines.push(`SUMMARY:${esc(`Prüfung: ${r.inspection_type} (${r.unit_id})`)}`);
      lines.push(`DESCRIPTION:${esc(`Prüfzeitraum ${String(r.due_from).slice(0, 10)} bis ${String(r.due_to).slice(0, 10)}`)}`);
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
    return res.end(lines.join("\r\n"));
  }

  if (method === "GET" && url.pathname === "/api/workshop/orders/photo") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const caseId = normalizeString(url.searchParams.get("caseId"));
    if (!caseId) return badRequest(res, "caseId_required");
    const r = await getWorkshopCasePhoto({ caseId });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { item: r.item });
  }

  if (method === "GET" && url.pathname === "/api/workshop/orders/messages") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const caseId = normalizeString(url.searchParams.get("caseId"));
    if (!caseId) return badRequest(res, "caseId_required");
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(500, limitRaw ? Number(limitRaw) : 200));
    const rows = await pool
      .query(
        `
        select id, case_id, message, username, created_at
        from workshop_case_message
        where case_id = $1
        order by created_at asc
        limit $2;
        `,
        [caseId, limit],
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        caseId: r.case_id,
        message: r.message,
        username: r.username,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  }

  if (method === "POST" && url.pathname === "/api/workshop/orders/message") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopWork, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const caseId = normalizeString(body.caseId);
    const message = normalizeString(body.message);
    if (!caseId) return badRequest(res, "caseId_required");
    if (!message) return badRequest(res, "message_required");
    if (message.length > 5000) return badRequest(res, "message_too_long");
    const c = await getWorkshopCaseById(caseId);
    if (!c) return badRequest(res, "case_not_found");
    const id = `wsm_${crypto.randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    const row = await pool
      .query(
        `
        insert into workshop_case_message (id, case_id, message, username, created_at)
        values ($1, $2, $3, $4, $5)
        returning id, case_id, message, username, created_at;
        `,
        [id, caseId, message, auth.username, createdAt],
      )
      .then((r) => r.rows[0] || null);
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "WORKSHOP_CASE_MESSAGE_CREATED",
      username: auth.username,
      occurredAt: createdAt,
      lockType: c.lockType,
      blockId: null,
      vehicleId: c.vehicleId,
      blockReason: c.title,
      overrideId: caseId,
      overrideReason: null,
      meta: { messageLength: message.length },
    });
    publishEvent("workshop", "workshop_case_message_created", { id: row.id, caseId, username: row.username, createdAt: new Date(row.created_at).toISOString() });
    publishEvent("dashboard", "dashboard_changed", { source: "workshop_case_message_created", caseId });
    return json(res, 201, { item: { id: row.id, caseId: row.case_id, message: row.message, username: row.username, createdAt: new Date(row.created_at).toISOString() } });
  }

  if (method === "GET" && url.pathname === "/api/workshop/orders/approvals") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const caseId = normalizeString(url.searchParams.get("caseId"));
    if (!caseId) return badRequest(res, "caseId_required");
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(500, limitRaw ? Number(limitRaw) : 200));
    const rows = await pool
      .query(
        `
        select id, case_id, requested_by, requested_at, status, decided_by, decided_at, decision, note, created_at
        from workshop_case_approval
        where case_id = $1
        order by requested_at asc, created_at asc
        limit $2;
        `,
        [caseId, limit],
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        caseId: r.case_id,
        requestedBy: r.requested_by,
        requestedAt: new Date(r.requested_at).toISOString(),
        status: r.status,
        decidedBy: r.decided_by || null,
        decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
        decision: r.decision || null,
        note: r.note || null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  }

  if (method === "POST" && url.pathname === "/api/workshop/orders/approval/request") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopWork, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const caseId = normalizeString(body.caseId);
    const note = normalizeString(body.note) || null;
    if (!caseId) return badRequest(res, "caseId_required");
    if (note && note.length > 2000) return badRequest(res, "note_too_long");
    const c = await getWorkshopCaseById(caseId);
    if (!c) return badRequest(res, "case_not_found");
    const id = `wsa_${crypto.randomUUID().slice(0, 12)}`;
    const requestedAt = new Date().toISOString();
    const row = await pool
      .query(
        `
        insert into workshop_case_approval (id, case_id, requested_by, requested_at, status, decided_by, decided_at, decision, note, created_at)
        values ($1,$2,$3,$4,'requested',null,null,null,$5,$6)
        returning id, case_id, requested_by, requested_at, status, decided_by, decided_at, decision, note, created_at;
        `,
        [id, caseId, auth.username, requestedAt, note, requestedAt],
      )
      .then((r) => r.rows[0] || null);
    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "WORKSHOP_CASE_APPROVAL_REQUESTED",
      username: auth.username,
      occurredAt: requestedAt,
      lockType: c.lockType,
      blockId: null,
      vehicleId: c.vehicleId,
      blockReason: c.title,
      overrideId: caseId,
      overrideReason: null,
      meta: { approvalId: id },
    });
    publishEvent("workshop", "workshop_case_approval_requested", { id: row.id, caseId, requestedBy: row.requested_by, requestedAt: new Date(row.requested_at).toISOString(), note: row.note || null });
    publishEvent("dashboard", "dashboard_changed", { source: "workshop_case_approval_requested", caseId });
    return json(res, 201, {
      item: {
        id: row.id,
        caseId: row.case_id,
        requestedBy: row.requested_by,
        requestedAt: new Date(row.requested_at).toISOString(),
        status: row.status,
        note: row.note || null,
      },
    });
  }

  if (method === "POST" && url.pathname === "/api/workshop/orders/approval/decide") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const requestId = normalizeString(body.requestId);
    const decision = normalizeString(body.decision);
    const note = normalizeString(body.note) || null;
    if (!requestId) return badRequest(res, "requestId_required");
    if (!["approved", "rejected"].includes(decision)) return badRequest(res, "invalid_decision");
    if (note && note.length > 2000) return badRequest(res, "note_too_long");

    const reqRow = await pool
      .query(
        `
        select id, case_id, requested_by, requested_at, status
        from workshop_case_approval
        where id = $1
        limit 1;
        `,
        [requestId],
      )
      .then((r) => r.rows[0] || null);
    if (!reqRow) return badRequest(res, "request_not_found");
    if (reqRow.status !== "requested") return badRequest(res, "request_not_open");
    const c = await getWorkshopCaseById(reqRow.case_id);
    if (!c) return badRequest(res, "case_not_found");

    const id = `wsa_${crypto.randomUUID().slice(0, 12)}`;
    const decidedAt = new Date().toISOString();
    const row = await pool
      .query(
        `
        insert into workshop_case_approval (id, case_id, requested_by, requested_at, status, decided_by, decided_at, decision, note, created_at)
        values ($1,$2,$3,$4,'decided',$5,$6,$7,$8,$9)
        returning id, case_id, requested_by, requested_at, status, decided_by, decided_at, decision, note, created_at;
        `,
        [id, reqRow.case_id, reqRow.requested_by, new Date(reqRow.requested_at).toISOString(), auth.username, decidedAt, decision, note, decidedAt],
      )
      .then((r) => r.rows[0] || null);

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "WORKSHOP_CASE_APPROVAL_DECIDED",
      username: auth.username,
      occurredAt: decidedAt,
      lockType: c.lockType,
      blockId: null,
      vehicleId: c.vehicleId,
      blockReason: c.title,
      overrideId: reqRow.case_id,
      overrideReason: decision,
      meta: { requestId, approvalId: id },
    });
    publishEvent("workshop", "workshop_case_approval_decided", { id: row.id, caseId: row.case_id, requestId, decidedBy: row.decided_by, decidedAt: new Date(row.decided_at).toISOString(), decision: row.decision, note: row.note || null });
    publishEvent("dashboard", "dashboard_changed", { source: "workshop_case_approval_decided", caseId: row.case_id });
    return json(res, 201, {
      item: {
        id: row.id,
        caseId: row.case_id,
        requestId,
        requestedBy: row.requested_by,
        requestedAt: new Date(row.requested_at).toISOString(),
        status: row.status,
        decidedBy: row.decided_by,
        decidedAt: new Date(row.decided_at).toISOString(),
        decision: row.decision,
        note: row.note || null,
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/workshop/orders/signatures") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const caseId = normalizeString(url.searchParams.get("caseId"));
    if (!caseId) return badRequest(res, "caseId_required");
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(200, limitRaw ? Number(limitRaw) : 50));
    const rows = await pool
      .query(
        `
        select id, case_id, signed_by, signed_at, signature, created_at
        from workshop_case_signature
        where case_id = $1
        order by signed_at desc
        limit $2;
        `,
        [caseId, limit],
      )
      .then((r) => r.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        caseId: r.case_id,
        signedBy: r.signed_by,
        signedAt: new Date(r.signed_at).toISOString(),
        signature: r.signature && typeof r.signature === "object" ? r.signature : {},
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  }

  if (method === "POST" && url.pathname === "/api/workshop/orders/sign") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopWork, Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    if (!pool) return badRequest(res, "db_required");
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const caseId = normalizeString(body.caseId);
    if (!caseId) return badRequest(res, "caseId_required");
    const c = await getWorkshopCaseById(caseId);
    if (!c) return badRequest(res, "case_not_found");
    if (!(c.status === "closed" || c.workState === "done")) return badRequest(res, "case_not_done");

    const parsed = parseSignature(body.signature);
    if (!parsed.ok) return badRequest(res, parsed.error);

    const id = `wss_${crypto.randomUUID().slice(0, 12)}`;
    const signedAt = new Date().toISOString();
    const row = await pool
      .query(
        `
        insert into workshop_case_signature (id, case_id, signed_by, signed_at, signature, created_at)
        values ($1,$2,$3,$4,$5,$6)
        returning id, case_id, signed_by, signed_at, signature, created_at;
        `,
        [id, caseId, auth.username, signedAt, parsed.signature, signedAt],
      )
      .then((r) => r.rows[0] || null);

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "WORKSHOP_CASE_SIGNED",
      username: auth.username,
      occurredAt: signedAt,
      lockType: c.lockType,
      blockId: null,
      vehicleId: c.vehicleId,
      blockReason: c.title,
      overrideId: caseId,
      overrideReason: row.signature && row.signature.sha256 ? row.signature.sha256 : null,
      meta: { signatureType: row.signature && row.signature.type ? row.signature.type : null },
    });
    publishEvent("workshop", "workshop_case_signed", { id: row.id, caseId, signedBy: row.signed_by, signedAt: new Date(row.signed_at).toISOString(), signature: { type: row.signature && row.signature.type ? row.signature.type : null, sha256: row.signature && row.signature.sha256 ? row.signature.sha256 : null } });
    publishEvent("dashboard", "dashboard_changed", { source: "workshop_case_signed", caseId });
    return json(res, 201, { item: { id: row.id, caseId: row.case_id, signedBy: row.signed_by, signedAt: new Date(row.signed_at).toISOString(), signature: { type: row.signature.type, sha256: row.signature.sha256 || null } } });
  }

  if (method === "POST" && url.pathname === "/api/workshop/cases/close") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const caseId = normalizeString(body.caseId);
    const closedReason = normalizeString(body.closedReason);
    if (!caseId) return badRequest(res, "caseId_required");
    if (!closedReason) return badRequest(res, "closedReason_required");
    const r = await closeWorkshopCase({ caseId, closedReason, username: auth.username });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { item: r.item });
  }

  if (method === "POST" && url.pathname === "/api/workshop/vehicles/meter") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const vehicleId = normalizeString(body.vehicleId);
    if (!vehicleId) return badRequest(res, "vehicleId_required");
    const r = await recordWorkshopVehicleMeter({
      vehicleId,
      km: body.km,
      engineHours: body.engineHours,
      recordedAt: body.recordedAt,
      source: body.source,
      username: auth.username,
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 201, { item: r.item });
  }

  if (method === "POST" && url.pathname === "/api/workshop/vehicles/service/record") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const vehicleId = normalizeString(body.vehicleId);
    if (!vehicleId) return badRequest(res, "vehicleId_required");
    const r = await recordWorkshopVehicleService({
      vehicleId,
      serviceCode: body.serviceCode,
      km: body.km,
      engineHours: body.engineHours,
      servicedAt: body.servicedAt,
      username: auth.username,
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 201, { item: r.item });
  }

  if (method === "POST" && url.pathname === "/api/workshop/admin/maintenance-rule") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const r = await upsertWorkshopMaintenanceRule({
      vehicleType: body.vehicleType,
      serviceCode: body.serviceCode,
      kmInterval: body.kmInterval,
      daysInterval: body.daysInterval,
      hoursInterval: body.hoursInterval,
      active: body.active,
      username: auth.username,
    });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url.pathname === "/api/workshop/admin/vehicle-data/analyze") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const csvText = typeof body.csvText === "string" ? body.csvText : "";
    const a = analyzeDbExportCsvText(csvText);
    if (!a.ok) return badRequest(res, a.error);
    return json(res, 200, a);
  }

  if (method === "GET" && url.pathname === "/api/workshop/admin/vehicle-data/analyze-file") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let raw;
    try {
      raw = fs.readFileSync("/import/db_export_2026-06-03.csv", "utf8");
    } catch {
      return badRequest(res, "file_not_found");
    }
    const a = analyzeDbExportCsvText(raw);
    if (!a.ok) return badRequest(res, a.error);
    return json(res, 200, { source: "/import/db_export_2026-06-03.csv", ...a });
  }

  if (method === "POST" && url.pathname === "/api/workshop/admin/import/db-export/validate-file") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    const r = await validateDbExportFile({ requestedBy: auth.username });
    if (!r.ok) return json(res, 409, { ok: false, error: r.error, runId: r.runId || null, summary: r.summary || null });
    const issues = (r.issues || []).slice(0, 500);
    return json(res, 200, { ok: true, runId: r.runId, summary: r.summary, issues, truncated: (r.issues || []).length > issues.length });
  }

  if (method === "POST" && url.pathname === "/api/workshop/admin/import/db-export/import-file") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin])) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") body = {};
    const dryRun = body.dryRun === true;
    const sync = body.sync === true || normalizeString(url.searchParams.get("sync")) === "true";
    if (sync) {
      const r = await importDbExportFile({ requestedBy: auth.username, dryRun });
      if (!r.ok) return json(res, 409, { ok: false, error: r.error, runId: r.runId || null, summary: r.summary || null, message: r.message || null });
      return json(res, 201, { ok: true, runId: r.runId, validationRunId: r.validationRunId, summary: r.summary });
    }
    const job = await createJob({ type: "import_db_export", requestedBy: auth.username, params: { dryRun } });
    if (!job.ok) return badRequest(res, job.error);
    publishEvent("jobs", "job_created", { jobId: job.id, type: "import_db_export", requestedBy: auth.username });
    return json(res, 202, { ok: true, jobId: job.id });
  }

  if (method === "GET" && url.pathname === "/api/workshop/admin/import/runs") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const kind = normalizeString(url.searchParams.get("kind")) || "db_export";
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(100, limitRaw ? Number(limitRaw) : 20));
    const rows = await pool
      .query(
        `
        select id, kind, source_path, status, started_at, finished_at, requested_by, summary
        from import_run
        where kind = $1
        order by finished_at desc
        limit $2;
        `,
        [kind, limit],
      )
      .then((x) => x.rows);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        sourcePath: r.source_path,
        status: r.status,
        startedAt: new Date(r.started_at).toISOString(),
        finishedAt: new Date(r.finished_at).toISOString(),
        requestedBy: r.requested_by,
        summary: r.summary || {},
      })),
    });
  }

  if (method === "GET" && url.pathname === "/api/workshop/admin/import/run") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const id = normalizeString(url.searchParams.get("id"));
    if (!id) return badRequest(res, "id_required");
    const run = await pool
      .query(
        `
        select id, kind, source_path, status, started_at, finished_at, requested_by, summary
        from import_run
        where id = $1
        limit 1;
        `,
        [id],
      )
      .then((x) => x.rows[0] || null);
    if (!run) return notFound(res);
    const issues = await pool
      .query(
        `
        select severity, table_name, pk, column_name, entity_type, entity_key, message, details, created_at
        from import_issue
        where run_id = $1
        order by
          case severity when 'error' then 1 when 'warning' then 2 else 3 end asc,
          created_at asc
        limit 2000;
        `,
        [id],
      )
      .then((x) => x.rows);
    return json(res, 200, {
      item: {
        id: run.id,
        kind: run.kind,
        sourcePath: run.source_path,
        status: run.status,
        startedAt: new Date(run.started_at).toISOString(),
        finishedAt: new Date(run.finished_at).toISOString(),
        requestedBy: run.requested_by,
        summary: run.summary || {},
        issues: issues.map((x) => ({
          severity: x.severity,
          tableName: x.table_name || null,
          pk: x.pk || null,
          columnName: x.column_name || null,
          entityType: x.entity_type || null,
          entityKey: x.entity_key || null,
          message: x.message,
          details: x.details || {},
          createdAt: new Date(x.created_at).toISOString(),
        })),
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/workshop/vehicles/maintenance/status") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    const vehicleId = normalizeString(url.searchParams.get("vehicleId"));
    const serviceCode = normalizeString(url.searchParams.get("serviceCode"));
    if (!vehicleId) return badRequest(res, "vehicleId_required");
    const r = await getWorkshopMaintenanceStatus({ vehicleId, serviceCode });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { item: r.item });
  }

  if (method === "GET" && url.pathname === "/api/workshop/reports/summary") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");
    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const orderCounts = await pool
      .query(
        `
        select
          sum(case when status = 'open' then 1 else 0 end)::int as open_count,
          sum(case when status = 'closed' then 1 else 0 end)::int as closed_count,
          sum(case when status = 'open' and lock_type = 'hard' then 1 else 0 end)::int as critical_open_count
        from workshop_case;
        `,
      )
      .then((r) => r.rows[0] || { open_count: 0, closed_count: 0, critical_open_count: 0 });
    const orderDur = await pool
      .query(
        `
        select
          avg(extract(epoch from (closed_at - opened_at))) as avg_seconds
        from workshop_case
        where status = 'closed' and closed_at >= $1;
        `,
        [since30],
      )
      .then((r) => r.rows[0] || { avg_seconds: null });
    const invMoves = await pool
      .query(
        `
        select
          count(*)::int as movements,
          sum(abs(qty))::int as qty_abs
        from workshop_inventory_movement
        where occurred_at >= $1;
        `,
        [since30],
      )
      .then((r) => r.rows[0] || { movements: 0, qty_abs: 0 });
    const lowStock = await pool
      .query(
        `
        select count(*)::int as low
        from workshop_inventory_stock st
        join workshop_inventory_item i on i.id = st.item_id
        where st.qty < i.min_qty;
        `,
      )
      .then((r) => r.rows[0] || { low: 0 });
    const today = now.toISOString().slice(0, 10);
    const insp = await pool
      .query(
        `
        select
          sum(case when status = 'scheduled' then 1 else 0 end)::int as scheduled,
          sum(case when status = 'completed' then 1 else 0 end)::int as completed,
          sum(case when status = 'scheduled' and due_to < $1::date then 1 else 0 end)::int as overdue,
          sum(case when status = 'scheduled' and due_from <= $1::date and due_to >= $1::date then 1 else 0 end)::int as due_now
        from fleet_inspection;
        `,
        [today],
      )
      .then((r) => r.rows[0] || { scheduled: 0, completed: 0, overdue: 0, due_now: 0 });
    return json(res, 200, {
      generatedAt: now.toISOString(),
      orders: {
        open: Number(orderCounts.open_count) || 0,
        closed: Number(orderCounts.closed_count) || 0,
        criticalOpen: Number(orderCounts.critical_open_count) || 0,
        avgThroughputSecondsLast30Days: orderDur.avg_seconds !== null ? Math.round(Number(orderDur.avg_seconds)) : null,
      },
      inventory: {
        movementsLast30Days: Number(invMoves.movements) || 0,
        quantityAbsLast30Days: Number(invMoves.qty_abs) || 0,
        lowStockPositions: Number(lowStock.low) || 0,
      },
      inspections: {
        scheduled: Number(insp.scheduled) || 0,
        completed: Number(insp.completed) || 0,
        dueNow: Number(insp.due_now) || 0,
        overdue: Number(insp.overdue) || 0,
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/workshop/reports/kpis") {
    if (!requireAnyPermission(res, auth, [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit])) return;
    if (!pool) return badRequest(res, "db_required");

    const now = new Date();
    const fromRaw = normalizeString(url.searchParams.get("from")) || null;
    const toRaw = normalizeString(url.searchParams.get("to")) || null;
    const format = (normalizeString(url.searchParams.get("format")) || "json").toLowerCase();
    const from = fromRaw ? parseIsoDate(fromRaw) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = toRaw ? parseIsoDate(toRaw) : now;
    if (fromRaw && !from) return badRequest(res, "invalid_from");
    if (toRaw && !to) return badRequest(res, "invalid_to");
    if (!from || !to) return badRequest(res, "invalid_window");
    if (to < from) return badRequest(res, "to_must_be_after_from");

    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const fromDate = fromIso.slice(0, 10);
    const toDate = toIso.slice(0, 10);

    const sla = {
      highSeconds: 48 * 60 * 60,
      mediumSeconds: 5 * 24 * 60 * 60,
      lowSeconds: 10 * 24 * 60 * 60,
    };

    const closed = await pool
      .query(
        `
        select
          count(*)::int as closed_total,
          avg(extract(epoch from (closed_at - opened_at))) as avg_seconds,
          percentile_disc(0.5) within group (order by extract(epoch from (closed_at - opened_at))) as p50_seconds,
          percentile_disc(0.9) within group (order by extract(epoch from (closed_at - opened_at))) as p90_seconds
        from workshop_case
        where status = 'closed'
          and closed_at >= $1
          and closed_at <= $2;
        `,
        [fromIso, toIso],
      )
      .then((r) => r.rows[0] || null);

    const slaClosed = await pool
      .query(
        `
        select
          sum(case when priority = 'high' then 1 else 0 end)::int as high_total,
          sum(case when priority = 'high' and closed_at <= opened_at + interval '48 hours' then 1 else 0 end)::int as high_met,
          sum(case when priority = 'medium' then 1 else 0 end)::int as medium_total,
          sum(case when priority = 'medium' and closed_at <= opened_at + interval '5 days' then 1 else 0 end)::int as medium_met,
          sum(case when priority = 'low' then 1 else 0 end)::int as low_total,
          sum(case when priority = 'low' and closed_at <= opened_at + interval '10 days' then 1 else 0 end)::int as low_met
        from workshop_case
        where status = 'closed'
          and closed_at >= $1
          and closed_at <= $2;
        `,
        [fromIso, toIso],
      )
      .then((r) => r.rows[0] || null);

    const openStates = await pool
      .query(
        `
        select
          work_state,
          count(*)::int as n,
          avg(extract(epoch from (now() - opened_at))) as avg_age_seconds
        from workshop_case
        where status = 'open'
        group by work_state
        order by n desc;
        `,
      )
      .then((r) => r.rows);

    const openSla = await pool
      .query(
        `
        select
          sum(case when priority = 'high' then 1 else 0 end)::int as high_open,
          sum(case when priority = 'high' and now() > opened_at + interval '48 hours' then 1 else 0 end)::int as high_breached,
          sum(case when priority = 'medium' then 1 else 0 end)::int as medium_open,
          sum(case when priority = 'medium' and now() > opened_at + interval '5 days' then 1 else 0 end)::int as medium_breached,
          sum(case when priority = 'low' then 1 else 0 end)::int as low_open,
          sum(case when priority = 'low' and now() > opened_at + interval '10 days' then 1 else 0 end)::int as low_breached
        from workshop_case
        where status = 'open';
        `,
      )
      .then((r) => r.rows[0] || null);

    const inventoryFlow = await pool
      .query(
        `
        select
          sum(case when movement_type in ('issue','pickup') then abs(qty) else 0 end)::int as consumption_qty,
          sum(case when movement_type in ('inbound','putaway') then abs(qty) else 0 end)::int as inbound_qty,
          count(*)::int as movements
        from workshop_inventory_movement
        where occurred_at >= $1
          and occurred_at <= $2;
        `,
        [fromIso, toIso],
      )
      .then((r) => r.rows[0] || null);

    const stockNow = await pool
      .query(
        `
        select sum(qty)::int as total_qty
        from workshop_inventory_stock;
        `,
      )
      .then((r) => r.rows[0] || { total_qty: 0 });

    const inspections = await pool
      .query(
        `
        select
          count(*)::int as due_total,
          sum(case when status = 'completed' and completed_at::date <= due_to then 1 else 0 end)::int as compliant,
          sum(case when status = 'completed' and completed_at::date > due_to then 1 else 0 end)::int as late_completed,
          sum(case when status = 'scheduled' and due_to < $2::date then 1 else 0 end)::int as overdue_open
        from fleet_inspection
        where due_to >= $1::date and due_to <= $2::date;
        `,
        [fromDate, toDate],
      )
      .then((r) => r.rows[0] || null);

    const out = {
      generatedAt: now.toISOString(),
      window: { from: fromIso, to: toIso },
      orders: {
        closed: {
          total: Number(closed?.closed_total) || 0,
          avgSeconds: closed?.avg_seconds !== null && closed?.avg_seconds !== undefined ? Math.round(Number(closed.avg_seconds)) : null,
          p50Seconds: closed?.p50_seconds !== null && closed?.p50_seconds !== undefined ? Math.round(Number(closed.p50_seconds)) : null,
          p90Seconds: closed?.p90_seconds !== null && closed?.p90_seconds !== undefined ? Math.round(Number(closed.p90_seconds)) : null,
        },
        openByWorkState: openStates.map((r) => ({
          workState: r.work_state || "created",
          count: Number(r.n) || 0,
          avgAgeSeconds: r.avg_age_seconds !== null && r.avg_age_seconds !== undefined ? Math.round(Number(r.avg_age_seconds)) : null,
        })),
      },
      sla: {
        thresholdsSeconds: sla,
        closed: {
          high: { total: Number(slaClosed?.high_total) || 0, met: Number(slaClosed?.high_met) || 0 },
          medium: { total: Number(slaClosed?.medium_total) || 0, met: Number(slaClosed?.medium_met) || 0 },
          low: { total: Number(slaClosed?.low_total) || 0, met: Number(slaClosed?.low_met) || 0 },
        },
        openBreachesNow: {
          high: { open: Number(openSla?.high_open) || 0, breached: Number(openSla?.high_breached) || 0 },
          medium: { open: Number(openSla?.medium_open) || 0, breached: Number(openSla?.medium_breached) || 0 },
          low: { open: Number(openSla?.low_open) || 0, breached: Number(openSla?.low_breached) || 0 },
        },
      },
      inventory: {
        movements: Number(inventoryFlow?.movements) || 0,
        inboundQty: Number(inventoryFlow?.inbound_qty) || 0,
        consumptionQty: Number(inventoryFlow?.consumption_qty) || 0,
        stockQtyNow: Number(stockNow?.total_qty) || 0,
        turnoverApprox: Number(stockNow?.total_qty) > 0 ? Number(inventoryFlow?.consumption_qty || 0) / Number(stockNow.total_qty) : null,
      },
      inspections: {
        dueTotal: Number(inspections?.due_total) || 0,
        compliant: Number(inspections?.compliant) || 0,
        lateCompleted: Number(inspections?.late_completed) || 0,
        overdueOpen: Number(inspections?.overdue_open) || 0,
      },
    };

    if (format === "csv") {
      const lines = ["metric;value"];
      const add = (k, v) => lines.push(`${String(k).replaceAll("\n", " ")};${String(v ?? "").replaceAll("\n", " ")}`);
      add("window.from", out.window.from);
      add("window.to", out.window.to);
      add("orders.closed.total", out.orders.closed.total);
      add("orders.closed.avgSeconds", out.orders.closed.avgSeconds);
      add("orders.closed.p50Seconds", out.orders.closed.p50Seconds);
      add("orders.closed.p90Seconds", out.orders.closed.p90Seconds);
      add("sla.closed.high.total", out.sla.closed.high.total);
      add("sla.closed.high.met", out.sla.closed.high.met);
      add("sla.closed.medium.total", out.sla.closed.medium.total);
      add("sla.closed.medium.met", out.sla.closed.medium.met);
      add("sla.closed.low.total", out.sla.closed.low.total);
      add("sla.closed.low.met", out.sla.closed.low.met);
      add("inventory.movements", out.inventory.movements);
      add("inventory.inboundQty", out.inventory.inboundQty);
      add("inventory.consumptionQty", out.inventory.consumptionQty);
      add("inventory.stockQtyNow", out.inventory.stockQtyNow);
      add("inventory.turnoverApprox", out.inventory.turnoverApprox);
      add("inspections.dueTotal", out.inspections.dueTotal);
      add("inspections.compliant", out.inspections.compliant);
      add("inspections.lateCompleted", out.inspections.lateCompleted);
      add("inspections.overdueOpen", out.inspections.overdueOpen);
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
      return res.end(lines.join("\n"));
    }

    return json(res, 200, out);
  }

  if (method === "GET" && url.pathname === "/api/fleet/blocks") {
    const activeOnly = url.searchParams.get("activeOnly") === "true";
    return json(res, 200, { items: await getAvailabilityBlocks({ activeOnly }) });
  }

  if (url.pathname === "/api/fleet/blocks" && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "POST" && url.pathname === "/api/fleet/blocks") {
    if (!requirePermission(res, auth, Permissions.CreateBlock)) return;
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }

    if (!body || typeof body !== "object") return badRequest(res, "missing_body");

    const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId : "";
    const sourceModule = typeof body.sourceModule === "string" ? body.sourceModule : "workshop";
    const reason = typeof body.reason === "string" ? body.reason : "";
    const severity = typeof body.severity === "string" ? body.severity : "warning";
    const lockTypeRaw = typeof body.lockType === "string" ? body.lockType : "";
    const startsAt = typeof body.startsAt === "string" ? body.startsAt : new Date().toISOString();
    const endsAt = typeof body.endsAt === "string" ? body.endsAt : null;
    const reference = body.reference && typeof body.reference === "object" ? body.reference : null;

    if (!vehicleId) return badRequest(res, "vehicleId_required");
    if (!(await getVehicleById(vehicleId))) return badRequest(res, "vehicle_not_found");
    if (!reason) return badRequest(res, "reason_required");
    if (!["critical", "warning", "info"].includes(severity)) return badRequest(res, "invalid_severity");

    const lockType = lockTypeRaw === "soft" || lockTypeRaw === "hard" ? lockTypeRaw : severity === "critical" ? "hard" : "soft";

    const startDate = new Date(startsAt);
    if (Number.isNaN(startDate.valueOf())) return badRequest(res, "invalid_startsAt");
    const endDate = endsAt ? new Date(endsAt) : null;
    if (endDate && Number.isNaN(endDate.valueOf())) return badRequest(res, "invalid_endsAt");
    if (endDate && endDate <= startDate) return badRequest(res, "endsAt_must_be_after_startsAt");

    const id = `blk_${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    const record = {
      id,
      vehicleId,
      sourceModule,
      severity,
      lockType,
      reason,
      startsAt: startDate.toISOString(),
      endsAt: endDate ? endDate.toISOString() : null,
      reference: reference && typeof reference.entityType === "string" && typeof reference.entityId === "string"
        ? { entityType: reference.entityType, entityId: reference.entityId }
        : { entityType: "unknown", entityId: id },
      createdAt,
    };

    if (pool) {
      await pool.query(
        `
        insert into fleet_availability_block
          (id, vehicle_id, source_module, severity, lock_type, reason, starts_at, ends_at, ref_entity_type, ref_entity_id, created_at)
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
        `,
        [
          record.id,
          record.vehicleId,
          record.sourceModule,
          record.severity,
          record.lockType,
          record.reason,
          record.startsAt,
          record.endsAt,
          record.reference.entityType,
          record.reference.entityId,
          record.createdAt,
        ],
      );

      await insertAuditLog({
        id: `al_${crypto.randomUUID()}`,
        eventType: "BLOCK_CREATED",
        username: auth.username,
        occurredAt: record.createdAt,
        lockType: record.lockType,
        blockId: record.id,
        vehicleId: record.vehicleId,
        blockReason: record.reason,
        overrideId: null,
        overrideReason: null,
        meta: { sourceModule: record.sourceModule, severity: record.severity },
      });
    }
    publishEvent("dashboard", "dashboard_changed", { source: "block_created", blockId: record.id, vehicleId: record.vehicleId });
    return json(res, 201, { item: record });
  }

  if (method === "GET" && url.pathname === "/api/fleet/availability") {
    const vehicleId = (url.searchParams.get("vehicleId") || "").trim();
    if (!vehicleId) return badRequest(res, "vehicleId_required");
    const vehicle = await getVehicleById(vehicleId);
    if (!vehicle) return badRequest(res, "vehicle_not_found");

    const atRaw = (url.searchParams.get("at") || "").trim();
    const at = atRaw ? new Date(atRaw) : new Date();
    if (Number.isNaN(at.valueOf())) return badRequest(res, "invalid_at");

    const blocks = (await getAvailabilityBlocks({ activeOnly: true })).filter((b) => b.vehicleId === vehicleId && isBlockActive(b, at));
    const overrides = await getActiveOverridesForUser(auth.username, at);
    const overrideBlockIds = new Set(overrides.map((o) => o.blockId));

    const hardBlocks = blocks.filter((b) => b.lockType === "hard");
    const softBlocks = blocks.filter((b) => b.lockType === "soft");

    const hardWithoutOverride = hardBlocks.filter((b) => !overrideBlockIds.has(b.id));

    return json(res, 200, {
      vehicle,
      at: at.toISOString(),
      allowed: hardWithoutOverride.length === 0,
      blocks: blocks.map((b) => ({
        id: b.id,
        lockType: b.lockType,
        severity: b.severity,
        reason: b.reason,
        sourceModule: b.sourceModule,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        overridden: overrideBlockIds.has(b.id),
        deepLink: blockDeepLink(b),
      })),
      warnings: softBlocks
        .filter((b) => !overrideBlockIds.has(b.id))
        .map((b) => ({
          code: "soft_block_active",
          blockId: b.id,
          message: b.reason,
        })),
      blocking: hardWithoutOverride.map((b) => ({
        code: "hard_block_active",
        blockId: b.id,
        message: b.reason,
      })),
      auth: { username: auth.username, mode: auth.mode },
    });
  }

  if (url.pathname === "/api/fleet/dispatch/decision" && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/fleet/dispatch/decision") {
    const vehicleIdParam = parseRequiredStringParam(res, url, "vehicleId");
    if (!vehicleIdParam.ok) return;
    const moduleParam = parseRequiredStringParam(res, url, "module");
    if (!moduleParam.ok) return;
    const windowStartParam = parseRequiredIsoDateParam(res, url, "windowStart");
    if (!windowStartParam.ok) return;
    const windowEndParam = parseRequiredIsoDateParam(res, url, "windowEnd");
    if (!windowEndParam.ok) return;

    const vehicleId = vehicleIdParam.value;
    const moduleKey = moduleParam.value;
    if (moduleKey !== "waste") return badRequest(res, "module_must_be_waste");
    const windowStart = windowStartParam.value;
    const windowEnd = windowEndParam.value;
    if (windowEnd <= windowStart) return badRequest(res, "windowEnd_must_be_after_windowStart");

    const vehicle = await getVehicleById(vehicleId);
    if (!vehicle) return badRequest(res, "vehicle_not_found");

    const siteLatRaw = normalizeString(url.searchParams.get("siteLat"));
    const siteLonRaw = normalizeString(url.searchParams.get("siteLon"));
    const maxDistanceKmRaw = normalizeString(url.searchParams.get("maxDistanceKm"));
    const siteLat = siteLatRaw ? Number(siteLatRaw) : null;
    const siteLon = siteLonRaw ? Number(siteLonRaw) : null;
    const maxDistanceKm = maxDistanceKmRaw ? Number(maxDistanceKmRaw) : null;

    if ((siteLatRaw && !Number.isFinite(siteLat)) || (siteLonRaw && !Number.isFinite(siteLon))) return badRequest(res, "invalid_site_coordinates");
    if (maxDistanceKmRaw && !Number.isFinite(maxDistanceKm)) return badRequest(res, "invalid_maxDistanceKm");

    const context = {
      routeId: normalizeString(url.searchParams.get("routeId")),
      orderId: normalizeString(url.searchParams.get("orderId")),
      customerId: normalizeString(url.searchParams.get("customerId")),
      plannedTons: normalizeString(url.searchParams.get("plannedTons")),
      driverId: normalizeString(url.searchParams.get("driverId")),
      siteDepot: normalizeString(url.searchParams.get("siteDepot")),
      siteLat: siteLatRaw ? siteLat : null,
      siteLon: siteLonRaw ? siteLon : null,
      maxDistanceKm: maxDistanceKmRaw ? maxDistanceKm : null,
      weighRequired: toBool(url.searchParams.get("weighRequired")),
      tankRequired: toBool(url.searchParams.get("tankRequired")),
      depotCandidates: parseCsv(url.searchParams.get("depotCandidates")),
      priorityUrgency: normalizeString(url.searchParams.get("priorityUrgency")),
      priorityValue: normalizeString(url.searchParams.get("priorityValue")),
      priorityCustomerTier: normalizeString(url.searchParams.get("priorityCustomerTier")),
      containerSize: normalizeString(url.searchParams.get("containerSize")),
      containerType: normalizeString(url.searchParams.get("containerType")),
      grapplerType: normalizeString(url.searchParams.get("grapplerType")),
      adrClass: normalizeString(url.searchParams.get("adrClass")),
      shiftStart: normalizeString(url.searchParams.get("shiftStart")),
      shiftEnd: normalizeString(url.searchParams.get("shiftEnd")),
      lastShiftEnd: normalizeString(url.searchParams.get("lastShiftEnd")),
      minRestMinutes: normalizeString(url.searchParams.get("minRestMinutes")),
      plannedWorkMinutes: normalizeString(url.searchParams.get("plannedWorkMinutes")),
      maxWorkMinutes: normalizeString(url.searchParams.get("maxWorkMinutes")),
      loadMinutes: normalizeString(url.searchParams.get("loadMinutes")),
      unloadMinutes: normalizeString(url.searchParams.get("unloadMinutes")),
      transitMinutes: normalizeString(url.searchParams.get("transitMinutes")),
    };

    const evalResult = await evaluateDispatchDecision({ vehicle, moduleKey, windowStart, windowEnd, context });
    const override = await getDispatchOverride(vehicleId, moduleKey, windowStart, windowEnd);
    const effectiveDecision = override ? override.decision : evalResult.baseDecision;

    const response = {
      vehicle,
      module: moduleKey,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      decision: effectiveDecision,
      baseDecision: evalResult.baseDecision,
      reasonCode: override ? "manual_override" : evalResult.reasonCode,
      reasons: evalResult.reasons,
      warnings: evalResult.warnings,
      suggestions: evalResult.suggestions,
      overrideRequirement: evalResult.overrideRequirement,
      criteria: evalResult.criteria,
      blocks: {
        hard: evalResult.hardBlocks.map((b) => ({
          id: b.id,
          lockType: b.lockType,
          severity: b.severity,
          reason: b.reason,
          sourceModule: b.sourceModule,
          startsAt: b.startsAt,
          endsAt: b.endsAt,
          deepLink: blockDeepLink(b),
        })),
        soft: evalResult.softBlocks.map((b) => ({
          id: b.id,
          lockType: b.lockType,
          severity: b.severity,
          reason: b.reason,
          sourceModule: b.sourceModule,
          startsAt: b.startsAt,
          endsAt: b.endsAt,
          deepLink: blockDeepLink(b),
        })),
      },
      override,
      context,
      auth: { username: auth.username, mode: auth.mode },
    };

    await insertAuditLog({
      id: `al_${crypto.randomUUID()}`,
      eventType: "DISPATCH_DECISION_EVALUATED",
      username: auth.username || "anonymous",
      occurredAt: new Date().toISOString(),
      lockType: evalResult.hardBlocks.length ? "hard" : evalResult.softBlocks.length ? "soft" : null,
      blockId: null,
      vehicleId,
      blockReason: null,
      overrideId: override ? override.id : null,
      overrideReason: override ? override.reason : null,
      meta: {
        endpoint: "/api/fleet/dispatch/decision",
        method: "GET",
        module: moduleKey,
        windowStart: response.windowStart,
        windowEnd: response.windowEnd,
        baseDecision: response.baseDecision,
        decision: response.decision,
        reasonCode: response.reasonCode,
        context: response.context,
        criteria: response.criteria,
        reasons: response.reasons,
        warnings: response.warnings,
        suggestions: response.suggestions,
        overrideRequirement: response.overrideRequirement,
      },
    });

    return json(res, 200, response);
  }

  if (method === "POST" && url.pathname === "/api/fleet/dispatch/decision") {
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");

    const vehicleId = normalizeString(body.vehicleId);
    const moduleKey = normalizeString(body.module);
    const windowStart = parseIsoDate(body.windowStart);
    const windowEnd = parseIsoDate(body.windowEnd);
    const decision = normalizeString(body.decision);
    const reason = normalizeString(body.reason);
    const expiresAt = body.expiresAt ? parseIsoDate(body.expiresAt) : null;

    if (!vehicleId) return badRequest(res, "vehicleId_required");
    if (!moduleKey) return badRequest(res, "module_required");
    if (moduleKey !== "waste") return badRequest(res, "module_must_be_waste");
    if (!windowStart) return badRequest(res, "invalid_windowStart");
    if (!windowEnd) return badRequest(res, "invalid_windowEnd");
    if (windowEnd <= windowStart) return badRequest(res, "windowEnd_must_be_after_windowStart");
    if (!["allow", "deny"].includes(decision)) return badRequest(res, "invalid_decision");
    if (!reason) return badRequest(res, "reason_required");

    const vehicle = await getVehicleById(vehicleId);
    if (!vehicle) return badRequest(res, "vehicle_not_found");

    if (!auth.permissions.has(Permissions.OverrideDispatch)) return forbidden(res);

    const ctxSource = body.context && typeof body.context === "object" ? body.context : body;
    const ctx = {
      routeId: normalizeString(ctxSource.routeId),
      orderId: normalizeString(ctxSource.orderId),
      customerId: normalizeString(ctxSource.customerId),
      plannedTons: normalizeString(ctxSource.plannedTons),
      driverId: normalizeString(ctxSource.driverId),
      siteDepot: normalizeString(ctxSource.siteDepot),
      siteLat: ctxSource.siteLat === null || ctxSource.siteLat === undefined || ctxSource.siteLat === "" ? null : Number(ctxSource.siteLat),
      siteLon: ctxSource.siteLon === null || ctxSource.siteLon === undefined || ctxSource.siteLon === "" ? null : Number(ctxSource.siteLon),
      maxDistanceKm: ctxSource.maxDistanceKm === null || ctxSource.maxDistanceKm === undefined || ctxSource.maxDistanceKm === "" ? null : Number(ctxSource.maxDistanceKm),
      weighRequired: Boolean(ctxSource.weighRequired),
      tankRequired: Boolean(ctxSource.tankRequired),
      depotCandidates: Array.isArray(ctxSource.depotCandidates) ? ctxSource.depotCandidates : parseCsv(ctxSource.depotCandidates),
      priorityUrgency: normalizeString(ctxSource.priorityUrgency),
      priorityValue: normalizeString(ctxSource.priorityValue),
      priorityCustomerTier: normalizeString(ctxSource.priorityCustomerTier),
      containerSize: normalizeString(ctxSource.containerSize),
      containerType: normalizeString(ctxSource.containerType),
      grapplerType: normalizeString(ctxSource.grapplerType),
      adrClass: normalizeString(ctxSource.adrClass),
      shiftStart: normalizeString(ctxSource.shiftStart),
      shiftEnd: normalizeString(ctxSource.shiftEnd),
      lastShiftEnd: normalizeString(ctxSource.lastShiftEnd),
      minRestMinutes: normalizeString(ctxSource.minRestMinutes),
      plannedWorkMinutes: normalizeString(ctxSource.plannedWorkMinutes),
      maxWorkMinutes: normalizeString(ctxSource.maxWorkMinutes),
      loadMinutes: normalizeString(ctxSource.loadMinutes),
      unloadMinutes: normalizeString(ctxSource.unloadMinutes),
      transitMinutes: normalizeString(ctxSource.transitMinutes),
    };
    if ((ctx.siteLat !== null && !Number.isFinite(ctx.siteLat)) || (ctx.siteLon !== null && !Number.isFinite(ctx.siteLon))) return badRequest(res, "invalid_site_coordinates");
    if (ctx.maxDistanceKm !== null && !Number.isFinite(ctx.maxDistanceKm)) return badRequest(res, "invalid_maxDistanceKm");

    const evalResult = await evaluateDispatchDecision({ vehicle, moduleKey, windowStart, windowEnd, context: ctx });
    const hardPresent = evalResult.hardBlocks.length > 0;
    const approvalBody = {
      vehicleId,
      module: moduleKey,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      decision,
      reason,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      context: ctx,
    };
    const r = await createApprovalRequest({
      requestType: "ROUTE_OVERRIDE",
      requestSubtype: "dispatch_decision_override",
      requestedBy: auth.username,
      reason,
      payload: {
        body: approvalBody,
        meta: { overrideRequirement: evalResult.overrideRequirement, hardBlocksPresent: hardPresent, requiresHard: hardPresent || evalResult.overrideRequirement === "elevated" },
      },
      meta: { source: "api", endpoint: "/api/fleet/dispatch/decision", module: moduleKey },
    });
    if (!r.ok) return badRequest(res, r.error);

    return json(res, 202, {
      approval: r.item,
      baseDecision: evalResult.baseDecision,
      overrideRequirement: evalResult.overrideRequirement,
      hardBlocks: evalResult.hardBlocks.map((b) => ({ id: b.id, reason: b.reason, lockType: b.lockType })),
      softBlocks: evalResult.softBlocks.map((b) => ({ id: b.id, reason: b.reason, lockType: b.lockType })),
    });
  }

  if (url.pathname === "/api/fleet/overrides" && method !== "POST" && method !== "GET") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/fleet/overrides") {
    if (!requirePermission(res, auth, Permissions.ViewAudit)) return;
    const username = (url.searchParams.get("username") || "").trim();
    if (!username) return badRequest(res, "username_required");
    const atRaw = (url.searchParams.get("at") || "").trim();
    const at = atRaw ? new Date(atRaw) : new Date();
    if (Number.isNaN(at.valueOf())) return badRequest(res, "invalid_at");
    return json(res, 200, { items: await getActiveOverridesForUser(username, at) });
  }

  if (method === "POST" && url.pathname === "/api/fleet/overrides") {
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");

    const blockId = typeof body.blockId === "string" ? body.blockId : "";
    const overrideReason = typeof body.overrideReason === "string" ? body.overrideReason : "";
    const expiresAtRaw = typeof body.expiresAt === "string" ? body.expiresAt : "";

    if (!blockId) return badRequest(res, "blockId_required");
    if (!overrideReason) return badRequest(res, "overrideReason_required");

    const blocks = await getAvailabilityBlocks({ activeOnly: false });
    const block = blocks.find((b) => b.id === blockId) || null;
    if (!block) return badRequest(res, "block_not_found");

    if (block.lockType === "hard") {
      if (!requirePermission(res, auth, Permissions.OverrideHard)) return;
    } else {
      if (!requirePermission(res, auth, Permissions.OverrideSoft)) return;
    }

    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
    if (expiresAt && Number.isNaN(expiresAt.valueOf())) return badRequest(res, "invalid_expiresAt");

    const id = `ovr_${crypto.randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();

    if (pool) {
      await pool.query(
        `
        insert into fleet_override
          (id, block_id, username, override_reason, expires_at, created_at)
        values
          ($1, $2, $3, $4, $5, $6);
        `,
        [id, blockId, auth.username, overrideReason, expiresAt ? expiresAt.toISOString() : null, createdAt],
      );

      await insertAuditLog({
        id: `al_${crypto.randomUUID()}`,
        eventType: "OVERRIDE_CREATED",
        username: auth.username,
        occurredAt: createdAt,
        lockType: block.lockType,
        blockId: block.id,
        vehicleId: block.vehicleId,
        blockReason: block.reason,
        overrideId: id,
        overrideReason,
        meta: { expiresAt: expiresAt ? expiresAt.toISOString() : null },
      });
    }

    return json(res, 201, {
      item: {
        id,
        blockId,
        username: auth.username,
        overrideReason,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        createdAt,
      },
    });
  }

  if (url.pathname.startsWith("/api/approvals") && method !== "GET" && method !== "POST") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/approvals/requests") {
    if (!requireAnyPermission(res, auth, [Permissions.ApprovalView, Permissions.ViewAudit, Permissions.FleetAdmin])) return;
    const status = normalizeString(url.searchParams.get("status")) || null;
    const requestType = normalizeString(url.searchParams.get("type")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const items = await listApprovalRequests({ status, requestType, limit: limitRaw ? Number(limitRaw) : 50 });
    return json(res, 200, { items });
  }

  if (method === "GET" && url.pathname === "/api/approvals/request") {
    if (!requireAnyPermission(res, auth, [Permissions.ApprovalView, Permissions.ViewAudit, Permissions.FleetAdmin])) return;
    const id = normalizeString(url.searchParams.get("id"));
    if (!id) return badRequest(res, "id_required");
    const item = await getApprovalRequestById(id);
    if (!item) return notFound(res);
    return json(res, 200, { item });
  }

  if (method === "GET" && url.pathname === "/api/approvals/audit") {
    if (!requireAnyPermission(res, auth, [Permissions.ApprovalView, Permissions.ViewAudit, Permissions.FleetAdmin])) return;
    const requestId = normalizeString(url.searchParams.get("requestId")) || null;
    const limitRaw = normalizeString(url.searchParams.get("limit"));
    const limit = Math.max(1, Math.min(500, Number(limitRaw) || 100));
    if (!pool) return json(res, 200, { items: [] });
    const rows = await pool
      .query(
        `
        select id, request_id, entity_type, entity_id, event_type, username, occurred_at, reason, meta
        from erp_approval_audit
        where ($1::text is null or request_id = $1)
        order by occurred_at desc
        limit $2;
        `,
        [requestId, limit],
      )
      .then((r) => r.rows)
      .catch(() => []);
    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        requestId: r.request_id || null,
        entityType: r.entity_type,
        entityId: r.entity_id || null,
        eventType: r.event_type,
        username: r.username,
        occurredAt: new Date(r.occurred_at).toISOString(),
        reason: r.reason || null,
        meta: r.meta || {},
      })),
    });
  }

  if (method === "POST" && url.pathname === "/api/approvals/approve") {
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const requestId = normalizeString(body.requestId);
    const reason = normalizeString(body.reason) || null;
    if (!requestId) return badRequest(res, "requestId_required");
    const r = await decideApprovalRequest({ requestId, decision: "approve", auth, reason });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { item: r.item, applied: r.applied || null });
  }

  if (method === "POST" && url.pathname === "/api/approvals/reject") {
    if (!auth.username) return unauthorized(res);
    let body;
    try {
      body = await readJson(req);
    } catch {
      return badRequest(res, "invalid_json");
    }
    if (!body || typeof body !== "object") return badRequest(res, "missing_body");
    const requestId = normalizeString(body.requestId);
    const reason = normalizeString(body.reason) || null;
    if (!requestId) return badRequest(res, "requestId_required");
    const r = await decideApprovalRequest({ requestId, decision: "reject", auth, reason });
    if (!r.ok) return badRequest(res, r.error);
    return json(res, 200, { item: r.item });
  }

  if (url.pathname === "/api/audit/logs" && method !== "GET") {
    return methodNotAllowed(res);
  }

  if (method === "GET" && url.pathname === "/api/audit/logs") {
    if (!requirePermission(res, auth, Permissions.ViewAudit)) return;
    const limitRaw = url.searchParams.get("limit") || "100";
    const limit = Math.max(1, Math.min(500, Number(limitRaw)));
    if (!Number.isFinite(limit)) return badRequest(res, "invalid_limit");

    const vehicleId = (url.searchParams.get("vehicleId") || "").trim();
    const blockId = (url.searchParams.get("blockId") || "").trim();
    const username = (url.searchParams.get("username") || "").trim();
    const eventType = (url.searchParams.get("eventType") || "").trim();

    if (!pool) return json(res, 200, { items: [] });

    const where = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };

    if (vehicleId) add("vehicle_id = ?", vehicleId);
    if (blockId) add("block_id = ?", blockId);
    if (username) add("username = ?", username);
    if (eventType) add("event_type = ?", eventType);

    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const rows = await pool
      .query(
        `
        select
          id,
          event_type,
          username,
          occurred_at,
          lock_type,
          block_id,
          vehicle_id,
          block_reason,
          override_id,
          override_reason,
          meta
        from fleet_audit_log
        ${whereSql}
        order by occurred_at desc
        limit ${limit};
        `,
        params,
      )
      .then((r) => r.rows);

    return json(res, 200, {
      items: rows.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        username: r.username,
        occurredAt: new Date(r.occurred_at).toISOString(),
        lockType: r.lock_type,
        blockId: r.block_id,
        vehicleId: r.vehicle_id,
        blockReason: r.block_reason,
        overrideId: r.override_id,
        overrideReason: r.override_reason,
        meta: r.meta || {},
      })),
    });
  }

  if (method === "GET" && url.pathname === "/api/docs/dispatch/decision") {
    return json(res, 200, {
      name: "fleet.dispatch.decision",
      endpoints: {
        decision: {
          method: "GET",
          path: "/api/fleet/dispatch/decision",
          requiredQuery: ["vehicleId", "module", "windowStart", "windowEnd"],
          optionalQuery: [
            "routeId",
            "orderId",
            "customerId",
            "plannedTons",
            "driverId",
            "siteDepot",
            "siteLat",
            "siteLon",
            "maxDistanceKm",
            "depotCandidates",
            "priorityUrgency",
            "priorityValue",
            "priorityCustomerTier",
            "containerSize",
            "containerType",
            "grapplerType",
            "adrClass",
            "weighRequired",
            "tankRequired",
            "shiftStart",
            "shiftEnd",
            "lastShiftEnd",
            "minRestMinutes",
            "plannedWorkMinutes",
            "maxWorkMinutes",
            "loadMinutes",
            "unloadMinutes",
            "transitMinutes",
          ],
          constraints: { module: ["waste"], windowEndAfterWindowStart: true },
          returns: { decision: ["allow", "deny"], baseDecision: ["allow", "deny"], reasonCode: "string" },
        },
        override: {
          method: "POST",
          path: "/api/fleet/dispatch/decision",
          body: ["vehicleId", "module", "windowStart", "windowEnd", "decision", "reason"],
          permissions: [Permissions.OverrideDispatch],
          hardOverrideExtraPermission: Permissions.OverrideHard,
        },
        admin: {
          permissions: [Permissions.FleetAdmin],
          endpoints: [
            { method: "POST", path: "/api/fleet/admin/depot" },
            { method: "POST", path: "/api/fleet/admin/vehicle-location" },
            { method: "POST", path: "/api/fleet/admin/vehicle-equipment" },
            { method: "POST", path: "/api/fleet/admin/system-status" },
            { method: "POST", path: "/api/fleet/admin/driver-binding" },
            { method: "POST", path: "/api/fleet/admin/assignment" },
            { method: "POST", path: "/api/fleet/admin/blocks/close" },
          ],
        },
        audit: {
          method: "GET",
          path: "/api/audit/logs",
          permissions: [Permissions.ViewAudit],
          filter: { eventType: ["DISPATCH_DECISION_EVALUATED", "DISPATCH_DECISION_OVERRIDDEN"] },
        },
      },
      rules: {
        matching: {
          containerSize: ["20ft", "40ft", "45ft"],
          containerType: [
            { code: "standard", label: "Standardcontainer" },
            { code: "reefer", label: "Kühlcontainer" },
            { code: "special", label: "Spezialcontainer" },
          ],
          grapplerType: [
            { code: "standard", label: "Standardgreifer" },
            { code: "heavy", label: "Schwergutgreifer" },
            { code: "hazmat", label: "Spezialgreifer Gefahrgut" },
          ],
          adrClass: "String '1'..'9' (vereinfachtes Modell pro Auftrag).",
          behavior: "Nicht passende Kombinationen führen zu baseDecision=deny. Bestimmte Compliance-/Safety-Gründe setzen overrideRequirement=elevated.",
        },
        time: {
          shiftWindow: "Optional shiftStart/shiftEnd. Wenn windowStart/windowEnd außerhalb liegen => deny + Vorschlag adjust_window.",
          rest: "Optional lastShiftEnd + minRestMinutes. Unterschreitung => deny + Vorschlag adjust_shiftStart.",
          overtime: "Optional plannedWorkMinutes + maxWorkMinutes. Überschreitung => deny.",
          conflicts: "Dispositions-Konflikte werden gegen fleet_dispatch_assignment geprüft (vehicleId und optional driverId).",
        },
        depot: {
          recommendation: "Wenn siteLat/siteLon vorhanden sind, wird eine Depotempfehlung über fleet_depot berechnet (Distanz + Utilization, prioritätsadjustiert).",
          candidates: "depotCandidates als CSV (z.B. GREVEN,MUENSTER) begrenzt die Auswahl.",
          priority: "priorityUrgency (low|normal|high|critical) + priorityValue (Zahl) + priorityCustomerTier (A|B|C) -> priorityScore 0..100.",
        },
      },
      reasonCatalog: { endpoint: "/api/docs/reason-codes" },
      examples: {
        evaluate: "/api/fleet/dispatch/decision?vehicleId=veh_01&module=waste&windowStart=2026-06-01T08:00:00Z&windowEnd=2026-06-01T12:00:00Z",
        overrideAllow: {
          curl: "curl -X POST /api/fleet/dispatch/decision -H 'content-type: application/json' -H 'x-user: admin' -H 'x-permissions: OVERRIDE_DISPATCH,OVERRIDE_HARD' --data '{\"vehicleId\":\"veh_01\",\"module\":\"waste\",\"windowStart\":\"2026-06-01T08:00:00Z\",\"windowEnd\":\"2026-06-01T12:00:00Z\",\"decision\":\"allow\",\"reason\":\"Ausnahmegenehmigung\"}'",
        },
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/docs/reason-codes") {
    return json(res, 200, { items: ReasonCatalog });
  }

  if (method === "GET" && url.pathname === "/api/docs/reconcile/ahlert24") {
    return json(res, 200, {
      name: "reconcile.ahlert24.offer-vs-erp",
      endpoints: {
        run: {
          method: "POST",
          path: "/api/reconcile/ahlert24/run",
          permissions: [Permissions.FleetAdmin],
          body: {
            mode: { type: "string", allowed: ["live", "mock"], default: "live" },
          },
        },
        latest: { method: "GET", path: "/api/reconcile/ahlert24/latest", permissions: [Permissions.ViewAudit] },
        runs: { method: "GET", path: "/api/reconcile/ahlert24/runs?limit=20", permissions: [Permissions.ViewAudit] },
        runById: { method: "GET", path: "/api/reconcile/ahlert24/run?id=rec_...", permissions: [Permissions.ViewAudit] },
      },
      sources: {
        containerOverview: "https://www.ahlert24.de/container-service/container-uebersicht/",
        faq: "https://www.ahlert24.de/info-service-faq/",
      },
      tlsAndProxy: {
        behavior: "TLS-Zertifikatsprüfung ist zwingend aktiv. Optional werden Zwischenzertifikate automatisch via AIA nachgeladen, wenn die Serverkette unvollständig ist.",
        env: {
          ERP_HTTPS_PROXY: "Optional. Beispiel: http://proxy.example.local:3128 oder http://user:pass@proxy:3128",
          ERP_EXTRA_CA_PEM_PATH: "Optional. Pfad zu PEM-Datei (z. B. /run/secrets/company-ca.pem).",
          ERP_EXTRA_CA_PEM_BASE64: "Optional. PEM als Base64-kodierter String (Alternative zu *_PATH).",
        },
      },
      output: {
        report: {
          summary: "Zähler + Empfehlungen",
          findings: "Liste der Abweichungen mit severity high|medium|low",
        },
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/docs/waste/container-order") {
    return json(res, 200, {
      name: "waste.container-order.mvp",
      endpoints: {
        create: { method: "POST", path: "/api/waste/orders", permissions: [Permissions.FleetAdmin] },
        listOrGet: { method: "GET", path: "/api/waste/orders?status=...&limit=50 OR /api/waste/orders?id=ord_...", permissions: [Permissions.ViewAudit] },
        status: { method: "POST", path: "/api/waste/orders/status", permissions: [Permissions.FleetAdmin] },
        dispatchCheck: { method: "POST", path: "/api/waste/orders/dispatch/check", permissions: [Permissions.FleetAdmin] },
        dispatchAssign: { method: "POST", path: "/api/waste/orders/dispatch/assign", permissions: [Permissions.FleetAdmin] },
        weighMock: { method: "POST", path: "/api/waste/orders/weigh/mock", permissions: [Permissions.FleetAdmin] },
        invoiceMock: { method: "POST", path: "/api/waste/orders/invoice/mock", permissions: [Permissions.FleetAdmin] },
      },
      statusMachine: {
        statuses: WasteOrderStatuses,
        transitions: WasteOrderTransitions,
        notes: "Unzulässige Zustandswechsel werden mit 400 invalid_status_transition abgelehnt. Jede Transition wird immutable in waste_container_order_event + im Auditlog protokolliert.",
      },
      dispatch: {
        module: "waste",
        source: "fleet.dispatch.decision (GET /api/fleet/dispatch/decision)",
        rule: "dispatch/assign ist nur möglich, wenn decision=allow (ggf. via vorhandenes Dispatch-Override).",
      },
      mocks: {
        weigh: "Erzeugt waste_weigh_ticket (source=mock) und setzt Status -> weighed.",
        invoice: "Erzeugt waste_invoice_draft (source=mock) und setzt Status -> invoiced.",
      },
      audit: {
        endpoint: "/api/audit/logs",
        eventTypes: [
          "WASTE_ORDER_CREATED",
          "WASTE_ORDER_STATUS_CHANGED",
          "WASTE_ORDER_DISPATCH_CHECKED",
          "WASTE_ORDER_SCHEDULED",
          "WASTE_ORDER_WEIGHED",
          "WASTE_ORDER_INVOICED",
        ],
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/docs/workshop/vehicle-core") {
    return json(res, 200, {
      name: "workshop.vehicle-core.mvp",
      endpoints: {
        casesList: {
          method: "GET",
          path: "/api/workshop/cases?vehicleId=veh_04&status=open&limit=50",
          permissions: [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit],
        },
        caseCreate: { method: "POST", path: "/api/workshop/cases", permissions: [Permissions.WorkshopCreate, Permissions.WorkshopAdmin, Permissions.FleetAdmin] },
        orderCreate: { method: "POST", path: "/api/workshop/orders", permissions: [Permissions.WorkshopCreate, Permissions.WorkshopAdmin, Permissions.FleetAdmin] },
        pool: { method: "GET", path: "/api/workshop/orders/pool?limit=100&priority=high|medium|low&assigned=assigned|unassigned", permissions: [Permissions.WorkshopView] },
        assign: { method: "POST", path: "/api/workshop/orders/assign", permissions: [Permissions.WorkshopAssign, Permissions.WorkshopAdmin, Permissions.FleetAdmin] },
        photoGet: { method: "GET", path: "/api/workshop/orders/photo?caseId=wsc_...", permissions: [Permissions.WorkshopView] },
        caseClose: { method: "POST", path: "/api/workshop/cases/close", permissions: [Permissions.WorkshopAdmin, Permissions.FleetAdmin] },
        meterRecord: { method: "POST", path: "/api/workshop/vehicles/meter", permissions: [Permissions.WorkshopAdmin, Permissions.FleetAdmin] },
        serviceRecord: { method: "POST", path: "/api/workshop/vehicles/service/record", permissions: [Permissions.WorkshopAdmin, Permissions.FleetAdmin] },
        maintenanceRuleSet: { method: "POST", path: "/api/workshop/admin/maintenance-rule", permissions: [Permissions.WorkshopAdmin, Permissions.FleetAdmin] },
        maintenanceStatus: {
          method: "GET",
          path: "/api/workshop/vehicles/maintenance/status?vehicleId=veh_04&serviceCode=maintenance",
          permissions: [Permissions.WorkshopView, Permissions.WorkshopAdmin, Permissions.FleetAdmin, Permissions.ViewAudit],
        },
      },
      fields: {
        requiredOnCreate: ["vehicleId", "title", "description"],
        description: { requirement: "pflichtig", minLength: 20, errorCodes: ["description_required", "description_too_short"] },
        priority: { allowed: ["low", "medium", "high"], default: "medium" },
        reporterRole: { allowed: ["driver", "workshop"], default: "workshop" },
        photo: { optional: true, mimeTypes: ["image/jpeg", "image/png", "image/webp"], maxBytes: 2000000 },
        poolStatus: { computed: true, allowed: ["open", "assigned", "critical_blocked", "closed"] },
      },
      integration: {
        availabilityBlocks: "Jeder Workshop-Case erzeugt eine fleet_availability_block Sperre (source_module=workshop, ref_entity_type=workshopCase). Beim Schließen wird ends_at gesetzt.",
        dispatch: "Die Dispositionsentscheidung blockiert bei lock_type=hard automatisch (reasonCode=hard_block) in allen operativen Einsatzbereichen, die Vehicle Core verwenden.",
      },
      audit: {
        endpoint: "/api/audit/logs",
        eventTypes: [
          "WORKSHOP_CASE_CREATED",
          "WORKSHOP_CASE_CLOSED",
          "WORKSHOP_CASE_ASSIGNED",
          "WORKSHOP_CASE_UNASSIGNED",
          "WORKSHOP_METER_RECORDED",
          "WORKSHOP_SERVICE_RECORDED",
          "WORKSHOP_MAINTENANCE_RULE_SET",
        ],
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/docs/workshop/planning-options") {
    return json(res, 200, {
      name: "workshop.planning.options",
      topCriterion: "Transparenz/Übersichtlichkeit (Auswirkung auf Einsatzplanung Entsorgung/Kanal).",
      options: [
        {
          key: "calendar",
          label: "Kalenderansicht (Wochen-/Tagesplan)",
          viabilityCheck: [
            "Nur praxistauglich, wenn Aufträge eine belastbare Plan-Dauer (Sollzeit) + Ressourcenbezug (Bucht/Techniker) haben.",
            "Ohne verlässliche Dauerangaben wird die Kalenderdarstellung schnell zu einer Scheingenauigkeit und reduziert Transparenz.",
          ],
          strengths: ["Zeitliche Engpässe sichtbar", "Ressourcen-Konflikte visuell erkennbar"],
          risks: ["Scheingenauigkeit bei unsicheren Zeiten", "Viele Kurzaufträge/Unterbrechungen führen zu unübersichtlichen Overlaps"],
          recommendation: "Als zweite Stufe nach Einführung von Sollzeiten/Standardzeiten und klaren Status-/Warte-Zuständen (Teile, Fremdleistung).",
        },
        {
          key: "kanban",
          label: "Werkstatt-Board (Kanban) mit Swimlanes",
          layout: "Swimlanes: kritisch/geblockt, hoch, mittel, niedrig. Spalten: Neu (Pool), Zugewiesen, In Arbeit, Wartet auf Teile, Fertig.",
          strengths: ["Maximale Transparenz über Status & Priorität", "Sehr robust bei unsicheren Dauern", "Einfaches tägliches Standup/Steuerung"],
          risks: ["Zeitliche Kapazitätsplanung nur indirekt"],
          recommendation: "Empfohlen als Start, da es den Pool und Prioritäten am transparentesten abbildet.",
        },
        {
          key: "queue_plus_slots",
          label: "Pool-Liste + Slot-Plan (Ressourcen-Slots)",
          layout: "Links: priorisierte Pool-Liste. Rechts: Slot-Plan pro Bucht/Techniker (z. B. 4 Slots/Tag) ohne Minuten-Granularität.",
          strengths: ["Transparente Priorisierung + realistische Kapazitätsbegrenzung", "Verhindert Überplanung"],
          risks: ["Benötigt Definition von Slots (z. B. kurz/mittel/lang) und konsequentes Pflegen"],
          recommendation: "Sehr praxistauglich als Alternative zum Kalender, wenn Kapazität sichtbar sein muss, aber Zeiten unsicher sind.",
        },
      ],
    });
  }

  if (method === "GET" && url.pathname === "/api/docs/workshop/vehicle-data") {
    return json(res, 200, {
      name: "workshop.vehicle-data.integration",
      source: {
        hostPath: "/opt/ahlert-erp/import/db_export_2026-06-03.csv",
        containerPath: "/import/db_export_2026-06-03.csv",
        expectedHeader: ["tabelle", "pk", "spalte", "wert"],
        delimiter: ";",
      },
      integrationProposals: [
        {
          key: "staging_then_upsert",
          label: "Staging-Import + validierter Upsert in fleet_vehicle",
          steps: [
            "CSV in Staging-Struktur laden (tabelle/pk/spalte/wert) und pro Fahrzeug-PK pivotieren.",
            "Validierung (Pflichtfelder, eindeutige Kennzeichen/VIN, Depots, Capability-Mapping).",
            "Upsert nach fleet_vehicle + optionale Zusatz-Tabellen (Depot/Equipment) mit Audit-Events.",
          ],
        },
        {
          key: "read_only_reference",
          label: "Read-only Referenz + Matching",
          steps: [
            "CSV zunächst unverändert als Referenz halten (nur Analyse/Reporting).",
            "Fahrzeuge im ERP manuell/halbautomatisch in fleet_vehicle anlegen; CSV dient als Abgleichquelle.",
            "Geeignet, wenn Datenqualität im Export zunächst unsicher ist.",
          ],
        },
      ],
      cleansingChecklist: {
        mandatory: [
          "Eindeutiger Primärschlüssel je Fahrzeug (dauerhaft stabil).",
          "Eindeutiges Kennzeichen oder Fahrzeugcode (keine Dubletten, konsistentes Format).",
          "Depot-/Standortcodes konsolidieren (z. B. GREVEN/MUENSTER), keine Mischschreibweisen.",
          "Fahrzeugtyp/Aufbau normalisieren (für Wartungsregeln und Dispo-Matching).",
          "Capability-Mapping definieren (waste/sewage/fuel) und fehlende/fehlerhafte Zuordnungen bereinigen.",
        ],
        recommended: [
          "FIN/VIN (Fahrgestellnummer) erfassen/validieren (Länge/Zeichensatz), Dubletten bereinigen.",
          "Ausstattungsmerkmale strukturieren (z. B. containerSizes, grapplerTypes, ADR).",
          "Historische/ausgemusterte Fahrzeuge kennzeichnen (active=false) statt löschen.",
          "Einheitliche Datumsformate/Zeitzonen für Inbetriebnahme/Prüftermine.",
        ],
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/dashboard/overview") {
    const notifications = await buildNotifications();
    const activeBlocks = await getAvailabilityBlocks({ activeOnly: true });
    const vehicles = await getVehicles();
    const blockedVehicles = activeBlocks.filter((b) => b.lockType === "hard").map((b) => {
      const v = vehicles.find((x) => x.id === b.vehicleId) || null;
      return {
        blockId: b.id,
        vehicleId: b.vehicleId,
        vehicleCode: v ? v.code : b.vehicleId,
        severity: b.severity,
        lockType: b.lockType,
        reason: b.reason,
        sourceModule: b.sourceModule,
        deepLink: blockDeepLink(b),
      };
    });

    return json(res, 200, {
      date: todayIso(),
      modules,
      kpis: {
        waste: { toursPlanned: 12, toursInProgress: 4, stopsOpen: 37 },
        sewage: { jobsPlanned: 6, jobsInProgress: 2, complianceDueSoon: 3 },
        fuel: { deliveriesPlanned: 18, deliveriesInProgress: 5, litersPlanned: 42000 },
        workshop: {
          vehiclesBlocked: blockedVehicles.length,
          criticalDefectsOpen: blockedVehicles.filter((x) => x.severity === "critical").length,
          inspectionsOverdue: 0,
        },
      },
      notifications,
      readiness: { blockedVehicles },
      weather: { status: "placeholder", location: "Greven", updatedAt: new Date().toISOString() },
      traffic: { status: "placeholder", updatedAt: new Date().toISOString() },
    });
  }

  if (method === "GET" && url.pathname === "/api") {
    return text(res, 200, "ok");
  }

  return notFound(res);
});

let hereSchedulerTimer = null;
function startHereTrafficScheduler() {
  if (hereSchedulerTimer) return;
  if (!pool) return;
  if (!hereConfigured()) return;
  const tick = async () => {
    await refreshHereTrafficSnapshots({ day: null });
  };
  tick().catch(() => {});
  hereSchedulerTimer = setInterval(() => tick().catch(() => {}), hereRefreshIntervalMs);
}

async function main() {
  const cmd = String(process.argv[2] || "").trim();
  const envName = String(process.env.NODE_ENV || "").trim().toLowerCase();
  if (envName === "production" && !jwtSecret && !allowInsecureHeaders && !allowStaticTokens) throw new Error("ERP_JWT_SECRET_required_in_production");

  if (cmd === "migrate") {
    const res = await runMigrations({ direction: "up" });
    if (!res.ok) throw new Error(res.error || "migrate_failed");
    console.log(JSON.stringify({ ok: true, applied: res.applied, skipped: res.skipped }, null, 2));
    return;
  }
  if (cmd === "migrate:down") {
    const toId = String(process.argv[3] || "").trim() || null;
    const res = await runMigrations({ direction: "down", toId });
    if (!res.ok) throw new Error(res.error || "migrate_down_failed");
    console.log(JSON.stringify({ ok: true, applied: res.applied }, null, 2));
    return;
  }
  if (cmd === "worker") {
    const mig = await runMigrations({ direction: "up" });
    if (!mig.ok) throw new Error(mig.error || "migrations_failed");
    await ensureBootstrapAdmin();
    const workerId = normalizeString(process.env.ERP_WORKER_ID) || `worker_${process.pid}`;
    let stopped = false;
    process.on("SIGINT", () => {
      stopped = true;
    });
    process.on("SIGTERM", () => {
      stopped = true;
    });
    while (!stopped) {
      const job = await claimNextJob({ workerId });
      if (!job) {
        await new Promise((r) => setTimeout(r, 750));
        continue;
      }
      await runJob({ job });
    }
    return;
  }

  const mig = await runMigrations({ direction: "up" });
  if (!mig.ok) throw new Error(mig.error || "migrations_failed");

  await ensureBootstrapAdmin();

  const seed = String(process.env.ERP_SEED_DATA || "").trim().toLowerCase();
  const doSeed = seed ? seed === "true" : allowInsecureHeaders || envName !== "production";
  if (doSeed) await ensureSeedData();

  server.listen(port, "0.0.0.0", () => {
    console.log(`api listening on :${port}`);
    startHereTrafficScheduler();
    startApprovalEscalationScheduler();
  });
}

const isMain = path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
