# Sicherheit

Trading Duell ist eine reine Client-PWA ohne Server, ohne Backend und
ohne Abhängigkeiten. Es gibt keine Accounts, keine Datenbank und keine
personenbezogenen Daten, die übertragen werden – das Spiel läuft vollständig
im Browser.

## Bedrohungsmodell

Die einzige extern stammende Eingabe ist der eingefügte Ergebnis-Code des
Gegners (`SPCX3.…`) im Zwei-Geräte-Modus. Er wird in `unpackResult()`
abgesichert:

- Präfix- und Feldanzahl-Prüfung, Base64-Decodierung in `try/catch`.
- Numerische Felder werden geparst und auf `NaN` geprüft.
- Frei wählbare Texte (Name, Lieblingsaktie) werden längenbegrenzt und beim
  Einfügen ins DOM ausnahmslos durch `esc()` HTML-escaped.

## Härtung

- **Content-Security-Policy** (`<meta>` in `index.html`): `default-src 'self'`
  unterbindet externe Quellen und Daten-Abfluss; `object-src 'none'` blockt
  Plugins. Inline-Script/-Style ist erlaubt, weil die komplette App in einer
  Datei lebt.
- **Referrer-Policy** `no-referrer`.

Hinweis: `frame-ancestors` (Schutz vor Clickjacking) wirkt nur als echter
HTTP-Header. Wer die App selbst hostet, sollte zusätzlich
`X-Frame-Options: DENY` bzw. `Content-Security-Policy: frame-ancestors 'none'`
serverseitig setzen.

## Schwachstelle melden

Bitte Sicherheitsprobleme über ein privates GitHub Security Advisory oder per
Issue ohne sensible Details melden. Da keine Nutzerdaten verarbeitet werden,
sind die Auswirkungen auf das lokale Spielgerät beschränkt.
