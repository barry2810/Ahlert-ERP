## Git Push Troubleshooting (Ahlert ERP)

### Ziel
Dieses Dokument beschreibt typische Ursachen, die eine erfolgreiche Übertragung (Push) verhindern, sowie die in diesem Repository etablierten Gegenmaßnahmen.

### Häufige Ursachen
- **Ungewollte lokale Verzeichnisse im Arbeitsbaum** (z. B. IDE-/Debug-Ordner oder persistente Container-Daten), die bei `git add -A` versehentlich aufgenommen werden.
- **Fehlende/inkonsistente Migrationen**: neue Migrationsdateien liegen lokal vor, sind aber nicht versioniert.
- **Branch-Policy**: `main` ist ggf. geschützt, sodass direkte Pushes abgelehnt werden.
- **Remote-Auth**: SSH-Key/Token fehlt oder Remote-URL ist falsch.

### Repo-Konventionen
- **Persistente Datenverzeichnisse** werden nicht versioniert (z. B. `*-data/`-Ordner).
- **IDE-/Tooling-Artefakte** werden nicht versioniert (z. B. `.trae/`, `.dbg/`).
- **Migrationen** liegen ausschließlich unter `apps/api/migrations/*.mjs`.

### Fixes, die im Repo umgesetzt sind
- `.gitignore` enthält Einträge, um lokale Artefakte und Datenverzeichnisse aus Git herauszuhalten.
  - Beispiele: `.trae/`, `.dbg/`, `prometheus-data/`, `tempo-data/`, `promtail-data/`, `grafana-data/`, `loki-data/`, `alertmanager-data/`

### Checkliste vor dem Push
1. `git status -b`
2. Merge-Konflikte prüfen: `git diff --name-only --diff-filter=U`
3. Änderungen reviewen: `git diff --stat`
4. Commit erstellen: `git commit -m "<type>: <summary>"`
5. Remote prüfen: `git remote -v`
6. Upstream setzen, falls nötig:
   - `git push -u origin <branch>`

### Branch-Empfehlung
Wenn `main` geschützt ist, neue Arbeiten auf Feature-Branch pushen und über PR integrieren:
- `git switch -c feat/<topic>`
- `git push -u origin feat/<topic>`

