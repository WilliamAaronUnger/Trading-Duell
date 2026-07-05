# Plan: Online-Raum (3. Modus) + Leinwand-Rolle

Status: **Phase 1 + 2 fertig (Server v3 + Client)** — 49 Worker- + 34 E2E-Checks grün,
inkl. Null-Request-Beweis für den Offline-Modus. Gemeinsamer Merge auf main deployt App
und Worker zusammen. Offen: Phase 3 (Leinwand-Großbild).

Alt-Status: Phase 1 (Server v3) fertig — worker.test.js 49/49 grün; liegt auf dem Feature-
Branch und wird BEWUSST erst zusammen mit Phase 2 (Client) auf main gemerged, weil der
Worker sich beim Merge automatisch deployt und App+Server zusammen wechseln müssen.
e2e.test.js ist bis Phase 2 vorübergehend veraltet (testet noch die alte /game-Welt).
Ersetzt konzeptionell die Revanche-Kette (A2) und den stillen Online-Fallback des
„Mehrere Geräte"-Modus. Hintergrund/Evaluation: `IDEAS.md` (A9), `ROADMAP.md`.

## Entschieden (mit Betreiber durchdacht)

1. **Drei Mehrspieler-Wege, klar getrennt:**
   - 📱 **Gleiches Gerät** — wie immer, offline.
   - 📱📱 **Mehrere Geräte (offline)** — strikt OHNE jeden Netz-Request: Code = Seed,
     Minuten-Start, Ergebnistausch per Code/QR. Für Funkloch, Flugzeug, Datensparen.
   - 🌐 **Online-Raum** — der einzige Modus, der den Worker nutzt.
2. **Raum = der Abend, Runden = flüchtig.** Einmal beitreten (QR/`?room=`-Link/6-stelliger
   Code), im Raum sind alle Mitglieder mit Anwesenheits-Punkt sichtbar; der Ersteller
   startet Runde um Runde (je frischer Geheim-Seed). Nach jeder Runde landen alle wieder
   im Raum.
3. **Rundendauer:** bleibt zwischen Runden erhalten, der Ersteller kann sie vor jedem
   Start ändern (5/10/15).
4. **Abend-Wertung: ja.** Der Raum führt eine Tabelle über die Runden (Rundensiege 👑 +
   Gesamt-P&L des Abends), sichtbar im Raum und auf der Leinwand.
