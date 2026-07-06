/* Tests für worker.js v5 (Online-RAUM + Anti-Cheat-Replay, D1-Speicher). Ausführen mit:  node worker.test.js
   Braucht nur Node ≥ 22 (fetch, WebCrypto, node:sqlite), keine Abhängigkeiten.
   D1 wird über einen kleinen Adapter auf echtem SQLite simuliert; getestet wird der
   echte fetch-Handler: Raum-Lebenszyklus, Rollen, Limit, Runden-Serie, Aggregat,
   Anwesenheit, Abend-Wertung, Verfall – und der Anti-Cheat: der Server spielt jedes
   eingereichte Trade-Log auf dem selbst erzeugten Markt nach (gleiche engine.js). */
const fs = require("fs"), os = require("os"), path = require("path"), {pathToFileURL} = require("url");
const {DatabaseSync} = require("node:sqlite");

function d1Stub(){
  const db = new DatabaseSync(":memory:");
  return {
    _db: db,
    prepare(sql){
      return {
        _args: [],
        bind(...a){ this._args = a; return this; },
        async first(){ const r = db.prepare(sql).get(...this._args); return r === undefined ? null : r; },
        async run(){ const info = db.prepare(sql).run(...this._args);
          return {success: true, meta: {changes: Number(info.changes)}}; },
        async all(){ return {results: db.prepare(sql).all(...this._args)}; },
      };
    },
  };
}

let passed = 0, failed = 0;
function ok(cond, name){ console.log((cond ? "✔ " : "✘ ") + name); cond ? passed++ : failed++; }

