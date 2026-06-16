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

## Lizenz

Aktuell keine Lizenzdatei im Repository. Falls das Projekt oeffentlich weitergegeben werden soll, bitte eine passende Lizenz ergaenzen.

