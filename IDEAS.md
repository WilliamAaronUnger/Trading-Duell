# Ideen & Backlog

Sammlung von Ideen für später — noch **nicht** umgesetzt. Jede Idee mit kurzer Begründung,
Fairness-Einschätzung und Umsetzungs-Notizen, damit sie später schnell aufgegriffen werden kann.

---

## 🎓 Experten-Modus

Ein optionaler Modus für fortgeschrittene Spieler, der realistischere — aber erklärungs-
bedürftigere — Mechaniken zuschaltet. Im Standard-Spiel bleibt alles eingängig; der Experten-Modus
ist bewusst „opt-in". Denkbar als weitere Stufe in der Einzelspieler-/Modus-Auswahl
(analog zur Sandbox), gesteuert über ein eigenes Flag (z.B. `expert`).

### Kandidaten-Mechaniken

**1. Short-Dividende (Leihkosten beim Leerverkauf)**
- *Was:* Wer eine Dividendenaktie (NVDA/AMZN/AAPL/MSFT) oder den MKT shortet, **zahlt** die
  Dividende laufend (Bargeld sinkt), statt sie zu bekommen — so wie an echten Börsen: der
  Leerverkäufer schuldet die Dividende dem Verleiher der Aktie.
- *Warum erst Experten-Modus:* Für Einsteiger verwirrend („warum fließt Geld ab für eine Dividende,
  die ich nie gesehen habe?"). Im Standard bleibt die Dividende ein reiner **Long-Bonus**.
- *Umsetzung (klein):* In der Accrual-Schleife (`game.js`, processTick) den Filter `pos.qty > 0`
  aufheben, sodass `pos.qty * price(sym) * divRate(sym) * TICK_SCALE` bei Shorts negativ wird.
  Anzeige für negative Beträge anpassen: Toast „💸 −X $ Leihgebühr (Short)" statt „kassiert", und
  die Depot-Zeile „Dividende gezahlt" statt „kassiert". Idee: als dezente Variante zunächst ganz
  ohne Toast, nur als Depot-Notiz, um Verwirrung zu minimieren.
- *Fairness:* ✅ Rein deterministisch (kein `rnd()`), symmetrisch für beide Spieler — Determinismus-
  Fairness unberührt. Verbessert sogar die Realismus-Balance (Shorten der ruhigen Werte nicht mehr
  „gratis").

**2. Haltekosten auf den Aktiv-Fonds (ACT)**
- *Was:* Der gehebelte ACT verliert beim Halten laufend etwas (negative „Dividende") — Gegenstück
  zum Sparplan-Bonus, nähert die Decay realer Leveraged-ETFs an und unterstreicht „ACT ist zum
  Traden, nicht zum Parken".
- *Umsetzung:* Gleiche Mechanik wie Dividende, negativer Satz für `ETF2_SYM` (z.B. über `divRate`
  einen negativen Wert für ACT zurückgeben, nur wenn `expert`).
- *Fairness:* ✅ Deterministisch/symmetrisch. ⚠️ **Balance-Vorsicht:** ACT hat bereits die hohe
  0,5 %-Ordergebühr — Haltekosten zusätzlich könnten doppelt bestrafen. Vorher mit Tuning prüfen.

### Offene Design-Fragen
- Wo sitzt der Experten-Schalter in der UI (eigene Modus-Stufe vs. Checkbox)?
- Zählt ein Experten-Spiel zum lokalen Rekord, oder eigener Rekord (wie Sandbox ausgenommen)?
- Im Remote-Duell: beide Geräte müssen denselben `expert`-Zustand haben → am besten in den
  Spielcode kodieren (wie schon die Dauer über `code % 3`), damit es nicht auseinanderläuft.

---

## 🌐 Online-Anbindung (Evaluation, Juni 2026 — noch nicht umgesetzt)

Ziel: den manuellen Austausch (Ergebnis-Code kopieren, Minuten-Trick der Lobby) durch eine
kleine Online-Schicht ersetzen. Wichtig: Der Server tauscht nur **kleine Zustandshäppchen**
(bereit-Signal, P&L-Zahl, Ergebnis) — der Markt bleibt lokal & deterministisch (`genMarket`),
deshalb reicht ein Mini-Backend im Gratis-Tarif. Alles muss ohne Netz sauber zum heutigen
manuellen Austausch degradieren; Solo/Lokal/Sandbox/Tutorial bleiben voll offline.

### Anbieter-Vergleich (alle ohne SDK, per fetch/EventSource — projektkonform)
- **Firebase Realtime DB** (REST + SSE): bequemste Fertiglösung, Live-Streaming eingebaut.
  Haken: Google; Security Rules (write-once für Ergebnisse!) in eigener Regel-Syntax.
- **Cloudflare Worker + KV** (~100 Zeilen eigene Mini-API, im Dashboard einfügbar): volle
  Kontrolle, kein Google, Regeln sind normaler JS-Code, Gratis-Tarif schläft nie. Live-Updates
  = Polling oder Durable-Object-WebSocket (mehr Aufwand als Firebase-SSE).
- **ntfy.sh** (POST + SSE): schnellster Prototyp, aber öffentliche 6-stellige Topics sind
  mitlesbar, keine echte Persistenz → nicht für den Dauerbetrieb.
- **Supabase**: ❌ Gratis-Projekt pausiert nach 1 Woche Inaktivität — K.-o. fürs Hobby-Spiel.
- **QR-Ergebnis-Austausch (0 Server!)**: Ergebnis-Screen zeigt das Ergebnis als QR, Gegner
  scannt → Vergleich öffnet sich. Encoder+Scanner existieren schon; Payload (~200–270 Zeichen)
  braucht Encoder-Erweiterung um 2–3 Versionen (Test-Harness vorhanden). Nur „nebeneinander",
  kein Live-P&L — Ergänzung, kein Ersatz.

### Funktions-Fahrplan
1. **Auto-Ergebnisvergleich** (hochladen unter Spiel-Code, Gegner-Ergebnis abholen → Vergleich
   öffnet sich bei beiden) + **echte Lobby** („Gegner beigetreten ✓", Start wenn beide bereit).
2. **Live-Gegner-P&L** während der Runde (nur die Zahl, NICHT Positionen — sonst Strategie-
   Kopieren möglich); optional Zuschauer-Modus über den Code.
3. **Tages-Challenge**: alle spielen denselben Tages-Seed, Bestenliste — beim Seed-Design fast
   geschenkt. Global-Bestenliste braucht Missbrauchs-Schutz (Namen, Plausibilität).

### Voll zufälliger, geheimer Seed (Fairness-Upgrade)
Heute ist der 6-stellige Code zugleich der Seed → der Ersteller könnte den Code **vorspielen**
(Mega-Timing kennen), und es gibt nur ~333k Märkte je Dauer. Mit Server: **Beitritts-Code und
Seed entkoppeln** — der Code bleibt die teilbare Einladung, der Server erzeugt den Seed voll
zufällig (voller 32-bit-Raum) und verrät ihn beiden Geräten **erst zum synchronen Start**.
Niemand kann vorspielen; `genMarket(seed)` und die ganze Determinismus-Mechanik bleiben
unverändert. Tages-Challenge: Seed wird zur festen Uhrzeit veröffentlicht. Snapshot/Resume
speichert dann den vollen Seed statt nur des Codes. Optional: „Zufälliger Gegner"-Matchmaking
(offener Lobby-Pool) auf derselben Basis.

### Randbedingungen
- CSP in `index.html`: `connect-src` um die eine Backend-Origin erweitern (eine Zeile).
- Anti-Cheat bleibt Vertrauenssache (Ergebnisse entstehen im Client — wie heute beim manuellen
  Code). Für öffentliche Bestenlisten: Plausibilitätsgrenzen; theoretisch Server-Replay möglich.
- Datenschutz: erstmals Spielerdaten (Name, Ergebnis) auf Fremdserver → Satz in der README.
- Empfehlung: Stufe 1 zuerst; Backend-Wahl = Cloudflare Worker (ohne Google, eigene Regeln)
  oder Firebase RTDB (am wenigsten eigener Code). Beides kostenlos.

---

## ✅ Umgesetzt (nicht mehr offen)

- **QR-Code in der Lobby + Scan-Button** (v47/v48): Eigener abhängigkeitsfreier QR-Encoder
  (`qr.js`, Byte-Modus, Versionen 1–10, EC-Level M, per Round-Trip gegen einen QR-Decoder
  verifiziert) zeigt den `?join=<code>`-Link als QR unter „Einladung teilen". Start-Screen hat
  einen „📷 Einladung scannen"-Button: nativer `BarcodeDetector`, wo verfügbar; sonst
  jsQR-Fallback (`jsqr.js`, vendored, lazy nachgeladen) — funktioniert damit auch in
  iOS Safari. Rein clientseitig, fairness-neutral.
