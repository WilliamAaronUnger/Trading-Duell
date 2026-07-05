"use strict";

/* ====================== Konfiguration ====================== */
let START_CASH = 25000;
/* Pool-Daten (dur, Event-Abstände, Drift pro Tick) sind auf 0,7-s-Ticks kalibriert –
   dieser Faktor rechnet sie auf die aktuelle Tick-Länge um, damit alles in
   Sekunden gemessen gleich bleibt */
/* Vorlauf zwischen News-Anzeige und Kursreaktion: Zeit zum Reagieren */

/* Drift ~neutral: Aktien können im Plus UND im Minus enden – nur SPCX hat minimal IPO-Rückenwind.
   Jede Aktie hat einen eigenen Charakter:
   - newsMult: News-Sprünge wirken stärker/schwächer (Hype-Wert)
   - momentum: jüngerer Trend verstärkt sich selbst (Momentum-Wert)
   - meanRev:  Kurs wird zur Eröffnung zurückgezogen (stabiler Riese)
   - spikeP/spikeMag: seltene, plötzliche Einzelsprünge (Zock-Papier) */
/* type steuert nur die Balance (Dividenden), NICHT die Marktgenerierung:
   dividend = zahlt pro Tick eine kleine Dividende an Long-Halter,
   growth/risk = keine Dividende. */

/* Handelbarer Gesamtmarkt-Index (Sparplan-Strategie). Bewusst AUSSERHALB von
   STOCK_DEFS, damit alle rnd()-Schleifen in genMarket ihn automatisch ausschließen
   (er ist abgeleitet, kein Random-Walk, nie News-Ziel). Sein Pfad wird am Ende von
   genMarket aus den 10 echten Aktien gemittelt. */
/* alle anzeig-/handelbaren Symbole (echte Aktien + Index) */

/* ---- Balance-Stellschrauben (playtest-bedürftig) ---- */

/* News: kleinere Sprünge, dafür längere Drift-Phasen → fließendere Bewegungen.
   Pool bewusst ausbalanciert: SPCX dominiert nicht – auch TSLA/NVDA/RKLB
   bekommen gleich viele und ähnlich kräftige Stories. */


/* Mega-Events: seltene Spezialereignisse mit gewaltigem Sprung (~50 % der
   Spiele, höchstens eines). Statt Vorwarnung gibt es eine lange Zündschnur:
   Der Kurs reagiert erst MEGA_REACT_TICKS (~20 s) nach der Meldung – genug
   Zeit zum Aufspringen UND zum Eindecken offener Shorts. Positive Events
   +20–40 %, die Marktpanik bewusst gedeckelt (Verluste nie vernichtend).
   newsMult wird hier nicht angewendet, damit die Größenordnung planbar bleibt.
   Bewusst NICHT in den Insider-Tipps: Mega-Events bleiben unangekündigt. */

/* Momentum-News: beziehen sich auf die Aktie, die gerade am stärksten läuft (%SYM% wird ersetzt) */

/* Mehrstufige News: erst ein Gerücht (kleiner Effekt), 1,5–2,5 Min später
   die Auflösung – Bestätigung (großer Sprung) oder Dementi (Umkehr) */

/* Generische Vorlagen (%SYM% = Ticker, %NAME% = Firmenname). Garantieren, dass
   JEDE Aktie – auch ohne handgeschriebene Stories – zuverlässig News bekommt.
   Werden in genMarket pro Aktie instanziiert; Magnituden im Band der Einzel-News. */



/* ====================== Helpers ====================== */
const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2}) + " $";
const sgn = n => (n>=0?"+":"") + fmt(n);
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* Seeded PRNG, damit beide Runden den identischen Markt bekommen */
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ====================== Markt vorab generieren ====================== */
/* market = { paths: {SYM:[preise...]}, events: [{tick, t, txt, tag}] } */
let market = null;

function genMarket(seed, ticks){
  const rnd = mulberry32(seed);
  const g = () => {
    let u=0,v=0;
    while(u===0)u=rnd();
    while(v===0)v=rnd();
    return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  };

  const events = [];
  const paths = {};
  const prices = {};
  for(const [sym,d] of Object.entries(STOCK_DEFS)){
    paths[sym] = [d.start];
    prices[sym] = d.start;
  }

  /* Platzhalter in News-Vorlagen füllen (%SYM% = Ticker, %NAME% = Firmenname). */
  const fillTpl = (txt, sym) => {
    const name = (STOCK_DEFS[sym] && STOCK_DEFS[sym].name) || sym;
    return txt.replace(/%SYM%/g, sym).replace(/%NAME%/g, name);
  };

  /* Pro-Aktie-Kandidatenpool: handgeschriebene Einträge ∪ generische Vorlagen.
     Garantiert, dass jede Aktie News bekommt. Verbraucht KEIN rnd() → fairness-neutral. */
  const symList = Object.keys(prices);
  const handBySym = {}; const allNews = [];
  for(const ev of NEWS_POOL){
    if(ev.t === "ALL"){ allNews.push(ev); continue; }
    (handBySym[ev.t] ||= []).push(ev);
  }
  const candBySym = {};
  for(const sym of symList)
    candBySym[sym] = [...GENERIC_NEWS.up, ...GENERIC_NEWS.down, ...(handBySym[sym] || [])];

  let effects = [];
  let pendingJumps = [];
  let lastEventSym = null; // bricht die Momentum-Schleife: nie zweimal dieselbe Aktie in Folge
  let nextEvent = Math.round((30 + Math.floor(rnd()*40)) * TICK_SCALE);
  let chainQueue = [];                // geplante Auflösungen (Bestätigung/Dementi)

  // Generische Ketten an jede Aktie binden, mit handgeschriebenen mischen (kein rnd())
  const genChainInstances = [];
  for(const sym of symList)
    for(const tpl of GENERIC_CHAINS)
      genChainInstances.push({t:sym, rumor:tpl.rumor, confirm:tpl.confirm, deny:tpl.deny});
  const chainsLeft = [...CHAIN_POOL, ...genChainInstances]; // jede Kette höchstens einmal pro Spiel

  // Mega-Event vorab würfeln: ~50 % der Spiele, genau eines, im mittleren Spielteil
  let megaAt = -1, megaEv = null;
  if(rnd() < 0.5){
    const genMegaInstances = [];
    for(const sym of symList)
      for(const tpl of GENERIC_MEGA)
        genMegaInstances.push({t:sym, txt:tpl.txt, jump:tpl.jump, drift:tpl.drift, dur:tpl.dur});
    const megaAll = [...MEGA_POOL, ...genMegaInstances];
    megaEv = megaAll[Math.floor(rnd()*megaAll.length)];
    megaAt = Math.min(Math.round(ticks * (0.3 + rnd()*0.45)), ticks - (MEGA_REACT_TICKS + 20));
  }

  /* Sprung einplanen: Kleine News knallen wie bisher in einem Tick rein.
     Extreme Sprünge (vor allem Mega-Events) steigen dagegen über mehrere
     Ticks als Kurve nach oben statt schlagartig – der Gesamtfaktor wird
     gleichmäßig auf die Rampen-Ticks verteilt (factor^(1/n) je Tick).
     Rein deterministisch: der Faktor steht schon fest, er wird nur über
     mehr Ticks gestreckt – kein zusätzliches rnd(), Fairness bleibt. */
  const pushJump = (at, sym, factor, forceRamp) => {
    const dev = Math.abs(factor - 1);
    const rampTicks = forceRamp
      ? forceRamp                                            // erzwungene Rampenlänge (z. B. Mega-Vorbeben)
      : dev < 0.04
        ? 1                                                  // kleine News: sofort
        : Math.max(2, Math.round(Math.min(dev * 50, 14) * 1000 / TICK_MS));
    if(rampTicks <= 1){ pendingJumps.push({at, sym, factor}); return; }
    const per = Math.pow(factor, 1 / rampTicks);            // gleicher Tick-Schritt
    for(let k = 0; k < rampTicks; k++) pendingJumps.push({at: at + k, sym, factor: per});
  };

  /* Event auslösen: News erscheint bei Tick i, der Kurs reagiert erst
     REACT_TICKS später – so bleibt Zeit, auf die Meldung zu reagieren.
     Die rnd()-Aufrufe passieren trotzdem hier, damit die PRNG-Reihenfolge
     deterministisch bleibt. */
  function fire(i, ev, sym){
    const dur = Math.round(ev.dur * TICK_SCALE);
    const resolved = {t:sym, txt:fillTpl(ev.txt, sym),
                      jump:ev.jump, drift:ev.drift, dur};
    const targets = sym === "ALL" ? Object.keys(prices) : [sym];
    const hits = i + REACT_TICKS;
    for(const s of targets){
      // newsMult: Hype-Werte reagieren stärker auf Schlagzeilen
      const mult = STOCK_DEFS[s].newsMult || 1;
      if(resolved.jump) pushJump(hits, s, 1 + resolved.jump * mult * (0.85 + rnd()*0.3));
    }
    if(resolved.drift) effects.push({sym, drift:resolved.drift * TICK_SCALE, from:hits, until:hits + dur});
    if(sym !== "ALL") lastEventSym = sym;
    events.push({tick:i, ev:resolved, tag: resolved.jump > 0 ? "up" : resolved.jump < 0 ? "down" : "neutral"});
  }

  /* Mega-Event: eigene, lange Zündschnur (MEGA_REACT_TICKS) und ohne newsMult.
     Vor-Beben: ein kleiner Teil der Bewegung (~MEGA_PRE_FRAC) kriecht schon in
     den ~12 Ticks VOR dem Hauptschlag in gleicher Richtung herein – ein
     spürbares Warnsignal im Kurs, das aufmerksame Trader rechtzeitig
     aussteigen (vor dem Crash) bzw. eindecken/aufspringen lässt. Der
     Gesamtfaktor bleibt unverändert (preFactor * Rest == factor), nur ein
     Teil der Bewegung wandert zeitlich nach vorne – kein zusätzliches rnd().
     Spike-and-Fade: nach dem Hoch (Ende der Boost-Drift) ebbt ~MEGA_FADE_FRAC
     der Bewegung langsam (~75 s) wieder ab – der Spike wird so zum echten
     Verkaufsfenster statt zum neuen Dauerniveau. Reiner Zeit-Anhang, der den
     bereits gestreuten factor weiterverwendet – kein zusätzliches rnd(). */
  function fireMega(i, ev){
    const dur = Math.round(ev.dur * TICK_SCALE);
    const hits = i + MEGA_REACT_TICKS;
    const targets = ev.t === "ALL" ? Object.keys(prices) : [ev.t];
    const preTicks = Math.max(2, Math.round(MEGA_REACT_TICKS * 0.6));
    const fadeStart = hits + dur;                            // Plateau nach der Boost-Drift
    let fadeTicks = Math.round(75000 / TICK_MS);             // langsames Abebben
    if(fadeStart < ticks - 4){                               // genug Platz bis Spielende?
      fadeTicks = Math.min(fadeTicks, ticks - fadeStart);    // späte Megas faden schneller
    }else{
      fadeTicks = 0;                                         // kein Platz: kein Fade
    }
    for(const s of targets){
      const factor = 1 + ev.jump * (0.9 + rnd()*0.2);
      const preFactor = Math.pow(factor, MEGA_PRE_FRAC);
      pushJump(hits - preTicks, s, preFactor, preTicks);     // sanfter Vorlauf
      pushJump(hits, s, factor / preFactor);                 // Hauptschlag (Rest)
      if(fadeTicks > 1){
        // Rückkehr auf ~ein Drittel der Bewegung; R = Zielniveau / Sprungniveau
        const netTarget = 1 + (factor - 1) * (1 - MEGA_FADE_FRAC);
        pushJump(fadeStart, s, netTarget / factor, fadeTicks);
      }
    }
    if(ev.drift) effects.push({sym:ev.t, drift:ev.drift * TICK_SCALE, from:hits, until:hits + dur});
    if(ev.t !== "ALL") lastEventSym = ev.t;
    events.push({tick:i, ev:{t:ev.t, txt:fillTpl(ev.txt, ev.t), jump:ev.jump, drift:ev.drift, dur},
                 tag: ev.jump > 0 ? "up" : "down", mega:true});
  }

  const LOOKBACK = Math.round(60000 / TICK_MS); // Momentum über die letzte Minute

  for(let i = 1; i <= ticks; i++){
    // Opening-Pop fest am Anfang
    if(i === 3) fire(i, OPENING_EVENT, "SPCX");

    if(i === megaAt) fireMega(i, megaEv);

    // Zufalls-News: ~50% Momentum-News über die gerade "beliebte" Aktie, sonst klassische News
    // Spätgrenze so, dass der verzögerte Kurssprung noch vor Spielende passiert
    if(i === nextEvent && i === megaAt){
      // Kollision mit dem Mega-Event: normale News kurz nach hinten schieben
      nextEvent = i + Math.round(20 * TICK_SCALE);
    }else if(i === nextEvent && i < ticks - (REACT_TICKS + 12)){
      if(rnd() < 0.5){
        let best = null, bestScore = -1;
        for(const sym of Object.keys(prices)){
          if(sym === lastEventSym) continue; // nicht zweimal in Folge dieselbe Aktie
          const back = Math.max(0, i - 1 - LOOKBACK);
          const chg = paths[sym][i-1] / paths[sym][back] - 1;
          // Bewegung relativ zur eigenen Volatilität, sonst gewinnt immer
          // die schwankungsstärkste Aktie (SPCX) – plus ordentlich Zufall
          const score = Math.abs(chg) / STOCK_DEFS[sym].sigma + rnd()*3;
          if(score > bestScore){ bestScore = score; best = {sym, chg}; }
        }
        let pool;
        if(best.chg >= 0) pool = rnd() < 0.65 ? MOMENTUM_POOL.upCont : MOMENTUM_POOL.upTake;
        else              pool = rnd() < 0.5  ? MOMENTUM_POOL.downReb : MOMENTUM_POOL.downCont;
        fire(i, pool[Math.floor(rnd()*pool.length)], best.sym);
      }else if(chainsLeft.length && i < ticks*0.55 && rnd() < 0.35){
        // Mehrstufig: Gerücht jetzt, Auflösung 1,5–2,5 Min später
        const chain = chainsLeft.splice(Math.floor(rnd()*chainsLeft.length), 1)[0];
        fire(i, chain.rumor, chain.t);
        let at = i + Math.round((90 + rnd()*60) * 1000 / TICK_MS);
        at = Math.min(at, ticks - (REACT_TICKS + 8));
        chainQueue.push({at, chain});
      }else{
        // Klassische Einzel-News: erst ZIEL fair wählen, dann Text aus dessen Pool.
        // So bekommt jede Aktie (auch neue) zuverlässig Schlagzeilen.
        const P_ALL = 0.18; // Anteil marktweiter News
        if(allNews.length && rnd() < P_ALL){
          const ev = allNews[Math.floor(rnd()*allNews.length)];
          fire(i, ev, "ALL");
        }else{
          let pickList = symList.filter(s => s !== lastEventSym);
          if(pickList.length === 0) pickList = symList; // Edge: nur eine Aktie
          const target = pickList[Math.floor(rnd()*pickList.length)];
          const cand = candBySym[target];
          fire(i, cand[Math.floor(rnd()*cand.length)], target);
        }
      }
      nextEvent = i + Math.round((60 + Math.floor(rnd()*55)) * TICK_SCALE);
    }

    // Ketten-Auflösung fällig? Bestätigung (65%) oder Dementi (35%)
    for(const c of chainQueue){
      if(c.at === i) fire(i, rnd() < 0.65 ? c.chain.confirm : c.chain.deny, c.chain.t);
    }
    chainQueue = chainQueue.filter(c => c.at > i);

    // Fällige News-Sprünge (REACT_TICKS nach der Meldung) anwenden
    for(const j of pendingJumps){
      if(j.at === i) prices[j.sym] = Math.max(1, prices[j.sym] * j.factor);
    }
    pendingJumps = pendingJumps.filter(j => j.at > i);

    effects = effects.filter(e => e.until > i);

    for(const [sym,d] of Object.entries(STOCK_DEFS)){
      let drift = d.drift * TICK_SCALE;
      for(const e of effects){
        if(e.from <= i && (e.sym === sym || e.sym === "ALL")) drift += e.drift;
      }
      // Charakter der Aktie:
      if(d.momentum) drift += d.momentum * (prices[sym] / paths[sym][Math.max(0, i - 1 - LOOKBACK)] - 1) / LOOKBACK;
      if(d.meanRev)  drift -= d.meanRev * (prices[sym] / d.start - 1);
      if(d.spikeP && rnd() < d.spikeP)
        prices[sym] *= 1 + (rnd() < 0.5 ? -1 : 1) * d.spikeMag * (0.7 + rnd()*0.6);
      let sig = d.sigma;
      if(sym === "SPCX" && i < ticks*0.12) sig *= 1.3;
      if(i > ticks*0.9) sig *= 1.2;
      prices[sym] = Math.max(1, prices[sym] * Math.exp(drift - sig*sig/2 + sig*g()));
      paths[sym].push(prices[sym]);
    }
  }

  /* Insider-Tipps: kündigen zwei echte kommende Events vage an (~50 s Vorlauf).
     Deterministisch aus dem Seed → beide Spieler/Geräte bekommen dieselben Tipps. */
  const lead = Math.round(50000 / TICK_MS);
  const tips = [];
  const candidates = events.filter(e => !e.mega && e.ev.t !== "ALL" && Math.abs(e.ev.jump) >= 0.008 && e.tick > lead + 10);
  for(const [lo, hi] of [[0.12, 0.5], [0.5, 0.95]]){
    const zone = candidates.filter(e =>
      e.tick >= ticks*lo && e.tick < ticks*hi && !tips.some(t => t.eventTick === e.tick));
    if(zone.length){
      const e = zone[Math.floor(rnd()*zone.length)];
      tips.push({tick: e.tick - lead, eventTick: e.tick, sym: e.ev.t, dir: e.ev.jump > 0 ? 1 : -1});
    }
  }
  tips.sort((a,b) => a.tick - b.tick);

  addEtfPath(paths, ticks);
  addActivePath(paths, ticks);
  return {paths, events, tips};
}

