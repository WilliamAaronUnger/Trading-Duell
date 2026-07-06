/* Trading Duell – ENGINE: deterministische Marktgenerierung, Impact-Overlay und
   Anti-Cheat-Replay. Diese Datei wird von ZWEI Seiten geladen:
   - Browser: als klassisches Script (index.html, zwischen data.js und game.js) –
     die Funktionen landen wie bisher im gemeinsamen globalen Scope.
   - Cloudflare Worker: per `import "./engine.js"` (nach `import "./data.js"`); der
     Publish-Block am Dateiende macht die Funktionen dort über globalThis sichtbar.
   Dadurch rechnen Client und Server mit EXAKT demselben Code – der Server kann jedes
   eingereichte Trade-Log nachspielen (Anti-Cheat, siehe worker.js). Kein DOM-Zugriff,
   kein Client-State: alles hier ist eine pure Funktion seiner Parameter (+ data.js-
   Konstanten). Bei Aenderungen an Handelsregeln in game.js MUSS replayRound mitziehen
   (der Engine-Paritaets-Test in worker.test.js schlaegt sonst Alarm). */

/* Seeded PRNG, damit beide Runden den identischen Markt bekommen */
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

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

function tradeTick(at, anchor){ return Math.floor((at - anchor) / TICK_MS); }

/* Ein Journal-Eintrag wirkt ab `hit` (Server-Stempel + REACT_TICKS). Synthetische
   Einträge (Squeeze) bringen ihre Wirkstärke/-zeit direkt mit (_mag/_hit). */
function impactFactorAt(tr, t, anchor){
  const hit = tr._hit !== undefined ? tr._hit : tradeTick(tr.at, anchor) + REACT_TICKS;
  if(t < hit) return 1;
  const mag = tr._mag !== undefined ? tr._mag : IMPACT_BASE * tr.vol / liqOf(tr.sym);
  const full = tr.side === "buy" ? 1 + mag : 1 / (1 + mag);
  const ramp = Math.min(1, (t - hit + 1) / IMPACT_RAMP_TICKS);
  if(ramp < 1) return Math.pow(full, ramp);
  const fade = Math.min(1, (t - hit - IMPACT_RAMP_TICKS + 1) / IMPACT_FADE_TICKS);
  return Math.pow(full, 1 - (1 - IMPACT_KEEP) * fade);
}

/* Gesamt-Overlay einer Aktie zum Tick t (gedeckelt auf ±IMPACT_CAP) */
function overlayAt(trs, t, anchor){
  let f = 1;
  for(const tr of trs) f *= impactFactorAt(tr, t, anchor);
  return Math.max(1 - IMPACT_CAP, Math.min(1 + IMPACT_CAP, f));
}

/* Schieflage der Herde in einer Aktie zum Tick t: Summe der wirksamen Blockorder-
   Volumina (Kauf +, Verkauf −), normiert auf −1…+1. Nur echte Einträge zählen. */
function skewAt(trs, t, anchor){
  let s = 0;
  for(const tr of trs){
    if(tr._mag !== undefined) continue;
    if(tradeTick(tr.at, anchor) + REACT_TICKS > t) continue;
    s += tr.side === "buy" ? tr.vol : -tr.vol;
  }
  return Math.max(-1, Math.min(1, s / SKEW_FULL));
}

/* Squeeze-Suche: eine News, die GEGEN eine deutliche Schieflage läuft, zwingt die
   Herde durch dieselbe Tür (Shorts decken ein / Blasen-Longs fliehen) – als
   synthetischer Zusatz-Impact in Sprungrichtung, deterministisch aus Journal+Markt. */
function findSqueezes(mkt, bySym, anchor, ticks){
  const out = [];
  for(const e of mkt.events){
    const sym = e.ev.t;
    if(sym === "ALL" || !bySym[sym]) continue;
    const jump = e.ev.jump || 0;
    if(!jump) continue;
    const hit = e.tick + (e.mega ? MEGA_REACT_TICKS : REACT_TICKS);
    if(hit > ticks) continue;
    const s = skewAt(bySym[sym], hit, anchor);
    if(Math.abs(s) < SKEW_MIN || (jump > 0) === (s > 0)) continue;
    out.push({sym, hitTick: hit, side: jump > 0 ? "buy" : "sell",
              _hit: hit, _mag: Math.abs(jump) * SQUEEZE_K * Math.abs(s),
              short: s < 0}); // short=true → Short-Squeeze, sonst platzt eine Long-Blase
  }
  return out;
}

