# Git- und CI/CD-Einrichtung

## Zweck

Dieses Dokument beschreibt die Einrichtung eines lokalen Git-Repositorys, die Anbindung an ein GitHub-Remote-Repository, die lokale Ausfuehrung der GitHub-Workflow-Pipeline und die Pruefung aller benoetigten Abhaengigkeiten fuer dieses ERP-Projekt.

## Abschlussstand 2026-06-16

Der aktuelle Reparatur- und Verifizierungsstand fuer dieses System ist:

- Arbeitsverzeichnis `/opt/ahlert-erp` ist ein initialisiertes lokales Git-Repository.
- `origin` ist auf `git@github.com:barry2810/Ahlert-ERP.git` gesetzt.
- Lokale Git-Identitaet ist gesetzt:
  - `user.name`: `Ahlert ERP Local Setup`
  - `user.email`: `noreply@ahlert.local`
- `gh`, `act`, `node` und `npm` sind lokal ohne Root unter `/opt/ahlert-erp/.tools` installiert und lauffaehig.
- Da `github.com:22` in dieser Umgebung nicht erreichbar ist und das Home-Verzeichnis schreibgeschuetzt ist, wurde eine projektlokale SSH-Konfiguration eingerichtet:
  - Private/Public Key unter `/opt/ahlert-erp/.local/ssh/`
  - Git nutzt lokal `core.sshCommand=ssh -F /opt/ahlert-erp/.local/ssh/config`
  - GitHub-Zugriff wird ueber `ssh.github.com:443` erzwungen
- `.gitignore` und `.dockerignore` schliessen Laufzeit- und Tool-Verzeichnisse aus:
  - `.tools/`
  - `.local/`
  - `postgres-data/`
  - `redis-data/`
  - `caddy-data/`
- Der lokale `act`-Lauf wurde in einer neutralen Testkopie erfolgreich validiert; der Workflow wurde fuer `act` angepasst, damit `upload-artifact` lokal uebersprungen wird.
- Da das Home-Verzeichnis schreibgeschuetzt ist, nutzt SSH eine projektlokale Known-Hosts-Datei:
  - `UserKnownHostsFile /opt/ahlert-erp/.local/ssh/known_hosts`

GitHub-Status:

- Public Key ist bei GitHub hinterlegt und SSH-Handshake ist erfolgreich (`Hi barry2810! ...`).
- `main` wurde erfolgreich nach GitHub gepusht und ist auf dem Remote verfuegbar.
- Neutrale GitHub-Testumgebung wurde erfolgreich durchlaufen: Clone, Test-Branch, Aenderung, Push und Rueckpruefung.

Bereits erfolgreich getestet:

- Root-Commit lokal erstellt: `168a9ce` (`chore: initialize repository and local git workflow`)
- Remote-Push nach GitHub erfolgreich:
  - `main`: `eb31068`
  - Test-Branch: `test/github-e2e-20260616065819` (Commit `b375ff5`)
- Neutrale lokale Testkopie via `git clone /opt/ahlert-erp /tmp/ahlert-erp-local-clone`
- Test-Branch lokal erstellt und gepusht: `test/local-e2e`
- Lokaler Push-Nachweis gegen das initialisierte Repository erfolgreich
- `act`-Workflow in neutraler Testkopie erfolgreich: Checkout, Node-Setup, `npm install`, OpenAPI-Build und OpenAPI-Validierung

Der aktuelle Projektstand wurde auf dem Zielsystem bereits teilweise verifiziert:

- Arbeitsverzeichnis: `/opt/ahlert-erp`
- Betriebssystem: `Ubuntu 22.04.5 LTS`
- Benutzer: `tu_admin`
- Lokales Git-Repository: initialisiert
- GitHub CLI `gh`: lokal unter `/opt/ahlert-erp/.tools/bin/gh` installiert
- Local GitHub Actions Runner `act`: lokal unter `/opt/ahlert-erp/.tools/bin/act` installiert
- Node.js / npm lokal: unter `/opt/ahlert-erp/.tools/node/node-v20.20.0-linux-x64/bin` installiert
- Docker: installiert
- Docker Compose: installiert
- Passwordless `sudo`: nicht verfuegbar

