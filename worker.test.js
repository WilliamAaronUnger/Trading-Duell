/* Tests für worker.js v3 (Online-RAUM, D1-Speicher). Ausführen mit:  node worker.test.js
   Braucht nur Node ≥ 22 (fetch, WebCrypto, node:sqlite), keine Abhängigkeiten.
   D1 wird über einen kleinen Adapter auf echtem SQLite simuliert; getestet wird der
   echte fetch-Handler: Raum-Lebenszyklus, Rollen, Limit, Runden-Serie, Aggregat,
   Anwesenheit, Abend-Wertung, Verfall. */
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
  const tmp = path.join(os.tmpdir(), "spcx-worker-" + process.pid + ".mjs");
  fs.copyFileSync(path.join(__dirname, "worker.js"), tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);

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

  // ---- Ergebnisse + Abend-Wertung, Runde 1 ----
  const res = s => "SPCX5." + Buffer.from(s).toString("base64");
  ok((await call("PUT", `/room/${R.code}/round/1/result/1?pnl=120.5`, res("anna1"), {"x-token": R.token})).status === 201, "Ergebnis p1 (Sieger R1)");
  ok((await call("PUT", `/room/${R.code}/round/1/result/1?pnl=120.5`, res("anna1"), {"x-token": R.token})).status === 409, "write-once → 409");
  ok((await call("PUT", `/room/${R.code}/round/1/result/2?pnl=-30`, res("ben1"), {"x-token": ben.token})).status === 201, "Ergebnis p2");
  ok((await call("PUT", `/room/${R.code}/round/1/result/2`, res("x"), {"x-token": ben.token})).status !== 201, "Ergebnis ohne pnl-Angabe abgelehnt");
  st = await agg(R.code);
  ok(st.results["1"] === res("anna1") && st.results["2"] === res("ben1"), "Ergebnisse im Aggregat");
  let sb = Object.fromEntries(st.scoreboard.map(s => [s.p, s]));
  ok(sb[1].wins === 1 && sb[1].total === 120.5 && sb[2].wins === 0 && sb[2].total === -30, "Wertung nach Runde 1");

  // ---- Runde 2: Dauer wechseln, neue Seeds, Wertung summiert ----
  db._db.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 1").run(Date.now() - 11*60000, R.code);
  r = await call("POST", `/room/${R.code}/start`, jbody({token: R.token, dur: 5}));
  const rd2 = await r.json();
  ok(r.status === 201 && rd2.n === 2 && rd2.dur === 5, "Runde 2 mit neuer Dauer 5");
  ok(rd2.seed !== rd1.seed, "Runde 2 hat eigenen Seed");
  st = await agg(R.code);
  ok(st.dur === 5, "gewählte Dauer wird neuer Raum-Standard");
  ok(Object.keys(st.results).length === 0 && Object.keys(st.pnls).length === 0, "Aggregat zeigt nur die AKTUELLE Runde (leer)");
  await call("PUT", `/room/${R.code}/round/2/result/1?pnl=-10`, res("anna2"), {"x-token": R.token});
  await call("PUT", `/room/${R.code}/round/2/result/2?pnl=55`,  res("ben2"),  {"x-token": ben.token});
  sb = Object.fromEntries((await agg(R.code)).scoreboard.map(s => [s.p, s]));
  ok(sb[1].wins === 1 && sb[2].wins === 1, "je ein Rundensieg nach Runde 2");
  ok(sb[1].total === 110.5 && sb[2].total === 25, "Gesamt-P&L über den Abend summiert");

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
  ok((await call("POST", `/room/${L.code}/role`, jbody({token: (await wallJoin.json()).token, role: "player"}))).status === 409,
     "Leinwand → Spieler scheitert am Limit");

  // ---- Längere Rundendauern (nur Raum; Offline-Codes bleiben bei 5/10/15) ----
  r = await call("POST", `/room/${L.code}/start`, jbody({token: L.token, dur: 7}));
  ok(r.status === 201 && (await r.json()).dur === 10, "unbekannte Dauer → Raum-Standard");
  db._db.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 1").run(Date.now() - 11*60000, L.code);
  r = await call("POST", `/room/${L.code}/start`, jbody({token: L.token, dur: 60}));
  ok(r.status === 201 && (await r.json()).dur === 60, "lange Dauer 60 Min erlaubt");

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