5. **Zuspätkommer: ja.** Beitritt auch während laufender Runde (wartet im Raum,
   „Runde läuft – noch X min", spielt ab der nächsten mit).
6. **Leinwand ist eine ROLLE, kein eigenes Wesen:** Jedes Mitglied schaltet zwischen
   🎮 Spielen und 🖥️ Anzeigen um. Anzeigen-Geräte zählen nicht ins Spielerlimit, senden
   keine Ergebnisse und rendern die Großbild-Ansicht. Eine App, kein Extra-HTML.
7. **Spielerlimit: 20 statt 8** (benannte Konstante `MAX_PLAYERS`). Machbar durch den
   Sammel-Endpunkt (konstanter Traffic pro Gerät, egal wie viele mitspielen).
8. **Rückbau:** A2-Revanche-UI + `/rematch`-Endpunkt entfallen („Nächste Runde" im Raum
   ersetzt sie); der Online-Zweig verschwindet aus dem „Mehrere Geräte"-Startpfad.

## Phase 1 — Server (worker.js v3 + worker.test.js) — ✅ umgesetzt

Tabellen: `rooms(code PK, created, lastActive, dur, curRound)`,
`members(code, p, token, name, role, lastSeen, PK(code,p))`,
`rounds(code, n, seed, dur, startAt, PK(code,n))`,
`results(code, n, p, body, created, PK(code,n,p))`, `pnl(code, n, p, v, t, PK(code,n,p))`.

| Endpunkt | Zweck |
|---|---|
| `POST /room {name}` | Raum eröffnen → `{code, token, p:1}` (Ersteller) |
| `POST /room/{code}/join {name}` | Beitreten (auch während Runde) → `{token, p}`; > `MAX_PLAYERS` Spieler-Rollen → 409 |
| `POST /room/{code}/role {token, role}` | 🎮/🖥️ umschalten (wall zählt nicht ins Limit) |
| `POST /room/{code}/start {token, dur?}` | nur Ersteller: Runde `n+1` mit frischem Seed, `startAt = now+10 s`; `dur` optional (sonst wie zuletzt) |
| `GET /room/{code}?me={token}` | **das eine Aggregat** (Poll ~2–4 s): Mitglieder (+`online` aus `lastSeen`), aktuelle Runde (`n`, `dur`, `startAt`, `seed` erst ab Start), Live-P&L der Runde, Ergebnis-Status, Abend-Tabelle. `me` = Herzschlag → `lastSeen`, `lastActive` |
| `PUT /room/{code}/round/{n}/result/{p}` | wie heute (x-token, write-once, `SPCX5.`) |
| `PUT /room/{code}/round/{n}/pnl/{p}` | wie heute (x-token, überschreibbar) |

Abend-Tabelle serverseitig aus `results` abgeleitet (Sieg = höchster P&L der Runde;
Summen-P&L). TTL: 24 h nach `lastActive` (aktiver Abend läuft nie aus); Aufräumen beim
Eröffnen. Alte `/game/*`-Routen entfallen (wir kontrollieren beide Seiten, App + Worker
deployen im selben Push).

## Phase 2 — Client (game.js/index.html/styles.css) — ✅ umgesetzt

- Moduswahl: dritter Unter-Button 🌐 Online-Raum (`mode="room"`); `MODE_HINTS`/Regeltext.
  „Mehrere Geräte" verliert JEDEN api()-Aufruf (strikt offline, alter Minuten-Flow bleibt).
- **Raum-Screen** (eigener Screen wie Statistik): Kopf mit Code + QR + Teilen; Mitglieder-
  liste (Name, Anwesenheits-Punkt, Rolle, 👑-Markierung Ersteller); Abend-Tabelle;
  Dauer-Wahl + „▶️ Runde starten" (nur Ersteller); „🖥️ Als Leinwand anzeigen"-Toggle;
  „Raum verlassen".
- Runden-Schleife: Aggregat-Poll sieht neue Runde → Countdown → `startRound` (wall-clock,
  Markt aus Runden-Seed) → Ende: Ergebnis hochladen → Runden-Rangliste (wie heute) →
  „← Zurück in den Raum" statt Revanche-Knöpfen.
- Persistenz: Raum-Mitgliedschaft (Code, Token, Rolle) in localStorage → Reload/App-Wechsel
  kehrt automatisch in den Raum zurück (ersetzt die Lobby-Persistenz); Snapshot um
  Raum/Runde erweitert (Resume mitten in der Runde wie gehabt).
- Deep-Link `?room=CODE` (QR im Raum nutzt ihn); `?join=` bleibt für den Offline-Modus.
- Live-Rennen/Rangliste laufen unverändert, nur gespeist aus dem Aggregat (weniger Requests).

## Phase 3 — Leinwand-Großbild

Anzeigen-Rolle rendert während der Runde: EIN großes Auto-Fokus-Chart (heißester Wert),
Mini-Chart-Wand, News-Band groß + Vollbild-Einblendung bei Breaking News, Live-Rangliste,
Restzeit; zwischen Runden: Raum-Ansicht groß (QR, Mitglieder, Abend-Tabelle); nach Runden:
Siegerehrung. 16:9-tauglich, in Stream-Kompression lesbar (Discord-Screenshare); Sound/
Konfetti zuschaltbar. Details: `IDEAS.md` A9.

## Verifikation

Phase 1: `worker.test.js` neu auf Raum-API (Rollen, Limit 20, Zuspätkommer, Runden-Serie,
Aggregat, Wertung, Herzschlag). Phase 2: `e2e.test.js` neu als Raum-Simulation (mehrere
Geräte: eröffnen → beitreten → 2 Runden spielen → Tabelle prüft Sieger; Leinwand-Rolle
zählt nicht; Offline-Modus macht null fetch-Aufrufe — Fetch-Stub zählt mit!). Danach
Gerätetest; CI manuell auslösen.
