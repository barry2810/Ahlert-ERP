# Rollenbasierte Freigabe-Workflows

Dieses Dokument beschreibt die rollenbasierten Freigabe-Workflows fuer kritische Aktionen im ERP (Preis, Rechnung, Routen-Override, Stammdaten). Die Umsetzung ist so gebaut, dass kritische Aktionen nicht direkt ausgefuehrt werden, sondern erst nach erfolgreicher Freigabe angewendet werden.

## Uebersicht

Kritische Aktionen erzeugen einen Freigabeantrag (`erp_approval_request`) mit 1..n sequentiellen Schritten (`erp_approval_step`).

- Status: `pending` -> `approved` -> `applied` (oder `rejected`)
- Eskalation: wenn `due_at` ueberschritten ist, wird der aktuelle Schritt auf eine hoehere Berechtigungsstufe eskaliert und `due_at` neu gesetzt.
- Audit: jede Aktion (Antrag, Schrittfreigabe, Ablehnung, Eskalation, Anwendung) wird in `erp_approval_audit` protokolliert.

## Rollen/Berechtigungen (hierarchisch)

Die Anwendung verwendet Berechtigungen (Permissions). Rollen koennen ueber `/api/auth/admin/roles` angelegt und ueber `/api/auth/admin/roles/grant` mit Permissions ausgestattet werden.

### Basis

- `APPROVAL_VIEW` – Freigaben lesen (Listen/Details/Audit)
- `FLEET_ADMIN` – kann alle Freigaben entscheiden (fallback) und wird als Eskalationsziel verwendet

### Preis (Preislisten, Fees, Overrides)

- `PRICING_MANAGE` – kann Preis-Aenderungen initiieren (Erzeugung von Freigabeantraegen)
- `APPROVAL_APPROVE_PRICING_L1` – erste Freigabestufe
- `APPROVAL_APPROVE_PRICING_L2` – zweite Freigabestufe (bei hoher Auswirkung oder Eskalation)

### Rechnung

- `PRICING_MANAGE` oder `FLEET_ADMIN` – kann Rechnungsentwuerfe zur Freigabe anstossen
- `APPROVAL_APPROVE_BILLING` – Freigabe von Rechnungsentwuerfen

### Routen-Overrides (Disposition)

- `OVERRIDE_DISPATCH` – kann Overrides anstossen (Freigabeantrag)
- `APPROVAL_APPROVE_ROUTE_OVERRIDE_L1` – Freigabe Standard-Override
- `APPROVAL_APPROVE_ROUTE_OVERRIDE_L2` – Freigabe erhoehter Override (z.B. harte Sperren / elevated)

### Stammdaten

- `CUSTOMER_MANAGE`, `CONTRACT_MANAGE`, `PRICING_MANAGE` – kann Stammdaten-Aenderungen initiieren (je nach Endpunkt)
- `APPROVAL_APPROVE_MASTERDATA` – Freigabe von Stammdaten-Aenderungen

## Anwendungsfaelle und Freigabepfade

### Preis-Aenderungen

Betroffene Endpunkte (Initiation erzeugt Freigabeantrag):

- `POST /api/pricing/pricelists` -> `PRICING_CHANGE/pricelist_create`
- `POST /api/pricing/pricelists/items` -> `PRICING_CHANGE/pricelist_item_create`
- `POST /api/pricing/fees` -> `PRICING_CHANGE/fee_create`
- `POST /api/pricing/overrides` -> `PRICING_CHANGE/override_create`

Pfad-Logik:

- Standard: 1 Schritt (`APPROVAL_APPROVE_PRICING_L1`)
- Hoehere Auswirkung (z.B. hoher Betrag / hoher Prozentwert): 2 Schritte (`L1` -> `L2`)

### Rechnungsfreigaben

Betroffene Endpunkte:

- `POST /api/billing/waste/invoice-drafts` -> `BILLING_APPROVAL/invoice_from_pricing`
- `POST /api/waste/orders/invoice/mock` -> `BILLING_APPROVAL/invoice_mock`

Hinweis: Es wird bereits vor der Antragserzeugung geprueft, ob der Auftrag im Status `weighed` ist und ob eine passende Pricing Calculation existiert (damit keine ungueltigen Antraege entstehen).

### Routen-Overrides

Betroffener Endpunkt:

- `POST /api/fleet/dispatch/decision` -> `ROUTE_OVERRIDE/dispatch_decision_override`

Pfad-Logik:

- Standard: 1 Schritt (`APPROVAL_APPROVE_ROUTE_OVERRIDE_L1`)
- Erhoeht (Hard Blocks oder `overrideRequirement=elevated`): 2 Schritte (`L1` -> `L2`)

### Stammdaten-Aenderungen

Betroffene Endpunkte:

- `POST /api/customers` -> `MASTERDATA_CHANGE/customer_create`
- `POST /api/customers/update` -> `MASTERDATA_CHANGE/customer_update`
- `POST /api/contracts` -> `MASTERDATA_CHANGE/contract_create`
- `POST /api/contracts/status` -> `MASTERDATA_CHANGE/contract_status`
- `POST /api/items/materials` -> `MASTERDATA_CHANGE/material_create`

## Freigabe-API (Bedienung)

- `GET /api/approvals/requests?status=pending&type=PRICING_CHANGE&limit=50`
- `GET /api/approvals/request?id=apr_...`
- `GET /api/approvals/audit?requestId=apr_...`
- `POST /api/approvals/approve` mit Body `{ "requestId": "apr_...", "reason": "..." }`
- `POST /api/approvals/reject` mit Body `{ "requestId": "apr_...", "reason": "..." }`

## Eskalation

- Scheduler: laeuft periodisch im API-Prozess und eskaliert offene Antraege, deren `due_at` ueberschritten ist.
- Eskalationsziel: je Schritt konfiguriert (Policy), Default/Fallback `FLEET_ADMIN`.

## Benachrichtigungen

- In-App: `APPROVAL_*` Events werden im Stream `topic=approval` publiziert.
- E-Mail: es wird ein `EMAIL_NOTIFICATION_REQUESTED` ERP-Event erzeugt (Template + Ziel-Permission). Die eigentliche Zustellung erfolgt durch einen separaten Consumer.

