## Ahlert ERP – Prozess-Workflows & Zustände (Stand: 2026-06-15)

### Geltungsbereich
Dieses Dokument beschreibt die fachlichen Workflows und die dazugehörigen Zustände (State-Machines) für die aktuell serverseitig implementierten Kernprozesse:
- Vehicle Core / Dispatch-Entscheidung (Blocks/Overrides)
- Fleet Inspections (Prüfungen)
- Werkstatt (Aufträge/Fälle, Planung, Lager)
- Import (DB-Export CSV) inkl. Runs/Issues
- Jobs/Worker (asynchrone Verarbeitung)
- Training & Zertifizierung (Katalog, Planung, Prüfungen, Credentials, Attachments-Metadaten)

### Begriffe / Konventionen
- Ein “Zustand” ist ein gespeicherter Wert (z. B. `status`, `work_state`) oder eine abgeleitete Lage (z. B. “Block aktiv”, wenn `ends_at` leer/erst in der Zukunft ist).
- “Audit/Events” sind Append-only (immutable) Tabellen, die Zustandswechsel nachvollziehbar machen.

---

## 1) Vehicle Core – Dispatch-Entscheidung & Sperren

### 1.1 Verfügbarkeits-Sperre (`fleet_availability_block`)
**Zweck:** Sperrt Fahrzeuge (soft/hard) für Dispatch-Module, wenn ein Risiko/Problem vorliegt (z. B. Werkstatt “kritisch/geblockt”).

**Felder/Dimensionen:**
- `severity`: fachliche Einstufung (z. B. `critical`, `warning`, `info`)
- `lock_type`: `soft` | `hard`
- “Aktiv” (abgeleitet): `starts_at <= now()` und (`ends_at is null` oder `ends_at > now()`)

**Erzeugung / Quellen (Beispiele):**
- Werkstatt kann bei “Hard-Block” (kritisch) Sperren für das Fahrzeug erzeugen (`source_module='workshop'`).

### 1.2 Dispatch Override (`fleet_dispatch_override`)
**Zweck:** Erzwingt pro Fahrzeug + Modul + Zeitfenster eine Entscheidung unabhängig von Sperren.

**Zustände:**
- `decision`: `allow` | `deny`
- “Aktiv” (abgeleitet): wenn `expires_at` leer ist oder `expires_at > now()`

### 1.3 Dispatch-Entscheidung (fachlicher Ablauf)
**Workflow (vereinfacht):**
- Eingang: `vehicleId`, `module`, Zeitfenster (`window_start`, `window_end`)
- Prüfen auf aktive Overrides → überschreiben Basisergebnis
- Prüfen auf aktive Blocks → beeinflussen Basisergebnis (Hard-Blocks führen typischerweise zu `deny`)

---

## 2) Fleet Inspections (Prüfungen)

### 2.1 Prüfung (`fleet_inspection`)
**Zustände:**
- `status`: `scheduled` | `completed`

**Übergänge (typisch):**
- `scheduled` → `completed` (bei Eintrag von `completed_at`, `completed_by`, optional `report_pdf`)

---

## 3) Werkstatt – Aufträge/Fälle (`workshop_case`)

### 3.1 Zustandsmodell
**Zustandsdimensionen (parallel):**
- `status`: `open` | `closed`
- `work_state`: `created` | `assigned` | `in_progress` | `waiting_parts` | `done`
- `priority`: `low` | `medium` | `high`
- `severity`: `critical` | `warning` | `info`
- `lock_type`: `soft` | `hard`
- Flags: `interrupted` (true/false), `delivery_delay` (true/false)

**Interpretation (bewährte Konvention):**
- `status=open` + `work_state=done` bedeutet “fachlich erledigt, aber noch nicht geschlossen” (z. B. Abnahme/Signatur fehlt).
- `status=closed` bedeutet “Fall abgeschlossen”; `closed_at`/`closed_reason` sind gesetzt.

### 3.2 Workflow: Auftrag anlegen → bearbeiten → abschließen
**Erstellen**
- `POST /api/workshop/cases` (Alias: `POST /api/workshop/orders`)
- Ergebnis: `status=open`, `work_state=created`