/* Effektiv-Pfade aus Basis-Markt + Journal bauen (Spieler UND Leinwand nutzen das):
   Blockorder-Overlay × Herden-Dämpfung, plus Squeeze-Zusätze. Unberührte Werte
   teilen sich das Basis-Array – nur betroffene werden kopiert. */
function buildEffPaths(mkt, jr, anchor, ticks){
  if(!jr.length) return {eff: null, squeezes: []};
  const bySym = {};
  for(const tr of jr) (bySym[tr.sym] = bySym[tr.sym] || []).push(tr);
  const squeezes = findSqueezes(mkt, bySym, anchor, ticks);
  const sqBySym = {};
  for(const q of squeezes) (sqBySym[q.sym] = sqBySym[q.sym] || []).push(q);
  const eff = {};
  for(const sym in mkt.paths){
    // MKT/ACT sind reine Ableitungen ihrer Bestandteile – sie bekommen KEIN eigenes
    // Overlay (Direkt-Handel schiebt den Index nicht), sondern werden unten aus den
    // Effektiv-Kursen der Aktien neu berechnet, damit sie dem Markt folgen.
    if(sym === ETF_SYM || sym === ETF2_SYM) continue;
    const base = mkt.paths[sym], trs = bySym[sym], sqs = sqBySym[sym];
    if(!trs && !sqs){ eff[sym] = base; continue; }
    const all = (trs || []).concat(sqs || []);
    const a = new Array(base.length);
    let damp = 1;
    a[0] = base[0] * overlayAt(all, 0, anchor);
    for(let t = 1; t < base.length; t++){
      if(trs){
        const s = skewAt(trs, t, anchor);
        // Bewegungen in Gewinnrichtung der Herde laufen zäher („der Markt bewegt
        // sich gegen die Masse"): alle short → fällt langsamer, alle long → steigt zäher.
        if(Math.abs(s) >= 0.15){
          const r = base[t] / base[t-1];
          if((s > 0 && r > 1) || (s < 0 && r < 1)){
            damp *= Math.pow(r, -DAMP_MAX * Math.abs(s));
            damp = Math.max(1 - DAMP_CAP, Math.min(1 + DAMP_CAP, damp));
          }
        }
      }
      a[t] = base[t] * damp * overlayAt(all, t, anchor);
    }
    eff[sym] = a;
  }
  // Index-Werte aus den (beeinflussten) Bestandteilen neu ableiten: addEtfPath/
  // addActivePath lesen die Aktien-Pfade aus `eff` (für jede Aktie steht dort der
  // Effektiv- oder – unberührt – der Basis-Pfad) und schreiben ETF_SYM/ETF2_SYM.
  // So erbt der Index den Impact seiner Aktien, ist selbst aber nicht handel-schiebbar.
  if(mkt.paths[ETF_SYM])  addEtfPath(eff, ticks);
  if(mkt.paths[ETF2_SYM]) addActivePath(eff, ticks);
  return {eff, squeezes};
}

/* ===== Experten-Haerten, pure Form (Client-Wrapper: spreadOf/haltInfo in game.js) ===== */

/* Geld-/Brief-Spanne eines Werts zum Tick t (Expert): Basis / liq, x3 fuer
   ~30 s nach einer News, die den Wert (oder ALL) trifft. */
function spreadAtTick(mkt, sym, t){
  let s = EXPERT_SPREAD_BASE / liqOf(sym);
  for(const e of mkt.events){
    if(e.ev.t !== sym && e.ev.t !== "ALL") continue;
    const hit = e.tick + (e.mega ? MEGA_REACT_TICKS : REACT_TICKS);
    if(t >= hit && t < hit + SPREAD_WIDE_TICKS){ s *= 3; break; }
  }
  return Math.min(s, 0.02);
}

/* Volatilitaetsunterbrechung: Rest-Ticks des Handelsstopps (0 = handelbar). */
function haltLeftAt(mkt, sym, t){
  for(const e of mkt.events){
    if(!e.mega || (e.ev.jump || 0) >= 0) continue;
    if(e.ev.t !== sym && e.ev.t !== "ALL") continue;
    const hit = e.tick + MEGA_REACT_TICKS;
    if(t >= hit && t < hit + EXPERT_HALT_TICKS) return hit + EXPERT_HALT_TICKS - t;
  }
  return 0;
}

