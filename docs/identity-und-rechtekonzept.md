# Identity- und Rechtekonzept (SSO/MFA/RBAC)

## 1. Zweck und Zielbild

Dieses Dokument beschreibt ein zentrales, unternehmensweites Identity- und Rechtekonzept mit Single Sign-On (SSO) und verpflichtender Multi-Faktor-Authentifizierung (MFA). Ziel ist eine einheitliche, auditierbare und compliance-faehige Steuerung von Identitaeten und Zugriffsrechten ueber alle Anwendungen, Systeme und Dienste hinweg.

## 2. Leitprinzipien

- Single Source of Truth: Identitaeten, Gruppen/Rollen und Authentifizierungsrichtlinien werden zentral am Identity Provider (IdP) verwaltet.
- Least Privilege: Rechtevergabe erfolgt minimal, rollenbasiert (RBAC) und bei Bedarf um kontextbezogene Regeln (Conditional Access) ergaenzt.
- Security by Default: MFA ist Standard fuer alle Benutzer; Ausnahmen sind eng begrenzt und nachvollziehbar.
- Nachvollziehbarkeit: Jeder Authentifizierungs- und Zugriffsprozess erzeugt Audit-Events mit Retention und SIEM-Anbindung.
- Standardprotokolle: OIDC/OAuth2, SAML2 und SCIM (Provisioning) werden bevorzugt.

## 3. Zentralisierte Identitaetsverwaltung (IdP)

### 3.1 Komponenten

- Identity Provider (IdP) als zentrale Authentifizierungsinstanz
- Verzeichnisdienst als Quelle fuer Mitarbeiter- und Dienstkonten (z.B. HR-Feed/LDAP/AD als Upstream)
- Provisioning (SCIM) fuer Zielsysteme und Anwendungen
- Gruppen-/Rollenverwaltung (z.B. Abteilungen, Funktionen, Applikationsrollen)

### 3.2 Kontotypen

- Mitarbeiterkonten (Human Users)
- Externe (Partner, Dienstleister) mit restriktiven Policies
- Service Accounts (non-interactive) nur wo zwingend notwendig, bevorzugt durch Workload Identity ersetzen
- Break-Glass Konten (Notfall) separat, stark kontrolliert, MFA/Hardware-Key, ueberwacht

### 3.3 Lifecycle / JML (Joiner-Mover-Leaver)

- Joiner: automatisierte Anlage (HR->IdP), Zuweisung von Standardrollen
- Mover: Rollen-/Gruppenwechsel ueber definierte Workflows, Approvals, Audit
- Leaver: sofortige Deaktivierung/Entzug aller Sessions, Tokens und App-Zugriffe, Entzug von Keys

## 4. SSO-Implementierung (SAML2, OAuth2, OIDC)

### 4.1 Protokollwahl (Empfehlung)

- OIDC (OpenID Connect) fuer moderne Web-Apps/APIs (Authorization Code + PKCE)
- OAuth2 fuer Service-to-Service Zugriffe (Client Credentials) mit kurzen Token-Laufzeiten
- SAML2 fuer Legacy-Enterprise-Anwendungen, die kein OIDC koennen

### 4.2 Token-/Session-Standards

- Kurze Access-Token-Laufzeiten (z.B. 5-15 Minuten), Refresh-Token nur wo erforderlich
- Rotierende Refresh Tokens, Device-Binding wo moeglich
- Signatur/Key-Rotation (JWKS), striktes Audience/Issuer-Checking
- Zentraler Logout/Session Revocation im IdP (bei Leaver/Incident)

### 4.3 Integration ins ERP (dieses Repo)

- API-Authentifizierung ueber OIDC (JWT Bearer)
- Rollen-/Rechteabbildung ueber Claims (z.B. `roles`, `groups`, `tenant`, `department`)
- Optional: SAML fuer Backoffice-UI (falls separater Web-Client entsteht)

## 5. MFA-Pflicht

### 5.1 Grundsatz

MFA ist fuer alle interaktiven Logins verpflichtend.

### 5.2 Zugelassene Faktoren (Beispiele)

- Passkey / FIDO2 / WebAuthn (bevorzugt)
- Authenticator App (TOTP/PUSH)
- Hardware Security Keys
- SMS nur als letzter Ausweg und nur fuer eng begrenzte Ausnahmefaelle

### 5.3 Conditional Access / Step-up MFA

- Step-up MFA fuer sensible Aktionen (z.B. Rollenvergabe, Export sensibler Daten, Admin-Funktionen)
- Device- und Standortbedingungen (z.B. Managed Devices, VPN, Geo-Restrictions)
- Risk-based Policies (Anomalien, Impossible Travel, Credential Stuffing Indicators)

### 5.4 Ausnahmen

Ausnahmen nur fuer genehmigte Spezialfaelle:

- dokumentierter Business-Need
- zeitlich befristet (Expiry)
- kompensierende Kontrollen (z.B. IP-Allowlist, Just-in-Time, Monitoring, Break-Glass Workflow)

## 6. Rollen- und Berechtigungskonzept (RBAC + bedingte Regeln)

### 6.1 Rollenmodell

- Organisationsrollen: z.B. Disposition, Billing, Reporting, Admin
- Applikationsrollen: fein granular pro Modul/Scope
- Trennung von Rollen und Personen (Rollen werden Gruppen im IdP zugeordnet)