**Zuordnen**
- `POST /api/workshop/orders/assign`
- Ergebnis: setzt `assigned_to`, `assigned_at` und typischerweise `work_state=assigned`

**Bearbeiten / Statusfortschritt**
- `POST /api/workshop/orders/status`
- Erlaubte `work_state` Werte: `created|assigned|in_progress|waiting_parts|done`
- Setzt optional: `interrupted`, `deliveryDelay`

**Schließen**
- `POST /api/workshop/cases/close`
- Ergebnis: `status=closed`, `closed_at` gesetzt, optional `closed_reason`

### 3.3 Ereignis-/Auditspur (Append-only)
- `workshop_case_event`: dokumentiert Zustandswechsel und Gründe (`reason`), inkl. Meta.
- `workshop_case_message`: Kommunikation/Notizen zum Fall.
- `workshop_case_approval`: Freigabeprozess
  - `status`: `requested` | `decided`
  - `decision`: `approved` | `rejected` (optional, wenn `decided`)
- `workshop_case_signature`: Signaturen zum Auftrag (Append-only).

### 3.4 Freigabe-Workflows (ERP, moduluebergreifend)
- Kritische Aktionen (Preis, Rechnung, Routen-Override, Stammdaten) werden ueber einen zentralen Freigabeprozess abgewickelt:
  - `erp_approval_request` (Antrag)
  - `erp_approval_step` (mehrstufige Freigabe)
  - `erp_approval_audit` (Auditspur)
- Details, Rollen/Permissions, Eskalation und API: siehe `docs/freigabe-workflows.md`

---

## 4) Werkstatt – Planung / Slotplan (`workshop_slot_plan`)

### 4.1 Modell
**Zweck:** Tagesbasierter Plan je Bearbeiter und Slot.

**Schlüssel:**
- `day`, `slot_index`, `assignee` sind eindeutig.

**“Zustand” (abgeleitet):**
- Slot “frei”, wenn `case_id` leer ist.
- Slot “belegt”, wenn `case_id` gesetzt ist.

### 4.2 Workflow (typisch)
- Auftrag existiert (`workshop_case`)
- Planung setzt/ändert Slot-Zuordnung (`case_id` in `workshop_slot_plan`)
- Änderungen sind nachvollziehbar über `updated_by`/`updated_at`

---

## 5) Werkstatt – Lager / Bestände / Bewegungen

### 5.1 Bewegungen (`workshop_inventory_movement`)
**Zustände (Movement Types):**
- `movement_type`: `inbound` | `putaway` | `pickup` | `issue` | `transfer` | `adjust`

**Wirkung (typisch):**
- `inbound`: Wareneingang ins System (Ziel-Lagerort)
- `putaway`: Einlagerung/Umplatzierung (Ziel-Lagerort)
- `pickup`: Entnahme aus Lagerort (Quelle-Lagerort)
- `issue`: Ausgabe an Fahrzeug (`unit_id`) oder Auftrag (`case_id`)
- `transfer`: Umlagerung Quelle → Ziel
- `adjust`: Bestandskorrektur

**Identifikatoren:**
- `identifiers` (json): z. B. Batch-/Seriennummern; Suche/Auswertung erfolgt über GIN-Index.

### 5.2 Workflows (typisch)
- Stammdaten anlegen (Supplier/Location/Item)
- Bestand wird über Bewegungen fortgeschrieben
- Ausgabe an Auftrag verbindet Lager mit Werkstattprozess (`case_id`)

---

## 6) Import – DB-Export CSV (Runs/Issues)

### 6.1 Import Run (`import_run`) – immutable
**Zweck:** Protokolliert Validierung/Import als abgeschlossene Läufe.

**Wichtige Felder:**
- `kind`: aktuell genutzt: `db_export`
- `source_path`: z. B. `/import/db_export_2026-06-03.csv`
- `status`: Status des Laufs (string, ohne DB-Constraint)

**Beobachtete Statuswerte (aktuelle Implementierung):**
- `validate_failed` (z. B. Datei nicht lesbar / Pivot-Fehler)
- `validated_ok`
- `validated_failed`
- `dry_run_ok`
- `import_ok`

