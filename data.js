/* SPCX Trading-Duell – Daten: Aktien, News, Events, Tipps, Awards, Tutorial,
   sowie Tuning-Konstanten. Wird VOR game.js geladen (gemeinsamer globaler Scope). */
const TICK_MS = 1000;
const TICK_SCALE = 700 / TICK_MS;
const REACT_TICKS = Math.round(8000 / TICK_MS);
const STOCK_DEFS = {
  SPCX:{name:"SpaceX",     type:"growth",   start:135.00, sigma:0.0015, drift:0.00001, newsMult:1.25,
        char:"🚀 Hype-Wert: reagiert besonders heftig auf News"},
  TSLA:{name:"Tesla",      type:"growth",   start:312.40, sigma:0.0010, drift:0, momentum:0.45,
        char:"📈 Momentum-Wert: Trends verstärken sich selbst"},
  NVDA:{name:"NVIDIA",     type:"dividend", start:176.80, sigma:0.0008, drift:0, meanRev:0.002,
        char:"🛡️ Stabiler Riese: schwankt wenig, zahlt Dividende"},
  RKLB:{name:"Rocket Lab", type:"risk",     start:38.65,  sigma:0.0011, drift:0, spikeP:0.006, spikeMag:0.010,
        char:"🎢 Zock-Papier: lange ruhig, dann plötzliche Sprünge"},
  AMZN:{name:"Amazon",     type:"dividend", start:185.00, sigma:0.0009, drift:0, meanRev:0.0015,
        char:"🐢 Schwergewicht: bedächtig, zahlt Dividende"},
  AAPL:{name:"Apple",      type:"dividend", start:228.00, sigma:0.0007, drift:0, meanRev:0.0025,
        char:"🍎 Sicherer Hafen: ruhig, zahlt Dividende"},
  MSFT:{name:"Microsoft",  type:"dividend", start:430.00, sigma:0.0008, drift:0.00001,
        char:"🏢 Solider Wachstumswert: ruhiger Aufwärtstrend, Dividende"},
  GOOGL:{name:"Alphabet",  type:"growth",   start:190.00, sigma:0.0010, drift:0, newsMult:1.15,
        char:"🔎 Nachrichten-getrieben: reagiert spürbar auf Schlagzeilen"},
  AMD:{name:"AMD",         type:"growth",   start:165.00, sigma:0.0012, drift:0, momentum:0.40,
        char:"⚡ Trendläufer: Bewegungen verstärken sich"},
  META:{name:"Meta",       type:"risk",     start:600.00, sigma:0.0011, drift:0, spikeP:0.005, spikeMag:0.011,
        char:"🎭 Stimmungswert: kann sprunghaft drehen"},
};
const ETF_SYM = "MKT", ETF_BASE = 100.00;
const ETF_DEF = {name:"Markt-ETF", type:"index", start:ETF_BASE,
                 char:"📊 Markt-ETF: ganzer Markt, ruhig, zahlt erhöhte Dividende fürs Sparen"};
/* Zweites synthetisches Instrument: aktiver, gehebelter Wachstumskorb – hohe Vola,
   hohe Ordergebühr, KEINE Dividende, KEIN garantierter Vorteil. Wie MKT abgeleitet. */
const ETF2_SYM = "ACT", ETF2_BASE = 100.00;
const ETF2_DEF = {name:"Aktiv-Fonds", type:"active", start:ETF2_BASE,
                  char:"⚡ Aktiv-Fonds: gehebelter Wachstumskorb – hohe Chance, hohes Risiko, teure Order"};
