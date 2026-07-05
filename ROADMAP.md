# Roadmap: SPCX Trading-Duell

Stand Juli 2026, nach Abschluss von Online-Stufe 1 (2–8 Spieler, Geheim-Seed, Rangliste).
Zwei Spuren: **Features** (was das Spiel können soll) und **Infrastruktur** (wie es gebaut,
getestet und ausgeliefert wird). Innerhalb jeder Spur nach Aufwand/Nutzen sortiert —
Reihenfolge ist ein Vorschlag, kein Zwang. Verwandte Dokumente: `IDEAS.md` (Detail-
Evaluationen), `ONLINE-PLAN.md` (Architektur der Online-Schicht), `CLAUDE.md` (Code-Regeln).

---

## 📍 Wo wir stehen (Lesezeichen, zuletzt Juli 2026)

- **B1 erledigt** (Tests im Repo, CI nur manuell über Actions → „Tests" → Run workflow).
- **B2: Database-ID eingetragen ✓** — letzter Handgriff des Betreibers: im Cloudflare-
  Dashboard den Worker per „Settings → Build" mit dem GitHub-Repo verbinden (Build command
  leer, Deploy `npx wrangler deploy`, Branch-Previews AUS). Der erste Build deployt dann
  automatisch die pnl-Endpunkte für A1.
