# Plan: Dynamischer Markt im Experten-Modus (nur Online-Raum) — A10 + A4

Status: **UMGESETZT** (Juli 2026) — Worker v4 (expert/cash, trades-Journal, Rate-Limit),
Effektivkurs-Schicht (Blockorders → Ramp/Fade-Overlay, Slippage, Schlussauktion),
Herden-Schicht (Dämpfung, Squeeze, Stimmungsband, Leinwand) und die lokalen Härten
(Spread, Handelsstopp, Limit-/Stop-Orders, Short-Leihgebühr, ACT-Haltekosten) inkl.
🎓-Toggle in der Sandbox. 63 Worker- + 54 E2E-Checks. Offen: Hebel/Margin-Call
(bewusst „später"), Tuning-Werte nach dem ersten echten Test-Abend justieren,
Awards („🐘 Elefant"/„🥷 Leisetreter") als Polish. Ursprünglicher Plan unten.
Hintergrund/Evaluation: `IDEAS.md` (A10/A4), `ROADMAP.md`.

## Entschieden (mit Betreiber durchdacht)

1. **Nur im Online-Raum.** Solo/Lokal/Offline bleiben zu 100 % unberührt — `genMarket`,
   Shared Codes, das ganze Determinismus-Fundament sind tabu. Der dynamische Markt ist
   eine reine Raum-Schicht ÜBER dem Basismarkt. Begründung: erst mit 2–20 Spielern sieht
   man, „dass wirklich was passiert" — solo wäre es ein einsamer Gimmick.
2. **Teil des zuschaltbaren Experten-Modus (A4).** Der Ersteller schaltet ihn pro Runde
   zu — der 🎓-Toggle sitzt in einem EIGENEN Block weiter unten im Raum-Screen (bewusst
   getrennt von der Dauer-Zeile, z. B. „Runden-Optionen" unterhalb des Start-Bereichs)
   und ist NUR für den Ersteller sichtbar/bedienbar; alle anderen sehen höchstens einen
   Hinweis „🎓 Experten-Runde". Das Flag ist Teil der Runden-Ressource vom Server (wie
   `dur`/`seed`) → alle Geräte inkl. Leinwand und Nachzügler spielen garantiert dieselben
   Regeln. Standard bleibt AUS (einsteigerfreundlich).
   Die übrigen A4-Härten (Short-Dividende, ACT-Haltekosten) hängen am selben Flag,
   sind aber eigene kleine Bausteine (lokal deterministisch, kein Server nötig).
3. **Trades werden zu News-Events (die zentrale Fairness-Idee).** Große Orders
   („Blockorders") melden sich an den Worker; der stempelt sie verbindlich auf einen Tick.
   Alle Geräte holen sie per Poll (~2,5 s) ab, die Meldung erscheint sofort im Feed
   („🐘 Blockorder: Jemand kauft groß SPCX"), die WIRKUNG trifft den Kurs erst bei
   `stampTick + REACT_TICKS` (~8 s) — dieselbe Grammatik wie News. Weil die Wirkverzögerung
   größer als die Poll-Latenz ist, wissen alle Bescheid, BEVOR es passiert: kein
   Latenz-Vorteil, und alle Geräte errechnen aus demselben Journal denselben Kurs.
4. **Zwei Schichten, ein Datenstrom:**
   - **Flow (sofort):** jede Blockorder schiebt den Kurs in Trade-Richtung (Kauf/Cover
     hoch, Verkauf/Short runter), rampt herein (wie `pushJump`) und federt größtenteils
     zurück (wie der Mega-Fade). Herden-Käufe stapeln sich → Blasen sind möglich.
   - **Positionsdruck (latent):** die kumulierte Schieflage des Raums pro Aktie (Summe der
     Block-Flows) dämpft Basisbewegungen in Herdenrichtung („alle short → fällt zäher")
     und zündet einen Multiplikator, wenn eine News GEGEN die Schieflage läuft
     (**Short Squeeze** / Blasen-Crash). Kein neuer Datenstrom — dasselbe Journal, summiert.
5. **Anti-Exploit (Selbst-Pump), drei Riegel:**
   - **Slippage:** der eigene Fill enthält den halben eigenen Impact (Ø-Kurs im Ticket
     sichtbar: „101,45 statt 100,80 — Market Impact"). Wale zahlen die Prämie.
   - **Fade:** Impact gibt den Großteil zurück — Pumps sind vergänglich.
   - **Schlussauktion:** Endbewertung der Runde zum fairen BASIS-Kurs (Impact-frei).
     Last-Second-Pumps bewerten sich zu null. Live-P&L während der Runde läuft effektiv.
   Kollektives Pumpen bringt in der Rangliste keinen relativen Vorteil, Verraten schon →
   das Chicken-Game reguliert sich selbst (und ist das eigentliche Tischtheater).
6. **Anonym:** Blockorders laufen ohne Namen („🐘 Jemand …"). Das Rätselraten am Tisch ist
   Teil des Spiels; optionale Auflösung in der Abend-Wertung („größter Marktbeweger").
7. **Stimmungsband = UI-Begleiter (A10 Stufe A fällt mit ab):** die Raum-Schieflage pro
   Aktie wird im Spiel (dezent) und auf der Leinwand (groß) angezeigt — so SIEHT man das
   Squeeze-Risiko wachsen, und Contrarian-Spiel wird eine echte Strategie.
8. **Startkapital-Wahl (entschieden).** Im „Runden-Optionen"-Block wählt der Ersteller das
   Startkapital der Runde: 10k / 25k / 50k / 100k $ (dieselbe Staffel wie die Sandbox,
   `START_CASH` ist dafür schon ein `let`). Der Wert ist Teil der Runden-Ressource
   (`rounds.cash`, Default 25 000, serverseitig gegen die Preset-Liste validiert) → alle
   starten identisch. Abend-Wertung bleibt absolut (bewusst: „Finalrunde mit 100k" als
   High-Stakes-Eskalation); der LOKALE Bestwert-Rekord wird nur bei 25k-Runden
   aktualisiert (Vergleichbarkeit, wie Sandbox).
9. **Konservativ tunen, dann Test-Abend.** Wucht ist Gefühlssache, keine Rechenaufgabe.
   Startwerte (alle als benannte Konstanten, justierbar):
   - Blockorder-Schwelle: Orderwert ≥ 20 % von `START_CASH` (5 000 $).
   - Flow-Impact je Blockorder: ~0,3 % (liquide Werte wie SPCX/MKT) bis ~2 % (kleine
     Werte) — skaliert über einen neuen `liq`-Trait in `STOCK_DEFS`; Deckel ±5 % pro
     Aktie (Summe aller aktiven Impacts); Fade: ~2/3 zurück über ~60 s.
   - Squeeze-Multiplikator: News-Sprung × bis zu 1,5 bei maximaler Gegen-Schieflage.
   - Dämpfung in Herdenrichtung: bis −30 % der Basis-Tick-Bewegung.
   - Rate-Limit: max. 1 Blockorder-Meldung je Spieler je 15 s (serverseitig).

## Phase 1 — Server (worker.js v4 + worker.test.js)

- `rounds` bekommt `expert INTEGER` (0/1) und `cash INTEGER` (Default 25000, nur
  Preset-Werte); `POST /room/{code}/start {expert?, cash?}` nimmt beides, das Aggregat
  liefert es mit der Runde aus.
- Neue Tabelle `trades(code, n, id, p, tick, sym, side, vol, PK(code,n,id))` — `tick` wird
  SERVERSEITIG aus `startAt` gestempelt (nicht dem Client geglaubt), `vol` in groben
  Stufen normalisiert (kein exakter Depotblick). Nur bei `expert=1` angenommen.
- `POST /room/{code}/round/{n}/trade {sym, side, vol}` (x-token, nur Spieler-Rolle,
  Rate-Limit, nur während laufender Runde).
- Aggregat (`GET /room/{code}?me=`) liefert das Trade-Journal der laufenden Runde mit
  (append-only, klein: nur Blockorders). Nachzügler/Resume bekommen es automatisch voll.
- TTL/Aufräumen wie `rounds`/`results`. Tests: Flag-Durchreichung, Stempel-Tick,
  Rate-Limit, Rollen-/Zeitfenster-Checks, Journal im Aggregat, Nicht-Expert → 404/409.

## Phase 2 — Client-Kern (game.js): Flow-Impact + Schlussauktion

- `START_CASH = rd.cash` beim Rundenstart (Anzeige im Raum/Lobby-Kopf, z. B. „💰 50.000 $");
  `updateRecord()` nur bei 25k-Runden.
- Effektivkurs-Schicht NUR im Raum + Expert: `eff[sym][t] = paths[sym][t] × overlay(sym,t)`;
  Overlay deterministisch aus dem Journal (Ramp bei `tick+REACT_TICKS`, Fade, Deckel).
  `price()` liefert im Expert-Raum den Effektivkurs; `drawChart` bekommt die effektiven
  Pfade über das (bereits gebaute) `o.market` gereicht — Kerzen/Linie/Marker gratis.
- `trade()` meldet Blockorders (fire-and-forget POST, Fehler unkritisch — dann eben ohne
  Impact-Meldung); eigener Fill mit halbem Eigen-Impact (Ticket zeigt Ø-Kurs + Hinweis).
- **Schlussauktion:** `endRound` bewertet offene Positionen zum Basis-Kurs; kurzer
  Hinweis im Ergebnis („Schlussauktion zum fairen Kurs").
- Ergebnis-Payload: Journal-Länge/-Hash ins Ergebnis (Verifikation „gleiche Überlagerung");
  neue Stats-Felder → `SPCX5.` → `SPCX6.` bumpen.
- Resume: Journal kommt ohnehin frisch vom Aggregat — kein neuer Snapshot-Inhalt.
- e2e: Zwei-Geräte-Simulation — identischer Effektivkurs auf beiden, Meldung vor Wirkung,
  Slippage kostet, Schlussauktion neutralisiert Last-Second-Pump, Nicht-Expert-Runde und
  alle Offline-Modi weiter mit NULL Impact-Code-Pfaden (Fetch-Zähler bleibt Beweis).

## Phase 3 — Positionsdruck, Stimmungsband, Leinwand

- Schieflage je Aktie aus dem Journal summieren → Dämpfung + Squeeze-/Crash-Multiplikator
  (Wirkung wieder erst `REACT_TICKS` nach der auslösenden News, gedeckelt).
- **Stimmungsband:** kompakte Anzeige der Raum-Schieflage (im Spiel dezent bei der Quote,
  auf der Leinwand als Balken je Aktie); Squeeze als eigene Meldung
  („🔥 SHORT SQUEEZE: NEBULA") inkl. Leinwand-Flash.
- A4-Härten am selben Flag: Short-Dividende + ACT-Haltekosten (kleine, lokale Bausteine
  laut IDEAS.md — auch in Solo denkbar, aber erst hier im Paket).
- Abend-Wertung: optionale Auflösung „größter Marktbeweger" (🐘). Awards („🥷 Leisetreter")
  als späterer Polish.

## Weitere Experten-Bausteine (Kandidaten, noch NICHT entschieden)

Alle rein deterministisch (kein `rnd()`-Verbrauch, kein Server nötig), einzeln schaltbar
denkbar, Reihenfolge = Empfehlung:

1. **⭐ Limit- & Stop-Orders.** Vorgemerkte Orders („kaufe bei ≤ 95", „Stop-Loss bei 88"),
   ausgeführt sobald der Kurs die Schwelle kreuzt (Prüfung in `processTick`). DER
   Tiefgangs-Baustein: Absichern vor News, Abfischen von Panik-Spikes — und im
   Experten-Raum die Profi-Antwort auf Squeezes („Limit in die Blase legen").
   Größter UI-Aufwand der Liste (Order-Verwaltung im Depot), aber alle Modi profitieren.
2. **Spread (Geld-/Briefkurs).** Kaufen leicht über, verkaufen leicht unter Kurs;
   Spanne je Aktie über den `liq`-Trait (Synergie mit dem Impact-Tuning!) und für
   ~30 s verbreitert nach News/Megas („dünnes Buch in der Panik"). Bestraft
   Zappel-Trading realistischer als die flache Gebühr. Kleiner Eingriff in `trade()`.
3. **Handelsstopp (Volatilitätsunterbrechung).** Bei Mega-Panik wird der betroffene
   Wert für ~15 s vom Handel ausgesetzt (Buttons gesperrt, „⛔ Handel ausgesetzt",
   Leinwand-Flash) — wie echte Circuit Breaker: wer den Crash nicht kommen sah,
   kommt nicht mehr raus. Winziger Aufwand (deterministisch aus `market.events`),
   großer Dramamoment.
4. **(Später) Hebel & Margin-Call.** Kaufen auf Kredit mit Zwangsliquidierung bei
   Unterdeckung. Maximales Risiko-Theater, aber balancing-heikel und erklärungs-
   bedürftig — erst evaluieren, wenn der Rest des Pakets steht.

Bereits gesetzt im Paket: dynamischer Markt (nur Raum), Short-Dividende, ACT-Haltekosten
(IDEAS.md A4), Startkapital-Wahl (Entscheidung 8).

## Verifikation

Phase 1: `worker.test.js` erweitert (s. o.). Phase 2/3: `e2e.test.js` als Raum-Simulation
mit Expert-Runden (s. o.), danach echter Test-Abend im Privatkreis mit bewusst kleinen
Impact-Werten; Tuning-Konstanten erst danach anfassen. CI manuell auslösen.

## Grundsätze (gelten unverändert)

Fairness-Kern (`genMarket`/Seed) unantastbar; Offline-Modi machen null Requests; kein
`rnd()`-Verbrauch durch Impact (reine Funktion des Journals); alles hinter dem
Expert-Flag, Standard-Raum spielt exakt wie heute.