**Issues (`import_issue`)**
- `severity`: typischerweise `error` | `warning` | `info`
- Bezug über `run_id`

### 6.2 Workflow: Validierung
- `POST /api/workshop/admin/import/db-export/validate-file`
- Ergebnis:
  - ok → `status=validated_ok`
  - Fehler/Issues → `status=validated_failed` oder `validate_failed`

### 6.3 Workflow: Import
- `POST /api/workshop/admin/import/db-export/import-file`
  - `sync=true` oder Body `{ "sync": true }`: synchroner Import (Antwort enthält `runId`)
  - Default: asynchron via Job (Antwort `202` mit `jobId`)
- Ergebnis (Run):
  - Dry Run → `status=dry_run_ok`
  - Import → `status=import_ok`

### 6.4 Run-Abfrage
- `GET /api/workshop/admin/import/runs?kind=db_export`
- `GET /api/workshop/admin/import/run?id=<runId>` (inkl. Issues)

---

## 7) Jobs & Worker (asynchrone Verarbeitung)

### 7.1 Job (`job`)
**Zustände:**
- `status`: `queued` | `running` | `succeeded` | `failed` | `cancelled`

**Wichtige Felder:**
- `type`: z. B. `import_db_export`
- `progress` / `total`: Fortschritt (0–100 Standard)
- `error`: Fehlertext bei `failed`
- Locking: `locked_at`, `locked_by` (Worker-Claim)

### 7.2 Job-Logs (`job_log`)
**Zustände:**
- `level`: `info` | `warning` | `error`

### 7.3 Workflow (typisch)
- Request erzeugt Job (`status=queued`)
- Worker claimed Job (`status=running`)
- Worker schreibt Logs/Progress
- Abschluss: `succeeded` oder `failed` (optional `cancelled`)

---

## 8) Training & Zertifizierung

### 8.1 Katalog
**Qualification (`training_qualification`)**
- “Zustand”: `active` (true/false)
- Klassifikation:
  - `category`: `safety` | `technical` | `compliance` | `other`
  - `issuer_type`: `internal` | `external`
- Sensitivität: `sensitive` (true/false) steuert Zugriff auf geschützte Inhalte.

**Course (`training_course`)**
- “Zustand”: `active` (true/false)
- `delivery_mode`: `in_person` | `online` | `blended`
- Optionaler Link zur Qualification: `qualification_id`

### 8.2 Planung
**Session (`training_session`)**
- `status`: `scheduled` | `completed` | `cancelled`

**Session Participant (`training_session_participant`)**
- `status`: `assigned` | `attended` | `no_show` | `passed` | `failed` | `cancelled`

**Workflow (typisch):**
- Session anlegen (`scheduled`)
- Teilnehmer zuweisen (`assigned`)
- Ergebnis markieren (`attended/no_show/passed/failed/cancelled`)
- Session abschließen (`completed`)
  - Bei `passed` Teilnehmern werden Credentials erzeugt, wenn der Course an eine Qualification gekoppelt ist.

### 8.3 Prüfungen
**Exam Plan (`training_exam_plan`)**
- `status`: `planned` | `booked` | `completed` | `cancelled`

### 8.4 Credentials
**Credential (`training_credential`)**
- `source`: `course` | `manual` | `import` | `external`
- `status`: `valid` | `expired` | `revoked` | `suspended`

**Credential Events (`training_credential_event`) – immutable**
- `event_type`: `issued` | `renewed` | `expired` | `revoked` | `suspended` | `note_changed` | `attachment_added`

### 8.5 Attachments (nur Metadaten)
**Attachment (`training_attachment`)**
- `owner_type`: `credential` | `session` | `exam_plan`
- `storage_provider`: `db_legacy` | `s3` | `minio` | `filesystem`
- Hinweis: Aktuell werden nur Metadaten erfasst; Dateiablage/Signierung ist ein separater Ausbauschritt.

### 8.6 Relevante APIs (Auszug)
- Katalog:
  - `GET|POST /api/training/qualifications`
  - `GET|POST /api/training/courses`