- **A1 (Live-Rennen) und A2 (Online-Revanche) umgesetzt.**
- **Online-RAUM: Phase 1+2 umgesetzt** (3. Modus, Runden-Serie, Abend-Wertung, Rollen,
  Limit 20, „Mehrere Geräte" strikt offline mit Null-Request-Beweis). A2-Revanche darin
  aufgegangen. **Offen: Phase 3 (Leinwand-Großbild)** — `RAUM-PLAN.md`.
- Neu aufgenommen: A9 (Leinwand-/Moderator-Ansicht) und A10 (dynamischer Online-Markt)
  — Details und Bewertung in `IDEAS.md`.

---

## Spur A — Features

### A1. Live-Rennen — ✅ umgesetzt (Juli 2026)
Während der Runde tickt neben dem eigenen P&L der der Mitspieler mit (alle ~3–5 s über den
Worker gepollt; nur die Zahl, nie Positionen — sonst könnte man Strategien nachhandeln).
Aus „jeder spielt für sich, Vergleich am Ende" wird ein echtes Kopf-an-Kopf-Rennen; bei
3–8 Spielern ein Live-Ranglisten-Band. Backend-seitig trivial (ein `PUT /game/{code}/pnl/{p}`
mit Throttling + ein Sammel-GET), Client: kleine Live-Leiste unter der Topbar.
*Aufwand: 1 Session. Fairness: unkritisch (reine Anzeige).*

### A2. Online-Revanche — ✅ umgesetzt (Juli 2026)
Nach dem Duell „🔁 Revanche" → legt automatisch ein neues Spiel an und lädt dieselbe Runde
per Push-Nachricht in der alten Spiel-Ressource ein („Revanche unter Code XXXXXX!") — die
Gegner sehen den Hinweis im Ergebnis-Screen und treten mit einem Tipp bei. Nimmt die letzte
manuelle Reibung aus Serien-Duellen. *Aufwand: klein.*

### A3. Tages-Challenge 🏆 (das Alleinstellungsmerkmal)
Der Worker veröffentlicht täglich zur festen Uhrzeit einen Tages-Seed; alle spielen exakt
denselben Markt, eine Tages-Bestenliste zeigt die Top-Ergebnisse. Dank des deterministischen
Seed-Designs fast geschenkt — was andere Spiele groß bauen müssten, ist hier ein Endpunkt +
ein Startknopf „🌍 Tages-Challenge". Braucht: Namens-Moderation (Wortfilter), Plausibilitäts-
grenzen (P&L-Deckel je Dauer), Ergebnis erst nach Rundenende einreichbar (Zeitfenster-Check).
*Aufwand: 1–2 Sessions. Vorstufe für alles Kompetitive.*

### A4. Experten-Modus (liegt fertig evaluiert in IDEAS.md)
Zuschaltbare realistische Härten: Short-Dividende (Leerverkäufer zahlt), ACT-Haltekosten.
Für Remote-Duelle muss der Modus in die Spiel-Ressource (alle spielen dieselben Regeln).
*Aufwand: klein–mittel. Bewusst opt-in, Standard bleibt einsteigerfreundlich.*

### A5. Push-Benachrichtigungen
„Dein Gegner hat sein Ergebnis hochgeladen", „Revanche-Einladung", „Tages-Challenge startet".
iOS-PWA kann Push seit iOS 16.4 (Installation auf dem Home-Bildschirm vorausgesetzt);
Web-Push-Versand direkt aus dem Worker (VAPID, kein Drittanbieter). *Aufwand: mittel;
erst sinnvoll nach A2/A3, wenn es echte Anlässe gibt.*

### A6. Zuschauer-Modus
Wer den Code kennt, sieht das Live-Rennen (A1) ohne mitzuspielen — nette Ergänzung fürs
Duell zu dritt am Tisch. *Aufwand: klein, setzt A1 voraus.*

### A7. Spieltiefe (unabhängig von Online)
- **Limit-/Stop-Orders**: „Verkaufe automatisch bei −5 %" — lehrt echtes Risikomanagement.
  Muss deterministisch am Tick ausgewertet werden (fairness-neutral, da pro Spieler).
- **QR-Ergebnisaustausch offline**: Ergebnis als QR am Ende, Gegner scannt (Encoder um
  2–3 Versionen erweitern; Harness existiert). Schließt die letzte Offline-Lücke.
- **Achievements**: dauerhafte Erfolge über Spiele hinweg („10 Duelle gewonnen", „+20 % in
  einer Runde"), lokal gespeichert — verlängert die Motivation ohne Server.
- Später: Elo/Rangpunkte & Saisons, Turnier-Modus (mehrere Seeds nacheinander, Gesamtwertung).

### A9. Leinwand-/Moderator-Ansicht („Admin Mode") 🖥️
Eine eigene Seite für Spielleiter: Spiel anlegen (ohne selbst mitzuspielen), riesiger QR +
Code für den Beitritt, Live-Roster, gemeinsamer Countdown — und während der Runde eine
Großbild-Ansicht für Beamer/Monitor: alle Märkte als Chart-Wand, großes News-Band,
Live-Rangliste (setzt A1 voraus), am Ende Siegerehrung. Perfekt für Schulklassen, Familien-
abende, Events. Details/Bausteine: `IDEAS.md`. *Aufwand: mittel (2–3 Sessions), technisch
gut vorbereitet durch Mehrspieler + Geheim-Seed; braucht eine „Host ohne Spieler-Slot"-Rolle
im Worker.*

### A10. Dynamischer Online-Markt (Kurse reagieren auf die Spieler) ⚠️
Reizvollste und zugleich heikelste Idee — sie berührt den Fairness-Kern (vorab generierter
Markt). Machbar als **Online-Sondermodus** über eine server-vermittelte, für ALLE identische
Überlagerung (Netto-Orderdruck → gemeinsamer Preis-Impact). Fairness bliebe durch Symmetrie
erhalten, aber Determinismus/Resume/Ergebnis-Verifikation werden deutlich komplexer.
Ausführliche Evaluation mit Architektur-Skizze und Risiken: `IDEAS.md`. *Aufwand: groß;
erst nach A1 sinnvoll (teilt sich die Trade-/Poll-Infrastruktur).*

### A8. Reichweite (wenn das Spiel „fertig" wirkt)
Englische Übersetzung (alle Texte liegen zentral in `data.js`/wenigen UI-Stellen — i18n-Map
statt Framework), Anti-Cheat-Härtung für öffentliche Bestenlisten (Trade-Log einreichen,
Server rechnet den Markt-Replay nach — die deterministische Engine macht das MÖGLICH,
kaum ein Spiel kann das), README/Datenschutz-Absatz.

---

## Spur B — Infrastruktur, Deployment & Co.

### B1. Tests ins Repo + CI — ✅ umgesetzt (CI bewusst nur manuell)
Heute: `worker.test.js` liegt im Repo, aber der große Client-E2E-Test (33 Checks, simuliert
mehrere Geräte gegen den echten Worker-Handler) lebt nur in der Session. Plan:
- ✅ `e2e.test.js` liegt im Repo (43 Checks; DOM-Stub + D1-Adapter, nur Node ≥ 22, null Deps).
- ✅ `.github/workflows/test.yml`: auf Betreiber-Wunsch NICHT pro Push, sondern **manuell**
  (GitHub → Actions → „Tests" → „Run workflow") — schont das Actions-Kontingent.
  Empfehlung: vor jedem größeren Merge einmal auslösen. Lokal weiterhin jederzeit:
  `node worker.test.js && node e2e.test.js`.

### B2. Worker-Deploy automatisieren — ✅ Repo-Seite fertig (Verbinden im Dashboard offen)
Heute: `worker.js` wird nach jeder Server-Änderung von Hand ins Dashboard kopiert (bereits
3× passiert, wird wieder passieren). Plan: **Workers Builds** (Git-Integration) —
`wrangler.jsonc` ins Repo (Name, D1-Binding mit database_id, `main = worker.js`), Repo einmal
im Cloudflare-Dashboard mit dem Worker verbinden → jeder Push auf `main` deployt den Worker
automatisch. Der Betreiber kopiert nie wieder Code. Achtung: Branch-Previews abschalten
(sonst baut jeder Feature-Branch einen Preview-Worker). *Einmalig ~15 Min Klickstrecke.*

### B3. Hosting-Entscheidung (GitHub Pages vs. Cloudflare)
Beobachteter Schmerz: GitHub Pages drosselt bei vielen Deploys („Deployment failed, try
again later" — 3× in dieser Session, jeweils per Retry gelöst). Optionen:
- **Kurzfristig (empfohlen): bleiben.** Der Schmerz trifft nur die Auslieferung neuer
  Versionen, nie die Spieler; an normalen Tagen (1–2 Deploys) irrelevant.
- **Mittelfristig: eigene Domain zuerst.** `spcx-duell.de` o. ä. auf GitHub Pages legen.
  Wichtig: Die Domain ist die *Identität* der PWA (localStorage, Installationen hängen an
  der Origin). Einmalig wechseln = Spielstände/Rekorde der Geräte beginnen bei Null —
  also lieber früh wechseln als spät, und danach nie wieder.
- **Danach optional: Hosting hinter der Domain zu Cloudflare** (Workers Static Assets) —
  App und API aus einer Hand, deploy-gedrosselt wird dort nichts, und die CSP/API-URL
  könnte relativ werden. Durch die eigene Domain ist der Umzug für Nutzer unsichtbar.

### B4. Release-Hygiene
- `CACHE`-Bump in `sw.js` bleibt manuell, aber CI prüft: „PWA-Datei geändert, aber CACHE
  nicht gebumpt?" → Warnung. Verhindert die „App hängt auf alter Version"-Klasse.
- Deploys bündeln statt tröpfeln (weniger Pages-Drosselung, weniger halbe Zustände).
- Kleines `VERSION`-Echo im Start-Screen-Footer (aus CACHE abgeleitet), damit „welche
  Version hast du?" am Telefon in 2 Sekunden beantwortet ist.

### B5. Betrieb & Schutz des Workers
- **Rate-Limiting**: einfacher In-Worker-Limiter (IP-basiert, D1- oder Memory-Zähler) bzw.
  Cloudflare-WAF-Regel — bevor Bestenlisten (A3) öffentlich werden, Pflicht.
- **Beobachtbarkeit**: Cloudflare-Dashboard reicht (Requests/Fehler je Route); optional ein
  `/health`-Endpunkt + wöchentlicher Blick. Kein externes Monitoring nötig.
- **Daten**: bewusst ephemer (24-h-TTL, keine Konten, keine personenbezogenen Daten außer
  frei gewählten Anzeigenamen) — kein Backup-Bedarf. Bei A3/Bestenlisten neu bewerten
  (Aufbewahrung, Löschkonzept, Datenschutz-Absatz in der README).
- **Echtzeit-Upgrade-Pfad**: Wenn Polling (A1) an Grenzen stößt → Durable Objects mit
  WebSockets (gleiches Cloudflare-Konto, migrierbar ohne Client-Bruch, da die API-Form
  bleibt). Erst bei Bedarf — Polling trägt 2–8 Spieler locker.

### B6. Repo-Prozess
Beibehalten, was sich bewährt hat: Feature-Branch → Tests → Merge auf `main` → Deploy;
jede Änderung mit Node-Verifikation vor dem Push. Neu durch B1: CI als Sicherheitsnetz
auch für künftige Sessions/Mitwirkende. `IDEAS.md`/`ONLINE-PLAN.md`/`ROADMAP.md` weiter
als Gedächtnis pflegen (hat sich in dieser Session mehrfach ausgezahlt).

---

## Vorgeschlagene Reihenfolge (je „Session"-große Häppchen)

1. **B1** Tests ins Repo + CI  → Sicherheitsnetz zuerst
2. **B2** Worker-Auto-Deploy   → nie wieder Copy-Paste
3. **A1** Live-Rennen          → größter Spielspaß pro Aufwand
4. **A2** Online-Revanche      → rundet das Duell ab
5. **A3** Tages-Challenge      → inkl. B5-Rate-Limiting
6. **B3** Domain-Entscheidung  → vor größerer Verbreitung
7. **A4/A5/A6/A7** nach Lust und Laune

Grundsätze, die für alles gelten: Fairness-Kern (`genMarket`/Seed) bleibt unantastbar;
alles Online degradiert sauber zu Offline; keine Abhängigkeiten im Client (vendored nur mit
Begründung wie `jsqr.js`); jede Änderung mit Tests belegt; Gratis-Tarife ohne hinterlegte
Zahlungsmittel als harte Kostenbremse.

---

## Spur C — Recht & Ordnung (keine Rechtsberatung, aber die To-do-Liste)

Substanziell ist das Spiel unkritisch: kein Echtgeld, kein Einsatz (→ kein Glücksspiel),
fiktive Kurse (→ keine Anlageberatung/Marktdaten-Lizenzen), keine Konten, Daten ephemer.
Ordnungspunkte, die vor breiterer Verbreitung erledigt sein sollten:
1. **Disclaimer in App/README**: „Fiktives Börsenspiel. Alle Kurse und Ereignisse sind
   erfunden; keine Anlageberatung. Nicht verbunden mit den genannten Unternehmen."
   Die echten Firmennamen (SpaceX, Tesla, „Nasdaq" …) sind Marken — die fiktive Nutzung im
   Spiel ist bei Hobby-Umfang risikoarm, der Nicht-Verbunden-Hinweis senkt es weiter.
2. **Impressum + Datenschutzerklärung**, sobald das Spiel öffentlich angeboten wird (nicht
   nur privat im Freundeskreis): deutsche Impressumspflicht greift schnell; die Online-
   Schicht verarbeitet technisch IP-Adressen (Cloudflare) und frei gewählte Anzeigenamen.
3. **Lizenz-Hygiene**: `jsqr.js` trägt den Apache-2.0-Hinweis im Header ✓; optional den
   Lizenztext als Datei beilegen. Für das eigene Repo eine Lizenz wählen (z. B. MIT),
   sonst haben Dritte formal keine Nutzungsrechte am Code.