### 6.2 Least-Privilege Umsetzung

- Default-deny in der Applikation
- Berechtigungen als explizite Scopes/Actions (z.B. `waste.order.read`, `billing.invoice_draft.create`)
- Admin-Funktionen strikt getrennt und MFA/Step-up geschuetzt

### 6.3 Bedingte Regeln (ABAC-Elemente)

RBAC kann um Bedingungen ergaenzt werden:

- Mandant/Standort/Region
- Datenklassifizierung (z.B. PII)
- Zeitfenster (z.B. nur innerhalb Betriebszeiten)
- Device Compliance

### 6.4 Access Reviews

Regelmaessige Zugriffspruefungen (z.B. quartalsweise):

- Rollen- und Gruppenmitgliedschaften bestaetigen oder entziehen
- Sonderrechte/temporare Erhoehungen (JIT) automatisch auslaufen lassen
- Nachweisfaehige Protokolle fuer Compliance

## 7. Security & Compliance (DSGVO, ISO 27001, NIST 800-63-3)

### 7.1 Datenschutz (DSGVO)

- Datenminimierung in Claims/Profilen (nur notwendige Attribute)
- Zweckbindung und transparente Dokumentation
- Loesch- und Sperrkonzepte fuer Benutzerattribute
- Rollenbasierte Zugriffskontrolle auf personenbezogene Daten

### 7.2 ISO 27001 / Governance

- Definierte Policies: Passwort, MFA, Access Reviews, Logging/Retention, Incident Response
- Change Management fuer Rollen/Policies
- Regelmaessige Audits und Nachweisfuehrung

### 7.3 NIST SP 800-63-3

- AAL (Authentication Assurance Level) mindestens AAL2 fuer Standardzugriffe, AAL3 fuer Admin/Break-Glass
- Phishing-resistente Faktoren bevorzugt (FIDO2/Passkeys)

### 7.4 Protokollierung & Monitoring

Zu loggende Ereignisse:

- Login (success/fail), MFA challenge/result
- Token issuance/refresh/revocation
- Rollen-/Gruppenveraenderungen (wer/was/wann/warum)
- Admin-Aktionen und sensitive Datenzugriffe

Anbindung:

- Zentrales Logging/SIEM (z.B. Azure Sentinel, Splunk, ELK)
- Alarmierung bei Anomalien (Brute force, impossible travel, token abuse)

### 7.5 Notfallplaene (Identity Misuse)

- Sofortige Session/Token Revocation
- Lockdown von Admin-Rollen
- Rotation kompromittierter Secrets/Keys
- Forensik: Export audit logs, Timeline, Impact-Analyse

## 8. Integration in bestehende Infrastruktur

### 8.1 Cloud- und On-Prem Systeme

- SSO fuer SaaS und interne Web-Apps via OIDC/SAML
- VPN/Zero-Trust Integration (Conditional Access)
- Legacy: SAML/Proxy oder Identity Gateway als Bruecke

### 8.2 Provisioning/Migration

Phasenmodell:

1. Inventarisierung: Systeme, Auth-Methoden, Benutzergruppen, Risiken
2. IdP-Setup: Domains, MFA, Conditional Access, Gruppenmodell
3. Pilot: 1-2 Anwendungen inkl. ERP
4. Rollout: gestaffelt nach Kritikalitaet
5. Decommission: alte Login-Mechanismen entfernen, technische Schulden abbauen

## 9. Test- und Abnahmeverfahren

### 9.1 Testplan (funktional)

- SSO Login (OIDC/SAML) fuer alle Ziel-Apps
- MFA enforced, Step-up fuer Admin/Sensitive Actions
- Rollenmapping: richtige Rechte nach Login, keine Ueberberechtigung
- Session/Token Revocation (Leaver/Incident)

### 9.2 Security Tests

- Penetrationstest (Auth Flows, Session Fixation, Token Handling)
- MFA Bypass Tests
- Misconfiguration Checks (redirect URIs, audience, issuer)
- Least-Privilege Review (RBAC/ABAC)

### 9.3 Abnahmekriterien

- MFA fuer alle User aktiv, Ausnahmen dokumentiert
- SSO fuer priorisierte Systeme aktiv
- Audit-Logs vollstaendig, SIEM-Integration produktiv
- Access Reviews etabliert und nachweisbar
- Incident Runbooks vorhanden und getestet

## 10. Lieferobjekte (Dokumentation)

- Admin-Handbuch (IdP, Policies, Notfall, Rotation, Monitoring)
- Enduser-Anleitung (Login, MFA, Passkeys, Recovery)
- Compliance-Anhang (Datenfluesse, Retention, Access Review Nachweise)
- Testplan und Abnahmeprotokolle

## Anhang A: Beispiel-Rollen fuer das ERP

- `erp.admin` – Administration, Systemkonfiguration, Rollenverwaltung (step-up MFA)
- `erp.dispatcher` – Disposition, Touren, Auftraege
- `erp.billing` – Rechnungsentwuerfe, Freigaben
- `erp.reporting` – Exporte und Reports
- `erp.mobile` – eingeschraenkter Zugriff fuer mobile Clients