- Planung:
  - `GET|POST /api/training/sessions`
  - `POST /api/training/sessions/participants/assign`
  - `POST /api/training/sessions/participants/mark`
  - `POST /api/training/sessions/complete`
- Credentials/Exams:
  - `GET /api/training/credentials`
  - `POST /api/training/credentials`
  - `POST /api/training/credentials/status`
  - `GET /api/training/credentials/events`
  - `GET|POST /api/training/exams`
- Self:
  - `GET /api/training/me/overview`
- Attachments:
  - `POST /api/training/attachments`

---

## 9) Disposition – Entsorgung (Orders, Routen, Municipal)

### 9.1 Aufträge (`waste_container_order`)
**Zweck:** Entsorgungsauftrag als zentrale Prozess-Entität (Disposition → Wiegen → Billing).

**Wichtige Stammdaten-Verknüpfungen:**
- Kunde: `customer_ref_id` → `crm_customer.id` (optional)
- Vertrag: `contract_id` → `crm_contract.id` (optional)
- Kommune: `municipality_id` → `waste_municipality.id` (optional)
- Entsorgungsstandort: `disposal_site_id` → `waste_disposal_site.id` (optional)
- Material: `material_code` (fachlicher Code, Lookup über `item_material.code`)

**Statusmodell (vereinfacht):**
- `created` → `validated` → `dispatch_checked` → `scheduled` → `delivered` → `pickup_requested` → `picked_up` → `weighed` → `invoiced`

**Events (immutable):**
- `waste_container_order_event`: Statuswechsel inkl. Meta

### 9.2 Routen (`waste_route`, `waste_route_stop`)
**Zweck:** Tour/Route zur Vermeidung redundanter Fahrten und Koordinierung der Stops.

**Integritätsregeln:**
- `waste_route_stop.unique(order_id)` verhindert, dass ein Auftrag mehrfach in Routen auftaucht.

**Relevante APIs (Auszug):**
- `POST /api/waste/routes/plan`
- `POST /api/waste/routes/reoptimize`
- `GET /api/waste/routes`
- `GET /api/waste/route?id=<routeId>`

---

## 10) Billing/Invoices (Entsorgung)

### 10.1 Invoice Draft (`waste_invoice_draft`) – immutable
**Zweck:** Revisionssicherer Rechnungsentwurf auf Basis eines Pricing-Snapshots.

**Stammdaten-Verknüpfungen:**
- `pricing_calculation_id` → `pricing_calculation.id`
- `customer_id` → `crm_customer.id`
- `contract_id` → `crm_contract.id`

**Relevante APIs (Auszug):**
- `POST /api/billing/waste/invoice-drafts` (aus Pricing-Snapshot)
- `GET /api/billing/waste/invoice-drafts?orderId=<orderId>` (Liste)
- `GET /api/billing/waste/invoice-drafts?id=<invoiceDraftId>` (Detail)

---

## 11) Modul-Events (Cross-Module Kommunikation)

### 11.1 ERP Event Outbox (`erp_event`)
**Zweck:** Persistente, konsumierbare Events zur Kopplung von Modulen (z. B. Disposition → Billing/Reporting/Mobile).

**Kerneigenschaften:**
- Append-only, chronologisch konsumierbar über `(occurred_at, id)`
- Filterbar nach `event_type`, `aggregate_type`, `aggregate_id`
- Verbindlicher technischer Standard für modulübergreifende Kommunikation
- Direkte Modul-zu-Modul-Aufrufe sind für fachliche Kopplung nicht vorgesehen; konsumierbare Zustandsänderungen müssen als `erp_event` publiziert werden