/* Markt-ETF-Pfad ableiten: gleichgewichteter Index (jede Aktie auf ihren
   Eröffnungskurs normiert, gemittelt, × ETF_BASE). Rein abgeleitet aus den
   bereits fertigen Pfaden → verbraucht KEIN rnd(), bricht die Fairness nicht.
   Niedrige Vola ergibt sich automatisch (Varianz ≈ 1/√Anzahl). */
function addEtfPath(paths, ticks){
  const syms = Object.keys(STOCK_DEFS);
  const N = syms.length;
  const etf = [];
  for(let t = 0; t <= ticks; t++){
    let acc = 0;
    for(const s of syms) acc += paths[s][t] / STOCK_DEFS[s].start;
    etf.push(acc / N * ETF_BASE);
  }
  paths[ETF_SYM] = etf;
}

/* Aktiv-Fonds-Pfad ableiten: gewichteter, auf Eröffnung normierter Wachstumskorb,
   dann Hebel auf die Abweichung vom Start (ACTIVE_LEV) → deutlich höhere Vola.
   Ebenfalls rein abgeleitet aus den fertigen Pfaden → KEIN rnd(), fairness-neutral. */
function addActivePath(paths, ticks){
  let wsum = 0; for(const s in ACTIVE_WEIGHTS) wsum += ACTIVE_WEIGHTS[s];
  const act = [];
  for(let t = 0; t <= ticks; t++){
    let acc = 0;
    for(const s in ACTIVE_WEIGHTS) acc += ACTIVE_WEIGHTS[s] * (paths[s][t] / STOCK_DEFS[s].start);
    const lev = 1 + ACTIVE_LEV * (acc / wsum - 1); // t=0 → 1 → Start = ETF2_BASE
    act.push(Math.max(1, lev * ETF2_BASE));
  }
  paths[ETF2_SYM] = act;
}

/* ====================== State ====================== */
let players, round, selected, qtyMode;
let chartMode = "line"; // "line" oder "candle" (Kerzenchart), nur Optik
let favorites = DEFAULT_FAVS.slice(); // 4 Watchlist-Favoriten, pro Spiel zurückgesetzt (nur Optik)
let tickCount, matchTicks, paused, over, timer;
let chartRaf = null, lastTickAt = 0; // für flüssige Chart-Animation (rAF-Loop)
/* Zeitanker der laufenden Runde: remote = gemeinsamer Lobby-Start (startAt),
   local = Rundenbeginn. Nur im Remote-Modus spielbestimmend. */
let roundAnchor = 0;

/* Spielmodus: "solo" = Einzelspieler (eine Runde, nur für sich),
   "local" = Mehrspieler am gleichen Gerät (Pass & Play, beide nacheinander),
   "remote" = Mehrspieler auf zwei Geräten, gekoppelt über den Spiel-Code.
   Timing: "solo" und "local" sind tick-basiert (pausierbar); nur "remote" läuft
   nach Weltzeit. Ergebnis: "solo" und "remote" zeigen das eigene Ergebnis. */
let mode = "local";
let sandbox = false;
let sandboxCash = 25000;

let durationMin = 15;
document.querySelectorAll(".dur[data-m]").forEach(b => b.onclick = () => {
  durationMin = +b.dataset.m;
  document.querySelectorAll(".dur[data-m]").forEach(x => x.classList.toggle("active", x === b));
});

document.querySelectorAll(".solosub").forEach(b => b.onclick = () => {
  sandbox = b.dataset.sb === "true";
  document.querySelectorAll(".solosub").forEach(x => x.classList.toggle("active", x === b));
  applySoloUI();
  updateStartBtn();
});

document.querySelectorAll(".cap").forEach(b => b.onclick = () => {
  sandboxCash = +b.dataset.cap;
  document.querySelectorAll(".cap").forEach(x => x.classList.toggle("active", x === b));
});

function applySoloUI(){
  const solo = mode === "solo";
  $("soloSub").style.display  = solo ? "" : "none";
  $("soloHint").style.display = solo ? "" : "none";
  $("capField").style.display = (solo && sandbox) ? "" : "none";
  $("durField").style.display = (solo && sandbox) ? "none" : "";
  $("soloHint").textContent   = sandbox
    ? "Freies Üben ohne Zeitdruck – kein Rekord-Eintrag."
    : "Du spielst allein und misst dich an deinem eigenen Rekord.";
}

/* Spiel-Code: 6 Ziffern, dient direkt als Markt-Seed.
   Code mod 3 kodiert die Spieldauer (5/10/15 Min), damit beide Geräte
   automatisch dieselbe Tick-Anzahl und damit denselben Markt bekommen. */
let gameCode = null;
/* Online-Duell: geheimer Markt-Seed vom Server (Code ≠ Seed → niemand kann vorspielen).
   null = klassisch offline, dann ist der Spiel-Code selbst der Seed. */
let marketSeed = null;
/* Laufendes Online-Spiel {code, token, p:1|2, seed} oder null (offline). */
let onlineGame = null;

function makeCode(durIdx){
  let c = 100000 + Math.floor(Math.random()*900000);
  c -= c % 3; c += durIdx;
  if(c > 999999) c -= 3;
  return c;
}

/* Start-Button-Text richtet sich nach Modus und (im Remote-Modus) danach,
   ob ein gültiger Code zum Beitreten eingetippt wurde. */
function updateStartBtn(){
  if(mode === "solo"){
    $("startBtn").textContent = sandbox ? "Sandbox starten 🏖️" : "Spiel starten 🔔";
    return;
  }
  if(mode === "local"){ $("startBtn").textContent = "Duell starten 🔔"; return; }
  const valid = /^\d{6}$/.test(codeIn.value);
  $("startBtn").textContent = valid ? "Spiel beitreten 🔔" : "Spiel anlegen 🔔";
}


function setMode(m){
  mode = m;
  document.querySelectorAll(".mode").forEach(b => b.classList.toggle("active", b.dataset.mode === m));
  $("field2").style.display    = m === "local" ? "" : "none";   // 2. Name nur bei "Gleiches Gerät"
  $("fieldCode").style.display = m === "remote" ? "" : "none";
  $("label1").textContent = m === "local" ? "Spieler 1 (beginnt)" : "Dein Name";
  if(m !== "remote"){
    codeIn.value = "";
    document.querySelectorAll(".dur[data-m]").forEach(b => b.disabled = false);
  }
  $("modeHint").textContent = MODE_HINTS[m] || "";
  $("codeErr").textContent = "";
  updateStartBtn();
  applySoloUI();
}
document.querySelectorAll(".mode").forEach(b => b.onclick = () => setMode(b.dataset.mode));

/* Oberste Ebene: Einzelspieler vs. Mehrspieler. Mehrspieler blendet die
   Unterauswahl (gleiches/zwei Geräte) ein. */
function setTop(t){
  document.querySelectorAll(".mtop").forEach(b => b.classList.toggle("active", b.dataset.top === t));
  if(t === "single"){
    $("modeSub").style.display = "none";
    setMode("solo");
  }else{
    sandbox = false;
    document.querySelectorAll(".solosub").forEach(b => b.classList.toggle("active", b.dataset.sb === "false"));
    $("modeSub").style.display = "";
    const sub = document.querySelector(".mode.active");
    setMode(sub ? sub.dataset.mode : "local");
  }
}
document.querySelectorAll(".mtop").forEach(b => b.onclick = () => setTop(b.dataset.top));

const codeIn = $("codeIn");
codeIn.addEventListener("input", () => {
  codeIn.value = codeIn.value.replace(/\D/g, "");
  $("codeErr").textContent = "";
  const valid = /^\d{6}$/.test(codeIn.value);
  // Bei gültigem Code ist die Dauer vorgegeben – Buttons sperren und anzeigen
  document.querySelectorAll(".dur[data-m]").forEach(b => b.disabled = valid);
  if(valid){
    durationMin = DURATIONS[+codeIn.value % 3];
    document.querySelectorAll(".dur[data-m]").forEach(x => x.classList.toggle("active", +x.dataset.m === durationMin));
  }
  updateStartBtn();
});

function buildMarket(){
  matchTicks = sandbox
    ? Math.round(60 * 60000 / TICK_MS)
    : Math.round(durationMin * 60000 / TICK_MS);
  market = genMarket(marketSeed == null ? gameCode : marketSeed, matchTicks);
}

function newPlayer(name, color){
  return {name, cash:START_CASH, pos:{}, color, result:null, pendingDiv:0,
          stats:{trades:0, buys:0, sells:0, shorts:0, volume:0, realized:0, best:null, worst:null,
                 allIns:0, newsTrades:0, tipTrades:0, bestPct:0, investedTicks:0, perSym:{},
                 peak:START_CASH, trough:START_CASH, maxDD:0, feesPaid:0, dividends:0}};
}

/* ====================== Lokaler Speicher (Namen + Rekord) ====================== */
/* Bewusst winzig: nur die zuletzt genutzten Namen und der beste je auf diesem
   Gerät erzielte P&L – ein einziger JSON-Schlüssel, wenige hundert Byte.
   Über "Daten löschen" komplett entfernbar. localStorage kann fehlen oder
   gesperrt sein (Privatmodus), darum alles defensiv in try/catch. */
const STORE_KEY = "spcx-duell";
const loadStore = () => { try{ return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }catch(e){ return {}; } };
const saveStore = s => { try{ localStorage.setItem(STORE_KEY, JSON.stringify(s)); }catch(e){} };

/* Laufendes Spiel sichern, damit man nach Neuladen/Schließen fortsetzen kann.
   Der Markt selbst wird NICHT gespeichert – er entsteht deterministisch neu aus
   dem Code; nur Spielzustand (Bargeld, Positionen, Stats, Tick) wandert rein.
   Eigener Schlüssel, getrennt von Namen/Rekord. Tutorial wird nie gesichert. */
const GAME_KEY = "spcx-duell-game";
function saveSnapshot(phase){
  if(tutorial || sandbox || (over && phase !== "handover")) return;
  try{
    localStorage.setItem(GAME_KEY, JSON.stringify({
      v:2, mode, gameCode, durationMin, round,
      startAt: mode === "remote" ? startAt : 0,
      marketSeed, online: onlineGame, // Online-Spiel: Seed ≠ Code + Token fürs Ergebnis-Hochladen
      tickCount, players, phase: phase || "play", ts: Date.now()
    }));
  }catch(e){}
}
function loadSnapshot(){
  try{
    const s = JSON.parse(localStorage.getItem(GAME_KEY));
    if(!s || s.v !== 2) return null;
    if(s.mode !== "local" && s.mode !== "remote" && s.mode !== "solo") return null;
    if(typeof s.gameCode !== "number" || !Array.isArray(s.players) || !s.players.length) return null;
    if(Date.now() - s.ts > 24*3600*1000) return null; // alte Stände nicht wiederbeleben
    return s;
  }catch(e){ return null; }
}
const clearSnapshot = () => { try{ localStorage.removeItem(GAME_KEY); }catch(e){} };

/* Namen merken (beim Spielstart aufgerufen) */
function rememberNames(){
  const s = loadStore();
  s.n1 = $("name1").value.trim().slice(0,14);
  s.n2 = $("name2").value.trim().slice(0,14);
  saveStore(s);
}

/* Rekord aktualisieren, wenn ein abgeschlossenes Ergebnis den Bestwert schlägt.
   Tutorial zählt nicht (wird vom Aufrufer ausgeschlossen). */
function updateRecord(p){
  const s = loadStore();
  if(!s.best || p.result.pnl > s.best.pnl){
    s.best = {pnl: p.result.pnl, name: p.name.slice(0,14), dur: durationMin, date: Date.now()};
    saveStore(s);
  }
}

/* Abgeschlossenes Spiel in die lokale Historie schreiben (neueste zuerst, max. 20).
   Der eingebettete packResult-Code macht jeden Eintrag teil- und vergleichbar. */
function appendGameHistory(p){
  const s = loadStore();
  if(!Array.isArray(s.games)) s.games = [];
  s.games.unshift({date: Date.now(), pnl: p.result.pnl, total: p.result.total,
                   durationMin, name: p.name.slice(0,14), mode, fav: favSym(p), code: packResult(p)});
  if(s.games.length > 20) s.games.length = 20;
  saveStore(s);
}

/* Startbildschirm: Namen vorbelegen, Rekordzeile, Fortsetzen- + Löschen-Button */
function applyStore(){
  const s = loadStore();
  if(s.n1) $("name1").value = s.n1;
  if(s.n2) $("name2").value = s.n2;
  const rec = $("recLine");
  if(s.best){
    rec.innerHTML = `🏆 Rekord: <b>${sgn(s.best.pnl)}</b> · ${esc(s.best.name)} · ${s.best.dur} Min`;
    rec.style.display = "";
  }else{
    rec.style.display = "none";
  }
  const snap = loadSnapshot();
  $("resumeBtn").style.display = snap ? "" : "none";
  $("clearBtn").style.display = (s.n1 || s.n2 || s.best || snap) ? "" : "none";
}

$("clearBtn").onclick = () => {
  try{ localStorage.removeItem(STORE_KEY); }catch(e){}
  clearSnapshot();
  $("name1").value = "Spieler 1";
  $("name2").value = "Spieler 2";
  applyStore();
};

/* Gesichertes Spiel fortsetzen: Markt deterministisch aus dem Code neu erzeugen,
   Spielzustand zurückspielen und an der gemerkten Tick-Position weitermachen. */
$("resumeBtn").onclick = () => {
  const snap = loadSnapshot();
  if(!snap){ applyStore(); return; }
  tutorial = false;
  mode = snap.mode;
  gameCode = snap.gameCode;
  durationMin = snap.durationMin;
  marketSeed = (typeof snap.marketSeed === "number") ? snap.marketSeed : null;
  onlineGame = snap.online || null;
  matchTicks = Math.round(durationMin * 60000 / TICK_MS);
  market = genMarket(marketSeed == null ? gameCode : marketSeed, matchTicks);
  players = snap.players;
  round = snap.round;
  if(mode === "remote") startAt = snap.startAt;
  $("startScreen").classList.remove("show");

  if(snap.phase === "handover"){
    // Lokal: Spieler 1 ist fertig, Übergabe an Spieler 2 wiederherstellen
    over = true;
    $("matchScreen").classList.add("show");
    showHandover(players[0]);
    return;
  }

  startRound(round);          // baut die Runden-UI auf und startet den Tick-Loop
  tickCount = snap.tickCount;  // echte Position wiederherstellen (startRound setzt 0)
  saveSnapshot("play");        // korrigierten Tick sofort sichern (startRound schrieb 0)
  replayNewsUpTo(tickCount);   // vergangene Meldungen still in den Feed zeichnen
  renderAll();
};

applyStore();
setTop("single"); // Startauswahl: Einzelspieler – mode-Variable an die UI angleichen