/* ===== Anti-Cheat: Server-Replay eines Trade-Logs =====
   log = Liste ausgefuehrter Fills: [tick, sym, side("buy"|"sell"|"short"), qty, block10]
   (block10 = gemeldetes Blockorder-Volumen x10, 0 = keine Blockorder).
   opt = {ticks, cash, expert, room, journal, anchor}.
   Spielt das Log mit exakt den Client-Regeln durch (Gebuehren, Dividenden,
   Short-Deckel, Spread/Halt/Slippage/Journal-Overlay im Expert) und liefert
   {ok:true, pnl} – oder {ok:false, error} wenn irgendeine Order zum
   angegebenen Tick gar nicht moeglich gewesen waere. Reihenfolge je Tick wie
   im Spiel: erst Dividenden-Accrual des Ticks, dann die Orders des Ticks. */
function replayRound(mkt, log, opt){
  const ticks = opt.ticks, expert = !!opt.expert, isRoom = !!opt.room;
  const eff = expert && isRoom && opt.journal && opt.journal.length
    ? buildEffPaths(mkt, opt.journal, opt.anchor, ticks).eff : null;
  const P = (sym, t) => ((eff && eff[sym]) || mkt.paths[sym])[Math.min(t, ticks)];

  // Grundform pruefen + normalisieren
  if(!Array.isArray(log) || log.length > 400) return {ok:false, error:"log"};
  const orders = [];
  for(const e of log){
    if(!Array.isArray(e) || e.length < 4) return {ok:false, error:"entry"};
    const o = {t:+e[0], sym:String(e[1]), a:String(e[2]), q:+e[3], b:+e[4] || 0};
    if(!Number.isInteger(o.t) || o.t < 0 || o.t > ticks) return {ok:false, error:"tick"};
    if(!mkt.paths[o.sym]) return {ok:false, error:"sym"};
    if(o.a !== "buy" && o.a !== "sell" && o.a !== "short") return {ok:false, error:"side"};
    if(!Number.isInteger(o.q) || o.q < 1 || o.q > 1e7) return {ok:false, error:"qty"};
    if(!Number.isInteger(o.b) || o.b < 0 || o.b > 20) return {ok:false, error:"block"};
    orders.push(o);
  }
  for(let i = 1; i < orders.length; i++)
    if(orders[i].t < orders[i-1].t) return {ok:false, error:"chrono"};

  let cash = opt.cash, pendingDiv = 0, li = 0;
  const pos = {};
  const totalAt  = t => { let v = cash; for(const s in pos) v += pos[s].qty * P(s, t); return v; };
  const shortExpoAt = t => { let v = 0; for(const s in pos) if(pos[s].qty < 0) v += -pos[s].qty * P(s, t); return v; };

  for(let t = 0; t <= ticks; t++){
    // 1) Dividenden-Accrual des Ticks (wie processTick; Expert: Short zahlt, ACT kostet)
    if(t >= 1){
      for(const s in pos){
        const q = pos[s].qty;
        if(isDividendSym(s) && (q > 0 || expert)) pendingDiv += q * P(s, t) * divRate(s) * TICK_SCALE;
        if(expert && s === ETF2_SYM && q > 0)     pendingDiv -= q * P(s, t) * EXPERT_ACT_HOLD * TICK_SCALE;
      }
      if(pendingDiv && t % DIV_PAYOUT === 0){
        if(Math.abs(pendingDiv) >= 0.005) cash += pendingDiv;
        pendingDiv = 0;
      }
    }
    // 2) Orders dieses Ticks
    while(li < orders.length && orders[li].t === t){
      const o = orders[li++];
      if(expert && haltLeftAt(mkt, o.sym, t)) return {ok:false, error:"halt"};
      let px = P(o.sym, t);
      if(expert && isRoom){
        if(o.b){
          const slip = IMPACT_BASE * (o.b / 10) / liqOf(o.sym) / 2;
          px = o.a === "buy" ? px * (1 + slip) : px * (1 - slip);
        }else if(!isIndexSym(o.sym) && o.q * px >= opt.cash * BLOCK_MIN_FRAC * 1.05){
          return {ok:false, error:"unblocked"}; // Blockorder-Groesse ohne gemeldete Slippage
          // (MKT/ACT sind ausgenommen: reine Ableitungen, kein Eigen-Impact/keine Slippage)
        }
      }
      if(expert){
        const spr = spreadAtTick(mkt, o.sym, t);
        px = o.a === "buy" ? px * (1 + spr / 2) : px * (1 - spr / 2);
      }
      const posS = pos[o.sym];
      if(o.a === "buy"){
        const cost = o.q * px, fee = feeOf(cost, o.sym);
        if(cost + fee > cash + 0.011) return {ok:false, error:"cash"};
        if(posS && posS.qty < 0){
          if(o.q > -posS.qty) return {ok:false, error:"cover"};
          cash -= cost + fee;
          posS.qty += o.q;
          if(posS.qty === 0) delete pos[o.sym];
        }else{
          cash -= cost + fee;
          const lp = posS || {qty:0, avg:0};
          lp.avg = (lp.avg * lp.qty + cost) / (lp.qty + o.q);
          lp.qty += o.q;
          pos[o.sym] = lp;
        }
      }else if(o.a === "sell"){
        if(!posS || posS.qty < o.q) return {ok:false, error:"shares"};
        const fee = feeOf(o.q * px, o.sym);
        cash += o.q * px - fee;
        posS.qty -= o.q;
        if(posS.qty === 0) delete pos[o.sym];
      }else{ // short eroeffnen/aufstocken
        if(posS && posS.qty > 0) return {ok:false, error:"cross"};
        const capQ = Math.floor((totalAt(t) - shortExpoAt(t)) / px);
        if(o.q > capQ + 0.001) return {ok:false, error:"shortcap"};
        const fee = feeOf(o.q * px, o.sym);
        cash += o.q * px - fee;
        const sp = posS || {qty:0, avg:0};
        sp.avg = (sp.avg * -sp.qty + o.q * px) / (-sp.qty + o.q);
        sp.qty -= o.q;
        pos[o.sym] = sp;
      }
    }
  }
  if(Math.abs(pendingDiv) >= 0.005) cash += pendingDiv; // letzte Ausschuettung (endRound)

  // Schlussauktion: Endbewertung IMMER zum fairen Basiskurs (im Nicht-Expert
  // identisch mit dem Effektivkurs, weil es dort kein Overlay gibt)
  let total = cash;
  for(const s in pos) total += pos[s].qty * mkt.paths[s][ticks];
  return {ok:true, pnl: Math.round((total - opt.cash) * 100) / 100};
}

