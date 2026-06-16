## Werkstatt-Modul – Schnittstellen-Audit & Korrekturen (2026-06-03)

### Anlass / Problem
Im Zuge der Einführung des Werkstatt-spezifischen Berechtigungsmodells (`WORKSHOP_CREATE|WORKSHOP_VIEW|WORKSHOP_ASSIGN|WORKSHOP_WORK`) wurden einzelne Werkstatt-Endpunkte weiterhin ausschließlich über `VIEW_AUDIT` abgesichert. Dadurch waren fachlich berechtigte Werkstatt-Nutzer (z. B. Fahrer/Werkstatt) von zentralen Werkstatt-Funktionen ausgeschlossen und Rollout/Interoperabilität des neuen RBAC-Modells war nicht möglich.

### Systematische Identifikation betroffener Schnittstellen
Vorgehen:
- Alle Werkstatt-Endpunkte im API-Router wurden enumeriert (Pfadpräfix `/api/workshop/`).
- Für jeden Endpunkt wurde geprüft, ob er `requirePermission(..., VIEW_AUDIT)` statt `requireAnyPermission(..., WORKSHOP_*)` verwendet.
- Zusätzlich wurde geprüft, ob die veröffentlichte Schnittstellen-Dokumentation (`/api/docs/workshop/vehicle-core`) die aktuellen Permissions korrekt ausweist.

Betroffene Endpunkte (Fehlerbild: unzutreffende Berechtigung / Rollout-Blocker):
- `GET /api/workshop/cases`
  - Fehler: erlaubte nur `VIEW_AUDIT`, statt Werkstatt-Lesezugriff.
  - Risiko: Werkstatt- und Fahrer-Accounts konnten die eigene Auftrags-/Fahrzeughistorie nicht abrufen.
- `GET /api/workshop/vehicles/maintenance/status`
  - Fehler: erlaubte nur `VIEW_AUDIT`, statt Werkstatt-Lesezugriff.
  - Risiko: Werkstatt konnte Fälligkeiten/Status nicht abrufen, obwohl dies Kernfunktion für Planung/Compliance ist.
- `GET /api/docs/workshop/vehicle-core` (Dokumentationsinkonsistenz)
  - Fehler: listete veraltete Permissions (`VIEW_AUDIT`) für die o. g. GET-Endpunkte.
  - Risiko: Client-Integrationen würden falsche Berechtigungen implementieren.

### Umgesetzte Korrekturen
RBAC-Korrektur (fachlich konsistent, rückwärtskompatibel):
- `GET /api/workshop/cases` akzeptiert nun: `WORKSHOP_VIEW` (zusätzlich `WORKSHOP_ADMIN`, `FLEET_ADMIN`, `VIEW_AUDIT`).
- `GET /api/workshop/vehicles/maintenance/status` akzeptiert nun: `WORKSHOP_VIEW` (zusätzlich `WORKSHOP_ADMIN`, `FLEET_ADMIN`, `VIEW_AUDIT`).
- Schnittstellen-Dokumentation aktualisiert: `casesList` und `maintenanceStatus` weisen nun die korrekten Permissions aus.

### Tests / Verifikation
Ausgeführte Regressionstests:
- `docker compose exec -T api node /app/tests-dispatch.mjs`
  - Ergebnis: `GATE_A_ACCEPTANCE_REPORT.result=pass`
  - Ergebnis: `WORKSHOP_ACCEPTANCE_REPORT.result=pass`

Ergänzte Funktionstests im Workshop-Acceptance:
- Zugriff auf `GET /api/workshop/cases`:
  - ohne Permissions → `403`
  - mit `WORKSHOP_VIEW` → `200`
- Zugriff auf `GET /api/workshop/vehicles/maintenance/status`:
  - ohne Permissions → `403`
  - mit `WORKSHOP_VIEW` → `200`

### Ergebnis / Betriebsübernahme
Die korrigierten Werkstatt-Schnittstellen sind mit dem neuen RBAC-Modell konsistent und können ohne Anpassung bestehender Audit-User (`VIEW_AUDIT`) in den Betrieb übernommen werden.