(async () => {
  // worker.js importiert data.js/engine.js (Anti-Cheat-Replay) → alle drei in ein Temp-Verzeichnis
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "spcx-worker-"));
  for(const f of ["data.js", "engine.js"]) fs.copyFileSync(path.join(__dirname, f), path.join(tdir, f));
  fs.copyFileSync(path.join(__dirname, "worker.js"), path.join(tdir, "worker.mjs"));
  const worker = (await import(pathToFileURL(path.join(tdir, "worker.mjs")).href)).default;

  const db = d1Stub(), env = {DB: db};
  const call = (method, p, body, headers) =>
    worker.fetch(new Request("https://api.test" + p, {method, body, headers}), env);
  const jbody = o => JSON.stringify(o);
  const agg = async (code, me) => (await call("GET", "/room/" + code + (me ? "?me=" + me : ""))).json();

  // ---- Raum eröffnen ----
  let r = await call("POST", "/room", jbody({name: "Anna"}));
  ok(r.status === 201, "Raum eröffnen → 201");
  const R = await r.json();
  ok(/^\d{6}$/.test(R.code) && R.p === 1 && R.token && R.dur === 10, "Code, Ersteller p1, Standard-Dauer 10");
  let st = await agg(R.code);
  ok(st.curRound === 0 && st.round === null && st.scoreboard.length === 0, "frischer Raum: keine Runde, leere Wertung");
  ok(st.members.length === 1 && st.members[0].name === "Anna" && st.members[0].role === "player"
     && st.members[0].online === true, "Ersteller im Roster, online");

  // ---- Beitreten + Anwesenheit ----
  const ben  = await (await call("POST", `/room/${R.code}/join`, jbody({name: "Ben"}))).json();
  const cleo = await (await call("POST", `/room/${R.code}/join`, jbody({name: "Cleo"}))).json();
  ok(ben.p === 2 && cleo.p === 3 && ben.dur === 10, "Beitritte → Plätze 2 und 3, Dauer mitgeteilt");
  db._db.prepare("UPDATE members SET lastSeen = ? WHERE code = ? AND p = 2").run(Date.now() - 60000, R.code);
  st = await agg(R.code);
  ok(st.members.find(m => m.p === 2).online === false, "ohne Herzschlag → offline angezeigt");
  st = await agg(R.code, ben.token);
  ok(st.members.find(m => m.p === 2).online === true, "Aggregat mit ?me= wirkt als Herzschlag");

  // ---- Rollen: Leinwand ----
  r = await call("POST", `/room/${R.code}/role`, jbody({token: cleo.token, role: "wall"}));
  ok(r.status === 200, "Rolle → Leinwand umschalten");
  st = await agg(R.code);
  ok(st.members.find(m => m.p === 3).role === "wall", "Rolle im Roster sichtbar");
  ok((await call("POST", `/room/${R.code}/role`, jbody({token: "falsch", role: "wall"}))).status === 403, "Rollenwechsel mit fremdem Token → 403");
  ok((await call("POST", `/room/${R.code}/role`, jbody({token: cleo.token, role: "chef"}))).status === 400, "unbekannte Rolle → 400");

  // ---- Runde starten ----
  ok((await call("POST", `/room/${R.code}/start`, jbody({token: ben.token}))).status === 403, "Start durch Nicht-Ersteller → 403");
  const solo = await (await call("POST", "/room", jbody({name: "Einsam"}))).json();
  ok((await call("POST", `/room/${solo.code}/start`, jbody({token: solo.token}))).status === 409, "Start allein → 409");
  const t0 = Date.now();
  r = await call("POST", `/room/${R.code}/start`, jbody({token: R.token}));
  ok(r.status === 201, "Runde 1 startet");
  const rd1 = await r.json();
  ok(rd1.n === 1 && rd1.dur === 10 && rd1.startAt >= t0 + 9000 && rd1.startAt <= t0 + 11500, "Runde 1: Standard-Dauer, ~10 s Puffer");
  ok(Number.isInteger(rd1.seed) && rd1.seed >= 0 && rd1.seed <= 0xFFFFFFFF, "frischer uint32-Seed");
  st = await agg(R.code);
  ok(st.curRound === 1 && st.round.n === 1 && st.round.seed === rd1.seed, "Aggregat zeigt die laufende Runde samt Seed");
  ok((await call("POST", `/room/${R.code}/start`, jbody({token: R.token}))).status === 409, "Start während laufender Runde → 409");

  // ---- Live-P&L je Runde ----
  ok((await call("PUT", `/room/${R.code}/round/1/pnl/1`, jbody({pnl: 12.345}), {"x-token": R.token})).status === 200, "eigenen P&L melden");
  ok((await call("PUT", `/room/${R.code}/round/1/pnl/1`, jbody({pnl: 99}), {"x-token": ben.token})).status === 403, "fremder Token → 403");
  ok((await call("PUT", `/room/${R.code}/round/1/pnl/3`, jbody({pnl: 1}), {"x-token": cleo.token})).status === 403, "Leinwand darf nicht melden → 403");
  ok((await call("PUT", `/room/${R.code}/round/9/pnl/1`, jbody({pnl: 1}), {"x-token": R.token})).status === 404, "unbekannte Runde → 404");
  ok((await call("PUT", `/room/${R.code}/round/1/pnl/1`, jbody({pnl: "x"}), {"x-token": R.token})).status === 400, "kaputter Wert → 400");
  st = await agg(R.code);
  ok(st.pnls["1"] === 12.35, "P&L im Aggregat (gerundet)");

  // ---- Ergebnisse + Abend-Wertung, Runde 1 (ANTI-CHEAT: Server spielt das Log nach) ----
  const res6 = s => "SPCX6." + Buffer.from(s).toString("base64");
  const rbody = (s, log) => JSON.stringify({res: res6(s), log});
  const T1 = Math.round(rd1.dur * 60000 / TICK_MS);
  const mkt1 = genMarket(rd1.seed >>> 0, T1);           // Test rechnet mit derselben Engine
  const repOpt = {ticks: T1, cash: 25000, expert: false, room: true, journal: [], anchor: 0};
  const logA = [[2, "SPCX", "buy", 10, 0], [200, "SPCX", "sell", 10, 0]];
  const pnlA = replayRound(mkt1, logA, repOpt).pnl;
  const logB = [[5, "RKLB", "short", 20, 0], [150, "RKLB", "buy", 20, 0]];
  const pnlB = replayRound(mkt1, logB, repOpt).pnl;
  ok(oracleMaxPnl(mkt1, T1, 25000) > Math.max(pnlA, pnlB, 0), "Orakel-Obergrenze über realen Ergebnissen");
  ok((await call("PUT", `/room/${R.code}/round/1/result/1?pnl=${pnlA}`, rbody("anna1", logA), {"x-token": R.token})).status === 409,
     "Einreichung während laufender Runde → 409");
  db._db.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 1").run(Date.now() - 11*60000, R.code);
  ok((await call("PUT", `/room/${R.code}/round/1/result/1?pnl=${pnlA}`, res6("alt"), {"x-token": R.token})).status === 400,
     "Alt-Client ohne Trade-Log → 400 (Update-Pflicht)");
  ok((await call("PUT", `/room/${R.code}/round/1/result/1?pnl=${(pnlA + 500).toFixed(2)}`, rbody("anna1", logA), {"x-token": R.token})).status === 422,
     "erfundenes P&L → 422 (Replay widerspricht)");
  ok((await call("PUT", `/room/${R.code}/round/1/result/1?pnl=0`, rbody("anna1", [[3, "SPCX", "sell", 5, 0]]), {"x-token": R.token})).status === 422,
     "unmögliche Order (Verkauf ohne Stücke) → 422");
  r = await call("PUT", `/room/${R.code}/round/1/result/1?pnl=${pnlA}`, rbody("anna1", logA), {"x-token": R.token});
  const conf = await r.json();
  ok(r.status === 201 && conf.pnl === pnlA && conf.sus === 0 && conf.bot === 0,
     "Ergebnis p1: Replay bestätigt Server-Zahl (kein 🤨, kein 🤖)");
  ok((await call("PUT", `/room/${R.code}/round/1/result/1?pnl=${pnlA}`, rbody("anna1", logA), {"x-token": R.token})).status === 409, "write-once → 409");
  ok((await call("PUT", `/room/${R.code}/round/1/result/2?pnl=${pnlB}`, rbody("ben1", logB), {"x-token": ben.token})).status === 201, "Ergebnis p2 (Short-Log repliziert)");
  ok((await call("PUT", `/room/${R.code}/round/1/result/2`, rbody("x", logB), {"x-token": ben.token})).status !== 201, "Ergebnis ohne pnl-Angabe abgelehnt");
  st = await agg(R.code);
  ok(st.results["1"] === res6("anna1") && st.results["2"] === res6("ben1"), "Ergebnisse im Aggregat");
  ok(st.sus && !st.sus["1"] && !st.sus["2"] && st.bot && !st.bot["1"] && !st.bot["2"],
     "keine Verdachts-Flags (🤨/🤖) für ehrliche Logs");
  let sb = Object.fromEntries(st.scoreboard.map(s => [s.p, s]));
  const w1 = pnlA >= pnlB ? 1 : 2;
  ok(sb[w1].wins === 1 && sb[w1 === 1 ? 2 : 1].wins === 0 &&
     sb[1].total === pnlA && sb[2].total === pnlB, "Wertung nach Runde 1 = SERVER-Zahlen");

  // ---- Runde 2: Dauer wechseln, neue Seeds, Wertung summiert ----
  db._db.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 1").run(Date.now() - 11*60000, R.code);
  r = await call("POST", `/room/${R.code}/start`, jbody({token: R.token, dur: 5}));
  const rd2 = await r.json();
  ok(r.status === 201 && rd2.n === 2 && rd2.dur === 5, "Runde 2 mit neuer Dauer 5");
  ok(rd2.seed !== rd1.seed, "Runde 2 hat eigenen Seed");
  st = await agg(R.code);
  ok(st.dur === 5, "gewählte Dauer wird neuer Raum-Standard");
  ok(Object.keys(st.results).length === 0 && Object.keys(st.pnls).length === 0, "Aggregat zeigt nur die AKTUELLE Runde (leer)");
  db._db.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 2").run(Date.now() - 6*60000, R.code);
  const T2 = Math.round(rd2.dur * 60000 / TICK_MS);
  const mkt2 = genMarket(rd2.seed >>> 0, T2);
  const repOpt2 = {ticks: T2, cash: 25000, expert: false, room: true, journal: [], anchor: 0};
  const logA2 = [[4, "MKT", "buy", 30, 0]];                       // hält bis zur Schlussauktion (+ Dividende)
  const pnlA2 = replayRound(mkt2, logA2, repOpt2).pnl;
  const logB2 = [[4, "TSLA", "buy", 8, 0], [250, "TSLA", "sell", 8, 0]];
  const pnlB2 = replayRound(mkt2, logB2, repOpt2).pnl;
  ok((await call("PUT", `/room/${R.code}/round/2/result/1?pnl=${pnlA2}`, rbody("anna2", logA2), {"x-token": R.token})).status === 201, "Runde 2: Buy-and-Hold repliziert (inkl. Dividende)");
  ok((await call("PUT", `/room/${R.code}/round/2/result/2?pnl=${pnlB2}`, rbody("ben2", logB2), {"x-token": ben.token})).status === 201, "Runde 2: Ergebnis p2");
  sb = Object.fromEntries((await agg(R.code)).scoreboard.map(s => [s.p, s]));
  const w2 = pnlA2 >= pnlB2 ? 1 : 2;
  ok(sb[1].wins === (w1 === 1 ? 1 : 0) + (w2 === 1 ? 1 : 0) &&
     sb[2].wins === (w1 === 2 ? 1 : 0) + (w2 === 2 ? 1 : 0), "Rundensiege korrekt gezählt");
  ok(Math.abs(sb[1].total - (pnlA + pnlA2)) < 0.011 && Math.abs(sb[2].total - (pnlB + pnlB2)) < 0.011,
     "Gesamt-P&L über den Abend = Summe der Server-Zahlen");

  // ---- Zuspätkommer während laufender Runde ----
  const dana = await call("POST", `/room/${R.code}/join`, jbody({name: "Dana"}));
  ok(dana.status === 200 && (await dana.json()).p === 4, "Beitritt während laufender Runde möglich");

  // ---- Spielerlimit 20 (Leinwände zählen nicht) ----
  const L = await (await call("POST", "/room", jbody({name: "Host"}))).json();
  let full = 0;
  for(let i = 2; i <= 20; i++){
    const jr = await call("POST", `/room/${L.code}/join`, jbody({name: "S" + i}));
    if(jr.status === 200) full++;
  }
  ok(full === 19, "Raum füllt bis 20 Spieler");
  ok((await call("POST", `/room/${L.code}/join`, jbody({name: "Nr21"}))).status === 409, "21. Spieler → 409 (voll)");
  const wallJoin = await call("POST", `/room/${L.code}/join`, jbody({name: "TV", role: "wall"}));
  ok(wallJoin.status === 200, "Leinwand kommt trotz vollem Raum rein");
  const wallTok = (await wallJoin.json()).token;
  ok((await call("POST", `/room/${L.code}/role`, jbody({token: wallTok, role: "player"}))).status === 409,
     "Leinwand → Spieler scheitert am Limit");

  // ---- Längere Rundendauern (nur Raum; Offline-Codes bleiben bei 5/10/15) ----
  r = await call("POST", `/room/${L.code}/start`, jbody({token: L.token, dur: 7}));
  ok(r.status === 201 && (await r.json()).dur === 10, "unbekannte Dauer → Raum-Standard");
  db._db.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 1").run(Date.now() - 11*60000, L.code);
  r = await call("POST", `/room/${L.code}/start`, jbody({token: L.token, dur: 60}));
  ok(r.status === 201 && (await r.json()).dur === 60, "lange Dauer 60 Min erlaubt");

  // ---- Experten-Runden: Flag, Startkapital, Blockorder-Journal ----
  db._db.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 2").run(Date.now() - 61*60000, L.code);
  r = await call("POST", `/room/${L.code}/start`, jbody({token: L.token, expert: true, cash: 50000}));
  const rdE = await r.json();
  ok(r.status === 201 && rdE.expert === 1 && rdE.cash === 50000, "Expert-Runde mit 50k Startkapital");
  st = await agg(L.code);
  ok(st.round.expert === 1 && st.round.cash === 50000 && Array.isArray(st.trades) && st.trades.length === 0,
     "Aggregat: Expert-Flag, Kapital, leeres Journal");
  ok((await call("POST", `/room/${L.code}/round/${rdE.n}/trade`, jbody({sym: "SPCX", side: "buy", vol: 0.5}),
     {"x-token": L.token})).status === 409, "Blockorder vor Rundenstart → 409");
  db._db.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = ?").run(Date.now() - 60000, L.code, rdE.n);
  r = await call("POST", `/room/${L.code}/round/${rdE.n}/trade`, jbody({sym: "SPCX", side: "buy", vol: 0.5}),
     {"x-token": L.token});
  const tr1 = await r.json();
  ok(r.status === 201 && tr1.id === 1 && tr1.at > 0, "Blockorder angenommen, Server stempelt at");
  st = await agg(L.code);
  ok(st.trades.length === 1 && st.trades[0].sym === "SPCX" && st.trades[0].side === "buy" &&
     st.trades[0].vol === 0.5 && !("p" in st.trades[0]), "Journal im Aggregat – anonym (ohne p)");
  ok((await call("POST", `/room/${L.code}/round/${rdE.n}/trade`, jbody({sym: "NRG", side: "sell", vol: 0.3}),
     {"x-token": L.token})).status === 429, "Rate-Limit: zweite Blockorder sofort → 429");
  db._db.prepare("UPDATE trades SET at = at - 16000 WHERE code = ?").run(L.code);
  r = await call("POST", `/room/${L.code}/round/${rdE.n}/trade`, jbody({sym: "NRG", side: "sell", vol: 9}),
     {"x-token": L.token});
  ok(r.status === 201, "nach dem Rate-Fenster wieder erlaubt");
  st = await agg(L.code);
  ok(st.trades.length === 2 && st.trades[1].vol === 2, "Volumen auf 2.0 gedeckelt");
  ok((await call("POST", `/room/${L.code}/round/${rdE.n}/trade`, jbody({sym: "SPCX", side: "buy", vol: 1}),
     {"x-token": wallTok})).status === 403, "Leinwand darf keine Blockorder senden");
  ok((await call("POST", `/room/${L.code}/round/${rdE.n}/trade`, jbody({sym: "spcx!", side: "buy", vol: 1}),
     {"x-token": L.token})).status === 400, "kaputtes Symbol → 400");
  ok((await call("POST", `/room/${R.code}/round/2/trade`, jbody({sym: "SPCX", side: "buy", vol: 1}),
     {"x-token": R.token})).status === 409, "Blockorder in Nicht-Expert-Runde → 409");
  db._db.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 2").run(Date.now() - 6*60000, R.code);
  r = await call("POST", `/room/${R.code}/start`, jbody({token: R.token, cash: 100000}));
  ok(r.status === 201 && (await r.json()).cash === 25000, "ohne Expert bleibt das Startkapital 25k");

  // ---- 🤖 Bot-Verdacht: Timing-Heuristik (Hellseher-Einstiege / Maschinen-Reaktion) ----
  // Deterministische Seed-Suche: ein 15-Min-Markt mit genug "blinden" Aufwärts-News
  // (ohne Tipp, Kette oder Cluster davor) für ein Hellseher-Log und genug angezeigten
  // Aufwärts-News für ein Nur-Schnell-Log. Beide Logs sind regelkonform replizierbar –
  // nur ihr TIMING unterscheidet Bot von Mensch.
  const TB = Math.round(15 * 60000 / TICK_MS);
  const clusterW = Math.round(160000 / TICK_MS), earliest = Math.round(45000 / TICK_MS);
  const upEvents = mkt => mkt.events.filter(e => (e.ev.jump || 0) >= 0.008 && e.ev.t !== "ALL" && !e.mega);
  const blindUp = mkt => upEvents(mkt).filter(e => e.tick >= earliest &&
    !mkt.tips.some(tp => tp.sym === e.ev.t) &&
    !mkt.events.some(o => o !== e && o.tick < e.tick && o.tick >= e.tick - clusterW &&
      (o.ev.t === e.ev.t || o.ev.t === "ALL")));
  const pickDisjoint = (evs, entryOff, exitOff, want) => {  // überschneidungsfreie Round-Trips
    const out = []; let free = -1;
    for(const e of evs.slice().sort((a, b) => a.tick - b.tick)){
      const t0 = e.tick + entryOff, t1 = e.tick + exitOff;
      if(t0 <= free || t0 < 0 || t1 >= TB) continue;
      out.push(e); free = t1 + 2;
      if(out.length === want) return out;
    }
    return null;
  };
  const roundTrips = (mkt, evs, entryOff, exitOff) => evs.flatMap(e => {
    const sym = e.ev.t, t0 = e.tick + entryOff;
    const q = Math.max(1, Math.floor(1500 / mkt.paths[sym][t0]));
    return [[t0, sym, "buy", q, 0], [e.tick + exitOff, sym, "sell", q, 0]];
  });
  let botSeed = 0, mktB = null, seher = null, flink = null;
  for(let s = 1; s < 800 && !botSeed; s++){
    const mkt = genMarket(s, TB);
    const b = pickDisjoint(blindUp(mkt), -3, REACT_TICKS + 10, 3);   // Einstieg VOR der Anzeige
    const u = pickDisjoint(upEvents(mkt), 1, REACT_TICKS + 6, 5);    // Einstieg ~1 s NACH der Anzeige
    if(b && u){
      botSeed = s; mktB = mkt;
      seher = roundTrips(mkt, b, -3, REACT_TICKS + 10);
      flink = roundTrips(mkt, u, 1, REACT_TICKS + 6);
    }
  }
  ok(botSeed > 0, "Seed mit genug News-Material für die Bot-Logs gefunden");
  const repB = {ticks: TB, cash: 25000, expert: false, room: true, journal: [], anchor: 0};
  const repSeher = replayRound(mktB, seher, repB), repFlink = replayRound(mktB, flink, repB);
  ok(repSeher.ok && repFlink.ok, "beide Bot-Test-Logs sind regelkonform replizierbar");
  ok(botSuspicion(mktB, seher, TB).bot === true, "Hellseher-Log (3× Einstieg vor blinder News) → 🤖");
  ok(botSuspicion(mktB, flink, TB).bot === false, "Maschinen-Timing allein → kein 🤖 (konservative Schwelle)");
  ok(botSuspicion(mktB, logA, TB).bot === false, "ehrliches Mini-Log → kein 🤖");
  // … und über die echte API: Runde mit präpariertem Seed, der Server flaggt beim PUT
  const M = await (await call("POST", "/room", jbody({name: "Mia"}))).json();
  const nils = await (await call("POST", `/room/${M.code}/join`, jbody({name: "Nils"}))).json();
  r = await call("POST", `/room/${M.code}/start`, jbody({token: M.token, dur: 15}));
  ok(r.status === 201, "Bot-Testraum: Runde startet");
  db._db.prepare("UPDATE rounds SET seed = ?, startAt = ? WHERE code = ? AND n = 1")
        .run(botSeed, Date.now() - 16 * 60000, M.code);
  r = await call("PUT", `/room/${M.code}/round/1/result/1?pnl=${repSeher.pnl}`, rbody("mia", seher), {"x-token": M.token});
  const confBot = await r.json();
  ok(r.status === 201 && confBot.pnl === repSeher.pnl && confBot.bot === 1, "Hellseher-Log über die API → 201 mit 🤖");
  ok((await call("PUT", `/room/${M.code}/round/1/result/2?pnl=${repFlink.pnl}`, rbody("nils", flink), {"x-token": nils.token})).status === 201,
     "Nur-Schnell-Log über die API → angenommen, ohne Flag");
  st = await agg(M.code);
  ok(st.bot && st.bot["1"] === 1 && !st.bot["2"], "Aggregat: 🤖 nur für das Hellseher-Log");
  sb = Object.fromEntries(st.scoreboard.map(s => [s.p, s]));
  ok(sb[1].bot === 1 && sb[2].bot === 0, "Wertung zählt 🤖-Runden je Spieler");

  // ---- MKT/ACT: Index leitet sich aus den (beeinflussten) Bestandteilen ab ----
  {
    const TI = Math.round(10 * 60000 / TICK_MS);
    const mktI = genMarket(4242, TI);
    const baseMKT = mktI.paths.MKT.slice();
    const hit = REACT_TICKS + IMPACT_RAMP_TICKS + 5;
    // (1) Blockorders, die SPCX kräftig hochkaufen → MKT muss anteilig mitziehen
    const pump = [];
    for(let k = 0; k < 4; k++) pump.push({at: k * 1000, sym: "SPCX", side: "buy", vol: 2});
    const effP = buildEffPaths(mktI, pump, 0, TI).eff;
    ok(effP.SPCX[hit] > mktI.paths.SPCX[hit], "SPCX-Pump hebt den Effektivkurs");
    ok(effP.MKT[hit] > baseMKT[hit], "MKT erbt den Impact seiner Bestandteile (Index folgt den Aktien)");
    // MKT ist EXAKT die Neu-Ableitung aus den Effektiv-Aktien – keine Eigenbewegung
    const syms = Object.keys(STOCK_DEFS);
    const expMKT = syms.reduce((a, s) => a + effP[s][hit] / STOCK_DEFS[s].start, 0) / syms.length * ETF_BASE;
    ok(Math.abs(effP.MKT[hit] - expMKT) < 1e-6, "MKT = Durchschnitt der Effektiv-Bestandteile (reine Ableitung)");
    // (2) Direkte Blockorder auf MKT bewegt den Index NICHT (nicht mehr manipulierbar)
    const onlyMkt = [{at: 0, sym: "MKT", side: "buy", vol: 2}, {at: 1000, sym: "MKT", side: "buy", vol: 2}];
    const effM = buildEffPaths(mktI, onlyMkt, 0, TI).eff;
    ok(Math.abs(effM.MKT[hit] - baseMKT[hit]) < 1e-6, "Direkter MKT-Handel schiebt den Index nicht");
    // (3) Große MKT-Order ohne block10 wird NICHT als 'unblocked' abgelehnt (Index zahlt keinen Eigen-Impact),
    //     eine gleich große Aktien-Order dagegen schon – die Ausnahme ist gezielt.
    const repOptE = {ticks: TI, cash: 25000, expert: true, room: true, journal: [], anchor: 0};
    const qMkt = Math.ceil(25000 * BLOCK_MIN_FRAC * 1.05 / mktI.paths.MKT[5]) + 5;
    ok(replayRound(mktI, [[5, "MKT", "buy", qMkt, 0]], repOptE).ok,
       "große MKT-Order ohne block10 → akzeptiert (Index ohne Eigen-Impact)");
    const qSpcx = Math.ceil(25000 * BLOCK_MIN_FRAC * 1.05 / mktI.paths.SPCX[5]) + 5;
    const spcxRej = replayRound(mktI, [[5, "SPCX", "buy", qSpcx, 0]], repOptE);
    ok(!spcxRej.ok && spcxRej.error === "unblocked",
       "gleich große SPCX-Order ohne block10 → weiterhin 'unblocked'");
  }

  // ---- Verfall ----
  db._db.prepare("UPDATE rooms SET lastActive = ? WHERE code = ?").run(Date.now() - 25*3600*1000, solo.code);
  ok((await call("GET", "/room/" + solo.code)).status === 404, "verfallener Raum → 404");
  await call("POST", "/room", jbody({name: "Putz"}));
  ok(db._db.prepare("SELECT COUNT(*) AS n FROM members WHERE code = ?").get(solo.code).n === 0, "Aufräumen löscht Mitglieder mit");

  // ---- Routing/Alt-API/CORS ----
  ok((await call("POST", "/game", jbody({dur: 10}))).status === 404, "alte /game-API → 404");
  ok((await call("GET", "/room/abc")).status === 400, "kaputter Code → 400");
  ok((await call("GET", "/room/000001")).status === 404, "unbekannter Raum → 404");
  ok((await call("DELETE", "/room/" + R.code)).status === 405, "falsche Methode → 405");
  r = await call("OPTIONS", "/room");
  ok(r.status === 204 && r.headers.get("access-control-allow-origin") === "*", "CORS-Preflight");
  ok((await call("GET", "/room/" + R.code)).headers.get("access-control-allow-origin") === "*", "CORS auf Antworten");

  console.log(failed ? `\n${failed} FEHLER (${passed} ok)` : `\nALLE ${passed} TESTS OK`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("Test-Harness-Fehler:", e); process.exit(1); });
