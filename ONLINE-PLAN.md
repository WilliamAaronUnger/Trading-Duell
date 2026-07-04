# Plan: Online-Stufe 1 — Cloudflare Worker (Auto-Ergebnisvergleich + echte Lobby + Geheim-Seed)

Status: **geplant, noch nicht umgesetzt.** Voraussetzung ist der einmalige Cloudflare-Setup
(siehe „Teil A"). Evaluation & Begründung der Backend-Wahl: siehe `IDEAS.md` (Abschnitt 🌐).

## Ziel

Den manuellen Teil des Zwei-Geräte-Duells durch eine kleine Online-Schicht ersetzen:

1. **Echte Lobby** — „Gegner beigetreten ✓", Start, wenn beide bereit sind (statt Minuten-Trick).
2. **Geheim-Seed (voll zufällig)** — Beitritts-Code ≠ Markt-Seed. Der Server erzeugt den Seed
   zufällig (voller 32-bit-Raum) und verrät ihn erst, wenn der Start feststeht → Vorspielen
   unmöglich. `genMarket(seed)` und die Determinismus-Mechanik bleiben unverändert.
3. **Auto-Ergebnisvergleich** — Ergebnis lädt nach Rundenende hoch; sobald das des Gegners da
   ist, öffnet sich bei beiden der Vergleich. Manuelles Kopieren bleibt als Fallback.
4. **Sauberer Offline-Fallback** — ohne erreichbaren Server verhält sich alles exakt wie heute
   (Code = Seed, Minuten-Start, manueller Austausch). Solo/Lokal/Sandbox/Tutorial: unberührt.

## Teil A — Klickstrecke für den Betreiber (~20–30 Min, einmalig, kostenlos)

1. **Konto:** https://dash.cloudflare.com/sign-up → mit E-Mail + Passwort registrieren
   (kein Zahlungsmittel nötig) → Bestätigungs-Mail anklicken.
2. **Worker anlegen:** Dashboard links **Workers & Pages** → **Create** →
   **Create Worker** → Name: `spcx-duell` → **Deploy** (der Hello-World-Platzhalter ist ok).
3. **Speicher (KV) anlegen:** Dashboard links **Storage & Databases** → **KV** →
   **Create namespace** → Name: `SPCX_GAMES` → anlegen.
4. **Worker mit Speicher verbinden:** zurück zu **Workers & Pages** → Worker `spcx-duell` →
   **Settings** → **Bindings** → **Add** → **KV namespace** →
   Variable name: `GAMES` (exakt so, Großbuchstaben) → Namespace `SPCX_GAMES` wählen → Save.
5. **Code einspielen:** im Worker **Edit code** → Inhalt der Datei `worker.js` aus diesem Repo
   komplett hineinkopieren (alles Vorhandene ersetzen) → **Deploy**.
   *(worker.js entsteht in Teil B — Schritt 5 also erst nach dessen Merge.)*
6. **URL melden:** die Worker-URL kopieren (Form: `https://spcx-duell.<account>.workers.dev`)
   und in die Session geben → sie wird als `ONLINE_API` in `data.js` und in der CSP eingetragen.
7. **Testen:** nach dem Deploy der Spiel-Version mit zwei Geräten ein Duell spielen
   (Lobby-Häkchen, synchroner Start, automatischer Vergleich).

Laufender Aufwand danach: keiner (Gratis-Tarif, 100k Requests/Tag; ein Duell braucht ~200).

## Teil B — Umsetzung (Repo)

### 1. `worker.js` — ✅ umgesetzt (liegt im Repo, wird NICHT von der PWA geladen)
ES-Module-Worker (`export default {fetch}`), KV-Binding `GAMES`, JSON + CORS. Zwei
Verfeinerungen gegenüber dem Grobplan (Begründung im Datei-Header):
- **Start durch den Ersteller statt Doppel-„ready"**: KV ist eventually consistent; ein
  einziger Schreiber für `startAt`/Seed vermeidet Schreib-Rennen. Beitritt gilt als bereit.
- **Spieler-Tokens**: `create`/`join` geben je ein Token zurück; `start` und `result`-PUT
  verlangen es — sonst könnte der Gegner fremde Ergebnis-Slots vorab füllen.

| Methode/Pfad | Zweck | Regeln |
|---|---|---|
| `POST /game` `{dur}` | Spiel anlegen | Join-Code kollisionsgeprüft, `code % 3` = Dauer-Index (Konvention wie offline); geheimer 32-bit-Seed bleibt beim Server; → `{code,dur,token}` |
| `POST /game/{code}/join` | Beitritt | einmalig (sonst 409) → `{dur,token}` |
| `POST /game/{code}/start` `{token}` | Start fixieren | nur Ersteller-Token; erst nach Beitritt; idempotent; `startAt = now + 10 s` → `{startAt,seed}` |
| `GET /game/{code}` | Status pollen | `{joined,dur,startAt, seed?}` — **`seed` nur, wenn `startAt` gesetzt** |
| `PUT /game/{code}/result/{p}` | Ergebnis abgeben | Header `x-token`; **write-once** (409), ≤ 600 Zeichen, nur `SPCX5.`-Präfix |
| `GET /game/{code}/result/{p}` | Gegner-Ergebnis holen | 404 solange nicht da |

Alle KV-Einträge mit `expirationTtl: 86400` (24 h) → räumt sich selbst auf.

### 2. Worker-Tests (Node, im bestehenden Harness-Stil)
`env.GAMES` als Map-Stub; den `fetch`-Handler direkt aufrufen. Fälle: kompletter Happy-Path
(create→join→2×ready→seed erscheint→2×result→gegenseitig abholen), Seed **nicht** vor beidem
ready sichtbar, Doppel-Join 409, Result-Überschreiben 409, kaputte Eingaben 400, TTL gesetzt.

### 3. Client (`game.js`, neue Sektion „Online", ~200 Zeilen; `data.js`; `index.html`)
- `data.js`: `const ONLINE_API = "";` — leer = Online-Schicht komplett aus (heutiges Verhalten).
  Nach Teil A Schritt 6 wird hier die Worker-URL eingetragen.
- Kleiner `api()`-Fetch-Wrapper mit 4-s-Timeout; jeder Fehler ⇒ stiller Rückfall auf den
  Offline-Pfad (das Spiel darf **nie** an der Cloud hängen).
- **Lobby:** Anlegen → `POST /game` (Code kommt vom Server); Beitritt → `join`. Anzeige
  „Gegner: beigetreten ✓ / wartet…", Bereit-Button; Polling ~2 s; `startAt` + Seed vom Server →
  `marketSeed` (neu, getrennt von `gameCode`) → `genMarket(marketSeed, ticks)`; Countdown wie
  gehabt ab `startAt`. QR/Teilen-Button bleiben (teilen weiter nur den Join-Code).
- **Ergebnis:** `endRound` lädt `packResult` hoch (`PUT result/{p}`); Ergebnis-Screen zeigt
  „Warte auf Gegner…" und pollt (~3 s, mit Deckel); sobald da → bestehendes `renderCompare`.
  Manuelle `cmpBox` bleibt als Fallback sichtbar.
- **Payload-Version `SPCX5`:** Feld `marketSeed` kommt mit hinein und wird beim Vergleich
  geprüft — verhindert stille Unfairness, wenn ein Gerät mit alter Version (Code=Seed) einen
  anderen Markt gespielt hat; alte Clients lehnen `SPCX5.…` sauber als unlesbar ab.
  (`unpackResult` akzeptiert beim manuellen Einfügen weiterhin `SPCX4` für Offline-Spiele.)
- **Snapshot:** um `marketSeed` erweitert (Resume baut den Markt daraus); Einträge ohne
  Feld fallen wie bisher auf `gameCode` zurück → alte Snapshots bleiben gültig.
- `index.html`: CSP `connect-src 'self'` um die Worker-Origin erweitern; Lobby-Zeile für den
  Gegner-Status + Bereit-Button.
- **Nicht angefasst:** `genMarket`/`rnd()`-Reihenfolge, Solo/Lokal/Sandbox/Tutorial, QR/Scanner.

### 4. Verifikation
- Worker-Tests (Punkt 2) grün.
- Client-Integrationstest im Node-DOM-Stub: zwei simulierte Clients gegen den echten
  Worker-Handler (in-memory) — identischer `marketSeed` auf beiden, identische Pfade,
  Auto-Vergleich öffnet, Offline-Simulation (api wirft) ⇒ exakt heutiges Verhalten.
- Browser-/Gerätetest laut Teil A Schritt 7.
- `sw.js`: Cache-Version bumpen. `worker.js` NICHT in `FILES` (gehört nicht zur PWA).

### Offene Punkte für spätere Stufen (nicht Teil von Stufe 1)
Live-Gegner-P&L (Polling ~3 s), Zuschauer-Modus, Tages-Challenge (Server veröffentlicht
Tages-Seed zur festen Uhrzeit), Bestenliste (+ Namens-Moderation, Plausibilitätsgrenzen),
Datenschutz-Satz in der README, Rate-Limiting im Worker, ggf. Durable-Object-WebSocket.