const ACTIVE_LEV = 3.0;            // Hebel auf die %-Abweichung des Korbs (~Vola der wildesten Aktie)
const ACTIVE_FEE_PCT = 0.005;      // 0,5 % Ordergebühr (≈3× normal)
// Korbgewichte: Wachstums-/Risiko-Werte stark über-, Dividendenwerte untergewichtet
const ACTIVE_WEIGHTS = {SPCX:3, TSLA:2.5, RKLB:2, AMD:2, META:2, GOOGL:1.5, NVDA:1, AMZN:0.5, AAPL:0.5, MSFT:0.5};
const defOf = sym => STOCK_DEFS[sym] || (sym === ETF_SYM ? ETF_DEF : sym === ETF2_SYM ? ETF2_DEF : undefined);
const DISPLAY_SYMS = [...Object.keys(STOCK_DEFS), ETF_SYM, ETF2_SYM];
const FEE_PCT = 0.0015;                                  // 0,15 % Gebühr je Order (Normalfall)
const feeRate = sym => sym === ETF2_SYM ? ACTIVE_FEE_PCT : FEE_PCT;   // Aktiv-Fonds teurer
const feeOf = (v, sym) => Math.round(v * feeRate(sym) * 100) / 100;   // auf Cent gerundet (keine Float-Drift)
const DIV_PCT = 0.00004;                                 // ~1,7 % Brutto-Dividende übers Spiel (Einzelwerte)
const DIV_PCT_ETF = 0.00006;                             // ~2,5 % – Sparplan-Bonus, macht den Index-Stil konkurrenzfähig
const DIV_PAYOUT = Math.max(1, Math.round(20000 / TICK_MS)); // Dividende wird alle ~20 s sichtbar ausgezahlt
const isDividendSym = sym => { const d = defOf(sym); return !!d && (d.type === "dividend" || sym === ETF_SYM); };
const NEWS_POOL = [
  {t:"SPCX", txt:"Starship-Testflug verläuft fehlerfrei – Booster erneut gelandet.", jump:+0.012, drift:+0.0005, dur:36},
  {t:"SPCX", txt:"Analystenhaus warnt: Bewertung von 1,77 Bio. $ »kaum zu rechtfertigen«.", jump:-0.010, drift:-0.0004, dur:38},
  {t:"SPCX", txt:"Gerücht: Großinvestor will nach Lock-up-Frist verkaufen.", jump:-0.009, drift:-0.0004, dur:30},
  {t:"SPCX", txt:"NASA vergibt weiteren Mond-Auftrag an SpaceX.", jump:+0.010, drift:+0.0004, dur:32},
  {t:"SPCX", txt:"xAI-Sparte verbrennt laut Bericht mehr Geld als erwartet.", jump:-0.007, drift:-0.0003, dur:26},
  {t:"SPCX", txt:"Indexfonds müssen SPCX aufnehmen – Kauforders laufen ein.", jump:+0.009, drift:+0.0004, dur:30},
  {t:"SPCX", txt:"Starlink-Erlöse übertreffen Schätzungen – Analysten erhöhen Kursziel.", jump:+0.011, drift:+0.0005, dur:34},
  {t:"SPCX", txt:"FAA erteilt Genehmigung für kommerzielle Starship-Routineflüge.", jump:+0.010, drift:+0.0004, dur:30},
  {t:"SPCX", txt:"Elon Musk kündigt Ausgliederung der Mars-Missionssparte an.", jump:+0.008, drift:+0.0003, dur:28},
  {t:"SPCX", txt:"Blue Origin gewinnt Ausschreibung, die SpaceX anvisierende hatte.", jump:-0.008, drift:-0.0003, dur:28},
  {t:"SPCX", txt:"Versicherungskosten nach Raketenverlust sprunghaft gestiegen.", jump:-0.008, drift:-0.0003, dur:26},
  {t:"SPCX", txt:"Hedgefonds meldet Short-Position von über 1 % des Streubesitzes.", jump:-0.009, drift:-0.0004, dur:32},
  {t:"TSLA", txt:"Tesla rollt FSD-Update in Europa breiter aus.", jump:+0.008, drift:+0.0004, dur:28},
  {t:"TSLA", txt:"Robotaxi-Flotte erhält Zulassung für weitere Großstädte.", jump:+0.010, drift:+0.0004, dur:30},
  {t:"TSLA", txt:"Absatzzahlen aus China enttäuschen.", jump:-0.008, drift:-0.0004, dur:28},
  {t:"TSLA", txt:"Rückruf wegen Software-Fehlers trifft Hunderttausende Fahrzeuge.", jump:-0.009, drift:-0.0004, dur:30},
  {t:"TSLA", txt:"Tesla-Energiesparte meldet Rekordumsatz – Analysten überrascht.", jump:+0.009, drift:+0.0004, dur:30},
  {t:"TSLA", txt:"Optimus-Roboter absolviert ersten öffentlichen Kundentest.", jump:+0.010, drift:+0.0004, dur:30},
  {t:"TSLA", txt:"Lieferzahlen für das Quartal klar über den Erwartungen.", jump:+0.009, drift:+0.0004, dur:28},
  {t:"TSLA", txt:"Neues Model-Y-Facelift kommt laut Leak Monate früher als geplant.", jump:+0.007, drift:+0.0003, dur:26},
  {t:"TSLA", txt:"Preissenkungen in Europa drücken die Bruttomarge.", jump:-0.008, drift:-0.0004, dur:28},
  {t:"TSLA", txt:"Institutionelle Anleger fordern mehr Fokus, kritisieren CEO-Ablenkung.", jump:-0.007, drift:-0.0003, dur:26},
  {t:"NVDA", txt:"NVIDIA meldet Großauftrag für Rechenzentrums-GPUs.", jump:+0.008, drift:+0.0004, dur:28},
  {t:"NVDA", txt:"Nächste Chip-Generation kommt früher als geplant.", jump:+0.010, drift:+0.0004, dur:30},
  {t:"NVDA", txt:"Berichte über neue Exportauflagen belasten Chipwerte.", jump:-0.008, drift:-0.0004, dur:28},
  {t:"NVDA", txt:"Großkunde verschiebt laut Insidern Bestellungen.", jump:-0.009, drift:-0.0004, dur:30},
  {t:"NVDA", txt:"Neue Blackwell-Ultra-Chips mit doppelter KI-Rechenleistung vorgestellt.", jump:+0.010, drift:+0.0004, dur:32},
  {t:"NVDA", txt:"Quartalsbericht übertrifft Konsens bei Marge und Umsatz deutlich.", jump:+0.011, drift:+0.0004, dur:30},
  {t:"NVDA", txt:"Tech-Konzern verlängert GPU-Rahmenvertrag um weitere drei Jahre.", jump:+0.008, drift:+0.0003, dur:28},
  {t:"NVDA", txt:"AMD kündigt Konkurrenzchip an – Analysten sehen erste Marktanteilsverluste.", jump:-0.008, drift:-0.0003, dur:28},
  {t:"NVDA", txt:"China-Verkaufsverbot auf weitere Hochleistungschips ausgeweitet.", jump:-0.010, drift:-0.0004, dur:32},
  {t:"NVDA", txt:"Lagerüberhang: Händler schieben Nachbestellungen auf nächstes Quartal.", jump:-0.007, drift:-0.0003, dur:26},
  {t:"RKLB", txt:"Rocket Lab gewinnt Konstellations-Vertrag.", jump:+0.010, drift:+0.0004, dur:28},
  {t:"RKLB", txt:"Neutron absolviert ersten Testflug erfolgreich.", jump:+0.012, drift:+0.0005, dur:32},
  {t:"RKLB", txt:"Neutron-Erststart verschiebt sich erneut.", jump:-0.008, drift:-0.0004, dur:28},
  {t:"RKLB", txt:"Triebwerkstest schlägt fehl – Untersuchung läuft.", jump:-0.009, drift:-0.0004, dur:30},
  {t:"RKLB", txt:"Electron absolviert 60. Flug – Branchenbester Zuverlässigkeitsrekord.", jump:+0.009, drift:+0.0004, dur:28},
  {t:"RKLB", txt:"US-Militär verlängert Rahmenvertrag mit Rocket Lab um fünf Jahre.", jump:+0.011, drift:+0.0005, dur:30},
  {t:"RKLB", txt:"NASA-Ausschreibung: Rocket Lab unter den drei Finalisten.", jump:+0.008, drift:+0.0003, dur:26},
  {t:"RKLB", txt:"Neue Montagehalle in Neuseeland eröffnet – Kapazität verdoppelt.", jump:+0.007, drift:+0.0003, dur:24},
  {t:"RKLB", txt:"Zulieferer meldet Engpass – Startkalender könnte rutschen.", jump:-0.008, drift:-0.0004, dur:28},
  {t:"RKLB", txt:"Konkurrent gewinnt Auftrag, den Rocket Lab angepeilt hatte.", jump:-0.007, drift:-0.0003, dur:26},
  {t:"AMZN", txt:"AWS-Cloudsparte meldet beschleunigtes Wachstum – Marge zieht an.", jump:+0.009, drift:+0.0004, dur:30},
  {t:"AMZN", txt:"Kartellklage gegen Amazons Marktplatz-Praktiken geht in nächste Runde.", jump:-0.008, drift:-0.0003, dur:28},
  {t:"AAPL", txt:"Neues iPhone übertrifft die Vorbestellungsrekorde der Vorgänger.", jump:+0.008, drift:+0.0003, dur:28},
  {t:"AAPL", txt:"Apple verschiebt KI-Funktionen – Analysten zweifeln am Zeitplan.", jump:-0.007, drift:-0.0003, dur:26},
  {t:"MSFT", txt:"Microsoft hebt Copilot-Preise an – Umsatzfantasie treibt den Kurs.", jump:+0.008, drift:+0.0004, dur:28},
  {t:"MSFT", txt:"Cloud-Ausfall legt Azure-Dienste stundenlang lahm.", jump:-0.008, drift:-0.0003, dur:26},
  {t:"GOOGL",txt:"Gemini-Modell gewinnt KI-Benchmarks – Werbegeschäft floriert.", jump:+0.010, drift:+0.0004, dur:30},
  {t:"GOOGL",txt:"Gericht erwägt Aufspaltung von Googles Werbe-Sparte.", jump:-0.010, drift:-0.0004, dur:30},
  {t:"AMD",  txt:"AMD stellt neuen KI-Beschleuniger vor – greift NVIDIA direkt an.", jump:+0.011, drift:+0.0005, dur:30},
  {t:"AMD",  txt:"Schwache Rechenzentrums-Nachfrage drückt AMDs Ausblick.", jump:-0.009, drift:-0.0004, dur:28},
  {t:"META", txt:"Meta meldet Rekord-Werbeumsatz – Reels überholt die Konkurrenz.", jump:+0.010, drift:+0.0004, dur:30},
  {t:"META", txt:"Reality-Labs verbrennt weiter Milliarden – Anleger verlieren Geduld.", jump:-0.009, drift:-0.0004, dur:28},
  {t:"ALL",  txt:"Inflationsdaten besser als erwartet – Markt dreht ins Plus.", jump:+0.004, drift:+0.0002, dur:36},
  {t:"ALL",  txt:"Fed-Mitglied dämpft Zinssenkungshoffnungen.", jump:-0.004, drift:-0.0002, dur:36},
  {t:"ALL",  txt:"Risk-off: Anleger schichten in Anleihen um.", jump:-0.003, drift:-0.0002, dur:30},
  {t:"ALL",  txt:"Jobmarkt-Daten überraschen positiv – Konjunktursorgen schwinden.", jump:+0.004, drift:+0.0002, dur:30},
  {t:"ALL",  txt:"Ölpreisrückgang senkt Inflationserwartungen – Tech-Werte profitieren.", jump:+0.004, drift:+0.0002, dur:32},
  {t:"ALL",  txt:"Starke Bankenzahlen signalisieren robuste Konjunktur.", jump:+0.003, drift:+0.0002, dur:26},
  {t:"ALL",  txt:"M&A-Boom: Fusionswelle treibt den Risikoappetit.", jump:+0.003, drift:+0.0002, dur:28},
  {t:"ALL",  txt:"Geopolitische Spannungen: Anleger ziehen sich aus Tech zurück.", jump:-0.005, drift:-0.0003, dur:36},
  {t:"ALL",  txt:"US-Haushaltsdebatte eskaliert – Unsicherheit belastet Märkte.", jump:-0.004, drift:-0.0002, dur:30},
  {t:"ALL",  txt:"Überraschender Zinsschritt der Fed sorgt für Volatilitätsschub.", jump:-0.005, drift:-0.0003, dur:34},
];
const OPENING_EVENT = {t:"SPCX",
  txt:"Eröffnung: SPCX startet über dem Ausgabepreis von 135 $.",
  jump:+0.012, drift:+0.0006, dur:24};
