[OPEN] Debug-Session: notification-test-connrefused

## Symptom
- `tests-dispatch.mjs` bricht mit `TypeError: fetch failed` ab
- Ursache im Stack: `ECONNREFUSED ::1:3000` und `127.0.0.1:3000`
- Fehler tritt im Container bei `req()` in `tests-dispatch.mjs` auf

## Kontext
- Test wird mit `docker compose exec -T api node /app/tests-dispatch.mjs` gestartet
- Im Container zeigt `localhost:3000` auf den API-Container selbst
- Der API-Prozess muss zum Testzeitpunkt bereits auf Port `3000` lauschen

## Hypothesen
1. Der Test startet zu frueh, bevor der API-Prozess im Container Port `3000` gebunden hat.
2. `tests-dispatch.mjs` verwendet mit `http://localhost:3000` einen Zielhost, der im Ausfuehrungskontext falsch ist.
3. Der API-Container startet, beendet sich aber kurzzeitig oder ist wegen Migration/Bootstrap noch nicht ansprechbar.
4. `docker compose exec ... api node /app/tests-dispatch.mjs` laeuft in einem anderen Netzwerk-/Prozesskontext als angenommen, sodass `localhost:3000` nicht auf den aktiven API-Listener zeigt.
5. Eine fruehere Testannahme nutzt direkten Sofortzugriff ohne Readiness-Check; der Fehler ist also ein Test-Orchestrierungsproblem, nicht ein Kanal-/Benachrichtigungsfehler.

## Naechste Evidenzschritte
- Zieladresse und Readiness-Annahme im Testcode pruefen
- Container-Status und API-Logs zum Fehlerzeitpunkt pruefen
- Erreichbarkeit von `localhost:3000` aus dem `api`-Container verifizieren
- Danach gezielt nur Test-Instrumentierung bzw. minimale Test-Setup-Anpassung vornehmen

## Evidenz
- `tests-dispatch.mjs` nutzte fest `http://localhost:3000`
- Reproduktion mit `docker compose up -d --build api worker && docker compose exec -T api node /app/tests-dispatch.mjs` schlug erneut mit `ECONNREFUSED` fehl
- Kurz danach zeigte `ps/netstat` im `api`-Container: `node --import /app/otel.mjs /app/server.mjs` lauscht auf `0.0.0.0:3000`
- Schlussfolgerung: kein dauerhafter Zielhost-Fehler, sondern ein Start-/Readiness-Race direkt nach Container-Neustart

## Instrumentierung
- In `apps/api/tests-dispatch.mjs` wurden Debug-Punkte rund um `req()` ergaenzt, um Start/Fehler/Response zu erfassen

## Fix
- `base` in `tests-dispatch.mjs` auf env-override faehig gemacht: `TEST_BASE_URL` oder `API_BASE_URL`
- `waitForApiReady()` vor dem ersten Testrequest eingefuegt
- Readiness prueft `GET /api/modules` mit Retry bis zu 30 Sekunden

## Verifikation
- Vor Fix: Abbruch direkt am ersten Request mit `fetch failed` / `ECONNREFUSED`
- Nach Fix: dieselbe Sequenz laeuft ueber den alten Fehlerpunkt hinaus
- Neuer Abbruch erst spaeter bei unabhaengigem Test `mdm_recall_min_95pct`

## Status
- Root Cause fuer den `ECONNREFUSED` identifiziert und minimal behoben
- Debug-Session bleibt offen bis Benutzerbestaetigung