## 1. Lokales Git-Repository einrichten

### 1.1 Voraussetzungen

Mindestens erforderlich:

- `git >= 2.34`
- Netzwerkzugriff auf `github.com`
- GitHub-Konto mit Berechtigung zum Erstellen oder Beschreiben des Ziel-Repositorys

### 1.2 Repository initialisieren

Im Projektverzeichnis ausfuehren:

```bash
cd /opt/ahlert-erp
git init -b main
```

Bereits umgesetzt und lokal verifiziert.

### 1.3 Git-Identitaet konfigurieren

Global:

```bash
git config --global user.name "Vorname Nachname"
git config --global user.email "name@firma.de"
```

Nur fuer dieses Repository:

```bash
git config user.name "Vorname Nachname"
git config user.email "name@firma.de"
```

Pruefen:

```bash
git config --get user.name
git config --get user.email
```

Aktueller Stand auf diesem System:

- `user.name`: `Ahlert ERP Local Setup`
- `user.email`: `noreply@ahlert.local`

## 2. GitHub-Remote einrichten

### 2.1 GitHub CLI installieren

Linux Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y gh
```

Windows:

```powershell
winget install --id GitHub.cli
```

macOS:

```bash
brew install gh
```

Pruefen:

```bash
gh --version
```

### 2.2 Authentifizierung bei GitHub

Fuer dieses Projekt ist SSH der Primaerweg. In dieser Umgebung ist `github.com` auf Port `22` nicht erreichbar, deshalb muss GitHub ueber `ssh.github.com:443` genutzt werden.

Bereits lokal eingerichtet:

```bash
git config core.sshCommand "ssh -F /opt/ahlert-erp/.local/ssh/config"
```

Aktiver projektlokaler SSH-Key:

```bash
cat /opt/ahlert-erp/.local/ssh/id_ed25519_github.pub
```

Der Public Key muss einmalig im GitHub-Konto oder in der Zielorganisation hinterlegt werden.

Danach pruefen:

```bash
ssh -T -F /opt/ahlert-erp/.local/ssh/config git@github.com
git ls-remote origin
```

Optional fuer Verwaltungsfunktionen wie `gh repo create` oder `gh repo view`:

```bash
PATH=/opt/ahlert-erp/.tools/bin:$PATH
gh auth login
gh auth status
```

## 12. GitHub CLI, Repo-Sicherheit und PR-Workflow (Verifizierung)

### 12.1 Ziel

Dieser Abschnitt verifiziert und haertet das GitHub-Repository nach gaengigen Sicherheitsstandards:

- GitHub CLI ist nicht-interaktiv nutzbar (Token-basiert)
- Branch-Schutzregeln fuer `main` sind aktiv (PR-only, Reviews, keine Force-Pushes)
- Repo-Settings sind sinnvoll konfiguriert (Merge-Strategien, Delete-branch-on-merge)
- PR-Workflow ist technisch verifiziert (Branch -> Push -> PR -> Close -> Branch Delete)

### 12.2 Fine-grained Token (empfohlen)

Erzeuge eine Fine-grained PAT fuer `barry2810/Ahlert-ERP` und setze sie als Environment Variable:

```bash
export GH_TOKEN="..."
```

Empfohlene Berechtigungen fuer das Repo:

- Administration: Read/Write (fuer Branch Protection)
- Contents: Read/Write (fuer Branch/Push/Ref-Loeschung)
- Pull requests: Read/Write (fuer PR-Erstellung/-Pruefung)
- Actions: Read (fuer Workflow-/Check-Validierung)

### 12.3 Automatisierte Verifizierung und Einrichtung

Non-interaktiv (kein `gh auth login` erforderlich):

```bash
node /opt/ahlert-erp/scripts/github-repo-verify.mjs --apply --pr-test
```

Optional als JSON-Ausgabe:

```bash
node /opt/ahlert-erp/scripts/github-repo-verify.mjs --apply --pr-test --json
```

Was dabei passiert:

- Repo-Settings werden gepatcht (u.a. `delete_branch_on_merge`, Merge-Strategien)
- Branch Protection fuer `main` wird gesetzt:
  - PR required
  - 1 Approval required
  - Dismiss stale reviews
  - Require conversation resolution
  - Linear history
  - Keine Force-Pushes/Deletions
  - Admins enforced
  - Status-Checks werden automatisch aus vorhandenen Check-Runs erkannt und nur gesetzt, wenn Checks existieren
- PR-Workflow wird in einer neutralen Testkopie durchlaufen:
  - Draft PR wird erstellt
  - PR wird geschlossen
  - Test-Branch wird wieder geloescht

### 12.4 Manuelle Kurzchecks (ohne Script)

Mit gesetztem `GH_TOKEN`:

```bash
PATH=/opt/ahlert-erp/.tools/bin:$PATH
gh repo view barry2810/Ahlert-ERP
gh pr list --repo barry2810/Ahlert-ERP --limit 10
```

Branch Protection anzeigen:

```bash
PATH=/opt/ahlert-erp/.tools/bin:$PATH
gh api repos/barry2810/Ahlert-ERP/branches/main/protection
```

### 2.3 Remote-Repository erstellen

Wenn das Zielsystem noch nicht existiert:

```bash
gh repo create <OWNER>/<REPO> --private --source=. --remote=origin --push=false
```

Alternative fuer ein oeffentliches Repository:

```bash
gh repo create <OWNER>/<REPO> --public --source=. --remote=origin --push=false
```

Falls das Repository bereits manuell auf GitHub angelegt wurde:

```bash
git remote add origin git@github.com:<OWNER>/<REPO>.git
```

### 2.4 Remote-Verbindung pruefen

```bash
git remote -v
git ls-remote origin
```

Erwartung:

- `origin` fuer `fetch` und `push` vorhanden
- `git ls-remote origin` liefert Referenzen ohne Authentifizierungsfehler

## 3. Commits und Pushes durchfuehren

### 3.1 Aenderungen pruefen

```bash
git status
git diff
```

### 3.2 Dateien zum Commit vormerken

```bash
git add <datei>
git add .
```

### 3.3 Aussagekraeftigen Commit erstellen

Beispiel:

```bash
git commit -m "docs: add git and ci/cd setup guide"
```

Empfohlene Commit-Struktur:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `chore: ...`
- `ci: ...`

### 3.4 Merge-Konflikte vor dem Push loesen

```bash
git fetch origin
git pull --rebase origin main
```

Bei Konflikten:

1. Konfliktdateien inhaltlich bereinigen
2. Dateien erneut vormerken:

```bash
git add <datei>
git rebase --continue
```

Abbruch des Rebase bei Bedarf:

```bash
git rebase --abort
```

### 3.5 Push ausfuehren

Erster Push:

```bash
git push -u origin main
```

Folge-Pushes:

```bash
git push
```

### 3.6 Erfolgreiche Uebertragung pruefen

```bash
git status
git log --oneline -n 5
gh repo view <OWNER>/<REPO>
```

Zusatzpruefung:

- Im GitHub-Webinterface pruefen, ob Commit und Dateien sichtbar sind

## 4. Lokale CI/CD-Ausfuehrung mit `act`

### 4.1 Mindestvoraussetzungen

- `Docker >= 24`
- `Docker Compose >= 2`
- `act >= 0.2.60`

### 4.2 Installation

Windows:

```powershell
winget install nektos.act
```

macOS:

```bash
brew install act
```

Debian/Ubuntu:

Empfohlen ueber GitHub-Release oder offizielles Installationsskript, da `act` in Standard-Repositories oft nicht enthalten ist:

```bash
curl https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash
```

Pruefen:

```bash
act --version
```

### 4.3 Workflow lokal ausfuehren

Im Projekt:

```bash
cd /opt/ahlert-erp
act -W .github/workflows/openapi.yml
```

Falls ein groesseres Runner-Image benoetigt wird:

```bash
act -W .github/workflows/openapi.yml -P ubuntu-latest=catthehacker/ubuntu:full-latest
```

### 4.4 Loganalyse

```bash
act -W .github/workflows/openapi.yml --verbose
```

Auf folgende Fehlerbilder achten:

- fehlende Docker-Berechtigung
- fehlende Node-/npm-Kommandos innerhalb des Runners
- Pfadfehler bei `site/openapi`
- Workflow-Datei syntaktisch ungueltig

## 5. Betriebssystem- und Tool-Anforderungen

### 5.1 Unterstuetzte Betriebssysteme

Empfohlene Mindestplattformen fuer die Nutzung des Gesamtpakets:

- Windows: `Windows 10 22H2` oder `Windows 11`
- macOS: `macOS 13 Ventura` oder neuer
- Linux: `Ubuntu 22.04 LTS`, `Debian 12`, vergleichbare aktuelle Distributionen mit Docker-Unterstuetzung

### 5.2 Projektspezifische Mindestversionen

#### Git-spezifische Tools

- `git >= 2.34`
- `gh >= 2.4`

#### CI/CD-spezifische Abhaengigkeiten

- `Docker >= 24`
- `Docker Compose >= 2`
- `act >= 0.2.60`
- `Node.js >= 20`
- `npm >= 10`

#### Projektspezifische Softwarekomponenten

- `PostgreSQL 16` via Docker
- `Redis 7` via Docker
- `Caddy 2` via Docker
- `Node 20 Alpine` fuer den API-Container

## 6. Installationsanweisungen fuer fehlende Pakete

### 6.1 Windows

```powershell
winget install --id Git.Git
winget install --id GitHub.cli
winget install Docker.DockerDesktop
winget install nektos.act
winget install OpenJS.NodeJS.LTS
```

Pruefen:

```powershell
git --version
gh --version
docker --version
docker compose version
act --version
node --version
npm --version
```

### 6.2 macOS

```bash
brew install git gh node act
brew install --cask docker
```

Pruefen:

```bash
git --version
gh --version
docker --version
docker compose version
act --version
node --version
npm --version
```

### 6.3 Debian/Ubuntu

```bash
sudo apt update
sudo apt install -y git gh docker.io docker-compose-plugin
```

Node.js 20 wird fuer dieses Projekt nicht aus dem Ubuntu-Standardrepository empfohlen, weil dort auf Ubuntu 22.04 nur Node 12 verfuegbar ist. Empfohlen:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

`act`:

```bash
curl https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash
```

Pruefen:

```bash
git --version
gh --version
docker --version
docker compose version
act --version
node --version
npm --version
```

## 7. Verifizierte Ist-Werte auf diesem System

Lokal geprueft:

- `git version 2.34.1`
- `Docker version 29.5.2`
- `Docker Compose version v5.1.4`
- `Python 3.10.12`
- `Ubuntu 22.04.5 LTS`

Fehlend oder noch nicht nutzbar:

- GitHub-Authentifizierung: SSH-Key noch nicht in GitHub registriert
- `gh auth status`: noch nicht eingeloggt
- Push-/Pull-Rechte gegen GitHub: noch nicht bestaetigt, da Authentifizierung extern blockiert

## 8. Bereits lokal erfolgreich geprueft

- Lokales Git-Repository wurde unter `/opt/ahlert-erp/.git` initialisiert
- Die GitHub-Workflow-Datei `.github/workflows/openapi.yml` ist vorhanden
- Die OpenAPI-Artefakte wurden bereits erfolgreich per Docker-basierter Node-Ausfuehrung erzeugt:
  - `site/openapi/v1.json`
  - `site/openapi/v2.json`
  - `site/openapi/metrics.json`
- Die lokale Integrationssuite mit Docker Compose wurde bereits erfolgreich ausgefuehrt

## 9. Noch offene Schritte fuer den vollstaendigen End-to-End-Nachweis

Die folgenden Schritte koennen erst nach Bereitstellung eines echten GitHub-Zielsystems und der erforderlichen Authentifizierung abgeschlossen werden:

1. Public Key aus `/opt/ahlert-erp/.local/ssh/id_ed25519_github.pub` bei GitHub hinterlegen
2. SSH-Zugriff mit `ssh -T -F /opt/ahlert-erp/.local/ssh/config git@github.com` bestaetigen
3. Optional `gh auth login` durchfuehren
4. Erstes Commit pushen
5. Neutralen SSH-Clone aus GitHub ziehen
6. Test-Branch anlegen, Aenderung pushen und Rueckpruefung durchfuehren
7. GitHub-Workflow im echten Remote-System nach Push pruefen

## 10. Troubleshooting

### 10.1 `fatal: not a git repository`

Loesung:

```bash
git init -b main
```

### 10.2 `Author identity unknown`

Loesung:

```bash
git config --global user.name "Vorname Nachname"
git config --global user.email "name@firma.de"
```

### 10.3 `remote origin already exists`

Loesung:

```bash
git remote set-url origin https://github.com/<OWNER>/<REPO>.git
```

### 10.4 `Authentication failed`

Moegliche Ursachen:

- GitHub-Login fehlt
- Token ohne `repo`-Berechtigung
- Falscher Remote-URL-Typ

Loesung:

```bash
gh auth login
gh auth status
git remote -v
```

### 10.5 `Permission denied (publickey)` bei SSH

Loesung:

1. Public Key ausgeben:

```bash
cat /opt/ahlert-erp/.local/ssh/id_ed25519_github.pub
```

2. Public Key bei GitHub hinterlegen
3. SSH-Verbindung pruefen:

```bash
ssh -T -F /opt/ahlert-erp/.local/ssh/config git@github.com
```

### 10.6 `act: command not found`

Loesung:

- `act` gemaess Abschnitt 6 installieren

### 10.7 Docker-/Act-Runner startet nicht

Pruefen:

```bash
docker ps
docker info
act --verbose
```

### 10.8 `npm: command not found`

Loesung:

- Node.js 20 und npm gemaess Abschnitt 6 installieren

### 10.9 Home-Verzeichnis ist schreibgeschuetzt

Symptom:

- SSH-Key kann nicht unter `~/.ssh` geschrieben werden
- Fehler wie `Read-only file system`

Loesung:

- Projektlokalen SSH-Ordner verwenden:

```bash
mkdir -p /opt/ahlert-erp/.local/ssh
git config core.sshCommand "ssh -F /opt/ahlert-erp/.local/ssh/config"
```

### 10.10 `act` scheitert an `ACTIONS_RUNTIME_TOKEN`

Symptom:

- `actions/upload-artifact` faellt lokal unter `act` aus

Loesung:

- Upload-Schritt im Workflow fuer lokale `act`-Laeufe ueberspringen:

```yaml
if: ${{ !env.ACT }}
```

### 10.11 Ubuntu-Repository liefert zu alte Node-Version

Auf Ubuntu 22.04 liefert `apt` standardmaessig nur Node 12. Fuer dieses Projekt ist Node 20 erforderlich. Deshalb NodeSource oder eine aehnlich aktuelle Quelle verwenden.

## 11. Empfohlene Abschlusspruefung

Nach Installation und GitHub-Anbindung folgende Kommandos in dieser Reihenfolge ausfuehren:

```bash
git config --get user.name
git config --get user.email
gh auth status
git remote -v
git ls-remote origin
git status
git add .
git commit -m "chore: initialize repository and ci setup"
git push -u origin main
act -W .github/workflows/openapi.yml --verbose
```

Erfolgskriterien:

- Remote `origin` ist gesetzt
- Push funktioniert ohne Authentifizierungsfehler
- Commit ist auf GitHub sichtbar
- `act` beendet den Workflow ohne Fehler
- Versionen aller Pflichtprogramme erfuellen die Mindestanforderungen