$("startBtn").onclick = async () => {
  rememberNames();
  onlineGame = null; marketSeed = null; // frischer Zustand für jedes neue Spiel
  if(mode === "solo"){
    // Einzelspieler: ein Spieler, eine Runde, sofortiger Start (keine Lobby)
    START_CASH = sandbox ? sandboxCash : 25000;
    gameCode = makeCode(DURATIONS.indexOf(durationMin));
    buildMarket();
    players = [newPlayer($("name1").value.trim() || "Spieler 1", "var(--p1)")];
    startRound(0);
    return;
  }
  START_CASH = 25000;
  if(mode === "local"){
    gameCode = makeCode(DURATIONS.indexOf(durationMin));
    buildMarket();
    players = [
      newPlayer($("name1").value.trim() || "Spieler 1", "var(--p1)"),
      newPlayer($("name2").value.trim() || "Spieler 2", "var(--p2)"),
    ];
    startRound(0);
    return;
  }

  // Remote: ein Spieler auf diesem Gerät, gekoppelt über den Code.
  // Zuerst online versuchen (echte Lobby + geheimer Seed); ohne Server: wie bisher offline.
  const raw = codeIn.value.trim();
  if(raw && !/^\d{6}$/.test(raw)){
    $("codeErr").textContent = "Der Spiel-Code hat 6 Ziffern.";
    return;
  }
  const joined = !!raw;
  const btn = $("startBtn"), oldTxt = btn.textContent;
  btn.disabled = true; btn.textContent = "Verbinde …";
  try{
    if(joined){
      gameCode = +raw;
      durationMin = DURATIONS[gameCode % 3];
      const own = loadLobbyState();
      if(own && own.code === raw){
        // Eigenes Spiel (z. B. nach Reload den Code erneut eingetippt):
        // Rolle samt Token wiederherstellen statt dem eigenen Spiel beizutreten
        onlineGame = {code: own.code, token: own.token, p: own.p, seed: null};
        durationMin = own.dur;
      }else try{
        const j = await apiJson("/game/" + raw + "/join",
                                {method:"POST", body: JSON.stringify({name: $("name1").value.trim()})});
        onlineGame = {code: raw, token: j.token, p: j.p || 2, seed: null};
        durationMin = j.dur; // die verbindliche Dauer kennt der Server
      }catch(e){
        if(String(e && e.message).includes("409")){
          $("codeErr").textContent = "Beitritt nicht möglich – Spiel ist voll oder schon gestartet.";
          return;
        }
        // 404/Netzfehler: Offline-Duell wie bisher (Code = Seed)
      }
    }else{
      try{
        const c = await apiJson("/game", {method:"POST",
                                body: JSON.stringify({dur: durationMin, name: $("name1").value.trim()})});
        onlineGame = {code: c.code, token: c.token, p: 1, seed: null};
        gameCode = +c.code;
      }catch(e){
        gameCode = makeCode(DURATIONS.indexOf(durationMin)); // Offline-Fallback
      }
    }
  }finally{
    btn.disabled = false; btn.textContent = oldTxt; updateStartBtn();
  }
  if(!onlineGame) buildMarket(); // online kommt der geheime Seed erst mit dem Start
  const guest = onlineGame ? onlineGame.p === 2 : joined; // Rolle kann wiederhergestellt sein
  players = [newPlayer(
    $("name1").value.trim() || (guest ? "Spieler 2" : "Spieler 1"),
    guest ? "var(--p2)" : "var(--p1)"
  )];
  if(onlineGame) saveLobbyState(); // Rolle + Token überleben einen Reload (App-Wechsel!)
  openLobby(guest);
};

/* ====================== Lobby (zeitversetzter Start) ====================== */
/* Start immer zur übernächsten vollen Minute. Geben beide Geräte den Code
   innerhalb derselben Minute ein, landen sie auf demselben Startzeitpunkt
   und spielen zeitgleich – ganz ohne Server. */
let lobbyTimer = null, startAt = 0;

/* Spieltipps für die Wartezeit (Lobby + Vorlauf). Reine Optik – kein rnd()/Fairness-Bezug. */
let tipTimer = null, tipIdx = 0, tipEls = [];
function startTips(ids){
  stopTips();
  tipEls = ids;
  tipIdx = Math.floor(Math.random() * TIPS.length); // nur Anzeige → Math.random ok
  const show = () => { const t = TIPS[tipIdx++ % TIPS.length]; for(const id of tipEls){ const el = $(id); if(el) el.textContent = t; } };
  show();
  tipTimer = setInterval(show, 4500);
}
function stopTips(){ clearInterval(tipTimer); tipTimer = null; }

const hhmm = ms => {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
};

function openLobby(joined){
  $("lobbyEyebrow").textContent = joined ? "Spiel beigetreten" : "Spiel angelegt";
  $("lobbyHead").textContent = joined ? "Auf die Plätze!" : "Bereitmachen!";
  $("lobbyCode").textContent = String(gameCode).padStart(6, "0");
  $("lobbyShare").textContent = "📤 Einladung teilen";
  // QR-Code des Einladungs-Links zeigen (nur wenn es eine teilbare http(s)-URL gibt)
  const joinUrl = shareUrl("join", String(gameCode).padStart(6, "0"));
  const qrOk = joinUrl && typeof drawQR === "function" && drawQR($("lobbyQR"), joinUrl, {size:200});
  $("lobbyQRWrap").style.display = qrOk ? "" : "none";
  clearInterval(lobbyTimer);
  $("lobbyStartBtn").style.display = "none";
  if(onlineGame){
    // Online: der Ersteller startet, sobald der Gegner da ist; der geheime Markt-Seed
    // kommt erst mit dem fixierten Start. Bis dahin: Lobby-Status pollen.
    startAt = 0;
    $("lobbySub").innerHTML = joined
      ? "Beigetreten ✓ – exakt dasselbe Spiel, gleiche Kurse, gleiche News."
      : "Code oder QR an die Mitspieler – bis zu 8 können beitreten; du startest, sobald alle da sind.";
    $("lobbyStartRow").style.display = "none";
    $("lobbyOpp").style.display = "";
    $("lobbyOpp").textContent = joined
      ? "Warte auf den Start durch den Ersteller …"
      : "Noch niemand beigetreten …";
    lobbyTimer = setInterval(pollLobby, 1500);
    pollLobby();
  }else{
    // Offline wie gehabt: Start zur übernächsten vollen Minute (serverloser Gleichstand)
    startAt = (Math.floor(Date.now()/60000) + 2) * 60000;
    $("lobbySub").innerHTML = joined
      ? "Exakt dasselbe Spiel wie auf dem anderen Gerät – gleiche Kurse, gleiche News.<br>" +
        "Wurde es dort in derselben Minute angelegt, startet ihr zeitgleich."
      : `Code fürs zweite Gerät – dort vor <b style="color:var(--text)">${hhmm(startAt - 60000)}</b> Uhr
         beitreten, dann startet ihr zeitgleich.`;
    $("lobbyOpp").style.display = "none";
    $("lobbyStartRow").style.display = "";
    $("lobbyTime").textContent = hhmm(startAt);
    updateLobby();
    lobbyTimer = setInterval(updateLobby, 250);
  }
  $("lobby").classList.add("show");
  startTips(["lobbyTip", "preTip"]); // Tipps während der Wartezeit (auch im Vorlauf-Fenster)
}

function updateLobby(){
  const left = startAt - Date.now();
  if(left <= 0){
    clearInterval(lobbyTimer);
    $("lobby").classList.remove("show");
    $("preStart").classList.remove("show");
    startRound(0); // exakt bei startAt – kein lokales Delay, beide Geräte synchron
    return;
  }
  if(left <= 5000){
    // Letzte 5 s: vom Lobby- ins Vorlauf-Fenster wechseln. An die Weltuhr geankert,
    // daher zählen beide Geräte denselben Wert und starten gleichzeitig bei startAt.
    $("lobby").classList.remove("show");
    $("preNum").textContent = Math.ceil(left/1000);
    $("preStart").classList.add("show");
  }
  $("lobbyCount").textContent = Math.ceil(left/1000) + " s";
}

$("lobbyCancel").onclick = () => {
  clearInterval(lobbyTimer);
  stopTips();
  onlineGame = null; marketSeed = null; // Online-Spiel verwaist einfach (24-h-TTL räumt auf)
  clearLobbyState();
  $("lobby").classList.remove("show");
};

/* ====================== Online (Cloudflare Worker) ====================== */
/* Kleine fetch-Hülle mit Timeout. Jeder Fehler wirft → die Aufrufer fallen still auf den
   Offline-Pfad zurück; das Spiel hängt nie an der Cloud. ONLINE_API leer = Schicht aus. */
async function api(path, opts, timeoutMs){
  if(!ONLINE_API) throw new Error("offline");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 4000);
  try{
    const res = await fetch(ONLINE_API + path, Object.assign({signal: ctl.signal}, opts));
    if(!res.ok) throw new Error("http " + res.status);
    return res;
  }finally{ clearTimeout(t); }
}
const apiJson = async (path, opts) => (await api(path, opts)).json();

/* Lobby-Zustand übersteht Reloads: iOS lädt die PWA beim App-Wechsel (Teilen/Scannen!)
   gern neu – und der Ersteller-Token existiert sonst nur im Speicher. Ohne ihn könnte
   nach einem Reload niemand mehr starten (beide Geräte wären „Gäste"). */
const LOBBY_KEY = "spcx-duell-lobby";
function saveLobbyState(){
  if(!onlineGame) return;
  try{
    localStorage.setItem(LOBBY_KEY, JSON.stringify({
      code: onlineGame.code, token: onlineGame.token, p: onlineGame.p,
      dur: durationMin, name: players && players[0] ? players[0].name : "", ts: Date.now()
    }));
  }catch(e){}
}
const clearLobbyState = () => { try{ localStorage.removeItem(LOBBY_KEY); }catch(e){} };
function loadLobbyState(){
  try{
    const l = JSON.parse(localStorage.getItem(LOBBY_KEY));
    if(!l || !l.code || !l.token || (l.p !== 1 && l.p !== 2)) return null;
    if(Date.now() - l.ts > 20*60000) return null; // verwaiste Lobbys nicht ewig wiederbeleben
    return l;
  }catch(e){ return null; }
}
/* Unterbrochene Online-Lobby wiederherstellen (richtige Rolle inkl. Ersteller-Token).
   Deckt auch den Reload im 10-s-Countdown ab: der Poll liefert startAt+Seed erneut. */
function resumeLobby(l){
  mode = "remote"; sandbox = false; tutorial = false; START_CASH = 25000;
  onlineGame = {code: l.code, token: l.token, p: l.p, seed: null};
  gameCode = +l.code; durationMin = l.dur; marketSeed = null; startAt = 0;
  players = [newPlayer(l.name || (l.p === 2 ? "Spieler 2" : "Spieler 1"),
                       l.p === 2 ? "var(--p2)" : "var(--p1)")];
  openLobby(l.p === 2);
}

/* Lobby-Status pollen (~1,5 s): Ersteller sieht den Beitritt und bekommt den Start-Knopf;
   der Beigetretene wartet auf startAt + Seed. Netz-Aussetzer: einfach nächste Runde. */
async function pollLobby(){
  if(!onlineGame || startAt) return;
  let st;
  try{ st = await apiJson("/game/" + onlineGame.code); }
  catch(e){
    if(String(e && e.message).includes("404")){ // Spiel abgelaufen/unbekannt: klar sagen
      clearInterval(lobbyTimer); clearLobbyState();
      $("lobbyOpp").textContent = "Spiel nicht mehr vorhanden – bitte neu anlegen.";
    }
    return;
  }
  if(st.players && st.players.length) onlineGame.players = st.players; // Roster fürs Ergebnis-Sammeln
  if(st.startAt){ armOnlineStart(st.startAt, st.seed); return; }
  const names = (st.players || []).map(x => x.name);
  if(onlineGame.p === 1){
    if(names.length >= 2){
      $("lobbyOpp").textContent = "Dabei (" + names.length + "): " + names.join(", ");
      const b = $("lobbyStartBtn");
      b.style.display = "";
      b.textContent = "▶️ Jetzt starten (" + names.length + " Spieler)";
    }
  }else if(names.length){
    $("lobbyOpp").textContent = "Dabei (" + names.length + "): " + names.join(", ") +
                                " — der Ersteller startet gleich …";
  }
}
$("lobbyStartBtn").onclick = async function(){
  if(!onlineGame) return;
  this.disabled = true;
  try{
    const s = await apiJson("/game/" + onlineGame.code + "/start",
                            {method: "POST", body: JSON.stringify({token: onlineGame.token})});
    armOnlineStart(s.startAt, s.seed);
  }catch(e){
    $("lobbyOpp").textContent = "Start fehlgeschlagen – bitte nochmal versuchen.";
  }finally{ this.disabled = false; }
};
/* Start ist fixiert, der geheime Seed da: Markt jetzt bauen und auf den gemeinsamen
   Zeitpunkt herunterzählen (beide Geräte teilen dasselbe wall-clock startAt). */
function armOnlineStart(at, seed){
  if(!onlineGame || startAt) return;
  marketSeed = seed >>> 0;
  onlineGame.seed = marketSeed;
  buildMarket();
  startAt = at;
  $("lobbyStartBtn").style.display = "none";
  $("lobbyOpp").textContent = "Gegner bereit ✓ – los geht's!";
  $("lobbyStartRow").style.display = "";
  $("lobbyTime").textContent = hhmm(startAt);
  clearInterval(lobbyTimer);
  lobbyTimer = setInterval(updateLobby, 250);
  updateLobby();
}

/* Nach Rundenende: eigenes Ergebnis hochladen (write-once; 409 nach Resume ist ok).
   Bei 2 Spielern öffnet sich der klassische Duell-Vergleich von selbst, ab 3 Spielern
   die Rangliste, die sich füllt, sobald die anderen fertig sind. */
async function onlineShareResult(p){
  if(!onlineGame || onlineGame.seed == null) return;
  $("cmpWait").style.display = "";
  try{
    await api("/game/" + onlineGame.code + "/result/" + onlineGame.p,
              {method: "PUT", body: packResult(p), headers: {"x-token": onlineGame.token}});
  }catch(e){ /* 409 = schon hochgeladen, Netzfehler = manueller Austausch bleibt */ }
  // Verbindliches Roster holen (falls kurz vor dem Start noch jemand dazukam)
  try{
    const st = await apiJson("/game/" + onlineGame.code);
    if(st.players && st.players.length) onlineGame.players = st.players;
  }catch(e){}
  if((onlineGame.players || []).length > 2) return startRanking(p);
  return pollOppResult();
}

/* ===== Mehrspieler-Rangliste (3–8 Spieler) ===== */
let rankResults = null, rankTimer = null, rankGame = null;
function startRanking(p){
  rankGame = onlineGame;
  rankResults = {};
  const own = unpackResult(packResult(p)); // eigenes Ergebnis in derselben Form wie die fremden
  own.self = true;
  rankResults[rankGame.p] = own;
  $("cmpBox").style.display = "none"; // manueller 1:1-Austausch passt nicht zur Rangliste
  showRankView();
  renderRanking();
  return pollRankResults();
}
function showRankView(){
  $("resTitle").textContent = "Rangliste";
  document.querySelector(".res-row").style.display = "none";
  $("analysis").style.display = "none";
  $("rankBack").style.display = "none";
  $("rankBox").style.display = "";
}
function renderRanking(){
  const roster = rankGame.players || [];
  const rows = roster.map(pl => ({p: pl.p, name: pl.name, res: rankResults[pl.p] || null}))
    .sort((a, b) => (b.res ? b.res.result.pnl : -Infinity) - (a.res ? a.res.result.pnl : -Infinity));
  const done = rows.filter(r => r.res).length;
  $("resSub").textContent = done >= roster.length
    ? "Alle Ergebnisse da – identischer Markt für alle."
    : done + " von " + roster.length + " Ergebnissen da – der Rest erscheint automatisch …";
  let html = "";
  rows.forEach((r, i) => {
    const pos = r.res ? (i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + ".") : "⏳";
    const pnl = r.res
      ? `<span style="color:${r.res.result.pnl >= 0 ? "var(--up)" : "var(--down)"}">${sgn(r.res.result.pnl)}</span>`
      : '<span style="color:var(--muted);font-weight:400">spielt noch …</span>';
    html += `<div class="rank-row${r.res && !r.res.self ? " tap" : ""}${r.res && r.res.self ? " me" : ""}" data-rp="${r.p}">
      <span class="rank-pos">${pos}</span>
      <span class="rank-name">${esc(r.name)}${r.res && r.res.self ? " (du)" : ""}</span>
      <span class="rank-pnl">${pnl}</span></div>`;
  });
  $("rankBox").innerHTML = html;
  // Fertige Mitspieler antippen → gewohnter Zwei-Spalten-Vergleich
  $("rankBox").querySelectorAll(".rank-row.tap").forEach(row => {
    row.onclick = () => showRankDetail(+row.dataset.rp);
  });
}
function showRankDetail(p){
  const o = rankResults && rankResults[p];
  if(!o) return;
  $("rankBox").style.display = "none";
  document.querySelector(".res-row").style.display = "";
  $("analysis").style.display = "";
  renderCompare(soloP, o);
  $("resTitle").textContent = "Vergleich mit " + o.name;
  $("rankBack").style.display = "";
}
$("rankBack").onclick = () => { showRankView(); renderRanking(); };
/* ===== Live-Rennen: eigenen P&L melden + alle abholen (nur Online-Runden) =====
   Reine Anzeige (nur die Zahl, nie Positionen) – Fairness unberührt. ~Alle 5 s ein
   PUT + GET; Netzfehler werden still geschluckt, die Leiste zeigt dann alte Werte. */