const MEGA_REACT_TICKS = Math.round(20000 / TICK_MS);
const MEGA_PRE_FRAC = 0.2;  // Anteil der Mega-Bewegung, der als Vor-Beben vorab hereinkriecht
const MEGA_FADE_FRAC = 0.65; // Anteil der Mega-Bewegung, der nach dem Hoch wieder abgegeben wird
const MEGA_POOL = [
  {t:"SPCX", txt:"💥 MEGA: Jahrhundert-Auftrag! Regierung lässt SpaceX die Mond-Basis bauen.", jump:+0.30, drift:+0.0008, dur:40},
  {t:"TSLA", txt:"💥 MEGA: Durchbruch! Teslas neuer Akku lädt in 90 Sekunden voll.",            jump:+0.28, drift:+0.0008, dur:40},
  {t:"NVDA", txt:"💥 MEGA: KI-Partnerschaft! NVIDIA wird Exklusiv-Ausrüster der großen KI-Labore.", jump:+0.26, drift:+0.0008, dur:40},
  {t:"RKLB", txt:"💥 MEGA: Medizin-Durchbruch in Schwerelosigkeit – Rocket-Lab-Kapseln auf Jahre ausgebucht!", jump:+0.32, drift:+0.0009, dur:40},
  {t:"ALL",  txt:"💥 MEGA: Branchenboom! Regierungen verdoppeln weltweit die Raumfahrt- und Tech-Budgets.", jump:+0.20, drift:+0.0006, dur:44},
  {t:"ALL",  txt:"💥 MEGA: Marktpanik! Flash-Crash reißt alle Werte gleichzeitig in die Tiefe.", jump:-0.13, drift:-0.0004, dur:40},
  {t:"SPCX", txt:"💥 MEGA: Musk verkündet vollständige Fusion von SpaceX und Tesla – Märkte rasten aus.", jump:+0.35, drift:+0.0009, dur:44},
  {t:"TSLA", txt:"💥 MEGA: Zulassung erteilt! Vollautonomes Fahren auf allen US-Bundesstraßen genehmigt.", jump:+0.32, drift:+0.0009, dur:40},
  {t:"NVDA", txt:"💥 MEGA: KI-Superzyklus! NATO und EU kaufen gemeinsam 500.000 NVIDIA-Chips.", jump:+0.28, drift:+0.0008, dur:40},
  {t:"ALL",  txt:"💥 MEGA: Zinswende! Fed senkt Leitzins überraschend um 150 Basispunkte – Tech explodiert.", jump:+0.22, drift:+0.0006, dur:44},
  {t:"AAPL", txt:"💥 MEGA: Apple enthüllt eigenen KI-Chip – Branche spricht von Quantensprung.", jump:+0.26, drift:+0.0008, dur:40},
  {t:"AMZN", txt:"💥 MEGA: Amazon übernimmt großen KI-Konzern – Marktdominanz auf Jahre zementiert.", jump:+0.28, drift:+0.0008, dur:40},
  {t:"MSFT", txt:"💥 MEGA: Microsoft sichert sich Exklusivrechte am führenden KI-Modell.", jump:+0.27, drift:+0.0008, dur:40},
];
const MOMENTUM_POOL = {
  upCont: [
    {txt:"%SYM% ist gerade der meistgehandelte Wert – immer mehr Anleger springen auf.", jump:+0.007, drift:+0.0004, dur:28},
    {txt:"Hype um %SYM%: Social-Media-Trader treiben den Kurs weiter.", jump:+0.006, drift:+0.0004, dur:26},
    {txt:"Kaufwelle bei %SYM% – Orderbücher laufen voll.", jump:+0.006, drift:+0.0003, dur:24},
    {txt:"Momentum-Signal: Algorithmen erhöhen %SYM%-Positionen automatisch.", jump:+0.007, drift:+0.0004, dur:26},
    {txt:"%SYM% durchbricht charttechnischen Widerstand – neue Kaufsignale.", jump:+0.008, drift:+0.0004, dur:28},
  ],
  upTake: [
    {txt:"Nach der Rally: Erste Gewinnmitnahmen bei %SYM%.", jump:-0.007, drift:-0.0003, dur:24},
    {txt:"Analysten warnen: %SYM% ist kurzfristig heißgelaufen.", jump:-0.006, drift:-0.0003, dur:24},
    {txt:"Optionen-Ablauf drückt auf %SYM% – Händler rollen Positionen.", jump:-0.006, drift:-0.0003, dur:22},
    {txt:"Fonds-Rebalancing zum Monatsende: %SYM% unter Verkaufsdruck.", jump:-0.007, drift:-0.0003, dur:24},
  ],
  downCont: [
    {txt:"Abwärtsdruck bei %SYM%: Stop-Loss-Verkäufe beschleunigen den Rutsch.", jump:-0.007, drift:-0.0004, dur:26},
    {txt:"Anleger flüchten aus %SYM% – Stimmung kippt.", jump:-0.006, drift:-0.0003, dur:24},
    {txt:"Short-Seller erhöhen Druck auf %SYM% – Borrow-Rate steigt.", jump:-0.007, drift:-0.0004, dur:26},
    {txt:"Negative Berichterstattung häuft sich: %SYM% im Fokus der Kritiker.", jump:-0.006, drift:-0.0003, dur:24},
  ],
  downReb: [
    {txt:"Schnäppchenjäger greifen bei %SYM% zu – Kurs stabilisiert sich.", jump:+0.006, drift:+0.0004, dur:26},
    {txt:"Großanleger nutzt den Rücksetzer bei %SYM% zum Einstieg.", jump:+0.007, drift:+0.0003, dur:24},
    {txt:"Überverkauft-Signal bei %SYM%: Kontra-Trader kaufen.", jump:+0.006, drift:+0.0003, dur:22},
    {txt:"Short-Squeeze zeichnet sich ab: %SYM% dreht plötzlich ins Plus.", jump:+0.008, drift:+0.0004, dur:26},
  ],
};
const CHAIN_POOL = [
  {t:"SPCX",
   rumor:  {txt:"Gerücht: Pentagon prüft Milliardenvertrag mit SpaceX.", jump:+0.005, drift:+0.0002, dur:20},
   confirm:{txt:"Bestätigt: Pentagon vergibt Milliardenvertrag an SpaceX!", jump:+0.014, drift:+0.0005, dur:32},
   deny:   {txt:"Dementi: Pentagon-Vertrag geht an die Konkurrenz.", jump:-0.012, drift:-0.0004, dur:28}},
  {t:"TSLA",
   rumor:  {txt:"Gerücht: Behörde untersucht angeblich Teslas Autopilot-Daten.", jump:-0.005, drift:-0.0002, dur:20},
   confirm:{txt:"Bestätigt: Behörde leitet formale Untersuchung gegen Tesla ein.", jump:-0.012, drift:-0.0005, dur:30},
   deny:   {txt:"Entwarnung: Keine Untersuchung gegen Tesla – Kurs erholt sich.", jump:+0.011, drift:+0.0004, dur:28}},
  {t:"NVDA",
   rumor:  {txt:"Spekulation: NVIDIA soll vor Übernahme eines KI-Startups stehen.", jump:+0.004, drift:+0.0002, dur:20},
   confirm:{txt:"Offiziell: NVIDIA übernimmt KI-Startup – Analysten jubeln.", jump:+0.012, drift:+0.0005, dur:30},
   deny:   {txt:"Übernahme geplatzt: KI-Startup geht an Mitbewerber.", jump:-0.010, drift:-0.0004, dur:28}},
  {t:"RKLB",
   rumor:  {txt:"Gerücht: Rocket Lab soll Mega-Auftrag einer Telekom-Firma erhalten.", jump:+0.006, drift:+0.0003, dur:20},
   confirm:{txt:"Fix: Rocket Lab erhält Mega-Auftrag – größter Deal der Firmengeschichte!", jump:+0.016, drift:+0.0006, dur:32},
   deny:   {txt:"Mega-Auftrag geplatzt: Telekom-Firma entscheidet sich um.", jump:-0.013, drift:-0.0005, dur:30}},
  {t:"TSLA",
   rumor:  {txt:"Gerücht: Apple soll Tesla-Übernahme in Milliardenhöhe prüfen.", jump:+0.008, drift:+0.0003, dur:22},
   confirm:{txt:"Bestätigt: Apple und Tesla geben Übernahme-Letter of Intent bekannt.", jump:+0.018, drift:+0.0006, dur:34},
   deny:   {txt:"Apple-Tesla-Gespräche gescheitert – Kurs gibt Gewinne vollständig ab.", jump:-0.014, drift:-0.0005, dur:30}},
  {t:"NVDA",
   rumor:  {txt:"Spekulation: Regierung könnte NVIDIA aus Sicherheitsgründen unter Aufsicht stellen.", jump:-0.006, drift:-0.0003, dur:20},
   confirm:{txt:"Bestätigt: Kartellamt leitet Missbrauchsverfahren gegen NVIDIA ein.", jump:-0.014, drift:-0.0005, dur:32},
   deny:   {txt:"Entwarnung: Behörde stellt Verfahren gegen NVIDIA ein – Aufatmen am Markt.", jump:+0.012, drift:+0.0004, dur:28}},
  {t:"SPCX",
   rumor:  {txt:"Gerücht: FAA prüft Sicherheitsmängel an Starship-Hitzeschutzplatten.", jump:-0.007, drift:-0.0003, dur:22},
   confirm:{txt:"FAA verhängt vorläufigen Startbann – Untersuchung dauert Wochen.", jump:-0.015, drift:-0.0005, dur:34},
   deny:   {txt:"FAA-Prüfung abgeschlossen: Starship erhält grünes Licht – Erleichterung.", jump:+0.013, drift:+0.0005, dur:30}},
];
const GENERIC_NEWS = {
  up: [
    {txt:"%NAME% meldet überraschend starke Quartalszahlen.", jump:+0.009, drift:+0.0004, dur:30},
    {txt:"Analystenhaus stuft %SYM% hoch – Kursziel angehoben.", jump:+0.008, drift:+0.0004, dur:28},
    {txt:"%NAME% gewinnt Großauftrag – Auftragsbuch gut gefüllt.", jump:+0.010, drift:+0.0004, dur:30},
    {txt:"Institutionelle Anleger bauen ihre %SYM%-Position weiter aus.", jump:+0.007, drift:+0.0003, dur:26},
    {txt:"%NAME% kündigt Aktienrückkaufprogramm an.", jump:+0.008, drift:+0.0003, dur:28},
    {txt:"Durchbruch bei %NAME%: neues Produkt begeistert die Branche.", jump:+0.009, drift:+0.0004, dur:28},
    {txt:"%SYM% im Plus – Schnäppchenjäger und Momentum-Trader greifen zu.", jump:+0.007, drift:+0.0003, dur:24},
  ],
  down: [
    {txt:"%NAME% verfehlt die Umsatzerwartungen der Analysten.", jump:-0.009, drift:-0.0004, dur:30},
    {txt:"Abstufung: Analysten senken das Kursziel für %SYM%.", jump:-0.008, drift:-0.0004, dur:28},
    {txt:"%NAME% warnt vor schwächerem Ausblick fürs Gesamtjahr.", jump:-0.010, drift:-0.0004, dur:30},
    {txt:"Insider-Verkäufe bei %SYM% verunsichern den Markt.", jump:-0.007, drift:-0.0003, dur:26},
    {txt:"Lieferprobleme belasten das Geschäft von %NAME%.", jump:-0.008, drift:-0.0003, dur:28},
    {txt:"Regulierer nimmt %NAME% ins Visier – Anleger werden vorsichtig.", jump:-0.009, drift:-0.0004, dur:28},
    {txt:"Gewinnmitnahmen drücken %SYM% – Stimmung kippt kurzfristig.", jump:-0.007, drift:-0.0003, dur:24},
  ],
};
const GENERIC_CHAINS = [
  {rumor:  {txt:"Gerücht: %NAME% soll vor einem Milliardendeal stehen.", jump:+0.005, drift:+0.0002, dur:20},
   confirm:{txt:"Bestätigt: %NAME% unterzeichnet den Milliardendeal!", jump:+0.014, drift:+0.0005, dur:32},
   deny:   {txt:"Dementi: %NAME%-Deal geplatzt – Konkurrent erhält den Zuschlag.", jump:-0.012, drift:-0.0004, dur:28}},
  {rumor:  {txt:"Spekulation: Behörde prüft angeblich %NAME%.", jump:-0.005, drift:-0.0002, dur:20},
   confirm:{txt:"Bestätigt: Formale Untersuchung gegen %NAME% eingeleitet.", jump:-0.013, drift:-0.0005, dur:30},
   deny:   {txt:"Entwarnung: Keine Untersuchung gegen %NAME% – Kurs erholt sich.", jump:+0.011, drift:+0.0004, dur:28}},
  {rumor:  {txt:"Gerücht: Großinvestor soll bei %NAME% einsteigen.", jump:+0.006, drift:+0.0003, dur:20},
   confirm:{txt:"Bestätigt: Staranleger meldet große Beteiligung an %NAME%.", jump:+0.013, drift:+0.0005, dur:30},
   deny:   {txt:"Dementi: Einstieg bei %NAME% war nur ein Gerücht.", jump:-0.011, drift:-0.0004, dur:28}},
];
const GENERIC_MEGA = [
  {txt:"💥 MEGA: Sensation! %NAME% präsentiert einen revolutionären Durchbruch.", jump:+0.30, drift:+0.0008, dur:40},
  {txt:"💥 MEGA: %NAME% schließt Jahrhundert-Partnerschaft – die Märkte rasten aus.", jump:+0.28, drift:+0.0008, dur:40},
  {txt:"💥 MEGA: Schock bei %NAME% – Großanleger steigt schlagartig aus.", jump:-0.13, drift:-0.0004, dur:40},
];
const DEFAULT_FAVS = ["SPCX","MKT","NVDA","RKLB"]; // Standard-Favoriten der Watchlist (inkl. Markt-ETF)
const DURATIONS = [5, 10, 15];
const MODE_HINTS = {
  solo:   "Du spielst allein und misst dich an deinem eigenen Rekord.",
  local:  "Beide nacheinander auf diesem Gerät – danach wird automatisch verglichen.",
  remote: "Jeder auf seinem Gerät, gekoppelt per 6-stelligem Code – exakt derselbe Markt.",
};
const TIPS = [
  "📰 News wirken erst ~8 Sekunden nach der Schlagzeile – nutze die Lücke zum Handeln.",
  "🤫 Insider-Tipps kündigen ein Ereignis ~50 Sekunden vorher an – positioniere dich früh.",
  "🐻 Mit dem Short-Button verdienst du an fallenden Kursen – auch schlechte News sind eine Chance.",
  "💸 Jede Order kostet 0,15 % Gebühr – ständiges Hin und Her frisst Gewinn.",
  "💰 Dividenden-Aktien wie AAPL, MSFT oder NVDA zahlen fürs Halten – Geduld lohnt sich.",
  "📊 Der Markt-ETF »MKT« bündelt alle Werte: ruhig und ideal für die Langfrist-Strategie.",
  "⚡ Der Aktiv-Fonds »ACT« schwankt stark und kostet mehr Gebühr – hohe Chance, hohes Risiko.",
  "🚀 SPCX reagiert besonders heftig auf News – hohes Risiko, hohe Chance.",
  "💥 Selten schlägt ein Mega-Event ein – ein Vor-Beben im Kurs warnt dich vorher.",
  "🕯️ Die Kerzen-Ansicht zeigt Schwankungen und Wendepunkte deutlicher als die Linie.",
  "⭐ Über »☆ Alle Aktien« legst du deine 4 Watchlist-Favoriten fest.",
  "🎢 Zock-Papiere wie RKLB liegen lange ruhig und springen dann plötzlich.",
  "📈 Gewinne zählen erst, wenn du sie sicherst – verkaufen nicht vergessen.",
  "🏁 Am Ende zählt das Gesamtdepot: Bargeld plus Positionen zum Schlusskurs.",
];
const KING_BADGE = "👑 Börsenkönig";
const AWARDS = [
  {n:"🪑 Zuschauer",         tOnly:true, c:(s,x) => s.trades === 0},
  {n:"💎 Diamond Hands",     c:(s,x) => s.trades <= 4 && x.inv > 0.7 && x.pnl > 0},
  {n:"🚀 Raketenreiter",     c:(s,x) => s.bestPct >= 0.04},
  {n:"🤫 Insider-Flüsterer", c:(s,x) => s.tipTrades >= 1},
  {n:"🔁 Daytrader",         c:(s,x) => s.trades >= 15},
  {n:"🐻 Short-Seller",      c:(s,x) => s.shorts >= 3},
  {n:"🦈 Hai-Trader",        c:(s,x) => s.volume >= 4 * START_CASH},
  {n:"⚡ News-Jäger",        c:(s,x) => s.newsTrades >= 3},
  {n:"🎰 Glückspilz",        c:(s,x) => s.allIns >= 2 && x.pnl > 0},
  {n:"🎰 Vollzocker",        tOnly:true, c:(s,x) => s.allIns >= 3},
  {n:"🧠 Marktflüsterer",    c:(s,x) => x.pnl >= 400},
  {n:"🛡️ Nervenstark",       c:(s,x) => s.maxDD <= 200 && x.inv >= 0.5},
  {n:"📈 Markt geschlagen",  c:(s,x) => x.pnl > x.bh},
  {n:"🔥 Verbrannte Finger", tOnly:true, c:(s,x) => x.pnl <= -400},
  {n:"🛟 Vorsichtsanleger",  tOnly:true, c:(s,x) => x.inv < 0.25},
  {n:"📊 Solider Trader",    tOnly:true, c:() => true},
];
const TUT_TICKS = 170;
const TUT_STEPS = {
  1:{lbl:"Schritt 1/10 · Das Ziel", pause:true, btn:"Los geht's!", next:2,
     text:"🎓 <b>Willkommen beim Trading-Duell!</b> Beide Spieler erleben exakt denselben Markt – " +
          "wer am Ende das größere Plus hat, gewinnt. Du startest mit 25.000 $. " +
          "Hier lernst du ohne Zeitdruck alles Wichtige."},
  2:{lbl:"Schritt 2/10 · Kaufen", pause:true, glow:"buyBtn",
     text:"Erst mal einkaufen: Im Order-Panel ist die Stückzahl <b>5</b> gewählt. " +
          "Tippe jetzt auf <b>Kaufen</b> – du bekommst 5 × SPCX zum aktuellen Kurs."},
  3:{lbl:"Schritt 3/10 · Einstand", pause:false,
     text:"✅ Gekauft! Die gestrichelte Linie im Chart ist dein <b>Einstand</b>. " +
          "Liegt der Kurs darüber, bist du im Plus. Schau kurz zu …"},
  4:{lbl:"Schritt 4/10 · Depot & Gewinn", pause:true, glow:"depotPanel", btn:"Verstanden", next:5,
     text:"📒 Dein <b>Depot</b> rechts zeigt alles Offene: <b>Stück</b>, deinen <b>Einstand</b> und den " +
          "aktuellen <b>Gewinn/Verlust</b>. Ganz oben siehst du dein <b>Live-Ergebnis</b> übers gesamte " +
          "Depot – genau diese Zahl entscheidet am Ende das Duell."},
  5:{lbl:"Schritt 5/10 · Kerzen-Chart", pause:true, cm:"candle", glow:"chartToggle", btn:"Verstanden", next:6,
     text:"🕯️ Über <b>📊 Kerzen</b> wechselst du die Chart-Ansicht. Jede Kerze fasst ~10 Sekunden zusammen: " +
          "Der <b>Körper</b> zeigt Eröffnung→Schluss (<span style=\"color:var(--up)\">grün</span> = gestiegen, " +
          "<span style=\"color:var(--down)\">rot</span> = gefallen), die dünnen <b>Dochte</b> das Hoch und Tief. " +
          "So erkennst du Schwankungen und Wendepunkte deutlicher als in der Linie."},
  6:{lbl:"Schritt 6/10 · Verkaufen", pause:true, cm:"line", glow:"sellBtn",
     text:"📈 Schön gelaufen! Gewinne zählen aber erst, wenn du sie sicherst: " +
          "Tippe jetzt auf <b>Verkaufen</b>. 💸 Achtung: Jede Order kostet eine kleine " +
          "Gebühr (0,15 %) – ständiges Hin und Her frisst Gewinn, Geduld lohnt sich."},
  7:{lbl:"Schritt 7/10 · News", pause:true, btn:"Verstanden", next:8,
     text:"💰 Gewinn gesichert! Jetzt die wichtigste Mechanik: <b>News</b>. Gleich erscheint eine " +
          "Breaking News – der Kurs reagiert aber erst <b>~8 Sekunden später</b>. " +
          "Diese Lücke ist deine Chance: Meldung lesen und handeln, bevor der Markt zieht!"},
  8:{lbl:"Schritt 7/10 · News", pause:false,
     text:"👀 Achte auf die Meldung – und nutze die Sekunden bis zur Kursreaktion: " +
          "bei guten News kaufen, bei schlechten verkaufen."},
  9:{lbl:"Schritt 8/10 · Insider", pause:true, btn:"Weiter", next:10,
     text:"🤫 <b>Insider-Tipps:</b> Manchmal flüstert dir eine vertrauliche Quelle, dass sich bei " +
          "einer Aktie etwas anbahnt – <b>bevor</b> es News gibt (im echten Spiel rund 50 Sekunden " +
          "vorher). Gleich bekommst du so einen Tipp – positioniere dich!"},
  10:{lbl:"Schritt 8/10 · Insider", pause:false,
     text:"Über die <b>Watchlist</b> oben wechselst du zwischen den Aktien. " +
          "Der Tipp verrät nur die Richtung – den Rest machst du draus."},
  11:{lbl:"Schritt 9/10 · Alle Aktien", pause:true, glow:"openStocks",
     text:"⭐ Du handelst nicht nur diese vier! Tippe oben auf <b>»☆ Alle Aktien«</b> – dort warten alle " +
          "<b>10 Werte</b>. Eine Aktie antippen handelt sie direkt. Mit dem <b>Stern</b> legst du deine bis " +
          "zu 4 Watchlist-Favoriten fest. <b>Probier's:</b> nimm einen Stern weg und mach dafür eine neue " +
          "Aktie zum Favoriten."},
  12:{lbl:"Schritt 10/10 · Short & Abschluss", pause:true, glow:"shortBtn", btn:"Test starten", next:13,
     text:"🐻 Letzter Trick: Mit dem <b>Short-Button</b> setzt du auf <b>fallende</b> Kurse (eingedeckt wird " +
          "per Kaufen). Jetzt noch etwa eine Minute freies Spiel – und gleich ein seltenes " +
          "<b>💥 Mega-Event</b>. Beobachte genau!"},
  13:{lbl:"Schritt 10/10 · Mega-Event", pause:false,
     text:"💥 Gleich schlägt ein <b>Mega-Event</b> ein: ein riesiger Sprung mit langer Zündschnur. " +
          "Achte auf das <b>Vor-Beben</b> – der Kurs kriecht schon vorher in die Richtung."},
  14:{lbl:"Schritt 10/10 · Mega-Event", pause:false,
     text:"🚀 Im <b>Hoch</b>! Megas <b>ebben danach wieder ab</b> – ein echtes Verkaufsfenster. " +
          "Wer den Spike mitnimmt und rechtzeitig verkauft, gewinnt groß. Spiel es zu Ende!"},
};
