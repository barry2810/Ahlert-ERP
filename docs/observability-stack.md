# Observability-Stack (Logs, Metrics, Tracing, Alerts)

## Zielbild
Der Stack liefert eine 360°-Sicht auf den Betrieb:
- **Strukturierte Logs (JSON)** mit konsistenten Feldern (Trace-/Span-IDs, Service, Environment, Error Codes)
- **Metriken (Prometheus)** für Infrastruktur und Applikation inkl. Histogrammen für Latenz
- **Verteiltes Tracing (OpenTelemetry → Tempo)** für End-to-End Analyse
- **Alerting (Prometheus Rules → Alertmanager)** mit reduzierten False-Positives und klaren Handlungsanweisungen

## Komponenten (Docker Compose)
- **Grafana** (UI): Port `3001` (intern `3000`)
- **Prometheus** (TSDB): Port `9090`
- **Alertmanager**: Port `9093`
- **Loki** (Logs): Port `3100`
- **Tempo** (Traces): Port `3200`
- **OpenTelemetry Collector**: OTLP `4317/4318`, Prometheus Exporter `8889`
- **Promtail**: sammelt Container-Logs via Docker Socket und liefert nach Loki
- **node-exporter** + **cAdvisor**: Infrastruktur-/Container-Metriken

Start:
```bash
docker compose up -d --build
```

## Strukturierte Logs
### Logformat (JSON)
Die API loggt Ereignisse als JSON-Line (stdout). Kernfelder:
- `ts` ISO-Zeitstempel
- `level` (`debug|info|warn|error`)
- `event` (z. B. `http_request`, `simulated_error`)
- `service` (z. B. `ahlert-erp-api`)
- `env` (z. B. `local`)
- `traceId`, `spanId` (für Korrelation mit Tempo)
- `requestId` (HTTP Request Correlation)
- `errorCode`, `errorMessage` (bei Fehlern)

Wichtig:
- Es werden **keine Request Bodies** geloggt (Schutz sensibler Daten).
- Trace-/Span-IDs werden zusätzlich als Response-Header `x-trace-id` / `x-span-id` ausgegeben (Debug/Forensik).

### Log-Aggregation
- Promtail liest Docker-Containerlogs und pusht nach Loki.
- Grafana (Explore → Loki) ermöglicht Filterung nach Labels wie `service`, `level`, `event`.

Beispiel-Query:
```logql
{service="ahlert-erp-api"} | json | level="error"
```

## Metriken
### Applikationsmetriken (API)
Prometheus scrapt `http://api:3000/api/metrics`.
Wichtige Serien:
- `ahlert_http_requests_total{method,path,status}`
- `ahlert_http_request_duration_ms_bucket{... ,le}`
- `ahlert_http_request_duration_ms_sum{...}`
- `ahlert_http_request_duration_ms_count{...}`
- `ahlert_erp_events_published_total{event_type}`

### Infrastrukturmetriken
Prometheus scrapt:
- `node-exporter` (Host CPU/RAM/Disk/Netz)
- `cadvisor` (Container CPU/RAM/Netz)

## Verteiltes Tracing (OpenTelemetry)
### Architektur
- Services senden Traces per OTLP HTTP (`OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`) an den Collector.
- Collector exportiert Traces an Tempo.
- Grafana zeigt Traces und verknüpft diese mit Logs.

### Service-Onboarding (neue Services)
Minimalanforderungen:
- OpenTelemetry SDK aktivieren
- OTLP Exporter zum Collector konfigurieren
- Service-Name und Environment setzen

