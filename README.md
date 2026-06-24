# Ahlert-ERP

Dieses Repository enthaelt ein ERP-System (Schwerpunkt: Entsorgung/Disposition) mit versionierter API, OpenAPI/Swagger-Dokumentation und einem eventgetriebenen Integrationsstandard (ERP-Event-Outbox).

## Ziel

- Zentrale Stammdaten und Prozesse fuer Entsorgung/Disposition, Billing/Invoices, Reporting/Exports und Importlaeufe.
- Nachvollziehbare, auditierbare Preisberechnung (Snapshotting) und saubere Verknuepfungen Customer/Contract/Pricing.
- Entkoppelte Modul-Integration ueber einen einheitlichen Event-Standard (Outbox + Consumer Offsets + Delivery/Failure Tracking).
- Versionierte HTTP-API mit OpenAPI 3.1 und Swagger UI.

## Tech-Stack (Kurz)

- Node.js (ESM) API: [apps/api](apps/api)
- PostgreSQL 16 (Docker)
- Redis 7 (Docker)
- Caddy 2 als Reverse Proxy + Static Site Serving: [Caddyfile](Caddyfile)
- Docker Compose: [docker-compose.yml](docker-compose.yml)

## Schnellstart (lokal via Docker)

1. `.env` anlegen (wird nicht eingecheckt) mit mindestens:
   - `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
   - `REDIS_PASSWORD`
   - `PUBLIC_BASE_URL` (z.B. `http://localhost`)

2. Services starten:

```bash
docker compose up -d postgres redis api worker caddy
```

3. Aufrufen:

- Web/Static: http://localhost/
- API: http://localhost/api/
- Swagger UI: http://localhost/api/docs/swagger
- OpenAPI JSON:
  - http://localhost/api/docs/openapi/v2.json
  - http://localhost/api/docs/openapi/v1.json

## API-Versionierung

- `/api/v2/...` ist die aktive Version.
- `/api/v1/...` ist deprecated (Deprecation-/Sunset-Hinweise werden als Header ausgegeben).
- `/api/...` ist ein Legacy-Alias (deprecated).

## Event-System (ERP-Event-Outbox)

Das Repo implementiert einen verbindlichen Event-Standard zur Modul-Entkopplung:

- Append-only Event-Tabelle (Outbox)
- Consumer Offsets (pro Consumer)
- Delivery/Failure Tracking (pro Consumer + Event)
- APIs fuer Event-Listen, Consume, Ack/Fail, Offsets und Delivery-Historie

Dokumentation: [docs/prozess-workflows-und-zustaende.md](docs/prozess-workflows-und-zustaende.md)

## CI / OpenAPI

Der OpenAPI-Workflow validiert, dass Implementierung und Spezifikation konsistent sind.

- Workflow: [.github/workflows/openapi.yml](.github/workflows/openapi.yml)
- Lokal (ohne GitHub): `act` ist optional, siehe [docs/git-und-cicd-einrichtung.md](docs/git-und-cicd-einrichtung.md)

## Repository-Struktur

- `apps/api/` – API-Server, Migrations, OpenAPI-Spec-Generator, Tests
- `site/` – statische Auslieferung (inkl. Swagger UI)
- `docs/` – technische und Prozess-Dokumentation
- `docker-compose.yml` – lokale Laufzeit (Postgres/Redis/API/Worker/Caddy)

## Sicherheit

- Keine Secrets einchecken (`.env` ist ignoriert).
- Laufzeitdaten (`postgres-data/`, `redis-data/`, `caddy-data/`) sind ignoriert.
- Branch Protection erzwingt PR-only und Required Check `openapi` auf `main`.

## Backup, Restore & Disaster Recovery (Go-Live)

### Ziele (operativ)

- **RPO (Recovery Point Objective)**: maximaler Datenverlust im Worst Case (Empfehlung: **≤ 15 Minuten**).
- **RTO (Recovery Time Objective)**: maximale Wiederanlaufzeit bis “Service wieder nutzbar” (Empfehlung: **≤ 60 Minuten**).
- **Prinzip**: Backups muessen **automatisiert**, **verschluesselt**, **versioniert** und **regelmaessig rueckgesichert** werden.

### Scope (was muss gesichert werden)

- **PostgreSQL** (kritisch, System of Record)
  - Alle Fach- und Audit-Daten, Outbox-Events, Importlaeufe, Job-Queue, Rollen/Rechte.
