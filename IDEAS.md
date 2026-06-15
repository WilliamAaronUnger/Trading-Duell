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