Standard-Umgebungsvariablen:
- `OTEL_ENABLED=true`
- `OTEL_SERVICE_NAME=<service>`
- `DEPLOYMENT_ENVIRONMENT=<env>`
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`

## Alerting
### Alert-Regeln
Prometheus nutzt `observability/prometheus-alerts.yml`. Enthaltene Alerts:
- `ApiDown` (Scrape Down)
- `ApiHighErrorRate` (5xx > 5% über 5 Minuten)
- `ApiHighLatencyP95` (p95 > 1000ms über 5 Minuten)
- Infrastruktur-Indikatoren (RAM/CPU)

### Alertmanager
Standard-Routing ist in `observability/alertmanager.yml` definiert.
- Webhook Receiver (generisch)
- E-Mail Receiver (SMTP Host `smtp:25`, anpassbar)

Empfohlene Erweiterung:
- Chat/Incident Tools über Webhooks (Slack, MS Teams, Opsgenie, PagerDuty)
- Teamzuordnung via Labels `team=<teamname>`

## Praxistest: schwer reproduzierbarer Fehler
### Fehler-Simulation
Endpoint:
`GET /api/observability/simulate?case=flaky&pct=1`
- Default: ca. 1% Fehlerquote (deterministisch über RequestId gehasht)
- Forcieren: `force=1` (immer 500)
- Optional: `sleepMs=<0..30000>`

### Vorgehen zur Analyse (5-Minuten-Playbook)
1. In Grafana → Tempo: Trace über `x-trace-id` (Response Header) oder Zeitfenster suchen.
2. Von Trace zu Logs springen (Traces→Logs Link).
3. Log-Event `simulated_error` und Felder `errorCode`, `requestId`, `traceId` prüfen.
4. In Prometheus: Fehlerrate prüfen (`ahlert_http_requests_total{status=~"5.."}`) und Latenz quantiles.

Automatisierbare Verifikation (Docker Compose):
```bash
docker compose exec -T api env OBS_VERIFY_STACK=true node /app/tests-dispatch.mjs
```
Diese Prüfung stellt sicher:
- TraceID ist vorhanden (Response Header)
- Trace ist in Tempo abrufbar
- Passende Loglines sind in Loki per LogQL (JSON-Filter auf `traceId`) auffindbar
- Prometheus enthält den 5xx-Counter für den Fehler-Endpunkt

## Lasttest (200% Datenvolumen)
Ziel: Der Stack muss eine Erhöhung um **+200% gegenüber den geplanten Betriebswerten** (d. h. **3× geplante Last**) ohne messbare Einbrüche verarbeiten.

Vorgehen (Beispiel):
1. Definiere geplante Last (z. B. `OBS_PLANNED_RPS=20`) und Lasttest-Dauer (z. B. `OBS_LOADTEST_SECONDS=20`).
2. Führe Lasttest gegen `GET /api/healthz` aus (erzeugt Logs + Traces + Metriken pro Request).
3. Prüfe Pass/Fail-Kriterien:
   - Fehlerrate ≤ 1% (HTTP != 2xx)
   - p95-Latenz steigt nicht um mehr als 20% gegenüber der geplanten Last
   - Loki/Tempo/Prometheus bleiben `ready` (keine Restart-Loops / keine 503 Readiness)

Hinweise:
- Für realistische Last empfiehlt sich ein dediziertes Tool (z. B. k6, vegeta, wrk).
- Für Produktionsbetrieb: Persistente Volumes, Retention Policies, AuthN/AuthZ für Grafana und TLS an allen Exposed Ports.

Automatisierbare Ausführung (Docker Compose):
```bash
docker compose exec -T api env OBS_LOADTEST=true OBS_PLANNED_RPS=20 OBS_LOADTEST_SECONDS=20 node /app/tests-dispatch.mjs
```

## Kompatibilität (Technologien & Infrastruktur)
Der Stack basiert auf offenen Standards (OpenTelemetry, Prometheus, Loki/LogQL) und ist dadurch technologieübergreifend integrierbar.

### Programmiersprachen & Laufzeitumgebungen
- **Node.js**: OpenTelemetry SDK/Auto-Instrumentation (bereits im API/Worker umgesetzt)
- **Java/JVM**: OpenTelemetry Java Agent (javaagent), OTLP Export zum Collector
- **.NET**: OpenTelemetry .NET SDK (ASP.NET Core Middleware), OTLP Export
- **Go**: OpenTelemetry Go SDK, OTLP Export
- **Python**: OpenTelemetry Python distro/SDK, OTLP Export

### Cloud/Container
- **Docker/Compose**: Referenzsetup in diesem Repository
- **Kubernetes**: Betrieb über Grafana/Prometheus/Loki/Tempo (Helm) möglich; OTLP bleibt kompatibel
- **AWS/Azure/GCP**: Betrieb on-prem, in VM oder Managed-Kubernetes möglich (OTLP/HTTP oder OTLP/gRPC zum Collector)