**Verbindliches Event-Envelope (v1):**
- `id`: technische Event-ID (`evt_...`)
- `schema_version`: aktuell `1`
- `event_type`: fachlicher Eventname in `UPPER_SNAKE_CASE`, z. B. `WASTE_ORDER_CREATED`
- `aggregate_type`: fachlicher Entitätstyp in `lower_snake_case`, z. B. `waste_order`
- `aggregate_id`: ID der betroffenen Entität
- `source_module`: erzeugendes Modul, z. B. `waste`, `billing`, `import`, `training`
- `occurred_at`: fachlicher Ereigniszeitpunkt
- `created_by`: Benutzer/System
- `correlation_id`: Request-/Prozess-Korrelation über mehrere Events
- `causation_id`: auslösendes Vorereignis
- `trace_id`: technische Tracing-ID für verteilte Nachverfolgung
- `partition_key`: Schlüssel für geordnete Consumer-Verarbeitung (typisch `aggregate_id`)
- `headers`: zusätzliche transportnahe Metadaten
- `payload`: fachliche Nutzdaten

**Namensregeln:**
- `event_type`: Vergangenheit, fachlich eindeutig, keine UI-Begriffe
- `payload`: nur fachliche Daten, keine transiente Darstellung/HTML
- `aggregate_id` muss immer auf eine bestehende Entität zeigen

**Standardisierte Erzeugung:**
- Server-intern über `publishErpEvent(...)`
- Für ältere Live-UI-Events wird `publishEvent(...)` nur noch als SSE-Projektion genutzt; die Funktion spiegelt die Ereignisse zusätzlich in das Standard-Eventsystem

**Beispiele für fachliche Standard-Events:**
- Disposition: `WASTE_ORDER_CREATED`, `WASTE_ORDER_STATUS_CHANGED`, `DISPATCH_ASSIGNMENT_CREATED`, `WASTE_ROUTE_PLANNED`
- Pricing/Billing: `PRICING_CALCULATED`, `WASTE_INVOICE_DRAFT_CREATED`
- Import: `IMPORT_RUN_RECORDED`, `RECONCILE_RUN_CREATED`

### 11.2 Consumer Offsets (`erp_event_consumer_offset`)
**Zweck:** Tracking, bis zu welchem Event ein Consumer verarbeitet hat.

**Verhalten:**
- Jeder Consumer (`billing`, `reporting`, `mobile`, spätere Module) hält seinen Offset separat
- Ein fehlgeschlagener Consumer blockiert keine anderen Consumer
- Acknowledgement verschiebt nur den Offset des bestätigenden Consumers

### 11.3 Zustell- und Fehlerprotokoll (`erp_event_delivery`)
**Zweck:** Nachvollziehbarkeit, ob ein Consumer ein Event erfolgreich verarbeitet oder mit Fehler quittiert hat.

**Statuswerte:**
- `delivered`: erfolgreich verarbeitet und bestätigt
- `failed`: Verarbeitung fehlgeschlagen, Offset bleibt unverändert
- `ignored`: bewusst verworfen, aber protokolliert

**Retry-/Fehlerregeln:**
- Jeder Zustellversuch wird mit `attempt_no` protokolliert
- Fehler werden über `error_code` und `error_message` nachvollziehbar gespeichert
- Ein erneuter Consumer-Lauf beginnt am letzten bestätigten Offset

**Relevante APIs (Auszug):**
- `GET /api/events?afterId=<eventId>&types=<csv>&aggregateType=<t>&aggregateId=<id>&limit=<n>`
- `GET /api/events/schema`
- `GET /api/events/consume?consumer=<name>&afterId=<eventId>&types=<csv>&aggregateType=<t>&aggregateId=<id>&limit=<n>`
- `GET /api/events/offset?consumer=<name>`
- `POST /api/events/ack` Body `{ "consumer": "...", "lastEventId": "evt_..." }`
- `POST /api/events/fail` Body `{ "consumer": "...", "eventId": "evt_...", "errorCode": "...", "errorMessage": "..." }`
- `GET /api/events/deliveries?consumer=<name>&eventId=<id>&limit=<n>`

### 11.4 Consumer-Standard für alle Module
**Polling/Empfang:**
- Consumer liest mit `GET /api/events/consume?consumer=<modul>`
- Wenn kein `afterId` angegeben ist, wird automatisch ab dem zuletzt bestätigten Offset gelesen

**Erfolgspfad:**
1. Consumer liest neue Events
2. Consumer verarbeitet fachlich
3. Consumer bestätigt mit `POST /api/events/ack`