let raceTimer = null, racePnls = {};
function startRace(){
  stopRace();
  if(mode !== "remote" || !onlineGame || onlineGame.seed == null) return;
  if(!(onlineGame.players || []).length) return;
  racePnls = {};
  $("raceRow").style.display = "";
  $("raceRow").innerHTML = "";
  raceTimer = setInterval(syncRace, 5000);
  syncRace();
}
function stopRace(){
  clearInterval(raceTimer); raceTimer = null;
  $("raceRow").style.display = "none";
}
async function syncRace(){
  const og = onlineGame;
  if(!og){ stopRace(); return; }
  const own = totalOf(players[round]) - START_CASH;
  try{
    await api("/game/" + og.code + "/pnl/" + og.p,
              {method: "PUT", body: JSON.stringify({pnl: Math.round(own * 100) / 100}),
               headers: {"x-token": og.token}});
  }catch(e){}
  try{
    const r = await apiJson("/game/" + og.code + "/pnl");
    if(onlineGame === og && r.pnls) racePnls = r.pnls;
  }catch(e){}
  if(onlineGame === og) renderRace(own);
}
function renderRace(own){
  const roster = (onlineGame && onlineGame.players) || [];
  if(roster.length < 2) return;
  const rows = roster.map(pl => ({
    p: pl.p, name: pl.name, me: pl.p === onlineGame.p,
    v: pl.p === onlineGame.p ? own : (racePnls[pl.p] !== undefined ? racePnls[pl.p] : null),
  })).sort((a, b) => (b.v === null ? -Infinity : b.v) - (a.v === null ? -Infinity : a.v));
  let html = "";
  rows.forEach((r, i) => {
    const val = r.v === null ? "…" : sgn(r.v);
    const cls = r.v === null ? "" : (r.v >= 0 ? " up" : " down");
    html += `<span class="race-chip${r.me ? " me" : ""}">${i === 0 && r.v !== null ? "👑 " : ""}` +
            `${esc(r.name)} <b class="rc${cls}">${val}</b></span>`;
  });
  $("raceRow").innerHTML = html;
}

/* Fehlende Ergebnisse einsammeln (~3 s Takt, 20-Min-Deckel) und die Liste füllen */
function pollRankResults(){
  clearTimeout(rankTimer);
  const og = rankGame, deadline = Date.now() + 20*60000;
  const tick = async () => {
    if(onlineGame !== og || Date.now() > deadline) return;
    const roster = og.players || [];
    for(const pl of roster){
      if(rankResults[pl.p]) continue;
      try{
        const txt = await (await api("/game/" + og.code + "/result/" + pl.p)).text();
        const o = unpackResult(txt);
        if(o && !o.wrongGame && (o.seed === undefined || (o.seed >>> 0) === og.seed)) rankResults[pl.p] = o;
      }catch(e){ /* 404: spielt noch */ }
    }
    renderRanking();
    if(roster.every(pl => rankResults[pl.p])) return; // vollständig
    rankTimer = setTimeout(tick, 3000);
  };
  return tick();
}
let oppTimer = null;
function pollOppResult(){
  clearTimeout(oppTimer);
  const og = onlineGame, opp = og.p === 1 ? "2" : "1", deadline = Date.now() + 15*60000;
  const tick = async () => {
    if(onlineGame !== og || Date.now() > deadline){ $("cmpWait").style.display = "none"; return; }
    try{
      const txt = await (await api("/game/" + og.code + "/result/" + opp)).text();
      const o = unpackResult(txt);
      if(o && !o.wrongGame && (o.seed === undefined || (o.seed >>> 0) === og.seed)){
        $("cmpWait").style.display = "none";
        renderCompare(soloP, o);
        return;
      }
    }catch(e){ /* 404: Gegner spielt noch */ }
    oppTimer = setTimeout(tick, 3000);
  };
  return tick();
}

/* Einladung teilen: Link mit vorbefülltem Beitritts-Code (?join=…) – der Gegner
   tippt ihn an und muss nur noch seinen Namen eingeben und beitreten. */
$("lobbyShare").onclick = async function(){
  const code = String(gameCode).padStart(6, "0");
  const url = shareUrl("join", code);
  const txt = `🚀 SPCX Trading-Duell – ich fordere dich heraus!\nSpiel-Code: ${code} · ${durationMin} Minuten` +
              (url ? `\nZum Beitreten antippen: ${url}` : "");
  try{
    this.textContent = (await shareOut(txt)) === "geteilt" ? "✅ Geteilt!" : "✅ Kopiert – ab damit an den Gegner!";
  }catch(e){
    if(e && e.name === "AbortError") return; // Teilen-Menü abgebrochen – kein Fehler
    window.prompt("Zum Kopieren markieren:", txt);
  }
};

$("round2Btn").onclick = () => {
  $("handover").classList.remove("show");
  startRound(1);
};

$("rematchBtn").onclick = () => {
  if(cmpFromStats){ // Vergleich kam aus der Statistik – dorthin zurück
    cmpFromStats = false;
    $("rematchBtn").textContent = "Revanche";
    $("overlay").classList.remove("show");
    renderStats();
    $("statsScreen").classList.add("show");
    window.scrollTo(0, 0);
    return;
  }
  $("overlay").classList.remove("show");
  $("matchScreen").classList.remove("show");
  $("startScreen").classList.add("show");
  // Code leeren, sonst würde die Revanche denselben (nun bekannten) Markt abspielen
  codeIn.value = "";
  $("codeErr").textContent = "";
  $("resCard2").style.display = "";
  document.querySelectorAll(".dur[data-m]").forEach(b => b.disabled = false);
  clearSnapshot(); // Spiel ist vorbei – kein Fortsetzen mehr anbieten
  applyStore();    // evtl. neuer Rekord / kein Snapshot → Startbildschirm auffrischen
  updateStartBtn();
  window.scrollTo(0,0);
};

function startRound(r){
  clearLobbyState(); // Runde läuft – ab jetzt deckt der Spiel-Snapshot Reloads ab
  round = r;
  tickCount = 0; paused = false; over = false; newsPaused = false; lastNewsTick = -999;
  clearInterval(preTimer); preTimer = null; $("preStart").classList.remove("show");
  $("newsPop").classList.remove("show");
  selected = "SPCX"; qtyMode = "5";
  favorites = DEFAULT_FAVS.slice(); // Favoriten je Spiel auf Standard zurücksetzen
  document.querySelectorAll(".chip").forEach(x => x.classList.toggle("active", x.dataset.q === "5"));
  $("news").innerHTML = '<div class="empty">Gleich geht\'s los …</div>';
  $("flash").textContent = "";
  $("pauseBtn").textContent = "⏸ Pause";
  // Remote läuft strikt nach Weltzeit – keine Pause möglich; im Tutorial pausiert der Coach
  $("pauseBtn").style.display = (mode === "remote" || tutorial) ? "none" : "";
  $("endSandboxBtn").style.display = sandbox ? "" : "none";
  roundAnchor = mode === "remote" ? startAt : Date.now();
  $("roundTag").textContent = tutorial
    ? "🎓 Tutorial"
    : (mode === "solo" && sandbox)
      ? "🏖️ Sandbox"
      : mode === "solo"
        ? "Einzelspiel"
        : mode === "remote"
          ? `Code ${String(gameCode).padStart(6,"0")}`
          : `Runde ${r+1}/2`;

  const p = players[round];
  $("pillDot").style.background = p.color;
  $("pillName").textContent = p.name;
  $("depName").textContent = p.name;
  $("target").innerHTML = (mode === "local" && round === 1)
    ? `Zu schlagen: <b style="color:${players[0].result.pnl>=0?'var(--up)':'var(--down)'}">${sgn(players[0].result.pnl)}</b>`
    : "";

  buildWatch();
  $("startScreen").classList.remove("show");
  $("matchScreen").classList.add("show");
  window.scrollTo(0,0);
  renderAll(); // Anfangszustand schon zeigen (eingefroren während des Vorlaufs)

  // Spielzeit erst nach dem Vorlauf starten
  const beginTicking = () => {
    stopTips(); // Spiel läuft – keine Wartetipps mehr
    roundAnchor = mode === "remote" ? startAt : Date.now();
    clearInterval(timer);
    timer = setInterval(tick, TICK_MS);
    lastTickAt = performance.now();
    startChartLoop();
    startRace(); // Live-Rennen (nur Online-Runden; sonst sofortiger No-op)
    saveSnapshot("play");
    renderAll();
  };
  // 5-Sekunden-Vorlauf nur für Solo & Local (tick-basiert). Remote ist weltzeit-
  // verankert (Lobby ist der Vorlauf) und das Tutorial startet sofort gecoacht.
  if((mode === "solo" || mode === "local") && !tutorial) runPreStart(beginTicking);
  else beginTicking();
}

/* 3-2-1-Vorlauf: zählt ~5 s herunter, dann ruft cb() den eigentlichen Start auf. */
let preTimer = null;
function runPreStart(cb){
  let n = 5;
  const num = $("preNum");
  num.textContent = n;
  $("preStart").classList.add("show");
  startTips(["preTip"]); // ein paar Tipps auch im Solo/Local-Vorlauf
  clearInterval(preTimer);
  preTimer = setInterval(() => {
    n--;
    if(n <= 0){
      clearInterval(preTimer); preTimer = null;
      num.textContent = "Los!";
      setTimeout(() => { $("preStart").classList.remove("show"); cb(); }, 450);
    }else{
      num.textContent = n;
    }
  }, 1000);
}

/* ====================== Tick (spielt vorberechneten Markt ab) ====================== */
let newsPaused = false;
let lastNewsTick = -999; // für die News-Junkie-Statistik

function price(sym){ return market.paths[sym][Math.min(tickCount, matchTicks)]; }
function open_(sym){ return defOf(sym).start; }

function insiderText(t){
  return t.dir > 0
    ? `Vertrauliche Quelle: Bei ${t.sym} bahnt sich in Kürze etwas Positives an …`
    : `Vertrauliche Quelle: Bei ${t.sym} ziehen dunkle Wolken auf …`;
}

/* Aufgelaufene Dividende auszahlen: aufs Bargeld gutschreiben, in die Statistik,
   und (außerhalb des Catch-ups) als kurzer Toast sichtbar machen. */
