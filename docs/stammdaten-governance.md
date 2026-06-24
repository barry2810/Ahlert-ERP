# Stammdaten-Governance (MDM) – Dublettenprüfung & Golden Records

## Ziel
Dieses Modul stellt eine zentrale Stammdaten-Governance für die kritischen Bereiche **Kunden**, **Standorte**, **Artikel**, **Materialien** und **Verträge** bereit.

Kernziele:
- Dubletten zuverlässig erkennen (auch bei unvollständigen/fehlerhaften Daten)
- Golden Records als autoritative Datensätze erzeugen und bereitstellen
- Kontinuierliche Datenqualitätsüberwachung mit Benachrichtigung und Nachverfolgbarkeit
- Zugriffskontrollen und Audit-Trail für alle Governance-Aktionen
- Integrationsfähigkeit über ERP-Events (Outbox) und API-Endpunkte

## Abgedeckte Entitäten
Die Governance arbeitet systemweit auf folgenden Tabellen/Quellen:
- Kunden: `crm_customer`
- Verträge: `crm_contract`
- Materialien: `item_material`
- Artikel/Leistungen: `item_service`
- Standorte: `waste_municipality` und `waste_disposal_site`

## Datenmodell (DB)
MDM-spezifische Tabellen:
- `mdm_match_candidate`: Dubletten-Kandidaten (Score + Signals + Status)
- `mdm_golden_record`: Golden Records (Payload + Quelle(n) + Version)
- `mdm_entity_map`: Zuordnung SourceRef → Golden Record
- `mdm_quality_issue`: Datenqualitätsprobleme (Severity + Status)
- `mdm_model`: Lightweight-Score-Modell (Gewichte/Bias/Threshold)
- `mdm_audit`: Audit-Trail für Entscheidungen, Merges, Modell-Labels

Eine **SourceRef** identifiziert Quelldatensätze eindeutig: `<table>:<id>` (z. B. `crm_customer:cus_123`).

## Dublettenprüfung (mehrdimensional)
Die Erkennung kombiniert mehrere Signalarten:
- Regelbasiert: exakte Übereinstimmungen (z. B. VAT, E-Mail, Code)
- Ähnlichkeitsmetriken: String-Ähnlichkeit (Levenshtein-basiertes Ratio)
- Phonetische Übereinstimmung: Soundex-basierter Vergleich (Namen/Bezeichnungen)
- KI/Modell-basiert: gewichtete Feature-Kombination (Logistic Score), trainierbar via Labeling

### Blocking (Performance)
Für Skalierbarkeit wird ein Blocking-Ansatz genutzt: Kandidatenpaare werden nur innerhalb gemeinsamer Block-Keys verglichen (z. B. gleiche E-Mail, VAT, phonetischer Name).

## Golden Record Prozess
Ein Golden Record entsteht aus mindestens zwei validierten Quell-Datensätzen:
- Erzeugung/Update: `/api/mdm/golden/merge`
- Auswahlregeln: Feldweise Priorisierung nach **Vollständigkeit**, **Aktivität** und **Aktualität**
- Versionierung: jede Änderung erhöht `mdm_golden_record.version`

Der Golden Record wird über `mdm_entity_map` für nachgelagerte Systeme als **single source of truth** referenzierbar.

## Datenqualitätsüberwachung (kontinuierlich)
Das System führt regelmäßig:
- Qualitätschecks (z. B. fehlender Name, ungültige E-Mail/Telefonnummer, ungültiger Zeitraum)
- Dublettenscans (kandidatenbasiert)

Bei neuen Issues:
- Persistenz: `mdm_quality_issue`
- Benachrichtigung: ERP-Outbox-Event `EMAIL_NOTIFICATION_REQUESTED` (Template `mdm_quality_issue`)
- In-App: Topic `mdm` (Event `MDM_QUALITY_ISSUE_DETECTED`)

## Zugriffskontrolle (RBAC)
Relevante Berechtigungen:
- `MDM_VIEW`: Lesen von Kandidaten/Issues/Golden Records
- `MDM_MANAGE`: Entscheiden von Kandidaten, Merges, Issue-Resolution
- `MDM_LABEL`: Labeling/Training des Modells
- `MDM_ADMIN`: Admin-Rechte (umfasst Manage/Label)

Bootstrap-Rollen (Standardrollen):
- `mdm_viewer` → `MDM_VIEW`
- `mdm_steward` → `MDM_VIEW`, `MDM_MANAGE`, `MDM_LABEL`, `APPROVAL_APPROVE_MASTERDATA`
- `mdm_admin` → `MDM_ADMIN`, `MDM_VIEW`, `MDM_MANAGE`, `MDM_LABEL`, `APPROVAL_APPROVE_MASTERDATA`

## Audit & Nachvollziehbarkeit
Jede wesentliche Governance-Aktion wird protokolliert:
- DB-Audit: `mdm_audit`
- Outbox-Events: `MDM_*` Events (z. B. Candidate bestätigt/abgelehnt, Golden upserted)

## API (Kurzüberblick)
MDM Endpunkte:
- Scan:
  - `POST /api/mdm/scan` (Dubletten + Qualität für einen Entity-Typ)
- Dubletten:
  - `GET /api/mdm/duplicates?entityType=...`
  - `POST /api/mdm/duplicates/decide`
- Golden Records:
  - `POST /api/mdm/golden/merge`
  - `GET /api/mdm/golden?entityType=...&id=...` oder `&sourceRef=...`
- Qualitätsissues:
  - `GET /api/mdm/issues`
  - `POST /api/mdm/issues/resolve`
- Modell:
  - `GET /api/mdm/model?entityType=...`
  - `POST /api/mdm/model/label`

## Betrieb & Wartung
Empfohlenes Vorgehen für Datenverwalter:
1. Regelmäßig `/api/mdm/issues?status=open` prüfen und priorisiert abarbeiten.
2. `/api/mdm/duplicates?status=open` prüfen, Kandidaten bestätigen/ablehnen.
3. Für bestätigte Gruppen Golden Records über `/api/mdm/golden/merge` erzeugen.
4. Falls Erkennung zu aggressiv/zu schwach ist: Labeling durchführen (`/api/mdm/model/label`) und Threshold/Weights nachjustieren.

Tuning-Hinweise:
- `threshold` steuert ab wann Kandidaten als Dubletten vorgeschlagen werden.
- Zusätzliche Signalquellen können über weitere Features/Blocking-Keys ergänzt werden.