- **Redis** (abhängig vom Einsatz)
  - Wenn nur Cache: Restore ist “best effort” (kann leer starten).
  - Wenn Sessions/Locks: als “wiederherstellbar” planen oder bewusst stateless betreiben.
- **Datei-/Blob-Daten** (falls in Volumes/Object Storage)
  - Z. B. Uploads/Exports/Import-Artefakte, falls nicht in Postgres gespeichert.
- **Konfiguration & Secrets**
  - `docker-compose.yml`, `Caddyfile`, `observability/*` (liegen im Repo und sind versioniert).
  - Laufzeit-Secrets (`.env`, Zertifikate, Token) muessen separat gesichert werden (z. B. Secret Manager/Vault).
- **Observability-Daten** (Prometheus/Loki/Tempo/Grafana)
  - Fuer Wiederanlauf hilfreich, aber typischerweise **nicht Go-Live-kritisch**. Retention/Restore kann reduziert oder “rebuildable” geplant werden.

### Backup-Strategie (Empfehlung)

- **Postgres (Pflicht)**
  - **Taeglicher Full-Backup** (logical oder physical) + **PITR** (WAL-Archiving) fuer RPO ≤ 15 Min.
  - Aufbewahrung: z. B. **30 Tage** taeglich, **12 Monate** monatlich (je nach Compliance anpassen).
  - Ablage: **Offsite** (zweites Rechenzentrum/Cloud) + optional **immutable** (WORM/Object-Lock).
  - Verschluesselung: AES-256 at rest + Transport TLS; Schluesselverwaltung getrennt (KMS/Vault).
- **Redis (optional)**
  - Wenn stateful benoetigt: Snapshot/Append-Only-File in Intervallen + Offsite Kopie.
  - Wenn Cache-only: kein Backup, stattdessen “cold start” akzeptieren.
- **Volumes (optional, je nach Nutzung)**
  - Regel: Alles, was nicht aus Postgres/Repo reproduzierbar ist, bekommt ein Backup.

### Minimaler “Local/Small Ops” Ansatz (Docker Compose)

- Postgres Dump (logical):
  - `docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > backup/postgres_$(date +%F).dump`
- Restore:
  - `cat backup/postgres_YYYY-MM-DD.dump | docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists`

Hinweis: Fuer Go-Live wird PITR (WAL) empfohlen; reine `pg_dump`-Backups sind oft zu grob fuer RPO ≤ 15 Minuten.

### Restore Runbook (Pflicht, regelmaessig testen)

1. **Incident klassifizieren**: Datenfehler vs. Total-Ausfall vs. Security Incident.
2. **Schreibzugriffe stoppen**: API/Worker skalieren auf 0 bzw. stoppen (keine neuen Writes).
3. **Postgres wiederherstellen**
   - Restore des letzten Full Backups.
   - PITR bis zum Zielzeitpunkt (falls WAL-Archiving aktiv).
4. **Applikation starten**
   - API/Worker starten.
   - Healthchecks: `/api/healthz`, Kern-Endpunkte, DB-Connectivity.
5. **Integritaetschecks**
   - Stichproben: letzte Auftraege/Rechnungen/Imports, Job-Queue, Event-Outbox.
6. **Freigabe & Monitoring**
   - Alerts beobachten, Error-Rate/Latency pruefen, Logs/Traces stichprobenartig.

### Disaster-Recovery-Szenarien (zwingend definieren)

- **DB-Korruption / Operator Error**: PITR auf Zeitpunkt vor dem Fehler.
- **Host/Volume-Ausfall**: Restore auf neue Infrastruktur (IaC/Compose/K8s) + DNS/Ingress Umschalten.
- **Ransomware**: Restore aus immutable/offsite Backup, Rotation aller Secrets, forensische Analyse.

### DR-Tests (Go-Live Voraussetzung)

- **Monatlich**: Restore-Test in Staging (Full Backup).
- **Quartalsweise**: PITR-Test (Wiederherstellung auf definierten Zeitpunkt).
- **Nach jeder grossen Aenderung** (Schema/Import/Reporting): gezielter Restore-Smoketest.

## Lizenz

Aktuell keine Lizenzdatei im Repository. Falls das Projekt oeffentlich weitergegeben werden soll, bitte eine passende Lizenz ergaenzen.