function payDividend(p, announce){
  const paid = p.pendingDiv || 0;
  if(paid <= 0){ p.pendingDiv = 0; return; }
  p.pendingDiv = 0;
  p.cash += paid;
  p.stats.dividends = (p.stats.dividends || 0) + paid;
  if(announce) showDivToast(paid);
}
let divToastTimer = null;
function showDivToast(amt){
  const el = $("divToast");
  if(!el) return;
  el.textContent = "💰 +" + fmt(amt) + " $ Dividende";
  el.classList.remove("show"); void el.offsetWidth; // Reflow → Animation neu starten
  el.classList.add("show");
  clearTimeout(divToastTimer);
  divToastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

/* Events und Insider-Tipps des aktuellen Ticks verarbeiten.
   showPopup=false beim Catch-up nach Tab-Schlaf (kein Popup-Stau). */
function processTick(showPopup){
  for(const e of market.events){
    if(e.tick === tickCount){
      pushNews(e.ev.t, e.ev.txt, e.tag);
      lastNewsTick = tickCount;
      if(showPopup) showNewsPop(e);
    }
  }
  for(const t of market.tips){
    if(t.tick === tickCount){
      pushNews(t.sym, insiderText(t), "insider");
      lastNewsTick = tickCount;
      if(showPopup) showNewsPop({ev:{t:t.sym, txt:"🤫 " + insiderText(t)}, tag:t.dir > 0 ? "up" : "down", insider:true});
    }
  }
  const p = players[round], s = p.stats;

  // Dividenden: Dividenden-Aktien (und der ETF) sammeln pro Tick einen kleinen Betrag
  // an; ausgezahlt wird sichtbar gebündelt alle ~20 s. Deterministisch (kein rnd()).
  for(const [sym, pos] of Object.entries(p.pos))
    if(pos.qty > 0 && isDividendSym(sym))
      p.pendingDiv = (p.pendingDiv || 0) + pos.qty * price(sym) * divRate(sym) * TICK_SCALE;
  if(p.pendingDiv > 0 && tickCount % DIV_PAYOUT === 0) payDividend(p, showPopup);

  // Statistik: investierte Zeit, Depot-Spitze/-Tief, max. Rücksetzer
  if(Object.keys(p.pos).length) s.investedTicks++;
  const tv = totalOf(p);
  if(tv > s.peak) s.peak = tv;
  if(tv < s.trough) s.trough = tv;
  if(s.peak - tv > s.maxDD) s.maxDD = s.peak - tv;
}

function tick(){
  if(over) return;
  lastTickAt = performance.now();

  if(mode === "remote"){
    /* Weltzeit-Anker: Spielzeit hängt nur an der Uhr, nie an Pausen oder
       Render-Aussetzern. Beide Geräte (gleicher startAt aus der Lobby)
       bleiben dadurch dauerhaft synchron; nach Tab-Schlaf wird aufgeholt. */
    const target = Math.min(matchTicks, Math.floor((Date.now() - roundAnchor) / TICK_MS));
    while(tickCount < target){
      tickCount++;
      processTick(tickCount === target);
    }
    if(tickCount >= matchTicks){ endRound(); return; }
    saveSnapshot("play");
    renderAll();
    return;
  }

  // Local (Pass & Play): tick-basiert, Pause und News-Popup halten an
  if(paused || newsPaused) return;
  tickCount++;
  processTick(true);
  if(tutorial) tutOnTick();

  if(!sandbox && tickCount >= matchTicks){ endRound(); return; }
  saveSnapshot("play");
  renderAll();
}

/* Breaking-News-Popup. Local: pausiert das Spiel bis zur Entscheidung.
   Remote: Spiel läuft weiter, Popup schließt nach ein paar Sekunden selbst. */
let npTimer = null;

function showNewsPop(e){
  if(mode !== "remote") newsPaused = true; // solo & local: Popup pausiert; remote läuft weiter
  clearTimeout(npTimer);
  if(mode === "remote") npTimer = setTimeout(closeNewsPop, e.mega ? 12000 : 6000);
  const sym = e.ev.t;
  $("npLive").textContent = e.insider ? "Insider" : e.mega ? "Mega-Event" : "Breaking";
  $("npHint").style.display = e.insider ? "none" : "";
  $("npHint").textContent = e.mega
    ? "💥 Gewaltige Kursreaktion in ~20 Sekunden – noch ist Zeit zu handeln!"
    : "⏳ Der Markt reagiert in wenigen Sekunden …";
  $("npSym").textContent = sym === "ALL" ? "MARKT" : sym;
  $("npSym").className = "np-sym " + e.tag;
  $("npCard").className = "np-card " + e.tag + (e.insider ? " insider" : "") + (e.mega ? " mega" : "");
  $("npText").textContent = e.ev.txt;
  const go = $("npGo");
  if(sym === "ALL"){
    go.style.display = "none";
    $("npSkip").textContent = "Weiter";
  }else{
    go.style.display = "";
    go.textContent = "Zu " + sym + " →";
    $("npSkip").textContent = "Ignorieren";
    go.onclick = () => {
      selected = sym;
      buildWatch();
      closeNewsPop();
    };
  }
  $("newsPop").classList.add("show");
}

function closeNewsPop(){
  clearTimeout(npTimer);
  $("newsPop").classList.remove("show");
  newsPaused = false;
  renderAll();
}

/* ====================== Handel ====================== */
/* Positionen: qty > 0 = long, qty < 0 = short (avg = mittlerer Einstiegs-
   bzw. Short-Kurs). Eine Order wechselt nie direkt von long zu short oder
   umgekehrt – erst glattstellen, dann neu eröffnen. */
function shortExposure(p){
  let v = 0;
  for(const [sym,pos] of Object.entries(p.pos)) if(pos.qty < 0) v += -pos.qty * price(sym);
  return v;
}

/* Kein Hebel: offener Short-Gegenwert maximal 1x aktueller Depotwert */
function maxShortQty(p, px){
  return Math.max(0, Math.floor((totalOf(p) - shortExposure(p)) / px));
}

function curQty(){
  const p = players[round];
  const pos = p.pos[selected];
  if(qtyMode === "max"){
    // Gebühr schon einplanen, damit "Max" nicht an Cents scheitert
    const afford = Math.floor(p.cash / (price(selected) * (1 + feeRate(selected))));
    // Bei Short-Position deckt "Max" höchstens alles ein
    return Math.max(1, pos && pos.qty < 0 ? Math.min(afford, -pos.qty) : afford);
  }
  return +qtyMode;
}

/* Statistik je Order: Anzahl, Volumen, All-ins, Trades kurz nach News/Tipps */
function noteTrade(p, value, side){
  const s = p.stats;
  s.trades++; s.volume += value;
  side === "buy" ? s.buys++ : s.sells++;
  s.perSym[selected] = (s.perSym[selected] || 0) + 1;
  if(qtyMode === "max") s.allIns++;
  if(tickCount - lastNewsTick <= Math.round(12000 / TICK_MS)) s.newsTrades++;
  // Insider-Flüsterer: Order auf die getippte Aktie, bevor das Event eintritt
  if(market.tips.some(t => t.sym === selected && tickCount >= t.tick && tickCount < t.eventTick))
    s.tipTrades++;
}

/* cost = eingesetztes Kapital des geschlossenen Teils (für die %-Rendite des Deals) */
function noteClose(p, profit, cost){
  p.stats.realized += profit;
  if(cost > 0) p.stats.bestPct = Math.max(p.stats.bestPct, profit / cost);
  p.stats.best  = p.stats.best  === null ? profit : Math.max(p.stats.best,  profit);
  p.stats.worst = p.stats.worst === null ? profit : Math.min(p.stats.worst, profit);
}

function trade(side){
  if(over) return;
  const p = players[round];
  const px = price(selected);
  const qty = curQty();
  const flash = $("flash");
  const pos = p.pos[selected];

  if(side === "buy"){
    if(pos && pos.qty < 0){
      // Short eindecken: zurückkaufen, Gewinn = (Short-Kurs − Kaufkurs) × Stück
      const q = Math.min(qty, -pos.qty, Math.floor(p.cash / (px * (1 + feeRate(selected)))));
      if(q < 1){ flash.textContent = "Nicht genug Bargeld zum Eindecken."; flash.className = "flash err"; return; }
      const profit = (pos.avg - px) * q;
      const fee = feeOf(q * px, selected);
      p.cash -= q * px + fee;
      p.stats.feesPaid += fee;
      pos.qty += q;
      if(pos.qty === 0) delete p.pos[selected];
      noteTrade(p, q * px, "buy");
      noteClose(p, profit, pos.avg * q);
      flash.textContent = `Eingedeckt: ${q} × ${selected} @ ${fmt(px)} (${sgn(profit)}) · Gebühr ${fmt(fee)}`;
      flash.className = "flash ok";
    }else{
      const cost = qty * px, fee = feeOf(cost, selected);
      if(cost + fee > p.cash + 0.001){ flash.textContent = "Nicht genug Bargeld."; flash.className = "flash err"; return; }
      p.cash -= cost + fee;
      p.stats.feesPaid += fee;
      const lp = pos || {qty:0, avg:0};
      lp.avg = (lp.avg*lp.qty + cost) / (lp.qty + qty);
      lp.qty += qty;
      p.pos[selected] = lp;
      noteTrade(p, cost, "buy");
      flash.textContent = `Gekauft: ${qty} × ${selected} @ ${fmt(px)} · Gebühr ${fmt(fee)}`;
      flash.className = "flash ok";
    }
  }else if(side === "sell"){
    // Long verkaufen – Shorts laufen über den eigenen Short-Button
    if(!pos || pos.qty <= 0){
      flash.textContent = "Nicht genug Stücke im Depot."; flash.className = "flash err"; return;
    }
    const sellQty = qtyMode === "max" ? pos.qty : Math.min(qty, pos.qty);
    const profit = (px - pos.avg) * sellQty;
    const fee = feeOf(sellQty * px, selected);
    p.cash += sellQty * px - fee;
    p.stats.feesPaid += fee;
    pos.qty -= sellQty;
    if(pos.qty === 0) delete p.pos[selected];
    noteTrade(p, sellQty * px, "sell");
    noteClose(p, profit, pos.avg * sellQty);
    flash.textContent = `Verkauft: ${sellQty} × ${selected} @ ${fmt(px)} · Gebühr ${fmt(fee)}`;
    flash.className = "flash ok";
  }else{
    // Short eröffnen/aufstocken: Erlös kommt aufs Konto, Rückkauf-Pflicht bleibt
    if(pos && pos.qty > 0){
      flash.textContent = "Erst Long-Position verkaufen, dann shorten."; flash.className = "flash err"; return;
    }
    const cap = maxShortQty(p, px);
    const q = qtyMode === "max" ? cap : Math.min(qty, cap);
    if(q < 1){ flash.textContent = "Short-Limit erreicht (max. 1× Depotwert)."; flash.className = "flash err"; return; }
    const fee = feeOf(q * px, selected);
    p.cash += q * px - fee;
    p.stats.feesPaid += fee;
    const sp = pos || {qty:0, avg:0};
    sp.avg = (sp.avg * -sp.qty + q * px) / (-sp.qty + q);
    sp.qty -= q;
    p.pos[selected] = sp;
    noteTrade(p, q * px, "sell");
    p.stats.shorts++;
    flash.textContent = `Short: ${q} × ${selected} @ ${fmt(px)} 🐻 · Gebühr ${fmt(fee)}`;
    flash.className = "flash ok";
  }
  // Fehler-Pfade kehren oben mit return zurück – hier war die Order erfolgreich
  if(tutorial) tutOnTrade(side);
  saveSnapshot("play");
  renderAll();
}

function totalOf(p){
  let v = p.cash;
  for(const [sym,pos] of Object.entries(p.pos)) v += pos.qty * price(sym);
  return v;
}

/* ====================== Rendering ====================== */
function buildWatch(){
  const el = $("watch");
  el.innerHTML = "";
  // Horizontale Leiste mit ALLEN Werten: Favoriten (per Stern) zuerst, dann der Rest.
  const order = [...favorites, ...DISPLAY_SYMS.filter(s => !favorites.includes(s))];
  for(const sym of order){
    const b = document.createElement("button");
    b.className = "w-card" + (sym === selected ? " active" : "");
    b.id = "w-" + sym;
    const favStar = favorites.includes(sym) ? `<span class="w-fav">★</span>` : "";
    b.innerHTML = `${favStar}<div class="w-sym">${sym}</div><div class="w-chg"></div>`;
    b.onclick = () => { selected = sym; buildWatch(); renderAll(); };
    el.appendChild(b);
  }
  // aktive Karte horizontal in den sichtbaren Bereich holen
  const a = $("w-" + selected);
  if(a && a.scrollIntoView) a.scrollIntoView({inline:"center", block:"nearest"});
}

/* ====================== Aktien-Auswahl (Overlay) ====================== */
function openStockModal(){
  buildStockList();
  $("stockModal").classList.add("show");
}
function closeStockModal(){
  $("stockModal").classList.remove("show");
}
/* Stern umschalten: Favorit entfernen (min. 1 bleibt) bzw. hinzufügen (max. 4) */
function toggleFav(sym){
  const i = favorites.indexOf(sym);
  if(i >= 0){
    if(favorites.length > 1) favorites.splice(i, 1);
  }else if(favorites.length < 4){
    favorites.push(sym);
  }else{
    return; // voll – erst einen abwählen
  }
  buildWatch();
  buildStockList();
  renderAll();
  if(tutorial) tutOnFav();
}
function buildStockList(){
  const el = $("stockList");
  if(!el) return;
  const full = favorites.length >= 4;
  let html = "";
  for(const sym of DISPLAY_SYMS){
    const d = defOf(sym);
    const ch = (price(sym)/open_(sym) - 1) * 100;
    const isFav = favorites.includes(sym);
    const starDis = !isFav && full;        // Stern deaktiviert, wenn 4 voll und kein Favorit
    html += `<div class="stock-row${sym === selected ? " sel" : ""}" data-sym="${sym}">
      <button class="fav-star${isFav ? " on" : ""}${starDis ? " dis" : ""}" data-fav="${sym}"
              title="${isFav ? "Favorit entfernen" : starDis ? "Erst einen Favoriten abwählen" : "Zu Favoriten"}">${isFav ? "★" : "☆"}</button>
      <div class="sr-main">
        <div class="sr-top"><span class="sr-sym">${sym}</span><span class="sr-name">${d.name}</span></div>
        <div class="sr-char">${d.char}</div>
      </div>
      <div class="sr-px">
        <div class="sr-price">${fmt(price(sym))}</div>
        <div class="sr-chg" style="color:${ch >= 0 ? "var(--up)" : "var(--down)"}">${ch>=0?"+":""}${ch.toFixed(2)}%</div>
      </div>
    </div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll(".stock-row").forEach(row => {
    row.onclick = () => { selected = row.dataset.sym; closeStockModal(); buildWatch(); renderAll(); };
  });
  el.querySelectorAll(".fav-star").forEach(star => {
    star.onclick = e => { e.stopPropagation(); toggleFav(star.dataset.fav); };
  });
}
$("openStocks").onclick = openStockModal;
$("closeStocks").onclick = closeStockModal;
$("stockModal").onclick = e => { if(e.target === $("stockModal")) closeStockModal(); };

function renderAll(){
  const cd = $("countdown");
  if(sandbox){
    const elapsed = Math.round(tickCount * TICK_MS / 1000);
    cd.textContent = String(Math.floor(elapsed/60)).padStart(2,"0") + ":" + String(elapsed%60).padStart(2,"0");
    cd.classList.remove("hot");
  }else{
    const remain = Math.max(0, Math.round((matchTicks - tickCount) * TICK_MS / 1000));
    cd.textContent = String(Math.floor(remain/60)).padStart(2,"0") + ":" + String(remain%60).padStart(2,"0");
    cd.classList.toggle("hot", remain <= 60);
  }

  const p = players[round];
  const tv = totalOf(p);
  const livePnl = tv - START_CASH;
  const pill = $("pillPnl");
  pill.textContent = sgn(livePnl);
  pill.style.color = livePnl >= 0 ? "var(--up)" : "var(--down)";

  // Tape
  let tape = "";
  for(const sym of DISPLAY_SYMS){
    const px = price(sym), op = open_(sym);
    const ch = (px/op - 1) * 100;
    const cls = ch >= 0 ? "t-up" : "t-down";
    tape += `<span><span class="t-sym">${sym}</span> ${fmt(px)} <span class="${cls}">${ch>=0?"+":""}${ch.toFixed(2)}%</span></span>`;
  }
  $("tape").innerHTML = tape + tape;

  // Watchlist
  for(const sym of DISPLAY_SYMS){
    const card = $("w-" + sym);
    if(!card) continue;
    const ch = (price(sym)/open_(sym) - 1) * 100;
    const d = card.querySelector(".w-chg");
    d.textContent = (ch>=0?"+":"") + ch.toFixed(2) + "%";
    d.style.color = ch >= 0 ? "var(--up)" : "var(--down)";
  }

  // Offenes Aktien-Overlay mitticken lassen
  if($("stockModal").classList.contains("show")) buildStockList();

  // Kurs
  const px = price(selected), op = open_(selected);
  const ch = (px/op - 1) * 100;
  $("qPx").textContent = fmt(px);
  const chg = $("qChg");
  chg.textContent = (ch>=0?"+":"") + ch.toFixed(2) + "%";
  chg.className = "chg " + (ch >= 0 ? "up" : "down");

  // %-Entwicklung zum eigenen Einstand (Vorzeichen bei Short gedreht: fallender Kurs = Gewinn)
  const myPos = p.pos[selected];
  const ek = $("qEk");
  if(myPos){
    const dir = myPos.qty < 0 ? -1 : 1;
    const ekCh = (px/myPos.avg - 1) * 100 * dir;
    ek.textContent = (myPos.qty < 0 ? "Short " : "EK ") + (ekCh>=0?"+":"") + ekCh.toFixed(2) + "%";
    ek.className = "chg ek " + (ekCh >= 0 ? "up" : "down");
    ek.style.display = "";
  }else{
    ek.style.display = "none";
  }

  // Renditebadge: Brutto-Dividende übers ganze Spiel, wenn man den Wert durchhält (0 → kein Badge)
  const dy = divRate(selected) * TICK_SCALE * matchTicks * 100;
  const divBadge = dy >= 0.05
    ? ` · <span class="div-yield" title="Brutto-Dividende, wenn du den ganzen Lauf hältst">💰 ~${dy.toLocaleString("de-DE", {maximumFractionDigits:1})} % Div./Lauf</span>`
    : "";
  $("qName").innerHTML = `${defOf(selected).name} · Eröffnung ${fmt(op)}<br><span class="char-line">${defOf(selected).char}${divBadge}</span>`;
  $("tradeSym").textContent = selected;

  // Order: Kaufen deckt bei Short-Position ein, Verkaufen nur für Longs,
  // Short hat seinen eigenen Button
  const qty = curQty();
  const held = p.pos[selected]?.qty || 0;
  const isShort = held < 0;
  const cap = maxShortQty(p, px);
  $("buyBtn").textContent = isShort ? "Eindecken" : "Kaufen";
  if(isShort){
    $("orderInfo").textContent = `Short: ${-held} Stk · Eindecken: ${qty} ≈ ${fmt(qty*px)}`;
  }else if(held > 0){
    $("orderInfo").textContent = qtyMode === "max"
      ? `Max: Kauf ${qty} Stück ≈ ${fmt(qty*px)} · Verkauf: alle ${held}`
      : `${qty} Stück ≈ ${fmt(qty*px)} · im Depot: ${held}`;
  }else{
    $("orderInfo").textContent = `${qty} Stück ≈ ${fmt(qty*px)} · Short möglich: ${cap} Stk`;
  }
  $("buyBtn").disabled = over || (isShort ? p.cash < px : qty*px > p.cash + 0.001);
  $("sellBtn").disabled = over || held <= 0;
  $("shortBtn").disabled = over || held > 0 || cap < 1;

  // Depot
  $("cash").textContent = fmt(p.cash);
  $("total").textContent = fmt(tv);
  const pnlEl = $("pnl");
  pnlEl.textContent = sgn(livePnl);
  pnlEl.style.color = livePnl >= 0 ? "var(--up)" : "var(--down)";

  // Dividenden-Zeile: zeigt, wohin die Dividende fließt (aufs Bargeld) – Gesamtsumme.
  // Die "läuft auf"-Zeile wird IMMER gerendert (auch bei 0), damit die Box nicht bei jeder
  // Auszahlung zwischen ein/zwei Zeilen springt – konstante Höhe.
  const divEl = $("divLine");
  const divTot = (p.stats.dividends || 0) + (p.pendingDiv || 0);
  if(divTot >= 0.005){
    divEl.innerHTML = `💰 Dividende kassiert: <b>+${fmt(p.stats.dividends || 0)}</b>` +
      `<span class="div-pending">(+${fmt(p.pendingDiv || 0)} läuft auf)</span>`;
    divEl.style.display = "";
  }else{
    divEl.style.display = "none";
  }

  const wrap = $("posWrap");
  const syms = Object.keys(p.pos);
  if(syms.length === 0){
    wrap.innerHTML = '<div class="empty">Keine offenen Positionen.</div>';
  }else{
    let rows = "";
    for(const sym of syms){
      const pos = p.pos[sym];
      const cur = price(sym);
      const ppnl = ((cur - pos.avg) * pos.qty) || 0; // "|| 0" fängt das negative Null-Artefakt ab
      const ppct = ((cur/pos.avg - 1) * 100 * (pos.qty < 0 ? -1 : 1)) || 0;
      const c = ppnl >= 0 ? "var(--up)" : "var(--down)";
      const tag = pos.qty < 0 ? ' <span style="color:var(--down);font-size:9px;font-weight:700">SHORT</span>'
                : (pos.qty > 0 && isDividendSym(sym)) ? ' <span title="zahlt Dividende">💰</span>' : "";
      rows += `<tr><td>${sym}${tag}</td><td>${pos.qty}</td><td>${fmt(pos.avg)}</td>
               <td style="color:${c}">${ppnl>=0?"+":""}${fmt(ppnl)}</td>
               <td style="color:${c}">${ppct>=0?"+":""}${ppct.toFixed(2)}%</td></tr>`;
    }
    wrap.innerHTML = `<table><thead><tr><th>Wert</th><th>Stk.</th><th>EK</th><th>+/−</th><th>% z. EK</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  drawChart();
}

/* rAF-Loop für flüssige Chart-Animation (60 fps, interpoliert letzten Punkt) */
function startChartLoop(){
  if(chartRaf) return;
  (function loop(){ drawChart(); chartRaf = requestAnimationFrame(loop); })();
}
function stopChartLoop(){
  if(chartRaf){ cancelAnimationFrame(chartRaf); chartRaf = null; }
}

/* "Schöne" Schrittweite für Gitterlinien (1-2-5-Raster) */
function niceStep(range, targetLines){
  const raw = range / targetLines;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for(const m of [1, 2, 2.5, 5, 10]){
    if(raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

function drawChart(){
  const cv = $("chart");
  if(!cv.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight || 190; // Höhe folgt dem CSS (Breitbild höher)
  cv.width = w*dpr; cv.height = h*dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,w,h);

  const op = open_(selected);
  const p = players[round];
  const pos = p.pos[selected];
  const path = market.paths[selected];

  const L = 8, R = 46, T = 8, B = 22;       // Innenabstände (rechts Platz für Preis-Labels)

  /* Glatte Animation: der aktuell entstehende Punkt/die offene Kerze wächst
     innerhalb des Tick-Intervalls herein (0..1). */
  let prog = 1;
  if(lastTickAt && tickCount >= 1 && !paused && !newsPaused && !over)
    prog = Math.min(1, (performance.now() - lastTickAt) / TICK_MS);

  /* Rollierendes Fenster: nur die letzten ~3 Minuten zeigen, Anfang abschneiden */
  const WINDOW = Math.round(180000 / TICK_MS);
  const startIdx = Math.max(0, tickCount + 1 - WINDOW);
  const data = path.slice(startIdx, tickCount + 1);
  const nPts = data.length;
  const livePrice = nPts >= 2 ? data[nPts-2] + (data[nPts-1] - data[nPts-2]) * prog : (data[0] || op);

  /* Animierter Kopf: deckt sich mit der livePrice-Interpolation und sitzt im
     Linien-Modus immer am rechten Rand. */
  const headTick = (tickCount - 1) + prog;
  const CT = Math.max(2, Math.round(10000 / TICK_MS)); // Ticks pro Kerze
  const lastC = Math.floor(tickCount / CT);

  /* --- Kerzen aggregieren (~10 s pro Kerze), wenn der Kerzen-Modus aktiv ist.
         Die letzte (offene) Kerze nutzt den animierten Live-Kurs als Schluss. --- */
  let candles = null, visStartTick = startIdx, firstC = 0;
  if(chartMode === "candle"){
    candles = [];
    const firstVisC = Math.max(0, lastC - Math.ceil(WINDOW / CT) + 1);
    firstC = Math.max(0, firstVisC - 1);   // eine Kerze mehr links → scrollt geclippt sauber raus
    visStartTick = firstVisC * CT;
    for(let c = firstC; c <= lastC; c++){
      const a = c*CT, b = Math.min(c*CT + CT - 1, tickCount);
      let hi = path[a], lo = path[a];
      for(let i=a;i<=b;i++){ if(path[i]>hi)hi=path[i]; if(path[i]<lo)lo=path[i]; }
      const live = c === lastC;
      const cl = live ? livePrice : path[b];
      if(live){ if(cl>hi)hi=cl; if(cl<lo)lo=cl; }
      candles.push({o: path[a], hi, lo, cl, live});
    }
  }

  /* --- Skalierung: im Kerzen-Modus über Dochte (High/Low) --- */
  let min, max;
  if(candles){
    min = Infinity; max = -Infinity;
    for(const k of candles){ if(k.lo<min)min=k.lo; if(k.hi>max)max=k.hi; }
  }else{
    min = Math.min(...data); max = Math.max(...data);
  }
  if(op >= min - (max-min)*0.3 && op <= max + (max-min)*0.3){ min = Math.min(min, op); max = Math.max(max, op); }
  if(pos){ min = Math.min(min, pos.avg); max = Math.max(max, pos.avg); }
  const pad = (max-min)*0.14 || 1;
  min -= pad; max += pad;

  /* Tick → X: konstante Breite pro Tick, rechtsbündig am Kopf ausgerichtet.
     So scrollt die Kurve gleichmäßig nach links, statt bei jedem neuen Punkt
     zu „atmen" (denn ein fester Fensterausschnitt = feste px/Tick). Im
     Kerzen-Modus liegt der „Kopf" an der rechten Slot-Grenze der offenen Kerze
     (= Tick (lastC+1)*CT), damit die Kerze ganz im Chart liegt und nicht am
     rechten Rand abgeschnitten wird. */
  const pxPerTick = (w-L-R) / (WINDOW - 1);
  const headX = candles ? (lastC + 1) * CT : headTick;
  const xt = t => (w-R) - (headX - t) * pxPerTick;
  const X = i => xt(startIdx + i);
  const Y = v => h - B - (h-T-B) * ((v-min)/(max-min));

  ctx.font = "10px ui-monospace,monospace";

  /* --- Horizontale Gitterlinien (Preis) --- */
  const step = niceStep(max-min, 4);
  ctx.strokeStyle = "#19233E"; ctx.lineWidth = 1;
  ctx.fillStyle = "#5F6C8C";
  for(let v = Math.ceil(min/step)*step; v <= max; v += step){
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w-R, y); ctx.stroke();
    ctx.fillText(v.toFixed(step < 1 ? 2 : step < 10 ? 1 : 0), w-R+5, y+3);
  }

  /* --- Vertikale Gitterlinien (Zeit, mm:ss) – an Tick-Positionen gebunden,
         damit sie mit der Kurve mitscrollen statt zu springen. --- */
  if(tickCount - visStartTick > 10){
    const tSteps = 4;
    for(let k = 1; k < tSteps; k++){
      const tk = visStartTick + (tickCount - visStartTick) * k/tSteps;
      const x = xt(tk);
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h-B); ctx.stroke();
      const sec = Math.round(tk * TICK_MS / 1000);
      const lbl = String(Math.floor(sec/60)).padStart(2,"0") + ":" + String(sec%60).padStart(2,"0");
      ctx.fillText(lbl, x - 13, h-7);
    }
  }

  /* --- Eröffnungslinie (nur wenn im sichtbaren Bereich) --- */
  if(op >= min && op <= max){
    ctx.strokeStyle = "#3A4769"; ctx.setLineDash([4,4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, Y(op)); ctx.lineTo(w-R, Y(op)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#7E8BA8";
    ctx.fillText("IPO " + op.toFixed(2), L+4, Y(op)-4);
  }

  /* --- Kursverlauf: Farbe relativ zum Einstand, wenn man Stücke hält
         (bei Short ist unter dem Einstand gut → Logik gedreht) --- */
  const ref = pos ? pos.avg : op;
  const up = pos && pos.qty < 0 ? livePrice <= ref : livePrice >= ref;
  const col = up ? "#3DDC97" : "#FF5C72";
  /* X-Position des animierten letzten Punktes (Linien-Modus: am rechten Rand) */
  const liveX = xt(headTick);
  const liveY = Y(livePrice);

  /* Plotbereich clippen: alte Punkte/Kerzen scrollen sauber unter dem linken
     Rand heraus, statt am Fensterrand zu „springen" (ein Extra-Punkt links
     wird gezeichnet und hier abgeschnitten). */
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, w-L-R, h-T-B); ctx.clip();

  if(candles){
    /* --- Kerzen --- */
    const NC = candles.length;
    const slot = pxPerTick * CT;                 // feste Kerzenbreite (kein „Atmen")
    const cw = Math.max(2, Math.min(slot*0.62, 13));
    for(let i=0;i<NC;i++){
      const k = candles[i];
      const cx = xt((firstC + i) * CT + (CT-1)/2); // Kerzen-Mitte über die Tick-Achse
      const kUp = k.cl >= k.o;
      const kCol = kUp ? "#3DDC97" : "#FF5C72";
      ctx.strokeStyle = kCol; ctx.fillStyle = kCol; ctx.lineWidth = 1;
      /* Docht (High–Low) */
      ctx.beginPath(); ctx.moveTo(cx, Y(k.hi)); ctx.lineTo(cx, Y(k.lo)); ctx.stroke();
      /* Körper (Open–Close); offene Kerze leicht transparent */
      const yo = Y(k.o), yc = Y(k.cl);
      const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      ctx.globalAlpha = k.live ? 0.65 : 1;
      ctx.fillRect(cx - cw/2, top, cw, bh);
      ctx.globalAlpha = 1;
    }
  }else{
    /* --- Linie --- */
    const startI = startIdx > 0 ? -1 : 0; // Extra-Punkt links für nahtloses Rausscrollen
    ctx.beginPath();
    for(let i=startI;i<nPts;i++){
      const px = i < nPts-1 ? X(i) : liveX;
      const py = i < nPts-1 ? Y(i < 0 ? path[startIdx-1] : data[i]) : liveY;
      i===startI ? ctx.moveTo(px,py) : ctx.lineTo(px,py);
    }
    ctx.strokeStyle = col; ctx.lineWidth = 1.8;
    ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();

    /* Fläche unter der Kurve */
    ctx.lineTo(liveX, h-B); ctx.lineTo(X(startI), h-B); ctx.closePath();
    const g = ctx.createLinearGradient(0,T,0,h-B);
    g.addColorStop(0, up ? "rgba(61,220,151,.16)" : "rgba(255,92,114,.16)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fill();
  }
  ctx.restore();

  /* --- Einstandslinie des aktiven Spielers --- */
  if(pos){
    const pCol = round === 0 ? "#FFB454" : "#5EC8F8";
    ctx.strokeStyle = pCol; ctx.setLineDash([7,4]); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(L, Y(pos.avg)); ctx.lineTo(w-R, Y(pos.avg)); ctx.stroke();
    ctx.setLineDash([]);
    const label = "Einstand " + pos.avg.toFixed(2);
    ctx.font = "bold 10px ui-monospace,monospace";
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(11,16,32,.88)";
    ctx.fillRect(w-R-tw-12, Y(pos.avg)-15, tw+8, 13);
    ctx.fillStyle = pCol;
    ctx.fillText(label, w-R-tw-8, Y(pos.avg)-5);
    ctx.font = "10px ui-monospace,monospace";
  }

  /* --- Letzter Kurs: Punkt (nur Linie) folgt der Animation, Preis-Tag am rechten Rand --- */
  if(!candles){ ctx.beginPath(); ctx.arc(liveX,liveY,3.2,0,7); ctx.fillStyle = col; ctx.fill(); }
  ctx.fillStyle = col;
  ctx.fillRect(w-R+2, liveY-7, R-4, 14);
  ctx.fillStyle = "#0B1020";
  ctx.font = "bold 10px ui-monospace,monospace";
  ctx.fillText(livePrice.toFixed(2), w-R+6, liveY+3);
}

/* ====================== News-Feed ====================== */
function pushNews(sym, text, tag, atTick){
  const elapsed = Math.round((atTick === undefined ? tickCount : atTick) * TICK_MS / 1000);
  const t = String(Math.floor(elapsed/60)).padStart(2,"0") + ":" + String(elapsed%60).padStart(2,"0");
  const el = $("news");
  if(el.querySelector(".empty")) el.innerHTML = "";
  const div = document.createElement("div");
  div.className = "news-item";
  div.innerHTML = `<span class="news-time">${t}</span>
                   <span class="news-tag ${tag}">${sym === "ALL" ? "MARKT" : sym}</span>
                   <span class="news-text">${text}</span>`;
  el.prepend(div);
  while(el.children.length > 12) el.removeChild(el.lastChild);
}

/* Beim Fortsetzen: alle bis zur aktuellen Tick-Position bereits gelaufenen
   Meldungen still (ohne Popup) in chronologischer Reihenfolge nachzeichnen. */
function replayNewsUpTo(tc){
  const items = [];
  for(const e of market.events) if(e.tick <= tc) items.push({tick:e.tick, sym:e.ev.t, txt:e.ev.txt, tag:e.tag});
  for(const t of market.tips)   if(t.tick <= tc) items.push({tick:t.tick, sym:t.sym, txt:insiderText(t), tag:"insider"});
  items.sort((a,b) => a.tick - b.tick);
  for(const it of items) pushNews(it.sym, it.txt, it.tag, it.tick);
}

/* ====================== Runden-/Match-Ende ====================== */
function endRound(){
  over = true;
  clearInterval(timer);
  stopChartLoop();
  stopRace();
  if(sandbox) matchTicks = tickCount; else tickCount = matchTicks;
  const p = players[round];
  payDividend(p, false); // letzte aufgelaufene Dividende noch auszahlen
  renderAll();
  const tot = totalOf(p);
  p.result = {total: tot, pnl: tot - START_CASH};

  // Tutorial: kein Duell-Ergebnis, der Coach übernimmt den Abschluss
  if(tutorial){
    tutFinish(p);
    return;
  }

  if(!sandbox){ updateRecord(p); appendGameHistory(p); } // Rekord + Historie auf diesem Gerät fortschreiben

  // Eine Runde, eigenes Ergebnis: Einzelspieler oder jedes Remote-Gerät
  if(mode === "solo" || mode === "remote"){
    showResultSolo(p);
    return;
  }

  if(round === 0){
    showHandover(p);
    saveSnapshot("handover"); // Übergabe ist fortsetzbar, falls Spieler 2 neu lädt
  }else{
    showResult();
  }
}

/* Übergabe-Overlay nach Runde 1 (lokal) – auch beim Fortsetzen genutzt */
function showHandover(p){
  $("hoTitle").textContent = players[0].name + " ist fertig";
  const ho = $("hoPnl");
  ho.textContent = sgn(p.result.pnl);
  ho.style.color = p.result.pnl >= 0 ? "var(--up)" : "var(--down)";
  $("hoBadge").textContent = playerTitle(p);
  $("hoBadges").innerHTML = badgesHtml(playerBadges(p));
  $("hoStats").innerHTML = statsLine(p);
  $("hoSub").innerHTML = `Handy weitergeben an <b style="color:var(--p2)">${esc(players[1].name)}</b>.<br>
    Gleicher Markt, gleiche News – gleiche Chancen.`;
  $("hoCode").textContent = gameCode;
  $("handover").classList.add("show");
}

/* ====================== Auszeichnungen ====================== */
/* Eine Liste, zwei Verwendungen: der erste Treffer ist der Haupttitel,
   weitere Treffer werden als kleine Badges darunter gezeigt – so haben auch
   Verlierer fast immer etwas vorzuzeigen. tOnly-Einträge sind reine
   Titel-Fallbacks und tauchen nie als Badge auf. */


function awardCtx(p){
  return {pnl: p.result.pnl, inv: p.stats.investedTicks / matchTicks, bh: buyHoldPnl()};
}

function playerTitle(p){
  const x = awardCtx(p);
  return AWARDS.find(a => a.c(p.stats, x)).n;
}

/* Bis zu drei Badges unterhalb des Titels; extra (z. B. "👑 Börsenkönig"
   für den Duell-Sieger) belegt den ersten Platz. */
function playerBadges(p, extra){
  const x = awardCtx(p);
  const title = playerTitle(p);
  const out = extra ? [extra] : [];
  for(const a of AWARDS){
    if(out.length >= 3) break;
    if(!a.tOnly && a.n !== title && a.c(p.stats, x)) out.push(a.n);
  }
  return out;
}

const badgesHtml = list => list.map(b => `<span class="badge">${b}</span>`).join("");

function statsLine(p){
  const s = p.stats;
  let out = `${s.trades} Trades · Spitze ${fmt(s.peak)}`;
  if(s.best !== null) out += `<br>Bester Deal ${sgn(s.best)} · Schwächster ${sgn(s.worst)}`;
  return out;
}

/* ====================== Analyse (ausführliche Endauswertung) ====================== */
/* Benchmark: Was hätte stures Kaufen-und-Halten von SPCX gebracht? */
function buyHoldPnl(){
  const px0 = STOCK_DEFS.SPCX.start;
  const qty = Math.floor(START_CASH / px0);
  return (START_CASH - qty*px0) + qty * market.paths.SPCX[matchTicks] - START_CASH;
}

function favSym(p){
  if(p.stats._fav) return p.stats._fav; // entpacktes Gegner-Ergebnis liefert den String direkt
  const e = Object.entries(p.stats.perSym).sort((a,b) => b[1] - a[1]);
  return e.length ? `${e[0][0]} (${e[0][1]}×)` : "–";
}

const pctf = x => (x >= 0 ? "+" : "") + (x*100).toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2}) + " %";

function buildAnalysis(list){
  const bh = buyHoldPnl();
  const col = v => v >= 0 ? "var(--up)" : "var(--down)";
  const rows = [
    ["Rendite",            p => `<span style="color:${col(p.result.pnl)}">${pctf(p.result.pnl/START_CASH)}</span>`],
    ["Käufe / Verkäufe",   p => `${p.stats.buys} / ${p.stats.sells}`],
    ["Short-Orders",       p => p.stats.shorts],
    ["Handelsvolumen",     p => fmt(p.stats.volume)],
    ["Gebühren gezahlt",   p => (p.stats.feesPaid||0) < 0.005 ? "–" : `<span style="color:var(--down)">−${fmt(p.stats.feesPaid)}</span>`],
    ["Dividenden",         p => (p.stats.dividends||0) < 0.005 ? "–" : `<span style="color:var(--up)">+${fmt(p.stats.dividends)}</span>`],
    ["Realisierte Gewinne",p => `<span style="color:${col(p.stats.realized)}">${sgn(p.stats.realized)}</span>`],
    ["Bester Deal",        p => p.stats.best  === null ? "–" : `<span style="color:${col(p.stats.best)}">${sgn(p.stats.best)}</span>`],
    ["Schwächster Deal",   p => p.stats.worst === null ? "–" : `<span style="color:${col(p.stats.worst)}">${sgn(p.stats.worst)}</span>`],
    ["Depot-Spitze",       p => fmt(p.stats.peak)],
    ["Depot-Tief",         p => fmt(p.stats.trough)],
    ["Max. Rücksetzer",    p => p.stats.maxDD < 0.005 ? "–" : "−" + fmt(p.stats.maxDD)],
    ["Investierte Zeit",   p => Math.round(p.stats.investedTicks / matchTicks * 100) + " %"],
    ["Lieblingsaktie",     p => esc(favSym(p))],
    ["Trades nach News",   p => p.stats.newsTrades],
    ["Trades auf Tipps",   p => p.stats.tipTrades],
    ["Markt geschlagen",   p => p.result.pnl > bh ? "✅ Ja" : "❌ Nein"],
  ];
  let html = '<h4>📊 Analyse</h4><table>';
  if(list.length > 1){
    html += `<tr><th></th>${list.map(p => `<th style="color:${p.color}">${esc(p.name)}</th>`).join("")}</tr>`;
  }
  for(const [label, fn] of rows){
    html += `<tr><td>${label}</td>${list.map(p => `<td>${fn(p)}</td>`).join("")}</tr>`;
  }
  html += `</table><div class="bh-note">Benchmark: Buy &amp; Hold SPCX hätte ${sgn(bh)} gebracht.</div>`;
  $("analysis").innerHTML = html;
}

/* ====================== Ergebnis-Austausch (Zwei-Geräte-Modus) ====================== */
/* Ohne Server: Jeder kopiert sein Ergebnis als kompakten Code (Base64) und
   schickt ihn dem Gegner (z. B. per Messenger). Eingefügt ergibt das die volle
   Duell-Ansicht mit Krone und zweispaltiger Analyse. */
function packResult(p){
  const s = p.stats;
  const f = [gameCode, p.name, p.result.pnl.toFixed(2), p.result.total.toFixed(2),
             s.trades, s.buys, s.sells, s.shorts, Math.round(s.volume), s.realized.toFixed(2),
             s.best  === null ? "x" : s.best.toFixed(2),
             s.worst === null ? "x" : s.worst.toFixed(2),
             s.allIns, s.newsTrades, s.investedTicks,
             s.peak.toFixed(2), s.trough.toFixed(2), s.maxDD.toFixed(2),
             s.tipTrades, s.bestPct.toFixed(4), favSym(p),
             (s.feesPaid||0).toFixed(2), (s.dividends||0).toFixed(2),
             (marketSeed == null ? gameCode : marketSeed) >>> 0]; // Feld 23: Markt-Seed (Online ≠ Code)
  return "SPCX5." + btoa(unescape(encodeURIComponent(f.join("|"))));
}

// expectCode: gegen welchen Spiel-Code geprüft wird (Default = laufendes Spiel;
// für den Historien-Vergleich wird der Code des jeweiligen Eintrags übergeben).
function unpackResult(str, expectCode){
  // SPCX5 = aktuell (trägt den Markt-Seed mit), SPCX4 = ältere Ergebnisse ohne Seed
  const v5 = str.startsWith("SPCX5."), v4 = str.startsWith("SPCX4.");
  if(!v5 && !v4) return null;
  let f;
  try{ f = decodeURIComponent(escape(atob(str.slice(6)))).split("|"); }catch(e){ return null; }
  if(f.length !== (v5 ? 24 : 23)) return null;
  const code = +f[0];
  if(code !== (expectCode === undefined ? gameCode : expectCode)) return {wrongGame:true};
  const nums = [2,3,4,5,6,7,8,9,12,13,14,15,16,17,18,19,21,22].map(i => parseFloat(f[i]));
  if(nums.some(isNaN)) return null;
  if(v5 && isNaN(+f[23])) return null;
  return {
    gameCode: code,
    seed: v5 ? (+f[23] >>> 0) : undefined,
    name: f[1].slice(0,14) || "Gegner",
    result:{pnl:+f[2], total:+f[3]},
    stats:{trades:+f[4], buys:+f[5], sells:+f[6], shorts:+f[7], volume:+f[8], realized:+f[9],
           best: f[10] === "x" ? null : +f[10],
           worst:f[11] === "x" ? null : +f[11],
           allIns:+f[12], newsTrades:+f[13], investedTicks:+f[14],
           peak:+f[15], trough:+f[16], maxDD:+f[17],
           tipTrades:+f[18], bestPct:+f[19], perSym:{}, _fav:f[20].slice(0,24),
           feesPaid:+f[21], dividends:+f[22]},
  };
}

/* Ergebnis-Code aus beliebig eingefügtem Text fischen: ganze WhatsApp-Nachricht,
   ?vs=-Link oder roher SPCX4-String – alles wird akzeptiert. */
function extractResultCode(raw){
  raw = (raw || "").trim();
  const link = raw.match(/[?&]vs=([^&\s]+)/);          // kompletter Teil-Link eingefügt
  if(link){ try{ return decodeURIComponent(link[1]); }catch(e){} }
  const code = raw.match(/SPCX[45]\.[A-Za-z0-9+/=]+/); // Code irgendwo im Text
  return code ? code[0] : raw;
}

/* Gegner-Ergebnis eingefügt → volle Duell-Ansicht wie im Ein-Gerät-Modus */
function renderCompare(me, opp){
  opp.color = me.color === "var(--p1)" ? "var(--p2)" : "var(--p1)";
  $("cmpBox").style.display = "none";
  $("resCard2").style.display = "";
  $("resName2").textContent = opp.name;
  document.querySelector("#resCard2 .dot").style.background = opp.color;
  const diff = Math.abs(me.result.pnl - opp.result.pnl);
  const draw = diff < 0.005;
  const meWins = me.result.pnl > opp.result.pnl;
  setRes("1", me,  !draw && meWins  ? KING_BADGE : null);
  setRes("2", opp, !draw && !meWins ? KING_BADGE : null);
  if(draw){
    $("resTitle").textContent = "Unentschieden!";
    $("resSub").textContent = "Auf den Cent gleich – das gibt's selten.";
    $("crown1").textContent = ""; $("crown2").textContent = "";
    $("resCard1").classList.remove("win"); $("resCard2").classList.remove("win");
  }else{
    $("resTitle").textContent = (meWins ? me.name : opp.name) + " gewinnt!";
    $("resSub").textContent = "Vorsprung: " + fmt(diff) + " · identischer Markt für beide";
    $("crown1").textContent = meWins ? "👑" : "";
    $("crown2").textContent = meWins ? "" : "👑";
    $("resCard1").classList.toggle("win", meWins);
    $("resCard2").classList.toggle("win", !meWins);
  }
  buildAnalysis([me, opp]);
}

let soloP = null;

/* Teil-Link auf diese App bauen (nur über http(s) – bei file:// gibt es keine teilbare URL) */
function shareUrl(param, value){
  if(!/^https?:$/.test(location.protocol)) return null;
  return location.origin + location.pathname + "?" + param + "=" + encodeURIComponent(value);
}
/* Text übers System-Teilen-Menü verschicken, sonst in die Zwischenablage */
async function shareOut(text){
  if(navigator.share){ await navigator.share({text}); return "geteilt"; }
  await navigator.clipboard.writeText(text);
  return "kopiert";
}

$("shareBtn").onclick = async function(){
  const code = packResult(soloP);
  const url = shareUrl("vs", code);
  const txt = `📈 SPCX Trading-Duell (Code ${String(gameCode).padStart(6,"0")}): ${sgn(soloP.result.pnl)} – „${playerTitle(soloP)}"\n` +
              (url ? `Zum Duell-Vergleich antippen: ${url}` : `Ergebnis-Code:\n${code}`);
  try{
    this.textContent = (await shareOut(txt)) === "geteilt" ? "✅ Geteilt!" : "✅ Kopiert – schick's dem Gegner!";
  }catch(e){
    if(e && e.name === "AbortError") return; // Teilen-Menü abgebrochen – kein Fehler
    window.prompt("Zum Kopieren markieren:", txt);
  }
};

$("cmpBtn").onclick = () => {
  const opp = unpackResult(extractResultCode($("cmpIn").value));
  if(!opp){ $("cmpErr").textContent = "Code nicht lesbar – komplett kopiert?"; return; }
  if(opp.wrongGame){ $("cmpErr").textContent = "Das Ergebnis stammt aus einem anderen Spiel."; return; }
  // Gleicher Code, aber anderer Markt (z. B. Online-Seed vs. Offline-Beitritt) → unfair, ablehnen
  const expSeed = (marketSeed == null ? gameCode : marketSeed) >>> 0;
  if(opp.seed !== undefined && opp.seed !== expSeed){
    $("cmpErr").textContent = "Anderer Markt – ein Gerät hat offline mit demselben Code gespielt.";
    return;
  }
  $("cmpErr").textContent = "";
  renderCompare(soloP, opp);
};

/* ====================== Statistik-Seite ====================== */
let statsGames = [], statsCmpIdx = -1, cmpFromStats = false;

const peekCode = str => {           // Spiel-Code (Feld 0) aus einem SPCX4/SPCX5-String lesen
  if(!str || !/^SPCX[45]\./.test(str)) return null;
  try{ return +decodeURIComponent(escape(atob(str.slice(6)))).split("|")[0]; }catch(e){ return null; }
};

function statGameHtml(g, i, tag){
  const dStr = new Date(g.date).toLocaleDateString("de-DE", {day:"2-digit", month:"2-digit", year:"2-digit"});
  const c = g.pnl >= 0 ? "var(--up)" : "var(--down)";
  return `<div class="stat-game">
    <div class="sg-main">
      <div class="sg-top">${tag ? `<span class="sg-tag">${tag}</span> ` : ""}<b>${esc(g.name)}</b> · ${g.durationMin} Min · ${dStr}</div>
      <div class="sg-sub">Lieblingsaktie ${esc(g.fav || "–")}</div>
    </div>
    <div class="sg-pnl" style="color:${c}">${sgn(g.pnl)}</div>
    <div class="sg-act">
      <button class="sg-btn" data-share="${i}" title="Ergebnis-Code kopieren">📤</button>
      <button class="sg-btn" data-cmp="${i}" title="Mit Gegner vergleichen">⚔️</button>
    </div>
  </div>`;
}

function renderStats(){
  const s = loadStore();
  statsGames = Array.isArray(s.games) ? s.games : [];
  $("statsCmpBox").style.display = "none"; statsCmpIdx = -1;
  const body = $("statsBody");
  if(!statsGames.length){
    body.innerHTML = '<div class="rec" style="display:block;margin-top:24px">Noch keine Spiele gespielt – leg los! 🚀</div>';
    return;
  }
  let best = 0, worst = 0;
  statsGames.forEach((g, i) => { if(g.pnl > statsGames[best].pnl) best = i; if(g.pnl < statsGames[worst].pnl) worst = i; });
  let html = '<div class="stat-head">🏆 Bestes & 📉 schlechtestes Spiel</div>';
  html += statGameHtml(statsGames[best], best, "🏆");
  if(worst !== best) html += statGameHtml(statsGames[worst], worst, "📉");
  html += '<div class="stat-head">🕒 Letzte 5</div>';
  statsGames.slice(0, 5).forEach((g, i) => html += statGameHtml(g, i, "")); // slice 0..4 == Original-Index
  body.innerHTML = html;
  body.querySelectorAll("[data-share]").forEach(b => b.onclick = () => shareStatsGame(+b.dataset.share, b));
  body.querySelectorAll("[data-cmp]").forEach(b => b.onclick = () => openStatsCompare(+b.dataset.cmp));
}

async function shareStatsGame(i, btn){
  const g = statsGames[i];
  const url = shareUrl("vs", g.code);
  const txt = `📈 SPCX Trading-Duell (${g.durationMin} Min): ${sgn(g.pnl)}\n` +
              (url ? `Zum Duell-Vergleich antippen: ${url}` : `Ergebnis-Code:\n${g.code}`);
  try{
    await shareOut(txt);
    const o = btn.textContent; btn.textContent = "✅"; setTimeout(() => btn.textContent = o, 1500);
  }catch(e){
    if(e && e.name === "AbortError") return;
    window.prompt("Zum Kopieren markieren:", txt);
  }
}

function openStatsCompare(i){
  statsCmpIdx = i;
  $("statsCmpIn").value = ""; $("statsCmpErr").textContent = "";
  $("statsCmpLabel").textContent = `Gegner-Code zu „${esc(statsGames[i].name)}" (${statsGames[i].durationMin} Min) einfügen`;
  $("statsCmpBox").style.display = "";
  $("statsCmpBox").scrollIntoView({behavior:"smooth", block:"center"});
}

/* Historien-Vergleich ausführen: eigener Eintrag + Gegner-String → Duell-Ansicht.
   Genutzt vom Statistik-Button UND vom ?vs=-Teil-Link. */
function runStatsCompare(entry, oppRaw, errEl){
  const gc = peekCode(entry.code);
  const me = unpackResult(entry.code, gc);
  if(!me || me.wrongGame){ errEl.textContent = "Eigener Eintrag beschädigt."; return false; }
  const opp = unpackResult(extractResultCode(oppRaw), gc);
  if(!opp){ errEl.textContent = "Code nicht lesbar – komplett kopiert?"; return false; }
  if(opp.wrongGame){ errEl.textContent = "Dieses Ergebnis stammt aus einem anderen Spiel."; return false; }
  // Markt-Seed abgleichen: beide müssen denselben Markt gespielt haben (Online: Seed ≠ Code)
  const expSeed = (me.seed !== undefined ? me.seed : gc) >>> 0;
  if(opp.seed !== undefined && opp.seed !== expSeed){
    errEl.textContent = "Anderer Markt – dieses Ergebnis passt nicht zu deinem Spiel."; return false;
  }
  errEl.textContent = "";
  // Ansicht sicher auf den klassischen Zwei-Spalten-Vergleich stellen
  rankGame = null; clearTimeout(rankTimer);
  $("rankBox").style.display = "none"; $("rankBack").style.display = "none";
  document.querySelector(".res-row").style.display = "";
  $("analysis").style.display = "";
  // Markt des Eintrags deterministisch rekonstruieren → Analyse/Benchmark stimmen
  sandbox = false; gameCode = gc; durationMin = entry.durationMin;
  marketSeed = (me.seed !== undefined && me.seed !== (gc >>> 0)) ? me.seed : null;
  buildMarket();
  me.color = "var(--p1)";
  $("resName1").textContent = me.name;
  document.querySelector("#resCard1 .dot").style.background = "var(--p1)";
  $("crown1").textContent = ""; $("resCard1").classList.remove("win");
  renderCompare(me, opp);
  $("resCode").textContent = String(gc).padStart(6, "0");
  $("rematchBtn").textContent = "← Zurück zur Statistik";
  cmpFromStats = true;
  $("overlay").classList.add("show");
  return true;
}

$("statsCmpBtn").onclick = () => {
  if(statsCmpIdx < 0) return;
  if(runStatsCompare(statsGames[statsCmpIdx], $("statsCmpIn").value, $("statsCmpErr")))
    $("statsScreen").classList.remove("show");
};

$("statsBtn").onclick = () => {
  renderStats();
  $("startScreen").classList.remove("show");
  $("statsScreen").classList.add("show");
  window.scrollTo(0, 0);
};
$("statsBack").onclick = () => {
  $("statsScreen").classList.remove("show");
  $("startScreen").classList.add("show");
  window.scrollTo(0, 0);
};

/* Remote: eigenes Ergebnis + Austausch-Box für den Vergleich */
function showResultSolo(p){
  clearSnapshot(); // Runde gespielt – Snapshot entfernen
  soloP = p;
  const solo = mode === "solo"; // Einzelspieler: kein Gegner, kein Ergebnis-Austausch
  $("resTitle").textContent = sandbox ? "Sandbox beendet!" : "Geschafft!";
  $("resSub").textContent = sandbox
    ? "Freies Üben – kein Rekord-Eintrag."
    : solo
      ? "Dein Ergebnis – schaffst du beim nächsten Mal mehr?"
      : "Tauscht eure Ergebnisse aus – dann gibt's den direkten Vergleich.";
  $("resName1").textContent = p.name;
  document.querySelector("#resCard1 .dot").style.background = p.color;
  $("crown1").textContent = "";
  $("resCard1").classList.remove("win");
  $("resCard2").style.display = "none";
  setRes("1", p);
  buildAnalysis([p]);
  $("cmpBox").style.display = solo ? "none" : "";
  $("shareBtn").textContent = "📤 Mein Ergebnis teilen";
  $("cmpIn").value = ""; $("cmpErr").textContent = "";
  $("cmpWait").style.display = "none";
  // Ansicht auf den klassischen Zustand zurücksetzen (falls zuvor eine Rangliste offen war)
  rankGame = null; clearTimeout(rankTimer);
  $("rankBox").style.display = "none"; $("rankBack").style.display = "none";
  document.querySelector(".res-row").style.display = "";
  $("analysis").style.display = "";
  $("resCode").textContent = String(gameCode).padStart(6,"0");
  $("rematchBtn").textContent = "Neues Spiel";
  $("overlay").classList.add("show");
  // Online-Duell: Ergebnis hochladen; 2 Spieler → Auto-Vergleich, 3+ → Rangliste
  if(!solo && !sandbox && onlineGame) onlineShareResult(p);
}

function showResult(){
  clearSnapshot(); // Duell entschieden – Snapshot entfernen
  rankGame = null; clearTimeout(rankTimer); // falls zuvor eine Online-Rangliste offen war
  $("rankBox").style.display = "none"; $("rankBack").style.display = "none";
  document.querySelector(".res-row").style.display = "";
  $("analysis").style.display = "";
  $("resCard2").style.display = "";
  $("cmpBox").style.display = "none";
  $("rematchBtn").textContent = "Revanche";
  document.querySelector("#resCard1 .dot").style.background = "var(--p1)";
  const r1 = players[0].result, r2 = players[1].result;
  $("resName1").textContent = players[0].name;
  $("resName2").textContent = players[1].name;
  const diff = Math.abs(r1.pnl - r2.pnl);
  const draw = diff < 0.005;
  const w = r1.pnl > r2.pnl ? 0 : 1;
  setRes("1", players[0], !draw && w === 0 ? KING_BADGE : null);
  setRes("2", players[1], !draw && w === 1 ? KING_BADGE : null);
  buildAnalysis([players[0], players[1]]);

  if(draw){
    $("resTitle").textContent = "Unentschieden!";
    $("resSub").textContent = "Auf den Cent gleich – das gibt's selten.";
    $("crown1").textContent = ""; $("crown2").textContent = "";
    $("resCard1").classList.remove("win"); $("resCard2").classList.remove("win");
  }else{
    $("resTitle").textContent = players[w].name + " gewinnt!";
    $("resSub").textContent = "Vorsprung: " + fmt(diff) + " · identischer Markt für beide";
    $("crown1").textContent = w === 0 ? "👑" : "";
    $("crown2").textContent = w === 1 ? "👑" : "";
    $("resCard1").classList.toggle("win", w === 0);
    $("resCard2").classList.toggle("win", w === 1);
  }
  $("resCode").textContent = gameCode;
  $("overlay").classList.add("show");
}

/* extra: Zusatz-Badge für den Duell-Sieger (👑 Börsenkönig) */
function setRes(i, p, extra){
  const r = p.result;
  const el = $("resPnl"+i);
  el.textContent = sgn(r.pnl);
  el.style.color = r.pnl >= 0 ? "var(--up)" : "var(--down)";
  $("resTot"+i).textContent = "Endwert " + fmt(r.total);
  $("resBadge"+i).textContent = playerTitle(p);
  $("resBadges"+i).innerHTML = badgesHtml(playerBadges(p, extra));
}

/* ====================== Tutorial ====================== */
/* Interaktives Übungsspiel: gescripteter Mini-Markt mit festem Seed (~2:30 Min
   Spielzeit), eine Coach-Leiste führt durch die 6 Schritte. Nutzt den normalen
   Match-Screen und die echte Handelslogik – genMarket und die Duell-Fairness
   bleiben unberührt. Bei Erklär- und Aktions-Schritten steht die Spielzeit
   (paused), es gibt also keinen Zeitdruck. */
let tutorial = false, tutStep = 0;


/* Drehbuch (Ticks à TICK_MS). Die Coach-Pausen frieren tickCount ein, daher
   passen die festen Event-Ticks und der vorberechnete Pfad immer zusammen.
   Ablauf der Beobachtungs-Fenster (Pausen dazwischen verbrauchen keine Ticks):
   0–20  SPCX-Anstieg (Einstand/Depot/Kerzen, Verkauf bei 20)
   20–44 SPCX-News bei 26 (Sprung bei 26+R)
   44–82 Insider-Tipp 48 → RKLB-Event 64 (Sprung 64+R)
   82–170 Abschluss-Test mit Mega: News 92, Vor-Beben 96/100/104,
          Hauptschlag bei 110, danach Abebben (Verkaufsfenster). */
function genTutorialMarket(){
  const rnd = mulberry32(4242);
  const g = () => {
    let u=0,v=0;
    while(u===0)u=rnd();
    while(v===0)v=rnd();
    return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  };
  const R = REACT_TICKS;
  const script = {
    SPCX:{sigma:0.0008,
          jumps:{[26+R]:+0.022,                       // positive News (Schritt »News«)
                 96:+0.012, 100:+0.012, 104:+0.012,   // Mega: Vor-Beben kriecht herein
                 110:+0.20},                           // Mega: Hauptschlag
          drift:t => t >= 1  && t <= 20  ? +0.0017     // Aufwärts für Einstand/Depot/Kerzen
                   : t > 26+R && t <= 26+R+12 ? +0.0008 // sanfter Nachlauf nach der News
                   : t >= 112 && t <= 152 ? -0.0032 : 0},// Mega ebbt ~zwei Drittel wieder ab
    RKLB:{sigma:0.0009, jumps:{[64+R]:+0.030},
          drift:t => t > 64+R && t <= 64+R+16 ? +0.0011 : 0},
  };
  const paths = {}, prices = {};
  for(const [sym,d] of Object.entries(STOCK_DEFS)){ paths[sym] = [d.start]; prices[sym] = d.start; }
  // Nicht eigens gescriptete Aktien (die übrigen Werte) laufen ruhig im Hintergrund
  const QUIET = {sigma:0.0006, jumps:{}, drift:() => 0};
  for(let i = 1; i <= TUT_TICKS; i++){
    for(const sym of Object.keys(STOCK_DEFS)){
      const sc = script[sym] || QUIET;
      if(sc.jumps[i]) prices[sym] *= 1 + sc.jumps[i];
      const sig = sc.sigma;
      prices[sym] = Math.max(1, prices[sym] * Math.exp(sc.drift(i) - sig*sig/2 + sig*g()));
      paths[sym].push(prices[sym]);
    }
  }
  const events = [
    {tick:26, ev:{t:"SPCX", txt:"NASA vergibt neuen Mond-Auftrag an SpaceX!"}, tag:"up"},
    {tick:64, ev:{t:"RKLB", txt:"Rocket Lab gewinnt Mega-Vertrag für eine Satelliten-Konstellation!"}, tag:"up"},
    {tick:92, ev:{t:"SPCX", txt:"💥 MEGA: Jahrhundert-Auftrag! Regierung lässt SpaceX die Mond-Basis bauen.",
                  jump:+0.20, drift:+0.0008, dur:40}, tag:"up", mega:true},
  ];
  const tips = [{tick:48, eventTick:64, sym:"RKLB", dir:1}];
  addEtfPath(paths, TUT_TICKS);    // damit price("MKT") auch im Tutorial existiert
  addActivePath(paths, TUT_TICKS); // ebenso price("ACT")
  return {paths, events, tips};
}

/* Schritte: pause = Spielzeit angehalten, glow = pulsierender Ziel-Button,
   btn/next = Weiter-Knopf samt Folgeschritt. Aktions-Schritte (2 und 4) werden
   über tutOnTrade weitergeschaltet, Beobachtungs-Phasen über tutOnTick. */

function tutShow(n){
  tutStep = n;
  const st = TUT_STEPS[n];
  paused = st.pause;
  if(st.cm) setChartMode(st.cm); // Schritt kann die Chart-Ansicht umstellen (Kerzen/Linie)
  $("coachStep").textContent = st.lbl;
  $("coachText").innerHTML = st.text;
  const b = $("coachBtn");
  b.style.display = st.btn ? "" : "none";
  b.textContent = st.btn || "";
  b.onclick = st.next ? () => tutShow(st.next) : null;
  document.querySelectorAll(".tut-glow").forEach(el => el.classList.remove("tut-glow"));
  if(st.glow) $(st.glow).classList.add("tut-glow");
  $("coach").classList.add("show");
}

/* Aktions-Schritte: erfolgreicher Kauf bzw. Verkauf schaltet weiter */
function tutOnTrade(side){
  if(tutStep === 2 && side === "buy") tutShow(3);
  else if(tutStep === 6 && side === "sell") tutShow(7);
}

/* Favoriten-Schritt: sobald eine neue (nicht-Standard) Aktie zum Favorit wird */
function tutOnFav(){
  if(tutStep === 11 && favorites.some(f => !DEFAULT_FAVS.includes(f))){
    closeStockModal();
    tutShow(12);
  }
}

/* Beobachtungs-Phasen enden an festen Ticks */
function tutOnTick(){
  if(tickCount === 20 && tutStep === 3) tutShow(4);        // Einstand/Depot
  else if(tickCount === 44 && tutStep === 8) tutShow(9);   // News → Insider
  else if(tickCount === 82 && tutStep === 10) tutShow(11); // Insider → Alle Aktien
  else if(tickCount === 114 && tutStep === 13) tutShow(14);// Mega im Hoch
}

/* Abschluss: eigenes Übungs-Ergebnis statt Duell-Auswertung */
function tutFinish(p){
  tutStep = 0;
  document.querySelectorAll(".tut-glow").forEach(el => el.classList.remove("tut-glow"));
  const pnl = p.result.pnl;
  $("coachStep").textContent = "Tutorial beendet";
  $("coachText").innerHTML =
    `🎓 <b>Geschafft!</b> Dein Übungs-Ergebnis: ` +
    `<b style="color:${pnl >= 0 ? "var(--up)" : "var(--down)"}">${sgn(pnl)}</b>. ` +
    `Du kennst jetzt Kaufen, Verkaufen & Short, den Einstand & dein Depot, den Kerzen-Chart, ` +
    `News mit Reaktionslücke, Insider-Tipps, alle 10 Aktien samt Favoriten – und Mega-Events. ` +
    `💡 Extra: Jede Order kostet 0,15 % <b>Gebühr</b>, manche Aktien & der <b>Markt-ETF (MKT)</b> ` +
    `zahlen <b>Dividende</b> fürs Halten – Geduld ist eine echte Strategie. ` +
    `Im echten Duell zählt genau dein Ergebnis – nur dass dein Gegner denselben Markt bekommt. Viel Erfolg!`;
  const b = $("coachBtn");
  b.style.display = "";
  b.textContent = "Zum Startbildschirm";
  b.onclick = exitTutorial;
}

function exitTutorial(){
  clearInterval(timer);
  over = true; tutorial = false; tutStep = 0;
  document.querySelectorAll(".tut-glow").forEach(el => el.classList.remove("tut-glow"));
  document.body.classList.remove("tut");
  $("coach").classList.remove("show");
  $("newsPop").classList.remove("show");
  $("matchScreen").classList.remove("show");
  $("startScreen").classList.add("show");
  // mode wieder an die Auswahl auf dem Startscreen angleichen (robust für Einzelspieler)
  const topSel = document.querySelector(".mtop.active");
  setTop(topSel ? topSel.dataset.top : "single");
  window.scrollTo(0,0);
}

$("coachExit").onclick = exitTutorial;

$("tutBtn").onclick = () => {
  tutorial = true;
  gameCode = 0;
  mode = "local";
  matchTicks = TUT_TICKS;
  market = genTutorialMarket();
  players = [newPlayer("Du", "var(--p1)")];
  document.body.classList.add("tut");
  startRound(0);
  tutShow(1);
};

/* ====================== Steuerung ====================== */
$("pauseBtn").onclick = function(){
  if(over) return;
  paused = !paused;
  this.textContent = paused ? "▶ Weiter" : "⏸ Pause";
};
$("endSandboxBtn").onclick = () => { if(!over) endRound(); };
$("npSkip").onclick = closeNewsPop;
$("buyBtn").onclick = () => trade("buy");
$("sellBtn").onclick = () => trade("sell");
$("shortBtn").onclick = () => trade("short");
document.querySelectorAll(".chip").forEach(c => c.onclick = () => {
  qtyMode = c.dataset.q;
  document.querySelectorAll(".chip").forEach(x => x.classList.toggle("active", x === c));
  renderAll();
});
/* Chart-Ansicht umschalten (Linie/Kerzen) – reine Optik, kein Spieleinfluss */
function setChartMode(cm){
  chartMode = cm;
  document.querySelectorAll(".ctg").forEach(x => x.classList.toggle("active", x.dataset.cm === cm));
  if(market) drawChart();
}
document.querySelectorAll(".ctg").forEach(b => b.onclick = () => setChartMode(b.dataset.cm));
window.addEventListener("resize", () => { if(market) drawChart(); });

/* ====================== Teil-Links (?join= / ?vs=) ====================== */
/* Geteiltes Ergebnis (?vs=…) öffnen: passendes eigenes Spiel in der Historie suchen
   und direkt den Duell-Vergleich zeigen. Fehlt das eigene Ergebnis, wird der
   Spiel-Code zum Nachspielen vorbefüllt – gleicher Code = exakt gleicher Markt. */
function openSharedCompare(oppRaw){
  const gc = peekCode(extractResultCode(oppRaw));
  if(gc == null || !isFinite(gc)) return;               // unlesbarer Link – still ignorieren
  const s = loadStore();
  const games = Array.isArray(s.games) ? s.games : [];
  const entry = games.find(g => peekCode(g.code) === gc);
  if(!entry){
    setTop("multi"); setMode("remote");
    codeIn.value = String(gc).padStart(6, "0");
    codeIn.dispatchEvent(new Event("input"));           // Dauer übernehmen/sperren, Button-Text
    $("codeErr").textContent = "Zum Vergleichen spiel erst dieses Spiel – der Code ist schon eingetragen.";
    return;
  }
  if(runStatsCompare(entry, oppRaw, $("codeErr")))
    $("startScreen").classList.remove("show");
}

/* 6-stelligen Beitritts-Code in die Remote-Eingabe übernehmen (Zwei-Geräte-Modus). */
function applyJoinCode(code){
  if(!/^\d{6}$/.test(code || "")) return false;
  $("startScreen").classList.add("show");
  setTop("multi"); setMode("remote");
  codeIn.value = code;
  codeIn.dispatchEvent(new Event("input")); // Dauer übernehmen/sperren, Button-Text aktualisieren
  $("name1").focus();
  return true;
}
/* Beliebigen geteilten/gescannten Text (voller ?join=/?vs=-Link ODER blanker 6-stelliger
   Code) an die richtige Stelle leiten. Rückgabe: true, wenn etwas erkannt wurde. */
function routeSharedText(text){
  text = (text || "").trim();
  let params = null; const q = text.indexOf("?");
  if(q >= 0){ try{ params = new URLSearchParams(text.slice(q)); }catch(e){} }
  const vs = params && params.get("vs");
  if(vs){ openSharedCompare(vs); return true; }
  const join = (params && params.get("join")) || (/^\d{6}$/.test(text) ? text : null);
  return applyJoinCode(join);
}
function handleShareParams(){
  let p;
  try{ p = new URLSearchParams(location.search); }catch(e){ return false; }
  if(p.get("join") === null && p.get("vs") === null) return false;
  const q = location.search;                                             // vor dem Aufräumen sichern
  try{ history.replaceState(null, "", location.pathname); }catch(e){}    // nicht erneut auslösen (Reload/PWA)
  routeSharedText(q);
  return true;
}
if(!handleShareParams() && !loadSnapshot()){
  // Unterbrochene Online-Lobby (Reload beim App-Wechsel) automatisch wieder öffnen –
  // laufende Runden deckt der Spiel-Snapshot ab, Teil-Links haben Vorrang.
  const lby = loadLobbyState();
  if(lby) resumeLobby(lby);
}

/* ====================== QR-Scanner (Einladung scannen) ====================== */
let scanStream = null, scanTimer = null, jsQRLoad = null;

/* Decoder-Fallback (z. B. iOS Safari ohne BarcodeDetector) erst bei Bedarf nachladen –
   gleiche Herkunft (CSP 'self'), vom Service Worker gecacht, also auch offline. */
function loadJsQR(){
  if(window.jsQR) return Promise.resolve();
  if(!jsQRLoad) jsQRLoad = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "jsqr.js";
    s.onload = res;
    s.onerror = () => { jsQRLoad = null; rej(new Error("jsqr")); };
    document.body.appendChild(s);
  });
  return jsQRLoad;
}
/* Liefert eine Erkennungs-Funktion video -> Promise<Text|null>: nativer BarcodeDetector,
   wo verfügbar – sonst jsQR auf einem (fürs Decodieren verkleinerten) Canvas-Frame. */
async function makeDetector(){
  if(typeof window.BarcodeDetector !== "undefined"){
    try{
      const d = new window.BarcodeDetector({formats:["qr_code"]});
      return async v => { const c = await d.detect(v); return c.length ? (c[0].rawValue || "") : null; };
    }catch(e){ /* Format nicht unterstützt → jsQR-Fallback */ }
  }
  await loadJsQR();
  const cv = document.createElement("canvas");
  const cx = cv.getContext("2d", {willReadFrequently:true});
  return async v => {
    const vw = v.videoWidth, vh = v.videoHeight;
    if(!vw || !vh) return null;
    const sc = Math.min(1, 640 / Math.max(vw, vh)); // ~640px reichen zum Decodieren, spart CPU
    cv.width = Math.round(vw*sc); cv.height = Math.round(vh*sc);
    cx.drawImage(v, 0, 0, cv.width, cv.height);
    const id = cx.getImageData(0, 0, cv.width, cv.height);
    const r = window.jsQR(id.data, cv.width, cv.height, {inversionAttempts:"dontInvert"});
    return r ? r.data : null;
  };
}
function stopScan(){
  clearTimeout(scanTimer); scanTimer = null;
  if(scanStream){ scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  $("scanVideo").srcObject = null;
  $("scanOverlay").classList.remove("show");
}
async function startScan(){
  $("scanErr").textContent = "";
  $("scanOverlay").classList.add("show");
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    $("scanErr").textContent = "Kamera hier nicht verfügbar. Tipp: den QR mit der Kamera-App scannen oder den 6-stelligen Code eintippen.";
    return;
  }
  let detect;
  try{
    detect = await makeDetector();
  }catch(e){
    $("scanErr").textContent = "Scanner konnte nicht geladen werden – bitte erneut versuchen.";
    return;
  }
  // Rückkamera bevorzugen, aber nicht erzwingen; scheitert das, jede verfügbare Kamera nehmen.
  try{
    scanStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}}, audio:false});
  }catch(e1){
    try{
      scanStream = await navigator.mediaDevices.getUserMedia({video:true, audio:false});
    }catch(e2){
      // Fehlername mit anzeigen (NotAllowedError etc.) – hilft bei der Diagnose, v.a. auf iOS
      $("scanErr").textContent = "Kein Kamerazugriff (" + (e2.name || e2.message || "unbekannt") +
        ") – bitte der App/Website in den iOS-Einstellungen die Kamera erlauben.";
      return;
    }
  }
  const video = $("scanVideo");
  video.muted = true;
  video.srcObject = scanStream;
  await video.play().catch(()=>{});
  const tick = async () => {
    if(!scanStream) return; // abgebrochen
    try{
      const raw = await detect(video);
      if(raw){
        if(routeSharedText(raw)){ stopScan(); return; }
        $("scanErr").textContent = "Kein SPCX-Einladungscode erkannt.";
      }
    }catch(e){ /* einzelner Frame-Fehler: einfach weiter */ }
    scanTimer = setTimeout(tick, 250);
  };
  scanTimer = setTimeout(tick, 300);
}
$("scanBtn").onclick = startScan;
$("scanCancel").onclick = stopScan;
$("scanOverlay").onclick = e => { if(e.target === $("scanOverlay")) stopScan(); };

/* PWA: Service Worker registrieren (nur wenn über http(s) geladen) */
if("serviceWorker" in navigator && location.protocol.startsWith("http")){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  });
}