/* ===== Anti-Cheat: theoretisches Maximum (Orakel-Obergrenze) =====
   Kontinuierliches Kapital, perfektes Timing, beliebige Wechsel ueber Cash
   (mit Ordergebuehren), Long UND Short (1x) – eine OBERGRENZE dessen, was mit
   ganzen Stuecken ueberhaupt erreichbar waere. Ergebnisse nahe dieser Grenze
   sind menschlich praktisch unmoeglich -> 🤨-Verdachts-Flag (kein Verbot). */
function oracleMaxPnl(mkt, ticks, cash0){
  const syms = Object.keys(mkt.paths);
  let cash = cash0;
  const long = {}, short = {};
  for(const s of syms){ long[s] = 0; short[s] = 0; }
  for(let t = 1; t <= ticks; t++){
    for(const s of syms){
      const r = mkt.paths[s][t] / mkt.paths[s][t-1];
      long[s] *= r;
      short[s] *= Math.max(0, 2 - r);
    }
    let best = cash;
    for(const s of syms){
      const f = 1 - feeRate(s);
      if(long[s]  * f > best) best = long[s]  * f;
      if(short[s] * f > best) best = short[s] * f;
    }
    cash = best;
    for(const s of syms){
      const f = 1 - feeRate(s);
      if(cash * f > long[s])  long[s]  = cash * f;
      if(cash * f > short[s]) short[s] = cash * f;
    }
  }
  let best = cash;
  for(const s of syms){
    const f = 1 - feeRate(s);
    if(long[s]  * f > best) best = long[s]  * f;
    if(short[s] * f > best) best = short[s] * f;
  }
  return Math.round((best - cash0) * 100) / 100;
}