**Fehlerpfad:**
1. Consumer liest Event
2. Verarbeitung schlägt fehl
3. Consumer meldet Fehler via `POST /api/events/fail`
4. Event bleibt für denselben Consumer erneut zustellbar

### 11.5 Nachweis der Entkopplung
- Billing, Reporting und Mobile konsumieren denselben Eventstrom unabhängig voneinander
- Jeder Consumer besitzt eigenen Offset und eigenes Fehlerprotokoll
- Ein Fehler in Billing verändert weder Offset noch Verarbeitung von Reporting oder Mobile

---

## 12) Reporting & Exporte (Disposition/Billing)

### 12.1 Dispo-Reporting
- `GET /api/reports/disposition/summary?from=<iso>&to=<iso>&depotCode=<code>&format=json|csv`

### 12.2 Exporte (CSV/JSON)
- `GET /api/exports/waste/orders?from=<iso>&to=<iso>&format=csv|json`
- `GET /api/exports/waste/routes?day=YYYY-MM-DD&format=csv|json`
- `GET /api/exports/waste/invoices?from=<iso>&to=<iso>&format=csv|json`

---

## 13) API-Versionierung, OpenAPI und Swagger

### 13.1 Verbindliches Versionsschema
**Zweck:** Abwaertskompatible Weiterentwicklung aller Kernschnittstellen mit paralleler Unterstuetzung mehrerer API-Versionen.

**Regeln:**
- Aktive Versionen werden semantisch versioniert (`1.0.0`, `2.0.0`)
- Transportpfade werden stabil ueber Major-Versionen exponiert:
  - `v1` unter `/api/v1/...`
  - `v2` unter `/api/v2/...`
- Die unversionierte Form `/api/...` bleibt nur als Legacy-Alias erhalten und ist veraltet

**Deprecation-Verhalten:**
- Veraltete Versionen liefern HTTP-Header `Deprecation`, `Sunset` und `Link`
- Aktuell gilt:
  - `/api/v1/...` = deprecated
  - `/api/...` = deprecated Legacy-Alias
  - `/api/v2/...` = aktive Version

### 13.2 OpenAPI 3.1 Spezifikationen
**Bereitstellung:**
- `GET /api/docs/openapi/v1.json`
- `GET /api/docs/openapi/v2.json`
- `GET /api/v1/docs/openapi.json`
- `GET /api/v2/docs/openapi.json`

**Inhalt:**
- Endpunkte der Kernschnittstellen
- Query-Parameter, Bodies, Antwortformate
- Authentifizierungs-/Berechtigungsschema
- Fehlerantworten
- Deprecation-Kennzeichnung auf Operationsebene

### 13.3 Swagger UI
**Interaktive Dokumentation:**
- `GET /swagger.html?version=v2`
- Alternativ Redirect ueber `GET /api/docs/swagger`

**Verhalten:**
- Version per Auswahl `v1` / `v2`
- Spezifikationen werden direkt aus den aktuellen OpenAPI-Endpunkten geladen

### 13.4 Validierung und Synchronitaet
**Runtime-Validierung:**
- `GET /api/docs/validate`
- `GET /api/docs/metrics`

**CI/CD-Validierung:**
- GitHub Actions Workflow: `.github/workflows/openapi.yml`
- Build/Validierung ueber:
  - `npm run openapi:build`
  - `npm run openapi:validate`

**Automatisch erzeugte Artefakte:**
- `site/openapi/v1.json`
- `site/openapi/v2.json`
- `site/openapi/metrics.json`

### 13.5 Erfolgsmetriken zur Reduzierung von Integrationsrisiken
**Messgroessen:**
- Anzahl dokumentierter Kernrouten
- Dokumentationsabdeckung gegen implementierte Kernrouten
- Anzahl parallel unterstuetzter Versionen
- Anzahl offiziell veralteter Versionen mit Sunset-Hinweisen

**Zielwirkung:**
- planbare externe Integrationen durch stabile Major-Versionen
- geringeres Breaking-Change-Risiko durch parallelen Versionsbetrieb
- schnellere Fehlersuche durch klare Spezifikationen und Swagger-Testbarkeit