/* ===== Anti-Cheat: Bot-Verdacht (Timing-Analyse eines replizierten Logs) =====
   Bewertet ein bereits per replayRound BESTAETIGTES (also regelkonformes) Log
   darauf, ob sein Timing nur mit Vorwissen oder Maschinen-Reaktion erklaerbar
   ist. Zwei Signale:
   1) Hellseherei: Einstiege in Richtung einer kommenden News, platziert kurz
      VOR deren Anzeige-Tick – gezaehlt nur bei "blinden" Events (kein Insider-
      Tipp, keine fruehere News mit ueberlappendem Ziel im Ketten-Fenster davor,
      nicht im Eroeffnungs-Trubel). Megas zaehlen doppelt: sie sind per Design
      unangekuendigt, vor ihrer Anzeige gibt es NULL ehrliche Signale.
   2) Maschinen-Reaktion: passende Orders binnen ~1 s nach dem Anzeige-Tick,
      ueber viele Events hinweg – Menschen lesen erst die Schlagzeile.
   Ergebnis ist ein VERDACHT (🤖-Flag in der Wertung), kein Beweis und keine
   Ablehnung. Die Schwellen sind bewusst konservativ (Momentum-News folgen
   steigenden Kursen, ehrliche Trend-Reiter sitzen dort schon richtig drin):
   Maschinen-Reaktion allein flaggt nie, Hellseherei erst ab drei Treffern. */
function botSuspicion(mkt, log, ticks){
  const fastMax  = Math.max(1, Math.round(1200 / TICK_MS));   // "sofort" = ca. 1 s nach Anzeige
  const reactWin = REACT_TICKS + Math.round(4000 / TICK_MS);  // was ueberhaupt als Reaktion zaehlt
  const preWin   = Math.round(12000 / TICK_MS);               // Hellseher-Fenster vor der Anzeige
  const clusterW = Math.round(160000 / TICK_MS);              // Geruecht→Aufloesung / News-Cluster
  const earliest = Math.round(45000 / TICK_MS);               // Eroeffnungs-Kaeufe ignorieren

  const shown = (mkt.events || []).filter(e => Math.abs(e.ev.jump || 0) >= 0.008);
  const blind = new Set(shown.filter(e => e.tick >= earliest &&
    !(mkt.events || []).some(o => o !== e && o.tick < e.tick && o.tick >= e.tick - clusterW &&
      (o.ev.t === e.ev.t || o.ev.t === "ALL" || e.ev.t === "ALL"))));
  const tipped = (t, sym, dir) => (mkt.tips || []).some(tp =>
    tp.sym === sym && tp.dir === dir && tp.tick <= t && t < tp.eventTick);

  let prescient = 0, reacts = 0, fast = 0;
  for(const ev of shown){
    const dir = ev.ev.jump > 0 ? 1 : -1;
    let pre = false, delta = Infinity;
    for(const o of log){
      const t = +o[0], sym = String(o[1]);
      if((String(o[2]) === "buy" ? 1 : -1) !== dir) continue; // sell & short = Abwaerts-Wette/-Flucht
      if(ev.ev.t !== sym && ev.ev.t !== "ALL") continue;
      if(t < ev.tick){
        if(blind.has(ev) && ev.tick - t <= preWin && !tipped(t, sym, dir)) pre = true;
      }else delta = Math.min(delta, t - ev.tick);
    }
    if(pre) prescient += ev.mega ? 2 : 1;
    if(delta <= reactWin){ reacts++; if(delta <= fastMax) fast++; }
  }
  const machine = reacts >= 5 && fast / reacts >= 0.8;
  const score = (prescient >= 3 ? 2 : prescient >= 2 ? 1 : 0) + (machine ? 1 : 0);
  return {prescient, reacts, fast, bot: score >= 2};
}

/* ===== Publish fuer den Worker-Pfad (im Browser harmlos-redundant) ===== */
if(typeof globalThis === "object") Object.assign(globalThis, {
  mulberry32, genMarket, addEtfPath, addActivePath,
  tradeTick, impactFactorAt, overlayAt, skewAt, findSqueezes, buildEffPaths,
  spreadAtTick, haltLeftAt, replayRound, oracleMaxPnl, botSuspicion,
});
